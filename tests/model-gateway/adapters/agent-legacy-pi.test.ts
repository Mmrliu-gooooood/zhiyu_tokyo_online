import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadAgentLegacyPi,
  locateAgentLegacyPi,
} from '@/lib/model-gateway/adapters/agent-legacy-pi';

const requireFromRoot = createRequire(path.join(process.cwd(), 'package.json'));

function rootPiAiVersion(): { version: string; dir: string } {
  // Neither pi-ai version exports ./package.json; read the root copy directly.
  const manifest = path.join(
    process.cwd(),
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'package.json',
  );
  return {
    version: JSON.parse(readFileSync(manifest, 'utf8')).version,
    dir: realpathSync(path.dirname(manifest)),
  };
}

describe('agent-legacy-pi loader', () => {
  it('resolves the nested pi-ai 0.78 copy used by pi-agent-core, not the root copy', () => {
    const legacy = locateAgentLegacyPi();
    const root = rootPiAiVersion();

    expect(legacy.version).toMatch(/^0\.78\./);
    expect(root.version).toBe('0.99.1');
    expect(realpathSync(legacy.packageDir)).not.toBe(root.dir);
  });

  it('matches the pi-ai directory installed alongside agent-core', () => {
    // pnpm places a package's dependencies next to it in the virtual store:
    // .pnpm/<agent-core>/node_modules/@earendil-works/{pi-agent-core,pi-ai}.
    const agentCoreDir = realpathSync(
      path.dirname(requireFromRoot.resolve('@earendil-works/pi-agent-core/package.json')),
    );
    const sibling = path.join(path.dirname(agentCoreDir), 'pi-ai');
    const legacyDir = realpathSync(locateAgentLegacyPi().packageDir);

    expect(legacyDir).toBe(realpathSync(sibling));
    expect(locateAgentLegacyPi().entryFile.startsWith(locateAgentLegacyPi().packageDir)).toBe(true);
  });

  it('loads the runtime once and exposes the interop surface', async () => {
    const first = await loadAgentLegacyPi();
    const second = await loadAgentLegacyPi();

    expect(second).toBe(first);
    expect(first.version).toMatch(/^0\.78\./);
    expect(typeof first.registerApiProvider).toBe('function');
    expect(typeof first.unregisterApiProviders).toBe('function');

    const stream = first.createAssistantMessageEventStream();
    const message = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'ok' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop' as const,
      timestamp: 0,
    };
    stream.push({ type: 'done', reason: 'stop', message });
    await expect(stream.result()).resolves.toMatchObject({ content: [{ text: 'ok' }] });
  });
});
