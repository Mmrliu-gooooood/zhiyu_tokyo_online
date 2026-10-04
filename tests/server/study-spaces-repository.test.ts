/**
 * Study spaces repository (learning plan B01) on PGlite with the real
 * document, stage_meta and study schemas: owner isolation by explicit owner
 * filters, idempotent course links, space revisions, and server-validated
 * course progress with optimistic concurrency.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import {
  StudyError,
  createStudySpace,
  deleteStudySpace,
  getCourseProgress,
  getStudySpace,
  linkStudySpaceCourse,
  listLinkableCourses,
  listStudySpaces,
  unlinkStudySpaceCourse,
  updateStudySpace,
  writeCourseProgress,
  type StudyDb,
} from '@/lib/server/study/spaces/repository';
import type { StudySpaceInput } from '@/lib/study/spaces/contracts';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }
}

const space = (overrides: Partial<StudySpaceInput> = {}): StudySpaceInput => ({
  name: '高等数学',
  educationLevel: 'university',
  subject: '数学',
  goal: null,
  examDate: '2027-01-08',
  examScope: null,
  timezone: 'Asia/Shanghai',
  ...overrides,
});

async function insertCourse(
  db: PGlite,
  owner: string,
  stageId: string,
  scenes: Array<{ id: string; actions: number }>,
  options: { outlines?: number; complete?: boolean } = {},
) {
  const now = Date.now();
  await db.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
     VALUES ($1, $2, $3, $3, $4, '{}'::jsonb)`,
    [stageId, `课程 ${stageId}`, now, owner],
  );
  await db.query('INSERT INTO stage_meta (stage_id, owner_id) VALUES ($1, $2)', [stageId, owner]);
  for (const [order, scene] of scenes.entries()) {
    await db.query(
      `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4::jsonb)`,
      [
        stageId,
        scene.id,
        order,
        JSON.stringify({
          id: scene.id,
          actions: Array.from({ length: scene.actions }, (_, i) => ({ id: `${scene.id}-a${i}` })),
        }),
      ],
    );
  }
  if (options.outlines !== undefined) {
    await db.query(`INSERT INTO document_outlines (stage_id, data) VALUES ($1, $2::jsonb)`, [
      stageId,
      JSON.stringify({
        outlines: Array.from({ length: options.outlines }, (_, i) => ({ order: i + 1 })),
        generationComplete: options.complete ?? false,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  }
}

const observed = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof StudyError) return error.code;
    throw error;
  }
}

describe('study spaces repository', () => {
  let raw: PGlite;
  let a: StudyDb;
  let b: StudyDb;

  beforeEach(async () => {
    raw = new PGlite();
    await raw.waitReady;
    await ensureDocumentSchema(raw);
    await ensureStageMetaSchema(raw);
    await ensureStudySchema(raw);
    // Applying twice is harmless (legacy installs ensure on every start).
    await ensureStudySchema(raw);
    const pool = new PGlitePool(raw) as never;
    a = createOwnerBoundQueryable(pool, OWNER_A) as StudyDb;
    b = createOwnerBoundQueryable(pool, OWNER_B) as StudyDb;
    await insertCourse(raw, OWNER_A, 'stage-a1', [
      { id: 's1', actions: 3 },
      { id: 's2', actions: 2 },
    ]);
    await insertCourse(raw, OWNER_A, 'stage-a2', [{ id: 's1', actions: 1 }], {
      outlines: 3,
      complete: false,
    });
    await insertCourse(raw, OWNER_B, 'stage-b1', [{ id: 's1', actions: 1 }]);
  });

  afterEach(async () => {
    await raw.close();
  });

  it('creates, lists and isolates spaces per owner', async () => {
    const math = await createStudySpace(a, OWNER_A, space());
    await createStudySpace(a, OWNER_A, space({ name: '数据结构', examDate: null }));
    expect(math).toMatchObject({
      name: '高等数学',
      educationLevel: 'university',
      examDate: '2027-01-08',
      status: 'active',
      revision: 1,
      courseCount: 0,
      lastStudied: null,
    });
    expect((await listStudySpaces(a, OWNER_A)).map((item) => item.name).sort()).toEqual([
      '数据结构',
      '高等数学',
    ]);
    expect(await listStudySpaces(b, OWNER_B)).toEqual([]);
    // Another owner can neither read, edit, link into nor delete the space.
    expect(await code(getStudySpace(b, OWNER_B, math.id))).toBe('STUDY_SPACE_NOT_FOUND');
    expect(await code(updateStudySpace(b, OWNER_B, math.id, { name: 'x' }, 1))).toBe(
      'STUDY_SPACE_NOT_FOUND',
    );
    expect(await code(linkStudySpaceCourse(b, OWNER_B, math.id, 'stage-b1', 'link'))).toBe(
      'STUDY_SPACE_NOT_FOUND',
    );
    expect(await code(deleteStudySpace(b, OWNER_B, math.id))).toBe('STUDY_SPACE_NOT_FOUND');
    expect((await getStudySpace(a, OWNER_A, math.id)).name).toBe('高等数学');
  });

  it('links only the owner’s live courses, idempotently, and keeps courses on unlink and delete', async () => {
    const math = await createStudySpace(a, OWNER_A, space());
    const other = await createStudySpace(a, OWNER_A, space({ name: '复习' }));
    expect(await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a1', 'link')).toEqual({
      created: true,
    });
    // A retried link (or a regenerated job) does not duplicate.
    expect(await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a1', 'generation')).toEqual({
      created: false,
    });
    await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a2', 'generation');
    // The same course may sit in two of the owner's spaces.
    await linkStudySpaceCourse(a, OWNER_A, other.id, 'stage-a1', 'link');

    // Foreign and missing courses are refused alike.
    expect(await code(linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-b1', 'link'))).toBe(
      'STUDY_COURSE_NOT_FOUND',
    );
    expect(await code(linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-x', 'link'))).toBe(
      'STUDY_COURSE_NOT_FOUND',
    );

    const detail = await getStudySpace(a, OWNER_A, math.id);
    expect(detail.courseCount).toBe(2);
    expect(detail.courses.map((course) => [course.stageId, course.generation])).toEqual(
      expect.arrayContaining([
        ['stage-a1', 'complete'],
        ['stage-a2', 'incomplete'],
      ]),
    );
    const linkable = await listLinkableCourses(a, OWNER_A);
    expect(linkable.map((course) => course.stageId).sort()).toEqual(['stage-a1', 'stage-a2']);
    expect(linkable.find((course) => course.stageId === 'stage-a1')?.spaceIds.sort()).toEqual(
      [math.id, other.id].sort(),
    );
    expect(await listLinkableCourses(b, OWNER_B)).toEqual([
      expect.objectContaining({ stageId: 'stage-b1', spaceIds: [] }),
    ]);

    await unlinkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a2');
    expect(await code(unlinkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a2'))).toBe(
      'STUDY_COURSE_NOT_FOUND',
    );
    await deleteStudySpace(a, OWNER_A, math.id);
    expect(await code(getStudySpace(a, OWNER_A, math.id))).toBe('STUDY_SPACE_NOT_FOUND');
    // Deleting a space removes its links only.
    expect((await raw.query('SELECT id FROM document_stages ORDER BY id')).rows).toHaveLength(3);
    expect((await getStudySpace(a, OWNER_A, other.id)).courseCount).toBe(1);
  });

  it('hides tombstoned courses and refuses new links to archived spaces', async () => {
    const math = await createStudySpace(a, OWNER_A, space());
    await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a1', 'link');
    await raw.query("UPDATE stage_meta SET deleted_at = now() WHERE stage_id = 'stage-a1'");
    expect((await getStudySpace(a, OWNER_A, math.id)).courses).toEqual([]);
    expect(await code(linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a1', 'link'))).toBe(
      'STUDY_COURSE_NOT_FOUND',
    );

    const archived = await updateStudySpace(a, OWNER_A, math.id, { status: 'archived' }, 1);
    expect(archived).toMatchObject({ status: 'archived', revision: 2 });
    expect(await code(linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a2', 'link'))).toBe(
      'STUDY_SPACE_ARCHIVED',
    );
    const restored = await updateStudySpace(a, OWNER_A, math.id, { status: 'active' }, 2);
    expect(restored.status).toBe('active');
    expect(
      (await raw.query<{ archived_at: unknown }>('SELECT archived_at FROM study_spaces')).rows[0]
        ?.archived_at,
    ).toBeNull();
  });

  it('rejects a stale space edit with the current space instead of overwriting it', async () => {
    const math = await createStudySpace(a, OWNER_A, space());
    const first = await updateStudySpace(
      a,
      OWNER_A,
      math.id,
      { goal: '期末 85 分', examScope: '第 1–6 章' },
      1,
    );
    expect(first).toMatchObject({ goal: '期末 85 分', examScope: '第 1–6 章', revision: 2 });
    try {
      await updateStudySpace(a, OWNER_A, math.id, { goal: '旧标签页的目标' }, 1);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError);
      expect((error as StudyError).code).toBe('STUDY_REVISION_CONFLICT');
      expect((error as StudyError).details?.current).toMatchObject({
        goal: '期末 85 分',
        revision: 2,
      });
    }
    // Clearing optional fields is explicit.
    const cleared = await updateStudySpace(a, OWNER_A, math.id, { examDate: null }, 2);
    expect(cleared.examDate).toBeNull();
  });

  it('records progress server-side and refuses stale or foreign writes', async () => {
    expect(await getCourseProgress(a, OWNER_A, 'stage-a1')).toBeNull();
    const first = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's1',
      actionIndex: 2,
      baseRevision: null,
      observedAt: observed(),
    });
    expect(first).toMatchObject({
      sceneId: 's1',
      sceneIndex: 0,
      sceneCount: 2,
      actionIndex: 2,
      actionId: 's1-a2',
      reachedEnd: false,
      sceneChanged: false,
      revision: 1,
    });

    // Device B moves on from revision 1.
    const second = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's2',
      actionIndex: 0,
      baseRevision: 1,
      observedAt: observed(1000),
    });
    expect(second).toMatchObject({ sceneIndex: 1, revision: 2, furthestSceneIndex: 1 });
    expect(first).toMatchObject({ resumeSceneId: 's1', resumeActionIndex: 2 });

    // A stale tab still on revision 1 cannot move the position back.
    try {
      await writeCourseProgress(a, OWNER_A, 'stage-a1', {
        sceneId: 's1',
        actionIndex: 0,
        baseRevision: 1,
        observedAt: observed(500),
      });
      throw new Error('expected a conflict');
    } catch (error) {
      expect((error as StudyError).code).toBe('STUDY_REVISION_CONFLICT');
      expect((error as StudyError).details?.current).toMatchObject({ sceneId: 's2', revision: 2 });
    }
    // A first write from a device that never saw any revision also conflicts.
    expect(
      await code(
        writeCourseProgress(a, OWNER_A, 'stage-a1', {
          sceneId: 's1',
          actionIndex: 0,
          baseRevision: null,
          observedAt: observed(),
        }),
      ),
    ).toBe('STUDY_REVISION_CONFLICT');

    // Scene navigation without an action index keeps the stored index for the same scene.
    const sameScene = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's2',
      actionIndex: null,
      baseRevision: 2,
      observedAt: observed(2000),
    });
    expect(sameScene).toMatchObject({ actionIndex: 0, revision: 3 });

    // Finishing the last scene is a sticky viewing fact; going back keeps it.
    const end = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's2',
      actionIndex: 2,
      baseRevision: 3,
      observedAt: observed(3000),
    });
    // The last scene finished: there is no next scene, so it replays from its start.
    expect(end).toMatchObject({
      reachedEnd: true,
      actionId: null,
      resumeSceneId: 's2',
      resumeActionIndex: 0,
    });
    const back = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's1',
      actionIndex: null,
      baseRevision: 4,
      observedAt: observed(4000),
    });
    expect(back).toMatchObject({
      sceneIndex: 0,
      actionIndex: 0,
      reachedEnd: true,
      furthestSceneIndex: 1,
    });

    // Validation against the stored course.
    expect(
      await code(
        writeCourseProgress(a, OWNER_A, 'stage-a1', {
          sceneId: 'nope',
          actionIndex: 0,
          baseRevision: 5,
          observedAt: observed(),
        }),
      ),
    ).toBe('STUDY_SCENE_NOT_FOUND');
    expect(
      await code(
        writeCourseProgress(a, OWNER_A, 'stage-a1', {
          sceneId: 's1',
          actionIndex: 4,
          baseRevision: 5,
          observedAt: observed(),
        }),
      ),
    ).toBe('STUDY_ACTION_OUT_OF_RANGE');

    // Another owner cannot read or write progress on A's course, and has none of its own.
    expect(await code(getCourseProgress(b, OWNER_B, 'stage-a1'))).toBe('STUDY_COURSE_NOT_FOUND');
    expect(
      await code(
        writeCourseProgress(b, OWNER_B, 'stage-a1', {
          sceneId: 's1',
          actionIndex: 0,
          baseRevision: null,
          observedAt: observed(),
        }),
      ),
    ).toBe('STUDY_COURSE_NOT_FOUND');
  });

  it('flags a position whose scene was edited or deleted after it was recorded', async () => {
    await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's2',
      actionIndex: 1,
      baseRevision: null,
      observedAt: observed(),
    });
    expect(await getCourseProgress(a, OWNER_A, 'stage-a1')).toMatchObject({
      sceneChanged: false,
      sceneMissing: false,
    });
    // Editing the scene bumps its revision (document trigger).
    await raw.query(
      `UPDATE document_scenes SET data = jsonb_set(data, '{actions}', '[{"id":"new"}]')
        WHERE stage_id = 'stage-a1' AND id = 's2'`,
    );
    expect(await getCourseProgress(a, OWNER_A, 'stage-a1')).toMatchObject({
      sceneChanged: true,
      sceneMissing: false,
      sceneIndex: 1,
      // An edited scene resumes from its start, not from a stale action index.
      resumeSceneId: 's2',
      resumeActionIndex: 0,
    });
    await raw.query("DELETE FROM document_scenes WHERE stage_id = 'stage-a1' AND id = 's2'");
    expect(await getCourseProgress(a, OWNER_A, 'stage-a1')).toMatchObject({
      sceneMissing: true,
      sceneIndex: null,
      sceneCount: 1,
      resumeSceneId: null,
    });
  });

  it('resumes a finished scene at the next one', async () => {
    const done = await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's1',
      actionIndex: 3,
      baseRevision: null,
      observedAt: observed(),
    });
    expect(done).toMatchObject({
      sceneId: 's1',
      reachedEnd: false,
      resumeSceneId: 's2',
      resumeActionIndex: 0,
    });
  });

  it('summarizes the most recently studied course per space', async () => {
    const math = await createStudySpace(a, OWNER_A, space());
    await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a1', 'link');
    await linkStudySpaceCourse(a, OWNER_A, math.id, 'stage-a2', 'link');
    await writeCourseProgress(a, OWNER_A, 'stage-a1', {
      sceneId: 's1',
      actionIndex: 0,
      baseRevision: null,
      observedAt: observed(),
    });
    await writeCourseProgress(a, OWNER_A, 'stage-a2', {
      sceneId: 's1',
      actionIndex: 0,
      baseRevision: null,
      observedAt: observed(),
    });
    const [summary] = await listStudySpaces(a, OWNER_A);
    expect(summary?.courseCount).toBe(2);
    expect(summary?.lastStudied?.stageId).toBe('stage-a2');
    expect(summary?.lastStudied?.courseName).toBe('课程 stage-a2');
  });
});
