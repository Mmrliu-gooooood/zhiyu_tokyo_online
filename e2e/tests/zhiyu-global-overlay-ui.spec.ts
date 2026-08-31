import { test, expect } from '../fixtures/base';

test('access code exposes stable states and keeps keyboard focus inside the gate', async ({ page }) => {
  let verificationAttempt = 0;
  await page.route('**/api/access-code/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, authenticated: false }),
    });
  });
  await page.route('**/api/access-code/verify', async (route) => {
    verificationAttempt += 1;
    if (verificationAttempt === 1) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  const dialog = page.getByTestId('access-code-dialog');
  const input = page.getByTestId('access-code-input');
  const submit = page.getByTestId('access-code-submit');

  await expect(dialog).toHaveAttribute('data-state', 'initial');
  await expect(input).toBeFocused();
  await expect(page.locator('[inert][aria-hidden="true"]')).toHaveCount(1);

  await input.fill('wrong-code');
  await page.keyboard.press('Tab');
  await expect(submit).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();

  await submit.click();
  await expect(dialog).toHaveAttribute('data-state', 'invalid');
  await expect(page.getByTestId('access-code-error')).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill('valid-code');
  await submit.click();
  await expect(dialog).toHaveAttribute('data-state', 'loading');
  await expect(input).toBeFocused();
  await expect(dialog).toHaveAttribute('data-state', 'success');
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText(/.+/);
});
