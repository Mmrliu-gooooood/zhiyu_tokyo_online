import { trustProxyHeaders } from './trust-proxy';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function prune(now: number): void {
  if (buckets.size < 2000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  prune(now);
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) };
}

export function clientRateKey(request: Request, action: string): string {
  // Forwarded headers are caller-controlled unless the deployment explicitly
  // declares that a trusted reverse proxy overwrites them.
  const trustProxy = trustProxyHeaders();
  const forwarded = trustProxy ? request.headers.get('x-forwarded-for') : null;
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    (trustProxy ? request.headers.get('x-real-ip') : null) ||
    'untrusted-client';
  return `${action}:${ip}`;
}
