/**
 * The only application module that imports pi-ai runtime values (plan 3.2).
 *
 * - Provider instances are created once per process and cached (plan 3.5).
 * - Each call gets a lightweight `Models` view bound to a sealed AuthContext.
 * - Every lazily loaded pi entry point is a literal `import()` below, which also
 *   keeps it in Next's standalone file trace (scripts/smoke-pi-runtime.mjs).
 */
import {
  calculateCost as piCalculateCost,
  clampThinkingLevel as piClampThinkingLevel,
  createModels,
  createProvider,
  isContextOverflow as piIsContextOverflow,
  lazyApi,
  Type,
  type AuthContext,
  type AuthInteraction,
  type Context,
  type Credential,
  type CredentialStore,
  type MutableModels,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TSchema,
} from '@earendil-works/pi-ai';
import type { AssistantMessage, PiModel, PiThinkingLevel, PiUsage, WireApi } from '../types';

type ProviderModule = Record<string, unknown>;

/** pi provider id → its module (literal specifiers: traceable and bundler-safe). */
const PROVIDER_MODULES: Record<string, () => Promise<ProviderModule>> = {
  'amazon-bedrock': () => import('@earendil-works/pi-ai/providers/amazon-bedrock'),
  'ant-ling': () => import('@earendil-works/pi-ai/providers/ant-ling'),
  anthropic: () => import('@earendil-works/pi-ai/providers/anthropic'),
  'azure-openai-responses': () => import('@earendil-works/pi-ai/providers/azure-openai-responses'),
  baseten: () => import('@earendil-works/pi-ai/providers/baseten'),
  cerebras: () => import('@earendil-works/pi-ai/providers/cerebras'),
  'cloudflare-ai-gateway': () => import('@earendil-works/pi-ai/providers/cloudflare-ai-gateway'),
  'cloudflare-workers-ai': () => import('@earendil-works/pi-ai/providers/cloudflare-workers-ai'),
  deepseek: () => import('@earendil-works/pi-ai/providers/deepseek'),
  fireworks: () => import('@earendil-works/pi-ai/providers/fireworks'),
  'github-copilot': () => import('@earendil-works/pi-ai/providers/github-copilot'),
  google: () => import('@earendil-works/pi-ai/providers/google'),
  'google-vertex': () => import('@earendil-works/pi-ai/providers/google-vertex'),
  groq: () => import('@earendil-works/pi-ai/providers/groq'),
  huggingface: () => import('@earendil-works/pi-ai/providers/huggingface'),
  'kimi-coding': () => import('@earendil-works/pi-ai/providers/kimi-coding'),
  meta: () => import('@earendil-works/pi-ai/providers/meta'),
  minimax: () => import('@earendil-works/pi-ai/providers/minimax'),
  'minimax-cn': () => import('@earendil-works/pi-ai/providers/minimax-cn'),
  mistral: () => import('@earendil-works/pi-ai/providers/mistral'),
  moonshotai: () => import('@earendil-works/pi-ai/providers/moonshotai'),
  'moonshotai-cn': () => import('@earendil-works/pi-ai/providers/moonshotai-cn'),
  nvidia: () => import('@earendil-works/pi-ai/providers/nvidia'),
  openai: () => import('@earendil-works/pi-ai/providers/openai'),
  'openai-codex': () => import('@earendil-works/pi-ai/providers/openai-codex'),
  opencode: () => import('@earendil-works/pi-ai/providers/opencode'),
  'opencode-go': () => import('@earendil-works/pi-ai/providers/opencode-go'),
  openrouter: () => import('@earendil-works/pi-ai/providers/openrouter'),
  'qwen-token-plan': () => import('@earendil-works/pi-ai/providers/qwen-token-plan'),
  'qwen-token-plan-cn': () => import('@earendil-works/pi-ai/providers/qwen-token-plan-cn'),
  'qwen-token-plan-individual': () =>
    import('@earendil-works/pi-ai/providers/qwen-token-plan-individual'),
  together: () => import('@earendil-works/pi-ai/providers/together'),
  'vercel-ai-gateway': () => import('@earendil-works/pi-ai/providers/vercel-ai-gateway'),
  xai: () => import('@earendil-works/pi-ai/providers/xai'),
  xiaomi: () => import('@earendil-works/pi-ai/providers/xiaomi'),
  'xiaomi-token-plan-ams': () => import('@earendil-works/pi-ai/providers/xiaomi-token-plan-ams'),
  'xiaomi-token-plan-cn': () => import('@earendil-works/pi-ai/providers/xiaomi-token-plan-cn'),
  'xiaomi-token-plan-sgp': () => import('@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp'),
  zai: () => import('@earendil-works/pi-ai/providers/zai'),
  'zai-coding-cn': () => import('@earendil-works/pi-ai/providers/zai-coding-cn'),
};

/** Wire API implementations for custom (descriptor-defined) providers. */
const API_STREAMS: Record<WireApi, () => ProviderStreams> = {
  'openai-completions': () => lazyApi(() => import('@earendil-works/pi-ai/api/openai-completions')),
  'openai-responses': () => lazyApi(() => import('@earendil-works/pi-ai/api/openai-responses')),
  'anthropic-messages': () => lazyApi(() => import('@earendil-works/pi-ai/api/anthropic-messages')),
  'google-generative-ai': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/google-generative-ai')),
  'mistral-conversations': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/mistral-conversations')),
  'azure-openai-responses': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/azure-openai-responses')),
  'bedrock-converse-stream': () =>
    lazyApi(() => import('@earendil-works/pi-ai/api/bedrock-converse-stream')),
};

