import { AsyncLocalStorage } from 'node:async_hooks';

/** The minimal query contract shared by pg pools, clients, and storage adapters. */
export interface HeavyTaskAdmissionQueryable {
  query<T extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type HeavyTaskKind =
  | 'generation'
  | 'agent'
  | 'material-extraction'
  | 'document-extraction'
  | 'media';

/**
 * Stable root identity carried by a root task and every heavy child it starts.
 * It never contains credentials or user input.
 */
export interface HeavyTaskRootContext {
  ownerId: string;
  rootTaskId: string;
  kind: HeavyTaskKind;
}

export type HeavyTaskAdmissionDecision =
  | { allowed: true; inherited: boolean; activeRoots: number; activeOwnerRoots: number }
  | {
      allowed: false;
      inherited: false;
      reason: 'personal_limit' | 'site_limit';
      activeRoots: number;
      activeOwnerRoots: number;
    };

export type HeavyTaskQueueDecision =
  | { allowed: true; queuedRoots: number; queuedOwnerRoots: number }
  | {
      allowed: false;
      reason: 'personal_queue_limit' | 'site_queue_limit';
      queuedRoots: number;
      queuedOwnerRoots: number;
    };

export type HeavyTaskAttentionDecision =
  | { allowed: true; attentionRoots: number; attentionOwnerRoots: number }
  | {
      allowed: false;
      reason: 'personal_attention_limit' | 'site_attention_limit';
      attentionRoots: number;
      attentionOwnerRoots: number;
    };

export class HeavyTaskCapacityError extends Error {
  override readonly name = 'HeavyTaskCapacityError';
  readonly httpStatus: 429 | 503;
  constructor(
    readonly reason:
      | 'personal_queue_limit'
      | 'site_queue_limit'
      | 'personal_attention_limit'
      | 'site_attention_limit',
  ) {
    super(reason);
    this.httpStatus = reason.startsWith('personal_') ? 429 : 503;
  }
}

export interface HeavyTaskAdmissionOptions extends HeavyTaskRootContext {
  /** Current wall-clock milliseconds, injected by claim paths for deterministic tests. */
  nowMs?: number;
  /** Agent and material leases currently share this deployment TTL. */
  agentLeaseTtlMs: number;
  materialLeaseTtlMs?: number;
  siteLimit?: number;
  /** Read-only status projections may skip serialization; claim paths keep the default. */
  lock?: boolean;
  /** A synchronous request can join the fairness comparison without a durable queue row. */
  candidateQueuedAtMs?: number;
}

const ADMISSION_LOCK = 'heavy-task:admission:v1';
export const HEAVY_TASK_SYNC_QUOTA_PREFIX = 'heavy-task:sync-owner:';
const rootContext = new AsyncLocalStorage<HeavyTaskRootContext>();

export function heavyTaskSiteLimit(env: Record<string, string | undefined> = process.env): 1 | 2 {
  const raw = env.APP_HEAVY_TASK_LIMIT?.trim();
  if (!raw) return 1;
  if (raw === '1' || raw === '2') return Number(raw) as 1 | 2;
  throw new Error('Invalid heavy-task configuration: APP_HEAVY_TASK_LIMIT must be 1 or 2');
}

export function heavyTaskQueueWaitMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GENERATION_QUEUE_WAIT_MS?.trim();
  if (!raw) return 60 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1000) {
    throw new Error('Invalid heavy-task configuration: GENERATION_QUEUE_WAIT_MS');
  }
  return value;
}

export function heavyTaskSyncQuotaGroup(ownerId: string): string {
  assertRootContext({ ownerId, rootTaskId: 'sync-quota-group', kind: 'media' });
  return `${HEAVY_TASK_SYNC_QUOTA_PREFIX}${ownerId}`;
}

export function getHeavyTaskRootContext(): HeavyTaskRootContext | undefined {
  return rootContext.getStore();
}

/**
 * Run child work with an explicit root identity. Nested callers keep the original root;
 * changing owner/root inside an admitted task is a programming error, not a new slot.
 */
