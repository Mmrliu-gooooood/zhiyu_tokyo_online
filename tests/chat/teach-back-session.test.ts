import { describe, expect, it } from 'vitest';

import {
  buildTeachBackSpeechEvents,
  isTeachBackFollowUpRequest,
  shouldRouteToTeachBack,
  shouldSkipAgentLoopForTeachBack,
} from '@/lib/chat/teach-back-session';

describe('teach-back session helpers', () => {
  it('speaks a closing turn without cueing another student explanation', () => {
    const events = buildTeachBackSpeechEvents({
      messageId: 'm-close',
      peer: {
        id: 'default-2',
        name: 'Zhiwei',
        role: 'assistant',
        persona: 'helper',
        avatar: '/a.png',
        color: '#10b981',
      },
      text: '说得对，这一轮可以停了。',
    });
    expect(events.filter((event) => event.type === 'cue_user')).toHaveLength(0);
    expect(
      events.some((event) => event.type === 'text_delta' && event.data.content.includes('说得对')),
    ).toBe(true);
  });

  it('does not invent a user start message and waits after one companion question', () => {
    const events = buildTeachBackSpeechEvents({
      messageId: 'm1',
      peer: {
        id: 'default-2',
        name: 'Zhiwei',
        role: 'assistant',
        persona: 'helper',
        avatar: '/a.png',
        color: '#10b981',
      },
      text: 'Why does water move that way?',
      cue: { prompt: 'Why does water move that way?' },
    });
    expect(
      events.some((event) => event.type === 'text_delta' && event.data.content.includes('start')),
    ).toBe(false);
    expect(events.filter((event) => event.type === 'cue_user')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', data: { sessionClosed: false } });
  });

  it('routes teach_back before ordinary or guided loops', () => {
    expect(shouldRouteToTeachBack('teach_back', 'standard')).toBe(true);
    expect(shouldRouteToTeachBack(undefined, 'teach_back')).toBe(true);
    expect(shouldRouteToTeachBack('guided', 'guided')).toBe(false);
  });

  it('skips the ordinary agent loop for teach_back sessions', () => {
    expect(shouldSkipAgentLoopForTeachBack('teach_back')).toBe(true);
    expect(shouldSkipAgentLoopForTeachBack('guided')).toBe(false);
  });

  it('starts another three-turn round only for an explicit request that the companion ask again', () => {
    for (const message of [
      '继续提问',
      '请继续问我',
      '再问我一个问题',
      '我想让 AI 继续提问',
      '我还想让 AI 提问',
      '繼續提問',
      'ask me another question',
      'quiz me again',
    ]) {
      expect(isTeachBackFollowUpRequest(message), message).toBe(true);
    }
  });

  it('does not restart after acknowledgements or questions asked by the learner', () => {
    for (const message of [
      '谢谢',
      '我明白了',
      '我还有一个问题',
      '为什么是这样？',
      '不要继续提问',
      '学伴别再问我了',
      'thank you',
      'I have another question',
      "don't ask me again",
      'do not quiz me again',
    ]) {
      expect(isTeachBackFollowUpRequest(message), message).toBe(false);
    }
  });

  it('recognizes explicit localized requests for another round', () => {
    for (const message of [
      'もう一度質問して',
      '다시 질문해 줘',
      'pose-moi une autre question',
      'stell mir noch eine frage',
      'hazme otra pregunta',
      'faça outra pergunta',
      'задай мне ещё один вопрос',
      'hỏi tôi thêm một câu',
      'اسألني سؤالا آخر',
    ]) {
      expect(isTeachBackFollowUpRequest(message), message).toBe(true);
    }
  });
});
