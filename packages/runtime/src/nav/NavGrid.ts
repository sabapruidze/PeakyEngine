/**
 * Runtime navigation grid + A* pathfinding.
 *
 * The editor paints a per-scene `navMesh` (walkable grid + obstacle polygons +
 * waypoints). At scene start we BAKE that into a flat `blocked` grid (walkable
 * minus obstacles), then run A* on it for NPC paths. The grid is the single
 * source of truth — obstacle polygons exist for the editor + tracers, but for
 * routing they're just cells subtracted from walkability.
 */
export interface NavMeshData {
  cellSize: number;
  cols: number;
  rows: number;
  walkable: number[];
  obstacles: { id: string; points: { x: number; y: number }[]; tags: string[] }[];
  waypoints: { id: string; x: number; y: number; name?: string; tags: string[]; waitSec?: number; signalOnArrive?: string; srcMap?: string; srcX?: number; srcY?: number; setStateAny?: string; setStates?: { bp: string; state: string }[]; singleUse?: boolean }[];
}

export interface NavGrid {
  cellSize: number;
  cols: number;
  rows: number;
  /** 1 = blocked (not walkable OR inside an obstacle), 0 = walkable. */
  blocked: Uint8Array;
  /** Painted type per cell: 0=blocked, 1=linear (sharp), 2=curved (rounded).
   *  Path corners passing through a curved cell get arc-rounded. */
  terrain: Uint8Array;
  /** Kept for runtime queries (tracer line-of-sight / detection by tag). */
  obstacles: NavMeshData["obstacles"];
  waypoints: NavMeshData["waypoints"];
}

function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Bake walkable-minus-obstacles into a flat blocked grid. */
export function buildNavGrid(nm: NavMeshData): NavGrid {
  const { cellSize, cols, rows } = nm;
  const blocked = new Uint8Array(cols * rows);
  const terrain = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) { const v = nm.walkable[i] || 0; terrain[i] = v; blocked[i] = v ? 0 : 1; }
  for (const o of nm.obstacles) {
    if (o.points.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of o.points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const c0 = Math.max(0, Math.floor(minX / cellSize)), c1 = Math.min(cols - 1, Math.floor(maxX / cellSize));
    const r0 = Math.max(0, Math.floor(minY / cellSize)), r1 = Math.min(rows - 1, Math.floor(maxY / cellSize));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (pointInPoly(c * cellSize + cellSize / 2, r * cellSize + cellSize / 2, o.points)) blocked[r * cols + c] = 1;
    }
  }
  return { cellSize, cols, rows, blocked, terrain, obstacles: nm.obstacles, waypoints: nm.waypoints };
}

/** Segment (a→b) vs segment (c→d) intersection test. */
function segHit(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** True if the world segment (ax,ay)→(bx,by) crosses or starts inside the polygon. */
export function segmentHitsPolygon(ax: number, ay: number, bx: number, by: number, poly: { x: number; y: number }[]): boolean {
  if (poly.length < 3) return false;
  if (pointInPoly(ax, ay, poly) || pointInPoly(bx, by, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segHit(ax, ay, bx, by, poly[i].x, poly[i].y, poly[j].x, poly[j].y)) return true;
  }
  return false;
}

/** True if an axis-aligned rect overlaps the polygon (for BOX tracers). */
export function rectHitsPolygon(minX: number, minY: number, maxX: number, maxY: number, poly: { x: number; y: number }[]): boolean {
  if (poly.length < 3) return false;
  for (const p of poly) if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) return true;
  if (pointInPoly(minX, minY, poly) || pointInPoly(maxX, minY, poly) || pointInPoly(maxX, maxY, poly) || pointInPoly(minX, maxY, poly)) return true;
  const edges: [number, number, number, number][] = [[minX, minY, maxX, minY], [maxX, minY, maxX, maxY], [maxX, maxY, minX, maxY], [minX, maxY, minX, minY]];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    for (const [x1, y1, x2, y2] of edges) if (segHit(x1, y1, x2, y2, poly[j].x, poly[j].y, poly[i].x, poly[i].y)) return true;
  }
  return false;
}

const curvedCell = (g: NavGrid, x: number, y: number) => {
  const c = Math.floor(x / g.cellSize), r = Math.floor(y / g.cellSize);
  return c >= 0 && c < g.cols && r >= 0 && r < g.rows && g.terrain[r * g.cols + c] === 2;
};

/** Replace each corner that sits in a CURVED (yellow) cell with a short
 *  quadratic-Bezier arc, so the NPC rounds the bend instead of pivoting.
 *  Corners in LINEAR (green) cells stay sharp. */
function roundCurvedCorners(g: NavGrid, pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const out: { x: number; y: number }[] = [pts[0]];
  const R = g.cellSize * 1.6;
  const SAMPLES = 6;
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1], B = pts[i], C = pts[i + 1];
    if (!curvedCell(g, B.x, B.y)) { out.push(B); continue; }
    const ab = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const cb = Math.hypot(B.x - C.x, B.y - C.y) || 1;
    const r1 = Math.min(R, ab / 2), r2 = Math.min(R, cb / 2);
    const P1 = { x: B.x + ((A.x - B.x) / ab) * r1, y: B.y + ((A.y - B.y) / ab) * r1 };
    const P2 = { x: B.x + ((C.x - B.x) / cb) * r2, y: B.y + ((C.y - B.y) / cb) * r2 };
    out.push(P1);
    for (let t = 1; t <= SAMPLES; t++) {
      const u = t / (SAMPLES + 1), iu = 1 - u;
      out.push({ x: iu * iu * P1.x + 2 * iu * u * B.x + u * u * P2.x, y: iu * iu * P1.y + 2 * iu * u * B.y + u * u * P2.y });
    }
    out.push(P2);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const cellCenter = (g: NavGrid, c: number, r: number) => ({ x: c * g.cellSize + g.cellSize / 2, y: r * g.cellSize + g.cellSize / 2 });
