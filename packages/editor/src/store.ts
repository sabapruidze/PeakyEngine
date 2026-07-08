import { create } from "zustand";
import {
  ACTION_DEFAULTS,
  Condition,
  ConditionKind,
  DialogueLineParsed as ParsedDialogueLine,
  StateAction,
  StateActionKind,
} from "@peaky/shared";
import { sanitizeAssetName, sanitizeFolderPath } from "./sanitize";
import {
  getActiveAssetStore,
  notifyAssetStoreChange,
  spriteDiskFolder,
  spriteFrameDiskPath,
  tilesetDiskFolder,
  tilesetImagePath,
  soundDiskPath,
  fontDiskPath,
  blueprintDiskPath,
  sceneDiskPath,
  spriteMetaDiskPath,
  tilesetMetaDiskPath,
  tilemapDiskPath,
  dialogueDiskPath,
  uiWidgetDiskPath,
  itemDiskPath,
  recipeDiskPath,
} from "./AssetStore";
import {
  BEHAVIOR_DEFAULTS,
  BehaviorKind,
  BlueprintDef,
  BlueprintInstance,
  SpritePlacement,
  DialogueAsset,
  DialogBoxAsset,
  DialogueChoice,
  DialogueDefaults,
  DialogueLine,
  LayerDef,
  LogicSheet,
  LogicGraphNode,
  SignalDef,
  GlobalVarDef,
  ListDef,
  ListEntry,
  PeakyEvent,
  PeakyEventKind,
  InputActionDef,
  PeakyProject,
  ProjectSampling,
  SceneData,
  TilesetAsset,
  BigTile,
  TerrainDef,
  TilemapAsset,
  TilemapLayer,
  TilemapInstance,
  NavMesh,
  NavObstacle,
  NavWaypoint,
  SoundAsset,
  FontAsset,
  ItemAsset,
  RecipeAsset,
  SpriteAnimationDef,
  SpriteAsset,
  SpriteFrame,
  SpriteImagePoint,
  UIWidgetChild,
  UIWidgetDef,
  UIWidgetInstance,
  UIWidgetKind,
  LODGroup,
  VariableDef,
  defaultDialogueStyle,
  defaultLayers,
  defaultsForUIWidgetKind,
  emptyProject,
  findBlueprint,
  itemCountGlobalName,
  newId,
  tilemapTilesets,
  TILESET_GID_STRIDE,
} from "./project";
import type { AnimFrame } from "./project";

// A tilemap references a tileset if it's the primary OR any extra slot.
// Mutators that purge BigTile/animated placements for a deleted def must check
// BOTH — keying only on the primary `tilesetId` leaves dangling placements on
// maps that carry the tileset as an extra slot.
const mapRefsTileset = (m: { tilesetId?: string; extraTilesetIds?: string[] }, tilesetId: string) =>
  m.tilesetId === tilesetId || (m.extraTilesetIds ?? []).includes(tilesetId);

export type EditorView = "scene" | "blueprint";

export type ActiveTab =
  | { kind: "scene" }
  | { kind: "blueprint"; id: string }
  | { kind: "sprite"; id: string }
  | { kind: "dialogue"; id: string }
  | { kind: "uiwidget"; id: string }
  | { kind: "tileset"; id: string }
  | { kind: "tilemap"; id: string }
  | { kind: "dialogflow" };

interface EditorState {
  project: PeakyProject;
  view: EditorView;

  openSceneIds: string[];
  openBlueprintIds: string[];
  openSpriteIds: string[];
  openDialogueIds: string[];
  openUIWidgetIds: string[];
  openTilesetIds: string[];
  openTilemapIds: string[];
  /** Per-BP Logic Sheet open-folder id. Local component state forgot the
   *  selection on tab switch / re-mount; persisting here keeps the same
   *  folder open across navigation. Keyed by BP id (or scene id for the
   *  Main Sheet view, where the key is "__main__:<sceneId>"). */
  openLogicFolderByOwner: Record<string, string>;
  /** Editor-only: when true, clicking on the SELECTED tilemap instance in the
   *  scene editor paints onto it instead of drag-moving. Driven by a toggle
   *  on the tilemap-instance inspector. Reset to false on tab/scene switch. */
  tilemapPaintMode: boolean;
  activeTab: ActiveTab;
  /** Scene tab sub-view: the visual scene editor vs the project Main Sheet.
   *  Driven from the top tab bar; persisted across reloads. */
  sceneSubTab: "scene" | "main";

  /** Bottom dock active panel (Content Browser vs Output Log). Lifted to the
   *  store so the left rail can focus the Content Browser. Persisted. */
  dockTab: "content" | "console";
  /** Bottom dock collapsed (hidden) — toggled by the left-rail folder icon so
   *  the editor gets full height when you don't need the Content Browser
   *  (e.g. while editing a blueprint). Persisted. */
  dockCollapsed: boolean;

  selectedInstanceId: string | null;
  /** Multi-selection — the FULL set of selected instance ids when the user
   *  has Shift/Ctrl-clicked multiple. Includes the primary `selectedInstanceId`.
   *  Hoisted from SceneEditor's local state so the Outliner can multi-select
   *  too and the Inspector's edits (e.g. layer change) can fan out across the
   *  group. Empty set when only one or zero are selected. */
  multiSelected: Set<string>;
  selectedBlueprintId: string | null;

  isRunning: boolean;

  // "broken" when a folder auto-save write has thrown — surfaced by the
  // SaveStatusBanner so silent loss can't slip past unnoticed.
  autosaveStatus: "ok" | "broken";
  // The actual reason the last auto-save threw (folder-write error message, or
  // the wipe-guard's protective refusal). null while healthy. Shown verbatim in
  // the banner so the user/dev sees the real cause instead of a stale guess.
  autosaveError: string | null;
  // True when the failure was the empty-state WIPE GUARD — disk is intact, the
  // save was REFUSED to avoid deleting files, not lost. Lets the banner reassure.
  autosaveGuard: boolean;

  // ---- undo / redo ----
  past: PeakyProject[];
  future: PeakyProject[];
  /** Bumped on every undo/redo. Components that mirror project data into
   *  local state (e.g. the Logic Sheet canvas's xyflow nodes, which only
   *  re-sync on folder.id) watch this to force a re-sync when an undo
   *  reverts content without changing ids. */
  historyTick: number;
  undo: () => void;
  redo: () => void;

  // ---- selectors ----
  activeScene: () => SceneData;
  selectedInstance: () => BlueprintInstance | null;
  /** Returns the selected UI Widget instance (if the current selection
   *  refers to one). Mutually exclusive with `selectedInstance()` —
   *  the same `selectedInstanceId` field is used for both kinds, and
   *  exactly one (or neither) will return non-null. */
  selectedUIInstance: () => UIWidgetInstance | null;
  /** Returns the selected Tilemap instance (if the current selection
   *  refers to one). Mutually exclusive with `selectedInstance` and
   *  `selectedUIInstance` — exactly one (or none) returns non-null. */
  selectedTilemapInstance: () => TilemapInstance | null;
  /** The currently-selected SpritePlacement, or null. Same shared
   *  `selectedInstanceId` field as the other instance kinds. */
  selectedSpritePlacement: () => SpritePlacement | null;
  selectedBlueprint: () => BlueprintDef | null;
  blueprintFor: (instance: BlueprintInstance) => BlueprintDef | undefined;

  // ---- view + selection ----
  setView: (v: EditorView) => void;
  selectInstance: (id: string | null) => void;
  setMultiSelected: (ids: Set<string>) => void;
  toggleMultiSelected: (id: string) => void;
  selectBlueprint: (id: string | null) => void;

  // ---- tabs ----
  openSceneTab: (sceneId: string) => void;
  closeSceneTab: (sceneId: string) => void;
  openBlueprintTab: (bpId: string) => void;
  closeBlueprintTab: (bpId: string) => void;
  openSpriteTab: (spriteId: string) => void;
  closeSpriteTab: (spriteId: string) => void;
  openDialogueTab: (dialogueId: string) => void;
  closeDialogueTab: (dialogueId: string) => void;
  /** Open the project-singleton Dialog Flow timeline view. */
  openDialogFlowTab: () => void;
  openTilesetTab: (id: string) => void;
  closeTilesetTab: (id: string) => void;
  openTilemapTab: (id: string) => void;
  closeTilemapTab: (id: string) => void;
  setTilemapPaintMode: (v: boolean) => void;
  /** Editor-only: SmartTween scrub preview. When set, the BlueprintPreview
   *  applies the sampled keyframe values to the chosen target so authors
   *  can see "what this point in the animation looks like" without
   *  running the scene. Cleared on row collapse / animation switch. */
  animatorPreview: { bpId: string; target: string; mirror: number; offsetX: number; offsetY: number; scale: number; opacity: number; rotation: number; tint?: number; tintFill?: number } | null;
  setAnimatorPreview: (p: EditorState["animatorPreview"]) => void;

  // ---- tilesets ----
  /** Create a new (empty) tileset under the given Content Browser folder. */
  addTileset: (path?: string) => string;
  renameTileset: (id: string, name: string) => void;
  removeTileset: (id: string) => void;
  /** Update slicer / collision config for a tileset. Pass only the fields you
   *  want to change — `tiles` arrays are untouched. */
  updateTileset: (id: string, patch: Partial<TilesetAsset>) => void;
  /** Toggle the per-tile solid flag at `tileIndex` in the given tileset. */
  toggleTileSolid: (id: string, tileIndex: number) => void;

  // ---- terrains (auto-tile) ----
  /** Add a new empty terrain to a tileset. Returns the new terrain id.
   *  defaultTile defaults to 0; user reassigns via the slot editor. */
  /** Set a per-tile custom collision polygon (points in pixel coords within
   *  the tile cell). Pass null to clear back to the default (full-cell)
   *  collision shape. Tile must be in `solidTiles` for the polygon to
   *  actually affect runtime collision. */
  setTileCollider: (tilesetId: string, tileIdx: number, polygon: { points: { x: number; y: number }[] } | null) => void;
  setTileMining: (tilesetId: string, tileIdx: number, hardness: number | string, drops: { bp: string; min: number; max: number; chance: number; instanceName?: string; animation?: string; frame?: number; vars?: Record<string, string | number | boolean> }[]) => void;
  setTileDropLayer: (tilesetId: string, tileIdx: number, layerName: string) => void;
  setTileGrowBack: (tilesetId: string, tileIdx: number, value: string) => void;
  setTileGrowBackPop: (tilesetId: string, tileIdx: number, pop: boolean) => void;
  setTileOnBelowRemoved: (tilesetId: string, tileIdx: number, value: "destroy" | "drop" | "none") => void;
  setTilesetGlobalExcludedTags: (tilesetId: string, tags: string[]) => void;
  setTileExcludedTags: (tilesetId: string, tileIdx: number, tags: string[]) => void;
  setBigTileOnBelowRemoved: (tilesetId: string, bigTileId: string, value: "destroy" | "drop" | "none") => void;
  setBigTileExcludedTags: (tilesetId: string, bigTileId: string, tags: string[]) => void;
  addTerrain: (tilesetId: string, name?: string) => string;
  /** Append a new (empty / all-wildcard) rule and return its id. */
  addTerrainRule: (tilesetId: string, terrainId: string) => string;
  /** Drop a rule from a terrain. */
  removeTerrainRule: (tilesetId: string, terrainId: string, ruleId: string) => void;
  /** Patch a rule's tile and/or neighbors array. */
  updateTerrainRule: (tilesetId: string, terrainId: string, ruleId: string, patch: Partial<{ tile: number; neighbors: ("any" | "must" | "mustNot")[] }>) => void;
  /** Move a rule up (-1) or down (+1) in the priority list. */
  reorderTerrainRule: (tilesetId: string, terrainId: string, ruleId: string, dir: -1 | 1) => void;
  removeTerrain: (tilesetId: string, terrainId: string) => void;
  /** Patch any subset of a terrain's props (name, color, defaultTile). Does
   *  not touch `rules` — use the rule CRUD methods for that. */
  updateTerrain: (tilesetId: string, terrainId: string, patch: Partial<TerrainDef>) => void;

  // ---- tilemaps ----
  addTilemap: (path?: string, tilesetId?: string) => string;
  renameTilemap: (id: string, name: string) => void;
  setTilemapTags: (id: string, tags: string[]) => void;
  removeTilemap: (id: string) => void;
  setTilemapTileset: (id: string, tilesetId: string) => void;
  /** Append an extra tileset to the map's ordered list (Tiled-style firstgid).
   *  No-op if it's already the primary or already in the list. */
  addTilemapTileset: (id: string, tilesetId: string) => void;
  /** Remove an extra tileset from the map. Cells painted from it (and from any
   *  LATER tileset, whose firstgids shift) are cleared to -1 so nothing
   *  reinterprets to the wrong art. The primary tileset can't be removed here. */
  removeTilemapTileset: (id: string, tilesetId: string) => void;
  /** Resize the tilemap grid. New cells are filled with -1 (empty); trimmed
   *  cells are dropped. Applied to ALL layers so they stay in lock-step. */
  resizeTilemap: (id: string, cols: number, rows: number) => void;
  /** Set a single cell on the given layer to `tile` (use -1 for empty). */
  paintTile: (id: string, layerId: string, col: number, row: number, tile: number, xf?: number) => void;
  /** Bulk-paint many cells in one update on the given layer (bucket / rect
   *  / multi-stroke brushes that would otherwise spam history). */
  paintTiles: (id: string, layerId: string, edits: { col: number; row: number; tile: number }[], xf?: number) => void;
  /** Append a new empty layer to the tilemap (z = max z + 1). Returns its id. */
  addTilemapLayer: (id: string, name?: string) => string;
  /** Remove a layer. No-op if it's the last one (a tilemap must have ≥1). */
  removeTilemapLayer: (id: string, layerId: string) => void;
  renameTilemapLayer: (id: string, layerId: string, name: string) => void;
  /** Patch any subset of a layer's props (z / alpha / visible / collides). */
  updateTilemapLayer: (id: string, layerId: string, patch: Partial<TilemapLayer>) => void;
  /** Move a layer one slot up (delta -1) or down (+1) in the z stack. Slots
   *  are reassigned contiguously so z stays the on-screen order. */
  reorderTilemapLayer: (id: string, layerId: string, delta: number) => void;
  /** Drag-drop: move a layer to `toIndex` in the ASCENDING-z order (0 =
   *  bottom-most). z values are renumbered contiguously after the move. */
  moveTilemapLayerTo: (id: string, layerId: string, toIndex: number) => void;
  /** Create a BigTile in a tileset from a rectangular region of cells.
   *  Returns the new bigTile id. Removes any existing bigTile that overlaps
   *  the region. */
  addBigTile: (tilesetId: string, c: number, r: number, w: number, h: number, cells?: { c: number; r: number }[]) => string;
  setBigTileCells: (tilesetId: string, bigTileId: string, cells: { c: number; r: number }[]) => void;
  removeBigTile: (tilesetId: string, bigTileId: string) => void;
  /** Update pivot fractions (0..1) for a BigTile. */
  setBigTilePivot: (tilesetId: string, bigTileId: string, pivotX: number, pivotY: number) => void;
  /** Update the Y-sort flip-point fraction (0..1) for a BigTile. */
  setBigTileSortY: (tilesetId: string, bigTileId: string, sortY: number) => void;
  setBigTileSortLineY: (tilesetId: string, bigTileId: string, sortLineY: number) => void;
  /** Set a BigTile's collision rect (in cell units within its bbox). Pass null
   *  to clear (BigTile becomes non-blocking again). */
  setBigTileCollide: (tilesetId: string, bigTileId: string, rect: { cx: number; cy: number; cw: number; ch: number } | null) => void;
  setBigTileCollidePoly: (tilesetId: string, bigTileId: string, poly: { points: { x: number; y: number }[] } | null) => void;
  patchBigTile: (tilesetId: string, bigTileId: string, patch: Partial<BigTile>) => void;
  setBigTileTags: (tilesetId: string, bigTileId: string, tags: string[]) => void;
  /** Place a BigTile in a tilemap layer at anchor (c, r). Returns placement id. */
  placeBigTile: (tilemapId: string, layerId: string, bigTileId: string, c: number, r: number) => string;
  removeBigTilePlacement: (tilemapId: string, layerId: string, placementId: string) => void;

  // ---- animated tiles (live frame-cycle composites) ----
  /** Create a new animated tile on a tileset. Returns the new id. */
  addAnimatedTile: (tilesetId: string) => string;
  removeAnimatedTile: (tilesetId: string, animatedTileId: string) => void;
  updateAnimatedTile: (
    tilesetId: string,
    animatedTileId: string,
    patch: Partial<{ name: string; fps: number; loop: boolean; autoplay: boolean; hardness: number | string; destroyOnDepleted: boolean; playOnDepleted: boolean; playOnHit: boolean; damageStagesMode: boolean; tags: string[]; dropLayer: string; onBelowRemoved: "destroy" | "drop" | "none"; excludedTags: string[]; playOnOverlap: boolean; overlapTags: string[]; overlapMode: "edge" | "latch" | "loop"; signalOnHit: string; signalOnMine: string }>,
  ) => void;
  setAnimatedTileFrames: (tilesetId: string, animatedTileId: string, frames: AnimFrame[]) => void;
  setAnimatedTileDrops: (
    tilesetId: string,
    animatedTileId: string,
    drops: { bp: string; min: number; max: number; chance: number; instanceName?: string; animation?: string; frame?: number; vars?: Record<string, string | number | boolean> }[],
  ) => void;
  placeAnimatedTile: (tilemapId: string, layerId: string, animatedTileId: string, c: number, r: number) => string;
  removeAnimatedTilePlacement: (tilemapId: string, layerId: string, placementId: string) => void;

  // ---- tilemap instances (per scene) ----
  addTilemapInstance: (sceneId: string, inst: Omit<TilemapInstance, "id">) => string;
  updateTilemapInstance: (sceneId: string, instId: string, patch: Partial<TilemapInstance>) => void;
  removeTilemapInstance: (sceneId: string, instId: string) => void;
  // ---- nav mesh (per scene) ----
  /** Create the scene's navMesh (sized from scene w/h) if absent; no-op otherwise. */
  ensureNavMesh: (sceneId: string, cellSize?: number) => void;
  /** Set walkability for a batch of cells. Value: 0=blocked, 1=linear (green,
   *  sharp turns), 2=curved (yellow, rounded turns). 1 & 2 are both walkable. */
  paintNavWalkable: (sceneId: string, cells: { c: number; r: number; walkable: number }[]) => void;
  /** Paint the SHELTER mask (weather-blocked cells). on: 1 = shelter, 0 = clear. */
  paintNavShelter: (sceneId: string, cells: { c: number; r: number; on: number }[]) => void;
  /** Change grid resolution; resamples the painted walkable mask so paint survives. */
  setNavCellSize: (sceneId: string, cellSize: number) => void;
  /** Resize the nav AREA in world px (for unbounded maps bigger than the layout).
   *  Keeps the painted mask for the overlapping region. */
  setNavSize: (sceneId: string, width: number, height: number) => void;
  setNavDebug: (sceneId: string, on: boolean) => void;
  setNavRegionLocked: (sceneId: string, on: boolean) => void;
  addNavObstacle: (sceneId: string, points: { x: number; y: number }[], tags?: string[]) => string;
  updateNavObstacle: (sceneId: string, obstacleId: string, patch: Partial<NavObstacle>) => void;
  removeNavObstacle: (sceneId: string, obstacleId: string) => void;
  addNavWaypoint: (sceneId: string, x: number, y: number, tags?: string[]) => string;
  updateNavWaypoint: (sceneId: string, waypointId: string, patch: Partial<NavWaypoint>) => void;
  removeNavWaypoint: (sceneId: string, waypointId: string) => void;
  setActiveTab: (tab: ActiveTab) => void;
  setSceneSubTab: (t: "scene" | "main") => void;
  setDockTab: (t: "content" | "console") => void;
  setDockCollapsed: (v: boolean) => void;

  // ---- folders + asset paths ----
  addFolder: (path: string) => void;
  removeFolder: (path: string) => void;
  renameFolder: (oldPath: string, newPath: string) => void;
  setBlueprintPath: (bpId: string, path: string) => void;
  setScenePath: (sceneId: string, path: string) => void;
  setSpritePath: (spriteId: string, path: string) => void;
  /** Soft-delete handle — sets the `hidden` flag on the named asset across
   *  any kind (blueprint / scene / sprite / uiwidget / dialogue). Hidden
   *  assets stay in the project file but the Content Browser filters them
   *  out unless "Show Hidden" is toggled on. Lets users declutter without
   *  losing data; flagging for permanent deletion comes later. */
  setAssetHidden: (kind: "blueprint" | "scene" | "sprite" | "uiwidget" | "dialogue" | "sound" | "item" | "recipe", id: string, hidden: boolean) => void;
  /** Reset the editor to a fresh empty project. Replaces `project` with
   *  `emptyProject()` and clears every view-state field (open tabs,
   *  selections, undo history, etc.) so nothing references stale ids. */
  newProject: () => void;

  // ---- sprite asset CRUD ----
  addSprite: (path?: string) => string;
  renameSprite: (id: string, name: string) => void;
  removeSprite: (id: string) => void;
  setSpriteSize: (id: string, width: number, height: number) => void;
  /** Same as `setSpriteSize` but first stamps the CURRENT `sprite.width` /
   *  `sprite.height` onto every un-sized frame in animations OTHER than
   *  `exceptAnimId`. Use after a crop / resize that targets one animation
   *  so other animations keep their previous render size instead of
   *  snapping to the new (smaller) asset size via the imageW/imageH
   *  fallback. The current anim's frames carry their own freshly-stamped
   *  imageW/imageH already. */
  setSpriteSizeProtecting: (id: string, width: number, height: number, exceptAnimId: string) => void;
  setSpriteLockAspect: (id: string, locked: boolean) => void;

  addSpriteAnimation: (spriteId: string, name?: string) => string;
  renameSpriteAnimation: (spriteId: string, animId: string, name: string) => void;
  removeSpriteAnimation: (spriteId: string, animId: string) => void;
  updateSpriteAnimation: (spriteId: string, animId: string, patch: Partial<SpriteAnimationDef>) => void;
  reorderSpriteAnimation: (spriteId: string, fromAnimId: string, toAnimId: string) => void;

  addSpriteFrame: (
    spriteId: string,
    animId: string,
    init?: { color?: number; imageFile?: string; imageW?: number; imageH?: number },
  ) => string;
  removeSpriteFrame: (spriteId: string, animId: string, frameId: string) => void;
  removeSpriteFrames: (spriteId: string, animId: string, frameIds: string[]) => void;
  insertSpriteFrames: (
    spriteId: string,
    animId: string,
    frames: Array<Omit<SpriteFrame, "id">>,
    afterIdx: number,
  ) => string[];
  updateSpriteFrame: (spriteId: string, animId: string, frameId: string, patch: Partial<SpriteFrame>) => void;
  /** Copy `frameId`'s collider config onto every frame in the SAME
   *  animation. Convenience for "this is a static prop, all frames
   *  share the body". */
  applyColliderToAnimFrames: (spriteId: string, animId: string, sourceFrameId: string) => void;
  /** Copy `frameId`'s collider config onto every frame in EVERY
   *  animation of the sprite. The "set hitbox once" button. */
  applyColliderToAllAnims: (spriteId: string, sourceAnimId: string, sourceFrameId: string) => void;
  /** Apply multiple frame patches in one store update — produces a single
   *  undo entry for the whole batch (avoids each frame creating its own
   *  snapshot during slow async operations like cropping). */
  bulkUpdateSpriteFrames: (spriteId: string, animId: string, patches: Array<{ id: string; patch: Partial<SpriteFrame> }>) => void;
  /** Same as bulkUpdateSpriteFrames but patches frames (by id) across EVERY
   *  animation of the sprite in one atomic step — used by flip / crop / resize
   *  with the "All animations" scope. Frame ids are globally unique. */
  bulkUpdateSpriteFramesAllAnims: (spriteId: string, patches: Array<{ id: string; patch: Partial<SpriteFrame> }>) => void;
  reorderSpriteFrame: (spriteId: string, animId: string, fromIdx: number, toIdx: number) => void;
  updateSpriteFramePivot: (spriteId: string, animId: string, frameId: string, pivotX: number, pivotY: number) => void;
  setFramePivotToAll: (spriteId: string, animId: string, frameId: string) => void;
  /** Copy a frame's pivot to every frame in EVERY animation of the sprite. */
  setFramePivotToAllAnims: (spriteId: string, animId: string, frameId: string) => void;
  addSpriteImagePoint: (spriteId: string, animId: string, frameId: string, name?: string, x?: number, y?: number) => string;
  updateSpriteImagePoint: (spriteId: string, animId: string, frameId: string, pointId: string, patch: { name?: string; x?: number; y?: number }) => void;
  removeSpriteImagePoint: (spriteId: string, animId: string, frameId: string, pointId: string) => void;
  setImagePointToAll: (spriteId: string, animId: string, frameId: string, pointId: string) => void;
  /** Copy an image point to every frame in EVERY animation of the sprite. */
  setImagePointToAllAnims: (spriteId: string, animId: string, frameId: string, pointId: string) => void;

  // ---- scene CRUD ----
  addScene: (path?: string) => string;
  renameScene: (sceneId: string, name: string) => void;
  removeScene: (sceneId: string) => void;
  setActiveScene: (sceneId: string) => void;
  /** Per-scene world / layout size (the area the camera can scroll over). */
  setSceneSize: (sceneId: string, width: number, height: number) => void;
  /** Per-scene background fill (hex 0xRRGGBB). */
  setSceneBackground: (sceneId: string, color: number) => void;
  /** Per-scene gravity (px/s²) — applied to Phaser's arcade physics world. */
  setSceneGravity: (sceneId: string, gravity: number) => void;
  /** Per-scene unbounded-scroll flag — Construct-style, lets the camera
   *  scroll past layout edges when true. */
  setSceneUnboundedScroll: (sceneId: string, unbounded: boolean) => void;
  /** Project-wide game-window (viewport) size — what the camera renders. */
  setViewportSize: (width: number, height: number) => void;
  /** Set the global texture sampling (nearest / bilinear / trilinear). */
  setSampling: (sampling: ProjectSampling) => void;
  setCullDistanceMultiplier: (multiplier: number) => void;
  setSpawnBudgetPerFrame: (budget: number) => void;
  setLoadingSceneId: (id: string) => void;
  setOpenLogicFolderForOwner: (ownerId: string, folderId: string | null) => void;
  /** Rename the project (shown in the top bar, used as the save filename). */
  setProjectName: (name: string) => void;

  // ---- layers (per-scene) ----
  addLayer: (sceneId: string, name?: string) => string;
  removeLayer: (sceneId: string, layerId: string) => void;
  renameLayer: (sceneId: string, layerId: string, name: string) => void;
  setLayerParallax: (sceneId: string, layerId: string, x: number, y: number) => void;
  setLayerVisible: (sceneId: string, layerId: string, visible: boolean) => void;
  setLayerOpacity: (sceneId: string, layerId: string, opacity: number) => void;
  setLayerGlobal: (sceneId: string, layerId: string, global: boolean) => void;
  setLayerYSort: (sceneId: string, layerId: string, ySort: boolean) => void;
  setLayerLocked: (sceneId: string, layerId: string, locked: boolean) => void;
  setInstanceLocked: (id: string, locked: boolean) => void;
  reorderLayer: (sceneId: string, layerId: string, newIndex: number) => void;
  setActiveLayer: (sceneId: string, layerId: string) => void;
  setInstanceLayer: (sceneId: string, instanceId: string, layerId: string) => void;

  // ---- dialogue assets ----
  addDialogue: (path?: string) => string;
  renameDialogue: (id: string, name: string) => void;
  setDialoguePath: (id: string, path: string) => void;
  removeDialogue: (id: string) => void;
  /** Replace ALL lines (used by upload flow). Pass un-id'd lines/choices —
   *  store stamps fresh ids. */
  setDialogueLines: (id: string, lines: ParsedDialogueLine[]) => void;
  setDialogueLine: (id: string, lineId: string, patch: Partial<DialogueLine>) => void;
  addDialogueLine: (id: string, afterLineId?: string) => string;
  removeDialogueLine: (id: string, lineId: string) => void;
  reorderDialogueLine: (id: string, fromIdx: number, toIdx: number) => void;
  addDialogueChoice: (id: string, lineId: string) => string;
  setDialogueChoice: (id: string, lineId: string, choiceId: string, patch: Partial<DialogueChoice>) => void;
  removeDialogueChoice: (id: string, lineId: string, choiceId: string) => void;
  setDialogueSpeakerMap: (id: string, map: Record<string, string>) => void;
  /** Set per-speaker overhead bubble offset on a dialogue. Pass `null` to
   *  clear (returns to asset-wide style.overheadOffsetX/Y default). */
  setDialogueSpeakerOffset: (id: string, label: string, offset: { x: number; y: number } | null) => void;
  setDialogueOverrides: (id: string, patch: Partial<Pick<DialogueAsset, "displayMode" | "advanceAction" | "autoAdvanceSec" | "typewriterCps" | "playerSpeakerBpId" | "freezePlayerDuringDialog" | "freezeNpcsDuringDialog">>) => void;

  // ---- sound assets ----
  /** Create a sound asset from an imported audio data URL. `kind` defaults
   *  to "sfx"; pass "music" for looping background tracks. Returns new id. */
  addSound: (init: { name?: string; path?: string; file: string; kind?: "music" | "sfx" }) => string;
  renameSound: (id: string, name: string) => void;
  setSoundPath: (id: string, path: string) => void;
  removeSound: (id: string) => void;
  setSoundKind: (id: string, kind: "music" | "sfx") => void;
  setSoundVolume: (id: string, volume: number) => void;
  setSoundLoop: (id: string, loop: boolean) => void;
  setSoundMaxInstances: (id: string, n: number) => void;
  setSoundMinInterval: (id: string, ms: number) => void;

  // ---- custom fonts ----
  /** Register an uploaded font file. `name` becomes the font-family; it's
   *  de-duped against existing fonts. Returns the new id. */
  addFont: (init: { name: string; file: string }) => string;
  renameFont: (id: string, name: string) => void;
  removeFont: (id: string) => void;

  // ---- items (inventory item assets) ----
  /** Create an inventory item asset. Returns new id. */
  addItem: (init?: { name?: string; path?: string; spriteId?: string }) => string;
  renameItem: (id: string, name: string) => void;
  setItemPath: (id: string, path: string) => void;
  removeItem: (id: string) => void;
  setItemIcon: (id: string, spriteId: string) => void;
  setItemIconAnim: (id: string, animId: string) => void;
  setItemIconFrame: (id: string, frame: number) => void;
  setItemMaxStack: (id: string, maxStack: number) => void;
  setItemTags: (id: string, tags: string[]) => void;
  setItemProps: (id: string, props: import("./project").ItemProp[]) => void;
  setItemCountGlobal: (id: string, countGlobal: string) => void;
  setItemBuyPrice: (id: string, price: number) => void;
  setItemSellPrice: (id: string, price: number) => void;
  setItemPickupBp: (id: string, pickupBp: string) => void;

  // ---- recipes ----
  addRecipe: (init?: { name?: string; path?: string }) => string;
  renameRecipe: (id: string, name: string) => void;
  setRecipePath: (id: string, path: string) => void;
  setTilesetPath: (id: string, path: string) => void;
  setTilemapPath: (id: string, path: string) => void;
  removeRecipe: (id: string) => void;
  setRecipeInputs: (id: string, inputs: import("./project").RecipeInput[]) => void;
  setRecipeOutput: (id: string, item: string, qty: number) => void;
  setRecipeEnabled: (id: string, enabled: boolean) => void;

  // ---- dialog flow ----
  /** Add a chapter to the dialog flow. Initializes dialogFlow if missing. */
  addDialogFlowChapter: (name?: string) => string;
  renameDialogFlowChapter: (id: string, name: string) => void;
  removeDialogFlowChapter: (id: string) => void;
  reorderDialogFlowChapter: (id: string, toIdx: number) => void;
  /** Add a trigger. Returns the new id. */
  addDialogFlowTrigger: (chapterId: string) => string;
  updateDialogFlowTrigger: (id: string, patch: Partial<import("./project").DialogFlowTrigger>) => void;
  removeDialogFlowTrigger: (id: string) => void;
  /** Add an empty condition row to a trigger. */
  addDialogFlowCondition: (triggerId: string) => string;
  updateDialogFlowCondition: (triggerId: string, condId: string, patch: Partial<import("./project").DialogFlowCondition>) => void;
  removeDialogFlowCondition: (triggerId: string, condId: string) => void;
  /** Add a BP to the explicit row list (no-op if already present). */
  addDialogFlowRow: (bpId: string) => void;
  /** Remove a BP from the explicit row list. Triggers still rendered if
   *  the BP has them — row will reappear via the trigger-derived fallback. */
  removeDialogFlowRow: (bpId: string) => void;

  // ---- UI widget assets ----
  /** Create a new UIWidget of the given kind in the given folder
   *  (defaults to "/UI" / Panel). Opens it in a new editor tab and
   *  returns its id. */
  addUIWidget: (path?: string, kind?: UIWidgetKind) => string;
  renameUIWidget: (id: string, name: string) => void;
  setUIWidgetPath: (id: string, path: string) => void;
  removeUIWidget: (id: string) => void;
  openUIWidgetTab: (id: string) => void;
  closeUIWidgetTab: (id: string) => void;
  /** Patch any field on a widget (size, kind, colors, text, etc.). */
  updateUIWidget: (id: string, patch: Partial<UIWidgetDef>) => void;
  /** Switch a widget's kind, preserving common style fields and
   *  resetting type-specific fields to sensible defaults for the new
   *  kind (so Panel→Button gets a click handler, Button→Slider gets
   *  min/max, etc.). */
  setUIWidgetKind: (id: string, kind: UIWidgetKind) => void;
  /** Toggle a widget between single / multi mode. */
  setUIWidgetMode: (id: string, mode: "single" | "multi") => void;
  /** Add a child to a multi-mode widget. Seeded with kind defaults +
   *  the given (x, y) inside the parent viewport. Returns child id. */
  addUIWidgetChild: (widgetId: string, kind: UIWidgetKind, x?: number, y?: number) => string;
  /** Patch any field on a child. */
  updateUIWidgetChild: (widgetId: string, childId: string, patch: Partial<UIWidgetChild>) => void;
  /** Remove a child by id. */
  removeUIWidgetChild: (widgetId: string, childId: string) => void;
  /** Switch a child's kind, layering kind defaults on top. */
  setUIWidgetChildKind: (widgetId: string, childId: string, kind: UIWidgetKind) => void;
  /** Move a child to a new index. Drives z-order — earlier indices draw
   *  first (behind later siblings). `to: 0` is "send to back", `to:
   *  children.length-1` is "bring to front". `to` is clamped. */
  reorderUIWidgetChild: (widgetId: string, childId: string, to: number) => void;
  /** Spawn a UI Widget instance into the active scene. Picks the active
   *  layer; if it's not parallax-(0,0) the instance still works, but
   *  Anchor's screen-space math will drift with camera scroll. */
  placeUIWidgetInstance: (uiWidgetId: string, x?: number, y?: number) => string;
  updateUIWidgetInstance: (id: string, patch: Partial<{ x: number; y: number; w: number; h: number; layerId: string; name: string; parentInstanceId: string }>) => void;
  removeUIWidgetInstance: (id: string) => void;
  setProjectDialogueDefaults: (patch: Partial<DialogueDefaults>) => void;

  // ---- dialog box (9-slice) CRUD ----
  addDialogBox: (init: { name?: string; dataUrl: string; sliceLeft?: number; sliceRight?: number; sliceTop?: number; sliceBottom?: number }) => string;
  updateDialogBox: (id: string, patch: Partial<{ name: string; dataUrl: string; sliceLeft: number; sliceRight: number; sliceTop: number; sliceBottom: number }>) => void;
  removeDialogBox: (id: string) => void;

  // ---- blueprint CRUD ----
  addBlueprint: (partial?: Partial<BlueprintDef>) => string;
  updateBlueprint: (id: string, patch: Partial<BlueprintDef>) => void;
  removeBlueprint: (id: string) => void;
  /** Deep-clone a blueprint into a new independent BP with a unique name
   *  and fresh internal ids. Returns the new BP id (or "" if the source
   *  wasn't found). Selects the clone. */
  duplicateBlueprint: (id: string) => string;
  /** Deep-clone any Content Browser asset (blueprint / scene / sprite /
   *  dialogue / uiwidget) into a new independent copy with a unique name.
   *  Returns the new asset id (or "" if not found / unknown kind). */
  duplicateAsset: (kind: "blueprint" | "scene" | "sprite" | "dialogue" | "uiwidget" | "sound" | "item" | "recipe" | "tileset" | "tilemap", id: string) => string;

  // ---- main logic sheets (project-level, multi) ----
  addMainLogicSheet: (name?: string) => string;
  renameMainLogicSheet: (id: string, name: string) => void;
  removeMainLogicSheet: (id: string) => void;
  setMainLogicSheetEnabled: (id: string, enabled: boolean) => void;
  /** Overwrite a Main Logic Sheet's graph contents. Used by the
   *  LogicSheetModal's `onCommitSheet` callback. */
  setMainLogicSheetGraph: (id: string, sheet: import("./project").LogicSheet) => void;
  addBlueprintBehavior: (bpId: string, kind: BehaviorKind) => void;
  /** Clone an existing behavior on the BP. Only valid for multi-instance
   *  kinds (Tracer, Text) — for single-instance behaviors logs a warning
   *  and no-ops. The clone copies the full config and auto-renames the
   *  `name` field to the next unused suffix so it's instantly addressable. */
  duplicateBlueprintBehavior: (bpId: string, index: number) => void;
  updateBlueprintBehavior: (bpId: string, index: number, config: Record<string, unknown>) => void;
  removeBlueprintBehavior: (bpId: string, index: number) => void;
  reorderBlueprintBehavior: (bpId: string, fromIndex: number, toIndex: number) => void;
  toggleBlueprintBehaviorEnabled: (bpId: string, index: number) => void;

  // ---- blueprint LOD groups (per-component distance-based enable/disable) ----
  addLODGroup: (bpId: string) => string;
  updateLODGroup: (bpId: string, groupId: string, patch: Partial<LODGroup>) => void;
  removeLODGroup: (bpId: string, groupId: string) => void;
  toggleLODGroupComponent: (bpId: string, groupId: string, componentKind: string) => void;

  // ---- blueprint variables ----
  addVariable: (bpId: string, name?: string) => string;
  renameVariable: (bpId: string, varId: string, name: string) => void;
  setVariableDefault: (bpId: string, varId: string, value: number | string | boolean) => void;
  setVariableType: (bpId: string, varId: string, type: "number" | "string" | "bool") => void;
  setVariableAutoCap: (bpId: string, varId: string, cap: [number, number] | undefined) => void;
  setVariableInstanceEditable: (bpId: string, varId: string, editable: boolean) => void;
  setVariableExposeOnSpawn: (bpId: string, varId: string, expose: boolean) => void;
  setVariableGlobal: (bpId: string, varId: string, global: boolean) => void;
  setVariableNumberKind: (bpId: string, varId: string, kind: "integer" | "float") => void;
  removeVariable: (bpId: string, varId: string) => void;

