/**
 * Shared route timing and request-bound constants.
 *
 * Next.js route modules may only export supported route fields and HTTP
 * handlers. Keeping these values here lets routes and their regression tests
 * consume the same contract without adding unsupported route exports.
 */
export const OWNER_EVENT_POLL_INTERVAL_MS = 30_000;
export const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
export const OWNER_EVENT_REPLAY_LIMIT = 1_000;

export const SESSION_EVENT_POLL_INTERVAL_MS = 5_000;
export const TERMINAL_SESSION_EVENT_POLL_INTERVAL_MS = 10_000;

export const STAGE_FRESHNESS_POLL_INTERVAL_MS = 5_000;
export const MAX_BATCH_SCENE_IDS = 200;
