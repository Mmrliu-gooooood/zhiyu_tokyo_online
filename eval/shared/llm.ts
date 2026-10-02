/**
 * Eval harness model calls over the model gateway. Keeps the AI SDK-like
 * parameter shape the harnesses were written against (system / prompt /
 * plain-text or image messages) so prompts and judges stay unchanged.
 */
import {
  gateway,
  userContent,
  userText,
  fromChatTurns,
  type ChatTurn,
  type GatewayMessage,
  type ModelBinding,
} from '@/lib/model-gateway';

type EvalMessage =
  | ChatTurn
  | {
      role: 'user';
      content: Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer | string }>;
    };

export interface EvalCall {
  model: ModelBinding;
  system?: string;
  prompt?: string;
  messages?: EvalMessage[];
  maxOutputTokens?: number;
  temperature?: number;
}

function imageInput(image: Buffer | string): string {
  return typeof image === 'string' ? image : `data:image/png;base64,${image.toString('base64')}`;
}

function toRequest(call: EvalCall): { system?: string; messages: GatewayMessage[] } {
  const turns: ChatTurn[] = [];
  const messages: GatewayMessage[] = [];
  for (const message of call.messages ?? []) {
    if (typeof message.content === 'string') {
      turns.push(message as ChatTurn);
      continue;
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n');
    const images = message.content
      .filter((part) => part.type === 'image')
      .map((part) => imageInput((part as { image: Buffer | string }).image));
    messages.push(userContent(text, images));
  }
  const fromTurns = fromChatTurns(turns, call.system);
  return {
    ...(fromTurns.system ? { system: fromTurns.system } : {}),
    messages: [...fromTurns.messages, ...messages, ...(call.prompt ? [userText(call.prompt)] : [])],
  };
}

/** One completion through the gateway (usage recorded under `source`). */
export async function completeEval(call: EvalCall, source: string): Promise<{ text: string }> {
  const result = await gateway.complete(
    call.model,
    {
      ...toRequest(call),
      ...(call.maxOutputTokens ? { maxOutputTokens: call.maxOutputTokens } : {}),
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
    },
    { source },
  );
  return { text: result.text };
}

/** Judge / scorer calls (formerly the AI SDK's generateText). */
export function generateText(call: EvalCall): Promise<{ text: string }> {
  return completeEval(call, 'eval-judge');
}
