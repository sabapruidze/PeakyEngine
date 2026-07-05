import type { Sprite } from "./Sprite";

// Spatial-hash grid parameters. CELL ≈ a typical body size; bodies larger than
// a cell simply span several cells (still correct). BIAS shifts negative cell
// coords non-negative; STRIDE packs (cx,cy) into one numeric key (no per-cell
// string allocation). Bounds: cells within ±2^20 → ±~134M px at CELL 128.
const CELL = 128;
const CELL_BIAS = 1 << 20;
const CELL_STRIDE = 1 << 21;
// Reused across ticks (cleared each call) so the broad-phase allocates only
// the per-cell index buckets, never the container structures.
const _grid = new Map<number, number[]>();
const _testedPairs = new Set<number>();

/**
 * Per-scene overlap scan. Walks `sprites` pairwise, computes AABB
 * intersection on each pair's physics body, and stamps four transient
 * Sets on each Sprite that the animator's tag-based collision
 * conditions consume:
 *
 *   - `_currOverlap`           — sprites overlapping THIS tick.
 *   - `_prevOverlap`           — what `_currOverlap` was last tick.
 *   - `_justCollidedThisTick`  — `_currOverlap \ _prevOverlap` (edge ON).
 *   - `_justSeparatedThisTick` — `_prevOverlap \ _currOverlap` (edge OFF).
 *
 * Called from `Game.ts` once per scene update AFTER Phaser's physics
 * step (so body positions are settled) and BEFORE the per-sprite
 * behavior tick (so the animator sees this tick's fresh state during
 * its update). O(N²) over the live sprite list — N is typically tens,
 * so a few thousand AABB tests per tick is well under a frame budget.
 *
 * Why not Phaser's `add.overlap(group, group)`? Phaser only fires its
 * callback for pairs that ARE overlapping, with no built-in way to
 * detect the SEPARATION edge from inside the callback. Doing the scan
 * ourselves keeps `_prevOverlap` snapshot + diff trivially correct and
 * decouples the animator from Phaser-callback ordering quirks.
 */
