import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { createOwnerBoundQueryable } from '@/lib/db/request-queryable';
import { getPersistencePool } from '@/lib/db/pool-registry';
import { getHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';
import { getClassroomSnapshotStore } from '@/lib/server/classroom-snapshot-store';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
  ownerId?: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function classroomOwnerAllows(
  classroom: PersistedClassroomData,
  ownerId: string | undefined,
): boolean {
  if (!ownerId) return !classroom.ownerId;
  // Historical ownerless classrooms remain available only to the legacy
  // unsigned surface. A signed-in account must never claim one merely by
  // knowing its id.
  if (!classroom.ownerId) return false;
  return classroom.ownerId === ownerId;
}

/**
 * Dual-mode media: a missing snapshot stays on the unsigned/legacy file path.
 * A `user:{uuid}` snapshot is private even when AUTH_MODE is unset.
 */
export function classroomMediaAllows(
  classroom: PersistedClassroomData | null,
  ownerId: string | undefined,
): boolean {
  if (ownerId) return Boolean(classroom && classroomOwnerAllows(classroom, ownerId));
  if (!classroom) return true;
  return classroomOwnerAllows(classroom, undefined);
}

function hostedOwnerId(explicitOwnerId?: string): string {
  const ownerId = explicitOwnerId ?? getHeavyTaskRootContext()?.ownerId;
  if (!ownerId) throw new Error('HOSTED_CLASSROOM_OWNER_REQUIRED');
  return ownerId;
}

async function readHostedClassroom(
  id: string,
  explicitOwnerId?: string,
): Promise<PersistedClassroomData | null> {
  const ownerId = hostedOwnerId(explicitOwnerId);
  const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
  const result = await db.query<{ storage_ref: string | null }>(
    'SELECT storage_ref FROM classroom_snapshots WHERE classroom_id=$1',
    [id],
  );
  const storageRef = result.rows[0]?.storage_ref;
  if (!storageRef) return null;
  const bytes = await (await getClassroomSnapshotStore()).get(storageRef);
  const classroom = JSON.parse(new TextDecoder().decode(bytes)) as PersistedClassroomData;
  return classroom.ownerId === ownerId ? classroom : null;
}

export async function readClassroom(
  id: string,
  ownerId?: string,
): Promise<PersistedClassroomData | null> {
  if (isHostedAuthEnabled()) return readHostedClassroom(id, ownerId);
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    ownerId?: string;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  if (isHostedAuthEnabled()) {
    return persistHostedClassroom(data, baseUrl);
  }

  const existing = await readClassroom(data.id);
  if (existing && data.ownerId && (!existing.ownerId || existing.ownerId !== data.ownerId)) {
    const error = new Error('CLASSROOM_OWNER_CONFLICT');
    error.name = 'ClassroomOwnerConflict';
    throw error;
  }

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(data.ownerId || existing?.ownerId ? { ownerId: data.ownerId ?? existing?.ownerId } : {}),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

async function persistHostedClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    ownerId?: string;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const ownerId = hostedOwnerId(data.ownerId);
  const db = createOwnerBoundQueryable(getPersistencePool(), ownerId);
  const metadata = await db.query<{
    owner_id: string;
    storage_ref: string | null;
    version: string | number;
  }>(
    `SELECT owner_id, storage_ref, version
       FROM classroom_snapshots
      WHERE classroom_id=$1`,
    [data.id],
  );
  const current = metadata.rows[0];
  let existing: PersistedClassroomData | null = null;
  if (current?.storage_ref) {
    const bytes = await (await getClassroomSnapshotStore()).get(current.storage_ref);
    existing = JSON.parse(new TextDecoder().decode(bytes)) as PersistedClassroomData;
  }
  if (existing?.ownerId && existing.ownerId !== ownerId) {
    const error = new Error('CLASSROOM_OWNER_CONFLICT');
    error.name = 'ClassroomOwnerConflict';
    throw error;
  }

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ownerId,
  };
  const priorVersion = current ? Number(current.version) : 0;
  const version = priorVersion + 1;
  const store = await getClassroomSnapshotStore();
  const storageRef = await store.put({
    ownerId,
    classroomId: data.id,
    version,
    bytes: new TextEncoder().encode(JSON.stringify(classroomData)),
  });

  try {
    await db.withTransaction(async (transaction) => {
      if (current) {
        const updated = await transaction.query<{ classroom_id: string }>(
          `UPDATE classroom_snapshots
              SET stage_id=$1, storage_ref=$2, version=$3, updated_at=clock_timestamp()
            WHERE classroom_id=$4 AND owner_id=$5 AND version=$6
            RETURNING classroom_id`,
          [data.stage.id, storageRef, version, data.id, ownerId, priorVersion],
        );
        if (updated.rows.length !== 1) {
          const error = new Error('CLASSROOM_VERSION_CONFLICT');
          error.name = 'ClassroomVersionConflict';
          throw error;
        }
        return;
      }
      await transaction.query(
        `INSERT INTO classroom_snapshots
          (classroom_id, owner_id, stage_id, storage_ref, version)
         VALUES ($1,$2,$3,$4,$5)`,
        [data.id, ownerId, data.stage.id, storageRef, version],
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const ownerConflict = new Error('CLASSROOM_OWNER_CONFLICT');
      ownerConflict.name = 'ClassroomOwnerConflict';
      throw ownerConflict;
    }
    throw error;
  }

  return { ...classroomData, url: `${baseUrl}/classroom/${data.id}` };
}
