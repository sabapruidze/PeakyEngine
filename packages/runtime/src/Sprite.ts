import Phaser from "phaser";
import type { Condition, StateAction } from "@peaky/shared";
import { isTriggerCondition } from "@peaky/shared";
import { Behavior, BehaviorClass } from "./Behavior";
import type { BehaviorKindMap } from "./Behavior";
import { EventBus } from "./EventBus";
import { getInputActions } from "./input/InputActions";
import { evaluateCondition, runAction, resolvePickSet } from "./sm/eval";
import { destroyLogicSheet } from "./LogicSheetRunner";
import { persistentState } from "./PersistentState";
import { Logger } from "./Logger";

/**
 * Runtime spec for a single event sheet node. Construct-3 style:
 *   • `kind: "event"`   — fires when conditions match per `combinator`.
 *   • `kind: "comment"` — ignored at runtime.
 *
 * Use the `Else` condition (in System) for "fires when previous sibling
 * didn't" semantics. Use `combinator: "OR"` to make conditions any-match.
 *
 * Conditions are evaluated together: trigger conditions consume their
 * one-shot signal; state conditions are continuous queries. Sub-events
 * run AFTER the parent's actions and re-evaluate their own conditions.
 */
export interface EventSpec {
  id: string;
  kind: "event" | "comment" | "group";
  combinator?: "AND" | "OR";
  conditions: Condition[];
  actions: StateAction[];
  children: EventSpec[];
  groupId?: string;
  disabled?: boolean;
}

/** Spec for a named event group — enable/disable batches of events together. */
export interface EventGroupSpec {
  id: string;
  name: string;
  enabled: boolean;
}

/** Per-event runtime state — bookkeeping for one node in the event tree. */
interface EventState {
  /** OnCreate fires exactly once per condition with that kind. */
  createdFired: boolean;
  /** OnSceneStart fires exactly once per condition (currently aliases createdFired-style semantics). */
  sceneStartFired: boolean;
  /** EveryXSeconds tracks the last-fire clock value. Initialized to the
   *  sprite's clock at attach time so the FIRST fire happens AFTER the
   *  configured interval has elapsed (matches Construct 3's "Every X
   *  seconds" semantics — without this it'd fire on tick 1 then again
   *  every X seconds, which surprises users).  */
  everyLastFiredSec: number;
  /** Edge-detect for OnAnimationEnd: previous frame's SR.finishedEmitted. */
  prevAnimFinished: boolean;
  /** Until this clock value, the chain is mid-Wait and the event is suppressed. */
  inFlightUntil: number;
  /** Last tick's "all non-meta conditions matched" — used by TriggerOnceWhileTrue. */
  prevTickMatched: boolean;
  /** Set true when StopLoop runs — the inner loop exits, then this is reset. */
  stopLoop: boolean;
  /** For events with loop/pick conditions but no explicit trigger — fire once
      then suppress so they don't run every frame. */
  implicitOnceFired: boolean;
}

export interface SpriteShape {
  color?: number;
  w?: number;
  h?: number;
  /** BP class — when "Camera", the body is created but made inert
   *  (no gravity, immovable). The rectangle stays in place at spawn so
   *  the Camera BP behaves as a stationary scene-camera controller while
   *  Phaser's viewport is what actually follows things. */
  classKind?: string;
  /** When true, skip `scene.physics.add.existing(gameObject)` — no Phaser
   *  body created. The sprite still has position (gameObject.x/y), tags,
   *  and renders normally; it just doesn't participate in physics. Saves
   *  ~0.3ms per spawn. Author must not attach body-needing behaviors
   *  (CharacterMovement / MoveTo with physics / Solid / etc.) to a no-body
   *  BP — those silently no-op. */
  noPhysicsBody?: boolean;
}

/**
 * Thin wrapper around a Phaser arcade-physics sprite.
 * For v0, "sprite" = colored rectangle. Image loading comes later via SpriteRenderer.
 */
/** Monotonic UID source for in-scene sprite identity (ObjectUIDExists / picks). */
let _spriteUidCounter = 1;

/** Throttled-cull tick rate: off-screen "throttled" sprites run their full
 *  tick once every CULL_THROTTLE_FRAMES frames (10Hz at 60fps default).
 *  Picked so the "villager walking off-screen" reads visually as slightly
 *  reduced framerate (smooth-ish from the player's standpoint when they
 *  walk back) rather than full freeze. Lowering = more responsive culled
 *  sprites but smaller CPU win; raising = bigger win, choppier wake-up. */
const CULL_THROTTLE_FRAMES = 6;

/** LOD throttle — distance check runs every Nth frame per sprite. 6 frames
 *  at 60fps = 10Hz, same cadence as `CULL_THROTTLE_FRAMES`. Player can't move
 *  across the ring edge fast enough for the 100ms staleness to be visible. */
const LOD_TICK_FRAMES = 6;

/** Runtime shape of a component-LOD group on a sprite. Mirrors the
 *  `LODGroup` schema in editor/project.ts but kept inline here so the
 *  runtime package doesn't need to import from the editor's project file
 *  (which would invert the dep direction). */
export interface SpriteLODGroup {
  id: string;
  name: string;
  components: string[];
  distance: number;
  targetTag: string;
}

/** O(1) sprite-by-uid lookup using the index the Sprite ctor/destroy maintain
 *  in `scene.data["peaky.spritesByUid"]`. Returns undefined for a missing or
 *  destroyed uid. Replaces `peaky.sprites.find(s => s.uid === x)` scans. */
export function spriteByUid(scene: Phaser.Scene, uid: number): Sprite | undefined {
  const s = (scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined)?.get(uid);
  return s && !s.destroyed ? s : undefined;
}

/** Per-scene `tag → Set<Sprite>` index. Built incrementally as sprites are
 *  spawned + tagged via `indexSpriteTags`; cleared on destroy via
 *  `unindexSpriteTags`. Replaces O(N) `peaky.sprites.filter(s => s.tags.has(t))`
 *  scans with O(1) Set lookups across AIBrain / Projectile / FireProjectile /
 *  EmitSignalTo / SetVarOn / Tracer hot paths — the single biggest win at
 *  high NPC counts.
 *
 *  Sprite.tags is populated by spawnFromBlueprint AFTER Sprite construction
 *  (so the constructor can't pre-index). `indexSpriteTags` is called by
 *  the spawn path once all tags are added; runtime tag mutations would
 *  go through `addSpriteTag` / `removeSpriteTag` to keep the index in
 *  sync — though Peaky currently has no runtime tag-mutation actions, so
 *  the spawn-time indexing alone covers every current case. */
const SPRITES_BY_TAG_KEY = "peaky.spritesByTag";

/** Returns the live `Set<Sprite>` registered under `tag`, or an empty set
 *  when no sprite carries it. The returned set is the LIVE index — DO NOT
 *  mutate it from outside; use addSpriteTag / removeSpriteTag instead.
 *  Iteration order is insertion order (Set semantics). */
export function getSpritesByTag(scene: Phaser.Scene, tag: string): Set<Sprite> {
  const map = scene.data.get(SPRITES_BY_TAG_KEY) as Map<string, Set<Sprite>> | undefined;
  return map?.get(tag) ?? EMPTY_SPRITE_SET;
}
const EMPTY_SPRITE_SET: Set<Sprite> = new Set();

/** Register every current `sprite.tags` entry in the scene's tag index.
 *  Call once per sprite AFTER tags have been added by the spawn path. Safe
 *  to call multiple times (Set-based; duplicates collapse). */
export function indexSpriteTags(scene: Phaser.Scene, sprite: Sprite): void {
  if (sprite.tags.size === 0) return;
  let map = scene.data.get(SPRITES_BY_TAG_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) { map = new Map(); scene.data.set(SPRITES_BY_TAG_KEY, map); }
  for (const t of sprite.tags) {
    let set = map.get(t);
    if (!set) { set = new Set(); map.set(t, set); }
    set.add(sprite);
  }
}

/** Remove this sprite from every tag bucket it appears in. Called by
 *  Sprite.destroy(). Empty buckets are kept (cheap; avoids GC churn when a
 *  tag's last sprite died but a fresh one is about to spawn). */
export function unindexSpriteTags(scene: Phaser.Scene, sprite: Sprite): void {
  const map = scene.data.get(SPRITES_BY_TAG_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) return;
  for (const t of sprite.tags) {
    map.get(t)?.delete(sprite);
  }
}

/** Add a tag to a sprite AND its scene index in one go. Future runtime
 *  AddTag actions (when added to Peaky) should route through this helper
 *  so the index stays in sync. */
export function addSpriteTag(scene: Phaser.Scene, sprite: Sprite, tag: string): void {
  if (sprite.tags.has(tag)) return;
  sprite.tags.add(tag);
  let map = scene.data.get(SPRITES_BY_TAG_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) { map = new Map(); scene.data.set(SPRITES_BY_TAG_KEY, map); }
  let set = map.get(tag);
  if (!set) { set = new Set(); map.set(tag, set); }
  set.add(sprite);
}

/** Remove a tag from a sprite AND its scene index. Mirror of addSpriteTag. */
export function removeSpriteTag(scene: Phaser.Scene, sprite: Sprite, tag: string): void {
  if (!sprite.tags.has(tag)) return;
  sprite.tags.delete(tag);
  const map = scene.data.get(SPRITES_BY_TAG_KEY) as Map<string, Set<Sprite>> | undefined;
  map?.get(tag)?.delete(sprite);
}

/** Per-scene `name → Set<Sprite>` index — same pattern as the tag index above.
 *  Keyed by BOTH blueprintName and instanceName so `var:Player.hp` /
 *  `var:Boss.x` resolve with O(1) lookups instead of a full peaky.sprites scan
 *  on every expression, every frame (HUD/AI hot path at swarm scale). */
const SPRITES_BY_NAME_KEY = "peaky.spritesByName";

/** Live `Set<Sprite>` registered under `name` (matches blueprintName OR
 *  instanceName), or an empty set. Iteration order is insertion (spawn) order,
 *  so "first match wins" matches the old linear scan. */
export function getSpritesByName(scene: Phaser.Scene, name: string): Set<Sprite> {
  const map = scene.data.get(SPRITES_BY_NAME_KEY) as Map<string, Set<Sprite>> | undefined;
  return map?.get(name) ?? EMPTY_SPRITE_SET;
}

function _nameMap(scene: Phaser.Scene): Map<string, Set<Sprite>> {
  let map = scene.data.get(SPRITES_BY_NAME_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) { map = new Map(); scene.data.set(SPRITES_BY_NAME_KEY, map); }
  return map;
}
function _addName(map: Map<string, Set<Sprite>>, name: string, sprite: Sprite): void {
  if (!name) return;
  let set = map.get(name);
  if (!set) { set = new Set(); map.set(name, set); }
  set.add(sprite);
}

/** Register a sprite under its blueprintName AND instanceName. Call from the
 *  spawn path right after indexSpriteTags (names are set by then). */
export function indexSpriteName(scene: Phaser.Scene, sprite: Sprite): void {
  const map = _nameMap(scene);
  _addName(map, sprite.blueprintName, sprite);
  _addName(map, sprite.instanceName, sprite);
}

/** Remove a sprite from both name buckets. Called by Sprite.destroy(). */
export function unindexSpriteName(scene: Phaser.Scene, sprite: Sprite): void {
  const map = scene.data.get(SPRITES_BY_NAME_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) return;
  map.get(sprite.blueprintName)?.delete(sprite);
  map.get(sprite.instanceName)?.delete(sprite);
}

/** Re-key a sprite's INSTANCE name (SetInstanceName action). Drops the old
 *  instanceName bucket entry, then re-adds blueprintName (in case it equaled
 *  the old name) and the new instanceName. */
export function reindexSpriteInstanceName(scene: Phaser.Scene, sprite: Sprite, oldName: string, newName: string): void {
  const map = scene.data.get(SPRITES_BY_NAME_KEY) as Map<string, Set<Sprite>> | undefined;
  if (!map) return;
  if (oldName) map.get(oldName)?.delete(sprite);
  _addName(map, sprite.blueprintName, sprite);
  _addName(map, newName, sprite);
}

export class Sprite {
  /** Stable per-instance UID — used by ObjectUIDExists, picking, etc. */
  readonly uid: number = _spriteUidCounter++;
  readonly scene: Phaser.Scene;
  readonly gameObject: Phaser.GameObjects.Rectangle;
  /** Phaser arcade body. Undefined when the BP has `noPhysicsBody = true`
   *  (decoration sprites). Code that uses the body should null-check first;
   *  Sprite-internal hot paths (cull check, save/load, MoveTo physics
   *  branch) and CollisionScan already guard. */
  readonly body!: Phaser.Physics.Arcade.Body;
  events = new EventBus();
  /**
   * When false, this sprite's `tick()` does NOT call `events.flush()`.
   * Used by multi-mode UI widget children that share their parent's
   * EventBus: only the parent should rotate the shared frame buffers,
   * otherwise N siblings each calling flush() in one tick clobbers
   * `firedPrev` and signals get silently dropped between siblings.
   *
   * Default true (every sprite owns its own bus). spawnFromUIWidget
   * sets it false on multi-mode children after pointing their `events`
   * at the parent's bus.
   */
  ownsEventBus = true;
  /** Tags inherited from Blueprint plus any instance-specific additions.
   *  Union — used for collision/overlap matching, picking, and the legacy
   *  `picked.tag` (first-tag) lookups. */
  readonly tags: Set<string> = new Set();
  /** Instance-only subset of `tags` — the per-placement extras the author
   *  wrote in the scene editor's Tags field. Exposed via the GetOtherObject
   *  `instanceTag` pin and `picked.instanceTag` / `self.instanceTag`
   *  expression tokens so authors can disambiguate "what specific thing
   *  did I collide with" from the BP-level role tag. */
  readonly instanceTags: Set<string> = new Set();
  /** Arcade collider/overlap handles registered for this sprite by
   *  runProject's pair-wiring. Removed from the physics world on destroy so a
   *  long session that spawns/destroys (projectiles, enemies) doesn't leak a
   *  growing list of dead-referencing colliders that keep being processed. */
  readonly _colliders: Phaser.Physics.Arcade.Collider[] = [];

