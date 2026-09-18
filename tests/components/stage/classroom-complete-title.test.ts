import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ClassroomCompletePage } from '@/components/scene-renderers/classroom-complete';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: () => '课程完成', locale: 'zh-CN' }),
}));

describe('completion title layout', () => {
  it('bounds long Chinese instructions and unbroken text to two lines while retaining the full title', async () => {
    const { chromium } = await import('@playwright/test');
    const { compileTailwindCss } = await import('@/tests/helpers/tailwind-css.mjs');
    const css = await compileTailwindCss(
      '@import "tailwindcss" source(none);\n@source "../../components/scene-renderers/classroom-complete.tsx";',
      'e2e/fixtures/complete-title.css',
    );
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 540, height: 720 } });
      for (const title of [
        '二元一次方程组',
        '为高中学生设计一节《师说》讲授型大师课，核心学习目标有两条。'.repeat(8),
        'LongCourseTitle'.repeat(50),
        '',
      ]) {
        const markup = renderToStaticMarkup(
          createElement(ClassroomCompletePage, { title, scenes: [] }),
        );
        await page.setContent(`<style>${css}</style>${markup}`);
        const heading = page.getByRole('heading');
        expect(await heading.textContent()).toBe(title || '课程完成');
        const dimensions = await heading.evaluate((element) => ({
          height: element.clientHeight,
          lineHeight: parseFloat(getComputedStyle(element).lineHeight),
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }));
        expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight * 2 + 1);
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
