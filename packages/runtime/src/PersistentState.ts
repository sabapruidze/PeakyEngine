/**
 * Cross-scene persistent state — a MODULE-LEVEL singleton, deliberately not on
 * the Phaser game or scene data. Scene transitions tear down and recreate the
 * whole game (see the editor's ScenePanel), so anything stored on the game is
 * lost on every transition. This module stays loaded across those recreations,
 * so it's the one place state can survive moving between scenes.
 *
 * Holds:
 *  - `removedInstances`: stable ids of authored scene instances that were
 *    permanently removed (Destroy with "Remember"). runProject skips spawning
 *    them when a scene reloads, so picked-up / destroyed objects stay gone.
 *  - `globals`: global variables (money, day, counts, flags, AND arrays)
 *    read/written via the `global:<name>` expression + the SetGlobal /
 *    GlobalArrayOp actions. Mutable, persisted into save/load.
 *  - `lists`: read-only lookup data authored in the editor (prices, dialogue
 *    lines, spawn tables). Read via `list:<name>`; never written at runtime,
 *    so it's re-seeded fresh from the project each Play (NOT serialized).
 *
 * Lifetime: reset at the START of a Play session (the editor calls
 * `resetPersistentState()` on the initial boot, NOT on scene transitions), and
 * `globals` + `removedInstances` are serialized into Save/Load so they survive
 * quitting. In-session everything persists across every scene change.
 */
export type GlobalScalar = number | string | boolean;
export type GlobalValue = GlobalScalar | GlobalScalar[];

interface PersistentStateShape {
  removedInstances: Set<string>;
  globals: Record<string, GlobalValue>;
  /** Read-only lists: group name → { entry name → value }. */
  lists: Record<string, Record<string, GlobalScalar>>;
  /** Shop stock remaining, keyed by `<shopName>#<slotIndex>`. Depletes as the
   *  player buys; persists across scenes (NOT save/load); refilled by the
   *  Restock Shop action. Seeded lazily from each Shop's config on spawn. */
  shopStock: Record<string, number>;
  /** Full inventory bags that should survive scene changes, keyed by each
   *  Inventory's authored `persistKey` (e.g. "player"). The whole slot array is
   *  stored — so items, amounts AND positions carry over — and each key is
   *  independent, so a player and a chest never cross-contaminate. Inventories
   *  with an empty persistKey are scene-local and never appear here. */
  inventories: Record<string, { itemId: string; qty: number }[]>;
  /** Monotonic counter behind `nextSpawnId()`. Persisted into save/load so a
   *  spawnId minted in one session never collides with one recreated from a
   *  save. Recreated objects keep their OLD (smaller) spawnId; new spawns
   *  always draw from here, which the load path restores ABOVE every saved id. */
  spawnCounter: number;
  /** Runtime-spawned objects (CreateObject) captured per scene when the player
   *  LEAVES a level, so placed candles / drops come back on return. Keyed by
   *  scene id; each record is plain JSON (bp + position + vars + behavior
   *  state) that runScene replays after authored instances. The CURRENT scene
   *  is handled by SaveSlot's own sprite snapshot — this carries the OTHERS,
   *  and is itself serialized into save/load so they survive quitting too. */
  spawnedByScene: Record<string, unknown[]>;
  /** Tilemap edits (mined/placed tiles, partial HP) captured per scene on level
   *  exit so they survive a level change + come back on return. Keyed by scene
   *  id → tilemap-host instanceId → the TilemapRenderer.serialize() payload.
   *  Also serialized into save/load so they survive quitting. */
  tileEditsByScene: Record<string, Record<string, unknown>>;
  /** Transient door hand-off: when a Door fires, it stashes where the traveler
   *  should arrive; the destination scene's build reads + clears it to place the
   *  traveler on the matching door. Not serialized (a momentary transition-time
   *  value); cleared on Play reset and consumed on arrival. */
  pendingEntry?: { destSceneId: string; destDoor: string; travelerTag?: string };
}

const _state: PersistentStateShape = {
  removedInstances: new Set<string>(),
  globals: {},
  lists: {},
  shopStock: {},
  inventories: {},
  spawnCounter: 0,
  spawnedByScene: {},
  tileEditsByScene: {},
};

/** Mint a stable id for a runtime-spawned object (CreateObject). Stamped onto
 *  the Sprite by the `peaky.spawn` callback so SaveSlot can recreate the object
 *  on load — authored instances use `instanceId` instead and don't call this. */
export function nextSpawnId(): string {
  return `spawn:${_state.spawnCounter++}`;
}

/** Record (or clear) the runtime-spawned objects for a scene on level exit. */
export function setSceneSpawns(sceneId: string, records: unknown[]): void {
  if (records.length) _state.spawnedByScene[sceneId] = records;
  else delete _state.spawnedByScene[sceneId];
}

/** The runtime-spawned objects to replay when (re)building a scene. */
export function getSceneSpawns(sceneId: string): unknown[] {
  return _state.spawnedByScene[sceneId] ?? [];
}

