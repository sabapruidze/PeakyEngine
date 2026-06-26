/**
 * Preset actions for the v2 events-only authoring model.
 *
 * Each event block holds an ordered list of actions, executed top-to-bottom
 * each time the event's trigger fires (and its guards pass). `Wait` defers
 * subsequent actions in the same chain via the per-event action queue.
 */

export type StateActionKind =
  | "SetColor"
  | "Log"
  | "PrintString"
  | "SetVelocityX"
  | "SetVelocityY"
  | "MoveTo"                   // fire-once: fly to a captured point at constant speed, then stop
  | "MoveStop"                 // cancel an in-flight MoveTo and halt
  | "EmitSignal"
  | "SetSize"
  | "SetVar"
  | "AddVar"
  | "SubVar"
  | "RandomNumber"
  | "SetBool"
  | "ToggleBool"
  | "Destroy"
  | "Wait"
  | "WaitRealtime"
  | "WaitForSignal"
  | "SetTimeScale"
  | "HitStop"                 // brief impact freeze: timeScale→0 for N ms, auto-resumes (wall-clock)
  | "ApplyDamage"             // deal `amount` damage to the subject's Damageable (0 hp → death + OnDeath)
  | "Heal"                    // restore `amount` HP to the subject's Damageable (clamped to maxHp)
  | "SetPaused"               // pause / resume / toggle the whole scene or one layer (widgets stay live)
  | "PlayAnimation"
  | "StopAnimation"
  | "SetFrame"
  | "SetAnimationSpeed"
  | "SetSprite"               // swap the SpriteRenderer to a different sprite asset at runtime
  | "SetStatePriority"
  | "SetStateEnabled"
  | "SetActiveStateMachine"   // switch which named State Machine drives the host (exclusive)
  // ── Dismemberment (Dismemberment behavior) ─────────────────────────
  | "Dismember"               // slice the host's current frame into physics gib chunks
  // ── Particle emitter (ParticleEmitter behavior) ────────────────────
  | "StartParticles"          // resume continuous emission (or arm burst mode)
  | "StopParticles"            // stop emitting; existing particles finish their lifetime
  | "BurstParticles"           // explode N particles in one shot
  | "SetParticleRate"          // live-tune emission rate (per/sec)
  | "SetParticleSpeed"         // live-tune base speed + jitter
  | "SetParticleGravity"       // live-tune gravity X/Y
  | "SetParticleSprite"        // swap particle texture mid-emit (sprite asset id)
  | "SetBehaviorParam"
  | "SetBehaviorEnabled"
  | "SetEventGroupEnabled"
  | "SetGroupActive"
  // General — spawning + Z order
  | "CreateObject"
  | "CreateObjectByName"
  | "FireProjectile"
  | "SetInstanceName"
  | "EditTags"
  | "DebugPrint"
  | "MoveToSetPosition"
  | "MoveToSetObject"
  | "MoveToSetTag"
  | "MoveToSetAngle"
  | "MoveToStop"
  | "MoveToResume"
  | "MoveToSetSpeed"
  | "MoveToNavPoint"
  | "PatrolNavPoints"
  | "SortZOrder"
  // Flow control
  | "StopLoop"
  // Scenes / Layouts
  | "GoToLayout"
  | "GoToLayoutWithLoad"
  | "SetLoadingProgress"
  | "SetLoadingScene"
  | "SetPlacementVisible"
  | "SetPlacementFrame"
  | "PlayPlacementAnim"
  | "StopPlacementAnim"
  | "SetPlacementPos"
  | "CreateSpriteObject"
  | "DestroySpriteObject"
  | "SetPlacementScale"
  | "SetPlacementRotation"
  | "SetPlacementAlpha"
  | "SetRecipeEnabled"
  | "AddRecipeIngredient"
  | "RemoveRecipeIngredient"
  | "SetRecipeOutput"
  | "SetSpriteObjectColliderEnabled"
  | "SetSpriteObjectSolid"
  | "SetSpriteObjectCollideMode"
  | "AddSpriteObjectTag"
  | "RemoveSpriteObjectTag"
  | "ClearSpriteObjectTags"
  | "AddSpriteObjectCollideTag"
  | "RemoveSpriteObjectCollideTag"
  | "ClearSpriteObjectCollideTags"
  | "RestartLayout"
  | "GoToNextLayout"
  | "RecreateInitialObjects"
  // Camera / Scroll
  | "ScrollToObject"
  | "ScrollToPosition"
  | "SetLayoutScale"
  // Save / Load
  | "SaveSlot"
  | "LoadSlot"
  // CharacterMovement — explicit triggers + comprehensive parameter control
  | "CMJump"
  | "CMDash"
  | "CMStopDash"
  | "CMStopWallSlide"
  | "CMStopMovement"
  | "CMSet"
  | "CMResetJumps"
  | "CMIgnoreInput"
  | "CMSimulateControl"
  | "CMFallThrough"
  | "CMSetDefaultControls"
  // Explicit CharacterMovement setters — each is a thin alias around CMSet but
  // surfaces in the picker for discoverability. CMSet still works as a typed
  // catch-all for any param.
  | "CMSetMaxSpeed"
  | "CMSetAcceleration"
  | "CMSetDeceleration"
  | "CMSetGravity"
  | "CMSetGravityAngle"
  | "CMSetMaxFallSpeed"
  | "CMSetJumpStrength"
  | "CMSetMultiJump"
  | "CMSetJumpSustain"     // toggle (on/off)
  | "CMSetCeilingMode"     // stop / preserve momentum
  | "CMSetDoubleJump"      // toggle multiJump > 1
  | "CMSetMirror"          // off / velocity / input — auto-flip sprite
  // TopdownMovement — 8-dir / no-gravity controller (parallel to CM* above)
  | "TMSet"                // set any TM param (dropdown) + value
  | "TMStop"               // zero velocity immediately
  | "TMIgnoreInput"        // lock / unlock player input (momentum coasts)
  | "TMSimulateControl"    // push a movement direction (up/down/left/right) this tick
  | "SetFacing"            // manual sprite mirror: left / right / flip
  // Text behavior
  | "SetText"
  | "AppendText"
  | "SetFontFamily"
  | "SetFontSize"
  | "SetTextColor"
  | "SetBold"
  | "SetItalic"
  | "SetAlignH"
  | "SetAlignV"
  | "SetWrapWidth"
  | "SetTextVisible"
  | "ShowText"
  | "HideText"
  | "PlayAnimatorAnim"
  | "StopAnimatorAnim"
  | "StopAllAnimatorAnims"
  | "InteractWithNPC"
  // Camera behavior
  | "CameraSetTarget"        // follow tag, OR (with subject:bp) follow the picked sprite
  | "CameraSetTargetSelf"    // back to following the host BP
  | "CameraStopFollow"       // free camera (still pannable)
  | "CameraShake"            // {duration, intensity}
  | "CameraStopShake"
  | "CameraSetSmoothing"     // {value}
  | "CameraSetOffset"        // {x, y}
  | "CameraSetZoom"          // {zoom}
  | "CameraSetFollowAxes"    // {followX, followY}
  | "CameraFlash"            // {duration, color}
  | "CameraFade"             // {duration, color, fadeOut}
  | "CameraLock"             // freeze for cutscene
  | "CameraUnlock"           // resume follow
  | "CameraPanTo"            // smooth pan to (x, y) over duration
  | "CameraPanToTag"         // smooth pan to first sprite carrying tag
  // Tracer behavior
  | "TracerGetResult"        // copy a tracer hit field into a BP variable
  // Cross-object communication
  | "EmitSignalTo"           // send a signal to other sprites by tag/uid (they react via OnSignal)
  | "SetVarOn"               // set a variable on other sprites by tag/uid
  | "SetGlobal"              // set a global var (persists across scenes + save/load) — read via global:name
  | "AddGlobal"              // add a delta to a numeric global var (negative = subtract)
  | "SubGlobal"              // subtract a delta from a numeric global var (sugar for AddGlobal with negative)
  | "GlobalArrayOp"          // modify a global ARRAY (push / set / removeAt / clear) — read via global:name.<i>
  | "RestockShop"            // refill a Shop widget's per-slot stock to its configured amounts
  | "ResetWorld"             // clear all persistent state (removed objects + globals) — new game
  // Transform — instant set
  | "SetPosition"            // set both X and Y on the running sprite
  | "SetPositionX"           // set X only
  | "SetPositionY"           // set Y only
  // Transform — animated (Phaser tweens) — each tween carries a `tag`
  // so events can pause / stop / wait-for it independently of others.
  | "Tween"                  // tween a property (position.x/y, scale, alpha, angle, …) to a value
  | "TweenSetEndValue"       // change a running tween's target value mid-flight
  | "TweenStop"              // cancel a tween by tag
  | "TweenStopAll"           // cancel every tween on this sprite
  | "TweenPause"             // pause a tween by tag (resumable later)
  | "TweenPauseAll"          // pause every tween on this sprite
  | "TweenResume"            // resume a paused tween by tag
  | "TweenResumeAll"         // resume every paused tween on this sprite
  // Dialogue
  | "PlayDialogue"           // play a project DialogueAsset by id
  | "StopDialogue"           // cancel the running dialogue (if any)
  // ── Audio ───────────────────────────────────────────────────────────
  | "PlayMusic"              // play a Music sound asset (loops, single track, replaces current)
  | "StopMusic"              // stop the current music track (optional fade)
  | "PlaySound"              // play a SFX sound asset (one-shot, overlaps)
  | "PlaySounds"             // play from a list: random pick / queue / all, with random volume+pitch
  | "StopSound"              // stop a named SFX (all its instances)
  | "StopAllSounds"          // stop music + every SFX
  | "SetMusicVolume"         // set the music bus volume (0..1)
  | "SetSfxVolume"           // set the SFX bus volume (0..1)
  | "SetMasterVolume"        // set the master volume (0..1, scales both buses)
  // Squash & stretch
  | "PlaySquashStretch"      // trigger the cartoon-style squash/stretch wobble on this sprite
  // ── UI Widget actions ───────────────────────────────────────────────
  // Each action targets a UI widget (or a child inside a Multi widget)
  // BY NAME. Empty target = self. Non-empty name resolves against
  // sprite.instanceName (multi-mode child names / per-instance labels)
  // or sprite.blueprintName (the widget's own name) — same convention
  // used by `var:Player.hp` cross-BP resolution.
  | "SetUIText"              // set a Label / Button / Dropdown's `text`
  | "SetUIValue"             // set a Slider / ProgressBar's `value`
  | "SetUISelectedValue"     // set a Dropdown's `selectedValue`
  | "SetUIVisible"           // show / hide (or toggle) a whole UI widget
  | "SetUIBgColor"           // change a widget's bg color (hex)
  | "SetUIElement"           // set one element's params (each param toggled on individually)
  | "CreateUIWidget"         // spawn a UI widget instance at runtime
  | "DestroyUIWidget"        // destroy UI widgets matching a name
  // ── Inventory — count globals (the player's bag = global:<item>) ─────
  | "GiveItem"               // add N of an item to the player's count global (global:<item>)
  | "TakeItem"               // remove N of an item from the player's count global
  // ── Shop transactions (item buy/sell prices + a money global) ────────
  | "BuyItem"                // pay buy price from a money global, give the item
  | "SellItem"               // take the item, pay sell price into a money global
  // ── Inventory (Inventory behavior) ──────────────────────────────────
  | "AddItem"                // add N of an item (by name) to the host's Inventory
  | "RemoveItem"             // remove N of an item from the host's Inventory
  | "ClearInventory"         // empty the host's Inventory
  | "GiveItemTo"             // add N of an item to ANOTHER sprite's Inventory (by tag/name)
  | "GetItemCount"           // write the count of an item into a number variable
  | "GetItemProp"            // write a custom item property into a variable
  | "QuitGame"               // close the game (browser: tries window.close(), emits OnGameQuit)
  | "BlurScene"              // toggle / set blur on the main camera (UI cam stays crisp)
  | "SetScreenEffect"        // grayscale / VHS / chromatic post-FX on the world (main cam)
  // ── Universal transform actions ─────────────────────────────────────
  // Apply to ANY sprite (BPs and UI widgets alike). Self-targeted.
  | "SetAngle"               // set rotation in degrees
  | "SetScale"               // set uniform scale (both X and Y)
  | "SetScaleX"              // horizontal scale only
  | "SetScaleY"              // vertical scale only
  | "SetOpacity"             // alpha 0..1
  | "MoveToLayer"            // move sprite to a different render layer (by name)
  | "SetZOrder"              // set z-depth within the current layer (higher = on top)
  // ── Mouse cursor ──────────────────────────────────────────────────────
  | "SetCursor"              // change cursor to a CSS style (default, pointer, crosshair, none, etc.)
  | "ResetCursor"            // back to default
  | "HideCursor"             // alias: SetCursor "none"
  | "ShowCursor"             // alias: SetCursor "default"
  // ── Tilemap (Tier 1: read / mutate) ──────────────────────────────────
  | "SetTile"                // set tile index at cell (c, r) on a named layer
  | "RemoveTile"             // clear tile at cell (c, r) → empty
  | "SetTileAtWorld"         // same as SetTile but resolves cell from world x/y
  | "RemoveTileAtWorld"      // same as RemoveTile but world x/y
  | "FillTileRect"           // fill a rect (c0..c1, r0..r1) with one tile index
  | "ReplaceTile"            // whole-layer find/replace one tile index for another
  | "RemoveTilesInTracer"    // clear every tile whose center sits inside a named tracer's box
  | "FillTilesInTracer"      // fill every tile whose center sits inside a named tracer's box
  // ── BigTile (Tier 3: composite multi-cell props like trees / rocks) ─
  | "PlaceBigTile"           // stamp a BigTile by id at cell (c, r) anchor
  | "RemoveBigTileAtWorld"   // remove the BigTile covering world (x, y)
  | "RemoveBigTileAt"        // remove the BigTile covering cell (c, r)
  | "TracerSet"              // set any tracer parameter at runtime (CMSet for Tracer)
  // ── Tier 2: mining / damage / drops ─────────────────────────────────
  | "DamageTile"             // subtract HP from a cell at (c, r); destroy + drops at 0
  | "DamageTileAtWorld"      // same but resolves cell from world (x, y)
  | "MineTileAtWorld"        // power-vs-hardness alias; same destroy + drops flow
  | "RestoreTileHP"          // reset HP for one cell back to its max hardness
  // ── Animated tile control (cycling placements) ──────────────────────
  | "PlayTileAnimation"      // start one animated-tile placement at (c, r); restart + loop overrides
  | "PlayTileAnimationAtWorld"  // same but resolves cell from world (x, y) — like MineTileAtWorld
  | "StopTileAnimation"      // freeze one animated-tile placement at (c, r)
  | "StopTileAnimationAtWorld"  // same but resolves cell from world (x, y)
  | "PlayAllTileAnimations"  // bulk play — optionally filtered to one animated-tile id
  | "StopAllTileAnimations"  // bulk stop — optionally filtered to one animated-tile id
  | "RemoveAnimatedTileAt"  // remove one animated-tile placement at (c, r) — explicit no-drops removal
  // ── Weapon slot ─────────────────────────────────────────────────────
  | "EquipWeapon"            // swap a WeaponSlot's spriteId at runtime; empty = unequip
  | "PlayWeaponAnimation";   // play an anim on a WeaponSlot, resetting frame/timer