export const PI_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_MODULES));

/** Placeholder bearer for keyless local servers (pi requires a non-empty key). */
export const KEYLESS_API_KEY = 'no-key';

const providerCache = new Map<string, Promise<Provider>>();

/** Cached instance of a built-in pi provider. */
export function loadPiProvider(piProviderId: string): Promise<Provider> {
  let cached = providerCache.get(piProviderId);
  if (!cached) {
    const load = PROVIDER_MODULES[piProviderId];
    if (!load) return Promise.reject(new Error(`Unknown pi provider: ${piProviderId}`));
    cached = load().then((module) => {
      const factory = Object.entries(module).find(
        ([name, value]) => name.endsWith('Provider') && typeof value === 'function',
      )?.[1] as (() => Provider) | undefined;
      if (!factory) throw new Error(`pi provider module ${piProviderId} has no factory`);
      return factory();
    });
    cached.catch(() => providerCache.delete(piProviderId));
    providerCache.set(piProviderId, cached);
  }
  return cached;
}

const customCache = new Map<string, Provider>();

/**
 * Cached provider for a descriptor-defined endpoint. Its auth only accepts the
 * per-request key the gateway passes explicitly; it never resolves ambient env.
 */
export function getCustomProvider(input: { id: string; api: WireApi; baseUrl?: string }): Provider {
  const key = `${input.id}\u0000${input.api}\u0000${input.baseUrl ?? ''}`;
  let provider = customCache.get(key);
  if (!provider) {
    provider = createProvider({
      id: input.id,
      baseUrl: input.baseUrl,
      auth: {
        apiKey: {
          name: `${input.id} API key`,
          resolve: async ({ credential }) =>
            credential?.key ? { auth: { apiKey: credential.key }, source: 'request' } : undefined,
        },
      },
      models: [],
      api: API_STREAMS[input.api](),
    });
    customCache.set(key, provider);
  }
  return provider;
}

/** Per-call `Models` view: one provider, sealed (or ambient) auth context. */
export function createCallModels(provider: Provider, authContext: AuthContext): MutableModels {
  const models = createModels({ authContext });
  models.setProvider(provider);
  return models;
}

let oauthFlows: Promise<void> | undefined;

/**
 * pi loads its OAuth flows (sign-in, token refresh) through a variable
 * specifier that Next's file tracer cannot follow, so the standalone output
 * would lack them. This literal entry statically imports every flow and
 * registers them with pi; it is traced into both web and worker outputs.
 */
function ensureOAuthFlows(): Promise<void> {
  oauthFlows ??= import('@earendil-works/pi-ai/bun-oauth').then((module) =>
    module.registerBunOAuthFlows(),
  );
  oauthFlows.catch(() => {
    oauthFlows = undefined;
  });
  return oauthFlows;
}

/**
 * Per-call `Models` view for a signed-in account: pi reads, and refreshes
 * under the store's lock, the one credential the scoped store exposes.
 */
export function createCredentialModels(
  provider: Provider,
  authContext: AuthContext,
  credentials: CredentialStore,
): MutableModels {
  const models = createModels({ authContext, credentials });
  models.setProvider(provider);
  return models;
}

/** Resolve request auth up front so credential failures keep their cause. */
export async function authenticateModel(
  models: MutableModels,
  model: PiModel,
  signal: AbortSignal,
) {
  await ensureOAuthFlows();
  return models.getAuth(model, { signal });
}

/**
 * Run a provider's OAuth sign-in (plan 3.10). pi persists the result through
 * its credential store; here that store only captures it, so the caller
 * decides whether the credential is kept (the sign-in session may have been
 * cancelled meanwhile). The sealed context keeps ambient env out of the flow.
 */
export async function runProviderLogin(
  provider: Provider,
  authContext: AuthContext,
  interaction: AuthInteraction,
  deviceId: string,
): Promise<Credential> {
  let captured: Credential | undefined;
  const capture: CredentialStore = {
    read: async () => captured,
    list: async () => [],
    modify: async (_providerId, fn) => {
      const next = await fn(captured);
      if (next !== undefined) captured = next;
      return captured;
    },
    delete: async () => {
      captured = undefined;
    },
  };
  await ensureOAuthFlows();
  const models = createModels({ authContext, credentials: capture });
  models.setProvider(provider);
  return models.login(provider.id, 'oauth', interaction, { getDeviceId: () => deviceId });
}

export function streamModel(
  models: MutableModels,
  model: PiModel,
  context: Context,
  options: SimpleStreamOptions,
) {
  return models.streamSimple(model, context, options);
}

/** Adopt a JSON Schema object as a pi tool schema (the single allowed schema cast). */
export function toPiToolSchema(jsonSchema: Record<string, unknown>): TSchema {
  return Type.Unsafe(jsonSchema);
}

export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  return piIsContextOverflow(message, contextWindow);
}

export function estimateCostUsd(model: PiModel, usage: PiUsage): number {
  return piCalculateCost(model, usage).total;
}

export function clampThinkingLevel(
  model: PiModel,
  level: PiThinkingLevel | 'off',
): PiThinkingLevel | 'off' {
  return piClampThinkingLevel(model, level);
}

/** Warm the API module of a known model so the first request does not pay its import. */
export async function warmApi(api: WireApi): Promise<void> {
  const loaders: Partial<Record<WireApi, () => Promise<unknown>>> = {
    'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
    'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
    'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  };
  await loaders[api]?.();
}
