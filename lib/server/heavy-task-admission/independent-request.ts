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

const SYNC_LEASE_MS = 10 * 60 * 1000;
const SYNC_HEARTBEAT_MS = 30 * 1000;

interface IndependentLease {
  group: string;
  holder: string;
  epoch: number;
}

/**
 * Admit a synchronous parsing/media request through a recoverable PostgreSQL
 * lease. Provider waits never pin a SQL connection; a crashed process simply
 * stops heartbeating and the slot becomes reusable after the bounded lease.
 */
export async function runIndependentHeavyTaskRequest(
  request: Request,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  body: () => Promise<Response>,
): Promise<Response> {
  // Worker deployments reject browser media routes at their existing guard;
  // durable worker/Pro media already inherits its admitted root context.
  if (kind === 'media' && backgroundGenerationEnabled()) return body();
  if (!process.env.DATABASE_URL?.trim()) return body();

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

  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void heartbeatIndependentLease(lease!)
      .catch(() => undefined)
      .finally(() => {
        renewing = false;
      });
  }, SYNC_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const response = await withHeavyTaskRootContext({ ownerId, rootTaskId, kind }, body);
    appendResponseHeaders(response, responseHeaders);
    return response;
  } finally {
    clearInterval(heartbeat);
    await releaseIndependentLease(lease).catch(() => undefined);
  }
}

async function acquireIndependentLease(
  ownerId: string,
  rootTaskId: string,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  holder: string,
): Promise<IndependentLease | null> {
  return transaction(async (queryable) => {
    const nowMs = Date.now();
    const decision = await checkHeavyTaskAdmission(queryable, {
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
      !(await isHeavyTaskFairTurn(queryable, {
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
    const acquired = await queryable.query<{ lease_epoch: number | string }>(
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

async function heartbeatIndependentLease(lease: IndependentLease): Promise<void> {
  await getGenerationPool().query(
    `UPDATE generation_provider_slots
        SET expires_at = clock_timestamp() + $4 * interval '1 millisecond'
      WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3
        AND expires_at > clock_timestamp()`,
    [lease.group, lease.holder, lease.epoch, SYNC_LEASE_MS],
  );
}

async function releaseIndependentLease(lease: IndependentLease): Promise<void> {
  await getGenerationPool().query(
    `UPDATE generation_provider_slots
        SET holder_attempt_id=NULL, expires_at=NULL
      WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3`,
    [lease.group, lease.holder, lease.epoch],
  );
}

async function transaction<T>(body: (queryable: HeavyTaskAdmissionQueryable) => Promise<T>) {
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

class PersonalCapacityError extends Error {}

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
    'HEAVY_TASK_SITE_CAPACITY_LIMIT',
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
