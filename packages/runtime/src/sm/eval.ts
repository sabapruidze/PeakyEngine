import type { Sprite } from "../Sprite";
import { getSpritesByTag, addSpriteTag, removeSpriteTag, getSpritesByName, reindexSpriteInstanceName } from "../Sprite";
import type { Condition, StateAction } from "@peaky/shared";
import { getInputActions, pointerOverUiBlocker } from "../input/InputActions";
import { Logger } from "../Logger";
import { findPath } from "../nav/NavGrid";
import { isNavPointAvailable, claimNavPoint } from "../nav/navPoints";
import { showOnScreenPrint } from "../OnScreenPrint";
import { findTracer } from "../behaviors/Tracer";
import { getSoundManager } from "../SoundManager";
import { isWritableBehaviorParam } from "../Behavior";
import { persistentState, resetPersistentState, serializePersistentState, applyPersistentState } from "../PersistentState";
import type { Behavior } from "../Behavior";
import { findTilemap, findTilemapAtWorld, resolveLayerId, resolveTilemapAndLayer } from "../util/tileCoords";
import { parseHardnessMax } from "../behaviors/TilemapRenderer";
import Phaser from "phaser";
import { VHSPipeline, ChromaticAberrationPipeline, FilmGrainPipeline } from "../fx/ScreenFXPipelines";

/** Composable full-screen post-FX on the main camera. Set by BlurScene +
 *  SetScreenEffect via the `peaky.screenFX` scene-data registry, applied by
 *  applyScreenFX. Each value is an intensity; absent = effect off. */
type ScreenFXState = { blur?: number; grayscale?: number; vhs?: number; chromatic?: number; filmgrain?: number };

/** A camera OR a GameObject — both expose the same postFX controller + post
 *  pipeline API, so one routine drives full-screen AND per-object effects. */
interface FXHost {
  postFX?: { clear(): void; addBlur(...a: number[]): unknown; addColorMatrix(): { grayscale(v?: number, m?: boolean): unknown } };
  setPostPipeline?: (p: unknown) => void;
  resetPostPipeline?: (b?: boolean) => void;
  getPostPipeline?: (p: unknown) => unknown;
}

/** Rebuild a host's full post-FX stack from an fx state. Built-in FX (blur,
 *  grayscale) go through the FX controller; the custom VHS / chromatic / grain
 *  shaders go through post pipelines. Clearing + rebuilding the whole stack on
 *  every change is what lets the effects COMPOSE instead of clobbering each
 *  other. WebGL only for the custom shaders. `fx` null/empty = clear everything. */
function applyFXTo(host: FXHost, fx: ScreenFXState | null, webgl: boolean): void {
  // Clear the ENTIRE post-pipeline stack ONCE, up front. Phaser's built-in FX
  // (blur/grayscale) are themselves post pipelines — postFX.clear() internally
  // calls resetPostPipeline(true). So clearing must happen before re-adding
  // anything; clearing BETWEEN adding FX and adding the custom shader pipelines
  // wipes the just-added grayscale/blur (the bug this fixes).
  if (host.postFX && typeof host.postFX.clear === "function") {
    host.postFX.clear();
  } else if (webgl && typeof host.resetPostPipeline === "function") {
    host.resetPostPipeline();
  }
  // Re-add the built-in FX (blur, grayscale) via the FX controller.
  if (host.postFX) {
    if (fx?.blur && fx.blur > 0) host.postFX.addBlur(0, fx.blur, fx.blur, 1, 0xffffff, 4);
    if (fx?.grayscale && fx.grayscale > 0) host.postFX.addColorMatrix().grayscale(Math.min(1, fx.grayscale));
  }
  // Re-add the custom shader pipelines (WebGL only).
  if (!webgl || typeof host.setPostPipeline !== "function") return;
  const pipes: Function[] = [];
  if (fx?.vhs && fx.vhs > 0) pipes.push(VHSPipeline);
  if (fx?.chromatic && fx.chromatic > 0) pipes.push(ChromaticAberrationPipeline);
  if (fx?.filmgrain && fx.filmgrain > 0) pipes.push(FilmGrainPipeline);
  if (pipes.length === 0 || typeof host.setPostPipeline !== "function") return;
  host.setPostPipeline(pipes);
  const setIntensity = (Cls: Function, v?: number): void => {
    if (!v || v <= 0 || typeof host.getPostPipeline !== "function") return;
    const p = host.getPostPipeline(Cls);
    const inst = (Array.isArray(p) ? p[0] : p) as { intensity: number } | undefined;
    if (inst) inst.intensity = Math.min(1, v);
  };
  setIntensity(VHSPipeline, fx?.vhs);
  setIntensity(ChromaticAberrationPipeline, fx?.chromatic);
  setIntensity(FilmGrainPipeline, fx?.filmgrain);
}

const _hasFX = (fx: ScreenFXState | undefined): boolean => !!fx && Object.keys(fx).length > 0;

/** Full-screen effects — rebuild the main camera's stack from `peaky.screenFX`. */
function applyScreenFX(scene: Phaser.Scene): void {
  const cam = scene.cameras?.main;
  if (!cam) return;
  const fx = (scene.data.get("peaky.screenFX") as ScreenFXState | undefined) ?? {};
  applyFXTo(cam as unknown as FXHost, fx, scene.game.renderer.type === Phaser.WEBGL);
}

/** Per-layer effects registry: layer NAME → fx state. */
type LayerFXReg = Map<string, ScreenFXState>;

/** Apply the post-FX of whatever layer a sprite currently sits on (by its
 *  layerId) to all of that sprite's visual objects — or clear them if its layer
 *  has no active effect. Called on spawn + MoveToLayer so the effect follows
 *  objects as they appear / move between layers. */
/** Resolve the fx state for whatever layer a sprite currently sits on. */
function layerFXForSprite(sprite: Sprite): ScreenFXState | undefined {
  const reg = sprite.scene?.data.get("peaky.layerFX") as LayerFXReg | undefined;
  if (!reg || reg.size === 0) return undefined;
  const idByName = sprite.scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
  if (!idByName) return undefined;
  for (const name in idByName) if (idByName[name] === sprite.layerId) return reg.get(name);
  return undefined;
}

/** Apply the post-FX of a sprite's current layer to it (or clear it). Called on
 *  spawn + MoveToLayer so the effect follows objects. UI widgets render on the
 *  shared UI camera and their bg/border are Graphics (no per-object FX), so
 *  their layer's effect routes to the UI camera instead — only SET there (never
 *  clear from here) so a plain widget spawning can't wipe another UI layer's
 *  active effect on the shared camera. */
function applyLayerFXToSprite(sprite: Sprite): void {
  const scene = sprite.scene;
  if (!scene) return;
  const webgl = scene.game.renderer.type === Phaser.WEBGL;
  const fx = layerFXForSprite(sprite);
  const fxOrNull = _hasFX(fx) ? (fx as ScreenFXState) : null;
  if (sprite.isUIWidget && !sprite.renderOnMainCamera) {
    if (fxOrNull) {
      const uiCam = scene.data.get("peaky.uiCam") as FXHost | undefined;
      if (uiCam) applyFXTo(uiCam, fxOrNull, webgl);
    }
    return;
  }
  for (const go of sprite.collectFXObjects()) applyFXTo(go as unknown as FXHost, fxOrNull, webgl);
}

/** Re-apply a layer's effect after it changed (SetScreenEffect target=layer).
 *  Gameplay sprites get per-object FX; UI-camera sprites route the effect to
 *  the UI camera (covers their Graphics bg/border, which can't take object FX).
 *  NOTE: all UI layers share one UI camera, so with multiple effected UI layers
 *  the most-recently-changed one wins on that camera. */
function applyLayerFX(scene: Phaser.Scene, layerName: string): void {
  const idByName = scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
  const targetId = idByName?.[layerName];
  if (targetId === undefined) return;
  // Register a per-scene hook so overlays CREATED LATER (e.g. a SpriteRenderer's
  // lazily-built image) inherit their layer's effect — Sprite.routeOverlayToCamera
  // calls it for each newly-routed GO. Set once; reads the live registry each
  // call (no-op when no layer effects are active). UI-cam sprites are handled by
  // the camera, so skip per-object there.
  if (!scene.data.get("peaky.layerFXHook")) {
    scene.data.set("peaky.layerFXHook", (s: Sprite, go: Phaser.GameObjects.GameObject) => {
      const reg2 = s.scene?.data.get("peaky.layerFX") as LayerFXReg | undefined;
      if (!reg2 || reg2.size === 0) return;
      if (s.isUIWidget && !s.renderOnMainCamera) return;
      const fx = layerFXForSprite(s);
      if (!_hasFX(fx)) return;
      applyFXTo(go as unknown as FXHost, fx as ScreenFXState, s.scene.game.renderer.type === Phaser.WEBGL);
    });
  }
  const reg = scene.data.get("peaky.layerFX") as LayerFXReg | undefined;
  const fxOrNull = _hasFX(reg?.get(layerName)) ? (reg!.get(layerName) as ScreenFXState) : null;
  const webgl = scene.game.renderer.type === Phaser.WEBGL;
  const sprites = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  let uiRouted = false;
  for (const s of sprites) {
    if (s.destroyed || s.layerId !== targetId) continue;
    if (s.isUIWidget && !s.renderOnMainCamera) { uiRouted = true; continue; }
    for (const go of s.collectFXObjects()) applyFXTo(go as unknown as FXHost, fxOrNull, webgl);
  }
  if (uiRouted) {
    const uiCam = scene.data.get("peaky.uiCam") as FXHost | undefined;
    if (uiCam) applyFXTo(uiCam, fxOrNull, webgl);
  }
}

export { applyLayerFXToSprite };

/** Resolve a sprite by blueprintName or instanceName. Uses the per-scene name
 *  index (peaky.spritesByName, built in Sprite.ts) for an O(1) lookup instead
 *  of an O(N) peaky.sprites scan on every `var:Name.field` read every frame.
 *  Returns the FIRST non-destroyed match (insertion/spawn order — same
 *  "first match wins" semantics as the old scan). Falls back to a linear scan
 *  ONLY when the index map is absent (defensive — imperative-API games that
 *  never registered it). */
function findSpriteByName(sprite: Sprite, target: string): Sprite | undefined {
  const scene = sprite.scene;
  // Index fast-path (O(1)) for the common case.
  for (const s of getSpritesByName(scene, target)) if (!s.destroyed) return s;
  // MISS → fall back to the linear scan. The index is an OPTIMIZATION, not the
  // source of truth: a sprite spawned/renamed through a path that didn't
  // register it (or before its name was assigned) must still resolve, else
  // var:Name reads silently return nothing and break AI / attacks / sound
  // triggers that depend on them. Only genuinely-absent names pay the O(N) cost.
  return ((scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [])
    .find((s) => !s.destroyed && (s.blueprintName === target || s.instanceName === target));
}

/**
 * Coerce a config value to a number with a fallback. Three input shapes:
 *   • a literal number (Inspector)
 *   • a numeric string
 *   • a `$var:<name>` ref — resolved against `sprite.vars` each call
 */
/**
 * Coerce a stored variable value to a number, accepting strings, booleans,
 * and finite numbers. Returns `fallback` for anything else.
 */
function varToNum(cur: unknown, fallback: number): number {
  if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  if (typeof cur === "boolean") return cur ? 1 : 0;
  if (typeof cur === "string") {
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Tokenize an expression string into operators, numbers, and identifiers.
 * Identifiers are anything matching `[A-Za-z_$][A-Za-z0-9_.:$]*` — captures
 * `self.x`, `var:hp`, `$var:hp`, `tracer:T.f`, `$tracer:T.f`, bare `hp`.
 * Returns `null` on bad characters (caller falls back to legacy parsing).
 */
function tokenizeExpr(expr: string): Array<string | number> | null {
  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if ("+-*/()".includes(c)) { tokens.push(c); i++; continue; }
    if (/[\d.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[\d.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push(n);
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < expr.length && /[A-Za-z0-9_.:$]/.test(expr[j])) j++;
      // Function-call form: `name(...)` — greedily capture the parenthesised
      // arg list (with nested-paren support) so the whole `random.int(10, 50)`
      // string lands as ONE identifier token that resolveIdent then parses
      // itself. Without this, the comma inside the args breaks the bare
      // arithmetic tokenizer and the entire expression falls back to the
      // legacy literal-Number() path, dropping the random call entirely.
      if (expr[j] === "(") {
        let depth = 1;
        let k = j + 1;
        while (k < expr.length && depth > 0) {
          const ch = expr[k];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          k++;
        }
        if (depth !== 0) return null; // unbalanced parens
        tokens.push(expr.slice(i, k));
        i = k;
        continue;
      }
      tokens.push(expr.slice(i, j));
      i = j;
      continue;
    }
    return null;
  }
  return tokens;
}

/** Tokenize cache. Expression strings are STATIC config (they don't change at
 *  runtime), so an `Always → SetVelocityX self.x + var:speed` event re-running
 *  60×/sec would otherwise re-tokenize (per-char regex + a fresh array) every
 *  frame. Keyed by the raw string; bounded by the project's distinct
 *  expressions. `null` is a valid cached result (un-parseable → legacy path),
 *  so we distinguish "absent" via `=== undefined`. The parser only reads the
 *  tokens via a `pos` index, never mutates them, so sharing the array is safe. */
const _tokenCache = new Map<string, Array<string | number> | null>();
/** Exported for tests (verifies the cache returns identical array refs). */
export function tokenizeExprCached(expr: string): Array<string | number> | null {
  let t = _tokenCache.get(expr);
  if (t === undefined && !_tokenCache.has(expr)) {
    t = tokenizeExpr(expr);
    _tokenCache.set(expr, t);
  }
  return t ?? null;
}

/** Coerce one persistent-store scalar to a number (undefined if not numeric). */
function globalScalarToNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

/** Split "name.accessor" → [name, accessor]; accessor is "" when there's none.
 *  Used for `global:`/`list:` refs that may carry a `.length` or `.<index>`. */
function splitStoreRef(rest: string): [string, string] {
  const dot = rest.indexOf(".");
  return dot >= 0 ? [rest.slice(0, dot), rest.slice(dot + 1)] : [rest, ""];
}

/** Read a store value (scalar OR array) with an optional accessor as a NUMBER.
 *  Array + "length"/"" → element count; array + index → that element. */
function readStoreNum(value: unknown, acc: string): number | undefined {
  if (Array.isArray(value)) {
    if (acc === "" || acc === "length") return value.length;
    const i = Number(acc);
    return Number.isInteger(i) ? globalScalarToNum(value[i]) : undefined;
  }
  if (acc === "length") return undefined;
  return globalScalarToNum(value);
}

/** Read a LIST (key→value record) with an accessor as a NUMBER. `list:g.entry`
 *  → that entry; `list:g.length` / bare → entry count. */
function readListNum(rec: Record<string, unknown> | undefined, acc: string): number | undefined {
  if (!rec) return undefined;
  if (acc === "" || acc === "length") return Object.keys(rec).length;
  return globalScalarToNum(rec[acc]);
}

/** Read a LIST (key→value record) with an accessor as a STRING. `list:g.entry`
 *  → that entry; `length` → count; bare → comma-joined values. */
function readListStr(rec: Record<string, unknown> | undefined, acc: string): string | undefined {
  if (!rec) return undefined;
  if (acc === "length") return String(Object.keys(rec).length);
  if (acc === "") return Object.values(rec).map((v) => String(v)).join(",");
  const v = rec[acc];
  return v === undefined ? undefined : String(v);
}

/** Read a store value (scalar OR array) with an optional accessor as a STRING.
 *  Bare array → comma-joined; "length" → count; index → that element. */
function readStoreStr(value: unknown, acc: string): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (acc === "") return value.join(",");
    if (acc === "length") return String(value.length);
    const i = Number(acc);
    return Number.isInteger(i) && i >= 0 && i < value.length ? String(value[i]) : undefined;
  }
  if (acc === "length") return undefined;
  return String(value);
}

/** Resolve an identifier token to a numeric value. Returns undefined for
 *  unknown identifiers so the parser can bail and the caller can fall back. */
/** Split a comma-separated argument list while respecting nested parens.
 *  Used by `tile.<fn>(arg, arg, ...)` expression tokens so an inner expression
 *  like `tile.idx(World, Main, mouse.x, mouse.y + 32)` doesn't break on the
 *  comma inside Math/expression brackets either. */
function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(src.slice(start, i));
      start = i + 1;
    }
  }
  out.push(src.slice(start));
  return out;
}

