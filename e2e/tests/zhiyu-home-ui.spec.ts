import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

test.beforeEach(async ({ page }) => {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'zh-CN');
  }, SETTINGS_STORAGE);
});

test('renders the ZHIYU learning home without academy branding', async ({ page }) => {
  const home = new HomePage(page);
  await home.goto();

  await expect(home.logo).toBeVisible();
  await expect(home.createCard).toBeVisible();
  await expect(page.getByTestId('zhiyu-learning-visual')).toBeVisible();
  await expect(page.getByText('一句话，生成一堂互动课')).toBeVisible();
  await expect(page.getByText('多智能体教师与同学，实时讲授与讨论')).toBeVisible();
  await expect(page.getByRole('button', { name: '开课' })).toBeDisabled();
  await expect(page.getByText('青衿')).toHaveCount(0);
  await expect(page.getByText('书院')).toHaveCount(0);
});
