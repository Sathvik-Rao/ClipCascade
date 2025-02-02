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
  usersTableBody: "#users-tbody",
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
  serverVersion: "/admin/server-version",
  latestServerVersion: "/admin/latest-server-version",
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
let CSRF_TOKEN = null;
let MAX_MESSAGE_SIZE = null; // in MiB
let CSRF_HEADER_NAME = "X-CSRF-TOKEN";

/* -----------------------------------------
         ============  ON DOCUMENT READY  =========
         ----------------------------------------- */
$(function () {
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

        // check for server updates
        fetchServerVersion()
          .then((serverVersion) => {
            fetchLatestServerVersion()
              .then((latestServerVersion) => {
                if (serverVersion.version !== latestServerVersion.server) {
                  $(SELECTORS.updateLink).text(
                    `🔄 Update (${serverVersion.version} ➞ ${latestServerVersion.server})`
                  );
                  showSection(SELECTORS.updateLink);
                }
              })
              .catch(() => {});
          })
          .catch(() => {});
      }

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
  $(SELECTORS.statusMessage).hide();
  if (CURRENT_MODE === "P2S") {
    connectStomp();
  } else {
    connectP2P();
  }
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
  if (CURRENT_MODE === "P2S") {
    disconnectStomp();
  } else {
    disconnectP2P();
  }
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
function connectStomp() {
  const brokerURL = $(SELECTORS.brokerUrlInput).val();
  stompClient = new StompJs.Client({
    brokerURL,
    heartbeatIncoming: 20000,
    heartbeatOutgoing: 0,
  });

  stompClient.onConnect = (frame) => {
    setStompConnected(true);
    showStatusMessage("Connected to WebSocket server (P2S).", "success");
    console.log("Connected (P2S): " + frame);

    // Subscribe to personal queue
    stompClient.subscribe(ENDPOINTS.websocketReceive, (res) => {
      displayIncomingMessage(JSON.parse(res.body));
    });
  };

  stompClient.onWebSocketError = (error) => {
    console.error("WebSocket error:", error);
    showStatusMessage("WebSocket error. Check console for details.", "danger");
  };

  stompClient.onStompError = (frame) => {
    console.error("STOMP error:", frame.headers["message"]);
    console.error("Details:", frame.body);
    showStatusMessage("STOMP error. Check console for details.", "danger");
  };

  stompClient.activate();
}

function disconnectStomp() {
  if (stompClient) {
    stompClient.deactivate();
    setStompConnected(false);
    showStatusMessage("Disconnected from WebSocket server (P2S).", "warning");
    console.log("Disconnected (P2S)");
  }
}

function sendTextToServerStomp(textVal) {
  if (!stompClient || !stompClient.connected) return;
  stompClient.publish({
    destination: ENDPOINTS.websocketSend,
    body: JSON.stringify({ payload: textVal, type: "text" }),
  });
}

function setStompConnected(connected) {
  $(SELECTORS.connectBtn).prop("disabled", connected);
  $(SELECTORS.disconnectBtn).prop("disabled", !connected);
  $(SELECTORS.conversationTable).toggle(connected);
  if (!connected) {
    $(SELECTORS.conversationBody).empty();
  }
}

/* -----------------------------------------
               ==========  P2P WEBRTC  ==========
               ----------------------------------------- */
function connectP2P() {
  const signalingUrl = $(SELECTORS.brokerUrlInput).val();
  if (!signalingUrl) {
    showStatusMessage("Signaling URL is required for P2P mode.", "danger");
    return;
  }

  // first fetch STUN url (async), then connect
  fetchStunUrl().then(() => {
    // WebSocket for signaling
    p2pSignalingWebSocket = new WebSocket(signalingUrl);

    p2pSignalingWebSocket.onopen = () => {
      setP2PConnected(true);
      showStatusMessage("Connected to Signaling server (P2P).", "success");
      // Start heartbeat(stay alive) every 20 seconds
      /*
       * heartbeatIntervalId = setInterval(() => {
       * if (
       * p2pSignalingWebSocket &&
       * p2pSignalingWebSocket.readyState === WebSocket.OPEN
       * ) {
       * p2pSignalingWebSocket.send("\n");
       * }
       * }, 20000);
       */
    };

    p2pSignalingWebSocket.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      handleSignalingMessage(data);
    };

    p2pSignalingWebSocket.onclose = () => {
      console.log("Signaling WebSocket closed (P2P).");
      showStatusMessage("Disconnected from Signaling server (P2P).", "warning");
    };

    p2pSignalingWebSocket.onerror = (err) => {
      console.error("Signaling WebSocket error:", err);
      showStatusMessage("Signaling error (P2P). Check console.", "danger");
    };
  });
}

function disconnectP2P() {
  if (p2pSignalingWebSocket) {
    p2pSignalingWebSocket.close();
    p2pSignalingWebSocket = null;
  }
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  for (const peerId in peerConnections) {
    peerConnections[peerId].close();
  }
  peerConnections = {};
  dataChannels = {};
  myPeerId = null;

  // Only on explicit user disconnect do we hide/clear the conversation:
  setP2PConnected(false);
  showStatusMessage("Disconnected from P2P mesh.", "warning");
}

function setP2PConnected(connected) {
  $(SELECTORS.connectBtn).prop("disabled", connected);
  $(SELECTORS.disconnectBtn).prop("disabled", !connected);
  $(SELECTORS.conversationTable).toggle(connected);
  if (!connected) {
    $(SELECTORS.conversationBody).empty();
  }
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
  $.ajax({
    url: ENDPOINTS.adminUsers,
    method: "GET",
    success: (data) => {
      populateUsersTable(data);
    },
    error: (err) => {
      alert("Failed to load users");
      console.error(err);
    },
  });
}

function populateUsersTable(users) {
  const tbody = $(SELECTORS.usersTableBody);
  tbody.empty();
  if (!Array.isArray(users)) return;

  users.forEach((user) => {
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

    actionTd.append(editBtn).append(deleteBtn);
    row.append(actionTd);
    tbody.append(row);
  });
}

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