  // ---- input actions ----
  addInputAction: (name?: string, group?: string) => string;
  renameInputAction: (id: string, name: string) => void;
  setInputActionKeys: (id: string, keys: string[]) => void;
  removeInputAction: (id: string) => void;
  // ---- input action groups + reorder (drag-drop) ----
  addInputActionGroup: (name?: string) => void;
  renameInputActionGroup: (oldName: string, newName: string) => void;
  removeInputActionGroup: (name: string) => void;
  /** Move an action into `group` ("" = ungrouped), positioned before
   *  `beforeId` (or at the end of that group's run when null). Single op
   *  powering both reordering and drop-into / drop-out-of a group. */
  moveInputAction: (id: string, group: string, beforeId?: string | null) => void;

  // ---- signals ----
  addSignal: (name?: string) => string;
  renameSignal: (id: string, name: string) => void;
  removeSignal: (id: string) => void;

  // ---- global variables ----
  addGlobalVariable: (name?: string) => string;
  renameGlobalVariable: (id: string, name: string) => void;
  setGlobalVariableType: (id: string, type: "number" | "float" | "string" | "boolean") => void;
  setGlobalVariableDefault: (id: string, value: number | string | boolean) => void;
  setGlobalVariableIsArray: (id: string, isArray: boolean) => void;
  setGlobalVariableItems: (id: string, items: (number | string | boolean)[]) => void;
  removeGlobalVariable: (id: string) => void;

  // ---- read-only lists (named groups of key/value entries) ----
  addList: (name?: string) => string;
  renameList: (id: string, name: string) => void;
  setListType: (id: string, type: "number" | "float" | "string" | "boolean") => void;
  addListEntry: (listId: string) => void;
  renameListEntry: (listId: string, entryId: string, name: string) => void;
  /** Per-entry type override. Pass `undefined` to clear it (entry follows the
   *  list's default type again). Coerces the entry's value to the new type. */
  setListEntryType: (listId: string, entryId: string, type: "number" | "float" | "string" | "boolean" | undefined) => void;
  setListEntryValue: (listId: string, entryId: string, value: number | string | boolean) => void;
  removeListEntry: (listId: string, entryId: string) => void;
  removeList: (id: string) => void;

  // ---- instance CRUD ----
  placeInstance: (blueprintId: string, x?: number, y?: number) => string;
  updateInstance: (id: string, patch: Partial<BlueprintInstance>) => void;
  /** Drop a sprite asset into the active scene at world position (x, y).
   *  Picks the scene's activeLayerId. Returns the new placement's id so the
   *  caller can immediately select it. */
  addSpritePlacement: (spriteId: string, x: number, y: number) => string;
  updateSpritePlacement: (id: string, patch: Partial<SpritePlacement>) => void;
  removeSpritePlacement: (id: string) => void;
  /** Set ONE per-instance variable starting value. The variable must
   *  exist on the BP and be flagged `instanceEditable: true` (this isn't
   *  enforced at the store level — the inspector is responsible for only
   *  showing editable vars). Stored on `instance.vars[name]`. */
  setInstanceVar: (id: string, name: string, value: number | string | boolean) => void;
  /** Clear an instance-level override so the BP default applies again. */
  clearInstanceVar: (id: string, name: string) => void;
  removeInstance: (id: string) => void;
  /** Clone the given scene items (BP instances, sprite placements, UI widgets,
   *  tilemaps) with fresh ids, offset by (dx, dy). Returns the new ids so the
   *  caller can re-select the copies. Powers Ctrl+D / Ctrl+V in the scene. */
  duplicateSelection: (ids: string[], dx?: number, dy?: number) => string[];

  // ---- run ----
  setRunning: (v: boolean) => void;
  loadProject: (p: PeakyProject) => void;
  setAutosaveStatus: (v: "ok" | "broken", info?: { error?: string | null; guard?: boolean }) => void;
  /** Scan the on-disk `assets/` tree and remove every file/folder the
   *  manifest doesn't reference. Returns the count + list of removed paths
   *  so callers can show a summary. No-op when no AssetStore is active. */
  cleanupOrphans: () => Promise<{ removedCount: number; removedPaths: string[] }>;
}

let _skipSnap = false;
// Trailing-edge debounce: schedule a snapshot N ms after the last
// change. If more changes arrive during the wait, cancel and reschedule.
// Net effect: typing a 12-char name takes ONE snapshot at end-of-burst,
// capturing the original prevState before the first keystroke. Old
// leading-edge coalesce dropped intermediate state silently.
let _snapTimer: ReturnType<typeof setTimeout> | undefined;
let _burstPrevProject: PeakyProject | null = null;
const SNAP_DEBOUNCE_MS = 250;

// Commit any pending (debounced) snapshot immediately. undo/redo MUST call
// this first: pressing Ctrl+Z within the debounce window would otherwise
// revert against a change not yet recorded, then the late timer would push a
// stale snapshot and wipe the redo stack. Flushing keeps history consistent.
function _flushPendingSnap(): void {
  if (_snapTimer === undefined) return;
  clearTimeout(_snapTimer);
  _snapTimer = undefined;
  const captured = _burstPrevProject;
  _burstPrevProject = null;
  if (captured === null) return;
  _skipSnap = true;
  useEditor.setState({
    past: [...useEditor.getState().past.slice(-49), captured],
    future: [],
  });
  _skipSnap = false;
}

/** Prune open-tab ids + activeTab against a project. undo/redo swap the whole
 *  `project` but NOT the view-state (open tabs / active tab live outside the
 *  undo history), so after undoing a "create sprite" the Sprite tab still
 *  points at a sprite no longer in `project.sprites` — SpriteTab then renders
 *  an undefined asset and the React tree crashes to a white screen. Dropping
 *  stale ids here closes the phantom tab instead. Covers every asset-tab kind. */
function _pruneViewToProject(
  p: PeakyProject,
  s: Pick<EditorState, "openSceneIds" | "openBlueprintIds" | "openSpriteIds" | "openDialogueIds" | "openUIWidgetIds" | "openTilesetIds" | "openTilemapIds" | "activeTab">,
) {
  const ids = {
    scene: new Set(p.scenes.map((x) => x.id)),
    blueprint: new Set(p.blueprints.map((x) => x.id)),
    sprite: new Set(p.sprites.map((x) => x.id)),
    dialogue: new Set(p.dialogues.map((x) => x.id)),
    uiwidget: new Set(p.uiWidgets.map((x) => x.id)),
    tileset: new Set((p.tilesets ?? []).map((x) => x.id)),
    tilemap: new Set((p.tilemaps ?? []).map((x) => x.id)),
  };
  let activeTab = s.activeTab;
  if ("id" in activeTab) {
    const set = ids[activeTab.kind as keyof typeof ids];
    if (set && !set.has(activeTab.id)) activeTab = { kind: "scene" };
  }
  return {
    openSceneIds: s.openSceneIds.filter((id) => ids.scene.has(id)),
    openBlueprintIds: s.openBlueprintIds.filter((id) => ids.blueprint.has(id)),
    openSpriteIds: s.openSpriteIds.filter((id) => ids.sprite.has(id)),
    openDialogueIds: s.openDialogueIds.filter((id) => ids.dialogue.has(id)),
    openUIWidgetIds: s.openUIWidgetIds.filter((id) => ids.uiwidget.has(id)),
    openTilesetIds: s.openTilesetIds.filter((id) => ids.tileset.has(id)),
    openTilemapIds: s.openTilemapIds.filter((id) => ids.tilemap.has(id)),
    activeTab,
  };
}

const _initialProject = emptyProject();

/** Coerce a list value to a type. Shared by setListType (re-coerce default-typed
 *  entries) and setListEntryType (re-coerce one entry to its override). */
function coerceListValue(
  cur: number | string | boolean,
  type: "number" | "float" | "string" | "boolean",
): number | string | boolean {
  if (type === "number") return Math.round(Number(cur)) || 0;
  if (type === "float") return Number(cur) || 0;
  if (type === "boolean") return cur === true || cur === "true" || cur === 1;
  return String(cur);
}

