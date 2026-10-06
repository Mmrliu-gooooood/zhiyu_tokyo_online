/**
 * Classmate templates (learning plan B04). Every query names the owner
 * explicitly, so isolation holds on legacy installs without row security; on
 * hosted databases the same queries also run under the owner-bound app_web
 * policies of accounts v25 (and the worker's read grant for Pro sessions).
 *
 * Each saved change bumps `revision` and stores that revision's snapshot in
 * the same transaction, so every revision a classroom may name exists.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  CLASSMATE_LIMITS,
  classmateAvatarPath,
  parseClassmateSnapshot,
  snapshotOf,
  uploadedAvatarId,
  type ClassmateAvatarType,
  type ClassmateInput,
  type ClassmatePatch,
  type ClassmateSnapshot,
  type ClassmateStatus,
  type ClassmateView,
  type ClassmateVoice,
} from '@/lib/study/classmates/contracts';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';

export function createClassmateId(): string {
  return `cm-${randomBytes(8).toString('hex')}`;
}

function createAvatarId(): string {
  return `av-${randomBytes(8).toString('hex')}`;
}

interface ClassmateRow extends Record<string, unknown> {
  id: string;
  name: string;
  role: ClassmateView['role'];
  persona: string;
  learning_style: ClassmateView['learningStyle'];
  speech_policy: ClassmateView['speechPolicy'];
  avatar: string;
  color: string;
  voice: ClassmateVoice | string | null;
  status: ClassmateStatus;
  revision: number;
  created_at: string | Date;
  updated_at: string | Date;
  material_ids: string[] | null;
}

const COLUMNS = `c.id, c.name, c.role, c.persona, c.learning_style, c.speech_policy, c.avatar,
  c.color, c.voice, c.status, c.revision, c.created_at, c.updated_at,
  COALESCE((SELECT array_agg(m.material_id ORDER BY m.added_at, m.material_id)
              FROM study_classmate_materials m
             WHERE m.owner_id = c.owner_id AND m.classmate_id = c.id), '{}') AS material_ids`;

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function jsonValue<T>(value: T | string | null): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function viewFromRow(row: ClassmateRow): ClassmateView {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    persona: row.persona,
    learningStyle: row.learning_style,
    speechPolicy: row.speech_policy,
    avatar: row.avatar,
    color: row.color,
    voice: jsonValue<ClassmateVoice>(row.voice),
    materialIds: row.material_ids ?? [],
    status: row.status,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listClassmates(
  db: Queryable,
  ownerId: string,
  options: { status?: ClassmateStatus } = {},
): Promise<ClassmateView[]> {
  const result = await db.query<ClassmateRow>(
    `SELECT ${COLUMNS} FROM study_classmates c
      WHERE c.owner_id = $1 AND ($2::text IS NULL OR c.status = $2)
      ORDER BY c.status, c.updated_at DESC, c.id`,
    [ownerId, options.status ?? null],
  );
  return result.rows.map(viewFromRow);
}

export async function getClassmate(
  db: Queryable,
  ownerId: string,
  classmateId: string,
): Promise<ClassmateView> {
  const result = await db.query<ClassmateRow>(
    `SELECT ${COLUMNS} FROM study_classmates c WHERE c.owner_id = $1 AND c.id = $2`,
    [ownerId, classmateId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
  return viewFromRow(row);
}

/** Uploaded avatars must be the owner's; bundled ones are always allowed. */
async function assertAvatar(tx: Queryable, ownerId: string, avatar: string): Promise<void> {
  const avatarId = uploadedAvatarId(avatar);
  if (!avatarId) return;
  const found = await tx.query<{ id: string }>(
    'SELECT id FROM study_classmate_avatars WHERE owner_id = $1 AND id = $2',
    [ownerId, avatarId],
  );
  if (found.rows.length === 0) throw new StudyError('STUDY_AVATAR_NOT_FOUND');
}

