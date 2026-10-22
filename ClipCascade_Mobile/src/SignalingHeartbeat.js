const SIGNALING_PING_INTERVAL_MS = 25000;
const SIGNALING_PONG_TIMEOUT_MS = 75000;
const SIGNALING_POLL_GAP_MS = 30000;

function createSignalingHeartbeat(now = Date.now) {
  let lastPingAt = null;
  let pendingPingAt = null;
  let lastPollAt = null;

  return {
    connected() {
      lastPingAt = now();
      pendingPingAt = null;
      lastPollAt = now();
    },
    pong() {
      pendingPingAt = null;
    },
    polled() {
      const current = now();
      if (lastPollAt !== null && current - lastPollAt > SIGNALING_POLL_GAP_MS) {
        // Android may suspend the JS event loop while backgrounded. On resume,
        // require a fresh unanswered ping before declaring this socket stale.
        pendingPingAt = null;
        lastPingAt = current - SIGNALING_PING_INTERVAL_MS;
      }
      lastPollAt = current;
    },
    shouldPing() {
      return (
        lastPingAt !== null && now() - lastPingAt >= SIGNALING_PING_INTERVAL_MS
      );
    },
    markPingSent() {
      lastPingAt = now();
      if (pendingPingAt === null) {
        pendingPingAt = lastPingAt;
      }
    },
    isStale() {
      return (
        pendingPingAt !== null &&
        now() - pendingPingAt >= SIGNALING_PONG_TIMEOUT_MS
      );
    },
    reset() {
      lastPingAt = null;
      pendingPingAt = null;
      lastPollAt = null;
    },
  };
}

module.exports = { createSignalingHeartbeat };
