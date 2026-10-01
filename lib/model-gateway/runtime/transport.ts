/**
 * Per-attempt HTTP transport and side channel (plan 3.8).
 *
 * pi folds HTTP failures into an `errorMessage` string, so classification uses
 * what this fetch observed: status, whitelisted headers, network error codes,
 * whether the request could have reached the server, and time to first byte.
 * A new side channel is created for every upstream attempt; nothing is global.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertSafeLookupAddresses } from '@/lib/server/pinned-fetch-agent';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { EndpointKind } from '../types';

const RECORDED_HEADERS = ['retry-after', 'retry-after-ms', 'x-request-id', 'request-id'] as const;

/** Errors that prove the request never reached the server. */
const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNSAFE_NETWORK_TARGET',
]);

export class UnsafeEndpointError extends Error {
  readonly code = 'UNSAFE_NETWORK_TARGET';
  constructor() {
    super('Model endpoint failed the network safety check');
    this.name = 'UnsafeEndpointError';
  }
}

export interface SideChannel {
  /** False only when the failure proves the request never left (DNS, connect, SSRF). */
  requestSent: boolean;
  status?: number;
  headers: Partial<Record<(typeof RECORDED_HEADERS)[number], string>>;
  networkErrorCode?: string;
  unsafeEndpoint: boolean;
  startedAt?: number;
  firstByteAt?: number;
}

export interface Transport {
  fetch: typeof globalThis.fetch;
  channel: SideChannel;
}

export interface TransportOptions {
  endpoint: EndpointKind;
  /** Operator-configured proxy (operator endpoints only). */
  proxy?: string;
  /** Test seam: the fetch used for official endpoints. */
  baseFetch?: typeof globalThis.fetch;
}

function localNetworksAllowed(): boolean {
  return process.env.ALLOW_LOCAL_NETWORKS === 'true' || process.env.ALLOW_LOCAL_NETWORKS === '1';
}

function lookupPinned(
  hostname: string,
  options: Record<string, unknown>,
  callback: (...args: unknown[]) => void,
): void {
  dnsLookup(
    hostname,
    { ...options, all: true, verbatim: true },
    (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (error) return callback(error);
      try {
        assertSafeLookupAddresses(addresses);
      } catch (unsafe) {
        return callback(Object.assign(unsafe as Error, { code: 'UNSAFE_NETWORK_TARGET' }));
      }
      if (options.all === true) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
  );
}

/** LLM-appropriate timeouts: long generations stream for minutes. */
const LLM_AGENT_OPTIONS = {
  headersTimeout: 120_000,
  bodyTimeout: 300_000,
  keepAliveTimeout: 30_000,
};

let pinnedAgent: Agent | undefined;
let localAgent: Agent | undefined;
const proxyAgents = new Map<string, ProxyAgent>();

/** One process-wide DNS-pinned agent for user endpoints (connections are reused). */
function userDispatcher(): Dispatcher {
  if (localNetworksAllowed()) {
    localAgent ??= new Agent({ ...LLM_AGENT_OPTIONS, connect: { timeout: 10_000 } });
    return localAgent;
  }
  pinnedAgent ??= new Agent({
    ...LLM_AGENT_OPTIONS,
    connect: { timeout: 10_000, lookup: lookupPinned as never },
  });
  return pinnedAgent;
}

function proxyDispatcher(proxy: string): Dispatcher {
  let agent = proxyAgents.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({ uri: proxy, ...LLM_AGENT_OPTIONS });
    proxyAgents.set(proxy, agent);
  }
  return agent;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Walk the cause chain for a network error code. */
export function networkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function createTransport(options: TransportOptions): Transport {
  const channel: SideChannel = { requestSent: false, headers: {}, unsafeEndpoint: false };
  // User-supplied (including keyless local) endpoints are untrusted: every
  // request URL is SSRF-checked, DNS is pinned at connect time, no redirects.
  const checksEveryUrl = options.endpoint === 'user' || options.endpoint === 'local';
  const dispatcher = checksEveryUrl
    ? userDispatcher()
    : options.endpoint === 'operator' && options.proxy
      ? proxyDispatcher(options.proxy)
      : undefined;
  const baseFetch = options.baseFetch ?? globalThis.fetch;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    channel.startedAt ??= Date.now();
    try {
      if (checksEveryUrl) {
        const unsafe = await validateUrlForSSRF(urlOf(input));
        if (unsafe) {
          channel.unsafeEndpoint = true;
          throw new UnsafeEndpointError();
        }
      }
      const response = dispatcher
        ? ((await undiciFetch(urlOf(input), {
            ...(init as Parameters<typeof undiciFetch>[1]),
            // Bearer credentials must never follow a redirect off the endpoint.
            redirect: checksEveryUrl ? 'error' : init?.redirect,
            dispatcher,
          })) as unknown as Response)
        : await baseFetch(input, { ...init, redirect: checksEveryUrl ? 'error' : init?.redirect });
      channel.requestSent = true;
      channel.firstByteAt ??= Date.now();
      channel.status ??= response.status;
      if (!response.ok) {
        for (const name of RECORDED_HEADERS) {
          const value = response.headers.get(name);
          if (value) channel.headers[name] = value;
        }
      } else {
        const id = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        if (id) channel.headers['x-request-id'] = id;
      }
      return response;
    } catch (error) {
      const code = networkErrorCode(error);
      channel.networkErrorCode ??= code;
      if (code === 'UNSAFE_NETWORK_TARGET') channel.unsafeEndpoint = true;
      const redirectRejected =
        checksEveryUrl && error instanceof TypeError && /redirect/i.test(String(error.cause ?? ''));
      if (redirectRejected) channel.unsafeEndpoint = true;
      // Anything that is not provably pre-send may have reached the server.
      channel.requestSent =
        channel.requestSent || !(code && PRE_SEND_CODES.has(code)) || redirectRejected;
      throw error;
    }
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, channel };
}

/** For tests: drop cached dispatchers (e.g. after toggling ALLOW_LOCAL_NETWORKS). */
export async function resetTransportAgents(): Promise<void> {
  const agents: Dispatcher[] = [...proxyAgents.values()];
  if (pinnedAgent) agents.push(pinnedAgent);
  if (localAgent) agents.push(localAgent);
  pinnedAgent = undefined;
  localAgent = undefined;
  proxyAgents.clear();
  await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
}
