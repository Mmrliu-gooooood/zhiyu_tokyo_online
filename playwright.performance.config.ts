import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/performance',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        colorScheme: 'light',
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        viewport: { width: 1366, height: 900 },
      },
    },
  ],
});