export const useEditor = create<EditorState>((set, get) => ({
  project: _initialProject,
  view: "scene",
  openSceneIds: [_initialProject.activeSceneId],
  openBlueprintIds: [],
  openSpriteIds: [],
  openDialogueIds: [],
  openLogicFolderByOwner: {},
  openUIWidgetIds: [],
  openTilesetIds: [],
  openTilemapIds: [],
  tilemapPaintMode: false,
  animatorPreview: null,
  activeTab: { kind: "scene" },
  sceneSubTab: ((): "scene" | "main" => {
    try { return localStorage.getItem("peaky.scene-subtab") === "main" ? "main" : "scene"; }
    catch { return "scene"; }
  })(),
  dockTab: ((): "content" | "console" => {
    try { return localStorage.getItem("peaky.dock-tab") === "console" ? "console" : "content"; }
    catch { return "content"; }
  })(),
  dockCollapsed: ((): boolean => {
    try { return localStorage.getItem("peaky.dock-collapsed") === "1"; } catch { return false; }
  })(),
  selectedInstanceId: null,
  multiSelected: new Set<string>(),
  selectedBlueprintId: null,
  isRunning: false,
  autosaveStatus: "ok",
  autosaveError: null,
  autosaveGuard: false,
  past: [],
  future: [],
  historyTick: 0,

  undo: () => {
    _flushPendingSnap();
    const { past, project, future, historyTick } = get();
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    _skipSnap = true;
    set({ past: past.slice(0, -1), project: prev, future: [project, ...future.slice(0, 49)], historyTick: historyTick + 1, ..._pruneViewToProject(prev, get()) });
    _skipSnap = false;
  },

  redo: () => {
    _flushPendingSnap();
    const { past, project, future, historyTick } = get();
    if (future.length === 0) return;
    const next = future[0];
    _skipSnap = true;
    set({ past: [...past.slice(-49), project], project: next, future: future.slice(1), historyTick: historyTick + 1, ..._pruneViewToProject(next, get()) });
    _skipSnap = false;
  },

  activeScene: () => {
    const { project } = get();
    const s = project.scenes.find((x) => x.id === project.activeSceneId);
    // Defensive fallback — if activeSceneId got out of sync with the scene
    // list (legacy save corruption, race during load), return the first
    // scene rather than crashing the whole React tree.
    return s ?? project.scenes[0];
  },

  selectedInstance: () => {
    const { selectedInstanceId } = get();
    if (!selectedInstanceId) return null;
    return get().activeScene().instances.find((i) => i.id === selectedInstanceId) ?? null;
  },

  selectedUIInstance: () => {
    const { selectedInstanceId } = get();
    if (!selectedInstanceId) return null;
    return (get().activeScene().uiInstances ?? []).find((i) => i.id === selectedInstanceId) ?? null;
  },

  selectedTilemapInstance: () => {
    const { selectedInstanceId } = get();
    if (!selectedInstanceId) return null;
    return (get().activeScene().tilemapInstances ?? []).find((i) => i.id === selectedInstanceId) ?? null;
  },

  selectedSpritePlacement: () => {
    const { selectedInstanceId } = get();
    if (!selectedInstanceId) return null;
    return (get().activeScene().spritePlacements ?? []).find((p) => p.id === selectedInstanceId) ?? null;
  },

  selectedBlueprint: () => {
    const { selectedBlueprintId, project } = get();
    if (!selectedBlueprintId) return null;
    return project.blueprints.find((b) => b.id === selectedBlueprintId) ?? null;
  },

  blueprintFor: (instance) => findBlueprint(get().project, instance.blueprintId),

  setView: (view) => set({ view }),
  selectInstance: (id) => set((state) => ({
    selectedInstanceId: id,
    // Plain select replaces multi-select unless the new id was already in
    // the set (Outliner row "Add to selection" via Shift+click takes the
    // toggleMultiSelected path). Empty set when only one or zero are selected.
    multiSelected: state.multiSelected.has(id ?? "") ? state.multiSelected : new Set<string>(),
  })),

  setMultiSelected: (ids) => set({ multiSelected: ids }),
  toggleMultiSelected: (id) => set((state) => {
    const next = new Set(state.multiSelected);
    // Seed the set with the current primary so toggling on a SECOND id grows
    // the group rather than starting from just-the-new-id (matches the scene
    // canvas behavior the user already learned).
    if (state.selectedInstanceId && state.selectedInstanceId !== id) next.add(state.selectedInstanceId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { multiSelected: next, selectedInstanceId: id };
  }),
  selectBlueprint: (id) => set({ selectedBlueprintId: id }),

  openSceneTab: (sceneId) =>
    set((state) => {
      const exists = state.project.scenes.some((s) => s.id === sceneId);
      if (!exists) return state;
      const ids = state.openSceneIds.includes(sceneId)
        ? state.openSceneIds
        : [...state.openSceneIds, sceneId];
      return {
        openSceneIds: ids,
        project: { ...state.project, activeSceneId: sceneId },
        activeTab: { kind: "scene" },
        selectedInstanceId: null,
      };
    }),

  // Always leave at least one scene tab open — Scene is the workspace's
  // permanent anchor. Closing the last open scene is a no-op.
  closeSceneTab: (sceneId) =>
    set((state) => {
      // Filter to ids that actually exist in the project; openSceneIds can
      // hold stale ids if a project was loaded over the initial state.
      const validOpen = state.openSceneIds.filter(
        (id) => state.project.scenes.some((s) => s.id === id),
      );
      if (validOpen.length <= 1 && validOpen.includes(sceneId) === false) return state;
      const ids = validOpen.filter((x) => x !== sceneId);
      // If we'd be left with nothing, keep at least one (the first scene).
      if (ids.length === 0) return state;
      const wasActiveScene = state.project.activeSceneId === sceneId;
      const nextActiveSceneId = wasActiveScene ? ids[0] : state.project.activeSceneId;
      return {
        openSceneIds: ids,
        project: { ...state.project, activeSceneId: nextActiveSceneId },
        selectedInstanceId: wasActiveScene ? null : state.selectedInstanceId,
      };
    }),

  openBlueprintTab: (bpId) =>
    set((state) => {
      const exists = state.project.blueprints.some((b) => b.id === bpId);
      if (!exists) return state;
      const ids = state.openBlueprintIds.includes(bpId)
        ? state.openBlueprintIds
        : [...state.openBlueprintIds, bpId];
      return {
        openBlueprintIds: ids,
        activeTab: { kind: "blueprint", id: bpId },
        selectedBlueprintId: bpId,
      };
    }),

  closeBlueprintTab: (bpId) =>
    set((state) => {
      const ids = state.openBlueprintIds.filter((x) => x !== bpId);
      const wasActive = state.activeTab.kind === "blueprint" && state.activeTab.id === bpId;
      return { openBlueprintIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  openSpriteTab: (spriteId) =>
    set((state) => {
      const exists = state.project.sprites.some((s) => s.id === spriteId);
      if (!exists) return state;
      const ids = state.openSpriteIds.includes(spriteId)
        ? state.openSpriteIds
        : [...state.openSpriteIds, spriteId];
      return { openSpriteIds: ids, activeTab: { kind: "sprite", id: spriteId } };
    }),

  closeSpriteTab: (spriteId) =>
    set((state) => {
      const ids = state.openSpriteIds.filter((x) => x !== spriteId);
      const wasActive = state.activeTab.kind === "sprite" && state.activeTab.id === spriteId;
      return { openSpriteIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  openTilesetTab: (id) =>
    set((state) => {
      const exists = (state.project.tilesets ?? []).some((t) => t.id === id);
      if (!exists) return state;
      const ids = state.openTilesetIds.includes(id) ? state.openTilesetIds : [...state.openTilesetIds, id];
      return { openTilesetIds: ids, activeTab: { kind: "tileset", id } };
    }),

  closeTilesetTab: (id) =>
    set((state) => {
      const ids = state.openTilesetIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "tileset" && state.activeTab.id === id;
      return { openTilesetIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  openTilemapTab: (id) =>
    set((state) => {
      const exists = (state.project.tilemaps ?? []).some((t) => t.id === id);
      if (!exists) return state;
      const ids = state.openTilemapIds.includes(id) ? state.openTilemapIds : [...state.openTilemapIds, id];
      return { openTilemapIds: ids, activeTab: { kind: "tilemap", id } };
    }),

  closeTilemapTab: (id) =>
    set((state) => {
      const ids = state.openTilemapIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "tilemap" && state.activeTab.id === id;
      return { openTilemapIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  setTilemapPaintMode: (v) => set(() => ({ tilemapPaintMode: v })),
  setAnimatorPreview: (p) => set(() => ({ animatorPreview: p })),

  openDialogueTab: (dialogueId) =>
    set((state) => {
      const exists = state.project.dialogues.some((d) => d.id === dialogueId);
      if (!exists) return state;
      const ids = state.openDialogueIds.includes(dialogueId)
        ? state.openDialogueIds
        : [...state.openDialogueIds, dialogueId];
      return { openDialogueIds: ids, activeTab: { kind: "dialogue", id: dialogueId } };
    }),

  openDialogFlowTab: () => set(() => ({ activeTab: { kind: "dialogflow" } })),

  closeDialogueTab: (dialogueId) =>
    set((state) => {
      const ids = state.openDialogueIds.filter((x) => x !== dialogueId);
      const wasActive = state.activeTab.kind === "dialogue" && state.activeTab.id === dialogueId;
      return { openDialogueIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  openUIWidgetTab: (id) =>
    set((state) => {
      const exists = state.project.uiWidgets.some((w) => w.id === id);
      if (!exists) return state;
      const ids = state.openUIWidgetIds.includes(id)
        ? state.openUIWidgetIds
        : [...state.openUIWidgetIds, id];
      return { openUIWidgetIds: ids, activeTab: { kind: "uiwidget", id } };
    }),

  closeUIWidgetTab: (id) =>
    set((state) => {
      const ids = state.openUIWidgetIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "uiwidget" && state.activeTab.id === id;
      return { openUIWidgetIds: ids, activeTab: wasActive ? { kind: "scene" } : state.activeTab };
    }),

  setActiveTab: (tab) =>
    set((state) => {
      if (tab.kind === "blueprint" && !state.openBlueprintIds.includes(tab.id)) return state;
      if (tab.kind === "sprite" && !state.openSpriteIds.includes(tab.id)) return state;
      if (tab.kind === "dialogue" && !state.openDialogueIds.includes(tab.id)) return state;
      if (tab.kind === "uiwidget" && !state.openUIWidgetIds.includes(tab.id)) return state;
      return { activeTab: tab };
    }),

  setSceneSubTab: (t) => {
    try { localStorage.setItem("peaky.scene-subtab", t); } catch { /* private mode */ }
    set({ sceneSubTab: t });
  },

  setDockTab: (t) => {
    try { localStorage.setItem("peaky.dock-tab", t); } catch { /* private mode */ }
    set({ dockTab: t });
  },

  setDockCollapsed: (v) => {
    try { localStorage.setItem("peaky.dock-collapsed", v ? "1" : "0"); } catch { /* private mode */ }
    set({ dockCollapsed: v });
  },

  addBlueprint: (partial = {}) => {
    const id = newId("bp");
    // "World" is reserved — it's the blueprintName of the synthetic
    // main-sheet host, used by `var:World.<field>` cross-BP lookups. A
    // user-named "World" BP would shadow the globals and break any
    // expression that relied on them. Reject up front with a console
    // warning + auto-rename to "World 2".
    let proposedName = partial.name ?? `Blueprint_${get().project.blueprints.length + 1}`;
    if (proposedName === "World") {
      console.warn('[Peaky] "World" is a reserved blueprint name (used for Main Sheet globals). Renamed to "World_2".');
      proposedName = "World_2";
    }
    proposedName = sanitizeAssetName(proposedName, "Blueprint");
    // Spread `partial` first so class-template / caller fields that aren't in
    // the explicit list below (affectedByGravity, logicSheet, cullMode,
    // poolSize, noPhysicsBody, hideRect, …) actually land instead of being
    // silently dropped. The explicit keys then override with sanitized /
    // defaulted values, and `id` overrides any stray id on the partial.
    const bp: BlueprintDef = {
      ...partial,
      id,
      name: proposedName,
      classKind: partial.classKind ?? "Actor",
      tags: partial.tags ?? [],
      w: partial.w ?? 32,
      h: partial.h ?? 32,
      color: partial.color ?? 0xff8844,
      behaviors: partial.behaviors ?? [],
      variables: partial.variables ?? [],
      events: partial.events ?? [],
      eventGroups: partial.eventGroups ?? [],
      // Each BP gets a unique first-page id so cross-BP event paste / move
      // can't ever land an event on the "wrong" page just because two BPs
      // happened to share a literal id like "p_main".
      eventPages: partial.eventPages ?? [{ id: newId("page"), name: "Page 1" }],
      path: partial.path ?? "/Blueprints",
    };
    set((state) => ({
      project: { ...state.project, blueprints: [...state.project.blueprints, bp] },
      selectedBlueprintId: id,
      view: "blueprint",
    }));
    return id;
  },

  updateBlueprint: (id, patch) =>
    set((state) => {
      // Sanitize blueprint names to UE5 conventions — `[A-Za-z_][A-Za-z0-9_]*`.
      // Drives expression-parser safety (`var:Player.hp` parses cleanly only
      // when "Player" is a single identifier token). Applied at every write
      // so the project state never holds a name with spaces.
      const cleanedPatch = patch.name !== undefined
        ? { ...patch, name: sanitizeAssetName(patch.name, "Blueprint") }
        : patch;
      if (cleanedPatch.name === "World") {
        console.warn('[Peaky] Heads up: "World" is the Main Sheet globals host name. A user BP named "World" will shadow var:World.<x> lookups. Consider renaming.');
      }
      return {
        project: {
          ...state.project,
          blueprints: state.project.blueprints.map((b) => (b.id === id ? { ...b, ...cleanedPatch } : b)),
        },
      };
    }),

  removeBlueprint: (id) =>
    set((state) => {
      const scenes = state.project.scenes.map((sc) => ({
        ...sc,
        instances: sc.instances.filter((i) => i.blueprintId !== id),
      }));
      // Cascade through dialogue assets: drop any speakerMap entries that
      // pointed at this BP. Without this, deleting a BP would leave dialogue
      // lines silently routing to a phantom id at runtime.
      const dialogues = state.project.dialogues.map((d) => {
        const map = d.speakerMap ?? {};
        let touched = false;
        const cleaned: Record<string, string> = {};
        for (const k of Object.keys(map)) {
          if (map[k] === id) {
            touched = true;
            continue;
          }
          cleaned[k] = map[k];
        }
        return touched ? { ...d, speakerMap: cleaned } : d;
      });
      let dialogueDefaults = state.project.dialogueDefaults;
      if (dialogueDefaults.narratorBpId === id) {
        dialogueDefaults = { ...dialogueDefaults, narratorBpId: "" };
      }
      if (dialogueDefaults.playerSpeakerBpId === id) {
        dialogueDefaults = { ...dialogueDefaults, playerSpeakerBpId: "" };
      }
      // Same for per-asset overrides — clear playerSpeakerBpId entries
      // that pointed at this BP.
      const dialoguesAfterBp = dialogues.map((d) => {
        if (d.playerSpeakerBpId !== id) return d;
        const { playerSpeakerBpId: _drop, ...rest } = d;
        void _drop;
        return rest;
      });
      const ids = state.openBlueprintIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "blueprint" && state.activeTab.id === id;
      return {
        project: {
          ...state.project,
          blueprints: state.project.blueprints.filter((b) => b.id !== id),
          scenes,
          dialogues: dialoguesAfterBp,
          dialogueDefaults,
        },
        selectedBlueprintId: state.selectedBlueprintId === id ? null : state.selectedBlueprintId,
        openBlueprintIds: ids,
        activeTab: wasActive ? { kind: "scene" } : state.activeTab,
      };
    }),

  duplicateBlueprint: (id) => {
    const src = get().project.blueprints.find((b) => b.id === id);
    if (!src) return "";
    const newBpId = newId("bp");
    // Deep clone so the copy shares NO references with the source — edits
    // to behaviors / variables / logic-sheet nodes on one don't bleed
    // into the other. structuredClone handles nested arrays/objects;
    // BlueprintDef is plain JSON (no functions / class instances).
    const clone: BlueprintDef = structuredClone(src);
    clone.id = newBpId;
    clone.hidden = false;
    // Unique name: "<name> copy", then "<name> copy 2", "… 3", …  so the
    // duplicate never shadows the source for `var:<Name>.x` cross-BP
    // lookups (which match by blueprintName). Also dodge the reserved
    // "World" name. Comparison is against ALL current BP names.
    const taken = new Set(get().project.blueprints.map((b) => b.name));
    const base = sanitizeAssetName(`${src.name}_copy`, "Blueprint");
    let candidate = base;
    let n = 2;
    while (taken.has(candidate) || candidate === "World") {
      candidate = `${base}_${n++}`;
    }
    clone.name = candidate;
    // Fresh eventPage ids (+ remap any legacy event.pageId refs) so the
    // clone honors the "each BP owns unique page ids" invariant — keeps
    // cross-BP event paste/move from ever landing on the wrong page even
    // though Event Sheets are deprecated.
    const pageIdMap = new Map<string, string>();
    clone.eventPages = (clone.eventPages ?? []).map((p) => {
      const np = newId("page");
      pageIdMap.set(p.id, np);
      return { ...p, id: np };
    });
    const remapEventPages = (evs: typeof clone.events): typeof clone.events =>
      (evs ?? []).map((ev) => ({
        ...ev,
        pageId: ev.pageId ? (pageIdMap.get(ev.pageId) ?? ev.pageId) : ev.pageId,
        children: remapEventPages(ev.children),
      }));
    clone.events = remapEventPages(clone.events);
    // Logic Sheet: regenerate folder ids (+ node/edge ids) so the copy shares
    // NO ids with the source. Folder ids double as the editor's canvas key and
    // per-owner open-folder key, so identical ids across two BPs made edits in
    // one bleed into the other (and nodes vanish on save). Edges are re-pointed
    // through the node-id map so exec/data wiring survives the remap.
    if (clone.logicSheet?.folders) {
      clone.logicSheet = {
        ...clone.logicSheet,
        folders: clone.logicSheet.folders.map((f) => {
          const idMap = new Map<string, string>();
          const nodes = f.graph.nodes.map((n) => {
            const nid = newId("node");
            idMap.set(n.id, nid);
            return { ...n, id: nid };
          });
          const edges = f.graph.edges.map((e) => ({
            ...e,
            id: newId("edge"),
            source: idMap.get(e.source) ?? e.source,
            target: idMap.get(e.target) ?? e.target,
          }));
          return { ...f, id: newId("folder"), graph: { nodes, edges } };
        }),
      };
    }
    // Insert directly AFTER the source so the duplicate appears adjacent
    // in the Content Browser / outliner.
    set((state) => {
      const list = state.project.blueprints;
      const idx = list.findIndex((b) => b.id === id);
      const next = idx >= 0
        ? [...list.slice(0, idx + 1), clone, ...list.slice(idx + 1)]
        : [...list, clone];
      return {
        project: { ...state.project, blueprints: next },
        selectedBlueprintId: newBpId,
        view: "blueprint",
      };
    });
    return newBpId;
  },

  duplicateAsset: (kind, id) => {
    // Blueprints have their own richer clone (eventPage remap, select +
    // open) — delegate. Everything else uses the generic deep-clone
    // path below: structuredClone, new top-level id, unique name,
    // insert adjacent to the source. Nested ids (layer / animation /
    // frame / line / child ids) are scoped to their parent asset, so
    // two assets can carry identical internal ids without runtime
    // conflict — no remap needed, which keeps this bug-free.
    if (kind === "blueprint") return get().duplicateBlueprint(id);

    // Unique-name helper: "<name> copy", "<name> copy 2", … against the
    // existing names in that asset list.
    const uniqueName = (base: string, taken: Set<string>): string => {
      const root = `${base} copy`;
      if (!taken.has(root)) return root;
      let n = 2;
      while (taken.has(`${root} ${n}`)) n++;
      return `${root} ${n}`;
    };
    // Generic adjacent-insert into an array by source id.
    const insertAfter = <T extends { id: string }>(arr: T[], srcId: string, item: T): T[] => {
      const idx = arr.findIndex((x) => x.id === srcId);
      return idx >= 0 ? [...arr.slice(0, idx + 1), item, ...arr.slice(idx + 1)] : [...arr, item];
    };

    let newId_ = "";
    set((state) => {
      const p = state.project;
      if (kind === "scene") {
        const src = p.scenes.find((s) => s.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("scene");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(p.scenes.map((s) => s.name)));
        return { project: { ...p, scenes: insertAfter(p.scenes, id, clone) } };
      }
      if (kind === "sprite") {
        const src = p.sprites.find((s) => s.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("spr");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(p.sprites.map((s) => s.name)));
        // Disk: the new sprite's frames live at assets/<cb>/<newName>/ —
        // copy the source folder there so the cloned imageFile refs
        // resolve. Without this, the duplicate would render empty frames
        // (or share the source's files, which breaks the moment one
        // sprite gets edits the other doesn't).
        const store = getActiveAssetStore();
        if (store) {
          const oldDir = spriteDiskFolder(src);
          const newDir = spriteDiskFolder(clone);
          void store.copyDir(oldDir, newDir).catch((err) => {
            console.warn(`[duplicateAsset:sprite] copy ${oldDir} → ${newDir} failed`, err);
          });
        }
        return { project: { ...p, sprites: insertAfter(p.sprites, id, clone) } };
      }
      if (kind === "dialogue") {
        const src = p.dialogues.find((d) => d.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("dlg");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(p.dialogues.map((d) => d.name)));
        return { project: { ...p, dialogues: insertAfter(p.dialogues, id, clone) } };
      }
      if (kind === "uiwidget") {
        const src = p.uiWidgets.find((w) => w.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("ui");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(p.uiWidgets.map((w) => w.name)));
        return { project: { ...p, uiWidgets: insertAfter(p.uiWidgets, id, clone) } };
      }
      if (kind === "sound") {
        const list = p.sounds ?? [];
        const src = list.find((s) => s.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("snd");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(list.map((s) => s.name)));
        // Copy the audio file so the duplicate has its own on-disk binary.
        // Without this both SoundAssets point at the same /assets/.../X.wav;
        // renaming or moving either one (setSoundPath, setSoundKind) triggers
        // a renameFile on the shared file and silently breaks the other.
        const store = getActiveAssetStore();
        if (store && src.file) {
          const ext = /\.[^.]+$/.exec(src.file)?.[0] ?? "";
          clone.file = `${clone.name}${ext}`;
          const oldPath = soundDiskPath(src);
          const newPath = soundDiskPath(clone);
          void store.copyFile(oldPath, newPath).catch((err) => {
            console.warn(`[duplicateAsset:sound] copy ${oldPath} → ${newPath} failed`, err);
          });
        }
        return { project: { ...p, sounds: insertAfter(list, id, clone) } };
      }
      if (kind === "item") {
        const list = p.items ?? [];
        const src = list.find((i) => i.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("item");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(list.map((i) => i.name)));
        return { project: { ...p, items: insertAfter(list, id, clone) } };
      }
      if (kind === "recipe") {
        const list = p.recipes ?? [];
        const src = list.find((r) => r.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("recipe");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(list.map((r) => r.name)));
        return { project: { ...p, recipes: insertAfter(list, id, clone) } };
      }
      if (kind === "tileset") {
        const list = p.tilesets ?? [];
        const src = list.find((t) => t.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("tset");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(list.map((t) => t.name)));
        // Same as sprite: copy the binary atlas folder to the new name.
        const store = getActiveAssetStore();
        if (store) {
          const oldDir = tilesetDiskFolder(src);
          const newDir = tilesetDiskFolder(clone);
          void store.copyDir(oldDir, newDir).catch((err) => {
            console.warn(`[duplicateAsset:tileset] copy ${oldDir} → ${newDir} failed`, err);
          });
        }
        return { project: { ...p, tilesets: insertAfter(list, id, clone) } };
      }
      if (kind === "tilemap") {
        const list = p.tilemaps ?? [];
        const src = list.find((m) => m.id === id);
        if (!src) return {};
        const clone = structuredClone(src);
        clone.id = newId_ = newId("tmap");
        clone.hidden = false;
        clone.name = uniqueName(src.name, new Set(list.map((m) => m.name)));
        return { project: { ...p, tilemaps: insertAfter(list, id, clone) } };
      }
      return {};
    });
    return newId_;
  },

  // ── Main Logic Sheets (project-level, multi) ───────────────────────
  addMainLogicSheet: (name) => {
    const id = newId("mls");
    set((state) => {
      const cur = state.project.mainLogicSheets ?? [];
      const nextName = name ?? `Main Sheet ${cur.length + 1}`;
      return {
        project: {
          ...state.project,
          mainLogicSheets: [
            ...cur,
            { id, name: nextName, enabled: true, sheet: { folders: [] } },
          ],
        },
      };
    });
    return id;
  },
  renameMainLogicSheet: (id, name) =>
    set((state) => {
      const cur = state.project.mainLogicSheets;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          mainLogicSheets: cur.map((s) => (s.id === id ? { ...s, name } : s)),
        },
      };
    }),
  removeMainLogicSheet: (id) =>
    set((state) => {
      const cur = state.project.mainLogicSheets;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          mainLogicSheets: cur.filter((s) => s.id !== id),
        },
      };
    }),
  setMainLogicSheetEnabled: (id, enabled) =>
    set((state) => {
      const cur = state.project.mainLogicSheets;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          mainLogicSheets: cur.map((s) => (s.id === id ? { ...s, enabled } : s)),
        },
      };
    }),
  setMainLogicSheetGraph: (id, sheet) =>
    set((state) => {
      const cur = state.project.mainLogicSheets;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          mainLogicSheets: cur.map((s) => (s.id === id ? { ...s, sheet } : s)),
        },
      };
    }),

  addBlueprintBehavior: (bpId, kind) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        const config: Record<string, unknown> = { ...BEHAVIOR_DEFAULTS[kind] };
        // Auto-name multi-instance components so each gets a unique handle.
        // First attached uses the bare kind ("Tracer", "Text"); subsequent
        // ones append a 1-up suffix starting at 2 ("Tracer2", "Text3", …).
        // The user can rename later via the Components panel; auto-name is
        // just a sane default so expressions like `tracer:Tracer2.hitX`
        // work out of the box without forcing setup.
        if (kind === "Tracer" || kind === "Text" || kind === "ParticleEmitter") {
          const taken = new Set<string>();
          for (const b of bp.behaviors) {
            if (b.kind !== kind) continue;
            const n = b.config.name;
            if (typeof n === "string" && n) taken.add(n);
          }
          let candidate = kind as string;
          if (taken.has(candidate)) {
            let i = 2;
            while (taken.has(`${kind}${i}`)) i++;
            candidate = `${kind}${i}`;
          }
          config.name = candidate;
        }
        return {
          ...bp,
          behaviors: [...bp.behaviors, { kind, config, enabled: true }],
        };
      }),
    })),

  updateBlueprintBehavior: (bpId, index, config) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        // Component-name uniqueness guard: Text / Tracer use a `name`
        // field to disambiguate per-BP siblings (`text:Hint.content`,
        // `tracer:T2.hitX`). Renaming to a name another sibling-of-
        // same-kind already has would silently collide and break every
        // expression that referenced either. Warn — and refuse the
        // collision by falling back to the previous config — so the
        // user notices instead of hunting silent breakage.
        const existing = bp.behaviors[index];
        if (existing) {
          const newName = String((config as Record<string, unknown>)?.name ?? "").trim();
          const oldName = String((existing.config as Record<string, unknown>)?.name ?? "").trim();
          if (newName && newName !== oldName) {
            const collidesWith = bp.behaviors.findIndex((b, i) => i !== index && b.kind === existing.kind && String((b.config as Record<string, unknown>)?.name ?? "").trim() === newName);
            if (collidesWith >= 0) {
              console.warn(`[Peaky] ${existing.kind} name "${newName}" already used by another component on this BP — keeping previous name. Pick a unique name (or clear the other one first).`);
              return {
                ...bp,
                behaviors: bp.behaviors.map((x, i) => (i === index ? { ...x, config: { ...config, name: oldName } } : x)),
              };
            }
          }
        }
        return {
          ...bp,
          behaviors: bp.behaviors.map((x, i) => (i === index ? { ...x, config } : x)),
        };
      }),
    })),

  duplicateBlueprintBehavior: (bpId, index) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        const src = bp.behaviors[index];
        if (!src) return bp;
        // Only multi-instance behaviors clone cleanly — single-instance
        // components (CharacterMovement / SpriteRenderer / etc.) are 1:1
        // with the host body and a second copy fights the first for
        // control of the same fields. Tell the user instead of silently
        // creating a broken duplicate.
        const MULTI = new Set<string>(["Tracer", "Text", "ParticleEmitter"]);
        if (!MULTI.has(src.kind)) {
          console.warn(`[Peaky] Can't duplicate ${src.kind} — single-instance behaviors only allow one per BP. Multi-instance kinds: Tracer, Text.`);
          return bp;
        }
        // Deep-copy the config so future edits to the clone don't bleed
        // into the original (shallow spread keeps nested objects shared).
        const config: Record<string, unknown> = JSON.parse(JSON.stringify(src.config));
        // Auto-rename so the clone's `name` doesn't collide with the
        // source. Matches addBlueprintBehavior's suffix scheme.
        const taken = new Set<string>();
        for (const b of bp.behaviors) {
          if (b.kind !== src.kind) continue;
          const n = b.config.name;
          if (typeof n === "string" && n) taken.add(n);
        }
        const baseName = String((src.config as Record<string, unknown>).name ?? src.kind);
        let candidate = baseName;
        if (taken.has(candidate)) {
          let i = 2;
          // If the original was "Tracer2", probe "Tracer3", "Tracer4", …
          // If it was "groundCheck", probe "groundCheck2", "groundCheck3", …
          const stripped = baseName.replace(/\d+$/, "");
          while (taken.has(`${stripped}${i}`)) i++;
          candidate = `${stripped}${i}`;
        }
        config.name = candidate;
        // Insert AFTER the original so the duplicate appears adjacent
        // in the components panel — feels natural to the user.
        const next = bp.behaviors.slice();
        next.splice(index + 1, 0, { kind: src.kind, config, enabled: src.enabled });
        return { ...bp, behaviors: next };
      }),
    })),

  removeBlueprintBehavior: (bpId, index) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        behaviors: bp.behaviors.filter((_, i) => i !== index),
      })),
    })),

  reorderBlueprintBehavior: (bpId, fromIndex, toIndex) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        if (fromIndex === toIndex) return bp;
        if (fromIndex < 0 || fromIndex >= bp.behaviors.length) return bp;
        if (toIndex < 0 || toIndex > bp.behaviors.length) return bp;
        const next = bp.behaviors.slice();
        const [moved] = next.splice(fromIndex, 1);
        // After splice the destination shifts left by one if we removed
        // from earlier in the array.
        const adjusted = fromIndex < toIndex ? toIndex - 1 : toIndex;
        next.splice(adjusted, 0, moved);
        return { ...bp, behaviors: next };
      }),
    })),

  toggleBlueprintBehaviorEnabled: (bpId, index) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        behaviors: bp.behaviors.map((x, i) =>
          i === index ? { ...x, enabled: x.enabled === false ? true : false } : x,
        ),
      })),
    })),

  addLODGroup: (bpId) => {
    const newGroupId = newId("lod");
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        const existing = bp.lodGroups ?? [];
        const fresh: LODGroup = {
          id: newGroupId,
          name: `Group ${existing.length + 1}`,
          components: [],
          distance: 500,
          targetTag: "player",
        };
        return { ...bp, lodGroups: [...existing, fresh] };
      }),
    }));
    return newGroupId;
  },

  updateLODGroup: (bpId, groupId, patch) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        lodGroups: (bp.lodGroups ?? []).map((g) =>
          g.id === groupId ? { ...g, ...patch } : g,
        ),
      })),
    })),

  removeLODGroup: (bpId, groupId) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        lodGroups: (bp.lodGroups ?? []).filter((g) => g.id !== groupId),
      })),
    })),

  toggleLODGroupComponent: (bpId, groupId, componentKind) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        lodGroups: (bp.lodGroups ?? []).map((g) => {
          if (g.id !== groupId) return g;
          const has = g.components.includes(componentKind);
          return {
            ...g,
            components: has
              ? g.components.filter((c) => c !== componentKind)
              : [...g.components, componentKind],
          };
        }),
      })),
    })),

  // ----------------- Folders + asset paths -----------------
  addFolder: (path) =>
    set((state) => {
      const norm = normalizeFolderPath(path);
      if (!norm) return state;
      if (state.project.folders.includes(norm)) return state;
      return { project: { ...state.project, folders: [...state.project.folders, norm] } };
    }),

  removeFolder: (path) =>
    set((state) => {
      const norm = normalizeFolderPath(path);
      if (!norm) return state;
      const parent = parentFolder(norm);
      const isAffected = (p: string) => p === norm || p.startsWith(norm + "/");
      const folders = state.project.folders.filter((f) => !isAffected(f));
      const blueprints = state.project.blueprints.map((b) => (isAffected(b.path) ? { ...b, path: parent } : b));
      const scenes = state.project.scenes.map((sc) => (isAffected(sc.path) ? { ...sc, path: parent } : sc));
      const sprites = state.project.sprites.map((s) => (isAffected(s.path) ? { ...s, path: parent } : s));
      const dialogues = state.project.dialogues.map((d) => (d.path !== undefined && isAffected(d.path) ? { ...d, path: parent } : d));
      const uiWidgets = state.project.uiWidgets.map((w) => (w.path !== undefined && isAffected(w.path) ? { ...w, path: parent } : w));
      const sounds = (state.project.sounds ?? []).map((s) => (isAffected(s.path) ? { ...s, path: parent } : s));
      const items = (state.project.items ?? []).map((i) => (isAffected(i.path) ? { ...i, path: parent } : i));
      const recipes = (state.project.recipes ?? []).map((r) => (isAffected(r.path) ? { ...r, path: parent } : r));
      return { project: { ...state.project, folders, blueprints, scenes, sprites, dialogues, uiWidgets, sounds, items, recipes } };
    }),

  renameFolder: (oldPath, newPath) => {
    const oldNorm = normalizeFolderPath(oldPath);
    const newNorm = normalizeFolderPath(newPath);
    if (!oldNorm || !newNorm || oldNorm === newNorm) return;
    if (get().project.folders.includes(newNorm)) return;
    // Disk side: every asset whose CB-path lives under oldNorm has its files
    // under `assets/<oldNorm-stripped>/...` — moving that directory tree to
    // the new location cascades all the children (sprites' frame folders,
    // tilesets' atlas folders, sounds, etc.) in one shot. Fire-and-forget
    // async; state updates synchronously so the editor feels responsive.
    // notifyAssetStoreChange after the move so any useAssetURL hooks that
    // resolved against the new path (empty result during the in-flight
    // move) re-fetch.
    const store = getActiveAssetStore();
    if (store) {
      // Strip leading "/" — disk paths are relative to project root.
      const oldDir = `assets${oldNorm}`.replace(/\/+/g, "/").replace(/\/$/, "");
      const newDir = `assets${newNorm}`.replace(/\/+/g, "/").replace(/\/$/, "");
      void store.renameDir(oldDir, newDir)
        .then(() => notifyAssetStoreChange())
        .catch((err) => {
          console.warn(`[renameFolder] disk dir rename failed: ${oldDir} → ${newDir}`, err);
        });
    }
    set((state) => {
      const remap = (p: string) =>
        p === oldNorm ? newNorm : p.startsWith(oldNorm + "/") ? newNorm + p.slice(oldNorm.length) : p;
      const folders = state.project.folders.map(remap);
      const blueprints = state.project.blueprints.map((b) => ({ ...b, path: remap(b.path) }));
      const scenes = state.project.scenes.map((sc) => ({ ...sc, path: remap(sc.path) }));
      const sprites = state.project.sprites.map((s) => ({ ...s, path: remap(s.path) }));
      const dialogues = state.project.dialogues.map((d) => (d.path !== undefined ? { ...d, path: remap(d.path) } : d));
      const uiWidgets = state.project.uiWidgets.map((w) => (w.path !== undefined ? { ...w, path: remap(w.path) } : w));
      const sounds = (state.project.sounds ?? []).map((s) => ({ ...s, path: remap(s.path) }));
      const items = (state.project.items ?? []).map((i) => ({ ...i, path: remap(i.path) }));
      const recipes = (state.project.recipes ?? []).map((r) => ({ ...r, path: remap(r.path) }));
      // Tilesets and tilemaps were missing — their disk files DO move with the
      // folder (renameDir handles the whole subtree above) but without remap
      // here the manifest still records the old paths → they vanish from the
      // Content Browser and fail to load next session.
      const tilesets = (state.project.tilesets ?? []).map((t) => ({ ...t, path: remap(t.path) }));
      const tilemaps = (state.project.tilemaps ?? []).map((tm) => ({ ...tm, path: remap(tm.path) }));
      return { project: { ...state.project, folders, blueprints, scenes, sprites, dialogues, uiWidgets, sounds, items, recipes, tilesets, tilemaps } };
    });
  },

  setBlueprintPath: (bpId, path) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({ ...bp, path: normalizeFolderPath(path) || "/" })),
    })),

  setAssetHidden: (kind, id, hidden) =>
    set((state) => {
      const flag = hidden ? true : undefined; // drop the field when unhiding so saved files stay clean
      const apply = <T extends { id: string; hidden?: boolean }>(list: T[]): T[] =>
        list.map((a) => (a.id === id ? { ...a, hidden: flag } : a));
      const project = { ...state.project };
      switch (kind) {
        case "blueprint": project.blueprints = apply(project.blueprints); break;
        case "scene":     project.scenes     = apply(project.scenes);     break;
        case "sprite":    project.sprites    = apply(project.sprites);    break;
        case "uiwidget":  project.uiWidgets  = apply(project.uiWidgets);  break;
        case "dialogue":  project.dialogues  = apply(project.dialogues);  break;
        case "sound":     project.sounds     = apply(project.sounds ?? []); break;
        case "item":      project.items      = apply(project.items ?? []); break;
        case "recipe":    project.recipes    = apply(project.recipes ?? []); break;
      }
      return { project };
    }),

  newProject: () =>
    set(() => {
      // Hard reset: replace project with a fresh emptyProject() and clear
      // every editor-only view state (open tabs, selections, undo history,
      // running flag) so nothing references stale ids that no longer exist.
      const fresh = emptyProject();
      return {
        project: fresh,
        openSceneIds: [fresh.activeSceneId],
        openBlueprintIds: [],
        openSpriteIds: [],
        openDialogueIds: [],
        openUIWidgetIds: [],
        activeTab: { kind: "scene" },
        view: "scene",
        selectedInstanceId: null,
        selectedBlueprintId: null,
        past: [],
        future: [],
      };
    }),

  setScenePath: (sceneId, path) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id === sceneId ? { ...sc, path: normalizeFolderPath(path) || "/" } : sc,
        ),
      },
    })),

  // ----------------- Scenes -----------------
  addScene: (path) => {
    const id = newId("scene");
    set((state) => {
      const baseName = "NewScene";
      let unique = baseName;
      let n = 2;
      while (state.project.scenes.some((s) => s.name === unique)) unique = `${baseName}${n++}`;
      const sc: SceneData = {
        id,
        name: unique,
        width: 800,
        height: 600,
        backgroundColor: 0x1a1a2e,
        gravity: 800,
        instances: [],
        path: normalizeFolderPath(path ?? "/Scenes") || "/",
        ...defaultLayers(),
      };
      return { project: { ...state.project, scenes: [...state.project.scenes, sc] } };
    });
    return id;
  },

  renameScene: (sceneId, name) => {
    const clean = sanitizeAssetName(name, "Scene");
    set((state) => {
      const target = state.project.scenes.find((sc) => sc.id === sceneId);
      const scenes = state.project.scenes.map((sc) => (sc.id === sceneId ? { ...sc, name: clean } : sc));
      if (!target || target.name === clean) {
        return { project: { ...state.project, scenes } };
      }
      // Scenes are referenced BY NAME in GoToLayout / GoToNextLayout's
      // `scene` param. Cascade so saved actions follow the rename instead
      // of breaking with "scene not found" at runtime.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapNamedRefInSheet(bp.logicSheet, "scene", oldName, clean),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapNamedRefInSheet(ms.sheet, "scene", oldName, clean)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapNamedRefInSheet(w.logicSheet, "scene", oldName, clean),
      }));
      return { project: { ...state.project, scenes, blueprints, mainLogicSheets, uiWidgets } };
    });
  },

  removeScene: (sceneId) =>
    set((state) => {
      if (state.project.scenes.length <= 1) return state;
      const scenes = state.project.scenes.filter((sc) => sc.id !== sceneId);
      const activeSceneId =
        state.project.activeSceneId === sceneId ? scenes[0].id : state.project.activeSceneId;
      const openSceneIds = state.openSceneIds.filter((x) => x !== sceneId);
      // Guarantee at least one scene tab remains open.
      const finalOpen = openSceneIds.length > 0 ? openSceneIds : [activeSceneId];
      return {
        project: { ...state.project, scenes, activeSceneId },
        openSceneIds: finalOpen,
      };
    }),

  setActiveScene: (sceneId) =>
    set((state) => {
      if (!state.project.scenes.some((sc) => sc.id === sceneId)) return state;
      const openSceneIds = state.openSceneIds.includes(sceneId)
        ? state.openSceneIds
        : [...state.openSceneIds, sceneId];
      return {
        openSceneIds,
        project: { ...state.project, activeSceneId: sceneId },
        activeTab: { kind: "scene" },
        selectedInstanceId: null,
      };
    }),

  setSceneSize: (sceneId, width, height) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
          },
        ),
      },
    })),

  setSceneBackground: (sceneId, color) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : { ...sc, backgroundColor: color & 0xffffff },
        ),
      },
    })),

  setSceneGravity: (sceneId, gravity) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : { ...sc, gravity },
        ),
      },
    })),

  setSceneUnboundedScroll: (sceneId, unbounded) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : { ...sc, unboundedScroll: unbounded },
        ),
      },
    })),

  setViewportSize: (width, height) =>
    set((state) => ({
      project: {
        ...state.project,
        viewportWidth: Math.max(1, Math.round(width)),
        viewportHeight: Math.max(1, Math.round(height)),
      },
    })),

  setSampling: (sampling) =>
    set((state) => ({ project: { ...state.project, sampling } })),

  setCullDistanceMultiplier: (multiplier) =>
    set((state) => ({ project: { ...state.project, cullDistanceMultiplier: Math.max(0.5, multiplier) } })),

  setSpawnBudgetPerFrame: (budget) =>
    set((state) => ({ project: { ...state.project, spawnBudgetPerFrame: Math.max(0, Math.floor(budget)) } })),

  setLoadingSceneId: (id) =>
    set((state) => ({ project: { ...state.project, loadingSceneId: id || undefined } })),

  setOpenLogicFolderForOwner: (ownerId, folderId) =>
    set((state) => {
      const next = { ...state.openLogicFolderByOwner };
      if (folderId == null || folderId === "") delete next[ownerId];
      else next[ownerId] = folderId;
      return { openLogicFolderByOwner: next };
    }),

  setProjectName: (name) =>
    set((state) => ({ project: { ...state.project, name } })),

  // ----------------- Layers (per-scene) -----------------
  addLayer: (sceneId, name) => {
    const id = newId("layer");
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const base = name ?? "Layer";
          let unique = base;
          let n = 2;
          while (sc.layers.some((l) => l.name === unique)) unique = `${base} ${n++}`;
          const layer: LayerDef = {
            id, name: unique, parallaxX: 1, parallaxY: 1, visible: true, opacity: 1,
          };
          // Insert above Background (i.e. just before the last layer if its
          // parallax < 1) so new layers appear in the foreground by default.
          const insertAt = sc.layers.findIndex((l) => l.parallaxX < 1 && l.parallaxY < 1);
          const layers = insertAt >= 0
            ? [...sc.layers.slice(0, insertAt), layer, ...sc.layers.slice(insertAt)]
            : [...sc.layers, layer];
          return { ...sc, layers };
        }),
      },
    }));
    return id;
  },

  removeLayer: (sceneId, layerId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          if (sc.layers.length <= 1) return sc; // never delete the last layer
          const layers = sc.layers.filter((l) => l.id !== layerId);
          // Orphan instances → fall back to the first remaining layer.
          const fallbackId = layers[0].id;
          const instances = sc.instances.map((inst) =>
            inst.layerId === layerId ? { ...inst, layerId: fallbackId } : inst,
          );
          const activeLayerId = sc.activeLayerId === layerId ? fallbackId : sc.activeLayerId;
          return { ...sc, layers, instances, activeLayerId };
        }),
      },
    })),

  renameLayer: (sceneId, layerId, name) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) => (l.id === layerId ? { ...l, name } : l)),
          },
        ),
      },
    })),

  setLayerParallax: (sceneId, layerId, x, y) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) =>
              l.id === layerId ? { ...l, parallaxX: x, parallaxY: y } : l,
            ),
          },
        ),
      },
    })),

  setLayerVisible: (sceneId, layerId, visible) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) => (l.id === layerId ? { ...l, visible } : l)),
          },
        ),
      },
    })),

  setLayerOpacity: (sceneId, layerId, opacity) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) =>
              l.id === layerId ? { ...l, opacity: Math.max(0, Math.min(1, opacity)) } : l,
            ),
          },
        ),
      },
    })),

  setLayerGlobal: (sceneId, layerId, global) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) => (l.id === layerId ? { ...l, global } : l)),
          },
        ),
      },
    })),

  setLayerYSort: (sceneId, layerId, ySort) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) => (l.id === layerId ? { ...l, ySort } : l)),
          },
        ),
      },
    })),

  setLayerLocked: (sceneId, layerId, locked) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc : {
            ...sc,
            layers: sc.layers.map((l) => (l.id === layerId ? { ...l, locked } : l)),
          },
        ),
      },
    })),

  // Per-instance lock — works for BlueprintInstance, TilemapInstance, and
  // UIWidgetInstance. They're stored in three separate scene arrays so we
  // sweep all three and patch wherever the id lands.
  setInstanceLocked: (id, locked) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => ({
          ...sc,
          instances: sc.instances.map((i) => (i.id === id ? { ...i, locked } : i)),
          tilemapInstances: sc.tilemapInstances?.map((t) => (t.id === id ? { ...t, locked } : t)),
          uiInstances: sc.uiInstances?.map((u) => (u.id === id ? { ...u, locked } : u)),
        })),
      },
    })),

  reorderLayer: (sceneId, layerId, newIndex) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          const fromIdx = sc.layers.findIndex((l) => l.id === layerId);
          if (fromIdx < 0) return sc;
          const clamped = Math.max(0, Math.min(sc.layers.length - 1, newIndex));
          if (clamped === fromIdx) return sc;
          const next = [...sc.layers];
          const [moved] = next.splice(fromIdx, 1);
          next.splice(clamped, 0, moved);
          return { ...sc, layers: next };
        }),
      },
    })),

  setActiveLayer: (sceneId, layerId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) =>
          sc.id !== sceneId ? sc :
          sc.layers.some((l) => l.id === layerId) ? { ...sc, activeLayerId: layerId } : sc,
        ),
      },
    })),

  setInstanceLayer: (sceneId, instanceId, layerId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc;
          if (!sc.layers.some((l) => l.id === layerId)) return sc;
          // Same id might land in BP / UI / tilemap arrays; sweep all three
          // so a multi-selection that mixes kinds (e.g. a tilemap + some BPs)
          // is moved as a group.
          return {
            ...sc,
            instances: sc.instances.map((inst) =>
              inst.id === instanceId ? { ...inst, layerId } : inst,
            ),
            uiInstances: sc.uiInstances?.map((u) =>
              u.id === instanceId ? { ...u, layerId } : u,
            ),
            tilemapInstances: sc.tilemapInstances?.map((t) =>
              t.id === instanceId ? { ...t, layerId } : t,
            ),
          };
        }),
      },
    })),

  // ----------------- Dialogue assets -----------------
  addDialogue: (path) => {
    const id = newId("dlg");
    set((state) => {
      const baseName = "NewDialogue";
      let unique = baseName;
      let n = 2;
      while (state.project.dialogues.some((d) => d.name === unique)) unique = `${baseName}${n++}`;
      const asset: DialogueAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(path ?? "/Dialogues") || "/",
        lines: [],
        speakerMap: {},
      };
      return { project: { ...state.project, dialogues: [...state.project.dialogues, asset] } };
    });
    return id;
  },

  renameDialogue: (id, name) => {
    const clean = sanitizeAssetName(name, "Dialogue");
    set((state) => {
      const target = state.project.dialogues.find((d) => d.id === id);
      const dialogues = state.project.dialogues.map((d) => (d.id === id ? { ...d, name: clean } : d));
      if (!target || target.name === clean) {
        return { project: { ...state.project, dialogues } };
      }
      // Dialogues are referenced BY NAME in PlayDialogue's `dialogueId` param
      // (legacy field name — actually holds the asset name). Cascade.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapNamedRefInSheet(bp.logicSheet, "dialogueId", oldName, clean),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapNamedRefInSheet(ms.sheet, "dialogueId", oldName, clean)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapNamedRefInSheet(w.logicSheet, "dialogueId", oldName, clean),
      }));
      return { project: { ...state.project, dialogues, blueprints, mainLogicSheets, uiWidgets } };
    });
  },

  setDialoguePath: (id, path) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) =>
          d.id === id ? { ...d, path: normalizeFolderPath(path) || "/" } : d,
        ),
      },
    })),

  // ----------------- UI Widget assets -----------------
  addUIWidget: (path, kind) => {
    const id = newId("ui");
    set((state) => {
      const baseName = "NewUIWidget";
      let unique = baseName;
      let n = 2;
      while (state.project.uiWidgets.some((w) => w.name === unique)) unique = `${baseName}${n++}`;
      const k: UIWidgetKind = kind ?? "Panel";
      const widget: UIWidgetDef = {
        id,
        name: unique,
        mode: "single",
        children: [],
        kind: k,
        width: 200,
        height: 60,
        // Per-kind sensible starting fields (visible bg, default text,
        // default colors / value / min / max etc.) so the widget is
        // immediately usable without further configuration.
        ...defaultsForUIWidgetKind(k),
        variables: [],
        events: [],
        eventGroups: [],
        // Per-widget unique page id — same policy as `addBlueprint`.
        // A literal "p_main" shared across every widget would let a
        // cross-widget event paste / move land on the wrong page just
        // because two widgets happened to share a page id.
        eventPages: [{ id: newId("page"), name: "Page 1" }],
        path: normalizeFolderPath(path ?? "/UI") || "/",
        behaviors: [],
      };
      return { project: { ...state.project, uiWidgets: [...state.project.uiWidgets, widget] } };
    });
    return id;
  },

  renameUIWidget: (id, name) => {
    const clean = sanitizeAssetName(name, "Widget");
    set((state) => {
      const target = state.project.uiWidgets.find((w) => w.id === id);
      const renamed = state.project.uiWidgets.map((w) => (w.id === id ? { ...w, name: clean } : w));
      if (!target || target.name === clean) {
        return { project: { ...state.project, uiWidgets: renamed } };
      }
      // UI widgets are referenced BY NAME in CreateUIWidget / DestroyUIWidget
      // / SetUI* actions via `widget` / `widgetName` params. Cascade both.
      const oldName = target.name;
      const remap = (sheet: LogicSheet | undefined) => {
        const s1 = remapNamedRefInSheet(sheet, "widget", oldName, clean);
        return remapNamedRefInSheet(s1, "widgetName", oldName, clean);
      };
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remap(bp.logicSheet),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remap(ms.sheet)!,
      }));
      const uiWidgets = renamed.map((w) => ({
        ...w,
        logicSheet: remap(w.logicSheet),
      }));
      return { project: { ...state.project, blueprints, mainLogicSheets, uiWidgets } };
    });
  },

  setUIWidgetPath: (id, path) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) =>
          w.id === id ? { ...w, path: normalizeFolderPath(path) || "/" } : w,
        ),
      },
    })),

  removeUIWidget: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.filter((w) => w.id !== id),
        // Cascade: drop any instance placements pointing at this widget.
        // Without this, scenes keep dangling refs that show as "missing"
        // in the editor and silently fail to spawn at runtime.
        scenes: state.project.scenes.map((sc) => ({
          ...sc,
          uiInstances: (sc.uiInstances ?? []).filter((i) => i.uiWidgetId !== id),
        })),
      },
      openUIWidgetIds: state.openUIWidgetIds.filter((x) => x !== id),
      activeTab:
        state.activeTab.kind === "uiwidget" && state.activeTab.id === id
          ? { kind: "scene" }
          : state.activeTab,
    })),

  updateUIWidget: (id, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) =>
          w.id === id ? { ...w, ...patch } : w,
        ),
      },
    })),

  setUIWidgetKind: (id, kind) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) => {
          if (w.id !== id) return w;
          // Preserve common style + variables/events; layer the kind's
          // sensible defaults on TOP so any field the previous kind
          // didn't have (e.g. min/max when switching to Slider) gets
          // a starting value.
          return { ...w, ...defaultsForUIWidgetKind(kind), kind } as UIWidgetDef;
        }),
      },
    })),

  setUIWidgetMode: (id, mode) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) => (w.id === id ? { ...w, mode } : w)),
      },
    })),

  addUIWidgetChild: (widgetId, kind, x = 40, y = 40) => {
    const childId = newId("uic");
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) => {
          if (w.id !== widgetId) return w;
          // Auto-name children of the same kind: Button1, Button2, ...
          // The runtime targets children by `name` (SetUIText target=
          // "Button1"), so an unnamed child is unaddressable. Existing
          // children with explicit names are skipped when generating
          // the next number.
          const sameKind = w.children.filter((c) => c.kind === kind);
          const used = new Set(sameKind.map((c) => c.name).filter(Boolean) as string[]);
          let n = sameKind.length + 1;
          let candidate = `${kind}${n}`;
          while (used.has(candidate)) candidate = `${kind}${++n}`;
          // Seed the child with kind defaults + a sensible starting size.
          // Position is in the parent widget's viewport pixels (top-left
          // origin); caller picks reasonable defaults if not set.
          const defaults = defaultsForUIWidgetKind(kind);
          const child: UIWidgetChild = {
            id: childId,
            kind,
            x,
            y,
            width: 160,
            height: 40,
            name: candidate,
            ...defaults,
          };
          return { ...w, children: [...w.children, child] };
        }),
      },
    }));
    return childId;
  },

  updateUIWidgetChild: (widgetId, childId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) =>
          w.id !== widgetId ? w : {
            ...w,
            children: w.children.map((c) => (c.id === childId ? { ...c, ...patch } : c)),
          },
        ),
      },
    })),

  removeUIWidgetChild: (widgetId, childId) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) =>
          w.id !== widgetId ? w : {
            ...w,
            children: w.children.filter((c) => c.id !== childId),
          },
        ),
      },
    })),

  reorderUIWidgetChild: (widgetId, childId, to) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) => {
          if (w.id !== widgetId) return w;
          const from = w.children.findIndex((c) => c.id === childId);
          if (from < 0) return w;
          const clampedTo = Math.max(0, Math.min(w.children.length - 1, to));
          if (from === clampedTo) return w;
          // Splice the child out, insert at the new index. Drives z-order:
          // earlier indices render BEHIND later indices in the runtime's
          // child-rendering loop (UIWidgetRenderer per-child instances
          // get baseDepth + insertion-order offset, so reordering the
          // array is the source of truth).
          const next = w.children.slice();
          const [moved] = next.splice(from, 1);
          next.splice(clampedTo, 0, moved);
          return { ...w, children: next };
        }),
      },
    })),

  setUIWidgetChildKind: (widgetId, childId, kind) =>
    set((state) => ({
      project: {
        ...state.project,
        uiWidgets: state.project.uiWidgets.map((w) =>
          w.id !== widgetId ? w : {
            ...w,
            children: w.children.map((c) => (c.id === childId ? { ...c, ...defaultsForUIWidgetKind(kind), kind } as UIWidgetChild : c)),
          },
        ),
      },
    })),

  removeDialogue: (id) =>
    set((state) => {
      // Cascade: any choice's `goToDialogue` pointing at this id gets
      // cleared so the user doesn't end up with phantom jumps to a
      // deleted dialogue. The Go-to dropdown surfaces these as
      // "(missing)" already, but cleaning them up keeps the data tidy.
      const dialogues = state.project.dialogues
        .filter((d) => d.id !== id)
        .map((d) => {
          let touched = false;
          const lines = d.lines.map((l) => {
            if (!l.choices || l.choices.length === 0) return l;
            const choices = l.choices.map((c) => {
              if (c.goToDialogue === id) {
                touched = true;
                const { goToDialogue: _drop, ...rest } = c;
                void _drop;
                return rest;
              }
              return c;
            });
            return touched ? { ...l, choices } : l;
          });
          return touched ? { ...d, lines } : d;
        });
      return {
        project: { ...state.project, dialogues },
        activeTab: state.activeTab.kind === "dialogue" && state.activeTab.id === id
          ? { kind: "scene" }
          : state.activeTab,
      };
    }),

  setDialogueLines: (id, parsed) =>
    set((state) => {
      // Resolve any `-> dialogueName` references on choices to actual
      // dialogue ids by name match (exact, then case-insensitive). The
      // user-facing dropdown already handles missing references; this
      // just gives upload a free shot at wiring them up automatically.
      const resolveGoTo = (name: string | undefined): string | undefined => {
        if (!name) return undefined;
        const exact = state.project.dialogues.find((d) => d.name === name);
        if (exact) return exact.id;
        const ci = state.project.dialogues.find((d) => d.name.toLowerCase() === name.toLowerCase());
        return ci?.id;
      };
      return {
        project: {
          ...state.project,
          dialogues: state.project.dialogues.map((d) => {
            if (d.id !== id) return d;
            // Stamp fresh ids on every line + choice. Replacing the whole
            // list is the simplest way to keep store invariants clean —
            // the upload flow always passes the freshly-parsed lines,
            // never partial.
            const lines: DialogueLine[] = parsed.map((l) => ({
              id: newId("dl"),
              speaker: l.speaker,
              text: l.text,
              ...(l.delaySec !== undefined ? { delaySec: l.delaySec } : {}),
              ...(l.emitSignal ? { emitSignal: l.emitSignal } : {}),
              ...(l.choices && l.choices.length
                ? {
                    choices: l.choices.map((c) => {
                      const goToId = resolveGoTo(c.goToDialogueName);
                      return {
                        id: newId("dc"),
                        text: c.text,
                        emitSignal: c.emitSignal,
                        ...(goToId ? { goToDialogue: goToId } : {}),
                      };
                    }),
                  }
                : {}),
            }));
            return { ...d, lines };
          }),
        },
      };
    }),

  setDialogueLine: (id, lineId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) =>
          d.id !== id
            ? d
            : { ...d, lines: d.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) },
        ),
      },
    })),

  addDialogueLine: (id, afterLineId) => {
    const newLineId = newId("dl");
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          const fresh: DialogueLine = { id: newLineId, speaker: "Narrator", text: "" };
          if (!afterLineId) return { ...d, lines: [...d.lines, fresh] };
          const idx = d.lines.findIndex((l) => l.id === afterLineId);
          if (idx < 0) return { ...d, lines: [...d.lines, fresh] };
          const lines = [...d.lines];
          lines.splice(idx + 1, 0, fresh);
          return { ...d, lines };
        }),
      },
    }));
    return newLineId;
  },

  removeDialogueLine: (id, lineId) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) =>
          d.id !== id ? d : { ...d, lines: d.lines.filter((l) => l.id !== lineId) },
        ),
      },
    })),

  reorderDialogueLine: (id, fromIdx, toIdx) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          if (fromIdx === toIdx) return d;
          if (fromIdx < 0 || fromIdx >= d.lines.length) return d;
          if (toIdx < 0 || toIdx >= d.lines.length) return d;
          const lines = [...d.lines];
          const [moved] = lines.splice(fromIdx, 1);
          lines.splice(toIdx, 0, moved);
          return { ...d, lines };
        }),
      },
    })),

  addDialogueChoice: (id, lineId) => {
    const choiceId = newId("dc");
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          return {
            ...d,
            lines: d.lines.map((l) => {
              if (l.id !== lineId) return l;
              const choice: DialogueChoice = { id: choiceId, text: "", emitSignal: "" };
              return { ...l, choices: [...(l.choices ?? []), choice] };
            }),
          };
        }),
      },
    }));
    return choiceId;
  },

  setDialogueChoice: (id, lineId, choiceId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          return {
            ...d,
            lines: d.lines.map((l) => {
              if (l.id !== lineId) return l;
              return {
                ...l,
                choices: (l.choices ?? []).map((c) => (c.id === choiceId ? { ...c, ...patch } : c)),
              };
            }),
          };
        }),
      },
    })),

  removeDialogueChoice: (id, lineId, choiceId) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          return {
            ...d,
            lines: d.lines.map((l) => {
              if (l.id !== lineId) return l;
              const choices = (l.choices ?? []).filter((c) => c.id !== choiceId);
              if (choices.length === 0) {
                const { choices: _drop, ...rest } = l;
                void _drop;
                return rest;
              }
              return { ...l, choices };
            }),
          };
        }),
      },
    })),

  setDialogueSpeakerMap: (id, map) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => (d.id === id ? { ...d, speakerMap: map } : d)),
      },
    })),

  setDialogueSpeakerOffset: (id, label, offset) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => {
          if (d.id !== id) return d;
          const next = { ...(d.speakerOffsets ?? {}) };
          if (offset === null) {
            delete next[label];
          } else {
            next[label] = offset;
          }
          // Drop the speakerOffsets field entirely when the map is empty
          // so saved projects stay tidy.
          if (Object.keys(next).length === 0) {
            const { speakerOffsets: _drop, ...rest } = d;
            void _drop;
            return rest;
          }
          return { ...d, speakerOffsets: next };
        }),
      },
    })),

  setDialogueOverrides: (id, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogues: state.project.dialogues.map((d) => (d.id === id ? { ...d, ...patch } : d)),
      },
    })),

  setProjectDialogueDefaults: (patch) =>
    set((state) => ({
      project: {
        ...state.project,
        dialogueDefaults: { ...state.project.dialogueDefaults, ...patch },
      },
    })),

  // ---- dialog box (9-slice) CRUD ----
  // Stored inline as data-URLs since dialog box PNGs are typically very small
  // (<10KB). For larger artwork, swap to file-based storage matching the
  // sounds / fonts pattern (see addSound below).
  addDialogBox: (init) => {
    const id = newId("dlgbox");
    set((state) => {
      const existing = state.project.dialogBoxes ?? [];
      let baseName = (init.name && init.name.trim()) || "Box";
      const taken = new Set(existing.map((b) => b.name));
      let nm = baseName;
      let n = 1;
      while (taken.has(nm)) { n += 1; nm = `${baseName} ${n}`; }
      const box: DialogBoxAsset = {
        id,
        name: nm,
        dataUrl: init.dataUrl,
        sliceLeft: Math.max(0, Math.floor(init.sliceLeft ?? 16)),
        sliceRight: Math.max(0, Math.floor(init.sliceRight ?? 16)),
        sliceTop: Math.max(0, Math.floor(init.sliceTop ?? 16)),
        sliceBottom: Math.max(0, Math.floor(init.sliceBottom ?? 16)),
      };
      return {
        project: {
          ...state.project,
          dialogBoxes: [...existing, box],
        },
      };
    });
    return id;
  },
  updateDialogBox: (id, patch) =>
    set((state) => {
      const list = state.project.dialogBoxes ?? [];
      const next = list.map((b) => {
        if (b.id !== id) return b;
        // Clamp slice numbers to non-negative integers — negative or
        // fractional values produce broken Phaser slice rects.
        const clean: Partial<DialogBoxAsset> = { ...patch };
        for (const k of ["sliceLeft", "sliceRight", "sliceTop", "sliceBottom"] as const) {
          if (clean[k] !== undefined) clean[k] = Math.max(0, Math.floor(clean[k]));
        }
        return { ...b, ...clean };
      });
      return { project: { ...state.project, dialogBoxes: next } };
    }),
  removeDialogBox: (id) =>
    set((state) => {
      const list = state.project.dialogBoxes ?? [];
      // Also clear boxAssetId on any DialogueStyle pointing at the deleted
      // box so the asset reference doesn't dangle and silently render
      // the modern-fallback path forever. Walk asset overrides + project
      // defaults.
      const cleanedDefaults = state.project.dialogueDefaults.style?.boxAssetId === id
        ? { ...state.project.dialogueDefaults, style: { ...state.project.dialogueDefaults.style, boxAssetId: "" } }
        : state.project.dialogueDefaults;
      return {
        project: {
          ...state.project,
          dialogBoxes: list.filter((b) => b.id !== id),
          dialogueDefaults: cleanedDefaults,
        },
      };
    }),

  // ----------------- Dialog Flow -----------------
  // The DialogFlowDef may be missing on legacy projects — each mutator
  // initializes it lazily with `{ chapters: [], triggers: [] }`. New
  // chapters / triggers / conditions get fresh ids from genId(). All
  // mutations are pure; runtime DialogFlowRunner reads the latest snapshot
  // at scene-create time, so edits made post-runProject don't take effect
  // until the user re-plays.
  addDialogFlowChapter: (name) => {
    const id = newId("dfch");
    set((state) => {
      const cur = state.project.dialogFlow ?? { chapters: [], triggers: [] };
      const nextName = name ?? `Chapter ${cur.chapters.length + 1}`;
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            chapters: [...cur.chapters, { id, name: nextName }],
          },
        },
      };
    });
    return id;
  },
  renameDialogFlowChapter: (id, name) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            chapters: cur.chapters.map((c) => (c.id === id ? { ...c, name } : c)),
          },
        },
      };
    }),
  removeDialogFlowChapter: (id) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      // Cascade — drop any triggers anchored to the removed chapter so
      // the timeline doesn't carry orphans.
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            chapters: cur.chapters.filter((c) => c.id !== id),
            triggers: cur.triggers.filter((t) => t.chapterId !== id),
          },
        },
      };
    }),
  reorderDialogFlowChapter: (id, toIdx) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      const fromIdx = cur.chapters.findIndex((c) => c.id === id);
      if (fromIdx < 0 || fromIdx === toIdx) return {};
      const next = cur.chapters.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(Math.max(0, Math.min(next.length, toIdx)), 0, moved);
      return {
        project: { ...state.project, dialogFlow: { ...cur, chapters: next } },
      };
    }),
  addDialogFlowTrigger: (chapterId) => {
    const id = newId("dftr");
    set((state) => {
      const cur = state.project.dialogFlow ?? { chapters: [], triggers: [] };
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: [...cur.triggers, {
              id, chapterId,
              speakerBpId: "",
              dialogueId: "",
              kind: "OnInteract",
              conditions: [],
              priority: 0,
              oneShot: false,
            }],
          },
        },
      };
    });
    return id;
  },
  updateDialogFlowTrigger: (id, patch) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: cur.triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
          },
        },
      };
    }),
  removeDialogFlowTrigger: (id) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: cur.triggers.filter((t) => t.id !== id),
          },
        },
      };
    }),
  addDialogFlowCondition: (triggerId) => {
    const id = newId("dfco");
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: cur.triggers.map((t) => (t.id !== triggerId ? t : {
              ...t,
              conditions: [...t.conditions, { id, left: "", op: "==", right: "" }],
            })),
          },
        },
      };
    });
    return id;
  },
  updateDialogFlowCondition: (triggerId, condId, patch) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: cur.triggers.map((t) => (t.id !== triggerId ? t : {
              ...t,
              conditions: t.conditions.map((c) => (c.id === condId ? { ...c, ...patch } : c)),
            })),
          },
        },
      };
    }),
  removeDialogFlowCondition: (triggerId, condId) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: {
            ...cur,
            triggers: cur.triggers.map((t) => (t.id !== triggerId ? t : {
              ...t,
              conditions: t.conditions.filter((c) => c.id !== condId),
            })),
          },
        },
      };
    }),
  addDialogFlowRow: (bpId) =>
    set((state) => {
      const cur = state.project.dialogFlow ?? { chapters: [], triggers: [] };
      const list = cur.rowBpIds ?? [];
      if (list.includes(bpId)) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: { ...cur, rowBpIds: [...list, bpId] },
        },
      };
    }),
  removeDialogFlowRow: (bpId) =>
    set((state) => {
      const cur = state.project.dialogFlow;
      if (!cur || !cur.rowBpIds) return {};
      return {
        project: {
          ...state.project,
          dialogFlow: { ...cur, rowBpIds: cur.rowBpIds.filter((id) => id !== bpId) },
        },
      };
    }),

  // ----------------- Sprite assets -----------------
  setSpritePath: (spriteId, path) => {
    const cleanPath = normalizeFolderPath(path) || "/";
    // Disk: the sprite's frame folder (assets/<old-cb>/<name>/) needs to
    // move to assets/<new-cb>/<name>/ when the CB path changes — same as
    // renameSprite. Save-time GC catches the .sprite.json move; this
    // catches the binary folder.
    const prev = get().project.sprites.find((s) => s.id === spriteId);
    if (prev && prev.path !== cleanPath) {
      const store = getActiveAssetStore();
      if (store) {
        const oldDir = spriteDiskFolder(prev);
        const newDir = spriteDiskFolder({ path: cleanPath, name: prev.name });
        void store.renameDir(oldDir, newDir)
          .then(() => notifyAssetStoreChange())
          .catch((err) => {
            console.warn(`[setSpritePath] disk folder rename failed: ${oldDir} → ${newDir}`, err);
          });
      }
    }
    set((state) => ({
      project: {
        ...state.project,
        sprites: state.project.sprites.map((s) =>
          s.id === spriteId ? { ...s, path: cleanPath } : s,
        ),
      },
    }));
  },

  addSprite: (path) => {
    const id = newId("spr");
    set((state) => {
      const baseName = "NewSprite";
      let unique = baseName;
      let n = 2;
      while (state.project.sprites.some((s) => s.name === unique)) unique = `${baseName}${n++}`;
      const defaultAnim: SpriteAnimationDef = {
        id: newId("anim"),
        name: "Default",
        frames: [],
        fps: 10,
        loop: true,
      };
      const sprite: SpriteAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(path ?? "/Sprites") || "/",
        animations: [defaultAnim],
        width: 64,
        height: 64,
        lockAspect: false,
      };
      return { project: { ...state.project, sprites: [...state.project.sprites, sprite] } };
    });
    return id;
  },

  renameSprite: (id, name) => {
    const clean = sanitizeAssetName(name, "Sprite");
    const applyName = () =>
      set((state) => ({
        project: {
          ...state.project,
          sprites: state.project.sprites.map((s) => (s.id === id ? { ...s, name: clean } : s)),
        },
      }));
    // Disk side: the sprite's on-disk folder is keyed by its name (see
    // spriteDiskFolder), so renaming the in-memory sprite WITHOUT moving the
    // folder first leaves every frame path (assets/<CB>/<oldName>/frame_N.png)
    // dangling. Critically, the name MUST change only AFTER the disk move
    // completes: if we flip the name synchronously, the frame display
    // immediately re-resolves against assets/<CB>/<newName>/ — which is empty
    // until the async copy finishes — and the asset hooks CACHE that empty
    // "" result, so freshly-imported cutsheet frames look permanently gone.
    // Await the move, then apply the name (files already at the new path).
    const prev = get().project.sprites.find((s) => s.id === id);
    if (prev && prev.name !== clean) {
      const store = getActiveAssetStore();
      if (store) {
        const oldDir = spriteDiskFolder(prev);
        const newDir = spriteDiskFolder({ path: prev.path, name: clean });
        void store.renameDir(oldDir, newDir)
          .then(() => { applyName(); notifyAssetStoreChange(); })
          .catch((err) => {
            console.warn(`[renameSprite] disk folder rename failed: ${oldDir} → ${newDir}`, err);
            // Still apply the name so the editor isn't stuck — but the frames
            // may need a project reload to re-resolve.
            applyName();
          });
        return;
      }
    }
    applyName();
  },

  removeSprite: (id) => {
    // Disk cleanup deferred to next-session-open GC. Removing the sprite
    // in-editor only mutates state; the frame folder stays on disk so
    // undo restores fully (frames render with their actual art). The
    // load-time sweep in loadProjectFromFolder catches unreferenced
    // sprite folders next time the project opens.
    set((state) => {
      const ids = state.openSpriteIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "sprite" && state.activeTab.id === id;
      // Orphan-cleanse every reference to this sprite id:
      //   - SpriteRenderer (clears spriteId + currentAnimation)
      //   - ParticleEmitter (clears spriteId)
      //   - Any behavior whose config carries a generic spriteId field
      //   - Item.spriteId (icon)
      //   - UIWidgetDef + every UIWidgetChild: spriteId (Image), plus
      //     slotBgSpriteId / panelSpriteId / selectionSpriteId /
      //     craftArrowSpriteId (Inventory / Craft / Shop grids)
      // Without these scrubs the runtime falls back to default visuals
      // silently and the next-load GC deletes the orphaned PNGs from
      // disk, making the breakage permanent.
      const scrubBehavior = (b: typeof state.project.blueprints[0]["behaviors"][0]) => {
        const cfg = b.config as Record<string, unknown> | undefined;
        if (!cfg || String(cfg.spriteId ?? "") !== id) return b;
        if (b.kind === "SpriteRenderer") {
          return { ...b, config: { ...cfg, spriteId: "", currentAnimation: "" } };
        }
        return { ...b, config: { ...cfg, spriteId: "" } };
      };
      const blueprints = state.project.blueprints.map((bp) => {
        const behaviors = bp.behaviors.map(scrubBehavior);
        return behaviors.some((b, i) => b !== bp.behaviors[i]) ? { ...bp, behaviors } : bp;
      });
      const items = (state.project.items ?? []).map((it) =>
        it.spriteId === id ? { ...it, spriteId: "" } : it,
      );
      const SPRITE_REF_KEYS = ["spriteId", "slotBgSpriteId", "panelSpriteId", "selectionSpriteId", "craftArrowSpriteId"] as const;
      function scrubVisual<T extends object>(v: T): T {
        let out = v as unknown as Record<string, unknown>;
        let touched = false;
        for (const k of SPRITE_REF_KEYS) {
          if (out[k] === id) { out = { ...out, [k]: "" }; touched = true; }
        }
        return (touched ? out : v) as T;
      }
      const uiWidgets = state.project.uiWidgets.map((w) => {
        const scrubbedRoot = scrubVisual(w);
        const children = w.children.map(scrubVisual);
        const touched = scrubbedRoot !== w || children.some((c, i) => c !== w.children[i]);
        return touched ? { ...scrubbedRoot, children } : w;
      });
      // Scrub scene instance overrides that pinned an animation name on
      // the deleted sprite — without this, instances spawn with the
      // dangling animation name and silently render blank. (audit HIGH #23)
      const scenes = state.project.scenes.map((sc) => {
        const instances = sc.instances.map((inst) =>
          inst.spriteAnimation ? { ...inst, spriteAnimation: undefined } : inst,
        );
        return instances.some((i, idx) => i !== sc.instances[idx]) ? { ...sc, instances } : sc;
      });
      return {
        project: {
          ...state.project,
          sprites: state.project.sprites.filter((s) => s.id !== id),
          blueprints,
          items,
          uiWidgets,
          scenes,
        },
        openSpriteIds: ids,
        activeTab: wasActive ? { kind: "scene" } : state.activeTab,
      };
    });
  },

  setSpriteSize: (id, width, height) =>
    set((state) => ({
      project: {
        ...state.project,
        sprites: state.project.sprites.map((s) =>
          s.id === id
            ? { ...s, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
            : s,
        ),
      },
    })),

  // ── tileset asset CRUD ───────────────────────────────────────────
  addTileset: (path) => {
    const id = newId("tset");
    set((state) => {
      const existing = state.project.tilesets ?? [];
      const baseName = "NewTileset";
      let unique = baseName;
      let n = 2;
      while (existing.some((t) => t.name === unique)) unique = `${baseName}${n++}`;
      const tileset: TilesetAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(path ?? "/Tilesets") || "/",
        imageFile: "",
        sheetW: 0,
        sheetH: 0,
        tileW: 32,
        tileH: 32,
        offsetX: 0,
        offsetY: 0,
        spacingX: 0,
        spacingY: 0,
        cols: 0,
        rows: 0,
        solidTiles: [],
      };
      return { project: { ...state.project, tilesets: [...existing, tileset] } };
    });
    return id;
  },

  renameTileset: (id, name) => {
    const clean = sanitizeAssetName(name, "Tileset");
    // Disk side: same pattern as renameSprite. The tileset's on-disk folder
    // (which holds tileset.<ext>) is keyed by name; rename the folder so the
    // imageFile reference inside it stays resolvable.
    const prev = (get().project.tilesets ?? []).find((t) => t.id === id);
    if (prev && prev.name !== clean) {
      const store = getActiveAssetStore();
      if (store) {
        const oldDir = tilesetDiskFolder(prev);
        const newDir = tilesetDiskFolder({ path: prev.path, name: clean });
        void store.renameDir(oldDir, newDir)
          .then(() => notifyAssetStoreChange())
          .catch((err) => {
            console.warn(`[renameTileset] disk folder rename failed: ${oldDir} → ${newDir}`, err);
          });
      }
    }
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => (t.id === id ? { ...t, name: clean } : t)),
      },
    }));
  },

  removeTileset: (id) => {
    // Deferred disk cleanup, same model as removeSprite.
    set((state) => {
      const ids = state.openTilesetIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "tileset" && state.activeTab.id === id;
      // Orphan-cleanse: any tilemap that referenced this tileset gets its
      // `tilesetId` cleared so the painter shows "no tileset" instead of
      // dereferencing a deleted asset. Also wipe BigTile + animated
      // placements on every layer of those tilemaps — their ids point to
      // BigTile / AnimatedTile defs that just stopped existing. Without
      // this, runtime silently skipped rendering them and the editor kept
      // dead ids in the saved file forever.
      const tsBeingRemoved = (state.project.tilesets ?? []).find((t) => t.id === id);
      const tilemaps = (state.project.tilemaps ?? []).map((m) => {
        if (!mapRefsTileset(m, id)) return m;
        // Primary removal clears the whole map's BigTile/animated placements
        // (the renderer falls back to "no tileset"). For an extra slot we blank
        // ONLY that slot's tiles + its own placements so other slots survive.
        if (m.tilesetId === id) {
          return {
            ...m,
            tilesetId: "",
            layers: m.layers.map((L) => ({
              ...L,
              bigTilePlacements: [],
              animatedTilePlacements: [],
            })),
          };
        }
        const extra = m.extraTilesetIds ?? [];
        const ei = extra.indexOf(id);
        const slotIdx = ei + 1;
        const lo = slotIdx * TILESET_GID_STRIDE;
        const hi = lo + TILESET_GID_STRIDE;
        const inRange = (t: number) => t >= lo && t < hi;
        const bigIds = new Set((tsBeingRemoved?.bigTiles ?? []).map((b) => b.id));
        const animIds = new Set((tsBeingRemoved?.animatedTiles ?? []).map((a) => a.id));
        const layers = m.layers.map((L) => {
          const next = L.tiles.map((t) => (inRange(t) ? -1 : t));
          const xf = L.xf ? { ...L.xf } : undefined;
          if (xf) for (let i = 0; i < L.tiles.length; i++) if (inRange(L.tiles[i])) delete xf[i];
          return {
            ...L,
            tiles: next,
            xf,
            bigTilePlacements: (L.bigTilePlacements ?? []).filter((p) => !bigIds.has(p.bigTileId)),
            animatedTilePlacements: (L.animatedTilePlacements ?? []).filter((p) => !animIds.has(p.animatedTileId)),
          };
        });
        const nextExtra = extra.slice();
        nextExtra[ei] = "";
        while (nextExtra.length && !nextExtra[nextExtra.length - 1]) nextExtra.pop();
        return { ...m, extraTilesetIds: nextExtra, layers };
      });
      return {
        project: {
          ...state.project,
          tilesets: (state.project.tilesets ?? []).filter((t) => t.id !== id),
          tilemaps,
        },
        openTilesetIds: ids,
        activeTab: wasActive ? { kind: "scene" as const } : state.activeTab,
      };
    });
  },

  updateTileset: (id, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
      },
    })),

  toggleTileSolid: (id, tileIndex) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== id) return t;
          const set = new Set(t.solidTiles);
          if (set.has(tileIndex)) set.delete(tileIndex);
          else set.add(tileIndex);
          // If un-marking, drop ALL the per-tile-index mining/collider
          // configuration. Without this, hardness + drops linger silently
          // and "resurrect" the moment the tile is re-marked solid later
          // — surprising authors with old config they thought they cleared.
          const tileColliders = { ...(t.tileColliders ?? {}) };
          const tileHardness = { ...(t.tileHardness ?? {}) };
          const tileDrops = { ...(t.tileDrops ?? {}) };
          if (!set.has(tileIndex)) {
            const k = String(tileIndex);
            delete tileColliders[k];
            delete tileHardness[k];
            delete tileDrops[k];
          }
          // Sorted for stable JSON — diffs and saves stay clean across edits.
          return {
            ...t,
            solidTiles: Array.from(set).sort((a, b) => a - b),
            tileColliders,
            tileHardness,
            tileDrops,
          };
        }),
      },
    })),

  setTileCollider: (id, tileIdx, rect) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== id) return t;
          const tileColliders = { ...(t.tileColliders ?? {}) };
          const key = String(tileIdx);
          if (rect === null) delete tileColliders[key];
          else tileColliders[key] = rect;
          return { ...t, tileColliders };
        }),
      },
    })),

  setTileMining: (tilesetId, tileIdx, hardness, drops) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileHardness = { ...(t.tileHardness ?? {}) };
          const tileDrops = { ...(t.tileDrops ?? {}) };
          const key = String(tileIdx);
          // hardness can be a literal number or an expression string
          // (e.g. "random(1,5)"). Either way "empty" → unset → unbreakable.
          const isEmptyHardness = (typeof hardness === "number")
            ? hardness <= 0
            : (hardness ?? "").toString().trim() === "";
          if (!isEmptyHardness) tileHardness[key] = hardness;
          else delete tileHardness[key];
          if (drops.length > 0) tileDrops[key] = drops;
          else delete tileDrops[key];
          return { ...t, tileHardness, tileDrops };
        }),
      },
    })),

  setTileDropLayer: (tilesetId, tileIdx, layerName) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileDropLayer = { ...(t.tileDropLayer ?? {}) };
          const key = String(tileIdx);
          const trimmed = (layerName ?? "").trim();
          if (trimmed) tileDropLayer[key] = trimmed;
          else delete tileDropLayer[key];
          return { ...t, tileDropLayer };
        }),
      },
    })),

  setTileGrowBack: (tilesetId, tileIdx, value) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileGrowBack = { ...(t.tileGrowBack ?? {}) };
          const key = String(tileIdx);
          const s = String(value ?? "").trim();
          if (s !== "" && s !== "0") tileGrowBack[key] = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
          else delete tileGrowBack[key];
          return { ...t, tileGrowBack };
        }),
      },
    })),

  setTileGrowBackPop: (tilesetId, tileIdx, pop) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileGrowBackPop = { ...(t.tileGrowBackPop ?? {}) };
          const key = String(tileIdx);
          if (pop === false) tileGrowBackPop[key] = false;
          else delete tileGrowBackPop[key];
          return { ...t, tileGrowBackPop };
        }),
      },
    })),

  setTileOnBelowRemoved: (tilesetId, tileIdx, value) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileOnBelowRemoved = { ...(t.tileOnBelowRemoved ?? {}) };
          const key = String(tileIdx);
          if (value === "destroy" || value === "drop") tileOnBelowRemoved[key] = value;
          else delete tileOnBelowRemoved[key];
          return { ...t, tileOnBelowRemoved };
        }),
      },
    })),

  setTilesetGlobalExcludedTags: (tilesetId, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const cleaned = tags.map((s) => s.trim()).filter(Boolean);
          if (cleaned.length === 0) {
            const { globalExcludedTags: _drop, ...rest } = t;
            void _drop;
            return rest;
          }
          return { ...t, globalExcludedTags: cleaned };
        }),
      },
    })),

  setTileExcludedTags: (tilesetId, tileIdx, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const tileExcludedTags = { ...(t.tileExcludedTags ?? {}) };
          const key = String(tileIdx);
          const cleaned = tags.map((s) => s.trim()).filter(Boolean);
          if (cleaned.length > 0) tileExcludedTags[key] = cleaned;
          else delete tileExcludedTags[key];
          return { ...t, tileExcludedTags };
        }),
      },
    })),

  setBigTileOnBelowRemoved: (tilesetId, bigTileId, value) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => {
              if (bt.id !== bigTileId) return bt;
              if (value === "destroy" || value === "drop") return { ...bt, onBelowRemoved: value };
              const { onBelowRemoved: _drop, ...rest } = bt;
              void _drop;
              return rest;
            }),
          };
        }),
      },
    })),

  setBigTileExcludedTags: (tilesetId, bigTileId, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const cleaned = tags.map((s) => s.trim()).filter(Boolean);
          return {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => {
              if (bt.id !== bigTileId) return bt;
              if (cleaned.length > 0) return { ...bt, excludedTags: cleaned };
              const { excludedTags: _drop, ...rest } = bt;
              void _drop;
              return rest;
            }),
          };
        }),
      },
    })),

  setBigTileCells: (tilesetId, bigTileId, cells) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => {
              if (bt.id !== bigTileId) return bt;
              // A mask that covers EVERY cell of the bbox is equivalent to
              // "no mask" — strip it so the runtime stays on the rect path.
              if (cells.length > 0 && cells.length < bt.w * bt.h) {
                return { ...bt, cells };
              }
              const { cells: _drop, ...rest } = bt;
              void _drop;
              return rest;
            }),
          };
        }),
      },
    })),

  // ── terrain CRUD (auto-tile) ─────────────────────────────────────
  addTerrain: (tilesetId, name) => {
    const newTerrainId = newId("terrain");
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          const existing = t.terrains ?? [];
          let n = existing.length + 1;
          const taken = new Set(existing.map((tr) => tr.name));
          let auto = `Terrain ${n}`;
          while (taken.has(auto)) auto = `Terrain ${++n}`;
          const terrain: TerrainDef = {
            id: newTerrainId,
            name: name ?? auto,
            // Distinct hue per terrain so the painter swatch is unambiguous.
            // Cycle through a small palette by index; users can recolor.
            color: [0x7eb37e, 0x5a8acd, 0xe8b35a, 0xd47a7a, 0xa777c5, 0x6dbab3][existing.length % 6],
            defaultTile: 0,
            rules: [],
          };
          return { ...t, terrains: [...existing, terrain] };
        }),
      },
    }));
    return newTerrainId;
  },

  removeTerrain: (tilesetId, terrainId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return { ...t, terrains: (t.terrains ?? []).filter((tr) => tr.id !== terrainId) };
        }),
      },
    })),

  updateTerrain: (tilesetId, terrainId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            terrains: (t.terrains ?? []).map((tr) => (tr.id === terrainId ? { ...tr, ...patch } : tr)),
          };
        }),
      },
    })),

  addTerrainRule: (tilesetId, terrainId) => {
    const ruleId = newId("rule");
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            terrains: (t.terrains ?? []).map((tr) => {
              if (tr.id !== terrainId) return tr;
              const rule = {
                id: ruleId,
                tile: -1,
                // All 8 neighbors start as wildcard so a brand-new rule matches
                // EVERY cell — author then constrains specific positions.
                neighbors: ["any", "any", "any", "any", "any", "any", "any", "any"] as ("any" | "must" | "mustNot")[],
              };
              return { ...tr, rules: [...tr.rules, rule] };
            }),
          };
        }),
      },
    }));
    return ruleId;
  },

  removeTerrainRule: (tilesetId, terrainId, ruleId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            terrains: (t.terrains ?? []).map((tr) => {
              if (tr.id !== terrainId) return tr;
              return { ...tr, rules: tr.rules.filter((rr) => rr.id !== ruleId) };
            }),
          };
        }),
      },
    })),

  updateTerrainRule: (tilesetId, terrainId, ruleId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            terrains: (t.terrains ?? []).map((tr) => {
              if (tr.id !== terrainId) return tr;
              return {
                ...tr,
                rules: tr.rules.map((rr) => (rr.id === ruleId ? { ...rr, ...patch } : rr)),
              };
            }),
          };
        }),
      },
    })),

  /** Move a rule up (-1) or down (+1) in the priority list. First-match-wins,
   *  so the order matters: specific rules go before broad rules. */
  reorderTerrainRule: (tilesetId, terrainId, ruleId, dir) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) => {
          if (t.id !== tilesetId) return t;
          return {
            ...t,
            terrains: (t.terrains ?? []).map((tr) => {
              if (tr.id !== terrainId) return tr;
              const arr = [...tr.rules];
              const i = arr.findIndex((rr) => rr.id === ruleId);
              if (i < 0) return tr;
              const j = i + dir;
              if (j < 0 || j >= arr.length) return tr;
              const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
              return { ...tr, rules: arr };
            }),
          };
        }),
      },
    })),

  // ── tilemap asset CRUD ───────────────────────────────────────────
  addTilemap: (path, tilesetId) => {
    const id = newId("tmap");
    set((state) => {
      const existing = state.project.tilemaps ?? [];
      const baseName = "NewTilemap";
      let unique = baseName;
      let n = 2;
      while (existing.some((m) => m.name === unique)) unique = `${baseName}${n++}`;
      const cols = 16, rows = 16;
      const tilemap: TilemapAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(path ?? "/Tilemaps") || "/",
        tilesetId: tilesetId ?? "",
        cols,
        rows,
        // Start with one layer — authors add more via the layers panel.
        layers: [{
          id: newId("tlayer"),
          name: "Layer 1",
          tiles: new Array(cols * rows).fill(-1),
          z: 0,
          alpha: 1,
          visible: true,
          collides: true,
        }],
      };
      return { project: { ...state.project, tilemaps: [...existing, tilemap] } };
    });
    return id;
  },

  renameTilemap: (id, name) => {
    const clean = sanitizeAssetName(name, "Tilemap");
    set((state) => {
      const list = state.project.tilemaps ?? [];
      const target = list.find((m) => m.id === id);
      const tilemaps = list.map((m) => (m.id === id ? { ...m, name: clean } : m));
      if (!target || target.name === clean) {
        return { project: { ...state.project, tilemaps } };
      }
      // Tilemaps are referenced BY NAME in every tile action's `tilemap`
      // param (SetTile / Mine* / Place / PlayTileAnimation / etc.). Cascade
      // the rename through every BP sheet, main sheet, and UI widget sheet
      // so saved actions follow the rename instead of silently breaking
      // with "tilemap X not found" the next time Play hits one.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapTilemapInSheet(bp.logicSheet, oldName, clean),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapTilemapInSheet(ms.sheet, oldName, clean)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapTilemapInSheet(w.logicSheet, oldName, clean),
      }));
      return { project: { ...state.project, tilemaps, blueprints, mainLogicSheets, uiWidgets } };
    });
  },

  setTilemapTags: (id, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) =>
          m.id !== id ? m : { ...m, tags: tags.length > 0 ? tags : undefined },
        ),
      },
    })),

  removeTilemap: (id) =>
    set((state) => {
      const ids = state.openTilemapIds.filter((x) => x !== id);
      const wasActive = state.activeTab.kind === "tilemap" && state.activeTab.id === id;
      // Drop every placed instance that referenced this tilemap, across every
      // scene — otherwise the runtime would try to spawn a Tilemap from a
      // dangling id and log warnings.
      const scenes = state.project.scenes.map((sc) => ({
        ...sc,
        tilemapInstances: (sc.tilemapInstances ?? []).filter((ti) => ti.tilemapId !== id),
      }));
      return {
        project: {
          ...state.project,
          tilemaps: (state.project.tilemaps ?? []).filter((m) => m.id !== id),
          scenes,
        },
        openTilemapIds: ids,
        activeTab: wasActive ? { kind: "scene" as const } : state.activeTab,
      };
    }),

  setTilemapTileset: (id, tilesetId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => (m.id === id ? { ...m, tilesetId } : m)),
      },
    })),

  addTilemapTileset: (id, tilesetId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          if (!tilesetId || tilesetId === m.tilesetId) return m;
          const extra = m.extraTilesetIds ?? [];
          if (extra.includes(tilesetId)) return m;
          return { ...m, extraTilesetIds: [...extra, tilesetId] };
        }),
      },
    })),

  removeTilemapTileset: (id, tilesetId) =>
    set((state) => {
      const tilesets = state.project.tilesets ?? [];
      return {
        project: {
          ...state.project,
          tilemaps: (state.project.tilemaps ?? []).map((m) => {
            if (m.id !== id) return m;
            const extra = m.extraTilesetIds ?? [];
            const ei = extra.indexOf(tilesetId);
            if (ei < 0) return m;
            // Clear ONLY this tileset's id range and BLANK its slot (keep the
            // position) so later tilesets' firstgids never shift — works even
            // if the tileset asset was already deleted from the project.
            const slotIdx = ei + 1; // +1: primary is slot 0
            const lo = slotIdx * TILESET_GID_STRIDE;
            const hi = lo + TILESET_GID_STRIDE;
            const inRange = (t: number) => t >= lo && t < hi;
            const ts = tilesets.find((t) => t.id === tilesetId);
            const bigIds = new Set((ts?.bigTiles ?? []).map((b) => b.id));
            const animIds = new Set((ts?.animatedTiles ?? []).map((a) => a.id));
            const layers = m.layers.map((L) => {
              const next = L.tiles.map((t) => (inRange(t) ? -1 : t));
              const xf = L.xf ? { ...L.xf } : undefined;
              if (xf) for (let i = 0; i < L.tiles.length; i++) if (inRange(L.tiles[i])) delete xf[i];
              return {
                ...L,
                tiles: next,
                xf,
                bigTilePlacements: (L.bigTilePlacements ?? []).filter((p) => !bigIds.has(p.bigTileId)),
                animatedTilePlacements: (L.animatedTilePlacements ?? []).filter((p) => !animIds.has(p.animatedTileId)),
              };
            });
            const nextExtra = extra.slice();
            nextExtra[ei] = ""; // blank, preserve index
            while (nextExtra.length && !nextExtra[nextExtra.length - 1]) nextExtra.pop();
            return { ...m, extraTilesetIds: nextExtra, layers };
          }),
        },
      };
    }),

  resizeTilemap: (id, cols, rows) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          const nc = Math.max(1, Math.floor(cols));
          const nr = Math.max(1, Math.floor(rows));
          if (nc === m.cols && nr === m.rows) return m;
          // Resize EVERY layer in lock-step — layers can't have differing
          // dimensions within one map (the painter UI assumes a single grid).
          // Also truncate BigTile + animated placements whose anchor / footprint
          // falls outside the new bounds. Without this, shrinking a map kept
          // OOB placements in the data which then spawned off-map at runtime
          // and were invisible to the editor.
          const bigDefs = new Map<string, { w: number; h: number }>();
          for (const slot of tilemapTilesets(m, state.project.tilesets ?? [])) {
            for (const bt of slot.ts.bigTiles ?? []) bigDefs.set(bt.id, { w: bt.w, h: bt.h });
          }
          const layers = m.layers.map((L) => {
            const next = new Array(nc * nr).fill(-1);
            const rMax = Math.min(m.rows, nr);
            const cMax = Math.min(m.cols, nc);
            for (let r = 0; r < rMax; r++) {
              for (let c = 0; c < cMax; c++) {
                next[r * nc + c] = L.tiles[r * m.cols + c] ?? -1;
              }
            }
            const trimmedBig = (L.bigTilePlacements ?? []).filter((p) => {
              const bt = bigDefs.get(p.bigTileId);
              const w = bt?.w ?? 1;
              const h = bt?.h ?? 1;
              return p.c >= 0 && p.r >= 0 && p.c + w <= nc && p.r + h <= nr;
            });
            const trimmedAnim = (L.animatedTilePlacements ?? []).filter(
              (p) => p.c >= 0 && p.r >= 0 && p.c < nc && p.r < nr,
            );
            return {
              ...L,
              tiles: next,
              bigTilePlacements: trimmedBig,
              animatedTilePlacements: trimmedAnim,
            };
          });
          return { ...m, cols: nc, rows: nr, layers };
        }),
      },
    })),

  paintTile: (id, layerId, col, row, tile, xf = 0) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          if (col < 0 || col >= m.cols || row < 0 || row >= m.rows) return m;
          let touched = false;
          const layers = m.layers.map((L) => {
            if (L.id !== layerId) return L;
            const idx = row * m.cols + col;
            // Effective transform: empty cells (tile < 0) carry none.
            const wantXf = tile >= 0 ? (xf & 0xf) : 0;
            const curXf = L.xf?.[idx] ?? 0;
            if (L.tiles[idx] === tile && curXf === wantXf) return L;
            touched = true;
            const next = L.tiles.slice();
            next[idx] = tile;
            const nextXf = { ...(L.xf ?? {}) };
            if (wantXf) nextXf[idx] = wantXf; else delete nextXf[idx];
            return { ...L, tiles: next, xf: nextXf };
          });
          return touched ? { ...m, layers } : m;
        }),
      },
    })),

  paintTiles: (id, layerId, edits, xf) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          let touched = false;
          const layers = m.layers.map((L) => {
            if (L.id !== layerId) return L;
            // Single allocation, mutate in place — bucket fills can touch the
            // whole grid in one stroke; per-cell .slice() would balloon to garbage.
            const next = L.tiles.slice();
            const nextXf = { ...(L.xf ?? {}) };
            // `xf` undefined = "don't touch the cell's transform" (terrain /
            // bucket / erase re-evaluate the index only). A NUMBER (even 0, from
            // the brush) explicitly sets it — 0 clears. Empty cells never carry
            // a transform.
            const want = xf === undefined ? undefined : (xf & 0xf);
            for (const e of edits) {
              if (e.col < 0 || e.col >= m.cols || e.row < 0 || e.row >= m.rows) continue;
              const idx = e.row * m.cols + e.col;
              next[idx] = e.tile;
              if (e.tile < 0) delete nextXf[idx];
              else if (want !== undefined) { if (want) nextXf[idx] = want; else delete nextXf[idx]; }
            }
            touched = true;
            return { ...L, tiles: next, xf: nextXf };
          });
          return touched ? { ...m, layers } : m;
        }),
      },
    })),

  addTilemapLayer: (id, name) => {
    const newLayerId = newId("tlayer");
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          const maxZ = m.layers.reduce((mx, L) => Math.max(mx, L.z), -1);
          // Auto-name as "Layer N" using the next free integer so renames stay sane.
          let n = m.layers.length + 1;
          const taken = new Set(m.layers.map((L) => L.name));
          let auto = `Layer ${n}`;
          while (taken.has(auto)) auto = `Layer ${++n}`;
          const layer: TilemapLayer = {
            id: newLayerId,
            name: name ?? auto,
            tiles: new Array(m.cols * m.rows).fill(-1),
            z: maxZ + 1,
            alpha: 1,
            visible: true,
            collides: true,
          };
          return { ...m, layers: [...m.layers, layer] };
        }),
      },
    }));
    return newLayerId;
  },

  removeTilemapLayer: (id, layerId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          // A tilemap must keep at least ONE layer — refusing to delete the
          // last layer avoids a state where the painter has nothing to draw to.
          if (m.layers.length <= 1) return m;
          return { ...m, layers: m.layers.filter((L) => L.id !== layerId) };
        }),
      },
    })),

  renameTilemapLayer: (id, layerId, name) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          return { ...m, layers: m.layers.map((L) => (L.id === layerId ? { ...L, name } : L)) };
        }),
      },
    })),

  updateTilemapLayer: (id, layerId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          return { ...m, layers: m.layers.map((L) => (L.id === layerId ? { ...L, ...patch } : L)) };
        }),
      },
    })),

  reorderTilemapLayer: (id, layerId, delta) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          // Sort by current z to find on-screen position, swap with the
          // neighbor in the delta direction, then re-zero z to contiguous.
          const sorted = [...m.layers].sort((a, b) => a.z - b.z);
          const idx = sorted.findIndex((L) => L.id === layerId);
          if (idx < 0) return m;
          const target = idx + delta;
          if (target < 0 || target >= sorted.length) return m;
          const next = sorted.slice();
          [next[idx], next[target]] = [next[target], next[idx]];
          // Reassign z so it matches array position — visually stable when
          // the user starts adding more layers afterward.
          const renumbered = next.map((L, i) => ({ ...L, z: i }));
          return { ...m, layers: renumbered };
        }),
      },
    })),

  moveTilemapLayerTo: (id, layerId, toIndex) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== id) return m;
          const sorted = [...m.layers].sort((a, b) => a.z - b.z);
          const from = sorted.findIndex((L) => L.id === layerId);
          if (from < 0) return m;
          const target = Math.max(0, Math.min(sorted.length - 1, toIndex));
          if (target === from) return m;
          const next = sorted.slice();
          const [moved] = next.splice(from, 1);
          next.splice(target, 0, moved);
          return { ...m, layers: next.map((L, i) => ({ ...L, z: i })) };
        }),
      },
    })),

  addBigTile: (tilesetId, c, r, w, h, cells) => {
    const id = newId("bt");
    set((state) => {
      // Drop any existing bigTile that overlaps this rect — one bigTile per
      // cell region. Then cascade: any placement in any tilemap that
      // references one of the just-removed BigTile ids becomes an orphan
      // and gets stripped. Without that cascade, painted placements pointed
      // at deleted BigTile defs and silently failed to render at runtime.
      const overlaps = (a: { c: number; r: number; w: number; h: number }, b: { c: number; r: number; w: number; h: number }) =>
        a.c < b.c + b.w && a.c + a.w > b.c && a.r < b.r + b.h && a.r + a.h > b.r;
      // Only carry `cells` when it's a proper sparse mask — a list that
      // covers EVERY cell of the bbox is equivalent to no mask, so drop it
      // to keep saves clean and the runtime on the rect fast-path.
      const cleanedCells =
        cells && cells.length > 0 && cells.length < w * h ? cells : undefined;
      const newBig = { id, c, r, w, h, ...(cleanedCells ? { cells: cleanedCells } : {}) };
      const orphanedIds = new Set<string>();
      const tilesets = (state.project.tilesets ?? []).map((t) => {
        if (t.id !== tilesetId) return t;
        const dropped = (t.bigTiles ?? []).filter((bt) => overlaps(bt, newBig));
        for (const d of dropped) orphanedIds.add(d.id);
        const trimmed = (t.bigTiles ?? []).filter((bt) => !overlaps(bt, newBig));
        return { ...t, bigTiles: [...trimmed, newBig] };
      });
      const tilemaps = orphanedIds.size === 0
        ? state.project.tilemaps
        : (state.project.tilemaps ?? []).map((m) => {
            if (!mapRefsTileset(m, tilesetId)) return m;
            return {
              ...m,
              layers: m.layers.map((L) => ({
                ...L,
                bigTilePlacements: (L.bigTilePlacements ?? []).filter((p) => !orphanedIds.has(p.bigTileId)),
              })),
            };
          });
      return { project: { ...state.project, tilesets, tilemaps } };
    });
    return id;
  },

  removeBigTile: (tilesetId, bigTileId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : { ...t, bigTiles: (t.bigTiles ?? []).filter((bt) => bt.id !== bigTileId) },
        ),
        tilemaps: (state.project.tilemaps ?? []).map((m) =>
          !mapRefsTileset(m, tilesetId) ? m : {
            ...m,
            layers: m.layers.map((L) => ({
              ...L,
              bigTilePlacements: (L.bigTilePlacements ?? []).filter((p) => p.bigTileId !== bigTileId),
            })),
          },
        ),
      },
    })),

  setBigTilePivot: (tilesetId, bigTileId, pivotX, pivotY) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) =>
              bt.id !== bigTileId ? bt : { ...bt, pivotX: Math.max(0, Math.min(1, pivotX)), pivotY: Math.max(0, Math.min(1, pivotY)) },
            ),
          },
        ),
      },
    })),

  setBigTileSortY: (tilesetId, bigTileId, sortY) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) =>
              bt.id !== bigTileId ? bt : { ...bt, sortY: Math.max(0, Math.min(1, sortY)) },
            ),
          },
        ),
      },
    })),

  setBigTileSortLineY: (tilesetId, bigTileId, sortLineY) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) =>
              bt.id !== bigTileId ? bt : { ...bt, sortLineY: Math.max(0, Math.min(1, sortLineY)) },
            ),
          },
        ),
      },
    })),

  setBigTileCollide: (tilesetId, bigTileId, rect) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => {
              if (bt.id !== bigTileId) return bt;
              if (!rect) { const { collide, ...rest } = bt; return rest; }
              return { ...bt, collide: rect };
            }),
          },
        ),
      },
    })),

  setBigTileCollidePoly: (tilesetId, bigTileId, poly) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => {
              if (bt.id !== bigTileId) return bt;
              if (!poly) { const { collidePoly, ...rest } = bt; return rest; }
              return { ...bt, collidePoly: poly };
            }),
          },
        ),
      },
    })),

  patchBigTile: (tilesetId, bigTileId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) => (bt.id !== bigTileId ? bt : { ...bt, ...patch })),
          },
        ),
      },
    })),

  setBigTileTags: (tilesetId, bigTileId, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            bigTiles: (t.bigTiles ?? []).map((bt) =>
              bt.id !== bigTileId ? bt : { ...bt, tags: tags.length > 0 ? tags : undefined },
            ),
          },
        ),
      },
    })),

  placeBigTile: (tilemapId, layerId, bigTileId, c, r) => {
    const state = get();
    const map = (state.project.tilemaps ?? []).find((m) => m.id === tilemapId);
    if (!map) return "";
    // Search ALL the map's tilesets (primary + extras), not just the primary —
    // otherwise BigTiles from an extra tileset can't be placed AND the overlap
    // dedup below can't find them, silently DELETING their placements.
    const mapTilesets = tilemapTilesets(map, state.project.tilesets ?? []).map((s) => s.ts);
    const findBt = (bid: string) => {
      for (const t of mapTilesets) { const b = (t.bigTiles ?? []).find((x) => x.id === bid); if (b) return b; }
      return undefined;
    };
    const bt = findBt(bigTileId);
    if (!bt) return "";
    // Dedup overlap — without this, every click stacks a fresh placement on top
    // of any existing BigTile that covers the same cells. Drop existing
    // placements whose OCCUPIED cells intersect the new one's. Occupied honors
    // the sparse `cells` mask (a tree occupying trunk-only cells lets canopies
    // OVERHANG each other — dense Y-sorted forests); no mask = the full w×h
    // rect. Placements whose def can't be found are KEPT (never delete data we
    // can't measure).
    const occupied = (b: { w: number; h: number; cells?: { c: number; r: number }[] }, ac: number, ar: number): Array<[number, number]> => {
      if (b.cells && b.cells.length > 0 && b.cells.length < b.w * b.h) return b.cells.map((cc) => [ac + cc.c, ar + cc.r]);
      const out: Array<[number, number]> = [];
      for (let dr = 0; dr < b.h; dr++) for (let dc = 0; dc < b.w; dc++) out.push([ac + dc, ar + dr]);
      return out;
    };
    const newCells = new Set(occupied(bt, c, r).map(([cc, rr]) => `${cc},${rr}`));
    const cellsOverlap = (pBt: { w: number; h: number; cells?: { c: number; r: number }[] }, pc: number, pr: number): boolean => {
      // Cheap bbox reject first — cell scan only when boxes intersect.
      if (!(c < pc + pBt.w && c + bt.w > pc && r < pr + pBt.h && r + bt.h > pr)) return false;
      for (const [cc, rr] of occupied(pBt, pc, pr)) if (newCells.has(`${cc},${rr}`)) return true;
      return false;
    };
    const id = newId("bp");
    set((s) => ({
      project: {
        ...s.project,
        tilemaps: (s.project.tilemaps ?? []).map((m) => {
          if (m.id !== tilemapId) return m;
          return {
            ...m,
            layers: m.layers.map((L) => {
              if (L.id !== layerId) return L;
              // allowOverlap layers stack placements freely — no dedup (dense
              // forests; drag gates prevent same-stroke stacking, Y-sort
              // resolves draw order).
              const existing = L.allowOverlap
                ? (L.bigTilePlacements ?? [])
                : (L.bigTilePlacements ?? []).filter((p) => {
                    const pBt = findBt(p.bigTileId);
                    if (!pBt) return true;
                    return !cellsOverlap(pBt, p.c, p.r);
                  });
              return { ...L, bigTilePlacements: [...existing, { id, bigTileId, c, r }] };
            }),
          };
        }),
      },
    }));
    return id;
  },

  removeBigTilePlacement: (tilemapId, layerId, placementId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== tilemapId) return m;
          return {
            ...m,
            layers: m.layers.map((L) =>
              L.id !== layerId ? L : { ...L, bigTilePlacements: (L.bigTilePlacements ?? []).filter((p) => p.id !== placementId) },
            ),
          };
        }),
      },
    })),

  // ── animated tiles ─────────────────────────────────────────────────
  addAnimatedTile: (tilesetId) => {
    const id = newId("at");
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            animatedTiles: [
              ...(t.animatedTiles ?? []),
              { id, name: "", frames: [], fps: 8, loop: true, autoplay: true },
            ],
          },
        ),
      },
    }));
    return id;
  },

  removeAnimatedTile: (tilesetId, animatedTileId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : { ...t, animatedTiles: (t.animatedTiles ?? []).filter((a) => a.id !== animatedTileId) },
        ),
        tilemaps: (state.project.tilemaps ?? []).map((m) =>
          !mapRefsTileset(m, tilesetId) ? m : {
            ...m,
            layers: m.layers.map((L) => ({
              ...L,
              animatedTilePlacements: (L.animatedTilePlacements ?? []).filter((p) => p.animatedTileId !== animatedTileId),
            })),
          },
        ),
      },
    })),

  updateAnimatedTile: (tilesetId, animatedTileId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            animatedTiles: (t.animatedTiles ?? []).map((a) => {
              if (a.id !== animatedTileId) return a;
              // Strip "none" → undefined so AnimatedTileDef.onBelowRemoved stays
              // narrow to "destroy" | "drop" | undefined; the runtime treats
              // missing as "no cascade".
              const { onBelowRemoved: rawObr, ...restPatch } = patch;
              const obr: "destroy" | "drop" | undefined =
                rawObr === "destroy" || rawObr === "drop" ? rawObr : undefined;
              const cleanedPatch: typeof restPatch & { onBelowRemoved?: "destroy" | "drop" } =
                rawObr !== undefined
                  ? { ...restPatch, ...(obr ? { onBelowRemoved: obr } : {}) }
                  : restPatch;
              const finalPatch = patch.name !== undefined
                ? { ...cleanedPatch, name: sanitizeAssetName(patch.name, "AnimatedTile") }
                : cleanedPatch;
              const next = { ...a, ...finalPatch };
              if (finalPatch.tags !== undefined && finalPatch.tags.length === 0) delete (next as { tags?: string[] }).tags;
              if (finalPatch.dropLayer !== undefined && finalPatch.dropLayer.trim() === "") delete (next as { dropLayer?: string }).dropLayer;
              if (rawObr === "none" || rawObr === undefined && "onBelowRemoved" in patch) {
                delete (next as { onBelowRemoved?: "destroy" | "drop" }).onBelowRemoved;
              }
              if ((finalPatch as { excludedTags?: string[] }).excludedTags !== undefined && (finalPatch as { excludedTags?: string[] }).excludedTags!.length === 0) {
                delete (next as { excludedTags?: string[] }).excludedTags;
              }
              return next;
            }),
          },
        ),
      },
    })),

  setAnimatedTileFrames: (tilesetId, animatedTileId, frames) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            animatedTiles: (t.animatedTiles ?? []).map((a) =>
              a.id !== animatedTileId ? a : { ...a, frames: [...frames] },
            ),
          },
        ),
      },
    })),

  setAnimatedTileDrops: (tilesetId, animatedTileId, drops) =>
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id !== tilesetId ? t : {
            ...t,
            animatedTiles: (t.animatedTiles ?? []).map((a) =>
              a.id !== animatedTileId ? a : { ...a, drops: drops.length > 0 ? drops : undefined },
            ),
          },
        ),
      },
    })),

  placeAnimatedTile: (tilemapId, layerId, animatedTileId, c, r) => {
    const state = get();
    const map = (state.project.tilemaps ?? []).find((m) => m.id === tilemapId);
    if (!map) return "";
    // Search ALL the map's tilesets (primary + extras), not just the primary.
    const mapTilesets = tilemapTilesets(map, state.project.tilesets ?? []).map((s) => s.ts);
    if (!mapTilesets.some((t) => (t.animatedTiles ?? []).some((a) => a.id === animatedTileId))) return "";
    const id = newId("ap");
    set((s) => ({
      project: {
        ...s.project,
        tilemaps: (s.project.tilemaps ?? []).map((m) => {
          if (m.id !== tilemapId) return m;
          return {
            ...m,
            layers: m.layers.map((L) => {
              if (L.id !== layerId) return L;
              // Dedup at the cell — each single-cell animated placement must
              // occupy a unique (c, r). Stacking would double-render, double
              // HP-drain, double drops, and leave the bottom one un-erasable.
              const existing = (L.animatedTilePlacements ?? []).filter((p) => !(p.c === c && p.r === r));
              return { ...L, animatedTilePlacements: [...existing, { id, animatedTileId, c, r }] };
            }),
          };
        }),
      },
    }));
    return id;
  },

  removeAnimatedTilePlacement: (tilemapId, layerId, placementId) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) => {
          if (m.id !== tilemapId) return m;
          return {
            ...m,
            layers: m.layers.map((L) =>
              L.id !== layerId ? L : { ...L, animatedTilePlacements: (L.animatedTilePlacements ?? []).filter((p) => p.id !== placementId) },
            ),
          };
        }),
      },
    })),

  // ── tilemap instance CRUD (per scene) ────────────────────────────
  addTilemapInstance: (sceneId, init) => {
    const id = newId("tmi");
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => sc.id !== sceneId ? sc : {
          ...sc,
          tilemapInstances: [...(sc.tilemapInstances ?? []), { id, ...init }],
        }),
      },
    }));
    return id;
  },

  updateTilemapInstance: (sceneId, instId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => sc.id !== sceneId ? sc : {
          ...sc,
          tilemapInstances: (sc.tilemapInstances ?? []).map((ti) => ti.id === instId ? { ...ti, ...patch } : ti),
        }),
      },
    })),

  removeTilemapInstance: (sceneId, instId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => sc.id !== sceneId ? sc : {
          ...sc,
          tilemapInstances: (sc.tilemapInstances ?? []).filter((ti) => ti.id !== instId),
        }),
      },
    })),

  // ── nav mesh CRUD (per scene) ────────────────────────────────────
  ensureNavMesh: (sceneId, cellSize = 16) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId || sc.navMesh) return sc;
          const cs = Math.max(4, Math.floor(cellSize));
          const cols = Math.max(1, Math.ceil(sc.width / cs));
          const rows = Math.max(1, Math.ceil(sc.height / cs));
          // Start all-blocked: the author paints the walkable zones ("where
          // NPCs can go"), which is also the natural A* input.
          const navMesh: NavMesh = { cellSize: cs, cols, rows, walkable: new Array(cols * rows).fill(0), obstacles: [], waypoints: [] };
          return { ...sc, navMesh };
        }),
      },
    })),

  paintNavWalkable: (sceneId, cells) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId || !sc.navMesh) return sc;
          const nm = sc.navMesh;
          const walkable = nm.walkable.slice();
          for (const { c, r, walkable: w } of cells) {
            if (c < 0 || c >= nm.cols || r < 0 || r >= nm.rows) continue;
            walkable[r * nm.cols + c] = w;
          }
          return { ...sc, navMesh: { ...nm, walkable } };
        }),
      },
    })),

  paintNavShelter: (sceneId, cells) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId || !sc.navMesh) return sc;
          const nm = sc.navMesh;
          const shelter = (nm.shelter ?? new Array(nm.cols * nm.rows).fill(0)).slice();
          for (const { c, r, on } of cells) {
            if (c < 0 || c >= nm.cols || r < 0 || r >= nm.rows) continue;
            shelter[r * nm.cols + c] = on;
          }
          return { ...sc, navMesh: { ...nm, shelter } };
        }),
      },
    })),

  setNavCellSize: (sceneId, cellSize) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId || !sc.navMesh) return sc;
          const old = sc.navMesh;
          const cs = Math.max(4, Math.floor(cellSize));
          if (cs === old.cellSize) return sc;
          const cols = Math.max(1, Math.ceil(sc.width / cs));
          const rows = Math.max(1, Math.ceil(sc.height / cs));
          // Resample the painted mask at each new cell's center so paint
          // survives a resolution change.
          const walkable = new Array(cols * rows).fill(0);
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const oc = Math.floor((c * cs + cs / 2) / old.cellSize);
            const or = Math.floor((r * cs + cs / 2) / old.cellSize);
            if (oc >= 0 && oc < old.cols && or >= 0 && or < old.rows && old.walkable[or * old.cols + oc]) walkable[r * cols + c] = 1;
          }
          let shelter: number[] | undefined;
          if (old.shelter) {
            shelter = new Array(cols * rows).fill(0);
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
              const oc = Math.floor((c * cs + cs / 2) / old.cellSize);
              const or = Math.floor((r * cs + cs / 2) / old.cellSize);
              if (oc >= 0 && oc < old.cols && or >= 0 && or < old.rows) {
                const ov = old.shelter[or * old.cols + oc];
                if (ov) shelter[r * cols + c] = ov;
              }
            }
          }
          return { ...sc, navMesh: { ...old, cellSize: cs, cols, rows, walkable, shelter } };
        }),
      },
    })),

  setNavDebug: (sceneId, on) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : { ...sc, navMesh: { ...sc.navMesh, debug: on || undefined } }),
      },
    })),

  setNavRegionLocked: (sceneId, on) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : { ...sc, navMesh: { ...sc.navMesh, regionLocked: on || undefined } }),
      },
    })),

  setNavSize: (sceneId, width, height) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => {
          if (sc.id !== sceneId || !sc.navMesh) return sc;
          const old = sc.navMesh;
          const cols = Math.max(1, Math.ceil(Math.max(1, width) / old.cellSize));
          const rows = Math.max(1, Math.ceil(Math.max(1, height) / old.cellSize));
          if (cols === old.cols && rows === old.rows) return sc;
          // cellSize unchanged → copy the overlapping cell region directly.
          const walkable = new Array(cols * rows).fill(0);
          for (let r = 0; r < Math.min(rows, old.rows); r++) for (let c = 0; c < Math.min(cols, old.cols); c++) {
            walkable[r * cols + c] = old.walkable[r * old.cols + c];
          }
          let shelter: number[] | undefined;
          if (old.shelter) {
            shelter = new Array(cols * rows).fill(0);
            for (let r = 0; r < Math.min(rows, old.rows); r++) for (let c = 0; c < Math.min(cols, old.cols); c++) {
              shelter[r * cols + c] = old.shelter[r * old.cols + c];
            }
          }
          return { ...sc, navMesh: { ...old, cols, rows, walkable, shelter } };
        }),
      },
    })),

  addNavObstacle: (sceneId, points, tags = []) => {
    const id = newId("nob");
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, obstacles: [...sc.navMesh.obstacles, { id, points, tags }] },
        }),
      },
    }));
    return id;
  },

  updateNavObstacle: (sceneId, obstacleId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, obstacles: sc.navMesh.obstacles.map((o) => o.id === obstacleId ? { ...o, ...patch } : o) },
        }),
      },
    })),

  removeNavObstacle: (sceneId, obstacleId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, obstacles: sc.navMesh.obstacles.filter((o) => o.id !== obstacleId) },
        }),
      },
    })),

  addNavWaypoint: (sceneId, x, y, tags = []) => {
    const id = newId("nwp");
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, waypoints: [...sc.navMesh.waypoints, { id, x, y, tags }] },
        }),
      },
    }));
    return id;
  },

  updateNavWaypoint: (sceneId, waypointId, patch) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, waypoints: sc.navMesh.waypoints.map((w) => w.id === waypointId ? { ...w, ...patch } : w) },
        }),
      },
    })),

  removeNavWaypoint: (sceneId, waypointId) =>
    set((state) => ({
      project: {
        ...state.project,
        scenes: state.project.scenes.map((sc) => (sc.id !== sceneId || !sc.navMesh) ? sc : {
          ...sc,
          navMesh: { ...sc.navMesh, waypoints: sc.navMesh.waypoints.filter((w) => w.id !== waypointId) },
        }),
      },
    })),

  // ── sound asset CRUD ─────────────────────────────────────────────
  addSound: (init) => {
    const id = newId("snd");
    set((state) => {
      const list = state.project.sounds ?? [];
      const baseName = (init.name && init.name.trim()) || "NewSound";
      let unique = baseName;
      let n = 2;
      while (list.some((s) => s.name === unique)) unique = `${baseName}${n++}`;
      const kind = init.kind ?? "sfx";
      const sound: SoundAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(init.path ?? "/Audio") || "/",
        file: init.file,
        kind,
        volume: 1,
        loop: kind === "music",
      };
      return { project: { ...state.project, sounds: [...list, sound] } };
    });
    return id;
  },

  renameSound: (id, name) =>
    set((state) => {
      const list = state.project.sounds ?? [];
      const target = list.find((s) => s.id === id);
      const sounds = list.map((s) => (s.id === id ? { ...s, name } : s));
      // No cascade needed when there's nothing to rename or the name is
      // unchanged.
      if (!target || target.name === name) {
        return { project: { ...state.project, sounds } };
      }
      // Sounds are referenced BY NAME in logic-graph nodes (PlaySound /
      // StopSound / PlayMusic / Is*Playing use the `sound` param; PlaySounds
      // uses the `sounds` array). Cascade the rename into every BP sheet,
      // Main Sheet, and UI-widget sheet so references don't silently break.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapSoundInSheet(bp.logicSheet, oldName, name),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapSoundInSheet(ms.sheet, oldName, name)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapSoundInSheet(w.logicSheet, oldName, name),
      }));
      return { project: { ...state.project, sounds, blueprints, mainLogicSheets, uiWidgets } };
    }),

  setSoundPath: (id, path) => {
    const cleanPath = normalizeFolderPath(path) || "/";
    // Disk: the audio file (assets/<old-cb>/<sound>.<ext>) needs to move
    // to assets/<new-cb>/<sound>.<ext>. Sound is a single file (not a
    // folder), so we use renameFile.
    const prev = (get().project.sounds ?? []).find((s) => s.id === id);
    if (prev && prev.path !== cleanPath) {
      const store = getActiveAssetStore();
      if (store) {
        const oldP = soundDiskPath(prev);
        const newP = soundDiskPath({ path: cleanPath, file: prev.file });
        void store.renameFile(oldP, newP)
          .then(() => notifyAssetStoreChange())
          .catch((err) => {
            console.warn(`[setSoundPath] disk file rename failed: ${oldP} → ${newP}`, err);
          });
      }
    }
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) =>
          s.id === id ? { ...s, path: cleanPath } : s,
        ),
      },
    }));
  },

  removeSound: (id) =>
    // Deferred disk cleanup, same model as removeSprite.
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).filter((s) => s.id !== id),
      },
    })),

  setSoundKind: (id, kind) =>
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) => (s.id === id ? { ...s, kind } : s)),
      },
    })),

  setSoundVolume: (id, volume) =>
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) =>
          s.id === id ? { ...s, volume: Math.max(0, Math.min(1, volume)) } : s,
        ),
      },
    })),

  setSoundLoop: (id, loop) =>
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) => (s.id === id ? { ...s, loop } : s)),
      },
    })),

  setSoundMaxInstances: (id, n) =>
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) =>
          s.id === id ? { ...s, maxInstances: Math.max(0, Math.floor(n)) } : s,
        ),
      },
    })),

  setSoundMinInterval: (id, ms) =>
    set((state) => ({
      project: {
        ...state.project,
        sounds: (state.project.sounds ?? []).map((s) =>
          s.id === id ? { ...s, minIntervalMs: Math.max(0, Math.floor(ms)) } : s,
        ),
      },
    })),

  // ── custom font CRUD ─────────────────────────────────────────────
  addFont: (init) => {
    const id = newId("font");
    set((state) => {
      const list = state.project.fonts ?? [];
      // The name doubles as the CSS font-family, so it must be unique. Strip
      // a file extension if the caller passed a raw filename.
      const base = (init.name || "Font").replace(/\.[^.]+$/, "").trim() || "Font";
      let unique = base;
      let n = 2;
      while (list.some((f) => f.name === unique)) unique = `${base} ${n++}`;
      const font: FontAsset = { id, name: unique, file: init.file };
      return { project: { ...state.project, fonts: [...list, font] } };
    });
    return id;
  },

  renameFont: (id, name) =>
    set((state) => {
      const trimmed = name.trim();
      const list = state.project.fonts ?? [];
      if (!trimmed || list.some((f) => f.id !== id && f.name === trimmed)) return state;
      return {
        project: { ...state.project, fonts: list.map((f) => (f.id === id ? { ...f, name: trimmed } : f)) },
      };
    }),

  removeFont: (id) =>
    // Deferred disk cleanup, same model as removeSprite.
    set((state) => ({
      project: { ...state.project, fonts: (state.project.fonts ?? []).filter((f) => f.id !== id) },
    })),

  addItem: (init) => {
    const id = newId("item");
    set((state) => {
      const list = state.project.items ?? [];
      const baseName = sanitizeAssetName((init?.name && init.name.trim()) || "NewItem", "Item");
      let unique = baseName;
      let n = 2;
      while (list.some((i) => i.name === unique)) unique = `${baseName}_${n++}`;
      const item: ItemAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(init?.path ?? "/Items") || "/",
        spriteId: init?.spriteId ?? "",
        maxStack: 99,
        // Each item auto-owns its persistent count global (the player's "bag"
        // count). Named after the item; editable in the item editor.
        countGlobal: itemCountGlobalName(unique),
      };
      return { project: { ...state.project, items: [...list, item] } };
    });
    return id;
  },

  renameItem: (id, name) => {
    const clean = sanitizeAssetName(name, "Item");
    set((state) => {
      const list = state.project.items ?? [];
      const target = list.find((i) => i.id === id);
      const items = list.map((i) => (i.id === id ? { ...i, name: clean } : i));
      if (!target || target.name === clean) {
        return { project: { ...state.project, items } };
      }
      // Items are referenced BY NAME in logic-graph nodes (AddItem / RemoveItem /
      // HasItem use the `item` param). Cascade the rename into every sheet.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapItemInSheet(bp.logicSheet, oldName, clean),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapItemInSheet(ms.sheet, oldName, clean)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapItemInSheet(w.logicSheet, oldName, clean),
      }));
      // Recipes reference items by name too.
      const recipes = (state.project.recipes ?? []).map((r) => ({
        ...r,
        inputs: r.inputs.map((inp) => (inp.item === oldName ? { ...inp, item: clean } : inp)),
        outputItem: r.outputItem === oldName ? clean : r.outputItem,
      }));
      return { project: { ...state.project, items, blueprints, mainLogicSheets, uiWidgets, recipes } };
    });
  },

  setItemPath: (id, path) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, path: normalizeFolderPath(path) || "/" } : i,
        ),
      },
    })),

  removeItem: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).filter((i) => i.id !== id),
      },
    })),

  setItemIcon: (id, spriteId) =>
    set((state) => ({
      project: {
        ...state.project,
        // New sprite → reset the anim/frame selection so it starts clean.
        items: (state.project.items ?? []).map((i) => (i.id === id ? { ...i, spriteId, iconAnim: "", iconFrame: 0 } : i)),
      },
    })),

  setItemIconAnim: (id, animId) =>
    set((state) => ({
      project: {
        ...state.project,
        // Switching animation → reset frame to 0 (the new anim's first frame).
        items: (state.project.items ?? []).map((i) => (i.id === id ? { ...i, iconAnim: animId, iconFrame: 0 } : i)),
      },
    })),

  setItemIconFrame: (id, frame) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) => (i.id === id ? { ...i, iconFrame: Math.floor(frame) } : i)),
      },
    })),

  setItemMaxStack: (id, maxStack) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, maxStack: Math.max(1, Math.floor(maxStack)) } : i,
        ),
      },
    })),

  setItemTags: (id, tags) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) => (i.id === id ? { ...i, tags } : i)),
      },
    })),

  setItemCountGlobal: (id, countGlobal) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, countGlobal: countGlobal.replace(/[^A-Za-z0-9_]/g, "") } : i,
        ),
      },
    })),

  setItemBuyPrice: (id, price) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, buyPrice: Number.isFinite(price) ? Math.max(0, price) : 0 } : i,
        ),
      },
    })),

  setItemSellPrice: (id, price) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, sellPrice: Number.isFinite(price) ? Math.max(0, price) : 0 } : i,
        ),
      },
    })),

  setItemPickupBp: (id, pickupBp) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) =>
          i.id === id ? { ...i, pickupBp: pickupBp.trim() || undefined } : i,
        ),
      },
    })),

  setItemProps: (id, props) =>
    set((state) => ({
      project: {
        ...state.project,
        items: (state.project.items ?? []).map((i) => (i.id === id ? { ...i, props } : i)),
      },
    })),

  addRecipe: (init) => {
    const id = newId("recipe");
    set((state) => {
      const list = state.project.recipes ?? [];
      const baseName = sanitizeAssetName((init?.name && init.name.trim()) || "NewRecipe", "Recipe");
      let unique = baseName;
      let n = 2;
      while (list.some((r) => r.name === unique)) unique = `${baseName}_${n++}`;
      const recipe: RecipeAsset = {
        id,
        name: unique,
        path: normalizeFolderPath(init?.path ?? "/Recipes") || "/",
        inputs: [],
        outputItem: "",
        outputQty: 1,
      };
      return { project: { ...state.project, recipes: [...list, recipe] } };
    });
    return id;
  },

  renameRecipe: (id, name) => {
    const clean = sanitizeAssetName(name, "Recipe");
    set((state) => {
      const list = state.project.recipes ?? [];
      const target = list.find((r) => r.id === id);
      const recipes = list.map((r) => (r.id === id ? { ...r, name: clean } : r));
      if (!target || target.name === clean) {
        return { project: { ...state.project, recipes } };
      }
      // Recipes are referenced BY NAME in logic-graph nodes (Craft / CanCraft
      // use the `recipe` param). Cascade the rename into every sheet.
      const oldName = target.name;
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        logicSheet: remapRecipeInSheet(bp.logicSheet, oldName, clean),
      }));
      const mainLogicSheets = (state.project.mainLogicSheets ?? []).map((ms) => ({
        ...ms,
        sheet: remapRecipeInSheet(ms.sheet, oldName, clean)!,
      }));
      const uiWidgets = state.project.uiWidgets.map((w) => ({
        ...w,
        logicSheet: remapRecipeInSheet(w.logicSheet, oldName, clean),
      }));
      return { project: { ...state.project, recipes, blueprints, mainLogicSheets, uiWidgets } };
    });
  },

  setRecipePath: (id, path) =>
    set((state) => ({
      project: {
        ...state.project,
        recipes: (state.project.recipes ?? []).map((r) =>
          r.id === id ? { ...r, path: normalizeFolderPath(path) || "/" } : r,
        ),
      },
    })),

  setTilesetPath: (id, path) => {
    const cleanPath = normalizeFolderPath(path) || "/";
    // Same disk cascade as setSpritePath — move the on-disk atlas folder.
    const prev = (get().project.tilesets ?? []).find((t) => t.id === id);
    if (prev && prev.path !== cleanPath) {
      const store = getActiveAssetStore();
      if (store) {
        const oldDir = tilesetDiskFolder(prev);
        const newDir = tilesetDiskFolder({ path: cleanPath, name: prev.name });
        void store.renameDir(oldDir, newDir)
          .then(() => notifyAssetStoreChange())
          .catch((err) => {
            console.warn(`[setTilesetPath] disk folder rename failed: ${oldDir} → ${newDir}`, err);
          });
      }
    }
    set((state) => ({
      project: {
        ...state.project,
        tilesets: (state.project.tilesets ?? []).map((t) =>
          t.id === id ? { ...t, path: cleanPath } : t,
        ),
      },
    }));
  },

  setTilemapPath: (id, path) =>
    set((state) => ({
      project: {
        ...state.project,
        tilemaps: (state.project.tilemaps ?? []).map((m) =>
          m.id === id ? { ...m, path: normalizeFolderPath(path) || "/" } : m,
        ),
      },
    })),

  removeRecipe: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        recipes: (state.project.recipes ?? []).filter((r) => r.id !== id),
      },
    })),

  setRecipeInputs: (id, inputs) =>
    set((state) => ({
      project: {
        ...state.project,
        recipes: (state.project.recipes ?? []).map((r) => (r.id === id ? { ...r, inputs } : r)),
      },
    })),

  setRecipeOutput: (id, item, qty) =>
    set((state) => ({
      project: {
        ...state.project,
        recipes: (state.project.recipes ?? []).map((r) =>
          r.id === id ? { ...r, outputItem: item, outputQty: Math.max(1, Math.floor(qty)) } : r,
        ),
      },
    })),

  setRecipeEnabled: (id, enabled) =>
    set((state) => ({
      project: {
        ...state.project,
        recipes: (state.project.recipes ?? []).map((r) => (r.id === id ? { ...r, enabled } : r)),
      },
    })),

  setSpriteSizeProtecting: (id, width, height, exceptAnimId) =>
    set((state) => ({
      project: {
        ...state.project,
        sprites: state.project.sprites.map((s) => {
          if (s.id !== id) return s;
          const oldW = s.width;
          const oldH = s.height;
          const animations = s.animations.map((a) => {
            if (a.id === exceptAnimId) return a;
            // Other animations: stamp the soon-to-be-stale fallback size onto
            // any frame that doesn't already carry its own imageW/imageH so
            // their visual size sticks across the asset resize.
            const frames = a.frames.map((f) => {
              if (f.imageW !== undefined && f.imageH !== undefined) return f;
              return {
                ...f,
                imageW: f.imageW ?? oldW,
                imageH: f.imageH ?? oldH,
              };
            });
            return { ...a, frames };
          });
          return {
            ...s,
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            animations,
          };
        }),
      },
    })),

  setSpriteLockAspect: (id, locked) =>
    set((state) => ({
      project: {
        ...state.project,
        sprites: state.project.sprites.map((s) => (s.id === id ? { ...s, lockAspect: locked } : s)),
      },
    })),

  addSpriteAnimation: (spriteId, name) => {
    const id = newId("anim");
    set((state) => ({
      project: mapSprite(state.project, spriteId, (sp) => {
        const baseName = name ?? "NewAnim";
        let unique = baseName;
        let n = 2;
        while (sp.animations.some((a) => a.name === unique)) unique = `${baseName}${n++}`;
        const anim: SpriteAnimationDef = { id, name: unique, frames: [], fps: 10, loop: true };
        return { ...sp, animations: [...sp.animations, anim] };
      }),
    }));
    return id;
  },

  renameSpriteAnimation: (spriteId, animId, name) =>
    set((state) => {
      const sp = state.project.sprites.find((s) => s.id === spriteId);
      if (!sp) return state;
      const target = sp.animations.find((a) => a.id === animId);
      if (!target) return state;
      // Same name is a no-op (avoids running the cascade for nothing).
      if (name === target.name) return state;
      // Surface the reject so the user knows the rename didn't take. Without
      // this it silently snaps back when the input is controlled.
      if (sp.animations.some((a) => a.name === name)) {
        // eslint-disable-next-line no-console
        console.warn(`renameSpriteAnimation: animation name "${name}" already exists on sprite "${sp.name}" — rename rejected.`);
        return state;
      }
      const oldName = target.name;
      // Cascade-rename references in:
      //   - other BPs' SpriteRenderer.config.currentAnimation (when it
      //     points at THIS sprite — different sprite assets can legally
      //     share an animation name)
      //   - events that read/write this animation by name (PlayAnimation
      //     action; OnAnimationEnd / IsAnimationPlaying conditions). These
      //     can't be sprite-scoped (the BP's renderer determines context),
      //     so we update wherever the old name appears.
      const blueprints = state.project.blueprints.map((bp) => {
        const behaviors = bp.behaviors.map((b) => {
          if (b.kind !== "SpriteRenderer") return b;
          if (String(b.config.spriteId ?? "") !== spriteId) return b;
          if (String(b.config.currentAnimation ?? "") !== oldName) return b;
          return { ...b, config: { ...b.config, currentAnimation: name } };
        });
        const events = transformAllEvents(bp.events, (ev) => ({
          ...ev,
          conditions: ev.conditions.map((c) => {
            if ((c.kind === "OnAnimationEnd" || c.kind === "IsAnimationPlaying") && c.animation === oldName) {
              return { ...c, animation: name };
            }
            return c;
          }),
          actions: ev.actions.map((a) => {
            if (a.kind === "PlayAnimation" && String(a.config.animation ?? "") === oldName) {
              return { ...a, config: { ...a.config, animation: name } };
            }
            return a;
          }),
        }));
        return { ...bp, behaviors, events };
      });
      return {
        project: {
          ...state.project,
          sprites: state.project.sprites.map((s) =>
            s.id === spriteId
              ? { ...s, animations: s.animations.map((a) => (a.id === animId ? { ...a, name } : a)) }
              : s,
          ),
          blueprints,
        },
      };
    }),

  removeSpriteAnimation: (spriteId, animId) =>
    set((state) => ({
      project: mapSprite(state.project, spriteId, (sp) => {
        if (sp.animations.length <= 1) return sp;
        return { ...sp, animations: sp.animations.filter((a) => a.id !== animId) };
      }),
    })),

  updateSpriteAnimation: (spriteId, animId, patch) =>
    set((state) => ({
      project: mapSprite(state.project, spriteId, (sp) => ({
        ...sp,
        animations: sp.animations.map((a) => (a.id === animId ? { ...a, ...patch } : a)),
      })),
    })),

  reorderSpriteAnimation: (spriteId, fromAnimId, toAnimId) =>
    set((state) => ({
      project: mapSprite(state.project, spriteId, (sp) => {
        if (fromAnimId === toAnimId) return sp;
        const fromIdx = sp.animations.findIndex((a) => a.id === fromAnimId);
        const toIdx = sp.animations.findIndex((a) => a.id === toAnimId);
        if (fromIdx < 0 || toIdx < 0) return sp;
        const next = [...sp.animations];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return { ...sp, animations: next };
      }),
    })),

  addSpriteFrame: (spriteId, animId, init) => {
    const id = newId("frame");
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        // Inherit imageW/imageH/pivotX/pivotY from the last existing frame
        // when the caller didn't supply explicit values. Empty frames added
        // via "+ Add frame" otherwise default to imageW/H = undefined and
        // get rendered against `sprite.width/height` while sibling frames
        // use their own (cropped) sizes — picking up the sibling dims keeps
        // the pivot anchor consistent and lets the new frame plug in
        // visually without manual resize.
        const sibling = anim.frames[anim.frames.length - 1];
        const frame: SpriteFrame = {
          id,
          // -1 = empty/transparent frame ("+ Add frame" makes a blank frame to
          // draw/import onto, not a coloured placeholder). Imports pass a real
          // color explicitly.
          color: init?.color ?? -1,
          imageFile: init?.imageFile,
          imageW: init?.imageW ?? (init?.imageFile ? undefined : sibling?.imageW),
          imageH: init?.imageH ?? (init?.imageFile ? undefined : sibling?.imageH),
          pivotX: sibling?.pivotX,
          pivotY: sibling?.pivotY,
        };
        return { ...anim, frames: [...anim.frames, frame] };
      }),
    }));
    return id;
  },

  // Note: removeSpriteFrame / removeSpriteFrames intentionally DON'T delete
  // the frame PNG from disk here. If they did, Ctrl+Z would restore the
  // in-memory frame but its file would be gone → blank thumbnail. The
  // save-time GC in saveProjectToFolder walks each sprite folder and
  // removes any PNG no frame.imageFile still references; the user can
  // delete frames freely, undo within the session, and the file ops only
  // happen at save time.
  removeSpriteFrame: (spriteId, animId, frameId) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        if (anim.frames.length <= 1) return anim;
        return { ...anim, frames: anim.frames.filter((f) => f.id !== frameId) };
      }),
    })),

  removeSpriteFrames: (spriteId, animId, frameIds) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        if (frameIds.length === 0) return anim;
        const drop = new Set(frameIds);
        const next = anim.frames.filter((f) => !drop.has(f.id));
        if (next.length === 0) {
          const keep = anim.frames.find((f) => drop.has(f.id));
          return keep ? { ...anim, frames: [keep] } : anim;
        }
        return { ...anim, frames: next };
      }),
    })),

  insertSpriteFrames: (spriteId, animId, frames, afterIdx) => {
    if (frames.length === 0) return [];
    const newIds = frames.map(() => newId("frame"));
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        const built: SpriteFrame[] = frames.map((f, i) => ({ ...f, id: newIds[i] }));
        const insertAt =
          afterIdx < 0 || afterIdx >= anim.frames.length ? anim.frames.length : afterIdx + 1;
        const next = [...anim.frames.slice(0, insertAt), ...built, ...anim.frames.slice(insertAt)];
        return { ...anim, frames: next };
      }),
    }));
    return newIds;
  },

  updateSpriteFrame: (spriteId, animId, frameId, patch) =>
    set((state) => {
      const project1 = mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f)),
      }));
      // If the patch touched the frame's image dimensions (crop / resize),
      // re-derive the SPRITE's design w/h as the MAX of all current frames
      // across all animations. Keeps `sprite.width/height` in sync with
      // the cropped art so the placement preview AND inspector display
      // match the runtime — which always renders to the frame texture's
      // natural size. Skip when the patch doesn't touch dims (e.g. just
      // editing a collider or a pivot).
      if (patch.imageW == null && patch.imageH == null) {
        return { project: project1 };
      }
      return { project: syncSpriteSizeFromFrames(project1, spriteId) };
    }),

  applyColliderToAnimFrames: (spriteId, animId, sourceFrameId) =>
    set((state) => {
      const sprite = state.project.sprites.find((s) => s.id === spriteId);
      const anim = sprite?.animations.find((a) => a.id === animId);
      const src = anim?.frames.find((f) => f.id === sourceFrameId);
      if (!src?.collider) return {};
      const srcCollider = src.collider;
      return {
        project: mapSpriteAnim(state.project, spriteId, animId, (a) => ({
          ...a,
          frames: a.frames.map((f) => ({ ...f, collider: { ...srcCollider } })),
        })),
      };
    }),

  applyColliderToAllAnims: (spriteId, sourceAnimId, sourceFrameId) =>
    set((state) => {
      const sprite = state.project.sprites.find((s) => s.id === spriteId);
      const anim = sprite?.animations.find((a) => a.id === sourceAnimId);
      const src = anim?.frames.find((f) => f.id === sourceFrameId);
      if (!src?.collider) return {};
      const srcCollider = src.collider;
      return {
        project: {
          ...state.project,
          sprites: state.project.sprites.map((s) => {
            if (s.id !== spriteId) return s;
            return {
              ...s,
              animations: s.animations.map((a) => ({
                ...a,
                frames: a.frames.map((f) => ({ ...f, collider: { ...srcCollider } })),
              })),
            };
          }),
        },
      };
    }),

  bulkUpdateSpriteFrames: (spriteId, animId, patches) =>
    set((state) => {
      // Build a fast id→patch lookup so the inner map runs O(n+p) instead
      // of O(n*p) — small wins matter in animations with many frames.
      const map = new Map(patches.map((p) => [p.id, p.patch]));
      const project1 = mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) => map.has(f.id) ? { ...f, ...map.get(f.id)! } : f),
      }));
      // Crops / resizes bulk-update imageW/imageH — keep sprite.width/height
      // in sync. See updateSpriteFrame's comment for rationale.
      const touchedDims = patches.some((p) => p.patch.imageW != null || p.patch.imageH != null);
      return {
        project: touchedDims ? syncSpriteSizeFromFrames(project1, spriteId) : project1,
      };
    }),

  bulkUpdateSpriteFramesAllAnims: (spriteId, patches) =>
    set((state) => {
      const map = new Map(patches.map((p) => [p.id, p.patch]));
      const project1 = {
        ...state.project,
        sprites: state.project.sprites.map((s) =>
          s.id !== spriteId ? s : {
            ...s,
            animations: s.animations.map((a) => ({
              ...a,
              frames: a.frames.map((f) => map.has(f.id) ? { ...f, ...map.get(f.id)! } : f),
            })),
          },
        ),
      };
      const touchedDims = patches.some((p) => p.patch.imageW != null || p.patch.imageH != null);
      return { project: touchedDims ? syncSpriteSizeFromFrames(project1, spriteId) : project1 };
    }),

  reorderSpriteFrame: (spriteId, animId, fromIdx, toIdx) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        if (fromIdx === toIdx) return anim;
        if (fromIdx < 0 || fromIdx >= anim.frames.length) return anim;
        if (toIdx < 0 || toIdx >= anim.frames.length) return anim;
        const next = [...anim.frames];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return { ...anim, frames: next };
      }),
    })),

  updateSpriteFramePivot: (spriteId, animId, frameId, pivotX, pivotY) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) => (f.id === frameId ? { ...f, pivotX, pivotY } : f)),
      })),
    })),

  setFramePivotToAll: (spriteId, animId, frameId) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        const src = anim.frames.find((f) => f.id === frameId);
        if (!src) return anim;
        return {
          ...anim,
          frames: anim.frames.map((f) => ({ ...f, pivotX: src.pivotX, pivotY: src.pivotY })),
        };
      }),
    })),

  setFramePivotToAllAnims: (spriteId, animId, frameId) =>
    set((state) => {
      const sprite = state.project.sprites.find((s) => s.id === spriteId);
      const src = sprite?.animations.find((a) => a.id === animId)?.frames.find((f) => f.id === frameId);
      if (!src) return {};
      const px = src.pivotX, py = src.pivotY;
      return {
        project: {
          ...state.project,
          sprites: state.project.sprites.map((s) =>
            s.id !== spriteId ? s : {
              ...s,
              animations: s.animations.map((a) => ({
                ...a,
                frames: a.frames.map((f) => ({ ...f, pivotX: px, pivotY: py })),
              })),
            },
          ),
        },
      };
    }),

  addSpriteImagePoint: (spriteId, animId, frameId, name, x, y) => {
    const id = newId("pt");
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) => {
          if (f.id !== frameId) return f;
          const pts = f.points ?? [];
          const pt: SpriteImagePoint = {
            id,
            name: name ?? `Point ${pts.length + 1}`,
            x: x ?? 0,
            y: y ?? 0,
          };
          return { ...f, points: [...pts, pt] };
        }),
      })),
    }));
    return id;
  },

  updateSpriteImagePoint: (spriteId, animId, frameId, pointId, patch) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) =>
          f.id !== frameId
            ? f
            : { ...f, points: (f.points ?? []).map((p) => (p.id === pointId ? { ...p, ...patch } : p)) },
        ),
      })),
    })),

  removeSpriteImagePoint: (spriteId, animId, frameId, pointId) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => ({
        ...anim,
        frames: anim.frames.map((f) =>
          f.id !== frameId ? f : { ...f, points: (f.points ?? []).filter((p) => p.id !== pointId) },
        ),
      })),
    })),

  setImagePointToAll: (spriteId, animId, frameId, pointId) =>
    set((state) => ({
      project: mapSpriteAnim(state.project, spriteId, animId, (anim) => {
        const srcFrame = anim.frames.find((f) => f.id === frameId);
        const srcPt = srcFrame?.points?.find((p) => p.id === pointId);
        if (!srcPt) return anim;
        return {
          ...anim,
          frames: anim.frames.map((f) => {
            const pts = f.points ?? [];
            const existIdx = pts.findIndex((p) => p.name === srcPt.name);
            if (existIdx >= 0) {
              const next = [...pts];
              next[existIdx] = { ...next[existIdx], x: srcPt.x, y: srcPt.y };
              return { ...f, points: next };
            }
            return { ...f, points: [...pts, { ...srcPt, id: newId("pt") }] };
          }),
        };
      }),
    })),

  setImagePointToAllAnims: (spriteId, animId, frameId, pointId) =>
    set((state) => {
      const sprite = state.project.sprites.find((s) => s.id === spriteId);
      const srcPt = sprite?.animations.find((a) => a.id === animId)
        ?.frames.find((f) => f.id === frameId)
        ?.points?.find((p) => p.id === pointId);
      if (!srcPt) return {};
      return {
        project: {
          ...state.project,
          sprites: state.project.sprites.map((s) =>
            s.id !== spriteId ? s : {
              ...s,
              animations: s.animations.map((a) => ({
                ...a,
                frames: a.frames.map((f) => {
                  const pts = f.points ?? [];
                  const existIdx = pts.findIndex((p) => p.name === srcPt.name);
                  if (existIdx >= 0) {
                    const next = [...pts];
                    next[existIdx] = { ...next[existIdx], x: srcPt.x, y: srcPt.y };
                    return { ...f, points: next };
                  }
                  return { ...f, points: [...pts, { ...srcPt, id: newId("pt") }] };
                }),
              })),
            },
          ),
        },
      };
    }),

  // ----------------- Blueprint variables -----------------
  addVariable: (bpId, name) => {
    const id = newId("var");
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => {
        const baseName = name ?? "newVar";
        let unique = baseName;
        let n = 2;
        while (bp.variables.some((v) => v.name === unique)) unique = `${baseName}${n++}`;
        const v: VariableDef = { id, name: unique, type: "number", default: 0 };
        return { ...bp, variables: [...bp.variables, v] };
      }),
    }));
    return id;
  },

  renameVariable: (bpId, varId, name) =>
    set((state) => {
      // Owner can be a blueprint OR a UI widget (both carry `variables`).
      const owner = state.project.blueprints.find((b) => b.id === bpId)
        ?? state.project.uiWidgets.find((w) => w.id === bpId);
      const target = owner?.variables?.find((v) => v.id === varId);
      if (!owner || !target) return state;
      const oldName = target.name;
      if (name === oldName || (owner.variables ?? []).some((v) => v.name === name)) return state;
      // 1. Rename the variable on its owner. 2. Cascade the rename through every
      // Logic Sheet node param, cross-object expression, and widget binding so
      // nothing silently keeps pointing at the old name.
      const renamed = mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: (bp.variables ?? []).map((v) => (v.id === varId ? { ...v, name } : v)),
      }));
      return { project: rewriteVarRefs(renamed, bpId, owner.name, oldName, name) };
    }),

  setVariableDefault: (bpId, varId, value) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, default: value } : v)),
      })),
    })),

  setVariableType: (bpId, varId, type) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => {
          if (v.id !== varId) return v;
          // Pick a sensible default for the new type. Preserve the old default
          // value when it's coercible (e.g. "5" → 5 when switching string → number)
          // so the user doesn't lose intent.
          let nextDefault: number | string | boolean;
          if (type === "number") {
            nextDefault = typeof v.default === "number" ? v.default
                        : typeof v.default === "boolean" ? (v.default ? 1 : 0)
                        : (Number(v.default) || 0);
          } else if (type === "string") {
            nextDefault = String(v.default ?? "");
          } else {
            nextDefault = !!v.default;
          }
          return { ...v, type, default: nextDefault };
        }),
      })),
    })),

  setVariableAutoCap: (bpId, varId, cap) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, autoCap: cap } : v)),
      })),
    })),

  setVariableInstanceEditable: (bpId, varId, editable) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, instanceEditable: editable } : v)),
      })),
    })),

  setVariableExposeOnSpawn: (bpId, varId, expose) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, exposeOnSpawn: expose } : v)),
      })),
    })),

  setVariableNumberKind: (bpId, varId, kind) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, numberKind: kind } : v)),
      })),
    })),

  setVariableGlobal: (bpId, varId, global) =>
    set((state) => ({
      project: mapBlueprint(state.project, bpId, (bp) => ({
        ...bp,
        variables: bp.variables.map((v) => (v.id === varId ? { ...v, global } : v)),
      })),
    })),

  removeVariable: (bpId, varId) =>
    set((state) => {
      // Surface dangling references — deleting a var that's still used would
      // silently break those reads (they'd resolve to 0/empty at runtime).
      const owner = state.project.blueprints.find((b) => b.id === bpId)
        ?? state.project.uiWidgets.find((w) => w.id === bpId);
      const target = owner?.variables?.find((v) => v.id === varId);
      if (owner && target) {
        const uses = findVarUsages(state.project, bpId, owner.name, target.name);
        if (uses.length > 0) {
          console.warn(`[Peaky] Deleted variable "${target.name}" is still referenced in ${uses.length} place(s):`,
            uses.map((u) => `${u.where} — ${u.detail}`).join("; "));
        }
      }
      return {
        project: mapBlueprint(state.project, bpId, (bp) => ({
          ...bp,
          variables: bp.variables.filter((v) => v.id !== varId),
        })),
      };
    }),

  // ----------------- Input Actions -----------------
  addInputAction: (name, group) => {
    const id = newId("inact");
    const baseName = name ?? "NewAction";
    set((state) => {
      let unique = baseName;
      let n = 2;
      while (state.project.inputActions.some((a) => a.name === unique)) unique = `${baseName}${n++}`;
      const action: InputActionDef = { id, name: unique, keys: [], group: group || undefined };
      return { project: { ...state.project, inputActions: [...state.project.inputActions, action] } };
    });
    return id;
  },

  renameInputAction: (id, name) =>
    set((state) => {
      if (state.project.inputActions.some((a) => a.id !== id && a.name === name)) return state;
      const target = state.project.inputActions.find((a) => a.id === id);
      if (!target) return state;
      const oldName = target.name;
      // Don't cascade through every field if either side of the rename is
      // empty — `String(undefined ?? "") === ""` would otherwise match
      // every undefined action field on every CM, and we'd either clear
      // working refs to "" (when name=="") or stamp them with whatever
      // name is being typed mid-edit (when oldName==""). The InputAction's
      // own name still gets updated below; only the cascade is skipped.
      const ACTION_FIELDS = ["leftAction", "rightAction", "jumpAction", "dashAction"] as const;
      const skipCascade = oldName === "" || name === "";
      const blueprints = skipCascade
        ? state.project.blueprints
        : state.project.blueprints.map((bp) => {
            const behaviors = bp.behaviors.map((b) => {
              if (b.kind !== "CharacterMovement") return b;
              let touched = false;
              const config = { ...b.config };
              for (const field of ACTION_FIELDS) {
                // Strict equality on the actual stored value, NOT through
                // `?? ""`, so undefined fields never falsely match.
                if (config[field] === oldName) {
                  config[field] = name;
                  touched = true;
                }
              }
              return touched ? { ...b, config } : b;
            });
            const events = transformAllEvents(bp.events, (ev) => ({
              ...ev,
              conditions: ev.conditions.map((c) => {
                if (c.kind === "OnKeyPressed" || c.kind === "OnKeyReleased" || c.kind === "OnKeyHeld") {
                  if (!c.actions || !c.actions.includes(oldName)) return c;
                  return { ...c, actions: c.actions.map((a) => (a === oldName ? name : a)) };
                }
                if (c.kind === "IsActionHeld" && c.action === oldName) {
                  return { ...c, action: name };
                }
                return c;
              }),
            }));
            return { ...bp, behaviors, events };
          });
      return {
        project: {
          ...state.project,
          inputActions: state.project.inputActions.map((a) => (a.id === id ? { ...a, name } : a)),
          blueprints,
        },
      };
    }),

  setInputActionKeys: (id, keys) =>
    set((state) => ({
      project: {
        ...state.project,
        inputActions: state.project.inputActions.map((a) => (a.id === id ? { ...a, keys } : a)),
      },
    })),

  removeInputAction: (id) =>
    set((state) => {
      const target = state.project.inputActions.find((a) => a.id === id);
      if (!target) return state;
      // Strip the deleted action from any condition OR CharacterMovement
      // behavior config that referenced it. The behavior pass mirrors the
      // condition pass so a deleted action can't leave a CM with a stale
      // dashAction / jumpAction / etc. pointing at a non-existent name.
      // Strict equality only — never match undefined via `?? ""`.
      const ACTION_FIELDS = ["leftAction", "rightAction", "jumpAction", "dashAction"] as const;
      const blueprints = target.name === ""
        ? state.project.blueprints
        : state.project.blueprints.map((bp) => {
        const behaviors = bp.behaviors.map((b) => {
          if (b.kind !== "CharacterMovement") return b;
          let touched = false;
          const config = { ...b.config };
          for (const field of ACTION_FIELDS) {
            if (config[field] === target.name) {
              config[field] = "";
              touched = true;
            }
          }
          return touched ? { ...b, config } : b;
        });
        const events = transformAllEvents(bp.events, (ev) => ({
          ...ev,
          conditions: ev.conditions
            .map((c) => {
              if (c.kind === "OnKeyPressed" || c.kind === "OnKeyReleased" || c.kind === "OnKeyHeld") {
                if (!c.actions || !c.actions.includes(target.name)) return c;
                return { ...c, actions: c.actions.filter((a) => a !== target.name) };
              }
              if (c.kind === "IsActionHeld" && c.action === target.name) {
                return { ...c, action: "" };
              }
              return c;
            }),
        }));
        return { ...bp, behaviors, events };
      });
      return {
        project: {
          ...state.project,
          inputActions: state.project.inputActions.filter((a) => a.id !== id),
          blueprints,
        },
      };
    }),

  addInputActionGroup: (name) =>
    set((state) => {
      const groups = state.project.inputActionGroups ?? [];
      const base = name ?? "New Group";
      let unique = base;
      let n = 2;
      while (groups.includes(unique)) unique = `${base} ${n++}`;
      return { project: { ...state.project, inputActionGroups: [...groups, unique] } };
    }),

  renameInputActionGroup: (oldName, newName) =>
    set((state) => {
      const trimmed = newName.trim();
      const groups = state.project.inputActionGroups ?? [];
      // No-op on blank or a name that already exists (keeps groups unique).
      if (!trimmed || (trimmed !== oldName && groups.includes(trimmed))) return state;
      return {
        project: {
          ...state.project,
          inputActionGroups: groups.map((g) => (g === oldName ? trimmed : g)),
          inputActions: state.project.inputActions.map((a) => (a.group === oldName ? { ...a, group: trimmed } : a)),
        },
      };
    }),

  removeInputActionGroup: (name) =>
    set((state) => ({
      project: {
        ...state.project,
        inputActionGroups: (state.project.inputActionGroups ?? []).filter((g) => g !== name),
        // Its actions survive — they just become ungrouped (group cleared).
        inputActions: state.project.inputActions.map((a) => (a.group === name ? { ...a, group: undefined } : a)),
      },
    })),

  moveInputAction: (id, group, beforeId) =>
    set((state) => {
      const list = [...state.project.inputActions];
      const idx = list.findIndex((a) => a.id === id);
      if (idx < 0) return state;
      const g = group || undefined;
      const [moved] = list.splice(idx, 1);
      moved.group = g;
      let insertAt: number;
      if (beforeId) {
        insertAt = list.findIndex((a) => a.id === beforeId);
        if (insertAt < 0) insertAt = list.length;
      } else {
        // No anchor → append after the last action already in this group, so
        // the moved item lands at the bottom of its group's run.
        let last = -1;
        list.forEach((a, i) => { if ((a.group ?? "") === (g ?? "")) last = i; });
        insertAt = last < 0 ? list.length : last + 1;
      }
      list.splice(insertAt, 0, moved);
      return { project: { ...state.project, inputActions: list } };
    }),

  // ----------------- Signals -----------------
  addSignal: (name) => {
    const id = newId("sig");
    set((state) => {
      const baseName = name ?? "MySignal";
      let unique = baseName;
      let n = 2;
      while (state.project.signals.some((s) => s.name === unique)) unique = `${baseName}${n++}`;
      const sig: SignalDef = { id, name: unique };
      return { project: { ...state.project, signals: [...state.project.signals, sig] } };
    });
    return id;
  },

  renameSignal: (id, name) =>
    set((state) => {
      if (state.project.signals.some((s) => s.id !== id && s.name === name)) return state;
      const target = state.project.signals.find((s) => s.id === id);
      if (!target) return state;
      const oldName = target.name;
      // Cascade-rename: EmitSignal actions, OnSignal conditions, IsSignalFiring
      // conditions all follow the rename. Walks the full event tree.
      const blueprints = state.project.blueprints.map((bp) => ({
        ...bp,
        events: transformAllEvents(bp.events, (ev) => ({
          ...ev,
          conditions: ev.conditions.map((c) => {
            if (c.kind === "OnSignal" && c.signals && c.signals.includes(oldName)) {
              return { ...c, signals: c.signals.map((s) => (s === oldName ? name : s)) };
            }
            if (c.kind === "IsSignalFiring" && c.signal === oldName) {
              return { ...c, signal: name };
            }
            return c;
          }),
          actions: ev.actions.map((a) =>
            a.kind === "EmitSignal" && a.config.name === oldName
              ? { ...a, config: { ...a.config, name } }
              : a,
          ),
        })),
      }));
      return {
        project: {
          ...state.project,
          signals: state.project.signals.map((s) => (s.id === id ? { ...s, name } : s)),
          blueprints,
        },
      };
    }),

  removeSignal: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        signals: state.project.signals.filter((s) => s.id !== id),
      },
    })),

  // ─── Global variables ────────────────────────────────────────────────
  addGlobalVariable: (name) => {
    const id = newId("glob");
    set((state) => {
      const list = state.project.globalVariables ?? [];
      const baseName = name ?? "myGlobal";
      let unique = baseName;
      let n = 2;
      while (list.some((g) => g.name === unique)) unique = `${baseName}${n++}`;
      const def: GlobalVarDef = { id, name: unique, type: "number", default: 0 };
      return { project: { ...state.project, globalVariables: [...list, def] } };
    });
    return id;
  },

  renameGlobalVariable: (id, name) =>
    set((state) => {
      const list = state.project.globalVariables ?? [];
      if (list.some((g) => g.id !== id && g.name === name)) return state;
      return {
        project: {
          ...state.project,
          globalVariables: list.map((g) => (g.id === id ? { ...g, name } : g)),
        },
      };
    }),

  setGlobalVariableType: (id, type) =>
    set((state) => {
      const list = state.project.globalVariables ?? [];
      const coerce = (cur: number | string | boolean): number | string | boolean => {
        if (type === "number") return Math.round(Number(cur)) || 0;
        if (type === "float") return Number(cur) || 0;
        if (type === "boolean") return cur === true || cur === "true" || cur === 1;
        return String(cur);
      };
      return {
        project: {
          ...state.project,
          globalVariables: list.map((g) => (g.id === id ? { ...g, type, default: coerce(g.default) } : g)),
        },
      };
    }),

  setGlobalVariableDefault: (id, value) =>
    set((state) => {
      const list = state.project.globalVariables ?? [];
      return {
        project: {
          ...state.project,
          globalVariables: list.map((g) => (g.id === id ? { ...g, default: value } : g)),
        },
      };
    }),

  setGlobalVariableIsArray: (id, isArray) =>
    set((state) => {
      const list = state.project.globalVariables ?? [];
      return {
        project: {
          ...state.project,
          globalVariables: list.map((g) =>
            g.id === id ? { ...g, isArray, items: g.items ?? [] } : g,
          ),
        },
      };
    }),

  setGlobalVariableItems: (id, items) =>
    set((state) => {
      const list = state.project.globalVariables ?? [];
      return {
        project: {
          ...state.project,
          globalVariables: list.map((g) => (g.id === id ? { ...g, items } : g)),
        },
      };
    }),

  removeGlobalVariable: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        globalVariables: (state.project.globalVariables ?? []).filter((g) => g.id !== id),
      },
    })),

  // ─── Read-only Lists ─────────────────────────────────────────────────
  addList: (name) => {
    const id = newId("list");
    set((state) => {
      const lists = state.project.lists ?? [];
      const baseName = name ?? "myList";
      let unique = baseName;
      let n = 2;
      while (lists.some((l) => l.name === unique)) unique = `${baseName}${n++}`;
      const def: ListDef = { id, name: unique, type: "number", entries: [] };
      return { project: { ...state.project, lists: [...lists, def] } };
    });
    return id;
  },

  renameList: (id, name) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      if (lists.some((l) => l.id !== id && l.name === name)) return state;
      return {
        project: { ...state.project, lists: lists.map((l) => (l.id === id ? { ...l, name } : l)) },
      };
    }),

  setListType: (id, type) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          // List `type` is the DEFAULT for entries without their own override.
          // Re-coerce only those (entries with an explicit `type` keep theirs).
          lists: lists.map((l) =>
            l.id === id ? { ...l, type, entries: l.entries.map((e) => (e.type ? e : { ...e, value: coerceListValue(e.value, type) })) } : l,
          ),
        },
      };
    }),

  setListEntryType: (listId, entryId, type) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          lists: lists.map((l) => {
            if (l.id !== listId) return l;
            return {
              ...l,
              entries: l.entries.map((e) => {
                if (e.id !== entryId) return e;
                // Clearing the override (undefined) → follow the list default.
                const eff = type ?? l.type;
                const next: ListEntry = { ...e, value: coerceListValue(e.value, eff) };
                if (type) next.type = type; else delete next.type;
                return next;
              }),
            };
          }),
        },
      };
    }),

  addListEntry: (listId) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          lists: lists.map((l) => {
            if (l.id !== listId) return l;
            let base = "key";
            let unique = base;
            let n = 1;
            while (l.entries.some((e) => e.name === unique)) unique = `${base}${++n}`;
            const entry: ListEntry = {
              id: newId("lent"),
              name: unique,
              value: l.type === "string" ? "" : l.type === "boolean" ? false : 0,
            };
            return { ...l, entries: [...l.entries, entry] };
          }),
        },
      };
    }),

  renameListEntry: (listId, entryId, name) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          lists: lists.map((l) => {
            if (l.id !== listId) return l;
            if (l.entries.some((e) => e.id !== entryId && e.name === name)) return l;
            return { ...l, entries: l.entries.map((e) => (e.id === entryId ? { ...e, name } : e)) };
          }),
        },
      };
    }),

  setListEntryValue: (listId, entryId, value) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          lists: lists.map((l) =>
            l.id !== listId ? l : { ...l, entries: l.entries.map((e) => (e.id === entryId ? { ...e, value } : e)) },
          ),
        },
      };
    }),

  removeListEntry: (listId, entryId) =>
    set((state) => {
      const lists = state.project.lists ?? [];
      return {
        project: {
          ...state.project,
          lists: lists.map((l) => (l.id !== listId ? l : { ...l, entries: l.entries.filter((e) => e.id !== entryId) })),
        },
      };
    }),

  removeList: (id) =>
    set((state) => ({
      project: { ...state.project, lists: (state.project.lists ?? []).filter((l) => l.id !== id) },
    })),

  // ----------------- Instances -----------------
  placeInstance: (blueprintId, x = 100, y = 100) => {
    const id = newId("inst");
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        // Drop new placements onto whichever layer is currently active.
        instances: [...sc.instances, { id, blueprintId, x, y, layerId: sc.activeLayerId }],
      })),
      selectedInstanceId: id,
      view: "scene",
    }));
    return id;
  },

  duplicateSelection: (ids, dx = 16, dy = 16) => {
    const idSet = new Set(ids);
    const newIds: string[] = [];
    const clone = <T extends { id: string; x: number; y: number }>(arr: T[], prefix: string): T[] => {
      const extra: T[] = [];
      for (const it of arr) {
        if (!idSet.has(it.id)) continue;
        const nid = newId(prefix);
        newIds.push(nid);
        extra.push({ ...structuredClone(it), id: nid, x: it.x + dx, y: it.y + dy });
      }
      return extra;
    };
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        instances: [...sc.instances, ...clone(sc.instances, "inst")],
        uiInstances: [...(sc.uiInstances ?? []), ...clone(sc.uiInstances ?? [], "uiinst")],
        tilemapInstances: [...(sc.tilemapInstances ?? []), ...clone(sc.tilemapInstances ?? [], "tminst")],
        spritePlacements: [...(sc.spritePlacements ?? []), ...clone(sc.spritePlacements ?? [], "splc")],
      })),
    }));
    return newIds;
  },

  // ----------------- UI Widget Instances -----------------
  placeUIWidgetInstance: (uiWidgetId, x = 100, y = 100) => {
    const id = newId("uiinst");
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => {
        // Prefer placing UI widgets on a parallax-(0,0) layer so anchor
        // math + viewport-relative child positions work correctly. If
        // the active layer parallaxes, look for the first existing
        // (0,0) layer; if none exists, fall back to the active layer
        // and let the runtime warn (`renderOnMainCamera` path is OK
        // for diegetic widgets but breaks anchored UI). The doc comment
        // on UIWidgetInstance promised this enforcement; it was unwired.
        const active = sc.layers.find((l) => l.id === sc.activeLayerId);
        const activeIsUI = !!active && active.parallaxX === 0 && active.parallaxY === 0;
        const fallback = activeIsUI ? sc.activeLayerId : (sc.layers.find((l) => l.parallaxX === 0 && l.parallaxY === 0)?.id ?? sc.activeLayerId);
        if (!activeIsUI && fallback !== sc.activeLayerId) {
          console.warn(`[Peaky] UI widget placed on non-parallax-0 layer "${active?.name ?? "?"}" — auto-routing to "${sc.layers.find((l) => l.id === fallback)?.name ?? "?"}". Use a parallax-(0,0) layer for camera-locked UI.`);
        }
        return {
          ...sc,
          uiInstances: [
            ...(sc.uiInstances ?? []),
            { id, uiWidgetId, x, y, layerId: fallback },
          ],
        };
      }),
      selectedInstanceId: id,
      view: "scene",
    }));
    return id;
  },

  updateUIWidgetInstance: (id, patch) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        uiInstances: (sc.uiInstances ?? []).map((i) =>
          i.id === id ? { ...i, ...patch } : i,
        ),
      })),
    })),

  removeUIWidgetInstance: (id) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        uiInstances: (sc.uiInstances ?? []).filter((i) => i.id !== id),
      })),
      selectedInstanceId:
        state.selectedInstanceId === id ? null : state.selectedInstanceId,
    })),

  updateInstance: (id, patch) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        instances: sc.instances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
      })),
    })),

  setInstanceVar: (id, name, value) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        instances: sc.instances.map((i) => {
          if (i.id !== id) return i;
          const vars = { ...(i.vars ?? {}), [name]: value };
          return { ...i, vars };
        }),
      })),
    })),

  clearInstanceVar: (id, name) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        instances: sc.instances.map((i) => {
          if (i.id !== id) return i;
          if (!i.vars || !(name in i.vars)) return i;
          const { [name]: _drop, ...rest } = i.vars;
          void _drop;
          // If the override map is now empty, drop the field entirely
          // so saved JSON stays compact and migration logic can rely on
          // "vars present → user has set something".
          if (Object.keys(rest).length === 0) {
            const { vars: _v, ...instWithoutVars } = i;
            void _v;
            return instWithoutVars;
          }
          return { ...i, vars: rest };
        }),
      })),
    })),

  removeInstance: (id) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        instances: sc.instances.filter((i) => i.id !== id),
      })),
      selectedInstanceId: state.selectedInstanceId === id ? null : state.selectedInstanceId,
    })),

  addSpritePlacement: (spriteId, x, y) => {
    const id = `sp-${Math.random().toString(36).slice(2, 10)}`;
    set((state) => {
      const sprite = state.project.sprites.find((s) => s.id === spriteId);
      // Auto-name with the sprite asset's name + a numeric suffix when
      // an existing placement already uses the bare name. Logic Sheet
      // dropdowns key off `name`, so an empty default means the
      // placement is invisible to actions until the author renames it.
      const baseName = sprite?.name ?? "SpriteObject";
      const sc0 = state.project.scenes.find((s) => s.id === state.project.activeSceneId);
      const taken = new Set((sc0?.spritePlacements ?? []).map((p) => p.name));
      let name = baseName;
      let n = 2;
      while (taken.has(name)) name = `${baseName}_${n++}`;
      return ({
      project: mapActiveScene(state.project, (sc) => {
        const placement: SpritePlacement = {
          id,
          name,
          spriteId,
          x, y,
          scaleX: 1, scaleY: 1,
          rotation: 0,
          alpha: 1,
          flipX: false, flipY: false,
          layerId: sc.activeLayerId,
          animation: "",
          startFrame: 0,
          playing: true,
          visible: true,
          // Fit-to-sprite is the common case for walls / props. Author
          // can flip off in the inspector to set explicit collider dims.
          colliderFitSprite: true,
        };
        const existing = sc.spritePlacements ?? [];
        return { ...sc, spritePlacements: [...existing, placement] };
      }),
      // Auto-select the new placement so the inspector reflects it.
      selectedInstanceId: id,
      });
    });
    return id;
  },

  updateSpritePlacement: (id, patch) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        spritePlacements: (sc.spritePlacements ?? []).map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      })),
    })),

  removeSpritePlacement: (id) =>
    set((state) => ({
      project: mapActiveScene(state.project, (sc) => ({
        ...sc,
        spritePlacements: (sc.spritePlacements ?? []).filter((p) => p.id !== id),
      })),
      selectedInstanceId: state.selectedInstanceId === id ? null : state.selectedInstanceId,
    })),

  setRunning: (v) => set({ isRunning: v }),
  setAutosaveStatus: (v, info) => set({
    autosaveStatus: v,
    autosaveError: v === "broken" ? (info?.error ?? null) : null,
    autosaveGuard: v === "broken" ? !!info?.guard : false,
  }),

  cleanupOrphans: async () => {
    const store = getActiveAssetStore();
    if (!store) return { removedCount: 0, removedPaths: [] };
    const project = get().project;
    // Build the COMPLETE set of every disk path the project references.
    // Previously this only counted binary assets (sprite PNGs, atlas
    // images, audio, fonts) and forgot the per-asset .json metadata files,
    // so the sweep would delete every blueprint / scene / sprite-meta
    // file — catastrophic. The fixed set covers both halves.
    const referenced = new Set<string>();
    // JSON metadata files (one per asset).
    for (const bp of project.blueprints) referenced.add(blueprintDiskPath(bp));
    for (const sc of project.scenes)     referenced.add(sceneDiskPath(sc));
    for (const sp of project.sprites)    referenced.add(spriteMetaDiskPath(sp));
    for (const ts of project.tilesets ?? [])  referenced.add(tilesetMetaDiskPath(ts));
    for (const tm of project.tilemaps ?? [])  referenced.add(tilemapDiskPath(tm));
    for (const d  of project.dialogues)  referenced.add(dialogueDiskPath(d));
    for (const w  of project.uiWidgets)  referenced.add(uiWidgetDiskPath(w));
    for (const it of project.items ?? [])     referenced.add(itemDiskPath(it));
    for (const r  of project.recipes ?? [])   referenced.add(recipeDiskPath(r));
    // Binary asset files.
    for (const sp of project.sprites) {
      for (const anim of sp.animations) {
        for (const f of anim.frames) {
          if (f.imageFile) referenced.add(spriteFrameDiskPath(sp, f.imageFile));
        }
      }
    }
    for (const ts of project.tilesets ?? []) {
      if (ts.imageFile) referenced.add(tilesetImagePath(ts));
      // Keep the Manual Tile Builder's raw source sheet (else re-edit/re-bake breaks).
      if (ts.manualSourceFile) referenced.add(tilesetImagePath({ ...ts, imageFile: ts.manualSourceFile }));
    }
    for (const snd of project.sounds ?? []) {
      if (snd.file) referenced.add(soundDiskPath(snd));
    }
    for (const fnt of project.fonts ?? []) {
      if (fnt.file) referenced.add(fontDiskPath(fnt));
    }
    // Walk assets/ and delete anything not referenced. The manifest itself
    // (project.peaky.json) lives at project root, not under assets/, so
    // can't be hit accidentally.
    const removed: string[] = [];
    for await (const path of store.walkFiles("assets")) {
      if (referenced.has(path)) continue;
      await store.deleteFile(path);
      removed.push(path);
    }
    return { removedCount: removed.length, removedPaths: removed };
  },
  loadProject: (p) => {
    _skipSnap = true;
    // Kill any pending debounced snapshot from the OUTGOING project — otherwise
    // its late timer fires after load and pushes a foreign project state into
    // the new project's undo stack (first Ctrl+Z jumps to the old project).
    if (_snapTimer !== undefined) { clearTimeout(_snapTimer); _snapTimer = undefined; }
    _burstPrevProject = null;
    try {
      const migrated = migrateProject(p);
      set({
        project: migrated,
        openSceneIds: [migrated.activeSceneId],
        openBlueprintIds: [],
        openSpriteIds: [],
        openDialogueIds: [],
        openUIWidgetIds: [],
        activeTab: { kind: "scene" },
        past: [],
        future: [],
        selectedInstanceId: null,
        selectedBlueprintId: null,
        isRunning: false,
      });
    } catch (e) {
      // A corrupt / incompatible / hand-edited .peaky.json must NOT white-screen
      // the editor — keep the current project loaded and tell the user.
      console.error("[Peaky] Failed to load project — file is corrupt or incompatible.", e);
      if (typeof window !== "undefined") {
        window.alert("Couldn't open this project — the file looks corrupt or incompatible. Your current project is unchanged.");
      }
    } finally {
      _skipSnap = false;
    }
  },
}));