function resolveIdent(sprite: Sprite, ident: string): number | undefined {
  if (ident.startsWith("self.")) {
    const field = ident.slice(5);
    const obj = sprite.gameObject;
    const body = sprite.body;
    switch (field) {
      case "x":      return obj.x;
      case "y":      return obj.y;
      case "vx":     return body.velocity.x;
      case "vy":     return body.velocity.y;
      case "scale":  return obj.scale;
      case "scaleX": return obj.scaleX;
      case "scaleY": return obj.scaleY;
      case "alpha":  return obj.alpha;
      case "angle":  return obj.angle;
      case "uid":    return sprite.uid;
      default:       return undefined;
    }
  }
  if (ident.startsWith("picked.")) {
    // The most-recently-picked sprite — set by OnObjectClicked,
    // OnObjectDoubleClicked, and OnCollide / OnOverlap callbacks. Lets
    // actions in a picking trigger's chain address THAT specific instance
    // (e.g. picked.uid → fed to SetVarOn / EmitSignalTo, picked.x for
    // SetPosition, picked.<varName> to read a per-instance variable).
    // Returns 0 when nothing is picked yet so expressions stay safe
    // outside picking-trigger chains.
    const field = ident.slice("picked.".length);
    const picked = sprite.scene?.data?.get("peaky.picked") as Sprite | undefined;
    if (!picked || picked.destroyed) return 0;
    const obj = picked.gameObject;
    const body = picked.body;
    switch (field) {
      case "x":      return obj.x;
      case "y":      return obj.y;
      case "vx":     return body?.velocity.x ?? 0;
      case "vy":     return body?.velocity.y ?? 0;
      case "scale":  return obj.scale;
      case "scaleX": return obj.scaleX;
      case "scaleY": return obj.scaleY;
      case "alpha":  return obj.alpha;
      case "angle":  return obj.angle;
      case "uid":    return picked.uid;
      // Strings (name, tag) — let resolveIdent return undefined so the
      // caller can fall back. strOr handles the string form separately.
      case "name":
      case "tag":    return undefined;
      // picked.<varName> — read a variable on the picked sprite.
      default:       return varToNum(picked.vars.get(field), 0);
    }
  }
  if (ident.startsWith("mouse.")) {
    // Mouse / pointer coordinates. World coords honor camera scroll
    // (so `SetPosition mouse.x mouse.y` puts the sprite under the
    // cursor in world space). screenX/screenY are canvas-pixel coords
    // (no scroll applied) — useful for UI-cam targets.
    const field = ident.slice(6);
    const ptr = sprite.scene?.input?.activePointer;
    if (!ptr) return undefined;
    // cameras.main can be undefined during scene shutdown/start. Fall back
    // to ptr.x/y (canvas coords) when missing. (audit HIGH #54)
    const cam = sprite.scene.cameras?.main;
    switch (field) {
      case "x":       return ptr.worldX ?? (ptr.x + (cam?.scrollX ?? 0));
      case "y":       return ptr.worldY ?? (ptr.y + (cam?.scrollY ?? 0));
      case "screenX": return ptr.x;
      case "screenY": return ptr.y;
      case "left":    return ptr.leftButtonDown() ? 1 : 0;
      case "middle":  return ptr.middleButtonDown() ? 1 : 0;
      case "right":   return ptr.rightButtonDown() ? 1 : 0;
      default:        return undefined;
    }
  }
  if (ident.startsWith("lastTile.")) {
    // Scene-wide context of the most-recently affected tile. Two snapshots
    // are written: `peaky.lastDamagedTile` (partial damage, HP > 0 after) and
    // `peaky.lastDestroyedTile` (HP reached 0). The damaged snapshot wins
    // when both are present from the same tick because OnTileDamaged is the
    // newer event and authors using both triggers expect to read the right
    // one. The damaged snapshot also exposes `prevHP` / `nextHP` / `maxHP`.
    const field = ident.slice("lastTile.".length);
    const damaged = sprite.scene?.data?.get("peaky.lastDamagedTile") as
      | { tilemap: string; layer: string; c: number; r: number; idx: number; x: number; y: number; prevHP?: number; nextHP?: number; maxHP?: number; animatedTileId?: string }
      | undefined;
    const destroyed = sprite.scene?.data?.get("peaky.lastDestroyedTile") as
      | { tilemap: string; layer: string; c: number; r: number; idx: number; x: number; y: number }
      | undefined;
    const last = damaged ?? destroyed;
    if (!last) return field === "tilemap" || field === "layer" ? undefined : 0;
    switch (field) {
      case "c":       return last.c;
      case "r":       return last.r;
      case "idx":     return last.idx;
      case "x":       return last.x;
      case "y":       return last.y;
      case "prevHP":  return damaged?.prevHP ?? 0;
      case "nextHP":  return damaged?.nextHP ?? 0;
      case "maxHP":   return damaged?.maxHP ?? 0;
      case "tilemap": return undefined; // string field — handled in strOr
      case "layer":   return undefined;
      default:        return undefined;
    }
  }
  // Bare `random(min, max)` — universal alias for `random.int(min, max)`.
  // Matches the tile-hardness expression syntax so authors can use the same
  // form everywhere expressions are accepted (particle counts, positions,
  // var assignments, etc.) without remembering the .int suffix.
  if (ident.startsWith("random(") && ident.endsWith(")")) {
    const args = splitArgs(ident.slice("random(".length, -1));
    const lo = Math.floor(numOr((args[0] ?? "0").trim(), 0, sprite));
    const hi = Math.floor(numOr((args[1] ?? "0").trim(), 0, sprite));
    if (hi < lo) return lo;
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }
  if (ident.startsWith("random.")) {
    // Random expression tokens (numeric variants):
    //   random.float(min, max)  → uniform float in [min, max)
    //   random.int(min, max)    → integer in [min, max] (inclusive both ends)
    // The string variant `random.string(chars..., length)` is a STRING result
    // and is handled in strOr's whole-string ref branch — it returns
    // undefined here so the literal fallback path triggers for that case.
    const open = ident.indexOf("(");
    const close = ident.lastIndexOf(")");
    if (open < 0 || close < open) return undefined;
    const fn = ident.slice("random.".length, open).trim();
    const args = splitArgs(ident.slice(open + 1, close));
    if (fn === "float") {
      const lo = numOr((args[0] ?? "0").trim(), 0, sprite);
      const hi = numOr((args[1] ?? "1").trim(), 1, sprite);
      if (hi < lo) return lo;
      return lo + Math.random() * (hi - lo);
    }
    if (fn === "int") {
      const lo = Math.floor(numOr((args[0] ?? "0").trim(), 0, sprite));
      const hi = Math.floor(numOr((args[1] ?? "0").trim(), 0, sprite));
      if (hi < lo) return lo;
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    // `random.string` numeric form `.length(...)` returns the string's
    // length — handy as a sanity check expression. The string content
    // itself flows through strOr.
    if (fn === "string.length") {
      const last = (args[args.length - 1] ?? "0").trim();
      return Math.max(0, Math.floor(Number(last) || 0));
    }
    return undefined;
  }
  if (ident.startsWith("choose(") && ident.endsWith(")")) {
    // Pick ONE of the comma-separated expressions and evaluate it.
    // Lazy — only the chosen branch runs, so `choose(random.int(-20, 20),
    // random.int(-50, 50))` rolls exactly one random number, not both.
    const inner = ident.slice("choose(".length, -1);
    const args = splitArgs(inner).map((a) => a.trim()).filter((a) => a.length > 0);
    if (args.length === 0) return undefined;
    const pick = args[Math.floor(Math.random() * args.length)];
    return numOr(pick, 0, sprite);
  }
  if (ident.startsWith("tile.")) {
    // Tilemap expression tokens — pure read accessors, format:
    //   tile.idx(<tilemap>, <layer>, <x>, <y>)   → tile index at world (x, y)
    //   tile.c(<tilemap>, <x>)                   → cell column for world X
    //   tile.r(<tilemap>, <y>)                   → cell row for world Y
    //   tile.worldX(<tilemap>, <c>)              → world X for cell C (center)
    //   tile.worldY(<tilemap>, <r>)              → world Y for cell R (center)
    //   tile.cols(<tilemap>)                     → map width in cells
    //   tile.rows(<tilemap>)                     → map height in cells
    // Argument values can themselves be expressions (e.g. `mouse.x`).
    // Returns undefined when the tilemap isn't placed or args don't parse.
    const open = ident.indexOf("(");
    const close = ident.lastIndexOf(")");
    if (open < 0 || close < open) return undefined;
    const fn = ident.slice("tile.".length, open).trim();
    const args = splitArgs(ident.slice(open + 1, close));
    const tmName = (args[0] ?? "").trim();
    if (!tmName) return undefined;
    const tm = findTilemap(sprite.scene, tmName);
    if (!tm) return undefined;
    if (fn === "cols") return tm.cols;
    if (fn === "rows") return tm.rows;
    if (fn === "idx") {
      const layerId = resolveLayerId(tm, (args[1] ?? "").trim());
      if (!layerId) return -1;
      const xExpr = (args[2] ?? "0").trim();
      const yExpr = (args[3] ?? "0").trim();
      const cell = tm.worldToCell(numOr(xExpr, 0, sprite), numOr(yExpr, 0, sprite));
      if (!cell) return -1;
      return tm.getTileAt(layerId, cell.c, cell.r);
    }
    if (fn === "c") {
      const xExpr = (args[1] ?? "0").trim();
      const cell = tm.worldToCell(numOr(xExpr, 0, sprite), 0);
      return cell ? cell.c : -1;
    }
    if (fn === "r") {
      const yExpr = (args[1] ?? "0").trim();
      const cell = tm.worldToCell(0, numOr(yExpr, 0, sprite));
      return cell ? cell.r : -1;
    }
    if (fn === "worldX") {
      const c = Math.floor(numOr((args[1] ?? "0").trim(), 0, sprite));
      return tm.cellToWorld(c, 0).x;
    }
    if (fn === "worldY") {
      const r = Math.floor(numOr((args[1] ?? "0").trim(), 0, sprite));
      return tm.cellToWorld(0, r).y;
    }
    return undefined;
  }
  if (ident.startsWith("global:") || ident.startsWith("$global:")) {
    // Persistent global variable (money / day / counts / arrays). Survives
    // scene transitions + save/load — see PersistentState. Set via SetGlobal /
    // GlobalArrayOp. `global:arr.2` → element, `global:arr.length` → count.
    const [name, acc] = splitStoreRef(ident.slice(ident.indexOf(":") + 1));
    return readStoreNum(persistentState().globals[name], acc);
  }
  if (ident.startsWith("list:") || ident.startsWith("$list:")) {
    // Read-only list (named group of key→value entries). `list:prices.apple`
    // → that entry's value, `list:prices.length` → entry count.
    const [name, acc] = splitStoreRef(ident.slice(ident.indexOf(":") + 1));
    return readListNum(persistentState().lists[name], acc);
  }
  if (ident.startsWith("$var:") || ident.startsWith("var:")) {
    const path = ident.slice(ident.indexOf(":") + 1);
    // Cross-BP lookup: `var:Player.hp` / `var:Player.x` resolves "Player"
    // to the first live sprite whose blueprintName OR instanceName
    // matches, then returns either a built-in transform/physics field
    // (x, y, vx, vy, angle, scale*, alpha, uid) or a user variable on
    // that sprite. Built-ins win when the names collide so there's no
    // ambiguity. Bare `var:hp` (no dot) still reads from the calling
    // sprite's own vars.
    const dot = path.indexOf(".");
    if (dot > 0) {
      const target = path.slice(0, dot);
      const field = path.slice(dot + 1);
      // `self` → the calling sprite, so `var:self.x` matches the bare
      // `self.x` form. Otherwise look up the named BP / instance.
      const found = target === "self"
        ? sprite
        : findSpriteByName(sprite, target);
      if (!found) return undefined;
      const obj = found.gameObject;
      const body = found.body;
      switch (field) {
        case "x":      return obj.x;
        case "y":      return obj.y;
        case "vx":     return body?.velocity.x ?? 0;
        case "vy":     return body?.velocity.y ?? 0;
        case "angle":  return obj.angle;
        case "scale":  return obj.scale;
        case "scaleX": return obj.scaleX;
        case "scaleY": return obj.scaleY;
        case "alpha":  return obj.alpha;
        case "uid":    return found.uid;
      }
      return varToNum(found.vars.get(field), 0);
    }
    return varToNum(sprite.vars.get(path), 0);
  }
  if (ident.startsWith("$tracer:") || ident.startsWith("tracer:")) {
    const rest = ident.slice(ident.indexOf(":") + 1);
    const t = resolveTracerExpr(sprite, rest);
    if (typeof t === "number") return t;
    if (typeof t === "string") {
      const n = Number(t);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  if (ident.startsWith("$weapon:") || ident.startsWith("weapon:")) {
    const rest = ident.slice(ident.indexOf(":") + 1);
    const w = resolveWeaponExpr(sprite, rest);
    if (typeof w === "number") return w;
    if (typeof w === "string") {
      const n = Number(w);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  // Bare name — auto-resolve as a BP variable (matches CompareValues style).
  if (sprite.vars.has(ident)) return varToNum(sprite.vars.get(ident), 0);
  return undefined;
}

/**
 * Evaluate a numeric expression like `self.x + 200` or `(var:hp / 2) - 5`.
 * Standard operator precedence: unary minus > * / > + -. Parens override.
 *
 * Returns undefined on parse error (unknown identifier, bad syntax, division
 * by zero handled by JS but produces ±Infinity which `Number.isFinite`
 * filters out). Caller treats undefined as "fall back to literal parsing"
 * so old projects keep working.
 */
/** Shared by the CreateSpriteObject action AND Game.ts's per-frame
 *  drain loop. Creates the Phaser Sprite, indexes it under
 *  peaky.placementsBySpriteId, hides from the UI cam, and queues the
 *  OnSpriteObjectCreate broadcast for the next frame. Returns the
 *  GameObject so callers can inspect / mutate further. */
export function spawnRuntimeSpriteObject(
  scene: Phaser.Scene, spriteId: string, x: number, y: number,
): Phaser.GameObjects.Sprite | null {
  const spritesProj = scene.data.get("peaky.projectSprites") as
    Array<{ id: string; name: string; width: number; height: number;
            animations: Array<{ id: string; name: string; fps: number; loop: boolean;
              frames: Array<{ imageFile?: string; color: number; collider?: { enabled: boolean; width: number; height: number; offsetX: number; offsetY: number; exceptionTags?: string[] } }> }> }> | undefined;
  if (!spritesProj) return null;
  const asset = spritesProj.find((s) => s.id === spriteId);
  if (!asset) return null;
  const anim = asset.animations[0];
  if (!anim || anim.frames.length === 0) return null;
  const key = `sprite:${asset.id}:${anim.id}:0`;
  const go = scene.add.sprite(x, y, scene.textures.exists(key) ? key : "__DEFAULT");
  if (!scene.textures.exists(key)) {
    go.setTint(anim.frames[0].color & 0xffffff);
    go.setDisplaySize(asset.width || 32, asset.height || 32);
  }
  // Pull the first frame's collider exception tags onto the GameObject
  // so the runtime collision processCallback can veto pairs matching
  // any of these tags (e.g., attack frames exempting teammates).
  const frame0Collider = anim.frames[0]?.collider;
  if (frame0Collider?.enabled && frame0Collider.exceptionTags?.length) {
    go.setData("peaky.frameExempt", [...frame0Collider.exceptionTags]);
  }
  const uiCam = scene.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
  if (uiCam) uiCam.ignore(go);
  const idx = (scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined) ?? new Map();
  const list = idx.get(spriteId) ?? [];
  list.push(go);
  idx.set(spriteId, list);
  scene.data.set("peaky.placementsBySpriteId", idx);
  const pending = (scene.data.get("peaky.pendingPlacementCreates") as Array<{ spriteId: string; go: Phaser.GameObjects.Sprite }> | undefined) ?? [];
  pending.push({ spriteId, go });
  scene.data.set("peaky.pendingPlacementCreates", pending);
  return go;
}

export function evalExpression(sprite: Sprite, expr: string): number | undefined {
  const tokens = tokenizeExprCached(expr);
  if (!tokens || tokens.length === 0) return undefined;
  let pos = 0;

  const peek = (): string | number | undefined => tokens[pos];

  const parseExpr = (): number | undefined => {
    let left = parseTerm();
    if (left === undefined) return undefined;
    while (peek() === "+" || peek() === "-") {
      const op = tokens[pos++] as string;
      const right = parseTerm();
      if (right === undefined) return undefined;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number | undefined => {
    let left = parseFactor();
    if (left === undefined) return undefined;
    while (peek() === "*" || peek() === "/") {
      const op = tokens[pos++] as string;
      const right = parseFactor();
      if (right === undefined) return undefined;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number | undefined => {
    const t = peek();
    if (t === undefined) return undefined;
    if (t === "-") { pos++; const v = parseFactor(); return v === undefined ? undefined : -v; }
    if (t === "+") { pos++; return parseFactor(); }
    if (t === "(") {
      pos++;
      const v = parseExpr();
      if (peek() !== ")") return undefined;
      pos++;
      return v;
    }
    if (typeof t === "number") { pos++; return t; }
    if (typeof t === "string") { pos++; return resolveIdent(sprite, t); }
    return undefined;
  };

  const result = parseExpr();
  if (pos !== tokens.length) return undefined; // trailing junk → bad expression
  return result === undefined || !Number.isFinite(result) ? undefined : result;
}

// Once-per-process warn registry so a typo'd expression in a per-tick
// path doesn't spam the Logger 60 times per second.
const _numOrWarnedExprs = new Set<string>();

// Same idea for EmitSignalTo diagnostics — log each distinct misconfig
// once so a continuous emitter (tracer interval, OnStep) doesn't flood.
const _emitSignalToWarned = new Set<string>();

/** Parse a tag list off an action config — preferred field is `tags`
 *  (string[]), legacy fallback is `tag` (string). The legacy string
 *  splits on commas so a hand-typed "enemy, boss" still works without
 *  schema migration. Trims whitespace and drops empty entries so a
 *  trailing comma can't accidentally match the empty tag. */
function parseTagList(cfg: Record<string, unknown>): string[] {
  const raw = cfg.tags;
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? "").trim()).filter((s) => s !== "");
  }
  const legacy = String(cfg.tag ?? "").trim();
  if (legacy === "") return [];
  return legacy.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export function numOr(v: unknown, fallback: number, sprite?: Sprite): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    if (v.trim() === "") return fallback;
    // Try the expression evaluator first — covers literals, identifiers
    // (self.x, var:foo, tracer:T.f), and arithmetic on them. Unknown
    // syntax falls through silently to the legacy paths below for
    // backwards compatibility with strings that pre-date the evaluator.
    if (sprite) {
      const result = evalExpression(sprite, v);
      if (result !== undefined) return result;
    }
    // Legacy direct-prefix paths (still useful when no sprite is in scope).
    if (sprite && v.startsWith("$var:")) {
      return varToNum(sprite.vars.get(v.slice("$var:".length)), fallback);
    }
    if (sprite && (v.startsWith("$tracer:") || v.startsWith("tracer:"))) {
      const rest = v.slice(v.indexOf(":") + 1);
      const t = resolveTracerExpr(sprite, rest);
      return varToNum(t, fallback);
    }
    if (sprite && (v.startsWith("$weapon:") || v.startsWith("weapon:"))) {
      const rest = v.slice(v.indexOf(":") + 1);
      const w = resolveWeaponExpr(sprite, rest);
      return varToNum(w, fallback);
    }
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    // Reached only when the string failed every parse path. Warn once
    // per distinct expression — silent fallback was masking typos like
    // `var:HP ` (trailing space) or `var:Player.HP` vs `var:player.hp`.
    if (!_numOrWarnedExprs.has(v)) {
      _numOrWarnedExprs.add(v);
      Logger.log({
        level: "warn",
        source: "numOr",
        message: `Couldn't resolve expression ${JSON.stringify(v)} — using fallback ${fallback}. Check spelling, case, and that any referenced variable / tracer exists.`,
      });
    }
  }
  return fallback;
}

/** Resolve a single `picked.<field>` expression to its string form.
 *  Returns "" when nothing is picked, the picked sprite is destroyed,
 *  or the field is unknown (matches `var:UNKNOWN` semantics). */
function resolvePickedString(sprite: Sprite, field: string): string {
  const picked = sprite.scene?.data?.get("peaky.picked") as Sprite | undefined;
  if (!picked || picked.destroyed) return "";
  switch (field) {
    case "x":      return String(picked.gameObject.x);
    case "y":      return String(picked.gameObject.y);
    case "vx":     return String(picked.body?.velocity.x ?? 0);
    case "vy":     return String(picked.body?.velocity.y ?? 0);
    case "scale":  return String(picked.gameObject.scale);
    case "scaleX": return String(picked.gameObject.scaleX);
    case "scaleY": return String(picked.gameObject.scaleY);
    case "alpha":  return String(picked.gameObject.alpha);
    case "angle":  return String(picked.gameObject.angle);
    case "uid":    return String(picked.uid);
    case "name":        return picked.instanceName || picked.blueprintName || "";
    case "tag":         return [...picked.tags][0] ?? "";
    case "instanceTag": return [...picked.instanceTags][0] ?? "";
    default: {
      const cur = picked.vars.get(field);
      return cur === undefined ? "" : String(cur);
    }
  }
}

/** Resolve a `var:` path (without the prefix) — either a bare local var
 *  name (`hp`) or a cross-BP dotted form (`Player.x` / `Player.hp`). The
 *  dotted form looks up the target sprite by blueprintName / instanceName,
 *  then reads either a built-in transform/physics field or a user var.
 *  Returns undefined when the sprite or field isn't found, so callers can
 *  fall back to a default. Mirrors the same resolution path used by
 *  `resolveIdent` (numOr) and `resolveExpr` (CompareValues) so authors get
 *  consistent semantics across PrintString interpolation, arithmetic,
 *  and value comparisons. */
function resolveVarPath(sprite: Sprite, path: string): unknown {
  const dot = path.indexOf(".");
  if (dot <= 0) return sprite.vars.get(path);
  const target = path.slice(0, dot);
  const field = path.slice(dot + 1);
  // `self` resolves to the calling sprite — so `$var:self.x` works the
  // same as the bare `self.x` form. Forgiving: authors who reach for the
  // $var: prefix out of habit still get the host's own field.
  const found = target === "self"
    ? sprite
    : findSpriteByName(sprite, target);
  if (!found) return undefined;
  const obj = found.gameObject;
  const body = found.body;
  // Image-point lookup — `Object.IP.<pointName>.x|y` resolves to the world
  // position of a named image point on the target sprite's SpriteRenderer
  // current frame. Returns undefined when no SR / no such point exists
  // (callers fall back via numOr default). The IP prefix keeps point names
  // in their own namespace so they can't shadow user vars.
  if (field.startsWith("IP.")) {
    const rest = field.slice(3);
    const lastDot = rest.lastIndexOf(".");
    if (lastDot <= 0) return undefined;
    const pointName = rest.slice(0, lastDot);
    const axis = rest.slice(lastDot + 1);
    const sr = found.findBehaviorByKind("SpriteRenderer") as
      | { getImagePointWorld?: (n: string) => { x: number; y: number } | null }
      | undefined;
    const pt = sr?.getImagePointWorld?.(pointName);
    if (!pt) return undefined;
    if (axis === "x") return pt.x;
    if (axis === "y") return pt.y;
    return undefined;
  }
  switch (field) {
    case "x":      return obj.x;
    case "y":      return obj.y;
    case "vx":     return body?.velocity.x ?? 0;
    case "vy":     return body?.velocity.y ?? 0;
    case "angle":  return obj.angle;
    case "scale":  return obj.scale;
    case "scaleX": return obj.scaleX;
    case "scaleY": return obj.scaleY;
    case "alpha":  return obj.alpha;
    case "uid":    return found.uid;
  }
  return found.vars.get(field);
}

/** Resolve a variable WRITE target path to the sprite + field to write into.
 *  Bare `name` (no dot) → the calling sprite (local, unchanged). `Object.field`
 *  (optionally `var:`/`$var:`-prefixed) → another live sprite matched by
 *  blueprintName / instanceName / tag, or `self`. Returns null if the named
 *  object isn't found, so the caller no-ops instead of writing nowhere. */
function resolveWriteTarget(sprite: Sprite, path: string): { sprite: Sprite; field: string } | null {
  let p = (path ?? "").trim();
  if (!p) return null;
  if (p.startsWith("$var:")) p = p.slice(5);
  else if (p.startsWith("var:")) p = p.slice(4);
  const dot = p.indexOf(".");
  if (dot <= 0) return { sprite, field: p };
  const objName = p.slice(0, dot);
  const field = p.slice(dot + 1);
  if (objName === "self") return { sprite, field };
  const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  const found = all.find((s) => !s.destroyed && (s.blueprintName === objName || s.instanceName === objName || s.tags.has(objName)));
  return found ? { sprite: found, field } : null;
}

export function strOr(v: unknown, fallback: string, sprite?: Sprite): string {
  if (typeof v === "string") {
    if (sprite) {
      // Whole-string var reference: "var:hp" / "$var:hp" → the raw value, no
      // coercion. Also supports the cross-BP dotted form "var:Player.x".
      // Accept BOTH the bare `var:` (what the {} picker inserts and what
      // numOr/CompareValues use) and the `$var:` form — so a picked-or-typed
      // var reference resolves the same as tracer:/global:/list: which already
      // accept both. (Previously only `$var:` worked here, so a Set-Text with
      // `var:HP` silently rendered the literal text.)
      if ((v.startsWith("var:") || v.startsWith("$var:")) && !/\s/.test(v)) {
        const cur = resolveVarPath(sprite, v.slice(v.indexOf(":") + 1));
        return cur === undefined ? fallback : String(cur);
      }
      // Whole-string self reference: "self.x" / "$self.x" → the host
      // sprite's own transform/physics field. Mirrors resolveExpr's
      // `self.` branch so PrintString can show "self.x" the same way
      // CompareValues / arithmetic expressions read it.
      if ((v.startsWith("self.") || v.startsWith("$self.")) && !/\s/.test(v)) {
        const field = v.slice(v.indexOf(".") + 1);
        const cur = resolveVarPath(sprite, `self.${field}`);
        return cur === undefined ? fallback : String(cur);
      }
      // Whole-string tracer reference: "$tracer:groundCheck.actorName" /
      // "tracer:groundCheck.actorName" → raw field value, no coercion.
      if ((v.startsWith("$tracer:") || v.startsWith("tracer:")) && !/\s/.test(v)) {
        const rest = v.slice(v.indexOf(":") + 1);
        return String(resolveTracerExpr(sprite, rest));
      }
      // Whole-string weapon-slot reference: "$weapon:RightHand.spriteId" /
      // "weapon:RightHand.spriteId" → raw field value, no coercion.
      if ((v.startsWith("$weapon:") || v.startsWith("weapon:")) && !/\s/.test(v)) {
        const rest = v.slice(v.indexOf(":") + 1);
        return String(resolveWeaponExpr(sprite, rest));
      }
      // Whole-string picked reference: "picked.name" / "picked.uid" /
      // "picked.<varName>" → raw field value, no coercion. The optional
      // leading "$" mirrors the var/tracer style for consistency in
      // interpolated contexts.
      if ((v.startsWith("picked.") || v.startsWith("$picked.")) && !/\s/.test(v)) {
        const field = v.slice(v.indexOf(".") + 1);
        return resolvePickedString(sprite, field);
      }
      // Whole-string `choose(a, b, c, ...)` — pick one comma-separated entry
      // and evaluate it via strOr (so inner refs like `var:X` / `$self.name`
      // still resolve). Lazy: only the chosen branch evaluates.
      if ((v.startsWith("choose(") || v.startsWith("$choose(")) && v.endsWith(")")) {
        const inner = v.slice(v.indexOf("(") + 1, -1);
        const args = splitArgs(inner).map((a) => a.trim()).filter((a) => a.length > 0);
        if (args.length === 0) return fallback;
        const pick = args[Math.floor(Math.random() * args.length)];
        return strOr(pick, fallback, sprite);
      }
      // Whole-string `random.string(chars..., length)` — last arg is the
      // length, every preceding arg is a token to pick from with replacement.
      // Tokens can be single characters ("a", "b", "c") or multi-character
      // strings — the picker treats each comma-separated entry as one unit.
      // Empty if any required arg is missing.
      if ((v.startsWith("random.string(") || v.startsWith("$random.string(")) && v.endsWith(")")) {
        const inner = v.slice(v.indexOf("(") + 1, -1);
        const args = splitArgs(inner).map((a) => a.trim());
        if (args.length >= 2) {
          const lengthArg = args[args.length - 1];
          const length = Math.max(0, Math.floor(numOr(lengthArg, 0, sprite) || 0));
          const tokens = args.slice(0, -1).filter((t) => t.length > 0);
          if (tokens.length > 0 && length > 0) {
            let out = "";
            for (let i = 0; i < length; i++) {
              out += tokens[Math.floor(Math.random() * tokens.length)];
            }
            return out;
          }
        }
        return fallback;
      }
      // Whole-string lastTile reference — string fields (tilemap, layer)
      // are returned literally; numeric fields fall through to numOr via
      // resolveIdent. Empty string when no tile has been destroyed yet.
      if ((v.startsWith("lastTile.") || v.startsWith("$lastTile.")) && !/\s/.test(v)) {
        const field = v.slice(v.indexOf(".") + 1);
        // Damaged snapshot wins over destroyed when both are set this tick
        // (matches resolveIdent's preference). Numeric fields fall through
        // to numOr via resolveIdent.
        const damaged = sprite.scene?.data?.get("peaky.lastDamagedTile") as
          | { tilemap?: string; layer?: string }
          | undefined;
        const destroyed = sprite.scene?.data?.get("peaky.lastDestroyedTile") as
          | { tilemap?: string; layer?: string }
          | undefined;
        const last = damaged ?? destroyed;
        if (field === "tilemap") return last?.tilemap ?? "";
        if (field === "layer") return last?.layer ?? "";
        // For numeric fields let resolveExpr/numOr handle it; fall through.
      }
      // Whole-string global reference: "global:playerName" → the persistent
      // global's value. "global:arr.0" / "global:arr.length" index arrays.
      if ((v.startsWith("global:") || v.startsWith("$global:")) && !/\s/.test(v)) {
        const [name, acc] = splitStoreRef(v.slice(v.indexOf(":") + 1));
        const s = readStoreStr(persistentState().globals[name], acc);
        return s === undefined ? fallback : s;
      }
      // Whole-string read-only list reference: "list:prices.apple" / "list:prices.length".
      if ((v.startsWith("list:") || v.startsWith("$list:")) && !/\s/.test(v)) {
        const [name, acc] = splitStoreRef(v.slice(v.indexOf(":") + 1));
        const s = readListStr(persistentState().lists[name], acc);
        return s === undefined ? fallback : s;
      }
      // Interpolation: replace every "$var:NAME" / "$tracer:NAME.FIELD" /
      // "$picked.FIELD" inside the string with the resolved value. Users
      // can write "Clicked $picked.name (uid=$picked.uid)" and get the
      // picked sprite's data inlined.
      let out = v;
      if (out.includes("$tracer:")) {
        out = out.replace(/\$tracer:([A-Za-z_]\w*)?\.([A-Za-z_]\w*)/g, (_m, name: string | undefined, field: string) => {
          return String(resolveTracerExpr(sprite, `${name ?? ""}.${field}`));
        });
      }
      if (out.includes("$weapon:")) {
        out = out.replace(/\$weapon:([A-Za-z_]\w*)?\.([A-Za-z_]\w*)/g, (_m, name: string | undefined, field: string) => {
          return String(resolveWeaponExpr(sprite, `${name ?? ""}.${field}`));
        });
      }
      if (out.includes("$var:")) {
        // Captures optionally-dotted name: `$var:hp` or `$var:Player.x`.
        // The dot is matched literally; nested dots (e.g. `var:A.B.c`)
        // collapse the first segment as the target and the rest as the
        // field, matching resolveVarPath / resolveExpr semantics.
        out = out.replace(/\$var:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/g, (_m, path: string) => {
          const cur = resolveVarPath(sprite, path);
          return cur === undefined ? "" : String(cur);
        });
      }
      if (out.includes("$picked.")) {
        out = out.replace(/\$picked\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, field: string) => {
          return resolvePickedString(sprite, field);
        });
      }
      if (out.includes("$self.")) {
        out = out.replace(/\$self\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, field: string) => {
          const cur = resolveVarPath(sprite, `self.${field}`);
          return cur === undefined ? "" : String(cur);
        });
      }
      if (out.includes("$global:")) {
        out = out.replace(/\$global:([A-Za-z_]\w*(?:\.\w+)?)/g, (_m, ref: string) => {
          const [name, acc] = splitStoreRef(ref);
          return readStoreStr(persistentState().globals[name], acc) ?? "";
        });
      }
      if (out.includes("$list:")) {
        out = out.replace(/\$list:([A-Za-z_]\w*(?:\.\w+)?)/g, (_m, ref: string) => {
          const [name, acc] = splitStoreRef(ref);
          return readListStr(persistentState().lists[name], acc) ?? "";
        });
      }
      if (out !== v) return out;
    }
  }
  return v == null ? fallback : String(v);
}

/**
 * Resolve the working sprite for a condition or action based on its
 * Construct-3-style `subject` field. Returns the host `sprite` when
 * subject is missing / "self" / "system" / "mouse" / "keyboard" / "world"
 * (those subjects don't redirect — they operate scene-globally or against
 * the host). For "bp" / "uiwidget", looks up the most recent picked
 * instance of that BP from `peaky.picked`; falls back to the first live
 * instance if nothing has been picked yet.
 *
 * Returns null when the subject is "bp:<id>" but no live instance exists.
 * Callers should treat null as "skip this evaluation" (condition false /
 * action no-op).
 */
export function resolveSubjectSprite(sprite: Sprite, subject?: import("@peaky/shared").Subject): Sprite | null {
  if (!subject || subject.kind === "self" || subject.kind === "system" ||
      subject.kind === "mouse" || subject.kind === "keyboard") {
    return sprite;
  }
  if ((subject.kind === "bp" || subject.kind === "uiwidget") && subject.bpId) {
    const wantedName = subject.instanceName?.trim();
    // Prefer the chain's picked sprite if it matches the requested BP
    // (and instance name when set) — lets a condition pick one instance
    // and downstream actions in the same chain target THAT instance.
    const picked = sprite.scene.data.get("peaky.picked") as Sprite | undefined;
    if (picked && !picked.destroyed && picked.blueprintId === subject.bpId
        && (!wantedName || picked.instanceName === wantedName)) {
      return picked;
    }
    const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const firstLive = all.find((s) =>
      !s.destroyed && s.blueprintId === subject.bpId &&
      (!wantedName || s.instanceName === wantedName),
    );
    return firstLive ?? null;
  }
  return sprite;
}

/**
 * Plural Sprite Object List (SOL) resolver — Construct's per-event picked
 * set. When a condition with `subject: bp:X` matches, runtime stores all
 * matching X instances into `peaky.pickedSets[X]`. Subsequent actions
 * with the same subject act on EVERY sprite in the set (Construct's "for
 * each picked instance" semantics).
 *
 * Returns:
 *   - subject = self / system / mouse / keyboard / world → [sprite] (the host).
 *   - subject = bp:X / uiwidget:X with non-empty pickedSets[X] → those sprites.
 *   - subject = bp:X / uiwidget:X with empty pickedSets[X] (no prior pick) →
 *     all live instances of X (Construct's "implicit pick all" default).
 *   - subject = bp:X with no live instances → [] (action skipped entirely).
 */
export function resolveSubjectSprites(sprite: Sprite, subject?: import("@peaky/shared").Subject): Sprite[] {
  if (!subject || subject.kind === "self" || subject.kind === "system" ||
      subject.kind === "mouse" || subject.kind === "keyboard") {
    return [sprite];
  }
  if ((subject.kind === "bp" || subject.kind === "uiwidget") && subject.bpId) {
    const wantedName = subject.instanceName?.trim();
    const sets = sprite.scene.data.get("peaky.pickedSets") as Map<string, Sprite[]> | undefined;
    const set = sets?.get(subject.bpId);
    const filterByName = (arr: Sprite[]) =>
      wantedName ? arr.filter((s) => s.instanceName === wantedName) : arr;
    if (set && set.length > 0) {
      return filterByName(set.filter((s) => !s.destroyed));
    }
    // No prior pick → implicit "pick all" of that BP (filtered by
    // instanceName when the subject narrows to a specific placement).
    const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    return filterByName(all.filter((s) => !s.destroyed && s.blueprintId === subject.bpId));
  }
  return [sprite];
}

/**
 * Evaluate an event guard against a sprite — RAW result, no `not` flip.
 *
 * Guards are pure synchronous queries — no event consumption, no time tracking.
 * The trigger half is matched separately by the per-event runner on `Sprite`.
 *
 * NOTE: This intentionally does NOT apply `c.not` — the only caller
 * (Sprite.evalOneCondition) applies it uniformly across triggers / Else /
 * state checks. Applying it here too would cancel the outer flip and make
 * NOT-conditions behave as their non-inverted counterparts.
 *
 * Subject resolution: when `c.subject` selects a different BP than the
 * host, the condition evaluates AGAINST that picked instance — and on
 * a successful match the instance is stamped as `peaky.picked` so the
 * chain's downstream actions can target it.
 */
export function evaluateCondition(sprite: Sprite, c: Condition): boolean {
  const subj = c.subject;
  // Plural SOL filter — when subject is bp/uiwidget, the condition acts
  // as a FILTER over the chain's current pick set for that BP. If the
  // pick set is empty (no prior pick), start from all live instances.
  // Survivors become the new pickedSets[bpId]. Returns true iff any
  // survived. Single-pick `peaky.picked` is also written when exactly
  // one survives, so picked.* expressions still resolve in inline use.
  if (subj && (subj.kind === "bp" || subj.kind === "uiwidget") && subj.bpId) {
    if (sprite.blueprintId === subj.bpId) {
      // Already evaluating on a sprite of the requested BP (e.g. via
      // §10 trigger redirect that ran us per-instance). Skip the SOL
      // filter — the per-instance evaluator decides match/no-match.
      return evalConditionRaw(sprite, c);
    }
    const sets = (sprite.scene.data.get("peaky.pickedSets") as Map<string, Sprite[]> | undefined) ?? new Map<string, Sprite[]>();
    let candidates = sets.get(subj.bpId);
    if (!candidates || candidates.length === 0) {
      const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      candidates = all.filter((s) => !s.destroyed && s.blueprintId === subj.bpId);
    } else {
      candidates = candidates.filter((s) => !s.destroyed);
    }
    const survivors = candidates.filter((cand) => evalConditionRaw(cand, c));
    sets.set(subj.bpId, survivors);
    sprite.scene.data.set("peaky.pickedSets", sets);
    if (survivors.length === 1) sprite.scene.data.set("peaky.picked", survivors[0]);
    return survivors.length > 0;
  }
  // Self / system / mouse / keyboard / world — no plural fan-out.
  return evalConditionRaw(sprite, c);
}

function evalConditionRaw(sprite: Sprite, c: Condition): boolean {
  switch (c.kind) {
    case "Always":
    case "OnStep":
      // OnStep is an alias for Always — fires every tick. Both are continuous
      // state checks (never inverted into Never).
      return true;
    case "Compare":
      return evaluateCompare(sprite, c);
    case "IsMoving":
      // HORIZONTAL speed only — matches the node's description and the sidescroller
      // use case. For topdown / omni-directional movement use IsMovingAny, which
      // treats both axes. Threshold low (0.1 px/s) so the deceleration tail reads
      // false the moment the user stops inputting.
      return Math.abs(sprite.body.velocity.x) > 0.1;
    case "IsMovingTo": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { enabled: boolean; _moving?: boolean }
        | undefined;
      if (!mt || !mt.enabled) return false;
      // `_moving` is set true on any tick MoveTo drives the body toward a
      // target (every mode). The old `_target` check failed in POSITION mode,
      // which never sets `_target` — so a sheep walking to a tile read "not
      // moving" and its Walk state never played.
      return !!mt._moving;
    }
    case "HasArrived": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { enabled: boolean; _moving?: boolean; navPath?: unknown; _target?: unknown; _arrivedFor?: unknown }
        | undefined;
      if (!mt) return false;
      // Object/tag chase: the latch must match the CURRENT chased sprite.
      if (mt._target) return mt._arrivedFor === mt._target;
      // Position / nav-point / patrol: those modes never set `_target`, but they
      // latch `_arrivedFor` on arrival. Arrived = a latch exists, not currently
      // steering, and no path in progress.
      return mt._arrivedFor != null && !mt._moving && !mt.navPath;
    }
    case "IsFacingLeft":
      // CharacterMovement (and any other mirroring code) writes a negative
      // facingScaleX when the sprite faces left. Keeps its value while
      // idle, so this stays true between movements unlike IsMovingLeft.
      // (Body's own scaleX stays positive — flipping it would drift the
      // arcade body off the visual.)
      return sprite.facingScaleX < 0;
    case "IsFacingRight":
      return sprite.facingScaleX >= 0;
    case "IsMovingLeft":
      return sprite.body.velocity.x < -0.1;
    case "IsMovingRight":
      return sprite.body.velocity.x > 0.1;
    case "IsMovingUp":
      return sprite.body.velocity.y < -0.1;
    case "IsMovingDown":
      return sprite.body.velocity.y > 0.1;
    case "IsRunning": {
      // Running = grounded + moving horizontally + NOT in a special move.
      // Without the dash exclusion, a ground dash registers as both
      // IsDashing AND IsRunning, so the user's "set Run animation while
      // IsRunning" event overrides the dash animation mid-dash.
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (cm?.dashing === true) return false;
      return (sprite.body.blocked.down || sprite.body.touching.down) && Math.abs(sprite.body.velocity.x) > 0.1;
    }
    case "IsGrounded":
      return sprite.body.blocked.down || sprite.body.touching.down;
    case "IsJumping":
      return !(sprite.body.blocked.down || sprite.body.touching.down) && sprite.body.velocity.y < 0;
    case "IsFalling":
      return !(sprite.body.blocked.down || sprite.body.touching.down) && sprite.body.velocity.y > 0;
    case "IsDashing": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      return cm?.dashing === true;
    }
    case "IsWallSliding": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      return cm?.wallSliding === true;
    }
    case "IsByWall": {
      // Probe a thin AABB (3 px) just outside each side of the body for a
      // Solid sprite. Works regardless of input or velocity — Phaser's
      // `blocked`/`touching` flags only fire DURING collision resolution,
      // so they go false the moment the player stops pushing into the wall
      // even when visibly pressed against it.
      return isNearSolid(sprite, -1, 3) || isNearSolid(sprite, 1, 3);
    }
    case "IsByWallLeft":
      return isNearSolid(sprite, -1, 3);
    case "IsByWallRight":
      return isNearSolid(sprite, 1, 3);
    case "IsDoubleJumpEnabled": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      return (cm?.multiJump ?? 1) > 1;
    }
    case "IsWallJumping": {
      const cm = sprite.findBehaviorByKind("CharacterMovement") as { wallJumpedAtSec?: number; now?: number } | undefined;
      if (!cm || cm.wallJumpedAtSec === undefined || cm.now === undefined) return false;
      if (cm.now - cm.wallJumpedAtSec > 1.0) return false;
      return sprite.body.velocity.y < 0;
    }
    case "IsBehaviorEnabled": {
      const name = String(c.behavior ?? "").trim();
      if (!name) return false;
      const b = sprite.findBehaviorByKind(name);
      return b ? b.enabled : false;
    }
    case "CanJump": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) return false;
      const used = cm.jumpsUsed ?? 0;
      const max = cm.multiJump ?? 1;
      return used < max;
    }
    case "CanDash": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm || !cm.dashEnabled || cm.dashing) return false;
      const now = sprite.scene.time.now / 1000;
      return now >= (cm.dashReadyAtSec ?? 0);
    }
    case "CompareCMParam": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) return false;
      const name = String(c.cmParam ?? "");
      if (!name) return false;
      // Reject unknown / private params using the same allow-list `CMSet`
      // uses on the write side. Without this, a typo'd `cmParam` could
      // read internal state like `_jumpAscentEndsAt`, leaking implementation
      // details into game logic.
      if (!isWritableBehaviorParam("CharacterMovement", name)) return false;
      const lhs = (cm as unknown as Record<string, unknown>)[name];
      const left = typeof lhs === "boolean" ? (lhs ? 1 : 0)
                 : typeof lhs === "number" ? lhs : Number(lhs);
      if (Number.isNaN(left)) return false;
      // numOr so users can write `var:bossMaxSpeed` / `self.x + 10` /
      // expressions on the right side too.
      const right = numOr(c.value, 0, sprite);
      const op = c.op ?? "==";
      switch (op) {
        case ">": return left > right;
        case "<": return left < right;
        case ">=": return left >= right;
        case "<=": return left <= right;
        case "==": return left === right;
        case "!=": return left !== right;
      }
      return false;
    }
    case "CompareTMParam": {
      const tm = sprite.findBehaviorByKind("TopdownMovement");
      if (!tm) return false;
      const name = String(c.tmParam ?? "");
      if (!name) return false;
      if (!isWritableBehaviorParam("TopdownMovement", name)) return false;
      const lhs = (tm as unknown as Record<string, unknown>)[name];
      const left = typeof lhs === "boolean" ? (lhs ? 1 : 0)
                 : typeof lhs === "number" ? lhs : Number(lhs);
      if (Number.isNaN(left)) return false;
      const right = numOr(c.value, 0, sprite);
      const op = c.op ?? "==";
      switch (op) {
        case ">": return left > right;
        case "<": return left < right;
        case ">=": return left >= right;
        case "<=": return left <= right;
        case "==": return left === right;
        case "!=": return left !== right;
      }
      return false;
    }
    case "IsMovingDir": {
      // True while moving (>8 px/s) in the requested 8-way direction. Same
      // bucketing as the animator's facingDir but momentary (reads velocity).
      const vx = sprite.body.velocity.x, vy = sprite.body.velocity.y;
      if (Math.hypot(vx, vy) <= 8) return false;
      const dirs = ["right", "downright", "down", "downleft", "left", "upleft", "up", "upright"];
      const idx = ((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8;
      return dirs[idx] === String(c.direction ?? "");
    }
    case "IsTopdownFacing": {
      // Sticky 4-way facing — survives key release. Reads `facingDir` off the
      // host's TopdownMovement behavior. Defaults to "down" so a brand-new
      // sprite that hasn't moved yet has predictable behaviour.
      const tm = sprite.findBehaviorByKind("TopdownMovement") as { facingDir?: string } | undefined;
      if (!tm) return false;
      return (tm.facingDir ?? "down") === String(c.direction ?? "");
    }
    case "IsActionHeld": {
      const name = (c.action ?? "").trim();
      if (!name) return false;
      const ia = getInputActions(sprite.scene);
      return ia ? ia.isDown(name) : false;
    }
    case "InputCombo": {
      const ia = getInputActions(sprite.scene);
      const rows = c.comboKeys ?? [];
      if (!ia || rows.length === 0) return false;
      // ALL rows must match THIS frame. `pressed`/`released` are frame
      // edges (justPressed/justReleased), `held` is the live down-state.
      // A combo with one `pressed` row edge-fires once on that press,
      // gated by the `held` rows — no time window to leak into the next
      // press (the bug with OnKeyHeld → WaitForKeyPress).
      for (const r of rows) {
        const a = (r.action ?? "").trim();
        if (!a) return false;
        const ok = r.mode === "pressed" ? ia.justPressed(a)
          : r.mode === "released" ? ia.justReleased(a)
          : ia.isDown(a);
        if (!ok) return false;
      }
      return true;
    }
    case "OnKeyHeld": {
      // Multi-action variant of IsActionHeld — true while ANY listed input
      // map is held (OR semantics). The condition's `actions` array carries
      // the input map names.
      const names = c.actions ?? [];
      if (names.length === 0) return false;
      const ia = getInputActions(sprite.scene);
      if (!ia) return false;
      return names.some((n) => n && ia.isDown(n));
    }
    case "IsAnimationPlaying": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) return false;
      const target = (c.animation ?? "").trim();
      if (target === "") return !!sr.currentAnimation;
      return sr.currentAnimation === target;
    }
    case "IsStateEnabled": {
      // True iff the named state exists on the host's animator AND its
      // enabled flag is non-zero (undefined === enabled, the default).
      const an = sprite.findBehaviorByKind("StateMachine") as { states?: Array<{ name: string; enabled?: number }> } | undefined;
      if (!an || !Array.isArray(an.states)) return false;
      const name = (c.state ?? "").trim();
      if (!name) return false;
      const row = an.states.find((s) => s.name === name);
      if (!row) return false;
      return row.enabled !== 0;
    }
    case "IsState": {
      const an = sprite.findBehaviorByKind("StateMachine") as { currentState?: string } | undefined;
      const target = (c.state ?? "").trim();
      if (!target) return false;
      return an?.currentState === target;
    }
    case "PreviousStateWas": {
      const an = sprite.findBehaviorByKind("StateMachine") as { previousState?: string } | undefined;
      const target = (c.state ?? "").trim();
      if (!target) return false;
      return an?.previousState === target;
    }
    case "PreviousAnimWas": {
      const an = sprite.findBehaviorByKind("StateMachine") as { previousAnim?: string } | undefined;
      const target = (c.animation ?? "").trim();
      if (!target) return false;
      return an?.previousAnim === target;
    }
    case "SignalFiredEdge": {
      const name = (c.signal ?? "").trim();
      if (!name) return false;
      return sprite.events.firedExactlyThisFrame(name);
    }
    case "InputBuffered": {
      const name = (c.action ?? "").trim();
      if (!name) return false;
      const an = sprite.findBehaviorByKind("StateMachine") as { _bufferedInputAtMs?: Map<string, number>; inputBufferMs?: number } | undefined;
      if (!an || !an._bufferedInputAtMs || (an.inputBufferMs ?? 0) <= 0) return false;
      const stampMs = an._bufferedInputAtMs.get(name);
      if (stampMs === undefined) return false;
      return (sprite.scene.time.now - stampMs) <= (an.inputBufferMs ?? 0);
    }
    case "JustTurnedLeft": {
      const an = sprite.findBehaviorByKind("StateMachine") as { _justTurnedLeft?: boolean } | undefined;
      return !!an?._justTurnedLeft;
    }
    case "JustTurnedRight": {
      const an = sprite.findBehaviorByKind("StateMachine") as { _justTurnedRight?: boolean } | undefined;
      return !!an?._justTurnedRight;
    }
    case "JustWallJumped": {
      const cm = sprite.findBehaviorByKind("CharacterMovement") as { wallJumpedAtSec?: number; now?: number } | undefined;
      if (!cm || cm.wallJumpedAtSec === undefined || cm.now === undefined) return false;
      return cm.now - cm.wallJumpedAtSec < 0.12;
    }
    case "JustCollidedWithTag": {
      const tag = (c.tag ?? "").trim();
      if (!tag) return false;
      const set = (sprite as unknown as { _justCollidedThisTick?: Set<{ tags: Set<string> }> })._justCollidedThisTick;
      if (!set) return false;
      for (const other of set) if (other.tags.has(tag)) return true;
      return false;
    }
    case "JustSeparatedFromTag": {
      const tag = (c.tag ?? "").trim();
      if (!tag) return false;
      const set = (sprite as unknown as { _justSeparatedThisTick?: Set<{ tags: Set<string> }> })._justSeparatedThisTick;
      if (!set) return false;
      for (const other of set) if (other.tags.has(tag)) return true;
      return false;
    }
    case "IsOverlappingTag": {
      const tag = (c.tag ?? "").trim();
      if (!tag) return false;
      const set = (sprite as unknown as { _currOverlap?: Set<{ tags: Set<string> }> })._currOverlap;
      if (!set) return false;
      for (const other of set) if (other.tags.has(tag)) return true;
      return false;
    }
    case "IsAirborne": {
      const b = sprite.body;
      if (!b) return false;
      return !(b.blocked.down || b.touching.down);
    }
    case "IsAIState": {
      const ai = sprite.findBehaviorByKind("AIBrain") as { state?: string } | undefined;
      const want = String(c.action ?? "").trim();
      if (!ai || !want) return false;
      return ai.state === want;
    }
    case "IsMovingAny": {
      const b = sprite.body;
      if (!b) return false;
      const threshold = numOr(c.value, 0, sprite);
      return Math.hypot(b.velocity.x, b.velocity.y) > threshold;
    }
    case "HasTag": {
      const tag = (c.tag ?? "").trim();
      return !!tag && sprite.tags.has(tag);
    }
    case "HasAnyTag": {
      const list = (c.tags ?? []).map((t) => t.trim()).filter(Boolean);
      if (list.length === 0) return false;
      for (const t of list) if (sprite.tags.has(t)) return true;
      return false;
    }
    case "HasAllTags": {
      const list = (c.tags ?? []).map((t) => t.trim()).filter(Boolean);
      if (list.length === 0) return false;
      for (const t of list) if (!sprite.tags.has(t)) return false;
      return true;
    }
    case "IsDead": {
      const d = sprite.findBehaviorByKind("Damageable") as { isDead?: boolean } | undefined;
      return !!d?.isDead;
    }
    case "IsInHitstun": {
      const d = sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
      return !!d?.isInHitstun?.();
    }
    case "IsInIframes": {
      const d = sprite.findBehaviorByKind("Damageable") as { isInIframes?: () => boolean } | undefined;
      return !!d?.isInIframes?.();
    }
    case "HasAITarget": {
      const brain = sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
      return !!brain && (brain.targetUid ?? -1) !== -1;
    }
    case "NoAITarget": {
      const brain = sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
      return !brain || (brain.targetUid ?? -1) === -1;
    }
    case "IsSignalFiring": {
      const name = (c.signal ?? "").trim();
      if (!name) return false;
      return sprite.events.firedThisFrame(name);
    }
    case "CompareValues": {
      // Read as a plain string so the string-only operators (contains /
      // startsWith / endsWith) work even though they aren't in CompareOp.
      const op: string = c.op ?? "==";
      const left = resolveExpr(sprite, c.left);
      const right = resolveExpr(sprite, c.right);
      // String-match operators always coerce both sides to text — this is
      // what lets you test e.g. `tracer:T.actorTags contains "shop"`,
      // `picked.name startsWith "Boss"`, etc. Only the LEFT side is guarded
      // for emptiness: an empty RIGHT ("") is a legitimate query.
      if (op === "contains" || op === "startsWith" || op === "endsWith") {
        if (left === undefined || left === null || left === "") return false;
        const ls = String(left);
        const rs = String(right ?? "");
        switch (op) {
          case "contains":   return ls.includes(rs);
          case "startsWith": return ls.startsWith(rs);
          case "endsWith":   return ls.endsWith(rs);
        }
      }
      // Safety net: when EITHER side is unresolved (undefined / empty
      // string from a half-configured row), fall back to FALSE rather
      // than string-comparing "" against the other side — which would
      // produce surprising "always true" / "always false" matches.
      // Pre-fix this caused the canonical Player.coins < World.gold to
      // always fire because LEFT was empty and "" < "<anything>" = true.
      const leftEmpty = left === undefined || left === null || left === "";
      const rightEmpty = right === undefined || right === null || right === "";
      if (leftEmpty || rightEmpty) return false;
      // Numeric compare when both sides parse as numbers; otherwise string.
      const ln = typeof left === "number" ? left : Number(left);
      const rn = typeof right === "number" ? right : Number(right);
      const bothNumeric = !Number.isNaN(ln) && !Number.isNaN(rn);
      if (bothNumeric) {
        switch (op) {
          case ">": return ln > rn;
          case "<": return ln < rn;
          case ">=": return ln >= rn;
          case "<=": return ln <= rn;
          case "==": return ln === rn;
          case "!=": return ln !== rn;
        }
      }
      const ls = String(left);
      const rs = String(right);
      switch (op) {
        case "==": return ls === rs;
        case "!=": return ls !== rs;
        case ">": return ls > rs;
        case "<": return ls < rs;
        case ">=": return ls >= rs;
        case "<=": return ls <= rs;
      }
      return false;
    }
    case "IsBetween": {
      const name = String(c.varName ?? "").trim();
      if (!name) return false;
      const v = varToNum(sprite.vars.get(name), NaN);
      if (Number.isNaN(v)) return false;
      // Run min/max through numOr so users can write `var:floor` / arithmetic
      // expressions on either side, matching `CompareValues`.
      const min = numOr(c.min, -Infinity, sprite);
      const max = numOr(c.max, Infinity, sprite);
      return v >= min && v <= max;
    }
    case "CompareTime": {
      const op = c.op ?? ">";
      // Resolve through numOr so `var:checkpointTime` / arithmetic
      // expressions work — was a literal-only `c.value ?? 0` before.
      const v = numOr(c.value, 0, sprite);
      const elapsed = sprite.scene.time.now / 1000; // seconds since scene start
      switch (op) {
        case ">": return elapsed > v;
        case "<": return elapsed < v;
        case ">=": return elapsed >= v;
        case "<=": return elapsed <= v;
        case "==": return Math.floor(elapsed) === Math.floor(v);
        case "!=": return Math.floor(elapsed) !== Math.floor(v);
      }
      return false;
    }
    case "IsMouseButtonHeld": {
      if (pointerOverUiBlocker(sprite.scene)) return false; // over a blocking UI widget
      const btn = typeof c.button === "number" ? c.button : 0;
      const ptr = sprite.scene.input.activePointer;
      if (btn === 0) return ptr.leftButtonDown();
      if (btn === 1) return ptr.middleButtonDown();
      if (btn === 2) return ptr.rightButtonDown();
      return false;
    }
    case "Repeat":
    case "While":
    case "ForEach":
      // Loop meta-conditions — never gate the event. The action runner reads
      // them and loops the action list. Always true; iteration is handled in
      // Sprite.tryFire.
      return true;
    case "ObjectUIDExists": {
      const uid = c.uid;
      if (uid === undefined || uid === "") return false;
      const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const target = Number(uid);
      return list.some((s) => s.uid === target);
    }
    case "PickAll":
    case "PickRandom":
    case "PickByHighest":
    case "PickByLowest":
    case "PickNth":
    case "PickByComparison":
      // Picking conditions filter the event's action target set. They're true
      // iff the resolved pick set is non-empty; the actual targeting happens
      // in Sprite.tryFire which reads these conditions and runs actions
      // against each picked sprite.
      return resolvePickSet(sprite, c).length > 0;
    case "IsBoolean": {
      const name = String(c.varName ?? "").trim();
      if (!name) return false;
      const v = sprite.vars.get(name);
      const expected = c.expected !== false; // default true
      const asBool = typeof v === "boolean" ? v : (typeof v === "number" ? v !== 0 : !!v);
      return asBool === expected;
    }
    case "CompareFrame": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) return false;
      // If user picked an animation name, only match when SR is playing it.
      const target = (c.animation ?? "").trim();
      if (target && sr.currentAnimation !== target) return false;
      const frame = typeof sr.currentFrameIdx === "number" ? sr.currentFrameIdx : 0;
      const op = c.op ?? "==";
      // numOr so `var:flashFrame` / arithmetic works.
      const v = numOr(c.value, 0, sprite);
      let matches = false;
      switch (op) {
        case ">":  matches = frame >  v; break;
        case "<":  matches = frame <  v; break;
        case ">=": matches = frame >= v; break;
        case "<=": matches = frame <= v; break;
        case "==": matches = frame === v; break;
        case "!=": matches = frame !== v; break;
      }
      if (!matches) return false;
      // Edge-only: this condition fires ONCE per anim-frame entry, not
      // every tick the frame stays current. Without this, an event with
      // `CompareFrame == 7 → EmitSignal` would emit ~5 times per visit
      // at a typical 12-fps anim on a 60-fps loop. The edge is detected
      // by checking whether the SR's `frameEnteredAtTick` is the current
      // game loop frame — true only on the tick the index just changed.
      // Inequality ops (>, <, >=, <=, !=) match a RANGE of frames, so
      // the edge is "first tick this range becomes true". Same logic
      // works there because `frameEnteredAtTick` changes whenever the
      // index changes — including transitions across the boundary.
      const currentTick = sprite.scene.game.loop.frame;
      return sr.frameEnteredAtTick === currentTick;
    }
    case "CompareText": {
      const t = sprite.findBehaviorByKind("Text");
      if (!t) return false;
      const left = String(t.content ?? "");
      const right = strOr(c.textValue, "", sprite);
      switch (c.textOp ?? "==") {
        case "==": return left === right;
        case "!=": return left !== right;
        case "contains": return left.includes(right);
        case "startsWith": return left.startsWith(right);
        case "endsWith": return left.endsWith(right);
      }
      return false;
    }
    case "IsTextVisible": {
      const t = sprite.findBehaviorByKind("Text");
      return !!t && (t.visible ?? 1) !== 0;
    }
    case "IsDialoguePlaying": {
      // Dialogue is a scene-level singleton (peaky.dialogue), not per-sprite.
      const runner = sprite.scene.data.get("peaky.dialogue") as { isPlaying?: () => boolean } | undefined;
      return !!runner?.isPlaying?.();
    }
    case "IsAnimatorAnimPlaying": {
      const a = sprite.findBehaviorByKind("SmartTween") as { isPlaying?: (n: string) => boolean } | undefined;
      const name = c.action ?? "";
      return !!a?.isPlaying?.(name);
    }
    case "IsCameraShaking": {
      // Camera state is global to the scene's main camera, not per-sprite.
      // Read it directly so this works regardless of which sprite owns
      // the Camera behavior (or even if none does).
      return !!sprite.scene.cameras.main.shakeEffect.isRunning;
    }
    case "IsCameraPanning": {
      return !!sprite.scene.cameras.main.panEffect.isRunning;
    }
    case "IsCameraLocked": {
      const cam = sprite.findBehaviorByKind("Camera");
      return !!cam && (cam.locked ?? 0) !== 0;
    }
    case "CompareCameraZoom": {
      const z = sprite.scene.cameras.main.zoom;
      const op = c.op ?? "==";
      const v = c.value ?? 1;
      switch (op) {
        case ">":  return z >  v;
        case "<":  return z <  v;
        case ">=": return z >= v;
        case "<=": return z <= v;
        case "==": return z === v;
        case "!=": return z !== v;
      }
      return false;
    }
    case "IsTracerHit": {
      const tracer = findTracer(sprite, c.tracer ?? "");
      return !!tracer?.lastHit;
    }
    case "TracerHitHasTag": {
      const tracer = findTracer(sprite, c.tracer ?? "");
      const tag = (c.tagValue ?? "").trim();
      if (!tracer?.lastHit || !tag) return false;
      return tracer.lastHit.actorTags.includes(tag);
    }
    case "IsTweenPlaying": {
      const tag = (c.tweenTag ?? "").trim();
      if (tag === "") {
        // Empty tag = "any tween playing on this sprite".
        for (const [, entry] of sprite.tweens) {
          if (entry.tween.isPlaying()) return true;
        }
        return false;
      }
      // Match ANY tween at this tag (across props).
      for (const [, entry] of sprite.tweens) {
        if (entry.tag === tag && entry.tween.isPlaying()) return true;
      }
      return false;
    }
    case "IsTweenPaused": {
      const tag = (c.tweenTag ?? "").trim();
      if (tag === "") {
        for (const [, entry] of sprite.tweens) {
          if (entry.tween.isPaused()) return true;
        }
        return false;
      }
      for (const [, entry] of sprite.tweens) {
        if (entry.tag === tag && entry.tween.isPaused()) return true;
      }
      return false;
    }
    case "IsAnyTweenPlaying": {
      for (const [, entry] of sprite.tweens) {
        if (entry.tween.isPlaying()) return true;
      }
      return false;
    }
    case "IsEmittingParticles": {
      // Per-emitter filter via `target`. Empty target = true if ANY
      // emitter on the BP is currently active.
      const ems = resolveEmitters(sprite, c as unknown as Record<string, unknown>);
      return ems.some((e) => e.isActive());
    }
    case "IsParticleEmitterEnabled": {
      const ems = resolveEmitters(sprite, c as unknown as Record<string, unknown>);
      return ems.some((e) => e.enabled);
    }
    case "CompareParticleCount": {
      // Sum of alive counts across matching emitters; named target
      // narrows to that one emitter, empty target sums every emitter.
      const ems = resolveEmitters(sprite, c as unknown as Record<string, unknown>);
      if (ems.length === 0) return false;
      let count = 0;
      for (const e of ems) count += e.getAliveCount();
      const op = c.op ?? ">";
      const v = numOr(c.value, 0, sprite);
      switch (op) {
        case ">":  return count >  v;
        case "<":  return count <  v;
        case ">=": return count >= v;
        case "<=": return count <= v;
        case "==": return count === v;
        case "!=": return count !== v;
      }
      return false;
    }
    case "IsMusicPlaying": {
      const sm = getSoundManager(sprite.scene);
      if (!sm) return false;
      const name = (c.sound ?? "").trim();
      return sm.isMusicPlaying(name || undefined);
    }
    case "IsSoundPlaying": {
      const sm = getSoundManager(sprite.scene);
      const name = (c.sound ?? "").trim();
      if (!sm || !name) return false;
      return sm.isSfxPlaying(name);
    }
    case "IsLoading":
      // peaky.isLoading is set true by ScenePanel between the GoToLayoutWithLoad
      // dispatch and the target scene swap. Useful for blocking input,
      // pausing AI, or displaying a "Loading..." sub-message.
      return !!sprite.scene.data.get("peaky.isLoading");
    case "IsScene": {
      const want = (c.scene ?? "").trim();
      if (!want) return false;
      // runProject stashes the layout name on scene.data when the scene
      // boots. Falls back to the Phaser scene key if missing.
      const cur = String(sprite.scene.data.get("peaky.activeSceneName") ?? sprite.scene.scene.key ?? "");
      return cur === want;
    }
    case "IsPaused": {
      const scope = c.scope ?? "all";
      if (scope === "layer") {
        const layerName = (c.layer ?? "").trim();
        if (!layerName) return false;
        const idByName = sprite.scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
        const layerId = idByName?.[layerName];
        const set = sprite.scene.data.get("peaky.pausedLayers") as Set<string> | undefined;
        return !!layerId && !!set && set.has(layerId);
      }
      return sprite.scene.data.get("peaky.pauseAll") === true;
    }
    case "HasItem": {
      const inv = sprite.findBehaviorByKind("Inventory");
      if (!inv) return false;
      const need = typeof c.value === "number" ? c.value : 1;
      return inv.countItem((c.item ?? "").trim()) >= need;
    }
    case "InventoryIsFull": {
      const inv = sprite.findBehaviorByKind("Inventory");
      return inv ? inv.isFull() : false;
    }
    // Trigger conditions, TriggerOnceWhileTrue, and Else are handled by
    // Sprite's evalTrigger / evaluateConditions — they never produce a raw
    // truth value here. Listing them explicitly keeps the exhaustiveness
    // check below honest: adding a new ConditionKind to the union is a hard
    // compile error until it's wired up here OR added to this list.
    case "OnCreate":
    case "OnDestroyed":
    case "OnKeyPressed":
    case "OnKeyReleased":
    case "OnCollide":
    case "OnOverlap":
    case "OnAnimationEnd":
    case "OnAnyAnimationEnd":
    case "OnLand":
    case "OnJump":
    case "OnFall":
    case "OnDashStart":
    case "OnDashEnd":
    case "OnMoved":
    case "OnStopped":
    case "OnSignal":
    case "OnCollideWithSpriteObject":
    case "OnOverlapWithSpriteObject":
    case "OnSpriteObjectCreate":
    case "OnSpriteObjectDestroy":
    case "HasSpriteObjectTag":
    case "OnSceneStart":
    case "OnSceneEnd":
    case "OnLoadStart":
    case "OnLoadProgress":
    case "OnLoadComplete":
    case "OnSaveLoadComplete":
    case "OnCameraPanEnd":
    case "EveryXSeconds":
    case "OnMouseButtonPressed":
    case "OnMouseButtonReleased":
    case "OnMouseClick":
    case "OnMouseDoubleClick":
    case "OnMouseWheel":
    case "OnObjectClicked":
    case "OnObjectDoubleClicked":
    case "TracerJustHit":
    case "OnTweenStart":
    case "OnTweenFinish":
    case "OnParticleBurstEnd":
    case "OnTileDestroyed":
    case "OnTileDamaged":
    case "TriggerOnceWhileTrue":
    case "Else":
      return false;
    case "IsCursorOverObject": {
      // Continuous: true while cursor is over a sprite that matches the
      // configured filter.
      //   • `targetBpId` set → match sprites whose blueprintId === id.
      //   • `tags[]` non-empty → match sprites carrying any of those tags.
      //   • Both set → intersection.
      //   • Neither set → ANY sprite under the cursor.
      const tags = c.tags ?? [];
      const targetBpId = c.targetBpId;
      const ptr = sprite.scene.input.activePointer;
      const cam = sprite.scene.cameras?.main;
      const wx = ptr.worldX ?? (ptr.x + (cam?.scrollX ?? 0));
      const wy = ptr.worldY ?? (ptr.y + (cam?.scrollY ?? 0));
      // Build the candidate list cheaper than scanning every sprite:
      //   • tags set → union of tag-index buckets (typically tens).
      //   • tags empty → full sprite list (no avoiding it).
      // At 5000 NPCs this turns a 5000-element per-tick scan into a
      // ~tag-bucket-sized scan. (audit HIGH #48, #51)
      let candidates: Iterable<Sprite>;
      if (tags.length > 0) {
        const byTag = sprite.scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
        if (!byTag) return false;
        const merged = new Set<Sprite>();
        for (const t of tags) {
          if (!t) continue;
          const bucket = byTag.get(t);
          if (bucket) for (const s of bucket) merged.add(s);
        }
        candidates = merged;
      } else {
        candidates = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      }
      for (const s of candidates) {
        if (s.destroyed || !s.body) continue;
        if (targetBpId && s.blueprintId !== targetBpId) continue;
        const b = s.body;
        if (wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom) return true;
      }
      return false;
    }
    case "CompareTileAt": {
      const tm = findTilemap(sprite.scene, (c.tilemap ?? "").trim());
      if (!tm) return false;
      const layerId = resolveLayerId(tm, (c.layer ?? "").trim());
      if (!layerId) return false;
      const idx = tm.getTileAt(layerId, Math.floor(c.c ?? 0), Math.floor(c.r ?? 0));
      return compareOp(idx, c.op ?? "==", c.value ?? 0);
    }
    case "CompareTileAtWorld": {
      const tm = findTilemap(sprite.scene, (c.tilemap ?? "").trim());
      if (!tm) return false;
      const layerId = resolveLayerId(tm, (c.layer ?? "").trim());
      if (!layerId) return false;
      const cell = tm.worldToCell(numOr(c.tileX, 0, sprite), numOr(c.tileY, 0, sprite));
      const idx = cell ? tm.getTileAt(layerId, cell.c, cell.r) : -1;
      return compareOp(idx, c.op ?? "==", c.value ?? 0);
    }
    case "IsTileSolidAt": {
      const tm = findTilemap(sprite.scene, (c.tilemap ?? "").trim());
      if (!tm) return false;
      const layerId = resolveLayerId(tm, (c.layer ?? "").trim());
      if (!layerId) return false;
      const cell = tm.worldToCell(numOr(c.tileX, 0, sprite), numOr(c.tileY, 0, sprite));
      if (!cell) return false;
      return tm.isSolidAt(layerId, cell.c, cell.r);
    }
    case "IsTileEmptyAt": {
      const tm = findTilemap(sprite.scene, (c.tilemap ?? "").trim());
      if (!tm) return false;
      const layerId = resolveLayerId(tm, (c.layer ?? "").trim());
      if (!layerId) return false;
      const cell = tm.worldToCell(numOr(c.tileX, 0, sprite), numOr(c.tileY, 0, sprite));
      if (!cell) return true; // out-of-bounds counts as empty (no tile there)
      return tm.isEmptyAt(layerId, cell.c, cell.r);
    }
    default: {
      const _exhaustive: never = c.kind;
      void _exhaustive;
      return false;
    }
  }
}

