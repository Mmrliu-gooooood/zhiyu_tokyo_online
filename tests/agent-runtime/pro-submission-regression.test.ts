import { describe, expect, it, vi } from 'vitest';
import {
  buildGenerationJobTools,
  type GenerationJobToolDeps,
} from '@/lib/server/agent-runtime/generation-job-tools';
import { createProCourseRuntimeBoundary } from '@/lib/server/agent-runtime/runner-contract';
import lectureConstraints from '@/skills/agent-runtime/lecture-style/outline-constraints.json';

vi.mock('@/lib/server/resolve-provider-selection', () => ({
  resolveProviderSelection: vi.fn(() => ({
    providerId: 'minimax-tts',
    modelId: 'speech-2.8-hd',
    revision: 'rev-one',
    apiKey: 'private',
    baseUrl: 'https://tts.example.test',
  })),
}));

const outline = {
  id: 'one',
  type: 'slide',
  title: 'One',
  description: 'Teach the concept',
  keyPoints: [],
  order: 0,
};
const teacher = { id: 'teacher', role: 'teacher', name: 'Teacher', persona: 'Teaches' };
const mediaConfig: GenerationJobToolDeps['mediaConfig'] = {
  version: 3,
  ttsEnabled: true,
  ttsProviders: [
    {
      source: 'platform',
      defaultId: 'default-tts',
      revision: 'rev-one',
    },
  ],
  ttsVoiceDirectory: [
    {
      source: 'platform',
      defaultId: 'default-tts',
      revision: 'rev-one',
      voiceIds: ['female-yujie'],
    },
  ],
};
function setup(extra: Partial<GenerationJobToolDeps> = {}) {
  const createJob = vi.fn(
    async () => ({ status: 'queued', phase: 'preparing', readyScenes: 0, totalScenes: 0 }) as never,
  );
  const tools = buildGenerationJobTools({
    ownerId: 'owner',
    sessionId: 'session',
    repository: { createJob, getJob: vi.fn(), getJobBySession: vi.fn(), cancel: vi.fn() },
    ...extra,
  });
  const submit = tools.find((t) => t.name === 'submit_course_generation')!;
  const run = (params: Record<string, unknown>) =>
    submit.execute(
      'call',
      { requirement: 'Course', ...params } as never,
      undefined,
      undefined,
    ) as Promise<{
      isError?: boolean;
      details: { code?: string; issues?: unknown[] };
      content: Array<{ text: string }>;
    }>;
  return { createJob, submit, run, tools };
}

