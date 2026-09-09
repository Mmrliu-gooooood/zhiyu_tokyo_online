import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { apiError } from '@/lib/server/api-response';
import {
  backgroundGenerationEnabled,
  getGenerationPool,
} from '@/lib/server/generation-jobs/runtime';

import {
  checkHeavyTaskAdmission,
  heavyTaskSyncQuotaGroup,
  isHeavyTaskFairTurn,
  withHeavyTaskRootContext,
  type HeavyTaskAdmissionQueryable,
  type HeavyTaskKind,
} from './index';

// This grace window exceeds every synchronous chain's own hard budget (local
// media extraction is the longest at 45 minutes). Heartbeats normally keep it
// moving; the hour exists so a DB outage can abort provider work without the
// row becoming reusable while a non-network cleanup step is still unwinding.
const SYNC_LEASE_MS = 60 * 60 * 1000;
const SYNC_HEARTBEAT_MS = 30 * 1000;
const independentFetchSignal = new AsyncLocalStorage<AbortSignal>();
let abortableFetchInstalled = false;

interface IndependentLease {
  group: string;
  holder: string;
  epoch: number;
}

/**
 * Admit a synchronous parsing/media request through a recoverable PostgreSQL
 * lease. Provider waits never pin a SQL connection. A heartbeat renews the
 * fencing row while work is alive; if persistence is lost, the contextual
 * AbortSignal cancels this task's provider fetches before the lease can expire.
 * The wrapper still awaits the body settling, so it never releases capacity
 * while detached provider work is continuing.
 */
