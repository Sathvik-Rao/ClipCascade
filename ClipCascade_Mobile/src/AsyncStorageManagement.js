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

// Clear all data from async storage
export const clearAsyncStorage = async () => {
  try {
    await AsyncStorage.clear();
  } catch (e) {
    throw e;
  }
};
