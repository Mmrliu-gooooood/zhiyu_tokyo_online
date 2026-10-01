/**
 * Provider descriptors (plan 3.3.6, 3.6): application provider id → upstream
 * (a built-in pi provider or a descriptor-defined endpoint), auth methods,
 * endpoint policy and UI grouping. Isomorphic and secret-free; never imports
 * the pi runtime.
 */
import type { PayloadPatchId, WireApi } from '../types';
import type { ProviderType } from '@/lib/types/provider';

export type ProviderGroup =
  | 'official'
  | 'china'
  | 'aggregator'
  | 'coding-plan'
  | 'subscription'
  | 'local'
  | 'enterprise';

/** `ambient` = AWS / Google ADC credentials, operator-managed only. */
export type AuthMethod = 'api-key' | 'oauth' | 'none' | 'ambient';

export type ModelDiscovery = 'catalog' | 'openai-models' | 'pi-refresh' | 'manual';

export interface EndpointProfile {
  piProviderId: string;
  /** i18n key of the profile label. */
  label: string;
}

export type DescriptorUpstream =
  | {
      kind: 'pi';
      piProviderId: string;
      /** Regional / plan variants; the first one is the default. */
      profiles?: Readonly<Record<string, EndpointProfile>>;
      /** Reviewed corrections over pi's per-model compat flags. */
      compat?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: 'custom';
      api: WireApi;
      /** pi compat flags every model of this endpoint shares. */
      compat?: Readonly<Record<string, unknown>>;
    };

export interface ProviderDescriptor {
  /** Application id; stable (persisted in settings and snapshots). */
  id: string;
  name: string;
  icon?: string;
  group: ProviderGroup;
  upstream: DescriptorUpstream;
  auth: readonly AuthMethod[];
  /** false = operator-managed only (Bedrock, Vertex). */
  userConfigurable: boolean;
  allowCustomBaseUrl: boolean;
  /** Wire APIs a user may pick for a custom endpoint (first = default). */
  allowedApis?: readonly WireApi[];
  modelDiscovery: ModelDiscovery;
  /** Split inline `<think>` text into thinking blocks. */
  inlineThinkTags?: boolean;
  payloadPatches?: readonly PayloadPatchId[];
  /** Legacy `type` kept for settings compatibility and the x-provider-type check. */
  legacyProviderType?: ProviderType;
  defaultBaseUrl?: string;
  baseUrlPlaceholder?: string;
  alternateBaseUrls?: readonly { label: string; url: string }[];
  /** A base URL is mandatory (account-specific endpoints such as Azure). */
  requiresBaseUrl?: boolean;
  /**
   * Non-secret per-connection values pi substitutes into the endpoint
   * (`{CLOUDFLARE_ACCOUNT_ID}`); passed per request, never read from env.
   */
  endpointParams?: readonly string[];
  /**
   * Without an explicit thinking choice, send the reviewed capability's default
   * (local chat templates that would otherwise think by default).
   */
  defaultThinkingFromCapability?: boolean;
  /** Key prefixes the upstream expects as `Authorization: Bearer` (MiniMax Token Plan). */
  bearerKeyPrefixes?: readonly string[];
  docsUrl?: string;
}

const OPENAI_COMPATIBLE_APIS: readonly WireApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

