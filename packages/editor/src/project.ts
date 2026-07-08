/**
 * Peaky project model — v2 events-only.
 *
 *   Blueprint = class definition (visual + components/behaviors + variables + events)
 *   Instance  = placement of a Blueprint in a scene
 *
 * Logic lives in ONE place: `BlueprintDef.events` — a flat priority list of
 * `(trigger, guards, actions)` blocks. State machines, the node graph, and
 * recursive sub-events are gone.
 */

import { Condition, StateAction } from "@peaky/shared";

export type BehaviorKind =
  | "Solid"
  | "JumpThru"
  | "CharacterMovement"
  | "TopdownMovement"
  | "SpriteRenderer"
  | "Collider"
  | "Text"
  | "Camera"
  | "Tracer"
  | "SquashStretch"
  | "UIWidgetRenderer"
  | "ParticleEmitter"
  | "Damageable"
  | "StateMachine"
  | "AIBrain"
  | "PhaseManager"
  | "Widget"
  | "SmartTween"
  | "Projectile"
  | "Inventory"
  | "TilemapRenderer"
  | "VisionMask"
  | "MoveTo"
  | "TiledBackground"
  | "WeaponSlot"
  | "Dismemberment"
  | "Outline"
  | "Shadow"
  | "LightSource"
  | "Weather";

export interface BehaviorInstance {
  kind: BehaviorKind;
  config: Record<string, unknown>;
  /** When false, the runtime skips this behavior's update each frame. */
  enabled?: boolean;
}

/**
 * Object-scoped variable on a Blueprint. Each spawned Instance gets its own
 * copy initialized to `default`. SetVar / AddVar actions modify it; Compare
 * conditions can read it as `var:<name>`.
 *
 * Supports three types:
 *   - "number" — counters, hp, score, etc. AddVar adds a delta.
 *   - "string" — name, dialogue line, current weapon, etc.
 *   - "bool"   — flags, toggles. AddVar is a no-op for bools.
 */
export type VariableType = "number" | "string" | "bool";

export interface VariableDef {
  id: string;
  name: string;
  type: VariableType;
  default: number | string | boolean;
  /**
   * Number sub-kind. Drives the chip color in the left rail (integer = bluish
   * green, float = green) and could later inform validation. Only meaningful
   * when `type === "number"`. Defaults to "integer" if absent.
   */
  numberKind?: "integer" | "float";
  /** Optional [min, max] clamp applied at runtime to numeric vars. */
  autoCap?: [number, number];
  /** Whether placements can override this var per-instance in the scene. */
  instanceEditable?: boolean;
  /** Whether the var appears in the BP's spawn API (for code spawning). */
  exposeOnSpawn?: boolean;
  /**
   * When true, this variable is backed by the persistent GLOBAL store instead
   * of per-instance state: it survives scene transitions + save/load and is
   * shared by every instance (so it's meant for SINGLETON Blueprints — Player,
   * GameManager). Reads/writes via `var:<BP>.<name>` and `global:<name>` hit the
   * same value (keyed by the variable's NAME). Auto-listed in the Main Logic
   * Sheet's Global Variables panel.
   */
  global?: boolean;
}

/**
 * Construct-3-style event sheet node. Every "row" in the inspector is a
 * PeakyEvent. The shape is recursive — `children` are sub-events that run
 * AFTER the parent's actions when the parent's conditions matched.
 *
 * Two flavors via `kind`:
 *
 *   • "event"   — standard event. Fires when its `conditions` match according
 *                 to `combinator` (AND combines all, OR combines any). For
 *                 "if NOT previous sibling fired", add an `Else` condition
 *                 from the System category — that's the C3-equivalent.
 *
 *   • "comment" — text-only divider. No conditions, no actions, ignored
 *                 at runtime.
 */
export type PeakyEventKind = "event" | "comment" | "group";

export interface PeakyEvent {
  id: string;
  kind: PeakyEventKind;
  /** How `conditions` are combined — defaults to AND. Toggle in the UI. */
  combinator?: "AND" | "OR";
  /** Conditions list — empty for "comment" / "group". */
  conditions: Condition[];
  /** Actions list — empty for "comment" / "group". */
  actions: StateAction[];
  /** Sub-events. For "group", these are the events nested inside the folder. */
  children: PeakyEvent[];
  /** "comment" kind: the comment text. "group" kind: the folder name. */
  text?: string;
  /** Optional group this event belongs to. Disabled-group events skip at runtime. */
  groupId?: string;
  /** Per-event manual disable. Disabled events evaluate as "not fired" for Else chains. */
  disabled?: boolean;
  /**
   * Owning event-page id. Top-level events are scoped to a page (Construct-style
   * "event sheet"). Sub-events inherit their parent's page implicitly. Undefined
   * = unmigrated (treated as the BP's first page at render time).
   */
  pageId?: string;
}

/** A named "event sheet" tab. Each blueprint can have many. */
export interface EventPageDef {
  id: string;
  name: string;
}

/**
 * Legacy event shape kept for migration — never read from the typed tree
 * directly. The store's `migrateProject` converts these into `PeakyEvent`
 * on load.
 */
export interface EventDef {
  id: string;
  trigger: unknown;
  guardCombinator: "AND" | "OR";
  guards: Condition[];
  actions: StateAction[];
  groupId?: string;
}

/**
 * Named group of events that can be enabled/disabled together at runtime.
 * Each event's `groupId` references one of these (or none = ungrouped).
 */
export interface EventGroupDef {
  id: string;
  name: string;
  /** Initial enabled state when the sprite spawns. Toggled via SetEventGroupEnabled. */
  enabled: boolean;
}

/**
 * Component-level LOD group on a BP. When a sprite carrying `targetTag` is
 * within `distance` (px) of an instance of this BP, the listed `components`
 * are enabled; outside that range, they're disabled. Multiple groups can
 * coexist on one BP (e.g. "combat" at 400px for Tracer+AIBrain, "visual"
 * at 1000px for SpriteRenderer+SquashStretch).
 */
export interface LODGroup {
  id: string;
  /** Display label — inspector only. Default "Group N". */
  name: string;
  /** Behavior KINDS (e.g. ["Tracer", "AIBrain"]) that toggle as a unit.
   *  Identifying by kind (not chip index) keeps the group resilient when
   *  behavior chips are reordered. If the BP has TWO Tracers, BOTH toggle. */
  components: string[];
  /** Enable distance in WORLD pixels. */
  distance: number;
  /** Tag whose nearest carrier is measured against. Typical: "player". */
  targetTag: string;
}

