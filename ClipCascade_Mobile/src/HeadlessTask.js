import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
} from './AsyncStorageManagement'; // persistent storage
import StartForegroundService from './StartForegroundService'; // foreground service

module.exports = async data => {
  try {
    const enableForegroundService = async () => {
      const requested = await getDataFromAsyncStorage('sync_requested');
      return requested ?? ((await getDataFromAsyncStorage('wsIsRunning')) || 'false');
    };

    if (data && data['event'] === 'BOOT_COMPLETED') {
      const relaunch_on_boot = await getDataFromAsyncStorage(
        'relaunch_on_boot',
      );
      if (relaunch_on_boot !== null && relaunch_on_boot === 'true') {
        if ((await enableForegroundService()) === 'true') {
          await setDataInAsyncStorage('wsStatusMessage', '');
          const result = await StartForegroundService();
          if (result[0] === false) {
            throw result[1];
          }
        }
      }
    }
  } catch (e) {
    console.error('Error in Headless JS Task:', e);
  }
};
