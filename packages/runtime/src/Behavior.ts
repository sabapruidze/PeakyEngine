import type { Sprite } from "./Sprite";
import type { Solid } from "./behaviors/Solid";
import type { JumpThru } from "./behaviors/JumpThru";
import type { CharacterMovement } from "./behaviors/CharacterMovement";
import type { TopdownMovement } from "./behaviors/TopdownMovement";
import type { SpriteRenderer } from "./behaviors/SpriteRenderer";
import type { Collider } from "./behaviors/Collider";
import type { Text } from "./behaviors/Text";
import type { Camera } from "./behaviors/Camera";
import type { Tracer } from "./behaviors/Tracer";
import type { SquashStretch } from "./behaviors/SquashStretch";
import type { Outline } from "./behaviors/Outline";
import type { Shadow } from "./behaviors/Shadow";
import type { LightSource } from "./behaviors/LightSource";
import type { Weather } from "./behaviors/Weather";
import type { UIWidgetRenderer } from "./behaviors/UIWidgetRenderer";
import type { ParticleEmitter } from "./behaviors/ParticleEmitter";
import type { Damageable } from "./behaviors/Damageable";
import type { CharacterAnimator } from "./behaviors/CharacterAnimator";
import type { AIBrain } from "./behaviors/AIBrain";
import type { PhaseManager } from "./behaviors/PhaseManager";
import type { Widget } from "./behaviors/Widget";
import type { Animator } from "./behaviors/Animator";
import type { Projectile } from "./behaviors/Projectile";
import type { Inventory } from "./behaviors/Inventory";
import type { TilemapRenderer } from "./behaviors/TilemapRenderer";
import type { VisionMask } from "./behaviors/VisionMask";
import type { MoveTo } from "./behaviors/MoveTo";
import type { TiledBackground } from "./behaviors/TiledBackground";
import type { WeaponSlot } from "./behaviors/WeaponSlot";
import type { Dismemberment } from "./behaviors/Dismemberment";

/**
 * Compile-time map from Behavior `kind` string to its concrete class type.
 * Lets `Sprite.findBehaviorByKind("Text")` return a typed `Text` instead of
 * the base `Behavior` — so callers can read `.content` / `.fontSize` without
 * an `as { … }` lie that the compiler can't validate.
 *
 * Adding a new behavior: declare its class, add the entry here, register
 * it in the editor's `BEHAVIOR_REGISTRY` + `BehaviorKind` union. The
 * editor's union and this map should always carry the same set of keys.
 */
export interface BehaviorKindMap {
  Solid: Solid;
  JumpThru: JumpThru;
  CharacterMovement: CharacterMovement;
  TopdownMovement: TopdownMovement;
  SpriteRenderer: SpriteRenderer;
  Collider: Collider;
  Text: Text;
  Camera: Camera;
  Tracer: Tracer;
  SquashStretch: SquashStretch;
  UIWidgetRenderer: UIWidgetRenderer;
  ParticleEmitter: ParticleEmitter;
  Damageable: Damageable;
  StateMachine: CharacterAnimator;
  AIBrain: AIBrain;
  PhaseManager: PhaseManager;
  Widget: Widget;
  SmartTween: Animator;
  Projectile: Projectile;
  Inventory: Inventory;
  TilemapRenderer: TilemapRenderer;
  VisionMask: VisionMask;
  MoveTo: MoveTo;
  TiledBackground: TiledBackground;
  WeaponSlot: WeaponSlot;
  Dismemberment: Dismemberment;
  Outline: Outline;
  Shadow: Shadow;
  LightSource: LightSource;
  Weather: Weather;
}

/**
 * Per-behavior allow-list of params that `SetBehaviorParam` (and `CMSet`)
 * may write at runtime. Anything not in this list is rejected — keeps
 * malformed action configs from clobbering internal state like `kind`,
 * `enabled`, `sprite`, or `_naturalAbsScale`.
 *
 * Should mirror the keys in the editor's `BEHAVIOR_PARAMS` (behaviorMeta.ts).
 * Drift here means a writable param shows in the editor but the runtime
 * silently ignores it — easy to spot during testing.
 */
