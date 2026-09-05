import { createHash } from 'node:crypto';
import type { AgentInfo } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';
import type { Action, SpeechAction } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import type { GenerationLease } from '@/lib/server/generation-jobs/contracts';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { PipelineExecution, type CheckpointRepository } from './execution';
import type { ContentCheckpoint, GenerationPlan } from './services';

export interface PipelineRepository extends CheckpointRepository {
  getSnapshot(lease: GenerationLease): Promise<{
    outlines: SceneOutline[];
    steps: Array<{ key: string; status: string; result: unknown }>;
  }>;
  savePlan(
    lease: GenerationLease,
    outlines: SceneOutline[],
    stage?: Partial<Stage>,
  ): Promise<unknown>;
  updateStage(lease: GenerationLease, stage: Partial<Stage>): Promise<unknown>;
  publishScene(lease: GenerationLease, outlineId: string, scene: Scene): Promise<unknown>;
  complete(lease: GenerationLease): Promise<unknown>;
}
export interface PipelineServices {
  research(): Promise<string>;
  plan(research: string): Promise<GenerationPlan>;
  agents(plan: GenerationPlan): Promise<AgentInfo[]>;
  content(
    outline: SceneOutline,
    agents: AgentInfo[],
    plan: GenerationPlan,
  ): Promise<ContentCheckpoint>;
  actions(
    content: ContentCheckpoint,
    agents: AgentInfo[],
    plan: GenerationPlan,
    previousSpeeches: string[],
  ): Promise<Action[]>;
  assemble(content: ContentCheckpoint, actions: Action[], sceneId: string): Scene;
  media(scene: Scene, outline: SceneOutline): Promise<Scene>;
  tts(scene: Scene, agents: AgentInfo[]): Promise<Scene>;
}

/** Durable stages, bounded content lookahead, and strictly ordered dependencies. */
export async function runGenerationPipeline(
  repository: PipelineRepository,
  execution: PipelineExecution,
  services: PipelineServices,
  contentConcurrency = 2,
): Promise<'awaiting_confirmation' | 'succeeded'> {
  const { lease, signal } = execution;
  const snapshot = await repository.getSnapshot(lease);
  const research = await execution.checkpoint('research', lease.input, () => services.research());
  const originalPlan = await execution.checkpoint('plan', { input: lease.input, research }, () =>
    services.plan(research),
  );
  if (!snapshot.outlines.length) {
    await repository.savePlan(lease, originalPlan.outlines, {
      name:
        originalPlan.courseTitle ??
        originalPlan.outlines[0]?.title ??
        lease.input.requirements.requirement.slice(0, 50),
      languageDirective: originalPlan.languageDirective,
      videoManifest: buildVideoManifestFromOutlines(originalPlan.outlines),
    });
    return 'awaiting_confirmation';
  }
  const plan: GenerationPlan = {
    ...originalPlan,
    outlines: [...snapshot.outlines].sort((a, b) => a.order - b.order),
  };
  const agents = await execution.checkpoint(
    'agents',
    {
      planRevision: lease.planRevision,
      input: lease.input.agents,
      languageDirective: plan.languageDirective,
    },
    () => services.agents(plan),
  );
  await repository.updateStage(lease, {
    languageDirective: plan.languageDirective,
    videoManifest: buildVideoManifestFromOutlines(plan.outlines),
    generatedAgentConfigs: agents.map((agent, index) => {
      const configured = lease.input.agents?.items?.find((item) => item.id === agent.id);
      return {
        ...agent,
        persona: agent.persona ?? '',
        avatar: configured?.avatar ?? AGENT_DEFAULT_AVATARS[index % AGENT_DEFAULT_AVATARS.length]!,
        color: configured?.color ?? AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length]!,
        priority:
          configured?.priority ??
          (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
        ...(configured?.voiceConfig ? { voiceConfig: configured.voiceConfig } : {}),
      };
    }),
  });

  const limit = Math.max(1, Math.min(2, contentConcurrency));
  const lookahead = limit === 1 ? 0 : 2;
  let consumeIndex = 0;
  let active = 0;
  let next = 0;
  let stopped = false;
  const pending = new Map<number, Promise<ContentCheckpoint>>();
  const running = new Set<Promise<unknown>>();
  const schedule = () => {
    // At most current + two future outlines, even if the first is slow.
    while (
      !stopped &&
      !signal.aborted &&
      active < limit &&
      next < plan.outlines.length &&
      next <= consumeIndex + lookahead
    ) {
      const index = next++;
      const outline = plan.outlines[index]!;
      active++;
      const task = execution
        .checkpoint(
          `content:${outline.id}`,
          { outline, agents, input: lease.input, planRevision: lease.planRevision },
          () => services.content(outline, agents, plan),
        )
        .catch((error) => {
          stopped = true;
          throw error;
        })
        .finally(() => {
          active--;
          running.delete(task);
          schedule();
        });
      pending.set(index, task);
      running.add(task);
      // Preheated failures are consumed in ordinal order; suppress unhandled
      // rejections while their predecessors finish and stop further scheduling.
      void task.catch(() => {
        stopped = true;
      });
    }
  };
  schedule();
  let previousSpeeches: string[] = [];
  try {
    for (let index = 0; index < plan.outlines.length; index++) {
      signal.throwIfAborted();
      consumeIndex = index;
      schedule();
      const task = pending.get(index);
      if (!task) throw new Error('CONTENT_DEPENDENCY_FAILED');
      const content = await task;
      const outline = plan.outlines[index]!;
      const actions = await execution.checkpoint(
        `actions:${outline.id}`,
        { content, previousSpeeches, agents, planRevision: lease.planRevision },
        () => services.actions(content, agents, plan, previousSpeeches),
      );
      const sceneId = `gscene_${createHash('sha256').update(`${lease.jobId}:${outline.id}`).digest('hex').slice(0, 24)}`;
      let scene = await execution.checkpoint(
        `scene:${outline.id}`,
        { content, actions, sceneId },
        async () => services.assemble(content, actions, sceneId),
      );
      scene = await execution.checkpoint(
        `media:${outline.id}`,
        { scene, requests: outline.mediaGenerations },
        () => services.media(scene, outline),
      );
      scene = await execution.checkpoint(
        `tts:${outline.id}`,
        { scene, tts: lease.input.tts, agents },
        () => services.tts(scene, agents),
      );
      await repository.publishScene(lease, outline.id, scene);
      // Only speeches from the committed predecessor feed the next actions call.
      previousSpeeches = (scene.actions ?? [])
        .filter((action): action is SpeechAction => action.type === 'speech')
        .map((action) => action.text);
    }
    await repository.complete(lease);
    return 'succeeded';
  } finally {
    stopped = true;
    await Promise.allSettled([...running]);
  }
}
