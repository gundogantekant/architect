/**
 * Asset browser contract tests — W-1137
 *
 * AB-1: GET /api/assets returns at least one item in each category
 * AB-2: GET /api/assets/content?path=usecases/implement-work-item.md returns content with placeholders
 * AB-3: GET /api/assets/content?path=../../../etc/passwd returns 403
 * AB-4: GET /api/assets/content?path=.claude/agents/coder.md returns content
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api } from './helpers.mjs';

test.describe('Asset browser @fast', () => {

  test('AB-1: GET /api/assets returns at least one item in each category', async () => {
    const index = await api('assets');
    expect(Array.isArray(index.agents)).toBe(true);
    expect(Array.isArray(index.skills)).toBe(true);
    expect(Array.isArray(index.usecases)).toBe(true);
    expect(Array.isArray(index.templates)).toBe(true);

    expect(index.agents.length).toBeGreaterThan(0);
    expect(index.skills.length).toBeGreaterThan(0);
    expect(index.usecases.length).toBeGreaterThan(0);
    expect(index.templates.length).toBeGreaterThan(0);

    // Each entry must have path and size
    const first = index.agents[0];
    expect(typeof first.path).toBe('string');
    expect(typeof first.size).toBe('number');
    expect(first.path.startsWith('.claude/agents/')).toBe(true);
  });

  test('AB-2: GET /api/assets/content for a usecase returns correct response shape', async () => {
    const result = await api('assets/content?path=' + encodeURIComponent('usecases/implement-work-item.md'));
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.binary).toBe(false);
    expect(typeof result.truncated).toBe('boolean');
    expect(Array.isArray(result.placeholders)).toBe(true);
    // All extracted placeholders must be uppercase alphanumeric + underscores
    for (const p of result.placeholders) {
      expect(p).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  test('AB-3: GET /api/assets/content with path traversal returns 403', async () => {
    const url = `${getBase()}/api/assets/content?path=${encodeURIComponent('../../../etc/passwd')}`;
    const resp = await fetch(url);
    expect(resp.status).toBe(403);
  });

  test('AB-4: GET /api/assets/content for an agent returns content', async () => {
    const result = await api('assets/content?path=' + encodeURIComponent('.claude/agents/coder.md'));
    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.binary).toBe(false);
    expect(typeof result.truncated).toBe('boolean');
    expect(Array.isArray(result.placeholders)).toBe(true);
  });

});
