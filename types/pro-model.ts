import type { ThinkingConfig } from '@/lib/types/provider';

/** Public, owner-scoped reference. It never authorizes access by itself. */
export interface ProModelRef {
  id: string;
  revision: number;
}

/** Connection input / server-only resolved context. Never persist in a session. */
export interface ProModelContext {
  modelString: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  api?: 'openai-completions' | 'openai-responses';
  thinkingConfig?: ThinkingConfig;
  /** Server-only revocation fence, checked before each outgoing call. */
  assertActive?: () => Promise<void>;
}
