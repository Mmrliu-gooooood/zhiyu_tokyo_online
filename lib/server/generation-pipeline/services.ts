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
  isAbortError,
} from '@openmaic/generation';
import {
  gateway,
  resolveBinding,
  storedSelectionRequest,
  userParts,
  userText,
  type ModelBinding,
  type ModelSelection,
} from '@/lib/model-gateway';
import type { LlmStage } from '@/lib/server/model-routes';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { gatewayPlannerCall, generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/defaults';
import { resolveGenerationSearchConfig } from './search';
import type { GenerationSearchSnapshotContent } from '@/lib/server/generation-search-snapshots';
import { searchWeb, formatSearchResultsAsContext } from '@/lib/web-search';
import { describeWebSearchFailure } from '@/lib/web-search/failure';
import { validatePlan } from '@/lib/server/generation-jobs/contracts';
import type { GenerationInput } from '@/lib/server/generation-jobs/contracts';
import type { SceneOutline, PdfImage } from '@/lib/types/generation';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { MAX_PDF_CONTENT_CHARS } from '@/lib/constants/generation';
import { normalizeTaskEngineOutline, sanitizeNonTaskEngineOutline } from './outline-modes';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { PipelineExecution } from './execution';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationSearch');

/** Diagnostic hostname of the bound endpoint (never a URL or credential). */
function endpointHostname(binding: ModelBinding): string | undefined {
  try {
    return binding.model.baseUrl ? new URL(binding.model.baseUrl).hostname : undefined;
  } catch {
    return undefined;
  }
}

export const AUTO_AGENT_STRATEGY_VERSION = 'difficulty-v1';

export interface AutomaticAgentDecisionCheckpoint {
  kind: 'automatic-agent-decision';
  version: 1;
  strategyVersion: typeof AUTO_AGENT_STRATEGY_VERSION;
  outlineVersion: number;
  difficulty: {
    level: 'introductory' | 'applied' | 'complex';
    rationale: string;
  };
  agents: AgentInfo[];
}

export type AgentCheckpoint = AgentInfo[] | AutomaticAgentDecisionCheckpoint;

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
    /** The run's snapshot selection; absent for operator-managed runs. */
    readonly modelSelection?: ModelSelection,
    readonly searchConfig?: GenerationSearchSnapshotContent,
  ) {}

  async modelCall(
    stage: LlmStage,
    key: string,
  ): Promise<{ aiCall: AICallFn; binding: ModelBinding }> {
    const binding = await resolveBinding({
      request: storedSelectionRequest(this.modelSelection, this.input.model),
      stage,
    });
    if (!binding.credentialReady) throw new Error('PROVIDER_NOT_CONFIGURED');
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
            model: binding.modelString,
            thinking: binding.thinking,
          },
          'llm',
          binding.providerId,
          async (signal) => {
            const vision = images?.length && binding.capabilities.vision;
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
            // The gateway retries pre-send DNS failures itself (plan 3.8).
            const result = await gateway.complete(
              binding,
              {
                system,
                messages: [
                  resolvedImages
                    ? userParts(buildVisionUserContent(prompt, resolvedImages))
                    : userText(prompt),
                ],
              },
              { source: stage, signal, retry: 'none' },
            );
            return result.text;
          },
          false,
          { hostname: endpointHostname(binding) },
        );
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    return { aiCall, binding };
  }

  async research(): Promise<string> {
    if (this.input.researchContext) return this.input.researchContext;
    if (!this.input.enableWebSearch && !this.input.requirements.webSearch) return '';
    const config = resolveGenerationSearchConfig(this.input, this.searchConfig);
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
      async (signal, lifecycle) => {
        signal.throwIfAborted();
        const optionalSearch = !!this.input.searchConfigRef && this.input.source?.kind !== 'pro';
        try {
          const result = await searchWeb({
            ...config,
            query: query.query,
            ...(optionalSearch ? { signal } : {}),
          });
          signal.throwIfAborted();
          return formatSearchResultsAsContext(result);
        } catch (error) {
          signal.throwIfAborted();
          if (!optionalSearch || isAbortError(error)) throw error;
          lifecycle.reportDnsFailure(error);
          // Persist an empty result once, so resuming this course never repeats
          // an optional failed search. Log only allowlisted diagnostics; upstream
          // messages may contain credentials, URLs, queries or challenge bodies.
          log.warn(
            'Optional web search unavailable; continuing course generation without research',
            { provider: config.providerId, ...describeWebSearchFailure(error) },
          );
          return '';
        }
      },
    );
  }

  async plan(researchContext: string): Promise<GenerationPlan> {
    const { aiCall, binding } = await this.modelCall('scene-outlines-stream', 'plan');
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
        visionEnabled: binding.capabilities.vision,
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

  async agents(plan: GenerationPlan): Promise<AgentCheckpoint> {
    if (this.input.agents?.mode === 'custom') return this.input.agents.items!;
    if (this.input.agents?.mode !== 'generate') return getDefaultAgents();
    const { aiCall } = await this.modelCall('agent-profiles', 'agents');
    const count = this.input.agents.count;
    const text = await aiCall(
      `Evaluate the course difficulty and generate its classroom roster in one decision. Return JSON {"difficulty":{"level":"introductory|applied|complex","rationale":"..."},"agents":[{"id":"unique-role-id","name":"...","role":"teacher|assistant|student","persona":"course-specific teaching or learning responsibility"}]}. Exactly one teacher and ${count ? `exactly ${count} total agents for this legacy fixed-count task` : '2–5 total agents chosen from the course complexity and necessary responsibilities'}. Use distinct non-empty responsibilities and unique role IDs. Do not choose from title, subject, or page count alone.`,
      JSON.stringify(
        {
          courseRequestIncludingGoalsPrerequisitesAndTeachingMethod:
            this.input.requirements.requirement,
          learner: {
            nickname: this.input.requirements.userNickname,
            levelAndBackground: this.input.requirements.userBio,
          },
          courseTitle: plan.courseTitle,
          languageDirective: plan.languageDirective,
          confirmedOutline: plan.outlines,
          decisionGuidance: {
            difficultyBasis:
              'Use objectives, prerequisites, abstraction, reasoning or operational steps, learner level, and teaching method.',
            introductory: 'Usually 2-3 roles for one focused goal.',
            applied: 'Usually 3-4 roles for multi-step application.',
            complex:
              'Usually 4-5 roles when integrated reasoning or multiple necessary perspectives demand it.',
          },
        },
        null,
        2,
      ),
    );
    let value: {
      selectedCount?: number;
      difficulty?: AutomaticAgentDecisionCheckpoint['difficulty'];
      agents?: AgentInfo[];
    };
    try {
      value = JSON.parse(
        text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
      ) as typeof value;
    } catch {
      throw new Error('INVALID_AGENT_RESULT');
    }
    const agents = value.agents;
    const difficulty = value.difficulty;
    const ids = new Set<string>();
    const responsibilities = new Set<string>();
    const expectedCount = count ?? null;
    if (
      !difficulty ||
      !['introductory', 'applied', 'complex'].includes(difficulty.level) ||
      typeof difficulty.rationale !== 'string' ||
      !difficulty.rationale.trim() ||
      !Array.isArray(agents) ||
      (expectedCount === null && (agents.length < 2 || agents.length > 5)) ||
      (expectedCount !== null && agents.length !== expectedCount) ||
      (value.selectedCount !== undefined && value.selectedCount !== agents.length) ||
      agents.filter((agent) => agent.role === 'teacher').length !== 1 ||
      agents.some(
        (agent) =>
          typeof agent.id !== 'string' ||
          !/^[a-zA-Z0-9_.:/-]+$/.test(agent.id) ||
          ids.has(agent.id) ||
          !ids.add(agent.id) ||
          typeof agent.name !== 'string' ||
          !agent.name.trim() ||
          typeof agent.persona !== 'string' ||
          !agent.persona.trim() ||
          responsibilities.has(agent.persona.trim().toLocaleLowerCase()) ||
          !responsibilities.add(agent.persona.trim().toLocaleLowerCase()) ||
          !['teacher', 'assistant', 'student'].includes(agent.role),
      )
    )
      throw new Error('INVALID_AGENT_RESULT');
    return {
      kind: 'automatic-agent-decision',
      version: 1,
      strategyVersion: AUTO_AGENT_STRATEGY_VERSION,
      outlineVersion: this.execution.lease.planRevision,
      difficulty: {
        level: difficulty.level,
        rationale: difficulty.rationale.trim(),
      },
      agents: agents.map((agent, index) => ({
        ...agent,
        name: agent.name.trim(),
        persona: agent.persona!.trim(),
        id: `gen-${this.execution.lease.jobId}-${index}`,
      })),
    };
  }

  async content(
    outline: SceneOutline,
    agents: AgentInfo[],
    plan: GenerationPlan,
  ): Promise<ContentCheckpoint> {
    const key = `content:${outline.id}`;
    const stage = `scene-content:${outline.type}` as LlmStage;
    const { aiCall, binding } = await this.modelCall(stage, key);
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
      visionEnabled: binding.capabilities.vision,
      ...(effective.type === 'pbl'
        ? {
            pblLoopFallback: (input) =>
              this.execution.external(
                `${key}:planner`,
                { input, model: binding.modelString },
                'llm',
                binding.providerId,
                (signal) =>
                  generatePBLV2Project(
                    input,
                    binding,
                    gatewayPlannerCall({ signal, retry: 'none' }),
                    {},
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
