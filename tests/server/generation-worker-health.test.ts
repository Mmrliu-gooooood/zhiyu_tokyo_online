import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertFreshWorkerHealthMarker,
  clearWorkerHealthMarker,
  writeWorkerHealthMarker,
} from '@/workers/generation/health';

const directories: string[] = [];

describe('generation worker local health marker', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function markerPath() {
    const directory = await mkdtemp(join(tmpdir(), 'openmaic-worker-health-'));
    directories.push(directory);
    return join(directory, 'heartbeat.json');
  }

  it('accepts a fresh marker written after a successful database heartbeat', async () => {
    const path = await markerPath();
    await writeWorkerHealthMarker(path, { now: 10_000, pid: process.pid });

    await expect(
      assertFreshWorkerHealthMarker(path, { now: 29_999, maxAgeMs: 20_000 }),
    ).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      pid: process.pid,
      updatedAt: 10_000,
    });
  });

  it('rejects missing, stale, future and malformed markers', async () => {
    const path = await markerPath();
    await expect(assertFreshWorkerHealthMarker(path, { now: 30_001, maxAgeMs: 20_000 })).rejects.toThrow();

    await writeWorkerHealthMarker(path, { now: 10_000, pid: process.pid });
    await expect(assertFreshWorkerHealthMarker(path, { now: 30_001, maxAgeMs: 20_000 })).rejects.toThrow(/stale/i);

    await writeWorkerHealthMarker(path, { now: 40_001, pid: process.pid });
    await expect(assertFreshWorkerHealthMarker(path, { now: 30_000, maxAgeMs: 20_000 })).rejects.toThrow(/future/i);

    await writeFile(path, '{not-json', 'utf8');
    await expect(assertFreshWorkerHealthMarker(path, { now: 30_000, maxAgeMs: 20_000 })).rejects.toThrow();
  });

  it('clears a stale marker before the main worker starts', async () => {
    const path = await markerPath();
    await writeWorkerHealthMarker(path, { now: 10_000, pid: process.pid });
    await clearWorkerHealthMarker(path);
    await clearWorkerHealthMarker(path);

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
