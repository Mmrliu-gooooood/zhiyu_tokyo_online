import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';

const ROOT = path.join(process.cwd(), 'data', 'render-jobs');
const RENDER_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface RenderJobOwnerRecord {
  jobId: string;
  ownerId: string;
}

async function fileFor(jobId: string): Promise<string> {
  if (!RENDER_JOB_ID.test(jobId)) {
    throw new Error('INVALID_RENDER_JOB_ID');
  }
  await fs.mkdir(ROOT, { recursive: true });
  return path.join(ROOT, `${jobId}.json`);
}

export async function recordRenderJobOwner(jobId: string, ownerId: string): Promise<void> {
  if (!RENDER_JOB_ID.test(jobId)) throw new Error('INVALID_RENDER_JOB_ID');
  if (isHostedAuthEnabled()) {
    const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
    const result = await db.query<{ job_id: string }>(
      `INSERT INTO render_job_owners (job_id, owner_id, status)
       VALUES ($1,$2,'queued')
       ON CONFLICT (job_id) DO UPDATE
         SET updated_at=clock_timestamp()
         WHERE render_job_owners.owner_id=excluded.owner_id
       RETURNING job_id`,
      [jobId, ownerId],
    );
    if (result.rows.length !== 1) throw new Error('RENDER_JOB_OWNER_CONFLICT');
    return;
  }
  const file = await fileFor(jobId);
  await fs.writeFile(file, JSON.stringify({ jobId, ownerId } satisfies RenderJobOwnerRecord));
}

export async function readRenderJobOwner(
  jobId: string,
  ownerId?: string,
): Promise<string | undefined> {
  if (!RENDER_JOB_ID.test(jobId)) return undefined;
  if (isHostedAuthEnabled()) {
    if (!ownerId) return undefined;
    const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
    const result = await db.query<{ owner_id: string }>(
      'SELECT owner_id FROM render_job_owners WHERE job_id=$1',
      [jobId],
    );
    return result.rows[0]?.owner_id;
  }
  try {
    const raw = await fs.readFile(await fileFor(jobId), 'utf-8');
    const parsed = JSON.parse(raw) as RenderJobOwnerRecord;
    return parsed.ownerId;
  } catch {
    return undefined;
  }
}

export async function assertRenderJobOwner(
  jobId: string,
  ownerId: string | undefined,
): Promise<boolean> {
  if (!ownerId) return true;
  const recorded = await readRenderJobOwner(jobId, ownerId);
  if (!recorded) return false;
  return recorded === ownerId;
}
