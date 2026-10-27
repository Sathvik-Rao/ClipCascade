/* -----------------------------------------
   ==========  GLOBAL CONSTANTS  ===========
   ----------------------------------------- */
const SELECTORS = {
  // User Section
  userSection: "#user-section",
  brokerUrlInput: "#broker-url",
  connectBtn: "#connect",
  disconnectBtn: "#disconnect",
  sendBtn: "#send",
  conversationTable: "#conversation",
  conversationBody: "#channel",
  statusMessage: "#status-message",

  // Header / Common
  updateLink: "#update-link",
  serverVersion: "#server-version",
  advanceLink: "#advance-link",
  changeUsernameLink: "#change-username-link",
  changePasswordLink: "#change-password-link",
  logoutLink: "#logout-link",
  logoutAllDevicesLink: "#logout-all-devices-link",
  maxMessageSize: "#max-message-size",
  user: "#user-name",
  donateLink: "#donate-link",

  // Admin Section
  adminSection: "#admin-section",
  loadUsersBtn: "#load-users-btn",
  revokeAllSessionsBtn: "#revoke-all-sessions-btn",
  usersTableBody: "#users-tbody",
  usersTable: "#users-table",
  adminUsersSearch: "#admin-users-search",
  adminUsersPager: "#admin-users-pager",
  openAddUserModalBtn: "#open-add-user-modal-btn",

  // Modals: Add User
  addUserModal: "#add-user-modal",
  addUserForm: "#add-user-form",
  addUsernameInput: "#add-username-input",
  addPasswordInput: "#add-password-input",
  addEnabledSelect: "#add-enabled-select",

  // Modals: Edit User
  editUserModal: "#edit-user-modal",
  editUserForm: "#edit-user-form",
  editUserOldUsername: "#edit-user-old-username",
  editUserNewUsername: "#edit-user-new-username",
  editUserNewPassword: "#edit-user-new-password",
  editUserEnabled: "#edit-user-enabled",
};

const ENDPOINTS = {
  whoami: "/whoami",
  logout: "/logout",
  logoutAllDevices: "/logout-session",
  csrfToken: "/csrf-token",
  adminUsers: "/admin/users",
  adminUsersPage: "/admin/users/page",
  adminRegisterUser: "/admin/register-user",
  adminDeleteUser: "/admin/delete-user",
  adminToggleUserStatus: "/admin/toggle-user-status",
  adminUpdateUserPassword: "/admin/update-user-password",
  adminUpdateUsername: "/admin/update-username",
  updatePassword: "/update-password",
  maxMessageSize: "/max-message-size",
  websocketSend: "/app/cliptext",
  websocketReceive: "/user/queue/cliptext",
  adminLogoutUserSession: "/admin/logout-user-session",
  adminLogoutAllSessions: "/admin/logout-all-sessions",
  serverVersion: "/server-version",
  latestServerVersion: "/latest-server-version",
  serverMode: "/server-mode",
  stunUrl: "/stun-url",
  donationStatus: "/donation-status",
};

// server mode
// "P2S" => peer to server  (STOMP approach)
// "P2P" => peer to peer (WebRTC mesh)
let CURRENT_MODE = "P2S";

// STOMP references for P2S
let stompClient = null;

// P2P references
let p2pSignalingWebSocket = null;
let myPeerId = null;
let peerConnections = {}; // key = peerId, value = RTCPeerConnection
let dataChannels = {}; // key = peerId, value = RTCDataChannel
let heartbeatIntervalId = null; // for 20s keep-alive on P2P
let stunConfig = { iceServers: [] }; // will be loaded from /stun-url

// Common
let monitoringRequested = false;
let monitoringGeneration = 0;
let reconnectTimer = null;
let connectionTimer = null;
let reconnectAttempts = 0;

let CSRF_TOKEN = null;
let MAX_MESSAGE_SIZE = null; // in MiB
let CSRF_HEADER_NAME = "X-CSRF-TOKEN";

function compareReleaseVersions(latest, installed) {
  const parse = (value) => {
    if (typeof value !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.trim())) {
      throw new Error("Invalid release version");
    }
    const parts = value.trim().split(".").map(Number);
    if (!parts.every(Number.isSafeInteger)) {
      throw new Error("Invalid release version");
    }
    return parts;
  };
  const remote = parse(latest);
  const current = parse(installed);
  for (let i = 0; i < remote.length; i++) {
    if (remote[i] !== current[i]) {
      return remote[i] > current[i] ? 1 : -1;
    }
  }
  return 0;
}

/* -----------------------------------------
         ============  ON DOCUMENT READY  =========
         ----------------------------------------- */
