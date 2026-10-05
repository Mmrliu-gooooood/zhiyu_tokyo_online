/**
 * Study material library (learning plan B02) on PGlite with the real unpdf
 * parser: one upload → one version → one parse artifact, reused across two
 * spaces and by repeated parse requests; page-addressed reading; replacing a
 * file keeps the old version's locations; scans fail readably; permanent
 * delete revokes reads before removing objects; owners are isolated.
 */
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import type { Queryable } from '@openmaic/storage/document/pg';

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import {
  ensureOwnerMaterialSchema,
  finalizeOwnerMaterial,
  registerOwnerMaterial,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { ensureStudySchema } from '@/lib/server/study/schema';
import { setMaterialByteStoreForTests } from '@/lib/server/materials/bytes';
import { createStudySpace, StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';
import {
  addStudyMaterialVersion,
  createStudyMaterialFromUpload,
  getStudyMaterial,
  linkStudySpaceMaterial,
  listStudyMaterials,
  readableStudySharedKey,
  recordStudySessionRef,
  unlinkStudySpaceMaterial,
} from '@/lib/server/study/materials/repository';
import {
  materialParserOptions,
  purgeStudyMaterial,
  readStudyMaterialPage,
  readStudyMaterialText,
  requestMaterialParse,
} from '@/lib/server/study/materials/service';
import { runMaterialParseTask } from '@/lib/server/study/materials/parse';
import { LearningTaskQueue, getLearningTask } from '@/lib/server/learning-tasks/repository';
import { getDocumentExtractorProvider } from '@/lib/document/extractors/registry';

const OWNER_A = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let db: PGlite;
let study: StudyDb;
let queue: LearningTaskQueue;
let bytes: Map<string, Buffer>;
let deleted: string[];

function q(): Queryable {
  return {
    query: async (sql, params) => ({ rows: (await db.query(sql, params ?? [])).rows as never[] }),
  };
}

async function textPdf(pages: string[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([400, 300]);
    page.drawText(text, { x: 40, y: 200, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

async function scannedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: '#888888' },
  })
    .png()
    .toBuffer();
  const image = await pdf.embedPng(png);
  pdf.addPage([400, 300]).drawImage(image, { x: 0, y: 0, width: 400, height: 300 });
  return Buffer.from(await pdf.save());
}

let uploadCounter = 0;
async function upload(owner: string, body: Buffer, name = 'notes.pdf', mime = 'application/pdf') {
  uploadCounter += 1;
  const id = `mat_upload${uploadCounter}`;
  const key = `materials/${owner}/${id}`;
  bytes.set(key, body);
  await registerOwnerMaterial(
    q(),
    {
      id,
      ownerId: owner,
      kind: 'source',
      mime,
      bytes: body.byteLength,
      originalName: name,
      ossKey: key,
    },
    { maxCount: 100, maxTotalBytes: 1e9 },
    (work) => db.transaction((tx) => work(tx as never)),
  );
  return finalizeOwnerMaterial(
    q(),
    id,
    body.byteLength,
    createHash('sha256').update(body).digest('hex'),
  ) as Promise<OwnerMaterialRecord>;
}

async function runNextParse(signal = new AbortController().signal) {
  const lease = await queue.claim('worker-1', ['material_parse']);
  if (!lease) throw new Error('expected a parse task');
  await runMaterialParseTask(lease, { queue, signal });
  return lease;
}

async function spaceFor(owner: string, name: string) {
  return createStudySpace(study, owner, {
    name,
    educationLevel: null,
    subject: null,
    goal: null,
    examDate: null,
    examScope: null,
    timezone: null,
  });
}

beforeEach(async () => {
  db = new PGlite();
  const pool = {
    query: (sql: string, args?: unknown[]) => db.query(sql, args),
    connect: async () => ({
      query: (sql: string, args?: unknown[]) => db.query(sql, args),
      release() {},
    }),
  };
  study = Object.assign(q(), {
    withTransaction: <T>(body: (tx: Queryable) => Promise<T>) =>
      db.transaction((tx) => body(tx as never)) as Promise<T>,
  });
  await ensureDocumentSchema(q());
  await ensureStageMetaSchema(q());
  await ensureOwnerMaterialSchema(q());
  await ensureAssetSchema(q());
  await ensureStudySchema(q());
  await migrateGenerationSchema(pool as never);
  // A live learning worker, so parse requests are accepted.
  queue = new LearningTaskQueue(pool as never, { leaseMs: 60_000, queueWaitMs: 3_600_000 });
  await queue.workerHeartbeat('host-1');
  bytes = new Map();
  deleted = [];
  setMaterialByteStoreForTests({
    put: async (key, body) => void bytes.set(key, Buffer.from(body as Uint8Array)),
    get: async (key) => {
      const value = bytes.get(key);
      if (!value) throw new Error(`missing ${key}`);
      return value;
    },
    delete: async (key) => {
      deleted.push(key);
      bytes.delete(key);
    },
  });
});

afterEach(async () => {
  setMaterialByteStoreForTests(null);
  vi.restoreAllMocks();
  await db.close();
});

describe('study material library', () => {
  it('parses once and reuses the same version and artifact in two spaces', async () => {
    const algebra = await spaceFor(OWNER_A, 'Algebra');
    const exam = await spaceFor(OWNER_A, 'Exam prep');
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Page one alpha', 'Page two beta'])),
      spaceId: algebra.id,
    });
    expect(created.material.title).toBe('notes');
    expect(created.material.current.parseState).toBe('not_started');
    expect(
      await linkStudySpaceMaterial(study, OWNER_A, exam.id, created.material.materialId),
    ).toEqual({
      created: true,
    });
    expect(
      await linkStudySpaceMaterial(study, OWNER_A, exam.id, created.material.materialId),
    ).toEqual({
      created: false,
    });

    const options = materialParserOptions('application/pdf');
    expect(options.find((option) => option.isDefault)?.providerId).toBe('unpdf');
    expect(options.filter((option) => option.paid).every((option) => !option.isDefault)).toBe(true);

    const { task } = await requestMaterialParse(
      study,
      OWNER_A,
      created.material.materialId,
      created.versionId,
    );
    expect(task).toMatchObject({ status: 'queued', providerId: 'unpdf' });
    await runNextParse();
    const parsed = await getLearningTask(q(), OWNER_A, task.taskId);
    expect(parsed).toMatchObject({ status: 'succeeded', result: { pageCount: 2, paged: true } });

    for (const space of [algebra, exam]) {
      const [listed] = await listStudyMaterials(study, OWNER_A, { spaceId: space.id });
      expect(listed.materialId).toBe(created.material.materialId);
      expect(listed.current.parseState).toBe('succeeded');
      expect(listed.current.artifact).toMatchObject({
        pageCount: 2,
        paged: true,
        extractorId: 'unpdf',
      });
      expect(listed.spaces.map((ref) => ref.name).sort()).toEqual(['Algebra', 'Exam prep']);
    }
    // One raw object plus one artifact's JSON and text; nothing copied per space.
    expect([...bytes.keys()].filter((key) => key.startsWith('materials/'))).toHaveLength(1);
    expect([...bytes.keys()].filter((key) => key.includes('/artifacts/'))).toHaveLength(2);

    const page2 = await readStudyMaterialPage(study, OWNER_A, {
      materialId: created.material.materialId,
      versionId: created.versionId,
      page: 2,
    });
    expect(page2).toMatchObject({ paged: true, pageCount: 2, page: 2 });
    expect(page2.blocks.map((block) => block.text).join(' ')).toContain('Page two beta');
    expect(page2.blocks.map((block) => block.text).join(' ')).not.toContain('alpha');
    const text = await readStudyMaterialText(study, OWNER_A, {
      materialId: created.material.materialId,
      versionId: created.versionId,
    });
    expect(text.text).toContain('Page one alpha');
    expect(text.text).toContain('Page two beta');

    // Asking again with the same parser reuses the artifact without parsing.
    const extract = vi.spyOn(getDocumentExtractorProvider('unpdf')!, 'extract');
    const again = await requestMaterialParse(
      study,
      OWNER_A,
      created.material.materialId,
      created.versionId,
      { providerId: 'unpdf' },
    );
    await runNextParse();
    expect(extract).not.toHaveBeenCalled();
    expect(await getLearningTask(q(), OWNER_A, again.task.taskId)).toMatchObject({
      status: 'succeeded',
      result: { reused: true },
    });
    const artifacts = await db.query('SELECT id FROM study_material_artifacts');
    expect(artifacts.rows).toHaveLength(1);

    // Removing it from one space keeps it in the other and in the library.
    await unlinkStudySpaceMaterial(study, OWNER_A, algebra.id, created.material.materialId);
    expect(await listStudyMaterials(study, OWNER_A, { spaceId: algebra.id })).toEqual([]);
    expect(await listStudyMaterials(study, OWNER_A, { spaceId: exam.id })).toHaveLength(1);
  });

  it('keeps an old version readable at the same location after the file is replaced', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Version one first', 'Version one second'])),
    });
    await requestMaterialParse(study, OWNER_A, created.material.materialId, created.versionId);
    await runNextParse();
    const before = await readStudyMaterialPage(study, OWNER_A, {
      materialId: created.material.materialId,
      versionId: created.versionId,
      page: 2,
    });

    const replaced = await addStudyMaterialVersion(
      study,
      OWNER_A,
      created.material.materialId,
      await upload(OWNER_A, await textPdf(['Version two only'])),
    );
    expect(replaced.material.versionCount).toBe(2);
    expect(replaced.material.current.versionId).toBe(replaced.versionId);
    await requestMaterialParse(study, OWNER_A, created.material.materialId, replaced.versionId);
    await runNextParse();

    const after = await readStudyMaterialPage(study, OWNER_A, {
      materialId: created.material.materialId,
      versionId: created.versionId,
      page: 2,
    });
    // Same blocks and page; only the "current version" flag moved to v2.
    expect(before.isCurrent).toBe(true);
    expect({ ...after, isCurrent: true }).toEqual(before);
    const detail = await getStudyMaterial(study, OWNER_A, created.material.materialId);
    expect(detail.versions.map((version) => [version.versionNo, version.parseState])).toEqual([
      [2, 'succeeded'],
      [1, 'succeeded'],
    ]);
  });

  it('reports a scan without a text layer as a readable failure', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await scannedPdf(), 'scan.pdf'),
    });
    const { task } = await requestMaterialParse(
      study,
      OWNER_A,
      created.material.materialId,
      created.versionId,
    );
    await runNextParse();
    const view = await getLearningTask(q(), OWNER_A, task.taskId);
    expect(view).toMatchObject({ status: 'failed', lastErrorCode: 'MATERIAL_NO_TEXT' });
    expect(view?.lastErrorSummary).toMatch(/scan/);
    const detail = await getStudyMaterial(study, OWNER_A, created.material.materialId);
    expect(detail.current).toMatchObject({ parseState: 'failed', artifact: null });
    await expect(
      readStudyMaterialPage(study, OWNER_A, {
        materialId: created.material.materialId,
        versionId: created.versionId,
      }),
    ).rejects.toMatchObject({ code: 'STUDY_MATERIAL_NOT_PARSED' });
    // Nothing was stored for the failed parse; the original file stays.
    expect([...bytes.keys()].filter((key) => key.includes('/artifacts/'))).toEqual([]);
  });

  it('isolates owners on every material path', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Private'])),
    });
    const spaceB = await spaceFor(OWNER_B, 'B space');
    const materialId = created.material.materialId;
    await expect(getStudyMaterial(study, OWNER_B, materialId)).rejects.toMatchObject({
      code: 'STUDY_MATERIAL_NOT_FOUND',
    });
    await expect(
      linkStudySpaceMaterial(study, OWNER_B, spaceB.id, materialId),
    ).rejects.toBeInstanceOf(StudyError);
    await expect(
      requestMaterialParse(study, OWNER_B, materialId, created.versionId),
    ).rejects.toMatchObject({ code: 'STUDY_MATERIAL_NOT_FOUND' });
    await expect(
      readStudyMaterialPage(study, OWNER_B, { materialId, versionId: created.versionId }),
    ).rejects.toMatchObject({ code: 'STUDY_MATERIAL_NOT_FOUND' });
    expect(await listStudyMaterials(study, OWNER_B)).toEqual([]);
    // The same bytes uploaded by B are not reported as a duplicate of A's file.
    const bCopy = await createStudyMaterialFromUpload(study, OWNER_B, {
      upload: await upload(OWNER_B, await textPdf(['Private'])),
    });
    expect(bCopy.duplicateOf).toBeNull();
    const aCopy = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Private'])),
    });
    expect(aCopy.duplicateOf).toMatchObject({ materialId });
  });

  it('revokes session reads, cancels parses and removes every object on permanent delete', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['To delete'])),
    });
    await requestMaterialParse(study, OWNER_A, created.material.materialId, created.versionId);
    await runNextParse();
    const detail = await getStudyMaterial(study, OWNER_A, created.material.materialId);
    await db.exec(`CREATE TABLE agent_sessions(id text primary key, owner_id text, deleted_at timestamptz,
      status text default 'succeeded', lease_worker_id text, lease_heartbeat_at bigint,
      updated_at timestamptz default now());
      INSERT INTO agent_sessions(id,owner_id) VALUES('session-1','${OWNER_A}'),('session-2','${OWNER_A}')`);
    for (const session of ['session-1', 'session-2']) {
      await recordStudySessionRef(q(), {
        ownerId: OWNER_A,
        sessionId: session,
        sessionMaterialId: `mat_${session}`,
        versionId: created.versionId,
        artifactId: detail.current.artifact!.artifactId,
      });
    }
    const rawKey = [...bytes.keys()].find((key) => key.startsWith('materials/'))!;
    const textKey = [...bytes.keys()].find((key) => key.endsWith('/text.md'))!;
    expect(await readableStudySharedKey(q(), 'session-1', rawKey)).toEqual({
      mime: 'application/pdf',
    });
    expect(await readableStudySharedKey(q(), 'session-2', textKey)).toEqual({
      mime: 'text/markdown',
    });
    expect(await readableStudySharedKey(q(), 'session-3', rawKey)).toBeNull();

    // Deleting one session leaves the other reading the shared file.
    await db.query("UPDATE agent_sessions SET deleted_at=now() WHERE id='session-1'");
    expect(await readableStudySharedKey(q(), 'session-1', rawKey)).toBeNull();
    expect(await readableStudySharedKey(q(), 'session-2', rawKey)).toEqual({
      mime: 'application/pdf',
    });
    expect(bytes.has(rawKey)).toBe(true);
    // Only live sessions count toward the delete warning.
    expect(
      (await getStudyMaterial(study, OWNER_A, created.material.materialId)).sessionRefCount,
    ).toBe(1);

    // A queued parse for the material is cancelled by the delete.
    const pending = await requestMaterialParse(
      study,
      OWNER_A,
      created.material.materialId,
      created.versionId,
      { providerId: 'unpdf', idempotencyKey: 'late' },
    );
    expect(
      await purgeStudyMaterial(study, OWNER_B, created.material.materialId).catch((e) => e.code),
    ).toBe('STUDY_MATERIAL_NOT_FOUND');
    expect(await purgeStudyMaterial(study, OWNER_A, created.material.materialId)).toEqual({
      deleted: true,
      pendingObjects: 0,
    });
    expect(await readableStudySharedKey(q(), 'session-2', rawKey)).toBeNull();
    expect(deleted).toEqual(expect.arrayContaining([rawKey, textKey]));
    expect([...bytes.keys()]).toEqual([]);
    for (const table of [
      'study_materials',
      'study_material_versions',
      'study_material_artifacts',
      'study_session_material_refs',
      'learning_tasks',
      'owner_material',
    ]) {
      expect((await db.query(`SELECT 1 FROM ${table}`)).rows).toEqual([]);
    }
    expect(await getLearningTask(q(), OWNER_A, pending.task.taskId)).toBeNull();
  });

  it('resumes an interrupted delete and keeps the material hidden meanwhile', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Flaky storage'])),
    });
    setMaterialByteStoreForTests({
      put: async () => undefined,
      get: async () => Buffer.alloc(0),
      delete: async () => {
        throw new Error('storage outage');
      },
    });
    expect(await purgeStudyMaterial(study, OWNER_A, created.material.materialId)).toEqual({
      deleted: false,
      pendingObjects: 1,
    });
    expect(await listStudyMaterials(study, OWNER_A)).toEqual([]);
    await expect(
      getStudyMaterial(study, OWNER_A, created.material.materialId),
    ).rejects.toMatchObject({
      code: 'STUDY_MATERIAL_NOT_FOUND',
    });
    setMaterialByteStoreForTests({
      put: async () => undefined,
      get: async () => Buffer.alloc(0),
      delete: async () => undefined,
    });
    expect(await purgeStudyMaterial(study, OWNER_A, created.material.materialId)).toEqual({
      deleted: true,
      pendingObjects: 0,
    });
  });

  it('discards a parse that finishes after its material was deleted', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Race'])),
    });
    const { task } = await requestMaterialParse(
      study,
      OWNER_A,
      created.material.materialId,
      created.versionId,
    );
    const lease = (await queue.claim('worker-1', ['material_parse']))!;
    // The material is marked deleting between claim and result commit.
    await db.query("UPDATE study_materials SET status='deleting'");
    await runMaterialParseTask(lease, { queue, signal: new AbortController().signal });
    expect(await getLearningTask(q(), OWNER_A, task.taskId)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'MATERIAL_DELETED',
    });
    expect([...bytes.keys()].filter((key) => key.includes('/artifacts/'))).toEqual([]);
    expect((await db.query('SELECT 1 FROM study_material_artifacts')).rows).toEqual([]);
  });

  it('refuses parses while no learning worker is live', async () => {
    const created = await createStudyMaterialFromUpload(study, OWNER_A, {
      upload: await upload(OWNER_A, await textPdf(['Offline'])),
    });
    await queue.workerHeartbeat('host-1', true);
    await expect(
      requestMaterialParse(study, OWNER_A, created.material.materialId, created.versionId),
    ).rejects.toMatchObject({ code: 'STUDY_TASKS_UNAVAILABLE' });
    await expect(
      requestMaterialParse(study, OWNER_A, created.material.materialId, created.versionId, {
        providerId: 'mineru-cloud',
      }),
    ).rejects.toMatchObject({ code: 'STUDY_PARSER_UNAVAILABLE' });
  });
});
