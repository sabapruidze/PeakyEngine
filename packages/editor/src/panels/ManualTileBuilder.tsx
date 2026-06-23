import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../store";
import { useAssetURL } from "../useAssetURL";
import { writeAssetFromDataURL, tilesetImagePath } from "../AssetStore";
import type { TilesetAsset } from "../project";

/**
 * Manual Tile Builder — draw FREE-FORM rectangles on a raw (messy / non-grid)
 * source sheet; produces a clean grid-sliceable tileset. Solves the "AI
 * showcase sheets have no real grid" problem by letting the author place every
 * tile box by hand.
 *
 * EACH box has its OWN bake size (set in the preview pane). The grid cell is
 * sized to the biggest box, and every box is drawn at its own size top-left in
 * its cell — so a 64×64 and a 64×128 tile can live in the same tileset (smaller
 * ones just have transparent room in their cell). No BigTiles.
 *
 * Bake scaling has two modes (how the SOURCE box maps to the chosen size):
 *  - "snap"  → stretch to the chosen size exactly.
 *  - "free"  → scale to fit keeping aspect (centered, transparent letterbox).
 *
 * Drawing is always free (any position / size).
 */
type Region = { x: number; y: number; w: number; h: number; tw?: number; th?: number };
type Drag =
  | { mode: "draw"; sx: number; sy: number }
  | { mode: "move"; idx: number; sx: number; sy: number; orig: Region }
  | { mode: "resize"; idx: number; corner: number; orig: Region };

const HANDLE = 12; // px (screen) hit radius for corner handles

function readImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ dataUrl, w: img.width, h: img.height });
      img.onerror = () => reject(new Error("decode failed"));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

const loadImg = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });

