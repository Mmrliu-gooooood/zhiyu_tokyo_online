import { createHash } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import type {
  GenerationInput,
  GenerationJobView,
  GenerationModelRef,
  MediaConfigRef,
} from '@/lib/server/generation-jobs/contracts';
import {
  GenerationJobError,
  parseGenerationInput,
  validatePlan,
} from '@/lib/server/generation-jobs/contracts';
import type { AgentSessionMediaConfig } from './course-tools';
import { mediaConfigVoiceSource, resolveEffectiveSessionVoice } from './effective-voice-directory';

const SubmitParams = Type.Object({
  requirement: Type.String({ description: 'The complete course generation brief.' }),
  courseTitle: Type.Optional(Type.String()),
  languageDirective: Type.Optional(Type.String()),
  researchContext: Type.Optional(Type.String()),
  outlines: Type.Optional(Type.Array(Type.Any(), { minItems: 1, maxItems: 30 })),
  agents: Type.Optional(Type.Array(Type.Any(), { minItems: 1, maxItems: 10 })),
  skillIds: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
  folderId: Type.Optional(Type.String()),
  targetStageId: Type.Optional(Type.String()),
  targetRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  replaceExisting: Type.Optional(Type.Boolean()),
});
const JobParams = Type.Object({ jobId: Type.Optional(Type.String()) });
const RetryParams = Type.Object({
  jobId: Type.Optional(Type.String()),
  acknowledged: Type.Optional(
    Type.Boolean({
      description:
        'Set true only after the user explicitly accepts the duplicate-charge risk of retrying an unknown external result.',
    }),
  ),
});

export interface GenerationJobToolRepository {
  createJob(ownerId: string, key: string, input: unknown): Promise<GenerationJobView>;
  getJob(ownerId: string, jobId: string): Promise<GenerationJobView | null>;
  getJobBySession(ownerId: string, sessionId: string): Promise<GenerationJobView | null>;
  getStageRevision?(ownerId: string, stageId: string): Promise<number | null>;
  cancel(
    ownerId: string,
    jobId: string,
    input: { commandKey: string; expectedVersion?: number },
  ): Promise<GenerationJobView>;
  retry?(
    ownerId: string,
    jobId: string,
    input: { commandKey: string; expectedVersion?: number; acknowledged?: boolean },
  ): Promise<GenerationJobView>;
}

export interface GenerationJobToolDeps {
  ownerId: string;
  sessionId: string;
  repository: GenerationJobToolRepository;
  modelConfigRef?: GenerationModelRef;
  resolveModelConfigRef?: () => Promise<GenerationModelRef | undefined>;
  mediaConfigRef?: MediaConfigRef;
  mediaConfig?: AgentSessionMediaConfig;
  ensureReady?: () => Promise<void>;
  resolveSkillConstraints?: (
    ids: readonly string[],
  ) => Promise<Array<{ id: string; constraints: Record<string, unknown> }>>;
  onCompleted?: (job: GenerationJobView) => void;
}

function key(kind: string, sessionId: string, callId: string) {
  return `pro:${kind}:${createHash('sha256').update(`${sessionId}\0${callId}`).digest('hex')}`;
}
function result(text: string, details: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}
function progress(job: GenerationJobView) {
  return `${job.status} / ${job.phase}; ${job.readyScenes}/${job.totalScenes} pages ready`;
}

function normalizePlannedOutlines(value: readonly unknown[]) {
  const normalized: Record<string, unknown>[] = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new GenerationJobError('INVALID_OUTLINE', 400);
    }
    const source = { ...(item as Record<string, unknown>) };
    const description = source.description ?? source.brief;
    const keyPoints = source.keyPoints ?? source.materialFacts;
    const languageNote = source.languageNote ?? source.language;
    if (
      (source.description !== undefined &&
        source.brief !== undefined &&
        source.description !== source.brief) ||
      (source.keyPoints !== undefined &&
        source.materialFacts !== undefined &&
        JSON.stringify(source.keyPoints) !== JSON.stringify(source.materialFacts)) ||
      (source.languageNote !== undefined &&
        source.language !== undefined &&
        source.languageNote !== source.language)
    ) {
      throw new GenerationJobError('INVALID_OUTLINE', 400);
    }
    delete source.brief;
    delete source.materialFacts;
    delete source.language;
    return { ...source, description, keyPoints, ...(languageNote ? { languageNote } : {}) };
  });
  const orders = new Set<number>();
  for (const item of normalized) {
    if (!Number.isInteger(item.order) || orders.has(item.order as number)) {
      throw new GenerationJobError('INVALID_OUTLINE', 400);
    }
    orders.add(item.order as number);
  }
  return validatePlan(
    normalized.sort((left, right) => (left.order as number) - (right.order as number)),
  );
}

