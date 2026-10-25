import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** Emits manifest.json with the version from package.json, the single source of truth. */
function manifest(): Plugin {
  return {
    name: "clipcascade-manifest",
    generateBundle() {
      const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
      const base = JSON.parse(readFileSync("src/manifest.json", "utf8")) as Record<string, unknown>;
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: JSON.stringify({ ...base, version }, null, 2),
      });
    },
  };
}

// Builds the service worker and the extension pages as ES modules.
// The content script cannot be an ES module, so it has its own build
// (vite.content.config.ts) that emits a single IIFE file.
export default defineConfig({
  plugins: [manifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: false,
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        popup: "popup.html",
        options: "options.html",
        offscreen: "offscreen.html",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
