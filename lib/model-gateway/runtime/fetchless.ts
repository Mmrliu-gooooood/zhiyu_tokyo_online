/**
 * APIs whose pi adapter cannot take the gateway's per-request fetch (plan
 * P2-6, invariant 4a): Google Generative AI, Vertex and Bedrock talk through
 * their own SDK transports, so the SSRF check, DNS pinning, redirect refusal
 * and operator proxy of runtime/transport.ts do not apply. They may therefore
 * only reach the official Google endpoint or an operator-configured endpoint,
 * and never through a proxy the gateway cannot enforce.
 */
import type { GatewayErrorCode } from './errors';
import type { ModelBinding } from '../types';

export const FETCHLESS_APIS: ReadonlySet<string> = new Set([
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
]);

/** Operator-only ambient-credential APIs. */
const OPERATOR_ONLY_APIS: ReadonlySet<string> = new Set([
  'google-vertex',
  'bedrock-converse-stream',
]);

export const OFFICIAL_GOOGLE_HOST = 'generativelanguage.googleapis.com';

/** Application providers served through a fetch-less API. */
export const FETCHLESS_PROVIDER_IDS = Object.freeze(['google', 'bedrock', 'google-vertex']);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Why a binding must not be sent, or undefined when it may. Checked before any request. */
export function fetchlessRefusal(
  binding: Pick<ModelBinding, 'model' | 'endpoint' | 'proxy'>,
): GatewayErrorCode | undefined {
  const api = binding.model.api;
  if (!FETCHLESS_APIS.has(api)) return undefined;
  // The SDK transport would silently bypass the proxy and connect directly.
  if (binding.proxy) return 'MODEL_CONFIGURATION';
  if (OPERATOR_ONLY_APIS.has(api)) {
    return binding.endpoint === 'operator' ? undefined : 'MODEL_CONFIGURATION';
  }
  if (binding.endpoint === 'user' || binding.endpoint === 'local') return 'MODEL_UNSAFE_ENDPOINT';
  if (binding.endpoint === 'official' && hostOf(binding.model.baseUrl) !== OFFICIAL_GOOGLE_HOST) {
    return 'MODEL_UNSAFE_ENDPOINT';
  }
  return undefined;
}
