/**
 * Study spaces repository (learning plan B01). Every query names the owner
 * explicitly, so isolation holds on legacy installs without row security; on
 * hosted databases the same queries also run under the owner-bound app_web
 * policies of accounts v22.
 *
 * A course is "the owner's live course" when its stage_meta row names the
 * owner and is not tombstoned. Links and progress are only written for such
 * courses; tombstoned courses drop out of every read.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  STUDY_SPACE_LIMITS,
  type CourseGenerationState,
  type LinkableCourse,
  type ProgressWriteInput,
  type StudyCourseProgressView,
  type StudySpaceCourse,
  type StudySpaceDetail,
  type StudySpaceInput,
  type StudySpacePatch,
  type StudySpaceSummary,
} from '@/lib/study/spaces/contracts';

/** Request-bound database: each query() runs owner-bound; withTransaction() reuses one connection. */
export interface StudyDb extends Queryable {
  withTransaction: <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;
}

export type StudyErrorCode =
  | 'STUDY_SPACE_NOT_FOUND'
  | 'STUDY_COURSE_NOT_FOUND'
  | 'STUDY_SCENE_NOT_FOUND'
  | 'STUDY_ACTION_OUT_OF_RANGE'
  | 'STUDY_REVISION_CONFLICT'
  | 'STUDY_SPACE_LIMIT'
  | 'STUDY_SPACE_COURSE_LIMIT'
  | 'STUDY_SPACE_ARCHIVED'
  // B02 material library
  | 'STUDY_MATERIAL_NOT_FOUND'
  | 'STUDY_MATERIAL_LIMIT'
  | 'STUDY_MATERIAL_VERSION_LIMIT'
  | 'STUDY_SPACE_MATERIAL_LIMIT'
  | 'STUDY_MATERIAL_TYPE_UNSUPPORTED'
  | 'STUDY_MATERIAL_NOT_PARSED'
  | 'STUDY_MATERIAL_UNAVAILABLE'
  | 'STUDY_PARSER_UNAVAILABLE'
  | 'STUDY_TASKS_UNAVAILABLE'
  // Retrieval and cited answers (B03).
  | 'STUDY_QA_UNAVAILABLE'
  | 'STUDY_QA_NOT_INDEXED'
  | 'STUDY_QA_INVALID_SCOPE'
  | 'STUDY_QA_RATE_LIMITED'
  | 'STUDY_QA_ANSWER_INVALID'
  | 'STUDY_QA_MODEL_UNAVAILABLE'
  | 'STUDY_INDEX_QUOTA_EXCEEDED';

const STATUS: Record<StudyErrorCode, number> = {
  STUDY_MATERIAL_NOT_FOUND: 404,
  STUDY_MATERIAL_LIMIT: 409,
  STUDY_MATERIAL_VERSION_LIMIT: 409,
  STUDY_SPACE_MATERIAL_LIMIT: 409,
  STUDY_MATERIAL_TYPE_UNSUPPORTED: 415,
  STUDY_MATERIAL_NOT_PARSED: 409,
  STUDY_MATERIAL_UNAVAILABLE: 503,
  STUDY_PARSER_UNAVAILABLE: 422,
  STUDY_TASKS_UNAVAILABLE: 503,
  STUDY_QA_UNAVAILABLE: 503,
  STUDY_QA_NOT_INDEXED: 409,
  STUDY_QA_INVALID_SCOPE: 400,
  STUDY_QA_RATE_LIMITED: 429,
  STUDY_QA_ANSWER_INVALID: 502,
  STUDY_QA_MODEL_UNAVAILABLE: 503,
  STUDY_INDEX_QUOTA_EXCEEDED: 409,
  STUDY_SPACE_NOT_FOUND: 404,
  STUDY_COURSE_NOT_FOUND: 404,
  STUDY_SCENE_NOT_FOUND: 422,
  STUDY_ACTION_OUT_OF_RANGE: 422,
  STUDY_REVISION_CONFLICT: 409,
  STUDY_SPACE_LIMIT: 409,
  STUDY_SPACE_COURSE_LIMIT: 409,
  STUDY_SPACE_ARCHIVED: 409,
};

