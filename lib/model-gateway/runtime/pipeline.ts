/**
 * The gateway call pipeline (plan 3.4). Every `stream()` runs these stages in
 * this order:
 *
 *   1 request validation (tools, toolChoice, images / vision)
 *   2 revocation fence (`beforeCall`, before every upstream attempt)
 *   3 entitlement (platform funding only)
 *   4 quota slot (background deployments), held until the stream terminates
 *   5 credential resolution
 *   6 per-attempt transport with side channel
 *   7 pi call (`maxRetries: 0`)
 *   8 event normalization (inline <think> split, truncated tool calls, empty text)
 *   9 classification and bounded retry
 *  10 per-attempt usage, settlement, structured log; quota release at the end
 */
import { createLogger } from '@/lib/logger';
import { getCanonicalModelId } from '@/lib/ai/model-aliases';
import { getCredentialHandle } from '../credentials/handles';
import { ambientAuthContext, sealedAuthContext } from '../credentials/auth-context';
import { explicitProviderEnv } from '../credentials/env-exposure';
import {
  credentialError,
  credentialFailure,
  defaultCredentialDatabase,
  openVaultStore,
  type CredentialDatabaseFactory,
} from '../credentials/vault-auth';
import { messageText } from '../messages';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  CompleteOptions,
  EntitlementGrant,
  EntitlementPolicy,
  GatewayCallOptions,
  GatewayRequest,
  GatewayResult,
  GatewayStream,
  GatewayStreamEvent,
  ModelBinding,
  ModelGateway,
  NormalizedUsage,
  PayloadPatchId,
  ThinkingContent,
  ToolCall,
  WireApi,
} from '../types';
import { classifyFailure } from './classify';
import { getEntitlementPolicy } from './entitlement';
import { GatewayError, describeInternalError } from './errors';
import { FETCHLESS_APIS, fetchlessRefusal } from './fetchless';
import { resolveImages, ImageInputError } from './images';
import {
  KEYLESS_API_KEY,
  authenticateModel,
  createCallModels,
  createCredentialModels,
  estimateCostUsd,
  getCustomProvider,
  loadPiProvider,
  streamModel,
} from './pi-registry';
import { acquireDeploymentQuota, type QuotaAcquirer, type QuotaLease } from './quota';
import { retryDelayMs, retryMode, type RetryMode } from './retry';
import { buildPayloadPatcher, planMaxTokens, planThinking } from './thinking';
import { splitInlineThinkTags } from './think-tag-splitter';
import { createTransport, type SideChannel } from './transport';
import { recordUsageEvent, toNormalizedUsage, type UsageEvent, type UsageRecorder } from './usage';
import type { AuthContext, Provider } from '@earendil-works/pi-ai';

const log = createLogger('ModelGateway');

const AMBIENT_PROVIDERS = new Set(['amazon-bedrock', 'google-vertex']);
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const BACKGROUND_DEADLINE_MS = 300_000;

export interface LlmCallLog {
  event: 'llm_call';
  source: string;
  providerId: string;
  modelId: string;
  api: string;
  funding: string;
  attempt: number;
  status: 'ok' | 'error' | 'aborted';
  errorCode?: string;
  requestSent: boolean;
  ttftMs?: number;
  durationMs: number;
  estimatedCostUsd?: number;
}

export interface ResolvedProvider {
  provider: Provider;
  authContext: AuthContext;
}

export interface GatewayDeps {
  quota: QuotaAcquirer;
  recordUsage: UsageRecorder;
  entitlement: () => EntitlementPolicy;
  resolveProvider: (binding: ModelBinding) => Promise<ResolvedProvider>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  logCall: (line: LlmCallLog) => void;
  /** Test seam: fetch used for official endpoints. */
  baseFetch?: typeof globalThis.fetch;
  /** Owner-bound vault access for signed-in accounts (plan 3.10). */
  credentialDatabase: CredentialDatabaseFactory;
}

