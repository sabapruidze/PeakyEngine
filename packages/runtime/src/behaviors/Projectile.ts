import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";
import { getSpritesByTag } from "../Sprite";

/**
 * Projectile — a self-propelling sprite that flies in a direction (or
 * homes onto a target), fires a signal on tag-matched overlap, and
 * optionally destroys itself on hit / on lifetime expiry.
 *
 * Pairs with the `FireProjectile` action: the author authors a BP with
 * a sprite + collider + this behavior, then fires it via
 * `FireProjectile { bpName, x, y, angle, speed, ... }`. The action sets
 * the body's initial velocity AND any per-shot overrides (targetUid for
 * homing). This behavior keeps the velocity at `speed` thereafter — or
 * accumulates gravity each tick, depending on config.
 *
 * No automatic damage. On overlap with a sprite carrying any tag from
 * `targetTags`, the projectile emits `hitSignal` on BOTH itself AND the
 * hit sprite. Authors then react in event sheets — typically apply
 * damage, spawn an explosion, knockback, etc.
 */
export class Projectile extends Behavior {
  kind = "Projectile";

  /** "straight" = constant heading. "homing" = turn toward target each tick
   *  up to `homingTurnRate` degrees/sec. */
  mode: "straight" | "homing" = "straight";
  /** Travel speed (px/sec). FireProjectile may override per-shot. */
  speed = 600;
  /** Auto-destroy after this many seconds. 0 = no time limit. */
  lifetime = 3;
  /** Per-axis gravity (px/sec²). Non-zero arcs the trajectory; the
   *  visual rotation (when `rotateToVelocity`) tracks the curving
   *  velocity vector. */
  gravityX = 0;
  gravityY = 0;
  /** Comma- or space-separated list of tags. Overlap with any sprite
   *  carrying ANY of these fires the hit signal. Empty = never. */
  targetTags = "";
  /** Signal emitted on (self, hit-target) when overlap matches. Empty
   *  string = no signal, hit just registers for destroyOnHit. */
  hitSignal = "";
  /** When 1, the projectile destroys itself on its first matching hit. */
  destroyOnHit = 1;
  /** When 1, the projectile also checks for solid tilemap tiles each tick
   *  (projectiles otherwise pass straight through the world). On a tile hit it
   *  emits `tileHitSignal` on itself + the generic `OnProjectileTileHit`, and
   *  destroys itself when `destroyOnHit` is set. */
  collideTiles = 0;
  /** Signal emitted on the projectile when it overlaps a solid tile (only when
   *  `collideTiles` is on). Empty = no signal, just the destroy + generic event. */
  tileHitSignal = "";
  /** When 1, rotate the host sprite's GameObject so its "front" points
   *  along velocity. Useful for arrows / missiles. Pure visual. */
  rotateToVelocity = 1;
  /** Damage applied to the target's Damageable on hit. > 0 routes through
   *  `Damageable.applyDamage(damage, this, {knockbackX, knockbackY})` —
   *  same path Tracer uses — so iframes / hitstun / OnDamageTaken signals
   *  fire identically. 0 = no auto-damage (author handles damage via the
   *  hitSignal event-sheet wiring). */
  damage = 0;
  /** Horizontal knockback velocity applied to the target on hit. Flipped
   *  by the projectile's facing (positive = the direction the projectile
   *  is heading along +X). 0 = no knockback X. */
  knockbackX = 0;
  /** Vertical knockback velocity applied to the target on hit. Negative
   *  pushes the target up. 0 = no knockback Y. */
  knockbackY = 0;
  /** Homing-mode target uid. Set by FireProjectile at spawn. -1 = no
   *  specific target — falls back to nearest sprite carrying any of
   *  `targetTags`. */
  targetUid = -1;
  /** Homing-mode max turn rate (degrees/sec). Higher = sharper turns. */
  homingTurnRate = 360;
  /** Custom hitbox width (px). 0 = use the body's width (which equals the
   *  BP's W field). Set this to a small value (e.g. 16) when your BP's
   *  visual / body width is much larger than the actual bullet — without
   *  this, the projectile damages anything within `bodyWidth / 2` of its
   *  center. */
  hitboxW = 0;
  /** Custom hitbox height (px). 0 = use the body's height. */
  hitboxH = 0;
  /** Hitbox offset from the bullet center (px) — move the damage / tile-mining
   *  footprint left/right/up/down (e.g. push it to the bullet's tip). */
  hitboxOffsetX = 0;
  hitboxOffsetY = 0;
  /** 1 = draw the actual hitbox rect used by the damage check, as a
   *  magenta dashed outline at runtime. Lets the author see exactly what
   *  area can deal damage, so "why is the bullet damaging from far away"
   *  becomes a 5-second visual check instead of a guessing game. */
  debugDraw = 0;
  private _dbgGfx?: Phaser.GameObjects.Graphics;

