export const FOREGROUND_GENERATION_ROOT_HEADER = 'x-generation-root-stage-id';
export const FOREGROUND_GENERATION_SESSION_HEADER = 'x-generation-root-session-id';

const SESSION_KEY_PREFIX = 'openmaic:foreground-generation-session:';
const volatileSessions = new Map<string, string>();

function storedSessionId(stageId: string): string | undefined {
  const volatile = volatileSessions.get(stageId);
  if (volatile) return volatile;
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    return sessionStorage.getItem(`${SESSION_KEY_PREFIX}${stageId}`)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionIdFor(stageId: string): string {
  const existing = storedSessionId(stageId);
  if (existing) return existing;
  const created = newSessionId();
  volatileSessions.set(stageId, created);
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(`${SESSION_KEY_PREFIX}${stageId}`, created);
    } catch {
      // The in-memory fence still protects this tab when storage is unavailable.
    }
  }
  return created;
}

function clearSessionId(stageId: string, expected: string): void {
  if (volatileSessions.get(stageId) === expected) volatileSessions.delete(stageId);
  if (typeof sessionStorage === 'undefined') return;
  try {
    const key = `${SESSION_KEY_PREFIX}${stageId}`;
    if (sessionStorage.getItem(key) === expected) sessionStorage.removeItem(key);
  } catch {
    // Best effort only; a completed session cannot release a newer fence.
  }
}

export function foregroundGenerationHeaders(stageId: string): Record<string, string> {
  return {
    [FOREGROUND_GENERATION_ROOT_HEADER]: stageId,
    [FOREGROUND_GENERATION_SESSION_HEADER]: sessionIdFor(stageId),
  };
}

/** Best-effort explicit cancellation; expiry remains the crash/unload fallback. */
export async function cancelForegroundGenerationRoot(stageId: string): Promise<void> {
  if (!stageId.trim()) return;
  const sessionId = storedSessionId(stageId);
  if (!sessionId) return;
  // Fence this run before the network hop: a retry/new run must never reuse a
  // session whose delayed cancellation is already in flight.
  clearSessionId(stageId, sessionId);
  const response = await fetch(`/api/stages/${encodeURIComponent(stageId)}/generation-cancel`, {
    method: 'POST',
    headers: {
      [FOREGROUND_GENERATION_ROOT_HEADER]: stageId,
      [FOREGROUND_GENERATION_SESSION_HEADER]: sessionId,
    },
    keepalive: true,
  });
  if (!response.ok)
    throw new Error(`Foreground generation cancellation failed: ${response.status}`);
}

/** A completion request the server refused or that never got an answer. */
export class ForegroundCompletionError extends Error {
  constructor(
    readonly status: number | 'network',
    /** 4xx: the course is gone (404) or not ours (403); retrying cannot help. */
    readonly terminal: boolean,
  ) {
    super(`Foreground generation completion failed: ${status}`);
    this.name = 'ForegroundCompletionError';
  }
}

/** Backoff before each retry; the request is attempted `length + 1` times. */
export const FOREGROUND_COMPLETION_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

export interface ForegroundCompletionOptions {
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether this tab still holds an unreleased foreground session for the course. */
export function hasPendingForegroundGenerationSession(stageId: string): boolean {
  return storedSessionId(stageId) !== undefined;
}

/**
 * Mark the final durable document complete and release its course-level root.
 *
 * Both server steps are idempotent, so network errors and 5xx are retried with
 * bounded backoff; 4xx is final. The session id is cleared only after success,
 * which is what lets a reopened tab detect and repair a failed completion.
 */
export async function completeForegroundGenerationRoot(
  stageId: string,
  options: ForegroundCompletionOptions = {},
): Promise<void> {
  const delays = options.retryDelaysMs ?? FOREGROUND_COMPLETION_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const sessionId = storedSessionId(stageId);
  for (let attempt = 0; ; attempt += 1) {
    let failure: ForegroundCompletionError;
    try {
      const response = await fetch(
        `/api/stages/${encodeURIComponent(stageId)}/generation-complete`,
        {
          method: 'POST',
          headers: sessionId
            ? {
                [FOREGROUND_GENERATION_ROOT_HEADER]: stageId,
                [FOREGROUND_GENERATION_SESSION_HEADER]: sessionId,
              }
            : undefined,
        },
      );
      if (response.ok) {
        if (sessionId) clearSessionId(stageId, sessionId);
        return;
      }
      failure = new ForegroundCompletionError(
        response.status,
        response.status >= 400 && response.status < 500,
      );
    } catch {
      failure = new ForegroundCompletionError('network', false);
    }
    if (failure.terminal || attempt >= delays.length) throw failure;
    await sleep(delays[attempt]);
  }
}
