import Phaser from "phaser";
import { Behavior } from "../Behavior";

/**
 * Marks a sprite as immovable terrain. Other (non-Solid) sprites collide against it.
 */
export class Solid extends Behavior {
  kind = "Solid";
  /** 1 = draw the immovable body outline at runtime as a teal dashed rect
   *  so authors can verify where the wall/floor's physical surface
   *  actually sits relative to the visible art. The most common cause of
   *  "character sinks into the ground" is a Collider on the ground that
   *  resized the body smaller than the visible rect — debug viz makes
   *  that immediately obvious. Off by default. */
  debugDraw = 0;
  private _gfx?: Phaser.GameObjects.Graphics;

  init(): void {
    if (!this.sprite.body) return;
    this.sprite.body.setImmovable(true);
    this.sprite.body.setAllowGravity(false);
  }

  update(_delta: number): void {
    if (!this.debugDraw) {
      if (this._gfx) this._gfx.clear();
      return;
    }
    if (!this._gfx) {
      this._gfx = this.sprite.scene.add.graphics();
      this.sprite.routeOverlayToCamera(this._gfx);
    }
    const body = this.sprite.body;
    if (!body) { this._gfx.clear(); return; }
    this._gfx.setDepth(this.sprite.gameObject.depth + 6);
    this._gfx.clear();
    this._gfx.lineStyle(1.5, 0x2ad8c0, 0.95);
    this._gfx.strokeRect(body.x, body.y, body.width, body.height);
  }

  onDestroy(): void {
    this._gfx?.destroy();
    this._gfx = undefined;
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, _alpha: number, visible: boolean): void {
    if (!this._gfx) return;
    this._gfx.setScrollFactor(scrollX, scrollY);
    this._gfx.setDepth(baseDepth + 6);
    this._gfx.setVisible(visible);
  }
}
