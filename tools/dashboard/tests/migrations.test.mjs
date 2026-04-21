import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MG-1: migration files have unique version numbers.
 *
 * The W-951 incident was caused by two files sharing version 008
 * (008-org-key-column.mjs and 008-work-item-state-machine.mjs). The
 * alphabetically-first applied and recorded v8; the second was silently
 * skipped for three weeks. This test catches that class at PR time.
 */
test('MG-1: migration files have unique version numbers', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(dir).filter(f => /^\d{3}-.+\.mjs$/.test(f));
  const seen = new Map();
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    assert.ok(!seen.has(v), `Duplicate version ${v}: ${seen.get(v)} and ${f}`);
    seen.set(v, f);
  }
});
