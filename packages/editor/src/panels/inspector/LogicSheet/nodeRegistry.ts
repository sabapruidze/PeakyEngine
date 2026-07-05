import type { StateActionKind, ConditionKind } from "@peaky/shared";
import { ACTION_KINDS, ACTION_DEFAULTS, ACTION_DESCRIPTIONS, CONDITION_KINDS, TRIGGER_KINDS } from "@peaky/shared";

/** Triggers live in the curated PALETTE Triggers group — exclude them
 *  from the generic condition palette so they don't double-emit. */
const TRIGGER_KIND_SET: ReadonlySet<ConditionKind> = new Set(TRIGGER_KINDS);

/**
 * Engine-side action kinds that the Logic Sheet renders with HAND-CURATED
 * palette entries (custom param names / behavior). Auto-generated entries
 * for these kinds would clash with the curated ones, so the generator
 * skips them and the existing PALETTE in LogicGraphCanvas still owns the
 * UX for these. Everything else gets auto-promoted via genericActionEntries.
 */
const CURATED_ACTION_KINDS: ReadonlySet<string> = new Set<string>([
  "EmitSignal", "EmitSignalTo",
  "SetVar", "AddVar", "ToggleBool",
  // Combat — curated in PALETTE with "Apply Damage" / "Heal" labels. Without
  // this exclusion the auto-generator ships a second copy of each.
  "ApplyDamage", "Heal",
  "PlayAnimation",
  "CreateObject", "CreateObjectByName",
  "Destroy", "Wait", "WaitForSignal", "PrintString",
  "PlayDialogue", "StopDialogue",
  "SetBehaviorParam", "SetBehaviorEnabled",
  // MoveTo setters — already in the curated Actions group with "MoveTo →"
  // labels. Without these in this list the auto-generator also emitted a
  // second copy with the humanized label "Move To Set Position" etc., so
  // every search hit a pair of near-identical rows.
  "MoveToSetPosition", "MoveToSetObject", "MoveToSetTag", "MoveToSetAngle",
  "MoveToStop", "MoveToResume", "MoveToSetSpeed",
  // Loading-system actions — curated with descriptive labels in PALETTE.
  "GoToLayoutWithLoad", "SetLoadingProgress", "SetLoadingScene",
  // Identity setters — curated in PALETTE.
  "SetInstanceName", "EditTags",
  // DebugPrint — special wire-inserted node, custom compact renderer.
  "DebugPrint",
  // Sprite Object actions — curated in PALETTE with the "Sprite Object"
  // labels. Without this list the auto-generator also shipped a SECOND
  // row per action with the humanized internal name ("Set Placement
  // Visible" etc.), producing 4-5 visible duplicates per action.
  "SetPlacementVisible", "SetPlacementFrame", "PlayPlacementAnim",
  "StopPlacementAnim", "SetPlacementPos", "CreateSpriteObject",
  "DestroySpriteObject",
  "SetPlacementScale", "SetPlacementRotation", "SetPlacementAlpha",
  "SetSpriteObjectColliderEnabled", "SetSpriteObjectSolid", "SetSpriteObjectCollideMode",
  "AddSpriteObjectTag", "RemoveSpriteObjectTag", "ClearSpriteObjectTags",
  "AddSpriteObjectCollideTag", "RemoveSpriteObjectCollideTag", "ClearSpriteObjectCollideTags",
  "SetRecipeEnabled", "AddRecipeIngredient", "RemoveRecipeIngredient", "SetRecipeOutput",
]);

/**
 * Actions retired from the palette but kept in the engine so existing saved
 * graphs still run. The per-property UI setters are all folded into the
 * dynamic SetUIElement node now — pick the element and it shows that kind's
 * params. Old SetUIText / SetUIValue / SetUISelectedValue / SetUIBgColor nodes
 * keep working at runtime; they just aren't offered for new graphs.
 */
const DEPRECATED_ACTION_KINDS: ReadonlySet<string> = new Set<string>([
  "SetUIText", "SetUIValue", "SetUISelectedValue", "SetUIBgColor",
  // Superseded by Give Item / Take Item (the unified count-global + Inventory
  // pair). Hidden from new graphs; still run in any graph that uses them.
  "AddItem", "RemoveItem",
]);

export interface GeneratedPaletteEntry {
  type: string;
  kind: "action";
  label: string;
  defaults: Record<string, unknown>;
  component: string;
  description: string;
}

/**
 * Build a palette entry for every engine action that isn't already
 * curated in LogicGraphCanvas's PALETTE. Each entry's `type` matches its
 * StateActionKind so the runtime's generic pass-through in nodeToAction
 * can build `{ kind: node.type, config: node.params }` and let runAction
 * dispatch it. `defaults` mirrors ACTION_DEFAULTS so param keys line up
 * with what runAction reads.
 */
/**
 * Engine ConditionKinds already curated with custom param names in the
 * Logic Sheet — generator skips these so we don't duplicate. Note: the
 * curated palette uses `VarEquals`/`VarAbove` etc., while the engine
 * registry uses `Compare`/`CompareValues`. They cover similar ground
 * but expose different UX, so we keep both available.
 */
