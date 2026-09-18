import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GuidedModeToggle } from '@/components/chat/chat-area';

describe('GuidedModeToggle', () => {
  it('keeps the thumb inside the track in both states, including narrow panels and RTL', async () => {
    const { chromium } = await import('@playwright/test');
    const { compileTailwindCss } = await import('@/tests/helpers/tailwind-css.mjs');
    const css = await compileTailwindCss(
      '@import "tailwindcss" source(none);\n@source "../../components/chat/chat-area.tsx";',
      'e2e/fixtures/guided-toggle.css',
    );
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      for (const direction of ['ltr', 'rtl']) {
        for (const active of [false, true]) {
          const markup = renderToStaticMarkup(
            React.createElement(GuidedModeToggle, {
              enabled: true,
              active,
              disabled: false,
              label: '核查式答疑',
              description: 'Review before publishing',
              onChange: vi.fn(),
            }),
          );
          await page.setContent(
            `<style>${css}</style><div dir="${direction}" style="width:240px">${markup}</div>`,
          );
          const track = await page.getByRole('switch').boundingBox();
          const thumb = await page.getByRole('switch').locator('span').boundingBox();
          expect(track).not.toBeNull();
          expect(thumb).not.toBeNull();
          expect(thumb!.x).toBeGreaterThanOrEqual(track!.x + 1);
          expect(thumb!.x + thumb!.width).toBeLessThanOrEqual(track!.x + track!.width - 1);
        }
      }
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('renders no DOM at all when the deployment flag is disabled', () => {
    expect(
      renderToStaticMarkup(
        React.createElement(GuidedModeToggle, {
          enabled: false,
          active: false,
          disabled: false,
          label: 'Checked tutoring',
          description: 'Review before publishing',
          onChange: vi.fn(),
        }),
      ),
    ).toBe('');
  });

  it('uses a compact accessible switch without taking over the chat panel', () => {
    const markup = renderToStaticMarkup(
      React.createElement(GuidedModeToggle, {
        enabled: true,
        active: true,
        disabled: false,
        label: 'Checked tutoring',
        description: 'Review before publishing',
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-testid="guided-learning-toggle"');
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('Checked tutoring');
    expect(markup).not.toContain('textarea');
  });
});
