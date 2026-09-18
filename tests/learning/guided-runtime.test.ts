import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@openmaic/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendLearningDialogueFact,
  learningDialogueRuntimePayloadValidator,
  listLearningDialogueFacts,
} from '@/lib/learning/guided-runtime';

const databases = new Set<string>();

function store(name: string) {
  databases.add(name);
  return new BrowserRuntimeStore({
    dbName: name,
    payloadValidators: { learningDialogue: learningDialogueRuntimePayloadValidator },
  });
}

afterEach(async () => {
  await Promise.all(
    [...databases].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => resolve();
        }),
    ),
  );
  databases.clear();
});

const identity = {
  requestId: 'request-1',
  chatSessionId: 'chat-1',
  stageId: 'stage-1',
  contentRevision: 'content-7',
  scopedRevision: 'scene-2:sha256:abc',
  source: { kind: 'scene' as const, sceneId: 'scene-2' },
  evidenceRefs: ['scene#body'],
};

describe('learning dialogue runtime', () => {
  it('appends the real student input before the public outcome using tail CAS', async () => {
    const runtime = store(`guided-${crypto.randomUUID()}`);
    const deps = {
      store: runtime,
      learnerKey: 'learner-1',
      now: () => '2026-09-14T00:00:00.000Z',
      mintRecordId: (() => {
        let id = 0;
        return () => `record-${++id}`;
      })(),
    };

    await appendLearningDialogueFact(
      {
        payloadVersion: 1,
        identity,
        event: { kind: 'student_input', input: 'In glucose.', createdAt: deps.now() },
      },
      deps,
    );
    await appendLearningDialogueFact(
      {
        payloadVersion: 1,
        identity,
        event: {
          kind: 'published_outcome',
          createdAt: deps.now(),
          outcome: {
            schemaVersion: 1,
            requestId: 'request-1',
            phase: 'feedback',
            published: {
              explanation: 'Yes. Glucose stores the captured energy.',
              reviewNote: 'Limited to the supplied evidence.',
            },
            review: { verdict: 'no_issue_found', evidenceRefs: [] },
            budget: { callsUsed: 1, callLimit: 1, stopReason: 'completed' },
            usage: { status: 'unknown' },
          },
        },
      },
      deps,
    );

    const facts = await listLearningDialogueFacts('stage-1', 'chat-1', {
      store: runtime,
      learnerKey: 'learner-1',
    });
    expect(facts.map((fact) => fact.payload.event.kind)).toEqual([
      'student_input',
      'published_outcome',
    ]);
    expect(facts[0].payload.event).toMatchObject({ input: 'In glucose.' });
    expect(JSON.stringify(facts)).not.toContain('reasoning');
  });

  it('keeps dialogues partitioned by stage, learner, and chat session', async () => {
    const runtime = store(`guided-${crypto.randomUUID()}`);
    await appendLearningDialogueFact(
      {
        payloadVersion: 1,
        identity,
        event: {
          kind: 'student_input',
          input: 'My answer',
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      },
      { store: runtime, learnerKey: 'learner-1' },
    );

    expect(
      await listLearningDialogueFacts('stage-1', 'another-chat', {
        store: runtime,
        learnerKey: 'learner-1',
      }),
    ).toEqual([]);
    expect(
      await listLearningDialogueFacts('stage-1', 'chat-1', {
        store: runtime,
        learnerKey: 'another-learner',
      }),
    ).toEqual([]);
  });

  it('rejects a different real input that reuses an existing request identity', async () => {
    const runtime = store(`guided-${crypto.randomUUID()}`);
    const deps = { store: runtime, learnerKey: 'learner-1' };
    await appendLearningDialogueFact(
      {
        payloadVersion: 1,
        identity,
        event: {
          kind: 'student_input',
          input: 'First real input',
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      },
      deps,
    );

    await expect(
      appendLearningDialogueFact(
        {
          payloadVersion: 1,
          identity,
          event: {
            kind: 'student_input',
            input: 'Different real input',
            createdAt: '2026-09-14T00:00:01.000Z',
          },
        },
        deps,
      ),
    ).rejects.toThrow('request identity already belongs to different dialogue evidence');
  });
});
