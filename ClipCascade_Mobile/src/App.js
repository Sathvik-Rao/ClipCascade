import {discoverServer} from './ServerDiscovery';
import {openInitialDownloadNotification} from './DownloadNotifications';
import {
  PermissionsAndroid,
  findNodeHandle,
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
import Clipboard from '@react-native-clipboard/clipboard';

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
 * (file) android\app\src\main\java\com\clipcascade\PermissionGrantService.kt
 * (file) android\app\src\main\java\com\clipcascade\ShizukuPermissionsModule.kt
 * (file) android\app\src\main\aidl\com\clipcascade\IPermissionGrantService.aidl
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
 * (file) ServerDiscovery.js
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
  const isDark = useColorScheme() === 'dark';
  const [showSetupGuide, setShowSetupGuide] = useState(true);
  const setupGuidePreference = useRef({visible: true, changed: false});

  useEffect(() => {
    let active = true;
    getDataFromAsyncStorage('show_android_setup_guide')
      .then(value => {
        // A late storage read must not undo a user's tap.
        if (active && !setupGuidePreference.current.changed) {
          const visible = value !== 'false';
          setupGuidePreference.current.visible = visible;
          setShowSetupGuide(visible);
        }
      })
      .catch(console.warn);
    return () => { active = false; };
  }, []);

  const toggleSetupGuide = () => {
    const visible = !setupGuidePreference.current.visible;
    setupGuidePreference.current = {visible, changed: true};
    setShowSetupGuide(visible);
    saveDevicePreference('show_android_setup_guide', String(visible))
      .catch(() => Alert.alert(
        'Could not save preference',
        'Your setup guide preference could not be saved. It may reset when you reopen the app.',
      ));
  };
  const [copiedCommand, setCopiedCommand] = useState('');
  const [showShizukuSetup, setShowShizukuSetup] = useState(false);
  const [grantingPermissions, setGrantingPermissions] = useState(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [permissionSetupStatus, setPermissionSetupStatus] = useState('');
  const permissionSetupPending = useRef(false);
  const runShizukuPermissionSetup = async () => {
    if (permissionSetupPending.current) return;
    permissionSetupPending.current = true;
    setGrantingPermissions(true);
    setPermissionsGranted(false);
    setPermissionSetupStatus('Waiting for Shizuku. Allow ClipCascade access when prompted.');
    try {
      const result = await NativeModules.ShizukuPermissions.grantPermissions();
      if (result.readLogs && result.overlay) {
        setPermissionsGranted(true);
        setPermissionSetupStatus('Permissions granted. Close ClipCascade to apply them, then reopen it and start sync. Allow log access when Android asks.');
      } else {
        const missing = [
          !result.readLogs && 'READ_LOGS',
          !result.overlay && 'drawing over other apps',
        ].filter(Boolean).join(' and ');
        setPermissionSetupStatus(`Still missing: ${missing}. ${result.error || 'Check Shizuku and retry, or use the ADB commands below.'}`);
      }
    } catch (error) {
      setPermissionSetupStatus(error.message || 'Unable to grant permissions. Check Shizuku and try again.');
    } finally {
      permissionSetupPending.current = false;
      setGrantingPermissions(false);
    }
  };
  const grantPermissionsWithShizuku = () => Alert.alert(
    'Grant permissions and close ClipCascade?',
    'Android may close ClipCascade as soon as permissions are granted, stopping sync. Reopen the app manually, start sync, and allow log access when Android asks. If the app stays open, use “Close app to apply permissions”.',
    [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Continue', onPress: runShizukuPermissionSetup},
    ],
  );
  const closeAppWithShizuku = () => Alert.alert(
    'Close ClipCascade?',
    'ClipCascade will close and sync will stop. Reopen the app manually, start sync, and allow log access when Android asks.',
    [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Close app', onPress: async () => {
        if (permissionSetupPending.current) return;
        permissionSetupPending.current = true;
        setGrantingPermissions(true);
        setPermissionSetupStatus('Closing ClipCascade…');
        try {
          await NativeModules.ShizukuPermissions.forceStopApp();
        } catch (error) {
          setPermissionSetupStatus(`${error.message || 'Unable to close ClipCascade.'} You can force stop it from Android App info, then reopen it.`);
        } finally {
          permissionSetupPending.current = false;
          setGrantingPermissions(false);
        }
      }},
    ],
  );
  const [isChangingSync, setIsChangingSync] = useState(false);
  const dashboardColors = {
    backgroundColor: isDark ? '#111827' : '#f3f6fa',
    color: isDark ? '#f3f4f6' : '#182230',
  };
  const cardColors = {
    backgroundColor: isDark ? '#1f2937' : '#ffffff',
    borderColor: isDark ? '#374151' : '#dce3ec',
  };
  const secondaryText = {color: isDark ? '#b8c5d6' : '#475467'};
  const actionText = {color: isDark ? '#93c5fd' : '#175cd3'};

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
  const CSRF_URL = '/csrf-token';
  const VALIDATE_URL = '/validate-session';
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

        data_s = await discoverServer(data_s, fetchTimeout);

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
    setIsChangingSync(true);
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
        setIsChangingSync(false);
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
  const [showPassword, setShowPassword] = useState(false);
  const passwordInputRef = useRef(null);

  const applyPasswordVisibility = () => {
    const tag = findNodeHandle(passwordInputRef.current);
    if (tag != null) {
      NativeBridgeModule.setPasswordVisibility(tag, showPassword).catch(console.warn);
    }
  };

  useEffect(() => {
    const tag = findNodeHandle(passwordInputRef.current);
    if (enableLoginPage && tag != null) {
      NativeBridgeModule.setPasswordVisibility(tag, showPassword).catch(console.warn);
    }
  }, [enableLoginPage, showPassword, NativeBridgeModule]);

  useEffect(() => {
    if (!enableLoginPage) setShowPassword(false);
  }, [enableLoginPage]);

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
  const syncConnected = wsIsRunning === 'true' && wsPageMessage.includes('✅ Connected');
  const syncStatusColor = isChangingSync
    ? (isDark ? '#fbbf24' : '#b45309')
    : syncConnected
      ? (isDark ? '#4ade80' : '#15803d')
      : (isDark ? '#f87171' : '#b42318');

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
        backgroundColor: enableWSPage ? dashboardColors.backgroundColor : undefined,
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
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
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
            <View style={styles.passwordField}>
              <TextInput
                editable={!isLoggingIn}
                ref={passwordInputRef}
                onLayout={applyPasswordVisibility}
                style={[styles.input, styles.passwordInput]}
                accessibilityLabel="Password"
                value={password}
                onChangeText={text => setPassword(text)}
                // Keep password keyboard semantics even when native code reveals the text.
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                importantForAutofill="no"
              />
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                accessibilityState={{disabled: isLoggingIn}}
                disabled={isLoggingIn}
                onPress={() => setShowPassword(visible => !visible)}
                style={styles.passwordToggle}
              >
                <Text style={styles.passwordMonkey}>{showPassword ? '🐵' : '🙈'}</Text>
              </TouchableOpacity>
            </View>
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
        <ScrollView
          style={{backgroundColor: dashboardColors.backgroundColor}}
          contentContainerStyle={styles.dashboard}
        >
          <View style={styles.dashboardHeader}>
            <Text style={[styles.dashboardTitle, {color: dashboardColors.color}]}>{APP_NAME}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.secondaryAction}
              disabled={isChangingSync}
              onPress={logout}
            >
              <Text style={actionText}>Log out</Text>
            </TouchableOpacity>
          </View>
          <View>
            <View style={[styles.dashboardCard, cardColors]}>
              <Text accessibilityRole="header" style={[styles.cardTitle, {color: dashboardColors.color}]}>
                Clipboard sync
              </Text>
              <View style={styles.syncStatusRow}>
                <View
                  accessible={false}
                  importantForAccessibility="no"
                  style={[styles.syncStatusDot, {backgroundColor: syncStatusColor}]}
                />
                <Text style={[styles.statusLabel, {color: syncStatusColor}]} accessibilityLiveRegion="polite">
                  {isChangingSync
                    ? (wsIsRunning === 'true' ? 'Stopping…' : 'Starting…')
                    : wsIsRunning !== 'true'
                      ? 'Stopped'
                      : /retrying|reconnect/i.test(wsPageMessage)
                        ? 'Reconnecting…'
                        : wsPageMessage.includes('✅ Connected')
                          ? 'Connected'
                          : 'Service running · Waiting for connection'}
                </Text>
              </View>
              <Text style={[styles.cardBody, secondaryText]}>
                {wsIsRunning === 'true'
                  ? 'Clipboard sync is running in the background.'
                  : 'Start sync to share clipboard content with your devices.'}
              </Text>
              {wsPageMessage !== '' && wsPageMessage !== '✅ Connected' && (
                <Text style={[styles.statusMessage, secondaryText]} accessibilityLiveRegion="polite">{wsPageMessage}</Text>
              )}
              {wsPageP2PMessage !== '' && (
                <Text style={[styles.statusMessage, secondaryText]}>{wsPageP2PMessage}</Text>
              )}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{disabled: isChangingSync, busy: isChangingSync}}
                style={[styles.primaryAction, isChangingSync && styles.disabledAction]}
                disabled={isChangingSync}
                onPress={foregroundService}
              >
                <Text style={styles.loginButtonText}>
                  {isChangingSync ? 'Please wait…' : wsIsRunning === 'true' ? 'Stop sync' : 'Start sync'}
                </Text>
              </TouchableOpacity>
            </View>
            {newVersionAvailable[0] && (
              <View style={[styles.updateCard, cardColors]}>
                <View style={styles.updateDetails}>
                  <Text accessibilityRole="header" style={[styles.updateTitle, {color: dashboardColors.color}]}>
                    Update available
                  </Text>
                  <Text style={[styles.updateVersion, secondaryText]}>
                    {APP_VERSION} <Text style={styles.updateArrow}>➜</Text> {newVersionAvailable[1]}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityRole="link"
                  accessibilityLabel={`Update ClipCascade to ${newVersionAvailable[1]}`}
                  accessibilityHint="Opens the release download page"
                  onPress={() => Linking.openURL(RELEASE_URL)}
                  style={[styles.updateButton, {borderColor: actionText.color}]}
                >
                  <Text style={[styles.updateButtonText, actionText]}>Update</Text>
                </TouchableOpacity>
              </View>
            )}
            {(enableFilesDownloadButton || isDownloadingFiles || isChoosingDownloadDirectory) && (
              <View style={[styles.dashboardCard, cardColors]}>
                <Text accessibilityRole="header" style={[styles.cardTitle, {color: dashboardColors.color}]}>
                  File transfers
                </Text>
                <Text style={[styles.cardBody, secondaryText]}>
                  {enableFilesDownloadButton
                    ? `${availableFileCount} ${availableFileCount === 1 ? 'file' : 'files'} available to download`
                    : 'Incoming files will appear here.'}
                </Text>
                {enableFilesDownloadButton && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{disabled: isChoosingDownloadDirectory || isDownloadingFiles, busy: isDownloadingFiles}}
                    style={[styles.primaryAction, (isChoosingDownloadDirectory || isDownloadingFiles) && styles.disabledAction]}
                    onPress={downloadFiles}
                    disabled={isChoosingDownloadDirectory || isDownloadingFiles}
                  >
                    <Text style={styles.loginButtonText}>
                      {isChoosingDownloadDirectory ? 'Choosing folder…' : isDownloadingFiles ? 'Downloading…' : `Download ${availableFileCount === 1 ? 'file' : 'files'}`}
                    </Text>
                  </TouchableOpacity>
                )}
                {isDownloadingFiles && <ActivityIndicator style={styles.transferActivity} color={actionText.color} />}
                {fileDownloadStatus !== '' && (
                  <Text style={[styles.cardBody, secondaryText]} accessibilityLiveRegion="polite">
                    {fileDownloadStatus}
                  </Text>
                )}
              </View>
            )}
            <View style={[styles.dashboardCard, cardColors]}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{expanded: showSetupGuide}}
                style={styles.guideToggle}
                onPress={toggleSetupGuide}
              >
                <Text style={[styles.cardTitle, {color: dashboardColors.color}]}>Android setup guide</Text>
                <Text style={actionText}>{showSetupGuide ? 'Hide' : 'Show'}</Text>
              </TouchableOpacity>
              <Text style={[styles.cardBody, secondaryText]}>
                Share manually, enable automatic sharing, and keep sync running.
              </Text>
              {showSetupGuide && (
                <View>
                  <View style={styles.guideSection}>
                    <Text accessibilityRole="header" style={[styles.guideSectionTitle, {color: dashboardColors.color}]}>
                      How to share
                    </Text>
                    <Text style={[styles.guideText, secondaryText]}>
                      1. Select text, an image, or files.{'\n'}
                      2. Tap “Share” <Text style={styles.sharingArrow}>➜</Text> “ClipCascade”.
                    </Text>
                    <Text style={[styles.guideText, secondaryText]}>
                      Or tap “ClipCascade” instead of “Copy” when selecting text.
                    </Text>
                    <Text style={[styles.guideText, secondaryText]}>
                      On Android 10+, automatic sending from the background is restricted. To enable it, follow the ADB setup below. Receiving still works automatically while sync is running.
                    </Text>
                  </View>

                  <View style={[styles.guideSection, styles.guideDivider, {borderColor: cardColors.borderColor}]}>
                    <Text accessibilityRole="header" style={[styles.guideSectionTitle, {color: dashboardColors.color}]}>
                      Share automatically · ADB setup
                    </Text>
                    <Text style={[styles.guideText, secondaryText]}>
                      Works with or without root. Run these commands in order from a computer with ADB connected to your phone.
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{expanded: showShizukuSetup}}
                      style={styles.shizukuToggle}
                      onPress={() => setShowShizukuSetup(visible => !visible)}
                    >
                      <Text style={[actionText, styles.shizukuLink]}>No computer to run ADB? (Shizuku)</Text>
                    </TouchableOpacity>
                    {showShizukuSetup && (
                      <View>
                        <Text style={[styles.guideText, secondaryText]}>
                          Install and start Shizuku, then tap the button and allow ClipCascade access. On Android 11+, Shizuku can start using wireless debugging without a computer. Shizuku is only needed for setup.
                        </Text>
                        <TouchableOpacity
                          accessibilityRole="link"
                          style={styles.guideSettingsButton}
                          onPress={() => Linking.openURL('https://shizuku.rikka.app/guide/setup/')}
                        >
                          <Text style={actionText}>Shizuku installation and setup</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityState={{disabled: grantingPermissions, busy: grantingPermissions}}
                          disabled={grantingPermissions}
                          style={[styles.guideSettingsButton, {borderColor: cardColors.borderColor}]}
                          onPress={grantPermissionsWithShizuku}
                        >
                          <Text style={actionText}>{grantingPermissions ? 'Granting permissions…' : 'Grant permissions using Shizuku'}</Text>
                        </TouchableOpacity>
                        {!!permissionSetupStatus && (
                          <Text accessibilityLiveRegion="polite" style={[styles.guideText, secondaryText]}>
                            {permissionSetupStatus}
                          </Text>
                        )}
                        {permissionsGranted && (
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityState={{disabled: grantingPermissions, busy: grantingPermissions}}
                            disabled={grantingPermissions}
                            style={[styles.guideSettingsButton, {borderColor: cardColors.borderColor}]}
                            onPress={closeAppWithShizuku}
                          >
                            <Text style={actionText}>Close app to apply permissions</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                    {[
                      ['1. Allow clipboard monitoring', 'adb -d shell pm grant com.clipcascade android.permission.READ_LOGS', 'Grants READ_LOGS so ClipCascade can detect clipboard access events in Android’s system logs and trigger automatic clipboard monitoring. This does not change how content is received.'],
                      ['2. Allow drawing over other apps', 'adb -d shell appops set com.clipcascade SYSTEM_ALERT_WINDOW allow', 'Allows ClipCascade to briefly focus a small overlay to read clipboard content when Android restricts background access. You can also grant this permission in Android settings under Drawing over other apps.'],
                      ['3. Stop the app to apply permissions', 'adb -d shell am force-stop com.clipcascade', 'Stops ClipCascade so it can restart with the new permissions. After running this command, reopen the app and start sync.'],
                    ].map(([title, command, info]) => (
                      <View key={command} style={styles.adbStep}>
                        <View style={styles.adbStepHeader}>
                          <InfoLabel
                            style={[styles.guideText, styles.adbStepTitle, {color: dashboardColors.color}]}
                            label={title}
                            info={info}
                          />
                          <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel={`Copy command: ${title}`}
                            style={styles.copyCommand}
                            onPress={() => {
                              Clipboard.setString(command);
                              setCopiedCommand(command);
                            }}
                          >
                            <Text style={actionText} accessibilityLiveRegion="polite">{copiedCommand === command ? 'Copied' : 'Copy'}</Text>
                          </TouchableOpacity>
                        </View>
                        <ScrollView horizontal style={[styles.commandBox, {backgroundColor: dashboardColors.backgroundColor}]}>
                          <Text selectable style={[styles.commandText, secondaryText]}>{command}</Text>
                        </ScrollView>
                      </View>
                    ))}
                  </View>

                  <View style={[styles.guideSection, styles.guideDivider, {borderColor: cardColors.borderColor}]}>
                    <Text accessibilityRole="header" style={[styles.guideSectionTitle, {color: dashboardColors.color}]}>
                      Keep sync running
                    </Text>
                    <Text style={[styles.guideText, secondaryText]}>
                      Disable battery optimization for ClipCascade and check your phone’s power manager to reduce background interruptions.
                    </Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.guideSettingsButton, {borderColor: cardColors.borderColor}]}
                      onPress={async () => await notifee.openBatteryOptimizationSettings()}
                    >
                      <Text style={actionText}>Battery optimization settings</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.guideSettingsButton, {borderColor: cardColors.borderColor}]}
                      onPress={async () => await notifee.openPowerManagerSettings()}
                    >
                      <Text style={actionText}>Power manager settings</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
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
  dashboard: {
    padding: 20,
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
  },
  dashboardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  dashboardTitle: {fontSize: 26, lineHeight: 36, paddingVertical: 2, fontWeight: '700', flex: 1},
  secondaryAction: {minHeight: 48, paddingHorizontal: 12, justifyContent: 'center'},
  dashboardCard: {borderWidth: 1, borderRadius: 16, padding: 20, marginBottom: 16},
  cardTitle: {fontSize: 18, paddingVertical: 4, includeFontPadding: true, fontWeight: '600', flexShrink: 1},
  cardBody: {fontSize: 15, lineHeight: 24, paddingVertical: 2, flexShrink: 0, includeFontPadding: true, marginTop: 10},
  // Native font metrics accommodate Android emoji and fallback glyphs.
  statusMessage: {fontSize: 15, paddingVertical: 4, includeFontPadding: true, flexShrink: 0, marginTop: 10},
  syncStatusRow: {flexDirection: 'row', alignItems: 'center', marginTop: 10},
  syncStatusDot: {width: 10, height: 10, borderRadius: 5, marginRight: 10},
  statusLabel: {fontSize: 20, paddingVertical: 4, includeFontPadding: true, flex: 1, fontWeight: '600'},
  primaryAction: {
    minHeight: 48,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#175cd3',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  updateCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  updateDetails: {flexGrow: 1, flexBasis: 160},
  updateTitle: {fontSize: 16, fontWeight: '600', paddingVertical: 2},
  updateArrow: {fontSize: 13, fontWeight: '400'},
  updateVersion: {fontSize: 14, marginTop: 4, paddingVertical: 2},
  updateButton: {minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'center', alignItems: 'center'},
  updateButtonText: {fontSize: 14, fontWeight: '600'},
  disabledAction: {opacity: 0.5},
  transferActivity: {marginTop: 12},
  guideSection: {marginTop: 16},
  guideDivider: {borderTopWidth: 1, paddingTop: 16},
  guideSectionTitle: {fontSize: 16, lineHeight: 24, fontWeight: '600'},
  sharingArrow: {fontSize: 15, fontWeight: '400'},
  guideText: {fontSize: 14, lineHeight: 22, paddingVertical: 2, marginTop: 6},
  shizukuToggle: {alignSelf: 'flex-start', paddingVertical: 8},
  shizukuLink: {fontSize: 13, textDecorationLine: 'underline'},
  adbStep: {marginTop: 10},
  adbStepHeader: {flexDirection: 'row', alignItems: 'center'},
  adbStepTitle: {flex: 1, marginTop: 0},
  copyCommand: {minHeight: 44, minWidth: 56, alignItems: 'center', justifyContent: 'center'},
  commandBox: {borderRadius: 8},
  commandText: {fontSize: 13, lineHeight: 22, padding: 12, fontFamily: 'monospace'},
  guideSettingsButton: {minHeight: 44, justifyContent: 'center', padding: 12, borderWidth: 1, borderRadius: 8, marginTop: 10},
  guideToggle: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
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
  passwordField: {flex: 2, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderWidth: 1, borderColor: '#ccc', borderRadius: 5},
  passwordInput: {flex: 1, minWidth: 0, borderWidth: 0, paddingHorizontal: 0},
  passwordToggle: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center'},
  passwordMonkey: {fontSize: 18, paddingVertical: 2},
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