const CURATED_CONDITION_KINDS: ReadonlySet<string> = new Set<string>([
  "VarEquals", "VarAbove", "VarBelow", "VarTrue", "VarFalse",
  "IsOverlappingTag", "IsAnimationPlaying", "IsState",
  "IsGrounded", "IsByWall", "IsDialoguePlaying",
  "IsAIState", "IsTargetSighted", "DistanceToTargetBelow",
  // MoveTo state queries — same dedup story as the MoveTo setters above.
  "IsMovingTo", "HasArrived",
  // Tag queries — curated in PALETTE with the right field shape (tag vs tags[]).
  "HasTag", "HasAnyTag", "HasAllTags",
  // Loading-system polling condition.
  "IsLoading",
  // Scene-name compare.
  "IsScene",
  // Sprite Object triggers — curated with the placement dropdown.
  // Collide/Overlap are RETIRED from the palette (unified into On Collide /
  // On Overlap [tag] via firePlacementContact) but stay here so the generator
  // doesn't resurrect them as generic nodes; old saves still load via runtime.
  "OnCollideWithSpriteObject", "OnOverlapWithSpriteObject",
  "OnSpriteObjectCreate", "OnSpriteObjectDestroy",
  "HasSpriteObjectTag",
]);

/** Per-condition default params keyed off the engine's `Condition` shape.
 *  Most conditions read a small subset (tag / signal / value / etc.) so we
 *  pre-seed just those — keeps the auto-generated node's inline param list
 *  short and authorable without dropping data wires. */
export const CONDITION_PARAM_DEFAULTS: Partial<Record<ConditionKind, Record<string, unknown>>> = {
  OnSignal: { signal: "" },
  IsSignalFiring: { signal: "" },
  Compare: { property: "velocity.x", op: ">", value: 0 },
  CompareValues: { left: "0", op: "==", right: "0" },
  CompareTime: { op: ">", value: 1 },
  IsBetween: { varName: "", min: 0, max: 100 },
  IsBoolean: { varName: "", expected: true },
  EveryXSeconds: { seconds: 1 },
  CompareCMParam: { cmParam: "maxSpeed", op: ">", value: 0 },
  CompareTMParam: { tmParam: "maxSpeed", op: ">", value: 0 },
  IsMovingDir: { direction: "up" },
  IsTopdownFacing: { direction: "down" },
  CompareFrame: { value: 0 },
  CompareText: { textOp: "==", textValue: "" },
  IsTextVisible: {},
  IsTracerHit: { tracer: "" },
  TracerHitHasTag: { tracer: "", tagValue: "" },
  IsBehaviorEnabled: { behavior: "CharacterMovement" },
  IsCameraShaking: {}, IsCameraPanning: {}, IsCameraLocked: {},
  CompareCameraZoom: { op: ">", value: 1 },
  IsTweenPlaying: { tweenTag: "" },
  IsTweenPaused: { tweenTag: "" },
  IsAnyTweenPlaying: {},
  IsEmittingParticles: {},
  IsParticleEmitterEnabled: {},
  CompareParticleCount: { op: ">", value: 0 },
  IsMusicPlaying: { sound: "" },
  IsSoundPlaying: { sound: "" },
  IsPaused: { scope: "all", layer: "" },
  HasItem: { item: "", value: 1 },
  InventoryIsFull: {},
  IsMouseButtonHeld: { button: 0 },
  IsCursorOverObject: { tags: [] },
  ObjectUIDExists: { uid: 0 },
  IsActionHeld: { action: "" },
  InputCombo: { comboKeys: [] },
  IsMoving: {}, IsMovingLeft: {}, IsMovingRight: {}, IsMovingUp: {}, IsMovingDown: {},
  IsFacingLeft: {}, IsFacingRight: {}, IsRunning: {},
  IsJumping: {}, IsFalling: {}, IsDashing: {}, IsWallSliding: {},
  IsByWallLeft: {}, IsByWallRight: {}, CanJump: {}, CanDash: {}, IsDoubleJumpEnabled: {},
  IsWallJumping: {},
  IsState: { state: "" }, IsStateEnabled: { state: "" }, PreviousStateWas: { state: "" }, PreviousAnimWas: { animation: "" },
  SignalFiredEdge: { signal: "" },
  InputBuffered: { action: "" },
  JustTurnedLeft: {}, JustTurnedRight: {}, JustWallJumped: {},
  JustCollidedWithTag: { tag: "" }, JustSeparatedFromTag: { tag: "" },
  IsOverlappingTag: { tag: "" },
  IsAirborne: {},
  IsMovingAny: { value: 0 },
  IsDead: {}, IsInHitstun: {}, IsInIframes: {},
  HasAITarget: {}, NoAITarget: {},
  IsAIState: { action: "" },
  // tileX/tileY/c/r are typed `string | number` because they accept runtime
  // expressions (mouse.x, picked.c, etc.). Defaulting to `number` 0 causes
  // the cursor-jump-to-end footgun on first keystroke when the field flips
  // to string. Default to string "0" so the typed value's runtime stays
  // consistent across edits.
  CompareTileAt: { tilemap: "", layer: "", c: "0", r: "0", op: "==", value: 0 },
  CompareTileAtWorld: { tilemap: "", layer: "", tileX: "0", tileY: "0", op: "==", value: 0 },
  IsTileSolidAt: { tilemap: "", layer: "", tileX: "0", tileY: "0" },
  IsTileEmptyAt: { tilemap: "", layer: "", tileX: "0", tileY: "0" },
};

export interface GeneratedConditionEntry {
  type: string;
  kind: "condition";
  label: string;
  defaults: Record<string, unknown>;
  component: string;
}

/**
 * Build a palette entry for every engine ConditionKind not already
 * curated. The runtime's generic pass-through in evalConditionNode
 * builds `{ kind: node.type, ...node.params }` and dispatches via the
 * shared `evaluateCondition`, so any condition appearing here works
 * without per-kind editor code.
 */
