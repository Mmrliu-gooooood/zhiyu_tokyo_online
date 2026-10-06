/**
 * Classmate speaking rules for live classroom chat (learning plan B04). Pure,
 * shared by the LangGraph director (/api/chat) and the Pi director
 * (/api/chat/pi) so both paths decide the same way.
 *
 * The rule runs before either director sees the roster: an `on_demand`
 * classmate that was not named is removed from the request's agents, so no
 * prompt can call on it. A classmate the student names is kept and reported
 * as `addressedAgentId`, which the directors call on first. Existing reply
 * limits (getReplyPolicy) still cap the number of turns.
 */
import type { ClassmateSpeechPolicy } from './contracts';

export interface SpeechCandidate {
  id: string;
  name: string;
  role: string;
}

export interface ClassmateSpeechPlan {
  /** The request's agent ids, in their original order, minus classmates that must stay quiet. */
  agentIds: string[];
  /** The classmate the student named first, when one is in the roster. */
  addressedAgentId: string | null;
  removedAgentIds: string[];
}

/** Text of the most recent user message, or null when the turn was not started by the student. */
export function lastUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | null;
    if (!message || typeof message !== 'object' || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.parts)) {
      return message.parts
        .map((part: { type?: string; text?: string } | null) =>
          part?.type === 'text' && typeof part.text === 'string' ? part.text : '',
        )
        .join('\n');
    }
    return '';
  }
  return null;
}

function namePosition(text: string, name: string): number {
  const needle = name.trim();
  if (!needle) return -1;
  return text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

/**
 * Apply the classmates' speaking rules to one chat request.
 *
 * `policies` holds a rule for each classmate agent in the request (other
 * agents are untouched). The trigger agent of an agent-initiated discussion
 * keeps its turn. If removing quiet classmates would leave no agent at all,
 * the roster is left as it was rather than ending the conversation silently.
 */
export function planClassmateSpeech(input: {
  agents: SpeechCandidate[];
  policies: ReadonlyMap<string, ClassmateSpeechPolicy>;
  userText: string | null;
  triggerAgentId?: string | null;
}): ClassmateSpeechPlan {
  const text = input.userText ?? '';
  let addressed: { id: string; at: number } | null = null;
  const named = new Set<string>();
  for (const agent of input.agents) {
    if (!input.policies.has(agent.id) || !text) continue;
    const at = namePosition(text, agent.name);
    if (at < 0) continue;
    named.add(agent.id);
    if (!addressed || at < addressed.at) addressed = { id: agent.id, at };
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const agent of input.agents) {
    const policy = input.policies.get(agent.id);
    if (
      policy === 'on_demand' &&
      !named.has(agent.id) &&
      agent.id !== (input.triggerAgentId ?? undefined)
    ) {
      removed.push(agent.id);
    } else {
      kept.push(agent.id);
    }
  }
  if (kept.length === 0) {
    return {
      agentIds: input.agents.map((agent) => agent.id),
      addressedAgentId: addressed?.id ?? null,
      removedAgentIds: [],
    };
  }
  return { agentIds: kept, addressedAgentId: addressed?.id ?? null, removedAgentIds: removed };
}

/** One line both directors add to their prompt when the student named a classmate. */
export function addressedAgentGuidance(name: string): string {
  return `The student addressed ${name} by name in this message: let ${name} answer this message first (the teacher may add a correction afterwards only if needed).`;
}
