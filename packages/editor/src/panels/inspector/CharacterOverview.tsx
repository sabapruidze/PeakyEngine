import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useEditor } from "../../store";
import type { BlueprintDef } from "../../project";
import { COMPONENT_THEME, type ComponentTheme, conditionComponent, CONDITION_PARAM_DEFAULTS, humanizeKind } from "./LogicSheet/nodeRegistry";
import { SignalPicker } from "../../components/SignalPicker";
import { ExpressionField } from "../ExpressionField";
import { BEHAVIOR_PARAMS } from "../../behaviorMeta";
import { Toggle } from "../../components/Toggle";
import { CONDITION_KINDS, type Condition as SharedCondition, type ConditionKind } from "@peaky/shared";

// Prominent "add row" button — used for the secondary list adders inside the
// State Machine panels (signal / combo step / extra condition / frame motion)
// so they read as real buttons, not dim dashed text.
const ADD_BTN: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 12px",
  fontSize: 11,
  fontWeight: 600,
  background: "var(--teal)",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
};

// Per-BP State Machine UI open-state (which state rows are expanded + the
// input-gates panel). Persisted to localStorage so leaving the BP tab /
// scene and coming back restores exactly what the user had open. Mirrors
// BlueprintTab's loadBpState/saveBpState pattern.
const SM_UI_KEY = (bpId: string) => `peaky.sm-ui.${bpId}`;
interface SmUiState { expandedRows: number[]; inputGatesOpen: boolean; selectedMachineKey: string; }
const PRIMARY_MACHINE_KEY = "__primary__";
function loadSmUi(bpId: string): SmUiState {
  try {
    const raw = localStorage.getItem(SM_UI_KEY(bpId));
    if (!raw) return { expandedRows: [], inputGatesOpen: false, selectedMachineKey: PRIMARY_MACHINE_KEY };
    const p = JSON.parse(raw);
    return {
      expandedRows: Array.isArray(p.expandedRows)
        ? p.expandedRows.filter((n: unknown) => typeof n === "number")
        : [],
      inputGatesOpen: !!p.inputGatesOpen,
      selectedMachineKey: typeof p.selectedMachineKey === "string" ? p.selectedMachineKey : PRIMARY_MACHINE_KEY,
    };
  } catch { return { expandedRows: [], inputGatesOpen: false, selectedMachineKey: PRIMARY_MACHINE_KEY }; }
}
function saveSmUi(bpId: string, patch: Partial<SmUiState>): void {
  try {
    const cur = loadSmUi(bpId);
    localStorage.setItem(SM_UI_KEY(bpId), JSON.stringify({ ...cur, ...patch }));
  } catch { /* quota / private mode — silent */ }
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--inner)",
        borderRadius: 8,
        color: "var(--text-dim)",
        fontSize: 11,
        lineHeight: 1.5,
        border: "1px dashed rgba(255,255,255,0.08)",
      }}
    >
      {text}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Animation state-machine table
//
// Each row = one entry in CharacterAnimator.config.states[]. Users add /
// remove / reorder rows; the runtime evaluates them every tick in
// descending-priority order and writes the winning state's animation to
// the host's SpriteRenderer. Condition-specific extra fields (action /
// threshold) appear conditionally based on the chosen Condition Kind so
// the row stays readable.
// ──────────────────────────────────────────────────────────────────────────

interface FrameSignalRow {
  anim: string;
  frames: number[];
  signal: string;
  /** Optional broadcast tag. Empty = self-emit only (classic). When set,
   *  the signal ALSO fans out to every live sprite carrying this tag —
   *  same routing as `EmitSignalTo`. Self-emit still fires either way so
   *  host-side Tracers wired to the signal keep working. */
  targetTag?: string;
}

interface FrameMotionRow {
  frame: number;
  /** Accepts a plain number OR an expression string: `random(40, 80)`,
   *  `var:dashRange`, `random(-20,20) + 80`, etc. Resolved by the
   *  runtime's numOr at fire time. */
  dx: number | string;
  dy: number | string;
  mode: "instant" | "tween";
  duration: number;
  /** When on, the motion is skipped if it would push the body into a
   *  Solid (lookahead overlap test against the scene's static bodies).
   *  Stops attack lunges from clipping through walls / ceilings. */
  skipIfBlocked?: boolean;
  /** Combo anim this motion applies to. Empty = all anims (combo or
   *  not). When set, motion only fires while SR's currentAnimation
   *  matches this name. */
  anim?: string;
}

interface AnimStateRow {
  name: string;
  priority: number;
  /** When 0, the state is skipped by the animator's priority loop —
   *  never wins, never plays. Toggleable from the editor (initial
   *  state) and at runtime via the SetStateEnabled action. Optional
   *  for backward-compat; undefined === enabled. */
  enabled?: number;
  /** When true, AIBrain stays paused while this state is active.
   *  Tighter coupling than name-matching: rename freely, the flag
   *  stays attached. Default-on for hurt/death in NPC template. */
  pausesAI?: boolean;
  /** Minimum PhaseManager.currentPhase for this state to be eligible.
   *  Undefined = no lower bound. Used to gate Boss attack states behind
   *  HP-driven phase transitions without per-state IsBetween chains. */
  minPhase?: number;
  /** Maximum PhaseManager.currentPhase for this state to be eligible.
   *  Undefined = no upper bound. Set when a state should retire in
   *  later phases (e.g. a phase-0 weak attack the enraged boss drops). */
  maxPhase?: number;
  animation: string;
  enterAnim?: string;
  exitAnim?: string;
  /** @deprecated — kept so older saves don't break. Replaced by useEnter/useExit. */
  useTransitions?: boolean;
  /** Run the enter anim when entering this state. Defaults to false. */
  useEnter?: boolean;
  /** Run the exit anim when leaving this state. Defaults to false. */
  useExit?: boolean;
  loop: boolean;
  /** Primary condition — full Logic Sheet `Condition`. Any of the 75+
   *  unified ConditionKinds (Compare, OnKeyPressed, IsTracerHit, IsAIState,
   *  CompareValues with var:/tracer:/weapon: expressions, etc.). */
  primary: import("@peaky/shared").Condition;
  /** Advanced settings — see runtime CharacterAnimator for semantics. */
  freezeMovement?: boolean;
  /** Block CM input every tick the state is active in main phase, without
   *  zeroing velocity. Used for "dash" / "attack" states where CM is
   *  driving the motion and we just want to block player override. */
  ignoreInput?: boolean;
  frameMotions?: FrameMotionRow[];
  /** Frame-triggered signals: per-state list mapping (anim, frames) →
   *  signal name. Fires on the SR frame-enter edge. */
  frameSignals?: FrameSignalRow[];
  /** When true and the state's main anim is one-shot (sprite asset
   *  loop=false), the state holds on the last frame after the anim
   *  ends instead of releasing. Useful for death / interact / pose
   *  states. Default false. */
  holdOnFinish?: boolean;
  /** Lock facing while this state's animation plays a cycle (suppress the
   *  auto-flip from CM mirror + AIBrain). For attacks. Default false. */
  lockFacing?: boolean;
  /** Ordered list of animation names the state cycles through on each
   *  re-entry. attack1 → comboAnimations[0], attack2 → [1], etc. When
   *  set + non-empty, the `animation` field is ignored for this state. */
  comboAnimations?: string[];
  /** When true, combo plays a weighted-random step each entry instead
   *  of advancing through the list. */
  comboRandom?: boolean;
  /** Parallel to `comboAnimations`. Per-step weight (0..100). Higher =
   *  more likely. Used only when `comboRandom` is true. Missing entries
   *  default to 100. Sum need not total 100. */
  comboWeights?: number[];
  /** When `comboRandom` is on, suppress picking the same anim twice in
   *  a row. Falls back to the full set when only one step is eligible. */
  comboRandomNoRepeat?: boolean;
  /** Per-state combo-window override (seconds). Falls back to the
   *  animator-level default when missing/0. */
  comboWindow?: number;
  /** Per-state hysteresis override (ms). Replaces the animator-wide
   *  60 ms default when this state is the prior active one being
   *  considered for sticking. Falls back to 60 ms when 0/missing. */
  hysteresisMs?: number;
  /** Per-state re-entry guard override (ms). Replaces the animator-
   *  wide 80 ms default for the "skip enter anim on rapid re-entry"
   *  window. Falls back to 80 ms when 0/missing. */
  reEntryGuardMs?: number;
  /** Replay this state's anim from frame 0 when its signal condition
   *  re-fires while already active (e.g. a 2nd hit mid-hurt). */
  retrigger?: boolean;
  /** Extras combined with primary via matchAny (default AND). Each entry
   *  is a full Logic Sheet Condition. */
  extras?: import("@peaky/shared").Condition[];
  /** Top-level combine for (primary + extras + the folded sub-group):
   *  false/omitted = AND, true = OR. */
  matchAny?: boolean;
  /** Sub conditions combined via subMatchAny, folded into the top group
   *  as ONE term joined by matchAny. */
  subs?: import("@peaky/shared").Condition[];
  /** Combine for the sub-conditions: false/omitted = AND, true = OR. */
  subMatchAny?: boolean;
}

/** One extra condition row. Mirrors the primary condition's fields.
 *  `negate` flips the row's result. How rows combine (all-AND vs any-OR) is
 *  the state-level `matchAny` flag — there is no per-row operator. */
type ExtraConditionRow = import("@peaky/shared").Condition;

/** Per-input gate config. The named action is treated as NOT-pressed
 *  while any condition in the AND-list fails. */
interface InputGate {
  action: string;
  conditions: import("@peaky/shared").Condition[];
}

/** Starter set for an AI-driven NPC. Mirrors the CharacterAnimator config
 *  inlined into the NPC class defaults so "Reset" / "Add Missing" on an
 *  NPC produce the same state machine a brand-new NPC ships with. */
const NPC_STARTER_STATES: AnimStateRow[] = [
  { name: "death",   priority: 100, animation: "death",   enterAnim: "", exitAnim: "", useTransitions: false, loop: false, primary: { kind: "CompareValues", left: "var:hp", op: "==", right: "0" } },
  { name: "hurt",    priority: 95,  animation: "hurt",    enterAnim: "", exitAnim: "", useTransitions: false, loop: false, primary: { kind: "IsSignalFiring", signal: "OnDamageTaken" } },
  { name: "attack",  priority: 90,  animation: "attack",  enterAnim: "", exitAnim: "", useTransitions: false, loop: false, primary: { kind: "IsAIState", action: "attack" } },
  { name: "flee",    priority: 70,  animation: "flee",    enterAnim: "", exitAnim: "", useTransitions: false, loop: true,  primary: { kind: "IsAIState", action: "flee" } },
  { name: "chase",   priority: 50,  animation: "chase",   enterAnim: "", exitAnim: "", useTransitions: false, loop: true,  primary: { kind: "IsAIState", action: "chase" } },
  { name: "search",  priority: 40,  animation: "search",  enterAnim: "", exitAnim: "", useTransitions: false, loop: true,  primary: { kind: "IsAIState", action: "search" } },
  { name: "alert",   priority: 30,  animation: "alert",   enterAnim: "", exitAnim: "", useTransitions: false, loop: true,  primary: { kind: "IsAIState", action: "alert" } },
  { name: "idle",    priority: 0,   animation: "idle",    enterAnim: "", exitAnim: "", useTransitions: false, loop: true,  primary: { kind: "Always" } },
];

/** Starter set for a sidescroller Character. Mirrors the BEHAVIOR_DEFAULTS
 *  for CharacterAnimator in project.ts so "Reset" / "Add Missing" produce
 *  the same machine a brand-new Character template ships with. */
const SIDESCROLLER_STARTER_STATES: AnimStateRow[] = [
  { name: "attack",      priority: 100, animation: "attack",      enterAnim: "",           exitAnim: "",           useTransitions: false, loop: false, primary: { kind: "OnKeyPressed", actions: ["Attack"] } },
  { name: "dash",        priority: 80,  animation: "dash",        enterAnim: "",           exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "IsDashing" } },
  { name: "wallslide",   priority: 60,  animation: "wallslide",   enterAnim: "wallslide_in",exitAnim: "",           useTransitions: true,  loop: true,  primary: { kind: "IsWallSliding" } },
  { name: "walljump",    priority: 65,  animation: "walljump",    enterAnim: "",           exitAnim: "",           useTransitions: false, loop: false, primary: { kind: "JustWallJumped" } },
  { name: "land",        priority: 55,  animation: "land",        enterAnim: "",           exitAnim: "",           useTransitions: false, loop: false, primary: { kind: "OnLand" } },
  { name: "jump",        priority: 50,  animation: "jump",        enterAnim: "jump_start", exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "Compare", property: "velocity.y", op: "<", value: 0 } },
  { name: "fall",        priority: 40,  animation: "fall",        enterAnim: "",           exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "IsAirborne" } },
  { name: "turn_left",   priority: 30,  animation: "turn_left",   enterAnim: "",           exitAnim: "",           useTransitions: false, loop: false, primary: { kind: "JustTurnedLeft" } },
  { name: "turn_right",  priority: 30,  animation: "turn_right",  enterAnim: "",           exitAnim: "",           useTransitions: false, loop: false, primary: { kind: "JustTurnedRight" } },
  { name: "crouch",      priority: 20,  animation: "crouch",      enterAnim: "crouch_in",  exitAnim: "crouch_out", useTransitions: false, loop: true,  primary: { kind: "IsActionHeld", action: "Crouch" } },
  { name: "run",         priority: 15,  animation: "run",         enterAnim: "",           exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "IsMoving", value: 100 } },
  { name: "walk",        priority: 10,  animation: "walk",        enterAnim: "",           exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "IsMoving", value: 5 } },
  { name: "idle",        priority: 0,   animation: "idle",        enterAnim: "",           exitAnim: "",           useTransitions: false, loop: true,  primary: { kind: "Always" } },
];

/**
 * Map each AnimConditionKind to its owning component for color/chip
 * routing in the condition dropdown. Mirrors the Logic Sheet's
 * `conditionComponent()` helper. Names here match the keys in
 * `COMPONENT_THEME` (from nodeRegistry).
 */
const ANIM_CONDITION_TO_COMPONENT: Record<string, string> = {
  // CharacterMovement state checks
  isMoving: "CharacterMovement", velocityXAbove: "CharacterMovement",
  velocityXBelow: "CharacterMovement", velocityYAbove: "CharacterMovement",
  velocityYBelow: "CharacterMovement",
  isGrounded: "CharacterMovement", isAirborne: "CharacterMovement",
  isWallSliding: "CharacterMovement", isByWallLeft: "CharacterMovement",
  isByWallRight: "CharacterMovement", isByWall: "CharacterMovement",
  isDashing: "CharacterMovement", isWallJumping: "CharacterMovement",
  isFacingLeft: "CharacterMovement", isFacingRight: "CharacterMovement",
  justLanded: "CharacterMovement", justTurnedLeft: "CharacterMovement",
  justTurnedRight: "CharacterMovement", justWallJumped: "CharacterMovement",
  isJumping: "CharacterMovement", isFalling: "CharacterMovement",
  isRunning: "CharacterMovement", canJump: "CharacterMovement",
  canDash: "CharacterMovement", isDoubleJumpEnabled: "CharacterMovement",
  compareCMParam: "CharacterMovement",
  // Animator state-machine extras
  isStateEnabled: "SpriteRenderer",
  // Input
  inputPressed: "System", inputBuffered: "System", inputHeld: "System",
  // Variables
  varEquals: "Variables", varAbove: "Variables", varBelow: "Variables",
  varTrue: "Variables", varFalse: "Variables",
  // SpriteRenderer / animator
  isAnimationPlaying: "SpriteRenderer", compareFrame: "SpriteRenderer",
  isState: "SpriteRenderer", previousStateWas: "SpriteRenderer",
  previousAnimWas: "SpriteRenderer",
  // Tracer
  isTracerHit: "Tracer", tracerJustHit: "Tracer", tracerHitHasTag: "Tracer",
  // Signals + tag collisions
  signalFired: "Signals", signalFiredEdge: "Signals",
  justCollidedWithTag: "Collider", isOverlappingTag: "Collider",
  justSeparatedFromTag: "Collider",
  // AI Brain
  isAIState: "AIBrain", hasAITarget: "AIBrain", noAITarget: "AIBrain",
  // Damageable
  isDead: "Damageable", isInHitstun: "Damageable", isInIframes: "Damageable",
  // Behavior toggle
  isBehaviorEnabled: "Behavior",
  // Default / fallback
  always: "Flow",
};

