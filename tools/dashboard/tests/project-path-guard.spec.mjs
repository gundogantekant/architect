/**
 * Project Path Guard Contract Tests
 *
 * Validates that dispatch and terminal endpoints return a clear HTTP 400
 * (not a cryptic 500 "spawnSync tmux ENOENT") when the resolved project
 * path does not exist on disk (e.g. external volume not mounted).
 *
 * Root cause: resolveProjectPath returns whatever is in the portfolio
 * registry without checking the filesystem. Node.js surfaces a missing cwd
 * as `spawnSync <executable> ENOENT`, which falsely implicates the executable.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api } from './helpers.mjs';

const GHOST_PROJECT_KEY = 'testorg/ghostproject/main';
const GHOST_PATH = '/tmp/nonexistent-architect-path-guard-test-xyz';

test.describe('Project path existence guard @fast', () => {

  test.beforeEach(async () => {
    // Seed a registry entry that resolves to a non-existent directory
    await api('test/seed-registry-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: GHOST_PROJECT_KEY, project_path: GHOST_PATH }),
    });
  });

  test('PPG-1: POST /api/dispatch returns 400 with actionable message when project path missing', async () => {
    const resp = await fetch(`${getBase()}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: GHOST_PROJECT_KEY,
        additional_instructions: 'test task',
      }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/Project path does not exist/);
    expect(body.error).toMatch(GHOST_PATH);
    expect(body.error).toMatch(/volume or drive/);
  });

  test('PPG-2: POST /api/terminal returns 400 with actionable message when project path missing', async () => {
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: GHOST_PROJECT_KEY,
        title: 'test session',
        additional_instructions: 'test',
      }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/Project path does not exist/);
    expect(body.error).toMatch(GHOST_PATH);
    expect(body.error).toMatch(/volume or drive/);
  });

  test('PPG-3: error is 400 not 500 — does not implicate tmux or spawn', async () => {
    const resp = await fetch(`${getBase()}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: GHOST_PROJECT_KEY,
        additional_instructions: 'test task',
      }),
    });
    expect(resp.status).not.toBe(500);
    const body = await resp.json();
    expect(body.error).not.toMatch(/spawnSync/);
    expect(body.error).not.toMatch(/tmux/);
    expect(body.error).not.toMatch(/ENOENT/);
  });

});
