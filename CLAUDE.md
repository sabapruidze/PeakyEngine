# Peaky Engine — Project Handoff (CLAUDE.md)

This document captures the full state of the project as of **2026-06-12**.
It's written for a Claude session joining cold. Read it top-to-bottom before
editing — the engine has dense plumbing and the registries below are the
"if you don't know it, you can't find it" parts.

> **Authoring-surface note (v3):** the **Logic Sheet** (a node graph) is now the
> ONLY logic-authoring UI. The old **Event Sheets** UI was removed — its file
> `EventsSection.tsx` is a 22-line tombstone. The data shape `BlueprintDef.events`
> and the per-event runner in `Sprite.ts` still exist as a **legacy runtime
> path**, but no UI writes to them anymore. Where this doc below describes
> "event sheets / the picker in EventsSection," read it as the Logic Sheet
> (`packages/editor/src/panels/inspector/LogicSheet/`, primary file
> `LogicGraphCanvas.tsx`) + its runtime `LogicSheetRunner.ts`.

---

## 0. Latest session (2026-07-03) — read this first

Big engine work. See `docs/API_REFERENCE.md` for the full node/component/class
reference (AI-oriented). Highlights, grouped:

**Fast scene transitions (persistent game) — PARTIAL, Stages 0–2 shipped, Stage 3
pending.** Previously EVERY scene change did `game.destroy()` + `new Phaser.Game`
(re-uploads all textures → ~100–500ms "loading" feel). Now the game persists and
the scene rebuilds IN PLACE via `scene.restart()` — the same path `RestartLayout`
always used. Key pieces:
- `runtime/Game.ts`: `Peaky` stores a MUTABLE builder (`_builder`/`_preload`);
  `MainScene.create()`/`preload()` call the STORED ones. New `setBuilder()` +
  `gotoScene(build, preload)` (= setBuilder then `scene.restart()`). `create()` now
  also runs an EXTENDED reset list — hitstop (else new scene FREEZES), camera
  (zoom/follow/scroll + `peaky.camera` cache — the "camera zoom across transitions"
  bug), mouse/input, tilemap registries, placement callbacks, pause flags. Textures
  stay on the GPU (stable keys + `textures.exists`).
- `editor/runProject.ts`: the giant `game.start` closure was extracted into
  `makeSceneBuilder(project, scene, parent)` → `{ build, preload, effectiveScene }`.
  `runScene` = initial boot (new game). `buildSceneOn(game, project, scene, parent)`
  = transition (calls `game.gotoScene`). Builder captures `project`, `scene`, `parent`.
- `editor/ScenePanel.tsx`: `transitionTo()` rebuilds on the existing game (keeps
  `gameRef`/`__peakyGame`), behind a `FAST_TRANSITIONS` fallback flag; `boot` (cold
  destroy+new) is now only for initial Play / Stop→Play / loader boot. The
  outgoing-scene snapshot COVER + `peaky:sceneReady` gate still hide the 1-frame
  rebuild (cover now `background-size: contain`, fixing a zoom artifact).
- `runtime/behaviors/ParticleEmitter.ts`: packed-frame texture key is now
  DETERMINISTIC (hash of frame indices) — the old `Math.random()` suffix leaked one
  canvas per scene visit on a persistent game.
- **STILL TODO (Stage 3):** route `GoToLayoutWithLoad` loader in-place; add CHOOSABLE
  music (persist vs stop per transition — user wants a toggle on Door + GoToLayout);
  retire the `FAST_TRANSITIONS` flag; audit `scene.events.on` in the builder for a
  matching SHUTDOWN-`off` (a missed one leaks a listener per transition). See
  `FOLLOWUPS.md`. Risk = leaks if a registry isn't reset — the reset list is the fix.

**Trigger + Door (one unified object).**
- New **`Trigger` blueprint class** (`blueprintClasses.ts`) — invisible (`hideRect`),
  gravity-off, box **sensor** `Collider` (passThrough), tag `trigger`. Drop-in volume;
  wire `OnOverlap`/`On End Overlap (=OnSeparate)`/`OnOverlapForSeconds`.
- New node **`OnOverlapForSeconds`** (LogicTriggerKind-only — LogicSheetRunner + palette
  + nodeDocs; NOT in shared condition.ts) — fires once after continuous overlap N sec,
  gated on `CollisionScan._currOverlap`. Mirrors `OnKeyHeldFor`'s timer.
