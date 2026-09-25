import type { Queryable } from '@openmaic/storage/document/pg';
import { GenerationJobError } from './contracts';

export interface GenerationOwnership extends Record<string, unknown> {
  stage_id: string;
  owner_id: string;
  producer_kind: string;
  producer_ref: string | null;
  ownership_epoch: number;
  write_mode: string;
}
export async function readGenerationOwnership(
  q: Queryable,
  stageId: string,
  lock = false,
): Promise<GenerationOwnership | null> {
  const schema = await q.query<{ name: string | null }>(
    "SELECT to_regclass('generation_ownership')::text AS name",
  );
  if (!schema.rows[0]?.name) return null;
  const columns = await q.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'generation_ownership'
        AND column_name = 'stage_id'`,
  );
  if (!columns.rows[0]) return null;
  const result = await q.query<GenerationOwnership>(
    `SELECT * FROM generation_ownership WHERE stage_id=$1 ${lock ? 'FOR UPDATE' : ''}`,
    [stageId],
  );
  return result.rows[0] ?? null;
}
/** Fails closed on errors; old producer metadata protects courses before the additive migration. */
export async function assertClientGenerationAllowed(
  q: Queryable,
  stageId: string,
  ownerId: string,
): Promise<void> {
  const meta = await q.query<{ owner_id: string; deleted_at: unknown }>(
    'SELECT owner_id,deleted_at FROM stage_meta WHERE stage_id=$1',
    [stageId],
  );
  if (!meta.rows[0] || meta.rows[0].owner_id !== ownerId || meta.rows[0].deleted_at !== null)
    throw new GenerationJobError('COURSE_NOT_FOUND', 404);
  const ownership = await readGenerationOwnership(q, stageId);
  if (ownership && (ownership.owner_id !== ownerId || ownership.producer_kind !== 'client'))
    throw new GenerationJobError('SERVER_OWNED_GENERATION');
  const outline = await q.query<{ producer: string | null }>(
    "SELECT data->>'producer' AS producer FROM document_outlines WHERE stage_id=$1",
    [stageId],
  );
  if (outline.rows[0]?.producer === 'server-job')
    throw new GenerationJobError('SERVER_OWNED_GENERATION');
}

/** Called before stage_meta locks. Lock order: job -> ownership -> stage_meta -> document. */
export async function assertGenerationMutationAllowed(
  q: Queryable,
  stageId: string,
  ownerId: string,
  options: { internalProducer?: boolean; delete?: boolean } = {},
): Promise<void> {
  const schema = await q.query<{ name: string | null }>(
    "SELECT to_regclass('generation_jobs')::text AS name",
  );
  let job: { id: string; owner_id: string; status: string } | undefined;
  if (schema.rows[0]?.name) {
    const columns = await q.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'generation_jobs'
          AND column_name = 'status'`,
    );
    if (columns.rows[0]) {
      const jobs = await q.query<{ id: string; owner_id: string; status: string }>(
        'SELECT id,owner_id,status FROM generation_jobs WHERE stage_id=$1 FOR UPDATE',
        [stageId],
      );
      job = jobs.rows[0];
      if (job && job.owner_id !== ownerId) throw new GenerationJobError('COURSE_NOT_FOUND', 404);
    }
  }
  const ownership = await readGenerationOwnership(q, stageId, true);
  if (ownership) {
    if (ownership.owner_id !== ownerId) throw new GenerationJobError('COURSE_NOT_FOUND', 404);
    if (ownership.write_mode === 'deleted' && !options.delete)
      throw new GenerationJobError('COURSE_NOT_FOUND', 404);
    if (options.delete && job) {
      await q.query(
        "UPDATE generation_jobs SET status=CASE WHEN status='succeeded' THEN status ELSE 'cancelled' END,lease_epoch=lease_epoch+1,worker_id=NULL,lease_expires_at=NULL,cancel_requested_at=clock_timestamp(),state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [job.id],
      );
      await q.query(
        "UPDATE generation_ownership SET write_mode='deleted',ownership_epoch=ownership_epoch+1,updated_at=clock_timestamp() WHERE stage_id=$1",
        [stageId],
      );
      await q.query(
        "INSERT INTO generation_events(job_id,run_no,state_version,type,payload) SELECT id,run_no,state_version,'deleted','{}' FROM generation_jobs WHERE id=$1",
        [job.id],
      );
      return;
    }
    // A generic Agent mutationFence is never a course-worker credential.
    if (ownership.producer_kind === 'course-worker' && ownership.write_mode === 'generating')
      throw new GenerationJobError('SERVER_OWNED_GENERATION');
    if (
      ownership.producer_kind === 'agent-runtime' &&
      !options.internalProducer &&
      ownership.write_mode === 'generating'
    )
      throw new GenerationJobError('SERVER_OWNED_GENERATION');
    return;
  }
  const outline = await q.query<{ producer: string | null }>(
    "SELECT data->>'producer' AS producer FROM document_outlines WHERE stage_id=$1",
    [stageId],
  );
  if (outline.rows[0]?.producer === 'server-job' && !options.internalProducer && !options.delete)
    throw new GenerationJobError('SERVER_OWNED_GENERATION');
}

/** Ordinary whole-document saves cannot erase or forge the server producer marker. */
export async function preserveGenerationProducer(
  q: Queryable,
  stageId: string,
  internalProducer = false,
): Promise<void> {
  const ownership = await readGenerationOwnership(q, stageId);
  if (ownership?.producer_kind === 'course-worker') {
    const meta = await q.query<{ generation_complete: boolean }>(
      'SELECT generation_complete FROM stage_meta WHERE stage_id=$1',
      [stageId],
    );
    await q.query(
      `INSERT INTO document_outlines(stage_id,data) VALUES($1,jsonb_build_object('outlines','[]'::jsonb,'producer','server-job','producerKind','course-worker','producerRef',$2::text,'generationComplete',$3::boolean))
      ON CONFLICT(stage_id) DO UPDATE SET data=document_outlines.data || jsonb_build_object('producer','server-job','producerKind','course-worker','producerRef',$2::text,'generationComplete',$3::boolean)`,
      [stageId, ownership.producer_ref, meta.rows[0]?.generation_complete ?? false],
    );
    return;
  }
  if (!ownership && !internalProducer) {
    const outline = await q.query<{ producer: string | null }>(
      "SELECT data->>'producer' producer FROM document_outlines WHERE stage_id=$1",
      [stageId],
    );
    if (outline.rows[0]?.producer === 'server-job')
      throw new GenerationJobError('SERVER_OWNED_GENERATION');
  }
}