/** Apply a comparison operator to two numbers — used by tile/var compare
 *  conditions. Returns false on an unrecognised op for safety. */
function compareOp(left: number, op: import("@peaky/shared").CompareOp, right: number): boolean {
  switch (op) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return left > right;
    case "<": return left < right;
    case ">=": return left >= right;
    case "<=": return left <= right;
  }
  // Default-false on unrecognised op — TS exhaustiveness was relying on
  // `CompareOp` covering every case, but the runtime sees data from disk
  // (saves, network) that can carry corrupted op strings → undefined was
  // being returned and treated as truthy by callers. (audit HIGH #45)
  return false;
}

function evaluateCompare(sprite: Sprite, c: Condition): boolean {
  if (c.property === undefined || c.op === undefined || c.value === undefined) return false;
  const left = readProperty(sprite, c.property);
  const right = c.value;
  switch (c.op) {
    case ">": return left > right;
    case "<": return left < right;
    case ">=": return left >= right;
    case "<=": return left <= right;
    case "==": return left === right;
    case "!=": return left !== right;
  }
  // Same exhaustiveness fallback as compareOp above. (audit HIGH #46)
  return false;
}

/**
 * Resolve a CompareValues expression. The editor stores either a literal
 * number/string OR a "var:name" reference. Returns the raw var value (any
 * type) so the caller can decide numeric vs string compare.
 */
/** All sprites in the scene that carry the given tag. Returns a fresh
 *  array (never the live `peaky.sprites` reference) so the caller can
 *  safely iterate while emit-side actions destroy / spawn sprites. */
export function spritesByTag(sprite: Sprite, tag: string): Sprite[] {
  const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  if (!tag) return [...list];
  return list.filter((s) => s !== sprite && s.tags.has(tag));
}

/**
 * Probe-based wall detection — independent of input or velocity. Builds a
 * thin AABB (`probeWidth` px wide) just outside one side of the sprite's
 * body and checks for any Solid-tagged sprite overlapping it.
 *
 *   side = -1 → probe to the LEFT of the body
 *   side = +1 → probe to the RIGHT
 *
 * This solves the "Phaser arcade `blocked`/`touching` only fires during
 * collision resolution" issue — those flags require active velocity into
 * the wall, so a stationary sprite pressed against a wall reports false
 * even though it's visually in contact. The probe gives reliable contact
 * detection regardless of motion.
 */
function isNearSolid(sprite: Sprite, side: -1 | 1, probeWidth: number): boolean {
  const b = sprite.body;
  const probeX = side === -1 ? b.x - probeWidth : b.right;
  const probeY = b.y;
  const probeRight = probeX + probeWidth;
  const probeBottom = probeY + b.height;
  const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  for (const other of list) {
    if (other === sprite || other.destroyed) continue;
    // Only "Solid" terrain counts as a wall — JumpThru and arbitrary
    // dynamic actors don't.
    if (!other.findBehaviorByKind("Solid")) continue;
    const ob = other.body;
    if (!ob) continue;
    // AABB overlap test (probe rect vs other body rect).
    if (probeRight <= ob.x || probeX >= ob.right) continue;
    if (probeBottom <= ob.y || probeY >= ob.bottom) continue;
    return true;
  }
  return false;
}

/** Read a numeric property from a sprite by name (var:foo or position.x etc.). */
export function readSpriteProp(s: Sprite, key: string): number {
  if (key.startsWith("var:")) return varToNum(s.vars.get(key.slice(4)), 0);
  const body = s.body;
  const obj = s.gameObject;
  switch (key) {
    case "velocity.x": return body.velocity.x;
    case "velocity.y": return body.velocity.y;
    case "speed": return Math.abs(body.velocity.x);
    case "position.x": return obj.x;
    case "position.y": return obj.y;
  }
  return varToNum(s.vars.get(key), 0);
}

/**
 * Resolve a Pick/ForEach condition into the matching sprites. Used both by
 * the evaluator (returns true if non-empty) and by Sprite.tryFire when it
 * loops the action chain over the pick set.
 */
export function resolvePickSet(sprite: Sprite, c: Condition): Sprite[] {
  const tag = (c.tag ?? "").trim();
  const pool = spritesByTag(sprite, tag);
  switch (c.kind) {
    case "PickAll":
    case "ForEach":
      return pool;
    case "PickRandom": {
      if (pool.length === 0) return [];
      return [pool[Math.floor(Math.random() * pool.length)]];
    }
    case "PickByHighest": {
      const by = (c.by ?? "").trim();
      if (!by || pool.length === 0) return [];
      let best = pool[0]; let bestVal = readSpriteProp(best, by);
      for (let i = 1; i < pool.length; i++) {
        const v = readSpriteProp(pool[i], by);
        if (v > bestVal) { best = pool[i]; bestVal = v; }
      }
      return [best];
    }
    case "PickByLowest": {
      const by = (c.by ?? "").trim();
      if (!by || pool.length === 0) return [];
      let best = pool[0]; let bestVal = readSpriteProp(best, by);
      for (let i = 1; i < pool.length; i++) {
        const v = readSpriteProp(pool[i], by);
        if (v < bestVal) { best = pool[i]; bestVal = v; }
      }
      return [best];
    }
    case "PickNth": {
      const idx = typeof c.index === "number" ? c.index : 0;
      if (idx < 0 || idx >= pool.length) return [];
      return [pool[idx]];
    }
    case "PickByComparison": {
      const left = (c.left ?? "").trim();
      const op = c.op ?? "==";
      const rightExpr = c.right ?? "";
      const rightLiteral = isNaN(Number(rightExpr)) ? rightExpr : Number(rightExpr);
      return pool.filter((s) => {
        const lv = readSpriteProp(s, left);
        const rv = typeof rightLiteral === "number" ? rightLiteral : readSpriteProp(s, String(rightLiteral));
        switch (op) {
          case ">": return lv > rv;
          case "<": return lv < rv;
          case ">=": return lv >= rv;
          case "<=": return lv <= rv;
          case "==": return lv === rv;
          case "!=": return lv !== rv;
        }
        return false;
      });
    }
    default:
      return [];
  }
}

function resolveExpr(sprite: Sprite, expr: string | undefined): number | string | boolean | undefined {
  if (expr === undefined || expr === "") return undefined;
  if (typeof expr === "string") {
    // self.<field> — host sprite's own transform/physics. Mirrors the
    // `self.` branch in `resolveIdent` so CompareValues can compare the
    // host's own position to other expressions (`self.x < var:Player.x`).
    if (expr.startsWith("self.")) {
      const field = expr.slice(5);
      const obj = sprite.gameObject;
      const body = sprite.body;
      switch (field) {
        case "x":      return obj.x;
        case "y":      return obj.y;
        case "vx":     return body?.velocity.x ?? 0;
        case "vy":     return body?.velocity.y ?? 0;
        case "angle":  return obj.angle;
        case "scale":  return obj.scale;
        case "scaleX": return obj.scaleX;
        case "scaleY": return obj.scaleY;
        case "alpha":  return obj.alpha;
        case "uid":    return sprite.uid;
      }
      return undefined;
    }
    // tracer:<name>.<field>  — e.g. "tracer:groundCheck.hitX". Empty <name>
    // ("tracer:.distance") falls back to the first attached tracer. The
    // $-prefixed form (`$tracer:…`) is also accepted for consistency with
    // `$var:` used in action value fields.
    if (expr.startsWith("$tracer:")) return resolveTracerExpr(sprite, expr.slice(8));
    if (expr.startsWith("tracer:")) return resolveTracerExpr(sprite, expr.slice(7));
    // var:<name> or var:<BlueprintName>.<field>. Matches the same shape
    // resolveIdent uses (numOr/strOr) — without the dotted fallback the
    // ValueExpressionPicker's "var:World.gold" form looked up a literal
    // variable called "World.gold" on the host sprite and returned undefined.
    if (expr.startsWith("var:") || expr.startsWith("$var:")) {
      // Single source of truth — resolveVarPath handles bare local vars,
      // cross-BP `BP.field` (built-in transform OR user var), and the
      // `self.field` host shortcut. Returns a number / string / boolean
      // / undefined; resolveExpr's callers accept all of those.
      return resolveVarPath(sprite, expr.slice(expr.indexOf(":") + 1)) as number | string | boolean | undefined;
    }
    // picked.<field> — current pick-set's primary sprite. Mirrors the
    // numOr resolver in resolveIdent so CompareValues can read picked.uid,
    // picked.x, picked.<varName> the same as any other expression input.
    if (expr.startsWith("picked.")) {
      const field = expr.slice("picked.".length);
      const picked = sprite.scene?.data?.get("peaky.picked") as Sprite | undefined;
      if (!picked || picked.destroyed) return 0;
      switch (field) {
        case "x":      return picked.gameObject.x;
        case "y":      return picked.gameObject.y;
        case "uid":    return picked.uid;
        case "name":   return picked.instanceName || picked.blueprintName || "";
        case "tag":    return [...picked.tags][0] ?? "";
        default:       return picked.vars.get(field);
      }
    }
    // Bare name → variable lookup if a variable with that name exists. This
    // matches the new UI which stores bare names (no "var:" prefix). Falls
    // through to literal handling when no variable matches.
    if (sprite.vars.has(expr)) return sprite.vars.get(expr);
    // Literal — try number first; if not, return as string.
    const n = Number(expr);
    if (!Number.isNaN(n)) return n;
    return expr;
  }
  return expr;
}

/** Read one field off a sprite's tracer. Returns a diagnostic string when
 *  the tracer or field is missing — so debug logs make the misconfiguration
 *  visible instead of silently rendering as an empty value. Numeric fields
 *  return 0 when the tracer hasn't hit anything yet so callers can compare. */
/** Resolve `weapon:SLOT.field` — read fields off a WeaponSlot by name.
 *  Used in CompareValues / Switch nodes so authors can dispatch on the
 *  currently equipped weapon without maintaining a parallel index var.
 *  Empty SLOT falls back to the first WeaponSlot on the sprite. */
function resolveWeaponExpr(sprite: Sprite, rest: string): number | string {
  const dot = rest.indexOf(".");
  const name = dot < 0 ? rest : rest.slice(0, dot);
  const field = dot < 0 ? "equipped" : rest.slice(dot + 1);
  const slots = sprite.findBehaviorsByKind("WeaponSlot") as unknown as Array<{
    name?: string;
    spriteId?: string;
    currentAnimation?: string;
    imagePoint?: string;
    visible?: number;
  }>;
  const slot = name
    ? slots.find((s) => String(s.name ?? "") === name)
    : slots[0];
  if (!slot) {
    const available = slots.length === 0
      ? "no WeaponSlot attached to this sprite"
      : `available slots: ${slots.map((s) => `"${s.name}"`).join(", ")}`;
    return `<weapon slot "${name}" not found — ${available}>`;
  }
  switch (field) {
    case "equipped":  return slot.spriteId ? 1 : 0;
    case "spriteId":  return String(slot.spriteId ?? "");
    case "animation": return String(slot.currentAnimation ?? "");
    case "imagePoint": return String(slot.imagePoint ?? "");
    case "visible":   return Number(slot.visible ?? 0);
    default:          return `<unknown weapon field "${field}" — valid: equipped, spriteId, animation, imagePoint, visible>`;
  }
}

function resolveTracerExpr(sprite: Sprite, rest: string): number | string {
  const dot = rest.indexOf(".");
  const name = dot < 0 ? rest : rest.slice(0, dot);
  const field = dot < 0 ? "hit" : rest.slice(dot + 1);
  const tracer = findTracer(sprite, name);
  if (!tracer) {
    const all = sprite.findBehaviorsByKind("Tracer");
    const available = all.length === 0
      ? "no Tracer attached to this sprite"
      : `available tracers: ${all.map((t) => `"${t.name}"`).join(", ")}`;
    return `<tracer "${name}" not found — ${available}>`;
  }
  const hit = tracer.lastHit;
  // For start/end geometry use the LIVE calc — where the tracer points right
  // now, regardless of whether it has fired this frame. The `_lastTraceGeom`
  // cache only updates on sample, so reading it in the same chain as the
  // signal that triggers the tracer would return the previous frame's
  // geometry. _calcGeom() recomputes from current host position + facing.
  const liveGeom = (tracer as unknown as { _calcGeom: () => { px: number; py: number; ex: number; ey: number } })._calcGeom();
  switch (field) {
    case "hit":       return hit ? 1 : 0;
    case "hitX":      return hit ? hit.hitX : 0;
    case "hitY":      return hit ? hit.hitY : 0;
    case "actorX":    return hit ? hit.actorX : 0;
    case "actorY":    return hit ? hit.actorY : 0;
    case "actorName": return hit ? hit.actorName : "";
    case "actorUid":  return hit ? hit.actorUid : 0;
    case "actorTags": return hit ? (hit.actorTags ?? []).join(",") : "";
    case "distance":  return hit ? hit.distance : 0;
    // Line geometry — LIVE values, recomputed every read from the host's
    // current position + facing + tracer angle/distance. Independent of
    // whether the tracer has fired; lets authors put `tracer:swing.endX`
    // anywhere and always get the current trace tip.
    case "startX":    return liveGeom.px;
    case "startY":    return liveGeom.py;
    case "endX":      return liveGeom.ex;
    case "endY":      return liveGeom.ey;
    default:          return `<unknown tracer field "${field}" — valid: hit, hitX, hitY, actorX, actorY, actorName, actorUid, actorTags, distance, startX, startY, endX, endY>`;
  }
}

function readProperty(sprite: Sprite, p: NonNullable<Condition["property"]>): number {
  // `var:<name>` strings aren't in the CompareProperty union but flow through
  // here at runtime — the editor writes them as the dropdown value when you
  // pick a Blueprint variable. Check the prefix first so the switch below can
  // stay exhaustive on the union without unreachable-code complaints.
  const s = p as unknown as string;
  if (s.startsWith("var:")) {
    return varToNum(sprite.vars.get(s.slice(4)), 0);
  }
  const body = sprite.body;
  const obj = sprite.gameObject;
  switch (p) {
    case "velocity.x": return body?.velocity.x ?? 0;
    case "velocity.y": return body?.velocity.y ?? 0;
    case "speed": return Math.abs(body?.velocity.x ?? 0);
    case "position.x": return obj.x;
    case "position.y": return obj.y;
    case "angle": return obj.angle;
    case "scale.x": return obj.scaleX;
    case "scale.y": return obj.scaleY;
    case "scale": return (obj.scaleX + obj.scaleY) / 2;
    case "alpha": return obj.alpha;
    case "depth": return obj.depth;
    case "is_grounded": return body && (body.blocked.down || body.touching.down) ? 1 : 0;
  }
  // Default-0 on unrecognised property — matches the editor's "missing data"
  // contract and keeps callers from getting undefined-as-NaN. (audit MED #91)
  return 0;
}

/**
 * Run a single action immediately. `Wait` is a no-op here — the per-event
 * action queue handles its scheduling. Caller passes a context label for
 * logging (e.g. event trigger kind).
 */
/** Scene-singleton actions that operate on the scene camera or layout —
 *  there's only one Phaser camera per scene, so these don't fan out per
 *  sprite. If the subject resolves to nothing (e.g. Camera BP isn't
 *  placed in the scene), still run once on the caller; the eval handler
 *  will fall back to `scene.cameras.main.shake / flash / ...` even
 *  without a Camera behavior. Without this bypass, targeting an
 *  unplaced Camera BP silently no-ops — confusing because the actions
 *  visibly DO have a meaningful Phaser fallback. */
const SCENE_SINGLETON_ACTIONS = new Set<string>([
  "CameraShake", "CameraStopShake", "CameraSetSmoothing",
  "CameraSetTarget", "CameraSetTargetSelf", "CameraStopFollow",
  "CameraSetOffset", "CameraSetZoom", "CameraSetFollowAxes",
  "CameraFlash", "CameraFade", "CameraLock", "CameraUnlock",
  "CameraPanTo", "CameraPanToTag", "BlurScene",
  "ScrollToObject", "ScrollToPosition", "SetLayoutScale",
]);

/** Resolve which Text behavior a text action targets. `name` matches a Text
 *  component's `name` field; blank / undefined = the first Text component.
 *  When a name is given but no Text matches, returns undefined so the action
 *  no-ops instead of writing to the wrong overlay (BPs can have several). */
function resolveTextBehavior(sprite: Sprite, name: unknown) {
  const all = sprite.findBehaviorsByKind("Text");
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return all[0];
  return all.find((t) => (t.name ?? "") === n);
}

/** Monotonic suffix that makes multi-target Tween map keys unique per call so
 *  parallel tweens on the same tag+prop don't overwrite each other's slot. */
let _tweenSeq = 0;

export function runAction(sprite: Sprite, a: StateAction, sourceLabel?: string): void {
  // Plural SOL fan-out — when the action's subject targets a specific
  // BP / UI Widget, dispatch the action ONCE PER picked instance (or
  // once per live instance if nothing has been picked in this chain
  // yet). Self / system / mouse / keyboard / world subjects collapse to
  // the single host sprite — single iteration, no fan-out.
  // Construct's "for each picked instance" semantics fall out of this.
  let targets = resolveSubjectSprites(sprite, a.subject);
  if (targets.length === 0 && SCENE_SINGLETON_ACTIONS.has(a.kind)) {
    // No instances of the targeted BP exist (most often: a Camera BP
    // that isn't placed in the scene). Run once on the caller so the
    // scene-camera Phaser fallback in the action handler kicks in.
    targets = [sprite];
  }
  for (const target of targets) {
    if (target.destroyed) continue;
    runActionOnSprite(target, a, sourceLabel);
  }
}

