/**
 * Error Path Tests
 *
 * Validates that the dashboard handles invalid inputs, unknown routes, and
 * non-existent resources gracefully — no JS crashes, no 5xx responses.
 *
 * EP-5 through EP-7 are unit tests for injectPrompt kill-on-failure behavior (W-1215).
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, api } from './helpers.mjs';

// Unit tests for injectPrompt — run in the Node.js test process, no browser needed.
// These verify kill-on-failure behavior added in W-1215.
test.describe('injectPrompt kill-on-failure @unit', () => {
  function makeMockTerminal(writeImpl, { tmuxSession = null, pid = null } = {}) {
    const events = [];
    const killSignals = [];
    const terminal = {
      id: `test-${Date.now()}`,
      _pendingPrompt: 'test prompt payload',
      pid,
      tmux_session: tmuxSession,
      ptyProcess: {
        write: writeImpl,
        kill: (sig) => killSignals.push(sig),
      },
      eventStream: {
        append: (_type, data) => { events.push(data); return data; },
        broadcast: () => {},
      },
    };
    return { terminal, events, killSignals };
  }

  test('EP-5: write failure kills PTY, emits session_status:failed, clears _pendingPrompt', async () => {
    const { terminal, events, killSignals } = makeMockTerminal((data) => {
      if (data === '\x1b[200~') return;
      throw new Error('simulated PTY write failure');
    });

    const { injectPrompt } = await import('../pty-manager.mjs');
    await injectPrompt(terminal);

    expect(terminal._pendingPrompt).toBeNull();
    expect(killSignals).toContain('SIGHUP');
    expect(events.some(e => e?.key === 'session_status' && e?.value === 'failed')).toBe(true);
    expect(events.some(e => e?.key === 'prompt_injection_status' && e?.value === 'failed')).toBe(true);
  });

  test('EP-6: happy path emits prompt_injection_status:done and does not kill PTY', async () => {
    const { terminal, events, killSignals } = makeMockTerminal(() => {});

    const { injectPrompt } = await import('../pty-manager.mjs');
    await injectPrompt(terminal);

    expect(events.some(e => e?.key === 'prompt_injection_status' && e?.value === 'done')).toBe(true);
    expect(events.some(e => e?.key === 'session_status' && e?.value === 'failed')).toBe(false);
    expect(killSignals).toHaveLength(0);
  });

  test('EP-7: write failure on tmux-backed session kills ptyProcess and attempts tmux kill-session', async () => {
    const { terminal, events, killSignals } = makeMockTerminal(
      (data) => {
        if (data === '\x1b[200~') return;
        throw new Error('simulated PTY write failure');
      },
      { tmuxSession: 'architect-test-ep7', pid: null },
    );

    const { injectPrompt } = await import('../pty-manager.mjs');
    // tmux kill-session will fail silently (no real session) — must not propagate
    await expect(injectPrompt(terminal)).resolves.toBeUndefined();

    expect(killSignals).toContain('SIGHUP');
    expect(events.some(e => e?.key === 'session_status' && e?.value === 'failed')).toBe(true);
  });
});

test.describe('Error paths @behavioral', () => {

  test('EP-1: navigating to nonexistent terminal does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/#terminal/nonexistent-id-99999');
    await page.waitForTimeout(2000);
    // page should not throw uncaught JS errors
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('EP-2: killed dispatch shows non-running status', async ({ page }) => {
    const { dispatch_id } = await seedDispatch({ status: 'completed', output: ['done'] });
    await page.goto('/');
    await page.waitForTimeout(500);
    // dispatch panel should not show "running" badge
    const panel = page.locator(`[id="dispatch-${dispatch_id}"], #dispatch-${dispatch_id}`);
    if (await panel.count() > 0) {
      await expect(panel).not.toContainText('running');
    }
  });

  test('EP-3: navigating to unknown component does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/#component/unknown-org/unknown-proj/main');
    await page.waitForTimeout(2000);
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('EP-4: POST work-item without title returns 4xx not 5xx', async () => {
    const resp = await fetch(`${getBase()}/api/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'draft' }), // missing title
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(500);
  });
});
