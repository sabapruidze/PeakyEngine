import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, open: true },
  // Serve the source-linked workspace packages through the normal transform
  // pipeline (with HMR) instead of pre-bundling them into the dep cache —
  // otherwise edits to @peaky/runtime/@peaky/shared can be masked by a stale
  // optimized bundle and "nothing changes at runtime".
  optimizeDeps: { exclude: ["@peaky/runtime", "@peaky/shared"] },
});