export class StudyError extends Error {
  readonly status: number;
  constructor(
    readonly code: StudyErrorCode,
    /** Safe, owner-scoped data the client needs to recover (e.g. the current row on a conflict). */
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'StudyError';
    this.status = STATUS[code];
  }
}

export function createStudySpaceId(): string {
  return `space-${randomBytes(9).toString('base64url')}`;
}

// ── row mapping ────────────────────────────────────────────────────────────

interface SpaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  education_level: string | null;
  subject: string | null;
  goal: string | null;
  exam_date: string | Date | null;
  exam_scope: string | null;
  timezone: string | null;
  status: 'active' | 'archived';
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
}

const SPACE_COLUMNS = `id, name, education_level, subject, goal, exam_date::text AS exam_date,
  exam_scope, timezone, status, revision, created_at, updated_at`;

function iso(value: string | Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function spaceFromRow(
  row: SpaceRow,
  courseCount: number,
  lastStudied: StudyCourseProgressView | null,
): StudySpaceSummary {
  return {
    id: row.id,
    name: row.name,
    educationLevel: row.education_level as StudySpaceSummary['educationLevel'],
    subject: row.subject,
    goal: row.goal,
    examDate:
      row.exam_date === null
        ? null
        : row.exam_date instanceof Date
          ? row.exam_date.toISOString().slice(0, 10)
          : String(row.exam_date).slice(0, 10),
    examScope: row.exam_scope,
    timezone: row.timezone,
    status: row.status,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    courseCount,
    lastStudied,
  };
}

interface CourseRow extends Record<string, unknown> {
  stage_id: string;
  name: string;
  updated_at: number | string;
  scene_count: number | string;
  outline_count: number | string | null;
  outline_complete: boolean | null;
  meta_complete: boolean | null;
}

/**
 * The outline is the authority on generation (stage_meta.generation_complete is
 * a mirror). A course without an outline (imported, or written by tools) is
 * treated as complete; one whose scenes cover every outline entry is too.
 */
function generationState(row: CourseRow): CourseGenerationState {
  if (row.outline_complete === true || row.meta_complete === true) return 'complete';
  if (row.outline_count === null) return 'complete';
  return Number(row.scene_count) >= Number(row.outline_count) ? 'complete' : 'incomplete';
}

/** Live courses of the owner, optionally limited to some ids. */
const LIVE_COURSES_SQL = `
  SELECT d.id AS stage_id, d.name, d.updated_at,
         (SELECT count(*) FROM document_scenes s WHERE s.stage_id = d.id) AS scene_count,
         CASE WHEN jsonb_typeof(o.data->'outlines') = 'array'
              THEN jsonb_array_length(o.data->'outlines') END AS outline_count,
         (o.data->>'generationComplete') = 'true' AS outline_complete,
         m.generation_complete AS meta_complete
    FROM stage_meta m
    JOIN document_stages d ON d.id = m.stage_id
    LEFT JOIN document_outlines o ON o.stage_id = d.id
   WHERE m.owner_id = $1 AND m.deleted_at IS NULL`;

async function liveCourses(
  db: Queryable,
  ownerId: string,
  stageIds?: string[],
): Promise<Map<string, CourseRow>> {
  if (stageIds && stageIds.length === 0) return new Map();
  const result = stageIds
    ? await db.query<CourseRow>(`${LIVE_COURSES_SQL} AND d.id = ANY($2::text[])`, [
        ownerId,
        stageIds,
      ])
    : await db.query<CourseRow>(`${LIVE_COURSES_SQL} ORDER BY d.updated_at DESC LIMIT 500`, [
        ownerId,
      ]);
  return new Map(result.rows.map((row) => [row.stage_id, row]));
}

interface ProgressRow extends Record<string, unknown> {
  stage_id: string;
  scene_id: string;
  action_index: number;
  action_count: number;
  action_id: string | null;
  scene_revision: number | string;
  furthest_scene_index: number;
  reached_end_at: string | Date | null;
  revision: number;
  observed_at: string | Date;
  updated_at: string | Date;
}

interface SceneRow extends Record<string, unknown> {
  stage_id: string;
  id: string;
  rev: number | string;
}

const PROGRESS_COLUMNS = `stage_id, scene_id, action_index, action_count, action_id, scene_revision,
  furthest_scene_index, reached_end_at, revision, observed_at, updated_at`;

/** Scene ids (in playback order) and their current revisions for some courses. */
async function sceneOrder(db: Queryable, stageIds: string[]): Promise<Map<string, SceneRow[]>> {
  const out = new Map<string, SceneRow[]>();
  if (stageIds.length === 0) return out;
  const result = await db.query<SceneRow>(
    `SELECT s.stage_id, s.id, COALESCE(r.rev, 0) AS rev
       FROM document_scenes s
       LEFT JOIN document_scene_revision r ON r.stage_id = s.stage_id AND r.scene_id = s.id
      WHERE s.stage_id = ANY($1::text[])
      ORDER BY s.stage_id, s.scene_order, s.id`,
    [stageIds],
  );
  for (const row of result.rows) {
    const list = out.get(row.stage_id) ?? [];
    list.push(row);
    out.set(row.stage_id, list);
  }
  return out;
}

function progressView(
  row: ProgressRow,
  course: CourseRow,
  scenes: SceneRow[],
): StudyCourseProgressView {
  const index = scenes.findIndex((scene) => scene.id === row.scene_id);
  const scene = index >= 0 ? scenes[index] : undefined;
  const changed = scene !== undefined && String(scene.rev) !== String(row.scene_revision);
  const finished = Number(row.action_index) >= Number(row.action_count);
  let resumeSceneId: string | null = scene ? row.scene_id : null;
  let resumeActionIndex = scene && !changed ? Number(row.action_index) : 0;
  if (scene && !changed && finished) {
    // A finished scene continues at the next one; the finished last scene replays.
    const next = scenes[index + 1];
    if (next) resumeSceneId = next.id;
    resumeActionIndex = 0;
  }
  return {
    stageId: row.stage_id,
    courseName: course.name,
    sceneId: row.scene_id,
    sceneIndex: index >= 0 ? index : null,
    sceneCount: scenes.length,
    actionIndex: Number(row.action_index),
    actionId: row.action_id,
    furthestSceneIndex: Math.min(Number(row.furthest_scene_index), Math.max(0, scenes.length - 1)),
    reachedEnd: row.reached_end_at !== null,
    sceneChanged: changed,
    sceneMissing: scene === undefined,
    resumeSceneId,
    resumeActionIndex,
    revision: Number(row.revision),
    observedAt: iso(row.observed_at),
    updatedAt: iso(row.updated_at),
  };
}

async function progressFor(
  db: Queryable,
  ownerId: string,
  courses: Map<string, CourseRow>,
): Promise<Map<string, StudyCourseProgressView>> {
  const ids = [...courses.keys()];
  const out = new Map<string, StudyCourseProgressView>();
  if (ids.length === 0) return out;
  const rows = await db.query<ProgressRow>(
    `SELECT ${PROGRESS_COLUMNS} FROM study_progress
      WHERE owner_id = $1 AND stage_id = ANY($2::text[])`,
    [ownerId, ids],
  );
  if (rows.rows.length === 0) return out;
  const scenes = await sceneOrder(
    db,
    rows.rows.map((row) => row.stage_id),
  );
  for (const row of rows.rows) {
    const course = courses.get(row.stage_id);
    if (course) out.set(row.stage_id, progressView(row, course, scenes.get(row.stage_id) ?? []));
  }
  return out;
}

function latest(views: Iterable<StudyCourseProgressView>): StudyCourseProgressView | null {
  let best: StudyCourseProgressView | null = null;
  for (const view of views) {
    if (!best || view.updatedAt > best.updatedAt) best = view;
  }
  return best;
}

interface LinkRow extends Record<string, unknown> {
  space_id: string;
  stage_id: string;
  added_at: string | Date;
  added_via: 'link' | 'generation';
}

// ── spaces ─────────────────────────────────────────────────────────────────

export async function listStudySpaces(db: StudyDb, ownerId: string): Promise<StudySpaceSummary[]> {
  return db.withTransaction(async (tx) => {
    const spaces = await tx.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS} FROM study_spaces WHERE owner_id = $1
        ORDER BY status, updated_at DESC`,
      [ownerId],
    );
    if (spaces.rows.length === 0) return [];
    const links = await tx.query<LinkRow>(
      'SELECT space_id, stage_id, added_at, added_via FROM study_space_courses WHERE owner_id = $1',
      [ownerId],
    );
    const courses = await liveCourses(tx, ownerId, [
      ...new Set(links.rows.map((link) => link.stage_id)),
    ]);
    const progress = await progressFor(tx, ownerId, courses);
    return spaces.rows.map((row) => {
      const stageIds = links.rows
        .filter((link) => link.space_id === row.id && courses.has(link.stage_id))
        .map((link) => link.stage_id);
      return spaceFromRow(
        row,
        stageIds.length,
        latest(stageIds.flatMap((id) => (progress.has(id) ? [progress.get(id)!] : []))),
      );
    });
  });
}

export async function getStudySpace(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
): Promise<StudySpaceDetail> {
  return db.withTransaction(async (tx) => {
    const space = await tx.query<SpaceRow>(
      `SELECT ${SPACE_COLUMNS} FROM study_spaces WHERE owner_id = $1 AND id = $2`,
      [ownerId, spaceId],
    );
    const row = space.rows[0];
    if (!row) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const links = await tx.query<LinkRow>(
      `SELECT space_id, stage_id, added_at, added_via FROM study_space_courses
        WHERE owner_id = $1 AND space_id = $2 ORDER BY added_at DESC`,
      [ownerId, spaceId],
    );
    const courses = await liveCourses(
      tx,
      ownerId,
      links.rows.map((link) => link.stage_id),
    );
    const progress = await progressFor(tx, ownerId, courses);
    const items: StudySpaceCourse[] = links.rows.flatMap((link) => {
      const course = courses.get(link.stage_id);
      if (!course) return [];
      return [
        {
          stageId: link.stage_id,
          name: course.name,
          sceneCount: Number(course.scene_count),
          generation: generationState(course),
          addedAt: iso(link.added_at),
          addedVia: link.added_via,
          courseUpdatedAt: iso(Number(course.updated_at)),
          progress: progress.get(link.stage_id) ?? null,
        },
      ];
    });
    return {
      ...spaceFromRow(row, items.length, latest(progress.values())),
      courses: items,
    };
  });
}

export async function createStudySpace(
  db: StudyDb,
  ownerId: string,
  input: StudySpaceInput,
  id: string = createStudySpaceId(),
): Promise<StudySpaceSummary> {
  return db.withTransaction(async (tx) => {
    // Serialize one owner's creates so the count check cannot be raced.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('study_spaces:' || $1))", [ownerId]);
    const count = await tx.query<{ n: number | string }>(
      'SELECT count(*) AS n FROM study_spaces WHERE owner_id = $1',
      [ownerId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= STUDY_SPACE_LIMITS.spacesPerOwner) {
      throw new StudyError('STUDY_SPACE_LIMIT', { maximum: STUDY_SPACE_LIMITS.spacesPerOwner });
    }
    const inserted = await tx.query<SpaceRow>(
      `INSERT INTO study_spaces
         (id, owner_id, name, education_level, subject, goal, exam_date, exam_scope, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
       RETURNING ${SPACE_COLUMNS}`,
      [
        id,
        ownerId,
        input.name,
        input.educationLevel,
        input.subject,
        input.goal,
        input.examDate,
        input.examScope,
        input.timezone,
      ],
    );
    return spaceFromRow(inserted.rows[0]!, 0, null);
  });
}

const PATCH_COLUMNS: Array<[keyof StudySpaceInput, string, string]> = [
  ['name', 'name', ''],
  ['educationLevel', 'education_level', ''],
  ['subject', 'subject', ''],
  ['goal', 'goal', ''],
  ['examDate', 'exam_date', '::date'],
  ['examScope', 'exam_scope', ''],
  ['timezone', 'timezone', ''],
];

/**
 * Apply a partial update when `expectedRevision` is still current. A stale
 * revision answers STUDY_REVISION_CONFLICT carrying the current space, so the
 * client can show it instead of silently overwriting a newer edit.
 */
export async function updateStudySpace(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  patch: StudySpacePatch,
  expectedRevision: number,
): Promise<StudySpaceSummary> {
  const sets: string[] = [];
  const values: unknown[] = [ownerId, spaceId, expectedRevision];
  for (const [field, column, cast] of PATCH_COLUMNS) {
    if (!(field in patch)) continue;
    values.push(patch[field]);
    sets.push(`${column} = $${values.length}${cast}`);
  }
  if (patch.status) {
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
    sets.push(
      `archived_at = CASE WHEN $${values.length} = 'archived' THEN COALESCE(archived_at, clock_timestamp()) END`,
    );
  }
  await db
    .withTransaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE study_spaces
          SET ${sets.join(', ')}, revision = revision + 1, updated_at = clock_timestamp()
        WHERE owner_id = $1 AND id = $2 AND revision = $3
        RETURNING id`,
        values,
      );
      if (updated.rows.length === 1) return;
      const exists = await tx.query<{ id: string }>(
        'SELECT id FROM study_spaces WHERE owner_id = $1 AND id = $2',
        [ownerId, spaceId],
      );
      if (exists.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
      throw new StudyError('STUDY_REVISION_CONFLICT');
    })
    .catch(async (error) => {
      if (error instanceof StudyError && error.code === 'STUDY_REVISION_CONFLICT') {
        throw new StudyError('STUDY_REVISION_CONFLICT', {
          current: await getStudySpace(db, ownerId, spaceId),
        });
      }
      throw error;
    });
  return getStudySpace(db, ownerId, spaceId);
}

/** Delete a space and its course links. The courses themselves stay. */
export async function deleteStudySpace(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
): Promise<void> {
  const deleted = await db.query<{ id: string }>(
    'DELETE FROM study_spaces WHERE owner_id = $1 AND id = $2 RETURNING id',
    [ownerId, spaceId],
  );
  if (deleted.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
}

// ── course links ───────────────────────────────────────────────────────────

/**
 * Link one of the owner's live courses into an active space. Repeating a link
 * (a retried request, a regenerated job) is a no-op that reports
 * `created: false`.
 */
export async function linkStudySpaceCourse(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  stageId: string,
  via: 'link' | 'generation',
): Promise<{ created: boolean }> {
  return db.withTransaction(async (tx) => {
    const space = await tx.query<{ status: string }>(
      'SELECT status FROM study_spaces WHERE owner_id = $1 AND id = $2 FOR UPDATE',
      [ownerId, spaceId],
    );
    const status = space.rows[0]?.status;
    if (!status) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const course = await tx.query<{ stage_id: string }>(
      `SELECT m.stage_id FROM stage_meta m JOIN document_stages d ON d.id = m.stage_id
        WHERE m.stage_id = $2 AND m.owner_id = $1 AND m.deleted_at IS NULL`,
      [ownerId, stageId],
    );
    if (course.rows.length === 0) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    const existing = await tx.query<{ stage_id: string }>(
      `SELECT stage_id FROM study_space_courses
        WHERE owner_id = $1 AND space_id = $2 AND stage_id = $3`,
      [ownerId, spaceId, stageId],
    );
    if (existing.rows.length > 0) return { created: false };
    if (status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
    const count = await tx.query<{ n: number | string }>(
      'SELECT count(*) AS n FROM study_space_courses WHERE owner_id = $1 AND space_id = $2',
      [ownerId, spaceId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= STUDY_SPACE_LIMITS.coursesPerSpace) {
      throw new StudyError('STUDY_SPACE_COURSE_LIMIT', {
        maximum: STUDY_SPACE_LIMITS.coursesPerSpace,
      });
    }
    const inserted = await tx.query<{ stage_id: string }>(
      `INSERT INTO study_space_courses (owner_id, space_id, stage_id, added_via)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, space_id, stage_id) DO NOTHING
       RETURNING stage_id`,
      [ownerId, spaceId, stageId, via],
    );
    await tx.query(
      'UPDATE study_spaces SET updated_at = clock_timestamp() WHERE owner_id = $1 AND id = $2',
      [ownerId, spaceId],
    );
    return { created: inserted.rows.length === 1 };
  });
}

/** Remove a course from a space. The course and its progress stay. */
export async function unlinkStudySpaceCourse(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  stageId: string,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const space = await tx.query<{ id: string }>(
      'SELECT id FROM study_spaces WHERE owner_id = $1 AND id = $2',
      [ownerId, spaceId],
    );
    if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const removed = await tx.query<{ stage_id: string }>(
      `DELETE FROM study_space_courses WHERE owner_id = $1 AND space_id = $2 AND stage_id = $3
       RETURNING stage_id`,
      [ownerId, spaceId, stageId],
    );
    if (removed.rows.length === 0) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    await tx.query(
      'UPDATE study_spaces SET updated_at = clock_timestamp() WHERE owner_id = $1 AND id = $2',
      [ownerId, spaceId],
    );
  });
}

/** The owner's live courses (newest first) with the spaces each already sits in. */
export async function listLinkableCourses(db: StudyDb, ownerId: string): Promise<LinkableCourse[]> {
  return db.withTransaction(async (tx) => {
    const courses = await liveCourses(tx, ownerId);
    const links = await tx.query<LinkRow>(
      'SELECT space_id, stage_id, added_at, added_via FROM study_space_courses WHERE owner_id = $1',
      [ownerId],
    );
    return [...courses.values()].map((course) => ({
      stageId: course.stage_id,
      name: course.name,
      sceneCount: Number(course.scene_count),
      generation: generationState(course),
      updatedAt: iso(Number(course.updated_at)),
      spaceIds: links.rows
        .filter((link) => link.stage_id === course.stage_id)
        .map((link) => link.space_id),
    }));
  });
}

// ── progress ───────────────────────────────────────────────────────────────

export async function getCourseProgress(
  db: StudyDb,
  ownerId: string,
  stageId: string,
): Promise<StudyCourseProgressView | null> {
  return db.withTransaction(async (tx) => {
    const courses = await liveCourses(tx, ownerId, [stageId]);
    if (!courses.has(stageId)) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    return (await progressFor(tx, ownerId, courses)).get(stageId) ?? null;
  });
}

interface WriteSceneRow extends Record<string, unknown> {
  id: string;
  action_count: number | string;
  rev: number | string;
}

/**
 * Record the learner's position. The server resolves the scene's place,
 * action count, action id and revision from the stored course; the client
 * supplies only where it is and when it was there.
 *
 * Optimistic concurrency: a write must name the revision it was based on.
 * A mismatch (another tab or device wrote first) answers
 * STUDY_REVISION_CONFLICT with the current progress; the client decides
 * whether its position is newer and retries on the current revision.
 */
export async function writeCourseProgress(
  db: StudyDb,
  ownerId: string,
  stageId: string,
  input: ProgressWriteInput,
): Promise<StudyCourseProgressView> {
  const outcome = await db.withTransaction(async (tx) => {
    const courses = await liveCourses(tx, ownerId, [stageId]);
    const course = courses.get(stageId);
    if (!course) throw new StudyError('STUDY_COURSE_NOT_FOUND');
    const scenes = await tx.query<WriteSceneRow>(
      `SELECT s.id,
              CASE WHEN jsonb_typeof(s.data->'actions') = 'array'
                   THEN jsonb_array_length(s.data->'actions') ELSE 0 END AS action_count,
              COALESCE(r.rev, 0) AS rev
         FROM document_scenes s
         LEFT JOIN document_scene_revision r ON r.stage_id = s.stage_id AND r.scene_id = s.id
        WHERE s.stage_id = $1
        ORDER BY s.scene_order, s.id`,
      [stageId],
    );
    const sceneIndex = scenes.rows.findIndex((scene) => scene.id === input.sceneId);
    if (sceneIndex < 0) throw new StudyError('STUDY_SCENE_NOT_FOUND');
    const scene = scenes.rows[sceneIndex]!;
    const actionCount = Number(scene.action_count);

    const existing = await tx.query<ProgressRow>(
      `SELECT ${PROGRESS_COLUMNS} FROM study_progress
        WHERE owner_id = $1 AND stage_id = $2 FOR UPDATE`,
      [ownerId, stageId],
    );
    const current = existing.rows[0];
    if (current && input.baseRevision !== Number(current.revision)) {
      return { conflict: true as const };
    }

    const actionIndex =
      input.actionIndex ??
      (current && current.scene_id === input.sceneId ? Number(current.action_index) : 0);
    if (actionIndex > actionCount) {
      // A null index keeps a stored index that the scene may since have outgrown.
      if (input.actionIndex !== null) throw new StudyError('STUDY_ACTION_OUT_OF_RANGE');
    }
    const boundedIndex = Math.min(actionIndex, actionCount);
    const actionId =
      boundedIndex < actionCount
        ? ((
            await tx.query<{ action_id: string | null }>(
              `SELECT s.data->'actions'->($3::int)->>'id' AS action_id
                 FROM document_scenes s WHERE s.stage_id = $1 AND s.id = $2`,
              [stageId, input.sceneId, boundedIndex],
            )
          ).rows[0]?.action_id ?? null)
        : null;
    const isLast = sceneIndex === scenes.rows.length - 1;
    const reachedEnd = isLast && boundedIndex >= actionCount;
    const values = [
      ownerId,
      stageId,
      input.sceneId,
      sceneIndex,
      scenes.rows.length,
      boundedIndex,
      actionCount,
      actionId && actionId.length <= 200 ? actionId : null,
      String(scene.rev),
      reachedEnd,
      input.observedAt,
    ];
    if (!current) {
      await tx.query(
        `INSERT INTO study_progress
           (owner_id, stage_id, scene_id, scene_index, scene_count, action_index, action_count,
            action_id, scene_revision, furthest_scene_index, reached_end_at, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $4,
                 CASE WHEN $10::boolean THEN clock_timestamp() END, $11::timestamptz)`,
        values,
      );
    } else {
      await tx.query(
        `UPDATE study_progress
            SET scene_id = $3, scene_index = $4, scene_count = $5, action_index = $6,
                action_count = $7, action_id = $8, scene_revision = $9::bigint,
                furthest_scene_index = GREATEST(furthest_scene_index, $4),
                reached_end_at = COALESCE(reached_end_at,
                  CASE WHEN $10::boolean THEN clock_timestamp() END),
                observed_at = $11::timestamptz,
                revision = revision + 1,
                updated_at = clock_timestamp()
          WHERE owner_id = $1 AND stage_id = $2`,
        values,
      );
    }
    const view = (await progressFor(tx, ownerId, courses)).get(stageId);
    return { conflict: false as const, view: view! };
  });
  if (outcome.conflict) {
    throw new StudyError('STUDY_REVISION_CONFLICT', {
      current: await getCourseProgress(db, ownerId, stageId),
    });
  }
  return outcome.view;
}
