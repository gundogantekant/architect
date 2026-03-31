import { defineConfig } from '@playwright/test';
import { SPEC_FILES } from './tests/global-setup.mjs';

const BASE_PORT = 3800;

// One Playwright project per spec file (Chromium only).
// Each spec file has its own isolated server on a dedicated port (see global-setup.mjs).
const projects = SPEC_FILES.map((name, i) => ({
  name: `${name}/chromium`,
  testMatch: `**/${name}.spec.mjs`,
  use: { baseURL: `http://127.0.0.1:${BASE_PORT + i}`, browserName: 'chromium' },
}));

export default defineConfig({
  globalSetup: './tests/global-setup.mjs',
  globalTeardown: './tests/global-teardown.mjs',
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['./tests/progress-reporter.mjs']],
  use: { headless: true },
  projects,
});
