import {Alert, AppState, Linking} from 'react-native';
import notifee, {AndroidImportance} from '@notifee/react-native';
import {getDataFromAsyncStorage} from './AsyncStorageManagement';
import {APP_VERSION} from './AppVersion';

export const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL = 60 * 60 * 1000;
const VERSION_URL =
  'https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json';
export const RELEASE_URL =
  'https://github.com/Sathvik-Rao/ClipCascade/releases/latest';
export const UPDATE_NOTIFICATION_ID = 'ClipCascade_Update';

export const parseVersion = value => {
  if (typeof value !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.trim())) {
    throw new Error('Invalid release version');
  }
  const parts = value.trim().split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error('Invalid release version');
  }
  return parts;
};

export const isNewerVersion = (latest, current) => {
  const remote = parseVersion(latest);
  const installed = parseVersion(current);
  for (let i = 0; i < remote.length; i++) {
    if (remote[i] !== installed[i]) {
      return remote[i] > installed[i];
    }
  }
  return false;
};

// One checker per JS runtime, shared by the screen and foreground service.
let nextCheckAt = 0;
let inFlight = null;
let status = [false, ''];
let alertInFlight = false;
let popupOpen = false;
let focused = true;
const alertedVersions = new Set();
const listeners = new Set();

export const subscribeToUpdates = listener => {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
};

export const presentUpdate = async () => {
  const version = status[1];
  if (!status[0] || alertInFlight || alertedVersions.has(version)) {
    return;
  }
  alertInFlight = true;
  try {
    if ((await getDataFromAsyncStorage('update_notifications')) === 'false') {
      return;
    }
    // Read state after storage access: the app may have moved into the background.
    if (listeners.size && AppState.currentState === 'active' && focused) {
      if (popupOpen) {
        return;
      }
      const dismiss = () => { popupOpen = false; };
      Alert.alert(
        'Update available',
        `ClipCascade ${version} is available (installed: ${APP_VERSION}).`,
        [
          {text: 'Later', style: 'cancel', onPress: dismiss},
          {text: 'Open download page', onPress: () => {
            dismiss();
            Linking.openURL(RELEASE_URL).catch(console.warn);
          }},
        ],
        {cancelable: true, onDismiss: dismiss},
      );
      popupOpen = true;
    } else {
      // Do not consume the alert if Android notification permission is denied.
      const settings = await notifee.getNotificationSettings();
      if (settings.authorizationStatus < 1) {
        return;
      }
      const channelId = await notifee.createChannel({
        id: 'clipcascade_updates', name: 'App updates',
        importance: AndroidImportance.DEFAULT,
      });
      if ((await notifee.getChannel(channelId))?.blocked) {
        return;
      }
      await notifee.displayNotification({
        id: UPDATE_NOTIFICATION_ID,
        title: 'ClipCascade update available',
        body: `Version ${version} is available. Tap to open ClipCascade.`,
        android: {
          channelId, smallIcon: 'ic_small_icon',
          pressAction: {id: 'default'},
        },
      });
    }
    alertedVersions.add(version);
  } catch (error) {
    console.warn('Unable to show update alert:', error);
  } finally {
    alertInFlight = false;
  }
};

export const setUpdateFocused = value => {
  focused = value;
};

export const checkForUpdates = ({force = false} = {}) => {
  if (inFlight) {
    return inFlight;
  }
  if (!force && Date.now() < nextCheckAt) {
    return Promise.resolve(status);
  }
  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(VERSION_URL, {signal: controller.signal});
      if (!response.ok) {
        throw new Error(`Update check HTTP ${response.status}`);
      }
      const manifest = await response.json();
      const newer = isNewerVersion(manifest.android, APP_VERSION);
      status = [newer, manifest.android.trim()];
      nextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL;
      listeners.forEach(listener => listener(status));
    } catch (error) {
      // Preserve the last good result when offline or the manifest is invalid.
      nextCheckAt = Date.now() + RETRY_INTERVAL;
    } finally {
      clearTimeout(timer);
    }
    await presentUpdate();
    return status;
  })().finally(() => { inFlight = null; });
  return inFlight;
};
