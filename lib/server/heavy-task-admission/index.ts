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

export interface HeavyTaskAdmissionOptions extends HeavyTaskRootContext {
  /** Current wall-clock milliseconds, injected by claim paths for deterministic tests. */
  nowMs?: number;
  /** Agent and material leases currently share this deployment TTL. */
  agentLeaseTtlMs: number;
  materialLeaseTtlMs?: number;
  siteLimit?: number;
  /** Read-only status projections may skip serialization; claim paths keep the default. */
  lock?: boolean;
}

const ADMISSION_LOCK = 'heavy-task:admission:v1';
const rootContext = new AsyncLocalStorage<HeavyTaskRootContext>();

export function heavyTaskSiteLimit(env: Record<string, string | undefined> = process.env): 1 | 2 {
  const raw = env.APP_HEAVY_TASK_LIMIT?.trim();
  if (!raw) return 1;
  if (raw === '1' || raw === '2') return Number(raw) as 1 | 2;
  throw new Error('Invalid heavy-task configuration: APP_HEAVY_TASK_LIMIT must be 1 or 2');
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
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_materials')::text AS agent_session_materials`,
  );
  const available = relations.rows[0];
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
  const counts = await queryable.query<{
    active_roots: number | string;
    active_owner_roots: number | string;
    inherited: boolean;
  }>(
    `WITH active_roots AS (${activeSql})
     SELECT COUNT(*) AS active_roots,
            COUNT(*) FILTER (WHERE owner_id = $1) AS active_owner_roots,
            COALESCE(BOOL_OR(owner_id = $1 AND root_task_id = $2), FALSE) AS inherited
       FROM active_roots`,
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
  }>(
    `SELECT to_regclass('generation_jobs')::text AS generation_jobs,
            to_regclass('agent_sessions')::text AS agent_sessions,
            to_regclass('agent_session_materials')::text AS agent_session_materials`,
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