/** Replace the material links; every material must be the owner's live library entry. */
async function writeMaterials(
  tx: Queryable,
  ownerId: string,
  classmateId: string,
  materialIds: string[],
): Promise<void> {
  if (materialIds.length > 0) {
    const live = await tx.query<{ id: string }>(
      `SELECT id FROM study_materials
        WHERE owner_id = $1 AND id = ANY($2::text[]) AND status = 'active'`,
      [ownerId, materialIds],
    );
    if (live.rows.length !== materialIds.length) {
      throw new StudyError('STUDY_CLASSMATE_MATERIAL_UNAVAILABLE');
    }
  }
  await tx.query(
    `DELETE FROM study_classmate_materials
      WHERE owner_id = $1 AND classmate_id = $2 AND NOT (material_id = ANY($3::text[]))`,
    [ownerId, classmateId, materialIds],
  );
  for (const materialId of materialIds) {
    await tx.query(
      `INSERT INTO study_classmate_materials (owner_id, classmate_id, material_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [ownerId, classmateId, materialId],
    );
  }
}

async function writeRevision(
  tx: Queryable,
  ownerId: string,
  classmateId: string,
  revision: number,
  snapshot: ClassmateSnapshot,
): Promise<void> {
  await tx.query(
    `INSERT INTO study_classmate_revisions (owner_id, classmate_id, revision, snapshot)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [ownerId, classmateId, revision, JSON.stringify(snapshotOf(snapshot))],
  );
}

async function insertClassmate(
  tx: Queryable,
  ownerId: string,
  input: ClassmateInput,
  importKey: string | null,
): Promise<string | null> {
  const count = await tx.query<{ count: string | number }>(
    'SELECT count(*) AS count FROM study_classmates WHERE owner_id = $1',
    [ownerId],
  );
  if (Number(count.rows[0]?.count ?? 0) >= CLASSMATE_LIMITS.classmatesPerOwner) {
    throw new StudyError('STUDY_CLASSMATE_LIMIT');
  }
  await assertAvatar(tx, ownerId, input.avatar);
  const id = createClassmateId();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO study_classmates
       (id, owner_id, name, role, persona, learning_style, speech_policy, avatar, color, voice,
        import_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id,
      ownerId,
      input.name,
      input.role,
      input.persona,
      input.learningStyle,
      input.speechPolicy,
      input.avatar,
      input.color,
      input.voice ? JSON.stringify(input.voice) : null,
      importKey,
    ],
  );
  if (inserted.rows.length === 0) return null;
  await writeRevision(tx, ownerId, id, 1, input);
  await writeMaterials(tx, ownerId, id, input.materialIds);
  return id;
}

export async function createClassmate(
  db: StudyDb,
  ownerId: string,
  input: ClassmateInput,
): Promise<ClassmateView> {
  const id = await db.withTransaction(async (tx) => {
    const created = await insertClassmate(tx, ownerId, input, null);
    if (!created) throw new StudyError('STUDY_CLASSMATE_LIMIT');
    return created;
  });
  return getClassmate(db, ownerId, id);
}

const PATCH_COLUMNS: Array<[keyof ClassmateInput, string, string]> = [
  ['name', 'name', ''],
  ['role', 'role', ''],
  ['persona', 'persona', ''],
  ['learningStyle', 'learning_style', ''],
  ['speechPolicy', 'speech_policy', ''],
  ['avatar', 'avatar', ''],
  ['color', 'color', ''],
  ['voice', 'voice', '::jsonb'],
];

/**
 * Apply a partial update when `expectedRevision` is still current. A stale
 * revision answers STUDY_REVISION_CONFLICT carrying the current template. An
 * archived template only accepts being restored.
 */
