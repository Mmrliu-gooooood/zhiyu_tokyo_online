/**
 * The Memory page's data (learning plan B06): switches, preferences, facts,
 * subject goals, learning records and the rule-based recent state. Opening
 * the page first replays the event projection (no model calls), so records
 * a failed inline projection missed appear here.
 */
import type { StudyDb } from '@/lib/server/study/spaces/repository';
import { MEMORY_LIMITS } from '@/lib/study/memory/contracts';
import type { MemoryOverview, MemorySpaceInfo } from '@/lib/study/memory/overview';
import { aggregateRecentState } from '@/lib/study/memory/recent-state';

import { isStudyReviewFlagOn } from '@/lib/server/study/flags';

import { syncLearningEvents } from './projector';
import { readSummaries } from './summary';
import {
  listFacts,
  listLearningRecords,
  listPreferences,
  listSuppressions,
  readMemoryControls,
  setMemoryControl,
} from './repository';

/**
 * Turn the global or one subject's switch on or off. Turning a switch off
 * first records every fact saved so far (classroom quizzes are only caught
 * up on demand): turning it back on records `enabled_since`, and facts from
 * before that are never projected again — only the off period itself should
 * stay unrecorded. The catch-up is best effort: a failure never blocks
 * switching off.
 */
export async function switchMemory(
  db: StudyDb,
  ownerId: string,
  spaceId: string | null,
  enabled: boolean,
  baseRevision?: number,
) {
  if (!enabled) await syncLearningEvents(db, ownerId, { force: true }).catch(() => undefined);
  return setMemoryControl(db, ownerId, spaceId, enabled, baseRevision);
}

export async function readMemoryOverview(
  db: StudyDb,
  ownerId: string,
  now: Date = new Date(),
): Promise<MemoryOverview> {
  const sync = await syncLearningEvents(db, ownerId);
  // One connection for the whole read (pool budget), in a fixed order.
  const read = await db.withTransaction(async (tx) => {
    const controls = await readMemoryControls(tx, ownerId);
    const spaceRows = await tx.query<{
      id: string;
      name: string;
      status: 'active' | 'archived';
      goal: string | null;
      exam_date: string | null;
    }>(
      `SELECT id, name, status, goal, exam_date::text AS exam_date FROM study_spaces
        WHERE owner_id = $1 ORDER BY status, updated_at DESC LIMIT 100`,
      [ownerId],
    );
    const preferences = await listPreferences(tx, ownerId);
    const facts = await listFacts(tx, ownerId);
    const records = await listLearningRecords(tx, ownerId);
    const suppressed = await listSuppressions(tx, ownerId, ['preference', 'suggestion']);
    const since = new Date(now.getTime() - MEMORY_LIMITS.recentDays * 86_400_000).toISOString();
    const recent = await listLearningRecords(tx, ownerId, { since, limit: 2000 });
    const summaries = isStudyReviewFlagOn() ? await readSummaries(tx, ownerId) : [];
    return { controls, spaceRows, preferences, facts, records, suppressed, recent, summaries };
  });
  const { controls, spaceRows, preferences, facts, records, suppressed, recent, summaries } = read;
  const stateRecords = recent.map((record) => ({
    seq: record.seq,
    type: record.type,
    occurredAt: record.occurredAt,
    payload: record.payload,
    stageId: record.course?.stageId ?? null,
    spaceIds: record.spaceIds,
    classmateId: record.classmate?.id ?? null,
  }));
  const spaces: MemorySpaceInfo[] = spaceRows.rows.map((row) => ({
    spaceId: row.id,
    name: row.name,
    status: row.status,
    goal: row.goal,
    examDate: row.exam_date ? String(row.exam_date).slice(0, 10) : null,
  }));
  const courses: Record<string, string> = {};
  const classmates: Record<string, string> = {};
  for (const record of [...recent, ...records]) {
    if (record.course) courses[record.course.stageId] = record.course.title;
    if (record.classmate) classmates[record.classmate.id] = record.classmate.name;
  }
  return {
    controls: {
      global: controls.global,
      spaces: spaces.map((space) => ({
        spaceId: space.spaceId,
        name: space.name,
        status: space.status,
        ...(controls.spaces.get(space.spaceId) ?? {
          enabled: true,
          revision: 0,
          enabledSince: null,
          updatedAt: null,
        }),
      })),
    },
    spaces,
    preferences,
    facts,
    records,
    recentState: {
      all: aggregateRecentState(stateRecords, null, now),
      spaces: spaces
        .filter((space) => space.status === 'active')
        .map((space) => aggregateRecentState(stateRecords, space.spaceId, now)),
    },
    names: { courses, classmates },
    suppressedSuggestions: [...new Set(suppressed.map((item) => item.key))],
    sync,
    summaries,
  };
}
