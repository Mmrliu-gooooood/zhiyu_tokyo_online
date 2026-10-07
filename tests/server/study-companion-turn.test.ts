/**
 * Per-turn resolution of an after-class chat (learning plan B05) on PGlite:
 * the material scope is (space materials ∩ classmate's authorised
 * materials ∩ live), so a classmate authorised for textbook A never reaches
 * textbook B, the same classmate in two subjects never mixes materials, a
 * revoked or deleted material drops out of the next turn, and an archived
 * classmate or space stops the chat.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema, type Queryable } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { resolveCompanionTurn } from '@/lib/server/study/companion/turn';
import { StudyError } from '@/lib/server/study/spaces/repository';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CM = 'cm-0123456789abcdef';

let pg: PGlite;
const db = (): Queryable => ({
  query: async (text: string, params?: unknown[]) =>
    ({ rows: (await pg.query(text, params ?? [])).rows }) as never,
});

beforeEach(async () => {
  pg = new PGlite();
  await ensureDocumentSchema(pg as never);
  await ensureStageMetaSchema(pg as never);
  await ensureStudySchema(pg as never);
  await pg.query(
    `INSERT INTO study_spaces (id, owner_id, name) VALUES
       ('math', $1, '高数'), ('physics', $1, '物理'), ('foreign', $2, '别人')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `INSERT INTO study_materials (id, owner_id, title) VALUES
       ('book-a', $1, '教材A'), ('book-b', $1, '教材B'), ('book-c', $1, '教材C'), ('book-x', $2, '别人的书')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `INSERT INTO study_space_materials (owner_id, space_id, material_id) VALUES
       ($1, 'math', 'book-a'), ($1, 'math', 'book-b'), ($1, 'physics', 'book-c'), ($2, 'foreign', 'book-x')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar, color)
     VALUES ($1, $2, '小林', 'student', 'peer', 'active', '/avatars/curious.png', '#10b981')`,
    [CM, OWNER],
  );
  // Authorised for textbook A (math) and C (physics), never B.
  await pg.query(
    `INSERT INTO study_classmate_materials (owner_id, classmate_id, material_id) VALUES
       ($1, $2, 'book-a'), ($1, $2, 'book-c')`,
    [OWNER, CM],
  );
});

afterEach(async () => {
  await pg.close();
});

describe('after-class turn resolution', () => {
  it('limits a classmate to its authorised materials inside the chat’s subject', async () => {
    const math = await resolveCompanionTurn(db(), OWNER, { spaceId: 'math', classmateId: CM });
    expect(math.materials).toEqual([{ id: 'book-a', title: '教材A' }]);
    expect([...math.allowedMaterialIds]).toEqual(['book-a']);
    // Retrieval is off here (no B03 switch / storage): the scope is empty and says so.
    expect(math.retrieval).toBe('unavailable');
    expect(math.scope).toEqual([]);

    const physics = await resolveCompanionTurn(db(), OWNER, {
      spaceId: 'physics',
      classmateId: CM,
    });
    expect(physics.materials).toEqual([{ id: 'book-c', title: '教材C' }]);
  });

  it('drops a revoked or deleted material from the next turn', async () => {
    await pg.query(
      `DELETE FROM study_classmate_materials WHERE owner_id = $1 AND classmate_id = $2 AND material_id = 'book-a'`,
      [OWNER, CM],
    );
    expect(
      (await resolveCompanionTurn(db(), OWNER, { spaceId: 'math', classmateId: CM })).materials,
    ).toEqual([]);
    await pg.query(`UPDATE study_materials SET status = 'deleting' WHERE id = 'book-c'`);
    expect(
      (await resolveCompanionTurn(db(), OWNER, { spaceId: 'physics', classmateId: CM })).materials,
    ).toEqual([]);
  });

  it('follows the current template revision and stops archived classmates and spaces', async () => {
    await pg.query(`UPDATE study_classmates SET name = '小林同学', revision = 3 WHERE id = $1`, [
      CM,
    ]);
    const turn = await resolveCompanionTurn(db(), OWNER, { spaceId: 'math', classmateId: CM });
    expect(turn.snapshot.name).toBe('小林同学');
    expect(turn.classmate.revision).toBe(3);

    await pg.query(
      `UPDATE study_spaces SET status = 'archived', archived_at = clock_timestamp() WHERE id = 'math'`,
    );
    await expect(
      resolveCompanionTurn(db(), OWNER, { spaceId: 'math', classmateId: CM }),
    ).rejects.toMatchObject({ code: 'STUDY_SPACE_ARCHIVED' });
    await pg.query(
      `UPDATE study_classmates SET status = 'archived', archived_at = clock_timestamp() WHERE id = $1`,
      [CM],
    );
    await expect(
      resolveCompanionTurn(db(), OWNER, { spaceId: 'physics', classmateId: CM }),
    ).rejects.toBeInstanceOf(StudyError);
  });

  it('never resolves another owner’s classmate or space', async () => {
    await expect(
      resolveCompanionTurn(db(), OTHER, { spaceId: 'foreign', classmateId: CM }),
    ).rejects.toMatchObject({ code: 'STUDY_CLASSMATE_NOT_FOUND' });
    await expect(
      resolveCompanionTurn(db(), OWNER, { spaceId: 'foreign', classmateId: CM }),
    ).rejects.toMatchObject({ code: 'STUDY_SPACE_NOT_FOUND' });
  });
});