const walkableCell = (g: NavGrid, c: number, r: number) => c >= 0 && c < g.cols && r >= 0 && r < g.rows && g.blocked[r * g.cols + c] === 0;

/** Nearest walkable cell to a world point (BFS outward). Returns null if the
 *  whole grid is blocked. Lets a path start/end snap onto the mesh even when
 *  the NPC or target is a few px off a painted cell. */
function nearestWalkable(g: NavGrid, wx: number, wy: number): { c: number; r: number } | null {
  const c0 = Math.floor(wx / g.cellSize), r0 = Math.floor(wy / g.cellSize);
  if (walkableCell(g, c0, r0)) return { c: c0, r: r0 };
  const maxR = Math.max(g.cols, g.rows);
  for (let rad = 1; rad <= maxR; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue; // ring only
      if (walkableCell(g, c0 + dc, r0 + dr)) return { c: c0 + dc, r: r0 + dr };
    }
  }
  return null;
}

/** Bresenham line-of-sight between two cells (no blocked cell on the line). */
function lineOfSight(g: NavGrid, c0: number, r0: number, c1: number, r1: number): boolean {
  let dc = Math.abs(c1 - c0), dr = Math.abs(r1 - r0);
  let sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
  let err = dc - dr, c = c0, r = r0;
  for (;;) {
    if (!walkableCell(g, c, r)) return false;
    if (c === c1 && r === r1) return true;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 < dc) { err += dc; r += sr; }
  }
}

const SQRT2 = Math.SQRT2;

/**
 * A* from world (sx,sy) → (gx,gy). 8-directional, octile heuristic, with a
 * line-of-sight string-pull so the returned path is a short list of world
 * points (not every cell). Returns null if no route exists.
 */
export function findPath(g: NavGrid, sx: number, sy: number, gx: number, gy: number): { x: number; y: number }[] | null {
  const start = nearestWalkable(g, sx, sy);
  const goal = nearestWalkable(g, gx, gy);
  if (!start || !goal) return null;
  const { cols, rows } = g;
  const idx = (c: number, r: number) => r * cols + c;
  const startI = idx(start.c, start.r), goalI = idx(goal.c, goal.r);
  if (startI === goalI) return [{ x: gx, y: gy }];

  const open = new Set<number>([startI]);
  const came = new Map<number, number>();
  const gScore = new Float64Array(cols * rows).fill(Infinity);
  const fScore = new Float64Array(cols * rows).fill(Infinity);
  gScore[startI] = 0;
  const h = (c: number, r: number) => { const dc = Math.abs(c - goal.c), dr = Math.abs(r - goal.r); return (dc + dr) + (SQRT2 - 2) * Math.min(dc, dr); };
  fScore[startI] = h(start.c, start.r);

  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let guard = cols * rows + 1;
  while (open.size > 0 && guard-- > 0) {
    // Lowest fScore in the open set.
    let cur = -1, best = Infinity;
    for (const i of open) if (fScore[i] < best) { best = fScore[i]; cur = i; }
    if (cur === goalI) break;
    open.delete(cur);
    const cc = cur % cols, cr = (cur - cc) / cols;
    for (const [dc, dr] of NB) {
      const nc = cc + dc, nr = cr + dr;
      if (!walkableCell(g, nc, nr)) continue;
      // Disallow cutting diagonally through a blocked corner.
      if (dc !== 0 && dr !== 0 && (!walkableCell(g, cc + dc, cr) || !walkableCell(g, cc, cr + dr))) continue;
      const ni = idx(nc, nr);
      const step = dc !== 0 && dr !== 0 ? SQRT2 : 1;
      const tentative = gScore[cur] + step;
      if (tentative < gScore[ni]) {
        came.set(ni, cur);
        gScore[ni] = tentative;
        fScore[ni] = tentative + h(nc, nr);
        open.add(ni);
      }
    }
  }
  if (!came.has(goalI) && startI !== goalI) return null;

  // Reconstruct cell path.
  const cells: { c: number; r: number }[] = [];
  let n: number | undefined = goalI;
  while (n !== undefined) { const c = n % cols; cells.push({ c, r: (n - c) / cols }); n = came.get(n); }
  cells.reverse();

  // String-pull: keep a point only when LOS to the next-next breaks.
  const out: { x: number; y: number }[] = [cellCenter(g, cells[0].c, cells[0].r)];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    if (!lineOfSight(g, cells[anchor].c, cells[anchor].r, cells[i].c, cells[i].r)) {
      out.push(cellCenter(g, cells[i - 1].c, cells[i - 1].r));
      anchor = i - 1;
    }
  }
  // Always end at the EXACT authored point. The A* routed via walkable cells up
  // to the nearest one; this final short hop lands the NPC precisely on the
  // waypoint (bushes / nodes sit just off the painted mesh, so snapping to a
  // cell center would scatter NPCs by up to half a cell, differently per point).
  out.push({ x: gx, y: gy });
  // Round corners that fall in curved (yellow) cells; linear (green) stay sharp.
  return roundCurvedCorners(g, out);
}
