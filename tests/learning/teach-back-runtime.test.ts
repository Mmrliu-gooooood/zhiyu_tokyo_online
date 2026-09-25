import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@openmaic/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { teachBackRuntimePayloadValidator } from '@/lib/learning/teach-back/contracts';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  appendTeachBackEvent,
  listTeachBackActivities,
  readTeachBackActivity,
} from '@/lib/learning/teach-back/runtime';
import type { TeachBackSource } from '@/lib/learning/teach-back/contracts';

const databases = new Set<string>();

function store(name: string) {
  databases.add(name);
  return new BrowserRuntimeStore({
    dbName: name,
    payloadValidators: { teachBack: teachBackRuntimePayloadValidator },
  });
}

const source: TeachBackSource = {
  stageId: 'stage-1',
  sceneId: 'scene-1',
  sceneType: 'slide',
  title: 'Forces',
  courseTitle: 'Physics',
  snapshotAlgorithmVersion: 'learning-content-v1',
  sourceRevision: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  fragments: [
    {
      id: 'scene:scene-1',
      digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      text: "A net force changes an object's velocity.",
    },
  ],
  coverageLimited: false,
};

const peer = {
  id: 'default-2',
  name: 'Zhiwei',
  role: 'assistant',
  persona: 'helper',
  avatar: '/avatars/assist.png',
  color: '#10b981',
};

afterEach(async () => {
  for (const name of databases) {
    indexedDB.deleteDatabase(name);
  }
  databases.clear();
});

describe('teach-back runtime store', () => {
  it('overlaps history reads within four requests and preserves tied history order', async () => {
    const backing = store('tb-history-bounded');
    for (let index = 0; index < 7; index++) {
      await appendTeachBackEvent(
        {
          activityId: `history-${index}`,
          commandId: 'prepared',
          stageId: source.stageId,
          expectedLastSeq: null,
          event: {
            kind: 'activity_prepared',
            createdAt: '2026-09-19T00:00:00.000Z',
            source,
            plan: {
              topic: `Forces ${index}`,
              peer,
              criteria: [
                {
                  criterionId: 'c1',
                  description: 'Force',
                  quote: 'A net force',
                  fragmentId: 'scene:scene-1',
                },
              ],
              openingQuestion: {
                questionId: 'q1',
                text: 'What changes velocity?',
                criterionId: 'c1',
              },
            },
          },
        },
        { store: backing, learnerKey: 'learner-1' },
      );
    }
    const expected = (await backing.listSessions(source.stageId, 'learner-1')).map((session) =>
      session.id.replace(/^teach-back:/, ''),
    );
    const read = backing.listRecords.bind(backing);
    let active = 0;
    let peak = 0;
    vi.spyOn(backing, 'listRecords').mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await read(...args);
      } finally {
        active--;
      }
    });
    const activities = await listTeachBackActivities(source.stageId, {
      store: backing,
      learnerKey: 'learner-1',
    });
    expect(peak).toBe(4);
    expect(activities.map((activity) => activity.activityId)).toEqual(expected);
    expect(activities.every((activity) => activity.logicalPhase === 'awaiting_explanation')).toBe(
      true,
    );
  });

  it('replays the same commandId without creating a second explanation', async () => {
    const backing = store('tb-runtime-1');
    const first = await appendTeachBackEvent(
      {
        activityId: 'act-1',
        commandId: 'explain:turn-1',
        stageId: 'stage-1',
        expectedLastSeq: null,
        event: {
          kind: 'explanation_submitted',
          createdAt: '2026-09-19T00:00:00.000Z',
          explanation: {
            turnId: 'turn-1',
            turnIndex: 1,
            text: 'Force changes speed.',
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          },
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    expect(first.status).toBe('applied');
    const replayed = await appendTeachBackEvent(
      {
        activityId: 'act-1',
        commandId: 'explain:turn-1',
        stageId: 'stage-1',
        expectedLastSeq: first.seq,
        event: {
          kind: 'explanation_submitted',
          createdAt: '2026-09-19T00:00:00.000Z',
          explanation: {
            turnId: 'turn-1',
            turnIndex: 1,
            text: 'Force changes speed.',
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          },
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    expect(replayed.status).toBe('replayed');
    expect(replayed.activity.explanations).toHaveLength(1);
  });

  it('rejects a conflicting payload for the same commandId and rejects appends after finish', async () => {
    const backing = store('tb-runtime-2');
    await appendTeachBackEvent(
      {
        activityId: 'act-2',
        commandId: 'explain:turn-1',
        stageId: 'stage-1',
        expectedLastSeq: null,
        event: {
          kind: 'explanation_submitted',
          createdAt: '2026-09-19T00:00:00.000Z',
          explanation: {
            turnId: 'turn-1',
            turnIndex: 1,
            text: 'Force changes speed.',
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          },
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    const conflict = await appendTeachBackEvent(
      {
        activityId: 'act-2',
        commandId: 'explain:turn-1',
        stageId: 'stage-1',
        expectedLastSeq: 0,
        event: {
          kind: 'explanation_submitted',
          createdAt: '2026-09-19T00:00:00.000Z',
          explanation: {
            turnId: 'turn-1',
            turnIndex: 1,
            text: 'A different explanation.',
            submittedAt: '2026-09-19T00:00:00.000Z',
            questionId: 'question-open',
          },
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    expect(conflict.status).toBe('conflict');

    const finished = await appendTeachBackEvent(
      {
        activityId: 'act-2',
        commandId: 'finish:1',
        stageId: 'stage-1',
        expectedLastSeq: 0,
        finishSession: true,
        event: {
          kind: 'activity_finished',
          createdAt: '2026-09-19T00:00:01.000Z',
          reason: 'manual_stop',
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    expect(finished.status).toBe('applied');
    const late = await appendTeachBackEvent(
      {
        activityId: 'act-2',
        commandId: 'explain:turn-2',
        stageId: 'stage-1',
        expectedLastSeq: finished.seq,
        event: {
          kind: 'explanation_submitted',
          createdAt: '2026-09-19T00:00:02.000Z',
          explanation: {
            turnId: 'turn-2',
            turnIndex: 2,
            text: 'Late explanation',
            submittedAt: '2026-09-19T00:00:02.000Z',
            questionId: 'question-open',
          },
        },
      },
      { store: backing, learnerKey: 'learner-1' },
    );
    expect(late.status).toBe('conflict');
    const read = await readTeachBackActivity('act-2', { store: backing, learnerKey: 'learner-1' });
    expect(read.activity.phase).toBe('finished');
    expect(read.activity.explanations).toHaveLength(1);
  });

  it('keeps existing validators when teachBack is added', () => {
    expect(Object.keys(APP_RUNTIME_PAYLOAD_VALIDATORS)).toEqual([
      'chat',
      'learningCheck',
      'learningDialogue',
      'quizAttempt',
      'whiteboard',
      'teachBack',
    ]);
  });
});
