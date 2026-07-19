/**
 * @format
 */

import crypto from 'crypto';
import {Buffer} from 'buffer';
import {
  MAX_TRACKED_SENDERS,
  ReplayCache,
  ensureDeviceId,
  nextCounter,
  wrapOutbound,
  unwrapInbound,
  buildTransportFrame,
  extractTransportEnvelope,
} from '../protocolV2';

// Reproduces ClipCascadeController.sendPrivateMessage: the server rebuilds the
// relayed message from three getters, so every other top-level field is lost.
const relay = frame => ({
  payload: frame.payload,
  type: frame.type || 'text',
  metadata: frame.metadata,
});

const KEY = crypto.randomBytes(32).toString('base64');

const wrap = (payload, store) =>
  wrapOutbound({
    payload,
    type: 'text',
    cipherEnabled: true,
    hashedPassword: KEY,
    store: store ?? {device_id: 'sender', send_counter: 0},
  });

const unwrap = (body, extra) =>
  unwrapInbound({
    body,
    cipherEnabled: true,
    hashedPassword: KEY,
    replayCache: new ReplayCache(),
    ...extra,
  });

// A v2 envelope whose ciphertext will not authenticate under our key.
const forgedEnvelope = (sender, counter) => ({
  v: 2,
  type: 'text',
  senderDeviceId: sender,
  counter,
  ts: Date.now(),
  payload: JSON.stringify({
    nonce: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.from('nope').toString('base64'),
    tag: Buffer.alloc(16).toString('base64'),
    bound: true,
  }),
});

