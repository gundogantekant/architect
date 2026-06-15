/**
 * Cost summary API contract tests — W-1150
 *
 * CS-1: GET /api/costs/summary returns expected shape with breakdown and trend arrays
 * CS-2: GET /api/costs/summary?group_by=model groups correctly by model
 * CS-3: GET /api/costs/summary?from=…&to=… applies date range filter
 * CS-4: GET /api/costs/summary?group_by=agent_role groups correctly by agent_role
 */

import { test, expect } from './fixtures.mjs';
import { api, seedDispatch } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCost(dispatchId, overrides = {}) {
  return api('test/seed-dispatch-cost', {
    method: 'POST',
    body: JSON.stringify({
      id: dispatchId,
      model: overrides.model || 'claude-sonnet-4-6',
      agent_role: overrides.agent_role || 'coder',
      input_tokens: overrides.input_tokens ?? 1000,
      output_tokens: overrides.output_tokens ?? 500,
      cache_read_tokens: overrides.cache_read_tokens ?? 0,
      cache_write_tokens: overrides.cache_write_tokens ?? 0,
    }),
  });
}

// ---------------------------------------------------------------------------
// CS-1: Response shape
// ---------------------------------------------------------------------------

test.describe('Cost summary @fast', () => {
  test('CS-1: GET /api/costs/summary returns expected shape', async () => {
    const d = await seedDispatch({ status: 'completed' });
    await seedCost(d.dispatch_id);

    const summary = await api('costs/summary');

    // Top-level fields
    expect(typeof summary.total_cost_usd).toBe('number');
    expect(typeof summary.total_tokens).toBe('number');
    expect(typeof summary.sessions).toBe('number');
    expect(summary.period).toMatchObject({
      from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });

    // breakdown is an array with correct per-entry shape
    expect(Array.isArray(summary.breakdown)).toBe(true);
    expect(summary.breakdown.length).toBeGreaterThan(0);
    for (const entry of summary.breakdown) {
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.cost_usd).toBe('number');
      expect(typeof entry.tokens).toBe('number');
      expect(typeof entry.sessions).toBe('number');
    }

    // trend is an array with correct per-entry shape
    expect(Array.isArray(summary.trend)).toBe(true);
    expect(summary.trend.length).toBeGreaterThan(0);
    for (const entry of summary.trend) {
      expect(entry.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof entry.cost_usd).toBe('number');
      expect(typeof entry.sessions).toBe('number');
    }
  });

  // ---------------------------------------------------------------------------
  // CS-2: group_by=model
  // ---------------------------------------------------------------------------

  test('CS-2: group_by=model groups costs by model correctly', async () => {
    const d1 = await seedDispatch({ status: 'completed' });
    const d2 = await seedDispatch({ status: 'completed' });

    await seedCost(d1.dispatch_id, { model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 500 });
    await seedCost(d2.dispatch_id, { model: 'claude-haiku-4-5-20251001', input_tokens: 2000, output_tokens: 800 });

    const summary = await api('costs/summary?group_by=model');

    expect(Array.isArray(summary.breakdown)).toBe(true);
    const labels = summary.breakdown.map(e => e.label);
    expect(labels).toContain('claude-sonnet-4-6');
    expect(labels).toContain('claude-haiku-4-5-20251001');

    // Sonnet: (1000*3.0 + 500*15.0)/1e6 = 0.010500
    const sonnet = summary.breakdown.find(e => e.label === 'claude-sonnet-4-6');
    const expectedSonnetCost = (1000 * 3.0 + 500 * 15.0) / 1_000_000;
    expect(Math.abs(sonnet.cost_usd - expectedSonnetCost)).toBeLessThan(0.00005);
    expect(sonnet.sessions).toBe(1);
    expect(sonnet.tokens).toBe(1000 + 500);

    // Haiku: (2000*1.0 + 800*5.0)/1e6 = 0.006000 (model-catalog / migration 046)
    const haiku = summary.breakdown.find(e => e.label === 'claude-haiku-4-5-20251001');
    const expectedHaikuCost = (2000 * 1.0 + 800 * 5.0) / 1_000_000;
    expect(Math.abs(haiku.cost_usd - expectedHaikuCost)).toBeLessThan(0.00005);
    expect(haiku.sessions).toBe(1);
    expect(haiku.tokens).toBe(2000 + 800);

    // breakdown should be sorted by cost_usd descending
    const costs = summary.breakdown.map(e => e.cost_usd);
    expect(costs[0]).toBeGreaterThanOrEqual(costs[costs.length - 1]);
  });

  // ---------------------------------------------------------------------------
  // CS-3: Date range filter
  // ---------------------------------------------------------------------------

  test('CS-3: from/to date range filters out costs outside the window', async () => {
    const d = await seedDispatch({ status: 'completed' });
    await seedCost(d.dispatch_id, { input_tokens: 5000, output_tokens: 2000 });

    // Request a range that is guaranteed to be in the past (1970) — no records
    const summaryEmpty = await api('costs/summary?from=1970-01-01&to=1970-01-31');
    expect(summaryEmpty.total_cost_usd).toBe(0);
    expect(summaryEmpty.total_tokens).toBe(0);
    expect(summaryEmpty.sessions).toBe(0);
    expect(summaryEmpty.breakdown).toHaveLength(0);
    expect(summaryEmpty.trend).toHaveLength(0);
    expect(summaryEmpty.period).toMatchObject({ from: '1970-01-01', to: '1970-01-31' });

    // Request a range that covers today — should include the seeded record
    const today = new Date().toISOString().slice(0, 10);
    const summaryToday = await api(`costs/summary?from=${today}&to=${today}`);
    expect(summaryToday.sessions).toBeGreaterThan(0);
    expect(summaryToday.total_cost_usd).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // CS-4: group_by=agent_role
  // ---------------------------------------------------------------------------

  test('CS-4: group_by=agent_role groups costs by agent role correctly', async () => {
    const d1 = await seedDispatch({ status: 'completed' });
    const d2 = await seedDispatch({ status: 'completed' });

    await seedCost(d1.dispatch_id, { agent_role: 'coder', input_tokens: 1000, output_tokens: 500 });
    await seedCost(d2.dispatch_id, { agent_role: 'reviewer', input_tokens: 500, output_tokens: 200 });

    const summary = await api('costs/summary?group_by=agent_role');

    expect(Array.isArray(summary.breakdown)).toBe(true);
    const labels = summary.breakdown.map(e => e.label);
    expect(labels).toContain('coder');
    expect(labels).toContain('reviewer');

    const coder = summary.breakdown.find(e => e.label === 'coder');
    expect(coder.sessions).toBe(1);
    expect(coder.tokens).toBe(1000 + 500);

    const reviewer = summary.breakdown.find(e => e.label === 'reviewer');
    expect(reviewer.sessions).toBe(1);
    expect(reviewer.tokens).toBe(500 + 200);
  });
});
