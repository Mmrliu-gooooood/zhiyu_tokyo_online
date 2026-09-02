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

  test('keeps hosted editor commands reachable after Pro routes to Workspace', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    await page.getByRole('switch', { name: /edit course|编辑课程/i }).click();
    await page.waitForURL(new RegExp(`/workspace\\?course=${ZHIYU_CLASSROOM_STAGE_ID}`));

    await expect(page.getByTestId('zhiyu-workspace-shell')).toBeVisible();
    await expect(page.getByTestId('workbench-editor-header')).toBeVisible();
    await expect(page.getByTestId('workbench-start-learning')).toBeVisible();
    const editor = page.getByTestId('zhiyu-editor-shell');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('slide-nav-rail')).toBeVisible();
    await expect(editor.getByTestId('edit-dock')).toBeVisible();
    await expect(editor.getByRole('button', { name: /narration script|旁白脚本/i })).toBeVisible();
    await expect(
      editor.getByRole('button', { name: /add action|添加动作/i }).first(),
    ).toBeVisible();
    // The workbench owns course scope and Pro mode, so the standalone command
    // bar and its mode switch are deliberately not duplicated inside the pane.
    await expect(editor.getByRole('button', { name: /undo|撤销/i })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: /redo|重做/i })).toHaveCount(0);
    await expect(editor.getByRole('switch', { name: /done editing|完成编辑/i })).toHaveCount(0);

    const scenes = editor.getByTestId('scene-item');
    await scenes.nth(1).click();
    await expect(scenes.nth(1)).toHaveAttribute('aria-current', 'page');
  });
});
