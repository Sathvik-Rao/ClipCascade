import {openInitialDownloadNotification} from './DownloadNotifications';
import {
  PermissionsAndroid,
  AppState,
  Image,
  StyleSheet,
  Text,
  View,
  Linking,
  TextInput,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  NativeModules,
  Alert,
  SafeAreaView,
  StatusBar,
  Modal,
  Keyboard,
  useColorScheme,
} from 'react-native';

import { useEffect, useState, useRef } from 'react';

import CheckBox from '@react-native-community/checkbox';

import notifee from '@notifee/react-native';
import { pbkdf2 } from '@react-native-module/pbkdf2';
import { Buffer } from 'buffer';
import {
  pick,
  errorCodes,
  isErrorWithCode,
} from '@react-native-documents/picker';

import { sha3_512 } from 'js-sha3';
import { DOMParser } from 'react-native-html-parser';

import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  getMultipleDataFromAsyncStorage,
  clearAsyncStorage,
} from './AsyncStorageManagement';
import StartForegroundService from './StartForegroundService';
import {LIMIT_UNITS, NO_LOCAL_LIMIT, formatClipboardLimit, parseClipboardLimit} from './ClipboardLimit';
import {authenticateSession} from './LoginSession';
import {APP_VERSION} from './AppVersion';
import {
  getDownloadDirectory,
  clearDownloadDirectory,
  chooseDownloadDirectory,
  resolveDownloadDirectory,
  downloadDirectoryLabel,
} from './DownloadDirectory';
import {
  checkForUpdates, presentUpdate, setUpdateFocused, subscribeToUpdates,
  RELEASE_URL, UPDATE_NOTIFICATION_ID,
} from './UpdateChecker';
import {
  DEVICE_PREFERENCE_FIELDS,
  isValidClipboardLimit,
  saveDevicePreference,
  waitForPreferenceWrites,
} from './DevicePreferences';

const isCancel = error =>
  isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED;

/*
 * These files are part of the ClipCascade project.
 *
 * (file) android\app\src\main\java\com\clipcascade\AsyncStorageBridge.kt
 * (file) android\app\src\main\java\com\clipcascade\BootReceiver.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardContent.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardFloatingActivity.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerPackage.kt
 * (file) android\app\src\main\java\com\clipcascade\HeadlessTaskService.kt
 * (file) android\app\src\main\java\com\clipcascade\MainActivity.kt
 * (file) android\app\src\main\java\com\clipcascade\MainApplication.kt
 * (file) android\app\src\main\java\com\clipcascade\NativeBridgeModule.kt
 * (file) android\app\src\main\java\com\clipcascade\NativeBridgePackage.kt
 * (file) android\app\src\main\java\com\clipcascade\PendingShares.kt
 * (file) android\app\src\main\java\com\clipcascade\ScheduleService.kt
 * (file) android/app/src/main/java/com/clipcascade/ServerTls.kt
 * (file) android/app/src/main/java/com/clipcascade/ServerTlsModule.kt
 * (file) android\app\src\main\AndroidManifest.xml
 * (folder) android\app\src\main\res\
 * (file) android\app\build.gradle
 * (file) android\app\my-upload-key.keystore
 * (file) android\gradle.properties
 * (file) AsyncStorageManagement.js
 * (file) HeadlessTask.js
 * (file) index.js
 * (file) StartForegroundService.js
 * (file) LoginSession.js
 * (file) WebSocketStatus.js
 * (file) DevicePreferences.js
 * (file) DownloadDirectory.js
 * (file) DownloadNotifications.js
 * (file) ClipboardLimit.js
 * (file) FileTransfer.js
 * (file) AppVersion.js
 * (file) UpdateChecker.js
 */

// Main App
function InfoLabel({style, label, info}) {
  const infoColor = useColorScheme() === 'dark' ? '#64b5f6' : '#005ea8';
  return (
    <Text
      style={style}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Shows information about this setting"
      onPress={() => Alert.alert(
        label.replace(/:$/, ''),
        info,
        [{text: 'OK'}],
        {cancelable: true},
      )}>
      {label}{' '}<Text style={[styles.labelInfoMark, {color: infoColor}]}>?</Text>
    </Text>
  );
}