export function ManualTileBuilder({ tileset, onClose }: { tileset: TilesetAsset; onClose: () => void }) {
  const updateTileset = useEditor((s) => s.updateTileset);

  const srcPath = tileset.manualSourceFile
    ? tilesetImagePath({ ...tileset, imageFile: tileset.manualSourceFile })
    : undefined;
  const srcUrl = useAssetURL(srcPath);

  const [regions, setRegions] = useState<Region[]>(tileset.manualRegions ?? []);
  const [sel, setSel] = useState<number | null>(null);
  const [gap, setGap] = useState(Math.max(0, tileset.spacingX || 0));
  const [fit, setFit] = useState<"snap" | "free">(tileset.manualFit ?? "snap");
  // Uniform mode: one bake size for EVERY tile (vs. per-box sizes). On by
  // default if every region already shares the tileset's baked cell size.
  const [uniform, setUniform] = useState(!!tileset.manualUniform);
  const [uniW, setUniW] = useState(tileset.manualUniW || (tileset.tileW && tileset.tileW >= 8 ? tileset.tileW : 128));
  const [uniH, setUniH] = useState(tileset.manualUniH || (tileset.tileH && tileset.tileH >= 8 ? tileset.tileH : 128));
  const [srcDims, setSrcDims] = useState({ w: 0, h: 0 });
  const [busy, setBusy] = useState(false);
  const [seedCols, setSeedCols] = useState(6);
  const [seedRows, setSeedRows] = useState(5);

  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const alphaRef = useRef<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef(false);
  const [previewW, setPreviewW] = useState(380);
  const [lightBg, setLightBg] = useState(false);
  const [autoSnap, setAutoSnap] = useState(true);
  const [imgReady, setImgReady] = useState(0);
  const [, force] = useState(0);

  // Draggable divider to grow/shrink the preview pane.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current || !panesRef.current) return;
      const rect = panesRef.current.getBoundingClientRect();
      setPreviewW(Math.max(220, Math.min(rect.width - 200, rect.right - e.clientX)));
    };
    const onUp = () => { resizeRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // Load the source once: gives natural size AND a reusable Image for the
  // live preview + bake.
  useEffect(() => {
    imgRef.current = null;
    if (!srcUrl) { setSrcDims({ w: 0, h: 0 }); return; }
    let alive = true;
    void loadImg(srcUrl).then((im) => {
      if (!alive) return;
      imgRef.current = im;
      // Pull the alpha channel once for auto-snap (autocrop to non-transparent).
      try {
        const off = document.createElement("canvas"); off.width = im.width; off.height = im.height;
        const octx = off.getContext("2d", { willReadFrequently: true });
        if (octx) { octx.drawImage(im, 0, 0); alphaRef.current = { data: octx.getImageData(0, 0, im.width, im.height).data, w: im.width, h: im.height }; }
      } catch { alphaRef.current = null; }
      setSrcDims({ w: im.width, h: im.height }); setImgReady((n) => n + 1);
    });
    return () => { alive = false; };
  }, [srcUrl]);

  // Autocrop a region to the tightest box around its non-transparent pixels.
  const snap = (r: Region): Region => {
    const a = alphaRef.current; if (!a) return r;
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(a.w, Math.ceil(r.x + r.w)), y1 = Math.min(a.h, Math.ceil(r.y + r.h));
    let minx = x1, miny = y1, maxx = x0, maxy = y0, found = false;
    const T = 16;
    for (let y = y0; y < y1; y++) {
      const row = y * a.w * 4;
      for (let x = x0; x < x1; x++) {
        if (a.data[row + x * 4 + 3] > T) { found = true; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      }
    }
    return found ? { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 } : r;
  };

  // This box's chosen OUTPUT size in px. Uniform mode → one size for all;
  // otherwise its own `tw`/`th`, else the detected box size (set per-box).
  const bakeW = (r: Region) => uniform ? Math.max(1, uniW) : Math.max(1, Math.round(r.tw ?? r.w));
  const bakeH = (r: Region) => uniform ? Math.max(1, uniH) : Math.max(1, Math.round(r.th ?? r.h));

  // Live preview — render ONLY the currently selected tile, at the cell size,
  // so you judge the ONE you're editing (the canvas is CSS-scaled up to fill
  // the pane → one big tile, not all of them shrunk into a grid).
  useEffect(() => {
    const cv = previewRef.current; const img = imgRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    const r = sel != null ? regions[sel] : null;
    if (!img || !r || r.w < 1 || r.h < 1) { cv.width = 1; cv.height = 1; ctx.clearRect(0, 0, 1, 1); return; }
    const tw = bakeW(r), th = bakeH(r);
    cv.width = tw; cv.height = th;
    ctx.clearRect(0, 0, tw, th); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (fit === "snap") ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    else { const s = Math.min(tw / r.w, th / r.h); const dw = r.w * s, dh = r.h * s; ctx.drawImage(img, r.x, r.y, r.w, r.h, (tw - dw) / 2, (th - dh) / 2, dw, dh); }
  }, [regions, sel, fit, uniform, uniW, uniH, imgReady]);

  // Display scale: fit the source into the stage width, never upscale past 1.
  const STAGE_W = 1040;
  const sc = useMemo(() => (srcDims.w > 0 ? Math.min(1, STAGE_W / srcDims.w) : 1), [srcDims.w]);

  const toSrc = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(srcDims.w, (clientX - r.left) / sc)),
      y: Math.max(0, Math.min(srcDims.h, (clientY - r.top) / sc)),
    };
  };

  // ── drag lifecycle (window-level so it survives leaving the stage) ──
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toSrc(e.clientX, e.clientY);
      setRegions((rs) => {
        const next = rs.slice();
        if (d.mode === "draw") {
          const x = Math.min(d.sx, p.x), y = Math.min(d.sy, p.y);
          const w = Math.abs(p.x - d.sx), h = Math.abs(p.y - d.sy);
          next[next.length - 1] = { x, y, w, h };
        } else if (d.mode === "move") {
          const dx = p.x - d.sx, dy = p.y - d.sy;
          next[d.idx] = { ...d.orig, x: Math.max(0, d.orig.x + dx), y: Math.max(0, d.orig.y + dy) };
        } else {
          const o = d.orig;
          let { x, y, w, h } = o;
          const rx = o.x + o.w, ry = o.y + o.h;
          if (d.corner === 0) { x = Math.min(p.x, rx - 4); y = Math.min(p.y, ry - 4); w = rx - x; h = ry - y; }
          else if (d.corner === 1) { y = Math.min(p.y, ry - 4); w = Math.max(4, p.x - o.x); h = ry - y; }
          else if (d.corner === 2) { x = Math.min(p.x, rx - 4); w = rx - x; h = Math.max(4, p.y - o.y); }
          else { w = Math.max(4, p.x - o.x); h = Math.max(4, p.y - o.y); }
          next[d.idx] = { x, y, w, h };
        }
        return next;
      });
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.mode === "draw") {
        setRegions((rs) => {
          let last = rs[rs.length - 1];
          if (last && (last.w < 6 || last.h < 6)) return rs.slice(0, -1); // discard tiny
          const next = rs.slice();
          if (autoSnap && last) { last = snap(last); next[next.length - 1] = last; } // autocrop to content
          setSel(next.length - 1);
          return next;
        });
      }
      force((n) => n + 1);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [sc, srcDims.w, srcDims.h, autoSnap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel != null) { setRegions((rs) => rs.filter((_, i) => i !== sel)); setSel(null); }
      } else if (e.key === "Escape") onClose();
      else if (e.key === "s" || e.key === "S") {
        if (sel != null) { e.preventDefault(); setRegions((rs) => rs.map((r, i) => (i === sel ? snap(r) : r))); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, onClose]);

  const onStageDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = toSrc(e.clientX, e.clientY);
    // hit-test a corner handle of the selected region first
    if (sel != null) {
      const r = regions[sel];
      const corners = [
        { c: 0, x: r.x, y: r.y }, { c: 1, x: r.x + r.w, y: r.y },
        { c: 2, x: r.x, y: r.y + r.h }, { c: 3, x: r.x + r.w, y: r.y + r.h },
      ];
      for (const cc of corners) {
        if (Math.abs(p.x - cc.x) * sc < HANDLE && Math.abs(p.y - cc.y) * sc < HANDLE) {
          dragRef.current = { mode: "resize", idx: sel, corner: cc.c, orig: r };
          return;
        }
      }
    }
    // hit-test region bodies (topmost first)
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        setSel(i);
        dragRef.current = { mode: "move", idx: i, sx: p.x, sy: p.y, orig: r };
        return;
      }
    }
    // else start drawing a new region
    setRegions((rs) => [...rs, { x: p.x, y: p.y, w: 0, h: 0 }]);
    dragRef.current = { mode: "draw", sx: p.x, sy: p.y };
  };

  const onImportSource = async (file: File) => {
    setBusy(true);
    try {
      const { dataUrl, w, h } = await readImage(file);
      const ext = (file.name.split(".").pop() ?? "png").toLowerCase();
      const filename = `_source.${ext}`;
      const ok = await writeAssetFromDataURL(tilesetImagePath({ ...tileset, imageFile: filename }), dataUrl);
      if (!ok) { console.warn("manual builder: no AssetStore open"); return; }
      updateTileset(tileset.id, { manualSourceFile: filename });
      setSrcDims({ w, h });
      setRegions([]); setSel(null);
    } finally { setBusy(false); }
  };

  const updateSel = (patch: Partial<Region>) => {
    if (sel == null) return;
    setRegions((rs) => rs.map((r, i) => (i === sel ? { ...r, ...patch } : r)));
  };

  const autoGrid = () => {
    if (srcDims.w === 0) return;
    const cw = srcDims.w / seedCols, ch = srcDims.h / seedRows;
    const rs: Region[] = [];
    for (let r = 0; r < seedRows; r++)
      for (let c = 0; c < seedCols; c++)
        rs.push({ x: c * cw, y: r * ch, w: cw, h: ch });
    setRegions(rs); setSel(null);
  };

  const bake = async () => {
    if (!srcUrl || regions.length === 0) return;
    const nBig = tileset.bigTiles?.length ?? 0;
    const nAnim = tileset.animatedTiles?.length ?? 0;
    if (nBig + nAnim > 0) {
      const parts = [nBig && `${nBig} BigTile${nBig > 1 ? "s" : ""}`, nAnim && `${nAnim} animated tile${nAnim > 1 ? "s" : ""}`].filter(Boolean).join(" and ");
      if (!window.confirm(`Re-baking rebuilds the grid and will remove ${parts} that reference the old layout. Continue?`)) return;
    }
    setBusy(true);
    try {
      const img = await loadImg(srcUrl);
      const valid = regions.filter((r) => r.w >= 1 && r.h >= 1);
      if (valid.length === 0) { console.warn("manual builder: no valid regions"); return; }
      // Grid cell = the biggest box's chosen size. Each box draws at its OWN
      // size, top-left in its cell — smaller tiles just leave transparent room.
      const cellW = Math.max(...valid.map(bakeW));
      const cellH = Math.max(...valid.map(bakeH));
      const n = valid.length;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const W = cols * cellW + (cols - 1) * gap;
      const H = rows * cellH + (rows - 1) * gap;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d")!;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      valid.forEach((r, i) => {
        const tw = bakeW(r), th = bakeH(r);
        const gx = (i % cols) * (cellW + gap);
        const gy = Math.floor(i / cols) * (cellH + gap);
        if (fit === "snap") {
          ctx.drawImage(img, r.x, r.y, r.w, r.h, gx, gy, tw, th);
        } else {
          const s = Math.min(tw / r.w, th / r.h);
          const dw = r.w * s, dh = r.h * s;
          ctx.drawImage(img, r.x, r.y, r.w, r.h, gx + (tw - dw) / 2, gy + (th - dh) / 2, dw, dh);
        }
      });
      const dataUrl = cv.toDataURL("image/png");
      const ok = await writeAssetFromDataURL(tilesetImagePath({ ...tileset, imageFile: "tileset.png" }), dataUrl);
      if (!ok) { console.warn("manual builder: bake write failed"); return; }
      updateTileset(tileset.id, {
        imageFile: "tileset.png", sheetW: W, sheetH: H,
        tileW: cellW, tileH: cellH, spacingX: gap, spacingY: gap, offsetX: 0, offsetY: 0,
        cols, rows, manualRegions: valid, manualFit: fit,
        manualUniform: uniform, manualUniW: uniW, manualUniH: uniH,
        // Baking rebuilds the grid, so any BigTiles/animated tiles from a prior
        // bake point at cells that no longer exist — clear them. (Guarded by the
        // confirm above so the author isn't silently stripped of hand-made ones.)
        bigTiles: [], animatedTiles: [],
      });
      onClose();
    } finally { setBusy(false); }
  };

  const dispW = srcDims.w * sc, dispH = srcDims.h * sc;
  const selR = sel != null ? regions[sel] : null;
  const bg = lightBg ? "#cfcfcf" : "#111";

  return (
    <div
      style={{
        flex: 1, height: "100%", display: "flex", flexDirection: "column",
        padding: 12, gap: 10, background: "var(--panel-2)", overflow: "hidden",
      }}
    >
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", color: "var(--text)", fontSize: 12 }}>
        <b style={{ fontSize: 13 }}>Manual Tile Builder — {tileset.name}</b>
        <button style={BTN} disabled={busy} onClick={() => fileRef.current?.click()}>
          {tileset.manualSourceFile ? "Replace source…" : "Import source sheet…"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportSource(f); e.target.value = ""; }} />
        <Num label="Gap" v={gap} set={(n) => setGap(Math.max(0, n))} />
        <button style={{ ...BTN, ...(uniform ? SEL : {}) }} onClick={() => setUniform((v) => !v)}
          title="Uniform: bake every tile to ONE size. Off: each box keeps its own size (set in the preview).">
          {uniform ? "▦ Uniform: ON" : "▦ Uniform: OFF"}
        </button>
        {uniform && (
          <span style={{ display: "flex", gap: 4, alignItems: "center", padding: "2px 6px", border: "1px solid var(--accent, #3a7afe)", borderRadius: 4 }}>
            <span style={LBL}>All</span>
            <Num label="W" v={uniW} set={(n) => setUniW(Math.max(1, n))} />
            <Num label="H" v={uniH} set={(n) => setUniH(Math.max(1, n))} />
          </span>
        )}
        <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={LBL}>Scale</span>
          <button style={{ ...BTN, ...(fit === "snap" ? SEL : {}) }} onClick={() => setFit("snap")} title="Stretch each region to fill the cell — edges snap to the grid">Snap to grid</button>
          <button style={{ ...BTN, ...(fit === "free" ? SEL : {}) }} onClick={() => setFit("free")} title="Scale to fit keeping aspect — no distortion (transparent letterbox)">Free</button>
        </span>
        <button style={{ ...BTN, ...(autoSnap ? SEL : {}) }} onClick={() => setAutoSnap((v) => !v)} title="Auto-crop each drawn box to the tile's non-transparent pixels (needs a transparent-background sheet)">
          🧲 Auto-snap
        </button>
        <button style={BTN} disabled={sel == null} onClick={() => { if (sel != null) updateSel(snap(regions[sel])); }} title="Snap the selected box to its content now (shortcut: S)">Snap (S)</button>
        <button style={BTN} onClick={() => setLightBg((v) => !v)} title="Toggle light/dark background to see tile borders">
          {lightBg ? "◑ Dark BG" : "◐ Light BG"}
        </button>
        <span style={{ width: 1, height: 18, background: "var(--border)" }} />
        <span style={{ display: "flex", gap: 4, alignItems: "center" }} title="Drop an even N×M grid of boxes you can then nudge/resize — a quick start instead of drawing every box by hand.">
          <span style={LBL}>Seed grid</span>
          <Num label="Cols" v={seedCols} set={(n) => setSeedCols(Math.max(1, n))} />
          <Num label="Rows" v={seedRows} set={(n) => setSeedRows(Math.max(1, n))} />
          <button style={BTN} onClick={autoGrid}>Seed</button>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-dim)" }}>{regions.length} regions</span>
        <button style={BTN} disabled={sel == null} onClick={() => { if (sel != null) { setRegions((rs) => rs.filter((_, i) => i !== sel)); setSel(null); } }}>Delete</button>
        <button style={BTN} onClick={() => { setRegions([]); setSel(null); }}>Clear</button>
        <button style={{ ...BTN, background: "var(--accent, #3a7afe)", color: "#fff" }} disabled={busy || regions.length === 0} onClick={() => void bake()}>Bake → tileset</button>
        <button style={BTN} onClick={onClose}>Close</button>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        Draw a box around each tile (free — any size); click to select, drag to move, corner to resize, Delete to remove. Set each selected box's <b>Bake size</b> in the preview on the right — every box can be a different size. The grid cell sizes to the biggest box.
      </div>

      {/* stage (left) + live preview (right) */}
      <div ref={panesRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: 1, overflow: "auto", background: bg, border: "1px solid var(--border)", borderRadius: 4 }}>
          {!srcUrl ? (
            <div style={{ padding: 40, color: "var(--text-dim)", fontSize: 13 }}>Import a source sheet to begin.</div>
          ) : (
            <div
              ref={stageRef}
              onMouseDown={onStageDown}
              style={{ position: "relative", width: dispW, height: dispH, margin: 12, cursor: "crosshair", userSelect: "none" }}
            >
              <img src={srcUrl} draggable={false} style={{ position: "absolute", inset: 0, width: dispW, height: dispH, imageRendering: "pixelated" }} />
              {regions.map((r, i) => (
                <div key={i}
                  style={{
                    position: "absolute", left: r.x * sc, top: r.y * sc, width: r.w * sc, height: r.h * sc,
                    border: `2px solid ${i === sel ? "#ffd23c" : "rgba(80,200,255,0.9)"}`,
                    background: i === sel ? "rgba(255,210,60,0.12)" : "rgba(80,200,255,0.08)",
                    boxSizing: "border-box",
                  }}
                >
                  <span style={{ position: "absolute", top: -16, left: 0, fontSize: 10, color: "#ffd23c", background: "rgba(0,0,0,0.6)", padding: "0 3px" }}>{i + 1}</span>
                </div>
              ))}
              {selR && [[selR.x, selR.y], [selR.x + selR.w, selR.y], [selR.x, selR.y + selR.h], [selR.x + selR.w, selR.y + selR.h]].map(([hx, hy], k) => (
                <div key={k} style={{
                  position: "absolute", left: hx * sc - 5, top: hy * sc - 5, width: 10, height: 10,
                  background: "#ffd23c", border: "1px solid #000", borderRadius: 2,
                }} />
              ))}
            </div>
          )}
        </div>
        {/* draggable divider */}
        <div
          onMouseDown={(e) => { e.preventDefault(); resizeRef.current = true; }}
          title="Drag to resize the preview"
          style={{ width: 8, flexShrink: 0, cursor: "col-resize", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ width: 3, height: 40, background: "var(--border)", borderRadius: 2 }} />
        </div>
        {/* live preview of the SELECTED tile, large */}
        <div style={{ width: previewW, flexShrink: 0, overflow: "auto", background: bg, border: "1px solid var(--border)", borderRadius: 4, padding: 10 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
            {selR ? `Preview — tile #${(sel ?? 0) + 1} · ${fit === "snap" ? "stretched" : "fit"}` : "Select a tile to preview"}
          </div>
          {selR && (
            <>
              {/* Per-box bake size — only when NOT in uniform mode. */}
              {uniform ? (
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>
                  Uniform mode — every tile bakes to <b>{uniW}×{uniH}</b> (toolbar). Turn off Uniform for per-box sizes.
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, padding: "4px 6px", border: "1px solid var(--accent, #3a7afe)", borderRadius: 4 }}>
                  <span style={{ ...LBL, color: "var(--text)" }}>Bake size</span>
                  <Num label="W" v={bakeW(selR)} set={(n) => updateSel({ tw: Math.max(1, n) })} />
                  <span style={{ color: "var(--text-dim)" }}>×</span>
                  <Num label="H" v={bakeH(selR)} set={(n) => updateSel({ th: Math.max(1, n) })} />
                  <span style={LBL}>px</span>
                  {(selR.tw != null || selR.th != null) && (
                    <button style={{ ...BTN, padding: "1px 5px" }} title="Use the detected box size" onClick={() => updateSel({ tw: undefined, th: undefined })}>auto</button>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
                Detected box: {Math.round(selR.w)} × {Math.round(selR.h)} px (aspect {(selR.h > 0 ? selR.w / selR.h : 0).toFixed(2)})
              </div>
            </>
          )}
          <canvas ref={previewRef} style={{ width: "100%", height: "auto", imageRendering: "pixelated", background: lightBg ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.03)", border: "1px solid var(--border)" }} />
        </div>
      </div>
    </div>
  );
}

const BTN: React.CSSProperties = { fontSize: 11, cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", padding: "3px 8px" };
const SEL: React.CSSProperties = { background: "var(--accent, #3a7afe)", color: "#fff", borderColor: "transparent" };
const LBL: React.CSSProperties = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)" };

function Num({ label, v, set }: { label: string; v: number; set: (n: number) => void }) {
  // Buffer the raw text while focused so a clamp in `set` (e.g. Math.max(4, n))
  // can't rewrite the field mid-typing — that caused "type 1 → shows 4, then
  // type 128 → 428". We commit (and clamp) only on blur / Enter.
  const [buf, setBuf] = useState(String(v));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setBuf(String(v)); }, [v, editing]);
  const commit = () => {
    setEditing(false);
    const n = parseInt(buf, 10);
    if (!Number.isNaN(n)) set(n);
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={LBL}>{label}</span>
      <input
        type="number"
        value={editing ? buf : String(v)}
        onFocus={() => { setEditing(true); setBuf(String(v)); }}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          else if (e.key === "Escape") { setBuf(String(v)); setEditing(false); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        style={{ width: 56, fontSize: 12, padding: "2px 4px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 3, color: "var(--text)" }}
      />
    </label>
  );
}