export const BEHAVIOR_WRITABLE_PARAMS: Record<keyof BehaviorKindMap, ReadonlySet<string>> = {
  Solid: new Set<string>(["debugDraw"]),
  JumpThru: new Set<string>(),
  CharacterMovement: new Set<string>([
    "maxSpeed", "acceleration", "deceleration", "airControl",
    "gravity", "gravityAngle", "maxFallSpeed", "ceilingMode",
    "mirrorMode", "scaleMirror", "scaleMirrorTime",
    "leftAction", "leftEventTrigger", "leftCustomFn",
    "rightAction", "rightEventTrigger", "rightCustomFn",
    "jumpAction", "jumpEventTrigger", "jumpCustomFn",
    "jumpStrength", "jumpTimeToApex", "fallGravityMultiplier", "multiJump",
    "coyoteEnabled", "coyoteTime",
    "bufferEnabled", "bufferTime",
    "varHeightEnabled", "varHeightCutoff",
    "jumpSustainEnabled", "jumpSustainTime",
    "dashEnabled", "dashAction", "dashEventTrigger", "dashCustomFn",
    "dashSpeed", "dashStartDelay", "dashDuration", "dashCooldown", "dashWallBlock",
    "wallEnabled", "wallSlideSpeed", "wallSlideRequiresInput", "wallSlideOnContact",
    "wallJumpAllowed",
    "wallJumpStrength", "wallJumpKickX", "wallSlideCustomFn", "wallJumpCustomFn",
    "ignoreInput",
    "jumpsUsed", "dashing", "dashReadyAtSec",
  ]),
  TopdownMovement: new Set<string>([
    "maxSpeed", "acceleration", "deceleration",
    "upAction", "downAction", "leftAction", "rightAction",
    "upEventTrigger", "downEventTrigger", "leftEventTrigger", "rightEventTrigger",
    "mirrorMode", "scaleMirror", "scaleMirrorTime", "ignoreInput", "slideAssist",
  ]),
  SpriteRenderer: new Set<string>([
    "spriteId", "currentAnimation", "playing", "speed", "frame", "useFrameCollider", "solid",
  ]),
  Collider: new Set<string>([
    "width", "height", "offsetX", "offsetY", "collideWorldBounds", "passThrough", "debugDraw",
  ]),
  Text: new Set<string>([
    "name",
    "content", "fontFamily", "fontSize", "color",
    "bold", "italic", "align", "vAlign",
    "wrapWidth", "visible", "alpha", "offsetX", "offsetY",
  ]),
  Camera: new Set<string>([
    "targetMode", "targetTag", "smoothing",
    "followX", "followY",
    "offsetLeftX", "offsetRightX", "offsetY", "offsetSmoothing",
    "deadzoneX", "deadzoneY",
    "zoom", "bounded", "locked",
  ]),
  Tracer: new Set<string>([
    "name", "shape", "distance", "angle",
    "pivotSource", "imagePointName", "weaponSlotName",
    "pivotX", "pivotY", "boxThickness", "tagFilter",
    "triggerMode", "triggerSignal", "fireAnim", "fireFrame", "intervalSec", "debugDraw",
    "signalCount", "signalLoop", "signalLifetimeSec",
    "damage", "knockbackX", "knockbackY", "multiHit",
  ]),
  SquashStretch: new Set<string>([
    "intensity", "duration", "easing", "emitOnEnd",
  ]),
  Outline: new Set<string>([
    "on", "color", "thickness", "opacity", "pulse", "pulseSpeed",
    "glow", "glowColor", "glowSize", "glowOpacity", "feather",
  ]),
  Shadow: new Set<string>([
    "on", "shape", "width", "height", "feather", "opacity", "color",
    "offsetX", "offsetY", "groundTag", "maxDrop", "shrinkWithHeight",
  ]),
  LightSource: new Set<string>([
    "on", "color", "radius", "intensity", "edge", "feather", "edgeAmount", "offsetX", "offsetY", "flicker", "flickerSpeed",
  ]),
  Weather: new Set<string>([
    "on", "space", "mode", "killTags", "shelterTags", "shelterDrizzleTags", "count", "speed", "speedJitter", "angle", "wind", "rotationSpeed",
    "shape", "size", "sizeJitter", "thickness", "color", "alpha", "sway", "swaySpeed", "spriteId",
    "splash", "splashType", "splashSprite", "splashAnim", "splashScale",
  ]),
  ParticleEmitter: new Set<string>([
    "name",
    "mode", "rate", "burstCount", "maxParticles", "enabled", "spriteId", "delay",
    "pivotSource", "imagePointName",
    "spawnJitterX", "spawnJitterY", "offsetX", "offsetY", "renderOrder",
    "lifetime", "lifetimeJitter",
    "speed", "speedJitter", "angleMin", "angleMax",
    "gravityX", "gravityY", "friction",
    "rotationStart", "rotationEnd", "rotationJitter",
    "scaleStart", "scaleEnd",
    "alphaStart", "alphaEnd",
    "tintStart", "tintEnd",
    "blendMode", "frameMode", "frameIndices",
  ]),
  Damageable: new Set<string>([
    "hp", "maxHp", "hpVar", "maxHpVar", "iframeSec", "hitstunSec",
    "knockbackMultiplier", "blockKnockbackMultiplier", "partialKnockbackMultiplier",
    "destroyOnDeath", "deathDestroyDelay", "allowHealing", "attackable",
    "blockStates", "guardMultiplier", "guarding",
  ]),
  StateMachine: new Set<string>([
    "states", "currentState", "debugDraw", "inputGates", "comboWindow", "inputBufferMs",
  ]),
  AIBrain: new Set<string>([
    "state", "targetTag", "sightTracerName", "attackTracerName",
    "attackRange", "loseSightAfterSec", "attackCooldownSec", "attackDurationSec", "attackRestState",
    "interruptAttackOnHit", "chaseSpeed", "patrolSpeed",
    "fleeOnDamage", "fleeDurationSec", "hearSignals", "patrolMode",
    "targetUid", "autoBrain", "detectionRadius", "autoFaceTarget",
    "disableWhenDead", "separationDist", "separationTag", "separationAvoid", "separationMode",
    "aiTickRate", "mover",
  ]),
  PhaseManager: new Set<string>([
    "thresholdsPct", "currentPhase", "phaseVar", "invulnOnTransitionSec",
  ]),
  UIWidgetRenderer: new Set<string>([
    // All UI Widget fields settable via SetBehaviorParam at runtime.
    // Lets a Button's text be changed, a Slider's value bound to a var,
    // a Dropdown's selectedValue scripted, etc.
    "widgetKind", "widgetW", "widgetH",
    "bgColor", "bgAlpha", "borderColor", "borderWidth", "padding",
    "cornerRadius", "cornersSeparate",
    "cornerRadiusTL", "cornerRadiusTR", "cornerRadiusBL", "cornerRadiusBR",
    "shadowEnabled", "shadowColor", "shadowAlpha", "shadowBlur",
    "shadowOffsetX", "shadowOffsetY",
    "anchorCorner", "anchorOffsetX", "anchorOffsetY",
    "text", "fontFamily", "fontSize", "fontColor", "fontBold", "fontItalic",
    "align", "vAlign",
    "signalOnClick", "signalOnHover", "signalOnLeave",
    "hoverBgColor", "pressedBgColor", "clickMode",
    "min", "max", "value", "direction", "fillColor", "signalOnChange", "readOnly",
    "selectedValue", "signalOnSelect",
    "spriteId", "imageTextureKey",
  ]),
  Widget: new Set<string>([
    "widgetId", "offsetX", "offsetY", "hideWhenDead", "linkedVar",
  ]),
  SmartTween: new Set<string>([
    // animations[] is structural — edit via the inspector, not
    // SetBehaviorParam. Runtime control is via PlayAnimatorAnim /
    // StopAnimatorAnim actions. Keep this empty so SetBehaviorParam
    // can't malform the keyframe list at runtime.
  ]),
  Projectile: new Set<string>([
    "mode", "speed", "lifetime", "gravityX", "gravityY",
    "targetTags", "hitSignal", "destroyOnHit", "rotateToVelocity",
    "collideTiles", "tileHitSignal",
    "damage", "knockbackX", "knockbackY",
    "hitboxW", "hitboxH", "hitboxOffsetX", "hitboxOffsetY", "debugDraw",
    "targetUid", "homingTurnRate",
  ]),
  // slots[] is structural — managed via AddItem/RemoveItem actions + the
  // Inventory widget's drag/drop, not SetBehaviorParam.
  Inventory: new Set<string>(["capacity"]),
  // Tilemap config is bulk-injected at attach (textureKey, tiles, solids).
  // No fine-grained SetBehaviorParam access for v1 — paint-in-runtime would
  // require destroying + rebuilding the Phaser layer per call, not worth it.
  TilemapRenderer: new Set<string>([]),
  VisionMask: new Set<string>([
    "radius", "featherPx", "cutoutOpacity", "centerOffsetX", "centerOffsetY",
    "maskFrame", "maskMirror", "cutoutLayers", "excludeTags", "invert", "enabled",
  ]),
  MoveTo: new Set<string>([
    "mode", "targetX", "targetY", "targetUid", "targetTag", "angleDeg",
    "speed", "stopRadius", "retargetEverySec", "arrivalSignal",
    "mirror", "usePhysics", "enabled",
    "separationDist", "separationTag", "separationStrength", "separationAvoid", "separationMode",
  ]),
  TiledBackground: new Set<string>([
    "mode", "parallaxFactor", "parallaxFactorX", "parallaxFactorY",
    "scrollSpeedX", "scrollSpeedY",
    "width", "height", "flipX", "flipY", "tileX", "tileY",
    "currentAnimation", "playing", "startFrame",
    "enabled",
  ]),
  WeaponSlot: new Set<string>([
    "name", "spriteId", "currentAnimation", "imagePoint",
    "offsetX", "offsetY", "angleOffset",
    "scaleX", "scaleY",
    "followFacing", "renderAbove", "visible",
    "playing", "startFrame", "speed",
  ]),
  Dismemberment: new Set<string>([
    "launch", "angleDeg", "spreadDeg",
    "speedMin", "speedMax", "spinMin", "spinMax",
    "gravity", "bounce",
    "cleanup", "lifetimeSec", "fadeSec", "maxGibs",
    "collideWorld", "hideHost", "fireSignal",
    // `regions` is structural (array of rects) — edit via the inspector, not
    // SetBehaviorParam, so it can't be malformed at runtime.
  ]),
};