function SettingsGroup({title, children}) {
  const isDark = useColorScheme() === 'dark';
  return (
    <View style={[
      styles.settingsGroup,
      {backgroundColor: isDark ? '#1c1c1e' : '#f8f9fb', borderColor: isDark ? '#3a3a3c' : '#e1e5eb'},
    ]}>
      <Text
        accessibilityRole="header"
        style={[styles.settingsGroupTitle, {color: isDark ? '#e5e7eb' : '#344054'}]}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function ClipboardLimitEditor({draft, onChange, disabled}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isDark = useColorScheme() === 'dark';
  const colors = {
    color: isDark ? '#f2f2f7' : '#1d2939',
    backgroundColor: isDark ? '#2c2c2e' : '#fff',
    borderColor: isDark ? '#555' : '#cbd2dc',
  };
  return (
    <View style={styles.limitControls}>
      {draft.unit !== NO_LOCAL_LIMIT && (
        <TextInput
          accessibilityLabel="Clipboard size limit amount"
          keyboardType="decimal-pad"
          editable={!disabled}
          style={[styles.limitAmount, colors]}
          value={draft.amount}
          onChangeText={amount => {
            if (/^[0-9]*\.?[0-9]*$/.test(amount)) {
              onChange({...draft, amount});
            }
          }}
        />
      )}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Clipboard size limit unit"
        accessibilityState={{expanded: menuOpen, disabled}}
        disabled={disabled}
        style={[styles.limitUnitButton, colors]}
        onPress={() => {
          Keyboard.dismiss();
          setMenuOpen(true);
        }}
      >
        <Text style={{color: colors.color}}>{draft.unit} ▾</Text>
      </TouchableOpacity>
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <SafeAreaView style={styles.limitMenuSafeArea}>
          <TouchableOpacity
            activeOpacity={1}
            style={styles.limitMenuBackdrop}
            accessibilityLabel="Close size unit menu"
            onPress={() => setMenuOpen(false)}
          >
            <View style={[styles.limitMenu, colors]} accessibilityViewIsModal>
              <Text style={[styles.limitMenuTitle, {color: colors.color}]} accessibilityRole="header">
                Clipboard size unit
              </Text>
              <ScrollView
                style={styles.limitMenuScroll}
                contentContainerStyle={styles.limitMenuContent}
                keyboardShouldPersistTaps="handled"
              >
                {[NO_LOCAL_LIMIT, ...Object.keys(LIMIT_UNITS)].map(unit => (
                  <TouchableOpacity
                    key={unit}
                    accessibilityRole="radio"
                    accessibilityState={{checked: draft.unit === unit}}
                    style={styles.limitMenuOption}
                    onPress={() => {
                      onChange({amount: unit === NO_LOCAL_LIMIT ? '' : draft.amount, unit});
                      setMenuOpen(false);
                    }}
                  >
                    <Text style={{color: colors.color}}>{unit}</Text>
                    {draft.unit === unit && <Text style={{color: colors.color}}>✓</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export default function App() {
  const { NativeBridgeModule } = NativeModules;

  const isMountedRef = useRef(true);
  const loginInProgressRef = useRef(false);
  const foregroundServiceInProgressRef = useRef(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [newVersionAvailable, setNewVersionAvailable] = useState([false, '']);
  const [donateUrl, setDonateUrl] = useState(null);

  // Constants
  const MAX_LOGIN_AUTO_RETRY = 3; // Retry login attempts
  const FETCH_TIMEOUT = 5000; // 5 seconds
  const LOGOUT_URL = '/logout';
  const MAXSIZE_URL = '/max-size';
  const CSRF_URL = '/csrf-token';
  const SERVER_MODE_URL = '/server-mode';
  const WEBSOCKET_ENDPOINT = '/clipsocket';
  const VALIDATE_URL = '/validate-session';
  const WEBSOCKET_ENDPOINT_P2P = '/p2psignaling';
  const STUN_URL = '/stun-url';
  const GITHUB_URL = 'https://github.com/Sathvik-Rao/ClipCascade';
  const APP_NAME = 'ClipCascade';
  const HELP_URL = `${GITHUB_URL}/blob/main/README.md`;
  const METADATA_URL =
    'https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/metadata.json';

  useEffect(() => {
    setUpdateFocused(true);
    PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
      .then(() => presentUpdate()).catch(console.warn);
    const unsubscribe = subscribeToUpdates(setNewVersionAvailable);
    // Check immediately on UI launch, sharing any in-flight service request.
    checkForUpdates({force: true});
    const timer = setInterval(() => checkForUpdates(), 60000);
    const state = AppState.addEventListener('change', value => {
      if (value === 'active') {
        setUpdateFocused(true);
        checkForUpdates();
        presentUpdate();
      }
    });
    const focus = AppState.addEventListener('focus', () => {
      setUpdateFocused(true);
      presentUpdate();
    });
    const blur = AppState.addEventListener('blur', () => setUpdateFocused(false));
    return () => {
      unsubscribe();
      clearInterval(timer);
      state.remove();
      focus.remove();
      blur.remove();
    };
  }, []);

  const fetchTimeout = async (input, init, timeout_ms = FETCH_TIMEOUT) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (e) {
      throw e;
    }
  };

  //data hook
  const [data, setData] = useState({
    cipher_enabled: 'true',
    server_url: 'http://localhost:8080',
    ssl_ca_bundle: '',
    ssl_ca_bundle_name: '',
    websocket_url: '',
    username: '',
    hashed_password: '',
    csrf_token: '',
    maxsize: '',
    hash_rounds: '664937',
    salt: '',
    save_password: 'false',
    max_clipboard_size_local_limit_bytes: '',
    relaunch_on_boot: 'false',
    enable_websocket_status_notification: 'false',
    update_notifications: 'true',
    download_notifications: 'true',
    enable_periodic_checks: 'true',
    send_clipboard: 'true',
    receive_clipboard: 'true',
    enable_image_sharing: 'true',
    enable_file_sharing: 'true',
    server_mode: 'P2S',
    stun_url: '',
  });

  /*
   * Virtual/Helper Async Storage Fields:
   *
   * downloadFiles, filesAvailableToDownload, dirPath, wsStatusMessage, p2pStatusMessage, echo, wsIsRunning,
   * enableWSButton, foreground_service_stopped_running, password, wsForegroundServiceTerminated
   */

  const [clipboardLimitDraft, setClipboardLimitDraft] = useState(() => formatClipboardLimit(''));
  const [clipboardLimitError, setClipboardLimitError] = useState('');

  // get data from async storage
  const getAsyncStorage = async () => {
    try {
      let data_s = { ...data };
      for (const key in data_s) {
        const value = await getDataFromAsyncStorage(key);
        //value === null means there is no key/data in async storage
        if (value !== null) {
          data_s[key] = value;
        }
      }
      return data_s;
    } catch (e) {
      throw e;
    }
  };

  //set data in async storage
  const setAsyncStorage = async data_s => {
    try {
      for (const key in data_s) {
        if (data_s[key] === null) {
          data_s[key] = '';
        }
        await setDataInAsyncStorage(key, data_s[key]);
      }
    } catch (e) {
      throw e;
    }
  };

  // notification
  const onDisplayNotification = async () => {
    try {
      // remove work manager notification if exists
      await notifee.cancelAllNotifications();

      // stop foreground service(if any)
      await notifee.stopForegroundService();

      // start foreground service
      const result = await StartForegroundService();
      if (result[0] === false) {
        throw result[1];
      }
    } catch (e) {
      throw e;
    }
  };

  const clearFiles = async () => {
    try {
      await setDataInAsyncStorage('filesAvailableToDownload', 'false');
      await setDataInAsyncStorage('downloadFiles', 'false');
      await setDataInAsyncStorage('dirPath', '');
      if ((await getDataFromAsyncStorage('fileDownloadInProgress')) !== 'true') {
        await setDataInAsyncStorage('fileDownloadStatus', '');
        setFileDownloadStatus('');
      }
      await notifee.cancelNotification(
        'ClipCascade_Download_Files_Notification_Id',
      );
      setEnableFilesDownloadButton(false);
    } catch (e) {
      throw e;
    }
  };

  const [initError, setInItError] = useState([false, '']);
  useEffect(() => {
    // initialize
    const init = async () => {
      try {
        // enable websocket button
        await setDataInAsyncStorage('enableWSButton', 'true');

        // start polling UI flags
        isMountedRef.current = true;
        pollUIFlags();

        // get data from async storage and initialize data hook
        let data_s = await getAsyncStorage();
        setData(data_s);
        setClipboardLimitDraft(formatClipboardLimit(data_s.max_clipboard_size_local_limit_bytes));
        setClipboardLimitError('');
        setDownloadDirectory((await getDownloadDirectory()) || '');
        await NativeModules.ServerTlsModule.configure(
          data_s.server_url,
          data_s.ssl_ca_bundle,
        );

        // get foreground service status from work manager
        let foregroundServiceStoppedRunning = await getDataFromAsyncStorage(
          'foreground_service_stopped_running',
        );

        // Check if websocket is running, if so directly navigate to next page
        let wsIsRunning_s = await getDataFromAsyncStorage('wsIsRunning');
        if (wsIsRunning_s === null) {
          wsIsRunning_s = 'false';
        }
        // check if foreground service is running
        if (wsIsRunning_s === 'true') {
          let foregroundServiceIsActive = false;

          setLoadingPageMessage('Checking foreground service...');
          await setDataInAsyncStorage('echo', 'ping');
          let iterate = 35; //3500 ms
          while (iterate > 0) {
            await new Promise(resolve => setTimeout(resolve, 100)); //100 ms
            const echo = await getDataFromAsyncStorage('echo');
            if (echo && echo === 'pong') {
              foregroundServiceIsActive = true;
              break;
            }
            iterate--;
          }
          if (!foregroundServiceIsActive) {
            wsIsRunning_s = 'false';
            // A killed process cannot clear its saved status during shutdown.
            // Stop polling the stale messages before clearing storage and UI.
            await setDataInAsyncStorage('wsIsRunning', 'false');
            await setDataInAsyncStorage('wsStatusMessage', '');
            await setDataInAsyncStorage('p2pStatusMessage', '');
            setWsPageMessage('');
            setWsPageP2PMessage('');
            await clearFiles();
          }
        }
        setWsIsRunning(wsIsRunning_s);

        if (wsIsRunning_s === 'true') {
          //enable websocket page
          setEnableLoadingPage(false);
          setEnableWSPage(true);
        } else {
          await setDataInAsyncStorage('p2pStatusMessage', '');
          //validate session
          setLoadingPageMessage('Verifying Session...');
          validResult = await validateSession(data_s);
          setEnableLoadingPage(false);
          if (validResult[0]) {
            //enable websocket page
            setEnableWSPage(true);
            setDataInAsyncStorage('wsIsRunning', 'false');
            // start foreground service (work manager notification click handler)
            if (
              foregroundServiceStoppedRunning &&
              foregroundServiceStoppedRunning === 'true'
            ) {
              foregroundService();
            }
          } else {
            //enable login page
            await setDataInAsyncStorage('wsStatusMessage', '');
            setEnableLoginPage(true);
            setDataInAsyncStorage('wsIsRunning', 'false');
            if (data_s.save_password === 'true') {
              const pass = await getDataFromAsyncStorage('password');
              if (
                pass !== null &&
                pass !== '' &&
                data_s.cipher_enabled !== 'true'
              ) {
                setPassword(pass);
                handleLogin(pass, data_s);
              }
            }
          }
        }

        try {
          const response = await fetchTimeout(METADATA_URL);
          if (!response.ok) {
            throw new Error('Network response was not ok');
          }
          const data = await response.json();
          if (data) {
            setDonateUrl(data.funding);
          }
        } catch (e) {
          // Silent catch
        }
      } catch (e) {
        setInItError([true, e.message]);
      } finally {
        // reset foreground service work manager status
        await setDataInAsyncStorage(
          'foreground_service_stopped_running',
          'false',
        );
      }
    };
    init();

    // cleanup
    return () => {
      isMountedRef.current = false;
      const clearWSStatusMessage = async () => {
        try {
          const wsIsRunning_s = await getDataFromAsyncStorage('wsIsRunning');
          if (wsIsRunning_s !== null && wsIsRunning_s === 'false') {
            await setDataInAsyncStorage('wsStatusMessage', '');
            await setDataInAsyncStorage('p2pStatusMessage', '');
          }
        } catch (error) {
          // Silent catch
        }
      };
      clearWSStatusMessage();
    };
  }, []);

  // Function to convert a server URL to a WebSocket URL
  const convertToWebSocketUrl = async (inputUrl, endpoint) => {
    if (!inputUrl || typeof inputUrl !== 'string') {
      throw new Error('Invalid URL provided');
    }

    inputUrl = inputUrl.trim().replace(/\/+$/, '').toLowerCase(); // Remove trailing slashes and convert to lowercase

    let wsUrl;

    if (inputUrl.startsWith('https://')) {
      wsUrl = inputUrl.replace('https://', 'wss://');
    } else if (inputUrl.startsWith('http://')) {
      wsUrl = inputUrl.replace('http://', 'ws://');
    } else {
      throw new Error(`Unsupported protocol in URL: ${inputUrl}`);
    }

    if (endpoint != null) {
      wsUrl += endpoint;
      wsUrl = wsUrl.replace(/\/+$/, '');
    }

    return wsUrl;
  };

  // Generate a PBKDF2 hash to create an encryption key.
  const hash = async (data_s, password_s) => {
    try {
      const salt = [data_s.username, password_s, data_s.salt].join('');

      const derivedKey = await new Promise((resolve, reject) => {
        pbkdf2(
          Buffer.from(password_s, 'utf8'),
          Buffer.from(salt, 'utf8'),
          Number(data_s.hash_rounds),
          32,
          'sha256',
          (err, key) => {
            if (err) {
              reject([false, err, data_s]);
            } else {
              resolve([true, key, data_s]);
            }
          },
        );
      });

      return derivedKey;
    } catch (error) {
      return [false, error, data_s];
    }
  };

  // SHA3-512 hash for password
  const stringToSHA3_512LowercaseHex = async input => {
    return sha3_512(input).toLowerCase();
  };

  // Function to validate session
  const validateSession = async data_s => {
    try {
      const response = await fetchTimeout(data_s.server_url + VALIDATE_URL, {
        method: 'GET',
      });

      if (response.ok && (await response.text()) === 'OK') {
        return [true, 'Cookie authentication is valid.'];
      } else {
        return [false, 'Cookie authentication is not valid.'];
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return [false, 'Error: Request timed out'];
      }
      return [false, error];
    }
  };

  // Login
  const login = async (data_s, password_s) => {
    try {
      const authentication = await authenticateSession({
        fetchRequest: fetchTimeout,
        serverUrl: data_s.server_url,
        username: data_s.username,
        password: password_s,
        parseCsrfToken: html => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const inputs = doc.getElementsByTagName('input');
          for (let i = 0; i < inputs.length; i++) {
            if (inputs[i].getAttribute('name') === '_csrf') {
              return inputs[i].getAttribute('value');
            }
          }
          return '';
        },
      });
      if (authentication.ok) {
        // get CSRF token
        data_s.csrf_token = await getCSRFToken(data_s);

        // get server mode
        const serverModeResponse = await fetchTimeout(
          data_s.server_url + SERVER_MODE_URL,
          {
            method: 'GET',
          },
        );
        if (!serverModeResponse.ok) {
          return [
            false,
            'Login Successful but unable to get server mode; Status: ' +
              serverModeResponse.status,
            data_s,
          ];
        }
        const serverModeResponseText = await serverModeResponse.text();
        data_s.server_mode = String(JSON.parse(serverModeResponseText).mode);

        if (data_s.server_mode === 'P2P') {
          data_s.maxsize = '-1';

          // get stun url
          const stunUrlResponse = await fetchTimeout(
            data_s.server_url + STUN_URL,
            {
              method: 'GET',
            },
          );
          if (!stunUrlResponse.ok) {
            return [
              false,
              'Login Successful but unable to get stun url; Status: ' +
                stunUrlResponse.status,
              data_s,
            ];
          }
          const stunUrlResponseText = await stunUrlResponse.text();
          data_s.stun_url = String(JSON.parse(stunUrlResponseText).url);

          // convert server_url to websocket url
          data_s.websocket_url = await convertToWebSocketUrl(
            data_s.server_url,
            WEBSOCKET_ENDPOINT_P2P,
          );
        } else if (data_s.server_mode === 'P2S') {
          data_s.stun_url = '';

          // get max size
          const maxSizeResponse = await fetchTimeout(
            data_s.server_url + MAXSIZE_URL,
            {
              method: 'GET',
            },
          );
          if (!maxSizeResponse.ok) {
            return [
              false,
              'Login Successful but unable to get max size; Status: ' +
                maxSizeResponse.status,
              data_s,
            ];
          }
          const maxSizeResponseText = await maxSizeResponse.text();
          data_s.maxsize = String(JSON.parse(maxSizeResponseText).maxsize);

          // convert server_url to websocket url
          data_s.websocket_url = await convertToWebSocketUrl(
            data_s.server_url,
            WEBSOCKET_ENDPOINT,
          );
        }

        // Hash the password for encryption
        if (data_s.cipher_enabled === 'true') {
          hashResult = await hash(data_s, password);
          data_s = hashResult[2];
          if (!hashResult[0]) {
            return [
              false,
              'Login successful but error generating hash: ' + hashResult[1],
              data_s,
            ];
          }
          data_s.hashed_password = hashResult[1].toString('base64');
        }

        return [true, 'Login successful: ' + authentication.status, data_s];
      } else {
        return [false, authentication.message, data_s];
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return [false, 'Error: Request timed out', data_s];
      }
      return [false, 'Error: ' + error, data_s];
    }
  };

  // Get CSRF token
  const getCSRFToken = async data_s => {
    try {
      const response = await fetchTimeout(data_s.server_url + CSRF_URL, {
        method: 'GET',
      });

      const responseData = await response.json();
      if (response.ok) {
        return responseData.token || '';
      }
    } catch (error) {
      return '';
    }
  };

  // Logout
  const logout = async () => {
    try {
      setWsPageMessage('⌛ Please wait...');
      await setDataInAsyncStorage('password', '');
      if (wsIsRunning === 'true') {
        await setDataInAsyncStorage('wsIsRunning', 'false');
        setWsIsRunning('false');
      }

      const formData = new URLSearchParams();
      formData.append('_csrf', await getDataFromAsyncStorage('csrf_token'));

      const response = await fetchTimeout(data.server_url + LOGOUT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      if (response.status == 204) {
        setWsPageMessage('✅ Logout successful: ' + response.status);
      } else {
        setWsPageMessage('❌ Logout failed: ' + response.status);
      }

      await setDataInAsyncStorage('csrf_token', '');
      setEnableWSPage(false);
      setEnableLoginPage(true);
      setLoginStatusMessage('');

      // clear cookies if any
      NativeBridgeModule.clearCookies();
    } catch (error) {
      if (error.name === 'AbortError') {
        setWsPageMessage('❌ Error: Request timed out');
      } else {
        setWsPageMessage('❌ Error: ' + error);
      }
    }
  };

  function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
  }

  async function pollUIFlags() {
    const POLL_KEYS = [
      'wsIsRunning',
      'wsStatusMessage',
      'server_mode',
      'p2pStatusMessage',
      'filesAvailableToDownload',
      'availableFileCount',
      'fileDownloadStatus',
      'fileDownloadInProgress',
      'downloadFiles',
    ];

    while (isMountedRef.current) {
      const json = NativeBridgeModule.getFlagsSync(POLL_KEYS);
      const latest = JSON.parse(json);
      setAvailableFileCount(Number(latest.availableFileCount) || 0);
      setFileDownloadStatus(latest.fileDownloadStatus || '');
      setIsDownloadingFiles(latest.fileDownloadInProgress === 'true' || latest.downloadFiles === 'true');

      if (latest.wsIsRunning === 'true') {
        // Websocket status message
        const msg1 = latest.wsStatusMessage;
        if (msg1 !== null && msg1 !== '') {
          setWsPageMessage(msg1);
        }

        if (latest.server_mode === 'P2P') {
          const msg2 = latest.p2pStatusMessage;
          if (msg2 !== null) {
            setWsPageP2PMessage(msg2);
          }
        }

        // Files available to download
        if (latest.filesAvailableToDownload === 'true') {
          setEnableFilesDownloadButton(true);
        } else {
          setEnableFilesDownloadButton(false);
        }
      }
      await sleep(300);
    }
  }

  // Foreground service handler
  const foregroundService = async () => {
    if (foregroundServiceInProgressRef.current) return;
    foregroundServiceInProgressRef.current = true;
    try {
      if ((await getDataFromAsyncStorage('enableWSButton')) === 'true') {
        await setDataInAsyncStorage('enableWSButton', 'false');
        setWsPageMessage('');
        setWsPageP2PMessage('');
        await clearFiles();
        const wsIsRunning_s = wsIsRunning === 'true' ? 'false' : 'true'; // toggle
        await setDataInAsyncStorage('wsForegroundServiceTerminated', 'false');
        await setDataInAsyncStorage('wsIsRunning', wsIsRunning_s);
        if (wsIsRunning_s === 'true') {
          //start foreground service
          await setDataInAsyncStorage('wsStatusMessage', '');
          await setDataInAsyncStorage('p2pStatusMessage', '');
          setWsPageMessage('🚀 Starting foreground service...');
          await onDisplayNotification();
        } else {
          // wait for 1 sec so that foreground service can be terminated
          setWsPageMessage('⌛ Stopping foreground service...');
          while (
            (await getDataFromAsyncStorage('wsForegroundServiceTerminated')) ===
            'false'
          ) {
            await new Promise(resolve => setTimeout(resolve, 100)); //100 ms
          }
          await notifee.cancelAllNotifications();
          setWsPageMessage('');
          setWsPageP2PMessage('');
        }
        await NativeBridgeModule.clearImageCache();

        setWsIsRunning(wsIsRunning_s);
      }
    } catch (error) {
      setWsPageMessage('❌ Error: ' + error);
    } finally {
      try {
        await setDataInAsyncStorage('enableWSButton', 'true');
      } finally {
        foregroundServiceInProgressRef.current = false;
      }
    }
  };

  /* Loading Page Handlers */
  // State to manage loading page visibility
  const [enableLoadingPage, setEnableLoadingPage] = useState(true);

  // State to manage loading page message
  const [loadingPageMessage, setLoadingPageMessage] = useState('Loading...');

  /* Login Page Handlers */
  // State to manage login page visibility
  const [enableLoginPage, setEnableLoginPage] = useState(false);

  // State to manage visibility of extra config fields
  const [showExtraConfig, setShowExtraConfig] = useState(false);

  // State to manage login status message
  const [loginStatusMessage, setLoginStatusMessage] = useState('');

  // password
  const [password, setPassword] = useState('');

  // Function to handle input changes in the login form
  const handleInputChange = (field, value) => {
    if (loginInProgressRef.current) {
      return;
    }
    try {
      setData(prevData => ({
        ...prevData,
        [field]: value,
      }));
      if (
        DEVICE_PREFERENCE_FIELDS.has(field) &&
        (field !== 'max_clipboard_size_local_limit_bytes' ||
          isValidClipboardLimit(value))
      ) {
        saveDevicePreference(field, value)
          .then(async () => {
            if (field === 'enable_periodic_checks') {
              if (value === 'true') {
                await NativeBridgeModule.startWorkManager();
              } else {
                await NativeBridgeModule.stopWorkManager();
              }
            }
            if (
              field === 'enable_websocket_status_notification' &&
              value === 'false'
            ) {
              await notifee.cancelNotification(
                'ClipCascade_WebSocket_Status_Notification_Id',
              );
            }
            if (field === 'update_notifications' && value === 'false') {
              await notifee.cancelNotification(UPDATE_NOTIFICATION_ID);
            }
            if (field === 'update_notifications' && value === 'true') {
              await presentUpdate();
            }
          })
          .catch(async e => {
            const message = '❌ Unable to save preference: ' + e;
            setLoginStatusMessage(message);
            if (field === 'send_clipboard' || field === 'receive_clipboard') {
              const saved = await getDataFromAsyncStorage(field);
              setData(current => ({...current, [field]: saved ?? 'true'}));
            }
          });
      }
    } catch (e) {
      setLoginStatusMessage('❌ Error: ' + e);
    }
  };

  const handleClipboardLimitChange = draft => {
    setClipboardLimitDraft(draft);
    try {
      const bytes = parseClipboardLimit(draft.amount, draft.unit);
      setClipboardLimitError('');
      handleInputChange('max_clipboard_size_local_limit_bytes', bytes);
    } catch (error) {
      setClipboardLimitError(error.message);
    }
  };

  const renderClipboardSyncSettings = () => (
    <>
      {[
        ['send_clipboard', 'Send Clipboard:', 'Share clipboard changes from this device.'],
        ['receive_clipboard', 'Receive Clipboard:', 'Apply clipboard updates from other devices.'],
      ].map(([field, label, info]) => (
        <View key={field} style={styles.row}>
          <InfoLabel style={styles.label} label={label} info={info} />
          <CheckBox
            disabled={isLoggingIn}
            accessibilityLabel={label}
            value={data[field] === 'true'}
            onValueChange={value => handleInputChange(field, String(value))}
          />
        </View>
      ))}
    </>
  );

  const importCaBundle = async () => {
    try {
      const [file] = await pick({ allowMultiSelection: false, type: ['*/*'] });
      const pem = await NativeModules.ServerTlsModule.importBundle(file.uri);
      setData(previous => ({
        ...previous,
        ssl_ca_bundle: pem,
        ssl_ca_bundle_name: file.name || 'Imported CA bundle',
      }));
      setLoginStatusMessage('CA bundle imported. Log in to save and use it.');
    } catch (error) {
      if (!isCancel(error)) {
        setLoginStatusMessage('❌ ' + error);
      }
    }
  };

  // Function to handle login button press
  const handleLogin = async (pass = null, data_s_c = null) => {
    if (loginInProgressRef.current) {
      return;
    }
    loginInProgressRef.current = true;
    setIsLoggingIn(true);
    try {
      if (!data_s_c && clipboardLimitError) {
        throw new Error(clipboardLimitError);
      }
      if (
        !isValidClipboardLimit(
          (data_s_c || data).max_clipboard_size_local_limit_bytes,
        )
      ) {
        throw new Error(
          'Max Clipboard Size Local Limit must be a positive integer or empty.',
        );
      }
      await waitForPreferenceWrites();
      setLoginStatusMessage('⌛ Please wait...');

      // clear cookies if any
      await NativeBridgeModule.clearCookies();

      let password_s = null;
      if (pass === null) {
        password_s = await stringToSHA3_512LowercaseHex(password);
      } else {
        // saved password
        password_s = pass;
      }

      // synchronous data instead of state hook data for instant updates
      let data_s;
      if (data_s_c !== null) {
        data_s = data_s_c;
      } else {
        data_s = { ...data };
      }

      // remove trailing slashes in server_url
      data_s.server_url = data_s.server_url.replace(/\/+$/, '');

      await NativeModules.ServerTlsModule.configure(
        data_s.server_url,
        data_s.ssl_ca_bundle,
      );

      let iteration = 0;
      let loginResult;
      do {
        iteration++;
        loginResult = await login(data_s, password_s);
      } while (!loginResult[0] && iteration < MAX_LOGIN_AUTO_RETRY);

      data_s = loginResult[2];
      if (!loginResult[0]) {
        setPassword('');
        setLoginStatusMessage(['❌ ', loginResult[1]].join(''));
      } else {
        setLoginStatusMessage(['✅ ', loginResult[1]].join(''));

        // Stop periodic checks work manager notification (if disabled)
        if (data_s.enable_periodic_checks === 'false') {
          await NativeBridgeModule.stopWorkManager();
        }

        // Save password in async storage
        if (
          data_s.save_password === 'true' &&
          data_s.cipher_enabled !== 'true'
        ) {
          await setDataInAsyncStorage('password', password_s);
        } else {
          await setDataInAsyncStorage('password', '');
        }
        // Remove password from memory
        setPassword('');
        password_s = '';

        // Save data in async storage
        await setAsyncStorage(data_s);

        // Save data_s in data state hook
        setData(data_s);

        // Navigation to the websocket screen
        setEnableLoginPage(false);
        setEnableWSPage(true);
        setWsPageMessage('');
        setWsPageP2PMessage('');
      }
    } catch (e) {
      setLoginStatusMessage('❌ Error: ' + e);
    } finally {
      loginInProgressRef.current = false;
      setIsLoggingIn(false);
    }
  };

  /* Websocket Page Handlers */
  // State to manage websocket page visibility
  const [enableWSPage, setEnableWSPage] = useState(false);

  // State to manage websocket status
  const [wsIsRunning, setWsIsRunning] = useState('false');

  // State to manage websocket page message
  const [wsPageMessage, setWsPageMessage] = useState('');

  // State to manage websocket page p2p message
  const [wsPageP2PMessage, setWsPageP2PMessage] = useState('');

  // files download button
  const [enableFilesDownloadButton, setEnableFilesDownloadButton] =
    useState(false);

  const [availableFileCount, setAvailableFileCount] = useState(0);
  const [fileDownloadStatus, setFileDownloadStatus] = useState('');
  const [isDownloadingFiles, setIsDownloadingFiles] = useState(false);
  const [downloadDirectory, setDownloadDirectory] = useState('');
  const [isChoosingDownloadDirectory, setIsChoosingDownloadDirectory] = useState(false);
  const downloadActionInProgress = useRef(false);

  const selectDownloadDirectory = async () => {
    const uri = await chooseDownloadDirectory();
    setDownloadDirectory(uri);
    return uri;
  };

  const changeDownloadDirectory = async (clear = false) => {
    if (downloadActionInProgress.current || isDownloadingFiles) {
      return;
    }
    downloadActionInProgress.current = true;
    setIsChoosingDownloadDirectory(true);
    try {
      if (clear) {
        await clearDownloadDirectory();
        setDownloadDirectory('');
      } else {
        await selectDownloadDirectory();
      }
    } catch (error) {
      if (!isCancel(error)) {
        Alert.alert('Download folder', error.message || String(error));
      }
    } finally {
      downloadActionInProgress.current = false;
      setIsChoosingDownloadDirectory(false);
    }
  };

  const renderDownloadDirectorySetting = () => (
    <View style={styles.row}>
      <View style={styles.caDetails}>
        <InfoLabel
          style={styles.caLabel}
          label="Default download folder:"
          info="Choose a folder once to use it for future downloads. Access is saved across app and device restarts. Clear the default to choose a folder for each download instead. If access is lost or the folder becomes unavailable, choose a folder again. Android may require a subfolder such as Downloads/ClipCascade instead of the main Downloads folder. Changes are saved immediately."
        />
        <Text style={styles.caFileName}>
          {downloadDirectoryLabel(downloadDirectory)}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.caButton}
        onPress={() => changeDownloadDirectory()}
        disabled={isChoosingDownloadDirectory || isDownloadingFiles || isLoggingIn}
        accessibilityRole="button"
        accessibilityLabel="Change download folder"
      >
        <Text style={styles.caButtonText}>{downloadDirectory ? 'Change' : 'Choose'}</Text>
      </TouchableOpacity>
      {downloadDirectory !== '' && (
        <TouchableOpacity
          style={[styles.caButton, styles.caRemoveButton]}
          onPress={() => changeDownloadDirectory(true)}
          disabled={isChoosingDownloadDirectory || isDownloadingFiles || isLoggingIn}
          accessibilityRole="button"
          accessibilityLabel="Clear default download folder"
        >
          <Text style={styles.caButtonText}>Clear</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  useEffect(() => {
    openInitialDownloadNotification();
  }, []);

  // download files
  const downloadFiles = async () => {
    if (downloadActionInProgress.current || isDownloadingFiles) {
      return;
    }
    downloadActionInProgress.current = true;
    setIsChoosingDownloadDirectory(true);
    try {
      if (
        (await getDataFromAsyncStorage('filesAvailableToDownload')) === 'true'
      ) {
        const uri = await resolveDownloadDirectory();
        setDownloadDirectory((await getDownloadDirectory()) || '');
        await setDataInAsyncStorage('dirPath', uri);
        await setDataInAsyncStorage('fileDownloadStatus', 'Download queued…');
        await setDataInAsyncStorage('downloadFiles', 'true');
        setFileDownloadStatus('Download queued…');
        setIsDownloadingFiles(true);
      } else {
        setEnableFilesDownloadButton(false);
      }
    } catch (e) {
      if (!isCancel(e)) {
        Alert.alert('Download failed', e.message || String(e));
      }
    } finally {
      downloadActionInProgress.current = false;
      setIsChoosingDownloadDirectory(false);
    }
  };

  // view
  if (initError[0]) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          paddingTop: StatusBar.currentHeight,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <View style={styles.loadingContainer}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>
          <View style={styles.loadingBottomContainer}>
            <Text style={styles.loadingText}>Init Error: {initError[1]}</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView
      style={{
        flex: 1,
        paddingTop: StatusBar.currentHeight,
      }}
    >
      {/* Loading Page */}
      {enableLoadingPage && (
        <View style={styles.loadingContainer}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>
          <View style={styles.loadingBottomContainer}>
            <Text style={styles.loadingText}>{loadingPageMessage}</Text>
            <ActivityIndicator size="large" />
          </View>
        </View>
      )}
      {/* Login Page */}
      {enableLoginPage && (
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>
          <View style={styles.row}>
            <Text style={styles.label}>Username:</Text>
            <TextInput
              editable={!isLoggingIn}
              style={styles.input}
              value={data.username}
              onChangeText={text => handleInputChange('username', text)}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Password:</Text>
            <TextInput
              editable={!isLoggingIn}
              style={styles.input}
              value={password}
              onChangeText={text => setPassword(text)}
              secureTextEntry
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <InfoLabel
              style={styles.label}
              label="Server URL:"
              info={"Address of your ClipCascade server, including http:// or https://.\n\nExamples:\n• Local network: http://192.168.1.70:8080\n• Domain: https://clipcascade.example.com\n\nUse your server’s address, not your phone’s address. Do not add /login or /clipsocket."}
            />
            <TextInput
              editable={!isLoggingIn}
              style={styles.input}
              value={data.server_url}
              onChangeText={text =>
                handleInputChange('server_url', text.trim())
              }
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <InfoLabel
              style={styles.label}
              label="Enable encryption (recommended):"
              info={"Encrypts clipboard content on your device before sending it. Enabled by default.\n\nNote: all devices sharing clipboard data must use matching encryption settings, including the password, encryption salt, and key derivation iterations."}
            />
            <CheckBox
              disabled={isLoggingIn}
              value={data.cipher_enabled === 'true' ? true : false}
              onValueChange={newValue =>
                handleInputChange('cipher_enabled', String(newValue))
              }
            />
          </View>

          <View style={styles.row}>
            <Text style={styles.label}>Show connection status notifications:</Text>
            <CheckBox
              disabled={isLoggingIn}
              value={
                data.enable_websocket_status_notification === 'true'
                  ? true
                  : false
              }
              onValueChange={newValue =>
                handleInputChange(
                  'enable_websocket_status_notification',
                  String(newValue),
                )
              }
            />
          </View>

          {/* Display login status message */}
          {loginStatusMessage !== '' && (
            <Text style={styles.message}>{loginStatusMessage}</Text>
          )}

          {/* Login Button */}
          <TouchableOpacity
            style={styles.loginButton}
            disabled={isLoggingIn}
            onPress={() => {
              handleLogin(null, null);
            }}
          >
            <Text style={styles.loginButtonText}>Log in</Text>
          </TouchableOpacity>

          {/* Toggle Extra Config as Text */}
          <TouchableOpacity
            onPress={() => setShowExtraConfig(!showExtraConfig)}
          >
            <Text style={styles.linkText}>
              {showExtraConfig
                ? 'Hide advanced settings'
                : 'Show advanced settings'}
            </Text>
          </TouchableOpacity>

          {/* Extra Config Fields (conditionally rendered) */}
          {showExtraConfig && (
            <>
              <SettingsGroup title="Security">
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Key derivation iterations:"
                    info={"Number of iterations used to derive your encryption key. Higher values increase resistance to password guessing, but take longer.\n\nDefault: 664937. Keep the default unless you need a different value.\n\nNote: must be a positive integer and must match on every device."}
                  />
                  <TextInput
                    editable={!isLoggingIn}
                    style={styles.input}
                    value={data.hash_rounds}
                    onChangeText={text =>
                      handleInputChange(
                        'hash_rounds',
                        isNaN(Number(text)) ? data.hash_rounds : text.trim(),
                      )
                    }
                  />
                </View>
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Encryption salt:"
                    info={"Optional extra text mixed into encryption key derivation. Letters, numbers, symbols, and spaces are allowed.\n\nExample: myCustomSalt123\n\nNote: use exactly the same salt on every device, including capitalization and spaces. Leave blank to keep the default. Changing it on only one device prevents decryption between devices."}
                  />
                  <TextInput
                    editable={!isLoggingIn}
                    style={styles.input}
                    value={data.salt}
                    onChangeText={text => handleInputChange('salt', text)}
                    autoCapitalize="none"
                  />
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Store Password Locally (not recommended; only works if encryption is disabled):</Text>
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.save_password === 'true' ? true : false}
                    onValueChange={newValue =>
                      handleInputChange('save_password', String(newValue))
                    }
                  />
                </View>
                <View style={styles.row}>
                  <View style={styles.caDetails}>
                    <InfoLabel
                      style={styles.caLabel}
                      label="Custom CA certificate bundle:"
                      info={"Use this if your server’s HTTPS certificate was issued by a private or internal certificate authority.\n\nExample file: corp-root.pem, containing PEM-encoded CA certificates supplied by your administrator.\n\nLeave empty to use system certificates. Imported certificates are trusted alongside system certificates for your configured server hostname.\n\nNote: log in to save changes. Use Remove and log in to return to system trust only."}
                    />
                    <Text
                      style={styles.caFileName}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {data.ssl_ca_bundle_name || 'Default system certificates'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.caButton}
                    onPress={importCaBundle}
                    disabled={isLoggingIn}
                    accessibilityRole="button"
                    accessibilityLabel="Import custom CA certificate bundle"
                  >
                    <Text style={styles.caButtonText}>
                      {data.ssl_ca_bundle ? 'Replace' : 'Import'}
                    </Text>
                  </TouchableOpacity>
                  {data.ssl_ca_bundle !== '' && (
                    <TouchableOpacity
                      style={[styles.caButton, styles.caRemoveButton]}
                      accessibilityRole="button"
                      accessibilityLabel="Remove custom CA certificate bundle"
                      disabled={isLoggingIn}
                      onPress={() =>
                        setData(previous => ({
                          ...previous,
                          ssl_ca_bundle: '',
                          ssl_ca_bundle_name: '',
                        }))
                      }
                    >
                      <Text style={styles.caButtonText}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </SettingsGroup>
              <SettingsGroup title="Clipboard sharing">
                <View style={styles.limitField}>
                  <InfoLabel
                    style={styles.limitLabel}
                    label="Local clipboard size limit:"
                    info="Limit incoming and outgoing clipboard content. Choose a number and unit, or leave blank for no local limit. Decimals such as 1.5 MiB are supported and rounded to the nearest byte. 1 KiB = 1024 bytes; 1 MiB = 1024 KiB. Server and platform limits still apply."
                  />
                  <ClipboardLimitEditor
                    draft={clipboardLimitDraft}
                    onChange={handleClipboardLimitChange}
                    disabled={isLoggingIn}
                  />
                  {clipboardLimitError !== '' && (
                    <Text accessibilityRole="alert" style={styles.limitError}>
                      {clipboardLimitError}
                    </Text>
                  )}
                </View>
                {renderClipboardSyncSettings()}
                {renderDownloadDirectorySetting()}
                <View style={styles.row}>
                  <Text style={styles.label}>Enable Image Sharing:</Text>
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.enable_image_sharing === 'true' ? true : false}
                    onValueChange={newValue =>
                      handleInputChange('enable_image_sharing', String(newValue))
                    }
                  />
                </View>
                <View style={styles.row}>
                  <Text style={styles.label}>Enable File Sharing:</Text>
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.enable_file_sharing === 'true' ? true : false}
                    onValueChange={newValue =>
                      handleInputChange('enable_file_sharing', String(newValue))
                    }
                  />
                </View>
              </SettingsGroup>
              <SettingsGroup title="Background activity">
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Start on device restart (disable if the READ_LOGS permission is granted via ADB):"
                    info={"Starts ClipCascade after your device restarts. Off by default.\n\nNote: keep this disabled if you granted READ_LOGS via ADB for automatic clipboard monitoring, to avoid interfering with the permission prompt. After restarting, open ClipCascade manually and allow the log-access prompt when shown."}
                  />
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.relaunch_on_boot === 'true' ? true : false}
                    onValueChange={newValue =>
                      handleInputChange('relaunch_on_boot', String(newValue))
                    }
                  />
                </View>
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Enable Periodic Checks:"
                    info={"Checks that clipboard monitoring and the foreground service are running when monitoring starts and periodically in the background, approximately every 15 minutes. Enabled by default.\n\nIf the service has stopped, a notification lets you restart it. Tap the notification to restart the service."}
                  />
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.enable_periodic_checks === 'true' ? true : false}
                    onValueChange={newValue =>
                      handleInputChange(
                        'enable_periodic_checks',
                        String(newValue),
                      )
                    }
                  />
                </View>
              </SettingsGroup>
              <SettingsGroup title="Notifications">
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Notify when an update is available:"
                    info="Checks at startup and once a day while running. Alerts once per new version each session. Enabled by default."
                  />
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.update_notifications === 'true'}
                    onValueChange={value => handleInputChange('update_notifications', String(value))}
                  />
                </View>
                <View style={styles.row}>
                  <InfoLabel
                    style={styles.label}
                    label="Notify when downloads finish:"
                    info="Shows a notification after files are saved. Enabled by default. Saving progress, the in-app result, and download failures remain visible when disabled."
                  />
                  <CheckBox
                    disabled={isLoggingIn}
                    value={data.download_notifications === 'true'}
                    onValueChange={value => handleInputChange('download_notifications', String(value))}
                  />
                </View>
              </SettingsGroup>
            </>
          )}
          {/* Footer */}
          <View style={styles.footerContainer}>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(GITHUB_URL)}
            >
              <Text style={styles.footerText}>GITHUB</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(HELP_URL)}
            >
              <Text style={styles.footerText}>HELP</Text>
            </TouchableOpacity>
            {donateUrl && (
              <TouchableOpacity
                style={styles.spacing}
                onPress={() => Linking.openURL(donateUrl)}
              >
                <Text style={styles.footerText}>DONATE</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.versionText}>
            v{APP_VERSION}
            {newVersionAvailable[1] === APP_VERSION ? ' (latest)' : ''}
          </Text>
        </ScrollView>
      )}

      {/* websocket page */}
      {enableWSPage && (
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>
          <View style={styles.container}>
            <TouchableOpacity
              style={[
                styles.loginButton,
                {
                  backgroundColor: wsIsRunning === 'true' ? '#800020' : 'green',
                },
              ]}
              onPress={foregroundService}
            >
              <Text style={styles.loginButtonText}>
                {wsIsRunning === 'true' ? 'Stop' : 'Start'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.loginButton, { backgroundColor: '#800020' }]}
              onPress={logout}
            >
              <Text style={styles.loginButtonText}>Logout</Text>
            </TouchableOpacity>
            {/* Display websocket status message */}
            {wsPageMessage !== '' && (
              <Text style={styles.message}>{wsPageMessage}</Text>
            )}
            {/* Display p2p status message */}
            {wsPageP2PMessage !== '' && (
              <Text style={styles.message}>{wsPageP2PMessage}</Text>
            )}
            {/* File download button */}
            {enableFilesDownloadButton &&
              enableFilesDownloadButton === true && (
                <TouchableOpacity
                  style={[styles.loginButton, { backgroundColor: '#4bab4e' }]}
                  onPress={downloadFiles}
                  disabled={isChoosingDownloadDirectory || isDownloadingFiles}
                >
                  <Text style={styles.loginButtonText}>
                    {isDownloadingFiles ? '⏳ Downloading…' : `📥 Download ${availableFileCount === 1 ? 'File' : 'Files'}`}
                  </Text>
                </TouchableOpacity>
              )}
            {fileDownloadStatus !== '' && (
              <Text style={styles.message} accessibilityRole="text" accessibilityLiveRegion="polite">
                {fileDownloadStatus}
              </Text>
            )}
            {/* new version display message */}
            {newVersionAvailable[0] && (
              <TouchableOpacity
                onPress={() => Linking.openURL(RELEASE_URL)}
                style={{ marginTop: 10 }}
              >
                <Text
                  style={[
                    styles.message,
                    {
                      color: '#008080',
                      fontWeight: 'bold',
                      textDecorationLine: 'underline',
                    },
                  ]}
                >
                  New version available! 🚀 Click here to update ({APP_VERSION}{' '}
                  ➞ {newVersionAvailable[1]})
                </Text>
              </TouchableOpacity>
            )}
            <View style={{ marginTop: 20, paddingHorizontal: 10 }}>
              <Text
                style={[styles.message, { fontWeight: 'bold', fontSize: 18 }]}
              >
                Instructions
              </Text>

              <View style={{ marginTop: 15 }}>
                <Text
                  style={[
                    styles.label,
                    { fontWeight: 'bold', marginBottom: 5 },
                  ]}
                >
                  Clipboard Sharing on Android 10+:
                </Text>
                <Text style={styles.label}>
                  On Android 10 and above, clipboard monitoring has been
                  restricted for privacy reasons. To share clipboard content
                  using ClipCascade:
                </Text>
                <View style={{ marginTop: 10, marginLeft: 15 }}>
                  <Text style={styles.label}>
                    1. Select the text, image, or files you want to copy.
                  </Text>
                  <Text style={styles.label}>
                    2. Tap 'Share', select 'ClipCascade'.
                  </Text>
                  <Text style={[styles.label, { marginLeft: 15 }]}>(or)</Text>
                  <Text style={[styles.label, { marginLeft: 15 }]}>
                    Tap 'ClipCascade' instead of 'Copy'.
                  </Text>
                </View>
                <Text
                  style={[
                    styles.label,
                    { marginTop: 5, fontSize: 15, fontStyle: 'italic' },
                  ]}
                >
                  There's also a workaround to enable clipboard sharing in the
                  background. Scroll down for setup instructions.
                </Text>
              </View>

              <View style={{ marginTop: 20 }}>
                <Text
                  style={[
                    styles.label,
                    { fontWeight: 'bold', marginBottom: 5 },
                  ]}
                >
                  Background Clipboard Reception:
                </Text>
                <Text style={styles.label}>
                  ClipCascade automatically receives clipboard content in the
                  background. No manual action is required to receive data.
                </Text>
              </View>

              <View style={{ marginTop: 20 }}>
                <Text
                  style={[
                    styles.label,
                    { fontWeight: 'bold', marginBottom: 5 },
                  ]}
                >
                  Important Note:
                </Text>
                <Text style={styles.label}>
                  To ensure uninterrupted performance, please disable battery
                  optimization for ClipCascade. This will prevent the system
                  from stopping the app when it's running in the foreground.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.loginButton, { backgroundColor: 'black' }]}
                onPress={async () =>
                  await notifee.openBatteryOptimizationSettings()
                }
              >
                <Text style={styles.loginButtonText}>
                  Battery Optimization Settings
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginButton, { backgroundColor: 'black' }]}
                onPress={async () => await notifee.openPowerManagerSettings()}
              >
                <Text style={styles.loginButtonText}>
                  Power Manager Settings
                </Text>
              </TouchableOpacity>

              {/* ADB Commands Section */}
              <View style={{ marginTop: 20 }}>
                <Text
                  style={[
                    styles.label,
                    { fontWeight: 'bold', marginBottom: 5 },
                  ]}
                >
                  Automatic Clipboard Monitoring Setup:
                </Text>
                <Text style={styles.label}>
                  On rooted/non-rooted devices, to enable automatic clipboard
                  monitoring you need to execute these 3 ADB commands:
                </Text>
                <View style={{ marginTop: 10, marginLeft: 15 }}>
                  <Text style={styles.label}>
                    1. Enable the READ_LOGS permission:
                  </Text>
                  <Text
                    selectable
                    style={[
                      styles.label,
                      { fontWeight: 'bold', marginLeft: 15 },
                    ]}
                  >
                    {`> adb -d shell pm grant com.clipcascade android.permission.READ_LOGS`}
                  </Text>

                  <Text style={styles.label}>
                    2. Allow "Drawing over other apps", also accessible from
                    Settings:
                  </Text>
                  <Text
                    selectable
                    style={[
                      styles.label,
                      { fontWeight: 'bold', marginLeft: 15 },
                    ]}
                  >
                    {`> adb -d shell appops set com.clipcascade SYSTEM_ALERT_WINDOW allow`}
                  </Text>

                  <Text style={styles.label}>
                    3. Kill the app for the new permissions to take effect:
                  </Text>
                  <Text
                    selectable
                    style={[
                      styles.label,
                      { fontWeight: 'bold', marginLeft: 15 },
                    ]}
                  >
                    {`> adb -d shell am force-stop com.clipcascade`}
                  </Text>
                </View>
              </View>
            </View>
          </View>
          {/* Footer */}
          <View style={styles.footerContainer}>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(GITHUB_URL)}
            >
              <Text style={styles.footerText}>GITHUB</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(HELP_URL)}
            >
              <Text style={styles.footerText}>HELP</Text>
            </TouchableOpacity>
            {donateUrl && (
              <TouchableOpacity
                style={styles.spacing}
                onPress={() => Linking.openURL(donateUrl)}
              >
                <Text style={styles.footerText}>DONATE</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(data.server_url)}
            >
              <Text style={styles.footerText}>HOMEPAGE</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.versionText}>
            v{APP_VERSION}
            {newVersionAvailable[1] === APP_VERSION ? ' (latest)' : ''}
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// view styles
const styles = StyleSheet.create({
  container: {
    padding: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  appTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    textAlign: 'center',
    paddingBottom: 20,
  },
  loadingBottomContainer: {
    position: 'absolute',
    bottom: 30,
    alignItems: 'center',
  },
  loadingText: {
    marginBottom: 10,
    fontSize: 16,
    color: '#555',
  },
  limitField: {
    marginBottom: 16,
  },
  limitLabel: {
    fontSize: 16,
    marginBottom: 8,
  },
  limitControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  limitAmount: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    marginRight: 8,
  },
  limitUnitButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: 6,
  },
  limitError: {
    color: '#d92d20',
    fontSize: 13,
    marginTop: 6,
  },
  limitMenuSafeArea: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  limitMenuBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  limitMenu: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '100%',
    flexShrink: 1,
    alignSelf: 'center',
    borderRadius: 12,
    padding: 16,
  },
  limitMenuScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  limitMenuContent: {
    paddingBottom: 8,
  },
  limitMenuTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  limitMenuOption: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  settingsGroup: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  settingsGroupTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  labelInfoMark: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  label: {
    flex: 1,
    fontSize: 16,
  },
  caDetails: {
    flex: 1,
    paddingRight: 12,
  },
  caLabel: {
    fontSize: 16,
  },
  caFileName: {
    fontSize: 13,
    color: '#777',
    marginTop: 3,
  },
  caButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#5081ab',
    borderRadius: 5,
  },
  caButtonText: {
    color: '#5081ab',
    fontSize: 14,
  },
  caRemoveButton: {
    marginLeft: 8,
  },
  input: {
    flex: 2,
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    borderRadius: 5,
  },
  loginButton: {
    backgroundColor: '#007BFF',
    padding: 10,
    borderRadius: 5,
    alignItems: 'center',
    marginVertical: 10,
  },
  loginButtonText: {
    color: 'white',
    fontSize: 16,
  },
  linkText: {
    color: '#5081ab',
    textDecorationLine: 'underline',
    textAlign: 'center',
    marginVertical: 10,
    fontSize: 18,
  },
  message: {
    color: '#5081ab',
    textAlign: 'center',
    marginVertical: 12,
    fontSize: 16,
  },
  serviceButton: {
    padding: 10,
    borderRadius: 5,
    alignItems: 'center',
    marginVertical: 10,
  },
  instructionsContainer: {
    marginTop: 40,
    paddingHorizontal: 10,
  },
  instructionsHeader: {
    fontWeight: 'bold',
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  instructionBlock: {
    marginTop: 15,
  },
  instructionTitle: {
    fontWeight: 'bold',
    marginBottom: 5,
    fontSize: 16,
  },
  instructionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  instructionSteps: {
    marginTop: 10,
    marginLeft: 15,
  },
  footerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 50,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  footerText: {
    fontSize: 16,
    color: '#5081ab',
    marginTop: 5,
  },
  spacing: {
    marginHorizontal: 12,
  },
  versionText: {
    textAlign: 'center',
    fontSize: 11,
    color: '#9aa0a6',
    marginTop: 4,
    marginBottom: 14,
  },
});
