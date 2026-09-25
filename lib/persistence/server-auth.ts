/**
 * DEVELOPMENT-ONLY authentication for the embedded persistence route.
 *
 * The token is NOT a secret: NEXT_PUBLIC_PERSISTENCE_TOKEN is compiled into
 * the public browser bundle, so it is fully visible to every visitor and
 * provides no confidentiality and no user isolation — anyone who can load the
 * page can read and write EVERY learner partition and all documents by
 * supplying an arbitrary x-learner-key. Its only purpose is to keep unrelated
 * network scanners out of a trusted-network endpoint. Suitable only for
 * localhost or trusted-network, single-user deployments. Production must
 * replace this module with real session verification and derive learner
 * identity from server-controlled claims.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { AssetPrincipal } from '@openmaic/storage';
import type { RuntimeHttpPrincipal } from '@openmaic/storage/server';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { tryPrincipal } from '@/lib/auth/session';
import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';
import { resolveGenerationOwner } from '@/lib/server/generation-jobs/auth';

type PersistencePrincipal = RuntimeHttpPrincipal & Partial<Pick<AssetPrincipal, 'key'>>;

/**
 * The single asset partition for this deployment shape. Documents have no
 * ownership partition; assets get the same treatment until real auth lands.
 */
const SHARED_ASSET_PRINCIPAL = 'shared';

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function authenticatePersistenceCredentials(
  authorization: string | undefined,
  learnerKey: string | undefined,
): PersistencePrincipal | undefined {
  const token = process.env.PERSISTENCE_DEV_TOKEN;
  if (!token || !authorization || !secureEqual(authorization, `Bearer ${token}`)) return undefined;

  // Documents are stored without any ownership partition, so assets are
  // stored under one shared principal to match: this authenticator provides
  // no user isolation either way (the header is client-supplied), and a
  // per-header asset partition only meant a converted document's assets
  // became unreadable to every other browser the document was shared with.
  // The learner key still partitions runtime sessions, which are genuinely
  // per-learner state. Production replaces this module with real session
  // verification and derives both from server-controlled claims.
  return { key: SHARED_ASSET_PRINCIPAL, ...(learnerKey ? { learnerKey } : {}) };
}

function incomingToRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const key of ['authorization', 'x-learner-key', 'cookie', 'origin', 'host']) {
    const value = singleHeader(req.headers[key]);
    if (value) headers.set(key, value);
  }
  return new Request('http://localhost:3000/api/persistence', { headers });
}

export function authenticatePersistenceHeaders(headers: Headers): PersistencePrincipal | undefined {
  const principal = authenticatePersistenceCredentials(
    headers.get('authorization') ?? undefined,
    headers.get('x-learner-key') ?? undefined,
  );
  if (!principal) return undefined;
  if (
    process.env.GENERATION_BACKGROUND_ENABLED === '1' &&
    headers.get('cookie')?.includes('generation_owner=')
  ) {
    try {
      const origin =
        process.env.GENERATION_ALLOWED_ORIGINS?.split(',')[0]?.trim() || 'http://localhost:3000';
      return {
        ...principal,
        key: resolveGenerationOwner(new Request(origin, { headers }), new Headers()),
      };
    } catch {
      return undefined;
    }
  }
  return principal;
}

export async function authenticatePersistenceRequest(
  req: IncomingMessage,
  originalRequest?: Request,
): Promise<PersistencePrincipal | undefined> {
  if (hasSupabaseBrowserConfig()) {
    try {
      // The embedded adapter has already authenticated this exact request.
      // Reuse its request-scoped verification; standalone callers still verify
      // their incoming credentials normally. Learner binding remains below.
      const principal = await tryPrincipal(originalRequest ?? incomingToRequest(req));
      if (principal) {
        if (
          req.headers['x-learner-key'] &&
          singleHeader(req.headers['x-learner-key']) !== principal.learnerKey
        ) {
          return undefined;
        }
        return { key: principal.assetPrincipal, learnerKey: principal.learnerKey };
      }
    } catch {
      return undefined;
    }
  }
  if (isHostedAuthEnabled()) return undefined;
  const headers = new Headers();
  for (const key of ['authorization', 'x-learner-key', 'cookie']) {
    const value = singleHeader(req.headers[key]);
    if (value) headers.set(key, value);
  }
  return authenticatePersistenceHeaders(headers);
}
