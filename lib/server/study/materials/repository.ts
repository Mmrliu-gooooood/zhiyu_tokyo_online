/**
 * Study material library repository (learning plan B02). Every query names
 * the owner explicitly, so isolation holds on legacy installs without row
 * security; hosted databases additionally enforce the accounts v23 policies.
 *
 * Bytes are never copied here: a version points at one finalized owner upload
 * (owner_material + its private object). Artifacts are written by the worker;
 * this module reads them, links materials to spaces, records session
 * references and runs the two-phase permanent delete.
 */
import { randomBytes } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import {
  STUDY_MATERIAL_LIMITS,
  parseStateOf,
  type StudyMaterialArtifactView,
  type StudyMaterialDetail,
  type StudyMaterialDuplicateHint,
  type StudyMaterialSpaceRef,
  type StudyMaterialSummary,
  type StudyMaterialVersionView,
} from '@/lib/study/materials/contracts';
import type { LearningTaskView } from '@/lib/study/tasks/contracts';
import {
  cancelLearningTasksForSubjects,
  listLearningTasksForSubjects,
} from '@/lib/server/learning-tasks/repository';
import { StudyError, type StudyDb } from '@/lib/server/study/spaces/repository';

export function createStudyMaterialId(): string {
  return `smat-${randomBytes(9).toString('base64url')}`;
}
export function createStudyVersionId(): string {
  return `sver-${randomBytes(9).toString('base64url')}`;
}
export function createStudyArtifactId(): string {
  return `sart-${randomBytes(9).toString('base64url')}`;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface MaterialRow extends Record<string, unknown> {
  id: string;
  title: string;
  status: 'active' | 'deleting';
  revision: number;
  version_count: number;
  current_version_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface VersionRow extends Record<string, unknown> {
  id: string;
  material_id: string;
  version_no: number;
  owner_material_id: string;
  object_key: string;
  sha256: string;
  mime: string;
  byte_size: number | string;
  original_name: string;
  active_artifact_id: string | null;
  created_at: string | Date;
  a_id: string | null;
  a_extractor_id: string | null;
  a_extractor_version: string | null;
  a_page_count: number | null;
  a_text_chars: number | null;
  a_image_count: number | null;
  a_paged: boolean | null;
  a_diagnostics: unknown;
  a_created_at: string | Date | null;
}

const VERSION_COLUMNS = `v.id, v.material_id, v.version_no, v.owner_material_id, v.object_key,
  v.sha256, v.mime, v.byte_size, v.original_name, v.active_artifact_id, v.created_at,
  a.id AS a_id, a.extractor_id AS a_extractor_id, a.extractor_version AS a_extractor_version,
  a.page_count AS a_page_count, a.text_chars AS a_text_chars, a.image_count AS a_image_count,
  a.paged AS a_paged, a.diagnostics AS a_diagnostics, a.created_at AS a_created_at`;

const VERSION_JOIN = `study_material_versions v
  LEFT JOIN study_material_artifacts a ON a.owner_id = v.owner_id AND a.id = v.active_artifact_id`;

function artifactView(row: VersionRow): StudyMaterialArtifactView | null {
  if (!row.a_id) return null;
  return {
    artifactId: row.a_id,
    extractorId: row.a_extractor_id ?? '',
    extractorVersion: row.a_extractor_version ?? '',
    pageCount: Number(row.a_page_count ?? 0),
    textChars: Number(row.a_text_chars ?? 0),
    imageCount: Number(row.a_image_count ?? 0),
    paged: row.a_paged === true,
    diagnostics: Array.isArray(row.a_diagnostics) ? (row.a_diagnostics as string[]) : [],
    createdAt: iso(row.a_created_at ?? row.created_at),
  };
}

function versionView(
  row: VersionRow,
  currentVersionId: string | null,
  latestTask: LearningTaskView | null,
): StudyMaterialVersionView {
  const artifact = artifactView(row);
  return {
    versionId: row.id,
    versionNo: Number(row.version_no),
    originalName: row.original_name,
    mime: row.mime,
    byteSize: Number(row.byte_size),
    createdAt: iso(row.created_at),
    isCurrent: row.id === currentVersionId,
    parseState: parseStateOf(artifact, latestTask),
    artifact,
    latestTask,
  };
}

/** Materials with their current version, newest change first; optionally only one space's. */
export async function listStudyMaterials(
  db: StudyDb,
  ownerId: string,
  options: { spaceId?: string } = {},
): Promise<StudyMaterialSummary[]> {
  return db.withTransaction(async (tx) => {
    if (options.spaceId) {
      const space = await tx.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
        ownerId,
        options.spaceId,
      ]);
      if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    }
    const materials = await tx.query<MaterialRow>(
      `SELECT m.* FROM study_materials m
        WHERE m.owner_id=$1 AND m.status='active'
          ${
            options.spaceId
              ? `AND EXISTS (SELECT 1 FROM study_space_materials s
                   WHERE s.owner_id=$1 AND s.space_id=$2 AND s.material_id=m.id)`
              : ''
          }
        ORDER BY m.updated_at DESC, m.id
        LIMIT ${STUDY_MATERIAL_LIMITS.maxMaterialsPerOwner}`,
      options.spaceId ? [ownerId, options.spaceId] : [ownerId],
    );
    return summaries(tx, ownerId, materials.rows);
  });
}

