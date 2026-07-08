import { useEffect, useMemo, useRef, useState, MouseEvent, DragEvent } from "react";
import { createPortal } from "react-dom";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { SpriteAsset, TilemapAsset, TilemapInstance, TilesetAsset, tilemapTilesets, animFrameRegion, type TerrainDef } from "../project";
import { FrameThumb, useSpriteFrameURL, useTilesetURL } from "../components/FrameThumb";
import { useAssetURLs } from "../useAssetURL";
import { spriteFrameDiskPath, tilesetImagePath } from "../AssetStore";
import { visualCssStyle, InventoryGridPreview, inventoryFrameSize, CraftGridPreview, craftGridFrameSize } from "./UIWidgetTab";
import { loadTilesetImage, paintLayerBuffer, type TileSlot } from "./tilemapDraw";
import { BigTilePreview } from "./TilesetTab";
import { bucketEdits, lineCells, pickerSelection, rectEdits, transformedSelection, type RectDrag as PaintRectDrag, type Tool as PaintTool } from "./tilemapPainter";
import { NavMeshOverlay, NavMeshView } from "./NavMeshOverlay";
import {
  autoTileBrushEdits, autoTileEraseEdits, autoTileRectEdits,
  buildTerrainOwnership, tileForMaskOrFallback,
} from "./tilemapAutoTile";

/** Shift a terrain's tile references by `firstgid` so its rules compare against
 *  the GLOBAL ids stored in a layer's tiles array (mirrors TilemapTab). */
function offsetTerrain(t: TerrainDef, firstgid: number): TerrainDef {
  if (firstgid === 0) return t;
  return {
    ...t,
    defaultTile: t.defaultTile + firstgid,
    rules: t.rules.map((r) => ({ ...r, tile: r.tile + firstgid })),
  };
}

const SHOW_COLLIDERS_KEY = "peaky.scene-show-colliders";
const SHOW_VIEWPORT_KEY  = "peaky.scene-show-viewport";
const VIEWPORT_POS_KEY   = (sceneId: string) => `peaky.scene-viewport-pos.${sceneId}`;
const USER_ZOOM_KEY      = (sceneId: string) => `peaky.scene-zoom.${sceneId}`;
const PAN_KEY            = (sceneId: string) => `peaky.scene-pan.${sceneId}`;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.12;

/** CSS alpha-component hex (00..FF) from a 0..1 alpha. Used by UI widget
 *  preview to combine bgColor + bgAlpha into a single CSS color string. */
function alphaHex(a: number): string {
  const clamped = Math.max(0, Math.min(1, a));
  return Math.round(clamped * 255).toString(16).padStart(2, "0");
}

/**
 * Static (paused) scene viewport. Renders each Instance — using the BP's
 * SpriteRenderer (first frame of default animation) when present, otherwise
 * the BP's colour/size as a fallback rect. Click selects, drag moves.
 */
