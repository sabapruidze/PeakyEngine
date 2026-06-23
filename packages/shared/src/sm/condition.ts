/**
 * Unified condition primitives — Construct-3 style event sheet model.
 *
 * Every row in an event's "When …" list is a Condition. Some kinds are
 * **triggers** (fire once on the frame the underlying signal arrives —
 * e.g. `OnKeyPressed`, `OnLand`, `OnSignal`). Others are **state checks**
 * that are continuously true while their predicate holds (e.g. `IsGrounded`,
 * `Compare`, `IsAnimationPlaying`).
 *
 * Each condition can carry `not: true` to invert its result. The event's
 * combinator AND/ORs all of its conditions together. Sub-events nest under
 * a parent and are evaluated only after the parent's conditions matched
 * AND its actions ran (Construct semantics).
 */

export type ConditionKind =
  // ─── Triggers (one-shot per frame) ────────────────────────────────────
  | "OnCreate"
  | "OnDestroyed"
  | "OnKeyPressed"
  | "OnKeyReleased"
  | "OnCollide"
  | "OnOverlap"
  | "OnAnimationEnd"
  | "OnAnyAnimationEnd"
  | "OnLand"
  | "OnJump"
  | "OnFall"
  | "OnDashStart"
  | "OnDashEnd"
  | "OnMoved"           // speed transitioned 0 → non-zero
  | "OnStopped"         // speed transitioned non-zero → 0
  | "OnSignal"
  | "OnSceneStart"       // fires once on the frame the scene starts
  | "OnSceneEnd"         // fires once when the scene is shutting down
  | "OnLoadStart"        // fires once when GoToLayoutWithLoad activates the loading scene
  | "OnLoadProgress"     // fires repeatedly with `pct` payload (0..1) while loading
  | "OnLoadComplete"     // fires once when target assets finish loading
  | "IsLoading"          // continuous — true while a load is in progress
  | "IsScene"            // continuous — true when the active scene's name matches
  | "OnCollideWithSpriteObject"  // trigger — fires when the host BP collides (blocks) with a named sprite placement
  | "OnOverlapWithSpriteObject"  // trigger — fires when the host BP enters a named sprite placement's overlap zone
  | "OnSpriteObjectCreate"       // trigger — fires when a named sprite placement spawns (initial scene boot + runtime CreateSpriteObject)
  | "OnSpriteObjectDestroy"      // trigger — fires when a named sprite placement is destroyed
  | "HasSpriteObjectTag"         // continuous — true when ANY placement of the chosen sprite carries the configured tag
  | "OnSaveLoadComplete" // fires once when a save or load operation completes
  | "OnMouseButtonPressed"   // mouse-down on a button (0=left, 1=mid, 2=right)
  | "OnMouseButtonReleased"  // mouse-up
  | "OnMouseClick"           // full click cycle (press + release, no drag)
  | "OnMouseDoubleClick"     // two clicks within ~500ms
  | "OnMouseWheel"           // wheel scroll up / down
  | "OnObjectClicked"        // edge-trigger: press landed on a sprite carrying tag
  | "OnObjectDoubleClicked"  // two clicks within 500ms on the same tagged sprite
  | "TracerJustHit"          // edge-trigger: fires the frame a Tracer registers a NEW hit
  | "OnTweenStart"           // edge-trigger: fires the frame a tween with the given tag starts
  | "OnTweenFinish"          // edge-trigger: fires the frame a tween with the given tag completes
  // ─── State checks (continuous) ───────────────────────────────────────
  | "Always"
  | "OnStep"             // alias for "every tick"
  | "OnKeyHeld"          // continuous-while-held
  | "IsMouseButtonHeld"  // continuous while a mouse button is down
  | "IsCursorOverObject" // continuous: cursor is over a sprite carrying tag
  | "TriggerOnceWhileTrue" // meta — fires once when the OTHER conditions in this event become true
  | "Compare"
  | "CompareValues"      // universal two-value compare (literal or var on both sides)
  | "CompareTime"        // compare seconds since scene start to a number
  | "IsBetween"          // value in [min, max]
  | "IsBoolean"          // boolean variable test (true / false)
  | "EveryXSeconds"      // fires every N seconds
  | "ObjectUIDExists"    // safety check before referencing an instance
  // ─── Loops (need runtime infra; stubbed for now) ─────────────────────
  | "ForEach"            // iterate over instances of a tag/blueprint
  | "Repeat"             // run sub-actions N times
  | "While"              // run sub-actions while condition holds
  // ─── Picking (need runtime infra; stubbed for now) ───────────────────
  | "PickByComparison"
  | "PickAll"
  | "PickRandom"
  | "PickByHighest"
  | "PickByLowest"
  | "PickNth"
  | "IsMoving"
  | "IsMovingTo"
  | "HasArrived"
  | "IsMovingLeft"
  | "IsMovingRight"
  | "IsMovingUp"
  | "IsMovingDown"
  | "IsFacingLeft"        // sprite scaleX < 0 (mirrored)
  | "IsFacingRight"       // sprite scaleX >= 0 (default orientation)
  | "IsRunning"
  | "IsGrounded"
  | "IsJumping"
  | "IsFalling"
  | "IsDashing"
  | "IsWallSliding"
  | "IsByWall"          // touching a wall on EITHER side
  | "IsByWallLeft"      // touching a wall on the LEFT side specifically
  | "IsByWallRight"     // touching a wall on the RIGHT side specifically
  | "CanJump"           // jumps remaining > 0 (single, double, etc.)
  | "CanDash"           // dash cooldown elapsed
  | "IsDoubleJumpEnabled" // multiJump > 1
  | "IsWallJumping"     // CM fired wall-jump branch recently AND still ascending (vy < 0)
  | "IsBehaviorEnabled" // any attached behavior is enabled
  | "CompareCMParam"    // read any CharacterMovement property and compare
  | "CompareTMParam"    // read any TopdownMovement property and compare
  | "IsMovingDir"       // moving in a specific 8-way direction (up/upright/right/…)
  | "IsTopdownFacing"   // STICKY 4-way facing direction tracked by TopdownMovement
  | "IsAnimationPlaying"
  | "IsState"           // animator currentState === named state
  | "IsStateEnabled"
  | "PreviousStateWas"  // animator previousState === named state
  | "PreviousAnimWas"   // animator previousAnim === named animation
  | "IsSignalFiring"
  | "SignalFiredEdge"     // signal emitted EXACTLY this frame (strict edge, no carryover)
  | "IsActionHeld"
  | "InputCombo"          // multi-key combo: ALL configured (mode + action) rows match this frame
  | "InputBuffered"       // named input was just-pressed within the animator's buffer window
  | "JustTurnedLeft"      // edge: facingScaleX flipped +→- this tick
  | "JustTurnedRight"     // edge: facingScaleX flipped -→+ this tick
  | "JustWallJumped"      // edge: CM fired its wall-jump branch <0.12s ago
  | "JustCollidedWithTag" // edge: a sprite carrying tag started overlapping this tick
  | "IsOverlappingTag"    // continuous: at least one sprite carrying tag is currently overlapping
  | "JustSeparatedFromTag" // edge: a sprite carrying tag stopped overlapping this tick
  | "IsAirborne"          // continuous: NOT body.blocked.down — falling, jumping, knocked back
  | "IsAIState"           // continuous: AIBrain.state matches the picked state name
  | "IsMovingAny"         // hypot(vx, vy) > threshold — topdown / omni-directional movement
  | "IsDead"              // Damageable.isDead — kill() has run
  | "IsInHitstun"         // Damageable.isInHitstun() — sim time < hitstunUntilSec
  | "IsInIframes"         // Damageable.isInIframes() — sim time < iframesUntilSec
  | "HasAITarget"         // AIBrain.targetUid !== -1
  | "NoAITarget"          // AIBrain.targetUid === -1
  | "CompareFrame"
  // ─── Text behavior ───────────────────────────────────────────────────
  | "CompareText"        // compare the rendered text to a literal/var
  | "IsTextVisible"      // Text behavior is currently shown
  | "IsDialoguePlaying"  // a dialogue is currently running (scene singleton)
  | "IsAnimatorAnimPlaying" // named animation is currently in flight on the Animator component
  // ─── Camera behavior ─────────────────────────────────────────────────
  | "IsCameraShaking"    // Camera is currently shaking
  | "IsCameraPanning"    // Camera is in the middle of a smooth pan
  | "IsCameraLocked"     // Camera lock flag is set (cutscene mode)
  | "CompareCameraZoom"  // current zoom OP value
  | "OnCameraPanEnd"     // trigger: a CameraPanTo / CameraPanToTag finished
  // ─── Tracer behavior ─────────────────────────────────────────────────
  | "IsTracerHit"        // continuous: a named Tracer is currently hitting something
  | "HasTag"             // subject sprite carries a specific tag
  | "HasAnyTag"          // subject carries ANY tag from a CSV list (OR)
  | "HasAllTags"         // subject carries ALL tags from a CSV list (AND)
  | "TracerHitHasTag"    // current hit actor's tags contain a value
  // ─── Tween lifecycle ─────────────────────────────────────────────────
  | "IsTweenPlaying"     // continuous: a tween with the given tag is currently playing
  | "IsTweenPaused"      // continuous: a tween with the given tag exists but is paused
  | "IsAnyTweenPlaying"  // continuous: ANY tween on this sprite is playing
  // ─── ParticleEmitter ─────────────────────────────────────────────────
  | "IsEmittingParticles"          // continuous: emitter is enabled AND currently producing
  | "IsParticleEmitterEnabled"     // continuous: emitter's `enabled` flag is set
  | "OnParticleBurstEnd"           // edge: fires once when the last alive particle dies
  | "CompareParticleCount"         // compare current alive-particle count to a number
  // ─── Audio ───────────────────────────────────────────────────────────
  | "IsMusicPlaying"               // continuous: music is playing (optionally a specific track)
  | "IsSoundPlaying"               // continuous: a named SFX has a live instance playing
  | "IsPaused"                     // continuous: the scene (or a named layer) is paused via SetPaused
  | "HasItem"                      // continuous: Inventory holds at least N of an item (by name)
  | "InventoryIsFull"              // continuous: Inventory has no empty slots
  // ── Tilemap (Tier 1: read) ─────────────────────────────────────────────
  | "CompareTileAt"                // tile index at (tilemap, layer, c, r) OP value
  | "CompareTileAtWorld"           // same as CompareTileAt but world x/y
  | "IsTileSolidAt"                // cell at (tilemap, layer, x, y) is on solidTiles list
  | "IsTileEmptyAt"                // cell at (tilemap, layer, x, y) is -1 (empty)
  // ── Tilemap (Tier 2: mining trigger) ────────────────────────────────
  | "OnTileDestroyed"              // fires this frame on the actor that just mined a tile to HP 0
  | "OnTileDamaged"                // fires on the actor when a hit reduces tile HP but doesn't destroy it
  | "Else";

