import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import {
  createOwnerBoundQueryable,
  createOwnerBoundTransactionSource,
  type OwnerBoundQueryable,
} from '@/lib/db/request-queryable';
import { resolveRequestOwnerIdAsync } from '@/lib/server/agent-runtime/owner';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { apiError } from '@/lib/server/api-response';
import { FOREGROUND_GENERATION_ROOT_HEADER } from './foreground-generation';
import {
  backgroundGenerationEnabled,
  getGenerationRequestPool,
} from '@/lib/server/generation-jobs/runtime';

import {
  checkHeavyTaskAdmission,
  heavyTaskOwnerLimit,
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
const SYNC_ABORT_GRACE_MS = 15 * 60 * 1000;
const RELEASE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000] as const;
const independentFetchSignal = new AsyncLocalStorage<AbortSignal>();
let abortableFetchInstalled = false;

interface IndependentLease {
  group: string;
  slot: number;
  holder: string;
  epoch: number;
  expiresAtMs: number;
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
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media' | 'study-qa' | 'study-extract'>,
  body: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  // Worker deployments reject browser media routes at their existing guard;
  // durable worker/Pro media already inherits its admitted root context.
  // Hosted accounts cannot skip identity, even when the local DB is unset.
  if (!isHostedAuthEnabled() && kind === 'media' && backgroundGenerationEnabled()) {
    return body(new AbortController().signal);
  }
  if (!isHostedAuthEnabled() && !process.env.DATABASE_URL?.trim()) {
    return body(new AbortController().signal);
  }

  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  let ownerId: string;
  try {
    ownerId = await resolveRequestOwnerIdAsync(request, responseHeaders);
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, responseHeaders);
    throw error;
  }
  if (!process.env.DATABASE_URL?.trim()) {
    const response = await body(new AbortController().signal);
    appendResponseHeaders(response, responseHeaders);
    return response;
  }
  // Foreground course media is a child of the stable course root acquired by
  // guardClientGeneration inside body. Do not allocate a second random root.
  if (kind === 'media' && request.headers.get(FOREGROUND_GENERATION_ROOT_HEADER)?.trim()) {
    const response = await body(new AbortController().signal);
    appendResponseHeaders(response, responseHeaders);
    return response;
  }
  const holder = randomUUID();
  const rootTaskId = `independent:${holder}`;
  const requestPool = getGenerationRequestPool();
  const requestDb = createOwnerBoundQueryable(requestPool, ownerId);
  let lease: IndependentLease | null;
  try {
    lease = await acquireIndependentLease(requestPool, ownerId, rootTaskId, kind, holder);
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
  let expiryWatchdog: ReturnType<typeof setTimeout> | undefined;
  const armExpiryWatchdog = () => {
    if (expiryWatchdog) clearTimeout(expiryWatchdog);
    expiryWatchdog = setTimeout(() => {
      if (!leaseAbort.signal.aborted) {
        leaseAbort.abort(new IndependentLeaseUncertainError());
      }
    }, SYNC_LEASE_MS - SYNC_ABORT_GRACE_MS);
    expiryWatchdog.unref?.();
  };
  armExpiryWatchdog();
  const renew = () => {
    if (renewing) return;
    renewing = heartbeatIndependentLease(requestDb, lease!)
      .then((alive) => {
        if (!alive) {
          const error = new IndependentLeaseLostError();
          leaseFailure ??= error;
          if (!leaseAbort.signal.aborted) leaseAbort.abort(error);
        } else {
          lease!.expiresAtMs = Date.now() + SYNC_LEASE_MS;
          armExpiryWatchdog();
        }
      })
      // A query error does not prove the fenced row was lost. The one-hour
      // grace remains exclusive longer than every wrapped local hard budget,
      // so preserve the provider's real outcome and retry on the next tick.
      .catch(() => undefined)
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
    if (expiryWatchdog) clearTimeout(expiryWatchdog);
    await renewing;
    try {
      await releaseIndependentLease(requestDb, lease);
    } catch {
      retryReleaseIndependentLease(requestDb, lease);
    }
  }
}

