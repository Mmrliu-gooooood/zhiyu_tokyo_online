/**
 * Classmate templates repository (learning plan B04) on PGlite with the real
 * document, stage_meta and study schemas: owner isolation by explicit owner
 * filters, a stored snapshot for every revision, stale-revision conflicts,
 * archived templates, owner-checked materials and avatars, and one-time
 * import of device roles.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { ensureStudySchema } from '@/lib/server/study/schema';
import {
  createClassmate,
  getClassmate,
  importClassmates,
  listActiveClassmateSnapshots,
  listClassmates,
  readClassmateAvatar,
  readClassmateRevisions,
  saveClassmateAvatar,
  sniffAvatarType,
  updateClassmate,
} from '@/lib/server/study/classmates/repository';
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import { CLASSMATE_LIMITS, type ClassmateInput } from '@/lib/study/classmates/contracts';

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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const input = (overrides: Partial<ClassmateInput> = {}): ClassmateInput => ({
  name: '小林',
  role: 'student',
  persona: '耐心，喜欢举例。',
  learningStyle: 'peer',
  speechPolicy: 'active',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: null,
  materialIds: [],
  ...overrides,
});

describe('study classmates repository (PGlite)', () => {
  let pg: PGlite;
  let dbA: StudyDb;
  let dbB: StudyDb;

  beforeEach(async () => {
    pg = new PGlite();
    await ensureDocumentSchema(pg as never);
    await ensureStageMetaSchema(pg as never);
    await ensureStudySchema(pg as never);
    const pool = new PGlitePool(pg);
    dbA = createOwnerBoundQueryable(pool as never, OWNER_A) as StudyDb;
    dbB = createOwnerBoundQueryable(pool as never, OWNER_B) as StudyDb;
  });

  afterEach(async () => {
    await pg.close();
  });

  it('creates a template with revision 1 and its snapshot; other owners see nothing', async () => {
    const created = await createClassmate(dbA, OWNER_A, input());
    expect(created).toMatchObject({ name: '小林', revision: 1, status: 'active', materialIds: [] });
    expect(created.id).toMatch(/^cm-[0-9a-f]{16}$/);
    expect(await listClassmates(dbB, OWNER_B)).toEqual([]);
    await expect(getClassmate(dbB, OWNER_B, created.id)).rejects.toMatchObject({
      code: 'STUDY_CLASSMATE_NOT_FOUND',
    });
    const revisions = await readClassmateRevisions(dbA, OWNER_A, [
      { classmateId: created.id, revision: 1 },
    ]);
    expect(revisions.get(`${created.id}-r1`)).toMatchObject({
      name: '小林',
      speechPolicy: 'active',
    });
    expect(
      (await readClassmateRevisions(dbB, OWNER_B, [{ classmateId: created.id, revision: 1 }])).size,
    ).toBe(0);
  });

  it('keeps every revision readable after edits and rejects a stale revision', async () => {
    const created = await createClassmate(dbA, OWNER_A, input());
    const edited = await updateClassmate(
      dbA,
      OWNER_A,
      created.id,
      { name: '小林同学', speechPolicy: 'on_demand' },
      1,
    );
    expect(edited).toMatchObject({ name: '小林同学', revision: 2, speechPolicy: 'on_demand' });
    const revisions = await readClassmateRevisions(dbA, OWNER_A, [
      { classmateId: created.id, revision: 1 },
      { classmateId: created.id, revision: 2 },
      { classmateId: created.id, revision: 9 },
    ]);
    expect(revisions.get(`${created.id}-r1`)?.name).toBe('小林');
    expect(revisions.get(`${created.id}-r2`)).toMatchObject({
      name: '小林同学',
      speechPolicy: 'on_demand',
    });
    expect(revisions.has(`${created.id}-r9`)).toBe(false);
    await expect(
      updateClassmate(dbA, OWNER_A, created.id, { name: 'stale' }, 1),
    ).rejects.toMatchObject({
      code: 'STUDY_REVISION_CONFLICT',
      details: { current: { revision: 2, name: '小林同学' } },
    });
  });

  it('archives without losing snapshots, refuses edits while archived, and restores', async () => {
    const created = await createClassmate(dbA, OWNER_A, input());
    const archived = await updateClassmate(dbA, OWNER_A, created.id, { status: 'archived' }, 1);
    expect(archived.status).toBe('archived');
    expect(await listActiveClassmateSnapshots(dbA, OWNER_A)).toEqual([]);
    await expect(
      updateClassmate(dbA, OWNER_A, created.id, { name: 'x' }, archived.revision),
    ).rejects.toMatchObject({ code: 'STUDY_CLASSMATE_ARCHIVED' });
    expect(
      (await readClassmateRevisions(dbA, OWNER_A, [{ classmateId: created.id, revision: 1 }])).size,
    ).toBe(1);
    const restored = await updateClassmate(
      dbA,
      OWNER_A,
      created.id,
      { status: 'active', name: '回来了' },
      archived.revision,
    );
    expect(restored).toMatchObject({ status: 'active', name: '回来了' });
    expect((await listActiveClassmateSnapshots(dbA, OWNER_A))[0]).toMatchObject({
      id: created.id,
      revision: restored.revision,
      snapshot: { name: '回来了' },
    });
  });

  it('links only the owner’s live materials and drops links when a material goes', async () => {
    const insertMaterial = (owner: string, id: string, status = 'active') =>
      pg.query(
        `INSERT INTO study_materials (id, owner_id, title, status) VALUES ($1, $2, $3, $4)`,
        [id, owner, id, status],
      );
    await insertMaterial(OWNER_A, 'mat-a');
    await insertMaterial(OWNER_A, 'mat-going', 'deleting');
    await insertMaterial(OWNER_B, 'mat-b');
    await expect(
      createClassmate(dbA, OWNER_A, input({ materialIds: ['mat-b'] })),
    ).rejects.toMatchObject({ code: 'STUDY_CLASSMATE_MATERIAL_UNAVAILABLE' });
    await expect(
      createClassmate(dbA, OWNER_A, input({ materialIds: ['mat-going'] })),
    ).rejects.toMatchObject({ code: 'STUDY_CLASSMATE_MATERIAL_UNAVAILABLE' });
    expect(await listClassmates(dbA, OWNER_A)).toEqual([]);

    const created = await createClassmate(dbA, OWNER_A, input({ materialIds: ['mat-a'] }));
    expect(created.materialIds).toEqual(['mat-a']);
    const cleared = await updateClassmate(dbA, OWNER_A, created.id, { materialIds: [] }, 1);
    expect(cleared.materialIds).toEqual([]);
    await updateClassmate(dbA, OWNER_A, created.id, { materialIds: ['mat-a'] }, 2);
    await pg.query(`DELETE FROM study_materials WHERE id = 'mat-a'`);
    expect((await getClassmate(dbA, OWNER_A, created.id)).materialIds).toEqual([]);
  });

  it('enforces the per-owner template limit', async () => {
    for (let index = 0; index < CLASSMATE_LIMITS.classmatesPerOwner; index += 1) {
      await createClassmate(dbA, OWNER_A, input({ name: `同学${index}` }));
    }
    await expect(createClassmate(dbA, OWNER_A, input())).rejects.toMatchObject({
      code: 'STUDY_CLASSMATE_LIMIT',
    });
    expect((await createClassmate(dbB, OWNER_B, input())).revision).toBe(1);
  });

  it('imports device roles once per account', async () => {
    const roles = [input({ name: 'A' }), input({ name: 'B', role: 'assistant' })];
    const first = await importClassmates(dbA, OWNER_A, roles);
    expect(first.created.map((item) => item.name)).toEqual(['A', 'B']);
    expect(first.skipped).toBe(0);
    const again = await importClassmates(dbA, OWNER_A, [...roles, input({ name: 'C' })]);
    expect(again.created.map((item) => item.name)).toEqual(['C']);
    expect(again.skipped).toBe(2);
    expect((await importClassmates(dbB, OWNER_B, roles)).created).toHaveLength(2);
  });

  it('stores avatars by content, checks the bytes, and serves them to their owner only', async () => {
    expect(sniffAvatarType(PNG)).toBe('image/png');
    expect(sniffAvatarType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
    await expect(saveClassmateAvatar(dbA, OWNER_A, PNG, 'image/jpeg')).rejects.toMatchObject({
      code: 'STUDY_AVATAR_INVALID',
    });
    const oversized = new Uint8Array(CLASSMATE_LIMITS.avatarBytes + 1);
    oversized.set(PNG);
    await expect(saveClassmateAvatar(dbA, OWNER_A, oversized, 'image/png')).rejects.toMatchObject({
      code: 'STUDY_AVATAR_INVALID',
    });

    const saved = await saveClassmateAvatar(dbA, OWNER_A, PNG, 'image/png');
    expect(saved.avatar).toBe(`/api/study/classmates/avatars/${saved.id}`);
    expect((await saveClassmateAvatar(dbA, OWNER_A, PNG, 'image/png')).id).toBe(saved.id);
    const read = await readClassmateAvatar(dbA, OWNER_A, saved.id);
    expect(read.contentType).toBe('image/png');
    expect([...read.bytes]).toEqual([...PNG]);
    await expect(readClassmateAvatar(dbB, OWNER_B, saved.id)).rejects.toMatchObject({
      code: 'STUDY_AVATAR_NOT_FOUND',
    });

    // A template may use only its owner's uploads.
    expect((await createClassmate(dbA, OWNER_A, input({ avatar: saved.avatar }))).avatar).toBe(
      saved.avatar,
    );
    await expect(
      createClassmate(dbB, OWNER_B, input({ avatar: saved.avatar })),
    ).rejects.toMatchObject({ code: 'STUDY_AVATAR_NOT_FOUND' });
  });
});
