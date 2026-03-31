import { WebSocketServer } from 'ws';
import { appendFileSync } from 'node:fs';
import { dispatches, terminals } from './state.mjs';
import { termEventLogPath } from './utils.mjs';

export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
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

      // Replay: snapshot + events from fromSeq
      const { snapshot, snapshotSeq, events } = terminal.eventStream.replayFrom(fromSeq);

      if (snapshot) {
        try { ws.send(JSON.stringify({ type: 'snapshot', data: snapshot, upToSeq: snapshotSeq })); } catch {}
      }

      for (const event of events) {
        try {
          ws.send(JSON.stringify({ type: 'event', seq: event.seq, eventType: event.type, payload: event.payload, ts: event.ts }));
        } catch {}
      }

      // Send stream-live
      try { ws.send(JSON.stringify({ type: 'stream-live' })); } catch {}

      // If terminal already exited, send exit and close
      if (terminal.status !== 'running') {
        try { ws.send(JSON.stringify({ type: 'exit', code: terminal.status === 'completed' ? 0 : 1 })); } catch {}
        ws.close();
        return;
      }

      // Register subscriber
      const clientId = `${Date.now()}-${Math.random()}`;
      terminal.eventStream.subscribers.set(clientId, { ws, lastSeq: terminal.eventStream.headSeq });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'input' && terminal.ptyProcess) {
            try { terminal.ptyProcess.write(msg.data); } catch {}
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            clearTimeout(terminal._resizeTimer);
            terminal._resizeTimer = setTimeout(() => {
              terminal.cols = msg.cols;
              terminal.rows = msg.rows;
              if (terminal.ptyProcess) try { terminal.ptyProcess.resize(msg.cols, msg.rows); } catch {}
              // Broadcast resize event to all subscribers
              const resizeEvent = terminal.eventStream.append('resize', { cols: msg.cols, rows: msg.rows });
              try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(resizeEvent) + '\n'); } catch {}
              terminal.eventStream.broadcast(resizeEvent);
            }, 50);
          }
        } catch {}
      });

      ws.on('close', () => {
        terminal.eventStream.subscribers.delete(clientId);
      });
    });
  });
}
