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
  changeUsernameLink: "#change-username-link",
  changePasswordLink: "#change-password-link",
  logoutLink: "#logout-link",
  logoutAllDevicesLink: "#logout-all-devices-link",
  maxMessageSize: "#max-message-size",
  user: "#user-name",

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
};

let stompClient = null;
let CSRF_TOKEN = null;
let MAX_MESSAGE_SIZE = null; // in MiB
let CSRF_HEADER_NAME = "X-CSRF-TOKEN";

/* -----------------------------------------
         ==========  ON DOCUMENT READY  ===========
         ----------------------------------------- */
$(function () {
  // Prevent form submissions from reloading the page
  $("form").on("submit", (e) => e.preventDefault());

  // Step 1: Fetch CSRF token from server
  fetchCsrfToken()
    // Step 2: Fetch maximum message size
    .then(fetchMaxMessageSize)
    // Step 3: Then fetch user info
    .then(fetchCurrentUser)
    // Step 4: Then initialize the page based on user role
    .then((userData) => {
      // Always show the user section
      showSection(SELECTORS.userSection);

      // Set the username in the Navbar
      $(SELECTORS.user).text(userData.username);

      // If user is Admin, show Admin Section and change username button
      if (userData.role === "ADMIN") {
        showSection(SELECTORS.changeUsernameLink);
        showSection(SELECTORS.adminSection);
      }

      // Initialize event handlers
      initEventHandlers();
      // Auto-populate the WebSocket URL
      autoPopulateWebSocketURL();
    })
    .catch((err) => {
      console.error("Failed to initialize page:", err);
    });
});

/* -----------------------------------------
               ============  FETCH CURRENT USER  ========
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

/* -----------------------------------------
               ==========  INIT EVENT HANDLERS  =========
               ----------------------------------------- */
function initEventHandlers() {
  // HOME (User) Section event bindings
  $(SELECTORS.connectBtn).click(connectWebSocket);
  $(SELECTORS.disconnectBtn).click(disconnectWebSocket);
  $(SELECTORS.sendBtn).click(sendTextToServer);

  // Header links
  $(SELECTORS.changeUsernameLink).click(onChangeUsernameClick);
  $(SELECTORS.changePasswordLink).click(onChangePasswordClick);
  $(SELECTORS.logoutLink).click(onLogoutClick);
  $(SELECTORS.logoutAllDevicesLink).click(onLogoutAllDevicesClick);

  // Admin Section event bindings
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
               ===========  UTILITY FUNCTIONS  ==========
               ----------------------------------------- */

/**
 * Reusable function for showing any HTML section by selector.
 */
function showSection(selector) {
  $(selector).css("display", "block");
}

/**
 * Reusable function for hiding any HTML section by selector.
 */
function hideSection(selector) {
  $(selector).css("display", "none");
}

/**
 * Show a status message in the UI with a given Bootstrap alert type.
 */
function showStatusMessage(message, type) {
  // type can be 'success', 'danger', 'warning', 'info'
  const statusMessageElem = $(SELECTORS.statusMessage);
  statusMessageElem
    .removeClass("alert-success alert-danger alert-warning alert-info")
    .addClass(`alert alert-${type}`)
    .text(message)
    .show();
}

/** Hide status message. */
function hideStatusMessage() {
  $(SELECTORS.statusMessage).hide();
}

/** Basic HTML escaping to prevent XSS in appended text. */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Enable or disable connect/disconnect buttons and clear conversation.
 */
function setConnected(connected) {
  $(SELECTORS.connectBtn).prop("disabled", connected);
  $(SELECTORS.disconnectBtn).prop("disabled", !connected);
  $(SELECTORS.conversationTable).toggle(connected);
  $(SELECTORS.conversationBody).empty();
}

/**
 * Auto-populate the default WebSocket URL based on current protocol/domain.
 */
function autoPopulateWebSocketURL() {
  const currentUrl = window.location.href;
  const urlParts = currentUrl.split("/");
  const protocol = currentUrl.startsWith("https://") ? "wss" : "ws";
  const domain = urlParts[2];
  const defaultWsUrl = `${protocol}://${domain}/clipsocket`;
  $(SELECTORS.brokerUrlInput).val(defaultWsUrl);
}

/**
 * Convert a unicode string to base64 (e.g. for emojis or non-Latin chars).
 */
function base64EncodeUnicode(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary);
}

/**
 * Trigger a download of the given base64 text content as a .txt file.
 */
function downloadFile(filename, content) {
  const blob = new Blob([atob(content)], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Copy text to the clipboard. */
function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => console.log("Text copied to clipboard."))
    .catch((err) => {
      console.error("Could not copy text: ", err);
      alert("Failed to copy to clipboard.");
    });
}

/**
 * Show a modal (e.g. Add User Modal, Edit User Modal) by setting display:flex.
 */
function showModal(modalSelector) {
  $(modalSelector).css("display", "flex");
}

/**
 * Hide a modal by setting display:none.
 */
function hideModal(modalSelector) {
  $(modalSelector).css("display", "none");
}

/**
 * Hide Add User Modal.
 */
function hideAddUserModal() {
  hideModal(SELECTORS.addUserModal);
}

/**
 * Hide Edit User Modal.
 */
function hideEditUserModal() {
  hideModal(SELECTORS.editUserModal);
}

/**
 * Validate that username is not empty and does not start/end with whitespace.
 */
