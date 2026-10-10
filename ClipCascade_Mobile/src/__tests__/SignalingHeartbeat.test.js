const { createSignalingHeartbeat } = require('../SignalingHeartbeat');

test('times out after 75 seconds of unanswered pings', () => {
  let time = 0;
  const heartbeat = createSignalingHeartbeat(() => time);
  expect(heartbeat.shouldPing()).toBe(false);
  expect(heartbeat.isStale()).toBe(false);
  heartbeat.connected();
  time = 25000;
  heartbeat.polled();
  expect(heartbeat.shouldPing()).toBe(true);
  heartbeat.markPingSent();
  for (time = 26000; time < 100000; time += 1000) {
    heartbeat.polled();
    expect(heartbeat.isStale()).toBe(false);
  }
  time = 100000;
  heartbeat.polled();
  expect(heartbeat.isStale()).toBe(true);
});

test('PONG clears the unanswered-ping timeout', () => {
  let time = 0;
  const heartbeat = createSignalingHeartbeat(() => time);
  heartbeat.connected();
  time = 25000;
  heartbeat.polled();
  heartbeat.markPingSent();
  time = 44000;
  heartbeat.polled();
  heartbeat.pong();
  time = 60000;
  heartbeat.polled();
  expect(heartbeat.isStale()).toBe(false);
  heartbeat.reset();
  expect(heartbeat.shouldPing()).toBe(false);
  expect(heartbeat.isStale()).toBe(false);
});

test('a suspended Android JS loop gets a fresh probe instead of false timeout', () => {
  let time = 0;
  const heartbeat = createSignalingHeartbeat(() => time);
  heartbeat.connected();
  time = 25000;
  heartbeat.polled();
  heartbeat.markPingSent();
  time = 3600000;
  heartbeat.polled();
  expect(heartbeat.isStale()).toBe(false);
  expect(heartbeat.shouldPing()).toBe(true);
  heartbeat.markPingSent();
  time += 1000;
  heartbeat.polled();
  heartbeat.pong();
  expect(heartbeat.isStale()).toBe(false);
});
