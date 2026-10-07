/**
 * Embedding calls (learning plan B03). pi-ai has no embedding API, so the
 * gateway speaks the OpenAI-compatible `POST {baseUrl}/embeddings` itself,
 * through the same stages as text calls: binding with a private credential,
 * revocation fence, quota slot (background deployments), per-attempt
 * transport, classification with bounded retry, and per-attempt usage and
 * structured log. Business code never calls an embedding endpoint directly.
 *
 * Embeddings are operator-funded in this release: the model is the server's
 * configured provider (STUDY_EMBEDDING_MODEL names a provider from the server
 * provider configuration), never a browser-supplied key or endpoint.
 */
import { createHash } from 'node:crypto';

import { createLogger } from '@/lib/logger';
import {
  isServerConfiguredProvider,
  resolveApiKey,
  resolveBaseUrl,
  resolveProxy,
} from '@/lib/server/provider-config';

import { getDescriptor } from '../catalog/descriptors';
import type { FundingSource } from '../types';
import { GatewayError, describeInternalError, type GatewayErrorCode } from './errors';
import { acquireDeploymentQuota, type QuotaAcquirer, type QuotaLease } from './quota';
import { createTransport, type SideChannel } from './transport';
import { recordUsageEvent, type UsageRecorder } from './usage';

const log = createLogger('ModelGateway');

/** Frozen, credential-free description of one embedding model. */
export interface EmbeddingBinding {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelString: string;
  readonly baseUrl: string;
  readonly dimensions: number;
  /** Send `dimensions` in the request (models with adjustable output width). */
  readonly requestDimensions: boolean;
  readonly funding: FundingSource;
  readonly endpoint: 'operator';
  readonly proxy?: string;
  readonly credentialReady: boolean;
  /** Identity of the vector space: changing it means re-embedding everything. */
  readonly signature: string;
}

const credentials = new WeakMap<EmbeddingBinding, string>();

export interface EmbeddingSpec {
  providerId: string;
  modelId: string;
  dimensions: number;
  requestDimensions?: boolean;
}

/** Operator-configured embedding binding, or null when the provider is not configured. */
export function resolveOperatorEmbeddingBinding(spec: EmbeddingSpec): EmbeddingBinding | null {
  if (!isServerConfiguredProvider('providers', spec.providerId)) return null;
  // Server base URL, else the provider's official endpoint.
  const baseUrl = resolveBaseUrl(spec.providerId) ?? getDescriptor(spec.providerId)?.defaultBaseUrl;
  if (!baseUrl) return null;
  const apiKey = resolveApiKey(spec.providerId);
  return createEmbeddingBinding(spec, { baseUrl, apiKey, proxy: resolveProxy(spec.providerId) });
}

/** Build a binding from explicit values (operator configuration, tests). */
export function createEmbeddingBinding(
  spec: EmbeddingSpec,
  endpoint: { baseUrl: string; apiKey: string; proxy?: string },
): EmbeddingBinding {
  const modelString = `${spec.providerId}:${spec.modelId}`;
  const binding: EmbeddingBinding = Object.freeze({
    providerId: spec.providerId,
    modelId: spec.modelId,
    modelString,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
    dimensions: spec.dimensions,
    requestDimensions: spec.requestDimensions === true,
    funding: Object.freeze({ kind: 'operator' }) as FundingSource,
    endpoint: 'operator',
    ...(endpoint.proxy ? { proxy: endpoint.proxy } : {}),
    credentialReady: endpoint.apiKey.length > 0,
    signature: `${modelString}#${spec.dimensions}#${createHash('sha256')
      .update(endpoint.baseUrl)
      .digest('hex')
      .slice(0, 8)}`,
  });
  credentials.set(binding, endpoint.apiKey);
  return binding;
}

export interface EmbedOptions {
  /** Purpose label for usage and logs, e.g. `study-index` / `study-query`. */
  source: string;
  signal?: AbortSignal;
  beforeCall?: () => Promise<void>;
  /** `none` in background deployments' durable tasks that retry themselves. */
  retry?: 'default' | 'none';
  ownerId?: string;
  usage?: { jobId?: string; requestId?: string; eventKey?: string };
}

