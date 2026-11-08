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
import {readClipboardStream, readClipboardBytes, fileUris, encodeFiles, deliverPendingShare} from './FileTransfer';
import {acquireServiceRun, serviceRun} from './ServiceLifecycle';
import {deactivateStompClient} from './StompShutdown';
import {StompSocket} from './StompSocket';
import * as binary from './BinaryProtocol';
import {RelayRecipients} from './RelayRecipients';
import {normalizeReceiveLimit, receiveLimitHeader, allowsContentSize, metadataContentSize,
  receiveCapabilityMessage, readReceiveCapability, base64ContentSize} from './TransferLimits';
import {fragmentClipboard, yieldClipboardEvents, ClipboardJobs, ClipboardSuperseded,
  isClipboardSuperseded, sendSharedClipboardFragments, acceptsClipboardFragment,
  ClipboardRevisionGate, ClipboardEchoes, encryptedClipboardEchoKey, serializeClipboardMessages,
  acceptClipboardObservation} from './ClipboardPreparation';

import {
  getDataFromAsyncStorage,
  getMultipleDataFromAsyncStorage,
} from './AsyncStorageManagement';

function cleanupClipboardListeners() {
  DeviceEventEmitter.removeAllListeners('SHARE_AVAILABLE');
  DeviceEventEmitter.removeAllListeners('SHARED_TEXT');
  DeviceEventEmitter.removeAllListeners('SHARED_IMAGE');
  DeviceEventEmitter.removeAllListeners('SHARED_FILES');
  DeviceEventEmitter.removeAllListeners('onClipboardChange');
}

