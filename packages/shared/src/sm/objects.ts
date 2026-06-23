/**
 * Construct-3-style object-first picker model.
 *
 * Every event-sheet condition / action carries an optional `subject` —
 * the OBJECT it operates on. The condition picker shows objects first
 * (System / Mouse / Keyboard / World / each BP / each UI Widget); after
 * the user picks an object, the available conditions/actions are filtered
 * to those valid for that subject kind.
 *
 * At runtime, conditions with `subject: bp:<id>` filter / pick instances
 * of that blueprint; actions with `subject: bp:<id>` run against the
 * picked instance bound by an earlier condition in the same chain.
 *
 * `subject` is OPTIONAL — legacy data without a subject behaves exactly
 * as before:
 *   - On a BP/widget sheet: implicit "self" (the sheet's host sprite).
 *   - On the Main Sheet: implicit "system" (no sprite redirect).
 *
 * Source of truth for the kind→subject mapping is the matrix in the
 * approved plan at C:/Users/sabap/.claude/plans/magical-kindling-zebra.md.
 * Per the matrix:
 *   - NO CROSS_CUTTING_* lists. Every kind is explicitly assigned per subject.
 *   - Camera kinds appear ONLY under bp:<CameraBP> (gated by hasCamera).
 *     They are NOT in SYSTEM_*_KINDS — Camera is a dedicated BP class now.
 *   - Logic / time / loops / picking → System only.
 *   - Per-instance compare (Compare / CompareValues / IsBetween / IsBoolean)
 *     → System (free both sides), World (write to globals), BP (LEFT-locked).
 *   - Modifiers (Else / TriggerOnceWhileTrue) → System AND BP.
 *   - Signals (OnSignal / IsSignalFiring) → System AND BP.
 *   - Wait / Log / PrintString → System; Log/PrintString also BP per plan.
 */

import type { ConditionKind } from "./condition";
import type { StateActionKind } from "./action";

export type SubjectKind =
  /** Host sprite of the sheet — implicit on BP/widget sheets. */
  | "self"
  /** Global / scene-wide rules — Compare, EveryXSeconds, OnSignal, GoToLayout, …
   *  Also covers Main Sheet globals: SetVar/AddVar with no subject on the
   *  Main Sheet writes to the world host (= globals). To compare globals,
   *  System CompareValues with `var:World.<name>` on either side works. */
  | "system"
  /** Mouse / cursor inputs and cursor-shape actions. */
  | "mouse"
  /** Keyboard inputs. */
  | "keyboard"
  /** A specific blueprint by id — instances form the SOL. */
  | "bp"
  /** A specific UI widget by id. */
  | "uiwidget";

export interface Subject {
  kind: SubjectKind;
  /** Required when kind === "bp" or "uiwidget". */
  bpId?: string;
  /** Optional — narrows the SOL to ONE specific instance by its
   *  `instanceName`. Set in the Inspector on a placement; a BP's first
   *  instance with this name (across all scenes) becomes the only
   *  picked sprite. Empty / undefined = match all instances of bpId
   *  (today's behavior). Used for Construct's "Pick by unique name"
   *  pattern when the author needs to address one specific placement. */
  instanceName?: string;
}

/* ─── CONDITIONS ───────────────────────────────────────────────────── */

/**
 * System-only conditions. No sprite redirect — these are scene-wide
 * events / pure logic / loops / pickers / scene lifecycle.
 *
 * Camera state checks are NOT here — Camera is its own BP class, see
 * BP_CONDITION_KINDS gated by hasCamera.
 */
