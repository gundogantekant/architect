#!/usr/bin/env node
// Test stub for the `claude` CLI. Emits a minimal stream-json session so dispatch
// spawn paths (e.g. plan_execute phase-2 via POST /api/dispatch/:id/execute) can be
// exercised in tests without launching a real agent. Wired in via ARCHITECT_CLAUDE_BIN
// (see constants.mjs CLAUDE_BIN). Reads and discards stdin, prints an init event with a
// session id, then a terminal result event, and exits 0.

let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const sessionId = `stub-sess-${process.pid}`;
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: 0 }) + '\n');
  // Linger briefly so the spawning request observes a 'running' phase-2 before exit,
  // letting concurrency/idempotency assertions resolve deterministically.
  setTimeout(() => process.exit(0), 250);
});