- **Door** = a Trigger instance with a `door?: DoorLink` (schema on `BlueprintInstance`,
  `project.ts`): `{ name, destSceneId, destDoor, withLoad, travelerTag, activation:
  instant|delay|input, delaySec, inputAction }`. Runtime `runDoorScan(sprites)` in
  `eval.ts` (called each frame after `runCollisionScan` in `Game.ts`): fires on the
  ENTER edge; **arm-on-exit** for instant/delay (arriving on a door doesn't bounce);
  **input mode is exempt** (no leave/re-enter — tap key each time; eats the arrival
  frame so a held key across a rebuild doesn't bounce). SAME-scene link = in-place
  teleport (no reload). Cross-scene = `emitGoToScene`/`WithLoad` + `setPendingEntry`
  (PersistentState) → arrival reposition of the traveler-tagged sprite in `runProject`
  (after spawn, before sceneReady gate). Door panel + input-action dropdown in
  `InstanceInspector.tsx` (shown when the BP `classKind === "Trigger"`).

**Scale sync fix (Tracer + Shadow).** A BP scaled via the **w/h "blueprint scale"**
path sizes body+art but leaves `gameObject.scaleX = 1`. Tracer/Shadow folded only
`obj.scaleX`, so a bed shrunk to 0.6 kept a full-size (over-reaching) tracer. FIX:
`runProject` stamps `sprite._renderScaleX/_renderScaleY` (the w/h-derived scale);
Tracer `_calcGeom` + Shadow fold `abs(obj.scaleX) × _renderScaleX`. ALSO: the tracer
DETECTION samplers used raw `boxThickness` while `_calcGeom` scaled it → detection box
had wrong thickness (offset from drawn). New `_scaledThick()` routes all samplers
(`_sample`/`_sampleAll`/`_placementHits`/`_tilemapHitInto`/`mineBox`/tile-collect)
through the scaled thickness. Now drawn == detected at any scale.

**Scene gizmo now edits `scaleX/scaleY`** (was the hidden `w/h` override) — unifies
with the inspector's Scale X/Y so resizing an instance no longer double-scales
(`SceneEditor.tsx` `bpScale` resize kind, clears `w/h`).

**SetVisible hides the WHOLE BP.** `sprite.manualHidden` is now composed into
SpriteRenderer, Text, **Shadow, LightSource, Outline** visibility.

**Weather shelter.** `killTags` normalizer accepts string|string[] (`_tagList`);
`shelterTags` (fully dry) + `shelterDrizzleTags` (rain falls, splashes removed) block
weather over tagged BPs/tiles; a painted **shelter mask** on the nav grid
(`scene.navMesh.shelter[]`, painted in `NavMeshOverlay.tsx` — blue=1 kills both,
red=2 kills only splashes) is baked to `peaky.shelterMask` and read per-drop in
`Weather.ts`. Weather sprite splashes are marked `peaky.soTransient` so they're NOT
captured for scene persistence (fixed "phantom dizzle sprites on scene entry").

**Tilemap:** editor ghost preview now draws the ACTUAL selected tiles (flipped/rotated
per `brushXf`) under the cursor in BOTH the tilemap editor and the in-scene painter;
in-scene painter got flip/rotate TRANSFORM controls. Big-tile collision-polygon editor
+ palette got zoom. **Culling** now tests the tile IMAGE FOOTPRINT (`origin +
displayWidth/Height`), not just the anchor — fixed big buildings popping out at the edge.

**Also:** `TweenVar`/`TweenParam` (delta lerp a variable or a component param, tag =
`tweenTag` free-text), `OnKeyHeldFor` trigger, `PlaceBigTileAtWorld`/
`PlaceAnimatedTileAtWorld`. Collider face-culling for big-tile polygons was TRIED and
REVERTED (opened real boundaries with partial coverage). A runtime tilemap-collider
debug-draw was added then REMOVED per user.

---

## 0b. Prior session (2026-06-28) — also read + `FOLLOWUPS.md` first

Big additions since the body of this doc was written. The §14 "Recent work" log
below is older (2026-05-10); treat THIS as the current head.

**Runtime persistence (NEW — `PersistentState.ts` is the hub):**
- **Runtime-spawned objects persist.** `CreateObject` stamps a `spawnId`
  (`Sprite.spawnId`, minted by `nextSpawnId()`), and `SaveSlot`/`LoadSlot`
  (`eval.ts`) now RECREATE spawned objects on load instead of skipping them.
  Scale/angle are saved too (fixes "tiny on restart" — an OnCreate scale-tween
  was being cancelled with no restored value).
- **Cross-LEVEL persistence.** Leaving a level (`GoToLayout` family) captures
  spawned objects + runtime sprite objects + **tilemap edits** into
  `PersistentState` keyed by scene id (`captureSpawnedForScene` in eval.ts);
  `runScene` (runProject.ts, `replayCarriedSpawns()` + the tilemap-edit block
  right after) replays them on return. `RestartLayout` deliberately does NOT
  capture (it means "reset this level"). All of it is also folded into
  Save/Load so it survives quitting.
- **Runtime sprite objects** (`CreateSpriteObject`) persist too — marked
  `peaky.soRuntime`, captured via `collectRuntimeSpriteObjects` (eval.ts).
- **Tilemap persistence.** `TilemapRenderer.serialize()/deserialize()` (NEW)
  diff mined/placed tiles vs an `_authoredTiles` snapshot, capture ALL BigTile +
  animated placements, and partial-damage HP. The tilemap host is in
  `peaky.sprites` with a stable `instanceId`, so SaveSlot/LoadSlot drive it
  automatically; level changes route the same payload through
  `PersistentState.tileEditsByScene`.

**New tile actions/nodes:** `PlaceBigTileAtWorld`, `PlaceAnimatedTileAtWorld`
(place-at-cursor; `eval.ts` + the usual ~8 registration spots). The Logic Sheet
node config has a **visual BigTile/Animated picker** (reuses `BigTilePreview`)
and the id field is a typeable expression input (name / `var:` / wire).
`BigTile` now has a `name` (TilesetTab input); `placeBigTile`/`placeAnimatedTile`
resolve name→id.

**Editor:** `CreateSpriteObject` got a layer dropdown. Autosave is now **3 min**
+ incremental (only rewrites changed asset files — `projectFolderIO.ts`
reference-cache) to stop the multi-second freeze on large projects.

**Lighting + weather (NEW, 2026-06-29):**
- **`LightSource.ts`** — atmospheric glow. A baked additive (`ADD` blend) glow
  texture, NOT Phaser PointLight. `edge` = smooth/hard/noisy/wave (noisy/wave
  clip the rim), `feather`, `flicker`, `offsetX/Y` center (draggable gizmo in
  `BlueprintPreview` mirroring VisionMask). Renders above the ambient darkness.
- **`Weather.ts`** — drop-in rain/snow. `space` screen/world, `mode`
  topdown (varied-height landings) / sidescroller (die on `killTags` against
  tagged BPs + tiles), `splash` simple (pixel crown) / sprite (one-shot anim),
  shape line/circle/sprite, size/speed jitter, rotation, wind. Particles only
  exist in the viewport (world mode wraps the field to the camera). Registered
  in all 7 behavior places.
- **`VisionMask`** now also cuts holes through **Sprite Objects** (placed sprite
  assets), with `peaky.soLayer` stamped on placements for the cutoutLayers filter.
- **BlobShadow was built then removed** (per user); the Weather `preset` field too.
- `BlueprintInspector` got an **`animOf`** param hook so a `spriteAnim` field can
  pick which sibling sprite it lists animations from (Weather splash vs shape).

**Open items + audit findings to revisit** are in **`FOLLOWUPS.md`** (notably
transient-object persistence + tilemap-placement save bloat). Diagnostic
SceneSave/Save/Load log lines are still in `eval.ts`/`runProject.ts` to strip
once persistence is trusted.

---

## 1. What this is

**Peaky Engine** is a browser-based 2D game engine. The goal is a Construct-3
/ GameMaker-style authoring experience built around UE5-flavored mental
models. The user is the sole author; the audience is "people who want to
ship 2D games visually without writing code."

- **Editor**: a React + Zustand SPA that authors a JSON-serializable
  project model. Scene editor, Blueprint editor, event sheets, sprite
  editor, UI widget editor, dialogue editor, content browser, layers
  panel, inspector.
- **Runtime**: Phaser-3 based game engine consumed by the editor's
  "Play" button. The same runtime is what a published game would embed.
- **Shared**: pure-TS types and registries (action / condition / object /
  subject) shared between editor and runtime so the two sides stay
  type-coupled at compile time.

The author works in **Blueprints** ("BPs") — class templates with
visuals + composable behaviors + variables + an event sheet. Instances
of a BP get placed into **scenes**. Logic lives entirely in event sheets
(triggers → conditions → actions).

Code-spawning is supported via `CreateObject` / `CreateObjectByName`
actions but the primary authoring model is visual.

---

## 2. Stack

| Layer        | Tech                                                  |
|--------------|-------------------------------------------------------|
| Game runtime | **Phaser 3.80.1**, arcade physics                     |
| Language     | TypeScript ~5.4 (strict)                              |
| Editor UI    | React 18, Zustand 4, Vite 5                           |
| Node graph   | @xyflow/react 12 (used in a couple of authoring spots)|
| Module type  | ESM throughout                                        |
| Test runner  | None — manual scenario testing only                   |
| OS target    | Browser (Windows dev host)                            |

No native dependencies. No backend. Project files are plain JSON saved
locally (or downloaded as `.peaky.json` from the editor).

---

## 3. Monorepo layout

NPM workspaces (`packages/*`, `examples/*`). Top-level scripts:

```
npm run dev:editor    # vite dev server, opens the editor
npm run dev:demo      # the example-platformer
npm run build         # build every workspace
npm run typecheck     # tsc -b (project references)
```

Three packages:

```
packages/
  shared/   — pure types & registries (no DOM, no Phaser)
  runtime/  — Phaser-based game runtime + behaviors
  editor/   — React editor that imports both
```

### shared (`@peaky/shared`)

- `src/sm/action.ts` — `StateActionKind` union, `ACTION_KINDS`,
  `ACTION_DESCRIPTIONS`, `ACTION_DEFAULTS`, `StateAction` interface.
- `src/sm/condition.ts` — `ConditionKind`, `CompareProperty`,
  `CompareOp`, `Condition` interface.
- `src/sm/objects.ts` — Subject system (the C3-style object picker).
  Contains per-subject **allow lists** (`SYSTEM_ACTION_KINDS`,
  `BP_ACTION_KINDS`, `UIWIDGET_UNIVERSAL_ACTION_KINDS`,
  `MOUSE_ACTION_KINDS`, etc.) and dispatch helpers
  (`conditionKindsForSubject`, `actionKindsForSubject`).
- `src/sm/trigger.ts` — small enum for trigger meta (one-shot vs continuous).
- `src/dialogue/script.ts` — `DialogueAssetSpec`, `DialogueLineSpec`, etc.

### runtime (`@peaky/runtime`)

- `src/Game.ts` — `Peaky.start(...)` boot. Creates Phaser game,
  preloads, instantiates scenes, wires the global EventBus.
- `src/Sprite.ts` (2351 lines!) — the heart of the runtime. Hosts
  behaviors, owns the action queue, drains queued Waits, manages
  per-event state (TriggerOnceWhileTrue / EveryXSeconds / etc.),
  runs picking + ForEach iteration, dispatches conditions/actions.
- `src/Behavior.ts` — abstract `Behavior` base class and the
  `BehaviorKindMap` + `BEHAVIOR_WRITABLE_PARAMS` registry.
- `src/EventBus.ts` — per-sprite event bus with **1-frame
  carryover** (`firedThisFrame` / `firedExactlyThisFrame` /
  `prevTickMatched`) for dedup semantics.
- `src/sm/eval.ts` (5888 lines) — `evalCondition()` and `runAction()`.
  This is where every action kind and condition kind is implemented.
- `src/LogicSheetRunner.ts` (1416 lines) — the runtime for **Logic Sheets**
  (the node-graph authoring surface). Subscribes each trigger node to its
  event and walks the exec edges into `runAction`. This is the PRIMARY logic
  path now; the per-event runner in `Sprite.ts` is the legacy path.
- `src/behaviors/*.ts` — the concrete behavior classes (see §6).
- `src/dialogue/DialogueRunner.ts` — scene-attached dialogue system
  with bubble UI, branching choices.
- `src/input/InputActions.ts` — name-based key bindings ("Jump" →
  ["UP", "W", "SPACE"]) so events reference action names not key codes.
- `src/Logger.ts` — runtime log capture for the editor's console panel.
- `src/OnScreenPrint.ts` — `PrintString` action's overlay text.

### editor (`@peaky/editor`)

- `src/main.tsx` / `src/App.tsx` — React entry. App composes the panels.
- `src/project.ts` (3115 lines) — full project schema. **Read this
  first** if you're confused about the data model.
- `src/store.ts` (8490 lines) — Zustand store. Holds the whole
  `PeakyProject` plus editor state (selection, active tab, undo
  stack, clipboard). Contains `migrateProject` for legacy project
  files. The single biggest editor file by data, though
  `LogicGraphCanvas.tsx` is the largest single source file.
- `src/runProject.ts` (2567 lines) — runtime/editor bridge. Translates
  the editor project into Phaser scenes + spawned sprites + attached
  behaviors. Owns `BEHAVIOR_REGISTRY` and the texture preload pass.
- `src/blueprintClasses.ts` — `BpClass` registry: `"Character" | "Actor" | "Camera"`.
- `src/behaviorMeta.ts` — `BEHAVIOR_PARAMS` map: per-behavior inspector
  field metadata (label, default, type, dependsOn). Drives both the
  Inspector and Get/Set Behavior Param dropdowns.
- `src/panels/SceneEditor.tsx` (1234 lines) — the scene canvas: drag,
  select, marquee, gizmo rendering.
- `src/panels/SpriteTab.tsx` (1977 lines) — sprite asset editor:
  animation editor, image points, frame data.
- `src/panels/UIWidgetTab.tsx` (1002 lines) — UI widget composer.
- `src/panels/DialogueTab.tsx` (757 lines) — dialogue script editor.
- `src/panels/ContentBrowser.tsx` (803 lines) — UE5-style asset browser.
- `src/panels/inspector/LogicSheet/LogicGraphCanvas.tsx` (**4042 lines, the
  largest editor source file**) — the **Logic Sheet** node-graph UI: node
  canvas, the RMB / search node picker (with ACTION/CONDITION categories),
  and per-node configuration. (Replaces the removed event-sheet UI —
  `EventsSection.tsx` is now a 22-line tombstone.)
- `src/panels/inspector/EventsSection.tsx` (22 lines) — tombstone; the
  Event Sheets UI was removed. Kept only so legacy imports resolve.
- `src/panels/inspector/ActionRow.tsx` (1720 lines) — per-action pill
  renderer. Every action kind has a switch case here that returns the
  inline-editable field widgets.

---

## 4. Mental model

A **Blueprint** is a class template:

- Visual defaults (w, h, color, optional hidden rect).
- A `classKind` from `"Character" | "Actor" | "Camera"` — picked at
  creation time; supplies seed defaults but doesn't lock the BP.
- A tag list (`["enemy", "ground"]`) used by `OnCollide`,
  `OnOverlap`, `EmitSignalTo`, picking conditions.
- Variables (per-instance state with `numberKind`, `autoCap`,
  `instanceEditable`, `exposeOnSpawn`).
- Behaviors — the composable transforms / sprites / colliders /
  controllers.
- Events — a tree of `(trigger, guards, actions)` blocks. Sub-events
  nest under a parent; they run AFTER the parent's actions when the
  parent's conditions matched (Construct-3 semantics).
- Event groups + event pages (named tabs of events).

A **Scene** is a layout:

- Width/height (the world size — camera scrolls across it).
- Project-level `viewportWidth/Height` is the canvas size.
- Background color, gravity, `unboundedScroll` flag.
- Layers (ordered top→bottom, each with `parallaxX/Y`, `opacity`,
  `visible`).
- Instances (BP placements with `x, y, w?, h?, scaleX?, scaleY?,
  angle?, alpha?, layerId, instanceVars?`).
- UI instances (UIWidget placements — separate list, no physics body).
- A "main event sheet" addressed via the sentinel id
  `__main__:<sceneId>` so scene-scoped global logic uses the same
  event-sheet plumbing as BPs.

Authors mostly work in either: a Blueprint's event sheet, the Main
Sheet, or the Scene Editor.

---

## 5. Runtime architecture

### 5.1 Sprite — the host

Every placed BP becomes a `Sprite`. It owns:

- A Phaser body (`gameObject` — usually a `Rectangle` or a
  `Container` for sprite-rendered BPs).
- A `behaviors[]` list. Each behavior has `attach(sprite, config)`,
  `init()`, `update(delta)`, optional `serialize()` / `deserialize()`
  / `applyLayer()` / `onDestroy()` hooks.
- A per-sprite `EventBus` for signals + carryover dedup.
- Per-event state (`firedThisFrame`, `prevTickMatched`,
  `everyLastFiredSec`, `prevAnimFinished`, `inFlightUntil`,
  `stopLoop`).
- An **action queue** with deferred actions from `Wait`,
  `WaitRealtime`, and `WaitForSignal`.
- A tween map keyed by tween tag.
- Camera-route hooks for overlay GameObjects (SR image, Text label,
  Particles).

### 5.2 The tick (Sprite.update)

Per Phaser frame, every Sprite runs:

1. `scaledDelta = delta * scene.time.timeScale`. The sim clock
   advances by `scaledDelta / 1000`. Behaviors that gate gameplay
   read this scaled value so `SetTimeScale 0` freezes motion,
   input replay, animation frames, etc.
2. Behaviors update (`update(delta)`), gated by `Behavior.enabled`
   AND (when paused) `Behavior.tickDuringPause`. UI-side behaviors
   override `tickDuringPause = true` so pause menus stay live.
3. Emit `OnMoved` / `OnStopped` / `OnJump` / `OnLand` / `OnFall`
   edges based on previous-frame state.
4. **`drainQueue()`** — runs every tick now, even during pause. See §5.5.
5. **Process events** — iterate the BP's events in priority order,
   match conditions, run actions (or queue them if there's a `Wait`).
6. Apply per-event state transitions.

### 5.3 EventBus and dedup

`packages/runtime/src/EventBus.ts` is a per-sprite signal bus. The
critical part is the **1-frame carryover**: a signal emitted on
frame N stays "firing" into frame N+1's condition check, but
`firedExactlyThisFrame` returns true only on N. Combined with
`prevTickMatched` on each event state, this powers:

- `TriggerOnceWhileTrue` — fires on the rising edge of "all
  conditions match" instead of every tick.
- `OnCollide` / `OnOverlap` — survive both into-the-frame ordering
  AND avoid double-firing when the same pair re-collides next frame.
- `OnSignal` — fires once when the signal arrives, doesn't re-fire
  on the carryover frame.

If you're touching trigger semantics, **understand both
`firedThisFrame` (carryover-tolerant) and `firedExactlyThisFrame`
(edge-only)** before changing anything.

### 5.4 Picking and ForEach

C3-style picking is implemented in `Sprite.processEvents`. Conditions
like `PickAll`, `PickByComparison`, `ForEach`, `PickRandom`,
`PickByHighest/Lowest`, `PickNth` populate a per-event Sprite
Object List (SOL). Subsequent conditions filter the SOL; actions
run on each member. Each ForEach iteration gets its own
`chainId` so a queued Wait→Action chain that targets a sprite
which dies mid-flight evicts ONLY that iteration's tail (not
sibling chains on other live targets).

Queue items carry `targetUid` so when a `Wait` elapses on a chain
that was iterating ForEach, the action lands on the right sprite
(or is dropped if the target died).

### 5.5 The action queue — Wait, WaitRealtime, WaitForSignal

This is the most subtle piece of the runtime. The queue is shared
between three "delay" actions:

| Action          | Gate                                                   |
|-----------------|--------------------------------------------------------|
| `Wait`          | `runAtSec` — sim clock (`this.clock`). Advanced by `delta * timeScale`. Freezes when timeScale = 0. |
| `WaitRealtime`  | `runAtRealMs` — wall clock (`scene.game.loop.time`). Advanced regardless of timeScale. |
| `WaitForSignal` | `runAtSec = Infinity` + `awaitSignal`. Released when the signal fires (within `AWAIT_SIGNAL_TIMEOUT_SEC = 30s`). |

Each queue item carries BOTH `runAtSec` and an optional
`runAtRealMs` (only set when the chain used `WaitRealtime`). An
item fires when BOTH gates are elapsed. This composes naturally:

- A pure `Wait`-chain has `runAtRealMs === undefined` → only sim gate
  matters → identical legacy behavior.
- A pure `WaitRealtime`-chain has `runAtSec === clockAtBuild` (already
  elapsed by next tick) → only real gate matters → unaffected by pause.
- A mixed chain takes the slower-elapsing of the two (intuitive).

**`drainQueue()` now runs every tick, even during pause.** Sim-gated
items hold naturally because `clock` is frozen. Real-gated items keep
ticking. This is what makes the unpause trick work:

```
SetTimeScale 0 → WaitRealtime 0.2 → SetTimeScale 1
```

The queue is sorted by `(runAtSec, runAtRealMs)` with a stable sort
so a chain like `WaitRealtime 0.2 → SetX → WaitRealtime 0.1 → SetY`
fires SetX before SetY (both share `runAtSec`, secondary key
disambiguates, insertion order ties).

### 5.6 Save/Load

Behaviors opt in by implementing `serialize() / deserialize()`. The
host Sprite snapshots its scalar state (position, velocity, angle,
scale, alpha, variables, behavior payloads). Load path calls
`clearRuntimeState()` to drop queues + tweens + per-event states +
the bus, then re-applies. CharacterMovement persists `jumpsUsed`
etc.; SpriteRenderer persists `currentAnimation`. In-flight effects
(active dashes, tweens, particle bursts) are intentionally NOT saved.

---

## 6. Behaviors

There are **11 behaviors** (`packages/runtime/src/behaviors/`).
Every behavior is registered in three places:

1. `BehaviorKindMap` in `packages/runtime/src/Behavior.ts` —
   compile-time string-to-class map for `findBehaviorByKind`.
2. `BEHAVIOR_WRITABLE_PARAMS` in the same file — runtime allow-list
   for which params `SetBehaviorParam` may write.
3. `BEHAVIOR_REGISTRY` in `packages/editor/src/runProject.ts` —
   editor-side constructor map.
4. `BEHAVIOR_PARAMS` in `packages/editor/src/behaviorMeta.ts` —
   inspector field metadata.
5. `BEHAVIOR_DEFAULTS` in `packages/editor/src/project.ts` —
   default config at attach time.
6. `KNOWN_KINDS` in `packages/editor/src/store.ts`'s `migrateProject`
   — strips unknown behaviors on project load.
7. `BehaviorKind` union in `packages/editor/src/project.ts`.

**Adding a new behavior = touching all seven places.** Forgetting
any one of them causes silent breakage:

- Missing in `BEHAVIOR_WRITABLE_PARAMS` → `SetBehaviorParam` no-ops.
- Missing in `BEHAVIOR_REGISTRY` → editor crash when spawning a BP
  that carries the behavior.
- Missing in `BEHAVIOR_PARAMS` → no inspector fields.
- Missing in `KNOWN_KINDS` → behavior gets stripped on next project
  load.
- Missing in `BEHAVIOR_DEFAULTS` → instances spawn with empty config.

### 6.1 Solid (12 lines)
World geometry. Marks the host's body as static. Other bodies collide
against it. No config.

### 6.2 JumpThru (22 lines)
One-way platform. Other bodies pass through from below, land on top.
Used with CharacterMovement.

### 6.3 CharacterMovement (654 lines)
The big one. Topdown / platformer controller. Handles:

- Walk (left/right input via named Input Actions, mirror modes,
  smooth-mirror tween).
- Jump (multi-jump, coyote time, jump buffer, variable height,
  jump sustain).
- Dash (delay → duration → cooldown; air-dash supported).
- Wall (slide speed, wall-jump kick, requires-input vs on-contact).
- Gravity (magnitude, angle, fall multiplier, max fall speed,
  ceiling mode).
- Custom event triggers (`leftEventTrigger: "MyOnLeft"` fires that
  event when the input is pressed — lets authors layer custom
  movement on top).
- All params writable at runtime via `CMSet` / `CMSet*` actions.
- Serializes `jumpsUsed`, `dashing`, `dashReadyAtSec`.

Lots of inspector fields. See `behaviorMeta.ts` for the full list
(~60 params).

### 6.4 SpriteRenderer (401 lines)
Overlays a Phaser `Image` (or animated `Sprite`) on the host body.

- Frame data is held by sprite assets (`PeakyProject.sprites`); SR
  carries a `spriteId` reference.
- Animation: `currentAnimation`, `playing`, `speed`, per-frame
  duration overrides, ping-pong, loop, finished-emitted edge for
  `OnAnimationEnd`.
- Stamps `frameEnteredAtTick` whenever the displayed frame index
  changes — `CompareFrame` reads this for edge detection (without
  it, a 12fps animation visiting frame 4 would match the condition
  5× at 60fps).
- Image points: named anchor points per frame, looked up via
  `getImagePointWorld(name)`. Used by Tracer pivot, ParticleEmitter
  spawn point.
- `applyFrame` bakes `facingScaleX` + `squashX/Y` (from
  SquashStretch) into the overlay's scale. Per-tick `syncOverlay`
  syncs position/rotation/alpha back to the host.

### 6.5 Collider (61 lines)
Customizes the host's physics body shape (width, height, offsetX/Y).
Optional `collideWorldBounds`. Without this behavior, the BP body
size === the BP visual size.

### 6.6 Text (214 lines)
Renders a Phaser `Text` overlay on the host. Fields: `content`,
`fontFamily`, `fontSize`, `color`, `bold`, `italic`, `align`,
`vAlign`, `wrapWidth`, `visible`, `alpha`, `offsetX`, `offsetY`.

- Supports `{var:name}` and `{self.x}` interpolation in `content`.
- `syncOverlay` updates the Phaser text each tick; the host
  rectangle is usually `alpha = 0` (`hideRect: true` on the BP).

### 6.7 Camera (341 lines)
Scene-camera controller. **Only one Camera BP per scene** by
convention. Auto-attached to BPs created with `classKind: "Camera"`.

- Target modes: `"self"` (follows the host BP), `"tag"` (follows
  first sprite carrying tagTarget), `"none"` (free pan).
- Smoothing (lerp factor), per-axis follow toggles, directional
  offsets (offsetLeftX / offsetRightX / offsetY), deadzone, zoom,
  layout-bounded scroll, lock flag for cutscenes.
- Shake, flash, fade, pan (smooth tween + `OnCameraPanEnd` edge).
- Action surface: `CameraSetTarget`, `CameraShake`, `CameraFlash`,
  `CameraFade`, `CameraPanTo`, `CameraPanToTag`, `CameraLock` /
  `Unlock`, etc.

A Camera-class BP's host rectangle is set invisible. (There's a
plan — see §13 — to make it inert via `setAllowGravity(false)` +
`setImmovable(true)` so the body doesn't drift, and to render a
distinct dotted-outline gizmo in the editor.)

### 6.8 Tracer (397 lines)
Line / box / circle hit-detection geometry attached to a sprite.
Used for melee attacks, line-of-sight checks, etc.

- Shape: line / box / circle. Pivot at host or named image point.
- `triggerMode`: `manual` (emit signal to fire once) / `interval`
  (every N sec) / `continuous` (every tick).
- `tagFilter`: only hits sprites carrying these tags.
- Emits `_tracerHit` (signal) on the sprite that owns the tracer +
  on the hit target (`TracerJustHit` is the edge condition).
- `TracerGetResult` action copies hit-data into a var on the
  caller.
- Optional `debugDraw` renders the tracer geometry.

### 6.9 SquashStretch (199 lines)
Cartoon-style deform-and-return. Bakes `squashX / squashY` onto the
host's sprite scale; SpriteRenderer's `applyFrame` composes them in.

- Inspector fields: `intensity`, `duration`, `easing`, `emitOnEnd`.
- Action: `PlaySquashStretch { kind, intensity, duration, easing }`
  where kind is "both" (squash → stretch → return) / "squash" /
  "stretch". Per-call params override behavior defaults.

### 6.10 UIWidgetRenderer (742 lines)
The runtime side of UI widgets. UI widgets are screen-space
elements (HUD, buttons, sliders, dropdowns, progress bars,
images, labels). The widget instance has a `widgetKind`
(`label | button | slider | progress | dropdown | image | container`)
and a giant field list (bg color, border, padding, corner radius,
shadow, anchor, text props, click signals, value/min/max for
slider, dropdown options, etc.).

- Always `tickDuringPause = true` so pause menus stay interactive.
- Routes to the dedicated UI camera so it stays crisp when the
  main camera has BlurScene applied.

### 6.11 ParticleEmitter (598 lines, **recent**)
Wraps Phaser's particle emitter. Most fields below come from
Construct-3 conventions:

- Emission: `mode: "continuous" | "burst"`, `rate`, `burstCount`,
  `maxParticles` (cap kept at 0 / unlimited at creation — see
  §10), `enabled` (the inspector toggle; captured into private
  `_running` to survive the runProject clobber — see §11.1),
  `spriteId`, `delay`, `pivotSource: "host" | "imagePoint"`,
  `imagePointName`, `spawnJitterX/Y`.
- Lifetime / movement: `lifetime`, `lifetimeJitter`, `speed`,
  `speedJitter`, `angleMin/Max`, `gravityX/Y`, `friction`,
  `rotationStart/End/Jitter` (jitter handled via Phaser onEmit /
  onUpdate callbacks).
- Visual: `scaleStart/End`, `alphaStart/End`, `tintStart/End`,
  `blendMode`, `frameMode: "first" | "random"`.
- Actions: `StartParticles`, `StopParticles`, `BurstParticles`,
  `SetParticleRate`, `SetParticleSpeed`, `SetParticleGravity`,
  `SetParticleSprite`.
- Conditions: `IsEmittingParticles`, `IsParticleEmitterEnabled`,
  `OnParticleBurstEnd` (edge: alive count high→0), `CompareParticleCount`.
- `_lastImagePointPos` caches the last successful image-point
  lookup so multi-frame animations where the named point only
  exists on some frames keep emitting from "where the point was
  last seen" during gap frames, instead of alternating between
  the point and the host pivot.
- `runProject` injects `_textureKey` and `_frameKeys` based on
  the chosen `spriteId`.

---

## 7. Action system

`StateActionKind` is currently **~100 kinds** (see
`packages/shared/src/sm/action.ts`). Categories:

- **Lifecycle**: `Destroy`, `CreateObject`, `CreateObjectByName`,
  `SortZOrder`.
- **Variables**: `SetVar`, `AddVar`, `SubVar`, `SetBool`, `ToggleBool`.
- **Flow control**: `Wait`, `WaitRealtime`, `WaitForSignal`,
  `StopLoop`, `SetEventGroupEnabled`.
- **Time**: `SetTimeScale`.
- **Signals**: `EmitSignal`, `EmitSignalTo`, `SetVarOn`.
- **Behavior**: `SetBehaviorParam`, `SetBehaviorEnabled`.
- **Transform** (instant): `SetPosition`, `SetPositionX/Y`,
  `SetAngle`, `SetScale`, `SetScaleX/Y`, `SetOpacity`,
  `MoveToLayer`, `SetZOrder`.
- **Velocity**: `SetVelocityX`, `SetVelocityY`.
- **Animation**: `PlayAnimation`, `StopAnimation`, `SetFrame`,
  `SetAnimationSpeed`.
- **CharacterMovement**: ~22 kinds (`CMJump`, `CMDash`,
  `CMSetMaxSpeed`, `CMSet`, etc.).
- **Text**: `SetText`, `AppendText`, `SetFontFamily`,
  `SetFontSize`, `SetTextColor`, `SetBold`, `SetItalic`,
  `SetAlignH/V`, `SetWrapWidth`, `SetTextVisible`, `ShowText`,
  `HideText`.
- **Camera**: ~16 kinds (see §6.7).
- **Tracer**: `TracerGetResult`.
- **Tween**: `Tween`, `TweenSetEndValue`, `TweenStop`, `TweenStopAll`,
  `TweenPause`, `TweenPauseAll`, `TweenResume`, `TweenResumeAll`.
- **Dialogue**: `PlayDialogue`, `StopDialogue`.
- **SquashStretch**: `PlaySquashStretch`.
- **UI widget**: `SetUIText`, `SetUIValue`, `SetUISelectedValue`,
  `SetUIVisible`, `SetUIBgColor`, `CreateUIWidget`, `DestroyUIWidget`.
- **Particles**: `StartParticles`, `StopParticles`, `BurstParticles`,
  `SetParticleRate`, `SetParticleSpeed`, `SetParticleGravity`,
  `SetParticleSprite`.
- **Scene / layout**: `GoToLayout`, `RestartLayout`,
  `GoToNextLayout`, `RecreateInitialObjects`, `ScrollToObject`,
  `ScrollToPosition`, `SetLayoutScale`, `SetCursor`, `ResetCursor`,
  `HideCursor`, `ShowCursor`.
- **Save/Load**: `SaveSlot`, `LoadSlot`.
- **Other**: `SetColor`, `SetSize`, `Log`, `PrintString`, `QuitGame`,
  `BlurScene`.

Every action has:

- A `StateActionKind` entry in the union.
- A row in `ACTION_KINDS[]`.
- A description in `ACTION_DESCRIPTIONS`.
- A default config shape in `ACTION_DEFAULTS`.
- Membership in one or more **subject allow-lists** in
  `packages/shared/src/sm/objects.ts` (otherwise the action picker
  filters it out).
- A handler in `eval.ts`'s `runAction` switch (or a queue-handled
  no-op like `Wait`).
