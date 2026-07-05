import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";

/** Blob / drop shadow under the host. A soft, feathered dark blob (circle or
 *  rectangle) drawn BELOW the sprite. Size, feather, opacity, colour and offset
 *  are authorable (the offset is draggable via a gizmo in the Blueprint
 *  preview). When `groundTag` is set, the shadow SNAPS its Y onto the nearest
 *  ground surface below the host carrying that tag — so a jumping platformer
 *  character leaves its shadow on the ground (optionally shrinking + fading with
 *  height). No shader — a baked feathered texture stamped with NORMAL blend, so
 *  it draws on any renderer. */
export class Shadow extends Behavior {
  /** Registration key — findBehaviorByKind("Shadow") needs it. */
  kind = "Shadow";
  /** 1 = shadow visible. Runtime-toggleable (Set Component Param). */
  on = 1;
  /** "circle" (squashed ellipse) or "rect". */
  shape = "circle";
  /** Shadow width / height in px (the ellipse/rect is stretched to this). */
  width = 48;
  height = 16;
  /** Edge softness 0..1 (0 = crisp, 1 = very soft/blurred). */
  feather = 0.6;
  /** Shadow opacity 0..1. */
  opacity = 0.5;
  /** Shadow colour (hex 0xRRGGBB). Usually black. */
  color = 0x000000;
  /** Offset from the host origin (px). Draggable gizmo in the BP preview. */
  offsetX = 0;
  offsetY = 8;
  /** CSV of tags the shadow snaps its Y onto (e.g. "ground, platform"). Empty =
   *  the shadow just follows the host at the offset (no ground snapping). */
  groundTag = "";
  /** How far DOWN to search for a ground surface, px. */
  maxDrop = 600;
  /** 1 = shrink + fade the shadow the higher the host is above the ground
   *  (classic platformer jump feel). Needs `groundTag`. */
  shrinkWithHeight = 0;

  /** Depth band — just below the host sprite. */
  static readonly DEPTH_OFFSET = -0.4;

  private _img: Phaser.GameObjects.Image | null = null;

  /** Bake (once per shape/feather) a white feathered blob. White so a per-
   *  instance setTint recolours it; alpha carries the soft edge. Quantized so a
   *  slider sweep can't mint hundreds of textures. */
  private static _ensureTex(scene: Phaser.Scene, shape: string, feather: number): string {
    const f = Math.round(Math.max(0, Math.min(1, feather)) * 10) / 10;
    const key = `peaky.shadowTex_${shape}_${Math.round(f * 10)}`;
    if (scene.textures.exists(key)) return key;
    const size = 128;
    const canvas = scene.textures.createCanvas(key, size, size);
    if (!canvas) return key;
    const ctx = canvas.getContext();
    ctx.clearRect(0, 0, size, size);
    // Canvas blur gives a clean feathered edge for both shapes. `pad` keeps the
    // blurred shape from clipping the texture bounds.
    const blur = f * (size / 3.5);
    const pad = Math.max(2, blur * 1.4);
    ctx.fillStyle = "#ffffff";
    try { (ctx as unknown as { filter: string }).filter = `blur(${blur}px)`; } catch { /* older canvas */ }
    if (shape === "rect") {
      ctx.fillRect(pad, pad, size - 2 * pad, size - 2 * pad);
    } else {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - pad, 0, Math.PI * 2);
      ctx.fill();
    }
    try { (ctx as unknown as { filter: string }).filter = "none"; } catch { /* noop */ }
    canvas.refresh();
    canvas.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return key;
  }

  init(): void {
    const scene = this.sprite.scene;
    if (!scene) return;
    const go = this.sprite.gameObject;
    const img = scene.add.image(go.x + this.offsetX, go.y + this.offsetY, Shadow._ensureTex(scene, this.shape, this.feather));
    img.setOrigin(0.5, 0.5);
    img.setDepth((go.depth ?? 0) + Shadow.DEPTH_OFFSET);
    (this.sprite as unknown as { routeOverlayToCamera?: (g: unknown) => void }).routeOverlayToCamera?.(img);
    this._img = img;
  }

  /** Nearest ground-surface TOP Y below the host (within maxDrop) carrying any
   *  of `groundTag`, or null if none. Matches sprites whose body spans the
   *  host's X. */
  private _groundY(scene: Phaser.Scene, px: number, fromY: number): number | null {
    const raw = this.groundTag.trim();
    if (!raw) return null;
    const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) return null;
    const byTag = scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
    if (!byTag) return null;
    let best: number | null = null;
    for (const tag of tags) {
      const set = byTag.get(tag);
      if (!set) continue;
      for (const s of set) {
        if (s === this.sprite || s.destroyed) continue;
        const b = s.body as Phaser.Physics.Arcade.Body | null;
        if (!b) continue;
        if (px < b.x || px > b.x + b.width) continue;   // host not over this surface
        const top = b.y;                                 // ground surface (body top)
        if (top < fromY - 4) continue;                   // must be BELOW the host
        if (top - fromY > this.maxDrop) continue;        // too far down
        if (best === null || top < best) best = top;     // nearest (highest) ground
      }
    }
    return best;
  }

  update(_delta: number): void {
    const img = this._img;
    if (!img) return;
    const scene = this.sprite.scene;
    // Honor the whole-BP hide (SetVisible 0 → sprite.manualHidden) so the shadow
    // vanishes with its owner, not just the sprite art.
    if (!this.on || !scene || this.sprite.manualHidden) { img.setVisible(false); return; }
    img.setVisible(true);

    // Re-bake if shape/feather changed at runtime.
    const key = Shadow._ensureTex(scene, this.shape, this.feather);
    if (img.texture.key !== key) img.setTexture(key);

    const go = this.sprite.gameObject;
    // Fold the host scale so the shadow grows/shrinks + offsets WITH the BP when
    // it's scaled. facingScaleX is the mirror sign, not the scale → abs.
    const sx = (Math.abs(go.scaleX) || 1) * (this.sprite._renderScaleX || 1);
    const sy = (Math.abs(go.scaleY) || 1) * (this.sprite._renderScaleY || 1);
    const px = go.x + this.offsetX * sx;
    const gy = this._groundY(scene, px, go.y);

    let alpha = Math.max(0, Math.min(1, this.opacity));
    let w = Math.max(1, this.width) * sx;
    let h = Math.max(1, this.height) * sy;
    let y: number;
    if (gy !== null) {
      y = gy + this.offsetY * sy;
      // Optional: shrink + fade the higher the host floats above the ground.
      if (this.shrinkWithHeight) {
        const rise = Math.max(0, gy - go.y);
        const factor = Math.max(0.25, 1 - rise / Math.max(1, this.maxDrop));
        w *= factor; h *= factor; alpha *= factor;
      }
    } else {
      y = go.y + this.offsetY * sy;
    }

    img.setPosition(px, y);
    img.setDisplaySize(w, h);
    img.setTint(this.color);
    img.setAlpha(alpha);
    img.setDepth((go.depth ?? 0) + Shadow.DEPTH_OFFSET);
  }

  applyLayer(scrollX: number, scrollY: number, _baseDepth: number, _alpha: number, visible: boolean): void {
    if (this._img) {
      this._img.setScrollFactor(scrollX, scrollY);
      this._img.setVisible(visible && !!this.on && !this.sprite.manualHidden);
    }
  }

  onDestroy(): void {
    if (this._img) { this._img.destroy(); this._img = null; }
  }
}