  /** True once `launch()` has been called. Movement / lifetime / overlap
   *  checks are no-ops while false — so a scene-placed BP carrying this
   *  behavior sits dormant instead of shooting off the screen on boot.
   *  FireProjectile flips this to true. */
  fired = false;
  /** Current heading in radians. 0 = +X (right). Set by `launch()` and
   *  by the homing turn logic each tick. */
  angleRad = 0;

  private _spawnedAtSec = 0;
  /** UIDs we've already fired the hit signal at. Without this the same
   *  enemy would re-fire the signal every frame for destroyOnHit=0. */
  private readonly _alreadyHit = new Set<number>();

  /** Save: in-flight projectiles round-trip their firing flag, heading,
   *  and current homing target. Without this, a save mid-arc resumed with
   *  fired=false and the projectile sat dormant. (audit HIGH #36) */
  serialize(): Record<string, unknown> | undefined {
    if (!this.fired) return undefined;
    return { fired: this.fired, angleRad: this.angleRad, targetUid: this.targetUid };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.fired === "boolean") this.fired = state.fired;
    if (typeof state.angleRad === "number") this.angleRad = state.angleRad;
    if (typeof state.targetUid === "number") this.targetUid = state.targetUid;
  }

  init(): void {
    // Projectiles ignore world gravity from the scene — they manage
    // their own per-axis gravity field. Without this, scene gravity
    // would add on top of our explicit gravityY and the user would see
    // "double gravity" when they tune it.
    //
    // Also opt out of every physics-engine collision: projectiles use
    // their own AABB overlap loop for hit detection (so authors can
    // gate hits by tag + signal), so we don't want Phaser's collider
    // pairs to grind the projectile to a stop against the ground or
    // bounce it off world bounds. The result is a pure ballistic body
    // that flies until lifetime expires or it scores a tag-filtered hit.
    const body = this.sprite.body;
    if (body) {
      body.setAllowGravity(false);
      body.setCollideWorldBounds(false);
      body.checkCollision.none = true;
    }
  }

  /**
   * Launch this projectile in the given direction. Called by the
   * FireProjectile action right after spawn — stamps the lifetime clock,
   * sets the heading, applies per-shot overrides for speed / target uid,
   * and flips `fired` so update() starts moving it.
   *
   * Calling launch() twice on the same projectile re-fires it from its
   * current position with new params. Useful for "redirect" effects.
   */
  launch(angleRad: number, speedOverride?: number, targetUid?: number): void {
    this._spawnedAtSec = this.sprite.scene.time.now / 1000;
    this.angleRad = angleRad;
    if (speedOverride !== undefined && speedOverride > 0) this.speed = speedOverride;
    if (targetUid !== undefined) this.targetUid = targetUid;
    this.fired = true;
    const body = this.sprite.body;
    if (body) {
      body.setVelocityX(Math.cos(angleRad) * this.speed);
      body.setVelocityY(Math.sin(angleRad) * this.speed);
    }
    if (this.rotateToVelocity) {
      this.sprite.gameObject.rotation = angleRad;
    }
  }

  update(delta: number): void {
    if (!this.fired || this.sprite.destroyed) return;
    const dt = delta / 1000;
    const now = this.sprite.scene.time.now / 1000;

    // Lifetime expiry
    if (this.lifetime > 0 && now - this._spawnedAtSec >= this.lifetime) {
      this.sprite.destroy();
      return;
    }

    const body = this.sprite.body;
    if (!body) return;

    // Homing — rotate angleRad toward the target each tick.
    if (this.mode === "homing") {
      const target = this._resolveTarget();
      if (target) {
        const dx = target.gameObject.x - this.sprite.gameObject.x;
        const dy = target.gameObject.y - this.sprite.gameObject.y;
        const desired = Math.atan2(dy, dx);
        const maxTurn = (this.homingTurnRate * Math.PI / 180) * dt;
        let diff = desired - this.angleRad;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angleRad += Math.max(-maxTurn, Math.min(maxTurn, diff));
      }
    }

    // Apply velocity. Without gravity we lock to `speed` every frame so
    // physics overlaps don't bleed momentum. With gravity, we accumulate
    // the per-axis force onto the existing velocity (arc trajectory).
    if (this.gravityX === 0 && this.gravityY === 0) {
      body.setVelocityX(Math.cos(this.angleRad) * this.speed);
      body.setVelocityY(Math.sin(this.angleRad) * this.speed);
    } else {
      body.setVelocityX(body.velocity.x + this.gravityX * dt);
      body.setVelocityY(body.velocity.y + this.gravityY * dt);
      // Sync angle to velocity so rotateToVelocity tracks the arc.
      this.angleRad = Math.atan2(body.velocity.y, body.velocity.x);
    }

    if (this.rotateToVelocity) {
      this.sprite.gameObject.rotation = this.angleRad;
    }

    if (this.collideTiles && this._checkTileHit()) {
      // The bullet center (self.x/self.y) is reported as-is. To clear the WHOLE
      // hitbox (not just the center cell — which can be empty on an edge hit),
      // the signal handler should use MineTileAtWorld with w/h set to the
      // bullet's hitbox size (a w×h box centered at self.x/self.y).
      const ev = this.sprite.events;
      ev.emit("OnProjectileTileHit");
      if (this.tileHitSignal) ev.emit(this.tileHitSignal);
      if (this.destroyOnHit) { this.sprite.destroy(); return; }
    }

    this._checkOverlaps();
    this._drawDebug();
  }

  /** True when the projectile's hitbox overlaps a solid tile in any registered
   *  tilemap layer. Samples the hitbox center + four corners so a fast bullet
   *  doesn't slip past a tile. Solidity comes from the layer's own
   *  `setCollision` indices (same flags sprites collide against), so non-solid
   *  background tiles are ignored. */
  private _checkTileHit(): boolean {
    const layers = this.sprite.scene.data.get("peaky.tilemapLayers") as
      | Phaser.Tilemaps.TilemapLayer[] | undefined;
    if (!layers || layers.length === 0) return false;
    const body = this.sprite.body;
    const cx = this.sprite.gameObject.x + this.hitboxOffsetX;
    const cy = this.sprite.gameObject.y + this.hitboxOffsetY;
    const w = this.hitboxW > 0 ? this.hitboxW : (body?.width ?? 0);
    const h = this.hitboxH > 0 ? this.hitboxH : (body?.height ?? 0);
    const hw = w / 2, hh = h / 2;
    const pts: Array<[number, number]> = [
      [cx, cy],
      [cx - hw, cy - hh], [cx + hw, cy - hh],
      [cx - hw, cy + hh], [cx + hw, cy + hh],
    ];
    for (const layer of layers) {
      for (const [px, py] of pts) {
        const tile = layer.getTileAtWorldXY(px, py);
        if (tile && tile.collides) return true;
      }
    }
    return false;
  }

  private _drawDebug(): void {
    if (!this.debugDraw) {
      if (this._dbgGfx) this._dbgGfx.clear();
      return;
    }
    if (!this._dbgGfx) {
      this._dbgGfx = this.sprite.scene.add.graphics();
      this.sprite.routeOverlayToCamera(this._dbgGfx);
    }
    const myBody = this.sprite.body;
    if (!myBody) return;
    let x: number, y: number, w: number, h: number;
    if (this.hitboxW > 0 || this.hitboxH > 0) {
      w = this.hitboxW > 0 ? this.hitboxW : myBody.width;
      h = this.hitboxH > 0 ? this.hitboxH : myBody.height;
      x = this.sprite.gameObject.x + this.hitboxOffsetX - w / 2;
      y = this.sprite.gameObject.y + this.hitboxOffsetY - h / 2;
    } else {
      x = myBody.x + this.hitboxOffsetX;
      y = myBody.y + this.hitboxOffsetY;
      w = myBody.width;
      h = myBody.height;
    }
    this._dbgGfx.setDepth(this.sprite.gameObject.depth + 6);
    this._dbgGfx.clear();
    this._dbgGfx.lineStyle(1.5, 0xff3aa8, 0.95);
    this._dbgGfx.strokeRect(x, y, w, h);
  }

  onDestroy(): void {
    this._dbgGfx?.destroy();
    this._dbgGfx = undefined;
  }

  /** Resolve which sprite the homing projectile should chase. Priority:
   *  1) explicit targetUid (set by FireProjectile at spawn);
   *  2) nearest sprite carrying any of `targetTags`. */
  private _resolveTarget(): Sprite | undefined {
    // Explicit uid wins (snapshot from FireProjectile). Uid lookup goes
    // through the scene's uid index — O(1) instead of a linear scan.
    if (this.targetUid > 0) {
      const byUid = this.sprite.scene.data.get("peaky.spritesByUid") as Map<number, Sprite> | undefined;
      const s = byUid?.get(this.targetUid);
      return s && !s.destroyed ? s : undefined;
    }
    const tagList = this._parseTags();
    if (tagList.length === 0) return undefined;
    // Tag-driven homing: union the per-tag Set across every configured
    // tag, then pick nearest. Was O(N) per tag per tick — at 5000 sprites
    // with one tag, 5000 ops PER BULLET PER FRAME. Tag index drops it to
    // (sum of per-tag set sizes) iterations — typically <50 even with
    // huge swarms because only target-tagged sprites are in the candidates.
    let best: Sprite | undefined;
    let bestDist = Infinity;
    const sx = this.sprite.gameObject.x;
    const sy = this.sprite.gameObject.y;
    const seen = tagList.length > 1 ? new Set<Sprite>() : null;
    for (const t of tagList) {
      const candidates = getSpritesByTag(this.sprite.scene, t);
      for (const s of candidates) {
        if (s.destroyed || s === this.sprite) continue;
        if (seen) { if (seen.has(s)) continue; seen.add(s); }
        const dx = s.gameObject.x - sx;
        const dy = s.gameObject.y - sy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = s; }
      }
    }
    return best;
  }

  /** Cache of the last-parsed `targetTags` — `_parseTags` runs every tick (homing
   *  target resolve + overlap check), so re-splitting the string each frame was
   *  needless GC. Re-parses only when `targetTags` actually changes (e.g. a
   *  SetBehaviorParam at runtime). */
  private _tagCacheSrc = "\0";
  private _tagCache: string[] = [];
  private _parseTags(): string[] {
    if (this.targetTags !== this._tagCacheSrc) {
      this._tagCacheSrc = this.targetTags;
      this._tagCache = this.targetTags.split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    }
    return this._tagCache;
  }

  /** Per-tick AABB overlap check against every sprite carrying one of the
   *  target tags. On first match per uid, emit `hitSignal` on both sides
   *  and (when configured) destroy self.
   *
   *  Empty `targetTags` short-circuits the whole loop: no tags = no hit
   *  detection, regardless of `destroyOnHit`. Otherwise a projectile
   *  spawned at `self.x, self.y` (on top of the player) would instantly
   *  overlap the player on the first tick and self-destroy. Authors must
   *  set targetTags to opt into auto-hit/destroy. */
  private _checkOverlaps(): void {
    const tagList = this._parseTags();
    if (tagList.length === 0) return;
    const all = (this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const myBody = this.sprite.body;
    if (!myBody) return;
    // Hitbox: by default the projectile's full body AABB. When hitboxW/H
    // are set, use a smaller rect centered on the sprite's GameObject —
    // lets the author keep a large visual / wide body for ground physics
    // while only damaging targets within e.g. 16x16 of the bullet's tip.
    let myRect: Phaser.Geom.Rectangle;
    if (this.hitboxW > 0 || this.hitboxH > 0) {
      const w = this.hitboxW > 0 ? this.hitboxW : myBody.width;
      const h = this.hitboxH > 0 ? this.hitboxH : myBody.height;
      const cx = this.sprite.gameObject.x + this.hitboxOffsetX;
      const cy = this.sprite.gameObject.y + this.hitboxOffsetY;
      myRect = new Phaser.Geom.Rectangle(cx - w / 2, cy - h / 2, w, h);
    } else {
      myRect = new Phaser.Geom.Rectangle(myBody.x + this.hitboxOffsetX, myBody.y + this.hitboxOffsetY, myBody.width, myBody.height);
    }
    for (const s of all) {
      if (s.destroyed || s === this.sprite) continue;
      if (this._alreadyHit.has(s.uid)) continue;
      if (!tagList.some((t) => s.tags.has(t))) continue;
      const other = s.body;
      if (!other) continue;
      const otherRect = new Phaser.Geom.Rectangle(other.x, other.y, other.width, other.height);
      if (!Phaser.Geom.Intersects.RectangleToRectangle(myRect, otherRect)) continue;

      this._alreadyHit.add(s.uid);
      if (this.hitSignal) {
        this.sprite.events.emit(this.hitSignal);
        s.events.emit(this.hitSignal);
      }
      // Damage + knockback path — mirrors Tracer's auto-damage so
      // OnDamageTaken fires on the target identically. Damage > 0 routes
      // through Damageable.applyDamage so iframes / hitstun gates apply
      // and CharacterMovement can't clobber the knockback velocity.
      // Damage = 0 means "no auto-damage; just knockback" — applied
      // directly to the body since Damageable.applyDamage early-returns
      // on amount <= 0.
      const headingSign = Math.cos(this.angleRad) >= 0 ? 1 : -1;
      const kx = this.knockbackX * headingSign;
      const ky = this.knockbackY;
      const dmgable = s.findBehaviorByKind("Damageable") as
        | { applyDamage?: (amount: number, src?: Sprite, opts?: { knockbackX?: number; knockbackY?: number }) => boolean }
        | undefined;
      if (this.damage > 0 && dmgable?.applyDamage) {
        dmgable.applyDamage(this.damage, this.sprite, { knockbackX: kx, knockbackY: ky });
      } else if (kx !== 0 || ky !== 0) {
        if (kx !== 0) other.setVelocityX(kx);
        if (ky !== 0) other.setVelocityY(ky);
      }
      if (this.destroyOnHit) {
        this.sprite.destroy();
        return;
      }
    }
  }
}