export function genericConditionEntries(): GeneratedConditionEntry[] {
  return CONDITION_KINDS
    .filter((k) => !CURATED_CONDITION_KINDS.has(k))
    // Triggers are subscribed at sheet level, not used as predicate
    // nodes — exclude them from the condition palette to keep authoring
    // mental model clean (triggers live in the Triggers group already).
    // Filter explicitly by TRIGGER_KINDS rather than name-prefix; a name-
    // pattern filter ("On"-prefix) would miss any future trigger that
    // doesn't follow the convention, and a renamed/added kind would
    // silently double-emit (once in PALETTE Triggers, once here).
    .filter((k) => !TRIGGER_KIND_SET.has(k))
    // Legacy `OnStep` — event-sheet "always true" predicate. In Logic
    // Sheets it's a Branch no-op; kept in the union for back-compat
    // with old saves, but new graphs can't add it from the palette.
    .filter((k) => k !== "OnStep")
    .map((k) => ({
      type: k,
      kind: "condition" as const,
      label: humanizeKind(k),
      defaults: { ...(CONDITION_PARAM_DEFAULTS[k] ?? {}) },
      component: CONDITION_TO_COMPONENT[k] ?? "Flow",
    }));
}

export function genericActionEntries(): GeneratedPaletteEntry[] {
  return ACTION_KINDS
    .filter((k) => !CURATED_ACTION_KINDS.has(k) && !DEPRECATED_ACTION_KINDS.has(k))
    .map((k) => ({
      type: k,
      kind: "action" as const,
      label: humanizeKind(k),
      defaults: { ...(ACTION_DEFAULTS[k] ?? {}) },
      component: ACTION_TO_COMPONENT[k as StateActionKind] ?? "Flow",
      description: ACTION_DESCRIPTIONS[k] ?? "",
    }));
}

/**
 * Color palette for component-tagged Logic Sheet nodes. Background +
 * accent values per component so authors can tell at a glance which
 * subsystem a node belongs to. Picked for legibility against the dark
 * canvas — every bg pairs with white-ish text. When a node's `type`
 * doesn't map to any component (Branch, Wait, etc.), the renderer falls
 * back to the "Flow" entry.
 */
export interface ComponentTheme {
  /** Component / category name shown as the chip label. */
  label: string;
  /** Header gradient applied to the node card. */
  headerBg: string;
  /** Chip background — solid, sits at top-right of the node. */
  chipBg: string;
  /** Chip text color. */
  chipFg: string;
}

