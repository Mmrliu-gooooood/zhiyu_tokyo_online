/**
 * Characterization matrix shared by the legacy recorder (P0-3) and the gateway
 * equivalence run (P2-5): which provider/model/thinking/tools/stream
 * combinations are exercised, and how a captured request is projected into a
 * stable, key-free golden record.
 */
import { PROVIDERS } from '@/lib/model-gateway/catalog/client-catalog';
import type { ModelInfo, ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';

export interface CharacterizationModel {
  providerId: string;
  modelId: string;
  /** Catalog entry, or null for an unknown/hand-typed model id. */
  modelInfo: ModelInfo | null;
  thinking?: ThinkingCapability;
}

export interface ThinkingVariant {
  label: string;
  config: ThinkingConfig | undefined;
}

export interface CharacterizationCase {
  id: string;
  providerId: string;
  modelId: string;
  thinking: ThinkingVariant;
  tools: boolean;
  stream: boolean;
}

/** Placeholder upstream for Azure, which has no catalog default. */
export const AZURE_TEST_BASE_URL = 'https://fake-resource.openai.azure.com/openai';
export const UNKNOWN_MODEL_ID = 'characterization-unknown-model';

export function thinkingSignature(thinking?: ThinkingCapability): string {
  return thinking ? JSON.stringify(thinking, Object.keys(thinking).sort()) : 'none';
}

/** One catalog model per distinct thinking capability, plus one unknown model. */
export function representativeModels(providerId: string): CharacterizationModel[] {
  const provider = PROVIDERS[providerId as keyof typeof PROVIDERS];
  const seen = new Set<string>();
  const models: CharacterizationModel[] = [];
  for (const model of provider.models) {
    const thinking = model.capabilities?.thinking;
    const signature = thinkingSignature(thinking);
    if (seen.has(signature)) continue;
    seen.add(signature);
    models.push({ providerId, modelId: model.id, modelInfo: model, thinking });
  }
  if (providerId === 'azure') {
    // Azure deployments are user-named; exercise a typical deployment id.
    models.push({ providerId, modelId: 'gpt-5.4', modelInfo: null });
  }
  models.push({ providerId, modelId: UNKNOWN_MODEL_ID, modelInfo: null });
  return models;
}

export function thinkingVariants(thinking?: ThinkingCapability): ThinkingVariant[] {
  const variants: ThinkingVariant[] = [
    { label: 'unset', config: undefined },
    { label: 'default', config: { mode: 'default' } },
    { label: 'disabled', config: { mode: 'disabled' } },
    { label: 'enabled', config: { mode: 'enabled' } },
  ];
  for (const effort of thinking?.effortValues ?? []) {
    variants.push({
      label: `effort-${effort}`,
      config: { mode: effort === 'none' ? 'disabled' : 'enabled', effort },
    });
  }
  for (const level of thinking?.levelValues ?? []) {
    variants.push({ label: `level-${level}`, config: { mode: 'enabled', level } });
  }
  if (thinking?.budgetRange) {
    const budget = thinking.defaultBudgetTokens ?? Math.max(thinking.budgetRange.min, 4096);
    variants.push({ label: `budget-${budget}`, config: { mode: 'enabled', budgetTokens: budget } });
    variants.push({
      label: `budget-min`,
      config: { mode: 'enabled', budgetTokens: thinking.budgetRange.min },
    });
    if (thinking.budgetRange.allowDynamic) {
      variants.push({ label: 'budget-dynamic', config: { mode: 'enabled', budgetTokens: -1 } });
    }
  }
  if (thinking?.control === 'mode') variants.push({ label: 'auto', config: { mode: 'auto' } });
  if (thinking?.requestAdapter === 'openrouter') {
    variants.push({
      label: 'exclude-reasoning',
      config: { mode: 'enabled', excludeReasoningOutput: true },
    });
  }
  return variants;
}

export function casesForProvider(providerId: string): CharacterizationCase[] {
  const cases: CharacterizationCase[] = [];
  for (const model of representativeModels(providerId)) {
    for (const thinking of thinkingVariants(model.thinking)) {
      for (const tools of [false, true]) {
        for (const stream of [false, true]) {
          cases.push({
            id: `${model.modelId}|thinking=${thinking.label}|tools=${tools ? 1 : 0}|${stream ? 'stream' : 'generate'}`,
            providerId,
            modelId: model.modelId,
            thinking,
            tools,
            stream,
          });
        }
      }
    }
  }
  return cases;
}

export const LEGACY_PROVIDER_IDS = Object.keys(PROVIDERS).sort();

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface GoldenRecord {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

const RECORDED_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'anthropic-beta',
  'anthropic-version',
];

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Replace the test key wherever it appears so goldens never carry key material. */
function redact(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join('<api-key>') : value;
}

export function projectRequest(captured: CapturedRequest, apiKey: string): GoldenRecord {
  const headers: Record<string, string> = {};
  for (const name of RECORDED_HEADERS) {
    const value = captured.headers[name];
    if (value !== undefined) headers[name] = redact(value, apiKey);
  }
  const query = Object.fromEntries(
    Object.entries(captured.query).map(([key, value]) => [key, redact(value, apiKey)]),
  );
  return sortKeys({
    method: captured.method,
    host: captured.host,
    path: captured.path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    headers,
    body: captured.body,
  }) as GoldenRecord;
}
