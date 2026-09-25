import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('hosted compose isolation', () => {
  it('never binds the live classroom port or volumes', () => {
    const hosted = read('docker-compose.hosted.yml');
    const script = read('scripts/generation-compose.ps1');

    expect(hosted).toContain("name: openmaic-hosted");
    expect(hosted).toContain('127.0.0.1:3001:3000');
    expect(hosted).not.toContain('127.0.0.1:3000:3000');
    expect(hosted).not.toContain('openmaic-main_openmaic');
    expect(hosted).toContain('container_name: openmaic-hosted-ui');
    expect(hosted).toContain('image: openmaic-hosted-ui:local');
    expect(hosted).toContain('container_name: openmaic-hosted-worker');
    expect(hosted).toContain('image: openmaic-hosted-worker:local');
    expect(hosted).toContain('ASSET_BYTE_BACKEND: local');
    expect(hosted).toContain('APP_ORIGIN: http://localhost:3001');
    expect(hosted).toContain('DATABASE_URL: ${DATABASE_URL_APP_WEB:?Set DATABASE_URL_APP_WEB in .env.hosted.local}');
    expect(hosted).not.toMatch(/^\s*container_name:\s*zhiyu-worker\s*$/m);
    expect(hosted).toContain('223.5.5.5');
    expect(hosted).not.toContain('postgresql://openmaic-hosted-ui:unused@127.0.0.1:1/none');
    expect(script).toContain('Never auto-load docker-compose.hosted.yml');
    expect(script).not.toContain('docker-compose.hosted.yml up');
  });
});
