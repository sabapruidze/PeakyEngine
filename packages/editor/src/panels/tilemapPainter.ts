/**
 * Pure paint helpers shared between the dedicated TilemapTab painter and
 * the SceneEditor's in-scene paint mode. No React state lives here — these
 * are stateless functions that compute store edits for the current input,
 * so they're trivially testable AND can be reused without dragging in any
 * component coupling.
 */

export type Tool = "brush" | "erase" | "bucket" | "rect" | "picker";

/**
 * Transform a `selW × selH` brush selection as ONE block by the packed brush
 * transform `xf` (bit0 flipX, bit1 flipY, bits2-3 rotation × 90° CW). Returns
 * the output footprint plus, for every output cell, which SOURCE selection cell
 * (sc, sr) lands there. The caller applies `xf` to each placed tile too, so the
 * group AND each tile flip/rotate together — not each cell independently.
 */
export function transformedSelection(
  selW: number, selH: number, xf: number,
): { outW: number; outH: number; cells: { ox: number; oy: number; sc: number; sr: number }[] } {
  const fx = (xf & 1) !== 0;
  const fy = (xf & 2) !== 0;
  const rot = (xf >> 2) & 3;
  const cells: { ox: number; oy: number; sc: number; sr: number }[] = [];
  for (let sr = 0; sr < selH; sr++) {
    for (let sc = 0; sc < selW; sc++) {
      let x = sc, y = sr, w = selW, h = selH;
      // Rotate the position 90° CW `rot` times (dims swap each quarter turn).
      for (let k = 0; k < rot; k++) {
        const nx = h - 1 - y, ny = x;
        x = nx; y = ny;
        const t = w; w = h; h = t;
      }
      if (fx) x = w - 1 - x;
      if (fy) y = h - 1 - y;
      cells.push({ ox: x, oy: y, sc, sr });
    }
  }
  return { outW: rot % 2 === 1 ? selH : selW, outH: rot % 2 === 1 ? selW : selH, cells };
}

export type RectDrag = { c0: number; r0: number; c1: number; r1: number };

export interface TileEdit {
  col: number;
  row: number;
  tile: number;
}

/**
 * Bresenham line — every grid cell between (c0,r0) and (c1,r1) inclusive.
 * Fast drags fire mousemove events sparsely (browsers throttle), so one-shot
 * "paint at the current cell" leaves gaps. Interpolating every cell on the
 * line between the previous and current cursor closes those gaps so the
 * brush stroke reads continuous regardless of drag speed.
 */
export function lineCells(c0: number, r0: number, c1: number, r1: number): { col: number; row: number }[] {
  const cells: { col: number; row: number }[] = [];
  const dc = Math.abs(c1 - c0), sc = c0 < c1 ? 1 : -1;
  const dr = Math.abs(r1 - r0), sr = r0 < r1 ? 1 : -1;
  let err = dc - dr;
  let c = c0, r = r0;
  // 100k cap so a corrupt input can't lock the editor — Bresenham terminates
  // in <max(dc, dr) iterations for valid coords.
  for (let safety = 0; safety < 100000; safety++) {
    cells.push({ col: c, row: r });
    if (c === c1 && r === r1) break;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 < dc) { err += dc; r += sr; }
  }
  return cells;
}

/**
 * Stamp a multi-tile brush selection at (col, row), anchor at top-left.
 * Returns the resulting `paintTiles` edits — caller decides which layer to
 * apply them to (callers in v1 always apply to the active layer).
 *
 * `selection` is in palette space (tile-index coords); each cell of the
 * selection maps to a target cell on the map relative to (col, row).
 */
