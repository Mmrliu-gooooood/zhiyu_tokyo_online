import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { requirePrincipal, tryPrincipal } from '@/lib/auth/session';
import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';
import { GenerationJobError } from './contracts';

const COOKIE = 'generation_owner';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function cookie(req: Request, key: string): string | undefined {
  return req.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}
function sessionSecret(): string {
  const secret = process.env.GENERATION_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new GenerationJobError('GENERATION_SESSION_UNAVAILABLE', 503);
  return secret;
}
function signature(id: string): string {
  return createHmac('sha256', sessionSecret())
    .update(`generation-owner:v1:${id}`)
    .digest('base64url');
}
export function assertGenerationOrigin(req: Request): void {
  const configured =
    process.env.GENERATION_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000';
  const allowed = configured
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  let target = new URL(req.url);
  const host = req.headers.get('host');
  if (host !== null) {
    // Next standalone can expose its bind address (0.0.0.0) in req.url.
    // The actual Host is usable only after strict allowlist validation below;
    // forwarded host/protocol headers never grant trust.
    try {
      const addressed = new URL(`${target.protocol}//${host}`);
      if (
        addressed.host !== host.toLowerCase() ||
        addressed.username ||
        addressed.password ||
        addressed.pathname !== '/' ||
        addressed.search ||
        addressed.hash
      ) {
        throw new Error('Invalid Host');
      }
      target = addressed;
    } catch {
      throw new GenerationJobError('ORIGIN_NOT_ALLOWED', 403);
    }
  }
  if (!allowed.includes(target.origin)) throw new GenerationJobError('ORIGIN_NOT_ALLOWED', 403);
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site' || (origin !== null && origin !== target.origin))
    throw new GenerationJobError('ORIGIN_NOT_ALLOWED', 403);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin !== target.origin)
    throw new GenerationJobError('ORIGIN_REQUIRED', 403);
}
/** A persisted, signed session. The public persistence token is never an identity. */
export function resolveGenerationOwner(req: Request, headers: Headers, create = false): string {
  if (isHostedAuthEnabled()) {
    throw new GenerationJobError('GENERATION_SESSION_REQUIRED', 401);
  }
  const raw = cookie(req, COOKIE);
  if (raw) {
    const [id, proof, ...extra] = raw.split('.');
    if (!UUID.test(id) || !proof || extra.length)
      throw new GenerationJobError('INVALID_GENERATION_SESSION', 401);
    const expected = Buffer.from(signature(id));
    const actual = Buffer.from(proof);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new GenerationJobError('INVALID_GENERATION_SESSION', 401);
    return `anon:${id}`;
  }
  if (!create) throw new GenerationJobError('GENERATION_SESSION_REQUIRED', 401);
  // Existing anonymous identities are only imported in the explicitly trusted
  // local installation. This migration is disabled by default.
  const legacy = cookie(req, 'anonymous_id');
  const id =
    process.env.GENERATION_TRUST_LEGACY_OWNER === '1' && legacy && UUID.test(legacy)
      ? legacy
      : randomUUID();
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  const suffix = `; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`;
  headers.append('Set-Cookie', `${COOKIE}=${id}.${signature(id)}${suffix}`);
  headers.append('Set-Cookie', `anonymous_id=${id}${suffix}`);
  return `anon:${id}`;
}

export async function resolveGenerationOwnerAsync(
  req: Request,
  headers: Headers,
  create = false,
): Promise<string> {
  if (isHostedAuthEnabled()) {
    const principal = await requirePrincipal(req, headers);
    return principal.ownerId;
  }
  if (hasSupabaseBrowserConfig()) {
    const principal = await tryPrincipal(req, headers);
    if (principal) return principal.ownerId;
  }
  return resolveGenerationOwner(req, headers, create);
}