/** Numeric properties readable from a sprite for `Compare`. */
export type CompareProperty =
  | "velocity.x"
  | "velocity.y"
  | "speed"
  | "position.x"
  | "position.y"
  | "angle"        // rotation in degrees (0..360)
  | "scale.x"
  | "scale.y"
  | "scale"        // average of scale.x, scale.y (uniform-scale shorthand)
  | "alpha"        // 0..1 opacity
  | "depth"        // z-order (within layer)
  | "is_grounded";

export type CompareOp = ">" | "<" | ">=" | "<=" | "==" | "!=";

/**
 * One row in an event's condition list. Discriminated by `kind`; payload
 * fields are kind-specific (most are unused for any given kind).
 */
export interface Condition {
  /** Stable id — used for React keys + reorder operations. */
  id?: string;
  kind: ConditionKind;
  /**
   * Construct-3-style object subject — what the condition operates on.
   * The picker sets this when the user picks an object before choosing
   * the condition kind. At runtime, conditions with `subject: bp:<id>`
   * filter / pick instances of that BP into the chain's SOL.
   *
   * Optional — legacy data without a subject defaults to:
   *   - "self"   on BP/widget event sheets (host sprite, today's behavior).
   *   - "system" on the Main Sheet (no sprite redirect).
   */
  subject?: import("./objects").Subject;
  /** Inverts the result. Ignored for `Always` and `OnStep` (would be Never). */
  not?: boolean;
  // ── Multi-value trigger payloads (OR semantics across the array) ──
  /** OnKeyPressed / OnKeyReleased / OnKeyHeld — InputAction names. */
  actions?: string[];
  /** OnCollide / OnOverlap / OnObjectClicked / OnObjectDoubleClicked /
   *  IsCursorOverObject — tag names. Author can specify tags OR a
   *  specific BP via `targetBpId`, or both (intersection). Construct's
   *  "On collision with another object" maps to the BP picker; tag
   *  matching is the legacy / cross-cutting path. */
  tags?: string[];
  /** OnCollide / OnOverlap / OnObjectClicked / OnObjectDoubleClicked /
   *  IsCursorOverObject — specific blueprint id to match on. Sibling to
   *  `tags`; either or both can be set. When set, the trigger fires
   *  only against sprites whose blueprintId === this id (in addition to
   *  tag matches). Mirrors Construct's per-object collision semantics. */
  targetBpId?: string;
  /** OnSignal — signal names. */
  signals?: string[];
  // ── Single-value payloads ──
  /** OnAnimationEnd / IsAnimationPlaying — animation name (empty = any). */
  animation?: string;
  /** IsStateEnabled / IsState / previousStateWas — animator state name. */
  state?: string;
  /** Compare — which property/var to read. */
  property?: CompareProperty;
  /** Compare — comparison operator. */
  op?: CompareOp;
  /** Compare — right-hand value (literal number or numeric var). */
  value?: number;
  /** IsSignalFiring — single signal name. */
  signal?: string;
  /** IsActionHeld — single InputAction name. */
  action?: string;
  /** InputCombo — ordered list of (mode, action) requirements. The
   *  condition is true on a frame where EVERY row matches: `held` →
   *  action currently down, `pressed` → action JustPressed this frame,
   *  `released` → action JustReleased this frame. Mix one `pressed`
   *  (the edge trigger) with `held` gates for moves like "Down held +
   *  Attack pressed". */
  comboKeys?: Array<{ mode: "held" | "pressed" | "released"; action: string }>;
  /** CompareValues — left-hand expression. Literal number, "var:name", or string. */
  left?: string;
  /** CompareValues — right-hand expression. Same format as `left`. */
  right?: string;
  /** IsBetween — variable name (or "var:name"). */
  varName?: string;
  /** IsBetween — inclusive range minimum. */
  min?: number;
  /** IsBetween — inclusive range maximum. */
  max?: number;
  /** IsBoolean — expected value (defaults to true). */
  expected?: boolean;
  /** EveryXSeconds / Repeat / etc. — interval in seconds or count. */
  seconds?: number;
  /** Mouse button index — 0=left, 1=middle, 2=right. */
  button?: number;
  /** OnMouseWheel — "up" / "down" / "any". */
  wheelDir?: "up" | "down" | "any";
  /** ForEach / picking — tag to scope the iteration / pick set. */
  tag?: string;
  /** ForEach / picking — blueprint name (alternative to tag). */
  blueprint?: string;
  /** Repeat — iteration count. */
  count?: number;
  /** Pick Nth — 0-based index. */
  index?: number;
  /** ObjectUIDExists — UID to look up. */
  uid?: string | number;
  /** Pick by highest/lowest — property to sort by (var name or sprite prop). */
  by?: string;
  /** CompareCMParam / CMSet — name of the CharacterMovement parameter. */
  cmParam?: string;
  /** CompareTMParam — name of the TopdownMovement parameter. */
  tmParam?: string;
  /** IsMovingDir — 8-way direction (up/upright/right/downright/down/downleft/left/upleft). */
  direction?: string;
  /** IsBehaviorEnabled — name of the behavior to test (e.g. "CharacterMovement"). */
  behavior?: string;
  /** CompareText — comparison operator over strings. */
  textOp?: "==" | "!=" | "contains" | "startsWith" | "endsWith";
  /** CompareText — right-hand value (literal string or "var:name"). */
  textValue?: string;
  /** IsTracerHit / TracerHitHasTag / TracerJustHit — tracer name (empty = first attached). */
  tracer?: string;
  /** TracerHitHasTag — tag to check on the current hit actor's tag set. */
  tagValue?: string;
  /** OnTweenStart / OnTweenFinish / IsTweenPlaying / IsTweenPaused — tween tag. */
  tweenTag?: string;
  /** IsMusicPlaying / IsSoundPlaying — sound asset name (empty = any music). */
  sound?: string;
  /** IsPaused — what to test: the whole scene ("all") or a named layer. */
  scope?: "all" | "layer";
  /** IsPaused — layer name when scope = "layer". */
  layer?: string;
  /** IsScene — scene name to match against the currently active scene. */
  scene?: string;
  /** OnCollideWithSpriteObject / OnOverlapWithSpriteObject /
   *  OnSpriteObjectCreate / OnSpriteObjectDestroy — sprite asset id to
   *  react to. Empty = any sprite placement triggers it. */
  spriteId?: string;
  /** HasItem — item name to look for in the host's Inventory. */
  item?: string;
  /** CompareTileAt / IsTileSolidAt / IsTileEmptyAt — tilemap ASSET name. */
  tilemap?: string;
  /** CompareTileAt — cell column. (IsTileSolidAt/Empty/CompareTileAtWorld use `tileX`/`tileY`.) */
  c?: number;
  /** CompareTileAt — cell row. */
  r?: number;
  /** CompareTileAtWorld / IsTileSolidAt / IsTileEmptyAt — world X expression. */
  tileX?: string | number;
  /** CompareTileAtWorld / IsTileSolidAt / IsTileEmptyAt — world Y expression. */
  tileY?: string | number;
}

