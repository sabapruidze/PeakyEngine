import { Behavior } from "../Behavior";

/**
 * One-way platform — sprites can JUMP THROUGH it from below, but LAND on it
 * from above. Implemented via Phaser's per-side collision flags: only the
 * platform's TOP face accepts contact; left, right, and bottom pass through.
 *
 * The CMFallThrough action sets a per-frame sentinel on the player so they
 * temporarily bypass any jump-thru they're standing on (drops them through).
 */
export class JumpThru extends Behavior {
  kind = "JumpThru";
  init(): void {
    const body = this.sprite.body;
    body.setImmovable(true);
    body.setAllowGravity(false);
    body.checkCollision.up = true;
    body.checkCollision.down = false;
    body.checkCollision.left = false;
    body.checkCollision.right = false;
  }
}