  /** Tag-based overlap state (populated each tick by `runCollisionScan`
   *  in `CollisionScan.ts`). Drives the animator's `justCollidedWithTag`,
   *  `isOverlappingTag`, `justSeparatedFromTag` conditions. These sets
   *  are scene-tick-local and intentionally NOT serialized — they're
   *  re-derived from physics state each tick. */
  _currOverlap: Set<Sprite> = new Set();
  _prevOverlap: Set<Sprite> = new Set();
  _justCollidedThisTick: Set<Sprite> = new Set();
  _justSeparatedThisTick: Set<Sprite> = new Set();
  /** The "other" sprite of the event currently being handled — set by the
   *  Logic Sheet trigger fire when a collide/overlap/separate event carries a
   *  payload, so a `Get Collided Object` getter can read its name/tag/etc.
   *  Transient: valid for the immediate synchronous chain (stale after a Wait). */
  _eventOther: Sprite | null = null;
  /** Names of this sprite's Logic Sheet groups (folders) currently DEACTIVATED
   *  via the Set Group Active action. Empty = all groups active. The Logic
   *  Sheet trigger `fire` skips a group whose name is in here. */
  _disabledGroups: Set<string> = new Set();
  /** Blueprint display name set by the spawner. Reported by Tracer hit data
   *  (`tracer:<name>.actorName`) and useful for identifying spawned actors. */
  blueprintName = "";
  /** Blueprint id this sprite was spawned from. Stable across renames (the
   *  name field follows user edits). Used by systems like DialogueRunner
   *  that need to find a sprite belonging to a specific BP. */
  blueprintId = "";
  /** Optional per-instance human label set in the scene editor's Instance
   *  Inspector. Lets dialogue / events target a SPECIFIC placement among
   *  multiple instances of the same BP. Empty when the user hasn't named
   *  this instance — falls back to blueprintName for resolution. */
  instanceName = "";
  /** BP name from the editor — used by Y-sort / debug to find the player by
   *  name (e.g. "BP_TP_Player") instead of guessing by size/position. Set by
   *  runProject during BP spawn; empty for tilemap/UI hosts. */
  bpName = "";
  /** Stable id of the SceneInstance / UIWidgetInstance this sprite was
   *  spawned from. Used by Stack to find children whose `parentInstanceId`
   *  matches this id. Empty for runtime-spawned objects (CreateObject)
   *  that don't have a scene placement. */
  instanceId = "";
  /** Stable id for a RUNTIME-spawned object (CreateObject), minted by
   *  `nextSpawnId()` and stamped by the `peaky.spawn` callback. Empty for
   *  authored placements (they use `instanceId`). SaveSlot records it +
   *  `blueprintId`/`spawnLayerName` so LoadSlot can RECREATE the object (a
   *  placed candle) instead of skipping it — authored instances are re-placed
   *  by the scene, spawned ones are not, so without this they vanish on load. */
  spawnId = "";
  /** Layer NAME this object was spawned into (so a recreate on load lands on
   *  the same layer). Empty = the scene's default/active layer at spawn. */
  spawnLayerName = "";
  /** When non-empty, identifies this sprite's parent in a Stack-managed
   *  layout. Set on UI widget instances placed inside a Stack-bearing
   *  parent in the editor. Empty for top-level placements. */
  parentInstanceId = "";
  /** True when this sprite was spawned as part of a UI Widget (parent
   *  host OR a multi-mode child). Used by DestroyUIWidget to identify
   *  UI sprites and to cascade destroy children when a parent dies. */
  isUIWidget = false;
  /**
   * When true, a UI widget sprite renders on the MAIN (world) camera
   * instead of the UI camera. Set by spawnFromUIWidget when the host
   * layer's parallax is non-zero — the widget is meant to follow the
   * world camera (e.g. floating health bars, in-world prompts).
   *
   * Default false: UI widgets render on the UI cam only, so BlurScene
   * blurs the world without smearing the UI. Non-UI sprites ignore
   * this flag entirely (they always render on the main cam).
   */
  renderOnMainCamera = false;
  /** The id of the layer this sprite was spawned onto. Stamped by
   *  runProject's spawn paths. Used by behaviors that spawn attached
   *  children (e.g. the Widget component spawning its HP bar) so the
   *  child can inherit the host's layer and ride the same camera /
   *  parallax / depth band. Empty = unknown layer (legacy / failed lookup). */
  layerId = "";

  /**
   * Y-sort config — set by runProject when this sprite is placed on a
   * `ySort: true` scene layer. Each tick, the sprite's depth is recomputed
   * to `_ySortBaseDepth + body.y + body.height * _ySortPivotY` so it sorts
   * against other Y-sort sprites and tilemap rows by its world Y position.
   * `_ySortEnabled = false` skips the per-tick depth update (default).
   */
  _ySortEnabled = false;
  _ySortBaseDepth = 0;
  _ySortPivotY = 1;
  /** When true, the Y-sort pivot MIRRORS with vertical movement: moving UP uses
   *  the configured pivot, moving DOWN uses (1 − pivot) — e.g. 0.8 up / 0.2
   *  down. Direction latches while idle (no flicker when stopping). */
  _ySortFlipByDir = false;
  private _ySortDirDown = false;
  private _ySortPrevY = Number.NaN;

  /**
   * Route a Phaser GameObject to the right camera based on whether
   * this sprite is part of a UI widget. UI widget objects render only
   * on the secondary "ui" camera (so BlurScene can blur the main
   * camera's world without smearing the UI). Non-UI objects render
   * only on the main camera.
   *
   * Called by behaviors right after they create overlays (Text /
   * SpriteRenderer / UIWidgetRenderer's internals). When the UI
   * camera doesn't exist yet (during scene boot before Game.ts's
   * create runs), this is a no-op; the caller should rely on
   * `Sprite.gameObject` getting routed by spawnFromBlueprint /
   * spawnFromUIWidget.
   */
  /** Every overlay GameObject this sprite owns (SpriteRenderer image, Text,
   *  particles, tracer gfx, …), collected as they're routed. Powers per-object
   *  post-FX for SetScreenEffect targeting a layer/object — see collectFXObjects. */
  private _fxObjects = new Set<Phaser.GameObjects.GameObject>();

  /** Host body + every overlay GameObject, for applying per-object post-FX.
   *  Skips destroyed / inactive objects. */
  collectFXObjects(): Phaser.GameObjects.GameObject[] {
    const out: Phaser.GameObjects.GameObject[] = [];
    if (this.gameObject && this.gameObject.active) out.push(this.gameObject);
    for (const go of this._fxObjects) if (go && go.active) out.push(go);
    return out;
  }

  /** Objects this sprite hid when it froze off-screen (so wake restores only
   *  what was actually visible, not force-showing an intentionally-hidden one). */
  private _culledHidden: Phaser.GameObjects.GameObject[] = [];
  /** Off-screen-cull visibility. The loop cull only hid the HOST rect, leaving
   *  every overlay (SpriteRenderer image, Text, tracer gfx…) in Phaser's render
   *  list — so ~N off-screen overlays still pay transform + cull every frame.
   *  Hiding them lets the renderer skip them outright. */
  setCullHidden(hidden: boolean): void {
    if (hidden) {
      if (this._culledHidden.length) return; // already hidden
      const hide = (go: Phaser.GameObjects.GameObject | undefined) => {
        const v = go as unknown as { visible?: boolean; setVisible?: (b: boolean) => void } | undefined;
        if (v && v.visible && typeof v.setVisible === "function") { this._culledHidden.push(go!); v.setVisible(false); }
      };
      hide(this.gameObject);
      for (const go of this._fxObjects) hide(go);
    } else {
      // Unculling reveals what cull hid — UNLESS the author hid the whole BP
      // via SetVisible; then it must stay hidden.
      const show = !this._manualHidden;
      for (const go of this._culledHidden) {
        const v = go as unknown as { setVisible?: (b: boolean) => void };
        if (v && typeof v.setVisible === "function") v.setVisible(show);
      }
      this._culledHidden.length = 0;
    }
  }

  /** Author-driven whole-BP visibility (the SetVisible action). true = hidden.
   *  Hides the host body AND every routed overlay (SpriteRenderer image, Text,
   *  particles, tracer gfx…). Composes with the off-screen cull — unculling
   *  won't reveal a manually-hidden BP. (Toggling a whole LAYER's visibility
   *  re-applies per behavior and can override this; rare, acceptable for v1.) */
  private _manualHidden = false;
  get manualHidden(): boolean { return this._manualHidden; }
  /** Author-driven whole-BP opacity multiplier (the SetOpacity action). The
   *  overlays (SpriteRenderer image, Text) multiply their computed alpha by
   *  this each tick, so SetOpacity fades the actual sprite — not just the
   *  invisible host rect. 1 = fully opaque. */
  manualAlpha = 1;
  setManualHidden(hidden: boolean): void {
    this._manualHidden = hidden;
    // While culled off-screen, don't force-show — the cull owns visibility and
    // its re-show path (above) already honors _manualHidden.
    if (!hidden && this._culledHidden.length > 0) return;
    const apply = (go: Phaser.GameObjects.GameObject | undefined) => {
      const v = go as unknown as { setVisible?: (b: boolean) => void } | undefined;
      if (v && typeof v.setVisible === "function") v.setVisible(!hidden);
    };
    apply(this.gameObject);
    for (const go of this._fxObjects) apply(go);
  }

  routeOverlayToCamera(go: Phaser.GameObjects.GameObject): void {
    if (!this.scene) return;
    this._fxObjects.add(go);
    // Drop the reference when the overlay is destroyed, so transient/churning
    // overlays (e.g. Weather splash pixels) don't accumulate dead entries in
    // _fxObjects forever — which would grow unbounded and slow every overlay
    // sweep (getOverlays / layer-FX hide) for this sprite's lifetime.
    go.once("destroy", () => this._fxObjects.delete(go));
    // An active layer post-FX must reach overlays created AFTER it was set
    // (SpriteRenderer builds its image lazily on the first textured frame).
    // eval.ts registers this hook on scene.data when a layer effect is active.
    const fxHook = this.scene.data.get("peaky.layerFXHook") as
      | ((s: Sprite, g: Phaser.GameObjects.GameObject) => void) | undefined;
    if (fxHook) { try { fxHook(this, go); } catch (e) { console.warn("[Sprite] layerFXHook threw", e); } }
    const uiCam = this.scene.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
    if (!uiCam) return;
    // UI widget on a parallaxed layer (renderOnMainCamera=true): render
    // on main, hide from UI cam so it doesn't double-render.
    if (this.isUIWidget && !this.renderOnMainCamera) {
      this.scene.cameras.main.ignore(go);
    } else {
      uiCam.ignore(go);
    }
  }
  /**
   * Force every visual-overlay behavior on this sprite to re-sync its
   * Phaser GameObject to the host body's current transform. Called from
   * transform-mutating actions (SetScale, SetPosition, SetAngle, etc.)
   * so the visual lands on the SAME frame as the body change — without
   * this, overlays would only catch up on the next tick, producing a
   * one-frame flash at the old transform (most visible on spawn-frame
   * scale-down patterns like "OnCreate → SetScale 0.3").
   */
  resyncOverlays(): void {
    for (const b of this.behaviors) {
      const fn = (b as unknown as { syncOverlay?: () => void }).syncOverlay;
      if (typeof fn === "function") fn.call(b);
    }
  }
  /**
   * Visual squash/stretch multipliers — drive the cartoon-anim "anticipation"
   * scale (wider+shorter or taller+narrower) without mutating the body's
   * physical size. SpriteRenderer multiplies these into its overlay display
   * size each frame; the SquashStretch behavior animates them via a tween
   * chain. 1.0 = no scaling (default). The body GameObject's own scale is
   * also driven from these so plain colored-rect BPs (no SpriteRenderer)
   * still show the effect.
   */
  squashX = 1;
  squashY = 1;
  /**
   * Object-scoped variables — initialized from Blueprint defaults. Values can
   * be number / string / boolean (matching the BP's `VariableDef.type`).
   */
  readonly vars: Map<string, number | string | boolean> = new Map();
  /**
   * Names of this sprite's variables that are GLOBAL — backed by the persistent
   * store, shared across instances + scenes. Populated at spawn from the BP's
   * `VariableDef.global` flags. `writeVar` mirrors writes of these names into
   * `persistentState().globals` so `global:<name>` and `var:<BP>.<name>` agree.
   */
  readonly globalVars: Set<string> = new Set();
  /** Set true after destroy(); tick() bails on subsequent frames. */
  destroyed = false;
  /**
   * `performance.now()` deadline (ms) until which jump-thru collisions are
   * skipped — set by the CMFallThrough action. Lets the player drop through
   * jump-thru platforms briefly. Cleared once the deadline passes. Stored in
   * SCALED sim milliseconds (`simNowMs`) so the window freezes during
   * pause / hitstop instead of expiring on wall-clock time.
   */
  fallingThroughUntil = 0;
  /**
   * Visual mirror factor for the sprite — written by CharacterMovement (and
   * any other mirroring code), read by SpriteRenderer / Camera / SM
   * conditions like `IsFacingLeft`. Sign carries facing (+ = right, − = left);
   * absolute value carries the smooth-mirror tween (0..|natural scale|).
   *
   * Why this exists separately from `gameObject.scaleX`: setting a negative
   * scaleX on the body Rectangle desyncs the arcade physics body from the
   * visual (the body drifts by its own width). Keeping the body at the
   * user's natural absolute scale and storing facing here lets the overlay
   * + camera + conditions all mirror without breaking collisions.
   */
  facingScaleX = 1;

  /** The "blueprint scale" baked from the instance w/h override (art + body are
   *  sized by it, but gameObject.scaleX is NOT). Overlays that fold host scale
   *  (Tracer reach, Shadow) multiply this by |gameObject.scaleX| to get the REAL
   *  effective scale, so a bed shrunk to 0.6 shrinks its tracer too. Default 1. */
  _renderScaleX = 1;
  _renderScaleY = 1;

  /** Active "Move To" command — set by the MoveTo action, applied each tick in
   *  `tick()` (home toward the captured target at constant speed, stop within
   *  stopRadius). Target is SNAPSHOT at fire time (so "Move To mouse.x/y" goes
   *  to the click point, not the live cursor). Cleared on arrival, by MoveStop,
   *  or on load. In-flight movement — intentionally NOT serialized. */
  _moveTo: { tx: number; ty: number; speed: number; stopRadius: number } | null = null;

  /** Active Phaser tweens on this sprite, keyed by user-supplied tag. Each
   *  `Tween` action registers here on start; the entry is auto-removed on
   *  completion (or when stopped). The `prop` is the Phaser-side property
   *  name (e.g. `x`, `scale`) — stored so `TweenSetEndValue` can call
   *  `updateTo(prop, value)` without re-deriving it from Phaser internals
   *  (which expose tween data with shifting type shapes across versions). */
  /** Map key is composite `${tag}|${prop}` so a single sprite can run two
   *  tweens at the same tag — e.g. `Tween(position.x, tag="")` AND
   *  `Tween(alpha, tag="")` coexist instead of overwriting each other.
   *  The `tag` field on each entry preserves the user-facing tag so
   *  tag-only queries (TweenStop, IsTweenPlaying) can filter without
   *  parsing the key. */
  readonly tweens = new Map<string, { tween: Phaser.Tweens.Tween; prop: string; tag: string }>();

