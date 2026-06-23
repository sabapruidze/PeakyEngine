import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import { getGibManager, GibCleanup } from "../GibManager";
import type { Sprite } from "../Sprite";
import type { SpriteRenderer } from "./SpriteRenderer";

/**
 * Dismemberment — slices the host's CURRENT sprite frame into rectangular
 * "gib" chunks on trigger and launches each as an arcade-physics Image that
 * flies off, collides with the world, and is reaped by the scene's GibManager.
 *
 * Phase 1:
 *   - Regions are authored numerically (name + x/y/w/h in frame-local pixels)
 *     and shown as a read-only overlay in the BP preview.
 *   - The host's displayed texture (SpriteRenderer overlay) is cropped per
 *     region. No SpriteRenderer / no texture → falls back to a small colored
 *     rectangle per region so the effect still fires.
 *   - Facing/flip of the host is NOT mirrored onto the chunks (noted for Phase 2).
 *
 * Trigger:
 *   - `dismember()` (public) — fired by the Dismember action.
 *   - `fireSignal` — when set, init() subscribes to that EventBus signal on the
 *     host so e.g. "OnDeath" auto-dismembers.
 *
 * No `enabled`-style inspector field, so the §11.1 enabled-clobber footgun
 * doesn't apply here.
 */
export interface DismemberRegion {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type LaunchMode = "burst" | "drop" | "directional" | "random";

export class Dismemberment extends Behavior {
  kind = "Dismemberment";

  /** Rectangular regions in the sprite frame's LOCAL pixel coords. */
  regions: DismemberRegion[] = [];

  /** Which animation+frame the regions are authored against and sliced from —
   *  the dismemberment ALWAYS cuts this fixed pose, regardless of which
   *  animation is live when it fires. Empty `refAnimation` = the SpriteRenderer's
   *  init pose (frame 0 of its configured animation). */
  refAnimation = "";
  refFrame = 0;

  launch: LaunchMode = "burst";
  /** Used by `directional` — 270 = up in screen coords (y-down). */
  angleDeg = 270;
  /** Cone width (degrees) for directional / drop spread. */
  spreadDeg = 60;
  speedMin = 120;
  speedMax = 300;
  /** Visual angular velocity range (deg/s) applied to each chunk's rotation. */
  spinMin = -360;
  spinMax = 360;
  gravity = 900;
  bounce = 0.3;

  cleanup: GibCleanup = "time";
  lifetimeSec = 4;
  fadeSec = 0.5;
  maxGibs = 50;

  /** 0/1 — collide chunks with Solids / tilemap. */
  collideWorld = 1;
  /** 0/1 — hide the host gameObject + SpriteRenderer overlay on dismember. */
  hideHost = 1;
  /** When set, auto-dismember when this signal fires on the host's EventBus. */
  fireSignal = "";

  /** True once this behavior has dismembered — guards against double-fire
   *  (a manual action AND the signal in the same frame). */
  private _dismembered = false;
  private _unsub?: () => void;

  init(): void {
    this._dismembered = false;
    Logger.log({
      level: "log",
      source: "Dismemberment",
      message: `attached — ${Array.isArray(this.regions) ? this.regions.length : 0} region(s); fireSignal=${this.fireSignal || "(none — use the Dismember action)"}.`,
    });
    if (this.fireSignal) {
      this._unsub = this.sprite.events.on(this.fireSignal, () => this.dismember());
    }
  }

