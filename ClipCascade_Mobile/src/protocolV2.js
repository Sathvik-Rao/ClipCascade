/**
 * E2E clipboard protocol v2 for mobile.
 * Envelope: { v, type, senderDeviceId, counter, ts, payload }
 * Crypto binds metadata by encrypting an inner object {t,d,c,ts,p} so
 * outer labels cannot be swapped without failing decrypt/verify.
 */

import AesGcmCrypto from 'react-native-aes-gcm-crypto';
import {Buffer} from 'buffer';

export const PROTOCOL_VERSION = 2;
export const REPLAY_CACHE_MAX = 2048;
export const MAX_TRACKED_SENDERS = 64;
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Rejects duplicate (senderDeviceId, counter) pairs within a bounded window.
 *
 * The window is kept per sender: a shared window lets one sender's traffic
 * evict another's history, which would let a replayed message back in. Both
 * the per-sender window and the number of tracked senders are bounded so a
 * flood of unique device IDs cannot grow memory without limit.
 *
 * Callers must only admit senders whose message has already been
 * authenticated (see unwrapInbound); otherwise an unauthenticated peer can
 * both evict real entries and pin a victim's counter.
 */
export class ReplayCache {
  constructor(maxEntries = REPLAY_CACHE_MAX, maxSenders = MAX_TRACKED_SENDERS) {
    this.max = maxEntries;
    this.maxSenders = maxSenders;
    // senderDeviceId -> {seen: Map<counter, true>, last: number|null}
    this.senders = new Map();
  }

  accept(senderDeviceId, counter) {
    if (
      !senderDeviceId ||
      typeof counter !== 'number' ||
      !Number.isSafeInteger(counter) ||
      counter < 1
    ) {
      return false;
    }

    let entry = this.senders.get(senderDeviceId);
    if (!entry) {
      entry = {seen: new Map(), last: null};
      this.senders.set(senderDeviceId, entry);
      while (this.senders.size > this.maxSenders) {
        this.senders.delete(this.senders.keys().next().value);
      }
    } else {
      // Refresh LRU position so active senders are not evicted first.
      this.senders.delete(senderDeviceId);
      this.senders.set(senderDeviceId, entry);
    }

    const seen = entry.seen;
    if (seen.has(counter)) {
      return false;
    }
    const last = entry.last;
    if (last != null && counter <= last - this.max) {
      return false;
    }

    seen.set(counter, true);
    while (seen.size > this.max) {
      seen.delete(seen.keys().next().value);
    }
    if (last == null || counter > last) {
      entry.last = counter;
    }
    return true;
  }
}

export function ensureDeviceId(store) {
  if (!store.device_id) {
    store.device_id = generateUuid();
  }
  return store.device_id;
}

export function nextCounter(store) {
  const counter = (Number(store.send_counter) || 0) + 1;
  store.send_counter = counter;
  return counter;
}

function generateUuid() {
  // RFC4122-ish v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * @param {{payload:string,type:string,cipherEnabled:boolean,hashedPassword?:string,store:object}} args
 */
export async function wrapOutbound({
  payload,
  type,
  cipherEnabled,
  hashedPassword,
  store,
}) {
  const deviceId = ensureDeviceId(store);
  const counter = nextCounter(store);
  const ts = Date.now();

  let wirePayload = payload;
  if (cipherEnabled) {
    if (!hashedPassword) {
      throw new Error('cipher enabled but no key');
    }
    // Bind metadata inside ciphertext (mobile AES-GCM has no AAD API).
    const inner = JSON.stringify({
      t: type,
      d: deviceId,
      c: counter,
      ts,
      p: payload,
    });
    const encrypted = await AesGcmCrypto.encrypt(inner, false, hashedPassword);
    wirePayload = JSON.stringify({
      nonce: Buffer.from(encrypted.iv, 'hex').toString('base64'),
      ciphertext: encrypted.content,
      tag: Buffer.from(encrypted.tag, 'hex').toString('base64'),
      bound: true,
    });
  }

  return {
    v: PROTOCOL_VERSION,
    type,
    senderDeviceId: deviceId,
    counter,
    ts,
    payload: wirePayload,
  };
}

/**
 * Wrap a v2 envelope in the outer frame the server relays.
 *
 * The server models a clipboard message as {payload, type, metadata} and
 * rebuilds the relayed copy from exactly those three fields, so any other
 * top-level key is dropped in transit. Serialising the envelope into `payload`
 * keeps it intact through every server, including versions that predate
 * protocol v2 — which is what most self-hosters are running. It is also what
 * the P2P transport has always done, so both transports now agree.
 *
 * Only the fields the server models are sent. It does not merely ignore extra
 * top-level keys — Jackson raises UnrecognizedPropertyException and the whole
 * message is dropped before the handler runs, which is why the flat envelope
 * did not just arrive looking like v1, it never arrived at all.
 */
export function buildTransportFrame(envelope, type) {
  return {
    payload: JSON.stringify(envelope),
    type,
  };
}

/**
 * Recover the v2 envelope from a relayed frame.
 *
 * Accepts a frame from buildTransportFrame, and also a flat envelope so the
 * client keeps working if a server ever carries the envelope fields itself.
 *
 * The outer frame's `type`/`metadata` are relay-controlled and deliberately not
 * returned: only the envelope reaches unwrapInbound, and only the type bound
 * inside the ciphertext is authoritative.
 */
export function extractTransportEnvelope(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Invalid clipboard frame');
  }

  if (body.v === PROTOCOL_VERSION && body.senderDeviceId !== undefined) {
    return body;
  }

  const payload = body.payload;
  if (typeof payload !== 'string') {
    throw new Error(
      `Clipboard frame has no string payload to unwrap (keys: ${Object.keys(
        body,
      )
        .sort()
        .join(',')})`,
    );
  }

  let envelope;
  try {
    envelope = JSON.parse(payload);
  } catch (e) {
    throw new Error(`Clipboard frame payload is not a v2 envelope: ${e.message}`);
  }

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    envelope.payload === undefined
  ) {
    throw new Error('Clipboard frame payload is not a v2 envelope');
  }
  return envelope;
}

