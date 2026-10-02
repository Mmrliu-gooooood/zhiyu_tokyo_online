/**
 * Plant a generation model snapshot row with stored content of any version.
 * GenerationModelSnapshotStore.create writes only v3; v1 / v2 rows written by
 * earlier builds are reproduced here to exercise the read-and-upgrade path.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { GenerationModelRef } from '@/lib/server/generation-jobs/contracts';
import {
  sealGenerationModelSnapshot,
  type StoredGenerationModelSnapshotContent,
} from '@/lib/server/generation-model-snapshots';
import { modelConfigSelection } from '@/lib/utils/model-selection';
import type { ModelConfigInput, ProModelContext } from '@/types/pro-model';

/** A Home model configuration (flat settings fields) as a connection selection. */
export function selectionOf(config: ModelConfigInput): Pick<ProModelContext, 'selection'> {
  const selection = modelConfigSelection(config);
  if (!selection) throw new Error('invalid test model configuration');
  return { selection };
}

export async function plantModelSnapshot(
  db: Queryable,
  ownerId: string,
  content: StoredGenerationModelSnapshotContent,
): Promise<GenerationModelRef> {
  const ref = { id: randomUUID(), revision: 1 };
  const { ciphertext, intentDigest } = sealGenerationModelSnapshot(content, ownerId, ref);
  await db.query(
    'INSERT INTO generation_model_snapshots(id,owner_id,revision,schema_version,ciphertext,intent_digest) VALUES($1,$2,$3,$4,$5,$6)',
    [ref.id, ownerId, ref.revision, content.version, ciphertext, intentDigest],
  );
  return ref;
}
