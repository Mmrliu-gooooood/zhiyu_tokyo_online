import type { ThinkingConfig } from '@/lib/types/provider';
import type { PlatformDefaultId } from '@/lib/types/platform-default-models';
import type { WireApi } from '@/lib/model-gateway/types';
import type { ModelSelection } from '@/lib/model-gateway/selection/schema';

/** Public, owner-scoped reference. It never authorizes access by itself. */
export interface ProModelRef {
  id: string;
  revision: number;
}

/**
 * The Home model configuration in the browser (flat settings fields). It is
 * converted to a ModelSelection before it leaves the browser.
 */
export interface ModelConfigInput {
  /** Explicit source for new connections; omitted only by legacy snapshots. */
  source?: 'platform' | 'user' | 'legacy-managed';
  /** Stable server-resolved reference. Platform contexts never carry provider credentials. */
  defaultId?: PlatformDefaultId;
  /** Server-confirmed platform binding revision, included in snapshot identity. */
  revision?: string;
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  /** Wire protocol (any gateway WireApi the provider allows). */
  api?: WireApi;
  /** Catalog endpoint profile (regional / plan variant). */
  endpointProfile?: string;
  /** Non-secret catalog endpoint values (Cloudflare account / gateway id). */
  endpointParams?: Record<string, string>;
  /** Subscription credential reference (R2); mutually exclusive with apiKey. */
  credentialId?: string;
  thinkingConfig?: ThinkingConfig;
}

/** Server-only resolved connection. Never persist in a session. */
export interface ProModelContext {
  selection: ModelSelection;
  /** Server-only revocation fence, checked before each outgoing call. */
  assertActive?: () => Promise<void>;
}
