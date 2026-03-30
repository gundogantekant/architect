import { test as base, expect } from '@playwright/test';
import { SPEC_FILES } from './global-setup.mjs';

export const test = base.extend({
  // Auto worker fixture: sets TEST_SERVER_PORT so getBase() in helpers resolves correctly.
  // Runs automatically before any test in the worker without needing to be declared.
  _workerPort: [async ({}, use, workerInfo) => {
    // Project name is "${specName}/chromium" or "${specName}/firefox"
    const specName = workerInfo.project.name.replace(/\/(chromium|firefox)$/, '');
    const idx = SPEC_FILES.indexOf(specName);
    const port = 3778 + (idx >= 0 ? idx : 0);
    process.env.TEST_SERVER_PORT = String(port);
    await use(port);
  }, { scope: 'worker', auto: true }],
});

export { expect };