export const SYSTEM_CONDITION_KINDS: ConditionKind[] = [
  // Pure logic / comparison (System "Compare two values" — free both sides)
  "Compare",
  "CompareValues",
  "IsBetween",
  "IsBoolean",
  // Modifiers
  "Else",
  "TriggerOnceWhileTrue",
  // Time
  "Always",
  "OnStep",
  "EveryXSeconds",
  "CompareTime",
  // Loops
  "ForEach",
  "Repeat",
  "While",
  // Signals (scene-wide bus)
  "OnSignal",
  "IsSignalFiring",
  // Scene lifecycle
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
  // Picking (filters the SOL)
  "PickByComparison",
  "PickAll",
  "PickRandom",
  "PickByHighest",
  "PickByLowest",
  "PickNth",
  // Spawn-existence query
  "ObjectUIDExists",
  // Pause state
  "IsPaused",
  // Tilemap
  "CompareTileAt",
  "CompareTileAtWorld",
  "IsTileSolidAt",
  "IsTileEmptyAt",
  "OnTileDestroyed",
  "OnTileDamaged",
];

/**
 * Mouse-input conditions. Includes object-clicks (which ALSO appear
 * under BP — see BP_CONDITION_KINDS — for "this BP was clicked" reads).
 */
export const MOUSE_CONDITION_KINDS: ConditionKind[] = [
  "OnMouseButtonPressed",
  "OnMouseButtonReleased",
  "OnMouseClick",
  "OnMouseDoubleClick",
  "OnMouseWheel",
  "IsMouseButtonHeld",
  "OnObjectClicked",
  "OnObjectDoubleClicked",
  "IsCursorOverObject",
];

export const KEYBOARD_CONDITION_KINDS: ConditionKind[] = [
  "OnKeyPressed",
  "OnKeyReleased",
  "OnKeyHeld",
  "IsActionHeld",
];

/**
 * Conditions valid against a specific blueprint subject. Some are gated
 * by behaviors (hasCM / hasSR / hasText / hasTracer / hasCamera) at
 * picker time. Others apply to any BP regardless of behaviors.
 *
 * Camera kinds are HERE (not in SYSTEM) — they only surface for BPs
 * carrying the Camera behavior, i.e. the dedicated Camera BP class.
 */
export const BP_CONDITION_KINDS: ConditionKind[] = [
  // Per-instance compare — Construct's "Compare instance variable" lives here.
  "Compare",
  "CompareValues",
  "IsBetween",
  "IsBoolean",
  // Modifiers (work in any chain)
  "Else",
  "TriggerOnceWhileTrue",
  // Per-instance time
  "EveryXSeconds",
  // Per-instance signals
  "OnSignal",
  "IsSignalFiring",
  // Lifecycle
  "OnCreate",
  "OnDestroyed",
  // Collision / overlap (subject = listener; tag/BP param picks the other)
  "OnCollide",
  "OnOverlap",
  // Object-clicks pick this BP's instance under cursor
  "OnObjectClicked",
  "OnObjectDoubleClicked",
  "IsCursorOverObject",
  // CharacterMovement triggers + state (gated hasCM)
  "OnLand", "OnJump", "OnFall", "OnDashStart", "OnDashEnd",
  "OnMoved", "OnStopped",
  "IsGrounded", "IsByWall", "IsByWallLeft", "IsByWallRight",
  "IsMoving", "IsMovingLeft", "IsMovingRight", "IsMovingUp", "IsMovingDown",
  "IsMovingTo", "HasArrived",
  "IsFacingLeft", "IsFacingRight",
  "IsRunning", "IsJumping", "IsFalling", "IsDashing", "IsWallSliding",
  "CanJump", "CanDash", "IsDoubleJumpEnabled",
  "IsWallJumping",
  "JustTurnedLeft", "JustTurnedRight", "JustWallJumped",
  "InputBuffered",
  "CompareCMParam",
  // TopdownMovement
  "CompareTMParam", "IsMovingDir", "IsTopdownFacing",
  // SpriteRenderer / animations (gated hasSR)
  "OnAnimationEnd",
  "OnAnyAnimationEnd",
  "IsAnimationPlaying",
  "IsAnimatorAnimPlaying",
  "CompareFrame",
  "IsState", "IsStateEnabled",
  "PreviousStateWas", "PreviousAnimWas",
  // Collider edges (state-check variants of OnCollide/OnOverlap)
  "JustCollidedWithTag", "JustSeparatedFromTag",
  "HasTag", "HasAnyTag", "HasAllTags",
  // Signals
  "SignalFiredEdge",
  // Damageable (any BP can have one)
  "IsDead", "IsInHitstun", "IsInIframes",
  // Inventory (gated hasInventory)
  "HasItem", "InventoryIsFull",
  // AI Brain (any BP can have one)
  "HasAITarget", "NoAITarget",
  // Text behavior (gated hasText)
  "CompareText",
  "IsTextVisible",
  // Dialogue (scene singleton — not behavior-gated)
  "IsDialoguePlaying",
  // Tracer (gated hasTracer)
  "IsTracerHit",
  "TracerHitHasTag",
  "TracerJustHit",
  // Tween — any BP can have tweens
  "OnTweenStart",
  "OnTweenFinish",
  "IsTweenPlaying",
  "IsTweenPaused",
  "IsAnyTweenPlaying",
  // Camera (gated hasCamera — only Camera BP has the behavior)
  "OnCameraPanEnd",
  "IsCameraShaking",
  "IsCameraPanning",
  "IsCameraLocked",
  "CompareCameraZoom",
  // ParticleEmitter (gated hasParticles)
  "IsEmittingParticles",
  "IsParticleEmitterEnabled",
  "OnParticleBurstEnd",
  "CompareParticleCount",
  // Audio (global)
  "IsMusicPlaying",
  "IsSoundPlaying",
  // Behavior-toggle check
  "IsBehaviorEnabled",
  // Tilemap reads — authors who can DAMAGE tiles from a BP sheet (tile
  // actions are already in BP_ACTION_KINDS) should also be able to GATE
  // on tile state from the same sheet. Without these in the BP allow-list,
  // a BP's "if tile under feet is solid → ..." pattern wasn't reachable.
  "CompareTileAt",
  "CompareTileAtWorld",
  "IsTileSolidAt",
  "IsTileEmptyAt",
  "OnTileDestroyed",
  "OnTileDamaged",
];