export async function updateClassmate(
  db: StudyDb,
  ownerId: string,
  classmateId: string,
  patch: ClassmatePatch,
  expectedRevision: number,
): Promise<ClassmateView> {
  await db
    .withTransaction(async (tx) => {
      const current = await tx.query<ClassmateRow>(
        `SELECT ${COLUMNS} FROM study_classmates c
          WHERE c.owner_id = $1 AND c.id = $2 FOR UPDATE`,
        [ownerId, classmateId],
      );
      const row = current.rows[0];
      if (!row) throw new StudyError('STUDY_CLASSMATE_NOT_FOUND');
      if (Number(row.revision) !== expectedRevision)
        throw new StudyError('STUDY_REVISION_CONFLICT');
      const before = viewFromRow(row);
      const editsContent =
        PATCH_COLUMNS.some(([field]) => field in patch) || 'materialIds' in patch;
      if (before.status === 'archived' && patch.status !== 'active' && editsContent) {
        throw new StudyError('STUDY_CLASSMATE_ARCHIVED');
      }
      if (patch.avatar !== undefined) await assertAvatar(tx, ownerId, patch.avatar);

      const sets: string[] = [];
      const values: unknown[] = [ownerId, classmateId];
      for (const [field, column, cast] of PATCH_COLUMNS) {
        if (!(field in patch)) continue;
        const value = patch[field];
        values.push(field === 'voice' ? (value ? JSON.stringify(value) : null) : value);
        sets.push(`${column} = $${values.length}${cast}`);
      }
      if (patch.status) {
        values.push(patch.status);
        sets.push(`status = $${values.length}`);
        sets.push(
          `archived_at = CASE WHEN $${values.length} = 'archived' THEN COALESCE(archived_at, clock_timestamp()) END`,
        );
      }
      const updated = await tx.query<ClassmateRow>(
        `UPDATE study_classmates c
            SET ${[...sets, 'revision = revision + 1', 'updated_at = clock_timestamp()'].join(', ')}
          WHERE c.owner_id = $1 AND c.id = $2
          RETURNING ${COLUMNS}`,
        values,
      );
      const after = viewFromRow(updated.rows[0]!);
      await writeRevision(tx, ownerId, classmateId, after.revision, after);
      if (patch.materialIds) await writeMaterials(tx, ownerId, classmateId, patch.materialIds);
    })
    .catch(async (error) => {
      if (error instanceof StudyError && error.code === 'STUDY_REVISION_CONFLICT') {
        throw new StudyError('STUDY_REVISION_CONFLICT', {
          current: await getClassmate(db, ownerId, classmateId),
        });
      }
      throw error;
    });
  return getClassmate(db, ownerId, classmateId);
}

/**
 * Create templates from roles the student made on this device before
 * templates lived on the server. Each role is imported at most once per
 * account: the import key hashes its content, so a second import (from this
 * or another device) skips what is already there.
 */
export async function importClassmates(
  db: StudyDb,
  ownerId: string,
  inputs: ClassmateInput[],
): Promise<{ created: ClassmateView[]; skipped: number }> {
  const ids = await db.withTransaction(async (tx) => {
    const created: string[] = [];
    for (const input of inputs) {
      const key = createHash('sha256')
        .update(JSON.stringify([input.name, input.role, input.persona]))
        .digest('hex');
      const id = await insertClassmate(tx, ownerId, input, key);
      if (id) created.push(id);
    }
    return created;
  });
  const created = await Promise.all(ids.map((id) => getClassmate(db, ownerId, id)));
  return { created, skipped: inputs.length - ids.length };
}

/**
 * The owner's active templates at their current revision, read from the
 * template table alone (the generation worker may read templates and
 * revisions, nothing else of the study schema).
 */
export async function listActiveClassmateSnapshots(
  db: Queryable,
  ownerId: string,
): Promise<Array<{ id: string; revision: number; snapshot: ClassmateSnapshot }>> {
  const result = await db.query<ClassmateRow>(
    `SELECT id, name, role, persona, learning_style, speech_policy, avatar, color, voice,
            status, revision, created_at, updated_at, ARRAY[]::text[] AS material_ids
       FROM study_classmates
      WHERE owner_id = $1 AND status = 'active'
      ORDER BY updated_at DESC, id`,
    [ownerId],
  );
  return result.rows.map((row) => {
    const view = viewFromRow(row);
    return { id: view.id, revision: view.revision, snapshot: snapshotOf(view) };
  });
}

