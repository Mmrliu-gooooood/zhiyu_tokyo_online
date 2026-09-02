#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const requiredNodeMajor = 22;
const requiredPnpmVersion = '10.28.0';
const criticalUnitFiles = [
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
];

const plan = {
  schemaVersion: 1,
  requiredNodeMajor,
  requiredPnpmVersion,
  runner: 'docker-builder',
  localDiagnosticRunner: 'node-direct',
  criticalUnitFiles,
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
};

function fail(message) {
  console.error(`Phase 0 verification refused to run: ${message}`);
  process.exit(1);
}

function git(worktreeRoot, args) {
  const result = spawnSync('git', args, {
    cwd: worktreeRoot,
    encoding: 'buffer',
  });
  if (result.status !== 0) fail(`git ${args.join(' ')} could not be read`);
  return result.stdout;
}

function nulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function snapshotWorktree(worktreeRoot) {
  const status = git(worktreeRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = new Set([
    ...nulPaths(git(worktreeRoot, ['diff', '--name-only', '-z'])),
    ...nulPaths(git(worktreeRoot, ['diff', '--cached', '--name-only', '-z'])),
    ...nulPaths(git(worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ]);
  const digest = createHash('sha256');
  digest.update(status);
  for (const path of [...paths].sort()) {
    const absolutePath = resolve(worktreeRoot, path);
    digest.update(`\0${path}\0`);
    digest.update(existsSync(absolutePath) ? readFileSync(absolutePath) : '<missing>');
  }
  return {
    schemaVersion: 1,
    root: worktreeRoot,
    fingerprint: digest.digest('hex'),
    dirtyPaths: [...paths].sort(),
  };
}

function assertNodeAndManifest() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== requiredNodeMajor) {
    fail(`Node ${requiredNodeMajor}.x is required; received ${process.version}`);
  }

  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (!packageJson.packageManager?.startsWith(`pnpm@${requiredPnpmVersion}+`)) {
    fail(`packageManager must remain pinned to pnpm ${requiredPnpmVersion}`);
  }
}

function assertLocalPnpm() {
  const pnpmCli = process.env.PHASE0_PNPM_CLI;
  if (!pnpmCli) {
    fail('PHASE0_PNPM_CLI must point to the pnpm 10.28.0 JavaScript CLI');
  }
  const actualPnpm = execFileSync(process.execPath, [pnpmCli, '--version'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (actualPnpm !== requiredPnpmVersion) {
    fail(`pnpm ${requiredPnpmVersion} is required; received ${actualPnpm}`);
  }
}

function runLocalDiagnostic() {
  assertNodeAndManifest();
  assertLocalPnpm();
  const before = snapshotWorktree(root);
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...criticalUnitFiles],
    { cwd: root, stdio: 'inherit' },
  );
  const after = snapshotWorktree(root);
  if (before.fingerprint !== after.fingerprint) {
    fail('the critical test run changed the protected worktree');
  }
  process.exit(result.status ?? 1);
}

function runDocker(args, options = {}) {
  const dockerCli = process.env.PHASE0_DOCKER_CLI || 'docker';
  const result = spawnSync(dockerCli, args, {
    cwd: root,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  });
  if (result.status !== 0) {
    const error = new Error(`docker ${args[0]} failed`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return options.capture ? result.stdout.trim() : '';
}

function runCriticalInDocker() {
  assertNodeAndManifest();
  const before = snapshotWorktree(root);
  const image = 'openmaic-phase0-verify:builder';
  let exitCode = 0;
  try {
    runDocker(['build', '--target', plan.docker.target, '--tag', image, '.']);
    const nodeVersion = runDocker(['run', '--rm', image, 'node', '--version'], { capture: true });
    const pnpmVersion = runDocker(['run', '--rm', image, 'pnpm', '--version'], { capture: true });
    if (!nodeVersion.startsWith(`v${requiredNodeMajor}.`)) {
      fail(`Docker builder must use Node ${requiredNodeMajor}.x; received ${nodeVersion}`);
    }
    if (pnpmVersion !== requiredPnpmVersion) {
      fail(`Docker builder must use pnpm ${requiredPnpmVersion}; received ${pnpmVersion}`);
    }
    runDocker(['run', '--rm', image, 'pnpm', 'exec', 'vitest', 'run', ...criticalUnitFiles]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    exitCode = error?.exitCode ?? 1;
  }
  const after = snapshotWorktree(root);
  if (before.fingerprint !== after.fingerprint) {
    fail('the Docker critical test run changed the protected worktree');
  }
  process.exit(exitCode);
}

const [command, format, rootFlag, requestedRoot] = process.argv.slice(2);
if (command === 'plan' && format === '--json') {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
} else if (command === 'snapshot' && format === '--json') {
  const worktreeRoot = rootFlag === '--root' && requestedRoot ? resolve(requestedRoot) : root;
  process.stdout.write(`${JSON.stringify(snapshotWorktree(worktreeRoot))}\n`);
} else if (command === 'critical') {
  runCriticalInDocker();
} else if (command === 'critical-local') {
  runLocalDiagnostic();
} else {
  console.error(
    [
      'Usage:',
      '  node scripts/phase0-verify.mjs plan --json',
      '  node scripts/phase0-verify.mjs snapshot --json [--root <git-worktree>]',
      '  node scripts/phase0-verify.mjs critical',
      '  PHASE0_PNPM_CLI=<pnpm-10.28.0-cli> node scripts/phase0-verify.mjs critical-local',
      'PHASE0_DOCKER_CLI and PHASE0_PNPM_CLI are scoped to Phase 0 verification only.',
    ].join('\n'),
  );
  process.exit(2);
}