// Debug — exposes the store on window so you can poke at project state from
// devtools console. DEV-only: a public build must not expose the whole store
// (any site script could mutate the user's project through it).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as { peaky: typeof useEditor }).peaky = useEditor;
}

/**
 * Forward-compat for any pre-v3 project shape. Strips the dropped surfaces:
 *   • `stateMachines` (state machines)
 *   • `graph` (UE5 node graph)
 *   • old recursive `events` (with `condition` + `children`)
 *
 * Also upgrades early-v3 events authored before the multi-payload trigger /
 * guardCombinator landing:
 *   • singular `action` → `actions: [action]`
 *   • singular `tag`    → `tags: [tag]`
 *   • singular `event`  → `events: [event]`
 *   • missing `guardCombinator` → `"AND"`
 *
 * Old events with the recursive `condition+children` shape are wiped since
 * that schema is incompatible.
 */
function migrateProject(p: PeakyProject): PeakyProject {
  /**
   * Pre-v5 events used a separate `trigger` field + `guards` array. We
   * convert each old event into a single PeakyEvent with all conditions in
   * one list (Construct-3 model). Lots of legacy shape variants are handled.
   */
  type LegacyBp = BlueprintDef & {
    stateMachines?: unknown;
    graph?: unknown;
  };
  type LegacyTrigger = {
    kind: string;
    action?: string;
    actions?: string[];
    tag?: string;
    tags?: string[];
    event?: string;
    events?: string[];
    signals?: string[];
    animation?: string;
  };
  type LegacyEvent = {
    id?: string;
    // Old shape (trigger + guards split):
    trigger?: LegacyTrigger;
    guardCombinator?: "AND" | "OR";
    guards?: unknown[];
    // New shape (already PeakyEvent):
    kind?: PeakyEventKind;
    conditions?: unknown[];
    children?: unknown[];
    // Common:
    actions?: StateAction[];
    text?: string;
    groupId?: string;
    disabled?: boolean;
    // Even older recursive shape (Construct-style v0):
    condition?: unknown;
  };

  /** Coerce a legacy trigger blob into a normalized Condition row. */
  const triggerToCondition = (t: LegacyTrigger | undefined): Condition | null => {
    if (!t || !t.kind) return null;
    const id = newId("cond");
    if (t.kind === "OnKeyPressed" || t.kind === "OnKeyReleased" || t.kind === "OnKeyHeld") {
      const arr = Array.isArray(t.actions) ? t.actions : t.action ? [t.action] : [];
      return { id, kind: t.kind as ConditionKind, actions: arr };
    }
    if (t.kind === "OnCollide" || t.kind === "OnOverlap") {
      const arr = Array.isArray(t.tags) ? t.tags : t.tag ? [t.tag] : [];
      return { id, kind: t.kind as ConditionKind, tags: arr };
    }
    if (t.kind === "OnEvent" || t.kind === "OnSignal") {
      // Both old name (OnEvent) and new (OnSignal) → unified OnSignal.
      const arr = Array.isArray(t.signals) ? t.signals
                : Array.isArray(t.events) ? t.events
                : t.event ? [t.event] : [];
      return { id, kind: "OnSignal", signals: arr };
    }
    if (t.kind === "OnAnimationEnd") {
      return { id, kind: "OnAnimationEnd", animation: t.animation ?? "" };
    }
    if (t.kind === "OnStep" || t.kind === "OnCreate" || t.kind === "OnLand" || t.kind === "OnJump" || t.kind === "OnFall" || t.kind === "OnDashStart" || t.kind === "OnDashEnd") {
      return { id, kind: t.kind as ConditionKind };
    }
    return null;
  };

  /** Coerce a legacy guard (Condition pre-id) → modern Condition with id + signal-rename. */
  const fixGuard = (g: unknown): Condition => {
    const c = (g ?? {}) as Condition & { event?: string };
    const next: Condition = { ...c, id: c.id ?? newId("cond") };
    // Old "IsEventFiring" → "IsSignalFiring" with field rename.
    if ((next.kind as string) === "IsEventFiring") {
      next.kind = "IsSignalFiring";
      const oldEvent = (c as { event?: string }).event;
      if (oldEvent && !next.signal) next.signal = oldEvent;
      delete (next as { event?: string }).event;
    }
    return next;
  };

  /** Convert a legacy event blob into a PeakyEvent. */
  const upgradeEvent = (raw: LegacyEvent): PeakyEvent => {
    // Already a PeakyEvent? Trust it (after walking children + cleaning up
    // any old `or`/`else` kinds — those were an earlier shape we dropped).
    if (raw.kind && Array.isArray(raw.conditions) && Array.isArray(raw.children)) {
      const oldKind = raw.kind as string;
      let kind: PeakyEventKind;
      let combinator: "AND" | "OR" | undefined;
      let conditions = raw.conditions.map(fixGuard);
      if (oldKind === "or") {
        kind = "event";
        combinator = "OR";
      } else if (oldKind === "else") {
        // Migrate "else" event → regular event with an `Else` condition.
        kind = "event";
        combinator = "AND";
        conditions = [{ id: newId("cond"), kind: "Else" }, ...conditions];
      } else if (oldKind === "comment") {
        kind = "comment";
      } else if (oldKind === "group") {
        kind = "group";
      } else {
        kind = "event";
        combinator = (raw as { combinator?: "AND" | "OR" }).combinator;
      }
      // CRITICAL: copy through `pageId` so multi-page event sheets survive
      // a reload. Without this, every event got rebuilt without pageId on
      // every load, then a later backfill pass reassigned them all to
      // Page 1 — so events authored on Page 2+ would silently migrate to
      // Page 1 every refresh.
      return {
        id: String(raw.id ?? newId("evt")),
        kind,
        combinator,
        conditions,
        actions: (raw.actions ?? []).map((a) => {
          if ((a.kind as string) === "EmitEvent") return { ...a, kind: "EmitSignal" as StateActionKind };
          return a;
        }),
        children: (raw.children as LegacyEvent[]).map(upgradeEvent),
        text: raw.text,
        groupId: raw.groupId,
        disabled: raw.disabled,
        pageId: (raw as { pageId?: string }).pageId,
      };
    }
    // Legacy trigger+guards → unified conditions (trigger first, guards after).
    const triggerCond = triggerToCondition(raw.trigger);
    const guardConds = (raw.guards ?? []).map(fixGuard);
    const conditions: Condition[] = triggerCond ? [triggerCond, ...guardConds] : guardConds;
    return {
      id: String(raw.id ?? newId("evt")),
      kind: "event",
      combinator: raw.guardCombinator === "OR" ? "OR" : undefined,
      conditions,
      actions: (raw.actions ?? []).map((a) => {
        if ((a.kind as string) === "EmitEvent") return { ...a, kind: "EmitSignal" as StateActionKind };
        return a;
      }),
      children: [],
      groupId: raw.groupId,
      disabled: raw.disabled,
      pageId: (raw as { pageId?: string }).pageId,
    };
  };

  let stripped = false;
  // Hand-edited / truncated project files can arrive with a non-array (or
  // missing) `blueprints` — coerce to [] so migration never throws on `.map`.
  const blueprints = (Array.isArray(p.blueprints) ? p.blueprints : []).map((raw) => {
    const bp = raw as LegacyBp;
    let touched = false;

    let next: BlueprintDef = bp;
    if (bp.stateMachines !== undefined || bp.graph !== undefined) {
      const { stateMachines: _sm, graph: _g, ...rest } = bp;
      void _sm; void _g;
      next = rest as BlueprintDef;
      touched = true;
    }

    // Convert events to PeakyEvent shape (handles all legacy variants).
    const legacyEvents = (next.events ?? []) as unknown as LegacyEvent[];
    const upgradedEvents = legacyEvents.map(upgradeEvent);
    // Detect change: shape diff is enough; rather than diffing deeply, just
    // always replace and let the equality check handle it.
    if (legacyEvents.length > 0 || (next.events as unknown[])?.length !== upgradedEvents.length) {
      // Compare a JSON proxy to skip the obvious "no change" case.
      const beforeKeys = legacyEvents[0] && (legacyEvents[0] as Record<string, unknown>).trigger !== undefined;
      if (beforeKeys || legacyEvents.some((e) => e.condition !== undefined)) {
        // Was old shape — now upgraded.
        next = { ...next, events: upgradedEvents };
        touched = true;
      } else {
        // Already PeakyEvent shape — but `upgradeEvent` still ran fixGuard on
        // each condition (e.g. assigning ids). Adopt result.
        next = { ...next, events: upgradedEvents };
      }
    } else {
      next = { ...next, events: upgradedEvents };
    }

    // Drop behaviors with kinds that no longer exist (legacy Platformer,
    // MoveLR, Gravity, etc. — consolidated into CharacterMovement). Keep
    // this list in sync with BehaviorKind in project.ts; missing entries
    // here silently delete user-added behaviors on reload.
    const KNOWN_KINDS = new Set<string>(["Solid", "JumpThru", "CharacterMovement", "TopdownMovement", "SpriteRenderer", "Collider", "Text", "Camera", "Tracer", "SquashStretch", "UIWidgetRenderer", "ParticleEmitter", "Damageable", "StateMachine", "AIBrain", "PhaseManager", "Widget", "SmartTween", "Projectile", "Inventory", "TilemapRenderer", "VisionMask", "MoveTo", "TiledBackground", "WeaponSlot", "Dismemberment", "Outline", "Shadow", "LightSource", "Weather"]);
    const filteredBehaviors = next.behaviors.filter((b) => KNOWN_KINDS.has(b.kind));
    if (filteredBehaviors.length !== next.behaviors.length) {
      // Loud warn so a forgotten KNOWN_KINDS entry doesn't silently delete
      // legitimate behaviors on every project load. (audit HIGH #22)
      const stripped = next.behaviors.filter((b) => !KNOWN_KINDS.has(b.kind)).map((b) => b.kind);
      console.warn(`[Peaky] Blueprint "${next.name ?? next.id}" had unknown behavior kinds — stripped on load: ${[...new Set(stripped)].join(", ")}. If these are new behaviors, add them to KNOWN_KINDS in store.ts:migrateProject.`);
      next = { ...next, behaviors: filteredBehaviors };
      touched = true;
    }

    // Ensure eventGroups field exists (added with the Groups feature).
    if (!Array.isArray((next as { eventGroups?: unknown }).eventGroups)) {
      next = { ...next, eventGroups: [] };
      touched = true;
    }

    // Ensure eventPages exists (Construct-style multi-page event sheets). If
    // missing, create a single default page and assign every existing
    // top-level event to it. Sub-events inherit page through their parent.
    const hasPages = Array.isArray((next as { eventPages?: unknown }).eventPages)
      && (next as { eventPages: unknown[] }).eventPages.length > 0;
    if (!hasPages) {
      const defaultPage = { id: "p_main", name: "Page 1" };
      next = {
        ...next,
        eventPages: [defaultPage],
        events: next.events.map((ev) => ({
          ...ev,
          pageId: ev.pageId ?? defaultPage.id,
        })),
      };
      touched = true;
    } else {
      // Pages exist but some events may be missing pageId — backfill to first page.
      const firstPageId = next.eventPages[0].id;
      let needsBackfill = false;
      const fixed = next.events.map((ev) => {
        if (ev.pageId) return ev;
        needsBackfill = true;
        return { ...ev, pageId: firstPageId };
      });
      if (needsBackfill) {
        next = { ...next, events: fixed };
        touched = true;
      }
    }

    // Variables: add `type` field if missing (pre-typed-vars projects).
    {
      let varsTouched = false;
      const newVars = next.variables.map((v) => {
        if ((v as { type?: unknown }).type) return v;
        varsTouched = true;
        return { ...v, type: "number" as const };
      });
      if (varsTouched) {
        next = { ...next, variables: newVars };
        touched = true;
      }
    }

    if (touched) stripped = true;
    return next;
  });

  // Project-level: customEvents → signals.
  let signals = p.signals;
  const oldCustomEvents = (p as { customEvents?: { id: string; name: string }[] }).customEvents;
  if (!Array.isArray(signals) && Array.isArray(oldCustomEvents)) {
    signals = oldCustomEvents;
    stripped = true;
  } else if (!Array.isArray(signals)) {
    signals = [];
  }

  if (stripped) {
    console.log("[Peaky] migrated project shape: renamed Custom Events → Signals, EmitEvent → EmitSignal, OnEvent → OnSignal, IsEventFiring → IsSignalFiring; stripped legacy components / SM / graph and/or upgraded event triggers");
  }

  // Drop legacy field if present and return the v4 shape.
  const { customEvents: _drop, ...rest } = p as PeakyProject & { customEvents?: unknown };
  void _drop;

  // v5 → v6 migration: hard-remove the animator's per-state Events modal
  // data (config.events on CharacterAnimator) and Functions section
  // (config.functions). These have been replaced by the per-BP Logic
  // Sheet (`bp.logicSheet`) — a node-graph event system that lives at
  // the BP level rather than inside the animator. Initializing empty
  // `logicSheet` on every BP so the new UI has a stable home.
  if ((p as { version?: number }).version === undefined || (p as { version?: number }).version! < 6) {
    for (const bp of blueprints) {
      if (!bp.logicSheet) bp.logicSheet = { folders: [] };
      for (const b of bp.behaviors) {
        if (b.kind !== "StateMachine") continue;
        const cfg = b.config as Record<string, unknown>;
        if ("functions" in cfg) delete cfg.functions;
        const states = (cfg.states as Array<Record<string, unknown>> | undefined) ?? [];
        for (const st of states) {
          if ("events" in st) delete st.events;
        }
      }
    }
  }

  // Logic Sheet: events[] -> folders[] conversion. Each legacy single-
  // trigger event becomes its own folder with the trigger absorbed into
  // the graph as a regular node (kind="trigger"). Edges with sourceId
  // === event.trigger.id get rewritten to the new trigger node's id.
  // No version bump — the change is forward-compatible for fresh projects.
  for (const bp of blueprints) {
    const sheet = bp.logicSheet as ({ events?: unknown[]; folders?: unknown[] } | undefined);
    if (!sheet) { bp.logicSheet = { folders: [] }; continue; }
    if (Array.isArray(sheet.folders)) continue;
    const legacyEvents = (Array.isArray(sheet.events) ? sheet.events : []) as Array<{
      id: string; autoLabel?: string;
      trigger: { id: string; kind: string; params: Record<string, unknown>; position: { x: number; y: number } };
      graph: {
        nodes: Array<{ id: string; kind: string; type: string; params: Record<string, unknown>; position: { x: number; y: number } }>;
        edges: Array<{ id: string; source: string; sourcePin: string; target: string; targetPin: string; pinType: string }>;
      };
    }>;
    bp.logicSheet = {
      folders: legacyEvents.map((ev) => ({
        id: `fld-${ev.id}`,
        name: ev.autoLabel || ev.trigger.kind,
        graph: {
          nodes: [
            // Trigger absorbed as a regular graph node (kind="trigger").
            { id: ev.trigger.id, kind: "trigger", type: ev.trigger.kind, params: ev.trigger.params ?? {}, position: ev.trigger.position ?? { x: 40, y: 40 } } as never,
            ...ev.graph.nodes as never,
          ],
          edges: ev.graph.edges as never,
        },
      })),
    } as never;
  }

  // ── State-machine condition unification ──────────────────────────────
  // The StateMachine used to carry its own lowercase condition kinds
  // (conditionKind/conditionAction/conditionThreshold + extraConditions +
  // subConditions). They're now full Logic Sheet `Condition` objects
  // (primary/extras/subs). Convert any state still in the old shape so the
  // inspector (which reads state.primary.kind) doesn't crash on load. This
  // is a one-time data conversion, not a runtime shim — old fields are
  // dropped after the convert.
  const convertLegacyCond = (
    kind: string, action: string, threshold: number | string, action2?: string, negate?: boolean,
  ): Record<string, unknown> => {
    const t = threshold === undefined || threshold === "" ? 0 : threshold;
    const not = negate ? { not: true } : {};
    const M = (o: Record<string, unknown>) => ({ ...o, ...not });
    switch (kind) {
      case "always":            return M({ kind: "Always" });
      case "isMoving":          return M({ kind: "IsMoving", value: t });
      case "isMovingAny":       return M({ kind: "IsMovingAny", value: t });
      case "inputPressed":      return M({ kind: "OnKeyPressed", actions: action ? [action] : [] });
      case "inputBuffered":     return M({ kind: "InputBuffered", action });
      case "inputHeld":         return M({ kind: "IsActionHeld", action });
      case "velocityXAbove":    return M({ kind: "Compare", property: "velocity.x", op: ">", value: t });
      case "velocityXBelow":    return M({ kind: "Compare", property: "velocity.x", op: "<", value: t });
      case "velocityYAbove":    return M({ kind: "Compare", property: "velocity.y", op: ">", value: t });
      case "velocityYBelow":    return M({ kind: "Compare", property: "velocity.y", op: "<", value: t });
      case "isGrounded":        return M({ kind: "IsGrounded" });
      case "isAirborne":        return M({ kind: "IsAirborne" });
      case "isWallSliding":     return M({ kind: "IsWallSliding" });
      case "isByWallLeft":      return M({ kind: "IsByWallLeft" });
      case "isByWallRight":     return M({ kind: "IsByWallRight" });
      case "isByWall":          return M({ kind: "IsByWall" });
      case "isDashing":         return M({ kind: "IsDashing" });
      case "isWallJumping":     return M({ kind: "IsWallJumping" });
      case "isFacingLeft":      return M({ kind: "IsFacingLeft" });
      case "isFacingRight":     return M({ kind: "IsFacingRight" });
      case "facingDir":         return M({ kind: "IsTopdownFacing", direction: action });
      case "justLanded":        return M({ kind: "OnLand" });
      case "justTurnedLeft":    return M({ kind: "JustTurnedLeft" });
      case "justTurnedRight":   return M({ kind: "JustTurnedRight" });
      case "justWallJumped":    return M({ kind: "JustWallJumped" });
      case "varEquals":         return M({ kind: "CompareValues", left: `var:${action}`, op: "==", right: String(t) });
      case "varAbove":          return M({ kind: "CompareValues", left: `var:${action}`, op: ">",  right: String(t) });
      case "varBelow":          return M({ kind: "CompareValues", left: `var:${action}`, op: "<",  right: String(t) });
      case "varTrue":           return M({ kind: "CompareValues", left: `var:${action}`, op: "!=", right: "0" });
      case "varFalse":          return M({ kind: "CompareValues", left: `var:${action}`, op: "==", right: "0" });
      case "isAnimationPlaying":return M({ kind: "IsAnimationPlaying", animation: action });
      case "isState":           return M({ kind: "IsState", state: action });
      case "previousStateWas":  return M({ kind: "PreviousStateWas", state: action });
      case "previousAnimWas":   return M({ kind: "PreviousAnimWas", animation: action });
      case "isTracerHit":       return M({ kind: "IsTracerHit", tracer: action });
      case "tracerJustHit":     return M({ kind: "TracerJustHit", tracer: action });
      case "tracerHitHasTag":   return M({ kind: "TracerHitHasTag", tracer: action, tagValue: action2 ?? "" });
      case "signalFired":       return M({ kind: "IsSignalFiring", signal: action });
      case "signalFiredEdge":   return M({ kind: "SignalFiredEdge", signal: action });
      case "justCollidedWithTag":  return M({ kind: "JustCollidedWithTag", tag: action });
      case "isOverlappingTag":     return M({ kind: "IsOverlappingTag", tag: action });
      case "justSeparatedFromTag": return M({ kind: "JustSeparatedFromTag", tag: action });
      case "isAIState":         return M({ kind: "IsAIState", action });
      case "hasAITarget":       return M({ kind: "HasAITarget" });
      case "noAITarget":        return M({ kind: "NoAITarget" });
      case "isDead":            return M({ kind: "IsDead" });
      case "isInHitstun":       return M({ kind: "IsInHitstun" });
      case "isInIframes":       return M({ kind: "IsInIframes" });
      case "isJumping":         return M({ kind: "IsJumping" });
      case "isFalling":         return M({ kind: "IsFalling" });
      case "isRunning":         return M({ kind: "IsRunning" });
      case "canJump":           return M({ kind: "CanJump" });
      case "canDash":           return M({ kind: "CanDash" });
      case "isDoubleJumpEnabled": return M({ kind: "IsDoubleJumpEnabled" });
      case "isStateEnabled":    return M({ kind: "IsStateEnabled", state: action });
      default:                  return M({ kind: "Always" });
    }
  };
  const convertLegacyRow = (r: Record<string, unknown>): Record<string, unknown> =>
    convertLegacyCond(
      String(r.kind ?? "always"), String(r.action ?? ""),
      (r.threshold as number | string) ?? 0, r.action2 as string | undefined, !!r.negate,
    );
  const convertState = (st: Record<string, unknown>) => {
    if (st.primary !== undefined) return; // already new format
    if (!("conditionKind" in st)) {
      // No legacy condition AND no new primary — the state's condition was
      // lost (e.g. a project saved during the schema transition before the
      // converter existed). Defaulting to Always means this state would win
      // by priority every frame. Warn loudly so it's diagnosable in F12
      // rather than silently breaking ("attack always active", etc.).
      console.warn(`[Peaky] State "${String(st.name ?? "?")}" has no conditionKind and no primary — defaulting to Always. Its original condition was lost (likely saved mid-migration). Re-set its condition in the State Machine inspector.`);
      st.primary = { kind: "Always" };
      return;
    }
    st.primary = convertLegacyCond(
      String(st.conditionKind ?? "always"), String(st.conditionAction ?? ""),
      (st.conditionThreshold as number | string) ?? 0, st.conditionAction2 as string | undefined,
    );
    if (Array.isArray(st.extraConditions)) st.extras = (st.extraConditions as Record<string, unknown>[]).map(convertLegacyRow);
    if (Array.isArray(st.subConditions)) st.subs = (st.subConditions as Record<string, unknown>[]).map(convertLegacyRow);
    delete st.conditionKind; delete st.conditionAction; delete st.conditionThreshold; delete st.conditionAction2;
    delete st.extraConditions; delete st.subConditions;
  };
  for (const bp of blueprints) {
    for (const b of bp.behaviors) {
      if (b.kind !== "StateMachine") continue;
      const cfg = b.config as Record<string, unknown>;
      if (Array.isArray(cfg.states)) for (const st of cfg.states as Record<string, unknown>[]) convertState(st);
      if (Array.isArray(cfg.stateMachines)) {
        for (const m of cfg.stateMachines as Record<string, unknown>[]) {
          if (Array.isArray(m.states)) for (const st of m.states as Record<string, unknown>[]) convertState(st);
        }
      }
      // Input gates carried lowercase condition rows too.
      if (Array.isArray(cfg.inputGates)) {
        for (const g of cfg.inputGates as Record<string, unknown>[]) {
          if (Array.isArray(g.conditions) && g.conditions.length > 0 && (g.conditions[0] as Record<string, unknown>).threshold !== undefined) {
            g.conditions = (g.conditions as Record<string, unknown>[]).map(convertLegacyRow);
          }
        }
      }
    }
  }

  let out = { ...rest, version: 8, blueprints, signals } as PeakyProject;
  // Backfill the sounds array on projects saved before audio support.
  if (!Array.isArray(out.sounds)) out.sounds = [];
  if (!Array.isArray(out.items)) out.items = [];
  if (!Array.isArray(out.tilesets)) out.tilesets = [];
  if (!Array.isArray(out.tilemaps)) out.tilemaps = [];
  // Same backfill for the later optional asset arrays — guarded at every read
  // today, but initialize them so nothing downstream can hit an undefined.
  if (!Array.isArray(out.fonts)) out.fonts = [];
  if (!Array.isArray(out.dialogBoxes)) out.dialogBoxes = [];
  if (!Array.isArray(out.mainLogicSheets)) out.mainLogicSheets = [];
  // Tilemap v1 → v2 migration: legacy `tiles: number[]` is folded into a
  // single layer so old saves keep their art. Tilemaps that already have
  // `layers` (v2+) pass through unchanged.
  out.tilemaps = out.tilemaps.map((m) => {
    const anyM = m as TilemapAsset & { tiles?: number[] };
    if (Array.isArray(m.layers) && m.layers.length > 0) return m;
    const legacy = Array.isArray(anyM.tiles) ? anyM.tiles : new Array(m.cols * m.rows).fill(-1);
    const next: TilemapAsset = {
      ...m,
      layers: [{
        id: newId("tlayer"),
        name: "Layer 1",
        tiles: legacy,
        z: 0,
        alpha: 1,
        visible: true,
        collides: true,
      }],
    };
    delete (next as TilemapAsset & { tiles?: number[] }).tiles;
    return next;
  });
  // Backfill tilemapInstances on each scene (nullable on legacy projects).
  out.scenes = out.scenes.map((sc) => Array.isArray(sc.tilemapInstances) ? sc : { ...sc, tilemapInstances: [] });
  // Backfill each item's count global (the owned-count source of truth) so
  // existing items gain one without a manual step.
  out.items = out.items.map((i) => (i.countGlobal ? i : { ...i, countGlobal: itemCountGlobalName(i.name) }));
  // Shop widgets: legacy `shopSlotItems: string[]` → `shopSlots: {item,stock}[]`
  // (unlimited). Walks widgets + their children.
  {
    const fixShop = (v: { shopSlots?: unknown; shopSlotItems?: unknown }): void => {
      if (!Array.isArray(v.shopSlots) && Array.isArray(v.shopSlotItems)) {
        v.shopSlots = (v.shopSlotItems as string[]).map((item) => ({ item: String(item ?? ""), stock: -1 }));
      }
    };
    for (const w of out.uiWidgets) {
      fixShop(w as never);
      for (const c of (w.children ?? [])) fixShop(c as never);
    }
  }
  if (!Array.isArray(out.recipes)) out.recipes = [];
  if (!Array.isArray(out.globalVariables)) out.globalVariables = [];
  // Lists gained a {name,value} entry shape (was a flat `items` array). Ensure
  // every list has `entries` so the editor never renders against undefined;
  // convert any legacy `items` into index-named entries so old data survives.
  out.lists = (Array.isArray(out.lists) ? out.lists : []).map((l) => {
    if (Array.isArray((l as ListDef).entries)) return l;
    const legacyItems = (l as ListDef & { items?: unknown[] }).items;
    const items = Array.isArray(legacyItems) ? legacyItems : [];
    return {
      ...l,
      entries: items.map((v, i) => ({ id: newId("lent"), name: String(i), value: v as number | string | boolean })),
    };
  });
  // Normalize legacy Get List Item nodes (pre key/value rework): they carried
  // `index` + field "item" and read by position. Lists read by entry NAME now,
  // so reshape to { list, key, field } — otherwise the node shows a stray index
  // field and reads nothing. Walks every Logic Sheet graph (BPs + Main sheets).
  const fixListNodes = (nodes: Array<{ type?: string; params?: Record<string, unknown> }> | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type !== "GetListValue" || !n.params) continue;
      const p = n.params;
      if (!("key" in p)) p.key = "";
      if (p.field === "item" || p.field === undefined) p.field = "value";
      if ("index" in p) delete p.index;
    }
  };
  for (const bp of blueprints) {
    for (const f of bp.logicSheet?.folders ?? []) fixListNodes(f.graph?.nodes as never);
  }
  for (const ms of out.mainLogicSheets ?? []) {
    for (const f of ms.sheet?.folders ?? []) fixListNodes(f.graph?.nodes as never);
  }
  // Repair activeSceneId if it points to a scene that no longer exists —
  // a previous broken closeSceneTab could have written a stale id here.
  if (out.scenes.length > 0 && !out.scenes.some((s) => s.id === out.activeSceneId)) {
    out.activeSceneId = out.scenes[0].id;
  }
  // Seed default Input Actions if missing OR empty — losing these strands
  // every CharacterMovement BP with a useless trigger dropdown (only None /
  // Signal options). We seed on empty too because users who hit this state
  // are almost always recovering from a prior save bug, not deliberately
  // shipping a project with zero input actions. Users who really want zero
  // can delete them again after this single re-seed lands.
  if (!Array.isArray(out.inputActions) || out.inputActions.length === 0) {
    out.inputActions = [
      { id: newId("act"), name: "MoveLeft",  keys: ["LEFT", "A"] },
      { id: newId("act"), name: "MoveRight", keys: ["RIGHT", "D"] },
      { id: newId("act"), name: "Jump",      keys: ["UP", "W", "SPACE"] },
      { id: newId("act"), name: "Crouch",    keys: ["DOWN", "S"] },
    ];
  }

  // Viewport migration: pre-viewport projects had no separate window vs
  // layout size — `scene.width / height` did double duty. Fall back to
  // the first scene's dimensions so existing projects render unchanged
  // at runtime, then the user can resize the viewport independently.
  if (typeof out.viewportWidth !== "number" || !Number.isFinite(out.viewportWidth) || out.viewportWidth <= 0) {
    out.viewportWidth = out.scenes[0]?.width ?? 800;
  }
  if (typeof out.viewportHeight !== "number" || !Number.isFinite(out.viewportHeight) || out.viewportHeight <= 0) {
    out.viewportHeight = out.scenes[0]?.height ?? 600;
  }

  // Projects predating the Sampling setting render with bilinear (the old
  // hardcoded default) — preserve that look rather than surprising them.
  if (out.sampling !== "nearest" && out.sampling !== "bilinear" && out.sampling !== "trilinear") {
    out.sampling = "bilinear";
  }

  // Layer migration: scenes that predate the layers feature have neither
  // `layers` nor `activeLayerId`. Seed the default set (UI / Main /
  // Background) and assign every existing instance to the Main layer.
  // Also repair scenes whose `activeLayerId` points at a deleted layer.
  out.scenes = out.scenes.map((sc) => {
    let next = sc;
    const hasLayers = Array.isArray((sc as { layers?: unknown }).layers) && (sc.layers as unknown[]).length > 0;
    if (!hasLayers) {
      const seed = defaultLayers();
      next = { ...next, layers: seed.layers, activeLayerId: seed.activeLayerId };
    }
    if (!next.layers.some((l) => l.id === next.activeLayerId)) {
      // Pick the first non-UI layer if available, else the first.
      const fallback = next.layers.find((l) => l.parallaxX !== 0 || l.parallaxY !== 0) ?? next.layers[0];
      next = { ...next, activeLayerId: fallback.id };
    }
    // Backfill instance.layerId — pick "Main" by name if present, else
    // the activeLayerId. This keeps legacy instances visible at runtime
    // (they were rendering against the default camera scroll factor of
    // (1,1) anyway, so Main = lossless migration).
    const mainId = next.layers.find((l) => l.name === "Main")?.id ?? next.activeLayerId;
    let touchedInstances = false;
    const instances = next.instances.map((inst) => {
      if (inst.layerId && next.layers.some((l) => l.id === inst.layerId)) return inst;
      touchedInstances = true;
      return { ...inst, layerId: mainId };
    });
    if (touchedInstances) next = { ...next, instances };
    return next;
  });

  // ── Input action repair pass ─────────────────────────────────────────
  // Earlier versions of the rename cascade had a bug that could leave a
  // CharacterMovement behavior with `dashAction` (or jump/left/right)
  // pointing at an empty string OR at an action name that no longer
  // exists. Both cases silently break the ability — the runtime looks up
  // the (case-sensitive, exact-match) name, finds nothing, and the
  // ability never fires.
  //
  // We repair both shapes here so existing broken projects heal on next
  // load:
  //   1. Trim whitespace on every InputAction name (a stray space in the
  //      stored value would never match the dropdown's trimmed display).
  //   2. For each CM behavior, if a `*Action` field is set but doesn't
  //      match any registered action, try a case-insensitive / trimmed
  //      lookup. If we find a unique match, snap to that action's exact
  //      stored name. If not, leave the value alone.
  if (Array.isArray(out.inputActions)) {
    const trimmedActions = out.inputActions.map((a) => {
      const trimmed = typeof a.name === "string" ? a.name.trim() : a.name;
      const cleanKeys = Array.isArray(a.keys)
        ? a.keys.filter((k): k is string => typeof k === "string" && k.length > 0)
        : [];
      return trimmed === a.name && cleanKeys.length === (a.keys?.length ?? 0)
        ? a
        : { ...a, name: trimmed, keys: cleanKeys };
    });
    out.inputActions = trimmedActions;

    const knownNames = new Set(trimmedActions.map((a) => a.name));
    const lowerToExact = new Map<string, string>();
    for (const a of trimmedActions) {
      const k = a.name.toLowerCase();
      if (!lowerToExact.has(k)) lowerToExact.set(k, a.name);
    }
    const ACTION_FIELDS = ["leftAction", "rightAction", "jumpAction", "dashAction"] as const;
    out.blueprints = out.blueprints.map((bp) => {
      let touched = false;
      const behaviors = bp.behaviors.map((b) => {
        if (b.kind !== "CharacterMovement") return b;
        const cfg = { ...b.config };
        let bTouched = false;
        for (const field of ACTION_FIELDS) {
          const raw = cfg[field];
          if (typeof raw !== "string" || raw === "") continue;
          if (knownNames.has(raw)) continue; // already correct
          const trimmedRef = raw.trim();
          if (knownNames.has(trimmedRef)) {
            cfg[field] = trimmedRef;
            bTouched = true;
            continue;
          }
          const exact = lowerToExact.get(trimmedRef.toLowerCase());
          if (exact) {
            cfg[field] = exact;
            bTouched = true;
          }
          // No match → leave it alone; the dropdown will show "(unknown)"
          // and the user can re-pick. We don't blank silently.
        }
        if (bTouched) {
          touched = true;
          return { ...b, config: cfg };
        }
        return b;
      });
      return touched ? { ...bp, behaviors } : bp;
    });
  }

  // Dialogue migration: pre-dialogue projects don't have these fields.
  // Seed empty arrays + sensible defaults so the editor renders cleanly.
  if (!Array.isArray((out as { dialogues?: unknown }).dialogues)) {
    out.dialogues = [];
  }
  // UIWidget migration: seed empty array for projects that pre-date the
  // UIWidget asset class. Same shape as dialogues — pure additive.
  if (!Array.isArray((out as { uiWidgets?: unknown }).uiWidgets)) {
    (out as { uiWidgets: UIWidgetDef[] }).uiWidgets = [];
  }
  // Backfill `behaviors: []` on UI widgets created by older versions of
  // the editor that didn't include the field. EventsSection (shared with
  // BPs) reads `bp.behaviors` so without this, opening an old widget's
  // event sheet crashes. Also backfills mode/children for widgets
  // authored before the Single / Multi distinction.
  const wList = (out as { uiWidgets: UIWidgetDef[] }).uiWidgets;
  for (let i = 0; i < wList.length; i++) {
    const w = wList[i] as UIWidgetDef & { behaviors?: unknown; mode?: unknown; children?: unknown };
    let next = w as UIWidgetDef;
    if (!Array.isArray(w.behaviors)) next = { ...next, behaviors: [] };
    if (w.mode !== "single" && w.mode !== "multi") next = { ...next, mode: "single" };
    if (!Array.isArray(w.children)) next = { ...next, children: [] };
    wList[i] = next;
  }
  if (typeof (out as { dialogueDefaults?: unknown }).dialogueDefaults !== "object" || out.dialogueDefaults === null) {
    out.dialogueDefaults = {
      displayMode: "overhead",
      advanceAction: "Interact",
      autoAdvanceSec: 0,
      typewriterCps: 30,
      narratorBpId: "",
      playerSpeakerBpId: "",
      style: defaultDialogueStyle(),
    };
  }
  // Backfill playerSpeakerBpId for projects that pre-date it.
  if (typeof out.dialogueDefaults.playerSpeakerBpId !== "string") {
    out.dialogueDefaults = { ...out.dialogueDefaults, playerSpeakerBpId: "" };
  }
  // Repair: if playerSpeakerBpId points at a deleted BP, clear it.
  if (out.dialogueDefaults.playerSpeakerBpId
      && !out.blueprints.some((bp) => bp.id === out.dialogueDefaults.playerSpeakerBpId)) {
    out.dialogueDefaults = { ...out.dialogueDefaults, playerSpeakerBpId: "" };
  }
  // Backfill `style` for projects that pre-date it.
  if (typeof out.dialogueDefaults.style !== "object" || out.dialogueDefaults.style === null) {
    out.dialogueDefaults = { ...out.dialogueDefaults, style: defaultDialogueStyle() };
  } else {
    // Backfill any individual style fields added in later versions
    // (e.g. position offsets) — preserve existing customizations.
    out.dialogueDefaults = {
      ...out.dialogueDefaults,
      style: { ...defaultDialogueStyle(), ...out.dialogueDefaults.style },
    };
  }
  // Repair: if narratorBpId points at a deleted Blueprint, clear it.
  if (out.dialogueDefaults.narratorBpId && !out.blueprints.some((bp) => bp.id === out.dialogueDefaults.narratorBpId)) {
    out.dialogueDefaults = { ...out.dialogueDefaults, narratorBpId: "" };
  }
  // Repair: drop any speakerMap entries that reference deleted BPs.
  out.dialogues = out.dialogues.map((d) => {
    const map = d.speakerMap ?? {};
    let touched = false;
    const cleaned: Record<string, string> = {};
    for (const k of Object.keys(map)) {
      const v = map[k];
      if (v && out.blueprints.some((bp) => bp.id === v)) {
        cleaned[k] = v;
      } else if (v) {
        touched = true; // had a value, dropped it
      } else {
        cleaned[k] = v;
      }
    }
    return touched ? { ...d, speakerMap: cleaned } : d;
  });

  // Seed the /Dialogues folder if it's missing — the Content Browser uses
  // explicit folder paths so dialogues without one would have nowhere to
  // appear.
  if (!out.folders.includes("/Dialogues")) {
    out.folders = [...out.folders, "/Dialogues"];
  }
  if (!out.folders.includes("/Items")) {
    out.folders = [...out.folders, "/Items"];
  }
  if (!out.folders.includes("/Recipes")) {
    out.folders = [...out.folders, "/Recipes"];
  }

  // Event-page repair pass.
  // Every BP must have at least one eventPage. Every top-level event must
  // either have NO pageId (treated as belonging to page[0]) or a pageId
  // that matches an existing page on the same BP. If an event references
  // a deleted page we silently re-anchor it to page[0] so it doesn't
  // become invisible.
  out.blueprints = out.blueprints.map((bp) => {
    let touched = false;
    let pages = bp.eventPages;
    if (!Array.isArray(pages) || pages.length === 0) {
      pages = [{ id: newId("page"), name: "Page 1" }];
      touched = true;
    }
    const pageIdSet = new Set(pages.map((p) => p.id));
    const fixEv = (ev: PeakyEvent): PeakyEvent => {
      let next = ev;
      if (next.pageId && !pageIdSet.has(next.pageId)) {
        const { pageId: _drop, ...rest } = next;
        void _drop;
        next = rest as PeakyEvent;
        touched = true;
      }
      // Sub-events should never carry a pageId — they inherit through
      // their parent. Strip any stale ones.
      if (next.children && next.children.length > 0) {
        const fixedChildren = next.children.map((c) => {
          if (c.pageId !== undefined) {
            const { pageId: _drop, ...rest } = c;
            void _drop;
            touched = true;
            return rest as PeakyEvent;
          }
          return c;
        }).map(fixEv);
        if (fixedChildren !== next.children) {
          next = { ...next, children: fixedChildren };
        }
      }
      return next;
    };
    const events = bp.events.map(fixEv);
    return touched ? { ...bp, eventPages: pages, events } : bp;
  });

  // Class-locked behavior auto-heal: Camera-class BPs MUST carry a
  // Camera behavior. If a saved BP somehow lost it (hand-edit, older
  // format, corruption), re-attach a default-config instance so the
  // class invariant holds. The Components rail's lockdown also blocks
  // the +Component menu, so without auto-heal a broken Camera BP would
  // be unrecoverable.
  //
  // Legacy migration: the now-removed `Particles` BP class is downgraded
  // to `Character` so existing projects don't carry a phantom class.
  // Their attached `ParticleEmitter` behavior is preserved.
  out.blueprints = out.blueprints.map((bp) => {
    let next: BlueprintDef = bp.classKind === ("Particles" as unknown as BlueprintDef["classKind"])
      ? { ...bp, classKind: "Character" }
      : bp;
    if (next.classKind === "Camera" && !next.behaviors.some((b) => b.kind === "Camera")) {
      next = {
        ...next,
        behaviors: [
          { kind: "Camera" as BehaviorKind, config: {}, enabled: true },
          ...next.behaviors,
        ],
      };
    }
    return next;
  });

  // ── Asset-name sanitization sweep (UE5-style: [A-Za-z_][A-Za-z0-9_]*) ──
  // Top-level asset names + folder paths get rewritten to a clean form. Any
  // logic-sheet field that references an asset by name gets updated using
  // the per-type rename map. Free-text expression fields with `var:<bpName>`
  // tokens get a regex pass too. Scope is INTENTIONALLY top-level assets
  // only — variables, signals, input actions, animation names, state names,
  // and component names stay as-is.
  out = sanitizeProjectAssetNames(out);

  return out;
}