/** Returns true when the given (kind, param) pair is safe for SetBehaviorParam. */
export function isWritableBehaviorParam(kind: string, param: string): boolean {
  const set = (BEHAVIOR_WRITABLE_PARAMS as Record<string, ReadonlySet<string> | undefined>)[kind];
  return set ? set.has(param) : false;
}

export abstract class Behavior {
  sprite!: Sprite;
  /**
   * When false, the host Sprite skips this behavior's `update(delta)`. Other
   * methods (init, attach) still run. Wired via `SetBehaviorEnabled` actions
   * in the graph.
   */
  enabled = true;
  /**
   * Behavior kind — set by attach() so action handlers can look up a behavior
   * by string name without instanceof gymnastics. Matches `BehaviorKind`.
   */
  kind = "";
  /**
   * When false (default), Sprite.tick skips `update(delta)` for this behavior
   * while the scene's timeScale is 0 (paused). Stops gameplay behaviors —
   * CharacterMovement reading input during a pause and replaying jump/move
   * the moment timeScale flips back to 1, Tracer animating its overlay,
   * SpriteRenderer advancing animation frames, etc.
   *
   * UI-side behaviors (UIWidgetRenderer) override to true so pause-menu
   * widgets keep responding to clicks / hover while the world is frozen.
   * Events still fire during a pause regardless — so `OnPress[Q] →
   * SetTimeScale 1` still unpauses the game.
   */
  tickDuringPause = false;