/** Subset of ConditionKind values that are TRIGGERS (one-shot per frame). */
export const TRIGGER_KINDS: ConditionKind[] = [
  "OnCreate",
  "OnDestroyed",
  "OnKeyPressed",
  "OnKeyReleased",
  "OnCollide",
  "OnOverlap",
  "OnAnimationEnd",
  "OnAnyAnimationEnd",
  "OnLand",
  "OnJump",
  "OnFall",
  "OnDashStart",
  "OnDashEnd",
  "OnMoved",
  "OnStopped",
  "OnSignal",
  "OnSceneStart",
  "OnSceneEnd",
  "OnLoadStart",
  "OnLoadProgress",
  "OnLoadComplete",
  "OnSaveLoadComplete",
  "EveryXSeconds",
  "OnMouseButtonPressed",
  "OnMouseButtonReleased",
  "OnMouseClick",
  "OnMouseDoubleClick",
  "OnMouseWheel",
  "OnObjectClicked",
  "OnObjectDoubleClicked",
  "OnCameraPanEnd",
  "TracerJustHit",
  "OnTweenStart",
  "OnTweenFinish",
  "OnParticleBurstEnd",
  "OnTileDestroyed",
  "OnTileDamaged",
  "InputCombo",
];

export function isTriggerCondition(kind: ConditionKind): boolean {
  return TRIGGER_KINDS.includes(kind);
}