export interface StateAction {
  id: string;
  kind: StateActionKind;
  config: Record<string, unknown>;
  /**
   * Construct-3-style object subject — what the action operates on.
   * Set by the picker when the user picks an object before choosing the
   * action kind. At runtime, actions with `subject: bp:<id>` resolve to
   * the SOL bound by an earlier picking condition in the same chain
   * (or the first live instance of that BP if nothing was picked).
   *
   * Optional — legacy data without a subject defaults to:
   *   - "self"   on BP/widget event sheets (host sprite, today's behavior).
   *   - "system" on the Main Sheet (no sprite redirect).
   */
  subject?: import("./objects").Subject;
}

export const ACTION_KINDS: StateActionKind[] = [
  "PlayAnimation",
  "SetSprite",
  "StopAnimation",
  "SetFrame",
  "SetAnimationSpeed",
  "SetStatePriority",
  "SetStateEnabled",
  "SetActiveStateMachine",
  "Dismember",
  "StartParticles",
  "StopParticles",
  "BurstParticles",
  "SetParticleRate",
  "SetParticleSpeed",
  "SetParticleGravity",
  "SetParticleSprite",
  "Wait",
  "WaitRealtime",
  "WaitForSignal",
  "SetVar",
  "AddVar",
  "SubVar",
  "RandomNumber",
  "SetBool",
  "ToggleBool",
  "SetTimeScale",
  "HitStop",
  "ApplyDamage",
  "Heal",
  "SetPaused",
  "SetColor",
  "SetSize",
  "SetVelocityX",
  "SetVelocityY",
  "MoveTo",
  "MoveStop",
  "EmitSignal",
  "Destroy",
  "PrintString",
  "Log",
  "SetBehaviorParam",
  "SetBehaviorEnabled",
  "SetEventGroupEnabled",
  "SetGroupActive",
  "CreateObject",
  "CreateObjectByName",
  "FireProjectile",
  "SetInstanceName",
  "EditTags",
  "DebugPrint",
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
  "StopLoop",
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
  "ScrollToObject",
  "ScrollToPosition",
  "SetLayoutScale",
  "SaveSlot",
  "LoadSlot",
  "CMJump",
  "CMDash",
  "CMStopDash",
  "CMStopWallSlide",
  "CMStopMovement",
  "CMSet",
  "CMResetJumps",
  "CMIgnoreInput",
  "CMSimulateControl",
  "CMFallThrough",
  "CMSetDefaultControls",
  "CMSetMaxSpeed",
  "CMSetAcceleration",
  "CMSetDeceleration",
  "CMSetGravity",
  "CMSetGravityAngle",
  "CMSetMaxFallSpeed",
  "CMSetJumpStrength",
  "CMSetMultiJump",
  "CMSetJumpSustain",
  "CMSetCeilingMode",
  "CMSetDoubleJump",
  "CMSetMirror",
  "TMSet",
  "TMStop",
  "TMIgnoreInput",
  "TMSimulateControl",
  "SetFacing",
  "SetText",
  "AppendText",
  "SetFontFamily",
  "SetFontSize",
  "SetTextColor",
  "SetBold",
  "SetItalic",
  "SetAlignH",
  "SetAlignV",
  "SetWrapWidth",
  "SetTextVisible",
  "ShowText",
  "HideText",
  "PlayAnimatorAnim",
  "StopAnimatorAnim",
  "StopAllAnimatorAnims",
  "InteractWithNPC",
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
  "TracerGetResult",
  "EmitSignalTo",
  "SetVarOn",
  "SetGlobal",
  "AddGlobal",
  "SubGlobal",
  "GlobalArrayOp",
  "RestockShop",
  "ResetWorld",
  "SetPosition",
  "SetPositionX",
  "SetPositionY",
  "Tween",
  "TweenSetEndValue",
  "TweenStop",
  "TweenStopAll",
  "TweenPause",
  "TweenPauseAll",
  "TweenResume",
  "TweenResumeAll",
  "PlayDialogue",
  "StopDialogue",
  "PlayMusic",
  "StopMusic",
  "PlaySound",
  "PlaySounds",
  "StopSound",
  "StopAllSounds",
  "SetMusicVolume",
  "SetSfxVolume",
  "SetMasterVolume",
  "PlaySquashStretch",
  "SetUIText",
  "SetUIValue",
  "SetUISelectedValue",
  "SetUIVisible",
  "SetUIBgColor",
  "SetUIElement",
  "CreateUIWidget",
  "DestroyUIWidget",
  "GiveItem",
  "TakeItem",
  "BuyItem",
  "SellItem",
  "AddItem",
  "RemoveItem",
  "ClearInventory",
  "GiveItemTo",
  "GetItemCount",
  "GetItemProp",
  "QuitGame",
  "BlurScene",
  "SetScreenEffect",
  "SetAngle",
  "SetScale",
  "SetScaleX",
  "SetScaleY",
  "SetOpacity",
  "MoveToLayer",
  "SetZOrder",
  "SetCursor",
  "ResetCursor",
  "HideCursor",
  "ShowCursor",
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
  "TracerSet",
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
  "EquipWeapon",
  "PlayWeaponAnimation",
];

