import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: './tests/global-setup.mjs',
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Serial execution required: test files share a single server and use purgeAll()
  // in beforeEach. Running files concurrently causes cross-suite interference.
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:3777',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, dependencies: ['chromium'] },
  ],
});
