import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as db from '../db.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let tmpDir;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'search-test-'));
  await db.initDatabaseAsync(tmpDir, MIGRATIONS_DIR);
});

afterEach(() => {
  db.closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('searchWorkItems returns planned item matching keyword', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'task awareness backlog', status: 'planned', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['awareness']);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'task awareness backlog');
});

test('searchWorkItems excludes done items', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'awareness done item', status: 'done', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['awareness']);
  assert.equal(results.length, 0);
});

test('searchWorkItems excludes cancelled items', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'awareness cancelled item', status: 'cancelled', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['awareness']);
  assert.equal(results.length, 0);
});

test('searchWorkItems excludes archived items', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'awareness archived item', status: 'archived', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['awareness']);
  assert.equal(results.length, 0);
});

test('searchWorkItems returns empty array on no match', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'regular draft task', status: 'draft', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['zzznomatch']);
  assert.deepEqual(results, []);
});

test('searchWorkItems treats % as literal — does not match unless text contains literal %', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: '100percent complete', status: 'draft', priority: 'medium', description: '' });
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'has %percent sign in title', status: 'draft', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['%percent']);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'has %percent sign in title');
});

test('searchWorkItems ranks 2-keyword hit above 1-keyword hit', () => {
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'backlog sync awareness item', status: 'draft', priority: 'medium', description: '' });
  db.createWorkItem({ project_key: 'org/proj/comp', title: 'backlog only item', status: 'draft', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['backlog', 'awareness']);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'backlog sync awareness item');
});

test('searchWorkItems filters by project_key when provided', () => {
  db.createWorkItem({ project_key: 'org/alpha/comp', title: 'keyword match alpha', status: 'draft', priority: 'medium', description: '' });
  db.createWorkItem({ project_key: 'org/beta/comp', title: 'keyword match beta', status: 'draft', priority: 'medium', description: '' });
  const results = db.searchWorkItems(['keyword'], 'org/alpha/comp');
  assert.equal(results.length, 1);
  assert.equal(results[0].project_key, 'org/alpha/comp');
});
