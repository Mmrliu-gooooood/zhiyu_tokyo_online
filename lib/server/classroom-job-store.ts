import { promises as fs } from 'fs';
import path from 'path';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: process may have restarted during generation',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
  };

  if (isHostedAuthEnabled()) {
    const owner = hostedJobOwner(ownerId);
    const db = createOwnerBoundQueryable(getPersistencePool(), owner);
    await db.query(
      `INSERT INTO classroom_generation_jobs (job_id, owner_id, payload)
       VALUES ($1,$2,$3::jsonb)`,
      [jobId, owner, JSON.stringify(job)],
    );
  } else {
    await ensureClassroomJobsDir();
    await writeJsonFileAtomic(jobFilePath(jobId), job);
  }
  return job;
}

export async function readClassroomGenerationJob(
  jobId: string,
  ownerId?: string,
): Promise<ClassroomGenerationJob | null> {
  if (isHostedAuthEnabled()) {
    const owner = hostedJobOwner(ownerId);
    const db = createOwnerBoundQueryable(getPersistencePool(), owner);
    const result = await db.query<{ payload: ClassroomGenerationJob }>(
      'SELECT payload FROM classroom_generation_jobs WHERE job_id=$1',
      [jobId],
    );
    return result.rows[0] ? markStaleIfNeeded(result.rows[0].payload) : null;
  }
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as ClassroomGenerationJob;
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  if (isHostedAuthEnabled()) return updateHostedJob(jobId, patch, ownerId);
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  if (isHostedAuthEnabled()) {
    const existing = await readClassroomGenerationJob(jobId, ownerId);
    if (!existing) throw new Error(`Classroom generation job not found: ${jobId}`);
    return updateClassroomGenerationJob(
      jobId,
      {
        status: 'running',
        startedAt: existing.startedAt || new Date().toISOString(),
        message: 'Classroom generation started',
      },
      ownerId,
    );
  }
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(
    jobId,
    {
      status: 'running',
      step: progress.step,
      progress: progress.progress,
      message: progress.message,
      scenesGenerated: progress.scenesGenerated,
      totalScenes: progress.totalScenes,
    },
    ownerId,
  );
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(
    jobId,
    {
      status: 'succeeded',
      step: 'completed',
      progress: 100,
      message: 'Classroom generation completed',
      completedAt: new Date().toISOString(),
      scenesGenerated: result.scenesCount,
      result: {
        classroomId: result.id,
        url: result.url,
        scenesCount: result.scenesCount,
      },
    },
    ownerId,
  );
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
  ownerId?: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(
    jobId,
    {
      status: 'failed',
      step: 'failed',
      message: 'Classroom generation failed',
      completedAt: new Date().toISOString(),
      error,
    },
    ownerId,
  );
}

function hostedJobOwner(explicitOwnerId?: string): string {
  const ownerId = explicitOwnerId ?? getHeavyTaskRootContext()?.ownerId;
  if (!ownerId) throw new Error('HOSTED_CLASSROOM_JOB_OWNER_REQUIRED');
  return ownerId;
}

async function updateHostedJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
  explicitOwnerId?: string,
): Promise<ClassroomGenerationJob> {
  const ownerId = hostedJobOwner(explicitOwnerId);
  const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
  return db.withTransaction(async (transaction) => {
    const result = await transaction.query<{ payload: ClassroomGenerationJob }>(
      `SELECT payload
         FROM classroom_generation_jobs
        WHERE job_id=$1
        FOR UPDATE`,
      [jobId],
    );
    const existing = result.rows[0]?.payload;
    if (!existing) throw new Error(`Classroom generation job not found: ${jobId}`);
    const updated: ClassroomGenerationJob = {
      ...markStaleIfNeeded(existing),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await transaction.query(
      `UPDATE classroom_generation_jobs
          SET payload=$1::jsonb, updated_at=clock_timestamp()
        WHERE job_id=$2 AND owner_id=$3`,
      [JSON.stringify(updated), jobId, ownerId],
    );
    return updated;
  });
}