module.exports = async (inputData = null) => {
  const bridge = NativeModules.NativeBridgeModule;
  let runId;
  try {
    runId = await acquireServiceRun(bridge);
  } catch (error) {
    return [false, error];
  }
  const run = serviceRun(bridge, runId);
  const setDataInAsyncStorage = run.setData;
  let runnerStarted = false;
  // Constants
  const SUBSCRIPTION_DESTINATION = '/user/queue/cliptext';
  const SEND_DESTINATION = '/app/cliptext';
  const RECONNECT_WS_TIMER = 10000; // 10 seconds
  const HEARTBEAT_INTERVAL = 20000; // 20 seconds
  const FRAGMENT_SIZE = 15360; // 15 KiB
  const FRAGMENT_TTL_MS = 60000; // drop partial fragment buffers idle for 60s
  const P2P_CONNECTION_TIMEOUT_MS = 90000;

  // forground service
  notifee.registerForegroundService(async notification => {
    // Notifee may deliver another start event for an existing notification.
    if (!bridge.activateServiceRunSync(runId)) return;
    runnerStarted = true;
    let transportCleanupFailed = false;
    const { ClipboardListener } = NativeModules;
    const serviceController = new AbortController();
    let heartbeatStopped = false;
    let heartbeatPending = false;
    // Discovery, transfers, and retry delays must not block liveness checks.
    const heartbeatTimer = setInterval(async () => {
      if (heartbeatStopped || heartbeatPending) return;
      heartbeatPending = true;
      try {
        const flags = JSON.parse(NativeModules.NativeBridgeModule.getFlagsSync([
          'wsIsRunning', 'echo',
        ]));
        if (!run.isCurrent() || flags.wsIsRunning !== 'true') {
          serviceController.abort();
        } else if (flags.echo === 'ping') {
          await setDataInAsyncStorage('echo', 'pong');
        }
      } catch (error) {
        console.warn('Could not check foreground service flags', error);
      } finally {
        heartbeatPending = false;
      }
    }, 1000);
    const waitForRetry = (delay = RECONNECT_WS_TIMER) => new Promise(resolve => {
      const signal = serviceController.signal;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      signal.addEventListener('abort', finish);
      if (signal.aborted) finish();
    });
    let clipboardStarted = false;
    const stopClipboard = async () => {
      if (clipboardStarted) {
        await ClipboardListener.stopListening();
        clipboardStarted = false;
      }
    };
    const runTransport = async () => {
      let cleanupTransport = async () => {};
      try {
        if (!run.isCurrent()) return false;
        let restarting = false;
        let transportStopped = false;
        const track = callback => run.track((...args) => !transportStopped && callback(...args));
        const { NativeBridgeModule } = NativeModules;
        // Restore trust before either WebSocket mode starts, including headless boot.
        await NativeModules.ServerTlsModule.configure(
          await getDataFromAsyncStorage('server_url'),
          (await getDataFromAsyncStorage('ssl_ca_bundle')) || '',
        );
        if (!run.isCurrent()) return false;
        if (!clipboardStarted) {
          // Request native log access while monitoring is being started, before
          // network discovery can delay it. Transport changes reuse this reader.
          ClipboardListener.startListening();
          clipboardStarted = true;
        }
        const clipboardJobs = new ClipboardJobs(() => NativeBridgeModule.cancelClipboardReadsSync());
        const clipboardRevisions = new ClipboardRevisionGate();
        const sentEchoes = new ClipboardEchoes();
        let localClipboardEpoch = 0;
        let cancelIncoming = () => {};
        const checkClipboardJob = generation => {
          clipboardJobs.check(generation);
          if (!run.isCurrent() || transportStopped) throw new ClipboardSuperseded();
        };
        const clearShareFailure = async generation => {
          checkClipboardJob(generation);
          if (!isShareTransportReady()) return;
          const flags = JSON.parse(NativeBridgeModule.getFlagsSync(['wsStatusMessage']));
          const message = flags.wsStatusMessage || '';
          if (message.startsWith('❌ Share failed:') || message.startsWith('✅ Connected - ⏳ Loading ')) {
            // A newer clipboard action supersedes the old share's result.
            // Leave unrelated connection and clipboard errors untouched.
            await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
          }
        };
        const textEncoder = new encoding.TextEncoder();
        const textDecoder = new encoding.TextDecoder();

        await setDataInAsyncStorage('fileDownloadInProgress', 'false');
        await setDataInAsyncStorage('fileDownloadStatus', '');

        let previous_clipboard_content_hash = '';
        let block_image_once = false;
        let files_in_memory = null;
        let websocket_status_notification_toggle = false;
        let p2pMsg = null; // p2p status message

        let stompClient = null;
        let stompSocket = null;
        let wsSignalingClient = null;
        let sendClipBoardP2S = null;
        let sendClipBoardP2P = null;
        let stopServicesP2S = null;
        let stopServicesP2P = null;
        let isShareTransportReady = () => false;
        let getP2PStatusMessage = null;
        let isP2PStatusMsgChanged = false;
        let attachmentLoading = null;

        // Discover in the service too: Android can start it without the app UI.
        const keys = [
          'server_url', 'websocket_url', 'cipher_enabled', 'maxsize',
          'server_mode', 'stun_url', 'enable_image_sharing',
          'enable_file_sharing', 'enable_websocket_status_notification',
          'max_clipboard_size_local_limit_bytes',
        ];
        let settings = await getMultipleDataFromAsyncStorage(keys);
        const refreshSettings = async () => {
          while (run.isCurrent() && !serviceController.signal.aborted && !transportStopped && (await getDataFromAsyncStorage('wsIsRunning')) === 'true') {
            try {
              const next = await discoverServer(settings, fetch, serviceController.signal);
              if (!run.isCurrent() || serviceController.signal.aborted || transportStopped || (await getDataFromAsyncStorage('wsIsRunning')) !== 'true') return null;
              for (const key of ['server_mode', 'websocket_url', 'stun_url', 'maxsize']) {
                await setDataInAsyncStorage(key, next[key]);
              }
              return next;
            } catch (error) {
              if (!run.isCurrent() || serviceController.signal.aborted || transportStopped) return null;
              await setDataInAsyncStorage('wsStatusMessage', '❌ ' + error.message + '; retrying…');
              await waitForRetry();
            }
          }
          return null;
        };
        settings = await refreshSettings();
        if (!settings || !run.isCurrent()) {
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
          if (!next || !run.isCurrent() || transportStopped) return false;
          // Rebuild the service's transport state when any server setting changes.
          restarting = ['server_mode', 'websocket_url', 'stun_url', 'maxsize']
            .some(key => next[key] !== settings[key]);
          return !restarting;
        };

        const maxsize = Number(maxsizeStr);
        // Blank/legacy zero means no local cap. Server limits are separate.
        const localReceiveLimit = normalizeReceiveLimit(Number(maxClipboardLimitStr) === 0 ? null : maxClipboardLimitStr);
        const max_clipboard_size_local_limit_bytes = localReceiveLimit ?? -1;

        // encrption
        const encrypt = async (plainText, onEncrypted = () => {}) => {
          try {
            const encryptedData = await AesGcmCrypto.encrypt(
              plainText,
              false,
              await getDataFromAsyncStorage('hashed_password'),
            );
            const envelope = {
              nonce: Buffer.from(encryptedData.iv, 'hex').toString('base64'),
              ciphertext: encryptedData.content,
              tag: Buffer.from(encryptedData.tag, 'hex').toString('base64'),
            };
            onEncrypted(envelope);
            return JSON.stringify(envelope);
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

        // The installed AES library's binary API requires whole-payload Base64.
        // Use a bounded, file-backed native cipher for CCB1 instead.
        const cryptBinary = async (raw, decrypting, nonce = new Uint8Array(0), tag = new Uint8Array(0)) => {
          const generation = clipboardJobs.generation;
          const checkCurrent = () => checkClipboardJob(generation);
          checkCurrent();
          const id = await NativeBridgeModule.beginClipboardCipher(
            await getDataFromAsyncStorage('hashed_password'), decrypting, Array.from(nonce), Array.from(tag));
          try {
            for (let offset = 0; offset < raw.length; offset += 32768) {
              checkCurrent();
              await NativeBridgeModule.appendClipboardCipher(id, binary.toBase64(raw.subarray(offset, offset + 32768)));
              await yieldClipboardEvents();
            }
            checkCurrent();
            const envelope = await NativeBridgeModule.finishClipboardCipher(id);
            const content = await readClipboardStream(envelope.id, NativeBridgeModule, checkCurrent);
            checkCurrent();
            return decrypting ? content : binary.concat([new Uint8Array([binary.fromBase64(envelope.nonce).length]),
              binary.fromBase64(envelope.nonce), binary.fromBase64(envelope.tag), content]);
          } catch (error) {
            checkCurrent();
            throw error;
          } finally {
            await NativeBridgeModule.abortClipboardCipher(id);
          }
        };
        const encryptBinary = raw => cryptBinary(raw, false);
        const decryptBinary = raw => {
          const n = raw[0];
          if (!Number.isInteger(n) || n < 8 || n > 32 || raw.length < 1 + n + 16) throw new Error('Invalid encrypted binary payload');
          return cryptBinary(raw.subarray(1 + n + 16), true, raw.subarray(1, 1 + n), raw.subarray(1 + n, 1 + n + 16));
        };
        const decodeBinary = async message => {
          if (message.encrypted !== (cipher_enabled === 'true')) throw new Error('Encryption settings differ between devices');
          return binary.decodeContent(message.payload, message.type,
            message.encrypted ? decryptBinary : null, localReceiveLimit, true);
        };
        let relayRecipientCache = new RelayRecipients();
        const relayRecipients = async () => {
          const cached = relayRecipientCache.get();
          if (cached) return cached;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 3000);
          try {
            const response = await fetch(server_url.replace(/\/+$/, '') + '/clipbinary/recipients',
              {credentials: 'include', signal: controller.signal, headers: {Accept: 'application/json'}});
            const fallback = response.ok ? binary.recipients(await response.json()) : null;
            return relayRecipientCache.get() || fallback;
          } catch (_) { return null; }
          finally { clearTimeout(timer); }
        };

        // hash clipboard content
        const hashCB = async (input, kind = 'text') => {
          const generation = clipboardJobs.generation;
          const [header, parts] = binary.contentParts(input, kind);
          let hash = xxHash32(textEncoder.encode(JSON.stringify(header)), 0);
          // Fixed chunk boundaries make the hash independent of transport fragments.
          for (const part of parts) {
            for (let offset = 0; offset < part.length; offset += 65536) {
              hash = xxHash32(part.subarray(offset, offset + 65536), hash);
              if (offset % (1024 * 1024) === 0) {
                await yieldClipboardEvents();
                checkClipboardJob(generation);
              }
            }
          }
          return String(hash);
        };

        //check if clipboard content changed
        const newCB = async hcb => {
          return previous_clipboard_content_hash !== hcb;
        };

        const calculateBase64DecodedLength = async base64Str => {
          return base64ContentSize(base64Str);
        };

        // fragment string into chunks
        const fragmentString = async (str, fragmentSize, checkCurrent) => {
          return fragmentClipboard(str, fragmentSize, textEncoder, textDecoder, checkCurrent);
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

        const loadClipboardAttachment = async (content, type, generation, onSize) => {
          const checkCurrent = () => checkClipboardJob(generation);
          checkCurrent();
          const loading = {generation, message: type === 'files' ? 'Loading files…' : 'Loading image…'};
          attachmentLoading = loading;
          const message = `✅ Connected - ⏳ ${loading.message}`;
          try {
            checkCurrent();
            if (server_mode === 'P2P') {
              // Peer/transfer progress has its own field. The dashboard uses
              // wsStatusMessage to determine whether signaling is connected.
              await p2pStatusMessageChanged();
            } else {
              await setDataInAsyncStorage('wsStatusMessage', message);
            }
            checkCurrent();
            return type === 'files'
              ? await encodeFiles(content, NativeBridgeModule, checkCurrent, onSize, true)
              : await readClipboardBytes(content, NativeBridgeModule, checkCurrent);
          } finally {
            if (attachmentLoading === loading) attachmentLoading = null;
            if (generation === clipboardJobs.generation && run.isCurrent() && !transportStopped) {
              if (server_mode === 'P2P') {
                await p2pStatusMessageChanged();
              } else {
                // Preserve connection errors or newer updates made during the read.
                const flags = JSON.parse(NativeBridgeModule.getFlagsSync(['wsStatusMessage']));
                if (flags.wsStatusMessage === message) {
                  await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
                }
              }
            }
          }
        };

        const measureClipboardContent = async (clipContent, type, direction) => {
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
              clipContentByteLength = typeof clipContent === 'string'
                ? await calculateBase64DecodedLength(clipContent) : clipContent.length;
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
              let files = typeof clipContent === 'string' ? JSON.parse(clipContent) : clipContent;
              for (const file in files) {
                clipContentByteLength += typeof files[file] === 'string'
                  ? await calculateBase64DecodedLength(files[file]) : files[file].length;
              }
            }
          } else {
            return false;
          }

          return clipContentByteLength;
        };

        // Both modes use original content bytes, excluding encoding overhead.
        const validateClipboardSize = async (clipContent, type, direction, measuredSize = null) => {
          const clipContentByteLength = measuredSize ?? await measureClipboardContent(clipContent, type, direction);
          if (!Number.isSafeInteger(clipContentByteLength) || clipContentByteLength < 0) return false;
          if (server_mode === 'P2S') {
            if (
              (maxsize < 0 || clipContentByteLength <= maxsize) &&
              allowsContentSize(localReceiveLimit, clipContentByteLength)
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
          track(async params => {
            try {
              if (params && params.content && params.type) {
                if (!acceptClipboardObservation(clipboardRevisions, params)) return;
                await sendClipBoard(params.content, params.type);
              }
            } catch (e) {
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ Outbound Error: ' + e,
              );
            }
          }),
        );

        const clearFiles = async (expensiveCall = false) => {
          const generation = clipboardJobs.generation;
          files_in_memory = null;
          if (!expensiveCall) {
            // A finished download belongs to the previous clipboard item.
            // Keep active saving progress visible until that batch finishes.
            const downloadInProgress = await getDataFromAsyncStorage('fileDownloadInProgress');
            clipboardJobs.check(generation);
            if (downloadInProgress !== 'true') {
              await setDataInAsyncStorage('fileDownloadStatus', '');
              clipboardJobs.check(generation);
            }
            await notifee.cancelNotification(
              'ClipCascade_Download_Files_Notification_Id',
            );
            clipboardJobs.check(generation);
            await setDataInAsyncStorage('filesAvailableToDownload', 'false');
            clipboardJobs.check(generation);
            await setDataInAsyncStorage('downloadFiles', 'false');
            clipboardJobs.check(generation);
            await setDataInAsyncStorage('dirPath', '');
            clipboardJobs.check(generation);
          }
        };

        const showFilesDownloadNotification = async files => {
          const generation = clipboardJobs.generation;
          const count = Object.keys(typeof files === 'string' ? JSON.parse(files) : files).length;
          await setDataInAsyncStorage('availableFileCount', String(count));
          clipboardJobs.check(generation);
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
            webSocketFactory: () => {
              stompSocket = new StompSocket(websocket_url, NativeBridgeModule, DeviceEventEmitter);
              return stompSocket;
            },
            connectHeaders: {'x-clipcascade-recipient-updates': '1', 'x-clipcascade-binary': 'ccb1', 'x-clipcascade-no-self-echo': 'true',
              'x-clipcascade-receive-limit': receiveLimitHeader(localReceiveLimit)},
            beforeConnect: async () => {
              relayRecipientCache.reset();
              if (!(await track(prepareReconnect)()) && stompClient) {
                // Do not await deactivate inside beforeConnect: it can wait on
                // this very connection attempt. The poll loop completes cleanup.
                void stompClient.deactivate();
              }
            },
            reconnectDelay: RECONNECT_WS_TIMER,
            connectionTimeout: 5000,
            heartbeatIncoming: HEARTBEAT_INTERVAL,
            heartbeatOutgoing: 0,
            // The native transport sends small binary writes, preserving NUL
            // bytes without one oversized React Native/OkHttp send.
            forceBinaryWSFrames: false,
            // appendMissingNULLonIncoming: true, // https://stomp-js.github.io/api-docs/latest/classes/Client.html#appendMissingNULLonIncoming
            onConnect: track(async () => {
              const recipientCache = relayRecipientCache = new RelayRecipients();
              await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');

              // Subscribe to a topic
              const receiveClipboardMessage = track(serializeClipboardMessages(async (message, parsedBody) => {
                let generation = clipboardJobs.generation;
                try {
                  if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                    return;
                  }

                  if (message && (message.isBinaryBody || message.body)) {
                    const isBinary = message.headers?.['content-type']?.split(';')[0] === binary.CONTENT_TYPE;
                    const body = isBinary ? binary.decodeFrame(message.binaryBody) : parsedBody;
                    if (!allowsContentSize(localReceiveLimit, metadataContentSize(body.metadata))) {
                      await setDataInAsyncStorage('wsStatusMessage', '⚠️ Incoming clipboard ignored: original content exceeds the local size limit.');
                      return;
                    }
                    let cb = isBinary ? body.payload : String(body.payload);
                    const type_ = body.type ?? 'text';

                    //decrypt
                    if (isBinary) {
                      cb = await decodeBinary(body);
                    } else if (cipher_enabled === 'true') {
                      try {
                        const envelope = JSON.parse(cb);
                        if (sentEchoes.consume(encryptedClipboardEchoKey(type_, envelope))) return;
                        cb = await decrypt(envelope);
                      } catch (error) {
                        throw new Error(
                          `Encryption must be enabled on all devices if enabled. JSON parsing failed: ${error.message}`,
                        );
                      }
                    }

                    // hash clipboard content
                    const hcb = await hashCB(cb, type_);
                    checkClipboardJob(generation);
                    if (await newCB(hcb)) {
                      generation = clipboardJobs.cancel();
                      await clearFiles();
                      checkClipboardJob(generation);
                      await clearShareFailure(generation);
                      checkClipboardJob(generation);
                      previous_clipboard_content_hash = hcb;

                      // validate clipboard size
                      if (await validateClipboardSize(cb, type_, 'Inbound')) {
                        if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                          return;
                        }
                        checkClipboardJob(generation);
                        await NativeBridgeModule.discardPendingShare();
                        checkClipboardJob(generation);
                        // set clipboard content
                        if (type_ === 'text') {
                          await NativeBridgeModule.copyTextToClipboard(cb);
                        } else if (type_ === 'image') {
                          block_image_once = true;
                          await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                            binary.legacyContent(cb, type_),
                          );
                        } else if (type_ === 'files') {
                          await showFilesDownloadNotification(cb);
                          checkClipboardJob(generation);

                          files_in_memory = cb;
                          await setDataInAsyncStorage(
                            'filesAvailableToDownload',
                            'true',
                          );
                        }
                      }
                    }
                    await clearShareFailure(generation);
                  }
                } catch (e) {
                  if (isClipboardSuperseded(e)) return;
                  await setDataInAsyncStorage(
                    'wsStatusMessage',
                    '❌ Inbound Error: ' + e,
                  );
                }
              }, () => localClipboardEpoch));
              stompClient.subscribe(SUBSCRIPTION_DESTINATION, track(message => {
                if (recipientCache !== relayRecipientCache || !stompClient?.connected) return;
                // Membership controls bypass clipboard serialization and receive preferences.
                let parsedBody;
                if (message.headers?.['content-type']?.split(';')[0] !== binary.CONTENT_TYPE) {
                  try {
                    parsedBody = JSON.parse(message.body);
                    if (recipientCache.accept(parsedBody)) return;
                  } catch (_) { return; }
                }
                return receiveClipboardMessage(message, parsedBody);
              }));

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
            }),
            onDisconnect: track(async () => {
              relayRecipientCache.reset();
              block_image_once = false;
              await setDataInAsyncStorage('wsStatusMessage', 'Disconnected');
            }),
            onStompError: track(async frame => {
              block_image_once = false;
              await setDataInAsyncStorage(
                'wsStatusMessage',
                '❌ STOMP Error: ' + JSON.stringify(frame, null, 2),
              );
            }),
            onWebSocketError: track(async event => {
              block_image_once = false;
              await setDataInAsyncStorage(
                'wsStatusMessage',
                webSocketErrorMessage(event),
              );
            }),
            onWebSocketClose: track(async event => {
              relayRecipientCache.reset();
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
            }),
          });

          isShareTransportReady = () => run.isCurrent() && !!stompClient?.connected;

          // start websocket stomp connection
          stompClient.activate();

          // send clipboard content P2S
          sendClipBoardP2S = async (clipContent, type_ = 'text', generation) => {
            const sendingSocket = stompSocket;
            const checkCurrent = () => {
              checkClipboardJob(generation);
              if (sendingSocket !== stompSocket || (sendingSocket && sendingSocket.readyState !== 1)) {
                throw new ClipboardSuperseded();
              }
            };
            try {
              await clearFiles();
              checkCurrent();
              if (!stompClient?.connected) return false;
              if (stompClient && stompClient.connected) {
                const socket = stompSocket;
                if (!socket) return false;
                // Finish an already-started STOMP frame before publishing
                // another. Superseded waiters must not prepare more files.
                await socket.flush();
                checkCurrent();
                if (
                  (type_ === 'image' && enable_image_sharing === 'false') ||
                  (type_ === 'files' && enable_file_sharing === 'false')
                ) {
                  return true;
                }

                let contentSizeBytes = await measureClipboardContent(clipContent, type_, 'Outbound');
                if (await validateClipboardSize(clipContent, type_, 'Outbound', contentSizeBytes)) {
                  checkCurrent();
                  const plan = await relayRecipients();
                  checkCurrent();
                  // Load original bytes once for this recipient snapshot.
                  if (type_ === 'image' || type_ === 'files') {
                    clipContent = await loadClipboardAttachment(clipContent, type_, generation, size => { contentSizeBytes = size; });
                  }

                  checkCurrent();
                  if (type_ === 'image') contentSizeBytes = clipContent.length;
                  if (!(await validateClipboardSize(clipContent, type_, 'Outbound', contentSizeBytes))) return true;
                  checkCurrent();
                  // clipboard content hash
                  const hcb = await hashCB(clipContent, type_);
                  // Legacy servers still echo. Plaintext hashes cannot tell
                  // an echo apart from another device's genuine resend.
                  let echoKey = null;
                  checkCurrent();
                  if (await newCB(hcb)) {
                    if (block_image_once) {
                      block_image_once = false;
                    } else {

                      checkCurrent();
                      const encrypted = cipher_enabled === 'true';
                      const messages = [];
                      if (plan?.binary.length) {
                        try {
                          const raw = await binary.encodeContent(clipContent, type_, encrypted ? encryptBinary : null, undefined, checkCurrent);
                          checkCurrent();
                          messages.push({destination: '/app/clipbinary',
                            headers: {'content-type': binary.CONTENT_TYPE, 'x-clipcascade-recipients': plan.binary.join(',')},
                            binaryBody: binary.encodeFrame(raw, type_, {contentSizeBytes}, encrypted)});
                        } catch (error) {
                          if (error.message !== 'Binary header too large') throw error;
                          plan.legacy.push(...plan.binary);
                          plan.binary = [];
                        }
                      }
                      if (!plan || plan.legacy.length) {
                        let prepared = binary.legacyContent(clipContent, type_);
                        if (encrypted) prepared = await encrypt(prepared, envelope => { echoKey = encryptedClipboardEchoKey(type_, envelope); });
                        messages.push({destination: SEND_DESTINATION,
                          headers: plan ? {'x-clipcascade-recipients': plan.legacy.join(',')} : {},
                          body: JSON.stringify({payload: String(prepared), type: type_, metadata: {contentSizeBytes}})});
                      }
                      await setDataInAsyncStorage('wsStatusMessage', '✅ Connected');
                      for (const message of messages) {
                        checkCurrent();
                        if (!(await isClipboardSyncEnabled('send_clipboard'))) return true;
                        if (!run.isCurrent() || transportStopped) return false;
                        if (message.body && echoKey !== null) sentEchoes.remember(echoKey);
                        try { stompClient.publish(message); }
                        catch (error) {
                          if (message.body && echoKey !== null) sentEchoes.consume(echoKey);
                          throw error;
                        }
                        await socket.flush();
                      }
                      // A frame already submitted can still be echoed by an
                      // older server, even if newer clipboard work supersedes
                      // us while the transport drains. Keep its nonce tracked.
                      await socket.flush();
                      checkCurrent();
                      previous_clipboard_content_hash = hcb;
                    }
                  }
                }
              }
              return true;
            } catch (e) {
              if (isClipboardSuperseded(e)) throw e;
              block_image_once = false;
              throw e;
            }
          };

          // stop events and connection P2S
          stopServicesP2S = async () => {
            relayRecipientCache.reset();
            transportStopped = true;
            clipboardJobs.cancel();
            cancelIncoming();
            files_in_memory = null;
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
              stompClient.onConnect = () => {};
              stompClient.onDisconnect = () => {};
              stompClient.onStompError = () => {};
              stompClient.onWebSocketError = () => {};
              stompClient.onWebSocketClose = () => {};

              // Allow a graceful disconnect, then discard an unresponsive socket.
              // Keep ownership until the old STOMP callbacks are detached.
              try {
                await deactivateStompClient(stompClient);
              } catch (error) {
                transportCleanupFailed = true;
                throw error;
              }
            }
            stompClient = null;

            await setDataInAsyncStorage('wsStatusMessage', '✅ Disconnected');
            cleanupClipboardListeners();
          };
          cleanupTransport = stopServicesP2S;
        } else if (server_mode === 'P2P') {
          // p2p variables
          let myPeerId = null; // Your assigned peer ID from server
          let peers = new Set(); // Current set of known peer IDs in the "room"
          let peerConnections = {}; // Map: peerId -> RTCPeerConnection
          let dataChannels = {};
          const peerReceiveLimits = new Map(); // Map: peerId -> original-content byte limit (null means unlimited)
          isShareTransportReady = () => run.isCurrent() && Object.values(dataChannels).some(channel => channel.readyState === 'open');
          let liveConnectionsCount = 0; // Track open DataChannels
          let pendingPeerList = null;
          let p2pShuttingDown = false;
          let signalingStopped = false;
          let signalingReconnectTimer = null;
          const peerOpChains = {};
          const peerRetryAttempts = {};
          const peerConnectionDeadlines = {};
          const pendingIce = new WeakMap();
          const dataChannelHeartbeatTimers = {};
          const P2P_DC_KEEPALIVE_JSON = receiveCapabilityMessage(localReceiveLimit);

          // Fragment variables
          let sendingFragmentId = '';
          const discardedFragments = new Map();
          const discardFragment = id => {
            discardedFragments.delete(id);
            discardedFragments.set(id, true);
            if (discardedFragments.size > 1024) discardedFragments.delete(discardedFragments.keys().next().value);
          };
          let receivingFragments = {}; // Map: fragmentId -> array of strings (ordered)
          let sendingFragmentStats = null;
          let receivingFragmentStats = null;

          getP2PStatusMessage = async () => {
            let msg = '📊';
            msg += ` Peers: ${liveConnectionsCount}`;
            if (attachmentLoading?.generation === clipboardJobs.generation) {
              msg += ` | ${attachmentLoading.message}`;
            }
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

          const clearReceiving = () => {
            Object.keys(receivingFragments).forEach(discardFragment);
            receivingFragments = {};
            receivingFragmentStats = null;
          };
          cancelIncoming = () => {
            sendingFragmentId = '';
            sendingFragmentStats = null;
            clearReceiving();
          };
          const dropPeerFragments = peerId => {
            peerReceiveLimits.delete(peerId);
            for (const [fid, entry] of Object.entries(receivingFragments)) {
              if (entry.peerId === peerId) {
                discardFragment(fid);
                delete receivingFragments[fid];
              }
            }
            if (!Object.keys(receivingFragments).length) receivingFragmentStats = null;
          };
          const resetReceivingFragments = async () => {
            clearReceiving();
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
                discardFragment(fid);
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
            const next = prev.then(() => op()).catch(error => {
              console.warn('P2P operation failed for peer', peerId, error);
            });
            peerOpChains[peerId] = next;
            return next;
          };

          const startDataChannelHeartbeat = (remotePeerId, channel) => {
            if (dataChannelHeartbeatTimers[remotePeerId]) {
              clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
            }
            dataChannelHeartbeatTimers[remotePeerId] = setInterval(() => {
              try {
                pruneStaleReceivingFragments();
                if (run.isCurrent() && channel.readyState === 'open') {
                  channel.send(P2P_DC_KEEPALIVE_JSON);
                }
              } catch (e) {
                // no-op
              }
            }, HEARTBEAT_INTERVAL);
          };

          async function cleanupPeerConnections() {
            p2pShuttingDown = true;
            peerReceiveLimits.clear();
            clipboardJobs.cancel();
            cancelIncoming();
            for (const id of Object.keys(peerConnectionDeadlines)) {
              cancelPeerConnectionDeadline(id);
            }
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

              for (const id of Object.keys(peerRetryAttempts)) {
                delete peerRetryAttempts[id];
              }
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

          const initializeWebSocketSignalingClient = track(async () => {
            if (!signalingStopped && wsSignalingClient == null) {
              if (!(await prepareReconnect()) || !run.isCurrent() || signalingStopped) return;
              const socket = new WebSocket(websocket_url);
              wsSignalingClient = socket;
              const current = () =>
                run.isCurrent() && !signalingStopped && wsSignalingClient === socket;

              socket.onopen = track(async () => {
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
              });

              socket.onmessage = track(async event => {
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
              });

              socket.onerror = track(async event => {
                if (!current()) return;
                block_image_once = false;
                await setDataInAsyncStorage(
                  'wsStatusMessage',
                  webSocketErrorMessage(event),
                );
              });

              socket.onclose = track(async event => {
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
              });
            }
          });

          // start websocket signaling connection
          initializeWebSocketSignalingClient();

          // send clipboard content P2P
          sendClipBoardP2P = async (clipContent, type_ = 'text', generation) => {
            const checkCurrent = () => checkClipboardJob(generation);
            try {
              if (!isShareTransportReady()) return false;
              await clearFiles();
              if (
                (type_ === 'image' && enable_image_sharing === 'false') ||
                (type_ === 'files' && enable_file_sharing === 'false')
              ) {
                return;
              }

              let contentSizeBytes = await measureClipboardContent(clipContent, type_, 'Outbound');
              const eligiblePeers = () => Object.entries(dataChannels).filter(([peer, channel]) =>
                channel.readyState === 'open' && allowsContentSize(peerReceiveLimits.get(peer), contentSizeBytes))
                .map(([, channel]) => channel);
              if (await validateClipboardSize(clipContent, type_, 'Outbound', contentSizeBytes)) {
                checkCurrent();
                if (!eligiblePeers().length) {
                  p2pMsg = '⚠️ Clipboard not sent: content exceeds connected peers’ receive limits.';
                  await p2pStatusMessageChanged();
                  return true;
                }
                checkCurrent();
                const recipients = eligiblePeers();
                const recipientIds = new Map(Object.entries(dataChannels).map(([peer, channel]) => [channel, peer]));
                const binaryPeers = new Set(recipients.filter(channel => channel._ccBinary === true));
                // Load original bytes once for this recipient snapshot.
                if (type_ === 'image' || type_ === 'files') {
                  clipContent = await loadClipboardAttachment(clipContent, type_, generation, size => { contentSizeBytes = size; });
                }

                checkCurrent();
                if (type_ === 'image') contentSizeBytes = clipContent.length;
                if (!(await validateClipboardSize(clipContent, type_, 'Outbound', contentSizeBytes))) return true;
                checkCurrent();
                if (!eligiblePeers().length) {
                  p2pMsg = '⚠️ Clipboard not sent: content exceeds connected peers’ receive limits.';
                  await p2pStatusMessageChanged();
                  return true;
                }
                // clipboard content hash
                const hcb = await hashCB(clipContent, type_);
                checkCurrent();
                if (await newCB(hcb)) {
                  if (block_image_once) {
                    block_image_once = false;
                  } else {
                    checkCurrent();
                    await resetSendingFragmentId();
                    checkCurrent();
                    await resetReceivingFragments();
                    checkCurrent();

                    let legacy = null;
                    const getLegacy = () => {
                      if (legacy === null) legacy = binary.legacyContent(clipContent, type_);
                      return legacy;
                    };
                    if (!recipients.length) return false;
                    const encrypted = cipher_enabled === 'true';
                    const groups = [];
                    for (let useBinary of [false, true]) {
                      const channels = recipients.filter(channel => binaryPeers.has(channel) === useBinary);
                      if (!channels.length) continue;
                      checkCurrent();
                      let parts;
                      let combinedRawPayloadSizeInBytes = 0;
                      if (useBinary) {
                        try {
                          const raw = await binary.encodeContent(clipContent, type_, encrypted ? encryptBinary : null,
                            size => { combinedRawPayloadSizeInBytes = size; }, checkCurrent);
                          parts = binary.fragments(raw, FRAGMENT_SIZE);
                        } catch (error) {
                          if (error.message !== 'Binary header too large') throw error;
                          parts = [];
                        }
                        if (!parts.length || parts.length > 65536) {
                          useBinary = false;
                          combinedRawPayloadSizeInBytes = Buffer.byteLength(getLegacy(), 'utf8');
                          parts = await fragmentString(encrypted ? await encrypt(getLegacy()) : getLegacy(), FRAGMENT_SIZE, checkCurrent);
                        }
                      } else {
                        combinedRawPayloadSizeInBytes = Buffer.byteLength(getLegacy(), 'utf8');
                        const prepared = encrypted ? await encrypt(getLegacy()) : getLegacy();
                        parts = await fragmentString(prepared, FRAGMENT_SIZE, checkCurrent);
                      }
                      groups.push({useBinary, channels, fragments: parts, combinedRawPayloadSizeInBytes});
                    }
                    checkCurrent();
                    clipContent = null;
                    const metadata = {
                      id: await generateUuid(), contentSizeBytes,
                    };
                    checkCurrent();
                    sendingFragmentId = metadata.id;
                    try {
                      const results = await Promise.all(groups.map(group => sendSharedClipboardFragments(
                        group.fragments, group.channels,
                        {...metadata, combinedRawPayloadSizeInBytes: group.combinedRawPayloadSizeInBytes,
                          isFragmented: group.fragments.length > 1, index: 0, totalFragments: group.fragments.length},
                        type_, textEncoder,
                        () => {
                          checkCurrent();
                          if (sendingFragmentId !== metadata.id) throw new ClipboardSuperseded();
                        },
                        async () => {
                          if (!(await isClipboardSyncEnabled('send_clipboard'))) throw new ClipboardSuperseded();
                        },
                        (index, total) => {
                          if (generation === clipboardJobs.generation && sendingFragmentId === metadata.id) {
                            sendingFragmentStats = `${index}/${total}`;
                            isP2PStatusMsgChanged = true;
                          }
                        },
                        channel => dataChannels[recipientIds.get(channel)] === channel
                          && allowsContentSize(peerReceiveLimits.get(recipientIds.get(channel)), contentSizeBytes),
                        group.useBinary ? (part, meta) => binary.encodeFrame(part, type_, meta, encrypted) : null,
                      )));
                      const completed = results.reduce((sum, count) => sum + count, 0);
                      checkCurrent();
                      if (!completed) return false;
                      previous_clipboard_content_hash = hcb;
                    } finally {
                      if (sendingFragmentId === metadata.id) await resetSendingFragmentId();
                    }
                  }
                }
              }
            } catch (e) {
              checkCurrent();
              if (isClipboardSuperseded(e)) throw e;
              block_image_once = false;
              await resetSendingFragmentId();
              checkCurrent();
              p2pMsg = '❌ P2P Outbound Error: ' + JSON.stringify(e, null, 2);
              await p2pStatusMessageChanged();
              throw e;
            }
          };

          // stop events and connection P2P
          stopServicesP2P = async () => {
            transportStopped = true;
            clipboardJobs.cancel();
            cancelIncoming();
            files_in_memory = null;
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
          };
          cleanupTransport = stopServicesP2P;

          // send message to websocket signaling server
          const signalingSend = async obj => {
            try {
              if (
                run.isCurrent() &&
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
          const onDataChannelMessage = async (messageJson, peerId) => {
            try {
              const message = typeof messageJson === 'string' ? JSON.parse(messageJson) : binary.decodeFrame(messageJson);
              const isBinary = message._cc_binary === true;
              if (message && message._cc_keepalive === true) {
                const channel = dataChannels[peerId];
                if (channel) channel._ccBinary = message.capabilities?.version === 1
                  && Array.isArray(message.capabilities.transferFormats) && message.capabilities.transferFormats.includes('ccb1');
                readReceiveCapability(message, peerReceiveLimits, peerId);
                return;
              }

              if (!(await isClipboardSyncEnabled('receive_clipboard'))) {
                await resetReceivingFragments();
                return;
              }

              let cb = isBinary ? message.payload : String(message.payload);
              const type_ = message.type ?? 'text';
              const metadata = message.metadata;
              if (!acceptsClipboardFragment(metadata, receivingFragments, discardedFragments)) return;
              // Check if the payload exceeds the maximum size: first layer protection
              // Legacy payload sizes include overhead. When original size is
              // absent, defer to the decoded-content validation below.
              const announcedSize = metadataContentSize(metadata);
              if (!allowsContentSize(localReceiveLimit, announcedSize)) {
                if (metadata?.id) {
                  delete receivingFragments[metadata.id];
                  discardFragment(metadata.id);
                }
                if (!Object.keys(receivingFragments).length) receivingFragmentStats = null;
                p2pMsg = `⚠️ Content size limit exceeded: ${announcedSize} bytes exceeds ${max_clipboard_size_local_limit_bytes} bytes`;
                await p2pStatusMessageChanged();
                return;
              }

              let generation = metadata && receivingFragments[metadata.id]?.generation;
              if (metadata == null || (metadata.index === 0 && generation == null)) {
                generation = clipboardJobs.cancel();
                await resetSendingFragmentId();
                checkClipboardJob(generation);
                await clearFiles(true);
              }
              checkClipboardJob(generation);
              await clearShareFailure(generation);
              checkClipboardJob(generation);

              // Fragmented message handling
              if (metadata != null && metadata.isFragmented) {
                pruneStaleReceivingFragments();
                receivingFragmentStats = `${metadata.index + 1}/${
                  metadata.totalFragments
                }`;
                await p2pStatusMessageChanged();
                checkClipboardJob(generation);

                if (metadata.id in receivingFragments) {
                  const entry = receivingFragments[metadata.id];
                  if (entry.peerId !== peerId || entry.fragments.length !== metadata.totalFragments || entry.type !== type_ || entry.binary !== isBinary || entry.encrypted !== message.encrypted) {
                    await resetReceivingFragments();
                    return;
                  }
                  checkClipboardJob(entry.generation);
                  if (isBinary) {
                    if (metadata.index !== entry.nextIndex || metadata.contentSizeBytes !== entry.size
                        || entry.bytes + cb.length > entry.size + 65536 + 64) throw new Error('Invalid binary fragment sequence or size');
                    entry.nextIndex++;
                    entry.bytes += cb.length;
                  }
                  entry.fragments[metadata.index] = cb;
                  entry.lastReceivedAt = Date.now();

                  // If this is the last fragment, try to combine
                  if (metadata.index === metadata.totalFragments - 1) {
                    // Check if all fragments are present (none is empty)
                    if (entry.fragments.every(frag => frag !== '')) {
                      // Join them all together into one payload
                      cb = isBinary ? binary.concat(entry.fragments) : entry.fragments.join('');
                      discardFragment(metadata.id);
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
                  checkClipboardJob(generation);
                  receivingFragments[metadata.id] = {
                    lastReceivedAt: Date.now(),
                    peerId, generation, type: type_, binary: isBinary, encrypted: message.encrypted,
                    nextIndex: 1, bytes: cb.length, size: metadata.contentSizeBytes,
                    fragments: Array(metadata.totalFragments).fill(''),
                  };
                  receivingFragments[metadata.id].fragments[metadata.index] = cb;
                  return;
                }
              }

              checkClipboardJob(generation);
              await clearFiles();
              checkClipboardJob(generation);

              // decrypt
              if (isBinary) {
                cb = await decodeBinary({...message, payload: cb});
              } else if (cipher_enabled === 'true') {
                try {
                  cb = await decrypt(JSON.parse(cb));
                } catch (error) {
                  throw new Error(
                    `Encryption must be enabled on all devices if enabled. JSON parsing failed: ${error.message}`,
                  );
                }
              }

              checkClipboardJob(generation);
              // hash clipboard content
              const hcb = await hashCB(cb, type_);
              checkClipboardJob(generation);
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
                  checkClipboardJob(generation);
                  // set clipboard content
                  if (type_ === 'text') {
                    await NativeBridgeModule.copyTextToClipboard(cb);
                  } else if (type_ === 'image') {
                    block_image_once = true;
                    await NativeBridgeModule.copyBase64ImageToClipboardUsingCache(
                      binary.legacyContent(cb, type_),
                    );
                  } else if (type_ === 'files') {
                    await showFilesDownloadNotification(cb);
                    checkClipboardJob(generation);

                    files_in_memory = cb;
                    await setDataInAsyncStorage(
                      'filesAvailableToDownload',
                      'true',
                    );
                  }
                }
              }
              await clearShareFailure(generation);
            } catch (e) {
              if (isClipboardSuperseded(e)) return;
              await resetReceivingFragments();
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

            await Promise.all([...peers].map(pid => runSerializedPeerOp(pid, async () => {
              if (!run.isCurrent() || p2pShuttingDown || !myPeerId || !peers.has(pid) || pid === myPeerId) return;
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
            })));
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
              dropPeerFragments(oldPid);
              cancelPeerConnectionDeadline(oldPid);
              delete peerOpChains[oldPid];
              delete peerRetryAttempts[oldPid];
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
            dropPeerFragments(peerId);
            cancelPeerConnectionDeadline(peerId);
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

          const cancelPeerConnectionDeadline = peerId => {
            if (peerConnectionDeadlines[peerId] != null) {
              clearTimeout(peerConnectionDeadlines[peerId]);
              delete peerConnectionDeadlines[peerId];
            }
          };

          const peerConnectionTimedOut = (peerId, pc) => {
            if (peerConnections[peerId] !== pc) return;
            delete peerConnectionDeadlines[peerId];
            if (!run.isCurrent() || p2pShuttingDown || signalingStopped || !myPeerId || !peers.has(peerId)) return;
            if (dataChannels[peerId]?.readyState === 'open') return;
            console.warn('P2P: data channel did not open within 90s; scheduling recovery',
              peerId, pc.connectionState, pc.iceConnectionState, pc.signalingState);
            recoverPeerTransport(peerId, pc);
          };

          /**
           * Create and return a RTCPeerConnection, set up listeners for ICE + DataChannel.
           */
          const createPeerConnection = async remotePeerId => {
            if (!run.isCurrent()) throw new Error('Sync run is stopping');
            const pc = new RTCPeerConnection({
              iceServers: [
                {
                  urls: stun_url,
                },
              ],
            });

            pc.onicecandidate = track(async event => {
              if (event.candidate) {
                await signalingSend({
                  type: 'ICE_CANDIDATE',
                  fromPeerId: myPeerId,
                  toPeerId: remotePeerId,
                  candidate: event.candidate,
                });
              }
            });

            pc.ondatachannel = track(async event => {
              const channel = event.channel;
              if (peerConnections[remotePeerId] !== pc) {
                channel.close();
                return;
              }
              dataChannels[remotePeerId] = channel;
              await setupDataChannel(remotePeerId, channel);
            });

            pc.onconnectionstatechange = () => {
              const st = pc.connectionState;
              if (st === 'failed' || st === 'closed') {
                recoverPeerTransport(remotePeerId, pc);
              }
            };

            cancelPeerConnectionDeadline(remotePeerId);
            peerConnectionDeadlines[remotePeerId] = setTimeout(
              () => peerConnectionTimedOut(remotePeerId, pc), P2P_CONNECTION_TIMEOUT_MS,
            );
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

          const recoverPeerTransport = track(async (remotePeerId, deadPc) => {
            if (!run.isCurrent() || p2pShuttingDown || signalingStopped || !myPeerId || !peers.has(remotePeerId)) {
              return;
            }
            deadPc = deadPc || peerConnections[remotePeerId];
            if (!deadPc || peerConnections[remotePeerId] !== deadPc) {
              return;
            }
            const attempt = peerRetryAttempts[remotePeerId] || 0;
            await waitForRetry(Math.min(2 ** Math.min(attempt, 5), 30) * 1000);
            await runSerializedPeerOp(remotePeerId, async () => {
              if (!run.isCurrent() || p2pShuttingDown || signalingStopped || !myPeerId || !peers.has(remotePeerId)) {
                return;
              }
              if (deadPc != null && peerConnections[remotePeerId] !== deadPc) {
                return;
              }
              const ch = dataChannels[remotePeerId];
              // A failed transport can leave its channel reporting open. Only
              // suppress a queued retry when the transport has actually recovered.
              if (ch && ch.readyState === 'open' &&
                  deadPc.connectionState === 'connected' &&
                  ['connected', 'completed'].includes(deadPc.iceConnectionState)) {
                return;
              }
              peerRetryAttempts[remotePeerId] = Math.min(attempt + 1, 5);
              await disposePeerConnection(remotePeerId);
              if (!run.isCurrent() || p2pShuttingDown || signalingStopped || !myPeerId || !peers.has(remotePeerId)) {
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
          });

          /**
           * Handle incoming OFFER from remote, then respond with ANSWER.
           */
          const handleOffer = async (fromPeerId, offer) => {
            if (!run.isCurrent() || p2pShuttingDown) {
              return;
            }
            // Ignore delayed/stale OFFERs for peers removed from the latest PEER_LIST.
            // Startup guard: allow early signaling before ASSIGNED_ID/PEER_LIST is ready.
            if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
              return;
            }
            await runSerializedPeerOp(fromPeerId, async () => {
              if (!run.isCurrent() || p2pShuttingDown) {
                return;
              }
              // TOCTOU guard: PEER_LIST can change after the outer fast-path check.
              if (myPeerId && peers.size > 0 && !peers.has(fromPeerId)) {
                return;
              }
              // Full new offer (e.g. after peer recovery): must not apply on an
              // existing connected PC or datachannel counts diverge across devices.
              let pc = peerConnections[fromPeerId];
              if (pc && !(pc.signalingState === 'stable' &&
                  !pc.remoteDescription && pc.connectionState === 'new')) {
                await disposePeerConnection(fromPeerId);
                pc = null;
              }
              if (!pc) {
                pc = await createPeerConnection(fromPeerId);
                peerConnections[fromPeerId] = pc;
              }

              await pc.setRemoteDescription(new RTCSessionDescription(offer));
              await flushPendingIce(pc);
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
          const flushPendingIce = async pc => {
            const candidates = pendingIce.get(pc) || [];
            pendingIce.delete(pc);
            for (const candidate of candidates) {
              await pc.addIceCandidate(candidate);
            }
          };

          const handleAnswer = async (fromPeerId, answer) => {
            await runSerializedPeerOp(fromPeerId, async () => {
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

              if (pc.signalingState !== 'have-local-offer') return;
              await pc.setRemoteDescription(new RTCSessionDescription(answer));
              await flushPendingIce(pc);
            });
          };

          /**
           * Handle incoming ICE candidate from remote peer.
           */
          const handleIceCandidate = async (fromPeerId, candidateData) => {
            await runSerializedPeerOp(fromPeerId, async () => {
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

              const candidate = new RTCIceCandidate(candidateData);
              if (!pc.remoteDescription) {
                const candidates = pendingIce.get(pc) || [];
                if (candidates.length < 256) candidates.push(candidate);
                pendingIce.set(pc, candidates);
                return;
              }
              await pc.addIceCandidate(candidate);
            });
          };

          /**
           * Set up DataChannel for remotePeerId.
           */
          const setupDataChannel = async (remotePeerId, channel) => {
            channel.binaryType = 'arraybuffer';
            channel.onopen = track(async () => {
              if (dataChannels[remotePeerId] !== channel) return;
              cancelPeerConnectionDeadline(remotePeerId);
              delete peerRetryAttempts[remotePeerId];
              channel.send(P2P_DC_KEEPALIVE_JSON);
              startDataChannelHeartbeat(remotePeerId, channel);
              await syncLiveConnectionsCount();
            });

            const receiveMessage = serializeClipboardMessages(async data => {
              if (run.isCurrent() && !transportStopped && dataChannels[remotePeerId] === channel) {
                await onDataChannelMessage(data, remotePeerId);
              }
            }, () => localClipboardEpoch);
            channel.onmessage = track(e => receiveMessage(e.data));

            channel.onclose = track(async () => {
              if (dataChannels[remotePeerId] !== channel) return;
              dropPeerFragments(remotePeerId);
              const pc = peerConnections[remotePeerId];
              if (dataChannelHeartbeatTimers[remotePeerId]) {
                clearInterval(dataChannelHeartbeatTimers[remotePeerId]);
                delete dataChannelHeartbeatTimers[remotePeerId];
              }
              await syncLiveConnectionsCount();
              await recoverPeerTransport(remotePeerId, pc);
            });

            channel.onerror = track(async err => {
              p2pMsg = '❌ DataChannel error with ' + remotePeerId + ': ' + err;
              await p2pStatusMessageChanged();
            });

            if (channel.readyState === 'open') {
              await channel.onopen();
            }
          };
        }

        // send clipboard content
        const sendClipBoard = async (clipContent, type_ = 'text') => {
          if (!run.isCurrent() || transportStopped) return false;
          // Native observation metadata identifies our own writes. A real
          // local copy must not be suppressed merely because its text or URI
          // matches a previous received item.
          block_image_once = false;
          localClipboardEpoch++;
          const generation = clipboardJobs.cancel();
          cancelIncoming();
          let sent;
          try {
            await clearFiles();
            checkClipboardJob(generation);
            await clearShareFailure(generation);
            checkClipboardJob(generation);
            if (!(await isClipboardSyncEnabled('send_clipboard'))) return;
            checkClipboardJob(generation);
            sent = server_mode === 'P2S'
              ? await sendClipBoardP2S(clipContent, type_, generation)
              : await sendClipBoardP2P(clipContent, type_, generation);
            checkClipboardJob(generation);
            if (sent === false) {
              throw new Error('Clipboard not sent: connection unavailable, busy, or interrupted. Copy/share it again when connected.');
            }
            await clearShareFailure(generation);
          } catch (error) {
            // A newer local copy or inbound item can arrive while an awaited
            // send is returning false or failing. It is cancellation, not a
            // connection error belonging to the current clipboard item.
            if (generation !== clipboardJobs.generation) return true;
            if (isClipboardSuperseded(error)) return true;
            throw error;
          }
          return sent;
        };

        let deliveringShare = false;
        async function processPendingShares() {
          if (!run.isCurrent() || deliveringShare) return;
          deliveringShare = true;
          try {
            while (await deliverPendingShare(
              NativeBridgeModule,
              isShareTransportReady,
              async (content, type) => {
                block_image_once = false;
                const expectedGeneration = clipboardJobs.generation + 1;
                const result = await sendClipBoard(content, type);
                if (run.isCurrent() && type === 'text' && clipboardJobs.generation === expectedGeneration) {
                  try {
                    await NativeBridgeModule.copyTextToClipboard(content);
                  } catch (error) {
                    await setDataInAsyncStorage('wsStatusMessage', '❌ Clipboard error: ' + error);
                  }
                }
                return result;
              },
              error => setDataInAsyncStorage('wsStatusMessage', '❌ Share failed: ' + error),
              revision => clipboardRevisions.baseline(revision),
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
          await run.drain();
        };

        function sleep(ms) {
          return new Promise(res => setTimeout(res, ms));
        }

        async function pollFlagsLoop() {
          const POLL_KEYS = [
            'wsIsRunning',
            'downloadFiles',
            'filesAvailableToDownload',
          ];

          while (true) {
            const json = NativeBridgeModule.getFlagsSync(POLL_KEYS);
            const latest = JSON.parse(json);

            if (run.isCurrent() && restarting && latest.wsIsRunning === 'true') {
              await stopServices();
              return true;
            }

            // check if wsIsRunning is true or else terminate the service
            if (!run.isCurrent() || latest.wsIsRunning !== 'true') {
              restarting = false;
              await stopServices();
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
                const files = typeof files_in_memory === 'string' ? JSON.parse(files_in_memory) : (files_in_memory || {});
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
                    JSON.stringify({[name]: typeof content === 'string' ? content : binary.toBase64(content)}),
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
        try {
          await cleanupTransport();
        } finally {
          cleanupClipboardListeners();
          // Cleanup reports Disconnected; publish the failure afterwards so
          // the dashboard can explain why the service stopped.
          await setDataInAsyncStorage('wsStatusMessage', '❌ Error: ' + error);
        }
        return false;
      }
    };
    try {
      while (await runTransport()) {
        // Keep the foreground notification alive while replacing the transport.
      }
    } finally {
      bridge.requestServiceRunStopSync(runId, false);
      heartbeatStopped = true;
      clearInterval(heartbeatTimer);
      serviceController.abort();
      // Keep ownership until every old callback and native cleanup completes.
      // If cleanup fails/hangs, a new start times out instead of overlapping.
      await stopClipboard();
      cleanupClipboardListeners();
      await run.drain();
      if (transportCleanupFailed) throw new Error('Sync transport cleanup failed; restart ClipCascade before starting sync again.');
      if (run.isOwner()) {
        await notifee.stopForegroundService();
        await setDataInAsyncStorage('wsIsRunning', 'false');
        await setDataInAsyncStorage('wsForegroundServiceTerminated', 'true');
        bridge.releaseServiceRunSync(runId);
      }
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
    if (!runnerStarted && run.isOwner()) {
      bridge.requestServiceRunStopSync(runId, false);
      await notifee.stopForegroundService();
      await setDataInAsyncStorage('wsForegroundServiceTerminated', 'true');
      bridge.releaseServiceRunSync(runId);
    }
    return [false, error];
  }
};
