/**
 * Sync API Contract Tests
 *
 * Headless tests — no browser required. Validates the /api/sync/* endpoints
 * return expected shapes and status codes.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { api } from './helpers.mjs';

test.describe('Sync API contracts @fast', () => {

  test('SC-1: GET /api/sync/status returns array of project freshness records', async () => {
    const result = await api('sync/status');
    expect(Array.isArray(result)).toBe(true);
    // Each entry must have required shape fields
    for (const entry of result) {
      expect(typeof entry.project_key).toBe('string');
      expect(['fresh', 'aging', 'stale', 'never']).toContain(entry.freshness);
    }
  });

  test('SC-2: POST /api/sync/trigger with valid project_key returns accepted response', async () => {
    const result = await api('sync/trigger', {
      method: 'POST',
      body: JSON.stringify({ project_key: 'ticari/architect/main', trigger: 'manual' }),
    });
    expect(result.accepted).toBe(true);
    expect(typeof result.sync_id).toBe('number');
  });

  test('SC-3: POST /api/sync/trigger with missing project_key returns 400', async () => {
    let threw = false;
    try {
      await api('sync/trigger', {
        method: 'POST',
        body: JSON.stringify({ trigger: 'manual' }),
      });
    } catch (e) {
      threw = true;
      expect(e.message).toMatch(/400/);
    }
    expect(threw).toBe(true);
  });

  test('SC-4: GET /api/sync/significant returns array of recent significant entries', async () => {
    const result = await api('sync/significant');
    expect(Array.isArray(result)).toBe(true);
    for (const entry of result) {
      expect(typeof entry.project_key).toBe('string');
      expect(['architectural', 'dependency']).toContain(entry.classification);
      expect(typeof entry.commit_hash).toBe('string');
    }
  });

  test('SC-5: GET /api/sync/:project_key/history returns array of sync records', async () => {
    const result = await api('sync/ticari%2Farchitect%2Fmain/history');
    expect(Array.isArray(result)).toBe(true);
    for (const record of result) {
      expect(typeof record.id).toBe('number');
      expect(record.project_key).toBe('ticari/architect/main');
      expect(['pending', 'running', 'completed', 'failed', 'skipped']).toContain(record.status);
    }
  });

});
