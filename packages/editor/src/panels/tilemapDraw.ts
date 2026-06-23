/**
 * Shared canvas-draw helper for tilemap previews.
 *
 * The painter and the scene-editor preview both used to render per-cell divs,
 * which froze at 256+ cells (React reconciliation × many absolutely-positioned
 * elements). One <canvas> + drawImage scales to thousands of cells with no
 * issue — modern browsers can blit tens of thousands of tiles per frame.
 *
 * Pure functions: caller owns the canvas + the loaded HTMLImageElements, these
 * just paint. Resizes the canvas to the requested pixel dims so the caller
 * doesn't have to wire that separately each render.
 *
 * Multi-tileset: painted cells hold GLOBAL tile ids. The caller passes an
 * ordered `TileSlot[]` (one per tileset, each with its firstgid) and a cell's
 * id is resolved to its owning slot + local index here. Source pixels come
 * from the slot's own tile size; they're drawn into the map's cell size, so a
 * tileset whose tiles differ in size from the map cell is scaled to fit.
 */
export interface TileMapData {
  tiles: number[];
  cols: number;
  rows: number;
  /** Sparse per-cell transform (packed: bit0 flipX, bit1 flipY, bits2-3 rot). */
  xf?: Record<number, number>;
}

export interface TileSetData {
  tileW: number;
  tileH: number;
  offsetX: number;
  offsetY: number;
  spacingX: number;
  spacingY: number;
  cols: number;
  solidTiles?: number[];
}

/** One tileset in a map's ordered list, with the global-id range it owns. */
export interface TileSlot {
  tileset: TileSetData;
  img: HTMLImageElement | null;
  /** Global id of this tileset's first cell. */
  firstgid: number;
  /** cols*rows — ids [firstgid, firstgid+count) belong to this slot. */
  count: number;
}

export interface DrawOptions {
  /** Show 1px grid lines between cells. */
  gridLines?: boolean;
  /** Show a rect-tool overlay (start cell → current cell). */
  rectDrag?: { c0: number; r0: number; c1: number; r1: number } | null;
  /** Tint solid tiles red so the collision map is visible while painting. */
  showSolids?: boolean;
}

/** Map a global tile id to its owning slot + local index, or null for empty /
 *  out-of-range (e.g. a tileset removed from the map). Walks high→low so the
 *  first slot whose firstgid the id clears is the owner. */
function resolveSlot(slots: TileSlot[], g: number): { slot: TileSlot; local: number } | null {
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

/** Source rect of a local tile index within its tileset sheet. */
function srcRect(ts: TileSetData, local: number): { sx: number; sy: number } {
  const tc = ts.cols > 0 ? local % ts.cols : 0;
  const tr = ts.cols > 0 ? (local - tc) / ts.cols : 0;
  return {
    sx: ts.offsetX + tc * (ts.tileW + ts.spacingX),
    sy: ts.offsetY + tr * (ts.tileH + ts.spacingY),
  };
}

export function drawTilemap(
  canvas: HTMLCanvasElement,
  slots: TileSlot[],
  tilemap: TileMapData,
  mapTileW: number,
  mapTileH: number,
  zoom: number,
  opts: DrawOptions = {},
): void {
  const { cols, rows, tiles } = tilemap;
  const W = Math.max(1, Math.round(cols * mapTileW * zoom));
  const H = Math.max(1, Math.round(rows * mapTileH * zoom));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);

  // Subtle backing so empty cells stay visible against a dark editor bg.
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, W, H);

  // Tile blits. drawImage is the hot path — keep the inner loop tight.
  const dW = mapTileW * zoom;
  const dH = mapTileH * zoom;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const t = tiles[idx];
      if (t === undefined || t < 0) continue;
      const res = resolveSlot(slots, t);
      if (!res) continue;
      const img = res.slot.img;
      if (!img || !img.complete || img.naturalWidth <= 0) continue;
      const ts = res.slot.tileset;
      const { sx, sy } = srcRect(ts, res.local);
      const xf = tilemap.xf?.[idx] ?? 0;
      if (xf === 0) {
        ctx.drawImage(img, sx, sy, ts.tileW, ts.tileH, c * dW, r * dH, dW, dH);
      } else {
        // Rotate (bits2-3 × 90° CW) then flip (bit0 X, bit1 Y), around the
        // cell center. Same order the runtime applies, so editor = game.
        const fx = (xf & 1) ? -1 : 1;
        const fy = (xf & 2) ? -1 : 1;
        const rot = ((xf >> 2) & 3) * Math.PI / 2;
        ctx.save();
        ctx.translate(c * dW + dW / 2, r * dH + dH / 2);
        ctx.rotate(rot);
        ctx.scale(fx, fy);
        ctx.drawImage(img, sx, sy, ts.tileW, ts.tileH, -dW / 2, -dH / 2, dW, dH);
        ctx.restore();
      }
    }
  }

  // Solid-tile overlay — red wash on cells whose painted tile is marked solid
  // in its OWNING tileset (solidTiles is per-tileset, in local indices).
  if (opts.showSolids !== false && slots.some((s) => s.tileset.solidTiles && s.tileset.solidTiles.length > 0)) {
    ctx.fillStyle = "rgba(255,80,80,0.28)";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = tiles[r * cols + c];
        if (t === undefined || t < 0) continue;
        const res = resolveSlot(slots, t);
        if (!res) continue;
        if (!res.slot.tileset.solidTiles?.includes(res.local)) continue;
        ctx.fillRect(c * dW, r * dH, dW, dH);
      }
    }
  }

  // Grid lines — only on demand (skipped in scene-editor preview where they
  // double the tile outlines from the underlying scene gizmo).
  if (opts.gridLines) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const x = Math.round(c * mapTileW * zoom) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let r = 0; r <= rows; r++) {
      const y = Math.round(r * mapTileH * zoom) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }

  // Rect-tool live overlay (painted after grid so it sits on top).
  const rd = opts.rectDrag;
  if (rd) {
    const c0 = Math.min(rd.c0, rd.c1);
    const r0 = Math.min(rd.r0, rd.r1);
    const c1 = Math.max(rd.c0, rd.c1);
    const r1 = Math.max(rd.r0, rd.r1);
    const x = c0 * mapTileW * zoom;
    const y = r0 * mapTileH * zoom;
    const w = (c1 - c0 + 1) * mapTileW * zoom;
    const h = (r1 - r0 + 1) * mapTileH * zoom;
    ctx.fillStyle = "rgba(255,210,60,0.18)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,210,60,0.95)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
}

