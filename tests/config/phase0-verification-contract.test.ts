import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');

const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Phase 0 verification contract', () => {
  it('keeps the Node and pnpm versions aligned across local, CI, and Docker verification', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      packageManager?: string;
    };
    const ci = read('.github/workflows/ci.yml');
    const dockerfile = read('Dockerfile');
    const dockerPnpmCommand = read('scripts/docker-pnpm-command.sh');

    expect(read('.nvmrc').trim()).toBe('22');
    expect(packageJson.packageManager).toMatch(/^pnpm@10\.28\.0\+/);
    expect(ci).toMatch(/node-version:\s*22/);
    expect(dockerfile).toContain('FROM node:22-alpine AS base');
    expect(dockerfile).toContain('docker-pnpm-command prepare');
    expect(dockerPnpmCommand).toContain('corepack prepare pnpm@10.28.0 --activate');
  });

  it('exposes the fixed Phase 0 critical regression set without invoking pnpm', () => {
    const output = execFileSync(
      process.execPath,
      [resolve(root, 'scripts/phase0-verify.mjs'), 'plan', '--json'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      requiredNodeMajor: 22,
      requiredPnpmVersion: '10.28.0',
      runner: 'docker-builder',
      localDiagnosticRunner: 'node-direct',
      criticalUnitFiles: [
        'tests/components/classroom/zhiyu-classroom-shell.test.ts',
        'tests/classroom/zhiyu-classroom-layout.test.ts',
        'tests/generation-preview/zhiyu-generation-state.test.ts',
        'tests/workbench/owner-session-client.test.ts',
        'tests/workbench/session-events-subscription.test.ts',
        'tests/workbench/stage-freshness-fetch.test.ts',
        'tests/workbench/stage-freshness-sync.test.ts',
        'tests/workbench/element-ref-owner-lifecycle.test.ts',
        'tests/components/edit/playback-chrome-root-element-reference-owner.test.ts',
        'tests/workbench/workspace-course-chat-bootstrap.test.ts',
      ],
      docker: {
        target: 'builder',
        runArgs: ['--rm'],
        usesBindMount: false,
      },
      e2e: {
        config: 'playwright.docker.config.ts',
        driver: 'node-direct',
      },
      environment: {
        dockerCli: 'PHASE0_DOCKER_CLI',
        localPnpmCli: 'PHASE0_PNPM_CLI',
        scope: 'Phase 0 verification only',
      },
    });
  });

  it('keeps timing-sensitive ZHIYU profiler gates out of the parallel unit pool', () => {
    const vitestConfig = read('vitest.config.ts');
    const performanceConfig = read('vitest.workspace-performance.config.ts');
    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(vitestConfig).toContain(
      "exclude: ['tests/performance/zhiyu-workspace-profiler-baseline.test.ts']",
    );
    expect(vitestConfig).not.toContain(
      "exclude: ['tests/performance/zhiyu-playback-profiler-baseline.test.ts'",
    );
    expect(packageJson.scripts?.['test:performance:zhiyu']).toBe(
      'vitest run --config vitest.workspace-performance.config.ts tests/performance/zhiyu-playback-profiler-baseline.test.ts && vitest run --config vitest.workspace-performance.config.ts tests/performance/zhiyu-workspace-profiler-baseline.test.ts',
    );
    expect(performanceConfig).toContain(
      "'tests/performance/zhiyu-playback-profiler-baseline.test.ts'",
    );
    expect(performanceConfig).toContain(
      "'tests/performance/zhiyu-workspace-profiler-baseline.test.ts'",
    );
    expect(performanceConfig).toContain('fileParallelism: false');
    expect(performanceConfig).toContain('maxWorkers: 1');
    expect(performanceConfig).toContain("'tests/setup-performance-env.ts'");
    expect(read('tests/performance/zhiyu-playback-profiler-baseline.test.ts')).toContain(
      "const performanceIt = process.env.ZHIYU_DEDICATED_PERFORMANCE === '1' ? it : it.skip;",
    );
  });

  it('fingerprints dirty file content instead of only its porcelain status', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'openmaic-phase0-worktree-'));
    try {
      execFileSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
      writeFileSync(join(fixture, 'protected.txt'), 'staged baseline');
      execFileSync('git', ['add', 'protected.txt'], { cwd: fixture });
      writeFileSync(join(fixture, 'protected.txt'), 'dirty version one');

      const first = execFileSync(
        process.execPath,
        [resolve(root, 'scripts/phase0-verify.mjs'), 'snapshot', '--json', '--root', fixture],
        { encoding: 'utf8' },
      );
      writeFileSync(join(fixture, 'protected.txt'), 'dirty version two');
      const second = execFileSync(
        process.execPath,
        [resolve(root, 'scripts/phase0-verify.mjs'), 'snapshot', '--json', '--root', fixture],
        { encoding: 'utf8' },
      );

      expect(JSON.parse(second).fingerprint).not.toBe(JSON.parse(first).fingerprint);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
