import Phaser from "phaser";
import type { Sprite } from "./Sprite";

/**
 * Per-scene spatial hash grid for O(1) nearest / radius queries.
 *
 * The brute-force `peaky.sprites.filter(s => dist(s, here) < radius)` pattern
 * costs O(N) per query — at 10K NPCs each doing one such query per tick,
 * that's 100M ops/frame. With this grid the same query inspects only the
 * 1-9 cells that overlap the query circle (typically 1-50 sprites) — a
 * 100×-1000× win at scale.
 *
 * Layout: 256×256 px cells (matches Construct 3's default collision-cells
 * size). Each cell holds a Set<Sprite>; sprites are bucketed by their
 * gameObject.x/y. The grid is rebuilt cheaply each tick from
 * `peaky.sprites` rather than maintained incrementally — simpler, no
 * "forgot to call rebucket on SetPosition" footguns, and the cost
 * (one integer divide + Map.set per sprite per tick) is negligible
 * compared to the savings on radius queries.
 *
 * Cell ID encoding: `${cellX}|${cellY}` string. String keys keep the
 * grid sparse (no need for a fixed-size 2D array) and let huge / negative
 * coords work without bounds checks. Map performance on string keys is
 * fast enough for the 10K-sprite scale.
 */

export const CELL_SIZE = 256;
const SPATIAL_GRID_KEY = "peaky.spatialGrid";
const EMPTY: Sprite[] = [];

// Pack (cellX, cellY) into one numeric key — avoids the ~5000 template-string
// allocations per frame that string keys (`${cx}|${cy}`) caused in rebuild +
// every getNeighbors query. BIAS shifts negative coords non-negative so
// negative-side cells don't collide with positive-side ones; STRIDE keeps
// cy from spilling into the cx range. Bounds: ±2^20 cells → ±~268M px.
const CELL_BIAS = 1 << 20;
const CELL_STRIDE = 1 << 21;

/** Compute the packed numeric cell key for a given world position. */
export function cellKey(x: number, y: number): number {
  const cx = Math.floor(x / CELL_SIZE) + CELL_BIAS;
  const cy = Math.floor(y / CELL_SIZE) + CELL_BIAS;
  return cx * CELL_STRIDE + cy;
}

/** Rebuild the grid from the scene's live sprite list. Called once per
 *  scene UPDATE BEFORE Sprite.update fires, so every behavior that runs
 *  this tick sees a fresh grid. Cost: ~N Map.set operations + ~N integer
 *  divides — at 10K sprites, <2 ms on a modern browser. */
export function rebuildSpatialGrid(scene: Phaser.Scene): void {
  let grid = scene.data.get(SPATIAL_GRID_KEY) as Map<number, Set<Sprite>> | undefined;
  if (!grid) { grid = new Map(); scene.data.set(SPATIAL_GRID_KEY, grid); }
  else grid.clear();
  const sprites = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
  for (const s of sprites) {
    if (s.destroyed) continue;
    // Frozen off-screen sprites are inert (no tick, body disabled) and never
    // move — keep them OUT of the grid so the rebuild + every getNeighbors
    // query scale with ACTIVE sprites, not the total spawned count.
    if (s._frozenByCull) continue;
    const go = s.gameObject;
    if (!go) continue;
    const cx = Math.floor(go.x / CELL_SIZE) + CELL_BIAS;
    const cy = Math.floor(go.y / CELL_SIZE) + CELL_BIAS;
    const k = cx * CELL_STRIDE + cy;
    let set = grid.get(k);
    if (!set) { set = new Set(); grid.set(k, set); }
    set.add(s);
  }
}

/** Return every sprite within `radius` px of (cx, cy). The result includes
 *  sprites in ANY cell overlapping the query circle's bounding box — caller
 *  is responsible for the final distance check (we don't filter precisely
 *  because the typical caller is already doing a min-distance scan inside
 *  the loop, so filtering twice is wasted work).
 *
 *  Returns the LIVE collection — DO NOT mutate. For typical sight ranges
 *  (50-400 px) hits 1-9 cells. For a radius of 0 returns just the cell
 *  containing (cx, cy) — cheap point lookup.
 *
 *  This is the BIG performance lever: callers that used to scan all
 *  N sprites per tick now scan ~10-50 candidates max. */
export function getNeighbors(scene: Phaser.Scene, cx: number, cy: number, radius: number): Sprite[] {
  const grid = scene.data.get(SPATIAL_GRID_KEY) as Map<number, Set<Sprite>> | undefined;
  if (!grid || grid.size === 0) return EMPTY;
  const minCellX = Math.floor((cx - radius) / CELL_SIZE);
  const maxCellX = Math.floor((cx + radius) / CELL_SIZE);
  const minCellY = Math.floor((cy - radius) / CELL_SIZE);
  const maxCellY = Math.floor((cy + radius) / CELL_SIZE);
  // Fast path — single cell query (radius < cell size and aligned).
  if (minCellX === maxCellX && minCellY === maxCellY) {
    const k = (minCellX + CELL_BIAS) * CELL_STRIDE + (minCellY + CELL_BIAS);
    const set = grid.get(k);
    return set ? Array.from(set) : EMPTY;
  }
  const out: Sprite[] = [];
  for (let cy2 = minCellY; cy2 <= maxCellY; cy2++) {
    const cyKey = cy2 + CELL_BIAS;
    for (let cx2 = minCellX; cx2 <= maxCellX; cx2++) {
      const k = (cx2 + CELL_BIAS) * CELL_STRIDE + cyKey;
      const set = grid.get(k);
      if (!set) continue;
      for (const s of set) out.push(s);
    }
  }
  return out;
}

/** Combined helper: tag index AND spatial filter in one call. Returns
 *  sprites that carry `tag` AND sit within `radius` of (cx, cy). Used by
 *  AIBrain sight scans, separation, MoveTo target acquisition. Cost: a
 *  set intersection of the tag set and the cell candidate set — typically
 *  <10 ops. Falls back to tag-only when the tag set is smaller than
 *  the cells' candidate count (often the case for rare tags). */
export function getNeighborsByTag(scene: Phaser.Scene, tag: string, cx: number, cy: number, radius: number): Sprite[] {
  const byTag = scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
  const tagged = byTag?.get(tag);
  if (!tagged || tagged.size === 0) return EMPTY;
  // For rare tags (≤8 sprites carry it), iterate the tag set and filter by
  // distance — likely faster than walking the grid cells. This is the
  // "find the player" case where 1 sprite carries the tag.
  if (tagged.size <= 8) {
    const out: Sprite[] = [];
    const r2 = radius * radius;
    for (const s of tagged) {
      if (s.destroyed) continue;
      const dx = s.gameObject.x - cx;
      const dy = s.gameObject.y - cy;
      if (dx * dx + dy * dy <= r2) out.push(s);
    }
    return out;
  }
  // Common tag (many sprites) — iterate grid cells overlapping the
  // radius and filter by tag presence. Avoids the "find player from
  // 5000 enemies" pathology where the tag set is large.
  const neighbors = getNeighbors(scene, cx, cy, radius);
  if (neighbors.length === 0) return EMPTY;
  const out: Sprite[] = [];
  for (const s of neighbors) {
    if (s.destroyed) continue;
    if (!tagged.has(s)) continue;
    out.push(s);
  }
  return out;
}
