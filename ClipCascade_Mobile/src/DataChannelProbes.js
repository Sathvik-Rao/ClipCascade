const PROBE_TIMEOUT_MS = 90000;
const POLL_GAP_MS = 30000;

// Checks actual WebRTC payload delivery in both directions, without copying data.
function createDataChannelProbes(now = Date.now) {
  const pending = new Map();
  const verified = new Map();
  let sequence = 0;
  let lastPollAt = now();

  return {
    ping(peerId) {
      if (!pending.has(peerId)) {
        sequence += 1;
        pending.set(peerId, { id: `${now()}-${sequence}`, since: now() });
      }
      return JSON.stringify({ _cc_probe: 'ping', id: pending.get(peerId).id });
    },
    receive(peerId, payload, reply) {
      let message;
      try {
        message = JSON.parse(payload);
      } catch (e) {
        return false;
      }
      if (message?._cc_keepalive === true) {
        return true;
      }
      if (message?._cc_probe === 'ping') {
        if (typeof message.id === 'string') {
          reply(JSON.stringify({ _cc_probe: 'pong', id: message.id }));
        }
        return true;
      }
      if (message?._cc_probe === 'pong') {
        if (pending.get(peerId)?.id === message.id) {
          pending.delete(peerId);
          verified.set(peerId, now());
        }
        return true;
      }
      return false;
    },
    poll() {
      const current = now();
      // JS timers are suspended while Android sleeps. Probe again on resume.
      if (current - lastPollAt > POLL_GAP_MS) {
        pending.clear();
      }
      lastPollAt = current;
    },
    stalePeers() {
      return [...pending.entries()]
        .filter(([, request]) => now() - request.since >= PROBE_TIMEOUT_MS)
        .map(([peer]) => peer);
    },
    verifiedCount(openPeers) {
      return openPeers.filter(peer => verified.has(peer)).length;
    },
    dropPeer(peerId) {
      pending.delete(peerId);
      verified.delete(peerId);
    },
    reset() {
      pending.clear();
      verified.clear();
      lastPollAt = now();
    },
  };
}

module.exports = { createDataChannelProbes };