- A category entry in `ACTION_CATEGORIES` (or `SYSTEM_ACTION_GROUPS`
  for system kinds) in `EventsSection.tsx`.
- An inline-pill renderer in `ActionRow.tsx`.
- A one-line summary in `EventsSection.tsx`'s `actionSummary`.

**Adding a new action kind = touching ~8 places.** See §9 for the
exact recipe.

---

## 8. Condition system

`ConditionKind` is currently **~75 kinds** (see
`packages/shared/src/sm/condition.ts`). Two flavors:

- **Triggers** (one-shot per frame): `OnCreate`, `OnKeyPressed`,
  `OnCollide`, `OnOverlap`, `OnAnimationEnd`, `OnAnyAnimationEnd`,
  `OnLand/Jump/Fall`, `OnDashStart/End`, `OnMoved/Stopped`,
  `OnSignal`, `OnSceneStart/End`, `OnSaveLoadComplete`,
  `OnMouseButtonPressed/Released`, `OnMouseClick`,
  `OnMouseDoubleClick`, `OnMouseWheel`, `OnObjectClicked`,
  `OnObjectDoubleClicked`, `TracerJustHit`, `OnTweenStart`,
  `OnTweenFinish`, `OnCameraPanEnd`, `OnParticleBurstEnd`.
