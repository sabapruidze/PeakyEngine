import Phaser from "phaser";
import { Behavior } from "../Behavior";

/**
 * Collision-shape behavior. Gives the host Sprite a rectangular Arcade body
 * of `width` × `height`, offset by (offsetX, offsetY) from its centre.
 *
 * Circle and capsule shapes are removed — Arcade Physics circle-vs-rect
 * collision jitters due to unstable penetration-depth resolution. They will
 * return if/when the engine switches to Matter.js.
 *
 * Multiple Colliders aren't supported — the last one attached wins, since
 * Phaser bodies are 1:1 with their gameObject.
 */
export class Collider extends Behavior {
  kind = "Collider";
  width = 32;
  height = 48;
  offsetX = 0;
  offsetY = 0;
  /** 1 = body collides with the scene's outer bounds; 0 = free to leave the screen. */
  collideWorldBounds = 1;
  /** 1 = bodies pass through each other (overlap-only — events still fire,
   *  but no physical pushback). 0 = bodies block each other (Phaser
   *  resolves the collision by pushing them apart).
   *
   *  Default 1 because most casual collisions are pickup / hitbox checks
   *  (coin, trigger, projectile) where bodies should NOT shove each
   *  other. Set 0 to make this Collider block on contact (e.g. a Player
   *  bumping another solid character without using the Solid behavior). */
  passThrough = 1;
  /** 1 = draw the body rect as an orange dashed outline at runtime so
   *  authors can see exactly where the physics body sits relative to the
   *  sprite during Play. The editor's "● Colliders" toggle only affects
   *  the editor; this drives the in-game overlay. Off by default — flip
   *  on while tuning hitbox shape, then off for the polished build. */
  debugDraw = 0;
  private lastWorldBounds = -1;
  private _gfx?: Phaser.GameObjects.Graphics;

  init(): void {
    this.applyShape();
  }

  /** Re-applied each frame so runtime SetBehaviorParam tweaks take effect. */
  update(_delta: number): void {
    this.applyShape();
    this.drawDebug();
  }

  onDestroy(): void {
    this._gfx?.destroy();
    this._gfx = undefined;
  }

  private applyShape(): void {
    const body = this.sprite.body;
    if (!body) return;
    const obj  = this.sprite.gameObject;

    if (this.collideWorldBounds !== this.lastWorldBounds) {
      body.setCollideWorldBounds(this.collideWorldBounds !== 0);
      this.lastWorldBounds = this.collideWorldBounds;
    }

    // When the SpriteRenderer's "Use Frame Collider" is on, the body tracks the
    // DISPLAYED frame's per-frame collider (the sprite's own hitbox) instead of
    // the fixed width/height — so an animation can grow/shrink the hitbox and a
    // multi-frame sprite gets the right shape per frame.
    const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as
      | { frameColliderRect?: () => { w: number; h: number; offX: number; offY: number } | null }
      | undefined;
    const fcr = sr?.frameColliderRect?.() ?? null;
    const w  = fcr ? Math.max(1, fcr.w) : Math.max(1, this.width);
    const h  = fcr ? Math.max(1, fcr.h) : Math.max(1, this.height);
    const userOffX = fcr ? fcr.offX : this.offsetX;
    const userOffY = fcr ? fcr.offY : this.offsetY;
    body.setSize(w, h, false);
    // Body is centered on the gameObject, then shifted by the user's
    // explicit (offsetX, offsetY). What you set in the BP preview's
    // drag/resize handles is exactly the runtime body — no pivot magic,
    // no anchor abstraction. WYSIWYG.
    const ox = (obj.width  - w) / 2 + userOffX;
    const oy = (obj.height - h) / 2 + userOffY;
    body.setOffset(ox, oy);
  }

  private drawDebug(): void {
    if (!this.debugDraw) {
      if (this._gfx) {
        this._gfx.clear();
      }
      return;
    }
    if (!this._gfx) {
      this._gfx = this.sprite.scene.add.graphics();
      // Routed to the host's camera so the overlay follows main vs UI cam
      // and isn't double-drawn — same pattern as Tracer / SpriteRenderer.
      this.sprite.routeOverlayToCamera(this._gfx);
    }
    const body = this.sprite.body;
    if (!body) { this._gfx.clear(); return; }
    this._gfx.setDepth(this.sprite.gameObject.depth + 6);
    this._gfx.clear();
    this._gfx.lineStyle(1.5, 0xff9a28, 0.9);
    this._gfx.strokeRect(body.x, body.y, body.width, body.height);
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, _alpha: number, visible: boolean): void {
    if (!this._gfx) return;
    this._gfx.setScrollFactor(scrollX, scrollY);
    this._gfx.setDepth(baseDepth + 6);
    this._gfx.setVisible(visible);
  }
}