export function SceneEditor() {
  const scene = useEditor((s) => s.activeScene());
  const viewportW = useEditor((s) => s.project.viewportWidth);
  const viewportH = useEditor((s) => s.project.viewportHeight);
  const blueprintFor = useEditor((s) => s.blueprintFor);
  const sprites = useEditor((s) => s.project.sprites);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const tilesets = useEditor((s) => s.project.tilesets);
  const tilemaps = useEditor((s) => s.project.tilemaps);
  // Subscribe to blueprint changes so collider/behavior edits re-render immediately.
  useEditor((s) => s.project.blueprints);
  // Bulk-resolve every UI-Widget Image kind's first frame to a blob URL so
  // the JSX-side loop can look them up synchronously by disk-path. Computing
  // paths inside the map() callback would require hooks-in-loops which React
  // forbids; collecting upfront keeps the contract clean. Covers both
  // single-mode widgets AND multi-mode children that reference a sprite.
  const uiImagePaths: (string | undefined)[] = (scene.uiInstances ?? []).flatMap((inst) => {
    const widget = uiWidgets.find((w) => w.id === inst.uiWidgetId);
    if (!widget) return [];
    const paths: (string | undefined)[] = [];
    const addFor = (spriteId: string | undefined) => {
      if (!spriteId) return;
      const sp = sprites.find((s) => s.id === spriteId);
      const fr = sp?.animations[0]?.frames[0];
      if (sp && fr?.imageFile) paths.push(spriteFrameDiskPath(sp, fr.imageFile));
    };
    if (widget.kind === "Image") addFor(widget.spriteId);
    if (widget.mode === "multi") for (const ch of widget.children) if (ch.kind === "Image") addFor(ch.spriteId);
    return paths;
  });
  const uiImageUrls = useAssetURLs(uiImagePaths);
  const selectedId = useEditor((s) => s.selectedInstanceId);
  const select = useEditor((s) => s.selectInstance);
  const update = useEditor((s) => s.updateInstance);
  const placeInstance = useEditor((s) => s.placeInstance);
  const placeUIWidgetInstance = useEditor((s) => s.placeUIWidgetInstance);
  const addSpritePlacement = useEditor((s) => s.addSpritePlacement);
  const updateSpritePlacement = useEditor((s) => s.updateSpritePlacement);
  const removeSpritePlacement = useEditor((s) => s.removeSpritePlacement);
  const openSpriteTab = useEditor((s) => s.openSpriteTab);
  const updateUIWidgetInstance = useEditor((s) => s.updateUIWidgetInstance);
  const addTilemapInstance = useEditor((s) => s.addTilemapInstance);
  const updateTilemapInstance = useEditor((s) => s.updateTilemapInstance);
  const removeTilemapInstance = useEditor((s) => s.removeTilemapInstance);
  const removeInstance = useEditor((s) => s.removeInstance);
  const duplicateSelection = useEditor((s) => s.duplicateSelection);
  // Scene clipboard for Ctrl+C / Ctrl+V — holds copied ids + a paste counter so
  // successive pastes cascade their offset instead of stacking exactly.
  const clipboardRef = useRef<{ ids: string[]; pastes: number } | null>(null);
  const removeUIWidgetInstance = useEditor((s) => s.removeUIWidgetInstance);
  const openBlueprintTab = useEditor((s) => s.openBlueprintTab);
  const openTilemapTab = useEditor((s) => s.openTilemapTab);
  // In-scene tilemap paint mode — toggled via the tilemap-instance inspector.
  // When on AND a tilemap is selected, mouse on its canvas paints instead of
  // drag-moves; we also render a floating tools+palette overlay.
  const tilemapPaintMode = useEditor((s) => s.tilemapPaintMode);
  const setTilemapPaintMode = useEditor((s) => s.setTilemapPaintMode);
  // Nav-mesh edit mode — paint walkable areas / obstacles / waypoints over the
  // scene. Local (not store) since it's a transient editor mode like a tool.
  const [navMode, setNavMode] = useState(false);
  // Show nav objects (waypoints/obstacles) in NORMAL editing too, so authors
  // see where missions/obstacles are without entering Nav mode.
  const [showNavObjects, setShowNavObjects] = useState(true);
  const ensureNavMesh = useEditor((s) => s.ensureNavMesh);
  // Screen-space top-left of the scene VIEWPORT panel, so the portalled Nav
  // toggle anchors to the viewport (not the global left rail).
  const [vpBox, setVpBox] = useState({ left: 0, top: 0, right: 0 });
  const paintTile = useEditor((s) => s.paintTile);
  const paintTiles = useEditor((s) => s.paintTiles);
  const selectedTilemapInst = useEditor((s) => s.selectedTilemapInstance());

  const containerRef = useRef<HTMLDivElement>(null);
  const [baseFitScale, setBaseFitScale] = useState(1);
  // User-controlled zoom multiplier on top of the fit-to-area base. Persisted
  // per-scene so each layout remembers its zoom independently.
  const [userZoom, setUserZoom] = useState<number>(() => {
    try { return Number(localStorage.getItem(USER_ZOOM_KEY(scene.id)) ?? 1) || 1; } catch { return 1; }
  });
  // Re-load user zoom when switching scenes.
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(USER_ZOOM_KEY(scene.id)) ?? 1) || 1;
      setUserZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)));
    } catch { setUserZoom(1); }
  }, [scene.id]);
  useEffect(() => {
    localStorage.setItem(USER_ZOOM_KEY(scene.id), String(userZoom));
  }, [scene.id, userZoom]);
  // Effective rendering scale = fit-to-area * user zoom. Multiplies cleanly:
  // user zoom 1 = "fits the panel"; 2 = "twice as big as fit"; 0.5 = half.
  const scale = baseFitScale * userZoom;

  // Pan offset in screen pixels, also persisted per-scene. Reset to zero
  // on every fresh mount / scene switch — pan is only adjusted while
  // explicitly drag-panning the canvas; the stored value was once used by
  // a buggy cursor-anchored zoom and could leave the canvas stranded
  // off-screen, so we ignore the persisted value at load time.
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);
  useEffect(() => {
    localStorage.setItem(PAN_KEY(scene.id), JSON.stringify(pan));
  }, [scene.id, pan]);
  const panDrag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const resetView = () => { setUserZoom(1); setPan({ x: 0, y: 0 }); };
  const [showColliders, setShowColliders] = useState<boolean>(() => {
    return localStorage.getItem(SHOW_COLLIDERS_KEY) === "1";
  });
  useEffect(() => {
    localStorage.setItem(SHOW_COLLIDERS_KEY, showColliders ? "1" : "0");
  }, [showColliders]);

  // Viewport overlay — dashed rectangle the size of the project viewport,
  // draggable inside the layout to preview the camera framing. Position
  // persists per-scene; clamped to layout bounds so it can't drift off.
  const [showViewport, setShowViewport] = useState<boolean>(() => {
    return localStorage.getItem(SHOW_VIEWPORT_KEY) !== "0";
  });
  useEffect(() => {
    localStorage.setItem(SHOW_VIEWPORT_KEY, showViewport ? "1" : "0");
  }, [showViewport]);
  const [vpPos, setVpPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem(VIEWPORT_POS_KEY(scene.id));
      if (raw) {
        const parsed = JSON.parse(raw);
        return { x: Number(parsed.x) || 0, y: Number(parsed.y) || 0 };
      }
    } catch { /* ignore */ }
    return { x: 0, y: 0 };
  });
  // Reload position when switching scenes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(VIEWPORT_POS_KEY(scene.id));
      setVpPos(raw ? JSON.parse(raw) : { x: 0, y: 0 });
    } catch { setVpPos({ x: 0, y: 0 }); }
  }, [scene.id]);
  useEffect(() => {
    localStorage.setItem(VIEWPORT_POS_KEY(scene.id), JSON.stringify(vpPos));
  }, [scene.id, vpPos]);
  const vpDrag = useRef<{ dx: number; dy: number } | null>(null);

  // Refs that mirror state — the wheel handler reads these so multiple
  // rapid wheel events don't all share a stale closure pan/zoom.
  const userZoomRef = useRef(userZoom); userZoomRef.current = userZoom;
  const panRef = useRef(pan); panRef.current = pan;
  const baseFitScaleRef = useRef(baseFitScale); baseFitScaleRef.current = baseFitScale;

  useEffect(() => {
    const fit = () => {
      const el = containerRef.current?.parentElement;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setVpBox({ left: r.left, top: r.top, right: r.right });
      const padding = 24;
      const aw = el.clientWidth - padding;
      const ah = el.clientHeight - padding;
      if (aw <= 0 || ah <= 0) return;
      // Compute the BASE fit-to-area scale; the user's wheel zoom multiplies
      // on top via `scale = baseFitScale * userZoom`. So userZoom = 1 always
      // means "currently fits the panel" regardless of layout size.
      const sx = aw / scene.width;
      const sy = ah / scene.height;
      setBaseFitScale(Math.min(sx, sy));
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (containerRef.current?.parentElement) ro.observe(containerRef.current.parentElement);
    return () => ro.disconnect();
  }, [scene.width, scene.height]);

  // Multi-selection — set of instance ids in addition to the primary
  // `selectedInstanceId` from the store. Maintained locally because the
  // primary-selection field is shared with other panels (Inspector,
  // Outliner) which expect a single id; the multi set is viewport-only.
  // multiSelected lives in the store so the Outliner (Shift+click rows) and
  // the Inspector (apply changes to all selected) share the same state.
  const multiSelected = useEditor((s) => s.multiSelected);
  const setMultiSelected = (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const resolved = typeof next === "function" ? next(useEditor.getState().multiSelected) : next;
    useEditor.getState().setMultiSelected(resolved);
  };

  // Paint state for the in-scene painter — local because it's editor-only UI
  // state, not part of project data. Resets to layer 0 of whichever tilemap
  // is currently selected.
  const [paintTool, setPaintTool] = useState<PaintTool>("brush");
  const [paintSel, setPaintSel] = useState<PaintRectDrag>({ c0: 0, r0: 0, c1: 0, r1: 0 });
  const [paintActiveLayerId, setPaintActiveLayerId] = useState<string | null>(null);
  const [paintActiveTilesetId, setPaintActiveTilesetId] = useState<string | null>(null);
  const [paintTerrainId, setPaintTerrainId] = useState<string | null>(null);
  const [paintBigTileId, setPaintBigTileId] = useState<string | null>(null);
  const placeBigTile = useEditor((s) => s.placeBigTile);
  const removeBigTilePlacement = useEditor((s) => s.removeBigTilePlacement);
  const [paintRectDrag, setPaintRectDrag] = useState<PaintRectDrag | null>(null);
  const [paintXf, setPaintXf] = useState(0);
  const paintLastStamp = useRef<{ col: number; row: number } | null>(null);

  // Resolve the selected tilemap + tileset for paint mode + the toolbar.
  const selectedTilemapMap = selectedTilemapInst
    ? (tilemaps ?? []).find((m) => m.id === selectedTilemapInst.tilemapId)
    : undefined;
  const selectedTilemapTileset = selectedTilemapMap
    ? (tilesets ?? []).find((t) => t.id === selectedTilemapMap.tilesetId)
    : undefined;
  // Multi-tileset paint: the map's ordered tileset slots (primary + extras, each
  // with its global `firstgid`), the slot currently being painted from, and that
  // slot's id offset — so painting from a non-primary tileset stamps GLOBAL ids.
  const paintSlots = useMemo(
    () => (selectedTilemapMap ? tilemapTilesets(selectedTilemapMap, tilesets ?? []) : []),
    [selectedTilemapMap, tilesets],
  );
  const activePaintSlot = paintSlots.find((s) => s.ts.id === paintActiveTilesetId) ?? paintSlots[0];
  const paintTileset = activePaintSlot?.ts ?? selectedTilemapTileset;
  const paintFirstgid = activePaintSlot?.firstgid ?? 0;
  // Manual tileset switch from the toolbar — reset the palette selection +
  // terrain/big-tile picks (they belong to the previous tileset). The picker
  // tool sets paintActiveTilesetId directly so it can keep its computed sel.
  const switchPaintTileset = (id: string) => {
    setPaintActiveTilesetId(id);
    setPaintSel({ c0: 0, r0: 0, c1: 0, r1: 0 });
    setPaintTerrainId(null);
    setPaintBigTileId(null);
  };

  // When the selected tilemap changes, point the painter at its first layer.
  useEffect(() => {
    if (!selectedTilemapMap) { setPaintActiveLayerId(null); return; }
    const stillValid = selectedTilemapMap.layers.some((L) => L.id === paintActiveLayerId);
    if (!stillValid) {
      setPaintActiveLayerId(selectedTilemapMap.layers[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTilemapMap?.id]);

  // ── In-scene paint handlers ───────────────────────────────────────────────
  // Mirrors the TilemapTab painter's logic but dispatches to paintTile /
  // paintTiles directly (no local Tool state living in TilemapTab) — the
  // helpers in tilemapPainter.ts keep the per-tool edit math in one place.
  const paintActive =
    tilemapPaintMode &&
    !!selectedTilemapMap && !!paintTileset && !!paintActiveLayerId;

  const paintAtScene = (col: number, row: number) => {
    if (!selectedTilemapMap || !paintTileset || !paintActiveLayerId) return;
    const cols = selectedTilemapMap.cols, rows = selectedTilemapMap.rows;
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const terrains = paintTileset?.terrains ?? [];
    const rawTerrain = paintTerrainId ? terrains.find((t) => t.id === paintTerrainId) ?? null : null;
    const activeTerrain = rawTerrain ? offsetTerrain(rawTerrain, paintFirstgid) : null;
    const layer = selectedTilemapMap.layers.find((L) => L.id === paintActiveLayerId);
    if (paintTool === "brush") {
      if (paintLastStamp.current && paintLastStamp.current.col === col && paintLastStamp.current.row === row) return;
      const prev = paintLastStamp.current;
      paintLastStamp.current = { col, row };
      const path = prev ? lineCells(prev.col, prev.row, col, row).slice(1) : [{ col, row }];
      if (activeTerrain && layer) {
        const working = layer.tiles.slice();
        const accum: { col: number; row: number; tile: number }[] = [];
        for (const cell of path) {
          const edits = autoTileBrushEdits(working, cols, rows, cell.col, cell.row, activeTerrain);
          for (const e of edits) { working[e.row * cols + e.col] = e.tile; accum.push(e); }
        }
        if (accum.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, accum);
      } else {
        // Transform the selection as ONE block (mirror/rotate cell positions),
        // then tag every stamped cell with paintXf so it flips/rotates as a unit.
        const sC0 = Math.min(paintSel.c0, paintSel.c1);
        const sR0 = Math.min(paintSel.r0, paintSel.r1);
        const selW = Math.abs(paintSel.c1 - paintSel.c0) + 1;
        const selH = Math.abs(paintSel.r1 - paintSel.r0) + 1;
        const tsCols = paintTileset?.cols ?? 1;
        const { cells } = transformedSelection(selW, selH, paintXf);
        const all: { col: number; row: number; tile: number }[] = [];
        for (const cell of path) {
          for (const t of cells) {
            const tCol = cell.col + t.ox, tRow = cell.row + t.oy;
            if (tCol < 0 || tCol >= cols || tRow < 0 || tRow >= rows) continue;
            all.push({ col: tCol, row: tRow, tile: paintFirstgid + (sR0 + t.sr) * tsCols + (sC0 + t.sc) });
          }
        }
        if (all.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, all, paintXf);
      }
    } else if (paintTool === "erase") {
      if (paintLastStamp.current && paintLastStamp.current.col === col && paintLastStamp.current.row === row) return;
      const prev = paintLastStamp.current;
      paintLastStamp.current = { col, row };
      const path = prev ? lineCells(prev.col, prev.row, col, row).slice(1) : [{ col, row }];
      const clipped = path.filter((p) => p.col >= 0 && p.col < cols && p.row >= 0 && p.row < rows);
      if (activeTerrain && layer) {
        const working = layer.tiles.slice();
        const accum: { col: number; row: number; tile: number }[] = [];
        for (const cell of clipped) {
          const edits = autoTileEraseEdits(working, cols, rows, cell.col, cell.row, activeTerrain);
          for (const e of edits) { working[e.row * cols + e.col] = e.tile; accum.push(e); }
        }
        if (accum.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, accum);
      } else {
        const erases = clipped.map((p) => ({ col: p.col, row: p.row, tile: -1 }));
        if (erases.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, erases);
      }
    } else if (paintTool === "picker") {
      if (!layer) return;
      const t = layer.tiles[row * cols + col] ?? -1;
      if (t < 0) return;
      // Resolve which tileset slot owns this GLOBAL id, switch the painter to it,
      // then map the id back to a local palette selection (+ terrain if any).
      const owner = paintSlots.find((s) => t >= s.firstgid && t < s.firstgid + s.count) ?? activePaintSlot;
      if (!owner) return;
      setPaintActiveTilesetId(owner.ts.id);
      const owning = (owner.ts.terrains ?? []).find((tr) =>
        tr.defaultTile + owner.firstgid === t || tr.rules.some((rr) => rr.tile + owner.firstgid === t),
      );
      setPaintTerrainId(owning ? owning.id : null);
      const sel = pickerSelection(t, owner.ts.cols, owner.firstgid);
      if (sel) setPaintSel(sel);
    }
  };

  /** BigTile drag-stroke state — footprint grid anchored at the stroke's first
   *  stamp, so drag-painting tiles composites side-by-side instead of overlap-
   *  deleting the previous one (mirrors TilemapTab's bigStroke). */
  const paintBigStroke = useRef<{ oc: number; or: number; placed: Set<string> } | null>(null);

  /** Place the selected BigTile at (col,row), footprint-grid-snapped within the
   *  active stroke. Returns true when a BigTile brush is active. */
  const placeBigAtScene = (col: number, row: number): boolean => {
    if (!paintBigTileId || !selectedTilemapMap || !paintTileset || !paintActiveLayerId) return false;
    const bt = (paintTileset.bigTiles ?? []).find((b) => b.id === paintBigTileId);
    if (!bt) return true;
    const px = bt.pivotX ?? 0.5;
    const py = bt.pivotY ?? 1;
    const anchorC = Math.max(0, Math.min(selectedTilemapMap.cols - bt.w, col - Math.min(bt.w - 1, Math.floor(px * bt.w))));
    const anchorR = Math.max(0, Math.min(selectedTilemapMap.rows - bt.h, row - Math.min(bt.h - 1, Math.floor(py * bt.h))));
    if (!paintBigStroke.current) {
      paintBigStroke.current = { oc: anchorC, or: anchorR, placed: new Set([`${anchorC},${anchorR}`]) };
      placeBigTile(selectedTilemapMap.id, paintActiveLayerId, paintBigTileId, anchorC, anchorR);
      return true;
    }
    const s = paintBigStroke.current;
    const gc = Math.max(0, Math.min(selectedTilemapMap.cols - bt.w, s.oc + Math.round((anchorC - s.oc) / bt.w) * bt.w));
    const gr = Math.max(0, Math.min(selectedTilemapMap.rows - bt.h, s.or + Math.round((anchorR - s.or) / bt.h) * bt.h));
    const key = `${gc},${gr}`;
    if (!s.placed.has(key)) {
      s.placed.add(key);
      placeBigTile(selectedTilemapMap.id, paintActiveLayerId, paintBigTileId, gc, gr);
    }
    return true;
  };

  const onScenePaintDown = (col: number, row: number, e: MouseEvent) => {
    // BigTile placement — click places one; HOLD + DRAG tiles more side-by-side
    // (footprint-snapped). Click cell is the pivot (trees land trunk-base).
    if (paintBigTileId && selectedTilemapMap && paintTileset && paintActiveLayerId) {
      paintBigStroke.current = null;
      if (placeBigAtScene(col, row)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // Erase tool: hit-test BigTile placements first; deleting a placement
    // takes priority over erasing the underlying cells.
    if (paintTool === "erase" && selectedTilemapMap && paintTileset && paintActiveLayerId) {
      const layer = selectedTilemapMap.layers.find((L) => L.id === paintActiveLayerId);
      const hits = (layer?.bigTilePlacements ?? []).filter((p) => {
        const bt = (paintTileset.bigTiles ?? []).find((b) => b.id === p.bigTileId);
        if (!bt) return false;
        return col >= p.c && col < p.c + bt.w && row >= p.r && row < p.r + bt.h;
      });
      if (hits.length > 0) {
        const target = hits[hits.length - 1];
        removeBigTilePlacement(selectedTilemapMap.id, paintActiveLayerId, target.id);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (!selectedTilemapMap || !paintTileset || !paintActiveLayerId) return;
    e.preventDefault();
    e.stopPropagation();
    paintLastStamp.current = null;
    if (paintTool === "rect") {
      setPaintRectDrag({ c0: col, r0: row, c1: col, r1: row });
      return;
    }
    if (paintTool === "bucket") {
      const layer = selectedTilemapMap.layers.find((L) => L.id === paintActiveLayerId);
      if (!layer) return;
      const cols = selectedTilemapMap.cols, rows = selectedTilemapMap.rows;
      const terrains = paintTileset?.terrains ?? [];
      const rawTerrain = paintTerrainId ? terrains.find((t) => t.id === paintTerrainId) ?? null : null;
      const activeTerrain = rawTerrain ? offsetTerrain(rawTerrain, paintFirstgid) : null;
      if (activeTerrain) {
        const target = layer.tiles[row * cols + col] ?? -1;
        const fill = activeTerrain.defaultTile;
        if (target === fill) return;
        const stack: number[] = [col, row];
        const next = layer.tiles.slice();
        const visited = new Set<number>();
        const filled = new Set<number>();
        while (stack.length > 0) {
          const r = stack.pop()!;
          const c = stack.pop()!;
          if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
          const i = r * cols + c;
          if (visited.has(i)) continue;
          visited.add(i);
          if ((next[i] ?? -1) !== target) continue;
          next[i] = fill;
          filled.add(i);
          stack.push(c + 1, r); stack.push(c - 1, r);
          stack.push(c, r + 1); stack.push(c, r - 1);
        }
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
            if (next[i] !== layer.tiles[i]) edits.push({ col: c, row: r, tile: next[i] });
          }
        }
        if (edits.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, edits);
      } else {
        const tsCols = paintTileset?.cols ?? 1;
        const sC0 = Math.min(paintSel.c0, paintSel.c1);
        const sR0 = Math.min(paintSel.r0, paintSel.r1);
        const fill = tsCols > 0 ? paintFirstgid + sR0 * tsCols + sC0 : 0;
        const edits = bucketEdits(layer.tiles, cols, rows, col, row, fill);
        if (edits.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, edits);
      }
      return;
    }
    paintAtScene(col, row);
  };

  const onScenePaintMove = (col: number, row: number) => {
    // BigTile brush — drag tiles composites side-by-side (footprint-snapped).
    if (paintBigTileId) { placeBigAtScene(col, row); return; }
    if (paintTool === "rect") {
      setPaintRectDrag((d) => (d ? { ...d, c1: col, r1: row } : d));
      return;
    }
    paintAtScene(col, row);
  };

  const onScenePaintUp = () => {
    paintBigStroke.current = null;
    if (paintTool === "rect" && paintRectDrag && selectedTilemapMap && paintTileset && paintActiveLayerId) {
      const terrains = paintTileset.terrains ?? [];
      const rawTerrain = paintTerrainId ? terrains.find((t) => t.id === paintTerrainId) ?? null : null;
      const activeTerrain = rawTerrain ? offsetTerrain(rawTerrain, paintFirstgid) : null;
      const layer = selectedTilemapMap.layers.find((L) => L.id === paintActiveLayerId);
      if (activeTerrain && layer) {
        const edits = autoTileRectEdits(
          layer.tiles, selectedTilemapMap.cols, selectedTilemapMap.rows,
          paintRectDrag.c0, paintRectDrag.r0, paintRectDrag.c1, paintRectDrag.r1,
          activeTerrain,
        );
        if (edits.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, edits);
      } else {
        const edits = rectEdits(paintRectDrag, paintSel, paintTileset.cols, paintFirstgid);
        if (edits.length > 0) paintTiles(selectedTilemapMap.id, paintActiveLayerId, edits, paintXf);
      }
      setPaintRectDrag(null);
    }
    paintLastStamp.current = null;
  };

  // Delete / Backspace removes the currently-selected scene instance(s) —
  // honors the multi-selection set so a rectangle-select followed by Delete
  // wipes everything in one shot. Skip when typing in an input so authors
  // can still hit Backspace inside a number field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
      const curIds = (): string[] => {
        const s = new Set<string>(multiSelected);
        if (selectedId) s.add(selectedId);
        return Array.from(s);
      };
      // Copy / Paste / Duplicate. Paste cascades its offset so repeated pastes
      // don't stack exactly on top of each other.
      if (mod && (e.key === "c" || e.key === "C")) {
        const ids = curIds();
        if (ids.length) { clipboardRef.current = { ids, pastes: 0 }; e.preventDefault(); }
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        const cb = clipboardRef.current;
        if (!cb || cb.ids.length === 0) return;
        e.preventDefault();
        cb.pastes += 1;
        const off = 16 * cb.pastes;
        const newIds = duplicateSelection(cb.ids, off, off);
        if (newIds.length) { select(newIds[0]); setMultiSelected(new Set(newIds)); }
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        const ids = curIds();
        if (!ids.length) return;
        e.preventDefault();
        const newIds = duplicateSelection(ids, 16, 16);
        if (newIds.length) { select(newIds[0]); setMultiSelected(new Set(newIds)); }
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Build the id set: multi if non-empty, plus the primary selection.
      const ids = new Set<string>(multiSelected);
      if (selectedId) ids.add(selectedId);
      if (ids.size === 0) return;
      e.preventDefault();
      for (const id of ids) {
        const isBp = scene.instances.some((i) => i.id === id);
        const isUI = (scene.uiInstances ?? []).some((i) => i.id === id);
        const isTilemap = (scene.tilemapInstances ?? []).some((i) => i.id === id);
        const isPlacement = (scene.spritePlacements ?? []).some((p) => p.id === id);
        if (isBp) removeInstance(id);
        else if (isUI) removeUIWidgetInstance(id);
        else if (isTilemap) removeTilemapInstance(scene.id, id);
        else if (isPlacement) removeSpritePlacement(id);
      }
      select(null);
      setMultiSelected(new Set());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, multiSelected, scene.instances, scene.uiInstances, scene.tilemapInstances, scene.spritePlacements, scene.id, removeInstance, removeUIWidgetInstance, removeTilemapInstance, removeSpritePlacement, select, duplicateSelection, setMultiSelected]);

  /** Wheel zoom — scrolling up zooms in, down zooms out. Uses ZOOM_STEP per
   *  notch so feels consistent regardless of mouse-wheel sensitivity.
   *  Zoom orbits the canvas's parent-flex center; pan is unchanged. */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setUserZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor)));
  };

  // Active rectangle-select drag — left-click + Shift on empty canvas
  // starts one. Stores world-space corners; render overlay on every
  // mousemove + finalize on mouseup by intersecting with instance bounds.
  const rectDrag = useRef<{ startX: number; startY: number; endX: number; endY: number; additive: boolean } | null>(null);
  const [rectDragVisual, setRectDragVisual] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  const drag = useRef<{ id: string; offsetX: number; offsetY: number; kind: "bp" | "ui" | "tilemap" | "placement" } | null>(null);
  /** Active resize-handle drag. Carries the starting instance bounds + the
   *  handle being dragged, so onMouseMove can compute the new w/h/x/y per
   *  handle direction (corner handles edit two axes; edge handles edit one). */
  const resizeRef = useRef<{
    id: string;
    handle: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    startClientX: number;
    startClientY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    /** Which instance kind to dispatch updates to. Placements AND BP instances
     *  both resize via scaleX/scaleY now (so the gizmo matches the inspector's
     *  Scale X/Y and never double-scales); "bp" is the legacy w/h path. */
    kind?: "bp" | "placement" | "bpScale";
    /** For placements: the base width/height (sprite asset size) used to
     *  convert pixel deltas into scale changes. */
    baseW?: number;
    baseH?: number;
  } | null>(null);
  /** True if the user has actually moved the mouse during a drag — used to
   *  distinguish "click to select" from "drag to move". A click that didn't
   *  move shouldn't re-trigger the canvas's deselect. */
  const dragMoved = useRef(false);

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-peaky-asset")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: DragEvent) => {
    const raw = e.dataTransfer.getData("application/x-peaky-asset");
    if (!raw || !containerRef.current) return;
    e.preventDefault();
    const [kind, id] = raw.split(":");
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    if (kind === "blueprint") {
      placeInstance(id, x, y);
    } else if (kind === "sprite") {
      // Direct sprite placement — no Blueprint wrapper. Spawns at the
      // drop point on the scene's active layer, default animation, plays
      // by default. Author can re-target via the right rail inspector.
      const newId = addSpritePlacement(id, x, y);
    } else if (kind === "uiwidget") {
      // UI widgets live on a parallax-(0,0) layer at runtime — their
      // x/y is interpreted as VIEWPORT-relative (canvas coords), not
      // world. So convert the drop position from world coords to
      // coords relative to the viewport rectangle's top-left. This way
      // dropping at the visible center of the viewport rectangle in
      // the editor lands the widget at the visible center of the
      // game canvas at runtime.
      placeUIWidgetInstance(id, x - vpPos.x, y - vpPos.y);
    } else if (kind === "tilemap") {
      // Tilemap instances anchor on their TOP-LEFT (Tiled convention) so the
      // drop position lands the grid's top-left where the user dropped it.
      // The active layer is whichever the scene currently focuses (mirrors
      // BP placement); fall back to the topmost layer when none is set.
      const layerId = scene.activeLayerId || scene.layers[0]?.id;
      if (layerId) addTilemapInstance(scene.id, { tilemapId: id, x: Math.round(x), y: Math.round(y), layerId });
    }
    // Other asset kinds (sprite, scene, dialogue) aren't draggable
    // into the scene canvas — drop is a no-op.
  };

  const onMouseDown = (e: MouseEvent, id: string, _w: number, _h: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Lock check — instance-level OR its layer locked. Either way: no
    // selection, no drag. Click falls through to the canvas marquee.
    const lockedInst = scene.instances.find((i) => i.id === id);
    if (lockedInst?.locked) return;
    const instLayer = scene.layers.find((l) => l.id === (lockedInst?.layerId ?? scene.activeLayerId));
    if (instLayer?.locked) return;
    // Shift / Ctrl / Cmd-click → toggle into the multi-selection set
    // instead of replacing the primary selection. The most-recently-added
    // id becomes the primary so the inspector tracks it. Skip the drag
    // setup so dragging starts on a regular click only.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (selectedId && selectedId !== id) next.add(selectedId);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      select(id);
      return;
    }
    // Plain click clears the multi set if it was non-empty.
    if (multiSelected.size > 0) setMultiSelected(new Set());
    select(id);
    const inst = scene.instances.find((i) => i.id === id);
    if (!inst) return;
    if (!containerRef.current) return;
    // Anchor offset off the CANVAS rect, not the sprite-div rect. The
    // sprite-div's top-left differs from `inst.x - w/2` for sprite-bearing
    // BPs (gizmo is anchored to the image pivot, not the body center) —
    // using the canvas rect makes the math work uniformly: offset = cursor
    // world position minus instance center, regardless of gizmo shape.
    const canvasRect = containerRef.current.getBoundingClientRect();
    const cursorWorldX = (e.clientX - canvasRect.left) / scale;
    const cursorWorldY = (e.clientY - canvasRect.top)  / scale;
    drag.current = {
      id,
      offsetX: cursorWorldX - inst.x,
      offsetY: cursorWorldY - inst.y,
      kind: "bp",
    };
    dragMoved.current = false;
  };

  /** Mouse-down on a SpritePlacement — same drag pattern as BP instances,
   *  but dispatches to `updateSpritePlacement` in onMouseMove via the
   *  drag-ref's `kind` discriminator. Placements have no lock field yet,
   *  so the layer-lock check is the only guard. */
  const onPlacementMouseDown = (e: MouseEvent, id: string, _w: number, _h: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const placement = (scene.spritePlacements ?? []).find((p) => p.id === id);
    if (!placement) return;
    const instLayer = scene.layers.find((l) => l.id === placement.layerId);
    if (instLayer?.locked) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (selectedId && selectedId !== id) next.add(selectedId);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      select(id);
      return;
    }
    if (multiSelected.size > 0) setMultiSelected(new Set());
    select(id);
    if (!containerRef.current) return;
    const canvasRect = containerRef.current.getBoundingClientRect();
    const cursorWorldX = (e.clientX - canvasRect.left) / scale;
    const cursorWorldY = (e.clientY - canvasRect.top)  / scale;
    drag.current = {
      id,
      offsetX: cursorWorldX - placement.x,
      offsetY: cursorWorldY - placement.y,
      kind: "placement",
    };
    dragMoved.current = false;
  };

  /** Mouse-down on a UI Widget instance — same drag pattern as BP
   *  instances, but dispatches to `updateUIWidgetInstance` in onMouseMove
   *  via the drag-ref's `kind` discriminator. */
  const onUIMouseDown = (e: MouseEvent, id: string, _w: number, _h: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const lockedInst = (scene.uiInstances ?? []).find((i) => i.id === id);
    if (lockedInst?.locked) return;
    const instLayer = scene.layers.find((l) => l.id === (lockedInst?.layerId ?? scene.activeLayerId));
    if (instLayer?.locked) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (selectedId && selectedId !== id) next.add(selectedId);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      select(id);
      return;
    }
    if (multiSelected.size > 0) setMultiSelected(new Set());
    select(id);
    const inst = (scene.uiInstances ?? []).find((i) => i.id === id);
    if (!inst) return;
    if (!containerRef.current) return;
    const canvasRect = containerRef.current.getBoundingClientRect();
    const cursorWorldX = (e.clientX - canvasRect.left) / scale;
    const cursorWorldY = (e.clientY - canvasRect.top)  / scale;
    // UI widgets are stored viewport-relative — fold vpPos into the
    // anchor so the offset is in canvas-world space, matching onMouseMove.
    drag.current = {
      id,
      offsetX: cursorWorldX - (vpPos.x + inst.x),
      offsetY: cursorWorldY - (vpPos.y + inst.y),
      kind: "ui",
    };
    dragMoved.current = false;
  };

  /** Mouse-down on a Tilemap instance — drag handling, world-space (the
   *  instance stores world coords, top-left anchored). Same shape as the
   *  BP / UI handlers; the drag-ref's `kind` discriminator routes the
   *  per-axis update inside onMouseMove. */
  const onTilemapMouseDown = (e: MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const lockedInst = (scene.tilemapInstances ?? []).find((i) => i.id === id);
    if (lockedInst?.locked) return;
    const instLayer = scene.layers.find((l) => l.id === (lockedInst?.layerId ?? scene.activeLayerId));
    if (instLayer?.locked) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (selectedId && selectedId !== id) next.add(selectedId);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      select(id);
      return;
    }
    if (multiSelected.size > 0) setMultiSelected(new Set());
    select(id);
    const inst = (scene.tilemapInstances ?? []).find((i) => i.id === id);
    if (!inst) return;
    if (!containerRef.current) return;
    const canvasRect = containerRef.current.getBoundingClientRect();
    const cursorWorldX = (e.clientX - canvasRect.left) / scale;
    const cursorWorldY = (e.clientY - canvasRect.top)  / scale;
    drag.current = {
      id,
      offsetX: cursorWorldX - inst.x,
      offsetY: cursorWorldY - inst.y,
      kind: "tilemap",
    };
    dragMoved.current = false;
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!containerRef.current) return;
    // Rectangle-select drag — update the live overlay each move.
    if (rectDrag.current) {
      const r0 = containerRef.current.getBoundingClientRect();
      const wx = (e.clientX - r0.left) / scale;
      const wy = (e.clientY - r0.top)  / scale;
      rectDrag.current.endX = wx;
      rectDrag.current.endY = wy;
      setRectDragVisual({
        x1: rectDrag.current.startX,
        y1: rectDrag.current.startY,
        x2: wx,
        y2: wy,
      });
      return;
    }
    // Pan drag — adjust pan offset based on mouse movement in screen px.
    if (panDrag.current) {
      setPan({
        x: panDrag.current.origX + (e.clientX - panDrag.current.startX),
        y: panDrag.current.origY + (e.clientY - panDrag.current.startY),
      });
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    if (vpDrag.current) {
      const x = (e.clientX - rect.left) / scale - vpDrag.current.dx;
      const y = (e.clientY - rect.top)  / scale - vpDrag.current.dy;
      // Clamp to layout bounds so the rectangle can't escape.
      const cx = Math.max(0, Math.min(scene.width  - viewportW, x));
      const cy = Math.max(0, Math.min(scene.height - viewportH, y));
      setVpPos({ x: cx, y: cy });
      return;
    }
    // Handle resize drag: convert mouse delta from screen px to scene px,
    // apply to width/height per the handle direction. Top/left handles
    // also shift x/y by HALF the size delta so the OPPOSITE edge stays
    // anchored (instances are positioned by center).
    if (resizeRef.current) {
      dragMoved.current = true;
      const r = resizeRef.current;
      const dx = (e.clientX - r.startClientX) / scale;
      const dy = (e.clientY - r.startClientY) / scale;
      let w = r.origW;
      let h = r.origH;
      let cx = r.origX;
      let cy = r.origY;
      const m = r.handle;
      if (m.includes("e")) { w = r.origW + dx; cx = r.origX + dx / 2; }
      if (m.includes("w")) { w = r.origW - dx; cx = r.origX + dx / 2; }
      if (m.includes("s")) { h = r.origH + dy; cy = r.origY + dy / 2; }
      if (m.includes("n")) { h = r.origH - dy; cy = r.origY + dy / 2; }
      const minSize = 4;
      if (w < minSize) w = minSize;
      if (h < minSize) h = minSize;
      if (r.kind === "placement" && r.baseW && r.baseH) {
        // Placements store scaleX/scaleY, not w/h. Convert pixel size
        // back into scale relative to the sprite asset's base dimensions.
        updateSpritePlacement(r.id, {
          scaleX: w / r.baseW,
          scaleY: h / r.baseH,
          x: Math.round(cx),
          y: Math.round(cy),
        });
      } else if (r.kind === "bpScale" && r.baseW && r.baseH) {
        // BP instances resize into scaleX/scaleY (the field the inspector shows)
        // and CLEAR the legacy w/h override, so the gizmo and inspector are one
        // scale — no more "gizmo says big, inspector says 1, then ×2 compounds".
        update(r.id, {
          scaleX: w / r.baseW,
          scaleY: h / r.baseH,
          w: undefined,
          h: undefined,
          x: Math.round(cx),
          y: Math.round(cy),
        });
      } else {
        update(r.id, {
          w: Math.round(w),
          h: Math.round(h),
          x: Math.round(cx),
          y: Math.round(cy),
        });
      }
      return;
    }
    if (!drag.current) return;
    dragMoved.current = true;
    const x = (e.clientX - rect.left) / scale - drag.current.offsetX;
    const y = (e.clientY - rect.top)  / scale - drag.current.offsetY;
    if (drag.current.kind === "ui") {
      // UI widgets store viewport-relative coords (see onDrop).
      updateUIWidgetInstance(drag.current.id, { x: x - vpPos.x, y: y - vpPos.y });
    } else if (drag.current.kind === "placement") {
      // Direct sprite placements — world coords, same as BP instances.
      updateSpritePlacement(drag.current.id, { x: Math.round(x), y: Math.round(y) });
    } else if (drag.current.kind === "tilemap") {
      // Snap dragged tilemap positions to the tileset's tile grid so adjacent
      // placements align cleanly. Holding Alt overrides for free pixel-level
      // placement when the author needs sub-tile alignment. Without snap,
      // even a 1-pixel offset between two chunks of the same tilemap shows
      // as a tear at the seam.
      const ti = (scene.tilemapInstances ?? []).find((t) => t.id === drag.current!.id);
      const map = ti ? (tilemaps ?? []).find((m) => m.id === ti.tilemapId) : null;
      const ts = map ? (tilesets ?? []).find((t) => t.id === map.tilesetId) : null;
      const snap = !e.altKey && ts && ts.tileW > 0 && ts.tileH > 0;
      const snapX = snap ? Math.round(x / ts!.tileW) * ts!.tileW : Math.round(x);
      const snapY = snap ? Math.round(y / ts!.tileH) * ts!.tileH : Math.round(y);
      updateTilemapInstance(scene.id, drag.current.id, { x: snapX, y: snapY });
    } else {
      update(drag.current.id, { x, y });
    }
  };

  const onMouseUp = () => {
    // Finalize rectangle-select if active. Find every BP instance whose
    // bounding box intersects the dragged rect (in world coords, since
    // both rect and instances are stored in the same world space).
    if (rectDrag.current) {
      const r = rectDrag.current;
      const x1 = Math.min(r.startX, r.endX);
      const x2 = Math.max(r.startX, r.endX);
      const y1 = Math.min(r.startY, r.endY);
      const y2 = Math.max(r.startY, r.endY);
      // Click-with-no-drag (zero-area rect) clears selection rather than
      // selecting nothing — matches "click empty bg" behavior.
      const dragged = (x2 - x1) > 1 || (y2 - y1) > 1;
      if (dragged) {
        const bp = blueprintFor;
        const hits: string[] = [];
        for (const inst of scene.instances) {
          const def = bp(inst);
          const w = inst.w ?? def?.w ?? 32;
          const h = inst.h ?? def?.h ?? 32;
          const ix1 = inst.x - w / 2;
          const ix2 = inst.x + w / 2;
          const iy1 = inst.y - h / 2;
          const iy2 = inst.y + h / 2;
          // AABB-vs-AABB intersection test.
          if (ix2 >= x1 && ix1 <= x2 && iy2 >= y1 && iy1 <= y2) hits.push(inst.id);
        }
        // Additive (Shift held during drag) merges with prior multi
        // selection; non-additive replaces it.
        const next = new Set<string>(r.additive ? multiSelected : []);
        if (r.additive && selectedId) next.add(selectedId);
        for (const id of hits) next.add(id);
        // Promote one hit to primary (the inspector shows the primary).
        const primary = hits.length > 0 ? hits[hits.length - 1] : (selectedId ?? null);
        next.delete(primary ?? "");
        setMultiSelected(next);
        select(primary);
      }
      rectDrag.current = null;
      setRectDragVisual(null);
    }
    drag.current = null;
    vpDrag.current = null;
    panDrag.current = null;
    resizeRef.current = null;
  };

  /** Pan when middle-mouse drag, OR left-click drag started on the empty
   *  canvas background (i.e. not on an instance / viewport rect). Instance
   *  + viewport-rect mousedowns stopPropagation so they take priority.
   *  Shift+left-drag on empty bg → rectangle-select instead of pan. */
  const onCanvasMouseDown = (e: MouseEvent) => {
    const isMiddle = e.button === 1;
    const isLeftBg = e.button === 0;
    if (!isMiddle && !isLeftBg) return;
    e.preventDefault();
    if (isLeftBg && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const wx = (e.clientX - r.left) / scale;
      const wy = (e.clientY - r.top)  / scale;
      rectDrag.current = {
        startX: wx, startY: wy, endX: wx, endY: wy,
        // Shift held = additive: existing multi-selection is preserved
        // and the rect's hits are added on mouseup. Without modifier the
        // rect REPLACES the selection. Mirrors most editors' behavior.
        additive: true,
      };
      setRectDragVisual({ x1: wx, y1: wy, x2: wx, y2: wy });
      return;
    }
    panDrag.current = {
      startX: e.clientX, startY: e.clientY,
      origX: pan.x, origY: pan.y,
    };
  };

  return (
    <>
    {createPortal(
      <button
        onClick={() => { if (!navMode) ensureNavMesh(scene.id); setNavMode((v) => !v); }}
        title="Paint navigation mesh — walkable areas, obstacles, waypoints"
        style={{
          position: "fixed", top: vpBox.top + 10, left: vpBox.left + 10, zIndex: 90,
          padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer",
          borderRadius: 5, border: "1px solid rgba(120,210,140,0.5)",
          background: navMode ? "rgba(120,210,140,0.85)" : "rgba(20,22,30,0.92)",
          color: navMode ? "#0a1810" : "#7fe0a0",
        }}
      >{navMode ? "✕ Exit Nav" : "Nav Mesh"}</button>,
      document.body,
    )}
    {!navMode && scene.navMesh && createPortal(
      <button
        onClick={() => setShowNavObjects((v) => !v)}
        title="Show/hide nav waypoints + obstacles while editing normally"
        style={{
          position: "fixed", top: vpBox.top + 10, left: vpBox.left + 96, zIndex: 90,
          padding: "5px 10px", fontSize: 11, cursor: "pointer", borderRadius: 5,
          border: "1px solid rgba(120,160,255,0.45)",
          background: showNavObjects ? "rgba(90,140,230,0.7)" : "rgba(20,22,30,0.92)",
          color: showNavObjects ? "#fff" : "#9bd0ff",
        }}
      >{showNavObjects ? "◉ Nav Objs" : "○ Nav Objs"}</button>,
      document.body,
    )}
    <div
      ref={containerRef}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onMouseDown={onCanvasMouseDown}
      onWheel={onWheel}
      onClick={(e) => {
        // Only deselect on a clean click of the canvas BACKGROUND. Instance
        // clicks bubble up here too — without the target check, selecting an
        // instance would immediately re-deselect on mouse-up. Pan/resize/move
        // drags also reach onClick once the mouse is released; skip those.
        if (e.target !== e.currentTarget) return;
        if (dragMoved.current) { dragMoved.current = false; return; }
        select(null);
        if (multiSelected.size > 0) setMultiSelected(new Set());
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        width: scene.width * scale,
        height: scene.height * scale,
        background: `#${scene.backgroundColor.toString(16).padStart(6, "0")}`,
        // Center via absolute + translate(-50%, -50%) instead of relying on
        // the parent's flex centering: when the canvas overflows the
        // parent, browsers can place a flex child at the START (top-left)
        // rather than keeping it centered. Absolute positioning + transform
        // centering is robust to overflow and gives the same look at every
        // zoom level. Pan stacks on top of the centering translate.
        position: "absolute",
        left: "50%",
        top: "50%",
        boxShadow: "0 0 8px rgba(0,0,0,0.06)",
        cursor: panDrag.current ? "grabbing" : drag.current ? "grabbing" : "grab",
        // Children with overflow visible can sit outside the canvas rect
        // (instances placed beyond layout bounds remain visible — useful
        // when shrinking the layout to find off-bounds objects).
        overflow: "visible",
        transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
      }}
    >
      {navMode && scene.navMesh && <NavMeshOverlay scene={scene} />}
      {!navMode && showNavObjects && scene.navMesh && <NavMeshView scene={scene} />}
      {/* Tilemap instance previews — drawn BEFORE gameplay instances so the
          map sits behind characters in DOM order. Each placement is ONE
          <canvas> rendered by drawTilemap (drawImage per tile) — switching
          off per-cell divs is what makes thousand-tile maps editable
          without freezing the editor.

          Drawn in RUNTIME depth order (matching runProject): a tilemap on a
          lower scene layer, or a lower per-instance z, sits behind one above
          it. Sort ascending so the back-most draws first (DOM order = paint
          order). Without this the scene viewport stacked tilemaps by array
          order, so it never matched the runtime z. */}
      {[...(scene.tilemapInstances ?? [])]
        .map((ti) => {
          const li = scene.layers.findIndex((l) => l.id === ti.layerId);
          // layers[0] is top-most → highest depth; missing layer sinks to back.
          const layerDepth = li < 0 ? -Infinity : (scene.layers.length - 1 - li) * 1_000_000;
          return { ti, depth: layerDepth + (ti.z ?? 0) * 1000 };
        })
        .sort((a, b) => a.depth - b.depth)
        .map(({ ti }) => {
        const map = (tilemaps ?? []).find((m) => m.id === ti.tilemapId);
        if (!map) return null;
        // Match the RUNTIME: it renders from ALL the map's tilesets (the first
        // slot supplies the cell size), so the scene preview must too — else a
        // map whose primary tileset was deleted/emptied shows at runtime + in
        // the outliner but vanishes here.
        const slots = tilemapTilesets(map, tilesets ?? []);
        const ts = slots[0]?.ts;
        if (!ts || ts.cols === 0 || !slots.some((s) => s.ts.imageFile)) return null;
        const layer = scene.layers.find((l) => l.id === ti.layerId);
        if (!layer) return null;
        const layerAlpha = (layer.visible ? 1 : 0.3) * layer.opacity;
        const isSelected = ti.id === selectedId || multiSelected.has(ti.id);
        const isLocked = !!ti.locked || !!layer.locked;
        const fullW = map.cols * ts.tileW;
        const fullH = map.rows * ts.tileH;
        const isPaintTarget = isSelected && paintActive && selectedTilemapInst?.id === ti.id;
        // z-index = layer rank (higher layer = on top), tilemap band (100) sits
        // BELOW the instance band (500) of the same layer but ABOVE everything on
        // lower layers — so a sprite on a background layer is correctly covered
        // by a higher layer's tilemap, matching the runtime. NEGATIVE base keeps
        // ALL gameplay below the scene's z-auto overlays (UI, camera bounds, the
        // viewport/colliders toggle) without having to bump each of those.
        const tmLayerIdx = scene.layers.findIndex((l) => l.id === ti.layerId);
        const tmZ = -100000 + (tmLayerIdx < 0 ? 0 : (scene.layers.length - 1 - tmLayerIdx)) * 1000 + 100;
        return (
          <ScenePlacedTilemap
            key={ti.id}
            ti={ti}
            map={map}
            ts={ts}
            tilesets={tilesets ?? []}
            scale={scale}
            zIndex={tmZ}
            isSelected={isSelected}
            isLocked={isLocked}
            layerAlpha={layerAlpha * (ti.alpha ?? 1)}
            fullW={fullW}
            fullH={fullH}
            showColliders={showColliders}
            onMouseDown={(e) => onTilemapMouseDown(e, ti.id)}
            onDoubleClick={(e) => { e.stopPropagation(); openTilemapTab(ti.id); }}
            paintActive={isPaintTarget}
            paintRectDrag={isPaintTarget ? paintRectDrag : null}
            paintSel={isPaintTarget ? paintSel : null}
            paintTilesetId={isPaintTarget ? (activePaintSlot?.ts.id ?? null) : null}
            paintTool={isPaintTarget ? paintTool : undefined}
            paintXf={isPaintTarget ? paintXf : 0}
            onPaintDown={onScenePaintDown}
            onPaintMove={onScenePaintMove}
            onPaintUp={onScenePaintUp}
          />
        );
      })}

      {/* Render instances back-to-front: iterate layers in reverse so the
          last layer (Background) renders first in DOM, and the first layer
          (UI) renders last → on top. Instances skip rendering when their
          layer is missing; layer.visible=false dims to 30% with a badge. */}
      {[...scene.layers].reverse().flatMap((layer) =>
        scene.instances
          .filter((inst) => (inst.layerId ?? scene.activeLayerId) === layer.id)
          // Within a layer, sort by per-instance z so editor stacking
          // matches runtime: low z draws first (bottom), high z last (top).
          .slice()
          .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
          .map((inst) => {
        const bp = blueprintFor(inst);
        if (!bp) return null;
        const isSelected = inst.id === selectedId || multiSelected.has(inst.id);
        // Lock state — pointer-events:none on the div so clicks pass
        // through to whatever's beneath. See the UI instance render for
        // the longer rationale.
        const isLocked = !!inst.locked || !!layer.locked;

        const renderer = bp.behaviors.find((b) => b.kind === "SpriteRenderer")
                      ?? bp.behaviors.find((b) => b.kind === "TiledBackground");
        // Per-instance spriteId override beats the BP-configured sprite.
        const effectiveSpriteId = inst.spriteId || (renderer ? String(renderer.config.spriteId ?? "") : "");
        const sprite: SpriteAsset | undefined = renderer
          ? sprites.find((s) => s.id === effectiveSpriteId)
          : undefined;
        const animName = renderer
          ? (inst.spriteAnimation || String(renderer.config.currentAnimation ?? "") || sprite?.animations[0]?.name || "")
          : "";
        const anim = sprite?.animations.find((a) => a.name === animName) ?? sprite?.animations[0];
        // Per-instance posed frame (>=0) wins; else the SpriteRenderer
        // component's `frame` field; else frame 0. Matches the runtime.
        const compFrame = renderer ? Number(renderer.config.frame ?? -1) : -1;
        const poseFrame = typeof inst.spriteFrame === "number" && inst.spriteFrame >= 0
          ? inst.spriteFrame
          : (compFrame >= 0 ? compFrame : 0);
        const frameIdx = Math.max(0, Math.min((anim?.frames.length ?? 1) - 1, poseFrame));
        const firstFrame = anim?.frames[frameIdx];
        const hasText = bp.behaviors.some((b) => b.kind === "Text");

        // baseW/baseH = the BP's default size (sprite asset wins if there is
        // one). w/h = the EFFECTIVE size after the instance's optional
        // override is applied. sX/sY = how much the instance is scaled vs
        // the default — used to scale the inner image proportionally so a
        // resized instance keeps its art aspect.
        const baseW = sprite ? sprite.width : bp.w;
        const baseH = sprite ? sprite.height : bp.h;
        const w = inst.w ?? baseW;
        const h = inst.h ?? baseH;
        const sX = baseW > 0 ? w / baseW : 1;
        const sY = baseH > 0 ? h / baseH : 1;

        // Camera BPs are viewport gizmos — render as dashed outline with a
        // glyph instead of a solid rect, so they read distinctly from
        // entities-in-the-world.
        const isCamera = bp.classKind === "Camera";
        const isControllerGizmo = isCamera;
        const showRectFill = !firstFrame?.imageFile && !hasText && !bp.hideRect && !isControllerGizmo;
        // Outline component → CSS drop-shadow outline on the instance sprite so
        // the highlight shows in the scene editor like it does at runtime.
        const outlineFilter = (() => {
          const ob = bp.behaviors.find((b) => b.kind === "Outline");
          if (!ob || Number(ob.config.on ?? 1) === 0) return undefined;
          const t = Math.max(0, Number(ob.config.thickness ?? 4)) * scale;
          if (t <= 0) return undefined;
          const c = `#${(Number(ob.config.color ?? 0xffe24a) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
          const d = t.toFixed(1);
          return `drop-shadow(${d}px 0 0 ${c}) drop-shadow(-${d}px 0 0 ${c}) drop-shadow(0 ${d}px 0 ${c}) drop-shadow(0 -${d}px 0 ${c}) drop-shadow(${d}px ${d}px 0 ${c}) drop-shadow(-${d}px ${d}px 0 ${c}) drop-shadow(${d}px -${d}px 0 ${c}) drop-shadow(-${d}px -${d}px 0 ${c})`;
        })();
        // Layer-driven dim: hidden layers stay visible in editor at 30%
        // so users can still find / select them. Layer opacity multiplies in.
        const layerAlpha = (layer.visible ? 1 : 0.3) * layer.opacity;

        // Gizmo / click-target box. For sprite-bearing BPs the box wraps
        // the visible (possibly cropped) frame so the resize handles
        // align with what the user actually sees — instead of staying
        // anchored to the uncropped sprite-asset size. Image pivot lives
        // at (inst.x, inst.y); the box top-left is the image's top-left.
        // For text / rect-fill / empty BPs we keep the legacy centered
        // (w × h) box so a placement gizmo still exists.
        const imgW = firstFrame?.imageW ?? baseW;
        const imgH = firstFrame?.imageH ?? baseH;
        const pivotPxX = firstFrame?.pivotX ?? imgW / 2;
        const pivotPxY = firstFrame?.pivotY ?? imgH / 2;
        const gizmoW = firstFrame?.imageFile ? imgW * sX : w;
        const gizmoH = firstFrame?.imageFile ? imgH * sY : h;
        const gizmoLeft = firstFrame?.imageFile
          ? inst.x - pivotPxX * sX
          : inst.x - w / 2;
        const gizmoTop = firstFrame?.imageFile
          ? inst.y - pivotPxY * sY
          : inst.y - h / 2;

        // Scene-editor stacking fix for TiledBackground BPs. The editor
        // renders BPs in HTML order per scene-layer position — if the
        // BG layer sits at the TOP of the layer list (most common when
        // the author just added it), its BPs would otherwise render
        // OVER tilemaps on layers below. Push them visually behind so
        // the editor matches the runtime (where Phaser depth is forced
        // to MIN_SAFE_INTEGER for TiledBackground tile sprites).
        const isTiledBg = bp.behaviors.some((b) => b.kind === "TiledBackground");
        // z-index = layer rank (higher layer on top) + the instance band (500),
        // which sits ABOVE the tilemap band (100) of the same layer but below
        // higher layers' tilemaps — so a higher-layer tilemap correctly covers a
        // sprite on a background layer, matching the runtime. Negative base keeps
        // all gameplay below the z-auto overlays. TiledBackground stays at the
        // very back.
        const instLayerIdx = scene.layers.findIndex((l) => l.id === layer.id);
        const instZIndex = isTiledBg
          ? -1000000
          : -100000 + (instLayerIdx < 0 ? 0 : (scene.layers.length - 1 - instLayerIdx)) * 1000 + 500;
        // Per-instance visual scale + angle preview. Applied to the WHOLE gizmo
        // box (incl. selection outline) so it reads rotated/scaled and matches
        // Play. Origin = the placement point (inst.x, inst.y) within the box —
        // the frame pivot for sprite BPs, else the box center. `rotate() scale()`
        // order mirrors Phaser (scale then rotate). Click hit-testing follows the
        // CSS transform automatically since the handlers live on this same div.
        const instScaleX = inst.scaleX ?? 1, instScaleY = inst.scaleY ?? 1;
        const instAngle = inst.angle ?? 0;
        const instTransform = (instAngle !== 0 || instScaleX !== 1 || instScaleY !== 1)
          ? `rotate(${instAngle}deg) scale(${instScaleX}, ${instScaleY})`
          : undefined;
        const instOriginX = firstFrame?.imageFile ? pivotPxX * sX * scale : (gizmoW * scale) / 2;
        const instOriginY = firstFrame?.imageFile ? pivotPxY * sY * scale : (gizmoH * scale) / 2;
        return (
          <div
            key={inst.id}
            onMouseDown={(e) => onMouseDown(e, inst.id, w, h)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); openBlueprintTab(bp.id); }}
            style={{
              position: "absolute",
              left: gizmoLeft * scale,
              top:  gizmoTop  * scale,
              width:  gizmoW * scale,
              height: gizmoH * scale,
              opacity: layerAlpha,
              pointerEvents: isLocked ? "none" : undefined,
              zIndex: instZIndex,
              background: showRectFill
                ? `#${bp.color.toString(16).padStart(6, "0")}`
                : "transparent",
              outline: isSelected
                ? `2px solid var(--yellow)`
                : isControllerGizmo
                  ? `1.5px dashed #${bp.color.toString(16).padStart(6, "0")}`
                  : showRectFill
                    ? "1px solid rgba(255,255,255,0.1)"
                    : "none",
              cursor: "grab",
              // Allow resize handles (children) to render outside the box.
              // Inner art is positioned absolutely so it still clips visually
              // to the rect via its own bounds, not via overflow:hidden.
              overflow: "visible",
              transform: instTransform,
              transformOrigin: instTransform ? `${instOriginX}px ${instOriginY}px` : undefined,
            }}
            title={`${bp.name} · ${layer.name}${!layer.visible ? " (hidden)" : ""}`}
          >
            {isControllerGizmo && (
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: Math.max(10, Math.min(gizmoW, gizmoH) * scale * 0.5),
                  pointerEvents: "none",
                  userSelect: "none",
                  filter: "saturate(0.6)",
                }}
              >📷</span>
            )}
            {firstFrame?.imageFile && sprite && !isControllerGizmo && (
              // Image fills the gizmo box exactly — the box was sized to
              // the visible (possibly cropped) frame above, so no inner
              // pivot offset is needed here.
              <FrameThumb
                sprite={sprite}
                frame={firstFrame}
                style={{
                  position: "absolute",
                  left: 0,
                  top:  0,
                  width:  gizmoW * scale,
                  height: gizmoH * scale,
                  imageRendering: "pixelated",
                  pointerEvents: "none",
                  filter: outlineFilter,
                  transform: (() => {
                    if (renderer?.kind !== "TiledBackground") return undefined;
                    const fx = renderer.config.flipX ? -1 : 1;
                    const fy = renderer.config.flipY ? -1 : 1;
                    return fx === 1 && fy === 1 ? undefined : `scale(${fx}, ${fy})`;
                  })(),
                  transformOrigin: "center center",
                }}
              />
            )}
            {/* WeaponSlot overlays — render each equipped weapon at its
                host image-point (gizmo-relative). Falls back to the host
                pivot when the named point isn't on the host's first frame. */}
            {bp.behaviors.filter((b) => b.kind === "WeaponSlot").map((wb, wi) => (
              <SceneWeaponSlotPreview
                key={`ws-${wi}`}
                cfg={wb.config as Record<string, unknown>}
                sprites={sprites}
                hostFirstFrame={firstFrame}
                hostPivotInGizmoX={pivotPxX * sX * scale}
                hostPivotInGizmoY={pivotPxY * sY * scale}
                hostScaleX={sX}
                hostScaleY={sY}
                scale={scale}
              />
            ))}
            {!layer.visible && (
              <span
                style={{
                  position: "absolute", top: 2, right: 2,
                  fontSize: 10, padding: "1px 4px",
                  background: "rgba(0,0,0,0.6)", color: "var(--text-2)",
                  borderRadius: 3, pointerEvents: "none",
                }}
                title={`Layer "${layer.name}" is hidden`}
              >🚫</span>
            )}
            {(layer.parallaxX !== 1 || layer.parallaxY !== 1) && (
              <span
                style={{
                  position: "absolute", bottom: 2, left: 2,
                  fontSize: 9, padding: "0 3px",
                  background: "rgba(0,0,0,0.5)", color: "var(--text-2)",
                  borderRadius: 2, pointerEvents: "none",
                  fontFamily: "ui-monospace, monospace",
                }}
                title={`Parallax ${layer.parallaxX}, ${layer.parallaxY}`}
              >{layer.parallaxX === layer.parallaxY ? `${layer.parallaxX}×` : `${layer.parallaxX},${layer.parallaxY}`}</span>
            )}
            {/* Z badge — visible per-instance z (0..999, layer-local).
                Always shown so the author sees the per-instance stack order
                at a glance. Non-zero z gets a slightly brighter background
                so the default-zero instances don't clutter the canvas. */}
            <span
              style={{
                position: "absolute", top: 2, left: 2,
                fontSize: 9, padding: "0 3px",
                background: (inst.z ?? 0) > 0 ? "rgba(245,207,71,0.6)" : "rgba(0,0,0,0.4)",
                color: (inst.z ?? 0) > 0 ? "#000" : "var(--text-2)",
                borderRadius: 2, pointerEvents: "none",
                fontFamily: "ui-monospace, monospace",
                fontWeight: (inst.z ?? 0) > 0 ? 700 : 400,
              }}
              title={`Z order ${inst.z ?? 0} (layer-local, 0..999)`}
            >z:{inst.z ?? 0}</span>
            {isSelected && (() => {
              // Eight resize handles (4 corners + 4 edges) shown only on the
              // selected instance. Sized in screen px (NOT scaled with zoom)
              // so the grab targets stay easy to hit at every zoom level.
              // Position handles at the corners of the WRAPPING DIV (which
              // wraps the visible cropped frame) — not at the BP's nominal
              // (w × h) bounds, which after cropping no longer match what
              // the user sees. The drag math still uses w/h since that's
              // the "design size" the instance override scales against.
              const HANDLE = 9;
              const half = HANDLE / 2;
              const wPx = gizmoW * scale;
              const hPx = gizmoH * scale;
              const handles: Array<[number, number, string, "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"]> = [
                [0,        0,        "nw-resize", "nw"],
                [wPx / 2,  0,        "ns-resize", "n"],
                [wPx,      0,        "ne-resize", "ne"],
                [wPx,      hPx / 2,  "ew-resize", "e"],
                [wPx,      hPx,      "se-resize", "se"],
                [wPx / 2,  hPx,      "ns-resize", "s"],
                [0,        hPx,      "sw-resize", "sw"],
                [0,        hPx / 2,  "ew-resize", "w"],
              ];
              return handles.map(([cx, cy, cursor, mode]) => (
                <div
                  key={mode}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    // Base display size (scale 1) and the CURRENT total displayed
                    // size = base × (w/h override sX/sY) × (inst.scaleX/Y). The
                    // drag re-expresses that total as a single scaleX/scaleY and
                    // drops the w/h override, unifying the gizmo with the inspector.
                    const dispBaseW = firstFrame?.imageFile ? imgW : baseW;
                    const dispBaseH = firstFrame?.imageFile ? imgH : baseH;
                    resizeRef.current = {
                      id: inst.id,
                      handle: mode,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origX: inst.x,
                      origY: inst.y,
                      origW: dispBaseW * sX * (inst.scaleX ?? 1),
                      origH: dispBaseH * sY * (inst.scaleY ?? 1),
                      kind: "bpScale",
                      baseW: dispBaseW,
                      baseH: dispBaseH,
                    };
                    dragMoved.current = false;
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    left: cx - half,
                    top:  cy - half,
                    width: HANDLE,
                    height: HANDLE,
                    background: "var(--yellow)",
                    border: "1px solid rgba(0,0,0,0.7)",
                    cursor,
                    zIndex: 10,
                  }}
                />
              ));
            })()}
          </div>
        );
      }))}

      {/* ─── UI Widget instance previews ─── renders an approximation
          of what each attached component will draw at runtime: Text
          content, SpriteRenderer first frame, Slider track + fill.
          Labeled tag in the corner identifies the widget. UI widgets
          render on top of regular instances since by convention they
          live on the parallax-(0,0) UI layer. */}
      {(scene.uiInstances ?? []).map((inst) => {
        const widget = uiWidgets.find((w) => w.id === inst.uiWidgetId);
        if (!widget) return null;
        const layer = scene.layers.find((l) => l.id === inst.layerId) ?? scene.layers[0];
        if (!layer) return null;
        const layerAlpha = (layer.visible ? 1 : 0.3) * layer.opacity;
        const isSelected = inst.id === selectedId || multiSelected.has(inst.id);
        // Lock state — used to make the div transparent to pointer events.
        // Without this, a locked widget's onMouseDown stopPropagation
        // (followed by an early return) blocks clicks from reaching
        // anything beneath the widget, even other widgets / BP instances /
        // empty canvas. pointer-events:none lets the browser route clicks
        // to whatever's physically under the locked widget's bounds.
        const isLocked = !!inst.locked || !!layer.locked;
        // Multi-mode widgets fill the viewport — render at viewport
        // top-left with viewport size, ignoring instance x/y/w/h.
        // Children render at their own (child.x, child.y) inside.
        const isMulti = widget.mode === "multi";
        // Inventory frame is derived from its grid + padding (matches runtime),
        // not the stored instance/widget size which can be stale after edits.
        const invFrame = widget.kind === "CraftGrid" ? craftGridFrameSize(widget)
          : (widget.kind === "Inventory" || widget.kind === "Crafting") ? inventoryFrameSize(widget) : null;
        const w = isMulti ? viewportW : invFrame ? invFrame.width  : (inst.w ?? widget.width);
        const h = isMulti ? viewportH : invFrame ? invFrame.height : (inst.h ?? widget.height);

        // Render the widget per kind — same visual recipe as the runtime
        // so what-you-see-in-the-editor is what-you-get-at-play. Common
        // bg + border are always drawn; kind-specific layers (text,
        // slider fill, image, dropdown chevron) layer on top.
        const bgColorHex = `#${((widget.bgColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
        const bgAlpha = widget.bgAlpha ?? (widget.bgColor !== undefined ? 1 : 0);
        const borderHex = `#${((widget.borderColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
        const borderW = widget.borderWidth ?? 0;

        // Slider / ProgressBar fill ratio
        let fillT = 0;
        if (widget.kind === "Slider" || widget.kind === "ProgressBar") {
          const min = widget.min ?? 0;
          const max = widget.max ?? 100;
          const span = max - min;
          if (typeof widget.value === "number") {
            fillT = span === 0 ? 0 : Math.max(0, Math.min(1, (widget.value - min) / span));
          } else {
            fillT = 0.5; // expression-bound bar — show 50% as a placeholder
          }
        }
        const fillHex = `#${((widget.fillColor ?? 0x44ddff) & 0xffffff).toString(16).padStart(6, "0")}`;

        // Image kind — show the sprite's first frame (resolved by the
        // outer bulk hook into uiImageUrls).
        let imageSrc: string | undefined;
        if (widget.kind === "Image") {
          const sp = sprites.find((s) => s.id === widget.spriteId);
          const fr = sp?.animations[0]?.frames[0];
          if (sp && fr?.imageFile) {
            const p = spriteFrameDiskPath(sp, fr.imageFile);
            imageSrc = uiImageUrls.get(p);
          }
        }

        const showText = widget.kind === "Label" || widget.kind === "Button" || widget.kind === "Dropdown";
        const dropdownLabel = widget.kind === "Dropdown"
          ? (widget.options?.find((o) => o.value === widget.selectedValue)?.label ?? widget.text ?? "Pick…")
          : widget.text ?? "";

        // UI widget positions are VIEWPORT-relative.
        //  - Single mode: instance.x/y is the WIDGET'S CENTER in
        //    viewport-canvas coords. Render centered at vpPos+(x,y).
        //  - Multi mode: the widget fills the entire viewport regardless
        //    of inst.x/y. Render anchored at the viewport rectangle's
        //    top-left, sized to the full viewport. Children render at
        //    their own (child.x, child.y) INSIDE the viewport.
        const divLeft = isMulti
          ? vpPos.x * scale
          : (vpPos.x + inst.x - w / 2) * scale;
        const divTop = isMulti
          ? vpPos.y * scale
          : (vpPos.y + inst.y - h / 2) * scale;
        const widgetCss = visualCssStyle(widget, scale);
        // Inventory frame honors cornerRadius too (clamped) — matches runtime.
        const frameBorderRadius = invFrame
          ? `${Math.min(widget.cornerRadius ?? 0, Math.min(w, h) / 2) * scale}px`
          : widgetCss.borderRadius;
        return (
          <div
            key={inst.id}
            className="wradius"
            onMouseDown={(e) => onUIMouseDown(e, inst.id, w, h)}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: divLeft,
              top:  divTop,
              width:  w * scale,
              height: h * scale,
              pointerEvents: isLocked ? "none" : undefined,
              // A multi-mode widget is a full-screen HUD CANVAS — its own
              // background stays transparent so gameplay (and child widgets)
              // show through. Without this an opaque root paints the whole
              // viewport and hides the scene. For a full-screen colored
              // overlay (pause dim), add a full-size child Panel instead.
              background: (!isMulti && bgAlpha > 0) ? `${bgColorHex}${alphaHex(bgAlpha)}` : "transparent",
              border: borderW > 0
                ? `${borderW}px solid ${borderHex}`
                : isSelected ? "2px dashed var(--yellow)" : "1px dashed rgba(255,165,0,0.4)",
              outline: isSelected && borderW > 0 ? "2px dashed var(--yellow)" : "none",
              outlineOffset: 1,
              opacity: layerAlpha,
              cursor: "grab",
              userSelect: "none",
              overflow: "hidden",
              boxSizing: "border-box",
              borderRadius: frameBorderRadius,
              boxShadow: widgetCss.boxShadow,
              backdropFilter: widgetCss.backdropFilter,
              WebkitBackdropFilter: widgetCss.backdropFilter,
            }}
            title={`UI · ${widget.name} · ${widget.kind} · ${layer.name}`}
          >
            {/* Single-mode element rendering — these only apply when
                the widget IS one element (Slider / Button / Label /
                etc.). Multi mode renders its own children below. */}
            {!isMulti && imageSrc && (
              <img
                src={imageSrc} alt="" draggable={false}
                style={{
                  position: "absolute", left: 0, top: 0,
                  width: "100%", height: "100%",
                  objectFit: "fill", imageRendering: "pixelated",
                  pointerEvents: "none",
                }}
              />
            )}

            {!isMulti && (widget.kind === "Slider" || widget.kind === "ProgressBar") && widget.direction !== "vertical" && (
              <div style={{
                position: "absolute", left: 0, top: 0,
                width: `${fillT * 100}%`, height: "100%",
                background: fillHex, pointerEvents: "none",
              }}/>
            )}
            {!isMulti && (widget.kind === "Slider" || widget.kind === "ProgressBar") && widget.direction === "vertical" && (
              <div style={{
                position: "absolute", left: 0, bottom: 0,
                width: "100%", height: `${fillT * 100}%`,
                background: fillHex, pointerEvents: "none",
              }}/>
            )}

            {/* Slider thumb hint (interactive sliders only — visual cue
                that you can grab it). Centered on the fill edge. */}
            {!isMulti && widget.kind === "Slider" && widget.direction !== "vertical" && (
              <div style={{
                position: "absolute",
                left: `calc(${fillT * 100}% - 4px)`,
                top: 2, bottom: 2,
                width: 8, background: "rgba(255,255,255,0.7)",
                borderRadius: 2, pointerEvents: "none",
              }}/>
            )}

            {/* Text content for Label / Button / Dropdown */}
            {!isMulti && showText && (
              <span style={{
                position: "absolute", left: 0, top: 0,
                width: "100%", height: "100%",
                display: "flex",
                alignItems: widget.vAlign === "top" ? "flex-start" : widget.vAlign === "bottom" ? "flex-end" : "center",
                justifyContent: widget.align === "left" ? "flex-start" : widget.align === "right" ? "flex-end" : "center",
                fontFamily: widget.fontFamily ?? "Arial",
                fontSize: (widget.fontSize ?? 16) * scale,
                color: `#${((widget.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
                fontWeight: widget.fontBold ? 700 : 400,
                fontStyle: widget.fontItalic ? "italic" : "normal",
                pointerEvents: "none",
                padding: (widget.padding ?? 0) * scale,
                boxSizing: "border-box",
              }}>
                {widget.kind === "Dropdown" ? dropdownLabel : (widget.text ?? "")}
              </span>
            )}

            {/* Dropdown chevron */}
            {!isMulti && widget.kind === "Dropdown" && (
              <span style={{
                position: "absolute",
                right: 8 * scale, top: "50%",
                transform: "translateY(-50%)",
                color: `#${((widget.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
                fontSize: (widget.fontSize ?? 14) * scale,
                pointerEvents: "none",
              }}>▾</span>
            )}

            {/* Inventory slot grid — same geometry as runtime + widget-tab preview */}
            {!isMulti && (widget.kind === "Inventory" || widget.kind === "Crafting") && (
              <InventoryGridPreview v={widget} scale={scale} />
            )}
            {!isMulti && widget.kind === "CraftGrid" && (
              <CraftGridPreview v={widget} scale={scale} />
            )}

            {/* Multi-mode: render each child at its in-viewport position.
                Children are display-only here (the inspector / widget
                editor is where you reposition them). What you see is
                what runtime spawns. */}
            {isMulti && widget.children.map((child) => {
              const childBgColor = child.bgColor ?? 0;
              const childBgAlpha = child.bgAlpha ?? (child.bgColor !== undefined ? 1 : 0);
              const childBgHex = `#${(childBgColor & 0xffffff).toString(16).padStart(6, "0")}`;
              const childBorderHex = `#${((child.borderColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
              const childBorderW = child.borderWidth ?? 0;
              const childShowText = child.kind === "Label" || child.kind === "Button" || child.kind === "Dropdown";
              let childFillT = 0;
              if (child.kind === "Slider" || child.kind === "ProgressBar") {
                const cmin = child.min ?? 0;
                const cmax = child.max ?? 100;
                const cspan = cmax - cmin;
                childFillT = typeof child.value === "number" && cspan > 0
                  ? Math.max(0, Math.min(1, (child.value - cmin) / cspan))
                  : 0.5;
              }
              const childFillHex = `#${((child.fillColor ?? 0x44ddff) & 0xffffff).toString(16).padStart(6, "0")}`;
              // Image-kind child resolves to a blob URL via the bulk hook.
              // Path is computed here, then looked up in uiImageUrls (which
              // also covers nested children — same asset store, same map).
              let childImage: string | undefined;
              if (child.kind === "Image") {
                const sp = sprites.find((s) => s.id === child.spriteId);
                const fr = sp?.animations[0]?.frames[0];
                if (sp && fr?.imageFile) {
                  childImage = uiImageUrls.get(spriteFrameDiskPath(sp, fr.imageFile));
                }
              }
              const childLabel = child.kind === "Dropdown"
                ? (child.options?.find((o) => o.value === child.selectedValue)?.label ?? child.text ?? "Pick…")
                : (child.text ?? "");
              const childCss = visualCssStyle(child, scale);
              // Inventory child: frame size from grid + padding (matches runtime).
              const childInvFrame = child.kind === "CraftGrid" ? craftGridFrameSize(child)
                : (child.kind === "Inventory" || child.kind === "Crafting") ? inventoryFrameSize(child) : null;
              const childBorderRadius = childInvFrame
                ? `${Math.min(child.cornerRadius ?? 0, Math.min(childInvFrame.width, childInvFrame.height) / 2) * scale}px`
                : childCss.borderRadius;
              return (
                <div
                  key={child.id}
                  className="wradius"
                  style={{
                    position: "absolute",
                    left: child.x * scale,
                    top:  child.y * scale,
                    width:  (childInvFrame ? childInvFrame.width  : child.width)  * scale,
                    height: (childInvFrame ? childInvFrame.height : child.height) * scale,
                    background: childBgAlpha > 0 ? `${childBgHex}${alphaHex(childBgAlpha)}` : "transparent",
                    border: childBorderW > 0
                      ? `${childBorderW}px solid ${childBorderHex}`
                      : "1px dashed rgba(255,255,255,0.15)",
                    overflow: "hidden",
                    pointerEvents: "none",
                    boxSizing: "border-box",
                    borderRadius: childBorderRadius,
                    boxShadow: childCss.boxShadow,
                    backdropFilter: childCss.backdropFilter,
                    WebkitBackdropFilter: childCss.backdropFilter,
                  }}
                  title={`${child.kind}${child.name ? ` · ${child.name}` : ""}`}
                >
                  {childImage && (
                    <img src={childImage} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "fill", imageRendering: "pixelated" }} />
                  )}
                  {(child.kind === "Inventory" || child.kind === "Crafting") && (
                    <InventoryGridPreview v={child} scale={scale} />
                  )}
                  {child.kind === "CraftGrid" && (
                    <CraftGridPreview v={child} scale={scale} />
                  )}
                  {(child.kind === "Slider" || child.kind === "ProgressBar") && child.direction !== "vertical" && (
                    <div style={{ position: "absolute", left: 0, top: 0, width: `${childFillT * 100}%`, height: "100%", background: childFillHex }} />
                  )}
                  {(child.kind === "Slider" || child.kind === "ProgressBar") && child.direction === "vertical" && (
                    <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: `${childFillT * 100}%`, background: childFillHex }} />
                  )}
                  {childShowText && (
                    <span style={{
                      position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
                      display: "flex",
                      alignItems: child.vAlign === "top" ? "flex-start" : child.vAlign === "bottom" ? "flex-end" : "center",
                      justifyContent: child.align === "left" ? "flex-start" : child.align === "right" ? "flex-end" : "center",
                      fontFamily: child.fontFamily ?? "Arial",
                      fontSize: (child.fontSize ?? 14) * scale,
                      color: `#${((child.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
                      fontWeight: child.fontBold ? 700 : 400,
                      fontStyle: child.fontItalic ? "italic" : "normal",
                      padding: (child.padding ?? 0) * scale,
                      boxSizing: "border-box",
                    }}>{childLabel}</span>
                  )}
                </div>
              );
            })}

            {/* Tiny corner tag identifying this as a UI widget */}
            <span
              style={{
                position: "absolute",
                top: 2, left: 2,
                fontSize: 9,
                fontWeight: 700,
                color: "var(--orange)",
                background: "rgba(0,0,0,0.5)",
                padding: "1px 4px",
                borderRadius: 2,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                pointerEvents: "none",
              }}
            >
              UI · {inst.name ?? widget.name}{isMulti ? " (multi)" : ""}
            </span>
          </div>
        );
      })}

      {/* ─── Sprite Placement preview ─── direct sprite drops, no BP. */}
      {(scene.spritePlacements ?? []).map((p) => {
        const sprite = sprites.find((s) => s.id === p.spriteId);
        const animFromName = sprite && p.animation
          ? sprite.animations.find((a) => a.name === p.animation)
          : undefined;
        const anim = animFromName ?? sprite?.animations[0];
        const frameIdx = anim ? Math.max(0, Math.min(anim.frames.length - 1, p.startFrame ?? 0)) : 0;
        const frame = anim?.frames[frameIdx];
        // Base size: prefer the FRAME's imageW/H (matches what the runtime
        // Phaser sprite renders, since the texture IS the frame's cropped
        // image). Fall back to sprite.width/height when the frame doesn't
        // have its own dims, then to 32px so 0-size sprites still show.
        const baseW = (frame?.imageW || sprite?.width  || 32);
        const baseH = (frame?.imageH || sprite?.height || 32);
        const w = baseW * (p.scaleX ?? 1);
        const h = baseH * (p.scaleY ?? 1);
        const layer = scene.layers.find((l) => l.id === p.layerId) ?? scene.layers[0];
        const layerAlpha = (layer?.visible ? 1 : 0.3) * (layer?.opacity ?? 1);
        const isSelected = selectedId === p.id || multiSelected.has(p.id);
        return (
          <div
            key={`placement:${p.id}`}
            onMouseDown={(e) => onPlacementMouseDown(e, p.id, w, h)}
            onDoubleClick={(e) => { e.stopPropagation(); if (sprite) openSpriteTab(sprite.id); }}
            style={{
              position: "absolute",
              left: (p.x - w / 2) * scale,
              top:  (p.y - h / 2) * scale,
              width:  w * scale,
              height: h * scale,
              transform: `rotate(${p.rotation ?? 0}deg) scaleX(${p.flipX ? -1 : 1}) scaleY(${p.flipY ? -1 : 1})`,
              opacity: (p.alpha ?? 1) * layerAlpha,
              outline: isSelected ? "1.5px solid var(--yellow)" : "1px dashed rgba(255,255,255,0.25)",
              cursor: "grab",
              zIndex: 3,
            }}
          >
            {sprite && frame && frame.imageFile ? (
              <FrameThumb
                sprite={sprite}
                frame={frame}
                style={{
                  position: "absolute", inset: 0,
                  width: "100%", height: "100%",
                  imageRendering: "pixelated",
                  pointerEvents: "none",
                }}
              />
            ) : (
              // Color-only frame OR missing sprite OR no animations — show
              // a colored marker so the author can still see + select the
              // placement. Magenta = clearly broken (missing sprite).
              <div style={{
                position: "absolute", inset: 0,
                background: frame
                  ? `#${(frame.color & 0xffffff).toString(16).padStart(6, "0")}`
                  : "rgba(255, 0, 255, 0.4)",
                pointerEvents: "none",
              }} />
            )}
            {/* Always show a name label so a placed sprite is immediately
             *  obvious even if its rendered art is invisible (zero-size,
             *  missing texture). */}
            <span style={{
              position: "absolute", left: 0, top: -16,
              fontSize: 9, color: "#fff",
              background: isSelected ? "rgba(245, 180, 71, 0.85)" : "rgba(0,0,0,0.6)",
              padding: "1px 4px", borderRadius: 2,
              pointerEvents: "none", whiteSpace: "nowrap",
            }}>
              {p.name || sprite?.name || "(missing sprite)"}
            </span>
            {/* 8 resize handles on the selected placement — matches the
             *  BP gizmo so the editing experience is consistent. The
             *  resize math converts dragged px back into scaleX/scaleY
             *  relative to the sprite asset's base size. */}
            {isSelected && (() => {
              const HANDLE = 9;
              const half = HANDLE / 2;
              const wPx = w * scale;
              const hPx = h * scale;
              const handles: Array<[number, number, string, "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"]> = [
                [0,       0,       "nw-resize", "nw"],
                [wPx / 2, 0,       "ns-resize", "n"],
                [wPx,     0,       "ne-resize", "ne"],
                [wPx,     hPx / 2, "ew-resize", "e"],
                [wPx,     hPx,     "se-resize", "se"],
                [wPx / 2, hPx,     "ns-resize", "s"],
                [0,       hPx,     "sw-resize", "sw"],
                [0,       hPx / 2, "ew-resize", "w"],
              ];
              return handles.map(([cx, cy, cursor, mode]) => (
                <div
                  key={mode}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    resizeRef.current = {
                      id: p.id,
                      handle: mode,
                      startClientX: e.clientX,
                      startClientY: e.clientY,
                      origX: p.x,
                      origY: p.y,
                      origW: w,
                      origH: h,
                      kind: "placement",
                      baseW: sprite?.width  || 32,
                      baseH: sprite?.height || 32,
                    };
                    dragMoved.current = false;
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    left: cx - half,
                    top:  cy - half,
                    width: HANDLE, height: HANDLE,
                    background: "var(--yellow)",
                    border: "1px solid rgba(0,0,0,0.7)",
                    cursor,
                    zIndex: 10,
                  }}
                />
              ));
            })()}
          </div>
        );
      })}

      {/* ─── Static Text-behavior preview ─── */}
      {scene.instances.map((inst) => {
        const bp = blueprintFor(inst);
        if (!bp) return null;
        const text = bp.behaviors.find((b) => b.kind === "Text");
        if (!text) return null;
        const cfg = text.config as Record<string, unknown>;
        const visible = Number(cfg.visible ?? 1) !== 0;
        if (!visible) return null;
        // Honor the instance's layer — hidden layers dim to 30%, opacity multiplies.
        const layer = scene.layers.find((l) => l.id === inst.layerId) ?? scene.layers[0];
        const layerAlpha = (layer?.visible ? 1 : 0.3) * (layer?.opacity ?? 1);
        const content = String(cfg.content ?? "");
        const fontFamily = String(cfg.fontFamily ?? "Arial");
        const fontSize = Number(cfg.fontSize ?? 16);
        const colorN = Number(cfg.color ?? 0xffffff);
        const colorCss = `#${(colorN & 0xffffff).toString(16).padStart(6, "0")}`;
        const bold = Number(cfg.bold ?? 0) !== 0;
        const italic = Number(cfg.italic ?? 0) !== 0;
        const align  = String(cfg.align  ?? "left") as "left" | "center" | "right";
        const vAlign = String(cfg.vAlign ?? "top")  as "top"  | "middle" | "bottom";
        const wrapWidth = Number(cfg.wrapWidth ?? 0);
        // Per-instance scale — same denominator as the body/collider previews
        // (sprite asset size when there's a SpriteRenderer, else bp.w/h). The
        // label's offset AND its font size both scale by this so the text
        // moves AND resizes with the BP as one unit, matching the runtime.
        const textRenderer = bp.behaviors.find((b) => b.kind === "SpriteRenderer")
                          ?? bp.behaviors.find((b) => b.kind === "TiledBackground");
        const textSprite = textRenderer
          ? sprites.find((s) => s.id === String(textRenderer.config.spriteId ?? ""))
          : undefined;
        const baseW = textSprite ? textSprite.width  : bp.w;
        const baseH = textSprite ? textSprite.height : bp.h;
        const sX = inst.w !== undefined && baseW > 0 ? inst.w / baseW : 1;
        const sY = inst.h !== undefined && baseH > 0 ? inst.h / baseH : 1;
        const offsetX = Number(cfg.offsetX ?? 0) * sX;
        const offsetY = Number(cfg.offsetY ?? 0) * sY;

        // Anchor at instance position + (scaled) offset, then alignment sets
        // the text pivot via CSS transform — see BlueprintPreview.
        const tx = align  === "center" ? "-50%" : align  === "right"  ? "-100%" : "0%";
        const ty = vAlign === "middle" ? "-50%" : vAlign === "bottom" ? "-100%" : "0%";
        const anchorXpx = (inst.x + offsetX) * scale;
        const anchorYpx = (inst.y + offsetY) * scale;

        return (
          <span
            key={`${inst.id}:text`}
            style={{
              position: "absolute",
              left: anchorXpx,
              top: anchorYpx,
              transform: `translate(${tx}, ${ty})`,
              fontFamily,
              fontSize: fontSize * sX * scale,
              color: colorCss,
              fontWeight: bold ? 700 : 400,
              fontStyle: italic ? "italic" : "normal",
              textAlign: align,
              whiteSpace: wrapWidth > 0 ? "pre-wrap" : "pre",
              maxWidth: wrapWidth > 0 ? wrapWidth * scale : undefined,
              lineHeight: 1.1,
              userSelect: "none",
              pointerEvents: "none",
              opacity: layerAlpha,
            }}
          >
            {content}
          </span>
        );
      })}

      {/* ─── Collider outlines (toggle-able) ─── */}
      {/* SpritePlacement collider outlines — bold dashed box so it's
       *  clearly visible at any zoom. Orange = blocks, cyan = overlap. */}
      {showColliders && (scene.spritePlacements ?? []).map((p) => {
        if (!p.hasCollider) return null;
        const sprite = sprites.find((s) => s.id === p.spriteId);
        const baseW = sprite?.width  || 32;
        const baseH = sprite?.height || 32;
        // Mirror the runtime body sizing EXACTLY (runProject SpritePlacement
        // spawn): the displayed frame's per-frame collider wins, else fit-sprite,
        // else the placement's manual collider rect. So the overlay shows the
        // REAL collider for the shown frame, not a fixed sprite-size box.
        const anim = sprite?.animations.find((a) => a.name === p.animation) ?? sprite?.animations[0];
        const startIdx = Math.max(0, Math.min((anim?.frames.length ?? 1) - 1, p.startFrame ?? 0));
        const fc = anim?.frames[startIdx]?.collider;
        const fit = p.colliderFitSprite !== false;
        let bw: number, bh: number, foffX = 0, foffY = 0;
        if (fc?.enabled) { bw = fc.width; bh = fc.height; foffX = fc.offsetX; foffY = fc.offsetY; }
        else if (fit) { bw = baseW; bh = baseH; }
        else { bw = p.colliderWidth || 32; bh = p.colliderHeight || 32; }
        const finalOffX = foffX !== 0 ? foffX : (p.colliderOffsetX ?? 0);
        const finalOffY = foffY !== 0 ? foffY : (p.colliderOffsetY ?? 0);
        const cw = bw * (p.scaleX ?? 1);
        const ch = bh * (p.scaleY ?? 1);
        const ox = finalOffX * (p.scaleX ?? 1);
        const oy = finalOffY * (p.scaleY ?? 1);
        const stroke = p.colliderBlocks ? "#ff8a3c" : "#3ba9e8";
        return (
          <div
            key={`${p.id}:collider`}
            style={{
              position: "absolute",
              left: (p.x + ox - cw / 2) * scale,
              top:  (p.y + oy - ch / 2) * scale,
              width:  cw * scale,
              height: ch * scale,
              borderRadius: 2,
              border: `3px dashed ${stroke}`,
              boxShadow: `0 0 0 1px rgba(0,0,0,0.6) inset, 0 0 8px ${stroke}66`,
              background: p.colliderBlocks ? "rgba(232, 116, 59, 0.12)" : "rgba(59, 169, 232, 0.12)",
              pointerEvents: "none",
              boxSizing: "border-box",
              zIndex: 5,
            }}
            title={p.colliderBlocks ? "collider (blocks)" : "collider (overlap)"}
          />
        );
      })}
      {showColliders && scene.instances.map((inst) => {
        const bp = blueprintFor(inst);
        if (!bp) return null;
        const collider = bp.behaviors.find((b) => b.kind === "Collider");
        if (!collider) return null;
        const cfg     = collider.config as Record<string, unknown>;
        // Scale collider rect + offset by the instance's universal resize
        // ratio (same denominator the editor uses for the body div: sprite
        // asset width if there's a SpriteRenderer, BP body width otherwise).
        // This matches the runtime collider scale exactly so what you see
        // in the editor is what you get in the running game. Stays 1 for
        // legacy / un-resized instances.
        const renderer = bp.behaviors.find((b) => b.kind === "SpriteRenderer")
                      ?? bp.behaviors.find((b) => b.kind === "TiledBackground");
        const colSprite = renderer
          ? sprites.find((s) => s.id === String(renderer.config.spriteId ?? ""))
          : undefined;
        const dispBaseW = colSprite ? colSprite.width  : bp.w;
        const dispBaseH = colSprite ? colSprite.height : bp.h;
        const scaleX = inst.w !== undefined && dispBaseW > 0 ? inst.w / dispBaseW : 1;
        const scaleY = inst.h !== undefined && dispBaseH > 0 ? inst.h / dispBaseH : 1;
        const offsetX = Number(cfg.offsetX ?? 0) * scaleX;
        const offsetY = Number(cfg.offsetY ?? 0) * scaleY;
        const cw      = Number(cfg.width  ?? 32) * scaleX;
        const ch      = Number(cfg.height ?? 48) * scaleY;
        return (
          <div
            key={`${inst.id}:collider`}
            style={{
              position: "absolute",
              left: (inst.x + offsetX - cw / 2) * scale,
              top:  (inst.y + offsetY - ch / 2) * scale,
              width:  cw * scale,
              height: ch * scale,
              borderRadius: 2,
              border: "1.5px dashed var(--orange)",
              background: "rgba(232, 116, 59, 0.08)",
              pointerEvents: "none",
              boxSizing: "border-box",
            }}
            title="collider"
          />
        );
      })}

      {/* ─── Tracer geometry preview (selected instances) ───
          Shows each Tracer's configured shape at the BP's editor position
          so authors can place / size attack hitboxes against image points
          without entering Play. Drawn only for the current selection to
          stay out of the way during scene layout work. Pivot sources
          "framePivot" / "imagePoint" need live animation data the editor
          doesn't simulate — those fall back to the BP center with a hint
          label, so the user can still see angle + length while authoring,
          and the runtime debug viz fills in the rest at Play time. */}
      {scene.instances.map((inst) => {
        if (inst.id !== selectedId && !multiSelected.has(inst.id)) return null;
        const bp = blueprintFor(inst);
        if (!bp) return null;
        const tracers = bp.behaviors.filter((b) => b.kind === "Tracer");
        if (tracers.length === 0) return null;
        const layer = scene.layers.find((l) => l.id === inst.layerId) ?? scene.layers[0];
        if (!layer || !layer.visible) return null;
        return tracers.map((tracer, idx) => {
          const cfg = tracer.config as Record<string, unknown>;
          if (!Number(cfg.debugDraw ?? 1)) return null;
          const shape       = String(cfg.shape ?? "line");
          const distance    = Number(cfg.distance ?? 100);
          const angleDeg    = Number(cfg.angle ?? 0);
          const pivotX      = Number(cfg.pivotX ?? 0);
          const pivotY      = Number(cfg.pivotY ?? 0);
          const pivotSource = String(cfg.pivotSource ?? "manual");
          const boxThick    = Number(cfg.boxThickness ?? 16);
          // Editor preview assumes facing-right + manual pivot. Frame-pivot
          // / image-point sources are noted with a "(approx)" tag so the
          // user knows the runtime exact position depends on the active
          // animation frame.
          const px = inst.x + pivotX;
          const py = inst.y + pivotY;
          const rad = (angleDeg * Math.PI) / 180;
          const ex = px + Math.cos(rad) * distance;
          const ey = py + Math.sin(rad) * distance;
          const pad = Math.max(8, boxThick);
          const minX = Math.min(px, ex) - pad;
          const maxX = Math.max(px, ex) + pad;
          const minY = Math.min(py, ey) - pad;
          const maxY = Math.max(py, ey) + pad;
          const svgW = maxX - minX;
          const svgH = maxY - minY;
          const tracerName = String(cfg.name ?? "") || "tracer";
          const isApprox = pivotSource !== "manual";
          return (
            <svg
              key={`tracer-preview:${inst.id}:${idx}`}
              style={{
                position: "absolute",
                left: minX * scale,
                top:  minY * scale,
                width:  svgW * scale,
                height: svgH * scale,
                pointerEvents: "none",
                overflow: "visible",
                zIndex: 4,
              }}
              viewBox={`0 0 ${svgW} ${svgH}`}
            >
              {shape === "box" ? (
                <rect
                  x={Math.min(px, ex) - minX - boxThick / 2}
                  y={Math.min(py, ey) - minY - boxThick / 2}
                  width={Math.abs(ex - px) + boxThick}
                  height={Math.abs(ey - py) + boxThick}
                  fill="rgba(64, 192, 255, 0.08)"
                  stroke="#40c0ff"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  opacity={0.85}
                />
              ) : (
                <line
                  x1={px - minX}
                  y1={py - minY}
                  x2={ex - minX}
                  y2={ey - minY}
                  stroke="#40c0ff"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  opacity={0.85}
                />
              )}
              <circle cx={px - minX} cy={py - minY} r={3} fill="#ffd040" opacity={0.95} />
              <text
                x={px - minX + 6}
                y={py - minY - 6}
                fill="#40c0ff"
                fontSize={10}
                fontFamily="ui-monospace, monospace"
                opacity={0.9}
              >
                {tracerName}{isApprox ? " (approx)" : ""}
              </text>
            </svg>
          );
        });
      })}

      {/* ─── Viewport rectangle ─── shows what the camera frames at the
          current preview position. Drag from inside the rectangle to move
          it; clamped to layout bounds. The shaded margin highlights the
          off-camera world (visible in editor, scrolled out at runtime). */}
      {showViewport && (() => {
        const vw = viewportW * scale;
        const vh = viewportH * scale;
        const vx = vpPos.x * scale;
        const vy = vpPos.y * scale;
        const lw = scene.width  * scale;
        const lh = scene.height * scale;
        return (
          <>
            {/* Outside-of-viewport mask (4 strips around the rectangle). */}
            <div style={{ position: "absolute", left: 0, top: 0, width: lw, height: vy, background: "rgba(0,0,0,0.35)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", left: 0, top: vy + vh, width: lw, height: Math.max(0, lh - (vy + vh)), background: "rgba(0,0,0,0.35)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", left: 0, top: vy, width: vx, height: vh, background: "rgba(0,0,0,0.35)", pointerEvents: "none" }} />
            <div style={{ position: "absolute", left: vx + vw, top: vy, width: Math.max(0, lw - (vx + vw)), height: vh, background: "rgba(0,0,0,0.35)", pointerEvents: "none" }} />
            {/* The viewport rectangle itself — draggable. */}
            <div
              onMouseDown={(e) => {
                e.stopPropagation();
                if (!containerRef.current) return;
                const rect = containerRef.current.getBoundingClientRect();
                vpDrag.current = {
                  dx: (e.clientX - rect.left) / scale - vpPos.x,
                  dy: (e.clientY - rect.top)  / scale - vpPos.y,
                };
              }}
              onClick={(e) => {
                // Without this, clicking inside the viewport rect (which
                // sits over a large portion of the canvas) hits THIS div as
                // e.target — the canvas's onClick target===currentTarget
                // check fails and selection is never cleared. Authors then
                // can't open the scene's properties by clicking the canvas.
                // Skip when the click was actually a viewport-drag.
                e.stopPropagation();
                if (dragMoved.current) { dragMoved.current = false; return; }
                select(null);
                if (multiSelected.size > 0) setMultiSelected(new Set());
              }}
              title={`Camera viewport (${viewportW}×${viewportH}) — drag to preview`}
              style={{
                position: "absolute",
                left: vx, top: vy, width: vw, height: vh,
                border: "2px dashed var(--teal)",
                background: "transparent",
                boxSizing: "border-box",
                cursor: "move",
                pointerEvents: "all",
              }}
            >
              <span style={{
                position: "absolute", top: 2, left: 4,
                fontSize: 9, fontFamily: "ui-monospace, monospace",
                color: "var(--teal)", background: "rgba(0,0,0,0.5)",
                padding: "0 4px", borderRadius: 2,
                pointerEvents: "none", userSelect: "none",
              }}>
                {viewportW}×{viewportH}
              </span>
            </div>
          </>
        );
      })()}

      {/* ─── Rectangle-select overlay (Shift+drag on empty bg) ─── */}
      {rectDragVisual && (() => {
        const x = Math.min(rectDragVisual.x1, rectDragVisual.x2) * scale;
        const y = Math.min(rectDragVisual.y1, rectDragVisual.y2) * scale;
        const w = Math.abs(rectDragVisual.x2 - rectDragVisual.x1) * scale;
        const h = Math.abs(rectDragVisual.y2 - rectDragVisual.y1) * scale;
        return (
          <div
            style={{
              position: "absolute",
              left: x, top: y, width: w, height: h,
              border: "1.5px dashed var(--yellow, #f5b447)",
              background: "rgba(245, 180, 71, 0.10)",
              pointerEvents: "none",
              boxSizing: "border-box",
              zIndex: 50,
            }}
          />
        );
      })()}

      {/* ─── In-scene paint toolbar — portalled + fixed to the viewport panel
           (was absolute inside the scaled canvas, so it drifted off-screen and
           you couldn't pick a tile → "nothing paints"). ─── */}
      {paintActive && selectedTilemapMap && paintTileset && paintActiveLayerId && createPortal(
        <InScenePaintToolbar
          vpBox={vpBox}
          map={selectedTilemapMap}
          tileset={paintTileset}
          tilesetOptions={paintSlots.map((s) => ({ id: s.ts.id, name: s.ts.name }))}
          activeTilesetId={activePaintSlot?.ts.id ?? ""}
          setActiveTilesetId={switchPaintTileset}
          tool={paintTool}
          setTool={setPaintTool}
          xf={paintXf}
          setXf={setPaintXf}
          selection={paintSel}
          setSelection={setPaintSel}
          activeLayerId={paintActiveLayerId}
          setActiveLayerId={setPaintActiveLayerId}
          terrainId={paintTerrainId}
          setTerrainId={setPaintTerrainId}
          bigTileId={paintBigTileId}
          setBigTileId={setPaintBigTileId}
          onClose={() => setTilemapPaintMode(false)}
        />,
        document.body,
      )}

      {/* ─── Floating toggles — portalled + fixed to the viewport panel's
           top-right corner (mirrors the Nav Mesh button) so they DON'T drift
           or scale with the canvas zoom/pan, and sit below the menu (z 90). ─── */}
      {createPortal(
      <div style={{ position: "fixed", top: vpBox.top + 10, right: Math.max(8, window.innerWidth - vpBox.right + 10), zIndex: 90, display: "flex", gap: 6 }}>
        <button
          onClick={(e) => { e.stopPropagation(); resetView(); }}
          title="Reset zoom (1×) and pan to default — fit-to-area"
          style={{
            padding: "4px 10px", fontSize: 11,
            background: (userZoom !== 1 || pan.x !== 0 || pan.y !== 0) ? "var(--accent)" : "var(--inner)",
            color: (userZoom !== 1 || pan.x !== 0 || pan.y !== 0) ? "var(--frame)" : "var(--text-2)",
            border: "none", borderRadius: 8, cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            fontFamily: "ui-monospace, monospace",
          }}
        >
          {Math.round(userZoom * 100)}%
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setShowViewport((v) => !v); }}
          title={showViewport ? "Hide camera viewport rectangle" : "Show camera viewport rectangle"}
          style={{
            padding: "4px 10px", fontSize: 11,
            background: showViewport ? "var(--teal)" : "var(--inner)",
            color: showViewport ? "var(--frame)" : "var(--text-2)",
            border: "none", borderRadius: 8, cursor: "crosshair",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {showViewport ? "● Viewport" : "○ Viewport"}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setShowColliders((v) => !v); }}
          title={showColliders ? "Hide collision outlines" : "Show collision outlines"}
          style={{
            padding: "4px 10px", fontSize: 11,
            background: showColliders ? "var(--orange)" : "var(--inner)",
            color: showColliders ? "var(--frame)" : "var(--text-2)",
            border: "none", borderRadius: 8, cursor: "crosshair",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          {showColliders ? "● Colliders" : "○ Colliders"}
        </button>
      </div>,
      document.body,
      )}
    </div>
    </>
  );
}

