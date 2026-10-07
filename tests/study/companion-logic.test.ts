/**
 * After-class classmate chats (learning plan B05): pure rules — the
 * per-message options envelope, the chat page's event fold (replays never
 * duplicate messages; persona/material/model changes are shown as markers),
 * the read-time re-filtering of earlier material excerpts, the history
 * window, the system prompt and the model policy parser.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';

import {
  companionHistoryView,
  companionPersonaKey,
  companionSystemPrompt,
} from '@/lib/server/study/companion/context';
import {
  parseClassmateModelPolicy,
  type ClassmateSnapshot,
} from '@/lib/study/classmates/contracts';
import {
  WITHHELD_EXCERPT,
  decodeCompanionMessage,
  encodeCompanionMessage,
  renderMaterialResult,
  type CompanionExcerpt,
  type CompanionMaterialDetails,
  type CompanionTurnInfo,
} from '@/lib/study/companion/contracts';
import {
  citationParts,
  companionErrorCode,
  createCompanionFold,
  foldCompanionEvents,
  type CompanionEvent,
} from '@/lib/study/companion/fold';

const CM = 'cm-0123456789abcdef';
const OTHER = 'cm-fedcba9876543210';

const snapshot: ClassmateSnapshot = {
  name: '小林',
  role: 'student',
  persona: '说话简短',
  learningStyle: 'socratic',
  speechPolicy: 'active',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  voice: null,
};

const excerpt = (
  ref: string,
  materialId: string,
  text = `${materialId} text`,
): CompanionExcerpt => ({
  ref,
  materialId,
  versionId: `${materialId}-v1`,
  versionNo: 1,
  artifactId: `${materialId}-art`,
  title: materialId === 'mat-a' ? '教材A' : '教材B',
  page: 3,
  blockId: 'b1',
  text,
});

describe('message options envelope', () => {
  it('round-trips discussion invites and strips them from the text', () => {
    const encoded = encodeCompanionMessage('为什么？', { discuss: [OTHER, OTHER] });
    expect(encoded).toContain('[[companion-options');
    expect(decodeCompanionMessage(encoded)).toEqual({
      text: '为什么？',
      options: { discuss: [OTHER] },
    });
    expect(encodeCompanionMessage('只问你', { discuss: [] })).toBe('只问你');
    expect(decodeCompanionMessage('只问你')).toEqual({ text: '只问你', options: { discuss: [] } });
  });

  it('ignores malformed or foreign ids and caps the invite list', () => {
    const forged = `问\n\n[[companion-options {"discuss":["x","${OTHER}","cm-1111111111111111","cm-2222222222222222"]}]]`;
    expect(decodeCompanionMessage(forged).options.discuss).toEqual([OTHER, 'cm-1111111111111111']);
    expect(decodeCompanionMessage('问 [[companion-options {bad}]]').options.discuss).toEqual([]);
  });
});

describe('material results', () => {
  const details: CompanionMaterialDetails = {
    kind: 'study-companion-materials',
    note: '找到 2 段',
    excerpts: [excerpt('M1', 'mat-a'), excerpt('M2', 'mat-b')],
  };

  it('withholds excerpts of materials outside the current authorisation', () => {
    const text = renderMaterialResult(details, new Set(['mat-a']));
    expect(text).toContain('mat-a text');
    expect(text).not.toContain('mat-b text');
    expect(text).toContain(WITHHELD_EXCERPT);
  });

  it('re-renders earlier tool results in the model history and keeps refs unique', () => {
    const history = [
      { role: 'user', content: '第一问', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'search_materials', arguments: {} }],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'search_materials',
        content: [{ type: 'text', text: renderMaterialResult(details) }],
        details,
        isError: false,
        timestamp: 3,
      },
      { role: 'assistant', content: [{ type: 'text', text: '答 [M2]' }], timestamp: 4 },
    ] as unknown as AgentMessage[];
    const view = companionHistoryView(history, new Set(['mat-a']));
    const rendered = JSON.stringify(view.messages);
    expect(rendered).not.toContain('mat-b text');
    expect(rendered).toContain('mat-a text');
    expect(view.withheldMaterialIds).toEqual(['mat-b']);
    expect([...view.excerpts.keys()]).toEqual(['M1']);
    expect(view.lastRef).toBe(2);
    // The stored message is untouched (read-time view only).
    expect(JSON.stringify(history)).toContain('mat-b text');
  });

  it('keeps only the last user turns, cut at a user message', () => {
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: 'user', content: `问${index}`, timestamp: index * 2 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `答${index}` }],
        timestamp: index * 2 + 1,
      },
    ]).flat() as unknown as AgentMessage[];
    const view = companionHistoryView(history, new Set(), 3);
    expect(view.messages).toHaveLength(6);
    expect((view.messages[0] as unknown as { content: string }).content).toBe('问9');
  });
});

describe('system prompt', () => {
  it('carries persona, authorised materials, the classroom origin and the single-responder rule', () => {
    const prompt = companionSystemPrompt({
      snapshot,
      spaceName: '高数',
      subject: '数学',
      materials: [{ id: 'mat-a', title: '教材A' }],
      retrieval: 'keyword',
      origin: {
        stageId: 'stage-1',
        sceneId: 'scene-2',
        excerpt: '为什么要换元？',
        courseTitle: '积分',
      },
      discussing: [],
      withheldCount: 1,
    });
    expect(prompt).toContain('小林');
    expect(prompt).toContain('《教材A》');
    expect(prompt).not.toContain('教材B');
    expect(prompt).toContain('read_course_page');
    expect(prompt).toContain('为什么要换元？');
    expect(prompt).toContain('只有你一个人回答');
    expect(prompt).toContain('1 份资料已被取消授权');
  });

  it('describes the discussion only when classmates are invited', () => {
    const prompt = companionSystemPrompt({
      snapshot,
      spaceName: '高数',
      subject: null,
      materials: [],
      retrieval: 'unavailable',
      origin: null,
      discussing: [{ classmateId: OTHER, name: '小周' }],
      withheldCount: 0,
    });
    expect(prompt).toContain('invite_classmate');
    expect(prompt).toContain('小周');
    expect(prompt).toContain('资料检索当前不可用');
  });

  it('changes the persona key only with persona fields', () => {
    expect(companionPersonaKey(snapshot)).toBe(
      companionPersonaKey({ ...snapshot, color: '#000000' }),
    );
    expect(companionPersonaKey(snapshot)).not.toBe(
      companionPersonaKey({ ...snapshot, persona: '话多' }),
    );
  });
});

const turn = (revision: number, overrides: Partial<CompanionTurnInfo> = {}): CompanionTurnInfo => ({
  classmateId: CM,
  revision,
  personaKey: `p${revision}`,
  name: '小林',
  avatar: '/avatars/curious.png',
  color: '#10b981',
  status: 'active',
  spaceId: 'space-a',
  materials: [{ id: 'mat-a', title: '教材A' }],
  withheldMaterialIds: [],
  retrieval: 'keyword',
  model: { mode: 'inherit', label: 'deepseek:deepseek-chat' },
  discuss: [],
  ...overrides,
});

function chatEvents(): CompanionEvent[] {
  let id = 0;
  const event = (type: string, data: unknown): CompanionEvent => ({ id: ++id, ts: id, type, data });
  return [
    event('user_message', { text: '第一问', delivery: 'queued' }),
    event('session_start', {}),
    event('study_companion_turn', turn(1)),
    event('message_start', { message: { role: 'assistant', content: [] } }),
    event('tool_execution_start', {
      toolCallId: 't1',
      toolName: 'search_materials',
      args: { query: '换元' },
    }),
    event('tool_execution_end', {
      toolCallId: 't1',
      toolName: 'search_materials',
      isError: false,
      result: {
        details: {
          kind: 'study-companion-materials',
          note: '',
          excerpts: [excerpt('M1', 'mat-a')],
        },
      },
    }),
    event('message_start', { message: { role: 'assistant', content: [] } }),
    event('message_update', {
      message: { role: 'assistant', content: [{ type: 'text', text: '先' }] },
    }),
    event('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: '先换元 [M1]' }] },
    }),
    event('session_end', { status: 'succeeded', toolCalls: 1 }),
    event('user_message', {
      text: encodeCompanionMessage('第二问', { discuss: [OTHER] }),
      delivery: 'queued',
    }),
    event('session_resumed', {}),
    event('study_companion_turn', turn(2, { withheldMaterialIds: ['mat-b'] })),
    event('tool_execution_start', { toolCallId: 't2', toolName: 'invite_classmate', args: {} }),
    event('tool_execution_end', {
      toolCallId: 't2',
      toolName: 'invite_classmate',
      isError: false,
      result: {
        details: {
          kind: 'study-companion-invite',
          classmateId: OTHER,
          revision: 1,
          name: '小周',
          avatar: '/a.png',
          color: '#000000',
          reply: '补充一点',
          excerpts: [],
        },
      },
    }),
    event('session_end', { status: 'failed', error: 'STUDY_CLASSMATE_ARCHIVED: 已归档' }),
  ];
}

describe('chat event fold', () => {
  it('builds the conversation once, whatever the replay or reconnect order', () => {
    const events = chatEvents();
    const once = foldCompanionEvents(createCompanionFold(), events);
    // A reconnect replays from an earlier id: nothing is duplicated.
    const replayed = foldCompanionEvents(once, events.slice(3));
    expect(replayed).toEqual(once);
    // Resuming from the middle gives the same final view.
    const half = foldCompanionEvents(createCompanionFold(), events.slice(0, 8));
    expect(foldCompanionEvents(half, events)).toEqual(once);

    const kinds = once.nodes.map((node) => node.kind);
    expect(kinds.filter((kind) => kind === 'user')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'assistant')).toHaveLength(1);
    expect(once.nodes.find((node) => node.kind === 'assistant')).toMatchObject({
      text: '先换元 [M1]',
      streaming: false,
    });
    expect(once.excerpts.M1?.materialId).toBe('mat-a');
    expect(once.nodes.find((node) => node.kind === 'user' && node.text === '第二问')).toMatchObject(
      {
        discuss: [OTHER],
      },
    );
    expect(once.nodes.find((node) => node.kind === 'invite')).toMatchObject({
      details: { name: '小周', reply: '补充一点' },
    });
    expect(once.toolCalls).toBe(2);
    expect(once.answers).toBe(1);
    expect(once.status).toBe('failed');
  });

  it('marks persona, model and material changes without rewriting earlier answers', () => {
    const fold = foldCompanionEvents(createCompanionFold(), chatEvents());
    const markers = fold.nodes.flatMap((node) => (node.kind === 'marker' ? [node.marker] : []));
    expect(markers).toEqual(['persona-updated', 'materials-withheld']);
    const answer = fold.nodes.find((node) => node.kind === 'assistant');
    expect(answer && answer.kind === 'assistant' ? answer.turn?.revision : null).toBe(1);
    const status = fold.nodes.at(-1);
    expect(status && status.kind === 'status' ? companionErrorCode(status.error) : null).toBe(
      'STUDY_CLASSMATE_ARCHIVED',
    );
  });

  it('splits citations out of answer text', () => {
    expect(citationParts('a [M1] b [M12]')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'cite', ref: 'M1' },
      { kind: 'text', text: ' b ' },
      { kind: 'cite', ref: 'M12' },
    ]);
  });
});

describe('classmate model policy', () => {
  it('defaults to inherit and accepts only existing-connection references', () => {
    expect(parseClassmateModelPolicy(undefined)).toEqual({ ok: true, value: { mode: 'inherit' } });
    expect(
      parseClassmateModelPolicy({
        mode: 'custom',
        model: { kind: 'platform', defaultId: 'zhiyu-default-text' },
      }),
    ).toEqual({
      ok: true,
      value: { mode: 'custom', model: { kind: 'platform', defaultId: 'zhiyu-default-text' } },
    });
    expect(
      parseClassmateModelPolicy({
        mode: 'custom',
        model: {
          kind: 'credential',
          credentialId: '11111111-1111-4111-8111-111111111111',
          providerId: 'openrouter',
          modelId: 'deepseek/deepseek-chat',
        },
      }).ok,
    ).toBe(true);
    // A key, a non-text platform default or an unknown kind is refused.
    expect(
      parseClassmateModelPolicy({
        mode: 'custom',
        model: { kind: 'user', providerId: 'openai', modelId: 'gpt', apiKey: 'sk-x' },
      }).ok,
    ).toBe(false);
    expect(
      parseClassmateModelPolicy({
        mode: 'custom',
        model: { kind: 'platform', defaultId: 'zhiyu-default-tts' },
      }).ok,
    ).toBe(false);
    expect(
      parseClassmateModelPolicy({
        mode: 'custom',
        model: { kind: 'credential', credentialId: 'nope', providerId: 'openrouter', modelId: 'x' },
      }).ok,
    ).toBe(false);
  });
});
