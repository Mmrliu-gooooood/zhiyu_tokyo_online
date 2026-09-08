import {
  applyOutlineFallbacks,
  buildCompleteScene,
  buildVisionUserContent,
  generateSceneOutlinesFromRequirements,
  generateSceneContent,
  generateSceneActions,
  formatTeacherPersonaForPrompt,
  formatImageDescription,
  type AICallFn,
  type AgentInfo,
  type GeneratedSceneContent,
} from '@openmaic/generation';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';
import type { LlmStage } from '@/lib/server/model-routes';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/defaults';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { searchWeb, formatSearchResultsAsContext } from '@/lib/web-search';
import { validatePlan } from '@/lib/server/generation-jobs/contracts';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { ProModelContext } from '@/types/pro-model';
import type { SceneOutline, PdfImage } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';
import { normalizeTaskEngineOutline, sanitizeNonTaskEngineOutline } from './outline-modes';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { PipelineExecution } from './execution';

export interface GenerationPlan {
  outlines: SceneOutline[];
  languageDirective: string;
  courseTitle?: string;
}
export interface ContentCheckpoint {
  outline: SceneOutline;
  content: GeneratedSceneContent;
}
export interface PipelineAssets {
  read(assetId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  write(logicalKey: string, bytes: Uint8Array, mimeType: string): Promise<string>;
}

/** Server-only generation seams; neither transport URLs nor React state enter here. */
export class GenerationServices {
  constructor(
    readonly execution: PipelineExecution,
    readonly input: GenerationInput,
    readonly assets: PipelineAssets,
    readonly modelContext?: ProModelContext,
  ) {}

