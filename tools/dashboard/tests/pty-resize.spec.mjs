/**
 * PTY Resize Contract Tests (W-1149)
 *
 * Verifies the max-of-subscribers resize strategy:
 *   - PTY is resized to the maximum of all connected clients' dimensions
 *   - Resize events are NOT broadcast to other subscribers
 *   - When the largest client disconnects, PTY resizes down to next max
 *   - stream-live no longer auto-sends a resize message to the server
 *
 * These tests run directly against ws-router logic by opening real WebSocket
 * connections to the isolated Playwright test server.
 *
 * PR-1: Client B sends resize 220x50 → Client A must NOT receive resize event
 * PR-2: Client B (220x50) disconnects → PTY resizes to Client A's dims (< 220)
 * PR-3: Client A sends resize → PTY updated, no broadcast to Client B, no self-echo
 */

import { test, expect } from './fixtures.mjs';
import { api } from './helpers.mjs';

// ---------------------------------------------------------------------------
// WebSocket helper — uses Node 21+ built-in WebSocket (no external dep)
// ---------------------------------------------------------------------------

function connectTerminalWs(terminalId) {
  const port = process.env.TEST_SERVER_PORT;
  if (!port) throw new Error('TEST_SERVER_PORT not set');
  const url = `ws://127.0.0.1:${port}/api/terminal/${terminalId}/ws`;
  const ws = new WebSocket(url);
  const messages = [];

  ws.onmessage = (event) => {
    try { messages.push(JSON.parse(event.data)); } catch {}
  };

  return {
    ws,
    messages,
    send(obj) { ws.send(JSON.stringify(obj)); },
    close() { ws.close(); },

    waitOpen(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
        const tid = setTimeout(() => reject(new Error('WS did not open in time')), timeoutMs);
        ws.onopen = () => { clearTimeout(tid); resolve(); };
        ws.onerror = () => { clearTimeout(tid); reject(new Error('WS open error')); };
      });
    },

    async waitLive(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (messages.some(m => m.type === 'stream-live')) return;
        await new Promise(r => setTimeout(r, 30));
      }
      throw new Error('stream-live not received within timeout');
    },
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Get the last resize event payload from the terminal's event stream.
 * Returns null if no resize events recorded.
 */
async function getLatestResizeDims(terminalId) {
  const stream = await api(`test/terminal/${terminalId}/event-stream`);
  const resizeEvents = (stream.events || []).filter(e => e.type === 'resize');
  if (resizeEvents.length === 0) return null;
  return resizeEvents[resizeEvents.length - 1].payload;
}

// ---------------------------------------------------------------------------
// PR-1: Client B (220x50) sends resize → Client A must NOT receive resize event
// ---------------------------------------------------------------------------

test('PR-1: Client A does not receive resize broadcast when Client B sends resize @fast', async () => {
  const terminal = await api('test/seed-terminal', {
    method: 'POST',
    body: JSON.stringify({ status: 'running' }),
  });
  const terminalId = terminal.terminal_id;

  const clientA = connectTerminalWs(terminalId);
  await clientA.waitOpen();
  await clientA.waitLive();

  // Clear handshake messages from A
  clientA.messages.length = 0;

  const clientB = connectTerminalWs(terminalId);
  await clientB.waitOpen();
  await clientB.waitLive();

  // Client B reports its larger viewport to the server
  clientB.send({ type: 'resize', cols: 220, rows: 50 });

  // Wait for debounce (50ms) + network propagation
  await sleep(250);

  // PR-1: Client A must NOT have received a resize event broadcast
  const resizeOnA = clientA.messages.find(m => m.type === 'event' && m.eventType === 'resize');
  expect(resizeOnA, 'Client A must not receive resize event broadcast from Client B').toBeUndefined();

  clientA.close();
  clientB.close();
  await sleep(100);
});

// ---------------------------------------------------------------------------
// PR-2: Client B disconnects → PTY resizes back to remaining subscribers' max
// ---------------------------------------------------------------------------

test('PR-2: PTY resizes to remaining max dims when largest client disconnects @fast', async () => {
  const terminal = await api('test/seed-terminal', {
    method: 'POST',
    body: JSON.stringify({ status: 'running' }),
  });
  const terminalId = terminal.terminal_id;

  // Client A connects with initial seed dims (80x24)
  const clientA = connectTerminalWs(terminalId);
  await clientA.waitOpen();
  await clientA.waitLive();

  // Client B connects and reports 220x50
  const clientB = connectTerminalWs(terminalId);
  await clientB.waitOpen();
  await clientB.waitLive();

  clientB.send({ type: 'resize', cols: 220, rows: 50 });
  await sleep(250);

  // Verify the server recorded B's larger dims in the event stream
  const dimsAfterB = await getLatestResizeDims(terminalId);
  expect(dimsAfterB?.cols, 'PTY must have expanded to 220 after B sent resize').toBe(220);
  expect(dimsAfterB?.rows).toBe(50);

  // Disconnect Client B — server should recompute max from remaining subscribers (A)
  clientB.close();
  await sleep(300);

  // After B disconnects, the last resize event must have cols < 220 (A's dims)
  const streamAfter = await api(`test/terminal/${terminalId}/event-stream`);
  const resizeEvents = (streamAfter.events || []).filter(e => e.type === 'resize');
  const lastResize = resizeEvents[resizeEvents.length - 1];
  expect(lastResize, 'Server must have recorded a resize event after B disconnected').toBeTruthy();
  expect(lastResize.payload.cols, 'Last resize must have cols < 220 after B disconnects').toBeLessThan(220);

  clientA.close();
  await sleep(100);
});

// ---------------------------------------------------------------------------
// PR-3: Resize message → PTY updated, no broadcast to other subscriber, no self-echo
// ---------------------------------------------------------------------------

test('PR-3: resize updates PTY only — no broadcast to Client B, no self-echo to Client A @fast', async () => {
  const terminal = await api('test/seed-terminal', {
    method: 'POST',
    body: JSON.stringify({ status: 'running' }),
  });
  const terminalId = terminal.terminal_id;

  const clientA = connectTerminalWs(terminalId);
  await clientA.waitOpen();
  await clientA.waitLive();

  const clientB = connectTerminalWs(terminalId);
  await clientB.waitOpen();
  await clientB.waitLive();

  // Clear all handshake messages
  clientA.messages.length = 0;
  clientB.messages.length = 0;

  // Client A sends a larger resize
  clientA.send({ type: 'resize', cols: 180, rows: 45 });
  await sleep(250);

  // Client B must NOT have received a resize event
  const resizeOnB = clientB.messages.find(m => m.type === 'event' && m.eventType === 'resize');
  expect(resizeOnB, 'Client B must not receive resize broadcast from Client A').toBeUndefined();

  // Client A must NOT receive a self-echo of the resize
  const resizeOnA = clientA.messages.find(m => m.type === 'event' && m.eventType === 'resize');
  expect(resizeOnA, 'Client A must not receive self-echo of resize').toBeUndefined();

  // The server-side event stream must record a resize event with Client A's dims
  const dims = await getLatestResizeDims(terminalId);
  expect(dims?.cols, 'Server event stream must record the new cols').toBe(180);
  expect(dims?.rows, 'Server event stream must record the new rows').toBe(45);

  clientA.close();
  clientB.close();
  await sleep(100);
});