export const ACTION_DESCRIPTIONS: Record<StateActionKind, string> = {
  PlayAnimation: "Play a named animation from the attached SpriteRenderer. 'from = beginning' force-restarts every call (use for re-trigger patterns like OnHit → Damage anim). 'from = current' resumes (smart): switch when the anim is different, leave alone when continuous, restart when finished and called again — matches the legacy 'IsFalling → PlayAnimation(Fall)' continuous-call pattern.",
  StopAnimation: "Pause the current animation on its current frame. Use PlayAnimation to resume / restart.",
  SetFrame: "Jump to a specific frame number in the current animation (0-indexed; matches the editor's frame strip labels).",
  SetAnimationSpeed: "Set the playback speed MULTIPLIER (1 = native fps from the anim, 2 = double speed, 0.5 = half). Affects only the host SpriteRenderer.",
  SetSprite: "Swap the host's SpriteRenderer to a DIFFERENT sprite asset at runtime (whole new sheet + animations). Optionally name an animation to play on the new sprite; empty plays its first. Use for skins, transformations, equipment swaps. To just switch animation within the current sprite, use Play Animation instead.",
  SetStatePriority: "Change the priority of a State Machine state at runtime by name. Higher priority wins when multiple states' conditions match. Use for rage / weakness / cutscene reordering. No-op if the state name doesn't exist on the host's State Machine.",
  SetStateEnabled: "Toggle an animator state on/off by name. Disabled states are skipped by the priority-sorted eval loop — they never win, never play. Use for iframe-windowed hurt suppression, locked-out abilities during cutscenes, etc.",
  SetActiveStateMachine: "Switch which named State Machine drives this object (exclusive — activating one deactivates the others). Use for boss phases: activate a different machine with its own moves/attacks on a phase change. Pick \"(none)\" to leave NO machine active (the animator stops driving and the sprite holds its last frame). No-op if the name isn't a machine on this object.",
  Dismember: "Slice the subject's CURRENT sprite frame into physics \"gib\" chunks (one per region defined on its Dismemberment component) and launch them flying. Requires a Dismemberment component on the subject; no-op (with a warning) otherwise. Fires once per object.",
  StartParticles: "Resume continuous emission (or arm a burst-mode emitter so subsequent BurstParticles calls run). Sets the emitter's enabled flag to true.",
  StopParticles: "Stop emitting. Existing particles finish their lifetime; no new ones spawn until StartParticles. Sets enabled=false.",
  BurstParticles: "Explode `count` particles in one shot, regardless of mode. No-op when the emitter is disabled.",
  SetParticleRate: "Live-tune the per-second emission rate (continuous mode). Maps to Phaser's frequency = 1000 / rate.",
  SetParticleSpeed: "Live-tune base initial speed (px/s). Existing particles keep their original speed; new ones use the updated value.",
  SetParticleGravity: "Live-tune per-particle gravity (px/s²). New particles inherit the new gravity at spawn; useful for wind effects.",
  SetParticleSprite: "Swap the particle texture mid-emit by Sprite asset id. Subsequent particles use the new sprite's first frame.",
  Wait: "Pause this event's action chain for N seconds (subsequent actions in this event run after the delay)",
  WaitRealtime: "Like Wait, but uses real wall-clock time — UNAFFECTED by timeScale. Use this to schedule an unpause: SetTimeScale 0 → WaitRealtime 0.5 → SetTimeScale 1 works, where plain Wait would freeze forever (Wait uses the scaled sim clock, which doesn't advance while paused).",
  SetVar: "Set a Blueprint variable to an exact value",
  AddVar: "Add a delta to a Blueprint variable (use negative to subtract — e.g. AddVar hp -10)",
  RandomNumber: "Write a random number between min and max into a variable. Float OFF = whole number (inclusive of both ends); Float ON = decimal. min/max accept expressions.",
  SetBool: "Set a boolean variable to true or false",
  ToggleBool: "Flip a boolean variable's value (true ↔ false)",
  SetTimeScale: "Set the scene's time scale — 1=normal, 0=paused, 0.5=slow-mo, 2=fast-forward.",
  HitStop: "Impact freeze for combat feel: snaps the whole scene's time scale to 0 (or a slow value) for `durationMs`, then resumes automatically (wall-clock, so it un-freezes itself even while paused). `delayMs` waits a few ms before freezing so the hit's reaction (e.g. the hurt animation) starts FIRST — otherwise the freeze stops the animator before it can enter the hurt state and the flinch is skipped. `affectPhysics` / `affectParticles` / `affectSmartTween` choose what freezes — turn one OFF to let e.g. hit particles or a white-flash SmartTween keep playing THROUGH the freeze. `blockUntilDone` makes the nodes AFTER this one wait until the freeze ends (otherwise they run instantly — HitStop is fire-and-forget by default). Drop it on a hit (OnTracerHit / OnDamageTaken).",
  ApplyDamage: "Deal `amount` damage to the subject's Damageable component. Respects i-frames, guard/block, and knockback. When HP hits 0 it triggers death (OnDeath + destroy per the Damageable's settings). Target whoever you want via the action's subject (self, a BP, picked sprites, tag). No Damageable on the target = no-op.",
  Heal: "Restore `amount` HP to the subject's Damageable, clamped to maxHp. Fires OnHealed. No-op if the target is dead or healing is disabled on its Damageable.",
  SetPaused: "Pause, resume, or toggle gameplay. scope=all freezes the whole scene; scope=layer freezes only one layer (by name). UI widgets are NEVER paused — their animations, logic, and input keep running so pause menus stay interactive. Frozen sprites hold position (physics + tweens pause) and resume exactly where they left off.",
  SetColor: "Set the sprite's fill color",
  SetSize: "Resize the sprite (width / height) — affects both visual and physics body",
  Log: "Write a message to the Output Log (and the browser console)",
  PrintString: "Show a message on screen for N seconds (UE5-style on-screen print)",
  SetVelocityX: "Set horizontal velocity (px/s)",
  SetVelocityY: "Set vertical velocity (px/s) — negative = up",
  MoveTo: "Fire once: the object flies to a point at a constant speed (px/s) and STOPS on its own — no gravity/friction needed, and it won't coast past. X and Y are captured WHEN it runs (so \"mouse.x / mouse.y\" goes to the click point, not the live cursor; \"var:Player.x / var:Player.y\" goes to the player's current spot). Re-fire to re-target a moving object. Stops within Stop Within (px); fires On Arrived. Needs gravity off.",
  MoveStop: "Cancel an in-flight Move To and halt the object immediately.",
  EmitSignal: "Emit a named signal on this sprite (other events can react via On Signal)",
  Destroy: "Destroy this sprite (removes from the scene). Use on death / pickup / etc. Tick \"Remember\" to keep it gone permanently — it won't respawn when you re-enter this scene (for pickups, chopped trees, opened chests).",
  SetGlobal: "Set a GLOBAL variable that persists across scenes and through save/load (money, day, counts, flags). Read it anywhere with the expression global:<name>.",
  AddGlobal: "Add a delta to a numeric GLOBAL variable (negative = subtract). Sugar for SetGlobal global:<name> + delta — preserves the existing global's value.",
  SubGlobal: "Subtract a delta from a numeric GLOBAL variable. Mirror of AddGlobal with the sign flipped.",
  GlobalArrayOp: "Modify a global ARRAY: push (append), set (overwrite an index), removeAt (delete an index), or clear (empty it). Read elements with global:<name>.<index> and the count with global:<name>.length.",
  RestockShop: "Refill a Shop widget's limited slots back to their configured stock amounts (e.g. on a new day). Leave the shop blank to restock every shop.",
  ResetWorld: "Clear all persistent state — removed objects come back and global variables reset. Use to start a new game.",
  SetBehaviorParam: "Write a parameter on a behavior (e.g. Platformer.speed)",
  SetBehaviorEnabled: "Turn a behavior on / off at runtime",
  SetEventGroupEnabled: "Enable or disable a named event group at runtime — disabled groups stop firing until re-enabled",
  SetGroupActive: "Activate or deactivate one of THIS object's Logic Sheet groups by name. A deactivated group's triggers stop firing until reactivated. Only affects this object's own groups.",
  SubVar: "Subtract a delta from a numeric variable (sugar over AddVar with negative).",
  WaitForSignal: "Pause the action chain until a named signal fires on this sprite. Resumes when the signal arrives or times out at 30 s (drops the rest of the chain on timeout). In Logic Sheets the param key is `signal`; in event-sheet legacy callers it's `name`.",
  CreateObject: "Spawn a new instance of a Blueprint at the given position. Optional layer + spawn vars seed the instance. Runs through the spawn budget (~50/frame) so a big OnSceneStart loop ramps in over several frames instead of freezing the browser.",
  CreateObjectByName: "Spawn a new instance by Blueprint NAME (string) — useful for data- or AI-driven content. Same position / layer / spawn-vars and spawn-budget path as CreateObject.",
  FireProjectile: "Spawn a Blueprint with a Projectile behavior and launch it. Aim modes: Manual angle (set degrees), Toward position (fire at world x/y), Toward target (snapshot angle to a sprite at fire time, then straight-line), Homing (continuously track the target). Target picked by uid OR by tag (nearest sprite carrying the tag wins).",
  SetInstanceName: "Set the runtime instance name of the subject sprite. Used by SaveSlot/LoadSlot matching, the debug console, and any `instance:<name>` lookups. Empty string clears the name.",
  EditTags: "Edit a Blueprint's runtime tags. Pick the Blueprint (object picker) + a mode: Insert adds a new tag (no-op if already present); Remove drops an existing tag picked from the chip list; Replace swaps an existing tag for a new one. The `tag` value supports expressions (e.g. var:newTagName). Applies to every live instance of the picked Blueprint.",
  DebugPrint: "Inline debug print container — dropped onto a Logic Sheet wire to log every time the chain crosses that point. Holds one or more compact print rows (message + color + duration). All rows fire at once when the chain hits the container. Each printed line auto-appends the Logic Sheet name + the previous node's kind, so a fan of debug prints across the graph is self-labeling. Prints to both the on-screen overlay AND the F12 console.",
  MoveToSetPosition: "Switch this sprite's MoveTo behavior to position mode and set a new world target (x, y). Optional speed override. MoveTo starts/continues chasing the new target on the next tick.",
  MoveToSetObject: "Switch this sprite's MoveTo behavior to object mode and chase the sprite with the given uid. Optional speed override.",
  MoveToSetTag: "Switch this sprite's MoveTo behavior to tag mode and chase the nearest sprite carrying the tag. Optional speed override.",
  MoveToSetAngle: "Switch this sprite's MoveTo behavior to angle mode (straight-line motion in the given direction, no destination). Optional speed override.",
  MoveToStop: "Disable this sprite's MoveTo behavior (clears velocity, stops chasing). Reversible via MoveToResume.",
  MoveToResume: "Re-enable a previously stopped MoveTo behavior.",
  MoveToSetSpeed: "Change MoveTo's speed without touching mode or target.",
  MoveToNavPoint: "Path-find (A*) across the scene's painted NAV MESH to the waypoint named/tagged X, walking AROUND obstacles. Needs a MoveTo component on this sprite + a nav mesh painted in the scene. Empty point = nearest waypoint of any tag.",
  PatrolNavPoints: "Endlessly patrol the nav waypoints carrying `tag`, A*-routing between them around obstacles. mode: loop (1→2→3→1), pingpong (1→2→3→2→1), or random. Needs a MoveTo component + painted waypoints. Re-issue or MoveTo Stop to end it.",
  SortZOrder: "Sort the scene's display list by Y so objects lower on screen render in front — standard top-down depth ordering. (For automatic per-frame sorting, the layer's Y-sort toggle is usually the better choice.)",
  StopLoop: "Break out of the surrounding loop (ForEach / Repeat / While) — sets a stop flag the loop runner checks each iteration and exits early.",
  GoToLayout: "Switch to another scene/layout by name. Drains OnSceneEnd on the current scene first, then transitions.",
  GoToLayoutWithLoad: "Switch to a layout VIA the project's loading scene. Engine auto-collects the target's assets, fires OnLoadProgress while loading, then OnLoadComplete. If minDisplaySec is set, the loading screen holds for at least that long.",
  SetLoadingProgress: "Manual progress update for the loading screen (0..1). Useful for layered progress (one bar for auto-load, another for warm-up Logic Sheet work).",
  SetLoadingScene: "Override which Scene is used as the loading screen for the NEXT GoToLayoutWithLoad. Empty name clears the override (falls back to the project's Settings → Loading Scene). Lets one project have multiple loaders — set 'boss_loader' before a boss transition, 'tutorial_loader' before a tutorial, etc.",
  SetPlacementVisible: "Show/hide every Sprite Object placement of the chosen sprite asset. Lighter than CreateObject + Destroy for things that toggle on/off (lights, doors, decorations).",
  SetPlacementFrame: "Jump every Sprite Object placement of the chosen sprite to a specific animation frame.",
  PlayPlacementAnim: "Start (or resume) the animation on every Sprite Object placement of the chosen sprite. `destroyOnFinish` plays it ONCE (no loop) and auto-destroys the placement when the animation ends — the clean way to fire-and-forget a one-shot VFX (spell hit, explosion) spawned via CreateSpriteObject.",
  StopPlacementAnim: "Pause the animation on every Sprite Object placement of the chosen sprite.",
  SetPlacementPos: "Move every Sprite Object placement of the chosen sprite to (x, y).",
  CreateSpriteObject: "Spawn a new Sprite Object placement at runtime using the chosen sprite asset. Lighter than CreateObject (no BP, no behaviors). `layer` picks a scene layer to render on (inherits its parallax + draws on top of that layer's Y-sorted sprites); leave empty to render above EVERYTHING (fire-and-forget FX).",
  DestroySpriteObject: "Destroy every Sprite Object placement of the chosen sprite asset. Fires OnSpriteObjectDestroy on every BP listening.",
  SetPlacementScale: "Set the scale (scaleX, scaleY) on every Sprite Object placement of the chosen sprite. Uniform scale = both equal.",
  SetPlacementRotation: "Set the rotation (degrees) on every Sprite Object placement of the chosen sprite.",
  SetPlacementAlpha: "Set the opacity (0..1) on every Sprite Object placement of the chosen sprite.",
  SetRecipeEnabled: "Enable or disable a recipe. Disabled recipes are skipped by the crafting system — useful for locked / quest-gated recipes you unlock at runtime.",
  AddRecipeIngredient: "Push an ingredient (itemId + qty) to a recipe's input list at runtime. Use to dynamically expand recipes (e.g., 'add a rare component once the player finds it').",
  RemoveRecipeIngredient: "Remove an ingredient by item id from a recipe's input list.",
  SetRecipeOutput: "Set a recipe's output (itemId + qty). Use to upgrade what a recipe produces (e.g., crafting tier-up).",
  SetSpriteObjectColliderEnabled: "Turn collider on/off for every placement of the chosen sprite. Useful for non-interactive vs interactive states (open vs closed door).",
  SetSpriteObjectSolid: "Toggle the Solid (Blocks Movement) flag for every placement of the chosen sprite. On = physical wall; Off = pass-through with overlap events.",
  SetSpriteObjectCollideMode: "Switch a placement's tag filter between 'include only these' and 'exclude these' mode at runtime.",
  AddSpriteObjectTag: "Add a tag to every placement of the chosen sprite. Tags drive the include/exclude collide filter and OnCollideWithSpriteObject routing.",
  RemoveSpriteObjectTag: "Remove a tag from every placement of the chosen sprite.",
  ClearSpriteObjectTags: "Remove ALL identity tags from every placement of the chosen sprite.",
  AddSpriteObjectCollideTag: "Add a tag to the COLLIDE FILTER list (separate from identity tags). Affects which OTHER sprites can collide with the placement based on its Collide Mode (include/exclude).",
  RemoveSpriteObjectCollideTag: "Remove a tag from the collide-filter list of every placement of the chosen sprite.",
  ClearSpriteObjectCollideTags: "Empty the collide-filter list. With Include mode → collides with every sprite. With Exclude mode → ignores nothing.",
  RestartLayout: "Reload the current scene from scratch.",
  GoToNextLayout: "Switch to the next scene in the project's scene list (wraps around to the first). Drains OnSceneEnd first.",
  RecreateInitialObjects: "Restart the scene from its initial placements — re-runs the scene's create() so every Blueprint placement is re-instantiated. Useful for checkpoint / retry.",
  ScrollToObject: "Make the camera follow a target sprite by tag.",
  ScrollToPosition: "Center the camera on the given X / Y world position.",
  SetLayoutScale: "Set the camera zoom — 1=normal, 2=2x zoom, 0.5=zoomed out.",
  SaveSlot: "Save the live scene state to a named slot (localStorage) — snapshots every sprite's position, velocity, vars and facing plus each behavior's serialize() payload (CharacterMovement, SpriteRenderer, Inventory, Damageable, …). UID is the match key on load.",
  LoadSlot: "Load saved state from a named slot — restores each sprite by UID from the snapshot SaveSlot wrote (transform, vars, and behavior payloads). No-op if the slot is empty.",
  CMJump: "Force a jump on CharacterMovement — emits OnJump and consumes a jump slot.",
  CMDash: "Force a dash on CharacterMovement — emits OnDashStart (respects cooldown).",
  CMStopDash: "Cancel an in-progress dash on CharacterMovement. Zeroes velocity, fires OnDashEnd, starts the dash cooldown. No-op if no dash is active.",
  CMStopWallSlide: "Cancel an in-progress wall-slide and suppress re-engagement for 0.2s. Forces IsWallSliding to false. Player must leave the wall before sliding again. Use for hit-stun, cutscenes, special-move cancels.",
  CMStopMovement: "Zero out velocity on CharacterMovement (instant stop).",
  CMSet: "Set any CharacterMovement parameter (maxSpeed, jumpStrength, gravity, dashCooldown, wallEnabled, …) at runtime.",
  CMResetJumps: "Re-arm CharacterMovement's jump slots — equivalent to landing for jump purposes.",
  CMIgnoreInput: "Toggle input suppression on CharacterMovement. Gravity / momentum still run; only input keys are ignored.",
  CMSimulateControl: "Programmatically press a CharacterMovement control (left / right / jump / dash) for one frame.",
  CMFallThrough: "If standing on a JumpThru platform, briefly disable jump-thru collision so the player drops through it.",
  CMSetDefaultControls: "Re-bind CharacterMovement's input action names to the engine defaults (MoveLeft / MoveRight / Jump / Dash).",
  CMSetMaxSpeed: "Set CharacterMovement.maxSpeed at runtime.",
  CMSetAcceleration: "Set CharacterMovement.acceleration at runtime.",
  CMSetDeceleration: "Set CharacterMovement.deceleration at runtime.",
  CMSetGravity: "Set CharacterMovement.gravity (magnitude) at runtime.",
  CMSetGravityAngle: "Set CharacterMovement.gravityAngle in degrees (0=right, 90=down, 180=left, 270=up).",
  CMSetMaxFallSpeed: "Set CharacterMovement.maxFallSpeed at runtime.",
  CMSetJumpStrength: "Set CharacterMovement.jumpStrength at runtime.",
  CMSetMultiJump: "Set CharacterMovement.multiJump (number of jump slots — 1=single, 2=double, …).",
  CMSetJumpSustain: "Toggle jump sustain (hold-to-rise).",
  CMSetCeilingMode: "Switch ceiling collision: 'stop' (zero vy) vs 'preserve' (keep upward momentum).",
  CMSetDoubleJump: "Convenience toggle: enable double-jump (multiJump=2) or disable (multiJump=1).",
  CMSetMirror: "Set how CharacterMovement auto-flips the sprite to face direction: off / velocity / input.",
  TMSet: "Set any TopdownMovement parameter (maxSpeed, acceleration, deceleration, mirrorMode, …) to a value — pick the parameter from the dropdown.",
  TMStop: "Zero out velocity on TopdownMovement (instant stop).",
  TMIgnoreInput: "Toggle input suppression on TopdownMovement. Momentum still coasts; only the direction keys are ignored. Use for cutscene / dialogue lockouts.",
  TMSimulateControl: "Programmatically push a TopdownMovement direction (up / down / left / right) for one frame — for scripted or AI-driven movement. Run every tick to keep moving.",
  SetFacing: "Manually face left / right / flip the sprite. Use when auto-mirror (AIBrain.autoFaceTarget or CharacterMovement.mirrorMode) is off and you want full control over facing direction.",
  SetText: "Replace the Text behavior's content. Supports {var} interpolation tokens.",
  AppendText: "Append to the Text behavior's current content.",
  SetFontFamily: "Change the Text behavior's font family (e.g. 'Arial', 'Courier New').",
  SetFontSize: "Change the Text behavior's font size in pixels.",
  SetTextColor: "Change the Text behavior's color (number 0xRRGGBB or '#RRGGBB' string).",
  SetBold: "Toggle bold on the Text behavior (1=on, 0=off).",
  SetItalic: "Toggle italic on the Text behavior (1=on, 0=off).",
  SetAlignH: "Set the Text behavior's horizontal alignment: left / center / right.",
  SetAlignV: "Set the Text behavior's vertical alignment: top / middle / bottom.",
  SetWrapWidth: "Set the Text behavior's word-wrap width in pixels (0 = no wrap).",
  SetTextVisible: "Set the Text behavior's visibility (1=show, 0=hide).",
  ShowText: "Show the Text behavior (visible=1).",
  HideText: "Hide the Text behavior (visible=0).",
  PlayAnimatorAnim: "Play a named animation on the host's Smart Tween component. Drives keyframed offset / scale / opacity / rotation on the animation's target component. When `override` is on (default), every call restarts the animation from frame 0; turn it off to leave the in-progress playback alone (useful when the trigger fires repeatedly and you want one-shots to finish cleanly).",
  StopAnimatorAnim: "Stop a named animation on the host's Smart Tween. Buffer contributions clear on the next tick.",
  StopAllAnimatorAnims: "Stop every animation on the host's Smart Tween component.",
  InteractWithNPC: "Fire OnInteract triggers on the Dialog Flow for the NPC with the given sprite UID. Bridges your interaction-detection layer (tracer hits, proximity checks, etc.) to declarative Dialog Flow triggers — wire `OnKeyPressed Interact + TracerJustHit InteractionChecker → InteractWithNPC { uid: tracer:InteractionChecker.actorUid }`.",
  CameraSetTarget: "Tell the Camera behavior who to follow. With no subject (or System subject) follows the first sprite carrying the tag. With subject = a specific BP / UI Widget, follows the picked instance directly (Construct's 'Set position to <Sprite>' pattern).",
  CameraSetTargetSelf: "Tell the Camera behavior to follow its host sprite again (the BP it's attached to).",
  CameraStopFollow: "Detach the camera from any target (it stays where it was).",
  CameraShake: "Trigger a camera shake — duration in seconds, intensity in pixels (typical 2..10).",
  CameraStopShake: "Cancel any in-flight camera shake immediately.",
  CameraSetSmoothing: "Set the camera's follow smoothing (0=instant, 0.1=typical, 1=very floaty).",
  CameraSetOffset: "Set the camera's follow offset — pixels from the target position (e.g. y=-30 to keep target lower in frame).",
  CameraSetZoom: "Set the camera zoom (1=native, 2=2× zoom in, 0.5=zoom out).",
  CameraSetFollowAxes: "Toggle X / Y follow axes independently (e.g. follow only horizontally for a side-scroller).",
  CameraFlash: "Flash the screen for `duration` seconds with the given color (hex 0xRRGGBB).",
  CameraFade: "Fade the screen to (or from) the given color over `duration` seconds. fadeOut=1 fades to black, fadeOut=0 fades back in.",
  CameraLock: "Freeze the camera at its current position. Follow logic + SetTarget are suppressed until CameraUnlock — use for cutscenes.",
  CameraUnlock: "Resume normal follow logic after a CameraLock.",
  CameraPanTo: "Smoothly pan the camera to (x, y) over `duration` seconds. Works while locked (cutscene-friendly).",
  CameraPanToTag: "Smoothly pan to the first sprite carrying `tag` over `duration` seconds.",
  TracerGetResult: "Copy a Tracer hit field (hitX, actorName, distance, …) into a blueprint variable. Pick the tracer, the field, and the variable — no syntax needed.",
  EmitSignalTo: "Send a signal to OTHER sprites by tag (or UID). They react via OnSignal. Use for cross-object communication: 'tell every door OpenDoor', 'broadcast Alert to all enemies'. Sender never reaches into the receiver — receiver decides what the signal means.",
  SetVarOn: "Set a variable on OTHER sprites by tag (or UID). Pushes data without triggering logic. Pair with Text's `{varName}` interpolation to update display text on another BP without writing any events on the receiver.",
  SetPosition: "Snap the running sprite to (X, Y) instantly. Updates both the gameObject and the arcade physics body so collisions register correctly.",
  SetPositionX: "Snap the running sprite's X coordinate. Y unchanged.",
  SetPositionY: "Snap the running sprite's Y coordinate. X unchanged.",
  Tween: "Animate a property (position.x/y, scale, scaleX/Y, alpha, angle) from its current value to a target over a duration with easing. Tag identifies the tween for later pause/stop/wait-for. Loop and yoyo (ping-pong) supported. Re-running with the same tag stops the old one and starts fresh.",
  TweenSetEndValue: "Change the target value of a running tween mid-flight. Useful for chasing a moving target without restarting the animation.",
  TweenStop: "Cancel a running tween by tag. No-op if no tween with that tag exists.",
  TweenStopAll: "Cancel every active tween on this sprite, regardless of tag.",
  TweenPause: "Pause a tween by tag — it freezes at its current value. Resume later with TweenResume.",
  TweenPauseAll: "Pause every active tween on this sprite.",
  TweenResume: "Resume a paused tween by tag.",
  TweenResumeAll: "Resume every paused tween on this sprite.",
  PlayDialogue: "Play a Dialogue asset. The runner shows its built-in bubble UI above the speaker (overhead) or fixed at the camera bottom (box). Press the advance action to step through. No-op while another dialogue is already playing.",
  StopDialogue: "Cancel the running dialogue immediately. Clears the bubble and emits OnDialogueEnd.",
  PlayMusic: "Play a Music sound asset. Loops by default and replaces whatever music is currently playing (single track). Optional fade-in seconds. Routed through master × music volume.",
  StopMusic: "Stop the current music track. Optional fade-out seconds for a smooth stop.",
  PlaySound: "Play a SFX sound asset once. Overlaps freely with other sounds (each call is its own instance). Optional volume override.",
  PlaySounds: "Play from a list of sounds. playMode = random (pick), queue (in order), all. playInSequence OFF = play ONE (random one, or next-in-order for queue); ON = play ALL one-after-another, waiting for each to FINISH before the next, with gapSec realtime seconds between. 'all' fires every sound: gapSec 0 = at once, gapSec > 0 = STAGGERED starts (sound 1 at 0s, sound 2 at gapSec, sound 3 at 2×gapSec…) overlapping on a fixed offset. Volume + pitch randomize within their min/max ranges per sound.",
  StopSound: "Stop a named SFX — silences every currently-playing instance of that sound.",
  StopAllSounds: "Stop the music track AND every SFX. Use on game-over / scene transition.",
  SetMusicVolume: "Set the music bus volume (0..1). Affects the current and future music tracks. Multiplies with master volume.",
  SetSfxVolume: "Set the SFX bus volume (0..1). Affects current looping SFX and future plays. Multiplies with master volume.",
  SetMasterVolume: "Set the master volume (0..1) — scales BOTH the music and SFX buses. Use for a global mute / volume slider.",
  PlaySquashStretch: "Trigger a cartoon-style squash-and-stretch wobble on this sprite — wider+shorter, then taller+narrower, then back to normal. Falls back to sensible defaults when the SquashStretch behavior isn't attached. Per-call params override the behavior's configured intensity / duration / easing.",
  SetUIText: "Set the text on a Label / Button / Dropdown UI widget (or a child inside a multi-widget). Target by name; empty target = self. Supports {var} interpolation in the new content.",
  SetUIValue: "Set the value on a Slider / ProgressBar UI widget. Target by name. Value can be a literal number or an expression like 'var:hp'.",
  SetUISelectedValue: "Set a Dropdown widget's selected value (the option whose `value` matches). Target by name. Empty target = self.",
  SetUIVisible: "Show, hide, or TOGGLE a whole UI widget (or a child). mode=set uses the visible flag; mode=toggle flips current visibility (e.g. press E → toggle a menu). Hidden widgets stop rendering AND stop receiving pointer events.",
  SetUIBgColor: "Change a UI widget's background color. Target by name. Hex 0xRRGGBB.",
  SetUIElement: "Control ONE element's properties. Pick the element and the node shows the params for THAT kind (Button → text/font/colors/enabled, Slider → value/min/max/fill, Image → bg/opacity, …). Toggle ON each param you want to set; params left OFF keep the element's authored value. Replaces the old per-property Set UI Text / Value / Bg Color nodes.",
  CreateUIWidget: "Spawn a UI widget at runtime. Pass the widget asset's name and (optional) position. Useful for popping a confirm dialog or in-game notification on demand.",
  DestroyUIWidget: "Destroy UI widget instances matching the given name. Removes them from the scene and frees their pointer listeners. Useful for closing modals.",
  GiveItem: "Add N of an item to the player's count (the item's count global, global:<item>). The simple bag model: pickups, crafting output, and rewards use this. Persists across scenes.",
  TakeItem: "Remove N of an item from the player's count global (won't go below 0). Used by crafting inputs, selling, and using items.",
  BuyItem: "Buy N of an item: if the money global ≥ the item's buy price × N, charge it and give the item. No-op if you can't afford it.",
  SellItem: "Sell N of an item: if you own at least N, take them and pay the item's sell price × N into the money global. Wire this to a bag double-click to sell.",
  AddItem: "Add N of an item (by Item-asset name) to this sprite's Inventory behavior. Stacks into existing slots up to the item's max stack, then fills empty slots. Emits OnItemAdded (and OnInventoryFull if it didn't all fit).",
  RemoveItem: "Remove up to N of an item (by name) from this sprite's Inventory. Emits OnItemRemoved.",
  ClearInventory: "Empty this sprite's Inventory — all slots become empty.",
  GiveItemTo: "Add N of an item to ANOTHER sprite's Inventory, found by tag or blueprint/instance name. Use for pickups / trading / loot drops.",
  GetItemCount: "Count how many of an item this sprite holds and write it into a number variable, so you can branch on it with Compare.",
  GetItemProp: "Read a custom property of an item (e.g. damage, heal, type) and set / add / subtract it into a variable (which may target another object, e.g. Player.HP).",
  QuitGame: "Quit the game. In browser, attempts window.close() (only works for popups) and emits OnGameQuit so the user can route to a 'goodbye' screen / external URL via OnSignal.",
  BlurScene: "Apply a Gaussian blur post-FX to the world (main camera) — UI widgets stay crisp on top. Pass strength 0 to remove. Useful for pause menus.",
  SetScreenEffect: "Apply a post-FX. Target = screen (whole world, main camera — UI stays crisp) or layer (every object on a named layer; follows spawns + MoveToLayer). Pick the effect (grayscale / vhs / chromatic / filmgrain) + intensity 0..1 (0 = remove). Effects stack: one node per effect. NOTE: on a layer, vhs/chromatic apply per-object (each sprite splits around its own center), grayscale/filmgrain look uniform.",
  SetAngle: "Set the running sprite's rotation in degrees (0..360). Pair with the Compare Property condition to read it back.",
  SetScale: "Set the running sprite's uniform scale (both X and Y at once). 1=natural size, 2=double, 0.5=half.",
  SetScaleX: "Set horizontal scale only. Negative flips the sprite. Y unchanged.",
  SetScaleY: "Set vertical scale only. Negative flips the sprite. X unchanged.",
  SetOpacity: "Set the running sprite's alpha (0=invisible, 1=opaque).",
  MoveToLayer: "Move the running sprite to a different render layer (by layer name). Updates parallax + depth band so the sprite renders on the new layer.",
  SetZOrder: "Set the sprite's depth within the current layer (higher = renders on top of siblings). Use to put a UI widget above another, or a sprite above a background.",
  SetCursor: "Change the mouse cursor to a CSS style (default, pointer, crosshair, none, wait, text, move, grab, etc.).",
  ResetCursor: "Restore the mouse cursor to the browser default.",
  HideCursor: "Hide the mouse cursor (alias for SetCursor \"none\").",
  ShowCursor: "Show the mouse cursor with default style (alias for ResetCursor).",
  SetTile: "Write a tile index at cell (c, r) on the named tilemap + layer. -1 clears the cell. Updates the visual + collision in one step. No-op when the tilemap / layer doesn't exist or (c, r) is out of bounds.",
  RemoveTile: "Clear the cell at (c, r) on the named tilemap + layer (sets it to empty / index -1). Equivalent to SetTile with tile = -1.",
  SetTileAtWorld: "Write a tile index at the cell that contains world (x, y) on the named tilemap + layer. Resolves the cell internally via worldToCell; no-op if (x, y) falls outside the tilemap.",
  RemoveTileAtWorld: "Clear the cell that contains world (x, y) on the named tilemap + layer.",
  FillTileRect: "Fill every cell in the inclusive rectangle (c0, r0)..(c1, r1) on the named layer with one tile index. Clamps to map bounds; use tile = -1 to bulk-erase a region.",
  ReplaceTile: "Whole-layer find/replace: scan every cell on the named layer and rewrite any cell whose index equals fromTile to toTile. Useful for batch swaps (e.g. dirt → trampled dirt at night).",
  RemoveTilesInTracer: "Clear every tile whose center sits inside the named tracer's box. Uses LIVE tracer geometry (current pivot + angle + distance + boxThickness), so the action works regardless of whether the tracer has fired this frame. Tracer must be box shape; line tracers contribute zero area.",
  FillTilesInTracer: "Fill every tile whose center sits inside the named tracer's box with one tile index. Same live-geometry semantics as RemoveTilesInTracer.",
  PlaceBigTile: "Stamp a BigTile (composite multi-cell prop from the tileset) at cell (c, r) on the named tilemap + layer. The BigTile is identified by its id from the tileset's BigTile list. Position is rejected if the BigTile would extend past the map's bounds.",
  RemoveBigTileAtWorld: "Remove the BigTile placement that covers world (x, y) on the named tilemap + layer. Destroys its visual + collision body. No-op if no BigTile sits there.",
  RemoveBigTileAt: "Remove the BigTile placement that covers cell (c, r) on the named tilemap + layer. Same as RemoveBigTileAtWorld but with cell coords.",
  TracerSet: "Set any Tracer parameter at runtime (angle, distance, boxThickness, pivotX, pivotY, shape, triggerMode, triggerSignal, intervalSec, signalCount, signalLoop, signalLifetimeSec, damage, knockbackX, knockbackY, tagFilter, multiHit, debugDraw). componentName picks WHICH tracer when the host has multiple; blank = first attached.",
  DamageTile: "Subtract `amount` HP from the cell at (c, r). On the same chain, fires OnTileDestroyed when HP reaches 0 — the tile is removed via the standard setTileAt path AND every entry in the tileset's tileDrops table for that tile rolls (chance% / min..max) into the persistent count globals.",
  DamageTileAtWorld: "Same as DamageTile but resolves cell from world (x, y). Damages every cell a box centered at (x, y) overlaps — the box defaults to the CALLING sprite's hitbox (so a bullet clears its whole footprint with just x: self.x, y: self.y), or set `w`/`h` to size it explicitly. OR set `tracer` to a tracer name → damages every tile that tracer's line/box overlaps (x/y/w/h ignored).",
  MineTileAtWorld: "Mining-flavoured alias of DamageTileAtWorld. `power` is the damage applied per cell; tiles with no tileHardness entry are unbreakable. Mines every cell a box at (x, y) overlaps — the box DEFAULTS to the calling sprite's hitbox (e.g. a bullet mines its whole footprint with just x: self.x, y: self.y, no size fields needed); set `w`/`h` to override the size. OR set `tracer` to a tracer's name to mine every tile that tracer's line/box overlaps. Priority: tracer > explicit w/h > self hitbox.",
  RestoreTileHP: "Reset the HP entry for one cell back to the tile's full hardness — useful for `On Day Start → restore overworld ores`. No-op if the cell has no tile or no hardness configured.",
  PlayTileAnimation: "Start the animated-tile placement at (c, r). `restart=true` rewinds to frame 0; `loop` overrides the def's loop flag for this play session. No-op if there's no animated placement at the cell.",
  PlayTileAnimationAtWorld: "Same as PlayTileAnimation but resolves cell from world (x, y) — pass mouse.x/mouse.y, picked.x/y, a tracer endpoint, etc. The way you'd normally target a specific placement without knowing its grid coords.",
  StopTileAnimation: "Freeze the animated-tile placement at (c, r) on its current frame. PlayTileAnimation resumes from there unless `restart=true` is passed.",
  StopTileAnimationAtWorld: "Same as StopTileAnimation but resolves cell from world (x, y).",
  PlayAllTileAnimations: "Bulk play. Filter to one animated-tile def by `animatedTileId` (blank = every placement on the tilemap). Useful for `On Scene Start → autoplay disabled, then trigger here`.",
  StopAllTileAnimations: "Bulk stop. Filter by `animatedTileId` (blank = every animated placement on the tilemap).",
  RemoveAnimatedTileAt: "Remove the animated-tile placement at (c, r) — destroys the Phaser Image and clears the placement record. No drops, no hardness check. For the mining + drops flow use MineTileAtWorld / DamageTileAtWorld — they auto-route to animated placements when there's one at the cell.",
  EquipWeapon: "Swap a WeaponSlot's equipped weapon at runtime. `slot` matches the WeaponSlot's Name (e.g. \"RightHand\"). `spriteId` is the new weapon sprite (empty = unequip). `animation` is the new anim name (blank = first animation on the new sprite). The runtime injects the weapon's animation data on the fly, so any project sprite can be equipped without pre-attachment.",
  PlayWeaponAnimation: "Play an animation on a WeaponSlot, resetting the frame index and timer so the swing starts crisply on the trigger frame. `slot` matches the WeaponSlot's Name. Useful from `OnSignal \"AttackFrame\" → PlayWeaponAnimation(\"RightHand\", \"swing\")` so the weapon swing locks to the player's attack frame.",
};

