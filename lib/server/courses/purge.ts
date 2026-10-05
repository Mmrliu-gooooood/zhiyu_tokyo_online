/**
 * Physical purge of deleted courses.
 *
 * Deleting a course in the app tombstones it at once (`stage_meta.deleted_at`,
 * running generation cancelled and fenced) so it disappears immediately. This
 * worker pass then removes what the course stored, after a short grace period:
 * scenes, outline, revisions, its generation job graph, runtime sessions and
 * the media assets only it referenced. The media blobs are then marked
 * unreferenced, and the asset collector deletes their bytes from object
 * storage after its own grace period.
 *
 * One small row per course stays behind on purpose: the `document_stages` row,
 * emptied (no name, no content), carrying the `stage_meta` tombstone that
 * cascades from it. The tombstone is what refuses a stale device that tries to
 * save or re-create the deleted course under the same id; without it the
 * course could come back from an old local copy.
 *
 * Runs as app_worker (row security grants it every row of these tables).
 * Study-space links and progress rows are left to the web role that owns them;
 * every study read already filters tombstoned courses out.
 */
import type { Pool } from 'pg';

import type { Queryable } from '@openmaic/storage/document/pg';

/** Marker written into the emptied stage row so a purged course is not revisited. */
const PURGED_KEY = 'purgedAt';

/** Asset ids as the registry allocates them (`ast_` + lowercase base32). */
const ASSET_ID_PATTERN = 'ast_[0-9a-z]{20,40}';

export interface CoursePurgeConfig {
  /** Wait after the tombstone before purging, so fenced writers have stopped. */
  graceMs: number;
  /**
   * Only tombstones at or after this instant are purged. Courses deleted
   * earlier stay as they are until an operator moves the boundary back.
   */
  deletedSince: Date | null;
  /** Courses per pass. */
  batchSize: number;
}

export function coursePurgeConfig(env: NodeJS.ProcessEnv = process.env): CoursePurgeConfig | null {
  if (env.COURSE_PURGE_ENABLED?.trim() !== '1') return null;
  const grace = Number(env.COURSE_PURGE_GRACE_MS?.trim() || 10 * 60_000);
  const sinceRaw = env.COURSE_PURGE_DELETED_SINCE?.trim();
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) {
    throw new Error('Invalid COURSE_PURGE_DELETED_SINCE (expected an ISO timestamp)');
  }
  return {
    graceMs: Number.isSafeInteger(grace) && grace >= 60_000 ? grace : 10 * 60_000,
    deletedSince: since,
    batchSize: 5,
  };
}

export interface CoursePurgeResult {
  stageId: string;
  assetsRemoved: number;
  blobsReleased: number;
}

/** Tombstoned courses whose content is still stored and whose grace has passed. */
export async function findPurgeableCourses(
  q: Queryable,
  config: CoursePurgeConfig,
): Promise<string[]> {
  const result = await q.query<{ stage_id: string }>(
    `SELECT meta.stage_id
       FROM stage_meta meta
       JOIN document_stages stage ON stage.id = meta.stage_id
      WHERE meta.deleted_at IS NOT NULL
        AND meta.deleted_at <= clock_timestamp() - $1 * interval '1 millisecond'
        AND ($2::timestamptz IS NULL OR meta.deleted_at >= $2::timestamptz)
        AND NOT (stage.data ? '${PURGED_KEY}')
      ORDER BY meta.deleted_at, meta.stage_id
      LIMIT $3`,
    [config.graceMs, config.deletedSince?.toISOString() ?? null, config.batchSize],
  );
  return result.rows.map((row) => row.stage_id);
}