/** Class-level definition. The "what does a Player look like / do". */
export interface BlueprintDef {
  id: string;
  name: string;
  /** When true, the Content Browser skips this asset unless "Show Hidden"
   *  is toggled on. Soft-delete handle — used to declutter the workspace
   *  for testing without losing data; users flag for permanent deletion
   *  later. Same field shape on every project-asset type. */
  hidden?: boolean;
  /**
   * UE5-style class template this BP was instantiated from. Stored so the
   * editor can show the class label and (later) gate certain features. The
   * registry of classes lives in `blueprintClasses.ts`.
   */
  classKind: import("./blueprintClasses").BpClass;
  /**
   * Free-form labels. Other Blueprints' events reference these via
   * `OnOverlap(tag)` / `OnCollide(tag)` triggers to react to physical contact
   * with this kind of object (e.g. "ground", "enemy", "pickup").
   */
  tags: string[];
  /**
   * When true, the scene-editor instance inspector exposes a per-instance
   * tag editor. The instance's `tags?: string[]` (if set) FULLY REPLACES
   * the BP-level `tags` at runtime — lets one BP serve as variants without
   * cloning. Missing / false → instances inherit the BP tags read-only.
   */
  tagsInstanceEditable?: boolean;
  /**
   * Viewport culling mode — drives whether the sprite's per-tick behavior
   * loop runs when this BP's instance is far off-screen. See Sprite.tick
   * for the gating logic.
   *
   *   - "never" (default): always run. Use for story-critical NPCs,
   *                       bosses, cinematic actors, the player. Whatever
   *                       happens off-screen MATTERS for gameplay.
   *   - "throttled":      off-screen sprites tick at 10Hz instead of 60Hz.
   *                       NPC keeps living its life (walking, animating)
   *                       but cheaper. Use for villagers, patrol guards,
   *                       wildlife — any NPC that should "live" off-camera
   *                       but isn't combat-critical.
   *   - "freeze":         off-screen sprites SKIP TICKING entirely.
   *                       NPC freezes in place. Resumes when camera comes
   *                       back. Use for swarm enemies — player doesn't
   *                       notice they were frozen.
   *
   * Missing on legacy BPs → defaults to "never" (no behavior change).
   */
  cullMode?: "never" | "throttled" | "freeze";
  /**
   * Off-screen tick rate (Hz) when cullMode is "throttled". 10 (default) / 20 /
   * 30. Higher = smoother off-screen movement on wake-up but smaller CPU win.
   * Ignored unless cullMode === "throttled". Missing → 10.
   */
  cullThrottleHz?: number;
  /**
   * Frames between "decision" passes for this BP's instances. Throttles ONLY
   * the expensive thinking — the StateMachine's state selection and the Logic
   * Sheet's per-frame OnTick + condition eval — while movement, animation
   * playback and overlay sync keep running every frame, so motion stays smooth.
   *   1 (default) = decide every frame (60Hz).
   *   2 = 30Hz · 3 = 20Hz · 6 = 10Hz.
   * For big background swarms whose logic only needs to re-decide a few times a
   * second. Reaction latency ≈ rate (e.g. 6 → up to ~100ms). NOT for combat
   * actors that rely on frame-signals / frame-motions / per-frame triggers —
   * those are evaluated at the reduced rate too. Missing → 1 (no change).
   */
  decisionTickRate?: number;
  /**
   * Skip this BP's instances from CollisionScan's broad-phase pair detection.
   * MASSIVE perf win at scale: when 1500 swarm NPCs cluster in one cell, the
   * pair scan would normally check 1500²/2 = ~1M pairs per frame. With this
   * flag, zero. The sprite still has a physics body (for player collision /
   * wall collision via Phaser's built-in systems); only the per-tick overlap
   * scan ignores it.
   *
   * Set this for swarm enemies whose damage comes from Tracers / Damageable
   * contact damage — NOT from OnCollide / OnOverlap event-sheet triggers.
   * If you DO need OnCollide events on this BP, leave this off.
   *
   * Missing on legacy BPs → defaults to false (no behavior change).
   */
  skipCollisionScan?: boolean;
  /**
   * Comma- or space-separated tag list. When `skipCollisionScan` is on,
   * pairs with sprites carrying ANY of these tags STILL get scanned —
   * so OnCollide / OnOverlap events on this BP (or on the other side)
   * fire for those interactions.
   *
   * Example: swarm enemy with `skipCollisionScan=true, exceptTags="player"`.
   *   - enemy ↔ enemy pair: skipped (perf win)
   *   - enemy ↔ player pair: scanned (so `OnCollide(player) → Destroy` works)
   *   - enemy ↔ wall pair: skipped (not in exception list)
   *
   * Empty → pure skip (the old single-flag behavior).
   * Ignored when skipCollisionScan is off.
   */
  collisionScanExceptTags?: string;
  /**
   * Component-level LOD groups. Each group lists behaviors that should
   * be ENABLED only when a sprite carrying the group's `targetTag` is
   * within `distance` pixels. Out-of-range NPCs keep cheap behaviors
   * running (MoveTo, Damageable) while disabling expensive ones (Tracer,
   * ParticleEmitter, AIBrain, SpriteRenderer), so the swarm still
   * converges on the player but doesn't pay for visuals it can't be seen.
   *
   * Distinct from `cullMode`: cull is all-or-nothing per sprite. LOD is
   * per-component. Both stack — a frozen sprite skips Sprite.tick
   * entirely, so the LOD pass doesn't even run for it.
   *
   * Empty / missing → no LOD, every behavior runs every tick.
   */
  lodGroups?: LODGroup[];
  /** Visual default. Becomes the sprite's color/size when an instance spawns. */
  w: number;
  h: number;
  color: number;
  /**
   * Vertical anchor for Y-sort depth (0..1). Used only when the BP's instance
   * sits on a layer with `ySort: true`. 0 = top of the sprite is the sort
   * point, 0.5 = center, 1 = bottom ("feet"). Topdown default = 1 so a tree's
   * base is what the player sorts against. Missing → 1.
   */
  ySortPivotY?: number;
  /**
   * When true, instances of this BP IGNORE a Y-sort layer's per-tick depth
   * recompute — they keep a fixed depth (layer base + per-instance z) instead
   * of interleaving by world Y. For decals / FX (blood splats, shadows) that
   * shouldn't flicker in front of / behind characters as everyone moves. Place
   * above/below the Y-sorted sprites via the instance z-order. Missing = false.
   */
  ySortExclude?: boolean;
  /**
   * When true, the BP's default colored rect is invisible at both edit-time
   * (scene preview) and runtime (Phaser physics rect alpha = 0). Useful for
   * Text-only BPs or pure logic BPs where the rect is just clutter.
   */
  hideRect?: boolean;
  /**
   * Whether the spawned instance is affected by the scene's gravity. Missing
   * (legacy) or true → gravity applies (default for player / actor BPs);
   * false → body.allowGravity = false at spawn (use for Camera / UI /
   * trigger / decoration BPs that shouldn't fall).
   */
  affectedByGravity?: boolean;
  /**
   * When true, the spawned instance gets NO Phaser physics body — skips
   * `scene.physics.add.existing(gameObject)` in the Sprite ctor. Cuts
   * ~0.3ms per spawn (significant when spawning hundreds of background
   * decorations).
   *
   * Use ON for: backgrounds, decorations, ambient props, particle host
   *   sprites, anything purely visual that never moves or collides.
   *
   * Use OFF (default — current behavior) for: NPCs, projectiles, walls,
   *   pickups, anything that needs collision detection, velocity-driven
   *   movement, or knockback. Behaviors that require a body
   *   (CharacterMovement, TopdownMovement, MoveTo, Damageable, Solid,
   *   JumpThru) will silently no-op without one — author is responsible
   *   for not attaching them to no-body BPs.
   *
   * Missing on legacy BPs → false (body created — no behavior change).
   */
  noPhysicsBody?: boolean;
  /**
   * Distance-gated (proximity) collision wiring.
   *
   * When > 0: instances of this BP SKIP the per-pair `wireCollisionsFor`
   * loop at spawn time (the O(N²) cost that freezes scene-start at
   * scale). Instead, each instance periodically checks if a sprite
   * carrying `collisionWakeTag` is within this many pixels. The moment
   * it is, the instance's Phaser pair colliders get wired (one-shot —
   * never unwired). Stale-collision risk is zero for sprites that
   * eventually approach the wake target; for sprites that never do,
   * pair colliders are never paid for.
   *
   * Use for: regular (non-swarm) BPs that need REAL Phaser collisions
   *   (player physical block, projectile pierce, etc.) but spawn in
   *   large batches and would freeze scene-start. E.g. 200 destructible
   *   crates placed in a scene.
   *
   * Default (missing / 0): wire immediately at spawn (legacy behavior).
   * Use `skipCollisionScan` instead for swarm BPs that don't need
   *   Phaser pair colliders at all.
   */
  collisionWakeRadius?: number;
  /** Tag whose nearest carrier triggers the wake check. Default "player". */
  collisionWakeTag?: string;
  /**
   * Object pool size.
   *
   * When > 0: at scene start, this many instances of this BP are
   * pre-spawned and deactivated into a pool. CreateObject for this BP
   * pops from the pool (~0.05ms) instead of full allocation (~1.5ms).
   * Destroy returns to the pool instead of tearing down. After warmup,
   * spawn/destroy is essentially free regardless of behavior count.
   *
   * Pool fill at scene load takes `poolSize × ~1.5ms` ONCE — pay this
   * behind a Loading screen for the Vampire Survivors pattern.
   *
   * Default (missing / 0): no pool, every spawn does fresh allocation
   * (legacy behavior).
   *
   * If pool exhausted at spawn time, falls back to fresh allocation
   * with a console warning.
   *
   * Behavior state on pool respawn: position, vars (default reset),
   * hp (Damageable), animation (SpriteRenderer), MoveTo target/mode are
   * reset. Less-common behaviors may retain stale state — author can
   * call SetBehaviorParam in OnCreate as a fallback.
   */
  poolSize?: number;
  /** Components that every instance of this blueprint receives at spawn. */
  behaviors: BehaviorInstance[];
  /** Object-scoped variables (per-instance state — hp, score, ammo, etc). */
  variables: VariableDef[];
  /** @deprecated Legacy event-sheet payload. Event Sheets were removed —
   *  all authoring now lives in `logicSheet`. Field kept (required, empty
   *  default) so existing call sites don't need `?? []` everywhere
   *  during the deprecation window. Ignored at runtime, invisible in the
   *  editor UI. Delete once all imports are gone. */
  events: PeakyEvent[];
  /** @deprecated See `events` — legacy field, unused by the runtime. */
  eventGroups: EventGroupDef[];
  /** @deprecated See `events` — legacy field, unused by the runtime. */
  eventPages: EventPageDef[];
  /**
   * Per-BP Logic Sheet — node-graph event system. The ONLY authoring
   * surface (Event sheets were removed). Each entry has ONE trigger node
   * + a graph of action / condition / branch nodes wired via exec + typed
   * data edges. Optional only because brand-new BPs can lack one until
   * an event is added.
   */
  logicSheet?: LogicSheet;
  /** Content Browser folder this asset lives in. Always starts with "/". */
  path: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Logic Sheet — per-BP node-graph event system (v6+).
// ──────────────────────────────────────────────────────────────────────────

export interface LogicSheet {
  folders: LogicFolder[];
}

/** One Main Logic Sheet — same authoring surface as a Blueprint's logic
 *  sheet, but not tied to any BP. Multiple sheets per project; each can
 *  be enabled/disabled independently at runtime. */
export interface MainLogicSheetDef {
  id: string;
  name: string;
  /** When false, the runtime skips this sheet entirely. Toggleable in the
   *  Main Logic Sheets manager. Defaults to true. */
  enabled: boolean;
  sheet: LogicSheet;
}

/**
 * A folder groups any number of triggers + their action chains onto a
 * single canvas. Authors organize by topic ("Combat", "Pickups",
 * "Movement"). Each folder's graph can contain many trigger nodes
 * rooting independent exec chains. v6 -> v7 migration converts each
 * legacy single-trigger LogicEvent into its own folder.
 */
export interface LogicFolder {
  id: string;
  name: string;
  graph: { nodes: LogicGraphNode[]; edges: LogicGraphEdge[] };
}

// (The legacy LogicEvent / LogicTriggerNode / LogicTriggerKind shapes were
// deleted — nothing read them, and the stale trigger union misled readers.
// The AUTHORITATIVE trigger list is `LogicTriggerKind` in
// packages/runtime/src/LogicSheetRunner.ts; graph nodes carry the kind as a
// plain string in `LogicGraphNode.type`.)

export interface LogicGraphNode {
  id: string;
  /** Node category — drives how the executor handles it.
   *  - `trigger` roots an exec chain (subscribes to an engine event)
   *  - `action`  runs an engine StateAction
   *  - `condition` evaluates a boolean (feeds a Branch)
   *  - `branch`  forks exec on a boolean input pin
   *  - `literal` / `varRead` emit a typed data value */
  kind: "trigger" | "action" | "condition" | "branch" | "literal" | "varRead" | "getter" | "comment";
  /** Concrete node type (e.g. "OnCollide", "ApplyDamage", "VarEquals"). */
  type: string;
  /** Per-node config (inline values for pins not driven by data wires). */
  params: Record<string, unknown>;
  position: { x: number; y: number };
  /** Editor-only: when true the node is visually collapsed to just its
   *  title bar (params + data-pin rows hidden). Exec connectivity is
   *  preserved. Ignored by the runtime. */
  collapsed?: boolean;
}

export interface LogicGraphEdge {
  id: string;
  source: string;
  sourcePin: string;
  target: string;
  targetPin: string;
  /** Strict typed wires — runtime + UI both enforce. */
  pinType: "exec" | "number" | "string" | "boolean" | "spriteRef";
}

/** A placement of a UI Widget in a scene.
 *
 *  UI widget instances live in their own list (`SceneData.uiInstances`)
 *  separate from gameplay BPs. They render on a parallax-(0,0) layer
 *  by convention, have no physics body at runtime, and are positioned
 *  at fixed canvas coordinates (or via the Anchor behavior, which
 *  overrides x/y at init time). */
export interface UIWidgetInstance {
  id: string;
  uiWidgetId: string;
  /** Optional human label, falls back to the UI Widget's name. */
  name?: string;
  /** Top-left position in scene-design pixels. Anchor behavior overrides
   *  this at runtime if attached. */
  x: number;
  y: number;
  /** Optional render-size override for the UI widget instance.
   *  Missing → use the widget's `width`/`height` defaults. */
  w?: number;
  h?: number;
  /** Layer this instance lives on. UI instances must reference a
   *  parallax-(0,0) layer to behave as a HUD; the editor enforces /
   *  warns when this isn't the case. */
  layerId?: string;
  /** Optional parent for Stack-managed layouts — when set, references
   *  another UIWidgetInstance.id whose Stack behavior arranges this
   *  child. */
  parentInstanceId?: string;
  /** Editor-side lock — when true, this instance can't be selected or
   *  dragged from the scene canvas. Independent of runtime visibility. */
  locked?: boolean;
}

/** A placement of a blueprint in a scene. */
/** Turns a Trigger instance into a scene-linking DOOR. When `destSceneId` is set,
 *  a traveler (a sprite carrying `travelerTag`, default "player") that ENTERS the
 *  trigger is teleported to scene `destSceneId` and placed on the door whose
 *  `name` === `destDoor` there. `name` is this door's own entry id (how OTHER
 *  doors target it). Empty `destSceneId` = plain trigger, no teleport. */
export interface DoorLink {
  /** This door's entry id (unique within its scene) — the target of other doors' `destDoor`. */
  name?: string;
  /** Destination scene id. Set = this trigger acts as a door. */
  destSceneId?: string;
  /** The `name` of the door in the destination scene to arrive on. */
  destDoor?: string;
  /** Use the loading-screen transition (GoToLayoutWithLoad) instead of a plain cut. */
  withLoad?: boolean;
  /** (withLoad) which scene to show as the loading screen. Empty = the project's
   *  default loadingSceneId. */
  loaderSceneId?: string;
  /** Which sprite tag counts as the traveler that activates the door. Default "player". */
  travelerTag?: string;
  /** How the door fires once the traveler is on it:
   *  "instant" (default) = travel on entry; "delay" = travel after `delaySec`
   *  standing on it; "input" = travel when `inputAction` is pressed while on it. */
  activation?: "instant" | "delay" | "input";
  /** Seconds to wait on the door before traveling (activation = "delay"). */
  delaySec?: number;
  /** Input action name to press to travel (activation = "input"). */
  inputAction?: string;
}

export interface BlueprintInstance {
  id: string;
  blueprintId: string;
  /** Optional human label; falls back to the Blueprint name. */
  name?: string;
  x: number;
  y: number;
  /** Optional Door link — turns a Trigger instance into a scene-to-scene door. */
  door?: DoorLink;
  /** Per-instance COMPONENT param overrides, applied on top of the BP's config
   *  at spawn. Key = behavior kind ("Collider"), or `Kind#name` when the BP has
   *  several of the same kind (Tracer/ParticleEmitter, matched by `name`).
   *  Value = only the overridden param keys. Authored in the Instance
   *  Inspector's "Component Overrides" section. */
  behaviorOverrides?: Record<string, Record<string, unknown>>;
  /**
   * Optional per-instance size override. When set, the body rect AND the
   * SpriteRenderer overlay are scaled to these dims (proportionally —
   * ratio is applied to per-frame display sizes too). Missing → use the
   * Blueprint / Sprite asset's own size. Lets one BP be reused at
   * multiple sizes without cloning the asset.
   */
  w?: number;
  h?: number;
  /**
   * Render layer this instance lives on. Drives parallax scroll factor +
   * depth ordering at runtime, plus visibility / opacity in the editor.
   * Missing for legacy projects → migrated to the scene's first non-UI
   * layer (typically `Main`) on load.
   */
  layerId?: string;
  /**
   * Per-instance z-order WITHIN the layer. Higher values draw on top.
   * Default 0. Sub-ordering is layer-local: it can't lift an instance
   * above a higher-layer's contents — the layer band always wins.
   * Behavior overlays (SpriteRenderer, Text, Tracer) follow their host's
   * z automatically, so a z=1 BP renders entirely above a z=0 BP.
   */
  z?: number;
  /**
   * Per-instance VISUAL scale (multiplies the BP's size). 1 / missing = no
   * change. Applied to the host gameObject at spawn; the SpriteRenderer / Text
   * overlays fold `obj.scaleX/Y` in via syncOverlay, so the art scales too.
   * (The arcade physics body is not re-sized — use w/h for collision size.)
   */
  scaleX?: number;
  scaleY?: number;
  /** Per-instance VISUAL rotation in degrees. 0 / missing = none. The overlay
   *  follows the host's rotation via syncOverlay. */
  angle?: number;
  /**
   * Per-instance starting values for variables marked `instanceEditable`
   * on the Blueprint. Applied on top of the BP's defaults at spawn time
   * — so 4 NPC instances can each start with different Money / HP /
   * whatever. Keyed by VARIABLE NAME (not id) for stability across
   * variable-renames; the cascade in the rename action keeps these in
   * sync. Missing keys = use the BP default. Empty / undefined for
   * legacy instances → all use defaults.
   */
  vars?: Record<string, number | string | boolean>;
  /**
   * Per-instance tag override. When defined (any array, even empty), this
   * fully replaces the BP's `tags` for this instance at runtime — so
   * `OnOverlap("boss")` matches a `tags: ["boss"]` instance even when its
   * BP has `tags: ["enemy"]`. Only honored when the BP has
   * `tagsInstanceEditable: true`. Missing / undefined = inherit BP tags.
   */
  tags?: string[];
  /**
   * Per-instance sprite asset override (by sprite id). When set, overrides
   * the BP's SpriteRenderer.spriteId AND TiledBackground.spriteId for this
   * instance, so two instances of the same BP can render different art.
   * The animation override (`spriteAnimation`) is matched by NAME against
   * the overridden asset's animation list, so the same animation-name
   * convention (e.g., "idle", "run") carries across asset swaps.
   */
  spriteId?: string;
  /**
   * Per-instance SpriteRenderer animation override (by NAME, matching
   * SpriteRenderer.currentAnimation). Empty / missing = the BP's default
   * animation. Lets each placed instance show a different animation.
   */
  spriteAnimation?: string;
  /**
   * Per-instance frame: >= 0 freezes the instance posed on that frame
   * (playing stops); -1 / missing = animate normally. Mirrors the Item-icon
   * "Static frame vs Animate" model.
   */
  spriteFrame?: number;
  /** Editor-side lock — when true, this instance can't be selected or
   *  dragged from the scene canvas. Independent of runtime visibility. */
  locked?: boolean;
  /**
   * Per-instance TiledBackground overrides. When the BP has a
   * TiledBackground component, any field set here REPLACES the BP's
   * value for that field on this specific instance — so two instances
   * of the same "Mountains BG" BP can have different parallax factors,
   * scroll speeds, sizes, flip, or tile-axis settings without forking
   * the BP. Fields left undefined inherit from the BP.
   */
  tiledBg?: {
    mode?: "followCamera" | "autoScroll";
    parallaxFactorX?: number;
    parallaxFactorY?: number;
    scrollSpeedX?: number;
    scrollSpeedY?: number;
    width?: number;
    height?: number;
    flipX?: 0 | 1;
    flipY?: 0 | 1;
    tileX?: 0 | 1;
    tileY?: 0 | 1;
  };
}

/**
 * Render-and-parallax layer. Layers are a pure logical grouping —
 * mapped at runtime to per-object `setScrollFactor` + `setDepth`, NOT
 * to separate Phaser cameras or framebuffers. See plan file for the
 * performance rationale.
 *
 *  - parallaxX / parallaxY: 0 = locked to screen (UI), 1 = scroll 1:1
 *    with the camera, 0.3 = drift slowly (parallax background).
 *  - visible: skip rendering when false.
 *  - opacity: 0..1, multiplied into each instance's alpha.
 */
export interface LayerDef {
  id: string;
  name: string;
  parallaxX: number;
  parallaxY: number;
  visible: boolean;
  opacity: number;
  /**
   * When true, this layer's content is SHARED across every scene. You author
   * the widgets / instances on it in ONE scene; at runtime they render in all
   * scenes (HUD, pause menu, persistent overlays). Layers are matched across
   * scenes by NAME — a same-named layer in another scene shows the same global
   * content rather than its own copy. The "source" scene is the first scene
   * (in project order) whose layer of that name is marked global.
   */
  global?: boolean;
  /**
   * Topdown-game "Y-sort" mode. When true, every sprite on this layer updates
   * its render depth each frame from its world Y position (plus the BP's
   * `ySortPivotY` offset), and tilemaps on this layer split into per-row
   * Phaser layers so individual tile rows interleave with sprites by Y.
   * The standard "player walks behind a tree" effect — automatic per frame.
   */
  ySort?: boolean;
  /**
   * When true, instances on this layer can't be selected, dragged, or edited
   * in the scene canvas. The layer can still be made invisible separately —
   * "locked" is for editor-side accident prevention (don't grab the
   * background while placing foreground props), independent of runtime
   * visibility.
   */
  locked?: boolean;
}

/** A sprite asset placed directly in a scene (no Blueprint wrapper).
 *  Pure visual + optional rectangular collider — no behaviors, no
 *  variables, no events. For decorations, background art, simple props.
 *  Logic Sheet actions can still target it by `name`. */
export interface SpritePlacement {
  id: string;
  /** Author-facing identifier — used by Logic Sheet actions to target
   *  this placement (`SetPlacementFrame { name: "tree1", ... }`). Empty
   *  is fine for purely decorative placements that don't need scripting. */
  name: string;
  /** The Sprite asset to render — references `PeakyProject.sprites[].id`. */
  spriteId: string;
  /** World-space position (top-left? center? see runtime — Phaser
   *  Sprites default-anchor at center 0.5, 0.5). */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Rotation in degrees. Most placements stay at 0. */
  rotation: number;
  /** 0..1. Default 1. */
  alpha: number;
  flipX: boolean;
  flipY: boolean;
  /** Scene layer the placement renders on. */
  layerId: string;
  /** Animation name from the sprite asset (empty = first available). */
  animation: string;
  /** Frame index displayed when scene boots OR when `playing` is false. */
  startFrame: number;
  /** When true, the animation runs in a loop. When false, the sprite
   *  sits on `startFrame` until a Logic Sheet action changes it. */
  playing: boolean;
  /** Visible at scene start. Logic Sheet's SetPlacementVisible can flip
   *  this at runtime. Defaults to true. */
  visible?: boolean;
  // ── Collider (Phase 3) ─────────────────────────────────────────────
  /** When true, the runtime creates an AABB physics body so the
   *  placement participates in collide / overlap detection. Default off. */
  hasCollider?: boolean;
  /** When true, the collider auto-uses the sprite asset's natural width
   *  and height — colliderWidth / colliderHeight are ignored. Default true
   *  on new placements (matches the common "wall = whole sprite" case). */
  colliderFitSprite?: boolean;
  /** Collider AABB width / height in pixels. Used only when
   *  colliderFitSprite is false. */
  colliderWidth?: number;
  colliderHeight?: number;
  /** Collider offset relative to the sprite's center. */
  colliderOffsetX?: number;
  colliderOffsetY?: number;
  /** Whether the collider blocks other bodies (Solid-like) or just
   *  fires overlap events. Default false (overlap-only). */
  colliderBlocks?: boolean;
  /** Identity tags carried BY this placement. Drive HasSpriteObjectTag /
   *  OnCollide_<tag> routing on OTHER sprites — what this placement IS,
   *  not who collides with it. */
  tags?: string[];
  /** Collide-filter MODE — interpretation of `collideFilterTags`:
   *   - "include" → ONLY sprites carrying any of these tags collide with
   *     this placement. Empty list = collide with every sprite.
   *   - "exclude" → sprites carrying any of these tags are IGNORED.
   *  Default "include". */
  collideFilterMode?: "include" | "exclude";
  /** Tag list interpreted by `collideFilterMode`. Separate from `tags`
   *  (the placement's identity) — these say WHO INTERACTS WITH this
   *  placement, not what it's tagged as. */
  collideFilterTags?: string[];
  /** Legacy. Old projects used `tagMode` for the collide filter; the
   *  field stays so saved scenes load, but the runtime now reads
   *  `collideFilterMode`. */
  tagMode?: "include" | "exclude";
}

export interface SceneData {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  width: number;
  height: number;
  backgroundColor: number;
  gravity: number;
  instances: BlueprintInstance[];
  /** UI Widget placements — separate list from `instances` (gameplay BPs).
   *  Spawned at scene start with NO physics body, rendered on the layer
   *  referenced by `layerId` (typically a parallax-(0,0) UI layer). */
  uiInstances?: UIWidgetInstance[];
  /** Tilemap placements — each spawns one Phaser Tilemap layer at runtime.
   *  Optional so legacy scenes load; migrateProject backfills []. */
  tilemapInstances?: TilemapInstance[];
  /** Direct sprite placements — a sprite asset placed straight into the
   *  scene WITHOUT a Blueprint wrapper. Renders, animates, optionally
   *  collides, but has no behaviors / variables / events. Use for
   *  decoration, background art, simple props. Lightweight runtime cost. */
  spritePlacements?: SpritePlacement[];
  /** Content Browser folder this scene lives in. Always starts with "/". */
  path: string;
  /**
   * Ordered top→bottom: index 0 draws on top. New scenes seed with
   * `[UI(0,0), Main(1,1)]`. Migration backfills this on legacy scenes.
   */
  layers: LayerDef[];
  /** Layer that newly-placed instances drop into. Defaults to `Main`. */
  activeLayerId: string;
  /**
   * When true, the runtime camera is NOT clamped to layout bounds —
   * `cameras.main.setBounds(...)` is skipped, so the camera can scroll
   * freely past the layout edges. Equivalent to Construct 3's "Unbounded
   * scrolling" layout flag. Default false = camera stays inside layout.
   */
  unboundedScroll?: boolean;
  /**
   * Main event sheet — scene-scoped global logic with no host BP.
   * Same shape as a BP's event sheet (events / groups / pages / variables)
   * but addressed from the editor via the sentinel id `__main__:<sceneId>`
   * so existing event-sheet store actions work unchanged. Variables on
   * the main sheet act as global game vars (score, time, etc.) accessible
   * to BPs via `var:World.<name>`. Empty / undefined for legacy scenes.
   */
  mainEvents?: PeakyEvent[];
  mainEventGroups?: EventGroupDef[];
  mainEventPages?: EventPageDef[];
  mainVariables?: VariableDef[];
  /** Navigation mesh — brush-painted walkable grid + obstacle polygons +
   *  tagged waypoints. Drives NPC pathfinding (A*) and `MoveTo NavPoint(tag)`.
   *  Optional; absent on scenes with no painted nav. */
  navMesh?: NavMesh;
}

/**
 * Per-scene navigation data. The `walkable` grid is the source of truth for
 * "where NPCs may go" (brush-painted); `obstacles` are detectable polygons
 * (tracers/line-of-sight) that ALSO subtract from walkability; `waypoints`
 * are named/tagged destinations referenced by `MoveTo NavPoint(tag)`.
 * The grid (not polygons) is what A* runs on — cellSize sets its resolution.
 */
export interface NavMesh {
  /** Grid cell size in world px. Smaller = finer paths, bigger arrays. */
  cellSize: number;
  /** cols = ceil(scene.width / cellSize); stored so the flat array is
   *  unambiguous even if the scene is later resized. */
  cols: number;
  rows: number;
  /** Row-major flat mask, length cols*rows. 1 = walkable, 0 = blocked. */
  walkable: number[];
  /** Row-major flat mask, length cols*rows. 1 = SHELTERED (weather blocked here
   *  — Weather.shelterMask reads this). Independent of `walkable`. Optional /
   *  absent = no painted shelter (the scene just isn't covered anywhere). */
  shelter?: number[];
  /** Obstacle polygons in world coords — detectable by tracers (via tags)
   *  and carved out of the walkable grid at bake time. */
  obstacles: NavObstacle[];
  /** Tagged destination markers. `MoveTo NavPoint("missionA")` paths here. */
  waypoints: NavWaypoint[];
  /** When on, the runtime draws each point colored by state (active / busy /
   *  consumed / depleted) during Play — a debugging aid. */
  debug?: boolean;
  /** When on, patrol scans only consider nav points in the SAME connected
   *  walkable area as the NPC — so an NPC never targets (or runs a doomed A*
   *  toward) a point in a disconnected painted area it can't reach. Only matters
   *  when the painted mesh has separate, unconnected blobs. Scene-wide. */
  regionLocked?: boolean;
}

export interface NavObstacle {
  id: string;
  /** World-space polygon vertices (>=3). */
  points: { x: number; y: number }[];
  /** Labels — matched by tracer tagFilter and any tile/obstacle queries. */
  tags: string[];
}

export interface NavWaypoint {
  id: string;
  x: number;
  y: number;
  /** Optional display name shown on the dot in the editor. */
  name?: string;
  /** Labels — `MoveTo NavPoint(tag)` picks the nearest waypoint carrying tag. */
  tags: string[];
  /** Patrol pause (sec) at this point before moving to the next. 0 = no stop. */
  waitSec?: number;
  /** Signal emitted on the NPC when it arrives here (hook eat/idle/door/etc.). */
  signalOnArrive?: string;
  /** Source tile this point was auto-placed on (tilemap name + the anchor cell's
   *  world center). Lets the runtime gate availability on the tile still existing
   *  — a renewable bush point goes unavailable while mined and returns when it
   *  grows back. Absent for hand-placed mission points (those skip tile-gating). */
  srcMap?: string;
  srcX?: number;
  srcY?: number;
  /** State to force on ANY arriving NPC: its state machine switches to a state
   *  by this name if it has one (NPCs without it are unaffected). The simple,
   *  BP-agnostic path; per-BP `setStates` overrides it. */
  setStateAny?: string;
  /** Per-blueprint state to force on arrival: when an NPC of blueprint `bp`
   *  arrives, its state machine is pinned to `state`. Multiple BPs supported. */
  setStates?: { bp: string; state: string }[];
  /** When true, this point is CONSUMED on first arrival — removed from nav
   *  targeting (MoveTo NavPoint / Get Nav Point / Patrol) so no other NPC
   *  goes to it. Resets on scene restart. */
  singleUse?: boolean;
}

/**
 * Project-level input mapping. Define an action once with a friendly name
 * ("Jump"), bind it to N keys (UP + W + SPACE), and reference it from any
 * event trigger via OnKeyPressed / OnKeyHeld / OnKeyReleased.
 *
 * Rebinding keys never breaks events because they reference action names,
 * not key codes. Phase 6 adds gamepad bindings; for now keys only.
 */
export interface InputActionDef {
  id: string;
  name: string;
  /** Phaser KeyCode strings (e.g. "LEFT", "A", "SPACE"). */
  keys: string[];
  /** Optional organizing group (folder) name. Empty / undefined = ungrouped.
   *  Editor-only metadata — the runtime only reads `name` + `keys`. */
  group?: string;
}

/**
 * Project-level signals — named pub/sub messages declared once with a friendly
 * name ("OnPickupCoin"); referenced by EmitSignal actions and `On Signal` triggers.
 * Behavior-emitted notifications (OnLand, OnJump, OnFall) are *not* signals —
 * they have dedicated trigger kinds.
 */
export interface SignalDef {
  id: string;
  name: string;
}

/**
 * Project-level GLOBAL variable. Unlike a Blueprint's per-instance variables
 * (which reset every scene because the Phaser game is torn down on each scene
 * transition), globals live in the runtime's persistent store and survive
 * scene changes for the whole Play session (money, day count, quest flags…).
 * Read / written via the `Set Global` node and the `global:<name>` expression
 * prefix (and `$global:<name>` inside text). Seeded to `default` at the start
 * of each Play session; written into Save/Load snapshots.
 */
export interface GlobalVarDef {
  id: string;
  name: string;
  /** "number" = integer, "float" = decimal (both stored as JS number),
   *  "string" = text, "boolean" = true/false. For an array global this is the
   *  ELEMENT type. */
  type: "number" | "float" | "string" | "boolean";
  default: number | string | boolean;
  /**
   * Array switcher — when true the global holds a LIST of `type` values
   * instead of a single one. Still read AND written at runtime (push / set /
   * removeAt / clear via the Global Array node; read via `global:name.<i>` and
   * `global:name.length`). `items` is the initial list; `default` is ignored.
   */
  isArray?: boolean;
  /** Initial array contents when `isArray` is true. */
  items?: (number | string | boolean)[];
}

/** One named entry inside a List — a key/value pair. */
export interface ListEntry {
  id: string;
  name: string;
  value: number | string | boolean;
  /** Optional per-entry type override. Unset → the entry follows the list's
   *  `type` (which is the default for new entries). Set → this one row is that
   *  type regardless, so a single list can hold mixed types (a config object:
   *  a number, a string, and a bool side by side). */
  type?: "number" | "float" | "string" | "boolean";
}

/**
 * Read-only LIST — a named GROUP of {name, value} entries authored in the editor
 * (prices, dialogue lines, spawn data, stats tables). A key-value lookup table.
 * NEVER modified at runtime: re-seeded fresh from the project each Play (not part
 * of save/load). Read via the `list:<group>.<entryName>` expression — e.g.
 * `list:prices.apple` → that entry's value; `list:prices.length` → entry count.
 */
export interface ListDef {
  id: string;
  name: string;
  /** Value type of every entry. */
  type: "number" | "float" | "string" | "boolean";
  entries: ListEntry[];
}

/**
 * Texture sampling, Construct-style. Controls how sprite textures are
 * filtered when drawn at non-native scale:
 *  - "nearest"   — point sampling. Crisp, no blur when scaled up; the
 *                  right choice for pixel art.
 *  - "bilinear"  — smooth linear filtering (the engine default).
 *  - "trilinear" — bilinear + mipmaps, smoother when scaled *down*.
 * Applied once as the global Phaser renderer default, so every texture —
 * sprites, particles, UI images, runtime-swapped sprites — follows it.
 */
export type ProjectSampling = "nearest" | "bilinear" | "trilinear";

export interface PeakyProject {
  /** v8: each asset (blueprint, scene, sprite metadata, etc.) lives in its
   *  own .json file on disk. The in-memory shape of PeakyProject stays the
   *  same — arrays are populated from individual files at load, written
   *  back at save. Reduces blast-radius of a corrupted write: losing one
   *  file loses one asset, not the whole project. v7 (monolithic manifest)
   *  doesn't load any more — no migration per project policy. */
  version: 8;
  name: string;
  blueprints: BlueprintDef[];
  scenes: SceneData[];
  sprites: SpriteAsset[];
  /** Sliced spritesheets used as tile palettes for the tile editor. Optional
   *  so legacy projects load; migrateProject backfills an empty array. */
  tilesets?: TilesetAsset[];
  /** Authored tile grids (each references one TilesetAsset). Placed in scenes
   *  via `tilemapInstances`. Optional; migrateProject backfills []. */
  tilemaps?: TilemapAsset[];
  /** Imported audio clips (music + sfx). Played at runtime via PlayMusic /
   *  PlaySound actions. Optional so legacy projects load; migrateProject
   *  backfills an empty array. */
  sounds?: SoundAsset[];
  /** Imported custom fonts (base64). Registered via FontFace at load + Play,
   *  then selectable as the fontFamily on text/labels. Optional for legacy
   *  projects; treated as [] when absent. */
  fonts?: FontAsset[];
  /** Inventory item definitions (name + icon + stack size). Optional so legacy
   *  projects load; migrateProject backfills an empty array. */
  items?: ItemAsset[];
  /** Crafting recipe definitions. Optional so legacy projects load;
   *  migrateProject backfills an empty array. */
  recipes?: RecipeAsset[];
  /** Project-level Dialogue assets. Authored in the DialogueTab; played at
   *  runtime via the `PlayDialogue` action. */
  dialogues: DialogueAsset[];
  /** Defaults applied to every dialogue (per-asset overrides win). */
  dialogueDefaults: DialogueDefaults;
  /** Viewport-culling buffer ring size, as a multiplier of the camera
   *  viewport. 1.0 = ring = viewport (aggressive, pop-in risk);
   *  1.5 = 50% buffer past each edge (recommended default — smooth pop-in);
   *  2.0 = generous (no pop-in, less savings). Only matters for BPs whose
   *  cullMode is "throttled" or "freeze"; ignored entirely for "never".
   *  Missing on legacy projects → defaults to 1.5 at runtime. */
  cullDistanceMultiplier?: number;
  /** Max sprites that can spawn in one frame. 0 (default) = unlimited
   *  (synchronous spawn — brief freeze at scene start with many NPCs but
   *  no slow-ramp visible to player). Values > 0 enable the spawn budget:
   *  excess spawns queue and drain across frames. Authors who hit
   *  mid-game CreateObject loops that spawn 100s of sprites can set
   *  this to ~50 to keep gameplay smooth at the cost of a visible spawn
   *  ramp. Missing → 0 (no budget). */
  spawnBudgetPerFrame?: number;
  /** Designer-authored 9-slice PNG dialog box assets. Selected per-style via
   *  `DialogueStyle.boxAssetId` when `theme === "image"`. Missing on legacy
   *  projects → defaults to empty (no boxes; image theme falls back to
   *  modern). */
  dialogBoxes?: DialogBoxAsset[];
  /**
   * Dialog Flow — declarative table of WHEN/WHERE/WHO triggers each dialog.
   * Authored in the DialogFlowTab as a chapter × NPC timeline; evaluated at
   * runtime by DialogFlowRunner. Does NOT replace `PlayDialogue` actions;
   * coexists with event-sheet wiring. Missing on legacy projects → defaults
   * to empty (no triggers, no chapters). */
  dialogFlow?: DialogFlowDef;
  /** UI Widgets — separate authoring class from BPs. Each widget is a
   *  composable UI element (HUD, button, panel, slider). UI widgets do NOT
   *  spawn a Phaser physics body at runtime; they render as a pure visual
   *  container with UI-specific behaviors (Anchor, Button, Stack, Slider).
   *  Created via the asset browser's right-click "New UI Widget" menu. */
  uiWidgets: UIWidgetDef[];
  activeSceneId: string;
  /** Optional Scene that the engine routes through when `GoToLayoutWithLoad`
   *  is used. While the target scene's assets are being loaded, this scene
   *  is the visible one — author wires its Logic Sheet against
   *  OnLoadStart / OnLoadProgress / OnLoadComplete to drive a progress bar,
   *  spinner, tip text, etc. Unset = the action falls back to plain GoToLayout. */
  loadingSceneId?: string;
  inputActions: InputActionDef[];
  /** Ordered Input Action group (folder) names. Lets a group exist while
   *  empty and fixes group display order. Actions reference a group by name
   *  via `InputActionDef.group`. */
  inputActionGroups?: string[];
  signals: SignalDef[];
  /** Project-level global variables — persist across scene transitions and
   *  the whole Play session (money, day, flags). Declared in the Main Logic
   *  Sheets manager; read/written via the Set Global node + `global:` prefix.
   *  Optional so legacy projects load; migrateProject backfills an empty array. */
  globalVariables?: GlobalVarDef[];
  /** Project-level read-only Lists — lookup tables filled in the editor, read
   *  at runtime via the `list:` prefix. Optional so legacy projects load. */
  lists?: ListDef[];
  /** Project-level "Main" logic sheets — scene-independent, run alongside
   *  Blueprint logic sheets. Author can have any number of them; each
   *  carries its own enabled flag so individual sheets can be toggled at
   *  runtime via the Main Logic Sheet manager UI. Replaces the legacy
   *  scene main event sheet. */
  mainLogicSheets?: MainLogicSheetDef[];
  /**
   * Content Browser folder paths, e.g. ["/Blueprints", "/Scenes", "/Audio"].
   * Stored explicitly so empty folders persist. Root "/" is implicit and
   * never appears in the list.
   */
  folders: string[];
  /**
   * Project-wide game-window size (Construct-style "Window Size"). The
   * Phaser canvas renders at this size at runtime; the camera shows
   * exactly this slice of the layout at any given moment. Each scene's
   * own `width / height` is the LAYOUT size — the world the camera can
   * scroll across — and may be larger than the viewport.
   */
  viewportWidth: number;
  viewportHeight: number;
  /** Global texture filtering. Defaults to "bilinear" when absent. */
  sampling?: ProjectSampling;
}

// ─── Sprite assets ────────────────────────────────────────────────────────────

/** Named anchor point on a sprite frame (for spawning, pinning, etc.). */
export interface SpriteImagePoint {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface SpriteFrame {
  id: string;
  /** Fallback hex colour rendered when no image is set. */
  color: number;
  /**
   * Frame image filename, RELATIVE to the sprite's on-disk folder
   * (assets/<CB-path>/<sprite-name>/). Typically just "<frame-id>.png".
   * The resolver in AssetStore composes the full project-relative path
   * from this + the parent SpriteAsset's path/name. Keeping it relative
   * means renaming the sprite (and its folder) doesn't need to rewrite
   * every frame. Empty/missing = no image (color-only frame).
   */
  imageFile?: string;
  imageW?: number;
  imageH?: number;
  pivotX?: number;
  pivotY?: number;
  points?: SpriteImagePoint[];
  /** Per-frame collider — when set, the sprite asset becomes its own
   *  source of hitbox data. SpritePlacements and BPs with SpriteRenderer
   *  read this to size their collision body to the visible frame, so
   *  punch animations can grow the hitbox on the impact frame and shrink
   *  it elsewhere. Construct 3 / GameMaker style. */
  collider?: SpriteFrameCollider;
}

export interface SpriteFrameCollider {
  /** Off = frame has no collider (the body shrinks to 0 or follows
   *  the previous frame's collider, depending on the consumer). */
  enabled: boolean;
  /** AABB width in pixels, relative to the frame's local space. */
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  /** Tags listed here are IGNORED by collisions against this frame —
   *  e.g. an attack frame might exempt "ally" so friendly fire is off.
   *  Empty list = no exemptions. */
  exceptionTags?: string[];
}

export interface SpriteAnimationDef {
  id: string;
  name: string;
  frames: SpriteFrame[];
  fps: number;
  loop: boolean;
}

export interface SpriteAsset {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  path: string;
  /** First entry is the runtime "default" animation. Reorder via the SpriteTab. */
  animations: SpriteAnimationDef[];
  width: number;
  height: number;
  lockAspect: boolean;
}

// ─── Tilemap assets ───────────────────────────────────────────────────────────

/**
 * TerrainDef — a Unity Rule Tile-style auto-tile terrain.
 *
 * The terrain is a list of RULES evaluated in order at paint time. Each rule
 * names a TILE and an 8-neighbor pattern of constraints. The first rule whose
 * pattern matches the cell's actual neighborhood wins, and its tile is drawn.
 * If no rule matches, `defaultTile` is drawn instead.
 *
 * Each neighbor in a rule is one of:
 *   "any"     — wildcard, matches whether or not the neighbor is same-terrain
 *   "must"    — that neighbor MUST be same-terrain
 *   "mustNot" — that neighbor MUST NOT be same-terrain (dirt / empty / different)
 *
 * Author flow: "I have this top-left corner art. When should it appear? When
 * N=mustNot, W=mustNot, E=must, S=must. Everything else: any." Rules with more
 * `any` slots match more patterns, so put SPECIFIC rules first and broad ones
 * last (or use defaultTile as the broad fallback).
 *
 * Tile "ownership" — for "what counts as same-terrain" during neighbor checks —
 * is inferred from `defaultTile` + every `tile` referenced by a rule.
 */
export type NeighborState = "any" | "must" | "mustNot";

export interface TerrainRule {
  id: string;
  /** Tile index drawn when this rule matches. */
  tile: number;
  /** 8 neighbor constraints in clockwise order from N:
   *  [0]=N, [1]=NE, [2]=E, [3]=SE, [4]=S, [5]=SW, [6]=W, [7]=NW */
  neighbors: NeighborState[];
}

export interface TerrainDef {
  id: string;
  name: string;
  /** Display swatch in the painter's terrain palette. */
  color: number;
  /** Drawn when no rule matches AND used as initial stamp tile during the
   *  brush stroke (so neighbors evaluate against a known same-terrain marker). */
  defaultTile: number;
  /** Rule list, evaluated top-down. First match wins. */
  rules: TerrainRule[];
}

/**
 * TilesetAsset — a sliced spritesheet used as a tile palette. The image is
 * stored as a data URL (consistent with SpriteAsset frames so a `.peaky.json`
 * carries its own art). The slicer params (tile size, offset, spacing) are
 * stored so the painter can show the right grid without re-importing, and so
 * the runtime can pass them straight to Phaser's `addTilesetImage`.
 *
 * `solidTiles` is the per-tile collision flag — when a tile from this set
 * appears in a Tilemap, that cell blocks any sprite with a Collider. Stored
 * as a sorted index list for stable JSON; the runtime materializes a Set.
 *
 * `terrains` are optional auto-tile definitions — see TerrainDef.
 */
export interface TilesetAsset {
  id: string;
  name: string;
  path: string;
  hidden?: boolean;
  /** Source sheet image — filename relative to the tileset's on-disk folder
   *  (assets/<CB-path>/<tileset-name>/). The AssetStore resolves this to a
   *  blob URL at render time. Empty = no image imported yet. */
  imageFile: string;
  /** Sheet pixel dimensions, captured at import for the slicer preview. */
  sheetW: number;
  sheetH: number;
  /** Cell dimensions in pixels. */
  tileW: number;
  tileH: number;
  /** Top-left margin before the first cell (matches Tiled / Phaser conventions). */
  offsetX: number;
  offsetY: number;
  /** Gap between adjacent cells. */
  spacingX: number;
  spacingY: number;
  /** Sliced grid dimensions — derived from the params above but stored so the
   *  painter palette stays consistent if the sheet image is missing. */
  cols: number;
  rows: number;
  /** Tile indices (0..cols*rows-1, row-major) that block movement. */
  solidTiles: number[];
  /** Auto-tile terrain definitions. Optional; backfilled to [] on legacy load. */
  terrains?: TerrainDef[];
  /** Per-tile custom collision POLYGON (point coords in pixels within the
   *  tile cell, in click order — should be a non-self-intersecting closed
   *  shape). Tiles listed in `solidTiles` but NOT in this map use the
   *  efficient full-cell layer-collision path. Tiles WITH a polygon are
   *  decomposed into axis-aligned rectangles at load time and become static
   *  physics bodies. Default polygon (if a user inserts and doesn't edit):
   *  a 4-point rect covering the cell. */
  tileColliders?: Record<string, { points: { x: number; y: number }[] }>;
  /** Per-tile-index hit-points for mining. Tiles NOT in this map are
   *  treated as unbreakable by `MineTileAtWorld` (no-op). HP is consumed
   *  cumulatively across multiple mining hits — the runtime keeps a scene-
   *  level scratch map keyed by `(tilemapId, layerId, c, r)` so the same
   *  tile-index can have different remaining HP at different cells. */
  /** Per tile-index max HP. Either a literal positive integer ("3" or 3)
   *  OR a `random(min, max)` expression that rolls per-cell on first damage
   *  (each placed cell gets its own random HP from the same expression).
   *  0 / missing = unbreakable. */
  tileHardness?: Record<string, number | string>;
  /** Per-tile-index grow-back delay in SECONDS — a destroyed cell of this index
   *  re-appears after this long (HP resets to full). 0 / blank = never. Accepts
   *  a number, `random(min, max)`, or `choose(a, b, …)`, rolled per destroyed
   *  cell. */
  tileGrowBack?: Record<string, number | string>;
  /** Per-tile-index "pop in (scale 0→1) on regrow" toggle. Absent = on; store
   *  `false` to make a regrown cell appear instantly. */
  tileGrowBackPop?: Record<string, boolean>;
  /** Per-tile-index drop tables. When a mined tile's HP reaches 0, every
   *  entry rolls independently:
   *    - `chance` (0..100) decides whether the entry fires.
   *    - `min..max` rolls how many copies to spawn.
   *    - `bp` names the Blueprint to spawn (e.g. an `ItemPickup` BP the
   *      user authored). The spawn passes `instanceName`, `animation`,
   *      `frame`, and the `vars` map as per-instance overrides — same
   *      semantics as placing a BP in the scene editor. The BP itself
   *      handles its own OnOverlap → GiveItem + Destroy logic. */
  tileDrops?: Record<string, {
    bp: string;
    min: number;
    max: number;
    chance: number;
    instanceName?: string;
    animation?: string;
    frame?: number;
    vars?: Record<string, string | number | boolean>;
  }[]>;
  /** Per tile-index drop layer NAME. Spawned drop BPs land on this scene
   *  layer instead of the tilemap's own layer. Empty / missing → drops
   *  inherit the tilemap's layer (same parallax, depth band, opacity). Use
   *  this when drops should sit on a separate "particles" or "items" layer
   *  with its own depth / opacity / parallax. */
  tileDropLayer?: Record<string, string>;
  /** Tags whose sprites pass through EVERY collider in this tileset
   *  (regular tiles, animated tiles, big tiles). Combined union-style with
   *  per-collider excludedTags — a sprite passes through if any of its tags
   *  match any tag in the union. Use for global "ghost" / "spirit" tags. */
  globalExcludedTags?: string[];
  /** Per-tile-index extra excluded tags. Stacks on top of globalExcludedTags
   *  (union). For tiles where some tagged sprites should pass through but
   *  the rest of the tileset shouldn't. */
  tileExcludedTags?: Record<string, string[]>;
  /** Per-tile-index "what happens to the tile directly above when THIS tile
   *  is destroyed":
   *    - `destroy` — fire the above tile's drop table + recurse upward
   *    - `drop`    — tween the above tile down into the gap, recurse
   *    - missing / "none" — above stays put (default)
   *  Set on the tiles you want to BE AFFECTED when their floor is mined out. */
  tileOnBelowRemoved?: Record<string, "destroy" | "drop">;
  /** "Big tiles" — multi-cell regions of the spritesheet treated as one
   *  composite tile (e.g. a 4x6 tree). Painted as a single unit into a
   *  tilemap and rendered as ONE sprite at runtime so it Y-sorts as one
   *  object (canopy + trunk together) instead of each cell individually. */
  bigTiles?: BigTile[];
  /** Animated tile templates — N frames cycled at `fps`. Painted into a
   *  layer as `animatedTilePlacements`. Each placement becomes one Phaser
   *  Image at runtime whose displayed tile-index cycles through `frames`. */
  animatedTiles?: AnimatedTileDef[];
  /** Manual Tile Builder — the RAW source sheet (messy showcase image) the
   *  user draws regions on. Stored alongside the baked `imageFile` so regions
   *  stay re-editable. Filename relative to the tileset folder. */
  manualSourceFile?: string;
  /** Free-form per-tile regions drawn on `manualSourceFile`, in SOURCE pixels.
   *  `tw`/`th` = the chosen OUTPUT size of THIS box in pixels (defaults to the
   *  detected box size). The bake sizes the grid cell to the biggest box and
   *  draws each box at its own `tw`×`th`. */
  manualRegions?: { x: number; y: number; w: number; h: number; tw?: number; th?: number }[];
  /** Bake scaling mode: "snap" stretches each region to fill the cell exactly
   *  (edges land on the grid); "free" scales to fit keeping aspect (centered,
   *  transparent letterbox — no distortion). Default "snap". */
  manualFit?: "snap" | "free";
  /** Manual-builder "Uniform" mode: bake every region to one size (`manualUniW`
   *  × `manualUniH`) instead of per-box sizes. Persisted so reopening the
   *  builder restores the author's choice. */
  manualUniform?: boolean;
  manualUniW?: number;
  manualUniH?: number;
}

/**
 * AnimatedTileDef — one named animated tile composed of N existing tile
 * indices played as a cycle at the configured FPS. Painted into a tilemap
 * layer the same way as a regular tile/BigTile, but the runtime animates
 * the displayed frame instead of showing one static index.
 */
/** One animated-tile frame. A bare number is a single sliced-grid index (a 1×1
 *  cell — the legacy/common form). A `{c,r,w,h}` object is a multi-cell region
 *  (a drag-selected rectangle or a BigTile's footprint) so an animated tile can
 *  span several cells. The two forms coexist in one `frames[]`. */
export type AnimFrame = number | { c: number; r: number; w: number; h: number };

/** Normalize an AnimFrame to a {c,r,w,h} region using the tileset column count. */
export function animFrameRegion(f: AnimFrame, cols: number): { c: number; r: number; w: number; h: number } {
  if (typeof f === "number") {
    return { c: cols > 0 ? f % cols : 0, r: cols > 0 ? Math.floor(f / cols) : 0, w: 1, h: 1 };
  }
  return { c: f.c, r: f.r, w: Math.max(1, f.w), h: Math.max(1, f.h) };
}

/** The animation footprint = the largest frame's w×h (smaller frames center). */
export function animFootprint(frames: AnimFrame[], cols: number): { w: number; h: number } {
  let w = 1, h = 1;
  for (const f of frames) { const r = animFrameRegion(f, cols); w = Math.max(w, r.w); h = Math.max(h, r.h); }
  return { w, h };
}

export interface AnimatedTileDef {
  id: string;
  name?: string;
  /** Playback frames in order. Each is either a single sliced-grid index (1×1)
   *  or a {c,r,w,h} multi-cell region / BigTile footprint. See {@link AnimFrame}. */
  frames: AnimFrame[];
  /** Frames per second. 0 = freeze on `frames[0]`. */
  fps: number;
  /** Loop when the end is reached. When false, the placement freezes on
   *  the last frame. Per-placement Play actions can override via param. */
  loop: boolean;
  /** When true, every placement starts playing the moment the scene loads.
   *  When false, placements wait for `PlayTileAnimation` from the logic sheet. */
  autoplay: boolean;
  /** Hit-points to destroy via mining. Absent = unbreakable (matches the
   *  same convention as `tileHardness`). Literal integer OR a
   *  `random(min, max)` expression that rolls per-placement on first damage. */
  hardness?: number | string;
  /** Grow-back delay in SECONDS — a destroyed placement re-appears after this
   *  long. 0 / blank = never. number, `random(min, max)`, or `choose(a, b, …)`. */
  growBack?: number | string;
  /** Pop in (scale 0→1) on regrow. Absent = on; false = appear instantly. */
  growBackPop?: boolean;
  /** When false, the placement STAYS in the scene after HP reaches 0 — the
   *  collider is removed, drops + OnTileDestroyed still fire, but the
   *  Phaser Image isn't destroyed. Defaults to true (instant destroy). */
  destroyOnDepleted?: boolean;
  /** When true, HP-0 also restarts the animation from frame 0 with loop
   *  forced off — a one-shot "crumble" / "deplete" effect. When the
   *  one-shot finishes, the placement is destroyed iff `destroyOnDepleted`
   *  is true; otherwise it freezes on the last frame. */
  playOnDepleted?: boolean;
  /** When true, EVERY surviving mine hit plays the animation once (frame 0 →
   *  end), then returns to frame 0 (idle) — a "shake/crack on hit" reaction.
   *  The killing hit plays it once too, then destroys iff destroyOnDepleted.
   *  Independent of playOnDepleted (which fires only at HP 0). */
  playOnHit?: boolean;
  /** When true, the frame slots double as damage stages: `frames.length`
   *  must equal `hardness`, animation playback is disabled, and each
   *  mining hit advances the displayed frame. Frame 0 = full HP, frame N-1
   *  = the last hit before destruction. Editing `hardness` auto-resizes
   *  the frames array in the editor; toggling this on for an existing
   *  def pads / truncates to match. */
  damageStagesMode?: boolean;
  /** Drop table, same shape and semantics as `tileDrops` — spawns BPs at
   *  the placement's world position on destroy. */
  drops?: {
    bp: string;
    min: number;
    max: number;
    chance: number;
    instanceName?: string;
    animation?: string;
    frame?: number;
    vars?: Record<string, string | number | boolean>;
  }[];
  /** Drop layer NAME. Same semantics as `tileDropLayer` — empty → drops
   *  inherit the tilemap's layer. */
  dropLayer?: string;
  /** Extra excluded tags for THIS animated placement (union with the
   *  tileset's globalExcludedTags). Sprites with a matching tag pass through. */
  excludedTags?: string[];
  /** Cascade behavior for the tile ABOVE this animated tile when it gets
   *  destroyed (`destroy` chains drops + recurses, `drop` tweens it down). */
  onBelowRemoved?: "destroy" | "drop";
  /** Custom collider polygon in tile-local coords (0..1 fractions of one
   *  cell). Absent = solid full-cell when the first frame's index appears
   *  in the tileset's `solidTiles` list; otherwise no collision. */
  collide?: { points: { x: number; y: number }[] };
  /** Tags applied to every placement — same purpose as BigTile.tags. */
  tags?: string[];
  /** When true, the placement plays its animation when a sprite carrying one
   *  of `overlapTags` enters its cell (player stepping on a pressure plate,
   *  walking through grass, etc.). `overlapMode` picks the replay behavior. */
  playOnOverlap?: boolean;
  /** Only sprites carrying one of these tags trigger `playOnOverlap`. Empty
   *  = nothing triggers (don't accidentally fire for every sprite). */
  overlapTags?: string[];
  /** Replay behavior for `playOnOverlap`:
   *   "edge"  — play once each time a sprite ENTERS the cell (re-enter replays).
   *   "loop"  — loop while any sprite overlaps; freeze on frame 0 when empty.
   *   "latch" — play once on enter, don't replay until the cell empties. */
  overlapMode?: "edge" | "loop" | "latch";
  /** Signal emitted on the miner + Main Sheets on every surviving hit. */
  signalOnHit?: string;
  /** Signal emitted on the miner + Main Sheets when destroyed (HP 0). */
  signalOnMine?: string;
}

/**
 * BigTile — a rectangular region of the tileset's sliced grid that the
 * user has "united" as one logical tile. Used for trees, buildings, props
 * that span multiple cells but should always be placed and sorted together.
 */
export interface BigTile {
  id: string;
  /** Optional readable name, so logic can place/identify this BigTile by name
   *  (e.g. "tree", "rock") instead of its opaque id. Empty = id-only. */
  name?: string;
  /** Top-left cell coords in the tileset grid (0..cols-1, 0..rows-1). */
  c: number;
  r: number;
  /** Size in cells (e.g. 4 wide × 6 tall). */
  w: number;
  h: number;
  /** Pivot fractions (0..1) within the BigTile's bounding rect. The clicked
   *  cell during placement becomes the BigTile's pivot. Defaults: 0.5, 1.0 —
   *  bottom-center (natural for trees/buildings: the trunk base lands at the
   *  click). */
  pivotX?: number;
  pivotY?: number;
  /** Y-sort flip point (0..1) — intuitive convention:
   *  - 0 = tree ALWAYS covers (depth-flip at bottom of bbox)
   *  - 1 = tree NEVER covers (depth-flip at top of bbox)
   *  - 0.5 = flip at vertical middle
   *  For a typical tree, ~0.3 puts the flip near the canopy's bottom edge
   *  (most natural "walk-behind" line). Defaults to 0 (always cover, safe). */
  sortY?: number;
  /** Y-sort line position (0..1) within the bbox when sortY = 0.5 (Y-sort
   *  mode): 0 = top edge, 0.5 = middle (default), 1 = bottom. The player
   *  passes behind once their feet rise above this line. Separate from the
   *  red placement pivot so adjusting the sort line never moves placements. */
  sortLineY?: number;
  /** Collision rect (in cell units) within the BigTile bbox — defines which
   *  sub-region blocks movement. Default = no collision. Set to e.g. the
   *  trunk cells of a tree so players can pass through the canopy but bump
   *  into the trunk. cx,cy = top-left in cells (0..w-1, 0..h-1), cw,ch in
   *  cells. */
  collide?: { cx: number; cy: number; cw: number; ch: number };
  /** Custom collision polygon spanning the whole BigTile footprint, in pixels
   *  (0..w·tileW, 0..h·tileH of the owning tileset). When set it REPLACES the
   *  cell-rect `collide` — the runtime decomposes it into axis-aligned rects.
   *  Edited as one shape, like a single tile's collision polygon. */
  collidePoly?: { points: { x: number; y: number }[] };
  /** Whether the painted `collidePoly` shape BLOCKS movement. Decoupled from
   *  the shape itself: a shape can exist purely as the mining damage area
   *  without being solid. Undefined = legacy behavior (a shape implies solid),
   *  so old saves keep blocking; the editor writes an explicit boolean. */
  solid?: boolean;
  /** Tags applied to every placement of this BigTile. VisionMask's
   *  `excludeTags` filter reads these — tag a ground/grass BigTile with
   *  "ground" and a VisionMask that excludes "ground" will leave it alone
   *  while still fading trees etc. Empty by default. */
  tags?: string[];
  /** Extra excluded tags for THIS BigTile's collider (union with the
   *  tileset's globalExcludedTags). Sprites with a matching tag pass through. */
  excludedTags?: string[];
  /** Cascade behavior when the tile directly below ANY of this BigTile's
   *  bottom-row cells is destroyed. `destroy` removes the whole BigTile and
   *  recurses upward from its top edge; `drop` falls back to destroy (true
   *  multi-cell drop tween isn't supported in v1). Missing = no cascade. */
  onBelowRemoved?: "destroy" | "drop";
  /** Sparse cell mask (relative to bbox top-left) for non-rectangular shapes
   *  like T / L / cross. When present, ONLY these cells are part of the
   *  composite — visual rendering skips other cells in the bbox, and the
   *  cascade "floor lost" check only treats cells below these as "ground".
   *  Absent = full bbox (backwards-compatible default). */
  cells?: { c: number; r: number }[];
  /** Mining HP for the WHOLE composite — one pool shared across all cells.
   *  0 / missing = unbreakable (Mine just no-ops). Accepts a number or a
   *  `random(min, max)` expression rolled once per placement on first hit. */
  hardness?: number | string;
  /** Grow-back delay in SECONDS — a destroyed placement re-appears after this
   *  long. 0 / blank = never. number, `random(min, max)`, or `choose(a, b, …)`. */
  growBack?: number | string;
  /** Pop in (scale 0→1) on regrow. Absent = on; false = appear instantly. */
  growBackPop?: boolean;
  /** Mineable sub-region (cell units within the bbox). A Mine hit only damages
   *  the BigTile when it lands inside this rect (e.g. a tree's trunk, not the
   *  canopy). Missing = the whole footprint is mineable. cx,cy = top-left in
   *  cells (0..w-1, 0..h-1), cw,ch in cells. */
  damageRect?: { cx: number; cy: number; cw: number; ch: number };
  /** Drop table — spawns BPs at the footprint center when HP hits 0. Same
   *  shape/semantics as tileDrops. */
  drops?: {
    bp: string;
    min: number;
    max: number;
    chance: number;
    instanceName?: string;
    animation?: string;
    frame?: number;
    vars?: Record<string, string | number | boolean>;
  }[];
  /** Scene layer NAME where drops spawn. Empty = the tilemap's own layer. */
  dropLayer?: string;
  /** When false, HP-0 keeps the composite in the scene (collider removed,
   *  drops still fire) instead of destroying it. Defaults to true. */
  destroyOnDepleted?: boolean;
  /** Signal emitted on the miner + Main Sheets on every surviving hit. */
  signalOnHit?: string;
  /** Signal emitted on the miner + Main Sheets when destroyed (HP 0). */
  signalOnMine?: string;
}

/**
 * One layer of a TilemapAsset — a 2D tile grid + display props. Multiple
 * layers stack inside a single tilemap by their `z` order (ascending; higher
 * draws on top). Lets one map carry ground / decoration / foreground in one
 * asset instead of three separate placements.
 */
export interface TilemapLayer {
  id: string;
  name: string;
  /** Row-major flat tile data: `tiles[r * cols + c]` is the tile index, or
   *  `-1` for an empty cell. Length = rows * cols. */
  tiles: number[];
  /** Sparse per-cell brush transform, keyed by the SAME flat index as `tiles`
   *  → a packed byte: bit0 = flipX, bit1 = flipY, bits2-3 = rotation (0-3 × 90°
   *  CW). Only transformed (non-zero) cells are stored, so the tile INDEX array
   *  stays untouched — collision / hardness / mining read the index exactly as
   *  before; only the two renderers consult this. Omit / 0 = upright. */
  xf?: Record<number, number>;
  /** Stacking order — higher z renders on top. Ties broken by array order. */
  z: number;
  /** Opacity multiplier (0..1) — useful for parallax / overlay effects. */
  alpha: number;
  /** When false the layer is hidden in the painter AND the runtime. */
  visible: boolean;
  /** When false, tiles on this layer don't block movement even if the tileset
   *  marks them solid. Lets decoration / foreground layers stay non-blocking. */
  collides: boolean;
  /** BigTile placements — instances of a tileset BigTile painted into this
   *  layer at (c, r) anchor coords. Each placement renders as ONE sprite
   *  and Y-sorts as one unit. */
  bigTilePlacements?: { id: string; bigTileId: string; c: number; r: number }[];
  /** Animated tile placements — instances of a tileset AnimatedTileDef
   *  painted into this layer at (c, r). Each placement renders as one
   *  Phaser Image whose frame cycles per the def's fps + loop. */
  animatedTilePlacements?: { id: string; animatedTileId: string; c: number; r: number }[];
  /** Per-layer Y-sort opt-in. Only takes effect when the SCENE layer this
   *  tilemap sits on is also Y-sort. When both are on, this layer renders
   *  per-cell so its tiles interleave with sprites by Y (player walks behind);
   *  off (default) keeps it on the cheap batched path. Mark only sparse
   *  foliage/object layers — leave big water/grass fills off for performance. */
  ySort?: boolean;
  /** When true, BigTile/animated placements on this layer may OVERLAP — a new
   *  placement does NOT delete existing ones it intersects. For dense Y-sorted
   *  forests (canopies over neighbors; draw order from Y-sort). Painting drag-
   *  strokes still space stamps by their base row so a single drag doesn't
   *  stack copies. Default off = one placement per cell (safe). */
  allowOverlap?: boolean;
}

/**
 * TilemapAsset — a stack of tile layers that share dimensions and one
 * tileset. Painted into via the TilemapTab; placed in scenes as a
 * `TilemapInstance`. `cols`/`rows` are shared across layers so the painter UI
 * works uniformly; each layer carries its own tile array and z so authors can
 * build multi-layer art in a single asset.
 *
 *  A map can reference MULTIPLE tilesets (`tilesetId` + `extraTilesetIds`).
 *  Cells stay `number[]` but hold GLOBAL tile ids resolved to a tileset by
 *  firstgid ranges — see {@link tilemapTilesets} / {@link resolveGid}.
 */
export interface TilemapAsset {
  id: string;
  name: string;
  path: string;
  hidden?: boolean;
  /** The PRIMARY tileset this map paints from (firstgid 0). Always present so
   *  legacy single-tileset maps keep working with zero migration. */
  tilesetId: string;
  /** Additional tilesets layered on top of the primary, in order. Combined with
   *  `tilesetId` they form the map's ordered tileset list. Painted cells store
   *  GLOBAL tile ids (Tiled-style firstgid): tileset k owns the id range
   *  [firstgid_k, firstgid_k + cols_k*rows_k), where firstgid is the cumulative
   *  cell count of earlier tilesets. firstgid_0 = 0 means every id painted with
   *  the old single-tileset model still resolves to the primary tileset. */
  extraTilesetIds?: string[];
  cols: number;
  rows: number;
  /** One or more painted layers, stacked by `z`. Sub-z bands inside the
   *  scene's parent layer keep render order stable across all instances. */
  layers: TilemapLayer[];
  /** Tilemap-wide tags merged into every layer's tag list at runtime. Lets
   *  the author tag a whole tilemap (e.g. "bg") once instead of putting the
   *  same tag on each of its layers. VisionMask's excludeTags reads them. */
  tags?: string[];
}

/**
 * TilemapInstance — a placement of a Tilemap into a scene. Mirrors
 * `UIWidgetInstance` (separate list, separate from gameplay BPs). `x`/`y` is
 * the TOP-LEFT of the rendered map (matches Tiled / standard tilemap
 * convention); the visible area = cols×tileW by rows×tileH.
 */
export interface TilemapInstance {
  id: string;
  tilemapId: string;
  x: number;
  y: number;
  layerId: string;
  /** Per-instance z stacks within the layer band — same convention as
   *  `BlueprintInstance.z`. Higher = closer to camera (depth + parallax). */
  z?: number;
  /** Optional alpha multiplier applied on top of the scene layer's opacity. */
  alpha?: number;
  /** Editor-side lock — when true, this tilemap instance can't be selected
   *  or dragged from the scene canvas. Independent of runtime visibility. */
  locked?: boolean;
}

/** One entry in a tilemap's resolved tileset list — the TilesetAsset plus the
 *  firstgid (global tile id of its first cell). See {@link tilemapTilesets}. */
export interface TilemapTilesetSlot {
  ts: TilesetAsset;
  firstgid: number;
  /** Cell count = cols*rows; ids [firstgid, firstgid+count) belong to this slot. */
  count: number;
}

/** Spacing between tileset slots in the global-id space. A slot's firstgid is
 *  `slotIndex * STRIDE`, NOT a running tile count — so re-baking / re-slicing a
 *  tileset (which changes its tile count) can NEVER shift another tileset's
 *  numbering. As long as no single tileset exceeds STRIDE tiles, ranges never
 *  overlap. (Painted cells store these ids; the runtime remaps them to a
 *  contiguous space when it builds its combined texture.) */
export const TILESET_GID_STRIDE = 1_000_000;

/** Resolve a tilemap's ordered tileset list with STABLE per-slot firstgids. The
 *  primary `tilesetId` is always first (firstgid 0); `extraTilesetIds` follow.
 *  Missing tileset ids are skipped but DON'T shift later slots (the index is
 *  preserved), so a deleted tileset only blanks its own cells. Used by the
 *  painter, scene preview, and runProject so all three agree on the numbering. */
export function tilemapTilesets(
  map: { tilesetId: string; extraTilesetIds?: string[] },
  all: TilesetAsset[],
): TilemapTilesetSlot[] {
  // Keep the FULL ordered list (don't pre-filter blanks) so a slot's firstgid
  // = its position × STRIDE stays stable even if an EARLIER slot is blank/
  // deleted. Filtering would shift later slots' indices → their painted ids
  // would resolve to the wrong tileset (silent corruption).
  const ids = [map.tilesetId, ...(map.extraTilesetIds ?? [])];
  const out: TilemapTilesetSlot[] = [];
  ids.forEach((id, idx) => {
    if (!id) return;
    const ts = all.find((t) => t.id === id);
    if (!ts) return;
    out.push({ ts, firstgid: idx * TILESET_GID_STRIDE, count: Math.max(1, ts.cols * ts.rows) });
  });
  return out;
}

/** Map a global tile id to its owning slot + local index, or null if the id
 *  falls in a gap (deleted tileset / out of range). */
export function resolveGid(
  g: number,
  slots: TilemapTilesetSlot[],
): { slot: TilemapTilesetSlot; local: number } | null {
  if (g < 0) return null;
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (g >= s.firstgid) {
      const local = g - s.firstgid;
      return local < s.count ? { slot: s, local } : null;
    }
  }
  return null;
}

// ─── Sound assets ─────────────────────────────────────────────────────────────

/**
 * SoundAsset — an imported audio clip (mp3 / ogg / wav) stored as a base64
 * data URL in the project (same self-contained approach as sprite frames, so
 * a `.peaky.json` carries its own audio).
 *
 * `kind` splits the two game-audio roles:
 *   - "music" → a looping background track. The runtime keeps ONE music
 *     track playing at a time on the music bus; PlayMusic replaces the
 *     current one (with optional fade). Routed through the master×music
 *     volume.
 *   - "sfx" → fire-and-forget one-shots that overlap freely on the sfx bus.
 *     Routed through master×sfx volume.
 *
 * Per-call PlayMusic / PlaySound actions can override `volume` and `loop`.
 */
export interface SoundAsset {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  path: string;
  /** Audio filename relative to the sound's CB-path folder under assets/.
   *  E.g. for a "Jump" sfx at CB-path "/SFX", on-disk lives at
   *  assets/SFX/Jump.mp3 and `file` is "Jump.mp3". The AssetStore resolves
   *  this to a blob URL at runtime preload. */
  file: string;
  /** Audio role — drives bus routing + default loop behavior. */
  kind: "music" | "sfx";
  /** Default playback volume 0..1. Per-call actions may override. */
  volume: number;
  /** Default loop flag. Music seeds true, sfx seeds false. */
  loop: boolean;
  /** SFX voice limit — max simultaneous copies of THIS sound. Beyond it the
   *  oldest copy is stolen. 0 / undefined = unlimited. Tames "many enemies, one
   *  hit sound" clipping + machine-gun phasing. */
  maxInstances?: number;
  /** Min real-time ms between retriggers of this sound — a burst within the
   *  window collapses to one play. 0 / undefined = no throttle. */
  minIntervalMs?: number;
}

/**
 * FontAsset — an imported font file (ttf / otf / woff / woff2). Lives flat
 * under `assets/fonts/<name>.<ext>` on disk. `name` IS the CSS font-family:
 * it's registered via FontFace under this name and used verbatim wherever a
 * `fontFamily` is set (widget text, Text behavior).
 */
export interface FontAsset {
  id: string;
  /** Display name AND the font-family string used at render. Must be unique. */
  name: string;
  /** Font filename within assets/fonts/, e.g. "Pixel.ttf". */
  file: string;
}

/**
 * Item asset — a lightweight inventory item definition. Authored in the
 * Content Browser like sprites/sounds. An item's icon is an existing
 * SpriteAsset's first frame; the runtime resolves it to a texture key.
 * Inventory actions/conditions reference items BY NAME.
 */
export interface ItemAsset {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  path: string;
  /** Icon — an existing SpriteAsset id. */
  spriteId: string;
  /** Animation id within the sprite to draw the icon from. Empty/missing =
   *  the sprite's first animation. */
  iconAnim?: string;
  /** Which frame of `iconAnim` is the icon: >=0 = that static frame; -1 =
   *  animate the whole animation (animated icon). Missing = frame 0. */
  iconFrame?: number;
  /** Max units per stack. 1 = non-stackable. */
  maxStack: number;
  /** Optional categorization tags (comma-authored). */
  tags?: string[];
  /** Custom per-item data, readable in the Logic Sheet via the GetItemProp
   *  action (e.g. damage=40, heal=25, type="fruit"). */
  props?: ItemProp[];
  /**
   * Persistent COUNT global for this item — `global:<countGlobal>` tracks how
   * many the player owns. Auto-filled with a sanitized version of the item name
   * when the item is created; editable. The single source of truth for "owned
   * items": pickups, the shop, crafting, and HUD all read/write this global, so
   * it persists across scenes for free and never desyncs. Empty = the item
   * isn't counted (e.g. a quest token tracked some other way).
   */
  countGlobal?: string;
  /** Shop buy price (cost to the player). 0 / undefined = not buyable. */
  buyPrice?: number;
  /** Shop sell price (payout to the player). 0 / undefined = not sellable. */
  sellPrice?: number;
  /** Blueprint id to SPAWN as a world pickup when this item is dropped (e.g.
   *  by mining a tile, killing an enemy, breaking a vase). Empty = drops add
   *  the item DIRECTLY to the actor's bag / count global instead of spawning
   *  a physical pickup. The spawned BP is responsible for its own collision /
   *  player-overlap → GiveItem logic — author the pickup BP once with an
   *  OnOverlap "pickup" trigger and link it here. */
  pickupBp?: string;
}

/** Turn an item name into a valid global-variable key (`Apple Seed` → `AppleSeed`).
 *  Strips anything that isn't a letter/digit/underscore so it parses in
 *  `global:<name>` expressions. */
export function itemCountGlobalName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `item_${cleaned}`;
}

