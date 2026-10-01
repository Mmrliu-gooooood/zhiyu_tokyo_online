/**
 * Model gateway startup checks (web server and generation worker).
 *
 * - Fetch-less providers (Google, Bedrock, Vertex) talk through SDK
 *   transports that cannot use the gateway's operator proxy; a configured
 *   proxy would be silently bypassed, so startup fails instead (plan P2-6).
 * - Logs which pi-readable environment variables are set, names only (P2-7).
 */
import { resolveProxy } from '@/lib/server/provider-config';
import { logPiEnvironmentAudit } from './credentials/env-exposure';
import { FETCHLESS_PROVIDER_IDS } from './runtime/fetchless';

export class GatewayStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayStartupError';
  }
}

export function assertFetchlessProxyConfig(
  proxyFor: (providerId: string) => string | undefined = resolveProxy,
): void {
  const proxied = FETCHLESS_PROVIDER_IDS.filter((providerId) => Boolean(proxyFor(providerId)));
  if (proxied.length === 0) return;
  throw new GatewayStartupError(
    `[model-gateway] An outbound proxy is configured for ${proxied.join(', ')}. ` +
      'These providers use SDK transports that cannot go through the gateway proxy and would ' +
      'connect directly. Remove the proxy setting for them, or reach the model through an ' +
      'OpenAI-compatible relay instead.',
  );
}

/** Run every startup check; throws GatewayStartupError on a configuration that must not run. */
export function runGatewayStartupChecks(): void {
  assertFetchlessProxyConfig();
  logPiEnvironmentAudit();
}
