/**
 * Model gateway contracts (isomorphic, type-only).
 *
 * The canonical message format is pi-ai's message/event protocol, re-exported
 * here so the rest of the application never imports pi-ai directly (plan D3).
 * Only `import type` from pi-ai is allowed in this file.
 */
import type {
  Api as PiApi,
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Message as PiMessage,
  Model,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ThinkingLevel as PiThinkingLevel,
  Tool as PiTool,
  ToolCall,
  ToolResultMessage,
  Usage as PiUsage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { PlatformDefaultId } from '@/lib/types/platform-default-models';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import type { NormalizedUsage } from '@/lib/usage/normalize';

export type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  PiApi,
  PiThinkingLevel,
  PiUsage,
  SystemMessage,
  TextContent,
  ThinkingCapability,
  ThinkingConfig,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  NormalizedUsage,
};

/** A pi chat model description (already resolved: baseUrl, api, compat, windows). */
export type PiModel = Model<PiApi>;

/** Wire protocols a selection may name; the descriptor decides which are allowed. */
export type WireApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations'
  | 'azure-openai-responses'
  | 'bedrock-converse-stream';

/** Platform-provided text models. Derived from the platform default ids, never hard-coded. */
export type TextPlatformDefaultId = Extract<PlatformDefaultId, `${string}-text`>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** An image the caller references by URL; the gateway downloads it under SSRF control. */
export interface ImageUrlContent {
  type: 'image_url';
  url: string;
}

export interface GatewayUserMessage extends Omit<UserMessage, 'content'> {
  content: string | (TextContent | ImageContent | ImageUrlContent)[];
}

/** Request messages: pi messages, with user images optionally given by URL. */
export type GatewayMessage =
  | GatewayUserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage;

/** pi message after image URLs were resolved. */
export type ResolvedMessage = PiMessage;

/** Tool declaration with a JSON-Schema `parameters` object. */
export type GatewayTool = PiTool;

// ---------------------------------------------------------------------------
// Funding, entitlement
// ---------------------------------------------------------------------------

export type FundingSource =
  | { kind: 'platform'; defaultId: TextPlatformDefaultId; revision: string }
  | { kind: 'operator' }
  | { kind: 'byok' }
  | { kind: 'subscription'; credentialId: string }
  | { kind: 'local' };

