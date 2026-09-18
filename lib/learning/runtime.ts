import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import {
  isLearningCheckPayloadV1,
  type LearningCheckPayloadV1,
  type LearningCheckPhase,
} from './contracts';

export interface LearningRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

export interface StoredLearningCheckAttempt {
  sessionId: string;
  status: RuntimeSession['status'];
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  payload: LearningCheckPayloadV1;
}

export class LearningCheckImmutableEvidenceError extends Error {
  constructor(attemptId: string) {
    super(`Learning check ${JSON.stringify(attemptId)} cannot replace its source or question set`);
    this.name = 'LearningCheckImmutableEvidenceError';
  }
}

export class LearningCheckAnswersChangedError extends Error {
  constructor(attemptId: string) {
    super(`Submitted answers for learning check ${JSON.stringify(attemptId)} cannot be changed`);
    this.name = 'LearningCheckAnswersChangedError';
  }
}

export class LearningCheckIncompleteReviewError extends Error {
  constructor(attemptId: string) {
    super(
      `Learning check ${JSON.stringify(attemptId)} cannot be reviewed before every grade exists`,
    );
    this.name = 'LearningCheckIncompleteReviewError';
  }
}

export class LearningCheckGradeConflictError extends Error {
  constructor(attemptId: string, questionId: string) {
    super(
      `Learning check ${JSON.stringify(attemptId)} already has a different grade for ${JSON.stringify(questionId)}`,
    );
    this.name = 'LearningCheckGradeConflictError';
  }
}

const phaseOrder: Record<LearningCheckPhase, number> = { draft: 0, submitted: 1, reviewed: 2 };
const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${stable(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `learning-check-record:${suffix}`;
}

function asPayload(record: RuntimeRecord | undefined): LearningCheckPayloadV1 | undefined {
  return record && isLearningCheckPayloadV1(record.payload) ? record.payload : undefined;
}

function assertPartition(
  session: RuntimeSession,
  stageId: string,
  learnerKey: string,
  attemptId: string,
): void {
  if (
    session.kind !== 'learningCheck' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey ||
    session.id !== attemptId
  ) {
    throw new Error(`Learning check ${JSON.stringify(attemptId)} is outside its runtime partition`);
  }
}

function immutableEvidence(payload: LearningCheckPayloadV1): string {
  return stable({
    identity: payload.identity,
    source: payload.source,
    questionSet: payload.questionSet,
    generation: payload.generation,
  });
}

function mergeConcurrentGrading(
  last: LearningCheckPayloadV1,
  incoming: LearningCheckPayloadV1,
): LearningCheckPayloadV1 {
  if (last.lifecycle.phase === 'draft' || incoming.lifecycle.phase === 'draft') return incoming;
  const grading = { ...incoming.lifecycle.grading };
  for (const question of incoming.questionSet.questions) {
    const prior = last.lifecycle.grading[question.id];
    const next = incoming.lifecycle.grading[question.id];
    if (prior?.status === 'graded' && next?.status === 'graded' && stable(prior) !== stable(next)) {
      throw new LearningCheckGradeConflictError(incoming.identity.attemptId, question.id);
    }
    if (prior?.status === 'graded' || (prior && next?.status !== 'graded')) {
      grading[question.id] = prior;
    }
  }
  return {
    ...incoming,
    lifecycle: {
      ...incoming.lifecycle,
      grading,
      submittedAt: last.lifecycle.submittedAt,
    },
  };
}

function enqueue<T>(store: RuntimeStore, attemptId: string, work: () => Promise<T>): Promise<T> {
  let storeQueues = queues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    queues.set(store, storeQueues);
  }
  const prior = storeQueues.get(attemptId) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(attemptId, settled);
  void settled.finally(() => {
    if (storeQueues.get(attemptId) === settled) storeQueues.delete(attemptId);
  });
  return current;
}

async function withLock<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`maic:learning-check:${attemptId}`, work);
  }
  return work();
}

async function dependencies(deps: LearningRuntimeDeps) {
  return {
    store: deps.store ?? getRuntimeStore(),
    learnerKey: deps.learnerKey ?? (await getLearnerKey()),
    now: deps.now ?? (() => new Date().toISOString()),
    mintRecordId: deps.mintRecordId ?? mintId,
  };
}

