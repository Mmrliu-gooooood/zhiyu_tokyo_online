import { createHash, randomUUID } from 'node:crypto';
import { PgAssetStore } from '@openmaic/storage/asset/pg';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import { DSL_VERSION, DSL_VERSION_KEY } from '@openmaic/dsl';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { TransactionSource } from '@/lib/persistence/owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { generationConfig, type GenerationConfig } from './config';
import { generationRequestHash } from './config-snapshot';
import { notifyDurableAgentEvent } from '@/lib/server/agent-runtime/event-notify-bus';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import {
  projectGenerationDisplayProgress,
  type GenerationDisplaySceneFact,
  type GenerationDisplayStepFact,
} from './display-progress';
import {
  checkHeavyTaskAdmission,
  checkHeavyTaskAttentionCapacity,
  checkHeavyTaskQueueCapacity,
  isHeavyTaskFairTurn,
  reserveHeavyTaskAttention,
} from '@/lib/server/heavy-task-admission';
import { assertGenerationSchema } from './migrations';
import { providerFailureDiagnostic, type ProviderFailureDiagnostic } from './failure-diagnostics';
import {
  canonicalHash,
  parseGenerationInput,
  validatePlan,
  GenerationJobError,
  GENERATION_PIPELINE_VERSION,
  type GenerationInput,
  type GenerationJobStatus,
  type GenerationJobView,
  type GenerationLease,
  type StepStart,
  type StepReceipt,
} from './contracts';

interface JobRow extends Record<string, unknown> {
  id: string;
  stage_id: string;
  owner_id: string;
  status: GenerationJobStatus;
  phase: string;
  state_version: number;
  run_no: number;
  plan_revision: number;
  ready_scenes: number;
  total_scenes: number;
  warning_count: number;
  last_error_code: string | null;
  review_hold: boolean;
  auto_continue_at: Date | string | null;
  worker_id: string | null;
  lease_epoch: number;
  lease_expires_at: Date | string | null;
  input_snapshot: GenerationInput;
  request_hash: string;
  review_policy: string;
  config_version: string;
  editable_revision: number | null;
  active_elapsed_ms: number;
  available_at: Date | string;
}
interface StepRow extends Record<string, unknown> {
  id: string;
  step_key: string;
  status: string;
  result: unknown;
  dependency_hash: string;
  attempt_count: number;
  max_attempts: number;
}
export interface SceneCheckpoint extends Record<string, unknown> {
  outlineId: string;
  sceneId: string;
  ordinal: number;
  status: string;
  outline: SceneOutline;
  content: unknown;
  actions: unknown;
}
interface Command {
  commandKey: string;
  expectedVersion?: number;
  planRevision?: number;
  outlines?: SceneOutline[];
  reviewHold?: boolean;
  acknowledged?: boolean;
  stepKeys?: string[];
}
function sanitizeErrorSummary(value: string | undefined): string | null {
  if (!value) return null;
  const compact = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\s+/g, ' ')
    .trim();
  return compact ? compact.slice(0, 240) : null;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
