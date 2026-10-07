/**
 * Classmates (learning plan B04): input validation, the snapshot id that ties
 * a classroom agent to one template revision, the persona a classroom
 * stores, the roster frozen for a new classroom, and the speaking rules both
 * chat directors apply.
 */
import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  CLASSMATE_LIMITS,
  classmateAvatarPath,
  classmateRosterConfig,
  classmateStageAgentId,
  classmateVoiceBinding,
  composeClassmatePersona,
  parseClassmateInput,
  parseClassmatePatch,
  parseClassmateSnapshot,
  parseClassmateStageAgentId,
  uploadedAvatarId,
  type ClassmateSnapshot,
} from '@/lib/study/classmates/contracts';
import { buildClassmateRoster, rosterAgentId } from '@/lib/study/classmates/roster';
import { lastUserText, planClassmateSpeech } from '@/lib/study/classmates/speech';

const ID = 'cm-0123456789abcdef';

const input = {
  name: '  小林  ',
  role: 'student',
  persona: '耐心，喜欢用生活中的例子。',
  learningStyle: 'socratic',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10B981',
  voice: { source: 'user', providerId: 'qwen-tts', voiceId: 'Cherry' },
  materialIds: ['mat-1', 'mat-1', 'mat-2'],
};

const snapshot: ClassmateSnapshot = {
  name: '小林',
  role: 'student',
  persona: '耐心，喜欢用生活中的例子。',
  learningStyle: 'socratic',
  speechPolicy: 'on_demand',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: null,
};

describe('classmate input', () => {
  it('trims, normalises the colour and de-duplicates materials', () => {
    const parsed = parseClassmateInput(input);
    expect(parsed).toEqual({
      ok: true,
      value: {
        ...input,
        name: '小林',
        color: '#10b981',
        materialIds: ['mat-1', 'mat-2'],
        // B05: absent policy means inherit.
        modelPolicy: { mode: 'inherit' },
      },
    });
  });

  it('rejects a teacher role, an unknown avatar, platform voices without a default and long names', () => {
    expect(parseClassmateInput({ ...input, role: 'teacher' })).toEqual({
      ok: false,
      field: 'role',
    });
    expect(parseClassmateInput({ ...input, avatar: 'https://example.com/a.png' })).toEqual({
      ok: false,
      field: 'avatar',
    });
    expect(
      parseClassmateInput({
        ...input,
        voice: { source: 'platform', providerId: 'x', voiceId: 'y' },
      }),
    ).toEqual({ ok: false, field: 'voice' });
    expect(parseClassmateInput({ ...input, name: '林'.repeat(CLASSMATE_LIMITS.name + 1) })).toEqual(
      { ok: false, field: 'name' },
    );
    expect(parseClassmateInput({ ...input, name: '   ' })).toEqual({ ok: false, field: 'name' });
  });

  it('accepts only uploaded-avatar paths of the expected form', () => {
    const avatar = classmateAvatarPath('av-0123456789abcdef');
    expect(parseClassmateInput({ ...input, avatar }).ok).toBe(true);
    expect(uploadedAvatarId(avatar)).toBe('av-0123456789abcdef');
    expect(uploadedAvatarId('/avatars/curious.png')).toBeNull();
    expect(parseClassmateInput({ ...input, avatar: `${avatar}/../x` }).ok).toBe(false);
  });

  it('patches only present fields and archives through status', () => {
    expect(parseClassmatePatch({ status: 'archived' })).toEqual({
      ok: true,
      value: { status: 'archived' },
    });
    expect(parseClassmatePatch({ speechPolicy: 'active' })).toEqual({
      ok: true,
      value: { speechPolicy: 'active' },
    });
    expect(parseClassmatePatch({})).toEqual({ ok: false, field: 'body' });
    expect(parseClassmatePatch({ status: 'deleted' })).toEqual({ ok: false, field: 'status' });
  });

  it('reads back only well-formed snapshots', () => {
    expect(parseClassmateSnapshot(snapshot)).toEqual(snapshot);
    expect(parseClassmateSnapshot({ ...snapshot, speechPolicy: 'always' })).toBeNull();
    expect(parseClassmateSnapshot('x')).toBeNull();
  });
});

