import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";
import { getSpritesByTag } from "../Sprite";
import { persistentState } from "../PersistentState";
import { Logger } from "../Logger";
import { Collider } from "./Collider";

/**
 * TilemapRenderer — spawns one or more Phaser TilemapLayers at the host
 * sprite's position. Each input layer (from the TilemapAsset.layers array)
 * becomes its own Phaser layer with its own depth band, alpha, and
 * collision flag, so authors can stack ground / decoration / foreground
 * inside a single placed tilemap.
 *
 * Collision integration: every layer with `collides: true` AND non-empty
 * `solidIndices` is registered in `scene.data["peaky.tilemapLayers"]`.
 * Game.registerCollisions wires NEW sprites against them; the renderer's
 * own init wires existing sprites.
 */
interface InputLayer {
  id: string;
  /** Author-facing layer name (e.g. "Main", "Foliage"). Used by tilemap
   *  action handlers (SetTile / CompareTileAt / ...) so authors can pick
   *  layers by their UI name instead of opaque ids. */
  name?: string;
  tiles: number[];
  /** Sparse per-cell packed transform keyed by flat index (bit0 flipX, bit1
   *  flipY, bits2-3 rotation × 90° CW). Visual only — collision/mining read
   *  the upright tile index. Omit / 0 = upright. */
  xf?: Record<number, number>;
  z: number;
  alpha: number;
  visible: boolean;
  collides: boolean;
  /** BigTile placements — instances of tileset BigTiles painted into this
   *  layer. Each renders as ONE sprite and Y-sorts as one unit. */
  bigTilePlacements?: { id: string; bigTileId: string; c: number; r: number }[];
  animatedTilePlacements?: { id: string; animatedTileId: string; c: number; r: number }[];
  /** Tags propagated to every per-tile image in this layer — VisionMask
   *  reads these to decide whether to fade. Tag a ground layer "ground"
   *  to keep the floor opaque while trees still fade. */
  tags?: string[];
  /** Per-internal-layer Y-sort opt-in. Only effective when the SCENE layer is
   *  also Y-sort (`this.ySort`). When both are true this layer renders per-cell
   *  so its tiles interleave with sprites by Y; otherwise it stays on the cheap
   *  batched path. Lets a map keep big water/grass fills batched while only a
   *  sparse foliage layer pays the per-cell cost. */
  ySort?: boolean;
}

/** One tileset in the map's ordered list — its Phaser texture key, the global
 *  id of its first cell (firstgid), and its slicing geometry. */
interface TilesetSlotInfo {
  textureKey: string;
  firstgid: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  marginX: number;
  marginY: number;
  spacingX: number;
  spacingY: number;
}

/** Owning-tileset source for a BigTile composite on a multi-tileset map. */
interface BigTileSrc {
  key: string;
  tileW: number;
  tileH: number;
  marginX: number;
  marginY: number;
  spacingX: number;
  spacingY: number;
}

/** One runtime animated-tile frame: a global tile index (1×1 cell) or a
 *  {c,r,w,h} multi-cell region composited from the owning tileset (like a
 *  BigTile). See AnimFrame in the editor schema. */
type AnimFrameRuntime = number | { c: number; r: number; w: number; h: number };

/** Runtime shape for an animated-tile def passed in from runProject. */
interface AnimatedTileDefRuntime {
  id: string;
  name?: string;
  frames: AnimFrameRuntime[];
  fps: number;
  loop: boolean;
  autoplay: boolean;
  /** Owning tileset source for REGION frames on a multi-tileset map (so the
   *  composite reads the right atlas). Undefined on single-tileset maps. */
  _src?: BigTileSrc;
  /** Literal integer OR `random(min, max)` expression — rolled per-placement
   *  on first damage (see TilesetAsset.tileHardness). */
  hardness?: number | string;
  destroyOnDepleted?: boolean;
  playOnDepleted?: boolean;
  playOnHit?: boolean;
  damageStagesMode?: boolean;
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
  /** Drop layer name. Same fallback semantics as `tileDropLayer`. */
  dropLayer?: string;
  /** Extra excluded tags for this placement (union with globalExcludedTags). */
  excludedTags?: string[];
  /** Cascade behavior — see `tileOnBelowRemoved`. */
  onBelowRemoved?: "destroy" | "drop";
  collide?: { points: { x: number; y: number }[] };
  tags?: string[];
  playOnOverlap?: boolean;
  overlapTags?: string[];
  overlapMode?: "edge" | "loop" | "latch";
  /** Signal emitted (on the miner + Main Sheets) on every surviving hit. */
  signalOnHit?: string;
  /** Signal emitted (on the miner + Main Sheets) when the tile is destroyed. */
  signalOnMine?: string;
}

export class TilemapRenderer extends Behavior {
  kind = "TilemapRenderer";
  /** Tilemap ASSET name (not instanceId). Used by the tilemap-action system to
   *  find a placed map by name (`peaky.tilemapsByName`). Populated by runProject. */
  name = "";

  // ── Config (injected by runProject) ─────────────────────────────────
  tilemapId = "";
  /** Phaser texture key for the tileset sheet. */
  textureKey = "";
  /** Authored layers (already sorted ascending z by runProject). */
  layers: InputLayer[] = [];
  cols = 0;
  rows = 0;
  tileW = 32;
  tileH = 32;
  marginX = 0;
  marginY = 0;
  spacingX = 0;
  spacingY = 0;
  /** Tile indices in the tileset that block movement (applied per-layer
   *  when that layer's `collides` flag is on). */
  solidIndices: number[] = [];
  /** Per-tile custom collision POLYGONS (points in pixels within the cell).
   *  Tiles in `solidIndices` but NOT here use the efficient full-cell layer-
   *  collision path. Tiles WITH a polygon are decomposed into axis-aligned
   *  rectangles (arcade physics doesn't support polygon bodies natively) and
   *  spawned as static bodies per cell. */
  tileColliders: Record<string, { points: { x: number; y: number }[] }> = {};
  /** Per-tile-index hardness — total HP a tile starts with. Absent =
   *  unbreakable. Values can be a literal integer (every cell = same HP)
   *  or a `random(min, max)` expression that rolls per-cell on first hit. */
  tileHardness: Record<string, number | string> = {};
  /** Per-tile-index grow-back delay (seconds) — a destroyed cell re-appears
   *  after this long. 0 / blank = never. Accepts a number, `random(min, max)`,
   *  or `choose(a, b, …)` (rolled per destroyed cell). */
  tileGrowBack: Record<string, number | string> = {};
  /** Pending regrows — each destroyed tile that opted into grow-back. Counted
   *  down by `update(delta)`; on expiry the original tile/composite is re-placed
   *  at its cell (HP resets to full). */
  private _regrow: { remaining: number; pop: boolean; layerId: string; c: number; r: number; tileIdx?: number; xf?: number; bigTileId?: string; animTileId?: string }[] = [];
  /** Per-regular-tile-index "pop in on regrow" toggle. Absent / true = scale-up
   *  animation; explicit false = appear instantly. */
  tileGrowBackPop: Record<string, boolean> = {};
  /** Per-tile-index drop tables — what `MineTileAtWorld` spawns on destroy.
   *  Each entry rolls chance + count, then spawns the named BP at the
   *  destroyed cell's world center with the supplied per-instance overrides
   *  (same mental model as placing a BP in the scene editor). */
  tileDrops: Record<string, {
    bp: string;
    min: number;
    max: number;
    chance: number;
    instanceName?: string;
    animation?: string;
    frame?: number;
    vars?: Record<string, string | number | boolean>;
  }[]> = {};
  /** Per-tile-index drop layer name. Drops spawn on this layer when set;
   *  fall back to the tilemap's own layer when missing/blank or the name
   *  doesn't resolve in the current scene. */
  tileDropLayer: Record<string, string> = {};
  /** Tags whose sprites pass through EVERY collider in this tileset
   *  (regular tiles, animated tiles, big tiles). Combined union-style with
   *  per-collider excluded tags. */
  globalExcludedTags: string[] = [];
  /** Per-tile-index extra excluded tags. Stacks on top of globalExcludedTags. */
  tileExcludedTags: Record<string, string[]> = {};
  /** Per-tile-index cascade behavior when the tile BELOW this one is removed.
   *  `destroy` chains drops + recurses; `drop` tweens the tile down into the
   *  gap; missing = nothing (the tile stays put / floats). */
  tileOnBelowRemoved: Record<string, "destroy" | "drop"> = {};

  /** Union the tileset-global excluded tags with this tile-index's extras. */
  getExcludedTagsForTile(tileIdx: number): string[] {
    const per = this.tileExcludedTags[String(tileIdx)];
    if (!per || per.length === 0) return this.globalExcludedTags;
    if (this.globalExcludedTags.length === 0) return per;
    return [...this.globalExcludedTags, ...per];
  }

  /** Union for an animated-tile placement's collider. */
  getExcludedTagsForAnimated(animatedTileId: string): string[] {
    const def = this.animatedTiles[animatedTileId];
    const per = def?.excludedTags;
    if (!per || per.length === 0) return this.globalExcludedTags;
    if (this.globalExcludedTags.length === 0) return per;
    return [...this.globalExcludedTags, ...per];
  }

  /** Create the visible BigTile Image with the right texture binding.
   *  Masked BigTiles use a stand-alone canvas texture (key matches frameKey);
   *  rectangular BigTiles read a sub-frame of the spritesheet texture. */
  private _addBigTileImage(scene: Phaser.Scene, worldX: number, worldY: number, bt: { id: string; w: number; h: number; cells?: { c: number; r: number }[] }): Phaser.GameObjects.Image {
    // Both sparse AND non-sparse BigTiles now live as stand-alone canvas
    // textures (keyed `bigtile_<id>`) built by ensureBigTileFrames. The
    // canvas omits the atlas's per-tile spacing so the rendered image
    // exactly matches `bt.w × tileW` × `bt.h × tileH` in the world.
    // Previously this path used the extruded atlas + a sub-frame for the
    // non-sparse fast case, but the sub-frame baked in the spacing rows
    // and made trees overhang into the row below.
    const frameKey = `bigtile_${bt.id}`;
    return scene.add.image(worldX, worldY, frameKey);
  }

  /** Whether the absolute cell (c, r) is part of a BigTile placement's
   *  occupied area. Respects the optional sparse `cells` mask — a tree with
   *  trunk-only mask returns true ONLY for trunk cells, even though the
   *  bbox covers the canopy too. */
  private _bigTileCovers(bt: { w: number; h: number; cells?: { c: number; r: number }[] }, p: { c: number; r: number }, c: number, r: number): boolean {
    const relC = c - p.c;
    const relR = r - p.r;
    if (relC < 0 || relC >= bt.w || relR < 0 || relR >= bt.h) return false;
    if (!bt.cells || bt.cells.length === 0) return true;
    for (const cell of bt.cells) {
      if (cell.c === relC && cell.r === relR) return true;
    }
    return false;
  }

  /** Union for a BigTile placement's collider. */
  getExcludedTagsForBigTile(bigTileId: string): string[] {
    const bt = this.bigTiles[bigTileId];
    const per = bt?.excludedTags;
    if (!per || per.length === 0) return this.globalExcludedTags;
    if (this.globalExcludedTags.length === 0) return per;
    return [...this.globalExcludedTags, ...per];
  }
  /** Tileset BigTile definitions — rectangular regions in the source sheet
   *  that act as one composite tile. Keyed by bigTile id. `_src` is set only
   *  for multi-tileset maps: it points the BigTile composite at its OWNING
   *  tileset's source atlas (the combined runtime texture is reflowed, so the
   *  BigTile's contiguous region only exists in the original sheet). */
  bigTiles: Record<string, { id: string; name?: string; c: number; r: number; w: number; h: number; pivotX?: number; pivotY?: number; sortY?: number; sortLineY?: number; collide?: { cx: number; cy: number; cw: number; ch: number }; collidePoly?: { points: { x: number; y: number }[] }; solid?: boolean; tags?: string[]; excludedTags?: string[]; onBelowRemoved?: "destroy" | "drop"; cells?: { c: number; r: number }[]; hardness?: number | string; damageRect?: { cx: number; cy: number; cw: number; ch: number }; drops?: { bp: string; min: number; max: number; chance: number; instanceName?: string; animation?: string; frame?: number; vars?: Record<string, string | number | boolean> }[]; dropLayer?: string; destroyOnDepleted?: boolean; signalOnHit?: string; signalOnMine?: string; _src?: BigTileSrc }> = {};
  /** Tileset animated-tile definitions — cycling frame composites keyed by id. */
  animatedTiles: Record<string, AnimatedTileDefRuntime> = {};
  /** Ordered tileset slots (primary + extras) with firstgids + atlas geometry.
   *  When length > 1 the renderer reflows them into ONE combined texture at
   *  init so the rest of the pipeline stays single-texture / single-grid. A
   *  one-element list (or empty) uses the flat `textureKey` path unchanged. */
  tilesets: TilesetSlotInfo[] = [];
  /** Tileset slicing dimensions used to compute BigTile pixel regions and add
   *  the right texture frames. */
  tilesetCols = 0;
  tilesetRows = 0;
  /** Y-sort mode — when on, this tilemap's authored layers are split into
   *  one Phaser layer PER non-empty ROW. Each row's depth is set from its
   *  world Y so the player + other Y-sorted sprites can interleave between
   *  rows ("walk behind a tree" effect). Off → standard one-Phaser-layer-per-
   *  authored-layer rendering, no per-row split. */
  ySort = false;

  // ── Runtime state ───────────────────────────────────────────────────
  // One Phaser Tilemap + Phaser TilemapLayer per author-layer. The "one-map-
  // multiple-layers" Phaser pattern works when you start from cached map
  // JSON, but the blank-tilemap-then-createBlankLayer path has been flaky
  // across versions. Per-layer-tilemap is bulletproof: feed `data` directly
  // and let Phaser do its standard layer init.
  private maps: Phaser.Tilemaps.Tilemap[] = [];
  /** True once `_init` has actually built this map's visuals (or determined it
   *  has nothing to draw). The scene-ready gate (peaky:sceneReady) waits on
   *  every renderer's `rendered` so the loader only reveals a fully-painted
   *  scene — a map that deferred on a missing texture keeps this false until its
   *  retry re-runs `_init`. */
  rendered = false;
  private phaserLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  /** Per-Phaser-layer depth offset (added on top of _layerBaseDepth in
   *  applyLayer). For non-Y-sort layers this is L.z × 0.01. */
  private phaserLayerDepthOffsets: number[] = [];
  /** Parallel array to `phaserLayers`: the authored layer each Phaser layer
   *  belongs to. */
  private phaserLayerAuthored: InputLayer[] = [];
  /** Per-tile sprite Images spawned for Y-sort mode (each = one tile cell's
   *  visual). They share the sprite pipeline with the player so depth-sort
   *  works correctly. Each entry has the Image + its depth offset (cell's
   *  world-bottom Y) + the cell's (c, r) coords used by flood-fill. */
  private perTileImages: { img: Phaser.GameObjects.Image; depthOffset: number; L: InputLayer; c: number; r: number }[] = [];
  /** Collision-only Phaser tilemap layers spawned for Y-sort mode — they
   *  hold collision data via setCollision but never render visually (per-tile
   *  Images do the visuals). Kept separate from `phaserLayers` so applyLayer
   *  doesn't re-show them. */
  private collisionOnlyLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  /** Phaser colliders we own — destroyed in onDestroy. */
  private _ownColliders: Phaser.Physics.Arcade.Collider[] = [];
  /** StaticGroup that holds custom-shape collision bodies (one per merged
   *  rectangle). Wired into sprite Colliders alongside the tilemap layers. */
  private _customCollisionGroup: Phaser.Physics.Arcade.StaticGroup | null = null;
  /** BigTile collision rectangles tracked so applyLayer can hide them in lock-
   *  step with the layer they belong to (Phaser bodies don't auto-disable when
   *  their game object goes invisible). */
  private bigTileColliderBodies: { go: Phaser.GameObjects.Rectangle; L: InputLayer }[] = [];
  /** Per-renderer references into `scene.data["peaky.bigTileImages"]` so
   *  onDestroy can splice this renderer's contributions without nuking
   *  entries owned by other tilemaps in the same scene. Stores GameObject
   *  (not Image) because non-Y-sort layers register the whole TilemapLayer. */
  private bigTileRegistryEntries: { img: Phaser.GameObjects.GameObject }[] = [];
  private _layerAlpha = 1;
  private _layerVisible = true;
  private _layerBaseDepth = 0;
  private _scrollX = 1;
  private _scrollY = 1;
  /** World-space top-left of the tilemap grid. Cached at init for fast
   *  world↔cell math in the public API (host doesn't move at runtime). */
  private _layerLeft = 0;
  private _layerTop = 0;
  /** Fast lookup: `${layerId}#${c},${r}` → entry into perTileImages. Lets
   *  setTileAt / removeTileAt find the existing Image without scanning the
   *  array. Parallel to perTileImages — kept in sync when entries are added
   *  or destroyed. */
  private _cellImageByKey = new Map<string, { img: Phaser.GameObjects.Image; depthOffset: number; L: InputLayer; c: number; r: number }>();
  /** Y-sort mode: invisible TilemapLayer that owns collision data for each
   *  authored layer (collision needs to be on a TilemapLayer, not on per-tile
   *  Images). Keyed by InputLayer.id so setTileAt can sync collision when a
   *  tile is changed. */
  private _collisionLayerById = new Map<string, Phaser.Tilemaps.TilemapLayer>();
  /** Standard mode: authored layer id → Phaser layer. Used by setTileAt for
   *  the non-Y-sort path (one big batched layer per InputLayer). */
  private _phaserLayerById = new Map<string, Phaser.Tilemaps.TilemapLayer>();
  /** Per-cell custom-polygon collider bodies, keyed by `${layerId}#${c},${r}`.
   *  Tracked so setTileAt can destroy the bodies belonging to the OLD tile
   *  when a cell mutates (and spawn fresh ones for the new tile if it also
   *  uses a custom collider). Without this map the polygon-decomposed static
   *  rects stayed in the scene as invisible walls after RemoveTile. */
  private _cellCustomBodies = new Map<string, Phaser.GameObjects.Rectangle[]>();
  /** Per-tile-index polygon decomposition cache — `polygonToRects` is pure,
   *  so we memoize by tile index across all cells of the same kind. */
  private _polyRectCache = new Map<number, { x: number; y: number; w: number; h: number }[]>();
  /** Per-BigTile-placement resources, keyed by placement id. Tracks the
   *  spawned Image, its (optional) static collision body, and the authored
   *  layer the placement belongs to. Lets `removeBigTileAt` surgically
   *  destroy a placement without re-scanning the perTileImages array. */
  private _bigTilePlacementResources = new Map<string, {
    img: Phaser.GameObjects.Image;
    colliders: Phaser.GameObjects.Rectangle[];
    L: InputLayer;
  }>();
  /** BigTile placements kept in-scene after HP-0 (destroyOnDepleted=false) so
   *  further mining hits don't re-fire drops. */
  private _bigTileDepleted = new Set<string>();
  /** Per-animated-placement runtime state. Keyed by placement id. The clock
   *  advances frames in update() based on the def's fps. `playing` honors
   *  autoplay at spawn; Play/Stop actions toggle it later. `loopOverride`
   *  is set when PlayTileAnimation explicitly passes a loop param —
   *  otherwise the def's loop flag is consulted. */
  /** Monotonic counter for runtime-spawned animated placement ids. Paired
   *  with Date.now()-base36 prefix in `placeAnimatedTile` so ids are
   *  collision-free even in long mining sessions. */
  private _nextAnimatedId = 1;
  private _animatedPlacements = new Map<string, {
    placement: { id: string; animatedTileId: string; c: number; r: number };
    L: InputLayer;
    img: Phaser.GameObjects.Image;
    collider: Phaser.GameObjects.Rectangle | null;
    def: AnimatedTileDefRuntime;
    frameIdx: number;
    elapsedSec: number;
    playing: boolean;
    loopOverride: boolean | null;
    /** True once HP hit 0 — gates further mining (no double drops) and
     *  signals update() to destroy on animation-end when the def opts into
     *  the play-then-destroy mode. */
    depleted: boolean;
    /** True while a play-on-depleted one-shot is running. Cleared when the
     *  animation reaches its last frame; at that point the placement either
     *  self-destroys (destroyOnDepleted) or freezes on the last frame. */
    depletingAnim: boolean;
    /** True while a play-on-HIT reaction is running (a surviving mine hit
     *  played the animation once). On end it resets to frame 0 (idle). */
    reacting: boolean;
    /** UIDs of tagged sprites overlapping this cell LAST frame — drives the
     *  rising-edge detection for `playOnOverlap`. Lazily created (only for
     *  placements whose def opts into overlap playback). */
    overlapUids?: Set<number>;
    /** True while an overlap "loop while overlapping" cycle is running — gates
     *  the same fps-0 fallback as `reacting` so a static animated tile still
     *  cycles while a sprite stands on it. */
    overlapLoop?: boolean;
    /** Set by the viewport cull pass — when true the placement is off-screen
     *  (beyond the camera + margin) so update() skips advancing its frames. */
    culled?: boolean;
  }>();

  init(): void {
    try {
      this._init();
    } catch (err) {
      // Catch + log instead of throwing — a misconfigured tilemap should never
      // brick the whole game boot. The host body stays hidden + inert from
      // _init's first few lines, so the rest of the scene continues normally.
      console.error("TilemapRenderer init failed:", err);
    }
    // Snapshot the AUTHORED tile grids so serialize() can diff the runtime edits
    // (mined / placed tiles) for save/load + level persistence. setTileAt mutates
    // L.tiles in place, so this copy is the immutable baseline.
    this._authoredTiles = {};
    for (const L of this.layers) this._authoredTiles[L.id] = [...(L.tiles ?? [])];
  }

  /** Authored tile grids per layer, captured at init — baseline for the
   *  serialize() diff. See serialize/deserialize. */
  private _authoredTiles?: Record<string, number[]>;