export interface EntitlementGrant {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface EntitlementSettlement {
  status: 'ok' | 'error' | 'aborted';
  usage: NormalizedUsage;
  estimatedCostUsd?: number;
}

export interface EntitlementPolicy {
  /** Only for `funding.kind === 'platform'`; rejects with MODEL_ENTITLEMENT_DENIED. */
  authorize(ctx: {
    ownerId?: string;
    binding: ModelBinding;
    source: string;
  }): Promise<EntitlementGrant>;
  /** Called once per upstream attempt (ok, error or aborted). */
  settle(grant: EntitlementGrant, outcome: EntitlementSettlement): Promise<void>;
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** Declarative request-body patches; implementations live in runtime/thinking.ts. */
export type PayloadPatchId =
  | 'doubao-thinking-auto'
  | 'openrouter-exclude-reasoning'
  | 'omit-max-tokens'
  /** No explicit thinking intent: strip every thinking field (provider default). */
  | 'provider-default-thinking'
  /** Anthropic managed-effort models: pi pins effort to high; send the requested one. */
  | 'anthropic-managed-effort'
  /** Thinking on without a chosen budget: do not send a top-level budget field. */
  | 'omit-thinking-budget'
  /** GLM (zai format): drop pi's clear_thinking:false so the API default applies. */
  | 'zai-default-clear-thinking';

export interface ModelCapabilities {
  tools: boolean | 'unknown';
  vision: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutputTokens?: number;
  knownModel: boolean;
  /** Reviewed application thinking capability (drives defaults and the UI). */
  thinking?: ThinkingCapability;
}

export interface ModelTransforms {
  /** Split inline `<think>…</think>` text into thinking blocks. */
  inlineThinkTags: boolean;
  payloadPatches: readonly PayloadPatchId[];
}

export type EndpointKind = 'official' | 'operator' | 'user' | 'local';

/**
 * Immutable server-side result of resolving a model selection. Never carries a
 * credential in an enumerable field: the handle lives in credentials/handles.ts.
 */
export interface ModelBinding {
  readonly source: 'platform' | 'user' | 'legacy-managed';
  readonly routedStage?: string;
  readonly providerId: string;
  readonly modelId: string;
  /** `provider:model`, or `platform:<defaultId>`. */
  readonly modelString: string;
  readonly defaultId?: TextPlatformDefaultId;
  readonly revision?: string;
  readonly model: Readonly<PiModel>;
  /**
   * `pi`: `model.provider` is a built-in pi provider id. `custom`: a
   * descriptor-defined endpoint speaking `model.api` (provider built on demand).
   */
  readonly upstream: 'pi' | 'custom';
  readonly capabilities: Readonly<ModelCapabilities>;
  readonly transforms: Readonly<ModelTransforms>;
  /** Arbitrated effective thinking configuration. */
  readonly thinking?: ThinkingConfig;
  readonly funding: FundingSource;
  readonly endpoint: EndpointKind;
  /** Operator-configured outbound proxy (operator endpoints only). */
  readonly proxy?: string;
  readonly credentialReady: boolean;
  /** Hash of non-secret fields for logs and diagnostics. */
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface GatewayRequest {
  system?: string;
  messages: GatewayMessage[];
  tools?: GatewayTool[];
  /** pi supports only these two; business code uses `auto`. */
  toolChoice?: 'auto' | 'none';
  maxOutputTokens?: number | 'model-default' | 'omit';
  temperature?: number;
}

export interface GatewayUsageContext {
  jobId?: string;
  sessionId?: string;
  requestId?: string;
  eventKey?: string;
}

export interface GatewayCallOptions {
  /** Stage / purpose label for usage, logs and limiter groups. */
  source: string;
  signal?: AbortSignal;
  /** Revocation fence run before every upstream attempt. */
  beforeCall?: () => Promise<void>;
  /** Background deployments force `none`. */
  retry?: 'default' | 'none';
  /** Prompt-cache affinity. */
  sessionId?: string;
  usage?: GatewayUsageContext;
  /** Owner used for entitlement; quota owner comes from the provider-call context. */
  ownerId?: string;
}

export interface CompleteOptions extends GatewayCallOptions {
  /** Accept or reject the final text; rejected results are retried. */
  validate?: (text: string) => boolean;
  validateRetries?: number;
}

export type GatewayStopReason = 'stop' | 'length' | 'toolUse';

export interface GatewayResult {
  message: AssistantMessage;
  text: string;
  reasoningText: string;
  toolCalls: ToolCall[];
  stopReason: GatewayStopReason;
  usage: NormalizedUsage;
  /** Upstream attempts made for this result (including transport retries). */
  attempts: number;
}

/** Thrown-error shape carried on terminal `error` events; see runtime/errors.ts. */
export interface GatewayErrorLike extends Error {
  readonly code: string;
}

/**
 * pi events, except that the terminal `error` event also carries the classified
 * gateway error. Iteration never throws: streams end with `done` or `error`.
 */
export type GatewayStreamEvent =
  | Exclude<AssistantMessageEvent, { type: 'error' }>
  | {
      type: 'error';
      reason: 'aborted' | 'error';
      error: AssistantMessage;
      gatewayError: GatewayErrorLike;
    };

export interface GatewayStream extends AsyncIterable<GatewayStreamEvent> {
  textStream(): AsyncIterable<string>;
  /** Resolves on `done`; rejects with the GatewayError on `error`. */
  result(): Promise<GatewayResult>;
}

export interface ModelGateway {
  stream(binding: ModelBinding, req: GatewayRequest, opts: GatewayCallOptions): GatewayStream;
  complete(
    binding: ModelBinding,
    req: GatewayRequest,
    opts: CompleteOptions,
  ): Promise<GatewayResult>;
}
