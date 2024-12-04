import {
  NativeEventEmitter,
  NativeModules,
  DeviceEventEmitter,
} from 'react-native';

import notifee, {AndroidImportance} from '@notifee/react-native'; // notification, foreground service
import {Client} from '@stomp/stompjs'; // stomp over websocket
import * as encoding from 'text-encoding'; //do not remove this (polyfills for TextEncoder/TextDecoder stompjs)
import {xxHash32} from 'js-xxhash'; // hashing
import AesGcmCrypto from 'react-native-aes-gcm-crypto'; // encryption/decryption
import {Buffer} from 'buffer'; // handling streams of binary data

/*
 * Replace 'react-native' with '@react-native-clipboard/clipboard' when using react 19 or
 * when react-native-clipboard is supporting higher verions.
 * https://reactnative.dev/docs/clipboard
 * https://github.com/react-native-clipboard/clipboard
 */
import {Clipboard} from 'react-native'; // clipboard

import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  clearAsyncStorage,
} from './AsyncStorageManagement'; // persistent storage

module.exports = async (inputData = null) => {
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

    return [true, 'Foreground service is running'];
  } catch (error) {
    return [false, error];
  }
};
