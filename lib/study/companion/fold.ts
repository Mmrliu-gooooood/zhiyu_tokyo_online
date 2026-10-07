/**
 * The after-class chat page's view of one agent session (learning plan B05):
 * a pure fold over the session's durable event log
 * (`/api/agent/sessions/:id/events`).
 *
 * Events are applied at most once by their log id, so a reconnect that
 * replays from `Last-Event-ID` (or a page reload that replays everything)
 * yields exactly the same messages — never a duplicate.
 */
import {
  COMPANION_TOOL_NAMES,
  COMPANION_TURN_EVENT,
  decodeCompanionMessage,
  type CompanionExcerpt,
  type CompanionInviteDetails,
  type CompanionMaterialDetails,
  type CompanionTurnInfo,
} from './contracts';

export interface CompanionEvent {
  id: number;
  ts: number;
  type: string;
  data: unknown;
}

export type CompanionNode =
  | { kind: 'user'; key: string; text: string; discuss: string[]; delivery: string; ts: number }
  | {
      kind: 'assistant';
      key: string;
      text: string;
      streaming: boolean;
      turn: CompanionTurnInfo | null;
      excerpts: Record<string, CompanionExcerpt>;
      ts: number;
    }
  | { kind: 'invite'; key: string; details: CompanionInviteDetails; ts: number }
  | {
      kind: 'tool';
      key: string;
      toolCallId: string;
      toolName: string;
      query: string;
      state: 'running' | 'done' | 'failed';
      found: number;
      ts: number;
    }
  | {
      kind: 'marker';
      key: string;
      marker: 'persona-updated' | 'materials-withheld' | 'model-changed';
      from?: number;
      to?: number;
      count?: number;
      label?: string;
      ts: number;
    }
  | {
      kind: 'status';
      key: string;
      status: 'failed' | 'cancelled' | 'interrupted';
      error?: string;
      ts: number;
    };

export type CompanionRunStatus = 'idle' | 'queued' | 'running' | 'failed' | 'cancelled';

export interface CompanionFold {
  lastEventId: number;
  nodes: CompanionNode[];
  status: CompanionRunStatus;
  /** The latest turn record (classmate revision, materials, model). */
  turn: CompanionTurnInfo | null;
  /** Every excerpt seen so far, by ref (citations in any answer resolve here). */
  excerpts: Record<string, CompanionExcerpt>;
  /** Tool calls and model rounds of this chat, for the usage line. */
  toolCalls: number;
  answers: number;
}