  /** Perform the slice + spawn. Idempotent — only the first call does work. */
  dismember(): void {
    if (this._dismembered) {
      Logger.log({ level: "warn", source: "Dismemberment", message: "dismember() ignored — already dismembered this run." });
      return;
    }

    const sprite = this.sprite;
    const scene = sprite.scene;
    const obj = sprite.gameObject;
    if (!obj || !obj.scene) {
      Logger.log({ level: "warn", source: "Dismemberment", message: "dismember() aborted — host gameObject is gone." });
      return;
    }

    const regions = Array.isArray(this.regions) ? this.regions : [];
    if (regions.length === 0) {
      Logger.log({ level: "warn", source: "Dismemberment", message: "dismember() did nothing — no regions defined. Add at least one region in the Dismemberment component." });
      return;
    }

    // Commit the one-shot guard only now that we're actually slicing — an
    // early no-op (no regions / host gone) must NOT brick future real calls.
    this._dismembered = true;

    const sr = sprite.findBehaviorByKind("SpriteRenderer") as SpriteRenderer | undefined;
    const tex = this._resolveTexture(sr);
    Logger.log({ level: "log", source: "Dismemberment", message: `dismember() firing — ${regions.length} region(s), pose=${this.refAnimation || "(SpriteRenderer init pose)"} frame ${this.refFrame}, texture=${tex.key ?? "FALLBACK-RECT"}, frame=${tex.dispW}x${tex.dispH}, source=${tex.srcW}x${tex.srcH}.` });

    // Effective display scale = physics-body scale × the instance size override
    // baked into the sprite frame. Regions are authored in RAW frame px (the BP
    // preview space); this converts them to the exact on-screen geometry so the
    // chunks line up 1:1 with the visible sprite even when the instance is sized.
    const hostScaleX = (obj.scaleX || 1) * tex.renderScaleX;
    const hostScaleY = (obj.scaleY || 1) * tex.renderScaleY;
    const cleanupColliders = this.collideWorld ? this._collectWorldColliderTargets(sprite) : [];
    const gibMgr = getGibManager(scene);

    for (const region of regions) {
      // Clip the authored region to the frame bounds so a rect dragged past an
      // edge (negative x/y, or extending beyond the frame w/h) only ever cuts
      // REAL frame pixels. Without this, the slice's start got clamped to the
      // edge but kept its full size — pulling in neighboring pixels (e.g. a
      // hair region dragged 3px above the frame grabbed hair + the head below).
      let rx = Number(region.x) || 0;
      let ry = Number(region.y) || 0;
      let rw = Math.max(1, Number(region.w) || 1);
      let rh = Math.max(1, Number(region.h) || 1);
      if (rx < 0) { rw += rx; rx = 0; }
      if (ry < 0) { rh += ry; ry = 0; }
      if (rx + rw > tex.dispW) rw = tex.dispW - rx;
      if (ry + rh > tex.dispH) rh = tex.dispH - ry;
      if (rw < 1 || rh < 1) continue; // region is entirely outside the frame

      // Region center in frame-local pixels, relative to the frame pivot, then
      // scaled by host scale to land at the correct world offset.
      const localCx = rx + rw / 2 - tex.pivotX;
      const localCy = ry + rh / 2 - tex.pivotY;
      const worldX = obj.x + localCx * hostScaleX;
      const worldY = obj.y + localCy * hostScaleY;

      let img: Phaser.GameObjects.Image;
      if (tex.key) {
        // Slice the region into a real sub-frame of the source texture, so the
        // chunk Image IS exactly that piece (origin 0.5) and arcade derives a
        // body that matches the visible chunk. (setCrop keeps the full frame
        // dimensions, which left the physics body centered on the whole sprite
        // and misaligned from the visible piece — chunks then clipped through
        // tiles because their real body was elsewhere.)
        //
        // Regions are authored in the frame's LOGICAL size (dispW×dispH); the
        // texture source pixels may be a different resolution, so map the slice
        // rect by the ratio. Without this, low-res-art-shown-big slices a tiny
        // clamped sliver at the edge (the "dark slivers" bug).
        const texture = scene.textures.get(tex.key);
        const ratioX = tex.dispW > 0 ? tex.srcW / tex.dispW : 1;
        const ratioY = tex.dispH > 0 ? tex.srcH / tex.dispH : 1;
        const tx = rx * ratioX;
        const ty = ry * ratioY;
        const tw = rw * ratioX;
        const th = rh * ratioY;
        Logger.log({ level: "log", source: "Dismemberment",
          message: `  region "${String(region.name ?? "")}" raw(${rx},${ry},${rw},${rh}) → slice(${Math.round(tx)},${Math.round(ty)},${Math.round(tw)},${Math.round(th)}) of src ${tex.srcW}x${tex.srcH} [disp ${tex.dispW}x${tex.dispH}, pivot ${tex.pivotX},${tex.pivotY}]` });
        const frameName = `__gib_${Math.round(tx)}_${Math.round(ty)}_${Math.round(tw)}_${Math.round(th)}`;
        if (!texture.has(frameName)) {
          // Phaser's Texture.add() repoints `firstFrame` to the new sub-frame
          // when the texture previously had only __BASE. This shared sprite
          // texture is used by EVERY NPC of this BP, and SpriteRenderer
          // re-applies it via setTexture(key) (no explicit frame → uses
          // firstFrame) on each anim frame — so after one NPC dismembers, the
          // others render this tiny gib region stretched full-size for a frame
          // (the "giant head" flicker). Restore firstFrame after adding.
          const prevFirst = texture.firstFrame;
          texture.add(
            frameName, 0,
            Math.max(0, Math.min(tx, tex.srcW - 1)),
            Math.max(0, Math.min(ty, tex.srcH - 1)),
            Math.max(1, Math.min(tw, tex.srcW - tx)),
            Math.max(1, Math.min(th, tex.srcH - ty)),
          );
          texture.firstFrame = prevFirst;
        }
        img = scene.add.image(worldX, worldY, tex.key, frameName);
        img.setOrigin(0.5, 0.5);
        img.setDisplaySize(rw * hostScaleX, rh * hostScaleY);
      } else {
        // Fallback: no texture — spawn a small colored rect the size of the region.
        const color = (obj as Phaser.GameObjects.Rectangle).fillColor ?? 0xffffff;
        const rt = scene.add.rectangle(worldX, worldY, rw * hostScaleX, rh * hostScaleY, color);
        // Use a 1x1 white texture image isn't needed — but the GibManager and
        // physics path want an Image. Bake the rect to a texture key and swap.
        // Simpler: keep the rectangle as a GameObject with a body; arcade
        // supports any GameObject. Cast to Image-compatible for the manager.
        scene.physics.add.existing(rt);
        const body = rt.body as Phaser.Physics.Arcade.Body;
        this._launchBody(body, sprite, obj, worldX, worldY);
        this._wireCollision(rt, cleanupColliders);
        if (gibMgr) {
          gibMgr.add({
            img: rt as unknown as Phaser.GameObjects.Image,
            lifetimeSec: this.lifetimeSec,
            fadeSec: this.fadeSec,
            cleanup: this.cleanup,
            maxGibs: this.maxGibs,
            spinDegPerSec: this._randSpin(),
          });
        }
        continue;
      }

      img.setDepth(obj.depth + 2);
      sprite.routeOverlayToCamera(img);
      img.setScrollFactor(obj.scrollFactorX, obj.scrollFactorY);

      scene.physics.add.existing(img);
      const body = img.body as Phaser.Physics.Arcade.Body;
      // Default body == the sub-frame (rw×rh source px), auto-scaled by the
      // image's display scale → it tracks the visible chunk. No manual setSize.
      this._launchBody(body, sprite, obj, worldX, worldY);
      this._wireCollision(img, cleanupColliders);

      if (gibMgr) {
        gibMgr.add({
          img,
          lifetimeSec: this.lifetimeSec,
          fadeSec: this.fadeSec,
          cleanup: this.cleanup,
          maxGibs: this.maxGibs,
          spinDegPerSec: this._randSpin(),
        });
      }
    }

    if (this.hideHost) {
      obj.setVisible(false);
      // Hide the SpriteRenderer overlay too (it's a separate GameObject).
      const overlay = (sr as unknown as { overlay?: Phaser.GameObjects.Image } | undefined)?.overlay;
      if (overlay) { overlay.setVisible(false); overlay.setAlpha(0); }
    }
  }