/* ─── ACTIONS ──────────────────────────────────────────────────────── */

/**
 * System-only actions — scene-wide stuff. No per-instance equivalent.
 *
 * Per plan: SetVar/AddVar/etc. ARE here (Construct's "Set value" sets
 * a global; on Main Sheet that means write to world host's vars).
 *
 * Camera actions are NOT here — Camera is its own BP class, see
 * BP_ACTION_KINDS gated by hasCamera.
 */
export const SYSTEM_ACTION_KINDS: StateActionKind[] = [
  // Time / flow control
  "Wait",
  "WaitRealtime",
  "WaitForSignal",
  "SetTimeScale",
  "HitStop",
  "SetPaused",
  "StopLoop",
  // Signals (scene-wide)
  "EmitSignal",
  "EmitSignalTo",
  "SetVarOn",
  // Persistent global state (cross-scene + save/load)
  "SetGlobal",
  "AddGlobal",
  "SubGlobal",
  "GlobalArrayOp",
  "RestockShop",
  "ResetWorld",
  // Inventory count globals (global:<item>)
  "GiveItem",
  "TakeItem",
  "BuyItem",
  "SellItem",
  // Debug
  "Log",
  "PrintString",
  // Logic var actions (write to host's vars — globals on Main Sheet)
  "SetVar",
  "AddVar",
  "SubVar",
  "RandomNumber",
  "SetBool",
  "ToggleBool",
  "SetEventGroupEnabled",
  "SetGroupActive",
  // Scene transitions
  "GoToLayout",
  "GoToLayoutWithLoad",
  "SetLoadingProgress",
  "SetLoadingScene",
  "SetPlacementVisible",
  "SetPlacementFrame",
  "PlayPlacementAnim",
  "StopPlacementAnim",
  "SetPlacementPos",
  "CreateSpriteObject",
  "DestroySpriteObject",
  "SetPlacementScale",
  "SetPlacementRotation",
  "SetPlacementAlpha",
  "SetRecipeEnabled",
  "AddRecipeIngredient",
  "RemoveRecipeIngredient",
  "SetRecipeOutput",
  "SetSpriteObjectColliderEnabled",
  "SetSpriteObjectSolid",
  "SetSpriteObjectCollideMode",
  "AddSpriteObjectTag",
  "RemoveSpriteObjectTag",
  "ClearSpriteObjectTags",
  "AddSpriteObjectCollideTag",
  "RemoveSpriteObjectCollideTag",
  "ClearSpriteObjectCollideTags",
  "RestartLayout",
  "GoToNextLayout",
  "RecreateInitialObjects",
  // Save / load
  "SaveSlot",
  "LoadSlot",
  // Spawning
  "CreateObject",
  "CreateObjectByName",
  "FireProjectile",
  "MoveToSetPosition",
  "MoveToSetObject",
  "MoveToSetTag",
  "MoveToSetAngle",
  "MoveToStop",
  "MoveToResume",
  "MoveToSetSpeed",
  "MoveToNavPoint",
  "PatrolNavPoints",
  "SortZOrder",
  // Dialogue
  "PlayDialogue",
  "StopDialogue",
  // Audio (global — music + sfx, played from any subject's chain)
  "PlayMusic",
  "StopMusic",
  "PlaySound",
  "PlaySounds",
  "StopSound",
  "StopAllSounds",
  "SetMusicVolume",
  "SetSfxVolume",
  "SetMasterVolume",
  // UI lifecycle (the per-instance UI ops live under uiwidget subject)
  "CreateUIWidget",
  "DestroyUIWidget",
  // App
  "QuitGame",
  // Screen post-FX (world / main camera; UI stays crisp)
  "SetScreenEffect",
  // Tilemap (Tier 1 read/write — tilemap is named by parameter, runs from any subject)
  "SetTile",
  "RemoveTile",
  "SetTileAtWorld",
  "RemoveTileAtWorld",
  "FillTileRect",
  "ReplaceTile",
  "RemoveTilesInTracer",
  "FillTilesInTracer",
  "PlaceBigTile",
  "RemoveBigTileAtWorld",
  "RemoveBigTileAt",
  "DamageTile",
  "DamageTileAtWorld",
  "MineTileAtWorld",
  "RestoreTileHP",
  "PlayTileAnimation",
  "PlayTileAnimationAtWorld",
  "StopTileAnimation",
  "StopTileAnimationAtWorld",
  "PlayAllTileAnimations",
  "StopAllTileAnimations",
  "RemoveAnimatedTileAt",
];