function frozenMediaIntent(
  mediaConfig: AgentSessionMediaConfig | undefined,
  agents: GenerationInput['agents'],
): Pick<GenerationInput, 'enableImageGeneration' | 'enableVideoGeneration' | 'media' | 'tts'> {
  if (!mediaConfig) return {};
  const imageEnabled = mediaConfig.imageEnabled ?? !!mediaConfig.image;
  const videoEnabled = mediaConfig.videoEnabled ?? !!mediaConfig.video;
  const voiceSource = mediaConfigVoiceSource(mediaConfig);
  const defaultVoice = resolveEffectiveSessionVoice(voiceSource);
  const ttsEnabled = mediaConfig.ttsEnabled ?? !!defaultVoice;
  const agentVoiceOverrides =
    agents?.mode === 'custom'
      ? Object.fromEntries(
          (agents.items ?? []).flatMap((agent) =>
            agent.voiceConfig ? [[agent.id, agent.voiceConfig] as const] : [],
          ),
        )
      : undefined;
  return {
    enableImageGeneration: imageEnabled,
    enableVideoGeneration: videoEnabled,
    media: {
      ...(imageEnabled && mediaConfig.image
        ? {
            image:
              mediaConfig.image.source === 'platform'
                ? {
                    source: mediaConfig.image.source,
                    defaultId: mediaConfig.image.defaultId,
                    revision: mediaConfig.image.revision,
                  }
                : {
                    source: mediaConfig.image.source ?? ('legacy-managed' as const),
                    providerId: mediaConfig.image.providerId,
                    modelId: mediaConfig.image.modelId,
                  },
          }
        : {}),
      ...(videoEnabled && mediaConfig.video
        ? {
            video:
              mediaConfig.video.source === 'platform'
                ? {
                    source: mediaConfig.video.source,
                    defaultId: mediaConfig.video.defaultId,
                    revision: mediaConfig.video.revision,
                  }
                : {
                    source: mediaConfig.video.source ?? ('legacy-managed' as const),
                    providerId: mediaConfig.video.providerId,
                    modelId: mediaConfig.video.modelId,
                  },
          }
        : {}),
    },
    tts:
      ttsEnabled && defaultVoice
        ? {
            enabled: true,
            source: defaultVoice.source ?? ('legacy-managed' as const),
            ...(defaultVoice.source === 'platform'
              ? { defaultId: defaultVoice.defaultId, revision: defaultVoice.revision }
              : { providerId: defaultVoice.providerId, modelId: defaultVoice.modelId }),
            voice: defaultVoice.voice,
            speed: defaultVoice.speed,
            ...(agentVoiceOverrides && Object.keys(agentVoiceOverrides).length
              ? { agentVoiceOverrides }
              : {}),
          }
        : { enabled: false },
  };
}