  // Set by SetPaused (scope=all or this sprite's layer). When frozen, the
  // physics body stops integrating and active tweens pause so the sprite
  // holds position; both restore on unfreeze. UI widgets are never frozen.
  private _frozenByPause = false;
  private _frozenTweens: Phaser.Tweens.Tween[] = [];
  // Whether the body was standing on ground at the moment it was frozen. On
  // unfreeze we re-assert the ground-contact flags for one tick so the
  // animator doesn't read a transient airborne state (physics hasn't
  // re-established collision yet) and flash a fall frame.
  private _wasGroundedAtFreeze = false;

  private readonly behaviors: Behavior[] = [];
  // Lookup caches rebuilt incrementally in addBehavior. The hot path
  // (eval.ts / LogicSheetRunner.ts / behaviors / Game.ts registerCollisions)
  // calls findBehaviorByKind / hasBehavior thousands of times per frame —
  // a 9.7s profile showed `.some/.find` arrow callbacks accounted for ~38%
  // of CPU time. Map.get / Set.has put both at O(1).
  // Behaviors are never removed mid-life (only on Sprite destroy), so no
  // invalidation logic is needed.
  private readonly _behaviorsByKind = new Map<string, Behavior[]>();
  private readonly _behaviorCtors = new Set<unknown>();
  private events_list: EventSpec[] = [];
  private readonly eventStates = new Map<string, EventState>();
  /** Per-key trigger/edge-detection state for StateMachine condition rows.
   *  The state machine evaluates conditions that can be TRIGGERS (OnLand,
   *  OnKeyPressed, JustWallJumped…) which need per-condition edge state —
   *  the same machinery event sheets use. Keyed by a stable string the
   *  animator supplies per (state, slot, index). */
  private readonly _animCondStates = new Map<string, EventState>();
  /** Mutable per-instance enabled state for each event group, keyed by group id. */
  private readonly eventGroupEnabled = new Map<string, boolean>();
  /** Group id ↔ name lookups so SetEventGroupEnabled can target by either. */
  private readonly eventGroupIdByName = new Map<string, string>();
  private readonly eventGroupNameById = new Map<string, string>();

  /** Seconds elapsed since attachEvents — drives the action queue. */
  private clock = 0;
  /** The scaled sim clock in milliseconds. Advances with `clock` (delta ×
   *  timeScale), so it FREEZES during pause / hitstop and slows in slow-mo —
   *  unlike performance.now(). Use this for any gameplay deadline that must
   *  respect SetTimeScale (e.g. fallingThroughUntil). */
  get simNowMs(): number { return this.clock * 1000; }
  /** Pending actions deferred via `Wait` or `WaitForSignal`. Drained each tick.
      `awaitDeadline` is the wall-clock time after which a stuck-on-signal item
      is dropped (prevents leaks when a signal never fires). */
  private actionQueue: {
    eventId: string;
    action: StateAction;
    runAtSec: number;
    /** Optional wall-clock gate (ms) — set when the chain used `WaitRealtime`.
     *  Item fires only when BOTH `clock >= runAtSec` AND
     *  `scene.game.loop.time >= runAtRealMs`. Lets a SetTimeScale 0 / Wait /
     *  SetTimeScale 1 chain unpause itself: WaitRealtime advances regardless
     *  of timeScale, while the sim clock is frozen. */
    runAtRealMs?: number;
    sourceLabel: string;
    awaitSignal?: string;
    awaitDeadline?: number;
    /** UID of the per-iteration host sprite the action should run on.
     *  Set by ForEach/Pick chains so a queued `Wait → SetVar` lands on
     *  the picked target rather than the source sprite. Undefined means
     *  "run on the source sprite (this)". When the target has been
     *  destroyed by the time the queue drains, the action is dropped. */
    targetUid?: number;
    /** Per-chain id assigned at queue-build time. When one item's target
     *  is destroyed mid-chain, the drainer evicts every remaining item
     *  in the same chain — without this, a partial chain would still
     *  fire `SetColor` after `SetVar` was dropped, leaving inconsistent
     *  state on a sibling target that survived. */
    chainId?: number;
    /** When set, this queue item is a deferred sub-event processing
     *  call — drain runs `processEvents(processChildren)` instead of
     *  dispatching `action`. Lets parent-Wait propagate to sub-events
     *  (Construct-3 parity: a `Wait 1; SubEvent: SetX` defers SetX a
     *  full second instead of firing immediately). */
    processChildren?: EventSpec[];
  }[] = [];

  /** Hard cap on how long WaitForSignal will block (in seconds, sim clock). */
  private static readonly AWAIT_SIGNAL_TIMEOUT_SEC = 30;
  /** Monotonic counter for queued action chains. Bumped per iteration so
   *  every Wait/WaitForSignal-deferred action knows which chain it
   *  belongs to and the drainer can evict siblings together when the
   *  chain's target is destroyed mid-flight. */
  private _chainSeq = 0;

  /** Tracks the previous frame's grounded state for OnLand edge events. */
  private wasOnGround = true;
  /** Tracks the previous frame's "is falling" state — vy > 0.5 while airborne. */
  private wasFalling = false;
  /** Tracks the previous frame's speed-non-zero state for OnMoved/OnStopped edges. */
  private wasMoving = false;

  constructor(scene: Phaser.Scene, shape: SpriteShape) {
    this.scene = scene;
    const w = shape.w ?? 32;
    const h = shape.h ?? 32;
    const color = shape.color ?? 0xffffff;

    // The Rectangle is a host for the physics body; it is NOT a default
    // visual. SpriteRenderer adds its own Image overlay, and BPs without
    // a SpriteRenderer have no visual representation in play (a pure
    // physics body — invisible by design). Keeping the rect alpha=0
    // means a colored `color` field still has somewhere to live for the
    // editor's preview / scene gizmos, which read the project model
    // directly rather than the running scene.
    this.gameObject = scene.add.rectangle(0, 0, w, h, color);
    this.gameObject.setAlpha(0);
    // Conditional body creation. Decoration BPs flag `noPhysicsBody=true`
    // to skip Phaser's ~0.3ms-per-spawn arcade body allocation. Sprite
    // still has position + tags + renders, just no physics integration.
    // Behaviors that need a body (CharacterMovement, MoveTo with physics,
    // Solid, …) are the author's responsibility to NOT attach to no-body
    // BPs — the body access will be undefined and the behavior silently
    // no-ops on the null reference.
    if (!shape.noPhysicsBody) {
      scene.physics.add.existing(this.gameObject);
      // Cast is safe — `add.existing` synchronously assigns gameObject.body.
      (this as { body: Phaser.Physics.Arcade.Body }).body = this.gameObject.body as Phaser.Physics.Arcade.Body;
    }
    // Back-reference so any code holding a raw GameObject (e.g. a Phaser
    // collide processCallback receiving the colliding body's GO) can resolve
    // back to the owning Sprite to read tags / fields.
    this.gameObject.setData("peakySprite", this);

    // Camera BPs are viewport controllers, not entities-in-the-world. Keep
    // the body for registry uniformity (peaky.sprites, picking, save/load)
    // but make it inert so the rectangle stays put — viewport motion comes
    // from Phaser's scene camera, not from this body.
    if (shape.classKind === "Camera" && this.body) {
      this.body.setAllowGravity(false);
      this.body.setImmovable(true);
    }

    // Register in the scene-wide sprite list so picking / ForEach / camera
    // follow / save-load can iterate.
    const list = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    list.push(this);
    scene.data.set("peaky.sprites", list);
    // uid → Sprite index, maintained alongside the list so callers that need a
    // specific sprite by uid (tracer hit resolution, queued-action targets,
    // EmitSignalTo uid) do an O(1) lookup instead of scanning peaky.sprites.
    let byUid = scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined;
    if (!byUid) { byUid = new Map<number, Sprite>(); scene.data.set("peaky.spritesByUid", byUid); }
    byUid.set(this.uid, this);
  }

  at(x: number, y: number): this {
    this.gameObject.setPosition(x, y);
    // No body for decoration BPs (`noPhysicsBody = true`) — gameObject
    // position is the source of truth, body.reset is skipped.
    if (this.body) this.body.reset(x, y);
    return this;
  }

  addBehavior<T extends Behavior>(BehaviorCtor: BehaviorClass<T>, config: Partial<T> = {}): this {
    const b = new BehaviorCtor();
    b.attach(this, config as Record<string, unknown>);
    this.behaviors.push(b);
    const arr = this._behaviorsByKind.get(b.kind);
    if (arr) arr.push(b);
    else this._behaviorsByKind.set(b.kind, [b]);
    this._behaviorCtors.add(BehaviorCtor);
    return this;
  }

  /** The most recently attached behavior (used by runProject to apply enabled). */
  get lastBehavior(): Behavior | undefined {
    return this.behaviors[this.behaviors.length - 1];
  }

  attachEvents(events: EventSpec[], groups: EventGroupSpec[] = []): this {
    this.events_list = events;
    // Walk tree to seed per-event state.
    const seed = (ev: EventSpec) => {
      this.eventStates.set(ev.id, {
        createdFired: false,
        sceneStartFired: false,
        // Anchor first-fire to the current clock so EveryXSeconds waits
        // a full interval before the first emission (C3 semantics). Was
        // -Infinity which fired on tick 1 then again every X seconds.
        everyLastFiredSec: this.clock,
        prevAnimFinished: false,
        inFlightUntil: 0,
        prevTickMatched: false,
        stopLoop: false,
        implicitOnceFired: false,
      });
      for (const c of ev.children) seed(c);
    };
    for (const ev of events) seed(ev);
    for (const g of groups) {
      this.eventGroupEnabled.set(g.id, g.enabled);
      this.eventGroupIdByName.set(g.name, g.id);
      this.eventGroupNameById.set(g.id, g.name);
    }
    return this;
  }

  /**
   * Set an event group's enabled state at runtime. Accepts either a group id
   * or a group name. No-op if the group doesn't exist on this sprite.
   * Returns true if the lookup matched something.
   */
  setEventGroupEnabled(idOrName: string, enabled: boolean): boolean {
    const id = this.eventGroupEnabled.has(idOrName)
      ? idOrName
      : this.eventGroupIdByName.get(idOrName);
    if (!id || !this.eventGroupEnabled.has(id)) return false;
    this.eventGroupEnabled.set(id, enabled);
    return true;
  }

  /** True if the event's group is enabled (or it has no group). Used by tryFire. */
  private isEventGroupActive(ev: EventSpec): boolean {
    if (!ev.groupId) return true;
    const en = this.eventGroupEnabled.get(ev.groupId);
    return en === undefined ? true : en;
  }

  /** Viewport-culling mode authored on the BP. "never" = always full
   *  update (default for legacy / story NPCs). "throttled" = off-screen
   *  ticks once every CULL_THROTTLE_FRAMES (10Hz) — keeps living-world
   *  NPCs walking but at reduced cost. "freeze" = off-screen skipped
   *  entirely (max savings, NPC literally pauses in place). Set by
   *  spawnFromBlueprint from the BP's cullMode field. */
  cullMode: "never" | "throttled" | "freeze" = "never";
  /** Frames between "decision" passes. 1 = decide every frame (default). 6 ≈
   *  10Hz at 60fps. Throttles ONLY the expensive thinking — the StateMachine's
   *  state SELECTION, the Logic Sheet's per-frame OnTick + event eval — while
   *  movement, animation playback and overlay sync keep running every frame, so
   *  motion stays smooth. For big background swarms whose logic only needs to
   *  re-decide a few times a second. Set from the BP's decisionTickRate field. */
  decisionTickRate = 1;
  /** Off-screen "throttled" cull rate, in FRAMES between ticks. Default
   *  CULL_THROTTLE_FRAMES (6 = 10Hz). 2 = 30Hz, 3 = 20Hz. Only used when
   *  cullMode === "throttled". Set from the BP's cullThrottleHz field. */
  cullThrottleFrames = CULL_THROTTLE_FRAMES;
  /** True on frames where decisions run this tick (driven by decisionTickRate,
   *  staggered by uid). CharacterAnimator's state selection + Sprite's event
   *  passes read it; MoveTo / SpriteRenderer ignore it and stay smooth. */
  _decisionFrame = true;
  private _decisionCounter = 0;
  /** When true, this sprite is EXCLUDED from CollisionScan's broad-phase
   *  pair detection. Use for swarm enemies that don't need OnCollide /
   *  OnOverlap events — gameplay damage comes from tracers, Damageable
   *  contact damage, etc. Massive win at scale: 1500 NPCs clustering
   *  in one cell normally produces 1500²/2 pair checks. With this flag,
   *  zero. The sprite STILL has a physics body (for player contact /
   *  wall collision via standard Phaser systems); only the per-tick
   *  overlap scan ignores it. Set by spawnFromBlueprint from BP's
   *  `skipCollisionScan` field. */
  skipCollisionScan = false;
  /** Tag exception list for skipCollisionScan — comma- or space-separated
   *  tags. When skipCollisionScan is true, pairs with sprites carrying
   *  ANY of these tags still get scanned. Lets a swarm enemy opt in to
   *  detecting collisions with the player ("player" in the list) while
   *  still skipping the expensive swarm-vs-swarm broad-phase. Empty =
   *  pure skip (original semantics). */
  collisionScanExceptTags = "";
  /** Distance-gated collision wiring. When > 0, this sprite's per-pair
   *  Phaser colliders are NOT wired at spawn — they get wired the moment
   *  a sprite carrying `collisionWakeTag` is within this many pixels.
   *  Once wired, never unwired. Spawn-time cost: 0. Per-frame cost during
   *  the unwired window: one tag-set scan per WAKE_TICK_FRAMES (~6).
   *  Default 0 = wire immediately at spawn (legacy behavior). */
  collisionWakeRadius = 0;
  /** Tag that triggers the wake check. Default "player". */
  collisionWakeTag = "player";
  /** True from spawn until the wake check fires. While true, the per-tick
   *  wake check runs every WAKE_TICK_FRAMES. Set false the moment the
   *  sprite is within wakeRadius of a wake-tag carrier and pair colliders
   *  get wired. */
  _collisionUnwired = false;
  /** Per-sprite frame stagger for the wake check so 1000 unwired sprites
   *  don't all check on the same frame. Set in runProject from uid. */
  _wakeTickPhase = 0;
  /** True when this sprite is currently sitting inactive in an object
   *  pool. Sprite.tick early-returns when pooled. Set true on destroy
   *  (when BP has poolSize > 0), false on pool-respawn. */
  _pooled = false;
  /** Re-entrancy latch for destroy(). The OnDestroyed chain runs BEFORE
   *  `destroyed` is set and before the pool check, so a chain that destroys
   *  this sprite again (cascade / "OnDestroyed → Destroy") would re-fire
   *  OnDestroyed and double-pool. Reset to false on pool-respawn. */
  _destroying = false;
  /** Component-level LOD groups. Set by runProject from the BP's
   *  lodGroups field. Each group toggles `behavior.enabled` for its
   *  listed component kinds based on proximity to a tag-matched sprite.
   *  Empty array = LOD off, pass skipped. See Sprite._runLodPass. */
  lodGroups: SpriteLODGroup[] = [];
  /** Per-group "currently enabled?" state for hysteresis. Indexed by
   *  group id. First-pass NPCs default to enabled (no entry = true). */
  private _lodState = new Map<string, boolean>();
  /** Per-sprite frame offset for the throttled LOD check. Set in the
   *  spawn path from uid so 1000 NPCs don't all check on the same frame. */
  private _lodTickPhase = 0;
  /** Internal: cached frame counter for the cullMode === "throttled"
   *  10Hz tick. Staggered by uid mod throttleEvery so 5000 throttled
   *  sprites don't all wake on the same frame. */
  private _cullFrame = 0;
  /** Tracks whether this tick the sprite is currently culled ("freeze"
   *  mode + outside ring). Used by Game.ts's per-frame cull loop to STOP
   *  body physics on the freeze transition and restore on un-cull.
   *  Public so Game.ts can read/write — internal to the cull system; do
   *  not touch from gameplay code. */
  _frozenByCull = false;
  /** Internal: one-shot diagnostic latch — first time this sprite culls,
   *  emit a console log so authors can verify the system is wired and
   *  inspect the cull-ring math. Stays true after the first log so the
   *  console doesn't spam at scale. */
  private _cullLogged = false;