function runActionOnSprite(sprite: Sprite, a: StateAction, sourceLabel?: string): void {
  const cfg = a.config;
  switch (a.kind) {
    case "SetColor": {
      const raw = cfg.color;
      let color = 0xffffff;
      if (typeof raw === "number") color = raw;
      else if (typeof raw === "string" && raw.length > 0) {
        const trimmed = raw.trim().replace(/^#/, "0x");
        const parsed = Number(trimmed);
        if (!Number.isNaN(parsed)) color = parsed;
      }
      sprite.gameObject.setFillStyle(color);
      break;
    }
    case "SetSize": {
      const w = numOr(cfg.w, sprite.gameObject.width, sprite);
      const h = numOr(cfg.h, sprite.gameObject.height, sprite);
      sprite.gameObject.setSize(w, h);
      // `body` is undefined on no-physics-body (decoration) BPs — guard it.
      if (sprite.body) sprite.body.setSize(w, h, true);
      break;
    }
    case "Log": {
      const source = sourceLabel ?? "Event";
      const message = strOr(cfg.message, "", sprite);
      console.log(`[${source}]`, message);
      Logger.log({ level: "log", source, message });
      break;
    }
    case "PrintString": {
      const message = strOr(cfg.message, "", sprite);
      const duration = numOr(cfg.duration, 2, sprite);
      const color = String(cfg.color ?? "#00ff88");
      showOnScreenPrint(sprite.scene, message, duration, color);
      Logger.log({ level: "log", source: sourceLabel ?? "Print", message });
      break;
    }
    case "DebugPrint": {
      // Wire-injected debug print container. LogicSheetRunner stuffs
      // `_sheet` and `_prev` into the config right before dispatching so
      // each row is self-labeling. The container holds 1..N rows; all
      // fire on the same tick when the chain hits the container.
      const sheet = String(cfg._sheet ?? "?");
      const prev = String(cfg._prev ?? "?");
      const next = String(cfg._next ?? "?");
      // Include the blueprint name (or instance name if set) so a fan of
      // debug prints across multiple BPs is unambiguous.
      const bp = sprite.instanceName || sprite.blueprintName || "?";
      const ctx = ` { bp: ${bp}, sheet: ${sheet}, between: ${prev} → ${next} }`;
      const rows = Array.isArray(cfg.rows) ? cfg.rows : [];
      for (const row of rows as Array<{ message?: unknown; color?: unknown; duration?: unknown }>) {
        const userMsg = strOr(row.message, "", sprite);
        const duration = numOr(row.duration, 2, sprite);
        const color = String(row.color ?? "#ff5555");
        const full = (userMsg || "(debug)") + ctx;
        showOnScreenPrint(sprite.scene, full, duration, color);
        console.log(`[DebugPrint] ${full}`);
        Logger.log({ level: "log", source: "DebugPrint", message: full });
      }
      break;
    }
    case "SetVelocityX":
      // No body on decoration BPs → nothing to set; skip instead of crashing.
      if (sprite.body) sprite.body.setVelocityX(numOr(cfg.vx, 0, sprite));
      break;
    case "SetVelocityY":
      if (sprite.body) sprite.body.setVelocityY(numOr(cfg.vy, 0, sprite));
      break;
    case "MoveTo": {
      // Fire-once command: SNAPSHOT the target (x, y) now and let Sprite.tick
      // home toward it at constant speed until it arrives, then stop. Capturing
      // once means "Move To mouse.x/mouse.y" goes to the CLICK point (not the
      // live cursor), and "Move To var:Player.x/y" goes to the player's current
      // spot. It stops on its own — no gravity/friction needed — so it never
      // coasts past to the screen edge. Re-fire to re-target a moving object.
      const gx = sprite.gameObject.x;
      const gy = sprite.gameObject.y;
      sprite._moveTo = {
        tx: numOr(cfg.x, gx, sprite),
        ty: numOr(cfg.y, gy, sprite),
        speed: numOr(cfg.speed, 120, sprite),
        stopRadius: numOr(cfg.stopRadius, 4, sprite),
      };
      break;
    }
    case "MoveStop": {
      // Cancel an in-flight Move To and halt.
      sprite._moveTo = null;
      if (sprite.body) {
        sprite.body.setVelocityX(0);
        sprite.body.setVelocityY(0);
      }
      break;
    }
    case "EmitSignal": {
      const name = (cfg.name as string) ?? "";
      if (name) sprite.events.emit(name);
      break;
    }
    case "SetVar": {
      // `name` may target another object (`Player.HP`); bare names stay local.
      const t = resolveWriteTarget(sprite, String(cfg.name ?? ""));
      if (!t) break;
      const tv = t.sprite.vars;
      const name = t.field;
      // Match the new value's type to the var's existing type so SetVar on a
      // string var stores a string, on a bool stores a bool, etc.
      const cur = tv.get(name);
      if (typeof cur === "string") {
        t.sprite.writeVar(name, strOr(cfg.value, "", sprite));
      } else if (typeof cur === "boolean") {
        // Accept literal 0/1, "true"/"false", or numeric vars; truthiness wins.
        const v = cfg.value;
        let asBool: boolean;
        if (typeof v === "boolean") asBool = v;
        else if (typeof v === "string" && v.startsWith("$var:")) asBool = !!sprite.vars.get(v.slice(5));
        else if (typeof v === "string") asBool = v === "true" || v === "1";
        else if (typeof v === "number") asBool = v !== 0;
        else asBool = false;
        t.sprite.writeVar(name, asBool);
      } else {
        // number var (or undefined — treat as number)
        t.sprite.writeVar(name, numOr(cfg.value, 0, sprite));
      }
      break;
    }
    case "AddVar": {
      const t = resolveWriteTarget(sprite, String(cfg.name ?? ""));
      if (!t) break;
      const tv = t.sprite.vars;
      const name = t.field;
      const cur = tv.get(name);
      if (typeof cur === "string") {
        // String concat — append the delta as a string.
        t.sprite.writeVar(name, cur + strOr(cfg.delta, "", sprite));
      } else if (typeof cur === "boolean") {
        // No-op for bool — toggling via AddVar is too implicit.
      } else {
        // number var
        const n = typeof cur === "number" && Number.isFinite(cur) ? cur : 0;
        t.sprite.writeVar(name, n + numOr(cfg.delta, 0, sprite));
      }
      break;
    }
    case "SetBool": {
      const t = resolveWriteTarget(sprite, String(cfg.name ?? ""));
      if (!t) break;
      const raw = cfg.value;
      const asBool = typeof raw === "boolean" ? raw
                   : typeof raw === "number" ? raw !== 0
                   : typeof raw === "string" ? (raw === "true" || raw === "1")
                   : false;
      t.sprite.writeVar(t.field, asBool);
      break;
    }
    case "ToggleBool": {
      const t = resolveWriteTarget(sprite, String(cfg.name ?? ""));
      if (!t) break;
      const cur = t.sprite.vars.get(t.field);
      const asBool = typeof cur === "boolean" ? cur : (typeof cur === "number" ? cur !== 0 : !!cur);
      t.sprite.writeVar(t.field, !asBool);
      break;
    }
    case "SetTimeScale": {
      const scale = numOr(cfg.scale, 1, sprite);
      const safe = Math.max(0, scale); // negative time scale is undefined behavior
      const prev = sprite.scene.time.timeScale;
      // Both physics + tween/timer time scale, so pause/slow-mo are total.
      sprite.scene.physics.world.timeScale = safe === 0 ? Infinity : 1 / safe; // Phaser physics: higher = slower
      sprite.scene.time.timeScale = safe;
      sprite.scene.tweens.timeScale = safe;
      // Unpause transition (0 → non-zero): swallow any keys still held
      // from before / during the pause. The player must physically
      // release + repress to engage movement / jump / dash again.
      // Without this:
      //   • Holding Left during pause keeps the character walking the
      //     moment timeScale flips back to 1.
      //   • Pressing Jump during pause queues a jump — `OnKeyPressed[Jump]
      //     → CMJump` fires (events run during pause) and writes Y velocity;
      //     unpause resumes physics and the buffered velocity launches
      //     the character (or, for held jumps after a fall pause, lands
      //     the character then immediately jumps again).
      //   • Holding Q (the pause-toggle key itself) oscillates the
      //     pause state every frame post-resume.
      if (prev === 0 && safe !== 0) {
        const ia = getInputActions(sprite.scene);
        ia?.ignoreAllCurrentlyHeld();
        // Physics world buffered up `delta` while paused — Phaser arcade
        // adds every frame's delta to `_elapsed` and only fires `step()`
        // when `_elapsed >= _frameTimeMS`. With timeScale=0 we set
        // `_frameTimeMS = Infinity`, so `_elapsed` grew unbounded for
        // the whole pause. On resume, frameTimeMS drops back to
        // ~16.67ms — the inner while-loop now steps physics ONCE PER
        // accumulated frame in a single tick. A 2-second pause = 120
        // physics steps in one frame: gravity integrates 120×, the
        // body slams into the ground; horizontal velocity carries the
        // BP however far it would have traveled in 2s. Drop the
        // buffer so physics starts fresh from frame 1 of the resume.
        const world = sprite.scene.physics.world as Phaser.Physics.Arcade.World & { _elapsed?: number };
        if ("_elapsed" in world) world._elapsed = 0;
      }
      break;
    }
    case "HitStop": {
      // Impact freeze. Snap timeScale to `scale` (0 = full freeze) and record
      // a WALL-CLOCK resume time; MainScene.update restores it once real time
      // passes (that loop runs every frame regardless of timeScale, so the
      // freeze un-freezes itself). Overlapping hits extend the window and
      // never overwrite the saved "normal" scale with the frozen 0.
      const ms = Math.max(0, numOr(cfg.durationMs, 80, sprite));
      const delayMs = Math.max(0, numOr(cfg.delayMs, 50, sprite));
      const scale = Math.max(0, numOr(cfg.scale, 0, sprite));
      const affectPhysics = cfg.affectPhysics !== false;     // default on
      const affectParticles = cfg.affectParticles !== false; // default on
      const scene = sprite.scene;
      const now = scene.game.loop.time;
      // Already frozen → extend the active window.
      if (scene.data.get("peaky.hitstopUntilRealMs") !== undefined) {
        const cur = scene.data.get("peaky.hitstopUntilRealMs") as number;
        scene.data.set("peaky.hitstopUntilRealMs", Math.max(cur, now + ms));
        break;
      }
      // A freeze is already scheduled (still in its delay window) → leave it.
      if (scene.data.get("peaky.hitstopBeginAtMs") !== undefined) break;
      // Schedule the freeze to BEGIN after `delayMs`. The delay lets the hit's
      // reaction start first — e.g. the State Machine transitions into "hurt"
      // (driven by the OnDamageTaken signal, which only fires for a frame) —
      // so time freezes ON the hurt pose instead of stopping the animator
      // before it can transition. MainScene.update applies + auto-resumes it
      // (it runs every frame, even while timeScale = 0).
      scene.data.set("peaky.hitstopBeginAtMs", now + delayMs);
      scene.data.set("peaky.hitstopMs", ms);
      scene.data.set("peaky.hitstopScale", scale);
      scene.data.set("peaky.hitstopAffectPhysics", affectPhysics);
      scene.data.set("peaky.hitstopAffectParticles", affectParticles);
      break;
    }
    case "SetPaused": {
      // Flag-based pause distinct from SetTimeScale: gameplay sprites freeze
      // (handled per-sprite in Sprite.tick) while UI widgets keep ticking, so
      // pause menus stay live. scope=all toggles peaky.pauseAll; scope=layer
      // toggles the layer's id in peaky.pausedLayers.
      const mode = strOr(cfg.mode, "pause", sprite);   // pause | resume | toggle
      const scope = strOr(cfg.scope, "all", sprite);   // all | layer
      const scene = sprite.scene;
      let nowPaused: boolean;
      if (scope === "layer") {
        const layerName = strOr(cfg.layer, "", sprite);
        if (!layerName) break;
        const idByName = scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
        const layerId = idByName?.[layerName];
        if (!layerId) {
          console.warn(`[SetPaused] layer "${layerName}" not found. Known: [${Object.keys(idByName ?? {}).join(", ") || "(none)"}]`);
          break;
        }
        let set = scene.data.get("peaky.pausedLayers") as Set<string> | undefined;
        if (!set) { set = new Set<string>(); scene.data.set("peaky.pausedLayers", set); }
        nowPaused = mode === "toggle" ? !set.has(layerId) : mode === "pause";
        if (nowPaused) set.add(layerId); else set.delete(layerId);
      } else {
        const cur = scene.data.get("peaky.pauseAll") === true;
        nowPaused = mode === "toggle" ? !cur : mode === "pause";
        scene.data.set("peaky.pauseAll", nowPaused);
      }
      // On resume, drop keys held during the pause so a held Jump / Move
      // doesn't replay the instant gameplay resumes (mirrors SetTimeScale).
      if (!nowPaused) getInputActions(scene)?.ignoreAllCurrentlyHeld();
      break;
    }
    case "ApplyDamage": {
      // `sprite` is the resolved subject (self / picked / BP instance).
      // Source is the OTHER sprite when this runs from a collide/overlap/
      // tracer chain, so knockback + sourceUid resolve to the attacker.
      const dmg = sprite.findBehaviorByKind("Damageable");
      if (!dmg) break;
      const amount = numOr(cfg.amount, 0, sprite);
      if (amount > 0) dmg.applyDamage(amount, sprite._eventOther ?? undefined);
      break;
    }
    case "Heal": {
      const dmg = sprite.findBehaviorByKind("Damageable");
      if (!dmg) break;
      const amount = numOr(cfg.amount, 0, sprite);
      if (amount > 0) dmg.heal(amount);
      break;
    }
    case "Destroy": {
      // "Remember" → record this authored instance's stable id so it isn't
      // re-spawned when the scene reloads (pickups / chopped trees stay gone
      // across scene transitions + save/load). No-op for spawned objects (no
      // instanceId) — they don't re-spawn on reload anyway.
      const persist = typeof cfg.persist === "boolean" ? cfg.persist : numOr(cfg.persist, 0, sprite) !== 0;
      if (persist && sprite.instanceId) persistentState().removedInstances.add(sprite.instanceId);
      sprite.destroy();
      break;
    }
    case "SetInstanceName": {
      // Free-text rename for the runtime instance. Used by SaveSlot matching
      // (when instanceId is absent), the debug console, and any
      // `instance:<name>` expression lookups.
      const _oldInstanceName = sprite.instanceName;
      sprite.instanceName = strOr(cfg.name, "", sprite);
      // Keep the name index in sync (remove the old instanceName key, add the
      // new one) so var:<name> lookups resolve the renamed instance.
      reindexSpriteInstanceName(sprite.scene, sprite, _oldInstanceName, sprite.instanceName);
      break;
    }
    case "EditTags": {
      // Fan out to every live instance of the picked Blueprint. The author's
      // chain may have narrowed via Pick/ForEach upstream — if so, `sprite`
      // is the picked target and we still match BP-by-id below to keep the
      // operation idempotent. Use blueprintName since `bp` is the author-
      // facing name on the picker (the runtime sprite.blueprintName matches).
      const bpName = String(cfg.bp ?? "").trim();
      const mode = String(cfg.mode ?? "insert");
      const newTag = strOr(cfg.tag, "", sprite).trim();
      const oldTag = strOr(cfg.oldTag, "", sprite).trim();
      const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      for (const s of list) {
        if (s.destroyed) continue;
        if (bpName && s.blueprintName !== bpName) continue;
        if (mode === "insert") {
          if (newTag) addSpriteTag(s.scene, s, newTag);
        } else if (mode === "remove") {
          if (oldTag) removeSpriteTag(s.scene, s, oldTag);
        } else if (mode === "replace") {
          if (oldTag) removeSpriteTag(s.scene, s, oldTag);
          if (newTag) addSpriteTag(s.scene, s, newTag);
        }
      }
      break;
    }
    case "Wait":
      // Handled by the per-event action queue.
      break;
    case "WaitRealtime":
      // Handled by the per-event action queue (wall-clock gate — advances
      // even while scene timeScale = 0, so it can schedule its own unpause).
      break;
    case "WaitForSignal": {
      // No-op at runAction time — the actual "wait" is handled by Sprite's
      // action queue, which respects this kind by deferring subsequent
      // actions until the named signal fires. The runner inspects the
      // action's kind during chain processing, not here.
      break;
    }
    case "SubVar": {
      const t = resolveWriteTarget(sprite, String(cfg.name ?? ""));
      if (!t) break;
      const cur = t.sprite.vars.get(t.field);
      if (typeof cur === "number") {
        t.sprite.writeVar(t.field, cur - numOr(cfg.delta, 0, sprite));
      }
      break;
    }
    case "RandomNumber": {
      const t = resolveWriteTarget(sprite, String(cfg.var ?? ""));
      if (!t) break;
      const a = numOr(cfg.min, 0, sprite);
      const b = numOr(cfg.max, 10, sprite);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const isFloat = typeof cfg.float === "boolean" ? cfg.float : numOr(cfg.float, 0, sprite) !== 0;
      let val: number;
      if (isFloat) {
        val = lo + Math.random() * (hi - lo);
      } else {
        const ilo = Math.ceil(lo), ihi = Math.floor(hi);
        val = ihi >= ilo ? ilo + Math.floor(Math.random() * (ihi - ilo + 1)) : Math.round(lo);
      }
      t.sprite.writeVar(t.field, val);
      break;
    }
    case "ScrollToPosition": {
      const x = numOr(cfg.x, 0, sprite);
      const y = numOr(cfg.y, 0, sprite);
      sprite.scene.cameras.main.centerOn(x, y);
      break;
    }
    case "ScrollToObject": {
      const tag = String(cfg.tag ?? "").trim();
      if (!tag) break;
      // Find a sprite carrying this tag in the same scene's registry.
      const sprites = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const target = sprites.find((s) => s.tags.has(tag));
      if (target) sprite.scene.cameras.main.startFollow(target.gameObject);
      break;
    }
    case "SetLayoutScale": {
      const scale = numOr(cfg.scale, 1, sprite);
      sprite.scene.cameras.main.setZoom(Math.max(0.01, scale));
      break;
    }
    case "RestartLayout":
      drainSceneEndThen(sprite, () => sprite.scene.scene.restart());
      break;
    case "GoToLayout": {
      const name = String(cfg.name ?? "").trim();
      if (!name) break;
      drainSceneEndThen(sprite, () => emitGoToScene(sprite, name));
      break;
    }
    case "GoToLayoutWithLoad": {
      // Routes to the LoadingScene first; the editor listener (ScenePanel)
      // boots that scene, starts loading the target's assets, fires
      // `_loadStart` / `_loadProgress { pct }` / `_loadComplete` signals as
      // it goes, and (when minDisplaySec has elapsed AND loader complete)
      // emits the same `peaky:goToScene` event that finalizes the swap.
      const name = String(cfg.name ?? "").trim();
      if (!name) break;
      const minDisplaySec = Number(cfg.minDisplaySec ?? 0);
      drainSceneEndThen(sprite, () => emitGoToSceneWithLoad(sprite, name, minDisplaySec));
      break;
    }
    case "SetLoadingScene": {
      // Override the project-level loadingSceneId for the NEXT
      // GoToLayoutWithLoad call. Empty string clears the override. The
      // editor's ScenePanel reads peaky.loadingSceneOverride before
      // falling back to the project setting.
      const name = String(cfg.name ?? "").trim();
      sprite.scene.data.set("peaky.loadingSceneOverride", name);
      break;
    }
    case "CreateSpriteObject": {
      const spriteId = String(cfg.spriteId ?? "").trim();
      if (!spriteId) break;
      const x = numOr(cfg.x, sprite.gameObject?.x ?? 0, sprite);
      const y = numOr(cfg.y, sprite.gameObject?.y ?? 0, sprite);
      // Synchronous spawn — Sprite Object creation is cheap enough that
      // V1 doesn't budget-gate it. (15K-spawn freeze is acceptable for
      // now; budgeting would defer the GameObject creation and break
      // any chain that immediately addresses the placement.)
      spawnRuntimeSpriteObject(sprite.scene, spriteId, x, y);
      break;
    }
    case "DestroySpriteObject": {
      const spriteId = String(cfg.spriteId ?? "").trim();
      if (!spriteId) break;
      const idx = sprite.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
      const list = idx?.get(spriteId);
      if (!list || list.length === 0) break;
      for (const g of list) g.destroy();
      idx!.delete(spriteId);
      // Queue the destroy broadcast so it lands at the start of the
      // next frame — same carryover reasoning as create.
      const pendingDestroy = (sprite.scene.data.get("peaky.pendingPlacementDestroys") as string[] | undefined) ?? [];
      pendingDestroy.push(spriteId);
      sprite.scene.data.set("peaky.pendingPlacementDestroys", pendingDestroy);
      break;
    }
    case "SetRecipeEnabled":
    case "AddRecipeIngredient":
    case "RemoveRecipeIngredient":
    case "SetRecipeOutput": {
      // Runtime recipe edits. `peaky.recipes` is a Record<recipeName,
      // RecipeRuntime> built by runProject; mutating in-place propagates
      // to canCraft / craft and the Crafting widget without rebuild.
      const recipes = sprite.scene.data.get("peaky.recipes") as
        Record<string, { name: string; enabled?: boolean;
                inputs: Array<{ item: string; qty: number }>;
                outputItem: string; outputQty: number }> | undefined;
      if (!recipes) break;
      const target = String(cfg.recipe ?? "").trim();
      if (!target) break;
      const r = recipes[target];
      if (!r) break;
      if (a.kind === "SetRecipeEnabled") {
        r.enabled = !!cfg.enabled;
      } else if (a.kind === "AddRecipeIngredient") {
        const item = String(cfg.item ?? "").trim();
        const qty = Math.max(1, Math.floor(numOr(cfg.qty, 1, sprite)));
        if (!item) break;
        const existing = r.inputs.find((i) => i.item === item);
        if (existing) existing.qty = qty; else r.inputs.push({ item, qty });
      } else if (a.kind === "RemoveRecipeIngredient") {
        const item = String(cfg.item ?? "").trim();
        if (!item) break;
        r.inputs = r.inputs.filter((i) => i.item !== item);
      } else if (a.kind === "SetRecipeOutput") {
        r.outputItem = String(cfg.item ?? "");
        r.outputQty = Math.max(1, Math.floor(numOr(cfg.qty, 1, sprite)));
      }
      break;
    }
    case "SetSpriteObjectColliderEnabled":
    case "SetSpriteObjectSolid":
    case "SetSpriteObjectCollideMode":
    case "AddSpriteObjectTag":
    case "RemoveSpriteObjectTag":
    case "ClearSpriteObjectTags":
    case "AddSpriteObjectCollideTag":
    case "RemoveSpriteObjectCollideTag":
    case "ClearSpriteObjectCollideTags": {
      // Active-placement context wins when set — lets the
      // OnSpriteObjectCreate chain mutate ONLY the just-created
      // placement (or whoever set peaky.activePlacement). Falls back to
      // asset-wide targeting when no active placement is set.
      const activeGo = sprite.scene.data.get("peaky.activePlacement") as Phaser.GameObjects.Sprite | null | undefined;
      let list: Phaser.GameObjects.Sprite[];
      if (activeGo) {
        list = [activeGo];
      } else {
        const spriteId = String(cfg.spriteId ?? "").trim();
        if (!spriteId) break;
        const idx = sprite.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
        const found = idx?.get(spriteId);
        if (!found || found.length === 0) break;
        list = found;
      }
      for (const go of list) {
        if (a.kind === "SetSpriteObjectColliderEnabled") {
          const enabled = !!cfg.enabled;
          let body = (go.body as Phaser.Physics.Arcade.Body | null);
          if (!body && enabled) {
            sprite.scene.physics.add.existing(go, false);
            body = go.body as Phaser.Physics.Arcade.Body | null;
            if (body) {
              body.setImmovable(true);
              body.allowGravity = false;
            }
          }
          if (body) body.enable = enabled;
          // Wire BOTH pair types (collider + overlap) so SetSolid can
          // swap at runtime without re-registering. Each pair's
          // processCallback gates on the LIVE solid flag — only one
          // fires per pair-per-tick depending on current state. Plus the
          // tag include/exclude filter. Guarded so toggling enable on/
          // off doesn't stack pairs.
          if (enabled && body && !go.getData("peaky.pairsRegistered")) {
            const allSpritesNow = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            // Helper that wires the two physics pairs (solid + overlap)
            // for one specific other-sprite. Reused both for the initial
            // snapshot AND the post-spawn hook (Bug #6 fix) so a sprite
            // created later via CreateObject also gets paired with this
            // placement.
            const wirePair = (other: Sprite) => {
              if (!other.gameObject || !other.gameObject.body) return;
              const goPair = other.gameObject as Phaser.Types.Physics.Arcade.GameObjectWithBody;
              sprite.scene.physics.add.collider(
                goPair, go, undefined,
                () => !!go.getData("peaky.solid") && passes(other),
              );
              sprite.scene.physics.add.overlap(
                goPair, go, undefined,
                () => !go.getData("peaky.solid") && passes(other),
              );
            };
            // Tag include/exclude filter at fire-time.
            const tagMatch = (s: Sprite): boolean => {
              const filterTags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
              const mode = (go.getData("peaky.tagMode") as string | undefined) ?? "include";
              if (filterTags.length === 0) return mode === "include";
              const tagSetLive = new Set(filterTags);
              let matched = false;
              for (const t of s.tags) if (tagSetLive.has(t)) { matched = true; break; }
              return mode === "include" ? matched : !matched;
            };
            // Frame-exception check: the sprite asset's per-frame collider
            // exception tags are the DEFAULT behavior. The placement-level
            // collide filter (set in the Inspector or via runtime Add/
            // Remove SpriteObject Collider Tag actions) OVERRIDES the frame
            // exception per the UI hint shown in the Sprite tab. So:
            //  - Instance has filter tags (non-empty) → frame exempt is IGNORED
            //  - Instance filter is empty → frame exempt acts as veto
            const frameExemptsSprite = (s: Sprite): boolean => {
              const exempt = (go.getData("peaky.frameExempt") as string[] | undefined) ?? [];
              if (exempt.length === 0) return false;
              const exemptSet = new Set(exempt);
              for (const t of s.tags) if (exemptSet.has(t)) return true;
              return false;
            };
            const passes = (s: Sprite): boolean => {
              const filterTags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
              const hasInstanceFilter = filterTags.length > 0;
              if (!hasInstanceFilter && frameExemptsSprite(s)) return false;
              return tagMatch(s);
            };
            for (const otherSprite of allSpritesNow) wirePair(otherSprite);
            // Bug #6 fix: register a post-spawn hook so sprites created
            // LATER (CreateObject in a wave spawner, FireProjectile, etc.)
            // also get paired with this placement. Hooks live in scene
            // data so Game.sprite() can fan them out without importing
            // anything from the placement layer.
            const hookKey = "peaky.onSpriteSpawnHooks";
            const hooks = (sprite.scene.data.get(hookKey) as Array<(sp: Sprite) => void> | undefined) ?? [];
            hooks.push(wirePair);
            sprite.scene.data.set(hookKey, hooks);
            go.setData("peaky.pairsRegistered", true);
          }
        } else if (a.kind === "SetSpriteObjectSolid") {
          go.setData("peaky.solid", !!cfg.solid);
        } else if (a.kind === "SetSpriteObjectCollideMode") {
          const mode = String(cfg.mode ?? "include").trim();
          go.setData("peaky.tagMode", mode === "exclude" ? "exclude" : "include");
        } else if (a.kind === "AddSpriteObjectTag") {
          const tag = String(cfg.tag ?? "").trim();
          if (!tag) continue;
          const tags = (go.getData("peaky.tags") as string[] | undefined) ?? [];
          if (!tags.includes(tag)) tags.push(tag);
          go.setData("peaky.tags", tags);
        } else if (a.kind === "RemoveSpriteObjectTag") {
          const tag = String(cfg.tag ?? "").trim();
          if (!tag) continue;
          const tags = (go.getData("peaky.tags") as string[] | undefined) ?? [];
          go.setData("peaky.tags", tags.filter((t) => t !== tag));
        } else if (a.kind === "ClearSpriteObjectTags") {
          go.setData("peaky.tags", []);
        } else if (a.kind === "AddSpriteObjectCollideTag") {
          const tag = String(cfg.tag ?? "").trim();
          if (!tag) continue;
          const tags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
          if (!tags.includes(tag)) tags.push(tag);
          go.setData("peaky.collideTags", tags);
        } else if (a.kind === "RemoveSpriteObjectCollideTag") {
          const tag = String(cfg.tag ?? "").trim();
          if (!tag) continue;
          const tags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
          go.setData("peaky.collideTags", tags.filter((t) => t !== tag));
        } else if (a.kind === "ClearSpriteObjectCollideTags") {
          go.setData("peaky.collideTags", []);
        }
      }
      break;
    }
    case "SetPlacementVisible":
    case "SetPlacementFrame":
    case "PlayPlacementAnim":
    case "StopPlacementAnim":
    case "SetPlacementPos":
    case "SetPlacementScale":
    case "SetPlacementRotation":
    case "SetPlacementAlpha": {
      // Sprite Object setter family — resolve by sprite asset id and
      // apply the change to EVERY placement of that sprite asset in
      // the scene. The list of GameObjects is maintained per spriteId
      // by runProject's spawn loop and the CreateSpriteObject handler.
      const spriteId = String(cfg.spriteId ?? "").trim();
      if (!spriteId) break;
      const idx = sprite.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
      const list = idx?.get(spriteId);
      if (!list || list.length === 0) break;
      for (const go of list) {
        if (a.kind === "SetPlacementVisible") {
          go.setVisible(!!cfg.visible);
        } else if (a.kind === "SetPlacementFrame") {
          const fn = go.getData("peaky.placementSetFrame") as ((i: number) => void) | undefined;
          if (fn) fn(numOr(cfg.frame, 0, sprite));
        } else if (a.kind === "PlayPlacementAnim") {
          const animName = String(cfg.animation ?? "").trim();
          if (animName) {
            const fn = go.getData("peaky.placementSwitchAnim") as
              ((name: string, opts: { loop?: boolean; startFrame?: number }) => void) | undefined;
            if (fn) fn(animName, {
              loop: cfg.loop !== false,
              startFrame: numOr(cfg.startFrame, 0, sprite),
            });
          } else {
            const fn = go.getData("peaky.placementSetPlaying") as ((v: boolean) => void) | undefined;
            if (fn) fn(true);
          }
        } else if (a.kind === "StopPlacementAnim") {
          const fn = go.getData("peaky.placementSetPlaying") as ((v: boolean) => void) | undefined;
          if (fn) fn(false);
        } else if (a.kind === "SetPlacementPos") {
          go.setPosition(numOr(cfg.x, go.x, sprite), numOr(cfg.y, go.y, sprite));
        } else if (a.kind === "SetPlacementScale") {
          go.setScale(numOr(cfg.scaleX, 1, sprite), numOr(cfg.scaleY, 1, sprite));
        } else if (a.kind === "SetPlacementRotation") {
          go.setRotation((numOr(cfg.rotation, 0, sprite) * Math.PI) / 180);
        } else if (a.kind === "SetPlacementAlpha") {
          go.setAlpha(Math.max(0, Math.min(1, numOr(cfg.alpha, 1, sprite))));
        }
      }
      break;
    }
    case "SetLoadingProgress": {
      // Manual progress drive — useful when the author runs custom warm-up
      // logic after the auto-load completes (e.g. spawning enemy pools)
      // and wants a layered progress bar. Emits the same signal the
      // auto-loader fires, so the same Logic Sheet trigger receives both.
      const pct = Math.max(0, Math.min(1, Number(cfg.pct ?? 0)));
      const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      for (const s of list) {
        if (s.destroyed) continue;
        if (s.events.listenerCount("_loadProgress") > 0) s.events.emit("_loadProgress", { pct });
      }
      break;
    }
    case "GoToNextLayout": {
      const list = (sprite.scene.data.get("peaky.sceneList") as string[] | undefined) ?? [];
      const cur = (sprite.scene.data.get("peaky.activeSceneName") as string | undefined) ?? sprite.scene.scene.key;
      const idx = list.indexOf(cur);
      const next = list[(idx + 1) % Math.max(1, list.length)];
      if (next) drainSceneEndThen(sprite, () => emitGoToScene(sprite, next));
      break;
    }
    case "RecreateInitialObjects":
      // Same effect as RestartLayout in this runtime — restart re-runs the
      // scene's create() which re-instantiates the BP placements.
      drainSceneEndThen(sprite, () => sprite.scene.scene.restart());
      break;
    case "CreateObject":
    case "CreateObjectByName": {
      // Spawn delegated to a project-level callback registered on scene.data
      // by runProject.ts. Without it, log and bail.
      // CreateObject goes through the spawn budget (50/frame default) so a
      // 1500-NPC OnSceneStart loop ramps in over ~30 frames instead of
      // freezing the browser. Excess spawns enqueue and drain on later
      // frames via Game.ts's start-of-frame queue drain. FireProjectile
      // bypasses this with `immediate: true` — see that case below.
      const spawn = sprite.scene.data.get("peaky.spawn") as
        | ((arg: { id?: string; name?: string; x: number; y: number; layer?: string; vars?: Record<string, number | string | boolean>; instanceName?: string; animation?: string; frame?: number; tag?: string }, opts?: { immediate?: boolean }) => void)
        | undefined;
      if (!spawn) {
        console.warn("[Peaky] Spawn callback not registered — CreateObject ignored.");
        break;
      }
      const x = numOr(cfg.x, 0, sprite);
      const y = numOr(cfg.y, 0, sprite);
      // Optional layer override — name of a layer to spawn into. Empty =
      // use the scene's active layer (legacy default).
      const layer = strOr(cfg.layer, "", sprite);
      // Per-spawn variable overrides (the `exposeOnSpawn` set authored
      // in the action row). Each value gets resolved through num/strOr
      // so the user can write `var:hp` / `tracer:T.f` / arithmetic in
      // the spawn-var input and have it computed at fire time.
      const spawnVarsCfg = cfg.spawnVars as Record<string, unknown> | undefined;
      let resolvedVars: Record<string, number | string | boolean> | undefined;
      if (spawnVarsCfg) {
        resolvedVars = {};
        for (const [k, v] of Object.entries(spawnVarsCfg)) {
          if (typeof v === "boolean") resolvedVars[k] = v;
          else if (typeof v === "number") resolvedVars[k] = v;
          else if (typeof v === "string") {
            // Try numeric expression first, fall back to literal string.
            const n = numOr(v, NaN, sprite);
            resolvedVars[k] = Number.isFinite(n) ? n : strOr(v, v, sprite);
          }
        }
      }
      // Optional spawn-time overrides (set by the Drop node; Create Object
      // leaves them empty). instanceName names the new instance; animation +
      // frame pose its SpriteRenderer — a numeric `frame` freezes it (static
      // pose), an empty frame lets the animation play; tag adds + indexes one
      // extra tag. Empty = leave the blueprint's own default.
      const spawnInstanceName = strOr(cfg.instanceName, "", sprite);
      const spawnAnimation = strOr(cfg.animation, "", sprite);
      const spawnFrameSet = cfg.frame !== "" && cfg.frame != null;
      const spawnFrameNum = spawnFrameSet ? numOr(cfg.frame, NaN, sprite) : NaN;
      const spawnTag = strOr(cfg.tag, "", sprite);
      const spawnExtras = {
        instanceName: spawnInstanceName || undefined,
        animation: spawnAnimation || undefined,
        frame: Number.isFinite(spawnFrameNum) ? spawnFrameNum : undefined,
        tag: spawnTag || undefined,
      };
      if (a.kind === "CreateObject") {
        spawn({ id: String(cfg.blueprintId ?? ""), x, y, layer, vars: resolvedVars, ...spawnExtras });
      } else {
        spawn({ name: String(cfg.blueprintName ?? ""), x, y, layer, vars: resolvedVars, ...spawnExtras });
      }
      break;
    }
    case "FireProjectile": {
      const spawn = sprite.scene.data.get("peaky.spawn") as
        | ((arg: { id?: string; name?: string; x: number; y: number; layer?: string }, opts?: { immediate?: boolean }) => Sprite | null)
        | undefined;
      if (!spawn) {
        console.warn("[Peaky] FireProjectile: peaky.spawn callback not registered on scene.data — bailing.");
        break;
      }
      const bpName = strOr(cfg.blueprintName, "", sprite);
      if (!bpName) {
        console.warn("[Peaky] FireProjectile: blueprintName is empty in cfg.", cfg);
        break;
      }
      // Spawn position = firing sprite's center by default, OR a named image
      // point on its current frame (e.g. a "Muzzle" on the gun) when
      // `spawnImagePoint` is set. getImagePointWorld is facing-aware, so the
      // muzzle stays in front when the sprite faces left. When a point name is
      // set but the CURRENT frame doesn't carry it, the shot is SUPPRESSED (no
      // bullet) — firing from the pivot instead would put it in the wrong spot.
      let x = sprite.gameObject.x;
      let y = sprite.gameObject.y;
      const spawnPt = strOr(cfg.spawnImagePoint, "", sprite).trim();
      if (spawnPt) {
        const sr = sprite.findBehaviorByKind("SpriteRenderer") as
          | { getImagePointWorld?: (n: string) => { x: number; y: number } | null }
          | undefined;
        const wp = sr?.getImagePointWorld?.(spawnPt);
        if (!wp) break; // point not on the current frame → don't fire
        x = wp.x; y = wp.y;
      }
      const facing = (sprite as unknown as { facingScaleX?: number }).facingScaleX ?? 1;

      // immediate: true bypasses the spawn budget. A bullet MUST appear
      // the same frame the fire trigger runs — queueing would feel broken.
      const spawned = spawn({ name: bpName, x, y }, { immediate: true });
      if (!spawned) break;
      const proj = spawned.findBehaviorByKind("Projectile") as
        | (Record<string, unknown> & { mode?: "straight" | "homing"; launch: (a: number, s?: number, t?: number) => void })
        | undefined;
      if (!proj) {
        console.warn(`[FireProjectile] BP "${bpName}" has no Projectile behavior — bullet will sit still. Attach Projectile in the BP inspector.`);
        break;
      }
      // Apply per-shot overrides — each ovrXxx flag, if truthy, replaces
      // the BP's Projectile field with the action's value for this shot.
      // Off (default) → field falls through to the BP's authored value.
      const num = (flagKey: string, valKey: string) => {
        if (!numOr(cfg[flagKey], 0, sprite)) return;
        const v = numOr(cfg[valKey], NaN, sprite);
        if (Number.isFinite(v)) (proj as Record<string, unknown>)[valKey] = v;
      };
      const str = (flagKey: string, valKey: string) => {
        if (!numOr(cfg[flagKey], 0, sprite)) return;
        (proj as Record<string, unknown>)[valKey] = strOr(cfg[valKey], "", sprite);
      };
      // `mode` is a string enum override; needs its own path since num()
      // and str() expect numeric / arbitrary strings. straight | homing.
      if (numOr(cfg.ovrMode, 0, sprite)) {
        const m = String(cfg.mode ?? "straight");
        if (m === "homing" || m === "straight") proj.mode = m;
      }
      num("ovrSpeed", "speed");
      num("ovrLifetime", "lifetime");
      num("ovrGravityX", "gravityX");
      num("ovrGravityY", "gravityY");
      str("ovrTargetTags", "targetTags");
      str("ovrHitSignal", "hitSignal");
      num("ovrDestroyOnHit", "destroyOnHit");
      num("ovrRotateToVelocity", "rotateToVelocity");
      num("ovrDamage", "damage");
      num("ovrKnockbackX", "knockbackX");
      num("ovrKnockbackY", "knockbackY");
      num("ovrHitboxW", "hitboxW");
      num("ovrHitboxH", "hitboxH");
      num("ovrHomingTurnRate", "homingTurnRate");
      // Compute initial firing angle. In HOMING mode, aim straight at the
      // nearest target sprite carrying any of `targetTags` so the bullet
      // doesn't have to fight its limited turn rate from a 90° wrong
      // start. This mirrors what Projectile._resolveTarget will do every
      // tick — we just snapshot it once at fire time for the initial
      // heading. STRAIGHT mode falls back to facing direction (the
      // pre-homing default), so a bullet without homing still fires
      // forward as before.
      let rad = facing < 0 ? Math.PI : 0;
      if (proj.mode === "homing") {
        const tagsStr = String((proj as Record<string, unknown>).targetTags ?? "");
        const tags = tagsStr.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
        if (tags.length > 0) {
          // Tag index — only iterate sprites carrying one of the target
          // tags instead of every sprite in the scene. At 5000 NPCs +
          // 1 player tagged "player", went from 5000 ops/shot to 1.
          let bestSprite: Sprite | null = null;
          let bestD2 = Infinity;
          const seen = tags.length > 1 ? new Set<Sprite>() : null;
          for (const t of tags) {
            const candidates = getSpritesByTag(sprite.scene, t);
            for (const s of candidates) {
              if (s.destroyed || s === sprite || s === spawned) continue;
              if (seen) { if (seen.has(s)) continue; seen.add(s); }
              const dx = s.gameObject.x - x;
              const dy = s.gameObject.y - y;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2) { bestD2 = d2; bestSprite = s; }
            }
          }
          if (bestSprite) {
            rad = Math.atan2(bestSprite.gameObject.y - y, bestSprite.gameObject.x - x);
          } else {
            console.warn(`[FireProjectile] homing bullet "${bpName}" found no sprite carrying any of [${tags.join(", ")}]. Firing in facing direction; bullet will home-search live each tick once it spawns.`);
          }
        } else {
          console.warn(`[FireProjectile] homing bullet "${bpName}" has empty targetTags. Set targetTags on the BP's Projectile component (e.g. "player") so the bullet knows what to chase.`);
        }
      }
      // launch() reads the (possibly-overridden) proj.speed itself, so we
      // pass undefined and let the Projectile use its own field.
      proj.launch(rad);
      break;
    }
    case "MoveToSetPosition": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; targetX: number | string; targetY: number | string; speed: number; enabled: boolean; navPath?: unknown; navPatrol?: unknown }
        | undefined;
      if (!mt) { console.warn("[MoveToSetPosition] sprite has no MoveTo behavior"); break; }
      mt.mode = "position";
      mt.navPath = null;
      mt.navPatrol = null;
      mt.targetX = numOr(cfg.x, 0, sprite);
      mt.targetY = numOr(cfg.y, 0, sprite);
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      mt.enabled = true;
      break;
    }
    case "MoveToNavPoint": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; speed: number; enabled: boolean; navPath: { x: number; y: number }[] | null; navPatrol?: unknown; navTarget?: unknown; navWant?: string }
        | undefined;
      if (!mt) { Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: "MoveToNavPoint: sprite has no MoveTo component." }); break; }
      mt.navPatrol = null;
      const grid = sprite.scene?.data?.get("peaky.navGrid") as import("../nav/NavGrid").NavGrid | undefined;
      if (!grid) { Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: "MoveToNavPoint: no nav mesh painted in this scene." }); break; }
      const want = strOr(cfg.point, "", sprite).trim();
      // Resolve the destination waypoint: match by name OR tag; empty = nearest of any.
      const ox = sprite.gameObject.x, oy = sprite.gameObject.y;
      const cands = grid.waypoints.filter((w) => isNavPointAvailable(sprite.scene, w, sprite.uid) && (!want || w.name === want || (w.tags ?? []).includes(want)));
      if (cands.length === 0) {
        sprite.events.emit("OnNavFailed");
        const names = grid.waypoints.map((w) => w.name || (w.tags[0] ?? "?")).join(", ");
        Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: `MoveToNavPoint: no waypoint "${want}". Available: [${names}]` });
        break;
      }
      let goal = cands[0], bd = Infinity;
      for (const w of cands) { const d = (w.x - ox) ** 2 + (w.y - oy) ** 2; if (d < bd) { bd = d; goal = w; } }
      const path = findPath(grid, ox, oy, goal.x, goal.y);
      if (!path) { sprite.events.emit("OnNavFailed"); Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: `MoveToNavPoint: no path to "${goal.name || goal.tags[0]}" (blocked / off the walkable mesh).` }); break; }
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      mt.mode = "position";
      mt.navWant = want;
      mt.navPath = path;
      mt.navTarget = { id: goal.id, x: goal.x, y: goal.y, name: goal.name, tags: goal.tags, waitSec: goal.waitSec, signalOnArrive: goal.signalOnArrive, srcMap: goal.srcMap, srcX: goal.srcX, srcY: goal.srcY, setStateAny: goal.setStateAny, setStates: goal.setStates, singleUse: goal.singleUse };
      if (goal.id) claimNavPoint(sprite.scene, goal.id, sprite.uid); // claim now so same-frame peers don't double-pick
      mt.enabled = true;
      break;
    }
    case "PatrolNavPoints": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; speed: number; enabled: boolean; navWant?: string; navFallbackState?: string; navWaiting?: boolean; navPath: { x: number; y: number }[] | null; navPatrol: { points: { x: number; y: number; name?: string; tags?: string[]; waitSec?: number; signalOnArrive?: string }[]; idx: number; mode: string; dir: number } | null }
        | undefined;
      if (!mt) { Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: "PatrolNavPoints: sprite has no MoveTo component." }); break; }
      const grid = sprite.scene?.data?.get("peaky.navGrid") as import("../nav/NavGrid").NavGrid | undefined;
      if (!grid) { Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: "PatrolNavPoints: no nav mesh painted in this scene." }); break; }
      const tag = strOr(cfg.tag, "", sprite).trim();
      // Keep ALL matching points in the patrol (availability is re-checked on each
      // advance) so the route still knows about a bush that's currently taken/
      // mined and can return to it once it frees up.
      const pts = grid.waypoints.filter((w) => !tag || (w.tags ?? []).includes(tag) || w.name === tag).map((w) => ({ id: w.id, x: w.x, y: w.y, name: w.name, tags: w.tags, waitSec: w.waitSec, signalOnArrive: w.signalOnArrive, srcMap: w.srcMap, srcX: w.srcX, srcY: w.srcY, setStateAny: w.setStateAny, setStates: w.setStates, singleUse: w.singleUse }));
      if (pts.length === 0) { sprite.events.emit("OnNavFailed"); Logger.log({ level: "warn", source: sourceLabel ?? a.kind, message: `PatrolNavPoints: no waypoints tagged "${tag}".` }); break; }
      const modeStr = strOr(cfg.mode, "loop", sprite);
      const mode = (modeStr === "pingpong" || modeStr === "random" || modeStr === "nearest") ? modeStr : "loop";
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      const fallback = strOr(cfg.fallback, "", sprite).trim();
      // Start at the nearest AVAILABLE point (claim it so same-frame peers pick a
      // different one — prevents stacking when bushes < sheep).
      const ox = sprite.gameObject.x, oy = sprite.gameObject.y;
      let startIdx = -1, bd = Infinity;
      for (let k = 0; k < pts.length; k++) {
        if (!isNavPointAvailable(sprite.scene, pts[k], sprite.uid)) continue;
        const d = (pts[k].x - ox) ** 2 + (pts[k].y - oy) ** 2;
        if (d < bd) { bd = d; startIdx = k; }
      }
      mt.navWant = tag;
      mt.navFallbackState = fallback;
      mt.navPatrol = { points: pts, idx: Math.max(0, startIdx), mode, dir: 1 };
      mt.mode = "position";
      mt.enabled = true;
      if (startIdx >= 0) {
        mt.navPath = findPath(grid, ox, oy, pts[startIdx].x, pts[startIdx].y);
        if (pts[startIdx].id) claimNavPoint(sprite.scene, pts[startIdx].id, sprite.uid);
        mt.navWaiting = false;
      } else {
        // Every point taken / mined right now → park idle; MoveTo resumes when one frees.
        mt.navPath = null;
        mt.navWaiting = true;
        sprite.events.emit("OnNavFailed");
        const anim = sprite.findBehaviorByKind("StateMachine") as { forcedState?: string } | undefined;
        if (anim && fallback) anim.forcedState = fallback;
      }
      break;
    }
    case "MoveToSetObject": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; targetUid: number; speed: number; enabled: boolean }
        | undefined;
      if (!mt) { console.warn("[MoveToSetObject] sprite has no MoveTo behavior"); break; }
      mt.mode = "object";
      mt.targetUid = numOr(cfg.uid, -1, sprite);
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      mt.enabled = true;
      break;
    }
    case "MoveToSetTag": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; targetTag: string; speed: number; enabled: boolean }
        | undefined;
      if (!mt) { console.warn("[MoveToSetTag] sprite has no MoveTo behavior"); break; }
      mt.mode = "tag";
      mt.targetTag = strOr(cfg.tag, "", sprite);
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      mt.enabled = true;
      break;
    }
    case "MoveToSetAngle": {
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { mode: string; angleDeg: number; speed: number; enabled: boolean }
        | undefined;
      if (!mt) { console.warn("[MoveToSetAngle] sprite has no MoveTo behavior"); break; }
      mt.mode = "angle";
      mt.angleDeg = numOr(cfg.angleDeg, 0, sprite);
      const s = numOr(cfg.speed, 0, sprite);
      if (s > 0) mt.speed = s;
      mt.enabled = true;
      break;
    }
    case "MoveToStop": {
      const mt = sprite.findBehaviorByKind("MoveTo") as { enabled: boolean } | undefined;
      if (mt) mt.enabled = false;
      // Also zero out the body velocity so the sprite truly stops on the same
      // frame, not the next time physics ticks.
      const body = sprite.body;
      if (body) body.setVelocity(0, 0);
      break;
    }
    case "MoveToResume": {
      const mt = sprite.findBehaviorByKind("MoveTo") as { enabled: boolean } | undefined;
      if (mt) mt.enabled = true;
      break;
    }
    case "MoveToSetSpeed": {
      const mt = sprite.findBehaviorByKind("MoveTo") as { speed: number } | undefined;
      if (mt) mt.speed = numOr(cfg.speed, mt.speed, sprite);
      break;
    }
    case "SortZOrder":
      // Sort scene display list by Y so foreground objects render above
      // background ones — typical 2D top-down ordering.
      sprite.scene.children.sort("y", undefined as never);
      break;
    case "StopLoop":
      // Handled by the per-event loop runner in Sprite.tryFire.
      break;
    case "SaveSlot": {
      const slot = String(cfg.slot ?? "default");
      // Namespace the key by project so two games on one origin don't collide.
      // Empty namespace (older boot path) keeps the legacy un-namespaced key.
      const saveNs = (sprite.scene.data.get("peaky.saveNamespace") as string | undefined) ?? "";
      const saveKey = saveNs ? `peaky.save.${saveNs}.${slot}` : `peaky.save.${slot}`;
      try {
        // Snapshot every live sprite: uid, position, velocity, vars,
        // facing, AND each behavior's opt-in `serialize()` payload (set by
        // CharacterMovement / SpriteRenderer / Text — see Behavior.ts).
        // UID is the matching key on Load.
        const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        const snapshot = {
          ts: Date.now(),
          // Save-format version. Bump when the snapshot shape changes so a
          // future engine can detect (and refuse / migrate) old saves instead
          // of silently corrupting player progress.
          saveVersion: 1,
          sprites: list.map((s) => {
            const behaviorStates: Array<{ kind: string; state: Record<string, unknown> }> = [];
            // Serialize EVERY behavior that opts in (its serialize() returns
            // non-undefined). Iterating all behaviors — not a hardcoded kind
            // list — means Inventory / Damageable / PhaseManager /
            // CharacterAnimator (and any future behavior) round-trip without
            // being silently dropped. Base Behavior.serialize() returns
            // undefined, so non-persisting behaviors exclude themselves.
            for (const b of s.getBehaviors()) {
              const state = b.serialize();
              if (state) behaviorStates.push({ kind: b.kind, state });
            }
            return {
              uid: s.uid,
              instanceId: s.instanceId,
              x: s.gameObject.x,
              y: s.gameObject.y,
              // body is undefined for noPhysicsBody sprites — skip velocity
              // rather than throw the whole snapshot. Position still
              // round-trips via gameObject.x/y.
              vx: s.body?.velocity.x ?? 0,
              vy: s.body?.velocity.y ?? 0,
              facingScaleX: s.facingScaleX,
              vars: Object.fromEntries(s.vars),
              behaviors: behaviorStates,
            };
          }),
          // Cross-scene persistent state: permanently-removed objects + globals.
          ...serializePersistentState(),
        };
        let ok = false;
        try {
          localStorage.setItem(saveKey, JSON.stringify(snapshot));
          ok = true;
        } catch (e) {
          // Surface failure loudly — a silently-failed save (e.g. quota
          // exceeded on a big world) must not masquerade as success.
          const quota = e instanceof Error && /quota|exceeded/i.test(`${e.name} ${e.message}`);
          Logger.log({
            level: "error",
            source: "SaveSlot",
            message: quota
              ? `Save "${slot}" FAILED — browser storage quota exceeded (save too large). Progress was NOT saved.`
              : `Save "${slot}" failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        // Fire OnSaveLoadComplete regardless (success OR failure) per the
        // trigger's contract — so authors can detect a failed save.
        for (const s of list) s.events.emit("_saveLoadComplete", { ok, op: "save" });
      } catch (e) {
        console.warn("[Peaky] SaveSlot snapshot failed:", e);
      }
      break;
    }
    case "CMJump": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const used = cm.jumpsUsed ?? 0;
      const max = cm.multiJump ?? 1;
      if (used >= max) break;
      sprite.body.setVelocityY(-(cm.jumpStrength ?? 460));
      cm.jumpsUsed = used + 1;
      sprite.events.emit("OnJump");
      if (cm.jumpCustomFn) sprite.events.emit(cm.jumpCustomFn);
      break;
    }
    case "CMDash": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const now = sprite.scene.time.now / 1000;
      if (cm.dashing || now < (cm.dashReadyAtSec ?? 0)) break;
      const speed = cm.dashSpeed ?? 600;
      const dir = sprite.body.velocity.x >= 0 ? 1 : -1;
      sprite.body.setVelocityX(speed * dir);
      sprite.body.setVelocityY(0);
      // Mark dashing — CharacterMovement.update will manage end-of-dash + cooldown.
      cm.dashing = true;
      sprite.events.emit("OnDashStart");
      if (cm.dashCustomFn) sprite.events.emit(cm.dashCustomFn);
      break;
    }
    case "CMStopMovement":
      sprite.body.setVelocityX(0);
      sprite.body.setVelocityY(0);
      break;
    case "CMStopDash": {
      // Cancel an active dash (windup or active phase). Delegates to the
      // behavior's `cancelDash()` so the cooldown is set on the behavior's
      // OWN clock (`this.now`, accumulated from delta), which is what the
      // dash-press check compares against. No-op when no dash is in flight.
      sprite.findBehaviorByKind("CharacterMovement")?.cancelDash();
      break;
    }
    case "CMStopWallSlide": {
      sprite.findBehaviorByKind("CharacterMovement")?.cancelWallSlide();
      break;
    }
    case "CMSet": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const param = String(cfg.param ?? "");
      if (!param) break;
      // Same allow-list guard as SetBehaviorParam — keeps a typo from
      // clobbering `kind` / `enabled` / private fields.
      if (!isWritableBehaviorParam("CharacterMovement", param)) {
        Logger.log({
          level: "warn",
          source: "CMSet",
          message: `"${param}" is not a writable CharacterMovement param.`,
        });
        break;
      }
      const cmRec = cm as unknown as Record<string, unknown>;
      const cur = cmRec[param];
      // Match the existing field's type so users can pass true/false to bool
      // toggles without manual conversion.
      let next: unknown;
      const raw = cfg.value;
      if (typeof cur === "boolean") {
        next = typeof raw === "boolean" ? raw : raw === 1 || raw === "true" || raw === "1";
      } else if (typeof cur === "number") {
        if (typeof raw === "number") next = raw;
        else if (typeof raw === "boolean") next = raw ? 1 : 0;
        else next = Number(raw) || 0;
      } else {
        next = raw;
      }
      cmRec[param] = next;
      break;
    }
    case "CMResetJumps": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (cm) cm.jumpsUsed = 0;
      break;
    }
    case "CMIgnoreInput": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const raw = cfg.ignore;
      cm.ignoreInput = raw === "toggle" ? (cm.ignoreInput ? 0 : 1)
        : (raw === "off" || raw === false || raw === 0 || raw === "false" || raw === "0") ? 0
        : 1;
      break;
    }
    case "CMFallThrough": {
      // Skip JumpThru collisions for `duration` seconds so the player drops
      // through any platform they're standing on. Game.ts's collider
      // process-callback consults this deadline.
      const dur = numOr(cfg.duration, 0.2, sprite);
      // Scaled sim clock (ms), NOT performance.now(): the window must freeze
      // during pause / hitstop / slow-mo, else it expires mid-pause and the
      // player lands on the platform they were dropping through.
      sprite.fallingThroughUntil = sprite.simNowMs + Math.max(0, dur) * 1000;
      break;
    }
    case "CMSetDefaultControls": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      cm.leftAction  = "MoveLeft";
      cm.rightAction = "MoveRight";
      cm.jumpAction  = "Jump";
      cm.dashAction  = "Dash";
      break;
    }
    // ── Explicit CM property setters — thin aliases of CMSet for picker
    //    discoverability. Each writes the named field with type coercion.
    case "CMSetMaxSpeed":
    case "CMSetAcceleration":
    case "CMSetDeceleration":
    case "CMSetGravity":
    case "CMSetGravityAngle":
    case "CMSetMaxFallSpeed":
    case "CMSetJumpStrength":
    case "CMSetMultiJump": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const value = numOr(cfg.value, 0, sprite);
      switch (a.kind) {
        case "CMSetMaxSpeed":      cm.maxSpeed     = value; break;
        case "CMSetAcceleration":  cm.acceleration = value; break;
        case "CMSetDeceleration":  cm.deceleration = value; break;
        case "CMSetGravity":       cm.gravity      = value; break;
        case "CMSetGravityAngle":  cm.gravityAngle = value; break;
        case "CMSetMaxFallSpeed":  cm.maxFallSpeed = value; break;
        case "CMSetJumpStrength":  cm.jumpStrength = value; break;
        case "CMSetMultiJump":     cm.multiJump    = value; break;
      }
      break;
    }
    case "CMSetJumpSustain": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const raw = cfg.value;
      const flag = typeof raw === "boolean" ? raw : raw === 1 || raw === "true" || raw === "1";
      cm.jumpSustainEnabled = flag ? 1 : 0;
      break;
    }
    case "CMSetCeilingMode": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const m = String(cfg.mode ?? "stop");
      cm.ceilingMode = m === "preserve" ? 1 : 0;
      break;
    }
    case "CMSetDoubleJump": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const raw = cfg.value;
      const on = typeof raw === "boolean" ? raw : raw === 1 || raw === "true" || raw === "1";
      cm.multiJump = on ? 2 : 1;
      break;
    }
    case "CMSetMirror": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const raw = String(cfg.mode ?? "off").toLowerCase();
      cm.mirrorMode = raw === "velocity" ? 1 : raw === "input" ? 2 : 0;
      break;
    }
    case "SetFacing": {
      // Manual mirror control. Independent of CMSetMirror (CM's auto-flip
      // mode) and AIBrain.autoFaceTarget — those should be turned off
      // when authors want full control via this action. Writes directly
      // to sprite.facingScaleX which SR's per-tick overlay sync reads.
      const dir = String(cfg.direction ?? "left").toLowerCase();
      const s = sprite as unknown as { facingScaleX: number };
      if (dir === "right") s.facingScaleX = 1;
      else if (dir === "left") s.facingScaleX = -1;
      else if (dir === "flip") s.facingScaleX = s.facingScaleX < 0 ? 1 : -1;
      break;
    }
    case "CMSimulateControl": {
      const cm = sprite.findBehaviorByKind("CharacterMovement");
      if (!cm) break;
      const ctl = String(cfg.control ?? "jump");
      // CharacterMovement listens for `*EventTrigger` event names — emit one
      // matching the picked control. If the trigger isn't configured, fall
      // back to a conventional default name.
      const evtName: Record<string, string> = {
        left:  cm.leftEventTrigger  || "_simulate_left",
        right: cm.rightEventTrigger || "_simulate_right",
        jump:  cm.jumpEventTrigger  || "_simulate_jump",
        dash:  cm.dashEventTrigger  || "_simulate_dash",
      };
      const name = evtName[ctl];
      if (!name) break;
      // Set the trigger field temporarily if it wasn't user-configured, so
      // CharacterMovement.update() will pick up the simulated press.
      if (ctl === "left"  && !cm.leftEventTrigger)  cm.leftEventTrigger  = name;
      if (ctl === "right" && !cm.rightEventTrigger) cm.rightEventTrigger = name;
      if (ctl === "jump"  && !cm.jumpEventTrigger)  cm.jumpEventTrigger  = name;
      if (ctl === "dash"  && !cm.dashEventTrigger)  cm.dashEventTrigger  = name;
      sprite.events.emit(name);
      break;
    }
    case "TMSet": {
      const tm = sprite.findBehaviorByKind("TopdownMovement");
      if (!tm) break;
      const param = String(cfg.tmParam ?? "");
      if (!param) break;
      if (!isWritableBehaviorParam("TopdownMovement", param)) {
        Logger.log({ level: "warn", source: "TMSet", message: `"${param}" is not a writable TopdownMovement param.` });
        break;
      }
      const rec = tm as unknown as Record<string, unknown>;
      const cur = rec[param];
      const raw = cfg.value;
      let next: unknown;
      if (typeof cur === "boolean") next = typeof raw === "boolean" ? raw : raw === 1 || raw === "true" || raw === "1";
      else if (typeof cur === "number") next = typeof raw === "number" ? raw : (typeof raw === "boolean" ? (raw ? 1 : 0) : (Number(raw) || 0));
      else next = raw;
      rec[param] = next;
      break;
    }
    case "TMStop": {
      sprite.body.setVelocityX(0);
      sprite.body.setVelocityY(0);
      break;
    }
    case "TMIgnoreInput": {
      const tm = sprite.findBehaviorByKind("TopdownMovement");
      if (!tm) break;
      const raw = cfg.ignore;
      tm.ignoreInput = raw === "toggle" ? (tm.ignoreInput ? 0 : 1)
        : (raw === "off" || raw === false || raw === 0 || raw === "false" || raw === "0") ? 0
        : 1;
      break;
    }
    case "TMSimulateControl": {
      // Mirror CMSimulateControl: emit the direction's event trigger so the
      // controller reads it as a one-frame press (TopdownMovement.held()
      // checks the *EventTrigger fields). Run every tick to keep moving.
      const tm = sprite.findBehaviorByKind("TopdownMovement");
      if (!tm) break;
      const dir = String(cfg.direction ?? "up");
      const field: Record<string, "upEventTrigger" | "downEventTrigger" | "leftEventTrigger" | "rightEventTrigger"> = {
        up: "upEventTrigger", down: "downEventTrigger", left: "leftEventTrigger", right: "rightEventTrigger",
      };
      const f = field[dir];
      if (!f) break;
      const name = tm[f] || `_simulate_${dir}`;
      if (!tm[f]) tm[f] = name;
      sprite.events.emit(name);
      break;
    }
    case "LoadSlot": {
      const slot = String(cfg.slot ?? "default");
      const saveNs = (sprite.scene.data.get("peaky.saveNamespace") as string | undefined) ?? "";
      const saveKey = saveNs ? `peaky.save.${saveNs}.${slot}` : `peaky.save.${slot}`;
      try {
        const raw = localStorage.getItem(saveKey);
        if (!raw) break;
        const parsed = JSON.parse(raw) as {
          ts?: number;
          saveVersion?: number;
          // Full-scene format. `behaviors` and `facingScaleX` are
          // optional for backwards-compat with saves predating L4.
          sprites?: {
            uid: number;
            instanceId?: string;
            x: number; y: number;
            vx?: number; vy?: number;
            facingScaleX?: number;
            vars: Record<string, unknown>;
            behaviors?: Array<{ kind: string; state: Record<string, unknown> }>;
          }[];
          // Legacy per-sprite-vars-only format (early stub).
          vars?: Record<string, unknown>;
          // Cross-scene persistent state (L5+).
          removedInstances?: string[];
          globals?: Record<string, number | string>;
        };
        // Refuse a save written by a NEWER engine (its shape may differ) —
        // best-effort loading would silently corrupt the player's progress.
        if (typeof parsed.saveVersion === "number" && parsed.saveVersion > 1) {
          Logger.log({
            level: "warn",
            source: "LoadSlot",
            message: `Save "${slot}" was written by a newer engine (saveVersion ${parsed.saveVersion}) — not loaded, to avoid corrupting it.`,
          });
          break;
        }
        // Restore persistent globals + removed-instances FIRST, then despawn
        // any currently-live object that was permanently removed (its stable
        // id is in the set) so the load matches the saved world immediately.
        applyPersistentState(parsed);
        const list = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        if (persistentState().removedInstances.size > 0) {
          for (const s of [...list]) {
            if (s.instanceId && persistentState().removedInstances.has(s.instanceId)) s.destroy();
          }
        }
        if (parsed.sprites) {
          // Match by the STABLE instanceId first (survives scene revisits +
          // reboots, where the runtime uid counter has moved on). Fall back to
          // uid for runtime-spawned objects that have no instanceId.
          const byInst = new Map<string, Sprite>();
          const byUid = new Map<number, Sprite>();
          for (const s of list) {
            if (s.instanceId) byInst.set(s.instanceId, s);
            byUid.set(s.uid, s);
          }
          for (const snap of parsed.sprites) {
            const s = (snap.instanceId ? byInst.get(snap.instanceId) : undefined) ?? byUid.get(snap.uid);
            if (!s) continue;
            // Wipe in-flight state FIRST so restored data starts clean —
            // queued Waits, running tweens, edge-detected event states
            // would otherwise interleave with the loaded snapshot.
            s.clearRuntimeState();
            // body is undefined for noPhysicsBody sprites — restore
            // position via the gameObject directly and skip velocity.
            if (s.body) {
              s.body.reset(snap.x, snap.y);
              s.body.setVelocity(snap.vx ?? 0, snap.vy ?? 0);
            } else {
              s.gameObject.setPosition(snap.x, snap.y);
            }
            if (typeof snap.facingScaleX === "number") s.facingScaleX = snap.facingScaleX;
            s.vars.clear();
            for (const [k, v] of Object.entries(snap.vars)) s.vars.set(k, v as never);
            // Apply per-behavior state. Match by kind — for multi-instance
            // behaviors (Tracer, Text) entries replay onto the matching
            // index. If counts don't match (BP edited between save and
            // load), extra entries are dropped silently.
            //
            // The used-index Set MUST be scoped per kind, not global —
            // otherwise indices for Tracer collide with indices for Text
            // (both start at 0) and the second kind's data gets dropped.
            // (audit CRIT #8)
            if (snap.behaviors) {
              const usedByKind = new Map<string, Set<number>>();
              for (const entry of snap.behaviors) {
                const kind = entry.kind as keyof typeof s.findBehaviorsByKind extends never ? string : string;
                const candidates = s.findBehaviorsByKind(kind as never);
                let used = usedByKind.get(kind);
                if (!used) { used = new Set(); usedByKind.set(kind, used); }
                let target: Behavior | undefined;
                for (let i = 0; i < candidates.length; i++) {
                  if (used.has(i)) continue;
                  target = candidates[i];
                  used.add(i);
                  break;
                }
                if (target) {
                  try { target.deserialize(entry.state); }
                  catch (e) { console.warn(`[Peaky] ${kind}.deserialize threw`, e); }
                }
              }
            }
          }
        } else if (parsed.vars) {
          for (const [k, v] of Object.entries(parsed.vars)) sprite.vars.set(k, v as never);
        }
        for (const s of list) s.events.emit("_saveLoadComplete");
      } catch (e) {
        console.warn("[Peaky] LoadSlot failed:", e);
      }
      break;
    }
    case "SetBehaviorParam": {
      // Behavior kind: new `behaviorKind`, else the legacy "Kind.param" target.
      let kind = String(cfg.behaviorKind ?? "");
      if (!kind) {
        const t = String(cfg.target ?? "");
        const d = t.indexOf(".");
        if (d >= 1) kind = t.slice(0, d);
      }
      if (!kind) break;
      // Pick a SPECIFIC component when the BP has several of this kind
      // (e.g. 3 Text overlays, Sight/Attack tracers) — match by the
      // component's Name. Blank = the first of that kind.
      const compName = String(cfg.componentName ?? "").trim();
      const behavior = compName
        ? sprite.findBehaviorsByKind(kind as never).find((b) => String((b as unknown as { name?: string }).name ?? "") === compName)
        : sprite.findBehaviorByKind(kind);
      if (!behavior) break;
      // One node can set MULTIPLE params: `params` is [{param, value}, ...].
      // Legacy single nodes fall back to the target/value pair.
      let plist = Array.isArray(cfg.params)
        ? (cfg.params as Array<{ param?: unknown; value?: unknown }>)
        : null;
      if (!plist) {
        const t = String(cfg.target ?? "");
        const d = t.indexOf(".");
        plist = d >= 1 ? [{ param: t.slice(d + 1), value: cfg.value }] : [];
      }
      const rec = behavior as unknown as Record<string, unknown>;
      for (const entry of plist) {
        const param = String(entry.param ?? "");
        if (!param) continue;
        // Reject params not in the behavior's writable allow-list — a typo
        // like "CharacterMovement.kind" would otherwise clobber the
        // discriminator / internal state.
        if (!isWritableBehaviorParam(kind, param)) {
          Logger.log({
            level: "warn",
            source: "SetBehaviorParam",
            message: `"${kind}.${param}" is not a writable param. Check the behavior's parameter list.`,
          });
          continue;
        }
        // VisionMask owns its on/off in `_maskOn` (the inspector `enabled`
        // field is clobbered by the component chip — §11.1).
        if (kind === "VisionMask" && param === "enabled") {
          (behavior as unknown as { _maskOn?: boolean })._maskOn = numOr(entry.value, 0, sprite) !== 0;
          continue;
        }
        // Coerce by the EXISTING field type so string params (spriteId,
        // currentAnimation, tags…) keep their string value instead of being
        // forced to a number by numOr (the old bug: "set sprite" wrote 0).
        rec[param] = typeof rec[param] === "string"
          ? strOr(entry.value, "", sprite)
          : numOr(entry.value, 0, sprite);
      }
      break;
    }
    case "SetBehaviorEnabled": {
      const kind = String(cfg.behavior ?? "");
      const behavior = sprite.findBehaviorByKind(kind);
      if (!behavior) break;
      behavior.enabled = numOr(cfg.enabled, 1, sprite) !== 0;
      break;
    }
    case "PlayAnimation": {
      const anim = String(cfg.animation ?? "");
      // `from` controls whether we restart from frame 0 or pick up where
      // we left off. Default "current" preserves the smart legacy logic
      // (switch anim if different; restart only on a discrete same-anim
      // re-trigger after the anim finished). "beginning" forces frame 0
      // every call — useful for "OnHit → Damage anim" patterns where the
      // user wants the anim to visibly replay even on continuous calls.
      const from = String(cfg.from ?? "current");
      if (anim) {
        const sr = sprite.findBehaviorByKind("SpriteRenderer");
        if (sr) {
          // Validate against the runtime animation map — without this a typo
          // (or stale event referencing a deleted anim) silently sets
          // `currentAnimation` to an unknown name, SpriteRenderer.update()
          // short-circuits, and the sprite freezes on its last frame.
          if (anim in sr._animations) {
            if (from === "beginning") {
              // Force restart — set anim, rewind frame, clear finished flag.
              sr.currentAnimation = anim;
              sr.currentFrameIdx = 0;
              sr.finishedEmitted = false;
              sr.restart();
              sr._lastPlayAnimRequestMs = sprite.scene.time.now;
            } else {
              // "current" — smart resume. Three cases:
              //  1) Different anim → switch (SpriteRenderer's update() will
              //     reset the frame counter since the anim name changed).
              //  2) Same anim, finished (non-loop), DISCRETE call → restart
              //     so a re-trigger replays. The DISCRETE check is the
              //     "called in the last ~100ms" heuristic.
              //  3) Same anim + continuous (every-frame) → leave alone so
              //     "While Falling → PlayAnimation(Fall)" doesn't visibly
              //     loop on each tick's call.
              const now = sprite.scene.time.now;
              const continuous = sr._lastPlayAnimRequestMs >= 0
                && (now - sr._lastPlayAnimRequestMs) < 100;
              sr._lastPlayAnimRequestMs = now;
              if (sr.currentAnimation !== anim) {
                sr.currentAnimation = anim;
              } else if (sr.finishedEmitted && !continuous) {
                sr.restart();
              }
            }
          } else {
            Logger.log({
              level: "warn",
              source: "PlayAnimation",
              message: `Animation "${anim}" not found on sprite (available: ${Object.keys(sr._animations).join(", ") || "none"}).`,
            });
          }
          // Implicit resume — PlayAnimation is the natural opposite of
          // StopAnimation. Without this, calling Play after Stop would
          // set currentAnimation but `playing` stays 0 → frames don't
          // advance and the user is confused.
          sr.playing = 1;
        }
      }
      break;
    }
    case "StopAnimation": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      // Freeze WHERE IT IS — pin `frame` to the current index so the paused
      // SR holds here (update() holds on `frame` when playing=0).
      if (sr) { sr.frame = sr.currentFrameIdx; sr.playing = 0; }
      break;
    }
    case "SetFrame": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) break;
      // numOr so authors can pass `var:hitFrame` or arithmetic.
      const idx = Math.max(0, Math.floor(numOr(cfg.frame, 0, sprite)));
      // `frame` is the picker; update() re-poses when currentFrameIdx !== frame.
      // Do NOT write currentFrameIdx here — setting both equal defeats that
      // change-detection so applyFrame never runs and the overlay never moves.
      sr.frame = idx;
      // Reset finished flag so a non-loop anim that previously hit its
      // last frame can be re-played from the new frame on the next tick.
      sr.finishedEmitted = false;
      break;
    }
    case "SetAnimationSpeed": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) break;
      // Speed is a multiplier (1 = native fps). Allow 0 to halt time-based
      // advance (acts as a soft pause without clearing playing); negative
      // would walk frames backward, which the elapsed-ms logic doesn't
      // support — clamp to 0.
      const speed = numOr(cfg.speed, 1, sprite);
      sr.speed = Math.max(0, speed);
      break;
    }
    case "SetSprite": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) break;
      const raw = strOr(cfg.spriteId, "", sprite);
      if (!raw) break;
      const tables = sprite.scene.data.get("peaky.spriteAnimTables") as
        | Record<string, Record<string, import("../behaviors/SpriteRenderer").SpriteAnimRuntime>>
        | undefined;
      // Accept either a sprite id (dropdown default) or a sprite NAME (wired /
      // typed string). Try the id directly, else resolve the name → id map.
      let spriteId = raw;
      let table = tables?.[spriteId];
      if (!table) {
        const byName = sprite.scene.data.get("peaky.spriteIdByName") as Record<string, string> | undefined;
        const mapped = byName?.[raw];
        if (mapped) { spriteId = mapped; table = tables?.[mapped]; }
      }
      if (!table) {
        console.warn(`[SetSprite] sprite "${raw}" not found by id or name in the project's sprite tables.`);
        break;
      }
      const animName = strOr(cfg.animation, "", sprite);
      sr.setSprite(spriteId, table, animName || undefined);
      break;
    }
    case "EquipWeapon": {
      const slot = strOr(cfg.slot, "", sprite);
      const spriteId = strOr(cfg.spriteId, "", sprite);
      const animName = strOr(cfg.animation, "", sprite);
      const slots = sprite.findBehaviorsByKind("WeaponSlot") as unknown as Array<{
        name?: string;
        equip: (id: string, animation?: string, anims?: Record<string, import("../behaviors/SpriteRenderer").SpriteAnimRuntime>, w?: number, h?: number) => void;
      }>;
      if (slots.length === 0) break;
      // Match by slot name; blank slot field = first WeaponSlot on the host.
      const target = slot
        ? slots.find((s) => String(s.name ?? "") === slot)
        : slots[0];
      if (!target) break;
      // Empty spriteId = unequip — clear animations + spriteId.
      if (!spriteId) {
        target.equip("", undefined, {}, 0, 0);
        break;
      }
      const tables = sprite.scene.data.get("peaky.spriteAnimTables") as
        | Record<string, Record<string, import("../behaviors/SpriteRenderer").SpriteAnimRuntime>>
        | undefined;
      const table = tables?.[spriteId];
      if (!table) {
        console.warn(`[EquipWeapon] sprite "${spriteId}" not found in the project's sprite tables.`);
        break;
      }
      const sizes = sprite.scene.data.get("peaky.spriteSizes") as
        | Record<string, { w: number; h: number }>
        | undefined;
      const sz = sizes?.[spriteId];
      target.equip(spriteId, animName || undefined, table, sz?.w, sz?.h);
      break;
    }
    case "PlayWeaponAnimation": {
      const slot = strOr(cfg.slot, "", sprite);
      const animName = strOr(cfg.animation, "", sprite);
      if (!animName) break;
      const slots = sprite.findBehaviorsByKind("WeaponSlot") as unknown as Array<{
        name?: string;
        playAnimation: (n: string) => void;
      }>;
      const target = slot
        ? slots.find((s) => String(s.name ?? "") === slot)
        : slots[0];
      target?.playAnimation(animName);
      break;
    }
    case "SetStatePriority": {
      // Mutate one animator state's priority in place. Lookup by name —
      // no-op if no row matches. Authors use this for "rage" buffs that
      // promote attack above walk, etc.
      const an = sprite.findBehaviorByKind("StateMachine") as { states?: Array<{ name: string; priority: number }>; invalidateStateOrder?: () => void } | undefined;
      if (!an || !Array.isArray(an.states)) break;
      const name = String(cfg.state ?? "");
      const priority = numOr(cfg.priority, 0, sprite);
      const row = an.states.find((s) => s.name === name);
      if (row) { row.priority = priority; an.invalidateStateOrder?.(); }
      break;
    }
    case "SetStateEnabled": {
      // Toggle one animator state on/off. Disabled rows are skipped by
      // the eval loop. Looked up by name; no-op when missing.
      const an = sprite.findBehaviorByKind("StateMachine") as { states?: Array<{ name: string; enabled?: number }> } | undefined;
      if (!an || !Array.isArray(an.states)) break;
      const name = String(cfg.state ?? "");
      const enabled = cfg.enabled === undefined ? 1 : (cfg.enabled ? 1 : 0);
      const row = an.states.find((s) => s.name === name);
      if (row) row.enabled = enabled;
      break;
    }
    case "SetActiveStateMachine": {
      // Switch which named State Machine drives the host (exclusive). The
      // animator repoints its active state list + resets per-state bookkeeping.
      const an = sprite.findBehaviorByKind("StateMachine") as { setActiveMachine?: (n: string) => void } | undefined;
      an?.setActiveMachine?.(strOr(cfg.machine, "", sprite));
      break;
    }
    case "Dismember": {
      const dm = sprite.findBehaviorByKind("Dismemberment");
      if (dm) {
        dm.dismember();
      } else {
        Logger.log({
          level: "warn",
          source: sourceLabel ?? "Dismember",
          message: "Dismember action fired but the subject has no Dismemberment component.",
        });
      }
      break;
    }
    case "StartParticles": {
      const ems = resolveEmitters(sprite, cfg);
      if (ems.length === 0 && String(cfg.target ?? "").trim() !== "") {
        const targetStr = String(cfg.target ?? "").trim();
        const allNames = (sprite.findBehaviorsByKind("ParticleEmitter") as Array<{ name?: string }>).map((e) => `"${e.name ?? ""}"`).join(", ");
        Logger.log({
          level: "warn",
          source: sourceLabel ?? "StartParticles",
          message: `no emitter matched "${targetStr}". Available on this BP: [${allNames || "(none)"}]. Names match exactly (case + whitespace).`,
        });
      }
      for (const em of ems) {
        applyParticleOverrides(em as unknown as Record<string, unknown>, cfg, sprite);
        em.start();
      }
      break;
    }
    case "StopParticles": {
      const ems = resolveEmitters(sprite, cfg);
      if (ems.length === 0 && String(cfg.target ?? "").trim() !== "") {
        const targetStr = String(cfg.target ?? "").trim();
        const allNames = (sprite.findBehaviorsByKind("ParticleEmitter") as Array<{ name?: string }>).map((e) => `"${e.name ?? ""}"`).join(", ");
        Logger.log({
          level: "warn",
          source: sourceLabel ?? "StopParticles",
          message: `no emitter matched "${targetStr}". Available on this BP: [${allNames || "(none)"}]. Names match exactly (case + whitespace).`,
        });
      }
      for (const em of ems) em.stop();
      break;
    }
    case "BurstParticles": {
      // `count` is read INDEPENDENTLY of the override gate — authors set it
      // per-action regardless of whether other emitter params are overridden.
      const count = Math.max(0, Math.floor(numOr(cfg.count, 30, sprite)));
      const ems = resolveEmitters(sprite, cfg);
      if (ems.length === 0) {
        const targetStr = String(cfg.target ?? "").trim();
        const allNames = (sprite.findBehaviorsByKind("ParticleEmitter") as Array<{ name?: string }>).map((e) => `"${e.name ?? ""}"`).join(", ");
        // Route to Logger so the Output Log warn-badge surfaces the miss.
        // Exact match (case + whitespace sensitive) is a common author
        // footgun — surface the available names so the typo is obvious
        // without opening F12.
        Logger.log({
          level: "warn",
          source: sourceLabel ?? "BurstParticles",
          message: `no emitter matched "${targetStr}". Available on this BP: [${allNames || "(none)"}]. Names match exactly (case + whitespace).`,
        });
      }
      for (const em of ems) {
        applyParticleOverrides(em as unknown as Record<string, unknown>, cfg, sprite);
        em.burst(count);
      }
      break;
    }
    case "SetParticleRate": {
      const rate = Math.max(0, numOr(cfg.rate, 10, sprite));
      for (const em of resolveEmitters(sprite, cfg)) em.setRate(rate);
      break;
    }
    case "SetParticleSpeed": {
      const speed = numOr(cfg.speed, 100, sprite);
      const jitter = Math.max(0, numOr(cfg.jitter, 0, sprite));
      for (const em of resolveEmitters(sprite, cfg)) em.setSpeed(speed, jitter);
      break;
    }
    case "SetParticleGravity": {
      const gx = numOr(cfg.x, 0, sprite);
      const gy = numOr(cfg.y, 0, sprite);
      for (const em of resolveEmitters(sprite, cfg)) em.setGravity(gx, gy);
      break;
    }
    case "SetParticleSprite": {
      const spriteId = String(cfg.spriteId ?? "").trim();
      if (!spriteId) break;
      const map = sprite.scene.data.get("peaky.spriteAssetFirstFrame") as Map<string, string> | undefined;
      const textureKey = map?.get(spriteId) ?? spriteId;
      if (!sprite.scene.textures.exists(textureKey)) break;
      for (const em of resolveEmitters(sprite, cfg)) em.setTexture(textureKey);
      break;
    }
    case "SetEventGroupEnabled": {
      const group = String(cfg.group ?? "").trim();
      if (group) sprite.setEventGroupEnabled(group, numOr(cfg.enabled, 1, sprite) !== 0);
      break;
    }
    case "SetGroupActive": {
      // Toggle one of THIS sprite's Logic Sheet groups (folders) by name. The
      // trigger `fire` in LogicSheetRunner skips groups whose name is disabled.
      const group = strOr(cfg.group, "", sprite).trim();
      if (!group) break;
      const on = typeof cfg.active === "boolean" ? cfg.active : numOr(cfg.active, 1, sprite) !== 0;
      if (on) sprite._disabledGroups.delete(group);
      else sprite._disabledGroups.add(group);
      break;
    }
    case "SetText": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.content = strOr(cfg.text, "", sprite);
      break;
    }
    case "AppendText": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.content = String(t.content ?? "") + strOr(cfg.text, "", sprite);
      break;
    }
    case "SetFontFamily": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.fontFamily = strOr(cfg.family, "Arial", sprite);
      break;
    }
    case "SetFontSize": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.fontSize = Math.max(1, numOr(cfg.size, 16, sprite));
      break;
    }
    case "SetTextColor": {
      const raw = cfg.color;
      let color = 0xffffff;
      if (typeof raw === "number") color = raw;
      else if (typeof raw === "string" && raw.length > 0) {
        const trimmed = raw.trim().replace(/^#/, "0x");
        const parsed = Number(trimmed);
        if (!Number.isNaN(parsed)) color = parsed;
      }
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.color = color;
      break;
    }
    case "SetBold": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.bold = numOr(cfg.value, 0, sprite) !== 0 ? 1 : 0;
      break;
    }
    case "SetItalic": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.italic = numOr(cfg.value, 0, sprite) !== 0 ? 1 : 0;
      break;
    }
    case "SetAlignH": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (!t) break;
      const v = strOr(cfg.align, "left", sprite);
      if (v === "left" || v === "center" || v === "right") t.align = v;
      break;
    }
    case "SetAlignV": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (!t) break;
      const v = strOr(cfg.align, "top", sprite);
      if (v === "top" || v === "middle" || v === "bottom") t.vAlign = v;
      break;
    }
    case "SetWrapWidth": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.wrapWidth = Math.max(0, numOr(cfg.width, 0, sprite));
      break;
    }
    case "SetTextVisible": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.visible = numOr(cfg.visible, 1, sprite) !== 0 ? 1 : 0;
      break;
    }
    case "ShowText": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.visible = 1;
      break;
    }
    case "HideText": {
      const t = resolveTextBehavior(sprite, cfg.textName);
      if (t) t.visible = 0;
      break;
    }
    case "PlayAnimatorAnim": {
      const a = sprite.findBehaviorByKind("SmartTween") as { play?: (n: string, override?: boolean) => void } | undefined;
      const name = String(cfg.name ?? "");
      // `override` defaults to 1 (true) so legacy event-sheets keep restarting
      // on every Play call. Set 0 to skip the call when the animation is
      // already mid-play — useful for "play swing on attack, but don't
      // re-trigger mid-swing if the player mashes the key".
      const override = cfg.override === undefined ? true : !!cfg.override;
      if (a && name) a.play?.(name, override);
      break;
    }
    case "StopAnimatorAnim": {
      const a = sprite.findBehaviorByKind("SmartTween") as { stop?: (n: string) => void } | undefined;
      const name = String(cfg.name ?? "");
      if (a && name) a.stop?.(name);
      break;
    }
    case "StopAllAnimatorAnims": {
      const a = sprite.findBehaviorByKind("SmartTween") as { stopAll?: () => void } | undefined;
      a?.stopAll?.();
      break;
    }
    case "InteractWithNPC": {
      // Bridge from author-side interaction detection (tracer hit, key
      // press near NPC, etc.) to the Dialog Flow runner. Looks up the
      // target sprite by uid and forwards to runner.handleInteract —
      // fires OnInteract triggers whose speakerBpId matches the target.
      // No-op if uid is 0 / unresolved / scene has no Dialog Flow runner.
      const uid = numOr(cfg.uid, 0, sprite);
      if (!uid) break;
      const list = sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined;
      const target = list?.find((s) => s.uid === uid && !s.destroyed);
      if (!target) break;
      const runner = sprite.scene.data.get("peaky.dialogFlow") as
        | { handleInteract?: (s: Sprite) => void } | undefined;
      runner?.handleInteract?.(target);
      break;
    }
    // ── Camera ─────────────────────────────────────────────────────────
    // Most camera actions need to find the scene's Camera behavior, which
    // typically lives on a different sprite (e.g. the player BP) than the
    // one firing the action. Walk the scene's sprite list and grab the
    // first Camera behavior found.
    case "CameraSetTarget": {
      const cam = findCameraBehavior(sprite);
      if (!cam) break;
      // Subject-aware: when the action is bound to a specific BP/widget
      // subject, the runAction redirect already swapped `sprite` to the
      // picked instance — follow THAT specific sprite instead of doing a
      // tag lookup. Construct's "Set position to <Player>" pattern.
      const subjectKind = a.subject?.kind;
      if (subjectKind === "bp" || subjectKind === "uiwidget") {
        cam.setTargetSprite(sprite);
      } else {
        cam.setTargetByTag(strOr(cfg.tag, "", sprite));
      }
      break;
    }
    case "CameraSetTargetSelf": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.setTargetSelf();
      break;
    }
    case "CameraStopFollow": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.stopFollow();
      else sprite.scene.cameras.main.stopFollow();
      break;
    }
    case "CameraShake": {
      const dur = numOr(cfg.duration, 0.3, sprite);
      const intensity = numOr(cfg.intensity, 5, sprite);
      const force = cfg.forceRestart === true;
      const cam = findCameraBehavior(sprite);
      if (cam) cam.shake(dur, intensity, force);
      else sprite.scene.cameras.main.shake(Math.max(0, dur * 1000), Math.max(0, Math.min(0.05, intensity / 200)), force);
      break;
    }
    case "CameraStopShake": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.stopShake();
      else sprite.scene.cameras.main.shake(0, 0);
      break;
    }
    case "CameraSetSmoothing": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.smoothing = Math.max(0, Math.min(1, numOr(cfg.value, 0.1, sprite)));
      break;
    }
    case "CameraSetOffset": {
      const cam = findCameraBehavior(sprite);
      if (cam) {
        // Camera now stores X offset per-direction (offsetLeftX / offsetRightX).
        // CameraSetOffset sets both to the same value for a static offset.
        // For directional look-ahead, set them in the BP inspector or add
        // a future per-direction setter action.
        const x = numOr(cfg.x, 0, sprite);
        cam.offsetLeftX  = x;
        cam.offsetRightX = x;
        cam.offsetY = numOr(cfg.y, 0, sprite);
      }
      break;
    }
    case "CameraSetZoom": {
      const z = Math.max(0.01, numOr(cfg.zoom, 1, sprite));
      const cam = findCameraBehavior(sprite);
      if (cam) cam.zoom = z;
      else sprite.scene.cameras.main.setZoom(z);
      break;
    }
    case "CameraSetFollowAxes": {
      const cam = findCameraBehavior(sprite);
      if (cam) {
        cam.followX = numOr(cfg.followX, 1, sprite) !== 0 ? 1 : 0;
        cam.followY = numOr(cfg.followY, 1, sprite) !== 0 ? 1 : 0;
      }
      break;
    }
    case "CameraFlash": {
      const dur = numOr(cfg.duration, 0.25, sprite);
      const color = Number(cfg.color ?? 0xffffff);
      const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
      const force = cfg.forceRestart === true;
      const cam = findCameraBehavior(sprite);
      if (cam) cam.flash(dur, r, g, b, force);
      else sprite.scene.cameras.main.flash(dur * 1000, r, g, b, force);
      break;
    }
    case "CameraFade": {
      const dur = numOr(cfg.duration, 0.5, sprite);
      const color = Number(cfg.color ?? 0x000000);
      const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
      const fadeOut = numOr(cfg.fadeOut, 1, sprite) !== 0;
      const cam = findCameraBehavior(sprite);
      if (cam) cam.fade(dur, r, g, b, fadeOut);
      else if (fadeOut) sprite.scene.cameras.main.fade(dur * 1000, r, g, b);
      else              sprite.scene.cameras.main.fadeFrom(dur * 1000, r, g, b);
      break;
    }
    case "CameraLock": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.lock();
      else sprite.scene.cameras.main.stopFollow();
      break;
    }
    case "CameraUnlock": {
      const cam = findCameraBehavior(sprite);
      if (cam) cam.unlock();
      break;
    }
    case "CameraPanTo": {
      const x = numOr(cfg.x, 0, sprite);
      const y = numOr(cfg.y, 0, sprite);
      const dur = numOr(cfg.duration, 1, sprite);
      const ease = strOr(cfg.ease, "Sine.easeInOut", sprite);
      const cam = findCameraBehavior(sprite);
      if (cam) cam.panTo(x, y, dur, ease);
      else sprite.scene.cameras.main.pan(x, y, dur * 1000, ease);
      break;
    }
    case "CameraPanToTag": {
      const tag = strOr(cfg.tag, "", sprite);
      const dur = numOr(cfg.duration, 1, sprite);
      const ease = strOr(cfg.ease, "Sine.easeInOut", sprite);
      const cam = findCameraBehavior(sprite);
      if (cam) cam.panToTag(tag, dur, ease);
      else if (tag) {
        // Fallback: do the lookup ourselves and pan via Phaser directly.
        const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        const target = all.find((s) => s.tags.has(tag));
        if (target) sprite.scene.cameras.main.pan(target.gameObject.x, target.gameObject.y, dur * 1000, ease);
      }
      break;
    }
    case "EmitSignalTo": {
      // Cross-object communication: emit `signal` on every sprite matching
      // ANY of `tags` OR uid, EXCLUDING the sender. Receivers react via
      // their own `OnSignal` events. `cfg.tags` is the array form; `cfg.tag`
      // is the legacy string form (single tag). Comma in the legacy string
      // splits into multiple tags so authors can type "enemy, boss" without
      // upgrading the schema. Empty entries are dropped so trailing commas
      // / extra spaces don't false-match the empty tag.
      const tags = parseTagList(cfg);
      const uidRaw = cfg.uid;
      // uid 0 / "0" mean "no uid target" so the tag is used instead. The uid
      // counter starts at 1, so 0 never matches a real sprite — without this,
      // a uid field coerced to 0 silently hijacks delivery away from the tag
      // (the "EmitSignalTo with a tag set but nothing receives it" bug).
      const uidEmpty = uidRaw === undefined || uidRaw === null || uidRaw === 0
        || (typeof uidRaw === "string" && (uidRaw.trim() === "" || uidRaw.trim() === "0"));
      const uid = uidEmpty ? null : numOr(uidRaw, NaN, sprite);
      const signal = String(cfg.signal ?? "").trim();
      // Diagnostics: the two silent-no-op cases each get their own
      // once-logged warning so "nothing happened" is never a mystery.
      if (!signal) {
        const key = `nosig:${String(cfg.tag ?? "")}`;
        if (!_emitSignalToWarned.has(key)) {
          _emitSignalToWarned.add(key);
          Logger.log({ level: "warn", source: "EmitSignalTo",
            message: `EmitSignalTo has no Signal name — set the "signal" field (the message OnSignal listens for). The tag only chooses WHO receives it, not the message.` });
        }
        break;
      }
      if (tags.length === 0 && uid === null) {
        const key = `notarget:${signal}`;
        if (!_emitSignalToWarned.has(key)) {
          _emitSignalToWarned.add(key);
          Logger.log({ level: "warn", source: "EmitSignalTo",
            message: `EmitSignalTo "${signal}" has no target — set a Tag (or UID) for who should receive it.` });
        }
        break;
      }
      // Snapshot before iterating — emitting may synchronously trigger an
      // action that destroys a sprite or spawns a new one, mutating the
      // live `peaky.sprites` array. Iterating the live array would skip or
      // double-count entries.
      // Source list: when an explicit uid is set, use spritesByUid for
      // O(1). When tags are set, union the per-tag sets (small). Only fall
      // back to the full sprite list when no targeting is configured
      // (which we already early-returned above).
      let source: Iterable<Sprite>;
      if (uid !== null && !Number.isNaN(uid)) {
        const byUid = sprite.scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined;
        const found = byUid?.get(uid);
        source = found ? [found] : [];
      } else if (tags.length === 1) {
        source = getSpritesByTag(sprite.scene, tags[0]);
      } else if (tags.length > 1) {
        const union = new Set<Sprite>();
        for (const t of tags) for (const s of getSpritesByTag(sprite.scene, t)) union.add(s);
        source = union;
      } else {
        source = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      }
      const snapshot = [...source];
      let delivered = 0;
      for (const s of snapshot) {
        if (s === sprite || s.destroyed) continue;
        // Filter still applied — the candidate set was filtered above,
        // but if a uid lookup hit a stale entry we skip it here too.
        if (uid !== null && !Number.isNaN(uid)) {
          if (s.uid !== uid) continue;
        }
        // If the recipient already ticked THIS frame (its prevTickMatched
        // bookkeeping was already finalized), the signal lands in `fired`
        // but the recipient won't see it until next frame. Phaser's
        // EventBus carryover keeps it visible via `firedPrev` — and the
        // recipient's `OnSignal` already uses `firedExactlyThisFrame`
        // when `prevTickMatched` is true to avoid double-firing. So
        // emit unconditionally; dedup is on the recipient side.
        s.events.emit(signal);
        delivered++;
      }
      // Reached nobody — the #1 cause of "my OnSignal never fires". List the
      // tags actually present in the scene so a case/spelling mismatch
      // ("SHOP" vs "shop") is obvious at a glance.
      if (delivered === 0) {
        const key = `nomatch:${signal}:${tags.join(",")}:${uid ?? ""}`;
        if (!_emitSignalToWarned.has(key)) {
          _emitSignalToWarned.add(key);
          // Pull every tag actually live in the scene from the per-tag
          // index — cheaper than re-scanning every sprite, and gives the
          // author a correct full picture even though the candidate
          // `snapshot` above was already tag-filtered.
          const byTag = sprite.scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
          const present = byTag ? Array.from(byTag.keys()).filter((k) => (byTag.get(k)?.size ?? 0) > 0) : [];
          Logger.log({ level: "warn", source: "EmitSignalTo",
            message: `EmitSignalTo "${signal}" reached 0 sprites (target ${uid !== null ? `uid ${uid}` : `tag(s) [${tags.join(", ")}]`}). Tags are CASE-SENSITIVE. Tags currently in the scene: [${present.sort().join(", ") || "none"}].` });
        }
      }
      break;
    }
    case "SetVarOn": {
      // Cross-object data push. Same tag-list / uid resolution as
      // EmitSignalTo above. Coerces the incoming value to match the
      // target var's CURRENT type (number / string / boolean), so a
      // single value field works regardless of var kind. Excludes the
      // sender. uid runs through numOr so `picked.uid` works as input.
      const tags = parseTagList(cfg);
      const uidRaw = cfg.uid;
      // uid 0 / "0" mean "no uid target" so the tag is used instead. The uid
      // counter starts at 1, so 0 never matches a real sprite — without this,
      // a uid field coerced to 0 silently hijacks delivery away from the tag
      // (the "EmitSignalTo with a tag set but nothing receives it" bug).
      const uidEmpty = uidRaw === undefined || uidRaw === null || uidRaw === 0
        || (typeof uidRaw === "string" && (uidRaw.trim() === "" || uidRaw.trim() === "0"));
      const uid = uidEmpty ? null : numOr(uidRaw, NaN, sprite);
      const name = String(cfg.name ?? "").trim();
      if (!name || (tags.length === 0 && uid === null)) break;
      // Same source-list logic as EmitSignalTo — index lookups skip the
      // full-sprite scan when uid or tags are specified.
      let source: Iterable<Sprite>;
      if (uid !== null && !Number.isNaN(uid)) {
        const byUid = sprite.scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined;
        const found = byUid?.get(uid);
        source = found ? [found] : [];
      } else if (tags.length === 1) {
        source = getSpritesByTag(sprite.scene, tags[0]);
      } else if (tags.length > 1) {
        const union = new Set<Sprite>();
        for (const t of tags) for (const s of getSpritesByTag(sprite.scene, t)) union.add(s);
        source = union;
      } else {
        source = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      }
      const snapshot = [...source];
      for (const s of snapshot) {
        if (s === sprite || s.destroyed) continue;
        if (uid !== null && !Number.isNaN(uid)) {
          if (s.uid !== uid) continue;
        }
        const current = s.vars.get(name);
        const raw = cfg.value;
        let value: number | string | boolean;
        if (typeof current === "number") {
          value = numOr(raw, 0, sprite);
        } else if (typeof current === "boolean") {
          value = raw === true || raw === 1 || raw === "true" || raw === "1";
        } else {
          value = strOr(raw, "", sprite);
        }
        s.writeVar(name, value);
      }
      break;
    }
    case "SetGlobal": {
      // Write a persistent global (survives scene transitions + save/load).
      // Read anywhere via the `global:<name>` expression. Keeps the existing
      // type if one is set (number stays number) so `global:coins + 1` works.
      const name = strOr(cfg.global, "", sprite).trim();
      if (!name) break;
      const g = persistentState().globals;
      const raw = cfg.value;
      const existing = g[name];
      if (typeof existing === "boolean") {
        // Boolean global: accept true/false, 1/0, "true"/"false".
        if (typeof raw === "boolean") g[name] = raw;
        else { const s = strOr(raw, "", sprite).trim().toLowerCase(); g[name] = s === "true" || s === "1"; }
      } else if (typeof existing === "string") {
        g[name] = strOr(raw, "", sprite);
      } else {
        // Default to numeric (the common case: money/day/counts).
        const asNum = numOr(raw, NaN, sprite);
        g[name] = Number.isNaN(asNum) ? strOr(raw, "", sprite) : asNum;
      }
      break;
    }
    case "AddGlobal":
    case "SubGlobal": {
      // Increment / decrement a numeric persistent global. Mirrors the
      // SetGlobal type-coercion logic but adds (or subtracts) the delta
      // onto the existing value. Missing global → start from 0. String /
      // boolean globals are no-ops (typed mismatch — same policy AddVar
      // uses for non-numeric BP vars).
      const name = strOr(cfg.global, "", sprite).trim();
      if (!name) break;
      const g = persistentState().globals;
      const existing = g[name];
      if (existing !== undefined && typeof existing !== "number") break;
      const cur = typeof existing === "number" && Number.isFinite(existing) ? existing : 0;
      const delta = numOr(cfg.delta, 0, sprite);
      g[name] = a.kind === "AddGlobal" ? cur + delta : cur - delta;
      break;
    }
    case "GlobalArrayOp": {
      // Mutate a global ARRAY. Coerces the target to an array if it isn't one
      // yet (so a fresh push just works). Value is stored as a number when it
      // parses numerically, else as a string (booleans kept as-is).
      const name = strOr(cfg.global, "", sprite).trim();
      if (!name) break;
      const g = persistentState().globals;
      let arr = g[name];
      if (!Array.isArray(arr)) { arr = []; g[name] = arr; }
      const op = String(cfg.op ?? "push");
      const coerce = (raw: unknown): number | string | boolean => {
        if (typeof raw === "boolean") return raw;
        const n = numOr(raw, NaN, sprite);
        return Number.isNaN(n) ? strOr(raw, "", sprite) : n;
      };
      if (op === "clear") {
        arr.length = 0;
      } else if (op === "push") {
        arr.push(coerce(cfg.value));
      } else if (op === "set") {
        const i = Math.floor(numOr(cfg.index, 0, sprite));
        if (i >= 0 && i < arr.length) arr[i] = coerce(cfg.value);
        else if (i === arr.length) arr.push(coerce(cfg.value));
      } else if (op === "removeAt") {
        const i = Math.floor(numOr(cfg.index, 0, sprite));
        if (i >= 0 && i < arr.length) arr.splice(i, 1);
      }
      break;
    }
    case "RestockShop": {
      // Clear this shop's per-slot stock keys so the grid re-seeds them to the
      // configured amounts on its next refresh. Blank shop = restock all.
      const shop = strOr(cfg.shop, "", sprite).trim();
      const store = persistentState().shopStock;
      if (!shop) {
        for (const k of Object.keys(store)) delete store[k];
      } else {
        const prefix = `${shop}#`;
        for (const k of Object.keys(store)) if (k.startsWith(prefix)) delete store[k];
      }
      break;
    }
    case "ResetWorld":
      resetPersistentState();
      break;
    case "GiveItem":
    case "TakeItem": {
      // Unified item add/remove. If the sprite has an Inventory behavior, route
      // through it (fills the slot-grid widget) — the behavior mirrors the new
      // count into the item's count global. With no Inventory, bump the count
      // global directly (the no-bag, counts-only model). Either way the item's
      // `global:<countGlobal>` ends up correct and persists across scenes.
      const itemName = strOr(cfg.item, "", sprite).trim();
      if (!itemName) break;
      const meta = sprite.scene.data.get("peaky.itemMeta") as Record<string, { countGlobal?: string; maxStack?: number }> | undefined;
      const qty = Math.max(0, Math.floor(numOr(cfg.qty, 1, sprite)));
      const inv = sprite.findBehaviorByKind("Inventory") as
        | { addItem: (n: string, q: number, m: number) => number; removeItem: (n: string, q: number) => number } | undefined;
      if (inv) {
        const maxStack = Math.max(1, meta?.[itemName]?.maxStack ?? 99);
        if (a.kind === "GiveItem") inv.addItem(itemName, qty, maxStack);
        else inv.removeItem(itemName, qty);
        break;
      }
      const key = (meta?.[itemName]?.countGlobal || itemName).replace(/[^A-Za-z0-9_]/g, "");
      if (!key) break;
      const store = persistentState().globals;
      const cur = typeof store[key] === "number" ? (store[key] as number) : Number(store[key]) || 0;
      store[key] = a.kind === "GiveItem" ? cur + qty : Math.max(0, cur - qty);
      break;
    }
    case "BuyItem":
    case "SellItem": {
      // Shop transaction: BuyItem charges the money global + gives the item;
      // SellItem takes the item + pays the sell price. Uses the sprite's
      // Inventory if it has one (live grid), else the item's count global.
      const itemName = strOr(cfg.item, "", sprite).trim();
      if (!itemName) break;
      const meta = (sprite.scene.data.get("peaky.itemMeta") as Record<string, { buyPrice?: number; sellPrice?: number; countGlobal?: string; maxStack?: number }> | undefined)?.[itemName];
      if (!meta) break;
      const qty = Math.max(1, Math.floor(numOr(cfg.qty, 1, sprite)));
      const curKey = (strOr(cfg.currency, "gold", sprite).trim() || "gold").replace(/[^A-Za-z0-9_]/g, "");
      const itemKey = (meta.countGlobal || itemName).replace(/[^A-Za-z0-9_]/g, "");
      const store = persistentState().globals;
      const gold = Math.max(0, Number(store[curKey]) || 0);
      const inv = sprite.findBehaviorByKind("Inventory") as
        | { addItem: (n: string, q: number, m: number) => number; removeItem: (n: string, q: number) => number; countItem: (n: string) => number } | undefined;
      const have = inv ? inv.countItem(itemName) : Math.max(0, Number(store[itemKey]) || 0);
      if (a.kind === "BuyItem") {
        const total = (meta.buyPrice ?? 0) * qty;
        if ((meta.buyPrice ?? 0) <= 0 || gold < total) break;
        store[curKey] = gold - total;
        if (inv) inv.addItem(itemName, qty, Math.max(1, meta.maxStack ?? 99));
        else store[itemKey] = (Number(store[itemKey]) || 0) + qty;
      } else {
        const total = (meta.sellPrice ?? 0) * qty;
        if ((meta.sellPrice ?? 0) <= 0 || have < qty) break;
        if (inv) inv.removeItem(itemName, qty);
        else store[itemKey] = Math.max(0, (Number(store[itemKey]) || 0) - qty);
        store[curKey] = gold + total;
      }
      break;
    }
    case "SetPosition": {
      const x = numOr(cfg.x, sprite.gameObject.x, sprite);
      const y = numOr(cfg.y, sprite.gameObject.y, sprite);
      const dx = x - sprite.gameObject.x;
      const dy = y - sprite.gameObject.y;
      // body.reset both updates the gameObject AND syncs the arcade body
      // so collisions register at the new spot — plain setPosition would
      // leave the physics body lagging until the next preUpdate. No-body
      // (decoration) BPs fall back to moving the gameObject directly.
      if (sprite.body) sprite.body.reset(x, y);
      else sprite.gameObject.setPosition(x, y);
      // Multi-mode UI widget parent: translate every child by the same
      // delta so the whole widget moves as one. Without this, the parent
      // (invisible) moves but the visible children stay put.
      translateMultiUIChildren(sprite, dx, dy);
      break;
    }
    case "SetPositionX": {
      const x = numOr(cfg.x, sprite.gameObject.x, sprite);
      const dx = x - sprite.gameObject.x;
      if (sprite.body) sprite.body.reset(x, sprite.gameObject.y);
      else sprite.gameObject.setPosition(x, sprite.gameObject.y);
      translateMultiUIChildren(sprite, dx, 0);
      break;
    }
    case "SetPositionY": {
      const y = numOr(cfg.y, sprite.gameObject.y, sprite);
      const dy = y - sprite.gameObject.y;
      if (sprite.body) sprite.body.reset(sprite.gameObject.x, y);
      else sprite.gameObject.setPosition(sprite.gameObject.x, y);
      translateMultiUIChildren(sprite, 0, dy);
      break;
    }
    case "Tween": {
      // Maps the user-friendly property name to the actual Phaser-tweenable
      // gameObject property. position.x/y → x/y on the rectangle gameObject;
      // angle → degrees rotation; scale → uniform scale factor.
      const propMap: Record<string, string> = {
        "position.x": "x",
        "position.y": "y",
        "scale":      "scale",
        "scaleX":     "scaleX",
        "scaleY":     "scaleY",
        "alpha":      "alpha",
        "angle":      "angle",
      };
      const uiProp = String(cfg.property ?? "position.x");
      const phaserProp = propMap[uiProp];
      if (!phaserProp) break;
      // Alpha is special — `sprite.gameObject` is the invisible host rect
      // (Sprite constructor forces alpha=0). Tweening its alpha would do
      // nothing visible because the actual visual is the SpriteRenderer
      // image overlay (or the Text overlay, for text-bearing BPs). Route
      // alpha tweens to whichever overlay is present so a fade-in / -out
      // actually shows. Build a list of targets so multiple visual
      // overlays (SR + Text) fade together.
      const tweenTargets: Phaser.GameObjects.GameObject[] = [];
      // For BP-flavored targets (self / bp / bpTag) we need a list of
      // Peaky Sprites so the alpha-overlay routing below can pick the
      // right child gameObject (SpriteRenderer / Text overlay) per BP.
      const bpTargetSprites: Sprite[] = [];
      const targetKind = String(cfg.targetKind ?? "self").trim();
      if (targetKind === "spriteObject") {
        // Sprite Object placement — tween every placement of the chosen
        // sprite asset, OR the active placement when set (OnSpriteObjectCreate
        // chain). Same active-placement context the Set actions use.
        const activeGo = sprite.scene.data.get("peaky.activePlacement") as Phaser.GameObjects.Sprite | null | undefined;
        if (activeGo) {
          tweenTargets.push(activeGo);
        } else {
          const spriteId = String(cfg.spriteId ?? "").trim();
          if (spriteId) {
            const idx = sprite.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
            const list = idx?.get(spriteId);
            if (list && list.length > 0) {
              for (const g of list) tweenTargets.push(g);
            }
          }
        }
        // No matching placements → nothing to tween.
        if (tweenTargets.length === 0) break;
      } else if (targetKind === "bp") {
        // BP instance(s) — match by blueprintName. Live snapshot so a
        // BP spawned mid-frame is also tweenable.
        const bpName = String(cfg.bp ?? "").trim();
        if (!bpName) break;
        const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        for (const s of all) if (!s.destroyed && s.blueprintName === bpName) bpTargetSprites.push(s);
        if (bpTargetSprites.length === 0) break;
      } else if (targetKind === "bpTag") {
        // BP tag filter — every Peaky sprite carrying the configured tag.
        const wantTag = String(cfg.targetTag ?? "").trim();
        if (!wantTag) break;
        const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        for (const s of all) if (!s.destroyed && s.tags.has(wantTag)) bpTargetSprites.push(s);
        if (bpTargetSprites.length === 0) break;
      } else if (bpTargetSprites.length > 0) {
        // BP-flavored target list — resolve overlays per BP for alpha,
        // else use the gameObject directly. Multiple BPs tween in parallel
        // off a single Phaser tween instance.
        for (const s of bpTargetSprites) {
          if (phaserProp === "alpha") {
            const sr = s.findBehaviorByKind("SpriteRenderer");
            const srOverlay = (sr as unknown as { overlay?: Phaser.GameObjects.Image })?.overlay;
            if (srOverlay) tweenTargets.push(srOverlay);
            const text = s.findBehaviorByKind("Text");
            const textOverlay = (text as unknown as { overlay?: Phaser.GameObjects.Text })?.overlay;
            if (textOverlay) tweenTargets.push(textOverlay);
            if (!srOverlay && !textOverlay) tweenTargets.push(s.gameObject);
          } else {
            tweenTargets.push(s.gameObject);
          }
        }
      } else if (phaserProp === "alpha") {
        const sr = sprite.findBehaviorByKind("SpriteRenderer");
        const srOverlay = (sr as unknown as { overlay?: Phaser.GameObjects.Image })?.overlay;
        if (srOverlay) tweenTargets.push(srOverlay);
        const text = sprite.findBehaviorByKind("Text");
        const textOverlay = (text as unknown as { overlay?: Phaser.GameObjects.Text })?.overlay;
        if (textOverlay) tweenTargets.push(textOverlay);
        // Fall back to the gameObject for sprites with no overlay (pure
        // physics body or rect-fill). Their host IS the visual.
        if (tweenTargets.length === 0) tweenTargets.push(sprite.gameObject);
      } else {
        tweenTargets.push(sprite.gameObject);
      }
      const tag = String(cfg.tag ?? "");
      const to = numOr(cfg.to, 0, sprite);
      const duration = Math.max(0.001, numOr(cfg.duration, 0.5, sprite)) * 1000;
      const ease = String(cfg.ease ?? "Linear");
      const repeat = Math.max(-1, Math.floor(numOr(cfg.repeat, 0, sprite)));
      const yoyo = numOr(cfg.yoyo, 0, sprite) !== 0;

      // Composite key: same (tag, prop) pair restarts; different prop on
      // the same tag coexists. Re-running Tween(position.x, tag="") will
      // restart the old position.x tween, but a separate Tween(alpha, tag="")
      // will run alongside it instead of overwriting.
      //
      // Property-level dedup: ANY existing tween targeting the SAME
      // property is stopped, regardless of tag. Two tweens on the same
      // property of the same sprite would fight every tick (Phaser tween
      // updates would clobber each other), making the visible motion
      // look erratic / infinite-looping. Different properties (position.y
      // vs alpha) are independent and stay running.
      let tweenKey = `${tag}|${phaserProp}`;
      // Property-level dedup ONLY makes sense when the tweens fight over
      // the SAME target (self). For spriteObject / bp / bpTag, each call
      // tweens a different placement / instance — running them in parallel
      // is the whole point. Cancelling one when another starts (the prior
      // behavior) silently killed every prior tween on the same tag+prop,
      // so only the LAST sprite's tween survived. Skip dedup for those.
      if (targetKind === "self" || targetKind === "") {
        const stoppedKeys: string[] = [];
        for (const [k, entry] of sprite.tweens) {
          if (entry.prop === phaserProp) {
            entry.tween.stop();
            stoppedKeys.push(k);
          }
        }
        for (const k of stoppedKeys) sprite.tweens.delete(k);
      } else {
        // Multi-target: each call is a distinct parallel tween. Sharing the
        // `${tag}|${prop}` map slot made the FIRST tween untrackable (a second
        // call overwrote its entry → TweenStop/Pause couldn't reach it) AND
        // either tween's onComplete deleted the OTHER's entry. Give each its
        // own key; Stop/Pause/Resume iterate by entry.tag/.prop, so they still
        // match every tween regardless of key.
        tweenKey = `${tag}|${phaserProp}|#${++_tweenSeq}`;
      }

      const tween = sprite.scene.tweens.add({
        targets: tweenTargets,
        [phaserProp]: to,
        duration,
        ease,
        repeat,
        yoyo,
        onStart: () => {
          // Tag-suffixed event name so OnTweenStart/Finish guards can match
          // by tag. Empty tag is fine — listeners can match "".
          sprite.events.emit(`_tweenStart:${tag}`);
        },
        onComplete: () => {
          sprite.events.emit(`_tweenFinish:${tag}`);
          sprite.tweens.delete(tweenKey);
        },
      });
      sprite.tweens.set(tweenKey, { tween, prop: phaserProp, tag });
      break;
    }
    case "TweenSetEndValue": {
      const tag = String(cfg.tag ?? "");
      const to = numOr(cfg.to, 0, sprite);
      // Apply the new endpoint to EVERY tween at this tag, each on its
      // own property. Multiple props (position.x + alpha) at same tag
      // would all chase the new value — usually only meaningful when
      // there's a single tween at the tag, but harmless when not.
      for (const [, entry] of sprite.tweens) {
        if (entry.tag === tag) entry.tween.updateTo(entry.prop, to, true);
      }
      break;
    }
    case "TweenStop": {
      const tag = String(cfg.tag ?? "");
      // Stop ALL tweens at this tag (across all properties) and clear
      // their entries from the map.
      const toDelete: string[] = [];
      for (const [k, entry] of sprite.tweens) {
        if (entry.tag === tag) {
          entry.tween.stop();
          toDelete.push(k);
        }
      }
      for (const k of toDelete) sprite.tweens.delete(k);
      break;
    }
    case "TweenStopAll": {
      for (const [, entry] of sprite.tweens) entry.tween.stop();
      sprite.tweens.clear();
      break;
    }
    case "TweenPause": {
      const tag = String(cfg.tag ?? "");
      for (const [, entry] of sprite.tweens) {
        if (entry.tag === tag) entry.tween.pause();
      }
      break;
    }
    case "TweenPauseAll": {
      for (const [, entry] of sprite.tweens) entry.tween.pause();
      break;
    }
    case "TweenResume": {
      const tag = String(cfg.tag ?? "");
      for (const [, entry] of sprite.tweens) {
        if (entry.tag === tag) entry.tween.resume();
      }
      break;
    }
    case "TweenResumeAll": {
      for (const [, entry] of sprite.tweens) entry.tween.resume();
      break;
    }
    case "TracerSet": {
      // Discoverable read-then-write for any writable Tracer field. Picks the
      // tracer by name (blank = first attached), validates the param key
      // against BEHAVIOR_WRITABLE_PARAMS.Tracer, then assigns. Mirrors CMSet.
      const tracerName = String(cfg.componentName ?? cfg.tracer ?? "");
      const param = String(cfg.param ?? "");
      if (!param) break;
      if (!isWritableBehaviorParam("Tracer", param)) {
        Logger.log({ level: "warn", source: sourceLabel ?? "TracerSet", message: `param "${param}" is not on Tracer's writable list — ignored.` });
        break;
      }
      const tracer = findTracer(sprite, tracerName);
      if (!tracer) break;
      // Resolve the value the same way SetBehaviorParam does — number first,
      // falling back to string so `param: "triggerMode"` accepts "signal"/"interval".
      const raw = cfg.value;
      const n = typeof raw === "string" ? numOr(raw, NaN, sprite) : Number(raw);
      if (Number.isFinite(n)) {
        (tracer as unknown as Record<string, unknown>)[param] = n;
      } else {
        (tracer as unknown as Record<string, unknown>)[param] = strOr(raw, "", sprite);
      }
      break;
    }
    case "TracerGetResult": {
      // Discoverable read-then-write: pick a tracer, pick a field, pick a
      // variable. Equivalent to SetVar value=tracer:<name>.<field> but with
      // dropdowns instead of typed expressions.
      const tracerName = String(cfg.tracer ?? "");
      const field = String(cfg.field ?? "hitX");
      const varName = String(cfg.varName ?? "");
      if (!varName) break;
      const value = resolveTracerExpr(sprite, `${tracerName}.${field}`);
      sprite.vars.set(varName, value);
      break;
    }
    case "PlayDialogue": {
      // The runner is a per-scene singleton stored on scene.data — installed
      // by runProject when the game starts. We look it up dynamically rather
      // than importing it because the runtime package can't reach into the
      // editor's project shape; the runner is fed everything it needs at
      // construction time.
      const runner = sprite.scene.data.get("peaky.dialogue") as
        | { play: (id: string, overrides?: Record<string, unknown>) => void }
        | undefined;
      if (!runner) break;
      const dialogueId = String(cfg.dialogueId ?? "");
      if (!dialogueId) break;
      runner.play(dialogueId, cfg);
      break;
    }
    case "StopDialogue": {
      const runner = sprite.scene.data.get("peaky.dialogue") as
        | { stop: () => void }
        | undefined;
      runner?.stop();
      break;
    }
    case "PlayMusic": {
      const sm = getSoundManager(sprite.scene);
      const name = strOr(cfg.sound, "", sprite);
      if (!sm || !name) break;
      sm.playMusic(name, {
        volume: cfg.volume !== undefined ? numOr(cfg.volume, 1, sprite) : undefined,
        loop: cfg.loop !== undefined ? cfg.loop !== false && cfg.loop !== 0 : undefined,
        fadeSec: numOr(cfg.fadeSec, 0, sprite),
      });
      break;
    }
    case "StopMusic": {
      getSoundManager(sprite.scene)?.stopMusic(numOr(cfg.fadeSec, 0, sprite));
      break;
    }
    case "PlaySound": {
      const sm = getSoundManager(sprite.scene);
      const name = strOr(cfg.sound, "", sprite);
      if (!sm || !name) break;
      sm.playSfx(name, {
        volume: cfg.volume !== undefined ? numOr(cfg.volume, 1, sprite) : undefined,
        loop: cfg.loop !== undefined ? cfg.loop !== false && cfg.loop !== 0 : undefined,
      });
      break;
    }
    case "PlaySounds": {
      const sm = getSoundManager(sprite.scene);
      if (!sm) break;
      const raw = Array.isArray(cfg.sounds) ? (cfg.sounds as unknown[]) : [];
      const names = raw.map((s) => strOr(s, "", sprite)).filter(Boolean);
      if (names.length === 0) break;
      const m = String(cfg.playMode ?? "random");
      const playMode = m === "all" || m === "queue" ? m : "random";
      sm.playMulti(names, {
        playMode,
        playInSequence: !!cfg.playInSequence,
        gapSec: numOr(cfg.gapSec, 0, sprite),
        volumeMin: numOr(cfg.volumeMin, 1, sprite),
        volumeMax: numOr(cfg.volumeMax, 1, sprite),
        pitchMin: numOr(cfg.pitchMin, 1, sprite),
        pitchMax: numOr(cfg.pitchMax, 1, sprite),
        cursorKey: a.id,
      });
      break;
    }
    case "StopSound": {
      const name = strOr(cfg.sound, "", sprite);
      getSoundManager(sprite.scene)?.stopSfx(name || undefined);
      break;
    }
    case "StopAllSounds": {
      getSoundManager(sprite.scene)?.stopAll();
      break;
    }
    case "SetMusicVolume": {
      getSoundManager(sprite.scene)?.setMusicVolume(numOr(cfg.volume, 1, sprite));
      break;
    }
    case "SetSfxVolume": {
      getSoundManager(sprite.scene)?.setSfxVolume(numOr(cfg.volume, 1, sprite));
      break;
    }
    case "SetMasterVolume": {
      getSoundManager(sprite.scene)?.setMasterVolume(numOr(cfg.volume, 1, sprite));
      break;
    }
    case "PlaySquashStretch": {
      // Requires a SquashStretch behavior attached to the sprite — that's
      // where the tween chain lives. Without it, log once and bail; we
      // could synthesize an ad-hoc tween here, but forcing the user to
      // attach the behavior keeps the data flow obvious (intensity /
      // duration defaults live on the behavior, the action overrides
      // them per-call).
      const ss = sprite.findBehaviorByKind("SquashStretch");
      if (!ss) {
        Logger.log({
          level: "warn",
          source: "PlaySquashStretch",
          message: "Sprite has no SquashStretch behavior — attach one in the Components panel before triggering this action.",
        });
        break;
      }
      const kindRaw = String(cfg.kind ?? "both");
      const kind: "both" | "squash" | "stretch" =
        kindRaw === "squash" ? "squash" : kindRaw === "stretch" ? "stretch" : "both";
      const opts: Parameters<typeof ss.play>[0] = { kind };
      // Coerce intensity / duration through numOr — covers cfg values
      // that landed as strings (older saves, hand-edited JSON, etc.).
      // NaN sentinel keeps "missing → use behavior default" semantics.
      const intensityN = numOr(cfg.intensity, NaN, sprite);
      if (Number.isFinite(intensityN)) opts.intensity = intensityN;
      const durationN = numOr(cfg.duration, NaN, sprite);
      if (Number.isFinite(durationN)) opts.duration = durationN;
      if (typeof cfg.easing === "string" && cfg.easing) opts.easing = cfg.easing;
      Logger.log({
        level: "log",
        source: "PlaySquashStretch",
        message: `raw cfg=${JSON.stringify(cfg)} → kind=${opts.kind} intensity=${opts.intensity ?? "(default " + ss.intensity + ")"} duration=${opts.duration ?? "(default " + ss.duration + ")"} easing=${opts.easing ?? "(default " + ss.easing + ")"}`,
      });
      ss.play(opts);
      break;
    }
    case "SetUIText": {
      const target = strOr(cfg.target, "", sprite);
      const text = strOr(cfg.text, "", sprite);
      for (const w of resolveUIWidgets(sprite, target)) {
        w.text = text;
      }
      break;
    }
    case "SetUIValue": {
      const target = strOr(cfg.target, "", sprite);
      // Value can be a literal number OR an expression string ("var:hp",
      // "var:Player.hp / var:Player.maxHp * 100", etc.) — store as the
      // raw cfg value so the renderer's resolveValue() handles both.
      const value = typeof cfg.value === "number" ? cfg.value : String(cfg.value ?? "");
      for (const w of resolveUIWidgets(sprite, target)) {
        w.value = value;
      }
      break;
    }
    case "SetUISelectedValue": {
      const target = strOr(cfg.target, "", sprite);
      const value = strOr(cfg.value, "", sprite);
      for (const w of resolveUIWidgets(sprite, target)) {
        w.selectedValue = value;
        // Force the dropdown's header label to refresh on next update.
        // Internal field name `lastLabelText` is private; setting text
        // empty would change content. Cleaner: just set the field.
        // (UIWidgetRenderer.update() re-resolves label text every tick.)
      }
      break;
    }
    case "SetUIVisible": {
      const target = strOr(cfg.target, "", sprite);
      const mode = strOr(cfg.mode, "set", sprite);
      const setVisible = numOr(cfg.visible, 1, sprite) !== 0;
      const widgets = resolveUIWidgets(sprite, target);
      if (widgets.length === 0) {
        const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        const uiBps = all.filter((s) => s.isUIWidget).map((s) => `${s.blueprintName}${s.instanceName ? `/${s.instanceName}` : ""}`);
        console.warn(`[SetUIVisible] no widget matched "${target}". Live UI widgets in scene: [${uiBps.join(", ") || "(none)"}]`);
      }
      for (const w of widgets) {
        const visible = mode === "toggle" ? !w.sprite.gameObject.visible : setVisible;
        w.setElementVisible(visible);
      }
      break;
    }
    case "SetUIBgColor": {
      const target = strOr(cfg.target, "", sprite);
      const color = numOr(cfg.color, 0xffffff, sprite);
      for (const w of resolveUIWidgets(sprite, target)) {
        w.bgColor = color;
      }
      break;
    }
    case "SetUIElement": {
      // Dynamic per-kind node: apply every prop whose `set_<prop>` toggle is
      // ON. The editor only emits the toggles relevant to the picked element's
      // kind, so we just walk all `set_*` keys and resolve each by its type.
      const target = strOr(cfg.target, "", sprite);
      const widgets = resolveUIWidgets(sprite, target);
      if (widgets.length > 0) {
        for (const key of Object.keys(cfg)) {
          if (!key.startsWith("set_") || !cfg[key]) continue;
          const prop = key.slice(4);
          const raw = cfg[prop];
          let val: number | string | boolean;
          if (prop === "value") val = typeof raw === "number" ? raw : String(raw ?? "");
          else if (SETUI_STRING_PROPS.has(prop)) val = strOr(raw, "", sprite);
          else if (SETUI_BOOL_PROPS.has(prop)) val = raw === false ? false : raw === true ? true : numOr(raw, 1, sprite) !== 0;
          else val = numOr(raw, 0, sprite); // numbers, colors, alpha
          for (const w of widgets) w.setLiveProp(prop, val);
        }
      }
      break;
    }
    case "CreateUIWidget": {
      // Calls the UI spawn callback registered by runProject — which
      // mirrors the BP `peaky.spawn` registry but for UI widget assets
      // looked up by NAME (not id, since the user authors by name in
      // the action's config).
      const widgetName = strOr(cfg.widgetName, "", sprite);
      if (!widgetName) break;
      const x = numOr(cfg.x, 0, sprite);
      const y = numOr(cfg.y, 0, sprite);
      const layer = strOr(cfg.layer, "", sprite);
      const spawnUI = sprite.scene.data.get("peaky.spawnUIWidget") as
        | ((arg: { name: string; x: number; y: number; layer?: string }) => void)
        | undefined;
      if (spawnUI) spawnUI({ name: widgetName, x, y, layer });
      else console.warn("[Peaky] CreateUIWidget: spawnUIWidget callback not registered on this scene");
      break;
    }
    case "DestroyUIWidget": {
      const target = strOr(cfg.target, "", sprite);
      if (!target) break;
      const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      // Two-pass destroy:
      //  1. Match name against any UI-widget sprite (parent or child).
      //     Use the `isUIWidget` flag (set in spawnFromUIWidget) to
      //     guard against collisions with gameplay BPs of the same
      //     name — checking for UIWidgetRenderer alone isn't enough
      //     since multi-mode parents host no renderer.
      //  2. Cascade: any sprite whose parentInstanceId points at a
      //     matched parent's instanceId also dies. This is what makes
      //     destroying a multi-widget by name take ALL its children
      //     out, not just the parent.
      const hits = new Set<Sprite>();
      const seedIds = new Set<string>();
      for (const s of all) {
        if (s.destroyed || !s.isUIWidget) continue;
        if (s.instanceName === target || s.blueprintName === target) {
          hits.add(s);
          if (s.instanceId) seedIds.add(s.instanceId);
        }
      }
      for (const s of all) {
        if (s.destroyed || !s.isUIWidget) continue;
        if (s.parentInstanceId && seedIds.has(s.parentInstanceId)) {
          hits.add(s);
        }
      }
      for (const s of hits) s.destroy();
      break;
    }
    case "AddItem": {
      const inv = sprite.findBehaviorByKind("Inventory");
      const item = strOr(cfg.item, "", sprite);
      if (!item) break;
      if (!inv) {
        console.warn(`[AddItem] "${sprite.blueprintName || sprite.instanceName || "sprite"}" has no Inventory component — "${item}" not added. Attach an Inventory component to this blueprint.`);
        break;
      }
      const qty = Math.max(0, Math.floor(numOr(cfg.qty, 1, sprite)));
      const meta = (sprite.scene.data.get("peaky.itemMeta") as Record<string, { maxStack: number }> | undefined)?.[item];
      if (!meta) console.warn(`[AddItem] item "${item}" not in the project's item catalog — defaulting maxStack to 99.`);
      inv.addItem(item, qty, meta?.maxStack ?? 99);
      break;
    }
    case "RemoveItem": {
      const inv = sprite.findBehaviorByKind("Inventory");
      const item = strOr(cfg.item, "", sprite);
      if (!inv || !item) break;
      inv.removeItem(item, Math.max(0, Math.floor(numOr(cfg.qty, 1, sprite))));
      break;
    }
    case "ClearInventory": {
      sprite.findBehaviorByKind("Inventory")?.clear();
      break;
    }
    case "GetItemCount": {
      const inv = sprite.findBehaviorByKind("Inventory");
      const t = resolveWriteTarget(sprite, String(cfg.var ?? ""));
      if (!inv || !t) break;
      t.sprite.vars.set(t.field, inv.countItem(strOr(cfg.item, "", sprite)));
      break;
    }
    case "GetItemProp": {
      const t = resolveWriteTarget(sprite, String(cfg.var ?? ""));
      const item = strOr(cfg.item, "", sprite);
      const key = strOr(cfg.key, "", sprite);
      if (!t || !item || !key) break;
      const props = (sprite.scene.data.get("peaky.itemMeta") as Record<string, { props?: Record<string, number | string | boolean> }> | undefined)?.[item]?.props;
      const val = props?.[key];
      if (val === undefined) break;
      const op = String(cfg.varOp ?? "set");
      if (op === "add" || op === "sub") {
        const cur = varToNum(t.sprite.vars.get(t.field), 0);
        const delta = varToNum(val, 0);
        t.sprite.vars.set(t.field, op === "add" ? cur + delta : cur - delta);
      } else {
        t.sprite.vars.set(t.field, val);
      }
      break;
    }
    case "GiveItemTo": {
      const item = strOr(cfg.item, "", sprite);
      const targetStr = strOr(cfg.target, "", sprite);
      if (!item || !targetStr) break;
      const qty = Math.max(0, Math.floor(numOr(cfg.qty, 1, sprite)));
      const maxStack = (sprite.scene.data.get("peaky.itemMeta") as Record<string, { maxStack: number }> | undefined)?.[item]?.maxStack ?? 99;
      const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      for (const s of all) {
        if (s.destroyed || s === sprite) continue;
        if (s.blueprintName === targetStr || s.instanceName === targetStr || s.tags.has(targetStr)) {
          s.findBehaviorByKind("Inventory")?.addItem(item, qty, maxStack);
        }
      }
      break;
    }
    case "QuitGame": {
      sprite.events.emit("OnGameQuit");
      try {
        if (typeof window !== "undefined") {
          window.close();
        }
      } catch { /* no-op */ }
      break;
    }
    case "SetAngle": {
      const angle = numOr(cfg.angle, 0, sprite);
      sprite.gameObject.setAngle(angle);
      break;
    }
    case "SetScale": {
      const s = numOr(cfg.scale, 1, sprite);
      sprite.gameObject.setScale(s);
      // Same-frame overlay catch-up so a spawn-frame "OnCreate → SetScale"
      // doesn't flash at the old scale for one render before the next
      // tick's syncOverlay rebuilds the visual.
      sprite.resyncOverlays();
      break;
    }
    case "SetScaleX": {
      const sx = numOr(cfg.scaleX, 1, sprite);
      sprite.gameObject.scaleX = sx;
      sprite.resyncOverlays();
      break;
    }
    case "SetScaleY": {
      const sy = numOr(cfg.scaleY, 1, sprite);
      sprite.gameObject.scaleY = sy;
      sprite.resyncOverlays();
      break;
    }
    case "SetOpacity": {
      const a = Math.max(0, Math.min(1, numOr(cfg.alpha, 1, sprite)));
      sprite.gameObject.setAlpha(a);
      break;
    }
    case "MoveToLayer": {
      // Re-bind the sprite to a different layer by name. Updates the
      // parallax (scrollFactor) and the depth band so it renders with
      // its new layer-mates. No-op if the named layer doesn't exist.
      const layerName = String(cfg.layer ?? "");
      if (!layerName) break;
      const layers = sprite.scene.data.get("peaky.layers") as
        | Record<string, { parallaxX: number; parallaxY: number; visible: boolean; baseDepth: number }>
        | undefined;
      const target = layers?.[layerName];
      if (!target) {
        console.warn(`[Peaky] MoveToLayer: layer "${layerName}" not found`);
        break;
      }
      sprite.gameObject.setScrollFactor(target.parallaxX, target.parallaxY);
      sprite.gameObject.setDepth(target.baseDepth);
      sprite.gameObject.setVisible(target.visible);
      // Re-apply the new layer to every behavior so their overlays
      // (SpriteRenderer image, Text, Tracer gfx, UIWidget bg/label/etc.)
      // jump along with the body. Without this the body re-layers
      // correctly but the visible overlay stays on the old layer's
      // depth + parallax — typical symptom is "the player moved to
      // the foreground layer but the sprite still draws behind walls".
      for (const b of sprite.getBehaviors()) {
        b.applyLayer(target.parallaxX, target.parallaxY, target.baseDepth, 1, target.visible);
      }
      // Keep layerId current (pause gating + per-layer FX both read it) and
      // re-apply whatever post-FX the new layer carries (clears the old one's).
      const idByName = sprite.scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
      const newId = idByName?.[layerName];
      if (newId !== undefined) sprite.layerId = newId;
      applyLayerFXToSprite(sprite);
      break;
    }
    case "SetZOrder": {
      // Z is RELATIVE — slots into the sprite's current layer rather
      // than overriding the absolute depth. Constants mirror runProject's
      // layer math: each layer occupies a 1,000,000-wide depth band, and
      // each integer z step is 1000 wide inside that band (gives room for
      // ~1000 sprites per z step before colliding into the next band).
      // So z=1 means "one rung above z=0 in this layer" — what authors
      // intuitively expect when they set z=1 on the player and want it
      // to render on top of NPCs sharing the same layer.
      const LAYER_DEPTH_STEP = 1_000_000;
      const Z_STEP = 1000;
      const z = numOr(cfg.depth, 0, sprite);
      const currentDepth = sprite.gameObject.depth;
      const layerBase = Math.floor(currentDepth / LAYER_DEPTH_STEP) * LAYER_DEPTH_STEP;
      sprite.gameObject.setDepth(layerBase + z * Z_STEP);
      break;
    }
    case "SetCursor": {
      const style = strOr(cfg.style, "default", sprite);
      sprite.scene.input.setDefaultCursor(style);
      // Also clear any inline canvas-style override that ResetCursor
      // / HideCursor might have written, so SetCursor wins.
      const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
      if (canvas) canvas.style.cursor = style;
      break;
    }
    case "ResetCursor": {
      sprite.scene.input.setDefaultCursor("default");
      const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
      if (canvas) canvas.style.cursor = "default";
      break;
    }
    case "HideCursor": {
      sprite.scene.input.setDefaultCursor("none");
      const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
      if (canvas) canvas.style.cursor = "none";
      break;
    }
    case "ShowCursor": {
      sprite.scene.input.setDefaultCursor("default");
      const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
      if (canvas) canvas.style.cursor = "default";
      break;
    }
    case "BlurScene": {
      // Blur is one of the composable screen effects (blur + grayscale + vhs +
      // chromatic). Write the strength into peaky.screenFX and rebuild the whole
      // stack so blur composes with the others instead of clearing them.
      const strength = numOr(cfg.strength, 4, sprite);
      const fx = (sprite.scene.data.get("peaky.screenFX") as ScreenFXState | undefined) ?? {};
      if (strength > 0) fx.blur = strength; else delete fx.blur;
      sprite.scene.data.set("peaky.screenFX", fx);
      applyScreenFX(sprite.scene);
      break;
    }
    case "SetScreenEffect": {
      // Post-FX with a target: "screen" (whole world / main camera) or "layer"
      // (every object on a named layer — applied per-object so it follows
      // spawns + MoveToLayer). effect: grayscale | vhs | chromatic | filmgrain.
      // intensity 0 = remove that effect. Effects stack (one node per effect).
      const effect = strOr(cfg.effect, "grayscale", sprite);
      const intensity = numOr(cfg.intensity, 1, sprite);
      if (effect !== "grayscale" && effect !== "vhs" && effect !== "chromatic" && effect !== "filmgrain") break;
      const target = strOr(cfg.target, "screen", sprite);
      if (target === "layer") {
        const layerName = strOr(cfg.layer, "", sprite);
        if (!layerName) break;
        const reg = (sprite.scene.data.get("peaky.layerFX") as LayerFXReg | undefined) ?? new Map<string, ScreenFXState>();
        const lfx = reg.get(layerName) ?? {};
        if (intensity > 0) lfx[effect] = intensity; else delete lfx[effect];
        reg.set(layerName, lfx);
        sprite.scene.data.set("peaky.layerFX", reg);
        applyLayerFX(sprite.scene, layerName);
      } else {
        const fx = (sprite.scene.data.get("peaky.screenFX") as ScreenFXState | undefined) ?? {};
        if (intensity > 0) fx[effect] = intensity; else delete fx[effect];
        sprite.scene.data.set("peaky.screenFX", fx);
        applyScreenFX(sprite.scene);
      }
      break;
    }
    // ── Tilemap (Tier 1: read / mutate) ───────────────────────────────
    // All five actions share the same plumbing: find the named tilemap,
    // resolve the named layer to an id, run a method on the renderer.
    // Failure paths (unknown tilemap / layer / out-of-bounds cell) are
    // silent no-ops — authors get the visual feedback "nothing changed"
    // without a hard crash on a typo.
    case "SetTile": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      tm.setTileAt(layerId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)), Math.floor(numOr(cfg.tile, 0, sprite)));
      break;
    }
    case "RemoveTile": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      tm.removeTileAt(layerId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)));
      break;
    }
    case "SetTileAtWorld": {
      const src = sourceLabel ?? a.kind;
      const tmName = strOr(cfg.tilemap, "", sprite);
      const layerName = strOr(cfg.layer, "", sprite);
      const wx = numOr(cfg.x, 0, sprite);
      const wy = numOr(cfg.y, 0, sprite);
      // Multi-instance aware — pick the placement whose bounds contain
      // the click. See MineTileAtWorld for the full rationale.
      const tm = findTilemapAtWorld(sprite.scene, tmName, wx, wy) ?? findTilemap(sprite.scene, tmName);
      if (!tm) {
        const known = Array.from(((sprite.scene.data.get("peaky.tilemapsByName") as Map<string, unknown> | undefined) ?? new Map()).keys());
        Logger.log({ level: "warn", source: src, message: `tilemap "${tmName}" not found. Registered: [${known.join(", ")}]` });
        break;
      }
      const layerId = resolveLayerId(tm, layerName);
      if (!layerId) break;
      const cell = tm.worldToCell(wx, wy);
      if (!cell) break;
      tm.setTileAt(layerId, cell.c, cell.r, Math.floor(numOr(cfg.tile, 0, sprite)));
      break;
    }
    case "RemoveTileAtWorld": {
      const tmName = strOr(cfg.tilemap, "", sprite);
      const layerName = strOr(cfg.layer, "", sprite);
      const wx = numOr(cfg.x, 0, sprite);
      const wy = numOr(cfg.y, 0, sprite);
      // Multi-instance aware lookup — see MineTileAtWorld for rationale.
      const tm = findTilemapAtWorld(sprite.scene, tmName, wx, wy) ?? findTilemap(sprite.scene, tmName);
      if (!tm) {
        const known = Array.from(((sprite.scene.data.get("peaky.tilemapsByName") as Map<string, unknown> | undefined) ?? new Map()).keys());
        Logger.log({ level: "warn", source: sourceLabel ?? "RemoveTileAtWorld", message: `tilemap "${tmName}" not found. Registered: [${known.join(", ")}]` });
        break;
      }
      const layerId = resolveLayerId(tm, layerName);
      if (!layerId) {
        const layers = tm.layers.map((L) => (L as { name?: string }).name ?? L.id).join(", ");
        Logger.log({ level: "warn", source: sourceLabel ?? "RemoveTileAtWorld", message: `layer "${layerName}" not on tilemap "${tmName}". Available: [${layers}]` });
        break;
      }
      const cell = tm.worldToCell(wx, wy);
      if (!cell) {
        Logger.log({ level: "warn", source: sourceLabel ?? "RemoveTileAtWorld", message: `world (${wx}, ${wy}) is outside tilemap "${tmName}" bounds.` });
        break;
      }
      // Auto-route to animated placement when one is present at this cell —
      // same pattern as MineTileAtWorld so authors don't need to know which
      // kind of tile sits where.
      const animP = tm.findAnimatedTilePlacementAt(layerId, cell.c, cell.r);
      if (animP) {
        const removed = tm.removeAnimatedTileAt(layerId, cell.c, cell.r);
        Logger.log({ level: "log", source: sourceLabel ?? "RemoveTileAtWorld", message: `removed animated placement at (${cell.c}, ${cell.r}) on "${tmName}/${layerName}". id=${removed}.` });
        break;
      }
      // Same routing for BigTile placements. Authors expect "clear at world
      // (x, y)" to remove whatever's there, regardless of composite kind.
      const bigP = tm.findBigTilePlacementAt(layerId, cell.c, cell.r);
      if (bigP) {
        const removed = tm.removeBigTileAt(layerId, cell.c, cell.r);
        Logger.log({ level: "log", source: sourceLabel ?? "RemoveTileAtWorld", message: `removed BigTile placement at (${cell.c}, ${cell.r}) on "${tmName}/${layerName}". id=${removed}.` });
        break;
      }
      const prev = tm.getTileAt(layerId, cell.c, cell.r);
      const ok = tm.removeTileAt(layerId, cell.c, cell.r);
      Logger.log({ level: "log", source: sourceLabel ?? "RemoveTileAtWorld", message: `removed cell (${cell.c}, ${cell.r}) on "${tmName}/${layerName}". Was tile=${prev}, ok=${ok}.` });
      break;
    }
    case "FillTileRect": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const c0Raw = Math.floor(numOr(cfg.c0, 0, sprite));
      const r0Raw = Math.floor(numOr(cfg.r0, 0, sprite));
      const c1Raw = Math.floor(numOr(cfg.c1, 0, sprite));
      const r1Raw = Math.floor(numOr(cfg.r1, 0, sprite));
      const tile = Math.floor(numOr(cfg.tile, 0, sprite));
      const c0 = Math.min(c0Raw, c1Raw);
      const c1 = Math.max(c0Raw, c1Raw);
      const r0 = Math.min(r0Raw, r1Raw);
      const r1 = Math.max(r0Raw, r1Raw);
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          tm.setTileAt(layerId, cc, rr, tile);
        }
      }
      break;
    }
    case "ReplaceTile": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const fromTile = Math.floor(numOr(cfg.fromTile, 0, sprite));
      const toTile = Math.floor(numOr(cfg.toTile, 0, sprite));
      if (fromTile === toTile) break;
      // Scan the whole layer once. Cheap for typical map sizes; for huge
      // maps an index would help but that's a future optimization.
      for (let rr = 0; rr < tm.rows; rr++) {
        for (let cc = 0; cc < tm.cols; cc++) {
          if (tm.getTileAt(layerId, cc, rr) === fromTile) {
            tm.setTileAt(layerId, cc, rr, toTile);
          }
        }
      }
      break;
    }
    case "PlaceBigTile": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const bigTileId = strOr(cfg.bigTileId, "", sprite);
      if (!bigTileId) break;
      tm.placeBigTile(layerId, bigTileId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)));
      break;
    }
    case "RemoveBigTileAt": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      tm.removeBigTileAt(layerId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)));
      break;
    }
    case "RemoveBigTileAtWorld": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const cell = tm.worldToCell(numOr(cfg.x, 0, sprite), numOr(cfg.y, 0, sprite));
      if (!cell) break;
      tm.removeBigTileAt(layerId, cell.c, cell.r);
      break;
    }
    // Tier 2 — mining.
    case "DamageTile": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      tm.damageTile(sprite, layerId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)), Math.max(1, numOr(cfg.amount, 1, sprite)));
      break;
    }
    case "DamageTileAtWorld":
    case "MineTileAtWorld": {
      const src = sourceLabel ?? a.kind;
      const tmName = strOr(cfg.tilemap, "", sprite);
      const layerName = strOr(cfg.layer, "", sprite);
      // `power` and `amount` are aliases — MineTileAtWorld uses "power" to
      // mirror the mining metaphor (pickaxe power, magic damage, etc.) while
      // DamageTileAtWorld keeps the generic "amount".
      const damage = Math.max(1, numOr(a.kind === "MineTileAtWorld" ? cfg.power : cfg.amount, 1, sprite));

      // A multi-cell animated tile / BigTile must take damage ONCE per Mine
      // call, not once per overlapped cell — otherwise a tracer/box covering N
      // of its cells deals N× damage and a 2-HP tile dies in one swing. Dedup
      // by placement id across every mineAt call in this invocation.
      const minedPlacements = new Set<string>();
      // Mine ONE tile at a world point. Multi-instance aware (picks the tilemap
      // whose bounds contain the point). Routes animated / big-tile / regular
      // tiles. Returns (not break) per point so the multi-tile loop continues
      // past empty / unbreakable cells.
      const mineAt = (wx: number, wy: number, quiet = false, seg?: { x0: number; y0: number; x1: number; y1: number }, box?: { x: number; y: number; w: number; h: number }): void => {
        const tm = findTilemapAtWorld(sprite.scene, tmName, wx, wy) ?? findTilemap(sprite.scene, tmName);
        if (!tm) {
          const known = Array.from(((sprite.scene.data.get("peaky.tilemapsByName") as Map<string, unknown> | undefined) ?? new Map()).keys());
          Logger.log({ level: "warn", source: src, message: `tilemap "${tmName}" not found. Registered: [${known.join(", ")}]` });
          return;
        }
        const layerId = resolveLayerId(tm, layerName);
        if (!layerId) {
          const layers = tm.layers.map((L) => (L as { name?: string }).name ?? L.id).join(", ");
          Logger.log({ level: "warn", source: src, message: `layer "${layerName}" not on tilemap "${tmName}". Available: [${layers}]` });
          return;
        }
        const cell = tm.worldToCell(wx, wy);
        if (!cell) {
          Logger.log({ level: "warn", source: src, message: `world (${wx}, ${wy}) is outside tilemap "${tmName}" bounds.` });
          return;
        }
        // Animated placements live OUTSIDE the per-cell L.tiles array — route
        // there first when one is present (one action, both kinds).
        const animPlacement = tm.findAnimatedTilePlacementAt(layerId, cell.c, cell.r);
        if (animPlacement) {
          if (minedPlacements.has(animPlacement.id)) return; // already hit this placement this swing
          minedPlacements.add(animPlacement.id);
          const def = tm.animatedTiles[animPlacement.animatedTileId];
          const maxHP = parseHardnessMax(def?.hardness as number | string | undefined);
          if (maxHP <= 0) {
            Logger.log({ level: "warn", source: src, message: `animated tile "${def?.name || animPlacement.animatedTileId}" at (${cell.c}, ${cell.r}) has NO hardness configured — unbreakable. Set hardness in Tileset tab → Animated tiles editor.` });
            return;
          }
          const prevHP = tm.getAnimatedTileHP(animPlacement.id);
          const nextHP = tm.damageAnimatedTile(sprite, layerId, cell.c, cell.r, damage, seg, box);
          Logger.log({ level: "log", source: src, message: `animated tile "${def?.name || animPlacement.animatedTileId}" at (${cell.c}, ${cell.r}) HP ${prevHP} → ${nextHP === 0 ? "DESTROYED" : nextHP} (damage ${damage}, max ${maxHP}).` });
          return;
        }
        const bigPlacement = tm.findBigTilePlacementAt(layerId, cell.c, cell.r);
        if (bigPlacement) {
          if (minedPlacements.has(bigPlacement.id)) return; // already hit this placement this swing
          minedPlacements.add(bigPlacement.id);
          const maxHP = tm.getBigTileMaxHardness(bigPlacement.bigTileId);
          if (maxHP <= 0) {
            if (!quiet) Logger.log({ level: "warn", source: src, message: `BigTile "${bigPlacement.bigTileId}" at (${cell.c}, ${cell.r}) has NO hardness configured — unbreakable. Set Hardness in Tileset tab → Big tiles.` });
            return;
          }
          const prevHP = tm.getBigTileHP(bigPlacement.id);
          const nextHP = tm.damageBigTile(sprite, layerId, cell.c, cell.r, damage, seg, box);
          // < 0 = the hit landed outside the BigTile's damage area (e.g. a
          // trunk-only tree's canopy) — a silent no-op so the multi-cell loop
          // keeps going.
          if (nextHP < 0) return;
          Logger.log({ level: "log", source: src, message: `BigTile "${bigPlacement.bigTileId}" at (${cell.c}, ${cell.r}) HP ${prevHP} → ${nextHP === 0 ? "DESTROYED" : nextHP} (damage ${damage}, max ${maxHP}).` });
          return;
        }
        const idx = tm.getTileAt(layerId, cell.c, cell.r);
        if (idx < 0) {
          if (!quiet) Logger.log({ level: "warn", source: src, message: `cell (${cell.c}, ${cell.r}) on "${tmName}/${layerName}" is EMPTY — nothing to mine.` });
          return;
        }
        const maxHP = tm.getTileMaxHardness(idx);
        if (maxHP <= 0) {
          if (!quiet) Logger.log({ level: "warn", source: src, message: `tile idx ${idx} on "${tmName}" has NO hardness configured — unbreakable. Set hardness in Tileset tab → Mining panel.` });
          return;
        }
        const prevHP = tm.getTileHP(layerId, cell.c, cell.r);
        const nextHP = tm.damageTile(sprite, layerId, cell.c, cell.r, damage);
        Logger.log({ level: "log", source: src, message: `tile idx ${idx} at (${cell.c}, ${cell.r}) HP ${prevHP} → ${nextHP === 0 ? "DESTROYED" : nextHP} (damage ${damage}, max ${maxHP}).` });
      };

      // Mining area, in priority order:
      //   • `tracer` named → every tile that tracer's line/box overlaps.
      //   • `w`/`h` > 0    → every cell a w×h box centered at (x, y) overlaps
      //                      (e.g. a bullet's whole hitbox, not just its center).
      //   • else           → the single (x, y) point.
      const tracerName = strOr(cfg.tracer, "", sprite);
      let rectW = numOr(cfg.w, 0, sprite);
      let rectH = numOr(cfg.h, 0, sprite);
      let boxOffX = 0, boxOffY = 0;
      // When w/h aren't set, default the box to the CALLING sprite's hitbox, so
      // a bullet (or pickaxe) mines its footprint with zero config — just
      // x: self.x, y: self.y. Prefer a Projectile's DAMAGE hitbox (hitboxW/H +
      // offset), which is often much smaller than the physics body — otherwise
      // a small bullet on a tall BP body would mine the whole column. Falls back
      // to the body, then (no body) to the single (x, y) cell.
      if (rectW <= 0 && rectH <= 0 && tracerName === "") {
        const proj = sprite.findBehaviorByKind("Projectile") as
          | { hitboxW?: number; hitboxH?: number; hitboxOffsetX?: number; hitboxOffsetY?: number }
          | undefined;
        if (proj && ((proj.hitboxW ?? 0) > 0 || (proj.hitboxH ?? 0) > 0)) {
          rectW = (proj.hitboxW ?? 0) > 0 ? proj.hitboxW! : (sprite.body?.width ?? 0);
          rectH = (proj.hitboxH ?? 0) > 0 ? proj.hitboxH! : (sprite.body?.height ?? 0);
          boxOffX = proj.hitboxOffsetX ?? 0;
          boxOffY = proj.hitboxOffsetY ?? 0;
        } else if (sprite.body) {
          rectW = sprite.body.width;
          rectH = sprite.body.height;
        }
      }
      if (tracerName !== "") {
        const tr = findTracer(sprite, tracerName);
        if (!tr) {
          Logger.log({ level: "warn", source: src, message: `${a.kind}: tracer "${tracerName}" not found on this sprite.` });
        } else {
          // The tracer's LINE drives sub-cell polygon hit-tests on big/animated
          // tiles (so an 8px trace must land ON a tile's custom shape, not just
          // share its cell). Box tracers return null → cell-overlap fallback.
          const seg = tr.mineSegment() ?? undefined;
          const box = tr.mineBox() ?? undefined;
          const pts = tr.collectOverlappedTileCenters();
          const dbgLayers = (sprite.scene.data.get("peaky.tilemapLayers") as unknown[] | undefined)?.length ?? 0;
          Logger.log({ level: "warn", source: "MineDbg", message: `tracer "${tracerName}" collected ${pts.length} cell(s); geom=${seg ? `(${Math.round(seg.x0)},${Math.round(seg.y0)})->(${Math.round(seg.x1)},${Math.round(seg.y1)})` : "box"}; tilemapLayers=${dbgLayers}; pts=[${pts.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" ")}]` });
          // Pass seg/box so big/animated tiles test the tracer against their
          // CUSTOM POLYGON (sub-cell) — not whole-cell overlap. The 0-cells issue
          // was the layer registration (now fixed), NOT this gate.
          for (const p of pts) mineAt(p.x, p.y, false, seg, box);
        }
      } else if (rectW > 0 || rectH > 0) {
        const x = numOr(cfg.x, 0, sprite) + boxOffX;
        const y = numOr(cfg.y, 0, sprite) + boxOffY;
        const halfW = Math.max(0, rectW) / 2;
        const halfH = Math.max(0, rectH) / 2;
        const tm = findTilemapAtWorld(sprite.scene, tmName, x, y) ?? findTilemap(sprite.scene, tmName);
        if (!tm) { mineAt(x, y); break; } // mineAt logs the not-found warning
        const cA = tm.worldToCell(x - halfW, y - halfH);
        const cB = tm.worldToCell(x + halfW, y + halfH);
        if (cA && cB) {
          const c0 = Math.min(cA.c, cB.c), c1 = Math.max(cA.c, cB.c);
          const r0 = Math.min(cA.r, cB.r), r1 = Math.max(cA.r, cB.r);
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const wp = tm.cellToWorld(c, r);
              if (wp) mineAt(wp.x, wp.y, true); // quiet: empty cells in the box are expected
            }
          }
        }
      } else {
        mineAt(numOr(cfg.x, 0, sprite), numOr(cfg.y, 0, sprite));
      }
      break;
    }
    case "RestoreTileHP": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const c = Math.floor(numOr(cfg.c, 0, sprite));
      const r = Math.floor(numOr(cfg.r, 0, sprite));
      const map = sprite.scene.data.get("peaky.tileHP") as Map<string, number> | undefined;
      // Deleting the entry restores the lazy "no entry = full HP" baseline,
      // which is cheaper than rewriting the max value (and stays in sync if
      // the hardness config is edited at runtime via tileset hot-reload).
      if (map) {
        // We don't know the renderer's exact key prefix from outside; the
        // renderer scopes by tilemapId so the easiest portable thing is to
        // call its getter (which knows the key shape).
        void tm;
        const prefix = `${(tm as unknown as { tilemapId: string }).tilemapId}#${layerId}#${c},${r}`;
        map.delete(prefix);
      }
      break;
    }
    case "PlayTileAnimation":
    case "PlayTileAnimationAtWorld": {
      // Multi-instance lookup for the AtWorld branch — pick the placement
      // whose bounds contain the world coords. Cell-coord variant uses
      // last-wins by-name lookup (same as before).
      const tmName = strOr(cfg.tilemap, "", sprite);
      const wx = numOr(cfg.x, 0, sprite);
      const wy = numOr(cfg.y, 0, sprite);
      const tm = a.kind === "PlayTileAnimationAtWorld"
        ? (findTilemapAtWorld(sprite.scene, tmName, wx, wy) ?? findTilemap(sprite.scene, tmName))
        : findTilemap(sprite.scene, tmName);
      if (!tm) break;
      const layerId = resolveLayerId(tm, strOr(cfg.layer, "", sprite));
      if (!layerId) break;
      let c: number, r: number;
      if (a.kind === "PlayTileAnimationAtWorld") {
        const cell = tm.worldToCell(wx, wy);
        if (!cell) break;
        c = cell.c; r = cell.r;
      } else {
        c = Math.floor(numOr(cfg.c, 0, sprite));
        r = Math.floor(numOr(cfg.r, 0, sprite));
      }
      const placement = tm.findAnimatedTilePlacementAt(layerId, c, r);
      if (!placement) break;
      const restart = cfg.restart === true;
      const loopParam = cfg.loop;
      const loopOpt = typeof loopParam === "boolean" ? loopParam : undefined;
      tm.playAnimatedTilePlacement(placement.id, { restart, loop: loopOpt });
      break;
    }
    case "StopTileAnimation":
    case "StopTileAnimationAtWorld": {
      // Multi-instance lookup for the AtWorld branch — see PlayTileAnimation.
      const tmName = strOr(cfg.tilemap, "", sprite);
      const wx = numOr(cfg.x, 0, sprite);
      const wy = numOr(cfg.y, 0, sprite);
      const tm = a.kind === "StopTileAnimationAtWorld"
        ? (findTilemapAtWorld(sprite.scene, tmName, wx, wy) ?? findTilemap(sprite.scene, tmName))
        : findTilemap(sprite.scene, tmName);
      if (!tm) break;
      const layerId = resolveLayerId(tm, strOr(cfg.layer, "", sprite));
      if (!layerId) break;
      let c: number, r: number;
      if (a.kind === "StopTileAnimationAtWorld") {
        const cell = tm.worldToCell(wx, wy);
        if (!cell) break;
        c = cell.c; r = cell.r;
      } else {
        c = Math.floor(numOr(cfg.c, 0, sprite));
        r = Math.floor(numOr(cfg.r, 0, sprite));
      }
      const placement = tm.findAnimatedTilePlacementAt(layerId, c, r);
      if (!placement) break;
      tm.stopAnimatedTilePlacement(placement.id);
      break;
    }
    case "PlayAllTileAnimations": {
      const tm = findTilemap(sprite.scene, strOr(cfg.tilemap, "", sprite));
      if (!tm) break;
      const restart = cfg.restart === true;
      const loopParam = cfg.loop;
      const loopOpt = typeof loopParam === "boolean" ? loopParam : undefined;
      const filt = strOr(cfg.animatedTileId, "", sprite);
      tm.playAllAnimatedTiles({ animatedTileId: filt || undefined, restart, loop: loopOpt });
      break;
    }
    case "StopAllTileAnimations": {
      const tm = findTilemap(sprite.scene, strOr(cfg.tilemap, "", sprite));
      if (!tm) break;
      const filt = strOr(cfg.animatedTileId, "", sprite);
      tm.stopAllAnimatedTiles({ animatedTileId: filt || undefined });
      break;
    }
    case "RemoveAnimatedTileAt": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      tm.removeAnimatedTileAt(layerId, Math.floor(numOr(cfg.c, 0, sprite)), Math.floor(numOr(cfg.r, 0, sprite)));
      break;
    }
    case "RemoveTilesInTracer":
    case "FillTilesInTracer": {
      const res = resolveTilemapAndLayer(sprite.scene, strOr(cfg.tilemap, "", sprite), strOr(cfg.layer, "", sprite), sourceLabel ?? a.kind);
      if (!res) break;
      const { tm, layerId } = res;
      const tracerName = strOr(cfg.tracer, "", sprite);
      const tracer = findTracer(sprite, tracerName);
      if (!tracer) break;
      // Read the LIVE trace geometry — same path the tracer:.endX/endY
      // expressions use, so this works regardless of triggerMode / signal
      // timing. _calcGeom() pulls current host position + facing + angle.
      const geom = (tracer as unknown as { _calcGeom: () => { px: number; py: number; ex: number; ey: number; thick: number } })._calcGeom();
      const { px, py, ex, ey } = geom;
      const thick = Math.max(0, geom.thick);
      const dxAxis = ex - px;
      const dyAxis = ey - py;
      const dist = Math.hypot(dxAxis, dyAxis);
      if (dist < 1) break; // degenerate trace
      const ux = dxAxis / dist; // unit along trace
      const uy = dyAxis / dist;
      const halfThick = thick / 2;
      // AABB of the rotated rectangle (defined by start, end, +/- perp * halfThick).
      const perpX = -uy * halfThick;
      const perpY = ux * halfThick;
      const minX = Math.min(px + perpX, px - perpX, ex + perpX, ex - perpX);
      const maxX = Math.max(px + perpX, px - perpX, ex + perpX, ex - perpX);
      const minY = Math.min(py + perpY, py - perpY, ey + perpY, ey - perpY);
      const maxY = Math.max(py + perpY, py - perpY, ey + perpY, ey - perpY);
      const minCell = tm.worldToCell(minX, minY);
      const maxCell = tm.worldToCell(maxX, maxY);
      const c0 = Math.max(0, minCell ? minCell.c : Math.floor((minX - 0) / tm.tileW));
      const r0 = Math.max(0, minCell ? minCell.r : Math.floor((minY - 0) / tm.tileH));
      const c1 = Math.min(tm.cols - 1, maxCell ? maxCell.c : Math.ceil((maxX - 0) / tm.tileW));
      const r1 = Math.min(tm.rows - 1, maxCell ? maxCell.r : Math.ceil((maxY - 0) / tm.tileH));
      const newTile = a.kind === "RemoveTilesInTracer" ? -1 : Math.floor(numOr(cfg.tile, 0, sprite));
      // For each candidate cell, project its CENTER into the trace's local
      // frame and accept when both axes lie within the box footprint:
      //   along-axis u in [0, dist], perpendicular v in [-halfThick, +halfThick].
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) {
          const center = tm.cellToWorld(cc, rr);
          const wx = center.x - px;
          const wy = center.y - py;
          const u = wx * ux + wy * uy;
          if (u < 0 || u > dist) continue;
          const v = wx * (-uy) + wy * ux;
          if (v < -halfThick || v > halfThick) continue;
          tm.setTileAt(layerId, cc, rr, newTile);
        }
      }
      break;
    }
    default: {
      const _exhaustive: never = a.kind;
      console.warn("Unknown action kind", _exhaustive);
    }
  }
}

