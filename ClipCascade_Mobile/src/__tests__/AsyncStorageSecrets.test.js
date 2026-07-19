/**
 * @format
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {
  SECRET_KEYS,
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  clearSecrets,
  setSecret,
  getSecret,
} from '../AsyncStorageManagement';

beforeEach(async () => {
  await AsyncStorage.clear();
  Keychain.__store.clear();
  jest.clearAllMocks();
});

describe('mobile secret storage', () => {
  test('SECRET_KEYS covers password material', () => {
    expect(SECRET_KEYS.has('password')).toBe(true);
    expect(SECRET_KEYS.has('hashed_password')).toBe(true);
    expect(SECRET_KEYS.has('csrf_token')).toBe(true);
  });

  test('secrets are stored in keychain, not AsyncStorage', async () => {
    await setDataInAsyncStorage('password', 'sha3-auth-hash');
    await setDataInAsyncStorage('hashed_password', 'base64-aes-key');
    await setDataInAsyncStorage('csrf_token', 'csrf-value');
    await setDataInAsyncStorage('username', 'alice');

    expect(await AsyncStorage.getItem('password')).toBeNull();
    expect(await AsyncStorage.getItem('hashed_password')).toBeNull();
    expect(await AsyncStorage.getItem('csrf_token')).toBeNull();
    expect(await AsyncStorage.getItem('username')).not.toBeNull();

    expect(await getDataFromAsyncStorage('password')).toBe('sha3-auth-hash');
    expect(await getDataFromAsyncStorage('hashed_password')).toBe(
      'base64-aes-key',
    );
    expect(await getDataFromAsyncStorage('csrf_token')).toBe('csrf-value');
    expect(await getDataFromAsyncStorage('username')).toBe('alice');
  });

  test('migrates legacy AsyncStorage secrets into keychain', async () => {
    await AsyncStorage.setItem('password', JSON.stringify('legacy-pass'));
    await AsyncStorage.setItem(
      'hashed_password',
      JSON.stringify('legacy-aes-key'),
    );

    expect(await getSecret('password')).toBe('legacy-pass');
    expect(await getSecret('hashed_password')).toBe('legacy-aes-key');

    // Scrubbed from AsyncStorage after migration.
    expect(await AsyncStorage.getItem('password')).toBeNull();
    expect(await AsyncStorage.getItem('hashed_password')).toBeNull();

    // Still readable from keychain.
    expect(await getDataFromAsyncStorage('password')).toBe('legacy-pass');
    expect(await getDataFromAsyncStorage('hashed_password')).toBe(
      'legacy-aes-key',
    );
  });

  test('clearSecrets wipes keychain and AsyncStorage copies', async () => {
    await setSecret('password', 'p');
    await setSecret('hashed_password', 'h');
    await setSecret('csrf_token', 'c');
    await AsyncStorage.setItem('password', JSON.stringify('stale'));

    await clearSecrets();

    expect(await getDataFromAsyncStorage('password')).toBeNull();
    expect(await getDataFromAsyncStorage('hashed_password')).toBeNull();
    expect(await getDataFromAsyncStorage('csrf_token')).toBeNull();
    expect(await AsyncStorage.getItem('password')).toBeNull();
  });

  test('empty secret write removes keychain entry', async () => {
    await setDataInAsyncStorage('csrf_token', 'token');
    expect(await getDataFromAsyncStorage('csrf_token')).toBe('token');

    await setDataInAsyncStorage('csrf_token', '');
    expect(await getDataFromAsyncStorage('csrf_token')).toBeNull();
  });
});
