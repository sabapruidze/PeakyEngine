# Peaky Engine — API Reference (AI-oriented)

> Machine-derived from source. Every list below is extracted verbatim from the
> registries; do not treat this as hand-authored prose. When in doubt, open the
> cited file. Generated for a cold AI session that needs the authoring surface fast.

## 0. Orientation

- **What**: browser 2D game engine (Construct-3 / GameMaker feel, UE5 mental models). React+Zustand editor authors a JSON project; a Phaser-3 runtime plays it.
- **Packages**: `packages/shared` (pure TS types + registries), `packages/runtime` (Phaser runtime + behaviors), `packages/editor` (React editor bridging both).
- **Authoring surface**: the **Logic Sheet** node graph is the ONLY logic UI. Runtime = `packages/runtime/src/LogicSheetRunner.ts`; editor UI = `packages/editor/src/panels/inspector/LogicSheet/LogicGraphCanvas.tsx` (4042 lines). Event sheets are dead (`EventsSection.tsx` is a tombstone) but `eval.ts`'s `runAction`/`evalCondition` still run every node.
- **Registry locations**:
  - Actions: `packages/shared/src/sm/action.ts` — `StateActionKind`, `ACTION_KINDS`, `ACTION_DESCRIPTIONS`, `ACTION_DEFAULTS`.
  - Conditions/triggers: `packages/shared/src/sm/condition.ts` — `ConditionKind`, `CONDITION_KINDS`, `TRIGGER_KINDS`, `CONDITION_DESCRIPTIONS`.
  - Logic-Sheet-only triggers: `packages/runtime/src/LogicSheetRunner.ts` — `LogicTriggerKind`.
  - Node friendly docs/examples: `packages/editor/src/panels/inspector/LogicSheet/nodeDocs.ts` (`FILL`, `GETTER_DESCRIPTIONS`).
  - Behaviors (kinds): `packages/runtime/src/Behavior.ts` — `BehaviorKindMap`, `BEHAVIOR_WRITABLE_PARAMS`.
  - Behavior inspector params: `packages/editor/src/behaviorMeta.ts` — `BEHAVIOR_PARAMS`.
  - Behavior runtime handler: `packages/runtime/src/sm/eval.ts` — `runAction` / `evalCondition`.
  - Behavior spawn registry: `packages/editor/src/runProject.ts` — `BEHAVIOR_REGISTRY`; defaults in `packages/editor/src/project.ts` `BEHAVIOR_DEFAULTS`; strip-on-load `KNOWN_KINDS` in `store.ts`.
  - Blueprint classes: `packages/editor/src/blueprintClasses.ts` — `CLASSES`, `PUBLIC_CLASSES`.

### Totals (verified against the arrays)

| Registry | Count |
|---|---|
| `ACTION_KINDS` (actions) | **251** |
| `CONDITION_KINDS` (conditions) | **138** (of which **38** are `TRIGGER_KINDS`) |
| `LogicTriggerKind` (Logic-Sheet trigger nodes) | **80** |
| `BehaviorKindMap` (component kinds) | **30** |
| `CLASSES` (blueprint classes) | **6** (`PUBLIC_CLASSES` shows 5) |

### "To add X, touch these files" (from CLAUDE.md §7–10)

- **New action** (~8 sites): `StateActionKind` union + `ACTION_KINDS` + `ACTION_DESCRIPTIONS` + `ACTION_DEFAULTS` (all in `action.ts`); a subject allow-list in `objects.ts`; `runAction` handler in `eval.ts`; the palette + config UI in `LogicGraphCanvas.tsx`. Skip one → invisible / invalid-on-load / silent no-op / generic pill.
- **New condition**: mirror of the above (`condition.ts` union+arrays+descriptions, `objects.ts` allow-list, `evalCondition` in `eval.ts`, `LogicGraphCanvas.tsx`).
- **New behavior** (7 sites): `BehaviorKindMap` + `BEHAVIOR_WRITABLE_PARAMS` (`Behavior.ts`), `BEHAVIOR_REGISTRY` (`runProject.ts`), `BEHAVIOR_PARAMS` (`behaviorMeta.ts`), `BEHAVIOR_DEFAULTS` + `BehaviorKind` union (`project.ts`), `KNOWN_KINDS` (`store.ts`). Missing one → no writable params / editor crash / no inspector fields / stripped on reload / empty config.

### Gotchas