/**
 * Resolve a UI target name to one or more UIWidgetRenderer instances.
 *
 * - Empty target → returns the calling sprite's own UIWidgetRenderer
 *   (if it has one). This is the "modify self" path used when an
 *   action is wired to a widget's own event sheet for a self-mutation.
 * - Non-empty target → walks the scene's sprite list and matches any
 *   sprite whose `instanceName` (per-instance label / multi-mode child
 *   name) OR `blueprintName` (the widget asset's name) equals the
 *   target. Returns every matching widget's renderer — so multiple
 *   widgets sharing a name all update together.
 */
/**
 * Drain OnSceneEnd action chains on every live sprite, then run `then`
 * (which actually triggers the scene transition). Called by
 * RestartLayout / GoToLayout / GoToNextLayout / RecreateInitialObjects.
 *
 * Why: the action chain is executing INSIDE one sprite's processEvents
 * right now — every scene plugin (input, physics, time, cameras) is
 * alive and well. We emit `_sceneEnd` on each sprite's bus, then run
 * one synthetic `tick(0)` per sprite so their processEvents reads
 * `_sceneEnd` from `fired` and runs the matching action chains. THEN
 * we call `then()` to schedule the actual restart — so when Phaser's
 * SHUTDOWN fires later, OnSceneEnd has already run cleanly.
 *
 * Re-entry guard: if an OnSceneEnd action chain itself calls
 * RestartLayout/GoToLayout, we no-op the inner call. Otherwise we'd
 * recurse forever (drain triggers more drain triggers more drain).
 */
