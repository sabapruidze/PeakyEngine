import { BEHAVIOR_DEFAULTS } from "../project";
import type { BehaviorInstance, BlueprintDef, LogicFolder } from "../project";

/**
 * Deterministic "assistant recipe": a structured character spec (gathered by
 * the wizard from the user's answers + existing project assets) is turned into
 * a fully-wired Blueprint — components, attack tracer(s), and a state machine.
 *
 * No AI: the wizard asks every question and pulls choices from real project
 * data, then this builder emits the same JSON the editor already understands.
 * A real LLM could later produce this same `CharacterSpec`; the build/apply
 * path is identical.
 */

export interface TracerOnAnim {
  anim: string;
  frame: number;
}

export interface CharacterSpec {
  name: string;
  movement: "topdown" | "sidescroll";
  spriteId: string;
  /** Non-attack states to create (idle / walk / run / hurt / death / …). */
  states: string[];
  /** state name → the sprite animation the author mapped to it (optional). */
  stateAnims: Record<string, string>;
  /** Attack animation name(s). [] = no attack. Length > 1 + combo = a combo. */
  attackAnims: string[];
  combo: boolean;
  /** Which attack animations spawn the tracer, and on which frame. */
  tracerOnAnims: TracerOnAnim[];
  imagePoint: string;
  range: number;
  thickness: number;
  damage: number;
  /** Side-scroller abilities (ignored for top-down). */
  dash: boolean;
  coyote: boolean;
  wallSlide: boolean;
  inventory: boolean;
  capacity: number;
}

// State-trigger CONDITIONS, matching the engine's own Character templates —
// these are continuous predicates the State Machine evaluates each tick (NOT
// one-shot triggers). Notably hurt = IsSignalFiring(OnDamageTaken) and
// death = CompareValues(var:hp == 0).
const STATE_PRIMARY: Record<string, Record<string, unknown>> = {
  idle: { kind: "Always" },
  walk: { kind: "IsMoving", value: 5 },
  run: { kind: "IsMoving", value: 100 },
  hurt: { kind: "IsSignalFiring", signal: "OnDamageTaken" },
  death: { kind: "CompareValues", left: "var:hp", op: "==", right: "0" },
  dash: { kind: "IsDashing" },
  block: { kind: "IsActionHeld", action: "Block" },
  jump: { kind: "Compare", property: "velocity.y", op: "<", value: 0 },
  fall: { kind: "IsAirborne" },
  land: { kind: "OnLand" },
  wallslide: { kind: "IsWallSliding" },
  walljump: { kind: "JustWallJumped" },
  turn_left: { kind: "JustTurnedLeft" },
  turn_right: { kind: "JustTurnedRight" },
};
const STATE_PRIORITY: Record<string, number> = {
  death: 200, hurt: 95, attack: 100, dash: 80, block: 85, walljump: 65, land: 55, jump: 50, fall: 40, turn_left: 30, turn_right: 30, run: 15, walk: 10, idle: 0,
};
const NON_LOOPING = new Set(["attack", "hurt", "death", "land", "walljump", "turn_left", "turn_right"]);

/** @param animName the sprite animation the author mapped to this state.
 *  Falls back to the state name when none was chosen.
 *  @param topdown  swaps walk/run to IsMovingAny so omni-directional (up/down)
 *  movement triggers them — plain IsMoving is horizontal-only. */
function buildState(name: string, animName: string | undefined, topdown: boolean): Record<string, unknown> {
  const key = name.toLowerCase();
  let primary = STATE_PRIMARY[key] ?? { kind: "Always" };
  if (topdown && (key === "walk" || key === "run")) {
    primary = { kind: "IsMovingAny", value: key === "run" ? 100 : 5 };
  }
  return {
    name,
    priority: STATE_PRIORITY[key] ?? 10,
    animation: animName || name,
    enterAnim: "",
    exitAnim: "",
    useTransitions: false,
    loop: !NON_LOOPING.has(key),
    primary,
  };
}

function buildAttackState(spec: CharacterSpec): Record<string, unknown> {
  const frameSignals = spec.tracerOnAnims.map((t) => ({ anim: t.anim, frames: [t.frame], signal: "atkTracer" }));
  return {
    name: "attack",
    priority: STATE_PRIORITY.attack,
    animation: spec.attackAnims[0] ?? "attack",
    enterAnim: "",
    exitAnim: "",
    useTransitions: false,
    loop: false,
    primary: { kind: "OnKeyPressed", actions: ["Attack"] },
    comboAnimations: spec.combo ? spec.attackAnims : [],
    frameSignals,
  };
}

/** Emit a ready-to-add Blueprint from the spec. Spreads BEHAVIOR_DEFAULTS so
 *  every config field exists, then overrides only what the wizard gathered. */
