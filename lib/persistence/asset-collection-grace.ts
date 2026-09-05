import { DEFAULT_ASSET_COLLECTION_GRACE_MS } from '@openmaic/storage';

/**
 * The reclamation grace this process runs with.
 *
 * Two components need it and must agree: the collector, which deletes
 * unreferenced bytes once it has elapsed, and the persistence route, which has
 * to declare it to enable indirect byte egress so the handler can check that a
 * signed URL expires long before the object it names can be collected. Two
 * parsers of one variable could disagree about what an invalid value means, and
 * the handler would then validate its lifetime against a grace nothing
 * enforces, so the parse lives here once.
 *
 * An unset, empty, or invalid value resolves to the package default rather than
 * failing: the retention window has to be correct with no operator action.
 */
export function resolveAssetCollectionGraceMs(): number {
  // Queue inputs and staged outputs can outlive a browser session. Registry FK
  // pins prevent their removal; the additional grace protects orphan byte writes.
  const queueEnabled = process.env.GENERATION_BACKGROUND_ENABLED === '1';
  const minimum = queueEnabled ? 24 * 60 * 60 * 1000 : 0;
  const fallback = Math.max(minimum, DEFAULT_ASSET_COLLECTION_GRACE_MS);
  const raw = process.env.ASSET_COLLECTION_GRACE_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    console.warn(
      `ASSET_COLLECTION_GRACE_MS=${raw} is not an integer of at least 0 milliseconds; ` +
        `using ${DEFAULT_ASSET_COLLECTION_GRACE_MS}`,
    );
    return fallback;
  }
  return Math.max(minimum, parsed);
}
