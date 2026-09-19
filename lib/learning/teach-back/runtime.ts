import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import {
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import {
  projectTeachBackActivity,
  type TeachBackProjectedActivity,
} from './activity';
import {
  canonicalJson,
  parseTeachBackRecordPayload,
  type TeachBackAppendStatus,
  type TeachBackEvent,
  type TeachBackRecordPayloadV1,
} from './contracts';

export interface TeachBackRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

export interface TeachBackAppendResult {
  status: TeachBackAppendStatus;
  seq: number;
  activity: TeachBackProjectedActivity;
  session: RuntimeSession;
}

const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();

export function teachBackSessionId(activityId: string): string {
  return `teach-back:${activityId}`;
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `teach-back-record:${suffix}`;
}

function asPayload(record: RuntimeRecord): TeachBackRecordPayloadV1 | undefined {
  try {
    return parseTeachBackRecordPayload(record.payload);
  } catch {
    return undefined;
  }
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
    return navigator.locks.request(`maic:teach-back:${id}`, work);
  }
  return work();
}

export async function readTeachBackActivity(
  activityId: string,
  deps: TeachBackRuntimeDeps = {},
): Promise<{ session?: RuntimeSession; activity: TeachBackProjectedActivity }> {
  const store = deps.store ?? getRuntimeStore();
  const id = teachBackSessionId(activityId);
  const session = await store.getSession(id);
  if (!session) {
    return {
      activity: projectTeachBackActivity(activityId, []),
    };
  }
  const records = await store.listRecords(id);
  return {
    session,
    activity: projectTeachBackActivity(
      activityId,
      records.flatMap((record) => {
        const payload = asPayload(record);
        return payload ? [{ seq: record.seq, payload }] : [];
      }),
    ),
  };
}

export async function listTeachBackActivities(
  stageId: string,
  deps: TeachBackRuntimeDeps = {},
): Promise<TeachBackProjectedActivity[]> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const sessions = await store.listSessions(stageId, learnerKey);
  const activities: TeachBackProjectedActivity[] = [];
  for (const session of sessions) {
    if (session.kind !== 'teachBack') continue;
    const records = await store.listRecords(session.id);
    const payloads = records.flatMap((record) => {
      const payload = asPayload(record);
      return payload ? [{ seq: record.seq, payload }] : [];
    });
    const activityId = payloads[0]?.payload.activityId ?? session.id.replace(/^teach-back:/, '');
    const activity = projectTeachBackActivity(activityId, payloads);
    if (activity.hasStarted) activities.push(activity);
  }
  return activities.sort((left, right) => left.lastSeq - right.lastSeq);
}

export async function appendTeachBackEvent(
  input: {
    activityId: string;
    commandId: string;
    event: TeachBackEvent;
    stageId: string;
    expectedLastSeq: number | null;
    finishSession?: boolean;
  },
  deps: TeachBackRuntimeDeps = {},
): Promise<TeachBackAppendResult> {
  const payload: TeachBackRecordPayloadV1 = {
    payloadVersion: 1,
    activityId: input.activityId,
    commandId: input.commandId,
    event: input.event,
  };
  parseTeachBackRecordPayload(payload);

  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;
  const id = teachBackSessionId(input.activityId);

  return enqueue(store, id, () =>
    withLock(id, async () => {
      const timestamp = now();
      let session = await store.getSession(id);
      if (!session) {
        try {
          session = await store.createSession({
            id,
            kind: 'teachBack',
            stageId: input.stageId,
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
        session.kind !== 'teachBack' ||
        session.stageId !== input.stageId ||
        session.learnerKey !== learnerKey
      ) {
        throw new Error('Teach-back is outside its runtime partition');
      }
      if (session.status !== 'active') {
        const records = await store.listRecords(id);
        const activity = projectTeachBackActivity(
          input.activityId,
          records.flatMap((record) => {
            const existing = asPayload(record);
            return existing ? [{ seq: record.seq, payload: existing }] : [];
          }),
        );
        return {
          status: 'conflict' as const,
          seq: activity.lastSeq,
          activity,
          session,
        };
      }

      const records = await store.listRecords(id);
      const last = records.at(-1);
      const actualLastSeq = last?.seq ?? null;
      const duplicate = records
        .map((record) => ({ record, payload: asPayload(record) }))
        .find((item) => item.payload?.commandId === input.commandId);
      if (duplicate?.payload) {
        const same = canonicalJson(duplicate.payload) === canonicalJson(payload);
        const activity = projectTeachBackActivity(
          input.activityId,
          records.flatMap((record) => {
            const existing = asPayload(record);
            return existing ? [{ seq: record.seq, payload: existing }] : [];
          }),
        );
        return {
          status: same ? ('replayed' as const) : ('conflict' as const),
          seq: duplicate.record.seq,
          activity,
          session,
        };
      }

      if (input.expectedLastSeq !== actualLastSeq) {
        const activity = projectTeachBackActivity(
          input.activityId,
          records.flatMap((record) => {
            const existing = asPayload(record);
            return existing ? [{ seq: record.seq, payload: existing }] : [];
          }),
        );
        return { status: 'conflict', seq: activity.lastSeq, activity, session };
      }

      try {
        const appended = await store.appendRecord(
          {
            id: mintRecordId(),
            sessionId: id,
            createdAt: timestamp,
            payload,
          },
          {
            expectedLastSeq: input.expectedLastSeq,
            ...(input.finishSession
              ? { sessionTransition: { status: 'completed' as const, updatedAt: timestamp } }
              : {}),
          },
        );
        const nextRecords = [...records, appended];
        const activity = projectTeachBackActivity(
          input.activityId,
          nextRecords.flatMap((record) => {
            const existing = asPayload(record);
            return existing ? [{ seq: record.seq, payload: existing }] : [];
          }),
        );
        const nextSession = input.finishSession
          ? ((await store.getSession(id)) ?? session)
          : session;
        return { status: 'applied', seq: appended.seq, activity, session: nextSession };
      } catch (error) {
        if (error instanceof RuntimeAppendConflictError) {
          const latest = await store.listRecords(id);
          const activity = projectTeachBackActivity(
            input.activityId,
            latest.flatMap((record) => {
              const existing = asPayload(record);
              return existing ? [{ seq: record.seq, payload: existing }] : [];
            }),
          );
          return {
            status: 'conflict',
            seq: activity.lastSeq,
            activity,
            session: (await store.getSession(id)) ?? session,
          };
        }
        throw error;
      }
    }),
  );
}
