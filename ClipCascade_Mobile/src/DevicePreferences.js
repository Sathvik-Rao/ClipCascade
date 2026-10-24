import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEVICE_PREFERENCE_FIELDS = new Set([
  'save_password',
  'max_clipboard_size_local_limit_bytes',
  'relaunch_on_boot',
  'enable_websocket_status_notification',
  'update_notifications',
  'enable_periodic_checks',
  'enable_image_sharing',
  'enable_file_sharing',
]);

export const isValidClipboardLimit = value =>
  value === '' ||
  (/^[0-9]+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0);

// Serialize changes so a slower earlier write cannot overwrite a newer toggle.
let pendingWrites = Promise.resolve();

export const saveDevicePreference = (field, value) => {
  if (!DEVICE_PREFERENCE_FIELDS.has(field)) {
    return Promise.reject(
      new Error('Only device preferences can be autosaved'),
    );
  }
  if (
    field === 'max_clipboard_size_local_limit_bytes'
      ? !isValidClipboardLimit(value)
      : value !== 'true' && value !== 'false'
  ) {
    return Promise.reject(new Error('Invalid device preference'));
  }

  pendingWrites = pendingWrites
    .catch(() => {})
    .then(async () => {
      const entries = [[field, JSON.stringify(value)]];
      if (field === 'save_password' && value === 'false') {
        entries.push(['password', JSON.stringify('')]);
      }
      await AsyncStorage.multiSet(entries);
    });
  return pendingWrites;
};

export const waitForPreferenceWrites = () => pendingWrites;