  tick(delta: number): void {
    if (this.destroyed) return;
    // Pooled sprites sit inactive in the pool array. They're still in
    // peaky.sprites (so Game.ts's snapshot iterates them), but their
    // gameObject is hidden, body disabled, no behaviors should run.
    // Early-return skips all per-tick work for them.
    if (this._pooled) return;
    // Viewport culling for "freeze" mode is handled at the Game.ts loop
    // level so we don't even pay the function-call overhead per frozen
    // sprite — this method isn't invoked for them. What remains here is
    // ONLY the "throttled" mode path: off-screen sprites run their tick
    // every CULL_THROTTLE_FRAMES instead of every frame. The throttle is
    // staggered by uid so 5K throttled sprites don't all wake on the same
    // frame.
    if (this.cullMode === "throttled" && !this.isUIWidget) {
      const cam = this.scene.cameras?.main;
      if (cam) {
        const mult = (this.scene.data.get("peaky.cullDistanceMultiplier") as number | undefined) ?? 1.5;
        const wv = cam.worldView;
        const halfW = (wv.width * mult) * 0.5;
        const halfH = (wv.height * mult) * 0.5;
        const dx = Math.abs(this.gameObject.x - wv.centerX);
        const dy = Math.abs(this.gameObject.y - wv.centerY);
        if (dx > halfW || dy > halfH) {
          this._cullFrame += 1;
          if (((this._cullFrame + this.uid) % this.cullThrottleFrames) !== 0) return;
        }
      }
    }

    // Component-level LOD pass. Runs at most every LOD_TICK_FRAMES (10Hz)
    // so the per-sprite cost is amortized. Toggles `behavior.enabled` on
    // the listed component kinds — the existing behavior loop already
    // self-gates on `enabled`, so disabled components are free.
    if (this.lodGroups.length > 0) this._runLodPass();

    // Distance-gated collision wiring — periodic wake check while the
    // sprite's per-pair Phaser colliders haven't been registered yet.
    // Once wired, never unwired (no churn). Per-frame cost: one tag-set
    // scan every 6 frames per unwired sprite. Set false once wired.
    if (this._collisionUnwired) this._runWakeCheck();

    // Honor scene-wide time scaling — `SetTimeScale` writes
    // `scene.time.timeScale` (and physics / tweens) so Phaser's built-in
    // systems already slow / pause. Custom behavior code that integrates
    // using `delta` (acceleration ramps, cooldowns, jump-buffer timers,
    // animation elapsedMs in SpriteRenderer, etc.) must see the SAME
    // scaled delta or it desyncs from Phaser's physics — feels glitchy
    // because the body moves at slow speed while the controller code
    // still ramps and counts at full speed. Reading the scale here is
    // the single bottleneck for "everything obeys time scale."
    const scaledDelta = delta * (this.scene.time.timeScale ?? 1);
    this.clock += scaledDelta / 1000;

    // SetPaused freeze — scene-wide (peaky.pauseAll) or this sprite's layer
    // (peaky.pausedLayers). UI widgets are exempt so pause menus keep
    // animating + handling input. On the freeze edge we stop the physics
    // body and pause active tweens so the sprite holds position; on unfreeze
    // we restore both. Distinct from the timeScale=0 pause, which also
    // freezes widgets — this one leaves them live.
    const pauseAll = this.scene.data.get("peaky.pauseAll") === true;
    const pausedLayers = this.scene.data.get("peaky.pausedLayers") as Set<string> | undefined;
    const layerPaused = !this.isUIWidget
      && (pauseAll || (pausedLayers !== undefined && pausedLayers.has(this.layerId)));
    if (layerPaused && !this._frozenByPause) {
      this._frozenByPause = true;
      this._wasGroundedAtFreeze = !!this.body && (this.body.blocked.down || this.body.touching.down);
      if (this.body) this.body.moves = false;
      this._frozenTweens = [];
      for (const e of this.tweens.values()) {
        if (e.tween.isPlaying()) { e.tween.pause(); this._frozenTweens.push(e.tween); }
      }
    } else if (!layerPaused && this._frozenByPause) {
      this._frozenByPause = false;
      if (this.body) {
        this.body.moves = true;
        // Re-assert ground contact for this resume tick so behaviors (the
        // animator especially) don't see a 1-frame airborne+falling state
        // before physics recomputes collisions, which flashed a fall frame.
        if (this._wasGroundedAtFreeze) {
          this.body.blocked.down = true;
          this.body.touching.down = true;
          this.body.velocity.y = 0;
        }
      }
      for (const t of this._frozenTweens) t.resume();
      this._frozenTweens = [];
    }

    // Y-sort: when on a `ySort: true` scene layer, recompute host depth from
    // world Y BEFORE behaviors run so SpriteRenderer's syncOverlay later in
    // this tick picks up the new depth on the visual image (it mirrors
    // host.depth + 1). Pivot 0 = top, 0.5 = center, 1 = bottom ("feet").
    // Phaser Rectangle's `y` is its CENTER, so shift the pivot to a center-
    // relative offset: sort point = body.y + h × (pivot − 0.5). Pivot 1
    // means depth = body bottom — the topdown convention.
    if (this._ySortEnabled) {
      const go = this.gameObject as any;
      const sr = this.findBehaviorByKind("SpriteRenderer");
      const ext = sr ? sr.ySortExtent() : null;
      // Sort point = topY + height × pivot, so pivot maps linearly over the
      // box: 0 = top edge, 1 = bottom edge ("feet"). The overlay extent is
      // preferred so the line tracks the visible sprite; the host rect (center
      // origin) is the fallback when the BP renders as a bare rectangle.
      const topY = ext ? ext.topY : go.y - (go.displayHeight ?? go.height ?? 0) / 2;
      const h = ext ? ext.height : ((go.displayHeight ?? go.height ?? 0) as number);
      // Direction-mirrored pivot: track vertical movement by position delta
      // (works for physics AND direct movement); latch the last direction while
      // idle so stopping doesn't flicker the depth.
      let pivot = this._ySortPivotY;
      if (this._ySortFlipByDir) {
        const dy = Number.isNaN(this._ySortPrevY) ? 0 : go.y - this._ySortPrevY;
        this._ySortPrevY = go.y;
        if (dy > 0.05) this._ySortDirDown = true;
        else if (dy < -0.05) this._ySortDirDown = false;
        if (this._ySortDirDown) pivot = 1 - pivot;
      }
      const newDepth = this._ySortBaseDepth + topY + h * pivot;
      this.gameObject.setDepth(newDepth);
      // Also push the depth onto any SpriteRenderer / Text overlay NOW so the
      // visual catches up THIS frame. Without this, syncOverlay only runs once
      // per tick and the overlay is one frame stale — for a player walking
      // past a tilemap row, one stale frame causes the wrong sort visibly.
      for (const b of this.behaviors) {
        const ov = (b as any).overlay;
        if (ov && typeof ov.setDepth === "function") {
          ov.setDepth(newDepth + 1);
        }
      }
    }

    // Decision throttle — decide whether the EXPENSIVE thinking runs this frame
    // (StateMachine selection + Logic Sheet OnTick/event eval). Staggered by uid
    // so a swarm's decision frames spread across the throttle window instead of
    // all landing together. Movement / animation / overlay sync below ignore
    // this and run every frame, so a throttled NPC still moves smoothly.
    this._decisionFrame = this.decisionTickRate <= 1
      || (((this._decisionCounter++) + this.uid) % this.decisionTickRate) === 0;

    // 1. Behaviors set velocity, emit OnJump on jump frames, etc.
    //
    // When the scene is paused (timeScale === 0 → scaledDelta === 0), skip
    // gameplay behaviors so they don't read input edges and replay them
    // when the scene resumes. CharacterMovement was the worst offender:
    // a `Jump` press during pause armed the input buffer (or set Y
    // velocity directly), then unpause → instant jump. UI behaviors
    // (UIWidgetRenderer) opt back in via `tickDuringPause = true` so
    // pause menus stay interactive.
    //
    // Events keep firing below — that's how `OnPress[Q] → SetTimeScale 1`
    // can still unpause the world while behaviors are frozen.
    const paused = scaledDelta === 0 || layerPaused;
    for (const b of this.behaviors) {
      if (!b.enabled) continue;
      if (paused && !b.tickDuringPause) continue;
      b.update(scaledDelta);
      // A behavior's update may destroy the sprite (e.g. Projectile's
      // destroyOnHit). Bail immediately — otherwise a LATER behavior in this
      // same loop (SpriteRenderer / Text) runs its update and lazily RE-CREATES
      // the overlay that destroy()'s onDestroy just tore down, leaving a ghost
      // image on screen after the host is gone.
      if (this.destroyed) return;
    }
    if (this.destroyed) return;
    // Self-sustaining MoveTo: home toward the snapshotted target at constant
    // speed each tick, then stop + emit OnArrived once within stopRadius. The
    // target was captured at fire time, so this never coasts past / drifts to
    // the screen edge the way a one-shot velocity-set did. Frozen while paused.
    if (this._moveTo && !paused && this.body) {
      const m = this._moveTo;
      const gx = this.gameObject.x, gy = this.gameObject.y;
      const dx = m.tx - gx, dy = m.ty - gy;
      const dist = Math.hypot(dx, dy);
      if (dist <= m.stopRadius || dist < 0.0001) {
        this.body.setVelocity(0, 0);
        this._moveTo = null;
        this.events.emit("OnArrived");
      } else {
        this.body.setVelocity((dx / dist) * m.speed, (dy / dist) * m.speed);
      }
    }
    // Per-tick fanout for LogicSheet's `OnTick` trigger. Emitted AFTER
    // behaviors update so listeners observe this frame's fresh state
    // (position, velocity, animator state, etc.) instead of last frame's.
    // Skipped during pause — gameplay tick triggers shouldn't fire while
    // the world is frozen, mirroring `b.update` gating above. Also gated by
    // the decision throttle so OnTick logic on a throttled swarm fires at the
    // reduced rate, not 60Hz.
    if (!paused && this._decisionFrame) this.events.emit("_tick");

    // Squash/stretch is applied EXCLUSIVELY through the SpriteRenderer
    // overlay (see SpriteRenderer.applyFrame). We deliberately do NOT
    // scale the body Rectangle here — Phaser's Arcade physics body picks
    // up the GameObject's scale, so squashing would shrink the collider
    // and the sprite would clip through floors. The body stays
    // axis-aligned and constant-size; only the visual wobbles.

    // OnLand / OnFall edge detection — built-in so any sprite gets these
    // events without needing a specific jump component.
    //   • OnLand fires the frame the sprite touches ground after being airborne.
    //   • OnFall fires the frame downward velocity starts (vy > 0.5 while
    //     airborne and was not already falling). This covers BOTH cases:
    //       - walking off a ledge (vy starts increasing from 0)
    //       - jump apex (vy crosses from negative to positive)
    //     Previous logic only caught the first case.
    // Skip while frozen by pause — the body's collision flags / velocity are
    // stale, so processing edges here would corrupt `wasOnGround`/`wasFalling`
    // and fire a spurious OnLand / OnFall on resume.
    if (!paused && this.body) {
      const onGround = this.body.blocked.down || this.body.touching.down;
      const isFalling = !onGround && this.body.velocity.y > 0.5;

      if (onGround && !this.wasOnGround) {
        this.events.emit("OnLand");
      }
      if (isFalling && !this.wasFalling) {
        this.events.emit("OnFall");
      }
      // OnMoved / OnStopped — speed-based edges, work for any sprite (not
      // just CharacterMovement) so non-platformer objects get them too.
      const speed = Math.abs(this.body.velocity.x) + Math.abs(this.body.velocity.y);
      const moving = speed > 0.5;
      if (moving && !this.wasMoving) this.events.emit("OnMoved");
      if (!moving && this.wasMoving) this.events.emit("OnStopped");
      this.wasMoving = moving;
      this.wasOnGround = onGround;
      this.wasFalling = isFalling;
    }

    // 2. Drain queued actions whose Wait has elapsed BEFORE matching this frame's
    //    triggers, so a chain finishes its tail before any fresh trigger fires.
    //    We drain every tick — including during pause (timeScale 0).
    //    Sim-clock-gated items naturally hold during pause because
    //    `this.clock` is frozen, so their `runAtSec` gate never trips.
    //    Items downstream of `WaitRealtime` carry a wall-clock `runAtRealMs`
    //    gate (advanced via `scene.game.loop.time`) which keeps ticking
    //    during pause — that's what lets a chain like
    //      SetTimeScale 0 → WaitRealtime 0.2 → SetTimeScale 1
    //    unpause itself.
    this.drainQueue();
    if (this.destroyed) return;

    // 3. Walk the event tree (Construct-3 semantics). Gated by the decision
    //    throttle — a throttled swarm re-evaluates its conditions at the
    //    reduced rate, not every frame.
    if (this._decisionFrame) this.processEvents(this.events_list);

    // 4. Drop unconsumed signals so they don't leak into next frame.
    //    Skip when this sprite shares its bus (multi-mode UI children) —
    //    only the bus owner (the parent) should rotate the frame buffers.
    if (this.ownsEventBus) this.events.flush();
  }