async function defaultResolveProvider(binding: ModelBinding): Promise<ResolvedProvider> {
  const provider =
    binding.upstream === 'pi'
      ? await loadPiProvider(binding.model.provider)
      : getCustomProvider({
          id: binding.model.provider,
          api: binding.model.api as WireApi,
          baseUrl: binding.model.baseUrl,
        });
  const ambient = binding.endpoint === 'operator' && AMBIENT_PROVIDERS.has(binding.model.provider);
  return { provider, authContext: ambient ? ambientAuthContext() : sealedAuthContext() };
}

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

export const defaultDeps: GatewayDeps = {
  quota: acquireDeploymentQuota,
  recordUsage: recordUsageEvent,
  entitlement: getEntitlementPolicy,
  resolveProvider: defaultResolveProvider,
  sleep: sleepWithAbort,
  logCall: (line) => log.info(JSON.stringify(line)),
  credentialDatabase: defaultCredentialDatabase,
};

// ---------------------------------------------------------------------------
// Stream object: a replayable event log with any number of consumers.
// ---------------------------------------------------------------------------

class EventLog {
  readonly events: GatewayStreamEvent[] = [];
  private waiters: (() => void)[] = [];
  terminal?: Extract<GatewayStreamEvent, { type: 'done' | 'error' }>;
  result?: GatewayResult;

