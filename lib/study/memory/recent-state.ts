/**
 * Rule-based recent state (learning plan B06): counts over the last few
 * weeks of learning records. No model call, no inference: it reports what
 * the student did (watched, submitted, asked), never what they mastered.
 *
 * Each result carries the B12 summary basis (watermark + input hash), so a
 * later summary can be regenerated only when the underlying records change.
 */
import {
  MEMORY_LIMITS,
  type LearningEventType,
  type MemorySummaryBasis,
} from '@/lib/study/memory/contracts';

export const RECENT_STATE_POLICY = 'recent-state-rules-v1';

export interface RecentStateRecord {
  seq: number;
  type: LearningEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  stageId: string | null;
  spaceIds: readonly string[];
  classmateId: string | null;
}

export interface RecentState extends MemorySummaryBasis {
  windowDays: number;
  since: string;
  /** Courses with any viewing record in the window. */
  coursesViewed: number;
  /** Courses watched to the end in the window (a viewing record, not mastery). */
  coursesFinished: number;
  /** Furthest page per course viewed in the window. */
  courseProgress: Array<{ stageId: string; furthestPage: number; pageCount: number }>;
  quizzesSubmitted: number;
  quizzesGraded: number;
  /** Server-checked choice questions only. */
  objective: { correct: number; total: number };
  /** Graded quizzes whose score could not be checked on the server. */
  quizzesUnverified: number;
  companionQuestions: number;
  companionByClassmate: Array<{ classmateId: string; count: number }>;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Aggregate the records of one scope (`spaceId` null = all records). The
 * input hash covers the records in the window, so it changes only when the
 * window's records change.
 */
export function aggregateRecentState(
  records: readonly RecentStateRecord[],
  spaceId: string | null,
  now: Date,
  windowDays: number = MEMORY_LIMITS.recentDays,
): RecentState {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const inScope = records
    .filter((record) => (spaceId ? record.spaceIds.includes(spaceId) : true))
    .filter((record) => new Date(record.occurredAt).getTime() >= since.getTime())
    .sort((a, b) => a.seq - b.seq);

  const viewed = new Set<string>();
  const finished = new Set<string>();
  const progress = new Map<string, { furthestPage: number; pageCount: number }>();
  const byClassmate = new Map<string, number>();
  let quizzesSubmitted = 0;
  let quizzesGraded = 0;
  let quizzesUnverified = 0;
  let correct = 0;
  let total = 0;
  let companionQuestions = 0;
  for (const record of inScope) {
    switch (record.type) {
      case 'course_started':
      case 'course_progressed':
      case 'course_finished': {
        if (!record.stageId) break;
        viewed.add(record.stageId);
        if (record.type === 'course_finished') finished.add(record.stageId);
        if (record.type === 'course_progressed') {
          const page = num(record.payload.furthestPage);
          const current = progress.get(record.stageId);
          if (!current || page > current.furthestPage) {
            progress.set(record.stageId, {
              furthestPage: page,
              pageCount: num(record.payload.pageCount),
            });
          }
        }
        break;
      }
      case 'quiz_submitted':
        quizzesSubmitted += 1;
        break;
      case 'quiz_graded': {
        quizzesGraded += 1;
        const objective = record.payload.objective as { correct?: unknown; total?: unknown } | null;
        if (record.payload.verification === 'server_checked' && objective) {
          correct += num(objective.correct);
          total += num(objective.total);
        } else {
          quizzesUnverified += 1;
        }
        break;
      }
      case 'companion_question':
        companionQuestions += 1;
        if (record.classmateId) {
          byClassmate.set(record.classmateId, (byClassmate.get(record.classmateId) ?? 0) + 1);
        }
        break;
      default:
        break;
    }
  }
  const sourceWatermark = inScope.length ? inScope[inScope.length - 1]!.seq : null;
  return {
    spaceId,
    windowDays,
    since: since.toISOString(),
    coursesViewed: viewed.size,
    coursesFinished: finished.size,
    courseProgress: [...progress.entries()].map(([stageId, value]) => ({ stageId, ...value })),
    quizzesSubmitted,
    quizzesGraded,
    objective: { correct, total },
    quizzesUnverified,
    companionQuestions,
    companionByClassmate: [...byClassmate.entries()]
      .map(([classmateId, count]) => ({ classmateId, count }))
      .sort((a, b) => b.count - a.count),
    sourceWatermark,
    inputHash: `${RECENT_STATE_POLICY}:${fnv1a(
      JSON.stringify(inScope.map((record) => [record.seq, record.type])),
    )}`,
    policyVersion: RECENT_STATE_POLICY,
  };
}
