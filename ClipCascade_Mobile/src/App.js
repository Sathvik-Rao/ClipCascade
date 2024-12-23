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
const APP_VERSION = '1.3.0';

// Main App
export default function App() {
  const {NativeBridgeModule} = NativeModules;

  const [newVersionAvailable, setNewVersionAvailable] = useState([false, '']);

  // Retry login attempts
  const MAX_LOGIN_AUTO_RETRY = 3;

  // Request permissions for notifications
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

  const fetchTimeout = async (input, init, timeout_ms = 5000) => {
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
    websocket_url: 'ws://localhost:8080/clipsocket',
    username: '',
    hashed_password: '',
    maxsize: '',
    subscription_destination: '/topic/cliptext',
    send_destination: '/app/cliptext',
    hash_rounds: '664937',
    salt: '',
    login_url: '/login',
    logout_url: '/logout',
    maxsize_url: '/max-size',
    save_password: 'false',
    max_clipboard_size_local_limit_bytes: '',
    relaunch_on_boot: 'false',
    enable_periodic_checks: 'true',
    enable_image_sharing: 'true',
    enable_file_sharing: 'true',
  });

  /*
   * Virtual/Helper Async Storage Fields:
   *
   * downloadFiles, filesAvailableToDownload, dirPath, wsStatusMessage, echo, wsIsRunning,
   * enableWSButton, foreground_service_stopped_running, password
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
              if (pass !== null) {
                setPassword(pass);
                handleLogin(pass, data_s);
              }
            }
          }
        }

        // check for new version
        try {
          const response = await fetch(
            'https://raw.githubusercontent.com/Sathvik-Rao/ClipCascade/main/version.json',
          );
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

  // Function to validate session
  const validateSession = async data_s => {
    try {
      const response = await fetchTimeout(
        data_s.server_url + data_s.maxsize_url,
        {
          method: 'HEAD',
        },
      );

      if (response.ok) {
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
      const formData = new URLSearchParams();
      formData.append('username', data_s.username);
      formData.append('password', password_s);
      formData.append('remember-me', 'on');

      const loginResponse = await fetchTimeout(
        data_s.server_url + data_s.login_url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
        },
      );

      const loginResponseText = await loginResponse.text();
      //login success
      if (
        loginResponse.ok &&
        !loginResponseText.toLowerCase().includes('bad credentials')
      ) {
        // Save max_size in async storage
        const maxSizeResponse = await fetchTimeout(
          data_s.server_url + data_s.maxsize_url,
          {
            method: 'GET',
          },
        );
        if (!maxSizeResponse.ok) {
          return [
            (false,
            'Login Successful but unable to get max size \n Status: ' +
              maxSizeResponse.status),
          ];
        }
        maxSizeResponseText = await maxSizeResponse.text();
        data_s.maxsize = String(JSON.parse(maxSizeResponseText).maxsize);

        // Hash the password
        if (data_s.cipher_enabled === 'true') {
          hashResult = await hash(data_s, password_s);
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

  // Logout
  const logout = async () => {
    try {
      setWsPageMessage('⌛ Please wait...');
      await setDataInAsyncStorage('password', '');
      await setDataInAsyncStorage('save_password', 'false');
      if (wsIsRunning === 'true') {
        await setDataInAsyncStorage('wsIsRunning', 'false');
        setWsIsRunning('false');
      }
      const response = await fetchTimeout(data.server_url + data.logout_url, {
        method: 'GET',
      });

      if (response.ok) {
        setWsPageMessage('✅ Logout successful: ' + response.status);
        setEnableWSPage(false);
        setEnableLoginPage(true);
        setLoginStatusMessage('');
      } else {
        setWsPageMessage('❌ Logout failed: ' + response.status);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        setWsPageMessage('❌ Error: Request timed out');
      } else {
        setWsPageMessage('❌ Error: ' + error);
      }
    }
  };

  const startInterval = () => {
    try {
      return setInterval(async () => {
        if ((await getDataFromAsyncStorage('wsIsRunning')) === 'true') {
          // Websocket status message
          const msg = await getDataFromAsyncStorage('wsStatusMessage');
          if (msg !== null && msg !== '') {
            setWsPageMessage(msg);
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
        await clearFiles();
        wsIsRunning_s = wsIsRunning === 'true' ? 'false' : 'true'; // toggle
        await setDataInAsyncStorage('wsIsRunning', wsIsRunning_s);
        if (wsIsRunning_s === 'true') {
          //start foreground service
          await setDataInAsyncStorage('wsStatusMessage', '');
          setWsPageMessage('🚀 Starting foreground service...');
          await onDisplayNotification();
        } else {
          // wait for 1 sec so that foreground service can be terminated
          setWsPageMessage('⌛ Stopping foreground service...');
          await new Promise(resolve => setTimeout(resolve, 1500));
          setWsPageMessage('');
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

  // github image loading error handler
  const [imageGitHubError, setImageGitHubError] = useState(false);

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

      let password_s = password;
      if (pass !== null) {
        password_s = pass;
      }

      // synchronous data instead of state hook data for instant updates
      let data_s;
      if (data_s_c !== null) {
        data_s = data_s_c;
      } else {
        data_s = {...data};
      }

      // replace trailing slashes in server_url and websocket_url with an empty string
      data_s.server_url = data_s.server_url.replace(/\/+$/, '');
      data_s.websocket_url = data_s.websocket_url.replace(/\/+$/, '');

      let iteration = 0;
      let loginResult;
      do {
        iteration++;
        loginResult = await login(data_s, password_s);
      } while (!loginResult[0] && iteration < MAX_LOGIN_AUTO_RETRY);

      data_s = loginResult[2];
      if (!loginResult[0]) {
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
          <Text style={styles.appTitle}>ClipCascade</Text>
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
          <Text style={styles.appTitle}>ClipCascade</Text>
          <View style={styles.loadingBottomContainer}>
            <Text style={styles.loadingText}>{loadingPageMessage}</Text>
            <ActivityIndicator size="large" />
          </View>
        </View>
      )}
      {/* Login Page */}
      {enableLoginPage && (
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.appTitle}>ClipCascade</Text>
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
            <Text style={styles.label}>WebSocket URL:</Text>
            <TextInput
              style={styles.input}
              value={data.websocket_url}
              onChangeText={text =>
                handleInputChange('websocket_url', text.trim())
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
                <Text style={styles.label}>Subscription Destination:</Text>
                <TextInput
                  style={styles.input}
                  value={data.subscription_destination}
                  onChangeText={text =>
                    handleInputChange('subscription_destination', text.trim())
                  }
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Send Destination:</Text>
                <TextInput
                  style={styles.input}
                  value={data.send_destination}
                  onChangeText={text =>
                    handleInputChange('send_destination', text.trim())
                  }
                  autoCapitalize="none"
                />
              </View>
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
                <Text style={styles.label}>Login URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.login_url}
                  onChangeText={text =>
                    handleInputChange('login_url', text.trim())
                  }
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Logout URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.logout_url}
                  onChangeText={text =>
                    handleInputChange('logout_url', text.trim())
                  }
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Max Size URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.maxsize_url}
                  onChangeText={text =>
                    handleInputChange('maxsize_url', text.trim())
                  }
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>
                  Store Password Locally (not recommended):
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
          {/* GitHub Icon */}
          <TouchableOpacity
            style={styles.githubIconContainer}
            onPress={() =>
              Linking.openURL('https://github.com/Sathvik-Rao/ClipCascade')
            }>
            {!imageGitHubError ? (
              <Image
                source={{
                  uri: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                }}
                style={styles.githubIcon}
                onError={() => setImageGitHubError(true)}
                accessibilityLabel="GitHub"
              />
            ) : (
              <Text style={styles.githubText}>GitHub</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* websocket page */}
      {enableWSPage && (
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.appTitle}>ClipCascade</Text>
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
            {/* Display status message */}
            {wsPageMessage !== '' && (
              <Text style={styles.message}>{wsPageMessage}</Text>
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
                onPress={() =>
                  Linking.openURL(
                    'https://github.com/Sathvik-Rao/ClipCascade/releases/latest',
                  )
                }
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
          {/* GitHub Icon */}
          <TouchableOpacity
            style={styles.githubIconContainer}
            onPress={() =>
              Linking.openURL('https://github.com/Sathvik-Rao/ClipCascade')
            }>
            {!imageGitHubError ? (
              <Image
                source={{
                  uri: 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
                }}
                style={styles.githubIcon}
                onError={() => setImageGitHubError(true)}
                accessibilityLabel="GitHub"
              />
            ) : (
              <Text style={styles.githubText}>GitHub</Text>
            )}
          </TouchableOpacity>
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
  githubIconContainer: {
    alignItems: 'center',
    marginVertical: 20,
  },
  githubIcon: {
    width: 30,
    height: 30,
  },
  githubText: {
    fontSize: 16,
    color: '#333',
    marginTop: 5,
    textDecorationLine: 'underline',
  },
});