async function summaries(
  tx: Queryable,
  ownerId: string,
  materials: MaterialRow[],
): Promise<StudyMaterialSummary[]> {
  const currentIds = materials
    .map((material) => material.current_version_id)
    .filter((id): id is string => Boolean(id));
  if (currentIds.length === 0) return [];
  const versions = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM ${VERSION_JOIN} WHERE v.owner_id=$1 AND v.id=ANY($2::text[])`,
    [ownerId, currentIds],
  );
  const tasks = await listLearningTasksForSubjects(tx, ownerId, currentIds, 1);
  const spaces = await materialSpaces(
    tx,
    ownerId,
    materials.map((material) => material.id),
  );
  const versionById = new Map(versions.rows.map((row) => [row.id, row]));
  const taskBySubject = new Map(tasks.map((task) => [task.subjectId, task]));
  return materials.flatMap((material) => {
    const current = material.current_version_id
      ? versionById.get(material.current_version_id)
      : undefined;
    if (!current) return [];
    return [
      {
        materialId: material.id,
        title: material.title,
        revision: Number(material.revision),
        versionCount: Number(material.version_count),
        current: versionView(
          current,
          material.current_version_id,
          taskBySubject.get(current.id) ?? null,
        ),
        spaces: spaces.get(material.id) ?? [],
        createdAt: iso(material.created_at),
        updatedAt: iso(material.updated_at),
      },
    ];
  });
}

async function materialSpaces(
  tx: Queryable,
  ownerId: string,
  materialIds: string[],
): Promise<Map<string, StudyMaterialSpaceRef[]>> {
  const result = new Map<string, StudyMaterialSpaceRef[]>();
  if (materialIds.length === 0) return result;
  const rows = await tx.query<{ material_id: string; id: string; name: string }>(
    `SELECT sm.material_id, s.id, s.name FROM study_space_materials sm
       JOIN study_spaces s ON s.owner_id = sm.owner_id AND s.id = sm.space_id
      WHERE sm.owner_id=$1 AND sm.material_id=ANY($2::text[])
      ORDER BY s.name, s.id`,
    [ownerId, materialIds],
  );
  for (const row of rows.rows) {
    const list = result.get(row.material_id) ?? [];
    list.push({ spaceId: row.id, name: row.name });
    result.set(row.material_id, list);
  }
  return result;
}

async function activeMaterial(
  tx: Queryable,
  ownerId: string,
  materialId: string,
  lock = false,
): Promise<MaterialRow> {
  const result = await tx.query<MaterialRow>(
    `SELECT * FROM study_materials WHERE owner_id=$1 AND id=$2 AND status='active'
     ${lock ? 'FOR UPDATE' : ''}`,
    [ownerId, materialId],
  );
  if (!result.rows[0]) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  return result.rows[0];
}

export async function getStudyMaterial(
  db: StudyDb,
  ownerId: string,
  materialId: string,
): Promise<StudyMaterialDetail> {
  return db.withTransaction((tx) => readDetail(tx, ownerId, materialId));
}

async function readDetail(
  tx: Queryable,
  ownerId: string,
  materialId: string,
): Promise<StudyMaterialDetail> {
  const material = await activeMaterial(tx, ownerId, materialId);
  const versions = await tx.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM ${VERSION_JOIN}
      WHERE v.owner_id=$1 AND v.material_id=$2 ORDER BY v.version_no DESC`,
    [ownerId, materialId],
  );
  const tasks = await listLearningTasksForSubjects(
    tx,
    ownerId,
    versions.rows.map((row) => row.id),
    1,
  );
  const taskBySubject = new Map(tasks.map((task) => [task.subjectId, task]));
  const views = versions.rows.map((row) =>
    versionView(row, material.current_version_id, taskBySubject.get(row.id) ?? null),
  );
  const current = views.find((version) => version.isCurrent) ?? views[0];
  if (!current) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  const spaces = await materialSpaces(tx, ownerId, [materialId]);
  const refs = await tx.query<{ n: number | string }>(
    `SELECT count(DISTINCT r.session_id) AS n FROM study_session_material_refs r
       JOIN study_material_versions v ON v.owner_id=r.owner_id AND v.id=r.version_id
      WHERE r.owner_id=$1 AND v.material_id=$2`,
    [ownerId, materialId],
  );
  return {
    materialId: material.id,
    title: material.title,
    revision: Number(material.revision),
    versionCount: Number(material.version_count),
    current,
    spaces: spaces.get(materialId) ?? [],
    createdAt: iso(material.created_at),
    updatedAt: iso(material.updated_at),
    versions: views,
    sessionRefCount: Number(refs.rows[0]?.n ?? 0),
  };
}

