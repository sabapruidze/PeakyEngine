import { useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { useTilesetURL } from "../components/FrameThumb";
import { tilesetImagePath } from "../AssetStore";
import { useAssetURLs } from "../useAssetURL";
import { loadTilesetImage, paintLayerBuffer, type TileSlot } from "./tilemapDraw";
import { transformedSelection } from "./tilemapPainter";
import { BigTilePreview } from "./TilesetTab";
import { useResizableWidth, SidebarResizeHandle } from "./resizableSidebar";
import {
  autoTileBrushEdits, autoTileEraseEdits, autoTileRectEdits,
  buildTerrainOwnership, tileForMaskOrFallback,
} from "./tilemapAutoTile";
import { tilemapTilesets, animFrameRegion, type TerrainDef, type TilesetAsset } from "../project";

/** Shift every tile reference in a terrain by `firstgid` so its rules compare
 *  against the GLOBAL ids stored in a layer's `tiles` array. firstgid 0 (the
 *  primary tileset) returns the terrain unchanged. */
function offsetTerrain(t: TerrainDef, firstgid: number): TerrainDef {
  if (firstgid === 0) return t;
  return {
    ...t,
    defaultTile: t.defaultTile + firstgid,
    rules: t.rules.map((r) => ({ ...r, tile: r.tile + firstgid })),
  };
}

/**
 * TilemapTab — the tile painter. Two columns: a palette of tiles from the
 * chosen tileset on the left, and a paint canvas on the right.
 *
 * Tools (v1):
 *  - brush     — paint the selected tile under the cursor (drag-paints).
 *  - erase     — paint -1 (empty) under the cursor.
 *  - bucket    — flood-fill from the clicked cell (4-way).
 *  - rect      — drag to paint a filled rectangle of the selected tile.
 *  - picker    — sample the tile under the cursor into the selection.
 *
 * Single nested level (one grid, one tileset) per the v1 spec — multi-layer
 * per-map and multi-tileset per-map are explicitly out of scope.
 */
type Tool = "brush" | "erase" | "bucket" | "rect" | "picker";

/** One weighted entry in the Randomize pool — a single palette cell or a
 *  whole BigTile (door / window / prop). */
type PoolEntry =
  | { kind: "cell"; c: number; r: number; weight: number }
  | { kind: "bigtile"; id: string; weight: number };

export function TilemapTab({ tilemapId }: { tilemapId: string }) {
  const tilemap     = useEditor((s) => (s.project.tilemaps ?? []).find((m) => m.id === tilemapId));
  const tilesets    = useEditor((s) => s.project.tilesets ?? []);
  const renameTilemap     = useEditor((s) => s.renameTilemap);
  const setTilemapTileset = useEditor((s) => s.setTilemapTileset);
  const addTilemapTileset    = useEditor((s) => s.addTilemapTileset);
  const removeTilemapTileset = useEditor((s) => s.removeTilemapTileset);
  const setTilemapTags    = useEditor((s) => s.setTilemapTags);
  const resizeTilemap     = useEditor((s) => s.resizeTilemap);
  const paintTile         = useEditor((s) => s.paintTile);
  const paintTiles        = useEditor((s) => s.paintTiles);
  const placeBigTile       = useEditor((s) => s.placeBigTile);
  const removeBigTilePlacement = useEditor((s) => s.removeBigTilePlacement);
  const placeAnimatedTile  = useEditor((s) => s.placeAnimatedTile);
  const removeAnimatedTilePlacement = useEditor((s) => s.removeAnimatedTilePlacement);
  const [selectedBigTileId, setSelectedBigTileId] = useState<string | null>(null);
  const [selectedAnimatedTileId, setSelectedAnimatedTileId] = useState<string | null>(null);
  // Which tileset the palette is showing / painting from. Null = the primary.
  // Painting with a non-primary tileset stamps GLOBAL ids (firstgid + local).
  const [activePaletteTsId, setActivePaletteTsId] = useState<string | null>(null);
  // A BigTile / Animated brush belongs to ONE tileset. Switching the palette
  // tileset clears it so a stale selection from another tileset can't keep
  // painting after the user moves to a different tab.
  useEffect(() => {
    setSelectedBigTileId(null);
    setSelectedAnimatedTileId(null);
  }, [activePaletteTsId]);
  const addTilemapLayer    = useEditor((s) => s.addTilemapLayer);
  const removeTilemapLayer = useEditor((s) => s.removeTilemapLayer);
  const renameTilemapLayer = useEditor((s) => s.renameTilemapLayer);
  const updateTilemapLayer = useEditor((s) => s.updateTilemapLayer);
  const reorderTilemapLayer = useEditor((s) => s.reorderTilemapLayer);
  const moveTilemapLayerTo = useEditor((s) => s.moveTilemapLayerTo);
  // Layer drag-drop reordering state (grip-drag a row onto another row).
  const dragLayerId = useRef<string | null>(null);
  const [dragOverLayerId, setDragOverLayerId] = useState<string | null>(null);
  // Active layer = which one the painter writes into. Persisted across the
  // session via a local ref keyed by tilemap id; defaults to the topmost layer.
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("brush");
  // Ref to the scrollable canvas wrapper — Ctrl+wheel zoom and Space+drag pan
  // both read/write its scroll offsets to keep the cursor-anchored cell stable.
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  // Spacebar pan state — true while the user is holding Space. The wrapper's
  // mouse handlers translate movementX/Y into scroll while this is true.
  const [panning, setPanning] = useState(false);
  // Which layer is currently being renamed inline. The layer name is a
  // static span by default — switching to a live <input> only when
  // explicitly armed prevents two papercuts: (1) keyboard shortcuts
  // (B/E/G/R/I) get swallowed whenever any inline input has focus,
  // (2) tabbing through inputs would silently change the active layer
  // via the input's onFocus handler.
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameBuffer, setRenameBuffer] = useState("");
  // Same click-to-edit pattern for the Tilemap's own Name field. Static text
  // by default so keyboard shortcuts (B/E/G/R/I) aren't swallowed when the
  // input has focus. Double-click to switch to inline rename; blur or Enter
  // commits, Escape cancels.
  const [renamingTilemap, setRenamingTilemap] = useState(false);
  const [tilemapNameBuffer, setTilemapNameBuffer] = useState("");
  // Mouse-down state for pan — only scroll while BOTH space is held AND the
  // user is dragging. Stops the canvas from drifting on a stray mouse move.
  const panMouseDownRef = useRef(false);
  // Brush selection is a RECTANGLE in palette space (c0,r0 → c1,r1) so users
  // can drag-select a multi-tile group and stamp it as one. A single click
  // collapses to a 1×1 rect (the same tile as the old single-select). Picker
  // also produces a 1×1 rect anchored on the picked tile.
  const [selection, setSelection] = useState<{ c0: number; r0: number; c1: number; r1: number }>({ c0: 0, r0: 0, c1: 0, r1: 0 });
  // Randomize mode — when on, brush/rect/bucket paint tiles drawn at random
  // from a weighted pool. The pool is a list of palette cell coords + weight;
  // weights are relative (don't have to sum to 100). Density (0.1..1) gates
  // rect/bucket: each cell rolls density first, only paints if it wins.
  // Brush ignores density (every dragged cell stamps a fresh random pick).
  // Mutually exclusive with terrain / BigTile / Animated selection — enabling
  // any of those clears Randomize, and enabling Randomize clears those.
  const [randomMode, setRandomMode] = useState(false);
  // Random pool entries are EITHER a palette cell (c,r) or a BigTile (id).
  // Picking one at paint time places a random tile or a random BigTile.
  const [randomPool, setRandomPool] = useState<PoolEntry[]>([]);
  const [randomDensity, setRandomDensity] = useState(1);
  // When a terrain is selected, all paint tools dispatch to the auto-tile
  // algorithm (stamp defaultTile + re-evaluate neighbors). Picker leaves
  // terrain mode untouched — picking a tile snaps back to flat-tile painting.
  const [selectedTerrainId, setSelectedTerrainId] = useState<string | null>(null);
  // Brush transform applied when painting — packed byte: bit0 flipX, bit1
  // flipY, bits2-3 rotation (0-3 × 90° CW). Z rotates, X/Y flip.
  const [brushXf, setBrushXf] = useState(0);
  const [zoom, setZoom] = useState(1);
  // Palette (tile-picker) zoom. 1 = fit-to-sidebar; higher enlarges + scrolls so
  // fine tiles are pickable on big sheets. Separate from the map-canvas `zoom`.
  const [paletteZoom, setPaletteZoom] = useState(1);
  // Editor-only animation preview. Off = animated tiles freeze on frame 0 and
  // the 6fps redraw stops entirely — useful on big maps where the preview costs.
  const [previewAnim, setPreviewAnim] = useState(true);
  // Eraser footprint (N×N cells, centered on the cursor) — lets one stroke wipe
  // many big/animated placements + tiles at once.
  const [eraseSize, setEraseSize] = useState(1);
  const [sidebarWidth, setSidebarWidth] = useResizableWidth("peaky.tilemapTab.sidebarWidth", 320, 220, 600);
  // Live rect-tool overlay (start cell → current cell). Committed on mouse-up.
  const [rectDrag, setRectDrag] = useState<{ c0: number; r0: number; c1: number; r1: number } | null>(null);
  const dragging = useRef(false);
  // Last stamped (col, row) so brush drag doesn't restamp the same anchor on
  // every mousemove event (a 4×4 brush would otherwise touch 16 cells per
  // fired event, even when the cursor stays in the same cell).
  const lastStamp = useRef<{ col: number; row: number } | null>(null);
  /** BigTile/Animated stroke state — anchors the FOOTPRINT GRID at the stroke's
   *  first placement so drag-painting tiles composites side-by-side instead of
   *  overlap-deleting the previous stamp (placeBigTile destroys overlaps). */
  const bigStroke = useRef<{ oc: number; or: number; placed: Set<string> } | null>(null);
  /** Randomize-brush stroke: OCCUPIED cells of composites placed THIS stroke —
   *  overlapping candidates are skipped (mixed-size pools can't grid-snap).
   *  Honors the sparse `cells` mask, so trunk-only trees pack densely with
   *  overhanging canopies (the Y-sorted-forest brush). */
  const randStrokeCells = useRef<Set<string>>(new Set());

  // Ordered tileset list (primary + extras) with firstgids.
  const gidSlots = useMemo(() => (tilemap ? tilemapTilesets(tilemap, tilesets) : []), [tilemap, tilesets]);
  // Primary tileset defines the map CELL size (every layer shares one grid).
  const primaryTs = gidSlots[0]?.ts;
  // Active palette = the tileset the user is currently painting from. Resolve
  // the chosen id, falling back to the primary when it's missing / unset.
  const activeSlot = useMemo(
    () => gidSlots.find((s) => s.ts.id === activePaletteTsId) ?? gidSlots[0],
    [gidSlots, activePaletteTsId],
  );
  const tileset = activeSlot?.ts;
  const activeFirstgid = activeSlot?.firstgid ?? 0;
  // On-disk atlas resolved to a blob URL (or undefined while loading).
  const tilesetImageUrl = useTilesetURL(tileset);
  // Every slot's atlas, for the paint canvas (cells can come from any tileset).
  const slotPaths = useMemo(
    () => gidSlots.map((s) => (s.ts.imageFile ? tilesetImagePath(s.ts) : undefined)),
    [gidSlots],
  );
  const slotUrls = useAssetURLs(slotPaths);

  // Keyboard shortcuts: B/E/G/R/I switch tools. Gated on form-element focus
  // so typing in a layer name input still works normally. Document-level so
  // the canvas itself doesn't have to be focused.
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isFormTarget(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "b") setTool("brush");
      else if (k === "e") setTool("erase");
      else if (k === "g") setTool("bucket");
      else if (k === "r") setTool("rect");
      else if (k === "i") setTool("picker");
      // Brush transform: Z rotate 90° CW, X flip horizontal, Y flip vertical.
      else if (k === "z") setBrushXf((t) => (t & 0b0011) | ((((t >> 2) + 1) & 3) << 2));
      else if (k === "x") setBrushXf((t) => t ^ 0b0001);
      else if (k === "y") setBrushXf((t) => t ^ 0b0010);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Spacebar pan: hold Space + drag to grab-pan the canvas wrapper. Gated on
  // form focus so Space still types a literal space in a layer name field.
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
    };
    const prevCursor = document.body.style.cursor;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (isFormTarget(e.target)) return;
      if (e.repeat) return;
      e.preventDefault();
      setPanning(true);
      document.body.style.cursor = "grab";
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setPanning(false);
      panMouseDownRef.current = false;
      document.body.style.cursor = prevCursor;
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.body.style.cursor = prevCursor;
    };
  }, []);

  if (!tilemap) {
    return <div style={{ padding: 24, color: "var(--text-dim)" }}>Tilemap not found.</div>;
  }

  const cols = tilemap.cols;
  const rows = tilemap.rows;
  // Map cell size comes from the PRIMARY tileset — all layers share one grid,
  // regardless of which palette tileset is active.
  const tileW = primaryTs?.tileW ?? 32;
  const tileH = primaryTs?.tileH ?? 32;
  // Active layer auto-selects the first one if no choice is set or the
  // previous active was deleted. The painter writes into THIS layer's tiles.
  const activeLayer = tilemap.layers.find((L) => L.id === activeLayerId) ?? tilemap.layers[0];
  const activeId = activeLayer?.id ?? "";
  // Normalized selection rect — used for stamping and the palette outline.
  const selC0 = Math.min(selection.c0, selection.c1);
  const selR0 = Math.min(selection.r0, selection.r1);
  const selC1 = Math.max(selection.c0, selection.c1);
  const selR1 = Math.max(selection.r0, selection.r1);
  const selW = selC1 - selC0 + 1;
  const selH = selR1 - selR0 + 1;
  const tilesetCols = tileset?.cols ?? 0;
  const terrains: TerrainDef[] = tileset?.terrains ?? [];
  // Auto-tile reads/writes the layer's GLOBAL ids, so the active terrain's tile
  // references are shifted into global space by the active tileset's firstgid.
  const activeTerrainRaw = selectedTerrainId ? terrains.find((t) => t.id === selectedTerrainId) ?? null : null;
  const activeTerrain = activeTerrainRaw ? offsetTerrain(activeTerrainRaw, activeFirstgid) : null;

  /** Stamp the current brush selection at (col, row) — anchor at top-left.
   *  Cells that fall outside the map are dropped. One paintTiles call per
   *  stamp so history collapses a drag into a single bulk update. */
  const stampBrushAt = (col: number, row: number) => {
    if (tilesetCols <= 0 || !activeId) return;
    // Transform the selection as ONE block (mirror/rotate cell positions), then
    // apply brushXf to each tile — so a multi-cell brush flips/rotates as a unit.
    const { cells } = transformedSelection(selW, selH, brushXf);
    const edits: { col: number; row: number; tile: number }[] = [];
    for (const cell of cells) {
      const tCol = col + cell.ox;
      const tRow = row + cell.oy;
      if (tCol < 0 || tCol >= cols || tRow < 0 || tRow >= rows) continue;
      const tile = activeFirstgid + (selR0 + cell.sr) * tilesetCols + (selC0 + cell.sc);
      edits.push({ col: tCol, row: tRow, tile });
    }
    if (edits.length > 0) paintTiles(tilemap.id, activeId, edits, brushXf);
  };

  /** All BigTiles in the map's tilesets, by id (with their owning tileset for
   *  previews) — randomize pool BigTiles can come from any tileset the map
   *  paints with. */
  const allBigTiles = useMemo(
    () => new Map(gidSlots.flatMap((s) => (s.ts.bigTiles ?? []).map((b) => [b.id, { ts: s.ts, bt: b }] as const))),
    [gidSlots],
  );

  /** Weighted pick from the random pool. Returns the chosen entry (cell or
   *  BigTile), or null when empty. Each call is INDEPENDENT. */
  const pickRandomEntry = (): PoolEntry | null => {
    if (!randomMode || randomPool.length === 0) return null;
    const total = randomPool.reduce((s, p) => s + Math.max(0, p.weight), 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const p of randomPool) {
      roll -= Math.max(0, p.weight);
      if (roll <= 0) return p;
    }
    return randomPool[randomPool.length - 1];
  };

  /** Resolve a pool entry to a global tile id (cell entries only), or null. */
  const entryTile = (e: PoolEntry): number | null =>
    e.kind === "cell" && tilesetCols > 0 ? activeFirstgid + e.r * tilesetCols + e.c : null;

  /** Place a BigTile at (col,row), honoring its pivot like a manual placement.
   *  During a drag-stroke, stamps that would OVERLAP a composite already placed
   *  this stroke are skipped (random pools mix footprint sizes, so a fixed grid
   *  can't work here — overlap-tracking gives the same "no overlap-delete"
   *  guarantee while letting varied sizes pack naturally). */
  const placeRandomBigTile = (id: string, col: number, row: number) => {
    const entry = allBigTiles.get(id);
    if (!entry || !activeId) return;
    const bt = entry.bt;
    const px = bt.pivotX ?? 0.5;
    const py = bt.pivotY ?? 1;
    // Clamp the pivot-adjusted anchor into bounds so a bottom-pivoted door
    // dropped on row 0 doesn't anchor at a negative row (off-map / invisible).
    const anchorC = Math.max(0, Math.min(cols - bt.w, col - Math.min(bt.w - 1, Math.floor(px * bt.w))));
    const anchorR = Math.max(0, Math.min(rows - bt.h, row - Math.min(bt.h - 1, Math.floor(py * bt.h))));
    // Occupied cells honor the sparse mask (trunk-only) — full rect otherwise.
    const masked = bt.cells && bt.cells.length > 0 && bt.cells.length < bt.w * bt.h;
    const occ: string[] = [];
    if (masked) for (const cc of bt.cells!) occ.push(`${anchorC + cc.c},${anchorR + cc.r}`);
    else for (let dr = 0; dr < bt.h; dr++) for (let dc = 0; dc < bt.w; dc++) occ.push(`${anchorC + dc},${anchorR + dr}`);
    for (const k of occ) if (randStrokeCells.current.has(k)) return;
    for (const k of occ) randStrokeCells.current.add(k);
    placeBigTile(tilemap.id, activeId, id, anchorC, anchorR);
  };

  /** Stamp ONE cell with a randomly-picked pool entry (tile OR BigTile). Used
   *  by Brush+Random instead of the multi-cell stampBrushAt pattern. */
  const stampRandomAt = (col: number, row: number) => {
    if (!activeId) return;
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const e = pickRandomEntry();
    if (!e) return;
    if (e.kind === "bigtile") { placeRandomBigTile(e.id, col, row); return; }
    const tile = entryTile(e);
    if (tile === null) return;
    paintTiles(tilemap.id, activeId, [{ col, row, tile }], brushXf);
  };

  /** Bresenham line — every grid cell between (c0,r0) and (c1,r1) inclusive.
   *  Fast drags fire mousemove events sparsely (browsers throttle), so a
   *  one-shot "paint at the current cell" would leave gaps. Interpolating
   *  every cell on the line between the previous and current position closes
   *  those gaps so the brush stroke reads continuous regardless of drag speed. */
  const lineCells = (c0: number, r0: number, c1: number, r1: number): { col: number; row: number }[] => {
    const cells: { col: number; row: number }[] = [];
    const dc = Math.abs(c1 - c0), sc = c0 < c1 ? 1 : -1;
    const dr = Math.abs(r1 - r0), sr = r0 < r1 ? 1 : -1;
    let err = dc - dr;
    let c = c0, r = r0;
    // Guard against infinite loops if dc=dr=0 — single cell is added on first
    // iteration and the break condition catches it immediately.
    for (let safety = 0; safety < 100000; safety++) {
      cells.push({ col: c, row: r });
      if (c === c1 && r === r1) break;
      const e2 = 2 * err;
      if (e2 > -dr) { err -= dr; c += sc; }
      if (e2 < dc)  { err += dc; r += sr; }
    }
    return cells;
  };

  /** Place the selected BigTile (pivot-anchored) or Animated tile at one cell.
   *  Returns true if a composite was placed (so callers can skip tile paint).
   *
   *  Drag-painting: stamps snap to a FOOTPRINT GRID anchored at the stroke's
   *  first placement (bigStroke ref), so moving the mouse tiles composites
   *  side-by-side — without this, every stamp overlapped the previous one and
   *  placeBigTile's overlap rule deleted it (only the last stamp survived). */
  const placeBigOrAnimatedAt = (col: number, row: number): boolean => {
    if (!activeLayer) return false;
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    const stampSnapped = (anchorC: number, anchorR: number, w: number, h: number, place: (c: number, r: number) => void) => {
      if (!bigStroke.current) {
        bigStroke.current = { oc: anchorC, or: anchorR, placed: new Set([`${anchorC},${anchorR}`]) };
        place(anchorC, anchorR);
        return;
      }
      const s = bigStroke.current;
      const gc = Math.max(0, Math.min(cols - w, s.oc + Math.round((anchorC - s.oc) / w) * w));
      const gr = Math.max(0, Math.min(rows - h, s.or + Math.round((anchorR - s.or) / h) * h));
      const key = `${gc},${gr}`;
      if (s.placed.has(key)) return;
      s.placed.add(key);
      place(gc, gr);
    };
    if (selectedBigTileId) {
      const bt = (tileset?.bigTiles ?? []).find((b) => b.id === selectedBigTileId);
      if (bt) {
        const px = bt.pivotX ?? 0.5;
        const py = bt.pivotY ?? 1;
        const anchorC = Math.max(0, Math.min(cols - bt.w, col - Math.min(bt.w - 1, Math.floor(px * bt.w))));
        const anchorR = Math.max(0, Math.min(rows - bt.h, row - Math.min(bt.h - 1, Math.floor(py * bt.h))));
        stampSnapped(anchorC, anchorR, bt.w, bt.h, (c, r) => placeBigTile(tilemap.id, activeLayer.id, selectedBigTileId, c, r));
      }
      return true;
    }
    if (selectedAnimatedTileId) {
      const at = (tileset?.animatedTiles ?? []).find((a) => a.id === selectedAnimatedTileId);
      const reg = at && at.frames.length > 0 ? animFrameRegion(at.frames[0], tileset?.cols ?? 1) : { w: 1, h: 1 };
      stampSnapped(col, row, Math.max(1, reg.w), Math.max(1, reg.h), (c, r) => placeAnimatedTile(tilemap.id, activeLayer.id, selectedAnimatedTileId, c, r));
      return true;
    }
    return false;
  };

  /** Remove every BigTile / Animated placement under one cell (drag-erase). */
  const eraseBigAnimatedAt = (col: number, row: number) => {
    if (!activeLayer) return;
    for (const p of (activeLayer.animatedTilePlacements ?? []).filter((p) => p.c === col && p.r === row)) {
      removeAnimatedTilePlacement(tilemap.id, activeLayer.id, p.id);
    }
    for (const p of (activeLayer.bigTilePlacements ?? []).filter((p) => {
      const bt = allBigTiles.get(p.bigTileId)?.bt;
      return bt ? col >= p.c && col < p.c + bt.w && row >= p.r && row < p.r + bt.h : false;
    })) {
      removeBigTilePlacement(tilemap.id, activeLayer.id, p.id);
    }
  };

  const paintAt = (col: number, row: number) => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    if (!activeLayer) return;
    if (tool === "brush") {
      if (lastStamp.current && lastStamp.current.col === col && lastStamp.current.row === row) return;
      // Interpolate from the previous stamp to this one so fast drags don't
      // leave gaps. First stamp in a stroke has no prev → just paint here.
      const prev = lastStamp.current;
      lastStamp.current = { col, row };
      const cells = prev ? lineCells(prev.col, prev.row, col, row).slice(1) : [{ col, row }];
      if (selectedBigTileId || selectedAnimatedTileId) {
        // Stroke-paint composites — one placement per cell the brush crosses.
        for (const cell of cells) placeBigOrAnimatedAt(cell.col, cell.row);
        return;
      }
      if (activeTerrain) {
        // Auto-tile path — the working buffer accumulates each cell's edits so
        // a smooth drag's neighbor re-evaluations see prior stamps in the same
        // stroke. Without this, joining tiles on a fast diagonal would lag
        // one stamp behind the brush.
        const working = activeLayer.tiles.slice();
        const accum: { col: number; row: number; tile: number }[] = [];
        for (const cell of cells) {
          const edits = autoTileBrushEdits(working, cols, rows, cell.col, cell.row, activeTerrain);
          for (const e of edits) { working[e.row * cols + e.col] = e.tile; accum.push(e); }
        }
        if (accum.length > 0) paintTiles(tilemap.id, activeId, accum);
      } else if (randomMode && randomPool.length > 0) {
        // Brush + Randomize: each cell touched rolls its own random tile from
        // the pool. Drag-paint produces an evenly noisy scatter, not a streak.
        for (const cell of cells) stampRandomAt(cell.col, cell.row);
      } else {
        for (const cell of cells) stampBrushAt(cell.col, cell.row);
      }
    }
    if (tool === "erase") {
      if (lastStamp.current && lastStamp.current.col === col && lastStamp.current.row === row) return;
      const prev = lastStamp.current;
      lastStamp.current = { col, row };
      const stroke = prev ? lineCells(prev.col, prev.row, col, row).slice(1) : [{ col, row }];
      // Expand each stroke cell to the eraser's N×N footprint (centered), deduped.
      const half = Math.floor((eraseSize - 1) / 2);
      const seen = new Set<number>();
      const clipped: { col: number; row: number }[] = [];
      for (const s of stroke) {
        for (let dr = 0; dr < eraseSize; dr++) for (let dc = 0; dc < eraseSize; dc++) {
          const c = s.col + dc - half, r = s.row + dr - half;
          if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
          const k = r * cols + c;
          if (seen.has(k)) continue;
          seen.add(k);
          clipped.push({ col: c, row: r });
        }
      }
      // Drag-erase removes BigTile / Animated placements under the stroke too.
      for (const cell of clipped) eraseBigAnimatedAt(cell.col, cell.row);
      if (activeTerrain) {
        const working = activeLayer.tiles.slice();
        const accum: { col: number; row: number; tile: number }[] = [];
        for (const cell of clipped) {
          const edits = autoTileEraseEdits(working, cols, rows, cell.col, cell.row, activeTerrain);
          for (const e of edits) { working[e.row * cols + e.col] = e.tile; accum.push(e); }
        }
        if (accum.length > 0) paintTiles(tilemap.id, activeId, accum);
      } else {
        const edits = clipped.map((p) => ({ col: p.col, row: p.row, tile: -1 }));
        if (edits.length > 0) paintTiles(tilemap.id, activeId, edits);
      }
    }
    if (tool === "picker") {
      const t = activeLayer.tiles[row * cols + col] ?? -1;
      if (t < 0) return;
      // Resolve the global id to its owning tileset so the picker can switch
      // the active palette to it (you can sample a tile from ANY of the map's
      // tilesets and keep painting with it).
      const owner = gidSlots.find((s) => t >= s.firstgid && t < s.firstgid + s.count);
      if (!owner || owner.ts.cols <= 0) return;
      if (owner.ts.id !== (tileset?.id ?? "")) setActivePaletteTsId(owner.ts.id);
      const local = t - owner.firstgid;
      // If the picked tile belongs to a terrain in that tileset, switch INTO it
      // — sampling grass should give the user the grass terrain brush back.
      const owning = (owner.ts.terrains ?? []).find((tr) =>
        tr.defaultTile === local || tr.rules.some((rr) => rr.tile === local),
      );
      setSelectedTerrainId(owning ? owning.id : null);
      const c = local % owner.ts.cols;
      const r = (local - c) / owner.ts.cols;
      setSelection({ c0: c, r0: r, c1: c, r1: r });
      // Also adopt the picked cell's transform so re-stamping matches it.
      setBrushXf(activeLayer.xf?.[row * cols + col] ?? 0);
    }
  };

  const onCanvasDown = (col: number, row: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!activeLayer) return;
    // Erase tool wins over BigTile/Animated selection — having a Big/Animated
    // tile selected in the palette must not stop the user from erasing. Run
    // the erase branch FIRST so it removes placements or clears the cell
    // regardless of which palette item is currently highlighted.
    if (tool === "erase") {
      // Erase now flows through the drag machinery: paintAt() removes BigTile /
      // Animated placements AND clears tiles per cell, so a single click or a
      // drag-stroke both work (no more clicking each placement individually).
    } else if (selectedBigTileId || selectedAnimatedTileId) {
      // BigTile / Animated placement. Brush (stroke-paint) and Rect (area-fill)
      // flow through the drag machinery below; Bucket / Picker single-place.
      if (tool !== "brush" && tool !== "rect") {
        placeBigOrAnimatedAt(col, row);
        return;
      }
    }
    dragging.current = true;
    lastStamp.current = null;
    bigStroke.current = null;
    randStrokeCells.current = new Set();
    if (tool === "rect") {
      setRectDrag({ c0: col, r0: row, c1: col, r1: row });
      return;
    }
    if (tool === "bucket") {
      // Bucket uses ONLY the top-left tile of the brush selection — flood-fill
      // semantics + a multi-tile pattern would need a tiling fill which we
      // can revisit; v1 keeps it predictable. Always operates on the ACTIVE layer.
      // Terrain mode: floods with defaultTile then re-evaluates the filled
      // region + 1-cell rim so the auto-tile joins update at the boundary.
      const fill = activeTerrain
        ? activeTerrain.defaultTile
        : tilesetCols > 0 ? activeFirstgid + selR0 * tilesetCols + selC0 : 0;
      const target = activeLayer.tiles[row * cols + col] ?? -1;
      const randomBucket = randomMode && randomPool.length > 0 && !activeTerrain;
      // Random bucket flood-fills the connected region the same way but
      // doesn't gate on "fill === target" — we want to scatter onto the
      // region's existing tiles. Without this, a same-tile re-flood with
      // random would early-return and the user's first bucket-click on an
      // already-flooded area would no-op silently.
      if (!randomBucket && target === fill) return;
      // 4-way flood fill — iterative stack so big regions don't recurse.
      const stack: number[] = [col, row];
      const next = activeLayer.tiles.slice();
      // BigTile pool entries can't live in the tile array — collect them and
      // place after the flood commits.
      const bigDrops: { id: string; col: number; row: number }[] = [];
      const visited = new Set<number>();
      // `visited` doubles as the "filled cell" set in the terrain branch
      // below, so we add an entry ONLY when the cell actually got the fill —
      // the seen-and-skipped check uses the `target` mismatch implicitly.
      const filled = new Set<number>();
      while (stack.length > 0) {
        const r = stack.pop()!;
        const c = stack.pop()!;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const i = r * cols + c;
        if (visited.has(i)) continue;
        visited.add(i);
        if ((next[i] ?? -1) !== target) continue;
        if (randomBucket) {
          // Roll density per cell; on win, pick a weighted random entry.
          // On loss, leave the cell unchanged (preserve existing).
          if (Math.random() < randomDensity) {
            const e = pickRandomEntry();
            if (e) {
              if (e.kind === "bigtile") bigDrops.push({ id: e.id, col: c, row: r });
              else { const tile = entryTile(e); if (tile !== null) next[i] = tile; }
            }
          }
        } else {
          next[i] = fill;
        }
        filled.add(i);
        stack.push(c + 1, r); stack.push(c - 1, r);
        stack.push(c, r + 1); stack.push(c, r - 1);
      }
      if (activeTerrain) {
        // Re-evaluate every flooded cell AND each one's 8 neighbors so the
        // boundary joins with whatever was outside the flood. `next` already
        // holds the stamped defaultTile, so the mask computation sees the
        // newly-filled region as same-terrain.
        const ownership = buildTerrainOwnership(activeTerrain);
        ownership.add(activeTerrain.defaultTile);
        const isOwned = (t: number) => ownership.has(t);
        const reEval = new Set<number>(filled);
        for (const i of filled) {
          const c = i % cols, r = (i - c) / cols;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const tc = c + dc, tr = r + dr;
            if (tc < 0 || tc >= cols || tr < 0 || tr >= rows) continue;
            reEval.add(tr * cols + tc);
          }
        }
        for (const i of reEval) {
          if (!isOwned(next[i])) continue;
          const c = i % cols, r = (i - c) / cols;
          next[i] = tileForMaskOrFallback(activeTerrain, next, cols, rows, c, r, isOwned);
        }
        const edits: { col: number; row: number; tile: number }[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (next[i] !== activeLayer.tiles[i]) edits.push({ col: c, row: r, tile: next[i] });
          }
        }
        if (edits.length > 0) paintTiles(tilemap.id, activeId, edits);
      } else {
        const edits: { col: number; row: number; tile: number }[] = [];
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (next[i] !== activeLayer.tiles[i]) edits.push({ col: c, row: r, tile: next[i] });
          }
        }
        if (edits.length > 0) paintTiles(tilemap.id, activeId, edits, brushXf);
      }
      for (const d of bigDrops) placeRandomBigTile(d.id, d.col, d.row);
      return;
    }
    paintAt(col, row);
  };
  const onCanvasMove = (col: number, row: number) => {
    if (!dragging.current) return;
    if (tool === "rect") {
      setRectDrag((d) => d ? { ...d, c1: col, r1: row } : d);
      return;
    }
    paintAt(col, row);
  };
  const onCanvasUp = () => {
    if (tool === "rect" && rectDrag) {
      const cMin0 = Math.min(rectDrag.c0, rectDrag.c1), cMax0 = Math.max(rectDrag.c0, rectDrag.c1);
      const rMin0 = Math.min(rectDrag.r0, rectDrag.r1), rMax0 = Math.max(rectDrag.r0, rectDrag.r1);
      if ((selectedBigTileId || selectedAnimatedTileId) && activeId) {
        if (selectedBigTileId) {
          // Tile the BigTile by its footprint so an area fill lays a clean grid
          // of composites instead of stacking one per cell.
          const bt = (tileset?.bigTiles ?? []).find((b) => b.id === selectedBigTileId);
          const stepC = Math.max(1, bt?.w ?? 1), stepR = Math.max(1, bt?.h ?? 1);
          for (let r = rMin0; r + stepR - 1 <= rMax0; r += stepR) {
            for (let c = cMin0; c + stepC - 1 <= cMax0; c += stepC) {
              placeBigTile(tilemap.id, activeId, selectedBigTileId, c, r);
            }
          }
        } else if (selectedAnimatedTileId) {
          for (let r = rMin0; r <= rMax0; r++) {
            for (let c = cMin0; c <= cMax0; c++) {
              placeAnimatedTile(tilemap.id, activeId, selectedAnimatedTileId, c, r);
            }
          }
        }
        setRectDrag(null);
        dragging.current = false;
        lastStamp.current = null;
        bigStroke.current = null;
        randStrokeCells.current = new Set();
        return;
      }
      if (activeTerrain && activeLayer) {
        const edits = autoTileRectEdits(
          activeLayer.tiles, cols, rows,
          rectDrag.c0, rectDrag.r0, rectDrag.c1, rectDrag.r1,
          activeTerrain,
        );
        if (edits.length > 0 && activeId) paintTiles(tilemap.id, activeId, edits);
      } else if (randomMode && randomPool.length > 0) {
        // Rect + Randomize: each cell in the rect rolls density first; on
        // win it picks a weighted random tile from the pool. Lost rolls
        // SKIP the cell entirely — existing tile (if any) is preserved.
        const cMin = Math.min(rectDrag.c0, rectDrag.c1);
        const cMax = Math.max(rectDrag.c0, rectDrag.c1);
        const rMin = Math.min(rectDrag.r0, rectDrag.r1);
        const rMax = Math.max(rectDrag.r0, rectDrag.r1);
        const edits: { col: number; row: number; tile: number }[] = [];
        const bigDrops: { id: string; col: number; row: number }[] = [];
        for (let r = rMin; r <= rMax; r++) for (let c = cMin; c <= cMax; c++) {
          if (Math.random() >= randomDensity) continue;
          const e = pickRandomEntry();
          if (!e) continue;
          if (e.kind === "bigtile") { bigDrops.push({ id: e.id, col: c, row: r }); continue; }
          const tile = entryTile(e);
          if (tile !== null) edits.push({ col: c, row: r, tile });
        }
        if (edits.length > 0 && activeId) paintTiles(tilemap.id, activeId, edits, brushXf);
        for (const d of bigDrops) placeRandomBigTile(d.id, d.col, d.row);
      } else {
        // Tile the brush selection across the rect — a 2×2 brush over a 6×4
        // rect lays a repeating 2×2 pattern. The selection is transformed as a
        // block first (so flip/rotate tile the mirrored/rotated pattern), then
        // wrapped via modulo. A single-cell brush keeps the legacy solid fill.
        const cMin = Math.min(rectDrag.c0, rectDrag.c1);
        const cMax = Math.max(rectDrag.c0, rectDrag.c1);
        const rMin = Math.min(rectDrag.r0, rectDrag.r1);
        const rMax = Math.max(rectDrag.r0, rectDrag.r1);
        const edits: { col: number; row: number; tile: number }[] = [];
        if (tilesetCols > 0) {
          const { outW, outH, cells } = transformedSelection(selW, selH, brushXf);
          const srcAt = new Array<{ sc: number; sr: number }>(outW * outH);
          for (const cell of cells) srcAt[cell.oy * outW + cell.ox] = { sc: cell.sc, sr: cell.sr };
          for (let r = rMin; r <= rMax; r++) for (let c = cMin; c <= cMax; c++) {
            const dc = (c - cMin) % outW;
            const dr = (r - rMin) % outH;
            const src = srcAt[dr * outW + dc];
            if (!src) continue;
            const tile = activeFirstgid + (selR0 + src.sr) * tilesetCols + (selC0 + src.sc);
            edits.push({ col: c, row: r, tile });
          }
        }
        if (edits.length > 0 && activeId) paintTiles(tilemap.id, activeId, edits, brushXf);
      }
      setRectDrag(null);
    }
    dragging.current = false;
    lastStamp.current = null;
    bigStroke.current = null;
    randStrokeCells.current = new Set();
  };

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Settings + palette sidebar ─────────────────────────────── */}
      <div style={{
        width: sidebarWidth, flexShrink: 0, padding: 12,
        background: "var(--panel-2)", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", gap: 10, overflow: "auto",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Name</span>
          {renamingTilemap ? (
            <input
              autoFocus
              value={tilemapNameBuffer}
              onChange={(e) => setTilemapNameBuffer(e.target.value)}
              onBlur={() => {
                const next = tilemapNameBuffer.trim();
                if (next && next !== tilemap.name) renameTilemap(tilemap.id, next);
                setRenamingTilemap(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                else if (e.key === "Escape") { setRenamingTilemap(false); e.stopPropagation(); }
              }}
              style={INP}
            />
          ) : (
            <span
              onDoubleClick={() => { setTilemapNameBuffer(tilemap.name); setRenamingTilemap(true); }}
              title="Double-click to rename"
              style={{ ...INP, display: "inline-block", cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >{tilemap.name}</span>
          )}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Tileset</span>
          <select
            value={tilemap.tilesetId}
            onChange={(e) => {
              const next = e.target.value;
              // Tileset switches reinterpret every painted tile index against
              // the new tileset's grid AND orphan every BigTile / Animated
              // placement (their ids point at defs that won't exist in the
              // new tileset). Warn before nuking the user's work.
              const hasPaint = tilemap.layers.some((L) => L.tiles.some((t) => t >= 0));
              const hasBigPlacements = tilemap.layers.some((L) => (L.bigTilePlacements?.length ?? 0) > 0);
              const hasAnimPlacements = tilemap.layers.some((L) => (L.animatedTilePlacements?.length ?? 0) > 0);
              if (hasPaint || hasBigPlacements || hasAnimPlacements) {
                const parts: string[] = [];
                if (hasPaint) parts.push("painted tiles");
                if (hasBigPlacements) parts.push("BigTile placements");
                if (hasAnimPlacements) parts.push("animated-tile placements");
                const ok = window.confirm(
                  `Switching tilesets will reinterpret ${parts.join(" + ")} against the new tileset. BigTile / animated placements may become orphaned. Continue?`,
                );
                // Controlled select: skipping setTilemapTileset means React
                // re-renders with the original value and the dropdown snaps
                // back on its own — no DOM mutation needed.
                if (!ok) return;
              }
              setTilemapTileset(tilemap.id, next);
            }}
            style={INP}
          >
            <option value="">(pick a tileset)</option>
            {tilesets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>

        {/* Multi-tileset: tabs for every tileset the map paints from, plus an
            "Add" picker. The active tab drives the palette + what new strokes
            stamp from (cells store GLOBAL ids resolved by firstgid). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Palette ({gidSlots.length})</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {gidSlots.map((s, i) => {
              const isActive = s.ts.id === (tileset?.id ?? "");
              const isPrimary = i === 0;
              return (
                <span
                  key={s.ts.id}
                  onClick={() => setActivePaletteTsId(s.ts.id)}
                  title={isPrimary ? "Primary tileset (cell size)" : "Extra tileset"}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 6px", borderRadius: 4, cursor: "pointer", fontSize: 11,
                    background: isActive ? "var(--accent)" : "var(--panel-3)",
                    color: isActive ? "#fff" : "var(--text)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {isPrimary ? "★ " : ""}{s.ts.name}
                  {!isPrimary && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const hasPaint = tilemap.layers.some((L) => L.tiles.some((t) => t >= s.firstgid));
                        if (hasPaint && !window.confirm(
                          `Remove "${s.ts.name}"? Cells painted from it (and from any tileset added after it) will be cleared.`,
                        )) return;
                        if (activePaletteTsId === s.ts.id) setActivePaletteTsId(null);
                        removeTilemapTileset(tilemap.id, s.ts.id);
                      }}
                      title="Remove tileset from this map"
                      style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: 13 }}
                    >×</button>
                  )}
                </span>
              );
            })}
          </div>
          <select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              addTilemapTileset(tilemap.id, id);
              setActivePaletteTsId(id);
            }}
            style={{ ...INP, fontSize: 11 }}
          >
            <option value="">+ Add tileset…</option>
            {tilesets
              .filter((t) => t.id !== tilemap.tilesetId && !(tilemap.extraTilesetIds ?? []).includes(t.id))
              .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL} title="Tags merged into every layer of this tilemap. VisionMask excludeTags reads them — tag the whole map 'bg' once instead of tagging each layer.">Tags (whole tilemap)</span>
          <input
            type="text"
            placeholder="bg, decor…"
            value={(tilemap.tags ?? []).join(", ")}
            onChange={(e) => {
              const next = e.target.value.split(",").map((t) => t.trim()).filter(Boolean);
              setTilemapTags(tilemap.id, next);
            }}
            style={INP}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <NumField label="Cols" value={cols} min={1} onChange={(n) => resizeTilemap(tilemap.id, Math.max(1, n), rows)} />
          <NumField label="Rows" value={rows} min={1} onChange={(n) => resizeTilemap(tilemap.id, cols, Math.max(1, n))} />
        </div>

        {/* Layers — stacked grids inside this tilemap. Active layer (yellow row)
            is what the painter writes into. Higher z draws on top; the list
            is sorted descending so visually "top of list" = "on top in scene". */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={LBL}>Layers</span>
            <button
              onClick={() => { const lid = addTilemapLayer(tilemap.id); setActiveLayerId(lid); }}
              title="Add a new (empty) layer on top"
              style={{ fontSize: 14, lineHeight: 1, padding: "0 6px", cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" }}
            >+</button>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            {[...tilemap.layers].sort((a, b) => b.z - a.z).map((L) => {
              const isActive = L.id === activeId;
              return (
                <div
                  key={L.id}
                  onClick={() => setActiveLayerId(L.id)}
                  onDragOver={(e) => { if (dragLayerId.current) { e.preventDefault(); setDragOverLayerId(L.id); } }}
                  onDragLeave={() => { if (dragOverLayerId === L.id) setDragOverLayerId(null); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverLayerId(null);
                    const from = dragLayerId.current;
                    dragLayerId.current = null;
                    if (!from || from === L.id) return;
                    // Target index in ASC-z order = where the row sits bottom-up.
                    const asc = [...tilemap.layers].sort((a, b) => a.z - b.z);
                    const to = asc.findIndex((x) => x.id === L.id);
                    if (to >= 0) moveTilemapLayerTo(tilemap.id, from, to);
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 3, padding: "3px 4px",
                    background: dragOverLayerId === L.id ? "rgba(90,190,255,0.18)" : isActive ? "rgba(255,210,60,0.22)" : "transparent",
                    borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
                    borderBottom: dragOverLayerId === L.id ? "1px solid rgba(90,190,255,0.8)" : "1px solid var(--border)",
                    cursor: "pointer",
                  }}
                >
                  <span
                    draggable
                    onDragStart={(e) => {
                      dragLayerId.current = L.id;
                      e.dataTransfer.effectAllowed = "move";
                      // Some browsers need data set for the drag to start.
                      e.dataTransfer.setData("text/plain", L.id);
                    }}
                    onDragEnd={() => { dragLayerId.current = null; setDragOverLayerId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to reorder"
                    style={{ cursor: "grab", color: "var(--text-dim)", fontSize: 10, padding: "0 2px", userSelect: "none", flex: "0 0 auto" }}
                  >⠿</span>
                  <Toggle
                    value={L.visible}
                    onChange={(v) => updateTilemapLayer(tilemap.id, L.id, { visible: v })}
                    onClick={(e) => e.stopPropagation()}
                    title="Visibility"
                    style={{ width: "auto", margin: 0 }}
                  />
                  {renamingLayerId === L.id ? (
                    <input
                      type="text"
                      autoFocus
                      value={renameBuffer}
                      onChange={(e) => setRenameBuffer(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        const next = renameBuffer.trim();
                        if (next && next !== L.name) renameTilemapLayer(tilemap.id, L.id, next);
                        setRenamingLayerId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        else if (e.key === "Escape") { setRenamingLayerId(null); e.stopPropagation(); }
                      }}
                      style={{ flex: 1, fontSize: 11, background: "var(--inner)", border: "1px solid var(--accent)", borderRadius: 2, color: "var(--text)", outline: "none", padding: "1px 4px", fontWeight: isActive ? 700 : 400 }}
                    />
                  ) : (
                    <span
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenameBuffer(L.name);
                        setRenamingLayerId(L.id);
                      }}
                      title="Double-click to rename"
                      style={{ flex: 1, fontSize: 11, color: "var(--text)", padding: "1px 0", fontWeight: isActive ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "text" }}
                    >{L.name}</span>
                  )}
                  <span style={{ fontSize: 9, color: "var(--text-dim)", marginRight: 2 }}>z{L.z}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); reorderTilemapLayer(tilemap.id, L.id, +1); }}
                    title="Move up (higher z)"
                    style={LAYER_BTN}
                  >▲</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); reorderTilemapLayer(tilemap.id, L.id, -1); }}
                    title="Move down (lower z)"
                    style={LAYER_BTN}
                  >▼</button>
                  {tilemap.layers.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const ok = window.confirm(
                          `Delete layer '${L.name}'? Painted tiles on this layer will be lost.`,
                        );
                        if (ok) removeTilemapLayer(tilemap.id, L.id);
                      }}
                      title="Delete layer"
                      style={{ ...LAYER_BTN, color: "var(--orange)" }}
                    >×</button>
                  )}
                </div>
              );
            })}
          </div>
          {activeLayer && (
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", fontSize: 10, color: "var(--text-2)", paddingTop: 2 }}>
              <span>Alpha</span>
              <input
                type="range" min={0} max={1} step={0.05}
                value={activeLayer.alpha}
                onChange={(e) => updateTilemapLayer(tilemap.id, activeLayer.id, { alpha: Number(e.target.value) })}
              />
              <span title="When off, even tileset-solid tiles on this layer don't block movement.">Solid</span>
              <Toggle
                value={activeLayer.collides}
                onChange={(v) => updateTilemapLayer(tilemap.id, activeLayer.id, { collides: v })}
                style={{ width: "auto", justifySelf: "start" }}
              />
              <span title="Per-cell Y-sort for THIS layer (player walks behind its tiles). Only active when the SCENE layer is also Y-sort. Expensive on big fills — enable only on sparse foliage/object layers; leave water/grass OFF.">Y-sort</span>
              <Toggle
                value={activeLayer.ySort === true}
                onChange={(v) => updateTilemapLayer(tilemap.id, activeLayer.id, { ySort: v })}
                style={{ width: "auto", justifySelf: "start" }}
              />
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Tool</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            <ToolBtn label="Brush"   title="Brush (B)"   active={tool === "brush"}  onClick={() => setTool("brush")}  />
            <ToolBtn label="Erase"   title="Erase (E)"   active={tool === "erase"}  onClick={() => setTool("erase")}  />
            <ToolBtn label="Bucket"  title="Bucket (G)"  active={tool === "bucket"} onClick={() => setTool("bucket")} />
            <ToolBtn label="Rect"    title="Rect (R)"    active={tool === "rect"}   onClick={() => setTool("rect")}   />
            <ToolBtn label="Picker"  title="Picker (I)"  active={tool === "picker"} onClick={() => setTool("picker")} />
          </div>
          {tool === "erase" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Size</span>
              {[1, 2, 3, 4, 6, 8].map((s) => (
                <button key={s} onClick={() => setEraseSize(s)}
                  style={{ flex: 1, fontSize: 10, padding: "2px 0", cursor: "pointer", borderRadius: 2,
                    background: eraseSize === s ? "var(--accent, #3a7afe)" : "rgba(255,255,255,0.06)",
                    color: eraseSize === s ? "#fff" : "var(--text-2)", border: "1px solid var(--border)" }}>{s}</button>
              ))}
            </div>
          )}
        </div>

        {/* Brush transform — rotate/flip the stamp BEFORE painting. Visual only;
            collision & mining still read the upright tile index. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Transform</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
            <ToolBtn label="↻ 90°" title="Rotate 90° CW (Z)" active={((brushXf >> 2) & 3) !== 0}
              onClick={() => setBrushXf((t) => (t & 0b0011) | ((((t >> 2) + 1) & 3) << 2))} />
            <ToolBtn label="⇄ H" title="Flip horizontal (X)" active={!!(brushXf & 1)}
              onClick={() => setBrushXf((t) => t ^ 0b0001)} />
            <ToolBtn label="⇅ V" title="Flip vertical (Y)" active={!!(brushXf & 2)}
              onClick={() => setBrushXf((t) => t ^ 0b0010)} />
          </div>
          {brushXf !== 0 && (
            <button
              onClick={() => setBrushXf(0)}
              style={{ fontSize: 10, padding: "2px 4px", background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" }}
            >
              reset ({((brushXf >> 2) & 3) * 90}°{brushXf & 1 ? " ↔" : ""}{brushXf & 2 ? " ↕" : ""})
            </button>
          )}
        </div>

        {/* Randomize — when on, brush/rect/bucket draw from a weighted pool of
            tiles. Mutually exclusive with terrain auto-tile mode (clearing each
            other on enable). Pool entries are added by single-clicking palette
            tiles while Randomize is on. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
            <Toggle
              value={randomMode}
              onChange={(v) => {
                const on = v;
                setRandomMode(on);
                // Mutual exclusion — enabling Random clears Terrain/Big/Animated
                // selections so the paint dispatch is unambiguous.
                if (on) {
                  setSelectedTerrainId(null);
                  setSelectedBigTileId(null);
                  setSelectedAnimatedTileId(null);
                }
              }}
              style={{ margin: 0 }}
            />
            <span style={{ ...LBL, margin: 0 }}>🎲 Randomize</span>
          </label>
          {randomMode && (
            <>
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                Click tiles in the palette to add/remove, or add BigTiles below. Weights are relative.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {randomPool.length === 0 ? (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
                    Pool is empty — click a palette tile or add a BigTile.
                  </span>
                ) : (
                  randomPool.map((p, i) => {
                    const label = p.kind === "bigtile" ? "▦ " + (p.id.slice(0, 5)) : "#" + (p.r * Math.max(1, tilesetCols) + p.c);
                    return (
                      <div key={p.kind === "bigtile" ? "bt:" + p.id : "c:" + p.c + "," + p.r} style={{ display: "grid", gridTemplateColumns: "auto 1fr 38px 18px", gap: 4, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: p.kind === "bigtile" ? "var(--accent, #3a7afe)" : "var(--text-dim)", minWidth: 24 }}>{label}</span>
                        <input
                          type="range" min={1} max={100} step={1}
                          value={p.weight}
                          onChange={(e) => {
                            const w = Math.max(1, Math.min(100, Number(e.target.value)));
                            setRandomPool((prev) => prev.map((x, j) => (j === i ? { ...x, weight: w } : x)));
                          }}
                          title={`Weight ${p.weight}`}
                        />
                        <input
                          type="number" min={1} max={100} step={1}
                          value={p.weight}
                          onChange={(e) => {
                            const w = Math.max(1, Math.min(100, Math.floor(Number(e.target.value)) || 1));
                            setRandomPool((prev) => prev.map((x, j) => (j === i ? { ...x, weight: w } : x)));
                          }}
                          style={{ fontSize: 10, padding: "1px 2px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 2, color: "var(--text)", width: "100%" }}
                        />
                        <button
                          onClick={() => setRandomPool((prev) => prev.filter((_, j) => j !== i))}
                          title="Remove from pool"
                          style={{ fontSize: 11, padding: "0 4px", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: "var(--orange)" }}
                        >×</button>
                      </div>
                    );
                  })
                )}
              </div>
              {allBigTiles.size > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Add BigTile to pool:</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {[...allBigTiles.values()].map(({ ts: bts, bt }) => {
                      const inPool = randomPool.some((p) => p.kind === "bigtile" && p.id === bt.id);
                      return (
                        <button
                          key={bt.id}
                          onClick={() => setRandomPool((prev) => inPool
                            ? prev.filter((p) => !(p.kind === "bigtile" && p.id === bt.id))
                            : [...prev, { kind: "bigtile", id: bt.id, weight: 50 }])}
                          title={inPool ? "Remove from pool" : "Add to pool"}
                          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: 2, cursor: "pointer", background: inPool ? "var(--accent, #3a7afe)" : "var(--inner)", border: "1px solid var(--border)", borderRadius: 3 }}
                        >
                          <BigTilePreview ts={bts} bt={bt} maxPx={36} />
                          <span style={{ fontSize: 9, color: inPool ? "#fff" : "var(--text-dim)" }}>{bt.w}×{bt.h}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {(tool === "rect" || tool === "bucket") && (
                <label style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    Density: {Math.round(randomDensity * 100)}% ({tool === "rect" ? "rect" : "bucket"} cells filled)
                  </span>
                  <input
                    type="range" min={0.1} max={1} step={0.05}
                    value={randomDensity}
                    onChange={(e) => setRandomDensity(Number(e.target.value))}
                    title="1.0 = every cell painted. 0.1 = ~10% of cells, sparse scatter."
                  />
                </label>
              )}
            </>
          )}
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Zoom ({Math.round(zoom * 100)}%)</span>
          <input type="range" min={0.25} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)", cursor: "pointer" }} title="Preview animated tiles cycling. Turn OFF on big maps — frames freeze on frame 0 and the 6fps redraw stops.">
          <input type="checkbox" checked={previewAnim} onChange={(e) => setPreviewAnim(e.target.checked)} />
          Animate preview
        </label>

        {/* Terrains — auto-tile palette (Unity Rule Tile / Godot terrain style).
            Picking a terrain switches brush/erase/bucket/rect to auto-tile
            mode; "None" returns to plain tile painting. Configured in the
            Tileset tab (47 slot cards per terrain). */}
        {/* BigTile palette — pick a multi-cell composite to place. When a BigTile
            is selected, single-click on the canvas places ONE placement (the
            whole tree/building) at the clicked anchor cell. */}
        {tileset && (tileset.bigTiles ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <span style={LBL}>Big tiles</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <button
                onClick={() => setSelectedBigTileId(null)}
                title="Paint regular tiles"
                style={{
                  fontSize: 10, padding: "3px 7px", cursor: "pointer",
                  background: !selectedBigTileId ? "var(--accent)" : "var(--inner)",
                  color: !selectedBigTileId ? "var(--on-accent)" : "var(--text)",
                  border: `1px solid ${!selectedBigTileId ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 3,
                }}
              >None</button>
              {(tileset.bigTiles ?? []).map((bt) => {
                const isActive = bt.id === selectedBigTileId;
                return (
                  <button
                    key={bt.id}
                    onClick={() => { setSelectedBigTileId(bt.id); setSelectedAnimatedTileId(null); setRandomMode(false); }}
                    title={`Place this ${bt.w}×${bt.h} composite as one unit`}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                      fontSize: 9, padding: "3px", cursor: "pointer",
                      background: isActive ? "var(--accent)" : "var(--inner)",
                      color: isActive ? "var(--on-accent)" : "var(--text)",
                      border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 3,
                    }}
                  >
                    <BigTilePreview ts={tileset} bt={bt} maxPx={44} />
                    <span>{bt.w}×{bt.h}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {tileset && (tileset.animatedTiles ?? []).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <span style={LBL}>Animated tiles</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <button
                onClick={() => setSelectedAnimatedTileId(null)}
                title="Paint regular tiles"
                style={{
                  fontSize: 10, padding: "3px 7px", cursor: "pointer",
                  background: !selectedAnimatedTileId ? "var(--accent)" : "var(--inner)",
                  color: !selectedAnimatedTileId ? "var(--on-accent)" : "var(--text)",
                  border: `1px solid ${!selectedAnimatedTileId ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 3,
                }}
              >None</button>
              {(tileset.animatedTiles ?? []).map((at) => {
                const isActive = at.id === selectedAnimatedTileId;
                return (
                  <AnimatedTilePaletteButton
                    key={at.id}
                    ts={tileset}
                    at={at}
                    active={isActive}
                    onPick={() => { setSelectedAnimatedTileId(at.id); setSelectedBigTileId(null); setRandomMode(false); }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {tileset && terrains.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <span style={LBL}>Terrain</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              <button
                onClick={() => setSelectedTerrainId(null)}
                title="Paint individual tiles from the palette below"
                style={{
                  fontSize: 10, padding: "3px 7px", cursor: "pointer",
                  background: !activeTerrain ? "var(--accent)" : "var(--inner)",
                  color: !activeTerrain ? "var(--on-accent)" : "var(--text)",
                  border: `1px solid ${!activeTerrain ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 3,
                }}
              >None</button>
              {terrains.map((tr) => {
                const isActive = tr.id === activeTerrain?.id;
                const swatch = "#" + tr.color.toString(16).padStart(6, "0");
                return (
                  <button
                    key={tr.id}
                    onClick={() => { setSelectedTerrainId(tr.id); setRandomMode(false); }}
                    title={`Auto-tile: ${tr.name}`}
                    style={{
                      fontSize: 10, padding: "3px 7px", cursor: "pointer",
                      display: "flex", alignItems: "center", gap: 4,
                      background: isActive ? "var(--accent)" : "var(--inner)",
                      color: isActive ? "var(--on-accent)" : "var(--text)",
                      border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 3,
                    }}
                  >
                    <span style={{ width: 10, height: 10, background: swatch, borderRadius: 2, border: "1px solid rgba(0,0,0,0.4)" }} />
                    {tr.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Palette — tiles from the chosen tileset. Click for a single tile;
            DRAG to select a multi-tile group (brush stamps the whole group). */}
        {tileset && tilesetImageUrl && tileset.cols > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ ...LBL, flex: 1 }}>Palette (click or drag)</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{Math.round(paletteZoom * 100)}%</span>
              {(() => {
                const zbtn: React.CSSProperties = { padding: "1px 7px", fontSize: 12, background: "var(--inner)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 3, cursor: "pointer" };
                return (<>
                  <button onClick={() => setPaletteZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} style={zbtn}>−</button>
                  <button onClick={() => setPaletteZoom((z) => Math.min(8, +(z + 0.25).toFixed(2)))} style={zbtn}>+</button>
                  <button onClick={() => setPaletteZoom(1)} title="Fit to sidebar" style={{ ...zbtn, fontSize: 10 }}>fit</button>
                </>);
              })()}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {selW === 1 && selH === 1
                ? `Brush: tile ${activeFirstgid + selR0 * tilesetCols + selC0}`
                : `Brush: ${selW}×${selH} tiles`}
            </div>
            <Palette
              zoom={paletteZoom}
              image={tilesetImageUrl}
              sheetW={tileset.sheetW}
              sheetH={tileset.sheetH}
              cols={tileset.cols}
              rows={tileset.rows}
              tileW={tileset.tileW}
              tileH={tileset.tileH}
              offsetX={tileset.offsetX}
              offsetY={tileset.offsetY}
              spacingX={tileset.spacingX}
              spacingY={tileset.spacingY}
              selection={selection}
              onSelectionChange={(sel) => { setSelection(sel); setSelectedBigTileId(null); setSelectedAnimatedTileId(null); }}
              poolMembers={randomMode ? randomPool.filter((p): p is Extract<PoolEntry, { kind: "cell" }> => p.kind === "cell") : null}
              onPoolToggle={randomMode
                ? (c, r) => setRandomPool((prev) =>
                    prev.some((p) => p.kind === "cell" && p.c === c && p.r === r)
                      ? prev.filter((p) => !(p.kind === "cell" && p.c === c && p.r === r))
                      : [...prev, { kind: "cell", c, r, weight: 50 }]
                  )
                : undefined}
            />
          </div>
        )}
      </div>

      <SidebarResizeHandle width={sidebarWidth} onChange={setSidebarWidth} min={220} max={600} />

      {/* ── Paint canvas ───────────────────────────────────────────── */}
      {/* Slightly darker than --bg so the canvas edge reads clearly even
          when most tiles are dark — the previous flush-to-bg surround was
          impossible to tell apart from the canvas. */}
      <div
        ref={canvasWrapRef}
        style={{ flex: 1, padding: 16, overflow: "auto", background: "#0d0e12", position: "relative", cursor: panning ? "grab" : undefined }}
        onWheel={(e) => {
          // Ctrl+wheel = cursor-anchored zoom. Without Ctrl the event passes
          // through so normal scroll still works.
          if (!e.ctrlKey) return;
          e.preventDefault();
          const wrap = canvasWrapRef.current;
          if (!wrap) return;
          const rect = wrap.getBoundingClientRect();
          // Cursor position inside the scrollable wrapper (including current scroll).
          const cx = e.clientX - rect.left + wrap.scrollLeft;
          const cy = e.clientY - rect.top + wrap.scrollTop;
          // World cell the cursor is over BEFORE the zoom change. (cx - 16) /
          // tileW/zoom accounts for the 16px padding of the wrapper.
          const worldX = (cx - 16) / zoom;
          const worldY = (cy - 16) / zoom;
          const next = Math.max(0.25, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
          setZoom(next);
          // After React applies the new zoom, re-scroll so the same world
          // point sits under the cursor again. rAF so the layout settles.
          requestAnimationFrame(() => {
            const w = canvasWrapRef.current;
            if (!w) return;
            const targetX = worldX * next + 16 - (e.clientX - rect.left);
            const targetY = worldY * next + 16 - (e.clientY - rect.top);
            w.scrollLeft = targetX;
            w.scrollTop = targetY;
          });
        }}
        onMouseDown={(e) => {
          if (!panning) return;
          // Block the underlying canvas paint while pan is active.
          e.preventDefault();
          e.stopPropagation();
          panMouseDownRef.current = true;
          document.body.style.cursor = "grabbing";
        }}
        onMouseMove={(e) => {
          if (!panning || !panMouseDownRef.current) return;
          const w = canvasWrapRef.current;
          if (!w) return;
          w.scrollLeft -= e.movementX;
          w.scrollTop -= e.movementY;
        }}
        onMouseUp={() => {
          if (!panning) return;
          panMouseDownRef.current = false;
          document.body.style.cursor = "grab";
        }}
        onMouseLeave={() => { panMouseDownRef.current = false; }}
      >
        {/* Floating "Painting:" chip — always visible while a layer is active
            so the user never has to scan the sidebar to confirm which layer
            their paint strokes are landing on. */}
        {activeLayer && tileset && (
          <div style={{
            position: "absolute", top: 8, left: 8, zIndex: 5,
            background: "var(--inner)", border: "1px solid var(--border)",
            color: "var(--text)", fontSize: 11, padding: "4px 8px",
            borderRadius: 4, pointerEvents: "none",
          }}>
            Painting: <strong>{activeLayer.name}</strong>
          </div>
        )}
        {!tileset ? (
          <div style={{ color: "var(--text-dim)", padding: 24, fontStyle: "italic" }}>
            Pick a tileset on the left to start painting.
          </div>
        ) : (
          <PaintCanvas
            layers={tilemap.layers}
            slots={gidSlots.map((s, i) => ({ ts: s.ts, firstgid: s.firstgid, count: s.count, url: slotPaths[i] ? slotUrls.get(slotPaths[i]!) : undefined }))}
            cols={cols}
            rows={rows}
            tileW={tileW}
            tileH={tileH}
            zoom={zoom}
            tool={tool}
            rectDrag={rectDrag}
            activeLayerId={activeId}
            hoverBigTile={selectedBigTileId && tileset ? (() => {
              const b = (tileset.bigTiles ?? []).find((x) => x.id === selectedBigTileId);
              return b ? { ...b, srcTileW: tileset.tileW, srcTileH: tileset.tileH } : null;
            })() : null}
            hoverAnimTileId={selectedAnimatedTileId || null}
            previewAnim={previewAnim}
            eraseSize={eraseSize}
            selW={selW}
            selH={selH}
            selC0={selC0}
            selR0={selR0}
            activeFirstgid={activeFirstgid}
            brushXf={brushXf}
            panning={panning}
            onDown={onCanvasDown}
            onMove={onCanvasMove}
            onUp={onCanvasUp}
          />
        )}
      </div>
    </div>
  );
}

// ─── building blocks ────────────────────────────────────────────────────────

const LBL: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" };
const INP: React.CSSProperties = { fontSize: 12, padding: "2px 6px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" };
const LAYER_BTN: React.CSSProperties = { fontSize: 9, lineHeight: 1, padding: "1px 4px", cursor: "pointer", background: "transparent", border: "1px solid transparent", color: "var(--text-dim)" };

function ToolBtn({ label, active, onClick, title }: { label: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        fontSize: 11, padding: "3px 6px", cursor: "pointer",
        background: active ? "var(--accent)" : "var(--inner)",
        color: active ? "var(--on-accent)" : "var(--text)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 4,
      }}
    >{label}</button>
  );
}

function NumField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (n: number) => void }) {
  // Buffer the input locally so intermediate keystrokes ("5" while typing "50")
  // don't trigger destructive resizes that wipe painted tiles past col 5.
  // Commit on blur OR Enter; Escape reverts. Sync back from the prop when the
  // committed value changes (so external resets flow back in).
  const [local, setLocal] = useState(String(value));
  useEffect(() => { setLocal(String(value)); }, [value]);
  const commit = () => {
    const n = Math.floor(Number(local));
    if (!Number.isFinite(n)) { setLocal(String(value)); return; }
    onChange(Math.max(min, n));
  };
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={LBL}>{label}</span>
      <input
        type="number"
        min={min}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") { setLocal(String(value)); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        style={{ ...INP, fontSize: 11 }}
      />
    </label>
  );
}

/** Palette button for one animated-tile def — cycles through its frames so
 *  authors recognize the animation while picking, instead of staring at a
 *  static first-frame thumbnail. */
function AnimatedTilePaletteButton({
  ts, at, active, onPick,
}: {
  ts: TilesetAsset;
  at: NonNullable<TilesetAsset["animatedTiles"]>[number];
  active: boolean;
  onPick: () => void;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (at.frames.length === 0 || at.fps <= 0) return;
    const periodMs = 1000 / at.fps;
    const id = window.setInterval(() => {
      setFrame((f) => (at.frames.length === 0 ? 0 : (f + 1) % at.frames.length));
    }, periodMs);
    return () => window.clearInterval(id);
  }, [at.frames.length, at.fps]);
  const idx = at.frames[Math.min(frame, Math.max(0, at.frames.length - 1))];
  const rc = typeof idx === "number" && ts.cols > 0
    ? { c: idx % ts.cols, r: Math.floor(idx / ts.cols), w: 1, h: 1 }
    : null;
  return (
    <button
      onClick={onPick}
      title={`Place "${at.name || "animated tile"}" — ${at.frames.length} frame${at.frames.length === 1 ? "" : "s"} @ ${at.fps} fps`}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        fontSize: 9, padding: "3px", cursor: "pointer",
        background: active ? "var(--accent)" : "var(--inner)",
        color: active ? "var(--on-accent)" : "var(--text)",
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 3,
      }}
    >
      {rc
        ? <BigTilePreview ts={ts} bt={rc} maxPx={44} />
        : <div style={{ width: 44, height: 44, background: "rgba(0,0,0,0.35)", border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 2 }} />}
      <span style={{ maxWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {at.name || `(${at.frames.length}f)`}
      </span>
    </button>
  );
}

/** Tileset palette for the painter sidebar. Single canvas with one drawImage
 *  of the sheet; cursor→cell on mousedown starts a drag-select that grows the
 *  selection rectangle as the mouse moves. A click without drag collapses to
 *  a 1×1 selection (same as the old single-pick behavior). */
function Palette({
  image, sheetW, sheetH, cols, rows, tileW, tileH, offsetX, offsetY, spacingX, spacingY, selection, onSelectionChange,
  poolMembers, onPoolToggle, zoom = 1,
}: {
  /** Display zoom. 1 = fit the sidebar width; >1 enlarges (parent scrolls). */
  zoom?: number;
  image: string; sheetW: number; sheetH: number;
  cols: number; rows: number;
  tileW: number; tileH: number;
  offsetX: number; offsetY: number; spacingX: number; spacingY: number;
  selection: { c0: number; r0: number; c1: number; r1: number };
  onSelectionChange: (sel: { c0: number; r0: number; c1: number; r1: number }) => void;
  /** When non-null, palette is in randomize-pool mode — clicks toggle pool
   *  membership instead of selecting a brush. The list drives a highlight
   *  outline on every pool tile so the author sees their pool at a glance. */
  poolMembers?: Array<{ c: number; r: number; weight: number }> | null;
  onPoolToggle?: (c: number, r: number) => void;
}) {
  // Draw the palette at (capped) NATIVE resolution and let CSS scale it down to
  // the sidebar width. The old code downscaled the bitmap to ~210px with
  // nearest-neighbour, which destroyed detail on anything but tiny pixel-art
  // sheets (the "preview is pixelated, not like the original" report). Keeping
  // full resolution + a smooth CSS downscale matches the TilesetTab view.
  const sampling = useEditor((s) => s.project.sampling ?? "bilinear");
  const smooth = sampling !== "nearest";
  const MAX_INTRINSIC = 1536; // bound the canvas size for very large sheets
  const scale = sheetW > 0 ? Math.min(MAX_INTRINSIC / sheetW, 1) : 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadTilesetImage(image).then((im) => {
      if (cancelled) return;
      imgRef.current = im;
      setImgTick((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = Math.max(1, Math.round(sheetW * scale));
    const H = Math.max(1, Math.round(sheetH * scale));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Smoothing only matters if we're capping a huge sheet (scale < 1). At
    // native scale the draw is 1:1 and the CSS layer does the display scaling.
    ctx.imageSmoothingEnabled = scale < 1 && smooth;
    ctx.clearRect(0, 0, W, H);
    const img = imgRef.current;
    if (img && img.complete) ctx.drawImage(img, 0, 0, W, H);
    // Selection rectangle — covers the whole selected area, not just one tile.
    const c0 = Math.min(selection.c0, selection.c1);
    const r0 = Math.min(selection.r0, selection.r1);
    const c1 = Math.max(selection.c0, selection.c1);
    const r1 = Math.max(selection.r0, selection.r1);
    const x = (offsetX + c0 * (tileW + spacingX)) * scale;
    const y = (offsetY + r0 * (tileH + spacingY)) * scale;
    const w = ((c1 - c0 + 1) * (tileW + spacingX) - spacingX) * scale;
    const h = ((r1 - r0 + 1) * (tileH + spacingY) - spacingY) * scale;
    ctx.fillStyle = "rgba(255,210,60,0.18)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,210,60,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    // Pool outlines — green border around every tile in the randomize pool
    // so the author sees their picks at a glance. Drawn AFTER the selection
    // rect so a tile that's both selected and pooled shows both layers.
    if (poolMembers && poolMembers.length > 0) {
      ctx.strokeStyle = "rgba(120,220,140,0.95)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      for (const p of poolMembers) {
        const px = (offsetX + p.c * (tileW + spacingX)) * scale;
        const py = (offsetY + p.r * (tileH + spacingY)) * scale;
        const pw = tileW * scale;
        const ph = tileH * scale;
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      }
      ctx.setLineDash([]);
    }
  }, [imgTick, sheetW, sheetH, scale, smooth, selection, offsetX, offsetY, tileW, tileH, spacingX, spacingY, poolMembers]);

  const cellAt = (clientX: number, clientY: number): { c: number; r: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // Use the LIVE displayed scale (`rect.width / sheetW`) instead of the
    // stored draw-time `scale`. The canvas's CSS box can be stretched by
    // the flex parent to fill the sidebar — `rect.width` is the only
    // accurate read of how big each sheet pixel actually is on screen.
    // Without this, clicks drift further off the more the sidebar grows.
    const effScaleX = sheetW > 0 ? rect.width / sheetW : scale;
    const effScaleY = sheetH > 0 ? rect.height / sheetH : scale;
    const x = (clientX - rect.left) / effScaleX;
    const y = (clientY - rect.top) / effScaleY;
    const c = Math.floor((x - offsetX) / (tileW + spacingX));
    const r = Math.floor((y - offsetY) / (tileH + spacingY));
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
    return { c, r };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = cellAt(e.clientX, e.clientY);
    if (!p) return;
    // Randomize-pool mode — click toggles pool membership, doesn't change
    // the brush selection. Drag has no special meaning here (each tile
    // toggles on click, not on drag — multi-toggle would feel surprising).
    if (onPoolToggle) {
      onPoolToggle(p.c, p.r);
      return;
    }
    onSelectionChange({ c0: p.c, r0: p.r, c1: p.c, r1: p.r });
    // Document-level listeners keep the drag alive if the cursor briefly
    // leaves the canvas — same pattern as the paint canvas.
    const move = (ev: MouseEvent) => {
      const q = cellAt(ev.clientX, ev.clientY);
      if (!q) return;
      onSelectionChange({ c0: p.c, r0: p.r, c1: q.c, r1: q.r });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // Canvas's CSS box is allowed to STRETCH to fill the sidebar's width
  // (parent is flex column with default align-items: stretch). The
  // intrinsic resolution stays at sheetW*scale so the texture stays
  // crisp; the visible scale-up happens at the CSS layer. The click
  // handler reads the LIVE bounding rect to map clicks correctly even
  // when the visible scale differs from the draw-time scale.
  // Wrapped in a scroll box: at zoom 1 the canvas is 100% (fits the sidebar);
  // higher zoom widens it past the box so it scrolls. Width drives the visible
  // scale; height stays auto (intrinsic aspect). cellAt reads the live rect, so
  // clicks map correctly at any zoom.
  return (
    <div style={{ overflow: "auto", maxHeight: 360, border: "1px solid var(--border)" }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        style={{
          display: "block", cursor: "crosshair",
          width: `${zoom * 100}%`,
          // Pixel-art projects (sampling "nearest") want crisp blocks; smooth
          // projects want the browser's quality downscale so HD tiles aren't
          // forced into a blocky look.
          imageRendering: smooth ? "auto" : "pixelated",
          height: "auto",
        }}
      />
    </div>
  );
}

/** Canvas-based paint canvas with PER-LAYER offscreen buffers.
 *
 *  Each layer's tiles are rendered into its own native-resolution buffer.
 *  Per-cell changes update only those cells in the buffer (delta). Every
 *  visible-canvas update is then a SINGLE drawImage per layer + scale, so
 *  per-frame cost stays constant regardless of map size (a 200×200 map
 *  is as cheap as a 16×16 one for the on-screen redraw).
 *
 *  Document-level mouse listeners keep the brush stroke alive if the cursor
 *  briefly leaves the canvas during a fast swipe. */
/** One tileset slot the painter renders from — full asset (for BigTiles /
 *  animated / solids / geometry), its global firstgid, and its atlas URL. */
interface PaintSlot {
  ts: TilesetAsset;
  firstgid: number;
  count: number;
  url: string | undefined;
}

function PaintCanvas({
  layers, slots, cols, rows, tileW, tileH, zoom, tool, rectDrag, activeLayerId, hoverBigTile,
  hoverAnimTileId, previewAnim = true, eraseSize = 1, selW, selH, selC0 = 0, selR0 = 0, activeFirstgid = 0, brushXf = 0, panning,
  onDown, onMove, onUp,
}: {
  layers: {
    id: string;
    tiles: number[];
    xf?: Record<number, number>;
    z: number;
    alpha: number;
    visible: boolean;
    collides?: boolean;
    bigTilePlacements?: { id: string; bigTileId: string; c: number; r: number }[];
    animatedTilePlacements?: { id: string; animatedTileId: string; c: number; r: number }[];
  }[];
  /** Ordered tileset list (primary + extras) with firstgids + atlas URLs. */
  slots: PaintSlot[];
  /** cols/rows of the map; tileW/tileH are the MAP CELL size (primary tileset). */
  cols: number; rows: number; tileW: number; tileH: number; zoom: number; tool: Tool;
  rectDrag: { c0: number; r0: number; c1: number; r1: number } | null;
  activeLayerId: string;
  hoverBigTile?: { id: string; c: number; r: number; w: number; h: number; pivotX?: number; pivotY?: number; sortY?: number; srcTileW?: number; srcTileH?: number } | null;
  hoverAnimTileId?: string | null;
  previewAnim?: boolean;
  eraseSize?: number;
  selW: number; selH: number;
  /** Selection origin + active tileset + transform — drives the ghost preview
   *  that shows the ACTUAL selected tile(s) (flipped/rotated) under the cursor. */
  selC0?: number; selR0?: number; activeFirstgid?: number; brushXf?: number;
  panning: boolean;
  onDown: (col: number, row: number, e: React.MouseEvent) => void;
  onMove: (col: number, row: number) => void;
  onUp: () => void;
}) {
  const [hoverCell, setHoverCell] = useState<{ col: number; row: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Separate overlay canvas for animated-tile placements. Keeping them OFF the
  // main canvas means the 6fps animation clock only redraws this cheap overlay,
  // not the whole tilemap (layer composites + big tiles + all-cells solids +
  // grid) — which is what made big maps crawl while previewing animation.
  const animCanvasRef = useRef<HTMLCanvasElement>(null);
  // Loaded atlas images keyed by tileset id (one per slot).
  const imgsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgTick, setImgTick] = useState(0);
  // Shared animation tick for animated-tile placements in the editor preview.
  // 6fps is enough to recognize an animation without hammering the canvas.
  const [animTick, setAnimTick] = useState(0);
  useEffect(() => {
    if (!previewAnim) return;
    if (!(layers.some((L) => (L.animatedTilePlacements?.length ?? 0) > 0))) return;
    const id = window.setInterval(() => setAnimTick((n) => n + 1), 1000 / 6);
    return () => window.clearInterval(id);
  }, [layers, previewAnim]);
  // Per-layer offscreen buffers + their last-painted tile arrays (for delta).
  // Survives renders as a ref so we don't churn canvases on every store update.
  const bufsRef = useRef<Map<string, { buf: HTMLCanvasElement; prevTiles: number[] | null; prevXf?: Record<number, number> }>>(new Map());

  // Resolve a global id to its owning slot (for BigTile / solid lookups).
  const ownerOf = (g: number): PaintSlot | undefined =>
    slots.find((s) => g >= s.firstgid && g < s.firstgid + s.count);

  const slotUrlKey = slots.map((s) => `${s.ts.id}:${s.url ?? ""}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const wanted = new Map(slots.filter((s) => s.url).map((s) => [s.ts.id, s.url!] as const));
    for (const id of Array.from(imgsRef.current.keys())) if (!wanted.has(id)) imgsRef.current.delete(id);
    Promise.all(Array.from(wanted.entries()).map(([id, url]) =>
      loadTilesetImage(url).then((im) => { if (!cancelled && im) imgsRef.current.set(id, im); }),
    )).then(() => { if (!cancelled) setImgTick((n) => n + 1); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotUrlKey]);

  // Draw slots for paintLayerBuffer — TilesetAsset is structurally a TileSetData.
  const tileSlots: TileSlot[] = slots.map((s) => ({
    tileset: s.ts, img: imgsRef.current.get(s.ts.id) ?? null, firstgid: s.firstgid, count: s.count,
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 1. Maintain per-layer buffers — add new, drop removed, repaint as needed.
    const bufs = bufsRef.current;
    const liveIds = new Set(layers.map((L) => L.id));
    for (const id of Array.from(bufs.keys())) if (!liveIds.has(id)) bufs.delete(id);
    const nativeW = Math.max(1, cols * tileW);
    const nativeH = Math.max(1, rows * tileH);
    // Only finalize (mark prevTiles) once EVERY tileset image is loaded. A
    // multi-tileset map's atlases load at different times; marking prevTiles
    // when only SOME are ready froze the not-yet-loaded slots' cells as blank
    // (the next delta found no change and skipped them) — that's the "messed
    // up after reopen" corruption. Until all are ready we full-repaint each
    // render (cheap — it's all buffered), so progressive loads land correctly.
    // Key on imageFile, NOT s.url: a slot whose URL hasn't resolved yet (url
    // undefined) still needs its image — treating it "ready" would re-freeze
    // its cells blank. (Matches the SceneEditor gate.)
    const allReady = slots.every((s) => !s.ts.imageFile || ((imgsRef.current.get(s.ts.id)?.naturalWidth ?? 0) > 0));
    for (const L of layers) {
      let entry = bufs.get(L.id);
      if (!entry) {
        entry = { buf: document.createElement("canvas"), prevTiles: null };
        entry.buf.width = nativeW;
        entry.buf.height = nativeH;
        bufs.set(L.id, entry);
      }
      // Dimensions changed → drop prev to force a full repaint.
      if (entry.buf.width !== nativeW || entry.buf.height !== nativeH) {
        entry.buf.width = nativeW;
        entry.buf.height = nativeH;
        entry.prevTiles = null;
        entry.prevXf = undefined;
      }
      // Not all ready → keep prevTiles null so this layer FULL-repaints every
      // render (no stale delta) until the images arrive.
      if (!allReady) { entry.prevTiles = null; entry.prevXf = undefined; }
      paintLayerBuffer(entry.buf, tileSlots, L.tiles, entry.prevTiles, cols, rows, tileW, tileH, L.xf, entry.prevXf);
      if (allReady) { entry.prevTiles = L.tiles; entry.prevXf = L.xf; }
    }

    // 2. Composite to the visible canvas: one drawImage per visible layer +
    //    overlays. This is the part that runs every interaction.
    const W = Math.max(1, Math.round(cols * tileW * zoom));
    const H = Math.max(1, Math.round(rows * tileH * zoom));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, 0, W, H);

    const sorted = [...layers].sort((a, b) => a.z - b.z);
    for (const L of sorted) {
      if (!L.visible) continue;
      const entry = bufs.get(L.id);
      if (!entry) continue;
      const isActive = L.id === activeLayerId;
      ctx.globalAlpha = L.alpha * (isActive ? 1 : 0.6);
      ctx.drawImage(entry.buf, 0, 0, nativeW, nativeH, 0, 0, W, H);
      // BigTile placements — draw each as a single rect of source pixels from
      // its OWNING tileset (a map can mix several), overlaid on the regular
      // cells. Drawn at the MAP cell size so a BigTile from a differently-sized
      // tileset still tiles cleanly. Matches what the runtime spawns.
      for (const placement of L.bigTilePlacements ?? []) {
        const owner = slots.find((s) => (s.ts.bigTiles ?? []).some((b) => b.id === placement.bigTileId));
        const oImg = owner ? imgsRef.current.get(owner.ts.id) : undefined;
        const bt = owner?.ts.bigTiles?.find((b) => b.id === placement.bigTileId);
        if (!owner || !oImg || !oImg.complete || !bt) continue;
        const ots = owner.ts;
        const sx = ots.offsetX + bt.c * (ots.tileW + ots.spacingX);
        const sy = ots.offsetY + bt.r * (ots.tileH + ots.spacingY);
        const sw = bt.w * ots.tileW + (bt.w - 1) * ots.spacingX;
        const sh = bt.h * ots.tileH + (bt.h - 1) * ots.spacingY;
        // Render at the OWNING tileset's true size (so a door from a 64×128
        // tileset shows at 64×128, not squished to the 32×32 map cell). For a
        // single-tileset map ots.tileW === the map cell, so trees/etc. are
        // byte-identical. Top-left anchored at the placement cell — an oversized
        // tile grows DOWN/RIGHT from where you clicked (stays on-screen).
        const dw = bt.w * ots.tileW * zoom;
        const dh = bt.h * ots.tileH * zoom;
        const dx = placement.c * tileW * zoom;
        const dy = placement.r * tileH * zoom;
        ctx.drawImage(oImg, sx, sy, sw, sh, dx, dy, dw, dh);
        // Faint green outline so authors see placement boundaries.
        ctx.strokeStyle = "rgba(120,210,120,0.7)";
        ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
      }
      // Animated-tile placements — drawn at THIS layer's z (interleaved with the
      // base buffer + big tiles) so they stack correctly under higher layers,
      // matching the runtime. (Previously a separate always-on-top overlay,
      // which made low-layer foam render OVER higher grass.)
      for (const placement of L.animatedTilePlacements ?? []) {
        const owner = slots.find((s) => (s.ts.animatedTiles ?? []).some((a) => a.id === placement.animatedTileId));
        const oImg = owner ? imgsRef.current.get(owner.ts.id) : undefined;
        const at = owner?.ts.animatedTiles?.find((a) => a.id === placement.animatedTileId);
        if (!owner || !oImg || !oImg.complete || !at || at.frames.length === 0) continue;
        const ots = owner.ts;
        if (ots.cols <= 0) continue;
        const reg = animFrameRegion(at.frames[(previewAnim ? animTick : 0) % at.frames.length], ots.cols);
        const asx = ots.offsetX + reg.c * (ots.tileW + ots.spacingX);
        const asy = ots.offsetY + reg.r * (ots.tileH + ots.spacingY);
        const asw = reg.w * ots.tileW + (reg.w - 1) * ots.spacingX;
        const ash = reg.h * ots.tileH + (reg.h - 1) * ots.spacingY;
        const adx = placement.c * tileW * zoom;
        const ady = placement.r * tileH * zoom;
        ctx.drawImage(oImg, asx, asy, asw, ash, adx, ady, reg.w * ots.tileW * zoom, reg.h * ots.tileH * zoom);
        ctx.strokeStyle = "rgba(160,140,255,0.85)";
        ctx.lineWidth = 1;
        ctx.strokeRect(adx + 0.5, ady + 0.5, reg.w * ots.tileW * zoom - 1, reg.h * ots.tileH * zoom - 1);
      }
    }
    ctx.globalAlpha = 1;

    // Solids overlay — collision tint on the ACTIVE layer's solid tiles.
    // solidTiles is per-tileset (local indices); resolve each cell's owner.
    // RED = this layer's collision is ON, so these cells actually block at
    // runtime. MUTED amber = the tile is solid in the tileset but the layer's
    // "Collides" toggle is OFF, so it does NOT collide in the scene/runtime —
    // this is why solids can look fine here yet pass-through in game.
    const active = sorted.find((L) => L.id === activeLayerId);
    if (active && slots.some((s) => (s.ts.solidTiles?.length ?? 0) > 0)) {
      ctx.fillStyle = active.collides ? "rgba(255,80,80,0.28)" : "rgba(255,200,40,0.16)";
      const dW = tileW * zoom, dH = tileH * zoom;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const t = active.tiles[r * cols + c];
          if (t === undefined || t < 0) continue;
          const owner = ownerOf(t);
          if (!owner || !(owner.ts.solidTiles ?? []).includes(t - owner.firstgid)) continue;
          ctx.fillRect(c * dW, r * dH, dW, dH);
        }
      }
    }

    // Grid lines.
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = Math.round(c * tileW * zoom) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(r * tileH * zoom) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();

    // BigTile hover preview — show the BigTile at the hover cell minus the
    // pivot, so the user sees EXACTLY where it will land when they click.
    if (hoverBigTile && hoverCell) {
      const bt = hoverBigTile;
      const px = bt.pivotX ?? 0.5;
      const py = bt.pivotY ?? 1;
      const anchorC = hoverCell.col - Math.min(bt.w - 1, Math.floor(px * bt.w));
      const anchorR = hoverCell.row - Math.min(bt.h - 1, Math.floor(py * bt.h));
      const dx = anchorC * tileW * zoom;
      const dy = anchorR * tileH * zoom;
      // Match the PLACED size: the BigTile's owning-tileset native size, top-left
      // anchored — so the preview outline is exactly what gets drawn on click.
      const dw = bt.w * (bt.srcTileW ?? tileW) * zoom;
      const dh = bt.h * (bt.srcTileH ?? tileH) * zoom;
      // Tinted outline + a tiny cross on the pivot cell.
      ctx.fillStyle = "rgba(120,210,120,0.20)";
      ctx.fillRect(dx, dy, dw, dh);
      ctx.strokeStyle = "rgba(120,210,120,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
      // Pivot crosshair at the clicked cell.
      const px2 = hoverCell.col * tileW * zoom + (tileW * zoom) / 2;
      const py2 = hoverCell.row * tileH * zoom + (tileH * zoom) / 2;
      ctx.strokeStyle = "rgba(255,80,80,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px2 - 6, py2); ctx.lineTo(px2 + 6, py2);
      ctx.moveTo(px2, py2 - 6); ctx.lineTo(px2, py2 + 6);
      ctx.stroke();
      // Sort-Y line at trunk base — only meaningful at "Middle" (sortY=0.5).
      const userSortY = bt.sortY ?? 0;
      if (userSortY === 0.5) {
        const sortLineY = dy + dh;
        ctx.strokeStyle = "rgba(60,200,255,0.95)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(dx, sortLineY); ctx.lineTo(dx + dw, sortLineY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Animated-tile hover ghost — draw the current cycle frame at the hover
    // cell so the user sees the actual tile where it will land (parity with
    // the BigTile preview above).
    if (hoverAnimTileId && hoverCell) {
      const owner = slots.find((s) => (s.ts.animatedTiles ?? []).some((a) => a.id === hoverAnimTileId));
      const oImg = owner ? imgsRef.current.get(owner.ts.id) : undefined;
      const at = owner?.ts.animatedTiles?.find((a) => a.id === hoverAnimTileId);
      if (owner && oImg && oImg.complete && at && at.frames.length > 0 && owner.ts.cols > 0) {
        const ots = owner.ts;
        const reg = animFrameRegion(at.frames[animTick % at.frames.length], ots.cols);
        const sx = ots.offsetX + reg.c * (ots.tileW + ots.spacingX);
        const sy = ots.offsetY + reg.r * (ots.tileH + ots.spacingY);
        const sw = reg.w * ots.tileW + (reg.w - 1) * ots.spacingX;
        const sh = reg.h * ots.tileH + (reg.h - 1) * ots.spacingY;
        const dx = hoverCell.col * tileW * zoom;
        const dy = hoverCell.row * tileH * zoom;
        const dw = reg.w * ots.tileW * zoom;
        const dh = reg.h * ots.tileH * zoom;
        ctx.globalAlpha = 0.7;
        ctx.drawImage(oImg, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(160,140,255,0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
      }
    }

    // Rect-tool live overlay (on top of everything else).
    if (rectDrag) {
      const c0 = Math.min(rectDrag.c0, rectDrag.c1);
      const r0 = Math.min(rectDrag.r0, rectDrag.r1);
      const c1 = Math.max(rectDrag.c0, rectDrag.c1);
      const r1 = Math.max(rectDrag.r0, rectDrag.r1);
      const x = c0 * tileW * zoom, y = r0 * tileH * zoom;
      const w = (c1 - c0 + 1) * tileW * zoom;
      const h = (r1 - r0 + 1) * tileH * zoom;
      ctx.fillStyle = "rgba(255,210,60,0.18)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,210,60,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }

    // Hover preview. Brush → draw the ACTUAL selected tile(s), flipped/rotated
    // per brushXf, so you see exactly what lands. Erase/rect → a footprint box.
    // Bucket/picker → nothing. BigTile / animated hovers are drawn above.
    if (hoverCell && !hoverBigTile && !hoverAnimTileId && !rectDrag && tool === "brush" && selW > 0 && selH > 0) {
      const aslot = slots.find((s) => s.firstgid === activeFirstgid) ?? slots[0];
      const aimg = aslot ? imgsRef.current.get(aslot.ts.id) : undefined;
      const tw = tileW * zoom, th = tileH * zoom;
      const { outW, outH, cells } = transformedSelection(selW, selH, brushXf);
      if (aslot && aimg && aimg.complete) {
        const pts = aslot.ts;
        const fx = (brushXf & 1) !== 0, fy = (brushXf & 2) !== 0, rot = (brushXf >> 2) & 3;
        ctx.globalAlpha = 0.6;
        for (const cell of cells) {
          const sx = pts.offsetX + (selC0 + cell.sc) * (pts.tileW + pts.spacingX);
          const sy = pts.offsetY + (selR0 + cell.sr) * (pts.tileH + pts.spacingY);
          const dx = (hoverCell.col + cell.ox) * tw;
          const dy = (hoverCell.row + cell.oy) * th;
          ctx.save();
          ctx.translate(dx + tw / 2, dy + th / 2);
          if (rot) ctx.rotate((rot * Math.PI) / 2);
          ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
          ctx.drawImage(aimg, sx, sy, pts.tileW, pts.tileH, -tw / 2, -th / 2, tw, th);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = "rgba(255,210,60,0.9)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hoverCell.col * tw + 0.75, hoverCell.row * th + 0.75, outW * tw - 1.5, outH * th - 1.5);
    } else if (hoverCell && !hoverBigTile && !hoverAnimTileId && !rectDrag && (tool === "erase" || tool === "rect")) {
      const previewW = tool === "erase" ? Math.max(1, eraseSize) : 1;
      const previewH = tool === "erase" ? Math.max(1, eraseSize) : 1;
      const half = tool === "erase" ? Math.floor((eraseSize - 1) / 2) : 0;
      const dx = (hoverCell.col - half) * tileW * zoom;
      const dy = (hoverCell.row - half) * tileH * zoom;
      const dw = previewW * tileW * zoom, dh = previewH * tileH * zoom;
      ctx.fillStyle = "rgba(255,210,60,0.10)";
      ctx.fillRect(dx, dy, dw, dh);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    }
  }, [layers, slots, cols, rows, tileW, tileH, zoom, rectDrag, imgTick, activeLayerId, hoverBigTile, hoverAnimTileId, hoverCell, tool, selW, selH, selC0, selR0, activeFirstgid, brushXf, eraseSize, animTick, previewAnim]);

  // Animated tiles are now drawn interleaved by z in the MAIN composite (so they
  // stack correctly under higher layers). This overlay canvas is kept cleared/
  // transparent — only resized to match so it never shows stale frames.
  useEffect(() => {
    const canvas = animCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = Math.max(1, Math.round(cols * tileW * zoom));
    const H = Math.max(1, Math.round(rows * tileH * zoom));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    ctx.clearRect(0, 0, W, H);
  }, [cols, rows, tileW, tileH, zoom]);

  // Pointer→cell with the canvas's bounding rect. Returns null when the
  // cursor is outside the painted area — callers no-op then.
  const pickCell = (clientX: number, clientY: number): { col: number; row: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const col = Math.floor(x / (tileW * zoom));
    const row = Math.floor(y / (tileH * zoom));
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    return { col, row };
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Space-pan suppresses paint clicks so Space+drag never accidentally edits.
    if (panning) return;
    const p = pickCell(e.clientX, e.clientY);
    if (!p) return;
    onDown(p.col, p.row, e);
    // Track drag at the DOCUMENT level so painting keeps going if the cursor
    // briefly leaves the canvas during a fast swipe — without this, the
    // brush would "skip" any cell the mouse re-entered through.
    const move = (ev: MouseEvent) => {
      const q = pickCell(ev.clientX, ev.clientY);
      if (q) onMove(q.col, q.row);
    };
    const up = () => {
      onUp();
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const onCanvasHover = (e: React.MouseEvent) => {
    const p = pickCell(e.clientX, e.clientY);
    setHoverCell(p);
  };
  const onCanvasLeave = () => setHoverCell(null);

  const cursor = panning ? "grab" : tool === "picker" ? "crosshair" : tool === "erase" ? "not-allowed" : "cell";
  return (
    <div style={{ position: "relative", display: "inline-block", lineHeight: 0, outline: "1px solid var(--border)" }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasHover}
        onMouseLeave={onCanvasLeave}
        style={{ display: "block", cursor, imageRendering: "pixelated" }}
      />
      <canvas
        ref={animCanvasRef}
        style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", imageRendering: "pixelated" }}
      />
    </div>
  );
}
