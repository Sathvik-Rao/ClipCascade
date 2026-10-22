const { createDataChannelProbes } = require('../DataChannelProbes');

test('bidirectional data-channel payload round trips without clipboard writes', () => {
  let time = 1;
  const a = createDataChannelProbes(() => time);
  const b = createDataChannelProbes(() => time);
  let pongForA = null;
  let pongForB = null;
  expect(
    b.receive('a', a.ping('b'), message => {
      pongForA = message;
    }),
  ).toBe(true);
  expect(a.receive('b', pongForA, () => {})).toBe(true);
  expect(a.verifiedCount(['b'])).toBe(1);
  expect(a.stalePeers()).toEqual([]);
  expect(
    a.receive('b', b.ping('a'), message => {
      pongForB = message;
    }),
  ).toBe(true);
  expect(b.receive('a', pongForB, () => {})).toBe(true);
  expect(b.verifiedCount(['a'])).toBe(1);
  expect(
    a.receive(
      'b',
      JSON.stringify({ payload: 'real clipboard', type: 'text' }),
      () => {},
    ),
  ).toBe(false);
});

test('unanswered transport probes time out while successful replies do not', () => {
  let time = 0;
  const health = createDataChannelProbes(() => time);
  const first = health.ping('phone');
  time = 20000;
  expect(health.ping('phone')).toBe(first);
  for (time = 1000; time < 90000; time += 1000) {
    health.poll();
    expect(health.stalePeers()).toEqual([]);
  }
  time = 90000;
  health.poll();
  expect(health.stalePeers()).toEqual(['phone']);
});

test('suspended Android JS loop discards stale probe timers on resume', () => {
  let time = 0;
  const health = createDataChannelProbes(() => time);
  health.ping('glass');
  time = 3600000;
  health.poll();
  expect(health.stalePeers()).toEqual([]);
  expect(health.ping('glass')).not.toContain('"id":"0-1"');
});

test('untrusted pong and old peer cleanup cannot forge a proof', () => {
  let time = 0;
  const health = createDataChannelProbes(() => time);
  health.ping('phone');
  health.receive(
    'phone',
    JSON.stringify({ _cc_probe: 'pong', id: 'forged' }),
    () => {},
  );
  expect(health.verifiedCount(['phone'])).toBe(0);
  health.dropPeer('phone');
  expect(health.stalePeers()).toEqual([]);
});