- **State checks** (continuous): `Always`, `OnStep`, `OnKeyHeld`,
  `IsMouseButtonHeld`, `IsCursorOverObject`, `TriggerOnceWhileTrue`,
  `Compare`, `CompareValues`, `CompareTime`, `IsBetween`,
  `IsBoolean`, `EveryXSeconds`, `ObjectUIDExists`, the picking
  conditions (`PickAll`, `PickByComparison`, `PickRandom`,
  `PickByHighest`, `PickByLowest`, `PickNth`, `ForEach`), motion
  predicates (`IsMoving`, `IsMovingLeft/Right/Up/Down`,
  `IsFacingLeft/Right`, `IsRunning`), CharacterMovement state
  (`IsGrounded`, `IsJumping`, `IsFalling`, `IsDashing`,
  `IsWallSliding`, `IsByWall(Left/Right)`, `CanJump`, `CanDash`,
  `IsDoubleJumpEnabled`), `IsBehaviorEnabled`, `CompareCMParam`,
  `IsAnimationPlaying`, `CompareFrame`, `IsSignalFiring`,
  `IsActionHeld`, `CompareText`, `IsTextVisible`, `IsCameraShaking`,
  `IsCameraPanning`, `IsCameraLocked`, `CompareCameraZoom`,
  `IsTracerHit`, `TracerHitHasTag`, `IsTweenPlaying`,
  `IsTweenPaused`, `IsAnyTweenPlaying`, `IsEmittingParticles`,
  `IsParticleEmitterEnabled`, `CompareParticleCount`, `Else`.