export const COMPONENT_THEME: Record<string, ComponentTheme> = {
  CharacterMovement: { label: "CharacterMovement", headerBg: "linear-gradient(180deg, #2a6cd1, #1a4ea0)", chipBg: "#3a82e8", chipFg: "#fff" },
  TopdownMovement:   { label: "TopdownMovement",   headerBg: "linear-gradient(180deg, #2a93d1, #1a6ea0)", chipBg: "#4ab3e8", chipFg: "#001a23" },
  MoveTo:            { label: "Move To",           headerBg: "linear-gradient(180deg, #2a9d8a, #1a7060)", chipBg: "#4ac9b0", chipFg: "#001a16" },
  SpriteRenderer:    { label: "SpriteRenderer",    headerBg: "linear-gradient(180deg, #c9a23a, #8c6e1d)", chipBg: "#e0bd55", chipFg: "#1a1300" },
  SpriteObject:      { label: "Sprite Object",     headerBg: "linear-gradient(180deg, #d18a3a, #a06b1a)", chipBg: "#e8a455", chipFg: "#1a0d00" },
  Recipe:            { label: "Recipe",            headerBg: "linear-gradient(180deg, #6a8a3a, #4a6a20)", chipBg: "#9bc858", chipFg: "#0d1300" },
  StateMachine:      { label: "State Machine",     headerBg: "linear-gradient(180deg, #c25fa8, #8a3c74)", chipBg: "#e88ed0", chipFg: "#2a0020" },
  SmartTween:        { label: "Smart Tween",       headerBg: "linear-gradient(180deg, #5f9ec2, #3c6f8a)", chipBg: "#8ecbe8", chipFg: "#00202a" },
  Tracer:            { label: "Tracer",            headerBg: "linear-gradient(180deg, #d97b2a, #9a541a)", chipBg: "#ff9c4c", chipFg: "#2a1500" },
  Camera:            { label: "Camera",            headerBg: "linear-gradient(180deg, #7b4ad9, #4d2c9a)", chipBg: "#a47ef5", chipFg: "#fff" },
  Text:              { label: "Text",              headerBg: "linear-gradient(180deg, #2cb5b1, #198581)", chipBg: "#45d5d0", chipFg: "#002323" },
  Particles:         { label: "Particles",         headerBg: "linear-gradient(180deg, #3aa869, #1f7848)", chipBg: "#5fd28b", chipFg: "#002a14" },
  Dismemberment:     { label: "Dismemberment",     headerBg: "linear-gradient(180deg, #b53a3a, #7a1d1d)", chipBg: "#e06a6a", chipFg: "#280000" },
  Damageable:        { label: "Damageable",        headerBg: "linear-gradient(180deg, #d23a3a, #951d1d)", chipBg: "#ff6a6a", chipFg: "#280000" },
  Inventory:         { label: "Inventory",         headerBg: "linear-gradient(180deg, #b8862f, #7a571a)", chipBg: "#e8b35a", chipFg: "#2a1d00" },
  UI:                { label: "UI Widget",         headerBg: "linear-gradient(180deg, #d24ab0, #952c7c)", chipBg: "#ff7ed1", chipFg: "#2a0019" },
  Dialogue:          { label: "Dialogue",          headerBg: "linear-gradient(180deg, #b78a55, #84602d)", chipBg: "#d8a978", chipFg: "#2a1800" },
  Audio:             { label: "Audio",             headerBg: "linear-gradient(180deg, #c93a6e, #8a1e49)", chipBg: "#e8729c", chipFg: "#2a0014" },
  Tween:             { label: "Tween",             headerBg: "linear-gradient(180deg, #c93aa8, #8a1e74)", chipBg: "#e672cb", chipFg: "#2a0020" },
  AIBrain:           { label: "AI Brain",          headerBg: "linear-gradient(180deg, #c9a73a, #8c731d)", chipBg: "#f2d057", chipFg: "#2a2000" },
  SquashStretch:     { label: "SquashStretch",     headerBg: "linear-gradient(180deg, #4ac9a0, #1d8c6e)", chipBg: "#55e0bd", chipFg: "#002319" },
  Collider:          { label: "Collider",          headerBg: "linear-gradient(180deg, #6e8a3a, #4d6021)", chipBg: "#9cba5a", chipFg: "#0a1900" },
  Transform:         { label: "Transform",         headerBg: "linear-gradient(180deg, #3a8ad2, #1d669a)", chipBg: "#62b1f0", chipFg: "#00141f" },
  Signals:           { label: "Signals",           headerBg: "linear-gradient(180deg, #4a4ac9, #2c2c9a)", chipBg: "#8585f0", chipFg: "#fff" },
  Variables:         { label: "Variables",         headerBg: "linear-gradient(180deg, #8e8e8e, #5e5e5e)", chipBg: "#c0c0c0", chipFg: "#1a1a1a" },
  Flow:              { label: "Flow",              headerBg: "linear-gradient(180deg, #4a4a4a, #2a2a2a)", chipBg: "#787878", chipFg: "#fff" },
  Trigger:           { label: "Trigger",           headerBg: "linear-gradient(180deg, #2a6cd1, #1a4ea0)", chipBg: "#3a82e8", chipFg: "#fff" },
  Time:              { label: "Time",              headerBg: "linear-gradient(180deg, #b59a44, #82691f)", chipBg: "#dab85e", chipFg: "#2a1f00" },
  Scene:             { label: "Scene",             headerBg: "linear-gradient(180deg, #5a8a3a, #3a5d21)", chipBg: "#8ec25e", chipFg: "#0a1900" },
  SaveLoad:          { label: "Save/Load",         headerBg: "linear-gradient(180deg, #6a6a3a, #44441d)", chipBg: "#b5b56a", chipFg: "#1a1a00" },
  System:            { label: "System",            headerBg: "linear-gradient(180deg, #5a5a5a, #3a3a3a)", chipBg: "#9a9a9a", chipFg: "#fff" },
  Debug:             { label: "Debug",             headerBg: "linear-gradient(180deg, #d23a8e, #951d5e)", chipBg: "#ff6ab5", chipFg: "#2a001a" },
  Mouse:             { label: "Mouse",             headerBg: "linear-gradient(180deg, #b53a3a, #821d1d)", chipBg: "#e07474", chipFg: "#280000" },
  Behavior:          { label: "Behavior",          headerBg: "linear-gradient(180deg, #3a8e6e, #1d6749)", chipBg: "#65c5a4", chipFg: "#00231a" },
  Spawning:          { label: "Spawning",          headerBg: "linear-gradient(180deg, #8e6e3a, #67491d)", chipBg: "#c5a474", chipFg: "#231a00" },
  Tilemap:           { label: "Tilemap",           headerBg: "linear-gradient(180deg, #4ab572, #1d7848)", chipBg: "#80e0a8", chipFg: "#002a14" },
};

/**
 * Reverse of `ACTION_CATEGORIES` in EventsSection — maps a StateActionKind
 * back to its owning component / category. Duplicated here so this file
 * stays self-contained (the EventsSection registry isn't exported). When
 * a kind appears in multiple categories, the FIRST match wins (matches
 * EventsSection's first-found-wins behavior in actionCategoryOf).
 */
