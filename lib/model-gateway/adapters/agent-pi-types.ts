/**
 * Interop types for pi-agent-core 0.78.
 *
 * The agent kernel ships with its own nested pi-ai 0.78 while the application
 * root depends on pi-ai 0.99. Every pi type handed to (or received from) the
 * agent kernel must therefore be derived from pi-agent-core's own exports,
 * never imported from the root `@earendil-works/pi-ai` package.
 */
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';

export type AgentLlmModel = Parameters<StreamFn>[0];
export type AgentLlmContext = Parameters<StreamFn>[1];
export type AgentStreamOptions = NonNullable<Parameters<StreamFn>[2]>;
export type AgentEventStream = Awaited<ReturnType<StreamFn>>;

export type AgentAssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
export type AgentToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
export type AgentUserMessage = Extract<AgentMessage, { role: 'user' }>;
export type AgentLlmMessage = AgentLlmContext['messages'][number];
export type AgentLlmTool = NonNullable<AgentLlmContext['tools']>[number];

export type AgentAssistantContent = AgentAssistantMessage['content'][number];
export type AgentToolCall = Extract<AgentAssistantContent, { type: 'toolCall' }>;
export type AgentTextContent = Extract<AgentAssistantContent, { type: 'text' }>;
export type AgentThinkingContent = Extract<AgentAssistantContent, { type: 'thinking' }>;

export type AgentAssistantMessageEvent =
  AgentEventStream extends AsyncIterable<infer E> ? E : never;

export type AgentApi = AgentLlmModel['api'];
export type AgentUsage = AgentAssistantMessage['usage'];