  /** Save the runtime tilemap edits: mined/placed regular tiles (diff vs
   *  authored), ALL current BigTile + animated placements, and partial-damage
   *  HP. Returns undefined when nothing changed so the save stays lean. The host
   *  sprite is in peaky.sprites with a stable instanceId, so SaveSlot/LoadSlot
   *  call these automatically; level changes route through the same payload via
   *  PersistentState. */
  serialize(): Record<string, unknown> | undefined {
    const tiles: { l: string; c: number; r: number; i: number }[] = [];
    if (this._authoredTiles) {
      for (const L of this.layers) {
        const auth = this._authoredTiles[L.id];
        if (!auth) continue;
        const n = Math.max(L.tiles.length, auth.length);
        for (let i = 0; i < n; i++) {
          const cur = L.tiles[i] ?? -1;
          if (cur !== (auth[i] ?? -1)) tiles.push({ l: L.id, c: i % this.cols, r: Math.floor(i / this.cols), i: cur });
        }
      }
    }
    const big: { l: string; b: string; c: number; r: number }[] = [];
    const anim: { l: string; a: string; c: number; r: number }[] = [];
    for (const L of this.layers) {
      for (const p of L.bigTilePlacements ?? []) big.push({ l: L.id, b: p.bigTileId, c: p.c, r: p.r });
      for (const p of L.animatedTilePlacements ?? []) anim.push({ l: L.id, a: p.animatedTileId, c: p.c, r: p.r });
    }
    const myLayers = new Set(this.layers.map((L) => L.id));
    const hpMap = this.sprite.scene?.data?.get("peaky.tileHP") as Map<string, number> | undefined;
    const hp: Record<string, number> = {};
    if (hpMap) for (const [k, v] of hpMap) { if (myLayers.has(k.split("#")[0])) hp[k] = v; }
    if (tiles.length === 0 && big.length === 0 && anim.length === 0 && Object.keys(hp).length === 0) return undefined;
    return { tiles, big, anim, hp };
  }

  /** Restore tilemap edits onto a freshly-built (authored) map: clear ALL current
   *  placements (the save is the source of truth), re-apply tile edits, re-place
   *  BigTile + animated tiles, restore HP. */
  deserialize(state: Record<string, unknown>): void {
    const s = state as {
      tiles?: { l: string; c: number; r: number; i: number }[];
      big?: { l: string; b: string; c: number; r: number }[];
      anim?: { l: string; a: string; c: number; r: number }[];
      hp?: Record<string, number>;
    };
    for (const L of this.layers) {
      for (const p of [...(L.bigTilePlacements ?? [])]) this._destroyBigTilePlacement(L, p.id);
      for (const p of [...(L.animatedTilePlacements ?? [])]) this._destroyAnimatedPlacement(L.id, p.id);
      // Reset the records directly too: when _init deferred (tileset texture not
      // loaded yet), _destroyBigTilePlacement no-ops on resources that don't
      // exist and leaves the authored records in place — so the later deferred
      // _init would spawn them AGAIN on top of the ones we re-place below.
      L.bigTilePlacements = [];
      L.animatedTilePlacements = [];
    }
    for (const t of s.tiles ?? []) this.setTileAt(t.l, t.c, t.r, t.i);
    for (const b of s.big ?? []) this.placeBigTile(b.l, b.b, b.c, b.r);
    for (const a of s.anim ?? []) this.placeAnimatedTile(a.l, a.a, a.c, a.r);
    if (s.hp) {
      let hpMap = this.sprite.scene?.data?.get("peaky.tileHP") as Map<string, number> | undefined;
      if (!hpMap && this.sprite.scene) { hpMap = new Map<string, number>(); this.sprite.scene.data.set("peaky.tileHP", hpMap); }
      if (hpMap) for (const [k, v] of Object.entries(s.hp)) hpMap.set(k, v);
    }
  }

  private _init(): void {
    const scene = this.sprite.scene;
    // Host body shouldn't physics-block — the per-layer tilemap layers own collision.
    this.sprite.gameObject.setAlpha(0);
    const body = this.sprite.body;
    if (body) {
      body.enable = false;
      body.setAllowGravity(false);
      body.setImmovable(true);
    }

    // Re-init guard: if this is a second _init() call (e.g. tileset swapped at
    // runtime), tear down the previously spawned GameObjects so they don't leak
    // as orphaned Images/bodies/maps in the scene.
    // Wide re-init guard: any state map populated from a prior _init counts
    // — without this, an _init that failed partway (e.g. texture missing)
    // could leak entries in _animatedPlacements / _bigTilePlacementResources
    // / _collisionLayerById on the next attempt because the original guard
    // only checked the visual arrays.
    if (
      this.perTileImages.length > 0 ||
      this.phaserLayers.length > 0 ||
      this.maps.length > 0 ||
      this._animatedPlacements.size > 0 ||
      this._bigTilePlacementResources.size > 0 ||
      this._collisionLayerById.size > 0 ||
      this.bigTileColliderBodies.length > 0 ||
      this._cellCustomBodies.size > 0
    ) {
      this.onDestroy();
    }
    // Polygon decomposition cache is keyed by tile index — if the tileset's
    // tileColliders config changes between _init calls (hot-reload, swapped
    // asset), the cached rects belong to the previous shape. Clear so
    // setTileAt + the init spawn re-decompose against the live config.
    this._polyRectCache.clear();

    if (this.cols <= 0 || this.rows <= 0 || !Array.isArray(this.layers) || this.layers.length === 0) { this.rendered = true; return; }

    // Multi-tileset: reflow every source atlas into ONE combined texture so the
    // rest of the pipeline (frame math, collision, Phaser layers) stays single-
    // texture / single-grid. Needs all source atlases loaded first; if any is
    // missing we hook its load event and retry, same pattern as the single-
    // texture case below. Painted cells already hold GLOBAL ids, which the
    // combined texture lays out row-major at `tile_<global>`.
    if (this.tilesets.length > 1) {
      const missing = this.tilesets.filter((s) => !scene.textures.exists(s.textureKey));
      if (missing.length > 0) {
        Logger.log({
          level: "warn",
          source: "TilemapRenderer.init",
          message: `${missing.length} tileset texture(s) not loaded yet — tilemap "${this.name || this.tilemapId}" will retry on load.`,
        });
        const retry = () => { try { this._init(); } catch (e) { console.error(e); } };
        for (const s of missing) scene.textures.once(`addtexture-${s.textureKey}`, retry);
        // Belt + suspenders (same as the single-texture path below): in the
        // EXPORTED game atlases load from inlined data URLs whose decode can
        // finish in the window between the exists() check and the once() above,
        // so the event may never fire for that slot. A nextTick re-check rescues
        // the map from staying permanently blank.
        scene.time.delayedCall(0, () => {
          if (this.tilesets.every((s) => scene.textures.exists(s.textureKey)) && this.phaserLayers.length === 0 && this.perTileImages.length === 0) retry();
        });
        return;
      }
      const combined = ensureCombinedTileset(scene, this.tilesets);
      if (combined) {
        this.textureKey = combined.key;
        this.tileW = combined.tileW;
        this.tileH = combined.tileH;
        this.marginX = 0; this.marginY = 0; this.spacingX = 0; this.spacingY = 0;
      }
    }

    if (!this.textureKey || !scene.textures.exists(this.textureKey)) {
      // Texture not registered yet — common when this renderer spawns before
      // the loader queue finishes. Silent return would leak: nothing ever
      // calls _init again. Hook the texture loader's add-event for this key
      // so we retry the moment the texture is registered. Log so authors
      // know why the tilemap is briefly blank.
      Logger.log({
        level: "warn",
        source: "TilemapRenderer.init",
        message: `texture "${this.textureKey}" not loaded yet — tilemap "${this.name || this.tilemapId}" will retry init on texture load.`,
      });
      const retry = () => { try { this._init(); } catch (e) { console.error(e); } };
      scene.textures.once(`addtexture-${this.textureKey}`, retry);
      // Belt + suspenders: a single-frame nextTick fallback in case the event
      // already fired during a prior tick (rare race between loader and our
      // addBehavior wiring).
      scene.time.delayedCall(0, () => {
        if (scene.textures.exists(this.textureKey) && this.phaserLayers.length === 0 && this.perTileImages.length === 0) retry();
      });
      return;
    }

    // The scene-layer base-depth + scroll factors are set on the host gameObject
    // BEFORE addBehavior calls us (see runProject.ts tilemap spawn). applyLayer
    // won't fire until AFTER init returns, so without this we'd build the per-row
    // layers with the default _layerBaseDepth = 0 and Y-sort comparisons against
    // sprites at depth ~1,000,000 would always lose. Seed from the host now.
    this._layerBaseDepth = this.sprite.gameObject.depth;
    this._scrollX = this.sprite.gameObject.scrollFactorX;
    this._scrollY = this.sprite.gameObject.scrollFactorY;

    // Build (or reuse) an extruded variant of the tileset texture to defeat
    // bilinear / trilinear bleed at tile edges. Swaps textureKey + margin +
    // spacing to the extruded values so every downstream call (addTilesetImage,
    // ensureTilesetFrames, ensureBigTileFrames, scene.add.image(..., textureKey,
    // `tile_N`)) naturally uses the padded layout. Cached on the scene, so the
    // build cost is one-time per (asset × tile dims), not per-instance.
    // The extruded texture only ADDS edge padding; tile pixel data is byte-
    // identical, so nearest-sampling games look the same as before.
    const x = ensureExtrudedTileset(
      scene, this.textureKey, this.tileW, this.tileH,
      this.marginX, this.marginY, this.spacingX, this.spacingY,
    );
    this.textureKey = x.key;
    this.marginX = x.marginX;
    this.marginY = x.marginY;
    this.spacingX = x.spacingX;
    this.spacingY = x.spacingY;

    // Host body's (obj.x, obj.y) is the CENTER (Phaser Rectangle origin 0.5).
    // Layers anchor at TOP-LEFT (Tiled convention) — offset back by half the
    // map's pixel size so the user-placed (x, y) becomes the layer top-left.
    const obj = this.sprite.gameObject;
    const layerLeft = obj.x - (this.cols * this.tileW) / 2;
    const layerTop  = obj.y - (this.rows * this.tileH) / 2;
    this._layerLeft = layerLeft;
    this._layerTop = layerTop;

    // Publish to the scene registry so tilemap-targeted actions (SetTile,
    // RemoveTile, MineTileAtWorld, ...) can find this renderer by asset name.
    // Multiple instances of the same asset name → last one wins. Cleared in
    // onDestroy so a re-init / scene shutdown leaves no dangling reference.
    if (this.name) {
      // Last-wins by-name registry — used by non-spatial actions like
      // PlayAllTileAnimations where the caller only knows the asset name.
      const reg = (scene.data.get("peaky.tilemapsByName") as Map<string, TilemapRenderer> | undefined) ?? new Map<string, TilemapRenderer>();
      reg.set(this.name, this);
      scene.data.set("peaky.tilemapsByName", reg);
      // ALL-instances-per-name registry — at-world actions (MineTileAtWorld,
      // SetTileAtWorld, etc.) need to find the SPECIFIC placement whose
      // bounds contain the click coords. Without this, two placements of
      // the same tilemap asset (common pattern: split a big map into
      // chunks) silently rejected mining clicks outside the last-spawned
      // one's bounds.
      const regAll = (scene.data.get("peaky.tilemapsByNameAll") as Map<string, TilemapRenderer[]> | undefined) ?? new Map<string, TilemapRenderer[]>();
      const list = regAll.get(this.name) ?? [];
      if (!list.includes(this)) list.push(this);
      regAll.set(this.name, list);
      scene.data.set("peaky.tilemapsByNameAll", regAll);
    }

    const solidSet = this.solidIndices.length > 0 ? new Set(this.solidIndices) : null;
    // Separate tiles into "full-cell collision" (efficient layer path) vs
    // "custom shape" (per-cell static bodies). The custom set never touches
    // setCollision — those cells block via the static bodies only.
    const customColliderIndices = new Set<number>();
    for (const k of Object.keys(this.tileColliders)) {
      const idx = Number(k);
      if (Number.isFinite(idx) && solidSet?.has(idx)) customColliderIndices.add(idx);
    }
    const fullCellSolidArr = solidSet
      ? Array.from(solidSet).filter((i) => !customColliderIndices.has(i))
      : [];
    const registered = (scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];

    // Lazy-create the static-body group on first need.
    const ensureCustomGroup = (): Phaser.Physics.Arcade.StaticGroup => {
      if (!this._customCollisionGroup) {
        this._customCollisionGroup = scene.physics.add.staticGroup();
      }
      return this._customCollisionGroup;
    };

    // Single-row "phaser layer build" helper. Used twice: the standard path
    // (one call with all rows) and the Y-sort path (one call per non-empty row).
    // Returns the created Phaser layer so the caller can register collisions etc.
    const buildPhaserLayer = (
      L: InputLayer,
      data: number[][],
      yOffsetPx: number,
      depthOffset: number,
    ): Phaser.Tilemaps.TilemapLayer | null => {
      const map = scene.make.tilemap({ data, tileWidth: this.tileW, tileHeight: this.tileH });
      const tileset = map.addTilesetImage("tileset", this.textureKey, this.tileW, this.tileH, this.marginX, this.spacingX);
      if (!tileset) { map.destroy(); return null; }
      const ph = map.createLayer(0, tileset, layerLeft, layerTop + yOffsetPx);
      if (!ph) { map.destroy(); return null; }
      if (L.xf) {
        // Bake the per-cell brush transform onto each Phaser Tile. The renderer
        // honors tile.rotation/flipX/flipY; collision still reads the upright
        // index, so this is visual-only (matches the editor's blitCell order:
        // flip then rotate).
        for (const k in L.xf) {
          const xf = L.xf[k] & 0xf;
          if (!xf) continue;
          const i = +k;
          const c = i % this.cols;
          const tile = ph.getTileAt(c, (i - c) / this.cols);
          if (!tile) continue;
          tile.flipX = !!(xf & 1);
          tile.flipY = !!(xf & 2);
          tile.rotation = ((xf >> 2) & 3) * Math.PI / 2;
        }
      }
      // Depth is composed as _layerBaseDepth + depthOffset so applyLayer can
      // re-apply after scene-layer base changes without losing per-row sorting.
      ph.setDepth(this._layerBaseDepth + depthOffset);
      ph.setAlpha((L.alpha ?? 1) * this._layerAlpha);
      ph.setVisible(this._layerVisible);
      ph.setScrollFactor(this._scrollX, this._scrollY);
      // Back-reference so the collider's processCallback (registered in Game.ts)
      // can look up per-tile-index excluded tags via getExcludedTagsForTile.
      ph.setData("tilemapRenderer", this);
      this.sprite.routeOverlayToCamera(ph);
      this.maps.push(map);
      this.phaserLayers.push(ph);
      this.phaserLayerDepthOffsets.push(depthOffset);
      this.phaserLayerAuthored.push(L);
      return ph;
    };

    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      if (!L.visible) continue;

      if (this.ySort && L.ySort) {
        // Y-sort PER-TILE mode (Unity Individual). Each painted cell becomes
        // its own Phaser.GameObjects.Image — same render pipeline as the player
        // sprite, so depth-sort works correctly. Per-row tilemap layers don't
        // work because Phaser batches TilemapLayer renders in a separate
        // pipeline that doesn't interleave with sprites by depth.
        //
        // For collision we ALSO build a hidden tilemap layer that owns the
        // collision data via setCollision. The Images are visual-only.
        ensureTilesetFrames(scene, this.textureKey, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
        ensureBigTileFrames(scene, this.textureKey, this.bigTiles, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
        // Spawn BigTile placements as ONE Image each — whole composite sorts
        // as a single object at its PIVOT Y (defaults to bottom edge for trees).
        for (const placement of L.bigTilePlacements ?? []) {
          const bt = this.bigTiles[placement.bigTileId];
          if (!bt) continue;
          // World dimensions: pure tile grid, no atlas spacing.
          // The canvas built by ensureBigTileFrames is exactly this size.
          // Native size from the owning tileset (no squish); bottom-anchored to
          // the footprint so an oversized tile overflows upward. Single-tileset
          // → srcTW === this.tileW, so this is identical to the old centering.
          const srcTW = bt._src?.tileW ?? this.tileW;
          const srcTH = bt._src?.tileH ?? this.tileH;
          const wPx = bt.w * srcTW;
          const hPx = bt.h * srcTH;
          const worldX = layerLeft + placement.c * this.tileW + wPx / 2;
          const worldY = layerTop + placement.r * this.tileH + hPx / 2;
          const img = this._addBigTileImage(scene, worldX, worldY, bt);
          img.setOrigin(0.5, 0.5);
          // Depth = trunk-base Y (natural Y-sort point for tall objects) plus
          // a sortY-driven lift:
          //   sortY=0   → +Z_LIFT  → tree wins vs any player → "always covers"
          //   sortY=0.5 → 0        → natural Y-sort at the tile's mid-line
          //   sortY=1   → -Z_LIFT  → tree loses to any player → "never covers"
          // Z_LIFT is sized to dominate the LAYER_DEPTH_STEP (1e6) from
          // runProject so cross-layer comparisons stay correct.
          // Sort line at the author-set fraction of the BigTile (default mid):
          // the player (sorted by its feet) passes behind once its feet rise
          // above this line.
          const userSortY = bt.sortY ?? 0.5;
          const trunkBaseY = layerTop + placement.r * this.tileH + hPx * (bt.sortLineY ?? 0.5);
          // Sized to be:
          //   - Far bigger than any plausible within-layer Y-sort delta (a few
          //     thousand px) so "always covers" / "never covers" are decisive
          //     against player Y-sort within the same scene layer.
          //   - Far smaller than runProject's LAYER_DEPTH_STEP (1,000,000) so
          //     the lift never crosses into a neighboring scene layer's depth
          //     band — earlier 1e9 sank "never covers" trees below the ground
          //     tiles in the same cells, hiding the tree entirely.
          const Z_LIFT = 100_000;
          const lift = (0.5 - userSortY) * 2 * Z_LIFT;
          const depthOffset = L.z * 0.01 + trunkBaseY + lift;
          img.setDepth(this._layerBaseDepth + depthOffset);
          img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
          img.setVisible(this._layerVisible);
          img.setScrollFactor(this._scrollX, this._scrollY);
          this.sprite.routeOverlayToCamera(img);
          // Store with c/r of the anchor (single cell for tracking).
          this.perTileImages.push({ img, depthOffset, L, c: placement.c, r: placement.r });
          // Publish to scene registry so behaviors like VisionMask can find
          // BigTile images by tag without crawling every sprite each frame.
          const registry = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
          const list = registry ?? [];
          list.push({ img, tags: bt.tags ?? [], layerId: this.sprite.layerId });
          if (!registry) scene.data.set("peaky.bigTileImages", list);
          this.bigTileRegistryEntries.push({ img });

          // Spawn static collision bodies if the BigTile defines a collider —
          // a cell rect or a custom polygon (decomposed into rects), placed in
          // the OWNING tileset's native px and anchored to the placement.
          const collBodies = this._spawnBigTileColliders(scene, bt, layerLeft, layerTop, placement, L, ensureCustomGroup());
          this._bigTilePlacementResources.set(placement.id, { img, colliders: collBodies, L });
        }
        // Animated-tile placements — single-cell, frame cycles in update().
        for (const placement of L.animatedTilePlacements ?? []) {
          this._spawnAnimatedTilePlacement(L, placement);
        }
        let spawnCount = 0;
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            const tile = L.tiles[r * this.cols + c] ?? -1;
            if (tile < 0) continue;
            const worldX = layerLeft + c * this.tileW + this.tileW / 2;
            const worldY = layerTop + r * this.tileH + this.tileH / 2;
            const frameKey = `tile_${tile}`;
            const img = scene.add.image(worldX, worldY, this.textureKey, frameKey);
            img.setOrigin(0.5, 0.5);
            const xf = L.xf?.[r * this.cols + c] ?? 0;
            if (xf) {
              img.setFlip(!!(xf & 1), !!(xf & 2));
              img.setRotation(((xf >> 2) & 3) * Math.PI / 2);
            }
            // Depth = cell's world-bottom Y so pure per-cell Y-sort applies.
            // BigTile placements (rendered separately below) override individual
            // cell depths for the cells they cover.
            const cellBottomY = layerTop + (r + 1) * this.tileH;
            const depthOffset = L.z * 0.01 + cellBottomY;
            img.setDepth(this._layerBaseDepth + depthOffset);
            img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
            img.setVisible(this._layerVisible);
            img.setScrollFactor(this._scrollX, this._scrollY);
            this.sprite.routeOverlayToCamera(img);
            const cellEntry = { img, depthOffset, L, c, r };
            this.perTileImages.push(cellEntry);
            this._cellImageByKey.set(`${L.id}#${c},${r}`, cellEntry);
            // Publish so VisionMask can see regular per-tile cells (not just
            // BigTiles). Tags come from the AUTHORED LAYER — set L.tags on the
            // ground/grass layer to keep it out of the fade.
            const reg2 = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
            const list2 = reg2 ?? [];
            list2.push({ img, tags: L.tags ?? [], layerId: this.sprite.layerId });
            if (!reg2) scene.data.set("peaky.bigTileImages", list2);
            this.bigTileRegistryEntries.push({ img });
            spawnCount++;
          }
        }
        // INVISIBLE tilemap layer carries the tile data — Phaser's setCollision +
        // arcade collider only work on a TilemapLayer, AND tile mining / tracer
        // hit-detection SAMPLE tiles through this layer (the Y-sort visuals above
        // are loose Images, not a samplable layer). So it must exist for ANY
        // layer the player can mine, not only solid ones — otherwise a non-solid
        // mining layer is invisible to the mine collector and nothing on it mines.
        // `setCollision` is still applied only when the layer is actually solid.
        // This layer is NOT in `phaserLayers` so applyLayer won't re-show it.
        {
          const data: number[][] = new Array(this.rows);
          for (let r = 0; r < this.rows; r++) data[r] = L.tiles.slice(r * this.cols, (r + 1) * this.cols);
          const collMap = scene.make.tilemap({ data, tileWidth: this.tileW, tileHeight: this.tileH });
          const collTileset = collMap.addTilesetImage("tileset", this.textureKey, this.tileW, this.tileH, this.marginX, this.spacingX);
          if (collTileset) {
            const collPh = collMap.createLayer(0, collTileset, layerLeft, layerTop);
            if (collPh) {
              collPh.setVisible(false);
              collPh.setActive(false); // disables update; render skipped via visible=false
              collPh.setScrollFactor(this._scrollX, this._scrollY);
              if (L.collides && solidSet && fullCellSolidArr.length > 0) collPh.setCollision(fullCellSolidArr);
              this.sprite.routeOverlayToCamera(collPh);
              this.maps.push(collMap);
              this.collisionOnlyLayers.push(collPh);
              this._collisionLayerById.set(L.id, collPh);
              if (!registered.includes(collPh)) registered.push(collPh);
            } else {
              collMap.destroy();
            }
          } else {
            collMap.destroy();
          }
        }
      } else {
        // Standard path: one Phaser tilemap per authored layer.
        const data: number[][] = new Array(this.rows);
        for (let r = 0; r < this.rows; r++) {
          data[r] = L.tiles.slice(r * this.cols, (r + 1) * this.cols);
        }
        const ph = buildPhaserLayer(L, data, 0, L.z * 0.01);
        if (!ph) continue;
        this._phaserLayerById.set(L.id, ph);
        if (L.collides && solidSet && fullCellSolidArr.length > 0) ph.setCollision(fullCellSolidArr);
        // Register EVERY layer for tile lookups — mining + hit-detection sample
        // via peaky.tilemapLayers, so a non-solid mining layer must be in here
        // too, else nothing on it can be mined. (Hit-detection still filters by
        // tile.collides, so non-solid tiles won't block movement.)
        if (!registered.includes(ph)) registered.push(ph);
        // Publish the whole TilemapLayer to the maskable registry. CUTOUT
        // mode handles it perfectly via per-pixel BitmapMask. FADE mode
        // ignores wholeLayer entries because setAlpha on a single GameObject
        // would fade the entire background instead of per-tile.
        const reg3 = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; wholeLayer?: boolean; layerId?: string }[] | undefined);
        const list3 = reg3 ?? [];
        list3.push({ img: ph, tags: L.tags ?? [], wholeLayer: true, layerId: this.sprite.layerId });
        if (!reg3) scene.data.set("peaky.bigTileImages", list3);
        this.bigTileRegistryEntries.push({ img: ph });

