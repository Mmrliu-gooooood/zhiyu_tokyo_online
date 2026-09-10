import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  migrateGenerationSchema,
  getGenerationSchemaVersion,
} from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import {
  parseGenerationInput,
  canonicalHash,
  type GenerationLease,
} from '@/lib/server/generation-jobs/contracts';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import { generationConfig } from '@/lib/server/generation-jobs/config';
import type { Scene } from '@/lib/types/stage';

class TestPool {
  constructor(readonly db: PGlite) {}
  async query<R extends Record<string, unknown>>(sql: string, args?: unknown[]) {
    return this.db.query<R>(sql, args);
  }
  async connect() {
    return { query: (sql: string, args?: unknown[]) => this.db.query(sql, args), release() {} };
  }
}
const input = {
  version: 1,
  requirements: { requirement: 'Test course', interactiveMode: true },
  review: { mode: 'manual' },
};
const outline = {
  id: 'one',
  type: 'slide' as const,
  title: 'One',
  description: 'Test',
  keyPoints: ['Key'],
  order: 0,
};
function numberedOutlines(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...outline,
    id: `scene_${index + 1}`,
    title: `Scene ${index + 1}`,
    order: index,
  }));
}
describe('generation input whitelist', () => {
  it('rejects secret/base URL/browser asset fields, preserves actual requirements', () => {
    expect(parseGenerationInput(input).requirements.interactiveMode).toBe(true);
    for (const extra of [
      { webSearchApiKey: 'CANARY_SECRET' },
      { ownerId: 'foreign' },
      { model: { baseUrl: 'http://localhost' } },
    ])
      expect(() => parseGenerationInput({ ...input, ...extra })).toThrow(
        'INVALID_GENERATION_INPUT',
      );
    expect(() =>
      parseGenerationInput({
        ...input,
        materials: { images: [{ id: 'img', src: 'data:image/png;base64,canary', pageNumber: 1 }] },
      }),
    ).toThrow();
  });
  it('hashes canonical JSON without depending on property insertion order', () =>
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 })));
});
describe('generation admission configuration', () => {
  it('starts with the confirmed site queue and execution limits and permits an explicit two-slot trial', () => {
    expect(generationConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      maxQueuedPerOwner: 5,
      maxQueued: 20,
      maxReviewAttentionPerOwner: 5,
      maxReviewAttention: 20,
      queueWaitMs: 60 * 60 * 1000,
      manualReviewWaitMs: 24 * 60 * 60 * 1000,
    });
    expect(() =>
      generationConfig({ GENERATION_MAX_QUEUED_JOBS: '21' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      generationConfig({
        GENERATION_QUEUE_WAIT_MS: String(60 * 60 * 1000 + 1),
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
describe('generation repository PostgreSQL statements (PGlite, not a lock-concurrency substitute)', () => {
  let db: PGlite, pool: TestPool, repo: GenerationJobRepository;
  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new TestPool(db);
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureAssetSchema(pool);
    await ensureAgentSessionSchema(pool);
    await migrateGenerationSchema(pool);
    repo = new GenerationJobRepository(pool);
  }, 30_000);
  afterEach(async () => {
    await db.close();
  });
  async function create() {
    return repo.createJob('owner', 'create-key', input);
  }
  it('keeps the speech total unknown until a non-empty plan has completed actions', async () => {
    const job = await create();
    expect(job.displayProgress?.speech).toEqual({
      completed: 0,
      total: null,
      active: 0,
      skipped: 0,
    });
  });
  it('projects Pro worker progress into the existing session and links only after success', async () => {
    await pool.query(
      "INSERT INTO agent_sessions(id,owner_id,prompt,stage_id,status) VALUES('pro-session','owner','course','stage','succeeded')",
    );
    const job = await repo.createJob('owner', 'pro-key', {
      ...input,
      source: { kind: 'pro', sessionId: 'pro-session', submissionId: 'submit-call' },
      planning: { outlines: [outline] },
      review: { mode: 'auto' },
    });
    const queued = await pool.query<{
      type: string;
      data: { toolCallId?: string; result?: { details?: { jobId?: string } } };
    }>('SELECT type,data FROM agent_session_events WHERE session_id=$1 ORDER BY seq', [
      'pro-session',
    ]);
    expect(queued.rows.at(-1)).toMatchObject({
      type: 'tool_execution_end',
      data: { toolCallId: 'submit-call', result: { details: { jobId: job.jobId } } },
    });
    expect(queued.rows.some((event) => event.type === 'stage_link')).toBe(false);

    const lease = (await repo.claim('worker'))!;
    const slot = (await repo.getSnapshot(lease)).scenes[0]!;
    await repo.publishScene(lease, 'one', scene(lease, slot.sceneId));
    await repo.complete(lease);
    const completed = await pool.query<{ type: string; data: { generationJobId?: string } }>(
      'SELECT type,data FROM agent_session_events WHERE session_id=$1 ORDER BY seq',
      ['pro-session'],
    );
    expect(completed.rows.filter((event) => event.type === 'stage_link')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ generationJobId: job.jobId }) }),
    ]);
  });
  async function claimed(): Promise<GenerationLease> {
    await create();
    const lease = await repo.claim('worker');
    expect(lease).not.toBeNull();
    return lease!;
  }
  async function confirmed(): Promise<GenerationLease> {
    const lease = await claimed();
    await repo.savePlan(lease, [outline]);
    const job = (await repo.getJob('owner', lease.jobId))!;
    await repo.confirm('owner', job.jobId, {
      commandKey: 'confirm',
      expectedVersion: job.stateVersion,
      planRevision: job.planRevision,
    });
    return (await repo.claim('worker'))!;
  }
  it('projects content checkpoints independently from published scenes and normalizes child calls', async () => {
    const initial = await claimed();
    const outlines = numberedOutlines(8);
    await repo.savePlan(initial, outlines);
    const review = (await repo.getJob('owner', initial.jobId))!;
    await repo.confirm('owner', initial.jobId, {
      commandKey: 'confirm-progress-plan',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
    });
    const lease = (await repo.claim('progress-worker'))!;
    for (const current of outlines.slice(0, 3)) {
      await repo.beginStep(lease, {
        key: `content:${current.id}`,
        kind: `content:${current.id}`,
        dependencyHash: current.id,
      });
      await repo.commitCheckpoint(lease, {
        stepKey: `content:${current.id}`,
        result: { title: current.title },
        outlineId: current.id,
        sceneStatus: 'content_ready',
        content: { title: current.title },
      });
    }
    await repo.beginStep(lease, {
      key: 'content:scene_4:call:0',
      kind: 'llm',
      dependencyHash: 'scene-4-call',
    });

    const detail = await repo.getJobDetail('owner', lease.jobId);
    expect(detail.displayProgress).toEqual({
      phase: 'content',
      content: { completed: 3, total: 8, active: 1 },
      actions: { completed: 0, total: 8, active: 0 },
      speech: { completed: 0, total: null, active: 0, skipped: 0 },
      published: { completed: 0, total: 8 },
    });
  });
  it('keeps concurrent content and speech progress when a TTS step needs attention', async () => {
    const initial = await claimed();
    const outlines = numberedOutlines(2);
    await repo.savePlan(initial, outlines);
    const review = (await repo.getJob('owner', initial.jobId))!;
    await repo.confirm('owner', initial.jobId, {
      commandKey: 'confirm-concurrent-plan',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
    });
    const lease = (await repo.claim('concurrent-worker'))!;
    await repo.beginStep(lease, {
      key: 'content:scene_1',
      kind: 'content:scene_1',
      dependencyHash: 'content-one',
    });
    await repo.commitCheckpoint(lease, {
      stepKey: 'content:scene_1',
      result: { title: 'Scene 1' },
      outlineId: 'scene_1',
      sceneStatus: 'content_ready',
      content: { title: 'Scene 1' },
    });
    const actions = [{ id: 'speech-1', type: 'speech', text: 'Hello', agentId: 'teacher' }];
    await repo.beginStep(lease, {
      key: 'actions:scene_1',
      kind: 'actions:scene_1',
      dependencyHash: 'actions-one',
    });
    await repo.commitCheckpoint(lease, {
      stepKey: 'actions:scene_1',
      result: actions,
      outlineId: 'scene_1',
      sceneStatus: 'actions_ready',
      actions,
    });
    await repo.beginStep(lease, {
      key: 'content:scene_2',
      kind: 'content:scene_2',
      dependencyHash: 'content-two',
    });
    await repo.beginStep(lease, {
      key: 'tts:scene_1',
      kind: 'tts:scene_1',
      dependencyHash: 'tts-one',
    });

    const active = await repo.getJobDetail('owner', lease.jobId);
    expect(active.displayProgress).toEqual({
      phase: 'tts',
      content: { completed: 1, total: 2, active: 1 },
      actions: { completed: 1, total: 2, active: 0 },
      speech: { completed: 0, total: null, active: 1, skipped: 0 },
      published: { completed: 0, total: 2 },
    });

    await repo.failStep(lease, {
      stepKey: 'tts:scene_1',
      code: 'EXTERNAL_RESULT_UNKNOWN',
      uncertain: true,
    });
    const stopped = await repo.getJobDetail('owner', lease.jobId);
    expect(stopped.status).toBe('needs_attention');
    expect(stopped.displayProgress).toEqual({
      phase: 'tts',
      content: { completed: 1, total: 2, active: 0 },
      actions: { completed: 1, total: 2, active: 0 },
      speech: { completed: 0, total: null, active: 0, skipped: 0 },
      published: { completed: 0, total: 2 },
      failedStep: {
        key: 'tts:scene_1',
        phase: 'tts',
        outlineId: 'scene_1',
        code: 'EXTERNAL_RESULT_UNKNOWN',
      },
    });
  });
  it('excludes stale-plan checkpoints and does not count child calls as completed pages', async () => {
    const initial = await claimed();
    await repo.beginStep(initial, {
      key: 'content:stale_scene',
      kind: 'content:stale_scene',
      dependencyHash: 'revision-zero',
    });
    await repo.commitCheckpoint(initial, {
      stepKey: 'content:stale_scene',
      result: { stale: true },
    });
    const [current] = numberedOutlines(1);
    await repo.savePlan(initial, [current]);
    const review = (await repo.getJob('owner', initial.jobId))!;
    await repo.confirm('owner', initial.jobId, {
      commandKey: 'confirm-revised-plan',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
    });
    const lease = (await repo.claim('revision-worker'))!;
    await repo.beginStep(lease, {
      key: 'content:scene_1:call:0',
      kind: 'llm',
      dependencyHash: 'child-call',
    });
    await repo.commitCheckpoint(lease, {
      stepKey: 'content:scene_1:call:0',
      result: { partial: true },
    });
    expect((await repo.getJobDetail('owner', lease.jobId)).displayProgress?.content).toEqual({
      completed: 0,
      total: 1,
      active: 0,
    });

    await repo.beginStep(lease, {
      key: 'content:scene_1',
      kind: 'content:scene_1',
      dependencyHash: 'revision-one',
    });
    await repo.commitCheckpoint(lease, {
      stepKey: 'content:scene_1',
      result: { current: true },
      outlineId: 'scene_1',
      sceneStatus: 'content_ready',
      content: { current: true },
    });
    expect((await repo.getJobDetail('owner', lease.jobId)).displayProgress?.content.completed).toBe(
      1,
    );
  });
  it('reports discovered speech as skipped when TTS is explicitly disabled', async () => {
    const job = await repo.createJob('owner', 'tts-disabled', {
      ...input,
      tts: { enabled: false },
    });
    const initial = (await repo.claim('tts-disabled-plan-worker'))!;
    const [current] = numberedOutlines(1);
    await repo.savePlan(initial, [current]);
    const review = (await repo.getJob('owner', job.jobId))!;
    await repo.confirm('owner', job.jobId, {
      commandKey: 'confirm-tts-disabled-plan',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
    });
    const lease = (await repo.claim('tts-disabled-worker'))!;
    const actions = [
      { id: 'speech-1', type: 'speech', text: 'One', agentId: 'teacher' },
      { id: 'speech-2', type: 'speech', text: 'Two', agentId: 'teacher' },
    ];
    await repo.beginStep(lease, {
      key: 'actions:scene_1',
      kind: 'actions:scene_1',
      dependencyHash: 'actions-without-tts',
    });
    await repo.commitCheckpoint(lease, {
      stepKey: 'actions:scene_1',
      result: actions,
      outlineId: 'scene_1',
      sceneStatus: 'actions_ready',
      actions,
    });

    expect((await repo.getJobDetail('owner', lease.jobId)).displayProgress?.speech).toEqual({
      completed: 0,
      total: 2,
      active: 0,
      skipped: 2,
    });
  });
  function scene(lease: GenerationLease, id: string): Scene {
    return {
      id,
      stageId: lease.stageId,
      type: 'slide',
      title: 'One',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'canvas',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: {
            backgroundColor: '#fff',
            themeColors: ['#000'],
            fontColor: '#000',
            fontName: 'Inter',
          },
          elements: [],
        },
      },
    };
  }
  it('migration reruns are idempotent and checksum drift aborts', async () => {
    await migrateGenerationSchema(pool);
    expect(await getGenerationSchemaVersion(pool)).toBe(4);
    const snapshots = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('media_config_snapshots')::text AS name",
    );
    expect(snapshots.rows[0]?.name).toBe('media_config_snapshots');
    await pool.query("UPDATE generation_schema_migrations SET checksum='drift'");
    await expect(migrateGenerationSchema(pool)).rejects.toThrow('checksum');
  });
  it('creates stage, owner, outline and job once, rejects body conflicts and hides foreign jobs', async () => {
    const job = await create();
    expect(job).toMatchObject({ queueReason: 'queued', retryAt: null });
    expect(await create()).toEqual(job);
    await expect(
      repo.createJob('owner', 'create-key', { ...input, requirements: { requirement: 'Other' } }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await repo.getJob('foreign', job.jobId)).toBeNull();
    const rows = await pool.query<{ producer: string; complete: boolean }>(
      "SELECT o.data->>'producer' producer,m.generation_complete complete FROM document_outlines o JOIN stage_meta m ON m.stage_id=o.stage_id WHERE o.stage_id=$1",
      [job.stageId],
    );
    expect(rows.rows[0]).toEqual({ producer: 'server-job', complete: false });
  });
  it('reuses an owner stage at the exact revision and seeds a supplied Pro plan', async () => {
    const store = createOwnerBoundDocumentStore<Scene>({
      pool,
      ownerId: 'owner',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const now = Date.now();
    await store.saveDocument({
      stage: {
        id: 'pro-target',
        name: 'Pro target',
        createdAt: now,
        updatedAt: now,
        interactiveMode: false,
        taskEngineMode: false,
      },
      scenes: [],
      outline: { outlines: [] },
    });
    const revision = await repo.getStageRevision('owner', 'pro-target');
    expect(revision).not.toBeNull();
    const job = await repo.createJob('owner', 'pro-submit', {
      ...input,
      review: { mode: 'auto' },
      source: { kind: 'pro', sessionId: 'session-1', submissionId: 'tool-1' },
      target: { stageId: 'pro-target', revision },
      planning: { outlines: [outline], skillIds: ['stage-dsl'] },
    });
    expect(job).toMatchObject({ stageId: 'pro-target', phase: 'agents', totalScenes: 1 });
    expect(await repo.getJobBySession('owner', 'session-1')).toMatchObject({ jobId: job.jobId });
    const lease = await repo.claim('worker');
    expect(lease).toMatchObject({ jobId: job.jobId, planRevision: 1 });
    expect((await repo.getSnapshot(lease!)).scenes).toHaveLength(1);
    await expect(
      repo.createJob('owner', 'stale-target', {
        ...input,
        source: { kind: 'pro', sessionId: 'session-2' },
        target: { stageId: 'pro-target', revision: revision! - 1 },
      }),
    ).rejects.toThrow('TARGET_STAGE_REVISION_CONFLICT');
  });
  it('rejects unavailable/shared assets atomically without leaving a placeholder', async () => {
    await expect(
      repo.createJob('owner', 'with-asset', {
        ...input,
        materials: { images: [{ id: 'x', assetId: 'ast_missing', pageNumber: 1 }] },
      }),
    ).rejects.toThrow('BACKGROUND_MATERIAL_UNAVAILABLE');
    expect(
      (await pool.query<{ n: number }>('SELECT count(*)::int n FROM document_stages')).rows[0].n,
    ).toBe(0);
  });
  it('enforces owner queue/active limits and skips incompatible pipeline versions', async () => {
    repo = new GenerationJobRepository(pool, { maxQueuedPerOwner: 2 });
    await create();
    await repo.createJob('owner', 'second', input);
    await expect(repo.createJob('owner', 'third', input)).rejects.toThrow('OWNER_QUEUE_LIMIT');
    expect(await repo.claim('future', ['999'])).toBeNull();
    expect(await repo.claim('one')).not.toBeNull();
    expect(await repo.claim('two')).toBeNull();
  });
  it('counts only queued work against queue limits and separately blocks review/attention backlog', async () => {
    repo = new GenerationJobRepository(pool, {
      maxQueuedPerOwner: 1,
      maxReviewAttentionPerOwner: 1,
    });
    const running = await repo.createJob('owner', 'running', input);
    expect((await repo.claim('worker'))?.jobId).toBe(running.jobId);
    const queued = await repo.createJob('owner', 'queued', input);
    await expect(repo.createJob('owner', 'queue-full', input)).rejects.toThrow('OWNER_QUEUE_LIMIT');
    await repo.cancel('owner', running.jobId, { commandKey: 'cancel-running' });
    await repo.cancel('owner', queued.jobId, { commandKey: 'cancel-queued' });

    const reviewOwner = 'review-owner';
    const review = await repo.createJob(reviewOwner, 'review', input);
    const reviewLease = (await repo.claim('review-worker'))!;
    expect(reviewLease.jobId).toBe(review.jobId);
    await repo.savePlan(reviewLease, [outline]);
    await expect(repo.createJob(reviewOwner, 'blocked-by-review', input)).rejects.toThrow(
      'OWNER_REVIEW_ATTENTION_LIMIT',
    );
  });
  it('reserves manual-review admission before accepted jobs produce an outline', async () => {
    const jobs = [];
    for (let index = 0; index < 5; index += 1) {
      jobs.push(await repo.createJob('reserved-owner', `reserved-${index}`, input));
    }
    expect((await repo.claim('reservation-worker'))?.jobId).toBe(jobs[0].jobId);
    await expect(repo.createJob('reserved-owner', 'reserved-sixth', input)).rejects.toThrow(
      'OWNER_REVIEW_ATTENTION_LIMIT',
    );
  });
  it('counts queued agent roots before accepting an ordinary generation job', async () => {
    for (let index = 0; index < 5; index += 1) {
      await pool.query(
        "INSERT INTO agent_sessions(id,owner_id,prompt,stage_id,status) VALUES($1,$2,$3,$4,'queued')",
        [`agent-${index}`, 'shared-owner', 'course', `stage-${index}`],
      );
    }
    await expect(repo.createJob('shared-owner', 'generation-sixth', input)).rejects.toThrow(
      'OWNER_QUEUE_LIMIT',
    );
  });
  it('enforces the site execution limit in the repository across worker claimants', async () => {
    vi.stubEnv('APP_HEAVY_TASK_LIMIT', '1');
    const first = await repo.createJob('owner-a', 'first', input);
    const ownerBlocked = await repo.createJob('owner-a', 'owner-blocked', input);
    const siteBlocked = await repo.createJob('owner-b', 'second', input);
    expect((await repo.claim('worker-a'))?.jobId).toBe(first.jobId);
    expect(await repo.claim('worker-b')).toBeNull();
    expect(await repo.getJob('owner-a', ownerBlocked.jobId)).toEqual(
      expect.objectContaining({ queueReason: 'owner_limit' }),
    );
    expect(await repo.getJob('owner-b', siteBlocked.jobId)).toEqual(
      expect.objectContaining({ queueReason: 'site_limit' }),
    );
    vi.unstubAllEnvs();
  });
  it('skips an active owner entire backlog so another owner receives the free site slot', async () => {
    vi.stubEnv('APP_HEAVY_TASK_LIMIT', '2');
    try {
      const ownerAJobs = [];
      for (let index = 0; index < 5; index += 1) {
        ownerAJobs.push(await repo.createJob('owner-a', `owner-a-${index}`, input));
      }
      const ownerB = await repo.createJob('owner-b', 'owner-b', input);
      expect((await repo.claim('worker-a'))?.jobId).toBe(ownerAJobs[0].jobId);
      expect((await repo.claim('worker-b'))?.jobId).toBe(ownerB.jobId);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('lets Pro generation children inherit their running agent root without taking another slot', async () => {
    vi.stubEnv('APP_HEAVY_TASK_LIMIT', '1');
    try {
      await pool.query(
        `INSERT INTO agent_sessions(
           id,owner_id,prompt,stage_id,status,lease_worker_id,lease_worker_pid,lease_heartbeat_at
         ) VALUES('pro-root','pro-owner','course','pro-stage','running','agent-worker',1,$1)`,
        [Date.now()],
      );
      for (const key of ['pro-child-one', 'pro-child-two']) {
        await repo.createJob('pro-owner', key, {
          ...input,
          source: { kind: 'pro', sessionId: 'pro-root', submissionId: key },
        });
      }
      expect(await repo.claim('generation-worker-one')).not.toBeNull();
      expect(await repo.claim('generation-worker-two')).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('expires only pure queued waits, retains their input, and does not expire retry backoff', async () => {
    repo = new GenerationJobRepository(pool, { queueWaitMs: 60_000 });
    const expired = await repo.createJob('queue-owner', 'expired', input);
    await pool.query(
      "UPDATE generation_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
      [expired.jobId],
    );
    expect(await repo.expireWaitingJobs()).toBe(1);
    const expiredView = (await repo.getJob('queue-owner', expired.jobId))!;
    expect(expiredView).toMatchObject({
      status: 'failed',
      lastErrorCode: 'QUEUE_WAIT_EXPIRED',
    });
    await expect(
      repo.retry('queue-owner', expired.jobId, {
        commandKey: 'do-not-resume-expired',
        expectedVersion: expiredView.stateVersion,
      }),
    ).rejects.toThrow('EXPIRED_JOB_REQUIRES_NEW_SUBMISSION');
    const retained = await pool.query<{
      requirement: string;
      write_mode: string;
    }>(
      `SELECT j.input_snapshot->'requirements'->>'requirement' requirement,o.write_mode
       FROM generation_jobs j JOIN generation_ownership o ON o.stage_id=j.stage_id
       WHERE j.id=$1`,
      [expired.jobId],
    );
    expect(retained.rows[0]).toEqual({ requirement: 'Test course', write_mode: 'editable' });

    const retryWait = await repo.createJob('queue-owner', 'retry-wait', input);
    await pool.query(
      "UPDATE generation_jobs SET status='retry_wait',updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
      [retryWait.jobId],
    );
    expect(await repo.expireWaitingJobs()).toBe(0);
    expect((await repo.getJob('queue-owner', retryWait.jobId))?.status).toBe('retry_wait');
  });
  it('expires manual outline review after 24 hours with its outline retained, leaving auto review alone', async () => {
    repo = new GenerationJobRepository(pool, { manualReviewWaitMs: 60_000 });
    const manual = await repo.createJob('manual-owner', 'manual', input);
    const manualLease = (await repo.claim('manual-worker'))!;
    await repo.savePlan(manualLease, [outline]);
    await pool.query(
      "UPDATE generation_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
      [manual.jobId],
    );

    const automatic = await repo.createJob('auto-owner', 'auto', {
      ...input,
      review: { mode: 'auto' },
    });
    const autoLease = (await repo.claim('auto-worker'))!;
    await repo.savePlan(autoLease, [{ ...outline, id: 'auto-outline' }]);
    await pool.query(
      "UPDATE generation_jobs SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
      [automatic.jobId],
    );

    expect(await repo.expireWaitingJobs()).toBe(1);
    const expiredReview = (await repo.getJob('manual-owner', manual.jobId))!;
    expect(expiredReview).toMatchObject({
      status: 'failed',
      lastErrorCode: 'OUTLINE_REVIEW_EXPIRED',
    });
    await expect(
      repo.retry('manual-owner', manual.jobId, {
        commandKey: 'do-not-resume-review',
        expectedVersion: expiredReview.stateVersion,
      }),
    ).rejects.toThrow('EXPIRED_JOB_REQUIRES_NEW_SUBMISSION');
    expect((await repo.getJobDetail('manual-owner', manual.jobId)).outlines).toEqual([outline]);
    expect((await repo.getJob('auto-owner', automatic.jobId))?.status).toBe(
      'awaiting_confirmation',
    );
  });
  it('persists manual review, command replay, freeze and scene identity', async () => {
    const lease = await claimed();
    await repo.savePlan(lease, [outline]);
    expect(await repo.heartbeat(lease)).toBe(false);
    const awaiting = (await repo.getJob('owner', lease.jobId))!;
    expect(await repo.claim('other')).toBeNull();
    const cmd = {
      commandKey: 'confirm',
      expectedVersion: awaiting.stateVersion,
      planRevision: awaiting.planRevision,
    };
    const frozen = await repo.confirm('owner', lease.jobId, cmd);
    expect(await repo.confirm('owner', lease.jobId, cmd)).toEqual(frozen);
    await expect(
      repo.confirm('owner', lease.jobId, { ...cmd, commandKey: 'other' }),
    ).rejects.toThrow();
    const next = (await repo.claim('worker'))!;
    expect((await repo.getSnapshot(next)).scenes[0]).toMatchObject({
      outlineId: 'one',
      status: 'pending',
      ordinal: 0,
    });
  });
  it('holds automatic review across worker scans and rejects stale outline edits', async () => {
    const job = await repo.createJob('owner', 'auto', { ...input, review: { mode: 'auto' } });
    const lease = (await repo.claim('worker'))!;
    await repo.savePlan(lease, [outline]);
    const review = (await repo.getJob('owner', job.jobId))!;
    await repo.reviewOutline('owner', job.jobId, {
      commandKey: 'hold',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
      reviewHold: true,
    });
    await pool.query(
      "UPDATE generation_jobs SET auto_continue_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [job.jobId],
    );
    expect(await repo.confirmDuePlans()).toBe(0);
    await expect(
      repo.reviewOutline('owner', job.jobId, {
        commandKey: 'late',
        expectedVersion: review.stateVersion,
        planRevision: review.planRevision,
        outlines: [outline],
      }),
    ).rejects.toThrow('STATE_VERSION_CONFLICT');
  });
  it('cancel fences all future checkpoints and assets, preserves already committed results', async () => {
    const lease = await claimed();
    await repo.beginStep(lease, { key: 'research', kind: 'research', dependencyHash: 'one' });
    await repo.commitCheckpoint(lease, { stepKey: 'research', result: { text: 'saved' } });
    await repo.beginStep(lease, {
      key: 'tts:one:speech',
      kind: 'tts',
      dependencyHash: 'paid-call',
      external: true,
    });
    const result = await repo.cancel('owner', lease.jobId, { commandKey: 'cancel' });
    expect(result.status).toBe('cancelled');
    expect(await repo.heartbeat(lease)).toBe(false);
    await expect(
      repo.commitCheckpoint(lease, { stepKey: 'research', result: { text: 'late' } }),
    ).rejects.toThrow('STALE_GENERATION_LEASE');
    await expect(
      repo.writeAsset(lease, {
        logicalKey: 'late',
        bytes: new Uint8Array([1]),
        mimeType: 'audio/mpeg',
      }),
    ).rejects.toThrow('STALE_GENERATION_LEASE');
    expect(
      (await pool.query<{ result: unknown }>('SELECT result FROM generation_steps')).rows[0].result,
    ).toEqual({ text: 'saved' });
    expect(
      (
        await pool.query<{ outcome: string }>(
          `SELECT a.outcome
             FROM generation_attempts a
             JOIN generation_steps s ON s.id=a.step_id
            WHERE s.step_key='tts:one:speech'`,
        )
      ).rows[0]?.outcome,
    ).toBe('uncertain');
    expect((await repo.getJob('owner', lease.jobId))?.status).toBe('cancelled');
  });
  it('reaps pure work safely, but never automatically replays an external unknown', async () => {
    const first = await claimed();
    await repo.beginStep(first, { key: 'pure', kind: 'prepare', dependencyHash: 'one' });
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    expect(await repo.reapExpired()).toBe(1);
    expect(await repo.getJob('owner', first.jobId)).toEqual(
      expect.objectContaining({
        status: 'retry_wait',
        queueReason: null,
        retryAt: expect.any(String),
      }),
    );
    const second = (await repo.claim('new'))!;
    await expect(
      repo.beginStep(first, { key: 'stale', kind: 'content', dependencyHash: 'x' }),
    ).rejects.toThrow('STALE_GENERATION_LEASE');
    await repo.beginStep(second, {
      key: 'external',
      kind: 'llm',
      dependencyHash: 'paid',
      external: true,
    });
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    await repo.reapExpired();
    const attention = (await repo.getJob('owner', first.jobId))!;
    expect(attention.status).toBe('needs_attention');
    expect(await repo.claim('third')).toBeNull();
    await expect(
      repo.retry('owner', first.jobId, {
        commandKey: 'bad-retry',
        expectedVersion: attention.stateVersion,
      }),
    ).rejects.toThrow('EXTERNAL_RESULT_ACKNOWLEDGEMENT_REQUIRED');
    expect(
      (
        await repo.retry('owner', first.jobId, {
          commandKey: 'retry',
          expectedVersion: attention.stateVersion,
          acknowledged: true,
        })
      ).runNo,
    ).toBe(2);
  });
  it('reuses committed external checkpoints and stable request keys', async () => {
    const lease = await claimed(),
      step = { key: 'plan:call:0', kind: 'llm', dependencyHash: 'hash', external: true };
    const first = await repo.beginStep(lease, step);
    await repo.commitCheckpoint(lease, { stepKey: step.key, result: 'result' });
    const again = await repo.beginStep(lease, step);
    expect(again).toMatchObject({
      status: 'succeeded',
      result: 'result',
      requestKey: first.requestKey,
    });
    expect(again.attemptId).toBeNull();
    expect(
      (await pool.query<{ n: number }>('SELECT count(*)::int n FROM generation_attempts')).rows[0]
        .n,
    ).toBe(1);
  });
  it('explicit retries cannot bypass the owner queue limit', async () => {
    repo = new GenerationJobRepository(pool, { maxQueuedPerOwner: 1 });
    const lease = await claimed();
    await repo.beginStep(lease, { key: 'fail', kind: 'prepare', dependencyHash: 'x' });
    await repo.failStep(lease, { stepKey: 'fail', code: 'INVALID_RESULT', uncertain: false });
    const failed = (await repo.getJob('owner', lease.jobId))!;
    await repo.createJob('owner', 'another', input);
    await expect(
      repo.retry('owner', lease.jobId, {
        commandKey: 'retry',
        expectedVersion: failed.stateVersion,
      }),
    ).rejects.toThrow('OWNER_QUEUE_LIMIT');
  });
  it('persists and projects a bounded safe external failure summary', async () => {
    const lease = await claimed();
    await repo.beginStep(lease, {
      key: 'tts:one:speech',
      kind: 'tts',
      dependencyHash: 'tts',
      external: true,
    });
    await repo.failStep(lease, {
      stepKey: 'tts:one:speech',
      code: 'TTS_RESULT_UNKNOWN_AFTER_TIMEOUT',
      uncertain: true,
      errorSummary: 'TTS provider did not return before the deadline; its result is unknown.',
    });

    const stored = await pool.query<{ last_error_summary: string | null }>(
      'SELECT last_error_summary FROM generation_jobs WHERE id=$1',
      [lease.jobId],
    );
    expect(stored.rows[0]?.last_error_summary).toBe(
      'TTS provider did not return before the deadline; its result is unknown.',
    );
  });
  it('projects a scene step failure and resets only its status on retry, preserving ready scenes and content', async () => {
    const initial = await claimed();
    const second = { ...outline, id: 'two', title: 'Two', order: 1 };
    await repo.savePlan(initial, [outline, second]);
    const review = (await repo.getJob('owner', initial.jobId))!;
    await repo.confirm('owner', initial.jobId, {
      commandKey: 'confirm',
      expectedVersion: review.stateVersion,
      planRevision: review.planRevision,
    });
    const lease = (await repo.claim('worker'))!;
    const slots = (await repo.getSnapshot(lease)).scenes;
    await repo.publishScene(lease, 'one', scene(lease, slots[0].sceneId));
    await repo.beginStep(lease, { key: 'content:two', kind: 'content', dependencyHash: 'content' });
    await repo.commitCheckpoint(lease, {
      stepKey: 'content:two',
      result: { saved: true },
      outlineId: 'two',
      sceneStatus: 'content_ready',
      content: { saved: true },
    });
    // The prefix fallback also supports older persisted steps without outline_id.
    await repo.beginStep(lease, { key: 'actions:two', kind: 'actions', dependencyHash: 'actions' });
    await repo.failStep(lease, {
      stepKey: 'actions:two',
      code: 'INVALID_ACTIONS',
      uncertain: false,
    });
    const detail = await repo.getJobDetail('owner', lease.jobId);
    expect(detail.scenes.map((s) => s.status)).toEqual(['ready', 'failed']);
    await repo.retry('owner', lease.jobId, {
      commandKey: 'retry',
      expectedVersion: detail.stateVersion,
    });
    const after = await repo.getJobDetail('owner', lease.jobId);
    expect(after.scenes.map((s) => s.status)).toEqual(['ready', 'pending']);
    expect(after.scenes[1].content).toEqual({ saved: true });
    const resumed = (await repo.claim('worker-2'))!;
    expect(await repo.getCheckpoint(resumed, 'content:two')).toEqual({ saved: true });
  });
  it('projects an outline-less job failure onto the first unpublished scene', async () => {
    const lease = await confirmed();
    await repo.fail(lease, 'ROLE_CONFIGURATION_FAILED');
    const detail = await repo.getJobDetail('owner', lease.jobId);
    expect(detail.scenes[0].status).toBe('failed');
    await repo.retry('owner', lease.jobId, {
      commandKey: 'retry',
      expectedVersion: detail.stateVersion,
    });
    expect((await repo.getJobDetail('owner', lease.jobId)).scenes[0].status).toBe('pending');
  });
  it('projects expired external work as needs_attention and still requires retry acknowledgement', async () => {
    const lease = await confirmed();
    const firstAttempt = await repo.beginStep(lease, {
      key: 'media:one:call:0',
      kind: 'media',
      dependencyHash: 'paid',
      external: true,
    });
    await repo.recordProviderRequest(lease, {
      attemptId: firstAttempt.attemptId!,
      taskId: 'paid-task-one',
    });
    await pool.query(
      "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [lease.jobId],
    );
    await repo.reapExpired();
    const detail = await repo.getJobDetail('owner', lease.jobId);
    expect(detail.lastErrorCode).toBe('WORKER_LEASE_LOST');
    expect(detail.scenes[0].status).toBe('needs_attention');
    await expect(
      repo.retry('owner', lease.jobId, { commandKey: 'bad', expectedVersion: detail.stateVersion }),
    ).rejects.toThrow('EXTERNAL_RESULT_ACKNOWLEDGEMENT_REQUIRED');
    await repo.retry('owner', lease.jobId, {
      commandKey: 'retry',
      expectedVersion: detail.stateVersion,
      acknowledged: true,
    });
    expect((await repo.getJobDetail('owner', lease.jobId)).scenes[0].status).toBe('pending');
    const resumedLease = (await repo.claim('worker-resumed'))!;
    const resumedAttempt = await repo.beginStep(resumedLease, {
      key: 'media:one:call:0',
      kind: 'media',
      dependencyHash: 'paid',
      external: true,
    });
    expect(resumedAttempt.providerRequestId).toBe('paid-task-one');
    expect(resumedLease.jobId).toBe(lease.jobId);
    expect(
      (await pool.query<{ count: number }>('SELECT count(*)::int count FROM generation_jobs'))
        .rows[0]?.count,
    ).toBe(1);
  });
  it('publishes incrementally, preserves ready content, finishes both completion mirrors', async () => {
    const lease = await confirmed();
    const slot = (await repo.getSnapshot(lease)).scenes[0];
    const output = scene(lease, slot.sceneId);
    await repo.publishScene(lease, 'one', output);
    await repo.publishScene(lease, 'one', output);
    await repo.complete(lease);
    expect((await repo.getJob('owner', lease.jobId))?.status).toBe('succeeded');
    const rows = await pool.query<{ complete: boolean; outline: string; count: number }>(
      "SELECT m.generation_complete complete,o.data->>'generationComplete' outline,(SELECT count(*)::int FROM document_scenes WHERE stage_id=m.stage_id) count FROM stage_meta m JOIN document_outlines o USING(stage_id)",
    );
    expect(rows.rows[0]).toEqual({ complete: true, outline: 'true', count: 1 });
  });
  it('blocks ordinary course mutations while generating; delete atomically revokes lease', async () => {
    const lease = await confirmed();
    const store = createOwnerBoundDocumentStore<Scene>({
      pool,
      ownerId: 'owner',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const slot = (await repo.getSnapshot(lease)).scenes[0];
    await expect(store.putScene(lease.stageId, scene(lease, slot.sceneId))).rejects.toThrow(
      'SERVER_OWNED_GENERATION',
    );
    await store.deleteDocument(lease.stageId);
    expect((await repo.getJob('owner', lease.jobId))?.status).toBe('cancelled');
    await expect(repo.publishScene(lease, 'one', scene(lease, slot.sceneId))).rejects.toThrow(
      'STALE_GENERATION_LEASE',
    );
  });
  it('does not expose private worker courses through legacy capability-by-id document reads', async () => {
    const lease = await confirmed();
    const stranger = createOwnerBoundDocumentStore<Scene>({
      pool,
      ownerId: 'stranger',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    expect(await stranger.loadDocument(lease.stageId)).toBeNull();
    const slot = (await repo.getSnapshot(lease)).scenes[0];
    await repo.publishScene(lease, 'one', scene(lease, slot.sceneId));
    expect(await stranger.getScene(lease.stageId, slot.sceneId)).toBeNull();
  });
  it('stores asset bytes and logical mapping once; FK pins prevent input/output collection', async () => {
    const lease = await claimed();
    const spec = {
      logicalKey: 'tts:one',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mpeg',
    };
    const id = await repo.writeAsset(lease, spec);
    expect(await repo.writeAsset(lease, spec)).toBe(id);
    expect(await repo.readAsset('owner', id)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mpeg',
    });
    await expect(repo.readAsset('other', id)).rejects.toThrow('BACKGROUND_MATERIAL_UNAVAILABLE');
    await expect(pool.query('DELETE FROM asset_entries WHERE id=$1', [id])).rejects.toThrow();
  });
  it('refuses modified pinned assets and preserves the server producer through editable whole-course saves', async () => {
    const lease = await confirmed();
    const assetId = await repo.writeAsset(lease, {
      logicalKey: 'asset',
      bytes: new Uint8Array([1]),
      mimeType: 'image/png',
    });
    await pool.query('UPDATE asset_entries SET revision=revision+1 WHERE id=$1', [assetId]);
    await expect(
      repo.beginStep(lease, { key: 'paid', kind: 'llm', dependencyHash: 'x', external: true }),
    ).rejects.toThrow('GENERATION_DEPENDENCY_CONFLICT');
    await repo.cancel('owner', lease.jobId, { commandKey: 'cancel' });
    const store = createOwnerBoundDocumentStore<Scene>({
      pool,
      ownerId: 'owner',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    const document = (await store.loadDocument(lease.stageId))!;
    await store.saveDocument({
      ...document,
      outline: { outlines: [], producer: 'client', generationComplete: true },
    });
    const stored = (await store.loadDocument(lease.stageId))!;
    expect(stored.outline).toMatchObject({
      producer: 'server-job',
      producerKind: 'course-worker',
      producerRef: lease.jobId,
      generationComplete: false,
    });
  });
  it('collects only old terminal staged outputs and retains bytes until the existing collector grace', async () => {
    const lease = await claimed();
    const asset = await repo.writeAsset(lease, {
      logicalKey: 'unused',
      bytes: new Uint8Array([9]),
      mimeType: 'image/png',
    });
    await repo.cancel('owner', lease.jobId, { commandKey: 'cancel' });
    expect(await repo.releaseExpiredStagedAssets()).toBe(0);
    await pool.query(
      "UPDATE generation_jobs SET finished_at=clock_timestamp()-interval '2 days' WHERE id=$1",
      [lease.jobId],
    );
    expect(await repo.releaseExpiredStagedAssets()).toBe(1);
    expect(
      (await pool.query('SELECT id FROM asset_entries WHERE id=$1', [asset])).rows,
    ).toHaveLength(0);
    expect((await pool.query('SELECT bytes FROM asset_blobs')).rows).toHaveLength(1);
  });
  it('provider slots are shared, stale releases fenced and unknown calls quarantined', async () => {
    const a = new PostgresGenerationLimiter(pool),
      b = new PostgresGenerationLimiter(pool);
    const slot = (await a.acquire('llm:deployment', 1, randomUUID(), 1000))!;
    expect(await b.acquire('llm:deployment', 1)).toBeNull();
    await a.release(slot, true);
    expect(await b.acquire('llm:deployment', 1)).toBeNull();
    await pool.query(
      "UPDATE generation_provider_slots SET quarantine_until=clock_timestamp()-interval '1 second'",
    );
    const replacement = (await b.acquire('llm:deployment', 1))!;
    await a.release(slot);
    expect(await a.acquire('llm:deployment', 1)).toBeNull();
    await b.release(replacement);
    const finalSlot = (await a.acquire('llm:deployment', 1))!;
    expect(finalSlot).not.toBeNull();
    await a.cooldown('llm:deployment', 10_000);
    await a.release(finalSlot);
    expect(await a.acquire('llm:deployment', 1)).toBeNull();
  });
});
