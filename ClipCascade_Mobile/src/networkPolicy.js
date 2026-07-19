/**
 * Client-side URL policy aligned with desktop Config._allows_insecure_http.
 * Allows HTTP for loopback, RFC1918, Tailscale CGNAT (100.64/10), and *.ts.net.
 */

const TAILSCALE_CGNAT = (() => {
  // 100.64.0.0 – 100.127.255.255
  const start = ipToLong('100.64.0.0');
  const end = ipToLong('100.127.255.255');
  return {start, end};
})();

function ipToLong(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + (Number(oct) & 255), 0) >>> 0;
}

// Each octet must be plain decimal with no leading zero. A leading zero is
// ambiguous: JS Number('064') is 64, but a spec-compliant (WHATWG) parser
// reads it as octal 52. Accepting it would let "100.064.0.1" pass as
// Tailscale CGNAT here while the connection actually goes to 100.52.0.1,
// which is public and routable. React Native's global.URL is a regex
// polyfill that does not normalise the host, so this module cannot rely on
// the URL parser to canonicalise it for us.
const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;

function isIpv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(p => IPV4_OCTET.test(p));
}

export function isPrivateOrMeshHost(host) {
  if (!host || typeof host !== 'string') {
    return false;
  }
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }
  // Only MagicDNS names under the apex, never the public apex itself.
  if (h.endsWith('.ts.net')) {
    return true;
  }
  if (!isIpv4(h)) {
    // Non-IP hostnames that are not MagicDNS: treat as public (require HTTPS).
    return false;
  }
  const parts = h.split('.').map(Number);
  if (parts.some(p => p > 255)) {
    return false;
  }
  // loopback 127.0.0.0/8
  if (parts[0] === 127) {
    return true;
  }
  // RFC1918
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  // link-local 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }
  // Tailscale CGNAT
  const n = ipToLong(h);
  if (n >= TAILSCALE_CGNAT.start && n <= TAILSCALE_CGNAT.end) {
    return true;
  }
  return false;
}

/**
 * @param {string} inputUrl
 * @throws {Error}
 */
export function validateServerUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') {
    throw new Error('Invalid URL provided');
  }
  // Lowercase the scheme before parsing. React Native ships a regex URL
  // polyfill whose hostname getter is anchored to a lowercase ^https?://, so
  // "HTTPS://host" yields an empty hostname and is rejected on device — while
  // jest, running Node's WHATWG URL, lowercases it and passes. Schemes are
  // case-insensitive, and desktop's urlparse already accepts these.
  const trimmed = inputUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/^([A-Za-z][A-Za-z\d+.-]*):/, m => m.toLowerCase());
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL provided');
  }
  if (!parsed.hostname) {
    throw new Error('Server URL must include a hostname');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Server URL must not include embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Server URL must not include query or fragment components');
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error('Server URL must not include a path');
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(`Unsupported protocol in URL: ${inputUrl}`);
  }
  if (scheme === 'http' && !isPrivateOrMeshHost(parsed.hostname)) {
    throw new Error(
      'Refusing insecure HTTP for non-private server. Use HTTPS, a Tailscale/LAN address (100.x / *.ts.net / RFC1918), or enable cleartext only on private mesh.',
    );
  }
  return trimmed;
}
