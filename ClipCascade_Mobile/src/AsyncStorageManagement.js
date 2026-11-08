import AsyncStorage from '@react-native-async-storage/async-storage'; // persistent storage
import {NativeModules} from 'react-native';

const protectedKeys = new Set(['password', 'hashed_password', 'csrf_token']);

// Save data in async storage
export const setDataInAsyncStorage = async (key, value) => {
  if (protectedKeys.has(key)) {
    await NativeModules.NativeBridgeModule.writeProtectedValue(key, value ?? '');
    return;
  }
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw e;
  }
};

// Retrieve data from async storage
export const getDataFromAsyncStorage = async key => {
  if (protectedKeys.has(key)) {
    return NativeModules.NativeBridgeModule.readProtectedValue(key);
  }
  try {
    const value = await AsyncStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch (e) {
    throw e;
  }
};

/**
 * Fetch multiple keys from AsyncStorage in one round-trip.
 * @param {string[]} keys
 * @returns {Promise<Record<string, any>>} an object mapping each key → its parsed value (or null)
 */
export const getMultipleDataFromAsyncStorage = async keys => {
  try {
    const stores = await AsyncStorage.multiGet(keys.filter(key => !protectedKeys.has(key)));
    const result = {};
    stores.forEach(([key, raw]) => {
      result[key] = raw != null ? JSON.parse(raw) : null;
    });
    for (const key of keys.filter(key => protectedKeys.has(key))) {
      result[key] = await getDataFromAsyncStorage(key);
    }
    return result;
  } catch (e) {
    throw e;
  }
};

// Clear all data from async storage
export const clearAsyncStorage = async () => {
  try {
    await AsyncStorage.clear();
  } catch (e) {
    throw e;
  }
};

// Publish related transport fields in one storage operation.
export const saveTransportSettings = async settings => {
  const keys = ['server_mode', 'websocket_url', 'stun_url', 'maxsize'];
  await AsyncStorage.multiSet(keys.map(key => [key, JSON.stringify(settings[key])]));
};
