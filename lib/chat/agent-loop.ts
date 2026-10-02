/**
 * Agent Loop — Shared core logic for the frontend-driven multi-agent loop.
 *
 * Extracted from use-chat-sessions.ts so both the frontend hook and the
 * eval harness share the same loop logic. No React dependency — pure
 * async function with callback injection for environment-specific behavior.
 *
 * The loop runs per-user-message: the director dispatches agents one at a
 * time, each agent generates a response, and the loop continues until the
 * director says END, cues the user, the automatic reply budget is reached,
 * or two consecutive empty agent turns indicate something is wrong.
 */

import type { StatelessEvent, DirectorState } from '@/lib/types/chat';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';
import { getReplyPolicy } from './reply-policy';

const log = createLogger('AgentLoop');

// ==================== Types ====================

/** Store state snapshot sent with each /api/chat request */
export interface AgentLoopStoreState {
  stage: unknown;
  scenes: unknown[];
  outlines?: unknown[];
  currentSceneId: string | null;
  mode: string;
  whiteboardOpen: boolean;
  whiteboardManualVisibilityRevision?: number;
  /**
   * Post-submit quiz state for the current scene. Hydrated from RuntimeStore
   * client-side; absent when the active scene is not a graded quiz or the
   * student has not submitted yet.
   */
  quizResults?: {
    sceneId: string;
    answers: Record<string, string | string[]>;
    results: Array<{
      questionId: string;
      correct: boolean | null;
      status: 'correct' | 'incorrect';
      earned: number;
      aiComment?: string;
    }>;
  };
}

/** Request template — fields that stay constant across loop iterations */
export interface AgentLoopRequest {
  /** Immutable user-turn snapshot; React refs may still contain the previous turn. */
  messages?: unknown[];
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
    [key: string]: unknown;
  };
  userProfile?: { nickname?: string; bio?: string };
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
  modelSource?: 'platform' | 'user' | 'legacy-managed';
  platformDefaultId?: string;
  api?: string;
  endpointProfile?: string;
  endpointParams?: Record<string, string>;
  credentialId?: string;
  thinkingConfig?: ThinkingConfig;
}

/** Per-iteration outcome extracted from the done event */
export interface AgentLoopIterationResult {
  directorState?: DirectorState;
  totalAgents: number;
  agentHadContent: boolean;
  cueUserReceived: boolean;
}

/** Callbacks injected by the caller (frontend or eval) */
export interface AgentLoopCallbacks {
  /** Get fresh store state for each iteration (whiteboard may have changed) */
  getStoreState: () => AgentLoopStoreState | Promise<AgentLoopStoreState>;

  /** Get current messages for the request */
  getMessages: () => unknown[];

  /**
   * Make the HTTP request to /api/chat.
   * Returns a Response object (or equivalent with .body ReadableStream).
   */
  fetchChat: (body: Record<string, unknown>, signal: AbortSignal) => Promise<Response>;

  /**
   * Process a single SSE event. Called for every event in the stream.
   * The callback should handle action execution, text accumulation,
   * message construction, and UI updates.
   */
  onEvent: (event: StatelessEvent) => void;

  /**
   * Called after all SSE events for one iteration have been processed
   * and the stream is closed.
   *
   * Must return the iteration result (extracted from the 'done' event).
   * The frontend waits for buffer drain here before reading the result
   * from loopDoneDataRef. The eval harness returns a result it
   * accumulated during onEvent calls.
   */
  onIterationEnd: () => Promise<AgentLoopIterationResult | null>;
}

/** Final outcome of the agent loop */
export interface AgentLoopOutcome {
  /** Why the loop stopped */
  reason: 'end' | 'cue_user' | 'turn_limit' | 'aborted' | 'empty_turns' | 'no_done';
  /** Accumulated director state */
  directorState?: DirectorState;
  /** Number of iterations completed */
  turnCount: number;
}

// ==================== Core Loop ====================