$(function () {
  // Keep navigation usable before the account requests have completed.
  const navigationToggle = document.getElementById("navigation-toggle");
  navigationToggle.addEventListener("click", () => {
    const expanded = navigationToggle.getAttribute("aria-expanded") !== "true";
    navigationToggle.setAttribute("aria-expanded", String(expanded));
    document.getElementById("account-navigation").classList.toggle("is-open", expanded);
  });

  // Prevent form submissions from reloading the page
  $("form").on("submit", (e) => e.preventDefault());

  // 1) Fetch CSRF token
  fetchCsrfToken()
    // 2) Fetch Server Mode
    .then(fetchServerMode)
    // 3) Fetch Max Message Size
    .then(fetchMaxMessageSize)
    // 4) Then fetch user info
    .then(fetchCurrentUser)
    // 5) Then finalize UI (admin vs user)
    .then((userData) => {
      // Always show the user section
      showSection(SELECTORS.userSection);

      // Set the username in the Navbar
      $(SELECTORS.user).text(userData.username);

      // If user is Admin, show Admin Section and change username button
      if (userData.role === "ADMIN") {
        showSection(SELECTORS.advanceLink);
        showSection(SELECTORS.changeUsernameLink);
        showSection(SELECTORS.adminSection);
      }

      // Show the read-only server version to every signed-in user.
      fetchServerVersion()
        .then((serverVersion) => {
          $(SELECTORS.serverVersion).text(`Version v${serverVersion.version}`);
          fetchLatestServerVersion()
            .then((latestServerVersion) => {
              const comparison = compareReleaseVersions(latestServerVersion.server, serverVersion.version);
              if (comparison === 0) {
                $(SELECTORS.serverVersion).text(`Version v${serverVersion.version} (latest)`);
              } else if (comparison > 0 && userData.role === "ADMIN") {
                $(SELECTORS.updateLink).text(
                  `🔄 Update (${serverVersion.version} ➞ ${latestServerVersion.server})`
                );
                showSection(SELECTORS.updateLink);
              }
            })
            .catch(() => {});
        })
        .catch(() => {});

      // Initialize event handlers
      initEventHandlers();

      // Auto-populate the default WebSocket/Signaling URL
      autoPopulateWebSocketURL();
    })
    // 6) Fetch Donation Status
    .then(fetchDonationStatus)
    // 7) Show Donate Link
    .then((donationData) => {
      if (donationData.enabled) {
        $(SELECTORS.donateLink).show();
      }
    })
    .catch((err) => {
      console.error("Failed to initialize page:", err);
    });
});

/* -----------------------------------------
         ============  INIT EVENT HANDLERS  ========
         ----------------------------------------- */
function initEventHandlers() {
  // HOME (User) Section event bindings
  $(SELECTORS.connectBtn).click(onConnectClick);
  $(SELECTORS.disconnectBtn).click(onDisconnectClick);
  $(SELECTORS.sendBtn).click(onSendClick);

  // Header links
  $(SELECTORS.changeUsernameLink).click(onChangeUsernameClick);
  $(SELECTORS.changePasswordLink).click(onChangePasswordClick);
  $(SELECTORS.logoutLink).click(onLogoutClick);
  $(SELECTORS.logoutAllDevicesLink).click(onLogoutAllDevicesClick);

  // Admin Section
  $(SELECTORS.loadUsersBtn).click(loadAllUsers);
  $(SELECTORS.revokeAllSessionsBtn).click(revokeAllUserSessions);
  $(SELECTORS.openAddUserModalBtn).click(() =>
    showModal(SELECTORS.addUserModal)
  );

  // Add User Modal form submission
  $(SELECTORS.addUserForm).submit(onAddUserSubmit);

  // Edit User Modal form submission
  $(SELECTORS.editUserForm).submit(onEditUserSubmit);
}

/* -----------------------------------------
                ==========  MODE DECISION  =========
                ----------------------------------------- */
function onConnectClick() {
  if (monitoringRequested) return;
  monitoringRequested = true;
  reconnectAttempts = 0;
  const generation = ++monitoringGeneration;
  updateMonitoringControls(false);
  showStatusMessage("Connecting to monitoring…", "info");
  connectMonitoring(generation);
}

async function connectMonitoring(generation) {
  try {
    // A failed WebSocket handshake does not expose HTTP authentication status.
    // Probe the session before each attempt so expired logins stop retrying.
    const user = await $.ajax({ url: ENDPOINTS.whoami, dataType: "json", cache: false });
    if (!monitoringRequested || generation !== monitoringGeneration) return;
    if (!user || typeof user.username !== "string") {
      monitoringSessionExpired();
      return;
    }
    if (CURRENT_MODE === "P2S") connectStomp(generation);
    else await connectP2P(generation);
  } catch (error) {
    if (!monitoringRequested || generation !== monitoringGeneration) return;
    if (error.status === 401 || error.status === 403 || error.status === 200) {
      // Redirects to the HTML login page produce a JSON parse error with HTTP 200.
      monitoringSessionExpired();
    } else {
      scheduleMonitoringReconnect(generation);
    }
  }
}

