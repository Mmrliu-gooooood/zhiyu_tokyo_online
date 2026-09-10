import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('generation deployment contract', () => {
  it('shares only dedicated generation snapshot keys with the worker', () => {
    const compose = read('docker-compose.persistence.yml');
    const envExample = read('.env.example');
    const deploymentPlan = read('optimization_docs/zhiyu-deployment-execution-plan-2026-09-07.md');

    expect(compose).toContain('GENERATION_MODEL_ENCRYPTION_KEY:');
    expect(compose).toContain('MEDIA_CONFIG_ENCRYPTION_KEY:');
    expect(compose).toMatch(
      /openmaic:[\s\S]*PRO_MODEL_ENCRYPTION_KEY:[\s\S]*generation-worker:[\s\S]*environment: \*generation-environment/,
    );
    expect(envExample).toContain('# GENERATION_MODEL_ENCRYPTION_KEY=');
    expect(deploymentPlan).toContain(
      '`PRO_MODEL_ENCRYPTION_KEY` | 已有；32 字节随机值的 64 位十六进制 | 仅 Web',
    );
    expect(deploymentPlan).toContain('`GENERATION_MODEL_ENCRYPTION_KEY`');
  });

  it('shares one TTS request budget between the web and generation worker', () => {
    const compose = read('docker-compose.persistence.yml');
    const envExample = read('.env.example');

    expect(compose).toContain('TTS_REQUEST_TIMEOUT_MS: ${TTS_REQUEST_TIMEOUT_MS:-120000}');
    expect(compose.match(/^\s*TTS_REQUEST_TIMEOUT_MS:/gm)).toHaveLength(1);
    expect(envExample).toContain('# TTS_REQUEST_TIMEOUT_MS=120000');
    expect(envExample).toContain('worker reserves additional checkpoint commit time');
  });

  it('labels both runtime images with the same source revision', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile.match(/ARG OPENMAIC_SOURCE_REVISION/g)).toHaveLength(2);
    expect(
      dockerfile.match(/LABEL org\.opencontainers\.image\.revision=\$OPENMAIC_SOURCE_REVISION/g),
    ).toHaveLength(2);
  });

  it('uses the optional npm mirror for dependency tarballs, not Corepack metadata', () => {
    const dockerfile = read('Dockerfile');
    const baseStage = dockerfile.slice(0, dockerfile.indexOf('# ---- Stage 2: Dependencies ----'));
    const depsStage = dockerfile.slice(
      dockerfile.indexOf('# ---- Stage 2: Dependencies ----'),
      dockerfile.indexOf('# ---- Independent worker'),
    );

    expect(baseStage).not.toContain('COREPACK_NPM_REGISTRY');
    expect(depsStage).toContain('ARG NPM_REGISTRY');
    expect(depsStage).toContain('pnpm config set registry "$npm_registry"');
  });

  it('gives the non-root generation worker a writable usage directory', () => {
    const dockerfile = read('Dockerfile');
    const workerStage = dockerfile.slice(
      dockerfile.indexOf('FROM base AS generation-worker'),
      dockerfile.indexOf('# ---- Stage 3: Builder ----'),
    );

    expect(workerStage).toContain('mkdir -p /app/data/usage');
    expect(workerStage).toContain('chown -R worker:nodejs /app/data');
    expect(workerStage.indexOf('chown -R worker:nodejs /app/data')).toBeLessThan(
      workerStage.indexOf('USER worker'),
    );
  });

  it('validates the complete web-worker deployment boundary', () => {
    const script = read('scripts/generation-compose.ps1');

    expect(script).toContain(
      "if (-not $workerService) { throw 'The generation-worker service is required.' }",
    );
    expect(script).toContain('$workerEnv.DATABASE_URL -ne $appEnv.DATABASE_URL');
    expect(script).toContain(
      '$workerEnv.MEDIA_CONFIG_ENCRYPTION_KEY -ne $appEnv.MEDIA_CONFIG_ENCRYPTION_KEY',
    );
    expect(script).toContain(
      '$workerEnv.GENERATION_MODEL_ENCRYPTION_KEY -ne $appEnv.GENERATION_MODEL_ENCRYPTION_KEY',
    );
    expect(script).toContain("GENERATION_BACKGROUND_ENABLED -ne '1'");
    expect(script).toContain("GENERATION_ACCEPTING_JOBS -ne '1'");
    expect(script).toContain('Wait-GenerationWorkerHealthy');
    expect(script).toContain('org.opencontainers.image.revision');
    expect(script).toContain('OPENMAIC_SOURCE_REVISION');
    expect(script).toContain(
      'function Get-ReleaseImageRecord([string]$ImageName, [string]$ExpectedRevision)',
    );
    expect(script).toContain('$imageMetadata.Config.Labels');
    expect(script).not.toContain('$image = @(($rawImage');
    expect(script).toContain("$runningContainer.Config.Labels.'com.docker.compose.project'");
    expect(script).toContain("$runningContainer.Config.Labels.'com.docker.compose.service'");
    expect(script).not.toContain("--format '{{index .Config.Labels");
  });
});
