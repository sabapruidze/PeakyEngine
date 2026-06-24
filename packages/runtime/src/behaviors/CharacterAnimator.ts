import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import type { Sprite } from "../Sprite";
import { getInputActions } from "../input/InputActions";
import { numOr, evaluateCondition } from "../sm/eval";
import { setupCrispText } from "../textRendering";
import { isTriggerCondition } from "@peaky/shared";
import type { Condition, ConditionKind } from "@peaky/shared";

/**
 * Two-stage animation state machine.
 *
 *   Stage 1 — conditions → state. Each entry in `states` declares a
 *     priority + a condition. Every tick we evaluate the entries in
 *     descending priority order and pick the first whose condition is
 *     true. That state's `name` is written to `currentState` (a plain
 *     string, so users can read it as a variable via `var:Char.animState`
 *     once we surface it in the expression layer).
 *
 *   Stage 2 — state → animation. The winning state's `animation` field
 *     is set as SpriteRenderer.currentAnimation. SR plays it.
 *
 * One-shot states (loop=false) latch: once entered they hold until SR's
 * `OnAnimationFinished` fires, regardless of whether their condition is
 * still true. This is what makes attack/hit/death play through cleanly
 * instead of getting clobbered by a lower-priority state the moment the
 * trigger button is released. Looping states (loop=true) re-evaluate
 * every tick.
 *
 * The user adds / edits states from the Overview's Animation Slots table
 * — no event-sheet plumbing for the default flow.
 */

/** A single state-machine entry. Stored on the behavior config as a flat
 *  array so saved projects round-trip cleanly through JSON. */
/** Per-frame position offset applied while a state's main animation
 *  plays a specific frame. Facing-aware: `dx` is in FORWARD-relative
 *  units and gets auto-flipped when the sprite faces left. Use for
 *  attack lunges, dash bursts, slide kicks — the kind of frame-driven
 *  motion that brings attacks to life without baking it into the
 *  sprite art's translation. */
export interface FrameMotion {
  /** 0-indexed frame inside the state's main animation. */
  frame: number;
  /** Forward-relative X offset. Positive = forward. Auto-flipped when
   *  sprite faces left. Accepts a NUMBER or an EXPRESSION STRING —
   *  `random(40, 80)`, `var:dashRange`, `random(-20, 20) + 80`, etc.
   *  Resolved at fire time via the shared numOr evaluator so each
   *  motion can roll fresh randomness per swing. */
  dx: number | string;
  /** Y offset (not flipped; world Y down). Same expression-string
   *  support as `dx`. */
  dy: number | string;
  /** "instant" — set position immediately. "tween" — ease over `duration`
   *  seconds via Phaser tween. */
  mode: "instant" | "tween";
  /** Tween duration in seconds; ignored when `mode` is "instant". */
  duration: number;
  /** When true, the motion is skipped if it would push the body into
   *  a Solid (static body) at the predicted landing position. Uses a
   *  lookahead overlap test against `scene.physics.world.staticBodies`
   *  so "near a wall but not yet touching" cases also skip — not just
   *  the moment of contact. Direction is facing-aware via the dx flip. */
  skipIfBlocked?: boolean;
  /** Name of the combo anim this motion applies to. Empty / missing =
   *  apply to ALL anims (combo or non-combo). When set, the motion
   *  only fires if SR's currentAnimation matches. Lets authors put
   *  every state's motions in a single list and tag each one with the
   *  combo step it belongs to — reorder-safe. */
  anim?: string;
}

/** Per-state mapping of (animation, frame indices) → signal name. The
 *  animator fires `signal` on the sprite's event bus whenever SR enters
 *  any frame in `frames` while playing the named `anim`. Dedup uses the
 *  same frame-enter edge as frameMotions so each visit fires once. */
export interface FrameSignal {
  /** Animation name to match against SR's currentAnimation. Empty =
   *  fire on any animation when the frame matches. */
  anim: string;
  /** Frame indices that trigger the signal. Each visit (frame-enter
   *  edge) fires once; staying on the frame across many ticks does NOT
   *  re-fire. */
  frames: number[];
  /** Signal name to emit. Plug a Tracer's `triggerSignal` here for the
   *  classic "emit on attack hit frame" pattern. */
  signal: string;
  /** Optional broadcast target tag. Empty (or missing) = self-emit —
   *  fires the signal on THIS sprite's bus only (classic Animator
   *  behavior, what every existing row defaulted to). Non-empty =
   *  broadcast — fan the signal out to EVERY live sprite carrying
   *  this tag. Lets a combo frame ping the Player (or all enemies,
   *  the boss, etc.) the same way `EmitSignalTo` does in an action
   *  chain. Self-emit happens regardless of tag so the same row can
   *  both drive a host-side Tracer AND notify a remote target. */
  targetTag?: string;
}

export interface AnimStateDef {
  /** State identifier, also what gets written to `currentState`. */
  name: string;
  /** Higher = wins over conflicting lower-priority states. */
  priority: number;
  /** When 0, the state is skipped by the priority-sorted eval loop —
   *  it never wins, never plays. Toggled at runtime via the
   *  `SetStateEnabled` action. `undefined` is treated as enabled so
   *  existing saved BPs keep working without migration. */
  enabled?: number;
  /** When true, AIBrain stays paused while this state is active.
   *  Tighter coupling than name-matching: rename the state freely,
   *  the flag stays attached. Authors tick this on hurt/death/stunned
   *  states so the brain can't decide to attack mid-stagger. */
  pausesAI?: boolean;
  /** Minimum `PhaseManager.currentPhase` for this state to be eligible.
   *  Undefined = no lower bound (always eligible from phase 0). Used by
   *  Boss BPs to gate phase-2 attacks behind PhaseManager's HP-driven
   *  transitions. State-eval loop skips when currentPhase < minPhase. */
  minPhase?: number;
  /** Maximum `PhaseManager.currentPhase` for this state to be eligible.
   *  Undefined = no upper bound. Set this when a state should ONLY play
   *  in early phases — e.g. a phase-0 weak attack that the enraged
   *  phase-2 boss has outgrown. */
  maxPhase?: number;
  /** SpriteRenderer animation name to play while this state is active. */
  animation: string;
  /** Optional one-shot anim played BEFORE the main loop when the state
   *  first becomes the winner. Examples: jump_start before jump,
   *  crouch_in before crouch. Empty/missing = skip. Also gated by
   *  `useTransitions` so users can toggle the in/out flow off without
   *  losing the saved anim name. */
  enterAnim?: string;
  /** Optional one-shot anim played when the state stops being the winner.
   *  Latches the prior state's priority until the exit anim finishes, so
   *  the next state's enter doesn't kick in immediately. Examples:
   *  crouch_out, attack_recovery. Empty/missing = skip. */
  exitAnim?: string;
  /** @deprecated Use `useEnter` + `useExit` instead. Kept on the type
   *  for backward compat with saved configs — runtime reads it as a
   *  fallback when the new fields are undefined. */
  useTransitions?: boolean;
  /** When true, the animator plays `enterAnim` on state entry. Saved
   *  enter-anim names are kept even when this is false so toggling on
   *  is one click. */
  useEnter?: boolean;
  /** When true, the animator plays `exitAnim` on state exit (delays the
   *  switch to the next state until exit anim ends). Independent from
   *  useEnter so you can have an enter without an exit (common case). */
  useExit?: boolean;
  /** When true, the host body's velocity is zeroed every tick this
   *  state is active in the main phase. Independent from `ignoreInput`
   *  — e.g. a "stunned" state may want both, but a "dash" state may
   *  want `ignoreInput` (no WASD override) without `freezeMovement`
   *  (CM is doing the dash motion and we mustn't zero it). */
  freezeMovement?: boolean;
  /** When true, CharacterMovement's `ignoreInput` flag is set every
   *  tick this state is active in the main phase. CM then ignores
   *  WASD / Jump / etc. so the player can't override the state's
   *  motion. Doesn't zero existing velocity — use `freezeMovement`
   *  for that. Both can be combined. */
  ignoreInput?: boolean;
  /** Per-frame position offsets — fires when SR enters the listed
   *  frame index during the main phase. Facing-aware. */
  frameMotions?: FrameMotion[];
  /** Frame-trigger signals fired when SR enters any of the listed
   *  frames on the matching animation. Each row maps `(anim, frames[])`
   *  to a signal name; emitting on a per-frame edge. Useful for
   *  firing a Tracer's `triggerSignal` from specific attack frames
   *  without setting up an animator event for each one. Multiple rows
   *  on the same state can target different anims or different
   *  signals; an empty `anim` matches every animation. */
  frameSignals?: FrameSignal[];
  /** @deprecated The state machine now reads "is this a one-shot anim"
   *  from the SPRITE ASSET's loop flag (set in the Sprite editor) so
   *  there's one source of truth. This field is kept on the type so
   *  saved configs round-trip cleanly, but the runtime ignores it.
   *  enterAnim and exitAnim are always treated as one-shots regardless. */
  loop: boolean;
  /** When true and the state's main anim is one-shot (sprite asset
   *  loop=false), the state HOLDS on the last frame after the anim
   *  finishes — `_activeStateName` is NOT cleared, so the state keeps
   *  winning (via the active-one-shot branch in Phase B) until its
   *  condition fails. Useful for "death" / "interact" / "land hold"
   *  states where you want the final pose to linger. Default false
   *  (classic behavior: state releases when one-shot main ends, next
   *  state takes over). */
  holdOnFinish?: boolean;
  /** When true, the sprite's facing is LOCKED while this state's animation
   *  plays its cycle — automatic flips (CharacterMovement mirror + AIBrain
   *  auto-face) are suppressed until the main animation completes one cycle,
   *  then the held flip applies. For attacks: the enemy finishes its swing
   *  before turning to a target that moved behind it. Explicit SetFacing
   *  still works. Default false. */
  lockFacing?: boolean;
  /** Ordered list of animations the state cycles through on each
   *  re-entry. attack1 → comboAnimations[0], attack2 → [1], etc.
   *  Each re-entry advances to the next index; once exhausted (or
   *  after the combo window expires) the next entry resets to [0].
   *  When set + non-empty, `animation` is IGNORED for this state —
   *  the combo list is the source of truth. */
  comboAnimations?: string[];
  /** When true, combo steps are picked at random (weighted by
   *  `comboWeights`) instead of advancing sequentially. The combo
   *  window still applies — outside it, history is irrelevant since
   *  selection is independent each entry anyway. */
  comboRandom?: boolean;
  /** Parallel to `comboAnimations`. Per-step weight in 0..100. Used
   *  only when `comboRandom` is true. Steps with weight 0 never play.
   *  Missing entries default to 100 (equal probability). Sum need not
   *  equal 100 — weights are normalized at pick time. */
  comboWeights?: number[];
  /** When true (and `comboRandom` is on), the previously-picked anim
   *  is excluded from the next random selection so no animation plays
   *  twice in a row. Falls back to the full weighted set when there's
   *  only one eligible step left. Off = no constraint, any anim can
   *  repeat back-to-back (default). */
  comboRandomNoRepeat?: boolean;
  /** Per-state override for the combo window (seconds). When omitted,
   *  the animator-level default `comboWindow` is used. Window times
   *  out from the last combo anim's main-end — pressing the trigger
   *  after expiry resets the chain to index 0. */
  comboWindow?: number;
  /** Per-state hysteresis override (milliseconds). Replaces the
   *  animator-wide 60 ms default when THIS state is the prior active
   *  one being considered for sticking through condition flicker.
   *  Lower = releases faster (precision games); higher = stickier
   *  (slow combat states). Falls back to 60 ms when 0/missing. */
  hysteresisMs?: number;
  /** Per-state re-entry guard override (milliseconds). Replaces the
   *  animator-wide 80 ms default. Controls the window during which
   *  re-entering the same state skips its enter anim (avoids enter
   *  replay on flicker). Falls back to 80 ms when 0/missing. */
  reEntryGuardMs?: number;
  /** Replay the state's animation from frame 0 whenever its (signal-driven)
   *  condition RE-FIRES while the state is already active. Without this, a
   *  2nd hit landing mid-hurt does nothing visible because the animator
   *  doesn't re-enter a state it's already in. Use for hurt / flinch states
   *  driven by `signalFired` (e.g. OnDamageTaken) so every hit re-flinches. */
  retrigger?: boolean;
  /** Primary condition — full Logic Sheet `Condition` shape. Any of the
   *  75+ ConditionKinds can be used: Compare, OnKeyPressed, IsTracerHit,
   *  IsAIState, CompareValues with var:/tracer:/weapon: expressions, etc.
   *  Replaces the old conditionKind/Action/Threshold quartet. */
  primary: Condition;
  /** Additional conditions ANDed with the primary by default (combine
   *  governed by `matchAny`). Each entry is a full Logic Sheet `Condition`. */
  extras?: Condition[];
  /** Top-level combine for (primary + extras + the folded sub-group). Omitted/
   *  false = AND, true = OR. */
  matchAny?: boolean;
  /** One nested level of sub-conditions, indented under the top conditions.
   *  They combine among themselves via `subMatchAny`, then fold into the top
   *  level as ONE additional term (joined by `matchAny`). This 2-level tree is
   *  what expresses "moving AND (facing right OR left)" in one state:
   *  primary = IsMoving, matchAny = false (AND), subs = [IsFacingRight,
   *  IsFacingLeft], subMatchAny = true (OR). */
  subs?: Condition[];
  /** Combine for the sub-conditions: false/omitted = AND, true = OR. */
  subMatchAny?: boolean;
}