        // BigTile placements also need to render in non-Y-sort mode (e.g.
        // background tilemaps with trees). Spawn each placement as a single
        // Image at a stable depth just above the layer's own tilemap so the
        // composite art sits on top of the per-cell ground tiles. sortY's
        // lift is a no-op here because there's no Y-sort to bias against.
        if ((L.bigTilePlacements ?? []).length > 0) {
          ensureTilesetFrames(scene, this.textureKey, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
          ensureBigTileFrames(scene, this.textureKey, this.bigTiles, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
          for (const placement of L.bigTilePlacements ?? []) {
            const bt = this.bigTiles[placement.bigTileId];
            if (!bt) continue;
            // Pure tile grid — see ensureBigTileFrames for why we
            // explicitly DO NOT add the atlas spacing here.
            const srcTW = bt._src?.tileW ?? this.tileW;
            const srcTH = bt._src?.tileH ?? this.tileH;
            const wPx = bt.w * srcTW;
            const hPx = bt.h * srcTH;
            const worldX = layerLeft + placement.c * this.tileW + wPx / 2;
            const worldY = layerTop + placement.r * this.tileH + hPx / 2;
            const img = this._addBigTileImage(scene, worldX, worldY, bt);
            img.setOrigin(0.5, 0.5);
            // A HAIR above the layer's flat tiles (same layer) so the composite
            // sits on top of ground painted in the same layer — but BELOW the
            // next layer, whose band is L.z×0.01 away. Must be < 0.01 or the
            // BigTile leaps over higher layers (e.g. above a grass layer).
            const depthOffset = L.z * 0.01 + 0.005;
            img.setDepth(this._layerBaseDepth + depthOffset);
            img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
            img.setVisible(this._layerVisible);
            img.setScrollFactor(this._scrollX, this._scrollY);
            this.sprite.routeOverlayToCamera(img);
            this.perTileImages.push({ img, depthOffset, L, c: placement.c, r: placement.r });
            const reg4 = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
            const list4 = reg4 ?? [];
            list4.push({ img, tags: bt.tags ?? [], layerId: this.sprite.layerId });
            if (!reg4) scene.data.set("peaky.bigTileImages", list4);
            this.bigTileRegistryEntries.push({ img });

            // Collision bodies — same shape rules as the Y-sort path.
            const collBodies2 = this._spawnBigTileColliders(scene, bt, layerLeft, layerTop, placement, L, ensureCustomGroup());
            this._bigTilePlacementResources.set(placement.id, { img, colliders: collBodies2, L });
          }
        }
        // Animated-tile placements (non-Y-sort path).
        for (const placement of L.animatedTilePlacements ?? []) {
          this._spawnAnimatedTilePlacement(L, placement);
        }
      }

      // Custom-shape bodies: polygon → rects (scanline) → greedy-merged
      // static bodies. Independent of the visual layer split — runs once per
      // authored layer for both Y-sort and standard modes.
      if (L.collides && customColliderIndices.size > 0) {
        // Per-cell tracking (no inter-cell merge). The merge optimisation that
        // used to live here saved a few static bodies on big walls but made
        // runtime mutation impossible — once cells share a merged body,
        // RemoveTile on ONE cell can't surgically destroy the right slice.
        // The cost of N static bodies vs 1 is negligible for typical maps
        // (Phaser handles thousands fine) and the gain is correct mining.
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            const t = L.tiles[r * this.cols + c];
            if (!customColliderIndices.has(t)) continue;
            this._spawnCustomCellBodies(L, c, r, t, layerLeft, layerTop, ensureCustomGroup());
          }
        }
      }
    }
    scene.data.set("peaky.tilemapLayers", registered);
    // Stash the custom-body group on the scene so Game.registerCollisions can
    // wire future-spawned sprites against it.
    const allGroups = (scene.data.get("peaky.tilemapStaticGroups") as Phaser.Physics.Arcade.StaticGroup[] | undefined) ?? [];
    if (this._customCollisionGroup && !allGroups.includes(this._customCollisionGroup)) {
      allGroups.push(this._customCollisionGroup);
    }
    scene.data.set("peaky.tilemapStaticGroups", allGroups);

    // Wire EXISTING sprites with a Collider against every collidable layer
    // AND any custom-shape static group on this tilemap.
    const live = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const self = this;
    const layerProcess = (spriteGo: unknown, tile: unknown): boolean => {
      const sp = (spriteGo as Phaser.GameObjects.GameObject).getData?.("peakySprite") as { tags?: Set<string> } | undefined;
      if (!sp?.tags || sp.tags.size === 0) return true;
      const ex = self.getExcludedTagsForTile((tile as Phaser.Tilemaps.Tile).index);
      if (ex.length === 0) return true;
      for (const t of ex) if (sp.tags.has(t)) return false;
      return true;
    };
    const groupProcess = (spriteGo: unknown, bodyGo: unknown): boolean => {
      const sp = (spriteGo as Phaser.GameObjects.GameObject).getData?.("peakySprite") as { tags?: Set<string> } | undefined;
      if (!sp?.tags || sp.tags.size === 0) return true;
      const ex = (bodyGo as Phaser.GameObjects.GameObject).getData?.("excludedTags") as string[] | undefined;
      if (!ex || ex.length === 0) return true;
      for (const t of ex) if (sp.tags.has(t)) return false;
      return true;
    };
    for (const s of live) {
      if (s === this.sprite || s.destroyed) continue;
      if (!s.hasBehavior(Collider)) continue;
      for (const ph of this.phaserLayers) {
        if (!registered.includes(ph)) continue;
        const c = scene.physics.add.collider(s.gameObject, ph, undefined, layerProcess);
        this._ownColliders.push(c);
        s._colliders.push(c);
      }
      if (this._customCollisionGroup) {
        const c = scene.physics.add.collider(s.gameObject, this._customCollisionGroup, undefined, groupProcess);
        this._ownColliders.push(c);
        s._colliders.push(c);
      }
    }
    this.rendered = true;
  }

  /**
   * Per-frame work — currently nothing. Y-sort depths are set at spawn time
   * (per-tile for individual cells, per-group for united cells). Phaser's
   * display list re-sorts by depth automatically when sprites move.
   *
   * Kept as a no-op stub in case future per-frame logic is needed.
   */
  /** Viewport culling — every off-screen tile Image (per-cell Y-sort, BigTile,
   *  animated) is REMOVED from the display list so it costs nothing to render OR
   *  depth-sort, and animated placements skip frame advancement. Re-added when it
   *  comes back within the camera view + a 10% margin (plus a tile-size pad so
   *  tall trees / wide tiles whose center is off-screen but body isn't don't pop).
   *  Toggles only on boundary crossings, so a still camera does zero list work.
   *  Physics colliders are untouched — only the visuals are culled. */
  private _cullToViewport(): void {
    if (this.perTileImages.length === 0 && this._bigTilePlacementResources.size === 0 && this._animatedPlacements.size === 0) return;
    const cam = this.sprite.scene?.cameras?.main;
    if (!cam) return;
    const v = cam.worldView;
    const padX = v.width * 0.1 + this.tileW;
    const padY = v.height * 0.1 + this.tileH;
    const minX = v.x - padX, maxX = v.right + padX, minY = v.y - padY, maxY = v.bottom + padY;
    // Test the image's actual FOOTPRINT (origin + display size), not just its
    // anchor point — otherwise a BigTile larger than the pad (a whole building)
    // pops out the instant its anchor leaves the view while most of it is still
    // on screen. displayWidth/Height fold in scale; originX/Y handle any pivot.
    const cull = (img: Phaser.GameObjects.Image): boolean => {
      const left = img.x - img.displayWidth * img.originX;
      const top = img.y - img.displayHeight * img.originY;
      const on = left + img.displayWidth >= minX && left <= maxX && top + img.displayHeight >= minY && top <= maxY;
      const inList = img.displayList != null;
      if (on && !inList) img.addToDisplayList();
      else if (!on && inList) img.removeFromDisplayList();
      return on;
    };
    for (const e of this.perTileImages) cull(e.img);
    for (const e of this._bigTilePlacementResources.values()) cull(e.img);
    for (const e of this._animatedPlacements.values()) e.culled = !cull(e.img);
  }

  /** Queue a destroyed tile to grow back after rolling its grow-back delay.
   *  `pop` controls the scale-up animation on re-appearance (default on). */
  private _scheduleRegrow(raw: number | string | undefined, pop: boolean, e: { layerId: string; c: number; r: number; tileIdx?: number; xf?: number; bigTileId?: string; animTileId?: string }): void {
    const sec = rollGrowBack(raw);
    if (sec > 0) this._regrow.push({ remaining: sec * 1000, pop, ...e });
  }

  /** Pop a freshly-(re)placed tile Image in from scale 0 → its natural scale,
   *  with a little Back overshoot so a regrown bush "sprouts". Scales around the
   *  BOTTOM-CENTER (the ground line) regardless of the image's origin, so it
   *  grows upward from where it sits, then restores the original origin/position
   *  on completion so later rendering is unchanged. */
  private _popIn(img: Phaser.GameObjects.Image): void {
    const ox = img.originX, oy = img.originY;
    const tx = img.scaleX, ty = img.scaleY;
    const bx = img.x + (0.5 - ox) * img.displayWidth;   // bottom-center x
    const by = img.y + (1 - oy) * img.displayHeight;     // bottom edge y
    img.setOrigin(0.5, 1).setPosition(bx, by).setScale(0);
    this.sprite.scene.tweens.add({
      targets: img, scaleX: tx, scaleY: ty, duration: 220, ease: "Back.easeOut",
      onComplete: () => {
        if (ox === 0.5 && oy === 1) return;
        img.setOrigin(ox, oy).setPosition(bx - (0.5 - ox) * img.displayWidth, by - (1 - oy) * img.displayHeight);
      },
    });
  }

  /** Count down pending regrows and re-place each tile when its timer elapses,
   *  popping it in (scale 0 → 1). */
  private _tickRegrow(delta: number): void {
    if (this._regrow.length === 0) return;
    for (let i = this._regrow.length - 1; i >= 0; i--) {
      const e = this._regrow[i];
      e.remaining -= delta;
      if (e.remaining > 0) continue;
      this._regrow.splice(i, 1);
      if (e.tileIdx != null) {
        const L = this.findLayer(e.layerId);
        if (e.xf && L) { if (!L.xf) L.xf = {}; L.xf[e.r * this.cols + e.c] = e.xf; }
        if (this.ySort && L?.ySort) {
          // Per-cell image exists after setTileAt → pop it directly.
          this.setTileAt(e.layerId, e.c, e.r, e.tileIdx);
          const cell = this._cellImageByKey.get(`${e.layerId}#${e.c},${e.r}`);
          if (cell && e.pop) this._popIn(cell.img);
        } else if (e.pop) {
          // Batched layer has no per-cell image — pop a temp overlay, then drop
          // the real tile in exactly when the pop finishes (no double-render).
          const scene = this.sprite.scene;
          const center = this.cellToWorld(e.c, e.r);
          const ov = scene.add.image(center.x, center.y + this.tileH / 2, this.textureKey, `tile_${e.tileIdx}`);
          ov.setOrigin(0.5, 1).setScale(0).setDepth(this._layerBaseDepth + (L?.z ?? 0) * 0.01 + center.y);
          this.sprite.routeOverlayToCamera(ov);
          const layerId = e.layerId, c = e.c, r = e.r, idx = e.tileIdx;
          scene.tweens.add({ targets: ov, scaleX: 1, scaleY: 1, duration: 220, ease: "Back.easeOut", onComplete: () => { try { ov.destroy(); } catch { /* ignore */ } this.setTileAt(layerId, c, r, idx); } });
        } else {
          this.setTileAt(e.layerId, e.c, e.r, e.tileIdx);
        }
      } else if (e.bigTileId) {
        const id = this.placeBigTile(e.layerId, e.bigTileId, e.c, e.r);
        const img = id ? this._bigTilePlacementResources.get(id)?.img : undefined;
        if (img && e.pop) this._popIn(img);
      } else if (e.animTileId) {
        const id = this.placeAnimatedTile(e.layerId, e.animTileId, e.c, e.r);
        const img = id ? this._animatedPlacements.get(id)?.img : undefined;
        if (img && e.pop) this._popIn(img);
      }
    }
  }

  update(delta: number): void {
    this._cullToViewport();
    this._tickRegrow(delta);
    if (this._animatedPlacements.size === 0) return;
    this._pollAnimatedOverlap(this.sprite.scene);
    const dSec = delta / 1000;
    // Placements that finished their deplete-once animation and asked for
    // destroy-on-end. We can't destroy mid-iteration without invalidating
    // the Map iterator, so we collect ids and clean them up afterwards.
    let toDestroy: { layerId: string; id: string }[] | null = null;
    for (const entry of this._animatedPlacements.values()) {
      if (entry.culled) continue; // off-screen — don't advance frames
      if (!entry.playing) continue;
      const fps = entry.def.fps;
      // A play-on-hit / play-on-deplete reaction must run even on a "static"
      // animated tile (fps 0) — fall back to a sensible reaction rate so the
      // frames actually cycle. Normal autoplay still needs an authored fps.
      const effFps = fps > 0 ? fps : ((entry.reacting || entry.depletingAnim || entry.overlapLoop) ? 12 : 0);
      if (effFps <= 0 || entry.def.frames.length === 0) continue;
      entry.elapsedSec += dSec;
      const periodSec = 1 / effFps;
      let endedThisTick = false;
      while (entry.elapsedSec >= periodSec) {
        entry.elapsedSec -= periodSec;
        const lastIdx = entry.def.frames.length - 1;
        const loop = entry.loopOverride ?? entry.def.loop;
        if (entry.frameIdx >= lastIdx) {
          if (loop) {
            entry.frameIdx = 0;
          } else {
            entry.playing = false;
            entry.elapsedSec = 0;
            endedThisTick = true;
            break;
          }
        } else {
          entry.frameIdx++;
        }
      }
      const frame = entry.def.frames[entry.frameIdx];
      if (typeof frame === "number") {
        try { entry.img.setFrame(`tile_${frame}`); } catch { /* texture loading race */ }
      } else {
        // Multi-cell region frame — swap the whole composite texture.
        try { entry.img.setTexture(`animframe_${entry.def.id}_${entry.frameIdx}`); } catch { /* loading race */ }
      }
      // Deplete-once one-shot finished. Either destroy (destroyOnDepleted)
      // or freeze on the last frame (the visual stays).
      if (endedThisTick && entry.depletingAnim) {
        entry.depletingAnim = false;
        if (entry.def.destroyOnDepleted !== false) {
          if (!toDestroy) toDestroy = [];
          toDestroy.push({ layerId: entry.L.id, id: entry.placement.id });
        }
      } else if (endedThisTick && entry.reacting) {
        // On-hit reaction finished — return to the idle frame (0).
        entry.reacting = false;
        entry.frameIdx = 0;
        const f0 = entry.def.frames[0];
        if (typeof f0 === "number") { try { entry.img.setFrame(`tile_${f0}`); } catch { /* race */ } }
        else { try { entry.img.setTexture(`animframe_${entry.def.id}_0`); } catch { /* race */ } }
      }
    }
    if (toDestroy) {
      for (const t of toDestroy) this._destroyAnimatedPlacement(t.layerId, t.id);
    }
  }

  /** Drives `playOnOverlap`: a sprite carrying one of a placement's
   *  `overlapTags` standing on its footprint plays the animation per
   *  `overlapMode` (edge = per-sprite-entry one-shot, latch = one-shot on the
   *  empty→occupied edge, loop = loop while occupied, idle when empty). Only
   *  placements that opted in are scanned; sprites are pulled from the O(1) tag
   *  index so the cost is `Σ(tagged sprites)`, not all sprites × all cells. */
  private _pollAnimatedOverlap(scene: Phaser.Scene): void {
    for (const entry of this._animatedPlacements.values()) {
      const def = entry.def;
      if (!def.playOnOverlap || entry.depleted) continue;
      const tags = def.overlapTags ?? [];
      if (tags.length === 0) continue;
      const f0 = def.frames[0];
      const w = f0 && typeof f0 !== "number" ? Math.max(1, f0.w) : 1;
      const h = f0 && typeof f0 !== "number" ? Math.max(1, f0.h) : 1;
      const left = this._layerLeft + entry.placement.c * this.tileW;
      const top = this._layerTop + entry.placement.r * this.tileH;
      const right = left + w * this.tileW;
      const bottom = top + h * this.tileH;
      const inside = new Set<number>();
      for (const tag of tags) {
        for (const s of getSpritesByTag(scene, tag)) {
          const go = s.gameObject;
          if (!go) continue;
          if (go.x >= left && go.x < right && go.y >= top && go.y < bottom) inside.add(s.uid);
        }
      }
      const prev = entry.overlapUids;
      const wasOccupied = !!prev && prev.size > 0;
      const occupied = inside.size > 0;
      const mode = def.overlapMode ?? "edge";
      if (mode === "loop") {
        if (occupied && !wasOccupied) {
          entry.frameIdx = 0; entry.elapsedSec = 0; entry.loopOverride = true;
          entry.reacting = false; entry.overlapLoop = true; entry.playing = true;
        } else if (!occupied && wasOccupied) {
          entry.playing = false; entry.loopOverride = null;
          entry.reacting = false; entry.overlapLoop = false; entry.frameIdx = 0;
          const f = def.frames[0];
          if (typeof f === "number") { try { entry.img.setFrame(`tile_${f}`); } catch { /* texture race */ } }
          else { try { entry.img.setTexture(`animframe_${def.id}_0`); } catch { /* texture race */ } }
        }
      } else {
        // edge / latch — fire a one-shot (frame 0 → end → idle, via `reacting`).
        let fire = false;
        if (mode === "latch") {
          fire = occupied && !wasOccupied;
        } else {
          for (const u of inside) if (!prev || !prev.has(u)) { fire = true; break; }
        }
        if (fire) {
          entry.frameIdx = 0; entry.elapsedSec = 0; entry.loopOverride = false;
          entry.reacting = true; entry.playing = true;
        }
      }
      entry.overlapUids = inside;
    }
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    this._scrollX = scrollX;
    this._scrollY = scrollY;
    this._layerBaseDepth = baseDepth;
    this._layerAlpha = alpha;
    this._layerVisible = visible;
    for (let i = 0; i < this.phaserLayers.length; i++) {
      const ph = this.phaserLayers[i];
      const L = this.phaserLayerAuthored[i];
      const offset = this.phaserLayerDepthOffsets[i] ?? 0;
      ph.setScrollFactor(scrollX, scrollY);
      // Use the per-Phaser-layer stored offset so Y-sort per-row depths are
      // preserved through scene-layer base updates. For non-Y-sort layers the
      // offset is L.z × 0.01 — identical to the old hardcoded formula.
      ph.setDepth(baseDepth + offset);
      ph.setAlpha((L?.alpha ?? 1) * alpha);
      ph.setVisible(visible && (L?.visible ?? true));
    }
    // Per-tile Y-sort images get their depths/alpha/visibility refreshed too,
    // preserving each image's stored per-cell offset.
    for (const entry of this.perTileImages) {
      entry.img.setScrollFactor(scrollX, scrollY);
      entry.img.setDepth(baseDepth + entry.depthOffset);
      entry.img.setAlpha((entry.L.alpha ?? 1) * alpha);
      entry.img.setVisible(visible && (entry.L.visible ?? true));
    }
    // BigTile static colliders: disable the physics body alongside layer
    // visibility so an "invisible tree" doesn't keep blocking the player.
    for (const entry of this.bigTileColliderBodies) {
      const live = visible && (entry.L.visible ?? true);
      entry.go.setVisible(live);
      const body = (entry.go as { body?: Phaser.Physics.Arcade.StaticBody }).body;
      if (body) body.enable = live;
      entry.go.setScrollFactor(scrollX, scrollY);
    }
    // Animated placement colliders: same body-disable contract as BigTile
    // colliders so hiding an "animated solid" layer also lets the player
    // walk through. Without this, an invisible animated tile keeps blocking.
    for (const entry of this._animatedPlacements.values()) {
      if (!entry.collider) continue;
      const live = visible && (entry.L.visible ?? true);
      entry.collider.setVisible(live);
      const body = (entry.collider as { body?: Phaser.Physics.Arcade.StaticBody }).body;
      if (body) body.enable = live;
      entry.collider.setScrollFactor(scrollX, scrollY);
    }
    // Custom-polygon per-cell colliders (the polygon-decomposed rect bodies)
    // also belong to authored layers. Hiding a "foreground decoration" layer
    // shouldn't leave its irregular collision shapes blocking the player.
    for (const [key, bodies] of this._cellCustomBodies) {
      const sep = key.indexOf("#");
      const layerId = sep > 0 ? key.slice(0, sep) : "";
      const ownerL = this.layers.find((x) => x.id === layerId);
      const live = visible && (ownerL?.visible ?? true);
      for (const go of bodies) {
        go.setVisible(live);
        const body = (go as { body?: Phaser.Physics.Arcade.StaticBody }).body;
        if (body) body.enable = live;
        go.setScrollFactor(scrollX, scrollY);
      }
    }
    // Y-sort collision-only Phaser layers: visually hidden by spec, but the
    // body collision must follow the authored layer's visibility flag.
    for (const [layerId, collPh] of this._collisionLayerById) {
      const ownerL = this.layers.find((x) => x.id === layerId);
      const live = visible && (ownerL?.visible ?? true);
      // collTotal stays setActive(false) at init for the no-update path; we
      // toggle setActive again here so the COLLISION ITSELF turns on/off.
      collPh.setActive(live);
      collPh.setScrollFactor(scrollX, scrollY);
    }
  }

  /** Lazy-create the custom-shape static group AND wire it against every
   *  EXISTING sprite that has a Collider. Without that retro-wiring, any
   *  group created after `_init` (first runtime setTileAt-with-poly, first
   *  runtime placeBigTile, first runtime placeAnimatedTile) would only
   *  block sprites spawned AFTER it — old sprites would walk straight
   *  through. */
  private _ensureCustomGroup(): Phaser.Physics.Arcade.StaticGroup {
    if (this._customCollisionGroup) return this._customCollisionGroup;
    const scene = this.sprite.scene;
    const group = scene.physics.add.staticGroup();
    this._customCollisionGroup = group;
    const allGroups = (scene.data.get("peaky.tilemapStaticGroups") as Phaser.Physics.Arcade.StaticGroup[] | undefined) ?? [];
    if (!allGroups.includes(group)) allGroups.push(group);
    scene.data.set("peaky.tilemapStaticGroups", allGroups);
    // Retro-wire: every Collider-bearing sprite that's already alive needs
    // a fresh collider against this new group, otherwise it phases through.
    const live = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const groupProcess = (spriteGo: unknown, bodyGo: unknown): boolean => {
      const sp = (spriteGo as Phaser.GameObjects.GameObject).getData?.("peakySprite") as { tags?: Set<string> } | undefined;
      if (!sp?.tags || sp.tags.size === 0) return true;
      const ex = (bodyGo as Phaser.GameObjects.GameObject).getData?.("excludedTags") as string[] | undefined;
      if (!ex || ex.length === 0) return true;
      for (const t of ex) if (sp.tags.has(t)) return false;
      return true;
    };
    for (const s of live) {
      if (s === this.sprite || s.destroyed) continue;
      if (!s.hasBehavior(Collider)) continue;
      const c = scene.physics.add.collider(s.gameObject, group, undefined, groupProcess);
      this._ownColliders.push(c);
      s._colliders.push(c);
    }
    return group;
  }

  /** Spawn the static-body rectangles for one cell whose tile index has a
   *  custom polygon collider in the tileset. Stores the bodies in the
   *  `_cellCustomBodies` map keyed by (layerId, c, r) so they can be
   *  cleaned up on runtime mutation. */
  private _spawnCustomCellBodies(
    L: InputLayer, c: number, r: number, tileIdx: number,
    layerLeft: number, layerTop: number,
    group: Phaser.Physics.Arcade.StaticGroup,
  ): void {
    let rects = this._polyRectCache.get(tileIdx);
    if (!rects) {
      const poly = this.tileColliders[String(tileIdx)];
      rects = poly ? polygonToRects(poly.points, this.tileW, this.tileH) : [];
      this._polyRectCache.set(tileIdx, rects);
    }
    if (rects.length === 0) return;
    const cellX = layerLeft + c * this.tileW;
    const cellY = layerTop + r * this.tileH;
    const bodies: Phaser.GameObjects.Rectangle[] = [];
    const scene = this.sprite.scene;
    const excludedTags = this.getExcludedTagsForTile(tileIdx);
    for (const rect of rects) {
      const go = scene.add.rectangle(cellX + rect.x + rect.w / 2, cellY + rect.y + rect.h / 2, rect.w, rect.h, 0xff0000, 0);
      group.add(go);
      (go as { body?: Phaser.Physics.Arcade.StaticBody }).body?.updateFromGameObject();
      go.setDepth(this._layerBaseDepth + L.z * 0.01);
      go.setScrollFactor(this._scrollX, this._scrollY);
      go.setData("excludedTags", excludedTags);
      bodies.push(go);
    }
    this._cellCustomBodies.set(`${L.id}#${c},${r}`, bodies);
  }

  /** Destroy the per-cell custom-collider bodies for one cell. Called on
   *  setTileAt before the new tile's bodies (if any) get spawned. */
  private _destroyCustomCellBodies(layerId: string, c: number, r: number): void {
    const key = `${layerId}#${c},${r}`;
    const bodies = this._cellCustomBodies.get(key);
    if (!bodies) return;
    for (const go of bodies) {
      try { go.destroy(); } catch { /* ignore — scene tearing down */ }
    }
    this._cellCustomBodies.delete(key);
  }

  // ─── Public tile-data API (Tier 1) ────────────────────────────────────
  //
  // These methods are the runtime surface used by the SetTile / RemoveTile /
  // CompareTileAt / MineTileAtWorld / ... action+condition handlers in
  // eval.ts. They keep the InputLayer.tiles array, the per-tile visual
  // (Phaser Image in Y-sort mode; Phaser TilemapLayer cell in standard mode),
  // and the collision tilemap in sync so a single setTileAt is enough to
  // update the world.

  /** Find an authored layer by id. Returns null if the layer doesn't exist. */
  findLayer(layerId: string): InputLayer | null {
    for (const L of this.layers) if (L.id === layerId) return L;
    return null;
  }

  /** Find an authored layer by name. Useful for actions that author-friendly
   *  reference "Main" / "Foliage" instead of opaque ids. Falls back to
   *  findLayer(name) so authors can pass an id either way. */
  findLayerByName(name: string): InputLayer | null {
    for (const L of this.layers) if ((L as { name?: string }).name === name) return L;
    return this.findLayer(name);
  }

  /** Tile index at (c, r) on the given authored layer, or -1 if empty / out of bounds. */
  getTileAt(layerId: string, c: number, r: number): number {
    const L = this.findLayer(layerId);
    if (!L) return -1;
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return -1;
    return L.tiles[r * this.cols + c] ?? -1;
  }

  /** True if any layer has a BigTile or animated PLACEMENT covering (c, r).
   *  Used by nav-point availability: a renewable bush point is "active" only
   *  while its placement exists (gone while mined, back when it regrows).
   *  Deliberately ignores plain ground tiles (L.tiles) — the grass under a
   *  mined bush must NOT keep the point alive. */
  hasPlacementAt(c: number, r: number): boolean {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return false;
    for (const L of this.layers) {
      for (const p of L.bigTilePlacements ?? []) {
        const bt = this.bigTiles[p.bigTileId];
        if (bt && c >= p.c && c < p.c + bt.w && r >= p.r && r < p.r + bt.h) return true;
      }
      for (const p of L.animatedTilePlacements ?? []) {
        if (p.c === c && p.r === r) return true;
      }
    }
    return false;
  }

  /** Mutate the cell at (c, r) on `layerId` to the given tile index. Pass
   *  `idx = -1` to remove. Returns true on success. Updates:
   *    - the authoring data array (L.tiles)
   *    - the visual (Image in Y-sort mode, TilemapLayer cell in standard mode)
   *    - the collision tilemap (so solidity tracks the new tile) */
  setTileAt(layerId: string, c: number, r: number, idx: number): boolean {
    const L = this.findLayer(layerId);
    if (!L) return false;
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return false;
    // BigTile placements cover their region as a single composite Image.
    // Writing a regular tile into L.tiles for a covered cell silently
    // desyncs author data from visuals (the BigTile keeps drawing on top
    // but L.tiles[r*cols+c] now reads a stale index). Warn loudly so the
    // author hits the issue immediately instead of debugging "why is my
    // tile gone" three sessions later. Still let the write proceed —
    // legitimate use case: scripted overwrite that's about to also
    // removeBigTileAt.
    for (const p of L.bigTilePlacements ?? []) {
      const bt = this.bigTiles[p.bigTileId];
      if (!bt) continue;
      if (c >= p.c && c < p.c + bt.w && r >= p.r && r < p.r + bt.h) {
        Logger.log({
          level: "warn",
          source: "TilemapRenderer.setTileAt",
          message: `cell (${c}, ${r}) on layer "${L.name ?? layerId}" is covered by BigTile placement "${p.id}" (${p.bigTileId}). Writing a per-tile index here desyncs L.tiles from the visual — call removeBigTileAt first if you mean to clear the composite.`,
        });
        break;
      }
    }
    const tiIdx = r * this.cols + c;
    const prev = L.tiles[tiIdx] ?? -1;
    if (prev === idx) return true;
    L.tiles[tiIdx] = idx;
    // Any HP entry recorded for this cell belongs to the OLD tile — drop it
    // so the new tile starts at its own full hardness, and an emptied cell
    // doesn't "remember damage" when something is later painted back.
    const hpMap = (this.sprite.scene?.data?.get("peaky.tileHP") as Map<string, number> | undefined);
    if (hpMap) hpMap.delete(this._tileHPKey(L.id, c, r));

    const scene = this.sprite.scene;
    const key = `${L.id}#${c},${r}`;

    if (this.ySort && L.ySort) {
      // Visual: per-tile Image. Destroy the existing one (if any) and spawn
      // a replacement if the new index is non-empty.
      const existing = this._cellImageByKey.get(key);
      if (existing) {
        try { existing.img.destroy(); } catch { /* ignore */ }
        const arrIdx = this.perTileImages.indexOf(existing);
        if (arrIdx >= 0) this.perTileImages.splice(arrIdx, 1);
        const regIdx = this.bigTileRegistryEntries.findIndex((e) => e.img === existing.img);
        if (regIdx >= 0) this.bigTileRegistryEntries.splice(regIdx, 1);
        const reg2 = scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject }[] | undefined;
        if (reg2) {
          const i2 = reg2.findIndex((e) => e.img === existing.img);
          if (i2 >= 0) reg2.splice(i2, 1);
        }
        this._cellImageByKey.delete(key);
      }
      if (idx >= 0) {
        const worldX = this._layerLeft + c * this.tileW + this.tileW / 2;
        const worldY = this._layerTop + r * this.tileH + this.tileH / 2;
        const frameKey = `tile_${idx}`;
        const img = scene.add.image(worldX, worldY, this.textureKey, frameKey);
        img.setOrigin(0.5, 0.5);
        const cellBottomY = this._layerTop + (r + 1) * this.tileH;
        const depthOffset = L.z * 0.01 + cellBottomY;
        img.setDepth(this._layerBaseDepth + depthOffset);
        img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
        img.setVisible(this._layerVisible);
        img.setScrollFactor(this._scrollX, this._scrollY);
        this.sprite.routeOverlayToCamera(img);
        const cellEntry = { img, depthOffset, L, c, r };
        this.perTileImages.push(cellEntry);
        this._cellImageByKey.set(key, cellEntry);
        const reg2 = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
        const list2 = reg2 ?? [];
        list2.push({ img, tags: L.tags ?? [], layerId: this.sprite.layerId });
        if (!reg2) scene.data.set("peaky.bigTileImages", list2);
        this.bigTileRegistryEntries.push({ img });
      }
      // Collision: hidden TilemapLayer carries the solid data in Y-sort mode.
      // Use replaceWithNull = true (Phaser's default) — nulling the slot is
      // what fully clears collision; a -1 stub can leave stale face state.
      // recalculateFaces = true forces the face geometry to regenerate for
      // the changed cell + its neighbors so the player can pass through.
      const collLayer = this._collisionLayerById.get(L.id);
      if (collLayer) {
        if (idx >= 0) collLayer.putTileAt(idx, c, r, true);
        else collLayer.removeTileAt(c, r, true, true);
      }
    } else {
      // Standard mode: one Phaser tilemap layer per InputLayer. Same logic
      // as above — null + face recompute so collision actually clears.
      const phLayer = this._phaserLayerById.get(L.id);
      if (phLayer) {
        if (idx >= 0) phLayer.putTileAt(idx, c, r, true);
        else phLayer.removeTileAt(c, r, true, true);
      }
    }

    // Custom polygon collider bodies — destroy the OLD tile's per-cell bodies
    // and spawn the NEW tile's bodies if it carries a custom collider too.
    // The tileset's `solidIndices` + `tileColliders` configuration determines
    // which tiles use per-cell custom shapes vs full-cell collision.
    this._destroyCustomCellBodies(L.id, c, r);
    if (idx >= 0 && this.tileColliders[String(idx)] && this.solidIndices.includes(idx)) {
      this._spawnCustomCellBodies(L, c, r, idx, this._layerLeft, this._layerTop, this._ensureCustomGroup());
    }
    return true;
  }

  /** Shortcut for setTileAt(layerId, c, r, -1). */
  removeTileAt(layerId: string, c: number, r: number): boolean {
    return this.setTileAt(layerId, c, r, -1);
  }

  /** Convert a world position to (c, r). Returns null when the position is
   *  outside the tilemap's bounds. */
  worldToCell(worldX: number, worldY: number): { c: number; r: number } | null {
    const c = Math.floor((worldX - this._layerLeft) / this.tileW);
    const r = Math.floor((worldY - this._layerTop) / this.tileH);
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return null;
    return { c, r };
  }

  /** Convert (c, r) to a world position (center of the cell). */
  cellToWorld(c: number, r: number): { x: number; y: number } {
    return {
      x: this._layerLeft + c * this.tileW + this.tileW / 2,
      y: this._layerTop + r * this.tileH + this.tileH / 2,
    };
  }

  /** True if the tile index marked solid by the tileset occupies the cell.
   *  Reads `solidIndices` (the tileset's authored solid set). */
  isSolidAt(layerId: string, c: number, r: number): boolean {
    const idx = this.getTileAt(layerId, c, r);
    if (idx < 0) return false;
    return this.solidIndices.includes(idx);
  }

  /** True if the cell holds tile index -1. Separate from isSolidAt so authors
   *  can ask "can I place here" (empty) vs "is it walkable" (not solid). */
  isEmptyAt(layerId: string, c: number, r: number): boolean {
    return this.getTileAt(layerId, c, r) < 0;
  }

  // ─── Mining API (Tier 2) ──────────────────────────────────────────────

  /** Max HP for the named tile index from the tileset's hardness map. Returns
   *  the UPPER BOUND of a random expression (for "is this tile breakable"
   *  checks). The per-cell rolled value is in `_ensureTileMaxHPMap()`.
   *  Returns 0 when the tile isn't listed (treated as UNBREAKABLE). */
  getTileMaxHardness(tileIdx: number): number {
    return parseHardnessMax(this.tileHardness[String(tileIdx)]);
  }

  /** Roll the per-cell max HP for (layerId, c, r). Random expressions roll
   *  once per cell on first call and cache the result so subsequent damage
   *  reads the same number. Literal numbers pass through unchanged. */
  private _rollCellMaxHP(layerId: string, c: number, r: number, tileIdx: number): number {
    const maxMap = this._ensureTileMaxHPMap();
    const key = this._tileHPKey(layerId, c, r);
    const cached = maxMap.get(key);
    if (cached !== undefined) return cached;
    const rolled = rollHardness(this.tileHardness[String(tileIdx)]);
    if (rolled > 0) maxMap.set(key, rolled);
    return rolled;
  }

  /** Current HP for a cell. Lazily seeded to the per-cell rolled max on
   *  first read when the cell has a tile with hardness > 0. Stored on a
   *  scene-wide map so multiple TilemapRenderers (one per scene tilemap
   *  instance) share the namespace cleanly under their tilemapId. */
  getTileHP(layerId: string, c: number, r: number): number {
    const idx = this.getTileAt(layerId, c, r);
    if (idx < 0) return 0;
    const max = this._rollCellMaxHP(layerId, c, r, idx);
    if (max <= 0) return 0;
    const map = this._ensureTileHPMap();
    const key = this._tileHPKey(layerId, c, r);
    const cur = map.get(key);
    return cur === undefined ? max : cur;
  }

  /** Apply `amount` of damage to the cell at (c, r). When HP reaches 0 the
   *  tile is removed via `setTileAt(-1)` and drops are dispatched into the
   *  count-global registry; a `_tileDestroyed` signal fires on the actor
   *  for OnTileDestroyed triggers. Returns the new HP (0 = destroyed).
   *  Unbreakable / empty tiles return -1 to signal "nothing happened". */
  damageTile(actor: Sprite, layerId: string, c: number, r: number, amount: number): number {
    const idx = this.getTileAt(layerId, c, r);
    if (idx < 0) return -1;
    const max = this._rollCellMaxHP(layerId, c, r, idx);
    if (max <= 0) return -1;
    if (amount <= 0) return this.getTileHP(layerId, c, r);
    const map = this._ensureTileHPMap();
    const key = this._tileHPKey(layerId, c, r);
    const cur = map.get(key) ?? max;
    const next = cur - amount;
    if (next > 0) {
      map.set(key, next);
      // Partial damage — fire OnTileDamaged so authors can drive crack
      // particles / hit sounds per swing. Uses the same lastDestroyedTile
      // snapshot shape as OnTileDestroyed so the same `lastTile.*` tokens
      // resolve in both triggers; the snapshot lives ALONG with `prevHP` /
      // `nextHP` so authors can branch on remaining HP.
      const center = this.cellToWorld(c, r);
      actor.scene.data.set("peaky.lastDamagedTile", {
        tilemap: this.name,
        layer: layerId,
        c, r,
        idx,
        prevHP: cur,
        nextHP: next,
        maxHP: max,
        x: center.x,
        y: center.y,
      });
      this._emitTileEvent(actor, "_tileDamaged");
      return next;
    }
    // Destroyed via the damage path. Delegate the actual teardown + drop spawn
    // + cascade to _destroyTileNow so cascade-triggered destroys (which bypass
    // hardness entirely — see _cascadeAbove) share the same logic.
    map.delete(key);
    this._destroyTileNow(actor, layerId, c, r, idx);
    return 0;
  }

  /** Unconditionally destroy a tile at (c, r) — bypasses hardness/HP entirely.
   *  Used by the cascade "destroy" path so an above tile without hardness still
   *  participates (the author opted into destruction via onBelowRemoved=destroy).
   *  Performs the same teardown as damageTile's destroy branch: clears the cell,
   *  spawns drops, broadcasts lastDestroyedTile + OnTileDestroyed, then cascades. */
  private _destroyTileNow(actor: Sprite, layerId: string, c: number, r: number, idx: number): void {
    // Grow-back: schedule a re-place of the SAME tile (preserving its transform)
    // before clearing, so the cell repopulates after the rolled delay.
    const grow = this.tileGrowBack[String(idx)];
    if (grow !== undefined) {
      const layer = this.findLayer(layerId);
      this._scheduleRegrow(grow, this.tileGrowBackPop[String(idx)] !== false, { layerId, c, r, tileIdx: idx, xf: layer?.xf?.[r * this.cols + c] });
    }
    this.removeTileAt(layerId, c, r);
    // Wipe any cached HP/maxHP so re-painting a tile at this cell later starts
    // fresh (otherwise stale HP would carry across paint/destroy cycles).
    const hpKey = this._tileHPKey(layerId, c, r);
    this._ensureTileHPMap().delete(hpKey);
    this._ensureTileMaxHPMap().delete(hpKey);
    const center = this.cellToWorld(c, r);
    const drops = this.tileDrops[String(idx)] ?? [];
    if (drops.length > 0) this._spawnTileDrops(actor, drops, center.x, center.y, this.tileDropLayer[String(idx)]);
    actor.scene.data.set("peaky.lastDestroyedTile", {
      tilemap: this.name,
      layer: layerId,
      c, r,
      idx,
      x: center.x,
      y: center.y,
    });
    this._emitTileEvent(actor, "_tileDestroyed");
    this._cascadeAbove(actor, layerId, c, r);
  }

  /** Find the deepest empty row in column `c` of `layerId` starting from
   *  `fromR`, walking downward. Stops just above the first solid tile,
   *  BigTile cell, or animated-tile placement, or at the map's bottom.
   *  Used so a dropping tile lands on the actual floor instead of one
   *  row down (which would leave it floating when multiple cells below
   *  are also empty). */
  private _findLandingRow(layerId: string, c: number, fromR: number): number {
    let r = fromR;
    // Bug #4 fix: scan EVERY tilemap layer for a solid cell below — not
    // just the source layer. Multi-layer tilemaps where the floor lives
    // on a different authored layer than the cascading tile (e.g.,
    // grass on "Decor" + ground on "Ground") previously let the tile
    // fall straight through visible ground tiles all the way to the
    // bottom of the map.
    const allLayerIds = this.layers.map((L) => L.id);
    const cellIsSolid = (nextR: number): boolean => {
      for (const lid of allLayerIds) {
        if (this.getTileAt(lid, c, nextR) >= 0) return true;
        if (this.findBigTilePlacementAt(lid, c, nextR)) return true;
        if (this.findAnimatedTilePlacementAt(lid, c, nextR)) return true;
      }
      return false;
    };
    while (r + 1 < this.rows) {
      if (cellIsSolid(r + 1)) break;
      r = r + 1;
    }
    // Touch the layerId argument so the param stays meaningful for future
    // single-layer scan modes and the linter doesn't flag it.
    void layerId;
    return r;
  }

  /** When a tile at (c, r) is destroyed on `sourceLayerId`, scan EVERY internal
   *  tilemap layer at (c, r-1) and act on each tile's `onBelowRemoved`. Multi-
   *  layer tilemaps (ground + foliage + decoration) cascade across layers:
   *  mining the ground layer kicks the foliage tile sitting on it. Recurses
   *  upward per layer for as long as each tile participates. Snapshots layer
   *  IDs first because cascade can mutate `this.layers`. */
  private _cascadeAbove(actor: Sprite, sourceLayerId: string, c: number, r: number): void {
    const aboveR = r - 1;
    if (aboveR < 0) return;
    const layerIds = this.layers.map((L) => L.id);
    for (const layerId of layerIds) {
      const aboveIdx = this.getTileAt(layerId, c, aboveR);
      if (aboveIdx >= 0) {
        const action = this.tileOnBelowRemoved[String(aboveIdx)];
        if (action === "destroy") {
          // Bypass damageTile/hardness — the author opted this tile into
          // cascade destruction via the per-tile dropdown.
          this._destroyTileNow(actor, layerId, c, aboveR, aboveIdx);
        } else if (action === "drop") {
          // Tween directly to the final landing row — the deepest empty
          // cell below `r` — instead of just one row down. Otherwise a
          // tile cascading into a column with multiple removed rows
          // floats at the top of the gap instead of falling all the way
          // through (the bug shown in the screenshot — grass tile mid-
          // column with empty space below it).
          const landingR = this._findLandingRow(layerId, c, r);
          this._tweenTileDrop(actor, layerId, c, aboveR, c, landingR, aboveIdx);
        }
        continue;
      }
      const animP = this.findAnimatedTilePlacementAt(layerId, c, aboveR);
      if (animP) {
        const def = this.animatedTiles[animP.animatedTileId];
        const action = def?.onBelowRemoved;
        if (action === "destroy" || action === "drop") {
          // Animated "drop" falls back to destroy (frame cycling makes a true
          // tween awkward; authors who want it should use a regular tile).
          this.damageAnimatedTile(actor, layerId, c, aboveR, Infinity);
        }
        continue;
      }
      // BigTile cascade — only triggers when (c, aboveR) is a MASK cell of the
      // BigTile (or any cell in the bbox if no mask is set). A tree with a
      // 2x2 trunk mask and 4x6 bbox should only fall when ground is mined
      // below the trunk, not below the canopy.
      const bigP = this.findBigTilePlacementAt(layerId, c, aboveR);
      if (bigP) {
        const bt = this.bigTiles[bigP.bigTileId];
        if (bt && this._bigTileCovers(bt, bigP, c, aboveR)) {
          const action = bt.onBelowRemoved;
          if (action === "destroy") {
            const topR = bigP.r;
            const leftC = bigP.c;
            const wCells = bt.w;
            this.removeBigTileAt(layerId, bigP.c, bigP.r);
            actor.scene.data.set("peaky.lastDestroyedTile", {
              tilemap: this.name,
              layer: layerId,
              c: leftC,
              r: topR,
              idx: -1,
              bigTileId: bigP.bigTileId,
              x: 0, y: 0,
            });
            this._emitTileEvent(actor, "_tileDestroyed");
            // Recurse upward from every column the composite spanned.
            for (let dx = 0; dx < wCells; dx++) {
              this._cascadeAbove(actor, layerId, leftC + dx, topR);
            }
          } else if (action === "drop") {
            this._tweenBigTileDrop(actor, layerId, bigP.c, bigP.r, bigP.bigTileId);
          }
        }
      }
    }
    // Silence the lint about the unused `sourceLayerId` — kept in the API
    // for symmetry with damageTile / future "same-layer-only" cascade modes.
    void sourceLayerId;
  }

  /** Tween a BigTile composite down by one cell. Remove the placement (which
   *  also drops its visual + collider), spawn a temporary stand-in Image at
   *  the old world position with the SAME texture binding the BigTile used,
   *  tween it down by tileH, then re-place the composite at (c, r+1) and
   *  recurse upward from every column the composite spanned. Falls back to a
   *  no-op (with a warning) when (c, r+1) would overflow the map. */
  private _tweenBigTileDrop(actor: Sprite, layerId: string, c: number, r: number, bigTileId: string): void {
    const bt = this.bigTiles[bigTileId];
    if (!bt) return;
    // Refuse to tween off the bottom edge of the map.
    if (r + 1 + bt.h > this.rows) {
      // Author asked for "drop" but the composite would overflow — treat as
      // destroy so the cascade still progresses cleanly.
      this.removeBigTileAt(layerId, c, r);
      for (let dx = 0; dx < bt.w; dx++) this._cascadeAbove(actor, layerId, c + dx, r);
      return;
    }
    const scene = this.sprite.scene;
    // Pure tile-grid dimensions (no atlas spacing) — matches the canvas
    // texture produced by ensureBigTileFrames and the placement code above.
    const srcTW = bt._src?.tileW ?? this.tileW;
    const srcTH = bt._src?.tileH ?? this.tileH;
    const wPx = bt.w * srcTW;
    const hPx = bt.h * srcTH;
    const srcWorldX = this._layerLeft + c * this.tileW + wPx / 2;
    const srcWorldY = this._layerTop + r * this.tileH + hPx / 2;
    const dstWorldY = srcWorldY + this.tileH;
    // Take the placement out (data + visual + collider) before the tween
    // starts so the colliders don't briefly overlap with the stand-in image.
    this.removeBigTileAt(layerId, c, r);
    const img = this._addBigTileImage(scene, srcWorldX, srcWorldY, bt);
    img.setOrigin(0.5, 0.5);
    img.setDepth(this._layerBaseDepth + 50_000);
    img.setAlpha(this._layerAlpha);
    img.setScrollFactor(this._scrollX, this._scrollY);
    this.sprite.routeOverlayToCamera(img);
    const DROP_DURATION_MS = 180;
    scene.tweens.add({
      targets: img,
      y: dstWorldY,
      duration: DROP_DURATION_MS,
      ease: "Quad.easeIn",
      onComplete: () => {
        try { img.destroy(); } catch { /* ignore */ }
        // Re-place the BigTile one row down. placeBigTile rebuilds the
        // visual + collider + scene-registry entries from the def.
        this.placeBigTile(layerId, bigTileId, c, r + 1);
        // Recurse upward from each column the composite USED to span.
        for (let dx = 0; dx < bt.w; dx++) {
          this._cascadeAbove(actor, layerId, c + dx, r);
        }
      },
    });
  }

  /** Tween a regular tile from (srcC, srcR) into the empty cell at (dstC, dstR).
   *  Clears the source first, spawns a temporary Phaser Image at the source's
   *  world center with the tile's texture frame, tweens Y to the destination's
   *  world center, then on complete re-creates the proper per-tile data + image
   *  via setTileAt, destroys the tween image, and recurses upward. */
  private _tweenTileDrop(actor: Sprite, layerId: string, srcC: number, srcR: number, dstC: number, dstR: number, tileIdx: number): void {
    const scene = this.sprite.scene;
    const srcWorld = this.cellToWorld(srcC, srcR);
    const dstWorld = this.cellToWorld(dstC, dstR);
    // Clear the source tile data + visual so it doesn't double-render during the tween.
    this.removeTileAt(layerId, srcC, srcR);
    // Make sure the per-tile frames exist on the (possibly extruded)
    // texture. Without this, a tween fired before ensureTilesetFrames
    // ran (or after a texture reload) creates an Image with a missing
    // frame, which Phaser silently falls back to the texture's full
    // base frame — showing the entire tileset spritesheet during the
    // tween instead of the single tile.
    ensureTilesetFrames(scene, this.textureKey, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
    const img = scene.add.image(srcWorld.x, srcWorld.y, this.textureKey, `tile_${tileIdx}`);
    img.setOrigin(0.5, 0.5);
    img.setDepth(this._layerBaseDepth + 50_000);
    img.setAlpha(this._layerAlpha);
    img.setScrollFactor(this._scrollX, this._scrollY);
    this.sprite.routeOverlayToCamera(img);
    // Physics body on the dropping tile — but with a processCallback
    // that STOPS the tween instead of separating bodies. Pushing the
    // player via immovable separation tunnels them through the solid
    // tiles below (Phaser arcade can't undo a single-step displacement
    // that goes past a static collider). Instead: when the tile's body
    // would overlap a sprite, we cancel the rest of the tween, snap
    // the tile to the cell just ABOVE the colliding sprite, and finalize
    // it as a regular tile there. The player stays put on whatever
    // they were standing on.
    scene.physics.add.existing(img, false);
    const dropBody = img.body as Phaser.Physics.Arcade.Body | null;
    if (dropBody) {
      dropBody.setImmovable(true);
      dropBody.setAllowGravity(false);
      dropBody.setSize(this.tileW, this.tileH);
    }
    let landingHandled = false;
    let tweenRef: Phaser.Tweens.Tween | null = null;
    const stopOnHit = (otherSprite: Sprite): boolean => {
      if (landingHandled) return false;
      landingHandled = true;
      tweenRef?.stop();
      // Compute the row directly above the sprite from its world Y.
      const otherY = otherSprite.gameObject.y;
      const layerTopY = this._layerTop;
      let stopR = Math.max(srcR, Math.floor((otherY - layerTopY) / this.tileH) - 1);
      // If a previously stacked tile is already sitting at that row
      // (earlier cascade tiles that landed on the same sprite),
      // walk UP until we find a truly empty cell. The tween image's
      // body doesn't collide with the static tilemap, so without this
      // every cascade tile would overwrite the same cell and visibly
      // "merge into one" on the sprite's head.
      while (stopR > srcR && this.getTileAt(layerId, dstC, stopR) >= 0) {
        stopR--;
      }
      try { img.destroy(); } catch { /* ignore */ }
      this.setTileAt(layerId, dstC, stopR, tileIdx);
      this._cascadeAbove(actor, layerId, srcC, srcR);
      // Event-driven retry: only attempt to drop again when the path is
      // ACTUALLY clear (no sprite center inside the path cells). The
      // previous version polled every 200ms and re-derived `stopR` from
      // the player's Y position, which fluctuates by sub-pixels each
      // frame (gravity micro-correction) and made `floor()` flip between
      // two cell indices — visible as the tile shaking up/down.
      // We poll at a slower 500ms interval AND only fire when the
      // sprite is no longer occupying any column-cell between stopR+1
      // and the prospective landing row.
      const cellLeftX = this._layerLeft + dstC * this.tileW;
      const cellRightX = cellLeftX + this.tileW;
      const retryFall = () => {
        // Bug #5 fix: guard against scene shutdown between scheduling
        // and firing. If the player triggered GoToLayout while the
        // 500ms timer was pending, `scene` is now torn down — reading
        // scene.data / calling scene.physics here would hit dead state.
        // Both this Sprite's host and the renderer's owning sprite are
        // checked because a layout swap destroys all sprites.
        if (this.sprite.destroyed) return;
        const scn = this.sprite.scene;
        const sys = scn?.sys as (Phaser.Scenes.Systems & { _running?: boolean }) | undefined;
        // Phaser doesn't expose a reliable "scene torn down" predicate.
        // The best signals available across versions:
        //  - settings.status === Phaser.Scenes.SHUTDOWN / DESTROYED
        //  - sys.isActive(): false once shutdown
        // A combined check handles both pre- and post-shutdown windows.
        if (!scn || !sys) return;
        const status = sys.settings?.status;
        if (status === Phaser.Scenes.SHUTDOWN || status === Phaser.Scenes.DESTROYED) return;
        if (typeof sys.isActive === "function" && !sys.isActive()) return;
        const here = this.getTileAt(layerId, dstC, stopR);
        if (here !== tileIdx) return; // tile gone or replaced — stop
        const landingNow = this._findLandingRow(layerId, dstC, stopR);
        if (landingNow > stopR) {
          // Pre-check: is there any sprite centered inside the path?
          // If yes, hold off — re-checking from Phaser physics would
          // just trigger another stopOnHit at the same row.
          const cellTopY = this._layerTop + (stopR + 1) * this.tileH;
          const cellBotY = this._layerTop + (landingNow + 1) * this.tileH;
          const sprites = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          let pathBlocked = false;
          for (const s of sprites) {
            if (!s.gameObject || !s.gameObject.body) continue;
            const sx = s.gameObject.x, sy = s.gameObject.y;
            if (sx > cellLeftX && sx < cellRightX && sy > cellTopY && sy < cellBotY) {
              pathBlocked = true;
              break;
            }
          }
          if (!pathBlocked) {
            this._tweenTileDrop(actor, layerId, dstC, stopR, dstC, landingNow, tileIdx);
            return;
          }
        }
        scene.time.delayedCall(500, retryFall);
      };
      scene.time.delayedCall(500, retryFall);
      return false; // Skip arcade separation entirely.
    };
    const dropColliders: Phaser.Physics.Arcade.Collider[] = [];
    const liveSprites = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of liveSprites) {
      if (!s.gameObject || !s.gameObject.body) continue;
      dropColliders.push(scene.physics.add.collider(s.gameObject, img, undefined, () => stopOnHit(s)));
    }
    // Constant SPEED — not constant duration. A 1-cell drop and a 10-cell
    // drop should move at the same pixels-per-second so cascading tiles
    // don't "rush" through long gaps. ~180ms per cell is comfortable.
    const MS_PER_PIXEL = 180 / this.tileH;
    const dropDistance = Math.abs(dstWorld.y - srcWorld.y);
    const DROP_DURATION_MS = Math.max(50, dropDistance * MS_PER_PIXEL);
    tweenRef = scene.tweens.add({
      targets: img,
      y: dstWorld.y,
      duration: DROP_DURATION_MS,
      ease: "Quad.easeIn",
      onComplete: () => {
        // Natural-end path: no sprite blocked it, so finalize at the
        // intended destination row. stopOnHit's early-finalize path
        // sets landingHandled=true so we skip the duplicate placement
        // here when a sprite intercepted the tile mid-tween.
        for (const c of dropColliders) { try { c.destroy(); } catch { /* ignore */ } }
        if (landingHandled) return;
        try { img.destroy(); } catch { /* ignore */ }
        this.setTileAt(layerId, dstC, dstR, tileIdx);
        this._cascadeAbove(actor, layerId, srcC, srcR);
      },
      onStop: () => {
        // Tween manually stopped (sprite intercepted). Colliders need
        // to die too — but the tile placement / cascade already ran
        // inside stopOnHit.
        for (const c of dropColliders) { try { c.destroy(); } catch { /* ignore */ } }
      },
    });
  }

  private _tileHPKey(layerId: string, c: number, r: number): string {
    // Tilemap id keeps namespaces clean when multiple tilemaps share a scene.
    return `${this.tilemapId}#${layerId}#${c},${r}`;
  }

  private _ensureTileHPMap(): Map<string, number> {
    const scene = this.sprite.scene;
    let map = scene.data.get("peaky.tileHP") as Map<string, number> | undefined;
    if (!map) {
      map = new Map<string, number>();
      scene.data.set("peaky.tileHP", map);
    }
    return map;
  }

  /** Per-cell rolled max HP — separate from current-HP so a cell whose
   *  expression rolled "5" remembers the 5 even after it gets hit down to 2.
   *  Without this, every damage tick would re-roll random expressions and
   *  HP tracking would be incoherent. */
  private _ensureTileMaxHPMap(): Map<string, number> {
    const scene = this.sprite.scene;
    let map = scene.data.get("peaky.tileMaxHP") as Map<string, number> | undefined;
    if (!map) {
      map = new Map<string, number>();
      scene.data.set("peaky.tileMaxHP", map);
    }
    return map;
  }

  /** Spawn one drop table at the destroyed tile's world center.
   *
   *  Each entry names a BP and (optionally) instance overrides that mirror
   *  what the user would set when placing the BP in the scene editor:
   *  instance name, SpriteRenderer animation / frame override, and a
   *  free-form `vars` map for any `exposeOnSpawn` variable. The BP author
   *  wires its own OnOverlap → GiveItem + Destroy logic.
   *
   *  Multiple copies (count > 1) all spawn at the same world point — the
   *  receiving BP can scatter them via its OnCreate (e.g. random velocity,
   *  small offset) if a "burst" look is desired.
   */
  /** Resolve a per-tile drop layer name to a runtime layer ID. Falls back to
   *  the tilemap's own layer when the name is empty or doesn't exist in the
   *  current scene (typo'd / cross-scene). Returns a value that spawn() can
   *  pass straight through to layerIdByName (which accepts ID or name). */
  private _resolveDropLayerId(layerName: string | undefined): string | undefined {
    const fallback = this.sprite.layerId;
    if (!layerName) return fallback;
    const map = this.sprite.scene.data.get("peaky.layerIdByName") as Record<string, string> | undefined;
    const id = map?.[layerName];
    if (id) return id;
    Logger.log({ level: "warn", source: "Drops", message: `drop layer "${layerName}" not found in scene — using tilemap's layer instead.` });
    return fallback;
  }

  private _spawnTileDrops(actor: Sprite, drops: { bp: string; min: number; max: number; chance: number; instanceName?: string; animation?: string; frame?: number; vars?: Record<string, string | number | boolean> }[], worldX: number, worldY: number, dropLayerName?: string): void {
    Logger.log({ level: "log", source: "Drops", message: `evaluating ${drops.length} drop entr${drops.length === 1 ? "y" : "ies"} on actor "${actor.blueprintName || actor.instanceName || "?"}"` });
    const spawn = actor.scene.data.get("peaky.spawn") as
      | ((arg: { id?: string; name?: string; x: number; y: number; layer?: string; vars?: Record<string, number | string | boolean>; instanceName?: string; animation?: string; frame?: number }) => void)
      | undefined;
    if (!spawn) {
      Logger.log({ level: "warn", source: "Drops", message: `peaky.spawn callback missing — can't spawn drops.` });
      return;
    }
    // WEIGHTED SINGLE-PICK semantics: drop entries are mutually exclusive.
    // Sum the chances → totalWeight. Roll one number across the full 100%
    // and pick the entry whose cumulative weight covers it. If totalWeight
    // < 100, the remainder is "no drop" probability — three entries at 33%
    // each → 99% something drops, 1% nothing. If totalWeight > 100, the
    // weights still work as proportions (each entry's share of the total
    // weight) but the "no drop" remainder collapses to zero.
    //
    // Previous behavior rolled EACH entry independently, so three 33%
    // entries could all fire on the same tile destroy — not what authors
    // expect from "33/33/33 means pick one of three".
    const valid = drops.filter((d) => {
      if (!d.bp) { Logger.log({ level: "warn", source: "Drops", message: `skipping entry — BP is not picked.` }); return false; }
      return true;
    });
    if (valid.length === 0) return;
    const totalWeight = valid.reduce((sum, d) => sum + Math.max(0, typeof d.chance === "number" ? d.chance : 100), 0);
    if (totalWeight <= 0) {
      Logger.log({ level: "log", source: "Drops", message: `all entries have 0 chance — nothing rolled` });
      return;
    }
    // Roll across full 100 so when totalWeight < 100, the gap is "no drop".
    const denominator = Math.max(100, totalWeight);
    const roll = Math.random() * denominator;
    let cumulative = 0;
    let picked: typeof valid[number] | null = null;
    for (const d of valid) {
      cumulative += Math.max(0, typeof d.chance === "number" ? d.chance : 100);
      if (roll < cumulative) { picked = d; break; }
    }
    if (!picked) {
      Logger.log({ level: "log", source: "Drops", message: `rolled ${roll.toFixed(1)}/${denominator.toFixed(0)} — no drop (gap below 100%)` });
      return;
    }
    {
      const d = picked;
      const min = Math.max(0, Math.floor(d.min ?? 1));
      const max = Math.max(min, Math.floor(d.max ?? min));
      const count = min + Math.floor(Math.random() * (max - min + 1));
      if (count <= 0) {
        Logger.log({ level: "log", source: "Drops", message: `"${d.bp}" rolled count 0 — skipped` });
        return;
      }
      Logger.log({ level: "log", source: "Drops", message: `rolled "${d.bp}" ×${count} (roll ${roll.toFixed(1)}/${denominator.toFixed(0)})` });
      const targetLayerId = this._resolveDropLayerId(dropLayerName);
      for (let i = 0; i < count; i++) {
        spawn({
          name: d.bp,
          x: worldX,
          y: worldY,
          layer: targetLayerId,
          instanceName: d.instanceName,
          animation: d.animation,
          frame: d.frame,
          vars: d.vars,
        });
      }
      Logger.log({ level: "log", source: "Drops", message: `"${d.bp}" × ${count} spawned at (${worldX.toFixed(0)}, ${worldY.toFixed(0)})` });
      // Notify the miner + Main Sheets: `_tileDrop` (OnTileDrop trigger) + a
      // `lastDrop` snapshot (Get Last Drop) so authors can react — count a
      // harvest, play a sound — without putting logic on each dropped item.
      actor.scene.data.set("peaky.lastDrop", {
        bp: d.bp, count, x: worldX, y: worldY, layer: targetLayerId ?? "",
      });
      this._emitTileEvent(actor, "_tileDrop");
    }
  }

  // ─── BigTile placement API (Tier 3) ──────────────────────────────────
  //
  // BigTiles are MULTI-CELL composites stamped from the tileset. A
  // "placement" stores `{ id, bigTileId, c, r }` where (c, r) is the
  // top-left anchor; the placement occupies (c..c+w-1, r..r+h-1).
  //
  // These methods touch L.bigTilePlacements (the source of truth),
  // _bigTilePlacementResources (the spawned Image + collider), and the
  // public scene registry — all three stay in sync.

  /** Find the BigTile placement (if any) that COVERS (c, r) on the named
   *  layer. Returns the placement record or null. Iterates placements; the
   *  list is typically small (dozens per layer), so the linear scan is
   *  cheaper than maintaining a 2-D cell→placement index. */
  findBigTilePlacementAt(layerId: string, c: number, r: number): { id: string; bigTileId: string; c: number; r: number } | null {
    const L = this.findLayer(layerId);
    if (!L) return null;
    for (const p of (L.bigTilePlacements ?? [])) {
      const bt = this.bigTiles[p.bigTileId];
      if (!bt) continue;
      if (c >= p.c && c < p.c + bt.w && r >= p.r && r < p.r + bt.h) return p;
    }
    return null;
  }

  /** Remove the BigTile placement covering (c, r) on the named layer. Cleans
   *  up the visual Image + collision body + scene registry entries. Returns
   *  the removed placement id, or null if there was none. */
  removeBigTileAt(layerId: string, c: number, r: number): string | null {
    const L = this.findLayer(layerId);
    if (!L) return null;
    const p = this.findBigTilePlacementAt(layerId, c, r);
    if (!p) return null;
    return this._destroyBigTilePlacement(L, p.id) ? p.id : null;
  }

  /** Spawn the static collision bodies for one BigTile placement. A cell-rect
   *  `collide` makes one body; a `collidePoly` decomposes (scanline → rects)
   *  into N bodies covering the custom shape. Returns the bodies so the caller
   *  can track them for layer-disable + surgical removal. Empty when the layer
   *  doesn't collide or the BigTile has no collider. */
  private _spawnBigTileColliders(
    scene: Phaser.Scene,
    bt: TilemapRenderer["bigTiles"][string],
    layerLeft: number, layerTop: number,
    placement: { c: number; r: number },
    L: InputLayer,
    group: Phaser.Physics.Arcade.StaticGroup,
  ): Phaser.GameObjects.Rectangle[] {
    if (!L.collides) return [];
    // The painted shape is decoupled from "solid": it can exist purely as the
    // mining damage area. Only block movement when solid. Undefined `solid`
    // = legacy (a shape implied solid), so old saves keep blocking.
    const isSolid = bt.solid ?? (!!bt.collidePoly || !!bt.collide);
    if (!isSolid) return [];
    const srcTW = bt._src?.tileW ?? this.tileW;
    const srcTH = bt._src?.tileH ?? this.tileH;
    const baseX = layerLeft + placement.c * this.tileW;
    const baseY = layerTop + placement.r * this.tileH;
    const excl = this.getExcludedTagsForBigTile(bt.id);
    const out: Phaser.GameObjects.Rectangle[] = [];
    const add = (lx: number, ly: number, w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const go = scene.add.rectangle(baseX + lx + w / 2, baseY + ly + h / 2, w, h, 0xff0000, 0);
      group.add(go);
      (go as { body?: Phaser.Physics.Arcade.StaticBody }).body?.updateFromGameObject();
      go.setDepth(this._layerBaseDepth + L.z * 0.01);
      go.setScrollFactor(this._scrollX, this._scrollY);
      go.setData("excludedTags", excl);
      out.push(go);
      this.bigTileColliderBodies.push({ go, L });
    };
    if (bt.collidePoly && bt.collidePoly.points.length >= 3) {
      for (const rc of polygonToRects(bt.collidePoly.points, bt.w * srcTW, bt.h * srcTH)) {
        add(rc.x, rc.y, rc.w, rc.h);
      }
    } else if (bt.collide) {
      add(bt.collide.cx * srcTW, bt.collide.cy * srcTH, bt.collide.cw * srcTW, bt.collide.ch * srcTH);
    }
    return out;
  }

  /** Place a new BigTile at (c, r) on the named layer. Returns the new
   *  placement id, or null if the BigTile definition is missing or the
   *  position would overflow the map bounds. */
  placeBigTile(layerId: string, bigTileId: string, c: number, r: number): string | null {
    const L = this.findLayer(layerId);
    if (!L) return null;
    // Accept a BigTile NAME as well as an id, so authors (and `var:` values)
    // can identify it by its readable name.
    let bt = this.bigTiles[bigTileId];
    if (!bt) {
      const byName = Object.values(this.bigTiles).find((b) => b.name === bigTileId);
      if (byName) bt = byName;
    }
    if (!bt) return null;
    if (c < 0 || r < 0 || c + bt.w > this.cols || r + bt.h > this.rows) return null;
    // Destroy any existing placement whose footprint intersects the new one
    // — single source of truth on the cell range. Without this, repeated
    // PlaceBigTile actions from a logic sheet stack identical sprites.
    const overlaps = (a: { c: number; r: number; w: number; h: number }, b: { c: number; r: number; w: number; h: number }) =>
      a.c < b.c + b.w && a.c + a.w > b.c && a.r < b.r + b.h && a.r + a.h > b.r;
    const newRect = { c, r, w: bt.w, h: bt.h };
    const collidingIds: string[] = [];
    for (const p of L.bigTilePlacements ?? []) {
      const pBt = this.bigTiles[p.bigTileId];
      if (!pBt) continue;
      if (overlaps(newRect, { c: p.c, r: p.r, w: pBt.w, h: pBt.h })) collidingIds.push(p.id);
    }
    for (const id of collidingIds) this._destroyBigTilePlacement(L, id);
    const id = `bp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const placement = { id, bigTileId: bt.id, c, r };
    if (!L.bigTilePlacements) L.bigTilePlacements = [];
    L.bigTilePlacements.push(placement);
    this._spawnBigTilePlacement(L, placement);
    return id;
  }

  /** Internal: destroy a single placement's resources by id. Removes the
   *  placement record from L.bigTilePlacements too. Used by both
   *  `removeBigTileAt` and (in Tier 2) `MineBigTile`. */
  private _destroyBigTilePlacement(L: InputLayer, placementId: string): boolean {
    const res = this._bigTilePlacementResources.get(placementId);
    if (!res) return false;
    const scene = this.sprite.scene;
    try { res.img.destroy(); } catch { /* ignore */ }
    for (const col of res.colliders) {
      try { col.destroy(); } catch { /* ignore */ }
      const colIdx = this.bigTileColliderBodies.findIndex((e) => e.go === col);
      if (colIdx >= 0) this.bigTileColliderBodies.splice(colIdx, 1);
    }
    // Strip from the perTileImages array + scene-level registries so
    // VisionMask / applyLayer / future iterations don't see a dangling image.
    const ptiIdx = this.perTileImages.findIndex((e) => e.img === res.img);
    if (ptiIdx >= 0) this.perTileImages.splice(ptiIdx, 1);
    const btreIdx = this.bigTileRegistryEntries.findIndex((e) => e.img === res.img);
    if (btreIdx >= 0) this.bigTileRegistryEntries.splice(btreIdx, 1);
    const sceneReg = scene?.data?.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject }[] | undefined;
    if (sceneReg) {
      const si = sceneReg.findIndex((e) => e.img === res.img);
      if (si >= 0) sceneReg.splice(si, 1);
    }
    this._bigTilePlacementResources.delete(placementId);
    // Source-of-truth: remove from the authored placements list too.
    const placements = L.bigTilePlacements ?? [];
    const pIdx = placements.findIndex((p) => p.id === placementId);
    if (pIdx >= 0) placements.splice(pIdx, 1);
    return true;
  }

  /** Internal: spawn one placement's Image + (optional) collision body,
   *  mirroring the init-time code paths (Y-sort vs standard). Called by
   *  `placeBigTile` for runtime additions. */
  private _spawnBigTilePlacement(L: InputLayer, placement: { id: string; bigTileId: string; c: number; r: number }): void {
    const bt = this.bigTiles[placement.bigTileId];
    if (!bt) return;
    const scene = this.sprite.scene;
    ensureBigTileFrames(scene, this.textureKey, this.bigTiles, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
    // Pure tile-grid dimensions, matching the contiguous canvas built by
    // ensureBigTileFrames.
    const srcTW = bt._src?.tileW ?? this.tileW;
    const srcTH = bt._src?.tileH ?? this.tileH;
    const wPx = bt.w * srcTW;
    const hPx = bt.h * srcTH;
    const worldX = this._layerLeft + placement.c * this.tileW + wPx / 2;
    const worldY = this._layerTop + placement.r * this.tileH + hPx / 2;
    const img = this._addBigTileImage(scene, worldX, worldY, bt);
    img.setOrigin(0.5, 0.5);
    // Use the same depth formula as the matching init path (Y-sort uses
    // trunk-base + sortY lift, non-Y-sort uses layer-z + 1).
    let depthOffset: number;
    if (this.ySort && L.ySort) {
      const userSortY = bt.sortY ?? 0.5;
      const trunkBaseY = this._layerTop + placement.r * this.tileH + hPx * (bt.sortLineY ?? 0.5);
      const Z_LIFT = 100_000;
      const lift = (0.5 - userSortY) * 2 * Z_LIFT;
      depthOffset = L.z * 0.01 + trunkBaseY + lift;
    } else {
      // < 0.01 so the BigTile stays inside its layer band (above its own flat
      // tiles, below the next layer). +1 leapt over higher layers.
      depthOffset = L.z * 0.01 + 0.005;
    }
    img.setDepth(this._layerBaseDepth + depthOffset);
    img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
    img.setVisible(this._layerVisible);
    img.setScrollFactor(this._scrollX, this._scrollY);
    this.sprite.routeOverlayToCamera(img);
    this.perTileImages.push({ img, depthOffset, L, c: placement.c, r: placement.r });
    const reg = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
    const list = reg ?? [];
    list.push({ img, tags: bt.tags ?? [], layerId: this.sprite.layerId });
    if (!reg) scene.data.set("peaky.bigTileImages", list);
    this.bigTileRegistryEntries.push({ img });

    const collBodies = this._spawnBigTileColliders(scene, bt, this._layerLeft, this._layerTop, placement, L, this._ensureCustomGroup());
    this._bigTilePlacementResources.set(placement.id, { img, colliders: collBodies, L });
  }

  // ─── Animated tile placements ──────────────────────────────────────────
  // Same pattern as BigTile placements but each renders ONE Phaser.Image
  // whose displayed tile-index cycles per the def's fps in update().

  findAnimatedTilePlacementAt(layerId: string, c: number, r: number): { id: string; animatedTileId: string; c: number; r: number } | null {
    const L = this.layers.find((x) => x.id === layerId);
    if (!L) return null;
    for (const p of (L.animatedTilePlacements ?? [])) {
      // Match the WHOLE footprint, not just the top-left anchor — a multi-cell
      // (region-mode) animated tile must be found by a hit on any of its cells
      // (mirrors findBigTilePlacementAt). frame 0's {w,h} defines the size.
      const f0 = this.animatedTiles[p.animatedTileId]?.frames?.[0];
      const w = f0 && typeof f0 !== "number" ? Math.max(1, f0.w) : 1;
      const h = f0 && typeof f0 !== "number" ? Math.max(1, f0.h) : 1;
      if (c >= p.c && c < p.c + w && r >= p.r && r < p.r + h) return p;
    }
    return null;
  }

  removeAnimatedTileAt(layerId: string, c: number, r: number): string | null {
    const p = this.findAnimatedTilePlacementAt(layerId, c, r);
    if (!p) return null;
    this._destroyAnimatedPlacement(layerId, p.id);
    return p.id;
  }

  placeAnimatedTile(layerId: string, animatedTileId: string, c: number, r: number): string | null {
    const L = this.layers.find((x) => x.id === layerId);
    if (!L) return null;
    // Accept an animated-tile NAME as well as an id, so authors (and runtime
    // `var:` expressions) can identify tiles by their readable name.
    let def = this.animatedTiles[animatedTileId];
    if (!def) {
      const byName = Object.values(this.animatedTiles).find((d) => d.name === animatedTileId);
      if (byName) def = byName;
    }
    if (!def) return null;
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return null;
    // Destroy any existing animated placement at this exact cell — single
    // source of truth so runtime stays in sync with the editor's dedup.
    const existing = (L.animatedTilePlacements ?? []).find((p) => p.c === c && p.r === r);
    if (existing) this._destroyAnimatedPlacement(layerId, existing.id);
    // Monotonic id seeded by Date.now + counter prevents the birthday-paradox
    // collision the old 7-char random suffix could hit in long-running mining
    // games (≈36^7 ≈ 7.8e10, so ~280k placements gives 50% chance of one
    // collision — way too few for a real save).
    const id = `ap_${Date.now().toString(36)}_${(this._nextAnimatedId++).toString(36)}`;
    const placement = { id, animatedTileId: def.id, c, r };
    if (!L.animatedTilePlacements) L.animatedTilePlacements = [];
    L.animatedTilePlacements.push(placement);
    this._spawnAnimatedTilePlacement(L, placement);
    return id;
  }

  /** Toggle playback on one placement. `restart=true` rewinds to frame 0;
   *  `loop` overrides the def's loop flag for this play session. */
  playAnimatedTilePlacement(placementId: string, opts?: { restart?: boolean; loop?: boolean }): boolean {
    const entry = this._animatedPlacements.get(placementId);
    if (!entry) return false;
    if (opts?.restart) { entry.frameIdx = 0; entry.elapsedSec = 0; }
    if (typeof opts?.loop === "boolean") entry.loopOverride = opts.loop;
    entry.playing = true;
    return true;
  }

  stopAnimatedTilePlacement(placementId: string): boolean {
    const entry = this._animatedPlacements.get(placementId);
    if (!entry) return false;
    entry.playing = false;
    return true;
  }

  /** Bulk play. `animatedTileId` filters to one def; absent = all. */
  playAllAnimatedTiles(opts?: { animatedTileId?: string; restart?: boolean; loop?: boolean }): number {
    let count = 0;
    for (const entry of this._animatedPlacements.values()) {
      if (opts?.animatedTileId && entry.placement.animatedTileId !== opts.animatedTileId) continue;
      if (opts?.restart) { entry.frameIdx = 0; entry.elapsedSec = 0; }
      if (typeof opts?.loop === "boolean") entry.loopOverride = opts.loop;
      entry.playing = true;
      count++;
    }
    return count;
  }

  stopAllAnimatedTiles(opts?: { animatedTileId?: string }): number {
    let count = 0;
    for (const entry of this._animatedPlacements.values()) {
      if (opts?.animatedTileId && entry.placement.animatedTileId !== opts.animatedTileId) continue;
      entry.playing = false;
      count++;
    }
    return count;
  }

  /** Fire a tile event (`_tileDamaged` / `_tileDestroyed` / `_tileDrop`) on the
   *  MINER plus every Main Sheet host. Main Sheets live on separate hidden host
   *  sprites (`__main…`), so the miner's emit alone never reaches them — fan out
   *  so scene-level logic ("any tile mined → …") can react too. Snapshots
   *  (lastDestroyedTile etc.) are scene data, already set before this. */
  private _emitTileEvent(actor: Sprite, name: string): void {
    actor.events.emit(name);
    const all = actor.scene?.data?.get("peaky.sprites") as Sprite[] | undefined;
    if (!all) return;
    for (const s of all) {
      if (s !== actor && !s.destroyed && s.blueprintId.startsWith("__main")) s.events.emit(name);
    }
  }

  /** True if footprint cell (dc, dr) — offset from the placement anchor —
   *  OVERLAPS the painted damage polygon. Cell-granular (not pixel-sensitive),
   *  so tracer/image-point jitter doesn't flip mining on/off; empty footprint
   *  cells the silhouette never touches stay unmineable. `tw/th` = source tile
   *  px; `footW/footH` = the polygon's px span. */
  private _cellInDamagePoly(
    poly: { x: number; y: number }[], footW: number, footH: number,
    tw: number, th: number, dc: number, dr: number,
  ): boolean {
    const cx = dc * tw, cy = dr * th;
    for (const rc of polygonToRects(poly, footW, footH)) {
      if (cx < rc.x + rc.w && cx + tw > rc.x && cy < rc.y + rc.h && cy + th > rc.y) return true;
    }
    return false;
  }

  /** True if the tracer's world LINE segment actually crosses the painted
   *  polygon (sub-cell). `left/top` = the placement's world top-left; the
   *  segment is sampled in footprint-local px and tested against the polygon,
   *  so an 8px trace must genuinely land on the silhouette to mine. */
  private _segmentInDamagePoly(
    poly: { x: number; y: number }[], left: number, top: number, seg: MineSeg,
  ): boolean {
    const lx0 = seg.x0 - left, ly0 = seg.y0 - top;
    const lx1 = seg.x1 - left, ly1 = seg.y1 - top;
    const samples = Math.max(2, Math.ceil(Math.hypot(lx1 - lx0, ly1 - ly0) / 2));
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      if (pointInPolygon(lx0 + (lx1 - lx0) * t, ly0 + (ly1 - ly0) * t, poly)) return true;
    }
    return false;
  }

  /** True if the tracer's world BOX rect overlaps the painted polygon's actual
   *  AREA (its rect decomposition), not just a footprint cell. Box version of
   *  `_segmentInDamagePoly`. `left/top` = placement world top-left. */
  private _boxInDamagePoly(
    poly: { x: number; y: number }[], footW: number, footH: number,
    left: number, top: number, box: MineBox,
  ): boolean {
    const bx0 = box.x - left, by0 = box.y - top;
    const bx1 = bx0 + box.w, by1 = by0 + box.h;
    for (const rc of polygonToRects(poly, footW, footH)) {
      if (bx0 < rc.x + rc.w && bx1 > rc.x && by0 < rc.y + rc.h && by1 > rc.y) return true;
    }
    return false;
  }

  /** Resolve the damage/collision polygon for an animated tile (footprint-local
   *  pixels). Prefers the def's own `collide`; otherwise — because animated
   *  tiles are built FROM BigTiles (their frames ARE BigTile footprints) —
   *  matches frame 0's region to the owning BigTile and reuses its painted
   *  `collidePoly`. Null = no shape (whole footprint mineable). */
  private _animatedDamagePoly(def: AnimatedTileDefRuntime): { x: number; y: number }[] | null {
    if (def.collide && def.collide.points.length >= 3) return def.collide.points;
    const f0 = def.frames[0];
    if (f0 && typeof f0 !== "number") {
      for (const bt of Object.values(this.bigTiles)) {
        if (bt.c === f0.c && bt.r === f0.r && bt.w === f0.w && bt.h === f0.h) {
          return bt.collidePoly && bt.collidePoly.points.length >= 3 ? bt.collidePoly.points : null;
        }
      }
    }
    return null;
  }

  /** Animated-tile mining. Mirrors `damageTile` but keys HP off the
   *  placement id (since the cell tile-index changes per frame). Returns
   *  the new HP, or -1 if there's no placement / it's unbreakable. */
  damageAnimatedTile(actor: Sprite, layerId: string, c: number, r: number, amount: number, seg?: MineSeg, box?: MineBox): number {
    const p = this.findAnimatedTilePlacementAt(layerId, c, r);
    if (!p) return -1;
    const def = this.animatedTiles[p.animatedTileId];
    if (!def) return -1;
    // Damage-area gate — mirror big tiles. With a tracer LINE (`seg`) the hit
    // only counts when the line actually crosses the painted SHAPE (sub-cell,
    // so an 8px trace must land ON the silhouette). Without a line (box/direct)
    // fall back to cell-overlap. Shape = the def's own `collide`, else the
    // source BigTile's `collidePoly`. No shape → whole footprint.
    {
      const poly = this._animatedDamagePoly(def);
      if (poly) {
        const f0 = def.frames[0];
        const fw = f0 && typeof f0 !== "number" ? Math.max(1, f0.w) : 1;
        const fh = f0 && typeof f0 !== "number" ? Math.max(1, f0.h) : 1;
        const srcTW = def._src?.tileW ?? this.tileW;
        const srcTH = def._src?.tileH ?? this.tileH;
        const left = this._layerLeft + p.c * this.tileW, top = this._layerTop + p.r * this.tileH;
        const hit = seg
          ? this._segmentInDamagePoly(poly, left, top, seg)
          : box
          ? this._boxInDamagePoly(poly, fw * srcTW, fh * srcTH, left, top, box)
          : this._cellInDamagePoly(poly, fw * srcTW, fh * srcTH, srcTW, srcTH, c - p.c, r - p.r);
        if (!hit) return -1;
      }
    }
    // Per-placement roll: random expressions on def.hardness roll ONCE per
    // placement on first damage; subsequent hits read the cached value.
    const maxMap = this._ensureTileMaxHPMap();
    const maxKey = `${this.tilemapId}#anim#${p.id}`;
    let max = maxMap.get(maxKey) ?? 0;
    if (max <= 0) {
      max = rollHardness(def.hardness as number | string | undefined);
      if (max > 0) maxMap.set(maxKey, max);
    }
    if (max <= 0) return -1;
    // Depleted placements ignore further damage so we don't re-fire drops /
    // OnTileDestroyed when the author keeps mining the leftover visual.
    const entry = this._animatedPlacements.get(p.id);
    if (entry?.depleted) return 0;
    if (amount <= 0) return this.getAnimatedTileHP(p.id);
    const map = this._ensureTileHPMap();
    const key = `${this.tilemapId}#anim#${p.id}`;
    const cur = map.get(key) ?? max;
    const next = cur - amount;
    if (next > 0) {
      map.set(key, next);
      // Damage-stages mode: each surviving hit advances the frame to match
      // the new HP (full HP = frame 0, 1 HP remaining = frame max-1). Clamp
      // when the frames array is shorter than hardness so the visual still
      // moves even with a misconfigured def.
      if (def.damageStagesMode && entry && entry.def.frames.length > 0) {
        const stageIdx = Math.min(entry.def.frames.length - 1, Math.max(0, max - next));
        entry.frameIdx = stageIdx;
        const tileIdx = entry.def.frames[stageIdx];
        if (typeof tileIdx === "number") {
          try { entry.img.setFrame(`tile_${tileIdx}`); } catch { /* texture race */ }
        }
      } else if (def.playOnHit && entry) {
        // Play-on-hit: restart the animation once as a reaction (update() resets
        // to frame 0 when it ends). Incompatible with damage-stages mode.
        entry.frameIdx = 0;
        entry.elapsedSec = 0;
        entry.playing = true;
        entry.loopOverride = false;
        entry.reacting = true;
      }
      // Partial damage on an animated placement — same OnTileDamaged signal
      // path as the regular tile. Authors get cracks/sound on every hit.
      const center = this.cellToWorld(c, r);
      actor.scene.data.set("peaky.lastDamagedTile", {
        tilemap: this.name,
        layer: layerId,
        c, r,
        idx: -1,
        animatedTileId: p.animatedTileId,
        tags: def.tags ?? [],
        name: def.name ?? "",
        prevHP: cur,
        nextHP: next,
        maxHP: max,
        x: center.x,
        y: center.y,
      });
      this._emitTileEvent(actor, "_tileDamaged");
      if (def.signalOnHit) this._emitTileEvent(actor, def.signalOnHit);
      return next;
    }
    map.delete(key);
    const center = this.cellToWorld(c, r);
    const destroyOnDepleted = def.destroyOnDepleted !== false;  // default true
    // Damage-stages mode IS the animation — never trigger an extra
    // play-on-depleted one-shot on top of it (the UI hides that toggle in
    // damage-stages mode, but the stored value can linger from before).
    // The killing hit plays the one-shot ONLY when play-on-deplete is set.
    // play-on-hit reacts on SURVIVING hits but does NOT force an animation on
    // the last hit — so "play-on-hit + destroy, no play-on-deplete" destroys
    // instantly on the killing blow.
    const playOnDepleted = def.playOnDepleted === true && !def.damageStagesMode;
    // Drops + destroy-context broadcast fire IMMEDIATELY on HP=0, regardless
    // of whether the visual sticks around for an animation. The trigger
    // semantics match regular tiles.
    if ((def.drops ?? []).length > 0) {
      this._spawnTileDrops(actor, def.drops!, center.x, center.y, def.dropLayer);
    }
    actor.scene.data.set("peaky.lastDestroyedTile", {
      tilemap: this.name,
      layer: layerId,
      c, r,
      idx: -1,
      animatedTileId: p.animatedTileId,
      tags: def.tags ?? [],
      name: def.name ?? "",
      x: center.x,
      y: center.y,
    });
    this._emitTileEvent(actor, "_tileDestroyed");
    if (def.signalOnMine) this._emitTileEvent(actor, def.signalOnMine);
    // Grow-back: only meaningful when the placement actually goes away.
    if (destroyOnDepleted) {
      this._scheduleRegrow((def as { growBack?: number | string }).growBack, (def as { growBackPop?: boolean }).growBackPop !== false, { layerId, c: p.c, r: p.r, animTileId: p.animatedTileId });
    }
    // Visual / collider handling depends on the def's toggles.
    if (entry) {
      // Collider always goes — depleted means "no longer blocks movement".
      if (entry.collider) {
        try { entry.collider.destroy(); } catch { /* ignore */ }
        entry.collider = null;
      }
      entry.depleted = true;
      if (playOnDepleted) {
        // Restart the animation from frame 0, force loop=false. update() will
        // either destroy the placement at the end (when destroyOnDepleted)
        // or freeze it on the last frame.
        entry.frameIdx = 0;
        entry.elapsedSec = 0;
        entry.playing = true;
        entry.loopOverride = false;
        entry.depletingAnim = true;
      } else if (destroyOnDepleted) {
        this._destroyAnimatedPlacement(layerId, p.id);
      } else {
        // Stays in the scene — freeze on the FINAL damage frame so the
        // visual reflects "fully broken", not the prev-stage frame. The
        // surviving-hit branch above advances per-hit but the killing blow
        // jumps straight here, so without this we'd freeze on frames[max-2]
        // (the previous stage), not the most-damaged look the author drew.
        if (entry.def.damageStagesMode && entry.def.frames.length > 0) {
          const lastIdx = entry.def.frames.length - 1;
          entry.frameIdx = lastIdx;
          const tileIdx = entry.def.frames[lastIdx];
          if (typeof tileIdx === "number") {
            try { entry.img.setFrame(`tile_${tileIdx}`); } catch { /* texture race */ }
          }
        }
        entry.playing = false;
      }
    } else if (destroyOnDepleted) {
      // Defensive — no runtime entry but we still need to wipe the data.
      this._destroyAnimatedPlacement(layerId, p.id);
    }
    // Cascade — same as the regular-tile destroy path.
    this._cascadeAbove(actor, layerId, c, r);
    return 0;
  }

  getAnimatedTileHP(placementId: string): number {
    const entry = this._animatedPlacements.get(placementId);
    if (!entry) return 0;
    // Prefer the cached per-placement rolled max if damageAnimatedTile has
    // ever been called on this placement; fall back to a parseHardnessMax
    // upper-bound when no roll has happened yet (purely informational).
    const maxMap = this._ensureTileMaxHPMap();
    const maxKey = `${this.tilemapId}#anim#${placementId}`;
    const max = maxMap.get(maxKey) ?? parseHardnessMax(entry.def.hardness as number | string | undefined);
    if (max <= 0) return 0;
    const map = this._ensureTileHPMap();
    const key = `${this.tilemapId}#anim#${placementId}`;
    const cur = map.get(key);
    return cur === undefined ? max : cur;
  }

  /** Upper-bound hardness for a BigTile def (for the mineAt "unbreakable" check
   *  before a placement has rolled its random hardness). */
  getBigTileMaxHardness(bigTileId: string): number {
    return parseHardnessMax(this.bigTiles[bigTileId]?.hardness);
  }

  /** Current HP of a BigTile placement (the whole-composite pool). */
  getBigTileHP(placementId: string): number {
    const maxMap = this._ensureTileMaxHPMap();
    const max = maxMap.get(`${this.tilemapId}#big#${placementId}`) ?? 0;
    const cur = this._ensureTileHPMap().get(`${this.tilemapId}#big#${placementId}`);
    return cur === undefined ? max : cur;
  }

  /** Damage the BigTile composite at (c, r). One HP pool for the whole tile.
   *  A hit only counts inside the `damageRect` (default: whole footprint).
   *  Returns the new HP, 0 on destroy, or -1 when nothing minable here
   *  (no placement, outside the damage area, or unbreakable). */
  damageBigTile(actor: Sprite, layerId: string, c: number, r: number, amount: number, seg?: MineSeg, box?: MineBox): number {
    const p = this.findBigTilePlacementAt(layerId, c, r);
    if (!p) return -1;
    const bt = this.bigTiles[p.bigTileId];
    if (!bt) return -1;
    // Damage area gate — the painted `collidePoly` IS the damage area. With a
    // tracer LINE (`seg`) a hit only counts when the line actually crosses the
    // silhouette (sub-cell); without one (box/direct) fall back to cell-overlap.
    // Supersedes the coarse cell `damageRect` when present.
    if (bt.collidePoly && bt.collidePoly.points.length >= 3) {
      const srcTW = bt._src?.tileW ?? this.tileW;
      const srcTH = bt._src?.tileH ?? this.tileH;
      const left = this._layerLeft + p.c * this.tileW, top = this._layerTop + p.r * this.tileH;
      const hit = seg
        ? this._segmentInDamagePoly(bt.collidePoly.points, left, top, seg)
        : box
        ? this._boxInDamagePoly(bt.collidePoly.points, bt.w * srcTW, bt.h * srcTH, left, top, box)
        : this._cellInDamagePoly(bt.collidePoly.points, bt.w * srcTW, bt.h * srcTH, srcTW, srcTH, c - p.c, r - p.r);
      if (!hit) return -1;
    } else if (bt.damageRect) {
      const dc = c - p.c, dr = r - p.r;
      const inside = dc >= bt.damageRect.cx && dc < bt.damageRect.cx + bt.damageRect.cw
                  && dr >= bt.damageRect.cy && dr < bt.damageRect.cy + bt.damageRect.ch;
      if (!inside) return -1;
    }
    if (this._bigTileDepleted.has(p.id)) return 0;
    const maxMap = this._ensureTileMaxHPMap();
    const maxKey = `${this.tilemapId}#big#${p.id}`;
    let max = maxMap.get(maxKey) ?? 0;
    if (max <= 0) {
      max = rollHardness(bt.hardness);
      if (max > 0) maxMap.set(maxKey, max);
    }
    if (max <= 0) return -1; // unbreakable
    if (amount <= 0) return this.getBigTileHP(p.id);
    const hpMap = this._ensureTileHPMap();
    const cur = hpMap.get(maxKey) ?? max;
    const next = cur - amount;
    const srcTW = bt._src?.tileW ?? this.tileW;
    const srcTH = bt._src?.tileH ?? this.tileH;
    const cx = this._layerLeft + p.c * this.tileW + (bt.w * srcTW) / 2;
    const cy = this._layerTop + p.r * this.tileH + (bt.h * srcTH) / 2;
    if (next > 0) {
      hpMap.set(maxKey, next);
      actor.scene.data.set("peaky.lastDamagedTile", {
        tilemap: this.name, layer: layerId, c, r, idx: -1,
        bigTileId: p.bigTileId, tags: bt.tags ?? [], name: p.bigTileId,
        prevHP: cur, nextHP: next, maxHP: max, x: cx, y: cy,
      });
      this._emitTileEvent(actor, "_tileDamaged");
      if (bt.signalOnHit) this._emitTileEvent(actor, bt.signalOnHit);
      return next;
    }
    hpMap.delete(maxKey);
    if ((bt.drops ?? []).length > 0) this._spawnTileDrops(actor, bt.drops!, cx, cy, bt.dropLayer);
    actor.scene.data.set("peaky.lastDestroyedTile", {
      tilemap: this.name, layer: layerId, c, r, idx: -1, bigTileId: p.bigTileId,
      tags: bt.tags ?? [], name: p.bigTileId, x: cx, y: cy,
    });
    this._emitTileEvent(actor, "_tileDestroyed");
    if (bt.signalOnMine) this._emitTileEvent(actor, bt.signalOnMine);
    if (bt.destroyOnDepleted !== false) {
      this._scheduleRegrow((bt as { growBack?: number | string }).growBack, (bt as { growBackPop?: boolean }).growBackPop !== false, { layerId, c: p.c, r: p.r, bigTileId: p.bigTileId });
      this.removeBigTileAt(layerId, p.c, p.r);
    } else {
      // Keep the visual; strip the collider so it no longer blocks movement.
      this._bigTileDepleted.add(p.id);
      const res = this._bigTilePlacementResources.get(p.id);
      if (res) {
        for (const col of res.colliders) {
          try { col.destroy(); } catch { /* ignore */ }
          const i = this.bigTileColliderBodies.findIndex((e) => e.go === col);
          if (i >= 0) this.bigTileColliderBodies.splice(i, 1);
        }
        res.colliders = [];
      }
    }
    return 0;
  }

  private _spawnAnimatedTilePlacement(L: InputLayer, placement: { id: string; animatedTileId: string; c: number; r: number }): void {
    const def = this.animatedTiles[placement.animatedTileId];
    if (!def) return;
    const scene = this.sprite.scene;
    ensureTilesetFrames(scene, this.textureKey, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
    const firstFrame = def.frames[0];
    // Region mode: any frame is a multi-cell {c,r,w,h} (drag-select or BigTile).
    // runProject converts the whole frame list to regions when so, so checking
    // frame 0 is sufficient. These render as a top-left-anchored composite (like
    // a BigTile) at the owning tileset's native size; single-cell number frames
    // keep the centered per-cell path.
    const regionMode = typeof firstFrame !== "number";
    let worldX: number, worldY: number, img: Phaser.GameObjects.Image;
    if (regionMode) {
      ensureAnimatedFrameComposites(scene, def.id, def.frames, this.textureKey, def._src, this.tileW, this.tileH, this.marginX, this.marginY, this.spacingX, this.spacingY);
      worldX = this._layerLeft + placement.c * this.tileW;
      worldY = this._layerTop + placement.r * this.tileH;
      img = scene.add.image(worldX, worldY, `animframe_${def.id}_0`);
      img.setOrigin(0, 0);
    } else {
      worldX = this._layerLeft + placement.c * this.tileW + this.tileW / 2;
      worldY = this._layerTop + placement.r * this.tileH + this.tileH / 2;
      img = scene.add.image(worldX, worldY, this.textureKey, `tile_${firstFrame}`);
      img.setOrigin(0.5, 0.5);
    }
    // Y-sort by a fraction of the footprint so a multi-cell animated object
    // sorts as one unit (player passes behind once its feet rise above the
    // line). A region frame built from a BigTile shares that BigTile's
    // footprint, so inherit its `sortLineY` — animated big-tile objects then
    // walk-behind at the same place as the static BigTile. Plain cell regions
    // fall back to the middle.
    const fh = regionMode && typeof firstFrame !== "number" ? Math.max(1, firstFrame.h) : 1;
    let sortFrac = 0.5;
    if (regionMode && typeof firstFrame !== "number") {
      for (const bt of Object.values(this.bigTiles)) {
        if (bt.c === firstFrame.c && bt.r === firstFrame.r && bt.w === firstFrame.w && bt.h === firstFrame.h) {
          sortFrac = bt.sortLineY ?? 0.5;
          break;
        }
      }
    }
    const depthOffset = (this.ySort && L.ySort)
      ? L.z * 0.01 + (this._layerTop + (placement.r + fh * sortFrac) * this.tileH)
      // +0.006 = a hair above the layer's flat tiles AND a hair above a BigTile
      // in the same cell (0.005), but < 0.01 so it stays inside the layer band.
      // The old +0.5 put animated placements above EVERY higher layer.
      : L.z * 0.01 + 0.006;
    img.setDepth(this._layerBaseDepth + depthOffset);
    img.setAlpha((L.alpha ?? 1) * this._layerAlpha);
    img.setVisible(this._layerVisible);
    img.setScrollFactor(this._scrollX, this._scrollY);
    this.sprite.routeOverlayToCamera(img);
    this.perTileImages.push({ img, depthOffset, L, c: placement.c, r: placement.r });
    const reg = (scene.data.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject; tags: string[]; layerId?: string }[] | undefined);
    const list = reg ?? [];
    list.push({ img, tags: [...(L.tags ?? []), ...(def.tags ?? [])], layerId: this.sprite.layerId });
    if (!reg) scene.data.set("peaky.bigTileImages", list);
    this.bigTileRegistryEntries.push({ img });

    // Collision — animated placements live OUTSIDE the per-cell tile array
    // (L.tiles stays empty at the placement's cell), so the standard
    // setCollision path on the Phaser tilemap layer NEVER sees them. We
    // spawn a full-cell static body whenever the layer collides AND the
    // first frame's source tile is marked solid in the tileset. This
    // matches author intuition: paint a solid tile as a frame → solid
    // animated placement.
    let collGo: Phaser.GameObjects.Rectangle | null = null;
    const solidSet = new Set(this.solidIndices);
    const isSolid = typeof firstFrame === "number" && solidSet.has(firstFrame);
    if (L.collides && isSolid) {
      const group = this._ensureCustomGroup();
      collGo = scene.add.rectangle(worldX, worldY, this.tileW, this.tileH, 0xff0000, 0);
      group.add(collGo);
      (collGo as { body?: Phaser.Physics.Arcade.StaticBody }).body?.updateFromGameObject();
      collGo.setDepth(this._layerBaseDepth + L.z * 0.01);
      collGo.setScrollFactor(this._scrollX, this._scrollY);
      collGo.setData("excludedTags", this.getExcludedTagsForAnimated(placement.animatedTileId));
    }

    this._animatedPlacements.set(placement.id, {
      placement, L, img,
      collider: collGo,
      def,
      frameIdx: 0,
      elapsedSec: 0,
      // Damage-stages mode disables auto-cycling — the frame is driven by
      // mining hits, not the clock. Logic-sheet PlayTileAnimation can still
      // force playback if the author really wants it.
      playing: def.damageStagesMode ? false : !!def.autoplay,
      loopOverride: null,
      depleted: false,
      depletingAnim: false,
      reacting: false,
    });
  }

  private _destroyAnimatedPlacement(layerId: string, placementId: string): void {
    const L = this.layers.find((x) => x.id === layerId);
    if (!L) return;
    const entry = this._animatedPlacements.get(placementId);
    if (entry) {
      try { entry.img.destroy(); } catch { /* ignore */ }
      // Static collider belongs to _customCollisionGroup — destroy() removes
      // it from the group (and its body) cleanly. Without this, mined
      // animated blocks leave invisible walls behind.
      if (entry.collider) {
        try { entry.collider.destroy(); } catch { /* ignore */ }
      }
      const ptIdx = this.perTileImages.findIndex((e) => e.img === entry.img);
      if (ptIdx >= 0) this.perTileImages.splice(ptIdx, 1);
      const scene = this.sprite.scene;
      const sceneReg = scene?.data?.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject }[] | undefined;
      if (sceneReg) {
        const idx = sceneReg.findIndex((e) => e.img === entry.img);
        if (idx >= 0) sceneReg.splice(idx, 1);
      }
      const regIdx = this.bigTileRegistryEntries.findIndex((e) => e.img === entry.img);
      if (regIdx >= 0) this.bigTileRegistryEntries.splice(regIdx, 1);
    }
    this._animatedPlacements.delete(placementId);
    // Drop any per-placement HP entry — without this, a later placeAnimatedTile
    // that reuses the same id pattern (or a sticky map key) would resurrect
    // stale damage from the now-destroyed placement.
    const hpMap = this.sprite.scene?.data?.get("peaky.tileHP") as Map<string, number> | undefined;
    if (hpMap) hpMap.delete(`${this.tilemapId}#anim#${placementId}`);
    const placements = L.animatedTilePlacements ?? [];
    const pIdx = placements.findIndex((p) => p.id === placementId);
    if (pIdx >= 0) placements.splice(pIdx, 1);
  }

  // ─── End public API ────────────────────────────────────────────────────

  onDestroy(): void {
    const scene = this.sprite.scene;
    for (const c of this._ownColliders) {
      try { c.destroy(); } catch { /* ignore — scene may be tearing down */ }
    }
    this._ownColliders.length = 0;
    if (this.phaserLayers.length > 0) {
      const registered = (scene?.data?.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
      for (const ph of this.phaserLayers) {
        const idx = registered.indexOf(ph);
        if (idx >= 0) registered.splice(idx, 1);
      }
    }
    this.phaserLayers.length = 0;
    this.phaserLayerDepthOffsets.length = 0;
    this.phaserLayerAuthored.length = 0;
    for (const entry of this.perTileImages) {
      try { entry.img.destroy(); } catch { /* ignore */ }
    }
    this.perTileImages.length = 0;
    this._cellImageByKey.clear();
    this._collisionLayerById.clear();
    this._phaserLayerById.clear();
    // The bodies are owned by `_customCollisionGroup`, which destroy(true)
    // below also destroys. Clear our index so we don't hold dangling refs.
    this._cellCustomBodies.clear();
    this._polyRectCache.clear();
    this._bigTilePlacementResources.clear();
    this._animatedPlacements.clear();
    this.bigTileColliderBodies.length = 0;
    // Unregister from name-keyed lookup. Guard the "is this still us?" check
    // so a re-init that happens to swap the entry before we run doesn't wipe
    // the live one.
    const byName = scene?.data?.get("peaky.tilemapsByName") as Map<string, TilemapRenderer> | undefined;
    if (byName && this.name && byName.get(this.name) === this) {
      byName.delete(this.name);
    }
    // Remove from the all-instances registry too (multi-instance bug fix).
    const byNameAll = scene?.data?.get("peaky.tilemapsByNameAll") as Map<string, TilemapRenderer[]> | undefined;
    if (byNameAll && this.name) {
      const list = byNameAll.get(this.name);
      if (list) {
        const idx = list.indexOf(this);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) byNameAll.delete(this.name);
      }
    }
    // Splice this renderer's entries out of the scene-level BigTile registry
    // so VisionMask doesn't dereference destroyed images.
    if (this.bigTileRegistryEntries.length > 0) {
      const list = scene?.data?.get("peaky.bigTileImages") as { img: Phaser.GameObjects.GameObject }[] | undefined;
      if (list) {
        const owned = new Set(this.bigTileRegistryEntries.map((e) => e.img));
        for (let i = list.length - 1; i >= 0; i--) {
          if (owned.has(list[i].img)) list.splice(i, 1);
        }
      }
      this.bigTileRegistryEntries.length = 0;
    }
    // Collision-only Phaser layers: unregister + destroy.
    if (this.collisionOnlyLayers.length > 0) {
      const registered = (scene?.data?.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
      for (const ph of this.collisionOnlyLayers) {
        const idx = registered.indexOf(ph);
        if (idx >= 0) registered.splice(idx, 1);
      }
    }
    this.collisionOnlyLayers.length = 0;
    for (const m of this.maps) {
      try { m.destroy(); } catch { /* ignore */ }
    }
    this.maps.length = 0;
    if (this._customCollisionGroup) {
      const groups = (scene?.data?.get("peaky.tilemapStaticGroups") as Phaser.Physics.Arcade.StaticGroup[] | undefined) ?? [];
      const idx = groups.indexOf(this._customCollisionGroup);
      if (idx >= 0) groups.splice(idx, 1);
      try { this._customCollisionGroup.destroy(true); } catch { /* ignore */ }
      this._customCollisionGroup = null;
    }
  }
}