const ACTION_TO_COMPONENT: Record<string, string> = {
  // CharacterMovement
  CMJump: "CharacterMovement", CMDash: "CharacterMovement", CMStopDash: "CharacterMovement",
  CMStopWallSlide: "CharacterMovement", CMStopMovement: "CharacterMovement",
  CMResetJumps: "CharacterMovement", CMFallThrough: "CharacterMovement",
  CMIgnoreInput: "CharacterMovement", CMSimulateControl: "CharacterMovement",
  CMSetDefaultControls: "CharacterMovement",
  CMSetMaxSpeed: "CharacterMovement", CMSetAcceleration: "CharacterMovement",
  CMSetDeceleration: "CharacterMovement", CMSetGravity: "CharacterMovement",
  CMSetGravityAngle: "CharacterMovement", CMSetMaxFallSpeed: "CharacterMovement",
  CMSetJumpStrength: "CharacterMovement", CMSetMultiJump: "CharacterMovement",
  CMSetJumpSustain: "CharacterMovement", CMSetCeilingMode: "CharacterMovement",
  CMSetDoubleJump: "CharacterMovement", CMSetMirror: "CharacterMovement",
  SetFacing: "CharacterMovement",
  CMSet: "CharacterMovement", SetVelocityX: "CharacterMovement", SetVelocityY: "CharacterMovement",
  MoveTo: "CharacterMovement", MoveStop: "CharacterMovement",
  // TopdownMovement
  TMSet: "TopdownMovement", TMStop: "TopdownMovement",
  TMIgnoreInput: "TopdownMovement", TMSimulateControl: "TopdownMovement",
  // SpriteRenderer
  PlayAnimation: "SpriteRenderer", StopAnimation: "SpriteRenderer",
  SetFrame: "SpriteRenderer", SetAnimationSpeed: "SpriteRenderer",
  SetSprite: "SpriteRenderer",
  SetColor: "SpriteRenderer", SetSize: "SpriteRenderer",
  // WeaponSlot
  EquipWeapon: "WeaponSlot", PlayWeaponAnimation: "WeaponSlot",
  // Sprite Object (placement) — its own component theme, distinct from
  // SpriteRenderer (which is the BP-attached overlay behavior). Same
  // family conceptually; different node-graph chip color so authors
  // can visually tell which target type each action affects.
  SetPlacementVisible: "SpriteObject", SetPlacementFrame: "SpriteObject",
  PlayPlacementAnim: "SpriteObject", StopPlacementAnim: "SpriteObject",
  SetPlacementPos: "SpriteObject", CreateSpriteObject: "SpriteObject",
  DestroySpriteObject: "SpriteObject",
  SetPlacementScale: "SpriteObject", SetPlacementRotation: "SpriteObject",
  SetPlacementAlpha: "SpriteObject",
  SetSpriteObjectColliderEnabled: "SpriteObject",
  SetSpriteObjectSolid: "SpriteObject",
  SetSpriteObjectCollideMode: "SpriteObject",
  AddSpriteObjectTag: "SpriteObject", RemoveSpriteObjectTag: "SpriteObject",
  ClearSpriteObjectTags: "SpriteObject",
  AddSpriteObjectCollideTag: "SpriteObject",
  RemoveSpriteObjectCollideTag: "SpriteObject",
  ClearSpriteObjectCollideTags: "SpriteObject",
  SetRecipeEnabled: "Recipe", AddRecipeIngredient: "Recipe",
  RemoveRecipeIngredient: "Recipe", SetRecipeOutput: "Recipe",
  // CharacterAnimator (the state machine) — these set/enable animator STATES,
  // which is a different system from the SpriteRenderer that draws frames.
  SetStatePriority: "StateMachine", SetStateEnabled: "StateMachine",
  SetActiveStateMachine: "StateMachine",
  // Animator (keyframe offset/scale/opacity tracks) — its own behavior.
  PlayAnimatorAnim: "SmartTween", StopAnimatorAnim: "SmartTween",
  // Camera
  ScrollToObject: "Camera", ScrollToPosition: "Camera", SetLayoutScale: "Camera",
  CameraSetTarget: "Camera", CameraSetTargetSelf: "Camera", CameraStopFollow: "Camera",
  CameraShake: "Camera", CameraStopShake: "Camera",
  CameraSetSmoothing: "Camera", CameraSetOffset: "Camera", CameraSetZoom: "Camera",
  CameraSetFollowAxes: "Camera",
  CameraFlash: "Camera", CameraFade: "Camera",
  CameraLock: "Camera", CameraUnlock: "Camera",
  CameraPanTo: "Camera", CameraPanToTag: "Camera",
  BlurScene: "Camera", SetScreenEffect: "Camera", SetAmbientLight: "Camera",
  // Tracer
  TracerGetResult: "Tracer",
  TracerSet: "Tracer",
  // Text
  SetText: "Text", AppendText: "Text", SetFontFamily: "Text", SetFontSize: "Text",
  SetTextColor: "Text", SetBold: "Text", SetItalic: "Text",
  SetAlignH: "Text", SetAlignV: "Text", SetWrapWidth: "Text",
  SetTextVisible: "Text", ShowText: "Text", HideText: "Text",
  // Dismemberment
  Dismember: "Dismemberment",
  // Particles
  StartParticles: "Particles", StopParticles: "Particles", BurstParticles: "Particles",
  SetParticleRate: "Particles", SetParticleSpeed: "Particles",
  SetParticleGravity: "Particles", SetParticleSprite: "Particles",
  // UI
  SetUIText: "UI", SetUIValue: "UI", SetUISelectedValue: "UI",
  SetUIVisible: "UI", SetUIBgColor: "UI", SetUIElement: "UI",
  CreateUIWidget: "UI", DestroyUIWidget: "UI",
  // Dialogue
  PlayDialogue: "Dialogue", StopDialogue: "Dialogue",
  InteractWithNPC: "Dialogue",
  // Audio
  PlayMusic: "Audio", StopMusic: "Audio",
  PlaySound: "Audio", PlaySounds: "Audio", StopSound: "Audio", StopAllSounds: "Audio",
  SetMusicVolume: "Audio", SetSfxVolume: "Audio", SetMasterVolume: "Audio",
  // Tween
  Tween: "Tween", TweenSetEndValue: "Tween",
  TweenStop: "Tween", TweenStopAll: "Tween",
  TweenPause: "Tween", TweenPauseAll: "Tween",
  TweenResume: "Tween", TweenResumeAll: "Tween",
  TweenVar: "Tween", TweenParam: "Tween",
  // SquashStretch
  PlaySquashStretch: "SquashStretch",
  // Variables
  SetVar: "Variables", AddVar: "Variables", SubVar: "Variables", RandomNumber: "Variables",
  SetBool: "Variables", ToggleBool: "Variables", SetVarOn: "Variables",
  // Signals
  EmitSignal: "Signals", EmitSignalTo: "Signals",
  // Transform
  SetPosition: "Transform", SetPositionX: "Transform", SetPositionY: "Transform",
  SetAngle: "Transform", SetScale: "Transform", SetScaleX: "Transform", SetScaleY: "Transform",
  SetOpacity: "Transform", SetVisible: "Transform", MoveToLayer: "Transform", SetZOrder: "Transform",
  // Time
  Wait: "Time", WaitRealtime: "Time", WaitForSignal: "Time", SetTimeScale: "Time",
  HitStop: "Time",
  SetPaused: "Time",
  // Scene
  GoToLayout: "Scene", RestartLayout: "Scene", GoToNextLayout: "Scene",
  RecreateInitialObjects: "Scene",
  GoToLayoutWithLoad: "Scene", SetLoadingProgress: "Scene", SetLoadingScene: "Scene",
  // Save/Load
  SaveSlot: "SaveLoad", LoadSlot: "SaveLoad",
  // Spawning
  CreateObject: "Spawning", CreateObjectByName: "Spawning", DropObject: "Spawning",
  Destroy: "Spawning", SortZOrder: "Spawning",
  // Identity — set instance name / edit per-instance tag list at runtime.
  // Shared theme with Behavior since they mutate per-instance metadata.
  SetInstanceName: "Behavior", EditTags: "Behavior",
  // Behavior
  SetBehaviorParam: "Behavior", SetBehaviorEnabled: "Behavior",
  SetEventGroupEnabled: "Behavior", SetGroupActive: "Flow",
  // Inventory
  GiveItem: "Inventory", TakeItem: "Inventory", BuyItem: "Inventory", SellItem: "Inventory",
  AddItem: "Inventory", RemoveItem: "Inventory", ClearInventory: "Inventory",
  GiveItemTo: "Inventory", GetItemCount: "Inventory", GetItemProp: "Inventory",
  // Mouse
  SetCursor: "Mouse", ResetCursor: "Mouse", HideCursor: "Mouse", ShowCursor: "Mouse",
  // Debug
  Log: "Debug", PrintString: "Debug", DebugPrint: "Debug",
  // System
  QuitGame: "System",
  SetGlobal: "System", AddGlobal: "System", SubGlobal: "System", GlobalArrayOp: "System", RestockShop: "System", ResetWorld: "System",
  // Flow
  StopLoop: "Flow",
  // Tilemap (Tier 1: read / mutate primitives)
  SetTile: "Tilemap", RemoveTile: "Tilemap",
  SetTileAtWorld: "Tilemap", RemoveTileAtWorld: "Tilemap",
  FillTileRect: "Tilemap", ReplaceTile: "Tilemap",
  RemoveTilesInTracer: "Tilemap", FillTilesInTracer: "Tilemap",
  PlaceBigTile: "Tilemap", PlaceBigTileAtWorld: "Tilemap", PlaceAnimatedTileAtWorld: "Tilemap",
  RemoveBigTileAtWorld: "Tilemap", RemoveBigTileAt: "Tilemap",
  DamageTile: "Tilemap", DamageTileAtWorld: "Tilemap",
  MineTileAtWorld: "Tilemap", RestoreTileHP: "Tilemap",
  PlayTileAnimation: "Tilemap", PlayTileAnimationAtWorld: "Tilemap",
  StopTileAnimation: "Tilemap", StopTileAnimationAtWorld: "Tilemap",
  PlayAllTileAnimations: "Tilemap", StopAllTileAnimations: "Tilemap",
  RemoveAnimatedTileAt: "Tilemap",
  // MoveTo behavior — surfaces as its own setter actions on the MoveTo
  // dropdown, but maps to CharacterMovement theme so it groups with the
  // other movement primitives in the palette.
  MoveToSetPosition: "MoveTo", MoveToSetObject: "MoveTo",
  MoveToSetTag: "MoveTo", MoveToSetAngle: "MoveTo",
  MoveToStop: "MoveTo", MoveToResume: "MoveTo",
  MoveToSetSpeed: "MoveTo", MoveToNavPoint: "MoveTo", PatrolNavPoints: "MoveTo",
  // Projectile spawning + SmartTween stopper that were Flow-themed before.
  FireProjectile: "Spawning",
  StopAllAnimatorAnims: "SmartTween",
  // Curated PALETTE entries (LogicGraphCanvas.tsx :2983-3130) — these
  // are author-facing aliases not in StateActionKind, so the old
  // typed Partial map skipped them and they fell back to Flow gray.
  // Surface them with their owning component's color so search hits
  // are visually identifiable instead of a wall of gray. (audit HIGH #14)
  ApplyDamage: "Damageable", Heal: "Damageable",
  IncrementVar: "Variables", ToggleVar: "Variables",
  DebounceWait: "Time", WaitForAnim: "Time", WaitForKeyPress: "Time",
  SetAIState: "AIBrain", SetAITarget: "AIBrain", AlertNearbyAllies: "AIBrain",
  Literal: "Variables", VarRead: "Variables",
  GetTracerField: "Tracer", GetSlotItem: "Inventory",
  GetListValue: "System", GetGlobalValue: "System",
  GetDistance: "System",
  GetOtherObject: "Collider",
  GetOverlappingObject: "Collider",
  GetPicked: "Collider",
  RandomPick: "Variables", RandomRange: "Variables",
};