export async function runIndependentHeavyTaskRequest(
  request: Request,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  body: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  // Worker deployments reject browser media routes at their existing guard;
  // durable worker/Pro media already inherits its admitted root context.
  if (kind === 'media' && backgroundGenerationEnabled()) return body(new AbortController().signal);
  if (!process.env.DATABASE_URL?.trim()) return body(new AbortController().signal);

  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  const ownerId = resolveRequestOwnerId(request, responseHeaders);
  const holder = randomUUID();
  const rootTaskId = `independent:${holder}`;
  let lease: IndependentLease | null;
  try {
    lease = await acquireIndependentLease(ownerId, rootTaskId, kind, holder);
  } catch (error) {
    return error instanceof PersonalCapacityError
      ? limitResponse('personal_limit', responseHeaders)
      : serviceUnavailableResponse(responseHeaders);
  }
  if (!lease) return limitResponse('site_limit', responseHeaders);

  installAbortableFetch();
  const leaseAbort = new AbortController();
  let leaseFailure: unknown;
  let renewing: Promise<void> | undefined;
  const renew = () => {
    if (renewing) return;
    renewing = heartbeatIndependentLease(lease!)
      .then((alive) => {
        if (!alive) throw new IndependentLeaseLostError();
      })
      .catch((error: unknown) => {
        leaseFailure ??= error;
        if (!leaseAbort.signal.aborted) leaseAbort.abort(error);
      })
      .finally(() => {
        renewing = undefined;
      });
  };
  const heartbeat = setInterval(renew, SYNC_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const response = await withHeavyTaskRootContext({ ownerId, rootTaskId, kind }, () =>
      independentFetchSignal.run(leaseAbort.signal, () => body(leaseAbort.signal)),
    );
    if (leaseFailure) return serviceUnavailableResponse(responseHeaders);
    appendResponseHeaders(response, responseHeaders);
    return response;
  } catch (error) {
    if (leaseFailure || error instanceof IndependentLeaseLostError) {
      return serviceUnavailableResponse(responseHeaders);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    await renewing;
    await releaseIndependentLease(lease).catch(() => undefined);
  }
}

async function acquireIndependentLease(
  ownerId: string,
  rootTaskId: string,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  holder: string,
): Promise<IndependentLease | null> {
  return transaction(async (client) => {
    const nowMs = Date.now();
    const decision = await checkHeavyTaskAdmission(client, {
      ownerId,
      rootTaskId,
      kind,
      nowMs,
      agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
    });
    if (!decision.allowed) {
      if (decision.reason === 'personal_limit') throw new PersonalCapacityError();
      return null;
    }
    if (
      !decision.inherited &&
      !(await isHeavyTaskFairTurn(client, {
        ownerId,
        rootTaskId,
        kind,
        nowMs,
        candidateQueuedAtMs: nowMs,
        agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
      }))
    ) {
      return null;
    }
    const group = heavyTaskSyncQuotaGroup(ownerId);
    const acquired = await client.query<{ lease_epoch: number | string }>(
      `INSERT INTO generation_provider_slots(
         quota_group, slot_no, holder_attempt_id, lease_epoch, expires_at,
         quarantine_until, cooldown_until
       ) VALUES (
         $1, 0, $2, 1,
         clock_timestamp() + $3 * interval '1 millisecond', NULL, NULL
       )
       ON CONFLICT (quota_group, slot_no) DO UPDATE
         SET holder_attempt_id = EXCLUDED.holder_attempt_id,
             lease_epoch = generation_provider_slots.lease_epoch + 1,
             expires_at = EXCLUDED.expires_at,
             quarantine_until = NULL,
             cooldown_until = NULL
       WHERE generation_provider_slots.holder_attempt_id IS NULL
          OR generation_provider_slots.expires_at <= clock_timestamp()
       RETURNING lease_epoch`,
      [group, holder, SYNC_LEASE_MS],
    );
    const row = acquired.rows[0];
    return row ? { group, holder, epoch: Number(row.lease_epoch) } : null;
  });
}

async function heartbeatIndependentLease(lease: IndependentLease): Promise<boolean> {
  const result = await getGenerationPool().query(
    `UPDATE generation_provider_slots
        SET expires_at = clock_timestamp() + $4 * interval '1 millisecond'
      WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3
        AND expires_at > clock_timestamp()`,
    [lease.group, lease.holder, lease.epoch, SYNC_LEASE_MS],
  );
  return result.rowCount === 1;
}

async function releaseIndependentLease(lease: IndependentLease): Promise<void> {
  await getGenerationPool().query(
    `DELETE FROM generation_provider_slots
      WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3`,
    [lease.group, lease.holder, lease.epoch],
  );
}

async function transaction<T>(body: (client: HeavyTaskAdmissionQueryable) => Promise<T>) {
  const client = await getGenerationPool().connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function installAbortableFetch(): void {
  if (abortableFetchInstalled) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const contextSignal = independentFetchSignal.getStore();
    if (!contextSignal) return originalFetch(input, init);
    const signal = init?.signal ? AbortSignal.any([init.signal, contextSignal]) : contextSignal;
    return originalFetch(input, { ...init, signal });
  }) as typeof globalThis.fetch;
  abortableFetchInstalled = true;
}

class PersonalCapacityError extends Error {}
class IndependentLeaseLostError extends Error {}

function limitResponse(reason: 'personal_limit' | 'site_limit', headers: Headers): Response {
  const response = apiError(
    reason === 'personal_limit'
      ? 'HEAVY_TASK_PERSONAL_CAPACITY_LIMIT'
      : 'HEAVY_TASK_SITE_CAPACITY_LIMIT',
    reason === 'personal_limit' ? 429 : 503,
    reason,
  );
  appendResponseHeaders(response, headers);
  return response;
}

function serviceUnavailableResponse(headers: Headers): Response {
  const response = apiError(
    'HEAVY_TASK_ADMISSION_UNAVAILABLE',
    503,
    'Heavy task admission is unavailable',
  );
  appendResponseHeaders(response, headers);
  return response;
}

function appendResponseHeaders(response: Response, headers: Headers): void {
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') response.headers.append(name, value);
  });
  const cookies = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  for (const cookie of cookies ?? []) response.headers.append('Set-Cookie', cookie);
}
