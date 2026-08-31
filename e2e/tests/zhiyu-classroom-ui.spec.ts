import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedClassroomDatabase, ZHIYU_CLASSROOM_STAGE_ID } from '../fixtures/zhiyu-classroom';

test.describe('ZHIYU classroom workspace', () => {
  test.beforeEach(async ({ page }) => {
    await seedClassroomDatabase(page);
  });

  test('renders the classroom workspace regions and current scene state', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
    await expect(page.getByTestId('zhiyu-scene-rail')).toBeVisible();
    await expect(page.getByTestId('zhiyu-learning-stage')).toBeVisible();
    await expect(page.getByTestId('zhiyu-interaction-panel')).toBeVisible();
    await expect(page.getByTestId('zhiyu-playback-bar')).toBeVisible();

    const rail = page.getByTestId('zhiyu-scene-rail');
    await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);
  });

  test('keeps guarded scene navigation and playback controls reachable', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    await classroom.clickScene(1);
    await expect(page.getByTestId('scene-item').nth(1)).toHaveAttribute('aria-current', 'page');

    const bar = page.getByTestId('zhiyu-playback-bar');
    const play = bar.getByRole('button', { name: /play|播放/i });
    await expect(play).toBeVisible();
    await play.click();
    await expect(bar.getByRole('button', { name: /pause|暂停/i })).toBeVisible();
    await expect(page.getByTestId('zhiyu-interaction-panel')).toBeVisible();
    await expect(page.getByRole('switch', { name: /edit course|编辑课程/i })).toBeVisible();
  });

  test('keeps one interaction lifecycle while switching presentation tabs', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(ZHIYU_CLASSROOM_STAGE_ID);
    await classroom.waitForLoaded();

    const panel = page.getByTestId('zhiyu-interaction-panel');
    const chatArea = panel.getByTestId('chat-area');
    await expect(chatArea).toBeAttached();
    await panel.getByRole('tab', { name: /discussion|讨论/i }).click();
    await expect(panel.getByRole('tab', { name: /discussion|讨论/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await panel.getByRole('tab', { name: /roles|角色/i }).click();
    await expect(panel.getByRole('tab', { name: /roles|角色/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(chatArea).toBeAttached();
    await panel.getByRole('tab', { name: /lecture|讲解/i }).click();
    await expect(panel.getByRole('tab', { name: /lecture|讲解/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(chatArea).toBeAttached();
  });
});