function updateMonitoringControls(connected) {
  $(SELECTORS.connectBtn).prop("disabled", monitoringRequested);
  $(SELECTORS.disconnectBtn).prop("disabled", !monitoringRequested);
  $(SELECTORS.sendBtn).prop("disabled", !connected);
  if (connected) $(SELECTORS.conversationTable).show();
}

function scheduleMonitoringReconnect(generation) {
  if (!monitoringRequested || generation !== monitoringGeneration || reconnectTimer !== null) return;
  updateMonitoringControls(false);
  const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts++, 5), 30000);
  showStatusMessage(`Connection lost. Retrying in ${delay / 1000} seconds…`, "warning");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMonitoring(generation);
  }, delay);
}

function monitoringSessionExpired() {
  onDisconnectClick();
  showStatusMessage("Your session expired or was revoked. Please log in again.", "warning");
  window.location.href = "/login?expired";
}

function onSendClick() {
  const textVal = $("#ws_text").val() || "";
  if (!textVal.trim()) return;

  // Send to STOMP or P2P
  if (CURRENT_MODE === "P2S") {
    sendTextToServerStomp(textVal);
  } else {
    sendTextToPeers(textVal);
  }

  // Log *locally* in the monitoring
  displayIncomingMessage({ payload: textVal, type: "text" });
}

function onDisconnectClick() {
  monitoringRequested = false;
  ++monitoringGeneration;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  reconnectTimer = connectionTimer = null;
  disconnectStomp();
  disconnectP2P();
  updateMonitoringControls(false);
  $(SELECTORS.conversationTable).hide();
  $(SELECTORS.conversationBody).empty();
  showStatusMessage("Monitoring disconnected.", "warning");
}

/* -----------------------------------------
                    ==========  UTILITY  ==========
                    ----------------------------------------- */
function showSection(selector) {
  $(selector).css("display", "block");
}
function hideSection(selector) {
  $(selector).css("display", "none");
}
function showStatusMessage(message, type) {
  // type can be 'success', 'danger', 'warning', 'info'
  const statusMessageElem = $(SELECTORS.statusMessage);
  statusMessageElem
    .removeClass("alert-success alert-danger alert-warning alert-info")
    .addClass(`alert alert-${type}`)
    .text(message)
    .show();
}
function hideStatusMessage() {
  $(SELECTORS.statusMessage).hide();
}
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function autoPopulateWebSocketURL() {
  const currentUrl = window.location.href;
  const urlParts = currentUrl.split("/");
  const protocol = currentUrl.startsWith("https://") ? "wss" : "ws";
  const domain = urlParts[2];

  if (CURRENT_MODE === "P2S") {
    const defaultWsUrl = `${protocol}://${domain}/clipsocket`;
    $(SELECTORS.brokerUrlInput).val(defaultWsUrl);
  } else {
    const defaultWsUrl = `${protocol}://${domain}/p2psignaling`;
    $(SELECTORS.brokerUrlInput).val(defaultWsUrl);
  }
}
function base64EncodeUnicode(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary);
}
function downloadFile(filename, base64Content) {
  const blob = new Blob([atob(base64Content)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => console.log("Text copied to clipboard."))
    .catch((err) => {
      console.error("Could not copy text: ", err);
      alert("Failed to copy to clipboard.");
    });
}
function showModal(modalSelector) {
  $(modalSelector).css("display", "flex");
}
function hideModal(modalSelector) {
  $(modalSelector).css("display", "none");
}
function hideAddUserModal() {
  hideModal(SELECTORS.addUserModal);
}
function hideEditUserModal() {
  hideModal(SELECTORS.editUserModal);
}
function validateUsername(username) {
  return (
    username &&
    username.length > 0 &&
    !username.startsWith(" ") &&
    !username.endsWith(" ")
  );
}

/* -----------------------------------------
         ============  FETCH FUNCTIONS  ===========
         ----------------------------------------- */
function fetchCurrentUser() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.whoami,
      method: "GET",
      success: (data) => {
        resolve(data);
      },
      error: (err) => {
        console.error("Failed to fetch user info:", err);
        reject(err);
      },
    });
  });
}
function fetchServerVersion() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.serverVersion,
      method: "GET",
      success: (data) => {
        resolve(data);
      },
      error: (err) => {
        console.error("Failed to fetch server version:", err);
        reject(err);
      },
    });
  });
}
function fetchLatestServerVersion() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.latestServerVersion,
      method: "GET",
      success: (data) => {
        resolve(data);
      },
      error: (err) => {
        console.error("Failed to fetch latest server version:", err);
        reject(err);
      },
    });
  });
}
function fetchCsrfToken() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.csrfToken,
      method: "GET",
      success: (data) => {
        CSRF_TOKEN = data.token;
        if (data.headerName) {
          CSRF_HEADER_NAME = data.headerName;
        }
        // Setup a global AJAX beforeSend to attach the CSRF token
        $.ajaxSetup({
          beforeSend: function (xhr) {
            xhr.setRequestHeader(CSRF_HEADER_NAME, CSRF_TOKEN);
          },
        });
        resolve();
      },
      error: (err) => {
        console.error("Failed to fetch CSRF token:", err);
        reject(err);
      },
    });
  });
}
function fetchMaxMessageSize() {
  return new Promise((resolve, reject) => {
    if (CURRENT_MODE === "P2P") {
      // Set max message size to "infinite" for P2P mode
      MAX_MESSAGE_SIZE = "∞";
      $(SELECTORS.maxMessageSize).text(`Max Message Size: ${MAX_MESSAGE_SIZE}`);
      resolve();
    } else {
      $.ajax({
        url: ENDPOINTS.maxMessageSize,
        method: "GET",
        success: (data) => {
          MAX_MESSAGE_SIZE = data.maxmessagesize;
          $(SELECTORS.maxMessageSize).text(
            `Max Message Size: ${MAX_MESSAGE_SIZE} MiB`
          );
          resolve();
        },
        error: (err) => {
          console.error("Failed to fetch max message size:", err);
          $(SELECTORS.maxMessageSize).text("Max Message Size: Unknown");
          reject(err);
        },
      });
    }
  });
}
function fetchServerMode() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.serverMode,
      method: "GET",
      success: (data) => {
        if (data && data.mode) {
          CURRENT_MODE = data.mode; // "P2S" or "P2P"
        }
        resolve();
      },
      error: (err) => {
        console.error("Failed to fetch server mode:", err);
        // fallback is P2S
        CURRENT_MODE = "P2S";
        resolve();
      },
    });
  });
}
function fetchStunUrl() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.stunUrl,
      method: "GET",
      success: (data) => {
        if (data && data.url) {
          stunConfig = { iceServers: [{ urls: data.url }] };
        }
        resolve();
      },
      error: (err) => {
        console.error("Failed to fetch STUN url:", err);
        resolve();
      },
    });
  });
}

