/**
 * Loader for the pi-ai runtime instance that pi-agent-core 0.78 itself uses.
 *
 * pi-agent-core 0.78 depends on `@earendil-works/pi-ai@^0.78.0`, which pnpm
 * installs as a nested copy next to the agent kernel, while the application
 * root depends on pi-ai 0.99. The kernel's `compact()` / `generateSummary()`
 * dispatch through the *nested* copy's global API registry, so bridges must be
 * registered on that exact instance — importing `@earendil-works/pi-ai` from
 * application code would resolve the 0.99 root copy and the registration would
 * silently land on the wrong registry.
 *
 * This is the only module in the project that touches the 0.78 runtime. Delete
 * it when the agent kernel is upgraded.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentApi,
  AgentEventStream,
  AgentLlmContext,
  AgentLlmModel,
  AgentStreamOptions,
} from './agent-pi-types';

type AgentApiStreamFn = (
  model: AgentLlmModel,
  context: AgentLlmContext,
  options?: AgentStreamOptions,
) => AgentEventStream;

/** Minimal surface of pi-ai 0.78 used by this project. */
export interface AgentLegacyPi {
  readonly version: string;
  readonly packageDir: string;
  registerApiProvider(
    provider: { api: AgentApi; stream: AgentApiStreamFn; streamSimple: AgentApiStreamFn },
    sourceId?: string,
  ): void;
  unregisterApiProviders(sourceId: string): void;
  createAssistantMessageEventStream(): AgentEventStream & {
    push(event: AgentEventStream extends AsyncIterable<infer E> ? E : never): void;
    end(): void;
  };
}

export interface AgentLegacyPiLocation {
  /** Directory of the pi-ai package that pi-agent-core resolves. */
  packageDir: string;
  version: string;
  /** Absolute path of the ESM entry (`exports['.'].import`). */
  entryFile: string;
}

const PI_AI = '@earendil-works/pi-ai';

function exportsImportEntry(pkg: { exports?: unknown; module?: string; main?: string }): string {
  const root = (pkg.exports as Record<string, unknown> | undefined)?.['.'];
  if (typeof root === 'string') return root;
  if (root && typeof root === 'object') {
    const entry = (root as Record<string, unknown>).import;
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const nested = (entry as Record<string, unknown>).default;
      if (typeof nested === 'string') return nested;
    }
    const fallback = (root as Record<string, unknown>).default;
    if (typeof fallback === 'string') return fallback;
  }
  const legacy = pkg.module ?? pkg.main;
  if (legacy) return legacy;
  throw new Error(`${PI_AI}: package.json has no ESM entry`);
}

/**
 * Locate the pi-ai package that pi-agent-core itself imports, following
 * Node's resolution from the agent-core package directory. pi-ai 0.78 does not
 * export `./package.json`, so the lookup walks the candidate `node_modules`
 * directories instead of calling `require.resolve('<pkg>/package.json')`.
 */
export function locateAgentLegacyPi(fromDir?: string): AgentLegacyPiLocation {
  const anchor = fromDir
    ? path.join(fromDir, 'package.json')
    : createRequire(path.join(process.cwd(), 'package.json')).resolve(
        '@earendil-works/pi-agent-core/package.json',
      );
  const agentCoreRequire = createRequire(anchor);
  const candidates = agentCoreRequire.resolve.paths(PI_AI) ?? [];
  for (const base of candidates) {
    const packageDir = path.join(base, ...PI_AI.split('/'));
    const manifestPath = path.join(packageDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string;
      exports?: unknown;
      module?: string;
      main?: string;
    };
    return {
      packageDir,
      version: pkg.version,
      entryFile: path.join(packageDir, exportsImportEntry(pkg)),
    };
  }
  throw new Error(`${PI_AI} is not resolvable from pi-agent-core (${anchor})`);
}

let cached: Promise<AgentLegacyPi> | undefined;

/** Load (once per process) the pi-ai runtime instance used by pi-agent-core. */
export function loadAgentLegacyPi(): Promise<AgentLegacyPi> {
  cached ??= (async () => {
    const location = locateAgentLegacyPi();
    const mod = (await import(
      /* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(location.entryFile).href
    )) as Omit<AgentLegacyPi, 'version' | 'packageDir'>;
    if (
      typeof mod.registerApiProvider !== 'function' ||
      typeof mod.unregisterApiProviders !== 'function' ||
      typeof mod.createAssistantMessageEventStream !== 'function'
    ) {
      throw new Error(`${PI_AI}@${location.version} does not expose the agent interop API`);
    }
    return {
      version: location.version,
      packageDir: location.packageDir,
      registerApiProvider: mod.registerApiProvider,
      unregisterApiProviders: mod.unregisterApiProviders,
      createAssistantMessageEventStream: mod.createAssistantMessageEventStream,
    };
  })();
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}
