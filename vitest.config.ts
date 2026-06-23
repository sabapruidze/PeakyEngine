import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Headless unit tests (no browser, no Phaser boot). `phaser` is aliased to an
// empty proxy stub so pure-logic modules that transitively import it (eval.ts →
// Sprite/behaviors) can be collected without a real Phaser runtime.
export default defineConfig({
  resolve: {
    alias: {
      phaser: fileURLToPath(new URL("./test/phaser-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});