/**
 * Dispatch a `peaky:goToScene` CustomEvent on the canvas's parent so
 * the editor's ScenePanel can resolve the named scene against
 * `project.scenes` and rebootstrap the Peaky game with the new scene
 * data. Used by GoToLayout / GoToNextLayout.
 *
 * Phaser's `scene.start(name)` won't work for our case — we register
 * one MainScene class per game; project scenes aren't separate Phaser
 * scenes. Instead the editor wraps the runtime, so we let it handle
 * the transition by destroying + re-running with a different scene.
 */
function emitGoToScene(sprite: Sprite, name: string): void {
  const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
  const target = canvas?.parentElement ?? canvas;
  if (target) {
    target.dispatchEvent(new CustomEvent("peaky:goToScene", { detail: { name }, bubbles: true }));
  } else {
    // Fallback: if there's no DOM container (e.g., headless test), try
    // Phaser's native scene-start. It'll silently fail unless someone
    // pre-registered a Phaser scene with this key.
    try { sprite.scene.scene.start(name); } catch (e) { console.warn("[Peaky] GoToLayout fallback failed:", e); }
  }
}

/** Dispatch the loading-scene transition request — ScenePanel boots the
 *  project's loadingSceneId scene, async-loads the target scene's assets,
 *  drives `_loadStart` / `_loadProgress` / `_loadComplete` signals on every
 *  alive sprite, then transitions to `name` once both `minDisplaySec` has
 *  elapsed AND the loader has reported complete. If no loadingSceneId is
 *  set in the project, ScenePanel falls back to a plain GoToLayout. */