Conditions support `negated`. `Compare` reads enum properties
(`velocity.x`, `position.x`, `angle`, `scale`, etc.). `CompareValues`
is the universal two-value compare — both sides can be literals or
expressions (`var:Player.hp`, `picked.x`, `self.vx`, `mouse.y`).

**Adding a new condition kind** has a similar 7-place footprint to
actions: union, allow-list, category, picker UI, eval handler,
inline pill, summary.

---

## 9. Picker plumbing — the "magic registries"

This is the part most likely to bite you. The picker UI lives in
`EventsSection.tsx`. There are **two filters in series**:

1. **Subject allow-list** — `actionKindsForSubject(subjectKind)` /
   `conditionKindsForSubject(subjectKind)` in `objects.ts`. Reads
   from `SYSTEM_ACTION_KINDS`, `BP_ACTION_KINDS`,
   `UIWIDGET_UNIVERSAL_ACTION_KINDS`, `MOUSE_ACTION_KINDS`,
   `KEYBOARD_ACTION_KINDS` (and condition counterparts).
2. **Category list** — `ACTION_CATEGORIES` / `CONDITION_CATEGORIES`
   in `EventsSection.tsx`. Groups kinds by left-rail label. The
   System category is sub-grouped by `SYSTEM_ACTION_GROUPS`.