export function buildCharacter(spec: CharacterSpec, pickupFolders: LogicFolder[] = []): Partial<BlueprintDef> {
  const D = BEHAVIOR_DEFAULTS as Record<string, Record<string, unknown>>;
  const topdown = spec.movement === "topdown";
  const hasAttack = spec.attackAnims.length > 0;
  const hasTracer = spec.tracerOnAnims.length > 0;

  const stateList = spec.states.map((s) => buildState(s, spec.stateAnims[s], topdown));
  if (hasAttack) stateList.unshift(buildAttackState(spec));

  const behaviors: BehaviorInstance[] = [
    {
      kind: "SpriteRenderer",
      config: { ...(D.SpriteRenderer ?? {}), spriteId: spec.spriteId, currentAnimation: spec.states[0] ?? "idle", playing: 1, speed: 1 },
      enabled: true,
    },
    topdown
      // Top-down: the 4-way RPG controller (up/down/left/right, no gravity).
      // mirrorMode 2 = flip facing by input, so the sprite faces left/right as it moves.
      ? { kind: "TopdownMovement", config: { ...(D.TopdownMovement ?? {}), upAction: "MoveUp", downAction: "MoveDown", leftAction: "MoveLeft", rightAction: "MoveRight", mirrorMode: 2 }, enabled: true }
      // Side-scroller: platformer controller (gravity + jump) with the
      // author-chosen abilities (dash / coyote-time / wall-slide+wall-jump).
      : { kind: "CharacterMovement", config: { ...(D.CharacterMovement ?? {}), gravity: 1500, gravityAngle: 90, maxFallSpeed: 1500, jumpStrength: 650, jumpAction: "Jump", leftAction: "MoveLeft", rightAction: "MoveRight",
          mirrorMode: 2,
          dashEnabled: spec.dash ? 1 : 0, dashAction: spec.dash ? "Dash" : "",
          coyoteEnabled: spec.coyote ? 1 : 0,
          wallEnabled: spec.wallSlide ? 1 : 0 }, enabled: true },
    { kind: "Collider", config: { ...(D.Collider ?? {}), width: 28, height: 28, collideWorldBounds: 1, passThrough: 1 }, enabled: true },
    // hpVar "hp" → Damageable mirrors HP into the `hp` runtime var, which the
    // death state's CompareValues(var:hp == 0) reads.
    { kind: "Damageable", config: { ...(D.Damageable ?? {}), hp: 100, maxHp: 100, hpVar: "hp", maxHpVar: "maxHp", destroyOnDeath: 1 }, enabled: true },
  ];

  if (hasTracer) {
    behaviors.push({
      kind: "Tracer",
      config: {
        ...(D.Tracer ?? {}),
        name: "AttackTracer",
        shape: "box",
        distance: spec.range,
        boxThickness: spec.thickness,
        pivotSource: spec.imagePoint ? "imagePoint" : "host",
        imagePointName: spec.imagePoint,
        tagFilter: "enemy",
        triggerMode: "signal",
        triggerSignal: "atkTracer",
        signalLifetimeSec: 0.2,
        damage: spec.damage,
        multiHit: 0,
      },
      enabled: true,
    });
  }

  if (spec.inventory) {
    // persistKey "player" → the bag persists across scenes AND the Inventory
    // widget (targetBp = this BP) reads it.
    behaviors.push({ kind: "Inventory", config: { ...(D.Inventory ?? {}), capacity: spec.capacity, persistKey: "player" }, enabled: true });
  }

  behaviors.push({ kind: "StateMachine", config: { ...(D.StateMachine ?? {}), states: stateList }, enabled: true });

  return {
    name: spec.name,
    classKind: "Character",
    tags: ["character", "player"],
    w: 32,
    h: 32,
    color: 0x4aa3ff,
    affectedByGravity: !topdown,
    behaviors,
    ...(pickupFolders.length ? { logicSheet: { folders: pickupFolders } } : {}),
  };
}

// ── NPC / enemy recipe ────────────────────────────────────────────────────────

export interface NpcSpec {
  name: string;
  movement: "topdown" | "sidescroll";
  spriteId: string;
  /** AI states to create (idle / chase / attack / flee / hurt / death / …). */
  states: string[];
  stateAnims: Record<string, string>;
  attackAnim: string;
  attackFrame: number;
  /** Image-point name the attack tracer pivots from (empty = host center). */
  imagePoint: string;
  /** Tag of who it hunts (e.g. "player"). */
  targetTag: string;
  sightRange: number;
  attackRange: number;
  thickness: number;
  damage: number;
  hp: number;
  chaseSpeed: number;
  patrolSpeed: number;
  fleeOnDamage: boolean;
}

