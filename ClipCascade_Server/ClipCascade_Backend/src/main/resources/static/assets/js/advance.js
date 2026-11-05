function initAdvancedNavigation() {
  const hash = "#advanced";
  const link = document.getElementById("advance-link");
  const back = document.getElementById("advanced-back");
  const dashboard = document.getElementById("dashboard-view");
  const advanced = document.getElementById("advanced-view");
  const tools = document.getElementById("advanced-tools");
  const status = document.getElementById("advanced-status");
  const menu = document.getElementById("navigation-toggle");
  let loading = false;
  let loaded = false;

  async function loadTools() {
    if (loading || loaded) return;
    loading = true;
    status.textContent = "Loading Advanced tools…";
    try {
      const response = await fetch("/admin/advance/fragment", { redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      tools.innerHTML = await response.text();
      initializeAdvancedTools(tools);
      loaded = true;
      status.textContent = "";
    } catch (error) {
      console.error("Failed to load Advanced tools:", error);
      tools.replaceChildren();
      status.textContent = "Could not load Advanced tools. Select Advanced to try again.";
    } finally {
      loading = false;
    }
  }

  function renderView() {
    if (location.hash === hash) {
      dashboard.hidden = true;
      advanced.hidden = false;
      menu.setAttribute("aria-expanded", "false");
      document.getElementById("account-navigation").classList.remove("is-open");
      document.getElementById("advanced-title").focus({ preventScroll: true });
      window.scrollTo(0, 0);
      loadTools();
    } else if (!advanced.hidden) {
      advanced.hidden = true;
      dashboard.hidden = false;
      const focusTarget = link.getClientRects().length ? link : menu;
      focusTarget.focus({ preventScroll: true });
    }
  }

  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.hash !== hash) {
      history.pushState({ fromDashboard: true }, "", hash);
    }
    renderView();
  });

  back.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (history.state?.fromDashboard) {
      history.back();
    } else {
      history.replaceState(null, "", location.pathname + location.search);
      renderView();
    }
  });

  window.addEventListener("hashchange", renderView);
  renderView();
}

