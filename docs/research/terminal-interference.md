# Cross-Browser PTY Resize Interference — Investigation Report

**Work item:** W-1142
**Date:** 2026-05-16
**Scope:** Read-only investigation; no code modified.

---

## 1. Root Cause

The root cause is a single-owner resize model applied to a shared-subscriber event stream. Any connected WebSocket client can resize the PTY process; the resulting resize event is then broadcast to every other subscriber.

**Confirmed call path:**

```
Browser B opens /api/terminal/<id>/ws
  └── ws-router.mjs:49  wss.handleUpgrade(...)
        └── ws-router.mjs:126 terminal.eventStream.subscribers.set(clientId, { ws, lastSeq })
              └── ws-router.mjs:115 server sends { type: 'stream-live' }
                    └── index.html:1299-1306 client receives 'stream-live'
                          └── wsManager.send({ type: 'resize', cols: term.cols, rows: term.rows })
                                └── ws-router.mjs:133-143 server receives { type: 'resize' }
                                      ├── ws-router.mjs:136 terminal.cols = msg.cols
                                      ├── ws-router.mjs:137 terminal.rows = msg.rows
                                      ├── ws-router.mjs:138 terminal.ptyProcess.resize(msg.cols, msg.rows)
                                      ├── ws-router.mjs:140 terminal.eventStream.append('resize', { cols, rows })
                                      └── ws-router.mjs:142 terminal.eventStream.broadcast(resizeEvent)
                                                └── event-stream.mjs:65-75 iterates ALL subscribers, sends resize event
                                                      └── index.html:973-978  client A receives resize event
                                                            ├── (container has dimensions) fitPreservingScroll → fitAddon.fit()
                                                            │     → term.cols/rows change to match Browser B's viewport
                                                            └── (no dimensions) term.resize(payload.cols, payload.rows)
```

**Exact file:line:function attribution:**

| Step | File | Lines | Action |
|------|------|-------|--------|
| Client B sends resize on `stream-live` | `index.html` | 1299–1306 | `wsManager.send({ type: 'resize', cols, rows })` |
| Server debounces and applies resize | `ws-router.mjs` | 133–143 | `ptyProcess.resize()` + `eventStream.broadcast()` |
| EventStream fans out to all subscribers | `event-stream.mjs` | 65–75 | `EventStream.broadcast()` — no caller filtering |
| Client A applies the foreign resize | `index.html` | 973–978 | `fitPreservingScroll()` or `term.resize()` |

---

## 2. Secondary Mechanisms

### 2a. ResizeObserver also sends resize on container layout changes

`index.html:1203–1216` — every client installs a `ResizeObserver` on its terminal container. When the resize event from the foreign client is processed and `fitAddon.fit()` runs, it changes `term.cols`/`term.rows`. If the container layout also shifts (e.g. a panel reflow), the `ResizeObserver` fires again and sends another `{ type: 'resize' }` back to the server while `sessionState.state === 'LIVE'` (`index.html:1211`). This creates an oscillation loop: B resizes → A gets resize event → A reflits → A sends new resize → B gets it → etc.

### 2b. `stream-live` resize is unconditional

`index.html:1303–1306` — the `stream-live` handler sends a resize message regardless of whether the client is already at the correct dimensions. There is no check that the reported dimensions actually differ from the server-stored `terminal.cols`/`terminal.rows`. This means every new connection immediately overwrites PTY dimensions even when the terminal is already at the right size.

### 2c. Debounce does not prevent cross-client overwriting

`ws-router.mjs:134–135` — `clearTimeout(terminal._resizeTimer)` is a single timer shared across all clients. A rapid succession of resize messages from different clients will cancel each other's debounce. Only the last message wins, regardless of which client sent it. There is no per-client debounce or ownership check.

### 2d. Resize events are replayed to reconnecting clients

`event-stream.mjs:44–53` (`replayFrom`) and `index.html:1290–1292` — resize events are stored in `eventStream.events` and replayed verbatim on reconnect. A reconnecting client will replay the last foreign resize and then re-fit its terminal to whatever dimensions the foreign client had when it last triggered a resize.

---

## 3. Reproduction Sequence

1. Open the dashboard in **Browser A** and navigate to an active terminal session. Confirm the terminal renders correctly at the expected dimensions (e.g. 220×50).
2. Open the same terminal URL (`/api/terminal/<id>/ws` page) in **Browser B** with a narrower viewport (e.g. 120×30). Observe that xterm initialises and connects.
3. After the WS handshake completes and `stream-live` is received in Browser B, observe that **Browser A's terminal immediately reflits to 120×30** — the PTY is now narrower, and any running TUI application (e.g. Claude Code) wraps text accordingly.
4. To trigger the oscillation loop: resize Browser B's window. The ResizeObserver fires, Browser B sends a new resize, Browser A gets the broadcast and fits to the new size. Resize Browser A — Browser B gets it and refits.

---

## 4. Proposed Fix Approach (for W-1149)

The fix must ensure that **only the client whose viewport changed is authoritative** for PTY dimensions, and that resize events are **not broadcast back to other clients**.