/** Shape of a Tracer's `lastHit` payload — mirrors the TracerHit
 *  interface in `Tracer.ts`. Duplicated here as a structural type so we
 *  don't pull in a runtime dependency on the Tracer class (the animator
 *  reaches it via `findBehaviorsByKind("Tracer")`). */
interface TracerHitLike {
  hitX?: number;
  hitY?: number;
  actorX?: number;
  actorY?: number;
  actorName?: string;
  actorUid?: number;
  actorTags?: string[];
  distance?: number;
  [k: string]: unknown;
}

/** Conditions that fire for exactly ONE tick. State-level hysteresis
 *  skips its 60ms hold when the new winner uses one of these — otherwise
 *  the edge is gone before hysteresis releases and the state never gets
 *  picked. Canonical example: fall (high prio, looping) is active when
 *  the player lands; OnLand fires on the touchdown frame; without this
 *  exemption hysteresis keeps fall winning and land is skipped. */
const EDGE_CONDITION_KINDS: ReadonlySet<ConditionKind> = new Set<ConditionKind>([
  "OnLand", "JustTurnedLeft", "JustTurnedRight", "JustWallJumped",
  "JustCollidedWithTag", "JustSeparatedFromTag",
  "SignalFiredEdge", "TracerJustHit",
  "OnKeyPressed", "InputBuffered",
  "OnJump", "OnFall", "OnDashStart", "OnDashEnd",
  "OnMoved", "OnStopped",
]);

/** 8-way facing buckets indexed by `round(atan2(vy, vx) / 45°) mod 8`.
 *  Phaser is Y-down, so +y is "down". The `facingDir` condition compares
 *  against these exact strings (the editor's direction dropdown uses them). */
const FACING_DIRS_8 = ["right", "downright", "down", "downleft", "left", "upleft", "up", "upright"] as const;

export class CharacterAnimator extends Behavior {
  // Display name "State Machine". Class/file kept as `CharacterAnimator`;
  // the saved + lookup kind string is "StateMachine".
  kind = "StateMachine";

  /** State machine entries for the CURRENTLY ACTIVE machine. Points at one
   *  of `_machines`' arrays; repointed by `setActiveMachine`. The eval loop
   *  reads this. Initially the primary machine (from `config.states`). */
  states: AnimStateDef[] = [];

  // ── Multiple state machines ─────────────────────────────────────────────
  // A BP can host several named machines; exactly one is active at a time.
  // The primary machine IS `states` (above) — kept as its own field so every
  // existing save keeps working untouched. Extra machines live in
  // `stateMachines`. Switch the active one at runtime via `setActiveMachine`
  // (the `SetActiveStateMachine` action). Activating a machine deactivates
  // the rest (exclusive); "" = no machine active (animator idles).
  /** Display name of the primary machine (the one backed by `states`). */
  machineName = "Main";
  /** Extra named machines beyond the primary. */
  stateMachines: { id?: string; name: string; states: AnimStateDef[] }[] = [];
  /** Name active at spawn. Empty → the primary machine. */
  activeMachine = "";
  /** name → states, built in init() from the primary + `stateMachines`. */
  private _machines: Map<string, AnimStateDef[]> = new Map();
  /** Name of the machine currently driving (mirrored into save data). */
  private _activeMachineName = "";
  /** Per-input gates. Each entry says "input X is ALLOWED only when
   *  these conditions all match". Empty conditions = no gate (always
   *  allowed). Recomputed each tick into `blockedActions`. Other
   *  behaviors (notably CharacterMovement) consult `blockedActions`
   *  before reading input, so a failing gate makes the action invisible
   *  to gameplay code. */
  inputGates: { action: string; conditions: Condition[] }[] = [];
  /** Set of input-action names blocked this tick. Recomputed at the
   *  start of every update(). Empty when no gates fail. Public so CM
   *  can read it cheaply via `findBehaviorByKind`. */
  blockedActions: Set<string> = new Set();
  /** True while the active `lockFacing` state's swing is mid-animation.
   *  Recomputed every tick at the top of update() (NOT latched) from the
   *  active state + SR frame. CharacterMovement's mirror and AIBrain's
   *  auto-face read this (via findBehaviorByKind) and skip their facing writes
   *  while it's true, so a swing finishes before the sprite turns — and the
   *  enemy re-faces at the next swing's frame 0. */
  facingLocked = false;
  /** Persistent 8-way movement facing (one of FACING_DIRS_8). Updated from
   *  body velocity while moving, HELD when idle — so topdown idle anims keep
   *  facing the last walked direction. Read by the `facingDir` condition.
   *  Default "down" (typical spawn-facing for a topdown character). */
  facingDir: string = "down";
  /** Last winning state's name. Mutated each tick. */
  currentState = "";
  /** Forced state name — set by a nav waypoint's "set state on arrive" rule.
   *  When set to a valid state, it WINS over condition selection (the NPC is
   *  pinned to it) until another waypoint sets a different one. "" = normal. */
  forcedState = "";
  /** Name of the state that was the winner BEFORE the current one.
   *  Empty until at least one transition has occurred. Read via the
   *  `previousStateWas` condition. Captured at the moment of state
   *  transition (Phase C, fresh state entry path). */
  previousState = "";
  /** SR animation that was playing when the previous state ended
   *  (i.e. at the moment of transition). Captured alongside
   *  `previousState`. Useful for combo follow-up checks ("if last
   *  attack anim was attack3, …"). */
  previousAnim = "";
  /** Default combo-window in seconds — per-state overrides take priority.
   *  Combo states with this window or shorter must chain before the
   *  timer elapses or the next press resets the chain to step 1. */
  comboWindow = 0.4;
  /** Input buffer window in milliseconds. Each input action's most
   *  recent JustPressed tick is stamped per-tick. The `inputBuffered`
   *  condition checks "was this action pressed within the last
   *  inputBufferMs". Lets authors layer a buffered fallback under an
   *  edge-only `inputPressed` so a press 5 frames before the current
   *  attack ends still triggers the next combo step. Setting this
   *  to 0 disables buffering (only edge-triggered presses fire). */
  inputBufferMs = 120;
  /** Per-input-action wall-clock ms of the last JustPressed sample.
   *  Stamped at the top of every update() for every named project
   *  input action. `inputBuffered` reads this. A consumed buffer
   *  (state win) clears the entry so a single press only fires once. */
  private _bufferedInputAtMs: Map<string, number> = new Map();
  /** Per-state: index into the state's `comboAnimations` list to play
   *  on the NEXT entry. Advanced on each entry; reset to 0 when the
   *  window expires or the list end is reached. */
  private _stateComboNextIdx: Map<string, number> = new Map();
  /** Per-state: sim-time when the most recent combo anim's main ended.
   *  Window check uses `now - this > window` to decide whether to
   *  reset the combo index back to 0. */
  private _stateComboLastEndAt: Map<string, number> = new Map();
  /** Accumulated sim time in seconds. Advances by `delta` each update.
   *  Used by combo-window checks so chain progression respects scene
   *  timeScale (paused game freezes the combo window too). */
  private _simTime = 0;

  private _onAnimEndUnsub: (() => void) | null = null;
  /** Current play phase for the active state:
   *   - "enter" — the state's enterAnim is playing (one-shot)
   *   - "main"  — the state's main animation is playing
   *   - "exit"  — the PREVIOUS state's exitAnim is playing while we hold
   *               off on switching to the new winner
   *
   *  enter/exit are one-shot latches released by `OnAnimationFinished`.
   *  main is one-shot when the SPRITE ASSET's loop is false; loops otherwise. */
  private _phase: "enter" | "main" | "exit" = "main";
  /** Read-only view of `_phase` for other behaviors. CharacterMovement
   *  reads this to gate its wall-slide physics block — e.g. so the
   *  vy clamp + gravity cap can be configured to engage only once the
   *  Main animation starts, leaving the In anim's first ~milliseconds
   *  at normal fall speed. */
  get phase(): "enter" | "main" | "exit" { return this._phase; }
  /** Which state's enter / main is being played, or whose exit is winding
   *  down. Cleared on phase=main transitions when the active state ends. */
  private _activeStateName = "";
  /** True while an `ignoreInput` STATE is the one holding CM's ignoreInput
   *  flag. Gates `releaseFreezeMovement` so a routine state change doesn't
   *  clear an ignoreInput that the AUTHOR set manually (e.g. a pause-menu
   *  input lock toggled from the Logic Sheet). */
  private _animOwnsIgnoreInput = false;
  /** Priority-sorted view of `states`, rebuilt only when the order can change
   *  (state set swapped, or a priority changed via SetStatePriority) — NOT
   *  every tick. `enabled` toggles don't reorder, and the entries are the same
   *  object refs, so the eval loop reads `enabled`/`priority` live off them. */
  private _sortedStates: AnimStateDef[] | null = null;
  private getSortedStates(): AnimStateDef[] {
    if (!this._sortedStates) this._sortedStates = [...this.states].sort((a, b) => b.priority - a.priority);
    return this._sortedStates;
  }
  /** Drop the sort cache so the priority order rebuilds next eval. Called when
   *  the state set changes or a SetStatePriority action runs. */
  invalidateStateOrder(): void { this._sortedStates = null; }
  /** Per-state wall-clock (sim ms) of the last `retrigger` anim restart —
   *  rate-limited by the state's reEntryGuard so a signal's 1-frame carryover
   *  doesn't double-restart. */
  private _lastRetriggerMs: Record<string, number> = {};
  /** State def we're transitioning TO once an exit phase finishes. */
  private _pendingNextStateName = "";
  /** Set true on the frame `OnAnimationFinished` fires so update() can
   *  advance phase exactly once. Reset at the end of update(). */
  private _animEndedThisTick = false;
  /** Previous-tick airborne state — edge-detect for `justLanded`. */
  private _wasAirborne = false;
  /** True for the one tick the body transitioned airborne → grounded.
   *  Recomputed at the top of every update() before condition eval. */
  private _justLanded = false;
  /** Previous-tick facing sign — edge-detect for `justTurnedLeft/Right`. */
  private _prevFacing: 1 | -1 = 1;
  private _justTurnedLeft = false;
  private _justTurnedRight = false;
  /** Previous-tick SR frame index — edge-detect for FrameMotion triggers
   *  so each motion fires exactly once per frame visit (not every tick
   *  the frame stays displayed). */
  private _prevSRFrame = -1;
  /** Name of the state whose main phase the previous frame-motion check
   *  was scoped to. Reset on state change so frame motions don't fire
   *  across state boundaries. */
  private _prevFrameMotionState = "";
  /** Frames whose FrameMotion(s) already fired during the active state's
   *  current cycle. Prevents looping anims from re-firing motions every
   *  pass (character drift) while still letting each fresh state
   *  activation fire its motions once. Reset on state change AND on
   *  loop-wrap for looping states. */
  private _firedFramesInState: Set<number> = new Set();
  /** Last clip the frame-trigger pass saw. enter / main / exit each play a
   *  different clip; when it changes we reset `_firedFramesInState` so the new
   *  clip's frame signals/motions fire fresh (frame indices would otherwise
   *  collide across the three clips of one state). */
  private _prevFrameAnim = "";
  /** Reference to the most recent frame-motion tween. Killed before a
   *  new tween starts so positional offsets don't stack when motions
   *  overlap (e.g. tween at frame 4 still in flight when frame 10 hits). */
  private _activeFrameTween: Phaser.Tweens.Tween | null = null;
  /** Wall-clock ms of the most recent tick each state was the active
   *  winner. Updated every tick after the winner is decided. Used by
   *  `enterState` to skip the enter anim when re-entering a state we
   *  were active in very recently — flicker-proof against any
   *  underlying condition toggling for 1-N ticks (wall-slide losing
   *  wall contact briefly, fall winning, then wallslide back). Real
   *  re-triggers (a state that was last active seconds ago) still
   *  play the enter as expected. */
  private _lastActiveAtMs: Record<string, number> = {};
  /** 1 = render a small text overlay above the sprite showing the
   *  animator's current state, phase, SR anim, SR frame. Use to debug
   *  "what's actually firing" without re-reading code. */
  debugDraw = 0;
  private _debugText?: Phaser.GameObjects.Text;
  /** Diagnostic dedup — prevents the hold-on-finish console log from
   *  spamming every tick while a state is held. Cleared when the state
   *  releases so the next entry into hold logs again. */
  private _lastLoggedHold: Set<string> = new Set();
  private _lastLoggedNotOneShot: Set<string> = new Set();

