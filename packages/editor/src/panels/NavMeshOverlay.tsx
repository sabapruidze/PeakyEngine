import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../store";
import { tilemapTilesets, animFrameRegion, type SceneData, type NavWaypoint } from "../project";

/**
 * In-scene navigation-mesh editor. Rendered INSIDE the scene div (so it inherits
 * the viewport's pan/zoom transform) when Nav mode is on. Captures its own mouse
 * events so it never fights the SceneEditor's instance/pan/tilemap handlers.
 *
 * Tools:
 *  - brush / erase : paint the walkable grid (green = NPCs may walk here).
 *  - obstacle      : click vertices → a detectable polygon (red); finish to commit.
 *  - waypoint      : click to drop a tagged "mission" dot.
 *
 * The walkable grid renders to a <canvas> (efficient for thousands of cells);
 * obstacles + waypoints render as SVG. Toolbar + objects panel are portalled to
 * <body> so the scene's CSS transform doesn't warp them.
 */
type NavTool = "select" | "brush" | "erase" | "shelter" | "shelterDrizzle" | "shelterErase" | "obstacle" | "waypoint";

const SIZES = [1, 2, 3, 4, 6, 8];

/** Controlled text field with its own buffer — robust against the overlay's
 *  frequent re-renders (hover) and focus-stealing mousedown propagation. */
function NavField({ value, onCommit, placeholder, width }: { value: string; onCommit: (v: string) => void; placeholder?: string; width?: number }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value); }, [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; onCommit(v); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{ flex: width ? "0 0 auto" : 1, minWidth: 0, width: width ?? "100%", boxSizing: "border-box", fontSize: 10, padding: "2px 4px", background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 3, color: "#f0f0f0" }}
    />
  );
}

/** Even-odd point-in-polygon, world coords. */
function pointInPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Read-only nav-objects viz (obstacles + waypoints) for the NORMAL scene
 *  editor — shown via the "Show Nav" toggle even when Nav edit mode is off, so
 *  authors see where missions/obstacles sit relative to scene objects. Inert. */
