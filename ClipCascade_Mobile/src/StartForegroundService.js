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
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc'; // webrtc

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
import {time} from 'console';

module.exports = async (inputData = null) => {
  // Constants
  const SUBSCRIPTION_DESTINATION = '/user/queue/cliptext';
  const SEND_DESTINATION = '/app/cliptext';
  const RECONNECT_WS_TIMER = 10000; // 10 seconds
  const HEARTBEAT_INTERVAL = 20000; // 20 seconds
  const FRAGMENT_SIZE = 15360; // 15 KiB

  // forground service
  notifee.registerForegroundService(notification => {
    return new Promise(async () => {
      try {
        const {NativeBridgeModule} = NativeModules;

        let previous_clipboard_content_hash = '';
        let toggle = false; // p2s toggle
        let block_image_once = false;
        let files_in_memory = null;
        let websocket_status_notification_toggle = false;
        let p2pMsg = null; // p2p status message

        let stompClient = null;
        let wsSignalingClient = null;
        let sendClipBoardP2S = null;
        let sendClipBoardP2P = null;
        let stopServicesP2S = null;
        let stopServicesP2P = null;
        let getP2PStatusMessage = null;
        let isP2PStatusMsgChanged = false;

        // get data from async storage
        const websocket_url = await getDataFromAsyncStorage('websocket_url');
        const cipher_enabled = await getDataFromAsyncStorage('cipher_enabled');
        const maxsize = Number(await getDataFromAsyncStorage('maxsize'));
        const server_mode = await getDataFromAsyncStorage('server_mode');
        const stun_url = await getDataFromAsyncStorage('stun_url');
        const enable_image_sharing = await getDataFromAsyncStorage(
          'enable_image_sharing',
        );
        const enable_file_sharing = await getDataFromAsyncStorage(
          'enable_file_sharing',
        );
        const enable_websocket_status_notification =
          await getDataFromAsyncStorage('enable_websocket_status_notification');
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

        // fragment string into chunks
        const fragmentString = async (str, fragmentSize) => {
          const bytes = new TextEncoder().encode(str); // convert to UTF-8 bytes
          const fragments = [];
          for (let i = 0; i < bytes.length; i += fragmentSize) {
            const chunk = bytes.slice(i, i + fragmentSize);
            fragments.push(new TextDecoder().decode(chunk));
          }
          return fragments;
        };

        // generate uuid
        const generateUuid = async () => {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        };

        const p2pStatusMessageChanged = async () => {
          isP2PStatusMsgChanged = true;
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

          if (server_mode === 'P2S') {
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
          } else if (server_mode === 'P2P') {
            if (
              max_clipboard_size_local_limit_bytes < 0 ||
              clipContentByteLength <= max_clipboard_size_local_limit_bytes
            ) {
              return true;
            }

            p2pMsg =
              '⚠️ ' +
              direction +
              ' clipboard ignored: \n size (' +
              clipContentByteLength +
              ' bytes) exceeds limits: \n Local max size (' +
              max_clipboard_size_local_limit_bytes +
              ' bytes)';
            await p2pStatusMessageChanged();
          }

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

        const clearFiles = async (expensiveCall = false) => {
          files_in_memory = null;
          if (!expensiveCall) {
            await notifee.cancelNotification(
              'ClipCascade_Download_Files_Notification_Id',
            );
            await setDataInAsyncStorage('filesAvailableToDownload', 'false');
            await setDataInAsyncStorage('downloadFiles', 'false');
            await setDataInAsyncStorage('dirPath', '');
          }
        };

        const showFilesDownloadNotification = async msg => {
          // Display a silent notification
          await notifee.displayNotification({
            id: 'ClipCascade_Download_Files_Notification_Id',
            title: msg,
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
        };

        const showWebSocketStatusNotification = async (
          msg,
          timeout = 10000,
        ) => {
          await notifee.displayNotification({
            id: 'ClipCascade_WebSocket_Status_Notification_Id',
            title: msg,
            android: {
              channelId: 'ClipCascade_Connection_Status',
              smallIcon: 'ic_small_icon',
              pressAction: {
                id: 'default',
                launchActivity: 'default',
              },
              timeoutAfter: timeout === -1 ? undefined : timeout,
            },
          });
        };

        if (server_mode === 'P2S') {
          // websocket stomp client
          stompClient = new Client({
            brokerURL: websocket_url,
            reconnectDelay: RECONNECT_WS_TIMER,
            connectionTimeout: 5000,
            heartbeatIncoming: HEARTBEAT_INTERVAL,
            heartbeatOutgoing: 0,
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
                    const type_ = body.type ?? 'text';

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
                          await showFilesDownloadNotification(
                            '📥 Download File(s)',
                          );

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

              if (enable_websocket_status_notification === 'true') {
                if (websocket_status_notification_toggle == true) {
                  websocket_status_notification_toggle = false;
                  await showWebSocketStatusNotification(
                    'WebSocket Connection Restored 🔗',
                  );
                } else {
                  await notifee.cancelNotification(
                    'ClipCascade_WebSocket_Status_Notification_Id',
                  );
                }
              }
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
              if (
                enable_websocket_status_notification === 'true' &&
                websocket_status_notification_toggle == false &&
                (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
              ) {
                websocket_status_notification_toggle = true;
                await showWebSocketStatusNotification(
                  'WebSocket Connection Lost ⛓️‍💥',
                  -1,
                );
              }
            },
          });

          // start websocket stomp connection
          stompClient.activate();

          // send clipboard content P2S
          sendClipBoardP2S = async (clipContent, type_ = 'text') => {
            try {
              await clearFiles();
              if (stompClient && stompClient.connected && !toggle) {
                if (
                  (type_ === 'image' && enable_image_sharing === 'false') ||
                  (type_ === 'files' && enable_file_sharing === 'false')
                ) {
                  return;
                }

                if (
                  await validateClipboardSize(clipContent, type_, 'Outbound')
                ) {
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

          // stop events and connection P2S
          stopServicesP2S = async () => {
            // 1) Stop clipboard listening
            try {
              await ClipboardListener.stopListening();
              if (clipboardOnChange) {
                clipboardOnChange.remove();
              }
            } catch (e) {
              // no-op
            }

            // 2) Deactivate STOMP client safely
            if (stompClient) {
              // Remove stomp event handlers
              stompClient.onConnect = null;
              stompClient.onDisconnect = null;
              stompClient.onStompError = null;
              stompClient.onWebSocketError = null;
              stompClient.onWebSocketClose = null;

              // Deactivate the stomp connection
              try {
                await stompClient.deactivate();
              } catch (e) {
                // no-op
              }
            }
            stompClient = null;

            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            await notifee.stopForegroundService();
          };
        } else if (server_mode === 'P2P') {
          // p2p variables
          let myPeerId = null; // Your assigned peer ID from server
          let peers = new Set(); // Current set of known peer IDs in the "room"
          let peerConnections = {}; // Map: peerId -> RTCPeerConnection
          let dataChannels = {}; // Map: peerId -> RTCDataChannel
          let liveConnectionsCount = 0; // Track open DataChannels

          // Fragment variables
          let sendingFragmentId = '';
          let receivingFragments = {}; // Map: fragmentId -> array of strings (ordered)
          let sendingFragmentStats = null;
          let receivingFragmentStats = null;

          getP2PStatusMessage = async () => {
            let msg = '📊';
            msg += ` Peers: ${liveConnectionsCount}`;
            if (sendingFragmentStats != null) {
              msg += ` | Sending: ${sendingFragmentStats}`;
            }
            if (receivingFragmentStats != null) {
              msg += ` | Receiving: ${receivingFragmentStats}`;
            }
            if (p2pMsg != null) {
              msg += `\n${p2pMsg}`;
            }
            return msg;
          };

          const resetSendingFragmentId = async () => {
            sendingFragmentId = '';
            sendingFragmentStats = null;
            await resetP2PMsg();
          };

          const resetReceivingFragments = async () => {
            receivingFragments = {};
            receivingFragmentStats = null;
            await resetP2PMsg();
          };

          const resetP2PMsg = async () => {
            p2pMsg = null;
            await p2pStatusMessageChanged();
          };

          const initializeWebSocketSignalingClient = async () => {
            if (wsSignalingClient == null) {
              wsSignalingClient = new WebSocket(websocket_url);

              wsSignalingClient.onopen = async () => {
                await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');

                if (enable_websocket_status_notification === 'true') {
                  if (websocket_status_notification_toggle == true) {
                    websocket_status_notification_toggle = false;
                    await showWebSocketStatusNotification(
                      'WebSocket Connection Restored 🔗',
                    );
                  } else {
                    await notifee.cancelNotification(
                      'ClipCascade_WebSocket_Status_Notification_Id',
                    );
                  }
                }
              };

              wsSignalingClient.onmessage = async event => {
                try {
                  const data = JSON.parse(event.data);
                  switch (data.type) {
                    case 'ASSIGNED_ID':
                      if (myPeerId && myPeerId !== data.peerId) {
                        await cleanupPeerConnections();
                      }
                      myPeerId = data.peerId;
                      break;

                    case 'PEER_LIST':
                      await handlePeerList(data.peers);
                      break;

                    case 'OFFER':
                      await handleOffer(data.fromPeerId, data.offer);
                      break;

                    case 'ANSWER':
                      await handleAnswer(data.fromPeerId, data.answer);
                      break;

                    case 'ICE_CANDIDATE':
                      await handleIceCandidate(data.fromPeerId, data.candidate);
                      break;
                  }

                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '✅ Connected',
                  );
                } catch (e) {
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '❌ Inbound Error: ' + e,
                  );
                }
              };

              wsSignalingClient.onerror = async event => {
                block_image_once = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '❌ WebSocket Error: ' + JSON.stringify(event, null, 2),
                );
              };

              wsSignalingClient.onclose = async event => {
                block_image_once = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  '⚠️ WebSocket Close: ' + event.reason,
                );
                if (
                  enable_websocket_status_notification === 'true' &&
                  websocket_status_notification_toggle == false &&
                  (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
                ) {
                  websocket_status_notification_toggle = true;
                  await showWebSocketStatusNotification(
                    'WebSocket Connection Lost ⛓️‍💥',
                    -1,
                  );
                }

                wsSignalingClient = null;
                setTimeout(async () => {
                  if (
                    wsSignalingClient == null &&
                    (await getDataFromAsyncStorage('wsIsRunning')) === 'true'
                  ) {
                    initializeWebSocketSignalingClient();
                  }
                }, RECONNECT_WS_TIMER);
              };
            }
          };

          // start websocket signaling connection
          initializeWebSocketSignalingClient();

          // send clipboard content P2P
          sendClipBoardP2P = async (clipContent, type_ = 'text') => {
            try {
              await clearFiles();
              if (
                (type_ === 'image' && enable_image_sharing === 'false') ||
                (type_ === 'files' && enable_file_sharing === 'false')
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
                    await resetSendingFragmentId();
                    await resetReceivingFragments();

                    const rawPayloadSizeInBytes = new TextEncoder().encode(
                      clipContent,
                    ).length;

                    if (cipher_enabled === 'true') {
                      //ecrypt
                      clipContent = await encrypt(clipContent);
                    }

                    // fragment payload
                    const fragments = await fragmentString(
                      clipContent,
                      FRAGMENT_SIZE,
                    );

                    const metadata = {
                      id: await generateUuid(),
                      isFragmented: fragments.length > 1,
                      index: 0,
                      totalFragments: fragments.length,
                      combinedRawPayloadSizeInBytes: rawPayloadSizeInBytes,
                    };

                    let loopBroken = false;
                    sendingFragmentId = metadata.id;
                    for (let i = 0; i < fragments.length; i++) {
                      if (sendingFragmentId != metadata.id) {
                        loopBroken = true;
                        return;
                      }

                      const fragment = fragments[i];

                      const messageJson = JSON.stringify({
                        payload: fragment,
                        type: type_,
                        metadata: metadata,
                      });
                      metadata.index += 1;

                      // send to all open DataChannels
                      Object.entries(dataChannels).forEach(
                        async ([peerId, channel]) => {
                          if (channel.readyState === 'open') {
                            await channel.send(messageJson);
                          }
                        },
                      );

                      // Update stats
                      if (metadata.isFragmented) {
                        sendingFragmentStats = `${metadata.index}/${metadata.totalFragments}`;
                        await p2pStatusMessageChanged();
                      }
                    }
                    if (!loopBroken) {
                      await resetSendingFragmentId();
                    }
                  }
                }
              }
            } catch (e) {
              block_image_once = false;
              p2pMsg = '❌ P2P Outbound Error: ' + JSON.stringify(e, null, 2);
              await p2pStatusMessageChanged();
            }
          };

          // stop events and connection P2P
          stopServicesP2P = async () => {
            // 1) Stop listening to clipboard events
            try {
              await ClipboardListener.stopListening();
              if (clipboardOnChange) {
                clipboardOnChange.remove();
              }
            } catch (e) {
              // no-op
            }

            // 2) Clean up the WebSocket (signaling client)
            if (wsSignalingClient) {
              // Remove all listeners so it won't re-fire or reconnect
              wsSignalingClient.onopen = null;
              wsSignalingClient.onmessage = null;
              wsSignalingClient.onerror = null;
              wsSignalingClient.onclose = null;

              // Close it
              try {
                wsSignalingClient.close();
              } catch (e) {
                // no-op
              }
            }
            wsSignalingClient = null;

            // 3) Close all DataChannels and RTCPeerConnections
            await cleanupPeerConnections();

            // 4) Finally, stop the foreground service
            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            await setDataInAsyncStorage('p2pStatusMessage', '');
            await notifee.stopForegroundService();
          };

          // send message to websocket signaling server
          const signalingSend = async obj => {
            try {
              if (
                wsSignalingClient &&
                wsSignalingClient.readyState === WebSocket.OPEN
              ) {
                wsSignalingClient.send(JSON.stringify(obj));
                await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
              }
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          };

          // receive clipboard content P2P
          const onDataChannelMessage = async messageJson => {
            try {
              await clearFiles((expensiveCall = true));
              await resetSendingFragmentId();

              const message = JSON.parse(messageJson);
              let cb = String(message.payload);
              const type_ = message.type ?? 'text';
              const metadata = message.metadata;

              // Check if the payload exceeds the maximum size: first layer protection
              if (
                metadata != null &&
                max_clipboard_size_local_limit_bytes >= 0 &&
                metadata.combinedRawPayloadSizeInBytes >
                  max_clipboard_size_local_limit_bytes
              ) {
                await resetReceivingFragments();
                p2pMsg = `⚠️ Payload size limit exceeded: ${metadata['combinedRawPayloadSizeInBytes']} bytes exceeds ${max_clipboard_size_local_limit_bytes} bytes`;
                await p2pStatusMessageChanged();
                return;
              }

              // Fragmented message handling
              if (metadata != null && metadata.isFragmented) {
                receivingFragmentStats = `${metadata.index + 1}/${
                  metadata.totalFragments
                }`;
                await p2pStatusMessageChanged();

                if (metadata.id in receivingFragments) {
                  receivingFragments[metadata.id][metadata.index] = cb;

                  // If this is the last fragment, try to combine
                  if (metadata.index === metadata.totalFragments - 1) {
                    // Check if all fragments are present (none is empty)
                    if (
                      receivingFragments[metadata.id].every(frag => frag !== '')
                    ) {
                      // Join them all together into one payload
                      cb = receivingFragments[metadata.id].join('');
                    } else {
                      // Missing fragment(s): error out
                      await resetReceivingFragments();
                      p2pMsg =
                        'Failed to receive: One or more fragments are missing or the clipboard changed before completion.';
                      await p2pStatusMessageChanged();
                      return;
                    }
                  } else {
                    // Not the last fragment, so we don't proceed further
                    return;
                  }
                } else {
                  await resetReceivingFragments();
                  receivingFragments[metadata.id] = Array(
                    metadata.totalFragments,
                  ).fill('');
                  receivingFragments[metadata.id][metadata.index] = cb;
                  return;
                }
              }

              await clearFiles();

              // decrypt
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

                await resetReceivingFragments();
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
                    await showFilesDownloadNotification('📥 Download File(s)');

                    files_in_memory = cb;
                    await setDataInAsyncStorage(
                      'filesAvailableToDownload',
                      'true',
                    );
                  }
                }
              }
            } catch (e) {
              p2pMsg = '❌ P2P Inbound Error: ' + e;
              await p2pStatusMessageChanged();
            }
          };

          const cleanupPeerConnections = async () => {
            // 1) Close all DataChannels
            for (const [peerId, dc] of Object.entries(dataChannels)) {
              if (dc) {
                try {
                  dc.onopen = null;
                  dc.onmessage = null;
                  dc.onclose = null;
                  dc.onerror = null;
                  dc.close();
                } catch (e) {
                  // no-op
                }
              }
            }
            dataChannels = {};

            // 2) Close all RTCPeerConnections
            for (const [peerId, pc] of Object.entries(peerConnections)) {
              if (pc) {
                try {
                  pc.onicecandidate = null;
                  pc.ondatachannel = null;
                  pc.close();
                } catch (e) {
                  // no-op
                }
              }
            }
            peerConnections = {};

            // 3) Reset local P2P state as needed
            myPeerId = null;
            peers.clear();
            liveConnectionsCount = 0;
            await resetReceivingFragments();
            await resetSendingFragmentId();
          };

          /**
           * The server gave us the entire list of peers in the "room".
           * For each peer, create a PeerConnection if we don't have one yet.
           */
          const handlePeerList = async peerList => {
            const updatedPeers = new Set(peerList);

            await removeStalePeers(updatedPeers);

            peers = updatedPeers;
            peers.forEach(async pid => {
              if (pid === myPeerId) return; // skip self
              if (!peerConnections[pid]) {
                // Create new PeerConnection
                const pc = await createPeerConnection(pid);
                peerConnections[pid] = pc;

                // Tie-breaker: only the "lower" ID makes the offer to avoid collisions
                if (myPeerId < pid) {
                  const channel = await pc.createDataChannel('cliptext');
                  dataChannels[pid] = channel;
                  await setupDataChannel(pid, channel);
                  await createOffer(pid);
                }
              }
            });
          };

          /**
           * Close connections and data channels for peers that no longer exist in PEER_LIST.
           */
          const removeStalePeers = async updatedPeers => {
            // 1) Find which peer IDs are no longer present
            const stalePeerIds = Object.keys(peerConnections).filter(
              pid => !updatedPeers.has(pid),
            );
            // 2) For each stale peer, close data channel and peer connection
            for (const oldPid of stalePeerIds) {
              // Close and remove its data channel
              if (dataChannels[oldPid]) {
                try {
                  if (dataChannels[oldPid].readyState === 'open') {
                    liveConnectionsCount--;
                    await p2pStatusMessageChanged();
                  }
                  dataChannels[oldPid].onopen = null;
                  dataChannels[oldPid].onmessage = null;
                  dataChannels[oldPid].onclose = null;
                  dataChannels[oldPid].onerror = null;
                  dataChannels[oldPid].close();
                } catch (err) {}
                delete dataChannels[oldPid];
              }

              // Close and remove its RTCPeerConnection
              if (peerConnections[oldPid]) {
                try {
                  peerConnections[oldPid].onicecandidate = null;
                  peerConnections[oldPid].ondatachannel = null;
                  peerConnections[oldPid].close();
                } catch (err) {}
                delete peerConnections[oldPid];
              }
            }
          };

          /**
           * Create and return a RTCPeerConnection, set up listeners for ICE + DataChannel.
           */
          const createPeerConnection = async remotePeerId => {
            const pc = new RTCPeerConnection({
              iceServers: [
                {
                  urls: stun_url,
                },
              ],
            });

            // This fires when the local side gathers an ICE candidate
            pc.onicecandidate = async event => {
              if (event.candidate) {
                await signalingSend({
                  type: 'ICE_CANDIDATE',
                  fromPeerId: myPeerId,
                  toPeerId: remotePeerId,
                  candidate: event.candidate,
                });
              }
            };

            // This fires when the remote side creates a datachannel
            pc.ondatachannel = async event => {
              const channel = event.channel;
              dataChannels[remotePeerId] = channel;
              await setupDataChannel(remotePeerId, channel);
            };

            return pc;
          };

          /**
           * Create an SDP offer for remotePeerId and send via signaling.
           */
          const createOffer = async remotePeerId => {
            const pc = peerConnections[remotePeerId];
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            await signalingSend({
              type: 'OFFER',
              fromPeerId: myPeerId,
              toPeerId: remotePeerId,
              offer: pc.localDescription,
            });
          };

          /**
           * Handle incoming OFFER from remote, then respond with ANSWER.
           */
          const handleOffer = async (fromPeerId, offer) => {
            let pc = peerConnections[fromPeerId];
            if (!pc) {
              pc = await createPeerConnection(fromPeerId);
              peerConnections[fromPeerId] = pc;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await signalingSend({
              type: 'ANSWER',
              fromPeerId: myPeerId,
              toPeerId: fromPeerId,
              answer: pc.localDescription,
            });
          };

          /**
           * Handle incoming ANSWER from remote to our previously sent OFFER.
           */
          const handleAnswer = async (fromPeerId, answer) => {
            const pc = peerConnections[fromPeerId];
            if (!pc) {
              return;
            }

            await pc.setRemoteDescription(new RTCSessionDescription(answer));
          };

          /**
           * Handle incoming ICE candidate from remote peer.
           */
          const handleIceCandidate = async (fromPeerId, candidateData) => {
            const pc = peerConnections[fromPeerId];
            if (!pc) {
              return;
            }

            await pc.addIceCandidate(new RTCIceCandidate(candidateData));
          };

          /**
           * Set up DataChannel for remotePeerId.
           */
          const setupDataChannel = async (remotePeerId, channel) => {
            channel.onopen = async () => {
              liveConnectionsCount++;
              await p2pStatusMessageChanged();
            };

            channel.onmessage = async e => {
              await onDataChannelMessage(e.data);
            };

            channel.onclose = async () => {
              liveConnectionsCount--;
              await p2pStatusMessageChanged();
            };

            channel.onerror = async err => {
              p2pMsg = '❌ DataChannel error with ' + remotePeerId + ': ' + err;
              await p2pStatusMessageChanged();
            };
          };
        }

        // send clipboard content
        const sendClipBoard = async (clipContent, type_ = 'text') => {
          if (server_mode === 'P2S') {
            await sendClipBoardP2S(clipContent, type_);
          } else if (server_mode === 'P2P') {
            await sendClipBoardP2P(clipContent, type_);
          }
        };

        // terminate service when wsIsRunning is false
        const stopServices = async () => {
          if (server_mode === 'P2S') {
            await stopServicesP2S();
          } else if (server_mode === 'P2P') {
            await stopServicesP2P();
          }

          DeviceEventEmitter.removeAllListeners('SHARED_TEXT');
          DeviceEventEmitter.removeAllListeners('SHARED_IMAGE');
          DeviceEventEmitter.removeAllListeners('SHARED_FILES');
        };

        const intervalId = setInterval(async () => {
          // check if wsIsRunning is true or else terminate the service
          if ((await getDataFromAsyncStorage('wsIsRunning')) !== 'true') {
            await stopServices();
            clearInterval(intervalId);
            await setDataInAsyncStorage(
              'wsForegroundServiceTerminated',
              'true',
            );
            return;
          }

          if (isP2PStatusMsgChanged) {
            isP2PStatusMsgChanged = false;
            await setDataInAsyncStorage(
              'p2pStatusMessage',
              await getP2PStatusMessage(),
            );
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
              await notifee.displayNotification({
                id: 'ClipCascade_Download_Files_Progress_Notification_Id',
                title: 'Downloading File(s)...',
                android: {
                  channelId: 'ClipCascade_Progress',
                  smallIcon: 'ic_small_icon',
                  progress: {
                    indeterminate: true,
                  },
                },
              });

              if (files_in_memory != null) {
                // save files
                await NativeBridgeModule.saveBase64Files(
                  dirPath,
                  files_in_memory,
                );
              }
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
    // Create a notification channel for the foreground service
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

    // Create a notification channel for download progress
    await notifee.createChannel({
      id: 'ClipCascade_Progress',
      name: 'ClipCascade Download Progress',
      importance: AndroidImportance.DEFAULT,
    });

    // Create a notification channel for connection status
    await notifee.createChannel({
      id: 'ClipCascade_Connection_Status',
      name: 'ClipCascade Connection Status',
      importance: AndroidImportance.HIGH,
    });

    return [true, 'Foreground service is running'];
  } catch (error) {
    return [false, error];
  }
};