export const ACTION_DEFAULTS: Record<StateActionKind, Record<string, unknown>> = {
  PlayAnimation: { animation: "", from: "current" },
  StopAnimation: {},
  SetFrame: { frame: 0 },
  SetAnimationSpeed: { speed: 1 },
  SetSprite: { spriteId: "", animation: "" },
  SetStatePriority: { state: "", priority: 0 },
  SetStateEnabled: { state: "", enabled: true },
  SetActiveStateMachine: { machine: "" },
  Dismember: {},
  // StartParticles / BurstParticles can OPTIONALLY override the host's
  // ParticleEmitter config for this firing. `override = 0` (default) →
  // node ignores the params below and uses the emitter's inspector
  // values. `override = 1` → node expands in the UI; all the params
  // below get pushed into the emitter before firing.
  StartParticles: {
    target: "",
    override: false,
    rate: 10,
    spriteId: "",
    lifetime: 1, lifetimeJitter: 0,
    speed: 100, speedJitter: 0,
    angleMin: -90, angleMax: -90,
    gravityX: 0, gravityY: 0,
    friction: 0,
    rotationStart: 0, rotationEnd: 0, rotationJitter: 0,
    scaleStart: 1, scaleEnd: 1,
    alphaStart: 1, alphaEnd: 0,
    tintStart: 0xffffff, tintEnd: 0xffffff,
    blendMode: "NORMAL", frameMode: "first", frameIndices: "",
    spawnJitterX: 0, spawnJitterY: 0,
  },
  StopParticles: { target: "" },
  BurstParticles: {
    target: "",
    count: 30,
    override: false,
    spriteId: "",
    lifetime: 1, lifetimeJitter: 0,
    speed: 100, speedJitter: 0,
    angleMin: -90, angleMax: -90,
    gravityX: 0, gravityY: 0,
    friction: 0,
    rotationStart: 0, rotationEnd: 0, rotationJitter: 0,
    scaleStart: 1, scaleEnd: 1,
    alphaStart: 1, alphaEnd: 0,
    tintStart: 0xffffff, tintEnd: 0xffffff,
    blendMode: "NORMAL", frameMode: "first", frameIndices: "",
    spawnJitterX: 0, spawnJitterY: 0,
  },
  SetParticleRate: { target: "", rate: 10 },
  SetParticleSpeed: { target: "", speed: 100, jitter: 0 },
  SetParticleGravity: { target: "", x: 0, y: 0 },
  SetParticleSprite: { target: "", spriteId: "" },
  Wait: { seconds: 1 },
  WaitRealtime: { seconds: 1 },
  SetVar: { name: "", value: 0 },
  AddVar: { name: "", delta: -1 },
  RandomNumber: { var: "", min: 0, max: 10, float: false },
  SetBool: { name: "", value: true },
  ToggleBool: { name: "" },
  SetTimeScale: { scale: 1 },
  HitStop: { durationMs: 80, delayMs: 50, scale: 0, affectPhysics: true, affectParticles: true, affectSmartTween: true, blockUntilDone: false },
  ApplyDamage: { amount: 10 },
  Heal: { amount: 10 },
  SetPaused: { mode: "pause", scope: "all", layer: "" },
  SetColor: { color: 0xffffff },
  SetSize: { w: 32, h: 32 },
  Log: { message: "Hello" },
  PrintString: { message: "Hello", duration: 2, color: "#00ff88" },
  SetVelocityX: { vx: 0 },
  SetVelocityY: { vy: 0 },
  MoveTo: { x: "", y: "", speed: 120, stopRadius: 4 },
  MoveStop: {},
  EmitSignal: { name: "MySignal" },
  Destroy: { persist: false },
  SetGlobal: { global: "", value: 0 },
  AddGlobal: { global: "", delta: 1 },
  SubGlobal: { global: "", delta: 1 },
  GlobalArrayOp: { global: "", op: "push", index: 0, value: 0 },
  RestockShop: { shop: "" },
  ResetWorld: {},
  SetBehaviorParam: { target: "Platformer.speed", value: 0, componentName: "" },
  SetBehaviorEnabled: { behavior: "Platformer", enabled: 1 },
  SetEventGroupEnabled: { group: "", enabled: 1 },
  SetGroupActive: { group: "", active: true },
  SubVar: { name: "", delta: 1 },
  WaitForSignal: { name: "" },
  CreateObject: { blueprintId: "", x: 0, y: 0, layer: "", spawnVars: {} },
  CreateObjectByName: { blueprintName: "", x: 0, y: 0, layer: "", spawnVars: {} },
  // FireProjectile mirrors the Projectile component: ONE visible field
  // (which BP to fire) plus a toggle for each component parameter. All
  // toggles default OFF — the bullet uses the BP's Projectile chip values.
  // Toggle ON = action's value overrides that parameter for this shot.
  // Spawn position = firing sprite's center; spawn direction = firing
  // sprite's facing; spawn layer = firing sprite's layer. All derived
  // automatically — the author doesn't have to wire them.
  FireProjectile: {
    blueprintName: "",
    // Optional: spawn from a named image point on the firing sprite's current
    // frame (e.g. "Muzzle") instead of its center. Facing-aware; falls back to
    // center when empty or the point isn't on the frame.
    spawnImagePoint: "",
    ovrMode: 0,             mode: "straight",
    ovrSpeed: 0,            speed: 600,
    ovrLifetime: 0,         lifetime: 3,
    ovrGravityX: 0,         gravityX: 0,
    ovrGravityY: 0,         gravityY: 0,
    ovrTargetTags: 0,       targetTags: "",
    ovrHitSignal: 0,        hitSignal: "",
    ovrDestroyOnHit: 0,     destroyOnHit: 1,
    ovrRotateToVelocity: 0, rotateToVelocity: 1,
    ovrDamage: 0,           damage: 0,
    ovrKnockbackX: 0,       knockbackX: 0,
    ovrKnockbackY: 0,       knockbackY: 0,
    ovrHitboxW: 0,          hitboxW: 0,
    ovrHitboxH: 0,          hitboxH: 0,
    ovrHomingTurnRate: 0,   homingTurnRate: 360,
  },
  SetInstanceName: { name: "" },
  EditTags: { bp: "", mode: "insert", tag: "", oldTag: "" },
  DebugPrint: { rows: [{ message: "", color: "#ff5555", duration: 2 }] },
  MoveToSetPosition: { x: 0, y: 0, speed: 0 },
  MoveToSetObject: { uid: 0, speed: 0 },
  MoveToSetTag: { tag: "", speed: 0 },
  MoveToSetAngle: { angleDeg: 0, speed: 0 },
  MoveToStop: {},
  MoveToResume: {},
  MoveToSetSpeed: { speed: 100 },
  MoveToNavPoint: { point: "", speed: 0 },
  PatrolNavPoints: { tag: "", mode: "loop", speed: 0, fallback: "" },
  SortZOrder: {},
  StopLoop: {},
  GoToLayout: { name: "" },
  GoToLayoutWithLoad: { name: "", minDisplaySec: 0 },
  SetLoadingProgress: { pct: 0 },
  SetLoadingScene: { name: "" },
  SetPlacementVisible: { spriteId: "", visible: true },
  SetPlacementFrame: { spriteId: "", frame: 0 },
  PlayPlacementAnim: { spriteId: "", animation: "", loop: true, startFrame: 0, destroyOnFinish: false },
  StopPlacementAnim: { spriteId: "" },
  SetPlacementPos: { spriteId: "", x: 0, y: 0 },
  CreateSpriteObject: { spriteId: "", x: 0, y: 0, layer: "" },
  DestroySpriteObject: { spriteId: "" },
  SetPlacementScale: { spriteId: "", scaleX: 1, scaleY: 1 },
  SetPlacementRotation: { spriteId: "", rotation: 0 },
  SetPlacementAlpha: { spriteId: "", alpha: 1 },
  SetRecipeEnabled: { recipe: "", enabled: true },
  AddRecipeIngredient: { recipe: "", item: "", qty: 1 },
  RemoveRecipeIngredient: { recipe: "", item: "" },
  SetRecipeOutput: { recipe: "", item: "", qty: 1 },
  SetSpriteObjectColliderEnabled: { spriteId: "", enabled: true },
  SetSpriteObjectSolid: { spriteId: "", solid: true },
  SetSpriteObjectCollideMode: { spriteId: "", mode: "include" },
  AddSpriteObjectTag: { spriteId: "", tag: "" },
  RemoveSpriteObjectTag: { spriteId: "", tag: "" },
  ClearSpriteObjectTags: { spriteId: "" },
  AddSpriteObjectCollideTag: { spriteId: "", tag: "" },
  RemoveSpriteObjectCollideTag: { spriteId: "", tag: "" },
  ClearSpriteObjectCollideTags: { spriteId: "" },
  RestartLayout: {},
  GoToNextLayout: {},
  RecreateInitialObjects: {},
  ScrollToObject: { tag: "" },
  ScrollToPosition: { x: 0, y: 0 },
  SetLayoutScale: { scale: 1 },
  SaveSlot: { slot: "default" },
  LoadSlot: { slot: "default" },
  CMJump: {},
  CMDash: {},
  CMStopDash: {},
  CMStopWallSlide: {},
  CMStopMovement: {},
  CMSet: { param: "maxSpeed", value: 220 },
  CMResetJumps: {},
  CMIgnoreInput: { ignore: "on" },
  CMSimulateControl: { control: "jump" },
  CMFallThrough: { duration: 0.2 },
  CMSetDefaultControls: {},
  CMSetMaxSpeed: { value: 220 },
  CMSetAcceleration: { value: 1500 },
  CMSetDeceleration: { value: 1500 },
  CMSetGravity: { value: 800 },
  CMSetGravityAngle: { value: 90 },
  CMSetMaxFallSpeed: { value: 600 },
  CMSetJumpStrength: { value: 460 },
  CMSetMultiJump: { value: 1 },
  CMSetJumpSustain: { value: true },
  CMSetCeilingMode: { mode: "stop" },
  CMSetDoubleJump: { value: true },
  CMSetMirror: { mode: "off" },
  TMSet: { tmParam: "maxSpeed", value: 220 },
  TMStop: {},
  TMIgnoreInput: { ignore: "on" },
  TMSimulateControl: { direction: "up" },
  SetFacing: { direction: "left" },
  // `textName` picks WHICH Text component (by its Name) when a BP has more
  // than one. Blank = the first Text component.
  SetText: { text: "", textName: "" },
  AppendText: { text: "", textName: "" },
  SetFontFamily: { family: "Arial", textName: "" },
  SetFontSize: { size: 16, textName: "" },
  SetTextColor: { color: 0xffffff, textName: "" },
  SetBold: { value: 1, textName: "" },
  SetItalic: { value: 1, textName: "" },
  SetAlignH: { align: "left", textName: "" },
  SetAlignV: { align: "top", textName: "" },
  SetWrapWidth: { width: 0, textName: "" },
  SetTextVisible: { visible: 1, textName: "" },
  ShowText: { textName: "" },
  HideText: { textName: "" },
  PlayAnimatorAnim: { name: "", override: 1 },
  StopAnimatorAnim: { name: "" },
  StopAllAnimatorAnims: {},
  InteractWithNPC: { uid: 0 },
  CameraSetTarget: { tag: "" },
  CameraSetTargetSelf: {},
  CameraStopFollow: {},
  CameraShake: { duration: 0.3, intensity: 5, forceRestart: false },
  CameraStopShake: {},
  CameraSetSmoothing: { value: 0.1 },
  CameraSetOffset: { x: 0, y: 0 },
  CameraSetZoom: { zoom: 1 },
  CameraSetFollowAxes: { followX: 1, followY: 1 },
  CameraFlash: { duration: 0.25, color: 0xffffff, forceRestart: false },
  CameraFade: { duration: 0.5, color: 0x000000, fadeOut: 1 },
  CameraLock: {},
  CameraUnlock: {},
  CameraPanTo: { x: 0, y: 0, duration: 1, ease: "Sine.easeInOut" },
  CameraPanToTag: { tag: "", duration: 1, ease: "Sine.easeInOut" },
  TracerGetResult: { tracer: "", field: "hitX", varName: "" },
  EmitSignalTo: { tag: "", uid: "", signal: "" },
  SetVarOn: { tag: "", uid: "", name: "", value: "" },
  SetPosition: { x: 0, y: 0 },
  SetPositionX: { x: 0 },
  SetPositionY: { y: 0 },
  Tween: {
    tag: "", property: "position.x", to: 0, duration: 0.5,
    ease: "Sine.easeOut", repeat: 0, yoyo: 0,
    // Target selector:
    //  - "self"          → the BP running the action (default)
    //  - "spriteObject"  → Sprite Object placement(s) of `spriteId`
    //  - "bp"            → BP instance(s) by blueprint name `bp`
    //  - "bpTag"         → every BP carrying tag `tag` (filter, not the tween-tag)
    targetKind: "self", spriteId: "", bp: "", targetTag: "",
  },
  TweenSetEndValue: { tag: "", to: 0 },
  TweenStop: { tag: "" },
  TweenStopAll: {},
  TweenPause: { tag: "" },
  TweenPauseAll: {},
  TweenResume: { tag: "" },
  TweenResumeAll: {},
  PlayDialogue: { dialogueId: "" },
  StopDialogue: {},
  PlayMusic: { sound: "", volume: 1, loop: true, fadeSec: 0 },
  StopMusic: { fadeSec: 0 },
  PlaySound: { sound: "", volume: 1 },
  PlaySounds: { sounds: [], playMode: "random", playInSequence: false, gapSec: 0, volumeMin: 1, volumeMax: 1, pitchMin: 1, pitchMax: 1 },
  StopSound: { sound: "" },
  StopAllSounds: {},
  SetMusicVolume: { volume: 1 },
  SetSfxVolume: { volume: 1 },
  SetMasterVolume: { volume: 1 },
  PlaySquashStretch: { kind: "both", intensity: 0.3, duration: 0.3, easing: "Quad.Out" },
  SetUIText: { target: "", text: "" },
  SetUIValue: { target: "", value: 0 },
  SetUISelectedValue: { target: "", value: "" },
  SetUIVisible: { target: "", mode: "set", visible: 1 },
  SetUIBgColor: { target: "", color: 0xffffff },
  // Params are DYNAMIC — the editor rebuilds the toggle/value pairs to match
  // the selected element's kind (a Button gets text/font/enabled, a Slider
  // gets value/min/max/fill, an Image gets bgColor/opacity, etc.). Starts with
  // just the target; picking an element fills in that kind's params.
  SetUIElement: { target: "" },
  CreateUIWidget: { widgetName: "", x: 0, y: 0, layer: "" },
  DestroyUIWidget: { target: "" },
  GiveItem: { item: "", qty: 1 },
  TakeItem: { item: "", qty: 1 },
  BuyItem: { item: "", qty: 1, currency: "gold" },
  SellItem: { item: "", qty: 1, currency: "gold" },
  AddItem: { item: "", qty: 1 },
  RemoveItem: { item: "", qty: 1 },
  ClearInventory: {},
  GiveItemTo: { item: "", qty: 1, target: "" },
  GetItemCount: { item: "", var: "" },
  GetItemProp: { item: "", key: "", var: "", varOp: "set" },
  QuitGame: {},
  BlurScene: { strength: 4 },
  SetScreenEffect: { effect: "grayscale", intensity: 1, target: "screen", layer: "" },
  SetAngle: { angle: 0 },
  SetScale: { scale: 1 },
  SetScaleX: { scaleX: 1 },
  SetScaleY: { scaleY: 1 },
  SetOpacity: { alpha: 1 },
  MoveToLayer: { layer: "" },
  SetZOrder: { depth: 0 },
  SetCursor: { style: "default" },
  ResetCursor: {},
  HideCursor: {},
  ShowCursor: {},
  SetTile: { tilemap: "", layer: "", c: 0, r: 0, tile: 0 },
  RemoveTile: { tilemap: "", layer: "", c: 0, r: 0 },
  SetTileAtWorld: { tilemap: "", layer: "", x: 0, y: 0, tile: 0 },
  RemoveTileAtWorld: { tilemap: "", layer: "", x: 0, y: 0 },
  FillTileRect: { tilemap: "", layer: "", c0: 0, r0: 0, c1: 0, r1: 0, tile: 0 },
  ReplaceTile: { tilemap: "", layer: "", fromTile: 0, toTile: 0 },
  RemoveTilesInTracer: { tilemap: "", layer: "", tracer: "" },
  FillTilesInTracer: { tilemap: "", layer: "", tracer: "", tile: 0 },
  PlaceBigTile: { tilemap: "", layer: "", bigTileId: "", c: 0, r: 0 },
  RemoveBigTileAtWorld: { tilemap: "", layer: "", x: 0, y: 0 },
  RemoveBigTileAt: { tilemap: "", layer: "", c: 0, r: 0 },
  TracerSet: { componentName: "", param: "angle", value: 0 },
  // `loop` is a tri-state override (true = force loop on, false = force off,
  // empty string = inherit from the def). Stored as a string sentinel rather
  // than `undefined` because JSON.stringify drops undefined keys — a save+
  // load round-trip would silently lose the override otherwise. The runtime
  // handler treats `""` / unset as "inherit", non-empty as the explicit value.
  PlayTileAnimation: { tilemap: "", layer: "", c: 0, r: 0, restart: false, loop: "" },
  PlayTileAnimationAtWorld: { tilemap: "", layer: "", x: 0, y: 0, restart: false, loop: "" },
  StopTileAnimation: { tilemap: "", layer: "", c: 0, r: 0 },
  StopTileAnimationAtWorld: { tilemap: "", layer: "", x: 0, y: 0 },
  PlayAllTileAnimations: { tilemap: "", animatedTileId: "", restart: false, loop: "" },
  StopAllTileAnimations: { tilemap: "", animatedTileId: "" },
  RemoveAnimatedTileAt: { tilemap: "", layer: "", c: 0, r: 0 },
  DamageTile: { tilemap: "", layer: "", c: 0, r: 0, amount: 1 },
  DamageTileAtWorld: { tilemap: "", layer: "", x: 0, y: 0, amount: 1, tracer: "", w: 0, h: 0 },
  MineTileAtWorld: { tilemap: "", layer: "", x: 0, y: 0, power: 1, tracer: "", w: 0, h: 0 },
  RestoreTileHP: { tilemap: "", layer: "", c: 0, r: 0 },
  EquipWeapon: { slot: "RightHand", spriteId: "", animation: "" },
  PlayWeaponAnimation: { slot: "RightHand", animation: "" },
};

