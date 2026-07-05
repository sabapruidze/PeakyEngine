import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";

/** Outline / highlight on the host's visible sprite. The hard outline is a true
 *  STROKE — 8 tinted silhouette copies offset N/NE/E/SE/S/SW/W/NW by `thickness`
 *  px, whose union is a uniform ring around the art (NOT a scaled copy, which
 *  reads as a lopsided drop-shadow when the sprite's pivot is off-centre).
 *  Optional soft GLOW is a few additive silhouette copies scaled up from the
 *  sprite's CENTRE so it spreads symmetrically. No postFX/shader — draws on any
 *  renderer, follows animated frames + per-instance scale/rotation. Toggle `on`
 *  at runtime via Set Component Param (e.g. On Object Hovered → Outline.on = 1). */
export class Outline extends Behavior {
  /** Registration key — without this it defaults to "" and
   *  findBehaviorByKind("Outline") (used by Set Component Param) can't find it. */
  kind = "Outline";
  /** 1 = outline visible. Runtime-toggleable (Set Component Param). */
  on = 1;
  /** Outline colour (hex 0xRRGGBB). */
  color = 0xffe24a;
  /** Outline width in pixels (each side). */
  thickness = 4;
  /** 0..1 outline alpha. */
  opacity = 1;
  /** 1 = pulse the thickness in and out. */
  pulse = 0;
  /** Pulse cycles per second. */
  pulseSpeed = 2;
  /** 1 = add a soft, feathered GLOW behind the hard outline. Additive silhouette
   *  copies scaled up from the sprite centre — no shader, draws on any renderer. */
  glow = 0;
  /** Glow colour (hex 0xRRGGBB). */
  glowColor = 0xffe24a;
  /** How far the glow reaches BEYOND the outline edge, in px. */
  glowSize = 12;
  /** Peak glow strength 0..1. */
  glowOpacity = 0.6;
  /** Edge softness 0..1. Higher = the glow spreads more evenly outward (softer,
   *  more diffuse); lower = it hugs the outline (tighter, harder falloff). */
  feather = 0.7;

  /** Unit offsets for the 8-way stroke (screen-space; the stroke stays uniform
   *  regardless of sprite rotation). Diagonals at length 1 slightly over-fill
   *  corners, which reads better than leaving them gapped. */
  private static readonly DIRS: readonly (readonly [number, number])[] = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
  ];
  private static readonly GLOW_LAYERS = 4;

  private _stroke: Phaser.GameObjects.Image[] = [];
  private _glow: Phaser.GameObjects.Image[] = [];
  private _t = 0;
  private _diag = false;

  init(): void { this._t = 0; this._diag = false; }

  private _hide(): void {
    for (const s of this._stroke) s.setVisible(false);
    for (const g of this._glow) g.setVisible(false);
  }

  private _overlay(): Phaser.GameObjects.Image | null {
    const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as { overlay?: Phaser.GameObjects.Image } | undefined;
    const ov = sr?.overlay;
    return ov && ov.texture ? ov : null;
  }

  private _route(go: Phaser.GameObjects.GameObject): void {
    (this.sprite as unknown as { routeOverlayToCamera?: (g: unknown) => void }).routeOverlayToCamera?.(go);
  }

  update(delta: number): void {
    // manualHidden = SetVisible 0 on the whole BP → outline vanishes with it.
    if (!this.on || this.sprite.destroyed || this.sprite.manualHidden) { this._hide(); return; }
    const ov = this._overlay();
    if (!ov || !ov.visible) {
      if (!this._diag) {
        this._diag = true;
        Logger.log({ level: "warn", source: "Outline", message: `"${this.sprite.bpName}" has no visible SpriteRenderer sprite to outline yet — the outline copies the sprite art, so the BP needs a SpriteRenderer with a visible frame.` });
      }
      this._hide();
      return;
    }
    const scene = this.sprite.scene;
    const key = ov.texture.key;

    let t = Math.max(0, this.thickness);
    if (this.pulse) {
      this._t += (delta / 1000) * Math.max(0.05, this.pulseSpeed);
      t *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this._t * Math.PI * 2));
    }

    // ── Hard stroke: 8 offset silhouette copies (uniform ring) ───────────────
    const strokeDepth = (ov.depth ?? 0) - 0.5;
    const alpha = this.opacity < 0 ? 0 : this.opacity > 1 ? 1 : this.opacity;
    for (let k = 0; k < Outline.DIRS.length; k++) {
      let s = this._stroke[k];
      if (!s) { s = scene.add.image(ov.x, ov.y, key); this._route(s); this._stroke[k] = s; }
      s.setVisible(true);
      if (s.texture.key !== key) s.setTexture(key);
      s.setTintFill(this.color);
      s.setOrigin(ov.originX, ov.originY);
      s.setScale(ov.scaleX, ov.scaleY);       // match the sprite exactly, just offset
      s.setRotation(ov.rotation);
      s.setDepth(strokeDepth);
      s.setAlpha(alpha);
      const d = Outline.DIRS[k];
      s.setPosition(ov.x + d[0] * t, ov.y + d[1] * t);
    }

    // ── Soft glow: additive copies scaled up from the CENTRE (symmetric) ─────
    if (this.glow && this.glowSize > 0 && this.glowOpacity > 0) {
      const N = Outline.GLOW_LAYERS;
      const glowDepth = (ov.depth ?? 0) - 0.6;
      const soft = Math.max(0, Math.min(1, this.feather));
      const c = ov.getCenter();               // geometric centre (pivot-independent)
      const dw = Math.abs(ov.displayWidth) || 1;
      const dh = Math.abs(ov.displayHeight) || 1;
      for (let i = 0; i < N; i++) {
        let g = this._glow[i];
        if (!g) {
          g = scene.add.image(c.x, c.y, key);
          g.setBlendMode(Phaser.BlendModes.ADD);
          this._route(g);
          this._glow[i] = g;
        }
        g.setVisible(true);
        if (g.texture.key !== key) g.setTexture(key);
        g.setTintFill(this.glowColor);
        g.setOrigin(0.5, 0.5);                 // scale symmetrically from centre
        g.setPosition(c.x, c.y);
        g.setRotation(ov.rotation);
        g.setDepth(glowDepth - i * 0.01);
        const frac = (i + 1) / N;
        const reach = this.glowSize * (frac * soft + (1 - soft) * frac * frac);
        const extent = t + reach;
        g.scaleX = ov.scaleX * (1 + (2 * extent) / dw);
        g.scaleY = ov.scaleY * (1 + (2 * extent) / dh);
        g.setAlpha(this.glowOpacity * (1 - i / N));
      }
    } else if (this._glow.length) {
      for (const g of this._glow) g.setVisible(false);
    }
  }

  onDestroy(): void {
    for (const s of this._stroke) { try { s.destroy(); } catch { /* gone */ } }
    for (const g of this._glow) { try { g.destroy(); } catch { /* gone */ } }
    this._stroke.length = 0;
    this._glow.length = 0;
  }
}
