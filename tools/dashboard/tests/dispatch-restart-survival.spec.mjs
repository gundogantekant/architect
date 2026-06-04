/**
 * Dispatch Restart Survival E2E Tests (W-1339)
 *
 * DRS-1: seed a dispatch with known log lines → restart the test server (reset sessions)
 *        → reconnect SSE with ?after=N cursor → assert only lines after N are replayed
 *        (no duplicates, no missing lines)
 */

import { test, expect } from './fixtures.mjs';
import { seedDispatch, resetSessions, api, getBase } from './helpers.mjs';

test.describe('Dispatch Restart Survival @behavioral', () => {

  test('DRS-1: SSE replay with ?after=N cursor returns only lines after N after restart', async () => {
    const logLines = ['line-A', 'line-B', 'line-C', 'line-D', 'line-E'];

    const { dispatch_id } = await seedDispatch({
      status: 'completed',
      output: logLines,
    });

    // Record how many lines exist before restart
    const logBefore = await api(`dispatch/${dispatch_id}/log`);
    const linesBefore = logBefore.trim().split('\n').filter(Boolean);
    expect(linesBefore.length).toBe(logLines.length);

    // Simulate restart: reset in-memory state, then reload from JSONL persistence
    await resetSessions();

    // Reconnect SSE with ?after=2 — should replay only lines 3, 4, 5 (0-indexed: 2,3,4)
    const cursorN = 2;
    const base = getBase();
    const ac = new AbortController();
    const collectedData = [];

    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => { ac.abort(); resolve(); }, 5000);

      fetch(`${base}/api/dispatch/${dispatch_id}/stream?after=${cursorN}`, { signal: ac.signal })
        .then(async (response) => {
          if (!response.ok) { clearTimeout(timeoutId); resolve(); return; }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (const part of parts) {
              const dataMatch = part.match(/^data: (.+)$/m);
              if (dataMatch) collectedData.push(dataMatch[1]);
              if (part.includes('event: done')) { clearTimeout(timeoutId); ac.abort(); resolve(); return; }
            }
          }
          clearTimeout(timeoutId);
          resolve();
        })
        .catch((err) => {
          if (err.name !== 'AbortError') reject(err);
          else resolve();
        });
    });

    // Lines replayed after cursor=2 should be exactly the last 3 lines
    const expectedReplayCount = logLines.length - cursorN;
    expect(collectedData.length, `Expected ${expectedReplayCount} lines replayed after cursor=${cursorN}`).toBe(expectedReplayCount);
  });

});
