import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

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
  type HeavyTaskKind,
} from './index';

const SYNC_LEASE_MS = 10 * 60 * 1000;

interface IndependentLeaseGuard {
  group: string;
  holder: string;
  epoch: number;
  client: PoolClient;
}

/**
 * Admit a synchronous parsing/media request through a recoverable PostgreSQL
 * lease. One row lock is held while provider work runs. Because site admission
 * is capped at two roots, this consumes at most two of the pool's eight clients.
 * The lock prevents an expired lease from being reclaimed while its body is
 * still alive; a crashed process releases the lock automatically and the
 * bounded lease then makes the row recoverable.
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
  let guard: IndependentLeaseGuard | null;
  try {
    guard = await acquireIndependentLease(ownerId, rootTaskId, kind, holder);
  } catch (error) {
    return error instanceof PersonalCapacityError
      ? limitResponse('personal_limit', responseHeaders)
      : serviceUnavailableResponse(responseHeaders);
  }
  if (!guard) return limitResponse('site_limit', responseHeaders);

  try {
    const response = await withHeavyTaskRootContext({ ownerId, rootTaskId, kind }, body);
    appendResponseHeaders(response, responseHeaders);
    return response;
  } finally {
    await releaseIndependentLease(guard);
  }
}

async function acquireIndependentLease(
  ownerId: string,
  rootTaskId: string,
  kind: Extract<HeavyTaskKind, 'document-extraction' | 'media'>,
  holder: string,
): Promise<IndependentLeaseGuard | null> {
  const client = await getGenerationPool().connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
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
      await client.query('ROLLBACK');
      transactionOpen = false;
      client.release();
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
      await client.query('ROLLBACK');
      transactionOpen = false;
      client.release();
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
    if (!row) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      client.release();
      return null;
    }

    const epoch = Number(row.lease_epoch);
    await client.query('COMMIT');
    transactionOpen = false;

    // Start a separate guard transaction after publishing the lease. The
    // ten-minute expiry closes the tiny commit-to-lock window to competitors.
    await client.query('BEGIN');
    transactionOpen = true;
    const locked = await client.query(
      `SELECT 1 FROM generation_provider_slots
        WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3
        FOR UPDATE`,
      [group, holder, epoch],
    );
    if (locked.rowCount !== 1) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      client.release();
      return null;
    }
    return { group, holder, epoch, client };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    client.release(error instanceof Error ? error : undefined);
    throw error;
  }
}

async function releaseIndependentLease(guard: IndependentLeaseGuard): Promise<void> {
  try {
    await guard.client.query(
      `DELETE FROM generation_provider_slots
        WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3`,
      [guard.group, guard.holder, guard.epoch],
    );
    await guard.client.query('COMMIT');
  } catch (_error) {
    await guard.client.query('ROLLBACK').catch(() => undefined);
    // The fenced fallback handles a connection failure after the body without
    // risking deletion of a successor's lease.
    await getGenerationPool()
      .query(
        `DELETE FROM generation_provider_slots
          WHERE quota_group=$1 AND slot_no=0 AND holder_attempt_id=$2 AND lease_epoch=$3`,
        [guard.group, guard.holder, guard.epoch],
      )
      .catch(() => undefined);
  } finally {
    guard.client.release();
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