/** Durable whole-course tools. They enqueue work; they never wait for the generation worker. */
export function buildGenerationJobTools(deps: GenerationJobToolDeps): AgentTool<never, never>[] {
  const submit: AgentTool<typeof SubmitParams, unknown> = {
    name: 'submit_course_generation',
    label: 'Generate complete course',
    description:
      'Submit a complete ordinary or planned course to the durable PostgreSQL generation worker. Returns immediately. Do not create pages synchronously after it succeeds.',
    parameters: SubmitParams,
    executionMode: 'sequential',
    async execute(callId, params: Static<typeof SubmitParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const targetRevision = params.targetStageId
        ? (params.targetRevision ??
          (await deps.repository.getStageRevision?.(deps.ownerId, params.targetStageId)))
        : undefined;
      if (params.targetStageId && targetRevision == null)
        return result(
          'The target stage was not found or its revision is unavailable.',
          { refused: true },
          true,
        );
      await deps.ensureReady?.();
      const modelConfigRef = deps.modelConfigRef ?? (await deps.resolveModelConfigRef?.());
      const skillConstraints = params.skillIds?.length
        ? await deps.resolveSkillConstraints?.(params.skillIds)
        : undefined;
      if (params.skillIds?.length && skillConstraints?.length !== new Set(params.skillIds).size)
        return result(
          'One or more requested skills are unavailable or have no enforceable constraints.',
          { refused: true, code: 'INVALID_GENERATION_SKILL' },
          true,
        );
      const agents: GenerationInput['agents'] = params.agents
        ? { mode: 'custom', items: params.agents }
        : { mode: 'generate' };
      let input: GenerationInput;
      try {
        input = parseGenerationInput({
          version: 1,
          requirements: { requirement: params.requirement },
          review: { mode: 'auto' },
          source: { kind: 'pro', sessionId: deps.sessionId, submissionId: callId },
          ...(modelConfigRef ? { modelConfigRef } : {}),
          ...(deps.mediaConfigRef ? { mediaConfigRef: deps.mediaConfigRef } : {}),
          agents,
          ...frozenMediaIntent(deps.mediaConfig, agents),
          ...(params.folderId ? { destination: { folderId: params.folderId } } : {}),
          ...(params.targetStageId
            ? {
                target: {
                  stageId: params.targetStageId,
                  revision: targetRevision!,
                  replaceExisting: params.replaceExisting,
                },
              }
            : {}),
          ...(params.outlines
            ? {
                planning: {
                  outlines: normalizePlannedOutlines(params.outlines),
                  courseTitle: params.courseTitle,
                  languageDirective: params.languageDirective,
                  researchContext: params.researchContext,
                  skillIds: params.skillIds,
                  skillConstraints,
                },
              }
            : {
                courseTitle: params.courseTitle,
                languageDirective: params.languageDirective,
                researchContext: params.researchContext,
              }),
        });
      } catch (error) {
        if (!(error instanceof GenerationJobError)) throw error;
        const code = params.agents ? 'INVALID_AGENTS' : error.code;
        return result(
          code === 'INVALID_AGENTS'
            ? 'The custom roster is incomplete or invalid. Supply full AgentInfo entries with stable ids and voiceConfig objects.'
            : 'The planned course could not be converted into a valid generation input.',
          { refused: true, code },
          true,
        );
      }
      const job = await deps.repository.createJob(
        deps.ownerId,
        key('submit', deps.sessionId, callId),
        input,
      );
      return result(`Course generation submitted: ${progress(job)}.`, job);
    },
  };
  const status: AgentTool<typeof JobParams, unknown> = {
    name: 'get_course_generation_status',
    label: 'Check course generation',
    description:
      'Read durable course-generation progress. Omit jobId to recover the latest job submitted by this Pro session.',
    parameters: JobParams,
    async execute(_callId, params: Static<typeof JobParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const job = params.jobId
        ? await deps.repository.getJob(deps.ownerId, params.jobId)
        : await deps.repository.getJobBySession(deps.ownerId, deps.sessionId);
      if (!job)
        return result(
          'No course generation job was found for this session.',
          { found: false },
          true,
        );
      if (job.status === 'succeeded') deps.onCompleted?.(job);
      return result(
        `Course generation: ${progress(job)}.${job.status === 'succeeded' ? ` Open ${job.courseUrl}` : ''}`,
        job,
      );
    },
  };
  const cancel: AgentTool<typeof JobParams, unknown> = {
    name: 'cancel_course_generation',
    label: 'Cancel course generation',
    description: 'Cancel a durable whole-course generation job owned by this user.',
    parameters: JobParams,
    executionMode: 'sequential',
    async execute(callId, params: Static<typeof JobParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const found = params.jobId
        ? await deps.repository.getJob(deps.ownerId, params.jobId)
        : await deps.repository.getJobBySession(deps.ownerId, deps.sessionId);
      if (!found)
        return result(
          'No course generation job was found for this session.',
          { found: false },
          true,
        );
      const job = await deps.repository.cancel(deps.ownerId, found.jobId, {
        commandKey: key('cancel', deps.sessionId, callId),
        expectedVersion: found.stateVersion,
      });
      return result(`Course generation cancelled: ${progress(job)}.`, job);
    },
  };
  const retry: AgentTool<typeof RetryParams, unknown> = {
    name: 'retry_course_generation',
    label: 'Retry course generation',
    description:
      'Retry a failed durable whole-course generation job from saved checkpoints. If status is needs_attention because an external result is unknown, first explain the duplicate-charge risk and obtain explicit user confirmation, then pass acknowledged=true. Never infer or default acknowledgement.',
    parameters: RetryParams,
    executionMode: 'sequential',
    async execute(callId, params: Static<typeof RetryParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const found = params.jobId
        ? await deps.repository.getJob(deps.ownerId, params.jobId)
        : await deps.repository.getJobBySession(deps.ownerId, deps.sessionId);
      if (!found || !deps.repository.retry)
        return result(
          'No retryable course generation job was found for this session.',
          { found: false },
          true,
        );
      if (found.status === 'needs_attention' && params.acknowledged !== true)
        return result(
          'This job has an unknown external result. Explain that retrying may duplicate a paid request and ask the user to confirm before retrying.',
          { refused: true, code: 'EXTERNAL_RESULT_ACKNOWLEDGEMENT_REQUIRED', jobId: found.jobId },
          true,
        );
      const job = await deps.repository.retry(deps.ownerId, found.jobId, {
        commandKey: key('retry', deps.sessionId, callId),
        expectedVersion: found.stateVersion,
        ...(params.acknowledged === true ? { acknowledged: true } : {}),
      });
      return result(`Course generation retry queued: ${progress(job)}.`, job);
    },
  };
  return [submit, status, cancel, retry] as unknown as AgentTool<never, never>[];
}

export const GENERATION_JOB_TOOL_NAMES = [
  'submit_course_generation',
  'get_course_generation_status',
  'cancel_course_generation',
  'retry_course_generation',
] as const;