export interface EmbedResult {
  vectors: number[][];
  /** Prompt tokens the provider reported; null when it reported none. */
  inputTokens: number | null;
  attempts: number;
}

export interface EmbeddingCallLog {
  event: 'embedding_call';
  source: string;
  providerId: string;
  modelId: string;
  funding: string;
  attempt: number;
  inputs: number;
  status: 'ok' | 'error' | 'aborted';
  errorCode?: string;
  requestSent: boolean;
  durationMs: number;
}

export interface EmbeddingGatewayDeps {
  quota: QuotaAcquirer;
  recordUsage: UsageRecorder;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  logCall: (line: EmbeddingCallLog) => void;
  baseFetch?: typeof globalThis.fetch;
}

export const MAX_EMBEDDING_INPUTS = 64;
export const MAX_EMBEDDING_INPUT_CHARS = 8000;
const EMBEDDING_TIMEOUT_MS = 60_000;

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const defaultDeps: EmbeddingGatewayDeps = {
  quota: acquireDeploymentQuota,
  recordUsage: recordUsageEvent,
  sleep: sleepWithAbort,
  logCall: (line) => log.info(JSON.stringify(line)),
};

function failure(
  binding: EmbeddingBinding,
  code: GatewayErrorCode,
  channel: SideChannel | undefined,
  cause?: unknown,
): GatewayError {
  const retryAfter = Number(channel?.headers['retry-after']);
  return new GatewayError(code, {
    providerId: binding.providerId,
    modelId: binding.modelId,
    status: channel?.status,
    requestSent: channel?.requestSent ?? false,
    safeToRetry: !(channel?.requestSent ?? false),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
    cause,
  });
}

function classifyStatus(status: number): GatewayErrorCode {
  if (status === 401 || status === 403) return 'MODEL_AUTH_FAILED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408) return 'MODEL_TIMEOUT';
  if (status === 429) return 'MODEL_RATE_LIMITED';
  if (status >= 500) return 'MODEL_UPSTREAM_UNAVAILABLE';
  return 'MODEL_BAD_REQUEST';
}

const RETRYABLE = new Set<GatewayErrorCode>([
  'MODEL_RATE_LIMITED',
  'MODEL_UPSTREAM_UNAVAILABLE',
  'MODEL_NETWORK',
  'MODEL_TIMEOUT',
]);

function parseVectors(binding: EmbeddingBinding, body: unknown, count: number) {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== count) return null;
  const vectors: number[][] = new Array(count);
  for (const item of data) {
    const index = (item as { index?: unknown }).index;
    const embedding = (item as { embedding?: unknown }).embedding;
    if (
      typeof index !== 'number' ||
      index < 0 ||
      index >= count ||
      vectors[index] ||
      !Array.isArray(embedding) ||
      embedding.length !== binding.dimensions ||
      !embedding.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      return null;
    }
    vectors[index] = embedding as number[];
  }
  const tokens = (body as { usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }).usage;
  const reported = Number(tokens?.prompt_tokens ?? tokens?.total_tokens);
  return { vectors, inputTokens: Number.isFinite(reported) && reported > 0 ? reported : null };
}

