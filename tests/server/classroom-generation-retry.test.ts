import { beforeEach, describe, expect, it, vi } from 'vitest';
import { containPBLGenerationError, generateClassroom } from '@/lib/server/classroom-generation';
import type { MediaConfigSnapshotContent } from '@/lib/server/media-config-snapshots';

const mocks = vi.hoisted(() => ({
  resolveParamsBinding: vi.fn(),
  generateSceneOutlinesFromRequirements: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  createSceneWithActions: vi.fn(),
  persistClassroom: vi.fn(),
  complete: vi.fn(),
  generateMediaForClassroom: vi.fn(),
  replaceMediaPlaceholders: vi.fn(),
  generateTTSForClassroom: vi.fn(),
}));
const PBLGenerationErrorMock = vi.hoisted(
  () =>
    class PBLGenerationError extends Error {
      readonly statusCode?: number;

      constructor(message: string, options?: { statusCode?: number }) {
        super(message);
        this.name = 'PBLGenerationError';
        this.statusCode = options?.statusCode;
      }
    },
);

vi.mock('@/lib/model-gateway', async (importOriginal) =>
  (await import('@/tests/helpers/model-gateway-mock')).mockGatewayModule(await importOriginal(), {
    complete: mocks.complete,
    resolveParamsBinding: mocks.resolveParamsBinding,
  }),
);

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneOutlinesFromRequirements: mocks.generateSceneOutlinesFromRequirements,
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  PBLGenerationError: PBLGenerationErrorMock,
}));

vi.mock('@/lib/server/scene-generation', () => ({
  createSceneWithActions: mocks.createSceneWithActions,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  persistClassroom: mocks.persistClassroom,
}));

vi.mock('@/lib/server/classroom-media-generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-media-generation')>()),
  generateMediaForClassroom: mocks.generateMediaForClassroom,
  replaceMediaPlaceholders: mocks.replaceMediaPlaceholders,
  generateTTSForClassroom: mocks.generateTTSForClassroom,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Basics',
  description: 'Explain retries',
  keyPoints: ['Retry transient failures'],
  order: 1,
} as const;

const slideContent = {
  elements: [],
  remark: 'Retry transient failures',
};

async function generateWithProgress() {
  const progress: Array<{ message: string }> = [];
  const result = await generateClassroom(
    { requirement: 'Teach retry basics' },
    {
      baseUrl: 'http://localhost',
      onProgress: (event) => {
        progress.push({ message: event.message });
      },
    },
  );
  return { result, progress };
}