  async modelCall(
    stage: LlmStage,
    key: string,
  ): Promise<{ aiCall: AICallFn; resolved: Awaited<ReturnType<typeof resolveModel>> }> {
    await this.modelContext?.assertActive?.();
    const resolved = await resolveModel({ ...this.input.model, ...this.modelContext, stage });
    if (isProviderKeyRequired(resolved.providerId) && !resolved.apiKey)
      throw new Error('PROVIDER_NOT_CONFIGURED');
    let callIndex = 0;
    let failure: unknown;
    const aiCall: AICallFn = async (system, prompt, images) => {
      // Some package generators catch provider errors. Keep the execution failure
      // sticky so a repair call can never replay an unknown paid request.
      if (failure) throw failure;
      const id = `${key}:call:${callIndex++}`;
      try {
        return await this.execution.external(
          id,
          {
            system,
            prompt,
            images,
            model: resolved.modelString,
            thinking: resolved.thinkingConfig,
          },
          'llm',
          resolved.providerId,
          async (signal) => {
            const vision = images?.length && resolved.modelInfo?.capabilities?.vision;
            const resolvedImages = vision
              ? await Promise.all(
                  images!.map(async (image) => {
                    if (image.src.startsWith('data:')) return image;
                    const asset = await this.assets.read(image.src);
                    return {
                      ...image,
                      src: `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`,
                    };
                  }),
                )
              : undefined;
            signal.throwIfAborted();
            const result = await callLLM(
              {
                model: resolved.model,
                system,
                ...(resolvedImages
                  ? {
                      messages: [
                        {
                          role: 'user' as const,
                          content: buildVisionUserContent(prompt, resolvedImages),
                        },
                      ],
                    }
                  : { prompt }),
                maxOutputTokens: resolved.modelInfo?.outputWindow,
                maxRetries: 0,
                abortSignal: signal,
              },
              stage,
              undefined,
              resolved.thinkingConfig,
            );
            return result.text;
          },
        );
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    return { aiCall, resolved };
  }

  async research(): Promise<string> {
    if (this.input.researchContext) return this.input.researchContext;
    if (!this.input.enableWebSearch && !this.input.requirements.webSearch) return '';
    const config = resolveClassroomWebSearchConfig({
      webSearchProviderId: this.input.webSearch?.providerId as WebSearchProviderId | undefined,
      webSearchModelId: this.input.webSearch?.modelId,
    });
    if (
      !config ||
      (this.input.webSearch?.providerId && config.providerId !== this.input.webSearch.providerId)
    )
      throw new Error('WEB_SEARCH_NOT_CONFIGURED');
    const query = await this.execution.checkpoint(
      'research:query',
      { requirements: this.input.requirements, text: this.input.materials?.text },
      async () => {
        const { aiCall } = await this.modelCall('web-search-query-rewrite', 'research:query');
        return buildSearchQuery(
          this.input.requirements.requirement,
          this.input.materials?.text,
          aiCall,
        );
      },
    );
    return this.execution.external(
      'research:search',
      { query: query.query, provider: config.providerId },
      'llm',
      config.providerId,
      async (signal) => {
        signal.throwIfAborted();
        const result = await searchWeb({ ...config, query: query.query });
        signal.throwIfAborted();
        return formatSearchResultsAsContext(result);
      },
    );
  }

  async plan(researchContext: string): Promise<GenerationPlan> {
    const { aiCall, resolved } = await this.modelCall('scene-outlines-stream', 'plan');
    const images = (this.input.materials?.images ?? []).map((image) => ({
      ...image,
      src: '',
    })) as PdfImage[];
    const teacherContext = formatTeacherPersonaForPrompt(
      this.input.agents?.mode === 'custom' ? this.input.agents.items : undefined,
    );
    const taskEngineMode = resolveVocationalActive(this.input.requirements);
    const interactiveMode = this.input.requirements.interactiveMode === true;
    const specialized =
      taskEngineMode || interactiveMode
        ? buildPrompt(
            taskEngineMode ? PROMPT_IDS.TASK_ENGINE_OUTLINES : PROMPT_IDS.INTERACTIVE_OUTLINES,
            {
              requirement: this.input.requirements.requirement,
              pdfContent: this.input.materials?.text?.substring(0, MAX_PDF_CONTENT_CHARS) || 'None',
              availableImages:
                images.map(formatImageDescription).join('\n') || 'No images available',
              researchContext: researchContext || 'None',
              hasSourceImages: images.length > 0,
              imageEnabled: this.input.enableImageGeneration,
              videoEnabled: this.input.enableVideoGeneration,
              mediaEnabled:
                !!this.input.enableImageGeneration || !!this.input.enableVideoGeneration,
              teacherContext,
              userProfile:
                this.input.requirements.userNickname || this.input.requirements.userBio
                  ? `## Student Profile\n\nStudent: ${this.input.requirements.userNickname || 'Unknown'}${this.input.requirements.userBio ? ` — ${this.input.requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
                  : '',
            },
          )
        : null;
    if ((taskEngineMode || interactiveMode) && !specialized)
      throw new Error('OUTLINE_MODE_TEMPLATE_UNAVAILABLE');
    const outlineCall: AICallFn = specialized
      ? (_system, _user, visionImages) => aiCall(specialized.system, specialized.user, visionImages)
      : aiCall;
    const result = await generateSceneOutlinesFromRequirements(
      this.input.requirements,
      this.input.materials?.text,
      images,
      outlineCall,
      {
        imageMapping: Object.fromEntries(images.map((image) => [image.id, image.assetId!])),
        visionEnabled: !!resolved.modelInfo?.capabilities?.vision,
        imageGenerationEnabled: this.input.enableImageGeneration,
        videoGenerationEnabled: this.input.enableVideoGeneration,
        researchContext,
        teacherContext,
      },
    );
    if (!result.success || !result.data) throw new Error('INVALID_OUTLINE_RESULT');
    result.data.outlines = result.data.outlines.map((outline) =>
      taskEngineMode
        ? normalizeTaskEngineOutline(outline, this.input.requirements.requirement)
        : sanitizeNonTaskEngineOutline(outline),
    );
    validatePlan(result.data.outlines);
    return {
      ...result.data,
      languageDirective: this.input.languageDirective ?? result.data.languageDirective,
      courseTitle: this.input.courseTitle ?? result.data.courseTitle,
    };
  }

  async agents(plan: GenerationPlan): Promise<AgentInfo[]> {
    if (this.input.agents?.mode === 'custom') return this.input.agents.items!;
    if (this.input.agents?.mode !== 'generate') return getDefaultAgents();
    const { aiCall } = await this.modelCall('agent-profiles', 'agents');
    const count = this.input.agents.count;
    const text = await aiCall(
      `Generate classroom agent profiles. Return JSON {"agents":[{"name":"...","role":"teacher|assistant|student","persona":"..."}]}. Exactly one teacher and ${count ? `exactly ${count}` : '2–5'} total agents.`,
      `${this.input.requirements.requirement}\nLanguage: ${plan.languageDirective}`,
    );
    const value = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as {
      agents: AgentInfo[];
    };
    if (
      !Array.isArray(value.agents) ||
      value.agents.length < 1 ||
      value.agents.length > 10 ||
      (count && value.agents.length !== count) ||
      value.agents.filter((agent) => agent.role === 'teacher').length !== 1 ||
      value.agents.some(
        (agent) =>
          !agent.name ||
          !agent.persona ||
          !['teacher', 'assistant', 'student'].includes(agent.role),
      )
    )
      throw new Error('INVALID_AGENT_RESULT');
    return value.agents.map((agent, index) => ({
      ...agent,
      id: `gen-${this.execution.lease.jobId}-${index}`,
    }));
  }

  async content(
    outline: SceneOutline,
    agents: AgentInfo[],
    plan: GenerationPlan,
  ): Promise<ContentCheckpoint> {
    const key = `content:${outline.id}`;
    const { aiCall, resolved } = await this.modelCall(
      `scene-content:${outline.type}` as LlmStage,
      key,
    );
    const allowProceduralSkill = resolveVocationalActive(this.input.requirements);
    const effective = applyOutlineFallbacks(outline, true, { allowProceduralSkill });
    const assignedImages = (this.input.materials?.images ?? [])
      .filter((image) => effective.suggestedImageIds?.includes(image.id))
      .map((image) => ({ ...image, src: '' })) as PdfImage[];
    const content = await generateSceneContent(effective, aiCall, {
      agents,
      languageDirective: plan.languageDirective,
      targetLanguage: this.input.locale,
      userRequirements: this.input.requirements,
      allowProceduralSkill,
      assignedImages,
      imageMapping: Object.fromEntries(assignedImages.map((image) => [image.id, image.assetId!])),
      visionEnabled: !!resolved.modelInfo?.capabilities?.vision,
      ...(effective.type === 'pbl'
        ? {
            pblLoopFallback: (input) =>
              this.execution.external(
                `${key}:planner`,
                { input, model: resolved.modelString },
                'llm',
                resolved.providerId,
                (signal) =>
                  generatePBLV2Project(
                    input,
                    resolved.model,
                    (params, source, retries, thinking) => {
                      signal.throwIfAborted();
                      return callLLM(
                        { ...params, maxRetries: 0, abortSignal: signal },
                        source,
                        retries,
                        thinking,
                      );
                    },
                    {},
                    resolved.thinkingConfig,
                  ),
              ),
          }
        : {}),
    });
    if (!content) throw new Error('INVALID_CONTENT_RESULT');
    return { outline: effective, content };
  }

  async actions(
    checkpoint: ContentCheckpoint,
    agents: AgentInfo[],
    plan: GenerationPlan,
    previousSpeeches: string[],
  ): Promise<Action[]> {
    const { aiCall } = await this.modelCall('scene-actions', `actions:${checkpoint.outline.id}`);
    const actions = await generateSceneActions(checkpoint.outline, checkpoint.content, aiCall, {
      agents,
      languageDirective: plan.languageDirective,
      userProfile: [this.input.requirements.userNickname, this.input.requirements.userBio]
        .filter(Boolean)
        .join(' — '),
      ctx: {
        pageIndex: plan.outlines.findIndex((outline) => outline.id === checkpoint.outline.id) + 1,
        totalPages: plan.outlines.length,
        allTitles: plan.outlines.map((outline) => outline.title),
        previousSpeeches,
      },
    });
    if (!actions.length) throw new Error('INVALID_ACTIONS_RESULT');
    return actions;
  }

  assemble(checkpoint: ContentCheckpoint, actions: Action[], sceneId: string): Scene {
    const scene = buildCompleteScene(
      checkpoint.outline,
      checkpoint.content,
      actions,
      this.execution.lease.stageId,
      { sceneId },
    );
    if (!scene) throw new Error('INVALID_SCENE_RESULT');
    return scene as Scene;
  }
}
