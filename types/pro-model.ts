import type { ThinkingConfig } from '@/lib/types/provider';
import type { PlatformDefaultId } from '@/lib/types/platform-default-models';
import type { WireApi } from '@/lib/model-gateway/types';

/** Public, owner-scoped reference. It never authorizes access by itself. */
export interface ProModelRef {
  id: string;
  revision: number;
}

/** Connection input / server-only resolved context. Never persist in a session. */
export interface ProModelContext {
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
  thinkingConfig?: ThinkingConfig;
  /** Server-only revocation fence, checked before each outgoing call. */
  assertActive?: () => Promise<void>;
}
