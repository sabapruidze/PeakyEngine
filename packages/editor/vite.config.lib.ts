import { defineConfig } from "vite";
import { resolve } from "path";

/**
 * Library build for the standalone game player bundle.
 *
 * Produces `dist-lib/peaky-standalone.js` — an IIFE that exposes
 * `window.PeakyStandalone.boot(...)` for exported HTML pages to call.
 * Phaser + the entire @peaky/runtime are bundled inline so the
 * resulting JS file is fully self-contained (no CDN, no second fetch).
 *
 * Run via `npm run build:standalone` in `packages/editor`. The bundle
 * artifact is copied into `packages/editor/public/peaky-standalone.js`
 * so the editor's Export feature can fetch it and embed it in the
 * exported ZIP.
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/standalonePlayer.ts"),
      name: "PeakyStandalone",
      formats: ["iife"],
      fileName: () => "peaky-standalone.js",
    },
    outDir: "dist-lib",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // Phaser MUST be bundled — the exported HTML expects a single
      // self-contained JS file that runs without external dependencies.
      external: [],
    },
    target: "es2020",
    minify: "esbuild",
  },
});
