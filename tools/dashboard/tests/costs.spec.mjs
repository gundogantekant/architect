/**
 * Cost tracking contract tests — W-1143
 *
 * CT-1: Cost computation formula
 * CT-2: Dispatch cost persistence (with/without result event)
 * CT-3: GET /api/costs/work-item/:id — work-item rollup
 * CT-4: GET /api/costs/project/:key — project rollup
 * CT-5: UI badge — dispatch panel shows cost, terminal panel shows placeholder
 * CT-6: Regression — getProjectAvgDispatchCost unchanged after migration
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.mjs';
import { getBase, api, seedWorkItem, seedDispatch } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedDispatchWithCost(opts = {}) {
  const id = opts.id || `D-cost-${randomUUID().slice(0, 8)}`;
  return api('test/seed-dispatch-cost', {
    method: 'POST',
    body: JSON.stringify({ id, ...opts }),
  });
}

// ---------------------------------------------------------------------------
// CT-1: Cost computation
// ---------------------------------------------------------------------------

test.describe('Cost tracking @fast', () => {
  test('CT-1: cost_usd_breakdown equals formula result within 0.01% tolerance', async () => {
    // Seeded model prices (from migration 024):
    //   claude-sonnet-4-6: input=3.0, output=15.0, cache_read=0.3, cache_write=3.75 per Mtok
    const input = 1000;
    const output = 500;
    const cacheRead = 200;
    const cacheWrite = 100;

    const model = 'claude-sonnet-4-6';
    const expectedCost =
      (input * 3.0 + output * 15.0 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000;

    const dispatch = await seedDispatch({ status: 'completed' });
    const result = await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: dispatch.dispatch_id,
        model,
        agent_role: 'coder',
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
      }),
    });

    expect(result).toHaveProperty('cost_usd_breakdown');
    const diff = Math.abs(result.cost_usd_breakdown - expectedCost) / expectedCost;
    expect(diff).toBeLessThan(0.0001); // within 0.01%
  });

  // ---------------------------------------------------------------------------
  // CT-2: Dispatch cost persistence
  // ---------------------------------------------------------------------------

  test('CT-2a: completed dispatch with result event creates exactly one dispatch_costs row', async () => {
    const dispatch = await seedDispatch({ status: 'completed' });
    await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: dispatch.dispatch_id,
        model: 'claude-haiku-4-5-20251001',
        agent_role: 'tracker',
        input_tokens: 500,
        output_tokens: 200,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    });

    const rows = await api(`test/dispatch-costs/${dispatch.dispatch_id}`);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(dispatch.dispatch_id);
    expect(rows[0].model).toBe('claude-haiku-4-5-20251001');
    expect(rows[0].agent_role).toBe('tracker');
    expect(typeof rows[0].cost_usd_breakdown).toBe('number');
    expect(rows[0].cost_usd_breakdown).toBeGreaterThan(0);
  });

  test('CT-2b: dispatch with no result event has no dispatch_costs row', async () => {
    const dispatch = await seedDispatch({ status: 'running' });
    const rows = await api(`test/dispatch-costs/${dispatch.dispatch_id}`);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // CT-3: GET /api/costs/work-item/:id
  // ---------------------------------------------------------------------------

  test('CT-3: work-item rollup sums costs and tokens across dispatches', async () => {
    const workItem = await seedWorkItem({ title: 'CT-3 cost work item' });

    // Create two dispatches linked to this work item
    const d1 = await seedDispatch({ status: 'completed', work_item_id: workItem.id });
    const d2 = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

    // Seed costs: sonnet prices: input=3.0, output=15.0 per Mtok
    // D1: 1000 input + 500 output → cost = (1000*3.0 + 500*15.0)/1e6 = 0.010500
    await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: d1.dispatch_id,
        model: 'claude-sonnet-4-6',
        agent_role: 'coder',
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    });
    // D2: 2000 input + 1000 output → cost = (2000*3.0 + 1000*15.0)/1e6 = 0.021000
    await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: d2.dispatch_id,
        model: 'claude-sonnet-4-6',
        agent_role: 'coder',
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    });

    const rollup = await api(`costs/work-item/${workItem.id}`);

    const expectedCost =
      (1000 * 3.0 + 500 * 15.0 + 2000 * 3.0 + 1000 * 15.0) / 1_000_000;
    const expectedTokens = 1000 + 500 + 2000 + 1000;

    expect(rollup.sessions).toBe(2);
    expect(rollup.total_tokens).toBe(expectedTokens);
    // 4 decimal place accuracy
    expect(Math.abs(rollup.total_cost_usd - expectedCost)).toBeLessThan(0.00005);
  });

  // ---------------------------------------------------------------------------
  // CT-4: GET /api/costs/project/:key
  // ---------------------------------------------------------------------------

  test('CT-4: project rollup sums across all dispatches for project', async () => {
    const projectKey = `ct4-org/ct4-proj/main`;

    const d1 = await seedDispatch({ status: 'completed', project_key: projectKey });
    const d2 = await seedDispatch({ status: 'completed', project_key: projectKey });

    // Haiku prices: input=0.8, output=4.0 per Mtok
    await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: d1.dispatch_id,
        model: 'claude-haiku-4-5-20251001',
        agent_role: 'classifier',
        input_tokens: 1000,
        output_tokens: 300,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    });
    await api('test/seed-dispatch-cost', {
      method: 'POST',
      body: JSON.stringify({
        id: d2.dispatch_id,
        model: 'claude-haiku-4-5-20251001',
        agent_role: 'coordinator',
        input_tokens: 2000,
        output_tokens: 600,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    });

    const rollup = await api(`costs/project/${encodeURIComponent(projectKey)}`);

    const expectedCost =
      (1000 * 0.8 + 300 * 4.0 + 2000 * 0.8 + 600 * 4.0) / 1_000_000;
    const expectedTokens = 1000 + 300 + 2000 + 600;

    expect(rollup.sessions).toBe(2);
    expect(rollup.total_tokens).toBe(expectedTokens);
    expect(Math.abs(rollup.total_cost_usd - expectedCost)).toBeLessThan(0.00005);
  });

  // ---------------------------------------------------------------------------
  // CT-5: UI badge
  // ---------------------------------------------------------------------------

  test('CT-5a: dispatch panel with cost data shows cost badge', async ({ page }) => {
    // Seed dispatch with a known cost_usd so the badge renders immediately
    const dispatch = await seedDispatch({ status: 'completed', cost_usd: 0.0015 });

    await page.goto(getBase());
    await page.waitForSelector(`#dispatch-${dispatch.dispatch_id}`, { timeout: 10_000 });

    // Cost badge should be present in the dispatch panel
    const badge = page.locator(`#dispatch-${dispatch.dispatch_id} .cost-badge`);
    await expect(badge).toBeVisible({ timeout: 8000 });
    const text = await badge.textContent();
    expect(text).toMatch(/\$[\d.]+/);
  });

  test('CT-5b: terminal panel shows (—) placeholder for missing cost signal', async ({ page }) => {
    const { api: apiHelper } = await import('./helpers.mjs');
    // Use the helpers seedTerminal
    const { seedTerminal } = await import('./helpers.mjs');
    const terminal = await seedTerminal({ status: 'running' });

    await page.goto(getBase());
    await page.waitForSelector(`#terminal-${terminal.id}`, { timeout: 10_000 });

    const placeholder = page.locator(`#terminal-${terminal.id} .cost-placeholder`);
    await expect(placeholder).toBeVisible({ timeout: 8000 });
    const text = await placeholder.textContent();
    expect(text).toContain('—');
  });

  // ---------------------------------------------------------------------------
  // CT-6: Regression — getProjectAvgDispatchCost unchanged
  // ---------------------------------------------------------------------------

  test('CT-6: getProjectAvgDispatchCost returns correct value after migration', async () => {
    // Seed session_history directly and verify the avg cost function works as before
    const projectKey = 'ct6-org/ct6-proj/main';

    await api('test/seed-session-history', {
      method: 'POST',
      body: JSON.stringify({ project_key: projectKey, cost_usd: 2.0, duration_seconds: 60, type: 'dispatch' }),
    });
    await api('test/seed-session-history', {
      method: 'POST',
      body: JSON.stringify({ project_key: projectKey, cost_usd: 4.0, duration_seconds: 120, type: 'dispatch' }),
    });
    await api('test/seed-session-history', {
      method: 'POST',
      body: JSON.stringify({ project_key: projectKey, cost_usd: 6.0, duration_seconds: 180, type: 'dispatch' }),
    });

    const result = await api(`test/project-avg-dispatch-cost/${encodeURIComponent(projectKey)}`);
    expect(result).toHaveProperty('avg_cost');
    expect(result).toHaveProperty('count');
    expect(result.count).toBe(3);
    expect(Math.abs(result.avg_cost - 4.0)).toBeLessThan(0.001);
  });
});