A kind has to be in BOTH the subject list AND a category to show up.
If you added an action and it's invisible, check both.

There's also behavior-gating: when the subject is a specific BP, the
category list filters by whether the BP carries the matching behavior
(`hasCM`, `hasSR`, `hasCamera`, `hasTracer`, etc.). UI widgets get a
separate allow-list (`UI_VISIBLE_ACTION_CATS`,
`UI_VISIBLE_COND_CATS`).

**Pickers use a 3-step modal:** Subject → Kind → Configure. The store
remembers the last-used subject (`setActionSubject` / similar) so the
picker re-opens on the same subject.

---

## 10. Adding new things — recipes

### Adding a new action kind

1. Add to `StateActionKind` union — `packages/shared/src/sm/action.ts`.
2. Add to `ACTION_KINDS[]` array (same file).
3. Add to `ACTION_DESCRIPTIONS` (same file).
4. Add to `ACTION_DEFAULTS` (same file).
5. Add to the right subject allow-list in
   `packages/shared/src/sm/objects.ts`
   (`SYSTEM_ACTION_KINDS` / `BP_ACTION_KINDS` /
   `UIWIDGET_UNIVERSAL_ACTION_KINDS` / etc.).
6. Implement handler in `packages/runtime/src/sm/eval.ts`'s
   `runAction` switch.
7. Add to `ACTION_CATEGORIES` in
   `packages/editor/src/panels/inspector/EventsSection.tsx`
   (and `SYSTEM_ACTION_GROUPS` if it lives under System).
8. Add inline-pill renderer in
   `packages/editor/src/panels/inspector/ActionRow.tsx`.
9. Add summary in `EventsSection.tsx`'s `actionSummary`.

Skip any step and the action will be **invisible**, **invalid at
load**, **silently no-op**, or **rendered as a generic placeholder**.

### Adding a new condition kind

Mirror of action: union, allow-list, eval, picker category, pill,
summary. See `WaitRealtime` (action) or `OnParticleBurstEnd`
(condition) commits for the canonical worked example.

### Adding a new behavior

See §6 — seven places.

---

## 11. Critical footguns (read before editing)

### 11.1 The `enabled` field collision

`Behavior` base class has a field `enabled = true` that controls
whether `update()` runs each tick. `runProject` clobbers this AFTER
`attach`:

```ts
sprite.addBehavior(Ctor, cfg);
if (sprite.lastBehavior) {
  sprite.lastBehavior.enabled = b.enabled !== false;   // <— this
  sprite.lastBehavior.applyLayer(...);
}
```

