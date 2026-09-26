import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StageMetaView } from '@/lib/classroom/stage-meta-client';
import {
  compensateForegroundCompletion,
  needsForegroundCompletionCompensation,
  resetForegroundCompletionCompensationForTests,
  type CompensationStageState,
} from '@/lib/generation/foreground-completion-compensation';
import { ForegroundCompletionError } from '@/lib/generation/foreground-root-client';

const STAGE = 'stage-1';

function meta(overrides: Partial<StageMetaView> = {}): StageMetaView {
  return {
    isOwner: true,
    isPublic: false,
    publishedAt: null,
    generationComplete: false,
    source: 'document',
    ...overrides,
  };
}

function state(overrides: Partial<CompensationStageState> = {}): CompensationStageState {
  return { stageId: STAGE, generationComplete: true, outlineProducer: 'client', ...overrides };
}

const noSession = () => false;
const withSession = () => true;

beforeEach(() => resetForegroundCompletionCompensationForTests());

describe('reopen compensation eligibility', () => {
  it('repairs a complete owner course whose mirror is still false', () => {
    expect(needsForegroundCompletionCompensation(STAGE, meta(), state(), noSession)).toBe(true);
  });

  it('repairs "marked but not released" when this tab still holds the session', () => {
    expect(
      needsForegroundCompletionCompensation(
        STAGE,
        meta({ generationComplete: true }),
        state(),
        withSession,
      ),
    ).toBe(true);
  });

  it('leaves a consistent course alone', () => {
    expect(
      needsForegroundCompletionCompensation(
        STAGE,
        meta({ generationComplete: true }),
        state(),
        noSession,
      ),
    ).toBe(false);
  });

  it.each<[string, StageMetaView, CompensationStageState]>([
    ['a visitor', meta({ isOwner: false }), state()],
    ['an unfinished course', meta(), state({ generationComplete: false })],
    ['a Pro/PPTX server-job course', meta(), state({ outlineProducer: 'server-job' })],
    ['a different loaded stage', meta(), state({ stageId: 'other' })],
  ])('skips %s', (_label, viewerMeta, stageState) => {
    expect(needsForegroundCompletionCompensation(STAGE, viewerMeta, stageState, withSession)).toBe(
      false,
    );
  });
});

describe('compensateForegroundCompletion', () => {
  const deps = (overrides: Partial<Parameters<typeof compensateForegroundCompletion>[3]> = {}) => ({
    persistenceEnabled: () => true,
    awaitSelfHealSave: async () => true,
    complete: vi.fn(async () => undefined),
    hasPendingSession: noSession,
    ...overrides,
  });

  it('sends one request per course per page lifetime', async () => {
    const d = deps();
    await expect(compensateForegroundCompletion(STAGE, meta(), () => state(), d)).resolves.toBe(
      true,
    );
    await expect(compensateForegroundCompletion(STAGE, meta(), () => state(), d)).resolves.toBe(
      false,
    );
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it('treats 404/403 as final and stays silent', async () => {
    const d = deps({
      complete: vi.fn(async () => {
        throw new ForegroundCompletionError(404, true);
      }),
    });
    await expect(compensateForegroundCompletion(STAGE, meta(), () => state(), d)).resolves.toBe(
      true,
    );
    await compensateForegroundCompletion(STAGE, meta(), () => state(), d);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it('does nothing without browser persistence', async () => {
    const d = deps({ persistenceEnabled: () => false });
    await compensateForegroundCompletion(STAGE, meta(), () => state(), d);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it('waits for the self-heal save and skips when it failed', async () => {
    const d = deps({ awaitSelfHealSave: async () => false });
    await compensateForegroundCompletion(STAGE, meta(), () => state(), d);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it('re-checks after waiting, in case the user navigated to another course', async () => {
    let current = state();
    const d = deps({
      awaitSelfHealSave: async () => {
        current = state({ stageId: 'other' });
        return true;
      },
    });
    await compensateForegroundCompletion(STAGE, meta(), () => current, d);
    expect(d.complete).not.toHaveBeenCalled();
  });
});