function defaultTitle(originalName: string): string {
  const base = originalName.replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || originalName;
  return Array.from(base).slice(0, STUDY_MATERIAL_LIMITS.titleMax).join('');
}

async function duplicateHint(
  tx: Queryable,
  ownerId: string,
  sha256: string,
  excludeVersionId: string,
): Promise<StudyMaterialDuplicateHint | null> {
  const found = await tx.query<{ material_id: string; title: string; version_no: number }>(
    `SELECT v.material_id, m.title, v.version_no FROM study_material_versions v
       JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
      WHERE v.owner_id=$1 AND v.sha256=$2 AND v.id<>$3 AND m.status='active'
      ORDER BY v.created_at DESC LIMIT 1`,
    [ownerId, sha256, excludeVersionId],
  );
  const row = found.rows[0];
  return row
    ? { materialId: row.material_id, title: row.title, versionNo: Number(row.version_no) }
    : null;
}

async function lockSpaceForMaterials(tx: Queryable, ownerId: string, spaceId: string) {
  const space = await tx.query<{ status: string }>(
    'SELECT status FROM study_spaces WHERE owner_id=$1 AND id=$2 FOR UPDATE',
    [ownerId, spaceId],
  );
  const status = space.rows[0]?.status;
  if (!status) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  return status;
}

