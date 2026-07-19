/**
 * @format
 */

import {isPrivateOrMeshHost, validateServerUrl} from '../networkPolicy';

describe('networkPolicy (Tailscale / private mesh)', () => {
  test('allows Tailscale CGNAT and MagicDNS', () => {
    expect(isPrivateOrMeshHost('100.64.0.1')).toBe(true);
    expect(isPrivateOrMeshHost('100.127.255.255')).toBe(true);
    expect(isPrivateOrMeshHost('clipcascade.tail-abc.ts.net')).toBe(true);
  });

  test('allows LAN and loopback', () => {
    expect(isPrivateOrMeshHost('192.168.1.5')).toBe(true);
    expect(isPrivateOrMeshHost('10.0.0.2')).toBe(true);
    expect(isPrivateOrMeshHost('172.16.0.1')).toBe(true);
    expect(isPrivateOrMeshHost('localhost')).toBe(true);
    expect(isPrivateOrMeshHost('127.0.0.1')).toBe(true);
  });

  test('rejects public hosts for mesh helper', () => {
    expect(isPrivateOrMeshHost('example.com')).toBe(false);
    expect(isPrivateOrMeshHost('8.8.8.8')).toBe(false);
    expect(isPrivateOrMeshHost('100.63.255.255')).toBe(false); // outside CGNAT
    expect(isPrivateOrMeshHost('100.128.0.1')).toBe(false); // outside CGNAT
  });

  test('rejects octets with a leading zero', () => {
    // Number('064') is 64, but a WHATWG parser reads 064 as octal 52. Treating
    // this as CGNAT would let a request to the public 100.52.0.1 through as
    // cleartext. React Native's global.URL is a regex polyfill and does not
    // normalise the host, so the check cannot lean on the URL parser.
    expect(isPrivateOrMeshHost('100.064.0.1')).toBe(false);
    expect(isPrivateOrMeshHost('010.0.0.1')).toBe(false);
    expect(isPrivateOrMeshHost('192.168.01.1')).toBe(false);
    expect(() => validateServerUrl('http://100.064.0.1:8080')).toThrow(
      /insecure HTTP/,
    );
    // Plain zero octets are still legitimate.
    expect(isPrivateOrMeshHost('10.0.0.1')).toBe(true);
  });

  test('does not treat the ts.net apex itself as a mesh host', () => {
    expect(isPrivateOrMeshHost('ts.net')).toBe(false);
    expect(isPrivateOrMeshHost('evilts.net')).toBe(false);
    expect(isPrivateOrMeshHost('box.ts.net.evil.com')).toBe(false);
  });

  test('validateServerUrl accepts private HTTP and public HTTPS', () => {
    expect(validateServerUrl('http://100.64.1.2:8080')).toBe(
      'http://100.64.1.2:8080',
    );
    expect(validateServerUrl('http://box.ts.net:8080/')).toBe(
      'http://box.ts.net:8080',
    );
    expect(validateServerUrl('https://example.com')).toBe('https://example.com');
  });

  test('validateServerUrl rejects public HTTP', () => {
    expect(() => validateServerUrl('http://example.com')).toThrow(/insecure HTTP/);
  });

  // Jest runs on Node's WHATWG URL; the app runs on React Native's regex URL
  // polyfill. They disagree, so a suite that only exercises Node validates a
  // parser that never ships. Re-run the policy against the real one.
  describe('under React Native\'s shipped URL polyfill', () => {
    const NodeURL = global.URL;
    let RNURL;
    try {
      // eslint-disable-next-line no-undef
      RNURL = require('react-native/Libraries/Blob/URL').URL;
    } catch {
      RNURL = null;
    }

    beforeAll(() => {
      if (RNURL) {
        global.URL = RNURL;
      }
    });
    afterAll(() => {
      global.URL = NodeURL;
    });

    test('the polyfill is actually in use', () => {
      if (!RNURL) {
        return; // RN internals moved; the assertions below still run on Node.
      }
      expect(global.URL).toBe(RNURL);
    });

    test('accepts an uppercase scheme (regression: broke only on device)', () => {
      expect(() => validateServerUrl('HTTPS://clip.example.com')).not.toThrow();
      expect(() => validateServerUrl('HTTP://192.168.1.5:8080')).not.toThrow();
    });

    test('still allows the mesh and rejects public cleartext', () => {
      expect(validateServerUrl('http://100.64.1.2:8080')).toBe(
        'http://100.64.1.2:8080',
      );
      expect(() => validateServerUrl('http://example.com')).toThrow(
        /insecure HTTP/,
      );
    });

    test('still rejects leading-zero octets', () => {
      expect(() => validateServerUrl('http://100.064.0.1:8080')).toThrow(
        /insecure HTTP/,
      );
    });
  });
});