export function withHeavyTaskRootContext<T>(context: HeavyTaskRootContext, body: () => T): T {
  assertRootContext(context);
  const parent = rootContext.getStore();
  if (parent) {
    if (parent.ownerId !== context.ownerId || parent.rootTaskId !== context.rootTaskId) {
      throw new Error('Heavy task child attempted to replace its admitted root context');
    }
    return body();
  }
  return rootContext.run(context, body);
}

function assertRootContext(context: HeavyTaskRootContext): void {
  if (!context.ownerId.trim() || !context.rootTaskId.trim()) {
    throw new Error('Heavy task ownerId and rootTaskId must be non-empty');
  }
  if (context.ownerId.length > 500 || context.rootTaskId.length > 500) {
    throw new Error('Heavy task ownerId and rootTaskId are too long');
  }
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Serialize all queue claim decisions and count live roots from the durable rows that
 * already own leases. The caller MUST invoke this inside the same transaction that
 * changes its candidate row to `running`; the transaction-scoped advisory lock is
 * intentionally released at commit, so provider waits never pin a DB connection.
 *
 * Missing relations are omitted. This keeps a process usable while an unrelated queue
 * is disabled, while a fully migrated deployment naturally counts all three queues.
 */
export async function checkHeavyTaskAdmission(
  queryable: HeavyTaskAdmissionQueryable,
  options: HeavyTaskAdmissionOptions,
): Promise<HeavyTaskAdmissionDecision> {
  assertRootContext(options);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('nowMs must be a valid timestamp');
  const agentLeaseTtlMs = positiveDuration(options.agentLeaseTtlMs, 'agentLeaseTtlMs');
  const materialLeaseTtlMs = positiveDuration(
    options.materialLeaseTtlMs ?? agentLeaseTtlMs,
    'materialLeaseTtlMs',
  );
  const siteLimit = options.siteLimit ?? heavyTaskSiteLimit();
  if (siteLimit !== 1 && siteLimit !== 2) {
    throw new Error('siteLimit must be 1 or 2');
  }

  if (options.lock !== false) {
    await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMISSION_LOCK]);
  }
  const relations = await queryable.query<{
    generation_jobs: string | null;
    agent_sessions: string | null;
    agent_session_materials: string | null;
    generation_provider_slots: string | null;
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_materials')::text AS agent_session_materials,
            to_regclass('generation_provider_slots')::text AS generation_provider_slots`,
  );
  const available = relations.rows[0];
  if (available?.generation_provider_slots && options.lock !== false) {
    await queryable.query(
      `DELETE FROM generation_provider_slots
        WHERE quota_group LIKE '${HEAVY_TASK_SYNC_QUOTA_PREFIX}%'
          AND (holder_attempt_id IS NULL OR expires_at <= clock_timestamp())`,
    );
  }
  const roots: string[] = [];
  const parameters: unknown[] = [options.ownerId, options.rootTaskId];
  if (available?.generation_jobs) {
    roots.push(`
      SELECT owner_id,
             CASE
               WHEN input_snapshot->'source'->>'kind' = 'pro'
                AND NULLIF(input_snapshot->'source'->>'sessionId', '') IS NOT NULL
               THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
               ELSE 'generation:' || id
             END AS root_task_id
        FROM generation_jobs
       WHERE status = 'running' AND lease_expires_at > clock_timestamp()`);
  }
  if (available?.agent_sessions) {
    const agentStaleBefore = `$${parameters.push(nowMs - agentLeaseTtlMs)}`;
    roots.push(`
      SELECT owner_id, 'agent:' || id AS root_task_id
        FROM agent_sessions
       WHERE status = 'running' AND lease_worker_id IS NOT NULL
         AND lease_heartbeat_at IS NOT NULL
         AND lease_heartbeat_at >= ${agentStaleBefore}`);
  }
  if (available?.agent_sessions && available.agent_session_materials) {
    const materialStaleBefore = `$${parameters.push(nowMs - materialLeaseTtlMs)}`;
    roots.push(`
      SELECT session.owner_id, 'agent:' || material.session_id AS root_task_id
        FROM agent_session_materials AS material
        INNER JOIN agent_sessions AS session ON session.id = material.session_id
       WHERE session.deleted_at IS NULL AND material.extraction_status = 'running'
         AND material.extraction_lease_worker_id IS NOT NULL
         AND material.extraction_lease_heartbeat_at IS NOT NULL
         AND material.extraction_lease_heartbeat_at >= ${materialStaleBefore}`);
  }

  const activeSql = roots.length
    ? roots.join('\nUNION\n')
    : `SELECT NULL::text AS owner_id, NULL::text AS root_task_id WHERE FALSE`;
  let synchronousSql = `SELECT 0::bigint AS active_roots, 0::bigint AS active_owner_roots`;
  if (available?.generation_provider_slots) {
    const syncOwnerGroup = `$${parameters.push(heavyTaskSyncQuotaGroup(options.ownerId))}`;
    synchronousSql = `SELECT COUNT(*)::bigint AS active_roots,
                             COUNT(*) FILTER (WHERE quota_group = ${syncOwnerGroup})::bigint
                               AS active_owner_roots
                        FROM generation_provider_slots
                       WHERE quota_group LIKE '${HEAVY_TASK_SYNC_QUOTA_PREFIX}%'
                         AND holder_attempt_id IS NOT NULL
                         AND expires_at > clock_timestamp()`;
  }
  const counts = await queryable.query<{
    active_roots: number | string;
    active_owner_roots: number | string;
    inherited: boolean;
  }>(
    `WITH active_roots AS (${activeSql}), durable AS (
       SELECT COUNT(*)::bigint AS active_roots,
              COUNT(*) FILTER (WHERE owner_id = $1)::bigint AS active_owner_roots,
              COALESCE(BOOL_OR(owner_id = $1 AND root_task_id = $2), FALSE) AS inherited
         FROM active_roots
     ), synchronous AS (${synchronousSql})
     SELECT durable.active_roots + synchronous.active_roots AS active_roots,
            durable.active_owner_roots + synchronous.active_owner_roots AS active_owner_roots,
            durable.inherited
       FROM durable CROSS JOIN synchronous`,
    parameters,
  );
  const row = counts.rows[0];
  const activeRoots = Number(row?.active_roots ?? 0);
  const activeOwnerRoots = Number(row?.active_owner_roots ?? 0);
  const inherited = row?.inherited === true;

  if (inherited) return { allowed: true, inherited, activeRoots, activeOwnerRoots };
  // The per-user limit is deliberately fixed at one for the beta; it is not configurable.
  if (activeOwnerRoots >= 1) {
    return {
      allowed: false,
      inherited: false,
      reason: 'personal_limit',
      activeRoots,
      activeOwnerRoots,
    };
  }
  if (activeRoots >= siteLimit) {
    return {
      allowed: false,
      inherited: false,
      reason: 'site_limit',
      activeRoots,
      activeOwnerRoots,
    };
  }
  return { allowed: true, inherited: false, activeRoots, activeOwnerRoots };
}

/**
 * Check the confirmed pure-queue capacity (five roots per owner, twenty site-wide).
 * Like execution admission, the caller must run this in the same transaction that
 * accepts its new root. The requested root is excluded, so the helper is safe both
 * immediately before insertion and from an after-insert hook in that transaction.
 * Retry backoff and review/attention states are deliberately not pure queue rows.
 */
export async function checkHeavyTaskQueueCapacity(
  queryable: HeavyTaskAdmissionQueryable,
  request: Pick<HeavyTaskRootContext, 'ownerId' | 'rootTaskId'>,
): Promise<HeavyTaskQueueDecision> {
  assertRootContext({ ...request, kind: 'generation' });
  await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMISSION_LOCK]);
  const relations = await queryable.query<{
    generation_jobs: string | null;
    agent_sessions: string | null;
    agent_session_materials: string | null;
    generation_provider_slots: string | null;
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_materials')::text AS agent_session_materials,
            to_regclass('generation_provider_slots')::text AS generation_provider_slots`,
  );
  const available = relations.rows[0];
  const roots: string[] = [];
  if (available?.generation_jobs) {
    roots.push(`
      SELECT owner_id,
             CASE
               WHEN input_snapshot->'source'->>'kind' = 'pro'
                AND NULLIF(input_snapshot->'source'->>'sessionId', '') IS NOT NULL
               THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
               ELSE 'generation:' || id
             END AS root_task_id
        FROM generation_jobs WHERE status = 'queued'`);
  }
  if (available?.agent_sessions) {
    roots.push(`
      SELECT owner_id, 'agent:' || id AS root_task_id
        FROM agent_sessions WHERE status = 'queued' AND deleted_at IS NULL`);
  }
  if (available?.agent_sessions && available.agent_session_materials) {
    roots.push(`
      SELECT session.owner_id, 'agent:' || material.session_id AS root_task_id
        FROM agent_session_materials AS material
        INNER JOIN agent_sessions AS session ON session.id = material.session_id
       WHERE session.deleted_at IS NULL AND material.extraction_status = 'pending'`);
  }
  const queuedSql = roots.length
    ? roots.join('\nUNION\n')
    : `SELECT NULL::text AS owner_id, NULL::text AS root_task_id WHERE FALSE`;
  const counts = await queryable.query<{
    queued_roots: number | string;
    queued_owner_roots: number | string;
  }>(
    `WITH queued_roots AS (${queuedSql}), other_roots AS (
       SELECT owner_id, root_task_id FROM queued_roots
        WHERE NOT (owner_id = $1 AND root_task_id = $2)
     )
     SELECT COUNT(*) AS queued_roots,
            COUNT(*) FILTER (WHERE owner_id = $1) AS queued_owner_roots
       FROM other_roots`,
    [request.ownerId, request.rootTaskId],
  );
  const queuedRoots = Number(counts.rows[0]?.queued_roots ?? 0);
  const queuedOwnerRoots = Number(counts.rows[0]?.queued_owner_roots ?? 0);
  if (queuedOwnerRoots >= 5) {
    return { allowed: false, reason: 'personal_queue_limit', queuedRoots, queuedOwnerRoots };
  }
  if (queuedRoots >= 20) {
    return { allowed: false, reason: 'site_queue_limit', queuedRoots, queuedOwnerRoots };
  }
  return { allowed: true, queuedRoots, queuedOwnerRoots };
}