/**
 * Whole-project sanitize sweep — used by migrateProject on load and could
 * be wired to a "Sanitize Names" menu action for explicit re-runs.
 *
 * 1. Walks each top-level asset list, sanitizes names with dedup-by-suffix,
 *    builds a `Map<oldName, newName>` per asset type.
 * 2. Sanitizes folder paths (segments individually).
 * 3. Walks every logic sheet (BP, main, UI widget) and rewrites known
 *    reference fields (bp / scene / dialogue / widget / tilemap / item /
 *    recipe). Also runs a `var:<bpName>.field` regex pass on every string
 *    param value so cross-BP expression refs follow renames.
 */
function sanitizeProjectAssetNames(project: PeakyProject): PeakyProject {
  // Build a sanitize-with-dedup helper for one asset list. Returns the new
  // list AND a Map<oldName, newName>. Order matters: assets that were
  // already clean win the slot (no collision); dirty names get suffixed.
  function renameList<T extends { name: string }>(
    items: T[],
    fallback: string,
  ): { items: T[]; renames: Map<string, string> } {
    const renames = new Map<string, string>();
    const taken = new Set<string>();
    // Two-pass: first lock in already-clean names so dedup doesn't displace
    // them; second pass sanitizes the dirty ones with collision-suffix.
    for (const it of items) {
      const clean = sanitizeAssetName(it.name, fallback);
      if (clean === it.name) taken.add(clean);
    }
    const out: T[] = items.map((it) => {
      const clean = sanitizeAssetName(it.name, fallback);
      let final = clean;
      if (clean !== it.name) {
        let n = 2;
        while (taken.has(final)) final = `${clean}_${n++}`;
        taken.add(final);
      }
      if (final !== it.name) renames.set(it.name, final);
      return final === it.name ? it : { ...it, name: final };
    });
    return { items: out, renames };
  }

  const next: PeakyProject = { ...project };

  // 1) Asset names + per-type rename maps.
  const bpR = renameList(next.blueprints, "Blueprint");
  next.blueprints = bpR.items;
  const sceneR = renameList(next.scenes, "Scene");
  next.scenes = sceneR.items;
  const spriteR = renameList(next.sprites, "Sprite");
  next.sprites = spriteR.items;
  const dialogueR = renameList(next.dialogues, "Dialogue");
  next.dialogues = dialogueR.items;
  const widgetR = renameList(next.uiWidgets, "Widget");
  next.uiWidgets = widgetR.items;
  const itemR = renameList(next.items ?? [], "Item");
  next.items = itemR.items;
  const recipeR = renameList(next.recipes ?? [], "Recipe");
  next.recipes = recipeR.items;
  const tilesetR = renameList(next.tilesets ?? [], "Tileset");
  next.tilesets = tilesetR.items;
  const tilemapR = renameList(next.tilemaps ?? [], "Tilemap");
  next.tilemaps = tilemapR.items;

  // Animated tiles live per-tileset; rename inside each.
  next.tilesets = next.tilesets.map((ts) => {
    if (!ts.animatedTiles || ts.animatedTiles.length === 0) return ts;
    const ar = renameList(
      ts.animatedTiles.map((a) => ({ ...a, name: a.name ?? "" })) as Array<{ name: string; id: string }>,
      "AnimatedTile",
    );
    // Reflow back onto the original shape.
    const byId = new Map(ar.items.map((a) => [a.id, a]));
    return {
      ...ts,
      animatedTiles: ts.animatedTiles.map((a) => {
        const r = byId.get(a.id);
        return r && r.name !== a.name ? { ...a, name: r.name } : a;
      }),
    };
  });

  // 2) Folder paths — sanitize per segment.
  if (Array.isArray(next.folders)) {
    next.folders = Array.from(new Set(next.folders.map(sanitizeFolderPath))).filter((p) => p && p !== "/");
  }
  const fixPath = <T extends { path?: string }>(asset: T): T =>
    asset.path !== undefined ? { ...asset, path: sanitizeFolderPath(asset.path) } : asset;
  next.blueprints = next.blueprints.map(fixPath);
  next.scenes = next.scenes.map(fixPath);
  next.sprites = next.sprites.map(fixPath);
  next.dialogues = next.dialogues.map(fixPath);
  next.uiWidgets = next.uiWidgets.map(fixPath);
  next.items = next.items?.map(fixPath);
  next.recipes = next.recipes?.map(fixPath);
  next.tilesets = next.tilesets?.map(fixPath);
  next.tilemaps = next.tilemaps?.map(fixPath);
  next.sounds = next.sounds?.map(fixPath);

  // 3) Reference rewrites in every logic sheet. Aggregate ALL maps into one
  //    table keyed by param-name so we can dispatch in a single walk pass.
  const refMaps: Record<string, Map<string, string>> = {
    // Blueprint name references.
    bp:           bpR.renames,
    blueprint:    bpR.renames,
    blueprintName: bpR.renames,
    // Scene name references.
    scene:        sceneR.renames,
    sceneName:    sceneR.renames,
    layout:       sceneR.renames,
    // Dialogue name references.
    dialogueId:   dialogueR.renames,
    dialogueName: dialogueR.renames,
    dialogue:     dialogueR.renames,
    asset:        dialogueR.renames,
    // Widget references.
    widget:       widgetR.renames,
    widgetName:   widgetR.renames,
    // Tilemap references.
    tilemap:      tilemapR.renames,
    tilemapName:  tilemapR.renames,
    // Item references.
    item:         itemR.renames,
    itemName:     itemR.renames,
    outputItem:   itemR.renames,
    // Recipe references.
    recipe:       recipeR.renames,
    recipeName:   recipeR.renames,
    // Sprite references — sprites are usually referenced by id (`spriteId`),
    // not name, so no map needed here. Tileset same story.
  };

  // Cached compiled regex for `var:<oldName>.field` substitution. Only built
  // when there's at least one BP rename — most projects will hit this path
  // since legacy saves with spaces are exactly what we're fixing.
  const bpVarPatterns: Array<{ regex: RegExp; replacement: string }> = [];
  for (const [oldName, newName] of bpR.renames) {
    // Escape any regex-special chars in the old name (mostly spaces).
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `var:OldName.field` — boundary on the dot or end-of-string.
    bpVarPatterns.push({
      regex: new RegExp(`var:${escaped}(\\b|\\.)`, "g"),
      replacement: `var:${newName}$1`,
    });
  }

  function rewriteString(s: string): string {
    let out = s;
    for (const { regex, replacement } of bpVarPatterns) {
      out = out.replace(regex, replacement);
    }
    return out;
  }

  function rewriteValue(key: string, val: unknown): unknown {
    if (typeof val === "string") {
      const map = refMaps[key];
      if (map && map.has(val)) return map.get(val)!;
      if (bpVarPatterns.length > 0 && val.includes("var:")) return rewriteString(val);
      return val;
    }
    // Arrays of strings (rare — e.g. PlaySounds.sounds or tag chips) — only
    // rewrite when the key has a reference map; we don't auto-rewrite tags.
    if (Array.isArray(val) && refMaps[key]) {
      const map = refMaps[key];
      return val.map((v) => (typeof v === "string" && map.has(v) ? map.get(v)! : v));
    }
    return val;
  }

  function rewriteConfig(config: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!config) return config;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      const r = rewriteValue(k, v);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : config;
  }

  function rewriteEvents(events: unknown[]): unknown[] {
    return events.map((e) => {
      const evt = e as { actions?: unknown[]; conditions?: unknown[]; children?: unknown[] };
      const actions = evt.actions
        ? evt.actions.map((a) => {
            const act = a as { config?: Record<string, unknown> };
            const cfg = rewriteConfig(act.config);
            return cfg === act.config ? act : { ...act, config: cfg };
          })
        : evt.actions;
      const conditions = evt.conditions
        ? evt.conditions.map((c) => {
            const cnd = c as Record<string, unknown>;
            // Conditions store their params at the TOP level of the row, not under a `config` key.
            let out = cnd;
            for (const [k, v] of Object.entries(cnd)) {
              const r = rewriteValue(k, v);
              if (r !== v) {
                if (out === cnd) out = { ...cnd };
                out[k] = r;
              }
            }
            return out;
          })
        : evt.conditions;
      const children = evt.children ? rewriteEvents(evt.children) : evt.children;
      if (actions === evt.actions && conditions === evt.conditions && children === evt.children) return e;
      return { ...evt, actions, conditions, children };
    });
  }

  function rewriteLogicSheet(sheet: unknown): unknown {
    if (!sheet) return sheet;
    const s = sheet as { nodes?: unknown[]; folders?: unknown[]; eventPages?: unknown[]; events?: unknown[] };
    const next: typeof s = { ...s };
    if (Array.isArray(s.nodes)) {
      next.nodes = s.nodes.map((n) => {
        const node = n as { params?: Record<string, unknown> };
        if (!node.params) return n;
        const p = rewriteConfig(node.params);
        return p === node.params ? n : { ...node, params: p };
      });
    }
    if (Array.isArray(s.folders)) {
      next.folders = s.folders.map((f) => {
        const folder = f as { graph?: { nodes?: unknown[] } };
        if (!folder.graph || !Array.isArray(folder.graph.nodes)) return f;
        const nodes = folder.graph.nodes.map((n) => {
          const node = n as { params?: Record<string, unknown> };
          if (!node.params) return n;
          const p = rewriteConfig(node.params);
          return p === node.params ? n : { ...node, params: p };
        });
        return { ...folder, graph: { ...folder.graph, nodes } };
      });
    }
    if (Array.isArray(s.eventPages)) {
      next.eventPages = s.eventPages.map((pg) => {
        const page = pg as { events?: unknown[] };
        if (!Array.isArray(page.events)) return pg;
        return { ...page, events: rewriteEvents(page.events) };
      });
    }
    if (Array.isArray(s.events)) {
      next.events = rewriteEvents(s.events);
    }
    return next;
  }

  next.blueprints = next.blueprints.map((bp) => ({
    ...bp,
    logicSheet: rewriteLogicSheet(bp.logicSheet) as typeof bp.logicSheet,
  }));
  if (next.mainLogicSheets) {
    next.mainLogicSheets = next.mainLogicSheets.map((ms) => ({
      ...ms,
      sheet: rewriteLogicSheet(ms.sheet) as typeof ms.sheet,
    }));
  }
  next.uiWidgets = next.uiWidgets.map((w) => ({
    ...w,
    logicSheet: rewriteLogicSheet(w.logicSheet) as typeof w.logicSheet,
  }));

  // Cross-asset reference cascades that AREN'T in logic sheets.
  // Scene instances reference blueprintId (id, not name) — no fix needed.
  // Scene main-event-pages live under SceneData; handle if present.
  next.scenes = next.scenes.map((sc) => {
    const pages = (sc as unknown as { mainEventPages?: Array<Record<string, unknown>> }).mainEventPages;
    if (!pages) return sc;
    const next = {
      ...sc,
      mainEventPages: pages.map((pg: Record<string, unknown>) => {
        const evts = pg.events;
        return Array.isArray(evts) ? { ...pg, events: rewriteEvents(evts) } : pg;
      }),
    } as unknown as typeof sc;
    return next;
  });
  // Recipe input/output items follow the item rename map.
  if (next.recipes) {
    next.recipes = next.recipes.map((r) => {
      const inputs = r.inputs.map((inp) =>
        itemR.renames.has(inp.item) ? { ...inp, item: itemR.renames.get(inp.item)! } : inp,
      );
      const outputItem = itemR.renames.has(r.outputItem) ? itemR.renames.get(r.outputItem)! : r.outputItem;
      return inputs === r.inputs && outputItem === r.outputItem ? r : { ...r, inputs, outputItem };
    });
  }
  // Dialogue speakerMap keys are blueprint NAMES — rename through bpR.
  next.dialogues = next.dialogues.map((d) => {
    if (!d.speakerMap) return d;
    let changed = false;
    const remapped: typeof d.speakerMap = {};
    for (const [k, v] of Object.entries(d.speakerMap)) {
      const newK = bpR.renames.get(k) ?? k;
      if (newK !== k) changed = true;
      remapped[newK] = v;
    }
    return changed ? { ...d, speakerMap: remapped } : d;
  });
  // Active scene id is an id (not name) — no rename needed.

  return next;
}

