import AsyncStorage from '@react-native-async-storage/async-storage'; // persistent storage

// Save data in async storage
export const setDataInAsyncStorage = async (key, value) => {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw e;
  }
};

// Retrieve data from async storage
export const getDataFromAsyncStorage = async key => {
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
    const stores = await AsyncStorage.multiGet(keys);
    const result = {};
    stores.forEach(([key, raw]) => {
      result[key] = raw != null ? JSON.parse(raw) : null;
    });
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
