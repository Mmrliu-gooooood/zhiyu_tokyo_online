import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('generation deployment contract', () => {
  it('shares only dedicated generation snapshot keys with the worker', () => {
    const compose = read('docker-compose.persistence.yml');
    const envExample = read('.env.example');
    const deploymentPlan = read(
      'docs/archive/investigations/zhiyu-deployment-execution-plan-2026-09-07.md',
    );

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

  it('passes the platform text thinking policy to web and worker', () => {
    const compose = read('docker-compose.persistence.yml');
    const envExample = read('.env.example');

    expect(compose).toContain(
      'ZHIYU_DEFAULT_TEXT_THINKING_MODE: ${ZHIYU_DEFAULT_TEXT_THINKING_MODE:-disabled}',
    );
    expect(compose).toContain(
      'ZHIYU_DEFAULT_TEXT_THINKING_EFFORT: ${ZHIYU_DEFAULT_TEXT_THINKING_EFFORT:-none}',
    );
    expect(envExample).toContain('ZHIYU_DEFAULT_TEXT_THINKING_MODE=disabled');
    expect(envExample).toContain('ZHIYU_DEFAULT_TEXT_THINKING_EFFORT=none');
  });

  it('labels both runtime images with the same source revision', () => {
    const dockerfile = read('Dockerfile');

    expect(dockerfile.match(/ARG OPENMAIC_SOURCE_REVISION/g)).toHaveLength(2);
    expect(
      dockerfile.match(/LABEL org\.opencontainers\.image\.revision=\$OPENMAIC_SOURCE_REVISION/g),
    ).toHaveLength(2);
  });

  it('uses the optional public npm mirror for Corepack and dependency tarballs', () => {
    const dockerfile = read('Dockerfile');
    const registryScript = read('scripts/docker-pnpm-command.sh');
    const baseStage = dockerfile.slice(0, dockerfile.indexOf('# ---- Stage 2: Dependencies ----'));
    const depsStage = dockerfile.slice(
      dockerfile.indexOf('# ---- Stage 2: Dependencies ----'),
      dockerfile.indexOf('# ---- Independent worker'),
    );

    expect(baseStage).toContain('ARG NPM_REGISTRY=""');
    expect(baseStage).toContain('docker-pnpm-command prepare');
    expect(depsStage).toContain('ARG NPM_REGISTRY');
    expect(depsStage).toContain('docker-pnpm-command install');
    expect(registryScript).toContain('COREPACK_NPM_REGISTRY="$registry"');
    expect(registryScript).toContain('pnpm config set registry "$registry"');
    expect(registryScript).toContain('while [ "$attempt" -le 3 ]');
    expect(registryScript).toContain('if [ "$attempt" -eq 1 ]; then delay=2; else delay=5; fi');
    expect(registryScript).toContain("official_registry='https://registry.npmjs.org'");
  });

  it('bounds Alpine package retries and falls back without changing container DNS', () => {
    const dockerfile = read('Dockerfile');
    const retryScript = read('scripts/docker-apk-add.sh');

    expect(dockerfile).toContain('COPY scripts/docker-apk-add.sh /usr/local/bin/docker-apk-add');
    expect(dockerfile.match(/docker-apk-add libc6-compat/g)).toHaveLength(2);
    expect(dockerfile).toContain(
      'docker-apk-add python3 build-base g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev',
    );
    expect(dockerfile).toContain('docker-apk-add cairo pango jpeg giflib librsvg');
    expect(retryScript).toContain('while [ "$attempt" -le 3 ]');
    expect(retryScript).toContain('if [ "$attempt" -eq 1 ]; then delay=2; else delay=5; fi');
    expect(retryScript).toContain('dl-cdn.alpinelinux.org');
    expect(retryScript).not.toContain('/etc/resolv.conf');
  });

  it('offers host networking only as an explicit build-scoped recovery option', () => {
    const script = read('scripts/generation-compose.ps1');
    const override = read('docker-compose.build-host.yml');

    expect(script).toContain('[switch]$UseHostBuildNetwork');
    expect(script).toContain("$Action -ne 'build'");
    expect(script).toContain("$prefix += @('-f','docker-compose.build-host.yml')");
    expect(override).toMatch(/openmaic:[\s\S]*build:[\s\S]*network: host/);
    expect(override).toMatch(/generation-worker:[\s\S]*build:[\s\S]*network: host/);
    expect(override).not.toContain('networks:');
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

  it('persists web and worker usage in one narrowly initialized volume', () => {
    const compose = read('docker-compose.persistence.yml');

    expect(compose).toContain('usage-init:');
    expect(compose).toContain('mkdir -p /data/usage');
    expect(compose).toContain('chown 1001:65533 /data/usage');
    expect(compose).toContain('chmod 0770 /data/usage');
    expect(compose).not.toContain('chmod 777');
    expect(compose).toMatch(/generation-worker:[\s\S]*volumes:[\s\S]*openmaic-data:\/app\/data/);
  });

  it('rejects a provider-config directory and disables implicit bind path creation', () => {
    const script = read('scripts/generation-compose.ps1');
    const providersCompose = read('docker-compose.providers.yml');

    expect(script).toContain("Test-Path -LiteralPath 'server-providers.yml' -PathType Leaf");
    expect(script).toContain("Test-Path -LiteralPath 'server-providers.yml' -PathType Container");
    expect(script).toContain('must be a regular file');
    expect(providersCompose).toContain('type: bind');
    expect(providersCompose).toContain('create_host_path: false');
    expect(providersCompose).not.toContain('./server-providers.yml:/app/server-providers.yml:ro');
  });

  it('provisions the Pro runtime stores before the generation worker starts', () => {
    const migration = read('workers/generation/migrate.ts');
    const generationMigration = migration.indexOf('await migrateGenerationSchema(pool)');

    for (const initializer of [
      'await ensureAgentSessionSchema(pool)',
      'await ensureAgentSessionMaterialSchema(pool)',
      'await ensureUserSkillSchema(pool)',
    ]) {
      expect(migration).toContain(initializer);
      expect(migration.indexOf(initializer)).toBeLessThan(generationMigration);
    }
  });

  it('validates the complete web-worker deployment boundary', () => {
    const script = read('scripts/generation-compose.ps1');

    expect(script).toContain(
      "if (-not $workerService) { throw 'The generation-worker service is required.' }",
    );
    expect(script).toContain('$workerEnv.DATABASE_URL -ne $appEnv.DATABASE_URL');
    expect(script).toContain("$workerDataMount[0].source -ne 'openmaic-data'");
    expect(script).toContain(
      '$workerEnv.MEDIA_CONFIG_ENCRYPTION_KEY -ne $appEnv.MEDIA_CONFIG_ENCRYPTION_KEY',
    );
    expect(script).toContain(
      '$workerEnv.GENERATION_MODEL_ENCRYPTION_KEY -ne $appEnv.GENERATION_MODEL_ENCRYPTION_KEY',
    );
    expect(script).toContain("GENERATION_BACKGROUND_ENABLED -ne '1'");
    expect(script).toContain("GENERATION_ACCEPTING_JOBS -ne '1'");
    expect(script).toContain('Wait-GenerationWorkerHealthy');
    expect(script).toContain('function Initialize-UsageDirectory');
    expect(script).toContain('run --rm --no-deps usage-init');
    expect(script).toContain('org.opencontainers.image.revision');
    expect(script).toContain('OPENMAIC_SOURCE_REVISION');
    expect(script).toContain('[switch]$AllowDirty');
    expect(script).toContain('NpmRegistryOverride must be an absolute HTTPS URL');
    expect(script).toContain('NPM_REGISTRY=$NpmRegistryOverride');
    expect(script).toContain('return "worktree-$($headRevision.Substring(0, 12))-$fingerprint"');
    expect(script).toContain('git hash-object -- $path');
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