function awaitOrAbort<T>(work: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve({ status: 'aborted' as const });
  return new Promise<{ status: 'completed'; value: T } | { status: 'aborted' }>(
    (resolve, reject) => {
      let settled = false;
      const finish = (result: { status: 'completed'; value: T } | { status: 'aborted' }) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish({ status: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void work.then(
        (value) => finish({ status: 'completed', value }),
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    },
  );
}

/**
 * Run the agent loop — shared between frontend and eval.
 *
 * Each iteration: refresh state → POST /api/chat → process SSE events
 * → check exit conditions → repeat until director cues USER, ENDs, the
 * stream errors out, or two consecutive empty agent turns are observed.
 * User questions permit a teacher answer and one optional supplement; bare
 * acknowledgments permit one closing reply. Scripted discussion keeps its budget.
 */
export async function runAgentLoop(
  request: AgentLoopRequest,
  callbacks: AgentLoopCallbacks,
  signal: AbortSignal,
): Promise<AgentLoopOutcome> {
  let directorState: DirectorState | undefined = undefined;
  let turnCount = 0;
  let consecutiveEmptyTurns = 0;
  const replyPolicy = getReplyPolicy(request.messages ?? callbacks.getMessages(), request.config);
  const maxTurns = replyPolicy.maxTurns;

  while (true) {
    if (signal.aborted) {
      return { reason: 'aborted', directorState, turnCount };
    }

    // Refresh store state each iteration — agent actions may have changed
    // whiteboard, scene, or mode between turns
    const stateRead = await awaitOrAbort(
      Promise.resolve().then(() => callbacks.getStoreState()),
      signal,
    );
    if (stateRead.status === 'aborted') {
      return { reason: 'aborted', directorState, turnCount };
    }
    const freshStoreState = stateRead.value;
    const currentMessages = callbacks.getMessages();

    // Build request body
    const body: Record<string, unknown> = {
      messages: currentMessages,
      storeState: freshStoreState,
      config: request.config,
      directorState,
      userProfile: request.userProfile,
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      model: request.model,
      providerType: request.providerType,
      modelSource: request.modelSource,
      platformDefaultId: request.platformDefaultId,
      api: request.api,
      endpointProfile: request.endpointProfile,
      endpointParams: request.endpointParams,
      credentialId: request.credentialId,
      thinkingConfig: request.thinkingConfig,
    };

    // Fetch
    const response = await callbacks.fetchChat(body, signal);

    // Some transports or test doubles may resolve even after cancellation.
    // Never hand their late payload to the retired session consumer.
    if (signal.aborted) {
      return { reason: 'aborted', directorState, turnCount };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    // Parse SSE stream and process events
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) {
          return { reason: 'aborted', directorState, turnCount };
        }
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop() || '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;

          try {
            const event: StatelessEvent = JSON.parse(line.slice(6));
            callbacks.onEvent(event);
          } catch {
            // Skip malformed events (heartbeats, etc.)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (signal.aborted) {
      return { reason: 'aborted', directorState, turnCount };
    }

    // Post-iteration: wait for buffer drain (frontend) or collect results (eval)
    const iterationRead = await awaitOrAbort(
      Promise.resolve().then(() => callbacks.onIterationEnd()),
      signal,
    );
    if (iterationRead.status === 'aborted') {
      return { reason: 'aborted', directorState, turnCount };
    }
    const iterationResult = iterationRead.value;

    // Check exit conditions
    if (!iterationResult) {
      return { reason: 'no_done', directorState, turnCount };
    }

    // Update accumulated director state
    directorState = iterationResult.directorState;
    // Count completed requests locally: missing/stale model state must not
    // reset the budget and keep the classroom talking indefinitely.
    turnCount += 1;

    // A one-reply acknowledgment budget must not turn an empty model response
    // into successful closure (which would incorrectly resume the lecture).
    if (
      replyPolicy.acknowledgment &&
      !iterationResult.agentHadContent &&
      iterationResult.totalAgents > 0
    ) {
      return { reason: 'empty_turns', directorState, turnCount };
    }

    // Director said USER — stop loop
    if (iterationResult.cueUserReceived) {
      return { reason: replyPolicy.acknowledgment ? 'end' : 'cue_user', directorState, turnCount };
    }

    // Director said END — no agent spoke
    if (iterationResult.totalAgents === 0) {
      return { reason: 'end', directorState, turnCount };
    }

    // Track consecutive empty responses
    if (!iterationResult.agentHadContent) {
      consecutiveEmptyTurns++;
      if (consecutiveEmptyTurns >= 2) {
        log.warn(
          `[AgentLoop] ${consecutiveEmptyTurns} consecutive empty agent responses, stopping loop`,
        );
        return { reason: 'empty_turns', directorState, turnCount };
      }
    } else {
      consecutiveEmptyTurns = 0;
    }

    if (turnCount >= maxTurns) {
      return {
        reason: replyPolicy.acknowledgment ? 'end' : 'turn_limit',
        directorState,
        turnCount,
      };
    }
  }
}
