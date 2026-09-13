// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  buildInput: vi.fn(),
  createJob: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'zh-CN' }),
}));
vi.mock('@/lib/generation/session-input', () => ({ buildGenerationJobInput: mocks.buildInput }));
vi.mock('@/lib/generation/job-client', async (load) => ({
  ...(await load<typeof import('@/lib/generation/job-client')>()),
  readBackgroundGenerationCapability: async () => ({ enabled: true, available: true }),
  createGenerationJob: mocks.createJob,
}));
vi.mock('@/lib/hooks/use-generation-job', () => ({
  useGenerationJob: () => ({
    job: null,
    error: null,
    cancelling: false,
    cancelError: null,
    cancel: mocks.cancel,
  }),
}));
vi.mock('@/lib/audio/voxcpm-voices', () => ({ useAllVoiceProfiles: () => ({ profiles: [] }) }));
vi.mock('@/lib/hooks/use-scene-generator', () => ({
  fetchSceneActions: vi.fn(),
  fetchSceneContent: vi.fn(),
  generateTTSForScene: vi.fn(),
}));
vi.mock('@/lib/utils/image-storage', () => ({
  cleanupOldImages: async () => {},
  deleteStoredImages: async () => {},
  loadImageMapping: vi.fn(),
  loadDocumentBlob: vi.fn(),
  storeImages: vi.fn(),
}));
vi.mock('@/components/generation/outlines-editor', () => ({ OutlinesEditor: () => null }));
vi.mock('@/components/agent/agent-reveal-modal', () => ({ AgentRevealModal: () => null }));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/app/generation-preview/components/ZhiyuGenerationTopicCards', () => ({
  ZhiyuGenerationTopicCards: () => null,
}));
vi.mock('@/app/generation-preview/components/GenerationExitDialog', () => ({
  GenerationExitDialog: (props: {
    open: boolean;
    cancelError: Error | null;
    onCancelAndReturn: () => void;
  }) =>
    props.open
      ? createElement(
          'div',
          null,
          createElement('button', { onClick: props.onCancelAndReturn }, 'cancel-and-return'),
          props.cancelError?.message,
        )
      : null,
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, className }: { children: ReactNode; className?: string }) =>
      createElement('div', { className }, children),
  },
}));

import { GenerationSessionController } from '@/app/generation-preview/GenerationSessionController';
import { GenerationJobRequestError } from '@/lib/generation/job-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('generation preview submission failures', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    sessionStorage.setItem(
      'generationSession',
      JSON.stringify({
        sessionId: 'preflight-failure',
        requirements: { requirement: 'test course' },
        pdfText: '',
        currentStep: 'generating',
      }),
    );
    mocks.buildInput.mockRejectedValue(new Error('MODEL_CONFIG_UNAVAILABLE'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionStorage.clear();
  });

  it('shows the actual preflight failure instead of preparing/working copy', async () => {
    await act(async () => root.render(createElement(GenerationSessionController)));
    expect(mocks.buildInput).toHaveBeenCalledOnce();
    expect(mocks.createJob).not.toHaveBeenCalled();
    expect(container.textContent).toContain('MODEL_CONFIG_UNAVAILABLE');
    expect(container.querySelector('h1')?.textContent).toBe('generation.statusGenerationFailed');
    expect(container.textContent).not.toContain('generation.aiWorking');
  });

  it('lets cancel-and-return leave when preflight failed before a job was submitted', async () => {
    await act(async () => root.render(createElement(GenerationSessionController)));
    const button = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(text),
      );
    await act(async () => button('generation.backToHome')!.click());
    await act(async () => button('cancel-and-return')!.click());
    expect(mocks.push).toHaveBeenCalledWith('/');
    expect(sessionStorage.getItem('generationSession')).toBeNull();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does not claim cancellation when a submitted job response was lost', async () => {
    mocks.buildInput.mockResolvedValue({ version: 1 });
    mocks.createJob.mockRejectedValue(new Error('connection lost'));
    await act(async () => root.render(createElement(GenerationSessionController)));
    const button = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(text),
      );
    await act(async () => button('generation.backToHome')!.click());
    await act(async () => button('cancel-and-return')!.click());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('generationSession')).not.toBeNull();
    expect(container.textContent).toContain('GENERATION_JOB_SUBMISSION_PENDING');
  });

  it.each([400, 401, 403, 422])(
    'allows cancellation after the first create request is explicitly rejected with %s',
    async (status) => {
      mocks.buildInput.mockResolvedValue({ version: 1 });
      mocks.createJob.mockRejectedValue(new GenerationJobRequestError(status, 'REQUEST_REJECTED'));
      await act(async () => root.render(createElement(GenerationSessionController)));
      expect(mocks.createJob).toHaveBeenCalledOnce();
      const button = (text: string) =>
        Array.from(container.querySelectorAll('button')).find((item) =>
          item.textContent?.includes(text),
        );
      await act(async () => button('generation.backToHome')!.click());
      await act(async () => button('cancel-and-return')!.click());
      expect(mocks.push).toHaveBeenCalledWith('/');
      expect(sessionStorage.getItem('generationSession')).toBeNull();
      expect(mocks.cancel).not.toHaveBeenCalled();
    },
  );

  it.each([404, 409, 500, 503])('preserves recovery after create returns %s', async (status) => {
    mocks.buildInput.mockResolvedValue({ version: 1 });
    mocks.createJob.mockRejectedValue(new GenerationJobRequestError(status, 'REQUEST_UNCONFIRMED'));
    await act(async () => root.render(createElement(GenerationSessionController)));
    const button = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(text),
      );
    await act(async () => button('generation.backToHome')!.click());
    await act(async () => button('cancel-and-return')!.click());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('generationSession')!).backgroundInput).toEqual({
      version: 1,
    });
    expect(container.textContent).toContain('GENERATION_JOB_SUBMISSION_PENDING');
  });

  it('preserves an earlier unknown submission when its recovery request now returns 401', async () => {
    const saved = JSON.parse(sessionStorage.getItem('generationSession')!);
    sessionStorage.setItem(
      'generationSession',
      JSON.stringify({
        ...saved,
        generationBackend: 'server-job',
        backgroundInput: { version: 1 },
      }),
    );
    mocks.createJob.mockRejectedValue(new GenerationJobRequestError(401, 'UNAUTHORIZED'));
    await act(async () => root.render(createElement(GenerationSessionController)));
    expect(mocks.buildInput).not.toHaveBeenCalled();
    const button = (text: string) =>
      Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes(text),
      );
    await act(async () => button('generation.backToHome')!.click());
    await act(async () => button('cancel-and-return')!.click());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('generationSession')!).backgroundInput).toEqual({
      version: 1,
    });
  });
});