/** One custom property on an Item asset. */
export interface ItemProp {
  key: string;
  type: "number" | "string" | "bool";
  value: number | string | boolean;
}

/**
 * Recipe asset — a crafting recipe authored in the Content Browser. Inputs and
 * output reference Items BY NAME. The runtime's Inventory behavior consumes the
 * inputs and adds the output (all-or-nothing) via the Craft action / Crafting
 * widget. Has no own icon — the UI draws the OUTPUT item's icon.
 */
export interface RecipeInput {
  item: string;
  qty: number;
}
export interface RecipeAsset {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  path: string;
  inputs: RecipeInput[];
  outputItem: string;
  outputQty: number;
  /** When false, the crafting action refuses to consume inputs / produce
   *  the output for this recipe — useful for locked / quest-gated recipes
   *  the author wants to flip on at runtime. Defaults to true (treated
   *  as enabled) when unset for back-compat with saved projects. */
  enabled?: boolean;
}

// ─── UI Widget assets ─────────────────────────────────────────────────────────

/**
 * UIWidgetKind — what TYPE of UI element this widget is. Determines the
 * runtime visual + interaction. Each widget IS one of these (not a
 * composition of components — that approach was scrapped because it
 * required users to manually attach SpriteRenderer + Text + Collider
 * and size the body to get anything visible).
 *
 *   - Panel       → rect with bg + border. Optional child layout
 *                    (row/column with gap + justify + align).
 *   - Label       → static text on a transparent or colored bg.
 *   - Button      → clickable rect + label, with hover / pressed states.
 *                    Emits signalOnClick / Hover / Leave.
 *   - Slider      → track + fill, draggable thumb. Emits signalOnChange.
 *   - ProgressBar → track + fill, read-only (drives `value` from
 *                    a literal or expression like "var:hp").
 *   - Dropdown    → button-like header that opens an options list. Emits
 *                    signalOnSelect with the picked option's value.
 *   - Image       → renders a sprite asset's first frame.
 */