/**
 * @returns {Promise<{payload:string,type:string}>}
 */
export async function unwrapInbound(args) {
  const {body, cipherEnabled, hashedPassword, replayCache, localDeviceId} =
    args ?? {};

  // Read the legacy opt-in as an OWN property, and require exactly `true`.
  //
  // A destructuring default (`allowLegacyV1 = false`) fires only when the
  // property is `undefined`, and an inherited property is not undefined — so
  // anything able to write Object.prototype could switch this on for every
  // later call. That was reachable: the P2P fragment reassembler indexed a
  // plain object with an attacker-supplied key. The reassembler is fixed, and
  // this makes the flag unreachable from the prototype chain regardless.
  const allowLegacyV1 =
    Object.prototype.hasOwnProperty.call(args ?? {}, 'allowLegacyV1') &&
    args.allowLegacyV1 === true;

  if (!body || body.payload === undefined) {
    throw new Error('Invalid clipboard message');
  }

  const version = body.v ?? 1;
  // `??` treats an explicit null as absent, but Python's dict.get(k, default)
  // returns the null. That difference let `"type": null` pass the bound
  // metadata check on mobile while desktop rejected it, so match Python: only
  // a genuinely missing key falls back to "text".
  let type = body.type === undefined ? 'text' : body.type;
  let payload = body.payload;

  // v1 carries no counter, timestamp, or metadata binding, so accepting it
  // lets anyone who can inject into the transport strip the "v" field and
  // bypass every v2 protection. Refused unless the caller opts in (for mixed
  // fleets still running < 3.2.0).
  if (version === 1 || version == null) {
    if (!allowLegacyV1) {
      throw new Error(
        'Rejected legacy v1 message (no replay or metadata binding). ' +
          'Upgrade all devices to 3.2.0+, or enable allowLegacyV1.',
      );
    }
    if (cipherEnabled) {
      payload = await decryptLegacy(payload, hashedPassword);
    }
    return {payload, type};
  }

  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  const sender = body.senderDeviceId;
  const counter = body.counter;
  const ts = body.ts;
  // Mirrors protocol_v2.py: the counter must be a positive safe integer and the
  // timestamp an integer. Without this the two sides disagree on what they will
  // accept, and a fractional or out-of-range counter reaches the replay cache.
  if (
    typeof sender !== 'string' ||
    !sender ||
    !Number.isSafeInteger(counter) ||
    counter < 1 ||
    !Number.isSafeInteger(ts)
  ) {
    throw new Error('Invalid v2 envelope metadata');
  }
  if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Message timestamp outside allowed skew');
  }
  if (localDeviceId && sender === localDeviceId) {
    throw new Error('Ignoring self-originated message');
  }

  if (cipherEnabled) {
    // Desktop requires a string here. Accepting an already-parsed object too
    // would mean the two runtimes admit different envelopes off the same wire.
    if (typeof payload !== 'string') {
      throw new Error('Encrypted payload must be a string');
    }
    const parsed = JSON.parse(payload);
    // "bound" travels outside the AEAD, so it is attacker-mutable. Treat
    // anything other than a bound envelope as legacy and refuse it by
    // default: honouring bound=false would let a tamperer skip the metadata
    // check and rewrite sender/counter/ts at will.
    if (parsed.bound === true || parsed.bound === 'true') {
      const plain = await AesGcmCrypto.decrypt(
        parsed.ciphertext,
        hashedPassword,
        Buffer.from(parsed.nonce, 'base64').toString('hex'),
        Buffer.from(parsed.tag, 'base64').toString('hex'),
        false,
      );
      const inner = JSON.parse(plain);
      if (
        inner.t !== type ||
        inner.d !== sender ||
        inner.c !== counter ||
        inner.ts !== ts
      ) {
        throw new Error('Bound metadata mismatch (possible tampering)');
      }
      payload = inner.p;
    } else if (allowLegacyV1) {
      payload = await decryptLegacy(payload, hashedPassword);
    } else {
      throw new Error(
        'Rejected un-bound v2 ciphertext (metadata is not authenticated). ' +
          'Upgrade all devices to 3.2.0+, or enable allowLegacyV1.',
      );
    }
  }

  // Admitted last: only a message that already authenticated under our key
  // may touch replay state. Doing this earlier lets an unauthenticated peer
  // evict real entries or pin a victim's counter to stall its traffic.
  if (replayCache && !replayCache.accept(sender, counter)) {
    throw new Error('Replay or stale counter rejected');
  }

  return {payload, type};
}

async function decryptLegacy(payload, hashedPassword) {
  const encryptedData =
    typeof payload === 'string' ? JSON.parse(payload) : payload;
  return AesGcmCrypto.decrypt(
    encryptedData.ciphertext,
    hashedPassword,
    Buffer.from(encryptedData.nonce, 'base64').toString('hex'),
    Buffer.from(encryptedData.tag, 'base64').toString('hex'),
    false,
  );
}
