import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateLegacyPortfolio } from '../portfolio-migration.mjs';

test('moves legacy portfolio to target when target missing', () => {
  const tmp = join(process.cwd(), 'tmp', 'pmig-' + Date.now());
  const legacy = join(tmp, 'repo', 'portfolio');
  const target = join(tmp, 'home', '.architect', 'portfolio');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'registry.json'), '{"version":1,"entries":{}}');

  assert.equal(migrateLegacyPortfolio({ legacyPath: legacy, targetPath: target }), true);
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(legacy), false);
  rmSync(tmp, { recursive: true, force: true });
});

test('is no-op when target already exists', () => {
  const tmp = join(process.cwd(), 'tmp', 'pmig-' + Date.now());
  const legacy = join(tmp, 'repo', 'portfolio');
  const target = join(tmp, 'home', '.architect', 'portfolio');
  mkdirSync(legacy, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(legacy, 'registry.json'), '{"legacy":true}');
  writeFileSync(join(target, 'registry.json'), '{"target":true}');

  assert.equal(migrateLegacyPortfolio({ legacyPath: legacy, targetPath: target }), false);
  assert.equal(JSON.parse(readFileSync(join(target, 'registry.json'), 'utf8')).target, true);
  rmSync(tmp, { recursive: true, force: true });
});

test('is no-op when legacy is missing', () => {
  const tmp = join(process.cwd(), 'tmp', 'pmig-' + Date.now());
  assert.equal(migrateLegacyPortfolio({ legacyPath: join(tmp, 'portfolio'), targetPath: join(tmp, 'target') }), false);
});
