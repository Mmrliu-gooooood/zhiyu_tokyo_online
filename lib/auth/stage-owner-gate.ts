import { NextResponse } from 'next/server';

import { AuthError, authJsonResponse } from '@/lib/auth/errors';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { shouldIsolateOwner } from '@/lib/auth/principal';
import { tryPrincipal } from '@/lib/auth/session';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { hasSupabaseBrowserConfig } from '@/lib/supabase/env';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { readStageMeta, type StageMetaRow } from '@/lib/persistence/stage-meta';
import { resolveGenerationOwner } from '@/lib/server/generation-jobs/auth';
import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';
import type { Queryable } from '@openmaic/storage/document/pg';

export type StagePostAccess = 'allow' | 'not-found';

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function isQueryableStageId(stageId: string): boolean {
  return stageId.length > 0 && !stageId.includes('\u0000') && !LONE_SURROGATE.test(stageId);
}

/**
 * Dual-mode chat/agent POST gate. Signed-in `user:{uuid}` principals cannot
 * attach to someone else's stage or to the unsigned `anon:` library. Unsigned
 * traffic can still use the shared `anon:` pile. A `user:` stage is never
 * available to unsigned callers.
 *
 * Hosted FORCE RLS hides foreign `stage_meta` from the caller, so a missing
 * row is indistinguishable from "not yours". Isolated callers that supplied a
 * stage id therefore get 404 instead of falling through to later 400s.
 * Stateless chat without a stage id never reaches this helper. Unsigned
 * traffic may still chat against a client-only id that is not persisted yet.
 */
export function decideStagePostAccess(input: {
  callerOwnerId: string | undefined;
  stageOwnerId: string | undefined;
  deleted?: boolean;
  requireExisting?: boolean;
}): StagePostAccess {
  const stageOwnerId = input.stageOwnerId;
  if (!stageOwnerId || input.deleted) {
    if (input.requireExisting || shouldIsolateOwner(input.callerOwnerId)) {
      return 'not-found';
    }
    return 'allow';
  }
  if (input.callerOwnerId === stageOwnerId) return 'allow';
  if (shouldIsolateOwner(input.callerOwnerId) || shouldIsolateOwner(stageOwnerId)) {
    return 'not-found';
  }
  return 'allow';
}

export function stageIdFromStoreState(storeState: unknown): string | undefined {
  if (!storeState || typeof storeState !== 'object' || Array.isArray(storeState)) return undefined;
  const stage = (storeState as { stage?: unknown }).stage;
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) return undefined;
  const id = (stage as { id?: unknown }).id;
  if (typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const stagePostMeta = {
  async read(stageId: string, ownerId?: string): Promise<StageMetaRow | null> {
    if (!isQueryableStageId(stageId)) return null;
    const url = process.env.DATABASE_URL?.trim();
    if (!url) return null;
    // In local shared-library mode there is no authenticated/isolated owner to
    // compare. Keep the historical capability-by-id behavior and avoid making
    // classroom chat depend on persistence availability solely for a check
    // that cannot deny this caller. Hosted mode still fails closed below.
    if (!ownerId && !isHostedAuthEnabled()) return null;
    const { pool } = await getServerPersistenceProvider(url);
    if (ownerId && (isHostedAuthEnabled() || shouldIsolateOwner(ownerId))) {
      return readStageMeta(createOwnerBoundQueryable(pool, ownerId), stageId);
    }
    return readStageMeta(pool as unknown as Queryable, stageId);
  },
};

export async function resolveOptionalChatOwnerId(req: Request): Promise<string | undefined> {
  const headers = new Headers();
  if (isHostedAuthEnabled() || hasSupabaseBrowserConfig()) {
    const principal = await tryPrincipal(req, headers);
    if (principal) return principal.ownerId;
  }
  try {
    return resolveGenerationOwner(req, headers, false);
  } catch (error) {
    if (error instanceof GenerationJobError && error.code === 'GENERATION_SESSION_REQUIRED') {
      return undefined;
    }
    throw error;
  }
}

function notFound(headers?: Headers): Response {
  return new NextResponse('Not found', { status: 404, headers });
}

/**
 * Returns a 404 response when the stage must not be used by this caller.
 * Does not mint anonymous owner cookies (the unsigned library stays unsigned).
 */
export async function refuseForeignStagePost(
  req: Request,
  stageId: string | undefined,
  options: {
    requireExisting?: boolean;
    ownerId?: string;
    headers?: Headers;
    readMeta?: (stageId: string) => Promise<StageMetaRow | null>;
  } = {},
): Promise<Response | null> {
  if (!stageId) return null;
  try {
    const ownerId = options.ownerId ?? (await resolveOptionalChatOwnerId(req));
    const readMeta = options.readMeta ?? ((id: string) => stagePostMeta.read(id, ownerId));
    const meta = await readMeta(stageId);
    const access = decideStagePostAccess({
      callerOwnerId: ownerId,
      stageOwnerId: meta?.ownerId,
      deleted: meta?.deletedAt != null,
      requireExisting: options.requireExisting,
    });
    if (access === 'not-found') return notFound(options.headers);
    return null;
  } catch (error) {
    if (error instanceof AuthError) return authJsonResponse(error, options.headers);
    if (error instanceof GenerationJobError) {
      return Response.json(
        { success: false, errorCode: error.code, error: error.code },
        { status: error.httpStatus, headers: options.headers },
      );
    }
    throw error;
  }
}