describe('protocolV2', () => {
  test('ReplayCache rejects duplicates', () => {
    const cache = new ReplayCache(8);
    expect(cache.accept('a', 1)).toBe(true);
    expect(cache.accept('a', 1)).toBe(false);
    expect(cache.accept('a', 2)).toBe(true);
    expect(cache.accept('b', 1)).toBe(true);
  });

  test('ReplayCache rejects non-integer counters', () => {
    const cache = new ReplayCache();
    expect(cache.accept('a', 1.5)).toBe(false);
    expect(cache.accept('a', 1e308)).toBe(false);
    expect(cache.accept('a', NaN)).toBe(false);
  });

  test('ReplayCache bounds the number of tracked senders', () => {
    const cache = new ReplayCache();
    for (let i = 0; i < 5000; i++) {
      cache.accept(`junk-${i}`, 1);
    }
    expect(cache.senders.size).toBeLessThanOrEqual(MAX_TRACKED_SENDERS);
  });

  test('ensureDeviceId and counter are monotonic', () => {
    const store = {};
    const id = ensureDeviceId(store);
    expect(id).toBeTruthy();
    expect(store.device_id).toBe(id);
    expect(nextCounter(store)).toBe(1);
    expect(nextCounter(store)).toBe(2);
  });

  test('round-trips an encrypted bound envelope', async () => {
    const env = await wrap('secret-clip');
    expect(env.v).toBe(2);
    const blob = JSON.parse(env.payload);
    expect(blob.bound).toBe(true);

    const out = await unwrap(env);
    expect(out.payload).toBe('secret-clip');
    expect(out.type).toBe('text');
  });

  test('rejects a replayed envelope', async () => {
    const env = await wrap('secret-clip');
    const replayCache = new ReplayCache();
    const args = {cipherEnabled: true, hashedPassword: KEY, replayCache};

    await expect(unwrapInbound({body: env, ...args})).resolves.toMatchObject({
      payload: 'secret-clip',
    });
    await expect(unwrapInbound({body: env, ...args})).rejects.toThrow(/Replay/);
  });

  test('rejects tampering with the outer type', async () => {
    const env = await wrap('secret-clip');
    await expect(unwrap({...env, type: 'image'})).rejects.toThrow(
      /Bound metadata mismatch/,
    );
  });

  test('rejects a legacy v1 message by default', async () => {
    await expect(
      unwrapInbound({
        body: {payload: 'legacy', type: 'text'},
        cipherEnabled: false,
      }),
    ).rejects.toThrow(/Rejected legacy v1/);
  });

  test('accepts a legacy v1 message only when opted in', async () => {
    const out = await unwrapInbound({
      body: {payload: 'legacy', type: 'text'},
      cipherEnabled: false,
      allowLegacyV1: true,
    });
    expect(out.payload).toBe('legacy');
  });

  test('rejects a v1 downgrade of a v2 envelope', async () => {
    const env = await wrap('secret-clip');
    const downgraded = {...env};
    delete downgraded.v;
    await expect(unwrap(downgraded)).rejects.toThrow(/Rejected legacy v1/);
  });

  test('rejects un-bound ciphertext, which sits outside the AEAD', async () => {
    const env = await wrap('secret-clip');
    const blob = JSON.parse(env.payload);
    blob.bound = false;
    await expect(
      unwrap({
        ...env,
        payload: JSON.stringify(blob),
        senderDeviceId: 'attacker-spoofed',
        counter: 9999,
      }),
    ).rejects.toThrow(/Rejected un-bound/);
  });

  test('an unauthenticated flood cannot evict replay history', async () => {
    const env = await wrap('secret-clip');
    const replayCache = new ReplayCache();
    const args = {cipherEnabled: true, hashedPassword: KEY, replayCache};

    await expect(unwrapInbound({body: env, ...args})).resolves.toMatchObject({
      payload: 'secret-clip',
    });

    for (let i = 0; i < 200; i++) {
      await expect(
        unwrapInbound({body: forgedEnvelope(`junk-${i}`, 1), ...args}),
      ).rejects.toThrow();
    }

    // The junk never reached the cache, so the original is still a replay.
    expect(replayCache.senders.size).toBe(1);
    await expect(unwrapInbound({body: env, ...args})).rejects.toThrow(/Replay/);
  });

  test('an unauthenticated message cannot pin a sender counter', async () => {
    const replayCache = new ReplayCache();
    const args = {cipherEnabled: true, hashedPassword: KEY, replayCache};

    await expect(
      unwrapInbound({body: forgedEnvelope('sender', 2000000000), ...args}),
    ).rejects.toThrow();

    // The real sender's next message must still get through.
    const env = await wrap('secret-clip');
    await expect(unwrapInbound({body: env, ...args})).resolves.toMatchObject({
      payload: 'secret-clip',
    });
  });

  test('rejects envelope metadata that protocol_v2.py would reject', async () => {
    // Parity with the desktop implementation: a counter must be a positive safe
    // integer and ts an integer. Divergence here means the two sides disagree
    // on what they accept.
    const base = await wrap('secret-clip');
    const bad = [
      {...base, counter: 0},
      {...base, counter: -1},
      {...base, counter: 1.5},
      {...base, counter: Number.MAX_SAFE_INTEGER + 1},
      {...base, counter: '1'},
      {...base, ts: 1.5},
      {...base, ts: '123'},
      {...base, senderDeviceId: ''},
      {...base, senderDeviceId: 42},
    ];
    for (const body of bad) {
      await expect(unwrap(body)).rejects.toThrow(/Invalid v2 envelope metadata/);
    }
  });

  test('frame carries only fields the server models', async () => {
    // The server does not ignore unknown top-level keys — Jackson raises
    // UnrecognizedPropertyException and drops the message before the handler
    // runs. Confirmed against a real server: the flat envelope relayed nothing.
    const env = await wrap('secret-clip');
    const frame = buildTransportFrame(env, 'text');
    expect(Object.keys(frame).sort()).toEqual(['payload', 'type']);
  });

  test('round-trips through a field-dropping relay', async () => {
    const env = await wrap('secret-clip');
    const relayed = relay(JSON.parse(JSON.stringify(buildTransportFrame(env, 'text'))));
    // The relay keeps only these three keys.
    expect(Object.keys(relayed).sort()).toEqual(['metadata', 'payload', 'type']);

    const out = await unwrapInbound({
      body: extractTransportEnvelope(relayed),
      cipherEnabled: true,
      hashedPassword: KEY,
      replayCache: new ReplayCache(),
      allowLegacyV1: false,
    });
    expect(out.payload).toBe('secret-clip');
    expect(out.type).toBe('text');
  });

  test('the relayed outer type is not trusted', async () => {
    const env = await wrap('secret-clip');
    const relayed = relay(buildTransportFrame(env, 'text'));
    relayed.type = 'files'; // relay-controlled, unauthenticated
    const out = await unwrapInbound({
      body: extractTransportEnvelope(relayed),
      cipherEnabled: true,
      hashedPassword: KEY,
      replayCache: new ReplayCache(),
      allowLegacyV1: false,
    });
    expect(out.type).toBe('text');
  });

  test('extractTransportEnvelope rejects junk without leaking SyntaxError', () => {
    for (const bad of [{payload: 'not json'}, {payload: 5}, {payload: '[]'}, {}, null]) {
      expect(() => extractTransportEnvelope(bad)).toThrow(Error);
    }
  });

  test('a polluted Object.prototype cannot enable legacy v1', async () => {
    // The P2P reassembler used to index a plain object with peer-supplied keys,
    // so one frame could set Object.prototype.allowLegacyV1. A destructuring
    // default only fires on `undefined`, so the inherited value would have won.
    // eslint-disable-next-line no-extend-native
    Object.prototype.allowLegacyV1 = true;
    try {
      expect({}.allowLegacyV1).toBe(true); // pollution is in place
      await expect(
        unwrapInbound({
          body: {payload: 'legacy', type: 'text'},
          cipherEnabled: false,
          replayCache: new ReplayCache(),
        }),
      ).rejects.toThrow(/Rejected legacy v1/);
    } finally {
      delete Object.prototype.allowLegacyV1;
    }
  });

  // The same corpus the Python suite runs, from the same file. Desktop and
  // mobile were asserted to be behaviourally identical for three review rounds
  // without anyone measuring it; when measured they disagreed on 4 of 34
  // envelopes, in host-language details invisible when reading the two files
  // side by side. This is the instrument that detects that class.
  describe('shared cross-runtime corpus', () => {
    // eslint-disable-next-line no-undef
    const corpus = require('../../../ClipCascade_Desktop/src/tests/protocol_corpus.json');
    const now = Date.now();

    corpus.cases.forEach(c => {
      test(`${c.name} -> ${c.expect}`, async () => {
        const envelope = {...c.envelope};
        if (typeof envelope.ts === 'number' && envelope.ts === 0) {
          envelope.ts = now;
        }
        const call = () =>
          unwrapInbound({
            body: envelope,
            cipherEnabled: false,
            replayCache: new ReplayCache(),
            allowLegacyV1: false,
          });

        if (c.expect === 'accept') {
          const out = await call();
          expect(out.payload).toBe(envelope.payload);
        } else {
          await expect(call()).rejects.toThrow();
        }
      });
    });
  });

  test('self-originated messages are ignored', async () => {
    const env = await wrap('secret-clip');
    await expect(unwrap(env, {localDeviceId: 'sender'})).rejects.toThrow(
      /self-originated/,
    );
  });
});
