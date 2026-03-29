import { test as base, expect } from '@playwright/test';
import { basename } from 'node:path';
import { SPEC_FILES } from './global-setup.mjs';

export const test = base.extend({
  baseURL: [async ({}, use, workerInfo) => {
    const specName = basename(workerInfo.file, '.spec.mjs');
    const idx = SPEC_FILES.indexOf(specName);
    const port = 3778 + (idx >= 0 ? idx : 0);
    await use(`http://127.0.0.1:${port}`);
  }, { scope: 'worker' }],
});

export { expect };