export type UIWidgetKind = "Panel" | "Label" | "Button" | "Slider" | "ProgressBar" | "Dropdown" | "Image" | "Inventory" | "Crafting" | "CraftGrid" | "Shop";

/** One option in a Dropdown widget's option list. */
export interface UIDropdownOption {
  id: string;
  /** Stable value — what `selectedValue` carries. */
  value: string;
  /** Display label shown in the dropdown list. */
  label: string;
  /** Optional per-option signal — fired ONLY when this specific option
   *  is picked. Lets the user wire different actions per option without
   *  switching on `selectedValue` in the event sheet. The widget's
   *  global `signalOnSelect` (if set) ALSO fires alongside. */
  signal?: string;
}

/**
 * Shared visual + interactive fields used by both UIWidgetDef (the
 * top-level asset) and UIWidgetChild (an element placed inside a
 * "multi" mode widget's viewport canvas). Pulling these into a base
 * interface lets the runtime UIWidgetRenderer take either a top-level
 * widget config or a child config without code-paths diverging.
 */
export interface UIWidgetVisual {
  /** Determines the runtime visual + interaction. */
  kind: UIWidgetKind;
  /** Render size in design pixels. */
  width: number;
  height: number;
  /** When on, while the pointer is over this widget it swallows mouse INPUT
   *  ACTIONS (e.g. an attack bound to Left-Click) so clicking the widget or
   *  dragging a slider doesn't also fire gameplay. */
  blockGameInput?: boolean;