/**
 * The frozen snapshots for classroom agent ids, keyed `<classmateId>-r<revision>`.
 * Unknown or foreign revisions are simply absent.
 */
export async function readClassmateRevisions(
  db: Queryable,
  ownerId: string,
  refs: ReadonlyArray<{ classmateId: string; revision: number }>,
): Promise<Map<string, ClassmateSnapshot>> {
  const out = new Map<string, ClassmateSnapshot>();
  if (refs.length === 0) return out;
  const result = await db.query<{
    classmate_id: string;
    revision: number;
    snapshot: unknown;
  }>(
    `SELECT r.classmate_id, r.revision, r.snapshot
       FROM study_classmate_revisions r
       JOIN unnest($2::text[], $3::int[]) AS want(classmate_id, revision)
         ON want.classmate_id = r.classmate_id AND want.revision = r.revision
      WHERE r.owner_id = $1`,
    [ownerId, refs.map((ref) => ref.classmateId), refs.map((ref) => ref.revision)],
  );
  for (const row of result.rows) {
    const snapshot = parseClassmateSnapshot(jsonValue(row.snapshot as string | null));
    if (snapshot) out.set(`${row.classmate_id}-r${Number(row.revision)}`, snapshot);
  }
  return out;
}

// ── avatars ────────────────────────────────────────────────────────────────

const SIGNATURES: Array<[ClassmateAvatarType, (bytes: Uint8Array) => boolean]> = [
  [
    'image/png',
    (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d,
  ],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    'image/webp',
    (b) =>
      b.length > 12 &&
      String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.subarray(8, 12)) === 'WEBP',
  ],
];

/** The image type the bytes actually are, when it is one avatars accept. */
export function sniffAvatarType(bytes: Uint8Array): ClassmateAvatarType | null {
  return SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null;
}

/**
 * Store an uploaded avatar and return its path. The same picture uploaded
 * twice is stored once. The declared type must match the bytes.
 */
export async function saveClassmateAvatar(
  db: StudyDb,
  ownerId: string,
  bytes: Uint8Array,
  declaredType: string,
): Promise<{ id: string; avatar: string }> {
  const type = sniffAvatarType(bytes);
  if (!type || type !== declaredType || bytes.length > CLASSMATE_LIMITS.avatarBytes) {
    throw new StudyError('STUDY_AVATAR_INVALID');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = await db.withTransaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      'SELECT id FROM study_classmate_avatars WHERE owner_id = $1 AND sha256 = $2',
      [ownerId, sha256],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const count = await tx.query<{ count: string | number }>(
      'SELECT count(*) AS count FROM study_classmate_avatars WHERE owner_id = $1',
      [ownerId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= CLASSMATE_LIMITS.avatarsPerOwner) {
      throw new StudyError('STUDY_AVATAR_LIMIT');
    }
    const avatarId = createAvatarId();
    await tx.query(
      `INSERT INTO study_classmate_avatars (id, owner_id, content_type, sha256, byte_size, bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [avatarId, ownerId, type, sha256, bytes.length, Buffer.from(bytes)],
    );
    return avatarId;
  });
  return { id, avatar: classmateAvatarPath(id) };
}

export async function readClassmateAvatar(
  db: Queryable,
  ownerId: string,
  avatarId: string,
): Promise<{ contentType: ClassmateAvatarType; bytes: Uint8Array; sha256: string }> {
  const result = await db.query<{
    content_type: ClassmateAvatarType;
    bytes: Uint8Array;
    sha256: string;
  }>(
    'SELECT content_type, bytes, sha256 FROM study_classmate_avatars WHERE owner_id = $1 AND id = $2',
    [ownerId, avatarId],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_AVATAR_NOT_FOUND');
  return { contentType: row.content_type, bytes: new Uint8Array(row.bytes), sha256: row.sha256 };
}