/** Check the separate review/manual-attention backlog (five owner, twenty site). */
export async function checkHeavyTaskAttentionCapacity(
  queryable: HeavyTaskAdmissionQueryable,
  request: Pick<HeavyTaskRootContext, 'ownerId' | 'rootTaskId'>,
): Promise<HeavyTaskAttentionDecision> {
  assertRootContext({ ...request, kind: 'generation' });
  await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADMISSION_LOCK]);
  const relations = await queryable.query<{
    generation_jobs: string | null;
    agent_sessions: string | null;
    agent_session_events: string | null;
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_events')::text AS agent_session_events`,
  );
  const available = relations.rows[0];
  const roots: string[] = [];
  if (available?.generation_jobs) {
    roots.push(`
      SELECT owner_id,
             CASE
               WHEN input_snapshot->'source'->>'kind' = 'pro'
                AND NULLIF(input_snapshot->'source'->>'sessionId', '') IS NOT NULL
               THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
               ELSE 'generation:' || id
             END AS root_task_id
        FROM generation_jobs
       WHERE status IN ('awaiting_confirmation', 'needs_attention')`);
  }
  if (available?.agent_sessions && available.agent_session_events) {
    roots.push(`
      SELECT session.owner_id, 'agent:' || session.id AS root_task_id
        FROM agent_sessions AS session
       WHERE session.deleted_at IS NULL
         AND session.status IN ('running', 'succeeded', 'failed')
         AND EXISTS (
           SELECT 1 FROM agent_session_events AS question
            WHERE question.session_id = session.id AND question.type = 'user_question'
              AND NOT EXISTS (
                SELECT 1 FROM agent_session_events AS answer
                 WHERE answer.session_id = question.session_id AND answer.seq > question.seq
                   AND answer.type = 'user_message'
                   AND length(btrim(COALESCE(answer.data->>'text', ''))) > 0
              )
         )`);
  }
  const attentionSql = roots.length
    ? roots.join('\nUNION\n')
    : `SELECT NULL::text AS owner_id, NULL::text AS root_task_id WHERE FALSE`;
  const counts = await queryable.query<{
    attention_roots: number | string;
    attention_owner_roots: number | string;
  }>(
    `WITH attention_roots AS (${attentionSql}), other_roots AS (
       SELECT owner_id, root_task_id FROM attention_roots
        WHERE NOT (owner_id = $1 AND root_task_id = $2)
     )
     SELECT COUNT(*) AS attention_roots,
            COUNT(*) FILTER (WHERE owner_id = $1) AS attention_owner_roots
       FROM other_roots`,
    [request.ownerId, request.rootTaskId],
  );
  const attentionRoots = Number(counts.rows[0]?.attention_roots ?? 0);
  const attentionOwnerRoots = Number(counts.rows[0]?.attention_owner_roots ?? 0);
  if (attentionOwnerRoots >= 5) {
    return {
      allowed: false,
      reason: 'personal_attention_limit',
      attentionRoots,
      attentionOwnerRoots,
    };
  }
  if (attentionRoots >= 20) {
    return {
      allowed: false,
      reason: 'site_attention_limit',
      attentionRoots,
      attentionOwnerRoots,
    };
  }
  return { allowed: true, attentionRoots, attentionOwnerRoots };
}

