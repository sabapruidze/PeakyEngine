import type Phaser from "phaser";
import type { TilemapRenderer } from "../behaviors/TilemapRenderer";
import { Logger } from "../Logger";

/**
 * Tilemap-action helpers — keep `eval.ts` slim by parking the
 * world↔cell math + named-lookup logic here.
 *
 * The runtime registry `peaky.tilemapsByName` is populated by TilemapRenderer
 * during init; entries are removed on destroy. A single map asset placed in
 * a scene multiple times → last-spawned wins; authors needing multi-instance
 * targeting can use the `tilemapId` to distinguish, but for v1 we go by name.
 */

/** Find a placed tilemap by its asset name. Returns null when no scene tilemap
 *  with that name is registered.
 *
 *  When multiple instances of the same tilemap exist (chunked levels, mirrored
 *  layouts), this returns the LAST-spawned one — fine for asset-wide actions
 *  like PlayAllTileAnimations. At-world actions (Mine/Set/Remove/Damage)
 *  should use `findTilemapAtWorld` instead to pick the specific instance whose
 *  bounds contain the click coords. */
export function findTilemap(scene: Phaser.Scene | undefined, name: string): TilemapRenderer | null {
  if (!scene || !name || !scene.data) return null;
  const reg = scene.data.get("peaky.tilemapsByName") as Map<string, TilemapRenderer> | undefined;
  return reg?.get(name) ?? null;
}

/** Find the placed tilemap instance (by asset name) whose bounds contain the
 *  given world coords. Used by at-world actions when multiple instances of
 *  the same asset are placed in the scene — without this lookup, only the
 *  last-spawned instance was reachable and clicks elsewhere silently failed
 *  with "outside tilemap bounds". Falls back to `findTilemap` when no
 *  instance contains the point (gives the existing error message). */
export function findTilemapAtWorld(
  scene: Phaser.Scene | undefined,
  name: string,
  worldX: number,
  worldY: number,
): TilemapRenderer | null {
  if (!scene || !name || !scene.data) return null;
  const all = scene.data.get("peaky.tilemapsByNameAll") as Map<string, TilemapRenderer[]> | undefined;
  const list = all?.get(name);
  if (list && list.length > 0) {
    for (const tm of list) {
      if (tm.worldToCell(worldX, worldY) !== null) return tm;
    }
    // None contain the point — return null so the action handler logs
    // "outside bounds" with the correct context.
    return null;
  }
  return findTilemap(scene, name);
}

/** Resolve a layer reference (name or id) against a TilemapRenderer. Returns
 *  the InputLayer's id on success, or null when the reference doesn't match
 *  any of the tilemap's layers. Useful in eval.ts where actions accept a
 *  `layer` parameter as a name (author-facing) but the public API methods
 *  expect an id. */
export function resolveLayerId(tm: TilemapRenderer, layerRef: string): string | null {
  if (!layerRef) {
    // No layer specified → first layer (z-asc) is the default. Most actions
    // make this explicit so this branch is rare.
    const first = tm.layers[0];
    return first?.id ?? null;
  }
  const byName = tm.findLayerByName(layerRef);
  return byName?.id ?? null;
}

/**
 * Action-handler convenience — resolve tilemap+layer from a config block
 * and LOG on either miss so authors see why their tile action did nothing.
 * Returns { tm, layerId } or null. `source` shows up as the log source
 * (the action kind, typically).
 *
 * Use this from every tile ACTION handler. Conditions intentionally don't
 * log on miss — they poll every tick and would spam the console.
 */
export function resolveTilemapAndLayer(
  scene: Phaser.Scene | undefined,
  tilemapName: string,
  layerName: string,
  source: string,
): { tm: TilemapRenderer; layerId: string } | null {
  const tm = findTilemap(scene, tilemapName);
  if (!tm) {
    const known = Array.from(((scene?.data?.get("peaky.tilemapsByName") as Map<string, unknown> | undefined) ?? new Map()).keys());
    Logger.log({ level: "warn", source, message: `tilemap "${tilemapName}" not found. Registered: [${known.join(", ")}]` });
    return null;
  }
  const layerId = resolveLayerId(tm, layerName);
  if (!layerId) {
    const layers = tm.layers.map((L) => (L as { name?: string }).name ?? L.id).join(", ");
    Logger.log({ level: "warn", source, message: `layer "${layerName}" not on tilemap "${tilemapName}". Available: [${layers}]` });
    return null;
  }
  return { tm, layerId };
}

/** Convert world coordinates to (c, r) for a named tilemap. Returns null if
 *  the tilemap doesn't exist or the position is out of bounds. */
export function worldToCellOn(
  scene: Phaser.Scene | undefined,
  tilemapName: string,
  worldX: number,
  worldY: number,
): { c: number; r: number } | null {
  const tm = findTilemap(scene, tilemapName);
  if (!tm) return null;
  return tm.worldToCell(worldX, worldY);
}