export function createCompanionFold(): CompanionFold {
  return {
    lastEventId: 0,
    nodes: [],
    status: 'idle',
    turn: null,
    excerpts: {},
    toolCalls: 0,
    answers: 0,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assistantText(message: unknown): string | null {
  const source = record(message);
  if (source.role !== 'assistant' || !Array.isArray(source.content)) return null;
  return source.content
    .map((block) => {
      const item = record(block);
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function isMaterialDetails(value: unknown): value is CompanionMaterialDetails {
  return record(value).kind === 'study-companion-materials';
}

function isInviteDetails(value: unknown): value is CompanionInviteDetails {
  return record(value).kind === 'study-companion-invite';
}

function lastTurnBefore(nodes: readonly CompanionNode[]): CompanionTurnInfo | null {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (node.kind === 'assistant' && node.turn) return node.turn;
  }
  return null;
}

/** Apply one event. Events at or below `lastEventId` are ignored (replays). */
export function foldCompanionEvent(state: CompanionFold, event: CompanionEvent): CompanionFold {
  if (!Number.isFinite(event.id) || event.id <= state.lastEventId) return state;
  const next: CompanionFold = { ...state, lastEventId: event.id, nodes: [...state.nodes] };
  const data = record(event.data);
  const key = `e${event.id}`;
  switch (event.type) {
    case 'user_message': {
      const decoded = decodeCompanionMessage(String(data.text ?? ''));
      next.nodes.push({
        kind: 'user',
        key,
        text: decoded.text,
        discuss: decoded.options.discuss,
        delivery: String(data.delivery ?? ''),
        ts: event.ts,
      });
      if (next.status !== 'running') next.status = 'queued';
      break;
    }
    case 'session_start':
    case 'session_resumed':
      next.status = 'running';
      break;
    case COMPANION_TURN_EVENT: {
      const turn = event.data as CompanionTurnInfo;
      const previous = state.turn;
      if (previous && previous.personaKey !== turn.personaKey) {
        next.nodes.push({
          kind: 'marker',
          key: `${key}-persona`,
          marker: 'persona-updated',
          from: previous.revision,
          to: turn.revision,
          ts: event.ts,
        });
      }
      if (previous && previous.model.label !== turn.model.label) {
        next.nodes.push({
          kind: 'marker',
          key: `${key}-model`,
          marker: 'model-changed',
          label: turn.model.label,
          ts: event.ts,
        });
      }
      const withheld = turn.withheldMaterialIds?.length ?? 0;
      if (withheld > 0 && (previous?.withheldMaterialIds?.length ?? 0) !== withheld) {
        next.nodes.push({
          kind: 'marker',
          key: `${key}-withheld`,
          marker: 'materials-withheld',
          count: withheld,
          ts: event.ts,
        });
      }
      next.turn = turn;
      break;
    }
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const text = assistantText(data.message);
      if (text === null) break;
      const openIndex = next.nodes.findIndex((node) => node.kind === 'assistant' && node.streaming);
      if (openIndex >= 0) {
        const open = next.nodes[openIndex] as Extract<CompanionNode, { kind: 'assistant' }>;
        next.nodes[openIndex] = {
          ...open,
          text: text || open.text,
          streaming: event.type !== 'message_end',
        };
        if (event.type === 'message_end' && !(text || open.text).trim()) {
          next.nodes.splice(openIndex, 1);
        } else if (event.type === 'message_end') {
          next.answers += 1;
        }
      } else if (event.type !== 'message_end' || text.trim()) {
        next.nodes.push({
          kind: 'assistant',
          key,
          text,
          streaming: event.type !== 'message_end',
          turn: next.turn ?? lastTurnBefore(next.nodes),
          excerpts: {},
          ts: event.ts,
        });
        if (event.type === 'message_end') next.answers += 1;
      }
      break;
    }
    case 'tool_execution_start': {
      const args = record(data.args);
      next.nodes.push({
        kind: 'tool',
        key,
        toolCallId: String(data.toolCallId ?? ''),
        toolName: String(data.toolName ?? ''),
        query: String(args.query ?? args.request ?? args.ref ?? ''),
        state: 'running',
        found: 0,
        ts: event.ts,
      });
      break;
    }
    case 'tool_execution_end': {
      next.toolCalls += 1;
      const callId = String(data.toolCallId ?? '');
      const details = record(data.result).details;
      const found = isMaterialDetails(details) ? details.excerpts.length : 0;
      next.nodes = next.nodes.map((node) =>
        node.kind === 'tool' && node.toolCallId === callId
          ? { ...node, state: data.isError ? 'failed' : 'done', found }
          : node,
      );
      if (isMaterialDetails(details) && details.excerpts.length) {
        next.excerpts = { ...next.excerpts };
        for (const excerpt of details.excerpts) next.excerpts[excerpt.ref] = excerpt;
      }
      if (String(data.toolName ?? '') === COMPANION_TOOL_NAMES.invite && isInviteDetails(details)) {
        next.nodes.push({ kind: 'invite', key: `${key}-invite`, details, ts: event.ts });
        if (details.excerpts.length) {
          next.excerpts = { ...next.excerpts };
          for (const excerpt of details.excerpts) next.excerpts[excerpt.ref] = excerpt;
        }
      }
      break;
    }
    case 'session_interrupted':
      next.nodes = next.nodes.map((node) =>
        node.kind === 'assistant' && node.streaming ? { ...node, streaming: false } : node,
      );
      next.nodes.push({ kind: 'status', key, status: 'interrupted', ts: event.ts });
      break;
    case 'session_end': {
      const status = String(data.status ?? '');
      next.nodes = next.nodes.map((node) =>
        node.kind === 'assistant' && node.streaming ? { ...node, streaming: false } : node,
      );
      if (status === 'failed') {
        next.status = 'failed';
        next.nodes.push({
          kind: 'status',
          key,
          status: 'failed',
          ...(typeof data.error === 'string' ? { error: data.error } : {}),
          ts: event.ts,
        });
      } else if (status === 'cancelled') {
        next.status = 'cancelled';
        next.nodes.push({ kind: 'status', key, status: 'cancelled', ts: event.ts });
      } else {
        next.status = 'idle';
      }
      break;
    }
    default:
      return { ...state, lastEventId: event.id };
  }
  return next;
}

export function foldCompanionEvents(
  state: CompanionFold,
  events: readonly CompanionEvent[],
): CompanionFold {
  return events.reduce(foldCompanionEvent, state);
}

/** The error code at the front of a failed run's message (e.g. STUDY_CLASSMATE_ARCHIVED). */
export function companionErrorCode(error: string | undefined): string | null {
  const match = /^([A-Z][A-Z_]+)(?::([a-z_]+))?:/.exec(error ?? '');
  return match ? match[1]! : null;
}

/** Split an answer into text and citation parts ([M3]). */
export function citationParts(
  text: string,
): Array<{ kind: 'text'; text: string } | { kind: 'cite'; ref: string }> {
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'cite'; ref: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/\[(M\d{1,4})\]/gu)) {
    if (match.index! > last) parts.push({ kind: 'text', text: text.slice(last, match.index) });
    parts.push({ kind: 'cite', ref: match[1]! });
    last = match.index! + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/** Every named SSE frame the chat page subscribes to (EventSource drops unlisted names). */
export const COMPANION_EVENT_TYPES = [
  'session_start',
  'session_resumed',
  'session_end',
  'session_interrupted',
  'user_message',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'agent_end',
  COMPANION_TURN_EVENT,
] as const;
