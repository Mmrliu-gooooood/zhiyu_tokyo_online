import { hostname } from 'node:os';
import { generationConfig } from '@/lib/server/generation-jobs/config';
import { getGenerationPool } from '@/lib/server/generation-jobs/runtime';
import { GenerationJobRepository } from '@/lib/server/generation-jobs/repository';
import { PostgresGenerationLimiter } from '@/lib/server/generation-jobs/limiter';
import { PipelineExecution } from '@/lib/server/generation-pipeline/execution';
import { GenerationServices } from '@/lib/server/generation-pipeline/services';
import { GenerationMediaServices } from '@/lib/server/generation-pipeline/media';
import { prepareMaterials } from '@/lib/server/generation-pipeline/materials';
import { runGenerationPipeline } from '@/lib/server/generation-pipeline/pipeline';
import { runWorker } from './runner';
import { assertGenerationConfigSnapshot } from '@/lib/server/generation-jobs/config-snapshot';
import { loadMediaConfigSnapshot } from '@/lib/server/media-config-snapshots';
import {
  cleanupGenerationModelSnapshots,
  loadGenerationModelSnapshot,
} from '@/lib/server/generation-model-snapshots';
import {
  cleanupGenerationSearchSnapshots,
  loadGenerationSearchSnapshot,
} from '@/lib/server/generation-search-snapshots';
import { withHeavyTaskRootContext } from '@/lib/server/heavy-task-admission';
import { isAgentRuntimeWorkerConfigured } from '@/lib/config/feature-flags';
import { startAgentEventNotifyBus } from '@/lib/server/agent-runtime/event-notify-bus';
import { startAgentRunner } from '@/lib/server/agent-runtime/runner';
import { startMaterialExtractionRunner } from '@/lib/server/material-extraction/runner';
import { startAssetCollectorSchedule } from '@/lib/persistence/asset-collector-schedule';
import {
  assertFreshWorkerHealthMarker,
  clearWorkerHealthMarker,
  writeWorkerHealthMarker,
} from './health';

async function main() {
  const config = generationConfig();
  const workerId = process.env.GENERATION_WORKER_ID ?? hostname();
  if (process.argv.includes('--check')) {
    await assertFreshWorkerHealthMarker();
    return;
  }
  await clearWorkerHealthMarker();
  const pool = getGenerationPool();
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => controller.abort());
  const assetCollector = startAssetCollectorSchedule();
  const agentEventBus = isAgentRuntimeWorkerConfigured() ? startAgentEventNotifyBus() : undefined;
  const agentRunner = isAgentRuntimeWorkerConfigured()
    ? startAgentRunner({
        loadMediaConfigSnapshot: async (ownerId, ref) =>
          (await loadMediaConfigSnapshot(
            ownerId,
            ref,
          )) as unknown as import('@/lib/server/agent-runtime/course-tools').AgentSessionMediaConfig,
      })
    : undefined;
  const extractionRunner = isAgentRuntimeWorkerConfigured()
    ? startMaterialExtractionRunner()
    : undefined;
  const repository = new GenerationJobRepository(pool, config);
  const limiter = new PostgresGenerationLimiter(pool, {
    llm: config.llmConcurrency,
    tts: config.ttsConcurrency,
    media: config.mediaConcurrency,
  });
  try {
    await runWorker({
      repository,
      workerId,
      concurrency: config.workerConcurrency,
      heartbeatMs: config.heartbeatMs,
      signal: controller.signal,
      report: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      onDatabaseHeartbeat: () => writeWorkerHealthMarker(),
      maintenance: async () => {
        const retentionMs = 7 * 24 * 60 * 60 * 1000;
        await cleanupGenerationModelSnapshots(retentionMs);
        await cleanupGenerationSearchSnapshots(retentionMs);
      },
      execute: (lease, signal) => {
        const source = lease.input.source;
        const rootTaskId =
          source?.kind === 'pro' && source.sessionId
            ? `agent:${source.sessionId}`
            : `generation:${lease.jobId}`;
        return withHeavyTaskRootContext(
          { ownerId: lease.ownerId, rootTaskId, kind: 'generation' },
          async () => {
            const budgetSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(lease.input.budget?.activeMs ?? 3_600_000),
            ]);
            const execution = new PipelineExecution(
              repository,
              lease,
              budgetSignal,
              limiter,
              (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
            );
            const assets = {
              read: (id: string) => repository.readAsset(lease.ownerId, id),
              write: (logicalKey: string, bytes: Uint8Array, mimeType: string) =>
                repository.writeAsset(lease, { logicalKey, bytes, mimeType }),
            };
            try {
              assertGenerationConfigSnapshot(lease.input);
              const materials = await prepareMaterials(lease.input, execution, assets);
              const input = { ...lease.input, materials };
              const mediaConfig = input.mediaConfigRef
                ? await loadMediaConfigSnapshot(lease.ownerId, input.mediaConfigRef)
                : undefined;
              const storedModel = input.modelConfigRef
                ? await loadGenerationModelSnapshot(lease.ownerId, input.modelConfigRef)
                : undefined;
              const modelContext = storedModel
                ? (({ version: _version, ...context }) => context)(storedModel)
                : undefined;
              const searchConfig = input.searchConfigRef
                ? await loadGenerationSearchSnapshot(lease.ownerId, input.searchConfigRef)
                : undefined;
              const services = new GenerationServices(
                execution,
                input,
                assets,
                modelContext,
                searchConfig,
              );
              const media = new GenerationMediaServices(execution, input, assets, mediaConfig);
              await runGenerationPipeline(
                repository,
                execution,
                {
                  research: () => services.research(),
                  plan: (research) => services.plan(research),
                  agents: (plan) => services.agents(plan),
                  content: (outline, agents, plan) => services.content(outline, agents, plan),
                  actions: (content, agents, plan, previous) =>
                    services.actions(content, agents, plan, previous),
                  assemble: (content, actions, sceneId) =>
                    services.assemble(content, actions, sceneId),
                  media: (scene, outline) => media.media(scene, outline),
                  tts: (scene, agents) => media.tts(scene, agents),
                },
                config.contentConcurrency,
              );
            } catch (error) {
              // Step failures normally fenced the job already; this covers failures
              // before the first checkpoint (configuration, deleted material, etc.).
              await repository
                .fail(
                  lease,
                  signal.aborted ? 'WORKER_INTERRUPTED' : 'GENERATION_FAILED',
                  signal.aborted,
                )
                .catch(() => {});
              throw error;
            }
          },
        );
      },
    });
  } finally {
    await extractionRunner?.stop();
    await agentRunner?.stop();
    await agentEventBus?.stop();
    await assetCollector?.stop();
    await pool.end();
  }
}

void main().catch(() => {
  process.stderr.write(
    'Generation worker startup failed; verify database, schema and server configuration.\n',
  );
  process.exitCode = 1;
});
