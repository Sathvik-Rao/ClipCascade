import {NativeModules} from 'react-native';
import {pickDirectory} from '@react-native-documents/picker';
import {
  getDataFromAsyncStorage,
  setDataInAsyncStorage,
} from './AsyncStorageManagement';

const PREFERENCE_KEY = 'preferred_download_directory';

export const getDownloadDirectory = () => getDataFromAsyncStorage(PREFERENCE_KEY);

export const clearDownloadDirectory = () => setDataInAsyncStorage(PREFERENCE_KEY, '');

export const isDownloadDirectoryAvailable = uri =>
  NativeModules.NativeBridgeModule.isDownloadDirectoryAvailable(uri);

export const chooseDownloadDirectory = async () => {
  const result = await pickDirectory({requestLongTermAccess: true});
  if (result.bookmarkStatus !== 'success') {
    throw new Error('Unable to keep access to this folder. Please choose another folder.');
  }
  if (!(await isDownloadDirectoryAvailable(result.uri))) {
    throw new Error('This folder is not writable. Please choose another folder.');
  }
  await setDataInAsyncStorage(PREFERENCE_KEY, result.uri);
  return result.uri;
};

export const resolveDownloadDirectory = async () => {
  const uri = await getDownloadDirectory();
  if (!uri) {
    // A one-time destination must not silently become the default after Clear.
    return (await pickDirectory({requestLongTermAccess: false})).uri;
  }
  return (await isDownloadDirectoryAvailable(uri))
    ? uri
    : chooseDownloadDirectory();
};

export const downloadDirectoryLabel = uri => {
  if (!uri) {
    return 'Ask where to save each download';
  }
  try {
    const documentId = decodeURIComponent(uri.split('/tree/')[1]?.split('/document/')[0] || uri);
    if (uri.startsWith('content://com.android.externalstorage.documents/tree/')) {
      const separator = documentId.indexOf(':');
      if (separator !== -1) {
        const volume = documentId.slice(0, separator);
        const path = documentId.slice(separator + 1);
        const root = volume === 'primary' ? 'Internal storage' : `Storage (${volume})`;
        return path ? `${root}/${path}` : root;
      }
    }
    return documentId;
  } catch {
    return uri;
  }
};
