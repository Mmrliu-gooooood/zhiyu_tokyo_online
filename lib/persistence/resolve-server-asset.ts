/**
 * Server-side resolution of a client-allocated asset id for extraction.
 *
 * Compatibility read fallback for callers that already hold an allocated
 * server asset id. New app flows do not allocate registry assets, but retained
 * documents and SDK clients may still name an existing entry.
 *
 * The resolution answers in five states so the route can map each to an honest
 * HTTP status: not configured (no `DATABASE_URL`), unauthenticated (the
 * development persistence credential is missing or wrong), missing (no entry
 * under this id for this principal), too large (the recorded byte length
 * exceeds the caller-supplied cap, rejected before any bytes are read), or
 * resolved.
 */
import { AssetNotFoundError, toAssetId, type AssetPrincipal } from '@openmaic/storage';

import { AuthError } from '@/lib/auth/errors';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { shouldIsolateOwner } from '@/lib/auth/principal';
import { tryPrincipal } from '@/lib/auth/session';

import { authenticatePersistenceHeaders } from './server-auth';
import { createHostedOwnerBoundStores, getServerPersistenceProvider } from './server-provider';

export type ServerAssetResolution =
  | { status: 'resolved'; buffer: Buffer; mimeType: string }
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'missing' }
  | { status: 'too_large' };

/**
 * Resolve an allocated asset id to its bytes for extraction.
 *
 * When `maxByteLength` is supplied, the store's identity read (`identify` —
 * the same call HEAD uses, carrying the recorded byte length without reading
 * the bytes) is consulted first: an asset whose recorded length exceeds the
 * cap answers `too_large` WITHOUT ever materializing the bytes, so a
 * multi-hundred-MB asset cannot be pulled into server memory just to be
 * rejected. The caller keeps its post-resolve length check as a defensive
 * backstop against a store whose recorded length disagrees with the bytes.
 */
export async function resolveServerAsset(
  assetId: string,
  headers: Headers,
  maxByteLength?: number,
): Promise<ServerAssetResolution> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: 'unconfigured' };

  let assetPrincipal: AssetPrincipal | undefined;
  try {
    const hosted = await tryPrincipal(
      new Request('http://localhost/api/persistence', { headers }),
    );
    if (hosted) {
      assetPrincipal = { key: hosted.assetPrincipal, learnerKey: hosted.learnerKey };
    }
  } catch (error) {
    if (error instanceof AuthError) return { status: 'unauthenticated' };
    throw error;
  }
  if (!assetPrincipal) {
    if (isHostedAuthEnabled()) return { status: 'unauthenticated' };
    const principal = authenticatePersistenceHeaders(headers);
    if (!principal?.key) return { status: 'unauthenticated' };
    assetPrincipal = {
      key: principal.key,
      ...(principal.learnerKey ? { learnerKey: principal.learnerKey } : {}),
    };
  }

  try {
    const provider = await getServerPersistenceProvider(connectionString);
    const assetStore = shouldIsolateOwner(assetPrincipal.key)
      ? createHostedOwnerBoundStores(provider.pool, assetPrincipal.key).assetStore
      : provider.assetStore;
    const ref = toAssetId(assetId);
    // Size check BEFORE materialization: `identify` reads only the registry
    // row (recorded byte length), never the bytes, so an oversized asset is
    // rejected without ever pulling it into server memory.
    if (maxByteLength !== undefined) {
      const identity = await assetStore.identify(assetPrincipal, ref);
      if (!identity) return { status: 'missing' };
      if (identity.byteLength > maxByteLength) return { status: 'too_large' };
    }
    const resolved = await assetStore.resolve(assetPrincipal, ref);
    if (!resolved) return { status: 'missing' };
    return { status: 'resolved', buffer: Buffer.from(resolved.bytes), mimeType: resolved.mime };
  } catch (error) {
    // An unknown id and another principal's id both miss; the registry raises
    // the same typed error for the shapes it rejects, so map it to `missing`
    // rather than leaking it as a 500.
    if (error instanceof AssetNotFoundError) return { status: 'missing' };
    throw error;
  }
}
