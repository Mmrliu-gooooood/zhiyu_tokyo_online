/**
 * Shapes of the P0-3 golden files (tests/fixtures/model-gateway/legacy-payloads).
 * The recorder that produced them drove the legacy stack and was removed with
 * it in P3-6; the goldens stay and are replayed by golden-replay.test.ts.
 */
import type { ProviderType, ThinkingConfig } from '@/lib/types/provider';
import type { GoldenRecord } from './matrix';

export type Conversation = 'single' | 'reasoning-replay' | 'tool-replay' | 'image';

export interface LegacyCaseInput {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  providerType?: ProviderType;
  api?: 'openai-completions' | 'openai-responses';
  thinking?: ThinkingConfig;
  tools: boolean;
  stream: boolean;
  conversation: Conversation;
  maxOutputTokens?: number;
  env?: Record<string, string>;
}

export interface GoldenEntry {
  input: LegacyCaseInput;
  request: GoldenRecord | { error: string };
}
