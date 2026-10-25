import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "chrome116",
    lib: {
      entry: "src/content/index.ts",
      formats: ["iife"],
      name: "clipCascadeContent",
      fileName: () => "content.js",
    },
  },
});