  attach(sprite: Sprite, config: Record<string, unknown> = {}): void {
    this.sprite = sprite;
    // Protect identity fields: a malformed project file (or stale legacy
    // field on a saved instance) could include `kind: "evil"` or
    // `sprite: …` and `Object.assign` would happily clobber them.
    // Strip those keys before merging — everything else (the public params
    // + the underscore-prefixed injection fields like `_animations` that
    // runProject sets up) is allowed through unchanged.
    if ("kind" in config || "sprite" in config) {
      const safe: Record<string, unknown> = {};
      for (const k of Object.keys(config)) {
        if (k === "kind" || k === "sprite") continue;
        safe[k] = config[k];
      }
      Object.assign(this, safe);
    } else {
      Object.assign(this, config);
    }
    this.init();
  }

  init(): void {}
  update(_delta: number): void {}
  /** Optional cleanup hook fired when the host Sprite is destroyed. */
  onDestroy(): void {}

  /** Optional hook fired when a pooled host is reactivated for reuse. The
   *  Sprite already wipes per-event state / queues / tweens / bus via
   *  clearRuntimeState(); this is for behavior-internal runtime fields that
   *  would otherwise leak from the previous life (jump/dash counters, the
   *  active state-machine state, in-flight flags). Default: no-op. */
  resetForPool(): void {}