describe('classroom scene generation retries', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveParamsBinding.mockResolvedValue({
      modelString: 'test:model',
      providerId: 'test',
      credentialReady: true,
    });
    mocks.complete.mockResolvedValue({ text: 'ok' });
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: {
        languageDirective: 'Use English.',
        outlines: [outline],
      },
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.createSceneWithActions.mockImplementation((sceneOutline, content, actions, api) => {
      const sceneResult = api.scene.create({
        type: sceneOutline.type,
        title: sceneOutline.title,
        order: sceneOutline.order,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: content.elements,
          },
        },
        actions,
      });
      return sceneResult.success ? (sceneResult.data ?? null) : null;
    });
    mocks.persistClassroom.mockImplementation(async ({ id, scenes }) => ({
      id,
      url: `http://localhost/classroom/${id}`,
      scenesCount: scenes.length,
      createdAt: '2026-06-22T00:00:00.000Z',
    }));
    mocks.generateMediaForClassroom.mockResolvedValue({});
    mocks.generateTTSForClassroom.mockResolvedValue(undefined);
  });

  it('retries an empty scene content result before skipping the scene', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateSceneContent.mockResolvedValueOnce(null).mockResolvedValueOnce(slideContent);

      const generation = generateWithProgress();
      await vi.runAllTimersAsync();
      const { result, progress } = await generation;

      expect(result.scenesCount).toBe(1);
      expect(mocks.generateSceneContent).toHaveBeenCalledTimes(2);
      expect(progress.some((event) => event.message.includes('Retrying scene 1/1 content'))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards classroom thinking config to scene retry LLM calls', async () => {
    const thinkingConfig = { enabled: true, effort: 'high' };
    const binding = {
      modelString: 'test:model',
      providerId: 'test',
      credentialReady: true,
      thinking: thinkingConfig,
    };
    mocks.resolveParamsBinding.mockResolvedValue(binding);
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return slideContent;
    });

    await generateWithProgress();

    // The classroom binding (with its thinking config) reaches the scene call.
    expect(mocks.complete).toHaveBeenCalledWith(binding, expect.anything(), {
      source: 'generate-classroom-scene',
      retry: 'none',
    });
  });

  it('forwards the owner-loaded media snapshot selections to legacy classroom media calls', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    const mediaConfig: MediaConfigSnapshotContent = {
      version: 3,
      imageEnabled: true,
      videoEnabled: true,
      ttsEnabled: true,
      image: {
        source: 'platform',
        defaultId: 'zhiyu-default-image',
        revision: 'image-r1',
      },
      video: {
        source: 'user',
        providerId: 'minimax-video',
        modelId: 'owner-video',
        apiKey: 'owner-video-key',
        baseUrl: 'https://owner-video.example',
        enabled: true,
        requiresApiKey: true,
      },
      ttsProviders: [
        {
          source: 'user',
          providerId: 'minimax-tts',
          modelId: 'owner-tts',
          apiKey: 'owner-tts-key',
          baseUrl: 'https://owner-tts.example',
          enabled: true,
          requiresApiKey: true,
        },
      ],
      ttsDefault: {
        source: 'user',
        providerId: 'minimax-tts',
        modelId: 'owner-tts',
        voiceId: 'female-yujie',
        speed: 1,
      },
      ttsVoiceDirectory: [
        {
          source: 'user',
          providerId: 'minimax-tts',
          modelId: 'owner-tts',
          voiceIds: ['female-yujie'],
        },
      ],
    };

    await generateClassroom(
      {
        requirement: 'Teach retry basics',
        enableImageGeneration: true,
        enableVideoGeneration: true,
        enableTTS: true,
        mediaConfig,
      },
      { baseUrl: 'http://localhost' },
    );

    expect(mocks.generateMediaForClassroom).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      'http://localhost',
      {
        image: {
          source: 'platform',
          defaultId: 'zhiyu-default-image',
          revision: 'image-r1',
        },
        video: {
          source: 'user',
          providerId: 'minimax-video',
          modelId: 'owner-video',
          apiKey: 'owner-video-key',
          baseUrl: 'https://owner-video.example',
        },
        tts: {
          source: 'user',
          providerId: 'minimax-tts',
          modelId: 'owner-tts',
          apiKey: 'owner-tts-key',
          baseUrl: 'https://owner-tts.example',
          voiceId: 'female-yujie',
        },
      },
    );
    expect(mocks.generateTTSForClassroom).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      'http://localhost',
      expect.objectContaining({ source: 'user', apiKey: 'owner-tts-key' }),
    );
  });

  it('retries retryable action generation errors', async () => {
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
      .mockResolvedValueOnce([]);

    const { result, progress } = await generateWithProgress();

    expect(result.scenesCount).toBe(1);
    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(2);
    expect(progress.some((event) => event.message.includes('Retrying scene 1/1 actions'))).toBe(
      true,
    );
  });

  it('does not retry non-retryable action generation errors', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    mocks.generateSceneContent.mockResolvedValue(slideContent);
    mocks.generateSceneActions.mockRejectedValue(unauthorized);

    await expect(generateWithProgress()).rejects.toBe(unauthorized);

    expect(mocks.generateSceneActions).toHaveBeenCalledTimes(1);
  });

  it('converts only PBLGenerationError to a null scene result', async () => {
    expect(
      containPBLGenerationError(
        new PBLGenerationErrorMock('both planners failed'),
        'Failed PBL scene',
      ),
    ).toBeNull();

    const unrelated = new Error('unrelated failure');
    expect(() => containPBLGenerationError(unrelated, 'Other scene')).toThrow(unrelated);
  });

  it('does not retry a status-less PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('both planners failed');
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(2);
    expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
    expect(pblCalls).toHaveLength(1);
  });

  it('does not retry a 401 PBL failure and completes surrounding slides', async () => {
    const outlines = [
      { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
      {
        ...outline,
        id: 'outline-pbl',
        type: 'pbl' as const,
        title: 'Practice project',
        order: 1,
        pblConfig: {
          projectTopic: 'Retries',
          projectDescription: 'Practice resilient generation',
          targetSkills: ['Retry handling'],
        },
      },
      { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
    ];
    mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
      success: true,
      data: { languageDirective: 'Use English.', outlines },
    });
    mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
      if (sceneOutline.type === 'pbl') {
        throw new PBLGenerationErrorMock('provider key rejected', { statusCode: 401 });
      }
      return slideContent;
    });

    const { result } = await generateWithProgress();
    const pblCalls = mocks.generateSceneContent.mock.calls.filter(
      ([sceneOutline]) => sceneOutline.type === 'pbl',
    );

    expect(result.scenesCount).toBe(2);
    expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
    expect(pblCalls).toHaveLength(1);
  });

  it('retries a 429 PBL failure before skipping it and completing surrounding slides', async () => {
    vi.useFakeTimers();
    try {
      const outlines = [
        { ...outline, id: 'outline-slide-1', title: 'Opening slide', order: 0 },
        {
          ...outline,
          id: 'outline-pbl',
          type: 'pbl' as const,
          title: 'Practice project',
          order: 1,
          pblConfig: {
            projectTopic: 'Retries',
            projectDescription: 'Practice resilient generation',
            targetSkills: ['Retry handling'],
          },
        },
        { ...outline, id: 'outline-slide-2', title: 'Closing slide', order: 2 },
      ];
      mocks.generateSceneOutlinesFromRequirements.mockResolvedValue({
        success: true,
        data: { languageDirective: 'Use English.', outlines },
      });
      mocks.generateSceneContent.mockImplementation(async (sceneOutline) => {
        if (sceneOutline.type === 'pbl') {
          throw new PBLGenerationErrorMock('provider rate limited', { statusCode: 429 });
        }
        return slideContent;
      });

      const generation = generateWithProgress();
      await vi.runAllTimersAsync();
      const { result } = await generation;
      const pblCalls = mocks.generateSceneContent.mock.calls.filter(
        ([sceneOutline]) => sceneOutline.type === 'pbl',
      );

      expect(result.scenesCount).toBe(2);
      expect(result.scenes.map((scene) => scene.title)).toEqual(['Opening slide', 'Closing slide']);
      expect(pblCalls).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
