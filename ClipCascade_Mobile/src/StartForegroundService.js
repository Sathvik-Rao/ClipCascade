import {
  NativeEventEmitter,
  NativeModules,
  DeviceEventEmitter,
} from 'react-native';

import notifee, { AndroidImportance } from '@notifee/react-native';
import { Client } from '@stomp/stompjs';
import * as encoding from 'text-encoding'; //do not remove this (polyfills for TextEncoder/TextDecoder stompjs)
import { xxHash32 } from 'js-xxhash';
import AesGcmCrypto from 'react-native-aes-gcm-crypto';
import { Buffer } from 'buffer';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import {discoverServer} from './ServerDiscovery';
import {checkForUpdates} from './UpdateChecker';
import {downloadDirectoryLabel} from './DownloadDirectory';
import {webSocketErrorMessage, webSocketCloseMessage} from './WebSocketStatus';
import {isClipboardSyncEnabled} from './DevicePreferences';
import {fileUris, encodeFiles, deliverPendingShare} from './FileTransfer';

import {
  setDataInAsyncStorage,
  getDataFromAsyncStorage,
  getMultipleDataFromAsyncStorage,
  clearAsyncStorage,
  saveTransportSettings,
} from './AsyncStorageManagement';

function cleanupClipboardListeners() {
  DeviceEventEmitter.removeAllListeners('SHARE_AVAILABLE');
  DeviceEventEmitter.removeAllListeners('SHARED_TEXT');
  DeviceEventEmitter.removeAllListeners('SHARED_IMAGE');
  DeviceEventEmitter.removeAllListeners('SHARED_FILES');
  DeviceEventEmitter.removeAllListeners('onClipboardChange');
}