export const CONDITION_KINDS: ConditionKind[] = [
  // Triggers first
  "OnCreate",
  "OnDestroyed",
  "OnSceneStart",
  "OnSceneEnd",
  "OnLoadStart",
  "OnLoadProgress",
  "OnLoadComplete",
  "IsLoading",
  "IsScene",
  "OnCollideWithSpriteObject",
  "OnOverlapWithSpriteObject",
  "OnSpriteObjectCreate",
  "OnSpriteObjectDestroy",
  "HasSpriteObjectTag",
  "OnSaveLoadComplete",
  "OnStep",
  "EveryXSeconds",
  "OnKeyPressed",
  "OnKeyReleased",
  "OnKeyHeld",
  "OnMouseButtonPressed",
  "OnMouseButtonReleased",
  "IsMouseButtonHeld",
  "OnCollide",
  "OnOverlap",
  "OnAnimationEnd",
  "OnAnyAnimationEnd",
  "OnLand",
  "OnJump",
  "OnFall",
  "OnDashStart",
  "OnDashEnd",
  "OnSignal",
  // State checks
  "Always",
  "TriggerOnceWhileTrue",
  "Compare",
  "CompareValues",
  "CompareTime",
  "IsBetween",
  "IsBoolean",
  "ObjectUIDExists",
  "ForEach",
  "Repeat",
  "While",
  "PickByComparison",
  "PickAll",
  "PickRandom",
  "PickByHighest",
  "PickByLowest",
  "PickNth",
  "IsMoving",
  "IsMovingTo",
  "HasArrived",
  "IsMovingLeft",
  "IsMovingRight",
  "IsMovingUp",
  "IsMovingDown",
  "IsFacingLeft",
  "IsFacingRight",
  "IsRunning",
  "IsGrounded",
  "IsJumping",
  "IsFalling",
  "IsDashing",
  "IsWallSliding",
  "IsByWall",
  "IsByWallLeft",
  "IsByWallRight",
  "CanJump",
  "CanDash",
  "IsDoubleJumpEnabled",
  "IsWallJumping",
  "IsBehaviorEnabled",
  "CompareCMParam",
  "CompareTMParam",
  "IsMovingDir",
  "IsTopdownFacing",
  "IsActionHeld",
  "InputCombo",
  "IsAnimationPlaying",
  "IsState",
  "IsStateEnabled",
  "PreviousStateWas",
  "PreviousAnimWas",
  "SignalFiredEdge",
  "InputBuffered",
  "JustTurnedLeft",
  "JustTurnedRight",
  "JustWallJumped",
  "JustCollidedWithTag",
  "IsOverlappingTag",
  "JustSeparatedFromTag",
  "IsAirborne",
  "IsAIState",
  "IsMovingAny",
  "IsDead",
  "IsInHitstun",
  "IsInIframes",
  "HasAITarget",
  "NoAITarget",
  "IsSignalFiring",
  "CompareFrame",
  "CompareText",
  "IsTextVisible",
  "IsDialoguePlaying",
  "IsAnimatorAnimPlaying",
  "IsCameraShaking",
  "IsCameraPanning",
  "IsCameraLocked",
  "CompareCameraZoom",
  "OnCameraPanEnd",
  "TracerJustHit",
  "IsTracerHit",
  "HasTag",
  "HasAnyTag",
  "HasAllTags",
  "TracerHitHasTag",
  "OnTweenStart",
  "OnTweenFinish",
  "IsTweenPlaying",
  "IsTweenPaused",
  "IsAnyTweenPlaying",
  "IsEmittingParticles",
  "IsParticleEmitterEnabled",
  "OnParticleBurstEnd",
  "CompareParticleCount",
  "IsMusicPlaying",
  "IsPaused",
  "HasItem",
  "InventoryIsFull",
  "IsSoundPlaying",
  "CompareTileAt",
  "CompareTileAtWorld",
  "IsTileSolidAt",
  "IsTileEmptyAt",
  "OnTileDestroyed",
  "OnTileDamaged",
  "Else",
];

