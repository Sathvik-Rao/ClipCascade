import {
  PermissionsAndroid,
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
} from 'react-native';

import {useEffect, useState} from 'react'; // hooks

import CheckBox from '@react-native-community/checkbox'; // checkbox

import notifee from '@notifee/react-native'; // notification, foreground service
import {pbkdf2} from '@react-native-module/pbkdf2'; // hashing
import {Buffer} from 'buffer'; // handling streams of binary data
import DocumentPicker from 'react-native-document-picker'; // file picker
import {sha3_512} from 'js-sha3';
import {DOMParser} from 'react-native-html-parser';

import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  clearAsyncStorage,
} from './AsyncStorageManagement'; // persistent storage
import StartForegroundService from './StartForegroundService'; // foreground service

/*
 * These files are part of the ClipCascade project.
 *
 * (file) android\app\src\main\java\com\clipcascade\AsyncStorageBridge.kt
 * (file) android\app\src\main\java\com\clipcascade\BootReceiver.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardFloatingActivity.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerPackage.kt
 * (file) android\app\src\main\java\com\clipcascade\HeadlessTaskService.kt
 * (file) android\app\src\main\java\com\clipcascade\MainActivity.kt
 * (file) android\app\src\main\java\com\clipcascade\MainApplication.kt
 * (file) android\app\src\main\java\com\clipcascade\NativeBridgeModule.kt
 * (file) android\app\src\main\java\com\clipcascade\NativeBridgePackage.kt
 * (file) android\app\src\main\java\com\clipcascade\ScheduleService.kt
 * (file) android\app\src\main\AndroidManifest.xml
 * (folder) android\app\src\main\res\
 * (file) android\app\build.gradle
 * (file) android\app\my-upload-key.keystore
 * (file) android\gradle.properties
 * (file) AsyncStorageManagement.js
 * (file) HeadlessTask.js
 * (file) index.js
 * (file) StartForegroundService.js
 */

// App version
const APP_VERSION = '3.0.0';