  push(event: GatewayStreamEvent): void {
    if (this.terminal) return;
    this.events.push(event);
    if (event.type === 'done' || event.type === 'error') this.terminal = event;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function resultFrom(message: AssistantMessage, attempts: number): GatewayResult {
  const reason = message.stopReason;
  return {
    message,
    text: messageText(message),
    reasoningText: message.content
      .filter((block): block is ThinkingContent => block.type === 'thinking')
      .map((block) => block.thinking)
      .join(''),
    toolCalls: message.content.filter((block): block is ToolCall => block.type === 'toolCall'),
    stopReason: reason === 'length' ? 'length' : reason === 'toolUse' ? 'toolUse' : 'stop',
    usage: toNormalizedUsage(message.usage),
    attempts,
  };
}

function createStreamHandle(eventLog: EventLog, cancel: (reason: unknown) => void): GatewayStream {
  const iterate = (): AsyncIterator<GatewayStreamEvent> => {
    let cursor = 0;
    return {
      async next() {
        while (cursor >= eventLog.events.length) {
          if (eventLog.terminal) return { done: true, value: undefined };
          await eventLog.wait();
        }
        return { done: false, value: eventLog.events[cursor++]! };
      },
      async return() {
        if (!eventLog.terminal) cancel(new DOMException('Stream consumer cancelled', 'AbortError'));
        cursor = Number.MAX_SAFE_INTEGER;
        return { done: true, value: undefined };
      },
    };
  };
  const handle: GatewayStream = {
    [Symbol.asyncIterator]: iterate,
    textStream() {
      return {
        [Symbol.asyncIterator]: () => {
          const source = iterate();
          return {
            async next(): Promise<IteratorResult<string>> {
              for (;;) {
                const item = await source.next();
                if (item.done) return { done: true, value: undefined };
                if (item.value.type === 'text_delta')
                  return { done: false, value: item.value.delta };
              }
            },
            async return() {
              await source.return?.();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    async result() {
      while (!eventLog.terminal) await eventLog.wait();
      const terminal = eventLog.terminal;
      if (terminal.type === 'error') throw terminal.gatewayError;
      return eventLog.result!;
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function validateRequest(binding: ModelBinding, req: GatewayRequest): void {
  const fail = () =>
    new GatewayError('MODEL_BAD_REQUEST', {
      providerId: binding.providerId,
      modelId: binding.modelId,
    });
  if (req.toolChoice && req.toolChoice !== 'auto' && req.toolChoice !== 'none') throw fail();
  const names = new Set<string>();
  for (const tool of req.tools ?? []) {
    const params = tool.parameters as unknown as Record<string, unknown> | undefined;
    if (!TOOL_NAME.test(tool.name) || names.has(tool.name) || params?.type !== 'object')
      throw fail();
    names.add(tool.name);
  }
  if (req.messages.length === 0 && !req.system) throw fail();
}

function syntheticFailure(binding: ModelBinding, error: GatewayError): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: binding.model.api,
    provider: binding.model.provider,
    model: binding.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: error.code === 'MODEL_ABORTED' ? 'aborted' : 'error',
    errorMessage: error.message,
    timestamp: Date.now(),
  };
}

/** Drop tool calls from a truncated turn and empty text blocks (plan 3.4 stage 8). */
function normalizeFinal(message: AssistantMessage): AssistantMessage {
  const content = message.content.filter(
    (block) =>
      !(block.type === 'text' && block.text.length === 0) &&
      !(message.stopReason === 'length' && block.type === 'toolCall'),
  );
  return content.length === message.content.length ? message : { ...message, content };
}

function apiKeyFor(binding: ModelBinding): string | undefined {
  const handle = getCredentialHandle(binding);
  switch (handle.kind) {
    case 'inline-key':
    case 'platform':
      return handle.apiKey;
    case 'operator':
      return handle.apiKey;
    case 'none':
      return KEYLESS_API_KEY;
    case 'vault':
      // pi resolves the signed-in account's token through the scoped store.
      return undefined;
  }
}

interface AttemptOutcome {
  ok: boolean;
  message: AssistantMessage;
  error?: GatewayError;
  channel: SideChannel;
  outputObserved: boolean;
}

export function runStream(
  deps: GatewayDeps,
  binding: ModelBinding,
  req: GatewayRequest,
  opts: GatewayCallOptions,
): GatewayStream {
  const eventLog = new EventLog();
  const internal = new AbortController();
  const mode: RetryMode = retryMode(opts.retry);
  const signals = [internal.signal];
  if (opts.signal) signals.push(opts.signal);
  if (mode === 'background') signals.push(AbortSignal.timeout(BACKGROUND_DEADLINE_MS));
  const signal = AbortSignal.any(signals);

  const handle = createStreamHandle(eventLog, (reason) => internal.abort(reason));
  void execute().catch((error: unknown) => {
    // Defensive: execute() reports its own failures; never leave consumers hanging.
    const gatewayError =
      error instanceof GatewayError
        ? error
        : new GatewayError('MODEL_UPSTREAM_UNAVAILABLE', {
            providerId: binding.providerId,
            modelId: binding.modelId,
            cause: error,
          });
    eventLog.push({
      type: 'error',
      reason: 'error',
      error: syntheticFailure(binding, gatewayError),
      gatewayError,
    });
  });
  return handle;

  async function execute(): Promise<void> {
    let lease: QuotaLease | undefined;
    let grant: EntitlementGrant | undefined;
    let finalError: GatewayError | undefined;
    const policy = deps.entitlement();
    try {
      // 1 validation and image resolution
      validateRequest(binding, req);
      let resolved;
      try {
        resolved = await resolveImages(req.messages, {
          vision: binding.capabilities.vision,
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new GatewayError(
          error instanceof ImageInputError ? 'MODEL_BAD_REQUEST' : 'MODEL_NETWORK',
          {
            providerId: binding.providerId,
            modelId: binding.modelId,
            cause: error,
          },
        );
      }
      if (resolved.droppedImages > 0) {
        log.warn(
          `[${opts.source}] dropped ${resolved.droppedImages} image(s): ${binding.modelString} has no vision input`,
        );
      }
      const context = { systemPrompt: req.system, messages: resolved.messages, tools: req.tools };

      // A binding missing a credential or a required endpoint value is never sent:
      // pi would otherwise fall back to process.env (P2-7).
      if (!binding.credentialReady) {
        throw new GatewayError('MODEL_CONFIGURATION', {
          providerId: binding.providerId,
          modelId: binding.modelId,
          requestSent: false,
        });
      }
      // Fetch-less SDK transports: only official / operator endpoints, no proxy (P2-6).
      const refusal = fetchlessRefusal(binding);
      if (refusal) {
        throw new GatewayError(refusal, {
          providerId: binding.providerId,
          modelId: binding.modelId,
          requestSent: false,
        });
      }

      // 3 entitlement (platform-funded calls only)
      if (binding.funding.kind === 'platform') {
        grant = await beforeSend('entitlement', () =>
          policy.authorize({ ownerId: opts.ownerId, binding, source: opts.source }),
        );
      }
      // 4 quota
      lease = await beforeSend('quota', () => deps.quota(signal));
      const attemptSignal = lease ? AbortSignal.any([signal, lease.signal]) : signal;

      const thinking = planThinking(binding);
      const tokens = planMaxTokens(binding, req.maxOutputTokens);
      const patchIds: PayloadPatchId[] = [
        ...binding.transforms.payloadPatches,
        ...thinking.patches,
      ];
      if (tokens.omit) patchIds.push('omit-max-tokens');
      const onPayload = buildPayloadPatcher(patchIds, {
        config: thinking.effective,
        level: thinking.reasoning,
        model: binding.model,
      });

      for (let attempt = 1; ; attempt += 1) {
        // 2 revocation fence before every upstream attempt
        await opts.beforeCall?.();
        attemptSignal.throwIfAborted();
        const startedAt = Date.now();
        const outcome = await runAttempt(attemptSignal, context, {
          reasoning: thinking.reasoning,
          thinkingBudgets: thinking.thinkingBudgets,
          maxTokens: tokens.maxTokens,
          onPayload,
        });
        // 10 per-attempt accounting
        const status = outcome.ok
          ? 'ok'
          : outcome.error?.code === 'MODEL_ABORTED'
            ? 'aborted'
            : 'error';
        const usage = toNormalizedUsage(outcome.message.usage);
        let estimatedCostUsd: number | undefined;
        try {
          estimatedCostUsd = estimateCostUsd(binding.model, outcome.message.usage);
        } catch {
          estimatedCostUsd = undefined;
        }
        recordAttempt(usage, attempt, status, estimatedCostUsd);
        if (grant) await settleSafely(policy, grant, { status, usage, estimatedCostUsd });
        deps.logCall({
          event: 'llm_call',
          source: opts.source,
          providerId: binding.providerId,
          modelId: binding.modelId,
          api: binding.model.api,
          funding: binding.funding.kind,
          attempt,
          status,
          errorCode: outcome.error?.code,
          requestSent: outcome.channel.requestSent || outcome.ok,
          ttftMs:
            outcome.channel.firstByteAt !== undefined
              ? outcome.channel.firstByteAt - startedAt
              : undefined,
          durationMs: Date.now() - startedAt,
          estimatedCostUsd,
        });

        if (outcome.ok) {
          eventLog.result = resultFrom(outcome.message, attempt);
          await lease?.release();
          lease = undefined;
          eventLog.push({
            type: 'done',
            reason: outcome.message.stopReason as 'stop' | 'length' | 'toolUse',
            message: outcome.message,
          });
          return;
        }
        const error = outcome.error!;
        const delay = attemptSignal.aborted
          ? undefined
          : retryDelayMs(error, attempt - 1, mode, binding.model.api);
        if (delay === undefined) {
          finalError = error;
          await lease?.release(error);
          lease = undefined;
          eventLog.push({
            type: 'error',
            reason: error.code === 'MODEL_ABORTED' ? 'aborted' : 'error',
            error: { ...outcome.message, errorMessage: error.message },
            gatewayError: error,
          });
          return;
        }
        await deps.sleep(delay, attemptSignal);
      }
    } catch (thrown) {
      const error =
        thrown instanceof GatewayError
          ? thrown
          : classifyFailure({
              providerId: binding.providerId,
              modelId: binding.modelId,
              thrown,
              outputObserved: false,
              aborted: signal.aborted,
            });
      finalError = error;
      await lease?.release(error);
      lease = undefined;
      eventLog.push({
        type: 'error',
        reason: error.code === 'MODEL_ABORTED' ? 'aborted' : 'error',
        error: syntheticFailure(binding, error),
        gatewayError: error,
      });
    } finally {
      await lease?.release(finalError);
    }
  }

  /**
   * Stages 3 and 4 run before anything is sent, so their failures (a credit
   * backend, the provider-slot table) are the gateway's own: they must never be
   * classified by provider error text ("permission denied" is not a bad key).
   */
  async function beforeSend<T>(stage: 'entitlement' | 'quota', work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      // Policy decisions (MODEL_ENTITLEMENT_DENIED) and cancellation keep their meaning.
      if (error instanceof GatewayError || signal.aborted) throw error;
      log.error(
        `[${opts.source}] ${stage} failed before the model request (${binding.providerId}:${binding.modelId}): ${describeInternalError(error)}`,
      );
      throw new GatewayError('MODEL_GATEWAY_UNAVAILABLE', {
        providerId: binding.providerId,
        modelId: binding.modelId,
        requestSent: false,
        safeToRetry: true,
        cause: error,
      });
    }
  }

  function recordAttempt(
    usage: NormalizedUsage,
    attempt: number,
    status: UsageEvent['status'],
    estimatedCostUsd: number | undefined,
  ): void {
    // Usage is attributed to the canonical model id (aliases resolved).
    const modelId = getCanonicalModelId(binding.providerId, binding.modelId);
    const funding = binding.funding;
    deps.recordUsage({
      source: opts.source,
      providerId: binding.providerId,
      modelId,
      modelString: binding.defaultId ? binding.modelString : `${binding.providerId}:${modelId}`,
      usage,
      fundingKind: funding.kind,
      ...(funding.kind === 'platform'
        ? { platformDefaultId: funding.defaultId, platformRevision: funding.revision }
        : {}),
      credentialKind: getCredentialHandle(binding).kind,
      api: binding.model.api,
      status,
      ...(estimatedCostUsd !== undefined && Number.isFinite(estimatedCostUsd)
        ? { estimatedCostUsd }
        : {}),
      jobId: opts.usage?.jobId,
      sessionId: opts.usage?.sessionId,
      requestId: opts.usage?.requestId,
      eventKey: opts.usage?.eventKey ? `${opts.usage.eventKey}:${attempt}` : undefined,
    });
  }

  async function runAttempt(
    attemptSignal: AbortSignal,
    context: Parameters<typeof streamModel>[2],
    plan: {
      reasoning?: Parameters<typeof streamModel>[3]['reasoning'];
      thinkingBudgets?: Parameters<typeof streamModel>[3]['thinkingBudgets'];
      maxTokens?: number;
      onPayload?: (payload: unknown) => unknown;
    },
  ): Promise<AttemptOutcome> {
    // 6 transport
    const transport = createTransport({
      endpoint: binding.endpoint,
      proxy: binding.proxy,
      baseFetch: deps.baseFetch,
    });
    let outputObserved = false;
    const fail = (error: GatewayError, message?: AssistantMessage): AttemptOutcome => ({
      ok: false,
      error,
      message: message ?? syntheticFailure(binding, error),
      channel: transport.channel,
      outputObserved,
    });
    const classify = (message?: AssistantMessage, thrown?: unknown) =>
      classifyFailure({
        providerId: binding.providerId,
        modelId: binding.modelId,
        contextWindow: binding.capabilities.contextWindow,
        channel: transport.channel,
        message,
        thrown,
        outputObserved,
        aborted: attemptSignal.aborted,
      });

    try {
      // 5 credentials, 7 pi call
      const apiKey = apiKeyFor(binding);
      const { provider, authContext } = await deps.resolveProvider(binding);
      const handle = getCredentialHandle(binding);
      let models = createCallModels(provider, authContext);
      if (handle.kind === 'vault') {
        try {
          const store = await openVaultStore(binding, handle, deps.credentialDatabase);
          models = createCredentialModels(provider, authContext, store);
          const auth = await authenticateModel(models, binding.model, attemptSignal);
          if (!auth) throw credentialError('MODEL_AUTH_FAILED', binding);
        } catch (error) {
          if (attemptSignal.aborted) throw error;
          return fail(credentialFailure(error, binding));
        }
      }
      const providerEnv = explicitProviderEnv(binding);
      const bearer =
        apiKey && binding.transforms.bearerKeyPrefixes?.some((prefix) => apiKey.startsWith(prefix));
      const source = streamModel(models, binding.model, context, {
        apiKey,
        ...(bearer ? { headers: { Authorization: `Bearer ${apiKey}`, 'x-api-key': null } } : {}),
        ...(Object.keys(providerEnv).length > 0 ? { env: providerEnv } : {}),
        ...(FETCHLESS_APIS.has(binding.model.api) ? {} : { fetch: transport.fetch }),
        signal: attemptSignal,
        maxRetries: 0,
        reasoning: plan.reasoning,
        thinkingBudgets: plan.thinkingBudgets,
        maxTokens: plan.maxTokens,
        toolChoice: req.toolChoice,
        temperature: req.temperature,
        sessionId: opts.sessionId,
        onPayload: plan.onPayload,
      });
      // 8 normalization
      const events: AsyncIterable<AssistantMessageEvent> = binding.transforms.inlineThinkTags
        ? splitInlineThinkTags(source)
        : source;
      let pendingStart: GatewayStreamEvent | undefined;
      for await (const event of events) {
        if (event.type === 'start') {
          pendingStart = event;
          continue;
        }
        if (event.type === 'done') {
          if (pendingStart) eventLog.push(pendingStart);
          return {
            ok: true,
            message: normalizeFinal(event.message),
            channel: transport.channel,
            outputObserved,
          };
        }
        if (event.type === 'error') return fail(classify(event.error), event.error);
        if (!outputObserved) {
          outputObserved = true;
          if (pendingStart) eventLog.push(pendingStart);
          pendingStart = undefined;
        }
        eventLog.push(event);
      }
      return fail(classify(undefined, new Error('stream ended without a terminal event')));
    } catch (thrown) {
      return fail(thrown instanceof GatewayError ? thrown : classify(undefined, thrown));
    }
  }
}

async function settleSafely(
  policy: EntitlementPolicy,
  grant: EntitlementGrant,
  outcome: Parameters<EntitlementPolicy['settle']>[1],
): Promise<void> {
  try {
    await policy.settle(grant, outcome);
  } catch (error) {
    log.warn('Entitlement settlement failed (ignored):', error);
  }
}

const nonEmpty = (text: string) => text.trim().length > 0;

export async function runComplete(
  deps: GatewayDeps,
  binding: ModelBinding,
  req: GatewayRequest,
  opts: CompleteOptions,
): Promise<GatewayResult> {
  const maxAttempts =
    retryMode(opts.retry) === 'background' ? 1 : Math.max(0, opts.validateRetries ?? 0) + 1;
  const validate = opts.validate ?? (maxAttempts > 1 ? nonEmpty : undefined);
  let attempts = 0;
  let lastResult: GatewayResult | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runStream(deps, binding, req, opts).result();
      attempts += result.attempts;
      if (validate && !validate(result.text)) {
        log.warn(`[${opts.source}] validation failed (attempt ${attempt}/${maxAttempts})`);
        lastResult = { ...result, attempts };
        continue;
      }
      return { ...result, attempts };
    } catch (error) {
      lastError = error;
      if (error instanceof GatewayError && error.code === 'MODEL_ABORTED') throw error;
    }
  }
  if (lastResult) return lastResult;
  throw lastError;
}

export function createGateway(overrides: Partial<GatewayDeps> = {}): ModelGateway {
  const deps: GatewayDeps = { ...defaultDeps, ...overrides };
  return {
    stream: (binding, req, opts) => runStream(deps, binding, req, opts),
    complete: (binding, req, opts) => runComplete(deps, binding, req, opts),
  };
}
