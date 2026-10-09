/**
 * Memory in after-class turns (learning plan B06), through the real
 * prepareCompanionRun on PGlite: every classmate reads the same owner Memory
 * (each keeps its own persona), only this subject's and global items are
 * injected, and turning Memory off — or the feature — removes it from the very
 * next turn, with the turn record saying so.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDocumentSchema } from '@openmaic/storage/document/pg';

vi.mock('@/lib/server/agent-runtime/agent-driver-model', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/agent-driver-model')>();
  return {
    ...actual,
    resolveAgentDriverModel: vi.fn(async () => ({
      binding: { credentialReady: true, modelString: 'platform:zhiyu-default-text' },
      piModel: {},
      wireMaxOutputTokens: undefined,
    })),
  };
});

import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { prepareCompanionRun } from '@/lib/server/agent-runtime/companion-run';
import { getCompanionChat } from '@/lib/server/study/companion/repository';
import { ensureStudySchema } from '@/lib/server/study/schema';

const OWNER = 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let pg: PGlite;

async function run(sessionId: string, ownerId = OWNER) {
  const chat = await getCompanionChat(pg as never, ownerId, sessionId);
  return prepareCompanionRun({
    chat: chat!,
    ownerId,
    sessionId,
    historyMessages: [],
    turnText: '导数是什么？',
    store: async () => {
      throw new Error('no course store in this test');
    },
    db: pg as never,
  });
}

beforeEach(async () => {
  vi.stubEnv('ZHIYU_STUDY_CLASSMATES_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_COMPANION_CHAT_ENABLED', '1');
  vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '1');
  pg = new PGlite();
  await ensureDocumentSchema(pg as never);
  await ensureStageMetaSchema(pg as never);
  await ensureStudySchema(pg as never);
  await pg.query(
    `INSERT INTO study_spaces (id, owner_id, name, subject) VALUES
       ('space-a', $1, '高数', '数学'), ('space-c', $1, '物理', NULL), ('space-b', $2, '英语', NULL)`,
    [OWNER, OTHER],
  );
  for (const [id, ownerId, name] of [
    ['cm-aaaaaaaaaaaaaaaa', OWNER, '小林'],
    ['cm-cccccccccccccccc', OWNER, '小周'],
    ['cm-bbbbbbbbbbbbbbbb', OTHER, '小王'],
  ]) {
    await pg.query(
      `INSERT INTO study_classmates (id, owner_id, name, role, learning_style, speech_policy, avatar, color)
       VALUES ($1, $2, $3, 'student', 'peer', 'active', '/avatars/curious.png', '#10b981')`,
      [id, ownerId, name],
    );
  }
  await pg.query(
    `INSERT INTO study_companion_chats (session_id, owner_id, space_id, classmate_id) VALUES
       ('s-lin', $1, 'space-a', 'cm-aaaaaaaaaaaaaaaa'),
       ('s-zhou', $1, 'space-a', 'cm-cccccccccccccccc'),
       ('s-phys', $1, 'space-c', 'cm-aaaaaaaaaaaaaaaa'),
       ('s-other', $2, 'space-b', 'cm-bbbbbbbbbbbbbbbb')`,
    [OWNER, OTHER],
  );
  await pg.query(
    `INSERT INTO study_learner_preferences (owner_id, space_id, pref_key, value, origin) VALUES
       ($1, NULL, 'example_order', 'example_first', 'settings'),
       ($1, 'space-c', 'explanation_length', 'brief', 'settings')`,
    [OWNER],
  );
  await pg.query(
    `INSERT INTO study_memory_facts (id, owner_id, space_id, text, origin) VALUES
       ('mf-0000000000000001', $1, 'space-a', '我在准备期中考试', 'manual')`,
    [OWNER],
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

describe('Memory in after-class turns', () => {
  it('gives every classmate the same Memory for the subject, each with its own persona', async () => {
    const lin = await run('s-lin');
    const zhou = await run('s-zhou');
    expect(lin.systemPrompt).toContain('你是「小林」');
    expect(zhou.systemPrompt).toContain('你是「小周」');
    for (const prepared of [lin, zhou]) {
      expect(prepared.systemPrompt).toContain('先举一个具体例子');
      expect(prepared.systemPrompt).toContain('我在准备期中考试');
      expect(prepared.systemPrompt).not.toContain('讲解尽量简短');
    }
    expect(lin.turnInfo.memory).toEqual(zhou.turnInfo.memory);
    expect(lin.turnInfo.memory).toMatchObject({
      state: 'on',
      refs: ['pref:example_order@global', 'fact:mf-0000000000000001'],
    });
    // Another subject: its own override, not 高数's fact.
    const physics = await run('s-phys');
    expect(physics.systemPrompt).toContain('讲解尽量简短');
    expect(physics.systemPrompt).not.toContain('期中考试');
    // Another account sees none of it.
    const other = await run('s-other', OTHER);
    expect(other.systemPrompt).not.toContain('先举一个具体例子');
    expect(other.turnInfo.memory?.refs).toEqual([]);
  });

  it('drops Memory from the next turn when it is turned off', async () => {
    await pg.query(`INSERT INTO study_memory_controls (owner_id, enabled) VALUES ($1, false)`, [
      OWNER,
    ]);
    const off = await run('s-lin');
    expect(off.systemPrompt).not.toContain('先举一个具体例子');
    expect(off.systemPrompt).not.toContain('Memory');
    expect(off.turnInfo.memory).toEqual({ state: 'off', refs: [], tokens: 0 });

    await pg.query(`UPDATE study_memory_controls SET enabled = true WHERE owner_id = $1`, [OWNER]);
    await pg.query(
      `INSERT INTO study_memory_controls (owner_id, space_id, enabled) VALUES ($1, 'space-a', false)`,
      [OWNER],
    );
    expect((await run('s-lin')).turnInfo.memory?.state).toBe('space_off');
    expect((await run('s-phys')).turnInfo.memory?.state).toBe('on');

    vi.stubEnv('ZHIYU_STUDY_MEMORY_ENABLED', '');
    const unavailable = await run('s-phys');
    expect(unavailable.turnInfo.memory?.state).toBe('unavailable');
    expect(unavailable.systemPrompt).not.toContain('讲解尽量简短');
  });

  it('answers without Memory when its tables are missing', async () => {
    await pg.query('DROP TABLE study_memory_controls');
    const prepared = await run('s-lin');
    expect(prepared.turnInfo.memory?.state).toBe('unavailable');
    expect(prepared.systemPrompt).toContain('你是「小林」');
  });
});