module.exports = async (inputData = null) => {
  // Constants
  const SUBSCRIPTION_DESTINATION = '/user/queue/cliptext';
  const SEND_DESTINATION = '/app/cliptext';
  const RECONNECT_WS_TIMER = 10000; // 10 seconds
  const HEARTBEAT_INTERVAL = 20000; // 20 seconds
  const FRAGMENT_SIZE = 15360; // 15 KiB
  const FRAGMENT_TTL_MS = 60000; // drop partial fragment buffers idle for 60s
  const STOMP_DEACTIVATE_TIMEOUT_MS = 5000; // bound the STOMP deactivate() wait

  // forground service
  notifee.registerForegroundService(async notification => {
    const { ClipboardListener } = NativeModules;
    let clipboardStarted = false;
    const stopClipboard = async () => {
      if (clipboardStarted) {
        clipboardStarted = false;
        await ClipboardListener.stopListening();
      }
    };
    const runTransport = async () => {
      try {
        let restarting = false;
        let transportStopped = false;
        const { NativeBridgeModule } = NativeModules;
        // Restore trust before either WebSocket mode starts, including headless boot.
        await NativeModules.ServerTlsModule.configure(
          await getDataFromAsyncStorage('server_url'),
          (await getDataFromAsyncStorage('ssl_ca_bundle')) || '',
        );
        if (!clipboardStarted) {
          // Request native log access while monitoring is being started, before
          // network discovery can delay it. Transport changes reuse this reader.
          ClipboardListener.startListening();
          clipboardStarted = true;
        }
        const textEncoder = new encoding.TextEncoder();
        const textDecoder = new encoding.TextDecoder();

        await setDataInAsyncStorage('fileDownloadInProgress', 'false');
        await setDataInAsyncStorage('fileDownloadStatus', '');

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
        let isShareTransportReady = () => false;
        let getP2PStatusMessage = null;
        let isP2PStatusMsgChanged = false;

        // Discover in the service too: Android can start it without the app UI.
        const keys = [
          'server_url', 'websocket_url', 'cipher_enabled', 'maxsize',
          'server_mode', 'stun_url', 'enable_image_sharing',
          'enable_file_sharing', 'enable_websocket_status_notification',
          'max_clipboard_size_local_limit_bytes',
        ];
        let settings = await getMultipleDataFromAsyncStorage(keys);
        const refreshSettings = async () => {
          while (!transportStopped && (await getDataFromAsyncStorage('wsIsRunning')) === 'true') {
            try {
              const next = await discoverServer(settings);
              if (transportStopped || (await getDataFromAsyncStorage('wsIsRunning')) !== 'true') return null;
              await saveTransportSettings(next);
              return next;
            } catch (error) {
              await setDataInAsyncStorage('wsStatusMessage', '❌ ' + error.message + '; retrying…');
              await new Promise(resolve => setTimeout(resolve, RECONNECT_WS_TIMER));
            }
          }
          return null;
        };
        settings = await refreshSettings();
        if (!settings) {
          await stopClipboard();
          await setDataInAsyncStorage('wsForegroundServiceTerminated', 'true');
          await notifee.stopForegroundService();
          return false;
        }
        const {
          websocket_url, cipher_enabled, maxsize: maxsizeStr, server_mode,
          stun_url, enable_image_sharing, enable_file_sharing,
          enable_websocket_status_notification,
          max_clipboard_size_local_limit_bytes: maxClipboardLimitStr,
        } = settings;
        const prepareReconnect = async () => {
          const next = await refreshSettings();
          if (!next || transportStopped) return false;
          // Rebuild the service's transport state when any server setting changes.
          restarting = ['server_mode', 'websocket_url', 'stun_url', 'maxsize']
            .some(key => next[key] !== settings[key]);
          return !restarting;
        };

        const maxsize = Number(maxsizeStr);
        let max_clipboard_size_local_limit_bytes = Number(maxClipboardLimitStr);
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
          if (!Number.isInteger(fragmentSize) || fragmentSize < 4) {
            throw new Error(
              'fragmentSize must be an integer of at least 4 bytes',
            );
          }
          const bytes = textEncoder.encode(str); // convert to UTF-8 bytes
          const fragments = [];
          let start = 0;
          while (start < bytes.length) {
            let end = Math.min(start + fragmentSize, bytes.length);
            // Move the boundary back to the start of any split UTF-8 character.
            while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
              end -= 1;
            }
            const chunk = bytes.slice(start, end);
            fragments.push(textDecoder.decode(chunk));
            start = end;
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
              (typeof clipContent === 'string' || Array.isArray(clipContent))
            ) {
              const file_paths = fileUris(clipContent);
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
                ' clipboard ignored: size (' +
                clipContentByteLength +
                ' bytes) exceeds limits; Server max size (' +
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
              ' clipboard ignored: size (' +
              clipContentByteLength +
              ' bytes) exceeds limits; Local max size (' +
              max_clipboard_size_local_limit_bytes +
              ' bytes)';
            await p2pStatusMessageChanged();
          }

          return false;
        };

        //clipboard monitor
        const clipboardListener = new NativeEventEmitter(ClipboardListener);
        // start clipboard listening
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
            // A finished download belongs to the previous clipboard item.
            // Keep active saving progress visible until that batch finishes.
            if ((await getDataFromAsyncStorage('fileDownloadInProgress')) !== 'true') {
              await setDataInAsyncStorage('fileDownloadStatus', '');
            }
            await notifee.cancelNotification(
              'ClipCascade_Download_Files_Notification_Id',
            );
            await setDataInAsyncStorage('filesAvailableToDownload', 'false');
            await setDataInAsyncStorage('downloadFiles', 'false');
            await setDataInAsyncStorage('dirPath', '');
          }
        };

        const showFilesDownloadNotification = async files => {
          const count = Object.keys(JSON.parse(files)).length;
          await setDataInAsyncStorage('availableFileCount', String(count));
          // Display a silent notification
          await notifee.displayNotification({
            id: 'ClipCascade_Download_Files_Notification_Id',
            title: `📥 Download ${count === 1 ? 'File' : 'Files'}`,
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
            beforeConnect: async () => {
              if (!(await prepareReconnect()) && stompClient) {
                // Do not await deactivate inside beforeConnect: it can wait on
                // this very connection attempt. The poll loop completes cleanup.
                void stompClient.deactivate();
              }
            },
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
                  // Echoes still release the outbound throttle in send-only mode.
                  toggle = false;
                  if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                    return;
                  }
                  await clearFiles();
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
                        if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                          return;
                        }
                        await NativeBridgeModule.discardPendingShare();
                        // set clipboard content
                        if (type_ === 'text') {
                          await NativeBridgeModule.copyTextToClipboard(cb);
                        } else if (type_ === 'image') {
                          await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                            cb,
                          );
                          block_image_once = true;
                        } else if (type_ === 'files') {
                          await showFilesDownloadNotification(cb);

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
                webSocketErrorMessage(event),
              );
            },
            onWebSocketClose: async event => {
              block_image_once = false;
              await setDataInAsyncStorage(
                'wsStatusMessage',
                webSocketCloseMessage(event),
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

          isShareTransportReady = () => !!stompClient?.connected && !toggle;

          // start websocket stomp connection
          stompClient.activate();

          // send clipboard content P2S
          sendClipBoardP2S = async (clipContent, type_ = 'text') => {
            try {
              await clearFiles();
              if (!stompClient?.connected || toggle) return false;
              if (stompClient && stompClient.connected && !toggle) {
                if (
                  (type_ === 'image' && enable_image_sharing === 'false') ||
                  (type_ === 'files' && enable_file_sharing === 'false')
                ) {
                  return true;
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
                    clipContent = await encodeFiles(clipContent, NativeBridgeModule);
                  }

                  // clipboad content hash
                  const hcb = await hashCB(clipContent);
                  if (await newCB(hcb)) {
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

                      if (!(await isClipboardSyncEnabled('send_clipboard'))) {
                        toggle = false;
                        return true;
                      }
                      // send
                      stompClient.publish({
                        destination: SEND_DESTINATION,
                        body: JSON.stringify({
                          payload: String(clipContent),
                          type: type_,
                        }),
                      });
                      previous_clipboard_content_hash = hcb;
                    }
                  }
                }
              }
              return true;
            } catch (e) {
              toggle = false;
              block_image_once = false;
              throw e;
            }
          };

          // stop events and connection P2S
          stopServicesP2S = async () => {
            transportStopped = true;
            // 1) Stop clipboard listening
            try {
              if (!restarting) await stopClipboard();
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
              stompClient.onWebSocketClose = () => {};

              // Deactivate the stomp connection, but don't hang here forever:
              // some socket states cause deactivate() to never resolve, which
              // would prevent the foreground service from stopping.
              try {
                await Promise.race([
                  stompClient.deactivate(),
                  new Promise(resolve =>
                    setTimeout(resolve, STOMP_DEACTIVATE_TIMEOUT_MS),
                  ),
                ]);
              } catch (e) {
                // no-op
              }
            }
            stompClient = null;

            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            cleanupClipboardListeners();
            if (!restarting) await notifee.stopForegroundService();
          };
        } else if (server_mode === 'P2P') {
          // p2p variables
          let myPeerId = null; // Your assigned peer ID from server
          let peers = new Set(); // Current set of known peer IDs in the "room"
          let peerConnections = {}; // Map: peerId -> RTCPeerConnection
          let dataChannels = {}; // Map: peerId -> RTCDataChannel
          isShareTransportReady = () => Object.values(dataChannels).some(channel => channel.readyState === 'open');
          let liveConnectionsCount = 0; // Track open DataChannels
          let pendingPeerList = null;
          let p2pShuttingDown = false;
          let signalingStopped = false;
          let signalingReconnectTimer = null;
          const peerOpChains = {};
          const dataChannelHeartbeatTimers = {};
          const P2P_DC_KEEPALIVE_JSON = JSON.stringify({ _cc_keepalive: true });

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
              msg += ` | ${p2pMsg}`;
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

          // Drop partial fragment buffers idle for FRAGMENT_TTL_MS so a peer
          // that disconnects mid-transfer can't leak memory forever.
          const pruneStaleReceivingFragments = () => {
            const now = Date.now();
            let pruned = 0;
            for (const fid of Object.keys(receivingFragments)) {
              const entry = receivingFragments[fid];
              if (entry && typeof entry.lastReceivedAt === 'number'
                  && (now - entry.lastReceivedAt) > FRAGMENT_TTL_MS) {
                delete receivingFragments[fid];
                pruned += 1;
              }
            }
            if (pruned > 0 && Object.keys(receivingFragments).length === 0) {
              receivingFragmentStats = null;
            }
          };

          const resetP2PMsg = async () => {
            p2pMsg = null;
            await p2pStatusMessageChanged();
          };

          const syncLiveConnectionsCount = async () => {
            liveConnectionsCount = Object.values(dataChannels).filter(
              c => c && c.readyState === 'open',
            ).length;
            isP2PStatusMsgChanged = true;
            await p2pStatusMessageChanged();
          };

          const runSerializedPeerOp = (peerId, op) => {
            const prev = peerOpChains[peerId] || Promise.resolve();
            const next = prev.then(() => op()).catch(() => {});
            peerOpChains[peerId] = next;
            return next;
          };

          const startDataChannelHeartbeat = (remotePeerId, channel) => {
            if (dataChannelHeartbeatTimers[remotePeerId]) {
              clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
            }
            dataChannelHeartbeatTimers[remotePeerId] = setInterval(() => {
              try {
                if (channel.readyState === 'open') {
                  channel.send(P2P_DC_KEEPALIVE_JSON);
                }
              } catch (e) {
                // no-op
              }
            }, HEARTBEAT_INTERVAL);
          };

          async function cleanupPeerConnections() {
            p2pShuttingDown = true;
            try {
              for (const id of Object.keys(dataChannelHeartbeatTimers)) {
                clearInterval(dataChannelHeartbeatTimers[id]);
                delete dataChannelHeartbeatTimers[id];
              }
              for (const [, dc] of Object.entries(dataChannels)) {
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

              for (const [, pc] of Object.entries(peerConnections)) {
                if (pc) {
                  try {
                    pc.onicecandidate = null;
                    pc.ondatachannel = null;
                    pc.onconnectionstatechange = null;
                    pc.close();
                  } catch (e) {
                    // no-op
                  }
                }
              }
              peerConnections = {};

              myPeerId = null;
              pendingPeerList = null;
              peers.clear();
              liveConnectionsCount = 0;
              for (const k of Object.keys(peerOpChains)) {
                delete peerOpChains[k];
              }
              await resetReceivingFragments();
              await resetSendingFragmentId();
            } finally {
              p2pShuttingDown = false;
            }
          }

          const initializeWebSocketSignalingClient = async () => {
            if (!signalingStopped && wsSignalingClient == null) {
              if (!(await prepareReconnect()) || signalingStopped) return;
              const socket = new WebSocket(websocket_url);
              wsSignalingClient = socket;
              const current = () =>
                !signalingStopped && wsSignalingClient === socket;

              socket.onopen = async () => {
                if (!current()) return;
                await cleanupPeerConnections();
                if (!current()) return;

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

              socket.onmessage = async event => {
                if (!current()) return;
                try {
                  const data = JSON.parse(event.data);
                  switch (data.type) {
                    case 'ASSIGNED_ID':
                      if (myPeerId && myPeerId !== data.peerId) {
                        await cleanupPeerConnections();
                      }
                      myPeerId = data.peerId;
                      if (pendingPeerList != null) {
                        const pending = pendingPeerList;
                        pendingPeerList = null;
                        await handlePeerList(pending);
                      }
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

                  if (!current()) return;
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '✅ Connected',
                  );
                } catch (e) {
                  if (!current()) return;
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '❌ Inbound Error: ' + e,
                  );
                }
              };

              socket.onerror = async event => {
                if (!current()) return;
                block_image_once = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  webSocketErrorMessage(event),
                );
              };

              socket.onclose = async event => {
                if (!current()) return;
                block_image_once = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  webSocketCloseMessage(event),
                );
                if (!current()) return;
                if (
                  enable_websocket_status_notification === 'true' &&
                  websocket_status_notification_toggle == false &&
                  (await getDataFromAsyncStorage('wsIsRunning')) === 'true' &&
                  current()
                ) {
                  websocket_status_notification_toggle = true;
                  await showWebSocketStatusNotification(
                    'WebSocket Connection Lost ⛓️‍💥',
                    -1,
                  );
                }

                if (!current()) return;
                wsSignalingClient = null;
                clearTimeout(signalingReconnectTimer);
                signalingReconnectTimer = setTimeout(async () => {
                  signalingReconnectTimer = null;
                  if (signalingStopped || wsSignalingClient != null) return;
                  const running = await getDataFromAsyncStorage('wsIsRunning');
                  if (
                    !signalingStopped &&
                    wsSignalingClient == null &&
                    running === 'true'
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
              if (!isShareTransportReady()) return false;
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
                  clipContent = await encodeFiles(clipContent, NativeBridgeModule);
                }

                // clipboad content hash
                const hcb = await hashCB(clipContent);
                if (await newCB(hcb)) {
                  if (block_image_once) {
                    block_image_once = false;
                  } else {
                    await resetSendingFragmentId();
                    await resetReceivingFragments();

                    const rawPayloadSizeInBytes =
                      textEncoder.encode(clipContent).length;

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

                    const recipients = Object.values(dataChannels).filter(channel => channel.readyState === 'open');
                    if (!recipients.length) return false;
                    let loopBroken = false;
                    sendingFragmentId = metadata.id;
                    for (let i = 0; i < fragments.length; i++) {
                      if (!(await isClipboardSyncEnabled('send_clipboard'))) {
                        await resetSendingFragmentId();
                        return;
                      }
                      if (sendingFragmentId != metadata.id) {
                        loopBroken = true;
                        return false;
                      }

                      const fragment = fragments[i];

                      const messageJson = JSON.stringify({
                        payload: fragment,
                        type: type_,
                        metadata: metadata,
                      });
                      metadata.index += 1;

                      // A peer joining midway cannot receive a partial batch.
                      let sent = false;
                      for (const channel of recipients) {
                        if (channel.readyState === 'open') {
                          await channel.send(messageJson);
                          sent = true;
                        }
                      }
                      if (!sent) {
                        await resetSendingFragmentId();
                        return false;
                      }

                      // Update stats
                      if (metadata.isFragmented) {
                        sendingFragmentStats = `${metadata.index}/${metadata.totalFragments}`;
                        await p2pStatusMessageChanged();
                      }
                    }
                    if (!loopBroken) {
                      previous_clipboard_content_hash = hcb;
                      await resetSendingFragmentId();
                    }
                  }
                }
              }
            } catch (e) {
              block_image_once = false;
              p2pMsg = '❌ P2P Outbound Error: ' + JSON.stringify(e, null, 2);
              await p2pStatusMessageChanged();
              throw e;
            }
          };

          // stop events and connection P2P
          stopServicesP2P = async () => {
            transportStopped = true;
            // This service must stay stopped even if a newer service sets the
            // shared running flag back to true before an old retry completes.
            signalingStopped = true;
            clearTimeout(signalingReconnectTimer);
            signalingReconnectTimer = null;
            // 1) Stop listening to clipboard events
            try {
              if (!restarting) await stopClipboard();
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
            cleanupClipboardListeners();
            if (!restarting) await notifee.stopForegroundService();
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
              const message = JSON.parse(messageJson);
              if (message && message._cc_keepalive === true) {
                return;
              }

              if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                await resetReceivingFragments();
                return;
              }
              await clearFiles(true);
              await resetSendingFragmentId();

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
                pruneStaleReceivingFragments();
                receivingFragmentStats = `${metadata.index + 1}/${
                  metadata.totalFragments
                }`;
                await p2pStatusMessageChanged();

                if (metadata.id in receivingFragments) {
                  const entry = receivingFragments[metadata.id];
                  entry.fragments[metadata.index] = cb;
                  entry.lastReceivedAt = Date.now();

                  // If this is the last fragment, try to combine
                  if (metadata.index === metadata.totalFragments - 1) {
                    // Check if all fragments are present (none is empty)
                    if (entry.fragments.every(frag => frag !== '')) {
                      // Join them all together into one payload
                      cb = entry.fragments.join('');
                      delete receivingFragments[metadata.id];
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
                  receivingFragments[metadata.id] = {
                    lastReceivedAt: Date.now(),
                    fragments: Array(metadata.totalFragments).fill(''),
                  };
                  receivingFragments[metadata.id].fragments[metadata.index] = cb;
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
                  if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                    await resetReceivingFragments();
                    return;
                  }
                  await NativeBridgeModule.discardPendingShare();
                  // set clipboard content
                  if (type_ === 'text') {
                    await NativeBridgeModule.copyTextToClipboard(cb);
                  } else if (type_ === 'image') {
                    await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                      cb,
                    );
                    block_image_once = true;
                  } else if (type_ === 'files') {
                    await showFilesDownloadNotification(cb);

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

          /**
           * The server gave us the entire list of peers in the "room".
           * For each peer, create a PeerConnection if we don't have one yet.
           */
          const handlePeerList = async peerList => {
            if (!myPeerId) {
              pendingPeerList = Array.isArray(peerList) ? [...peerList] : [];
              return;
            }
            const updatedPeers = new Set(peerList);
            peers = updatedPeers;
            await removeStalePeers(updatedPeers);

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
              delete peerOpChains[oldPid];
              if (dataChannelHeartbeatTimers[oldPid]) {
                clearInterval(dataChannelHeartbeatTimers[oldPid]);
                delete dataChannelHeartbeatTimers[oldPid];
              }
              if (dataChannels[oldPid]) {
                try {
                  dataChannels[oldPid].onopen = null;
                  dataChannels[oldPid].onmessage = null;
                  dataChannels[oldPid].onclose = null;
                  dataChannels[oldPid].onerror = null;
                  dataChannels[oldPid].close();
                } catch (err) {}
                delete dataChannels[oldPid];
              }

              if (peerConnections[oldPid]) {
                try {
                  peerConnections[oldPid].onicecandidate = null;
                  peerConnections[oldPid].ondatachannel = null;
                  peerConnections[oldPid].onconnectionstatechange = null;
                  peerConnections[oldPid].close();
                } catch (err) {}
                delete peerConnections[oldPid];
              }
            }
            await syncLiveConnectionsCount();
          };

          const disposePeerConnection = async peerId => {
            if (dataChannelHeartbeatTimers[peerId]) {
              clearInterval(dataChannelHeartbeatTimers[peerId]);
              delete dataChannelHeartbeatTimers[peerId];
            }
            const dc = dataChannels[peerId];
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
              delete dataChannels[peerId];
            }
            const pc = peerConnections[peerId];
            if (pc) {
              try {
                pc.onicecandidate = null;
                pc.ondatachannel = null;
                pc.onconnectionstatechange = null;
                pc.close();
              } catch (e) {
                // no-op
              }
              delete peerConnections[peerId];
            }
            await syncLiveConnectionsCount();
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

            pc.ondatachannel = async event => {
              const channel = event.channel;
              dataChannels[remotePeerId] = channel;
              await setupDataChannel(remotePeerId, channel);
            };

            pc.onconnectionstatechange = () => {
              const st = pc.connectionState;
              if (st === 'failed' || st === 'closed') {
                recoverPeerTransport(remotePeerId, pc);
              }
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

          const recoverPeerTransport = async (remotePeerId, deadPc) => {
            if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
              return;
            }
            if (deadPc != null && peerConnections[remotePeerId] !== deadPc) {
              return;
            }
            await runSerializedPeerOp(remotePeerId, async () => {
              if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
                return;
              }
              if (deadPc != null && peerConnections[remotePeerId] !== deadPc) {
                return;
              }
              if (deadPc == null) {
                const ch = dataChannels[remotePeerId];
                if (ch && ch.readyState === 'open') {
                  return;
                }
              }
              await disposePeerConnection(remotePeerId);
              if (p2pShuttingDown || !myPeerId || !peers.has(remotePeerId)) {
                return;
              }
              const newPc = await createPeerConnection(remotePeerId);
              peerConnections[remotePeerId] = newPc;
              if (myPeerId < remotePeerId) {
                const channel = await newPc.createDataChannel('cliptext');
                dataChannels[remotePeerId] = channel;
                await setupDataChannel(remotePeerId, channel);
                await createOffer(remotePeerId);
              }
            });
          };

          /**
           * Handle incoming OFFER from remote, then respond with ANSWER.
           */
          const handleOffer = async (fromPeerId, offer) => {
            if (p2pShuttingDown) {
              return;
            }
            // Ignore delayed/stale OFFERs for peers removed from the latest PEER_LIST.
            // Startup guard: allow early signaling before ASSIGNED_ID/PEER_LIST is ready.
            if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
              return;
            }
            await runSerializedPeerOp(fromPeerId, async () => {
              if (p2pShuttingDown) {
                return;
              }
              // TOCTOU guard: PEER_LIST can change after the outer fast-path check.
              if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
                return;
              }
              // Full new offer (e.g. after peer recovery): must not apply on an
              // existing connected PC or datachannel counts diverge across devices.
              if (peerConnections[fromPeerId]) {
                await disposePeerConnection(fromPeerId);
              }
              const pc = await createPeerConnection(fromPeerId);
              peerConnections[fromPeerId] = pc;

              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);

              await signalingSend({
                type: 'ANSWER',
                fromPeerId: myPeerId,
                toPeerId: fromPeerId,
                answer: pc.localDescription,
              });
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
            if (
              pc.connectionState === 'failed' ||
              pc.connectionState === 'closed'
            ) {
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
            if (
              pc.connectionState === 'failed' ||
              pc.connectionState === 'closed'
            ) {
              return;
            }

            await pc.addIceCandidate(new RTCIceCandidate(candidateData));
          };

          /**
           * Set up DataChannel for remotePeerId.
           */
          const setupDataChannel = async (remotePeerId, channel) => {
            channel.onopen = async () => {
              startDataChannelHeartbeat(remotePeerId, channel);
              await syncLiveConnectionsCount();
            };

            channel.onmessage = async e => {
              await onDataChannelMessage(e.data);
            };

            channel.onclose = async () => {
              if (dataChannelHeartbeatTimers[remotePeerId]) {
                clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
                delete dataChannelHeartbeatTimers[remotePeerId];
              }
              await syncLiveConnectionsCount();
              await recoverPeerTransport(remotePeerId, null);
            };

            channel.onerror = async err => {
              p2pMsg = '❌ DataChannel error with ' + remotePeerId + ': ' + err;
              await p2pStatusMessageChanged();
            };

            if (channel.readyState === 'open') {
              startDataChannelHeartbeat(remotePeerId, channel);
              await syncLiveConnectionsCount();
            }
          };
        }

        // send clipboard content
        const sendClipBoard = async (clipContent, type_ = 'text') => {
          if (type_ !== 'image') block_image_once = false;
          if (!(await isClipboardSyncEnabled('send_clipboard'))) {
            block_image_once = false;
            return;
          }
          const sent = server_mode === 'P2S'
            ? await sendClipBoardP2S(clipContent, type_)
            : await sendClipBoardP2P(clipContent, type_);
          if (sent === false) {
            throw new Error('Clipboard not sent: connection unavailable, busy, or interrupted. Copy/share it again when connected.');
          }
          return sent;
        };

        let deliveringShare = false;
        async function processPendingShares() {
          if (deliveringShare) return;
          deliveringShare = true;
          try {
            while (await deliverPendingShare(
              NativeBridgeModule,
              isShareTransportReady,
              async (content, type) => {
                block_image_once = false;
                const result = await sendClipBoard(content, type);
                if (type === 'text') {
                  try {
                    await NativeBridgeModule.copyTextToClipboard(content);
                  } catch (error) {
                    await setDataInAsyncStorage('wsStatusMessage', '❌ Clipboard error: ' + error);
                  }
                }
                return result;
              },
              error => setDataInAsyncStorage('wsStatusMessage', '❌ Share failed: ' + error),
            )) {
              // Each entry is consumed once; this only handles a newly arrived share.
            }
          } finally {
            deliveringShare = false;
          }
        }
        DeviceEventEmitter.addListener('SHARE_AVAILABLE', () => {
          processPendingShares().catch(error => {
            setDataInAsyncStorage('wsStatusMessage', '❌ Share failed: ' + error);
          });
        });

        // terminate service when wsIsRunning is false
        const stopServices = async () => {
          if (server_mode === 'P2S') {
            await stopServicesP2S();
          } else if (server_mode === 'P2P') {
            await stopServicesP2P();
          }

          cleanupClipboardListeners();
        };

        function sleep(ms) {
          return new Promise(res => setTimeout(res, ms));
        }

        async function pollFlagsLoop() {
          const POLL_KEYS = [
            'wsIsRunning',
            'echo',
            'downloadFiles',
            'filesAvailableToDownload',
          ];

          while (true) {
            const json = NativeBridgeModule.getFlagsSync(POLL_KEYS);
            const latest = JSON.parse(json);

            if (restarting && latest.wsIsRunning === 'true') {
              await stopServices();
              return true;
            }

            // check if wsIsRunning is true or else terminate the service
            if (latest.wsIsRunning !== 'true') {
              restarting = false;
              await stopServices();
              await setDataInAsyncStorage(
                'wsForegroundServiceTerminated',
                'true',
              );
              break;
            }

            await processPendingShares();

            // The shared checker gates requests to once a day and deduplicates
            // concurrent screen/service checks. Never delay clipboard polling.
            checkForUpdates();

            if (isP2PStatusMsgChanged) {
              isP2PStatusMsgChanged = false;
              await setDataInAsyncStorage(
                'p2pStatusMessage',
                await getP2PStatusMessage(),
              );
            }

            // check if ping initiated
            if (latest.echo === 'ping') {
              await setDataInAsyncStorage('echo', 'pong');
            }

            // check if user wants to download files
            if (
              latest.downloadFiles === 'true'
            ) {
              let saved = 0;
              let total = 0;
              let dirPath = '';
              const downloadId = String(Date.now());
              const reportDownload = async (message, inProgress, canOpenFolder = false, failed = false) => {
                await setDataInAsyncStorage('fileDownloadStatus', message);
                // Notification permission must not determine whether saving succeeds.
                try {
                  if (!inProgress && !failed &&
                      (await getDataFromAsyncStorage('download_notifications')) === 'false') {
                    await notifee.cancelNotification('ClipCascade_Download_Files_Progress_Notification_Id');
                    return;
                  }
                  await notifee.displayNotification({
                    id: 'ClipCascade_Download_Files_Progress_Notification_Id',
                    title: inProgress ? 'Downloading files…' : 'File download',
                    body: canOpenFolder ? `${message} Tap to open folder.` : message,
                    data: canOpenFolder ? {downloadDirectory: dirPath, downloadId} : {},
                    android: {
                      channelId: 'ClipCascade_Progress',
                      smallIcon: 'ic_small_icon',
                      onlyAlertOnce: true,
                      ongoing: inProgress,
                      progress: inProgress ? {max: total, current: saved} : undefined,
                      pressAction: {id: canOpenFolder ? 'open-download-folder' : 'default', launchActivity: 'default'},
                    },
                  });
                } catch (notificationError) {
                  console.warn('Could not show download notification', notificationError);
                }
              };
              try {
                // Snapshot the batch; incoming clipboard updates can replace files_in_memory.
                const files = JSON.parse(files_in_memory || '{}');
                const entries = Object.entries(files);
                total = entries.length;
                await setDataInAsyncStorage('fileDownloadInProgress', 'true');
                await setDataInAsyncStorage('downloadFiles', 'false');
                dirPath = await getDataFromAsyncStorage('dirPath');
                if (!total || latest.filesAvailableToDownload !== 'true') {
                  throw new Error('Files are no longer available. Share them again to retry.');
                }
                await reportDownload(`Saving 0 of ${total} ${total === 1 ? 'file' : 'files'}…`, true);
                for (const [name, content] of entries) {
                  await NativeBridgeModule.saveBase64Files(
                    dirPath,
                    JSON.stringify({[name]: content}),
                  );
                  saved += 1;
                  await reportDownload(`Saving ${saved} of ${total} ${total === 1 ? 'file' : 'files'}…`, true);
                }
                await reportDownload(`Downloaded ${saved} ${saved === 1 ? 'file' : 'files'} to ${downloadDirectoryLabel(dirPath)}.`, false, true);
              } catch (e) {
                await reportDownload(
                  `Download failed. Saved ${saved} of ${total} ${total === 1 ? 'file' : 'files'}${dirPath ? ` to ${downloadDirectoryLabel(dirPath)}` : ''}. ${e.message || String(e)}`,
                  false,
                  saved > 0,
                  true,
                );
              } finally {
                await setDataInAsyncStorage('downloadFiles', 'false');
                await setDataInAsyncStorage('fileDownloadInProgress', 'false');
              }
            }
            await sleep(1000);
          }
        }

        return await pollFlagsLoop();
      } catch (error) {
        await setDataInAsyncStorage('wsStatusMessage', '❌ Error:' + error);
        await stopClipboard();
        cleanupClipboardListeners();
        await setDataInAsyncStorage('wsIsRunning', 'false');
        await setDataInAsyncStorage('wsForegroundServiceTerminated', 'true');
        await notifee.stopForegroundService();
        return false;
      }
    };
    while (await runTransport()) {
      // Keep the foreground notification alive while replacing the transport.
    }
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
