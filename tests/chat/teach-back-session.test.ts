import { describe, expect, it } from 'vitest';

import { buildTeachBackSpeechEvents, shouldRouteToTeachBack, shouldSkipAgentLoopForTeachBack } from '@/lib/chat/teach-back-session';

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
    expect(events.some((event) => event.type === 'text_delta' && event.data.content.includes('说得对'))).toBe(
      true,
    );
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
    expect(events.some((event) => event.type === 'text_delta' && event.data.content.includes('start'))).toBe(
      false,
    );
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
});
