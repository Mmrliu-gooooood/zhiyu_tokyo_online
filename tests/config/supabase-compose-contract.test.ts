import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('independent Supabase localhost compose contract', () => {
  const compose = read('docker-compose.supabase.yml');
  const launcher = read('scripts/supabase-compose.ps1');
  const example = read('.env.hosted.example');
  const loginCreator = read('scripts/create-hosted-db-logins.ts');
  const loginApplier = read('scripts/apply-hosted-db-logins.ts');

  it('preserves the legacy stack and supports exactly two scaled workers', () => {
    expect(compose).toContain('name: openmaic-supabase');
    expect(compose).toContain("'127.0.0.1:3000:3000'");
    expect(compose).not.toContain('container_name:');
    expect(compose).not.toContain('openmaic-postgres');
    expect(compose).not.toContain('openmaic-data');
    expect(launcher).toContain("'--project-name', 'openmaic-supabase'");
    expect(launcher).toContain("[ValidateSet('Background', 'Foreground')]");
    expect(launcher).toContain("$baseEnvPath = Join-Path $repoRoot '.env.local'");
    expect(launcher).toContain(
      "GENERATION_BACKGROUND_ENABLED = if ($GenerationMode -eq 'Foreground') { '0' } else { '1' }",
    );
    expect(launcher).toContain(
      "$GenerationMode -eq 'Foreground' -and (-not $AcceptJobs -or -not $ConfirmWrites)",
    );
    expect(launcher).toContain(
      "Foreground generation writes require both -AcceptJobs and -ConfirmWrites.",
    );
    expect(launcher).toContain('--scale generation-worker=2');
    expect(launcher).not.toMatch(/@compose\s+down/);
    expect(launcher).not.toMatch(/@compose\s+rm/);
  });

  it('passes a shared managed DB, Storage, model and capacity contract explicitly', () => {
    expect(compose).not.toContain('env_file:');
    expect(compose).toContain('<<: *runtime-environment');
    expect(compose).toContain('DATABASE_URL: ${DATABASE_URL_APP_WEB:?');
    expect(compose).toContain('DATABASE_LISTEN_URL_APP_WEB: ${DATABASE_LISTEN_URL_APP_WEB:?');
    expect(compose).toContain('WORKER_DATABASE_URL: ${WORKER_DATABASE_URL:?');
    expect(compose).toContain('DATABASE_LISTEN_URL: ${DATABASE_LISTEN_URL:?');
    const web = compose.slice(
      compose.indexOf('  openmaic:'),
      compose.indexOf('  generation-worker:'),
    );
    const runtimeAnchor = compose.slice(
      compose.indexOf('x-runtime-environment:'),
      compose.indexOf('services:'),
    );
    const worker = compose.slice(
      compose.indexOf('  generation-worker:'),
      compose.indexOf('  supabase-readiness:'),
    );
    expect(web).not.toContain('WORKER_DATABASE_URL:');
    expect(web).not.toContain('DATABASE_LISTEN_URL:');
    expect(web).toContain('DATABASE_LISTEN_URL_APP_WEB:');
    expect(worker).not.toContain('DATABASE_URL_APP_WEB');
    expect(worker).not.toContain('DATABASE_LISTEN_URL_APP_WEB');
    expect(worker).toContain(
      'PRO_MODEL_ENCRYPTION_KEY: ${PRO_MODEL_ENCRYPTION_KEY:?Set the shared server-only Pro model key}',
    );
    expect(runtimeAnchor).not.toContain('GENERATION_BACKGROUND_ENABLED:');
    expect(web).toContain(
      'GENERATION_BACKGROUND_ENABLED: ${GENERATION_BACKGROUND_ENABLED:?Selected by the capacity launcher}',
    );
    expect(worker).toContain("GENERATION_BACKGROUND_ENABLED: '1'");
    expect(compose).toContain('ASSET_BYTE_BACKEND: s3');
    expect(compose).toContain('MATERIAL_BYTE_BACKEND: s3');
    expect(compose).toContain('CLASSROOM_S3_BUCKET: ${CLASSROOM_S3_BUCKET:?');
    expect(compose).toContain('ASSET_S3_ACCESS_KEY_ID: ${ASSET_S3_ACCESS_KEY_ID:?');
    expect(compose).toContain('MEDIA_CONFIG_ENCRYPTION_KEY: ${MEDIA_CONFIG_ENCRYPTION_KEY:?');
    expect(compose).toContain(
      'GENERATION_MODEL_ENCRYPTION_KEY: ${GENERATION_MODEL_ENCRYPTION_KEY:?',
    );
    expect(compose.match(/^\s+PRO_MODEL_ENCRYPTION_KEY:/gm)).toHaveLength(2);
    expect(compose).not.toContain('SUPABASE_SECRET_KEY:');
    expect(compose).not.toContain('HOSTED_DB_ADMIN_URL:');
    expect(compose).not.toContain('GENERATION_MIGRATION_DATABASE_URL:');
    expect(example).toContain('DATABASE_LISTEN_URL_APP_WEB=');
    expect(launcher).toContain("'DATABASE_LISTEN_URL_APP_WEB'");
    expect(loginCreator).toContain("upsertEnv(env, 'DATABASE_LISTEN_URL_APP_WEB', webUrl)");
    expect(loginApplier).toContain("upsertEnv(env, 'DATABASE_LISTEN_URL_APP_WEB', webUrl)");
  });

  it('mounts the downloaded database CA read-only into every hosted DB process', () => {
    expect(example).toContain('SUPABASE_DB_SSL_ROOT_CERT_PATH=./secrets/supabase-db-ca.crt');
    expect(compose).toContain('SUPABASE_DB_SSL_ROOT_CERT_PATH: /run/secrets/supabase-db-ca.crt');
    expect(compose).toContain(
      'file: ${SUPABASE_DB_SSL_ROOT_CERT_PATH:?Set the downloaded Supabase database CA path}',
    );
    expect(compose.match(/^    secrets: \*db-ca-secrets$/gm)).toHaveLength(3);
    expect(compose).toContain('mode: 0444');
    expect(launcher).toContain("'SUPABASE_DB_SSL_ROOT_CERT_PATH'");
    expect(read('.dockerignore')).toContain('*.crt');
    const probe = read('scripts/check-supabase-readiness.mjs');
    expect(probe).toContain("readFileSync(required('SUPABASE_DB_SSL_ROOT_CERT_PATH'), 'utf8')");
    expect(probe).toContain('rejectUnauthorized: true');
    expect(probe).not.toContain('rejectUnauthorized: false');
    expect(probe).toContain('WORKER_DATABASE_URL must use a Supabase database host');
  });

  it('rebuilds every protected public feature flag instead of disabling UI paths', () => {
    for (const name of [
      'NEXT_PUBLIC_PERSISTENCE',
      'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED',
      'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED',
      'NEXT_PUBLIC_PI_CHAT_ENABLED',
      'NEXT_PUBLIC_LEARNING_CHECKS_ENABLED',
      'NEXT_PUBLIC_GUIDED_LEARNING_ENABLED',
      'NEXT_PUBLIC_TEACH_BACK_ENABLED',
      'NEXT_PUBLIC_ENABLE_VIDEO_EXPORT',
      'NEXT_PUBLIC_ENABLE_PPTX_IMPORT',
      'NEXT_PUBLIC_AUTH_MODE',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ]) {
      expect(compose).toContain(`${name}:`);
      expect(example).toContain(`${name}=`);
    }
  });

  it('keeps migration writes closed by default and requires an explicit open', () => {
    expect(compose).toContain('GENERATION_ACCEPTING_JOBS: ${GENERATION_ACCEPTING_JOBS:-0}');
    expect(launcher).toContain('if ($AcceptJobs -and -not $ConfirmWrites)');
    expect(launcher).toContain("GENERATION_ACCEPTING_JOBS = if ($AcceptJobs) { '1' } else { '0' }");
  });

  it('preserves the local DNS override and applies runtime fixes without rebuilding', () => {
    expect(launcher).toContain("$dnsComposeFile = Join-Path $repoRoot 'docker-compose.dns.local.yml'");
    expect(launcher).toContain('Test-Path -LiteralPath $dnsComposeFile -PathType Leaf');
    expect(launcher).toContain("$compose += @('-f', $dnsComposeFile)");
    expect(launcher).toContain("$Action -in @('Start', 'Apply') -and $GenerationMode -eq 'Foreground'");
    const apply = launcher.slice(launcher.indexOf("    'Apply' {"), launcher.indexOf("    'Readiness' {"));
    expect(apply).toContain('up -d --no-build --scale generation-worker=2 @services');
    expect(apply).not.toMatch(/@compose\s+(?:build|stop|down|rm)/);
  });

  it.each([
    [4, 2, 4],
    [8, 4, 8],
    [16, 8, 16],
  ])('binds tier %i to coherent two-worker limits', (site, eachWorker, provider) => {
    const row = `${site} { @{ APP_HEAVY_TASK_LIMIT = '${site}'; OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT = '${site}'; GENERATION_WORKER_CONCURRENCY = '${eachWorker}'; GENERATION_LLM_MAX_INFLIGHT = '${provider}' } }`;
    expect(launcher).toContain(row);
  });

  it('checks schemas, each worker heartbeat and all private S3 backends', () => {
    expect(compose).toContain("dist-worker/generation.mjs', '--check'");
    expect(compose).toContain("fetch('http://127.0.0.1:3000/api/health')");
    expect(compose).toContain("command: ['node', 'scripts/check-supabase-readiness.mjs']");
    const probe = read('scripts/check-supabase-readiness.mjs');
    expect(probe).toContain('app_internal.deployment_readiness');
    expect(probe).toContain('HeadBucketCommand');
    expect(probe).toContain("required('CLASSROOM_S3_BUCKET')");
    expect(probe).not.toContain('console.log(process.env');
  });
});
