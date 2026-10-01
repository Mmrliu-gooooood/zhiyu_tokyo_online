/**
 * Bounded transport retry policy (plan 3.8). pi and SDK retries are always
 * disabled; this is the only retry layer. Nothing is retried once any output
 * was observed, and the provider/account never changes between attempts.
 */
import type { GatewayError } from './errors';

export type RetryMode = 'foreground' | 'background';

export const MAX_TRANSPORT_RETRIES = 2;
const PRE_SEND_DELAYS_MS = [1_000, 3_000] as const;
const BACKOFF_DELAYS_MS = [500, 1_500] as const;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

/**
 * Delay before the next attempt, or undefined to stop. `retriesSoFar` counts
 * retries already made (0 after the first attempt).
 */
export function retryDelayMs(
  error: GatewayError,
  retriesSoFar: number,
  mode: RetryMode,
): number | undefined {
  if (retriesSoFar >= MAX_TRANSPORT_RETRIES || error.outputObserved) return undefined;
  // DNS / connect failures: the request never left, safe in both modes.
  if (!error.requestSent && (error.code === 'MODEL_NETWORK' || error.code === 'MODEL_TIMEOUT')) {
    return PRE_SEND_DELAYS_MS[retriesSoFar];
  }
  if (mode === 'background') return undefined;
  if (error.code === 'MODEL_RATE_LIMITED') {
    if (error.retryAfterMs === undefined || error.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) {
      return undefined;
    }
    return Math.max(error.retryAfterMs, 100);
  }
  if (
    error.code === 'MODEL_UPSTREAM_UNAVAILABLE' ||
    error.code === 'MODEL_NETWORK' ||
    error.code === 'MODEL_TIMEOUT'
  ) {
    return BACKOFF_DELAYS_MS[retriesSoFar];
  }
  return undefined;
}

export function retryMode(requested: 'default' | 'none' | undefined): RetryMode {
  return requested === 'none' || process.env.GENERATION_BACKGROUND_ENABLED === '1'
    ? 'background'
    : 'foreground';
}