  // ── Common style ───────────────────────────────────────────────────
  bgColor?: number;
  bgAlpha?: number;
  borderColor?: number;
  borderWidth?: number;
  padding?: number;
  /** Corner radius in design pixels. Uniform when `cornersSeparate` is
   *  false (default) — applied to all four corners. When
   *  `cornersSeparate` is true, the per-corner fields below win. */
  cornerRadius?: number;
  /** When true, use cornerRadiusTL/TR/BL/BR independently. */
  cornersSeparate?: boolean;
  cornerRadiusTL?: number;
  cornerRadiusTR?: number;
  cornerRadiusBL?: number;
  cornerRadiusBR?: number;
  /** Drop shadow — when enabled, paints a soft offset shadow below
   *  the widget. Uses CSS `box-shadow` in the editor preview;
   *  approximated in Phaser runtime via an offset alpha rect. */
  shadowEnabled?: boolean;
  shadowColor?: number;     // 0xRRGGBB. Defaults to 0x000000.
  shadowAlpha?: number;     // 0..1. Defaults 0.4.
  shadowBlur?: number;      // px blur radius. Defaults 12.
  shadowOffsetX?: number;   // px horizontal offset. Defaults 0.
  shadowOffsetY?: number;   // px vertical offset. Defaults 6.
  /** Backdrop blur radius (px). Frosted-glass effect behind the
   *  widget. CSS `backdrop-filter` in the editor preview; skipped at
   *  runtime in v1 (Phaser doesn't expose per-object backdrop blur
   *  cheaply). 0 = none. */
  backdropBlur?: number;

  // ── Anchor (corner snap to a viewport / parent rectangle) ──────────
  anchorCorner?: string;
  anchorOffsetX?: number;
  anchorOffsetY?: number;

  // ── Text (Label / Button / Dropdown) ────────────────────────────────
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontColor?: number;
  fontBold?: boolean;
  fontItalic?: boolean;
  align?: "left" | "center" | "right";
  vAlign?: "top" | "middle" | "bottom";

  // ── Button-specific ─────────────────────────────────────────────────
  signalOnClick?: string;
  signalOnHover?: string;
  signalOnLeave?: string;
  hoverBgColor?: number;
  pressedBgColor?: number;
  clickMode?: "single" | "double";

  // ── Slider / ProgressBar-specific ───────────────────────────────────
  min?: number;
  max?: number;
  value?: number | string;
  direction?: "horizontal" | "vertical";
  fillColor?: number;
  signalOnChange?: string;
  /** When true, a Slider widget renders the same as a draggable slider
   *  (track + fill + thumb) but blocks pointer-drag — value can only
   *  change via SetUIValue or a `var:` binding. Useful when you want
   *  the Slider visual but only programmatic value updates. ProgressBar
   *  ignores this field (it's always read-only). */
  readOnly?: boolean;

  // ── Dropdown-specific ───────────────────────────────────────────────
  options?: UIDropdownOption[];
  selectedValue?: string;
  signalOnSelect?: string;

  // ── Image-specific ──────────────────────────────────────────────────
  spriteId?: string;

  // ── Panel layout (children inside, when used as a Multi-mode parent). */
  layoutDirection?: "row" | "column" | "none";
  layoutGap?: number;
  layoutJustify?: "start" | "center" | "end" | "spaceBetween";
  layoutAlign?: "start" | "center" | "end";

  // ── Inventory-specific ──────────────────────────────────────────────
  /** Grid dimensions for the Inventory widget. */
  rows?: number;
  cols?: number;
  /** Per-slot pixel size + gap between slots. */
  slotSize?: number;
  slotGap?: number;
  slotBgColor?: number;
  slotBorderColor?: number;
  slotBorderWidth?: number;
  /** Corner radius of each slot box (0 = square). The frame's own corner
   *  radius reuses the shared `cornerRadius` field. */
  slotRadius?: number;
  /** Which character's Inventory to show: a blueprint / instance name or a
   *  tag, resolved at runtime. Empty = the host (when attached to a BP). */
  targetBp?: string;
  /** Signal fired when a slot is clicked (no drag). Payload carries the slot
   *  index + item name. */
  signalOnSlotClick?: string;
  /** Signal fired (on the bound CHARACTER's bus) when an item slot is
   *  double-clicked — for "use / consume" flows. */
  signalOnSlotDoubleClick?: string;
  /** Variable name written (on the bound character) with the double-clicked
   *  item's NAME, so logic can GetItemProp / RemoveItem it. */
  clickedItemVar?: string;
  /** When false, slots can't be dragged (rearranged or pulled out). Clicks
   *  and double-clicks still fire. Default true. */
  slotsDraggable?: boolean;

  // ── Crafting-specific (reuses the Inventory grid fields above) ───────
  /** Tint applied to a recipe cell that isn't currently craftable. */
  uncraftableTint?: number;
  /** Signal fired when a craftable recipe cell is clicked. */
  signalOnCraftClick?: string;

  // ── CraftGrid-specific (reuses the Inventory grid fields for the input grid) ──
  /** Gap (px) between the input grid's right edge and the result slot. */
  resultGap?: number;
  /** Signal fired when the player takes a crafted result out of a CraftGrid. */
  signalOnCraft?: string;

