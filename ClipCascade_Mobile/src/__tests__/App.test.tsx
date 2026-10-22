/**
 * @format
 */

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    cancelAllNotifications: jest.fn(),
    cancelNotification: jest.fn(),
    createChannel: jest.fn(async () => 'ClipCascade'),
    displayNotification: jest.fn(),
    openBatteryOptimizationSettings: jest.fn(),
    openPowerManagerSettings: jest.fn(),
    registerForegroundService: jest.fn(),
    stopForegroundService: jest.fn(),
  },
  AndroidImportance: { HIGH: 4 },
}));

jest.mock('@react-native-documents/picker', () => ({
  pickDirectory: jest.fn(),
  isCancel: jest.fn(() => false),
}));

jest.mock('@react-native-module/pbkdf2', () => ({
  pbkdf2: jest.fn(),
}));

jest.mock('../AsyncStorageManagement', () => ({
  setDataInAsyncStorage: jest.fn(),
  getDataFromAsyncStorage: jest.fn(async () => null),
  getMultipleDataFromAsyncStorage: jest.fn(async () => ({})),
  clearAsyncStorage: jest.fn(),
}));

jest.mock('../StartForegroundService', () =>
  jest.fn(async () => [true, '']),
);

import React from 'react';
import { NativeModules, PermissionsAndroid } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

NativeModules.NativeBridgeModule = {
  clearCookies: jest.fn(),
  clearImageCache: jest.fn(),
  getCookies: jest.fn(async () => ''),
  getFlagsSync: jest.fn(() =>
    JSON.stringify({
      wsIsRunning: 'false',
      wsStatusMessage: '',
      server_mode: 'P2S',
      p2pStatusMessage: '',
      filesAvailableToDownload: 'false',
    }),
  ),
  stopWorkManager: jest.fn(),
};

jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('granted');

global.fetch = jest.fn(async () => ({
  ok: false,
  json: async () => ({}),
  text: async () => '',
})) as jest.Mock;

test('renders correctly', async () => {
  let renderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  await ReactTestRenderer.act(async () => {
    renderer.unmount();
    await new Promise(resolve => setTimeout(resolve, 350));
  });
});