/**
 * Load a tileset image to an HTMLImageElement. Returns a Promise that
 * resolves to `null` on failure (so callers don't need to wrap each call
 * in try/catch). Common pattern: useEffect → set img ref → trigger redraw.
 */
export function loadTilesetImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Paint one tilemap layer into an OFFSCREEN BUFFER canvas at native pixel
 * resolution (no zoom). On the first call (or whenever `prevTiles` is null
 * — meaning the buffer was just (re)sized) a full repaint runs. Subsequent
 * calls diff `tiles` against `prevTiles` and update ONLY the changed cells.
 *
 * Pairing this with a "blit once per visible-canvas update" rendering loop
 * decouples redraw cost from map size: a brush stamp of N cells costs O(N)
 * buffer updates + 1 blit, regardless of total cell count. Without it a
 * thousand-tile map re-blits a thousand drawImage calls EVERY mouse move.
 *
 * The buffer should be sized `cols*mapTileW × rows*mapTileH` by the caller
 * before the first call; we don't resize here so callers stay in control of
 * when a resize invalidates `prevTiles`.
 */
/** Blit one global tile id at its native resolution, applying the packed
 *  transform `xf` (bit0 flipX, bit1 flipY, bits2-3 rotation × 90° CW) around
 *  the cell center. Rotate-then-flip — the same order the runtime uses. */
function blitCell(
  ctx: CanvasRenderingContext2D, slots: TileSlot[],
  mapTileW: number, mapTileH: number, c: number, r: number, t: number, xf: number,
): void {
  const res = resolveSlot(slots, t);
  if (!res) return;
  const img = res.slot.img;
  if (!img || !img.complete || img.naturalWidth <= 0) return;
  const ts = res.slot.tileset;
  const { sx, sy } = srcRect(ts, res.local);
  const dx = c * mapTileW, dy = r * mapTileH;
  if (xf === 0) {
    ctx.drawImage(img, sx, sy, ts.tileW, ts.tileH, dx, dy, mapTileW, mapTileH);
    return;
  }
  ctx.save();
  ctx.translate(dx + mapTileW / 2, dy + mapTileH / 2);
  ctx.rotate(((xf >> 2) & 3) * Math.PI / 2);
  ctx.scale((xf & 1) ? -1 : 1, (xf & 2) ? -1 : 1);
  ctx.drawImage(img, sx, sy, ts.tileW, ts.tileH, -mapTileW / 2, -mapTileH / 2, mapTileW, mapTileH);
  ctx.restore();
}

export function paintLayerBuffer(
  buf: HTMLCanvasElement,
  slots: TileSlot[],
  tiles: number[],
  prevTiles: number[] | null,
  cols: number,
  rows: number,
  mapTileW: number,
  mapTileH: number,
  xf?: Record<number, number>,
  prevXf?: Record<number, number>,
): void {
  const ctx = buf.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const xfAt = (i: number) => xf?.[i] ?? 0;
  // "Ready" once at least one slot image has decoded — a delta that touches a
  // not-yet-loaded slot's cell simply skips that cell until its image lands.
  const anyReady = slots.some((s) => s.img && s.img.complete && s.img.naturalWidth > 0);

  if (!prevTiles || prevTiles.length !== tiles.length) {
    // Full repaint (first run, dims changed, or image newly loaded).
    ctx.clearRect(0, 0, buf.width, buf.height);
    if (!anyReady) return;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t === undefined || t < 0) continue;
      const c = i % cols;
      blitCell(ctx, slots, mapTileW, mapTileH, c, (i - c) / cols, t, xfAt(i));
    }
    return;
  }
  // Delta — redraw cells whose tile index OR transform changed since last paint.
  if (!anyReady) return;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === prevTiles[i] && xfAt(i) === (prevXf?.[i] ?? 0)) continue;
    const c = i % cols;
    const r = (i - c) / cols;
    ctx.clearRect(c * mapTileW, r * mapTileH, mapTileW, mapTileH);
    const t = tiles[i];
    if (t === undefined || t < 0) continue;
    blitCell(ctx, slots, mapTileW, mapTileH, c, r, t, xfAt(i));
  }
}