function validateUsername(username) {
  return (
    username &&
    username.length > 0 &&
    !username.startsWith(" ") &&
    !username.endsWith(" ")
  );
}

/* -----------------------------------------
               =========  CSRF TOKEN FUNCTIONS  =========
               ----------------------------------------- */
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

/* -----------------------------------------
               ============  FETCH MAX MESSAGE SIZE  =====
               ----------------------------------------- */
function fetchMaxMessageSize() {
  return new Promise((resolve, reject) => {
    $.ajax({
      url: ENDPOINTS.maxMessageSize,
      method: "GET",
      success: (data) => {
        // The server should return something like { "maxmessagesize": 10 }
        MAX_MESSAGE_SIZE = data.maxmessagesize;

        // Update the Max Message Size in the Navbar
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
  });
}

/* -----------------------------------------
               ==========  WEBSOCKET FUNCTIONS  =========
               ----------------------------------------- */
function connectWebSocket() {
  const brokerURL = $(SELECTORS.brokerUrlInput).val();
  stompClient = new StompJs.Client({ brokerURL });

  stompClient.onConnect = (frame) => {
    setConnected(true);
    showStatusMessage("Connected to WebSocket server.", "success");
    console.log("Connected: " + frame);

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

function disconnectWebSocket() {
  if (stompClient) {
    stompClient.deactivate();
    setConnected(false);
    showStatusMessage("Disconnected from WebSocket server.", "warning");
    console.log("Disconnected");
  }
}

function sendTextToServer() {
  if (!stompClient || !stompClient.connected) return;
  const textVal = $("#ws_text").val() || "";
  stompClient.publish({
    destination: ENDPOINTS.websocketSend,
    body: JSON.stringify({ payload: textVal }),
  });
}

function displayIncomingMessage(message) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const filename = `${timestamp}.txt`;
  const encodedText = base64EncodeUnicode(message.payload);
  const type = message.type ? escapeHtml(message.type) : "text";
  const payload = escapeHtml(message.payload);

  const row = $(`
          <tr>
            <td>{payload:${payload}, type:${type}}</td>
            <td>
              <div class="button-container">
                <button class="btn btn-primary download-btn"
                        onclick="downloadFile('${filename}', '${encodedText}')">Download</button>
                <button class="btn btn-default copy-btn"
                        onclick="copyToClipboard('${payload}')">Copy</button>
              </div>
            </td>
          </tr>
        `);

  $(SELECTORS.conversationBody).append(row);
}

/* -----------------------------------------
               ==========  HEADER LINK HANDLERS  ========
               ----------------------------------------- */
function onChangeUsernameClick() {
  const oldUsername = $(SELECTORS.user).text();
  const newUsername = prompt("Enter your new username:");

  if (!validateUsername(newUsername)) {
    alert("Username cannot be empty and cannot start or end with whitespace.");
    return;
  }

  // Update username
  $.ajax({
    url: ENDPOINTS.adminUpdateUsername,
    method: "PUT",
    contentType: "application/json",
    data: JSON.stringify({
      oldUsername,
      newUsername,
    }),
    success: () => {
      alert(
        "Username updated successfully. You will be logged out from all devices."
      );
      // Navigate to the login page
      window.location.href = "/login?expired";
    },
    error: (err) => {
      console.error("Failed to update username:", err);
      alert("Error: Unable to update your username.");
    },
  });
}

function onChangePasswordClick() {
  // Example: prompt user for new password
  const newPassword = prompt("Enter your new password:");
  if (!newPassword) {
    alert("Password cannot be empty.");
    return;
  }

  // 1) Hash the new password with SHA3-512 (assuming sha3_512 is globally available)
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
  // Could do a standard form submission or just navigate
  window.location.href = ENDPOINTS.logout;
}

function onLogoutAllDevicesClick() {
  logoutAllDevices(() => {
    window.location.href = "/login?expired";
  });
}

/**
 * A reusable function to log out from *all* devices.
 * Accepts a callback on success to handle post-logout flow.
 */
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
      alert("Failed to log off from all devices. Check console for details.");
    },
  });
}

/* -----------------------------------------
              ============  ADMIN FUNCTIONS  ===========
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

  if (!users || !Array.isArray(users)) {
    return;
  }

  users.forEach((user) => {
    const row = $("<tr></tr>");
    row.append($("<td></td>").text(user.username));
    row.append($("<td></td>").text(user.enabled ? "Enabled" : "Disabled"));

    const actionTd = $("<td></td>");
    // Edit button
    const editBtn = $("<button class='btn btn-primary btn-sm'>Edit</button>");
    editBtn.click(() => showEditUserModal(user));

    // Delete button
    const deleteBtn = $(
      "<button class='btn btn-danger btn-sm' style='margin-left:5px;'>Delete</button>"
    );
    deleteBtn.click(() => deleteUser(user.username));

    actionTd.append(editBtn).append(deleteBtn);
    row.append(actionTd);

    tbody.append(row);
  });
}

/**
 * 1) Log out user from all devices
 * 2) Then delete the user
 */
function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user '${username}'?`)) {
    return;
  }
  logoutUserFromAllDevices(username, () => {
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
  });
}

/**
 * Helper to log out a *specific user* from all devices in the admin panel.
 */
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

/* -- Add User Modal -- */
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

/* -- Edit User Modal -- */
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
        // 5) Refresh UI & notify
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
