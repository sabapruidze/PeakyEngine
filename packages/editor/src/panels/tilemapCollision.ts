/**
 * Pure tilemap collision math — polygon → axis-aligned rectangles, plus
 * cross-cell greedy merging. Lives in `editor/` because both the editor's
 * scene-preview overlay and the runtime's TilemapRenderer (via dedicated
 * runtime copy) consume this. Pure functions, no React, no Phaser.
 */

export interface PolygonShape { points: { x: number; y: number }[]; }
export interface AxisRect { x: number; y: number; w: number; h: number; }

/**
 * Decompose a polygon into axis-aligned rectangles via scanline. For each
 * integer Y row of the tile, compute horizontal spans at Y+0.5 using the
 * even-odd fill rule. Then vertically merge rows whose spans match exactly.
 * Returns rectangles with coords RELATIVE TO the tile cell (0..tileW × 0..tileH).
 */
export function polygonToRects(points: { x: number; y: number }[], tileW: number, tileH: number): AxisRect[] {
  if (points.length < 3) return [];
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
  const out: AxisRect[] = [];
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
 * Build the full world-space rectangle set for a tilemap layer's collision.
 * Scans every cell, decomposes its tile's polygon (cached per tile index),
 * and accumulates world-positioned rectangles. The cell's origin is
 * `(layerLeft + c*tileW, layerTop + r*tileH)`.
 */
export function buildLayerCollisionRects(
  tiles: number[], cols: number, rows: number,
  tileW: number, tileH: number,
  layerLeft: number, layerTop: number,
  customColliderIndices: Set<number>,
  tileColliders: Record<string, PolygonShape>,
): AxisRect[] {
  const cache = new Map<number, AxisRect[]>();
  const out: AxisRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r * cols + c];
      if (!customColliderIndices.has(t)) continue;
      let rects = cache.get(t);
      if (!rects) {
        const poly = tileColliders[String(t)];
        rects = poly ? polygonToRects(poly.points, tileW, tileH) : [];
        cache.set(t, rects);
      }
      const cx = layerLeft + c * tileW;
      const cy = layerTop + r * tileH;
      for (const rect of rects) {
        out.push({ x: cx + rect.x, y: cy + rect.y, w: rect.w, h: rect.h });
      }
    }
  }
  return out;
}

/**
 * Greedy merge of an arbitrary axis-rectangle set — the "unite collision"
 * feature. Two phases:
 *  1. Group rectangles by (y, h); within each group, sort by x and merge
 *     touching horizontals (where one rect's right edge == next rect's left).
 *  2. Group the result by (x, w); within each group, sort by y and merge
 *     touching verticals.
 *
 * This combines, for example, a row of 50 grass-top-edge tiles whose polygons
 * each produce a (0,0,16,4) rect → one (0,0,800,4) rect. Plus stacks of
 * left-edge tiles → one tall rect. Mixed-shape adjacent tiles stay separate.
 */
export function mergeRects(rects: AxisRect[]): AxisRect[] {
  if (rects.length <= 1) return rects.slice();
  // Phase 1: horizontal merges grouped by (y, h).
  const byYH = new Map<string, AxisRect[]>();
  for (const r of rects) {
    const k = `${r.y}|${r.h}`;
    let arr = byYH.get(k);
    if (!arr) { arr = []; byYH.set(k, arr); }
    arr.push(r);
  }
  const horizMerged: AxisRect[] = [];
  for (const arr of byYH.values()) {
    arr.sort((a, b) => a.x - b.x);
    let cur = { ...arr[0] };
    for (let i = 1; i < arr.length; i++) {
      const next = arr[i];
      if (next.x <= cur.x + cur.w) {
        // Touching or overlapping → extend.
        const right = Math.max(cur.x + cur.w, next.x + next.w);
        cur.w = right - cur.x;
      } else {
        horizMerged.push(cur);
        cur = { ...next };
      }
    }
    horizMerged.push(cur);
  }
  // Phase 2: vertical merges grouped by (x, w).
  const byXW = new Map<string, AxisRect[]>();
  for (const r of horizMerged) {
    const k = `${r.x}|${r.w}`;
    let arr = byXW.get(k);
    if (!arr) { arr = []; byXW.set(k, arr); }
    arr.push(r);
  }
  const out: AxisRect[] = [];
  for (const arr of byXW.values()) {
    arr.sort((a, b) => a.y - b.y);
    let cur = { ...arr[0] };
    for (let i = 1; i < arr.length; i++) {
      const next = arr[i];
      if (next.y <= cur.y + cur.h) {
        const bottom = Math.max(cur.y + cur.h, next.y + next.h);
        cur.h = bottom - cur.y;
      } else {
        out.push(cur);
        cur = { ...next };
      }
    }
    out.push(cur);
  }
  return out;
}