/**
 * Build a default condition body for a freshly-picked kind. Each branch
 * fills in the kind-specific payload with sensible empty defaults.
 */
function defaultConditionFor(id: string, kind: ConditionKind): Condition {
  switch (kind) {
    case "OnKeyPressed":
    case "OnKeyReleased":
      return { id, kind, actions: [] };
    case "OnCollide":
    case "OnOverlap":
      return { id, kind, tags: [] };
    case "OnSignal":
      return { id, kind, signals: [] };
    case "OnAnimationEnd":
    case "IsAnimationPlaying":
      return { id, kind, animation: "" };
    case "IsAnimatorAnimPlaying":
      return { id, kind, action: "" };
    case "OnAnyAnimationEnd":
      return { id, kind };
    case "Compare":
      return { id, kind, property: "velocity.x", op: ">", value: 0 };
    case "CompareValues":
      return { id, kind, left: "", op: "==", right: "" };
    case "CompareTime":
      return { id, kind, op: ">", value: 1 };
    case "IsBetween":
      return { id, kind, varName: "", min: 0, max: 100 };
    case "IsBoolean":
      return { id, kind, varName: "", expected: true };
    case "EveryXSeconds":
      return { id, kind, seconds: 1 };
    case "OnMouseButtonPressed":
    case "OnMouseButtonReleased":
    case "IsMouseButtonHeld":
      return { id, kind, button: 0 };
    case "ObjectUIDExists":
      return { id, kind, uid: "" };
    case "ForEach":
    case "PickAll":
    case "PickRandom":
      return { id, kind, tag: "" };
    case "Repeat":
      return { id, kind, count: 1 };
    case "PickByHighest":
    case "PickByLowest":
      return { id, kind, tag: "", by: "position.x" };
    case "PickNth":
      return { id, kind, tag: "", index: 0 };
    case "PickByComparison":
      return { id, kind, tag: "", left: "", op: "==", right: "" };
    case "CompareCMParam":
      return { id, kind, cmParam: "maxSpeed", op: ">", value: 0 };
    case "CompareTMParam":
      return { id, kind, tmParam: "maxSpeed", op: ">", value: 0 };
    case "IsMovingDir":
      return { id, kind, direction: "up" };
    case "IsBehaviorEnabled":
      return { id, kind, behavior: "CharacterMovement" };
    case "CompareFrame":
      return { id, kind, animation: "", op: "==", value: 0 };
    case "IsSignalFiring":
      return { id, kind, signal: "" };
    case "IsActionHeld":
      return { id, kind, action: "" };
    case "CompareText":
      return { id, kind, textOp: "==", textValue: "" };
    case "CompareCameraZoom":
      return { id, kind, op: "==", value: 1 };
    case "IsTracerHit":
    case "TracerJustHit":
      return { id, kind, tracer: "" };
    case "TracerHitHasTag":
      return { id, kind, tracer: "", tagValue: "" };
    case "OnMouseWheel":
      return { id, kind, wheelDir: "any" };
    case "OnObjectClicked":
    case "OnObjectDoubleClicked":
      return { id, kind, tags: [], button: 0 };
    case "OnMouseClick":
    case "OnMouseDoubleClick":
      return { id, kind, button: 0 };
    case "IsCursorOverObject":
      return { id, kind, tags: [] };
    case "OnTweenStart":
    case "OnTweenFinish":
    case "IsTweenPlaying":
    case "IsTweenPaused":
      return { id, kind, tweenTag: "" };
    case "IsAnyTweenPlaying":
      return { id, kind };
    // No-payload kinds — `kind` alone is the entire condition.
    case "OnCreate":
    case "OnDestroyed":
    case "OnSceneStart":
    case "OnSceneEnd":
    case "OnSaveLoadComplete":
    case "OnCameraPanEnd":
    case "OnLand":
    case "OnJump":
    case "OnFall":
    case "OnDashStart":
    case "OnDashEnd":
    case "OnMoved":
    case "OnStopped":
    case "OnKeyHeld":
    case "Always":
    case "OnStep":
    case "TriggerOnceWhileTrue":
    case "While":
    case "IsMoving":
    case "IsMovingLeft":
    case "IsMovingRight":
    case "IsMovingUp":
    case "IsMovingDown":
    case "IsFacingLeft":
    case "IsFacingRight":
    case "IsRunning":
    case "IsGrounded":
    case "IsJumping":
    case "IsFalling":
    case "IsDashing":
    case "IsWallSliding":
    case "IsByWall":
    case "IsByWallLeft":
    case "IsByWallRight":
    case "CanJump":
    case "CanDash":
    case "IsDoubleJumpEnabled":
    case "IsWallJumping":
    case "JustTurnedLeft":
    case "JustTurnedRight":
    case "JustWallJumped":
    case "IsDead":
    case "IsInHitstun":
    case "IsInIframes":
    case "HasAITarget":
    case "NoAITarget":
    case "IsTextVisible":
    case "IsCameraShaking":
    case "IsCameraPanning":
    case "IsCameraLocked":
    case "IsEmittingParticles":
    case "IsParticleEmitterEnabled":
    case "OnParticleBurstEnd":
    case "Else":
      return { id, kind };
    case "CompareParticleCount":
      return { id, kind, op: ">", value: 0 };
    case "IsMusicPlaying":
    case "IsSoundPlaying":
      return { id, kind, sound: "" };
    case "IsPaused":
      return { id, kind, scope: "all", layer: "" };
    case "HasItem":
      return { id, kind, item: "", value: 1 };
    case "InventoryIsFull":
      return { id, kind };
    case "IsStateEnabled":
    case "IsState":
    case "PreviousStateWas":
      return { id, kind, state: "" };
    case "PreviousAnimWas":
      return { id, kind, animation: "" };
    case "SignalFiredEdge":
      return { id, kind, signal: "" };
    case "InputBuffered":
      return { id, kind, action: "" };
    case "JustCollidedWithTag":
    case "JustSeparatedFromTag":
      return { id, kind, tag: "" };
    case "CompareTileAt":
      return { id, kind, tilemap: "", layer: "", c: 0, r: 0, op: "==", value: 0 };
    case "CompareTileAtWorld":
      return { id, kind, tilemap: "", layer: "", tileX: 0, tileY: 0, op: "==", value: 0 };
    case "IsTileSolidAt":
    case "IsTileEmptyAt":
      return { id, kind, tilemap: "", layer: "", tileX: 0, tileY: 0 };
    case "OnTileDestroyed":
    case "OnTileDamaged":
      return { id, kind };
    case "IsTopdownFacing":
      return { id, kind, direction: "down" };
    case "IsMovingTo":
    case "HasArrived":
    case "OnLoadStart":
    case "OnLoadProgress":
    case "OnLoadComplete":
    case "HasTag":
    case "HasAnyTag":
    case "HasAllTags":
    case "IsLoading":
    case "IsScene":
    case "OnCollideWithSpriteObject":
    case "OnOverlapWithSpriteObject":
    case "OnSpriteObjectCreate":
    case "OnSpriteObjectDestroy":
    case "HasSpriteObjectTag":
    case "IsOverlappingTag":
    case "IsAirborne":
    case "IsAIState":
    case "IsMovingAny":
    case "IsDialoguePlaying":
    case "InputCombo":
      return { id, kind };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { id, kind };
    }
  }
}