  // ── Shop role (turns a designed widget element into a shop control) ─────
  /**
   * Marks this element's job in a shop you designed:
   *   - "buy"  → on click: if money ≥ buy price, charge it and give the item.
   *   - "sell" → on click: if the player has the item, take it and pay sell price.
   * `shopItem` is which Item the element is for; `shopCurrency` is the money
   * global to charge/pay (default "gold"). Prices come from the Item asset.
   *
   * Display roles (icon/name/buyPrice/sellPrice) were removed — the {shop.*}
   * interpolation tokens cover display now. Old saves with a display role just
   * fall through to showing their Content text.
   */
  shopRole?: "buy" | "sell";
  /** Which Item (by name) this shop element represents. */
  shopItem?: string;
  /** Money global this shop element charges/pays (default "gold"). */
  shopCurrency?: string;
  /** Shop GRID widget — what each slot sells (row-major). `stock` is the amount
   *  for sale: -1 = unlimited; >=0 = a finite amount that depletes as bought and
   *  persists across scenes (refill via the Restock Shop action). */
  shopSlots?: { item: string; stock: number }[];
  /** Selection-frame highlight (Shop slot selection / focused cells). */
  selectionColor?: number;
  selectionWidth?: number;
  /** Sprite drawn as the selection frame over the selected slot (overrides the
   *  color/width outline when set). */
  selectionSpriteId?: string;
  /** Custom grid visuals (Inventory / Craft / Shop): a sprite drawn as each
   *  slot's background, and a sprite drawn as the whole grid's panel/frame. */
  slotBgSpriteId?: string;
  panelSpriteId?: string;
  /** Each grid sprite also picks an animation + frame (same as an item icon):
   *  `<x>Anim` = animation id within the sprite (empty = first); `<x>Frame` =
   *  the frame index to show, or -1 to PLAY the whole animation (animated UI). */
  slotBgAnim?: string;
  slotBgFrame?: number;
  selectionAnim?: string;
  selectionFrame?: number;
  panelAnim?: string;
  panelFrame?: number;
  /** CraftGrid arrow override — sprite drawn between the input grid and the
   *  result slot, replacing the default "▸" text arrow when set. Anim/frame
   *  conventions match the other grid sprites. */
  craftArrowSpriteId?: string;
  craftArrowAnim?: string;
  craftArrowFrame?: number;
}

/**
 * One element inside a multi-mode UI Widget's viewport canvas. Each child
 * has its own `kind` (Button / Label / Slider / etc.) and full visual
 * config, plus a position WITHIN the parent widget's viewport rectangle.
 *
 * Runtime spawns one Sprite + UIWidgetRenderer per child so each is
 * independently interactive (clickable, draggable, etc.).
 */
export interface UIWidgetChild extends UIWidgetVisual {
  id: string;
  /** Position inside the parent widget's viewport (in viewport pixels,
   *  top-left = (0,0)). Anchor (if set) is relative to the parent
   *  widget's viewport rectangle, not the global game canvas. */
  x: number;
  y: number;
  /** Optional human label so users can name children ("StartButton"). */
  name?: string;
  /** When true, the parent's "Apply Layout to Children" SKIPS this child —
   *  it keeps its own position and is not counted in the flow packing.
   *  Use for a full-size backdrop Image / fixed HUD element that shouldn't
   *  be arranged by the row/column layout. Default (undefined/false) =
   *  managed by the layout. */
  excludeFromLayout?: boolean;
}

/**
 * UI Widget — a self-contained UI element authored separately from
 * gameplay Blueprints. Two modes:
 *
 *  - **Single** (default): the widget IS one kind. Pick Button or
 *    Slider or Label, configure, drop in scene. One reusable element.
 *  - **Multi**: the widget is a viewport-sized canvas holding many
 *    children. Compose a HUD or menu screen by dropping multiple
 *    Buttons / Labels / Dropdowns / etc. inside. Drop the multi widget
 *    into a scene and the whole composition fills the viewport.
 */
/**
 * One reactive binding. Reads `source` every tick and writes the result
 * into the target widget's `property`. Source is either a literal
 * expression ("var:Player.hp", "var:Player.hp / var:Player.maxHp"),
 * the runtime resolves via the standard expression evaluator. When
 * `childName` is set (Multi mode), the binding targets that named
 * child; empty means the root widget itself.
 */
export interface WidgetBinding {
  id: string;
  /** Multi mode: name of the child this binding writes to. Empty / undefined
   *  = the widget itself (Single mode or root of Multi). */
  childName?: string;
  /** Which widget property to drive. Each kind supports a subset:
   *  - "text"     → Label / Button / Dropdown header (string)
   *  - "value"    → Slider / ProgressBar (number)
   *  - "visible"  → any widget (boolean — 0/false hides)
   *  - "bgColor"  → any widget (number — hex 0xRRGGBB)
   *  - "enabled"  → Button / Slider / Dropdown (boolean — disabled = dim + no input)
   */
  property: "text" | "value" | "visible" | "bgColor" | "enabled";
  /** Expression. Literal numbers, "var:Foo.bar", "var:hp / var:maxHp",
   *  "var:phase == 2", etc. Runtime resolves identically to the
   *  Slider's `value` field expressions. */
  source: string;
}

export interface UIWidgetDef extends UIWidgetVisual {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  /** "single" = the widget IS one element (Button/Slider/etc., uses
   *  the widget's own kind+visual fields).
   *  "multi" = the widget is a viewport-sized canvas; the children
   *  array carries the actual elements. */
  mode: "single" | "multi";
  /** Children placed inside this widget's viewport (Multi mode only —
   *  ignored when mode === "single"). */
  children: UIWidgetChild[];

  // ── Per-widget variables / event sheet ──────────────────────────────
  variables: VariableDef[];
  /** @deprecated Event sheet replaced by `logicSheet` (node graph). Kept
   *  on the schema so legacy projects load without migration; runtime
   *  ignores it. New widgets ship with `events: []`. */
  events: PeakyEvent[];
  /** @deprecated See `events`. */
  eventGroups: EventGroupDef[];
  /** @deprecated See `events`. */
  eventPages: EventPageDef[];
  /** Per-widget Logic Sheet — node-graph event system. Same shape as
   *  `BlueprintDef.logicSheet`. Replaces the event sheet for UI widgets.
   *  Optional so projects pre-v7 keep loading; widget editor creates
   *  one lazily on first edit. */
  logicSheet?: LogicSheet;
  /** Declarative reactive bindings — each row links a widget property
   *  (text / value / visible / bgColor / enabled) to a BP variable or
   *  expression. Read tick-by-tick by UIWidgetRenderer (or auto-updated
   *  when the var changes). Cleaner than wiring SetUIText/SetUIVisible
   *  via a Logic Sheet for simple "this label always shows var:hp"
   *  reactivity. Animation-Slots-style table — declarative, not events. */
  bindings?: WidgetBinding[];
  /** Content Browser folder. Defaults to "/UI". */
  path: string;
  /** Compatibility shim — always empty for UI widgets. The shared
   *  EventsSection component reads `bp.behaviors` to derive things like
   *  available animation names; without an empty array here it would
   *  crash on access. UI widgets don't author components anymore (the
   *  widget IS the component), but the field is needed for the
   *  BlueprintDef-shaped cast used by event-sheet authoring. */
  behaviors: BehaviorInstance[];
}

/** Sensible per-kind starting fields. Spread on top of an existing
 *  widget when switching kinds — preserves common style + variables
 *  + events while seeding type-specific fields with defaults so the
 *  widget is immediately usable (e.g. switching to Slider gets a
 *  visible 50% fill rather than a blank track). */
export function defaultsForUIWidgetKind(kind: UIWidgetKind): Partial<UIWidgetDef> {
  switch (kind) {
    case "Panel":
      return {
        bgColor: 0x222831,
        bgAlpha: 0.85,
        borderColor: 0x404552,
        borderWidth: 1,
        padding: 8,
        layoutDirection: "none",
        layoutGap: 8,
        layoutJustify: "start",
        layoutAlign: "start",
      };
    case "Label":
      return {
        bgColor: 0,
        bgAlpha: 0,
        text: "Label",
        fontFamily: "Arial",
        fontSize: 16,
        fontColor: 0xffffff,
        align: "center",
        vAlign: "middle",
      };
    case "Button":
      return {
        bgColor: 0x2d82d4,
        bgAlpha: 1,
        borderColor: 0x4aa8ff,
        borderWidth: 1,
        padding: 8,
        text: "Button",
        fontFamily: "Arial",
        fontSize: 14,
        fontColor: 0xffffff,
        align: "center",
        vAlign: "middle",
        hoverBgColor: 0x4aa8ff,
        pressedBgColor: 0x1f5b95,
        signalOnClick: "",
        clickMode: "single",
      };
    case "Slider":
      return {
        bgColor: 0x222831,
        bgAlpha: 0.85,
        borderColor: 0x404552,
        borderWidth: 1,
        min: 0,
        max: 100,
        value: 50,
        direction: "horizontal",
        fillColor: 0x44ddff,
        signalOnChange: "",
      };
    case "ProgressBar":
      return {
        bgColor: 0x222831,
        bgAlpha: 0.85,
        borderColor: 0x404552,
        borderWidth: 1,
        min: 0,
        max: 100,
        value: 50,
        direction: "horizontal",
        fillColor: 0x44ddff,
      };
    case "Dropdown":
      return {
        bgColor: 0x2d82d4,
        bgAlpha: 1,
        borderColor: 0x4aa8ff,
        borderWidth: 1,
        padding: 8,
        text: "Pick…",
        fontFamily: "Arial",
        fontSize: 14,
        fontColor: 0xffffff,
        align: "left",
        vAlign: "middle",
        hoverBgColor: 0x4aa8ff,
        options: [],
        selectedValue: "",
        signalOnSelect: "",
      };
    case "Image":
      return {
        bgColor: 0,
        bgAlpha: 0,
        spriteId: "",
      };
    case "Inventory":
      return {
        // Visible backing frame so the grid reads as a real inventory panel
        // (and `padding` has a frame to inset the slots from).
        bgColor: 0x1a1d23,
        bgAlpha: 0.9,
        borderColor: 0x404552,
        borderWidth: 1,
        cornerRadius: 0,
        padding: 8,
        rows: 1,
        cols: 5,
        slotSize: 48,
        slotGap: 4,
        // Size derived from the grid PLUS the frame padding (5×48 + 4 gaps +
        // 2×8 pad = 272 × 64) so anchoring, scene placement and preview all
        // match the rendered slot grid centered inside its padded frame.
        width: 5 * 48 + 4 * 4 + 2 * 8,
        height: 48 + 2 * 8,
        slotBgColor: 0x222831,
        slotBorderColor: 0x404552,
        slotBorderWidth: 1,
        slotRadius: 0,
        targetBp: "",
        signalOnSlotClick: "",
        signalOnSlotDoubleClick: "",
        clickedItemVar: "",
        slotsDraggable: true,
      };
    case "Crafting":
      return {
        bgColor: 0x1a1d23,
        bgAlpha: 0.9,
        borderColor: 0x404552,
        borderWidth: 1,
        cornerRadius: 0,
        padding: 8,
        rows: 1,
        cols: 5,
        slotSize: 48,
        slotGap: 4,
        width: 5 * 48 + 4 * 4 + 2 * 8,
        height: 48 + 2 * 8,
        slotBgColor: 0x222831,
        slotBorderColor: 0x404552,
        slotBorderWidth: 1,
        slotRadius: 0,
        targetBp: "",
        uncraftableTint: 0x000000,
        signalOnCraftClick: "",
      };
    case "Shop":
      return {
        bgColor: 0x1a1d23,
        bgAlpha: 0.9,
        borderColor: 0x404552,
        borderWidth: 1,
        cornerRadius: 0,
        padding: 8,
        rows: 2,
        cols: 4,
        slotSize: 48,
        slotGap: 4,
        width: 4 * 48 + 3 * 4 + 2 * 8,
        height: 2 * 48 + 1 * 4 + 2 * 8,
        slotBgColor: 0x222831,
        slotBorderColor: 0x404552,
        slotBorderWidth: 1,
        slotRadius: 0,
        shopSlots: [],
        shopCurrency: "gold",
        selectionColor: 0xffd23c,
        selectionWidth: 3,
        uncraftableTint: 0x000000,
      };
    case "CraftGrid":
      return {
        bgColor: 0x1a1d23,
        bgAlpha: 0.9,
        borderColor: 0x404552,
        borderWidth: 1,
        cornerRadius: 0,
        padding: 8,
        rows: 2,
        cols: 2,
        slotSize: 48,
        slotGap: 4,
        resultGap: 24,
        // width = input grid + arrow gap + result slot + frame padding.
        width: (2 * 48 + 1 * 4) + 24 + 48 + 2 * 8,
        height: (2 * 48 + 1 * 4) + 2 * 8,
        slotBgColor: 0x222831,
        slotBorderColor: 0x404552,
        slotBorderWidth: 1,
        slotRadius: 0,
        signalOnCraft: "",
      };
  }
}

// ─── Dialogue assets ──────────────────────────────────────────────────────────

/** One option in a choice block attached to a DialogueLine. A pick can
 *  do TWO things, both optional + independent:
 *    - `emitSignal`: fire a project signal so the user's event sheet can
 *      react (set vars, open doors, anything).
 *    - `goToDialogue`: immediately jump into another DialogueAsset by id.
 *      Stops the current dialogue and starts the target. Most common use:
 *      branching conversations without writing event-sheet glue. */
export interface DialogueChoice {
  id: string;
  text: string;
  emitSignal: string;
  /** Asset id of a dialogue to play when this choice is picked. Empty
   *  or missing = no jump (advance to the next non-choice line in the
   *  current dialogue, as before). */
  goToDialogue?: string;
}

/** A single line of dialogue. Choices, when present, pause playback until
 *  the user picks one — picking emits the choice's `emitSignal` and the
 *  dialogue advances to the next non-choice line. */
export interface DialogueLine {
  id: string;
  /** Speaker label as authored ("Alice", "Bob", "Narrator", …). Resolved
   *  at runtime via `DialogueAsset.speakerMap` to a Blueprint. */
  speaker: string;
  /** Multi-paragraph content. Newlines preserved; supports `{var}` token
   *  interpolation via the host Text behavior's existing pipeline. */
  text: string;
  /** Delay before this line starts to display (seconds). */
  delaySec?: number;
  /** Signal emitted when this line ENTERS playback (good for stage
   *  directions: open a door, start music, shake camera). */
  emitSignal?: string;
  /** Choice block. Empty/missing → linear advance on input. */
  choices?: DialogueChoice[];
}

export type DialogueDisplayMode = "overhead" | "box";

/**
 * Dialog Flow — declarative trigger table for the whole project. Authored in
 * the DialogFlowTab (timeline view). Evaluated by DialogFlowRunner at runtime.
 *
 * Chapters are PURE ORGANIZATION — engine doesn't gate on chapter. They're
 * the timeline columns for the author's mental model.
 *
 * Triggers are the actual runtime contract: when their `kind` fires AND all
 * conditions pass, the runner plays `dialogueId` via DialogueRunner.
 */
export interface DialogFlowDef {
  chapters: DialogFlowChapter[];
  triggers: DialogFlowTrigger[];
  /** Explicit BP-row list for the timeline. The grid only shows rows for BPs
   *  in this list (plus any BP that has a trigger, so triggers can't become
   *  orphaned/invisible). Author adds rows via "+ Add NPC". */
  rowBpIds?: string[];
}

export interface DialogFlowChapter {
  id: string;
  /** Free-form label (e.g. "Act 1", "Boss Arena"). Display-only. */
  name: string;
  /** Optional column tint (0xRRGGBB) for visual grouping. */
  color?: number;
}

export type DialogFlowTriggerKind = "OnInteract" | "OnEnterScene" | "OnSignal";

export interface DialogFlowTrigger {
  id: string;
  /** Owning chapter (column on the timeline). Display-only; runtime doesn't
   *  check it — but the editor groups triggers by chapter for authoring. */
  chapterId: string;
  /** NPC blueprint whose interaction / lifecycle this trigger watches. The
   *  timeline shows triggers grouped by speakerBpId as the row/lane. */
  speakerBpId: string;
  /** Optional: limit to a specific named placement (matches BlueprintInstance.name).
   *  Empty → fires for ANY instance of the speakerBpId. */
  instanceName?: string;
  /** Which dialog plays when this trigger fires. */
  dialogueId: string;
  /** What event the runner listens for. */
  kind: DialogFlowTriggerKind;
  /** Required when kind = "OnSignal". The signal name to listen for. */
  signalName?: string;
  /** For kind = "OnInteract": name of a tracer on the player BP (or any
   *  sprite) to watch. Each tick, when this tracer's `justHit` edge fires
   *  and the hit actor's blueprintId matches `speakerBpId`, the trigger
   *  fires. No event-sheet wiring required — the runner polls every tick.
   *  Empty = OnInteract requires manual `InteractWithNPC` action (legacy
   *  bridge path). */
  tracerName?: string;
  /** Optional: BP id of the sprite that CARRIES the tracer (the tracer's
   *  host). When set, the runtime only checks tracers on instances of this
   *  BP, and the `tracerName` dropdown in the editor is filtered to that
   *  BP's tracers. Empty = scan every BP (legacy global match). */
  tracerHostBpId?: string;
  /** Optional: BP id of the OTHER actor in the tracer hit. Empty = anyone
   *  (the typical "player walks into the NPC's zone"). Set when you want a
   *  specific BP on the other side — e.g. two NPCs talking to each other,
   *  where only NPC_Guard entering NPC_Mayor's tracer fires the dialogue
   *  (not the player wandering past). */
  interactorBpId?: string;
  /** Optional: limit the interactor to a specific named placement.
   *  Empty = ANY instance of the interactorBpId. */
  interactorInstanceName?: string;
  /** Optional input action that must be `justPressed` in addition to the
   *  tracer hit. Lets the author require a key press (e.g. "Interact")
   *  on top of proximity. Empty = no key required — fires on tracer
   *  justHit edge alone. */
  interactAction?: string;
  /** ALL must evaluate true for the trigger to fire. Empty = unconditional. */
  conditions: DialogFlowCondition[];
  /** When multiple triggers match the same event, the highest priority wins.
   *  Equal priorities → first-in-list wins. */
  priority: number;
  /** When true, the trigger fires AT MOST ONCE per game session. Persisted
   *  via the scene's data manager so save/load round-trips correctly. */
  oneShot: boolean;
}

/** Compare-expression condition. Reuses the engine's CompareValues syntax
 *  (var:Foo.bar / self.x / literal numbers / strings), evaluated at trigger
 *  time. ALL conditions on a trigger must match. */
export interface DialogFlowCondition {
  id: string;
  /** Left-hand value — literal or expression (`var:Player.hp`, `self.x`). */
  left: string;
  /** Comparison operator. */
  op: "==" | "!=" | "<" | ">" | "<=" | ">=" | "contains";
  /** Right-hand value — literal or expression. */
  right: string;
}


