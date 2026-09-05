import { test, expect } from '../fixtures/base';
import { seedClassroomDatabase } from '../fixtures/zhiyu-classroom';
import { SETTINGS_KV_KEY } from '../fixtures/test-data/settings';

test('keeps Home preset and auto role choices after visiting an existing course', async ({
  page,
  mockApi,
}) => {
  void mockApi;
  await seedClassroomDatabase(page, {
    agentMode: 'auto',
    selectedAgentIds: ['default-1', 'default-2', 'default-3'],
    agentSelectionIsUserSet: false,
  });
  // Reload once to show the newly seeded course, then use SPA navigation so
  // the fixture's init script cannot reset the user's settings during a visit.
  await page.reload();
  const readSelection = () =>
    page.evaluate((key) => {
      const state = JSON.parse(localStorage.getItem(key)!).state;
      return {
        mode: state.agentMode,
        ids: state.selectedAgentIds,
        userSet: state.agentSelectionIsUserSet,
      };
    }, SETTINGS_KV_KEY);
  const visitCourse = async () => {
    await page.getByText('Photosynthesis', { exact: true }).click();
    await expect(page.getByTestId('zhiyu-classroom-shell')).toBeVisible();
    await page.getByRole('button', { name: /back to home/i }).click();
    await expect(page.getByTestId('zhiyu-home-create-card')).toBeVisible();
  };

  await page.getByRole('button', { name: /Ready to learn together/ }).click();
  await page.getByRole('button', { name: 'Preset', exact: true }).click();
  await page.getByText('Class Clown', { exact: true }).click();
  await page.getByText('Curious Mind', { exact: true }).click();
  const preset = await readSelection();
  expect(preset).toEqual({
    mode: 'preset',
    ids: ['default-1', 'default-2', 'default-4'],
    userSet: true,
  });
  await visitCourse();
  await expect.poll(readSelection).toEqual(preset);

  await page.getByRole('button', { name: /Ready to learn together/ }).click();
  await expect(
    page.getByText('Class Clown', { exact: true }).locator('..').getByRole('checkbox'),
  ).not.toBeChecked();
  await expect(
    page.getByText('Curious Mind', { exact: true }).locator('..').getByRole('checkbox'),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Auto-generate', exact: true }).click();
  const auto = await readSelection();
  expect(auto.mode).toBe('auto');
  await visitCourse();
  await expect.poll(readSelection).toEqual(auto);
});