// Main App
export default function App() {
  const {NativeBridgeModule} = NativeModules;

  const [newVersionAvailable, setNewVersionAvailable] = useState([false, '']);
  const [donateUrl, setDonateUrl] = useState(null);

  // Constants
  const MAX_LOGIN_AUTO_RETRY = 3; // Retry login attempts
  const FETCH_TIMEOUT = 5000; // 5 seconds
  const LOGIN_URL = '/login';
  const LOGOUT_URL = '/logout';
  const MAXSIZE_URL = '/max-size';
  const CSRF_URL = '/csrf-token';
  const SERVER_MODE_URL = '/server-mode';
  const WEBSOCKET_ENDPOINT = '/clipsocket';
  const VALIDATE_URL = '/validate-session';
  const WEBSOCKET_ENDPOINT_P2P = '/p2psignaling';
  const STUN_URL = '/stun-url';
  const VERSION_URL =
    'https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json';
  const GITHUB_URL = 'https://github.com/Sathvik-Rao/ClipCascade';
  const RELEASE_URL =
    'https://github.com/Sathvik-Rao/ClipCascade/releases/latest';
  const APP_NAME = 'ClipCascade';
  const HELP_URL = `${GITHUB_URL}/blob/main/README.md`;
  const METADATA_URL =
    'https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/metadata.json';

  // Request permissions for notifications
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

  const fetchTimeout = async (input, init, timeout_ms = FETCH_TIMEOUT) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
      return await fetch(input, {...init, signal: controller.signal});
    } catch (e) {
      throw e;
    }
  };

  //data hook
  const [data, setData] = useState({
    cipher_enabled: 'true',
    server_url: 'http://localhost:8080',
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
    enable_periodic_checks: 'true',
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

  // get data from async storage
  const getAsyncStorage = async () => {
    try {
      let data_s = {...data};
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
    let intervalId = null;

    // initialize
    const init = async () => {
      try {
        // enable websocket button
        await setDataInAsyncStorage('enableWSButton', 'true');

        // start interval
        intervalId = startInterval();

        // get data from async storage and initialize data hook
        let data_s = await getAsyncStorage();
        setData(data_s);

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
            await clearFiles();
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '⚠️ Foreground service stopped running',
            );
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

        // check for new version
        try {
          const response = await fetchTimeout(VERSION_URL);
          if (!response.ok) {
            throw new Error('Network response was not ok');
          }
          const data = await response.json();
          if (data && data.android !== APP_VERSION) {
            setNewVersionAvailable([true, data.android]);
          }
        } catch (e) {
          // Silent catch
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
      if (intervalId) {
        clearInterval(intervalId);
      }
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
      // 1. Fetch the login page to get CSRF token and initial cookie
      const loginPageResponse = await fetchTimeout(
        data_s.server_url + LOGIN_URL,
        {
          method: 'GET',
        },
      );

      if (!loginPageResponse.ok) {
        const msg = `Failed to fetch login page: ${loginPageResponse.status}`;
        return [false, msg, data_s];
      }

      // parse HTML to get _csrf using react-native-html-parser
      const htmlText = await loginPageResponse.text();

      // Create a new DOM Parser instance
      const parser = new DOMParser();
      // Parse HTML
      const doc = parser.parseFromString(htmlText, 'text/html');

      // Find <input> elements and look for name="_csrf"
      const inputElements = doc.getElementsByTagName('input');
      let csrfToken = '';

      for (let i = 0; i < inputElements.length; i++) {
        const nameAttr = inputElements[i].getAttribute('name');
        if (nameAttr === '_csrf') {
          csrfToken = inputElements[i].getAttribute('value');
          break;
        }
      }

      if (csrfToken === '') {
        return [false, 'No CSRF token found in login page', data_s];
      }

      // 2. Retrieve the cookie(s) from the "Set-Cookie" header
      const setCookieHeader = loginPageResponse.headers.get('set-cookie');
      if (!setCookieHeader) {
        return [false, 'No Set-Cookie header returned from login page', null];
      }

      // 3. Prepare form data with the credentials AND the CSRF token
      const formData = new URLSearchParams();
      formData.append('username', data_s.username);
      formData.append('password', password_s);
      formData.append('_csrf', csrfToken);

      // 4. Send a POST request to the login URL with cookies + form data
      const loginResponse = await fetchTimeout(data_s.server_url + LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: setCookieHeader, // Include the cookies from the initial GET
        },
        body: formData.toString(),
      });

      const loginResponseText = await loginResponse.text();

      // 5. Check for login success
      if (
        loginResponse.ok &&
        !loginResponseText.toLowerCase().includes('bad credentials')
      ) {
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
            'Login Successful but unable to get server mode \n Status: ' +
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
              'Login Successful but unable to get stun url \n Status: ' +
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
              'Login Successful but unable to get max size \n Status: ' +
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

        return [true, 'Login successful: ' + loginResponse.status, data_s];
      } else {
        return [false, 'Login failed: ' + loginResponse.status, data_s];
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

  const startInterval = async () => {
    try {
      return setInterval(async () => {
        if ((await getDataFromAsyncStorage('wsIsRunning')) === 'true') {
          // Websocket status message
          const msg1 = await getDataFromAsyncStorage('wsStatusMessage');
          if (msg1 !== null && msg1 !== '') {
            setWsPageMessage(msg1);
          }

          if ((await getDataFromAsyncStorage('server_mode')) === 'P2P') {
            const msg2 = await getDataFromAsyncStorage('p2pStatusMessage');
            if (msg2 !== null) {
              setWsPageP2PMessage(msg2);
            }
          }

          // Files available to download
          if (
            (await getDataFromAsyncStorage('filesAvailableToDownload')) ===
            'true'
          ) {
            setEnableFilesDownloadButton(true);
          } else {
            setEnableFilesDownloadButton(false);
          }
        }
      }, 300);
    } catch (e) {
      throw e;
    }
  };

  // Foreground service handler
  const foregroundService = async () => {
    try {
      if ((await getDataFromAsyncStorage('enableWSButton')) === 'true') {
        await setDataInAsyncStorage('enableWSButton', 'false');
        setWsPageMessage('');
        setWsPageP2PMessage('');
        await clearFiles();
        wsIsRunning_s = wsIsRunning === 'true' ? 'false' : 'true'; // toggle
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
      await setDataInAsyncStorage('enableWSButton', 'true');
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
    try {
      setData(prevData => ({
        ...prevData,
        [field]: value,
      }));
    } catch (e) {
      setLoginStatusMessage('❌ Error: ' + e);
    }
  };

  // Function to handle login button press
  const handleLogin = async (pass = null, data_s_c = null) => {
    try {
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
        data_s = {...data};
      }

      // remove trailing slashes in server_url
      data_s.server_url = data_s.server_url.replace(/\/+$/, '');

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
          NativeBridgeModule.stopWorkManager();
        }

        // Save password in async storage
        if (data_s.save_password === 'true') {
          await setDataInAsyncStorage('password', password_s);
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

  // download files
  const downloadFiles = async () => {
    try {
      if (
        (await getDataFromAsyncStorage('filesAvailableToDownload')) === 'true'
      ) {
        const res = await DocumentPicker.pickDirectory();
        await setDataInAsyncStorage('dirPath', res.uri);
        await setDataInAsyncStorage('downloadFiles', 'true');
      } else {
        setEnableFilesDownloadButton(false);
      }
    } catch (e) {
      if (!DocumentPicker.isCancel(e)) {
        Alert.alert('Error', 'Unknown error: ' + JSON.stringify(e));
      }
    }
  };

  // view
  if (initError[0]) {
    return (
      <>
        <View style={styles.loadingContainer}>
          <Text style={styles.appTitle}>{APP_NAME}</Text>
          <View style={styles.loadingBottomContainer}>
            <Text style={styles.loadingText}>Init Error: {initError[1]}</Text>
          </View>
        </View>
      </>
    );
  }
  return (
    <>
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
              style={styles.input}
              value={data.username}
              onChangeText={text => handleInputChange('username', text)}
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Password:</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={text => setPassword(text)}
              secureTextEntry
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Server URL:</Text>
            <TextInput
              style={styles.input}
              value={data.server_url}
              onChangeText={text =>
                handleInputChange('server_url', text.trim())
              }
              autoCapitalize="none"
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Enable Encryption (recommended):</Text>
            <CheckBox
              value={data.cipher_enabled === 'true' ? true : false}
              onValueChange={newValue =>
                handleInputChange('cipher_enabled', String(newValue))
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
            onPress={() => {
              handleLogin(null, null);
            }}>
            <Text style={styles.loginButtonText}>Login</Text>
          </TouchableOpacity>

          {/* Toggle Extra Config as Text */}
          <TouchableOpacity
            onPress={() => setShowExtraConfig(!showExtraConfig)}>
            <Text style={styles.linkText}>
              {showExtraConfig ? 'Hide Extra Config' : 'Enable Extra Config'}
            </Text>
          </TouchableOpacity>

          {/* Extra Config Fields (conditionally rendered) */}
          {showExtraConfig && (
            <>
              <View style={styles.row}>
                <Text style={styles.label}>Hash Rounds:</Text>
                <TextInput
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
                <Text style={styles.label}>Salt:</Text>
                <TextInput
                  style={styles.input}
                  value={data.salt}
                  onChangeText={text => handleInputChange('salt', text)}
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>
                  Store Password Locally (not recommended; only works if
                  encryption is disabled):
                </Text>
                <CheckBox
                  value={data.save_password === 'true' ? true : false}
                  onValueChange={newValue =>
                    handleInputChange('save_password', String(newValue))
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>
                  Maximum Clipboard Size Local Limit (in bytes):
                </Text>
                <TextInput
                  style={styles.input}
                  value={data.max_clipboard_size_local_limit_bytes}
                  onChangeText={text =>
                    handleInputChange(
                      'max_clipboard_size_local_limit_bytes',
                      isNaN(Number(text))
                        ? data.max_clipboard_size_local_limit_bytes
                        : text.trim(),
                    )
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>
                  Run on system startup (disable if the READ_LOGS permission is
                  granted):
                </Text>
                <CheckBox
                  value={data.relaunch_on_boot === 'true' ? true : false}
                  onValueChange={newValue =>
                    handleInputChange('relaunch_on_boot', String(newValue))
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>
                  Enable WebSocket Status Notification:
                </Text>
                <CheckBox
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
              <View style={styles.row}>
                <Text style={styles.label}>Enable Periodic Checks:</Text>
                <CheckBox
                  value={data.enable_periodic_checks === 'true' ? true : false}
                  onValueChange={newValue =>
                    handleInputChange(
                      'enable_periodic_checks',
                      String(newValue),
                    )
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Enable Image Sharing:</Text>
                <CheckBox
                  value={data.enable_image_sharing === 'true' ? true : false}
                  onValueChange={newValue =>
                    handleInputChange('enable_image_sharing', String(newValue))
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Enable File Sharing:</Text>
                <CheckBox
                  value={data.enable_file_sharing === 'true' ? true : false}
                  onValueChange={newValue =>
                    handleInputChange('enable_file_sharing', String(newValue))
                  }
                />
              </View>
            </>
          )}
          {/* Footer */}
          <View style={styles.footerContainer}>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(GITHUB_URL)}>
              <Text style={styles.footerText}>GITHUB</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(HELP_URL)}>
              <Text style={styles.footerText}>HELP</Text>
            </TouchableOpacity>
            {donateUrl && (
              <TouchableOpacity
                style={styles.spacing}
                onPress={() => Linking.openURL(donateUrl)}>
                <Text style={styles.footerText}>DONATE</Text>
              </TouchableOpacity>
            )}
          </View>
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
                {backgroundColor: wsIsRunning === 'true' ? '#800020' : 'green'},
              ]}
              onPress={foregroundService}>
              <Text style={styles.loginButtonText}>
                {wsIsRunning === 'true' ? 'Stop' : 'Start'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.loginButton, {backgroundColor: '#800020'}]}
              onPress={logout}>
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
                  style={[styles.loginButton, {backgroundColor: '#4bab4e'}]}
                  onPress={downloadFiles}>
                  <Text style={styles.loginButtonText}>
                    📥 Download File(s)
                  </Text>
                </TouchableOpacity>
              )}
            {/* new version display message */}
            {newVersionAvailable[0] && (
              <TouchableOpacity
                onPress={() => Linking.openURL(RELEASE_URL)}
                style={{marginTop: 10}}>
                <Text
                  style={[
                    styles.message,
                    {
                      color: '#008080',
                      fontWeight: 'bold',
                      textDecorationLine: 'underline',
                    },
                  ]}>
                  New version available! 🚀 Click here to update ({APP_VERSION}{' '}
                  ➞ {newVersionAvailable[1]})
                </Text>
              </TouchableOpacity>
            )}
            <View style={{marginTop: 20, paddingHorizontal: 10}}>
              <Text
                style={[styles.message, {fontWeight: 'bold', fontSize: 18}]}>
                Instructions
              </Text>

              <View style={{marginTop: 15}}>
                <Text
                  style={[styles.label, {fontWeight: 'bold', marginBottom: 5}]}>
                  Clipboard Sharing on Android 10+:
                </Text>
                <Text style={styles.label}>
                  On Android 10 and above, clipboard monitoring has been
                  restricted for privacy reasons. To share clipboard content
                  using ClipCascade:
                </Text>
                <View style={{marginTop: 10, marginLeft: 15}}>
                  <Text style={styles.label}>
                    1. Select the text, image, or file(s) you want to copy.
                  </Text>
                  <Text style={styles.label}>
                    2. Tap 'Share', select 'ClipCascade'.
                  </Text>
                  <Text style={[styles.label, {marginLeft: 15}]}>(or)</Text>
                  <Text style={[styles.label, {marginLeft: 15}]}>
                    Tap 'ClipCascade' instead of 'Copy'.
                  </Text>
                </View>
                <Text
                  style={[
                    styles.label,
                    {marginTop: 5, fontSize: 15, fontStyle: 'italic'},
                  ]}>
                  There's also a workaround to enable clipboard sharing in the
                  background. Scroll down for setup instructions.
                </Text>
              </View>

              <View style={{marginTop: 20}}>
                <Text
                  style={[styles.label, {fontWeight: 'bold', marginBottom: 5}]}>
                  Background Clipboard Reception:
                </Text>
                <Text style={styles.label}>
                  ClipCascade automatically receives clipboard content in the
                  background. No manual action is required to receive data.
                </Text>
              </View>

              <View style={{marginTop: 20}}>
                <Text
                  style={[styles.label, {fontWeight: 'bold', marginBottom: 5}]}>
                  Important Note:
                </Text>
                <Text style={styles.label}>
                  To ensure uninterrupted performance, please disable battery
                  optimization for ClipCascade. This will prevent the system
                  from stopping the app when it's running in the foreground.
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.loginButton, {backgroundColor: 'black'}]}
                onPress={async () =>
                  await notifee.openBatteryOptimizationSettings()
                }>
                <Text style={styles.loginButtonText}>
                  Battery Optimization Settings
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginButton, {backgroundColor: 'black'}]}
                onPress={async () => await notifee.openPowerManagerSettings()}>
                <Text style={styles.loginButtonText}>
                  Power Manager Settings
                </Text>
              </TouchableOpacity>

              {/* ADB Commands Section */}
              <View style={{marginTop: 20}}>
                <Text
                  style={[styles.label, {fontWeight: 'bold', marginBottom: 5}]}>
                  Automatic Clipboard Monitoring Setup:
                </Text>
                <Text style={styles.label}>
                  On rooted/non-rooted devices, to enable automatic clipboard
                  monitoring you need to execute these 3 ADB commands:
                </Text>
                <View style={{marginTop: 10, marginLeft: 15}}>
                  <Text style={styles.label}>
                    1. Enable the READ_LOGS permission:
                  </Text>
                  <Text
                    selectable
                    style={[
                      styles.label,
                      {fontWeight: 'bold', marginLeft: 15},
                    ]}>
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
                      {fontWeight: 'bold', marginLeft: 15},
                    ]}>
                    {`> adb -d shell appops set com.clipcascade SYSTEM_ALERT_WINDOW allow`}
                  </Text>

                  <Text style={styles.label}>
                    3. Kill the app for the new permissions to take effect:
                  </Text>
                  <Text
                    selectable
                    style={[
                      styles.label,
                      {fontWeight: 'bold', marginLeft: 15},
                    ]}>
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
              onPress={() => Linking.openURL(GITHUB_URL)}>
              <Text style={styles.footerText}>GITHUB</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(HELP_URL)}>
              <Text style={styles.footerText}>HELP</Text>
            </TouchableOpacity>
            {donateUrl && (
              <TouchableOpacity
                style={styles.spacing}
                onPress={() => Linking.openURL(donateUrl)}>
                <Text style={styles.footerText}>DONATE</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.spacing}
              onPress={() => Linking.openURL(data.server_url)}>
              <Text style={styles.footerText}>HOMEPAGE</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
    </>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  label: {
    flex: 1,
    fontSize: 16,
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
});
