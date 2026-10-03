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
import { InvalidModelOutput, PipelineExecution } from './execution';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerationSearch');
const outputLog = createLogger('GenerationOutput');

/**
 * Fresh provider requests one step execution may add after the model answered
 * with unusable output. The step's own max_attempts bounds how often a resume
 * or manual retry grants this budget again.
 */
export const UNUSABLE_OUTPUT_REREQUESTS = 1;

/** Per-step record of a model caller's sequential call keys. */
export interface ModelCallLedger {
  /** Call keys handed out (`<step>:call:<n>`), recorded or not. */
  issued: number;
  /** Requests actually sent; a recorded call key replays without one. */
  dispatched: number;
  /** Sticky provider failure; no later call may be attempted. */
  failure?: unknown;
}

export function newModelCallLedger(): ModelCallLedger {
  return { issued: 0, dispatched: 0 };
}

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
    calls: ModelCallLedger = newModelCallLedger(),
  ): Promise<{ aiCall: AICallFn; binding: ModelBinding }> {
    const binding = await resolveBinding({
      request: storedSelectionRequest(this.modelSelection, this.input.model),
      stage,
    });
    if (!binding.credentialReady) throw new Error('PROVIDER_NOT_CONFIGURED');
    const aiCall: AICallFn = async (system, prompt, images) => {
      // Some package generators catch provider errors. Keep the execution failure
      // sticky so a repair call can never replay an unknown paid request.
      if (calls.failure) throw calls.failure;
      const id = `${key}:call:${calls.issued++}`;
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
            // Only runs when the call key has no recorded result.
            calls.dispatched++;
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
        calls.failure = error;
        throw error;
      }
    };
    return { aiCall, binding };
  }

  /**
   * Run `attempt` until it yields usable model output. When the provider
   * answered but `attempt` could not use the text (e.g. unrepairable JSON), the
   * next round sends a fresh request under the next call key; a recorded
   * output is never re-parsed as if it were new. Rounds whose call key was
   * already recorded replay for free, so a resumed step pays only for calls it
   * never made. Provider failures are never retried here.
   */
  async untilUsableOutput<T>(
    calls: ModelCallLedger,
    code: string,
    attempt: () => Promise<T | null>,
  ): Promise<T> {
    let rerequests = 0;
    for (let round = 0; ; round++) {
      const issued = calls.issued;
      const dispatched = calls.dispatched;
      const value = await attempt();
      if (round > 0 && calls.dispatched > dispatched) rerequests++;
      if (value !== null) return value;
      // A package generator may swallow a provider failure; never mask it.
      if (calls.failure) throw calls.failure;
      if (calls.issued === issued || rerequests >= UNUSABLE_OUTPUT_REREQUESTS)
        throw new InvalidModelOutput(
          code,
          calls.issued === issued
            ? 'Generation produced no usable result without calling the model.'
            : `Model output was unusable after ${calls.issued} call(s), including ${rerequests} fresh re-request(s).`,
        );
      outputLog.warn('Model output was unusable; re-requesting under a fresh call key', {
        code,
        nextCall: calls.issued,
      });
    }
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
    const calls = newModelCallLedger();
    const { aiCall, binding } = await this.modelCall('scene-outlines-stream', 'plan', calls);
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
    const outlineRequest: Parameters<typeof generateSceneOutlinesFromRequirements> = [
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
    ];
    const data = await this.untilUsableOutput(calls, 'INVALID_OUTLINE_RESULT', async () => {
      const result = await generateSceneOutlinesFromRequirements(...outlineRequest);
      return result.success && result.data ? result.data : null;
    });
    data.outlines = data.outlines.map((outline) =>
      taskEngineMode
        ? normalizeTaskEngineOutline(outline, this.input.requirements.requirement)
        : sanitizeNonTaskEngineOutline(outline),
    );
    validatePlan(data.outlines);
    return {
      ...data,
      languageDirective: this.input.languageDirective ?? data.languageDirective,
      courseTitle: this.input.courseTitle ?? data.courseTitle,
    };
  }

  async agents(plan: GenerationPlan): Promise<AgentCheckpoint> {
    if (this.input.agents?.mode === 'custom') return this.input.agents.items!;
    if (this.input.agents?.mode !== 'generate') return getDefaultAgents();
    const calls = newModelCallLedger();
    const { aiCall } = await this.modelCall('agent-profiles', 'agents', calls);
    const count = this.input.agents.count;
    const rosterRequest: [system: string, prompt: string] = [
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
    ];
    // Unparseable JSON earns a fresh request; a parsed but invalid roster does not.
    const value = await this.untilUsableOutput<{
      selectedCount?: number;
      difficulty?: AutomaticAgentDecisionCheckpoint['difficulty'];
      agents?: AgentInfo[];
    }>(calls, 'INVALID_AGENT_RESULT', async () => {
      const text = await aiCall(...rosterRequest);
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      } catch {
        return null;
      }
    });
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
    const calls = newModelCallLedger();
    const { aiCall, binding } = await this.modelCall(stage, key, calls);
    const allowProceduralSkill = resolveVocationalActive(this.input.requirements);
    const effective = applyOutlineFallbacks(outline, true, { allowProceduralSkill });
    const assignedImages = (this.input.materials?.images ?? [])
      .filter((image) => effective.suggestedImageIds?.includes(image.id))
      .map((image) => ({ ...image, src: '' })) as PdfImage[];
    const options: Parameters<typeof generateSceneContent>[2] = {
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
    };
    // Slide/quiz/interactive generators return null for unusable output.
    const content = await this.untilUsableOutput(calls, 'INVALID_CONTENT_RESULT', () =>
      generateSceneContent(effective, aiCall, options),
    );
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