  /**
   * Recursively process a list of sibling events. Tracks the previous
   * sibling's fire state so `else` events can chain off it.
   */
  /**
   * @param isTopLevel true when called from `tick()` (drives plural-SOL
   *   reset between sibling top-level events). Sub-event recursion passes
   *   false so children inherit the parent chain's pickedSets.
   */
  private processEvents(events: EventSpec[], isTopLevel: boolean = true): void {
    let prevFired = false;
    for (const ev of events) {
      if (this.destroyed) return;

      // Comments are no-ops and don't affect else chaining.
      if (ev.kind === "comment") continue;

      // Plural SOL reset: each TOP-LEVEL event starts with a fresh
      // pickedSets map so sibling events don't share filters. Sub-event
      // chains skip this reset and inherit the parent's pick set —
      // matching Construct's "sub-events run within the parent's SOL"
      // semantics.
      if (isTopLevel) {
        this.scene.data.set("peaky.pickedSets", new Map<string, Sprite[]>());
      }

      // Group: a folder container. Skip the group itself but recurse into
      // its children (so they run as if inlined). When the group is
      // disabled OR its eventGroup is disabled, the whole subtree is
      // skipped — like collapsing an entire bundle of logic.
      if (ev.kind === "group") {
        if (ev.disabled || !this.isEventGroupActive(ev)) {
          // Disabled group: treat as "didn't match" so a following Else
          // sibling reads prevFired=false and runs.
          prevFired = false;
          continue;
        }
        // Group children are conceptually inlined siblings — pass the
        // current isTopLevel through (top-level group → top-level kids).
        this.processEvents(ev.children, isTopLevel);
        // Propagate the LAST direct child's prevTickMatched so an Else
        // following the group can chain off the group's tail event.
        // Without this, a group would always reset prevFired to false
        // and any Else after `Group { … last:If A }` would run even
        // when A's conditions matched — surprising authors who expect
        // C3-style "the previous event fired, so my Else doesn't".
        const lastChild = ev.children[ev.children.length - 1];
        if (lastChild) {
          const st = this.eventStates.get(lastChild.id);
          prevFired = st ? st.prevTickMatched : false;
        } else {
          prevFired = false;
        }
        continue;
      }

      // Disabled (manual or via group) → treat as "didn't match" for else chains.
      if (ev.disabled || !this.isEventGroupActive(ev)) {
        prevFired = false;
        continue;
      }

      this.tryFire(ev, prevFired);
      // Else pairs with the previous sibling's CONDITION MATCH (whether the
      // underlying conditions evaluated true), NOT whether the event actually
      // fired. This matters because triggers like TriggerOnceWhileTrue
      // suppress firing on later ticks even though the conditions still hold —
      // an Else after them shouldn't kick in just because the trigger
      // suppressed re-fire.
      const st = this.eventStates.get(ev.id);
      prevFired = st ? st.prevTickMatched : false;
    }
  }

  /**
   * Evaluate one event node. If it fires, run its actions and recurse into
   * children. Returns true iff this event fired this tick.
   */
  private tryFire(ev: EventSpec, prevSiblingFired: boolean): boolean {
    const state = this.eventStates.get(ev.id);
    if (!state) return false;

    // Suppress while a previous chain on this event is still pending Waits.
    if (this.clock < state.inFlightUntil) return false;

    // Evaluate every condition. Triggers consume one-shot events; state
    // checks are continuous queries. Combine via `combinator` (AND/OR).
    // The "Else" condition reads `prevSiblingFired` from the caller.
    const matched = this.evaluateConditions(ev, state, prevSiblingFired);
    // NOTE: prevTickMatched is now updated inside evaluateConditions itself
    // so it reflects the INNER condition state (pre-trigger-once edge logic).
    if (!matched) return false;

    // Implicit one-shot for "loop/pick without trigger" events. Repeat alone
    // would otherwise fire every frame (Repeat is always-true) — this is
    // confusing since users expect "Repeat 4 times → spawn 4" to mean "do
    // it once at start, four times". If the event has any explicit trigger
    // condition we don't apply the gate (the trigger paces re-firing).
    const hasExplicitTrigger = ev.conditions.some((c) => isTriggerCondition(c.kind));
    const hasLoopOrPick = ev.conditions.some((c) =>
      c.kind === "Repeat" || c.kind === "While" || c.kind === "ForEach" ||
      c.kind === "PickAll" || c.kind === "PickRandom" || c.kind === "PickByHighest" ||
      c.kind === "PickByLowest" || c.kind === "PickNth" || c.kind === "PickByComparison"
    );
    if (!hasExplicitTrigger && hasLoopOrPick) {
      if (state.implicitOnceFired) return false;
      state.implicitOnceFired = true;
    }

    // Loop count from any Repeat conditions on this event. Multiple Repeats
    // multiply (Repeat 3 + Repeat 2 = 6 iterations). 0 → actions skipped.
    let iterations = 1;
    let isWhile = false;
    let whileMaxIters = 10000; // hard cap so an always-true While doesn't lock the tab
    for (const c of ev.conditions) {
      if (c.kind === "Repeat") {
        const n = Math.max(0, Math.floor(typeof c.count === "number" ? c.count : 1));
        iterations *= n;
      } else if (c.kind === "While") {
        isWhile = true;
      }
    }

    // ForEach: pool of sprites the actions iterate over (each sub-pick set
    // also gets one iteration per sprite). When multiple Pick/ForEach
    // conditions are present we union them — typical use is one ForEach.
    // Set-based dedup is O(N), down from O(N²) with .includes — important
    // at 5000-sprite picks. (audit HIGH #60, LOW #104)
    const pickedSet = new Set<Sprite>();
    let hasPick = false;
    for (const c of ev.conditions) {
      if (c.kind === "ForEach" || c.kind === "PickAll" || c.kind === "PickRandom" ||
          c.kind === "PickByHighest" || c.kind === "PickByLowest" || c.kind === "PickNth" ||
          c.kind === "PickByComparison") {
        hasPick = true;
        const set = resolvePickSet(this, c);
        for (const s of set) pickedSet.add(s);
      }
    }
    const pickedTargets: Sprite[] = hasPick ? [...pickedSet] : [];
    // If no pick set was resolved, default to running on `this` once per iter.
    const targets: (Sprite | null)[] = pickedTargets.length > 0 ? pickedTargets : [null];
    if (pickedTargets.length > 0) iterations *= pickedTargets.length;

    state.stopLoop = false;

    let when = this.clock;
    // Real-wall-clock accumulator (ms). Advanced by `WaitRealtime` actions
    // (which are unaffected by `scene.time.timeScale`). Queue items carry
    // this as `runAtRealMs` so drainQueue gates on real time independently
    // of the sim clock.
    const realStartMs = this.scene.game.loop.time;
    let whenRealMs = realStartMs;
    let waitForSignalName: string | null = null;
    const runOneIteration = (target: Sprite | null) => {
      // One chainId per iteration so dropping a partial chain (target
      // destroyed mid-Wait) evicts ONLY this iteration's tail, not
      // unrelated tails on other targets in the same ForEach pass.
      const chainId = ++this._chainSeq;
      for (const action of ev.actions) {
        if (state.stopLoop) return;
        if (action.kind === "Wait") {
          const sec = Number(action.config.seconds);
          if (Number.isFinite(sec) && sec > 0) when += sec;
          continue;
        }
        if (action.kind === "WaitRealtime") {
          const sec = Number(action.config.seconds);
          if (Number.isFinite(sec) && sec > 0) whenRealMs += sec * 1000;
          continue;
        }
        if (action.kind === "WaitForSignal") {
          // Defer the rest of the chain until the named signal fires on
          // this sprite. Subsequent actions get queued with a sentinel
          // runAtSec=Infinity and the awaited signal name; drainQueue
          // releases them when the signal fires.
          waitForSignalName = String(action.config.name ?? "").trim() || null;
          continue;
        }
        if (action.kind === "StopLoop") {
          state.stopLoop = true;
          return;
        }
        const host = target ?? this;
        // Store the iteration target's uid so the queue can dispatch the
        // action onto the right sprite when the Wait/WaitForSignal expires.
        // When `target` is null (no ForEach/Pick), leave undefined →
        // drainQueue defaults to the source sprite.
        const targetUid = target ? target.uid : undefined;
        // Real-time gate is "elapsed" when the accumulator hasn't advanced
        // past where the chain started — only items downstream of a
        // WaitRealtime carry a future runAtRealMs.
        const realGateActive = whenRealMs > realStartMs + 1e-3;
        const realElapsedNow = whenRealMs <= this.scene.game.loop.time + 1e-3;
        if (waitForSignalName) {
          this.actionQueue.push({
            eventId: ev.id, action, runAtSec: Infinity,
            runAtRealMs: realGateActive ? whenRealMs : undefined,
            sourceLabel: ev.id, awaitSignal: waitForSignalName,
            awaitDeadline: this.clock + Sprite.AWAIT_SIGNAL_TIMEOUT_SEC,
            targetUid, chainId,
          });
        } else if (when <= this.clock + 1e-6 && realElapsedNow) {
          runAction(host, action);
          if (host.destroyed) return;
        } else {
          this.actionQueue.push({
            eventId: ev.id, action, runAtSec: when,
            runAtRealMs: realGateActive ? whenRealMs : undefined,
            sourceLabel: ev.id,
            targetUid, chainId,
          });
        }
      }
    };

    if (isWhile) {
      // Re-evaluate non-meta conditions each pass; cap to avoid infinite loops.
      let safety = 0;
      while (this.evaluateConditions(ev, state, prevSiblingFired) && safety < whileMaxIters) {
        runOneIteration(null);
        if (state.stopLoop || this.destroyed) break;
        safety++;
      }
      if (safety >= whileMaxIters) console.warn("[Peaky] While loop hit safety cap (10000 iterations)");
    } else {
      for (let iter = 0; iter < iterations; iter++) {
        if (state.stopLoop || this.destroyed) break;
        const target = targets[iter % targets.length];
        runOneIteration(target);
      }
    }
    if (when > this.clock) state.inFlightUntil = when;

    // Sub-events run after the parent's actions. If the parent had any
    // Wait that pushed `when` past the current clock, defer sub-event
    // processing to that time (C3 parity — without this, a parent's
    // `Wait 1; SubEvent: SetX` fires the sub-event's SetX immediately).
    // Empty or zero-Wait parents process sub-events synchronously.
    if (ev.children.length > 0) {
      const childRealGateActive = whenRealMs > realStartMs + 1e-3;
      const simGateActive = when > this.clock + 1e-6;
      if (simGateActive || childRealGateActive) {
        this.actionQueue.push({
          eventId: ev.id,
          // dummy action — drainQueue uses `processChildren` instead
          action: { id: "", kind: "Wait", config: {} },
          runAtSec: when,
          runAtRealMs: childRealGateActive ? whenRealMs : undefined,
          sourceLabel: ev.id,
          processChildren: ev.children,
        });
      } else {
        // Sub-event recursion: false means inherit parent's pickedSets.
        this.processEvents(ev.children, false);
      }
    }

    return true;
  }

  /**
   * Evaluate every condition on an event and combine via the event's
   * `combinator` (AND default, OR if set). Triggers consume one-shot signals;
   * state checks are queries. The `Else` condition reads `prevSiblingFired`.
   */
  private evaluateConditions(ev: EventSpec, state: EventState, prevSiblingFired: boolean): boolean {
    const conds = ev.conditions;
    if (conds.length === 0) {
      // No conditions = always. Useful for "do this every frame" events.
      return true;
    }

    // TriggerOnceWhileTrue is meta — pull it aside to handle separately.
    let onceWhileTrue: Condition | null = null;
    const others: Condition[] = [];
    for (const c of conds) {
      if (c.kind === "TriggerOnceWhileTrue") onceWhileTrue = c;
      else others.push(c);
    }

    const combinator = ev.combinator ?? "AND";
    let matched: boolean;
    if (others.length === 0) {
      matched = true;
    } else if (combinator === "OR") {
      // Evaluate ALL conditions every tick — no short-circuit. Trigger
      // conditions (OnKeyReleased, OnMouseButton*, OnAnimationEnd, etc.)
      // mutate per-frame state inside `evalOneCondition` (justReleased's
      // heldLast map, scene.data mousePrev, prevAnimFinished). If we break
      // early, those mutations skip and the trigger misses its edge next
      // tick — visible bug: the second key in `OnKeyReleased Left | Right`
      // would intermittently miss its release.
      matched = false;
      for (const c of others) {
        if (this.evalOneCondition(c, state, prevSiblingFired)) matched = true;
      }
    } else {
      // AND — same reasoning. A false state check earlier in the list would
      // skip a trigger condition later, stranding its edge state stale.
      matched = true;
      for (const c of others) {
        if (!this.evalOneCondition(c, state, prevSiblingFired)) matched = false;
      }
    }

    // Track whether the inner non-meta conditions are matching THIS tick.
    // Stored so TriggerOnceWhileTrue can detect the rising edge on the
    // *inner* match state, not on the event's final fire state. (If we
    // tracked the fire flag, the trigger-once would oscillate every frame.)
    const wasInnerMatching = state.prevTickMatched;
    state.prevTickMatched = matched;

    if (onceWhileTrue) {
      const inverted = !!onceWhileTrue.not;
      const edgeFired = matched && !wasInnerMatching;
      return inverted ? !edgeFired : edgeFired;
    }
    return matched;
  }

  /**
   * Evaluate one condition (trigger, state check, or Else) and apply `not`.
   * Triggers consume their one-shot signal; state checks are pure queries;
   * Else reads the immediately-preceding sibling's fire state.
   *
   * Subject redirect for triggers: when a trigger condition has
   * `subject: bp:<id>` (or uiwidget), the per-sprite trigger events live
   * on the matching live instance's bus, not on `this`. We iterate live
   * instances of the subject BP and check each one's bus; first match
   * wins and binds `peaky.picked` to that instance so downstream actions
   * in the same chain target it. Construct's "Object → On collision"
   * pattern from the Main Sheet — the trigger fires when ANY <subject>
   * instance gets the event.
   */
  private evalOneCondition(c: Condition, state: EventState, prevSiblingFired: boolean): boolean {
    let raw: boolean;
    if (c.kind === "Else") {
      raw = !prevSiblingFired;
    } else if (isTriggerCondition(c.kind)) {
      const subjectKind = c.subject?.kind;
      const subjectBpId = c.subject?.bpId;
      if ((subjectKind === "bp" || subjectKind === "uiwidget") && subjectBpId && this.blueprintId !== subjectBpId) {
        // Plural SOL: iterate live instances of the subject BP, check
        // each one's trigger; collect ALL matches into pickedSets[bpId].
        // Subsequent actions in the chain fan out across the matched set.
        const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        const matched: Sprite[] = [];
        // For collide / overlap triggers the COLLIDE PARTNER (the OTHER
        // sprite that hit us) is also relevant — collect it per-listener
        // so pickedSets[partner.bpId] can be set for the partner BP.
        // Without this, `OnCollide subject:Player target:Coin → Destroy(Coin)`
        // falls back to "all live Coins" because no Coin is picked.
        const partners = this.scene.data.get("peaky.collidePartners") as Map<number, Sprite> | undefined;
        const partnerByBp: Map<string, Sprite[]> = new Map();
        for (const target of all) {
          if (target.destroyed || target.blueprintId !== subjectBpId) continue;
          if (target.evalTrigger(c, state)) {
            matched.push(target);
            // Capture this listener's collide partner if recent.
            const p = partners?.get(target.uid);
            if (p && !p.destroyed && p.blueprintId) {
              let arr = partnerByBp.get(p.blueprintId);
              if (!arr) { arr = []; partnerByBp.set(p.blueprintId, arr); }
              if (!arr.includes(p)) arr.push(p);
            }
          }
        }
        const sets = (this.scene.data.get("peaky.pickedSets") as Map<string, Sprite[]> | undefined) ?? new Map<string, Sprite[]>();
        sets.set(subjectBpId, matched);
        // Also seed pickedSets for each captured partner BP. This is
        // what makes `Destroy(Coin)` fan out only to the Coin that
        // actually collided.
        for (const [bpId, partnerArr] of partnerByBp) sets.set(bpId, partnerArr);
        this.scene.data.set("peaky.pickedSets", sets);
        if (matched.length === 1) this.scene.data.set("peaky.picked", matched[0]);
        raw = matched.length > 0;
      } else {
        raw = this.evalTrigger(c, state);
      }
    } else {
      raw = evaluateCondition(this, c);
    }
    // `Always` / `OnStep` are state checks that should never be inverted —
    // NOT-Always = Never, which is useless. Other conditions honor `not`.
    if (c.not && c.kind !== "Always" && c.kind !== "OnStep") return !raw;
    return raw;
  }

