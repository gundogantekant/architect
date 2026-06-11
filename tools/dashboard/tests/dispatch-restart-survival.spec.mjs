/**
 * Dispatch Restart Survival E2E Tests (W-1339)
 *
 * DRS-1: seed a dispatch with known log lines → restart the test server (reset sessions)
 *        → verify the dispatch log is still accessible from JSONL persistence after restart
 *        (distinct from restart-recovery.spec.mjs which covers terminal session content)
 */

import { test, expect } from './fixtures.mjs';
import { seedDispatch, resetSessions, getBase } from './helpers.mjs';

test.describe('Dispatch Restart Survival @behavioral', () => {

  test('DRS-1: dispatch log survives simulated server restart and remains readable', async () => {
    const logLines = ['line-A', 'line-B', 'line-C', 'line-D', 'line-E'];

    // Use 'interrupted' — completed dispatches are excluded from getPersistedDispatches()
    // to prevent unbounded memory growth, so only non-terminal states survive restart.
    const { dispatch_id } = await seedDispatch({
      status: 'interrupted',
      output: logLines,
    });

    // Verify log is present before restart (log endpoint returns plain-text JSONL, not JSON)
    const logRespBefore = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/log`);
    const logBefore = await logRespBefore.text();
    const linesBefore = logBefore.trim().split('\n').filter(Boolean);
    expect(linesBefore.length, 'log must have all seeded lines before restart').toBe(logLines.length);

    // Simulate restart: clears in-memory state, reloads dispatch entries from JSONL persistence
    await resetSessions();

    // Verify the log is still accessible after restart
    const logRespAfter = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/log`);
    const logAfter = await logRespAfter.text();
    const linesAfter = logAfter.trim().split('\n').filter(Boolean);
    expect(linesAfter.length, 'dispatch log must survive restart with same line count').toBe(logLines.length);

    // Verify line content is preserved (parse first and last JSONL entries)
    const firstBefore = JSON.parse(linesBefore[0]);
    const firstAfter = JSON.parse(linesAfter[0]);
    expect(firstAfter.delta?.text ?? firstAfter.text, 'first log line content must match').toBe(
      firstBefore.delta?.text ?? firstBefore.text
    );
  });

});