  init(): void {
    // Build the name→states map: the primary machine (backed by `states`)
    // plus every entry in `stateMachines`. Later same-name entries win — a
    // primary/extra name clash keeps the primary (registered first, then not
    // overwritten by the guard below).
    this._machines = new Map();
    const primaryName = this.machineName || "Main";
    this._machines.set(primaryName, this.states);
    for (const m of this.stateMachines) {
      if (m && m.name && !this._machines.has(m.name)) {
        this._machines.set(m.name, Array.isArray(m.states) ? m.states : []);
      }
    }
    // Point `states` at the active machine. Default = primary. Empty/unknown
    // active name leaves the animator idle (states = []), so it doesn't drive.
    const wantActive = this.activeMachine || primaryName;
    if (this._machines.has(wantActive)) {
      this._activeMachineName = wantActive;
      this.states = this._machines.get(wantActive)!;
      this._sortedStates = null;
    } else {
      this._activeMachineName = "";
      this.states = [];
      this._sortedStates = null;
    }

    // SR's `OnAnimationFinished` fires when ANY animation's last frame is
    // shown. We just flag the tick; update() inspects current phase and
    // decides what to do (enter→main, main→done if one-shot, exit→advance
    // to pending next state). Single source of truth for anim-end edges.
    this._onAnimEndUnsub = this.sprite.events.on("OnAnimationFinished", () => {
      this._animEndedThisTick = true;
    });
  }

  /** Switch which named machine drives this object (exclusive). `""` /
   *  "(none)" deactivates all — the animator idles and the SpriteRenderer
   *  holds its last frame. No-op (with a one-time warn) on an unknown name so
   *  a typo isn't silent. Resets per-state bookkeeping so the new machine
   *  re-evaluates from scratch on the next tick. */
  setActiveMachine(name: string): void {
    const want = (name ?? "").trim();
    if (want === "" || want === "(none)") {
      this._activeMachineName = "";
      this.states = [];
      this._sortedStates = null;
      this._resetStateBookkeeping();
      return;
    }
    const next = this._machines.get(want);
    if (!next) {
      Logger.log({
        level: "warn",
        source: "StateMachine",
        message: `Activate State Machine: "${want}" is not a machine on "${this.sprite.blueprintName || this.sprite.instanceName || "?"}". Known: [${[...this._machines.keys()].join(", ")}].`,
      });
      return;
    }
    if (want === this._activeMachineName) return;
    this._activeMachineName = want;
    this.states = next;
    this._sortedStates = null;
    this._resetStateBookkeeping();
  }

  /** Wipe the per-state runtime so a freshly-activated machine starts clean
   *  (the previous machine's state name / phase / combo timers don't leak in). */
  private _resetStateBookkeeping(): void {
    this.currentState = "";
    this.previousState = "";
    this.previousAnim = "";
    this._phase = "main";
    this._activeStateName = "";
    this._pendingNextStateName = "";
    this._animEndedThisTick = false;
    this._prevFrameMotionState = "";
    this._prevSRFrame = -1;
    this._bufferedInputAtMs.clear();
    this._stateComboNextIdx.clear();
    this._stateComboLastEndAt.clear();
    this._firedFramesInState.clear();
    this._lastRetriggerMs = {};
    this._lastActiveAtMs = {};
    this._lastLoggedHold.clear();
    this._lastLoggedNotOneShot.clear();
    this._activeFrameTween?.stop();
    this._activeFrameTween = null;
  }

