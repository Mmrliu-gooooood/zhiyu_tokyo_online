import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SceneOutline } from '@/lib/types/generation';

export const GENERATION_PIPELINE_VERSION = '1';
export const GENERATION_SCHEMA_VERSION = 4;
export class GenerationJobError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 409,
  ) {
    super(code);
    this.name = 'GenerationJobError';
  }
}
const text = z.string().max(100_000);
const ref = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
export const MediaConfigRefSchema = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
export type MediaConfigRef = z.infer<typeof MediaConfigRefSchema>;
export const GenerationModelRefSchema = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
export type GenerationModelRef = z.infer<typeof GenerationModelRefSchema>;
export const GenerationSearchRefSchema = z
  .object({ id: z.uuid(), revision: z.number().int().positive() })
  .strict();
export type GenerationSearchRef = z.infer<typeof GenerationSearchRefSchema>;
const image = z
  .object({
    id: ref,
    assetId: ref,
    pageNumber: z.number().int().nonnegative(),
    description: text.optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    originalId: ref.optional(),
    sourceDocumentId: ref.optional(),
    sourceDocumentName: z.string().max(500).optional(),
    sourceDocumentOrder: z.number().int().nonnegative().optional(),
    visionPriority: z.number().optional(),
  })
  .strict();
const voice = z
  .object({ providerId: ref, modelId: ref.optional(), voiceId: z.string().max(200) })
  .strict();
const agent = z
  .object({
    id: ref,
    name: z.string().min(1).max(200),
    role: z.enum(['teacher', 'assistant', 'student']),
    persona: text,
    avatar: z.string().max(1000).optional(),
    color: z.string().max(100).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    voiceConfig: voice.optional(),
  })
  .strict();