  /**
   * Evaluate a single Logic Sheet condition for the StateMachine. Unlike
   * the bare `evaluateCondition` (which only handles CONTINUOUS state
   * checks and returns false for triggers), this routes through the full
   * `evalOneCondition` path so TRIGGER kinds (OnLand, OnKeyPressed,
   * JustWallJumped, OnSignal, OnAnimationEnd…) fire correctly with proper
   * per-frame edge detection. `key` must be stable per (state, slot, index)
   * so edge state (OnCreate/OnAnimationEnd/EveryXSeconds) persists across
   * frames. Used by CharacterAnimator's state condition evaluation.
   */
  evalAnimCondition(c: Condition, key: string): boolean {
    let st = this._animCondStates.get(key);
    if (!st) {
      st = {
        createdFired: false,
        sceneStartFired: false,
        everyLastFiredSec: this.clock,
        prevAnimFinished: false,
        inFlightUntil: 0,
        prevTickMatched: false,
        stopLoop: false,
        implicitOnceFired: false,
      };
      this._animCondStates.set(key, st);
    }
    return this.evalOneCondition(c, st, false);
  }

  /**
   * Match a trigger condition against the current frame. Mutates `state` for
   * edge-detect kinds (OnCreate, OnAnimationEnd). Multi-payload triggers
   * (keys, tags, signals) OR-match across the array; empty arrays never fire.
   */
  private evalTrigger(c: Condition, state: EventState): boolean {
    switch (c.kind) {
      case "OnCreate":
        if (state.createdFired) return false;
        state.createdFired = true;
        return true;
      case "OnDestroyed":
        // OnDestroyed fires via the dedicated `_fireOnDestroyedEvents`
        // call inside `destroy()` — it should NEVER match during normal
        // tick processing. Returning false here is the safety guard.
        return false;
      case "OnSceneStart":
        // Truly scene-level: runProject.ts emits `_sceneStart` on every
        // sprite alive at scene start. Sprites spawned later don't get the
        // event, so they won't fire OnSceneStart — matching Construct's
        // "On start of layout" semantics.
        if (state.sceneStartFired) return false;
        if (this.events.firedThisFrame("_sceneStart")) {
          state.sceneStartFired = true;
          return true;
        }
        return false;
      case "EveryXSeconds": {
        const interval = typeof c.seconds === "number" && c.seconds > 0 ? c.seconds : 1;
        // First fire waits a full interval (C3 semantics — was -Infinity
        // before, which fired on tick 1). Normalize stale -Infinity state
        // (from a stale module in HMR) by treating the first eval as
        // the anchor: pin everyLastFiredSec to the current clock and
        // skip this tick. The NEXT interval-elapsed check fires normally.
        const last = state.everyLastFiredSec;
        if (!Number.isFinite(last) || last < 0) {
          state.everyLastFiredSec = this.clock;
          return false;
        }
        if (this.clock - last >= interval) {
          // Advance by the interval (not to current clock) so dropped
          // frames don't accumulate slip — long stalls fire bursts that
          // catch up rather than silently losing ticks.
          state.everyLastFiredSec = last + interval;
          return true;
        }
        return false;
      }
      case "OnTileDestroyed":
        if (state.prevTickMatched) {
          return this.events.firedExactlyThisFrame("_tileDestroyed");
        }
        return this.events.firedThisFrame("_tileDestroyed");
      case "OnTileDamaged":
        if (state.prevTickMatched) {
          return this.events.firedExactlyThisFrame("_tileDamaged");
        }
        return this.events.firedThisFrame("_tileDamaged");
      case "OnSceneEnd":
        // Same dedup pattern as OnSignal:
        // • If matched last frame, use firedExactlyThisFrame so the
        //   carryover doesn't re-fire on frame N+1.
        // • If didn't match last frame, use firedThisFrame so a
        //   frame-late emit (emitter ticked after listener) still
        //   catches via firedPrev. Net: exactly one fire per emit.
        if (state.prevTickMatched) {
          return this.events.firedExactlyThisFrame("_sceneEnd");
        }
        return this.events.firedThisFrame("_sceneEnd");
      case "OnSaveLoadComplete":
        // Same dedup pattern as OnSignal — fire exactly once per
        // SaveSlot/LoadSlot emit regardless of tick order.
        if (state.prevTickMatched) {
          return this.events.firedExactlyThisFrame("_saveLoadComplete");
        }
        return this.events.firedThisFrame("_saveLoadComplete");
      // Loading-system triggers — fired by the editor's ScenePanel
      // loader orchestration. Same dedup pattern as OnSignal so a
      // signal lingering in firedPrev doesn't double-fire.
      case "OnLoadStart":
        if (state.prevTickMatched) return this.events.firedExactlyThisFrame("_loadStart");
        return this.events.firedThisFrame("_loadStart");
      case "OnLoadProgress":
        // Loader emits this every progress tick (typically many per second).
        // We DON'T dedup this one — author wants every tick to update the
        // progress bar smoothly.
        return this.events.firedExactlyThisFrame("_loadProgress");
      case "OnLoadComplete":
        if (state.prevTickMatched) return this.events.firedExactlyThisFrame("_loadComplete");
        return this.events.firedThisFrame("_loadComplete");
      case "OnCameraPanEnd":
        // Same dedup pattern: scene fires PAN_COMPLETE once, runProject
        // fans it out to every alive sprite as `_cameraPanEnd`.
        if (state.prevTickMatched) {
          return this.events.firedExactlyThisFrame("_cameraPanEnd");
        }
        return this.events.firedThisFrame("_cameraPanEnd");
      case "OnMouseButtonPressed": {
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        // Phaser fires `pointerdown` once. We approximate "just pressed" by
        // checking if isDown changed this frame via state on the pointer.
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        stateMap.set(btn, downNow);
        this.scene.data.set("peaky.mousePrev", stateMap);
        return downNow && !wasDown;
      }
      case "OnMouseButtonReleased": {
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        stateMap.set(btn, downNow);
        this.scene.data.set("peaky.mousePrev", stateMap);
        return !downNow && wasDown;
      }
      case "OnMouseWheel": {
        // Phaser stores the latest wheel deltaY on the active pointer's
        // `deltaY` field. We track the per-frame delta via a scene-data
        // value updated in a wheel listener (registered once at scene
        // init in runProject). Empty / zero between frames.
        const dir = c.wheelDir ?? "any";
        const delta = (this.scene.data.get("peaky.wheelDeltaY") as number | undefined) ?? 0;
        if (delta === 0) return false;
        if (dir === "up") return delta < 0;
        if (dir === "down") return delta > 0;
        return true;
      }
      case "OnObjectClicked": {
        // Edge-trigger: the frame the configured mouse button transitions
        // 0→1 AND the cursor is over a sprite. Matching modes (Construct's
        // per-object click semantics):
        //   • `targetBpId` set → match sprites whose blueprintId === id.
        //   • `tags[]` non-empty → match sprites carrying any of those tags.
        //   • Both set → intersection (BP AND tag must match).
        //   • Neither set → ANY sprite under the cursor.
        const tags = c.tags ?? [];
        const targetBpId = c.targetBpId;
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        const edge = downNow && !wasDown;
        if (!edge) return false;
        const cam = this.scene.cameras.main;
        const wx = ptr.worldX ?? (ptr.x + cam.scrollX);
        const wy = ptr.worldY ?? (ptr.y + cam.scrollY);
        const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        for (const s of all) {
          // Pooled sprites are not `destroyed` and keep a (disabled) body at
          // their stale death position — without this they'd match clicks.
          if (s.destroyed || s._pooled || !s.body) continue;
          if (targetBpId && s.blueprintId !== targetBpId) continue;
          if (tags.length > 0 && !tags.some((t) => t && s.tags.has(t))) continue;
          const b = s.body;
          if (wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom) {
            // Picking: stash the hit sprite so subsequent actions in the
            // chain can address it via picked.* expressions (picked.uid,
            // picked.name, picked.<varName>) — including feeding into
            // SetVarOn / EmitSignalTo via uid="picked.uid".
            this.scene.data.set("peaky.picked", s);
            return true;
          }
        }
        return false;
      }
      case "OnKeyPressed": {
        const ia = getInputActions(this.scene);
        if (!ia || !c.actions || c.actions.length === 0) return false;
        return c.actions.some((a) => ia.justPressed(a));
      }
      case "OnKeyReleased": {
        const ia = getInputActions(this.scene);
        if (!ia || !c.actions || c.actions.length === 0) return false;
        return c.actions.some((a) => ia.justReleased(a));
      }
      case "InputCombo": {
        const ia = getInputActions(this.scene);
        const rows = c.comboKeys ?? [];
        if (!ia || rows.length === 0) return false;
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
      case "OnCollide": {
        // Two match modes (Construct's per-object collision parity):
        //   • By tag → `_collide:<tag>` events emitted from runProject's
        //     tag-paired colliders.
        //   • By targetBpId → `_collide:bp:<bpId>` events emitted from
        //     the bpId-paired colliders.
        // Edge-only: the EventBus has 1-frame carry-over, so a signal
        // emitted on frame N is still visible to `firedThisFrame()` on
        // frame N+1 (so signals emitted "between" event ticks aren't
        // missed). For collide / overlap we don't want N+1 to re-match,
        // because Phaser already gates emit-on-contact via the per-pair
        // frame tracker in runProject — the only time an N+1 match would
        // happen is the carry-over. Use `firedExactlyThisFrame` once the
        // event matched last tick to require a fresh emit.
        const checkSig = (sig: string) => state.prevTickMatched
          ? this.events.firedExactlyThisFrame(sig)
          : this.events.firedThisFrame(sig);
        const byTag = (c.tags ?? []).some((t) => t && checkSig(`_collide:${t}`));
        if (byTag) return true;
        if (c.targetBpId && checkSig(`_collide:bp:${c.targetBpId}`)) return true;
        return false;
      }
      case "OnOverlap": {
        const checkSig = (sig: string) => state.prevTickMatched
          ? this.events.firedExactlyThisFrame(sig)
          : this.events.firedThisFrame(sig);
        const byTag = (c.tags ?? []).some((t) => t && checkSig(`_overlap:${t}`));
        if (byTag) return true;
        if (c.targetBpId && checkSig(`_overlap:bp:${c.targetBpId}`)) return true;
        return false;
      }
      // Motion-edge triggers. firedExactlyThisFrame intentionally — the
      // EventBus carryover would otherwise fire each of these TWICE for
      // a single emit (once when it lands in `fired`, again next frame
      // when it's in `firedPrev`). Without this dedup, jump SFX double-
      // triggered, OnLand fired its action chain twice, etc.
      // (audit HIGH #62, #63, #64, #65, #66)
      case "OnLand":
        return this.events.firedExactlyThisFrame("OnLand");
      case "OnJump":
        return this.events.firedExactlyThisFrame("OnJump");
      case "OnFall":
        return this.events.firedExactlyThisFrame("OnFall");
      case "OnDashStart":
        return this.events.firedExactlyThisFrame("OnDashStart");
      case "OnDashEnd":
        return this.events.firedExactlyThisFrame("OnDashEnd");
      case "OnMoved":
        return this.events.firedExactlyThisFrame("OnMoved");
      case "OnStopped":
        return this.events.firedExactlyThisFrame("OnStopped");
      case "HasSpriteObjectTag": {
        // Continuous — true when any placement of the chosen sprite is
        // currently carrying the configured tag. Walks the per-spriteId
        // GameObject list maintained by runProject / eval.ts so runtime
        // tag mutations (AddSpriteObjectTag, RemoveSpriteObjectTag) are
        // reflected immediately.
        const spriteId = (c.spriteId ?? "").trim();
        const wantTag = (c.tag ?? "").trim();
        if (!spriteId || !wantTag) return false;
        const idx = this.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
        const list = idx?.get(spriteId);
        if (!list || list.length === 0) return false;
        for (const go of list) {
          const tags = (go.getData("peaky.tags") as string[] | undefined) ?? [];
          if (tags.includes(wantTag)) return true;
        }
        return false;
      }
      case "OnCollideWithSpriteObject":
      case "OnOverlapWithSpriteObject":
      case "OnSpriteObjectCreate":
      case "OnSpriteObjectDestroy": {
        // Sprite-asset-id triggers — runProject / eval.ts fan signals
        // by spriteId. Empty spriteId → matches any sprite asset.
        const targetSpriteId = (c.spriteId ?? "").trim();
        const channel =
          c.kind === "OnCollideWithSpriteObject" ? "_placementCollide" :
          c.kind === "OnOverlapWithSpriteObject" ? "_placementOverlap" :
          c.kind === "OnSpriteObjectCreate"      ? "_placementCreate"  :
                                                   "_placementDestroy";
        if (targetSpriteId) {
          return this.events.firedExactlyThisFrame(`${channel}:${targetSpriteId}`);
        }
        return this.events.firedExactlyThisFrame(channel);
      }
      case "OnSignal": {
        // The EventBus has a 1-frame carryover (signals visible in
        // firedPrev next frame). Without dedup, every OnSignal event
        // would fire TWICE for one emit — once when the signal lands
        // in `fired`, again next frame when it's in `firedPrev`.
        // If THIS event matched last frame and there's no NEW emit
        // this frame, treat the carryover as already-handled and
        // skip. Re-emits within the next frame still match because
        // the signal would be in `fired` again.
        const sigs = c.signals ?? [];
        if (state.prevTickMatched) {
          return sigs.some((s) => s && this.events.firedExactlyThisFrame(s));
        }
        return sigs.some((s) => s && this.events.firedThisFrame(s));
      }
      case "OnAnimationEnd":
      case "OnAnyAnimationEnd": {
        // Typed lookup returns SpriteRenderer | undefined — both fields
        // are guaranteed-present on the class, no structural cast needed.
        const sr = this.findBehaviorByKind("SpriteRenderer");
        const isFinished = sr?.finishedEmitted === true;
        const wasFinished = state.prevAnimFinished;
        state.prevAnimFinished = isFinished;
        if (!isFinished || wasFinished) return false;
        // OnAnyAnimationEnd ignores the animation field — fires for any anim.
        if (c.kind === "OnAnyAnimationEnd") return true;
        const target = (c.animation ?? "").trim();
        if (target === "") return true;
        return sr?.currentAnimation === target;
      }
      case "TracerJustHit": {
        const tracerName = (c.tracer ?? "").trim();
        const tracers = this.findBehaviorsByKind("Tracer");
        const t = tracerName === ""
          ? tracers[0]
          : tracers.find((tr) => tr.name === tracerName);
        return !!t && t.justHit;
      }
      case "OnTweenStart": {
        // Tween action emits `_tweenStart:<tag>` synchronously when the
        // Phaser tween begins. Match by exact tag; empty tag matches the
        // empty-tag tween (`_tweenStart:`).
        // Falls back to `c.tag` for legacy nodes saved before the field
        // was renamed `tag` → `tweenTag` — without this every pre-rename
        // OnTweenStart silently watched the empty-tag tween (since
        // `c.tweenTag` is undefined on those nodes).
        const tag = (c.tweenTag ?? c.tag ?? "").trim();
        return this.events.firedThisFrame(`_tweenStart:${tag}`);
      }
      case "OnTweenFinish": {
        const tag = (c.tweenTag ?? c.tag ?? "").trim();
        return this.events.firedThisFrame(`_tweenFinish:${tag}`);
      }
      case "OnParticleBurstEnd": {
        // Edge-only — same prevTickMatched dedup pattern as OnSignal /
        // OnCollide so the EventBus's 1-frame carry-over doesn't fire
        // the trigger twice.
        const sig = "_particleBurstEnd";
        return state.prevTickMatched
          ? this.events.firedExactlyThisFrame(sig)
          : this.events.firedThisFrame(sig);
      }
      // State-check / meta kinds never reach here — `evalOneCondition` routes
      // them to `evaluateCondition` (eval.ts) or handles them inline. Listed
      // explicitly so the exhaustiveness check below makes adding a new
      // ConditionKind a hard compile error until it's classified here.
      case "Always":
      case "OnStep":
      case "OnKeyHeld":
      case "IsMouseButtonHeld":
      case "TriggerOnceWhileTrue":
      case "Compare":
      case "CompareValues":
      case "CompareTime":
      case "IsBetween":
      case "IsBoolean":
      case "ObjectUIDExists":
      case "ForEach":
      case "Repeat":
      case "While":
      case "PickByComparison":
      case "PickAll":
      case "PickRandom":
      case "PickByHighest":
      case "PickByLowest":
      case "PickNth":
      case "IsMoving":
      case "IsMovingTo":
      case "HasArrived":
      case "IsMovingLeft":
      case "IsMovingRight":
      case "IsMovingUp":
      case "IsMovingDown":
      case "IsFacingLeft":
      case "IsFacingRight":
      case "IsRunning":
      case "IsGrounded":
      case "IsJumping":
      case "IsFalling":
      case "IsDashing":
      case "IsWallSliding":
      case "IsByWall":
      case "IsByWallLeft":
      case "IsByWallRight":
      case "CanJump":
      case "CanDash":
      case "IsDoubleJumpEnabled":
      case "IsWallJumping":
      case "IsBehaviorEnabled":
      case "CompareCMParam":
      case "CompareTMParam":
      case "IsMovingDir":
      case "IsAnimationPlaying":
      case "IsSignalFiring":
      case "IsActionHeld":
      case "CompareFrame":
      case "CompareText":
      case "IsTextVisible":
      case "IsDialoguePlaying":
      case "IsCameraShaking":
      case "IsCameraPanning":
      case "IsCameraLocked":
      case "CompareCameraZoom":
      case "IsTracerHit":
      case "TracerHitHasTag":
      case "IsTweenPlaying":
      case "IsTweenPaused":
      case "IsAnyTweenPlaying":
      case "IsEmittingParticles":
      case "IsParticleEmitterEnabled":
      case "CompareParticleCount":
      case "IsCursorOverObject":
      case "Else":
        return false;
      case "OnMouseClick": {
        // Full click cycle: press AND release within 250ms / 5px on the
        // same button. State carried on scene.data:
        //   peaky.mouseDownAt[btn] = { t, x, y } when pressed
        // We detect the release edge here; if within bounds, it's a click.
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        // Track press start in scene.data (separate from mousePrev which
        // OnMouseButtonPressed/Released also update).
        const downAt = (this.scene.data.get("peaky.mouseDownAt") as Map<number, { t: number; x: number; y: number }> | undefined) ?? new Map();
        if (downNow && !wasDown) {
          downAt.set(btn, { t: this.scene.time.now, x: ptr.x, y: ptr.y });
          this.scene.data.set("peaky.mouseDownAt", downAt);
        }
        // Release edge AND within click bounds = click.
        if (!downNow && wasDown) {
          const start = downAt.get(btn);
          downAt.delete(btn);
          if (start) {
            const dt = this.scene.time.now - start.t;
            const dx = ptr.x - start.x, dy = ptr.y - start.y;
            const drag = Math.hypot(dx, dy);
            return dt <= 250 && drag <= 5;
          }
        }
        return false;
      }
      case "OnMouseDoubleClick": {
        // Two clicks within 500ms on the same button. We piggyback on
        // OnMouseClick logic: track lastClickTime per button, check if
        // current click is within window.
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        const downAt = (this.scene.data.get("peaky.mouseDownAt") as Map<number, { t: number; x: number; y: number }> | undefined) ?? new Map();
        const lastClick = (this.scene.data.get("peaky.lastClickAt") as Map<number, number> | undefined) ?? new Map();
        // Don't mutate downAt here — OnMouseClick handles that. Just read.
        if (!downNow && wasDown) {
          const start = downAt.get(btn);
          if (start) {
            const dt = this.scene.time.now - start.t;
            const dx = ptr.x - start.x, dy = ptr.y - start.y;
            const drag = Math.hypot(dx, dy);
            const isClick = dt <= 250 && drag <= 5;
            if (isClick) {
              const prev = lastClick.get(btn) ?? -Infinity;
              const sinceLast = this.scene.time.now - prev;
              lastClick.set(btn, this.scene.time.now);
              this.scene.data.set("peaky.lastClickAt", lastClick);
              if (sinceLast <= 500) {
                // Reset so triple-click doesn't auto-double-fire.
                lastClick.delete(btn);
                return true;
              }
            }
          }
        }
        return false;
      }
      case "OnObjectDoubleClicked": {
        // Two presses on the SAME sprite within 500ms. Same matching
        // modes as OnObjectClicked: targetBpId / tags / both / neither.
        const tags = c.tags ?? [];
        const targetBpId = c.targetBpId;
        const btn = typeof c.button === "number" ? c.button : 0;
        const ptr = this.scene.input.activePointer;
        const downNow =
          btn === 0 ? ptr.leftButtonDown() :
          btn === 1 ? ptr.middleButtonDown() :
          btn === 2 ? ptr.rightButtonDown() : false;
        const stateMap = (this.scene.data.get("peaky.mousePrev") as Map<number, boolean> | undefined) ?? new Map();
        const wasDown = !!stateMap.get(btn);
        const edge = downNow && !wasDown;
        if (!edge) return false;
        const cam = this.scene.cameras.main;
        const wx = ptr.worldX ?? (ptr.x + cam.scrollX);
        const wy = ptr.worldY ?? (ptr.y + cam.scrollY);
        const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        let hit: Sprite | null = null;
        for (const s of all) {
          // Pooled sprites are not `destroyed` and keep a (disabled) body at
          // their stale death position — without this they'd match clicks.
          if (s.destroyed || s._pooled || !s.body) continue;
          if (targetBpId && s.blueprintId !== targetBpId) continue;
          if (tags.length > 0 && !tags.some((t) => t && s.tags.has(t))) continue;
          const b = s.body;
          if (wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom) { hit = s; break; }
        }
        if (!hit) return false;
        // Per-sprite last-click time, keyed by uid+button.
        const key = `${hit.uid}|${btn}`;
        const lastObjClick = (this.scene.data.get("peaky.lastObjClickAt") as Map<string, number> | undefined) ?? new Map();
        const prev = lastObjClick.get(key) ?? -Infinity;
        const sinceLast = this.scene.time.now - prev;
        lastObjClick.set(key, this.scene.time.now);
        this.scene.data.set("peaky.lastObjClickAt", lastObjClick);
        if (sinceLast <= 500) {
          lastObjClick.delete(key);
          // Picking — see OnObjectClicked for rationale.
          this.scene.data.set("peaky.picked", hit);
          return true;
        }
        return false;
      }
      case "IsStateEnabled":
      case "IsState":
      case "PreviousStateWas":
      case "PreviousAnimWas":
      case "SignalFiredEdge":
      case "InputBuffered":
      case "JustTurnedLeft":
      case "JustTurnedRight":
      case "JustWallJumped":
      case "JustCollidedWithTag":
      case "JustSeparatedFromTag":
      case "HasTag":
      case "HasAnyTag":
      case "HasAllTags":
      case "IsLoading":
      case "IsScene":
      case "IsDead":
      case "IsInHitstun":
      case "IsInIframes":
      case "HasAITarget":
      case "NoAITarget":
      case "IsAnimatorAnimPlaying":
      case "IsMusicPlaying":
      case "IsSoundPlaying":
      case "IsPaused":
      case "HasItem":
      case "InventoryIsFull":
      case "CompareTileAt":
      case "CompareTileAtWorld":
      case "IsTileSolidAt":
      case "IsTileEmptyAt":
      case "IsTopdownFacing":
      case "IsOverlappingTag":
      case "IsAirborne":
      case "IsAIState":
      case "IsMovingAny":
      case "InputCombo": {
        // Delegated to the shared evaluator in sm/eval.ts; Sprite's local
        // switch keeps exhaustive coverage so adding new ConditionKinds
        // doesn't silently fall through.
        return evaluateCondition(this, c);
      }
      default: {
        const _exhaustive: never = c.kind;
        void _exhaustive;
        return false;
      }
    }
  }

  private drainQueue(): void {
    if (this.actionQueue.length === 0) return;
    // Release any signal-awaited items whose signal fired this frame, OR
    // whose timeout has elapsed (keeps a missing signal from stalling the
    // chain forever). Timed-out items are dropped, not run, so the chain
    // simply skips the rest of its actions.
    let i = this.actionQueue.length;
    while (i--) {
      const item = this.actionQueue[i];
      if (!item.awaitSignal) continue;
      if (this.events.firedThisFrame(item.awaitSignal)) {
        item.awaitSignal = undefined;
        item.awaitDeadline = undefined;
        item.runAtSec = this.clock;
      } else if (item.awaitDeadline !== undefined && this.clock > item.awaitDeadline) {
        console.warn(`[Peaky] WaitForSignal "${item.awaitSignal}" timed out after ${Sprite.AWAIT_SIGNAL_TIMEOUT_SEC}s — dropping subsequent actions in this chain.`);
        this.actionQueue.splice(i, 1);
      }
    }
    // Sort by sim time, then real time. Stable sort preserves insertion
    // order for ties, which is what keeps a chain like
    //   WaitRealtime 0.2 → SetX → WaitRealtime 0.1 → SetY
    // firing in author-written order: both SetX and SetY share `runAtSec`
    // (no Wait between them), so the realtime gate is the secondary key.
    this.actionQueue.sort((a, b) => {
      if (a.runAtSec !== b.runAtSec) return a.runAtSec - b.runAtSec;
      const aRt = a.runAtRealMs ?? -Infinity;
      const bRt = b.runAtRealMs ?? -Infinity;
      return aRt - bRt;
    });
    // Both gates must be elapsed before an item fires. Items without a
    // realtime gate (`runAtRealMs === undefined`) only check the sim clock,
    // matching legacy `Wait`-only chains exactly.
    const realNowMs = this.scene.game.loop.time;
    const ready = (item: { runAtSec: number; runAtRealMs?: number }) =>
      item.runAtSec <= this.clock + 1e-6
      && (item.runAtRealMs === undefined || item.runAtRealMs <= realNowMs + 1e-3);
    // We can't just consume from the front anymore: the queue is sorted by
    // runAtSec, but the realtime gate is independent — a head item whose
    // sim time has elapsed may still be waiting on real time while a later
    // item is fully ready. Scan and drain in order; stop only when nothing
    // is ready (caps work at one full scan per tick).
    let scanned = 0;
    while (scanned < this.actionQueue.length) {
      const head = this.actionQueue[scanned];
      if (head.awaitSignal) { scanned++; continue; }
      if (!ready(head)) { scanned++; continue; }
      this.actionQueue.splice(scanned, 1);
      const item = head;
      // Resolve the per-iteration target (ForEach/Pick chains attach a
      // targetUid). If the target has been destroyed since the queue was
      // populated, drop this action — running it on `this` instead would
      // reproduce the original retarget bug. `targetUid === undefined`
      // means "run on the source sprite" (the legacy behavior).
      let host: Sprite = this;
      if (item.targetUid !== undefined) {
        const found = spriteByUid(this.scene, item.targetUid);
        if (!found || found.destroyed) {
          // Drop this item AND every other item in the same chain so a
          // partial Wait → SetVar → SetColor doesn't half-execute when
          // the target dies between drains. Without this, only the
          // current item's mutation is dropped; later items in the
          // queue still fire on the (now-dead) host's substitute.
          if (item.chainId !== undefined) {
            const cid = item.chainId;
            for (let j = this.actionQueue.length - 1; j >= 0; j--) {
              if (this.actionQueue[j].chainId === cid) this.actionQueue.splice(j, 1);
            }
          }
          continue;
        }
        host = found;
      }
      // Deferred sub-event processing (parent had a Wait — sub-events
      // run AFTER the wait elapses, evaluated freshly).
      if (item.processChildren) {
        // Deferred sub-event call: same as the synchronous path — false
        // so children inherit the parent chain's pickedSets.
        this.processEvents(item.processChildren, false);
        if (this.destroyed) return;
        continue;
      }
      runAction(host, item.action, item.sourceLabel);
      if (this.destroyed) return;
    }
  }

  /**
   * Reset all in-flight state so the sprite is in a "freshly spawned"
   * condition. Called by `LoadSlot` before re-applying saved data — without
   * this, a load mid-tween / mid-Wait / mid-event-trigger would interleave
   * old chains with restored state and visibly desync.
   *
   * Clears:
   *   • the deferred action queue (Wait / WaitForSignal items)
   *   • all active tweens
   *   • per-event states (so `OnCreate` / `TriggerOnceWhileTrue` / etc.
   *     re-arm; the player effectively re-enters the loaded scene)
   *   • the EventBus (one-frame carryover dropped)
   */
  /**
   * Write a variable, mirroring GLOBAL vars into the persistent store so
   * `global:<name>` stays in sync with `var:<BP>.<name>`. Use this instead of
   * `vars.set` for any user-initiated variable write (SetVar / AddVar / etc.).
   */
  writeVar(name: string, value: number | string | boolean): void {
    this.vars.set(name, value);
    if (this.globalVars.has(name)) persistentState().globals[name] = value;
  }

  clearRuntimeState(): void {
    this.actionQueue.length = 0;
    this._moveTo = null;
    for (const [, entry] of this.tweens) entry.tween.stop();
    this.tweens.clear();
    for (const state of this.eventStates.values()) {
      state.createdFired = false;
      state.sceneStartFired = false;
      state.everyLastFiredSec = this.clock;
      state.prevAnimFinished = false;
      state.inFlightUntil = 0;
      state.prevTickMatched = false;
      state.stopLoop = false;
      state.implicitOnceFired = false;
    }
    // Hard-clear BOTH frame buffers (not flush, which rotates this frame's
    // emits into the carryover) so a signal fired the same frame this sprite
    // was pooled/loaded can't ghost-fire on its reactivated first frame.
    this.events.clearAll();
  }

  /** Fire every behavior's resetForPool() hook. Called by the pool-reactivate
   *  path (runProject) to clear behavior-internal runtime state that
   *  clearRuntimeState() doesn't reach (jump/dash counters, active SM state). */
  resetBehaviorsForPool(): void {
    for (const b of this.behaviors) {
      try { b.resetForPool(); } catch (e) { console.warn("[pool] resetForPool threw", e); }
    }
  }

  /** Run actions on every event whose trigger is `OnDestroyed`. Called by
   *  destroy() BEFORE the sprite is torn down, so action handlers can
   *  still read this sprite's position / vars / instance state. Wait /
   *  WaitRealtime / WaitForSignal actions are dropped — the queue is
   *  wiped immediately after destroy. Non-trigger conditions
   *  (Compare, IsBoolean, etc.) ARE evaluated so the author can gate the
   *  death actions on state ("OnDestroyed + IsBoolean wasBoss → spawn
   *  loot"). Multi-condition events with only `OnDestroyed` as the
   *  trigger just run unconditionally. */
  private _fireOnDestroyedEvents(): void {
    if (this.events_list.length === 0) return;
    const walk = (events: EventSpec[]) => {
      for (const ev of events) {
        let hasOnDestroyed = false;
        let conditionsPass = true;
        for (const c of ev.conditions) {
          if (c.kind === "OnDestroyed") { hasOnDestroyed = true; continue; }
          if (isTriggerCondition(c.kind)) continue;
          if (!evaluateCondition(this, c)) { conditionsPass = false; break; }
        }
        if (hasOnDestroyed && conditionsPass) {
          for (const action of ev.actions) {
            if (action.kind === "Wait" || action.kind === "WaitRealtime" || action.kind === "WaitForSignal") continue;
            if (action.kind === "StopLoop") break;
            try {
              runAction(this, action);
            } catch (e) {
              console.warn("[OnDestroyed] action threw", action.kind, e);
            }
          }
        }
        if (ev.children && ev.children.length > 0) walk(ev.children);
      }
    };
    walk(this.events_list);
  }

  /** Component-level LOD pass. Called from `tick()` when this sprite has
   *  at least one LOD group. Throttled to every LOD_TICK_FRAMES with a
   *  per-sprite stagger so 1000 NPCs don't all check on the same frame.
   *
   *  For each group: find the nearest sprite carrying `group.targetTag`,
   *  compare squared distance to the threshold (with 10% hysteresis to
   *  avoid edge-flicker), and flip `behavior.enabled` on every matching
   *  component when the state changes. The tick loop's own
   *  `if (!b.enabled) continue` skips disabled behaviors for free, so
   *  there's no per-frame branching cost for unmatched sprites. */
  private _runWakeCheck(): void {
    this._wakeTickPhase += 1;
    if ((this._wakeTickPhase + this.uid) % 6 !== 0) return;
    const tagged = getSpritesByTag(this.scene, this.collisionWakeTag);
    if (tagged.size === 0) return;
    const ox = this.gameObject.x;
    const oy = this.gameObject.y;
    const r2 = this.collisionWakeRadius * this.collisionWakeRadius;
    for (const t of tagged) {
      if (t === this || t.destroyed) continue;
      const dx = t.gameObject.x - ox;
      const dy = t.gameObject.y - oy;
      if (dx * dx + dy * dy <= r2) {
        const wireFor = this.scene.data.get("peaky.wireCollisionsFor") as
          | ((sprite: Sprite, bpId: string) => void)
          | undefined;
        if (wireFor && this.blueprintId) {
          wireFor(this, this.blueprintId);
        }
        this._collisionUnwired = false;
        return;
      }
    }
  }

  private _runLodPass(): void {
    this._lodTickPhase += 1;
    if ((this._lodTickPhase + this.uid) % LOD_TICK_FRAMES !== 0) return;
    const ox = this.gameObject.x;
    const oy = this.gameObject.y;
    for (const group of this.lodGroups) {
      if (!group.targetTag || group.components.length === 0) continue;
      const tagged = getSpritesByTag(this.scene, group.targetTag);
      if (tagged.size === 0) continue;
      // Nearest squared-distance scan. Math.hypot is unnecessary here;
      // the threshold is squared once and compared against squared dist.
      let minD2 = Infinity;
      for (const s of tagged) {
        if (s === this || s.destroyed) continue;
        const sx = s.gameObject.x;
        const sy = s.gameObject.y;
        const ddx = sx - ox;
        const ddy = sy - oy;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < minD2) minD2 = d2;
      }
      if (minD2 === Infinity) continue;
      const enableR = group.distance;
      const disableR = enableR * 1.1; // 10% hysteresis
      const enableR2 = enableR * enableR;
      const disableR2 = disableR * disableR;
      const prevEnabled = this._lodState.get(group.id) ?? true;
      const wantEnabled = prevEnabled ? minD2 <= disableR2 : minD2 <= enableR2;
      if (wantEnabled === prevEnabled) continue;
      this._lodState.set(group.id, wantEnabled);
      for (const b of this.behaviors) {
        if (group.components.includes(b.kind)) b.enabled = wantEnabled;
      }
    }
  }

