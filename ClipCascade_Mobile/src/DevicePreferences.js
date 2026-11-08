import AsyncStorage from '@react-native-async-storage/async-storage';
import {setDataInAsyncStorage} from './AsyncStorageManagement';

export const DEVICE_PREFERENCE_FIELDS = new Set([
  'save_password',
  'relaunch_on_boot',
  'enable_websocket_status_notification',
  'update_notifications',
  'download_notifications',
  'enable_periodic_checks',
  'enable_image_sharing',
  'enable_file_sharing',
  'send_clipboard',
  'receive_clipboard',
  'show_android_setup_guide',
]);

export const isValidClipboardLimit = value =>
  value === '' ||
  (/^[0-9]+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0);

// Serialize changes so a slower earlier write cannot overwrite a newer toggle.
let pendingWrites = Promise.resolve();

const queuePreferenceWrite = write => {
  pendingWrites = pendingWrites.catch(() => {}).then(write);
  return pendingWrites;
};

export const saveDevicePreference = (field, value) => {
  if (!DEVICE_PREFERENCE_FIELDS.has(field)) {
    return Promise.reject(
      new Error('Only device preferences can be autosaved'),
    );
  }
  if (value !== 'true' && value !== 'false') {
    return Promise.reject(new Error('Invalid device preference'));
  }

  return queuePreferenceWrite(async () => {
    if (field === 'save_password' && value === 'false') {
      await setDataInAsyncStorage('password', '');
    }
    await AsyncStorage.setItem(field, JSON.stringify(value));
  });
};

export const saveClipboardLimit = (bytes, display) =>
  queuePreferenceWrite(() =>
    AsyncStorage.multiSet([
      ['max_clipboard_size_local_limit_bytes', JSON.stringify(bytes)],
      ['clipboard_limit_display', JSON.stringify(display)],
    ]),
  );

export const waitForPreferenceWrites = () => pendingWrites;

// Read persisted values for every operation so a headless service sees UI changes.
// Missing preferences preserve two-way sync for existing installations.
export const isClipboardSyncEnabled = async field => {
  await pendingWrites.catch(() => {});
  const raw = await AsyncStorage.getItem(field);
  return raw === null || JSON.parse(raw) !== 'false';
};