function fetchDonationStatus() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.donationStatus,
      method: "GET",
      success: (data) => {
        resolve(data);
      },
      error: (err) => {
        console.error("Failed to fetch donation status:", err);
        resolve({ enabled: false });
      },
    });
  });
}

/* -----------------------------------------
               ==========  STOMP (P2S)  ==========
               ----------------------------------------- */
function connectStomp(generation) {
  const client = new StompJs.Client({
    brokerURL: $(SELECTORS.brokerUrlInput).val(),
    heartbeatIncoming: 20000,
    heartbeatOutgoing: 0,
    connectionTimeout: 15000,
    reconnectDelay: 0, // Both modes use the authenticated retry loop above.
  });
  stompClient = client;
  const current = () => monitoringRequested && generation === monitoringGeneration && stompClient === client;
  client.onConnect = () => {
    if (!current()) return;
    reconnectAttempts = 0;
    updateMonitoringControls(true);
    showStatusMessage("Connected to WebSocket server (P2S).", "success");
    client.subscribe(ENDPOINTS.websocketReceive, (res) => {
      if (current()) displayIncomingMessage(JSON.parse(res.body));
    });
  };
  client.onWebSocketClose = () => {
    if (!current()) return;
    stompClient = null;
    client.deactivate();
    scheduleMonitoringReconnect(generation);
  };
  client.onWebSocketError = (error) => {
    if (current()) showStatusMessage("WebSocket connection failed. Waiting to retry…", "warning");
    console.error("WebSocket error:", error);
  };
  client.onStompError = () => {
    if (!current()) return;
    stompClient = null;
    client.deactivate();
    scheduleMonitoringReconnect(generation);
  };
  client.activate();
}

function disconnectStomp() {
  const client = stompClient;
  stompClient = null;
  if (client) client.deactivate();
}

function sendTextToServerStomp(textVal) {
  if (!stompClient || !stompClient.connected) return;
  stompClient.publish({
    destination: ENDPOINTS.websocketSend,
    body: JSON.stringify({ payload: textVal, type: "text" }),
  });
}

/* -----------------------------------------
               ==========  P2P WEBRTC  ==========
               ----------------------------------------- */
async function connectP2P(generation) {
  const signalingUrl = $(SELECTORS.brokerUrlInput).val();
  await fetchStunUrl();
  if (!monitoringRequested || generation !== monitoringGeneration) return;
  const socket = new WebSocket(signalingUrl);
  p2pSignalingWebSocket = socket;
  const current = () => monitoringRequested && generation === monitoringGeneration && p2pSignalingWebSocket === socket;
  connectionTimer = setTimeout(() => {
    if (current()) socket.close();
  }, 15000);
  socket.onopen = () => {
    if (!current()) return;
    clearTimeout(connectionTimer);
    connectionTimer = null;
    reconnectAttempts = 0;
    updateMonitoringControls(true);
    showStatusMessage("Connected to Signaling server (P2P).", "success");
  };
  socket.onmessage = (evt) => {
    if (current()) handleSignalingMessage(JSON.parse(evt.data));
  };
  socket.onclose = () => {
    if (!current()) return;
    clearTimeout(connectionTimer);
    connectionTimer = null;
    p2pSignalingWebSocket = null;
    closePeerConnections();
    scheduleMonitoringReconnect(generation);
  };
  socket.onerror = () => {
    if (current()) socket.close();
  };
}

