(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./BinaryProtocol'));
  else root.ClipCascadeRelay = factory(root.ClipCascadeBinary);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(binary) {
const {recipients} = binary;

// Each WebSocket connection owns one cache. Full snapshots repair missed updates.
class RelayRecipients {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.reset();
  }
  reset() { this.state = null; }
  accept(message) {
    if (message?._cc_control !== 'relay-recipients') return false;
    if (message.version !== 1 || !Number.isSafeInteger(message.revision) || message.revision < 0
        || typeof message.epoch !== 'string' || !message.epoch || message.epoch.length > 128) return true;
    if (this.state && (this.state.epoch !== message.epoch || message.revision <= this.state.revision)) return true;
    const plan = recipients(message);
    const unique = plan && new Set([...plan.binary, ...plan.legacy]).size === plan.binary.length + plan.legacy.length;
    this.state = {epoch: message.epoch, revision: message.revision, received: this.clock(), plan: unique ? plan : null};
    return true;
  }
  get() {
    if (!this.state?.plan || this.clock() - this.state.received >= 60000) return null;
    return {binary: [...this.state.plan.binary], legacy: [...this.state.plan.legacy]};
  }
}

return {RelayRecipients};
});