/** Same idea for conditions — best-effort mapping of common condition
 *  kinds to their owning component. Unknown kinds fall back to "Flow". */
const CONDITION_TO_COMPONENT: Record<string, string> = {
  // CharacterMovement state checks
  IsGrounded: "CharacterMovement", IsJumping: "CharacterMovement", IsFalling: "CharacterMovement",
  IsAirborne: "CharacterMovement",
  IsDashing: "CharacterMovement", IsWallSliding: "CharacterMovement",
  IsByWall: "CharacterMovement", IsByWallLeft: "CharacterMovement", IsByWallRight: "CharacterMovement",
  CanJump: "CharacterMovement", CanDash: "CharacterMovement",
  IsDoubleJumpEnabled: "CharacterMovement", IsWallJumping: "CharacterMovement",
  JustTurnedLeft: "CharacterMovement", JustTurnedRight: "CharacterMovement",
  JustWallJumped: "CharacterMovement",
  InputBuffered: "CharacterMovement",
  CompareCMParam: "CharacterMovement",
  CompareTMParam: "TopdownMovement", IsMovingDir: "TopdownMovement",
  IsTopdownFacing: "TopdownMovement",
  IsMoving: "CharacterMovement", IsMovingAny: "CharacterMovement",
  IsMovingLeft: "CharacterMovement", IsMovingRight: "CharacterMovement",
  IsMovingUp: "CharacterMovement", IsMovingDown: "CharacterMovement",
  IsFacingLeft: "CharacterMovement", IsFacingRight: "CharacterMovement",
  IsRunning: "CharacterMovement",
  // SpriteRenderer — raw frame playback / current frame.
  IsAnimationPlaying: "SpriteRenderer", CompareFrame: "SpriteRenderer",
  // CharacterAnimator — state-machine queries.
  IsState: "StateMachine", IsStateEnabled: "StateMachine",
  PreviousStateWas: "StateMachine", PreviousAnimWas: "StateMachine",
  IsAnimatorAnimPlaying: "SmartTween",
  // Behavior
  IsBehaviorEnabled: "Behavior",
  // Text
  CompareText: "Text", IsTextVisible: "Text",
  // Camera
  IsCameraShaking: "Camera", IsCameraPanning: "Camera",
  IsCameraLocked: "Camera", CompareCameraZoom: "Camera",
  // Tracer
  IsTracerHit: "Tracer", TracerHitHasTag: "Tracer",
  // Tween
  IsTweenPlaying: "Tween", IsTweenPaused: "Tween", IsAnyTweenPlaying: "Tween",
  // Particles
  IsEmittingParticles: "Particles", IsParticleEmitterEnabled: "Particles",
  CompareParticleCount: "Particles",
  // Audio
  IsMusicPlaying: "Audio", IsSoundPlaying: "Audio",
  // Time
  IsPaused: "Time",
  // Signals
  IsSignalFiring: "Signals", SignalFiredEdge: "Signals",
  // Collider edges
  JustCollidedWithTag: "Collider", JustSeparatedFromTag: "Collider",
  // Tag queries on the subject itself.
  HasTag: "Behavior", HasAnyTag: "Behavior", HasAllTags: "Behavior",
  // Loading-system polling condition.
  IsLoading: "Scene", IsScene: "Scene",
  // Sprite Object trigger conditions — same component family as the
  // Sprite Object action set so they share the picker category.
  OnCollideWithSpriteObject: "SpriteObject", OnOverlapWithSpriteObject: "SpriteObject",
  OnSpriteObjectCreate: "SpriteObject", OnSpriteObjectDestroy: "SpriteObject",
  HasSpriteObjectTag: "SpriteObject",
  // Damageable
  IsDead: "Damageable", IsInHitstun: "Damageable", IsInIframes: "Damageable",
  // Inventory
  HasItem: "Inventory", InventoryIsFull: "Inventory",
  // AI Brain
  HasAITarget: "AIBrain", NoAITarget: "AIBrain",
  // Triggers under signals
  // Time
  EveryXSeconds: "Time", CompareTime: "Time",
  // Variables / Flow
  Compare: "Variables", CompareValues: "Variables", IsBoolean: "Variables", IsBetween: "Variables",
  // Mouse
  IsMouseButtonHeld: "Mouse", IsCursorOverObject: "Mouse",
  OnObjectHovered: "Mouse", OnObjectUnhovered: "Mouse", GetHoveredObject: "Mouse",
  // Picking — keep under Flow since they aren't component-tied
  // Tilemap conditions
  CompareTileAt: "Tilemap", CompareTileAtWorld: "Tilemap",
  IsTileSolidAt: "Tilemap", IsTileEmptyAt: "Tilemap",
  OnTileDestroyed: "Tilemap",
  OnTileDamaged: "Tilemap",
  OnTileDrop: "Tilemap",
  GetLastTile: "Tilemap",
  GetLastDrop: "Tilemap",
  GetTaggedTile: "Tilemap",
  GetNavPoint: "MoveTo",
  // MoveTo behavior queries — match the MoveTo* actions' theme.
  IsMovingTo: "MoveTo", HasArrived: "MoveTo", OnArrived: "MoveTo", OnNavFailed: "MoveTo",
  OnPointArrived: "MoveTo", OnAnyPointArrived: "MoveTo", GetLastNavPoint: "MoveTo",
  // Input — IsActionHeld is the only non-trigger input condition.
  IsActionHeld: "Trigger",
  InputCombo: "Trigger",
  // Curated PALETTE conditions (LogicGraphCanvas.tsx :3092-3107) — same
  // story as the curated actions above: these author-facing aliases
  // weren't in CONDITION_TO_COMPONENT, so search hits rendered as
  // gray Flow. (audit HIGH #14)
  VarEquals: "Variables", VarAbove: "Variables", VarBelow: "Variables",
  VarTrue: "Variables", VarFalse: "Variables",
  IsOverlappingTag: "Collider",
  IsDialoguePlaying: "Dialogue",
  IsAIState: "AIBrain", IsTargetSighted: "AIBrain", DistanceToTargetBelow: "AIBrain",
};

