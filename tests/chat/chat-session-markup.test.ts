import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatSessionComponent } from '@/components/chat/chat-session';
import type { ChatSession } from '@/lib/types/chat';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ChatSessionComponent markup contract', () => {
  it('preserves newlines in the shared message text wrapper', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'first line\nsecond line' }],
          metadata: { originalRole: 'user', senderName: 'You' },
        },
      ],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, { session, isActive: false }),
    );

    expect(html).toContain('class="whitespace-pre-wrap break-words"');
    expect(html).toContain('first line\nsecond line');
  });

  it('renders separate stop and continue controls during soft-closing', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'soft-closing',
      messages: [],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
      softCloseDeadline: Date.now() + 15_000,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session,
        isActive: true,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );

    expect(html).toContain('chat.endQA');
    expect(html).toContain('chat.softClosing');
    expect(html).not.toContain('animate-ping');
  });

  it('keeps AI identity/content and user authorship explicit in the rendered contract', () => {
    const session: ChatSession = {
      id: 'session-identity',
      type: 'qa',
      title: 'Q&A',
      status: 'completed',
      messages: [
        {
          id: 'assistant-message',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Chlorophyll captures light energy.' }],
          metadata: { originalRole: 'teacher', senderName: 'AI Teacher' },
        },
        {
          id: 'user-message',
          role: 'user',
          parts: [{ type: 'text', text: 'How is that energy stored?' }],
          metadata: { originalRole: 'user', senderName: 'You' },
        },
      ],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 2,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, { session, isActive: false }),
    );

    expect(html).toContain('data-message-role="assistant"');
    expect(html).toContain('data-message-role="user"');
    expect(html).toContain('data-testid="zhiyu-chat-identity"');
    expect(html).toContain('data-testid="zhiyu-chat-content"');
    expect(html).toContain('Chlorophyll captures light energy.');
    expect(html).toContain('How is that energy stored?');
    expect(html).toContain('bg-primary-soft');
  });
});