/**
 * Preserve FIFO across the three durable queues while skipping owners that
 * already consume a different root. The admission lock must already be held by
 * the caller; a stale running takeover is absent from queued_roots and may run.
 */
export async function isHeavyTaskFairTurn(
  queryable: HeavyTaskAdmissionQueryable,
  options: HeavyTaskAdmissionOptions,
): Promise<boolean> {
  assertRootContext(options);
  const nowMs = options.nowMs ?? Date.now();
  const agentStaleBefore = nowMs - positiveDuration(options.agentLeaseTtlMs, 'agentLeaseTtlMs');
  const materialStaleBefore =
    nowMs -
    positiveDuration(options.materialLeaseTtlMs ?? options.agentLeaseTtlMs, 'materialLeaseTtlMs');
  const queueFreshAfter = nowMs - heavyTaskQueueWaitMs();
  const relations = await queryable.query<{
    generation_jobs: string | null;
    agent_sessions: string | null;
    agent_session_materials: string | null;
    generation_provider_slots: string | null;
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_materials')::text AS agent_session_materials,
            to_regclass('generation_provider_slots')::text AS generation_provider_slots`,
  );
  const available = relations.rows[0];
  const active: string[] = [];
  const queued: string[] = [];
  if (available?.generation_jobs) {
    const root = `CASE
      WHEN input_snapshot->'source'->>'kind' = 'pro'
       AND NULLIF(input_snapshot->'source'->>'sessionId', '') IS NOT NULL
      THEN 'agent:' || (input_snapshot->'source'->>'sessionId')
      ELSE 'generation:' || id END`;
    active.push(
      `SELECT owner_id, ${root} AS root_task_id FROM generation_jobs
        WHERE status = 'running' AND lease_expires_at > clock_timestamp()`,
    );
    queued.push(
      `SELECT owner_id, ${root} AS root_task_id, created_at AS queued_at
         FROM generation_jobs
        WHERE ((status = 'queued' AND updated_at > to_timestamp($5 / 1000.0))
           OR (status = 'retry_wait' AND available_at <= clock_timestamp()))`,
    );
  }
  if (available?.generation_provider_slots) {
    active.push(
      `SELECT substring(quota_group from ${HEAVY_TASK_SYNC_QUOTA_PREFIX.length + 1}) AS owner_id,
              'independent:' || holder_attempt_id::text AS root_task_id
         FROM generation_provider_slots
        WHERE quota_group LIKE '${HEAVY_TASK_SYNC_QUOTA_PREFIX}%'
          AND holder_attempt_id IS NOT NULL AND expires_at > clock_timestamp()`,
    );
  }
  if (options.candidateQueuedAtMs !== undefined) {
    queued.push(
      `SELECT $1::text AS owner_id, $2::text AS root_task_id,
              to_timestamp($6::bigint / 1000.0) AS queued_at`,
    );
  }
  if (available?.agent_sessions) {
    active.push(
      `SELECT owner_id, 'agent:' || id AS root_task_id FROM agent_sessions
        WHERE status = 'running' AND lease_worker_id IS NOT NULL
          AND lease_heartbeat_at IS NOT NULL AND lease_heartbeat_at >= $3`,
    );
    queued.push(
      `SELECT owner_id, 'agent:' || id AS root_task_id, updated_at AS queued_at
         FROM agent_sessions
        WHERE status = 'queued' AND deleted_at IS NULL
          AND updated_at > to_timestamp($5 / 1000.0)`,
    );
  }
  if (available?.agent_sessions && available.agent_session_materials) {
    active.push(
      `SELECT session.owner_id, 'agent:' || material.session_id AS root_task_id
         FROM agent_session_materials AS material
         JOIN agent_sessions AS session ON session.id = material.session_id
        WHERE session.deleted_at IS NULL AND material.extraction_status = 'running'
          AND material.extraction_lease_worker_id IS NOT NULL
          AND material.extraction_lease_heartbeat_at IS NOT NULL
          AND material.extraction_lease_heartbeat_at >= $4`,
    );
    queued.push(
      `SELECT session.owner_id, 'agent:' || material.session_id AS root_task_id,
              to_timestamp(COALESCE(
                material.extraction_lease_heartbeat_at,
                (extract(epoch FROM material.created_at) * 1000)::bigint
              ) / 1000.0) AS queued_at
         FROM agent_session_materials AS material
         JOIN agent_sessions AS session ON session.id = material.session_id
        WHERE session.deleted_at IS NULL AND material.extraction_status = 'pending'
          AND COALESCE(material.extraction_lease_heartbeat_at,
              (extract(epoch FROM material.created_at) * 1000)::bigint) > $5`,
    );
  }
  const activeSql = active.length
    ? active.join('\nUNION\n')
    : `SELECT NULL::text owner_id, NULL::text root_task_id WHERE FALSE`;
  const queuedSql = queued.length
    ? queued.join('\nUNION ALL\n')
    : `SELECT NULL::text owner_id, NULL::text root_task_id, NULL::timestamptz queued_at WHERE FALSE`;
  const result = await queryable.query<{ candidate_present: boolean; oldest_root: string | null }>(
    `WITH request_params AS (
       SELECT $1::text AS owner_id, $2::text AS root_task_id,
              $3::bigint AS agent_stale_before, $4::bigint AS material_stale_before,
              $5::bigint AS queue_fresh_after, $6::bigint AS candidate_queued_at
     ), active_roots AS (${activeSql}), raw_queue AS (${queuedSql}), queued_roots AS (
       SELECT owner_id, root_task_id, MIN(queued_at) AS queued_at
         FROM raw_queue GROUP BY owner_id, root_task_id
     ), eligible AS (
       SELECT queued_roots.* FROM queued_roots
        WHERE NOT EXISTS (
          SELECT 1 FROM active_roots
           WHERE active_roots.owner_id = queued_roots.owner_id
             AND active_roots.root_task_id <> queued_roots.root_task_id
        )
     )
     SELECT EXISTS(SELECT 1 FROM queued_roots WHERE owner_id=$1 AND root_task_id=$2)
              AS candidate_present,
            (SELECT root_task_id FROM eligible ORDER BY queued_at, root_task_id LIMIT 1)
              AS oldest_root
       FROM request_params`,
    [
      options.ownerId,
      options.rootTaskId,
      agentStaleBefore,
      materialStaleBefore,
      queueFreshAfter,
      options.candidateQueuedAtMs ?? nowMs,
    ],
  );
  const row = result.rows[0];
  return row?.candidate_present !== true || row.oldest_root === options.rootTaskId;
}
