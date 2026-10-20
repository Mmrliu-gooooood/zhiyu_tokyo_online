/**
 * What one after-class turn — or one live classroom reply — receives from
 * Memory (learning plan B06), resolved again for every run — the same "per-turn, on the server" rule as
 * the classmate's persona and materials (B05). Nothing is cached between
 * turns, so turning Memory off (or deleting a preference) applies to the very
 * next answer. Every classmate reads the same owner Memory; only the current
 * subject's items (plus global ones) are selected, within item and token caps.
 *
 * Memory never blocks a chat: a missing table (before v27) or a read error
 * resolves to `unavailable` with nothing injected.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { isStudyMemoryFlagOn, isStudyReviewFlagOn } from '@/lib/server/study/flags';
import {
  approximateTokens,
  classroomPreferenceScope,
  renderClassroomPreferenceBlock,
  renderMemoryBlock,
  selectClassroomPreferences,
  selectMemoryContext,
  type MemoryContextItem,
  type MemoryContextState,
  type MemoryTurnInfo,
} from '@/lib/study/memory/contracts';

import { listFacts, listPreferences, readMemoryControls } from './repository';

const log = createLogger('StudyMemoryContext');

export interface ResolvedMemoryContext {
  state: MemoryContextState;
  items: MemoryContextItem[];
  /** System-prompt block ('' when nothing is injected). */
  block: string;
  info: MemoryTurnInfo;
}

function resolved(
  state: MemoryContextState,
  items: MemoryContextItem[] = [],
  render: (items: readonly MemoryContextItem[]) => string = renderMemoryBlock,
): ResolvedMemoryContext {
  const block = render(items);
  return {
    state,
    items,
    block,
    info: {
      state,
      refs: items.map((item) => item.ref),
      tokens: block ? approximateTokens(block) : 0,
    },
  };
}

/**
 * The space's ready summary (B12), or null. A read failure (e.g. before v33)
 * only leaves the summary out; the rest of Memory still applies.
 */
async function readSpaceSummary(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<{ text: string; sourceWatermark: number | null } | null> {
  if (!isStudyReviewFlagOn()) return null;
  try {
    const result = await db.query<{ text: string; source_watermark: string | number | null }>(
      `SELECT text, source_watermark FROM study_memory_summaries
        WHERE owner_id = $1 AND space_id = $2 AND status = 'ready'`,
      [ownerId, spaceId],
    );
    const row = result.rows[0];
    return row
      ? {
          text: row.text,
          sourceWatermark: row.source_watermark === null ? null : Number(row.source_watermark),
        }
      : null;
  } catch (error) {
    log.warn('memory summary unavailable; answering without it', {
      code: (error as { code?: string }).code,
    });
    return null;
  }
}

export async function resolveMemoryContext(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<ResolvedMemoryContext> {
  if (!isStudyMemoryFlagOn()) return resolved('unavailable');
  try {
    const controls = await readMemoryControls(db, ownerId);
    if (!controls.global.enabled) return resolved('off');
    const space = controls.spaces.get(spaceId);
    if (space && !space.enabled) return resolved('space_off');
    const preferences = await listPreferences(db, ownerId, spaceId);
    const facts = await listFacts(db, ownerId, spaceId);
    const goal = await db.query<{ goal: string | null; exam_date: string | null }>(
      `SELECT goal, exam_date::text AS exam_date FROM study_spaces WHERE owner_id = $1 AND id = $2`,
      [ownerId, spaceId],
    );
    const row = goal.rows[0];
    const examDate = row?.exam_date ? String(row.exam_date).slice(0, 10) : null;
    return resolved(
      'on',
      selectMemoryContext({
        preferences,
        facts,
        spaceGoal: row ? { goal: row.goal, examDate } : null,
        spaceId,
        summary: await readSpaceSummary(db, ownerId, spaceId),
      }),
    );
  } catch (error) {
    log.warn('memory context unavailable; answering without it', {
      code: (error as { code?: string }).code,
    });
    return resolved('unavailable');
  }
}

/**
 * What an explanation of a wrong question receives (B13): the subject's
 * explanation-style preferences only (no goal, facts or summary), resolved
 * when the student asks for it. Null when Memory is off or nothing is set;
 * never throws.
 */
export async function resolveExplanationPreferences(
  db: Queryable,
  ownerId: string,
  spaceId: string,
): Promise<{ text: string; refs: string[] } | null> {
  if (!isStudyMemoryFlagOn()) return null;
  try {
    const controls = await readMemoryControls(db, ownerId);
    if (!controls.global.enabled || controls.spaces.get(spaceId)?.enabled === false) return null;
    const items = selectClassroomPreferences(await listPreferences(db, ownerId, spaceId), spaceId);
    if (items.length === 0) return null;
    return { text: items.map((item) => item.text).join('\n'), refs: items.map((item) => item.ref) };
  } catch (error) {
    log.warn('explanation preferences unavailable; explaining without them', {
      code: (error as { code?: string }).code,
    });
    return null;
  }
}

/**
 * What a live classroom reply receives (option A of the B06 classroom
 * decision): the explanation-style preferences only, for the subject the
 * course belongs to (`classroomPreferenceScope`). Same per-request,
 * nothing-cached rule as after-class turns; never throws.
 */
export async function resolveClassroomMemoryContext(
  db: Queryable,
  ownerId: string,
  stageId: string,
): Promise<ResolvedMemoryContext> {
  if (!isStudyMemoryFlagOn()) return resolved('unavailable');
  try {
    const controls = await readMemoryControls(db, ownerId);
    if (!controls.global.enabled) return resolved('off');
    const links = await db.query<{ space_id: string }>(
      `SELECT space_id FROM study_space_courses WHERE owner_id = $1 AND stage_id = $2`,
      [ownerId, stageId],
    );
    const scope = classroomPreferenceScope(
      links.rows.map((row) => ({
        spaceId: row.space_id,
        enabled: controls.spaces.get(row.space_id)?.enabled ?? true,
      })),
    );
    if (scope.state === 'space_off') return resolved('space_off');
    const preferences = await listPreferences(db, ownerId, scope.spaceId ?? undefined);
    return resolved(
      'on',
      selectClassroomPreferences(preferences, scope.spaceId),
      renderClassroomPreferenceBlock,
    );
  } catch (error) {
    log.warn('classroom memory unavailable; answering without it', {
      code: (error as { code?: string }).code,
    });
    return resolved('unavailable');
  }
}