If a behavior exposes its own `enabled` inspector toggle (like
ParticleEmitter's "Emit On Start"), the user's choice is lost —
`Object.assign` sets `this.enabled` from config, then this line
resets it to `true`.

**Fix pattern** (used in ParticleEmitter):

```ts
class ParticleEmitter extends Behavior {
  enabled = true;          // inspector field name — keeps saved configs working
  private _running = true; // the "real" flag

  init() {
    this._running = !!this.enabled;  // capture BEFORE runProject clobbers
    // ... all internal logic gates on _running, not this.enabled
  }
}
```

Do not rename the inspector field — the user's existing JSON saves
key off `enabled`. Keep the field, copy into a private flag in
`init()`, gate all logic on the private flag.

### 11.2 `ExpressionField.onChange` returns a STRING

`ExpressionField` is the free-text expression input used in most
action pills. Its `onChange` signature is `(next: string) => void`.
Code that does:

```jsx
<ExpressionField
  value={typeof cfg.x === "number" ? cfg.x : 0.3}
  onChange={(n) => onChange({ ...cfg, x: n })}
/>
```

is buggy: the moment the user types anything, `cfg.x` becomes a
STRING, the next render's `typeof` check fails, and the field
snaps back to the default. **Always pass the value through
directly** with a fallback:

```jsx
<ExpressionField
  value={cfg.x as string | number | undefined}
  onChange={(n) => onChange({ ...cfg, x: n })}
/>
```

The runtime's `numOr` / `strOr` helpers resolve the string at tick
time (supports literals, `var:BP.field`, `picked.x`, `self.x + 50`,
`mouse.y`, etc.).

### 11.3 `Wait` freezes during pause

`Wait` uses sim clock. If you do `SetTimeScale 0 → Wait 0.2 →
SetTimeScale 1`, the chain freezes forever. Use `WaitRealtime` to
unpause from inside a paused world. See §5.5.

### 11.4 Picker invisibility

Action / condition added but not showing in the picker?

1. Did you add it to a `*_ACTION_KINDS` / `*_CONDITION_KINDS` list
   in `objects.ts`? Subject filter strips anything that isn't.
2. Did you add it to `ACTION_CATEGORIES` / `CONDITION_CATEGORIES`?
   Not in a category = nowhere to surface.
3. If it's a System action — also `SYSTEM_ACTION_GROUPS`.

### 11.5 Migration policy: there is none

The user has stated: **"we are testing, no migration."** Don't write
shims to rename fields, migrate legacy configs, or coerce old saves.
If you change a field name or schema, accept that existing saves
break and tell the user. They'll just re-save.

The exception is `KNOWN_KINDS` in `store.ts`'s `migrateProject` — it
strips behaviors with kinds not in the list. Forgetting to add a new
behavior here means it gets deleted on every reload.

### 11.6 Behaviors that own a Phaser GameObject must route the camera

`SpriteRenderer`, `Text`, `Tracer` overlay, and `ParticleEmitter` all
call `this.sprite.routeOverlayToCamera(go)` so overlays render on
the same camera as the host (main vs UI). Skip this and `BlurScene`
applies postFX to the main cam but the UI cam draws a sharp ghost
copy.

### 11.7 Behaviors that own overlays must `applyLayer`

Layer changes (visibility, parallax, alpha, depth) propagate through
`applyLayer(scrollX, scrollY, baseDepth, alpha, visible)`. Behaviors
with secondary GameObjects must override this; otherwise their
overlays ignore the layer's parallax, opacity, and depth band.

### 11.8 Particle pool cap

Setting `maxParticles` AFTER creation doesn't reliably grow the
underlying pool — Phaser allocates lazily at first emission and the
cap is sticky. ParticleEmitter passes `maxParticles: 0` at
**creation time** so the pool grows freely; the user's
`maxParticles` field is advisory only. Memory stays bounded by
`rate × lifetime` naturally.

### 11.9 EventBus 1-frame carryover

A signal emitted on frame N persists into frame N+1's condition
match. This is what makes "edge → handler in another sprite" work
even when the emitter runs after the receiver in tick order. But it
means **edge triggers must check `firedExactlyThisFrame`** (or use
`prevTickMatched` dedup) — checking `firedThisFrame` will match
twice. `OnCollide` / `OnOverlap` / `OnSignal` all do this.

---

## 12. Major subsystems

### 12.1 Tweens

`Tween` action wraps Phaser tweens. Every tween has a **tag**, and
the runtime keeps a `tweens` map keyed by `${tag}|${property}`.
Reissuing a tween with the same tag+property cancels the prior one
(dedup). Pause / Resume / Stop work by tag. `OnTweenStart` and
`OnTweenFinish` are edges fired on the host sprite.

### 12.2 Dialogue

`PlayDialogue` runs a `DialogueAsset` through `DialogueRunner`. The
runner displays the bubble UI (overhead-of-speaker or fixed-at-box).
Branching choices supported. Advance via the `dialogueAdvance` input
action. `StopDialogue` cancels.

Default styling lives at the project level
(`PeakyProject.dialogueDefaults`), per-asset overrides win.

### 12.3 UI widgets

Authored in `UIWidgetTab.tsx`. Each widget has a `widgetKind`:
`label | button | slider | progress | dropdown | image | container`.
Container widgets carry children with their own widget defs.

UI widgets render via `UIWidgetRenderer` behavior. Placed in a scene
via `SceneData.uiInstances` (separate from gameplay BPs). Routed to
the dedicated UI camera (parallax 0,0). `tickDuringPause = true` so
pause menus stay live.

Click / hover / value-change emit signals (`signalOnClick`,
`signalOnChange`, etc.). Bind them via `OnSignal` triggers.

### 12.4 Sprite assets

`SpriteAsset` carries multiple `SpriteAnimationDef`s. Each animation
is a list of `SpriteFrame`s (image data-URL + per-frame duration +
image points). Frame textures are uploaded into Phaser's loader
under stable keys `sprite:<assetId>:<animId>:<frameIdx>` — that's
the key SpriteRenderer and ParticleEmitter both use.

### 12.5 Input actions

Project-level mapping of action name → key codes. Authoring uses
the name; rebinding keys never breaks events. See
`packages/runtime/src/input/InputActions.ts`. Phase 6 (not yet)
adds gamepad bindings.

### 12.6 Signals

Project-level `SignalDef[]` registers user-defined signal names
(autocomplete in the inspector). The runtime allows ad-hoc signal
names too — `EmitSignal "foo"` works without a declared signal.
Behavior-emitted notifications (OnLand, OnJump) are NOT signals —
they have their own trigger kinds.

### 12.7 Save / Load

Slot-based: `SaveSlot { name: "slot1" }` snapshots the scene state;
`LoadSlot` restores. Sprites round-trip their scalar transform +
variables + each opted-in behavior's `serialize()` payload. Tweens,
particle bursts, dashes-in-flight are intentionally NOT saved.

### 12.8 Layers

Each scene has an ordered layer list `[topmost → bottommost]`. Each
layer has `parallaxX/Y`, `opacity`, `visible`. Instances reference a
layer by id. `MoveToLayer` action moves an instance at runtime.
`SetZOrder` adjusts depth within a layer.

UI widgets typically live on a parallax-(0,0) layer at the top so
they sit above the gameplay layers.

### 12.9 Multi-tag system

`EmitSignalTo` and `SetVarOn` accept multiple tags (TagChips UI).
The action fans out to every sprite that has ANY of the tags. Empty
tag list = no-op (don't accidentally broadcast to everyone).

---

## 13. Camera BP lockdown + transform propagation (PLANNED, NOT DONE)

There's a saved plan in `C:\Users\sabap\.claude\plans\magical-kindling-zebra.md`
covering two related cleanups. Not implemented yet:

1. **Camera BP lockdown**:
   - +Component dropdown shows nothing on a Camera-class BP.
   - Camera component is undetachable on a Camera BP.
   - Editor draws Camera BPs as a dotted outline with a camera glyph
     (not a colored solid).
   - Runtime: Camera BP body gets `setAllowGravity(false)` +
     `setImmovable(true)` so the rectangle stays put while the
     viewport follows targets via Camera behavior's `startFollow`.

2. **Transform propagation to overlays**:
   - SpriteRenderer + Text overlays inherit parent scale, rotation,
     alpha (currently only inherit position).
   - Offsets scale with parent.
   - Tracer / UIWidgetRenderer excluded (different concerns).
   - No per-component "fixed scale" opt-out in v1.

If the user asks about Camera BPs being detachable, or scaling a
player making the SR/Text overlay desync, this is the unstarted work.

---

## 14. Recent work (last session, 2026-05-10/11)

In this session we did, in chronological order:

1. **Multi-select in viewport + Delete key** (SceneEditor.tsx) —
   rectangle marquee, Ctrl+click toggle, Delete removes selection.
2. **BP state preservation between scene loads** — selection /
   active tab / inspector state survive scene switches.
3. **Play button auto-switches to Scene view** when activated.
4. **Drag-jump fix** — dragging a BP no longer offsets it from cursor.
5. **Multi-select for events / conditions / actions** in event
   sheets. Ctrl+X / Ctrl+V works across the picker.
6. **Editor cleanups** — Compare condition's deprecated vars dropped;
   behavior-gated pickers cleaned up; UI widget restriction.
7. **Camera fixes** — smoothing default changed to 0.5,
   `roundPixels = false`, lerp used in `startFollow` for smooth
   tracking.
8. **Multi-tag in EmitSignalTo / SetVarOn** — TagChips UI; runtime
   matches ANY-of.
9. **Particle system (Waves 1-3)** — `ParticleEmitter` behavior, 25
   inspector fields, 7 actions, 4 conditions. Auto-burst on ready
   when mode = "burst". Image-point spawning with last-seen cache.
   Texture key resolution and `_frameKeys` injection from
   runProject.
10. **CompareFrame edge fix** — SR stamps `frameEnteredAtTick`;
    eval checks the stamp so the condition fires once per frame
    visit, not every tick.
11. **Collide/Overlap consolidation** — `peaky.collideTracker` Map
    edge-detects per-pair entries; `prevTickMatched` +
    `firedExactlyThisFrame` dedup mirrors the OnSignal pattern.
12. **`var:BP.x` extended** — cross-BP property reads support
    `x`, `y`, `vx`, `vy`, `angle`, `scale`, `alpha`, `uid` in
    addition to user variables.
13. **Particle bug fixes** — `maxParticles: 0` at creation so bursts
    don't recycle each other; `_lastImagePointPos` to stop
    "alternating point vs pivot" emission; rotation jitter via
    onEmit/onUpdate; texture preload now collects from
    ParticleEmitter not just SpriteRenderer.
14. **"Emit On Start" toggle fix** — added `_running` private flag,
    captured in `init()` before runProject's `enabled` clobber.
    All internal "should I emit?" checks now gate on `_running`.
    Inspector field name stays `enabled` (saved configs keep
    working). `burst()` removed the enabled gate so manual
    `BurstParticles` actions fire regardless of "Emit On Start".
15. **SquashStretch duration/intensity input freeze fix** —
    `ActionRow.tsx` was doing `typeof cfg.duration === "number" ?
    cfg.duration : 0.3` which discarded the string the user typed
    (because `ExpressionField.onChange` emits strings). Pass value
    through directly.
16. **`WaitRealtime` action added** — wall-clock-based delay that
    survives `SetTimeScale 0`. Touches: shared `action.ts`
    (union, array, description, default), shared `objects.ts`
    (subject lists), runtime `Sprite.ts` (queue type, chain
    builder, drain logic with dual gate, stable sort by
    `(runAtSec, runAtRealMs)`), runtime `eval.ts` (no-op case),
    editor `EventsSection.tsx` (categories, summary), editor
    `ActionRow.tsx` (pill). `drainQueue` now runs every tick
    instead of being gated by `!paused`.

All three packages typecheck clean as of session end.

---

## 15. Known risks / not-yet-fixed

- **`enabled` field collision** is solved point-locally for
  ParticleEmitter via `_running`, but the underlying class-level
  collision still lurks. Any future behavior that wants its own
  `enabled` config field will hit the same trap. Consider renaming
  base `Behavior.enabled` → `Behavior.updateEnabled` someday, OR
  keep applying the `_running` pattern per-behavior. For now, the
  pattern is documented in §11.1.
- **`drainQueue` is now O(n×scans)** worst case because items can
  hold for either gate independently. For typical n < 20 this is
  fine. If users build huge event chains it could matter — easy
  fix: bucket by sim vs real, dequeue separately.
- **Camera BP lockdown + transform propagation** — see §13. The
  plan is written but not implemented.
- **`maxParticles` field on ParticleEmitter is advisory only** —
  the inspector exposes it but the underlying Phaser pool is
  uncapped at creation. Either honor the cap (clamp in `init` and
  document the "burst recycle" behavior) or remove the field.
- **No automated tests** — every change is verified by typecheck +
  manual scenario testing through the editor. Some user-reported
  bugs ("burst kills previous burst", "image point alternates",
  "rotation buggy") all reached the user instead of being caught
  pre-ship. Worth adding at least a tiny smoke-test scene that
  exercises CharacterMovement / SpriteRenderer / collisions / a
  Wait chain on every commit.
- **The `enabled` of a behavior chip in the BP definition**
  (`b.enabled` in `runProject.ts:596`) and the base
  `Behavior.enabled` flag are conflated. They serve different
  purposes (chip on/off vs per-tick update gate). Should be
  separated — the chip's enabled should set a separate
  `chipEnabled` field that the runtime reads at attach time,
  leaving the runtime flag for `SetBehaviorEnabled` action use.
- **EventsSection.tsx is 5028 lines** and growing. Splitting
  out the picker modals + the category registries into separate
  files is overdue. Currently every action / condition addition
  has to scroll through a massive file.

---

## 16. Conventions

(Stated by the user, applied throughout the codebase.)

- **No comments unless WHY is non-obvious.** Comments that
  explain WHAT the code does are deleted on sight — the names do
  that. Comments are reserved for hidden constraints, subtle
  invariants, workarounds for specific bugs, or behavior that
  would surprise a reader.
- **No migration code** unless absolutely required. The user is in
  pre-ship testing and is fine re-saving when schemas change.
- **No new files / abstractions** when an existing file works.
  Three similar lines is better than a premature helper.
- **No "for the future" abstractions** — don't design for
  hypothetical needs.
- **No half-finished implementations.** If a feature has 3 sub-arcs
  and only 2 ship, the third either doesn't exist in code or is
  cleanly stubbed.
- **JSON edits to `myGame.peaky.json`** are user-project edits
  (because Claude can't reach the editor UI to do them). Engine
  code changes (TS/TSX) are universal — they ship to every project.
- **`/ultrareview <PR#>`** is the multi-agent review trigger if the
  user mentions it — not something Claude launches.

---

## 17. File-by-file size reference

For navigation. Anything >500 lines deserves careful reading before
you edit:

```
shared/sm/action.ts                                 1168
shared/sm/condition.ts                               730
shared/sm/objects.ts                                 641

runtime/Sprite.ts                                   2351  ★ heart (legacy event runner)
runtime/sm/eval.ts                                  5888  ★ all actions/conditions
runtime/LogicSheetRunner.ts                         1416  ★ Logic Sheet runtime (primary)
runtime/Behavior.ts                                  330
runtime/EventBus.ts                                   83
runtime/behaviors/CharacterMovement.ts               763
runtime/behaviors/ParticleEmitter.ts                 866
runtime/behaviors/SpriteRenderer.ts                  472
runtime/behaviors/Tracer.ts                          968
runtime/behaviors/Camera.ts                          328
runtime/behaviors/Text.ts                            254
runtime/behaviors/SquashStretch.ts                   199
runtime/behaviors/UIWidgetRenderer.ts               2064
runtime/behaviors/Collider.ts                        105

editor/store.ts                                     8490  ★ all editor state
editor/project.ts                                   3115  ★ schema
editor/runProject.ts                                2567  ★ runtime bridge
editor/behaviorMeta.ts                               544

editor/panels/inspector/LogicSheet/LogicGraphCanvas.tsx  4042  ★ Logic Sheet UI (largest)
editor/panels/inspector/EventsSection.tsx             22  (tombstone — Event Sheets removed)
editor/panels/inspector/ActionRow.tsx               2074  ★ per-action pills
editor/panels/inspector/BlueprintInspector.tsx      1986
editor/panels/SceneEditor.tsx                       2765
editor/panels/SpriteTab.tsx                         2629
editor/panels/UIWidgetTab.tsx                       2330
editor/panels/ContentBrowser.tsx                    2353
editor/panels/DialogueTab.tsx                       1068
```

---

## 18. Commands cheat-sheet

```bash
# Editor dev server
npm run dev:editor

# Full typecheck (project references)
./node_modules/.bin/tsc -b

# Single-package typecheck
./node_modules/.bin/tsc --noEmit -p packages/shared/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/runtime/tsconfig.json
./node_modules/.bin/tsc --noEmit -p packages/editor/tsconfig.json

# Build everything
npm run build
```

On Windows the path has a space (`g:\VSCODE PROJECTS\Peaky Engine`)
so quote it: `cd "g:/VSCODE PROJECTS/Peaky Engine"`.

The editor is the only entry point with a `dev` script — there's no
separate runtime dev server; the runtime is consumed by the editor
when the user clicks Play.

---

## 19. Project file format (`.peaky.json`)

Currently `version: 8`. Top-level shape:

```ts
{
  version: 8,
  name: string,
  blueprints: BlueprintDef[],
  scenes: SceneData[],
  sprites: SpriteAsset[],
  dialogues: DialogueAsset[],
  dialogueDefaults: DialogueDefaults,
  uiWidgets: UIWidgetDef[],
  activeSceneId: string,
  inputActions: InputActionDef[],
  signals: SignalDef[],
  folders: string[],
  viewportWidth: number,
  viewportHeight: number,
}
```

Saved via `JSON.stringify` (with formatting). Loaded back through
`migrateProject` (store.ts) which handles legacy migrations
(`KNOWN_KINDS` strip, `classKind` downgrades, missing-field
backfill, deprecated trigger renames). On schema change without
migration logic, old saves break — and per project policy, that's
fine.

The user keeps an active test project at
`G:\VSCODE PROJECTS\myGame.peaky.json` (outside the engine repo).

---

## 20. User profile (from memory)

- **Solo developer**, building Peaky Engine as a personal project.
- Mental model is Construct-3 / GameMaker / Unreal-flavored —
  visual authoring first, code spawning is secondary.
- **Wants UE5-style Content Browser + node graph** (per saved memory
  `project_redesign_2026_04.md` — earlier rejected flat Events + tab
  navigation).
- **Strongly opposed to piecemeal work**: design the user flow
  end-to-end, then build the discovery layer (RMB+search, node
  registry) before adding any new node kind.
- **Direct communication style.** Gets frustrated by repeated
  failures of the same bug. Has explicitly objected to:
  - Adding migration shims (multiple times).
  - Renaming user-facing field names mid-fix (the `autoStart`
    rename disaster was reverted with apology).
  - Long preambles before code changes.
  - Editing project JSON when an engine fix is what's needed.
- **Tests visually** through the editor's Play button. Watches the
  browser F12 console.
- Located in Georgia (Tbilisi area). Native language is Georgian;
  English is fluent but not first-language — short, direct phrasing
  works best.

---

## 21. Quick "where do I find?" index

| Looking for… | Open this |
|---|---|
| The list of action kinds | `packages/shared/src/sm/action.ts` |
| The list of condition kinds | `packages/shared/src/sm/condition.ts` |
| Why my action doesn't appear in the picker | `packages/shared/src/sm/objects.ts` (subject lists), `EventsSection.tsx` (categories) |
| The action's runtime behavior | `packages/runtime/src/sm/eval.ts`, `runAction` switch |
| The action's inline-pill renderer | `packages/editor/src/panels/inspector/ActionRow.tsx` |
| Schema of a Blueprint / Scene / etc. | `packages/editor/src/project.ts` |
| Project migration on load | `packages/editor/src/store.ts`, `migrateProject` |
| Editor → Runtime bridge | `packages/editor/src/runProject.ts` |
| Inspector field metadata for a behavior | `packages/editor/src/behaviorMeta.ts` |
| The whole tick loop | `packages/runtime/src/Sprite.ts`, `update()` (~ line 380) |
| Action queue + Wait / WaitRealtime drain | `packages/runtime/src/Sprite.ts`, `drainQueue()` |
| Signal carryover semantics | `packages/runtime/src/EventBus.ts` |
| BP class registry | `packages/editor/src/blueprintClasses.ts` |
| Behavior registry (runtime) | `packages/runtime/src/Behavior.ts` (`BehaviorKindMap`) |
| Behavior registry (editor / spawn) | `packages/editor/src/runProject.ts` (`BEHAVIOR_REGISTRY`) |
| Behavior strip-on-load | `packages/editor/src/store.ts` (`KNOWN_KINDS`) |

---

**End of handoff.** If you're picking up after this session, the
last thing on the table was `WaitRealtime`. The plan in §13 is what
the user might tackle next — Camera BP lockdown + transform
propagation. Don't start that arc without re-reading the plan file
verbatim, since the user already approved that specific approach.