export const CONDITION_DESCRIPTIONS: Record<ConditionKind, string> = {
  // Triggers
  OnCreate: "Fires once when this blueprint instance spawns.",
  OnDestroyed: "Fires once when this blueprint instance is about to be destroyed. Runs BEFORE the sprite is removed so the actions can read its final state (position, vars, etc.) and spawn pickups, play death effects, emit a global signal, etc. Actions are executed synchronously during destroy() — Wait actions are dropped (the sprite is gone right after).",
  OnKeyPressed: "Fires the frame any of the listed input maps is pressed (OR).",
  OnKeyReleased: "Fires the frame any of the listed input maps is released (OR).",
  OnCollide: "Fires while this sprite collides with another sprite carrying any listed tag (OR).",
  OnOverlap: "Fires while this sprite overlaps another sprite carrying any listed tag (OR).",
  OnAnimationEnd: "Fires once when a SPECIFIC animation finishes — pick the animation name. Animation must have loop=false.",
  OnAnyAnimationEnd: "Fires once whenever ANY non-loop animation reaches its last frame.",
  OnLand: "Fires once the frame the sprite touches ground after being airborne.",
  OnJump: "Fires once the frame a jump fires (CharacterMovement-emitted).",
  OnFall: "Fires once the frame the sprite starts falling (vy crosses 0 while airborne).",
  OnDashStart: "Fires once the frame a dash begins (CharacterMovement-emitted).",
  OnDashEnd: "Fires once the frame a dash ends (CharacterMovement-emitted).",
  OnMoved: "Fires once the frame the sprite's speed transitions from 0 → non-zero.",
  OnStopped: "Fires once the frame the sprite's speed transitions from non-zero → 0.",
  OnSignal: "Fires when any listed signal is emitted on this sprite (OR).",
  OnSceneStart: "Fires once on the first frame of the scene — equivalent to Construct's 'On start of layout'.",
  OnSceneEnd: "Fires once when the scene is shutting down (Construct's 'On end of layout').",
  OnLoadStart: "Fires once when GoToLayoutWithLoad enters the loading scene — use it to show a progress bar / start an animation.",
  OnLoadProgress: "Fires repeatedly while loading the target scene's assets. Payload exposes `pct` (0..1).",
  OnLoadComplete: "Fires once when the target scene's assets are fully loaded. Use to dismiss the loading UI or run GoToLayout when minDisplaySec is 0.",
  IsLoading: "True while a load is in progress (between GoToLayoutWithLoad firing and the target scene swap). Use to block input, pause AI, or display 'Loading…' text in the current scene.",
  IsScene: "True when the active scene's name matches the configured value. Use to gate cross-scene Logic Sheets ('if scene is Boss → enable phase trigger') without per-scene events.",
  OnCollideWithSpriteObject: "Fires when this BP collides (Blocks Movement = ON) with a named Sprite Object placement. Leave `placement` empty to fire on collision with ANY sprite placement.",
  OnOverlapWithSpriteObject: "Fires when this BP enters a named Sprite Object placement's overlap zone (Blocks Movement = OFF). Leave `placement` empty to fire on overlap with ANY sprite placement.",
  OnSpriteObjectCreate: "Fires once when a Sprite Object placement spawns — at scene boot for placed ones, or when CreateSpriteObject runs for runtime-spawned ones. Leave `placement` empty for any.",
  OnSpriteObjectDestroy: "Fires once when a named Sprite Object placement is destroyed (via DestroySpriteObject). Leave `placement` empty for any.",
  HasSpriteObjectTag: "True when ANY placement of the chosen sprite is currently carrying the configured tag. Use to gate logic on runtime-mutated tags (e.g., 'when the door has tag locked → show prompt').",
  OnSaveLoadComplete: "Fires once after a Save or Load action finishes (success or failure).",
  EveryXSeconds: "Fires every N seconds while the scene is running.",
  OnMouseButtonPressed: "Fires the frame a mouse button is pressed (0=left, 1=middle, 2=right).",
  OnMouseButtonReleased: "Fires the frame a mouse button is released.",
  OnMouseClick: "Fires on a full click cycle — press AND release within 250ms and ~5 pixels (not a drag or long-press). Pick the button.",
  OnMouseDoubleClick: "Fires when a second click lands within 500ms of the previous click on the same button. Stays in sync with OnMouseClick.",
  OnMouseWheel: "Fires the frame the mouse wheel is scrolled. Pick direction (up / down).",
  OnObjectClicked: "Fires the frame the user presses a mouse button while the cursor is over a sprite carrying any of the listed tags. Press-edge — fires on the press, not the release. (Use OnObjectDoubleClicked for double-clicks.)",
  OnObjectDoubleClicked: "Fires when a second press lands on the same sprite within 500ms of the previous press. Sprite must carry one of the listed tags.",
  IsCursorOverObject: "True every frame the cursor is over a sprite carrying any of the listed tags (OR).",
  // State checks
  Always: "Always passes — use as a placeholder when the event has only triggers.",
  OnStep: "Continuously true (every frame). Same as Construct's 'Every tick'.",
  OnKeyHeld: "True every frame any of the listed input maps is held (OR).",
  TriggerOnceWhileTrue: "Fires once when the rest of this event's conditions become true (edge-detected).",
  Compare: "Numeric comparison: property OP value (e.g. velocity.x > 100, var:hp <= 0).",
  CompareValues: "Universal compare — left OP right. Each side can be a literal number/string or 'var:name'.",
  CompareTime: "Compare seconds since scene start to a number (e.g. CompareTime > 30 fires after 30s).",
  IsBetween: "True when a variable's value is in the inclusive range [min, max].",
  IsBoolean: "Boolean variable test — true when the named bool var equals the expected value.",
  IsMouseButtonHeld: "True every frame the given mouse button (0=left, 1=middle, 2=right) is held.",
  ObjectUIDExists: "True when a live (non-destroyed) sprite with the given uid exists in the scene. Use to guard against stale uid references stored in vars after a target was destroyed.",
  ForEach: "Condition: true when at least one sprite with the tag exists. For Logic Sheet iteration use the ForEach ACTION node — it iterates every matching sprite and runs the body once per sprite with that sprite as `self`.",
  Repeat: "Condition: always true (use Repeat ACTION node in the Logic Sheet to loop N times).",
  While: "Condition: always true (use While ACTION node in the Logic Sheet to loop on a bool input).",
  PickByComparison: "True when at least one sprite with the tag passes the property comparison.",
  PickAll: "True when at least one sprite with the tag exists.",
  PickRandom: "True when at least one sprite with the tag exists (picks one randomly for the result set).",
  PickByHighest: "True when at least one sprite with the tag exists; picks the one with the highest value of the named property.",
  PickByLowest: "Same as PickByHighest but picks the lowest.",
  PickNth: "True when the tag pool has at least N+1 sprites; picks the Nth (0-based).",
  IsMoving: "Sprite has horizontal speed > 0. Toggle ≠ for 'idle'.",
  IsMovingTo: "True when this sprite's MoveTo behavior is currently enabled AND has a live target (not arrived). Use to gate other actions on 'is this NPC actively chasing?'.",
  HasArrived: "True when this sprite's MoveTo has entered its stopRadius around the current target (or finished an angle-mode shot). Edge-fires for one frame per arrival — pair with TriggerOnceWhileTrue if you want continuous.",
  IsMovingLeft: "Horizontal velocity is negative.",
  IsMovingRight: "Horizontal velocity is positive.",
  IsMovingUp: "Vertical velocity is negative (going up).",
  IsMovingDown: "Vertical velocity is positive (going down).",
  IsFacingLeft: "Sprite is mirrored (scaleX < 0). Stays true while idle if the character was last moving / inputting left.",
  IsFacingRight: "Sprite is in default orientation (scaleX ≥ 0). Stays true while idle if the character was last moving / inputting right.",
  IsRunning: "Grounded AND moving (true while running on the floor).",
  IsGrounded: "Sprite is standing on a Solid. Toggle ≠ for 'airborne'.",
  IsJumping: "Sprite is in the air going UP.",
  IsFalling: "Sprite is in the air going DOWN.",
  IsDashing: "CharacterMovement's dash is currently active.",
  IsWallSliding: "Sprite is currently wall-sliding (CharacterMovement).",
  IsByWall: "True while a Solid is touching the sprite's left or right side (either side). Probe-based — works regardless of input or velocity.",
  IsByWallLeft: "True while a Solid is touching the sprite's LEFT side specifically.",
  IsByWallRight: "True while a Solid is touching the sprite's RIGHT side specifically.",
  CanJump: "True while at least one jump slot remains (multi-jump / coyote / first jump).",
  CanDash: "True when the dash cooldown has elapsed and a dash can fire.",
  IsDoubleJumpEnabled: "True when CharacterMovement.multiJump > 1 (double-jump or higher allowed).",
  IsWallJumping: "True while CharacterMovement is in a wall-jump ascent — fired within the last ~1 s AND still rising (vy < 0). Use this (instead of the one-shot edge) to gate logic across the whole jump.",
  IsBehaviorEnabled: "True when the named behavior is enabled at runtime.",
  CompareCMParam: "Compare any CharacterMovement parameter (maxSpeed, jumpStrength, gravity, …) to a value.",
  CompareTMParam: "Compare any TopdownMovement parameter (maxSpeed, acceleration, …) to a value.",
  IsMovingDir: "True while the object is moving in a specific 8-way direction (up / up-right / right / … ). Momentary — reads current velocity, not facing.",
  IsTopdownFacing: "True when the TopdownMovement behavior's STICKY last-faced 4-way direction matches the picked direction (up / down / left / right). Survives key release — perfect for 'is the player facing up so the attack fires up' checks.",
  IsAnimationPlaying: "SpriteRenderer's current animation matches the picked name.",
  IsState: "True when the State Machine's current winning state matches the picked name. Reads currentState directly — works regardless of which animation is playing.",
  IsStateEnabled: "True when the named animator state is currently enabled (i.e. has not been turned off via SetStateEnabled). Use as a Branch input to gate logic that should only run while a state is reachable.",
  PreviousStateWas: "True when the animator's PREVIOUS winning state (the one before the current one) matches the picked name. Edge-shaped semantics: pair with an OnAnimationEnd-style trigger to react to specific transitions.",
  PreviousAnimWas: "True when the animation that was playing when the previous state ended matches the picked name. Mirrors PreviousStateWas but for combo / variant anims.",
  SignalFiredEdge: "Fires the EXACT frame a signal is emitted (strict edge, no 1-frame carryover). Use when 'IsSignalFiring' is too sticky.",
  InputBuffered: "True while an input action's most recent just-pressed is still inside the animator's buffer window (inputBufferMs). Lets queued input survive a brief animation lockout.",
  JustTurnedLeft: "Fires the frame the sprite's facing flipped from right → left (scaleX +→-).",
  JustTurnedRight: "Fires the frame the sprite's facing flipped from left → right (scaleX -→+).",
  JustWallJumped: "Fires within the brief edge window (~0.12s) after CharacterMovement fired its wall-jump branch. For sustained wall-jump ascent use IsWallJumping.",
  JustCollidedWithTag: "Fires the frame a sprite carrying the picked tag started overlapping this sprite (edge variant of IsOverlappingTag).",
  IsOverlappingTag: "Continuous: true while at least one sprite carrying the picked tag is overlapping this sprite. Sustained version of JustCollidedWithTag — use for proximity damage zones, in-range gates.",
  JustSeparatedFromTag: "Fires the frame a sprite carrying the picked tag stopped overlapping this sprite.",
  IsAirborne: "Continuous: NOT body.blocked.down. Covers any non-grounded state — jumping (ascending), falling (descending), and knocked-back airborne. Pair with velocity property checks for finer-grained airborne sub-states (long fall, peak of jump).",
  IsAIState: "Continuous: AIBrain.state matches the picked state name (idle / alert / chase / search / attack / flee). Use to drive animator states from AI decisions.",
  IsMovingAny: "Hypot of velocity X and Y is above the threshold. Topdown / omni-directional move check (use IsMoving for X-only).",
  IsDead: "Damageable's kill() has run (hp at 0). True until the sprite is destroyed or revived.",
  IsInHitstun: "Damageable is within its hitstun window (sim time < hitstunUntilSec). Lets logic suppress input or queue follow-ups during stagger.",
  IsInIframes: "Damageable is within its invincibility window. Use to gate hit detection / FX flicker.",
  HasAITarget: "AIBrain currently has a locked target (targetUid !== -1). Instantaneous — does not track 'recently sighted'.",
  NoAITarget: "AIBrain has no target (out-of-sight). Useful for return-to-idle gates.",
  IsSignalFiring: "A signal is being emitted on this sprite this frame.",
  IsActionHeld: "An InputAction's key is currently held down.",
  InputCombo: "Multi-key combo. Add rows of (mode + input action) — Held / Pressed / Released. True on a frame where ALL rows match. Mix one Pressed (the edge) with Held gates for moves like 'Down held + Attack pressed' — no time window, so it can't leak into the next press.",
  CompareFrame: "Compare the SpriteRenderer's current animation frame index to a number — 0-based, matching the Sprite editor's frame-strip labels. E.g. frame == 3 to fire only on a specific frame of an animation.",
  CompareText: "Compare the Text behavior's rendered string to a literal or variable using ==/!=/contains/startsWith/endsWith.",
  IsTextVisible: "True when the Text behavior's `visible` flag is on.",
  IsDialoguePlaying: "True while a dialogue is running (the scene's dialogue singleton has an active script). Use to gate input or pause logic during conversations.",
  IsAnimatorAnimPlaying: "True while the named animation on the host's Smart Tween component is currently playing. Set the animation name in the condition's `action` field.",
  IsCameraShaking: "True while a camera shake effect is active.",
  IsCameraPanning: "True while a smooth camera pan is in flight (set by CameraPanTo / CameraPanToTag).",
  OnCameraPanEnd: "Fires once when a CameraPanTo / CameraPanToTag tween finishes — use to chain cutscene steps without a manual Wait.",
  IsCameraLocked: "True when the Camera behavior is locked (cutscene mode — follow logic suppressed).",
  CompareCameraZoom: "Compare the camera's current zoom level to a number — e.g. zoom > 1.5 to detect close-up state.",
  IsTracerHit: "True while the named Tracer is currently hitting something. Leave the tracer name blank to use the first attached Tracer.",
  HasTag: "True when the subject sprite carries the named tag. Subject-aware: 'self has tag burning' / 'picked has tag boss' / etc.",
  HasAnyTag: "True when the subject sprite carries ANY tag from a comma-separated list. Equivalent to OR.",
  HasAllTags: "True when the subject sprite carries ALL tags from a comma-separated list. Equivalent to AND.",
  TracerHitHasTag: "True when the named Tracer's current hit actor carries a specific tag. Useful for filtering hits inside a single event.",
  TracerJustHit: "Fires the frame the named Tracer registers a NEW hit (different actor than the previous sample, or first hit after a miss).",
  OnTweenStart: "Fires the frame a tween with the given tag begins. Empty tag = match any tween starting on this sprite.",
  OnTweenFinish: "Fires the frame a tween with the given tag completes (excluding manual stops). Empty tag = any tween finishing.",
  IsTweenPlaying: "True while a tween with the given tag is actively running on this sprite (not paused, not finished). Empty tag = any tween playing.",
  IsTweenPaused: "True while a tween with the given tag exists in paused state (created and not yet stopped, but TweenPause was called). Empty tag = any paused tween.",
  IsAnyTweenPlaying: "True if any tween is currently running on this sprite, regardless of tag.",
  IsEmittingParticles: "True while the ParticleEmitter is enabled AND currently producing particles (continuous mode active or burst-mode particles still alive).",
  IsParticleEmitterEnabled: "True while the emitter's `enabled` flag is on, regardless of whether particles are currently visible. Use to gate logic that should run only between StartParticles / StopParticles.",
  OnParticleBurstEnd: "Fires once on the frame the LAST alive particle dies after a burst. Useful for chaining: spawn explosion → on burst end → destroy emitter.",
  CompareParticleCount: "Compare the current alive-particle count against a number with one of the operators (>, <, >=, <=, ==, !=). Lets gameplay react when an emitter is empty / saturated.",
  IsMusicPlaying: "True while a music track is playing. Set the sound name to test for a SPECIFIC track; leave empty to match ANY music. Use to avoid restarting music that's already playing.",
  IsSoundPlaying: "True while a named SFX has at least one live instance playing. Set the sound name to test.",
  IsPaused: "True while gameplay is paused via SetPaused. scope=all tests the whole-scene pause; scope=layer tests one named layer. Useful for pause-menu logic (e.g. only react to Resume input while paused).",
  HasItem: "True when this sprite's Inventory holds at least `value` (default 1) of the named item. Use to gate crafting / doors / dialogue on owning an item.",
  InventoryIsFull: "True when this sprite's Inventory has no empty slots left.",
  CompareTileAt: "Read the tile index at cell (c, r) on the named tilemap + layer and compare to a value with op (==, !=, >, <, >=, <=). Reads as -1 when the cell is empty / out of bounds.",
  CompareTileAtWorld: "Read the tile index at the cell that contains world (x, y) on the named tilemap + layer and compare. -1 when (x, y) is outside the tilemap.",
  IsTileSolidAt: "True when the tile at world (x, y) on the named tilemap + layer is on the tileset's solid list. Useful for 'can I step here' / line-of-sight checks.",
  IsTileEmptyAt: "True when the cell at world (x, y) on the named tilemap + layer holds tile -1 (no tile). Pair with placement actions to gate building.",
  OnTileDestroyed: "Fires on the actor that just mined a tile to 0 HP this frame. Reads cell context via the `lastTile.*` expression tokens (lastTile.c, lastTile.r, lastTile.idx, lastTile.x, lastTile.y, lastTile.tilemap, lastTile.layer) — scene-wide snapshot, valid only inside the chain that fired this tick.",
  OnTileDamaged: "Fires on the actor that just damaged a tile this frame WITHOUT destroying it (HP > 0 after the hit). Lets authors play hit sounds / crack particles per swing without waiting for destroy. Cell context via the `lastTile.*` tokens; `lastTile.prevHP` / `lastTile.nextHP` / `lastTile.maxHP` give the HP transition.",
  Else: "Fires when the IMMEDIATELY preceding sibling event did NOT fire this tick. Add as the only condition for a pure Else, or combine with others for 'else if'.",
};

