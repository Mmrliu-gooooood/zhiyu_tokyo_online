import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

interface ComposeService {
  image?: string;
  ports?: unknown[];
  dns?: unknown;
  profiles?: string[];
  environment?: Record<string, string>;
  logging?: { driver?: string; options?: Record<string, string> };
}

describe('Tokyo production compose overlay contract', () => {
  const overlaySource = read('docker-compose.production.yml');
  const overlay = load(overlaySource) as { services: Record<string, ComposeService> };
  const launcher = read('scripts/supabase-compose.sh');
  const ORIGIN = 'https://zhiyulearn.online';

  it('uses only the formal origin and never localhost', () => {
    for (const name of ['openmaic', 'generation-worker', 'supabase-readiness']) {
      const env = overlay.services[name]?.environment ?? {};
      expect(env.APP_ORIGIN, name).toBe(ORIGIN);
      expect(env.GENERATION_ALLOWED_ORIGINS, name).toBe(ORIGIN);
    }
    expect(overlaySource).not.toMatch(/localhost|127\.0\.0\.1:3000|http:\/\//);
  });

  it('does not carry the workstation DNS resolvers', () => {
    expect(overlaySource).not.toContain('223.5.5.5');
    expect(overlaySource).not.toContain('119.29.29.29');
    for (const service of Object.values(overlay.services)) expect(service.dns).toBeUndefined();
    expect(launcher).not.toMatch(/-f\s+\S*docker-compose\.dns\.local\.yml/);
    expect(launcher).not.toMatch(/dns_compose|dnsComposeFile/);
  });

  it('does not enable the MP4 video-export profile', () => {
    expect(overlay.services['render-service']).toBeUndefined();
    for (const service of Object.values(overlay.services)) expect(service.profiles).toBeUndefined();
    expect(launcher).not.toMatch(/--profile/);
  });

  it('keeps the Web port bound to loopback only', () => {
    // The overlay must not add ports (Compose appends port lists); the base
    // stack binds 127.0.0.1:3000 only.
    for (const service of Object.values(overlay.services)) expect(service.ports).toBeUndefined();
    const base = load(read('docker-compose.supabase.yml')) as {
      services: Record<string, ComposeService>;
    };
    expect(base.services.openmaic.ports).toEqual(['127.0.0.1:3000:3000']);
  });

  it('requires release image tags and keeps proxy trust opt-in', () => {
    expect(overlay.services.openmaic.image).toContain('ZHIYU_WEB_IMAGE:?');
    expect(overlay.services['generation-worker'].image).toContain('ZHIYU_WORKER_IMAGE:?');
    expect(overlay.services.openmaic.environment?.TRUST_PROXY_HEADERS).toBe(
      '${TRUST_PROXY_HEADERS:-0}',
    );
  });

  it('rotates container logs', () => {
    for (const name of ['openmaic', 'generation-worker']) {
      const logging = overlay.services[name].logging;
      expect(logging?.driver).toBe('json-file');
      expect(logging?.options?.['max-size']).toBeTruthy();
      expect(logging?.options?.['max-file']).toBeTruthy();
    }
  });

  it('launcher mirrors the local tiers, per-owner limit, workers and write gates', () => {
    expect(launcher).toContain('-f "$compose_file" -f "$production_file"');
    expect(launcher).toContain('--project-name openmaic-supabase');
    expect(launcher).toContain('--scale generation-worker=2');
    expect(launcher).toContain('--no-build');
    expect(launcher).toContain('4) heavy=4; runtime=4; worker_concurrency=2; llm=4 ;;');
    expect(launcher).toContain('8) heavy=8; runtime=8; worker_concurrency=4; llm=8 ;;');
    expect(launcher).toContain('16) heavy=16; runtime=16; worker_concurrency=8; llm=16 ;;');
    expect(launcher).toContain(
      'Foreground generation writes require both --accept-jobs and --confirm-writes.',
    );
    expect(launcher).not.toMatch(/compose"?\S*\s+(down|rm)\b/);
    expect(launcher).not.toMatch(/"\$\{compose\[@\]\}" build/);
    // Per-owner limit stays the Supabase compose value; the overlay must not change it.
    expect(overlaySource).not.toContain('APP_HEAVY_TASK_PER_OWNER_LIMIT');
    expect(read('docker-compose.supabase.yml')).toContain("APP_HEAVY_TASK_PER_OWNER_LIMIT: '2'");
  });
});