export function runCollisionScan(sprites: Sprite[]): void {
  // Rotate prev = curr, clear curr + edge sets. Reuse Set instances —
  // we swap references rather than allocating fresh each tick.
  for (const s of sprites) {
    if (!s) continue;
    const tmp = s._prevOverlap;
    s._prevOverlap = s._currOverlap;
    s._currOverlap = tmp;
    s._currOverlap.clear();
    s._justCollidedThisTick.clear();
    s._justSeparatedThisTick.clear();
  }

  // Broad-phase via a uniform spatial-hash grid (Construct-3 "collision
  // cells"). Each sprite is inserted into every grid cell its AABB covers;
  // two AABBs can only overlap if they share a cell, so we only narrow-phase
  // pairs that co-occupy a cell. This turns the old O(N²) all-pairs scan into
  // ~O(N) for normal object distributions — the difference between a few
  // hundred and ~180k AABB tests at 600 sprites. Output (`_currOverlap`) is
  // IDENTICAL to the brute-force scan: every overlapping pair shares ≥1 cell.
  const n = sprites.length;
  type Body = { x: number; y: number; width: number; height: number; enable?: boolean };
  const bodies: (Body | null)[] = new Array(n);
  // Asymmetric bucketing:
  //   - Sprites with `skipCollisionScan = false`        → bucketed normally.
  //   - Sprites with `skipCollisionScan = true`         → tracked but NOT
  //     bucketed. They run a second pass that QUERIES the bucket for
  //     non-skip neighbors, applying the per-tag exception list.
  //   - Pure-skip sprites (skip on, no exceptions)      → ignored entirely.
  //
  // The win at 1000 swarm sprites packed in one cell:
  //   Old: 1000² / 2 = ~500K within-bucket pair iterations even with
  //        cheap skip-check early-outs.
  //   New: bucket has 1 sprite (the player). Pass 2 has 0 pairs.
  //        Pass 3 runs ~1000 single-cell lookups, 1000 pair tests.
  //   ~500× fewer iterations for the typical "swarm + lone target" case.
  //
  // Cost is paid for the rare swarm-vs-swarm pair case (e.g. two swarm
  // BPs where each lists the other's tag in its exceptions). Those pairs
  // are missed by Pass 3 because both sides are out of the bucket. Author
  // workaround: disable `skipCollisionScan` on at least one of those
  // swarm BPs. Documented in the BP inspector tooltip.
  const exceptTagsByIdx: (string[] | null)[] = new Array(n);
  _grid.clear();
  for (let i = 0; i < n; i++) {
    const a = sprites[i];
    if (!a || a.destroyed) { bodies[i] = null; exceptTagsByIdx[i] = null; continue; }
    const skip = !!(a as unknown as { skipCollisionScan?: boolean }).skipCollisionScan;
    const ab = (a as unknown as { body?: Body }).body;
    if (!ab || ab.enable === false) { bodies[i] = null; exceptTagsByIdx[i] = null; continue; }
    // Opt-in collision: a sprite only participates in overlap / OnCollide-
    // OnOverlap detection when it has a collider (Collider / Solid / JumpThru),
    // OR a Projectile (a bullet is inherently a collision object — it opts out
    // of PHYSICS separation via checkCollision.none, but authors still expect
    // OnCollide/OnOverlap to detect it). "Use Frame Collider" auto-injects a
    // Collider, so it's covered. A BP with none of these is inert — no spurious
    // triggers off its default rect.
    const srOptIn = a.findBehaviorByKind("SpriteRenderer") as
      | { useFrameCollider?: number } | undefined;
    if (!a.findBehaviorByKind("Collider") && !a.findBehaviorByKind("Solid")
        && !a.findBehaviorByKind("JumpThru") && !a.findBehaviorByKind("Projectile")
        && !(srOptIn && srOptIn.useFrameCollider)) {
      bodies[i] = null; exceptTagsByIdx[i] = null; continue;
    }
    bodies[i] = ab;
    if (skip) {
      const raw = (a as unknown as { collisionScanExceptTags?: string }).collisionScanExceptTags ?? "";
      const parsed = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
      exceptTagsByIdx[i] = parsed.length > 0 ? parsed : null;
      // DO NOT bucket. Pass 3 handles these.
      continue;
    }
    exceptTagsByIdx[i] = null;
    // Bucket normally.
    const x0 = Math.floor(ab.x / CELL), x1 = Math.floor((ab.x + ab.width) / CELL);
    const y0 = Math.floor(ab.y / CELL), y1 = Math.floor((ab.y + ab.height) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx + CELL_BIAS) * CELL_STRIDE + (cy + CELL_BIAS);
        let bucket = _grid.get(key);
        if (!bucket) { bucket = []; _grid.set(key, bucket); }
        bucket.push(i);
      }
    }
  }
  // Pass 2: standard within-bucket pair tests. All sprites in buckets
  // have skipCollisionScan = false, so no skip check is needed in the
  // hot loop.
  _testedPairs.clear();
  for (const bucket of _grid.values()) {
    const m = bucket.length;
    for (let p = 0; p < m; p++) {
      const i = bucket[p];
      const ab = bodies[i];
      if (!ab) continue;
      const aR = ab.x + ab.width, aB = ab.y + ab.height;
      for (let q = p + 1; q < m; q++) {
        const j = bucket[q];
        const lo = i < j ? i : j, hi = i < j ? j : i;
        const pk = lo * n + hi;
        if (_testedPairs.has(pk)) continue;
        _testedPairs.add(pk);
        const bb = bodies[j];
        if (!bb) continue;
        if (ab.x < bb.x + bb.width && aR > bb.x && ab.y < bb.y + bb.height && aB > bb.y) {
          sprites[i]._currOverlap.add(sprites[j]);
          sprites[j]._currOverlap.add(sprites[i]);
        }
      }
    }
  }
  // Pass 3: skip-with-exception sprites query the bucket for non-skip
  // neighbors. This is the path that scales to 1000s of swarm sprites
  // without the within-cluster O(M²) explosion — each swarm sprite costs
  // (cell-count × non-skip-sprites-per-cell), which is typically 1-10.
  for (let i = 0; i < n; i++) {
    const myExcept = exceptTagsByIdx[i];
    if (!myExcept) continue; // not a skip-with-exception sprite
    const ab = bodies[i];
    if (!ab) continue;
    const aR = ab.x + ab.width, aB = ab.y + ab.height;
    const x0 = Math.floor(ab.x / CELL), x1 = Math.floor((ab.x + ab.width) / CELL);
    const y0 = Math.floor(ab.y / CELL), y1 = Math.floor((ab.y + ab.height) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = (cx + CELL_BIAS) * CELL_STRIDE + (cy + CELL_BIAS);
        const bucket = _grid.get(key);
        if (!bucket) continue;
        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j === i) continue;
          const lo = i < j ? i : j, hi = i < j ? j : i;
          const pk = lo * n + hi;
          if (_testedPairs.has(pk)) continue;
          _testedPairs.add(pk);
          const bb = bodies[j];
          if (!bb) continue;
          // Exception check — does the bucketed sprite carry any tag in
          // this swarm sprite's exception list?
          if (!tagsIntersect(myExcept, sprites[j].tags)) continue;
          if (ab.x < bb.x + bb.width && aR > bb.x && ab.y < bb.y + bb.height && aB > bb.y) {
            sprites[i]._currOverlap.add(sprites[j]);
            sprites[j]._currOverlap.add(sprites[i]);
          }
        }
      }
    }
  }

  // Edge derivation per sprite, plus auto-emit of `OnCollide_<tag>` /
  // `OnSeparate_<tag>` signals on the local sprite's event bus. The
  // auto-emit lets Functions react to collisions WITHOUT any state-
  // machine setup — author names a Function `OnCollide_wall` and it
  // fires every time a sprite tagged `wall` starts overlapping. Two
  // passes (curr-vs-prev and prev-vs-curr) match the edge semantics.
  for (const s of sprites) {
    if (!s) continue;
    const sEvents = (s as unknown as { events?: { emit: (name: string, payload?: unknown) => void } }).events;
    for (const other of s._currOverlap) {
      if (!s._prevOverlap.has(other)) {
        s._justCollidedThisTick.add(other);
        // Auto-emit per tag carried by `other`. Multi-tag sprites
        // produce one signal per tag — author can name a Function
        // after whichever tag they care about (most specific wins
        // mentally; functionally all three fire). `other` rides along as
        // payload so a Logic Sheet `Get Collided Object` getter can read it.
        if (sEvents) {
          // Bare `OnCollide` (no tag) fires once per newly-overlapping object —
          // even untagged ones — so a tagless OnCollide trigger detects ANY
          // collision. Per-tag signals fire alongside for filtered triggers.
          sEvents.emit("OnCollide", other);
          for (const tag of other.tags) sEvents.emit(`OnCollide_${tag}`, other);
        }
      }
    }
    for (const other of s._prevOverlap) {
      if (!s._currOverlap.has(other)) {
        s._justSeparatedThisTick.add(other);
        if (sEvents) {
          sEvents.emit("OnSeparate", other);
          for (const tag of other.tags) sEvents.emit(`OnSeparate_${tag}`, other);
        }
      }
    }
  }
}

/** True if any tag in `exceptList` is present in `theirTags`. Used by the
 *  asymmetric skip logic — a swarm enemy with `skipCollisionScan=true,
 *  exceptTags="player,wall"` still detects pairs with sprites carrying
 *  the "player" or "wall" tag. Returns false fast when there's no
 *  exception list or no tags. */
function tagsIntersect(exceptList: string[] | null, theirTags: Set<string> | undefined): boolean {
  if (!exceptList || !theirTags || theirTags.size === 0) return false;
  for (const t of exceptList) {
    if (theirTags.has(t)) return true;
  }
  return false;
}