// ─── Type predicates for the editor UI ────────────────────────────────────

export function isCompareCondition(kind: ConditionKind): boolean {
  return kind === "Compare";
}

/** Conditions whose payload is a single animation name. */
export function isAnimationCondition(kind: ConditionKind): boolean {
  return kind === "IsAnimationPlaying" || kind === "OnAnimationEnd";
}

/** Conditions whose payload is a single signal name (state check). */
export function isSignalFiringCondition(kind: ConditionKind): boolean {
  return kind === "IsSignalFiring";
}

/** Conditions whose payload is a single InputAction name. */
export function isActionHeldCondition(kind: ConditionKind): boolean {
  return kind === "IsActionHeld";
}

/** Conditions whose payload is a list of InputAction names. */
export function isKeyTrigger(kind: ConditionKind): boolean {
  return kind === "OnKeyPressed" || kind === "OnKeyReleased" || kind === "OnKeyHeld";
}

/** Conditions whose payload is a list of tag names. */
export function isTagTrigger(kind: ConditionKind): boolean {
  return kind === "OnCollide" || kind === "OnOverlap";
}

/** Conditions whose payload is a list of signal names. */
export function isSignalTrigger(kind: ConditionKind): boolean {
  return kind === "OnSignal";
}

export const COMPARE_PROPERTIES: CompareProperty[] = [
  "velocity.x",
  "velocity.y",
  "speed",
  "position.x",
  "position.y",
  "angle",
  "scale.x",
  "scale.y",
  "scale",
  "alpha",
  "depth",
  "is_grounded",
];

export const COMPARE_PROPERTY_DESCRIPTIONS: Record<CompareProperty, string> = {
  "velocity.x": "Horizontal velocity (px/s) — negative = left, positive = right",
  "velocity.y": "Vertical velocity (px/s) — negative = up, positive = down",
  speed: "Absolute horizontal speed (|velocity.x|)",
  "position.x": "Horizontal position (px)",
  "position.y": "Vertical position (px)",
  angle: "Rotation in degrees (0..360)",
  "scale.x": "Horizontal scale (1 = native size, 2 = double-wide)",
  "scale.y": "Vertical scale (1 = native size)",
  scale: "Uniform scale — average of scale.x and scale.y",
  alpha: "Opacity 0..1 (0 = invisible, 1 = fully opaque)",
  depth: "Z-order within the layer (higher = drawn on top)",
  is_grounded: "1 when standing on a Solid, 0 otherwise",
};

export const COMPARE_OPS: CompareOp[] = [">", "<", ">=", "<=", "==", "!="];
