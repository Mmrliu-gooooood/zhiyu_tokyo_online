import { createHash } from 'node:crypto';

import { isHostedAuthEnabled } from '@/lib/auth/mode';
import {
  createOwnerBoundQueryable,
  createOwnerBoundTransactionSource,
} from '@/lib/db/request-queryable';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { getGenerationRequestPool } from '@/lib/server/generation-jobs/runtime';

import {
  checkHeavyTaskAdmission,
  heavyTaskOwnerLimit,
  heavyTaskSiteLimit,
  heavyTaskSyncQuotaGroup,
  isHeavyTaskFairTurn,
  type HeavyTaskAdmissionQueryable,
} from './index';

export const FOREGROUND_GENERATION_ROOT_HEADER = 'x-generation-root-stage-id';
export const FOREGROUND_GENERATION_SESSION_HEADER = 'x-generation-root-session-id';

// A foreground course is a multi-request root: outline review and browser-side
// scene orchestration can legitimately leave gaps between requests. Every
// request renews this lease; completion/cancellation releases it immediately,
// while an abandoned tab becomes reusable without operator intervention.
export const FOREGROUND_GENERATION_LEASE_MS = 60 * 60 * 1000;

export type ForegroundGenerationAdmission =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'personal_limit' | 'site_limit' | 'account_inactive' | 'unavailable';
    };

function foregroundHolder(ownerId: string, stageId: string, sessionId: string): string {
  if (
    !ownerId.trim() ||
    !stageId.trim() ||
    !sessionId.trim() ||
    ownerId.length > 500 ||
    stageId.length > 500 ||
    sessionId.length > 200
  ) {
    throw new Error('Invalid foreground generation root identity');
  }
  const bytes = createHash('sha256')
    .update('openmaic:foreground-generation:v1\0')
    .update(ownerId)
    .update('\0')
    .update(stageId)
    .update('\0')
    .update(sessionId)
    .digest()
    .subarray(0, 16);
  // Deterministic RFC 4122-shaped UUID. The value is only a lease holder/fence,
  // never an authorization token; owner scope is independently asserted in DB.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function foregroundGenerationRootId(
  ownerId: string,
  stageId: string,
  sessionId: string,
): string {
  return `foreground:${foregroundHolder(ownerId, stageId, sessionId)}`;
}

/**
 * Acquire or renew the one durable root lease shared by all requests for a
 * foreground-generated course. The capacity decision and lease mutation share
 * one transaction/advisory lock, so concurrent processes cannot over-admit.
 */
export async function acquireForegroundGenerationRoot(
  ownerId: string,
  stageId: string,
  sessionId: string,
): Promise<ForegroundGenerationAdmission> {
  const holder = foregroundHolder(ownerId, stageId, sessionId);
  const rootTaskId = `foreground:${holder}`;
  const pool = getGenerationRequestPool();
  const client = await createOwnerBoundTransactionSource(pool, ownerId).connect();
  try {
    await client.query('BEGIN');
    const queryable = client as HeavyTaskAdmissionQueryable;
    const nowMs = Date.now();
    if (isHostedAuthEnabled()) {
      const result = await queryable.query<{ allowed: boolean; reason: string | null }>(
        'SELECT * FROM app_internal.acquire_foreground_generation_root($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          ownerId,
          holder,
          nowMs,
          nowMs - agentRuntimeConfig.leaseTtlMs,
          nowMs - agentRuntimeConfig.leaseTtlMs,
          heavyTaskOwnerLimit(),
          heavyTaskSiteLimit(),
          FOREGROUND_GENERATION_LEASE_MS,
        ],
      );
      const row = result.rows[0];
      await client.query('COMMIT');
      return row?.allowed === true
        ? { allowed: true }
        : {
            allowed: false,
            reason:
              row?.reason === 'personal_limit'
                ? 'personal_limit'
                : row?.reason === 'account_inactive'
                  ? 'account_inactive'
                  : 'site_limit',
          };
    }
    const decision = await checkHeavyTaskAdmission(queryable, {
      ownerId,
      rootTaskId,
      kind: 'generation',
      nowMs,
      candidateQueuedAtMs: nowMs,
      agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
    });
    if (!decision.allowed) {
      await client.query('ROLLBACK');
      return { allowed: false, reason: decision.reason };
    }
    if (
      !decision.inherited &&
      !(await isHeavyTaskFairTurn(queryable, {
        ownerId,
        rootTaskId,
        kind: 'generation',
        nowMs,
        candidateQueuedAtMs: nowMs,
        agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
      }))
    ) {
      await client.query('ROLLBACK');
      return { allowed: false, reason: 'site_limit' };
    }

    const ownerLimit = heavyTaskOwnerLimit();
    const acquired = await acquireLocal(queryable, ownerId, holder, ownerLimit);
    if (acquired.rows.length === 0) {
      await client.query('ROLLBACK');
      return { allowed: false, reason: 'site_limit' };
    }
    await client.query('COMMIT');
    return { allowed: true };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return { allowed: false, reason: 'unavailable' };
  } finally {
    client.release();
  }
}

async function acquireLocal(
  queryable: HeavyTaskAdmissionQueryable,
  ownerId: string,
  holder: string,
  ownerLimit: number,
) {
  const group = heavyTaskSyncQuotaGroup(ownerId);
  await queryable.query(
    `INSERT INTO generation_provider_slots(quota_group,slot_no)
     SELECT $1,slot_no FROM generate_series(0,$2-1) slot_no
     ON CONFLICT DO NOTHING`,
    [group, ownerLimit],
  );
  return queryable.query(
    `WITH candidate AS (
       SELECT slot_no FROM generation_provider_slots
        WHERE quota_group=$1 AND slot_no<$2
          AND (holder_attempt_id=$3 OR holder_attempt_id IS NULL
               OR expires_at<=clock_timestamp())
        ORDER BY CASE WHEN holder_attempt_id=$3 THEN 0 ELSE 1 END,slot_no
        LIMIT 1 FOR UPDATE
     )
     UPDATE generation_provider_slots target
        SET holder_attempt_id=$3,
            lease_epoch=CASE WHEN target.holder_attempt_id=$3
                             THEN target.lease_epoch ELSE target.lease_epoch+1 END,
            expires_at=clock_timestamp()+$4*interval '1 millisecond',
            quarantine_until=NULL,cooldown_until=NULL
       FROM candidate
      WHERE target.quota_group=$1 AND target.slot_no=candidate.slot_no
      RETURNING target.slot_no,target.lease_epoch`,
    [group, ownerLimit, holder, FOREGROUND_GENERATION_LEASE_MS],
  );
}

/** Release is owner-scoped and idempotent; a forged stage id can only target a
 * deterministic holder inside the caller's own quota group. */
export async function releaseForegroundGenerationRoot(
  ownerId: string,
  stageId: string,
  sessionId: string,
  queryable?: HeavyTaskAdmissionQueryable,
): Promise<void> {
  const holder = foregroundHolder(ownerId, stageId, sessionId);
  const db = queryable ?? createOwnerBoundQueryable(getGenerationRequestPool(), ownerId);
  if (isHostedAuthEnabled()) {
    await db.query('SELECT app_internal.release_heavy_task_foreground_lease($1,$2)', [
      ownerId,
      holder,
    ]);
    return;
  }
  await db.query(
    `DELETE FROM generation_provider_slots
      WHERE quota_group=$1 AND holder_attempt_id=$2`,
    [heavyTaskSyncQuotaGroup(ownerId), holder],
  );
}
