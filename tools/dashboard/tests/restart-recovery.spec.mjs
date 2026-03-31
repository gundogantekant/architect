/**
 * Restart Recovery E2E Test Suite
 *
 * Verifies that terminal history survives a simulated server restart.
 * Uses the /api/test/reset-sessions endpoint to clear in-memory state
 * and reload from JSONL persistence files — same path as a real restart.
 */

import { test, expect } from './fixtures.mjs';
import {
  seedTerminal,
  resetSessions,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermBufferLines,
  getXtermScrollMetrics,
  getEventStream,
} from './helpers.mjs';

test.describe('Restart Recovery', () => {

  test('RR-1: terminal content survives simulated restart', async ({ page }) => {
    test.setTimeout(60_000);

    // 1. Seed a completed terminal with content (completed survives restart as-is)
    const t = await seedTerminal({ lines: 300, withFakeContent: true, status: 'completed' });

    // 2. Verify content is visible in xterm
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 50);

    const linesBefore = await getXtermBufferLines(page, t.id, 0, 30);
    const nonEmptyBefore = linesBefore.filter(l => l.trim().length > 0);
    expect(nonEmptyBefore.length).toBeGreaterThan(10);

    // 3. Simulate server restart (clears memory, reloads from JSONL)
    await resetSessions();

    // 4. Verify terminal still exists after restart (via event-stream endpoint, not filtered by worker)
    const restored = await getEventStream(t.id);
    expect(restored).toBeTruthy();
    expect(restored.head_seq).toBeGreaterThan(0);

    // 5. Reload page and verify content is still visible
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 50);

    const linesAfter = await getXtermBufferLines(page, t.id, 0, 30);
    const nonEmptyAfter = linesAfter.filter(l => l.trim().length > 0);
    expect(nonEmptyAfter.length).toBeGreaterThan(10);

    // Content should match (same seed data restored from JSONL)
    expect(nonEmptyAfter.slice(0, 10)).toEqual(nonEmptyBefore.slice(0, 10));
  });

  test('RR-2: liveSnapshot is rebuilt from JSONL on restart', async () => {
    // Seed a terminal with known content
    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'completed' });

    // Get event stream state before restart
    const before = await getEventStream(t.id);
    expect(before.head_seq).toBeGreaterThan(0);
    expect(before.raw_bytes).toBeGreaterThan(0);
    expect(before.live_snapshot_length).toBeGreaterThan(0);

    // Simulate restart
    await resetSessions();

    // Get event stream state after restart
    const after = await getEventStream(t.id);
    expect(after.head_seq).toBe(before.head_seq);
    // raw_bytes should be restored from JSONL data events
    expect(after.raw_bytes).toBe(before.raw_bytes);
    // liveSnapshot must be rebuilt from JSONL — same length as before restart
    expect(after.live_snapshot_length).toBe(before.live_snapshot_length);
  });

  test('RR-3: large terminal (1000 lines) survives restart without data loss', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ lines: 1000, withFakeContent: true, status: 'completed' });

    // Verify initial load
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 100, 30_000);

    const metricsBefore = await getXtermScrollMetrics(page, t.id);
    expect(metricsBefore.baseY).toBeGreaterThan(0);

    // Simulate restart
    await resetSessions();

    // Reload and verify
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 100, 30_000);

    const metricsAfter = await getXtermScrollMetrics(page, t.id);
    // Scrollback should be comparable (same content restored)
    expect(metricsAfter.baseY).toBeGreaterThan(0);
    expect(metricsAfter.baseY).toBe(metricsBefore.baseY);
  });

  test('RR-4: meta events (claude_session_id) survive restart', async () => {
    const sessionId = 'test-session-' + Date.now();
    const t = await seedTerminal({
      lines: 50,
      withFakeContent: true,
      status: 'completed',
      claude_session_id: sessionId,
    });

    // Verify meta event exists before restart
    const before = await getEventStream(t.id);
    const metaBefore = before.events.filter(e => e.type === 'meta' && e.payload?.key === 'claude_session_id');
    expect(metaBefore.length).toBe(1);
    expect(metaBefore[0].payload.value).toBe(sessionId);

    // Simulate restart
    await resetSessions();

    // Verify meta event persisted
    const after = await getEventStream(t.id);
    const metaAfter = after.events.filter(e => e.type === 'meta' && e.payload?.key === 'claude_session_id');
    expect(metaAfter.length).toBe(1);
    expect(metaAfter[0].payload.value).toBe(sessionId);
  });
});