describe('Pro submission contract regression', () => {
  it('reports exact interactive counts, then accepts a complete corrected plan once', async () => {
    const { run, createJob } = setup({
      resolveSkills: async () => [
        {
          id: 'workshop-style',
          constraints: { typeMix: [{ type: 'interactive', min: 3, minRatio: 0.4 }] },
        },
      ],
    });
    const outlines = Array.from({ length: 13 }, (_, order) => ({
      ...outline,
      id: `p${order}`,
      order,
      type: order >= 8 ? 'interactive' : order >= 5 ? 'quiz' : 'slide',
      ...(order >= 8
        ? { widgetType: 'simulation', widgetOutline: { concept: 'Try a parameter' } }
        : {}),
    }));
    const response = await run({ outlines, skillIds: ['workshop-style'] });
    expect(response).toMatchObject({
      isError: true,
      details: { code: 'SKILL_CONSTRAINT_VIOLATION' },
    });
    expect(response.content[0].text).toContain('5 of 13');
    expect(response.content[0].text).toContain('at least 6');
    expect(response.content[0].text).toContain('1 more');
    expect(createJob).not.toHaveBeenCalled();
    const corrected = outlines.map((page, index) =>
      index === 4
        ? {
            ...page,
            type: 'interactive',
            description: 'Vary the initial condition and compare solutions.',
            widgetType: 'simulation',
            widgetOutline: { concept: 'Initial conditions' },
          }
        : page,
    );
    expect((await run({ outlines: corrected, skillIds: ['workshop-style'] })).isError).not.toBe(
      true,
    );
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('reports every conflicting outline alias on every page in one actionable response', async () => {
    const { run, createJob } = setup();
    const outlines = Array.from({ length: 3 }, (_, order) => ({
      ...outline,
      id: `p${order + 1}`,
      order,
      description: 'Canonical teaching intent',
      brief: 'Different teaching intent',
      keyPoints: ['Canonical fact'],
      materialFacts: ['Different fact'],
      languageNote: 'Chinese',
      language: 'English',
    }));
    const rejected = await run({ outlines });
    const paths = outlines.flatMap((_, index) =>
      ['brief', 'materialFacts', 'language'].map((alias) => `outlines[${index}].${alias}`),
    );
    expect(rejected).toMatchObject({
      isError: true,
      details: {
        code: 'INVALID_OUTLINE',
        issues: paths.map((path) => expect.objectContaining({ path, code: 'INVALID_OUTLINE' })),
      },
    });
    for (const path of paths) expect(rejected.content[0].text).toContain(path);
    expect(rejected.content[0].text).toContain('description');
    expect(rejected.content[0].text).toContain('keyPoints');
    expect(rejected.content[0].text).toContain('languageNote');
    expect(createJob).not.toHaveBeenCalled();
    const corrected = outlines.map(
      ({ brief: _brief, materialFacts: _materialFacts, language: _language, ...page }) => page,
    );
    expect(await run({ outlines: corrected })).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({ planning: expect.objectContaining({ outlines: corrected }) }),
    );
  });
  it('retains alias-only compatibility and identical duplicate values without dropping teaching intent', async () => {
    const { run, createJob } = setup();
    const { description, keyPoints, ...base } = outline;
    expect(
      await run({
        outlines: [{ ...base, brief: description, materialFacts: keyPoints, language: 'Chinese' }],
      }),
    ).not.toHaveProperty('isError');
    expect(
      await run({
        outlines: [
          {
            ...outline,
            brief: description,
            materialFacts: keyPoints,
            languageNote: 'Chinese',
            language: 'Chinese',
          },
        ],
      }),
    ).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledTimes(2);
    for (const call of createJob.mock.calls as unknown[][])
      expect(call[2]).toMatchObject({
        planning: { outlines: [{ ...outline, languageNote: 'Chinese' }] },
      });
  });
  it.each([
    { ...outline, unexpected: 'field' },
    { ...outline, widgetOutline: { apiKey: 'forbidden-placeholder' } },
    { id: 'p1', description: 'Partial update', keyPoints: [] },
  ])('keeps strict outline boundaries after alias diagnosis: %j', async (page) => {
    const { run, createJob } = setup();
    expect(await run({ outlines: [page] })).toMatchObject({
      isError: true,
      details: { code: 'INVALID_OUTLINE' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('enforces the installed lecture-style quiz and slide ratio constraints while preserving guidance', async () => {
    const { run, createJob } = setup({
      resolveSkills: async () => [
        { id: 'stage-design' },
        { id: 'lecture-style', constraints: lectureConstraints },
      ],
    });
    const slides = Array.from({ length: 3 }, (_, index) => ({
      ...outline,
      id: `p${index}`,
      order: index,
    }));
    const skillIds = ['stage-design', 'lecture-style'];
    expect(await run({ outlines: slides, skillIds })).toMatchObject({
      isError: true,
      details: { code: 'SKILL_CONSTRAINT_VIOLATION' },
    });
    expect(
      await run({
        outlines: [...slides, { ...outline, id: 'quiz', order: 3, type: 'quiz' }],
        skillIds,
      }),
    ).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledTimes(1);
  });
  it('accepts the documented three-page lecture mix without increasing the requested page count', async () => {
    const { run, createJob } = setup({
      resolveSkills: async () => [{ id: 'lecture-style', constraints: lectureConstraints }],
    });
    const outlines = ['slide', 'slide', 'quiz'].map((type, order) => ({
      ...outline,
      id: `p${order + 1}`,
      order,
      type,
    }));
    expect(await run({ outlines, skillIds: ['lecture-style'] })).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({ planning: expect.objectContaining({ outlines }) }),
    );
  });
  it('keeps guidance-only skills and page intent in the durable input', async () => {
    const { run, createJob } = setup({ resolveSkills: async () => [{ id: 'stage-design' }] });
    await run({
      outlines: [{ ...outline, description: 'Explain patiently with examples' }],
      skillIds: ['stage-design'],
    });
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({
        planning: expect.objectContaining({
          skillIds: ['stage-design'],
          skillConstraints: [],
          outlines: [expect.objectContaining({ description: 'Explain patiently with examples' })],
        }),
      }),
    );
  });
  it('preserves a user provider binding and the disabled TTS choice', async () => {
    const { run, createJob } = setup({
      mediaConfig: {
        version: 2,
        ttsEnabled: false,
        ttsProviders: [
          {
            source: 'user',
            providerId: 'custom-tts-test',
            modelId: 'speech',
            apiKey: 'private',
            baseUrl: 'https://tts.example.test',
            requiresApiKey: true,
            enabled: true,
          },
        ],
        ttsVoiceDirectory: [
          {
            source: 'user',
            providerId: 'custom-tts-test',
            modelId: 'speech',
            voiceIds: ['voice-one'],
          },
        ],
      },
    });
    expect(
      await run({ agents: [{ ...teacher, voice: 'custom-tts-test::voice-one' }] }),
    ).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({
        tts: { enabled: false },
        agents: {
          mode: 'custom',
          items: [
            {
              ...teacher,
              voiceConfig: {
                source: 'user',
                providerId: 'custom-tts-test',
                modelId: 'speech',
                voiceId: 'voice-one',
              },
            },
          ],
        },
      }),
    );
  });
  it('rejects an unqualified ambiguous voice instead of changing model silently', async () => {
    const { run, createJob } = setup({
      mediaConfig: {
        version: 2,
        ttsEnabled: true,
        ttsProviders: ['first', 'second'].map((modelId) => ({
          source: 'user',
          providerId: 'custom-tts-test',
          modelId,
          apiKey: 'private',
          baseUrl: 'https://tts.example.test',
          requiresApiKey: true,
          enabled: true,
        })),
        ttsVoiceDirectory: ['first', 'second'].map((modelId) => ({
          source: 'user',
          providerId: 'custom-tts-test',
          modelId,
          voiceIds: ['voice-one'],
        })),
      },
    });
    expect(
      await run({ agents: [{ ...teacher, voice: 'custom-tts-test::voice-one' }] }),
    ).toMatchObject({
      isError: true,
    });
    expect(
      await run({ agents: [{ ...teacher, voice: 'custom-tts-test::second::voice-one' }] }),
    ).not.toHaveProperty('isError');
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({
        agents: {
          mode: 'custom',
          items: [
            {
              ...teacher,
              voiceConfig: {
                source: 'user',
                providerId: 'custom-tts-test',
                modelId: 'second',
                voiceId: 'voice-one',
              },
            },
          ],
        },
      }),
    );
  });
  it.each(['user', 'legacy-managed', undefined] as const)(
    'rejects a model-ambiguous voiceConfig for source %s, retaining qualified bindings',
    async (source) => {
      const { run, createJob } = setup({
        mediaConfig: {
          version: 2,
          ttsEnabled: true,
          ttsProviders: ['first', 'second'].map((modelId) => ({
            source,
            providerId: 'custom-tts-test',
            modelId,
            apiKey: 'private',
            baseUrl: 'https://tts.example.test',
            requiresApiKey: true,
            enabled: true,
          })),
          ttsVoiceDirectory: ['first', 'second'].map((modelId) => ({
            source,
            providerId: 'custom-tts-test',
            modelId,
            voiceIds: ['voice-one'],
          })),
        },
      });
      const voiceConfig = {
        ...(source ? { source } : {}),
        providerId: 'custom-tts-test',
        voiceId: 'voice-one',
      };
      const refused = await run({ agents: [{ ...teacher, voiceConfig }] });
      expect(refused).toMatchObject({ isError: true, details: { code: 'INVALID_AGENTS' } });
      expect(refused.content[0].text).toContain('agents[0].voiceConfig.modelId');
      expect(createJob).not.toHaveBeenCalled();
      expect(
        await run({ agents: [{ ...teacher, voiceConfig: { ...voiceConfig, modelId: 'second' } }] }),
      ).not.toHaveProperty('isError');
      expect(createJob).toHaveBeenCalledWith(
        'owner',
        expect.any(String),
        expect.objectContaining({
          agents: {
            mode: 'custom',
            items: [{ ...teacher, voiceConfig: { ...voiceConfig, modelId: 'second' } }],
          },
        }),
      );
    },
  );
  it('aggregates roster and outline errors and retains strict field rejection', async () => {
    const { run, createJob } = setup();
    const result = await run({
      agents: [{ ...teacher, unexpected: true }],
      outlines: [{ ...outline, order: 0.5 }],
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'INVALID_AGENTS' }),
          expect.objectContaining({ code: 'INVALID_OUTLINE' }),
        ]),
      },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('exposes the roster and outline contracts to the model', () => {
    const { submit } = setup();
    const schema = submit.parameters as unknown as {
      properties: Record<string, { items: { properties: Record<string, unknown> } }>;
    };
    expect(schema.properties.agents.items.properties).toHaveProperty('voiceConfig');
    expect(schema.properties.agents.items.properties).toHaveProperty('voice');
    expect(schema.properties.outlines.items.properties).toHaveProperty('brief');
  });
  it('accepts mixed guidance/structural skills, deduplicating without dropping either', async () => {
    const resolveSkills = vi.fn(async () => [
      { id: 'stage-design' },
      { id: 'lecture-style', constraints: { firstSceneType: 'slide' } },
    ]);
    const { run, createJob } = setup({ resolveSkills });
    expect(
      (
        await run({
          outlines: [outline],
          skillIds: ['stage-design', 'lecture-style', 'stage-design'],
        })
      ).isError,
    ).not.toBe(true);
    expect(resolveSkills).toHaveBeenCalledWith(['stage-design', 'lecture-style']);
    expect(createJob).toHaveBeenCalledWith(
      'owner',
      expect.any(String),
      expect.objectContaining({
        planning: expect.objectContaining({
          skillIds: ['stage-design', 'lecture-style'],
          skillConstraints: [{ id: 'lecture-style', constraints: { firstSceneType: 'slide' } }],
        }),
      }),
    );
  });
  it('rejects unknown skills with per-ID diagnostics and never creates a job', async () => {
    const { run, createJob } = setup({ resolveSkills: async () => [{ id: 'stage-design' }] });
    const result = await run({ outlines: [outline], skillIds: ['stage-design', 'foreign'] });
    expect(result.content[0].text).toContain('foreign');
    expect(result).toMatchObject({
      isError: true,
      details: {
        code: 'INVALID_GENERATION_SKILL',
        issues: [expect.objectContaining({ id: 'foreign' })],
      },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('rejects structural violations before submission', async () => {
    const { run, createJob } = setup({
      resolveSkills: async () => [
        { id: 'lecture-style', constraints: { typeMix: [{ type: 'quiz', min: 1 }] } },
      ],
    });
    expect(await run({ outlines: [outline], skillIds: ['lecture-style'] })).toMatchObject({
      isError: true,
      details: { code: 'SKILL_CONSTRAINT_VIOLATION' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('refuses skill IDs without outlines rather than discarding their requirements', async () => {
    const { run, createJob } = setup({ resolveSkills: async () => [{ id: 'stage-design' }] });
    expect(await run({ skillIds: ['stage-design'] })).toMatchObject({
      isError: true,
      details: { code: 'SKILL_PLAN_REQUIRED' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('normalizes a listed platform voice using frozen identity without leaking secrets', async () => {
    const { run, createJob } = setup({ mediaConfig });
    expect(
      (await run({ agents: [{ ...teacher, voice: 'platform::default-tts::female-yujie' }] }))
        .isError,
    ).not.toBe(true);
    const input = (createJob.mock.calls as unknown[][])[0]?.[2];
    expect(input).toMatchObject({
      agents: {
        items: [
          {
            voiceConfig: {
              source: 'platform',
              defaultId: 'default-tts',
              revision: 'rev-one',
              providerId: 'minimax-tts',
              modelId: 'speech-2.8-hd',
              voiceId: 'female-yujie',
            },
          },
        ],
      },
    });
    expect(JSON.stringify(input)).not.toContain('private');
    expect(JSON.stringify(input)).not.toContain('platform::');
  });
  it.each([
    { voice: 'platform::default-tts::unknown' },
    { voice: 'malformed' },
    {
      voice: 'platform::default-tts::female-yujie',
      voiceConfig: {
        source: 'platform',
        defaultId: 'default-tts',
        revision: 'old',
        providerId: 'minimax-tts',
        voiceId: 'female-yujie',
      },
    },
    { voiceConfig: { providerId: 'invented', voiceId: 'invented' } },
  ])('rejects invalid or conflicting voice bindings: %j', async (voice) => {
    const { run, createJob } = setup({ mediaConfig });
    const result = await run({ agents: [{ ...teacher, ...voice }] });
    expect(result.content[0].text).toContain('agents[0].voice');
    expect(result).toMatchObject({
      isError: true,
      details: { code: 'INVALID_AGENTS' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('accepts identical voice and voiceConfig references', async () => {
    const { run, createJob } = setup({ mediaConfig });
    expect(
      (
        await run({
          agents: [
            {
              ...teacher,
              voice: 'platform::default-tts::female-yujie',
              voiceConfig: {
                source: 'platform',
                defaultId: 'default-tts',
                providerId: 'minimax-tts',
                voiceId: 'female-yujie',
              },
            },
          ],
        })
      ).isError,
    ).not.toBe(true);
    expect(createJob).toHaveBeenCalledTimes(1);
  });
  it.each([
    [teacher, { ...teacher, role: 'assistant' }],
    [teacher, { ...teacher, id: 'second' }],
    [{ ...teacher, role: 'assistant' }],
  ])('rejects duplicate IDs and wrong teacher counts', async (...agents) => {
    const { run, createJob } = setup();
    expect(await run({ agents })).toMatchObject({
      isError: true,
      details: { code: 'INVALID_AGENTS' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('reports a bad outline even when a valid roster is supplied', async () => {
    const { run, createJob } = setup();
    expect(await run({ agents: [teacher], outlines: [{ ...outline, order: 1.5 }] })).toMatchObject({
      isError: true,
      details: { code: 'INVALID_OUTLINE' },
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it('keeps no-job observations nonterminal, instructing parameter repair first', async () => {
    const { tools } = setup();
    const result = (await tools
      .find((t) => t.name === 'get_course_generation_status')!
      .execute('status', {} as never, undefined, undefined)) as unknown as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('submit_course_generation');
    expect(
      createProCourseRuntimeBoundary().after('get_course_generation_status', result.isError),
    ).toBeUndefined();
  });
});
