import Phaser from "phaser";

/**
 * Scene-level manager for "gib" chunks spawned by the Dismemberment behavior.
 * Installed once per scene on `scene.data` under `GIB_KEY`. The behavior looks
 * it up to register each spawned chunk; this manager owns their per-tick
 * visual spin + lifetime cleanup so the chunks keep flying / fading even after
 * the host sprite that spawned them is gone.
 *
 * Cleanup modes (per-gib, taken from the spawning behavior's config):
 *   - "time"      — fade over `fadeSec` once age exceeds `lifetimeSec`, then destroy.
 *   - "offscreen" — destroy the moment the chunk is fully outside the camera's
 *                   worldView (no fade — it's not visible anyway).
 *   - "pool"      — a global FIFO cap. When the live gib count exceeds `maxGibs`,
 *                   the OLDEST overflow chunks start fading+destroying. Each
 *                   gib carries its own `maxGibs`; the largest cap among the
 *                   currently-live pool gibs wins (so two behaviors with
 *                   different caps don't fight).
 *
 * Tick + cleanup are driven from runProject (Phaser SHUTDOWN + UPDATE hooks),
 * mirroring how DialogueRunner / DialogFlowRunner are ticked.
 */
export const GIB_KEY = "peaky.gibs";

export type GibCleanup = "time" | "offscreen" | "pool";

interface GibRecord {
  img: Phaser.GameObjects.Image;
  /** Sim-relative age in seconds, accumulated from the scaled delta passed to update(). */
  ageSec: number;
  lifetimeSec: number;
  fadeSec: number;
  cleanup: GibCleanup;
  maxGibs: number;
  /** Visual spin in degrees/second applied to img.angle each tick. */
  spinDegPerSec: number;
  /** Base alpha the chunk renders at before any fade is applied. */
  baseAlpha: number;
  /** Set once a fade-out has begun; counts up to fadeSec then the gib is destroyed. */
  fading: boolean;
  fadeElapsed: number;
  /** Monotonic spawn order — used for FIFO pool eviction (lowest = oldest). */
  order: number;
}

export class GibManager {
  private readonly scene: Phaser.Scene;
  private readonly gibs: GibRecord[] = [];
  private _orderCounter = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Register a freshly-spawned gib Image. The Image must already have its
   *  physics body + initial velocity set by the caller; this manager only
   *  drives spin + cleanup. */
  add(opts: {
    img: Phaser.GameObjects.Image;
    lifetimeSec: number;
    fadeSec: number;
    cleanup: GibCleanup;
    maxGibs: number;
    spinDegPerSec: number;
  }): void {
    this.gibs.push({
      img: opts.img,
      ageSec: 0,
      lifetimeSec: Math.max(0, opts.lifetimeSec),
      fadeSec: Math.max(0, opts.fadeSec),
      cleanup: opts.cleanup,
      maxGibs: Math.max(1, Math.floor(opts.maxGibs)),
      spinDegPerSec: opts.spinDegPerSec,
      baseAlpha: opts.img.alpha,
      fading: false,
      fadeElapsed: 0,
      order: this._orderCounter++,
    });
  }

  /** Per-tick driver. `dtSec` is the SCALED sim delta (seconds) so a paused /
   *  slowed scene holds / slows the gibs (matching every other gameplay clock). */
  update(dtSec: number): void {
    if (this.gibs.length === 0) return;
    const cam = this.scene.cameras?.main;
    const view = cam?.worldView;

    // Pool eviction — figure out how many of the currently-live gibs are in
    // "pool" mode, and start fading the oldest overflow. The cap is the max
    // maxGibs among live pool gibs so mixed configs don't thrash.
    let poolCap = 0;
    let poolCount = 0;
    for (const g of this.gibs) {
      if (g.cleanup !== "pool") continue;
      poolCount += 1;
      if (g.maxGibs > poolCap) poolCap = g.maxGibs;
    }
    if (poolCap > 0 && poolCount > poolCap) {
      // Oldest-first: gibs already in spawn order, so collect the non-fading
      // pool gibs sorted by `order` and fade the front overflow.
      const livePool = this.gibs
        .filter((g) => g.cleanup === "pool" && !g.fading)
        .sort((a, b) => a.order - b.order);
      const overflow = poolCount - poolCap;
      for (let i = 0; i < overflow && i < livePool.length; i++) {
        livePool[i].fading = true;
        livePool[i].fadeElapsed = 0;
      }
    }

    for (let i = this.gibs.length - 1; i >= 0; i--) {
      const g = this.gibs[i];
      const img = g.img;
      // Image may have been destroyed externally (scene teardown race).
      if (!img.scene) {
        this.gibs.splice(i, 1);
        continue;
      }

      g.ageSec += dtSec;

      // Physics feel: airborne chunks tumble at their spawn spin, but once a
      // chunk rests on the ground we bleed off both the spin and the horizontal
      // slide so it settles like real debris instead of pirouetting / gliding
      // forever (arcade bodies have no friction, so a landed body keeps its vx).
      const body = img.body as Phaser.Physics.Arcade.Body | null;
      const grounded = !!body && (body.blocked.down || body.touching.down);
      if (grounded && body) {
        g.spinDegPerSec *= Math.pow(0.0025, dtSec);
        if (Math.abs(g.spinDegPerSec) < 6) g.spinDegPerSec = 0;
        body.velocity.x *= Math.pow(0.0008, dtSec);
        if (Math.abs(body.velocity.x) < 4) body.velocity.x = 0;
      }
      if (g.spinDegPerSec !== 0) img.angle += g.spinDegPerSec * dtSec;

      // offscreen — destroy as soon as the chunk leaves the visible world view.
      if (g.cleanup === "offscreen" && view) {
        const b = img.getBounds();
        if (!Phaser.Geom.Intersects.RectangleToRectangle(b, view)) {
          this._destroy(i);
          continue;
        }
      }

      // time — begin fading once the lifetime elapses.
      if (g.cleanup === "time" && !g.fading && g.ageSec >= g.lifetimeSec) {
        g.fading = true;
        g.fadeElapsed = 0;
      }

      if (g.fading) {
        if (g.fadeSec <= 0) {
          this._destroy(i);
          continue;
        }
        g.fadeElapsed += dtSec;
        const t = Math.min(1, g.fadeElapsed / g.fadeSec);
        img.setAlpha(g.baseAlpha * (1 - t));
        if (t >= 1) {
          this._destroy(i);
          continue;
        }
      }
    }
  }

  /** Destroy a single gib by index (caller has the index from a reverse loop). */
  private _destroy(idx: number): void {
    const g = this.gibs[idx];
    if (g) {
      try { g.img.destroy(); } catch { /* already gone */ }
      this.gibs.splice(idx, 1);
    }
  }

  /** Destroy every live gib. Called on scene shutdown so chunks don't leak
   *  across RestartLayout / GoToLayout (Phaser keeps scene.data otherwise). */
  destroyAll(): void {
    for (const g of this.gibs) {
      try { g.img.destroy(); } catch { /* already gone */ }
    }
    this.gibs.length = 0;
  }
}

/** Convenience lookup used by the Dismemberment behavior. */
export function getGibManager(scene: Phaser.Scene): GibManager | undefined {
  return scene.data.get(GIB_KEY) as GibManager | undefined;
}
