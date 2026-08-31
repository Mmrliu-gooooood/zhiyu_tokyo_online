import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';

test.describe('ZHIYU editor workspace', () => {
  test.beforeEach(async ({ page }) => {
    await seedClassroomDatabase(page, {
      ttsEnabled: true,
      ttsProviderId: 'openai-tts',
    });
  });

  test('keeps the existing editor commands reachable inside the ZHIYU shell', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    await page.getByRole('switch', { name: /edit course|编辑课程/i }).click();

    const editor = page.getByTestId('zhiyu-editor-shell');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('slide-nav-rail')).toBeVisible();
    await expect(editor.getByTestId('edit-dock')).toBeVisible();
    await expect(editor.getByRole('button', { name: /undo|撤销/i })).toBeVisible();
    await expect(editor.getByRole('button', { name: /redo|重做/i })).toBeVisible();
    await expect(
      editor.getByRole('button', { name: /preview audio|试听音频/i }).first(),
    ).toBeVisible();
    await expect(editor.getByRole('switch', { name: /done editing|完成编辑/i })).toBeVisible();

    const scenes = editor.getByTestId('scene-item');
    await scenes.nth(1).click();
    await expect(scenes.nth(1)).toHaveAttribute('aria-current', 'page');
  });
});