- **kind ≠ class name**: behavior kind `"StateMachine"` maps to class `CharacterAnimator`; kind `"SmartTween"` maps to class `Animator`. All other kinds match their class name.
- **Logic-Sheet-only triggers**: many trigger node types exist ONLY in `LogicTriggerKind` (runtime) and are NOT in shared `condition.ts` `TRIGGER_KINDS`. See §2A for the split — do not expect these in the shared registry.
- **`enabled` field clobber** (CLAUDE.md §11.1): `runProject` resets `Behavior.enabled=true` after attach; a behavior needing its own `enabled` config must capture it into a private flag in `init()` (ParticleEmitter's `_running` pattern).

---

## 1. Components (behaviors)

30 kinds in `BehaviorKindMap` (`packages/runtime/src/Behavior.ts`). Purpose = class header comment (`packages/runtime/src/behaviors/*.ts`); params = `BEHAVIOR_PARAMS` (`behaviorMeta.ts`); defaults in `BEHAVIOR_DEFAULTS` (`project.ts`). `type` defaults to number; `bool` = 0/1 checkbox; `string`/enum = dropdown when `options` set. `[W]` = writable via `SetBehaviorParam` (`BEHAVIOR_WRITABLE_PARAMS`).

### Solid
Immovable terrain; other (non-Solid) bodies collide against it. `init` sets body immovable + no gravity.
- `debugDraw` (0) — draw teal dashed body outline at runtime.

### JumpThru
One-way platform: pass through from below, land on top (only TOP face collides). `CMFallThrough` drops the stander through. No params.

### CharacterMovement
Smart all-in-one platformer controller (walk/jump/dash/wall/gravity), each ability bound to a named Input Action. Emits `OnJump`/`OnDashStart`/`OnDashEnd`; `OnLand`/`OnFall` come from `Sprite.tick`. Custom sectioned inspector UI. ~55 params (rendered by a custom card, not the flat list). Key params:
- Movement: `maxSpeed` (220), `acceleration` (1500), `deceleration` (1500), `airControl` (1.0), `gravity` (800), `gravityAngle` (90), `maxFallSpeed` (600), `ceilingMode` (0=stop/1=preserve), `mirrorMode` (0 off/1 velocity/2 input), `scaleMirror` (0,bool), `scaleMirrorTime` (0.15).
- Input binds: `leftAction`/`rightAction`/`jumpAction`/`dashAction` (names) + per-ability `*EventTrigger` / `*CustomFn` overrides.
- Jump: `jumpStrength` (460), `multiJump` (1), `coyoteEnabled` (1), `coyoteTime` (0.1), `bufferEnabled` (1), `bufferTime` (0.1), `varHeightEnabled` (0), `varHeightCutoff` (-150), `jumpSustainEnabled` (0), `jumpSustainTime` (0.18).
- Dash: `dashEnabled` (0), `dashSpeed` (600), `dashStartDelay` (0), `dashDuration` (0.15), `dashCooldown` (1.0), `dashWallBlock` (1,bool).
- Wall: `wallEnabled` (0,bool), `wallJumpAllowed` (1,bool), `wallJumpStrength` (460), `wallJumpKickX` (320), `wallSlideSpeed` (100), `wallSlideRequiresInput` (1,bool), `wallSlideOnContact` (0,bool).
- Runtime state (serialized/writable): `jumpsUsed`, `dashing`, `dashReadyAtSec`. Full editable surface: `CHARACTER_MOVEMENT_PARAMS` in `action.ts` (used by `CMSet`).

### TopdownMovement
8-way, gravity-free RPG/flying controller. **Do not combine with CharacterMovement** (gravity fight). Params:
- `maxSpeed` (220, AI-overridden), `acceleration` (1500), `deceleration` (1500).
- `upAction`/`downAction`/`leftAction`/`rightAction` (inputAction) + `*EventTrigger` overrides.
- `mirrorMode` (0 off/1 velocity/2 input), `scaleMirror` (0,bool), `scaleMirrorTime` (0.15), `ignoreInput` (0,bool), `slideAssist` (1,bool).

### SpriteRenderer
Renders host as an animated Phaser Image overlay (rect stays as collision fallback). Emits `OnAnimationFinished`. Params:
- `spriteId` ("",spriteRef), `currentAnimation` ("",spriteAnim), `playing` (1,bool), `speed` (1.0), `frame` (0), `useFrameCollider` (0,bool), `solid` (1,bool · depends useFrameCollider=1), `collideFilterMode` (include/exclude), `collideFilterTags` ([],tagList).

### Collider
Rectangular Arcade body `width`×`height` at `offsetX/Y`. Last Collider wins; no circle shapes. Params:
- `width` (32), `height` (48), `offsetX` (0), `offsetY` (0), `collideWorldBounds` (1,bool), `passThrough` (1,bool · overlap-only vs block), `debugDraw` (0,bool).

### Text
Phaser Text overlay following the body; `{var}` / `{self.x}` interpolation in `content`. Params:
- `name` (""), `content` ("Hello"), `fontFamily` ("Arial",font), `fontSize` (16), `color` (0xffffff), `bold` (0,bool), `italic` (0,bool), `align` (left/center/right), `vAlign` (top/middle/bottom), `wrapWidth` (0=off), `visible` (1,bool), `alpha` (1), `offsetX` (0), `offsetY` (0).

### Camera
Drives the scene main camera (follow/smoothing/deadzone/zoom/shake/fade). One per scene (last init wins). Params:
- `targetMode` (self/tag), `targetTag` (""), `smoothing` (0.5), `followX` (1,bool), `followY` (1,bool), `offsetLeftX` (0), `offsetRightX` (0), `offsetY` (0), `offsetSmoothing` (0), `deadzoneX` (0), `deadzoneY` (0), `zoom` (1), `bounded` (1,bool), `locked` (0,bool).

### Tracer
UE5-style ray/box trace; multiple per sprite disambiguated by `name`. Reads via `tracer:<name>.hit/hitX/actorName/distance/...`. Params:
- `name` (""), `shape` (line/box), `distance` (100), `angle` (0), `pivotSource` (manual/framePivot/imagePoint/weaponSlot), `imagePointName` (""), `weaponSlotName` (""), `pivotX` (0), `pivotY` (0), `boxThickness` (16 · shape=box), `tagFilter` ("" any), `damage` (0=off), `multiHit` (0,bool cleave), `knockbackX` (0), `knockbackY` (0), `triggerMode` (interval/signal), `intervalSec` (0=every frame), `triggerSignal` (""), `signalCount` (1), `signalLoop` (0,bool), `signalLifetimeSec` (0=forever), `fireAnim` ("" gate), `fireFrame` (-1 any gate), `debugDraw` (0,bool).

### SquashStretch
Cartoon deform-and-return on `sprite.squashX/Y` (physics body unmoved). Fired by `PlaySquashStretch`. Params:
- `intensity` (0.3), `duration` (0.3), `easing` (Quad.Out + Linear/Quad.InOut/Cubic.Out/Sine.InOut/Back.Out/Bounce.Out/Elastic.Out), `emitOnEnd` (0,bool).

### Outline
Highlight ring (8-copy silhouette stroke) + optional soft additive glow. Runtime-toggle `on`. Params:
- `on` (1,bool), `color` (0xffe24a), `thickness` (4), `opacity` (1), `pulse` (0,bool), `pulseSpeed` (2 · pulse=1), `glow` (0,bool), `glowColor` (0xffe24a), `glowSize` (12), `glowOpacity` (0.6), `feather` (0.7) [glow subfields depend glow=1].

### Shadow
Soft feathered blob/drop shadow below the host; can snap onto ground carrying `groundTag`. Params:
- `on` (1,bool), `shape` (circle/rect), `width` (48), `height` (16), `feather` (0.6), `opacity` (0.5), `color` (0x000000), `offsetX` (0), `offsetY` (8), `groundTag` (""), `maxDrop` (600), `shrinkWithHeight` (0,bool).

### LightSource
Atmospheric additive glow (torch/candle) that punches through `SetAmbientLight` darkness. NOT a Phaser PointLight. Params:
- `on` (1,bool), `color` (0xffd9a0), `radius` (140), `intensity` (1), `edge` (smooth/hard/noisy/wave), `feather` (0.7), `edgeAmount` (0.5 · noisy/wave), `offsetX` (0), `offsetY` (0), `flicker` (0), `flickerSpeed` (9).

### Weather
Drop-in rain/snow across the scene. Particles only exist in the viewport. Params:
- `on` (1,bool), `space` (screen/world), `mode` (topdown/sidescroller), `killTags` ([],tagList · side-scroller), `shelterTags` ([],tagList · fully dry), `shelterDrizzleTags` ([],tagList · no splash), `count` (160), `speed` (380), `speedJitter` (0.3), `angle` (12), `wind` (0), `rotationSpeed` (0), `shape` (line/circle/sprite), `spriteId` ("" · shape=sprite), `size` (14), `sizeJitter` (0.4), `thickness` (2 · line), `color` (0xaaccff), `alpha` (0.6), `sway` (0), `swaySpeed` (1.5), `splash` (0,bool), `splashType` (simple/sprite), `splashSprite` (""), `splashAnim` (""), `splashScale` (1).

### ParticleEmitter
Wraps Phaser particle emitter; either a Particles BP or a sprite-attached emitter. Construct-3-shaped fields. Params:
- Emission: `name` (""), `mode` (continuous/burst), `rate` (10), `burstCount` (30), `maxParticles` (1000 · advisory, pool uncapped at creation), `enabled` (1,bool "Emit On Start"), `spriteId` (""), `delay` (0), `pivotSource` (host/imagePoint), `imagePointName` (""), `spawnJitterX/Y` (0), `offsetX/Y` (0), `renderOrder` (front/back).
- Life/movement: `lifetime` (1), `lifetimeJitter` (0), `speed` (100), `speedJitter` (0), `angleMin` (-90), `angleMax` (-90), `gravityX/Y` (0), `friction` (0), `rotationStart` (0), `rotationEnd` (0), `rotationJitter` (0).
- Visual: `scaleStart/End` (1), `alphaStart` (1), `alphaEnd` (0), `tintStart/End` (0xffffff), `blendMode` (NORMAL/ADD/MULTIPLY), `frameMode` (first/random), `frameIndices` ("").

### Damageable
HP/damage/death. Other behaviors call `applyDamage()`; emits `OnDamageTaken`/`OnHealed`/`OnDeath` etc. Time-based i-frames. Params:
- `hpVar` ("hp",varRefNumber), `maxHpVar` ("maxHp"), `iframeSec` (0.5), `hitstunSec` (0.3), `knockbackMultiplier` (1), `destroyOnDeath` (1,bool), `deathDestroyDelay` (0.5), `allowHealing` (1,bool), `attackable` (1,bool), `blockStates` ("" csv), `guardMultiplier` (0=full block), `guarding` (0,bool). ([W] adds `hp`,`maxHp`,`blockKnockbackMultiplier`,`partialKnockbackMultiplier`.)

### StateMachine  (class `CharacterAnimator`)
Two-stage animation state machine: conditions→state (priority-sorted), state→animation. One-shot states latch until anim end. Config is a structural `states[]` array (custom UI, no flat inspector fields). [W] params: `states`, `currentState`, `debugDraw`, `inputGates`, `comboWindow`, `inputBufferMs`.

### AIBrain
Sense→Think→Act NPC brain (idle/alert/chase/search/attack/flee/rest). Drives movement via `simulatedInputs`; emits `OnAIStateEnter/Exit_<name>`. Params:
- `autoBrain` (1,bool · off = drive via Logic Sheet), `state` (idle initial), `targetTag` ("player"), `sightTracerName` ("sight"), `attackTracerName` ("attack"), `attackRange` (40), `loseSightAfterSec` (2.5), `attackDurationSec` (0), `attackCooldownSec` (0.8), `attackRestState` ("alert"), `interruptAttackOnHit` (1,bool), `chaseSpeed` (100), `patrolSpeed` (40), `fleeOnDamage` (0,bool), `fleeDurationSec` (3), `hearSignals` (""), `patrolMode` (none/walls), `autoFaceTarget` (1,bool), `disableWhenDead` (1,bool), `separationDist` (0=off), `separationTag` ("enemy"), `separationMode` (off/velocity/push), `aiTickRate` (3 frames), `mover` (auto/CharacterMovement/TopdownMovement/MoveTo).

### PhaseManager
HP-ratio phase counter for bosses; advances `currentPhase` at % thresholds, fires `OnPhaseEnter[_n]`, one-way. Params:
- `thresholdsPct` ("66,33"), `currentPhase` (0), `phaseVar` ("phase"), `invulnOnTransitionSec` (0.6).

### Widget
Attaches a UI widget in WORLD space pinned to the host (per-NPC healthbars/labels). Mirrors host vars so `var:self.X` bindings resolve. Params:
- `widgetId` ("",widgetRef), `linkedVar` ("",varRef), `offsetX` (0), `offsetY` (-40), `hideWhenDead` (1,bool).

### SmartTween  (class `Animator`)
Generic keyframe tween: additive position/scale/opacity/rotation offsets on a named target component. Structural `animations[]` config (custom card, empty flat params). Controlled at runtime via `PlayAnimatorAnim`/`StopAnimatorAnim` (NOT `SetBehaviorParam`).

### Projectile
Self-propelling sprite (straight/homing/aimed); emits `hitSignal` on tag-matched overlap. Pairs with `FireProjectile`. Params:
- `mode` (straight/homing/aimed), `speed` (600), `lifetime` (3, 0=∞), `gravityX/Y` (0), `targetTags` (""), `hitSignal` (""), `destroyOnHit` (1,bool), `collideTiles` (0,bool), `tileHitSignal` ("" · collideTiles=1), `rotateToVelocity` (1,bool), `damage` (0=off), `knockbackX/Y` (0), `hitboxW/H` (0=body), `hitboxOffsetX/Y` (0), `debugDraw` (0,bool), `homingTurnRate` (360 · mode=homing).

### Inventory
Item slots referenced by item NAME; emits `OnItemAdded/Removed/InventoryFull`. Params:
- `capacity` (20), `persistKey` ("" · carry across scenes; set on player, empty on chests/NPCs). ([W] = `capacity` only; slots via AddItem/RemoveItem.)

### TilemapRenderer
Spawns Phaser TilemapLayers from a TilemapAsset; per-layer depth/alpha/collision. **Not user-attachable** (configured by the tilemap asset). No inspector params; no `SetBehaviorParam` access.

### VisionMask
Invisible vision sphere carving a pixel-perfect hole through occluders (trees/walls/tilemap/sprites). Params:
- `radius` (80), `featherPx` (0), `cutoutOpacity` (0=cut,1=off), `maskSpriteId` ("",spriteRef), `maskSpriteMode` (static/animation), `maskAnimation` (""), `maskFrame` (0 · static), `maskMirror` (0,bool), `centerOffsetX/Y` (0), `cutoutLayers` ("",sceneLayerList), `excludeTags` (""), `invert` (0,bool spotlight), `enabled` (1,bool).

### MoveTo
Lightweight chase/locomotion (position/object/tag/angle). The swarm-enemy mover. Params:
- `mode` (position/object/tag/angle), `targetX/Y` (0 · position), `targetUid` (-1 · object), `targetTag` ("" · tag), `angleDeg` (0 · angle), `speed` (100, AI-overridden), `stopRadius` (4), `retargetEverySec` (0.5 · tag), `arrivalSignal` (""), `mirror` (1,bool), `usePhysics` (1,bool), `enabled` (1,bool), `separationDist` (0=off), `separationTag` (""), `separationStrength` (0.6 · unused), `separationMode` (off/velocity/push), `separationAvoid` (0,bool · comingSoon).

### TiledBackground
Construct-3 TiledBackground: one texture tiled infinitely (parallax followCamera or autoScroll). Params:
- `spriteId` (""), `currentAnimation` (""), `playing` (1,bool), `startFrame` (0 · playing=0), `mode` (followCamera/autoScroll), `parallaxFactorX/Y` (1 · followCamera), `scrollSpeedX/Y` (0 · autoScroll), `width` (0=fill), `height` (0=fill), `flipX` (0,bool), `flipY` (0,bool), `tileX` (1,bool), `tileY` (1,bool), `enabled` (1,bool).

### WeaponSlot
Pins a weapon sprite to a host image point; mirrors with facing. Multi-slot = multiple behaviors, addressed by `weapon:<name>.field`. Params:
- `name` ("RightHand"), `spriteId` ("" unequipped), `currentAnimation` (""), `imagePoint` (""), `offsetX/Y` (0), `angleOffset` (0), `scaleX/Y` (1), `followFacing` (1,bool), `renderAbove` (1,bool), `visible` (1,bool), `playing` (1,bool), `startFrame` (0 · playing=0), `speed` (1).

### Dismemberment
Slices the host's current frame into physics gib chunks on trigger. Structural `regions[]` (custom editor). Params:
- `refAnimation` ("",spriteAnim), `refFrame` (0), `launch` (burst/drop/directional/random), `angleDeg` (270 · directional), `spreadDeg` (60), `speedMin` (120), `speedMax` (300), `spinMin` (-360), `spinMax` (360), `gravity` (900), `bounce` (0.3), `cleanup` (time/offscreen/pool), `lifetimeSec` (4 · time), `fadeSec` (0.5), `maxGibs` (50 · pool), `collideWorld` (1,bool), `hideHost` (1,bool), `fireSignal` ("" · auto-fire).

### UIWidgetRenderer
Runtime of screen-space UI widgets (Panel/Label/Button/Slider/ProgressBar/Dropdown/Image). Attached automatically at UI-widget spawn (authored in UIWidgetTab, not attachable to a BP). `tickDuringPause=true`. Large [W] list: `widgetKind`,`widgetW/H`,`bgColor`,`bgAlpha`,`borderColor/Width`,`padding`,`cornerRadius*`,`shadow*`,`anchor*`,`text`,`font*`,`align`/`vAlign`,`signalOnClick/Hover/Leave`,`hoverBgColor`,`pressedBgColor`,`clickMode`,`min`/`max`/`value`/`direction`/`fillColor`,`signalOnChange`,`readOnly`,`selectedValue`,`signalOnSelect`,`spriteId`,`imageTextureKey`.

---

## 2. Nodes

Three groups: Triggers (start a chain), Conditions (state checks / Branch inputs), Actions (exec). Full descriptions in `CONDITION_DESCRIPTIONS` / `ACTION_DESCRIPTIONS`; friendly one-liners + examples for graph-only nodes in `nodeDocs.ts` `FILL`.

### 2A. Triggers

**IMPORTANT split**: the Logic Sheet's trigger palette is `LogicTriggerKind` (80, in `LogicSheetRunner.ts`). The shared `TRIGGER_KINDS` (38, in `condition.ts`) is the legacy list. Many trigger node types (`OnSeparate`, `OnOverlapForSeconds`, `OnKeyHeldFor`, `OnDamageTaken`, `OnDeath`, `OnStateEnter/Main/Exit`, `OnAIStateEnter/Exit`, `OnTracerHit`, `OnTracedBy`, `OnDialogue*`, `OnObjectHovered`, `OnTileDrop`, …) exist **only** in `LogicTriggerKind` and are NOT in shared `condition.ts`. Do not look for them there.

#### Logic-Sheet trigger nodes (`LogicTriggerKind`, 80)

Lifecycle/scene: `OnCreate`, `OnDestroyed`, `OnSceneStart`, `OnSceneEnd`, `OnSaveLoadComplete`, `OnTick` (every frame), `OnEveryNSeconds` (timer).
Input: `OnKeyPressed`, `OnKeyHeld`, `OnKeyHeldFor` (long-press N s, re-arms on release), `OnKeyReleased`, `OnDoubleKeyPressed` (double-tap), `InputCombo`.
Collision/overlap: `OnCollide`, `OnOverlap`, `OnOverlapForSeconds` (proximity hold N s, re-arms on separation), `OnSeparate` (stopped overlapping).
Signals: `OnSignal`.
Combat/health: `OnDamageTaken`, `OnHealed`, `OnBlocked`, `OnPartialBlock` (chip through guard), `OnDeath`, `OnComboStep`.
Inventory: `OnItemAdded`, `OnItemRemoved`, `OnInventoryFull`.
Animation/state: `OnAnimationEnd`, `OnAnyAnimationEnd`, `OnStateEnter`, `OnStateMain` (every frame in state), `OnStateExit`, `OnSquashStretchEnd`, `OnAnimatorAnimEnd`.
Movement (CM/topdown): `OnJump`, `OnLand`, `OnFall`, `OnDashStart`, `OnDashEnd`, `OnMoved`, `OnStopped`, `OnTopdownDirectionChanged`.
Nav/MoveTo: `OnArrived`, `OnNavFailed`, `OnAnyPointArrived`, `OnPointArrived`.
Tracer: `OnTracerHit` (my tracer hit sth), `OnTracerLost`, `OnTracedBy` (another's tracer hit me), `OnUntracedBy`.
Particles/tween: `OnParticleBurstEnd`, `OnTweenStart`, `OnTweenFinish`.
Camera: `OnCameraPanEnd`.
Mouse: `OnMouseButtonPressed`, `OnMouseButtonReleased`, `OnMouseClick`, `OnMouseDoubleClick`, `OnMouseWheel`, `OnObjectClicked`, `OnObjectDoubleClicked`, `OnObjectHovered`, `OnObjectUnhovered`.
Dialogue: `OnDialogueStart`, `OnDialogueLine`, `OnDialogueEnd`.
Scene load: `OnLoadStart`, `OnLoadProgress`, `OnLoadComplete`.
AI: `OnAIStateEnter`, `OnAIStateExit`, `OnTargetSighted`, `OnTargetLost`.
Sprite objects: `OnSpriteObjectCreate`, `OnSpriteObjectDestroy`, `OnCollideWithSpriteObject`, `OnOverlapWithSpriteObject`.
Tiles: `OnTileDestroyed`, `OnTileDamaged`, `OnTileDrop` (fires on the miner when a destroyed tile drops loot).

#### Shared `TRIGGER_KINDS` (38, in `condition.ts`)
`OnCreate`, `OnDestroyed`, `OnKeyPressed`, `OnKeyReleased`, `OnCollide`, `OnOverlap`, `OnAnimationEnd`, `OnAnyAnimationEnd`, `OnLand`, `OnJump`, `OnFall`, `OnDashStart`, `OnDashEnd`, `OnMoved`, `OnStopped`, `OnSignal`, `OnSceneStart`, `OnSceneEnd`, `OnLoadStart`, `OnLoadProgress`, `OnLoadComplete`, `OnSaveLoadComplete`, `EveryXSeconds`, `OnMouseButtonPressed`, `OnMouseButtonReleased`, `OnMouseClick`, `OnMouseDoubleClick`, `OnMouseWheel`, `OnObjectClicked`, `OnObjectDoubleClicked`, `OnCameraPanEnd`, `TracerJustHit`, `OnTweenStart`, `OnTweenFinish`, `OnParticleBurstEnd`, `OnTileDestroyed`, `OnTileDamaged`, `InputCombo`.

### 2B. Conditions

138 in `CONDITION_KINDS` (`condition.ts`). All support `not:true`. `Compare` reads a `CompareProperty` (`velocity.x/y`, `speed`, `position.x/y`, `angle`, `scale.x/y`, `scale`, `alpha`, `depth`, `is_grounded`); ops `> < >= <= == !=`.

Scene/load: `OnSceneStart`, `OnSceneEnd`, `OnLoadStart`, `OnLoadProgress`, `OnLoadComplete`, `IsLoading`, `IsScene` (active scene name), `OnSaveLoadComplete`.
Sprite objects: `OnCollideWithSpriteObject`, `OnOverlapWithSpriteObject`, `OnSpriteObjectCreate`, `OnSpriteObjectDestroy`, `HasSpriteObjectTag`.
Time/step: `OnStep` (every tick), `EveryXSeconds`, `CompareTime`, `TriggerOnceWhileTrue` (edge on the rest of the event), `Always`, `Else` (prev sibling didn't fire).
Input: `OnKeyPressed`, `OnKeyReleased`, `OnKeyHeld`, `IsActionHeld`, `InputCombo`, `InputBuffered`, `SignalFiredEdge`, `IsSignalFiring`.
Mouse: `OnMouseButtonPressed`, `OnMouseButtonReleased`, `IsMouseButtonHeld`, `OnMouseClick`*, `OnMouseWheel`*, `OnObjectClicked`*, `OnObjectDoubleClicked`*, `IsCursorOverObject`.
Collision/overlap: `OnCollide`, `OnOverlap`, `JustCollidedWithTag`, `IsOverlappingTag`, `JustSeparatedFromTag`, `ObjectUIDExists`.
Compare/vars: `Compare`, `CompareValues` (left OP right, literals or `var:`), `IsBetween`, `IsBoolean`.
Loops/picking: `ForEach`, `Repeat`, `While` (conditions; use the matching ACTION nodes to actually loop), `PickByComparison`, `PickAll`, `PickRandom`, `PickByHighest`, `PickByLowest`, `PickNth`.
Motion: `IsMoving`, `IsMovingTo`, `HasArrived`, `IsMovingLeft/Right/Up/Down`, `IsMovingDir` (8-way velocity), `IsMovingAny` (hypot), `IsTopdownFacing` (sticky 4-way), `IsFacingLeft`, `IsFacingRight`, `IsRunning`.
CharacterMovement state: `IsGrounded`, `IsJumping`, `IsFalling`, `IsDashing`, `IsWallSliding`, `IsByWall`, `IsByWallLeft`, `IsByWallRight`, `CanJump`, `CanDash`, `IsDoubleJumpEnabled`, `IsWallJumping`, `JustWallJumped`, `IsAirborne`, `CompareCMParam`, `CompareTMParam`, `IsBehaviorEnabled`.
Animation/state machine: `IsAnimationPlaying`, `IsState`, `IsStateEnabled`, `PreviousStateWas`, `PreviousAnimWas`, `CompareFrame`, `JustTurnedLeft`, `JustTurnedRight`.
AI: `IsAIState`, `HasAITarget`, `NoAITarget`.
Health: `IsDead`, `IsInHitstun`, `IsInIframes`.
Tags: `HasTag`, `HasAnyTag`, `HasAllTags`.
Text: `CompareText`, `IsTextVisible`, `IsDialoguePlaying`, `IsAnimatorAnimPlaying`.
Camera: `IsCameraShaking`, `IsCameraPanning`, `IsCameraLocked`, `CompareCameraZoom`, `OnCameraPanEnd`.
Tracer: `TracerJustHit`, `IsTracerHit`, `TracerHitHasTag`.
Tween: `OnTweenStart`, `OnTweenFinish`, `IsTweenPlaying`, `IsTweenPaused`, `IsAnyTweenPlaying`.
Particles: `IsEmittingParticles`, `IsParticleEmitterEnabled`, `OnParticleBurstEnd`, `CompareParticleCount`.
Audio/pause: `IsMusicPlaying`, `IsSoundPlaying`, `IsPaused`.
Inventory: `HasItem`, `InventoryIsFull`.
Tiles: `CompareTileAt`, `CompareTileAtWorld`, `IsTileSolidAt`, `IsTileEmptyAt`, `OnTileDestroyed`, `OnTileDamaged`.

Graph-only condition/getter nodes (`nodeDocs.ts` `FILL`/`GETTER_DESCRIPTIONS`, distinct from shared kinds): `VarEquals`, `VarAbove`, `VarBelow`, `VarTrue`, `VarFalse`, `IsTargetSighted`, `DistanceToTargetBelow`, `And`, `Or`, `Not`, `Branch`, `Switch`, plus getters `VarRead`, `Literal`, `StringValue`, `GetPicked`, `GetOtherObject`, `GetOverlappingObject`, `GetHoveredObject`, `GetDistance`, `GetTags`, `CountByTag`, `GetSceneName`, `GetGlobalValue`, `GetListValue`, `GetSlotItem`, `GetTracerField`, `GetLastNavPoint`, `GetNavPoint`, `GetTaggedTile`, `GetLastTile`, `GetLastDrop`, `RandomPick`, `RandomRange`.

### 2C. Actions

251 in `ACTION_KINDS` (`action.ts`). One line each; defaults in `ACTION_DEFAULTS`. Grouped by the union's own comment sections.

**Animation / SpriteRenderer** — `PlayAnimation` (from=current/beginning), `SetSprite` (swap sheet), `StopAnimation`, `SetFrame`, `SetAnimationSpeed` (multiplier).
**State machine** — `SetStatePriority`, `SetStateEnabled`, `SetActiveStateMachine` (exclusive switch).
**Dismemberment** — `Dismember` (slice current frame into gibs).
**Particles** — `StartParticles`, `StopParticles`, `BurstParticles` (N in one shot), `SetParticleRate`, `SetParticleSpeed`, `SetParticleGravity`, `SetParticleSprite`.
**Flow / time** — `Wait` (sim clock, freezes when paused), `WaitRealtime` (wall clock, survives pause), `WaitForSignal` (release on signal, 30 s timeout), `StopLoop`, `SetTimeScale`, `HitStop` (impact freeze, auto-resumes), `SetPaused` (scope all/layer; UI stays live), `SetEventGroupEnabled`, `SetGroupActive` (this object's Logic Sheet group).
**Variables** — `SetVar`, `AddVar` (neg=subtract), `SubVar`, `RandomNumber` (var, min/max, float), `SetBool`, `ToggleBool`.
**Globals (persist across scenes+save)** — `SetGlobal`, `AddGlobal`, `SubGlobal`, `GlobalArrayOp` (push/set/removeAt/clear), `ResetWorld` (clear persistence — new game).
**Health** — `ApplyDamage`, `Heal`.
**Basic transform/visual** — `SetColor`, `SetSize` (visual+body), `SetVelocityX`, `SetVelocityY`, `SetPosition`, `SetPositionX`, `SetPositionY`, `SetAngle`, `SetScale`, `SetScaleX`, `SetScaleY`, `SetOpacity`, `SetVisible` (whole BP, set/toggle), `MoveToLayer`, `SetZOrder`.
**MoveTo (fire-once + behavior control)** — `MoveTo` (fly to captured point, stops), `MoveStop`, `MoveToSetPosition`, `MoveToSetObject`, `MoveToSetTag`, `MoveToSetAngle`, `MoveToStop`, `MoveToResume`, `MoveToSetSpeed`, `MoveToNavPoint` (A* nav mesh), `PatrolNavPoints` (loop/pingpong/random).
**Lifecycle / spawning** — `Destroy` (persist=remember gone), `CreateObject` (by BP id), `CreateObjectByName`, `FireProjectile` (manual/toward/aimed/homing), `SetInstanceName`, `EditTags` (insert/remove/replace), `SortZOrder`, `RecreateInitialObjects`.
**Signals / cross-object** — `EmitSignal`, `EmitSignalTo` (by tag/uid), `SetVarOn` (by tag/uid), `Log`, `PrintString`, `DebugPrint` (inline wire-tap print rows).
**Behavior control** — `SetBehaviorParam`, `SetBehaviorEnabled`.
**CharacterMovement** — `CMJump`, `CMDash`, `CMStopDash`, `CMStopWallSlide`, `CMStopMovement`, `CMSet` (any param), `CMResetJumps`, `CMIgnoreInput`, `CMSimulateControl` (press for one frame), `CMFallThrough`, `CMSetDefaultControls`, plus typed setters `CMSetMaxSpeed`, `CMSetAcceleration`, `CMSetDeceleration`, `CMSetGravity`, `CMSetGravityAngle`, `CMSetMaxFallSpeed`, `CMSetJumpStrength`, `CMSetMultiJump`, `CMSetJumpSustain`, `CMSetCeilingMode`, `CMSetDoubleJump`, `CMSetMirror`.
**TopdownMovement** — `TMSet`, `TMStop`, `TMIgnoreInput`, `TMSimulateControl`, `SetFacing` (left/right/flip).
**Text** — `SetText` (`{var}` interp), `AppendText`, `SetFontFamily`, `SetFontSize`, `SetTextColor`, `SetBold`, `SetItalic`, `SetAlignH`, `SetAlignV`, `SetWrapWidth`, `SetTextVisible`, `ShowText`, `HideText`. (All take `textName` to pick a Text component.)
**SmartTween (Animator)** — `PlayAnimatorAnim` (override=restart), `StopAnimatorAnim`, `StopAllAnimatorAnims`.
**Dialogue** — `PlayDialogue`, `StopDialogue`, `InteractWithNPC` (fire OnInteract on a uid).
**Camera** — `CameraSetTarget`, `CameraSetTargetSelf`, `CameraStopFollow`, `CameraShake`, `CameraStopShake`, `CameraSetSmoothing`, `CameraSetOffset`, `CameraSetZoom`, `CameraSetFollowAxes`, `CameraFlash`, `CameraFade`, `CameraLock`, `CameraUnlock`, `CameraPanTo`, `CameraPanToTag`; plus `ScrollToObject`, `ScrollToPosition`, `SetLayoutScale`.
**Tracer** — `TracerGetResult` (copy hit field to var), `TracerSet` (any tracer param at runtime).
**Tween** — `Tween` (property, tag, ease, loop/yoyo; target self/spriteObject/bp/bpTag), `TweenSetEndValue`, `TweenStop`, `TweenStopAll`, `TweenPause`, `TweenPauseAll`, `TweenResume`, `TweenResumeAll`, `TweenVar` (lerp a variable, frame-independent), `TweenParam` (lerp a component param e.g. LightSource.radius).
**Audio** — `PlayMusic` (loop, single track, fade), `StopMusic`, `PlaySound` (one-shot overlap), `PlaySounds` (random/queue/all + jitter), `StopSound`, `StopAllSounds`, `SetMusicVolume`, `SetSfxVolume`, `SetMasterVolume`.
**SquashStretch** — `PlaySquashStretch` (kind both/squash/stretch).
**UI widgets** — `SetUIText`, `SetUIValue`, `SetUISelectedValue`, `SetUIVisible` (set/toggle), `SetUIBgColor`, `SetUIElement` (per-element param panel; replaces the old per-property nodes), `CreateUIWidget`, `DestroyUIWidget`.
**Inventory / shop (count globals)** — `GiveItem`, `TakeItem`, `BuyItem`, `SellItem`, `RestockShop`.
**Inventory (behavior)** — `AddItem`, `RemoveItem`, `ClearInventory`, `GiveItemTo` (another sprite), `GetItemCount` (→var), `GetItemProp` (→var, set/add/sub).
**Scene / layout** — `GoToLayout`, `GoToLayoutWithLoad` (via loading scene), `SetLoadingProgress`, `SetLoadingScene`, `RestartLayout`, `GoToNextLayout`, `QuitGame`.
**Save/load** — `SaveSlot`, `LoadSlot`.
**Screen FX** — `BlurScene` (main cam), `SetScreenEffect` (grayscale/vhs/chromatic/filmgrain; screen or layer), `SetAmbientLight` (darkness + tint; LightSource punches through).
**Cursor** — `SetCursor`, `ResetCursor`, `HideCursor`, `ShowCursor`.
**Recipes (crafting)** — `SetRecipeEnabled`, `AddRecipeIngredient`, `RemoveRecipeIngredient`, `SetRecipeOutput`.
**Sprite Objects (placements, lighter than BPs)** — `CreateSpriteObject`, `DestroySpriteObject`, `SetPlacementVisible`, `SetPlacementFrame`, `PlayPlacementAnim` (destroyOnFinish), `StopPlacementAnim`, `SetPlacementPos`, `SetPlacementScale`, `SetPlacementRotation`, `SetPlacementAlpha`, `SetSpriteObjectColliderEnabled`, `SetSpriteObjectSolid`, `SetSpriteObjectCollideMode`, `AddSpriteObjectTag`, `RemoveSpriteObjectTag`, `ClearSpriteObjectTags`, `AddSpriteObjectCollideTag`, `RemoveSpriteObjectCollideTag`, `ClearSpriteObjectCollideTags`.
**Tilemap (read/mutate)** — `SetTile`, `RemoveTile`, `SetTileAtWorld`, `RemoveTileAtWorld`, `FillTileRect`, `ReplaceTile`, `RemoveTilesInTracer`, `FillTilesInTracer`.
**Tilemap BigTile** — `PlaceBigTile`, `PlaceBigTileAtWorld`, `RemoveBigTileAtWorld`, `RemoveBigTileAt`.
**Tilemap mining/damage** — `DamageTile`, `DamageTileAtWorld`, `MineTileAtWorld` (power vs hardness), `RestoreTileHP`.
**Tilemap animated tiles** — `PlayTileAnimation`, `PlayTileAnimationAtWorld`, `PlaceAnimatedTileAtWorld`, `StopTileAnimation`, `StopTileAnimationAtWorld`, `PlayAllTileAnimations`, `StopAllTileAnimations`, `RemoveAnimatedTileAt`.
**Weapon slot** — `EquipWeapon` (swap/unequip), `PlayWeaponAnimation`.

Graph-only action nodes (`nodeDocs.ts` `FILL`, not in shared `ACTION_KINDS`): `Sequence`, `DoOnce`, `FlipFlop`, `Random`, `Combinator`, `IncrementVar`, `ToggleVar`, `DropObject`, `DebounceWait`, `WaitForAnim`, `WaitForKeyPress`, `SetAIState`, `SetAITarget`, `AlertNearbyAllies`, `Comment`.

---

## 3. Blueprint classes

`CLASSES` in `packages/editor/src/blueprintClasses.ts`. `PUBLIC_CLASSES = ["Character","NPC","Trigger","Empty","Camera"]` (Actor is legacy, not in the picker). Each class seeds defaults but does not lock the BP. Every class also carries a placeholder `StateMachine` so the Overview/animation surface always exists.

| Class | Purpose | Seeds |
|---|---|---|
| **Character** | Pre-wired player. HP/movement/jump/collision ready; tune via Overview, no event authoring. | tags `character,player`; 32×48 red; behaviors: CharacterMovement (tuned), SpriteRenderer, Collider, Damageable, 3× Tracer (AttackTracer/InteractionChecker/talk_zone), StateMachine (idle/run/jump/fall/dash/wall/attack combo…), SquashStretch; vars HP=100, MaxHP=100. |
| **NPC** | AI-driven character; same body driven by AIBrain (sense→think→act). Toggle hostility/patrol/sight/damage. | tags `npc,enemy,dialog npc`; 32×48; behaviors: CharacterMovement, SpriteRenderer, Collider, Damageable, StateMachine (hurt/attack/flee/chase/search/alert/idle/death), AIBrain (patrol walls, chase 250), sight+attack Tracers, ParticleEmitter, Text; vars HP=20, MaxHP=50. |
| **Trigger** | Invisible sensor volume; wire OnOverlap / OnSeparate / OnOverlapForSeconds. Instance can carry a Door link to teleport to another scene. Overlap-only, no gravity, hidden rect. | tags `trigger`; 64×64 blue; `hideRect`, `affectedByGravity:false`; behaviors: Collider (overlap-only), placeholder StateMachine. |
| **Empty** | Blank BP — no components/tags/size. Clean starting point (pickups, decorations, spawners). | tags `[]`; 32×32 grey; `affectedByGravity:false`; placeholder StateMachine only. |
| **Camera** | Scene camera, one per scene. Auto-carries the Camera behavior (its picker exposes Camera actions/conditions). Drag to set initial scroll. | tags `camera`; 32×32 orange; behaviors: placeholder StateMachine, Camera. |
| **Actor** | Legacy default for un-classed BPs. Bare-bones, not in the picker. | `classKind:"Actor"` only. |

### DoorLink (Trigger instances)
`DoorLink` on `BlueprintInstance.door` (`project.ts`): turns a Trigger into a scene-to-scene door.
- `name` — this door's entry id (target of other doors' `destDoor`).
- `destSceneId` — destination scene (empty = plain trigger, no teleport).
- `destDoor` — door name to arrive on in the destination.
- `withLoad` (bool) — use the loading-screen transition instead of a plain cut.
- `travelerTag` ("player") — which tag activates the door.
- `activation` — `instant` (default, travel on entry) / `delay` (after `delaySec` standing on it) / `input` (press `inputAction` while on it).
- `delaySec`, `inputAction` — sub-fields for the above.

---

## 4. Recent additions (2026-07)

- **Trigger blueprint class** — invisible overlap sensor (`Trigger` in `blueprintClasses.ts`), hidden rect, overlap-only Collider.
- **Door links** — `DoorLink` on `BlueprintInstance.door`; activation `instant`/`delay`/`input`, optional loading-screen transition (`withLoad`).
- **`OnOverlapForSeconds`** + **`OnKeyHeldFor`** trigger nodes (LogicTriggerKind-only): proximity-hold / long-press with re-arm.
- **`OnSeparate`** — fires when overlap ends (LogicTriggerKind-only).
- **`TweenVar` / `TweenParam` / `SetVisible`** actions — lerp a variable / a component param (e.g. LightSource.radius) frame-independently; `SetVisible` toggles the whole BP incl. overlays.
- **Weather `shelterTags` / `shelterDrizzleTags`** — painted shelter mask (fully dry vs no-splash) for rain/snow.
- **Shadow / LightSource / Outline** components — feathered drop shadow, additive glow through `SetAmbientLight`, silhouette outline + glow.
- **Persistent-game fast transitions** — cross-level persistence + loading-scene routing (`GoToLayoutWithLoad`, `PersistentState`, spawn/tilemap capture per scene).