/**
 * Decompose a 2D polygon into axis-aligned rectangles via scanline. Walks
 * each integer Y row of the tile, computes the polygon's horizontal spans at
 * Y+0.5 (using the even-odd fill rule), and emits per-row rectangles. Then
 * vertically merges rows whose spans match exactly so a tall left-side wall
 * becomes ONE rectangle, not `tileH` of them.
 *
 * Arcade physics has no polygon-body support — every collider must be an
 * AABB — so this is how we honor a user-drawn polygon shape: by producing
 * the smallest rect-set that covers it.
 *
 * Edge cases: collinear polygon edges and points on a scan line are handled
 * via the standard even-odd rule (count each crossing once). Self-intersecting
 * polygons get a "best-effort" decomposition; we don't validate input.
 */
/** A tracer's world line segment, passed into the tile-mining damage gates. */
type MineSeg = { x0: number; y0: number; x1: number; y1: number };
/** A box tracer's world rect, passed into the tile-mining damage gates. */
type MineBox = { x: number; y: number; w: number; h: number };

/** Even-odd ray-cast point-in-polygon (footprint-local px). */
function pointInPolygon(px: number, py: number, points: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonToRects(
  points: { x: number; y: number }[],
  tileW: number, tileH: number,
): { x: number; y: number; w: number; h: number }[] {
  if (points.length < 3) return [];
  // Per-row spans: each row's list of [leftPx, rightPx] segments.
  type Span = { x: number; w: number };
  const rows: Span[][] = [];
  for (let y = 0; y < tileH; y++) {
    const yLine = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const A = points[i];
      const B = points[(i + 1) % points.length];
      const yMin = Math.min(A.y, B.y), yMax = Math.max(A.y, B.y);
      if (yLine < yMin || yLine >= yMax) continue;
      const t = (yLine - A.y) / (B.y - A.y);
      crossings.push(A.x + t * (B.x - A.x));
    }
    crossings.sort((a, b) => a - b);
    const spans: Span[] = [];
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const xL = Math.max(0, Math.round(crossings[i]));
      const xR = Math.min(tileW, Math.round(crossings[i + 1]));
      if (xR > xL) spans.push({ x: xL, w: xR - xL });
    }
    rows[y] = spans;
  }
  // Vertical merge: consecutive rows with the same spans collapse into one tall rect set.
  const out: { x: number; y: number; w: number; h: number }[] = [];
  let y = 0;
  while (y < tileH) {
    const spans = rows[y];
    if (!spans || spans.length === 0) { y++; continue; }
    let h = 1;
    while (y + h < tileH && spansEqual(rows[y + h], spans)) h++;
    for (const s of spans) out.push({ x: s.x, y, w: s.w, h });
    y += h;
  }
  return out;
}

