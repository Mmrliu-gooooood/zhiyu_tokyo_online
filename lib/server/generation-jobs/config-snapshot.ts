import * as providers from '@/lib/server/provider-config';
import { canonicalHash, GenerationJobError, type GenerationInput } from './contracts';

/** Only the digest leaves this function. Credentials and private URLs never enter jobs. */
export function generationProviderConfigVersion(): string {
  const section = (
    entries: Record<string, unknown>,
    key: (id: string) => unknown,
    url: (id: string) => unknown,
    model?: (id: string) => unknown,
  ) =>
    Object.fromEntries(
      Object.entries(entries).map(([id, info]) => [
        id,
        { info, key: key(id), url: url(id), model: model?.(id) },
      ]),
    );
  return canonicalHash({
    llm: section(providers.getServerProviders(), providers.resolveApiKey, providers.resolveBaseUrl),
    tts: section(
      providers.getServerTTSProviders(),
      providers.resolveTTSApiKey,
      providers.resolveTTSBaseUrl,
    ),
    image: section(
      providers.getServerImageProviders(),
      providers.resolveImageApiKey,
      providers.resolveImageBaseUrl,
      providers.resolveImageModel,
    ),
    video: section(
      providers.getServerVideoProviders(),
      providers.resolveVideoApiKey,
      providers.resolveVideoBaseUrl,
      providers.resolveVideoModel,
    ),
    pdf: section(
      providers.getServerPDFProviders(),
      providers.resolvePDFApiKey,
      providers.resolvePDFBaseUrl,
    ),
    search: section(
      providers.getServerWebSearchProviders(),
      providers.resolveWebSearchApiKey,
      providers.resolveWebSearchBaseUrl,
      providers.resolveWebSearchModel,
    ),
    defaultModel: process.env.DEFAULT_MODEL ?? '',
    routes: process.env.MODEL_ROUTES ?? '',
    thinkingDisabled: process.env.LLM_THINKING_DISABLED ?? '',
    vocational: process.env.OPENMAIC_ENABLE_VOCATIONAL ?? '',
  });
}
export function assertGenerationConfigSnapshot(input: GenerationInput): void {
  const version = input.model?.configVersion;
  if (version && version !== generationProviderConfigVersion())
    throw new GenerationJobError('GENERATION_CONFIG_CHANGED', 409);
}
/**
 * Server configuration and an owner-scoped media snapshot are separate version domains.
 * The media value hashes only the opaque reference; plaintext configuration is never read here.
 */
export function generationConfigVersions(input: GenerationInput): {
  server: string;
  media?: string;
} {
  return {
    server: generationProviderConfigVersion(),
    media: input.mediaConfigRef
      ? canonicalHash({ namespace: 'media-config-ref:v1', ref: input.mediaConfigRef })
      : undefined,
  };
}

/** Server-derived configuration is omitted; an opaque media ref remains user intent. */
export function generationRequestHash(input: GenerationInput): string {
  const model = input.model ? { ...input.model, configVersion: undefined } : undefined;
  return canonicalHash({
    ...input,
    model: model && Object.values(model).some((value) => value !== undefined) ? model : undefined,
  });
}