  /** Release per-sprite resources on scene SHUTDOWN / RestartLayout WITHOUT
   *  firing gameplay `OnDestroyed` events — a scene exit is not an in-game
   *  destruction, so respawn/death logic must NOT run. Fixes the RestartLayout
   *  leak: scene.restart() reuses the scene, so the prior run's Logic Sheet
   *  scene-listeners (input.on / events.on "update") and behavior subscriptions
   *  stayed registered and pinned the dead Sprite graph. GoToLayout already
   *  destroys the whole game, so this is mainly the restart path; it's
   *  idempotent and harmless on the full-destroy path. */
  shutdownCleanup(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    destroyLogicSheet(this);
    for (const b of this.behaviors) {
      try { b.onDestroy(); } catch (e) { console.warn("Behavior.onDestroy threw (shutdown)", e); }
    }
    for (const [, entry] of this.tweens) { try { entry.tween.stop(); } catch { /* dead tween */ } }
    this.tweens.clear();
    this.actionQueue.length = 0;
    this._currOverlap.clear();
    this._prevOverlap.clear();
  }

  destroy(): void {
    if (this.destroyed || this._destroying) return;
    // Latch BEFORE firing OnDestroyed: those chains run while `destroyed` is
    // still false, so a re-entrant destroy() (cascade / self-destruct) would
    // otherwise re-fire OnDestroyed and push this sprite into the pool twice.
    this._destroying = true;
    // OnDestroyed trigger — fire BEFORE the sprite is torn down so
    // action handlers can still read self.x / vars / instance state.
    // Two paths fire:
    //   1. Logic Sheet (node graph) — subscribed to `_onDestroyed` on
    //      the event bus
    //   2. Event sheet (list view) — _fireOnDestroyedEvents iterates
    //      the events_list directly and runs actions synchronously
    // Both run BEFORE behaviors' onDestroy + the queue wipe. Wait actions
    // are dropped (the queue clears right after).
    try { this.events.emit("_onDestroyed"); } catch (e) { console.warn("[Sprite] _onDestroyed bus emit threw", e); }
    this._fireOnDestroyedEvents();
    // Object pool — if this sprite's BP has poolSize > 0, deactivate
    // into the pool instead of full teardown. The sprite stays alive in
    // peaky.sprites; Sprite.tick early-returns on _pooled. Next
    // CreateObject for this BP pops it back out and reactivates.
    // Falls through to normal destroy when:
    //   - BP isn't pooled (poolSize=0)
    //   - Pool callback isn't registered (runProject not set up)
    //   - Already pooled (shouldn't happen but be safe)
    if (!this._pooled) {
      const deact = this.scene.data.get("peaky.deactivateToPool") as
        | ((s: Sprite) => boolean)
        | undefined;
      if (deact && deact(this)) {
        this._destroying = false; // lives on in the pool — allow a future destroy
        return; // sprite is now in the pool, NOT destroyed
      }
    }
    this.destroyed = true;
    destroyLogicSheet(this);
    for (const b of this.behaviors) {
      try { b.onDestroy(); } catch (e) { console.warn("Behavior.onDestroy threw", e); }
    }
    // Stop active tweens so they don't keep ticking against a destroyed
    // target. Phaser usually no-ops on dead game objects, but tweens that
    // animate custom behavior fields would keep mutating freed state.
    for (const [, entry] of this.tweens) entry.tween.stop();
    this.tweens.clear();
    // Clear the action queue so any pending Wait → SetX chains targeting
    // this sprite don't sit in memory waiting for a tick that'll never come.
    this.actionQueue.length = 0;
    // Drop overlap-set entries — other sprites' _currOverlap may still
    // reference us, but their next collide-tick rebuild will see we're
    // missing from peaky.sprites and self-clean.
    this._currOverlap.clear();
    this._prevOverlap.clear();
    this._justCollidedThisTick.clear();
    this._justSeparatedThisTick.clear();
    // Purge uid-keyed scene maps so a long session with spawn/destroy
    // churn doesn't accumulate one entry per dead sprite per click.
    const lastObjClick = this.scene.data.get("peaky.lastObjClickAt") as Map<string, number> | undefined;
    if (lastObjClick) {
      for (const key of lastObjClick.keys()) {
        if (key.startsWith(`${this.uid}|`)) lastObjClick.delete(key);
      }
    }
    // collideTracker is keyed by sorted pair "uidA|uidB" and otherwise grows
    // one permanent entry per historical collision pair across the session —
    // purge every key mentioning this uid.
    const collideTracker = this.scene.data.get("peaky.collideTracker") as Map<string, number> | undefined;
    if (collideTracker) {
      const a = `${this.uid}|`, b = `|${this.uid}`;
      for (const key of collideTracker.keys()) {
        if (key.startsWith(a) || key.endsWith(b)) collideTracker.delete(key);
      }
    }
    // collidePartners is keyed by listener uid and its VALUE may be this sprite
    // — drop our own entry and any entry pointing at us (else dead Sprites stay
    // retained, pinning their whole behavior/event graph). Collect deletions
    // FIRST, then apply — Map.delete inside a for..of over the same map
    // skips entries on V8. (audit HIGH #61, MED #98)
    const collidePartners = this.scene.data.get("peaky.collidePartners") as Map<number, Sprite> | undefined;
    if (collidePartners) {
      collidePartners.delete(this.uid);
      const toDelete: number[] = [];
      for (const [k, v] of collidePartners) if (v === this) toDelete.push(k);
      for (const k of toDelete) collidePartners.delete(k);
    }
    // Don't leave the global "picked" slot pinning a dead sprite's graph.
    if (this.scene.data.get("peaky.picked") === this) this.scene.data.set("peaky.picked", undefined);
    // Remove the arcade colliders this sprite participated in — Phaser keeps
    // them in the world (and re-processes them every step) until explicitly
    // removed; GameObject.destroy() does NOT clean them up. removeCollider is
    // safe to call on a handle the partner also removes (idempotent).
    if (this._colliders.length) {
      const world = this.scene.physics?.world;
      for (const c of this._colliders) { try { world?.removeCollider(c); } catch { /* already gone */ } }
      this._colliders.length = 0;
    }
    // Remove from scene sprite registry so picks / ForEach skip dead refs.
    const list = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const idx = list.indexOf(this);
    if (idx >= 0) list.splice(idx, 1);
    (this.scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined)?.delete(this.uid);
    // Tag index — unhook before destroy so the per-tag Set doesn't dangle a
    // pointer to a destroyed Sprite (which would still match in lookups
    // until the next GC).
    unindexSpriteTags(this.scene, this);
    unindexSpriteName(this.scene, this);
    this.gameObject.destroy();
  }

