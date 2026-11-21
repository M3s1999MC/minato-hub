'use strict';

const MAX_LINE = 4000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * Búfer circular de líneas. Conserva solo las últimas `capacity` líneas
 * (stdout/stderr/hub) con número de secuencia creciente para lectura incremental.
 */
class RingBuffer {
  constructor(capacity = 200) {
    this.cap = capacity;
    this.buf = new Array(capacity);
    this.head = 0;
    this.size = 0;
    this.seq = 0;
    this.partial = { out: '', err: '', hub: '' };
  }

  _add(stream, msg) {
    if (msg.length > MAX_LINE) msg = msg.slice(0, MAX_LINE) + '…';
    const entry = { n: ++this.seq, t: Date.now(), s: stream, m: msg };
    if (this.size < this.cap) {
      this.buf[(this.head + this.size) % this.cap] = entry;
      this.size++;
    } else {
      this.buf[this.head] = entry;
      this.head = (this.head + 1) % this.cap;
    }
  }

  push(stream, chunk) {
    const text = (this.partial[stream] || '') + String(chunk).replace(ANSI, '');
    const parts = text.split(/\r?\n/);
    this.partial[stream] = parts.pop();
    for (const line of parts) this._add(stream, line);
    if (this.partial[stream].length > MAX_LINE) {
      this._add(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
  }

  flush(stream) {
    const rest = this.partial[stream];
    if (rest) this._add(stream, rest);
    this.partial[stream] = '';
  }

  since(n = 0) {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const e = this.buf[(this.head + i) % this.cap];
      if (e.n > n) out.push(e);
    }
    return out;
  }
}

module.exports = RingBuffer;
