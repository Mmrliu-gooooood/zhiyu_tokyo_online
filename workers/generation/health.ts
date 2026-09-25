import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const WORKER_HEALTH_MARKER_PATH = '/tmp/openmaic-generation-worker-health.json';
export const WORKER_HEALTH_MAX_AGE_MS = 30_000;

interface WorkerHealthMarker {
  pid: number;
  updatedAt: number;
}

function markerPath(path?: string): string {
  return path ?? process.env.GENERATION_WORKER_HEALTH_MARKER_PATH?.trim() ?? WORKER_HEALTH_MARKER_PATH;
}

export async function clearWorkerHealthMarker(path?: string): Promise<void> {
  await unlink(markerPath(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function writeWorkerHealthMarker(
  path?: string,
  options: { now?: number; pid?: number } = {},
): Promise<void> {
  const target = markerPath(path);
  const marker: WorkerHealthMarker = {
    pid: options.pid ?? process.pid,
    updatedAt: options.now ?? Date.now(),
  };
  const temporary = `${target}.${marker.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

export async function assertFreshWorkerHealthMarker(
  path?: string,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? WORKER_HEALTH_MAX_AGE_MS;
  const marker = JSON.parse(await readFile(markerPath(path), 'utf8')) as Partial<WorkerHealthMarker>;
  if (!Number.isSafeInteger(marker.pid) || Number(marker.pid) <= 0) {
    throw new Error('Generation worker health marker has an invalid process id');
  }
  if (!Number.isSafeInteger(marker.updatedAt) || Number(marker.updatedAt) <= 0) {
    throw new Error('Generation worker health marker has an invalid timestamp');
  }
  const age = now - Number(marker.updatedAt);
  if (age < 0) throw new Error('Generation worker health marker is from the future');
  if (age > maxAgeMs) throw new Error('Generation worker health marker is stale');
  try {
    process.kill(Number(marker.pid), 0);
  } catch {
    throw new Error('Generation worker process is not running');
  }
}
