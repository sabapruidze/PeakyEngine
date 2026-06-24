import type Phaser from "phaser";
import { findTilemapAtWorld } from "../util/tileCoords";
import type { TilemapRenderer } from "../behaviors/TilemapRenderer";

/** A nav waypoint's availability-relevant fields. */
export interface NavPointLite {
  id: string;
  singleUse?: boolean;
  srcMap?: string;
  srcX?: number;
  srcY?: number;
}

/** Does the source tile of a (renewable) nav point still exist? Points without a
 *  source tile (hand-placed missions) are always considered present, so they
 *  fall through to claim-only behavior. Tile-backed points go unavailable while
 *  their tile is mined and return the moment it grows back. */
// Per-frame memo of tile-existence per source cell. ALL NPCs scan the SAME nav
// points every re-advance, so a point's tile-check is otherwise recomputed once
// per (NPC × point) — the `hasPlacementAt` 19.5% in the profile. Computing it
// ONCE per point per frame collapses that. Cleared when the frame changes; a
// tile mined mid-frame reads stale-by-one-frame, which is harmless (the claim
// system + the actual mine handle the real state).
let _tileExistsFrame = -1;
const _tileExistsMemo = new Map<string, boolean>();

export function navPointTileExists(scene: Phaser.Scene, p: { srcMap?: string; srcX?: number; srcY?: number }): boolean {
  if (p.srcX == null || p.srcY == null) return true;
  const frame = scene.game?.loop?.frame ?? -1;
  if (frame !== _tileExistsFrame) { _tileExistsFrame = frame; _tileExistsMemo.clear(); }
  const key = `${p.srcMap ?? ""}|${p.srcX}|${p.srcY}`;
  const memo = _tileExistsMemo.get(key);
  if (memo !== undefined) return memo;

  let result: boolean;
  // Prefer the exact named tilemap; fall back to scanning every registered
  // tilemap so an untitled map (or moved instance) still resolves.
  const named = findTilemapAtWorld(scene, p.srcMap ?? "", p.srcX, p.srcY);
  if (named) {
    const cell = named.worldToCell(p.srcX, p.srcY);
    result = cell ? named.hasPlacementAt(cell.c, cell.r) : true;
  } else {
    const all = scene.data.get("peaky.tilemapsByNameAll") as Map<string, TilemapRenderer[]> | undefined;
    if (!all || all.size === 0) {
      result = true; // no tilemaps at all → don't gate
    } else {
      result = false;
      outer: for (const arr of all.values()) {
        for (const tm of arr) {
          const cell = tm.worldToCell(p.srcX, p.srcY);
          if (cell && tm.hasPlacementAt(cell.c, cell.r)) { result = true; break outer; }
        }
      }
    }
  }
  _tileExistsMemo.set(key, result);
  return result;
}

/** Refresh this NPC's claim lease on a nav point (called each tick while it's
 *  actively heading to / working the point). Leak-proof: a dead or re-targeted
 *  NPC simply stops refreshing and the lease expires next frame. */
export function claimNavPoint(scene: Phaser.Scene, pointId: string, uid: number): void {
  let claims = scene.data.get("peaky.claimedNavPoints") as Map<string, { uid: number; frame: number }> | undefined;
  if (!claims) { claims = new Map(); scene.data.set("peaky.claimedNavPoints", claims); }
  claims.set(pointId, { uid, frame: scene.game.loop.frame });
}

/** Is a nav point available to `selfUid` right now?
 *   - singleUse → one-shot: consumed permanently (peaky.usedNavPoints).
 *   - otherwise → free unless another NPC holds a LIVE claim lease on it; and,
 *     when tile-backed, only while its source tile exists.
 */
/** Visual debug overlay — draws each nav point colored by state:
 *   green  = active (targetable)
 *   yellow = busy (an NPC holds a live claim)
 *   red    = consumed (single-use, used up)
 *   gray   = depleted (tile-backed point whose tile is mined / regrowing)
 *  Called each frame from the scene update when `peaky.navDebug` is on. */
export function drawNavDebug(scene: Phaser.Scene): void {
  let g = scene.data.get("peaky.navDebugGfx") as Phaser.GameObjects.Graphics | undefined;
  const grid = scene.data.get("peaky.navGrid") as { waypoints: (NavPointLite & { x: number; y: number; name?: string })[] } | undefined;
  if (!grid) { g?.clear(); return; }
  if (!g) {
    g = scene.add.graphics();
    g.setDepth(1_000_000_000);
    // World-space overlay — keep it off the fixed UI camera, else it also draws
    // stuck to the screen like a HUD widget.
    const uiCam = scene.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
    if (uiCam) uiCam.ignore(g);
    scene.data.set("peaky.navDebugGfx", g);
  }
  g.clear();
  const frame = scene.game.loop.frame;
  const used = scene.data.get("peaky.usedNavPoints") as Set<string> | undefined;
  const claims = scene.data.get("peaky.claimedNavPoints") as Map<string, { uid: number; frame: number }> | undefined;
  for (const w of grid.waypoints) {
    let color = 0x44e070; // active
    if (w.singleUse && used?.has(w.id)) color = 0xe04040; // consumed
    else {
      const claim = claims?.get(w.id);
      if (claim && claim.frame >= frame - 1) color = 0xf0d030; // busy
      else if (!navPointTileExists(scene, w)) color = 0x808080; // depleted
    }
    g.fillStyle(color, 0.85);
    g.fillCircle(w.x, w.y, 5);
    g.lineStyle(1.5, 0x101010, 0.9);
    g.strokeCircle(w.x, w.y, 5);
  }
}

export function isNavPointAvailable(scene: Phaser.Scene, p: NavPointLite, selfUid: number): boolean {
  if (p.singleUse) {
    const used = scene.data.get("peaky.usedNavPoints") as Set<string> | undefined;
    return !(used?.has(p.id));
  }
  const claims = scene.data.get("peaky.claimedNavPoints") as Map<string, { uid: number; frame: number }> | undefined;
  const claim = claims?.get(p.id);
  if (claim && claim.uid !== selfUid && claim.frame >= scene.game.loop.frame - 1) return false;
  return navPointTileExists(scene, p);
}