export const MOUSE_ACTION_KINDS: StateActionKind[] = [
  "SetCursor",
  "ResetCursor",
  "HideCursor",
  "ShowCursor",
];

/**
 * Actions that operate on a specific BP instance. Some are gated by
 * behaviors (hasCM / hasSR / hasText / hasTracer / hasCamera / hasSquash)
 * at picker time. Others apply to any BP.
 *
 * Camera actions are HERE (not in SYSTEM) — they only surface for BPs
 * carrying the Camera behavior, i.e. the dedicated Camera BP class.
 *
 * Per plan: Log / PrintString also live here (BP-context output is
 * auto-prefixed with the actor identifier).
 */
export const BP_ACTION_KINDS: StateActionKind[] = [
  // Debug — System AND BP per plan
  "Log",
  "PrintString",
  // Per-instance identity
  "SetInstanceName",
  "EditTags",
  // Debug
  "DebugPrint",
  // Per-instance vars
  "SetVar",
  "AddVar",
  "SubVar",
  "RandomNumber",
  "SetBool",
  "ToggleBool",
  // Per-instance behavior toggle
  "SetBehaviorParam",
  "SetBehaviorEnabled",
  "SetEventGroupEnabled",
  "SetGroupActive",
  // Inventory — count globals (any BP; bumps global:<item>)
  "GiveItem",
  "TakeItem",
  "BuyItem",
  "SellItem",
  // Inventory (gated hasInventory)
  "AddItem",
  "RemoveItem",
  "ClearInventory",
  "GiveItemTo",
  "GetItemCount",
  "GetItemProp",
  // Combat — operate on the target's Damageable component
  "ApplyDamage",
  "Heal",
  // Lifecycle
  "Destroy",
  // Persistent global state
  "SetGlobal",
  "AddGlobal",
  "SubGlobal",
  "GlobalArrayOp",
  "RestockShop",
  "ResetWorld",
  // Transform (per-instance)
  "SetPosition",
  "SetPositionX",
  "SetPositionY",
  "SetAngle",
  "SetScale",
  "SetScaleX",
  "SetScaleY",
  "SetOpacity",
  "MoveToLayer",
  "SetZOrder",
  // Velocity (CharacterMovement / arcade body)
  "SetVelocityX",
  "SetVelocityY",
  "MoveTo",
  "MoveStop",
  // CharacterMovement actions (gated hasCM)
  "CMJump", "CMDash", "CMStopDash", "CMStopWallSlide", "CMStopMovement",
  "CMResetJumps", "CMFallThrough", "CMIgnoreInput", "CMSimulateControl",
  "CMSetDefaultControls",
  "CMSetMaxSpeed", "CMSetAcceleration", "CMSetDeceleration",
  "CMSetGravity", "CMSetGravityAngle", "CMSetMaxFallSpeed",
  "CMSetJumpStrength", "CMSetMultiJump", "CMSetJumpSustain",
  "CMSetCeilingMode", "CMSetDoubleJump", "CMSetMirror",
  "CMSet",
  // TopdownMovement actions
  "TMSet", "TMStop", "TMIgnoreInput", "TMSimulateControl",
  "SetFacing",
  // SpriteRenderer (gated hasSR)
  "PlayAnimation",
  "StopAnimation",
  "SetFrame",
  "SetAnimationSpeed",
  "SetSprite",
  "SetStatePriority",
  "SetStateEnabled",
  "SetActiveStateMachine",
  "SetColor",
  "SetSize",
  // WeaponSlot (gated hasWeaponSlot)
  "EquipWeapon",
  "PlayWeaponAnimation",
  // SquashStretch (gated hasSquash)
  "PlaySquashStretch",
  // Dismemberment (gated hasDismemberment)
  "Dismember",
  // ParticleEmitter (gated hasParticles)
  "StartParticles",
  "StopParticles",
  "BurstParticles",
  "SetParticleRate",
  "SetParticleSpeed",
  "SetParticleGravity",
  "SetParticleSprite",
  // Text (gated hasText)
  "SetText", "AppendText", "SetFontFamily", "SetFontSize", "SetTextColor",
  "SetBold", "SetItalic", "SetAlignH", "SetAlignV", "SetWrapWidth",
  "SetTextVisible", "ShowText", "HideText",
  // Animator
  "PlayAnimatorAnim", "StopAnimatorAnim", "StopAllAnimatorAnims",
  // Dialog Flow bridge
  "InteractWithNPC",
  // Tracer (gated hasTracer)
  "TracerGetResult",
  "TracerSet",
  // Tween — any BP can have tweens
  "Tween",
  "TweenSetEndValue",
  "TweenStop",
  "TweenStopAll",
  "TweenPause",
  "TweenPauseAll",
  "TweenResume",
  "TweenResumeAll",
  // Camera (gated hasCamera — only Camera BP has the behavior)
  "ScrollToObject",
  "ScrollToPosition",
  "SetLayoutScale",
  "CameraSetTarget",
  "CameraSetTargetSelf",
  "CameraStopFollow",
  "CameraShake",
  "CameraStopShake",
  "CameraSetSmoothing",
  "CameraSetOffset",
  "CameraSetZoom",
  "CameraSetFollowAxes",
  "CameraFlash",
  "CameraFade",
  "CameraLock",
  "CameraUnlock",
  "CameraPanTo",
  "CameraPanToTag",
  "BlurScene",
  // Tilemap (tilemap parameter chooses the target; available on every BP)
  "SetTile",
  "RemoveTile",
  "SetTileAtWorld",
  "RemoveTileAtWorld",
  "FillTileRect",
  "ReplaceTile",
  "RemoveTilesInTracer",
  "FillTilesInTracer",
  "PlaceBigTile",
  "RemoveBigTileAtWorld",
  "RemoveBigTileAt",
  "DamageTile",
  "DamageTileAtWorld",
  "MineTileAtWorld",
  "RestoreTileHP",
  "PlayTileAnimation",
  "PlayTileAnimationAtWorld",
  "StopTileAnimation",
  "StopTileAnimationAtWorld",
  "PlayAllTileAnimations",
  "StopAllTileAnimations",
  "RemoveAnimatedTileAt",
];