function closePeerConnections() {
  for (const peerId in peerConnections) peerConnections[peerId].close();
  peerConnections = {};
  dataChannels = {};
  myPeerId = null;
}

function disconnectP2P() {
  const socket = p2pSignalingWebSocket;
  p2pSignalingWebSocket = null;
  if (socket) socket.close();
  if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
  heartbeatIntervalId = null;
  closePeerConnections();
}

function handleSignalingMessage(msg) {
  const type = msg.type || "";
  switch (type) {
    case "ASSIGNED_ID":
      myPeerId = msg.peerId;
      console.log("Assigned myPeerId:", myPeerId);
      break;
    case "PEER_LIST":
      handlePeerListUpdate(msg.peers || []);
      break;
    case "OFFER":
      handleOffer(msg);
      break;
    case "ANSWER":
      handleAnswer(msg);
      break;
    case "ICE_CANDIDATE":
      handleIceCandidateMsg(msg);
      break;
    default:
      console.log("Unknown signaling message:", msg);
      break;
  }
}

// Tie-break logic: Only create an offer if myPeerId < peerId
function handlePeerListUpdate(peers) {
  peers.forEach((peerId) => {
    if (peerId === myPeerId) return; // Ignore self
    if (!peerConnections[peerId]) {
      const initiator = myPeerId < peerId;
      createPeerConnection(peerId, initiator);
    }
  });

  // If any leftover peers are gone from the list, close them
  for (const pid in peerConnections) {
    if (!peers.includes(pid)) {
      peerConnections[pid].close();
      delete peerConnections[pid];
      delete dataChannels[pid];
    }
  }
}

function createPeerConnection(peerId, initiator) {
  console.log(
    `Creating peer connection for ${peerId}. Initiator: ${initiator}`
  );
  const pc = new RTCPeerConnection(stunConfig);
  peerConnections[peerId] = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignalingMessage({
        type: "ICE_CANDIDATE",
        fromPeerId: myPeerId,
        toPeerId: peerId,
        candidate: event.candidate,
      });
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    setupDataChannel(peerId, channel);
  };

  // If we are the initiator, create data channel + send offer
  if (initiator) {
    const channel = pc.createDataChannel("cliptext");
    setupDataChannel(peerId, channel);

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendSignalingMessage({
          type: "OFFER",
          fromPeerId: myPeerId,
          toPeerId: peerId,
          offer: pc.localDescription,
        });
      })
      .catch((err) => {
        console.error("Failed to create/send offer:", err);
      });
  }
}

function setupDataChannel(peerId, channel) {
  dataChannels[peerId] = channel;
  channel.onopen = () => {
    console.log("Data channel open with peer:", peerId);
  };
  channel.onclose = () => {
    console.log("Data channel closed with peer:", peerId);
  };
  channel.onmessage = (event) => {
    let msgObj;
    try {
      msgObj = JSON.parse(event.data);
    } catch (e) {
      console.warn("Received non-JSON or invalid data from peer:", event.data);
      return;
    }
    displayIncomingMessage(msgObj);
  };
}

function handleOffer(msg) {
  const fromPeerId = msg.fromPeerId;
  if (!peerConnections[fromPeerId]) {
    createPeerConnection(fromPeerId, false);
  }
  const pc = peerConnections[fromPeerId];
  pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      sendSignalingMessage({
        type: "ANSWER",
        fromPeerId: myPeerId,
        toPeerId: fromPeerId,
        answer: pc.localDescription,
      });
    })
    .catch((err) => {
      console.error("Failed to handleOffer:", err);
    });
}

function handleAnswer(msg) {
  const fromPeerId = msg.fromPeerId;
  const pc = peerConnections[fromPeerId];
  if (!pc) return;

  // If for some reason we get an ANSWER at an unexpected time:
  if (pc.signalingState !== "have-local-offer") {
    console.warn(
      `Ignoring unexpected ANSWER in signalingState= ${pc.signalingState}`
    );
    return;
  }
  pc.setRemoteDescription(new RTCSessionDescription(msg.answer)).catch(
    (err) => {
      console.error("Failed to setRemoteDescription(Answer):", err);
    }
  );
}

function handleIceCandidateMsg(msg) {
  const fromPeerId = msg.fromPeerId;
  const pc = peerConnections[fromPeerId];
  if (!pc) return;

  pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch((err) => {
    console.error("Error adding ICE candidate:", err);
  });
}