const DESCRIPTOR_LIST: readonly ProviderDescriptor[] = [
  // ---------------------------------------------------------------- existing 19
  {
    id: 'openai',
    name: 'OpenAI',
    icon: '/logos/openai.svg',
    group: 'official',
    upstream: { kind: 'pi', piProviderId: 'openai' },
    auth: ['api-key', 'oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    allowedApis: ['openai-completions', 'openai-responses'],
    modelDiscovery: 'openai-models',
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    icon: '/logos/azure.svg',
    group: 'enterprise',
    upstream: { kind: 'pi', piProviderId: 'azure-openai-responses' },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    requiresBaseUrl: true,
    modelDiscovery: 'manual',
    legacyProviderType: 'azure',
    baseUrlPlaceholder: 'https://YOUR-RESOURCE.openai.azure.com/openai',
  },
  {
    id: 'atlascloud',
    name: 'Atlas Cloud',
    group: 'aggregator',
    upstream: { kind: 'custom', api: 'openai-completions' },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.atlascloud.ai/v1',
  },
  {
    id: 'anthropic',
    name: 'Claude',
    icon: '/logos/claude.svg',
    group: 'official',
    upstream: { kind: 'pi', piProviderId: 'anthropic' },
    auth: ['api-key', 'oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'catalog',
    legacyProviderType: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    icon: '/logos/bedrock.svg',
    group: 'enterprise',
    upstream: { kind: 'pi', piProviderId: 'amazon-bedrock' },
    auth: ['ambient'],
    // Decision 2026-10-01: operator-managed only; no user Bedrock keys (P2-6).
    userConfigurable: false,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
    legacyProviderType: 'bedrock',
  },
  {
    id: 'google',
    name: 'Gemini',
    icon: '/logos/gemini.svg',
    group: 'official',
    upstream: { kind: 'pi', piProviderId: 'google' },
    auth: ['api-key'],
    userConfigurable: true,
    // Decision 2026-10-01: pi's Google adapter cannot take the gateway fetch, so
    // user endpoints are locked to the official host (P2-6).
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
    legacyProviderType: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'glm',
    name: 'GLM',
    icon: '/logos/glm.svg',
    group: 'china',
    // The general open.bigmodel.cn API; pi `zai` is the Coding Plan (zai-coding).
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: {
        thinkingFormat: 'zai',
        supportsDeveloperRole: false,
        supportsStore: false,
        maxTokensField: 'max_tokens',
      },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://open.bigmodel.cn/api/paas/v4' },
      { label: 'settings.baseUrlRegion.international', url: 'https://api.z.ai/api/paas/v4' },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    icon: '/logos/qwen.svg',
    group: 'china',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: {
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget',
        supportsReasoningEffort: false,
        supportsDeveloperRole: false,
        supportsStore: false,
      },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '/logos/deepseek.svg',
    group: 'official',
    upstream: { kind: 'pi', piProviderId: 'deepseek' },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    icon: '/logos/kimi.png',
    group: 'china',
    upstream: {
      kind: 'pi',
      piProviderId: 'moonshotai-cn',
      profiles: {
        cn: { piProviderId: 'moonshotai-cn', label: 'settings.baseUrlRegion.china' },
        global: { piProviderId: 'moonshotai', label: 'settings.baseUrlRegion.international' },
      },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://api.moonshot.cn/v1' },
      { label: 'settings.baseUrlRegion.international', url: 'https://api.moonshot.ai/v1' },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    icon: '/logos/minimax.svg',
    group: 'china',
    upstream: {
      kind: 'pi',
      piProviderId: 'minimax-cn',
      profiles: {
        cn: { piProviderId: 'minimax-cn', label: 'settings.baseUrlRegion.china' },
        global: { piProviderId: 'minimax', label: 'settings.baseUrlRegion.international' },
      },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'catalog',
    legacyProviderType: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://api.minimaxi.com/anthropic/v1' },
      {
        label: 'settings.baseUrlRegion.international',
        url: 'https://api.minimax.io/anthropic/v1',
      },
    ],
    bearerKeyPrefixes: ['sk-cp-'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    icon: '/logos/siliconflow.svg',
    group: 'aggregator',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: {
        thinkingFormat: 'qwen',
        thinkingTokenBudgetField: 'thinking_budget',
        supportsReasoningEffort: false,
        supportsStore: false,
      },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
  },
  {
    id: 'doubao',
    name: '豆包',
    icon: '/logos/doubao.svg',
    group: 'china',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: { supportsStore: false, supportsDeveloperRole: false },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '/logos/openrouter.svg',
    group: 'aggregator',
    // Legacy wire field; OpenRouter accepts both.
    upstream: { kind: 'pi', piProviderId: 'openrouter', compat: { maxTokensField: 'max_tokens' } },
    auth: ['api-key', 'oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'grok',
    name: 'Grok',
    icon: '/logos/grok.svg',
    group: 'official',
    upstream: { kind: 'pi', piProviderId: 'xai' },
    auth: ['api-key', 'oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
  },
  {
    id: 'tencent-hunyuan',
    name: 'Tencent Hunyuan',
    icon: '/logos/hunyuan.svg',
    group: 'china',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: { supportsStore: false, supportsDeveloperRole: false },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://tokenhub.tencentmaas.com/v1' },
      {
        label: 'settings.baseUrlRegion.international',
        url: 'https://tokenhub-intl.tencentmaas.com/v1',
      },
    ],
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    icon: '/logos/xiaomi.svg',
    group: 'china',
    upstream: {
      kind: 'pi',
      piProviderId: 'xiaomi',
      compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
    },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.xiaomiPayg', url: 'https://api.xiaomimimo.com/v1' },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanCN',
        url: 'https://token-plan-cn.xiaomimimo.com/v1',
      },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanSGP',
        url: 'https://token-plan-sgp.xiaomimimo.com/v1',
      },
      {
        label: 'settings.baseUrlRegion.xiaomiTokenPlanEU',
        url: 'https://token-plan-ams.xiaomimimo.com/v1',
      },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    icon: '/logos/ollama.svg',
    group: 'local',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
      },
    },
    auth: ['none'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
  },
  {
    id: 'lemonade',
    name: 'Lemonade',
    icon: '/logos/lemonade.svg',
    group: 'local',
    upstream: {
      kind: 'custom',
      api: 'openai-completions',
      compat: {
        supportsUsageInStreaming: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStore: false,
      },
    },
    auth: ['none'],
    userConfigurable: true,
    allowCustomBaseUrl: true,
    modelDiscovery: 'openai-models',
    inlineThinkTags: true,
    legacyProviderType: 'openai',
    defaultBaseUrl: 'http://localhost:13305/v1',
    defaultThinkingFromCapability: true,
  },

  // ---------------------------------------------------------------- new: official / aggregators
  ...(
    [
      ['groq', 'Groq', 'official'],
      ['cerebras', 'Cerebras', 'official'],
      ['mistral', 'Mistral', 'official'],
      ['meta', 'Meta', 'official'],
      ['ant-ling', 'Ant Ling', 'china'],
      ['together', 'Together AI', 'aggregator'],
      ['fireworks', 'Fireworks', 'aggregator'],
      ['huggingface', 'Hugging Face', 'aggregator'],
      ['nvidia', 'NVIDIA', 'aggregator'],
      ['baseten', 'Baseten', 'aggregator'],
      ['vercel-ai-gateway', 'Vercel AI Gateway', 'aggregator'],
      ['opencode', 'OpenCode Zen', 'aggregator'],
      ['opencode-go', 'OpenCode Go', 'aggregator'],
    ] as const
  ).map(
    ([id, name, group]): ProviderDescriptor => ({
      id,
      name,
      group,
      upstream: { kind: 'pi', piProviderId: id },
      auth: id === 'meta' ? ['api-key', 'oauth'] : ['api-key'],
      userConfigurable: true,
      allowCustomBaseUrl: false,
      modelDiscovery: 'catalog',
    }),
  ),
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    group: 'aggregator',
    upstream: { kind: 'pi', piProviderId: 'cloudflare-workers-ai' },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
    endpointParams: ['CLOUDFLARE_ACCOUNT_ID'],
  },
  {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    group: 'aggregator',
    upstream: { kind: 'pi', piProviderId: 'cloudflare-ai-gateway' },
    auth: ['api-key'],
    userConfigurable: true,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
    endpointParams: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  },
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    icon: '/logos/gemini.svg',
    group: 'enterprise',
    upstream: { kind: 'pi', piProviderId: 'google-vertex' },
    auth: ['ambient'],
    userConfigurable: false,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
  },

  // ---------------------------------------------------------------- new: Coding / Token Plans
  ...(
    [
      ['zai-coding', 'zai', 'Z.AI Coding Plan'],
      ['zai-coding-cn', 'zai-coding-cn', 'GLM Coding Plan (China)'],
      ['kimi-coding', 'kimi-coding', 'Kimi Coding'],
      ['qwen-token-plan', 'qwen-token-plan', 'Qwen Token Plan'],
      ['qwen-token-plan-cn', 'qwen-token-plan-cn', 'Qwen Token Plan (China)'],
      ['qwen-token-plan-individual', 'qwen-token-plan-individual', 'Qwen Token Plan (Individual)'],
      ['xiaomi-token-plan-cn', 'xiaomi-token-plan-cn', 'MiMo Token Plan (China)'],
      ['xiaomi-token-plan-ams', 'xiaomi-token-plan-ams', 'MiMo Token Plan (Europe)'],
      ['xiaomi-token-plan-sgp', 'xiaomi-token-plan-sgp', 'MiMo Token Plan (Singapore)'],
    ] as const
  ).map(
    ([id, piProviderId, name]): ProviderDescriptor => ({
      id,
      name,
      group: 'coding-plan',
      upstream: { kind: 'pi', piProviderId },
      auth: id === 'kimi-coding' ? ['api-key', 'oauth'] : ['api-key'],
      userConfigurable: true,
      allowCustomBaseUrl: false,
      modelDiscovery: 'catalog',
    }),
  ),

  // ---------------------------------------------------------------- new: subscriptions (R2)
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    group: 'subscription',
    upstream: { kind: 'pi', piProviderId: 'github-copilot' },
    auth: ['oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    group: 'subscription',
    upstream: { kind: 'pi', piProviderId: 'openai-codex' },
    auth: ['oauth'],
    userConfigurable: true,
    allowCustomBaseUrl: false,
    modelDiscovery: 'catalog',
  },
];

