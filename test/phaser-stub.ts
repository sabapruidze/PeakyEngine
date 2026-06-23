// Headless stub for the `phaser` module. These tests must NOT touch Phaser
// APIs — this exists only so transitive `import Phaser from "phaser"` chains
// (e.g. eval.ts → Sprite/behaviors) resolve during test collection. Every
// property access / call / construct returns the same proxy, so `Phaser.Scene`,
// `class X extends Phaser.Scene`, `new Phaser.Game()` etc. all no-op safely.
const stub: unknown = new Proxy(function () {}, {
  get: () => stub,
  apply: () => stub,
  construct: () => ({}),
});
export default stub;