async function tableExists(q: Queryable, table: string): Promise<boolean> {
  const result = await q.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${table}`],
  );
  return result.rows[0]?.present === true;
}

/**
 * Purge one tombstoned course inside the caller's transaction. Returns null
 * when the course is not (or no longer) a tombstoned, unpurged course.
 */
export async function purgeDeletedCourse(
  q: Queryable,
  stageId: string,
): Promise<CoursePurgeResult | null> {
  const meta = await q.query<{ owner_id: string }>(
    `SELECT meta.owner_id
       FROM stage_meta meta
       JOIN document_stages stage ON stage.id = meta.stage_id
      WHERE meta.stage_id = $1 AND meta.deleted_at IS NOT NULL
        AND NOT (stage.data ? '${PURGED_KEY}')
      FOR UPDATE OF meta, stage`,
    [stageId],
  );
  const ownerId = meta.rows[0]?.owner_id;
  if (!ownerId) return null;

  const jobs = await q.query<{ id: string }>(
    'SELECT id FROM generation_jobs WHERE stage_id = $1 FOR UPDATE',
    [stageId],
  );
  const jobIds = jobs.rows.map((row) => row.id);

  // Media this course used: its jobs' inputs and outputs, plus every asset id
  // its stored content mentions (foreground generation writes media without a
  // job). Only the owner's own entries are candidates.
  const candidates = await q.query<{ id: string }>(
    `WITH mentioned AS (
       SELECT asset_id AS id FROM generation_job_assets WHERE job_id = ANY($2::uuid[])
       UNION
       SELECT match[1] FROM document_scenes scene,
              regexp_matches(scene.data::text, '(${ASSET_ID_PATTERN})', 'g') AS match
        WHERE scene.stage_id = $1
       UNION
       SELECT match[1] FROM document_stages stage,
              regexp_matches(stage.data::text, '(${ASSET_ID_PATTERN})', 'g') AS match
        WHERE stage.id = $1
       UNION
       SELECT match[1] FROM document_outlines outline,
              regexp_matches(outline.data::text, '(${ASSET_ID_PATTERN})', 'g') AS match
        WHERE outline.stage_id = $1
     )
     SELECT entry.id
       FROM asset_entries entry
       JOIN mentioned ON mentioned.id = entry.id
      WHERE entry.principal = $3`,
    [stageId, jobIds, ownerId],
  );

  // Generation graph of the course (children first: no cascades on these).
  if (jobIds.length > 0) {
    await q.query(
      `DELETE FROM generation_attempts attempt USING generation_steps step
        WHERE attempt.step_id = step.id AND step.job_id = ANY($1::uuid[])`,
      [jobIds],
    );
    for (const table of [
      'generation_commands',
      'generation_events',
      'generation_job_assets',
      'generation_scenes',
      'generation_steps',
    ]) {
      await q.query(`DELETE FROM ${table} WHERE job_id = ANY($1::uuid[])`, [jobIds]);
    }
    await q.query('DELETE FROM generation_jobs WHERE id = ANY($1::uuid[])', [jobIds]);
  }
  await q.query('DELETE FROM generation_ownership WHERE stage_id = $1', [stageId]);
  if (await tableExists(q, 'runtime_sessions')) {
    await q.query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId]);
  }

  // Content: scenes and outline go; the stage row is emptied and kept as the
  // tombstone's anchor. Revision rows the triggers maintain go last.
  await q.query('DELETE FROM document_scenes WHERE stage_id = $1', [stageId]);
  await q.query('DELETE FROM document_outlines WHERE stage_id = $1', [stageId]);
  await q.query(
    `UPDATE document_stages
        SET name = '', description = NULL, folder_id = NULL,
            data = jsonb_build_object('${PURGED_KEY}', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
      WHERE id = $1`,
    [stageId],
  );
  await q.query('DELETE FROM document_scene_revision WHERE stage_id = $1', [stageId]);
  await q.query('DELETE FROM document_stage_revision WHERE stage_id = $1', [stageId]);

  // Media: drop the owner's entries no other course still references, then
  // mark their blobs unreferenced so the collector reclaims the bytes.
  const candidateIds = candidates.rows.map((row) => row.id);
  let assetsRemoved = 0;
  let blobsReleased = 0;
  if (candidateIds.length > 0) {
    const classroomMedia = (await tableExists(q, 'classroom_media_objects'))
      ? 'AND NOT EXISTS (SELECT 1 FROM classroom_media_objects media WHERE media.asset_id = entry.id)'
      : '';
    const removed = await q.query<{ content_hash: string }>(
      `DELETE FROM asset_entries entry
        WHERE entry.id = ANY($1::text[]) AND entry.principal = $2
          AND NOT EXISTS (SELECT 1 FROM generation_job_assets link WHERE link.asset_id = entry.id)
          ${classroomMedia}
          AND NOT EXISTS (
            SELECT 1 FROM document_scenes scene
             WHERE scene.stage_id <> $3 AND strpos(scene.data::text, entry.id) > 0)
          AND NOT EXISTS (
            SELECT 1 FROM document_stages stage
             WHERE stage.id <> $3 AND strpos(stage.data::text, entry.id) > 0)
        RETURNING entry.content_hash`,
      [candidateIds, ownerId, stageId],
    );
    assetsRemoved = removed.rows.length;
    const hashes = [...new Set(removed.rows.map((row) => row.content_hash))];
    if (hashes.length > 0) {
      const released = await q.query<{ content_hash: string }>(
        `UPDATE asset_blobs blob
            SET unreferenced_at = COALESCE(blob.unreferenced_at, clock_timestamp())
          WHERE blob.content_hash = ANY($1::text[])
            AND NOT EXISTS (SELECT 1 FROM asset_entries entry WHERE entry.content_hash = blob.content_hash)
          RETURNING blob.content_hash`,
        [hashes],
      );
      blobsReleased = released.rows.length;
    }
  }
  return { stageId, assetsRemoved, blobsReleased };
}

async function inTransaction<T>(pool: Pool, body: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const q: Queryable = {
    query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }),
  };
  try {
    await client.query('BEGIN');
    const result = await body(q);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One pass: purge up to `batchSize` courses, each in its own transaction. */
export async function runCoursePurgePass(
  pool: Pool,
  config: CoursePurgeConfig,
  report: (event: Record<string, unknown>) => void = () => undefined,
): Promise<CoursePurgeResult[]> {
  const stageIds = await inTransaction(pool, (q) => findPurgeableCourses(q, config));
  const results: CoursePurgeResult[] = [];
  for (const stageId of stageIds) {
    try {
      const result = await inTransaction(pool, (q) => purgeDeletedCourse(q, stageId));
      if (result) {
        results.push(result);
        report({ event: 'course_purged', ...result });
      }
    } catch (error) {
      report({
        event: 'course_purge_failed',
        stageId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return results;
}

export interface CoursePurgeSchedule {
  stop(): void;
}

/** Run a pass every `intervalMs` (no overlap); null when purging is not enabled. */
export function startCoursePurgeSchedule(
  pool: Pool,
  options: {
    config?: CoursePurgeConfig | null;
    intervalMs?: number;
    report?: (event: Record<string, unknown>) => void;
  } = {},
): CoursePurgeSchedule | null {
  const config = options.config === undefined ? coursePurgeConfig() : options.config;
  if (!config) return null;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runCoursePurgePass(pool, config, options.report)
      .catch(() => options.report?.({ event: 'course_purge_unavailable' }))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? 5 * 60_000);
  timer.unref?.();
  tick();
  return { stop: () => clearInterval(timer) };
}
