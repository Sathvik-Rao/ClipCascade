(function () {
  "use strict";

  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const storageKey = "clipcascade-theme";
  let savedTheme = null;

  try {
    const storedTheme = window.localStorage.getItem(storageKey);
    if (storedTheme === "dark" || storedTheme === "light") {
      savedTheme = storedTheme;
    }
  } catch (error) {
    // Theme switching should still work when browser storage is unavailable.
  }

  function applyTheme(dark) {
    root.setAttribute("data-bs-theme", dark ? "dark" : "light");
    root.style.colorScheme = dark ? "dark" : "light";
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      toggle.setAttribute("aria-checked", String(dark));
      toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  // Follow the browser/OS preference until the user explicitly chooses a theme.
  applyTheme(savedTheme ? savedTheme === "dark" : systemTheme.matches);
  function followSystem(event) {
    if (!savedTheme) {
      applyTheme(event.matches);
    }
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
        savedTheme = root.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
        applyTheme(savedTheme === "dark");
        try {
          window.localStorage.setItem(storageKey, savedTheme);
        } catch (error) {
          // Keep the manual choice for this page even if it cannot be saved.
        }
      });
    }
    applyTheme(root.getAttribute("data-bs-theme") === "dark");
  });
})();