/** Apply `fn` to the event with `eventId` anywhere in the tree. Tree-shape preserving. */
function mapEventTree(
  events: PeakyEvent[],
  eventId: string,
  fn: (ev: PeakyEvent) => PeakyEvent,
): PeakyEvent[] {
  return events.map((ev) => {
    if (ev.id === eventId) return fn(ev);
    if (ev.children.length === 0) return ev;
    const newChildren = mapEventTree(ev.children, eventId, fn);
    return newChildren === ev.children ? ev : { ...ev, children: newChildren };
  });
}

/** Apply `fn` to EVERY event in the tree (used by cascade-rename). */
function transformAllEvents(
  events: PeakyEvent[],
  fn: (ev: PeakyEvent) => PeakyEvent,
): PeakyEvent[] {
  return events.map((ev) => {
    const transformed = fn(ev);
    const children = transformAllEvents(transformed.children, fn);
    return children === transformed.children ? transformed : { ...transformed, children };
  });
}

/** Filter `eventId` (and its subtree) out of the tree. */
function filterEventTree(events: PeakyEvent[], eventId: string): PeakyEvent[] {
  const out: PeakyEvent[] = [];
  for (const ev of events) {
    if (ev.id === eventId) continue;
    out.push(ev.children.length === 0 ? ev : { ...ev, children: filterEventTree(ev.children, eventId) });
  }
  return out;
}