/** One placed Tilemap rendered to a <canvas>. Holds its own image-load ref so
 *  the draw fires once the tileset image decodes; otherwise re-renders every
 *  time the painted tile data changes (or the scene zoom). Selection + drag
 *  are handled by the parent SceneEditor via the passed mouse handlers.
 *
 *  When `paintActive` is true the mouse handlers swap to paint mode: clicking
 *  on the canvas fires the paint callbacks (col, row coords are derived from
 *  cursor → canvas bounds → tile size). Document-level listeners keep the
 *  stroke alive if the cursor leaves the canvas during a drag. */
function ScenePlacedTilemap({
  ti, map, ts, tilesets, scale, isSelected, isLocked = false, layerAlpha, fullW, fullH, showColliders, onMouseDown, onDoubleClick,
  paintActive = false, paintRectDrag = null, paintSel = null, paintTilesetId = null, paintTool, paintXf = 0, onPaintDown, onPaintMove, onPaintUp, zIndex,
}: {
  zIndex?: number;
  ti: TilemapInstance;
  map: TilemapAsset;
  /** Primary tileset — supplies the map cell size (tileW/tileH). */
  ts: TilesetAsset;
  /** All project tilesets, for resolving the map's extra-tileset slots. */
  tilesets: TilesetAsset[];
  scale: number;
  isSelected: boolean;
  /** When true, the outer div becomes pointer-events:none so clicks pass
   *  through to whatever's beneath. Set when the instance or its layer
   *  is locked. */
  isLocked?: boolean;
  layerAlpha: number;
  fullW: number;
  fullH: number;
  showColliders: boolean;
  onMouseDown: (e: MouseEvent) => void;
  onDoubleClick: (e: MouseEvent) => void;
  paintActive?: boolean;
  paintRectDrag?: PaintRectDrag | null;
  /** Current tile selection (in the paint tileset's cell coords) — drawn as a
   *  ghost preview under the cursor so you see the ACTUAL tiles, not a box. */
  paintSel?: PaintRectDrag | null;
  paintTilesetId?: string | null;
  paintTool?: PaintTool;
  paintXf?: number;
  onPaintDown?: (col: number, row: number, e: MouseEvent) => void;
  onPaintMove?: (col: number, row: number) => void;
  onPaintUp?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Hover cell for the ghost-tile paint preview (paint mode only).
  const [hoverCell, setHoverCell] = useState<{ col: number; row: number } | null>(null);
  // Loaded atlas images keyed by tileset id — one per slot in the map's list.
  const imgsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const [imgTick, setImgTick] = useState(0);
  // Per-layer offscreen buffers — same pattern as the painter, so a large
  // tilemap placed in a scene re-blits as ONE drawImage per layer per render,
  // not thousands of per-cell drawImages every time the player moves.
  const bufsRef = useRef<Map<string, { buf: HTMLCanvasElement; prevTiles: number[] | null; prevXf?: Record<number, number> }>>(new Map());

  // Resolved ordered tileset list (primary + extras) with firstgids.
  const gidSlots = useMemo(() => tilemapTilesets(map, tilesets), [map, tilesets]);
  // Atlas URLs for every slot, resolved through AssetStore.
  const slotPaths = useMemo(
    () => gidSlots.map((s) => (s.ts.imageFile ? tilesetImagePath(s.ts) : undefined)),
    [gidSlots],
  );
  const slotUrls = useAssetURLs(slotPaths);
  useEffect(() => {
    let cancelled = false;
    const wanted = new Map<string, string>();
    gidSlots.forEach((s, i) => { const u = slotPaths[i] ? slotUrls.get(slotPaths[i]!) : undefined; if (u) wanted.set(s.ts.id, u); });
    // Drop images for tilesets no longer in the list.
    for (const id of Array.from(imgsRef.current.keys())) if (!wanted.has(id)) imgsRef.current.delete(id);
    Promise.all(Array.from(wanted.entries()).map(([id, url]) =>
      loadTilesetImage(url).then((im) => { if (!cancelled && im) imgsRef.current.set(id, im); }),
    )).then(() => { if (!cancelled) setImgTick((n) => n + 1); });
    return () => { cancelled = true; };
    // slotUrls is a fresh Map each render; key on its joined values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gidSlots, Array.from(slotUrls.values()).join("|")]);

  // Build the draw slots (image + firstgid) the canvas helpers consume.
  const tileSlots: TileSlot[] = useMemo(
    () => gidSlots.map((s) => ({ tileset: s.ts, img: imgsRef.current.get(s.ts.id) ?? null, firstgid: s.firstgid, count: s.count })),
    // imgTick bumps when an image finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gidSlots, imgTick],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Sync per-layer buffers (delta paint where possible, full repaint otherwise).
    const bufs = bufsRef.current;
    const liveIds = new Set(map.layers.map((L) => L.id));
    for (const id of Array.from(bufs.keys())) if (!liveIds.has(id)) bufs.delete(id);
    const nativeW = Math.max(1, map.cols * ts.tileW);
    const nativeH = Math.max(1, map.rows * ts.tileH);
    // If a slot image isn't decoded yet, paintLayerBuffer is a no-op for those
    // cells. We must NOT mark `prevTiles` as painted in that case — the next
    // effect run (after image load) would diff tiles against itself, see no
    // changes, and skip every cell, leaving the buffer permanently empty.
    // Finalize a layer only when EVERY tileset image is loaded — otherwise a
    // late-loading multi-tileset atlas leaves its cells frozen blank (see the
    // TilemapTab fix). Until then we full-repaint every render.
    // Read readiness from the SAME `tileSlots` paintLayerBuffer draws from —
    // NOT imgsRef directly. imgsRef is mutated before `imgTick` bumps, so a
    // fresh imgsRef read can report "ready" while the memoized tileSlots still
    // holds img:null → we'd paint a blank buffer, finalize it (prevTiles set),
    // and the delta path would never repaint it (the "one layer frozen blank
    // until Play→Stop" bug).
    const allReady = tileSlots.every((s, i) => !gidSlots[i]?.ts.imageFile || ((s.img?.naturalWidth ?? 0) > 0));
    for (const L of map.layers) {
      let entry = bufs.get(L.id);
      if (!allReady && entry) { entry.prevTiles = null; entry.prevXf = undefined; }
      if (!entry) {
        entry = { buf: document.createElement("canvas"), prevTiles: null };
        entry.buf.width = nativeW;
        entry.buf.height = nativeH;
        bufs.set(L.id, entry);
      }
      if (entry.buf.width !== nativeW || entry.buf.height !== nativeH) {
        entry.buf.width = nativeW;
        entry.buf.height = nativeH;
        entry.prevTiles = null;
        entry.prevXf = undefined;
      }
      paintLayerBuffer(entry.buf, tileSlots, L.tiles, entry.prevTiles, map.cols, map.rows, ts.tileW, ts.tileH, L.xf, entry.prevXf);
      if (allReady) { entry.prevTiles = L.tiles; entry.prevXf = L.xf; }
    }
    // Composite to visible canvas — one drawImage per visible layer + scale.
    const W = Math.max(1, Math.round(map.cols * ts.tileW * scale));
    const H = Math.max(1, Math.round(map.rows * ts.tileH * scale));
    // Browsers blank a canvas once a dimension passes ~16k px (or it fails to
    // allocate the backing store), so a big map / high zoom would vanish in the
    // viewport until a forced re-render (Play→Stop). Cap the BACKING STORE under
    // a safe limit and composite through a matching scale transform. The
    // element's CSS size is 100% of the parent (= full map × scale), so the
    // on-screen size and pointer math are unchanged — only crispness softens at
    // extreme sizes.
    const MAX_DIM = 8192;
    const capScale = Math.min(1, MAX_DIM / W, MAX_DIM / H);
    const cw = Math.max(1, Math.round(W * capScale));
    const ch = Math.max(1, Math.round(H * capScale));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.setTransform(capScale, 0, 0, capScale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    const sorted = [...map.layers].sort((a, b) => a.z - b.z);
    for (const L of sorted) {
      if (!L.visible) continue;
      const entry = bufs.get(L.id);
      if (!entry) continue;
      ctx.globalAlpha = L.alpha;
      ctx.drawImage(entry.buf, 0, 0, nativeW, nativeH, 0, 0, W, H);
      // BigTile placements — one drawImage per placement using the BigTile's
      // source region from its OWNING tileset (BigTiles are authored on a
      // specific tileset; a map may mix several). Matches what the runtime
      // spawns (one composite Image). Drawn at the MAP cell size so a BigTile
      // from a differently-sized tileset still tiles cleanly.
      // Y-sort layers draw placements in BASE-Y order (lower bases on top) so
      // the scene preview matches the runtime's forest layering.
      const lPlacements = [...(((L as { bigTilePlacements?: { bigTileId: string; c: number; r: number }[]; ySort?: boolean }).bigTilePlacements) ?? [])];
      if ((L as { ySort?: boolean }).ySort) {
        const hOf = (bid: string) => {
          const o = gidSlots.find((s) => (s.ts.bigTiles ?? []).some((b) => b.id === bid));
          return o?.ts.bigTiles?.find((b) => b.id === bid)?.h ?? 1;
        };
        lPlacements.sort((a, b) => ((a.r + hOf(a.bigTileId)) * ts.tileH + ((a as { oy?: number }).oy ?? 0)) - ((b.r + hOf(b.bigTileId)) * ts.tileH + ((b as { oy?: number }).oy ?? 0)));
      }
      for (const placement of lPlacements) {
        const owner = gidSlots.find((s) => (s.ts.bigTiles ?? []).some((b) => b.id === placement.bigTileId));
        if (!owner) continue;
        const ots = owner.ts;
        const oImg = imgsRef.current.get(ots.id);
        if (!oImg || !oImg.complete) continue;
        const bt = (ots.bigTiles ?? []).find((b) => b.id === placement.bigTileId);
        if (!bt) continue;
        const sx = ots.offsetX + bt.c * (ots.tileW + ots.spacingX);
        const sy = ots.offsetY + bt.r * (ots.tileH + ots.spacingY);
        const sw = bt.w * ots.tileW + (bt.w - 1) * ots.spacingX;
        const sh = bt.h * ots.tileH + (bt.h - 1) * ots.spacingY;
        // Render at the OWNING tileset's true size (no squish), top-left anchored.
        const dw = bt.w * ots.tileW * scale;
        const dh = bt.h * ots.tileH * scale;
        const px = (placement as { ox?: number }).ox ?? 0;
        const py = (placement as { oy?: number }).oy ?? 0;
        const dx = (placement.c * ts.tileW + px) * scale;
        const dy = (placement.r * ts.tileH + py) * scale;
        ctx.drawImage(oImg, sx, sy, sw, sh, dx, dy, dw, dh);
      }
      // Animated-tile placements — static first-frame preview (the scene
      // viewport doesn't drive an animation clock; the runtime cycles them).
      // Without this the tile is invisible in the scene editor even though it
      // renders in the tilemap editor and at runtime.
      for (const placement of ((L as any).animatedTilePlacements ?? [])) {
        const owner = gidSlots.find((s) => (s.ts.animatedTiles ?? []).some((a) => a.id === placement.animatedTileId));
        if (!owner) continue;
        const ots = owner.ts;
        const oImg = imgsRef.current.get(ots.id);
        if (!oImg || !oImg.complete) continue;
        const at = (ots.animatedTiles ?? []).find((a) => a.id === placement.animatedTileId);
        if (!at || at.frames.length === 0 || ots.cols <= 0) continue;
        // First frame, normalized to a region (single cell or multi-cell /
        // BigTile). Multi-cell renders at native size, top-left anchored.
        const reg = animFrameRegion(at.frames[0], ots.cols);
        const sx = ots.offsetX + reg.c * (ots.tileW + ots.spacingX);
        const sy = ots.offsetY + reg.r * (ots.tileH + ots.spacingY);
        const sw = reg.w * ots.tileW + (reg.w - 1) * ots.spacingX;
        const sh = reg.h * ots.tileH + (reg.h - 1) * ots.spacingY;
        const dx = placement.c * ts.tileW * scale;
        const dy = placement.r * ts.tileH * scale;
        ctx.drawImage(oImg, sx, sy, sw, sh, dx, dy, reg.w * ots.tileW * scale, reg.h * ots.tileH * scale);
      }
    }
    ctx.globalAlpha = 1;
    // Rect-tool live overlay (only when this tilemap is the paint target).
    // Drawn inside the composite so each frame is from scratch — no overlay
    // ghosts piling up as the drag moves.
    if (paintActive && paintRectDrag) {
      const c0 = Math.min(paintRectDrag.c0, paintRectDrag.c1);
      const r0 = Math.min(paintRectDrag.r0, paintRectDrag.r1);
      const c1 = Math.max(paintRectDrag.c0, paintRectDrag.c1);
      const r1 = Math.max(paintRectDrag.r0, paintRectDrag.r1);
      const tw = ts.tileW * scale, th = ts.tileH * scale;
      const x = c0 * tw, y = r0 * th;
      const w = (c1 - c0 + 1) * tw, h = (r1 - r0 + 1) * th;
      ctx.fillStyle = "rgba(255,210,60,0.18)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,210,60,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
    // Ghost tile preview — draw the ACTUAL selected tile(s) under the cursor at
    // ~60% alpha so you see what you're painting, not just a box.
    if (paintActive && hoverCell && paintTilesetId && !paintRectDrag) {
      const pslot = gidSlots.find((s) => s.ts.id === paintTilesetId);
      const pimg = pslot ? imgsRef.current.get(pslot.ts.id) : undefined;
      const tw = ts.tileW * scale, th = ts.tileH * scale;
      if (pslot && pimg && pimg.complete && paintSel && paintTool !== "bucket") {
        const pts = pslot.ts;
        const sC0 = Math.min(paintSel.c0, paintSel.c1);
        const sR0 = Math.min(paintSel.r0, paintSel.r1);
        const sW = Math.abs(paintSel.c1 - paintSel.c0) + 1;
        const sH = Math.abs(paintSel.r1 - paintSel.r0) + 1;
        const { outW, outH, cells } = transformedSelection(sW, sH, paintXf);
        const fx = (paintXf & 1) !== 0, fy = (paintXf & 2) !== 0, rot = (paintXf >> 2) & 3;
        ctx.globalAlpha = 0.6;
        for (const cell of cells) {
          const sx = pts.offsetX + (sC0 + cell.sc) * (pts.tileW + pts.spacingX);
          const sy = pts.offsetY + (sR0 + cell.sr) * (pts.tileH + pts.spacingY);
          const dx = (hoverCell.col + cell.ox) * tw, dy = (hoverCell.row + cell.oy) * th;
          ctx.save();
          ctx.translate(dx + tw / 2, dy + th / 2);
          if (rot) ctx.rotate((rot * Math.PI) / 2);
          ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
          ctx.drawImage(pimg, sx, sy, pts.tileW, pts.tileH, -tw / 2, -th / 2, tw, th);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,210,60,0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hoverCell.col * tw + 0.75, hoverCell.row * th + 0.75, outW * tw - 1.5, outH * th - 1.5);
      } else {
        ctx.strokeStyle = "rgba(255,210,60,0.9)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hoverCell.col * tw + 0.75, hoverCell.row * th + 0.75, tw - 1.5, th - 1.5);
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [map.layers, map.cols, map.rows, ts, scale, imgTick, tileSlots, gidSlots, paintActive, paintRectDrag, hoverCell, paintSel, paintTilesetId, paintTool, paintXf]);

  // Mouse event handler — paints when in paint mode, otherwise hands off to
  // the parent (drag-to-move). Document-level listeners during paint keep
  // the stroke alive if the cursor leaves the canvas.
  const onCanvasMouseDown = (e: MouseEvent) => {
    // Middle-mouse always pans the viewport, even while painting — so you can
    // scroll around a big map without dropping tiles. Left-mouse paints.
    if (e.button === 1) { onMouseDown(e); return; }
    if (!paintActive || !onPaintDown) { onMouseDown(e); return; }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pick = (clientX: number, clientY: number): { col: number; row: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left, y = clientY - rect.top;
      const col = Math.floor(x / (ts.tileW * scale));
      const row = Math.floor(y / (ts.tileH * scale));
      if (col < 0 || col >= map.cols || row < 0 || row >= map.rows) return null;
      return { col, row };
    };
    const p = pick(e.clientX, e.clientY);
    if (!p) return;
    onPaintDown(p.col, p.row, e);
    const move = (ev: globalThis.MouseEvent) => {
      const q = pick(ev.clientX, ev.clientY);
      if (q) onPaintMove?.(q.col, q.row);
    };
    const up = () => {
      onPaintUp?.();
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  // Live collision preview: when the Colliders toggle is on, overlay the
  // POLYGON shapes (not the decomposed rectangles) per cell — for curved or
  // diagonal shapes the rect decomposition produces dozens of 1px-tall slices
  // that obscure the actual shape. The runtime still uses decomposed rects
  // for physics, but the user wants to see the polygon they drew.
  const collisionShapes = (() => {
    if (!showColliders) return null;
    const polys: { points: { x: number; y: number }[] }[] = [];
    // Full-cell solid tiles (a tile marked solid with NO custom polygon) — the
    // common case. These were never drawn before, so the toggle looked dead for
    // ordinary cell collisions. Now every collidable layer's solid cells show.
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    for (const L of map.layers) {
      if (!L.collides) continue;
      for (let r = 0; r < map.rows; r++) {
        for (let c = 0; c < map.cols; c++) {
          const t = L.tiles[r * map.cols + c];
          if (t === undefined || t < 0) continue;
          // Resolve to the owning tileset; colliders are keyed by LOCAL index.
          const slot = gidSlots.find((s) => t >= s.firstgid && t < s.firstgid + s.count);
          if (!slot) continue;
          const local = t - slot.firstgid;
          if (!(slot.ts.solidTiles ?? []).includes(local)) continue;
          const cx = c * ts.tileW;
          const cy = r * ts.tileH;
          const poly = slot.ts.tileColliders?.[String(local)];
          if (poly && poly.points.length >= 3) {
            // Custom polygon — scale from the OWNING tileset's pixel space to
            // the map cell so a differently-sized tileset's shape still aligns.
            const sxr = ts.tileW / slot.ts.tileW;
            const syr = ts.tileH / slot.ts.tileH;
            polys.push({ points: poly.points.map((p) => ({ x: cx + p.x * sxr, y: cy + p.y * syr })) });
          } else {
            rects.push({ x: cx, y: cy, w: ts.tileW, h: ts.tileH });
          }
        }
      }
      // BigTile placement colliders — a custom polygon (preferred) or the
      // legacy cell-rect. Geometry is authored in the OWNING tileset's native
      // px, anchored at the placement's top-left, matching how the runtime
      // spawns the bodies and how the BigTile image is drawn (native size).
      for (const placement of ((L as { bigTilePlacements?: { bigTileId: string; c: number; r: number }[] }).bigTilePlacements ?? [])) {
        const owner = gidSlots.find((s) => (s.ts.bigTiles ?? []).some((b) => b.id === placement.bigTileId));
        if (!owner) continue;
        const bt = (owner.ts.bigTiles ?? []).find((b) => b.id === placement.bigTileId);
        if (!bt) continue;
        const baseX = placement.c * ts.tileW;
        const baseY = placement.r * ts.tileH;
        if (bt.collidePoly && bt.collidePoly.points.length >= 3) {
          polys.push({ points: bt.collidePoly.points.map((p) => ({ x: baseX + p.x, y: baseY + p.y })) });
        } else if (bt.collide) {
          rects.push({
            x: baseX + bt.collide.cx * owner.ts.tileW,
            y: baseY + bt.collide.cy * owner.ts.tileH,
            w: bt.collide.cw * owner.ts.tileW,
            h: bt.collide.ch * owner.ts.tileH,
          });
        }
      }
      // Animated-tile placement colliders — the def's own polygon, else the
      // source BigTile's `collidePoly` (animated tiles are built from BigTile
      // footprints). Mirrors the runtime's `_animatedDamagePoly` so the purple
      // overlay shows EXACTLY where mining tests the shape.
      for (const placement of ((L as { animatedTilePlacements?: { animatedTileId: string; c: number; r: number }[] }).animatedTilePlacements ?? [])) {
        const owner = gidSlots.find((s) => (s.ts.animatedTiles ?? []).some((a) => a.id === placement.animatedTileId));
        if (!owner) continue;
        const at = (owner.ts.animatedTiles ?? []).find((a) => a.id === placement.animatedTileId);
        if (!at || at.frames.length === 0) continue;
        const baseX = placement.c * ts.tileW;
        const baseY = placement.r * ts.tileH;
        let poly = at.collide && at.collide.points.length >= 3 ? at.collide : undefined;
        if (!poly) {
          const f0 = animFrameRegion(at.frames[0], owner.ts.cols);
          const srcBt = (owner.ts.bigTiles ?? []).find((b) => b.c === f0.c && b.r === f0.r && b.w === f0.w && b.h === f0.h);
          if (srcBt?.collidePoly && srcBt.collidePoly.points.length >= 3) poly = srcBt.collidePoly;
        }
        if (poly) polys.push({ points: poly.points.map((p) => ({ x: baseX + p.x, y: baseY + p.y })) });
      }
    }
    return { polys, rects };
  })();

  return (
    <div
      style={{
        position: "absolute",
        zIndex,
        left: ti.x * scale,
        top:  ti.y * scale,
        width:  fullW * scale,
        height: fullH * scale,
        opacity: layerAlpha,
        outline: paintActive
          ? "2px solid var(--yellow)"
          : isSelected ? "2px solid var(--yellow)" : "1px dashed rgba(255,255,255,0.15)",
        boxShadow: paintActive ? "0 0 0 1px rgba(255,210,60,0.4) inset" : undefined,
        boxSizing: "border-box",
        pointerEvents: isLocked ? "none" : undefined,
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={(e) => {
          if (!paintActive) { if (hoverCell) setHoverCell(null); return; }
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const col = Math.floor((e.clientX - rect.left) / (ts.tileW * scale));
          const row = Math.floor((e.clientY - rect.top) / (ts.tileH * scale));
          if (col < 0 || col >= map.cols || row < 0 || row >= map.rows) { if (hoverCell) setHoverCell(null); return; }
          if (!hoverCell || hoverCell.col !== col || hoverCell.row !== row) setHoverCell({ col, row });
        }}
        onMouseLeave={() => { if (hoverCell) setHoverCell(null); }}
        onDoubleClick={onDoubleClick}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: paintActive ? "cell" : "grab",
          imageRendering: "pixelated",
        }}
      />
      {collisionShapes && (collisionShapes.rects.length > 0 || collisionShapes.polys.length > 0) && (
        <svg
          width="100%" height="100%"
          viewBox={`0 0 ${map.cols * ts.tileW} ${map.rows * ts.tileH}`}
          preserveAspectRatio="none"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {collisionShapes.rects.map((rc, i) => (
            <rect
              key={`r${i}`}
              x={rc.x} y={rc.y} width={rc.w} height={rc.h}
              fill="rgba(255,80,80,0.30)"
              stroke="rgba(255,80,80,0.9)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {collisionShapes.polys.map((poly, i) => (
            <polygon
              key={`p${i}`}
              points={poly.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(190,90,255,0.30)"
              stroke="rgba(190,90,255,0.95)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
    </div>
  );
}

/** Floating paint toolbar — shown over the scene when "Paint on canvas" is on
 *  for a selected tilemap. Tools row, palette (drag-select), and layers list
 *  (compact). Position: top-left of the scene area so it doesn't fight the
 *  reset-zoom toggles in the top-right. */
function InScenePaintToolbar({
  vpBox, map, tileset, tilesetOptions, activeTilesetId, setActiveTilesetId,
  tool, setTool, xf, setXf, selection, setSelection, activeLayerId, setActiveLayerId,
  terrainId, setTerrainId, bigTileId, setBigTileId, onClose,
}: {
  vpBox: { left: number; top: number; right: number };
  map: TilemapAsset;
  tileset: TilesetAsset;
  tilesetOptions: { id: string; name: string }[];
  activeTilesetId: string;
  setActiveTilesetId: (id: string) => void;
  tool: PaintTool;
  setTool: (t: PaintTool) => void;
  xf: number;
  setXf: (updater: (v: number) => number) => void;
  selection: PaintRectDrag;
  setSelection: (s: PaintRectDrag) => void;
  activeLayerId: string;
  setActiveLayerId: (id: string) => void;
  terrainId: string | null;
  setTerrainId: (id: string | null) => void;
  bigTileId: string | null;
  setBigTileId: (id: string | null) => void;
  onClose: () => void;
}) {
  const updateTilemapLayer = useEditor((s) => s.updateTilemapLayer);
  const sC0 = Math.min(selection.c0, selection.c1);
  const sR0 = Math.min(selection.r0, selection.r1);
  const sW = Math.abs(selection.c1 - selection.c0) + 1;
  const sH = Math.abs(selection.r1 - selection.r0) + 1;
  const tsCols = tileset.cols;
  const terrains = tileset.terrains ?? [];
  const activeTerrain = terrainId ? terrains.find((t) => t.id === terrainId) ?? null : null;
  const bigTiles = tileset.bigTiles ?? [];
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: vpBox.top + 10, left: vpBox.left + 10,
        width: 260,
        maxHeight: "calc(100vh - 120px)", overflowY: "auto",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        padding: 10,
        display: "flex", flexDirection: "column", gap: 8,
        zIndex: 90,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", flex: 1 }}>
          ✏ Painting · {map.name}
        </span>
        <button
          onClick={onClose}
          title="Exit paint mode"
          style={{ fontSize: 14, lineHeight: 1, padding: "0 6px", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text-dim)" }}
        >×</button>
      </div>

      {/* Tileset switcher — only when the map mixes multiple tilesets. Switching
          repoints the palette / big tiles / terrain below (and paints stamp the
          chosen tileset's GLOBAL ids). */}
      {tilesetOptions.length > 1 && (
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 3 }}>
            Tileset
          </div>
          <select
            value={activeTilesetId}
            onChange={(e) => setActiveTilesetId(e.target.value)}
            style={{ width: "100%", fontSize: 11, padding: "3px 6px", background: "var(--inner)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 3 }}
          >
            {tilesetOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 3 }}>
        {(["brush", "erase", "bucket", "rect", "picker"] as PaintTool[]).map((t) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            style={{
              fontSize: 10, padding: "3px 4px", cursor: "pointer",
              background: tool === t ? "var(--accent)" : "var(--inner)",
              color: tool === t ? "var(--on-accent)" : "var(--text)",
              border: `1px solid ${tool === t ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 3,
            }}
          >{t}</button>
        ))}
      </div>

      {/* Transform — flip/rotate the brush as a unit (also applies to rect fill).
          Bits: 1 = flipX, 2 = flipY, (v>>2)&3 = rotation ×90° CW. */}
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        {([
          ["↻ 90°", (v: number) => (v & 3) | (((((v >> 2) & 3) + 1) & 3) << 2), ((xf >> 2) & 3) !== 0],
          ["⇄ H", (v: number) => v ^ 1, (xf & 1) !== 0],
          ["⇅ V", (v: number) => v ^ 2, (xf & 2) !== 0],
        ] as [string, (v: number) => number, boolean][]).map(([label, fn, active]) => (
          <button
            key={label}
            onClick={() => setXf(fn)}
            style={{
              flex: 1, fontSize: 10, padding: "3px 4px", cursor: "pointer",
              background: active ? "var(--teal)" : "var(--inner)",
              color: active ? "var(--frame)" : "var(--text)",
              border: `1px solid ${active ? "var(--teal)" : "var(--border)"}`,
              borderRadius: 3,
            }}
          >{label}</button>
        ))}
        {xf !== 0 && (
          <button
            onClick={() => setXf(() => 0)}
            title="Reset transform"
            style={{ fontSize: 10, padding: "3px 6px", cursor: "pointer", background: "var(--inner)", color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 3 }}
          >↺</button>
        )}
      </div>

      {bigTiles.length > 0 && (
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 3 }}>
            Big tiles
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            <button
              onClick={() => setBigTileId(null)}
              style={{
                fontSize: 10, padding: "3px 7px", cursor: "pointer",
                background: !bigTileId ? "var(--accent)" : "var(--inner)",
                color: !bigTileId ? "var(--on-accent)" : "var(--text)",
                border: `1px solid ${!bigTileId ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 3,
              }}
            >None</button>
            {bigTiles.map((bt) => {
              const isActive = bt.id === bigTileId;
              return (
                <button
                  key={bt.id}
                  onClick={() => setBigTileId(bt.id)}
                  title={`Place ${bt.w}×${bt.h} composite`}
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

      {terrains.length > 0 && (
        <div>
          <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 3 }}>
            Terrain
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            <button
              onClick={() => setTerrainId(null)}
              title="Paint individual tiles"
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
                  onClick={() => setTerrainId(tr.id)}
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

      <div>
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 3 }}>
          Palette · {sW === 1 && sH === 1 ? `tile ${sR0 * tsCols + sC0}` : `${sW}×${sH}`}
        </div>
        <InScenePalette
          tileset={tileset}
          selection={selection}
          onSelectionChange={setSelection}
        />
      </div>

      <div>
        <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 3 }}>Layers</div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {[...map.layers].sort((a, b) => b.z - a.z).map((L) => {
            const isActive = L.id === activeLayerId;
            return (
              <div
                key={L.id}
                onClick={() => setActiveLayerId(L.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 4, padding: "2px 4px",
                  background: isActive ? "rgba(255,210,60,0.22)" : "transparent",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer", fontSize: 10,
                }}
              >
                <Toggle
                  value={L.visible}
                  onChange={(v) => updateTilemapLayer(map.id, L.id, { visible: v })}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: "auto", margin: 0 }}
                />
                <span style={{ flex: 1 }}>{L.name}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 9 }}>z{L.z}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Tile palette inside the in-scene toolbar. Identical drag-select behavior
 *  as the painter's main palette — kept self-contained here so SceneEditor
 *  doesn't import from TilemapTab (avoids the cross-panel coupling). */
function InScenePalette({
  tileset, selection, onSelectionChange,
}: {
  tileset: TilesetAsset;
  selection: PaintRectDrag;
  onSelectionChange: (s: PaintRectDrag) => void;
}) {
  const PAL_W = 240;
  const scale = tileset.sheetW > 0 ? Math.min(PAL_W / tileset.sheetW, 2) : 1;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);
  const tilesetUrl = useTilesetURL(tileset);

  useEffect(() => {
    let cancelled = false;
    if (!tilesetUrl) { imgRef.current = null; setImgTick((n) => n + 1); return; }
    loadTilesetImage(tilesetUrl).then((im) => {
      if (cancelled) return;
      imgRef.current = im;
      setImgTick((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [tilesetUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = Math.max(1, Math.round(tileset.sheetW * scale));
    const H = Math.max(1, Math.round(tileset.sheetH * scale));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    const img = imgRef.current;
    if (img && img.complete) ctx.drawImage(img, 0, 0, W, H);
    const c0 = Math.min(selection.c0, selection.c1);
    const r0 = Math.min(selection.r0, selection.r1);
    const c1 = Math.max(selection.c0, selection.c1);
    const r1 = Math.max(selection.r0, selection.r1);
    const x = (tileset.offsetX + c0 * (tileset.tileW + tileset.spacingX)) * scale;
    const y = (tileset.offsetY + r0 * (tileset.tileH + tileset.spacingY)) * scale;
    const w = ((c1 - c0 + 1) * (tileset.tileW + tileset.spacingX) - tileset.spacingX) * scale;
    const h = ((r1 - r0 + 1) * (tileset.tileH + tileset.spacingY) - tileset.spacingY) * scale;
    ctx.fillStyle = "rgba(255,210,60,0.18)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,210,60,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }, [imgTick, tileset, selection, scale]);

  const cellAt = (clientX: number, clientY: number): { c: number; r: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;
    const c = Math.floor((x - tileset.offsetX) / (tileset.tileW + tileset.spacingX));
    const r = Math.floor((y - tileset.offsetY) / (tileset.tileH + tileset.spacingY));
    if (c < 0 || c >= tileset.cols || r < 0 || r >= tileset.rows) return null;
    return { c, r };
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = cellAt(e.clientX, e.clientY);
    if (!p) return;
    onSelectionChange({ c0: p.c, r0: p.r, c1: p.c, r1: p.r });
    const move = (ev: globalThis.MouseEvent) => {
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

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={onMouseDown}
      style={{ display: "block", cursor: "crosshair", imageRendering: "pixelated", outline: "1px solid var(--border)" }}
    />
  );
}

/** Scene-editor render of one WeaponSlot. The host BP's gizmo div is sized
 *  so its TOP-LEFT corresponds to the host frame's image-pixel (0, 0); the
 *  host pivot pixel lives at (hostPivotInGizmoX, hostPivotInGizmoY) inside.
 *  We position the weapon image so its OWN pivot pixel lands at the host's
 *  named image point (or host pivot when the point is absent on this frame). */
function SceneWeaponSlotPreview({
  cfg,
  sprites,
  hostFirstFrame,
  hostPivotInGizmoX,
  hostPivotInGizmoY,
  hostScaleX,
  hostScaleY,
  scale,
}: {
  cfg: Record<string, unknown>;
  sprites: SpriteAsset[];
  hostFirstFrame: { points?: Array<{ name: string; x: number; y: number }> } | undefined;
  hostPivotInGizmoX: number;
  hostPivotInGizmoY: number;
  hostScaleX: number;
  hostScaleY: number;
  scale: number;
}) {
  const spriteId = String(cfg.spriteId ?? "");
  const animName = String(cfg.currentAnimation ?? "");
  const pointName = String(cfg.imagePoint ?? "");
  const offX = Number(cfg.offsetX ?? 0);
  const offY = Number(cfg.offsetY ?? 0);
  const angle = Number(cfg.angleOffset ?? 0);
  const wSx = Number(cfg.scaleX ?? 1);
  const wSy = Number(cfg.scaleY ?? 1);
  const visible = Number(cfg.visible ?? 1) !== 0;
  const playing = Number(cfg.playing ?? 1) !== 0;
  const startFrame = Math.max(0, Math.floor(Number(cfg.startFrame ?? 0)));
  const sprite = spriteId ? sprites.find((s) => s.id === spriteId) : undefined;
  const anim = sprite?.animations.find((a) => a.name === animName) ?? sprite?.animations[0];
  const frameIdx = !playing && anim ? Math.min(startFrame, anim.frames.length - 1) : 0;
  const frame = anim?.frames[Math.max(0, frameIdx)];
  const url = useSpriteFrameURL(sprite, frame);
  if (!visible || !sprite || !frame || !url) return null;
  const pt = pointName
    ? hostFirstFrame?.points?.find((p) => p.name === pointName)
    : undefined;
  // Anchor inside the gizmo div = host image-point in image-pixel coords,
  // converted to gizmo CSS pixels via the host's instance scale + canvas zoom.
  const anchorX = pt
    ? pt.x * hostScaleX * scale
    : hostPivotInGizmoX;
  const anchorY = pt
    ? pt.y * hostScaleY * scale
    : hostPivotInGizmoY;
  const baseW = (frame.imageW ?? sprite.width);
  const baseH = (frame.imageH ?? sprite.height);
  const weaponW = baseW * scale * wSx;
  const weaponH = baseH * scale * wSy;
  const wPivotX = (frame.pivotX ?? baseW / 2) * scale * wSx;
  const wPivotY = (frame.pivotY ?? baseH / 2) * scale * wSy;
  const x = anchorX + offX * scale;
  const y = anchorY + offY * scale;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{
        position: "absolute",
        left: Math.round(x - wPivotX),
        top: Math.round(y - wPivotY),
        width: weaponW,
        height: weaponH,
        imageRendering: "pixelated",
        pointerEvents: "none",
        transform: angle !== 0 ? `rotate(${angle}deg)` : undefined,
        transformOrigin: `${wPivotX}px ${wPivotY}px`,
      }}
    />
  );
}
