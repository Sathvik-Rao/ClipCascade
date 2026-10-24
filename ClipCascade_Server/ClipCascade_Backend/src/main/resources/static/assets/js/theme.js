(function () {
  "use strict";

  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;

  function applyTheme(dark) {
    root.setAttribute("data-bs-theme", dark ? "dark" : "light");
    root.style.colorScheme = dark ? "dark" : "light";
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      toggle.setAttribute("aria-checked", String(dark));
      toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  // Start fresh from the browser/OS preference on every page load.
  applyTheme(systemTheme.matches);
  function followSystem(event) {
    applyTheme(event.matches);
  }
  if (systemTheme.addEventListener) {
    systemTheme.addEventListener("change", followSystem);
  } else {
    systemTheme.addListener(followSystem);
  }

  document.addEventListener("DOMContentLoaded", function () {
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      toggle.addEventListener("click", function () {
        applyTheme(root.getAttribute("data-bs-theme") !== "dark");
      });
    }
    applyTheme(root.getAttribute("data-bs-theme") === "dark");
  });
})();
