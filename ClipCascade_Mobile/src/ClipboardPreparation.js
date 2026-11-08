// A resolved Promise only yields to microtasks. Use a timer so native clipboard
// events and service liveness checks can run during large preparation loops.
export const yieldClipboardEvents = () => new Promise(resolve => setTimeout(resolve, 0));

export class ClipboardSuperseded extends Error {
  constructor() { super('Clipboard superseded'); this.name = 'ClipboardSuperseded'; }
}

export function isClipboardSuperseded(error) {
  return error instanceof ClipboardSuperseded || error?.code === 'CLIPBOARD_SUPERSEDED';
}

export class ClipboardJobs {
  constructor(onCancel = () => {}) {
    this.generation = 0;
    this.onCancel = onCancel;
  }
  cancel() {
    this.generation++;
    this.onCancel();
    return this.generation;
  }
  check(generation) {
    if (generation !== this.generation) throw new ClipboardSuperseded();
  }
}

export class ClipboardEchoes {
  constructor() { this.pending = new Map(); }
  remember(key) {
    this.pending.set(key, (this.pending.get(key) || 0) + 1);
    if (this.pending.size > 1024) this.pending.delete(this.pending.keys().next().value);
  }
  consume(key) {
    const count = this.pending.get(key) || 0;
    if (!count) return false;
    if (count === 1) this.pending.delete(key);
    else this.pending.set(key, count - 1);
    return true;
  }
}

export const encryptedClipboardEchoKey = (type, envelope) =>
  JSON.stringify([type, 'encrypted', envelope.nonce, envelope.tag]);

// Preserve wire order across asynchronous decrypt/clipboard calls. An actual
// local action invalidates messages that were queued before that action.
export function serializeClipboardMessages(handler, getLocalEpoch) {
  let chain = Promise.resolve();
  return (...args) => {
    const epoch = getLocalEpoch();
    chain = chain.catch(() => {}).then(() => {
      if (epoch === getLocalEpoch()) return handler(...args);
    });
    return chain;
  };
}

// Revisions describe clipboard observations, not explicit Share actions. A
// queued event from before a share must not cancel that newer explicit action.
export class ClipboardRevisionGate {
  constructor() { this.revision = 0; }
  baseline(revision) {
    const value = Number(revision);
    if (Number.isSafeInteger(value) && value >= 0) {
      this.revision = Math.max(this.revision, value);
    }
  }
  accept(revision) {
    const value = Number(revision);
    if (!Number.isSafeInteger(value) || value <= this.revision) return false;
    this.revision = value;
    return true;
  }
}

export function acceptClipboardObservation(revisions, event) {
  return revisions.accept(event.clipboardRevision) && event.clipboardEcho !== true;
}

export function acceptsClipboardFragment(metadata, receiving, discarded) {
  if (metadata == null) return true;
  if (discarded.has(metadata.id)) return false;
  if (typeof metadata.id !== 'string' || !metadata.id
      || !Number.isSafeInteger(metadata.totalFragments) || !Number.isSafeInteger(metadata.index)
      || metadata.totalFragments < 1 || metadata.index < 0 || metadata.index >= metadata.totalFragments) {
    throw new Error('Invalid fragment metadata');
  }
  // Old clients keep sending after cancellation. A trailing fragment must
  // never allocate another buffer, even after a bounded tombstone is evicted.
  return metadata.index === 0 || Object.prototype.hasOwnProperty.call(receiving, metadata.id);
}

export async function waitForClipboardCapacity(channel, size, checkCurrent,
  limit = 1024 * 1024, timeout = 30000) {
  let previous = channel.bufferedAmount;
  let lastProgress = Date.now();
  while (true) {
    checkCurrent();
    if (channel.readyState !== 'open') throw new Error('Data channel closed during transfer');
    const buffered = channel.bufferedAmount;
    if (buffered + size <= limit) return;
    if (buffered < previous) lastProgress = Date.now();
    if (Date.now() - lastProgress >= timeout) throw new Error('Data channel stopped draining');
    previous = buffered;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export async function sendSharedClipboardFragments(fragments, recipients, metadata, payloadType,
  encoder, checkCurrent, beforeFragment = async () => {}, onProgress = () => {}, allowPeer = () => true, encode = null) {
  const total = fragments.length;
  const positions = recipients.map(() => 0);
  let released = 0;
  let canceled = false;
  const check = () => {
    if (canceled) throw new ClipboardSuperseded();
    checkCurrent();
  };
  const releaseConsumed = () => {
    const oldest = positions.reduce((minimum, position) => Math.min(minimum, position), total);
    while (released < oldest) fragments[released++] = null;
    onProgress(oldest, total);
  };
  const sendPeer = async (channel, peer) => {
    try {
      for (let index = 0; index < total; index++) {
        check();
        await beforeFragment();
        check();
        if (!allowPeer(channel)) return false;
        const message = encode ? encode(fragments[index], {...metadata, index}) :
          JSON.stringify({payload: fragments[index], type: payloadType, metadata: {...metadata, index}});
        await waitForClipboardCapacity(channel, typeof message === 'string' ? encoder.encode(message).length : message.byteLength, () => {
          check();
          if (!allowPeer(channel)) throw new Error('Peer receive limit changed');
        });
        check();
        if (!allowPeer(channel)) return false;
        channel.send(message);
        positions[peer] = index + 1;
        releaseConsumed();
        // Native clipboard/disconnect events need a turn even when all
        // awaited helpers immediately resolve to microtasks.
        if ((index + 1) % 64 === 0) await yieldClipboardEvents();
      }
      return true;
    } catch (error) {
      if (isClipboardSuperseded(error)) {
        canceled = true;
        throw error;
      }
      return false;
    } finally {
      positions[peer] = total;
      releaseConsumed();
    }
  };
  try {
    const results = await Promise.allSettled(recipients.map(sendPeer));
    for (const result of results) {
      if (result.status === 'rejected' && isClipboardSuperseded(result.reason)) throw result.reason;
    }
    return results.filter(result => result.status === 'fulfilled' && result.value === true).length;
  } finally {
    fragments.length = 0;
  }
}

export async function fragmentClipboard(str, fragmentSize, encoder, decoder, checkCurrent = () => {}) {
  if (!Number.isInteger(fragmentSize) || fragmentSize < 4) {
    throw new Error('fragmentSize must be an integer of at least 4 bytes');
  }
  await yieldClipboardEvents();
  checkCurrent();
  const bytes = encoder.encode(str);
  const fragments = [];
  let start = 0;
  while (start < bytes.length) {
    checkCurrent();
    let end = Math.min(start + fragmentSize, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    fragments.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    if (fragments.length % 64 === 0) await yieldClipboardEvents();
  }
  checkCurrent();
  return fragments;
}