export async function runEmbed(
  deps: EmbeddingGatewayDeps,
  binding: EmbeddingBinding,
  inputs: readonly string[],
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const ids = { providerId: binding.providerId, modelId: binding.modelId };
  if (
    inputs.length === 0 ||
    inputs.length > MAX_EMBEDDING_INPUTS ||
    inputs.some((text) => !text.trim() || text.length > MAX_EMBEDDING_INPUT_CHARS)
  ) {
    throw new GatewayError('MODEL_BAD_REQUEST', ids);
  }
  const apiKey = credentials.get(binding);
  if (!binding.credentialReady || apiKey === undefined) {
    throw new GatewayError('MODEL_CONFIGURATION', { ...ids, requestSent: false });
  }
  const signal = AbortSignal.any([
    ...(opts.signal ? [opts.signal] : []),
    AbortSignal.timeout(EMBEDDING_TIMEOUT_MS * 3),
  ]);
  let lease: QuotaLease | undefined;
  let finalError: unknown;
  try {
    try {
      lease = await deps.quota(signal);
    } catch (error) {
      // The slot table is the gateway's own: nothing was sent (see pipeline beforeSend).
      if (error instanceof GatewayError || signal.aborted) throw error;
      log.error(
        `[${opts.source}] quota failed before the embedding request (${binding.providerId}:${binding.modelId}): ${describeInternalError(error)}`,
      );
      throw failure(binding, 'MODEL_GATEWAY_UNAVAILABLE', undefined, error);
    }
    const attemptSignal = lease ? AbortSignal.any([signal, lease.signal]) : signal;
    const maxAttempts = opts.retry === 'none' ? 1 : 3;
    for (let attempt = 1; ; attempt += 1) {
      await opts.beforeCall?.();
      attemptSignal.throwIfAborted();
      const transport = createTransport({
        endpoint: 'operator',
        proxy: binding.proxy,
        baseFetch: deps.baseFetch,
      });
      const startedAt = Date.now();
      let error: GatewayError | undefined;
      let result: { vectors: number[][]; inputTokens: number | null } | null = null;
      try {
        const response = await transport.fetch(`${binding.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: binding.modelId,
            input: inputs,
            encoding_format: 'float',
            ...(binding.requestDimensions ? { dimensions: binding.dimensions } : {}),
          }),
          signal: AbortSignal.any([attemptSignal, AbortSignal.timeout(EMBEDDING_TIMEOUT_MS)]),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          error = failure(binding, classifyStatus(response.status), transport.channel);
        } else {
          result = parseVectors(binding, await response.json(), inputs.length);
          if (!result) error = failure(binding, 'MODEL_BAD_REQUEST', transport.channel);
        }
      } catch (thrown) {
        error = attemptSignal.aborted
          ? failure(binding, 'MODEL_ABORTED', transport.channel, thrown)
          : failure(
              binding,
              thrown instanceof Error && thrown.name === 'TimeoutError'
                ? 'MODEL_TIMEOUT'
                : 'MODEL_NETWORK',
              transport.channel,
              thrown,
            );
      }
      const status = error ? (error.code === 'MODEL_ABORTED' ? 'aborted' : 'error') : 'ok';
      deps.recordUsage({
        source: opts.source,
        providerId: binding.providerId,
        modelId: binding.modelId,
        modelString: binding.modelString,
        usage: {
          inputTokens: result?.inputTokens ?? 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
        fundingKind: binding.funding.kind,
        credentialKind: 'operator',
        api: 'openai-embeddings',
        status,
        jobId: opts.usage?.jobId,
        requestId: opts.usage?.requestId,
        eventKey: opts.usage?.eventKey ? `${opts.usage.eventKey}:${attempt}` : undefined,
      });
      deps.logCall({
        event: 'embedding_call',
        source: opts.source,
        providerId: binding.providerId,
        modelId: binding.modelId,
        funding: binding.funding.kind,
        attempt,
        inputs: inputs.length,
        status,
        errorCode: error?.code,
        requestSent: transport.channel.requestSent,
        durationMs: Date.now() - startedAt,
      });
      if (!error && result) {
        return { vectors: result.vectors, inputTokens: result.inputTokens, attempts: attempt };
      }
      if (!error || !RETRYABLE.has(error.code) || attempt >= maxAttempts || attemptSignal.aborted) {
        throw error;
      }
      await deps.sleep(
        Math.min(10_000, error.retryAfterMs ?? 500 * 2 ** (attempt - 1)),
        attemptSignal,
      );
    }
  } catch (error) {
    finalError = error;
    if (error instanceof GatewayError) throw error;
    throw failure(binding, signal.aborted ? 'MODEL_ABORTED' : 'MODEL_NETWORK', undefined, error);
  } finally {
    await lease?.release(finalError);
  }
}

export interface EmbeddingGateway {
  embed(
    binding: EmbeddingBinding,
    inputs: readonly string[],
    opts: EmbedOptions,
  ): Promise<EmbedResult>;
}

export function createEmbeddingGateway(
  overrides: Partial<EmbeddingGatewayDeps> = {},
): EmbeddingGateway {
  const deps = { ...defaultDeps, ...overrides };
  return { embed: (binding, inputs, opts) => runEmbed(deps, binding, inputs, opts) };
}

/** The process-wide embedding gateway. */
export const embeddingGateway: EmbeddingGateway = createEmbeddingGateway();