function view(r: JobRow): GenerationJobView {
  return {
    jobId: r.id,
    stageId: r.stage_id,
    status: r.status,
    phase: r.phase,
    stateVersion: Number(r.state_version),
    runNo: r.run_no,
    planRevision: r.plan_revision,
    readyScenes: r.ready_scenes,
    totalScenes: r.total_scenes,
    warningCount: r.warning_count,
    lastErrorCode: r.last_error_code,
    reviewHold: r.review_hold,
    autoContinueAt: r.auto_continue_at ? new Date(r.auto_continue_at).toISOString() : null,
    queueReason: r.status === 'queued' ? 'queued' : null,
    retryAt: r.status === 'retry_wait' ? new Date(r.available_at).toISOString() : null,
    pollUrl: `/api/generate-classroom/${r.id}`,
    courseUrl: `/classroom/${r.stage_id}`,
    pollIntervalMs: 2000,
  };
}
export class GenerationJobRepository {
  readonly config: GenerationConfig;
  constructor(
    readonly pool: TransactionSource,
    options: Partial<GenerationConfig> = {},
  ) {
    this.config = { ...generationConfig(), ...options };
  }
  async transaction<T>(body: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const q: Queryable = {
      async query<R extends Record<string, unknown>>(sql: string, p?: unknown[]) {
        const r = await c.query(sql, p);
        return { rows: r.rows as R[] };
      },
    };
    try {
      await c.query('BEGIN');
      const result = await body(q);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  private async job(q: Queryable, id: string, owner?: string, lock = true): Promise<JobRow> {
    const r = await q.query<JobRow>(
      `SELECT * FROM generation_jobs WHERE id=$1 ${owner ? 'AND owner_id=$2' : ''} ${lock ? 'FOR UPDATE' : ''}`,
      [id, ...(owner ? [owner] : [])],
    );
    if (!r.rows[0]) throw new GenerationJobError('JOB_NOT_FOUND', 404);
    return r.rows[0];
  }
  private rootTaskId(job: JobRow): string {
    const source = job.input_snapshot.source;
    return source?.kind === 'pro' && source.sessionId
      ? `agent:${source.sessionId}`
      : `generation:${job.id}`;
  }
  private async projectedView(q: Queryable, job: JobRow): Promise<GenerationJobView> {
    const [steps, scenes] = await Promise.all([
      q.query<GenerationDisplayStepFact>(
        `SELECT step_key AS key,kind,outline_id AS "outlineId",status,error_code AS "errorCode",started_at AS "startedAt"
         FROM generation_steps WHERE job_id=$1`,
        [job.id],
      ),
      q.query<GenerationDisplaySceneFact>(
        `SELECT outline_id AS "outlineId",status,actions
         FROM generation_scenes WHERE job_id=$1 AND plan_revision=$2 ORDER BY ordinal`,
        [job.id, job.plan_revision],
      ),
    ]);
    return this.projectedViewFromFacts(q, job, steps.rows, scenes.rows);
  }
  private async projectedViewFromFacts(
    q: Queryable,
    job: JobRow,
    steps: GenerationDisplayStepFact[],
    scenes: GenerationDisplaySceneFact[],
  ): Promise<GenerationJobView> {
    const result = {
      ...view(job),
      displayProgress: projectGenerationDisplayProgress({
        phase: job.phase,
        status: job.status,
        totalScenes: job.total_scenes,
        lastErrorCode: job.last_error_code,
        generationInput: job.input_snapshot,
        steps,
        scenes,
      }),
    };
    if (job.status !== 'queued') return result;
    const admission = await checkHeavyTaskAdmission(q, {
      ownerId: job.owner_id,
      rootTaskId: this.rootTaskId(job),
      kind: 'generation',
      agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
      lock: false,
    });
    return {
      ...result,
      queueReason: admission.allowed
        ? 'queued'
        : admission.reason === 'personal_limit'
          ? 'owner_limit'
          : 'site_limit',
    };
  }
  private async projectedViews(q: Queryable, jobs: JobRow[]): Promise<GenerationJobView[]> {
    if (!jobs.length) return [];
    const ids = jobs.map((job) => job.id);
    const [steps, scenes] = await Promise.all([
      q.query<GenerationDisplayStepFact & { jobId: string }>(
        `SELECT job_id AS "jobId",step_key AS key,kind,outline_id AS "outlineId",status,error_code AS "errorCode",started_at AS "startedAt"
         FROM generation_steps WHERE job_id=ANY($1::uuid[])`,
        [ids],
      ),
      q.query<GenerationDisplaySceneFact & { jobId: string }>(
        `SELECT s.job_id AS "jobId",s.outline_id AS "outlineId",s.status,s.actions
         FROM generation_scenes s
         JOIN generation_jobs j ON j.id=s.job_id AND j.plan_revision=s.plan_revision
         WHERE s.job_id=ANY($1::uuid[]) ORDER BY s.job_id,s.ordinal`,
        [ids],
      ),
    ]);
    const stepsByJob = Map.groupBy(steps.rows, (step) => step.jobId);
    const scenesByJob = Map.groupBy(scenes.rows, (scene) => scene.jobId);
    return Promise.all(
      jobs.map((job) =>
        this.projectedViewFromFacts(
          q,
          job,
          stepsByJob.get(job.id) ?? [],
          scenesByJob.get(job.id) ?? [],
        ),
      ),
    );
  }
  private async event(
    q: Queryable,
    id: string,
    type: string,
    payload: Record<string, unknown> = {},
  ) {
    await q.query(
      'INSERT INTO generation_events(job_id,run_no,state_version,type,payload) SELECT id,run_no,state_version,$2,$3::jsonb FROM generation_jobs WHERE id=$1',
      [id, type, JSON.stringify(payload)],
    );
    await this.projectProSession(q, id, type);
  }

  /** Same-transaction projection lets Pro reconnect by replaying its normal event log. */
  private async projectProSession(q: Queryable, id: string, eventType: string): Promise<void> {
    const result = await q.query<JobRow>(
      `SELECT * FROM generation_jobs WHERE id=$1
       AND input_snapshot->'source'->>'kind'='pro'
       AND input_snapshot->'source'->>'sessionId' IS NOT NULL
       AND input_snapshot->'source'->>'submissionId' IS NOT NULL`,
      [id],
    );
    const job = result.rows[0];
    if (!job) return;
    const source = job.input_snapshot.source!;
    const sessionId = source.sessionId!;
    const submissionId = source.submissionId!;
    const session = await q.query<{ attempt: number }>(
      'SELECT attempt FROM agent_sessions WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',
      [sessionId, job.owner_id],
    );
    if (!session.rows[0]) return;
    const snapshot = await this.projectedView(q, job);
    const isError = ['failed', 'needs_attention'].includes(job.status);
    const text = `Course generation: ${job.status} / ${job.phase}; ${job.ready_scenes}/${job.total_scenes} pages ready${job.last_error_code ? ` (${job.last_error_code})` : ''}.`;
    await q.query(
      `INSERT INTO agent_session_events(session_id,seq,ts,attempt,type,data)
       SELECT $1,COALESCE(MAX(seq),0)+1,$2,$3,'tool_execution_end',$4::jsonb
       FROM agent_session_events WHERE session_id=$1`,
      [
        sessionId,
        Date.now(),
        Number(session.rows[0].attempt),
        JSON.stringify({
          toolCallId: submissionId,
          toolName: 'submit_course_generation',
          isError,
          result: { content: [{ type: 'text', text }], details: { ...snapshot, eventType } },
        }),
      ],
    );
    if (job.status === 'succeeded') {
      await q.query(
        `INSERT INTO agent_session_events(session_id,seq,ts,attempt,type,data)
         SELECT $1,COALESCE(MAX(seq),0)+1,$2,$3,'stage_link',$4::jsonb
         FROM agent_session_events WHERE session_id=$1
         AND NOT EXISTS (SELECT 1 FROM agent_session_events WHERE session_id=$1 AND type='stage_link' AND data->>'generationJobId'=$5)`,
        [
          sessionId,
          Date.now(),
          Number(session.rows[0].attempt),
          JSON.stringify({
            stageId: job.stage_id,
            title: 'Generated course',
            url: snapshot.courseUrl,
            generationJobId: job.id,
          }),
          job.id,
        ],
      );
    }
    await notifyDurableAgentEvent(q, { kind: 'session', sessionId });
  }
  private async bump(q: Queryable, id: string) {
    await q.query(
      'UPDATE generation_jobs SET state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1',
      [id],
    );
  }
  /** Every result commit takes these locks on the caller transaction, before document/asset writes. */
  async assertLease(q: Queryable, lease: GenerationLease): Promise<JobRow> {
    const r = await this.job(q, lease.jobId, lease.ownerId);
    const alive = await q.query<{ alive: boolean }>(
      'SELECT lease_expires_at > clock_timestamp() AS alive FROM generation_jobs WHERE id=$1',
      [lease.jobId],
    );
    if (
      r.status !== 'running' ||
      r.worker_id !== lease.workerId ||
      Number(r.lease_epoch) !== lease.leaseEpoch ||
      r.plan_revision !== lease.planRevision ||
      !alive.rows[0]?.alive
    )
      throw new GenerationJobError('STALE_GENERATION_LEASE');
    const own = await q.query<{
      owner_id: string;
      producer_kind: string;
      producer_ref: string;
      ownership_epoch: number;
      write_mode: string;
    }>('SELECT * FROM generation_ownership WHERE stage_id=$1 FOR UPDATE', [lease.stageId]);
    const o = own.rows[0];
    if (
      !o ||
      o.owner_id !== lease.ownerId ||
      o.producer_kind !== 'course-worker' ||
      o.producer_ref !== lease.jobId ||
      Number(o.ownership_epoch) !== lease.ownershipEpoch ||
      o.write_mode !== 'generating'
    )
      throw new GenerationJobError('GENERATION_OWNERSHIP_CONFLICT');
    const meta = await q.query<{ owner_id: string; deleted_at: unknown }>(
      'SELECT owner_id,deleted_at FROM stage_meta WHERE stage_id=$1 FOR UPDATE',
      [lease.stageId],
    );
    const stage = await q.query<{ owner_id: string }>(
      'SELECT owner_id FROM document_stages WHERE id=$1 FOR UPDATE',
      [lease.stageId],
    );
    if (
      !meta.rows[0] ||
      meta.rows[0].owner_id !== lease.ownerId ||
      meta.rows[0].deleted_at !== null ||
      stage.rows[0]?.owner_id !== lease.ownerId
    )
      throw new GenerationJobError('COURSE_NOT_FOUND', 404);
    await this.assertAssetPins(q, lease.jobId);
    return r;
  }
  private async assertAssetPins(q: Queryable, jobId: string): Promise<void> {
    const changed = await q.query<{ changed: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM generation_job_assets a JOIN asset_entries e ON e.id=a.asset_id WHERE a.job_id=$1 AND (a.asset_revision<>e.revision OR a.content_hash<>e.content_hash)) changed',
      [jobId],
    );
    if (changed.rows[0].changed) throw new GenerationJobError('GENERATION_DEPENDENCY_CONFLICT');
  }
  async createJob(ownerId: string, key: string, value: unknown): Promise<GenerationJobView> {
    if (!ownerId || !key || key.length > 200)
      throw new GenerationJobError('INVALID_IDEMPOTENCY_KEY', 400);
    const input = parseGenerationInput(value),
      hash = generationRequestHash(input);
    return this.transaction(async (q) => {
      await assertGenerationSchema(q);
      await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:create'))");
      await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:owner:' || $1))", [ownerId]);
      const found = await q.query<JobRow>(
        'SELECT * FROM generation_jobs WHERE owner_id=$1 AND idempotency_key=$2',
        [ownerId, key],
      );
      if (found.rows[0]) {
        if (found.rows[0].request_hash !== hash)
          throw new GenerationJobError('IDEMPOTENCY_CONFLICT');
        return this.projectedView(q, found.rows[0]);
      }
      const id = randomUUID();
      const queue = await checkHeavyTaskQueueCapacity(q, {
        ownerId,
        rootTaskId:
          input.source?.kind === 'pro' && input.source.sessionId
            ? `agent:${input.source.sessionId}`
            : `generation:${id}`,
      });
      if (!queue.allowed) {
        throw new GenerationJobError(
          queue.reason === 'personal_queue_limit' ? 'OWNER_QUEUE_LIMIT' : 'GENERATION_QUEUE_FULL',
          queue.reason === 'personal_queue_limit' ? 429 : 503,
        );
      }
      const attention = await checkHeavyTaskAttentionCapacity(q, {
        ownerId,
        rootTaskId:
          input.source?.kind === 'pro' && input.source.sessionId
            ? `agent:${input.source.sessionId}`
            : `generation:${id}`,
      });
      if (!attention.allowed) {
        throw new GenerationJobError(
          attention.reason === 'personal_attention_limit'
            ? 'OWNER_REVIEW_ATTENTION_LIMIT'
            : 'GENERATION_REVIEW_ATTENTION_FULL',
          attention.reason === 'personal_attention_limit' ? 429 : 503,
        );
      }
      const count = await q.query<{
        owner_count: number;
        total: number;
        owner_review_attention: number;
        review_attention: number;
      }>(
        `SELECT
           count(*) FILTER(WHERE owner_id=$1 AND status='queued')::int owner_count,
           count(*) FILTER(WHERE status='queued')::int total,
           count(*) FILTER(WHERE owner_id=$1 AND status IN ('awaiting_confirmation','needs_attention'))::int owner_review_attention,
           count(*) FILTER(WHERE status IN ('awaiting_confirmation','needs_attention'))::int review_attention
         FROM generation_jobs`,
        [ownerId],
      );
      if (count.rows[0].owner_count >= this.config.maxQueuedPerOwner)
        throw new GenerationJobError('OWNER_QUEUE_LIMIT', 429);
      if (count.rows[0].total >= this.config.maxQueued)
        throw new GenerationJobError('GENERATION_QUEUE_FULL', 503);
      if (count.rows[0].owner_review_attention >= this.config.maxReviewAttentionPerOwner)
        throw new GenerationJobError('OWNER_REVIEW_ATTENTION_LIMIT', 429);
      if (count.rows[0].review_attention >= this.config.maxReviewAttention)
        throw new GenerationJobError('GENERATION_REVIEW_ATTENTION_FULL', 503);
      const stageId = input.target?.stageId ?? randomUUID(),
        now = Date.now();
      if (input.destination?.folderId) {
        const folder = await q.query<{ id: string }>(
          'SELECT id FROM document_folders WHERE owner_id=$1 AND id=$2',
          [ownerId, input.destination.folderId],
        );
        if (!folder.rows[0]) throw new GenerationJobError('COURSE_FOLDER_NOT_FOUND', 404);
      }
      if (input.target) {
        const target = await q.query<{
          owner_id: string;
          deleted_at: unknown;
          revision: number;
          scene_count: number;
        }>(
          `SELECT m.owner_id,m.deleted_at,r.rev::int revision,
             (SELECT count(*)::int FROM document_scenes s WHERE s.stage_id=d.id) scene_count
           FROM document_stages d JOIN stage_meta m ON m.stage_id=d.id
           JOIN document_stage_revision r ON r.stage_id=d.id
           WHERE d.id=$1 FOR UPDATE OF d,m,r`,
          [stageId],
        );
        const current = target.rows[0];
        if (!current || current.owner_id !== ownerId || current.deleted_at !== null)
          throw new GenerationJobError('COURSE_NOT_FOUND', 404);
        if (Number(current.revision) !== input.target.revision)
          throw new GenerationJobError('TARGET_STAGE_REVISION_CONFLICT');
        if (current.scene_count > 0 && !input.target.replaceExisting)
          throw new GenerationJobError('TARGET_STAGE_NOT_EMPTY');
        const ownership = await q.query<{ write_mode: string }>(
          'SELECT write_mode FROM generation_ownership WHERE stage_id=$1 FOR UPDATE',
          [stageId],
        );
        if (ownership.rows[0]?.write_mode === 'generating')
          throw new GenerationJobError('GENERATION_OWNERSHIP_CONFLICT');
        if (input.target.replaceExisting)
          await q.query('DELETE FROM document_scenes WHERE stage_id=$1', [stageId]);
        await q.query('UPDATE stage_meta SET generation_complete=false WHERE stage_id=$1', [
          stageId,
        ]);
      } else {
        const stage = {
          id: stageId,
          name: input.requirements.requirement.slice(0, 120),
          createdAt: now,
          updatedAt: now,
          interactiveMode: input.requirements.interactiveMode ?? false,
          taskEngineMode: input.requirements.taskEngineMode ?? false,
          [DSL_VERSION_KEY]: DSL_VERSION,
        };
        await q.query(
          'INSERT INTO document_stages(id,name,created_at,updated_at,owner_id,interactive_mode,task_engine_mode,data) VALUES($1,$2,$3,$3,$4,$5,$6,$7::jsonb)',
          [
            stageId,
            stage.name,
            now,
            ownerId,
            stage.interactiveMode,
            stage.taskEngineMode,
            JSON.stringify(stage),
          ],
        );
        await q.query(
          'INSERT INTO stage_meta(stage_id,owner_id,is_public,generation_complete) VALUES($1,$2,false,false)',
          [stageId, ownerId],
        );
      }
      if (input.destination?.folderId) {
        await q.query('UPDATE document_stages SET folder_id=$2 WHERE id=$1 AND owner_id=$3', [
          stageId,
          input.destination.folderId,
          ownerId,
        ]);
      }
      await q.query(
        "INSERT INTO generation_jobs(id,stage_id,owner_id,idempotency_key,request_hash,status,pipeline_version,config_version,input_snapshot,review_policy) VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8::jsonb,$9)",
        [
          id,
          stageId,
          ownerId,
          key,
          hash,
          GENERATION_PIPELINE_VERSION,
          input.model?.configVersion ?? 'server-v1',
          JSON.stringify(input),
          input.review.mode,
        ],
      );
      if (input.review.mode === 'manual' && !(await reserveHeavyTaskAttention(q, id))) {
        throw new GenerationJobError('GENERATION_REVIEW_ATTENTION_FULL', 503);
      }
      await q.query(
        `INSERT INTO generation_ownership(stage_id,owner_id,producer_kind,producer_ref,write_mode)
         VALUES($1,$2,'course-worker',$3,'generating')
         ON CONFLICT(stage_id) DO UPDATE SET producer_kind='course-worker',producer_ref=$3,
           write_mode='generating',ownership_epoch=generation_ownership.ownership_epoch+1,updated_at=clock_timestamp()
         WHERE generation_ownership.owner_id=$2`,
        [stageId, ownerId, id],
      );
      const planned = input.planning ? validatePlan(input.planning.outlines) : [];
      await q.query(
        `INSERT INTO document_outlines(stage_id,data) VALUES($1,$2::jsonb)
        ON CONFLICT(stage_id) DO UPDATE SET data=EXCLUDED.data`,
        [
          stageId,
          JSON.stringify({
            outlines: planned,
            requirement: input.requirements.requirement,
            generationComplete: false,
            producer: 'server-job',
            producerKind: 'course-worker',
            producerRef: id,
            createdAt: now,
            updatedAt: now,
          }),
        ],
      );
      if (planned.length) {
        await q.query(
          "UPDATE generation_jobs SET plan_revision=1,total_scenes=$2,phase='agents' WHERE id=$1",
          [id, planned.length],
        );
        const seeded = await this.job(q, id);
        await this.freezePlan(q, seeded);
      }
      const sources = input.materials?.sources ?? [];
      const assets = new Set([
        ...sources.map((s) => s.assetId),
        ...(input.materials?.images ?? []).map((i) => i.assetId),
      ]);
      let inputBytes = 0;
      for (const assetId of assets) {
        const result = await q.query<{
          revision: number;
          content_hash: string;
          byte_size: number;
          bytes: unknown;
        }>(
          'SELECT e.revision,e.content_hash,b.byte_size,b.bytes FROM asset_entries e JOIN asset_blobs b ON b.content_hash=e.content_hash WHERE e.id=$1 AND e.principal=$2 FOR SHARE OF e,b',
          [assetId, ownerId],
        );
        const asset = result.rows[0],
          source = sources.find((s) => s.assetId === assetId);
        inputBytes += Number(asset?.byte_size ?? 0);
        // Native PG bytes are validated here. Other backends require a verified owner upload adapter.
        if (
          !asset ||
          inputBytes > 100_000_000 ||
          asset.bytes === null ||
          Number(asset.byte_size) > 100_000_000 ||
          (source && (asset.revision !== source.revision || asset.content_hash !== source.digest))
        )
          throw new GenerationJobError('BACKGROUND_MATERIAL_UNAVAILABLE', 422);
        await q.query(
          "INSERT INTO generation_job_assets(job_id,logical_key,asset_id,role,lifecycle,asset_revision,content_hash) VALUES($1,$2,$3,'input','attached',$4,$5)",
          [id, `input:${assetId}`, assetId, asset.revision, asset.content_hash],
        );
      }
      await this.event(q, id, 'queued');
      return this.projectedView(q, await this.job(q, id));
    });
  }
  async getJob(ownerId: string, id: string): Promise<GenerationJobView | null> {
    return this.transaction(async (q) => {
      try {
        return await this.projectedView(q, await this.job(q, id, ownerId, false));
      } catch (e) {
        if (e instanceof GenerationJobError && e.httpStatus === 404) return null;
        throw e;
      }
    });
  }
  async getJobBySession(ownerId: string, sessionId: string): Promise<GenerationJobView | null> {
    return this.transaction(async (q) => {
      const result = await q.query<JobRow>(
        `SELECT * FROM generation_jobs WHERE owner_id=$1
         AND input_snapshot->'source'->>'kind'='pro'
         AND input_snapshot->'source'->>'sessionId'=$2
         ORDER BY created_at DESC LIMIT 1`,
        [ownerId, sessionId],
      );
      return result.rows[0] ? this.projectedView(q, result.rows[0]) : null;
    });
  }
  async getStageRevision(ownerId: string, stageId: string): Promise<number | null> {
    return this.transaction(async (q) => {
      const result = await q.query<{ revision: number }>(
        `SELECT r.rev::int revision FROM document_stage_revision r
         JOIN stage_meta m ON m.stage_id=r.stage_id
         WHERE r.stage_id=$1 AND m.owner_id=$2 AND m.deleted_at IS NULL`,
        [stageId, ownerId],
      );
      return result.rows[0] ? Number(result.rows[0].revision) : null;
    });
  }
  async listJobs(
    ownerId: string,
    options: { cursor?: string; limit?: number; active?: boolean } = {},
  ) {
    return this.transaction(async (q) => {
      const rows = await q.query<JobRow>(
        `SELECT * FROM generation_jobs WHERE owner_id=$1 ${options.active ? "AND status NOT IN ('succeeded','failed','cancelled')" : ''} AND ($2::text IS NULL OR id::text < $2) ORDER BY id DESC LIMIT $3`,
        [ownerId, options.cursor ?? null, Math.min(100, Math.max(1, options.limit ?? 30))],
      );
      const jobs = await this.projectedViews(q, rows.rows);
      return { jobs, cursor: rows.rows.length ? rows.rows.at(-1)!.id : null };
    });
  }
  private async scenes(q: Queryable, id: string): Promise<SceneCheckpoint[]> {
    return (
      await q.query<SceneCheckpoint>(
        'SELECT outline_id AS "outlineId",scene_id AS "sceneId",ordinal,status,outline,content,actions FROM generation_scenes WHERE job_id=$1 ORDER BY ordinal',
        [id],
      )
    ).rows;
  }
  async getJobDetail(ownerId: string, id: string, cursor = 0) {
    return this.transaction(async (q) => {
      const job = await this.job(q, id, ownerId, false),
        scenes = await this.scenes(q, id);
      const outline = await q.query<{ data: { outlines: SceneOutline[] } }>(
        'SELECT data FROM document_outlines WHERE stage_id=$1',
        [job.stage_id],
      );
      const events = await q.query<{
        id: string;
        type: string;
        payload: unknown;
        state_version: string;
      }>(
        'SELECT id,type,payload,state_version FROM generation_events WHERE job_id=$1 AND id>$2 ORDER BY id LIMIT 100',
        [id, cursor],
      );
      const active = await q.query<{ key: string; kind: string; outlineId: string | null }>(
        'SELECT step_key AS key,kind,outline_id AS "outlineId" FROM generation_steps WHERE job_id=$1 AND status=\'running\'',
        [id],
      );
      return {
        ...(await this.projectedView(q, job)),
        outlines: outline.rows[0]?.data.outlines ?? [],
        scenes,
        activeSteps: active.rows,
        events: events.rows,
        cursor: events.rows.at(-1)?.id ?? String(cursor),
      };
    });
  }
  async claim(
    workerId: string,
    pipelineVersions = [GENERATION_PIPELINE_VERSION],
  ): Promise<GenerationLease | null> {
    return this.transaction(async (q) => {
      await assertGenerationSchema(q);
      let offset = 0;
      for (;;) {
        const rows = await q.query<JobRow>(
          `SELECT * FROM generation_jobs AS candidate
         WHERE ((status='queued' AND updated_at>clock_timestamp()-$2*interval '1 millisecond') OR status='retry_wait')
           AND available_at<=clock_timestamp()
           AND pipeline_version=ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM generation_jobs AS active
             WHERE active.owner_id=candidate.owner_id AND active.status='running'
               AND active.lease_expires_at>clock_timestamp()
               AND NOT (
                 candidate.input_snapshot->'source'->>'kind'='pro'
                 AND NULLIF(candidate.input_snapshot->'source'->>'sessionId','') IS NOT NULL
                 AND active.input_snapshot->'source'->>'kind'='pro'
                 AND active.input_snapshot->'source'->>'sessionId'=candidate.input_snapshot->'source'->>'sessionId'
               )
           )
         ORDER BY priority DESC,available_at,created_at,id
         LIMIT 20 OFFSET $3 FOR UPDATE SKIP LOCKED`,
          [pipelineVersions, this.config.queueWaitMs, offset],
        );
        for (const r of rows.rows) {
          const lock = await q.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext('generation:owner:' || $1)) AS locked",
            [r.owner_id],
          );
          if (!lock.rows[0]?.locked) continue;
          const admission = await checkHeavyTaskAdmission(q, {
            ownerId: r.owner_id,
            rootTaskId: this.rootTaskId(r),
            kind: 'generation',
            agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
          });
          if (!admission.allowed) continue;
          if (
            !admission.inherited &&
            !(await isHeavyTaskFairTurn(q, {
              ownerId: r.owner_id,
              rootTaskId: this.rootTaskId(r),
              kind: 'generation',
              agentLeaseTtlMs: agentRuntimeConfig.leaseTtlMs,
            }))
          )
            continue;
          const own = await q.query<{
            ownership_epoch: number;
            write_mode: string;
            owner_id: string;
          }>(
            'SELECT ownership_epoch,write_mode,owner_id FROM generation_ownership WHERE stage_id=$1 FOR UPDATE',
            [r.stage_id],
          );
          if (own.rows[0]?.write_mode !== 'generating' || own.rows[0].owner_id !== r.owner_id)
            continue;
          await q.query(
            "UPDATE generation_jobs SET status='running',worker_id=$2,lease_epoch=lease_epoch+1,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',heartbeat_at=clock_timestamp(),started_at=COALESCE(started_at,clock_timestamp()),state_version=state_version+1 WHERE id=$1",
            [r.id, workerId, this.config.leaseMs],
          );
          await this.event(q, r.id, 'claimed');
          return {
            jobId: r.id,
            stageId: r.stage_id,
            ownerId: r.owner_id,
            workerId,
            leaseEpoch: Number(r.lease_epoch) + 1,
            ownershipEpoch: Number(own.rows[0].ownership_epoch),
            planRevision: r.plan_revision,
            input: r.input_snapshot,
          };
        }
        if (rows.rows.length < 20) return null;
        offset += rows.rows.length;
      }
    });
  }
  async heartbeat(lease: GenerationLease): Promise<boolean> {
    return this.transaction(async (q) => {
      const r = await q.query<{ id: string }>(
        "UPDATE generation_jobs SET active_elapsed_ms=active_elapsed_ms+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-heartbeat_at))*1000)::bigint,heartbeat_at=clock_timestamp(),lease_expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 AND worker_id=$2 AND lease_epoch=$3 AND status='running' AND lease_expires_at>clock_timestamp() RETURNING id",
        [lease.jobId, lease.workerId, lease.leaseEpoch, this.config.leaseMs],
      );
      return r.rows.length === 1;
    });
  }
  async workerHeartbeat(
    workerId: string,
    pipelineVersions = [GENERATION_PIPELINE_VERSION],
    draining = false,
  ): Promise<void> {
    await this.transaction((q) =>
      q.query(
        'INSERT INTO generation_worker_heartbeats(worker_id,pipeline_versions,draining) VALUES($1,$2::jsonb,$3) ON CONFLICT(worker_id) DO UPDATE SET pipeline_versions=EXCLUDED.pipeline_versions,heartbeat_at=clock_timestamp(),draining=EXCLUDED.draining',
        [workerId, JSON.stringify(pipelineVersions), draining],
      ),
    );
  }
  async getSnapshot(lease: GenerationLease) {
    return this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      const scenes = await this.scenes(q, lease.jobId);
      const steps = await q.query<{ key: string; status: string; result: unknown }>(
        'SELECT step_key AS key,status,result FROM generation_steps WHERE job_id=$1',
        [lease.jobId],
      );
      return { job: view(job), outlines: scenes.map((s) => s.outline), scenes, steps: steps.rows };
    });
  }
  async getCheckpoint(lease: GenerationLease, key: string): Promise<unknown | undefined> {
    return this.transaction(async (q) => {
      await this.assertLease(q, lease);
      const r = await q.query<StepRow>(
        'SELECT * FROM generation_steps WHERE job_id=$1 AND step_key=$2',
        [lease.jobId, key],
      );
      return r.rows[0]?.status === 'succeeded' ? r.rows[0].result : undefined;
    });
  }
  async beginStep(lease: GenerationLease, input: StepStart): Promise<StepReceipt> {
    return this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      if (Number(job.active_elapsed_ms) >= (lease.input.budget?.activeMs ?? 3_600_000))
        throw new GenerationJobError('GENERATION_BUDGET_EXCEEDED');
      await q.query(
        "INSERT INTO generation_steps(id,job_id,step_key,kind,outline_id,dependency_hash,status) VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(job_id,step_key) DO NOTHING",
        [
          randomUUID(),
          lease.jobId,
          input.key,
          input.kind,
          input.outlineId ?? null,
          input.dependencyHash,
        ],
      );
      const step = (
        await q.query<StepRow>(
          'SELECT * FROM generation_steps WHERE job_id=$1 AND step_key=$2 FOR UPDATE',
          [lease.jobId, input.key],
        )
      ).rows[0];
      if (step.dependency_hash !== input.dependencyHash)
        throw new GenerationJobError('GENERATION_DEPENDENCY_CONFLICT');
      const requestKey = canonicalHash({
        job: lease.jobId,
        step: input.key,
        input: input.dependencyHash,
      });
      if (step.status === 'succeeded' || step.status === 'skipped')
        return {
          stepId: step.id,
          attemptId: null,
          requestKey,
          status: step.status,
          result: step.result,
        };
      if (
        ['running', 'uncertain', 'cancelled', 'failed'].includes(step.status) ||
        step.attempt_count >= step.max_attempts
      )
        throw new GenerationJobError('GENERATION_STEP_NOT_RUNNABLE');
      const due = await q.query<{ due: boolean }>(
        'SELECT available_at<=clock_timestamp() AS due FROM generation_steps WHERE id=$1',
        [step.id],
      );
      if (!due.rows[0].due) throw new GenerationJobError('GENERATION_RETRY_NOT_DUE');
      const deadline = Math.min(input.deadlineMs ?? 300_000, 600_000);
      await q.query(
        "UPDATE generation_steps SET status='running',attempt_count=attempt_count+1,started_at=clock_timestamp(),deadline_at=clock_timestamp()+$2*interval '1 millisecond',error_code=NULL WHERE id=$1",
        [step.id, deadline],
      );
      const attemptId = input.external ? randomUUID() : null;
      const priorProviderRequest = input.external
        ? ((
            await q.query<{ provider_request_id: string | null }>(
              `SELECT provider_request_id FROM generation_attempts
               WHERE step_id=$1 AND provider_request_id IS NOT NULL
               ORDER BY attempt_no DESC LIMIT 1`,
              [step.id],
            )
          ).rows[0]?.provider_request_id ?? undefined)
        : undefined;
      if (attemptId)
        await q.query(
          "INSERT INTO generation_attempts(id,step_id,attempt_no,lease_epoch,provider_config_ref,request_key,request_hash,provider_request_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')",
          [
            attemptId,
            step.id,
            step.attempt_count + 1,
            lease.leaseEpoch,
            job.config_version,
            requestKey,
            input.dependencyHash,
            priorProviderRequest ?? null,
          ],
        );
      const phases: Record<string, string> = {
        research: 'researching',
        plan: 'outlines',
        agents: 'agents',
        content: 'scene_content',
        actions: 'scene_actions',
        tts: 'tts',
        media: 'media',
      };
      const phase = phases[input.key.split(':')[0]];
      if (phase)
        await q.query('UPDATE generation_jobs SET phase=$2 WHERE id=$1', [lease.jobId, phase]);
      await this.bump(q, lease.jobId);
      await this.event(q, lease.jobId, 'step_started', { stepKey: input.key, kind: input.kind });
      return {
        stepId: step.id,
        attemptId,
        requestKey,
        status: 'running',
        ...(priorProviderRequest ? { providerRequestId: priorProviderRequest } : {}),
      };
    });
  }
  async recordProviderRequest(
    lease: GenerationLease,
    input: { attemptId: string; taskId: string },
  ): Promise<void> {
    if (!input.taskId || input.taskId.length > 500)
      throw new GenerationJobError('INVALID_PROVIDER_REQUEST_ID', 400);
    await this.transaction(async (q) => {
      await this.assertLease(q, lease);
      const updated = await q.query<{ id: string }>(
        `UPDATE generation_attempts a SET provider_request_id=$3
         FROM generation_steps s WHERE a.id=$1 AND a.step_id=s.id AND s.job_id=$2
         AND a.outcome='running' AND (a.provider_request_id IS NULL OR a.provider_request_id=$3)
         RETURNING a.id`,
        [input.attemptId, lease.jobId, input.taskId],
      );
      if (!updated.rows[0]) throw new GenerationJobError('PROVIDER_REQUEST_ID_CONFLICT');
    });
  }
  async commitCheckpoint(
    lease: GenerationLease,
    input: {
      stepKey: string;
      result: unknown;
      outlineId?: string;
      sceneStatus?: string;
      content?: unknown;
      actions?: unknown;
      previousSpeechesHash?: string;
    },
  ): Promise<void> {
    await this.transaction(async (q) => {
      await this.assertLease(q, lease);
      await this.checkpoint(q, lease, input.stepKey, input.result);
      if (input.outlineId)
        await q.query(
          'UPDATE generation_scenes SET status=COALESCE($3,status),content=COALESCE($4::jsonb,content),actions=COALESCE($5::jsonb,actions),previous_speeches_hash=COALESCE($6,previous_speeches_hash),content_hash=COALESCE($7,content_hash) WHERE job_id=$1 AND outline_id=$2',
          [
            lease.jobId,
            input.outlineId,
            input.sceneStatus ?? null,
            input.content === undefined ? null : JSON.stringify(input.content),
            input.actions === undefined ? null : JSON.stringify(input.actions),
            input.previousSpeechesHash ?? null,
            input.content === undefined ? null : canonicalHash(input.content),
          ],
        );
      await this.bump(q, lease.jobId);
      await this.event(q, lease.jobId, 'checkpoint', { stepKey: input.stepKey });
    });
  }
  private async checkpoint(q: Queryable, lease: GenerationLease, key: string, result: unknown) {
    const row = (
      await q.query<StepRow>(
        'SELECT * FROM generation_steps WHERE job_id=$1 AND step_key=$2 FOR UPDATE',
        [lease.jobId, key],
      )
    ).rows[0];
    if (!row) throw new GenerationJobError('GENERATION_STEP_NOT_FOUND');
    if (row.status === 'succeeded') {
      if (canonicalHash(row.result) !== canonicalHash(result))
        throw new GenerationJobError('CHECKPOINT_CONFLICT');
      return;
    }
    if (row.status !== 'running') throw new GenerationJobError('GENERATION_STEP_NOT_RUNNING');
    await q.query(
      "UPDATE generation_steps SET status='succeeded',result=$2::jsonb,error_code=NULL WHERE id=$1",
      [row.id, JSON.stringify(result)],
    );
    await q.query(
      "UPDATE generation_attempts SET outcome='succeeded',finished_at=clock_timestamp() WHERE step_id=$1 AND lease_epoch=$2 AND outcome='running'",
      [row.id, lease.leaseEpoch],
    );
  }
  /** Known optional-media failure, warning and attempt outcome commit together. */
  async skipStepWithWarning(
    lease: GenerationLease,
    input: { stepKey: string; code: string },
  ): Promise<void> {
    if (!['MEDIA_REQUEST_REJECTED', 'MEDIA_TASK_FAILED'].includes(input.code))
      throw new GenerationJobError('INVALID_MEDIA_WARNING');
    await this.transaction(async (q) => {
      await this.assertLease(q, lease);
      const step = (
        await q.query<StepRow>(
          'SELECT * FROM generation_steps WHERE job_id=$1 AND step_key=$2 FOR UPDATE',
          [lease.jobId, input.stepKey],
        )
      ).rows[0];
      if (!step) throw new GenerationJobError('GENERATION_STEP_NOT_FOUND');
      if (step.kind !== 'media' || !input.stepKey.startsWith('media:'))
        throw new GenerationJobError('INVALID_MEDIA_WARNING_STEP');
      if (step.status === 'skipped') return;
      if (step.status !== 'running') throw new GenerationJobError('GENERATION_STEP_NOT_RUNNING');
      await q.query(
        "UPDATE generation_steps SET status='skipped',result='null'::jsonb,error_code=$2 WHERE id=$1",
        [step.id, input.code],
      );
      await q.query(
        "UPDATE generation_attempts SET outcome='safe_failure',finished_at=clock_timestamp() WHERE step_id=$1 AND lease_epoch=$2 AND outcome='running'",
        [step.id, lease.leaseEpoch],
      );
      await q.query(
        'UPDATE generation_jobs SET warning_count=warning_count+1,state_version=state_version+1 WHERE id=$1',
        [lease.jobId],
      );
      await this.event(q, lease.jobId, 'media_warning', {
        stepKey: input.stepKey,
        code: input.code,
      });
    });
  }

  async savePlan(
    lease: GenerationLease,
    outlines: SceneOutline[],
    stagePatch?: Partial<Stage>,
  ): Promise<void> {
    validatePlan(outlines);
    await this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      if (job.plan_revision !== 0) throw new GenerationJobError('PLAN_ALREADY_FROZEN');
      if (stagePatch) await this.patchStage(q, lease, stagePatch);
      const revision = job.plan_revision + 1;
      await q.query(
        "UPDATE document_outlines SET data=jsonb_set(data,'{outlines}',$2::jsonb)||jsonb_build_object('updatedAt',$3::bigint) WHERE stage_id=$1",
        [lease.stageId, JSON.stringify(outlines.map((o, i) => ({ ...o, order: i }))), Date.now()],
      );
      await q.query(
        "UPDATE generation_jobs SET status='awaiting_confirmation',phase='outlines',plan_revision=$2,total_scenes=$3,worker_id=NULL,lease_expires_at=NULL,lease_epoch=lease_epoch+1,state_version=state_version+1,auto_continue_at=CASE WHEN review_policy='auto' THEN clock_timestamp()+$4*interval '1 second' ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1",
        [lease.jobId, revision, outlines.length, lease.input.review.autoConfirmSeconds ?? 2.5],
      );
      await this.event(q, lease.jobId, 'awaiting_confirmation');
    });
  }
  async updateStage(lease: GenerationLease, patch: Partial<Stage>): Promise<void> {
    await this.transaction(async (q) => {
      await this.assertLease(q, lease);
      await this.patchStage(q, lease, patch);
    });
  }
  private async patchStage(q: Queryable, lease: GenerationLease, patch: Partial<Stage>) {
    const old = (
      await q.query<{ data: Stage }>('SELECT data FROM document_stages WHERE id=$1', [
        lease.stageId,
      ])
    ).rows[0].data;
    const next = { ...old, ...patch, id: lease.stageId, updatedAt: Date.now() };
    if (!validateAppStage(next).valid) throw new GenerationJobError('INVALID_STAGE_RESULT');
    await q.query(
      'UPDATE document_stages SET name=$2,description=$3,updated_at=$4,data=$5::jsonb WHERE id=$1',
      [lease.stageId, next.name, next.description ?? null, next.updatedAt, JSON.stringify(next)],
    );
  }
  private async freezePlan(q: Queryable, job: JobRow) {
    const stored = (
      await q.query<{ data: { outlines: SceneOutline[] } }>(
        'SELECT data FROM document_outlines WHERE stage_id=$1',
        [job.stage_id],
      )
    ).rows[0];
    const outlines = validatePlan(stored.data.outlines);
    for (const [ordinal, outline] of outlines.entries())
      await q.query(
        'INSERT INTO generation_scenes(job_id,outline_id,scene_id,ordinal,outline,plan_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [
          job.id,
          outline.id,
          `gscene_${createHash('sha256').update(`${job.id}:${outline.id}`).digest('hex').slice(0, 24)}`,
          ordinal,
          JSON.stringify({ ...outline, order: ordinal }),
          job.plan_revision,
        ],
      );
    await q.query(
      "UPDATE generation_jobs SET status='queued',phase='agents',auto_continue_at=NULL,state_version=state_version+1,available_at=clock_timestamp(),finished_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [job.id],
    );
    await this.event(q, job.id, 'confirmed');
  }
  private async command(
    ownerId: string,
    id: string,
    kind: string,
    input: Command,
    body: (q: Queryable, job: JobRow) => Promise<void>,
  ): Promise<GenerationJobView> {
    if (!input.commandKey || input.commandKey.length > 200)
      throw new GenerationJobError('INVALID_COMMAND_KEY', 400);
    return this.transaction(async (q) => {
      const job = await this.job(q, id, ownerId);
      const hash = canonicalHash({ kind, ...input });
      const old = await q.query<{ request_hash: string; result: GenerationJobView }>(
        'SELECT request_hash,result FROM generation_commands WHERE job_id=$1 AND command_key=$2',
        [id, input.commandKey],
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) throw new GenerationJobError('IDEMPOTENCY_CONFLICT');
        return old.rows[0].result;
      }
      if (
        input.expectedVersion !== undefined &&
        Number(job.state_version) !== input.expectedVersion
      )
        throw new GenerationJobError('STATE_VERSION_CONFLICT');
      const ownership = await q.query<{ owner_id: string; producer_kind: string }>(
        'SELECT owner_id,producer_kind FROM generation_ownership WHERE stage_id=$1 FOR UPDATE',
        [job.stage_id],
      );
      if (
        ownership.rows[0]?.owner_id !== ownerId ||
        ownership.rows[0].producer_kind !== 'course-worker'
      )
        throw new GenerationJobError('GENERATION_OWNERSHIP_CONFLICT');
      const meta = await q.query<{ owner_id: string; deleted_at: unknown }>(
        'SELECT owner_id,deleted_at FROM stage_meta WHERE stage_id=$1 FOR UPDATE',
        [job.stage_id],
      );
      if (
        meta.rows[0]?.owner_id !== ownerId ||
        (meta.rows[0].deleted_at !== null && kind !== 'cancel')
      )
        throw new GenerationJobError('COURSE_NOT_FOUND', 404);
      await body(q, job);
      const result = await this.projectedView(q, await this.job(q, id));
      await q.query(
        'INSERT INTO generation_commands(job_id,command_key,kind,request_hash,result_version,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [id, input.commandKey, kind, hash, result.stateVersion, JSON.stringify(result)],
      );
      return result;
    });
  }
  async reviewOutline(ownerId: string, id: string, input: Command) {
    return this.command(ownerId, id, 'outline', input, async (q, j) => {
      if (
        j.status !== 'awaiting_confirmation' ||
        j.plan_revision !== input.planRevision ||
        input.expectedVersion === undefined
      )
        throw new GenerationJobError('OUTLINE_REVIEW_CONFLICT');
      if (input.outlines) {
        validatePlan(input.outlines);
        await q.query(
          "UPDATE document_outlines SET data=jsonb_set(data,'{outlines}',$2::jsonb) WHERE stage_id=$1",
          [j.stage_id, JSON.stringify(input.outlines.map((o, i) => ({ ...o, order: i })))],
        );
      }
      await q.query(
        "UPDATE generation_jobs SET plan_revision=plan_revision+$2,total_scenes=COALESCE($3,total_scenes),review_hold=$4,review_policy=CASE WHEN $4 THEN review_policy ELSE 'auto' END,auto_continue_at=CASE WHEN $4 THEN NULL ELSE clock_timestamp()+interval '2.5 seconds' END,state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [id, input.outlines ? 1 : 0, input.outlines?.length ?? null, input.reviewHold ?? true],
      );
      await this.event(q, id, 'outline_reviewed');
    });
  }
  async confirm(ownerId: string, id: string, input: Command) {
    return this.command(ownerId, id, 'confirm', input, async (q, j) => {
      if (
        j.status !== 'awaiting_confirmation' ||
        input.expectedVersion === undefined ||
        j.plan_revision !== input.planRevision
      )
        throw new GenerationJobError('OUTLINE_REVIEW_CONFLICT');
      await this.freezePlan(q, j);
    });
  }
  async confirmDuePlans(): Promise<number> {
    return this.transaction(async (q) => {
      const rows = await q.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE status='awaiting_confirmation' AND review_policy='auto' AND NOT review_hold AND auto_continue_at<=clock_timestamp() LIMIT 20 FOR UPDATE SKIP LOCKED",
      );
      for (const job of rows.rows) await this.freezePlan(q, job);
      return rows.rows.length;
    });
  }
  /** End abandoned pure queue/manual-review waits without deleting their durable inputs or outline. */
  async expireWaitingJobs(): Promise<number> {
    return this.transaction(async (q) => {
      const queued = await q.query<JobRow>(
        `SELECT * FROM generation_jobs
         WHERE status='queued'
           AND updated_at<=clock_timestamp()-$1*interval '1 millisecond'
         LIMIT 20 FOR UPDATE SKIP LOCKED`,
        [this.config.queueWaitMs],
      );
      const reviews = await q.query<JobRow>(
        `SELECT * FROM generation_jobs
         WHERE status='awaiting_confirmation'
           AND (review_policy='manual' OR review_hold)
           AND updated_at<=clock_timestamp()-$1*interval '1 millisecond'
         LIMIT 20 FOR UPDATE SKIP LOCKED`,
        [this.config.manualReviewWaitMs],
      );
      for (const [jobs, code, event] of [
        [queued.rows, 'QUEUE_WAIT_EXPIRED', 'queue_expired'],
        [reviews.rows, 'OUTLINE_REVIEW_EXPIRED', 'outline_review_expired'],
      ] as const) {
        for (const job of jobs) {
          await this.projectSceneFailure(q, job.id, 'failed', code);
          await q.query(
            `UPDATE generation_jobs
             SET status='failed',last_error_code=$2,worker_id=NULL,lease_epoch=lease_epoch+1,
                 lease_expires_at=NULL,auto_continue_at=NULL,finished_at=clock_timestamp(),
                 state_version=state_version+1,updated_at=clock_timestamp()
             WHERE id=$1`,
            [job.id, code],
          );
          await this.editable(q, job);
          await this.event(q, job.id, event, { code });
        }
      }
      return queued.rows.length + reviews.rows.length;
    });
  }
  private async editable(q: Queryable, job: JobRow) {
    await q.query(
      "UPDATE generation_ownership SET write_mode='editable',updated_at=clock_timestamp() WHERE stage_id=$1",
      [job.stage_id],
    );
    await q.query(
      'UPDATE generation_jobs SET editable_revision=(SELECT rev FROM document_stage_revision WHERE stage_id=$2) WHERE id=$1',
      [job.id, job.stage_id],
    );
  }
  async cancel(ownerId: string, id: string, input: Command) {
    return this.command(ownerId, id, 'cancel', input, async (q, j) => {
      if (terminal.has(j.status)) return;
      await q.query(
        "UPDATE generation_jobs SET status='cancelled',lease_epoch=lease_epoch+1,worker_id=NULL,lease_expires_at=NULL,cancel_requested_at=clock_timestamp(),finished_at=clock_timestamp(),state_version=state_version+1 WHERE id=$1",
        [id],
      );
      await q.query(
        "UPDATE generation_attempts a SET outcome='uncertain',finished_at=clock_timestamp() FROM generation_steps s WHERE a.step_id=s.id AND s.job_id=$1 AND a.outcome='running'",
        [id],
      );
      await q.query(
        "UPDATE generation_steps SET status='cancelled' WHERE job_id=$1 AND status NOT IN ('succeeded','skipped')",
        [id],
      );
      await this.editable(q, j);
      await this.event(q, id, 'cancelled');
    });
  }
  async retry(ownerId: string, id: string, input: Command) {
    return this.command(ownerId, id, 'retry', input, async (q, j) => {
      if (!['failed', 'needs_attention'].includes(j.status) || input.expectedVersion === undefined)
        throw new GenerationJobError('JOB_NOT_RETRYABLE');
      if (['QUEUE_WAIT_EXPIRED', 'OUTLINE_REVIEW_EXPIRED'].includes(j.last_error_code ?? ''))
        throw new GenerationJobError('EXPIRED_JOB_REQUIRES_NEW_SUBMISSION', 409);
      if (j.status === 'needs_attention' && !input.acknowledged)
        throw new GenerationJobError('EXTERNAL_RESULT_ACKNOWLEDGEMENT_REQUIRED');
      await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:create'))");
      await q.query("SELECT pg_advisory_xact_lock(hashtext('generation:owner:' || $1))", [ownerId]);
      const sharedQueue = await checkHeavyTaskQueueCapacity(q, {
        ownerId,
        rootTaskId: this.rootTaskId(j),
      });
      if (!sharedQueue.allowed) {
        throw new GenerationJobError(
          sharedQueue.reason === 'personal_queue_limit'
            ? 'OWNER_QUEUE_LIMIT'
            : 'GENERATION_QUEUE_FULL',
          sharedQueue.reason === 'personal_queue_limit' ? 429 : 503,
        );
      }
      const queued = await q.query<{ owner_count: number; total: number }>(
        "SELECT count(*) FILTER(WHERE owner_id=$1)::int owner_count,count(*)::int total FROM generation_jobs WHERE id<>$2 AND status='queued'",
        [ownerId, id],
      );
      if (queued.rows[0].owner_count >= this.config.maxQueuedPerOwner)
        throw new GenerationJobError('OWNER_QUEUE_LIMIT', 429);
      if (queued.rows[0].total >= this.config.maxQueued)
        throw new GenerationJobError('GENERATION_QUEUE_FULL', 503);
      const meta = await q.query<{ deleted_at: unknown }>(
        'SELECT deleted_at FROM stage_meta WHERE stage_id=$1 FOR UPDATE',
        [j.stage_id],
      );
      if (!meta.rows[0] || meta.rows[0].deleted_at !== null)
        throw new GenerationJobError('COURSE_NOT_FOUND', 404);
      const rev = await q.query<{ rev: number }>(
        'SELECT rev FROM document_stage_revision WHERE stage_id=$1',
        [j.stage_id],
      );
      if (j.editable_revision !== null && Number(j.editable_revision) !== Number(rev.rows[0]?.rev))
        throw new GenerationJobError('GENERATION_DEPENDENCY_CONFLICT');
      await this.assertAssetPins(q, j.id);
      // Selected scope must include every failed/unknown dependency; successful steps are immutable.
      const failures = await q.query<{ step_key: string }>(
        "SELECT step_key FROM generation_steps WHERE job_id=$1 AND status IN ('failed','uncertain')",
        [id],
      );
      if (input.stepKeys && failures.rows.some((s) => !input.stepKeys!.includes(s.step_key)))
        throw new GenerationJobError('INCOMPLETE_RETRY_SCOPE');
      await q.query(
        "UPDATE generation_steps SET status='pending',available_at=clock_timestamp(),max_attempts=attempt_count+3,error_code=NULL WHERE job_id=$1 AND status IN ('failed','uncertain','retry_wait','running')",
        [id],
      );
      await q.query(
        "UPDATE generation_scenes SET status='pending',error_code=NULL WHERE job_id=$1 AND status IN ('failed','needs_attention','retry_wait')",
        [id],
      );
      await q.query(
        "UPDATE generation_ownership SET write_mode='generating',ownership_epoch=ownership_epoch+1 WHERE stage_id=$1",
        [j.stage_id],
      );
      await q.query(
        "UPDATE generation_jobs SET status='queued',run_no=run_no+1,lease_epoch=lease_epoch+1,worker_id=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_summary=NULL,available_at=clock_timestamp(),finished_at=NULL,state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await this.event(q, id, 'retry_acknowledged');
    });
  }
  async publishScene(lease: GenerationLease, outlineId: string, scene: Scene): Promise<void> {
    if (!validateAppScene(scene).valid) throw new GenerationJobError('INVALID_SCENE_RESULT');
    await this.transaction(async (q) => {
      await this.assertLease(q, lease);
      const rows = await this.scenes(q, lease.jobId);
      const slot = rows.find((s) => s.outlineId === outlineId);
      if (
        !slot ||
        slot.sceneId !== scene.id ||
        scene.stageId !== lease.stageId ||
        scene.order !== slot.ordinal
      )
        throw new GenerationJobError('SCENE_IDENTITY_CONFLICT');
      if (slot.status === 'ready') return;
      if (rows.some((s) => s.ordinal < slot.ordinal && s.status !== 'ready'))
        throw new GenerationJobError('SCENE_ORDER_CONFLICT');
      const unfinished = await q.query<{ n: number }>(
        "SELECT count(*)::int n FROM generation_steps WHERE job_id=$1 AND outline_id=$2 AND status NOT IN ('succeeded','skipped')",
        [lease.jobId, outlineId],
      );
      if (unfinished.rows[0].n > 0) throw new GenerationJobError('SCENE_STEPS_INCOMPLETE');
      await q.query('UPDATE document_stages SET updated_at=$2 WHERE id=$1', [
        lease.stageId,
        Date.now(),
      ]);
      await q.query(
        'INSERT INTO document_scenes(stage_id,id,scene_order,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(stage_id,id) DO UPDATE SET scene_order=EXCLUDED.scene_order,data=EXCLUDED.data',
        [lease.stageId, scene.id, scene.order, JSON.stringify(scene)],
      );
      await q.query(
        "UPDATE generation_scenes SET status='ready',ready_at=clock_timestamp() WHERE job_id=$1 AND outline_id=$2",
        [lease.jobId, outlineId],
      );
      await q.query(
        "UPDATE generation_job_assets SET lifecycle='attached',scene_id=$2 WHERE job_id=$1 AND role='output' AND (scene_id=$2 OR logical_key LIKE $3)",
        [lease.jobId, scene.id, `scene:${outlineId}:%`],
      );
      const refs = new Set<string>();
      const visit = (value: unknown): void => {
        if (typeof value === 'string' && value.startsWith('ast_')) refs.add(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      visit(scene);
      if (refs.size)
        await q.query(
          "UPDATE generation_job_assets SET lifecycle='attached' WHERE job_id=$1 AND asset_id=ANY($2::text[])",
          [lease.jobId, [...refs]],
        );
      await q.query(
        "UPDATE generation_jobs SET ready_scenes=(SELECT count(*) FROM generation_scenes WHERE job_id=$1 AND status='ready'),state_version=state_version+1 WHERE id=$1",
        [lease.jobId],
      );
      await this.event(q, lease.jobId, 'scene_ready', {
        sceneId: scene.id,
        outlineId,
        ordinal: scene.order,
      });
    });
  }
  async complete(lease: GenerationLease): Promise<void> {
    await this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      const pending = await q.query<{ n: number }>(
        "SELECT count(*)::int n FROM generation_steps WHERE job_id=$1 AND status NOT IN ('succeeded','skipped')",
        [lease.jobId],
      );
      if (job.total_scenes < 1 || job.ready_scenes !== job.total_scenes || pending.rows[0].n > 0)
        throw new GenerationJobError('GENERATION_INCOMPLETE');
      await q.query(
        "UPDATE document_outlines SET data=jsonb_set(data,'{generationComplete}','true') WHERE stage_id=$1",
        [lease.stageId],
      );
      await q.query('UPDATE stage_meta SET generation_complete=true WHERE stage_id=$1', [
        lease.stageId,
      ]);
      await q.query(
        "UPDATE generation_jobs SET status='succeeded',phase='finalizing',finished_at=clock_timestamp(),worker_id=NULL,lease_expires_at=NULL,lease_epoch=lease_epoch+1,state_version=state_version+1 WHERE id=$1",
        [lease.jobId],
      );
      await this.editable(q, job);
      await this.event(q, lease.jobId, 'succeeded');
    });
  }
  async failStep(
    lease: GenerationLease,
    input: {
      stepKey: string;
      code: string;
      uncertain: boolean;
      errorSummary?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      diagnostic?: ProviderFailureDiagnostic;
    },
  ): Promise<void> {
    await this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      const step = (
        await q.query<StepRow>(
          'SELECT * FROM generation_steps WHERE job_id=$1 AND step_key=$2 FOR UPDATE',
          [lease.jobId, input.stepKey],
        )
      ).rows[0];
      if (!step || step.status === 'succeeded') return;
      const safeRetry =
        !input.uncertain && input.retryable && step.attempt_count < step.max_attempts;
      const status = input.uncertain ? 'needs_attention' : safeRetry ? 'retry_wait' : 'failed';
      const code = /^[A-Z0-9_]{1,100}$/.test(input.code) ? input.code : 'GENERATION_STEP_FAILED';
      const errorSummary = sanitizeErrorSummary(input.errorSummary);
      const delay = Math.max(
        input.retryAfterMs ?? 0,
        Math.min(60_000, 2000 * 2 ** Math.max(0, step.attempt_count - 1)) +
          Math.floor(Math.random() * 1000),
      );
      await q.query(
        "UPDATE generation_steps SET status=$2,error_code=$3,available_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1",
        [step.id, input.uncertain ? 'uncertain' : safeRetry ? 'retry_wait' : 'failed', code, delay],
      );
      await q.query(
        "UPDATE generation_attempts SET outcome=$2,finished_at=clock_timestamp() WHERE step_id=$1 AND outcome='running'",
        [step.id, input.uncertain ? 'uncertain' : 'safe_failure'],
      );
      // Other concurrent requests are no longer safe to replay after losing this lease.
      const other = await q.query<{ id: string; step_key: string }>(
        "UPDATE generation_attempts a SET outcome='uncertain',finished_at=clock_timestamp() FROM generation_steps s WHERE a.step_id=s.id AND s.job_id=$1 AND a.outcome='running' RETURNING a.id,s.step_key",
        [lease.jobId],
      );
      if (other.rows.length)
        await q.query(
          "UPDATE generation_steps SET status='uncertain',error_code=COALESCE(error_code,'EXTERNAL_RESULT_UNKNOWN') WHERE job_id=$1 AND status='running' AND id IN (SELECT step_id FROM generation_attempts WHERE outcome='uncertain')",
          [lease.jobId],
        );
      await q.query(
        "UPDATE generation_steps SET status='pending' WHERE job_id=$1 AND status='running'",
        [lease.jobId],
      );
      const concurrentUnknown = other.rows.length > 0;
      const finalStatus = concurrentUnknown ? 'needs_attention' : status;
      const finalCode = concurrentUnknown ? 'EXTERNAL_RESULT_UNKNOWN' : code;
      const finalErrorSummary = concurrentUnknown
        ? 'A concurrent external request remained unresolved after the pipeline stopped.'
        : errorSummary;
      await this.projectSceneFailure(q, lease.jobId, finalStatus, finalCode, input.stepKey);
      await q.query(
        "UPDATE generation_jobs SET status=$2,last_error_code=$3,last_error_summary=$5,worker_id=NULL,lease_epoch=lease_epoch+1,lease_expires_at=NULL,available_at=clock_timestamp()+$4*interval '1 millisecond',state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1",
        [lease.jobId, finalStatus, finalCode, delay, finalErrorSummary],
      );
      if (finalStatus !== 'retry_wait') await this.editable(q, job);
      await this.event(q, lease.jobId, finalStatus, {
        stepKey: input.stepKey,
        code: finalCode,
        ...(finalErrorSummary ? { errorSummary: finalErrorSummary } : {}),
        primaryFailure: {
          stepKey: input.stepKey,
          code,
          uncertain: input.uncertain,
          ...(errorSummary ? { errorSummary } : {}),
          ...(providerFailureDiagnostic(input.diagnostic)
            ? { diagnostic: providerFailureDiagnostic(input.diagnostic) }
            : {}),
        },
        concurrentUnknownCount: other.rows.length,
        concurrentUnknown: other.rows.map((attempt) => ({
          attemptId: attempt.id,
          stepKey: attempt.step_key,
        })),
      });
    });
  }
  async fail(lease: GenerationLease, code = 'GENERATION_FAILED', uncertain = false): Promise<void> {
    await this.transaction(async (q) => {
      const job = await this.assertLease(q, lease);
      const attempts = await q.query<{ id: string }>(
        "UPDATE generation_attempts a SET outcome='uncertain' FROM generation_steps s WHERE a.step_id=s.id AND s.job_id=$1 AND a.outcome='running' RETURNING a.id",
        [lease.jobId],
      );
      const state = uncertain || attempts.rows.length ? 'needs_attention' : 'failed';
      await q.query(
        "UPDATE generation_steps SET status=CASE WHEN id IN(SELECT step_id FROM generation_attempts WHERE outcome='uncertain') THEN 'uncertain' ELSE 'failed' END WHERE job_id=$1 AND status='running'",
        [lease.jobId],
      );
      await this.projectSceneFailure(
        q,
        lease.jobId,
        state,
        /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'GENERATION_FAILED',
      );
      await q.query(
        'UPDATE generation_jobs SET status=$2,last_error_code=$3,worker_id=NULL,lease_epoch=lease_epoch+1,lease_expires_at=NULL,state_version=state_version+1 WHERE id=$1',
        [lease.jobId, state, /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'GENERATION_FAILED'],
      );
      await this.editable(q, job);
      await this.event(q, lease.jobId, state);
    });
  }
  async reapExpired(): Promise<number> {
    return this.transaction(async (q) => {
      const jobs = await q.query<JobRow>(
        "SELECT * FROM generation_jobs WHERE status='running' AND lease_expires_at<=clock_timestamp() LIMIT 20 FOR UPDATE SKIP LOCKED",
      );
      for (const job of jobs.rows) {
        const unresolved = await q.query<{ id: string }>(
          "UPDATE generation_attempts a SET outcome='uncertain',finished_at=clock_timestamp() FROM generation_steps s WHERE a.step_id=s.id AND s.job_id=$1 AND a.outcome='running' RETURNING a.id",
          [job.id],
        );
        const uncertain = unresolved.rows.length > 0;
        const code = uncertain ? 'WORKER_LEASE_LOST' : 'WORKER_LEASE_EXPIRED';
        const errorSummary = uncertain
          ? 'External request remained unresolved after the worker lease was lost.'
          : null;
        await q.query(
          "UPDATE generation_steps SET status=CASE WHEN id IN(SELECT step_id FROM generation_attempts WHERE outcome='uncertain') THEN 'uncertain' ELSE 'pending' END WHERE job_id=$1 AND status='running'",
          [job.id],
        );
        await this.projectSceneFailure(
          q,
          job.id,
          uncertain ? 'needs_attention' : 'retry_wait',
          code,
        );
        await q.query(
          'UPDATE generation_jobs SET status=$2,last_error_code=$3,last_error_summary=$4,worker_id=NULL,lease_epoch=lease_epoch+1,lease_expires_at=NULL,available_at=clock_timestamp(),state_version=state_version+1,updated_at=clock_timestamp() WHERE id=$1',
          [job.id, uncertain ? 'needs_attention' : 'retry_wait', code, errorSummary],
        );
        if (uncertain) await this.editable(q, job);
        await this.event(q, job.id, uncertain ? 'needs_attention' : 'lease_reaped');
      }
      return jobs.rows.length;
    });
  }
  /** Keep the existing classroom failure/retry controls driven by durable scene state. */
  private async projectSceneFailure(
    q: Queryable,
    jobId: string,
    state: 'failed' | 'needs_attention' | 'retry_wait',
    code: string,
    failedKey?: string,
  ): Promise<void> {
    const failures = await q.query<{
      outline_id: string | null;
      step_key: string;
      status: string;
      error_code: string | null;
    }>(
      "SELECT outline_id,step_key,status,error_code FROM generation_steps WHERE job_id=$1 AND (status IN ('failed','uncertain','retry_wait') OR step_key=$2)",
      [jobId, failedKey ?? null],
    );
    const targets = new Map<
      string,
      { status: 'failed' | 'needs_attention' | 'retry_wait'; code: string }
    >();
    for (const failure of failures.rows) {
      const outlineId =
        failure.outline_id ??
        /^(?:content|actions|scene|media|tts):([^:]+)/.exec(failure.step_key)?.[1];
      if (!outlineId) continue;
      const projected =
        failure.status === 'uncertain'
          ? 'needs_attention'
          : failure.status === 'retry_wait'
            ? 'retry_wait'
            : 'failed';
      const current = targets.get(outlineId);
      if (!current || projected === 'needs_attention' || current.status === 'retry_wait') {
        targets.set(outlineId, { status: projected, code: failure.error_code ?? code });
      }
    }
    let projected = 0;
    for (const [outlineId, target] of targets) {
      const result = await q.query<{ outline_id: string }>(
        "UPDATE generation_scenes SET status=$3,error_code=$4 WHERE job_id=$1 AND outline_id=$2 AND status<>'ready' RETURNING outline_id",
        [jobId, outlineId, target.status, target.code],
      );
      projected += result.rows.length;
    }
    // Preparation/role/finalization failures may have no outline-specific step.
    // Preserve all ready scenes while exposing the first remaining dependency.
    if (projected === 0)
      await q.query(
        "UPDATE generation_scenes SET status=$2,error_code=$3 WHERE job_id=$1 AND ordinal=(SELECT min(ordinal) FROM generation_scenes WHERE job_id=$1 AND status<>'ready')",
        [jobId, state, code],
      );
  }
  async readAsset(
    ownerId: string,
    assetId: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    return this.transaction(async (q) => {
      const row = (
        await q.query<{
          bytes: Uint8Array | null;
          mime: string;
          content_hash: string;
          byte_size: number;
        }>(
          'SELECT b.bytes,e.mime,e.content_hash,b.byte_size FROM asset_entries e JOIN asset_blobs b ON b.content_hash=e.content_hash WHERE e.id=$1 AND e.principal=$2 FOR SHARE OF e,b',
          [assetId, ownerId],
        )
      ).rows[0];
      if (!row || Number(row.byte_size) > 100_000_000)
        throw new GenerationJobError('BACKGROUND_MATERIAL_UNAVAILABLE', 422);
      const bytes =
        row.bytes ??
        (await lazyAssetByteStore(process.env.ASSET_S3_BUCKET, q).read(row.content_hash as never));
      if (!bytes || bytes.byteLength !== Number(row.byte_size))
        throw new GenerationJobError('BACKGROUND_MATERIAL_UNAVAILABLE', 422);
      return { bytes, mimeType: row.mime };
    });
  }
  /** Asset bytes + allocated identity + logical job mapping share the live lease transaction. */
  async writeAsset(
    lease: GenerationLease,
    input: { logicalKey: string; bytes: Uint8Array; mimeType: string; sceneId?: string },
  ): Promise<string> {
    if (input.bytes.byteLength > (lease.input.budget?.maxAssetBytes ?? 100_000_000))
      throw new GenerationJobError('GENERATION_ASSET_BUDGET_EXCEEDED');
    return this.transaction(async (q) => {
      await this.assertLease(q, lease);
      const existing = await q.query<{ asset_id: string }>(
        'SELECT asset_id FROM generation_job_assets WHERE job_id=$1 AND logical_key=$2',
        [lease.jobId, input.logicalKey],
      );
      if (existing.rows[0]) return existing.rows[0].asset_id;
      const usage = await q.query<{ bytes: number }>(
        "SELECT COALESCE(sum(b.byte_size),0)::bigint AS bytes FROM generation_job_assets a JOIN asset_entries e ON e.id=a.asset_id JOIN asset_blobs b ON b.content_hash=e.content_hash WHERE a.job_id=$1 AND a.role='output'",
        [lease.jobId],
      );
      if (
        Number(usage.rows[0].bytes) + input.bytes.byteLength >
        (lease.input.budget?.maxAssetBytes ?? 100_000_000)
      )
        throw new GenerationJobError('GENERATION_ASSET_BUDGET_EXCEEDED');
      const assetStore = new PgAssetStore(q, {
        withTransaction: (body) => body(q),
        byteStore: lazyAssetByteStore(process.env.ASSET_S3_BUCKET, q),
      });
      const copied = new Uint8Array(input.bytes.byteLength);
      copied.set(input.bytes);
      const id = await assetStore.put(
        { key: lease.ownerId },
        new Blob([copied], { type: input.mimeType }),
        { contentType: input.mimeType },
      );
      await q.query(
        "INSERT INTO generation_job_assets(job_id,logical_key,asset_id,role,scene_id,lifecycle,asset_revision,content_hash) SELECT $1,$2,id,'output',$4,'staged',revision,content_hash FROM asset_entries WHERE id=$3",
        [lease.jobId, input.logicalKey, id, input.sceneId ?? null],
      );
      // A byte backend may await I/O. Expiry while writing must not commit an
      // identity under a lease that was only valid before the upload started.
      await this.assertLease(q, lease);
      return id;
    });
  }
  /** Only discard terminal, unattached outputs. Input/shared/published assets remain pinned. */
  async releaseExpiredStagedAssets(): Promise<number> {
    return this.transaction(async (q) => {
      const grace = Math.max(86_400_000, resolveAssetCollectionGraceMs());
      const jobs = await q.query<JobRow>(
        "SELECT * FROM generation_jobs j WHERE status IN ('succeeded','cancelled') AND finished_at<clock_timestamp()-$1*interval '1 millisecond' AND EXISTS(SELECT 1 FROM generation_job_assets a WHERE a.job_id=j.id AND a.role='output' AND a.lifecycle='staged') LIMIT 20 FOR UPDATE SKIP LOCKED",
        [grace],
      );
      let removed = 0;
      for (const job of jobs.rows) {
        const assets = await q.query<{ asset_id: string; logical_key: string }>(
          "SELECT asset_id,logical_key FROM generation_job_assets WHERE job_id=$1 AND role='output' AND lifecycle='staged' FOR UPDATE",
          [job.id],
        );
        for (const asset of assets.rows) {
          const used = await q.query<{ used: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM document_scenes WHERE data::text LIKE '%' || $1 || '%') OR EXISTS(SELECT 1 FROM document_stages WHERE data::text LIKE '%' || $1 || '%') OR EXISTS(SELECT 1 FROM generation_job_assets WHERE asset_id=$1 AND (job_id<>$2 OR logical_key<>$3)) AS used`,
            [asset.asset_id, job.id, asset.logical_key],
          );
          if (used.rows[0].used) continue;
          await q.query('DELETE FROM generation_job_assets WHERE job_id=$1 AND logical_key=$2', [
            job.id,
            asset.logical_key,
          ]);
          const store = new PgAssetStore(q, {
            withTransaction: (body) => body(q),
            byteStore: lazyAssetByteStore(process.env.ASSET_S3_BUCKET, q),
          });
          await store.remove({ key: job.owner_id }, asset.asset_id);
          removed++;
        }
      }
      return removed;
    });
  }
}