function initializeAdvancedTools(section) {
  /**
   * Constants for the API endpoints
   */
  const ENDPOINTS = {
    USER_DETAILS_PAGE: "/admin/user-details/page",
    WEBSOCKET_STATS: "/admin/websocket-stats",
    ONLINE_USERS: "/admin/online-users",
    ONLINE_USERS_PAGE: "/admin/online-users/page",
    BFA_SNAPSHOT_PAGE: "/admin/bfa-snapshot/page",
    BFA_SNAPSHOT_FILE: "/admin/bfa-snapshot-file",
    UNLOCK_USER: "/admin/unlock-user",
    SERVER_TIME: "/admin/server-time",
  };

  /**
   * Generic fetch helper with basic error checking.
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
   * Format epoch (seconds) to a human-readable, locale-specific string.
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
   * Calls a paged admin endpoint and returns the PageResponse JSON.
   * Backend treats size <= 0 as "all rows" and accepts 0-based page index.
   */
  async function fetchPage(url, params) {
    const qs = new URLSearchParams();
    if (params.page != null) qs.set("page", String(params.page));
    if (params.size != null) qs.set("size", String(params.size));
    if (params.sort) qs.set("sort", params.sort);
    if (params.direction) qs.set("direction", params.direction);
    if (params.search) qs.set("search", params.search);
    const res = await fetchData(`${url}?${qs.toString()}`);
    return await res.json();
  }

  /**
   * Generic data-table controller backed by a server endpoint.
   * The endpoint owns sort/filter/paginate; this just renders the page
   * it returns and forwards user actions (sort click, search, page nav,
   * page-size change) back as fresh requests.
   */
  function createDataTable(opts) {
    const tableEl = document.querySelector(
      `table[data-table-id="${opts.tableId}"]`
    );
    const tbody = document.getElementById(opts.tbodyId);
    const searchEl = document.getElementById(opts.searchId);
    const pagerEl = document.getElementById(opts.pagerId);

    const state = {
      content: [],
      totalElements: 0,
      totalPages: 1,
      page: 0, // 0-based to match backend
      pageSize: 10, // -1 means "All"
      sortKey: opts.defaultSortKey || null,
      sortDir: opts.defaultSortDir || "asc",
      search: "",
    };

    async function reload() {
      if (!opts.fetcher) return;
      try {
        const data = await opts.fetcher({
          page: state.page,
          size: state.pageSize,
          sort: state.sortKey,
          direction: state.sortDir,
          search: state.search,
        });
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
      } catch (err) {
        console.error(err);
        if (opts.onError) opts.onError(err);
      }
    }

    function render() {
      tbody.innerHTML = "";
      state.content.forEach((row) => {
        const tr = document.createElement("tr");
        opts.columns.forEach((col) => {
          const td = document.createElement("td");
          let v = row[col.key];
          if (col.type === "date") {
            v = v ? formatEpochToLocal(v) : "";
          } else if (col.type === "bool") {
            v = v === true ? "Enabled" : v === false ? "Disabled" : "";
          } else if (v == null) {
            v = "";
          }
          td.textContent = v;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      // Header sort indicators
      tableEl.querySelectorAll("thead th[data-key]").forEach((h) => {
        h.classList.remove("sort-asc", "sort-desc");
        if (h.dataset.key === state.sortKey) {
          h.classList.add(
            state.sortDir === "asc" ? "sort-asc" : "sort-desc"
          );
        }
      });

      // Pager
      pagerEl.innerHTML = "";
      const total = state.totalElements;
      const usingAll = state.pageSize <= 0;
      const lo =
        total === 0
          ? 0
          : usingAll
          ? 1
          : state.page * state.pageSize + 1;
      const hi = usingAll
        ? total
        : Math.min((state.page + 1) * state.pageSize, total);

      const prev = document.createElement("button");
      prev.className = "btn btn-default btn-sm";
      prev.textContent = "Prev";
      prev.disabled = usingAll || state.page <= 0;
      prev.onclick = () => {
        state.page = Math.max(0, state.page - 1);
        reload();
      };

      const next = document.createElement("button");
      next.className = "btn btn-default btn-sm";
      next.textContent = "Next";
      next.disabled = usingAll || state.page >= state.totalPages - 1;
      next.onclick = () => {
        state.page = Math.min(state.totalPages - 1, state.page + 1);
        reload();
      };

      const pageLabel = document.createElement("span");
      pageLabel.className = "page-info";
      pageLabel.textContent = `Page ${state.page + 1} / ${state.totalPages}`;

      const sizeSel = document.createElement("select");
      sizeSel.className = "form-control input-sm";
      sizeSel.setAttribute("aria-label", "Rows per page");
      const sizeOptions = [
        { value: 10, label: "10 / page" },
        { value: 25, label: "25 / page" },
        { value: 50, label: "50 / page" },
        { value: 100, label: "100 / page" },
        { value: -1, label: "All" },
      ];
      sizeOptions.forEach(({ value, label }) => {
        const o = document.createElement("option");
        o.value = String(value);
        o.textContent = label;
        if (value === state.pageSize) o.selected = true;
        sizeSel.appendChild(o);
      });
      sizeSel.onchange = (e) => {
        state.pageSize = Number(e.target.value);
        state.page = 0;
        reload();
      };

      const info = document.createElement("span");
      info.className = "page-info";
      info.textContent = `${lo}-${hi} of ${total}`;

      pagerEl.appendChild(prev);
      pagerEl.appendChild(pageLabel);
      pagerEl.appendChild(next);
      pagerEl.appendChild(sizeSel);
      pagerEl.appendChild(info);
    }

    enableColumnResize(tableEl);

    // Header click → toggle sort + reload from backend
    tableEl.querySelectorAll("thead th[data-key]").forEach((h) => {
      if (h.dataset.sortable === "false") return;
      h.addEventListener("click", () => {
        const key = h.dataset.key;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDir = "asc";
        }
        state.page = 0;
        reload();
      });
    });

    // Search input (debounced) → reload from backend
    if (searchEl) {
      let timer = null;
      searchEl.addEventListener("input", (e) => {
        state.search = e.target.value;
        state.page = 0;
        clearTimeout(timer);
        timer = setTimeout(reload, 250);
      });
    }

    // Render empty pager so the UI shows the controls before the first fetch
    render();

    return {
      reload,
    };
  }

  // --- Table instances (server-driven sort/filter/paginate) ---
  const userDetailsTable = createDataTable({
    tableId: "userDetails",
    tbodyId: "user-details-tbody",
    searchId: "user-details-search",
    pagerId: "user-details-pager",
    columns: [
      { key: "username" },
      { key: "enabled", type: "bool" },
      { key: "markedForDeletion" },
      { key: "firstSignup", type: "date" },
      { key: "lastLogin", type: "date" },
      { key: "firstSignupIp" },
      { key: "lastLoginIp" },
      { key: "failedLoginAttempts", type: "number" },
      { key: "lockoutTime" },
      { key: "passwordChangedAt", type: "date" },
      { key: "email" },
      { key: "otp" },
      { key: "phone" },
      { key: "firstName" },
      { key: "lastName" },
      { key: "notes" },
    ],
    defaultSortKey: "lastLogin",
    defaultSortDir: "desc",
    fetcher: (params) => fetchPage(ENDPOINTS.USER_DETAILS_PAGE, params),
    onError: () => alert("Error fetching user details."),
  });

  const onlineUsersTable = createDataTable({
    tableId: "onlineUsers",
    tbodyId: "online-users-tbody",
    searchId: "online-users-search",
    pagerId: "online-users-pager",
    columns: [{ key: "username" }, { key: "connections", type: "number" }],
    defaultSortKey: "connections",
    defaultSortDir: "desc",
    fetcher: (params) => fetchPage(ENDPOINTS.ONLINE_USERS_PAGE, params),
    onError: () => alert("Error fetching online users."),
  });

  const bfaSnapshotTable = createDataTable({
    tableId: "bfaSnapshot",
    tbodyId: "bfa-snapshot-tbody",
    searchId: "bfa-snapshot-search",
    pagerId: "bfa-snapshot-pager",
    columns: [
      { key: "username" },
      { key: "sourceIp" },
      { key: "attempts", type: "number" },
      { key: "lockCount", type: "number" },
      { key: "lockTimeout", type: "date" },
      { key: "uniqueIpCount", type: "number" },
      { key: "userLockTimeout", type: "date" },
    ],
    defaultSortKey: "username",
    defaultSortDir: "asc",
    fetcher: (params) => fetchPage(ENDPOINTS.BFA_SNAPSHOT_PAGE, params),
    onError: () => alert("Error fetching BFA tracker data."),
  });

  /**
   * 1) User details — reload the current backend page
   */
  function getUserDetails() {
    return userDetailsTable.reload();
  }

  /**
   * 2) WebSocket stats
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
   * 3) Online users — refresh both the table (paged) and the
   *    "N user(s), M connection(s)" summary (computed over the full
   *    map via the legacy unpaged endpoint, since the summary needs
   *    the total connection count, not just the current page).
   */
  async function getOnlineUsers() {
    try {
      const response = await fetchData(ENDPOINTS.ONLINE_USERS);
      const data = await response.json();
      const totalUsers = Object.keys(data || {}).length;
      const totalConnections = Object.values(data || {}).reduce(
        (sum, n) => sum + (Number(n) || 0),
        0
      );
      document.getElementById(
        "online-users-summary"
      ).textContent = `${totalUsers} user(s), ${totalConnections} connection(s)`;
    } catch (err) {
      console.error(err);
    }
    return onlineUsersTable.reload();
  }

  /**
   * 4) BFA tracker — reload the current backend page (flattening is
   *    now done server-side).
   */
  function getBfaTracker() {
    return bfaSnapshotTable.reload();
  }

  /**
   * Download BFA snapshot
   */
  async function downloadBfaSnapshot() {
    try {
      const response = await fetchData(ENDPOINTS.BFA_SNAPSHOT_FILE);
      const blob = await response.blob();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `brute_force_tracker_snapshot_${timestamp}.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      alert("Snapshot downloaded successfully!");
    } catch (error) {
      console.error("Error downloading snapshot:", error);
      alert("Error downloading snapshot.");
    }
  }

  /**
   * Unlock user
   */
  async function unlockUser(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const username = formData.get("username").trim();
    const csrfToken = formData.get("_csrf");
    if (!username) {
      alert("Please enter a username to unlock.");
      return;
    }
    try {
      await fetchData(
        ENDPOINTS.UNLOCK_USER,
        "PUT",
        { username },
        { "X-CSRF-TOKEN": csrfToken }
      );
      alert("User unlocked successfully!");
    } catch (error) {
      console.error("Error unlocking user:", error);
      alert("Error unlocking user.");
    }
  }

  /**
   * Server time
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

  const actions = {
    getUserDetails,
    getWebsocketStats,
    getOnlineUsers,
    getBfaTracker,
    downloadBfaSnapshot,
    showServerTime,
  };
  section.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", actions[button.dataset.action]);
  });
  section.querySelector("#unlock-user-form").addEventListener("submit", unlockUser);

  getUserDetails();
  getWebsocketStats();
  getOnlineUsers();
  getBfaTracker();
  showServerTime();
}
