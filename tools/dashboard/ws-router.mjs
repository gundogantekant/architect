import { WebSocketServer } from 'ws';
import { appendFileSync } from 'node:fs';
import { dispatches, terminals } from './state.mjs';
import { termEventLogPath } from './utils.mjs';
import { HEARTBEAT_INTERVAL_MS } from './constants.mjs';
import { summarizeGoal } from './lib/summarize-goal.mjs';
import { updateTerminalTitle } from './db.mjs';
import { stripAnsi } from './lib/ansi.mjs';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // The access-guard upgrade listener (registered first in server.mjs) destroys the
    // socket on an Origin/host mismatch. Bail out if that already happened.
    if (socket.destroyed) return;
    const url = new URL(req.url, 'http://localhost');

    // Dispatch WebSocket: replay output from memory, then broadcast live updates
    const dispatchMatch = url.pathname.match(/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/ws$/);
    if (dispatchMatch) {
      const dispatch = dispatches.get(dispatchMatch[1]);
      if (!dispatch) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Replay output from memory
        const output = dispatch.output;
        if (output.length > 0) {
          try { ws.send(JSON.stringify({ type: 'replay-start', total: output.length })); } catch {}
          for (const line of output) {
            try { ws.send(JSON.stringify({ type: 'data', data: line })); } catch {}
          }
          try { ws.send(JSON.stringify({ type: 'replay-end' })); } catch {}
        } else {
          try { ws.send(JSON.stringify({ type: 'replay-end' })); } catch {}
        }
        if (dispatch.status !== 'running') {
          try { ws.send(JSON.stringify({ type: 'done', status: dispatch.status })); } catch {}
        }
        dispatch.wsClients.add(ws);
        ws.on('close', () => { dispatch.wsClients.delete(ws); });
      });
      return;
    }

    // Terminal WebSocket: EventStream protocol (stream-start → replay → stream-live → live events)
    const match = url.pathname.match(/^\/api\/terminal\/([A-Za-z0-9_-]+)\/ws$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const terminal = terminals.get(match[1]);
    if (!terminal) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Parse ?from= query param for reconnect
      const fromSeq = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10));

      const dims = {
        cols: terminal.cols || (terminal.ptyProcess ? terminal.ptyProcess.cols : 80),
        rows: terminal.rows || (terminal.ptyProcess ? terminal.ptyProcess.rows : 24),
      };

      // Send stream-start
      try {
        ws.send(JSON.stringify({
          type: 'stream-start',
          headSeq: terminal.eventStream.headSeq,
          rawBytes: terminal.eventStream.rawBytes,
          cols: dims.cols,
          rows: dims.rows,
        }));
      } catch {}

      // Replay: use full snapshot for fresh connects, batched replay for reconnects
      if (fromSeq === 0 && terminal.eventStream.headSeq > 0) {
        // Fresh connect: send entire terminal state as one snapshot message
        const { data, headSeq, nonDataEvents } = terminal.eventStream.getFullSnapshot();
        if (data.length > 0) {
          try { ws.send(JSON.stringify({ type: 'snapshot', data, upToSeq: headSeq })); } catch {}
        }
        // Send non-data events (resize, meta) individually — these are few
        for (const event of nonDataEvents) {
          try {
            ws.send(JSON.stringify({ type: 'event', seq: event.seq, eventType: event.type, payload: event.payload, ts: event.ts }));
          } catch {}
        }
      } else {
        // Reconnect: batch consecutive data events to reduce WS frame count
        const { snapshot, snapshotSeq, events } = terminal.eventStream.replayFrom(fromSeq);

        if (snapshot) {
          try { ws.send(JSON.stringify({ type: 'snapshot', data: snapshot, upToSeq: snapshotSeq })); } catch {}
        }

        let batchData = '';
        let batchMaxSeq = 0;
        for (const event of events) {
          if (event.type === 'data') {
            batchData += event.payload;
            batchMaxSeq = event.seq;
          } else {
            // Flush accumulated data batch before non-data event
            if (batchData) {
              try { ws.send(JSON.stringify({ type: 'event', seq: batchMaxSeq, eventType: 'data', payload: batchData, ts: Date.now() })); } catch {}
              batchData = '';
              batchMaxSeq = 0;
            }
            try {
              ws.send(JSON.stringify({ type: 'event', seq: event.seq, eventType: event.type, payload: event.payload, ts: event.ts }));
            } catch {}
          }
        }
        // Flush remaining data batch
        if (batchData) {
          try { ws.send(JSON.stringify({ type: 'event', seq: batchMaxSeq, eventType: 'data', payload: batchData, ts: Date.now() })); } catch {}
        }
      }

      // Send stream-live
      try { ws.send(JSON.stringify({ type: 'stream-live' })); } catch {}

      // If terminal already exited, send exit and close
      if (terminal.status !== 'running') {
        try { ws.send(JSON.stringify({ type: 'exit', code: terminal.status === 'completed' ? 0 : 1 })); } catch {}
        ws.close();
        return;
      }

      // Register subscriber — store viewport dimensions for max-of-subscribers PTY resize
      const clientId = `${Date.now()}-${Math.random()}`;
      terminal.eventStream.subscribers.set(clientId, {
        ws,
        lastSeq: terminal.eventStream.headSeq,
        cols: dims.cols,
        rows: dims.rows,
        pingIntervalId: null,
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input' && terminal.ptyProcess) {
            try { terminal.ptyProcess.write(msg.data); } catch {}
            if (!terminal._goalSummarized) {
              const printable = stripAnsi(msg.data)
                .replace(/\x7f/g, '\x08')
                .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
              let buf = terminal._inputBuffer || '';
              for (const ch of printable) {
                if (ch === '\x08') buf = buf.slice(0, -1);
                else buf += ch;
              }
              terminal._inputBuffer = buf.substring(0, 500);
              if (/[\r\n]/.test(msg.data)) {
                terminal._goalSummarized = true;
                const raw = terminal._inputBuffer.trim();
                terminal._inputBuffer = '';
                if (raw.length >= 5) {
                  summarizeGoal(raw).then(async (summary) => {
                    if (!summary) return;
                    terminal.title = summary;
                    updateTerminalTitle(terminal.id, summary)
                      .catch(e => console.error('terminal title update failed:', e));
                  });
                }
              }
            }
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            clearTimeout(terminal._resizeTimer);
            terminal._resizeTimer = setTimeout(() => {
              // Update this subscriber's stored dimensions
              const sub = terminal.eventStream.subscribers.get(clientId);
              if (sub) {
                sub.cols = msg.cols;
                sub.rows = msg.rows;
              }

              // Compute max-of-subscribers to prevent smaller viewports from shrinking the PTY
              const subscriberDimensions = [...terminal.eventStream.subscribers.values()];
              const maxCols = Math.max(...subscriberDimensions.map(s => s.cols || 80));
              const maxRows = Math.max(...subscriberDimensions.map(s => s.rows || 24));

              // Only resize PTY if dimensions actually changed
              if (maxCols !== terminal.cols || maxRows !== terminal.rows) {
                terminal.cols = maxCols;
                terminal.rows = maxRows;
                if (terminal.ptyProcess) try { terminal.ptyProcess.resize(maxCols, maxRows); } catch {}
                const resizeEvent = terminal.eventStream.append('resize', { cols: maxCols, rows: maxRows });
                try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(resizeEvent) + '\n'); } catch {}
                // Do NOT broadcast resize events — other subscribers must not have their viewport changed
              }
            }, 50);
          }
        } catch {}
      });

      ws.on('close', () => {
        // External tmux detach or kill closes the PTY → onExit → subscribers flushed → all WS connections closed. Intentional behavior.
        const sub = terminal.eventStream.subscribers.get(clientId);
        if (sub?.pingIntervalId) clearInterval(sub.pingIntervalId);
        terminal.eventStream.subscribers.delete(clientId);

        // Recompute PTY size to the max of remaining subscribers after disconnect
        const remaining = [...terminal.eventStream.subscribers.values()];
        if (remaining.length > 0) {
          const maxCols = Math.max(...remaining.map(s => s.cols || 80));
          const maxRows = Math.max(...remaining.map(s => s.rows || 24));
          if (maxCols !== terminal.cols || maxRows !== terminal.rows) {
            terminal.cols = maxCols;
            terminal.rows = maxRows;
            if (terminal.ptyProcess) try { terminal.ptyProcess.resize(maxCols, maxRows); } catch {}
            const resizeEvent = terminal.eventStream.append('resize', { cols: maxCols, rows: maxRows });
            try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(resizeEvent) + '\n'); } catch {}
          }
        }
      });

      // Arm ping interval after subscriber registration to avoid leaking on the early ws.close() path
      const pingIntervalId = setInterval(() => {
        try { ws.ping(); } catch {}
      }, HEARTBEAT_INTERVAL_MS);
      const sub = terminal.eventStream.subscribers.get(clientId);
      if (sub) sub.pingIntervalId = pingIntervalId;
    });
  });
}
