import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  mediaPut: vi.fn(),
  mediaDelete: vi.fn(),
  serverBacked: vi.fn(),
  poolPut: vi.fn(),
  stageState: vi.fn(),
}));

vi.mock('@/lib/media/asset-pool', () => ({
  isAssetPoolServerBacked: mocks.serverBacked,
  putAsset: mocks.poolPut,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.stageState },
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: {
    mediaFiles: {
      put: mocks.mediaPut,
      delete: mocks.mediaDelete,
    },
  },
}));

import {
  generateMediaForOutlines,
  mediaRetryTarget,
  retryMediaTask,
} from '@/lib/media/media-orchestrator';
import { resetProxyMediaFailureCache } from '@/lib/media/proxy-media-cache';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';
import type { SceneOutline } from '@/lib/types/generation';

const stageId = 'classic-stage';
const imageRef = 'gen_img_classic';
const videoRef = 'gen_vid_classic';

function outlineWith(
  ...mediaGenerations: NonNullable<SceneOutline['mediaGenerations']>
): SceneOutline {
  return {
    id: 'outline-1',
    type: 'slide',
    title: 'Classic scene',
    description: 'Classic scene',
    keyPoints: ['media'],
    order: 1,
    mediaGenerations,
  };
}

function failedTask(ref: string, type: 'image' | 'video' = 'image'): MediaTask {
  return {
    elementId: ref,
    type,
    status: 'failed',
    prompt: 'Retry media',
    params: { aspectRatio: '16:9' },
    error: 'retry me',
    retryCount: 0,
    stageId,
  };
}