function animConditionTheme(kind: string): ComponentTheme {
  const comp = ANIM_CONDITION_TO_COMPONENT[kind] ?? "Flow";
  return COMPONENT_THEME[comp] ?? COMPONENT_THEME.Flow;
}

const CONDITION_OPTIONS: { value: string; label: string; needs: "action" | "threshold" | "none" | "varName" | "varCompare" | "tracer" | "tracerWithTag" | "signal" | "tag" | "aiState" | "direction" }[] = [
  { value: "always",         label: "Always (fallback)",        needs: "none" },
  { value: "isMoving",       label: "Body moving (|vx| > N)",   needs: "threshold" },
  { value: "isMovingAny",    label: "Moving any direction (speed > N)", needs: "threshold" },
  { value: "inputPressed",   label: "Input just pressed",       needs: "action" },
  { value: "inputBuffered",  label: "Input buffered (within window)", needs: "action" },
  { value: "inputHeld",      label: "Input held",               needs: "action" },
  { value: "velocityXAbove", label: "velocity.x > N",           needs: "threshold" },
  { value: "velocityXBelow", label: "velocity.x < N",           needs: "threshold" },
  { value: "velocityYAbove", label: "velocity.y > N (falling)", needs: "threshold" },
  { value: "velocityYBelow", label: "velocity.y < N (jumping)", needs: "threshold" },
  { value: "isGrounded",      label: "Grounded",                needs: "none" },
  { value: "isAirborne",      label: "Airborne",                needs: "none" },
  { value: "isWallSliding",   label: "Wall sliding (CM)",       needs: "none" },
  { value: "isByWallLeft",    label: "Wall on left",            needs: "none" },
  { value: "isByWallRight",   label: "Wall on right",           needs: "none" },
  { value: "isByWall",        label: "By wall (either side)",   needs: "none" },
  { value: "isDashing",       label: "Dashing (CM)",            needs: "none" },
  { value: "isWallJumping",   label: "Wall-jumping (ascent)",   needs: "none" },
  { value: "isFacingLeft",    label: "Facing left",             needs: "none" },
  { value: "isFacingRight",   label: "Facing right",            needs: "none" },
  { value: "facingDir",       label: "Facing direction ==",     needs: "direction" },
  { value: "justLanded",      label: "Just landed (edge)",       needs: "none" },
  { value: "justTurnedLeft",  label: "Just turned left (edge)",  needs: "none" },
  { value: "justTurnedRight", label: "Just turned right (edge)", needs: "none" },
  { value: "justWallJumped",  label: "Just wall-jumped (edge)",  needs: "none" },
  { value: "varEquals",       label: "Var == N",                needs: "varCompare" },
  { value: "varAbove",        label: "Var > N",                 needs: "varCompare" },
  { value: "varBelow",        label: "Var < N",                 needs: "varCompare" },
  { value: "varTrue",         label: "Var is true",             needs: "varName" },
  { value: "varFalse",        label: "Var is false",            needs: "varName" },
  { value: "isAnimationPlaying", label: "Animation is playing", needs: "varName" },
  { value: "isState",         label: "State is",                needs: "varName" },
  { value: "previousStateWas", label: "Previous state was",     needs: "varName" },
  { value: "previousAnimWas",  label: "Previous anim was",      needs: "varName" },
  { value: "isTracerHit",      label: "Tracer is hit",          needs: "tracer" },
  { value: "tracerJustHit",    label: "Tracer just hit (edge)", needs: "tracer" },
  { value: "tracerHitHasTag",  label: "Tracer hit has tag",     needs: "tracerWithTag" },
  { value: "signalFired",      label: "On signal (within frame)", needs: "signal" },
  { value: "signalFiredEdge",  label: "On signal (edge, exact frame)", needs: "signal" },
  { value: "justCollidedWithTag",  label: "Just collided with tag",   needs: "tag" },
  { value: "isOverlappingTag",     label: "Is overlapping tag",       needs: "tag" },
  { value: "justSeparatedFromTag", label: "Just separated from tag",  needs: "tag" },
  { value: "isAIState",            label: "AI brain state ==",          needs: "aiState" },
  { value: "hasAITarget",          label: "AI has target (sighted)",    needs: "none" },
  { value: "noAITarget",           label: "AI has no target (out of sight)", needs: "none" },
  // ─── Damageable (when attached) ─────────────────────────────────────
  { value: "isDead",               label: "Is dead",                    needs: "none" },
  { value: "isInHitstun",          label: "Is in hitstun",              needs: "none" },
  { value: "isInIframes",          label: "Is in i-frames",             needs: "none" },
  // ─── CharacterMovement extras ──────────────────────────────────────
  { value: "isJumping",            label: "Is jumping (rising)",        needs: "none" },
  { value: "isFalling",            label: "Is falling",                 needs: "none" },
  { value: "isRunning",            label: "Is running (vx > 100)",      needs: "none" },
  { value: "canJump",              label: "Can jump (jumps remaining)", needs: "none" },
  { value: "canDash",              label: "Can dash (cooldown ready)",  needs: "none" },
  { value: "isDoubleJumpEnabled",  label: "Double-jump enabled",        needs: "none" },
  // ─── Animator state machine extras ─────────────────────────────────
  { value: "isStateEnabled",       label: "State is enabled",           needs: "varName" },
];

/** Signals emitted by built-in behaviors — surfaced as dropdown options
 *  for `signalFired` / `signalFiredEdge` conditions so authors discover
 *  them instead of guessing names. Datalist still allows custom signals. */
const BUILT_IN_SIGNALS = [
  "OnDamageTaken", "OnDeath", "OnHealed",
  "OnJump", "OnLand", "OnFall", "OnDashStart", "OnDashEnd", "OnMoved", "OnStopped",
  "OnAnimationFinished",
  "OnTracerHit", "OnTracerLost",
  "AttackFrame", "OnTargetSighted", "OnTargetLost",
  "OnSquashStretchEnd", "OnCameraPanEnd",
  // PhaseManager — generic + per-phase variants emitted on transitions.
  "OnPhaseEnter", "OnPhaseExit",
];

/** Valid AIBrain states — surfaced as strict dropdown for `isAIState` so
 *  authors can't typo a state that doesn't exist. */
const AI_STATE_OPTIONS = ["idle", "alert", "chase", "search", "attack", "flee", "rest"];

/** 8-way movement directions for the `facingDir` condition. `value` MUST match
 *  the runtime's FACING_DIRS_8 strings; `label` is the friendly UI text. */
const DIRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: "up",        label: "Up" },
  { value: "upright",   label: "Up-Right" },
  { value: "right",     label: "Right" },
  { value: "downright", label: "Down-Right" },
  { value: "down",      label: "Down" },
  { value: "downleft",  label: "Down-Left" },
  { value: "left",      label: "Left" },
  { value: "upleft",    label: "Up-Left" },
];

/**
 * Component-themed condition picker — visual parity with the Logic Sheet
 * palette. Replaces the native `<select>` so each option carries a
 * colored chip showing which subsystem the condition belongs to
 * (CharacterMovement / Tracer / Damageable / etc.), grouped by
 * component in the dropdown body.
 */
function ConditionDropdown({
  value, onChange, style,
}: {
  value: string;
  onChange: (next: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const current = CONDITION_OPTIONS.find((o) => o.value === value);
  const currentTheme = current ? animConditionTheme(current.value) : COMPONENT_THEME.Flow;
  // Group options by owning component for the popup. Order matches the
  // visual order in the Logic Sheet palette (gameplay → visual → meta).
  const COMPONENT_ORDER = [
    "CharacterMovement", "SpriteRenderer", "Tracer", "Damageable",
    "AIBrain", "Collider", "Variables", "Signals", "System",
    "Behavior", "Flow",
  ];
  const groups = new Map<string, typeof CONDITION_OPTIONS>();
  for (const opt of CONDITION_OPTIONS) {
    const comp = ANIM_CONDITION_TO_COMPONENT[opt.value] ?? "Flow";
    const arr = groups.get(comp) ?? [];
    arr.push(opt);
    groups.set(comp, arr);
  }
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "2px 8px", fontSize: 11, minWidth: 110, width: "100%",
          background: "var(--inner)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 3, color: "var(--text)", cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            background: currentTheme.chipBg, color: currentTheme.chipFg,
            fontSize: 8, fontWeight: 700,
            padding: "1px 5px", borderRadius: 3,
            textTransform: "uppercase", letterSpacing: 0.5,
            whiteSpace: "nowrap",
          }}
        >{currentTheme.label}</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.label ?? value}
        </span>
        <span style={{ fontSize: 9, color: "var(--text-dim)" }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0,
          marginTop: 2, minWidth: 260, maxWidth: 360, maxHeight: 360,
          overflowY: "auto",
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 4, padding: 4, zIndex: 1000,
          boxShadow: "0 6px 16px rgba(0,0,0,0.5)",
        }}>
          {COMPONENT_ORDER.flatMap((comp) => {
            const opts = groups.get(comp);
            if (!opts || opts.length === 0) return [];
            const theme = COMPONENT_THEME[comp] ?? COMPONENT_THEME.Flow;
            return [
              <div key={`hdr-${comp}`} style={{
                fontSize: 9, color: theme.chipBg,
                textTransform: "uppercase", letterSpacing: 0.5,
                padding: "6px 6px 2px", fontWeight: 700,
              }}>{theme.label}</div>,
              ...opts.map((opt) => (
                <div
                  key={opt.value}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  style={{
                    padding: "3px 6px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 6,
                    background: opt.value === value ? "rgba(255,205,60,0.15)" : "transparent",
                    borderRadius: 2, fontSize: 11,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = opt.value === value ? "rgba(255,205,60,0.15)" : "transparent"; }}
                >
                  <span style={{
                    background: theme.chipBg, color: theme.chipFg,
                    width: 8, height: 8, borderRadius: 2,
                    flex: "0 0 auto",
                  }} />
                  <span style={{ color: "#f0f0f0" }}>{opt.label}</span>
                </div>
              )),
            ];
          })}
        </div>
      )}
    </div>
  );
}

