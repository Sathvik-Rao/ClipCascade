$(function () {
  $("form").on("submit", (e) => e.preventDefault());
  $("#connect").click(connect);
  $("#disconnect").click(disconnect);
  $("#send").click(sendText);
  $("#logout").click(logout);

  // Auto-populate WebSocket URL based on current page URL
  const currentUrl = window.location.href;
  const urlParts = currentUrl.split("/");
  const protocol = currentUrl.startsWith("https://") ? "wss" : "ws";
  const domain = urlParts[2];
  const defaultWsUrl = `${protocol}://${domain}/clipsocket`;

  $("#broker-url").val(defaultWsUrl);
});

let stompClient;

function connect() {
  const brokerURL = $("#broker-url").val();

  stompClient = new StompJs.Client({
    brokerURL: brokerURL,
  });

  stompClient.onConnect = (frame) => {
    setConnected(true);
    console.log("Connected: " + frame);
    showStatusMessage("Connected to WebSocket server.", "success");
    stompClient.subscribe("/topic/cliptext", (res) => {
      showMessage(JSON.parse(res.body));
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

function disconnect() {
  if (stompClient) {
    stompClient.deactivate();
    setConnected(false);
    showStatusMessage("Disconnected from WebSocket server.", "warning");
    console.log("Disconnected");
  }
}

function sendText() {
  if (stompClient && stompClient.connected) {
    stompClient.publish({
      destination: "/app/cliptext",
      body: JSON.stringify({ text: $("#ws_text").val() }),
    });
  }
}

function logout() {
  const brokerURL = $("#broker-url").val();
  const baseUrl = brokerURL.split("/")[2];
  const logoutUrl = `http://${baseUrl}/logout`;

  window.location.href = logoutUrl;
}

function setConnected(connected) {
  $("#connect").prop("disabled", connected);
  $("#disconnect").prop("disabled", !connected);
  $("#conversation").toggle(connected);
  $("#channel").empty();
}

function base64EncodeUnicode(str) {
  // Encode the string as UTF-8 bytes
  const utf8Bytes = new TextEncoder().encode(str);

  // Convert the Uint8Array of UTF-8 bytes into a binary string
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }

  return btoa(binary);
}

function showMessage(message) {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const filename = `${timestamp}.txt`;
  const encodedText = base64EncodeUnicode(message.text);

  const row = $(`
          <tr>
              <td>{text:${escapeHtml(message.text)}, type:${escapeHtml(
    message.type
  )}}</td>
              <td>
              <div class="button-container">
                <button class="btn btn-primary download-btn" onclick="downloadFile('${escapeHtml(
                  filename
                )}', '${escapeHtml(encodedText)}')">Download</button>
                <button class="btn btn-secondary copy-btn" onclick="copyToClipboard('${escapeHtml(
                  message.text
                )}')">Copy</button>
              </div>
              </td>
          </tr>
      `);

  $("#channel").append(row);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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

function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      console.log("Text copied to clipboard.");
    })
    .catch((err) => {
      console.error("Could not copy text: ", err);
      alert("Failed to copy to clipboard.");
    });
}

function showStatusMessage(message, type) {
  const statusMessage = $("#status-message");
  statusMessage
    .removeClass("alert-success alert-danger alert-warning")
    .addClass(`alert-${type}`)
    .text(message)
    .show();
}