export function NavMeshView({ scene }: { scene: SceneData }) {
  const nm = scene.navMesh;
  if (!nm) return null;
  const navW = nm.cols * nm.cellSize, navH = nm.rows * nm.cellSize;
  return (
    <svg width={`${(navW / scene.width) * 100}%`} height={`${(navH / scene.height) * 100}%`} viewBox={`0 0 ${navW} ${navH}`} preserveAspectRatio="none"
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", zIndex: 40 }}>
      {nm.obstacles.map((o) => (
        <polygon key={o.id} points={o.points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="rgba(255,80,80,0.18)" stroke="rgba(255,80,80,0.8)" strokeWidth={2} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      ))}
      {nm.waypoints.map((w) => (
        <g key={w.id}>
          <circle cx={w.x} cy={w.y} r={6} fill="rgba(90,160,255,0.85)" stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <text x={w.x + 9} y={w.y + 4} fontSize={11} fill="#cfe4ff" style={{ paintOrder: "stroke" } as React.CSSProperties} stroke="#000" strokeWidth={3}>
            {w.name || (w.tags[0] ?? "wp")}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function NavMeshOverlay({ scene }: { scene: SceneData }) {
  const paintNavWalkable = useEditor((s) => s.paintNavWalkable);
  const paintNavShelter = useEditor((s) => s.paintNavShelter);
  const clearNavPaint = useEditor((s) => s.clearNavPaint);
  const setNavCellSize = useEditor((s) => s.setNavCellSize);
  const setNavSize = useEditor((s) => s.setNavSize);
  const setNavDebug = useEditor((s) => s.setNavDebug);
  const setNavRegionLocked = useEditor((s) => s.setNavRegionLocked);
  const addNavObstacle = useEditor((s) => s.addNavObstacle);
  const updateNavObstacle = useEditor((s) => s.updateNavObstacle);
  const removeNavObstacle = useEditor((s) => s.removeNavObstacle);
  const addNavWaypoint = useEditor((s) => s.addNavWaypoint);
  const updateNavWaypoint = useEditor((s) => s.updateNavWaypoint);
  const removeNavWaypoint = useEditor((s) => s.removeNavWaypoint);
  const blueprints = useEditor((s) => s.project.blueprints);
  const tilemaps = useEditor((s) => s.project.tilemaps);
  const tilesets = useEditor((s) => s.project.tilesets);
  // Blueprint → its state-machine state names, for the per-point "set state" UI.
  const bpList = useMemo(() => (blueprints ?? []).map((bp) => {
    const sm = (bp.behaviors ?? []).find((b) => b.kind === "StateMachine");
    const cfg = (sm?.config ?? {}) as { states?: { name?: string }[] };
    return { name: bp.name, states: (cfg.states ?? []).map((s) => s.name ?? "").filter(Boolean) };
  }).filter((b) => b.name), [blueprints]);

  const [tool, setTool] = useState<NavTool>("select");
  const [brushSize, setBrushSize] = useState(3);
  // 1 = linear (green, sharp turns), 2 = curved (yellow, rounded turns).
  const [paintType, setPaintType] = useState<1 | 2>(1);
  const [polyPts, setPolyPts] = useState<{ x: number; y: number }[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [autoTag, setAutoTag] = useState("");
  const [batchSel, setBatchSel] = useState<Set<string>>(new Set());

  // Drop a waypoint on every tilemap tile (BigTile / Animated placement) whose
  // tileset def carries `tag`. Lets the author tag bushes / nodes once and fill
  // the nav mesh in one click instead of placing 100 points by hand.
  const autoPlaceByTag = (rawTag: string) => {
    const tag = rawTag.trim();
    if (!tag) return;
    // Exact visual center = inst.x + cellOffset + footprintHalf, where the cell
    // offset uses the MAP's primary cell size but the footprint uses the tile's
    // OWNING tileset size (these differ on multi-tileset maps). This mirrors how
    // both the scene editor (drawImage at c*mapCell, sized bt.w*ownTileW) and the
    // runtime (worldX = layerLeft + c*mapTileW + bt.w*srcTW/2) place the tile.
    const bigDefs = new Map<string, { w: number; h: number; tags: string[]; px: number; py: number }>();
    const animDefs = new Map<string, { tags: string[]; cols: number; frame0: number | { c: number; r: number; w: number; h: number } | undefined }>();
    for (const ts of tilesets ?? []) {
      for (const b of ts.bigTiles ?? []) bigDefs.set(b.id, { w: b.w, h: b.h, tags: b.tags ?? [], px: b.pivotX ?? 0.5, py: b.pivotY ?? 1 });
      for (const a of ts.animatedTiles ?? []) animDefs.set(a.id, { tags: a.tags ?? [], cols: ts.cols, frame0: a.frames[0] });
    }
    let placed = 0;
    for (const inst of scene.tilemapInstances ?? []) {
      const tm = (tilemaps ?? []).find((t) => t.id === inst.tilemapId);
      if (!tm) continue;
      // Cell size = the map's PRIMARY tileset (same resolver the editor/runtime
      // use), so a missing/renamed tilesetId never falls back to a wrong size.
      const primary = tilemapTilesets(tm, tilesets ?? [])[0]?.ts;
      const tw = primary?.tileW ?? 32, th = primary?.tileH ?? 32;
      // Big tiles: anchor at the author's PIVOT (px/py fraction of the footprint
      // — e.g. a tree's bottom-center base). Animated tiles have no pivot, so use
      // their footprint center. Either way, select all + arrow-move to fine-tune.
      for (const layer of tm.layers) {
        for (const p of layer.bigTilePlacements ?? []) {
          const bt = bigDefs.get(p.bigTileId);
          if (!bt || !bt.tags.includes(tag)) continue;
          const id = addNavWaypoint(scene.id, Math.round(inst.x + (p.c + bt.px * bt.w) * tw), Math.round(inst.y + (p.r + bt.py * bt.h) * th), [tag]);
          // srcX/srcY = the anchor cell CENTER — the runtime checks this cell for
          // tile-existence (renewable availability), independent of the nav dot.
          updateNavWaypoint(scene.id, id, { name: tag, srcMap: tm.name, srcX: Math.round(inst.x + (p.c + 0.5) * tw), srcY: Math.round(inst.y + (p.r + 0.5) * th) });
          placed++;
        }
        for (const p of layer.animatedTilePlacements ?? []) {
          const at = animDefs.get(p.animatedTileId);
          if (!at || !at.tags.includes(tag)) continue;
          const reg = at.frame0 != null ? animFrameRegion(at.frame0, at.cols) : { c: 0, r: 0, w: 1, h: 1 };
          // Bottom-center (base) — tile art is ground-anchored to the bottom of
          // its box, so the base lands on the visible bush, not the empty top.
          const id = addNavWaypoint(scene.id, Math.round(inst.x + (p.c + reg.w / 2) * tw), Math.round(inst.y + (p.r + reg.h) * th), [tag]);
          updateNavWaypoint(scene.id, id, { name: tag, srcMap: tm.name, srcX: Math.round(inst.x + (p.c + 0.5) * tw), srcY: Math.round(inst.y + (p.r + 0.5) * th) });
          placed++;
        }
      }
    }
    if (placed === 0) window.alert(`No tilemap tiles tagged "${tag}" found in this scene. Tag the BigTile / Animated tile in the Tileset editor first.`);
  };

  const batchApply = (patch: Partial<NavWaypoint>) => {
    for (const id of batchSel) updateNavWaypoint(scene.id, id, patch);
  };

  // Recalculate: drop the existing points carrying this tag (the prior auto-placed
  // set) and re-scan, so added / removed / moved tiles are reflected in one click.
  // NOTE: manual arrow-nudges to those points are lost — they're regenerated.
  const recalcByTag = (rawTag: string) => {
    const tag = rawTag.trim();
    if (!tag) return;
    for (const w of (scene.navMesh?.waypoints ?? []).filter((w) => (w.tags ?? []).includes(tag))) {
      removeNavWaypoint(scene.id, w.id);
    }
    autoPlaceByTag(tag);
  };

  // Arrow keys move ALL selected (checkbox) points in sync — Shift = 10px steps.
  // Lets the author auto-place then fine-tune the whole batch onto the art.
  useEffect(() => {
    if (batchSel.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -1;
      else if (e.key === "ArrowRight") dx = 1;
      else if (e.key === "ArrowUp") dy = -1;
      else if (e.key === "ArrowDown") dy = 1;
      else return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 10 : 1;
      const wps = scene.navMesh?.waypoints ?? [];
      for (const id of batchSel) {
        const w = wps.find((x) => x.id === id);
        if (w) updateNavWaypoint(scene.id, id, { x: Math.round(w.x + dx * step), y: Math.round(w.y + dy * step) });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [batchSel, scene.id, scene.navMesh, updateNavWaypoint]);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painting = useRef(false);
  const dragWp = useRef<string | null>(null);
  const lastCell = useRef<{ c: number; r: number } | null>(null);
  const brushRef = useRef(brushSize); brushRef.current = brushSize;
  const toolRef = useRef(tool); toolRef.current = tool;
  const typeRef = useRef(paintType); typeRef.current = paintType;

  const nm = scene.navMesh;

  // Redraw the walkable grid whenever it changes. Canvas is sized to the GRID
  // (cols×rows, 1px/cell) — cheap even for huge unbounded maps — and CSS-scaled
  // up with pixelated rendering, so each cell stays crisp.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !nm) return;
    cv.width = nm.cols;
    cv.height = nm.rows;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, nm.cols, nm.rows);
    for (let r = 0; r < nm.rows; r++) {
      for (let c = 0; c < nm.cols; c++) {
        const v = nm.walkable[r * nm.cols + c];
        if (!v) continue;
        ctx.fillStyle = v === 2 ? "rgba(240,215,60,0.45)" : "rgba(70,225,120,0.40)";
        ctx.fillRect(c, r, 1, 1);
      }
    }
    // Shelter mask on top — blue (1) = fully dry (drops + splashes removed);
    // red (2) = rain still falls, only its splashes are removed.
    if (nm.shelter) {
      for (let r = 0; r < nm.rows; r++) {
        for (let c = 0; c < nm.cols; c++) {
          const v = nm.shelter[r * nm.cols + c];
          if (!v) continue;
          ctx.fillStyle = v === 2 ? "rgba(255,90,90,0.55)" : "rgba(90,190,255,0.55)";
          ctx.fillRect(c, r, 1, 1);
        }
      }
    }
  }, [nm]);

  if (!nm) return null;
  const cs = nm.cellSize;
  // Nav AREA in world px — independent of the scene/layout size (unbounded maps).
  const navW = nm.cols * cs;
  const navH = nm.rows * cs;

  const toWorld = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = rootRef.current!.getBoundingClientRect();
    const sx = rect.width / navW || 1;
    const sy = rect.height / navH || 1;
    return { x: (e.clientX - rect.left) / sx, y: (e.clientY - rect.top) / sy };
  };

  const paintCellsAround = (w: { x: number; y: number }, value: number) => {
    const c0 = Math.floor(w.x / cs), r0 = Math.floor(w.y / cs);
    if (lastCell.current && lastCell.current.c === c0 && lastCell.current.r === r0) return;
    lastCell.current = { c: c0, r: r0 };
    const rad = brushRef.current - 1;
    const t = toolRef.current;
    if (t === "shelter" || t === "shelterDrizzle" || t === "shelterErase") {
      // 1 = kills both (blue), 2 = kills only drizzles (red), 0 = clear.
      const on = t === "shelterErase" ? 0 : t === "shelterDrizzle" ? 2 : 1;
      const cells: { c: number; r: number; on: number }[] = [];
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) cells.push({ c: c0 + dc, r: r0 + dr, on });
      paintNavShelter(scene.id, cells);
      return;
    }
    const cells: { c: number; r: number; walkable: number }[] = [];
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) cells.push({ c: c0 + dc, r: r0 + dr, walkable: value });
    paintNavWalkable(scene.id, cells);
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const t = toolRef.current;
    const w = toWorld(e);
    if (t === "select") {
      // Hit-test waypoints first (small targets), then obstacles. Tolerance is
      // a constant ~12 screen px → world px varies with zoom.
      const rect = rootRef.current!.getBoundingClientRect();
      const sc = rect.width / navW || 1;
      const hitR = 12 / sc;
      let hit: string | null = null;
      for (const wp of nm.waypoints) { if (Math.hypot(wp.x - w.x, wp.y - w.y) <= Math.max(hitR, 8)) { hit = wp.id; break; } }
      if (hit) { setSelId(hit); dragWp.current = hit; return; }
      for (const o of nm.obstacles) { if (pointInPoly(w, o.points)) { setSelId(o.id); return; } }
      setSelId(null);
      return;
    }
    if (t === "brush" || t === "erase" || t === "shelter" || t === "shelterDrizzle" || t === "shelterErase") {
      painting.current = true;
      lastCell.current = null;
      paintCellsAround(w, t === "erase" ? 0 : typeRef.current);
    } else if (t === "waypoint") {
      const id = addNavWaypoint(scene.id, Math.round(w.x), Math.round(w.y), ["mission"]);
      setSelId(id);
    } else if (t === "obstacle") {
      // Pen-tool / AE-mask style: clicking near the FIRST vertex (>=3 pts)
      // CLOSES + commits the polygon instead of adding another point.
      if (polyPts.length >= 3) {
        const rect = rootRef.current!.getBoundingClientRect();
        const sc = rect.width / navW || 1;
        const f = polyPts[0];
        if (Math.hypot(f.x - w.x, f.y - w.y) <= Math.max(12 / sc, 8)) {
          const id = addNavObstacle(scene.id, polyPts, ["wall"]);
          setSelId(id);
          setPolyPts([]);
          return;
        }
      }
      setPolyPts((p) => [...p, { x: Math.round(w.x), y: Math.round(w.y) }]);
    }
  };
  const onMove = (e: React.MouseEvent) => {
    const w = toWorld(e);
    setHover(w);
    const t = toolRef.current;
    if (dragWp.current) { updateNavWaypoint(scene.id, dragWp.current, { x: Math.round(w.x), y: Math.round(w.y) }); return; }
    if (painting.current && (t === "brush" || t === "erase" || t === "shelter" || t === "shelterDrizzle" || t === "shelterErase")) paintCellsAround(w, t === "erase" ? 0 : typeRef.current);
  };
  const onUp = () => { painting.current = false; lastCell.current = null; dragWp.current = null; };

  const finishPoly = () => {
    if (polyPts.length >= 3) { const id = addNavObstacle(scene.id, polyPts, ["wall"]); setSelId(id); }
    setPolyPts([]);
  };

  const BTN = (active: boolean): React.CSSProperties => ({
    padding: "3px 8px", fontSize: 10, cursor: "pointer", borderRadius: 3,
    border: "1px solid rgba(255,255,255,0.15)", textTransform: "capitalize",
    background: active ? "rgba(120,210,140,0.40)" : "rgba(255,255,255,0.06)", color: "#f0f0f0",
  });

  // ── Toolbar (top) ──────────────────────────────────────────────────────
  const toolbar = createPortal(
    <div style={{
      position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", zIndex: 9999,
      background: "rgba(20,22,30,0.96)", border: "1px solid rgba(120,210,140,0.45)",
      borderRadius: 6, fontSize: 11, color: "#e8e8e8", boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
    }}>
      <span style={{ fontWeight: 700, color: "#7fe0a0" }}>NAV</span>
      {(["select", "brush", "erase", "obstacle", "waypoint"] as NavTool[]).map((t) => (
        <button key={t} onClick={() => { setTool(t); setPolyPts([]); }} style={BTN(tool === t)}>{t}</button>
      ))}
      <button onClick={() => { if (window.confirm("Clear ALL painted nav cells on this scene? Obstacles and waypoints stay.")) clearNavPaint(scene.id, "walkable"); }}
        title="Wipe every painted walkable cell (obstacles and waypoints stay)"
        style={{ ...BTN(false), color: "#e87" }}>clear</button>
      <span style={{ display: "flex", alignItems: "center", gap: 3, paddingLeft: 6, marginLeft: 2, borderLeft: "1px solid rgba(255,255,255,0.15)" }}
        title="Paint static ENVIRONMENT cover — weather is blocked over these cells. BLUE = fully dry (removes both drops AND splashes). RED = keeps the rain falling but removes its splashes. For moving objects (NPCs, umbrellas) use Weather's Shelter Tags instead.">
        <span style={{ color: "#7fd0ff", fontSize: 11 }}>☂</span>
        <button onClick={() => { setTool("shelter"); setPolyPts([]); }} title="Fully dry — removes drops AND splashes"
          style={{ ...BTN(tool === "shelter"), background: tool === "shelter" ? "rgba(90,190,255,0.55)" : "rgba(90,190,255,0.14)", color: "#cfeaff" }}>● dry</button>
        <button onClick={() => { setTool("shelterDrizzle"); setPolyPts([]); }} title="Rain still falls here — removes only the splashes"
          style={{ ...BTN(tool === "shelterDrizzle"), background: tool === "shelterDrizzle" ? "rgba(255,90,90,0.55)" : "rgba(255,90,90,0.14)", color: "#ffd6d6" }}>● no splash</button>
        <button onClick={() => { setTool("shelterErase"); setPolyPts([]); }}
          style={{ ...BTN(tool === "shelterErase"), background: tool === "shelterErase" ? "rgba(200,200,200,0.4)" : "rgba(255,255,255,0.06)" }}>erase</button>
        <button onClick={() => { if (window.confirm("Clear the ENTIRE shelter mask on this scene?")) clearNavPaint(scene.id, "shelter"); }}
          title="Wipe the whole shelter mask (blue + red)"
          style={{ ...BTN(false), color: "#e87" }}>clear</button>
      </span>
      {(tool === "brush" || tool === "erase" || tool === "shelter" || tool === "shelterDrizzle" || tool === "shelterErase") && (
        <span style={{ display: "flex", alignItems: "center", gap: 3, marginLeft: 4 }}>
          <span style={{ color: "#999" }}>size</span>
          {SIZES.map((s) => (
            <button key={s} onClick={() => setBrushSize(s)} style={{ ...BTN(brushSize === s), padding: "3px 6px", minWidth: 20 }}>{s}</button>
          ))}
        </span>
      )}
      {tool === "brush" && (
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <button onClick={() => setPaintType(1)} title="Linear — sharp/straight turns" style={{ ...BTN(paintType === 1), borderColor: paintType === 1 ? "#5ee080" : undefined, color: "#9af0b5" }}>● linear</button>
          <button onClick={() => setPaintType(2)} title="Curved — rounded/smooth turns" style={{ ...BTN(paintType === 2), borderColor: paintType === 2 ? "#e8d23c" : undefined, color: "#f0e08a" }}>● curved</button>
        </span>
      )}
      <span style={{ marginLeft: 6, paddingLeft: 8, borderLeft: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", gap: 4, color: "#9aa" }}>
        <span style={{ color: "#777" }} title="Nav-mesh area in world px — set this to your MAP size (can exceed the layout for unbounded scenes).">size</span>
        <NavField value={String(navW)} width={56} onCommit={(v) => { const n = Math.round(Number(v)); if (n > 0) setNavSize(scene.id, n, navH); }} />
        <span>×</span>
        <NavField value={String(navH)} width={56} onCommit={(v) => { const n = Math.round(Number(v)); if (n > 0) setNavSize(scene.id, navW, n); }} />
        <span style={{ color: "#777" }}>cell</span>
        <select value={nm.cellSize} onChange={(e) => setNavCellSize(scene.id, Number(e.target.value))} onMouseDown={(e) => e.stopPropagation()}
          style={{ fontSize: 10, padding: "1px 2px", background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 3, color: "#f0f0f0" }}>
          {[8, 12, 16, 24, 32, 48].map((s) => <option key={s} value={s}>{s}px</option>)}
        </select>
        <span style={{ color: "#666", fontSize: 9 }}>{nm.cols}×{nm.rows}</span>
      </span>
      <label style={{ marginLeft: 6, paddingLeft: 8, borderLeft: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", gap: 4, color: "#9aa", cursor: "pointer", fontSize: 10 }}
        title="Draw each point colored by state during Play: green=active, yellow=busy (claimed), red=consumed, gray=depleted (tile mined/regrowing).">
        <input type="checkbox" checked={!!nm.debug} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setNavDebug(scene.id, e.target.checked)} />
        debug in game
      </label>
      <label style={{ marginLeft: 6, paddingLeft: 8, borderLeft: "1px solid rgba(255,255,255,0.15)", display: "flex", alignItems: "center", gap: 4, color: "#9aa", cursor: "pointer", fontSize: 10 }}
        title="Only let NPCs target nav points in the SAME connected painted area they're in — skips doomed pathfinding toward unreachable points in disconnected blobs. Only matters when the mesh has separate areas.">
        <input type="checkbox" checked={!!nm.regionLocked} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setNavRegionLocked(scene.id, e.target.checked)} />
        area filter
      </label>
      {tool === "obstacle" && (
        <>
          <span style={{ color: "#bbb" }}>click vertices ({polyPts.length}){polyPts.length >= 3 ? " — click 1st point to close" : ""}</span>
          <button onClick={finishPoly} disabled={polyPts.length < 3}
            style={{ ...BTN(false), border: "1px solid rgba(255,120,120,0.5)", background: polyPts.length >= 3 ? "rgba(255,90,90,0.3)" : "rgba(255,255,255,0.04)" }}>finish</button>
          <button onClick={() => setPolyPts([])} style={{ ...BTN(false), color: "#ccc" }}>cancel</button>
        </>
      )}
    </div>,
    document.body,
  );

  // ── Objects panel (right) ──────────────────────────────────────────────
  const tagInput = (cur: string[], apply: (next: string[]) => void) => (
    <NavField value={cur.join(", ")} placeholder="tags" onCommit={(v) => apply(v.split(",").map((t) => t.trim()).filter(Boolean))} />
  );
  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 5, padding: "3px 5px", borderRadius: 3,
    background: active ? "rgba(120,160,255,0.20)" : "transparent", cursor: "pointer",
  });
  const mRow = (label: string, node: React.ReactNode) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0" }}>
      <span style={{ width: 64, color: "#999", fontSize: 10, flex: "0 0 auto" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>{node}</div>
    </div>
  );
  const selStyle: React.CSSProperties = { flex: 1, fontSize: 11, padding: "2px 4px", background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 3, color: "#f0f0f0" };
  const objectsPanel = createPortal(
    <div style={{
      position: "fixed", top: 60, right: 12, width: 210, maxHeight: "70vh", overflowY: "auto", zIndex: 9999,
      padding: 8, background: "rgba(20,22,30,0.96)", border: "1px solid rgba(120,210,140,0.4)",
      borderRadius: 6, fontSize: 11, color: "#e8e8e8", boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
    }}>
      <div style={{ fontWeight: 700, color: "#7fe0a0", marginBottom: 6 }}>NAV OBJECTS</div>

      <div style={{ color: "#9bd0ff", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 2px" }}>Auto-place on tagged tiles</div>
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
        <input value={autoTag} placeholder="tile tag e.g. bush" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          onChange={(e) => setAutoTag(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { autoPlaceByTag(autoTag); } }}
          style={{ flex: 1, minWidth: 0, fontSize: 10, padding: "2px 4px", background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 3, color: "#f0f0f0" }} />
        <button onClick={() => autoPlaceByTag(autoTag)} title="Add points for tagged tiles (keeps existing points)." style={{ ...BTN(false), color: "#9af0b5", flex: "0 0 auto" }}>+ place</button>
        <button onClick={() => recalcByTag(autoTag)} title="Recalculate: clear this tag's points and re-place from the current tiles (reflects added/removed/moved bushes). Manual nudges are lost." style={{ ...BTN(false), color: "#9bd0ff", flex: "0 0 auto" }}>↻ recalc</button>
      </div>

      <div style={{ color: "#9bd0ff", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, margin: "6px 0 2px", display: "flex", alignItems: "center" }}>
        <span>Waypoints ({nm.waypoints.length})</span>
        {nm.waypoints.length > 0 && (
          <button onClick={() => setBatchSel(batchSel.size === nm.waypoints.length ? new Set() : new Set(nm.waypoints.map((w) => w.id)))}
            style={{ marginLeft: "auto", ...BTN(false), fontSize: 9, padding: "1px 5px", color: "#cfe4ff" }}>{batchSel.size === nm.waypoints.length ? "none" : "all"}</button>
        )}
      </div>
      {nm.waypoints.length === 0 && <div style={{ color: "#666", fontSize: 10, fontStyle: "italic" }}>none — use the Waypoint tool</div>}
      {nm.waypoints.map((w) => (
        <div key={w.id} style={rowStyle(selId === w.id)} onClick={() => setSelId(w.id)} title="Click to edit this point">
          <input type="checkbox" checked={batchSel.has(w.id)} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onChange={() => setBatchSel((prev) => { const n = new Set(prev); if (n.has(w.id)) n.delete(w.id); else n.add(w.id); return n; })} style={{ flex: "0 0 auto", margin: 0 }} />
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: selId === w.id ? "#ffd060" : "rgba(90,160,255,0.9)", flex: "0 0 auto" }} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: selId === w.id ? "#fff" : "#cfe4ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name || (w.tags[0] ?? "waypoint")}</span>
          <button onClick={(e) => { e.stopPropagation(); setBatchSel((prev) => { const n = new Set(prev); n.delete(w.id); return n; }); removeNavWaypoint(scene.id, w.id); }} style={{ color: "#e87", background: "transparent", border: "none", cursor: "pointer", fontSize: 13 }}>×</button>
        </div>
      ))}
      {batchSel.size > 0 && (
        <div style={{ marginTop: 6, padding: 7, border: "1px solid rgba(230,200,80,0.4)", borderRadius: 4, background: "rgba(60,52,20,0.4)" }}>
          <div style={{ color: "#e0c050", fontSize: 9, fontWeight: 700, marginBottom: 4 }}>BATCH EDIT — {batchSel.size} selected</div>
          <div style={{ color: "#9ad", fontSize: 9, fontStyle: "italic", marginBottom: 4 }}>↑↓←→ move all in sync (Shift = 10px)</div>
          {mRow("wait (s)", <NavField value="" placeholder="apply to all" onCommit={(v) => { if (v.trim() !== "") batchApply({ waitSec: Math.max(0, Number(v) || 0) }); }} />)}
          {mRow("set state", <NavField value="" placeholder="apply to all" onCommit={(v) => { if (v.trim() !== "") batchApply({ setStateAny: v.trim() }); }} />)}
          {mRow("emit sig", <NavField value="" placeholder="apply to all" onCommit={(v) => { if (v.trim() !== "") batchApply({ signalOnArrive: v.trim() }); }} />)}
          {mRow("consume", (() => {
            const allOn = batchSel.size > 0 && nm.waypoints.filter((w) => batchSel.has(w.id)).every((w) => !!w.singleUse);
            return (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", color: "#cfe4ff" }}>
                <input type="checkbox" checked={allOn} onChange={() => batchApply({ singleUse: allOn ? undefined : true })} />
                consume on arrival (all selected)
              </label>
            );
          })())}
          <button onClick={() => { for (const id of batchSel) removeNavWaypoint(scene.id, id); setBatchSel(new Set()); }} style={{ ...BTN(false), marginTop: 5, width: "100%", color: "#e87", fontSize: 9 }}>delete {batchSel.size} points</button>
        </div>
      )}

      <div style={{ color: "#ff9b9b", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 2px" }}>Obstacles ({nm.obstacles.length})</div>
      {nm.obstacles.length === 0 && <div style={{ color: "#666", fontSize: 10, fontStyle: "italic" }}>none — use the Obstacle tool</div>}
      {nm.obstacles.map((o, i) => (
        <div key={o.id} style={rowStyle(selId === o.id)} onClick={() => setSelId(o.id)}>
          <span style={{ width: 10, height: 10, background: "rgba(255,90,90,0.7)", flex: "0 0 auto" }} />
          <span style={{ color: "#aaa", fontSize: 9 }}>#{i + 1}</span>
          {tagInput(o.tags, (next) => updateNavObstacle(scene.id, o.id, { tags: next }))}
          <button onClick={(e) => { e.stopPropagation(); removeNavObstacle(scene.id, o.id); }} style={{ marginLeft: "auto", color: "#e87", background: "transparent", border: "none", cursor: "pointer", fontSize: 13 }}>×</button>
        </div>
      ))}
    </div>,
    document.body,
  );

  // ── Per-point modal (opens when a waypoint is selected) ────────────────
  const selWp = nm.waypoints.find((w) => w.id === selId);
  const waypointModal = selWp ? (() => {
    const ss = selWp.setStates ?? [];
    const writeSS = (next: { bp: string; state: string }[]) => updateNavWaypoint(scene.id, selWp.id, { setStates: next.length ? next : undefined });
    return createPortal(
      <div onMouseDown={(e) => e.stopPropagation()} style={{
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 340, maxHeight: "82vh", overflowY: "auto", zIndex: 10000,
        padding: 14, background: "rgba(22,24,32,0.99)", border: "1px solid rgba(120,160,255,0.55)", borderRadius: 8, fontSize: 12, color: "#e8e8e8", boxShadow: "0 8px 34px rgba(0,0,0,0.65)",
      }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ffd060", marginRight: 7 }} />
          <span style={{ fontWeight: 700, color: "#9bd0ff" }}>NAV POINT — {selWp.name || (selWp.tags[0] ?? "waypoint")}</span>
          <button onClick={() => { removeNavWaypoint(scene.id, selWp.id); setSelId(null); }} style={{ marginLeft: "auto", ...BTN(false), color: "#e87", borderColor: "rgba(230,120,120,0.5)" }}>delete</button>
          <button onClick={() => setSelId(null)} style={{ marginLeft: 6, background: "transparent", border: "none", color: "#ccc", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {mRow("name", <NavField value={selWp.name ?? ""} placeholder="e.g. missionA" onCommit={(v) => updateNavWaypoint(scene.id, selWp.id, { name: v.trim() })} />)}
        {mRow("tags", tagInput(selWp.tags, (next) => updateNavWaypoint(scene.id, selWp.id, { tags: next })))}
        {mRow("wait (sec)", <NavField value={selWp.waitSec != null ? String(selWp.waitSec) : ""} placeholder="0" onCommit={(v) => updateNavWaypoint(scene.id, selWp.id, { waitSec: v.trim() === "" ? undefined : Math.max(0, Number(v) || 0) })} />)}
        {mRow("emit signal", <NavField value={selWp.signalOnArrive ?? ""} placeholder="onArrive" onCommit={(v) => updateNavWaypoint(scene.id, selWp.id, { signalOnArrive: v.trim() || undefined })} />)}
        {mRow("consume", (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", color: "#cfe4ff" }}>
            <input type="checkbox" checked={!!selWp.singleUse} onChange={(e) => updateNavWaypoint(scene.id, selWp.id, { singleUse: e.target.checked || undefined })} />
            consume on arrival — unavailable to other NPCs after
          </label>
        ))}
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={{ color: "#e0c050", fontSize: 10, fontWeight: 700, marginBottom: 5 }}>SET STATE ON ARRIVE — any NPC</div>
          {mRow("set state", <NavField value={selWp.setStateAny ?? ""} placeholder="e.g. Eat" onCommit={(v) => updateNavWaypoint(scene.id, selWp.id, { setStateAny: v.trim() || undefined })} />)}
          <div style={{ color: "#888", fontSize: 9, fontStyle: "italic", marginTop: 2 }}>any NPC that has a state by this name switches to it on arrival</div>
        </div>
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={{ color: "#e0c050", fontSize: 10, fontWeight: 700, marginBottom: 5 }}>SET STATE ON ARRIVE — per NPC (overrides above)</div>
          {ss.length === 0 && <div style={{ color: "#666", fontSize: 10, fontStyle: "italic", marginBottom: 4 }}>none — add an NPC to force its state here</div>}
          {ss.map((row, i) => {
            const bp = bpList.find((b) => b.name === row.bp);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, margin: "4px 0" }}>
                <select value={row.bp} onChange={(e) => writeSS(ss.map((s, idx) => idx === i ? { bp: e.target.value, state: "" } : s))} style={selStyle}>
                  <option value="">— NPC blueprint —</option>
                  {bpList.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
                </select>
                <select value={row.state} onChange={(e) => writeSS(ss.map((s, idx) => idx === i ? { ...s, state: e.target.value } : s))} style={{ ...selStyle, opacity: row.bp ? 1 : 0.5 }} disabled={!row.bp}>
                  <option value="">— state —</option>
                  {(bp?.states ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => writeSS(ss.filter((_, idx) => idx !== i))} style={{ color: "#e87", background: "transparent", border: "none", cursor: "pointer", fontSize: 13 }}>×</button>
              </div>
            );
          })}
          <button onClick={() => writeSS([...ss, { bp: "", state: "" }])} style={{ ...BTN(false), marginTop: 4, width: "100%", color: "#9af0b5" }}>+ add NPC</button>
        </div>
      </div>,
      document.body,
    );
  })() : null;

  const brushPx = brushSize * 2 - 1;
  return (
    <>
      {toolbar}
      {objectsPanel}
      {waypointModal}
      <div ref={rootRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        style={{ position: "absolute", left: 0, top: 0, width: `${(navW / scene.width) * 100}%`, height: `${(navH / scene.height) * 100}%`, cursor: tool === "select" ? "default" : "crosshair", zIndex: 50, background: "rgba(0,0,0,0.32)" }}>
        <canvas ref={canvasRef} style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", imageRendering: "pixelated", pointerEvents: "none" }} />
        <svg width="100%" height="100%" viewBox={`0 0 ${navW} ${navH}`} preserveAspectRatio="none"
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
          {nm.obstacles.map((o) => (
            <polygon key={o.id} points={o.points.map((p) => `${p.x},${p.y}`).join(" ")}
              fill={selId === o.id ? "rgba(255,150,80,0.35)" : "rgba(255,80,80,0.28)"}
              stroke={selId === o.id ? "#ffd060" : "rgba(255,80,80,0.95)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          ))}
          {polyPts.length > 0 && (
            <polyline points={[...polyPts, ...(hover ? [hover] : [])].map((p) => `${p.x},${p.y}`).join(" ")}
              fill="rgba(255,80,80,0.12)" stroke="rgba(255,180,80,0.95)" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          )}
          {polyPts.map((p, i) => {
            const closeable = i === 0 && polyPts.length >= 3;
            return (
              <circle key={i} cx={p.x} cy={p.y} r={closeable ? 8 : 4}
                fill={closeable ? "rgba(120,230,150,0.5)" : "#ffb050"}
                stroke={closeable ? "#7fe0a0" : "none"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            );
          })}
          {nm.waypoints.map((w) => (
            <g key={w.id}>
              <circle cx={w.x} cy={w.y} r={7} fill={selId === w.id ? "#ffd060" : "rgba(90,160,255,0.85)"} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <text x={w.x + 10} y={w.y + 4} fontSize={12} fill="#cfe4ff" style={{ paintOrder: "stroke" } as React.CSSProperties} stroke="#000" strokeWidth={3}>
                {w.name || (w.tags[0] ?? "wp")}
              </text>
            </g>
          ))}
          {hover && (tool === "brush" || tool === "erase" || tool === "shelter" || tool === "shelterDrizzle" || tool === "shelterErase") && (
            <rect x={(Math.floor(hover.x / cs) - (brushSize - 1)) * cs} y={(Math.floor(hover.y / cs) - (brushSize - 1)) * cs}
              width={brushPx * cs} height={brushPx * cs} fill="none"
              stroke={tool === "erase" ? "rgba(255,120,120,0.9)" : tool === "shelter" ? "rgba(90,190,255,0.95)" : tool === "shelterDrizzle" ? "rgba(255,90,90,0.95)" : tool === "shelterErase" ? "rgba(210,210,210,0.9)" : paintType === 2 ? "rgba(240,215,60,0.95)" : "rgba(120,255,160,0.95)"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
    </>
  );
}