async function insertSpaceLink(
  tx: Queryable,
  ownerId: string,
  spaceId: string,
  materialId: string,
): Promise<boolean> {
  const existing = await tx.query(
    'SELECT 1 FROM study_space_materials WHERE owner_id=$1 AND space_id=$2 AND material_id=$3',
    [ownerId, spaceId, materialId],
  );
  if (existing.rows.length > 0) return false;
  const status = await lockSpaceForMaterials(tx, ownerId, spaceId);
  if (status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
  const count = await tx.query<{ n: number | string }>(
    'SELECT count(*) AS n FROM study_space_materials WHERE owner_id=$1 AND space_id=$2',
    [ownerId, spaceId],
  );
  if (Number(count.rows[0]?.n ?? 0) >= STUDY_MATERIAL_LIMITS.maxMaterialsPerSpace) {
    throw new StudyError('STUDY_SPACE_MATERIAL_LIMIT', {
      maximum: STUDY_MATERIAL_LIMITS.maxMaterialsPerSpace,
    });
  }
  await tx.query(
    `INSERT INTO study_space_materials (owner_id, space_id, material_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [ownerId, spaceId, materialId],
  );
  await tx.query(
    'UPDATE study_spaces SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2',
    [ownerId, spaceId],
  );
  return true;
}

async function insertVersion(
  tx: Queryable,
  ownerId: string,
  materialId: string,
  versionNo: number,
  upload: OwnerMaterialRecord,
): Promise<string> {
  if (upload.status !== 'ready' || !upload.sha256 || !upload.mime || !upload.originalName) {
    throw new StudyError('STUDY_MATERIAL_UNAVAILABLE');
  }
  const versionId = createStudyVersionId();
  await tx.query(
    `INSERT INTO study_material_versions
       (id, owner_id, material_id, version_no, owner_material_id, object_key, sha256, mime,
        byte_size, original_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      versionId,
      ownerId,
      materialId,
      versionNo,
      upload.id,
      upload.ossKey,
      upload.sha256,
      upload.mime,
      upload.bytes,
      upload.originalName,
    ],
  );
  return versionId;
}

/** Turn a finalized upload into a new library material (optionally inside a space). */
export async function createStudyMaterialFromUpload(
  db: StudyDb,
  ownerId: string,
  input: { upload: OwnerMaterialRecord; title?: string; spaceId?: string },
): Promise<{
  material: StudyMaterialDetail;
  versionId: string;
  duplicateOf: StudyMaterialDuplicateHint | null;
}> {
  return db.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('study-materials:owner:' || $1))", [
      ownerId,
    ]);
    const count = await tx.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM study_materials WHERE owner_id=$1 AND status='active'",
      [ownerId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= STUDY_MATERIAL_LIMITS.maxMaterialsPerOwner) {
      throw new StudyError('STUDY_MATERIAL_LIMIT', {
        maximum: STUDY_MATERIAL_LIMITS.maxMaterialsPerOwner,
      });
    }
    if (input.spaceId) {
      const status = await lockSpaceForMaterials(tx, ownerId, input.spaceId);
      if (status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
    }
    const materialId = createStudyMaterialId();
    const title = input.title?.trim() || defaultTitle(input.upload.originalName ?? 'material');
    await tx.query('INSERT INTO study_materials (id, owner_id, title) VALUES ($1,$2,$3)', [
      materialId,
      ownerId,
      Array.from(title).slice(0, STUDY_MATERIAL_LIMITS.titleMax).join(''),
    ]);
    const versionId = await insertVersion(tx, ownerId, materialId, 1, input.upload);
    await tx.query(
      `UPDATE study_materials SET current_version_id=$3, version_count=1
        WHERE owner_id=$1 AND id=$2`,
      [ownerId, materialId, versionId],
    );
    if (input.spaceId) await insertSpaceLink(tx, ownerId, input.spaceId, materialId);
    const duplicateOf = await duplicateHint(tx, ownerId, input.upload.sha256!, versionId);
    return { material: await readDetail(tx, ownerId, materialId), versionId, duplicateOf };
  });
}