// AI states are driven by the AIBrain's current `state` via IsAIState (plus the
// universal hurt = IsSignalFiring and death = hp==0).
const AI_STATE_PRIMARY: Record<string, Record<string, unknown>> = {
  death: { kind: "CompareValues", left: "var:hp", op: "==", right: "0" },
  hurt: { kind: "IsSignalFiring", signal: "OnDamageTaken" },
  attack: { kind: "IsAIState", action: "attack" },
  flee: { kind: "IsAIState", action: "flee" },
  chase: { kind: "IsAIState", action: "chase" },
  search: { kind: "IsAIState", action: "search" },
  alert: { kind: "IsAIState", action: "alert" },
  patrol: { kind: "IsAIState", action: "patrol" },
  idle: { kind: "Always" },
};
const AI_STATE_PRIORITY: Record<string, number> = {
  death: 200, hurt: 95, attack: 90, flee: 70, chase: 50, search: 40, alert: 30, patrol: 15, idle: 0,
};
const AI_NON_LOOPING = new Set(["attack", "hurt", "death"]);

function buildAiState(name: string, animName: string | undefined): Record<string, unknown> {
  const key = name.toLowerCase();
  return {
    name, priority: AI_STATE_PRIORITY[key] ?? 10, animation: animName || name,
    enterAnim: "", exitAnim: "", useTransitions: false, loop: !AI_NON_LOOPING.has(key),
    primary: AI_STATE_PRIMARY[key] ?? { kind: "Always" },
  };
}

export function buildNPC(spec: NpcSpec): Partial<BlueprintDef> {
  const D = BEHAVIOR_DEFAULTS as Record<string, Record<string, unknown>>;
  const topdown = spec.movement === "topdown";
  const states = spec.states.map((s) => buildAiState(s, spec.stateAnims[s]));
  // attack state already handled above if present; ensure attack frame-signal.
  const attackState = states.find((s) => String((s as { name: string }).name).toLowerCase() === "attack");
  if (attackState && spec.attackAnim) {
    (attackState as Record<string, unknown>).animation = spec.attackAnim;
    (attackState as Record<string, unknown>).frameSignals = [{ anim: spec.attackAnim, frames: [spec.attackFrame], signal: "atk" }];
  }

  const behaviors: BehaviorInstance[] = [
    { kind: "SpriteRenderer", config: { ...(D.SpriteRenderer ?? {}), spriteId: spec.spriteId, currentAnimation: spec.states[0] ?? "idle", playing: 1, speed: 1 }, enabled: true },
    // Movement is AI-DRIVEN (no input actions) — AIBrain's mover:"auto" steers it.
    topdown
      ? { kind: "TopdownMovement", config: { ...(D.TopdownMovement ?? {}), maxSpeed: spec.chaseSpeed, upAction: "", downAction: "", leftAction: "", rightAction: "", mirrorMode: 1 }, enabled: true }
      : { kind: "CharacterMovement", config: { ...(D.CharacterMovement ?? {}), gravity: 1500, leftAction: "", rightAction: "", jumpAction: "", mirrorMode: 1 }, enabled: true },
    { kind: "Collider", config: { ...(D.Collider ?? {}), width: 28, height: 28, collideWorldBounds: 1, passThrough: 1 }, enabled: true },
    { kind: "Damageable", config: { ...(D.Damageable ?? {}), hp: spec.hp, maxHp: spec.hp, hpVar: "hp", maxHpVar: "maxHp", destroyOnDeath: 1 }, enabled: true },
    // Sight tracer — AIBrain reads it (by name "sight") to detect the target.
    { kind: "Tracer", config: { ...(D.Tracer ?? {}), name: "sight", shape: "circle", distance: spec.sightRange, pivotSource: "host", tagFilter: spec.targetTag, triggerMode: "interval", intervalSec: 0.15, damage: 0 }, enabled: true },
    // Attack tracer — AIBrain fires it (by name "attack") when in range.
    { kind: "Tracer", config: { ...(D.Tracer ?? {}), name: "attack", shape: "box", distance: spec.attackRange, boxThickness: spec.thickness, pivotSource: spec.imagePoint ? "imagePoint" : "host", imagePointName: spec.imagePoint, tagFilter: spec.targetTag, triggerMode: "signal", triggerSignal: "atk", signalLifetimeSec: 0.2, damage: spec.damage, multiHit: 0 }, enabled: true },
    // detectionRadius does the OMNIDIRECTIONAL sense (a real radius scan) — the
    // sight tracer alone is facing-directional, so without this the NPC never
    // "feels" a target off to the side/behind and stays idle.
    { kind: "AIBrain", config: { ...(D.AIBrain ?? {}), autoBrain: 1, state: "idle", targetTag: spec.targetTag, sightTracerName: "sight", attackTracerName: "attack", attackRange: spec.attackRange, detectionRadius: spec.sightRange, chaseSpeed: spec.chaseSpeed, patrolSpeed: spec.patrolSpeed, fleeOnDamage: spec.fleeOnDamage ? 1 : 0, mover: "auto" }, enabled: true },
    { kind: "StateMachine", config: { ...(D.StateMachine ?? {}), states }, enabled: true },
  ];

  return {
    name: spec.name,
    classKind: "NPC",
    tags: ["npc", "enemy"],
    w: 32, h: 48,
    color: 0xff6b6b,
    affectedByGravity: !topdown,
    behaviors,
  };
}
