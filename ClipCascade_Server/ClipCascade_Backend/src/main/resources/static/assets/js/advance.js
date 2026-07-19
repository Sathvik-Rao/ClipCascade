
      /**
       * Constants for the API endpoints
       */
      const ENDPOINTS = {
        USER_DETAILS: "/admin/user-details",
        WEBSOCKET_STATS: "/admin/websocket-stats",
        BFA_SNAPSHOT: "/admin/bfa-snapshot",
        BFA_SNAPSHOT_FILE: "/admin/bfa-snapshot-file",
        UNLOCK_USER: "/admin/unlock-user",
        SERVER_TIME: "/admin/server-time",
      };

      /**
       * A reusable fetch function that handles basic error checking.
       *
       * @param {string} url - The URL endpoint to call.
       * @param {string} [method='GET'] - The HTTP method, default is GET.
       * @param {Object|null} [body=null] - The request body, if any.
       * @returns {Promise<Response>} - The fetch response object.
       */
      async function fetchData(url, method = "GET", body = null, headers = {}) {
        try {
          const options = { method, headers: { ...headers } };
          if (body) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
          }
          const response = await fetch(url, options);
          if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
          }
          return response;
        } catch (error) {
          console.error("Fetch error:", error);
          throw error;
        }
      }

      /**
       * Format an epoch time in seconds to a human-readable, locale-specific
       * string in the format "YYYY MMM DD HH:MM:SS AM/PM TZ".
       *
       * @param {number} epoch - The epoch time in seconds.
       * @returns {string} - The formatted string, empty if the input is null or 0.
       */
      function formatEpochToLocal(epoch) {
        if (epoch == null || epoch === 0) return "";
        const date = new Date(epoch * 1000);
        const year = date.getFullYear();
        const month = date.toLocaleString(undefined, { month: "short" });
        const day = String(date.getDate()).padStart(2, "0");
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12 || 12;
        const hour12 = String(hours).padStart(2, "0");
        const tzMatch = date.toTimeString().match(/\(([A-Za-z\s]+)\)$/);
        const tz = tzMatch
          ? tzMatch[1]
              .split(" ")
              .map((w) => w[0])
              .join("")
          : "";
        return `${year} ${month} ${day} ${hour12}:${minutes}:${seconds} ${ampm} ${tz}`;
      }

      /**
       * 1) Fetch and display user details.
       */
      async function getUserDetails() {
        try {
          const response = await fetchData(ENDPOINTS.USER_DETAILS);
          const data = await response.json();
          const tbody = document.getElementById("user-details-tbody");
          tbody.innerHTML = "";

          const dateKeys = ["firstSignup", "lastLogin", "passwordChangedAt"];
          data.forEach((user) => {
            const row = document.createElement("tr");
            Object.keys(user).forEach((key) => {
              const cell = document.createElement("td");
              let text = user[key];
              if (dateKeys.includes(key)) {
                text = formatEpochToLocal(user[key]);
              }
              cell.textContent = text ?? "";
              row.appendChild(cell);
            });
            tbody.appendChild(row);
          });
        } catch (err) {
          console.error(err);
          alert("Error fetching user details.");
        }
      }

      /**
       * 2) Fetch and display WebSocket stats.
       */
      async function getWebsocketStats() {
        try {
          const response = await fetchData(ENDPOINTS.WEBSOCKET_STATS);
          const textData = await response.text();
          document.getElementById("websocket-stats-output").textContent =
            textData;
        } catch (error) {
          console.error("Error fetching WebSocket stats:", error);
          alert("Error fetching WebSocket stats.");
        }
      }

      /**
       * 3a) Fetch Brute Force Protection Tracker data (JSON) and populate table.
       */
      async function getBfaTracker() {
        try {
          const response = await fetchData(ENDPOINTS.BFA_SNAPSHOT);
          const trackerData = await response.json();
          const tbody = document.getElementById("bfa-snapshot-tbody");
          tbody.innerHTML = "";

          for (const [username, tracker] of Object.entries(trackerData)) {
            for (const [ip, details] of Object.entries(
              tracker.ipAccessDetails || {}
            )) {
              const row = document.createElement("tr");

              // Username
              row.appendChild(
                Object.assign(document.createElement("td"), {
                  textContent: username,
                })
              );
              // IP
              row.appendChild(
                Object.assign(document.createElement("td"), { textContent: ip })
              );
              // Attempts & lock count
              row.appendChild(
                Object.assign(document.createElement("td"), {
                  textContent: details.attempts,
                })
              );
              row.appendChild(
                Object.assign(document.createElement("td"), {
                  textContent: details.lockCount,
                })
              );

              // Lock timeout (epoch → formatted)
              const lockTd = document.createElement("td");
              lockTd.textContent = formatEpochToLocal(details.lockTimeout);
              row.appendChild(lockTd);

              // Unique IPs & user lock timeout
              row.appendChild(
                Object.assign(document.createElement("td"), {
                  textContent: (tracker.uniqueIpSet || []).length,
                })
              );
              const userLockTd = document.createElement("td");
              userLockTd.textContent = formatEpochToLocal(tracker.lockTimeout);
              row.appendChild(userLockTd);

              tbody.appendChild(row);
            }
          }
        } catch (err) {
          console.error(err);
          alert("Error fetching BFA tracker data.");
        }
      }

      /**
       * 3b) Download Brute Force Protection Tracker Snapshot (as file).
       */
      async function downloadBfaSnapshot() {
        try {
          const response = await fetchData(ENDPOINTS.BFA_SNAPSHOT_FILE);
          const blob = await response.blob();

          // Generate a timestamp-based filename
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const fileName = `brute_force_tracker_snapshot_${timestamp}.json`;

          // Create a link to download the file
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = fileName;
          link.click();

          // Cleanup
          URL.revokeObjectURL(url);
          alert("Snapshot downloaded successfully!");
        } catch (error) {
          console.error("Error downloading snapshot:", error);
          alert("Error downloading snapshot.");
        }
      }

      /**
       * 4) Unlock user based on form submission.
       */
      async function unlockUser(event) {
        event.preventDefault(); // Prevent default form submission

        const form = document.getElementById("unlock-user-form");
        const formData = new FormData(form); // Get form data

        const username = formData.get("username").trim(); // Retrieve the username
        const csrfToken = formData.get("_csrf"); // Retrieve the CSRF token

        if (!username) {
          alert("Please enter a username to unlock.");
          return;
        }

        try {
          // PUT request to unlock the user
          await fetchData(
            ENDPOINTS.UNLOCK_USER,
            "PUT",
            { username },
            {
              "X-CSRF-TOKEN": csrfToken,
            }
          );
          alert("User unlocked successfully!");
        } catch (error) {
          console.error("Error unlocking user:", error);
          alert("Error unlocking user.");
        }
      }

      /**
       * 5) Fetch and show server time.
       */
      async function showServerTime() {
        try {
          const response = await fetchData(ENDPOINTS.SERVER_TIME);
          const serverTime = await response.text();
          document.getElementById("server-time-output").textContent =
            serverTime;
        } catch (error) {
          console.error("Error fetching server time:", error);
          alert("Error fetching server time.");
        }
      }
    

      // Once the DOM is ready, fetch all the admin data
      document.addEventListener("DOMContentLoaded", () => {
        getUserDetails();
        getWebsocketStats();
        getBfaTracker();
        showServerTime();
      });
    

document.addEventListener('DOMContentLoaded', function () {
  var map = {
    'btn-get-user-details': typeof getUserDetails === 'function' ? getUserDetails : null,
    'btn-get-websocket-stats': typeof getWebsocketStats === 'function' ? getWebsocketStats : null,
    'btn-get-bfa-tracker': typeof getBfaTracker === 'function' ? getBfaTracker : null,
    'btn-download-bfa-snapshot': typeof downloadBfaSnapshot === 'function' ? downloadBfaSnapshot : null,
    'btn-show-server-time': typeof showServerTime === 'function' ? showServerTime : null,
  };
  Object.keys(map).forEach(function (id) {
    var el = document.getElementById(id);
    if (el && map[id]) el.addEventListener('click', map[id]);
  });
  var unlockForm = document.getElementById('unlock-user-form');
  if (unlockForm && typeof unlockUser === 'function') {
    unlockForm.addEventListener('submit', unlockUser);
  }
});