/** UI-widget-specific actions. Combined with UIWIDGET_UNIVERSAL_ACTION_KINDS
 *  to form the full set returned by `actionKindsForSubject("uiwidget")`. */
export const UIWIDGET_ACTION_KINDS: StateActionKind[] = [
  "SetUIText",
  "SetUIValue",
  "SetUISelectedValue",
  "SetUIVisible",
  "SetUIBgColor",
  "SetUIElement",
];

/** Universal actions that DO make sense on a UI widget — flow control,
 *  variables, signals, lifecycle, debug. Excludes everything tied to
 *  physics body / sprite renderer / character movement / animations /
 *  tracer / squash / tween — UI widgets carry none of those. */
const UIWIDGET_UNIVERSAL_ACTION_KINDS: StateActionKind[] = [
  "Wait", "WaitRealtime", "WaitForSignal",
  "EmitSignal", "EmitSignalTo", "SetVarOn",
  "SetVar", "AddVar", "SubVar", "RandomNumber", "SetBool", "ToggleBool",
  "Destroy",
  "Log", "PrintString",
  "SetEventGroupEnabled",
  "SetGroupActive",
  // A pause-menu button needs to resume / toggle pause from a widget sheet.
  "SetPaused",
];

/** Conditions valid on a UI widget — Logic / Time / Signals / cursor-on-widget
 *  / mouse-clicked-widget / lifecycle. Excludes movement state, animation,
 *  tracer, tween, camera, collide / overlap (no physics body on widgets). */