  /**
   * Optional save hook. Return a JSON-serializable object capturing the
   * pieces of runtime state that should survive a SaveSlot/LoadSlot
   * round-trip — e.g. `jumpsUsed` on CharacterMovement, `currentAnimation`
   * on SpriteRenderer. Returning `undefined` (default) means "nothing to
   * save" and the load path skips this behavior entirely.
   *
   * Things you generally should NOT save:
   *   • config params already in the BP definition (those re-apply via attach)
   *   • timers tied to the sim clock (in-flight dashes, wall-slide cooldowns)
   *   • Phaser internals (overlays, tweens, gameObjects)
   * In-flight effects are reset on load via `Sprite.clearRuntimeState()`.
   */
  serialize(): Record<string, unknown> | undefined { return undefined; }

  /**
   * Optional load hook — receives whatever `serialize()` returned for this
   * behavior on the matching saved sprite. Default: no-op. Behaviors that
   * implement `serialize` must implement `deserialize` to round-trip.
   */
  deserialize(_state: Record<string, unknown>): void { /* no-op by default */ }
  /**
   * Apply the host sprite's render layer to any secondary GameObjects this
   * behavior owns (e.g. SpriteRenderer's image overlay, Text's text overlay).
   * Default no-op — behaviors with no overlays can ignore this.
   *
   *   - scrollX / scrollY: per-axis camera scroll factor (parallax).
   *   - baseDepth: layer's render-order base. Within-layer ordering uses
   *     small offsets on top (e.g. body.depth+1, body.depth+2).
   *   - alpha: layer's opacity multiplier.
   *   - visible: layer-level visibility.
   */
  applyLayer(_scrollX: number, _scrollY: number, _baseDepth: number, _alpha: number, _visible: boolean): void {}
}

export type BehaviorClass<T extends Behavior = Behavior> = new () => T;
