export const validContentSize = value => Number.isSafeInteger(value) && value >= 0;

export function normalizeReceiveLimit(value) {
  if (value == null || value === '' || value === 'unlimited') return null;
  const number = typeof value === 'number' ? value : (/^[0-9]+$/.test(value) ? Number(value) : null);
  return validContentSize(number) ? number : null;
}

export const receiveLimitHeader = limit => limit == null ? 'unlimited' : String(limit);
export const allowsContentSize = (limit, size) => !validContentSize(limit) || !validContentSize(size) || size <= limit;
// Original bytes only. Keep the legacy P2P payload-size field separate so
// older receivers retain their existing behavior.
export const metadataContentSize = metadata => validContentSize(metadata?.contentSizeBytes) ? metadata.contentSizeBytes : null;

export function receiveCapabilityMessage(limit) {
  return JSON.stringify({_cc_keepalive: true, capabilities: {version: 1, transferFormats: ['ccb1'], receiveLimitBytes: limit}});
}

export function readReceiveCapability(message, limits, peer) {
  const capability = message?.capabilities;
  if (capability?.version !== 1 || !Object.prototype.hasOwnProperty.call(capability, 'receiveLimitBytes')) return;
  if (capability.receiveLimitBytes === null || validContentSize(capability.receiveLimitBytes)) {
    limits.set(peer, capability.receiveLimitBytes);
  }
}

export function base64ContentSize(encoded) {
  let length = encoded.length;
  const whitespace = /\s+/g;
  let match;
  while ((match = whitespace.exec(encoded)) !== null) length -= match[0].length;
  let padding = 0;
  for (let end = encoded.length - 1; end >= 0; end--) {
    const char = encoded[end];
    if (char === '=') padding++;
    else if (!/\s/.test(char)) break;
  }
  return Math.floor(length / 4) * 3 - padding;
}