/** Replace a material's file: a new immutable version becomes current; older ones stay readable. */
export async function addStudyMaterialVersion(
  db: StudyDb,
  ownerId: string,
  materialId: string,
  upload: OwnerMaterialRecord,
): Promise<{
  material: StudyMaterialDetail;
  versionId: string;
  duplicateOf: StudyMaterialDuplicateHint | null;
}> {
  return db.withTransaction(async (tx) => {
    const material = await activeMaterial(tx, ownerId, materialId, true);
    if (Number(material.version_count) >= STUDY_MATERIAL_LIMITS.maxVersionsPerMaterial) {
      throw new StudyError('STUDY_MATERIAL_VERSION_LIMIT', {
        maximum: STUDY_MATERIAL_LIMITS.maxVersionsPerMaterial,
      });
    }
    const versionNo = Number(material.version_count) + 1;
    const versionId = await insertVersion(tx, ownerId, materialId, versionNo, upload);
    await tx.query(
      `UPDATE study_materials
          SET current_version_id=$3, version_count=$4, revision=revision+1,
              updated_at=clock_timestamp()
        WHERE owner_id=$1 AND id=$2`,
      [ownerId, materialId, versionId, versionNo],
    );
    const duplicateOf = await duplicateHint(tx, ownerId, upload.sha256!, versionId);
    return { material: await readDetail(tx, ownerId, materialId), versionId, duplicateOf };
  });
}

export async function renameStudyMaterial(
  db: StudyDb,
  ownerId: string,
  materialId: string,
  title: string,
  revision: number,
): Promise<StudyMaterialDetail> {
  return db.withTransaction(async (tx) => {
    const material = await activeMaterial(tx, ownerId, materialId, true);
    if (Number(material.revision) !== revision) {
      throw new StudyError('STUDY_REVISION_CONFLICT', {
        current: await readDetail(tx, ownerId, materialId),
      });
    }
    await tx.query(
      `UPDATE study_materials SET title=$3, revision=revision+1, updated_at=clock_timestamp()
        WHERE owner_id=$1 AND id=$2`,
      [ownerId, materialId, title.trim()],
    );
    return readDetail(tx, ownerId, materialId);
  });
}

/** Add an existing library material to a space; repeating it reports created:false. */
export async function linkStudySpaceMaterial(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  materialId: string,
): Promise<{ created: boolean }> {
  return db.withTransaction(async (tx) => {
    await lockSpaceForMaterials(tx, ownerId, spaceId);
    await activeMaterial(tx, ownerId, materialId);
    return { created: await insertSpaceLink(tx, ownerId, spaceId, materialId) };
  });
}

/** Remove a material from a space only; the material, its versions and parses stay. */
export async function unlinkStudySpaceMaterial(
  db: StudyDb,
  ownerId: string,
  spaceId: string,
  materialId: string,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    const space = await tx.query('SELECT 1 FROM study_spaces WHERE owner_id=$1 AND id=$2', [
      ownerId,
      spaceId,
    ]);
    if (space.rows.length === 0) throw new StudyError('STUDY_SPACE_NOT_FOUND');
    const removed = await tx.query(
      `DELETE FROM study_space_materials WHERE owner_id=$1 AND space_id=$2 AND material_id=$3
       RETURNING material_id`,
      [ownerId, spaceId, materialId],
    );
    if (removed.rows.length === 0) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    await tx.query(
      'UPDATE study_spaces SET updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2',
      [ownerId, spaceId],
    );
  });
}

export interface ResolvedStudyVersion {
  materialId: string;
  title: string;
  isCurrent: boolean;
  versionId: string;
  versionNo: number;
  ownerMaterialId: string;
  objectKey: string;
  sha256: string;
  mime: string;
  byteSize: number;
  originalName: string;
  artifact: (StudyMaterialArtifactView & { artifactKey: string; textKey: string }) | null;
}

/**
 * One readable version of a live material. `artifactId` selects a specific
 * stored parse of that version (old citations); default is the active one.
 */
