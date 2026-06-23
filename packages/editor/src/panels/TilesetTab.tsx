import { useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { loadTilesetImage } from "./tilemapDraw";
import { writeAssetFromDataURL, tilesetImagePath, spriteFrameDiskPath } from "../AssetStore";
import { useTilesetURL, FrameThumb } from "../components/FrameThumb";
import { ManualTileBuilder } from "./ManualTileBuilder";
import { TilesetPixelMover } from "./TilesetPixelMover";
import { TagChips } from "./inspector/BlueprintInspector";
import { useResizableWidth, SidebarResizeHandle } from "./resizableSidebar";
import type { TerrainDef, TerrainRule, NeighborState, TilesetAsset, SpriteAsset, SpriteAnimationDef, AnimFrame } from "../project";
import { animFrameRegion } from "../project";

/**
 * TilesetTab — import a spritesheet, configure how it slices into tiles
 * (size / offset / spacing), and mark which tile indices block movement.
 *
 * Single-pane layout: settings on the left, sliced palette on the right.
 * Per-tile collision is a click-to-toggle on each cell — solid tiles get
 * a red overlay so the collision map is readable at a glance.
 *
 * The actual slicing is just `addTilesetImage(...)` config — Phaser does
 * the work at runtime. The editor just shows what each grid index will be.
 */
export function TilesetTab({ tilesetId }: { tilesetId: string }) {
  const tileset = useEditor((s) => (s.project.tilesets ?? []).find((t) => t.id === tilesetId));
  const renameTileset = useEditor((s) => s.renameTileset);
  const updateTileset = useEditor((s) => s.updateTileset);
  const toggleTileSolid = useEditor((s) => s.toggleTileSolid);
  const addTerrain = useEditor((s) => s.addTerrain);
  const removeTerrain = useEditor((s) => s.removeTerrain);
  const updateTerrain = useEditor((s) => s.updateTerrain);
  const addTerrainRule = useEditor((s) => s.addTerrainRule);
  const removeTerrainRule = useEditor((s) => s.removeTerrainRule);
  const updateTerrainRule = useEditor((s) => s.updateTerrainRule);
  const reorderTerrainRule = useEditor((s) => s.reorderTerrainRule);
  const setTileCollider = useEditor((s) => s.setTileCollider);
  const setTileMining = useEditor((s) => s.setTileMining);
  const setTileDropLayer = useEditor((s) => s.setTileDropLayer);
  const setTileGrowBack = useEditor((s) => s.setTileGrowBack);
  const setTileGrowBackPop = useEditor((s) => s.setTileGrowBackPop);
  const setTileOnBelowRemoved = useEditor((s) => s.setTileOnBelowRemoved);
  const setTilesetGlobalExcludedTags = useEditor((s) => s.setTilesetGlobalExcludedTags);
  const setTileExcludedTags = useEditor((s) => s.setTileExcludedTags);
  const addBigTile = useEditor((s) => s.addBigTile);
  const removeBigTile = useEditor((s) => s.removeBigTile);
  const setBigTilePivot = useEditor((s) => s.setBigTilePivot);
  const setBigTileSortY = useEditor((s) => s.setBigTileSortY);
  const setBigTileSortLineY = useEditor((s) => s.setBigTileSortLineY);
  const setBigTileCollide = useEditor((s) => s.setBigTileCollide);
  const setBigTileCollidePoly = useEditor((s) => s.setBigTileCollidePoly);
  const patchBigTile = useEditor((s) => s.patchBigTile);
  const setBigTileTags = useEditor((s) => s.setBigTileTags);
  const setBigTileOnBelowRemoved = useEditor((s) => s.setBigTileOnBelowRemoved);
  const setBigTileExcludedTags = useEditor((s) => s.setBigTileExcludedTags);
  const addAnimatedTile = useEditor((s) => s.addAnimatedTile);
  const removeAnimatedTile = useEditor((s) => s.removeAnimatedTile);
  const updateAnimatedTile = useEditor((s) => s.updateAnimatedTile);
  const setAnimatedTileFrames = useEditor((s) => s.setAnimatedTileFrames);
  const setAnimatedTileDrops = useEditor((s) => s.setAnimatedTileDrops);
  // BigTile mode + live drag-select rectangle in the palette.
  const [bigTileMode, setBigTileMode] = useState(false);
  // Committed cells in the BigTile-creation selection. Stored as a Set of
  // `"c,r"` strings so the palette can do O(1) hit-tests during render and
  // Ctrl+click toggles map cleanly. Null = no selection (palette shows the
  // creation prompt).
  const [bigTileSel, setBigTileSel] = useState<Set<string> | null>(null);
  // Damage-area drag-select mode — when set, the palette captures drags
  // constrained to that BigTile's region and writes its mineable `damageRect`.
  // (Reuses the generic cell-rect pick the collision rect used before it
  // became a polygon.)
  const [damageEditBigTileId, setDamageEditBigTileId] = useState<string | null>(null);
  // Which BigTile's collision-polygon editor is open (one shape over the whole
  // footprint, edited like a single oversized cell).
  const [polyEditBigTileId, setPolyEditBigTileId] = useState<string | null>(null);
  // Animated-tile frame-slot assign mode. When set, clicking a tile in the
  // palette writes that tile index into the (animatedTileId, frameIdx) slot
  // and exits the mode. `frameIdx === frames.length` means "append".
  const [animFrameAssign, setAnimFrameAssign] = useState<{ animatedTileId: string; frameIdx: number } | null>(null);
  // Which solid tile (if any) is currently being collider-edited. Click a
  // solid tile in the palette to select; the editor below the palette shows
  // its custom collision box.
  const [selectedSolidTile, setSelectedSolidTile] = useState<number | null>(null);
  // Multi-select: tile indices whose properties (solid / hardness / drops /
  // exclude tags / cascade) edit TOGETHER. selectedSolidTile is the "anchor"
  // whose values the editor displays; Ctrl/Cmd-click adds/removes others.
  const [selectedTiles, setSelectedTiles] = useState<Set<number>>(new Set());
  // Copied collision polygon — stamp one shape onto many cells via the editor's
  // Copy/Paste buttons (survives switching the selected tile).
  const [colliderClipboard, setColliderClipboard] = useState<{ points: { x: number; y: number }[] } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState(1);
  const [manualOpen, setManualOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useResizableWidth("peaky.tilesetTab.sidebarWidth", 320, 220, 600);
  const [busy, setBusy] = useState(false);
  // When non-null, clicking a tile in the palette assigns it to a SPECIFIC
  // rule's tile slot (or the terrain's defaultTile). The banner above the
  // palette makes the mode switch unambiguous.
  type AssignTarget =
    | { kind: "default"; terrainId: string }
    | { kind: "rule"; terrainId: string; ruleId: string };
  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  // Solid-mode toggle — when OFF (the default), clicking a palette tile does
  // nothing unless an assign-target is active. Stops users from accidentally
  // marking dozens of tiles as solid while exploring/clicking the palette.
  const [solidMode, setSolidMode] = useState(false);

  // Collapsible sidebar sections — persists the open/closed set across
  // sessions. Default = ALL open (no behavior change for existing users).
  const SECTION_KEYS = ["collision", "terrains", "bigTiles", "animatedTiles"] as const;
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("peaky.tilesetTab.expandedSections");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr.filter((k): k is string => typeof k === "string"));
      }
    } catch { /* fall through to default */ }
    return new Set(SECTION_KEYS);
  });
  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("peaky.tilesetTab.expandedSections", JSON.stringify([...next])); } catch { /* ignore quota */ }
      return next;
    });
  };

  // Memoize the solid Set for O(1) overlay lookup as the user pans across
  // a big grid — direct .includes on the array would re-scan every tile.
  const solidSet = useMemo(() => new Set(tileset?.solidTiles ?? []), [tileset?.solidTiles]);

  if (!tileset) {
    return (
      <div style={{ padding: 24, color: "var(--text-dim)" }}>
        Tileset not found.
      </div>
    );
  }

  const handleImport = async (file: File) => {
    setBusy(true);
    try {
      const { dataUrl, w, h } = await readImage(file);
      const tileW = Math.max(1, tileset.tileW);
      const tileH = Math.max(1, tileset.tileH);
      const cols = computeCols(w, tileW, tileset.offsetX, tileset.spacingX);
      const rows = computeRows(h, tileH, tileset.offsetY, tileset.spacingY);
      const max = cols * rows;
      const solidTiles = tileset.solidTiles.filter((i) => i < max);
      // Folder mode: write the atlas to disk under assets/<CB-path>/<name>/tileset.png
      // and store just the filename. AssetStore exposes a blob URL for rendering.
      const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
      const filename = `tileset.${ext}`;
      const ok = await writeAssetFromDataURL(
        tilesetImagePath({ ...tileset, imageFile: filename }),
        dataUrl,
      );
      if (!ok) { console.warn("Tileset import: no AssetStore open — file not written"); return; }
      updateTileset(tileset.id, { imageFile: filename, sheetW: w, sheetH: h, cols, rows, solidTiles });
    } catch {
      console.warn("Tileset import: failed to decode image");
    } finally {
      setBusy(false);
    }
  };
  // Atlas blob URL for the tab's preview canvases. Re-resolves when the
  // tileset changes.
  const tilesetUrl = useTilesetURL(tileset);

  // Slicer field — committing reslices the grid + drops out-of-bounds solids.
  const patchSlice = (patch: Partial<{ tileW: number; tileH: number; offsetX: number; offsetY: number; spacingX: number; spacingY: number }>) => {
    const next = { ...{
      tileW: tileset.tileW, tileH: tileset.tileH,
      offsetX: tileset.offsetX, offsetY: tileset.offsetY,
      spacingX: tileset.spacingX, spacingY: tileset.spacingY,
    }, ...patch };
    // Preserve any manual growGrid growth across a slice change: the extra
    // cols/rows the author added beyond the image-derived grid carry over as a
    // delta on top of the newly-computed grid (instead of being wiped).
    const oldCols = computeCols(tileset.sheetW, tileset.tileW, tileset.offsetX, tileset.spacingX);
    const oldRows = computeRows(tileset.sheetH, tileset.tileH, tileset.offsetY, tileset.spacingY);
    const extraCols = Math.max(0, tileset.cols - oldCols);
    const extraRows = Math.max(0, tileset.rows - oldRows);
    const cols = computeCols(tileset.sheetW, next.tileW, next.offsetX, next.spacingX) + extraCols;
    const rows = computeRows(tileset.sheetH, next.tileH, next.offsetY, next.spacingY) + extraRows;
    const max = cols * rows;
    const solidTiles = tileset.solidTiles.filter((i) => i < max);
    updateTileset(tileset.id, { ...next, cols, rows, solidTiles });
  };

  // Add one column (right) + one row (bottom) per press — keeps the cell size
  // exactly as tuned, just grows the grid by a line each direction. Press it
  // again to add another. (`dc`/`dr` let the +/- buttons grow one axis.)
  const growGrid = (dc: number, dr: number) => {
    if (!tileset) return;
    updateTileset(tileset.id, {
      cols: Math.max(1, tileset.cols + dc),
      rows: Math.max(1, tileset.rows + dr),
    });
  };

  const totalTiles = tileset.cols * tileset.rows;
  // Slicing-error detection — when the current tile/offset/spacing combo
  // produces zero columns or zero rows, the palette is empty and the user
  // can't tell why. Surface the cause inline under the slicer fields.
  const liveCols = computeCols(tileset.sheetW, tileset.tileW, tileset.offsetX, tileset.spacingX);
  const liveRows = computeRows(tileset.sheetH, tileset.tileH, tileset.offsetY, tileset.spacingY);
  const slicingHasZero = !!tileset.imageFile && (liveCols === 0 || liveRows === 0);

  if (manualOpen) return <ManualTileBuilder tileset={tileset} onClose={() => setManualOpen(false)} />;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Settings sidebar ─────────────────────────────────────────── */}
      <div style={{
        width: sidebarWidth, flexShrink: 0, padding: 12,
        background: "var(--panel-2)", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", gap: 10, overflow: "auto",
        position: "relative",
      }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Name</span>
          <input
            value={tileset.name}
            onChange={(e) => renameTileset(tileset.id, e.target.value)}
            style={INP}
          />
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Sheet image</span>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            style={{ ...BTN, padding: "4px 8px" }}
          >{tileset.imageFile ? "Replace…" : "Import sheet…"}</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = "";
            }}
          />
          {tileset.imageFile && (
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              {tileset.sheetW}×{tileset.sheetH}px · {tileset.cols}×{tileset.rows} ({totalTiles}) tiles
            </span>
          )}
          <button
            onClick={() => setManualOpen(true)}
            style={{ ...BTN, padding: "4px 8px" }}
            title="Draw free-form rectangles on a raw/messy sheet; each bakes into one uniform cell → a clean grid tileset."
          >✂ Manual tile builder…</button>
          {!!tileset.imageFile && (
            <button
              onClick={() => setMoveOpen(true)}
              style={{ ...BTN, padding: "4px 8px" }}
              title="Select a free rectangle on the sheet and drag its pixels to reposition — e.g. align an object's bottom to a baseline. Writes the sheet image."
            >✥ Move pixels / align…</button>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <NumField label="Tile W"   value={tileset.tileW}   min={1} onChange={(n) => patchSlice({ tileW:   Math.max(1, n) })} />
          <NumField label="Tile H"   value={tileset.tileH}   min={1} onChange={(n) => patchSlice({ tileH:   Math.max(1, n) })} />
          <NumField label="Offset X" value={tileset.offsetX} min={0} onChange={(n) => patchSlice({ offsetX: Math.max(0, n) })} />
          <NumField label="Offset Y" value={tileset.offsetY} min={0} onChange={(n) => patchSlice({ offsetY: Math.max(0, n) })} />
          <NumField label="Spacing X" value={tileset.spacingX} min={0} onChange={(n) => patchSlice({ spacingX: Math.max(0, n) })} />
          <NumField label="Spacing Y" value={tileset.spacingY} min={0} onChange={(n) => patchSlice({ spacingY: Math.max(0, n) })} />
        </div>
        {slicingHasZero && (
          <div style={{
            padding: "6px 8px",
            background: "rgba(224,116,116,0.08)",
            borderLeft: "3px solid #e07474",
            color: "#e07474",
            fontSize: 10,
            lineHeight: 1.4,
            borderRadius: 2,
          }}>
            Slicing produces no tiles. Tile W × N + offset must fit within Sheet W. Check Tile W, Offset X, Spacing X.
          </div>
        )}

        {!!tileset.imageFile && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 4 }}>
            <span style={LBL}>Grid size ({tileset.cols}×{tileset.rows})</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button style={{ ...BTN, padding: "4px 10px", flex: 1 }} onClick={() => growGrid(1, 1)}
                title="Add one column (right) + one row (bottom). Press again to add more. Keeps your Tile W/H.">⊞ Add row + col</button>
              <button style={{ ...BTN, padding: "4px 8px" }} onClick={() => growGrid(1, 0)} title="Add a column (right)">+ col</button>
              <button style={{ ...BTN, padding: "4px 8px" }} onClick={() => growGrid(0, 1)} title="Add a row (bottom)">+ row</button>
              <button style={{ ...BTN, padding: "4px 8px" }} onClick={() => growGrid(-1, -1)} title="Remove a row + column">−</button>
            </div>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              Object bottoms spilling past the grid? Add edge cells — each press grows the grid by a line, cell size untouched.
            </span>
          </div>
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LBL}>Zoom ({Math.round(zoom * 100)}%)</span>
          <input type="range" min={0.25} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 11, color: "var(--text-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button
              onClick={() => toggleSection("collision")}
              style={{ width: 16, height: 16, padding: 0, lineHeight: 1, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
              title={expandedSections.has("collision") ? "Collapse section" : "Expand section"}
            >{expandedSections.has("collision") ? "▼" : "▶"}</button>
            <span
              style={{ fontWeight: 700, flex: 1, cursor: "pointer" }}
              onClick={() => toggleSection("collision")}
            >Per-tile collision <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({(tileset.solidTiles ?? []).length})</span></span>
            <button
              onClick={() => setSolidMode(!solidMode)}
              title={solidMode ? "Click to disarm solid-toggle mode" : "Click to ARM solid-toggle mode"}
              style={{
                fontSize: 10, padding: "2px 7px", cursor: "pointer",
                background: solidMode ? "var(--red)" : "var(--inner)",
                color: solidMode ? "white" : "var(--text-dim)",
                border: `1px solid ${solidMode ? "var(--red)" : "var(--border)"}`,
                borderRadius: 3,
              }}
            >{solidMode ? "● ARMED" : "○ Arm"}</button>
          </div>
          {expandedSections.has("collision") && (
            <>
              {solidMode
                ? <span>Click a tile to toggle its <span style={{ color: "var(--red)" }}>SOLID</span> flag. Click "Arm" off when done.</span>
                : <span>Click <b>Arm</b> first to mark tiles as solid. Otherwise palette clicks do nothing.</span>}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                {(tileset.solidTiles ?? []).length} of {totalTiles || "—"} tiles marked solid.
              </div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, marginBottom: 4 }} title="Sprites with any of these tags pass THROUGH every collider in this tileset (regular tiles, big tiles, animated tiles). Per-tile excluded tags stack on top of these.">Excluded tags (whole tileset)</div>
                <TagChips
                  tags={tileset.globalExcludedTags ?? []}
                  onChange={(tags) => setTilesetGlobalExcludedTags(tileset.id, tags)}
                  placeholder="ghost, projectile…"
                />
              </div>
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 11, color: "var(--text-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button
              onClick={() => toggleSection("terrains")}
              style={{ width: 16, height: 16, padding: 0, lineHeight: 1, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
              title={expandedSections.has("terrains") ? "Collapse section" : "Expand section"}
            >{expandedSections.has("terrains") ? "▼" : "▶"}</button>
            <span
              style={{ fontWeight: 700, flex: 1, cursor: "pointer" }}
              onClick={() => toggleSection("terrains")}
            >Terrains <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({(tileset.terrains ?? []).length})</span></span>
          </div>
          {expandedSections.has("terrains") && (
            <TerrainsPanel
              tileset={tileset}
              assignTarget={assignTarget}
              setAssignTarget={setAssignTarget}
              onAdd={() => addTerrain(tileset.id)}
              onRemove={(terrainId) => removeTerrain(tileset.id, terrainId)}
              onUpdate={(terrainId, patch) => updateTerrain(tileset.id, terrainId, patch)}
              onAddRule={(terrainId) => addTerrainRule(tileset.id, terrainId)}
              onRemoveRule={(terrainId, ruleId) => removeTerrainRule(tileset.id, terrainId, ruleId)}
              onUpdateRule={(terrainId, ruleId, patch) => updateTerrainRule(tileset.id, terrainId, ruleId, patch)}
              onReorderRule={(terrainId, ruleId, dir) => reorderTerrainRule(tileset.id, terrainId, ruleId, dir)}
            />
          )}
        </div>

        {/* ── Big tiles (multi-cell objects) ─────────────────────────── */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 11, color: "var(--text-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button
              onClick={() => toggleSection("bigTiles")}
              style={{ width: 16, height: 16, padding: 0, lineHeight: 1, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
              title={expandedSections.has("bigTiles") ? "Collapse section" : "Expand section"}
            >{expandedSections.has("bigTiles") ? "▼" : "▶"}</button>
            <span
              style={{ fontWeight: 700, flex: 1, cursor: "pointer" }}
              onClick={() => toggleSection("bigTiles")}
            >Big tiles <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({(tileset.bigTiles ?? []).length})</span></span>
            <button
              onClick={() => { setBigTileMode(!bigTileMode); setBigTileSel(null); }}
              title={bigTileMode ? "Exit big-tile selection mode" : "Drag-select cells in palette to define a big tile"}
              style={{
                fontSize: 10, padding: "2px 7px", cursor: "pointer",
                background: bigTileMode ? "rgba(120,210,120,0.5)" : "var(--inner)",
                color: bigTileMode ? "white" : "var(--text-dim)",
                border: `1px solid ${bigTileMode ? "rgba(120,210,120,0.9)" : "var(--border)"}`,
                borderRadius: 3,
              }}
            >{bigTileMode ? "● ARMED" : "○ Arm"}</button>
          </div>
          {expandedSections.has("bigTiles") && (<>
          {bigTileMode
            ? <span><b>Drag a rectangle on the palette →</b> Ctrl-drag adds to the selection. Ctrl-click toggles single cells. Click "Unite" to create.</span>
            : <span>Multi-cell composites (trees, buildings) painted as one tile. Click <b>Arm</b> to drag-select.</span>}
          {bigTileMode && bigTileSel && bigTileSel.size > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                Selected: {bigTileSel.size} cell{bigTileSel.size === 1 ? "" : "s"}
              </div>
              <button
                onClick={() => {
                  // Compute bbox from cells, store cells relative to bbox top-left.
                  let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
                  const absCells: { c: number; r: number }[] = [];
                  for (const key of bigTileSel) {
                    const [cs, rs] = key.split(",");
                    const c = Number(cs), r = Number(rs);
                    absCells.push({ c, r });
                    if (c < minC) minC = c;
                    if (r < minR) minR = r;
                    if (c > maxC) maxC = c;
                    if (r > maxR) maxR = r;
                  }
                  const w = maxC - minC + 1;
                  const h = maxR - minR + 1;
                  const relCells = absCells.map((cell) => ({ c: cell.c - minC, r: cell.r - minR }));
                  addBigTile(tileset.id, minC, minR, w, h, relCells);
                  setBigTileSel(null);
                }}
                style={{ ...BTN, fontSize: 11, padding: "3px 8px", background: "rgba(120,210,120,0.35)" }}
              >Unite selection as big tile</button>
            </div>
          )}
          {(tileset.bigTiles ?? []).length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 9, color: "var(--text-dim)", textTransform: "uppercase" }}>Existing</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, alignItems: "start" }}>
              {(tileset.bigTiles ?? []).map((bt) => (
                <div key={bt.id} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10, padding: "3px 5px", background: "rgba(120,210,120,0.08)", border: "1px solid rgba(120,210,120,0.25)", borderRadius: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <BigTilePreview ts={tileset} bt={bt} />
                    <span style={{ flex: 1, color: "var(--text-dim)", fontSize: 9 }}>{bt.w}×{bt.h}</span>
                    <button onClick={() => removeBigTile(tileset.id, bt.id)} style={{ fontSize: 10, padding: "0 5px", cursor: "pointer", color: "var(--orange)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 2 }}>×</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: 4, alignItems: "center" }}>
                    <span style={{ color: "var(--text-dim)", fontSize: 9 }}>Pivot X</span>
                    <input
                      type="number" step={0.1} min={0} max={1}
                      value={bt.pivotX ?? 0.5}
                      onChange={(e) => setBigTilePivot(tileset.id, bt.id, Number(e.target.value), bt.pivotY ?? 1)}
                      style={{ ...INP, fontSize: 10, padding: "1px 3px" }}
                    />
                    <span style={{ color: "var(--text-dim)", fontSize: 9 }}>Y</span>
                    <input
                      type="number" step={0.1} min={0} max={1}
                      value={bt.pivotY ?? 1}
                      onChange={(e) => setBigTilePivot(tileset.id, bt.id, bt.pivotX ?? 0.5, Number(e.target.value))}
                      style={{ ...INP, fontSize: 10, padding: "1px 3px" }}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center" }}>
                    <span style={{ color: "var(--text-dim)", fontSize: 9 }}>Cover</span>
                    <select
                      value={bt.sortY ?? 0.5}
                      onChange={(e) => setBigTileSortY(tileset.id, bt.id, Number(e.target.value))}
                      style={{ ...INP, fontSize: 10, padding: "1px 3px" }}
                    >
                      <option value={0}>Always covers player</option>
                      <option value={0.5}>Y-sort (line below)</option>
                      <option value={1}>Never covers player</option>
                    </select>
                  </div>
                  {(bt.sortY ?? 0.5) === 0.5 && (
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 4, alignItems: "center" }}>
                      <span style={{ color: "var(--text-dim)", fontSize: 9 }} title="Where the player passes behind: 0 = top, 0.5 = middle, 1 = bottom of the big tile.">Sort line</span>
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={bt.sortLineY ?? 0.5}
                        onChange={(e) => setBigTileSortLineY(tileset.id, bt.id, Number(e.target.value))}
                      />
                      <span style={{ color: "var(--text-dim)", fontSize: 9, minWidth: 22, textAlign: "right" }}>{(bt.sortLineY ?? 0.5).toFixed(2)}</span>
                    </div>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, marginTop: 3 }}>
                    <Toggle
                      value={bt.solid ?? !!(bt.collidePoly || bt.collide)}
                      onChange={(v) => {
                        patchBigTile(tileset.id, bt.id, { solid: v });
                        // Solid needs a shape to block — seed a full-footprint
                        // one if none exists yet. Turning solid OFF keeps the
                        // shape (it still serves as the mining damage area).
                        if (v && !bt.collidePoly && !bt.collide) {
                          const tw = bt.w * tileset.tileW, th = bt.h * tileset.tileH;
                          setBigTileCollidePoly(tileset.id, bt.id, { points: [
                            { x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th },
                          ] });
                        }
                      }}
                      style={{ margin: 0 }}
                    />
                    <span>Solid (block movement)</span>
                  </label>
                  <button
                    onClick={() => {
                      if (!bt.collidePoly && !bt.collide) {
                        const tw = bt.w * tileset.tileW, th = bt.h * tileset.tileH;
                        setBigTileCollidePoly(tileset.id, bt.id, { points: [
                          { x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th },
                        ] });
                      }
                      setPolyEditBigTileId(polyEditBigTileId === bt.id ? null : bt.id);
                    }}
                    style={{ ...BTN, fontSize: 10, padding: "2px 6px", background: polyEditBigTileId === bt.id ? "rgba(255,210,60,0.35)" : "var(--inner)" }}
                    title="Paint a custom shape. It's the mining damage area (a hit only counts inside it) and, when Solid is on, also blocks movement. Works without Solid."
                  >{polyEditBigTileId === bt.id ? "Close shape" : ((bt.collidePoly || bt.collide) ? "Edit collision / damage shape" : "Add collision / damage shape")}</button>
                  {(bt.collidePoly || bt.collide) && (
                    <button
                      onClick={() => {
                        setBigTileCollidePoly(tileset.id, bt.id, null);
                        setBigTileCollide(tileset.id, bt.id, null);
                        patchBigTile(tileset.id, bt.id, { solid: false });
                        if (polyEditBigTileId === bt.id) setPolyEditBigTileId(null);
                      }}
                      style={{ ...BTN, fontSize: 9, padding: "1px 6px" }}
                    >Clear shape</button>
                  )}
                  {polyEditBigTileId === bt.id && (
                    <BigTileColliderEditor
                      tileset={tileset}
                      bt={bt}
                      onChange={(poly) => setBigTileCollidePoly(tileset.id, bt.id, poly)}
                      onClose={() => setPolyEditBigTileId(null)}
                      clipboard={colliderClipboard}
                      onCopy={setColliderClipboard}
                    />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 3 }}>
                    <span style={{ color: "var(--text-dim)", fontSize: 9 }}>Tags</span>
                    <TagChips
                      tags={bt.tags ?? []}
                      onChange={(next) => setBigTileTags(tileset.id, bt.id, next)}
                      placeholder="ground, grass…"
                    />
                    <span style={{ fontSize: 8, color: "var(--text-dim)", lineHeight: 1.35 }}>
                      The tile's tags (one field for everything). Used by <b>VisionMask</b> (e.g. tag "ground" so the vision cone doesn't fade it), read by <b>On Tile Destroyed / Damaged → Get Last Tile</b>, and matched by <b>Get Tagged Tile</b> so an NPC can target it (e.g. tag "bush" → a sheep walks to it). Type a tag like "bush" here.
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 3 }}>
                    <span style={{ fontSize: 9 }} title="What happens to this BigTile when any tile directly below one of its bottom-row cells is destroyed. 'destroy' removes the whole composite + cascades from its top edge.">On floor lost</span>
                    <select
                      value={String(bt.onBelowRemoved ?? "none")}
                      onChange={(e) => setBigTileOnBelowRemoved(tileset.id, bt.id, e.target.value as "destroy" | "drop" | "none")}
                      style={{ ...DROP_INPUT_STYLE, fontSize: 10 }}
                    >
                      <option value="none">Do nothing</option>
                      <option value="destroy">Destroy (removes composite + cascade)</option>
                      <option value="drop">Drop down (falls back to destroy)</option>
                    </select>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 3 }}>
                    <span style={{ fontSize: 9 }}>Exclude tags</span>
                    <TagChips
                      tags={bt.excludedTags ?? []}
                      onChange={(next) => setBigTileExcludedTags(tileset.id, bt.id, next)}
                      placeholder="ghost, projectile…"
                    />
                    <span style={{ fontSize: 8, color: "var(--text-dim)", lineHeight: 1.35 }}>
                      Sprites carrying any of these tags pass <b>THROUGH</b> this tile's collider (e.g. "ghost", "projectile"). Only matters when the tile is solid. Stacks on the tileset-wide excluded tags.
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
                    <span style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>Mining</span>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 10 }} title="Hit-points for the WHOLE composite (one shared pool). 0 = unbreakable. Number or random(min, max).">Hardness</span>
                      <input
                        type="text"
                        value={String(bt.hardness ?? "")}
                        placeholder="e.g. 5 or random(2, 6)"
                        onChange={(e) => {
                          const s = e.target.value.trim();
                          if (s === "") patchBigTile(tileset.id, bt.id, { hardness: 0 });
                          else if (/^-?\d+(\.\d+)?$/.test(s)) patchBigTile(tileset.id, bt.id, { hardness: Math.max(0, Math.floor(Number(s))) });
                          else patchBigTile(tileset.id, bt.id, { hardness: s });
                        }}
                        style={{ ...DROP_INPUT_STYLE, fontSize: 10 }}
                      />
                      <span style={{ fontSize: 10 }} title="Seconds until a destroyed placement re-appears. 0 / blank = never. Number, random(min, max), or choose(a, b, …).">Grow back (s)</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input
                          type="text"
                          value={String(bt.growBack ?? "")}
                          placeholder="0 = never · 5 · random(3,8)"
                          onChange={(e) => {
                            const s = e.target.value.trim();
                            if (s === "" || s === "0") patchBigTile(tileset.id, bt.id, { growBack: 0 });
                            else if (/^-?\d+(\.\d+)?$/.test(s)) patchBigTile(tileset.id, bt.id, { growBack: Number(s) });
                            else patchBigTile(tileset.id, bt.id, { growBack: s });
                          }}
                          style={{ ...DROP_INPUT_STYLE, fontSize: 10, flex: 1 }}
                        />
                        <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", cursor: "pointer" }} title="Pop in (scale 0→1) when it regrows. Off = instant.">
                          <input type="checkbox" checked={bt.growBackPop !== false} onChange={(e) => patchBigTile(tileset.id, bt.id, { growBackPop: e.target.checked })} />pop
                        </label>
                      </div>
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-dim)", lineHeight: 1.4 }}>
                      Damage area = the collision / damage shape above. Mining only counts inside it; no shape = the whole footprint is mineable.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
                      <span title="Signal emitted on the miner + Main Sheets on every surviving hit. Listen with On Signal.">Signal on hit</span>
                      <input type="text" value={bt.signalOnHit ?? ""} placeholder="e.g. treeHit" onChange={(e) => patchBigTile(tileset.id, bt.id, { signalOnHit: e.target.value })} style={{ ...DROP_INPUT_STYLE, fontSize: 10 }} />
                      <span title="Signal emitted on the miner + Main Sheets when this tile is destroyed (HP 0). Listen with On Signal.">Signal on mine</span>
                      <input type="text" value={bt.signalOnMine ?? ""} placeholder="e.g. treeChopped" onChange={(e) => patchBigTile(tileset.id, bt.id, { signalOnMine: e.target.value })} style={{ ...DROP_INPUT_STYLE, fontSize: 10 }} />
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
                      <Toggle value={bt.destroyOnDepleted !== false} onChange={(v) => patchBigTile(tileset.id, bt.id, { destroyOnDepleted: v })} style={{ margin: 0 }} />
                      <span style={{ color: "var(--text-dim)" }}>Destroy when mined out</span>
                    </label>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 10 }} title="Scene layer where drops spawn. Empty = the tilemap's own layer.">Drop layer</span>
                      <input type="text" value={bt.dropLayer ?? ""} placeholder="blank = tilemap layer" onChange={(e) => patchBigTile(tileset.id, bt.id, { dropLayer: e.target.value })} style={{ ...DROP_INPUT_STYLE, fontSize: 10 }} />
                    </div>
                    <TileDropsGrid drops={(bt.drops ?? []) as TileDrop[]} onChange={(next) => patchBigTile(tileset.id, bt.id, { drops: next })} />
                  </div>
                </div>
              ))}
              </div>
            </div>
          )}
          </>)}
        </div>

        {/* ── Animated tiles (cycling frame composites) ──────────────── */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 11, color: "var(--text-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button
              onClick={() => toggleSection("animatedTiles")}
              style={{ width: 16, height: 16, padding: 0, lineHeight: 1, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
              title={expandedSections.has("animatedTiles") ? "Collapse section" : "Expand section"}
            >{expandedSections.has("animatedTiles") ? "▼" : "▶"}</button>
            <span
              style={{ fontWeight: 700, flex: 1, cursor: "pointer" }}
              onClick={() => toggleSection("animatedTiles")}
            >Animated tiles <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({(tileset.animatedTiles ?? []).length})</span></span>
            <button
              onClick={() => addAnimatedTile(tileset.id)}
              style={{ fontSize: 10, padding: "2px 7px", cursor: "pointer", background: "var(--inner)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 3 }}
              title="Create a new animated tile composed of cycling frames"
            >+ add</button>
          </div>
          {expandedSections.has("animatedTiles") && (<>
          {(tileset.animatedTiles ?? []).length === 0 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
              Cycling tiles (water, torches, conveyors). Add one, then click a frame slot and pick a tile from the palette.
            </span>
          )}
          {animFrameAssign && (() => {
            const at = (tileset.animatedTiles ?? []).find((a) => a.id === animFrameAssign.animatedTileId);
            if (!at) return null;
            const label = animFrameAssign.frameIdx >= at.frames.length
              ? `${at.name || "animated tile"} — add frame ${animFrameAssign.frameIdx + 1}`
              : `${at.name || "animated tile"} — replace frame ${animFrameAssign.frameIdx + 1}`;
            return (
              <div style={{
                marginTop: 6, padding: "5px 8px",
                background: "var(--yellow)", color: "var(--frame)",
                borderRadius: 3, fontSize: 10, fontWeight: 700,
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <span>Click a palette tile → {label}</span>
                <button
                  onClick={() => setAnimFrameAssign(null)}
                  style={{ marginLeft: "auto", padding: "1px 6px", fontSize: 10, cursor: "pointer", background: "transparent", border: "1px solid var(--frame)", borderRadius: 2, color: "var(--frame)" }}
                >Cancel</button>
              </div>
            );
          })()}
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            {(tileset.animatedTiles ?? []).map((at) => (
              <AnimatedTileEditor
                key={at.id}
                ts={tileset}
                at={at}
                assigning={animFrameAssign?.animatedTileId === at.id ? animFrameAssign.frameIdx : null}
                onRequestAssign={(frameIdx) =>
                  setAnimFrameAssign(
                    animFrameAssign?.animatedTileId === at.id && animFrameAssign.frameIdx === frameIdx
                      ? null
                      : { animatedTileId: at.id, frameIdx },
                  )
                }
                onRemoveFrame={(frameIdx) => {
                  const next = at.frames.slice();
                  next.splice(frameIdx, 1);
                  setAnimatedTileFrames(tileset.id, at.id, next);
                  if (animFrameAssign?.animatedTileId === at.id) setAnimFrameAssign(null);
                }}
                onPatch={(patch) => updateAnimatedTile(tileset.id, at.id, patch)}
                onSetDrops={(drops) => setAnimatedTileDrops(tileset.id, at.id, drops)}
                onRemove={() => {
                  removeAnimatedTile(tileset.id, at.id);
                  if (animFrameAssign?.animatedTileId === at.id) setAnimFrameAssign(null);
                }}
              />
            ))}
          </div>
          </>)}
        </div>
      </div>

      <SidebarResizeHandle width={sidebarWidth} onChange={setSidebarWidth} min={220} max={600} />

      {/* ── Sliced palette ─────────────────────────────────────────── */}
      <div style={{ flex: 1, padding: 16, overflow: "auto", background: "#0d0e12" }}>
        {!tileset.imageFile ? (
          <div style={{ color: "var(--text-dim)", padding: 24, fontStyle: "italic" }}>
            Import a spritesheet to start. Set tile size + spacing on the left; this pane will show the sliced grid.
          </div>
        ) : moveOpen ? (
          <TilesetPixelMover tileset={tileset} zoom={zoom} onClose={() => setMoveOpen(false)} />
        ) : (
          <>
            {/* Assign-mode banner — visible above the sheet when the terrain
                editor has put us in "click a tile to assign to slot X" mode.
                Without this, clicking the palette is ambiguous between toggle-
                solid and assign-to-slot. */}
            {assignTarget && (() => {
              const terrain = (tileset.terrains ?? []).find((t) => t.id === assignTarget.terrainId);
              if (!terrain) return null;
              const label = assignTarget.kind === "default"
                ? `${terrain.name} / default tile`
                : `${terrain.name} / rule`;
              return (
                <div style={{
                  position: "sticky", top: 0, zIndex: 5, marginBottom: 8,
                  padding: "6px 10px", background: "var(--yellow)", color: "var(--frame)",
                  display: "flex", alignItems: "center", gap: 10, fontSize: 11, fontWeight: 700,
                  borderRadius: 4, boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
                }}>
                  <span>Click a tile to assign → {label}</span>
                  <button
                    onClick={() => setAssignTarget(null)}
                    style={{ marginLeft: "auto", padding: "1px 7px", fontSize: 12, cursor: "pointer", background: "transparent", border: "1px solid var(--frame)", borderRadius: 3, color: "var(--frame)" }}
                  >Cancel</button>
                </div>
              );
            })()}
            {/* assignTarget banner above already covers its own intent; the
                next two banners are mutually exclusive with it so the
                top-of-pane area never stacks more than one banner. */}
            {!assignTarget && bigTileMode && (
              <div style={{
                position: "sticky", top: 0, zIndex: 5, marginBottom: 8,
                padding: "6px 10px", background: "var(--yellow)", color: "var(--frame)",
                display: "flex", alignItems: "center", gap: 10, fontSize: 11, fontWeight: 700,
                borderRadius: 4, boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
              }}>
                <span>
                  {bigTileSel && bigTileSel.size > 0
                    ? `Selected: ${bigTileSel.size} cell${bigTileSel.size === 1 ? "" : "s"} — Ctrl-drag adds, Ctrl-click toggles, then click Unite below.`
                    : `Drag a rectangle on the palette. Ctrl-click toggles single cells. Click 'Unite' to create a big tile.`}
                </span>
                <button
                  onClick={() => { setBigTileMode(false); setBigTileSel(null); }}
                  style={{ marginLeft: "auto", padding: "1px 7px", fontSize: 12, cursor: "pointer", background: "transparent", border: "1px solid var(--frame)", borderRadius: 3, color: "var(--frame)" }}
                >Cancel</button>
              </div>
            )}
            {!assignTarget && !bigTileMode && solidMode && (
              <div style={{
                position: "sticky", top: 0, zIndex: 5, marginBottom: 8,
                padding: "6px 10px", background: "var(--yellow)", color: "var(--frame)",
                display: "flex", alignItems: "center", gap: 10, fontSize: 11, fontWeight: 700,
                borderRadius: 4, boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
              }}>
                <span>Click tiles to mark/unmark solid.</span>
                <button
                  onClick={() => setSolidMode(false)}
                  style={{ marginLeft: "auto", padding: "1px 7px", fontSize: 12, cursor: "pointer", background: "transparent", border: "1px solid var(--frame)", borderRadius: 3, color: "var(--frame)" }}
                >Cancel</button>
              </div>
            )}
            <TilePalette
              image={tilesetUrl ?? ""}
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
              zoom={zoom}
              solidSet={solidSet}
              tileColliders={tileset.tileColliders ?? {}}
              bigTileMode={bigTileMode}
              bigTileSel={bigTileSel}
              onBigTileSelChange={setBigTileSel}
              bigTiles={tileset.bigTiles ?? []}
              collideEditBigTileId={damageEditBigTileId}
              onCollideEditChange={(btId, rect) => patchBigTile(tileset.id, btId, { damageRect: rect })}
              assignRegionMode={!!animFrameAssign}
              onPickRegion={(c, r, w, h) => {
                if (!animFrameAssign) return;
                const at = (tileset.animatedTiles ?? []).find((a) => a.id === animFrameAssign.animatedTileId);
                if (at) {
                  // 1×1 stays a bare index (legacy form); larger = region.
                  const frame: AnimFrame = w === 1 && h === 1 ? r * tileset.cols + c : { c, r, w, h };
                  const next = at.frames.slice();
                  if (animFrameAssign.frameIdx >= next.length) next.push(frame);
                  else next[animFrameAssign.frameIdx] = frame;
                  setAnimatedTileFrames(tileset.id, at.id, next);
                }
                setAnimFrameAssign(null);
              }}
              highlightTile={(() => {
                if (assignTarget) {
                  const tr = (tileset.terrains ?? []).find((t) => t.id === assignTarget.terrainId);
                  if (!tr) return undefined;
                  if (assignTarget.kind === "default") return tr.defaultTile >= 0 ? tr.defaultTile : undefined;
                  const rule = tr.rules.find((r) => r.id === assignTarget.ruleId);
                  return rule && rule.tile >= 0 ? rule.tile : undefined;
                }
                return selectedSolidTile ?? undefined;
              })()}
              highlightTiles={selectedTiles}
              onToggleSolid={(idx, additive) => {
                // Assign mode wins — banner above the palette signals the intent.
                if (assignTarget) {
                  if (assignTarget.kind === "default") {
                    updateTerrain(tileset.id, assignTarget.terrainId, { defaultTile: idx });
                  } else {
                    updateTerrainRule(tileset.id, assignTarget.terrainId, assignTarget.ruleId, { tile: idx });
                  }
                  setAssignTarget(null);
                  return;
                }
                // Animated-tile frame-slot assign — same UX as terrain assign,
                // but writes into the named (animatedTileId, frameIdx) slot.
                if (animFrameAssign) {
                  const at = (tileset.animatedTiles ?? []).find((a) => a.id === animFrameAssign.animatedTileId);
                  if (at) {
                    const next = at.frames.slice();
                    if (animFrameAssign.frameIdx >= next.length) next.push(idx);
                    else next[animFrameAssign.frameIdx] = idx;
                    setAnimatedTileFrames(tileset.id, at.id, next);
                  }
                  setAnimFrameAssign(null);
                  return;
                }
                // Solid-mode ARMED: toggle the tile's solid flag.
                if (solidMode) {
                  toggleTileSolid(tileset.id, idx);
                  return;
                }
                // Default click: select the tile so its properties open.
                // Ctrl/Cmd-click adds/removes from the multi-select so the
                // editor's edits fan out to every selected tile.
                setSelectedSolidTile(idx);
                setSelectedTiles((prev) => {
                  if (!additive) return new Set([idx]);
                  const next = new Set(prev);
                  if (next.has(idx)) next.delete(idx); else next.add(idx);
                  return next;
                });
              }}
            />
            {selectedSolidTile !== null && (() => {
              const anchor = selectedSolidTile;
              if (anchor === null) return null;
              // Every selected tile receives the edit (anchor's values display).
              const targets = selectedTiles.size > 0 ? [...selectedTiles] : [anchor];
              return (
                <>
                  {targets.length > 1 && (
                    <div style={{ fontSize: 10, color: "var(--yellow)", margin: "6px 0 2px" }}>
                      {targets.length} tiles selected — edits apply to all. Ctrl/Cmd-click tiles to add or remove.
                    </div>
                  )}
                  {solidSet.has(anchor) && targets.length === 1 && (
                    <TileColliderEditor
                      tile={anchor}
                      tileset={tileset}
                      onChange={(rect) => setTileCollider(tileset.id, anchor, rect)}
                      onClose={() => { setSelectedSolidTile(null); setSelectedTiles(new Set()); }}
                      clipboard={colliderClipboard}
                      onCopy={setColliderClipboard}
                    />
                  )}
                  <TileMiningEditor
                    tile={anchor}
                    solid={solidSet.has(anchor)}
                    onSolidChange={() => {
                      const target = !solidSet.has(anchor);
                      targets.forEach((t) => { if (solidSet.has(t) !== target) toggleTileSolid(tileset.id, t); });
                    }}
                    hardness={tileset.tileHardness?.[String(anchor)] ?? 0}
                    growBack={tileset.tileGrowBack?.[String(anchor)] ?? ""}
                    growBackPop={tileset.tileGrowBackPop?.[String(anchor)] !== false}
                    drops={tileset.tileDrops?.[String(anchor)] ?? []}
                    dropLayer={tileset.tileDropLayer?.[String(anchor)] ?? ""}
                    onBelowRemoved={tileset.tileOnBelowRemoved?.[String(anchor)] ?? "none"}
                    excludedTags={tileset.tileExcludedTags?.[String(anchor)] ?? []}
                    onChange={(h, d) => targets.forEach((t) => setTileMining(tileset.id, t, h, d))}
                    onDropLayerChange={(name) => targets.forEach((t) => setTileDropLayer(tileset.id, t, name))}
                    onGrowBackChange={(v) => targets.forEach((t) => setTileGrowBack(tileset.id, t, v))}
                    onGrowBackPopChange={(v) => targets.forEach((t) => setTileGrowBackPop(tileset.id, t, v))}
                    onBelowRemovedChange={(v) => targets.forEach((t) => setTileOnBelowRemoved(tileset.id, t, v))}
                    onExcludedTagsChange={(tags) => targets.forEach((t) => setTileExcludedTags(tileset.id, t, tags))}
                  />
                </>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

/** Visual polygon editor for a tile's custom collision shape.
 *  - Tile preview + polygon overlay (filled yellow + outline)
 *  - Drag any point to move it (clamped to the tile cell)
 *  - Double-click on a polygon EDGE to insert a new point on that edge
 *  - Double-click on empty space to append a new point at that position
 *  - Right-click a point to delete it (min 3 points enforced)
 *  - Reset button → 4-corner rectangle (default full cell)
 *  Coords are stored as integer pixels within the tile's cell. */
/** Generic polygon editor over a `tw × th` pixel box. Used for both a single
 *  tile's collider and a whole BigTile's collider (where the box is the
 *  footprint). The caller supplies the current `points`, the backdrop image,
 *  and the persistence via `onChange`. */
function PolygonColliderEditor({
  tw, th, points, onChange, onClose, clipboard, onCopy, label, renderBg,
}: {
  tw: number; th: number;
  points: { x: number; y: number }[];
  onChange: (polygon: { points: { x: number; y: number }[] } | null) => void;
  onClose: () => void;
  /** Shared "copied" polygon — lets the author stamp one shape onto many cells. */
  clipboard: { points: { x: number; y: number }[] } | null;
  onCopy: (poly: { points: { x: number; y: number }[] }) => void;
  label: string;
  renderBg: (w: number, h: number) => React.ReactNode;
}) {
  // Keep points apart so a shape can never collapse to a zero-width line (which
  // decomposes to NO collision rects). Scales a little with cell size.
  const MIN_DIST = Math.max(3, Math.round(Math.min(tw, th) / 12));
  /** Push p away from any other point closer than MIN_DIST, then clamp to cell. */
  const enforceMinDist = (p: { x: number; y: number }, i: number, pts: { x: number; y: number }[]) => {
    let { x, y } = p;
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue;
      const dx = x - pts[j].x, dy = y - pts[j].y;
      const d = Math.hypot(dx, dy);
      if (d < MIN_DIST) {
        if (d < 0.001) { x = pts[j].x + MIN_DIST; y = pts[j].y; }
        else { x = pts[j].x + (dx / d) * MIN_DIST; y = pts[j].y + (dy / d) * MIN_DIST; }
      }
    }
    return { x: Math.round(Math.max(0, Math.min(tw, x))), y: Math.round(Math.max(0, Math.min(th, y))) };
  };
  const PREVIEW = 160; // larger so dragging single pixels is feasible
  const scale = PREVIEW / Math.max(tw, th);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  // Convert pointer event coords → tile-pixel coords, clamped to cell bounds.
  const toTilePx = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const px = Math.round((clientX - r.left) / scale);
    const py = Math.round((clientY - r.top) / scale);
    return {
      x: Math.max(0, Math.min(tw, px)),
      y: Math.max(0, Math.min(th, py)),
    };
  };

  const commitPoints = (next: { x: number; y: number }[]) => {
    onChange({ points: next });
  };

  const onPointMouseDown = (e: React.MouseEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    setDragging(i);
    const move = (ev: MouseEvent) => {
      const p = toTilePx(ev.clientX, ev.clientY);
      if (!p) return;
      const next = points.slice();
      next[i] = enforceMinDist(p, i, points);
      commitPoints(next);
    };
    const up = () => {
      setDragging(null);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  /** Right-click → delete. Browsers gate this through contextmenu, which
   *  fires AFTER mousedown and reliably skips drag entry. */
  const onPointContextMenu = (e: React.MouseEvent, i: number) => {
    e.preventDefault(); e.stopPropagation();
    if (points.length <= 3) return;
    commitPoints(points.filter((_, idx) => idx !== i));
  };

  // Squared distance from point P to segment AB. Used to find the nearest
  // edge for "insert point on edge" on double-click.
  const distSqToSegment = (P: {x:number;y:number}, A: {x:number;y:number}, B: {x:number;y:number}): { d2: number; t: number } => {
    const ax = B.x - A.x, ay = B.y - A.y;
    const px = P.x - A.x, py = P.y - A.y;
    const len2 = ax*ax + ay*ay;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px*ax + py*ay) / len2)) : 0;
    const cx = A.x + ax*t, cy = A.y + ay*t;
    const dx = P.x - cx, dy = P.y - cy;
    return { d2: dx*dx + dy*dy, t };
  };

  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const p = toTilePx(e.clientX, e.clientY);
    if (!p) return;
    // Find the nearest polygon edge; if it's within ~6 tile-px we insert on
    // that edge. Otherwise append a new point at the click position.
    let bestIdx = -1, bestD2 = Infinity;
    for (let i = 0; i < points.length; i++) {
      const A = points[i], B = points[(i + 1) % points.length];
      const { d2 } = distSqToSegment(p, A, B);
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    const next = points.slice();
    if (bestIdx >= 0 && bestD2 <= 36) {
      // Insert after bestIdx → splits that edge with the new point.
      next.splice(bestIdx + 1, 0, p);
    } else {
      next.push(p);
    }
    commitPoints(next);
  };

  /** Shift the whole shape flush against one cell edge (bbox snap). */
  const alignShape = (dir: "left" | "right" | "top" | "bottom") => {
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    let dx = 0, dy = 0;
    if (dir === "left") dx = -minX;
    else if (dir === "right") dx = tw - maxX;
    else if (dir === "top") dy = -minY;
    else if (dir === "bottom") dy = th - maxY;
    commitPoints(points.map((p) => ({ x: p.x + dx, y: p.y + dy })));
  };

  /** Mirror the shape across the cell's center, horizontally or vertically. */
  const flipShape = (axis: "h" | "v") => {
    commitPoints(points.map((p) => (axis === "h" ? { x: tw - p.x, y: p.y } : { x: p.x, y: th - p.y })));
  };

  // Build SVG polygon points string in screen-px.
  const polyStr = points.map((p) => `${p.x * scale},${p.y * scale}`).join(" ");
  const W = tw * scale;
  const H = th * scale;

  return (
    <div style={{
      marginTop: 10, padding: 10,
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: 4,
      display: "flex", gap: 12, alignItems: "flex-start",
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={LBL}>{label}</span>
        <div
          ref={canvasRef}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
          style={{
            position: "relative",
            width: W, height: H,
            border: "1px solid var(--border)",
            background: "var(--inner)",
            cursor: "crosshair",
            userSelect: "none",
          }}
        >
          {renderBg(W, H)}
          <svg
            width={W} height={H}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <polygon
              points={polyStr}
              fill="rgba(255,210,60,0.25)"
              stroke="rgba(255,210,60,0.95)"
              strokeWidth={2}
            />
          </svg>
          {points.map((p, i) => {
            const sx2 = p.x * scale, sy2 = p.y * scale;
            return (
              <div
                key={i}
                onMouseDown={(e) => onPointMouseDown(e, i)}
                onContextMenu={(e) => onPointContextMenu(e, i)}
                title={`Point ${i} (${p.x}, ${p.y}) — drag to move · right-click to delete`}
                style={{
                  position: "absolute",
                  left: sx2 - 6, top: sy2 - 6,
                  width: 14, height: 14,
                  borderRadius: "50%",
                  background: dragging === i ? "var(--yellow)" : "rgba(255,210,60,0.85)",
                  border: "2px solid rgba(0,0,0,0.85)",
                  cursor: "grab",
                  boxSizing: "border-box",
                }}
              />
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{ fontSize: 10, color: "var(--text-2)", lineHeight: 1.4 }}>
          <div><b>Drag</b> a point to move it.</div>
          <div><b>Double-click</b> on a polygon edge to add a point on that edge.</div>
          <div><b>Double-click</b> away from edges to append a new point.</div>
          <div><b>Right-click</b> a point to delete it (min 3).</div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Align</span>
          <button onClick={() => alignShape("left")}   title="Snap shape to the left edge"   style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>⊣ L</button>
          <button onClick={() => alignShape("right")}  title="Snap shape to the right edge"  style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>R ⊢</button>
          <button onClick={() => alignShape("top")}    title="Snap shape to the top edge"    style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>⊤ T</button>
          <button onClick={() => alignShape("bottom")} title="Snap shape to the bottom edge" style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>B ⊥</button>
          <button onClick={() => flipShape("h")} title="Flip shape horizontally" style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>⇄ H</button>
          <button onClick={() => flipShape("v")} title="Flip shape vertically" style={{ ...BTN, padding: "3px 7px", fontSize: 11 }}>⇅ V</button>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            onClick={() => onCopy({ points: points.map((p) => ({ ...p })) })}
            title="Copy this collision shape — then open another solid tile and Paste it"
            style={{ ...BTN, padding: "3px 8px", fontSize: 11 }}
          >⧉ Copy shape</button>
          <button
            onClick={() => clipboard && commitPoints(clipboard.points.map((p) => ({ x: Math.max(0, Math.min(tw, p.x)), y: Math.max(0, Math.min(th, p.y)) })))}
            disabled={!clipboard}
            title={clipboard ? "Paste the copied shape onto this tile" : "Nothing copied yet"}
            style={{ ...BTN, padding: "3px 8px", fontSize: 11, opacity: clipboard ? 1 : 0.5, cursor: clipboard ? "pointer" : "default" }}
          >⤓ Paste shape</button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => commitPoints([
              { x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th },
            ])}
            title="Reset to full-cell rectangle"
            style={{ ...BTN, padding: "3px 8px", fontSize: 11 }}
          >Reset shape</button>
          <button
            onClick={() => onChange(null)}
            title="Clear custom collider → tile uses Phaser's efficient layer-collision path"
            style={{ ...BTN, padding: "3px 8px", fontSize: 11 }}
          >Clear</button>
          <button
            onClick={onClose}
            style={{ ...BTN, padding: "3px 8px", fontSize: 11 }}
          >Close</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.3 }}>
          Polygon is decomposed into axis-aligned rectangles at load time
          (arcade physics doesn't support polygon bodies directly). Simple
          shapes → 1-2 rect bodies per cell. {points.length} points.
        </div>
      </div>
    </div>
  );
}

/** Single-tile collision polygon editor — backdrop is the tile's own image. */
function TileColliderEditor({
  tile, tileset, onChange, onClose, clipboard, onCopy,
}: {
  tile: number;
  tileset: TilesetAsset;
  onChange: (polygon: { points: { x: number; y: number }[] } | null) => void;
  onClose: () => void;
  clipboard: { points: { x: number; y: number }[] } | null;
  onCopy: (poly: { points: { x: number; y: number }[] }) => void;
}) {
  const tw = tileset.tileW, th = tileset.tileH;
  const points = tileset.tileColliders?.[String(tile)]?.points ?? [
    { x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th },
  ];
  return (
    <PolygonColliderEditor
      tw={tw} th={th} points={points}
      onChange={onChange} onClose={onClose} clipboard={clipboard} onCopy={onCopy}
      label={`Tile ${tile} · collision polygon`}
      renderBg={(w, h) => <TilePreviewBg tile={tile} tileset={tileset} size={Math.max(w, h)} fill />}
    />
  );
}

/** Whole-BigTile collision polygon editor — one shape over the footprint
 *  (treated as a single oversized cell), backed by the composite image. */
function BigTileColliderEditor({
  tileset, bt, onChange, onClose, clipboard, onCopy,
}: {
  tileset: TilesetAsset;
  bt: { id: string; c: number; r: number; w: number; h: number; cells?: { c: number; r: number }[]; collidePoly?: { points: { x: number; y: number }[] } };
  onChange: (polygon: { points: { x: number; y: number }[] } | null) => void;
  onClose: () => void;
  clipboard: { points: { x: number; y: number }[] } | null;
  onCopy: (poly: { points: { x: number; y: number }[] }) => void;
}) {
  const tw = bt.w * tileset.tileW, th = bt.h * tileset.tileH;
  const points = bt.collidePoly?.points ?? [
    { x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th },
  ];
  return (
    <PolygonColliderEditor
      tw={tw} th={th} points={points}
      onChange={onChange} onClose={onClose} clipboard={clipboard} onCopy={onCopy}
      label="Big tile · collision polygon"
      renderBg={(w, h) => (
        <div style={{ position: "absolute", inset: 0 }}>
          <BigTilePreview ts={tileset} bt={bt} maxPx={Math.max(w, h)} fill />
        </div>
      )}
    />
  );
}

// ─── shared bits ────────────────────────────────────────────────────────────

const LBL: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" };
const INP: React.CSSProperties = { fontSize: 12, padding: "2px 6px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" };
const BTN: React.CSSProperties = { fontSize: 11, cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)" };

function NumField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (n: number) => void }) {
  // Buffer the input locally so intermediate keystrokes don't reslice
  // mid-type (which would drop solids and confuse the user). Commit on
  // blur OR Enter; Escape reverts.
  const [local, setLocal] = useState(String(value));
  const focused = useRef(false);
  // Don't clobber in-progress typing: only re-sync from the prop while the
  // field is NOT focused (an external value change mid-type would otherwise
  // wipe the user's keystrokes).
  useEffect(() => { if (!focused.current) setLocal(String(value)); }, [value]);
  const commit = () => {
    const n = Math.floor(Number(local));
    if (!Number.isFinite(n)) { setLocal(String(value)); return; }
    const next = Math.max(min, n);
    // Equality guard: a no-op blur (open + click away) must not mint an undo
    // step or reslice the sheet (which drops the solid set).
    if (next === value) { setLocal(String(value)); return; }
    onChange(next);
  };
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={LBL}>{label}</span>
      <input
        type="number"
        min={min}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") { setLocal(String(value)); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        style={{ ...INP, fontSize: 11 }}
      />
    </label>
  );
}

/** Canvas-based sheet preview with click-to-toggle per-tile solid flag.
 *  One <canvas> paints the sheet + grid + red-tint solid overlay — replaces
 *  the per-cell <div> approach that froze on big sheets (1000+ tiles =
 *  1000+ DOM nodes). Click→cell math uses the same offset+spacing the
 *  runtime uses, so what you mark here is what blocks in-game. */
function TilePalette({
  image, sheetW, sheetH, cols, rows, tileW, tileH, offsetX, offsetY, spacingX, spacingY,
  zoom, solidSet, tileColliders, onToggleSolid, highlightTile, highlightTiles,
  bigTileMode, bigTileSel, onBigTileSelChange, bigTiles,
  collideEditBigTileId, onCollideEditChange,
  assignRegionMode, onPickRegion,
}: {
  image: string; sheetW: number; sheetH: number;
  cols: number; rows: number;
  tileW: number; tileH: number;
  offsetX: number; offsetY: number; spacingX: number; spacingY: number;
  zoom: number;
  solidSet: Set<number>;
  tileColliders: Record<string, { points: { x: number; y: number }[] }>;
  onToggleSolid: (tileIndex: number, additive?: boolean) => void;
  highlightTile?: number;
  /** All multi-selected tiles (outlined together). The anchor is highlightTile. */
  highlightTiles?: Set<number>;
  bigTileMode?: boolean;
  /** Set of `"c,r"` keys for cells currently selected in BigTile creation. */
  bigTileSel?: Set<string> | null;
  onBigTileSelChange?: (sel: Set<string> | null) => void;
  bigTiles?: { id: string; c: number; r: number; w: number; h: number; pivotX?: number; pivotY?: number; sortY?: number; sortLineY?: number; collide?: { cx: number; cy: number; cw: number; ch: number }; damageRect?: { cx: number; cy: number; cw: number; ch: number } }[];
  collideEditBigTileId?: string | null;
  onCollideEditChange?: (bigTileId: string, rect: { cx: number; cy: number; cw: number; ch: number }) => void;
  /** Animated-frame assignment: drag a rect → multi-cell region; a plain click
   *  inside a BigTile snaps to that BigTile's footprint; else a single cell. */
  assignRegionMode?: boolean;
  onPickRegion?: (c: number, r: number, w: number, h: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgTick, setImgTick] = useState(0);
  // Live rect while drag-selecting a multi-cell animation frame.
  const [assignRect, setAssignRect] = useState<{ c: number; r: number; w: number; h: number } | null>(null);

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
    // Size the canvas to cover BOTH the image AND the grid — so extending the
    // grid past the image (extra rows/cols) actually shows the new cells
    // instead of clipping them at the image edge.
    const gridW = offsetX + cols * (tileW + spacingX) - (cols > 0 ? spacingX : 0);
    const gridH = offsetY + rows * (tileH + spacingY) - (rows > 0 ? spacingY : 0);
    const imgW = Math.round(sheetW * zoom);
    const imgH = Math.round(sheetH * zoom);
    const W = Math.max(1, Math.round(Math.max(sheetW, gridW) * zoom));
    const H = Math.max(1, Math.round(Math.max(sheetH, gridH) * zoom));
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    // Faint backing on the extended (beyond-image) area so the extra empty
    // cells are visible against the dark editor.
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, W, H);
    const img = imgRef.current;
    // Draw at NATURAL size (not stretched to the extended canvas).
    if (img && img.complete) ctx.drawImage(img, 0, 0, imgW, imgH);
    // Solid-tile overlay. Tiles WITH a custom polygon render their polygon
    // shape so the author sees the actual collision area at a glance instead
    // of a generic red square. Tiles WITHOUT a custom polygon get the full-cell
    // red rect (default = full cell blocks).
    if (solidSet.size > 0) {
      ctx.fillStyle = "rgba(255,80,80,0.28)";
      ctx.strokeStyle = "rgba(255,80,80,0.95)";
      ctx.lineWidth = 1;
      for (const idx of solidSet) {
        const c = idx % cols;
        const r = (idx - c) / cols;
        const x0 = (offsetX + c * (tileW + spacingX)) * zoom;
        const y0 = (offsetY + r * (tileH + spacingY)) * zoom;
        const poly = tileColliders[String(idx)];
        if (poly && poly.points.length >= 3) {
          ctx.beginPath();
          for (let i = 0; i < poly.points.length; i++) {
            const p = poly.points[i];
            const px = x0 + p.x * zoom;
            const py = y0 + p.y * zoom;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const w = tileW * zoom;
          const h = tileH * zoom;
          ctx.fillRect(x0, y0, w, h);
          ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
        }
      }
    }
    // Light grid overlay so cell boundaries are visible even on flat tiles.
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = Math.round((offsetX + c * (tileW + spacingX)) * zoom) + 0.5;
      ctx.moveTo(x, offsetY * zoom);
      ctx.lineTo(x, (offsetY + rows * (tileH + spacingY) - spacingY) * zoom);
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round((offsetY + r * (tileH + spacingY)) * zoom) + 0.5;
      ctx.moveTo(offsetX * zoom, y);
      ctx.lineTo((offsetX + cols * (tileW + spacingX) - spacingX) * zoom, y);
    }
    ctx.stroke();
    // Yellow ring on the tile currently assigned to the slot the user is
    // editing (or -1 = none). Lets the user see which slot has what without
    // hunting through the slot grid sidebar.
    // Multi-select: a fainter fill on every selected tile; the anchor below
    // gets the bright outline.
    if (highlightTiles && highlightTiles.size > 1 && cols > 0) {
      ctx.fillStyle = "rgba(255,210,60,0.22)";
      for (const idx of highlightTiles) {
        if (idx < 0) continue;
        const c = idx % cols, r = (idx - c) / cols;
        ctx.fillRect((offsetX + c * (tileW + spacingX)) * zoom, (offsetY + r * (tileH + spacingY)) * zoom, tileW * zoom, tileH * zoom);
      }
    }
    if (typeof highlightTile === "number" && highlightTile >= 0 && cols > 0) {
      const c = highlightTile % cols;
      const r = (highlightTile - c) / cols;
      const x = (offsetX + c * (tileW + spacingX)) * zoom;
      const y = (offsetY + r * (tileH + spacingY)) * zoom;
      const w = tileW * zoom;
      const h = tileH * zoom;
      ctx.strokeStyle = "rgba(255,210,60,0.95)";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    }
    // Existing BigTiles — outline each one in green, plus a red pivot cross
    // at the pivot cell center and a cyan dashed line at the sort-Y flip.
    if (bigTiles && bigTiles.length > 0) {
      for (const bt of bigTiles) {
        const x = (offsetX + bt.c * (tileW + spacingX)) * zoom;
        const y = (offsetY + bt.r * (tileH + spacingY)) * zoom;
        const w = (bt.w * (tileW + spacingX) - spacingX) * zoom;
        const h = (bt.h * (tileH + spacingY) - spacingY) * zoom;
        ctx.fillStyle = "rgba(120,210,120,0.12)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "rgba(120,210,120,0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        // Mineable damage area (orange) — the sub-region where Mine hits land.
        if (bt.damageRect) {
          const dx = (offsetX + (bt.c + bt.damageRect.cx) * (tileW + spacingX)) * zoom;
          const dy = (offsetY + (bt.r + bt.damageRect.cy) * (tileH + spacingY)) * zoom;
          const dw = (bt.damageRect.cw * (tileW + spacingX) - spacingX) * zoom;
          const dh = (bt.damageRect.ch * (tileH + spacingY) - spacingY) * zoom;
          ctx.fillStyle = "rgba(255,140,60,0.32)";
          ctx.fillRect(dx, dy, dw, dh);
          ctx.strokeStyle = "rgba(255,140,60,0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);
        }
        // Pivot crosshair at the PIVOT CELL — the exact cell that lands under the
        // cursor on click. Uses the SAME formula as placement (col - min(n-1,
        // floor(p*n))) so the marker predicts placement exactly: px/py 0 → first
        // cell, 0.5 → middle cell, 1 → last cell. (Cell-grid placement can't land
        // a sub-cell edge, so the marker tracks the cell, not a bounding-box edge.)
        const px = (bt.pivotX ?? 0.5);
        const py = (bt.pivotY ?? 1);
        const pivotCellC = bt.c + Math.min(bt.w - 1, Math.floor(px * bt.w));
        const pivotCellR = bt.r + Math.min(bt.h - 1, Math.floor(py * bt.h));
        const pcx = (offsetX + pivotCellC * (tileW + spacingX) + tileW / 2) * zoom;
        const pcy = (offsetY + pivotCellR * (tileH + spacingY) + tileH / 2) * zoom;
        ctx.strokeStyle = "rgba(255,80,80,1)";
        ctx.fillStyle = "rgba(255,80,80,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(pcx - 7, pcy); ctx.lineTo(pcx + 7, pcy);
        ctx.moveTo(pcx, pcy - 7); ctx.lineTo(pcx, pcy + 7);
        ctx.stroke();
        // Sort-Y line at the author-set fraction — matches the runtime's Y-sort
        // point (hPx × sortLineY). Only draw in Y-sort mode (sortY=0.5); at 0
        // the tree always wins depth, at 1 it always loses, so the line is moot.
        const userSortY = bt.sortY ?? 0.5;
        if (userSortY === 0.5) {
          const sortLineY = y + h * (bt.sortLineY ?? 0.5);
          ctx.strokeStyle = "rgba(60,200,255,0.95)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(x, sortLineY); ctx.lineTo(x + w, sortLineY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // Collision rect overlay — red translucent fill on the cells that
        // block movement (if any).
        if (bt.collide) {
          const ccx = (offsetX + (bt.c + bt.collide.cx) * (tileW + spacingX)) * zoom;
          const ccy = (offsetY + (bt.r + bt.collide.cy) * (tileH + spacingY)) * zoom;
          const ccw = (bt.collide.cw * (tileW + spacingX) - spacingX) * zoom;
          const cch = (bt.collide.ch * (tileH + spacingY) - spacingY) * zoom;
          ctx.fillStyle = "rgba(255,80,80,0.35)";
          ctx.fillRect(ccx, ccy, ccw, cch);
          ctx.strokeStyle = "rgba(255,80,80,0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(ccx + 1, ccy + 1, ccw - 2, cch - 2);
        }
      }
    }
    // Live animation-frame drag rect (multi-cell region pick).
    if (assignRect) {
      const x = (offsetX + assignRect.c * (tileW + spacingX)) * zoom;
      const y = (offsetY + assignRect.r * (tileH + spacingY)) * zoom;
      const w = (assignRect.w * (tileW + spacingX) - spacingX) * zoom;
      const h = (assignRect.h * (tileH + spacingY) - spacingY) * zoom;
      ctx.fillStyle = "rgba(255,210,60,0.22)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,210,60,0.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
    // Live BigTile cell-mask selection — paint a translucent highlight per
    // selected cell so T / L / cross shapes are visible during creation.
    if (bigTileSel && bigTileSel.size > 0) {
      ctx.fillStyle = "rgba(60,200,255,0.25)";
      ctx.strokeStyle = "rgba(60,200,255,0.95)";
      ctx.lineWidth = 2;
      const cellW = tileW * zoom;
      const cellH = tileH * zoom;
      for (const key of bigTileSel) {
        const [cs, rs] = key.split(",");
        const c = Number(cs), r = Number(rs);
        const x = (offsetX + c * (tileW + spacingX)) * zoom;
        const y = (offsetY + r * (tileH + spacingY)) * zoom;
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2);
      }
    }
  }, [imgTick, sheetW, sheetH, cols, rows, tileW, tileH, offsetX, offsetY, spacingX, spacingY, zoom, solidSet, tileColliders, highlightTile, highlightTiles, bigTiles, bigTileSel, assignRect]);

  const pickCell = (clientX: number, clientY: number): { c: number; r: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / zoom;
    const y = (clientY - rect.top) / zoom;
    const c = Math.floor((x - offsetX) / (tileW + spacingX));
    const r = Math.floor((y - offsetY) / (tileH + spacingY));
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
    return { c, r };
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const p = pickCell(e.clientX, e.clientY);
    if (!p) return;
    // Animation-frame region pick: drag a rectangle (multi-cell), or click —
    // a click inside an existing BigTile snaps to that BigTile's footprint,
    // otherwise it's a single 1×1 cell.
    if (assignRegionMode && onPickRegion) {
      e.preventDefault();
      const start = p;
      const onMove = (ev: MouseEvent) => {
        const q = pickCell(ev.clientX, ev.clientY) ?? start;
        setAssignRect({
          c: Math.min(start.c, q.c), r: Math.min(start.r, q.r),
          w: Math.abs(q.c - start.c) + 1, h: Math.abs(q.r - start.r) + 1,
        });
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setAssignRect(null);
        const q = pickCell(ev.clientX, ev.clientY) ?? start;
        let c = Math.min(start.c, q.c), r = Math.min(start.r, q.r);
        let w = Math.abs(q.c - start.c) + 1, h = Math.abs(q.r - start.r) + 1;
        if (w === 1 && h === 1) {
          const hit = (bigTiles ?? []).find((bt) => c >= bt.c && c < bt.c + bt.w && r >= bt.r && r < bt.r + bt.h);
          if (hit) { c = hit.c; r = hit.r; w = hit.w; h = hit.h; }
        }
        onPickRegion(c, r, w, h);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      return;
    }
    if (bigTileMode && onBigTileSelChange) {
      // BigTile selection. Ctrl held → ADD/TOGGLE on top of existing selection
      // (drag a rect to extend the shape, or click one cell to flip it).
      // Without Ctrl → REPLACE selection with the drag rect.
      e.preventDefault();
      const additive = e.ctrlKey || e.metaKey;
      const baseSet = additive && bigTileSel ? new Set(bigTileSel) : new Set<string>();
      const startKey = `${p.c},${p.r}`;
      let moved = false;
      // Track which cells we've touched on this drag pass so we don't flip-
      // flop a cell when the mouse re-enters it.
      const touched = new Set<string>();
      const apply = (q: { c: number; r: number }, isStart: boolean) => {
        // For a Ctrl-CLICK without movement, defer toggling until mouseup so
        // a real toggle (single cell) vs a drag-start (cell becomes anchor)
        // is unambiguous. Drags overwrite the start cell's preview anyway.
        if (!moved && isStart) {
          touched.add(`${q.c},${q.r}`);
          return;
        }
        const cMin = Math.min(p.c, q.c);
        const cMax = Math.max(p.c, q.c);
        const rMin = Math.min(p.r, q.r);
        const rMax = Math.max(p.r, q.r);
        const next = new Set(baseSet);
        for (let cc = cMin; cc <= cMax; cc++) {
          for (let rr = rMin; rr <= rMax; rr++) {
            const key = `${cc},${rr}`;
            next.add(key);
            touched.add(key);
          }
        }
        onBigTileSelChange(next.size > 0 ? next : null);
      };
      apply(p, true);
      const move = (ev: MouseEvent) => {
        const q = pickCell(ev.clientX, ev.clientY);
        if (!q) return;
        moved = true;
        apply(q, false);
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        if (!moved) {
          // Pure click. Ctrl-click toggles the single cell; plain click
          // REPLACES selection with just that cell (consistent with
          // plain-drag REPLACES semantics).
          if (additive) {
            const next = new Set(baseSet);
            if (next.has(startKey)) next.delete(startKey);
            else next.add(startKey);
            onBigTileSelChange(next.size > 0 ? next : null);
          } else {
            onBigTileSelChange(new Set([startKey]));
          }
        }
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
      return;
    }
    // Collision drag-select for the currently-edited BigTile.
    if (collideEditBigTileId && onCollideEditChange && bigTiles) {
      const editingBt = bigTiles.find((b) => b.id === collideEditBigTileId);
      if (editingBt) {
        e.preventDefault();
        const clampToBt = (c: number, r: number) => ({
          c: Math.max(editingBt.c, Math.min(editingBt.c + editingBt.w - 1, c)),
          r: Math.max(editingBt.r, Math.min(editingBt.r + editingBt.h - 1, r)),
        });
        const start = clampToBt(p.c, p.r);
        const apply = (q: { c: number; r: number }) => {
          const cMin = Math.min(start.c, q.c) - editingBt.c;
          const cMax = Math.max(start.c, q.c) - editingBt.c;
          const rMin = Math.min(start.r, q.r) - editingBt.r;
          const rMax = Math.max(start.r, q.r) - editingBt.r;
          onCollideEditChange(editingBt.id, { cx: cMin, cy: rMin, cw: cMax - cMin + 1, ch: rMax - rMin + 1 });
        };
        apply(start);
        const move = (ev: MouseEvent) => {
          const q = pickCell(ev.clientX, ev.clientY);
          if (!q) return;
          apply(clampToBt(q.c, q.r));
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        return;
      }
    }
    // Normal click — toggle solid / select. Ctrl/Cmd = add to the multi-select.
    onToggleSolid(p.r * cols + p.c, e.ctrlKey || e.metaKey);
  };

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={onCanvasMouseDown}
      style={{ display: "block", cursor: bigTileMode ? "crosshair" : "pointer", imageRendering: "pixelated", userSelect: "none" }}
    />
  );
}

// ─── Terrains (Unity Rule Tile auto-tile) ─────────────────────────────────

type AssignTarget =
  | { kind: "default"; terrainId: string }
  | { kind: "rule"; terrainId: string; ruleId: string };

/** Sidebar section: list of terrains + per-terrain expandable card with a
 *  rule list. Each rule is "this tile + 8 neighbor constraints"; the painter
 *  picks the first rule that matches a cell's neighbors. */
function TerrainsPanel({
  tileset, assignTarget, setAssignTarget,
  onAdd, onRemove, onUpdate,
  onAddRule, onRemoveRule, onUpdateRule, onReorderRule,
}: {
  tileset: TilesetAsset;
  assignTarget: AssignTarget | null;
  setAssignTarget: (t: AssignTarget | null) => void;
  onAdd: () => void;
  onRemove: (terrainId: string) => void;
  onUpdate: (terrainId: string, patch: Partial<TerrainDef>) => void;
  onAddRule: (terrainId: string) => void;
  onRemoveRule: (terrainId: string, ruleId: string) => void;
  onUpdateRule: (terrainId: string, ruleId: string, patch: Partial<{ tile: number; neighbors: NeighborState[] }>) => void;
  onReorderRule: (terrainId: string, ruleId: string, dir: -1 | 1) => void;
}) {
  const terrains = tileset.terrains ?? [];
  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", lineHeight: 1.3, flex: 1 }}>
          Rules are tried top-down; the first match wins. No match → default tile.
        </span>
        <button
          onClick={onAdd}
          title="Add a new terrain"
          style={{ fontSize: 14, lineHeight: 1, padding: "0 6px", cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" }}
        >+</button>
      </div>
      {terrains.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }}>
          No terrains yet. Click + to add one.
        </div>
      ) : (
        terrains.map((t) => (
          <TerrainRow
            key={t.id}
            terrain={t}
            tileset={tileset}
            assignTarget={assignTarget}
            setAssignTarget={setAssignTarget}
            onRemove={() => onRemove(t.id)}
            onUpdate={(patch) => onUpdate(t.id, patch)}
            onAddRule={() => onAddRule(t.id)}
            onRemoveRule={(rid) => onRemoveRule(t.id, rid)}
            onUpdateRule={(rid, patch) => onUpdateRule(t.id, rid, patch)}
            onReorderRule={(rid, dir) => onReorderRule(t.id, rid, dir)}
          />
        ))
      )}
    </div>
  );
}

function TerrainRow({
  terrain, tileset, assignTarget, setAssignTarget,
  onRemove, onUpdate,
  onAddRule, onRemoveRule, onUpdateRule, onReorderRule,
}: {
  terrain: TerrainDef;
  tileset: TilesetAsset;
  assignTarget: AssignTarget | null;
  setAssignTarget: (t: AssignTarget | null) => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<TerrainDef>) => void;
  onAddRule: () => void;
  onRemoveRule: (ruleId: string) => void;
  onUpdateRule: (ruleId: string, patch: Partial<{ tile: number; neighbors: NeighborState[] }>) => void;
  onReorderRule: (ruleId: string, dir: -1 | 1) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isAssignDefault =
    assignTarget?.kind === "default" && assignTarget.terrainId === terrain.id;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 4px", background: "rgba(255,255,255,0.04)" }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ width: 16, height: 16, padding: 0, lineHeight: 1, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
        >{expanded ? "▼" : "▶"}</button>
        <input
          type="color"
          value={`#${(terrain.color & 0xffffff).toString(16).padStart(6, "0")}`}
          onChange={(e) => onUpdate({ color: parseInt(e.target.value.slice(1), 16) })}
          style={{ width: 18, height: 18, padding: 0, border: "1px solid var(--border)", background: "transparent", cursor: "pointer" }}
          title="Swatch color"
        />
        <input
          type="text"
          value={terrain.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          style={{ flex: 1, fontSize: 11, background: "transparent", border: "none", color: "var(--text)", outline: "none", padding: 0 }}
        />
        <button
          onClick={onRemove}
          title="Delete this terrain"
          style={{ fontSize: 10, padding: "1px 5px", color: "var(--orange)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer" }}
        >×</button>
      </div>
      {expanded && (
        <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Default tile</span>
            <button
              onClick={() => setAssignTarget(isAssignDefault ? null : { kind: "default", terrainId: terrain.id })}
              title="Click → click a tile in the palette. Used as fallback when no rule matches AND as the initial stamp before rules evaluate."
              style={{
                width: 32, height: 32, padding: 0, cursor: "pointer",
                background: "var(--inner)",
                border: `2px solid ${isAssignDefault ? "var(--yellow)" : "var(--border)"}`,
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              {terrain.defaultTile >= 0 && tileset.cols > 0
                ? <TilePreviewBg tile={terrain.defaultTile} tileset={tileset} size={28} fill />
                : null}
            </button>
            <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.3 }}>
              Drawn when no rule matches. Also the initial stamp before rules run.
            </span>
          </div>
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 2, paddingTop: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Rules ({terrain.rules.length}) · top match wins
            </span>
            <button
              onClick={onAddRule}
              title="Add a new rule (all neighbors start as wildcard)"
              style={{ fontSize: 10, padding: "1px 7px", cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" }}
            >+ Rule</button>
          </div>
          {terrain.rules.length === 0 && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
              No rules yet. Click <b>+ Rule</b> to add one.
            </div>
          )}
          {terrain.rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              tileset={tileset}
              isAssigning={assignTarget?.kind === "rule" && assignTarget.terrainId === terrain.id && assignTarget.ruleId === rule.id}
              canMoveUp={i > 0}
              canMoveDown={i < terrain.rules.length - 1}
              onPick={() => {
                const same = assignTarget?.kind === "rule" && assignTarget.terrainId === terrain.id && assignTarget.ruleId === rule.id;
                setAssignTarget(same ? null : { kind: "rule", terrainId: terrain.id, ruleId: rule.id });
              }}
              onCycleNeighbor={(idx) => {
                const cycle: NeighborState[] = ["any", "must", "mustNot"];
                const next = cycle[(cycle.indexOf(rule.neighbors[idx]) + 1) % cycle.length];
                const neighbors = [...rule.neighbors];
                neighbors[idx] = next;
                onUpdateRule(rule.id, { neighbors });
              }}
              onMoveUp={() => onReorderRule(rule.id, -1)}
              onMoveDown={() => onReorderRule(rule.id, +1)}
              onRemove={() => onRemoveRule(rule.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Single rule row: tile preview button + 3×3 neighbor grid + reorder/delete.
 *  Each non-center cell of the 3×3 cycles `any` → `must` → `mustNot` on click. */
function RuleRow({
  rule, tileset, isAssigning, canMoveUp, canMoveDown,
  onPick, onCycleNeighbor, onMoveUp, onMoveDown, onRemove,
}: {
  rule: TerrainRule;
  tileset: TilesetAsset;
  isAssigning: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPick: () => void;
  onCycleNeighbor: (idx: number) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const hasTile = rule.tile >= 0;
  return (
    <div style={{
      display: "flex", gap: 6, alignItems: "center",
      padding: 4,
      background: "rgba(255,255,255,0.025)",
      border: "1px solid var(--border)",
      borderRadius: 3,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <button
          onClick={onMoveUp} disabled={!canMoveUp}
          title="Higher priority"
          style={{ fontSize: 8, lineHeight: 1, padding: "0 3px", cursor: canMoveUp ? "pointer" : "default", background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: canMoveUp ? "var(--text-dim)" : "rgba(255,255,255,0.15)" }}
        >▲</button>
        <button
          onClick={onMoveDown} disabled={!canMoveDown}
          title="Lower priority"
          style={{ fontSize: 8, lineHeight: 1, padding: "0 3px", cursor: canMoveDown ? "pointer" : "default", background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: canMoveDown ? "var(--text-dim)" : "rgba(255,255,255,0.15)" }}
        >▼</button>
      </div>
      <button
        onClick={onPick}
        title="Click → click a tile in the palette to set this rule's tile"
        style={{
          width: 44, height: 44, padding: 0, cursor: "pointer",
          background: hasTile ? "transparent" : "rgba(0,0,0,0.35)",
          border: `2px solid ${isAssigning ? "var(--yellow)" : "var(--border)"}`,
          borderRadius: 3,
          overflow: "hidden",
          flexShrink: 0,
          position: "relative",
        }}
      >
        {hasTile && tileset.cols > 0
          ? <TilePreviewBg tile={rule.tile} tileset={tileset} size={40} fill />
          : <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "rgba(255,210,60,0.75)" }}>?</span>}
      </button>
      <NeighborGrid rule={rule} onCycle={onCycleNeighbor} />
      <button
        onClick={onRemove}
        title="Delete this rule"
        style={{ fontSize: 11, padding: "1px 6px", color: "var(--orange)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", marginLeft: "auto" }}
      >×</button>
    </div>
  );
}

/** 3×3 visual representation of a rule's neighbor constraints.
 *  Layout: NW N NE / W center E / SW S SE — mapped to rule.neighbors indexes
 *  [7][0][1] / [6][center][2] / [5][4][3]. */
const GRID_TO_NEIGHBOR_IDX: (number | null)[] = [7, 0, 1, 6, null, 2, 5, 4, 3];

function NeighborGrid({
  rule, onCycle,
}: {
  rule: TerrainRule;
  onCycle: (neighborIdx: number) => void;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, 18px)",
      gridTemplateRows: "repeat(3, 18px)",
      gap: 1,
    }}>
      {GRID_TO_NEIGHBOR_IDX.map((nIdx, i) => {
        if (nIdx === null) {
          // Center cell — non-interactive, always "this is me".
          return (
            <div key={i} style={{
              background: "var(--yellow)",
              border: "1px solid rgba(0,0,0,0.4)",
              boxSizing: "border-box",
            }} />
          );
        }
        const state = rule.neighbors[nIdx];
        const bg = state === "must" ? "rgba(120,210,120,0.9)"
                 : state === "mustNot" ? "rgba(220,80,80,0.9)"
                 : "rgba(255,255,255,0.06)";
        const symbol = state === "must" ? "✓"
                     : state === "mustNot" ? "✗"
                     : "";
        return (
          <button
            key={i}
            onClick={() => onCycle(nIdx)}
            title={state === "must" ? "Must be same terrain — click to set: must NOT be"
                : state === "mustNot" ? "Must NOT be same terrain — click to set: any"
                : "Any (wildcard) — click to set: must be same terrain"}
            style={{
              padding: 0, cursor: "pointer",
              background: bg,
              border: state === "any" ? "1px dashed rgba(255,255,255,0.25)" : "1px solid rgba(0,0,0,0.4)",
              color: state === "any" ? "var(--text-dim)" : "white",
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1,
              boxSizing: "border-box",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >{symbol}</button>
        );
      })}
    </div>
  );
}

/** Render a single tile from a tileset as a CSS background. When `fill` is on,
 *  the tile scales to fill the parent box (whatever size it has).
 *
 *  CSS background-position percentage rule: `pos_px = percent * (container - image)`.
 *  We want the visible window to show the tile at pixel-position `pixelX` in the
 *  source sheet, scaled to container. That means we need `pos_px = -pixelX * scale`
 *  where scale = container / tw. Solving for percent (with image = sheetW × scale):
 *     percent = pixelX / (sheetW - tw)
 *  Edge case: a 1-column sheet has `sheetW == tw` so denominator is 0 — but then
 *  the image fills the container exactly, so any percent works (use 0). */
function TilePreviewBg({
  tile, tileset, size, fill,
}: {
  tile: number;
  tileset: TilesetAsset;
  size: number;
  fill?: boolean;
}) {
  // Folder mode: tileset.imageFile is just the filename (e.g. "tileset.png").
  // It's not a resolvable URL on its own — the actual file lives at
  // assets/<cb-path>/<name>/tileset.png. Resolve via AssetStore to a blob URL.
  const url = useTilesetURL(tileset);
  if (tileset.cols <= 0 || !tileset.imageFile || !url) return null;
  const c = tile % tileset.cols;
  const r = (tile - c) / tileset.cols;
  const tw = tileset.tileW, th = tileset.tileH;
  // Background image scaled so each source tile == one container box.
  const bgSize = `calc(${tileset.sheetW / tw} * 100%) calc(${tileset.sheetH / th} * 100%)`;
  const pixelX = tileset.offsetX + c * (tw + tileset.spacingX);
  const pixelY = tileset.offsetY + r * (th + tileset.spacingY);
  const denomX = tileset.sheetW - tw;
  const denomY = tileset.sheetH - th;
  const percentX = denomX > 0 ? (pixelX / denomX) * 100 : 0;
  const percentY = denomY > 0 ? (pixelY / denomY) * 100 : 0;
  return (
    <div style={{
      width: fill ? "100%" : size,
      height: fill ? "100%" : size,
      backgroundImage: `url(${url})`,
      backgroundSize: bgSize,
      backgroundPosition: `${percentX}% ${percentY}%`,
      backgroundRepeat: "no-repeat",
      imageRendering: "pixelated",
    }} />
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function computeCols(sheetW: number, tileW: number, offsetX: number, spacingX: number): number {
  if (sheetW <= 0 || tileW <= 0) return 0;
  return Math.max(0, Math.floor((sheetW - offsetX + spacingX) / (tileW + spacingX)));
}
function computeRows(sheetH: number, tileH: number, offsetY: number, spacingY: number): number {
  if (sheetH <= 0 || tileH <= 0) return 0;
  return Math.max(0, Math.floor((sheetH - offsetY + spacingY) / (tileH + spacingY)));
}

type TileDrop = {
  bp: string;
  min: number;
  max: number;
  chance: number;
  instanceName?: string;
  animation?: string;
  frame?: number;
  vars?: Record<string, string | number | boolean>;
};

const DROP_INPUT_STYLE: React.CSSProperties = { fontSize: 10, padding: "2px 3px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" };

/**
 * Per-tile mining editor — sets hardness (hit-points) and a drop table for
 * the currently-selected solid tile.
 *
 * Each drop row picks a Blueprint to spawn when this tile is destroyed.
 * Once a BP is chosen, the row expands to show the same per-instance
 * overrides you'd get when placing the BP in the scene editor (instance
 * name, SpriteRenderer animation / frame, and every exposeOnSpawn
 * variable). The BP itself authors its OnOverlap → GiveItem + Destroy
 * logic — drops just deposit the BP at the destroyed tile's world center.
 */
/** Reusable drop-table editor (BP + min/max/chance + per-instance overrides).
 *  Shared by the per-tile mining editor and the BigTile mining panel. */
function TileDropsGrid({ drops, onChange }: { drops: TileDrop[]; onChange: (drops: TileDrop[]) => void }) {
  const blueprints = useEditor((s) => s.project.blueprints);
  const sprites = useEditor((s) => s.project.sprites);
  const patchAt = (i: number, patch: Partial<TileDrop>) =>
    onChange(drops.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>Drops (spawn BPs at the destroyed cell)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {drops.length === 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", gridColumn: "1 / -1" }}>No drops yet.</span>
        )}
        {drops.map((d, i) => {
          const bp = blueprints.find((b) => b.name === d.bp);
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, background: "rgba(0,0,0,0.18)", border: "1px solid var(--border)", borderRadius: 3 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 46px 46px 56px 22px", gap: 4, alignItems: "center" }}>
                <select
                  value={d.bp}
                  onChange={(e) => patchAt(i, { bp: e.target.value, instanceName: "", animation: "", frame: undefined, vars: {} })}
                  style={DROP_INPUT_STYLE}
                  title="Blueprint to spawn at the destroyed tile."
                >
                  <option value="">— pick BP —</option>
                  {blueprints.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
                <input
                  type="number" min={0} step={1}
                  value={d.min}
                  title="Min count to spawn"
                  onChange={(e) => patchAt(i, { min: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
                  style={DROP_INPUT_STYLE}
                />
                <input
                  type="number" min={0} step={1}
                  value={d.max}
                  title="Max count to spawn"
                  onChange={(e) => patchAt(i, { max: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
                  style={DROP_INPUT_STYLE}
                />
                <input
                  type="number" min={0} max={100} step={1}
                  value={d.chance}
                  title="Chance % to spawn (0..100)"
                  onChange={(e) => patchAt(i, { chance: Math.max(0, Math.min(100, Math.floor(Number(e.target.value)) || 0)) })}
                  style={DROP_INPUT_STYLE}
                />
                <button
                  onClick={() => onChange(drops.filter((_, j) => j !== i))}
                  style={{ fontSize: 10, padding: "0 6px", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: "var(--orange)" }}
                  title="Remove drop"
                >×</button>
              </div>
              {bp && (
                <DropBpInstanceFields
                  bp={bp}
                  sprites={sprites}
                  instanceName={d.instanceName ?? ""}
                  animation={d.animation ?? ""}
                  frame={d.frame}
                  vars={d.vars ?? {}}
                  onChange={(patch) => patchAt(i, patch)}
                />
              )}
            </div>
          );
        })}
        <button
          onClick={() => onChange([...drops, { bp: "", min: 1, max: 1, chance: 100 }])}
          style={{ fontSize: 10, padding: "3px 8px", cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)", alignSelf: "flex-start", marginTop: 2 }}
        >+ add drop</button>
      </div>
    </>
  );
}

function TileMiningEditor({
  tile, solid, onSolidChange, hardness, growBack, growBackPop, drops, dropLayer, onBelowRemoved, excludedTags, onChange, onDropLayerChange, onGrowBackChange, onGrowBackPopChange, onBelowRemovedChange, onExcludedTagsChange,
}: {
  tile: number;
  /** Whether the tile is in the tileset's solidTiles list — drives only the
   *  Solid toggle. Mining (Hardness / Drops) is INDEPENDENT of solid: the
   *  runtime mines by hardness index, no collider required. */
  solid: boolean;
  onSolidChange: () => void;
  hardness: number | string;
  growBack: number | string;
  growBackPop: boolean;
  drops: TileDrop[];
  dropLayer: string;
  onBelowRemoved: "destroy" | "drop" | "none";
  excludedTags: string[];
  onChange: (hardness: number | string, drops: TileDrop[]) => void;
  onDropLayerChange: (layerName: string) => void;
  onGrowBackChange: (value: string) => void;
  onGrowBackPopChange: (pop: boolean) => void;
  onBelowRemovedChange: (value: "destroy" | "drop" | "none") => void;
  onExcludedTagsChange: (tags: string[]) => void;
}) {
  // Accept either a plain integer or a `random(min, max)` expression.
  // Pass the string through verbatim so the user can type freely; the
  // runtime parses it on first damage.
  const setHardness = (v: string) => {
    const s = v.trim();
    if (s === "") { onChange(0, drops); return; }
    if (/^-?\d+(\.\d+)?$/.test(s)) { onChange(Math.max(0, Math.floor(Number(s))), drops); return; }
    onChange(s, drops);
  };
  const setDrops = (next: TileDrop[]) => onChange(hardness, next);
  return (
    <div style={{
      marginTop: 8, padding: 8,
      background: "rgba(255,255,255,0.04)",
      border: "1px solid var(--border)", borderRadius: 4,
    }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 6 }}>
        Tile #{tile}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: "#fff" }} title="Make this tile block movement. Independent of mining — a non-solid tile (grass, bush) can still have Hardness and be mined.">Solid</span>
        <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11 }}>
          <Toggle value={solid} onChange={onSolidChange} style={{ margin: 0 }} />
          <span style={{ color: "var(--text-dim)" }}>Blocks movement</span>
        </label>
        <span style={{ fontSize: 11, color: "#fff" }} title="Hit-points required to destroy. 0 = unbreakable. Accepts a number or `random(min, max)` — each cell rolls once on first damage. Works on ANY tile — solid is NOT required to be mineable.">Hardness</span>
        <input
          type="text"
          value={String(hardness ?? "")}
          placeholder="e.g. 4 or random(1, 5)"
          onChange={(e) => setHardness(e.target.value)}
          style={{ ...DROP_INPUT_STYLE, fontSize: 11 }}
        />
        <span style={{ fontSize: 11, color: "#fff" }} title="Seconds until a destroyed cell of this tile re-appears (HP resets to full). 0 / blank = never. Accepts a number, random(min, max), or choose(a, b, …) — rolled per destroyed cell.">Grow back (s)</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="text"
            value={String(growBack ?? "")}
            placeholder="0 = never · 5 · random(3,8) · choose(2,4,6)"
            onChange={(e) => onGrowBackChange(e.target.value)}
            style={{ ...DROP_INPUT_STYLE, fontSize: 11, flex: 1 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", cursor: "pointer" }} title="Pop in (scale 0→1) when it regrows. Off = appears instantly.">
            <input type="checkbox" checked={growBackPop} onChange={(e) => onGrowBackPopChange(e.target.checked)} />pop
          </label>
        </div>
        <span style={{ fontSize: 11, color: "#fff" }} title="Scene layer name where drops spawn. Empty = same layer as the tilemap.">Drop layer</span>
        <input
          type="text"
          value={dropLayer}
          placeholder="blank = tilemap layer"
          onChange={(e) => onDropLayerChange(e.target.value)}
          style={{ ...DROP_INPUT_STYLE, fontSize: 11 }}
        />
        <span style={{ fontSize: 11, color: "#fff" }} title="What happens to THIS tile when the tile directly BELOW it is destroyed. 'destroy' fires this tile's drop table (when solid) and recurses. 'drop' tweens it down into the gap and recurses. Works without solid.">On floor lost</span>
        <select
          value={onBelowRemoved}
          onChange={(e) => onBelowRemovedChange(e.target.value as "destroy" | "drop" | "none")}
          style={{ ...DROP_INPUT_STYLE, fontSize: 11 }}
        >
          <option value="none">Do nothing</option>
          <option value="destroy">Destroy (fire drops + cascade)</option>
          <option value="drop">Drop down (tween)</option>
        </select>
        <span style={{ fontSize: 11, color: "#fff" }} title="Sprites with any of these tags pass THROUGH this tile's collider. Stacks on top of the tileset-wide excluded tags.">Exclude tags</span>
        <TagChips tags={excludedTags} onChange={onExcludedTagsChange} placeholder="ghost, projectile…" />
      </div>
      <TileDropsGrid drops={drops} onChange={setDrops} />
    </div>
  );
}

/**
 * Per-instance override block for a drop row's BP — mirrors the relevant
 * subset of the scene editor's instance inspector: instance name,
 * SpriteRenderer animation/frame override, and one input per
 * exposeOnSpawn variable on the BP. Leaving a field blank = use the BP's
 * default (just like a scene-placed instance).
 */
function DropBpInstanceFields({
  bp, sprites, instanceName, animation, frame, vars, onChange,
}: {
  bp: { id: string; name: string; behaviors: { kind: string; config: Record<string, unknown> }[]; variables: { id: string; name: string; type: string; numberKind?: string; exposeOnSpawn?: boolean; default: unknown }[] };
  sprites: SpriteAsset[];
  instanceName: string;
  animation: string;
  frame: number | undefined;
  vars: Record<string, string | number | boolean>;
  onChange: (patch: Partial<TileDrop>) => void;
}) {
  const renderer = bp.behaviors.find((b) => b.kind === "SpriteRenderer");
  const spriteId = renderer ? String(renderer.config.spriteId ?? "") : "";
  const sprite = sprites.find((s) => s.id === spriteId);
  const exposedVars = bp.variables.filter((v) => v.exposeOnSpawn);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 4, borderLeft: "2px solid var(--accent)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
        <span style={{ color: "var(--text-dim)" }} title="Per-instance name — same as the Instance Name field in the scene editor.">Instance</span>
        <input
          type="text"
          placeholder="(blank — use BP name)"
          value={instanceName}
          onChange={(e) => onChange({ instanceName: e.target.value })}
          style={DROP_INPUT_STYLE}
        />
      </div>
      {sprite && (() => {
        const mode: "animate" | "static" = typeof frame === "number" ? "static" : "animate";
        const animObj = sprite.animations.find((a) => (a.name || a.id) === animation) ?? sprite.animations[0];
        const frames = animObj?.frames ?? [];
        return (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
              <span style={{ color: "var(--text-dim)" }}>Mode</span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["animate", "static"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      if (m === "animate") onChange({ frame: undefined });
                      else onChange({ frame: typeof frame === "number" ? frame : 0 });
                    }}
                    style={{
                      flex: 1, padding: "3px 6px", fontSize: 10,
                      background: mode === m ? "var(--accent)" : "rgba(0,0,0,0.3)",
                      color: mode === m ? "#fff" : "var(--text-dim)",
                      border: "1px solid var(--border)", borderRadius: 2,
                      cursor: "pointer", textTransform: "capitalize",
                    }}
                    title={m === "animate" ? "Play the chosen animation normally" : "Lock the BP to one frame from the animation"}
                  >{m}</button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
              <span style={{ color: "var(--text-dim)" }}>Animation</span>
              <select
                value={animation}
                onChange={(e) => onChange({ animation: e.target.value, frame: mode === "static" ? 0 : frame })}
                style={DROP_INPUT_STYLE}
              >
                <option value="">— BP default —</option>
                {sprite.animations.map((a) => <option key={a.id} value={a.name || a.id}>{a.name || a.id}</option>)}
              </select>
            </div>
            {mode === "static" && (
              <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4, alignItems: "start", fontSize: 10 }}>
                <span style={{ color: "var(--text-dim)", paddingTop: 2 }}>Frame</span>
                {frames.length === 0 ? (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
                    {animation ? "(animation has no frames)" : "(pick an animation first)"}
                  </span>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {frames.map((f, idx) => {
                      const picked = frame === idx;
                      return (
                        <button
                          key={f.id}
                          onClick={() => onChange({ frame: idx })}
                          title={`Frame ${idx}`}
                          style={{
                            position: "relative", width: 34, height: 34, padding: 0,
                            background: f.imageFile ? "#000" : `#${f.color.toString(16).padStart(6, "0")}`,
                            border: picked ? "2px solid var(--accent)" : "1px solid var(--border)",
                            borderRadius: 2, cursor: "pointer", overflow: "hidden",
                          }}
                        >
                          {f.imageFile && (
                            <FrameThumb
                              sprite={sprite}
                              frame={f}
                              style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated", display: "block" }}
                            />
                          )}
                          <span style={{
                            position: "absolute", bottom: 0, right: 0,
                            fontSize: 8, padding: "0 2px", lineHeight: 1.2,
                            background: "rgba(0,0,0,0.65)", color: "#fff",
                          }}>{idx}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}
      {exposedVars.length > 0 && (
        <div style={{ fontSize: 9, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 }}>Spawn Vars</div>
      )}
      {exposedVars.map((v) => {
        const cur = vars[v.name];
        const display = cur === undefined ? "" : String(cur);
        const onUpdate = (raw: string) => {
          const nextVars = { ...vars };
          if (raw === "") delete nextVars[v.name];
          else if (v.type === "number") {
            // Reject non-numeric input for numeric var slots — runtime BPs
            // type-cast on read, so a string here lands as NaN downstream
            // (silent "0" or "NaN" comparisons). Drop the bad input instead.
            const n = Number(raw);
            if (Number.isFinite(n)) nextVars[v.name] = n;
            else delete nextVars[v.name];
          } else if (v.type === "bool") {
            nextVars[v.name] = raw === "true" || raw === "1";
          } else {
            nextVars[v.name] = raw;
          }
          onChange({ vars: nextVars });
        };
        return (
          <div key={v.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
            <span style={{ color: "var(--text-dim)" }} title={v.type}>{v.name}</span>
            {v.type === "bool" ? (
              <select value={display || "false"} onChange={(e) => onUpdate(e.target.value)} style={DROP_INPUT_STYLE}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : (
              <input
                type={v.type === "number" ? "number" : "text"}
                placeholder={`(default ${String(v.default)})`}
                value={display}
                onChange={(e) => onUpdate(e.target.value)}
                style={DROP_INPUT_STYLE}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AnimatedTileEditor({
  ts, at, assigning, onRequestAssign, onRemoveFrame, onPatch, onSetDrops, onRemove,
}: {
  ts: TilesetAsset;
  at: NonNullable<TilesetAsset["animatedTiles"]>[number];
  /** When non-null, the user is in assign mode for this exact frame index (or
   *  the trailing "+ add" slot). Drives the highlight border on that slot. */
  assigning: number | null;
  onRequestAssign: (frameIdx: number) => void;
  onRemoveFrame: (frameIdx: number) => void;
  onPatch: (patch: Partial<{ name: string; fps: number; loop: boolean; autoplay: boolean; hardness: number | string; growBack: number | string; growBackPop: boolean; destroyOnDepleted: boolean; playOnDepleted: boolean; playOnHit: boolean; damageStagesMode: boolean; tags: string[]; dropLayer: string; onBelowRemoved: "destroy" | "drop" | "none"; excludedTags: string[]; playOnOverlap: boolean; overlapTags: string[]; overlapMode: "edge" | "latch" | "loop"; signalOnHit: string; signalOnMine: string }>) => void;
  onSetDrops: (drops: TileDrop[]) => void;
  onRemove: () => void;
}) {
  const blueprints = useEditor((s) => s.project.blueprints);
  const sprites = useEditor((s) => s.project.sprites);
  const damageMode = at.damageStagesMode === true;
  // Live cycling preview — visualizes the animation at its configured fps so
  // the author sees exactly what'll play in-game. In damage-stages mode the
  // preview shows the FIRST frame (full HP) so authors see the intact state.
  const [previewFrame, setPreviewFrame] = useState(0);
  useEffect(() => {
    if (damageMode || at.frames.length === 0 || at.fps <= 0) return;
    const periodMs = 1000 / at.fps;
    const id = window.setInterval(() => {
      setPreviewFrame((f) => {
        if (at.frames.length === 0) return 0;
        if (!at.loop && f >= at.frames.length - 1) return f;
        return (f + 1) % at.frames.length;
      });
    }, periodMs);
    return () => window.clearInterval(id);
  }, [at.frames.length, at.fps, at.loop, damageMode]);
  const previewFrameVal = damageMode
    ? at.frames[0]
    : at.frames[Math.min(previewFrame, Math.max(0, at.frames.length - 1))];
  const previewRc = previewFrameVal !== undefined && ts.cols > 0
    ? animFrameRegion(previewFrameVal, ts.cols)
    : null;
  const drops = at.drops ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "5px 7px", background: "rgba(160,140,255,0.07)", border: "1px solid rgba(160,140,255,0.25)", borderRadius: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {previewRc
          ? <BigTilePreview ts={ts} bt={previewRc} maxPx={40} />
          : <div style={{ width: 40, height: 40, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 2 }} />}
        <input
          type="text"
          placeholder="name…"
          value={at.name ?? ""}
          onChange={(e) => onPatch({ name: e.target.value })}
          style={{ ...DROP_INPUT_STYLE, flex: 1 }}
        />
        <button onClick={onRemove} title="Remove animated tile" style={{ fontSize: 11, padding: "0 6px", cursor: "pointer", color: "var(--orange)", background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 2 }}>×</button>
      </div>
      {!damageMode && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 56px auto 1fr auto 1fr", gap: 5, alignItems: "center", fontSize: 10 }}>
          <span style={{ color: "var(--text-dim)" }}>FPS</span>
          <input
            type="number" min={0} step={1}
            value={at.fps}
            onChange={(e) => onPatch({ fps: Math.max(0, Number(e.target.value) || 0) })}
            style={DROP_INPUT_STYLE}
            title="Frames per second. 0 = freeze on frame 1."
          />
          <span style={{ color: "var(--text-dim)" }}>Loop</span>
          <Toggle
            value={at.loop}
            onChange={(v) => onPatch({ loop: v })}
            style={{ margin: 0, justifySelf: "start" }}
            title="Loop back to the first frame after the last."
          />
          <span style={{ color: "var(--text-dim)" }}>Auto</span>
          <Toggle
            value={at.autoplay}
            onChange={(v) => onPatch({ autoplay: v })}
            style={{ margin: 0, justifySelf: "start" }}
            title="Play automatically on scene load. When off, use PlayTileAnimation from the logic sheet."
          />
        </div>
      )}
      <div>
        <span style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {damageMode ? "Frames (frame N shown after N hits)" : "Frames"}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
          {at.frames.map((frame, i) => {
            const rc = animFrameRegion(frame, ts.cols);
            const active = assigning === i;
            return (
              <div key={i} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                <button
                  onClick={() => onRequestAssign(i)}
                  title={damageMode
                    ? `Frame ${i + 1} — shown ${i === 0 ? "initially (no hits yet)" : `after ${i} hit${i === 1 ? "" : "s"}`}. Add the same tile in adjacent slots to make it persist for multiple hits.`
                    : `Frame ${i + 1} — click to reassign`}
                  style={{
                    padding: 0, background: "transparent",
                    border: active ? "2px solid var(--yellow)" : "1px solid var(--border)",
                    borderRadius: 2, cursor: "pointer",
                  }}
                >
                  {ts.cols > 0
                    ? <BigTilePreview ts={ts} bt={rc} maxPx={28} />
                    : <div style={{ width: 28, height: 28, background: "rgba(0,0,0,0.35)" }} />}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveFrame(i); }}
                  title="Remove this frame"
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 14, height: 14, padding: 0, lineHeight: "12px",
                    fontSize: 10, color: "var(--orange)", cursor: "pointer",
                    background: "var(--frame)", border: "1px solid var(--border)",
                    borderRadius: 7,
                  }}
                >×</button>
                <span style={{ fontSize: 8, color: "var(--text-dim)" }}>{i + 1}</span>
              </div>
            );
          })}
          <button
            onClick={() => onRequestAssign(at.frames.length)}
            title="Add a frame — pick a tile from the palette"
            style={{
              width: 28, height: 28, padding: 0, lineHeight: 1,
              fontSize: 16, color: "var(--text-dim)", cursor: "pointer",
              background: assigning === at.frames.length ? "rgba(255,255,120,0.15)" : "rgba(0,0,0,0.25)",
              border: assigning === at.frames.length ? "2px solid var(--yellow)" : "1px dashed var(--border)",
              borderRadius: 2,
            }}
          >+</button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ color: "var(--text-dim)", fontSize: 9 }}>Tags</span>
        <TagChips
          tags={at.tags ?? []}
          onChange={(next) => onPatch({ tags: next })}
          placeholder="grass, lava…"
        />
        <span style={{ fontSize: 8, color: "var(--text-dim)", lineHeight: 1.35 }}>
          Labels for this tile. Used by <b>VisionMask</b> (e.g. tag "ground" so the vision cone doesn't fade it), read by <b>On Tile Destroyed / Damaged → Get Last Tile</b> (tag field), and — soon — to make the tile a <b>tracer target</b>.
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
        <span style={{ color: "var(--text-dim)" }} title="Hit-points required to destroy this animated placement. 0 / blank = unbreakable. Accepts a number or `random(min, max)` — each placement rolls its own HP on first damage.">Hardness</span>
        <input
          type="text"
          value={String(at.hardness ?? "")}
          placeholder="e.g. 4 or random(1, 5)"
          onChange={(e) => {
            const s = e.target.value.trim();
            if (s === "") { onPatch({ hardness: 0 }); return; }
            if (/^-?\d+(\.\d+)?$/.test(s)) { onPatch({ hardness: Math.max(0, Math.floor(Number(s))) }); return; }
            onPatch({ hardness: s });
          }}
          style={DROP_INPUT_STYLE}
        />
        <span title="Seconds until a destroyed placement re-appears. 0 / blank = never. Number, random(min, max), or choose(a, b, …).">Grow back (s)</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="text"
            value={String(at.growBack ?? "")}
            placeholder="0 = never · 5 · random(3,8)"
            onChange={(e) => {
              const s = e.target.value.trim();
              if (s === "" || s === "0") { onPatch({ growBack: 0 }); return; }
              if (/^-?\d+(\.\d+)?$/.test(s)) { onPatch({ growBack: Number(s) }); return; }
              onPatch({ growBack: s });
            }}
            style={{ ...DROP_INPUT_STYLE, flex: 1 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap", cursor: "pointer" }} title="Pop in (scale 0→1) when it regrows. Off = instant.">
            <input type="checkbox" checked={at.growBackPop !== false} onChange={(e) => onPatch({ growBackPop: e.target.checked })} />pop
          </label>
        </div>
        <span title="Signal emitted on the miner + Main Sheets on every surviving hit. Listen with On Signal.">Signal on hit</span>
        <input type="text" value={at.signalOnHit ?? ""} placeholder="e.g. bushHit" onChange={(e) => onPatch({ signalOnHit: e.target.value })} style={DROP_INPUT_STYLE} />
        <span title="Signal emitted on the miner + Main Sheets when destroyed (HP 0). Listen with On Signal.">Signal on mine</span>
        <input type="text" value={at.signalOnMine ?? ""} placeholder="e.g. bushCut" onChange={(e) => onPatch({ signalOnMine: e.target.value })} style={DROP_INPUT_STYLE} />
        <span title="Scene layer name where drops spawn. Empty = same layer as the tilemap. Use this to put drops on a dedicated 'Items' / 'Particles' layer with its own depth / opacity / parallax.">Drop layer</span>
        <input
          type="text"
          value={String(at.dropLayer ?? "")}
          placeholder="blank = tilemap layer"
          onChange={(e) => onPatch({ dropLayer: e.target.value })}
          style={DROP_INPUT_STYLE}
        />
        <span title="What happens to THIS animated tile when the tile directly BELOW it is destroyed. 'destroy' fires its drop table + cascade; 'drop' tweens it down into the gap.">On floor lost</span>
        <select
          value={String(at.onBelowRemoved ?? "none")}
          onChange={(e) => onPatch({ onBelowRemoved: e.target.value as "destroy" | "drop" | "none" })}
          style={DROP_INPUT_STYLE}
        >
          <option value="none">Do nothing</option>
          <option value="destroy">Destroy (fire drops + cascade)</option>
          <option value="drop">Drop down (tween)</option>
        </select>
        <span>Exclude tags</span>
        <TagChips tags={at.excludedTags ?? []} onChange={(tags) => onPatch({ excludedTags: tags })} placeholder="ghost, projectile…" />
        <span style={{ gridColumn: "1 / -1", fontSize: 8, color: "var(--text-dim)", lineHeight: 1.35 }}>
          Sprites carrying any of these tags pass <b>THROUGH</b> this tile's collider (e.g. "ghost", "projectile"). Only matters when the tile is solid. Stacks on the tileset-wide excluded tags.
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
          title="When ON, animation playback is disabled and each mining hit advances to the next frame. Frame 1 shows initially; frame 2 after 1 hit; frame 3 after 2 hits; etc. Add the same tile in multiple slots if you want a frame to persist for several hits. If you have fewer frames than hardness, the last frame holds until depletion.">
          <Toggle
            value={damageMode}
            onChange={(v) => onPatch({ damageStagesMode: v })}
            style={{ margin: 0 }}
          />
          <span>Change frame on mine (damage stages)</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
          title="When ON, HP=0 removes the placement immediately. When OFF, the placement stays — collider is removed, drops + OnTileDestroyed still fire.">
          <Toggle
            value={at.destroyOnDepleted !== false}
            onChange={(v) => onPatch({ destroyOnDepleted: v })}
            style={{ margin: 0 }}
          />
          <span>Destroy on mine</span>
        </label>
        {!damageMode && (
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            title="When ON, every surviving mine HIT plays the animation once (frame 0 → end) then returns to frame 0 — a shake/crack reaction. Works even at fps 0 (a fallback rate cycles the frames). The killing hit plays it too, then destroys if 'Destroy on mine' is on.">
            <Toggle
              value={!!at.playOnHit}
              onChange={(v) => onPatch({ playOnHit: v })}
              style={{ margin: 0 }}
            />
            <span>Play animation on each hit</span>
          </label>
        )}
        {!damageMode && (
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            title="When ON, only HP=0 restarts the animation from frame 0 with loop forced off — a one-shot 'crumble' effect, then destroys (if 'Destroy on mine' is on).">
            <Toggle
              value={!!at.playOnDepleted}
              onChange={(v) => onPatch({ playOnDepleted: v })}
              style={{ margin: 0 }}
            />
            <span>Play animation on destroy (HP 0)</span>
          </label>
        )}
        {!damageMode && (
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            title="When ON, the placement plays its animation when a sprite carrying one of the 'Plays for tags' below steps onto its cell. Pick the replay mode (once on enter / loop while standing / latch).">
            <Toggle
              value={!!at.playOnOverlap}
              onChange={(v) => onPatch({ playOnOverlap: v })}
              style={{ margin: 0 }}
            />
            <span>Play animation on overlap</span>
          </label>
        )}
        {!damageMode && at.playOnOverlap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 18 }}>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 4, alignItems: "center", fontSize: 10 }}>
              <span style={{ color: "var(--text-dim)" }} title="edge: play once each time a sprite enters. latch: play once on enter, don't replay until the cell empties. loop: loop while a sprite stands on it, freeze on frame 0 when empty.">Replay</span>
              <select
                value={at.overlapMode ?? "edge"}
                onChange={(e) => onPatch({ overlapMode: e.target.value as "edge" | "latch" | "loop" })}
                style={DROP_INPUT_STYLE}
              >
                <option value="edge">Once on enter (re-enter replays)</option>
                <option value="latch">Once, until cell empties (latch)</option>
                <option value="loop">Loop while overlapping</option>
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 9 }} title="Only sprites carrying one of these tags trigger the overlap animation. Empty = nothing triggers it.">Plays for tags</span>
              <TagChips tags={at.overlapTags ?? []} onChange={(tags) => onPatch({ overlapTags: tags })} placeholder="player…" />
            </div>
          </div>
        )}
      </div>
      <div style={{ fontSize: 9, color: "var(--text-dim)" }}>Drops (spawn BPs at the destroyed placement)</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {drops.map((d, i) => {
          const bp = blueprints.find((b) => b.name === d.bp);
          const patchAt = (patch: Partial<TileDrop>) => onSetDrops(drops.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3, padding: 5, background: "rgba(0,0,0,0.18)", border: "1px solid var(--border)", borderRadius: 3 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 40px 40px 50px 22px", gap: 3, alignItems: "center" }}>
                <select
                  value={d.bp}
                  onChange={(e) => patchAt({ bp: e.target.value, instanceName: "", animation: "", frame: undefined, vars: {} })}
                  style={DROP_INPUT_STYLE}
                >
                  <option value="">— pick BP —</option>
                  {blueprints.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
                </select>
                <input type="number" min={0} step={1} value={d.min}
                  onChange={(e) => patchAt({ min: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
                  style={DROP_INPUT_STYLE} title="Min count" />
                <input type="number" min={0} step={1} value={d.max}
                  onChange={(e) => patchAt({ max: Math.max(0, Math.floor(Number(e.target.value)) || 0) })}
                  style={DROP_INPUT_STYLE} title="Max count" />
                <input type="number" min={0} max={100} step={1} value={d.chance}
                  onChange={(e) => patchAt({ chance: Math.max(0, Math.min(100, Math.floor(Number(e.target.value)) || 0)) })}
                  style={DROP_INPUT_STYLE} title="Chance %" />
                <button onClick={() => onSetDrops(drops.filter((_, j) => j !== i))}
                  style={{ fontSize: 10, padding: "0 5px", cursor: "pointer", background: "transparent", border: "1px solid var(--border)", borderRadius: 2, color: "var(--orange)" }}
                  title="Remove drop">×</button>
              </div>
              {bp && (
                <DropBpInstanceFields
                  bp={bp}
                  sprites={sprites}
                  instanceName={d.instanceName ?? ""}
                  animation={d.animation ?? ""}
                  frame={d.frame}
                  vars={d.vars ?? {}}
                  onChange={(patch) => patchAt(patch)}
                />
              )}
            </div>
          );
        })}
        <button
          onClick={() => onSetDrops([...drops, { bp: "", min: 1, max: 1, chance: 100 }])}
          style={{ fontSize: 10, padding: "3px 8px", cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)", alignSelf: "flex-start" }}
        >+ add drop</button>
      </div>
    </div>
  );
}

export function BigTilePreview({ ts, bt, maxPx = 56, fill = false }: {
  ts: TilesetAsset;
  bt: { c: number; r: number; w: number; h: number; cells?: { c: number; r: number }[] };
  maxPx?: number;
  /** Stretch the canvas to fill its parent (used as a backdrop behind the
   *  collision-polygon editor, where the box already has the BigTile aspect). */
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tilesetUrl = useTilesetURL(ts);
  // Stable signature of the optional cells mask so the effect re-runs only
  // when the mask actually changes (deep equality via stringify keeps the
  // dep stable across BigTile-rect-only edits when cells is missing).
  const cellsKey = JSON.stringify(bt.cells ?? null);
  useEffect(() => {
    if (!tilesetUrl || !canvasRef.current) return;
    let cancelled = false;
    loadTilesetImage(tilesetUrl).then((img) => {
      if (cancelled || !canvasRef.current || !img) return;
      const sw = bt.w * ts.tileW + (bt.w - 1) * ts.spacingX;
      const sh = bt.h * ts.tileH + (bt.h - 1) * ts.spacingY;
      const scale = Math.min(maxPx / sw, maxPx / sh, 4);
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));
      const canvas = canvasRef.current;
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, dw, dh);
      const masked = bt.cells && bt.cells.length > 0 && bt.cells.length < bt.w * bt.h;
      if (masked) {
        for (const cell of bt.cells!) {
          const sx = ts.offsetX + (bt.c + cell.c) * (ts.tileW + ts.spacingX);
          const sy = ts.offsetY + (bt.r + cell.r) * (ts.tileH + ts.spacingY);
          const dx = cell.c * (ts.tileW + ts.spacingX) * scale;
          const dy = cell.r * (ts.tileH + ts.spacingY) * scale;
          ctx.drawImage(img, sx, sy, ts.tileW, ts.tileH, dx, dy, ts.tileW * scale, ts.tileH * scale);
        }
      } else {
        const sx = ts.offsetX + bt.c * (ts.tileW + ts.spacingX);
        const sy = ts.offsetY + bt.r * (ts.tileH + ts.spacingY);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
      }
    }).catch(() => { /* ignore — broken image, just leave blank */ });
    return () => { cancelled = true; };
  }, [tilesetUrl, ts.tileW, ts.tileH, ts.offsetX, ts.offsetY, ts.spacingX, ts.spacingY, bt.c, bt.r, bt.w, bt.h, cellsKey, maxPx]);
  return (
    <canvas
      ref={canvasRef}
      style={fill ? {
        position: "absolute", inset: 0,
        width: "100%", height: "100%",
        imageRendering: "pixelated",
        display: "block",
      } : {
        width: maxPx,
        height: maxPx,
        objectFit: "contain",
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 2,
        imageRendering: "pixelated",
        display: "block",
      }}
    />
  );
}

function readImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ dataUrl, w: img.width, h: img.height });
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