function sendSignalingMessage(payload) {
  if (
    p2pSignalingWebSocket &&
    p2pSignalingWebSocket.readyState === WebSocket.OPEN
  ) {
    p2pSignalingWebSocket.send(JSON.stringify(payload));
  }
}

function sendTextToPeers(textVal) {
  const msg = { payload: textVal, type: "text" };
  const strMsg = JSON.stringify(msg);
  for (const pid in dataChannels) {
    const ch = dataChannels[pid];
    if (ch && ch.readyState === "open") {
      ch.send(strMsg);
    }
  }
}

/* -----------------------------------------
             ========== COMMON MONITORING =========
         ----------------------------------------- */
function displayIncomingMessage(message) {
  // Peer keep-alives are connection traffic, not clipboard entries.
  if (message && message._cc_keepalive === true) return;

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const filename = `${timestamp}.txt`;
  const payload = message.payload || "";
  const type = message.type || "text";

  const encodedText = base64EncodeUnicode(payload);
  const escapedPayload = escapeHtml(payload);
  const escapedType = escapeHtml(type);

  let metadataHtml = "";
  if (message.metadata) {
    const metadataStr = JSON.stringify(message.metadata);
    metadataHtml = `, metadata:${escapeHtml(metadataStr)}`;
  }

  const row = $(`
          <tr>
            <td>{payload:${escapedPayload}, type:${escapedType}${metadataHtml}}</td>
            <td>
              <div class="button-container">
                <button class="btn btn-primary download-btn"
                        onclick="downloadFile('${filename}', '${encodedText}')">Download</button>
                <button class="btn btn-default copy-btn"
                        onclick="copyToClipboard('${escapedPayload}')">Copy</button>
              </div>
            </td>
          </tr>
        `);
  $(SELECTORS.conversationBody).append(row);
}

/* -----------------------------------------
            ===========  HEADER LINK HANDLERS  =====
            ----------------------------------------- */
function onChangeUsernameClick() {
  const oldUsername = $(SELECTORS.user).text();
  const newUsername = prompt("Enter your new username:");
  if (!validateUsername(newUsername)) {
    alert("Username cannot be empty or start/end with whitespace.");
    return;
  }

  $.ajax({
    url: ENDPOINTS.adminUpdateUsername,
    method: "PUT",
    contentType: "application/json",
    data: JSON.stringify({ oldUsername, newUsername }),
    success: () => {
      alert(
        "Username updated successfully. You will be logged out from all devices."
      );
      window.location.href = "/login?expired";
    },
    error: (err) => {
      console.error("Failed to update username:", err);
      alert("Error: Unable to update your username.");
    },
  });
}

function onChangePasswordClick() {
  const newPassword = prompt("Enter your new password:");
  if (!newPassword) {
    alert("Password cannot be empty.");
    return;
  }
  const hashedPassword = sha3_512(newPassword);

  $.ajax({
    url: ENDPOINTS.updatePassword,
    type: "PUT",
    contentType: "application/json",
    data: JSON.stringify({ newPassword: hashedPassword }),
    success: (res) => {
      alert(res);
    },
    error: (err) => {
      alert("Failed to update password");
      console.error(err);
    },
  });
}

function onLogoutClick() {
  window.location.href = ENDPOINTS.logout;
}

function onLogoutAllDevicesClick() {
  logoutAllDevices(() => {
    window.location.href = "/login?expired";
  });
}

function logoutAllDevices(successCallback) {
  $.ajax({
    url: ENDPOINTS.logoutAllDevices,
    type: "DELETE",
    success: function () {
      if (typeof successCallback === "function") {
        successCallback();
      }
    },
    error: function (err) {
      console.error("Failed to log off from all devices:", err);
      alert("Failed to log off from all devices.");
    },
  });
}

/* -----------------------------------------
               ============  ADMIN LOGIC  =========
               ----------------------------------------- */
function loadAllUsers() {
  adminUsersTableController.reload();
}

/**
 * Make table columns drag-resizable. Switches the table to fixed layout,
 * locks each <th> at its current width, and adds a right-edge drag handle.
 */
function enableColumnResize(tableEl) {
  if (!tableEl || tableEl.dataset.resizableInit === "1") return;
  tableEl.dataset.resizableInit = "1";
  tableEl.classList.add("table-resizable");

  tableEl.querySelectorAll("thead th").forEach((th) => {
    if (!th.style.width) th.style.width = th.offsetWidth + "px";

    const handle = document.createElement("div");
    handle.className = "col-resizer";
    th.appendChild(handle);

    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const dx = e.clientX - startX;
      th.style.width = Math.max(40, startW + dx) + "px";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startW = th.offsetWidth;
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    handle.addEventListener("click", (e) => e.stopPropagation());
  });
}

