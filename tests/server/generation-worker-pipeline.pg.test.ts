import { randomUUID } from 'node:crypto';
import { ConfirmedMediaFailure } from '@/lib/media/generation-errors';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { buildCompleteScene } from '@openmaic/generation';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { migrateGenerationSchema } from '@/lib/server/generation-jobs/migrations';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import { PipelineExecution } from '@/lib/server/generation-pipeline/execution';
import {
  runGenerationPipeline,
  type PipelineServices,
} from '@/lib/server/generation-pipeline/pipeline';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';
import type { Scene } from '@/lib/types/stage';

// Explicitly isolated opt-in database; never fall back to application DATABASE_URL.
describe.skipIf(!process.env.TEST_GENERATION_DATABASE_URL)(
  'worker pipeline against PostgreSQL',
  () => {
    const schema = `worker_pipeline_test_${randomUUID().replaceAll('-', '')}`;
    let admin: Pool, pool: Pool, repository: GenerationJobRepository;
    beforeAll(async () => {
      admin = new Pool({ connectionString: process.env.TEST_GENERATION_DATABASE_URL, max: 1 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString: process.env.TEST_GENERATION_DATABASE_URL,
        max: 8,
        options: `-c search_path=${schema}`,
      });
      await ensureDocumentSchema(pool);
      await ensureStageMetaSchema(pool);
      await ensureAssetSchema(pool);
      await migrateGenerationSchema(pool);
      repository = new GenerationJobRepository(pool);
    }, 30_000);
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it('review, restart from committed calls, ordered publish and completion use one coherent durable state', async () => {
      const owner = randomUUID();
      const job = await repository.createJob(owner, randomUUID(), {
        version: 1,
        requirements: { requirement: 'Test' },
        review: { mode: 'manual' },
      });
      const outlines = Array.from({ length: 3 }, (_, order) => ({
        id: `scene${order}`,
        title: `Scene ${order}`,
        description: 'Test lesson',
        keyPoints: ['Test'],
        type: 'interactive' as const,
        order,
      }));
      let externalCalls = 0;
      let mediaCalls = 0;
      const execute = async (lease: GenerationLease) => {
        const execution = new PipelineExecution(
          repository,
          lease,
          new AbortController().signal,
          new PostgresGenerationLimiter(pool),
        );
        const services: PipelineServices = {
          research: async () => '',
          plan: async () => ({ outlines, languageDirective: 'Chinese' }),
          agents: async () => [
            { id: 'teacher', role: 'teacher', name: 'Teacher', persona: 'Teach clearly' },
          ],
          content: async (outline) => {
            const content = await execution.external(
              `content:${outline.id}:call:0`,
              outline,
              'llm',
              'test',
              async () => {
                externalCalls++;
                return { html: '<div>Lesson</div>' };
              },
            );
            return { outline, content };
          },
          actions: async (checkpoint) => [
            { id: `speech${checkpoint.outline.order}`, type: 'speech', text: 'Hello' },
          ],
          assemble: (checkpoint, actions, sceneId) =>
            buildCompleteScene(checkpoint.outline, checkpoint.content, actions, lease.stageId, {
              sceneId,
            }) as Scene,
          media: async (scene) => {
            if (scene.outlineId === 'scene0') {
              for (let replay = 0; replay < 2; replay++) {
                expect(
                  await execution.external(
                    'media:scene0:image',
                    {},
                    'media',
                    'test',
                    async () => {
                      mediaCalls++;
                      throw new ConfirmedMediaFailure('rejected', 'Submission rejected');
                    },
                    true,
                  ),
                ).toBeNull();
              }
            }
            return scene;
          },
          tts: async (scene) => scene,
        };
        return runGenerationPipeline(repository, execution, services);
      };
      expect(await execute((await repository.claim('worker-1'))!)).toBe('awaiting_confirmation');
      expect(externalCalls).toBe(0);
      const review = (await repository.getJob(owner, job.jobId))!;
      await repository.confirm(owner, job.jobId, {
        commandKey: 'confirm',
        expectedVersion: review.stateVersion,
        planRevision: review.planRevision,
      });
      expect(await execute((await repository.claim('worker-2'))!)).toBe('succeeded');
      expect(externalCalls).toBe(3);
      expect(mediaCalls).toBe(1);
      const final = (await repository.getJob(owner, job.jobId))!;
      expect(final.status).toBe('succeeded');
      expect(final.readyScenes).toBe(3);
      expect(final.warningCount).toBe(1);
      const warning = await pool.query(
        "SELECT s.status, a.outcome FROM generation_steps s JOIN generation_attempts a ON a.step_id=s.id WHERE s.job_id=$1 AND s.step_key='media:scene0:image'",
        [job.jobId],
      );
      expect(warning.rows).toEqual([{ status: 'skipped', outcome: 'safe_failure' }]);
      const persisted = await pool.query(
        'SELECT data FROM document_scenes WHERE stage_id=$1 ORDER BY scene_order',
        [job.stageId],
      );
      expect(persisted.rows.map((row) => row.data.outlineId)).toEqual([
        'scene0',
        'scene1',
        'scene2',
      ]);
      const pending = await pool.query(
        "SELECT count(*)::int count FROM generation_steps WHERE job_id=$1 AND status NOT IN ('succeeded','skipped')",
        [job.jobId],
      );
      expect(pending.rows[0].count).toBe(0);
    }, 30_000);

    it('strong-killed independent worker never replays an unknown paid request after restart', async () => {
      const owner = randomUUID();
      let calls = 0;
      const server = createServer((request, _response) => {
        calls++;
        request.resume(); /* Provider deliberately accepts but never returns. */
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TEST_PROVIDER_UNAVAILABLE');
      const job = await repository.createJob(owner, randomUUID(), {
        version: 1,
        requirements: { requirement: 'Synthetic kill test' },
        review: { mode: 'manual' },
        model: { modelString: 'openai:gpt-4o-mini' },
      });
      const target = new URL(process.env.TEST_GENERATION_DATABASE_URL!);
      target.searchParams.set('options', `-c search_path=${schema}`);
      let child: ChildProcess | undefined;
      const start = (id: string) =>
        spawn(process.execPath, [path.resolve('dist-worker/generation.mjs')], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DATABASE_URL: target.toString(),
            GENERATION_BACKGROUND_ENABLED: '1',
            GENERATION_WORKER_ID: id,
            GENERATION_WORKER_CONCURRENCY: '1',
            OPENAI_API_KEY: 'synthetic-test-only',
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            DEFAULT_MODEL: 'openai/gpt-4o-mini',
            MODEL_ROUTES: '',
          },
        });
      const kill = async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        child = undefined;
      };
      try {
        child = start(`kill-before-${randomUUID()}`);
        let diagnostics = '';
        child.stdout?.on('data', (data) => {
          diagnostics += String(data);
        });
        child.stderr?.on('data', (data) => {
          diagnostics += String(data);
        });
        try {
          await vi.waitFor(() => expect(calls).toBe(1), { timeout: 20_000 });
        } catch {
          throw new Error(
            `Worker did not reach fake provider: ${JSON.stringify(await repository.getJob(owner, job.jobId))}; exit=${child.exitCode}; ${diagnostics.slice(-2000)}`,
          );
        }
        await kill();
        await pool.query(
          "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [job.jobId],
        );
        expect(await repository.reapExpired()).toBe(1);
        expect((await repository.getJob(owner, job.jobId))?.status).toBe('needs_attention');
        const restartedId = `kill-after-${randomUUID()}`;
        child = start(restartedId);
        await vi.waitFor(
          async () => {
            const heartbeat = await pool.query(
              'SELECT 1 FROM generation_worker_heartbeats WHERE worker_id=$1',
              [restartedId],
            );
            expect(heartbeat.rowCount).toBe(1);
          },
          { timeout: 20_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(calls).toBe(1);
        expect((await repository.getJob(owner, job.jobId))?.status).toBe('needs_attention');
      } finally {
        await kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 50_000);

    it('strong-killed worker resumes a committed provider response without another external request', async () => {
      const owner = randomUUID();
      const job = await repository.createJob(owner, randomUUID(), {
        version: 1,
        requirements: { requirement: 'Synthetic durable response test' },
        review: { mode: 'manual' },
        model: { modelString: 'openai:gpt-4o-mini' },
      });
      const blocker = await pool.connect();
      let blocking = false,
        calls = 0;
      const text = JSON.stringify({
        courseTitle: 'Recovered course',
        languageDirective: 'Chinese',
        outlines: [
          {
            id: 'recovered',
            type: 'slide',
            title: 'Recovered',
            description: 'Durable response',
            keyPoints: ['Checkpoint'],
            order: 0,
          },
        ],
      });
      const server = createServer(async (request, response) => {
        request.resume();
        calls++;
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT 1 FROM generation_steps WHERE job_id=$1 AND step_key='plan' FOR UPDATE",
          [job.jobId],
        );
        blocking = true;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(
            request.url?.includes('/responses')
              ? {
                  id: 'resp_test',
                  object: 'response',
                  created_at: 1,
                  model: 'gpt-4o-mini',
                  status: 'completed',
                  output: [
                    {
                      id: 'msg_test',
                      type: 'message',
                      role: 'assistant',
                      status: 'completed',
                      content: [{ type: 'output_text', text, annotations: [] }],
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }
              : {
                  id: 'chat_test',
                  object: 'chat.completion',
                  created: 1,
                  model: 'gpt-4o-mini',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: text },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                },
          ),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('TEST_PROVIDER_UNAVAILABLE');
      const target = new URL(process.env.TEST_GENERATION_DATABASE_URL!);
      target.searchParams.set('options', `-c search_path=${schema}`);
      let child: ChildProcess | undefined;
      const start = () =>
        spawn(process.execPath, [path.resolve('dist-worker/generation.mjs')], {
          windowsHide: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            DATABASE_URL: target.toString(),
            GENERATION_BACKGROUND_ENABLED: '1',
            GENERATION_WORKER_ID: `checkpoint-${randomUUID()}`,
            OPENAI_API_KEY: 'synthetic-test-only',
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            DEFAULT_MODEL: 'openai:gpt-4o-mini',
            MODEL_ROUTES: '',
          },
        });
      const kill = async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const done = once(child, 'exit');
          child.kill('SIGKILL');
          await done;
        }
        child = undefined;
      };
      try {
        child = start();
        await vi.waitFor(
          async () => {
            const saved = await pool.query(
              "SELECT status FROM generation_steps WHERE job_id=$1 AND step_key='plan:call:0'",
              [job.jobId],
            );
            expect(saved.rows[0]?.status).toBe('succeeded');
          },
          { timeout: 20_000 },
        );
        await kill();
        if (blocking) {
          await blocker.query('ROLLBACK');
          blocking = false;
        }
        await pool.query(
          "UPDATE generation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [job.jobId],
        );
        expect(await repository.reapExpired()).toBe(1);
        expect((await repository.getJob(owner, job.jobId))?.status).toBe('retry_wait');
        child = start();
        await vi.waitFor(
          async () =>
            expect((await repository.getJob(owner, job.jobId))?.status).toBe(
              'awaiting_confirmation',
            ),
          { timeout: 20_000 },
        );
        expect(calls).toBe(1);
        const stage = await pool.query('SELECT name FROM document_stages WHERE id=$1', [
          job.stageId,
        ]);
        expect(stage.rows[0].name).toBe('Recovered course');
      } finally {
        await kill();
        if (blocking) await blocker.query('ROLLBACK');
        blocker.release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 50_000);
  },
);
