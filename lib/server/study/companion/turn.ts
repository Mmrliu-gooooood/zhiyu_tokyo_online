/**
 * What one after-class turn may use, resolved on the server at the start of
 * every run (learning plan B05): the classmate's current template and
 * revision, the study space, the materials the classmate may draw on in that
 * space, and the searchable indexes among them.
 *
 * Material scope = the space's live materials ∩ the classmate's authorised
 * materials. The same chat therefore never reaches another space's
 * materials, and a material removed from either side drops out of the next
 * turn (and of every later re-rendering of earlier tool results).
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { getClassmate } from '@/lib/server/study/classmates/repository';
import { resolveStudyRetrieval } from '@/lib/server/study/knowledge/config';
import {
  knowledgeStorageReady,
  resolveQuestionScope,
  type ScopedIndex,
} from '@/lib/server/study/knowledge/repository';
import { isStudyQaFlagOn } from '@/lib/server/study/flags';
import { StudyError } from '@/lib/server/study/spaces/repository';
import {
  snapshotOf,
  type ClassmateSnapshot,
  type ClassmateView,
} from '@/lib/study/classmates/contracts';
import type { CompanionChatRow } from './repository';

export interface CompanionSpace {
  id: string;
  name: string;
  subject: string | null;
  status: 'active' | 'archived';
}

export interface CompanionTurnContext {
  classmate: ClassmateView;
  snapshot: ClassmateSnapshot;
  space: CompanionSpace;
  /** Live library materials this classmate may use in this space. */
  materials: Array<{ id: string; title: string }>;
  allowedMaterialIds: Set<string>;
  /** Active keyword indexes of those materials (current versions). */
  scope: ScopedIndex[];
  retrieval: 'keyword' | 'unavailable';
}

export async function readCompanionSpace(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<CompanionSpace> {
  const result = await db.query<{
    id: string;
    name: string;
    subject: string | null;
    status: 'active' | 'archived';
  }>('SELECT id, name, subject, status FROM study_spaces WHERE owner_id = $1 AND id = $2', [
    ownerId,
    spaceId,
  ]);
  const row = result.rows[0];
  if (!row) throw new StudyError('STUDY_SPACE_NOT_FOUND');
  return row;
}

/** Authorised ∩ in-space ∩ live materials. */
export async function companionMaterials(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  classmateId: string,
): Promise<Array<{ id: string; title: string }>> {
  const result = await db.query<{ id: string; title: string }>(
    `SELECT m.id, m.title
       FROM study_classmate_materials cm
       JOIN study_space_materials sm
         ON sm.owner_id = cm.owner_id AND sm.material_id = cm.material_id AND sm.space_id = $3
       JOIN study_materials m
         ON m.owner_id = cm.owner_id AND m.id = cm.material_id AND m.status = 'active'
      WHERE cm.owner_id = $1 AND cm.classmate_id = $2
      ORDER BY m.title, m.id`,
    [ownerId, classmateId, spaceId],
  );
  return result.rows;
}

/** Searchable indexes inside the authorised set. Keyword search only (no embedding cost). */
export async function companionScope(
  db: Queryable,
  ownerId: string,
  spaceId: string,
  allowedMaterialIds: ReadonlySet<string>,
): Promise<{ scope: ScopedIndex[]; retrieval: 'keyword' | 'unavailable' }> {
  if (!isStudyQaFlagOn() || !(await knowledgeStorageReady(db))) {
    return { scope: [], retrieval: 'unavailable' };
  }
  if (allowedMaterialIds.size === 0) return { scope: [], retrieval: 'keyword' };
  const retrieval = resolveStudyRetrieval();
  if (!retrieval.signature) return { scope: [], retrieval: 'unavailable' };
  const scope = await resolveQuestionScope(db, ownerId, spaceId, retrieval.signature, []);
  return {
    scope: scope.filter((index) => allowedMaterialIds.has(index.materialId)),
    retrieval: 'keyword',
  };
}

/**
 * Resolve the turn. An archived classmate or space stops the chat with its
 * own code — the history stays readable, nothing answers in its place.
 */
export async function resolveCompanionTurn(
  db: Queryable,
  ownerId: string,
  chat: Pick<CompanionChatRow, 'spaceId' | 'classmateId'>,
): Promise<CompanionTurnContext> {
  const classmate = await getClassmate(db, ownerId, chat.classmateId);
  if (classmate.status !== 'active') throw new StudyError('STUDY_CLASSMATE_ARCHIVED');
  const space = await readCompanionSpace(db, ownerId, chat.spaceId);
  if (space.status !== 'active') throw new StudyError('STUDY_SPACE_ARCHIVED');
  const materials = await companionMaterials(db, ownerId, chat.spaceId, chat.classmateId);
  const allowedMaterialIds = new Set(materials.map((material) => material.id));
  const { scope, retrieval } = await companionScope(db, ownerId, chat.spaceId, allowedMaterialIds);
  return {
    classmate,
    snapshot: snapshotOf(classmate),
    space,
    materials,
    allowedMaterialIds,
    scope,
    retrieval,
  };
}
