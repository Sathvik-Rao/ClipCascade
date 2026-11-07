let nextSocketId = 0;

// STOMP still sees one continuous byte stream. Native code splits its frames
// into small binary WebSocket messages and waits for the OkHttp queue to drain.
export class StompSocket {
  constructor(url, bridge, events) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = 'arraybuffer';
    this._bridge = bridge;
    this._id = ++nextSocketId;
    this._pending = new Set();
    this._failure = null;
    this._listener = events.addListener('CLIPCASCADE_STOMP_SOCKET', event => {
      if (event.id !== this._id) return;
      if (event.type === 'open') {
        this.readyState = 1;
        this.onopen?.({type: 'open', target: this});
      } else if (event.type === 'message') {
        this.onmessage?.({data: JSON.parse(event.data), target: this});
      } else if (event.type === 'error') {
        this.onerror?.({message: event.data, target: this});
      } else if (event.type === 'close') {
        this.readyState = 3;
        this._listener.remove();
        this.onclose?.({code: event.code, reason: event.data, target: this});
      }
    });
    bridge.connectStompSocket(this._id, url, ['v12.stomp', 'v11.stomp', 'v10.stomp']);
  }

  send(frame) {
    if (this.readyState !== 1) throw new Error('STOMP connection is not open');
    if (typeof frame !== 'string') throw new Error('Expected a serialized STOMP text frame');
    // A literal NUL can be truncated by the React Native string bridge.
    // Send the STOMP terminator separately and restore it natively.
    const terminated = frame.endsWith('\0');
    const pending = this._bridge.sendStompFrame(this._id, terminated ? frame.slice(0, -1) : frame, terminated);
    this._pending.add(pending);
    pending.then(() => this._pending.delete(pending), error => {
      this._failure = error;
      this._pending.delete(pending);
      this.onerror?.({message: error.message || String(error), target: this});
    });
  }

  async flush() {
    if (this._failure) throw this._failure;
    await Promise.all([...this._pending]);
    if (this._failure) throw this._failure;
    if (this.readyState !== 1) throw new Error('STOMP connection closed during send');
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this._bridge.closeStompSocket(this._id, code, reason, false);
  }

  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this._bridge.closeStompSocket(this._id, 1000, 'Service stopped', true);
  }
}