function spansEqual(a: { x: number; w: number }[] | undefined, b: { x: number; w: number }[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].w !== b[i].w) return false;
  }
  return true;
}

/**
 * Ensure the tileset texture has a named frame per tile index, e.g. `tile_5`
 * for index 5. Lets us spawn per-tile Phaser.GameObjects.Image cheaply via
 * `scene.add.image(x, y, textureKey, "tile_5")`. Frame regions are computed
 * from tileW/tileH + margin + spacing, matching Phaser's addTilesetImage
 * convention.
 */
/**
 * Add a named frame per BigTile to the tileset texture so per-placement Images
 * can render the multi-cell region as one composite sprite. Frame key format:
 * `bigtile_<id>`. Skipped if the texture already has that frame.
 */
function ensureBigTileFrames(
  scene: Phaser.Scene,
  textureKey: string,
  bigTiles: Record<string, { id: string; name?: string; c: number; r: number; w: number; h: number; cells?: { c: number; r: number }[]; _src?: BigTileSrc }>,
  tileW: number, tileH: number,
  marginX: number, marginY: number,
  spacingX: number, spacingY: number,
): void {
  // ALWAYS build a contiguous canvas — never rely on a sub-frame of the
  // atlas. The atlas's per-tile spacing (≥4px for the extruded variant)
  // would otherwise appear inside the BigTile frame as extra pixels,
  // making the rendered image taller/wider than `bt.h × tileH` and
  // bleeding into the rows below the placement (e.g., a 1×4 tree
  // sticking 12px into the ground). The canvas is sized to the DESTINATION
  // (map) tile grid; each source tile is scaled into a map cell so a BigTile
  // from a differently-sized tileset still lands on the grid.
  for (const id of Object.keys(bigTiles)) {
    const bt = bigTiles[id];
    // On a multi-tileset map the combined runtime texture is reflowed, so a
    // BigTile reads from its OWNING tileset's source atlas (`_src`); otherwise
    // it reads from the map's single (extruded) texture.
    const srcKey = bt._src?.key ?? textureKey;
    const sTileW = bt._src?.tileW ?? tileW;
    const sTileH = bt._src?.tileH ?? tileH;
    const sMarginX = bt._src?.marginX ?? marginX;
    const sMarginY = bt._src?.marginY ?? marginY;
    const sSpacingX = bt._src?.spacingX ?? spacingX;
    const sSpacingY = bt._src?.spacingY ?? spacingY;
    const tex = scene.textures.get(srcKey);
    if (!tex || tex.key === "__MISSING") continue;
    const isSparse = !!(bt.cells && bt.cells.length > 0 && bt.cells.length < bt.w * bt.h);
    const key = `bigtile_${bt.id}`;
    if (scene.textures.exists(key)) continue;
    // Build at the SOURCE tileset's NATIVE resolution so a BigTile from a
    // differently-sized tileset (e.g. a 64×128 door in a 32px map) keeps its
    // true size instead of being squished to the map cell. Single-tileset maps
    // have sTileW === tileW, so trees/etc. are byte-identical to before.
    const w = bt.w * sTileW;
    const h = bt.h * sTileH;
    const canvasTex = scene.textures.createCanvas(key, w, h);
    if (!canvasTex) continue;
    const src = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const ctx = canvasTex.getContext();
    // Enumerate cells: explicit list for sparse, full bbox otherwise.
    const cells: Array<{ c: number; r: number }> = isSparse
      ? (bt.cells ?? [])
      : [];
    if (!isSparse) {
      for (let cr = 0; cr < bt.h; cr++) {
        for (let cc = 0; cc < bt.w; cc++) cells.push({ c: cc, r: cr });
      }
    }
    for (const cell of cells) {
      const srcX = sMarginX + (bt.c + cell.c) * (sTileW + sSpacingX);
      const srcY = sMarginY + (bt.r + cell.r) * (sTileH + sSpacingY);
      const dstX = cell.c * sTileW;
      const dstY = cell.r * sTileH;
      ctx.drawImage(src, srcX, srcY, sTileW, sTileH, dstX, dstY, sTileW, sTileH);
    }
    canvasTex.refresh();
  }
}