/**
 * Admin Users table controller — server-driven sort/filter/paginate.
 * Built lazily on first reload so it can attach handlers once. State is
 * thin (no client-side rows cache) since the backend owns every query.
 */
const adminUsersTableController = (() => {
  const state = {
    initialized: false,
    content: [],
    totalElements: 0,
    totalPages: 1,
    page: 0, // 0-based to match backend
    pageSize: 10, // -1 means "All"
    sortKey: "username",
    sortDir: "asc",
    search: "",
    searchDebounce: null,
  };

  function reload() {
    init();
    const params = {
      page: state.page,
      size: state.pageSize,
      sort: state.sortKey,
      direction: state.sortDir,
      search: state.search,
    };
    return $.ajax({
      url: ENDPOINTS.adminUsersPage,
      method: "GET",
      data: params,
    })
      .done((data) => {
        state.content = Array.isArray(data.content) ? data.content : [];
        state.totalElements =
          typeof data.totalElements === "number"
            ? data.totalElements
            : state.content.length;
        state.totalPages =
          typeof data.totalPages === "number" && data.totalPages > 0
            ? data.totalPages
            : 1;
        if (typeof data.page === "number") state.page = data.page;
        render();
      })
      .fail((err) => {
        alert("Failed to load users");
        console.error(err);
      });
  }

  function render() {
    const tbody = $(SELECTORS.usersTableBody);
    tbody.empty();

    state.content.forEach((user) => {
      const row = $("<tr></tr>");
      row.append($("<td></td>").text(user.username));
      row.append($("<td></td>").text(user.enabled ? "Enabled" : "Disabled"));

      const actionTd = $("<td></td>");
      const editBtn = $("<button class='btn btn-primary btn-sm'>Edit</button>");
      editBtn.click(() => showEditUserModal(user));

      const deleteBtn = $(
        "<button class='btn btn-danger btn-sm' style='margin-left:5px;'>Delete</button>"
      );
      deleteBtn.click(() => deleteUser(user.username));

      const revokeBtn = $("<button class='btn btn-warning btn-sm' style='margin-left:5px;'>Revoke sessions</button>");
      revokeBtn.click(() => {
        if (!confirm(`Revoke all sessions for '${user.username}'?`)) return;
        logoutUserFromAllDevices(user.username, () => {
          if (user.username === $(SELECTORS.user).text()) window.location.href = "/login?expired";
          else alert(`Sessions revoked for '${user.username}'.`);
        });
      });
      actionTd.append(editBtn).append(revokeBtn).append(deleteBtn);
      row.append(actionTd);
      tbody.append(row);
    });

    // Header sort indicators
    $(SELECTORS.usersTable + " thead th[data-key]").each(function () {
      const $th = $(this);
      $th.removeClass("sort-asc sort-desc");
      if ($th.data("key") === state.sortKey) {
        $th.addClass(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
      }
    });

    // Pager
    const $pager = $(SELECTORS.adminUsersPager);
    $pager.empty();
    const total = state.totalElements;
    const usingAll = state.pageSize <= 0;
    const lo =
      total === 0 ? 0 : usingAll ? 1 : state.page * state.pageSize + 1;
    const hi = usingAll
      ? total
      : Math.min((state.page + 1) * state.pageSize, total);

    const $prev = $(
      "<button class='btn btn-default btn-sm'>Prev</button>"
    ).prop("disabled", usingAll || state.page <= 0);
    $prev.click(() => {
      state.page = Math.max(0, state.page - 1);
      reload();
    });

    const $pageLabel = $("<span class='page-info'></span>").text(
      `Page ${state.page + 1} / ${state.totalPages}`
    );

    const $next = $(
      "<button class='btn btn-default btn-sm'>Next</button>"
    ).prop("disabled", usingAll || state.page >= state.totalPages - 1);
    $next.click(() => {
      state.page = Math.min(state.totalPages - 1, state.page + 1);
      reload();
    });

    const $size = $("<select class='form-control'></select>").css({
      display: "inline-block",
      width: "auto",
    });
    const pageSizeOptions = [
      { value: 10, label: "10 / page" },
      { value: 25, label: "25 / page" },
      { value: 50, label: "50 / page" },
      { value: 100, label: "100 / page" },
      { value: -1, label: "All" },
    ];
    pageSizeOptions.forEach(({ value, label }) => {
      $size.append(
        $("<option></option>")
          .val(value)
          .text(label)
          .prop("selected", value === state.pageSize)
      );
    });
    $size.change(function () {
      state.pageSize = Number($(this).val());
      state.page = 0;
      reload();
    });

    const $info = $("<span class='page-info'></span>").text(
      `${lo}-${hi} of ${total}`
    );

    $pager
      .append($prev)
      .append($pageLabel)
      .append($next)
      .append($size)
      .append($info);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    enableColumnResize(document.querySelector(SELECTORS.usersTable));

    // Header click → toggle sort + reload from backend
    $(SELECTORS.usersTable + " thead th.sortable").on("click", function () {
      const key = $(this).data("key");
      if (!key) return;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      state.page = 0;
      reload();
    });

    // Search input (debounced) → reload from backend
    $(SELECTORS.adminUsersSearch).on("input", function () {
      state.search = $(this).val();
      state.page = 0;
      clearTimeout(state.searchDebounce);
      state.searchDebounce = setTimeout(reload, 250);
    });
  }

  return {
    reload,
  };
})();

function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user '${username}'?`)) {
    return;
  }

  $.ajax({
    url: ENDPOINTS.adminDeleteUser,
    method: "DELETE",
    contentType: "application/json",
    data: JSON.stringify({ username }),
    success: (res) => {
      alert(res);
      loadAllUsers();
    },
    error: (err) => {
      alert("Failed to delete user");
      console.error(err);
    },
  });
}

function revokeAllUserSessions() {
  if (!confirm("Revoke sessions for every user? This also logs you out.")) return;
  $.ajax({
    url: ENDPOINTS.adminLogoutAllSessions,
    method: "DELETE",
    success: () => { window.location.href = "/login?expired"; },
    error: () => alert("Failed to revoke all sessions."),
  });
}

function logoutUserFromAllDevices(username, successCallback) {
  $.ajax({
    url: ENDPOINTS.adminLogoutUserSession,
    method: "DELETE",
    contentType: "application/json",
    data: JSON.stringify({ username }),
    success: function () {
      if (typeof successCallback === "function") {
        successCallback();
      }
    },
    error: function (err) {
      alert("Failed to log out user from all devices");
      console.error(err);
    },
  });
}

// Add User Modal
function onAddUserSubmit(e) {
  e.preventDefault();

  const username = $(SELECTORS.addUsernameInput).val();
  if (!validateUsername(username)) {
    alert("Username cannot start or end with whitespace.");
    return;
  }

  const rawPassword = $(SELECTORS.addPasswordInput).val();
  const enabled = $(SELECTORS.addEnabledSelect).val() === "true";
  const hashedPassword = sha3_512(rawPassword);

  const payload = { username, password: hashedPassword, role: "USER", enabled };

  $.ajax({
    url: ENDPOINTS.adminRegisterUser,
    method: "POST",
    contentType: "application/json",
    data: JSON.stringify(payload),
    success: (res) => {
      alert(res);
      hideModal(SELECTORS.addUserModal);
      $(SELECTORS.addUserForm)[0].reset();
      loadAllUsers();
    },
    error: (err) => {
      alert("Failed to register user");
      console.error(err);
    },
  });
}

// Edit User Modal
function showEditUserModal(user) {
  $(SELECTORS.editUserOldUsername).val(user.username);
  $(SELECTORS.editUserNewUsername).val("");
  $(SELECTORS.editUserNewPassword).val("");
  $(SELECTORS.editUserEnabled).val(user.enabled ? "true" : "false");

  showModal(SELECTORS.editUserModal);
}

function onEditUserSubmit(e) {
  e.preventDefault();

  const newUsername = $(SELECTORS.editUserNewUsername).val();
  const oldUsername = $(SELECTORS.editUserOldUsername).val();
  const rawNewPassword = $(SELECTORS.editUserNewPassword).val();
  const enabled = $(SELECTORS.editUserEnabled).val() === "true";

  // 1) Log off any existing sessions
  logoutUserFromAllDevices(oldUsername, () => {
    // 2) Update user password if provided
    let passwordUpdatePromise = Promise.resolve();
    if (rawNewPassword) {
      const hashedPassword = sha3_512(rawNewPassword);
      passwordUpdatePromise = $.ajax({
        url: ENDPOINTS.adminUpdateUserPassword,
        method: "PUT",
        contentType: "application/json",
        data: JSON.stringify({
          username: oldUsername,
          newPassword: hashedPassword,
        }),
      });
    }

    passwordUpdatePromise
      .then(() => {
        // 3) Toggle user status (enable/disable)
        return $.ajax({
          url: ENDPOINTS.adminToggleUserStatus,
          method: "PUT",
          contentType: "application/json",
          data: JSON.stringify({
            username: oldUsername,
            enabled,
          }),
        });
      })
      .then(() => {
        // 4) Update the username if provided
        if (validateUsername(newUsername)) {
          return $.ajax({
            url: ENDPOINTS.adminUpdateUsername,
            method: "PUT",
            contentType: "application/json",
            data: JSON.stringify({
              oldUsername,
              newUsername,
            }),
          });
        }
      })
      .then(() => {
        alert("User updated successfully.");
        hideModal(SELECTORS.editUserModal);
        $(SELECTORS.editUserForm)[0].reset();
        loadAllUsers();
      })
      .catch((err) => {
        alert("Failed to update user. Check console for details.");
        console.error(err);
      });
  });
}