  /** Resolve the host's current displayed texture key + frame source size +
   *  pivot from the SpriteRenderer. Returns an empty key when there's no
   *  textured frame (the caller then uses the colored-rect fallback). */
  private _resolveTexture(sr: SpriteRenderer | undefined): {
    key: string | undefined;
    /** Texture source resolution (the actual PNG pixels we slice from). */
    srcW: number; srcH: number;
    /** RAW author/display frame size — the space regions + pivot are authored
     *  in (BP preview's unscaled pixels). */
    dispW: number; dispH: number;
    pivotX: number; pivotY: number;
    /** Per-instance size override baked into the displayed sprite. World
     *  placement/size multiplies obj.scale by this so chunks match the visible
     *  (instance-scaled) sprite, not the raw frame. */
    renderScaleX: number; renderScaleY: number;
  } {
    const obj = this.sprite.gameObject;
    const fallback = {
      key: undefined as string | undefined,
      srcW: obj.width, srcH: obj.height,
      dispW: obj.width, dispH: obj.height,
      pivotX: obj.width / 2, pivotY: obj.height / 2,
      renderScaleX: 1, renderScaleY: 1,
    };
    if (!sr) return fallback;
    // Slice the FIXED reference pose the regions were authored against (the one
    // the BP preview shows), not whatever animation is live at death — otherwise
    // the regions land on a different-sized/posed frame.
    const ref = sr.referenceFrame(this.refAnimation || undefined, this.refFrame);
    const scene = this.sprite.scene;
    if (!ref || !scene.textures.exists(ref.key)) return fallback;
    const src = scene.textures.get(ref.key).getSourceImage() as { width?: number; height?: number };
    const srcW = src.width ?? ref.w;
    const srcH = src.height ?? ref.h;
    // ref.* are RAW frame px (instance scale divided out). The slice maps raw→
    // texture via srcW/dispW; world placement re-applies renderScale × obj.scale.
    return {
      key: ref.key, srcW, srcH, dispW: ref.w, dispH: ref.h,
      pivotX: ref.pivotX, pivotY: ref.pivotY,
      renderScaleX: ref.renderScaleX, renderScaleY: ref.renderScaleY,
    };
  }

