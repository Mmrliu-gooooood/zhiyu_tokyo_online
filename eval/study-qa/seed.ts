/**
 * Seed the B03 fixture into a study database as if each version had been
 * uploaded and parsed by B02 (owner_material upload, material, versions,
 * active parse artifact with its JSON in the byte store) and linked to one
 * study space per owner. Used by the server tests and the evaluation runner
 * against disposable databases only.
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import { fixtureArtifact, type StudyQaFixture } from './fixture';

export interface SeededVersion {
  versionId: string;
  artifactId: string;
}

export interface SeededFixture {
  spaceIds: { A: string; B: string };
  materials: Map<
    string,
    { materialId: string; owner: 'A' | 'B'; versions: Map<number, SeededVersion> }
  >;
  /** versionId → material key and number, for mapping hits back to labels. */
  byVersionId: Map<string, { key: string; no: number }>;
}

export async function seedStudyQaFixture(
  q: Queryable,
  fixture: StudyQaFixture,
  putObject: (key: string, body: Buffer) => Promise<void>,
): Promise<SeededFixture> {
  const spaceIds = { A: 'space_eval_a', B: 'space_eval_b' };
  for (const owner of ['A', 'B'] as const) {
    await q.query(
      `INSERT INTO study_spaces (id, owner_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [spaceIds[owner], fixture.owners[owner], owner === 'A' ? '评测学科 A' : '评测学科 B'],
    );
  }
  const materials: SeededFixture['materials'] = new Map();
  const byVersionId: SeededFixture['byVersionId'] = new Map();
  for (const material of fixture.materials) {
    const ownerId = fixture.owners[material.owner];
    const materialId = `smat_eval_${material.key}`;
    const versions = new Map<number, SeededVersion>();
    const latest = Math.max(...material.versions.map((version) => version.no));
    await q.query(
      `INSERT INTO study_materials (id, owner_id, title, current_version_id, version_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        materialId,
        ownerId,
        material.title,
        `sver_eval_${material.key}_${latest}`,
        material.versions.length,
      ],
    );
    for (const version of material.versions) {
      const versionId = `sver_eval_${material.key}_${version.no}`;
      const artifactId = `sart_eval_${material.key}_${version.no}`;
      const uploadId = `up_eval_${material.key}_${version.no}`;
      const document = fixtureArtifact(version);
      const body = Buffer.from(JSON.stringify(document), 'utf8');
      const sha256 = createHash('sha256').update(JSON.stringify(version)).digest('hex');
      const objectKey = `materials/${ownerId}/${uploadId}`;
      const artifactKey = `study/${ownerId}/artifacts/${artifactId}/artifact.json`;
      await putObject(artifactKey, body);
      await q.query(
        `INSERT INTO owner_material (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
           status, created_at)
         VALUES ($1, $2, 'source', 'application/pdf', 100, $3, $4, $5, 'ready', 0)`,
        [uploadId, ownerId, `${material.key}-v${version.no}.pdf`, objectKey, sha256],
      );
      await q.query(
        `INSERT INTO study_material_versions (id, owner_id, material_id, version_no,
           owner_material_id, object_key, sha256, mime, byte_size, original_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', 100, $8)`,
        [
          versionId,
          ownerId,
          materialId,
          version.no,
          uploadId,
          objectKey,
          sha256,
          `${material.key}-v${version.no}.pdf`,
        ],
      );
      await q.query(
        `INSERT INTO study_material_artifacts (id, owner_id, version_id, fingerprint, extractor_id,
           extractor_version, transform_version, artifact_key, text_key, object_keys, page_count,
           block_count, text_chars, paged)
         VALUES ($1, $2, $3, $4, 'unpdf', 'fixture', 'study-artifact-v1', $5, $6, $7::jsonb, $8, $9, $10, true)`,
        [
          artifactId,
          ownerId,
          versionId,
          createHash('sha256').update(artifactId).digest('hex'),
          artifactKey,
          `study/${ownerId}/artifacts/${artifactId}/text.md`,
          JSON.stringify([artifactKey]),
          document.pageCount,
          document.blocks.length,
          document.blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0),
        ],
      );
      await q.query(
        'UPDATE study_material_versions SET active_artifact_id=$3 WHERE owner_id=$1 AND id=$2',
        [ownerId, versionId, artifactId],
      );
      versions.set(version.no, { versionId, artifactId });
      byVersionId.set(versionId, { key: material.key, no: version.no });
    }
    await q.query(
      `INSERT INTO study_space_materials (owner_id, space_id, material_id) VALUES ($1, $2, $3)`,
      [ownerId, spaceIds[material.owner], materialId],
    );
    materials.set(material.key, { materialId, owner: material.owner, versions });
  }
  return { spaceIds, materials, byVersionId };
}