/** Look up the component theme for an action node by its `type` string. */
export function actionComponent(kind: string): ComponentTheme {
  const compName = ACTION_TO_COMPONENT[kind as StateActionKind];
  return COMPONENT_THEME[compName ?? "Flow"] ?? COMPONENT_THEME.Flow;
}

/** Look up the component theme for a condition node by its `type` string. */
export function conditionComponent(kind: string): ComponentTheme {
  const compName = CONDITION_TO_COMPONENT[kind as ConditionKind];
  return COMPONENT_THEME[compName ?? "Flow"] ?? COMPONENT_THEME.Flow;
}

/** Theme for a generic node when kind doesn't matter (Branch, Comment, etc.). */
export function flowTheme(): ComponentTheme {
  return COMPONENT_THEME.Flow;
}

/** Trigger nodes share the Trigger theme regardless of which subsystem they
 *  monitor — authors orient on "this is where the chain starts" first. */
export function triggerTheme(): ComponentTheme {
  return COMPONENT_THEME.Trigger;
}

/**
 * Humanize a CamelCase / PascalCase action / condition kind into a label.
 * Used as the fallback display name when a registry entry doesn't have a
 * custom label. e.g. `CameraSetTarget` → "Camera Set Target".
 */
// Display-name overrides for kinds whose auto-humanized label would still say
// "Animator" (the keyframe component was renamed to "Smart Tween").
export const LABEL_OVERRIDES: Record<string, string> = {
  // Authors think "components", not "behaviors" (the inspector calls them
  // components). Node KINDS stay SetBehaviorParam/SetBehaviorEnabled so saved
  // graphs + runtime don't break.
  SetBehaviorParam: "Set Component Parameter",
  SetBehaviorEnabled: "Enable / Disable Component",
  TweenVar: "Tween Variable (smooth)",
  TweenParam: "Tween Component Param (smooth)",
  // `OnSeparate` is the overlap-END edge (fires when two bodies stop
  // overlapping). Authors look for "end overlap", so label it that way — the
  // node TYPE stays "OnSeparate" so saved graphs + the runtime signal don't break.
  OnSeparate: "On End Overlap",
  PlayAnimatorAnim: "Play Smart Tween",
  StopAnimatorAnim: "Stop Smart Tween",
  StopAllAnimatorAnims: "Stop All Smart Tweens",
  IsAnimatorAnimPlaying: "Smart Tween playing?",
  // "Layout" is internal; authors think in Scenes. Relabel the node titles
  // (the action KINDS stay GoToLayout/etc. so saved projects don't break).
  GoToLayout: "Go To Scene",
  GoToNextLayout: "Go To Next Scene",
  RestartLayout: "Restart Scene",
  SetLayoutScale: "Set Scene Scale",
  // Mine vs Damage are semantic siblings — same runtime path, differ only
  // in param NAME (power vs amount). Disambiguate in the picker so the
  // author can see at a glance which one they're picking. Mine is the
  // canonical mining-flavored variant.
  MineTileAtWorld: "Mine Tile (Power)",
  DamageTileAtWorld: "Damage Tile (Amount)",
  // Cell/world variant pairs need similar disambiguation — easy to confuse
  // when both surface in the picker under the same auto-generated label.
  SetTile: "Set Tile (cell c,r)",
  SetTileAtWorld: "Set Tile (world x,y)",
  RemoveTile: "Remove Tile (cell c,r)",
  RemoveTileAtWorld: "Remove Tile (world x,y)",
  PlaceBigTile: "Place BigTile (cell c,r)",
  PlaceBigTileAtWorld: "Place BigTile (world x,y)",
  PlaceAnimatedTileAtWorld: "Place Animated Tile (world x,y)",
  RemoveBigTileAt: "Remove BigTile (cell c,r)",
  RemoveBigTileAtWorld: "Remove BigTile (world x,y)",
  PlayTileAnimation: "Play Tile Animation (cell c,r)",
  PlayTileAnimationAtWorld: "Play Tile Animation (world x,y)",
  StopTileAnimation: "Stop Tile Animation (cell c,r)",
  StopTileAnimationAtWorld: "Stop Tile Animation (world x,y)",
  // Sprite Object family — kinds keep the internal "Placement" prefix for
  // back-compat with saved graphs, but every UI surface (picker, node
  // chip title, search label) shows "Sprite Object". Without these
  // entries the auto-generator humanized them to "Set Placement Scale"
  // etc. and node chips for previously-saved nodes did the same.
  SetPlacementVisible: "Set Sprite Object Visible",
  SetPlacementFrame: "Set Sprite Object Frame",
  PlayPlacementAnim: "Play Sprite Object Animation",
  StopPlacementAnim: "Stop Sprite Object Animation",
  SetPlacementPos: "Set Sprite Object Position",
  SetPlacementScale: "Set Sprite Object Scale",
  SetPlacementRotation: "Set Sprite Object Rotation",
  SetPlacementAlpha: "Set Sprite Object Alpha",
  AddSpriteObjectCollideTag: "Add Sprite Object Collider Tag",
  RemoveSpriteObjectCollideTag: "Remove Sprite Object Collider Tag",
  ClearSpriteObjectCollideTags: "Clear Sprite Object Collider Tags",
  SetSpriteObjectCollideMode: "Set Sprite Object Collider Mode",
  EquipWeapon: "Equip Weapon",
  PlayWeaponAnimation: "Play Weapon Animation",
};

export function humanizeKind(kind: string): string {
  if (LABEL_OVERRIDES[kind]) return LABEL_OVERRIDES[kind];
  return kind
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}