export async function resolveStudyVersion(
  q: Queryable,
  ownerId: string,
  materialId: string,
  versionId: string,
  artifactId?: string,
): Promise<ResolvedStudyVersion> {
  const result = await q.query<
    VersionRow & {
      title: string;
      current_version_id: string | null;
      a_artifact_key: string | null;
      a_text_key: string | null;
    }
  >(
    `SELECT ${VERSION_COLUMNS}, a.artifact_key AS a_artifact_key, a.text_key AS a_text_key,
            m.title, m.current_version_id
       FROM study_material_versions v
       JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
       LEFT JOIN study_material_artifacts a
         ON a.owner_id=v.owner_id AND a.version_id=v.id AND a.id=COALESCE($4, v.active_artifact_id)
      WHERE v.owner_id=$1 AND v.material_id=$2 AND v.id=$3 AND m.status='active'`,
    [ownerId, materialId, versionId, artifactId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
  const artifact = artifactView(row);
  return {
    materialId: row.material_id,
    title: row.title,
    isCurrent: row.current_version_id === row.id,
    versionId: row.id,
    versionNo: Number(row.version_no),
    ownerMaterialId: row.owner_material_id,
    objectKey: row.object_key,
    sha256: row.sha256,
    mime: row.mime,
    byteSize: Number(row.byte_size),
    originalName: row.original_name,
    artifact:
      artifact && row.a_artifact_key && row.a_text_key
        ? { ...artifact, artifactKey: row.a_artifact_key, textKey: row.a_text_key }
        : null,
  };
}

export interface MaterialPurgePlan {
  versionIds: string[];
  uploadIds: string[];
  objectKeys: string[];
}

/**
 * Phase one of a permanent delete: hide the material, revoke every read path
 * (session references, space links, queued/running parses) and return what
 * must be removed from object storage. Idempotent: a material already marked
 * `deleting` returns the same plan so an interrupted delete can resume.
 */
export async function beginStudyMaterialPurge(
  db: StudyDb,
  ownerId: string,
  materialId: string,
): Promise<MaterialPurgePlan> {
  return db.withTransaction(async (tx) => {
    const material = await tx.query<{ status: string }>(
      'SELECT status FROM study_materials WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [ownerId, materialId],
    );
    if (!material.rows[0]) throw new StudyError('STUDY_MATERIAL_NOT_FOUND');
    await tx.query(
      `UPDATE study_materials SET status='deleting', revision=revision+1, updated_at=clock_timestamp()
        WHERE owner_id=$1 AND id=$2`,
      [ownerId, materialId],
    );
    // Lock versions so a parse commit in flight either lands before (and its
    // objects are in the plan) or sees the material as deleting.
    const versions = await tx.query<{ id: string; owner_material_id: string; object_key: string }>(
      `SELECT id, owner_material_id, object_key FROM study_material_versions
        WHERE owner_id=$1 AND material_id=$2 FOR UPDATE`,
      [ownerId, materialId],
    );
    const versionIds = versions.rows.map((row) => row.id);
    const artifacts = await tx.query<{ object_keys: string[] }>(
      `SELECT object_keys FROM study_material_artifacts
        WHERE owner_id=$1 AND version_id=ANY($2::text[])`,
      [ownerId, versionIds],
    );
    await cancelLearningTasksForSubjects(tx, ownerId, versionIds);
    await tx.query(
      'DELETE FROM study_session_material_refs WHERE owner_id=$1 AND version_id=ANY($2::text[])',
      [ownerId, versionIds],
    );
    await tx.query('DELETE FROM study_space_materials WHERE owner_id=$1 AND material_id=$2', [
      ownerId,
      materialId,
    ]);
    return {
      versionIds,
      uploadIds: versions.rows.map((row) => row.owner_material_id),
      objectKeys: [
        ...versions.rows.map((row) => row.object_key),
        ...artifacts.rows.flatMap((row) => (Array.isArray(row.object_keys) ? row.object_keys : [])),
      ],
    };
  });
}

/** Phase two, after every object is confirmed gone: remove the rows. */
export async function finishStudyMaterialPurge(
  db: StudyDb,
  ownerId: string,
  materialId: string,
  plan: MaterialPurgePlan,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    await tx.query('DELETE FROM learning_tasks WHERE owner_id=$1 AND subject_id=ANY($2::text[])', [
      ownerId,
      plan.versionIds,
    ]);
    await tx.query(
      `DELETE FROM study_materials WHERE owner_id=$1 AND id=$2 AND status='deleting'`,
      [ownerId, materialId],
    );
    await tx.query('DELETE FROM owner_material WHERE owner_id=$1 AND id=ANY($2::text[])', [
      ownerId,
      plan.uploadIds,
    ]);
  });
}