/** Save the generated immutable question set as a draft before the UI reveals it. */
export async function saveLearningCheckQuestionSet(
  stageId: string,
  payload: LearningCheckPayloadV1,
  deps: LearningRuntimeDeps = {},
): Promise<void> {
  if (payload.lifecycle.phase !== 'draft' || !isLearningCheckPayloadV1(payload)) {
    throw new Error('A generated learning check must first be saved as a valid draft');
  }
  return recordLearningCheckPhase(stageId, payload, deps);
}

/** Append one lifecycle fact using tail CAS; reviewed is completed atomically. */
export async function recordLearningCheckPhase(
  stageId: string,
  payload: LearningCheckPayloadV1,
  deps: LearningRuntimeDeps = {},
): Promise<void> {
  if (
    payload.lifecycle.phase === 'reviewed' &&
    payload.questionSet.questions.some(
      (question) => payload.lifecycle.grading[question.id]?.status !== 'graded',
    )
  ) {
    throw new LearningCheckIncompleteReviewError(payload.identity.attemptId);
  }
  if (!isLearningCheckPayloadV1(payload)) throw new Error('Invalid learning check payload');
  const resolved = await dependencies(deps);
  const { store, learnerKey, now, mintRecordId } = resolved;
  const attemptId = payload.identity.attemptId;
  let candidate = payload;

  return enqueue(store, attemptId, () =>
    withLock(attemptId, async () => {
      while (true) {
        const timestamp = now();
        let session = await store.getSession(attemptId);
        if (!session) {
          try {
            session = await store.createSession({
              id: attemptId,
              kind: 'learningCheck',
              stageId,
              learnerKey,
              status: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          } catch (error) {
            session = await store.getSession(attemptId);
            if (!session) throw error;
          }
        }
        assertPartition(session, stageId, learnerKey, attemptId);
        const records = await store.listRecords(attemptId);
        const lastRecord = records.at(-1);
        const last = asPayload(lastRecord);
        if (last && immutableEvidence(last) !== immutableEvidence(candidate)) {
          throw new LearningCheckImmutableEvidenceError(attemptId);
        }
        if (
          last &&
          phaseOrder[last.lifecycle.phase] >= phaseOrder.submitted &&
          stable(last.lifecycle.answers) !== stable(candidate.lifecycle.answers)
        ) {
          throw new LearningCheckAnswersChangedError(attemptId);
        }
        if (last && phaseOrder[candidate.lifecycle.phase] < phaseOrder[last.lifecycle.phase])
          return;
        if (last) candidate = mergeConcurrentGrading(last, candidate);
        if (last && stable(last) === stable(candidate)) {
          if (candidate.lifecycle.phase === 'reviewed' && session.status === 'active') {
            try {
              await store.setSessionStatus(attemptId, 'completed', timestamp, {
                expectedLastSeq: lastRecord!.seq,
              });
            } catch (error) {
              if (error instanceof RuntimeAppendConflictError) continue;
              throw error;
            }
          }
          return;
        }
        if (session.status !== 'active') {
          throw new Error(`Learning check ${JSON.stringify(attemptId)} is already completed`);
        }
        try {
          await store.appendRecord(
            {
              id: mintRecordId(),
              sessionId: attemptId,
              createdAt: timestamp,
              payload: candidate,
            },
            {
              expectedLastSeq: lastRecord?.seq ?? null,
              ...(candidate.lifecycle.phase === 'reviewed'
                ? { sessionTransition: { status: 'completed' as const, updatedAt: timestamp } }
                : {}),
            },
          );
          return;
        } catch (error) {
          if (error instanceof RuntimeAppendConflictError) continue;
          throw error;
        }
      }
    }),
  );
}

/** Fold every session in the learner/stage partition; history is never latest-only. */
export async function listLearningCheckAttempts(
  stageId: string,
  deps: Pick<LearningRuntimeDeps, 'store' | 'learnerKey'> = {},
): Promise<StoredLearningCheckAttempt[]> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const sessions = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === 'learningCheck',
  );
  const attempts = await Promise.all(
    sessions.map(async (session): Promise<StoredLearningCheckAttempt | undefined> => {
      const records = await store.listRecords(session.id);
      const lastRecord = records.at(-1);
      const payload = asPayload(lastRecord);
      if (!lastRecord || !payload) return undefined;
      return {
        sessionId: session.id,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastSeq: lastRecord.seq,
        payload,
      };
    }),
  );
  return attempts.filter((attempt): attempt is StoredLearningCheckAttempt => Boolean(attempt));
}
