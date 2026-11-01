import {Alert, NativeModules} from 'react-native';
import notifee, {EventType} from '@notifee/react-native';
import {downloadDirectoryLabel} from './DownloadDirectory';

// A tap can also be delivered as an initial notification on a cold start.
const handledDownloads = new Set();

export const handleDownloadNotification = async ({type, detail}) => {
  if (type !== EventType.PRESS && type !== EventType.ACTION_PRESS) {
    return;
  }
  const {notification, pressAction} = detail || {};
  const uri = notification?.data?.downloadDirectory;
  if (pressAction?.id !== 'open-download-folder' || !uri) {
    return;
  }
  const key = notification.data.downloadId || `${notification.id}:${uri}`;
  if (handledDownloads.has(key)) {
    return;
  }
  handledDownloads.add(key);
  // Keep this bounded when the service stays alive for a long time.
  if (handledDownloads.size > 50) {
    handledDownloads.delete(handledDownloads.values().next().value);
  }
  try {
    await NativeModules.NativeBridgeModule.openDownloadDirectory(uri);
  } catch (error) {
    handledDownloads.delete(key);
    Alert.alert('Open download folder', `${downloadDirectoryLabel(uri)}\n\n${error.message || String(error)}`);
  }
};

export const openInitialDownloadNotification = async () => {
  try {
    const detail = await notifee.getInitialNotification();
    if (detail) {
      await handleDownloadNotification({type: EventType.PRESS, detail});
    }
  } catch (error) {
    console.warn('Could not read initial download notification', error);
  }
};