function emitGoToSceneWithLoad(sprite: Sprite, name: string, minDisplaySec: number): void {
  const canvas = sprite.scene.game.canvas as HTMLCanvasElement | undefined;
  const target = canvas?.parentElement ?? canvas;
  if (target) {
    target.dispatchEvent(new CustomEvent("peaky:goToSceneWithLoad", {
      detail: { name, minDisplaySec }, bubbles: true,
    }));
  } else {
    try { sprite.scene.scene.start(name); } catch (e) { console.warn("[Peaky] GoToLayoutWithLoad fallback failed:", e); }
  }
}

function drainSceneEndThen(sprite: Sprite, then: () => void): void {
  const scene = sprite.scene;
  if (!scene) { then(); return; }
  if (scene.data.get("peaky.sceneEnding")) {
    // Already inside a scene-end drain — don't recurse, don't double
    // the transition. The outer drain will call its own `then()`.
    return;
  }
  scene.data.set("peaky.sceneEnding", true);
  try {
    const all = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    // Snapshot — emitting / ticking may destroy or spawn sprites.
    const snapshot = [...all];
    for (const s of snapshot) {
      if (!s.destroyed) s.events.emit("_sceneEnd");
    }
    for (const s of snapshot) {
      if (!s.destroyed) {
        try { s.tick(0); } catch (e) { console.warn("[Peaky] OnSceneEnd tick threw:", e); }
      }
    }
  } finally {
    // Clear flag BEFORE actually transitioning — the new scene's data
    // manager is fresh anyway (Game.ts:create() resets peaky.sprites),
    // but better hygiene to leave the old data clean.
    scene.data.set("peaky.sceneEnding", false);
    // A layout transition always lands UNPAUSED. RestartLayout uses Phaser's
    // scene.restart(), which keeps the scene's DataManager AND clock
    // timeScale — so a SetPaused (or SetTimeScale 0) left active before the
    // restart would otherwise carry over and spawn the new layout frozen,
    // forcing a manual Resume first. Reset both here so restart-while-paused
    // just works.
    scene.data.set("peaky.pauseAll", false);
    scene.data.set("peaky.pausedLayers", new Set<string>());
    scene.time.timeScale = 1;
    scene.physics.world.timeScale = 1;
    scene.tweens.timeScale = 1;
  }
  then();
}

