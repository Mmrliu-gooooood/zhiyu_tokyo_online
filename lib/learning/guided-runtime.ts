import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import {
  RuntimeAppendConflictError,
  type RuntimePayloadValidator,
  type RuntimeStore,
} from '@openmaic/storage';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import {
  parseGuidedLearningOutcome,
  type GuidedLearningOutcome,
  type GuidedSource,
} from './guided-contracts';

export interface LearningDialogueIdentity {
  requestId: string;
  chatSessionId: string;
  stageId: string;
  contentRevision: string;
  scopedRevision: string;
  source: GuidedSource;
  evidenceRefs: string[];
}

export interface LearningDialoguePayloadV1 {
  payloadVersion: 1;
  identity: LearningDialogueIdentity;
  event:
    | { kind: 'student_input'; input: string; createdAt: string }
    | { kind: 'published_outcome'; outcome: GuidedLearningOutcome; createdAt: string };
}

export interface LearningDialogueRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

export interface StoredLearningDialogueFact {
  session: RuntimeSession;
  seq: number;
  payload: LearningDialoguePayloadV1;
}

const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validSource(value: unknown): value is GuidedSource {
  if (!isRecord(value) || !nonempty(value.kind, 32)) return false;
  if (value.kind === 'scene') {
    return onlyKeys(value, ['kind', 'sceneId']) && nonempty(value.sceneId, 256);
  }
  return (
    (value.kind === 'learning_attempt' || value.kind === 'quiz_attempt') &&
    onlyKeys(value, ['kind', 'attemptId', 'questionId']) &&
    nonempty(value.attemptId, 256) &&
    nonempty(value.questionId, 256)
  );
}

export function isLearningDialoguePayloadV1(value: unknown): value is LearningDialoguePayloadV1 {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ['payloadVersion', 'identity', 'event']) ||
    value.payloadVersion !== 1 ||
    !isRecord(value.identity) ||
    !onlyKeys(value.identity, [
      'requestId',
      'chatSessionId',
      'stageId',
      'contentRevision',
      'scopedRevision',
      'source',
      'evidenceRefs',
    ]) ||
    !nonempty(value.identity.requestId, 256) ||
    !nonempty(value.identity.chatSessionId, 256) ||
    !nonempty(value.identity.stageId, 256) ||
    !nonempty(value.identity.contentRevision, 512) ||
    !nonempty(value.identity.scopedRevision, 512) ||
    !validSource(value.identity.source) ||
    !Array.isArray(value.identity.evidenceRefs) ||
    value.identity.evidenceRefs.length > 12 ||
    !value.identity.evidenceRefs.every((ref) => nonempty(ref, 512)) ||
    !isRecord(value.event) ||
    !nonempty(value.event.kind, 32) ||
    !nonempty(value.event.createdAt, 64)
  ) {
    return false;
  }
  if (value.event.kind === 'student_input') {
    return (
      onlyKeys(value.event, ['kind', 'input', 'createdAt']) && nonempty(value.event.input, 4_000)
    );
  }
  if (value.event.kind === 'published_outcome') {
    if (!onlyKeys(value.event, ['kind', 'outcome', 'createdAt'])) return false;
    try {
      const outcome = parseGuidedLearningOutcome(
        value.event.outcome,
        new Set(value.identity.evidenceRefs as string[]),
      );
      return outcome.requestId === value.identity.requestId;
    } catch {
      return false;
    }
  }
  return false;
}

export const learningDialogueRuntimePayloadValidator: RuntimePayloadValidator = (payload) =>
  isLearningDialoguePayloadV1(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [{ path: '/payload', message: 'learningDialogue payload must match version 1' }],
      };

function sessionId(chatSessionId: string): string {
  return `learning-dialogue:${chatSessionId}`;
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `learning-dialogue-record:${suffix}`;
}

function asPayload(record: RuntimeRecord): LearningDialoguePayloadV1 | undefined {
  return isLearningDialoguePayloadV1(record.payload) ? record.payload : undefined;
}

function enqueue<T>(store: RuntimeStore, id: string, work: () => Promise<T>): Promise<T> {
  let storeQueues = queues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    queues.set(store, storeQueues);
  }
  const prior = storeQueues.get(id) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(id, settled);
  void settled.finally(() => {
    if (storeQueues.get(id) === settled) storeQueues.delete(id);
  });
  return current;
}

async function withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`maic:learning-dialogue:${id}`, work);
  }
  return work();
}

export async function appendLearningDialogueFact(
  payload: LearningDialoguePayloadV1,
  deps: LearningDialogueRuntimeDeps = {},
): Promise<void> {
  if (!isLearningDialoguePayloadV1(payload)) throw new Error('Invalid learning dialogue payload');
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;
  const id = sessionId(payload.identity.chatSessionId);

  return enqueue(store, id, () =>
    withLock(id, async () => {
      for (;;) {
        const timestamp = now();
        let session = await store.getSession(id);
        if (!session) {
          try {
            session = await store.createSession({
              id,
              kind: 'learningDialogue',
              stageId: payload.identity.stageId,
              learnerKey,
              status: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          } catch (error) {
            session = await store.getSession(id);
            if (!session) throw error;
          }
        }
        if (
          session.kind !== 'learningDialogue' ||
          session.stageId !== payload.identity.stageId ||
          session.learnerKey !== learnerKey
        ) {
          throw new Error('Learning dialogue is outside its runtime partition');
        }
        if (session.status !== 'active') throw new Error('Learning dialogue is completed');
        const records = await store.listRecords(id);
        const last = records.at(-1);
        const duplicate = records.map(asPayload).find((existing) => {
          return (
            existing?.identity.requestId === payload.identity.requestId &&
            existing.event.kind === payload.event.kind
          );
        });
        if (duplicate) {
          const sameIdentity = canonical(duplicate.identity) === canonical(payload.identity);
          const sameEvent =
            duplicate.event.kind === 'student_input' && payload.event.kind === 'student_input'
              ? duplicate.event.input === payload.event.input
              : duplicate.event.kind === 'published_outcome' &&
                payload.event.kind === 'published_outcome' &&
                canonical(duplicate.event.outcome) === canonical(payload.event.outcome);
          if (!sameIdentity || !sameEvent) {
            throw new Error(
              'Guided request identity already belongs to different dialogue evidence',
            );
          }
          return;
        }
        try {
          await store.appendRecord(
            {
              id: mintRecordId(),
              sessionId: id,
              createdAt: timestamp,
              payload,
            },
            { expectedLastSeq: last?.seq ?? null },
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

export async function listLearningDialogueFacts(
  stageId: string,
  chatSessionId: string,
  deps: Pick<LearningDialogueRuntimeDeps, 'store' | 'learnerKey'> = {},
): Promise<StoredLearningDialogueFact[]> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const id = sessionId(chatSessionId);
  const session = await store.getSession(id);
  if (
    !session ||
    session.kind !== 'learningDialogue' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    return [];
  }
  const records = await store.listRecords(id);
  return records.flatMap((record) => {
    const payload = asPayload(record);
    return payload ? [{ session, seq: record.seq, payload }] : [];
  });
}