// ── agent session references ─────────────────────────────────────────────

export interface StudySessionBinding {
  versionId: string;
  objectKey: string;
  mime: string;
  originalName: string;
  byteSize: number;
  artifact: {
    artifactId: string;
    textKey: string;
    textChars: number;
    pageCount: number;
    imageCount: number;
    extractorId: string;
    extractorVersion: string;
    diagnostics: string[];
  } | null;
}

/** The live study version behind an owner upload id, if that upload belongs to the library. */
export async function findStudyVersionByUpload(
  q: Queryable,
  ownerId: string,
  ownerMaterialId: string,
): Promise<StudySessionBinding | null> {
  const result = await q.query<{
    id: string;
    object_key: string;
    mime: string;
    original_name: string;
    byte_size: number | string;
    a_id: string | null;
    text_key: string | null;
    text_chars: number | null;
    page_count: number | null;
    image_count: number | null;
    extractor_id: string | null;
    extractor_version: string | null;
    diagnostics: unknown;
  }>(
    `SELECT v.id, v.object_key, v.mime, v.original_name, v.byte_size,
            a.id AS a_id, a.text_key, a.text_chars, a.page_count, a.image_count,
            a.extractor_id, a.extractor_version, a.diagnostics
       FROM study_material_versions v
       JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id
       LEFT JOIN study_material_artifacts a ON a.owner_id=v.owner_id AND a.id=v.active_artifact_id
      WHERE v.owner_id=$1 AND v.owner_material_id=$2 AND m.status='active'`,
    [ownerId, ownerMaterialId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    versionId: row.id,
    objectKey: row.object_key,
    mime: row.mime,
    originalName: row.original_name,
    byteSize: Number(row.byte_size),
    artifact:
      row.a_id && row.text_key
        ? {
            artifactId: row.a_id,
            textKey: row.text_key,
            textChars: Number(row.text_chars ?? 0),
            pageCount: Number(row.page_count ?? 0),
            imageCount: Number(row.image_count ?? 0),
            extractorId: row.extractor_id ?? '',
            extractorVersion: row.extractor_version ?? '',
            diagnostics: Array.isArray(row.diagnostics) ? (row.diagnostics as string[]) : [],
          }
        : null,
  };
}

export async function recordStudySessionRef(
  q: Queryable,
  input: {
    ownerId: string;
    sessionId: string;
    sessionMaterialId: string;
    versionId: string;
    artifactId: string | null;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO study_session_material_refs
       (owner_id, session_id, session_material_id, version_id, artifact_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id, session_material_id) DO NOTHING`,
    [input.ownerId, input.sessionId, input.sessionMaterialId, input.versionId, input.artifactId],
  );
}

/**
 * Whether `key` is a shared study object this live session may read: it must
 * be the raw object or the referenced artifact's text of a version the session
 * holds a reference to, of a live material of the session's owner.
 */
export async function readableStudySharedKey(
  q: Queryable,
  sessionId: string,
  key: string,
): Promise<{ mime: string } | null> {
  const result = await q.query<{ mime: string }>(
    `SELECT CASE WHEN v.object_key=$2 THEN v.mime ELSE 'text/markdown' END AS mime
         FROM study_session_material_refs r
         JOIN agent_sessions s ON s.id=r.session_id AND s.owner_id=r.owner_id AND s.deleted_at IS NULL
         JOIN study_material_versions v ON v.owner_id=r.owner_id AND v.id=r.version_id
         JOIN study_materials m ON m.owner_id=v.owner_id AND m.id=v.material_id AND m.status='active'
         LEFT JOIN study_material_artifacts a ON a.owner_id=r.owner_id AND a.id=r.artifact_id
        WHERE r.session_id=$1 AND (v.object_key=$2 OR a.text_key=$2)
        LIMIT 1`,
    [sessionId, key],
  );
  return result.rows[0] ? { mime: result.rows[0].mime } : null;
}