export interface DialogueAsset {
  id: string;
  name: string;
  /** Hidden from the Content Browser unless "Show Hidden" is toggled. */
  hidden?: boolean;
  path?: string;
  lines: DialogueLine[];
  /** Speaker label → blueprint id. Auto-built on import (exact / case-
   *  insensitive / tag match) and prompted via SpeakerMappingModal for
   *  any unmatched speakers. Missing entries fall back to the project's
   *  narrator BP at runtime. */
  speakerMap: Record<string, string>;
  /** Speaker label → per-speaker overhead bubble offset override. When
   *  set, the runner uses this offset INSTEAD of the asset-wide
   *  `style.overheadOffsetX/Y` for that speaker's lines. Lets the author
   *  tune NPC vs Player bubble positions independently (e.g. a tall boss
   *  needs `-40` while a small player wants `-10`). Missing → fall back
   *  to the asset's style defaults. */
  speakerOffsets?: Record<string, { x: number; y: number }>;
  /** Per-asset overrides (each falls back to project.dialogueDefaults). */
  displayMode?: DialogueDisplayMode;
  advanceAction?: string;
  autoAdvanceSec?: number;
  typewriterCps?: number;
  /** Blueprint id whose Sprite represents "the player." When set, picking
   *  a choice ECHOES the chosen option's text as a line spoken by this
   *  BP — RPG-style "the player recites their answer before the NPC
   *  responds" UX. The player-line plays in full (typewriter, advance
   *  press to dismiss) before the original choice action (next line or
   *  goToDialogue) takes effect. Empty/missing → no echo, choice action
   *  fires immediately. Empty string here = explicit "no echo for this
   *  asset" override of a non-empty project default. Omitted = inherit
   *  from `dialogueDefaults.playerSpeakerBpId`. */
  playerSpeakerBpId?: string;
  /** Freeze the player's CharacterMovement (input + walk/jump/dash) while
   *  this dialog plays. Restored on dialog end. Requires `playerSpeakerBpId`
   *  to know which BP is the player. */
  freezePlayerDuringDialog?: boolean;
  /** Freeze CharacterMovement on every NPC speaker (any BP referenced in
   *  lines that isn't the player BP) while this dialog plays. */
  freezeNpcsDuringDialog?: boolean;
}

/** Per-asset visual style for the dialogue bubble / box. Falls back to
 *  `dialogueDefaults.style` when fields are unset on a specific asset. */
/** Visual theme for the dialog bubble / box. Controls the BOX rendering
 *  shape (rounded corners, drop shadow, separator, speaker pill, continue
 *  indicator). Colors / fonts / sizes still come from the rest of
 *  DialogueStyle so a theme can be re-tinted to match the project palette.
 *
 *   - "modern"         — soft rounded corners, drop shadow, speaker name
 *                        in a colored pill, thin separator, blinking
 *                        continue triangle. Best fit for narrative / indie.
 *   - "jrpg"           — square corners, double-line border, speaker box
 *                        top-left, blinking continue arrow. Classic FF /
 *                        Pokémon look.
 *   - "comic"          — rounded bubble with downward-pointing tail
 *                        (overhead only), bold underlined speaker name.
 *                        Classic comic-strip dialog.
 *   - "comic-shout"    — jagged starburst outline ("POW!" / "BAM!"),
 *                        bold high-contrast border, big skewed text
 *                        shadow. Use for combat / loud lines.
 *   - "comic-thought"  — cloud-puffy bubble (overlapping arcs around the
 *                        edge), trailing bubbles for the tail instead of
 *                        a tip. Use for internal monologue.
 *   - "comic-whisper"  — thin dashed outline, slightly translucent fill,
 *                        slim tail. Use for quiet / sneaking lines.
 *   - "comic-news"     — sharp rectangular box with halftone-dot
 *                        background pattern, thin black border, NO tail.
 *                        Use for narrator captions / news-bulletin lines. */
export type DialogueTheme =
  | "modern"
  | "jrpg"
  | "comic"
  | "comic-shout"
  | "comic-thought"
  | "comic-whisper"
  | "comic-news"
  | "image";

export interface DialogueStyle {
  /** Visual theme for the bubble / box. */
  theme: DialogueTheme;
  /** When `theme === "image"`, the DialogBoxAsset id to render as a 9-slice.
   *  Ignored by other themes. Empty + theme=image → falls back to procedural
   *  "modern" render so a misconfigured style doesn't render nothing. */
  boxAssetId?: string;
  bgColor: number;          // 0xRRGGBB
  bgAlpha: number;          // 0..1
  borderColor: number;
  borderWidth: number;
  textColor: string;        // CSS / Phaser-style color (e.g. "#ffffff")
  speakerColor: string;
  fontFamily: string;
  fontSize: number;         // px
  paddingX: number;
  paddingY: number;
  /** Per-side padding overrides — undefined falls back to paddingX/Y.
   *  Lets authors give the bottom more room (e.g. for portraits) without
   *  touching the symmetric defaults. Applies to default + 9-slice modes. */
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** Box-mode width (px). Overhead mode auto-sizes to text up to this cap. */
  boxWidth: number;
  /** Overhead-mode offset from the speaker sprite's head (top edge). X is
   *  added to sprite center; Y is added below the head (negative = higher
   *  above the head — the typical adjustment, since "0" puts the bubble
   *  bottom edge AT the head). Defaults: (0, -8). */
  overheadOffsetX: number;
  overheadOffsetY: number;
  /** Box-mode offset from camera bottom-center. X = 0 keeps it centered.
   *  Y is the gap from the bottom edge — negative pulls the box down,
   *  positive pushes it up. Defaults: (0, 16). */
  boxOffsetX: number;
  boxOffsetY: number;
}

/** Project-wide dialogue defaults. Each DialogueAsset can override these. */
export interface DialogueDefaults {
  displayMode: DialogueDisplayMode;
  advanceAction: string;
  autoAdvanceSec: number;
  typewriterCps: number;
  /** No longer required — kept as legacy fallback. The runner now ships
   *  its own UI overlay and doesn't need a narrator BP for v1. */
  narratorBpId: string;
  /** Default Blueprint that voices picked choices as "player" lines.
   *  Empty = no choice echo (choice picks immediately apply their action).
   *  See DialogueAsset.playerSpeakerBpId for the per-asset override. */
  playerSpeakerBpId: string;
  style: DialogueStyle;
}

/**
 * 9-slice PNG dialog box asset. Stores the PNG inline as a data-URL plus the
 * four slice cuts (px from each edge) so the engine can render the box at
 * arbitrary sizes without distorting corners. Selected per-style via
 * `DialogueStyle.boxAssetId` when `theme === "image"`.
 *
 * Slice semantics (Unity / Godot / CSS border-image-slice convention):
 *   - 4 CORNERS    — drawn at original size, never stretched (crisp).
 *   - 4 EDGES      — stretched along one axis only (top/bottom = horizontal;
 *                    left/right = vertical) to fill the box's width/height
 *                    minus the corner widths.
 *   - 1 MIDDLE     — stretched on both axes to fill the inner area.
 *
 * If sliceLeft + sliceRight > image.width (or top + bottom > height), the
 * engine clamps so corners don't overlap.
 */
export interface DialogBoxAsset {
  id: string;
  /** Display name shown in the picker dropdown. Must be unique within
   *  PeakyProject.dialogBoxes. */
  name: string;
  /** PNG image inline as a `data:image/png;base64,...` URL. Small (<10KB)
   *  boxes are typical so inline storage is fine; saves an asset-folder
   *  round-trip and keeps the box bundled with the project JSON. */
  dataUrl: string;
  /** Slice cuts in PIXELS from each edge of the PNG.
   *  Top + bottom must be < image height; left + right < image width. */
  sliceLeft: number;
  sliceRight: number;
  sliceTop: number;
  sliceBottom: number;
}

/** Sensible defaults for the bubble / box appearance. Dark translucent
 *  background, white text, accent-yellow speaker label, ~360px wide for
 *  comfortable readability. Overhead bubbles sit 8px above the speaker's
 *  head; box-mode dialogue sits 16px above the camera's bottom edge. */