export function AnimStateTable({ bp }: { bp: BlueprintDef }) {
  const updateBehavior = useEditor((s) => s.updateBlueprintBehavior);
  const sprites = useEditor((s) => s.project.sprites);
  const inputActions = useEditor((s) => s.project.inputActions);
  const projectSignals = useEditor((s) => s.project.signals);
  const projectBPs = useEditor((s) => s.project.blueprints);
  const projectScenes = useEditor((s) => s.project.scenes);
  const projectSounds = useEditor((s) => s.project.sounds);
  const projectItems = useEditor((s) => s.project.items);
  // Hooks MUST run on every render in the same order — moved above the
  // CharacterAnimator-missing early return below so a BP losing/gaining
  // its animator between renders doesn't mismatch the hook stack and
  // crash the whole subtree.
  const [inputGatesOpen, setInputGatesOpenRaw] = useState(() => loadSmUi(bp.id).inputGatesOpen);
  const setInputGatesOpen = (v: boolean) => {
    setInputGatesOpenRaw(v);
    saveSmUi(bp.id, { inputGatesOpen: v });
  };
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set(loadSmUi(bp.id).expandedRows));
  // Which State Machine is being EDITED (not the runtime-active one). A BP can
  // host several; this selects the one whose state table is shown.
  const [selectedMachineKey, setSelectedMachineKeyRaw] = useState<string>(() => loadSmUi(bp.id).selectedMachineKey);
  const setSelectedMachineKey = (k: string) => {
    setSelectedMachineKeyRaw(k);
    saveSmUi(bp.id, { selectedMachineKey: k });
  };

  // Reload open-state when the inspector is pointed at a different BP without
  // remounting (useState's initializer runs only once per mount). Writes only
  // ever happen through the setters above, so this read-only reload can't clobber.
  useEffect(() => {
    const ui = loadSmUi(bp.id);
    setExpandedRows(new Set(ui.expandedRows));
    setInputGatesOpenRaw(ui.inputGatesOpen);
    setSelectedMachineKeyRaw(ui.selectedMachineKey);
  }, [bp.id]);

  const idx = bp.behaviors.findIndex((b) => b.kind === "StateMachine");
  if (idx < 0) {
    return <Placeholder text="State Machine is missing on this Character BP — re-create it from the Content Browser." />;
  }
  const animatorBehavior = bp.behaviors[idx];
  const cfg = animatorBehavior.config;
  // Machines: the primary (backed by cfg.states) + each extra in
  // cfg.stateMachines. The editor shows ONE at a time, selected by
  // selectedMachineKey. The runtime-active machine is independent (set by the
  // SetActiveStateMachine action) — this selector is purely for authoring.
  const extraMachines: { id: string; name: string; states: AnimStateRow[]; manualAnims?: boolean }[] =
    Array.isArray(cfg.stateMachines) ? (cfg.stateMachines as { id: string; name: string; states: AnimStateRow[]; manualAnims?: boolean }[]) : [];
  const primaryName = typeof cfg.machineName === "string" && cfg.machineName ? cfg.machineName : "Main";
  // `manual` = type animation names by hand instead of the current-sprite
  // dropdown (for a machine whose states run on a swapped sprite).
  const machines: { key: string; name: string; states: AnimStateRow[]; manual: boolean }[] = [
    { key: PRIMARY_MACHINE_KEY, name: primaryName, states: Array.isArray(cfg.states) ? (cfg.states as AnimStateRow[]) : [], manual: !!cfg.machineManualAnims },
    ...extraMachines.map((m) => ({ key: m.id, name: m.name, states: Array.isArray(m.states) ? m.states : [], manual: !!m.manualAnims })),
  ];
  const selectedMachine = machines.find((m) => m.key === selectedMachineKey) ?? machines[0];
  const states: AnimStateRow[] = selectedMachine.states;
  const machineManual = selectedMachine.manual;

  // Animation dropdown options come from the BP's SpriteRenderer sprite.
  const sr = bp.behaviors.find((b) => b.kind === "SpriteRenderer");
  const spriteId = sr ? String(sr.config.spriteId ?? "") : "";
  const sprite = sprites.find((s) => s.id === spriteId);
  const animOptions = sprite ? sprite.animations.map((a) => a.name) : [];
  const inputActionOptions = ["", ...inputActions.map((a) => a.name)];
  // BP variable names — surfaced as a shared <datalist> below so every
  // var-name input gets a dropdown suggestion list while still allowing
  // free typing. The id is unique per BP so multiple Character overviews
  // mounted at once (unusual but possible) don't collide in the DOM.
  const varNameOptions: string[] = Array.isArray(bp.variables)
    ? bp.variables.map((v) => v.name).filter(Boolean)
    : [];
  const varDatalistId = `peaky-bp-vars-${bp.id}`;
  // Tracer names attached to this BP. Each Tracer behavior carries a
  // `name` field (Tracer.name) so a BP with multiple tracers (sword +
  // kick) can target them individually. Empty-named tracers still
  // appear in the list as "(unnamed)" so authors notice and fix.
  const tracerOptions: string[] = (bp.behaviors ?? [])
    .filter((b) => b.kind === "Tracer")
    .map((b) => (b.config as { name?: string } | undefined)?.name ?? "")
    .filter((n, i, arr) => arr.indexOf(n) === i);
  const signalOptions: string[] = Array.from(new Set<string>([
    ...BUILT_IN_SIGNALS,
    ...projectSignals.map((s) => s.name).filter(Boolean),
  ]));
  const signalDatalistId = `peaky-signals-${bp.id}`;
  // Gather tag suggestions from BOTH the BP defaults AND every per-instance
  // tag override across all scenes — without this, a tag that lives only on
  // a specific placement (e.g. one NPC tagged "boss" via instance editor)
  // wouldn't appear in the `tracerHitHasTag` / EmitSignalTo pickers.
  const tagOptions: string[] = Array.from(new Set<string>([
    ...projectBPs.flatMap((b) => b.tags ?? []),
    ...projectScenes.flatMap((sc) => sc.instances.flatMap((inst) => inst.tags ?? [])),
  ].filter(Boolean)));
  const tagDatalistId = `peaky-tags-${bp.id}`;

  // SmartTween (Animator) animation names on this BP — for IsAnimatorAnimPlaying.
  const animatorAnimNames: string[] = (bp.behaviors ?? [])
    .filter((b) => b.kind === "SmartTween")
    .flatMap((b) => {
      const anims = (b.config as { animations?: Array<{ name?: string }> }).animations;
      return Array.isArray(anims) ? anims.map((a) => String(a.name ?? "")).filter(Boolean) : [];
    });
  const soundNames: string[] = Array.isArray(projectSounds) ? projectSounds.map((s) => s.name).filter(Boolean) : [];
  const itemNames: string[] = Array.isArray(projectItems) ? projectItems.map((i) => i.name).filter(Boolean) : [];
  const sceneNames: string[] = projectScenes.map((s) => s.name).filter(Boolean);
  const layerNames: string[] = Array.from(new Set<string>(
    projectScenes.flatMap((sc) => (sc.layers ?? []).map((l) => l.name)).filter(Boolean),
  ));
  const cmParams: string[] = (BEHAVIOR_PARAMS.CharacterMovement ?? []).map((p) => p.key);
  const tmParams: string[] = (BEHAVIOR_PARAMS.TopdownMovement ?? []).map((p) => p.key);

  // Context bundle threaded into every ConditionEditor so its per-field
  // pickers (state / anim / tracer / signal / tag / input action) surface
  // the right options for THIS BP + the currently selected machine.
  const condOpts: CondOpts = {
    stateNames: states.map((s) => s.name).filter(Boolean),
    animNames: animOptions,
    inputActions: inputActionOptions,
    tracerNames: tracerOptions,
    tagOptions,
    animatorAnimNames,
    soundNames,
    itemNames,
    sceneNames,
    layerNames,
    cmParams,
    tmParams,
    varDatalistId,
    signalDatalistId,
    tagDatalistId,
    bpId: bp.id,
  };

  function commit(next: AnimStateRow[]) {
    // Route the edited states to the selected machine: primary → cfg.states,
    // extra → the matching cfg.stateMachines entry.
    if (selectedMachine.key === PRIMARY_MACHINE_KEY) {
      updateBehavior(bp.id, idx, { ...cfg, states: next });
    } else {
      updateBehavior(bp.id, idx, {
        ...cfg,
        stateMachines: extraMachines.map((m) => (m.id === selectedMachine.key ? { ...m, states: next } : m)),
      });
    }
  }
  function addMachine() {
    const name = window.prompt("New State Machine name", `Machine ${machines.length + 1}`);
    if (!name) return;
    const id = `sm-${Math.random().toString(36).slice(2, 10)}`;
    updateBehavior(bp.id, idx, { ...cfg, stateMachines: [...extraMachines, { id, name, states: [] }] });
    setSelectedMachineKey(id);
  }
  function setMachineManual(v: boolean) {
    if (selectedMachine.key === PRIMARY_MACHINE_KEY) {
      updateBehavior(bp.id, idx, { ...cfg, machineManualAnims: v });
    } else {
      updateBehavior(bp.id, idx, {
        ...cfg,
        stateMachines: extraMachines.map((m) => (m.id === selectedMachine.key ? { ...m, manualAnims: v } : m)),
      });
    }
  }
  function renameMachine() {
    const name = window.prompt("Rename State Machine", selectedMachine.name);
    if (!name) return;
    if (selectedMachine.key === PRIMARY_MACHINE_KEY) {
      updateBehavior(bp.id, idx, { ...cfg, machineName: name });
    } else {
      updateBehavior(bp.id, idx, {
        ...cfg,
        stateMachines: extraMachines.map((m) => (m.id === selectedMachine.key ? { ...m, name } : m)),
      });
    }
  }
  function deleteMachine() {
    if (selectedMachine.key === PRIMARY_MACHINE_KEY) {
      window.alert("The primary State Machine can't be deleted — rename it instead.");
      return;
    }
    if (!window.confirm(`Delete State Machine "${selectedMachine.name}" and its states?`)) return;
    const patch: Record<string, unknown> = {
      ...cfg,
      stateMachines: extraMachines.filter((m) => m.id !== selectedMachine.key),
    };
    // Don't leave the runtime default pointing at a machine that no longer exists.
    if (cfg.activeMachine === selectedMachine.name) patch.activeMachine = "";
    updateBehavior(bp.id, idx, patch);
    setSelectedMachineKey(PRIMARY_MACHINE_KEY);
  }
  function patchRow(rowIdx: number, patch: Partial<AnimStateRow>) {
    commit(states.map((s, i) => (i === rowIdx ? { ...s, ...patch } : s)));
  }
  function removeRow(rowIdx: number) {
    commit(states.filter((_, i) => i !== rowIdx));
  }
  function addRow() {
    const nextPriority = states.length === 0
      ? 0
      : Math.min(...states.map((s) => s.priority)) - 10;
    commit([
      ...states,
      {
        name: `state${states.length + 1}`,
        priority: nextPriority,
        animation: animOptions[0] ?? "",
        loop: true,
        primary: { kind: "Always" },
      },
    ]);
  }

  // Debug HUD toggle — flips `CharacterAnimator.debugDraw` so the
  // runtime draws a small overlay above the character showing the
  // animator's state machine decisions tick by tick. Reuses the
  // `idx` + `cfg` resolved at the top of this function.
  const debugDrawOn = Number(cfg.debugDraw ?? 0) !== 0;
  const inputGates: InputGate[] = Array.isArray(cfg.inputGates) ? (cfg.inputGates as InputGate[]) : [];
  function toggleAdvanced(rowIdx: number) {
    const next = new Set(expandedRows);
    if (next.has(rowIdx)) next.delete(rowIdx); else next.add(rowIdx);
    setExpandedRows(next);
    saveSmUi(bp.id, { expandedRows: Array.from(next) });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Shared datalist — every var-name input (in conditions + actions
          + modal) references this via `list={varDatalistId}`. Dropdown
          suggestions only; the input still accepts arbitrary text. */}
      <datalist id={varDatalistId}>
        {varNameOptions.map((n) => <option key={n} value={n} />)}
      </datalist>
      <datalist id={signalDatalistId}>
        {signalOptions.map((n) => <option key={n} value={n} />)}
      </datalist>
      <datalist id={tagDatalistId}>
        {tagOptions.map((n) => <option key={n} value={n} />)}
      </datalist>

      {/* State Machine selector — a BP can host several; these tabs pick which
          one's state table is shown below. The runtime-active machine is a
          separate concept, switched via the SetActiveStateMachine node. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>Machine</span>
        {machines.map((m) => (
          <button
            key={m.key}
            onClick={() => setSelectedMachineKey(m.key)}
            title={m.key === selectedMachine.key ? "Editing this machine" : `Edit "${m.name}"`}
            style={{
              padding: "3px 10px", fontSize: 11, borderRadius: 4, cursor: "pointer",
              border: m.key === selectedMachine.key ? "1px solid var(--accent)" : "1px solid rgba(255,255,255,0.15)",
              background: m.key === selectedMachine.key ? "rgba(120,180,255,0.18)" : "transparent",
              color: "var(--text)", fontWeight: m.key === selectedMachine.key ? 600 : 400,
            }}
          >{m.name} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>· {m.states.length}</span></button>
        ))}
        <button onClick={addMachine} title="Add a new State Machine" style={{ padding: "3px 8px", fontSize: 11, background: "var(--accent)", border: "none", borderRadius: 4, color: "var(--frame)", fontWeight: 600, cursor: "pointer" }}>+ Add</button>
        <button onClick={renameMachine} title="Rename the selected machine" style={{ padding: "3px 8px", fontSize: 11, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}>Rename</button>
        {selectedMachine.key !== PRIMARY_MACHINE_KEY && (
          <button onClick={deleteMachine} title="Delete the selected machine" style={{ padding: "3px 8px", fontSize: 11, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, color: "var(--red)", cursor: "pointer" }}>Delete</button>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)" }} title="Type animation names by hand instead of picking from the current sprite's dropdown. Turn this ON for a machine whose states run on a DIFFERENT sprite (swapped via the SetSprite node) — the current sprite's animation list won't include that sprite's names.">
          <Toggle value={machineManual} onChange={(v) => setMachineManual(v)} />
          Type animation names manually
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }} title="Render a small text panel above the character showing animator's current state / phase / anim / frame.">
          <Toggle
            value={debugDrawOn}
            onChange={(v) => updateBehavior(bp.id, idx, { ...cfg, debugDraw: v ? 1 : 0 })}
          />
          Debug HUD
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }} title="How long the combo chain remembers the previous re-entry (seconds). For a state with `comboAnimations: [a, b, c]`, re-entering within this window advances to the next anim in the list. After window expires, next entry resets to anim[0].">
          Combo Window (s)
          <NumericInput
            value={Number(cfg.comboWindow ?? 0.4)}
            onChange={(v) => updateBehavior(bp.id, idx, { ...cfg, comboWindow: v })}
            style={{ width: 56 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }} title="Input buffer window in milliseconds. States with condition `inputBuffered` match if the named action was just-pressed within the last N ms. Lets a press slightly before the current state ends still trigger the next state (combo follow-up forgiveness).">
          Input Buffer (ms)
          <NumericInput
            value={Number(cfg.inputBufferMs ?? 120)}
            onChange={(v) => updateBehavior(bp.id, idx, { ...cfg, inputBufferMs: v })}
            style={{ width: 56 }}
          />
        </label>
        <button
          onClick={() => setInputGatesOpen(true)}
          title="Configure per-input gates — each input action has an AND-list of conditions; input is treated as not-pressed when conditions fail. Used to block specific inputs (Jump, Attack, Dash, etc.) under specific game states."
          style={{
            fontSize: 10, padding: "3px 8px",
            background: inputGates.length > 0 ? "var(--accent)" : "var(--inner)",
            color: inputGates.length > 0 ? "var(--frame)" : "var(--text-muted)",
            border: "1px dashed rgba(255,255,255,0.2)",
            borderRadius: 4, cursor: "pointer",
          }}
        >Input Gates{inputGates.length > 0 ? ` (${inputGates.length})` : ""}</button>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 4px 4px", lineHeight: 1.5 }}>
        Whether a state's main animation loops or plays once is decided by the <strong>sprite asset</strong>'s loop flag (set in the Sprite editor). Looping anim = state holds while condition is true. One-shot anim = state plays main once then releases.
      </div>

      {/* Header row — split In/Out into separate `In` and `Out` toggles
          so users can enable just the enter without forcing exit on too. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "36px 110px 56px 36px 36px 1fr 1fr 1fr 1.4fr 28px",
        gap: 6,
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--text-dim)",
        paddingLeft: 4,
      }}>
        <span title="Enabled — when off, this state is skipped by the priority loop. Toggle at runtime via SetStateEnabled.">On</span>
        <span>Name</span>
        <span>Prio</span>
        <span title="Use Enter — when on, the Enter anim plays on state entry. When off, main plays directly.">In</span>
        <span title="Use Exit — when on, the Exit anim plays on state exit (delays switching to the next state). When off, the state ends immediately when its condition fails.">Out</span>
        <span>Enter (in)</span>
        <span>Main</span>
        <span>Exit (out)</span>
        <span>Condition</span>
        <span></span>
      </div>

      {/* Sorted by priority descending, so the visual order matches the
          runtime evaluation order. Index stored on each row so edits
          target the ORIGINAL array index (not the sorted display index). */}
      {[...states.entries()]
        .sort(([, a], [, b]) => b.priority - a.priority)
        .map(([rowIdx, row]) => {
          // Legacy `condMeta` lookup removed — the new ConditionEditor
          // owns all per-kind field rendering. Kept as a placeholder
          // comment so future readers know where it used to live.
          // useEnter / useExit — read explicitly. If the row only has the
          // legacy `useTransitions` field (saved before the split), fall
          // back to that value so existing configs keep working.
          const useEnter = row.useEnter !== undefined ? row.useEnter === true : row.useTransitions === true;
          const useExit  = row.useExit  !== undefined ? row.useExit  === true : row.useTransitions === true;
          return (
            <div key={rowIdx} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Each iteration renders the row + (optionally) the
                advanced settings panel directly below it, wrapped in
                a flex column so they sit together. */}
            <div
              key={rowIdx}
              style={{
                display: "grid",
                gridTemplateColumns: "36px 110px 56px 36px 36px 1fr 1fr 1fr 1.4fr 36px 28px",
                gap: 6,
                alignItems: "center",
                padding: "4px 4px",
                background: "var(--inner)",
                borderRadius: 6,
                // Visually dim disabled rows so authors see at a glance
                // which states are inactive without reading each checkbox.
                opacity: row.enabled === 0 ? 0.45 : 1,
              }}
            >
              <Toggle
                value={row.enabled !== 0}
                onChange={(v) => patchRow(rowIdx, { enabled: v ? 1 : 0 })}
                title="Enabled. When off, this state is skipped by the priority loop and never plays. Toggle at runtime via the SetStateEnabled action."
              />
              <input
                value={row.name}
                onChange={(e) => patchRow(rowIdx, { name: e.target.value })}
                style={{ width: "100%", minWidth: 0 }}
              />
              <NumericInput
                value={Number(row.priority)}
                onChange={(v) => patchRow(rowIdx, { priority: v })}
                style={{ width: "100%", minWidth: 0 }}
                title="Higher priority wins when multiple states' conditions are true at the same tick."
              />
              <Toggle
                value={useEnter}
                onChange={(v) => patchRow(rowIdx, { useEnter: v })}
                title="Play Enter animation on state entry. When off, main plays directly."
              />
              <Toggle
                value={useExit}
                onChange={(v) => patchRow(rowIdx, { useExit: v })}
                title="Play Exit animation on state exit (delays the switch to the next state). When off, the state ends immediately when its condition fails."
              />
              <AnimDropdown
                value={row.enterAnim ?? ""}
                onChange={(v) => patchRow(rowIdx, { enterAnim: v })}
                options={animOptions}
                manual={machineManual}
                placeholder="(none)"
                title="Optional one-shot animation played BEFORE the main animation when this state activates. e.g. jump_start, crouch_in. Only used when In is on."
                disabled={!useEnter}
              />
              <AnimDropdown
                value={row.animation}
                onChange={(v) => patchRow(rowIdx, { animation: v })}
                options={animOptions}
                manual={machineManual}
                placeholder="(pick sprite)"
                title="Main animation that plays while the state is active. Loops or one-shots based on the Loop column."
              />
              <AnimDropdown
                value={row.exitAnim ?? ""}
                onChange={(v) => patchRow(rowIdx, { exitAnim: v })}
                options={animOptions}
                manual={machineManual}
                placeholder="(none)"
                title="Optional one-shot animation played when this state stops being the winner. e.g. crouch_out. Only used when Out is on."
                disabled={!useExit}
              />

              {/* Condition column — unified Logic Sheet Condition editor.
                  Single dropdown lists ALL 75+ ConditionKinds (kinds shared
                  with the Logic Sheet now). Below the dropdown we render
                  the fields the picked kind actually uses, inferred from
                  the kind's default-config shape. */}
              <ConditionEditor
                condition={row.primary}
                onChange={(c) => patchRow(rowIdx, { primary: c })}
                opts={condOpts}
              />

              <button
                onClick={() => toggleAdvanced(rowIdx)}
                title="Advanced settings — frame motions, frame signals, freeze movement, ignore input, hold on finish, hysteresis, re-entry guard, extra conditions, combo animations"
                style={{
                  height: 22, padding: "0 6px", lineHeight: "20px",
                  background: expandedRows.has(rowIdx) ? "var(--accent)" : "transparent",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4,
                  color: expandedRows.has(rowIdx) ? "var(--frame)" : "var(--text-dim)",
                  cursor: "pointer", fontSize: 10, whiteSpace: "nowrap",
                }}
              >⚙{expandedRows.has(rowIdx) ? " ▾" : " ▸"}</button>
              <button
                onClick={() => {
                  removeRow(rowIdx);
                }}
                title="Delete state"
                style={{
                  width: 22, height: 22, padding: 0, lineHeight: "20px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                }}
              >×</button>
            </div>
            {expandedRows.has(rowIdx) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 16, marginTop: 4 }}>
                <div>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--orange)", marginBottom: 4 }}>
                    🔔 Frame Signals <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }} title="Emit a signal on a frame of THIS state's animation (e.g. the hurt anim's impact frame → Camera Shake). The Anim picker lists only this state's own in/main/out anims. Separate from Combo below.">— emit a signal on a frame of this state's anim</span>
                  </div>
                  <ComboSequenceEditor
                    mode="signals"
                    comboAnims={row.comboAnimations ?? []}
                    comboWeights={row.comboWeights ?? []}
                    comboRandom={!!row.comboRandom}
                    comboRandomNoRepeat={!!row.comboRandomNoRepeat}
                    frameSignals={row.frameSignals ?? []}
                    animOptions={animOptions}
                    stateAnims={Array.from(new Set([row.animation, row.enterAnim, row.exitAnim].filter((a): a is string => !!a && a.trim() !== "")))}
                    tagOptions={tagOptions}
                    bpId={bp.id}
                    onChangeAnims={(next) => patchRow(rowIdx, { comboAnimations: next })}
                    onChangeWeights={(next) => patchRow(rowIdx, { comboWeights: next })}
                    onToggleRandom={(v) => patchRow(rowIdx, { comboRandom: v })}
                    onToggleNoRepeat={(v) => patchRow(rowIdx, { comboRandomNoRepeat: v })}
                    onChangeSignals={(next) => patchRow(rowIdx, { frameSignals: next })}
                    onChangeBoth={(anims, signals) => patchRow(rowIdx, { comboAnimations: anims, frameSignals: signals })}
                  />
                </div>
                <div>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>
                    Conditions <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }} title="Extra conditions combine with the MAIN condition (in the row above) via the top AND/OR. Sub-conditions are one nested level with their own AND/OR; the whole sub-group folds in as one term. e.g. main=moving (AND) + sub-group (right OR left) → moving AND (right OR left).">— combined with the main condition above</span>
                  </div>
                  {/* Top AND/OR only matters when there's more than one thing at the
                      top level — i.e. the main condition PLUS at least one extra. With
                      only sub-conditions it's noise, so hide it (main ANDs the sub-group). */}
                  {/* ── Level 1: extra conditions — indented one step under the main,
                       with a connector line so the hierarchy (main → extras → subs)
                       reads as a staircase. ── */}
                  <div style={{ marginLeft: 6, paddingLeft: 14, borderLeft: "2px solid var(--border)" }}>
                    <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", margin: "0 0 4px -8px" }}>↳ with the main condition</div>
                    {(row.extras?.length ?? 0) > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>AND / OR</span>
                        <AndOrToggle value={row.matchAny} onChange={(v) => patchRow(rowIdx, { matchAny: v })} />
                        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{row.matchAny ? "any of these matches" : "all must match"}</span>
                      </div>
                    )}
                    <ExtraConditionsList
                      rows={row.extras ?? []}
                      addLabel="+ Add condition"
                      opts={condOpts}
                      onChange={(next) => patchRow(rowIdx, { extras: next })}
                    />
                    {/* ── Level 2: sub-group — stepped one MORE level in, with an accent
                         connector + tint so it's clearly nested. Combines via its own
                         AND/OR, then folds into the level above as a single term. ── */}
                    {(row.primary.kind !== "Always" || (row.extras?.length ?? 0) > 0 || (row.subs?.length ?? 0) > 0) && (
                      <div style={{ marginLeft: 14, marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--accent, #5a8ce6)", background: "rgba(90,140,230,0.06)", borderRadius: "0 6px 6px 0", paddingTop: 6, paddingBottom: 6 }}>
                        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--accent, #6ea8f5)", fontWeight: 700, margin: "0 0 4px -8px" }}>↳ sub-group <span style={{ textTransform: "none", fontWeight: 400, color: "var(--text-dim)" }}>— folds in as one term</span></div>
                        {(row.subs?.length ?? 0) > 0 && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" }}>AND / OR</span>
                            <AndOrToggle value={row.subMatchAny} onChange={(v) => patchRow(rowIdx, { subMatchAny: v })} />
                            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{row.subMatchAny ? "any sub-condition" : "all sub-conditions"}</span>
                          </div>
                        )}
                        <ExtraConditionsList
                          rows={row.subs ?? []}
                          addLabel="+ Add sub-condition"
                          opts={condOpts}
                          onChange={(next) => patchRow(rowIdx, { subs: next })}
                        />
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>
                    Combo <span style={{ textTransform: "none", letterSpacing: 0 }} title="Chain DIFFERENT anims on each re-entry within the combo window (atk1 → atk2 → atk3). A combo overrides this state's main Animation field; the in/out transition anims still play around each step. Leave empty for a normal single-anim state.">— chain different anims on re-entry (optional)</span>
                  </div>
                  <ComboSequenceEditor
                    mode="combo"
                    comboAnims={row.comboAnimations ?? []}
                    comboWeights={row.comboWeights ?? []}
                    comboRandom={!!row.comboRandom}
                    comboRandomNoRepeat={!!row.comboRandomNoRepeat}
                    frameSignals={row.frameSignals ?? []}
                    animOptions={animOptions}
                    manualAnims={machineManual}
                    stateAnims={Array.from(new Set([row.animation, row.enterAnim, row.exitAnim].filter((a): a is string => !!a && a.trim() !== "")))}
                    tagOptions={tagOptions}
                    bpId={bp.id}
                    onChangeAnims={(next) => patchRow(rowIdx, { comboAnimations: next })}
                    onChangeWeights={(next) => patchRow(rowIdx, { comboWeights: next })}
                    onToggleRandom={(v) => patchRow(rowIdx, { comboRandom: v })}
                    onToggleNoRepeat={(v) => patchRow(rowIdx, { comboRandomNoRepeat: v })}
                    onChangeSignals={(next) => patchRow(rowIdx, { frameSignals: next })}
                    onChangeBoth={(anims, signals) => patchRow(rowIdx, { comboAnimations: anims, frameSignals: signals })}
                  />
                </div>
                <AdvancedSettingsPanel
                  row={row}
                  animOptions={
                    Array.isArray(row.comboAnimations) && row.comboAnimations.length > 0
                      ? row.comboAnimations
                      : animOptions
                  }
                  onPatch={(patch) => patchRow(rowIdx, patch)}
                />
              </div>
            )}
            </div>
          );
        })}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button
          onClick={addRow}
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "var(--inner)",
            color: "var(--text-muted)",
            border: "1px dashed rgba(255,255,255,0.15)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >+ Add State</button>
        <button
          onClick={() => {
            // Add any starter state whose `name` isn't already present. Keeps
            // user-customized rows untouched; just fills in the gaps. Pick
            // the starter set by BP class — NPC gets AI-state-driven rows,
            // Character gets the sidescroller input-driven rows.
            const starter = bp.classKind === "NPC" ? NPC_STARTER_STATES : SIDESCROLLER_STARTER_STATES;
            const have = new Set(states.map((s) => s.name));
            const additions = starter.filter((s) => !have.has(s.name));
            if (additions.length === 0) return;
            commit([...states, ...additions]);
          }}
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "var(--inner)",
            color: "var(--text-muted)",
            border: "1px dashed rgba(255,255,255,0.15)",
            borderRadius: 6,
            cursor: "pointer",
          }}
          title={bp.classKind === "NPC"
            ? "Add the NPC starter states (death / hurt / attack / flee / chase / search / alert / idle) — skips any name you already have."
            : "Add the sidescroller starter states (attack / dash / wallslide / fall / jump / crouch / run / walk / idle) — skips any name you already have."}
        >+ Add Missing Defaults</button>
        <button
          onClick={() => {
            const starter = bp.classKind === "NPC" ? NPC_STARTER_STATES : SIDESCROLLER_STARTER_STATES;
            const label = bp.classKind === "NPC" ? "NPC" : "sidescroller";
            const ok = window.confirm(`Replace ALL states with the ${label} starter set (${starter.length} states)? Any custom states you've added will be lost.`);
            if (!ok) return;
            commit([...starter]);
          }}
          style={{
            fontSize: 10,
            padding: "4px 10px",
            background: "var(--inner)",
            color: "var(--text-muted)",
            border: "1px dashed rgba(255,80,80,0.3)",
            borderRadius: 6,
            cursor: "pointer",
          }}
          title="Wipe the table and replace it with the sidescroller defaults. Confirms first."
        >↺ Reset to Defaults</button>
      </div>

      {!sprite && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
          Tip: pick a Sprite asset in the Visual section above — animation dropdowns will populate from its animations list.
        </div>
      )}
      {inputGatesOpen && (
        <InputGatesModal
          gates={inputGates}
          inputActionOptions={inputActionOptions}
          opts={condOpts}
          onChange={(next) => updateBehavior(bp.id, idx, { ...cfg, inputGates: next })}
          onClose={() => setInputGatesOpen(false)}
        />
      )}
    </div>
  );
}