export const GenerationInputSchema = z
  .object({
    version: z.literal(1),
    requirements: z
      .object({
        requirement: text.min(1),
        userNickname: z.string().max(200).optional(),
        userBio: text.optional(),
        webSearch: z.boolean().optional(),
        interactiveMode: z.boolean().optional(),
        taskEngineMode: z.boolean().optional(),
      })
      .strict(),
    model: z
      .object({
        modelString: ref.optional(),
        thinkingConfig: z
          .object({
            enabled: z.boolean().optional(),
            mode: z.enum(['default', 'disabled', 'enabled', 'auto']).optional(),
            budgetTokens: z.number().int().positive().optional(),
            effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
            level: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
            excludeReasoningOutput: z.boolean().optional(),
          })
          .strict()
          .optional(),
        configVersion: ref.optional(),
      })
      .strict()
      .optional(),
    locale: z.string().max(100).optional(),
    languageDirective: text.optional(),
    researchContext: text.optional(),
    courseTitle: z.string().max(500).optional(),
    materials: z
      .object({
        text: text.optional(),
        images: z.array(image).max(100).optional(),
        sources: z
          .array(
            z
              .object({
                assetId: ref,
                revision: z.number().int().positive(),
                digest: z.string().regex(/^[a-f0-9]{64}$/),
                name: z.string().max(500).optional(),
                providerId: ref.optional(),
              })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict()
      .optional(),
    agents: z
      .object({
        mode: z.enum(['default', 'generate', 'custom']),
        count: z.number().int().min(1).max(10).optional(),
        items: z.array(agent).min(1).max(10).optional(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        mode: z.enum(['manual', 'auto']),
        autoConfirmSeconds: z.number().min(2.5).max(3600).optional(),
      })
      .strict()
      .default({ mode: 'manual' }),
    enableWebSearch: z.boolean().optional(),
    enableImageGeneration: z.boolean().optional(),
    enableVideoGeneration: z.boolean().optional(),
    webSearch: z.object({ providerId: ref, modelId: ref.optional() }).strict().optional(),
    media: z
      .object({
        image: z.object({ providerId: ref, modelId: ref }).strict().optional(),
        video: z.object({ providerId: ref, modelId: ref }).strict().optional(),
      })
      .strict()
      .optional(),
    mediaConfigRef: MediaConfigRefSchema.optional(),
    modelConfigRef: GenerationModelRefSchema.optional(),
    searchConfigRef: GenerationSearchRefSchema.optional(),
    source: z
      .object({
        kind: z.enum(['home', 'pro']),
        sessionId: ref.optional(),
        submissionId: ref.optional(),
      })
      .strict()
      .optional(),
    target: z
      .object({
        stageId: ref,
        revision: z.number().int().nonnegative(),
        replaceExisting: z.boolean().optional(),
      })
      .strict()
      .optional(),
    planning: z
      .object({
        outlines: z.array(z.unknown()).min(1).max(30),
        courseTitle: z.string().max(500).optional(),
        languageDirective: text.optional(),
        researchContext: text.optional(),
        skillIds: z.array(ref).max(30).optional(),
        skillConstraints: z
          .array(z.object({ id: ref, constraints: z.record(z.string(), z.unknown()) }).strict())
          .max(30)
          .optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        enabled: z.boolean(),
        providerId: ref.optional(),
        modelId: ref.optional(),
        voice: z.string().max(200).optional(),
        speed: z.number().min(0.25).max(4).optional(),
        agentVoiceOverrides: z.record(z.string(), voice).optional(),
      })
      .strict()
      .optional(),
    budget: z
      .object({
        activeMs: z.number().int().min(1000).max(3_600_000).optional(),
        maxAssetBytes: z.number().int().positive().max(100_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GenerationInput = z.infer<typeof GenerationInputSchema>;
export function parseGenerationInput(value: unknown): GenerationInput {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1_048_576)
    throw new GenerationJobError('INPUT_TOO_LARGE', 400);
  const parsed = GenerationInputSchema.safeParse(value);
  if (!parsed.success) throw new GenerationJobError('INVALID_GENERATION_INPUT', 400);
  if (
    parsed.data.agents?.mode === 'custom' &&
    (!parsed.data.agents.items ||
      parsed.data.agents.items.filter((a) => a.role === 'teacher').length !== 1)
  )
    throw new GenerationJobError('INVALID_AGENTS', 400);
  if (parsed.data.planning) validatePlan(parsed.data.planning.outlines);
  if ((parsed.data.target || parsed.data.planning) && parsed.data.source?.kind !== 'pro')
    throw new GenerationJobError('INVALID_PRO_GENERATION_INPUT', 400);
  return parsed.data;
}
export function canonicalHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function validatePlan(value: unknown): SceneOutline[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30)
    throw new GenerationJobError('INVALID_OUTLINE', 400);
  const ids = new Set<string>();
  const allowed = new Set([
    'id',
    'type',
    'title',
    'description',
    'keyPoints',
    'teachingObjective',
    'estimatedDuration',
    'order',
    'languageNote',
    'suggestedImageIds',
    'mediaGenerations',
    'quizConfig',
    'interactiveConfig',
    'pblConfig',
    'widgetType',
    'widgetOutline',
  ]);
  const safeKeys = (v: unknown): boolean =>
    !v ||
    typeof v !== 'object' ||
    Object.entries(v).every(
      ([key, item]) =>
        !/api.?key|authorization|password|secret|token|base.?url|callback.?url/i.test(key) &&
        safeKeys(item),
    );
  for (const o of value) {
    if (
      o &&
      typeof o === 'object' &&
      (Object.keys(o).some((key) => !allowed.has(key)) || !safeKeys(o))
    )
      throw new GenerationJobError('INVALID_OUTLINE', 400);
    if (
      !o ||
      typeof o !== 'object' ||
      typeof o.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(o.id) ||
      ids.has(o.id) ||
      !['slide', 'quiz', 'interactive', 'pbl'].includes(o.type) ||
      typeof o.title !== 'string' ||
      !o.title.trim() ||
      typeof o.description !== 'string' ||
      !Array.isArray(o.keyPoints) ||
      !o.keyPoints.every((v: unknown) => typeof v === 'string') ||
      !Number.isFinite(o.order)
    )
      throw new GenerationJobError('INVALID_OUTLINE', 400);
    ids.add(o.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 524_288)
    throw new GenerationJobError('INVALID_OUTLINE', 400);
  return value as SceneOutline[];
}
export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'retry_wait'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export interface GenerationLease {
  jobId: string;
  stageId: string;
  ownerId: string;
  workerId: string;
  leaseEpoch: number;
  ownershipEpoch: number;
  planRevision: number;
  input: GenerationInput;
}
export interface GenerationJobView {
  jobId: string;
  stageId: string;
  status: GenerationJobStatus;
  phase: string;
  stateVersion: number;
  runNo: number;
  planRevision: number;
  readyScenes: number;
  totalScenes: number;
  warningCount: number;
  lastErrorCode: string | null;
  reviewHold: boolean;
  autoContinueAt: string | null;
  queueReason?: 'queued' | 'owner_limit' | 'site_limit' | 'service_unavailable' | null;
  retryAt?: string | null;
  pollUrl: string;
  courseUrl: string;
  pollIntervalMs: number;
}
export interface StepStart {
  key: string;
  kind: string;
  dependencyHash: string;
  outlineId?: string;
  external?: boolean;
  deadlineMs?: number;
}
export interface StepReceipt {
  stepId: string;
  attemptId: string | null;
  requestKey: string;
  status: string;
  result?: unknown;
  providerRequestId?: string;
}