export function brushEdits(
  col: number, row: number,
  selection: RectDrag,
  tilesetCols: number,
  mapCols: number, mapRows: number,
  firstgid = 0,
): TileEdit[] {
  if (tilesetCols <= 0) return [];
  const sC0 = Math.min(selection.c0, selection.c1);
  const sR0 = Math.min(selection.r0, selection.r1);
  const sW = Math.abs(selection.c1 - selection.c0) + 1;
  const sH = Math.abs(selection.r1 - selection.r0) + 1;
  const out: TileEdit[] = [];
  for (let dr = 0; dr < sH; dr++) {
    for (let dc = 0; dc < sW; dc++) {
      const tCol = col + dc, tRow = row + dr;
      if (tCol < 0 || tCol >= mapCols || tRow < 0 || tRow >= mapRows) continue;
      // Local palette index → GLOBAL id by adding the active tileset's firstgid.
      const tile = firstgid + (sR0 + dr) * tilesetCols + (sC0 + dc);
      out.push({ col: tCol, row: tRow, tile });
    }
  }
  return out;
}

/**
 * Tile the brush selection across the rect drag — a 2×2 brush over a 6×4
 * rect lays a repeating 2×2 pattern. A 1×1 brush degenerates to the legacy
 * solid-fill behavior, which is what most users expect from "rect tool."
 */
export function rectEdits(
  rd: RectDrag,
  selection: RectDrag,
  tilesetCols: number,
  firstgid = 0,
): TileEdit[] {
  if (tilesetCols <= 0) return [];
  const cMin = Math.min(rd.c0, rd.c1), cMax = Math.max(rd.c0, rd.c1);
  const rMin = Math.min(rd.r0, rd.r1), rMax = Math.max(rd.r0, rd.r1);
  const sC0 = Math.min(selection.c0, selection.c1);
  const sR0 = Math.min(selection.r0, selection.r1);
  const sW = Math.abs(selection.c1 - selection.c0) + 1;
  const sH = Math.abs(selection.r1 - selection.r0) + 1;
  const out: TileEdit[] = [];
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const dc = (c - cMin) % sW;
      const dr = (r - rMin) % sH;
      const tile = firstgid + (sR0 + dr) * tilesetCols + (sC0 + dc);
      out.push({ col: c, row: r, tile });
    }
  }
  return out;
}

/**
 * 4-way flood-fill on a single layer's `tiles` starting at (col, row), using
 * iterative stack so big regions don't blow the call stack. Returns the diff
 * edits (cells that actually changed) so the caller can collapse to one
 * `paintTiles` history entry.
 */
export function bucketEdits(
  tiles: number[],
  cols: number, rows: number,
  col: number, row: number,
  fill: number,
): TileEdit[] {
  const i0 = row * cols + col;
  const target = tiles[i0] ?? -1;
  if (target === fill) return [];
  const next = tiles.slice();
  const stack: number[] = [col, row];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const r = stack.pop()!;
    const c = stack.pop()!;
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const i = r * cols + c;
    if (visited.has(i)) continue;
    visited.add(i);
    if ((next[i] ?? -1) !== target) continue;
    next[i] = fill;
    stack.push(c + 1, r); stack.push(c - 1, r);
    stack.push(c, r + 1); stack.push(c, r - 1);
  }
  const out: TileEdit[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (next[i] !== tiles[i]) out.push({ col: c, row: r, tile: next[i] });
    }
  }
  return out;
}

/** Resolve "pick a tile" → a 1×1 brush selection on the picked palette cell.
 *  `tile` is a GLOBAL id; `firstgid` is the owning tileset's offset (0 for the
 *  primary), so the selection lands on the right cell within that tileset's
 *  palette. The caller is responsible for switching the active palette to the
 *  owning tileset before applying this selection. */
export function pickerSelection(tile: number, tilesetCols: number, firstgid = 0): RectDrag | null {
  if (tile < 0 || tilesetCols <= 0) return null;
  const local = tile - firstgid;
  if (local < 0) return null;
  const c = local % tilesetCols;
  const r = (local - c) / tilesetCols;
  return { c0: c, r0: r, c1: c, r1: r };
}
