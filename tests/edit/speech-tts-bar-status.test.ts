// @vitest-environment jsdom
/**
 * P3-1: the editor's voiced label must agree with what classroom playback can
 * play. Pro/background narration lives only in the cloud asset pool, so a
 * Dexie-only check wrongly showed "Not voiced" and invited a paid re-voice.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  speechAudioAvailable: vi.fn(),
  resolveLegacySpeechAudioId: vi.fn(),
  regenerateSpeechAudio: vi.fn(),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/audio/regenerate-speech-tts', () => ({
  resolveSpeechAudioId: (_order: number, action: { audioId?: string }) => action.audioId,
  resolveLegacySpeechAudioId: mocks.resolveLegacySpeechAudioId,
  speechAudioAvailable: mocks.speechAudioAvailable,
  regenerateSpeechAudio: mocks.regenerateSpeechAudio,
  audioObjectUrl: vi.fn(async () => null),
  discardSpeechAudio: vi.fn(),
  isManagedTtsActive: () => true,
}));

import { SpeechTtsBar } from '@/components/edit/ActionsBar/ActionsBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveLegacySpeechAudioId.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderBar(props: { audioId?: string; audioUrl?: string }) {
  const onGenerated = vi.fn();
  await act(async () => {
    root.render(
      createElement(SpeechTtsBar, {
        actionId: 'speech-1',
        sceneOrder: 1,
        text: 'Narration',
        onGenerated,
        ...props,
      }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onGenerated, label: () => container.querySelector('span.text-\\[10px\\]')?.textContent };
}

describe('SpeechTtsBar voiced label', () => {
  it('shows a pool-only Pro narration as voiced, without any TTS call', async () => {
    mocks.speechAudioAvailable.mockResolvedValue(true);
    const { label, onGenerated } = await renderBar({ audioId: 'ast_pro_audio' });
    expect(mocks.speechAudioAvailable).toHaveBeenCalledWith('ast_pro_audio');
    expect(label()).toBe('edit.tts.statusReady');
    expect(mocks.regenerateSpeechAudio).not.toHaveBeenCalled();
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('shows a stamped id with no bytes anywhere as missing, not "not voiced"', async () => {
    mocks.speechAudioAvailable.mockResolvedValue(false);
    const { label } = await renderBar({ audioId: 'ast_gone' });
    expect(label()).toBe('edit.tts.statusMissing');
  });

  it('shows unknown, never voiced/not voiced, when the check fails', async () => {
    mocks.speechAudioAvailable.mockRejectedValue(new Error('unknown'));
    const { label } = await renderBar({ audioId: 'ast_unknown' });
    expect(label()).toBe('edit.tts.statusUnknown');
  });

  it('shows checking until the answer arrives', async () => {
    let answer: (value: boolean) => void = () => undefined;
    mocks.speechAudioAvailable.mockReturnValue(
      new Promise<boolean>((resolve) => (answer = resolve)),
    );
    const { label } = await renderBar({ audioId: 'ast_slow' });
    expect(label()).toBe('edit.tts.statusChecking');
    await act(async () => answer(true));
    expect(label()).toBe('edit.tts.statusReady');
  });

  it('keeps a line with no audio reference as not voiced', async () => {
    const { label } = await renderBar({});
    expect(label()).toBe('edit.tts.statusNone');
    expect(mocks.speechAudioAvailable).not.toHaveBeenCalled();
  });

  it('keeps legacy Dexie-only rows voiced', async () => {
    mocks.resolveLegacySpeechAudioId.mockResolvedValue('tts_s1_speech-1');
    mocks.speechAudioAvailable.mockResolvedValue(true);
    const { label } = await renderBar({});
    expect(mocks.speechAudioAvailable).toHaveBeenCalledWith('tts_s1_speech-1');
    expect(label()).toBe('edit.tts.statusReady');
  });

  it('treats an unconverted legacy URL as voiced without probing', async () => {
    const { label } = await renderBar({ audioUrl: 'https://cdn.example/a.mp3' });
    expect(label()).toBe('edit.tts.statusReady');
    expect(mocks.speechAudioAvailable).not.toHaveBeenCalled();
  });
});