describe('classroom snapshot ids', () => {
  it('round-trips the template revision behind a classroom agent', () => {
    const agentId = classmateStageAgentId(ID, 3);
    expect(agentId).toBe(`${ID}-r3`);
    expect(parseClassmateStageAgentId(agentId)).toEqual({ classmateId: ID, revision: 3 });
  });

  it('never mistakes other agents or the live template id for a snapshot', () => {
    for (const id of [ID, 'default-1', 'teacher-li', `${ID}-r0`, `${ID}-r`, 'cm-XYZ-r1', 42]) {
      expect(parseClassmateStageAgentId(id)).toBeNull();
    }
  });

  it('stores the student persona followed by the fixed companion-style rule', () => {
    const persona = composeClassmatePersona(snapshot);
    expect(persona.startsWith(snapshot.persona)).toBe(true);
    expect(persona).toContain('guiding questions');
    expect(composeClassmatePersona({ ...snapshot, persona: '' })).toContain('classmate');
    expect(classmateRosterConfig(ID, 2, { ...snapshot, voice: input.voice as never })).toEqual({
      id: `${ID}-r2`,
      name: '小林',
      role: 'student',
      persona,
      avatar: snapshot.avatar,
      color: snapshot.color,
      priority: 5,
      voiceConfig: input.voice,
    });
  });
});

function agent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'default-1',
    name: '启衡',
    role: 'teacher',
    persona: 'Lead teacher',
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    allowedActions: [],
    priority: 10,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: true,
    ...overrides,
  };
}

describe('classmate roster for a new classroom', () => {
  const teacher = agent({});
  const assistant = agent({ id: 'default-2', name: '知微', role: 'assistant', priority: 7 });
  const classmate = agent({
    id: ID,
    name: '小林',
    role: 'student',
    persona: 'composed persona',
    priority: 5,
    isDefault: false,
    classmate: { id: ID, revision: 4 },
    voiceConfig: { providerId: 'qwen-tts', voiceId: 'Cherry' } as AgentConfig['voiceConfig'],
  });

  it('leaves rosters without classmates to the existing preset behaviour', () => {
    expect(buildClassmateRoster([teacher, assistant], () => undefined)).toBeNull();
  });

  it('freezes the whole roster, classmates under their revision id, built-ins unchanged', () => {
    const roster = buildClassmateRoster([teacher, classmate], (picked) =>
      picked.id === 'default-1'
        ? ({ providerId: 'qwen-tts', voiceId: 'Ethan' } as AgentConfig['voiceConfig'])
        : picked.voiceConfig,
    );
    expect(roster?.map((entry) => entry.id)).toEqual(['default-1', `${ID}-r4`]);
    expect(roster?.[0]?.voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'Ethan' });
    expect(roster?.[1]).toMatchObject({
      name: '小林',
      role: 'student',
      persona: 'composed persona',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'Cherry' },
    });
    expect(rosterAgentId(teacher)).toBe('default-1');
  });

  it('refuses more classmates than one classroom takes', () => {
    const many = Array.from({ length: CLASSMATE_LIMITS.classmatesPerClassroom + 1 }, (_, i) =>
      agent({
        ...classmate,
        id: `cm-${String(i).padStart(16, '0')}`,
        classmate: { id: 'x', revision: i + 1 },
      }),
    );
    expect(() => buildClassmateRoster([teacher, ...many], () => undefined)).toThrow(
      'CLASSMATE_ROSTER_TOO_LARGE',
    );
  });
});

