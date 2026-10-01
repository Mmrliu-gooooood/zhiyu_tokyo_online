import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import catalog from '@/lib/model-gateway/catalog/generated/pi-models.json';

const ROOT = process.cwd();
const FILE = path.join(ROOT, 'lib', 'model-gateway', 'catalog', 'generated', 'pi-models.json');

describe('generated pi model catalog (P2-1)', () => {
  it('matches the installed pi-ai version (generate-model-catalog --check)', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'generate-model-catalog.mjs'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(output).toContain('up to date');
    const installed = JSON.parse(
      readFileSync(
        path.join(ROOT, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(catalog.piVersion).toBe(installed.version);
    expect(catalog.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stays within the client size budget', () => {
    expect(statSync(FILE).size).toBeLessThanOrEqual(150 * 1024);
  });

  it('keeps only curated short lists for the large aggregators', () => {
    const providers = catalog.providers as Record<string, { models: unknown[] }>;
    for (const id of ['openrouter', 'vercel-ai-gateway', 'amazon-bedrock', 'huggingface']) {
      expect(providers[id]?.models.length).toBeGreaterThan(0);
      expect(providers[id]!.models.length).toBeLessThanOrEqual(12);
    }
    expect(providers.typesafe).toBeUndefined();
    expect(providers.radius).toBeUndefined();
  });
});