/** Record (or clear) the tilemap edits for a scene on level exit. */
export function setSceneTileEdits(sceneId: string, edits: Record<string, unknown>): void {
  if (Object.keys(edits).length > 0) _state.tileEditsByScene[sceneId] = edits;
  else delete _state.tileEditsByScene[sceneId];
}

/** The tilemap edits to re-apply when (re)building a scene (host instanceId → payload). */
export function getSceneTileEdits(sceneId: string): Record<string, unknown> {
  return _state.tileEditsByScene[sceneId] ?? {};
}

export function persistentState(): PersistentStateShape {
  return _state;
}

/** Stash where a Door should drop the traveler in the NEXT scene. */
export function setPendingEntry(ep: { destSceneId: string; destDoor: string; travelerTag?: string } | undefined): void {
  _state.pendingEntry = ep;
}

/** Read + CLEAR the pending door entry (consumed once by the destination build). */
export function takePendingEntry(): { destSceneId: string; destDoor: string; travelerTag?: string } | undefined {
  const ep = _state.pendingEntry;
  _state.pendingEntry = undefined;
  return ep;
}

/** Wipe everything — a fresh Play session / new game. */
export function resetPersistentState(): void {
  _state.removedInstances.clear();
  _state.globals = {};
  _state.lists = {};
  _state.shopStock = {};
  _state.inventories = {};
  _state.spawnCounter = 0;
  _state.spawnedByScene = {};
  _state.tileEditsByScene = {};
  _state.pendingEntry = undefined;
}

/**
 * Seed declared global variables to their authored defaults. Called once at
 * the start of a Play session (right after `resetPersistentState`) so globals
 * that have a non-zero / string / array initial value start correctly even
 * before any SetGlobal runs. Only fills keys that aren't already set, so it
 * never clobbers a value carried in from a save.
 */
export function seedPersistentGlobals(defaults: Record<string, GlobalValue>): void {
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in _state.globals)) _state.globals[k] = Array.isArray(v) ? [...v] : v;
  }
}

/**
 * Seed read-only lists from the project. Always overwrites (lists are constant
 * config — they reflect the current project, not a save), so call once per Play
 * start after `resetPersistentState`.
 */
export function seedPersistentLists(lists: Record<string, Record<string, GlobalScalar>>): void {
  _state.lists = {};
  for (const [k, v] of Object.entries(lists)) _state.lists[k] = { ...v };
}

/** Plain-JSON snapshot for SaveSlot. Lists are intentionally excluded — they're
 *  constant project data, re-seeded each Play. `shopStock` IS included so a
 *  saved game restores depleted/limited shop stock instead of resetting it to
 *  full on load (which would be a buy-exploit). */
export function serializePersistentState(): { removedInstances: string[]; globals: Record<string, GlobalValue>; shopStock: Record<string, number>; inventories: Record<string, { itemId: string; qty: number }[]>; spawnCounter: number; spawnedByScene: Record<string, unknown[]>; tileEditsByScene: Record<string, Record<string, unknown>> } {
  return {
    removedInstances: [..._state.removedInstances],
    globals: { ..._state.globals },
    shopStock: { ..._state.shopStock },
    inventories: JSON.parse(JSON.stringify(_state.inventories)),
    spawnCounter: _state.spawnCounter,
    spawnedByScene: JSON.parse(JSON.stringify(_state.spawnedByScene)),
    tileEditsByScene: JSON.parse(JSON.stringify(_state.tileEditsByScene)),
  };
}

/** Restore from a SaveSlot payload (tolerates missing fields / legacy saves).
 *  Leaves `lists` untouched (they were seeded from the project at Play start). */
export function applyPersistentState(data: { removedInstances?: unknown; globals?: unknown; shopStock?: unknown; inventories?: unknown; spawnCounter?: unknown; spawnedByScene?: unknown; tileEditsByScene?: unknown } | undefined): void {
  if (!data) return;
  _state.spawnedByScene = (data.spawnedByScene && typeof data.spawnedByScene === "object")
    ? JSON.parse(JSON.stringify(data.spawnedByScene))
    : {};
  _state.tileEditsByScene = (data.tileEditsByScene && typeof data.tileEditsByScene === "object")
    ? JSON.parse(JSON.stringify(data.tileEditsByScene))
    : {};
  _state.removedInstances = new Set(Array.isArray(data.removedInstances) ? (data.removedInstances as string[]) : []);
  _state.globals = (data.globals && typeof data.globals === "object")
    ? { ...(data.globals as Record<string, GlobalValue>) }
    : {};
  _state.shopStock = (data.shopStock && typeof data.shopStock === "object")
    ? { ...(data.shopStock as Record<string, number>) }
    : {};
  _state.inventories = (data.inventories && typeof data.inventories === "object")
    ? JSON.parse(JSON.stringify(data.inventories))
    : {};
  _state.spawnCounter = typeof data.spawnCounter === "number" ? data.spawnCounter : 0;
}