export const PROVIDER_DESCRIPTORS: Readonly<Record<string, ProviderDescriptor>> = Object.freeze(
  Object.fromEntries(DESCRIPTOR_LIST.map((descriptor) => [descriptor.id, descriptor])),
);

/** The 19 application providers that existed before the gateway (settings-compatible). */
export const LEGACY_PROVIDER_IDS = Object.freeze([
  'openai',
  'azure',
  'atlascloud',
  'anthropic',
  'bedrock',
  'google',
  'glm',
  'qwen',
  'deepseek',
  'kimi',
  'minimax',
  'siliconflow',
  'doubao',
  'openrouter',
  'grok',
  'tencent-hunyuan',
  'xiaomi',
  'ollama',
  'lemonade',
] as const);

export function getDescriptor(providerId: string): ProviderDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DESCRIPTORS, providerId)
    ? PROVIDER_DESCRIPTORS[providerId]
    : undefined;
}

/** Wire APIs a user-defined (`custom-*`) provider may speak. */
export const CUSTOM_PROVIDER_APIS = OPENAI_COMPATIBLE_APIS;

/** Legacy `x-provider-type` → wire API (plan 3.3.1). */
export function apiForLegacyProviderType(type: string | undefined): WireApi | undefined {
  switch (type) {
    case 'openai':
      return 'openai-completions';
    case 'anthropic':
      return 'anthropic-messages';
    case 'azure':
      return 'azure-openai-responses';
    case 'google':
      return 'google-generative-ai';
    case 'bedrock':
      return 'bedrock-converse-stream';
    default:
      return undefined;
  }
}