/** Bake each MULTI-CELL region frame of an animated tile into its own canvas
 *  texture `animframe_<defId>_<i>` at the source tileset's native resolution —
 *  the same compositing as ensureBigTileFrames, but per animation frame. Lets an
 *  animated tile span several cells (a multi-cell drag-select or a BigTile). */
function ensureAnimatedFrameComposites(
  scene: Phaser.Scene,
  defId: string,
  frames: AnimFrameRuntime[],
  textureKey: string,
  src: BigTileSrc | undefined,
  tileW: number, tileH: number,
  marginX: number, marginY: number,
  spacingX: number, spacingY: number,
): void {
  const srcKey = src?.key ?? textureKey;
  const sTileW = src?.tileW ?? tileW;
  const sTileH = src?.tileH ?? tileH;
  const sMarginX = src?.marginX ?? marginX;
  const sMarginY = src?.marginY ?? marginY;
  const sSpacingX = src?.spacingX ?? spacingX;
  const sSpacingY = src?.spacingY ?? spacingY;
  const tex = scene.textures.get(srcKey);
  if (!tex || tex.key === "__MISSING") return;
  const srcImg = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (typeof f === "number") continue;
    const key = `animframe_${defId}_${i}`;
    if (scene.textures.exists(key)) continue;
    const w = Math.max(1, f.w) * sTileW;
    const h = Math.max(1, f.h) * sTileH;
    const canvasTex = scene.textures.createCanvas(key, w, h);
    if (!canvasTex) continue;
    const ctx = canvasTex.getContext();
    for (let cr = 0; cr < f.h; cr++) {
      for (let cc = 0; cc < f.w; cc++) {
        const sx = sMarginX + (f.c + cc) * (sTileW + sSpacingX);
        const sy = sMarginY + (f.r + cr) * (sTileH + sSpacingY);
        ctx.drawImage(srcImg, sx, sy, sTileW, sTileH, cc * sTileW, cr * sTileH, sTileW, sTileH);
      }
    }
    canvasTex.refresh();
  }
}