  serialize(): Record<string, unknown> {
    // Round-trip only the active machine so a SaveSlot mid-phase resumes on
    // the right one. currentState/anim are re-derived next tick; SR persists
    // its own currentAnimation.
    return { activeMachine: this._activeMachineName };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.activeMachine === "string") {
      // Force the switch even if it equals the spawn default, so `states` is
      // repointed correctly after a load that cleared runtime state.
      this._activeMachineName = "";
      this.setActiveMachine(state.activeMachine);
    }
  }

  onDestroy(): void {
    this._onAnimEndUnsub?.();
    this._onAnimEndUnsub = null;
    // Frame-motion tweens are raw Phaser tweens, not registered in
    // sprite.tweens, so Sprite.destroy()'s tween wipe misses them — stop here
    // or a mid-lunge death leaves the tween animating a freed body.
    this._activeFrameTween?.stop();
    this._activeFrameTween = null;
    this._debugText?.destroy();
    this._debugText = undefined;
  }

  /** Render / refresh the debug HUD overlay. Lazy-create on first call
   *  when debugDraw is on; clear/destroy when toggled off. */
  private drawDebug(sr: { currentAnimation: string; currentFrameIdx?: number } | undefined): void {
    if (!this.debugDraw) {
      this._debugText?.destroy();
      this._debugText = undefined;
      return;
    }
    if (!this._debugText) {
      this._debugText = this.sprite.scene.add.text(0, 0, "", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "10px",
        color: "#7cf",
        backgroundColor: "rgba(0,0,0,0.6)",
        padding: { left: 4, right: 4, top: 2, bottom: 2 },
      });
      setupCrispText(this._debugText);
      this._debugText.setDepth(this.sprite.gameObject.depth + 100);
      this.sprite.routeOverlayToCamera(this._debugText);
    }
    const obj = this.sprite.gameObject;
    const lines = [
      `state: ${this.currentState || "—"}`,
      `phase: ${this._phase}`,
      `active: ${this._activeStateName || "—"}`,
      `anim:  ${sr?.currentAnimation ?? "—"}`,
      `frame: ${sr?.currentFrameIdx ?? "—"}`,
      `facingDir: ${this.facingDir}`,
      `facingLk: ${this.facingLocked ? "LOCKED" : "free"} (state.lockFacing=${!!this.findState(this._activeStateName)?.lockFacing})`,
      this._pendingNextStateName ? `pending: ${this._pendingNextStateName}` : "",
    ].filter(Boolean);
    this._debugText.setText(lines.join("\n"));
    // Anchor above the sprite — top-center, with a small gap.
    this._debugText.setPosition(obj.x - this._debugText.width / 2, obj.y - 80);
  }

  update(_delta: number): void {
    // Sim-time accumulator for the combo-window check. _delta is
    // already scene-timeScale-adjusted by Sprite.tick, so pausing the
    // game freezes combo timers too.
    this._simTime += _delta / 1000;
    // Decision throttle — on non-decision frames (BP decisionTickRate > 1, big
    // swarms) skip state RE-SELECTION entirely. SpriteRenderer keeps stepping
    // the current animation's frames and MoveTo keeps moving, so motion stays
    // smooth; only the "which state should I be in" choice is throttled. NOTE:
    // frame-signals / frame-motions and per-tick freeze/ignore-input effects are
    // also evaluated at the reduced rate — intended for simple background NPCs,
    // not combat actors (leave their decisionTickRate at 1).
    if (!this.sprite._decisionFrame) return;
    // Default off every tick; recomputed below. No active state (or no sprite)
    // ⇒ never locked, so the sprite is free to face normally.
    this.facingLocked = false;
    const sr = this.sprite.findBehaviorByKind("SpriteRenderer");
    if (!sr) { this.drawDebug(undefined); return; }
    if (!Array.isArray(this.states) || this.states.length === 0) {
      this.drawDebug(sr as { currentAnimation: string; currentFrameIdx?: number });
      return;
    }

    // Forced state (nav waypoint "set state on arrive"). Pins the state over
    // condition selection until a waypoint changes/clears it.
    if (this.forcedState) {
      const fs = this.findState(this.forcedState);
      if (fs) {
        // A ONE-SHOT arrival anim ("eat", "mine") auto-releases once it has
        // played through, so the NPC falls to idle for the rest of the wait
        // instead of freezing on its last frame. Looping states ("sleep") and
        // holdOnFinish states still pin. Clearing the pin here drops into the
        // normal one-shot release path below, which picks idle this same tick.
        const srFinished = (sr as { finishedEmitted?: boolean }).finishedEmitted === true;
        const playedOut = this._activeStateName === fs.name && this._phase === "main"
          && srFinished && this.isMainOneShot(fs, sr) && !fs.holdOnFinish;
        if (playedOut) {
          this.forcedState = "";
        } else {
          if (this._activeStateName !== fs.name) {
            this.previousState = this._activeStateName;
            this.previousAnim = (sr as { currentAnimation?: string }).currentAnimation ?? "";
            this.enterState(fs, sr);
          }
          this.currentState = fs.name;
          this.applyAdvancedPerTick(fs, sr);
          this.drawDebug(sr as { currentAnimation: string; currentFrameIdx?: number });
          return;
        }
      }
    }

    // Facing lock — COMPUTED each tick, not latched. A `lockFacing` state holds
    // the sprite's facing while its swing is mid-animation (frame > 0), so an
    // attacking enemy doesn't flip toward a target that slipped behind it. It's
    // free on frame 0 (each swing's start, so the enemy picks the direction for
    // THIS swing) and once a one-shot has finished — which is what lets the
    // enemy re-face between swings instead of staying stuck. A latched lock
    // dead-ended here: it re-armed on the next swing's entry before AIBrain ever
    // saw an unlocked tick, so the enemy never turned.
    {
      const ls = this._activeStateName ? this.findState(this._activeStateName) : null;
      // Lock facing for the ENTIRE swing — in / main / out — the whole time a
      // lockFacing state is active. The old `lf > 0` and `!finished` gates
      // unlocked a SINGLE-FRAME main (frame 0, finishes immediately) and a
      // held one-shot, letting the enemy turn mid-attack. Re-facing between
      // swings happens in the rest/chase states, which aren't lockFacing, so
      // the brain still gets unlocked ticks there to re-aim.
      this.facingLocked = !!ls?.lockFacing
        && (this._phase === "enter" || this._phase === "main" || this._phase === "exit");
    }

    // Frame-level edge detection — compute ONCE here so every state's
    // condition evaluation sees the same answer (avoids two `justLanded`
    // states disagreeing within a single tick).
    const body = this.sprite.body;
    const groundedNow = body ? (body.blocked.down || body.touching.down) : false;
    this._justLanded = this._wasAirborne && groundedNow;
    this._wasAirborne = !groundedNow;
    // Facing flip edge detection. `sprite.facingScaleX` is +1 (right) or
    // -1 (left); the animator's edge flags fire for exactly one tick
    // after the flip so turn_left / turn_right states can latch their
    // one-shot anim.
    const facingNow: 1 | -1 = this.sprite.facingScaleX < 0 ? -1 : 1;
    this._justTurnedLeft  = this._prevFacing === 1  && facingNow === -1;
    this._justTurnedRight = this._prevFacing === -1 && facingNow === 1;
    this._prevFacing = facingNow;

    // Persistent 8-way movement facing for topdown directional anims. Only
    // update while actually moving (> 8 px/s) so idle keeps facing the last
    // walked direction — the `facingDir` condition reads this. Works for any
    // controller that sets body velocity (TopdownMovement, MoveTo, SetVelocity).
    if (body) {
      const vx = body.velocity.x, vy = body.velocity.y;
      if (Math.hypot(vx, vy) > 8) {
        const idx = ((Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) % 8) + 8) % 8;
        this.facingDir = FACING_DIRS_8[idx];
      }
    }

    // Stamp the input buffer for every named input action that fired
    // JustPressed this tick. The `inputBuffered` condition reads these
    // stamps so a press shortly BEFORE the current state ends can still
    // trigger the next state (e.g. combo follow-up). enterState clears
    // the entry it consumes so a single press fires exactly once.
    if (this.inputBufferMs > 0) {
      const inputs = getInputActions(this.sprite.scene);
      if (inputs) {
        const nowMs = this.sprite.scene.time.now;
        for (const name of inputs.actionNames()) {
          if (inputs.justPressed(name)) this._bufferedInputAtMs.set(name, nowMs);
        }
      }
    }

    // Recompute input gates each tick — for every gate whose conditions
    // don't all match, mark its action as blocked. Other behaviors
    // (CharacterMovement) check this set before reading input, so a
    // failing gate makes the action invisible to gameplay code.
    this.blockedActions.clear();
    if (Array.isArray(this.inputGates) && this.inputGates.length > 0) {
      for (const g of this.inputGates) {
        if (!g.action) continue;
        let allow = true;
        if (g.conditions && g.conditions.length > 0) {
          for (let i = 0; i < g.conditions.length; i++) {
            if (!this.evalRow(g.conditions[i], `gate:${g.action}:${i}`)) { allow = false; break; }
          }
        }
        if (!allow) this.blockedActions.add(g.action);
      }
    }

    // Synthetic anim-end via wrap detection. SR fires OnAnimationFinished
    // only when the asset has loop=false. For enter/exit phases (always
    // one-shot conceptually) and one-shot main anims, ALSO treat an SR
    // frame-index wrap (frameIdx decreased) as the anim ending. Without
    // this, an enter anim like `wallslide_in` whose asset has loop=true
    // cycles forever and never transitions to the main anim. Skipped
    // for looping main anims where wraps are normal and expected.
    const srFrameNow = (sr as { currentFrameIdx?: number }).currentFrameIdx ?? -1;
    if (srFrameNow >= 0 && this._prevSRFrame >= 0 && srFrameNow < this._prevSRFrame) {
      if (this._phase === "enter" || this._phase === "exit") {
        this._animEndedThisTick = true;
      } else if (this._phase === "main" && this._activeStateName) {
        const active = this.findState(this._activeStateName);
        if (active && this.isMainOneShot(active, sr)) {
          this._animEndedThisTick = true;
        }
      }
    }

    // Phase A: handle anim-end edges. enter→main, main→done(one-shot)→re-eval,
    // exit→advance to pending next. After this block, _phase reflects the
    // post-edge reality for this tick.
    if (this._animEndedThisTick) {
      this._animEndedThisTick = false;
      if (this._phase === "enter") {
        const active = this.findState(this._activeStateName);
        this._phase = "main";
        if (active) {
          this.sprite.events.emit(`OnStateMain_${active.name}`);
          this.sprite.events.emit("OnStateMain");
        }
        // Pick the combo anim that was selected in enterState (the one
        // immediately before the just-advanced next-index) when the
        // state has a combo list; otherwise fall back to state.animation.
        let mainAnim = active?.animation ?? "";
        if (active && this.comboList(active).length > 0) {
          const nextIdx = this._stateComboNextIdx.get(active.name) ?? 1;
          const curIdx = Math.max(0, nextIdx - 1);
          mainAnim = active.comboAnimations![curIdx] ?? active.comboAnimations![0];
        }
        if (active && mainAnim) {
          sr.currentAnimation = mainAnim;
          sr.playing = 1;
          // Force SR reset for the main anim — same lastAnimName clear
          // trick used in enterState so the main anim plays from frame 0
          // regardless of whether SR thinks it was already on this name.
          // Cast via `unknown` because `lastAnimName` is private on the
          // concrete SpriteRenderer type — we're poking it deliberately.
          const srMut = sr as unknown as { lastAnimName?: string; currentFrameIdx?: number; finishedEmitted?: boolean };
          srMut.lastAnimName = "";
          srMut.currentFrameIdx = 0;
          srMut.finishedEmitted = false;
          // Reset wrap tracking since the main anim is a fresh playback.
          this._prevSRFrame = -1;
        }
      } else if (this._phase === "exit") {
        // Exit anim done — apply the pending next state (enter or main).
        // Release the exit phase's freeze/ignoreInput first; the next state's
        // own applyAdvancedPerTick re-applies them this tick if it wants them.
        this.releaseFreezeMovement();
        const next = this.findState(this._pendingNextStateName);
        this._pendingNextStateName = "";
        if (next) {
          this.enterState(next, sr);
        } else {
          this._phase = "main";
          this._activeStateName = "";
        }
      } else if (this._phase === "main") {
        // Main-anim ended. If the main anim's ASSET is non-looping
        // (loop=false in the Sprite editor), release the latch so a
        // different state can win — UNLESS the state has `holdOnFinish`
        // set, in which case keep `_activeStateName` so the state holds
        // on its last frame until its condition fails.
        const active = this.findState(this._activeStateName);
        if (this.debugDraw) {
          const oneShot = !!(active && this.isMainOneShot(active, sr));
          const holdFlag = !!active?.holdOnFinish;
          console.log(`[Animator] ${active?.name ?? "(no state)"} main-anim ended — oneShot=${oneShot} holdOnFinish=${holdFlag} → ${oneShot ? (holdFlag ? "HOLD" : "RELEASE (no hold)") : "(ignored — anim is looping)"}`);
        }
        if (active && this.isMainOneShot(active, sr)) {
          // Stamp the combo-window timer for this state — even a held
          // state has "completed" its anim and starts the window for
          // the next re-entry (which would play comboAnimations[next]).
          if (this.comboList(active).length > 0) {
            this._stateComboLastEndAt.set(active.name, this._simTime);
          }
          // Hold (don't release) when holdOnFinish OR the condition is a held/
          // continuous one — releasing there machine-guns the state (the
          // run↔Block oscillation that flickers ignoreInput).
          if (!this.holdsOnFinish(active, sr)) {
            this._activeStateName = "";
          }
        }
      }
    }

    // Phase B: pick the winning state (highest priority whose condition matches).
    // If we're currently in enter or exit, the active/transitioning state has
    // priority over re-evaluation — animation transitions don't get clobbered
    // mid-play. Same for one-shot main holds (state with loop=false still
    // playing its main anim).
    let winning: AnimStateDef | null = null;
    if (this._phase === "enter" || this._phase === "exit") {
      // A HIGHER-priority state (e.g. hurt) interrupts the IN / OUT clip too —
      // not just main. It's a forced interrupt, so the in/out clip is abandoned
      // and the preempting state plays IMMEDIATELY (no exit anim of the
      // interrupted state). This is why hurt didn't fire while an attack was in
      // its PreAttack / AttackEnd clip.
      const interrupted = this.findState(this._activeStateName);
      const pre = interrupted ? this.findPreempt(interrupted.priority) : null;
      if (pre) {
        this.releaseFreezeMovement();
        this.sprite.events.emit(`OnStateExit_${this._activeStateName}`);
        this.sprite.events.emit("OnStateExit");
        this.previousState = this._activeStateName;
        this.previousAnim = (sr as { currentAnimation?: string }).currentAnimation ?? "";
        this.enterState(pre, sr);
        this.applyAdvancedPerTick(pre, sr);
        this.drawDebug(sr as { currentAnimation: string; currentFrameIdx?: number });
        return;
      }
      // Stay locked to the active enter / exit anim — winner is whoever
      // owns the active or pending name.
      winning = this.findState(
        this._phase === "exit" ? this._pendingNextStateName : this._activeStateName,
      );
      if (this._phase === "exit") {
        // Apply the EXITING state's advanced effects during its OUT anim too —
        // freezeMovement / ignoreInput / frame motions+signals — so they cover
        // the full in → main → out, not just main. (lockFacing is computed
        // each tick at the top and already includes the exit phase.) Released
        // when the exit ends (Phase A → releaseFreezeMovement before enterState).
        const exiting = this.findState(this._activeStateName);
        if (exiting) this.applyAdvancedPerTick(exiting, sr);
        // Still holding the prior state's exit anim — don't switch SR yet.
        this.currentState = this._activeStateName;
        return;
      }
    } else if (this._activeStateName) {
      // We're in main phase. Active state holds if its main anim's
      // ASSET is non-looping (one-shot) — Phase A cleared the latch
      // when the anim ended unless `holdOnFinish` is set.
      const active = this.findState(this._activeStateName);
      if (active && this.isMainOneShot(active, sr)) {
        const animFinished = (sr as { finishedEmitted?: boolean }).finishedEmitted === true;
        if (!animFinished) {
          // Anim still playing — sticky lock normally keeps the state
          // winning regardless of condition (a one-shot anim must play
          // through). EXCEPTION: a HIGHER-priority state whose condition
          // matches THIS frame preempts the lock — so hurt (110) can
          // interrupt attack (90) mid-swing. Same-or-lower priority
          // states can't break in (preserves the play-through guarantee
          // against re-entry of the active state itself or lower-prio
          // ambient states).
          let preempt: AnimStateDef | null = null;
          const sortedHigher = this.getSortedStates()
            .filter((s) => s.enabled !== 0 && s.priority > active.priority);
          let curPhaseCache: number | undefined;
          for (const s of sortedHigher) {
            if (s.minPhase !== undefined || s.maxPhase !== undefined) {
              if (curPhaseCache === undefined) {
                const pm = this.sprite.findBehaviorByKind("PhaseManager") as { currentPhase?: number } | undefined;
                curPhaseCache = pm?.currentPhase ?? 0;
              }
              if (s.minPhase !== undefined && curPhaseCache < s.minPhase) continue;
              if (s.maxPhase !== undefined && curPhaseCache > s.maxPhase) continue;
            }
            if (this.evaluate(s)) { preempt = s; break; }
          }
          winning = preempt ?? active;
        } else if (this.holdsOnFinish(active, sr) && this.evaluate(active)) {
          // Anim ended + (holdOnFinish OR continuous condition) + condition
          // still matches → keep the state pinned on its last frame — UNLESS
          // a HIGHER-priority state matches this frame, which PREEMPTS the
          // hold. Without this, a held block could never be interrupted by a
          // higher-priority attack — you'd have to drop the block input
          // first. Mirrors the mid-play preempt loop above.
          let preempt: AnimStateDef | null = null;
          const sortedHigher = this.getSortedStates()
            .filter((s) => s.enabled !== 0 && s.priority > active.priority);
          let curPhaseCache: number | undefined;
          for (const s of sortedHigher) {
            if (s.minPhase !== undefined || s.maxPhase !== undefined) {
              if (curPhaseCache === undefined) {
                const pm = this.sprite.findBehaviorByKind("PhaseManager") as { currentPhase?: number } | undefined;
                curPhaseCache = pm?.currentPhase ?? 0;
              }
              if (s.minPhase !== undefined && curPhaseCache < s.minPhase) continue;
              if (s.maxPhase !== undefined && curPhaseCache > s.maxPhase) continue;
            }
            if (this.evaluate(s)) { preempt = s; break; }
          }
          winning = preempt ?? active;
          if (this.debugDraw && winning === active && !this._lastLoggedHold.has(active.name)) {
            console.log(`[Animator] ${active.name} HOLDING on last frame (holdOnFinish + condition still matches)`);
            this._lastLoggedHold.add(active.name);
          }
        } else {
          // Either no hold, or hold but condition failed — release the
          // lock and let normal eval pick the next state.
          if (this.debugDraw && active.holdOnFinish) {
            const dkp = `${this._activeMachineName}:${active.name}:`;
            const primary = this.evalRow(active.primary, `${dkp}p`);
            const extras = (active.extras ?? []).map((c, i) => `${c.not ? "!" : ""}${c.kind}=${this.evalRow(c, `${dkp}e${i}`)}`).join(", ");
            const vy = (this.sprite.body as { velocity?: { y?: number } } | undefined)?.velocity?.y ?? "?";
            console.log(`[Animator] ${active.name} RELEASING — holdOnFinish=true BUT condition failed. kind=${active.primary.kind} primary=${primary} extras=[${extras}] vy=${vy}`);
          }
          this._lastLoggedHold.delete(active.name);
          // When the released state has an exit anim, DON'T clear
          // `_activeStateName` here — leave it so Phase C's transition sees it
          // as `prior` and plays the exit (e.g. attack → attack_out). Clearing
          // it directly made `prior` null and silently skipped the exit anim
          // every time a held one-shot (or any one-shot) released on condition
          // failure. States without an exit anim release immediately as before.
          if (!(active.exitAnim && this.useExitEnabled(active))) {
            this._activeStateName = "";
          }
        }
      } else if (active && this.debugDraw && !this._lastLoggedNotOneShot.has(active.name)) {
        // Diagnostic for the common gotcha: state has holdOnFinish ON
        // but the sprite asset's animation `loop` is also ON, so the
        // engine treats the anim as continuous and never enters the
        // hold path. Print once per state.
        if (active.holdOnFinish) {
          console.log(`[Animator] ${active.name} has holdOnFinish=true BUT sprite anim "${active.animation}" has loop=true → hold logic is INACTIVE. Set loop=false on the sprite anim in the Sprite editor.`);
        }
        this._lastLoggedNotOneShot.add(active.name);
      }
    }
    if (!winning) {
      const sorted = this.getSortedStates();
      // PhaseManager lookup hoisted outside the loop — most BPs don't
      // attach one, and we only need to read its `currentPhase` field.
      // Hoisting saves N-1 findBehaviorByKind calls per tick.
      let curPhase: number | undefined;
      for (const s of sorted) {
        // Author can toggle a state off at runtime via SetStateEnabled
        // — skip those rows so they never compete for the winner slot.
        // `undefined` is treated as enabled for backward-compat.
        if (s.enabled === 0) continue;
        // Phase gate: a state with `minPhase` / `maxPhase` only runs
        // when the sibling PhaseManager's currentPhase is in range.
        // When no PhaseManager is attached, currentPhase defaults to 0
        // so `minPhase: 0` (or undefined) states still match.
        if (s.minPhase !== undefined || s.maxPhase !== undefined) {
          if (curPhase === undefined) {
            const pm = this.sprite.findBehaviorByKind("PhaseManager") as { currentPhase?: number } | undefined;
            curPhase = pm?.currentPhase ?? 0;
          }
          if (s.minPhase !== undefined && curPhase < s.minPhase) continue;
          if (s.maxPhase !== undefined && curPhase > s.maxPhase) continue;
        }
        if (this.evaluate(s)) {
          winning = s;
          break;
        }
      }
    }
    if (!winning) return;
    // State-level hysteresis — if the currently active state has higher
    // priority than the new winner AND was active within the last 60 ms,
    // keep it. Rides out 1-3 tick condition flickers (CM's wallSliding
    // flag toggling because Phaser's body-separation briefly drops
    // blocked.left/right, or the slide-gravity clamp making vy=0 for
    // one frame) so a stable wallslide doesn't visibly flash fall main.
    // `hysteresisWin` gates the lastActive stamp at the end of update:
    // a hysteresis win does NOT refresh the timestamp, so the state
    // can only ride hysteresis for ~60 ms total before it genuinely
    // releases — otherwise it'd be stuck forever.
    let hysteresisWin = false;
    if (this._activeStateName && winning.name !== this._activeStateName) {
      const active = this.findState(this._activeStateName);
      if (active && active.priority > winning.priority) {
        const lastActive = this._lastActiveAtMs[active.name] ?? -Infinity;
        const windowMs = (active.hysteresisMs && active.hysteresisMs > 0) ? Number(active.hysteresisMs) : 60;
        // Edge-triggered winners bypass hysteresis. Conditions like
        // `justLanded` / `justTurnedLeft` fire for exactly ONE tick — if
        // hysteresis swallows that tick, the state never gets picked
        // (the edge is gone by the time hysteresis releases). The fall →
        // land transition is the canonical case: fall (high prio) is
        // active, justLanded fires, land (low prio) would win, but
        // hysteresis kept fall. Skipping hysteresis for edge winners
        // makes land latch on the touchdown frame as authors expect.
        const winnerIsEdge = EDGE_CONDITION_KINDS.has(winning.primary.kind);
        // Wall-slide flicker is already smoothed at the physics layer (CM's
        // coyote window keeps IsWallSliding true through Phaser's 1-2 tick
        // body-separation drops). So the state-level hysteresis on a wall-slide
        // state adds nothing but EXIT LAG — when you press away from the wall,
        // it'd hold the slide anim ~60 ms before fall. Skip it for wall-slide.
        const activeIsWallSlide = active.primary.kind === "IsWallSliding";
        if (!winnerIsEdge && !activeIsWallSlide && (this.sprite.scene.time.now - lastActive) < windowMs) {
          winning = active;
          hysteresisWin = true;
        }
      }
    }

    // Phase C: apply the winner. Three cases:
    //   1. Same as active state — keep playing, nothing to do.
    //   2. Different state, prior state has exitAnim — start exit phase.
    //   3. Different state (no exit) — start the new state's enter (or main).
    // Apply per-tick advanced effects of the active state: freeze
    // movement (zero velocity + block input), and per-frame motions
    // when SR's currentFrameIdx changes inside the active state's
    // main phase. Both run only while we're STAYING on the same state
    // (handled in this branch).
    // enter via `enterState`.
    this.applyAdvancedPerTick(winning, sr);

    if (winning.name === this._activeStateName) {
      // Replay-on-retrigger: a signal-driven state (e.g. hurt via OnDamageTaken)
      // can re-fire while it's already active — a 2nd hit landing mid-hurt.
      // Restart its anim from frame 0 so the flinch replays. Rate-limited by
      // reEntryGuard so the signal's 1-frame carryover doesn't double-restart.
      let didRestart = false;
      // Retrigger uses the primary condition's `action` field as the signal
      // name to watch (the convention for OnSignal-style primaries —
      // `primary.action` holds the signal name). States whose primary isn't
      // signal-shaped have no action and skip the retrigger path naturally.
      const retrigSignal = String((winning.primary as { action?: string }).action ?? "");
      if (winning.retrigger && retrigSignal
          && this.sprite.events.firedThisFrame(retrigSignal)) {
        const nowMs = this.sprite.scene.time.now;
        const guardMs = (winning.reEntryGuardMs && winning.reEntryGuardMs > 0) ? Number(winning.reEntryGuardMs) : 80;
        if (nowMs - (this._lastRetriggerMs[winning.name] ?? -Infinity) >= guardMs) {
          this._lastRetriggerMs[winning.name] = nowMs;
          this.restartStateAnim(winning, sr);
          didRestart = true;
        }
      }
      this.currentState = winning.name;
      this.drawDebug(sr as { currentAnimation: string; currentFrameIdx?: number });
      // After a retrigger restart keep _prevSRFrame at -1 (set by
      // restartStateAnim) so NEXT tick's entry into frame 0 reads as an edge —
      // otherwise a frame signal on frame 0 (the first frame) never re-fires on
      // the replay (the 0→0 isn't an edge). Mirrors a fresh enterState.
      this._prevSRFrame = didRestart ? -1 : ((sr as { currentFrameIdx?: number }).currentFrameIdx ?? -1);
      if (!hysteresisWin) this._lastActiveAtMs[winning.name] = this.sprite.scene.time.now;
      return;
    }
    // Release frozen movement when leaving the prior state.
    this.releaseFreezeMovement();
    const prior = this._activeStateName ? this.findState(this._activeStateName) : null;
    // Auto-emit `OnStateExit_<name>` so the Logic Sheet's OnStateExit
    // trigger can subscribe without per-state callback wiring. Also
    // emit the generic `OnStateExit` for "any state" subscribers.
    if (prior) {
      this.sprite.events.emit(`OnStateExit_${prior.name}`);
      this.sprite.events.emit("OnStateExit");
    }
    // Capture transition history — `previousState` / `previousAnim` get
    // stamped before the new state takes over so the new state can
    // read them via `previousStateWas` / `previousAnimWas` conditions
    // (covers "combo follow-up" / "post-landing → crouch" patterns).
    if (prior) {
      this.previousState = prior.name;
      const sr0 = sr as { currentAnimation?: string };
      this.previousAnim = sr0.currentAnimation ?? "";
    }
    if (prior && prior.exitAnim && this.useExitEnabled(prior)) {
      this._phase = "exit";
      this._pendingNextStateName = winning.name;
      sr.currentAnimation = prior.exitAnim;
      sr.playing = 1;
      // SR resets currentFrameIdx to 0 on next tick when the anim name
      // changes. Without clearing _prevSRFrame, the wrap detector sees
      // (newFrame 0 < oldFrame N) on a loop-main → exit transition and
      // spuriously fires animEndedThisTick on the FIRST tick of the
      // exit anim — skipping the whole exit playback. Same fix the
      // enter→main path at the top of update() uses (line ~608).
      this._prevSRFrame = -1;
      // SR's internal change detector compares lastAnimName to decide
      // whether to fully reset playback. Force a reset so an exit anim
      // reusing a previously-played name still plays from frame 0.
      // Cast via unknown because lastAnimName is private on SpriteRenderer.
      const srMut = sr as unknown as { lastAnimName?: string; currentFrameIdx?: number; finishedEmitted?: boolean };
      srMut.lastAnimName = "";
      srMut.currentFrameIdx = 0;
      srMut.finishedEmitted = false;
      this.currentState = prior.name;
      return;
    }
    // enterState reads `_lastActiveAtMs[winning.name]` (set on prior
    // ticks) to decide whether the enter anim should play. Stamp it
    // AFTER enterState runs so first-time entry sees the prior value
    // (-Infinity by default) and plays the enter anim normally.
    this.enterState(winning, sr);
    this.drawDebug(sr as { currentAnimation: string; currentFrameIdx?: number });
    // Leave _prevSRFrame at -1 (set by enterState) so NEXT tick's
    // frame-enter detector sees an edge from -1 → 0 — without this,
    // frame motions / frame signals on the FIRST frame (index 0) of a
    // newly entered state never fire (the entering tick stamps it to
    // 0, the next tick is still 0, so `frameIdx !== _prevSRFrame`
    // never trips). Wrap detection at top-of-update is safely gated
    // by `_prevSRFrame >= 0` so the -1 doesn't trigger a spurious wrap.
    this._prevSRFrame = -1;
    if (!hysteresisWin) this._lastActiveAtMs[winning.name] = this.sprite.scene.time.now;
  }

  /** Restart the active state's MAIN animation from frame 0 without a full
   *  state transition (no exit/enter). Used by `retrigger` so a re-fired
   *  state (e.g. a 2nd hit mid-hurt) re-plays its flinch. Mirrors the SR
   *  reset the exit-anim path uses. */
  private restartStateAnim(
    state: AnimStateDef,
    sr: { currentAnimation: string; playing: number },
  ): void {
    this._phase = "main";
    sr.currentAnimation = state.animation;
    sr.playing = 1;
    const srMut = sr as unknown as { lastAnimName?: string; currentFrameIdx?: number; finishedEmitted?: boolean };
    srMut.lastAnimName = "";
    srMut.currentFrameIdx = 0;
    srMut.finishedEmitted = false;
    this._prevSRFrame = -1;
    // Clear the per-visit frame-fire dedup so the replayed anim re-fires its
    // frame signals + motions (e.g. the hurt anim's CameraShake signal fires
    // again on a 2nd hit). Without this the restart looks right but no signal.
    this._firedFramesInState.clear();
    if (this.debugDraw) console.log(`[retrigger] restart "${state.name}" → frame 0, dedup cleared`);
  }

  /** Begin a fresh state — play its enterAnim (one-shot) if defined and
   *  in/out transitions are enabled, else its main animation directly.
   *  Updates phase + currentState. */
  private enterState(
    state: AnimStateDef,
    sr: { currentAnimation: string; playing: number },
  ): void {
    this._activeStateName = state.name;
    this.currentState = state.name;
    // Auto-emit `OnStateEnter_<name>` so Logic Sheet's OnStateEnter
    // trigger can subscribe. Mirrors the OnStateExit emit on the
    // transition-out path. Also emit the generic `OnStateEnter` for
    // "any state" subscribers.
    this.sprite.events.emit(`OnStateEnter_${state.name}`);
    this.sprite.events.emit("OnStateEnter");
    // Consume any `inputBuffered` entries this state's conditions
    // reference — a single buffered press should trigger at most one
    // state entry, not chain through every state that happens to read
    // the buffer. Both the primary condition and every extra are
    // checked; the buffer entry for each named action is cleared.
    const consumeBufferIfBuffered = (c: Condition) => {
      if (c.kind === "InputBuffered") {
        const act = String((c as { action?: string }).action ?? "");
        if (act) this._bufferedInputAtMs.delete(act);
      }
    };
    consumeBufferIfBuffered(state.primary);
    if (Array.isArray(state.extras)) for (const c of state.extras) consumeBufferIfBuffered(c);
    if (Array.isArray(state.subs)) for (const c of state.subs) consumeBufferIfBuffered(c);
    const useEnter = this.useEnterEnabled(state);
    // Sub-flicker re-entry guard — skip the enter anim only when this
    // state was active VERY recently (within the 60 ms hysteresis
    // window). That covers the edge case where hysteresis times out by
    // a single tick. A real transition out and back (e.g. wall jump's
    // 150 ms wallSliding suppression, then re-engaging the wall) plays
    // the enter normally because lastActive will be > 60 ms old.
    const nowMs = this.sprite.scene.time.now;
    const lastActiveMs = this._lastActiveAtMs[state.name] ?? -Infinity;
    const guardMs = (state.reEntryGuardMs && state.reEntryGuardMs > 0) ? Number(state.reEntryGuardMs) : 80;
    const recentlyActive = (nowMs - lastActiveMs) < guardMs;
    const playEnter = useEnter && !!state.enterAnim && !recentlyActive;
    // Combo: if state has a non-empty comboAnimations list, pick the
    // next anim from the chain. Reset the chain to 0 when the window
    // since the last combo anim expired or when the list is exhausted.
    // The `animation` field is ignored for REAL combo states (those with at
    // least one named step). A list of only blank steps — created when the
    // author just wants a frame signal on the main anim — falls through and
    // plays `state.animation` normally (no one-shot combo lock).
    let mainAnim = state.animation;
    let comboStepIdx = -1; // 0-based index of the picked combo step; -1 = not a combo entry
    if (this.comboList(state).length > 0) {
      const lastEnd = this._stateComboLastEndAt.get(state.name) ?? -Infinity;
      // Single source of truth — animator-level `comboWindow`. The state-
      // level override existed in the schema but had no editor UI, leading
      // to stale data (e.g. comboWindow=1) silently overriding the user's
      // inspector setting. Always use the animator's value.
      const window = this.comboWindow;
      const expired = (this._simTime - lastEnd) > window;
      const anims = state.comboAnimations ?? [];

      if (state.comboRandom) {
        // Weighted random pick — independent per entry. Window doesn't
        // gate selection (every entry is a fresh roll). We reuse the
        // _stateComboNextIdx map to remember the LAST picked index when
        // comboRandomNoRepeat is on, so the next entry can exclude it.
        const weights = state.comboWeights ?? [];
        const noRepeat = !!state.comboRandomNoRepeat;
        const lastIdx = this._stateComboNextIdx.get(state.name);
        // Build weighted total, optionally zeroing the previous idx so
        // it can't be picked. Skip the no-repeat exclusion when it'd
        // zero out every option (single eligible step) — better to
        // repeat than freeze.
        const eligibleW: number[] = [];
        let total = 0;
        for (let i = 0; i < anims.length; i++) {
          const baseW = Math.max(0, Number(weights[i] ?? 100));
          const w = (noRepeat && lastIdx === i) ? 0 : baseW;
          eligibleW.push(w);
          total += w;
        }
        if (total === 0) {
          // Either every weight is 0, OR the no-repeat exclusion zeroed
          // the only non-zero option. Fall back to the unfiltered weight
          // distribution so we still play something.
          total = 0;
          for (let i = 0; i < anims.length; i++) {
            const w = Math.max(0, Number(weights[i] ?? 100));
            eligibleW[i] = w;
            total += w;
          }
        }
        let pickIdx = 0;
        if (total > 0) {
          let r = Math.random() * total;
          for (let i = 0; i < anims.length; i++) {
            r -= eligibleW[i];
            if (r <= 0) { pickIdx = i; break; }
          }
        }
        mainAnim = anims[pickIdx];
        this._stateComboNextIdx.set(state.name, pickIdx);
        comboStepIdx = pickIdx;
      } else {
        let nextIdx = this._stateComboNextIdx.get(state.name) ?? 0;
        if (expired || nextIdx >= anims.length) nextIdx = 0;
        mainAnim = anims[nextIdx];
        // Advance for the next entry. Wrap-around handled by the reset
        // check above on the next call.
        this._stateComboNextIdx.set(state.name, nextIdx + 1);
        comboStepIdx = nextIdx;
      }
    }
    // Per-combo-step signal so authors can trigger on a SPECIFIC swing
    // (OnComboStep_1 / _2 / _3 …, 1-based to match the combo editor's #1/#2
    // step labels). `OnStateEnter_<name>` can't distinguish steps — the
    // state name is identical across the chain. Generic `OnComboStep` fires
    // for any step. Plus `OnComboStep_<animName>` keyed on the picked anim
    // for authors who'd rather match by clip than by index.
    if (comboStepIdx >= 0) {
      const stepNo = comboStepIdx + 1;
      // State-SCOPED so multiple combo states don't collide (a ground combo
      // and a crouch combo both have a "step 2"). `OnComboStep_<state>_<n>`
      // is the unambiguous one to wire; the bare `OnComboStep_<n>` / generic
      // / per-anim variants stay for convenience.
      this.sprite.events.emit(`OnComboStep_${state.name}_${stepNo}`);
      this.sprite.events.emit(`OnComboStep_${stepNo}`);
      this.sprite.events.emit("OnComboStep");
      if (mainAnim) this.sprite.events.emit(`OnComboStep_${mainAnim}`);
    }
    const target = playEnter ? state.enterAnim : mainAnim;
    this._phase = playEnter ? "enter" : "main";
    if (!playEnter) {
      this.sprite.events.emit(`OnStateMain_${state.name}`);
      this.sprite.events.emit("OnStateMain");
    }
    if (target) {
      sr.currentAnimation = target;
      sr.playing = 1;
      // Force SR to RESET its anim state even when re-entering with
      // the SAME anim name. SR's change detector compares against its
      // internal lastAnimName and skips the reset if they match —
      // leaving currentFrameIdx pinned where it was and finishedEmitted
      // stuck true. Rapid re-pressing attack hits this path and shows
      // as stale visuals + the state never releasing. Clearing
      // lastAnimName makes SR's next tick treat this as a fresh switch
      // and run the full reset (frame 0, elapsedMs=0, finishedEmitted=
      // false). The explicit field assigns below are belt-and-braces
      // so even the current tick reads a fresh frame index.
      (sr as { lastAnimName?: string }).lastAnimName = "";
      (sr as { currentFrameIdx?: number }).currentFrameIdx = 0;
      (sr as { finishedEmitted?: boolean }).finishedEmitted = false;
    }
    // Reset frame-motion edge tracking — fresh state starts with no
    // prior frame logged so the first frame visit fires its motions,
    // and no frames are marked "already fired" yet.
    this._prevSRFrame = -1;
    this._prevFrameMotionState = state.name;
    this._firedFramesInState.clear();
    // Stop any in-flight frame tween from the previous state — its
    // target was the character's position, and the new state's first
    // frame motion needs a clean slate.
    if (this._activeFrameTween) {
      this._activeFrameTween.stop();
      this._activeFrameTween = null;
    }
  }

  /** Per-tick advanced effects for the active state: freezeMovement +
   *  frameMotions. Called every tick during update() once the winner
   *  is known and we're staying on (or transitioning into) that state. */
  private applyAdvancedPerTick(
    state: AnimStateDef,
    sr: { currentAnimation: string; playing: number; currentFrameIdx?: number },
  ): void {
    // Freeze movement (independent of ignoreInput) — zero velocity each
    // tick the state is active in main phase. Used for "stunned" /
    // "interact" states where the body shouldn't move at all.
    //
    // EXCEPTION: while Damageable.isInHitstun() is true, skip the zero.
    // Damageable.applyDamage() just set a knockback velocity and the
    // hurt state typically carries freezeMovement=true — zeroing here
    // would kill the knockback on the very next tick before it could
    // visibly move the body. The CharacterMovement update() and the
    // AIBrain update() both already gate on isInHitstun() for the same
    // reason (preserve the knockback Damageable just applied). Keeping
    // this aligned closes the loop.
    if (state.freezeMovement) {
      const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
      const inHitstun = !!dmg?.isInHitstun?.();
      if (!inHitstun) {
        const body = this.sprite.body;
        if (body) {
          body.setVelocityX(0);
          body.setVelocityY(0);
        }
      }
    }
    // Ignore input — block CM's read of player input so WASD/Jump
    // don't override the state's motion. Independent from
    // freezeMovement: a dash state typically wants ignoreInput on (no
    // player override) but freezeMovement off (CM is doing the dash
    // velocity and shouldn't be zeroed).
    if (state.ignoreInput) {
      const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { ignoreInput?: number } | undefined;
      if (cm) cm.ignoreInput = 1;
      const tm = this.sprite.findBehaviorByKind("TopdownMovement") as { ignoreInput?: number } | undefined;
      if (tm) tm.ignoreInput = 1;
      this._animOwnsIgnoreInput = true;
    }

    // Frame motions + frame signals fire on the frame-enter edge. Runs in
    // enter / main / exit (see processFrameTriggers) so triggers authored on
    // the IN or OUT clip fire too, scoped by each row's `anim` filter.
    this.processFrameTriggers(state, sr);
    // NOTE: `_prevSRFrame` is intentionally NOT reset here. The end of
    // `update()` assigns it from sr.currentFrameIdx every tick across
    // ALL phases so the next tick's wrap detection (top of update) has
    // a usable previous frame in enter / exit phases too. Without this,
    // a `wallslide_in` enter anim whose asset has loop=true cycles
    // forever and never advances to the main anim.
  }

  /** Fire a state's frameMotions + frameSignals on the frame-enter edge,
   *  deduped per clip via `_firedFramesInState`. Phase-agnostic: called for the
   *  active state in enter / main and for the exiting state in exit, so a signal
   *  authored on the IN or OUT clip fires too. Each row's `anim` filter scopes
   *  it to the right clip; when the clip changes the dedup set resets. */
  private processFrameTriggers(
    state: AnimStateDef,
    sr: { currentAnimation: string; currentFrameIdx?: number },
  ): void {
    if (this._activeStateName !== state.name || this._prevFrameMotionState !== state.name) return;
    const activeMotions = state.frameMotions;
    const activeSignals = state.frameSignals;
    const hasMotions = Array.isArray(activeMotions) && activeMotions.length > 0;
    const hasSignals = Array.isArray(activeSignals) && activeSignals.length > 0;
    if (!hasMotions && !hasSignals) return;
    const frameIdx = sr.currentFrameIdx ?? -1;
    const currentAnim = sr.currentAnimation;
    // Clip changed (in → main → out) → reset the per-frame dedup so the new
    // clip's triggers fire fresh (frame indices collide across the 3 clips).
    if (currentAnim !== this._prevFrameAnim) {
      this._firedFramesInState.clear();
      this._prevFrameAnim = currentAnim;
    }
    if (frameIdx === this._prevSRFrame) return;
    if (!this.isMainOneShot(state, sr) && this._prevSRFrame >= 0 && frameIdx < this._prevSRFrame) {
      this._firedFramesInState.clear();
    }
    if (this._firedFramesInState.has(frameIdx)) return;
    // A row WITH an `anim` filter fires whenever that clip plays (in / main /
    // out). A row WITHOUT a filter stays MAIN-only — preserves legacy behavior
    // so adding enter/exit support can't make old rows double-fire.
    const inMain = this._phase === "main";
    if (hasMotions) {
      const motions = activeMotions!.filter((m) =>
        Math.floor(Number(m.frame)) === frameIdx && (m.anim ? m.anim === currentAnim : inMain));
      for (const m of motions) this.applyFrameMotion(m);
    }
    if (hasSignals) {
      for (const fs of activeSignals!) {
        if (!fs || !fs.signal) continue;
        if (fs.anim ? fs.anim !== currentAnim : !inMain) continue;
        const wantedFrames = Array.isArray(fs.frames) ? fs.frames.map((n) => Math.floor(Number(n))) : [];
        if (!wantedFrames.includes(frameIdx)) continue;
        if (this.debugDraw) console.log(`[frameSig] FIRE "${fs.signal}" @frame ${frameIdx} (anim ${currentAnim})`);
        this.sprite.events.emit(fs.signal);
        const tag = fs.targetTag;
        if (tag) {
          const all = (this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          for (const s of all) {
            if (s.destroyed || s === this.sprite) continue;
            if (!s.tags.has(tag)) continue;
            s.events.emit(fs.signal);
          }
        }
      }
    }
    this._firedFramesInState.add(frameIdx);
  }

  /** Apply one frame motion — facing-aware translation, instant or
   *  tween. Tween mode kills the previous frame-motion tween before
   *  starting so positional offsets don't accumulate when motions land
   *  back-to-back (frame 4 still tweening when frame 10 hits). */
  private applyFrameMotion(m: FrameMotion): void {
    const obj = this.sprite.gameObject;
    if (!obj) return;
    const facingSign = this.sprite.facingScaleX < 0 ? -1 : 1;
    // Resolve via the shared numOr — accepts plain numbers and the
    // same expression vocabulary used everywhere else in the engine:
    // `random(min, max)`, `var:Player.dashRange`, arithmetic, etc.
    // Random rolls fresh per fire, so a punch's recoil can vary
    // naturally swing-to-swing.
    const dx = numOr(m.dx, 0, this.sprite) * facingSign;
    const dy = numOr(m.dy, 0, this.sprite);
    // Wall guard — skip the motion if it would push the body into a
    // Solid. First the cheap contact check (already touching the wall),
    // then a LOOKAHEAD test: predict the body's rect at the post-motion
    // position and intersect-test against every immovable body in the
    // scene. The engine's `Solid` behavior sets dynamic bodies to
    // `immovable=true` (NOT `setStatic`), so we iterate `peaky.sprites`
    // and filter on `body.immovable` rather than `world.staticBodies`
    // (which is empty for Solid setups).
    if (m.skipIfBlocked) {
      const body = this.sprite.body;
      if (body) {
        // Cheap contact check — use ONLY `body.blocked.*` (geometry /
        // static-body collision), NOT `body.touching.*`. touching turns
        // true when the body contacts ANY other body — including the
        // player the NPC is trying to attack. Using touching here meant
        // every melee NPC's forward attack motion got skipped the moment
        // it came within hit range of the player. The lookahead AABB
        // test below covers the actual wall-collision case.
        if (dx > 0 && body.blocked.right) return;
        if (dx < 0 && body.blocked.left)  return;
        if (dy > 0 && body.blocked.down)  return;
        if (dy < 0 && body.blocked.up)    return;
        // Lookahead body — predicted position. Shrunk by EPS pixels on
        // every side so resting penetration (Phaser arcade leaves a
        // ~0.5-1px overlap when a character stands on the ground) does
        // NOT register as "would hit a wall". Real wall collisions
        // penetrate much further than EPS so they still trigger.
        const EPS = 2;
        const px = body.x + dx + EPS;
        const py = body.y + dy + EPS;
        const pr = body.x + dx + body.width  - EPS;
        const pb = body.y + dy + body.height - EPS;
        const liveList = (this.sprite.scene.data.get("peaky.sprites") as Array<{
          body?: { x: number; y: number; width: number; height: number; immovable?: boolean; enable?: boolean };
          destroyed?: boolean;
        }> | undefined) ?? [];
        for (const s of liveList) {
          if (!s || s === (this.sprite as unknown as typeof s) || s.destroyed) continue;
          const sb = s.body;
          if (!sb || !sb.immovable) continue;
          // Skip bodies that are flagged immovable but DISABLED — most
          // notably the TilemapRenderer host sprite, which marks itself
          // immovable but sets body.enable=false because the per-layer
          // tilemap layers own the actual collision.
          if (sb.enable === false) continue;
          if (px < sb.x + sb.width && pr > sb.x && py < sb.y + sb.height && pb > sb.y) return;
        }
        // Tilemap walls — checking only `peaky.sprites` misses tiles
        // because tilemap collision lives on Phaser tilemap layers, not
        // on individual sprite bodies. Iterate every registered Phaser
        // tilemap layer and ask each whether a collidable tile sits
        // inside the predicted body's footprint. Querying the four
        // corners catches typical tile-size+ bodies; for a body smaller
        // than a tile this still works because every corner falls in the
        // same tile.
        const tmLayers = (this.sprite.scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
        if (tmLayers.length > 0) {
          // Probe corners (insetting by a fraction of a pixel so a body
          // resting exactly on a cell boundary doesn't query the cell BELOW
          // — same epsilon trick the IsByWall conditions use).
          const corners: Array<[number, number]> = [
            [px,     py],
            [pr - 1, py],
            [px,     pb - 1],
            [pr - 1, pb - 1],
          ];
          for (const layer of tmLayers) {
            for (const [cx, cy] of corners) {
              const tile = layer.getTileAtWorldXY(cx, cy, true);
              if (tile && tile.index >= 0 && tile.collides) return;
            }
          }
        }
      }
    }
    if (m.mode === "tween" && m.duration > 0) {
      if (this._activeFrameTween) {
        this._activeFrameTween.stop();
        this._activeFrameTween = null;
      }
      this._activeFrameTween = this.sprite.scene.tweens.add({
        targets: obj,
        x: obj.x + dx,
        y: obj.y + dy,
        duration: Math.max(1, m.duration * 1000),
        ease: "Sine.easeOut",
        onComplete: () => { this._activeFrameTween = null; },
      });
    } else {
      obj.setPosition(obj.x + dx, obj.y + dy);
    }
  }

  /** Look up an attached Tracer by its `name` field. Empty name returns
   *  the first Tracer found (single-tracer BPs don't need to name them).
   *  Returns undefined when no match — callers no-op rather than throw.
   *  Uses `findBehaviorsByKind` for multi-instance support since a BP
   *  may carry several Tracers (sword + kick + jab). */
  private findTracerByName(name: string): { triggerSignal?: string; lastHit?: TracerHitLike | null; justHit?: boolean; name?: string } | undefined {
    const list = (this.sprite as unknown as { findBehaviorsByKind?: (k: string) => Behavior[] }).findBehaviorsByKind?.("Tracer")
      ?? (this.sprite.findBehaviorByKind("Tracer") ? [this.sprite.findBehaviorByKind("Tracer") as Behavior] : []);
    if (!list || list.length === 0) return undefined;
    if (!name) return list[0] as unknown as { triggerSignal?: string; lastHit?: TracerHitLike | null; justHit?: boolean; name?: string };
    for (const t of list) {
      if ((t as unknown as { name?: string }).name === name) {
        return t as unknown as { triggerSignal?: string; lastHit?: TracerHitLike | null; justHit?: boolean; name?: string };
      }
    }
    return undefined;
  }

  /** Clear any movement-block flags set by a prior freezeMovement state.
   *  Called when the active state changes. */
  private releaseFreezeMovement(): void {
    // Only clear ignoreInput if an ignoreInput STATE set it. A flag the author
    // toggled manually (e.g. a pause-menu lock via CM Ignore Input) must NOT be
    // cleared by a routine idle↔walk state change — that was the cause of the
    // "toggle input lock desyncs with the menu" bug.
    if (!this._animOwnsIgnoreInput) return;
    this._animOwnsIgnoreInput = false;
    const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { ignoreInput?: number } | undefined;
    if (cm) cm.ignoreInput = 0;
    const tm = this.sprite.findBehaviorByKind("TopdownMovement") as { ignoreInput?: number } | undefined;
    if (tm) tm.ignoreInput = 0;
  }

  /** True when the ACTIVE state freezes movement — read by MoveTo (and any
   *  other AI-driven mover) so a frozen/block state actually stops the body
   *  instead of being immediately overridden by the mover's setVelocity. The
   *  animator already zeroes velocity for freezeMovement, but a per-tick mover
   *  re-sets it; this lets the mover bail out so the freeze sticks. */
  isMovementFrozen(): boolean {
    const s = this.findState(this._activeStateName);
    return !!s?.freezeMovement;
  }

  private findState(name: string): AnimStateDef | null {
    // Prefer an ENABLED state when a name is duplicated. The active state is
    // always an enabled winner, so a disabled state sharing its name (a
    // leftover/experiment the author toggled off) must not be the one
    // returned here — otherwise every lock/hold/flag check reads the wrong,
    // disabled twin and the state machine corrupts (run beats a held block,
    // ignoreInput flickers, etc.). Fall back to any match if none enabled.
    return this.states.find((s) => s.name === name && s.enabled !== 0)
      ?? this.states.find((s) => s.name === name)
      ?? null;
  }

  /** Enter anim is played when useEnter === true. Falls back to the
   *  deprecated useTransitions field when useEnter is undefined so
   *  saved configs from the single-toggle era keep working. */
  private useEnterEnabled(state: AnimStateDef): boolean {
    if (state.useEnter !== undefined) return state.useEnter === true;
    return state.useTransitions === true;
  }
  /** Exit anim is played when useExit === true. Falls back the same
   *  way as useEnterEnabled. Critical because users who set up an
   *  enter without explicitly setting useExit shouldn't get a
   *  surprise exit anim firing on every state change. */
  private useExitEnabled(state: AnimStateDef): boolean {
    if (state.useExit !== undefined) return state.useExit === true;
    return state.useTransitions === true;
  }

  /** True when the state's main animation is a one-shot. For regular
   *  states this reads the sprite asset's `loop=false` flag — single
   *  source of truth for "should the state release after main plays
   *  once". For COMBO states (non-empty comboAnimations), this always
   *  returns true regardless of asset loop: the state must hold for
   *  the duration of the current combo anim so rapid presses can't
   *  override mid-play, and the chain advances on anim end via
   *  OnAnimationFinished or wrap detection. Falls back to "looping"
   *  when the anim can't be found so unknown anims hold their state. */
  /** Real combo steps — comboAnimations entries that name an actual anim.
   *  The editor's "+ Add Combo Step" inserts a BLANK entry when the author
   *  only wants a frame signal on the state's main anim (no chaining), so a
   *  list of just blanks must NOT count as a combo — otherwise the state
   *  gets the one-shot play-through lock and a looping state (e.g. run with
   *  a footstep frame-signal) can't release until its cycle finishes. */
  private comboList(state: AnimStateDef): string[] {
    return (state.comboAnimations ?? []).filter((a) => typeof a === "string" && a.trim() !== "");
  }

  private isMainOneShot(
    state: AnimStateDef,
    sr: { _animations?: Record<string, { loop: boolean }>; currentAnimation?: string } | unknown,
  ): boolean {
    const combo = this.comboList(state);
    // Only a REAL multi-step combo (2+ named clips) forces play-through —
    // that's a chain whose links advance on anim-end. A single "combo" step
    // (or none) isn't a chain; whether it plays through is decided purely by
    // the clip's own loop flag. This is what lets a looping `run` state that
    // carries one frame-signal step still release the instant you stop,
    // instead of being locked into finishing its cycle.
    if (combo.length > 1) return true;
    const anims = (sr as { _animations?: Record<string, { loop: boolean }> })._animations;
    // For a 1-step combo the playing clip is that step; otherwise it's the
    // state's own animation. A looping clip is never a one-shot.
    const animName = combo[0] ?? state.animation;
    const anim = anims?.[animName];
    if (!anim) return false;
    return anim.loop === false;
  }

  /** Whether a one-shot state should HOLD on its last frame instead of
   *  releasing + re-triggering (the "machine-gun"). True when the author
   *  set `holdOnFinish`, OR the state's primary condition is CONTINUOUS
   *  (a held key / state-check) so a release would just re-enter next frame
   *  — flickering ignoreInput/freezeMovement and breaking preemption.
   *  Edge-triggered one-shots (OnKeyPressed attack, OnLand land) still
   *  release normally so they play once and return. */
  /** First higher-priority state whose condition matches this frame (honoring
   *  enabled + phase gates), or null. Used to let hurt etc. preempt a state
   *  mid-clip — during enter / exit (here) and mid-main (inline loops). */
  private findPreempt(activePriority: number): AnimStateDef | null {
    const higher = this.getSortedStates().filter((s) => s.enabled !== 0 && s.priority > activePriority);
    let curPhase: number | undefined;
    for (const s of higher) {
      if (s.minPhase !== undefined || s.maxPhase !== undefined) {
        if (curPhase === undefined) {
          const pm = this.sprite.findBehaviorByKind("PhaseManager") as { currentPhase?: number } | undefined;
          curPhase = pm?.currentPhase ?? 0;
        }
        if (s.minPhase !== undefined && curPhase < s.minPhase) continue;
        if (s.maxPhase !== undefined && curPhase > s.maxPhase) continue;
      }
      if (this.evaluate(s)) return s;
    }
    return null;
  }

  private holdsOnFinish(state: AnimStateDef, sr: unknown): boolean {
    if (state.holdOnFinish) return true;
    if (!this.isMainOneShot(state, sr)) return false;
    const k = state.primary.kind;
    // OnKeyHeld is a trigger by category but stays true every frame held.
    // Everything that isn't a one-frame trigger (state-checks, IsActionHeld,
    // Always) is continuous.
    return k === "OnKeyHeld" || !isTriggerCondition(k);
  }

  /** Evaluate a single Logic Sheet condition against the host sprite via
   *  the sprite's trigger-aware path. `key` must be stable per (state,
   *  slot, index) so TRIGGER kinds (OnLand, OnKeyPressed, OnAnimationEnd,
   *  EveryXSeconds…) keep their per-frame edge state across ticks. Without
   *  the trigger path, every trigger kind would silently evaluate to false
   *  in a state machine (the bare continuous evaluator returns false for
   *  triggers). */
  private evalRow(c: Condition, key: string): boolean {
    return this.sprite.evalAnimCondition(c, key);
  }

  /** Combine a list of conditions via `any` (false = AND, true = OR). Empty
   *  = AND-vacuous true; callers guard the empty case where it matters.
   *  `keyPrefix` namespaces each row's edge state. */
  private combineRows(rows: Condition[], any: boolean | undefined, keyPrefix: string): boolean {
    if (any) {
      for (let i = 0; i < rows.length; i++) if (this.evalRow(rows[i], `${keyPrefix}${i}`)) return true;
      return false;
    }
    for (let i = 0; i < rows.length; i++) if (!this.evalRow(rows[i], `${keyPrefix}${i}`)) return false;
    return true;
  }

  /** Evaluate one state's overall match. Two levels:
   *  - Top: primary + `extras`, combined via `matchAny`.
   *  - Sub: `subs` combined via `subMatchAny`, folded into the top as ONE
   *    more term (joined by `matchAny`). Lets "moving AND (right OR left)"
   *    be a single state. Each leaf's `not` flips its own result. */
  private evaluate(state: AnimStateDef): boolean {
    const kp = `${this._activeMachineName}:${state.name}:`;
    const primary = this.evalRow(state.primary, `${kp}p`);
    const extras = state.extras;
    const subs = state.subs;
    const subTerm = subs && subs.length > 0 ? this.combineRows(subs, state.subMatchAny, `${kp}s`) : null;
    let result: boolean;
    if (state.matchAny) {
      result = false;
      if (primary) result = true;
      else if (extras && extras.some((c, i) => this.evalRow(c, `${kp}e${i}`))) result = true;
      else result = subTerm === true;
    } else if (!primary) {
      result = false;
    } else if (extras && extras.some((c, i) => !this.evalRow(c, `${kp}e${i}`))) {
      result = false;
    } else {
      result = subTerm !== false;
    }
    return result;
  }

  /** @deprecated Stub kept only so a build doesn't trip while migrating
   *  call sites. All condition evaluation now flows through `evalRow` →
   *  `evaluateCondition` from the shared Logic Sheet evaluator. */
  private _evaluateOneRemoved(kind: string, _action: string, _thresholdRaw: number, _action2?: string): boolean {
    void kind;
    return false;
    // Original switch follows but is unreachable — kept only until the
    // delete pass; the typed `kind` would force re-typing every line. The
    // safer move is to replace the body wholesale.
    /* legacy switch (removed): switch(kind) {
    const body = this.sprite.body;
    const thresh = Number(thresholdRaw) || 0;
    switch (kind) {
      case "always":
        return true;
      case "isMoving":
        return body ? Math.abs(body.velocity.x) > thresh : false;
      case "isMovingAny":
        return body ? (body.velocity.x ** 2 + body.velocity.y ** 2) > thresh * thresh : false;
      case "velocityXAbove":
        return body ? body.velocity.x > thresh : false;
      case "velocityXBelow":
        return body ? body.velocity.x < thresh : false;
      case "velocityYAbove":
        return body ? body.velocity.y > thresh : false;
      case "velocityYBelow":
        return body ? body.velocity.y < thresh : false;
      case "isGrounded":
        return body ? (body.blocked.down || body.touching.down) : false;
      case "isAirborne":
        return body ? !(body.blocked.down || body.touching.down) : false;
      case "inputPressed": {
        const inputs = getInputActions(this.sprite.scene);
        return !!inputs && !!action && inputs.justPressed(action);
      }
      case "inputBuffered": {
        if (!action || this.inputBufferMs <= 0) return false;
        const stampMs = this._bufferedInputAtMs.get(action);
        if (stampMs === undefined) return false;
        return (this.sprite.scene.time.now - stampMs) <= this.inputBufferMs;
      }
      case "inputHeld": {
        const inputs = getInputActions(this.sprite.scene);
        return !!inputs && !!action && inputs.isDown(action);
      }
      case "isWallSliding": {
        // Trust CM's `wallSliding` flag — it owns the full truth (touching
        // wall + airborne + falling + input/contact mode, with a 100 ms
        // coyote window to ride out Phaser separation gaps, and explicit
        // false-set + 150 ms suppression after wall jump). Adding a
        // second `vy >= 0` gate here was the flicker source: Phaser's
        // physics step can leave vy briefly negative between CM's clamp
        // and this read, dropping wallslide for 1 tick → fall wins →
        // wallslide re-fires → state stutters.
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { wallSliding?: boolean } | undefined;
        return !!cm && cm.wallSliding === true;
      }
      case "isDashing": {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { dashing?: boolean } | undefined;
        return !!cm && cm.dashing === true;
      }
      case "isByWallLeft":
        return body ? (body.blocked.left || body.touching.left) : false;
      case "isByWallRight":
        return body ? (body.blocked.right || body.touching.right) : false;
      case "isByWall":
        return body ? (body.blocked.left || body.touching.left || body.blocked.right || body.touching.right) : false;
      case "isFacingLeft":
        return this.sprite.facingScaleX < 0;
      case "isFacingRight":
        return this.sprite.facingScaleX > 0;
      case "facingDir":
        // Persistent 8-way movement facing equals the requested direction.
        return this.facingDir === action;
      case "isWallJumping": {
        // Sustained: true from the moment CM fires its wall-jump branch
        // until either vy becomes non-negative (apex reached) or 1 s has
        // passed (safety bound). Use this — instead of justWallJumped —
        // on the jump state's "AND NOT" extra so jump can't steal the
        // win during the entire wall-jump ascent.
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { wallJumpedAtSec?: number; now?: number } | undefined;
        if (!cm || cm.wallJumpedAtSec === undefined || cm.now === undefined || !body) return false;
        if (cm.now - cm.wallJumpedAtSec > 1.0) return false;
        return body.velocity.y < 0;
      }
      case "justLanded":
        return this._justLanded;
      case "justTurnedLeft":
        return this._justTurnedLeft;
      case "justTurnedRight":
        return this._justTurnedRight;
      case "justWallJumped": {
        // Brief edge (~0.12 s) after the wall-jump branch fired. Pairs
        // with a one-shot walljump state so the anim latches via
        // isMainOneShot. For "block jump throughout the ascent", use
        // `isWallJumping` instead — that one tracks vy < 0.
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { wallJumpedAtSec?: number; now?: number } | undefined;
        if (!cm || cm.wallJumpedAtSec === undefined || cm.now === undefined) return false;
        return cm.now - cm.wallJumpedAtSec < 0.12;
      }
      case "varEquals":
      case "varAbove":
      case "varBelow": {
        // BP variable comparisons. `action` holds the var name. The
        // var's value is coerced to number via Number() so booleans
        // and numeric strings work naturally; non-numeric strings
        // produce NaN → comparison fails.
        if (!action) return false;
        const v = this.sprite.vars.get(action);
        if (v === undefined) return false;
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) return false;
        if (kind === "varEquals") return n === thresh;
        if (kind === "varAbove")  return n > thresh;
        return n < thresh;
      }
      case "isAnimationPlaying": {
        // SR's currentAnimation is set per-tick from the animator's
        // state machine. Empty action = always false (no name to match).
        if (!action) return false;
        const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as { currentAnimation?: string } | undefined;
        return !!sr && sr.currentAnimation === action;
      }
      case "isState":
        return !!action && this.currentState === action;
      case "previousStateWas":
        return !!action && this.previousState === action;
      case "previousAnimWas":
        return !!action && this.previousAnim === action;
      case "isTracerHit": {
        const tracer = this.findTracerByName(action);
        return !!tracer && !!tracer.lastHit;
      }
      case "tracerJustHit": {
        const tracer = this.findTracerByName(action);
        return !!tracer && tracer.justHit === true;
      }
      case "tracerHitHasTag": {
        if (!action2) return false;
        const tracer = this.findTracerByName(action);
        const tags = tracer?.lastHit?.actorTags;
        return Array.isArray(tags) && tags.includes(action2);
      }
      case "signalFired": {
        if (!action) return false;
        const bus = this.sprite.events as unknown as { firedThisFrame?: (n: string) => boolean };
        return !!bus.firedThisFrame && bus.firedThisFrame(action);
      }
      case "signalFiredEdge": {
        if (!action) return false;
        const bus = this.sprite.events as unknown as { firedExactlyThisFrame?: (n: string) => boolean };
        return !!bus.firedExactlyThisFrame && bus.firedExactlyThisFrame(action);
      }
      case "justCollidedWithTag": {
        if (!action) return false;
        const set = (this.sprite as unknown as { _justCollidedThisTick?: Set<{ tags: Set<string> }> })._justCollidedThisTick;
        if (!set) return false;
        for (const other of set) if (other.tags.has(action)) return true;
        return false;
      }
      case "isOverlappingTag": {
        if (!action) return false;
        const set = (this.sprite as unknown as { _currOverlap?: Set<{ tags: Set<string> }> })._currOverlap;
        if (!set) return false;
        for (const other of set) if (other.tags.has(action)) return true;
        return false;
      }
      case "justSeparatedFromTag": {
        if (!action) return false;
        const set = (this.sprite as unknown as { _justSeparatedThisTick?: Set<{ tags: Set<string> }> })._justSeparatedThisTick;
        if (!set) return false;
        for (const other of set) if (other.tags.has(action)) return true;
        return false;
      }
      case "isAIState": {
        if (!action) return false;
        const brain = this.sprite.findBehaviorByKind("AIBrain") as { state?: string } | undefined;
        return brain?.state === action;
      }
      case "hasAITarget": {
        const brain = this.sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
        return !!brain && (brain.targetUid ?? -1) !== -1;
      }
      case "noAITarget": {
        const brain = this.sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
        return !brain || (brain.targetUid ?? -1) === -1;
      }
      case "isDead": {
        const d = this.sprite.findBehaviorByKind("Damageable") as { isDead?: boolean } | undefined;
        return !!d?.isDead;
      }
      case "isInHitstun": {
        const d = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
        return !!d?.isInHitstun?.();
      }
      case "isInIframes": {
        const d = this.sprite.findBehaviorByKind("Damageable") as { isInIframes?: () => boolean } | undefined;
        return !!d?.isInIframes?.();
      }
      case "isJumping": {
        const body = (this.sprite as unknown as { body?: { velocity?: { y?: number }; blocked?: { down?: boolean }; touching?: { down?: boolean } } }).body;
        if (!body) return false;
        const grounded = !!(body.blocked?.down || body.touching?.down);
        return !grounded && (body.velocity?.y ?? 0) < 0;
      }
      case "isFalling": {
        const body = (this.sprite as unknown as { body?: { velocity?: { y?: number }; blocked?: { down?: boolean }; touching?: { down?: boolean } } }).body;
        if (!body) return false;
        const grounded = !!(body.blocked?.down || body.touching?.down);
        return !grounded && (body.velocity?.y ?? 0) > 0;
      }
      case "isRunning": {
        const body = (this.sprite as unknown as { body?: { velocity?: { x?: number }; blocked?: { down?: boolean }; touching?: { down?: boolean } } }).body;
        if (!body) return false;
        const grounded = !!(body.blocked?.down || body.touching?.down);
        return grounded && Math.abs(body.velocity?.x ?? 0) > 100;
      }
      case "canJump": {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { jumpsUsed?: number; multiJump?: number } | undefined;
        if (!cm) return false;
        return (cm.jumpsUsed ?? 0) < (cm.multiJump ?? 1);
      }
      case "canDash": {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { dashing?: boolean; dashReadyAtSec?: number; now?: number } | undefined;
        if (!cm) return false;
        const now = (this.sprite.scene.time.now / 1000);
        return cm.dashing !== true && now >= (cm.dashReadyAtSec ?? 0);
      }
      case "isDoubleJumpEnabled": {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as { multiJump?: number } | undefined;
        return (cm?.multiJump ?? 1) > 1;
      }
      case "isStateEnabled": {
        if (!action) return false;
        const row = this.states.find((s) => s.name === action);
        if (!row) return false;
        return row.enabled !== 0;
      }
      case "varTrue":
      case "varFalse": {
        if (!action) return false;
        const v = this.sprite.vars.get(action);
        // Truthiness rules tailored for authored vars:
        //   - undefined / null → falsy.
        //   - boolean → use as-is.
        //   - number → falsy when 0.
        //   - string → falsy when "", "false", or "0" (otherwise truthy).
        // The string check matters because action-set vars typed via the
        // text input land here as strings unless we coerced them (e.g.
        // legacy saves) — without this, the string "false" would read
        // as truthy and Var-is-true would always match.
        let truthy: boolean;
        if (v === undefined || v === null) truthy = false;
        else if (typeof v === "boolean") truthy = v;
        else if (typeof v === "number") truthy = v !== 0;
        else if (typeof v === "string") truthy = v !== "" && v !== "false" && v !== "0";
        else truthy = !!v;
        return kind === "varTrue" ? truthy : !truthy;
      }
      default:
        return false;
    } */
  }
}