/** Input Gates modal — animator-wide config of per-input AND-lists.
 *  Each gate names an input action and lists conditions. While any
 *  condition in the gate fails, that input is treated as not-pressed
 *  by CM (and any other behavior that consults `blockedActions`).
 *  Used to block specific inputs under specific game states without
 *  cluttering CM with per-input "allowed" flags. */
function InputGatesModal({
  gates, inputActionOptions, opts, onChange, onClose,
}: {
  gates: InputGate[];
  inputActionOptions: string[];
  opts: CondOpts;
  onChange: (next: InputGate[]) => void;
  onClose: () => void;
}) {
  const patch = (i: number, p: Partial<InputGate>) => {
    const next = gates.slice();
    next[i] = { ...next[i], ...p };
    onChange(next);
  };
  const remove = (i: number) => {
    const next = gates.slice();
    next.splice(i, 1);
    onChange(next);
  };
  const add = () => {
    onChange([...gates, { action: inputActionOptions[0] ?? "", conditions: [] }]);
  };
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8, padding: 16, minWidth: 520, maxWidth: 760,
          maxHeight: "80vh", overflowY: "auto", color: "var(--text)",
          display: "flex", flexDirection: "column", gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Input Gates</div>
          <button
            onClick={onClose}
            style={{
              width: 24, height: 24, padding: 0, lineHeight: "22px",
              background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
            }}
          >×</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Each gate names an input action and lists conditions ANDed together. The action is
          treated as NOT-pressed by CharacterMovement (and other input-consuming behaviors)
          while any condition fails. Use the <b>!</b> button on a condition row to negate it.
        </div>
        {gates.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            No gates yet. Click <b>+ Add Gate</b> below to add one.
          </div>
        )}
        {gates.map((g, i) => (
          <div key={i} style={{
            border: "1px solid rgba(255,255,255,0.10)", borderRadius: 6,
            padding: 8, background: "var(--inner)",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "var(--text-dim)", minWidth: 50 }}>INPUT</span>
              <select
                value={g.action}
                onChange={(e) => patch(i, { action: e.target.value })}
                style={{ fontSize: 11, minWidth: 160 }}
              >
                <option value="">(pick input action)</option>
                {inputActionOptions.map((a) => (
                  <option key={a || "__empty__"} value={a}>{a || "— unbound —"}</option>
                ))}
              </select>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => remove(i)}
                title="Delete this gate"
                style={{
                  width: 22, height: 22, padding: 0, lineHeight: "20px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                }}
              >×</button>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", paddingLeft: 12 }}>
              Allow only when ALL conditions match. Failing any one = input is blocked.
            </div>
            <ExtraConditionsList
              rows={g.conditions}
              opts={opts}
              onChange={(rows) => patch(i, { conditions: rows })}
            />
          </div>
        ))}
        <button
          onClick={add}
          style={{
            alignSelf: "flex-start", fontSize: 10, padding: "4px 10px",
            background: "var(--inner)", color: "var(--text-muted)",
            border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 6, cursor: "pointer",
          }}
        >+ Add Gate</button>
      </div>
    </div>
  );
}

/** Ordered list of animation slots for an in-state combo chain. The
 *  state cycles through these on each re-entry — first press plays
 *  index 0, next press (within window) plays index 1, etc. Reset to 0
 *  on window expiry or list exhaustion. Each row can also expand to
 *  edit per-anim frame motions (overrides the state-level shared
 *  motions while THIS combo anim is playing). */
/**
 * Combo Sequence editor — replaces the old separate "Combo Animations"
 * list and "Frame Signals" grid for combo states. Each row = one combo
 * step. Per-row cells: index, anim name, then 0..N (frames, signal)
 * sub-rows for signals to emit during that combo's animation.
 *
 * Data: comboAnimations[i] holds the anim name for step i; frameSignals
 * is filtered per step by matching `anim` field. Signals whose anim
 * doesn't match any combo step (orphans / legacy "any-anim" rows) are
 * rendered in a separate "Other" footer so they're visible but flagged.
 *
 * Frames are 0-based everywhere — UI, storage, and runtime — matching the
 * Sprite editor's 0-based frame strip and the runtime's currentFrameIdx.
 */