Two complementary changes are needed:

**A. Server: track resize ownership; do not broadcast back to non-owner clients.**
When a resize message arrives from a specific `clientId`, the server should record that client as the "resize owner". The PTY resize still happens. The resulting event should be appended to the stream (for replay durability) but the broadcast must **exclude the originating client** — and ideally should not be sent to other clients at all, since they should derive their own dimensions from their own viewport.

**B. Client: suppress the `stream-live` resize if server dimensions already match.**
Before sending the `stream-live` resize, the client should compare `term.cols/rows` against the `cols`/`rows` values returned in the `stream-start` message. If they match, skip the send. This avoids overwriting dimensions when a second client connects with the same viewport size.

Optional hardening: store the `clientId` in the resize message so the server can log which client last resized, making future debugging easier.

---

## 5. W-1149 Implementation Guidance

### 5a. `ws-router.mjs` — suppress cross-client broadcast (lines 128–146)

Change the resize handler to pass the originating `clientId` to the broadcast call so it can be excluded. The simplest approach: skip `broadcast()` entirely for resize events, because other clients should not reflow based on a foreign resize. Resize events only need to be appended to the stream for reconnect replay (so a reconnecting client sees the last known dimensions). If cross-client resize propagation is ever intentional, a separate mechanism with explicit client consent should be used.

```js
// ws-router.mjs — inside ws.on('message') at line 133
} else if (msg.type === 'resize' && msg.cols && msg.rows) {
  clearTimeout(terminal._resizeTimer);
  terminal._resizeTimer = setTimeout(() => {
    terminal.cols = msg.cols;
    terminal.rows = msg.rows;
    if (terminal.ptyProcess) try { terminal.ptyProcess.resize(msg.cols, msg.rows); } catch {}
    // Append resize event for replay durability, but do NOT broadcast to other clients.
    // Each client determines its own viewport dimensions independently.
    const resizeEvent = terminal.eventStream.append('resize', { cols: msg.cols, rows: msg.rows });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(resizeEvent) + '\n'); } catch {}
    // REMOVED: terminal.eventStream.broadcast(resizeEvent);
  }, 50);
}
```

Lines changed: **140–142** (remove the `broadcast` call, keep `append` and `appendFileSync`).

### 5b. `index.html` — guard the `stream-live` resize (lines 1299–1306)

Before sending the resize on `stream-live`, compare against the dimensions the server reported in `stream-start`. Only send if they differ.

The `stream-start` payload already contains `cols` and `rows` (`ws-router.mjs:60–66`). Store them in `streamStartData` when handling `stream-start` (already stored at line ~1282 as `streamStartData`), then check:

```js
// index.html — inside the 'stream-live' branch (around line 1303)
} else if (msg.type === 'stream-live') {
  sessionState.state = 'LIVE';
  if (loadingEl) { loadingEl.remove(); loadingEl = null; }
  wsManager.resetBackoff();
  // Only send resize if our viewport differs from what the server already has.
  if (sessionState._term && streamStartData) {
    const serverCols = streamStartData.cols;
    const serverRows = streamStartData.rows;
    if (sessionState._term.cols !== serverCols || sessionState._term.rows !== serverRows) {
      wsManager.send({ type: 'resize', cols: sessionState._term.cols, rows: sessionState._term.rows });
    }
  }
  ...
```

Lines changed: **1303–1306** (wrap the `wsManager.send` in the dimension-diff guard).

### 5c. `index.html` — suppress applying received resize events from other clients

With fix 5a in place, resize events will no longer be broadcast to other clients in the live path. However, resize events may still be replayed on reconnect (from `eventStream.events`). The client's `_writeNonDataEvent` handler at line 973 applies all replayed resize events unconditionally. Since a replayed resize represents historical PTY state (not the current server state), and the client will send its own resize on `stream-live` after replay, suppress the application of replayed resize events during the `REPLAYING` phase:

```js
// index.html — inside _writeNonDataEvent (around line 973)
if (eventType === 'resize') {
  // Only apply resize events received during the LIVE phase (from the server's
  // perspective these will no longer be broadcast post-fix, but guard for safety).
  if (this._sessionState.state !== 'LIVE') return;
  const rect = this._containerEl ? this._containerEl.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    fitPreservingScroll(this._term, this._fitAddon);
  } else {
    try { this._term.resize(payload.cols, payload.rows); } catch {}
  }
}
```

Lines changed: **973** (add state guard before the resize block).

### Summary of files and lines for W-1149

| File | Lines | Change |
|------|-------|--------|
| `tools/dashboard/ws-router.mjs` | 140–142 | Remove `terminal.eventStream.broadcast(resizeEvent)` |
| `tools/dashboard/index.html` | 1303–1306 | Guard `stream-live` resize send behind dimension-diff check |
| `tools/dashboard/index.html` | 973–978 | Guard `_writeNonDataEvent` resize application to `LIVE` state only |

No changes required to `event-stream.mjs`, `terminal-session.mjs`, or `pty-manager.mjs`.
