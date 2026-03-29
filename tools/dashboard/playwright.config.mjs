import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: './tests/global-setup.mjs',
  globalTeardown: './tests/global-teardown.mjs',
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Each spec file gets its own isolated server; chromium+firefox workers share it
  workers: 18,
  reporter: [['./tests/progress-reporter.mjs']],
  use: {
    headless: true,
    // baseURL resolved per worker in tests/fixtures.mjs based on spec filename
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, dependencies: ['chromium'] },
  ],
});
