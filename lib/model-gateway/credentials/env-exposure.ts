/**
 * pi reads some settings straight from process.env, bypassing the sealed
 * AuthContext (`getProviderEnvValue(name, env)` = `env[name] || process.env[name]`,
 * so an empty override cannot block it). Plan P2-7:
 *
 * - every value pi needs is passed explicitly in the per-request `env` (Azure
 *   base URL / API version / deployment, Bedrock region, Vertex project /
 *   location), which pi reads before process.env;
 * - ambient AWS / Google credentials are used only by operator-only bindings;
 * - startup logs which of these names are set (never values) so operators
 *   know what pi could see.
 *
 * process.env is not modified: the legacy stack reads it until P5.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('ModelGateway');

/** Names pi may read directly from process.env (pi-ai 0.99.1). */
export const PI_DIRECT_ENV = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_BEDROCK_SKIP_AUTH',
  'AWS_BEDROCK_FORCE_CACHE',
  'AWS_BEDROCK_FORCE_HTTP1',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'PI_CACHE_RETENTION',
] as const);

/**
 * Provider credentials pi's auth resolvers look up. The gateway's sealed
 * AuthContext hides them from every non-ambient binding.
 */
export const PI_AUTH_ENV = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'HF_TOKEN',
  'NVIDIA_API_KEY',
  'BASETEN_API_KEY',
  'AI_GATEWAY_API_KEY',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
  'OPENCODE_API_KEY',
  'META_API_KEY',
  'ANT_LING_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'COPILOT_GITHUB_TOKEN',
] as const);

type Env = Readonly<Record<string, string | undefined>>;

const isSet = (env: Env, name: string) => typeof env[name] === 'string' && env[name]!.trim() !== '';

/** Names (never values) of pi-readable variables that are set. */
export function auditPiEnvironment(env: Env = process.env): {
  direct: string[];
  credentials: string[];
} {
  return {
    direct: PI_DIRECT_ENV.filter((name) => isSet(env, name)),
    credentials: PI_AUTH_ENV.filter((name) => isSet(env, name)),
  };
}

export function logPiEnvironmentAudit(env: Env = process.env): void {
  const { direct, credentials } = auditPiEnvironment(env);
  if (direct.length === 0 && credentials.length === 0) return;
  log.info(
    JSON.stringify({
      event: 'pi_env_audit',
      // pi reads these directly; the gateway passes explicit values instead,
      // and only operator-only Bedrock / Vertex bindings use ambient AWS / Google ones.
      direct,
      // Sealed from every non-ambient binding by the gateway AuthContext.
      credentials,
    }),
  );
}

export interface OperatorProviderEnv {
  /** Explicit per-request values (passed to pi as env and as typed options). */
  env: Record<string, string>;
  /** Every value the API requires is present. */
  ready: boolean;
}

/**
 * Explicit settings for operator-managed ambient providers, read once from the
 * operator's environment by the gateway (not by pi).
 */
export function operatorProviderEnv(api: string, env: Env = process.env): OperatorProviderEnv {
  const pick = (...names: string[]) =>
    names.map((name) => env[name]?.trim()).find((value) => value) ?? undefined;
  if (api === 'bedrock-converse-stream') {
    // Same precedence as the legacy Bedrock client.
    const region = pick('BEDROCK_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION') ?? 'us-east-1';
    return { env: { AWS_REGION: region }, ready: true };
  }
  if (api === 'google-vertex') {
    const project = pick('GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT');
    const location = pick('GOOGLE_CLOUD_LOCATION');
    return {
      env: {
        ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}),
        ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
      },
      ready: Boolean(project && location),
    };
  }
  return { env: {}, ready: true };
}

/**
 * The per-request `env` that pre-empts every process.env fallback of the
 * binding's API (plan P2-7). pi's `streamSimple` paths drop typed options
 * such as `azureBaseUrl`, `region` or `project`, but always forward `env`,
 * and `getProviderEnvValue` reads it before process.env.
 */
export function explicitProviderEnv(binding: {
  model: { api: string; id: string; baseUrl: string };
  requestEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = { ...(binding.requestEnv ?? {}) };
  if (binding.model.api === 'azure-openai-responses') {
    env.AZURE_OPENAI_BASE_URL = binding.model.baseUrl;
    env.AZURE_OPENAI_API_VERSION ??= 'v1';
    // Deployment = the model id the user selected (the legacy behavior).
    env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = `${binding.model.id}=${binding.model.id}`;
  }
  return env;
}
