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

/** Mark the final durable document complete and release its course-level root. */
export async function completeForegroundGenerationRoot(stageId: string): Promise<void> {
  const sessionId = storedSessionId(stageId);
  const response = await fetch(`/api/stages/${encodeURIComponent(stageId)}/generation-complete`, {
    method: 'POST',
    headers: sessionId
      ? {
          [FOREGROUND_GENERATION_ROOT_HEADER]: stageId,
          [FOREGROUND_GENERATION_SESSION_HEADER]: sessionId,
        }
      : undefined,
  });
  if (!response.ok) throw new Error(`Foreground generation completion failed: ${response.status}`);
  if (sessionId) clearSessionId(stageId, sessionId);
}