  hasBehavior<T extends Behavior>(BehaviorCtor: BehaviorClass<T>): boolean {
    return this._behaviorCtors.has(BehaviorCtor);
  }

  /** Typed lookup by kind — returns the concrete behavior class so callers
   *  can read its public fields without an `as { … }` cast. The string
   *  overload stays for unusual lookups (e.g. plugin-style kinds outside
   *  `BehaviorKindMap`). */
  findBehaviorByKind<K extends keyof BehaviorKindMap>(kind: K): BehaviorKindMap[K] | undefined;
  findBehaviorByKind(kind: string): Behavior | undefined;
  findBehaviorByKind(kind: string): Behavior | undefined {
    return this._behaviorsByKind.get(kind)?.[0];
  }

  /** All attached behaviors of a given kind (for multi-instance behaviors like Tracer). */
  findBehaviorsByKind<K extends keyof BehaviorKindMap>(kind: K): BehaviorKindMap[K][];
  findBehaviorsByKind(kind: string): Behavior[];
  findBehaviorsByKind(kind: string): Behavior[] {
    return this._behaviorsByKind.get(kind) ?? [];
  }

  /** Read-only snapshot of attached behaviors. Used by callers that
   *  need to iterate every behavior (e.g. MoveToLayer re-applying the
   *  new layer to each behavior's overlay). Returning a copy keeps the
   *  internal list immutable from outside. */
  getBehaviors(): readonly Behavior[] {
    return this.behaviors;
  }
}

