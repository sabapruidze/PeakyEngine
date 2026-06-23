import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { useAssetURL } from "../useAssetURL";
import { writeAssetFromDataURL, tilesetImagePath } from "../AssetStore";
import type { TilesetAsset } from "../project";

/**
 * Tileset Pixel Mover — select a FREE rectangle of the tileset sheet and drag
 * those pixels to a new position (cut + paste: the original spot is cleared).
 * For nudging an object up/down inside its cell so its bottom sits on a line.
 *
 * A draggable horizontal BASELINE guide is shown; while moving a selection its
 * BOTTOM edge snaps to the line when close. Arrow keys nudge 1px (Shift = 10px).
 * Edits live on an in-memory copy of the sheet — "Save" writes the image,
 * "Reset" reloads the original. (Pixel edits aren't in the project undo, so
 * Reset is the undo here.)
 */
const loadImg = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });

type Float = { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number };
type Drag =
  | { mode: "select"; sx: number; sy: number }
  | { mode: "move"; startX: number; startY: number; origX: number; origY: number }
  | { mode: "baseline" };

const SNAP = 6; // px — selection-bottom → baseline snap distance

export function TilesetPixelMover({ tileset, zoom, onClose }: { tileset: TilesetAsset; zoom: number; onClose: () => void }) {
  const updateTileset = useEditor((s) => s.updateTileset);
  const srcUrl = useAssetURL(tileset.imageFile ? tilesetImagePath(tileset) : undefined);

  const baseRef = useRef<HTMLCanvasElement | null>(null);  // the editable sheet copy
  const floatRef = useRef<Float | null>(null);             // currently lifted selection
  const dispRef = useRef<HTMLCanvasElement>(null);          // visible canvas
  const dragRef = useRef<Drag | null>(null);
  const pendRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null); // live select rect

  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [baseline, setBaseline] = useState<number | null>(null);
  const [lightBg, setLightBg] = useState(false);
  const [, force] = useState(0);
  const redraw = () => force((n) => n + 1);

  // Load the sheet into an editable base canvas.
  useEffect(() => {
    if (!srcUrl) return;
    let alive = true;
    void loadImg(srcUrl).then((im) => {
      if (!alive) return;
      // Extend the editable canvas to cover the GRID, so pixels can be moved
      // into rows/cols added in the tileset editor (and the save keeps them).
      const gW = tileset.offsetX + tileset.cols * (tileset.tileW + tileset.spacingX) - (tileset.cols > 0 ? tileset.spacingX : 0);
      const gH = tileset.offsetY + tileset.rows * (tileset.tileH + tileset.spacingY) - (tileset.rows > 0 ? tileset.spacingY : 0);
      const bw = Math.max(im.width, Math.ceil(gW));
      const bh = Math.max(im.height, Math.ceil(gH));
      const base = document.createElement("canvas");
      base.width = bw; base.height = bh;
      base.getContext("2d")!.drawImage(im, 0, 0);
      baseRef.current = base;
      floatRef.current = null;
      pendRef.current = null;
      setDims({ w: bw, h: bh });
      setBaseline((b) => (b == null ? Math.round(bh * 0.7) : b));
      redraw();
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcUrl]);

  // Grow the editable canvas when the grid grows (e.g. you press + row while
  // the mover is open) — preserving existing pixels so edits aren't lost.
  useEffect(() => {
    const base = baseRef.current;
    if (!base) return;
    const gW = tileset.offsetX + tileset.cols * (tileset.tileW + tileset.spacingX) - (tileset.cols > 0 ? tileset.spacingX : 0);
    const gH = tileset.offsetY + tileset.rows * (tileset.tileH + tileset.spacingY) - (tileset.rows > 0 ? tileset.spacingY : 0);
    const bw = Math.max(base.width, Math.ceil(gW));
    const bh = Math.max(base.height, Math.ceil(gH));
    if (bw > base.width || bh > base.height) {
      const grown = document.createElement("canvas");
      grown.width = bw; grown.height = bh;
      grown.getContext("2d")!.drawImage(base, 0, 0);
      baseRef.current = grown;
      setDims({ w: bw, h: bh });
      redraw();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileset.cols, tileset.rows, tileset.tileW, tileset.tileH, tileset.offsetX, tileset.offsetY, tileset.spacingX, tileset.spacingY]);

  // Composite the floating selection back into the base (drops it where it is).
  // If the selection was pushed past the right/bottom edge, grow the base canvas
  // to fit it first — otherwise drawImage would clip the off-canvas pixels and
  // the moved tile would be cropped. (Top/left overflow can't grow without
  // shifting the origin and breaking grid alignment, so those clamp to 0.)
  const commitFloat = () => {
    const base = baseRef.current, fl = floatRef.current;
    if (!base || !fl) return;
    // Draw at the float's EXACT position so where it's shown is where it lands.
    // Grow only the right/bottom edge for positive overflow (the editor's grid
    // grows that way too); a selection pushed past the top/left simply clips —
    // growing there would shift the origin and desync the grid.
    const needW = Math.max(base.width, Math.ceil(fl.x + fl.w));
    const needH = Math.max(base.height, Math.ceil(fl.y + fl.h));
    if (needW > base.width || needH > base.height) {
      const grown = document.createElement("canvas");
      grown.width = needW; grown.height = needH;
      const g = grown.getContext("2d")!;
      g.drawImage(base, 0, 0);
      g.drawImage(fl.canvas, fl.x, fl.y);
      baseRef.current = grown;
      setDims({ w: needW, h: needH });
    } else {
      base.getContext("2d")!.drawImage(fl.canvas, fl.x, fl.y);
    }
    floatRef.current = null;
  };

  // Render base + floating selection + overlays into the visible canvas.
  useEffect(() => {
    const cv = dispRef.current, base = baseRef.current;
    if (!cv) return;
    // Cover BOTH the image AND the grid so extended rows/cols (added in the
    // tileset editor) show their cells here too, not clipped at the image edge.
    const { tileW, tileH, offsetX, offsetY, spacingX, spacingY, cols, rows } = tileset;
    const gridW = offsetX + cols * (tileW + spacingX) - (cols > 0 ? spacingX : 0);
    const gridH = offsetY + rows * (tileH + spacingY) - (rows > 0 ? spacingY : 0);
    const imgW = Math.round(dims.w * zoom);
    const imgH = Math.round(dims.h * zoom);
    const W = Math.max(1, Math.round(Math.max(dims.w, gridW) * zoom));
    const H = Math.max(1, Math.round(Math.max(dims.h, gridH) * zoom));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    // Faint backing on the extended (beyond-image) area so the extra cells read.
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, W, H);
    // Draw the sheet at NATURAL size (not stretched into the extended canvas).
    if (base) ctx.drawImage(base, 0, 0, imgW, imgH);
    // Grid overlay — same cells as the main tileset preview, so you can align an
    // object's bottom to a cell line.
    if (tileW > 0 && tileH > 0 && cols > 0 && rows > 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
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
    }
    const fl = floatRef.current;
    if (fl) {
      ctx.drawImage(fl.canvas, fl.x * zoom, fl.y * zoom, fl.w * zoom, fl.h * zoom);
      ctx.strokeStyle = "#ffd23c"; ctx.lineWidth = 2;
      ctx.strokeRect(fl.x * zoom + 1, fl.y * zoom + 1, fl.w * zoom - 2, fl.h * zoom - 2);
    }
    const pend = pendRef.current;
    if (pend) {
      ctx.strokeStyle = "rgba(80,200,255,0.95)"; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(pend.x * zoom + 0.5, pend.y * zoom + 0.5, pend.w * zoom, pend.h * zoom);
      ctx.setLineDash([]);
    }
    if (baseline != null) {
      const y = baseline * zoom + 0.5;
      ctx.strokeStyle = "rgba(60,200,255,0.95)"; ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.setLineDash([]);
      // grab handle on the right
      ctx.fillStyle = "rgba(60,200,255,0.95)";
      ctx.fillRect(W - 14, y - 5, 12, 10);
    }
  });

  const toImg = (clientX: number, clientY: number) => {
    const r = dispRef.current!.getBoundingClientRect();
    return { x: Math.round((clientX - r.left) / zoom), y: Math.round((clientY - r.top) / zoom) };
  };

  const snapToBaseline = (fl: Float) => {
    if (baseline == null) return;
    if (Math.abs((fl.y + fl.h) - baseline) <= SNAP) fl.y = baseline - fl.h;
  };

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = toImg(e.clientX, e.clientY);
    const fl = floatRef.current;
    // 1) grab the baseline if clicked near it (and not on a float)
    if (baseline != null && Math.abs(p.y - baseline) * zoom < 6 && !(fl && p.x >= fl.x && p.x <= fl.x + fl.w && p.y >= fl.y && p.y <= fl.y + fl.h)) {
      dragRef.current = { mode: "baseline" };
      return;
    }
    // 2) move the floating selection if clicked inside it
    if (fl && p.x >= fl.x && p.x <= fl.x + fl.w && p.y >= fl.y && p.y <= fl.y + fl.h) {
      dragRef.current = { mode: "move", startX: p.x, startY: p.y, origX: fl.x, origY: fl.y };
      return;
    }
    // 3) otherwise drop any current float and start a fresh selection
    commitFloat();
    pendRef.current = { x: p.x, y: p.y, w: 0, h: 0 };
    dragRef.current = { mode: "select", sx: p.x, sy: p.y };
    redraw();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = toImg(e.clientX, e.clientY);
      if (d.mode === "baseline") {
        setBaseline(Math.max(0, Math.min(dims.h, p.y)));
        return;
      }
      if (d.mode === "select") {
        pendRef.current = { x: Math.min(d.sx, p.x), y: Math.min(d.sy, p.y), w: Math.abs(p.x - d.sx), h: Math.abs(p.y - d.sy) };
        redraw();
        return;
      }
      // move
      const fl = floatRef.current;
      if (!fl) return;
      fl.x = d.origX + (p.x - d.startX);
      fl.y = d.origY + (p.y - d.startY);
      snapToBaseline(fl);
      redraw();
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.mode === "select") {
        const pend = pendRef.current; pendRef.current = null;
        const base = baseRef.current;
        if (base && pend && pend.w >= 3 && pend.h >= 3) {
          // Cut the rect into a floating canvas; clear it on the base.
          const fc = document.createElement("canvas"); fc.width = pend.w; fc.height = pend.h;
          fc.getContext("2d")!.drawImage(base, pend.x, pend.y, pend.w, pend.h, 0, 0, pend.w, pend.h);
          base.getContext("2d")!.clearRect(pend.x, pend.y, pend.w, pend.h);
          floatRef.current = { canvas: fc, x: pend.x, y: pend.y, w: pend.w, h: pend.h };
        }
        redraw();
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, dims.h, baseline]);

  // Arrow-key nudge of the floating selection (Shift = 10px). Enter drops it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape") { onClose(); return; }
      const fl = floatRef.current;
      if (!fl) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowUp") fl.y -= step;
      else if (e.key === "ArrowDown") fl.y += step;
      else if (e.key === "ArrowLeft") fl.x -= step;
      else if (e.key === "ArrowRight") fl.x += step;
      else if (e.key === "Enter") { commitFloat(); redraw(); return; }
      else return;
      e.preventDefault();
      snapToBaseline(fl);
      redraw();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, onClose]);

  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!baseRef.current) return;
    setBusy(true);
    try {
      commitFloat();
      redraw();
      // Re-read AFTER commit — commitFloat may have replaced baseRef with a
      // grown canvas; the pre-commit reference would write the stale image.
      const base = baseRef.current;
      const ok = await writeAssetFromDataURL(tilesetImagePath(tileset), base.toDataURL("image/png"));
      if (!ok) { console.warn("pixel mover: save failed"); return; }
      // The canvas may have grown past the original sheet (rows/cols added) —
      // keep the tileset's recorded sheet size in sync so the grid still matches.
      if (base.width !== tileset.sheetW || base.height !== tileset.sheetH) {
        updateTileset(tileset.id, { sheetW: base.width, sheetH: base.height });
      }
      onClose();
    } finally { setBusy(false); }
  };

  const reset = () => {
    if (!srcUrl) return;
    void loadImg(srcUrl).then((im) => {
      const gW = tileset.offsetX + tileset.cols * (tileset.tileW + tileset.spacingX) - (tileset.cols > 0 ? tileset.spacingX : 0);
      const gH = tileset.offsetY + tileset.rows * (tileset.tileH + tileset.spacingY) - (tileset.rows > 0 ? tileset.spacingY : 0);
      const bw = Math.max(im.width, Math.ceil(gW));
      const bh = Math.max(im.height, Math.ceil(gH));
      const base = document.createElement("canvas");
      base.width = bw; base.height = bh;
      base.getContext("2d")!.drawImage(im, 0, 0);
      baseRef.current = base; floatRef.current = null; pendRef.current = null;
      setDims({ w: bw, h: bh });
      redraw();
    });
  };

  const bg = lightBg ? "#cfcfcf" : "#111";
  const fl = floatRef.current;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Sticky toolbar so it stays put while the (possibly tall) sheet scrolls. */}
      <div style={{ position: "sticky", top: 0, zIndex: 5, background: "#0d0e12", paddingBottom: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", color: "var(--text)", fontSize: 12 }}>
        <b style={{ fontSize: 13 }}>✥ Move pixels</b>
        <button style={{ ...BTN, ...(baseline != null ? SEL : {}) }} onClick={() => setBaseline((b) => (b == null ? Math.round(dims.h * 0.7) : null))}
          title="Toggle the horizontal baseline guide. Drag it to position; a selection's bottom snaps to it.">⎯ Baseline {baseline != null ? "on" : "off"}</button>
        <button style={BTN} onClick={() => setLightBg((v) => !v)} title="Toggle light/dark background to see edges">{lightBg ? "◑ Dark BG" : "◐ Light BG"}</button>
        <span style={{ flex: 1 }} />
        {fl && <span style={{ color: "var(--text-dim)" }}>moving {fl.w}×{fl.h} @ {fl.x},{fl.y}</span>}
        <button style={BTN} onClick={reset} disabled={busy}>Reset</button>
        <button style={{ ...BTN, background: "var(--accent, #3a7afe)", color: "#fff" }} onClick={() => void save()} disabled={busy}>Save image</button>
        <button style={BTN} onClick={onClose}>Close</button>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        Drag a box around an object → it lifts (the original spot clears). Drag it to reposition; its bottom <b>snaps to the baseline</b>. Arrow keys nudge 1px (Shift 10). Enter drops it. Zoom with the slider on the left. <b>Save image</b> writes the sheet; <b>Reset</b> reverts.
      </div>

      <div style={{ background: bg, border: "1px solid var(--border)", borderRadius: 4, padding: 8, display: "inline-block" }}>
        {!srcUrl ? (
          <div style={{ padding: 40, color: "var(--text-dim)", fontSize: 13 }}>This tileset has no image.</div>
        ) : (
          <canvas
            ref={dispRef}
            onMouseDown={onDown}
            style={{ display: "block", cursor: fl ? "move" : "crosshair", imageRendering: "pixelated", outline: "1px solid var(--border)" }}
          />
        )}
      </div>
    </div>
  );
}

const BTN: React.CSSProperties = { fontSize: 11, cursor: "pointer", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", padding: "3px 8px" };
const SEL: React.CSSProperties = { background: "var(--accent, #3a7afe)", color: "#fff", borderColor: "transparent" };
