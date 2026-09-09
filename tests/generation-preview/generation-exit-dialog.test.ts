// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationExitDialog } from '@/app/generation-preview/components/GenerationExitDialog';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'generation.exitDialogTitle': '返回首页？',
        'generation.exitDialogDesc':
          '后台任务不会因刷新、关闭标签页或返回首页而停止。取消后会保留已经完成的页面，但不能从取消处续跑。',
        'generation.exitContinueInBackground': '后台继续并返回',
        'generation.exitCancelAndReturn': '取消生成并返回',
        'generation.exitStay': '留在此页',
        'generation.exitCancellingTitle': '正在取消',
        'generation.exitCancelling': '正在取消…',
        'generation.exitCancelFailed': '取消尚未确认，请重试或留在此页查看状态。',
      })[key] ?? key,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GenerationExitDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers the three confirmed return-home choices', async () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    const onStay = vi.fn();
    await act(async () =>
      root.render(
        createElement(GenerationExitDialog, {
          open: true,
          cancelling: false,
          cancelError: null,
          onContinueInBackground: onContinue,
          onCancelAndReturn: onCancel,
          onStay,
        }),
      ),
    );
    const button = (label: string) =>
      Array.from(document.body.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label,
      );

    expect(button('后台继续并返回')).toBeTruthy();
    expect(button('取消生成并返回')).toBeTruthy();
    expect(button('留在此页')).toBeTruthy();
    act(() => button('后台继续并返回')?.click());
    act(() => button('取消生成并返回')?.click());
    act(() => button('留在此页')?.click());
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onStay).toHaveBeenCalledOnce();
  });

  it('keeps the dialog actionable when cancellation is not confirmed', async () => {
    await act(async () =>
      root.render(
        createElement(GenerationExitDialog, {
          open: true,
          cancelling: true,
          cancelError: new Error('network'),
          onContinueInBackground: vi.fn(),
          onCancelAndReturn: vi.fn(),
          onStay: vi.fn(),
        }),
      ),
    );

    expect(document.body.textContent).toContain('正在取消');
    expect(document.body.textContent).toContain('取消尚未确认，请重试或留在此页查看状态。');
    expect(
      Array.from(document.body.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === '正在取消…',
      )?.disabled,
    ).toBe(true);
  });
});