/** Match `random(min, max)` — both args are positive numbers, allows
 *  leading/trailing whitespace, case-insensitive function name. */
const RANDOM_RE = /^\s*random\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/i;

/** Resolve a hardness value to its concrete max HP for this hit:
 *   - number → returned as-is (clamped to >= 0)
 *   - "5" / "3.5" → parsed as number
 *   - "random(min, max)" → integer roll inclusive of both bounds
 *   - anything else → 0 (unbreakable, mining no-ops)
 * Called once per cell on first damage; result is cached in tileMaxHP map
 * so subsequent hits on the same cell don't re-roll. */
export function rollHardness(raw: number | string | undefined): number {
  if (raw === undefined) return 0;
  if (typeof raw === "number") return raw > 0 ? Math.floor(raw) : 0;
  const s = String(raw).trim();
  if (s === "") return 0;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? Math.floor(n) : 0;
  }
  const m = RANDOM_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const min = Math.max(0, Math.floor(Math.min(a, b)));
    const max = Math.max(0, Math.floor(Math.max(a, b)));
    if (max <= 0) return 0;
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  return 0;
}

/** Upper bound of a hardness expression — used for "is this tile breakable"
 *  pre-checks where the actual rolled value isn't needed yet. Matches
 *  rollHardness's parsing but skips randomization. */
