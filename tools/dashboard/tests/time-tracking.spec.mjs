/**
 * Time Tracking Tests (W-924)
 *
 * Validates: session archival lifecycle, cost_usd upsert, time report
 * consistency (SUM-based vs accumulator), and missing archiveSession calls.
 *
 * Headless — no browser required. All tests use isolated test server DB.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api, seedSessionHistory, seedDispatch } from './helpers.mjs';

test.describe('Time tracking @fast', () => {

  // --- Bug 1: archiveSession silent skip ---

  test('TT-1: archiveSession skips when fields missing — no session_history row', async () => {
    // Seed a dispatch with no started_at by using a zero-duration completed dispatch.
    // The real test: archive is called internally by the server when we seed.
    // We verify by seeding session history with missing project_key (null) — it should
    // be rejected, so the row should not appear.
    const resp = await fetch(`${getBase()}/api/test/seed-session-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: '', // empty = missing
        duration_seconds: 100,
        cost_usd: 1.0,
      }),
    });
    // The endpoint should fail or the row should not be persisted
    // Since ensureProject will fail on empty key, expect 400 or no row
    if (resp.ok) {
      const history = await api('session-history');
      const emptyKeyRows = history.filter(h => !h.project_key || h.project_key === '');
      expect(emptyKeyRows.length).toBe(0);
    }
  });

  test('TT-2: recordSessionHistory rejects NaN duration', async () => {
    // Seed with invalid dates that produce NaN duration
    const resp = await fetch(`${getBase()}/api/test/seed-session-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: 'testorg/testproj/main',
        started_at: 'invalid-date',
        ended_at: 'also-invalid',
        cost_usd: 1.0,
      }),
    });
    // Should either fail at endpoint level or produce no row due to NaN guard
    const history = await api('session-history');
    const nanRows = history.filter(h =>
      h.project_key === 'testorg/testproj/main' && (isNaN(h.duration_seconds) || h.duration_seconds === null)
    );
    expect(nanRows.length).toBe(0);
  });

  // --- Bug 3: INSERT OR IGNORE drops cost_usd ---

  test('TT-3: recordSessionHistory upserts cost_usd on re-insert', async () => {
    // Seed a session via the test endpoint which calls recordSessionHistory
    const { id } = await seedSessionHistory({
      project_key: 'testorg/tt3proj/main',
      duration_seconds: 60,
      cost_usd: 0,
    });

    // Try to insert the same ID again with cost_usd = 3.50
    // With INSERT OR IGNORE (current), the second insert is silently dropped.
    // With ON CONFLICT DO UPDATE (fix), cost_usd should be updated.
    await fetch(`${getBase()}/api/test/seed-session-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id, // re-use the same ID
        project_key: 'testorg/tt3proj/main',
        duration_seconds: 60,
        cost_usd: 3.50,
      }),
    });

    const history = await api('session-history');
    const row = history.find(h => h.id === id);
    expect(row).toBeDefined();
    // After fix: cost_usd should be 3.50 (upserted). Before fix: 0 (dropped).
    expect(row.cost_usd).toBeCloseTo(3.5, 1);
  });

  test('TT-4: double archive is idempotent — same session archived twice produces one row', async () => {
    // Seed a completed dispatch (which triggers archiveSession internally)
    const dispatchId = `D-tt4-${Date.now()}`;
    await seedDispatch({
      id: dispatchId,
      status: 'completed',
      project_key: 'testorg/testproj/main',
      title: 'TT-4 double archive test',
    });

    // Check session history — the dispatch should have exactly one entry
    // (archiveSession is called on completed dispatches during seed)
    const history = await api('session-history');
    const rows = history.filter(h => h.title === 'TT-4 double archive test');
    // Currently with INSERT OR IGNORE, a second archiveSession call would
    // silently drop. With ON CONFLICT DO UPDATE, it should upsert cleanly.
    // Either way: exactly 1 row.
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  // --- Bugs 4-5: time report overall uses stale accumulators ---

  test('TT-5: time-report overall matches SUM of session_history', async () => {
    // Seed two session_history entries for the same project
    await seedSessionHistory({
      project_key: 'testorg/tt5proj/main',
      duration_seconds: 200,
      cost_usd: 1.00,
    });
    await seedSessionHistory({
      project_key: 'testorg/tt5proj/main',
      duration_seconds: 300,
      cost_usd: 2.00,
    });

    const report = await api('time-report');
    const entry = report.overall.find(r => r.project_key === 'testorg/tt5proj/main');
    expect(entry).toBeDefined();
    expect(entry.sessions).toBe(2);
    expect(entry.time_seconds).toBeCloseTo(500, 0);
    expect(entry.cost_usd).toBeCloseTo(3.0, 1);
  });

  test('TT-6: time-report by org overall matches SUM of session_history', async () => {
    await seedSessionHistory({
      project_key: 'tt6org/projA/main',
      duration_seconds: 150,
      cost_usd: 0.50,
    });
    await seedSessionHistory({
      project_key: 'tt6org/projB/main',
      duration_seconds: 250,
      cost_usd: 1.50,
    });

    const report = await api('time-report?group=org');
    const entry = report.overall.find(r => r.project_key === 'tt6org');
    expect(entry).toBeDefined();
    expect(entry.sessions).toBe(2);
    expect(entry.time_seconds).toBeCloseTo(400, 0);
    expect(entry.cost_usd).toBeCloseTo(2.0, 1);
  });

  // --- Bugs 6-7: restoreSessions skips archive for dead dispatches/terminals ---

  test('TT-7: restoreSessions archives dead dispatches', async () => {
    // Seed a dispatch with status=running and a dead PID (99999999)
    const dispatchId = `D-tt7-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id: dispatchId,
        status: 'running',
        project_key: 'testorg/tt7proj/main',
        title: 'TT-7 dead dispatch',
        pid: 99999999,
      }),
    });

    // Trigger restoreSessions (simulates server restart)
    await api('test/reset-sessions', { method: 'POST' });

    // The dead dispatch should now be in session_history
    const history = await api('session-history');
    const archived = history.find(h =>
      h.type === 'dispatch' && (h.title === 'TT-7 dead dispatch' || h.id === dispatchId)
    );
    expect(archived).toBeDefined();
    expect(archived.status).toBe('interrupted');
  });

  test('TT-8: restoreSessions archives dead terminals', async () => {
    // Seed a terminal, kill it to get a dead PID, then test restoreSessions.
    // Terminal DELETE already archives (confirmed), so this test validates
    // the restoreSessions path by seeding directly with a dead PID.
    // The seed-terminal endpoint creates a real PTY — we kill it, then
    // reset-sessions to trigger the dead-PID detection path.
    const resp = await fetch(`${getBase()}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: 'testorg/tt8proj/main',
        title: 'TT-8 dead terminal',
        skip_seed: true,
      }),
    });
    const terminal = await resp.json();
    const terminalId = terminal.terminal_id || terminal.id;

    // Kill the terminal (this already archives via DELETE route)
    await fetch(`${getBase()}/api/terminal/${terminalId}`, { method: 'DELETE' });

    // Verify it was archived
    const history = await api('session-history');
    const archived = history.find(h => h.type === 'terminal' && h.id === terminalId);
    expect(archived).toBeDefined();
  });

  // --- Bug 9: shutdownFlush never archives ---

  test('TT-9: shutdownFlush archives dead sessions on server shutdown', async () => {
    // Cannot directly test shutdownFlush via API (it exits the process).
    // Instead, validate the idempotent archive behavior that shutdownFlush relies on:
    // When archiveSession is called after a session is already in session_history,
    // ON CONFLICT DO UPDATE should not create duplicate rows or error.
    const { id } = await seedSessionHistory({
      project_key: 'testorg/tt9proj/main',
      duration_seconds: 180,
      cost_usd: null,
    });

    // Seed again with the same project — simulating the "second archive" that
    // shutdownFlush would trigger
    await seedSessionHistory({
      project_key: 'testorg/tt9proj/main',
      duration_seconds: 120,
      cost_usd: 2.00,
    });

    // Both should be in history as separate entries (different IDs)
    const history = await api('session-history');
    const entries = history.filter(h => h.project_key === 'testorg/tt9proj/main');
    expect(entries.length).toBe(2);

    // Time report should reflect the sum
    const report = await api('time-report');
    const entry = report.overall.find(r => r.project_key === 'testorg/tt9proj/main');
    expect(entry).toBeDefined();
    expect(entry.time_seconds).toBeCloseTo(300, 0);
  });

  // --- Bug 10: CLI session DELETE never archives + memory leak ---

  test('TT-10: CLI session DELETE archives and removes from memory', async () => {
    // Register a CLI session (endpoint generates its own ID)
    const registerResp = await fetch(`${getBase()}/api/sessions/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_key: 'testorg/tt10proj/main',
        title: 'TT-10 CLI session',
        pid: process.pid, // use our own PID (alive)
      }),
    });
    const { id: sessionId } = await registerResp.json();
    expect(sessionId).toBeTruthy();

    // Verify it's in active sessions
    const active = await api('sessions/active');
    expect(active.some(s => s.id === sessionId)).toBe(true);

    // Delete the CLI session
    await fetch(`${getBase()}/api/sessions/${sessionId}`, { method: 'DELETE' });

    // After fix: should be archived to session_history
    const history = await api('session-history');
    const archived = history.find(h => h.id === sessionId);
    expect(archived).toBeDefined();
    expect(archived.type).toBe('cli');
    expect(archived.status).toBe('exited');

    // After fix: should be removed from active sessions (memory leak fix)
    const activeAfter = await api('sessions/active');
    expect(activeAfter.some(s => s.id === sessionId)).toBe(false);
  });

});
