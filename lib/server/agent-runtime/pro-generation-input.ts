import { Type } from 'typebox';
import {
  GenerationInputSchema,
  GenerationJobError,
  type GenerationInput,
} from '@/lib/server/generation-jobs/contracts';
import type { AgentSessionMediaConfig } from './course-tools';
import {
  effectiveSessionVoiceConfigs,
  mediaConfigVoiceSource,
  resolveEffectiveSessionVoice,
  sessionVoiceCatalog,
} from './effective-voice-directory';

const ref = () => Type.String({ minLength: 1, maxLength: 200, pattern: '^[a-zA-Z0-9_.:/-]+$' });
const text = () => Type.String({ maxLength: 100_000 });
const voiceFields = {
  providerId: ref(),
  modelId: Type.Optional(ref()),
  voiceId: Type.String({ minLength: 1, maxLength: 200 }),
};
export const ProAgentParams = Type.Object(
  {
    id: ref(),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    role: Type.Union([Type.Literal('teacher'), Type.Literal('assistant'), Type.Literal('student')]),
    persona: text(),
    avatar: Type.Optional(Type.String({ maxLength: 1000 })),
    color: Type.Optional(Type.String({ maxLength: 100 })),
    priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    voice: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description:
          'Exact binding returned by list_voices; platform::defaultId::voiceId is resolved from the frozen session snapshot. Do not invent identity fields.',
      }),
    ),
    voiceConfig: Type.Optional(
      Type.Union([
        Type.Object(
          {
            source: Type.Literal('platform'),
            defaultId: ref(),
            revision: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            ...voiceFields,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            source: Type.Optional(
              Type.Union([Type.Literal('user'), Type.Literal('legacy-managed')]),
            ),
            ...voiceFields,
          },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);

// Keep page-specific extensions visible while preserving validatePlan's existing
// allowlist and credential-key checks at the durable boundary.
export const ProOutlineParams = Type.Object(
  {
    id: Type.String({ pattern: '^[a-zA-Z0-9_-]{1,200}$' }),
    type: Type.Union(['slide', 'quiz', 'interactive', 'pbl'].map((value) => Type.Literal(value))),
    title: Type.String({ minLength: 1 }),
    order: Type.Integer(),
    description: Type.Optional(
      Type.String({
        maxLength: 100_000,
        description:
          'Preferred canonical teaching description. Put all page teaching/style intent here. Do not also supply brief with different content.',
      }),
    ),
    brief: Type.Optional(
      Type.String({
        maxLength: 100_000,
        description:
          'Legacy alias of description, not an extra teaching field. Omit this when using description; if both are supplied, values must be identical.',
      }),
    ),
    keyPoints: Type.Optional(
      Type.Array(text(), {
        description:
          'Preferred canonical list of grounded facts and teaching points. Put all intended points here. Do not also supply materialFacts with a different array.',
      }),
    ),
    materialFacts: Type.Optional(
      Type.Array(text(), {
        description:
          'Legacy alias of keyPoints, not extra facts. Omit this when using keyPoints; if both are supplied, arrays must be identical.',
      }),
    ),
    languageNote: Type.Optional(
      Type.String({
        maxLength: 100_000,
        description:
          'Preferred canonical language note for this page. Do not also supply language with a different value.',
      }),
    ),
    language: Type.Optional(
      Type.String({
        maxLength: 100_000,
        description:
          'Legacy alias of languageNote. Omit this when using languageNote; if both are supplied, values must be identical.',
      }),
    ),
    teachingObjective: Type.Optional(text()),
    estimatedDuration: Type.Optional(Type.Number()),
    suggestedImageIds: Type.Optional(Type.Array(Type.String())),
    mediaGenerations: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    quizConfig: Type.Optional(
      Type.Object(
        {
          questionCount: Type.Integer(),
          difficulty: Type.Union(['easy', 'medium', 'hard'].map((value) => Type.Literal(value))),
          questionTypes: Type.Array(
            Type.Union(['single', 'multiple', 'text'].map((value) => Type.Literal(value))),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    interactiveConfig: Type.Optional(
      Type.Object(
        {
          conceptName: text(),
          conceptOverview: text(),
          designIdea: text(),
          subject: Type.Optional(text()),
        },
        { additionalProperties: false },
      ),
    ),
    pblConfig: Type.Optional(
      Type.Object(
        {
          projectTopic: text(),
          projectDescription: text(),
          targetSkills: Type.Array(text()),
          issueCount: Type.Optional(Type.Integer()),
          scenarioRoleplay: Type.Optional(Type.Boolean()),
          scenarioBrief: Type.Optional(text()),
        },
        { additionalProperties: false },
      ),
    ),
    widgetType: Type.Optional(Type.String()),
    widgetOutline: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  {
    additionalProperties: false,
    description:
      'Each page requires description and keyPoints (aliases brief and materialFacts are accepted). order must be a unique integer. language aliases languageNote. Conflicting aliases are rejected.',
  },
);

export class ProInputError extends GenerationJobError {
  constructor(
    code: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(code, 400);
  }
}

/** Pro-only adapter: the ordinary generation contract and roster tools stay intact. */
export function normalizeProAgents(
  value: readonly unknown[] | undefined,
  mediaConfig?: AgentSessionMediaConfig,
): GenerationInput['agents'] {
  if (!value) return { mode: 'generate' };
  const issues: Array<{ path: string; message: string }> = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const source = mediaConfig ? mediaConfigVoiceSource(mediaConfig) : undefined;
  const catalog = source ? sessionVoiceCatalog(source) : [];
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const { voice, ...agent } = entry as Record<string, unknown>;
    if (voice === undefined && agent.voiceConfig === undefined) return agent;
    const path = `agents[${index}]`;
    // Validate the supplied object before filling any missing identity, so unknown
    // fields, credential fields, and malformed variants cannot be silently erased.
    const parsed = GenerationInputSchema.shape.agents.safeParse({ mode: 'custom', items: [agent] });
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        add(`${path}.${issue.path.slice(2).join('.')}`, issue.message);
      return agent;
    }
    const supplied = parsed.data?.items?.[0]?.voiceConfig;
    if (supplied && !supplied.modelId && source) {
      const matchingModels = new Set(
        effectiveSessionVoiceConfigs(source)
          .filter(
            (candidate) =>
              candidate.voice === supplied.voiceId &&
              ('source' in supplied && supplied.source === 'platform'
                ? candidate.source === 'platform' &&
                  candidate.defaultId === supplied.defaultId &&
                  (!supplied.revision || candidate.revision === supplied.revision)
                : (candidate.source ?? 'legacy-managed') ===
                    ('source' in supplied ? supplied.source : 'legacy-managed') &&
                  candidate.providerId === supplied.providerId),
          )
          .map((candidate) => candidate.modelId),
      );
      if (matchingModels.size > 1)
        add(
          `${path}.voiceConfig.modelId`,
          'This voice is available on multiple models. Supply modelId or use one exact model-qualified binding from list_voices.',
        );
    }
    const selected =
      voice === undefined ? undefined : catalog.find((item) => item.binding === voice);
    if (voice !== undefined && !selected)
      add(
        `${path}.voice`,
        'Voice is not in the frozen session catalog. Call list_voices and copy an exact binding.',
      );
    const config = supplied && source ? resolveEffectiveSessionVoice(source, supplied) : undefined;
    if (
      supplied &&
      (!config ||
        !catalog.some(
          (item) =>
            item.id === supplied.voiceId &&
            item.providerId === config.providerId &&
            (!item.modelId || item.modelId === config.modelId) &&
            (item.source ?? 'legacy-managed') === (config.source ?? 'legacy-managed') &&
            item.defaultId === config.defaultId &&
            item.revision === config.revision,
        ))
    ) {
      add(
        `${path}.voiceConfig`,
        'Voice identity is unavailable or its platform revision changed. Use a binding from list_voices.',
      );
    }
    // Platform resolution keys on defaultId; verify any explicitly supplied
    // provider/model fields too, instead of accepting contradictory identities.
    if (
      supplied &&
      config &&
      (supplied.providerId !== config.providerId ||
        (supplied.modelId && supplied.modelId !== config.modelId))
    )
      add(`${path}.voiceConfig`, 'Provider/model conflicts with the frozen platform identity.');
    const selectedConfig =
      selected && source
        ? resolveEffectiveSessionVoice(source, { ...selected, voiceId: selected.id })
        : undefined;
    if (selected && !selectedConfig)
      add(`${path}.voice`, 'Voice is not synthesizable from this session snapshot.');
    if (
      selectedConfig &&
      config &&
      (selectedConfig.providerId !== config.providerId ||
        selectedConfig.modelId !== config.modelId ||
        selectedConfig.voice !== config.voice ||
        (selectedConfig.source ?? 'legacy-managed') !== (config.source ?? 'legacy-managed') ||
        selectedConfig.defaultId !== config.defaultId ||
        selectedConfig.revision !== config.revision)
    )
      add(
        `${path}.voiceConfig`,
        'voice and voiceConfig refer to different voices. Supply one binding or matching identities.',
      );
    const effective = selectedConfig ?? config;
    if (effective)
      agent.voiceConfig = {
        ...(effective.source ? { source: effective.source } : {}),
        ...(effective.defaultId ? { defaultId: effective.defaultId } : {}),
        ...(effective.revision ? { revision: effective.revision } : {}),
        providerId: effective.providerId,
        modelId: effective.modelId,
        voiceId: effective.voice,
      };
    return agent;
  });
  const parsed = GenerationInputSchema.shape.agents.safeParse({
    mode: 'custom',
    items: normalized,
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) add(`agents.${issue.path.join('.')}`, issue.message);
  else {
    const ids = new Set<string>();
    parsed.data?.items?.forEach((agent, index) => {
      if (ids.has(agent.id)) add(`agents[${index}].id`, 'Agent IDs must be unique.');
      ids.add(agent.id);
    });
    if (parsed.data?.items?.filter((agent) => agent.role === 'teacher').length !== 1)
      add('agents', 'The roster must contain exactly one teacher.');
  }
  if (issues.length) throw new ProInputError('INVALID_AGENTS', issues);
  return parsed.success ? parsed.data : undefined;
}