/**
 * When `sprite` is a multi-mode UI widget parent, translate each of its
 * children by (dx, dy). No-op for non-UI sprites and for single-mode
 * widgets (their visuals are bound to the parent's gameObject and follow
 * automatically). Used by the Set*Position / transform actions so a
 * single SetPosition on a widget moves the whole composite UI.
 */
function translateMultiUIChildren(sprite: Sprite, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  if (!sprite.isUIWidget || !sprite.instanceId) return;
  const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  for (const s of all) {
    if (s.destroyed || s === sprite) continue;
    if (s.parentInstanceId !== sprite.instanceId) continue;
    s.body.reset(s.gameObject.x + dx, s.gameObject.y + dy);
  }
}

/** Resolve which ParticleEmitter behaviors on `sprite` a particle action
 *  targets. `cfg.target` (string) is the emitter's `name` field — empty
 *  means broadcast to every emitter on the BP. Names that don't match
 *  any emitter return an empty list (silent no-op rather than throw, so
 *  a renamed/missing emitter doesn't crash chains). */
function resolveEmitters(sprite: Sprite, cfg: Record<string, unknown>): import("../behaviors/ParticleEmitter").ParticleEmitter[] {
  const all = sprite.findBehaviorsByKind("ParticleEmitter") as unknown as import("../behaviors/ParticleEmitter").ParticleEmitter[];
  const target = String(cfg.target ?? "").trim();
  if (!target) return all;
  return all.filter((e) => (e.name ?? "") === target);
}

/** SetUIElement prop typing — how to resolve each `<prop>` value before
 *  handing it to setLiveProp. Anything not listed is treated as numeric
 *  (numbers, colors, alpha). `value` is special-cased (kept as number-or-expr). */
const SETUI_STRING_PROPS = new Set<string>(["text", "selectedValue", "fontFamily", "align", "vAlign", "direction", "spriteId", "shopRole", "shopItem", "shopCurrency"]);
const SETUI_BOOL_PROPS = new Set<string>(["fontBold", "fontItalic", "enabled"]);

function resolveUIWidgets(sprite: Sprite, target: string): import("../behaviors/UIWidgetRenderer").UIWidgetRenderer[] {
  const out: import("../behaviors/UIWidgetRenderer").UIWidgetRenderer[] = [];
  if (target === "") {
    const own = sprite.findBehaviorByKind("UIWidgetRenderer");
    if (own) {
      out.push(own);
      return out;
    }
    // Multi-mode parent has NO UIWidgetRenderer of its own — the children
    // each carry one. "Self" on a multi-mode parent's event sheet means
    // "all my children", so SetUIVisible / SetUIBgColor / etc. with an
    // empty target broadcasts to every child renderer.
    if (sprite.isUIWidget && sprite.instanceId) {
      const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      for (const s of all) {
        if (s.destroyed) continue;
        if (s.parentInstanceId === sprite.instanceId) {
          const r = s.findBehaviorByKind("UIWidgetRenderer");
          if (r) out.push(r);
        }
      }
    }
    return out;
  }
  const all = (sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  // Qualified `Widget.Child` form: matches a child whose `instanceName`
  // is `Child` AND whose parent widget's `blueprintName` is `Widget`.
  // The dot is the disambiguator when the same child name appears
  // across multiple widgets. Falls through to the simple-name path
  // below if no parent matches (treats the whole string as a single
  // name — covers the rare case of a real instance literally named
  // "Foo.Bar").
  const dotIdx = target.indexOf(".");
  if (dotIdx > 0 && dotIdx < target.length - 1) {
    const widgetName = target.slice(0, dotIdx);
    const childName = target.slice(dotIdx + 1);
    // Find the parent widget instance(s) by name; capture their instanceIds.
    const parentIds = new Set<string>();
    for (const s of all) {
      if (s.destroyed || !s.isUIWidget) continue;
      if (s.blueprintName === widgetName && s.instanceId) parentIds.add(s.instanceId);
    }
    if (parentIds.size > 0) {
      for (const s of all) {
        if (s.destroyed) continue;
        if (s.instanceName === childName && s.parentInstanceId && parentIds.has(s.parentInstanceId)) {
          const r = s.findBehaviorByKind("UIWidgetRenderer");
          if (r) out.push(r);
        }
      }
      if (out.length > 0) return out;
    }
  }
  // Simple name: matches by instanceName (per-instance label / multi-mode
  // child name) OR blueprintName (the widget asset's name).
  for (const s of all) {
    if (s.destroyed) continue;
    if (s.instanceName === target || s.blueprintName === target) {
      const r = s.findBehaviorByKind("UIWidgetRenderer");
      if (r) out.push(r);
    }
  }
  return out;
}

/**
 * Find a Camera behavior anywhere in the scene — typically on the player
 * BP, or a dedicated MainCamera BP. Camera state is scene-scoped (one main
 * camera), so any sprite firing a Camera action looks up the same instance.
 */
function findCameraBehavior(sprite: Sprite): import("../behaviors/Camera").Camera | null {
  // Cache the first-seen Camera behavior on the scene so subsequent
  // lookups don't depend on iteration order of `peaky.sprites`. Without
  // the cache, a Destroy + CreateObject cycle on a non-camera BP can
  // shift the array order, and `findCameraBehavior` would silently
  // start returning a different sprite's Camera (if multiple exist).
  type CameraBehavior = import("../behaviors/Camera").Camera;
  const scene = sprite.scene;
  const cached = scene.data.get("peaky.camera") as { sprite: Sprite; behavior: CameraBehavior } | undefined;
  if (cached && !cached.sprite.destroyed && cached.behavior) {
    return cached.behavior;
  }
  const all = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  for (const s of all) {
    if (s.destroyed) continue;
    const cam = s.findBehaviorByKind("Camera");
    if (cam) {
      scene.data.set("peaky.camera", { sprite: s, behavior: cam });
      return cam;
    }
  }
  return null;
}

/**
 * Apply override params from a StartParticles / BurstParticles action's
 * config to a ParticleEmitter. Skips sentinel "no override" values so
 * fields the author left at default keep the emitter's existing config.
 *   - numeric sentinels: -1 (positives) and -999 (angles / gravity)
 *   - string sentinels: "" (sprite asset id, blendMode, frameMode)
 * Overrides persist on the emitter after firing — issue another
 * SetParticleXxx to reset specific fields if you need to.
 */
function applyParticleOverrides(
  emitterRaw: Record<string, unknown>,
  cfg: Record<string, unknown>,
  sprite: Sprite,
): void {
  // Author opted out — leave the emitter's inspector values alone.
  if (!cfg.override || cfg.override === 0) return;
  const emitter = emitterRaw as Record<string, unknown> & {
    setGravity?: (x: number, y: number) => void;
    setRate?: (n: number) => void;
    setSpeed?: (s: number, j: number) => void;
    setSprite?: (id: string) => void;
    setFrameSelection?: (frameIndices: string, frameMode: string) => void;
  };
  // Override is on — push every relevant field from cfg into the emitter.
  // numOr / String coerce in case the editor stored a string ("100"
  // typed into a NumberField mid-edit).
  const setNum = (key: string): void => {
    if (cfg[key] === undefined) return;
    emitter[key] = numOr(cfg[key], emitter[key] as number, sprite);
  };
  const setStr = (key: string): void => {
    if (cfg[key] === undefined) return;
    const s = String(cfg[key]);
    if (s) emitter[key] = s;
  };
  if (cfg.rate !== undefined) emitter.setRate?.(numOr(cfg.rate, 10, sprite));
  if (cfg.speed !== undefined || cfg.speedJitter !== undefined) {
    emitter.setSpeed?.(
      numOr(cfg.speed, emitter.speed as number, sprite),
      numOr(cfg.speedJitter, emitter.speedJitter as number, sprite),
    );
  }
  if (cfg.gravityX !== undefined || cfg.gravityY !== undefined) {
    emitter.setGravity?.(
      numOr(cfg.gravityX, emitter.gravityX as number, sprite),
      numOr(cfg.gravityY, emitter.gravityY as number, sprite),
    );
  }
  if (typeof cfg.spriteId === "string" && cfg.spriteId) {
    emitter.setSprite?.(cfg.spriteId);
  }
  setNum("lifetime"); setNum("lifetimeJitter");
  setNum("angleMin"); setNum("angleMax");
  setNum("friction");
  setNum("rotationStart"); setNum("rotationEnd"); setNum("rotationJitter");
  setNum("scaleStart"); setNum("scaleEnd");
  setNum("alphaStart"); setNum("alphaEnd");
  setNum("tintStart"); setNum("tintEnd");
  setNum("spawnJitterX"); setNum("spawnJitterY");
  setStr("blendMode");
  // frameMode + frameIndices change which frames render — rebuild the packed
  // frame texture on the live emitter (setStr alone wouldn't re-pack).
  if (cfg.frameMode !== undefined || cfg.frameIndices !== undefined) {
    emitter.setFrameSelection?.(
      cfg.frameIndices !== undefined ? String(cfg.frameIndices) : String(emitter.frameIndices ?? ""),
      cfg.frameMode !== undefined ? String(cfg.frameMode) : String(emitter.frameMode ?? ""),
    );
  }
}
