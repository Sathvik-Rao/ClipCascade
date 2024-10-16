import {
  PermissionsAndroid,
  Image,
  StyleSheet,
  Text,
  View,
  NativeEventEmitter,
  NativeModules,
  Linking,
  DeviceEventEmitter,
  TextInput,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';

import {useEffect, useState} from 'react'; // hooks

/*
 * Replace 'react-native' with '@react-native-clipboard/clipboard' when using react 19 or
 * when react-native-clipboard is supporting higher verions.
 * https://reactnative.dev/docs/clipboard
 * https://github.com/react-native-clipboard/clipboard
 */
import {Clipboard} from 'react-native'; // clipboard
import CheckBox from '@react-native-community/checkbox'; // checkbox

import {Client} from '@stomp/stompjs'; // stomp over websocket
import * as encoding from 'text-encoding'; //do not remove this (polyfills for TextEncoder/TextDecoder stompjs)

import notifee, {AndroidImportance} from '@notifee/react-native'; // notification, foreground service
import {pbkdf2} from '@react-native-module/pbkdf2'; // hashing
import {Buffer} from 'buffer'; // handling streams of binary data
import {xxHash32} from 'js-xxhash'; // hashing
import AesGcmCrypto from 'react-native-aes-gcm-crypto'; // encryption/decryption
import AsyncStorage from '@react-native-async-storage/async-storage'; // persistent storage

/*
 * These files are part of the ClipCascade project.
 *
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardListenerPackage.kt
 * (file) android\app\src\main\java\com\clipcascade\ClipboardFloatingActivity.kt
 * (file) android\app\src\main\java\com\clipcascade\MainApplication.kt
 * (file) android\app\src\main\java\com\clipcascade\MainActivity.kt
 * (file) android\app\src\main\AndroidManifest.xml
 * (file) android\app\build.gradle
 * (folder) android\app\src\main\res\
 */

// Main App
export default function App() {
  // Retry attempts
  const MAX_LOGIN_AUTO_RETRY = 3;

  // Request permissions for notifications
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

  // Save data in async storage
  const setDataInAsyncStorage = async (key, value) => {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      throw e;
    }
  };

  // Retrieve data from async storage
  const getDataFromAsyncStorage = async key => {
    try {
      const value = await AsyncStorage.getItem(key);
      return value === null ? null : JSON.parse(value);
    } catch (e) {
      throw e;
    }
  };

  // Clear all data from async storage
  const clearAsyncStorage = async () => {
    try {
      await AsyncStorage.clear();
    } catch (e) {
      throw e;
    }
  };

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
  });

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

  // forground service
  notifee.registerForegroundService(notification => {
    return new Promise(async () => {
      try {
        let previous_clipboard_content_hash = '';
        let toggle = false;

        // get data from async storage
        const websocket_url = await getDataFromAsyncStorage('websocket_url');
        const subscription_destination = await getDataFromAsyncStorage(
          'subscription_destination',
        );
        const send_destination = await getDataFromAsyncStorage(
          'send_destination',
        );
        const cipher_enabled = await getDataFromAsyncStorage('cipher_enabled');
        const maxsize = Number(await getDataFromAsyncStorage('maxsize'));
        let max_clipboard_size_local_limit_bytes = Number(
          await getDataFromAsyncStorage('max_clipboard_size_local_limit_bytes'),
        );
        if (max_clipboard_size_local_limit_bytes === 0) {
          max_clipboard_size_local_limit_bytes = maxsize;
        }

        // encrption
        const encrypt = async plainText => {
          try {
            const encryptedData = await AesGcmCrypto.encrypt(
              plainText,
              false,
              await getDataFromAsyncStorage('hashed_password'),
            );
            return JSON.stringify({
              nonce: Buffer.from(encryptedData.iv, 'hex').toString('base64'),
              ciphertext: encryptedData.content,
              tag: Buffer.from(encryptedData.tag, 'hex').toString('base64'),
            });
          } catch (e) {
            throw new Error('Failed to encrypt: ' + e);
          }
        };

        // decryption
        const decrypt = async encryptedData => {
          try {
            const plainText = await AesGcmCrypto.decrypt(
              encryptedData['ciphertext'],
              await getDataFromAsyncStorage('hashed_password'),
              Buffer.from(encryptedData['nonce'], 'base64').toString('hex'),
              Buffer.from(encryptedData['tag'], 'base64').toString('hex'),
              false,
            );
            return plainText;
          } catch (e) {
            throw new Error('Failed to decrypt: ' + e);
          }
        };

        // hash clipboard content
        const hashCB = async (input, seed = 0) => {
          return String(xxHash32(input, seed));
        };

        //check if clipboard content changed
        const newCB = async hcb => {
          return previous_clipboard_content_hash !== hcb;
        };

        // validate clipboard size
        const validateClipboardSize = async (clipContent, direction) => {
          const clipContentByteLength = Buffer.byteLength(clipContent, 'utf8');
          if (
            clipContentByteLength <= maxsize &&
            clipContentByteLength <= max_clipboard_size_local_limit_bytes
          ) {
            return true;
          }
          await setDataInAsyncStorage(
            'wsStatusMessage',
            '⚠️ ' +
              direction +
              ' clipboard ignored: \n size (' +
              clipContentByteLength +
              ' bytes) exceeds limits: \n Server max size (' +
              maxsize +
              ' bytes) or Local max size (' +
              max_clipboard_size_local_limit_bytes +
              ' bytes)',
          );
          return false;
        };

        // ClipCascade when clipboard content is shared to app (or) when text selection popup menu action is invoked
        DeviceEventEmitter.addListener('SHARED_TEXT', async event => {
          try {
            const clipContent = event.text;
            if (clipContent) {
              /**
               * Sometimes `Clipboard.setString` is invoked before the app is fully opened, leading to an unauthorized state.
               * To handle this, implement a fail-safe mechanism that retries sending clipboard content only when it hasn't been successfully sent yet.
               * If both events are triggered successfully, the content won't be sent twice because the same content is hashed, ensuring that identical data is only processed once.
               */
              Clipboard.setString(clipContent);
              await sendClipBoard(clipContent);
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        //clipboard monitor
        const {ClipboardListener} = NativeModules;
        const clipboardListener = new NativeEventEmitter(ClipboardListener);
        // start clipboard listening
        ClipboardListener.startListening();
        // clipboard listener callback
        const clipboardOnChange = clipboardListener.addListener(
          'onClipboardChange',
          async clipContent => {
            try {
              await sendClipBoard(clipContent);
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          },
        );

        // websocket stomp client
        const stompClient = new Client({
          brokerURL: websocket_url,
          reconnectDelay: 10000,
          connectionTimeout: 5000,
          forceBinaryWSFrames: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#forceBinaryWSFrames
          // appendMissingNULLonIncoming: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#appendMissingNULLonIncoming
          onConnect: async () => {
            await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');

            // Subscribe to a topic
            stompClient.subscribe(subscription_destination, async message => {
              try {
                toggle = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '✅ Connected - Subscribed',
                );

                if (message && message.body) {
                  let cb = String(JSON.parse(message.body).text);
                  if (cipher_enabled === 'true') {
                    cb = await decrypt(JSON.parse(cb));
                  }

                  if (await validateClipboardSize(cb, 'Inbound')) {
                    const hcb = await hashCB(cb);
                    if (await newCB(hcb)) {
                      previous_clipboard_content_hash = hcb;
                      Clipboard.setString(cb);
                    }
                  }
                }
              } catch (e) {
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '❌ Inbound Error: ' + e,
                );
              }
            });
          },
          onDisconnect: async () => {
            await setDataInAsyncStorage('wsStatusMessage', 'Disconnected');
          },
          onStompError: async frame => {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ STOMP Error: ' + JSON.stringify(frame, null, 2),
            );
          },
          onWebSocketError: async event => {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ WebSocket Error: ' + JSON.stringify(event, null, 2),
            );
          },
          onWebSocketClose: async event => {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '⚠️ WebSocket Close: ' + event.reason,
            );
          },
        });

        // start websocket stomp connection
        stompClient.activate();

        // send clipboard content
        const sendClipBoard = async clipContent => {
          try {
            if (stompClient && stompClient.connected && !toggle) {
              if (await validateClipboardSize(clipContent, 'Outbound')) {
                const hcb = await hashCB(clipContent);
                if (await newCB(hcb)) {
                  toggle = true;
                  previous_clipboard_content_hash = hcb;
                  if (cipher_enabled === 'true') {
                    clipContent = await encrypt(clipContent);
                  }
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '✅ Connected - Broadcasting',
                  );
                  stompClient.publish({
                    destination: send_destination,
                    body: JSON.stringify({text: String(clipContent)}),
                  });
                }
              }
            }
          } catch (e) {
            throw e;
          }
        };

        // terminate service when wsIsRunning is false
        const stopServices = async () => {
          if (stompClient) {
            stompClient.deactivate();
          }
          ClipboardListener.stopListening();
          if (clipboardOnChange) {
            clipboardOnChange.remove();
          }
          await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
          await notifee.stopForegroundService();
        };

        const intervalId = setInterval(async () => {
          // check if wsIsRunning is true or else terminate the service
          if ((await getDataFromAsyncStorage('wsIsRunning')) !== 'true') {
            await stopServices();
            clearInterval(intervalId);
          }

          // check if ping initiated
          const echo = await getDataFromAsyncStorage('echo');
          if (echo && echo === 'ping') {
            await setDataInAsyncStorage('echo', 'pong');
          }
        }, 1000);
      } catch (error) {
        await setDataInAsyncStorage('wsStatusMessage', '❌ Error:' + error);
        await notifee.stopForegroundService();
      }
    });
  });

  // notification
  const onDisplayNotification = async () => {
    try {
      // Create a notification channel for Android
      const channelId = await notifee.createChannel({
        id: 'ClipCascade',
        name: 'ClipCascade Monitor',
        importance: AndroidImportance.LOW,
        sound: '',
      });

      // Display a notification to start the foreground service
      await notifee.displayNotification({
        title: 'ClipCascade',
        android: {
          channelId,
          asForegroundService: true,
          smallIcon: 'ic_small_icon',
          color: 'gray',
          pressAction: {
            id: 'default',
            launchActivity: 'default',
          },
        },
      });
    } catch (e) {
      throw e;
    }
  };

  // init
  useEffect(() => {
    const inti = async () => {
      // enable websocket button
      await setDataInAsyncStorage('enableWSButton', 'true');

      // start interval for websocket status message
      startIntervalWSM();

      // get data from async storage and initialize data hook
      let data_s = await getAsyncStorage();
      setData(data_s);

      // Check if websocket is running, if so directly navigate to next page
      let wsIsRunning_s = await getDataFromAsyncStorage('wsIsRunning');
      if (wsIsRunning_s === null) {
        wsIsRunning_s = 'false';
      }
      // check if foreground service is running
      if (wsIsRunning_s === 'true') {
        setLoadingPageMessage('Checking foreground service...');
        await setDataInAsyncStorage('echo', 'ping');
        await new Promise(resolve => setTimeout(resolve, 1500));
        const echo = await getDataFromAsyncStorage('echo');
        if (!(echo && echo === 'pong')) {
          wsIsRunning_s = 'false';
          await setDataInAsyncStorage(
            'wsStatusMessage',
            '⚠️ Foreground service not running',
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
        } else {
          //enable login page
          setEnableLoginPage(true);
          if (data_s.save_password === 'true') {
            const pass = await getDataFromAsyncStorage('password');
            if (pass !== null) {
              setPassword(pass);
              handleLogin(pass, data_s);
            }
          }
        }
      }
    };

    inti();
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

  // Function to start the interval for WebSocket StatusMessage
  const startIntervalWSM = () => {
    try {
      const intervalId = setInterval(async () => {
        if ((await getDataFromAsyncStorage('wsIsRunning')) === 'true') {
          const msg = await getDataFromAsyncStorage('wsStatusMessage');
          if (msg !== null && msg !== '') {
            setWsPageMessage(msg);
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

  // view
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
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Password:</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={text => setPassword(text)}
              secureTextEntry
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Server URL:</Text>
            <TextInput
              style={styles.input}
              value={data.server_url}
              onChangeText={text => handleInputChange('server_url', text)}
            />
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>WebSocket URL:</Text>
            <TextInput
              style={styles.input}
              value={data.websocket_url}
              onChangeText={text => handleInputChange('websocket_url', text)}
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
                    handleInputChange('subscription_destination', text)
                  }
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Send Destination:</Text>
                <TextInput
                  style={styles.input}
                  value={data.send_destination}
                  onChangeText={text =>
                    handleInputChange('send_destination', text)
                  }
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
                      isNaN(Number(text)) ? data.hash_rounds : text,
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
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Login URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.login_url}
                  onChangeText={text => handleInputChange('login_url', text)}
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Logout URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.logout_url}
                  onChangeText={text => handleInputChange('logout_url', text)}
                />
              </View>
              <View style={styles.row}>
                <Text style={styles.label}>Max Size URL:</Text>
                <TextInput
                  style={styles.input}
                  value={data.maxsize_url}
                  onChangeText={text => handleInputChange('maxsize_url', text)}
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
                        : text,
                    )
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
                    1. Select the text you want to copy.
                  </Text>
                  <Text style={styles.label}>
                    2. Tap 'ClipCascade' instead of 'Copy'.
                  </Text>
                  <Text style={[styles.label, {marginLeft: 15}]}>(or)</Text>
                  <Text style={[styles.label, {marginLeft: 15}]}>
                    Tap 'Share', select 'ClipCascade'.
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