/** Move `eventId` up or down within its sibling list. */
function moveEventInTree(
  events: PeakyEvent[],
  eventId: string,
  direction: "up" | "down",
): PeakyEvent[] {
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx >= 0) {
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= events.length) return events;
    const next = [...events];
    const [moved] = next.splice(idx, 1);
    next.splice(target, 0, moved);
    return next;
  }
  // Recurse into children.
  return events.map((ev) => {
    if (ev.children.length === 0) return ev;
    const newChildren = moveEventInTree(ev.children, eventId, direction);
    return newChildren === ev.children ? ev : { ...ev, children: newChildren };
  });
}

/** Take an event (and its subtree) out of the tree. Returns the cleaned tree + removed event. */
function takeEventFromTree(
  events: PeakyEvent[],
  eventId: string,
): { tree: PeakyEvent[]; taken: PeakyEvent | null } {
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx >= 0) {
    const taken = events[idx];
    const tree = [...events.slice(0, idx), ...events.slice(idx + 1)];
    return { tree, taken };
  }
  let taken: PeakyEvent | null = null;
  const tree = events.map((ev) => {
    if (taken || ev.children.length === 0) return ev;
    const r = takeEventFromTree(ev.children, eventId);
    if (r.taken) {
      taken = r.taken;
      return { ...ev, children: r.tree };
    }
    return ev;
  });
  return { tree, taken };
}

/** Insert `node` into the tree at a position relative to `targetId`. */
function insertEventInTree(
  events: PeakyEvent[],
  targetId: string,
  node: PeakyEvent,
  position: "before" | "after" | "inside",
): PeakyEvent[] {
  const idx = events.findIndex((e) => e.id === targetId);
  if (idx >= 0) {
    if (position === "inside") {
      // Drop into the target's children list at the end.
      const next = [...events];
      next[idx] = { ...next[idx], children: [...next[idx].children, node] };
      return next;
    }
    const insertAt = position === "before" ? idx : idx + 1;
    const next = [...events];
    next.splice(insertAt, 0, node);
    return next;
  }
  return events.map((ev) => {
    if (ev.children.length === 0) return ev;
    const newChildren = insertEventInTree(ev.children, targetId, node, position);
    return newChildren === ev.children ? ev : { ...ev, children: newChildren };
  });
}

/** Collect every event id in the subtree rooted at `rootId` (inclusive). */
function collectEventIds(events: PeakyEvent[], rootId: string, out: Set<string>): boolean {
  for (const ev of events) {
    if (ev.id === rootId) {
      out.add(ev.id);
      const collectAll = (node: PeakyEvent) => {
        out.add(node.id);
        for (const c of node.children) collectAll(c);
      };
      for (const c of ev.children) collectAll(c);
      return true;
    }
    if (collectEventIds(ev.children, rootId, out)) return true;
  }
  return false;
}

/**
 * Deep clone an event subtree with fresh ids on every node / condition /
 * action. Preserves combinator, kind, text, groupId, disabled, pageId.
 * Used by the paste flow + duplicateEventInTree.
 */
function cloneEventDeep(ev: PeakyEvent): PeakyEvent {
  return {
    id: newId("evt"),
    kind: ev.kind,
    combinator: ev.combinator,
    text: ev.text,
    groupId: ev.groupId,
    disabled: ev.disabled,
    pageId: ev.pageId,
    conditions: ev.conditions.map((c) => ({ ...c, id: newId("cond") })),
    actions: ev.actions.map((a) => ({ id: newId("act"), kind: a.kind, config: { ...a.config } })),
    children: ev.children.map(cloneEventDeep),
  };
}

/** Deep-clone an event subtree, minting fresh ids for every node + condition + action. */
function duplicateEventInTree(events: PeakyEvent[], srcId: string, newRootId: string): PeakyEvent[] {
  const clone = (ev: PeakyEvent, isRoot: boolean): PeakyEvent => ({
    id: isRoot ? newRootId : newId("evt"),
    kind: ev.kind,
    text: ev.text,
    groupId: ev.groupId,
    disabled: ev.disabled,
    conditions: ev.conditions.map((c) => ({ ...c, id: newId("cond") })),
    actions: ev.actions.map((a) => ({ id: newId("act"), kind: a.kind, config: { ...a.config } })),
    children: ev.children.map((c) => clone(c, false)),
  });
  // Find the source, append a clone of it right after.
  const idx = events.findIndex((e) => e.id === srcId);
  if (idx >= 0) {
    const dup = clone(events[idx], true);
    const next = [...events];
    next.splice(idx + 1, 0, dup);
    return next;
  }
  return events.map((ev) => {
    if (ev.children.length === 0) return ev;
    const newChildren = duplicateEventInTree(ev.children, srcId, newRootId);
    return newChildren === ev.children ? ev : { ...ev, children: newChildren };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers

/** Recompute `sprite.width/height` as the MAX of every frame's
 *  `imageW`/`imageH` across all animations. Called after crop / resize
 *  paths so the asset-level design size tracks the actual cropped
 *  content. Without this, the placement preview (which reads
 *  frame.imageW/H) ends up matching the runtime but the sprite asset's
 *  own w/h fields show stale pre-crop dims — confuses authors who
 *  expect "the sprite's size" to update when they crop. */
function syncSpriteSizeFromFrames(project: PeakyProject, spriteId: string): PeakyProject {
  return {
    ...project,
    sprites: project.sprites.map((s) => {
      if (s.id !== spriteId) return s;
      let maxW = 0;
      let maxH = 0;
      for (const a of s.animations) {
        for (const f of a.frames) {
          if (f.imageW && f.imageW > maxW) maxW = f.imageW;
          if (f.imageH && f.imageH > maxH) maxH = f.imageH;
        }
      }
      // Leave the existing size untouched when there's nothing to derive
      // from (empty sprite, color-only frames) so we don't zero it out.
      if (maxW === 0 || maxH === 0) return s;
      return { ...s, width: maxW, height: maxH };
    }),
  };
}

function mapActiveScene(project: PeakyProject, fn: (scene: SceneData) => SceneData): PeakyProject {
  return {
    ...project,
    scenes: project.scenes.map((s) => (s.id === project.activeSceneId ? fn(s) : s)),
  };
}

/** Sentinel-id prefix for the per-scene Main Event Sheet. The events
 *  panel addresses the main sheet by id `MAIN_SHEET_ID_PREFIX + sceneId`;
 *  mapBlueprint detects the prefix, builds a BP-shaped facade backed by
 *  the scene's mainEvents / mainEventGroups / mainEventPages / mainVariables
 *  fields, runs the caller's mutation `fn`, and writes those four arrays
 *  back to the scene. Lets every existing addEvent / addEventGroup / …
 *  store action work on the main sheet without parallel implementations. */
export const MAIN_SHEET_ID_PREFIX = "__main__:";

/** Rename every reference to a sound (by name) inside a logic sheet's node
 *  graphs. Touches the `sound` string param (PlaySound / StopSound /
 *  PlayMusic / IsMusicPlaying / IsSoundPlaying) and the `sounds` array
 *  (PlaySounds). Returns the same sheet reference when nothing changed. */
function remapSoundInSheet(
  sheet: LogicSheet | undefined,
  oldName: string,
  newName: string,
): LogicSheet | undefined {
  if (!sheet) return sheet;
  const remapNode = (n: LogicGraphNode): LogicGraphNode => {
    const p = n.params;
    let np = p;
    if (typeof p.sound === "string" && p.sound === oldName) {
      np = { ...np, sound: newName };
    }
    if (Array.isArray(p.sounds) && (p.sounds as unknown[]).includes(oldName)) {
      np = { ...np, sounds: (p.sounds as unknown[]).map((x) => (x === oldName ? newName : x)) };
    }
    return np === p ? n : { ...n, params: np };
  };
  return {
    ...sheet,
    folders: sheet.folders.map((f) => ({
      ...f,
      graph: { ...f.graph, nodes: f.graph.nodes.map(remapNode) },
    })),
  };
}

function remapItemInSheet(
  sheet: LogicSheet | undefined,
  oldName: string,
  newName: string,
): LogicSheet | undefined {
  if (!sheet) return sheet;
  const remapNode = (n: LogicGraphNode): LogicGraphNode => {
    const p = n.params;
    if (typeof p.item === "string" && p.item === oldName) {
      return { ...n, params: { ...p, item: newName } };
    }
    return n;
  };
  return {
    ...sheet,
    folders: sheet.folders.map((f) => ({
      ...f,
      graph: { ...f.graph, nodes: f.graph.nodes.map(remapNode) },
    })),
  };
}

// Debug global — only in dev builds. Lets F12 console call
// `__pky.dumpScene()` to inspect the live editor state without hunting
// through React DevTools.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pky = {
    state: () => useEditor.getState(),
    scene: () => useEditor.getState().activeScene(),
    placements: () => useEditor.getState().activeScene().spritePlacements ?? [],
    instances: () => useEditor.getState().activeScene().instances,
    uiInstances: () => useEditor.getState().activeScene().uiInstances ?? [],
    layers: () => useEditor.getState().activeScene().layers,
    dumpScene: () => {
      const sc = useEditor.getState().activeScene();
      console.log("=== SCENE DUMP ===");
      console.log("name:", sc.name, "id:", sc.id);
      console.log("layers:", sc.layers.map((l) => ({ id: l.id, name: l.name })));
      console.log("activeLayerId:", sc.activeLayerId);
      console.log("instances:", sc.instances.length, sc.instances);
      console.log("spritePlacements:", (sc.spritePlacements ?? []).length, sc.spritePlacements);
      console.log("uiInstances:", (sc.uiInstances ?? []).length, sc.uiInstances);
      console.log("tilemapInstances:", (sc.tilemapInstances ?? []).length, sc.tilemapInstances);
    },
  };
}

function remapRecipeInSheet(
  sheet: LogicSheet | undefined,
  oldName: string,
  newName: string,
): LogicSheet | undefined {
  if (!sheet) return sheet;
  const remapNode = (n: LogicGraphNode): LogicGraphNode => {
    const p = n.params;
    if (typeof p.recipe === "string" && p.recipe === oldName) {
      return { ...n, params: { ...p, recipe: newName } };
    }
    return n;
  };
  return {
    ...sheet,
    folders: sheet.folders.map((f) => ({
      ...f,
      graph: { ...f.graph, nodes: f.graph.nodes.map(remapNode) },
    })),
  };
}

/** Generic single-key remapper — walks every logic-sheet node and rewrites
 *  `params[key]` from oldName to newName. Used by the in-session rename
 *  cascades so action configs follow renames instead of silently breaking
 *  at runtime with "X not found" lookups. */
function remapNamedRefInSheet(
  sheet: LogicSheet | undefined,
  key: string,
  oldName: string,
  newName: string,
): LogicSheet | undefined {
  if (!sheet) return sheet;
  const remapNode = (n: LogicGraphNode): LogicGraphNode => {
    const p = n.params;
    if (typeof p[key] === "string" && p[key] === oldName) {
      return { ...n, params: { ...p, [key]: newName } };
    }
    return n;
  };
  return {
    ...sheet,
    folders: sheet.folders.map((f) => ({
      ...f,
      graph: { ...f.graph, nodes: f.graph.nodes.map(remapNode) },
    })),
  };
}

/** Tilemap-specific wrapper preserved for clarity at the call site. */
function remapTilemapInSheet(
  sheet: LogicSheet | undefined,
  oldName: string,
  newName: string,
): LogicSheet | undefined {
  return remapNamedRefInSheet(sheet, "tilemap", oldName, newName);
}

// ─── Variable reference scan + rewrite ──────────────────────────────────────
// Variables are referenced by NAME across the whole project (Logic Sheet node
// params, cross-object expressions, widget bindings). These two pure helpers
// walk every container so a rename can cascade everywhere and the inspector can
// show where a variable is used. Reference forms (see eval.ts grammar):
//   • LOCAL  (owner's own sheets): `var`/`varName` param === name, or `var:name`
//     / `$var:name` token in any string param.
//   • CROSS  (anywhere): `var:<OwnerName>.name` / `$var:<OwnerName>.name`.
// Bare un-prefixed names inside arithmetic are intentionally NOT matched
// (ambiguous — could be any identifier).
function _escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteVarRefs(
  project: PeakyProject,
  ownerId: string,
  ownerName: string,
  oldName: string,
  newName: string,
): PeakyProject {
  const localRe = new RegExp(`(?<![\\w.])(\\$?var:)${_escRe(oldName)}(?![\\w.])`, "g");
  const crossRe = new RegExp(`(?<![\\w.])(\\$?var:)${_escRe(ownerName)}\\.${_escRe(oldName)}(?![\\w.])`, "g");
  const rewriteStr = (s: string, isOwner: boolean): string => {
    let out = s.replace(crossRe, (_m, p: string) => `${p}${ownerName}.${newName}`);
    if (isOwner) out = out.replace(localRe, (_m, p: string) => `${p}${newName}`);
    return out;
  };
  const rewriteParams = (params: Record<string, unknown>, isOwner: boolean): Record<string, unknown> => {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if ((k === "var" || k === "varName") && isOwner && v === oldName) { next[k] = newName; changed = true; }
      else if (typeof v === "string") { const r = rewriteStr(v, isOwner); if (r !== v) changed = true; next[k] = r; }
      else next[k] = v;
    }
    return changed ? next : params;
  };
  const rewriteSheet = (sheet: LogicSheet | undefined, isOwner: boolean): LogicSheet | undefined => {
    if (!sheet) return sheet;
    let sheetChanged = false;
    const folders = sheet.folders.map((f) => {
      let folderChanged = false;
      const nodes = f.graph.nodes.map((n) => {
        const np = rewriteParams(n.params, isOwner);
        if (np !== n.params) { folderChanged = true; return { ...n, params: np }; }
        return n;
      });
      if (folderChanged) { sheetChanged = true; return { ...f, graph: { ...f.graph, nodes } }; }
      return f;
    });
    return sheetChanged ? { ...sheet, folders } : sheet;
  };
  const blueprints = project.blueprints.map((b) => {
    const ls = rewriteSheet(b.logicSheet, b.id === ownerId);
    return ls !== b.logicSheet ? { ...b, logicSheet: ls } : b;
  });
  const uiWidgets = project.uiWidgets.map((w) => {
    const isOwner = w.id === ownerId;
    const ls = rewriteSheet(w.logicSheet, isOwner);
    let bindings = w.bindings;
    if (w.bindings && w.bindings.length) {
      let bChanged = false;
      const nb = w.bindings.map((bd) => {
        const r = rewriteStr(bd.source ?? "", isOwner);
        if (r !== bd.source) { bChanged = true; return { ...bd, source: r }; }
        return bd;
      });
      if (bChanged) bindings = nb;
    }
    return (ls !== w.logicSheet || bindings !== w.bindings) ? { ...w, logicSheet: ls, bindings } : w;
  });
  const mainLogicSheets = project.mainLogicSheets?.map((ms) => {
    const ls = rewriteSheet(ms.sheet, false);
    return ls && ls !== ms.sheet ? { ...ms, sheet: ls } : ms;
  });
  return { ...project, blueprints, uiWidgets, ...(mainLogicSheets ? { mainLogicSheets } : {}) };
}

export interface VarUsage { where: string; detail: string; }

/** Every place `varName` (owned by `ownerId`/`ownerName`) is referenced. */
export function findVarUsages(
  project: PeakyProject,
  ownerId: string,
  ownerName: string,
  varName: string,
): VarUsage[] {
  const localRe = new RegExp(`(?<![\\w.])\\$?var:${_escRe(varName)}(?![\\w.])`);
  const crossRe = new RegExp(`(?<![\\w.])\\$?var:${_escRe(ownerName)}\\.${_escRe(varName)}(?![\\w.])`);
  const humanize = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const out: VarUsage[] = [];
  const paramHit = (params: Record<string, unknown>, isOwner: boolean): boolean => {
    for (const [k, v] of Object.entries(params)) {
      if ((k === "var" || k === "varName") && isOwner && v === varName) return true;
      if (typeof v === "string" && (crossRe.test(v) || (isOwner && localRe.test(v)))) return true;
    }
    return false;
  };
  const scanSheet = (sheet: LogicSheet | undefined, isOwner: boolean, where: string) => {
    if (!sheet) return;
    for (const f of sheet.folders) {
      for (const n of f.graph.nodes) {
        if (n.kind === "trigger" || n.kind === "comment") continue;
        if (paramHit(n.params, isOwner)) out.push({ where, detail: `${f.name} ▸ ${humanize(n.type)}` });
      }
    }
  };
  for (const b of project.blueprints) scanSheet(b.logicSheet, b.id === ownerId, b.id === ownerId ? "This object" : b.name);
  for (const ms of project.mainLogicSheets ?? []) scanSheet(ms.sheet, false, `Main Sheet: ${ms.name}`);
  for (const w of project.uiWidgets) {
    const isOwner = w.id === ownerId;
    scanSheet(w.logicSheet, isOwner, isOwner ? "This widget" : `${w.name} (widget)`);
    for (const bd of w.bindings ?? []) {
      if (crossRe.test(bd.source ?? "") || (isOwner && localRe.test(bd.source ?? ""))) {
        out.push({ where: isOwner ? "This widget" : `${w.name} (widget)`, detail: `binding: ${bd.property}` });
      }
    }
  }
  return out;
}

function mapBlueprint(
  project: PeakyProject,
  bpId: string,
  fn: (bp: BlueprintDef) => BlueprintDef,
): PeakyProject {
  // First try `blueprints` — the common case.
  if (project.blueprints.some((b) => b.id === bpId)) {
    return {
      ...project,
      blueprints: project.blueprints.map((b) => (b.id === bpId ? fn(b) : b)),
    };
  }
  // Fallback: also walk `uiWidgets`. UIWidgetDef shares the shape
  // BlueprintDef does for the event-related fields (events / eventGroups
  // / eventPages / variables / behaviors / id / name / path), so the
  // existing event store actions — which only mutate THOSE shared fields
  // — work for widgets too when routed here. Avoids parallel
  // copy-pasted addEvent/removeEvent/etc. for UI widgets. The cast is
  // safe in practice because event-action callbacks don't reference
  // BP-only fields like `color` / `w` / `h` / `tags`.
  if (project.uiWidgets.some((w) => w.id === bpId)) {
    return {
      ...project,
      uiWidgets: project.uiWidgets.map((w) =>
        w.id === bpId
          ? (fn(w as unknown as BlueprintDef) as unknown as UIWidgetDef)
          : w,
      ),
    };
  }
  // Main Sheet route — bpId looks like `__main__:<sceneId>`. Build a
  // BlueprintDef-shaped facade from the scene's main* arrays, run fn,
  // and unpack the result back into the scene. The facade's behaviors
  // is empty (main sheet has no host BP) and BP-only fields (w/h/color/
  // classKind/tags) get harmless defaults. Event-mutation callbacks
  // never read those; if a future action does, this is the place to
  // surface it.
  if (bpId.startsWith(MAIN_SHEET_ID_PREFIX)) {
    const sceneId = bpId.slice(MAIN_SHEET_ID_PREFIX.length);
    const sceneIdx = project.scenes.findIndex((s) => s.id === sceneId);
    if (sceneIdx < 0) return project;
    const scene = project.scenes[sceneIdx];
    const pages = scene.mainEventPages ?? [{ id: "page-main-default", name: "Page 1" }];
    const facade: BlueprintDef = {
      id: bpId,
      name: "Main Sheet",
      classKind: "Actor",
      tags: [],
      w: 0,
      h: 0,
      color: 0,
      hideRect: true,
      affectedByGravity: false,
      behaviors: [],
      variables: scene.mainVariables ?? [],
      events: scene.mainEvents ?? [],
      eventGroups: scene.mainEventGroups ?? [],
      eventPages: pages,
      path: "/",
    };
    const next = fn(facade);
    const updatedScene: SceneData = {
      ...scene,
      mainEvents: next.events,
      mainEventGroups: next.eventGroups,
      mainEventPages: next.eventPages,
      mainVariables: next.variables,
    };
    return {
      ...project,
      scenes: project.scenes.map((s, i) => (i === sceneIdx ? updatedScene : s)),
    };
  }
  return project;
}

function mapSprite(
  project: PeakyProject,
  spriteId: string,
  fn: (sp: SpriteAsset) => SpriteAsset,
): PeakyProject {
  return {
    ...project,
    sprites: project.sprites.map((s) => (s.id === spriteId ? fn(s) : s)),
  };
}

function mapSpriteAnim(
  project: PeakyProject,
  spriteId: string,
  animId: string,
  fn: (anim: SpriteAnimationDef) => SpriteAnimationDef,
): PeakyProject {
  return mapSprite(project, spriteId, (sp) => ({
    ...sp,
    animations: sp.animations.map((a) => (a.id === animId ? fn(a) : a)),
  }));
}

export function normalizeFolderPath(raw: string): string {
  let p = (raw ?? "").trim();
  if (!p) return "";
  // Run the segment-wise sanitize first so spaces / illegal chars in any
  // segment get cleaned (e.g. "/My Folder/Sub" → "/My_Folder/Sub"). The
  // sanitize helper handles the leading slash + collapse-slashes + trim
  // semantics that the old hand-rolled logic below used to do — but only
  // when there's at least one segment. Empty / root input bypasses it.
  if (p === "/" || p === "") {
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/\/+/g, "/");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  }
  return sanitizeFolderPath(p);
}

function parentFolder(path: string): string {
  const norm = normalizeFolderPath(path);
  if (!norm || norm === "/") return "/";
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "/" : norm.slice(0, i);
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-snapshot for undo/redo

useEditor.subscribe((state, prevState) => {
  if (_skipSnap || state.project === prevState.project) return;
  // Capture the FIRST prevState in this burst — that's what undo
  // should land on. Subsequent changes inside the debounce window
  // overwrite the timer, not the captured snapshot.
  if (_burstPrevProject === null) {
    _burstPrevProject = prevState.project;
  }
  if (_snapTimer !== undefined) clearTimeout(_snapTimer);
  _snapTimer = setTimeout(() => {
    const captured = _burstPrevProject;
    _burstPrevProject = null;
    _snapTimer = undefined;
    if (captured === null) return;
    _skipSnap = true;
    useEditor.setState({
      past: [...useEditor.getState().past.slice(-49), captured],
      future: [],
    });
    _skipSnap = false;
    console.log(`[Snap] taken — past=${useEditor.getState().past.length}`);
  }, SNAP_DEBOUNCE_MS);
});

// ────────────────────────────────────────────────────────────────────────────
// Auto-save (debounced) + auto-load on startup
//
// Storage backend: IndexedDB — now a READ-ONLY recovery surface. The old
// debounced IDB autosave was REMOVED: it was fully inert (the subscribe that
// drove it was commented out, the boot rehydrate was an empty IIFE, and the
// flush timer was never set, so flushOnExit could never fire). Autosave lives
// in TopBar.tsx (debounced saveProjectToFolder). The old IDB autosave was
// removed — see git history.
//
// readRawAutosave below stays as the recovery read path for legacy autosaves
// from before folder mode; idbGet / openIdb / the constants below support it.

const AUTOSAVE_KEY = "peaky.autosave";
const IDB_DB_NAME = "peaky-editor";
const IDB_STORE = "kv";
const IDB_KEY = "autosave";

/** Lazily-opened IndexedDB connection (reused across reads). */
let _idbPromise: Promise<IDBDatabase> | null = null;

function openIdb(): Promise<IDBDatabase> {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  // If the open fails, clear the cache so a future call retries.
  _idbPromise.catch(() => { _idbPromise = null; });
  return _idbPromise;
}

async function idbGet<T>(): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Legacy autosave read — recovery surface for pre-folder-mode projects.
 *  Read the raw auto-saved project blob straight from storage, bypassing the
 *  Zustand store. The recovery menu uses this so a corrupted in-memory state
 *  can't taint the exported file. Tries IndexedDB first, then the legacy
 *  localStorage key. Returns `undefined` if nothing is saved. */
export async function readRawAutosave(): Promise<unknown | undefined> {
  try {
    const fromIdb = await idbGet<unknown>();
    if (fromIdb !== undefined) return fromIdb;
  } catch { /* fall through to localStorage */ }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt or absent */ }
  return undefined;
}

// ── Boot ─────────────────────────────────────────────────────────────────
// Folder mode (v7+) does NOT autoload from IndexedDB. The state references
// files on disk, but the AssetStore can't be re-instantiated automatically —
// the browser requires a user gesture to re-grant directory permission. So we
// boot empty and let the author hit "File → Open Folder…", which restores
// state AND mounts the AssetStore from the picked directory. There is no
// startup rehydrate (the old empty IIFE was removed alongside the dead IDB
// autosave). Autosave lives in TopBar.tsx (debounced saveProjectToFolder).