describe('classmate speaking rules', () => {
  const agents = [
    { id: 'default-1', name: '启衡', role: 'teacher' },
    { id: `${ID}-r1`, name: '小林', role: 'student' },
    { id: 'cm-fedcba9876543210-r2', name: 'Ada', role: 'assistant' },
  ];
  const policies = new Map([
    [`${ID}-r1`, 'on_demand' as const],
    ['cm-fedcba9876543210-r2', 'active' as const],
  ]);

  it('keeps an on-demand classmate quiet unless named', () => {
    expect(planClassmateSpeech({ agents, policies, userText: '这一步为什么要求导？' })).toEqual({
      agentIds: ['default-1', 'cm-fedcba9876543210-r2'],
      addressedAgentId: null,
      removedAgentIds: [`${ID}-r1`],
    });
  });

  it('lets the named classmate in and reports it as addressed', () => {
    expect(
      planClassmateSpeech({ agents, policies, userText: '小林，你觉得 ada 说得对吗？' }),
    ).toEqual({
      agentIds: agents.map((entry) => entry.id),
      addressedAgentId: `${ID}-r1`,
      removedAgentIds: [],
    });
  });

  it('keeps the discussion trigger and never empties the roster', () => {
    expect(
      planClassmateSpeech({ agents, policies, userText: null, triggerAgentId: `${ID}-r1` })
        .agentIds,
    ).toContain(`${ID}-r1`);
    expect(
      planClassmateSpeech({
        agents: [agents[1]!],
        policies,
        userText: 'hello',
      }).agentIds,
    ).toEqual([`${ID}-r1`]);
  });

  it('reads the latest user text from plain and part-based messages', () => {
    expect(
      lastUserText([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'x' },
        { role: 'user', parts: [{ type: 'text', text: '小林' }, { type: 'image' }] },
      ]),
    ).toBe('小林\n');
    expect(lastUserText([{ role: 'assistant', content: 'x' }])).toBeNull();
    expect(lastUserText('nope')).toBeNull();
  });
});

describe('classmate voice binding', () => {
  const pick = {
    providerId: 'minimax-tts',
    modelId: 'speech-2.8-turbo',
    voiceId: 'Chinese (Mandarin)_Warm_Girl',
  };
  const platformDefaults = {
    entries: [
      {
        capability: 'tts',
        defaultId: 'zhiyu-default-tts',
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-turbo',
        available: true,
        revision: 'rev-1',
      },
    ],
  };

  it('binds the selected platform default when provider and model are its own', () => {
    expect(
      classmateVoiceBinding(pick, {
        ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' },
        platformDefaults,
        ttsProvidersConfig: { 'minimax-tts': { isServerConfigured: true } },
      }),
    ).toEqual({ ...pick, source: 'platform', defaultId: 'zhiyu-default-tts', revision: 'rev-1' });
  });

  it('binds the server key for another model of a server-configured provider', () => {
    expect(
      classmateVoiceBinding(
        { ...pick, modelId: 'speech-2.8-hd' },
        {
          ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' },
          platformDefaults,
          ttsProvidersConfig: { 'minimax-tts': { isServerConfigured: true } },
        },
      ),
    ).toEqual({ ...pick, modelId: 'speech-2.8-hd', source: 'legacy-managed' });
  });

  it("binds the student's own configuration otherwise", () => {
    const own = {
      ttsProvidersConfig: { 'minimax-tts': { apiKey: 'k', isServerConfigured: true } },
    };
    expect(classmateVoiceBinding(pick, own)).toEqual({ ...pick, source: 'user' });
    expect(
      classmateVoiceBinding(pick, {
        ttsSelection: { source: 'user' },
        platformDefaults,
        ttsProvidersConfig: {},
      }),
    ).toEqual({ ...pick, source: 'user' });
    const unavailable = {
      entries: platformDefaults.entries.map((entry) => ({ ...entry, available: false })),
    };
    expect(
      classmateVoiceBinding(pick, {
        ttsSelection: { source: 'platform', defaultId: 'zhiyu-default-tts' },
        platformDefaults: unavailable,
        ttsProvidersConfig: {},
      }).source,
    ).toBe('user');
  });
});
