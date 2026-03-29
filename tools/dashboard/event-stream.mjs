/**
 * EventStream: immutable, append-only log of PTY events with monotonic seq numbers.
 * Replaces the ring-buffer scrollback model.
 */
export class EventStream {
  constructor(terminalId) {
    this.terminalId = terminalId;
    this.events = [];           // Array<{seq, type, payload, ts, synthetic?}>
    this.headSeq = 0;
    this.rawBytes = 0;
    this.snapshot = null;       // string: merged data payload up to snapshotSeq
    this.snapshotSeq = 0;
    this.subscribers = new Map(); // clientId -> {ws, lastSeq}
  }

  append(type, payload, opts = {}) {
    const seq = ++this.headSeq;
    const event = { seq, type, payload, ts: Date.now(), ...(opts.synthetic ? { synthetic: true } : {}) };
    this.events.push(event);
    if (type === 'data') this.rawBytes += payload.length;
    // Compact if over threshold
    if (this.events.length > 10000 || this.rawBytes > 5 * 1024 * 1024) {
      this._compact();
    }
    return event;
  }

  _compact() {
    // Merge all data events into snapshot, keep resize+meta verbatim
    const dataEvents = this.events.filter(e => e.type === 'data');
    const nonDataEvents = this.events.filter(e => e.type !== 'data');
    const mergedData = dataEvents.map(e => e.payload).join('');
    this.snapshot = (this.snapshot || '') + mergedData;
    this.snapshotSeq = this.headSeq;
    this.events = nonDataEvents.filter(e => e.seq > this.snapshotSeq);
    this.rawBytes = 0;
  }

  replayFrom(fromSeq) {
    // Returns { snapshot, snapshotSeq, events } for replay starting at fromSeq
    const needSnapshot = this.snapshot && fromSeq < this.snapshotSeq;
    const events = this.events.filter(e => e.seq > fromSeq);
    return {
      snapshot: needSnapshot ? this.snapshot : null,
      snapshotSeq: needSnapshot ? this.snapshotSeq : 0,
      events,
    };
  }

  broadcast(event) {
    const msg = JSON.stringify({ type: 'event', seq: event.seq, eventType: event.type, payload: event.payload, ts: event.ts });
    for (const [clientId, sub] of this.subscribers) {
      try {
        sub.ws.send(msg);
        sub.lastSeq = event.seq;
      } catch {
        this.subscribers.delete(clientId);
      }
    }
  }

  toJSONL() {
    const lines = [];
    if (this.snapshot) {
      lines.push(JSON.stringify({ seq: 0, type: '_snapshot', payload: this.snapshot, snapshotSeq: this.snapshotSeq, ts: 0 }));
    }
    for (const e of this.events) {
      lines.push(JSON.stringify(e));
    }
    return lines.join('\n');
  }

  static fromJSONL(str, terminalId) {
    const stream = new EventStream(terminalId);
    if (!str.trim()) return stream;
    const lines = str.trim().split('\n');
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === '_snapshot') {
          stream.snapshot = e.payload;
          stream.snapshotSeq = e.snapshotSeq;
          continue;
        }
        stream.events.push(e);
        if (e.seq > stream.headSeq) stream.headSeq = e.seq;
        if (e.type === 'data') stream.rawBytes += e.payload.length;
      } catch {}
    }
    return stream;
  }
}
