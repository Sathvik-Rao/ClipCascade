import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

/**
 * Secrets must never remain in AsyncStorage (plaintext SQLite).
 * They are stored in Android Keystore / iOS Keychain via react-native-keychain.
 */
export const SECRET_KEYS = new Set([
  'password',
  'hashed_password',
  'csrf_token',
]);

const KEYCHAIN_SERVICE_PREFIX = 'ClipCascade';

const secretService = key => `${KEYCHAIN_SERVICE_PREFIX}/${key}`;

const isEmptySecret = value =>
  value === null ||
  value === undefined ||
  value === '' ||
  value === 'null' ||
  value === 'undefined';

/**
 * Persist a secret in the platform keychain and scrub any legacy AsyncStorage copy.
 */
export const setSecret = async (key, value) => {
  if (!SECRET_KEYS.has(key)) {
    throw new Error(`setSecret called for non-secret key: ${key}`);
  }

  if (isEmptySecret(value)) {
    await Keychain.resetGenericPassword({service: secretService(key)});
    await AsyncStorage.removeItem(key);
    return;
  }

  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value);

  await Keychain.setGenericPassword(key, serialized, {
    service: secretService(key),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  // Scrub any pre-migration plaintext copy.
  await AsyncStorage.removeItem(key);
};

/**
 * Read a secret from keychain; migrate legacy AsyncStorage values on first read.
 */
export const getSecret = async key => {
  if (!SECRET_KEYS.has(key)) {
    throw new Error(`getSecret called for non-secret key: ${key}`);
  }

  try {
    const credentials = await Keychain.getGenericPassword({
      service: secretService(key),
    });
    if (credentials && credentials.password != null) {
      return credentials.password;
    }
  } catch (e) {
    // Fall through to legacy AsyncStorage migration path.
  }

  // Legacy migration: secret still in AsyncStorage.
  const raw = await AsyncStorage.getItem(key);
  if (raw == null) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (!isEmptySecret(parsed)) {
    await setSecret(key, parsed);
  } else {
    await AsyncStorage.removeItem(key);
  }
  return isEmptySecret(parsed) ? null : parsed;
};

/**
 * Clear all known secrets from keychain + AsyncStorage.
 * Throws if any secret remains readable (fail-closed for logout).
 */
export const clearSecrets = async () => {
  const failures = [];
  for (const key of SECRET_KEYS) {
    try {
      await Keychain.resetGenericPassword({service: secretService(key)});
      await AsyncStorage.removeItem(key);
      const remaining = await getSecret(key);
      if (!isEmptySecret(remaining)) {
        failures.push(key);
      }
    } catch (e) {
      failures.push(key);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to clear secrets (fail-closed): ${failures.join(', ')}`,
    );
  }
};

// Save data in async storage (secrets route to keychain)
export const setDataInAsyncStorage = async (key, value) => {
  try {
    if (SECRET_KEYS.has(key)) {
      await setSecret(key, value);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    throw e;
  }
};

// Retrieve data from async storage (secrets from keychain)
export const getDataFromAsyncStorage = async key => {
  try {
    if (SECRET_KEYS.has(key)) {
      return await getSecret(key);
    }
    const value = await AsyncStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  } catch (e) {
    throw e;
  }
};

/**
 * Fetch multiple keys from AsyncStorage in one round-trip.
 * Secret keys are resolved individually via keychain.
 * @param {string[]} keys
 * @returns {Promise<Record<string, any>>} an object mapping each key → its parsed value (or null)
 */
export const getMultipleDataFromAsyncStorage = async keys => {
  try {
    const result = {};
    const plainKeys = [];
    for (const key of keys) {
      if (SECRET_KEYS.has(key)) {
        result[key] = await getSecret(key);
      } else {
        plainKeys.push(key);
      }
    }
    if (plainKeys.length > 0) {
      const stores = await AsyncStorage.multiGet(plainKeys);
      stores.forEach(([key, raw]) => {
        result[key] = raw != null ? JSON.parse(raw) : null;
      });
    }
    return result;
  } catch (e) {
    throw e;
  }
};

// Clear all data from async storage (non-secrets) and wipe secrets from keychain
export const clearAsyncStorage = async () => {
  try {
    await clearSecrets();
    await AsyncStorage.clear();
  } catch (e) {
    throw e;
  }
};
