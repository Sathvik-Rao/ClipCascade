import {
  NativeEventEmitter,
  NativeModules,
  DeviceEventEmitter,
  Alert,
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
  // Constants
  const SUBSCRIPTION_DESTINATION = '/user/queue/cliptext';
  const SEND_DESTINATION = '/app/cliptext';

  // forground service
  notifee.registerForegroundService(notification => {
    return new Promise(async () => {
      try {
        const {NativeBridgeModule} = NativeModules;

        let previous_clipboard_content_hash = '';
        let toggle = false;
        let block_image_once = false;
        let files_in_memory = null;

        // get data from async storage
        const websocket_url = await getDataFromAsyncStorage('websocket_url');
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

        const calculateBase64DecodedLength = async base64Str => {
          // Calculates the decoded byte length of a Base64-encoded string.
          const n = base64Str.length;
          const padding = (base64Str.match(/=/g) || []).length;
          return 3 * (n / 4) - padding;
        };

        // validate clipboard size
        const validateClipboardSize = async (clipContent, type, direction) => {
          let clipContentByteLength = 0;
          if (type === 'text') {
            clipContentByteLength = Buffer.byteLength(clipContent, 'utf8');
          } else if (type === 'image') {
            if (
              direction.toLowerCase() === 'outbound' &&
              typeof clipContent === 'string'
            ) {
              clipContentByteLength = Number(
                await NativeBridgeModule.getFileSize(clipContent),
              );
            } else if (direction.toLowerCase() === 'inbound') {
              clipContentByteLength = await calculateBase64DecodedLength(
                clipContent,
              );
            }
          } else if (type === 'files') {
            if (
              direction.toLowerCase() === 'outbound' &&
              typeof clipContent === 'string'
            ) {
              const file_paths = clipContent
                .split(',')
                .filter(item => item.trim() !== '');
              for (const file_path of file_paths) {
                clipContentByteLength += Number(
                  await NativeBridgeModule.getFileSize(file_path),
                );
              }
            } else if (direction.toLowerCase() === 'inbound') {
              let files = JSON.parse(clipContent);
              for (const file in files) {
                clipContentByteLength += await calculateBase64DecodedLength(
                  files[file],
                );
              }
            }
          } else {
            return false;
          }

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

        // Event triggered when text content is shared with the app. (or) when text selection popup menu action is invoked
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
              await sendClipBoard(clipContent, 'text');
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        // Event listener triggered when image is shared with the app.
        DeviceEventEmitter.addListener('SHARED_IMAGE', async event => {
          try {
            const clipContent = event.image;
            if (clipContent) {
              await sendClipBoard(clipContent, 'image');
            }
          } catch (e) {
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ Outbound Error: ' + e,
            );
          }
        });

        // Event listener triggered when files are shared with the app.
        DeviceEventEmitter.addListener('SHARED_FILES', async event => {
          try {
            const clipContent = event.files;
            if (clipContent) {
              await sendClipBoard(clipContent, 'files');
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
          async params => {
            try {
              if (params && params.content && params.type) {
                await sendClipBoard(params.content, params.type);
              }
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          },
        );

        const clearFiles = async () => {
          files_in_memory = null;
          await notifee.cancelNotification(
            'ClipCascade_Download_Files_Notification_Id',
          );
          await setDataInAsyncStorage('filesAvailableToDownload', 'false');
          await setDataInAsyncStorage('downloadFiles', 'false');
          await setDataInAsyncStorage('dirPath', '');
        };

        // websocket stomp client
        const stompClient = new Client({
          brokerURL: websocket_url,
          reconnectDelay: 10000,
          connectionTimeout: 5000,
          forceBinaryWSFrames: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#forceBinaryWSFrames
          // appendMissingNULLonIncoming: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#appendMissingNULLonIncoming
          onConnect: async () => {
            await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
            toggle = false;

            // Subscribe to a topic
            stompClient.subscribe(SUBSCRIPTION_DESTINATION, async message => {
              try {
                await clearFiles();
                toggle = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '✅ Connected - Subscribed',
                );

                if (message && message.body) {
                  const body = JSON.parse(message.body);
                  let cb = String(body.payload);
                  const type_ = body.type;

                  //decrypt
                  if (cipher_enabled === 'true') {
                    try {
                      cb = await decrypt(JSON.parse(cb));
                    } catch (error) {
                      throw new Error(
                        `Encryption must be enabled on all devices if enabled. JSON parsing failed: ${error.message}`,
                      );
                    }
                  }

                  // hash clipboard content
                  const hcb = await hashCB(cb);
                  if (await newCB(hcb)) {
                    previous_clipboard_content_hash = hcb;

                    // validate clipboard size
                    if (await validateClipboardSize(cb, type_, 'Inbound')) {
                      // set clipboard content
                      if (type_ === 'text') {
                        Clipboard.setString(cb);
                      } else if (type_ === 'image') {
                        await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                          cb,
                        );
                        block_image_once = true;
                      } else if (type_ === 'files') {
                        // Display a silent notification
                        await notifee.displayNotification({
                          id: 'ClipCascade_Download_Files_Notification_Id',
                          title: '📥 Download File(s)',
                          android: {
                            channelId: 'ClipCascade',
                            smallIcon: 'ic_small_icon',
                            color: 'gray',
                            pressAction: {
                              id: 'default',
                              launchActivity: 'default',
                            },
                          },
                        });

                        files_in_memory = cb;
                        await setDataInAsyncStorage(
                          'filesAvailableToDownload',
                          'true',
                        );
                      }
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
            block_image_once = false;
            await setDataInAsyncStorage('wsStatusMessage', 'Disconnected');
          },
          onStompError: async frame => {
            block_image_once = false;
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ STOMP Error: ' + JSON.stringify(frame, null, 2),
            );
          },
          onWebSocketError: async event => {
            block_image_once = false;
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '❌ WebSocket Error: ' + JSON.stringify(event, null, 2),
            );
          },
          onWebSocketClose: async event => {
            block_image_once = false;
            await setDataInAsyncStorage(
              'wsStatusMessage',
              '⚠️ WebSocket Close: ' + event.reason,
            );
          },
        });

        // start websocket stomp connection
        stompClient.activate();

        // send clipboard content
        const sendClipBoard = async (clipContent, type_ = 'text') => {
          try {
            await clearFiles();
            if (stompClient && stompClient.connected && !toggle) {
              if (
                (type_ === 'image' &&
                  (await getDataFromAsyncStorage('enable_image_sharing')) ===
                    'false') ||
                (type_ === 'files' &&
                  (await getDataFromAsyncStorage('enable_file_sharing')) ===
                    'false')
              ) {
                return;
              }

              if (await validateClipboardSize(clipContent, type_, 'Outbound')) {
                // base64 encode
                if (type_ === 'image') {
                  clipContent = await NativeBridgeModule.getFileAsBase64(
                    clipContent,
                  );
                } else if (type_ === 'files') {
                  temp = {};
                  const file_paths = clipContent
                    .split(',')
                    .filter(item => item.trim() !== '');

                  for (const file_path of file_paths) {
                    temp[await NativeBridgeModule.getFileName(file_path)] =
                      await NativeBridgeModule.getFileAsBase64(file_path);
                  }
                  clipContent = JSON.stringify(temp);
                }

                // clipboad content hash
                const hcb = await hashCB(clipContent);
                if (await newCB(hcb)) {
                  previous_clipboard_content_hash = hcb;

                  if (block_image_once) {
                    block_image_once = false;
                  } else {
                    toggle = true;

                    if (cipher_enabled === 'true') {
                      //ecrypt
                      clipContent = await encrypt(clipContent);
                    }

                    await setDataInAsyncStorage(
                      'wsStatusMessage',
                      '✅ Connected - Broadcasting',
                    );

                    // send
                    stompClient.publish({
                      destination: SEND_DESTINATION,
                      body: JSON.stringify({
                        payload: String(clipContent),
                        type: type_,
                      }),
                    });
                  }
                }
              }
            }
          } catch (e) {
            toggle = false;
            block_image_once = false;
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

          // check if user wants to download files
          if (
            ((await getDataFromAsyncStorage('downloadFiles')) === 'true' &&
              (await getDataFromAsyncStorage('filesAvailableToDownload'))) ===
            'true'
          ) {
            try {
              await setDataInAsyncStorage('downloadFiles', 'false');
              const dirPath = await getDataFromAsyncStorage('dirPath');

              // display progress notification
              const channelIdProgress = await notifee.createChannel({
                id: 'ClipCascade_Progress',
                name: 'ClipCascade Download Progress',
                importance: AndroidImportance.DEFAULT,
              });

              await notifee.displayNotification({
                id: 'ClipCascade_Download_Files_Progress_Notification_Id',
                title: 'Downloading File(s)...',
                android: {
                  channelId: channelIdProgress,
                  smallIcon: 'ic_small_icon',
                  progress: {
                    indeterminate: true,
                  },
                },
              });

              // save files
              await NativeBridgeModule.saveBase64Files(
                dirPath,
                files_in_memory,
              );
            } catch (e) {
              // Alert is displayed only when the app is open because this is called from foreground service
              Alert.alert('Error', 'Failed to download files: ' + e);
            } finally {
              await notifee.cancelNotification(
                'ClipCascade_Download_Files_Progress_Notification_Id',
              );
            }
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