export function parseHardnessMax(raw: number | string | undefined): number {
  if (raw === undefined) return 0;
  if (typeof raw === "number") return raw > 0 ? Math.floor(raw) : 0;
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? Math.floor(n) : 0;
  }
  const m = RANDOM_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const max = Math.max(0, Math.floor(Math.max(a, b)));
    return max;
  }
  return 0;
}

/** Roll a grow-back DELAY (seconds, fractional OK). 0 / blank / negative = never.
 *   - plain number → that many seconds
 *   - "random(min, max)" → a uniform FLOAT in [min, max]
 *   - "choose(a, b, c, …)" → one of the listed numbers at random
 *  Each destroyed tile rolls its own value, so a field of bushes regrows with
 *  natural variation. */
export function rollGrowBack(raw: number | string | undefined): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === "number") return raw > 0 ? raw : 0;
  const s = String(raw).trim();
  if (s === "") return 0;
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n > 0 ? n : 0; }
  let m = /^random\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/i.exec(s);
  if (m) { const a = Number(m[1]), b = Number(m[2]); const lo = Math.min(a, b), hi = Math.max(a, b); return Math.max(0, lo + Math.random() * (hi - lo)); }
  m = /^choose\((.*)\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(",").map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
    if (parts.length > 0) { const v = parts[Math.floor(Math.random() * parts.length)]; return v > 0 ? v : 0; }
  }
  return 0;
}

function ensureTilesetFrames(
  scene: Phaser.Scene,
  textureKey: string,
  tileW: number, tileH: number,
  marginX: number, marginY: number,
  spacingX: number, spacingY: number,
): void {
  const tex = scene.textures.get(textureKey);
  // Bail safely if the texture has no usable source (empty/oversized canvas).
  if (!tex || tex.key === "__MISSING" || !tex.has("__BASE")) return;
  // Use the BASE source — passing `0` makes Phaser 3.90 treat it as a frame
  // NAME, and once tile_<i> frames exist it warns "has no frame 0" on every
  // call (1000s of console spam). No-arg = __BASE, the full atlas image.
  const src = tex.getSourceImage() as HTMLImageElement | { width: number; height: number };
  const texW = (src as HTMLImageElement).width ?? 0;
  const texH = (src as HTMLImageElement).height ?? 0;
  if (texW <= 0 || texH <= 0) return;
  const cols = Math.max(1, Math.floor((texW - marginX + spacingX) / (tileW + spacingX)));
  const rows = Math.max(1, Math.floor((texH - marginY + spacingY) / (tileH + spacingY)));
  const total = cols * rows;
  for (let i = 0; i < total; i++) {
    const key = `tile_${i}`;
    if (tex.has(key)) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = marginX + col * (tileW + spacingX);
    const y = marginY + row * (tileH + spacingY);
    tex.add(key, 0, x, y, tileW, tileH);
  }
}

/**
 * Reflow several tileset atlases into ONE combined canvas texture for a multi-
 * tileset map. Global tile ids are laid out row-major at width `combinedCols =
 * max(slot.cols)`, so id `g` lands at cell `(g % combinedCols, g / combinedCols)`
 * — exactly the position the downstream frame math (`tile_<g>`, Phaser's
 * `addTilesetImage`) computes. Each source tile is scaled into the PRIMARY
 * tileset's cell size so differently-sized tilesets still align to the grid.
 *
 * Cached on the scene keyed by the slot texture keys + firstgids, so the build
 * cost is one-time per tileset-set. Returns the combined key + uniform cell
 * size, or null when the inputs are degenerate.
 */
function ensureCombinedTileset(
  scene: Phaser.Scene,
  slots: TilesetSlotInfo[],
): { key: string; tileW: number; tileH: number } | null {
  const cellW = slots[0]?.tileW ?? 0;
  const cellH = slots[0]?.tileH ?? 0;
  if (cellW <= 0 || cellH <= 0) return null;
  const cacheKey = "combined:" + slots.map((s) => `${s.textureKey}@${s.firstgid}`).join(",");
  if (scene.textures.exists(cacheKey)) return { key: cacheKey, tileW: cellW, tileH: cellH };
  const combinedCols = Math.max(...slots.map((s) => Math.max(1, s.cols)));
  const total = slots.reduce((n, s) => n + Math.max(1, s.cols) * Math.max(1, s.rows), 0);
  if (combinedCols <= 0 || total <= 0) return null;
  const combinedRows = Math.ceil(total / combinedCols);
  const W = combinedCols * cellW;
  const H = combinedRows * cellH;
  // Browsers cap canvas/texture size (~16384px). Past that createCanvas yields
  // an empty texture that crashes the frame setup downstream. Bail with a clear
  // message so the author can split/shrink tilesets instead of black-screening.
  if (W > 16384 || H > 16384) {
    console.warn(`[Peaky] Combined tileset texture is ${W}x${H}px — exceeds the browser canvas limit (16384). Use fewer / smaller tilesets on this map (or lower tile scale). Tiles from this set won't render.`);
    return null;
  }
  const canvasTex = scene.textures.createCanvas(cacheKey, W, H);
  if (!canvasTex) return null;
  const ctx = canvasTex.getContext();
  ctx.imageSmoothingEnabled = false;
  for (const s of slots) {
    const tex = scene.textures.get(s.textureKey);
    if (!tex || tex.key === "__MISSING" || !tex.has("__BASE")) continue;
    const src = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    const count = Math.max(1, s.cols) * Math.max(1, s.rows);
    for (let i = 0; i < count; i++) {
      const g = s.firstgid + i;
      const cx = g % combinedCols;
      const cy = Math.floor(g / combinedCols);
      const sc = i % s.cols;
      const sr = Math.floor(i / s.cols);
      const sx = s.marginX + sc * (s.tileW + s.spacingX);
      const sy = s.marginY + sr * (s.tileH + s.spacingY);
      ctx.drawImage(src, sx, sy, s.tileW, s.tileH, cx * cellW, cy * cellH, cellW, cellH);
    }
  }
  canvasTex.refresh();
  return { key: cacheKey, tileW: cellW, tileH: cellH };
}

/**
 * Build an EXTRUDED variant of a tileset atlas to defeat bilinear / trilinear
 * tile bleed.
 *
 * The bleed (visible as thin black or neighboring-color seams between tiles
 * when sampling != "nearest") happens because LINEAR filter interpolates
 * across the tile boundary in the source atlas — at sub-pixel scroll positions,
 * the GPU samples slightly outside the tile's source rect and picks up
 * transparent / dark gap pixels (or pixels from the next tile in the atlas).
 *
 * The fix is industry-standard: copy each tile's edge pixels OUTWARD by
 * `pad` pixels into a padded slot. The LINEAR kernel then samples the SAME
 * color at the boundary as it does just inside the tile, so no bleed —
 * even with sub-pixel scrolling and zero camera-follow stutter.
 *
 * Returns the extruded texture's key + new margin / spacing values so the
 * caller can swap them in for Phaser's `addTilesetImage` and the per-tile
 * frame setup. Cached on the scene so we build the extruded variant exactly
 * once per (source tileset × tile dims). NO-OP when the source texture is
 * missing or has zero dimensions — callers fall back to the original.
 */
export function ensureExtrudedTileset(
  scene: Phaser.Scene,
  textureKey: string,
  tileW: number, tileH: number,
  marginX: number, marginY: number,
  spacingX: number, spacingY: number,
): { key: string; marginX: number; marginY: number; spacingX: number; spacingY: number } {
  const PAD = 2;
  const xKey = `${textureKey}__x${PAD}_${tileW}x${tileH}_${marginX}_${marginY}_${spacingX}_${spacingY}`;
  const fallback = { key: textureKey, marginX, marginY, spacingX, spacingY };
  if (scene.textures.exists(xKey)) {
    return { key: xKey, marginX: PAD, marginY: PAD, spacingX: PAD * 2, spacingY: PAD * 2 };
  }
  const srcTex = scene.textures.get(textureKey);
  if (!srcTex || srcTex.key === "__MISSING") return fallback;
  const srcImg = srcTex.getSourceImage() as HTMLImageElement | HTMLCanvasElement | { width: number; height: number };
  const srcW = (srcImg as HTMLImageElement).width ?? 0;
  const srcH = (srcImg as HTMLImageElement).height ?? 0;
  if (srcW <= 0 || srcH <= 0) return fallback;
  const cols = Math.max(1, Math.floor((srcW - marginX + spacingX) / (tileW + spacingX)));
  const rows = Math.max(1, Math.floor((srcH - marginY + spacingY) / (tileH + spacingY)));
  // Destination layout: 1 tile slot = (tileW + 2*PAD) × (tileH + 2*PAD).
  // Outer margin = PAD (so the first tile's extrusion has room before it).
  // Gap between adjacent tiles = 2*PAD (PAD from the left tile's right
  // extrusion + PAD from the right tile's left extrusion). This is exactly
  // the layout Phaser's addTilesetImage expects when given margin=PAD,
  // spacing=2*PAD.
  const dstW = PAD + cols * (tileW + 2 * PAD) - PAD;
  const dstH = PAD + rows * (tileH + 2 * PAD) - PAD;
  // Margin/spacing values the CALLER should hand to addTilesetImage and
  // ensureTilesetFrames so the extruded layout reads correctly.
  const newMarginX = PAD;
  const newMarginY = PAD;
  const newSpacingX = PAD * 2;
  const newSpacingY = PAD * 2;
  const canvasTex = scene.textures.createCanvas(xKey, dstW, dstH);
  if (!canvasTex) return fallback;
  const ctx = canvasTex.getContext();
  // Disable smoothing for the per-pixel edge stretches — we WANT each
  // extruded edge to be the exact source pixel color repeated, not a
  // browser-interpolated blend that could re-introduce its own seam.
  ctx.imageSmoothingEnabled = false;
  const drawAny = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void => {
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    ctx.drawImage(srcImg as CanvasImageSource, sx, sy, sw, sh, dx, dy, dw, dh);
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = marginX + col * (tileW + spacingX);
      const sy = marginY + row * (tileH + spacingY);
      const dx = newMarginX + col * (tileW + newSpacingX);
      const dy = newMarginY + row * (tileH + newSpacingY);
      // Core tile (untouched copy).
      drawAny(sx, sy, tileW, tileH, dx, dy, tileW, tileH);
      // Four edges — copy a 1-pixel strip from the source edge, stretch
      // it PAD pixels outward in the destination.
      drawAny(sx, sy, tileW, 1, dx, dy - PAD, tileW, PAD); // top
      drawAny(sx, sy + tileH - 1, tileW, 1, dx, dy + tileH, tileW, PAD); // bottom
      drawAny(sx, sy, 1, tileH, dx - PAD, dy, PAD, tileH); // left
      drawAny(sx + tileW - 1, sy, 1, tileH, dx + tileW, dy, PAD, tileH); // right
      // Four corners — copy a single pixel, stretch into a PAD × PAD square.
      drawAny(sx, sy, 1, 1, dx - PAD, dy - PAD, PAD, PAD); // top-left
      drawAny(sx + tileW - 1, sy, 1, 1, dx + tileW, dy - PAD, PAD, PAD); // top-right
      drawAny(sx, sy + tileH - 1, 1, 1, dx - PAD, dy + tileH, PAD, PAD); // bottom-left
      drawAny(sx + tileW - 1, sy + tileH - 1, 1, 1, dx + tileW, dy + tileH, PAD, PAD); // bottom-right
    }
  }
  canvasTex.refresh();
  return { key: xKey, marginX: newMarginX, marginY: newMarginY, spacingX: newSpacingX, spacingY: newSpacingY };
}

/**
 * Greedy merge of axis-rectangle set — combines touching rectangles into the
 * smallest equivalent set. Two phases: horizontal merge within each (y, h)
 * group, then vertical merge within each (x, w) group.
 *
 * For tilemap collision: 50 grass-top-edge tiles in a row, each producing a
 * (0,0,16,4) rect, merge into one (0,0,800,4) rect. Mixed-shape tiles stay
 * separate (different y or h prevents the group merge).
 *
 * Mirror of editor/src/panels/tilemapCollision.ts:mergeRects so the editor
 * preview shows the same merged rectangles the runtime spawns.
 */
function mergeRects(rects: { x: number; y: number; w: number; h: number }[]): { x: number; y: number; w: number; h: number }[] {
  if (rects.length <= 1) return rects.slice();
  type R = { x: number; y: number; w: number; h: number };
  const byYH = new Map<string, R[]>();
  for (const r of rects) {
    const k = `${r.y}|${r.h}`;
    let arr = byYH.get(k);
    if (!arr) { arr = []; byYH.set(k, arr); }
    arr.push(r);
  }
  const horizMerged: R[] = [];
  for (const arr of byYH.values()) {
    arr.sort((a, b) => a.x - b.x);
    let cur = { ...arr[0] };
    for (let i = 1; i < arr.length; i++) {
      const next = arr[i];
      if (next.x <= cur.x + cur.w) {
        cur.w = Math.max(cur.x + cur.w, next.x + next.w) - cur.x;
      } else {
        horizMerged.push(cur);
        cur = { ...next };
      }
    }
    horizMerged.push(cur);
  }
  const byXW = new Map<string, R[]>();
  for (const r of horizMerged) {
    const k = `${r.x}|${r.w}`;
    let arr = byXW.get(k);
    if (!arr) { arr = []; byXW.set(k, arr); }
    arr.push(r);
  }
  const out: R[] = [];
  for (const arr of byXW.values()) {
    arr.sort((a, b) => a.y - b.y);
    let cur = { ...arr[0] };
    for (let i = 1; i < arr.length; i++) {
      const next = arr[i];
      if (next.y <= cur.y + cur.h) {
        cur.h = Math.max(cur.y + cur.h, next.y + next.h) - cur.y;
      } else {
        out.push(cur);
        cur = { ...next };
      }
    }
    out.push(cur);
  }
  return out;
}