const UIWIDGET_CONDITION_KINDS: ConditionKind[] = [
  "Always", "Else", "TriggerOnceWhileTrue",
  "Compare", "CompareValues", "CompareTime", "IsBetween", "IsBoolean",
  "While", "Repeat",
  "EveryXSeconds",
  "OnCreate",
  "OnDestroyed",
  "OnSignal", "IsSignalFiring",
  "OnObjectClicked", "OnObjectDoubleClicked", "IsCursorOverObject",
  "IsPaused",
];

/** Returns the conditions valid for the given subject kind. */
export function conditionKindsForSubject(kind: SubjectKind): ConditionKind[] {
  switch (kind) {
    case "system":   return SYSTEM_CONDITION_KINDS;
    case "mouse":    return MOUSE_CONDITION_KINDS;
    case "keyboard": return KEYBOARD_CONDITION_KINDS;
    case "bp":       return BP_CONDITION_KINDS;
    case "uiwidget": return UIWIDGET_CONDITION_KINDS;
    case "self":     return BP_CONDITION_KINDS; // self resolves to host BP
  }
}

/** Returns the actions valid for the given subject kind. */
export function actionKindsForSubject(kind: SubjectKind): StateActionKind[] {
  switch (kind) {
    case "system":   return SYSTEM_ACTION_KINDS;
    case "mouse":    return MOUSE_ACTION_KINDS;
    case "keyboard": return []; // keyboard has no actions
    case "bp":       return BP_ACTION_KINDS;
    case "uiwidget": return [...UIWIDGET_ACTION_KINDS, ...UIWIDGET_UNIVERSAL_ACTION_KINDS];
    case "self":     return BP_ACTION_KINDS;
  }
}