export function defaultDialogueStyle(): DialogueStyle {
  return {
    theme: "modern",
    bgColor: 0x000000,
    bgAlpha: 0.85,
    borderColor: 0xffffff,
    borderWidth: 2,
    textColor: "#ffffff",
    speakerColor: "#ffcc66",
    fontFamily: "Arial",
    fontSize: 16,
    paddingX: 12,
    paddingY: 10,
    boxWidth: 360,
    overheadOffsetX: 0,
    overheadOffsetY: -8,
    boxOffsetX: 0,
    boxOffsetY: 16,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(_id++).toString(36)}`;

/**
 * Build the default layer set for a fresh scene. v1 ships three layers,
 * top→bottom in render order:
 *   - UI         — parallax (0, 0): locked to the screen
 *   - Main       — parallax (1, 1): scrolls 1:1 with the camera (placements default here)
 *   - Background — parallax (0.3, 0.3): drifts slowly for depth feel
 * Layer order in this list IS the Z-depth: index 0 (UI) draws on top,
 * index N-1 (Background) draws at the back. The runtime converts list
 * position into `setDepth(...)` automatically.
 * Reused by `emptyProject` and the legacy-scene migration.
 */
export function defaultLayers(): { layers: LayerDef[]; activeLayerId: string } {
  const uiId   = newId("layer");
  const mainId = newId("layer");
  const bgId   = newId("layer");
  return {
    layers: [
      { id: uiId,   name: "UI",         parallaxX: 0,   parallaxY: 0,   visible: true, opacity: 1 },
      { id: mainId, name: "Main",       parallaxX: 1,   parallaxY: 1,   visible: true, opacity: 1 },
      { id: bgId,   name: "Background", parallaxX: 0.3, parallaxY: 0.3, visible: true, opacity: 1 },
    ],
    activeLayerId: mainId,
  };
}

export function emptyProject(): PeakyProject {
  const sceneId = newId("scene");

  const inputActions: InputActionDef[] = [
    { id: newId("act"), name: "MoveLeft", keys: ["LEFT", "A"] },
    { id: newId("act"), name: "MoveRight", keys: ["RIGHT", "D"] },
    { id: newId("act"), name: "Jump", keys: ["UP", "W", "SPACE"] },
    { id: newId("act"), name: "Crouch", keys: ["DOWN", "S"] },
    // For TopdownMovement (RPG-topdown / flying). Up/Down share keys with
    // Jump/Crouch so platformer + topdown both work out of the box.
    { id: newId("act"), name: "MoveUp", keys: ["UP", "W"] },
    { id: newId("act"), name: "MoveDown", keys: ["DOWN", "S"] },
  ];

  return {
    version: 8,
    name: "Untitled Game",
    activeSceneId: sceneId,
    viewportWidth: 800,
    viewportHeight: 600,
    sampling: "bilinear",
    blueprints: [],
    inputActions,
    signals: [],
    globalVariables: [],
    lists: [],
    scenes: [
      {
        id: sceneId,
        name: "Main",
        width: 800,
        height: 600,
        backgroundColor: 0x1a1a2e,
        gravity: 800,
        instances: [],
        path: "/Scenes",
        ...defaultLayers(),
      },
    ],
    sprites: [],
    tilesets: [],
    tilemaps: [],
    sounds: [],
    fonts: [],
    items: [],
    recipes: [],
    dialogues: [],
    dialogBoxes: [],
    dialogueDefaults: {
      displayMode: "overhead",
      advanceAction: "Interact",
      autoAdvanceSec: 0,
      typewriterCps: 30,
      narratorBpId: "",
      playerSpeakerBpId: "",
      style: defaultDialogueStyle(),
    },
    uiWidgets: [],
    folders: ["/Blueprints", "/Scenes", "/Sprites", "/Audio", "/Textures", "/Dialogues", "/UI", "/Items", "/Recipes"],
  };
}

export const BEHAVIOR_DEFAULTS: Record<BehaviorKind, Record<string, unknown>> = {
  Solid: { debugDraw: 0 },
  JumpThru: {},
  // ── CharacterMovement: one smart component, all the platformer abilities. ──
  // Physics + Move Left/Right + Jump (with coyote/buffer/multi-jump/var-height
  // toggles) + Dash. Each ability binds to a project InputAction by name. The
  // editor's component picker shows this with a custom sectioned details UI.
  CharacterMovement: {
    // Physics
    maxSpeed: 220,
    acceleration: 1500,
    deceleration: 1500,
    airControl: 1.0,
    gravity: 800,
    gravityAngle: 90,
    maxFallSpeed: 600,
    ceilingMode: 0,
    mirrorMode: 0,
    scaleMirror: 0,
    scaleMirrorTime: 0.15,
    // Move Left / Right — InputAction binding, optional event trigger, optional emit-on-fire
    leftAction: "MoveLeft",
    leftEventTrigger: "",
    leftCustomFn: "",
    rightAction: "MoveRight",
    rightEventTrigger: "",
    rightCustomFn: "",
    // Jump — base
    jumpAction: "Jump",
    jumpEventTrigger: "",
    jumpCustomFn: "",
    jumpStrength: 460,
    jumpTimeToApex: 0,
    fallGravityMultiplier: 1,
    multiJump: 1, // 1 = single, 2 = double, 3 = triple…
    // Coyote time (toggle + duration)
    coyoteEnabled: 1,
    coyoteTime: 0.1,
    // Input buffering (toggle + duration)
    bufferEnabled: 1,
    bufferTime: 0.1,
    // Jump sustain (hold to keep rising)
    jumpSustainEnabled: 0,
    jumpSustainTime: 0.18,
    // Variable jump height (release-to-cut)
    varHeightEnabled: 0,
    varHeightCutoff: -150,
    // Dash
    dashEnabled: 0,
    dashAction: "Dash",
    dashEventTrigger: "",
    dashCustomFn: "",
    dashSpeed: 600,
    dashStartDelay: 0,
    dashWallBlock: 1,
    dashDuration: 0.15,
    dashCooldown: 1.0,
    // Wall — was missing here, so freshly-attached CMs serialized
    // without these keys. Inspector still wrote them on edit, but
    // SetBehaviorParam couldn't reach them and projects round-tripped
    // through save/load without their wall config.
    wallEnabled: 0,
    wallJumpAllowed: 1,
    wallSlideSpeed: 100,
    wallJumpStrength: 460,
    wallJumpKickX: 320,
    wallSlideRequiresInput: 1,
    wallSlideOnContact: 0,
    wallSlideCustomFn: "",
    wallJumpCustomFn: "",
  },
  TopdownMovement: {
    maxSpeed: 220,
    acceleration: 1500,
    deceleration: 1500,
    upAction: "MoveUp",
    upEventTrigger: "",
    downAction: "MoveDown",
    downEventTrigger: "",
    leftAction: "MoveLeft",
    leftEventTrigger: "",
    rightAction: "MoveRight",
    rightEventTrigger: "",
    mirrorMode: 0,
    scaleMirror: 0,
    scaleMirrorTime: 0.15,
    ignoreInput: 0,
  },
  SpriteRenderer: {
    spriteId: "",
    currentAnimation: "",
    playing: 1,
    speed: 1.0,
    frame: 0,
    useFrameCollider: 0,
    solid: 1,
    collideFilterMode: "include",
    collideFilterTags: [],
  },
  Collider: {
    width: 32,
    height: 48,
    offsetX: 0,
    offsetY: 0,
    collideWorldBounds: 1,
    passThrough: 1,
    debugDraw: 0,
  },
  Text: {
    name: "",
    content: "Hello",
    fontFamily: "Arial",
    fontSize: 16,
    color: 0xffffff,
    bold: 0,
    italic: 0,
    align: "left",
    vAlign: "top",
    wrapWidth: 0,
    visible: 1,
    alpha: 1,
    offsetX: 0,
    offsetY: 0,
  },
  Camera: {
    targetMode: "self",
    targetTag: "",
    // Match the runtime class field default (Camera.ts:39) so newly
    // attached cameras spawn with the same value the inspector shows.
    // (audit HIGH #32, #74)
    smoothing: 0.5,
    followX: 1,
    followY: 1,
    offsetLeftX: 0,
    offsetRightX: 0,
    offsetY: 0,
    offsetSmoothing: 0,
    deadzoneX: 0,
    deadzoneY: 0,
    zoom: 1,
    bounded: 1,
    locked: 0,
  },
  Tracer: {
    name: "",
    shape: "line",
    distance: 100,
    angle: 0,
    pivotSource: "manual",
    imagePointName: "",
    pivotX: 0,
    pivotY: 0,
    boxThickness: 16,
    tagFilter: "",
    triggerMode: "interval",
    triggerSignal: "",
    signalCount: 1,
    signalLoop: 0,
    signalLifetimeSec: 0,
    intervalSec: 0,
    debugDraw: 0,
    // Class-field defaults that were missing from BEHAVIOR_DEFAULTS so
    // attached Tracers serialized with undefined for these. (audit HIGH #37)
    fireAnim: "",
    fireFrame: -1,
    damage: 0,
    multiHit: 0,
    knockbackX: 0,
    knockbackY: 0,
  },
  SquashStretch: {
    intensity: 0.3,
    duration: 0.3,
    easing: "Quad.Out",
    emitOnEnd: 0,
  },
  Outline: {
    on: 1,
    color: 0xffe24a,
    thickness: 4,
    opacity: 1,
    pulse: 0,
    pulseSpeed: 2,
    glow: 0,
    glowColor: 0xffe24a,
    glowSize: 12,
    glowOpacity: 0.6,
    feather: 0.7,
  },
  Shadow: {
    on: 1,
    shape: "circle",
    width: 48,
    height: 16,
    feather: 0.6,
    opacity: 0.5,
    color: 0x000000,
    offsetX: 0,
    offsetY: 8,
    groundTag: "",
    maxDrop: 600,
    shrinkWithHeight: 0,
  },
  LightSource: {
    on: 1,
    color: 0xffd9a0,
    radius: 140,
    intensity: 1,
    edge: "smooth",
    feather: 0.7,
    edgeAmount: 0.5,
    offsetX: 0,
    offsetY: 0,
    flicker: 0,
    flickerSpeed: 9,
  },
  Weather: {
    on: 1,
    space: "screen",
    mode: "topdown",
    killTags: "",
    shelterTags: "",
    shelterDrizzleTags: "",
    count: 160,
    speed: 380,
    speedJitter: 0.3,
    angle: 12,
    wind: 0,
    rotationSpeed: 0,
    shape: "line",
    size: 14,
    sizeJitter: 0.4,
    thickness: 2,
    color: 0xaaccff,
    alpha: 0.6,
    sway: 0,
    swaySpeed: 1.5,
    spriteId: "",
    splash: 0,
    splashType: "simple",
    splashSprite: "",
    splashAnim: "",
    splashScale: 1,
  },
  UIWidgetRenderer: {
    // The runtime UIWidgetRenderer is attached automatically by
    // runProject.spawnFromUIWidget — its config is built from the
    // widget's fields at spawn time, not authored on a BP. The empty
    // defaults here exist so SetBehaviorParam validation has a row.
  },
  ParticleEmitter: {
    name: "",
    mode: "continuous",
    rate: 10,
    burstCount: 30,
    maxParticles: 1000,
    enabled: 1,
    spriteId: "",
    delay: 0,
    pivotSource: "host",
    imagePointName: "",
    spawnJitterX: 0,
    spawnJitterY: 0,
    offsetX: 0,
    offsetY: 0,
    renderOrder: "front",
    lifetime: 1,
    lifetimeJitter: 0,
    speed: 100,
    speedJitter: 0,
    angleMin: -90,
    angleMax: -90,
    gravityX: 0,
    gravityY: 0,
    friction: 0,
    rotationStart: 0,
    rotationEnd: 0,
    rotationJitter: 0,
    scaleStart: 1,
    scaleEnd: 1,
    alphaStart: 1,
    alphaEnd: 0,
    tintStart: 0xffffff,
    tintEnd: 0xffffff,
    blendMode: "NORMAL",
    frameMode: "first",
    frameIndices: "",
  },
  Damageable: {
    hp: 100,
    maxHp: 100,
    // hpVar/maxHpVar bind hp to a named variable so it's readable in
    // event expressions. Empty default = unbound. (audit MED #76)
    hpVar: "",
    maxHpVar: "",
    iframeSec: 0.5,
    hitstunSec: 0.3,
    knockbackMultiplier: 1,
    blockKnockbackMultiplier: 1,
    partialKnockbackMultiplier: 1,
    destroyOnDeath: 1,
    deathDestroyDelay: 0.5,
    allowHealing: 1,
    attackable: 1,
    blockStates: "",
    guardMultiplier: 0,
    guarding: 0,
  },
  StateMachine: {
    // Starter state machine for a sidescroller Character. Priority
    // hierarchy (top wins when conditions tie):
    //   100 attack       one-shot     ← combat trumps movement
    //    80 dash         loop while CharacterMovement.dashing
    //    60 wallslide    loop while CharacterMovement.wallSliding
    //    45 fall         vy > 50      (Phaser Y-down: positive = falling)
    //    40 jump         vy < -10     (negative = going up)
    //    20 crouch       Crouch input held
    //    15 run          |vx| > 100
    //    10 walk         |vx| > 5
    //     0 idle         always       ← fallback
    // Anim names match the slots the user will fill in the Visual section.
    // Users add / edit / remove states from the Animation Slots table.
    states: [
      // enterAnim plays once before the main animation; exitAnim plays
      // once when the state stops being the winner (delays the switch).
      // Both are optional — leave blank to skip.
      // useTransitions toggles the enter/exit flow per state — default
      // false. Users opt in per row from the In/Out checkbox in the
      // Animation Slots table. enterAnim / exitAnim values stay saved
      // even when transitions are off so toggling back on is one click.
      { name: "attack",      priority: 100, animation: "attack",      enterAnim: "",            exitAnim: "",            useTransitions: false, loop: false, primary: { kind: "OnKeyPressed", actions: ["Attack"] } },
      { name: "dash",        priority: 80,  animation: "dash",        enterAnim: "",            exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "IsDashing" } },
      // Wallslide: enter anim plays once on first contact, then main
      // loops while sliding. useTransitions=true wires the enter; loop
      // stays true so the main animation cycles for as long as the
      // body remains on the wall.
      { name: "wallslide",   priority: 60,  animation: "wallslide",   enterAnim: "wallslide_in",exitAnim: "",            useTransitions: true,  loop: true,  primary: { kind: "IsWallSliding" } },
      // Walljump fires for ~0.12s after CM's wall-jump branch runs.
      // Priority 65 beats wallslide (60) so the state takes over the
      // moment the kick happens; one-shot latches the dedicated anim.
      { name: "walljump",    priority: 65,  animation: "walljump",    enterAnim: "",            exitAnim: "",            useTransitions: false, loop: false, primary: { kind: "JustWallJumped" } },
      { name: "land",        priority: 55,  animation: "land",        enterAnim: "",            exitAnim: "",            useTransitions: false, loop: false, primary: { kind: "OnLand" } },
      // Jump > Fall by priority so the upward arc plays `jump` while
      // velocity.y is negative; once vy hits 0 (apex) jump fails and
      // fall (IsAirborne) takes over for the rest of the airborne window.
      { name: "jump",        priority: 50,  animation: "jump",        enterAnim: "jump_start",  exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "Compare", property: "velocity.y", op: "<", value: 0 } },
      { name: "fall",        priority: 40,  animation: "fall",        enterAnim: "",            exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "IsAirborne" } },
      // Turn states fire on the one tick facing flips. One-shot — the
      // anim plays, then the state ends and movement resumes.
      { name: "turn_left",   priority: 30,  animation: "turn_left",   enterAnim: "",            exitAnim: "",            useTransitions: false, loop: false, primary: { kind: "JustTurnedLeft" } },
      { name: "turn_right",  priority: 30,  animation: "turn_right",  enterAnim: "",            exitAnim: "",            useTransitions: false, loop: false, primary: { kind: "JustTurnedRight" } },
      { name: "crouch",      priority: 20,  animation: "crouch",      enterAnim: "crouch_in",   exitAnim: "crouch_out",  useTransitions: false, loop: true,  primary: { kind: "IsActionHeld", action: "Crouch" } },
      { name: "run",         priority: 15,  animation: "run",         enterAnim: "",            exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "IsMoving", value: 100 } },
      { name: "walk",        priority: 10,  animation: "walk",        enterAnim: "",            exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "IsMoving", value: 5 } },
      { name: "idle",        priority: 0,   animation: "idle",        enterAnim: "",            exitAnim: "",            useTransitions: false, loop: true,  primary: { kind: "Always" } },
    ],
    currentState: "idle",
    debugDraw: 0,
  },
  AIBrain: {
    autoBrain: 1,
    state: "idle",
    targetTag: "player",
    // Multi-tracer list — matches the AIBrain class default. (audit MED #82)
    sightTracerName: "sight,sight_forward,sight_behind",
    attackTracerName: "attack",
    attackRange: 40,
    loseSightAfterSec: 2.5,
    attackCooldownSec: 0.8,
    attackRestState: "alert",
    chaseSpeed: 100,
    patrolSpeed: 40,
    fleeOnDamage: 0,
    fleeDurationSec: 3,
    hearSignals: "",
    patrolMode: "none",
    detectionRadius: 0,
    autoFaceTarget: 1,
    // 9 fields that were declared in AIBrain.ts + WRITABLE_PARAMS +
    // BEHAVIOR_PARAMS but never in BEHAVIOR_DEFAULTS — so newly attached
    // AIBrains serialized with undefined for all of these. (audit HIGH #16, #17, #31)
    attackDurationSec: 0,
    interruptAttackOnHit: 1,
    disableWhenDead: 1,
    aiTickRate: 3,
    mover: "auto",
    separationDist: 0,
    separationTag: "enemy",
    separationAvoid: 0,
    separationMode: "push",
  },
  PhaseManager: {
    // Comma-separated thresholds (HP %). Each threshold adds a phase: "66,33"
    // → phase 0 (100-66%), phase 1 (66-33%), phase 2 (33-0%); "50" → phase 0
    // + phase 1. Edit live via the inspector. A "phase 1 at <50%" boss = "50".
    thresholdsPct: "66,33",
    currentPhase: 0,
    phaseVar: "phase",
    invulnOnTransitionSec: 0.6,
  },
  Widget: {
    widgetId: "",
    offsetX: 0,
    offsetY: -40,
    hideWhenDead: 1,
    linkedVar: "",
  },
  SmartTween: {
    // List of named animations. Each: { name, target, durationSec,
    // loop, playOnStart, easing, keyframes[] }. Editor surfaces this
    // as a table; runtime plays via PlayAnimatorAnim action.
    animations: [],
    // Scale-pivot offset (frame-local px from the sprite's frame pivot) that
    // scale keyframes pivot around. Set via a draggable point in the BP preview.
    scalePivotX: 0,
    scalePivotY: 0,
  },
  Projectile: {
    mode: "straight",
    speed: 600,
    lifetime: 3,
    gravityX: 0,
    gravityY: 0,
    targetTags: "",
    hitSignal: "",
    destroyOnHit: 1,
    collideTiles: 0,
    tileHitSignal: "",
    rotateToVelocity: 1,
    damage: 0,
    knockbackX: 0,
    knockbackY: 0,
    hitboxW: 0,
    hitboxH: 0,
    hitboxOffsetX: 0,
    hitboxOffsetY: 0,
    debugDraw: 0,
    targetUid: -1,
    homingTurnRate: 360,
  },
  Inventory: {
    capacity: 20,
    persistKey: "",
  },
  // No user-authored fields — config is injected by runProject from the
  // referenced TilemapAsset + TilesetAsset.
  TilemapRenderer: {},
  VisionMask: {
    radius: 80,
    featherPx: 0,
    cutoutOpacity: 0,
    maskSpriteId: "",
    maskSpriteMode: "static",
    maskAnimation: "",
    maskFrame: 0,
    maskMirror: 0,
    centerOffsetX: 0,
    centerOffsetY: 0,
    cutoutLayers: "",
    excludeTags: "",
    invert: 0,
    // Match WRITABLE_PARAMS — VisionMask listed `enabled` writable but
    // BEHAVIOR_DEFAULTS omitted it, so attached masks spawned with
    // enabled = undefined. (audit MED #80, #81)
    enabled: 1,
  },
  MoveTo: {
    mode: "position",
    targetX: 0,
    targetY: 0,
    targetUid: -1,
    targetTag: "",
    angleDeg: 0,
    speed: 100,
    stopRadius: 4,
    retargetEverySec: 0.5,
    arrivalSignal: "",
    mirror: 1,
    usePhysics: 1,
    enabled: 1,
    separationDist: 0,
    separationTag: "",
    separationStrength: 0.6,
    separationAvoid: 0,
    // Match the runtime class field (MoveTo.ts) so newly attached
    // MoveTo behaviors use the documented "push" default. (audit HIGH #75, #85)
    separationMode: "push",
  },
  TiledBackground: {
    spriteId: "",
    currentAnimation: "",
    playing: 1,
    startFrame: 0,
    mode: "followCamera",
    parallaxFactorX: 1,
    parallaxFactorY: 1,
    parallaxFactor: 1,
    scrollSpeedX: 0,
    scrollSpeedY: 0,
    width: 0,
    height: 0,
    flipX: 0,
    flipY: 0,
    tileX: 1,
    tileY: 1,
    enabled: 1,
  },
  WeaponSlot: {
    name: "RightHand",
    spriteId: "",
    currentAnimation: "",
    imagePoint: "",
    offsetX: 0,
    offsetY: 0,
    angleOffset: 0,
    scaleX: 1,
    scaleY: 1,
    followFacing: 1,
    renderAbove: 1,
    visible: 1,
    playing: 1,
    startFrame: 0,
    speed: 1,
  },
  Dismemberment: {
    regions: [],
    refAnimation: "",
    refFrame: 0,
    launch: "burst",
    angleDeg: 270,
    spreadDeg: 60,
    speedMin: 120,
    speedMax: 300,
    spinMin: -360,
    spinMax: 360,
    gravity: 900,
    bounce: 0.3,
    cleanup: "time",
    lifetimeSec: 4,
    fadeSec: 0.5,
    maxGibs: 50,
    collideWorld: 1,
    hideHost: 1,
    fireSignal: "",
  },
};

/** Lookup helper — used by editor + runtime resolver. */
export function findBlueprint(project: PeakyProject, blueprintId: string): BlueprintDef | undefined {
  return project.blueprints.find((b) => b.id === blueprintId);
}

/**
 * Collect every signal name that the project actually emits or declares —
 * the union of:
 *   - declared `signals` (from the toolbar's modal)
 *   - every `EmitSignal` action's `config.name` across all blueprint events
 *
 * Used by pickers (e.g. CharacterMovement Link-to-Signal) so users see
 * names they've typed into EmitSignal actions even if they never registered
 * them as Signals explicitly.
 */
/** Collect signal names that exist somewhere in the project, optionally
 *  filtered to what's REACHABLE from a specific BP's logic sheet.
 *
 *  When `opts.forBpId` is provided:
 *   - `EmitSignal` from ANY OTHER BP is excluded — those fire on that
 *     BP's own sprite bus and never cross to a different sprite.
 *   - `EmitSignalTo` from any BP is INCLUDED — those are addressed at
 *     specific other sprites by tag/uid, so they're real cross-BP comms.
 *   - `EmitSignal` from the same `forBpId` is INCLUDED — self-listens
 *     on the BP's own sprite (combo state machines, internal plumbing).
 *   - Project-declared signals (`project.signals`) are always included.
 *
 *  Without `forBpId`, every signal name in the project is returned
 *  (legacy unfiltered list, used for global pickers + autocomplete
 *  contexts that don't have a BP scope). */
export function collectEmittedSignalNames(project: PeakyProject, opts?: { forBpId?: string }): string[] {
  const forBpId = opts?.forBpId;
  const names = new Set<string>();
  for (const s of project.signals) names.add(s.name);
  // Tags carried by the BP whose picker this is — used to scope EmitSignalTo
  // broadcasts to their actual receivers. A broadcast to tag "camera" is only
  // audible to BPs that carry "camera", so it shouldn't appear elsewhere.
  const forBp = forBpId ? project.blueprints.find((b) => b.id === forBpId) : undefined;
  const forBpTags = new Set<string>(forBp?.tags ?? []);
  // Parse an EmitSignalTo's target tags from `tags` (array) or `tag` (legacy
  // comma string) — mirrors the runtime's parseTagList.
  const targetTags = (cfg: { tags?: unknown; tag?: unknown }): string[] => {
    const out: string[] = [];
    if (Array.isArray(cfg.tags)) for (const t of cfg.tags) { const s = String(t).trim(); if (s) out.push(s); }
    if (typeof cfg.tag === "string") for (const part of cfg.tag.split(",")) { const s = part.trim(); if (s) out.push(s); }
    return out;
  };
  // True when an EmitSignalTo broadcast can't reach `forBp` (a real BP that
  // lacks every target tag). Unscoped pickers (forBpId omitted) and untagged
  // broadcasts (mid-authoring) always pass.
  const broadcastUnreachable = (cfg: { tags?: unknown; tag?: unknown }): boolean => {
    if (!forBpId) return false;
    const tt = targetTags(cfg);
    if (tt.length === 0) return false;
    return !tt.some((t) => forBpTags.has(t));
  };
  const visit = (ev: PeakyEvent, ownerId: string) => {
    for (const a of ev.actions) {
      const isSelf = a.kind === "EmitSignal";
      const isTo = a.kind === "EmitSignalTo";
      if (!isSelf && !isTo) continue;
      if (forBpId && isSelf && ownerId !== forBpId) continue;
      if (isTo && broadcastUnreachable(a.config as { tags?: unknown; tag?: unknown })) continue;
      const cand = (a.config as { name?: unknown; signal?: unknown }).name ?? (a.config as { signal?: unknown }).signal;
      if (typeof cand === "string" && cand) names.add(cand);
    }
    for (const c of ev.children) visit(c, ownerId);
  };
  // Behavior config fields that EMIT a signal on the host sprite's own bus
  // (like a self EmitSignal) — these never appear as EmitSignal actions, so
  // scan them explicitly. Scoped to the owning BP (forBpId), since they fire
  // on that sprite's bus.
  const BEHAVIOR_EMIT_SIGNAL_FIELDS: Record<string, string[]> = {
    Projectile: ["hitSignal", "tileHitSignal"],
  };
  for (const bp of project.blueprints) {
    if (!forBpId || bp.id === forBpId) {
      for (const b of bp.behaviors) {
        const fields = BEHAVIOR_EMIT_SIGNAL_FIELDS[b.kind];
        if (!fields) continue;
        for (const f of fields) {
          const v = (b.config as Record<string, unknown>)[f];
          if (typeof v === "string" && v.trim()) names.add(v.trim());
        }
      }
    }
    for (const ev of bp.events) visit(ev, bp.id);
    const folders = bp.logicSheet?.folders ?? [];
    for (const folder of folders) {
      for (const node of folder.graph.nodes) {
        if (node.kind !== "action") continue;
        const isSelf = node.type === "EmitSignal";
        const isTo = node.type === "EmitSignalTo";
        if (!isSelf && !isTo) continue;
        if (forBpId && isSelf && bp.id !== forBpId) continue;
        if (isTo && broadcastUnreachable(node.params as { tags?: unknown; tag?: unknown })) continue;
        const params = node.params as { signal?: unknown; name?: unknown };
        const candidate = params.signal ?? params.name;
        if (typeof candidate === "string" && candidate) names.add(candidate);
      }
    }
  }
  // Same rule for Main Logic Sheets — each sheet's host is its own
  // sprite bus, so an EmitSignal on Main Sheet A is invisible to Main
  // Sheet B and to every BP. EmitSignalTo is always visible.
  for (const ms of project.mainLogicSheets ?? []) {
    const ownerId = `__main_logic__:${ms.id}`;
    for (const folder of ms.sheet.folders) {
      for (const node of folder.graph.nodes) {
        if (node.kind !== "action") continue;
        const isSelf = node.type === "EmitSignal";
        const isTo = node.type === "EmitSignalTo";
        if (!isSelf && !isTo) continue;
        if (forBpId && isSelf && ownerId !== forBpId) continue;
        if (isTo && broadcastUnreachable(node.params as { tags?: unknown; tag?: unknown })) continue;
        const params = node.params as { signal?: unknown; name?: unknown };
        const candidate = params.signal ?? params.name;
        if (typeof candidate === "string" && candidate) names.add(candidate);
      }
    }
  }
  // UI widget element signals (button click, dropdown change, slider change,
  // hover/leave, slot, craft) now BROADCAST scene-wide — UIWidgetRenderer emits
  // them on every sprite's bus — so they're audible in ANY blueprint's
  // OnSignal. Surface them in EVERY picker (no widget-self scoping). Also scan
  // each widget's OWN logic sheet for EmitSignal / EmitSignalTo, same as
  // blueprints, so a signal a widget's sheet sends is selectable in the listener.
  for (const w of project.uiWidgets) {
    const collect = (v: UIWidgetVisual) => {
      for (const s of [v.signalOnClick, v.signalOnHover, v.signalOnLeave, v.signalOnChange, v.signalOnSelect, v.signalOnSlotClick, v.signalOnSlotDoubleClick, v.signalOnCraftClick, v.signalOnCraft]) {
        if (typeof s === "string" && s) names.add(s);
      }
      for (const o of v.options ?? []) if (typeof o.signal === "string" && o.signal) names.add(o.signal);
    };
    collect(w);
    for (const c of w.children ?? []) collect(c);
    for (const folder of w.logicSheet?.folders ?? []) {
      for (const node of folder.graph?.nodes ?? []) {
        if (node.kind !== "action") continue;
        const isSelf = node.type === "EmitSignal";
        const isTo = node.type === "EmitSignalTo";
        if (!isSelf && !isTo) continue;
        if (forBpId && isSelf && w.id !== forBpId) continue;
        if (isTo && broadcastUnreachable(node.params as { tags?: unknown; tag?: unknown })) continue;
        const params = node.params as { signal?: unknown; name?: unknown };
        const candidate = params.signal ?? params.name;
        if (typeof candidate === "string" && candidate) names.add(candidate);
      }
    }
  }
  return Array.from(names).sort();
}