function ComboSequenceEditor({
  mode,
  comboAnims, comboWeights, comboRandom, comboRandomNoRepeat,
  frameSignals, animOptions, stateAnims, tagOptions, bpId, manualAnims,
  onChangeAnims, onChangeWeights, onToggleRandom, onToggleNoRepeat,
  onChangeSignals, onChangeBoth,
}: {
  /** "signals" renders ONLY the frame-signal list (+ Add Signal) — emit a
   *  signal on a frame of this state's anim. "combo" renders ONLY the
   *  anim-chain steps (+ Add Combo Step). The parent shows them as two
   *  separate sections so signals (the common case) aren't buried in combo. */
  mode: "signals" | "combo";
  comboAnims: string[];
  comboWeights: number[];
  comboRandom: boolean;
  comboRandomNoRepeat: boolean;
  frameSignals: FrameSignalRow[];
  animOptions: string[];
  /** This state's OWN anims (in / main / out). Frame signals fire on the
   *  state's animation, so their anim picker is scoped to these — NOT every
   *  project anim (which is what makes combo different). */
  stateAnims: string[];
  /** Tags declared on any BP/instance — drives the "Emit to" dropdown
   *  so authors pick from real tags instead of typing. */
  tagOptions: string[];
  /** The host BP's id — forwarded to SignalPickers so cross-BP-
   *  invisible signals get filtered out of the picker list. */
  bpId: string;
  /** Type combo anim names by hand (machine targets a swapped sprite whose
   *  anims aren't in the current dropdown). */
  manualAnims?: boolean;
  onChangeAnims: (next: string[]) => void;
  onChangeWeights: (next: number[]) => void;
  onToggleRandom: (next: boolean) => void;
  onToggleNoRepeat: (next: boolean) => void;
  onChangeSignals: (next: FrameSignalRow[]) => void;
  /** Combined-write callback for compound ops (add / rename / remove) that
   *  need to update both arrays atomically. Without this, two sequential
   *  `onChangeAnims` + `onChangeSignals` calls would each read the same
   *  stale state snapshot — the second write overwrites the first's
   *  changes when committed. Routing them through one patch keeps both
   *  fields aligned. */
  onChangeBoth: (anims: string[], signals: FrameSignalRow[]) => void;
}) {
  // Drag-reorder state — index being dragged. Native HTML5 drag/drop
  // so no extra dependency. Drop target highlighted via `dropTargetIdx`.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const nextAnims = comboAnims.slice();
    const [movedAnim] = nextAnims.splice(from, 1);
    nextAnims.splice(to, 0, movedAnim);
    const nextWeights = comboWeights.slice();
    if (nextWeights.length > 0) {
      while (nextWeights.length < comboAnims.length) nextWeights.push(100);
      const [movedW] = nextWeights.splice(from, 1);
      nextWeights.splice(to, 0, movedW);
      onChangeWeights(nextWeights);
    }
    onChangeAnims(nextAnims);
  };
  const setWeight = (i: number, val: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    const next = comboWeights.slice();
    while (next.length < comboAnims.length) next.push(100);
    next[i] = clamped;
    onChangeWeights(next);
  };
  // ─── Combo-anim mutators ──────────────────────────────────────────
  // Compound ops (rename / remove / add) write BOTH combo + signals in
  // ONE call via onChangeBoth to avoid React state-batching bugs:
  // separate onChangeAnims + onChangeSignals each read the same stale
  // state snapshot at handler entry, so the second commit would
  // overwrite the first's changes.
  const patchAnim = (i: number, v: string) => {
    const oldName = comboAnims[i];
    const next = comboAnims.slice();
    next[i] = v;
    // Re-link paired signals targeting the OLD name to the NEW name so
    // renaming a combo step doesn't orphan its signal row.
    const nextSignals = oldName !== v
      ? frameSignals.map((fs) => fs.anim === oldName ? { ...fs, anim: v } : fs)
      : frameSignals;
    onChangeBoth(next, nextSignals);
  };
  const removeAnim = (i: number) => {
    const next = comboAnims.slice();
    const removedAnim = next[i];
    next.splice(i, 1);
    // Cascade — drop frameSignals targeting the deleted anim so they don't
    // drift into "orphan" land. Author can re-add if the anim was shared.
    // An unnamed step (removedAnim === "") never has paired signals — the
    // "+ Add signal" button is disabled until an anim is picked — so leave
    // signals untouched in that case.
    const nextSignals = removedAnim
      ? frameSignals.filter((fs) => fs.anim !== removedAnim)
      : frameSignals;
    // Prune the parallel weight when present, so weights[i] stays paired
    // with anims[i] after the removal.
    if (comboWeights.length > 0) {
      const nextW = comboWeights.slice();
      nextW.splice(i, 1);
      onChangeWeights(nextW);
    }
    onChangeBoth(next, nextSignals);
  };
  const moveAnim = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= comboAnims.length) return;
    const next = comboAnims.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChangeAnims(next);
  };
  const addAnim = () => {
    // A combo step is JUST an anim — signals are optional, added per step
    // via "+ Add signal" (disabled until the anim is picked). Do NOT
    // auto-pair a blank {anim:""} signal: signals link to steps by anim
    // NAME, so every freshly-added step sharing the empty name collided —
    // each empty step matched ALL empty-anim signals, so naming one step
    // relinked every blank signal and deleting one signal hit the others.
    onChangeAnims([...comboAnims, ""]);
  };

  // ─── Frame-signal helpers (0-based everywhere) ──────────
  const framesToText = (arr: number[]) => arr.map((n) => String(n)).join(", ");
  const textToFrames = (s: string): number[] => s
    .split(/[,\s]+/)
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((tok) => Math.floor(Number(tok)))
    .filter((n) => Number.isFinite(n) && n >= 0);

  // Find indices in frameSignals that target a specific anim.
  const indicesForAnim = (anim: string): number[] => {
    const out: number[] = [];
    for (let i = 0; i < frameSignals.length; i++) {
      if (frameSignals[i].anim === anim) out.push(i);
    }
    return out;
  };

  const patchSignal = (idx: number, p: Partial<FrameSignalRow>) => {
    onChangeSignals(frameSignals.map((r, i) => (i === idx ? { ...r, ...p } : r)));
  };
  const removeSignal = (idx: number) => {
    onChangeSignals(frameSignals.filter((_, i) => i !== idx));
  };
  const addSignalForAnim = (anim: string) => {
    onChangeSignals([...frameSignals, { anim, frames: [], signal: "" }]);
  };

  // Orphans — entries whose anim isn't in the current combo list. Only
  // meaningful when there IS a combo list to compare against. When
  // comboAnims is empty, signals are rendered as the primary table at
  // the top (non-combo state with frame signals), so re-rendering them
  // here as "orphans" would duplicate the UI.
  const orphans = comboAnims.length === 0
    ? []
    : frameSignals
        .map((fs, idx) => ({ fs, idx }))
        .filter(({ fs }) => !comboAnims.includes(fs.anim));

  // Cell label headers — shown once at the top so each row stays compact.
  const HeaderRow = (
    <div style={{
      display: "grid",
      gridTemplateColumns: "28px 110px 1fr 140px 110px 22px",
      gap: 6,
      fontSize: 9, color: "var(--text-dim)",
      textTransform: "uppercase", letterSpacing: 0.5,
      paddingLeft: 4,
    }}>
      <span>#</span>
      <span>Anim</span>
      <span>Frames (0-based, csv)</span>
      <span>Signal</span>
      <span title="Optional tag to broadcast this signal to (EmitSignalTo semantics). Empty = self-emit only. Self-emit still fires either way.">Emit to</span>
      <span></span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Random mode toggles — only meaningful when there's >1 step. */}
      {mode === "combo" && comboAnims.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <label
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }}
            title="When on, each entry picks a random step (weighted by its priority %) instead of advancing the chain. Use for varied idle reactions, random taunts, etc."
          >
            <Toggle
              value={comboRandom}
              onChange={(v) => onToggleRandom(v)}
            />
            <span>Random order (weighted by priority %)</span>
          </label>
          {comboRandom && (
            <label
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }}
              title="When on, the previously-picked anim is excluded from the next random selection so the same anim never plays twice in a row. Falls back to the full set when only one step would remain eligible."
            >
              <Toggle
                value={comboRandomNoRepeat}
                onChange={(v) => onToggleNoRepeat(v)}
              />
              <span>No same anim twice in a row</span>
            </label>
          )}
        </div>
      )}
      {mode === "signals" ? (
        <>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Emit a signal on a frame of this state's animation — e.g. fire on the
            hurt anim's impact frame, then wire <b>OnSignal → Camera Shake</b>
            {" "}(or set <b>Emit to</b> a tag). The Anim picker only lists this
            state's own in / main / out anims. Add as many as you want.
          </div>
          {frameSignals.some((fs) => !comboAnims.includes(fs.anim)) && (
            <>
              <div style={{
                display: "grid",
                gridTemplateColumns: "110px 1fr 140px 110px 22px",
                gap: 6,
                fontSize: 9, color: "var(--text-dim)",
                textTransform: "uppercase", letterSpacing: 0.5,
                paddingLeft: 4,
              }}>
                <span>Anim (blank = main)</span>
                <span>Frames (0-based, csv)</span>
                <span>Signal</span>
                <span title="Optional tag to broadcast this signal to (EmitSignalTo semantics). Empty = self-emit only. Self-emit still fires either way.">Emit to</span>
                <span></span>
              </div>
              {frameSignals.map((fs, idx) => ({ fs, idx })).filter(({ fs }) => !comboAnims.includes(fs.anim)).map(({ fs, idx }) => (
                <div key={idx} style={{
                  display: "grid",
                  gridTemplateColumns: "110px 1fr 140px 110px 22px",
                  gap: 6,
                  alignItems: "center",
                  padding: "2px 4px",
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: 4,
                }}>
                  <select
                    value={fs.anim}
                    onChange={(e) => patchSignal(idx, { anim: e.target.value })}
                    style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                    title="Which of THIS state's animations the signal fires on. (main) = the state's main anim (default). Only this state's in / main / out anims are listed — frame signals belong to this state, unlike a combo which can chain any anim."
                  >
                    <option value="">(main anim)</option>
                    {stateAnims.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <input
                    type="text"
                    defaultValue={framesToText(fs.frames)}
                    onBlur={(e) => patchSignal(idx, { frames: textToFrames(e.target.value) })}
                    placeholder="3, 5, 6"
                    style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                    title="Frame numbers (0-based, comma-sep). Signal fires on each frame-enter edge, deduped so staying on a frame doesn't re-fire."
                  />
                  <SignalPicker
                    value={fs.signal}
                    onChange={(v) => patchSignal(idx, { signal: v })}
                    placeholder="signal name"
                    style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                    mode="emit"
                    forBpId={bpId}
                  />
                  <select
                    value={fs.targetTag ?? ""}
                    onChange={(e) => patchSignal(idx, { targetTag: e.target.value || undefined })}
                    style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                    title="Emit To — pick a tag to broadcast this signal to every sprite with that tag (EmitSignalTo semantics). Empty = self-emit only (legacy). Self-emit still fires either way so host-side Tracers wired to the signal keep working."
                  >
                    <option value="">(self only)</option>
                    {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    onClick={() => removeSignal(idx)}
                    title="Remove this frame signal"
                    style={{
                      width: 22, height: 20, padding: 0, lineHeight: "18px",
                      background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                    }}
                  >×</button>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          {HeaderRow}
          {comboAnims.map((anim, i) => {
            const sigIdxs = indicesForAnim(anim);
            // Row layout: first sub-row carries the # + anim + move/del
            // buttons; subsequent sub-rows (multi-signal) are indented
            // under the same anim with blank index/anim cells.
            const subRows = sigIdxs.length === 0
              ? [-1]  // sentinel — render an empty signal row so the cells stay aligned
              : sigIdxs;
            return (
              <div
                key={i}
                draggable
                onDragStart={(e) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropTargetIdx !== i) setDropTargetIdx(i); }}
                onDragLeave={() => { if (dropTargetIdx === i) setDropTargetIdx(null); }}
                onDrop={(e) => { e.preventDefault(); if (dragIdx !== null && dragIdx !== i) reorder(dragIdx, i); setDragIdx(null); setDropTargetIdx(null); }}
                onDragEnd={() => { setDragIdx(null); setDropTargetIdx(null); }}
                style={{
                  display: "flex", flexDirection: "column", gap: 2,
                  padding: "4px 4px",
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: 4,
                  outline: dropTargetIdx === i && dragIdx !== i ? "2px dashed var(--yellow)" : "none",
                  opacity: dragIdx === i ? 0.5 : 1,
                  cursor: "grab",
                }}>
                {subRows.map((sigIdx, sIdx) => {
                  const isFirst = sIdx === 0;
                  const sig = sigIdx >= 0 ? frameSignals[sigIdx] : undefined;
                  return (
                    <div key={`${i}:${sIdx}`} style={{
                      display: "grid",
                      gridTemplateColumns: "28px 110px 1fr 140px 110px 22px",
                      gap: 6,
                      alignItems: "center",
                    }}>
                      {/* Index cell — only on first sub-row */}
                      <span style={{
                        color: "var(--text-dim)",
                        fontSize: 11, textAlign: "center",
                      }}>{isFirst ? `#${i + 1}` : ""}</span>

                      {/* Anim cell — only editable on first sub-row */}
                      {isFirst ? (
                        <AnimDropdown
                          value={anim}
                          onChange={(v) => patchAnim(i, v)}
                          options={animOptions}
                          manual={manualAnims}
                          placeholder="(pick anim)"
                        />
                      ) : (
                        <span style={{
                          fontSize: 10, color: "var(--text-dim)",
                          fontStyle: "italic", paddingLeft: 6,
                        }}>↳ same anim</span>
                      )}

                      {/* Frames cell — only meaningful when we have a sig */}
                      {sig ? (
                        <input
                          type="text"
                          defaultValue={framesToText(sig.frames)}
                          onBlur={(e) => patchSignal(sigIdx, { frames: textToFrames(e.target.value) })}
                          placeholder="3, 5, 6"
                          style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                          title="Frame numbers (0-based, comma-sep). Signal fires on each frame-enter edge, deduped so staying on a frame doesn't re-fire."
                        />
                      ) : (
                        <span style={{
                          fontSize: 10, color: "rgba(255,255,255,0.25)",
                          fontStyle: "italic",
                          padding: "2px 4px",
                        }}>(no signal — click + Add signal to emit on a frame)</span>
                      )}

                      {/* Signal cell */}
                      {sig ? (
                        <SignalPicker
                          value={sig.signal}
                          onChange={(v) => patchSignal(sigIdx, { signal: v })}
                          placeholder="signal name"
                          style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                          mode="emit"
                          forBpId={bpId}
                        />
                      ) : (
                        <span></span>
                      )}

                      {/* Emit-to cell — optional cross-BP fan-out via tag */}
                      {sig ? (
                        <select
                          value={sig.targetTag ?? ""}
                          onChange={(e) => patchSignal(sigIdx, { targetTag: e.target.value || undefined })}
                          style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                          title="Emit To — pick a tag to broadcast this signal to every sprite with that tag (EmitSignalTo semantics). Empty = self-emit only. Self-emit still fires either way so host-side Tracers wired to the signal keep working."
                        >
                          <option value="">(self only)</option>
                          {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <span></span>
                      )}

                      {/* Remove cell — first sub-row removes the WHOLE
                          combo step (cascading its signals); later sub-
                          rows remove just that signal entry. */}
                      {isFirst ? (
                        <button
                          onClick={() => removeAnim(i)}
                          title="Remove this combo step (and its frame signals)"
                          style={{
                            width: 22, height: 20, padding: 0, lineHeight: "18px",
                            background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                          }}
                        >×</button>
                      ) : (
                        <button
                          onClick={() => removeSignal(sigIdx)}
                          title="Remove this frame signal"
                          style={{
                            width: 22, height: 20, padding: 0, lineHeight: "18px",
                            background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                            borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                          }}
                        >×</button>
                      )}
                    </div>
                  );
                })}
                {/* Per-step controls — reorder + priority (in random mode) + add signal */}
                <div style={{
                  display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4,
                  paddingTop: 2,
                }}>
                  <span style={{ fontSize: 9, color: "var(--text-dim)", marginRight: 4 }} title="Drag the step container to reorder.">⠿ drag</span>
                  {comboRandom && (
                    <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--text-dim)" }}
                      title="Priority weight (0..100). Higher = more likely. 0 = never plays. Sum of all weights need not equal 100 — weights are normalized at pick time.">
                      <span>PRI%</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={comboWeights[i] ?? 100}
                        onChange={(e) => setWeight(i, Number(e.target.value) || 0)}
                        style={{ width: 48, fontSize: 11, padding: "1px 4px" }}
                      />
                    </label>
                  )}
                  <button onClick={() => moveAnim(i, -1)} disabled={i === 0} title="Move step up"
                    style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "transparent",
                      border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3,
                      color: i === 0 ? "rgba(255,255,255,0.15)" : "var(--text-dim)", cursor: i === 0 ? "default" : "pointer", fontSize: 10 }}>▲</button>
                  <button onClick={() => moveAnim(i, 1)} disabled={i === comboAnims.length - 1} title="Move step down"
                    style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "transparent",
                      border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3,
                      color: i === comboAnims.length - 1 ? "rgba(255,255,255,0.15)" : "var(--text-dim)",
                      cursor: i === comboAnims.length - 1 ? "default" : "pointer", fontSize: 10 }}>▼</button>
                  <button
                    onClick={() => addSignalForAnim(anim)}
                    disabled={!anim}
                    title={anim ? "Add another frame signal for this combo step" : "Pick an anim first"}
                    style={{
                      padding: "1px 6px", fontSize: 10,
                      background: "transparent",
                      border: "1px dashed rgba(255,255,255,0.2)",
                      borderRadius: 3,
                      color: anim ? "var(--text-dim)" : "rgba(255,255,255,0.15)",
                      cursor: anim ? "pointer" : "default",
                    }}
                  >+ signal</button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {mode === "signals" ? (
        <button
          onClick={() => addSignalForAnim("")}
          title="Emit a signal on a frame of this state's animation — NO combo needed. Add several for multiple signals. Set 'Emit to' a tag (e.g. your Camera) to fan the signal out, so a hit-frame can trigger CameraShake, etc. Leave Anim blank to fire on the state's main animation."
          style={{ ...ADD_BTN, alignSelf: "flex-start" }}
        >+ Add Signal</button>
      ) : (
        <button
          onClick={addAnim}
          title="Add a combo step — chains a DIFFERENT anim on each re-entry within the combo window (atk1 → atk2 → …). A combo overrides the state's main Animation field; in/out transition anims still play around each step. Only for multi-anim chains."
          style={{ ...ADD_BTN, alignSelf: "flex-start" }}
        >+ Add Combo Step</button>
      )}

      {/* Orphan footer — frame signals targeting an anim that ISN'T in
          the combo list (legacy "any-anim" rows, deleted-step leftovers).
          Surfaced so they don't silently keep firing. Author can edit or
          drop them here. */}
      {mode === "combo" && orphans.length > 0 && (
        <div style={{
          marginTop: 4, padding: "6px 4px 4px",
          borderTop: "1px dashed rgba(255,205,60,0.3)",
        }}>
          <div style={{
            fontSize: 9, color: "rgba(255,205,60,0.7)",
            textTransform: "uppercase", letterSpacing: 0.5,
            marginBottom: 4,
          }} title="These frame signals target an anim that's not in the combo list. Either a 'any-anim' legacy row or a deleted step's leftover. They still fire at runtime when SR plays the named anim.">
            ⚠ Other frame signals (no matching combo step)
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "110px 1fr 140px 110px 22px",
            gap: 6,
            fontSize: 9, color: "var(--text-dim)",
            textTransform: "uppercase", letterSpacing: 0.5,
            paddingLeft: 4,
          }}>
            <span>Anim</span>
            <span>Frames</span>
            <span>Signal</span>
            <span title="Optional tag to broadcast this signal to (EmitSignalTo semantics). Empty = self-emit only.">Emit to</span>
            <span></span>
          </div>
          {orphans.map(({ fs, idx }) => (
            <div key={idx} style={{
              display: "grid",
              gridTemplateColumns: "110px 1fr 140px 110px 22px",
              gap: 6,
              alignItems: "center",
              padding: "2px 4px",
              background: "rgba(255,205,60,0.05)",
              borderRadius: 4,
            }}>
              <select
                value={fs.anim}
                onChange={(e) => patchSignal(idx, { anim: e.target.value })}
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                title="Anim filter. Empty = fire on any animation when frame matches."
              >
                <option value="">(any anim)</option>
                {animOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <input
                type="text"
                defaultValue={framesToText(fs.frames)}
                onBlur={(e) => patchSignal(idx, { frames: textToFrames(e.target.value) })}
                placeholder="3, 5, 6"
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
              />
              <SignalPicker
                value={fs.signal}
                onChange={(v) => patchSignal(idx, { signal: v })}
                placeholder="signal name"
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                mode="emit"
                forBpId={bpId}
              />
              <select
                value={fs.targetTag ?? ""}
                onChange={(e) => patchSignal(idx, { targetTag: e.target.value || undefined })}
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                title="Emit To — pick a tag to broadcast this signal to every sprite with that tag (EmitSignalTo semantics). Empty = self-emit only. Self-emit still fires either way."
              >
                <option value="">(self only)</option>
                {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button
                onClick={() => removeSignal(idx)}
                title="Remove this row"
                style={{
                  width: 22, height: 20, padding: 0, lineHeight: "18px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mini condition editor rendered under each state row. Each entry in
 *  `rows` is ANDed with the row's primary condition — the state only
 *  activates when ALL of (primary + every extra) match. "+ Add Condition"
 *  appends a new entry defaulting to "always" (effectively a no-op until
 *  the user picks something). */
function ExtraConditionsList({
  rows, onChange, opts,
  addLabel = "+ Add condition",
}: {
  rows: ExtraConditionRow[];
  onChange: (next: ExtraConditionRow[]) => void;
  opts: CondOpts;
  /** Label for the add button — differs between top conditions and the
   *  nested sub-condition list. */
  addLabel?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {rows.map((r, i) => {
        const patch = (next: ExtraConditionRow) => {
          const arr = rows.slice();
          arr[i] = next;
          onChange(arr);
        };
        return (
          <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11 }}>
            <button
              onClick={() => patch({ ...r, not: !r.not })}
              title={r.not ? "Condition is negated (NOT). Click to un-negate." : "Negate this condition (NOT)."}
              style={{
                width: 18, height: 18, padding: 0, lineHeight: "16px",
                background: r.not ? "var(--accent)" : "transparent",
                color: r.not ? "var(--on-accent)" : "var(--text-dim)",
                border: "1px solid var(--border)",
                cursor: "pointer", fontSize: 10, fontWeight: 700,
              }}
            >!</button>
            <ConditionEditor condition={r} onChange={patch} opts={opts} />
            <button
              onClick={() => {
                const next = rows.slice();
                next.splice(i, 1);
                onChange(next);
              }}
              title="Remove this condition"
              style={{
                width: 18, height: 18, padding: 0, lineHeight: "16px",
                background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", fontSize: 10,
              }}
            >×</button>
          </div>
        );
      })}
      <button
        onClick={() => onChange([...rows, { kind: "Always" }])}
        title="Add another condition to this list"
        style={{ ...ADD_BTN, alignSelf: "flex-start" }}
      >{addLabel}</button>
    </div>
  );
}

/** Bundle of context-aware option lists threaded into ConditionEditor so
 *  each field renders the right picker (state names, anim names, tracers,
 *  input actions, tags, signals) instead of a blind text box. */
interface CondOpts {
  stateNames: string[];
  animNames: string[];
  inputActions: string[];
  tracerNames: string[];
  tagOptions: string[];
  /** SmartTween (Animator) animation names on this BP — for IsAnimatorAnimPlaying. */
  animatorAnimNames: string[];
  /** Project sound asset names — for IsMusicPlaying / IsSoundPlaying. */
  soundNames: string[];
  /** Project item names — for HasItem. */
  itemNames: string[];
  /** Project scene names — for IsScene. */
  sceneNames: string[];
  /** Active scene layer names — for IsPaused scope=layer. */
  layerNames: string[];
  /** CharacterMovement / TopdownMovement param names — for CompareCMParam / CompareTMParam. */
  cmParams: string[];
  tmParams: string[];
  varDatalistId: string;
  signalDatalistId: string;
  tagDatalistId: string;
  bpId: string;
}

const COMPARE_PROPERTIES = [
  "velocity.x", "velocity.y", "speed", "position.x", "position.y",
  "angle", "scale.x", "scale.y", "scale", "alpha", "depth", "is_grounded",
];
const COMPARE_OPS = ["==", "!=", "<", "<=", ">", ">="];
const COMPARE_VALUE_OPS = ["==", "!=", "<", "<=", ">", ">=", "contains"];

/** Categorized + searchable + color-chipped condition-kind picker. Opens a
 *  popup grouped by owning component (CharacterMovement, Tracer, SmartTween,
 *  …) with collapse/expand per group, a search box that filters across all
 *  groups, and chips colored via COMPONENT_THEME — mirrors the Logic Sheet's
 *  node picker so the two stay visually consistent. */
function ConditionKindPicker({ value, onPick }: { value: string; onPick: (kind: ConditionKind) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const theme = conditionComponent(value);
  // Group every kind by its owning component label.
  const groups = new Map<string, ConditionKind[]>();
  for (const k of CONDITION_KINDS) {
    const comp = conditionComponent(k).label;
    const arr = groups.get(comp) ?? [];
    arr.push(k);
    groups.set(comp, arr);
  }
  const q = search.trim().toLowerCase();
  const matches = (k: string) => !q || k.toLowerCase().includes(q) || humanizeKind(k).toLowerCase().includes(q);
  const orderedGroups = Array.from(groups.entries())
    .map(([comp, kinds]) => [comp, kinds.filter(matches)] as [string, ConditionKind[]])
    .filter(([, kinds]) => kinds.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Pick condition — grouped by component, searchable"
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, minWidth: 150,
          padding: "2px 8px", fontSize: 11, cursor: "pointer",
          background: theme.chipBg, color: theme.chipFg,
          border: "1px solid var(--border)", borderRadius: 4,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {humanizeKind(value)}
        </span>
        <span style={{ opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 8000 }} />
          <div style={{
            position: "absolute", top: "100%", left: 0, zIndex: 8001, marginTop: 2,
            width: 280, maxHeight: 360, overflowY: "auto",
            background: "var(--panel)", border: "1px solid var(--border)",
            borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.45)", padding: 6,
          }}>
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conditions…"
              style={{ width: "100%", fontSize: 11, padding: "3px 6px", marginBottom: 6, boxSizing: "border-box" }}
            />
            {!q && (
              <button
                type="button"
                onClick={() => { onPick("None" as ConditionKind); setOpen(false); setSearch(""); }}
                title="No condition — the state never activates on its own. Drive it from the Logic Sheet (Set State) or a nav arrival. For manual-only states."
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "3px 8px",
                  fontSize: 11, cursor: "pointer", marginBottom: 6,
                  background: value === "None" ? "var(--accent)" : "rgba(255,255,255,0.05)",
                  color: value === "None" ? "var(--on-accent)" : "var(--text-dim)",
                  border: "1px dashed var(--border)", borderRadius: 3,
                }}
              >None (manual only)</button>
            )}
            {orderedGroups.map(([comp, kinds]) => {
              const t = COMPONENT_THEME[comp] ?? conditionComponent(kinds[0]);
              const isCollapsed = collapsed.has(comp) && !q;
              return (
                <div key={comp} style={{ marginBottom: 4 }}>
                  <button
                    type="button"
                    onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(comp)) n.delete(comp); else n.add(comp); return n; })}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%",
                      padding: "2px 6px", fontSize: 10, fontWeight: 700, cursor: "pointer",
                      background: t.chipBg, color: t.chipFg, border: "none", borderRadius: 3,
                      textTransform: "uppercase", letterSpacing: 0.4,
                    }}
                  >
                    <span style={{ opacity: 0.8 }}>{isCollapsed ? "▸" : "▾"}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>{comp}</span>
                    <span style={{ opacity: 0.7 }}>{kinds.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div style={{ display: "flex", flexDirection: "column", paddingLeft: 4, paddingTop: 2 }}>
                      {kinds.map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => { onPick(k); setOpen(false); setSearch(""); }}
                          style={{
                            textAlign: "left", padding: "2px 8px", fontSize: 11, cursor: "pointer",
                            background: k === value ? "var(--accent)" : "transparent",
                            color: k === value ? "var(--on-accent)" : "var(--text)",
                            border: "none", borderRadius: 3,
                          }}
                        >{humanizeKind(k)}</button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {orderedGroups.length === 0 && (
              <div style={{ padding: 8, fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>No matches</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Unified Logic Sheet `Condition` editor. Uses the categorized/searchable
 *  ConditionKindPicker for the kind, then renders per-field widgets driven
 *  by (kind, fieldKey): state names → state dropdown, anims → anim dropdown,
 *  signals → SignalPicker, tags → tag datalist, tracers → tracer dropdown,
 *  input actions → action dropdown, AI states → AI-state dropdown, etc.
 *  Shared by the state-machine inspector AND any future Condition host. */
function ConditionEditor({
  condition, onChange, opts,
}: {
  condition: SharedCondition;
  onChange: (c: SharedCondition) => void;
  opts: CondOpts;
}) {
  const c = condition as unknown as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => onChange({ ...condition, ...patch } as SharedCondition);
  const kind = condition.kind;
  // Switching kind: seed the picked kind's default fields so the right
  // inputs appear (and stale fields from the prior kind drop away).
  const pickKind = (k: ConditionKind) => {
    let defaults: Record<string, unknown> = { ...(CONDITION_PARAM_DEFAULTS[k] ?? {}) };
    // Key triggers carry an `actions` array (not in CONDITION_PARAM_DEFAULTS)
    // — seed it so the input-action picker renders immediately.
    if (k === "OnKeyPressed" || k === "OnKeyReleased" || k === "OnKeyHeld") defaults = { actions: [] };
    onChange({ kind: k, ...(condition.not ? { not: true } : {}), ...defaults } as SharedCondition);
  };

  const inputActionSelect = (cur: string, on: (v: string) => void) => (
    <select value={cur} onChange={(e) => on(e.target.value)} style={{ minWidth: 90, fontSize: 11 }} title="Input action">
      {opts.inputActions.map((a) => <option key={a || "__e"} value={a}>{a || "— unbound —"}</option>)}
    </select>
  );

  // Render the fields this condition kind actually carries, in a stable
  // order. Presence is derived from the kind's EXPECTED shape (defaults +
  // key-trigger special case) merged with the current value — so a field
  // shows even when a legacy/migrated condition is missing it. `has` reads
  // this expected set, not just the raw stored object.
  // CONDITION_PARAM_DEFAULTS is a PARTIAL map (it omits the Logic Sheet's
  // "curated" kinds like HasTag, OnCollide, OnSignal…). Supplement it with
  // the fields those kinds need so every condition renders its inputs.
  const SUPPLEMENT: Record<string, Record<string, unknown>> = {
    HasTag: { tag: "" }, HasAnyTag: { tags: [] }, HasAllTags: { tags: [] },
    HasSpriteObjectTag: { spriteId: "", tag: "" },
    OnCollide: { tags: [] }, OnOverlap: { tags: [] },
    OnObjectClicked: { tags: [] }, OnObjectDoubleClicked: { tags: [] },
    OnCollideWithSpriteObject: { spriteId: "" }, OnOverlapWithSpriteObject: { spriteId: "" },
    OnSpriteObjectCreate: { spriteId: "" }, OnSpriteObjectDestroy: { spriteId: "" },
    OnKeyPressed: { actions: [] }, OnKeyReleased: { actions: [] }, OnKeyHeld: { actions: [] },
    OnSignal: { signals: [] },
    OnAnimationEnd: { animation: "" }, IsAnimationPlaying: { animation: "" },
    IsStateEnabled: { state: "" }, IsScene: { scene: "" },
    OnMouseButtonPressed: { button: 0 }, OnMouseButtonReleased: { button: 0 },
    OnMouseWheel: { wheelDir: "any" },
    IsCursorOverObject: { tags: [] },
    OnTweenStart: { tweenTag: "" }, OnTweenFinish: { tweenTag: "" },
    OnParticleBurstEnd: { target: "" },
    // IsAnimatorAnimPlaying stores the SmartTween anim name in the legacy
    // `action` field (matches the Logic Sheet + runtime).
    IsAnimatorAnimPlaying: { action: "" },
    InputCombo: { comboKeys: [] },
  };
  const expected: Record<string, unknown> = { ...(SUPPLEMENT[kind] ?? {}), ...(CONDITION_PARAM_DEFAULTS[kind] ?? {}) };
  if (kind === "OnKeyPressed" || kind === "OnKeyReleased" || kind === "OnKeyHeld") expected.actions = c.actions ?? [];
  const widgets: React.ReactNode[] = [];
  const has = (k: string) => c[k] !== undefined || expected[k] !== undefined;

  if (has("property")) widgets.push(
    <select key="property" value={String(c.property ?? "")} onChange={(e) => set({ property: e.target.value })} style={{ fontSize: 11 }} title="Property">
      {COMPARE_PROPERTIES.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>);
  if (has("left")) widgets.push(
    <ExpressionField key="left" showPicker wrap="raw" value={c.left as string} onChange={(v) => set({ left: v })} style={{ width: 90, fontSize: 11 }} title="Left value (literal, var:name, self.x…)" />);
  if (has("op")) widgets.push(
    <select key="op" value={String(c.op ?? "==")} onChange={(e) => set({ op: e.target.value })} style={{ width: 56, fontSize: 11 }} title="Operator">
      {(kind === "CompareValues" ? COMPARE_VALUE_OPS : COMPARE_OPS).map((o) => <option key={o} value={o}>{o}</option>)}
    </select>);
  if (has("textOp")) widgets.push(
    <select key="textOp" value={String(c.textOp ?? "==")} onChange={(e) => set({ textOp: e.target.value })} style={{ width: 70, fontSize: 11 }} title="Text operator">
      {["==", "!=", "contains", "startsWith", "endsWith"].map((o) => <option key={o} value={o}>{o}</option>)}
    </select>);
  if (has("right")) widgets.push(
    <ExpressionField key="right" showPicker wrap="raw" value={c.right as string} onChange={(v) => set({ right: v })} style={{ width: 80, fontSize: 11 }} title="Right value (literal, var:name…)" />);
  if (has("value")) widgets.push(
    <ExpressionField key="value" showPicker wrap="raw" value={c.value as string | number} onChange={(v) => set({ value: v })} style={{ width: 80, fontSize: 11 }} title="Value / threshold (number or expression)" />);
  if (has("textValue")) widgets.push(
    <input key="textValue" type="text" value={String(c.textValue ?? "")} onChange={(e) => set({ textValue: e.target.value })} placeholder="text" style={{ width: 90, fontSize: 11 }} />);
  if (has("min")) widgets.push(
    <ExpressionField key="min" showPicker wrap="raw" value={c.min as string | number} onChange={(v) => set({ min: v })} style={{ width: 60, fontSize: 11 }} title="Min" />);
  if (has("max")) widgets.push(
    <ExpressionField key="max" showPicker wrap="raw" value={c.max as string | number} onChange={(v) => set({ max: v })} style={{ width: 60, fontSize: 11 }} title="Max" />);
  if (has("seconds")) widgets.push(
    <ExpressionField key="seconds" showPicker wrap="raw" value={c.seconds as string | number} onChange={(v) => set({ seconds: v })} style={{ width: 60, fontSize: 11 }} title="Seconds" />);
  if (has("varName")) widgets.push(
    <input key="varName" type="text" list={opts.varDatalistId} value={String(c.varName ?? "")} onChange={(e) => set({ varName: e.target.value })} placeholder="var name" style={{ minWidth: 80, fontSize: 11 }} />);
  if (has("expected")) widgets.push(
    <Toggle key="expected" value={c.expected !== false} onChange={(v) => set({ expected: v })} title="Expected boolean value" />);
  // `action` is overloaded across kinds: AI state (IsAIState), SmartTween
  // anim name (IsAnimatorAnimPlaying), otherwise an input action.
  if (has("action")) {
    if (kind === "IsAIState") {
      widgets.push(
        <select key="action" value={String(c.action ?? "")} onChange={(e) => set({ action: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="AI Brain state">
          <option value="">(pick state)</option>
          {AI_STATE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>);
    } else if (kind === "IsAnimatorAnimPlaying") {
      widgets.push(
        <select key="action" value={String(c.action ?? "")} onChange={(e) => set({ action: e.target.value })} style={{ minWidth: 120, fontSize: 11 }} title="Smart Tween animation">
          <option value="">(pick animation)</option>
          {opts.animatorAnimNames.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>);
    } else {
      widgets.push(<span key="action">{inputActionSelect(String(c.action ?? ""), (v) => set({ action: v }))}</span>);
    }
  }
  if (has("actions")) {
    // OnKeyPressed/Released/Held — single input-action picker writing an array.
    const arr = Array.isArray(c.actions) ? (c.actions as string[]) : [];
    widgets.push(<span key="actions">{inputActionSelect(arr[0] ?? "", (v) => set({ actions: v ? [v] : [] }))}</span>);
  }
  if (has("state")) widgets.push(
    <select key="state" value={String(c.state ?? "")} onChange={(e) => set({ state: e.target.value })} style={{ minWidth: 100, fontSize: 11 }} title="State">
      <option value="">(pick state)</option>
      {opts.stateNames.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>);
  if (has("animation")) widgets.push(
    <select key="animation" value={String(c.animation ?? "")} onChange={(e) => set({ animation: e.target.value })} style={{ minWidth: 100, fontSize: 11 }} title="Animation">
      <option value="">(pick anim)</option>
      {opts.animNames.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>);
  // `signal` (singular, IsSignalFiring) and `signals` (plural, OnSignal) are
  // two representations of the same idea — only ever show ONE picker, even if a
  // migrated/stale condition carries both fields (was rendering two side by side).
  if (has("signal") && !has("signals")) widgets.push(
    <SignalPicker key="signal" value={String(c.signal ?? "")} onChange={(v) => set({ signal: v })} placeholder="pick signal…" style={{ minWidth: 130, fontSize: 11 }} forBpId={opts.bpId} />);
  if (has("signals")) {
    const arr = Array.isArray(c.signals) ? (c.signals as string[]) : [];
    widgets.push(
      <SignalPicker key="signals" value={arr[0] ?? ""} onChange={(v) => set({ signals: v ? [v] : [] })} placeholder="pick signal…" style={{ minWidth: 130, fontSize: 11 }} forBpId={opts.bpId} />);
  }
  if (has("spriteId")) widgets.push(
    <input key="spriteId" type="text" value={String(c.spriteId ?? "")} onChange={(e) => set({ spriteId: e.target.value })} placeholder="sprite object" style={{ minWidth: 100, fontSize: 11 }} title="Sprite object placement name/id" />);
  if (has("tracer")) widgets.push(
    <select key="tracer" value={String(c.tracer ?? "")} onChange={(e) => set({ tracer: e.target.value })} style={{ minWidth: 90, fontSize: 11 }} title="Tracer component">
      <option value="">(first tracer)</option>
      {opts.tracerNames.map((n) => <option key={n || "__u"} value={n}>{n || "(unnamed)"}</option>)}
    </select>);
  if (has("tag")) widgets.push(
    <input key="tag" type="text" list={opts.tagDatalistId} value={String(c.tag ?? "")} onChange={(e) => set({ tag: e.target.value })} placeholder="tag" style={{ minWidth: 90, fontSize: 11 }} />);
  if (has("tagValue")) widgets.push(
    <input key="tagValue" type="text" list={opts.tagDatalistId} value={String(c.tagValue ?? "")} onChange={(e) => set({ tagValue: e.target.value })} placeholder="hit tag" style={{ width: 80, fontSize: 11 }} />);
  if (has("direction")) widgets.push(
    <select key="direction" value={String(c.direction ?? "")} onChange={(e) => set({ direction: e.target.value })} style={{ minWidth: 100, fontSize: 11 }} title="Direction">
      {DIRECTION_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
    </select>);
  if (has("comboKeys")) {
    const rows = Array.isArray(c.comboKeys) ? (c.comboKeys as Array<{ mode: string; action: string }>) : [];
    const setRows = (next: Array<{ mode: string; action: string }>) => set({ comboKeys: next });
    widgets.push(
      <div key="comboKeys" style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
        {rows.map((row, idx) => (
          <div key={idx} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select value={row.mode ?? "held"} onChange={(e) => setRows(rows.map((x, j) => j === idx ? { ...x, mode: e.target.value } : x))} style={{ width: 70, fontSize: 11 }} title="Held / Pressed / Released">
              <option value="held">Held</option>
              <option value="pressed">Pressed</option>
              <option value="released">Released</option>
            </select>
            <select value={row.action ?? ""} onChange={(e) => setRows(rows.map((x, j) => j === idx ? { ...x, action: e.target.value } : x))} style={{ minWidth: 90, fontSize: 11 }}>
              {opts.inputActions.map((a) => <option key={a || "__e"} value={a}>{a || "— action —"}</option>)}
            </select>
            <button onClick={() => setRows(rows.filter((_, j) => j !== idx))} title="Remove key" style={{ width: 18, height: 18, padding: 0, border: "1px solid var(--border)", borderRadius: 3, background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}>×</button>
          </div>
        ))}
        <button onClick={() => setRows([...rows, { mode: "held", action: "" }])} style={{ alignSelf: "flex-start", padding: "1px 8px", fontSize: 10, background: "transparent", border: "1px dashed var(--border)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer" }}>+ Add key</button>
      </div>);
  }
  if (has("behavior")) widgets.push(
    <select key="behavior" value={String(c.behavior ?? "")} onChange={(e) => set({ behavior: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="Behavior component">
      {["CharacterMovement", "TopdownMovement", "SpriteRenderer", "Collider", "Tracer", "ParticleEmitter", "Camera", "Text", "MoveTo", "AIBrain", "Damageable", "StateMachine", "SmartTween", "WeaponSlot"].map((b) => <option key={b} value={b}>{b}</option>)}
    </select>);
  if (has("cmParam")) widgets.push(
    <select key="cmParam" value={String(c.cmParam ?? "")} onChange={(e) => set({ cmParam: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="CharacterMovement parameter">
      {opts.cmParams.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>);
  if (has("tmParam")) widgets.push(
    <select key="tmParam" value={String(c.tmParam ?? "")} onChange={(e) => set({ tmParam: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="TopdownMovement parameter">
      {opts.tmParams.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>);
  if (has("scene")) widgets.push(
    <select key="scene" value={String(c.scene ?? "")} onChange={(e) => set({ scene: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="Scene">
      <option value="">(pick scene)</option>
      {opts.sceneNames.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>);
  if (has("sound")) widgets.push(
    <select key="sound" value={String(c.sound ?? "")} onChange={(e) => set({ sound: e.target.value })} style={{ minWidth: 110, fontSize: 11 }} title="Sound (empty = any)">
      <option value="">(any)</option>
      {opts.soundNames.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>);
  if (has("item")) widgets.push(
    <select key="item" value={String(c.item ?? "")} onChange={(e) => set({ item: e.target.value })} style={{ minWidth: 100, fontSize: 11 }} title="Item">
      <option value="">(pick item)</option>
      {opts.itemNames.map((it) => <option key={it} value={it}>{it}</option>)}
    </select>);
  if (has("layer")) widgets.push(
    <select key="layer" value={String(c.layer ?? "")} onChange={(e) => set({ layer: e.target.value })} style={{ minWidth: 100, fontSize: 11 }} title="Layer">
      <option value="">(pick layer)</option>
      {opts.layerNames.map((l) => <option key={l} value={l}>{l}</option>)}
    </select>);
  if (has("wheelDir")) widgets.push(
    <select key="wheelDir" value={String(c.wheelDir ?? "any")} onChange={(e) => set({ wheelDir: e.target.value })} style={{ fontSize: 11 }} title="Wheel direction">
      {["up", "down", "any"].map((w) => <option key={w} value={w}>{w}</option>)}
    </select>);
  if (has("tweenTag")) widgets.push(
    <input key="tweenTag" type="text" value={String(c.tweenTag ?? "")} onChange={(e) => set({ tweenTag: e.target.value })} placeholder="tween tag (empty = any)" style={{ minWidth: 100, fontSize: 11 }} title="Tween tag — empty matches any tween" />);
  if (has("target")) widgets.push(
    <input key="target" type="text" value={String(c.target ?? "")} onChange={(e) => set({ target: e.target.value })} placeholder="emitter name" style={{ minWidth: 100, fontSize: 11 }} title="ParticleEmitter component name" />);
  if (has("button")) widgets.push(
    <select key="button" value={String(c.button ?? 0)} onChange={(e) => set({ button: Number(e.target.value) })} style={{ fontSize: 11 }} title="Mouse button">
      <option value={0}>Left</option><option value={1}>Middle</option><option value={2}>Right</option>
    </select>);
  if (has("scope")) widgets.push(
    <select key="scope" value={String(c.scope ?? "all")} onChange={(e) => set({ scope: e.target.value })} style={{ fontSize: 11 }} title="Pause scope">
      <option value="all">whole scene</option><option value="layer">one layer</option>
    </select>);
  // Generic free-text / expression fields the conditions above didn't claim.
  // Driven off the kind's EXPECTED shape so every documented field renders
  // SOMETHING the author can edit — no silent "missing value" gaps. Known
  // free-text keys: cmParam, tmParam, tweenTag, sound, item, uid, layer,
  // tilemap, c, r, tileX, tileY, seconds (already), etc.
  const RENDERED = new Set(["kind", "not", "subject", "property", "left", "op", "textOp",
    "right", "value", "textValue", "min", "max", "seconds", "varName", "expected",
    "action", "actions", "state", "animation", "signal", "signals", "spriteId",
    "tracer", "tag", "tagValue", "direction", "behavior", "button", "scope",
    "cmParam", "tmParam", "scene", "sound", "item", "layer", "wheelDir", "tweenTag", "target", "comboKeys"]);
  const FIELD_LABEL: Record<string, string> = {
    cmParam: "CM param", tmParam: "TM param", tweenTag: "tween tag", sound: "sound",
    item: "item", uid: "uid", layer: "layer", tilemap: "tilemap", c: "col", r: "row",
    tileX: "x", tileY: "y", tags: "tags (csv)",
  };
  for (const fk of Object.keys(expected)) {
    if (RENDERED.has(fk)) continue;
    const isTags = fk === "tags";
    const cur = isTags
      ? (Array.isArray(c[fk]) ? (c[fk] as string[]).join(",") : "")
      : String(c[fk] ?? expected[fk] ?? "");
    widgets.push(
      <input
        key={fk}
        type="text"
        value={cur}
        onChange={(e) => set({ [fk]: isTags ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : e.target.value })}
        placeholder={FIELD_LABEL[fk] ?? fk}
        title={`${FIELD_LABEL[fk] ?? fk} (${fk})`}
        style={{ width: 80, fontSize: 11 }}
      />);
  }

  return (
    <div style={{ display: "inline-flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <ConditionKindPicker value={kind} onPick={pickKind} />
      {widgets}
    </div>
  );
}

/** Tiny segmented AND/OR control. `value` true = OR (any), false = AND (all). */
function AndOrToggle({ value, onChange }: { value?: boolean; onChange: (any: boolean) => void }) {
  const cell = (active: boolean): React.CSSProperties => ({
    padding: "1px 9px", lineHeight: "16px", border: "none", cursor: "pointer",
    fontSize: 10, fontWeight: 700,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--on-accent)" : "var(--text-dim)",
  });
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <button onClick={() => onChange(false)} title="AND — every condition must match" style={cell(!value)}>AND</button>
      <button onClick={() => onChange(true)} title="OR — any condition matching is enough" style={cell(!!value)}>OR</button>
    </div>
  );
}

/** Reusable frame-motion editor — the per-frame position-offset table.
 *  Used by AdvancedSettingsPanel for the state-level motions and by
 *  ComboAnimsEditor (per combo index) for combo-specific motions. */
function FrameMotionsGrid({
  motions, animOptions, onChange,
}: {
  motions: FrameMotionRow[];
  /** Animation names available to assign per row. For combo states pass
   *  the state's `comboAnimations`; for non-combo states pass `[]` (or
   *  just the BP's anim list) — the dropdown's empty value (= "All") is
   *  always present. */
  animOptions: string[];
  onChange: (next: FrameMotionRow[]) => void;
}) {
  const patchMotion = (idx: number, patch: Partial<FrameMotionRow>) => {
    onChange(motions.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  };
  const addMotion = () => {
    onChange([...motions, { frame: 0, dx: 0, dy: 0, mode: "instant", duration: 0.1 }]);
  };
  const removeMotion = (idx: number) => {
    onChange(motions.filter((_, i) => i !== idx));
  };
  return (
    <div>
      {motions.length === 0 ? (
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "4px 0" }}>
          No frame motions. Add rows below — e.g. attack lunges at frames 4 / 10 / 24.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "50px 60px 60px 90px 70px 28px 90px 22px",
            gap: 6,
            fontSize: 9,
            color: "var(--text-dim)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            paddingLeft: 4,
          }}>
            <span title="0-based — matches the Sprite editor.">Frame</span>
            <span>+dx (fwd)</span>
            <span>+dy</span>
            <span>Mode</span>
            <span>Duration</span>
            <span title="Wall guard — skip the motion when the body is blocked in the direction of dx/dy. Stops lunges from clipping through walls.">Wall</span>
            <span title="Restrict to a specific anim. Empty = applies to all anims. Pick a combo anim name to scope this motion to that combo step only (reorder-safe).">Anim</span>
            <span></span>
          </div>
          {motions.map((m, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "50px 60px 60px 90px 70px 28px 90px 22px",
                gap: 6,
                alignItems: "center",
                padding: "2px 4px",
                background: "rgba(0,0,0,0.2)",
                borderRadius: 4,
              }}
            >
              <NumericInput
                value={Number(m.frame ?? 0)}
                onChange={(v) => patchMotion(i, { frame: Math.max(0, v) })}
                style={{ width: "100%", minWidth: 0 }}
                title="Frame inside the main animation (0-based — matches the Sprite editor's `Frame 0, Frame 1 …` labels)."
              />
              <input
                type="text"
                value={String(m.dx ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  // Plain integers stay numeric so saved JSON doesn't bloat
                  // with quotes. Any non-numeric value is an expression —
                  // store as the raw string for the runtime numOr to parse.
                  const n = Number(raw);
                  patchMotion(i, { dx: raw === "" ? 0 : (Number.isFinite(n) && String(n) === raw.trim() ? n : raw) });
                }}
                style={{ width: "100%", minWidth: 0 }}
                placeholder="number or random(a,b)"
                title="Forward-relative X. Positive = forward (auto-flipped when facing left). Negative = backward. Accepts an expression: random(40,80), var:dashRange, etc."
              />
              <input
                type="text"
                value={String(m.dy ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  const n = Number(raw);
                  patchMotion(i, { dy: raw === "" ? 0 : (Number.isFinite(n) && String(n) === raw.trim() ? n : raw) });
                }}
                style={{ width: "100%", minWidth: 0 }}
                placeholder="number or random(a,b)"
                title="World Y offset. Positive = down, Negative = up. Accepts an expression: random(-10,10), var:jumpKick, etc."
              />
              <select
                value={m.mode}
                onChange={(e) => patchMotion(i, { mode: e.target.value as "instant" | "tween" })}
                style={{ width: "100%", minWidth: 0 }}
              >
                <option value="instant">Instant</option>
                <option value="tween">Tween</option>
              </select>
              <NumericInput
                value={Number(m.duration ?? 0)}
                onChange={(v) => patchMotion(i, { duration: v })}
                step={0.05}
                disabled={m.mode !== "tween"}
                style={{ width: "100%", minWidth: 0, opacity: m.mode === "tween" ? 1 : 0.4 }}
                title="Tween duration in seconds. Ignored for Instant."
              />
              <Toggle
                value={!!m.skipIfBlocked}
                onChange={(v) => patchMotion(i, { skipIfBlocked: v })}
                title="Wall guard — when on, the motion is skipped if it would push the body into a Solid (lookahead overlap test). Catches both 'touching wall' and 'near wall' cases."
                style={{ justifySelf: "center" }}
              />
              <select
                value={m.anim ?? ""}
                onChange={(e) => patchMotion(i, { anim: e.target.value })}
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                title="Restrict this motion to one combo anim. Empty = all anims."
              >
                <option value="">(all)</option>
                {animOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <button
                onClick={() => removeMotion(i)}
                title="Remove this motion"
                style={{
                  width: 22, height: 20, padding: 0, lineHeight: "18px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={addMotion}
        style={{ ...ADD_BTN, marginTop: 6 }}
      >+ Add Frame Motion</button>
    </div>
  );
}

/** Expanded advanced-settings panel rendered below the state row.
 *  Three controls: freeze time on entry, freeze movement while active,
 *  and a per-frame motion offsets table. All optional — leaving them
 *  empty / off means the state behaves exactly as before. */
function AdvancedSettingsPanel({
  row, animOptions, onPatch,
}: {
  row: AnimStateRow;
  /** Anim names available to assign per frame-motion row. Combo states
   *  pass their combo anim names; non-combo states pass the BP's full
   *  anim list. */
  animOptions: string[];
  onPatch: (patch: Partial<AnimStateRow>) => void;
}) {
  const motions = Array.isArray(row.frameMotions) ? row.frameMotions : [];

  return (
    <div style={{
      marginLeft: 16,
      padding: "8px 10px",
      background: "rgba(255,255,255,0.03)",
      borderLeft: "2px solid var(--accent)",
      borderRadius: 4,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="Zeros body velocity every tick the state is active in main phase. Does NOT block input — for that, use Ignore Input. Use both for a 'stunned / interact' state where the body must stop AND the player can't move.">
          <Toggle
            value={!!row.freezeMovement}
            onChange={(v) => onPatch({ freezeMovement: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Freeze Movement</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="Blocks CharacterMovement's read of player input every tick the state is active in main phase. Does NOT zero velocity — CM-driven motions (dash, etc.) keep going. Use this for 'dash' / 'attack' states where you want CM to keep driving the motion but the player shouldn't be able to override with WASD/Jump.">
          <Toggle
            value={!!row.ignoreInput}
            onChange={(v) => onPatch({ ignoreInput: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Ignore Input</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="When the main anim is one-shot (sprite asset loop=false) and finishes, hold on the last frame instead of releasing the state. Useful for death / interact / pose states where you want the final frame to linger. When off (default), the state releases when the anim ends and the next-priority state wins.">
          <Toggle
            value={!!row.holdOnFinish}
            onChange={(v) => onPatch({ holdOnFinish: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Hold on Finish</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="Lock the sprite's facing while this state's animation plays one cycle. The automatic flips (CharacterMovement mirror + AIBrain auto-face-target) are suppressed until the main anim finishes a cycle, then the held flip applies. Use on attack states so an enemy finishes its swing before turning to a player who jumped behind it. Explicit SetFacing nodes still apply.">
          <Toggle
            value={!!row.lockFacing}
            onChange={(v) => onPatch({ lockFacing: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Lock Facing</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="While this state is active, AIBrain stays paused (no transitions, no attackSignal emit, no sensed input pushes). Tick on hurt/death/stunned states so the brain can't decide to attack mid-stagger. Tighter than name-matching: rename the state freely, the flag stays attached.">
          <Toggle
            value={!!row.pausesAI}
            onChange={(v) => onPatch({ pausesAI: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Pauses AI</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} title="Replay this state's animation from frame 0 every time its signal condition re-fires while the state is already active — e.g. a 2nd hit landing mid-hurt re-plays the flinch. Without this, the animator won't re-enter a state it's already in, so rapid repeat hits show no new flinch. Use on signal-driven states (hurt via OnDamageTaken). Rate-limited by Re-entry Guard.">
          <Toggle
            value={!!row.retrigger}
            onChange={(v) => onPatch({ retrigger: v })}
          />
          <span style={{ color: "var(--text-dim)" }}>Replay on Re-trigger</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }} title="Per-state hysteresis window (ms). Overrides the animator-wide 60 ms default. Lower = state releases faster on condition flicker (precision games); higher = state stickier (slow combat). 0 / empty = use animator default.">
          Hysteresis (ms)
          <NumericInput
            value={Number(row.hysteresisMs ?? 0)}
            onChange={(v) => onPatch({ hysteresisMs: v })}
            style={{ width: 60, fontSize: 11 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }} title="Per-state re-entry guard (ms). Overrides the animator-wide 80 ms default. Controls how long after exiting the state a re-entry will skip its enter anim (avoids enter replay on flicker). 0 / empty = use animator default.">
          Re-entry Guard (ms)
          <NumericInput
            value={Number(row.reEntryGuardMs ?? 0)}
            onChange={(v) => onPatch({ reEntryGuardMs: v })}
            style={{ width: 60, fontSize: 11 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }} title="Minimum PhaseManager.currentPhase for this state to be eligible. Set to 1 to gate behind the first phase transition, 2 for the second, etc. Requires a PhaseManager component on the BP. Use -1 for 'unset' (no lower bound).">
          Min Phase
          <NumericInput
            value={row.minPhase ?? -1}
            onChange={(v) => onPatch({ minPhase: v < 0 ? undefined : v })}
            style={{ width: 50, fontSize: 11 }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }} title="Maximum PhaseManager.currentPhase for this state to be eligible. Set when a state should retire in later phases — e.g. a phase-0-only weak attack the enraged boss drops at phase 1+. Use -1 for 'unset' (no upper bound).">
          Max Phase
          <NumericInput
            value={row.maxPhase ?? -1}
            onChange={(v) => onPatch({ maxPhase: v < 0 ? undefined : v })}
            style={{ width: 50, fontSize: 11 }}
          />
        </label>
      </div>

      <div>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>
          Frame Motions {(row.comboAnimations && row.comboAnimations.length > 0)
            ? <span style={{ textTransform: "none", letterSpacing: 0 }} title="Used as the FALLBACK when a combo index has no per-anim motions. Per-anim overrides live in the Combo section.">— shared fallback (per-anim overrides in Combo)</span>
            : <span style={{ textTransform: "none", letterSpacing: 0 }} title="Position offsets that fire when the main animation enters the listed frame index. dx is forward-relative (auto-flipped when facing left); dy is world Y (down = positive).">— forward-relative, facing-aware</span>}
        </div>
        <FrameMotionsGrid
          motions={motions}
          animOptions={animOptions}
          onChange={(next) => onPatch({ frameMotions: next })}
        />
      </div>

    </div>
  );
}


/** Number input that tolerates transient text states the way a normal
 *  controlled `<input type="number">` does NOT — specifically, a bare
 *  "-" while the user is mid-typing "-20". The standard pattern pushes
 *  `Number("-") = NaN` back through onChange, which we then refuse,
 *  React re-renders with the stale numeric value, and the "-" the user
 *  just typed disappears.
 *
 *  This helper keeps a local string buffer, only forwards parseable
 *  numbers, and re-syncs the buffer when the external value changes. */
function NumericInput({
  value, onChange, step, disabled, title, style,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  disabled?: boolean;
  title?: string;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState<string>(() => String(Number.isFinite(value) ? value : 0));
  useEffect(() => {
    // Re-sync if the external value differs from what's in the buffer.
    // Compare numerically to avoid "0" vs "0.0" no-op churn.
    const buffered = Number(text);
    if (!Number.isFinite(buffered) || buffered !== value) {
      setText(String(Number.isFinite(value) ? value : 0));
    }
  // text intentionally excluded — re-sync only on external value changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      step={step}
      disabled={disabled}
      title={title}
      style={style}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const num = Number(next);
        if (Number.isFinite(num)) onChange(num);
      }}
      onBlur={() => {
        // On focus loss, snap the buffer back to the canonical value if
        // it ended in a partial state (e.g. "-" or "1.").
        const num = Number(text);
        if (!Number.isFinite(num)) setText(String(value));
      }}
    />
  );
}

/** Anim-name picker that falls back to a free-text input when there are
 *  no sprite animations to choose from (e.g. user hasn't assigned a
 *  Sprite asset yet) or the saved value isn't in the current list. */
function AnimDropdown({
  value, onChange, options, placeholder, title, disabled, manual,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  title?: string;
  /** Gray out + block input. Used when the row's In/Out master toggle
   *  is off so the saved name stays but can't be edited until re-enabled. */
  disabled?: boolean;
  /** Force a free-text input instead of the dropdown — used when the machine
   *  is in "type manually" mode (its states target a swapped sprite whose
   *  animations aren't in the current sprite's option list). */
  manual?: boolean;
}) {
  if (manual) {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        title={title}
        disabled={disabled}
        style={{ width: "100%", minWidth: 0, opacity: disabled ? 0.4 : 1 }}
      />
    );
  }
  // Dropdown mode honors the author's toggle even with zero options —
  // showing an empty <select> with a clear "attach a sprite" hint reads
  // as "I'm waiting on data" instead of silently flipping to a text
  // input that looks identical to manual mode.
  const missing = value && !options.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={options.length === 0 ? "No animations — attach a SpriteRenderer with a sprite asset first." : title}
      disabled={disabled || options.length === 0}
      style={{ width: "100%", minWidth: 0, opacity: (disabled || options.length === 0) ? 0.4 : 1 }}
    >
      <option value="">{options.length === 0 ? "(attach a sprite)" : placeholder}</option>
      {missing && <option value={value}>{value} (missing)</option>}
      {options.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );
}