describe('classic media orchestrator', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let objectUrls: Map<string, Blob>;

  beforeEach(() => {
    resetProxyMediaFailureCache();
    mocks.mediaPut.mockReset().mockResolvedValue(undefined);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.serverBacked.mockReset().mockReturnValue(false);
    mocks.poolPut.mockReset().mockResolvedValue('ast_generated_image');
    mocks.stageState.mockReset();
    mocks.settings.mockReset().mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'image-provider',
      imageModelId: 'image-model',
      imageProvidersConfig: {},
      videoProviderId: 'video-provider',
      videoModelId: 'video-model',
      videoProvidersConfig: {},
    });
    useMediaGenerationStore.setState({ tasks: {} });

    objectUrls = new Map();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:classic-${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    resetProxyMediaFailureCache();
    vi.unstubAllGlobals();
  });

  function serveImage(bytes = 'classic-image'): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/generate/image') {
        return new Response(
          JSON.stringify({ success: true, result: { url: 'https://media.test/image' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        return new Response(new Blob([bytes], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  function serveVideo(): void {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/video') {
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              url: 'https://media.test/video',
              poster: 'https://media.test/poster',
              width: 1280,
              height: 720,
              duration: 5,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        const requested = JSON.parse(String(init?.body)) as { url: string };
        return requested.url.endsWith('/poster')
          ? new Response(new Blob(['classic-poster'], { type: 'image/jpeg' }), { status: 200 })
          : new Response(new Blob(['classic-video'], { type: 'video/mp4' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
  }

  it('stores generated image bytes under the original placeholder without allocating an asset id', async () => {
    serveImage();

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'A diagram', elementId: imageRef })],
      stageId,
    );

    expect(mocks.mediaPut).toHaveBeenCalledTimes(1);
    const row = mocks.mediaPut.mock.calls[0]![0] as {
      id: string;
      stageId: string;
      blob: Blob;
      placeholderRef?: string;
    };
    expect(row.id).toBe(`${stageId}:${imageRef}`);
    expect(row.stageId).toBe(stageId);
    expect(row.placeholderRef).toBeUndefined();
    await expect(row.blob.text()).resolves.toBe('classic-image');

    const generationInit = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/generate/image',
    )?.[1] as RequestInit | undefined;
    expect(new Headers(generationInit?.headers).get('x-generation-root-stage-id')).toBe(stageId);
    expect(new Headers(generationInit?.headers).get('x-generation-root-session-id')).toBeTruthy();

    const tasks = useMediaGenerationStore.getState().tasks;
    expect(Object.keys(tasks)).toEqual([imageRef]);
    expect(tasks[imageRef]).toMatchObject({
      elementId: imageRef,
      status: 'done',
      objectUrl: 'blob:classic-1',
    });
  });

  it('stores video and poster bytes in one placeholder-keyed classic row', async () => {
    serveVideo();

    await generateMediaForOutlines(
      [outlineWith({ type: 'video', prompt: 'A clip', elementId: videoRef })],
      stageId,
    );

    expect(mocks.mediaPut).toHaveBeenCalledTimes(1);
    const row = mocks.mediaPut.mock.calls[0]![0] as { id: string; blob: Blob; poster?: Blob };
    expect(row.id).toBe(`${stageId}:${videoRef}`);
    await expect(row.blob.text()).resolves.toBe('classic-video');
    await expect(row.poster?.text()).resolves.toBe('classic-poster');
    expect(useMediaGenerationStore.getState().tasks[videoRef]).toMatchObject({
      elementId: videoRef,
      status: 'done',
      objectUrl: 'blob:classic-1',
      poster: 'blob:classic-2',
    });
  });

  it('keeps a hosted result as classic row metadata without downloading or allocating it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { url: '', ossUrl: 'https://cdn.test/generated.png' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Hosted', elementId: imageRef })],
      stageId,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${stageId}:${imageRef}`,
        ossKey: 'https://cdn.test/generated.png',
        size: 0,
      }),
    );
    expect(useMediaGenerationStore.getState().tasks[imageRef]?.objectUrl).toBe(
      'https://cdn.test/generated.png',
    );
  });

  it('processes API-limited media requests serially', async () => {
    const events: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/image') {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        events.push(`generate:${body.prompt}`);
        return new Response(
          JSON.stringify({
            success: true,
            result: { url: `https://media.test/${body.prompt}` },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input) === '/api/proxy-media') {
        const body = JSON.parse(String(init?.body)) as { url: string };
        events.push(`proxy:${body.url.split('/').at(-1)}`);
        return new Response(new Blob([body.url], { type: 'image/png' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    await generateMediaForOutlines(
      [
        outlineWith(
          { type: 'image', prompt: 'first', elementId: 'gen_img_first' },
          { type: 'image', prompt: 'second', elementId: 'gen_img_second' },
        ),
      ],
      stageId,
    );

    expect(events).toEqual(['generate:first', 'proxy:first', 'generate:second', 'proxy:second']);
  });

  it('binds a selected custom provider configuration to the generation request', async () => {
    mocks.settings.mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'custom-image-gateway',
      imageModelId: 'vendor/image-v2',
      imageProvidersConfig: {
        'custom-image-gateway': {
          apiKey: 'image-secret',
          baseUrl: 'https://gateway.test/team/v1',
          enabled: true,
          protocol: 'openai-images',
          requiresApiKey: true,
        },
      },
      videoProviderId: 'custom-video-gateway',
      videoModelId: 'vendor/video-v1',
      videoProvidersConfig: {
        'custom-video-gateway': {
          apiKey: 'video-secret',
          baseUrl: 'https://gateway.test/team/api/v1',
          enabled: true,
          protocol: 'openrouter-video',
          requiresApiKey: true,
        },
      },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/generate/image') {
        const body = JSON.parse(String(init?.body));
        expect(body.providerConfig).toEqual({
          id: 'custom-image-gateway',
          protocol: 'openai-images',
          apiKey: 'image-secret',
          baseUrl: 'https://gateway.test/team/v1',
          enabled: true,
          requiresApiKey: true,
          modelId: 'vendor/image-v2',
        });
        return new Response(
          JSON.stringify({ success: true, result: { base64: 'aW1hZ2U=', mimeType: 'image/webp' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(input).startsWith('data:image/webp;base64,')) {
        return new Response(new Blob(['image'], { type: 'image/webp' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Custom gateway', elementId: imageRef })],
      stageId,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate/image',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${imageRef}` }),
    );
  });

  it('skips already completed, permanently failed, and disabled requests', async () => {
    useMediaGenerationStore.setState({
      tasks: {
        done: { ...failedTask('done'), status: 'done', objectUrl: 'blob:done', error: undefined },
        failed: failedTask('failed'),
      },
    });
    mocks.settings.mockReturnValue({
      ...mocks.settings(),
      videoGenerationEnabled: false,
    });

    await generateMediaForOutlines(
      [
        outlineWith(
          { type: 'image', prompt: 'done', elementId: 'done' },
          { type: 'image', prompt: 'failed', elementId: 'failed' },
          { type: 'video', prompt: 'disabled', elementId: 'disabled' },
        ),
      ],
      stageId,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.mediaPut).not.toHaveBeenCalled();
  });

  it('retries a failed placeholder by deleting and replacing its classic row', async () => {
    useMediaGenerationStore.setState({ tasks: { [imageRef]: failedTask(imageRef) } });
    serveImage('retried-image');

    await retryMediaTask(imageRef, {
      elementId: 'image-element',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });

    expect(mocks.mediaDelete).toHaveBeenCalledWith(`${stageId}:${imageRef}`);
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: `${stageId}:${imageRef}` }),
    );
    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'done',
      retryCount: 1,
    });
    const retryInit = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/generate/image',
    )?.[1] as RequestInit | undefined;
    expect(new Headers(retryInit?.headers).has('x-generation-root-stage-id')).toBe(false);
  });

  it('persists structured terminal errors under the placeholder for reload', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Sensitive content', errorCode: 'CONTENT_SENSITIVE' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Blocked', elementId: imageRef })],
      stageId,
    );

    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      errorCode: 'CONTENT_SENSITIVE',
    });
    expect(mocks.mediaPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${stageId}:${imageRef}`,
        errorCode: 'CONTENT_SENSITIVE',
        size: 0,
      }),
    );
  });

  it('keeps transient failures in memory without writing an empty durable row', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Retry later', elementId: imageRef })],
      stageId,
    );

    expect(useMediaGenerationStore.getState().tasks[imageRef]).toMatchObject({
      status: 'failed',
      error: 'network unavailable',
    });
    expect(mocks.mediaPut).not.toHaveBeenCalled();
  });

  it('sends platform image intent without the same-provider user credentials', async () => {
    mocks.settings.mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: false,
      imageSelection: { source: 'platform', defaultId: 'zhiyu-default-image' },
      imageProviderId: 'minimax-image',
      imageModelId: 'must-not-leak-model',
      imageProvidersConfig: {
        'minimax-image': {
          apiKey: 'must-not-leak-key',
          baseUrl: 'https://must-not-leak.example.com',
        },
      },
      videoProviderId: '',
      videoModelId: '',
      videoProvidersConfig: {},
    });
    serveImage();

    await generateMediaForOutlines(
      [outlineWith({ type: 'image', prompt: 'Platform image', elementId: imageRef })],
      stageId,
    );

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'x-model-source': 'platform',
      'x-platform-default-id': 'zhiyu-default-image',
      'x-image-provider': '',
      'x-image-model': '',
      'x-api-key': '',
      'x-base-url': '',
    });
    expect(JSON.stringify(init)).not.toContain('must-not-leak');
  });

  it('stores hosted media in the asset pool, saves its document ref, and skips regeneration on reload', async () => {
    mocks.serverBacked.mockReturnValue(true);
    const outline = outlineWith({ type: 'image', prompt: 'Quartered circle', elementId: imageRef });
    const scene = {
      id: 'scene-1',
      stageId,
      type: 'slide',
      title: 'Quartered circle',
      order: 1,
      content: {
        type: 'slide',
        canvas: { id: 'slide-1', elements: [{ id: 'image-1', type: 'image', src: imageRef }] },
      },
    };
    const state: {
      stage: { id: string };
      scenes: typeof scene[];
      outlines: SceneOutline[];
      setOutlines: (next: SceneOutline[]) => void;
      updateScene: (id: string, patch: { content: typeof scene.content }) => void;
      saveToStorage: ReturnType<typeof vi.fn>;
    } = {
      stage: { id: stageId },
      scenes: [scene],
      outlines: [outline],
      setOutlines(next) { state.outlines = next; },
      updateScene(_id: string, patch: { content: typeof scene.content }) {
        state.scenes = [{ ...state.scenes[0], content: patch.content }];
      },
      saveToStorage: vi.fn().mockResolvedValue(true),
    };
    mocks.stageState.mockReturnValue(state);
    serveImage();

    await generateMediaForOutlines([outline], stageId);

    expect(mocks.poolPut).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
      { contentType: 'image/png' },
    );
    expect(state.scenes[0].content.canvas.elements[0].src).toBe('ast_generated_image');
    expect(state.outlines[0].mediaGenerations?.[0]?.elementId).toBe('ast_generated_image');
    expect(state.saveToStorage).toHaveBeenCalledOnce();
    expect(useMediaGenerationStore.getState().tasks.ast_generated_image?.placeholderRef).toBe(imageRef);

    const imageCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/generate/image');
    await generateMediaForOutlines(state.outlines, stageId);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/generate/image')).toHaveLength(imageCalls.length);
  });

  it('retains renderer retry targeting as a read-side compatibility seam', () => {
    expect(mediaRetryTarget('image-element', 'scene-1', { canvas: { id: 'slide-1' } })).toEqual({
      elementId: 'image-element',
      sceneId: 'scene-1',
      slideId: 'slide-1',
    });
  });
});
