/* eslint-env jest */

const { NativeModules, PermissionsAndroid } = require('react-native');

NativeModules.NativeBridgeModule = {
  clearCookies: jest.fn(),
  clearImageCache: jest.fn(),
  getFileAsBase64: jest.fn(async () => ''),
  getFileName: jest.fn(async () => 'file.txt'),
  getFileSize: jest.fn(async () => '0'),
  getFlagsSync: jest.fn(() =>
    JSON.stringify({
      wsIsRunning: 'false',
      wsStatusMessage: '',
      server_mode: 'P2S',
      p2pStatusMessage: '',
      filesAvailableToDownload: 'false',
    })
  ),
  stopWorkManager: jest.fn(),
};

PermissionsAndroid.request = jest.fn(async () => 'granted');
global.fetch = jest.fn(async () => ({
  ok: false,
  status: 401,
  text: jest.fn(async () => ''),
  json: jest.fn(async () => ({})),
}));

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    cancelAllNotifications: jest.fn(),
    cancelNotification: jest.fn(),
    createChannel: jest.fn(async () => 'default'),
    displayNotification: jest.fn(),
    openBatteryOptimizationSettings: jest.fn(),
    openPowerManagerSettings: jest.fn(),
    registerForegroundService: jest.fn(),
    stopForegroundService: jest.fn(),
  },
  AndroidImportance: {
    HIGH: 4,
  },
}));

jest.mock('@react-native-documents/picker', () => ({
  pickDirectory: jest.fn(),
  isCancel: jest.fn(() => false),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('react-native-keychain', () => {
  const store = new Map();
  return {
    ACCESSIBLE: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    },
    setGenericPassword: jest.fn(async (username, password, options = {}) => {
      store.set(options.service || 'default', {username, password});
      return true;
    }),
    getGenericPassword: jest.fn(async (options = {}) => {
      const entry = store.get(options.service || 'default');
      return entry || false;
    }),
    resetGenericPassword: jest.fn(async (options = {}) => {
      store.delete(options.service || 'default');
      return true;
    }),
    // Test helper (not used by app code)
    __store: store,
  };
});

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
  RTCIceCandidate: jest.fn(),
  RTCSessionDescription: jest.fn(),
}));

// Real AES-256-GCM, mirroring react-native-aes-gcm-crypto's contract: the key
// is base64, the iv/tag are hex, and the ciphertext is base64. Returning bare
// jest.fn() here would make every protocol test vacuous — wrapOutbound and
// unwrapInbound would "pass" while never exercising the cipher path at all.
//
// Caveat: node accepts any GCM iv length, so this cannot catch the 12- vs
// 16-byte nonce difference between the desktop (PyCryptodome) and iOS
// (CryptoKit) implementations. That needs an on-device test.
jest.mock('react-native-aes-gcm-crypto', () => {
  const crypto = require('crypto');
  const {Buffer} = require('buffer');
  return {
    encrypt: jest.fn(async (plainText, _isBinary, keyBase64) => {
      const key = Buffer.from(keyBase64, 'base64');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([
        cipher.update(Buffer.from(plainText, 'utf8')),
        cipher.final(),
      ]);
      return {
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        content: content.toString('base64'),
      };
    }),
    decrypt: jest.fn(async (contentBase64, keyBase64, ivHex, tagHex) => {
      const key = Buffer.from(keyBase64, 'base64');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivHex, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(contentBase64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    }),
  };
});

jest.mock('@react-native-clipboard/clipboard', () => ({
  getString: jest.fn(async () => ''),
  setString: jest.fn(),
}));