async function acquireIndependentLease(
  pool: ReturnType<typeof getGenerationRequestPool>,
  ownerId: string,
  rootTaskId: string,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media' | 'study-qa' | 'study-extract'>,
  holder: string,
): Promise<IndependentLease | null> {
  return transaction(pool, ownerId, async (client) => {
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
    const ownerLimit = heavyTaskOwnerLimit();
    if (isHostedAuthEnabled()) {
      const acquired = await client.query<{ slot_no: number; lease_epoch: number | string }>(
        'SELECT * FROM app_internal.acquire_heavy_task_sync_lease($1,$2,$3,$4)',
        [ownerId, holder, ownerLimit, SYNC_LEASE_MS],
      );
      const row = acquired.rows[0];
      return row
        ? {
            group: heavyTaskSyncQuotaGroup(ownerId),
            slot: Number(row.slot_no),
            holder,
            epoch: Number(row.lease_epoch),
            expiresAtMs: Date.now() + SYNC_LEASE_MS,
          }
        : null;
    }
    const group = heavyTaskSyncQuotaGroup(ownerId);
    await client.query(
      `INSERT INTO generation_provider_slots(quota_group, slot_no)
       SELECT $1, slot_no FROM generate_series(0, $2 - 1) AS slot_no
       ON CONFLICT DO NOTHING`,
      [group, ownerLimit],
    );
    const acquired = await client.query<{ slot_no: number; lease_epoch: number | string }>(
      `WITH available AS (
         SELECT slot_no FROM generation_provider_slots
          WHERE quota_group=$1 AND slot_no<$2
            AND (holder_attempt_id IS NULL OR expires_at <= clock_timestamp())
          ORDER BY slot_no LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE generation_provider_slots AS target
          SET holder_attempt_id=$3, lease_epoch=target.lease_epoch+1,
              expires_at=clock_timestamp()+$4*interval '1 millisecond',
              quarantine_until=NULL, cooldown_until=NULL
         FROM available
        WHERE target.quota_group=$1 AND target.slot_no=available.slot_no
        RETURNING target.slot_no, target.lease_epoch`,
      [group, ownerLimit, holder, SYNC_LEASE_MS],
    );
    const row = acquired.rows[0];
    return row
      ? {
          group,
          slot: Number(row.slot_no),
          holder,
          epoch: Number(row.lease_epoch),
          expiresAtMs: Date.now() + SYNC_LEASE_MS,
        }
      : null;
  });
}

async function heartbeatIndependentLease(
  db: OwnerBoundQueryable,
  lease: IndependentLease,
): Promise<boolean> {
  if (isHostedAuthEnabled()) {
    const result = await db.query<{ alive: boolean }>(
      'SELECT app_internal.heartbeat_heavy_task_sync_lease($1,$2,$3,$4,$5) AS alive',
      [lease.group, lease.slot, lease.holder, lease.epoch, SYNC_LEASE_MS],
    );
    return result.rows[0]?.alive === true;
  }
  const result = await db.query(
    `UPDATE generation_provider_slots
        SET expires_at = clock_timestamp() + $5 * interval '1 millisecond'
      WHERE quota_group=$1 AND slot_no=$2 AND holder_attempt_id=$3 AND lease_epoch=$4
        AND expires_at > clock_timestamp()
      RETURNING slot_no`,
    [lease.group, lease.slot, lease.holder, lease.epoch, SYNC_LEASE_MS],
  );
  return result.rows.length === 1;
}

async function releaseIndependentLease(
  db: OwnerBoundQueryable,
  lease: IndependentLease,
): Promise<void> {
  if (isHostedAuthEnabled()) {
    await db.query('SELECT app_internal.release_heavy_task_sync_lease($1,$2,$3,$4)', [
      lease.group,
      lease.slot,
      lease.holder,
      lease.epoch,
    ]);
    return;
  }
  await db.query(
    `DELETE FROM generation_provider_slots
      WHERE quota_group=$1 AND slot_no=$2 AND holder_attempt_id=$3 AND lease_epoch=$4`,
    [lease.group, lease.slot, lease.holder, lease.epoch],
  );
}

function retryReleaseIndependentLease(db: OwnerBoundQueryable, lease: IndependentLease): void {
  void (async () => {
    let attempt = 0;
    while (Date.now() < lease.expiresAtMs) {
      const configuredDelay =
        RELEASE_RETRY_DELAYS_MS[Math.min(attempt, RELEASE_RETRY_DELAYS_MS.length - 1)];
      const delayMs = Math.min(configuredDelay, Math.max(1, lease.expiresAtMs - Date.now()));
      await unrefDelay(delayMs);
      try {
        await releaseIndependentLease(db, lease);
        return;
      } catch {
        // A later fenced attempt is safe even if a successor already owns the row.
      }
      attempt += 1;
    }
  })();
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function transaction<T>(
  pool: ReturnType<typeof getGenerationRequestPool>,
  ownerId: string,
  body: (client: HeavyTaskAdmissionQueryable) => Promise<T>,
) {
  const client = await createOwnerBoundTransactionSource(pool, ownerId).connect();
  try {
    await client.query('BEGIN');
    const result = await body(client as HeavyTaskAdmissionQueryable);
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
class IndependentLeaseUncertainError extends Error {}

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
