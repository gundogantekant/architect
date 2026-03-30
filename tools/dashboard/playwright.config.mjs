import { defineConfig } from '@playwright/test';
import { SPEC_FILES } from './tests/global-setup.mjs';

const BASE_PORT = 3778;

// One Playwright project per spec file per browser.
// Each spec file has its own isolated server on a dedicated port (see global-setup.mjs).
// Firefox projects depend on their chromium counterpart passing first.
const chromiumProjects = SPEC_FILES.map((name, i) => ({
  name: `${name}/chromium`,
  testMatch: `**/${name}.spec.mjs`,
  use: { baseURL: `http://127.0.0.1:${BASE_PORT + i}`, browserName: 'chromium' },
}));

const firefoxProjects = SPEC_FILES.map((name, i) => ({
  name: `${name}/firefox`,
  testMatch: `**/${name}.spec.mjs`,
  use: { baseURL: `http://127.0.0.1:${BASE_PORT + i}`, browserName: 'firefox' },
  dependencies: [`${name}/chromium`],
}));

export default defineConfig({
  globalSetup: './tests/global-setup.mjs',
  globalTeardown: './tests/global-teardown.mjs',
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // 2 workers per spec (chromium + firefox); each spec's tests share one isolated server
  workers: 18,
  reporter: [['./tests/progress-reporter.mjs']],
  use: { headless: true },
  projects: [...chromiumProjects, ...firefoxProjects],
});
