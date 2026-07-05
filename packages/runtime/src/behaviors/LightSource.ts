import Phaser from "phaser";
import { Behavior } from "../Behavior";

/** Atmospheric light — a soft additive glow that brightens the darkness around
 *  the host (torch / candle / lamp). A radial-gradient texture is baked once per
 *  edge style and stamped with ADD blend ABOVE the ambient darkness overlay (see
 *  the SetAmbientLight action), so it reveals a lit pool. `edge` picks the rim
 *  look: smooth · hard · noisy · wave. Follows the host; `on`, `radius`,
 *  `intensity`, `color`, `flicker`, `edge`, `feather` are runtime-toggleable. */
export class LightSource extends Behavior {
  /** Registration key — findBehaviorByKind("LightSource") needs it. */
  kind = "LightSource";
  /** 1 = lit. Runtime-toggleable. */
  on = 1;
  /** Glow colour (hex 0xRRGGBB). Warm by default. */
  color = 0xffd9a0;
  /** Glow radius in px. */
  radius = 140;
  /** Brightness 0..1 (centre additive strength). */
  intensity = 1;
  /** Rim style: "smooth" | "hard" | "noisy" | "wave". */
  edge = "smooth";
  /** Edge softness 0..1 for smooth/hard (0 = crisp, 1 = very soft). */
  feather = 0.7;
  /** Noise / wave amplitude 0..1 (only for edge = noisy / wave). */
  edgeAmount = 0.5;
  /** Centre offset from the host origin (px) — the pivot. */
  offsetX = 0;
  offsetY = 0;
  /** Flicker amount 0..1 (0 = steady flame). */
  flicker = 0;
  /** Flicker speed (Hz-ish). */
  flickerSpeed = 9;

  /** Depth band for lights — just above the darkness overlay (see
   *  SetAmbientLight) so the additive glow brightens the dark, below the UI. */
  static DEPTH = 900_001;

  private _img: Phaser.GameObjects.Image | null = null;
  private _t = 0;

  /** Bake (once per edge/feather/amount) a white radial glow. noisy/wave clip
   *  the rim to an organic boundary; the gradient feathers within it. White so a
   *  per-instance setTint recolours it. */
  private static _ensureTex(scene: Phaser.Scene, edge: string, feather: number, amount: number): string {
    // Quantize to 0.1 steps so dragging a slider can't mint a new 256² texture
    // per pixel-value — caps the baked-texture cache at ~11×11×4 instead of
    // 101×101×4 (textures live on the scene for its lifetime, see onDestroy).
    const f = Math.round(Math.max(0, Math.min(1, feather)) * 10) / 10;
    const amt = Math.round(Math.max(0, Math.min(1, amount)) * 10) / 10;
    const key = `peaky.lightTex_${edge}_${Math.round(f * 10)}_${Math.round(amt * 10)}`;
    if (scene.textures.exists(key)) return key;
    const size = 256;
    const canvas = scene.textures.createCanvas(key, size, size);
    if (!canvas) return key;
    const ctx = canvas.getContext();
    const cx = size / 2, cy = size / 2, R = size / 2 - 2;
    ctx.clearRect(0, 0, size, size);
    if (edge === "noisy" || edge === "wave") {
      ctx.save();
      ctx.beginPath();
      const steps = 240;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const ripple = edge === "wave"
          ? Math.cos(a * 8)
          : (0.6 * Math.sin(a * 7 + 1.3) + 0.3 * Math.sin(a * 13 + 0.7) + 0.2 * Math.sin(a * 23 + 2.1));
        const rr = R * (1 - amt * 0.32 * (0.5 - 0.5 * ripple));
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.clip();
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    if (edge === "hard") {
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(Math.min(0.97, 1 - f * 0.25), "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      const solid = 1 - f;
      g.addColorStop(0, "rgba(255,255,255,1)");
      if (solid > 0) g.addColorStop(Math.min(0.99, solid), "rgba(255,255,255,0.85)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    if (edge === "noisy" || edge === "wave") ctx.restore();
    canvas.refresh();
    canvas.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return key;
  }

  init(): void {
    const scene = this.sprite.scene;
    if (!scene) return;
    const go = this.sprite.gameObject;
    const img = scene.add.image(go.x + this.offsetX, go.y + this.offsetY, LightSource._ensureTex(scene, this.edge, this.feather, this.edgeAmount));
    img.setOrigin(0.5, 0.5);
    img.setBlendMode(Phaser.BlendModes.ADD);
    img.setDepth(LightSource.DEPTH);
    this.sprite.routeOverlayToCamera(img);
    this._img = img;
    this._t = 0;
  }

  update(delta: number): void {
    const img = this._img;
    if (!img) return;
    const scene = this.sprite.scene;
    // Honor the whole-BP hide (SetVisible 0 → sprite.manualHidden).
    if (!this.on || !scene || this.sprite.manualHidden) { img.setVisible(false); return; }
    img.setVisible(true);
    // Re-bake if edge style changed at runtime (Set Component Param).
    const key = LightSource._ensureTex(scene, this.edge, this.feather, this.edgeAmount);
    if (img.texture.key !== key) img.setTexture(key);
    const go = this.sprite.gameObject;
    img.x = go.x + this.offsetX;
    img.y = go.y + this.offsetY;
    img.setDisplaySize(this.radius * 2, this.radius * 2);
    img.setTint(this.color);
    let inten = this.intensity;
    if (this.flicker > 0) {
      this._t += (delta / 1000) * this.flickerSpeed;
      const wob = 0.5 * Math.sin(this._t) + 0.5 * Math.sin(this._t * 2.3 + 1.7);
      inten *= 1 - this.flicker * 0.5 * (1 + wob);
    }
    img.setAlpha(Math.max(0, Math.min(1, inten)));
    img.setDepth(LightSource.DEPTH);
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