/**
 * The full surface of CharacterMovement parameters editable via CMSet at
 * runtime. Grouped for the editor's typed param dropdown. Numeric unless
 * marked with `bool: true` (those become 0/1 toggles in the runtime).
 */
export interface CMParamSpec {
  name: string;
  label: string;
  group: string;
  /** True for boolean toggles (stored as 0/1 in the runtime). */
  bool?: boolean;
  /** Numeric default — used if the user has none set. */
  default?: number;
  /** Optional step hint for the editor's number field. */
  step?: number;
}
export const CHARACTER_MOVEMENT_PARAMS: CMParamSpec[] = [
  { name: "maxSpeed",          label: "Max Speed",        group: "Movement", default: 220 },
  { name: "acceleration",      label: "Acceleration",     group: "Movement", default: 1500 },
  { name: "deceleration",      label: "Deceleration",     group: "Movement", default: 1500 },
  { name: "airControl",        label: "Air Control",      group: "Movement", default: 1.0, step: 0.1 },
  { name: "gravity",           label: "Gravity",          group: "Movement", default: 800 },
  { name: "gravityAngle",      label: "Gravity Angle",    group: "Movement", default: 90 },
  { name: "maxFallSpeed",      label: "Max Fall Speed",   group: "Movement", default: 600 },
  { name: "ceilingMode",       label: "Ceiling Mode (0=stop, 1=preserve)", group: "Movement", default: 0, step: 1 },
  { name: "mirrorMode",        label: "Mirror (0=off, 1=velocity, 2=input)", group: "Movement", default: 0, step: 1 },
  { name: "scaleMirror",       label: "Smooth Mirror",     group: "Movement", bool: true, default: 0 },
  { name: "scaleMirrorTime",   label: "Smooth Mirror Time (s)", group: "Movement", default: 0.15, step: 0.01 },
  { name: "jumpStrength",      label: "Jump Strength",    group: "Jump",     default: 460 },
  { name: "multiJump",         label: "Multi-Jump",       group: "Jump",     default: 1, step: 1 },
  { name: "coyoteEnabled",     label: "Coyote Enabled",   group: "Jump",     bool: true,  default: 1 },
  { name: "coyoteTime",        label: "Coyote Time (s)",  group: "Jump",     default: 0.1, step: 0.01 },
  { name: "bufferEnabled",     label: "Input Buffer",     group: "Jump",     bool: true,  default: 1 },
  { name: "bufferTime",        label: "Buffer Time (s)",  group: "Jump",     default: 0.1, step: 0.01 },
  { name: "varHeightEnabled",  label: "Variable Height",  group: "Jump",     bool: true,  default: 0 },
  { name: "varHeightCutoff",   label: "Var Height Cutoff",group: "Jump",     default: -150 },
  { name: "jumpSustainEnabled",label: "Jump Sustain",     group: "Jump",     bool: true,  default: 0 },
  { name: "jumpSustainTime",   label: "Jump Sustain Time (s)", group: "Jump", default: 0.18, step: 0.01 },
  { name: "dashEnabled",       label: "Dash Enabled",     group: "Dash",     bool: true,  default: 0 },
  { name: "dashSpeed",         label: "Dash Speed",       group: "Dash",     default: 600 },
  { name: "dashDuration",      label: "Dash Duration (s)",group: "Dash",     default: 0.15, step: 0.01 },
  { name: "dashCooldown",      label: "Dash Cooldown (s)",group: "Dash",     default: 1.0,  step: 0.05 },
  { name: "wallEnabled",       label: "Wall Enabled",     group: "Wall",     bool: true,  default: 0 },
  { name: "wallSlideSpeed",    label: "Wall Slide Speed", group: "Wall",     default: 100 },
  { name: "wallJumpStrength",  label: "Wall Jump Y",      group: "Wall",     default: 460 },
  { name: "wallJumpKickX",     label: "Wall Jump X",      group: "Wall",     default: 320 },
  { name: "wallSlideRequiresInput", label: "Hold to Slide", group: "Wall",   bool: true, default: 1 },
];