  /** Apply gravity, bounce, and the per-launch-mode impulse to a chunk body. */
  private _launchBody(
    body: Phaser.Physics.Arcade.Body,
    sprite: Sprite,
    obj: Phaser.GameObjects.Rectangle,
    worldX: number,
    worldY: number,
  ): void {
    body.setAllowGravity(true);
    body.setGravityY(this.gravity);
    body.setBounce(this.bounce, this.bounce);

    const speed = this._rand(this.speedMin, this.speedMax);
    const ang = this._launchAngleRad(obj, worldX, worldY);
    body.setVelocity(Math.cos(ang) * speed, Math.sin(ang) * speed);
  }

  /** Direction (radians) for a chunk, per the launch mode. Screen coords are
   *  y-down, so 270° / -90° points up. */
  private _launchAngleRad(obj: Phaser.GameObjects.Rectangle, worldX: number, worldY: number): number {
    const D2R = Math.PI / 180;
    switch (this.launch) {
      case "burst": {
        // Radial: from host center to the region center. Degenerate (center)
        // chunks get a random direction so they don't stack.
        const dx = worldX - obj.x;
        const dy = worldY - obj.y;
        if (dx === 0 && dy === 0) return Math.random() * Math.PI * 2;
        return Math.atan2(dy, dx);
      }
      case "drop": {
        // Downward (90°) ± small spread.
        const spread = (this.spreadDeg || 0) * D2R;
        return Math.PI / 2 + (Math.random() - 0.5) * spread;
      }
      case "directional": {
        const spread = (this.spreadDeg || 0) * D2R;
        return this.angleDeg * D2R + (Math.random() - 0.5) * spread;
      }
      case "random":
      default:
        return Math.random() * Math.PI * 2;
    }
  }

  private _rand(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.random() * (max - min);
  }

  private _randSpin(): number {
    return this._rand(this.spinMin, this.spinMax);
  }

  /** Collect the static world geometry a chunk should collide with: tilemap
   *  layers, custom-shape static groups, and live Solid sprites' bodies.
   *  Mirrors Game.ts's per-sprite world-collision wiring. */
  private _collectWorldColliderTargets(sprite: Sprite): Phaser.GameObjects.GameObject[] {
    const scene = sprite.scene;
    const targets: Phaser.GameObjects.GameObject[] = [];
    const layers = (scene.data.get("peaky.tilemapLayers") as Phaser.GameObjects.GameObject[] | undefined) ?? [];
    for (const l of layers) targets.push(l);
    const groups = (scene.data.get("peaky.tilemapStaticGroups") as Phaser.Physics.Arcade.StaticGroup[] | undefined) ?? [];
    for (const g of groups) targets.push(g as unknown as Phaser.GameObjects.GameObject);
    const live = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of live) {
      if (s.destroyed) continue;
      if (s === sprite) continue;
      if (s.findBehaviorByKind("Solid") && s.gameObject) targets.push(s.gameObject);
    }
    return targets;
  }

  private _wireCollision(go: Phaser.GameObjects.GameObject, targets: Phaser.GameObjects.GameObject[]): void {
    if (targets.length === 0) return;
    const scene = this.sprite.scene;
    for (const t of targets) {
      try {
        scene.physics.add.collider(
          go,
          t as Phaser.Types.Physics.Arcade.ArcadeColliderType,
        );
      } catch { /* a destroyed / invalid target — skip */ }
    }
  }

  onDestroy(): void {
    if (this._unsub) { this._unsub(); this._unsub = undefined; }
  }
}
