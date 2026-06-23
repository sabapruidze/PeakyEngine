import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";

/**
 * VisionMask — invisible "vision sphere" attached to a BP (typically the
 * player). A screen-space RenderTexture has a (optionally feathered) circle
 * drawn at the host's screen position each frame; it's wrapped in a
 * BitmapMask applied to every occluder so the circle carves a PIXEL-PERFECT
 * HOLE through trees / walls / tilemap layers / sprites. The rest of each
 * occluder stays fully opaque.
 *
 * Fields:
 *   - `radius`         — px. Size of the sphere.
 *   - `featherPx`      — px. Soft-edge band on the outer ring (0 = hard).
 *   - `cutoutOpacity`  — opacity occluders fall to inside the circle. 0 = fully
 *                        cut (invisible inside), 0.5 = ghosted, 1 = no effect.
 *                        With `invert: 1` it controls the opacity OUTSIDE.
 *   - `excludeTags`    — comma-separated tag list. Tagged objects are left
 *                        alone (so "ground" can keep the floor solid).
 *   - `cutoutLayers`   — comma-separated scene-layer NAMES. When non-empty,
 *                        only occluders on one of the listed scene layers
 *                        are affected. Empty = every layer eligible.
 *   - `invert`         — 0/1. Flips: occluders stay visible INSIDE the circle,
 *                        and the rest of the screen darkens to `cutoutOpacity`
 *                        (spotlight / night-vision look).
 *
 * Mask-eligible objects:
 *   - Entries published to `scene.data["peaky.bigTileImages"]` by
 *     TilemapRenderer: BigTile placements, per-tile Y-sort images, and whole
 *     non-Y-sort TilemapLayers. Each entry carries its tag list + the owning
 *     tilemap's scene layerId.
 *   - All Sprites in `scene.data["peaky.sprites"]` and every visual overlay
 *     owned by their behaviors. The host sprite itself is always skipped.
 *
 * Multi-VisionMask note: Phaser's `setMask` is single-slot per GameObject.
 * Two VisionMasks active at once → the last one to tick wins on any given
 * occluder. v1 does not compose.
 */
type MaskableEntry = {
  img: Phaser.GameObjects.GameObject;
  tags: string[];
  layerId?: string;
  wholeLayer?: boolean;
};

export class VisionMask extends Behavior {
  kind = "VisionMask";
  radius = 80;
  featherPx = 0;
  cutoutOpacity = 0;
  excludeTags = "";
  /** Comma-separated scene-layer NAMES; only occluders on these layers get
   *  affected. Empty = all layers eligible (default). The runtime resolves
   *  IDs → names via `scene.data["peaky.layerIdToName"]`, populated by
   *  runProject at scene boot. */
  cutoutLayers = "";
  invert = 0;
  /** World-axis offset from the host origin to the mask center. Authored
   *  visually via the BP preview gizmo; writable at runtime via
   *  SetBehaviorParam. */
  centerOffsetX = 0;
  centerOffsetY = 0;
  /** Sprite asset id whose ALPHA drives the mask shape instead of the built-in
   *  circle. Empty = circle. runProject resolves it to `_maskTextureKey` (static)
   *  or `_maskFrameKeys`/`_maskFrameDurations` (animation). */
  maskSpriteId = "";
  /** "static" = freeze on `maskFrame` of `maskAnimation`; "animation" = cycle
   *  the chosen animation's frames over time (an animated reveal shape). */
  maskSpriteMode = "static";
  /** Which animation of the mask sprite to use (name). Empty = first. */
  maskAnimation = "";
  /** Static-mode frame index within `maskAnimation`. */
  maskFrame = 0;
  /** Mirror the mask shape horizontally with the host's facing (facingScaleX). */
  maskMirror = 0;

  private _maskRT?: Phaser.GameObjects.RenderTexture;
  private _maskGfx?: Phaser.GameObjects.Graphics;
  private _bitmapMask?: Phaser.Display.Masks.BitmapMask;
  private _maskedObjs = new Set<Phaser.GameObjects.GameObject>();
  /** Cached radial-gradient texture (HTML5 createRadialGradient) used as the
   *  soft-feather circle. Phaser Graphics has no native radial gradient so
   *  we bake one to a CanvasTexture and stamp it. Re-baked only when feather
   *  proportion changes. */
  private _gradTexKey?: string;
  private _gradImg?: Phaser.GameObjects.Image;
  private _gradLastRatio = -1;
  /** Texture key injected by runProject from `maskSpriteId` (static-mode frame).
   *  Present ⇒ stamp this sprite's alpha as the mask shape. */
  private _maskTextureKey?: string;
  /** Animation-mode frame keys + per-frame durations (seconds), injected by
   *  runProject. `_maskAnimTime` accumulates sim time to pick the frame. */
  private _maskFrameKeys?: string[];
  private _maskFrameDurations?: number[];
  private _maskAnimTime = 0;
  private _shapeImg?: Phaser.GameObjects.Image;
  /** The inspector "Enabled" toggle, captured in init() BEFORE runProject
   *  clobbers `this.enabled` with the component-chip's enabled (the §11.1
   *  footgun). All on/off logic gates on this, not `this.enabled`. Set at
   *  runtime by the SetVisionMask node. */
  private _maskOn = true;

  init(): void {
    this._maskOn = !!this.enabled;
  }

  update(_delta: number): void {
    if (!this._maskOn) {
      this._clearAllMasks();
      return;
    }
    // _delta is already scene-timeScale-adjusted, so a paused / slowed world
    // freezes / slows the animated mask shape too.
    this._maskAnimTime += _delta / 1000;
    const excl = this.excludeTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    this._tickCutout(excl);
  }

  // ── Cutout tick ────────────────────────────────────────────────────────
  private _tickCutout(excl: string[]): void {
    const scene = this.sprite.scene;
    this._ensureMaskRT();
    if (!this._bitmapMask) return;
    this._redrawMask();

    const layerNames = this.cutoutLayers
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const idToName = (scene.data.get("peaky.layerIdToName") as Map<string, string> | undefined) ?? new Map<string, string>();

    const seen = new Set<Phaser.GameObjects.GameObject>();
    const considerImage = (img: Phaser.GameObjects.GameObject, tags: readonly string[], layerId: string | undefined) => {
      if (!img.scene) return;
      seen.add(img);
      const excluded = excl.length > 0 && tags.some((t) => excl.includes(t));
      const wrongLayer = layerNames.length > 0 && (
        layerId === undefined || !layerNames.includes(idToName.get(layerId) ?? "")
      );
      if (excluded || wrongLayer) {
        if (this._maskedObjs.has(img)) this._clearMaskFrom(img);
        return;
      }
      this._applyMaskIfNeeded(img);
    };

    const bigTileEntries = (scene.data.get("peaky.bigTileImages") as MaskableEntry[] | undefined) ?? [];
    for (const e of bigTileEntries) considerImage(e.img, e.tags, e.layerId);

    const sprites = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of sprites) {
      if (s === this.sprite) continue;
      if (!s.gameObject) continue;
      const tags = Array.from(s.tags);
      considerImage(s.gameObject, tags, s.layerId);
      for (const b of s.getBehaviors()) {
        const ov = (b as { overlay?: Phaser.GameObjects.GameObject }).overlay;
        if (ov) considerImage(ov, tags, s.layerId);
      }
    }

    // Drop masks from objects that vanished from any registry this tick so
    // stale references don't hold a mask after the source object goes away.
    for (const obj of this._maskedObjs) {
      if (seen.has(obj)) continue;
      if (!obj.scene) { this._maskedObjs.delete(obj); continue; }
      this._clearMaskFrom(obj);
    }
  }

  // ── Mask plumbing ──────────────────────────────────────────────────────
  private _ensureMaskRT(): void {
    const scene = this.sprite.scene;
    const cam = scene.cameras.main;
    // The RT lives in WORLD space (scrollFactor 1): its top-left is pinned to
    // the camera's world-view origin each frame and its internal pixels map
    // 1:1 to world units, so we draw the reveal in (world − view) coordinates
    // and let the camera transform (scroll / zoom / directional offset /
    // bounds clamp) place it at render time. That cancels the worldView term
    // entirely — the reveal can't drift when the camera locks at a layout edge
    // or runs an offset/deadzone. Size tracks the world-view (= screen px at
    // zoom 1) so the invert fill always covers exactly the visible area.
    const zoom = cam.zoom || 1;
    const vw = Math.max(1, Math.ceil(cam.worldView.width || cam.width / zoom));
    const vh = Math.max(1, Math.ceil(cam.worldView.height || cam.height / zoom));
    if (!this._maskRT) {
      this._maskRT = scene.add.renderTexture(0, 0, vw, vh);
      this._maskRT.setOrigin(0, 0);
      this._maskRT.setVisible(false);
    } else if (this._maskRT.width !== vw || this._maskRT.height !== vh) {
      this._maskRT.setSize(vw, vh);
    }
    if (!this._maskGfx) {
      this._maskGfx = scene.make.graphics({ x: 0, y: 0 }, false);
    }
    if (!this._bitmapMask) {
      this._bitmapMask = this._maskRT.createBitmapMask();
    }
  }

  /** Bake a 256×256 HTML5 Canvas radial-gradient texture whose alpha is 1
   *  out to `solidRatio` of the texture radius and falls smoothly to 0 at
   *  the edge. Re-baked only when `solidRatio` changes — radius / feather /
   *  zoom changes are absorbed by re-scaling the stamped Image. */
  private _ensureGradientTexture(solidRatio: number): void {
    const scene = this.sprite.scene;
    const SIZE = 256;
    // Quantize ratio so tiny float jitter doesn't trigger re-bakes.
    const r2 = Math.max(0, Math.min(1, Math.round(solidRatio * 1000) / 1000));
    if (this._gradTexKey && this._gradLastRatio === r2) return;
    if (this._gradTexKey && scene.textures.exists(this._gradTexKey)) {
      scene.textures.remove(this._gradTexKey);
    }
    const key = `visionmask:grad:${(this.sprite as { uid?: number }).uid ?? Math.random()}:${r2}`;
    const tex = scene.textures.createCanvas(key, SIZE, SIZE);
    if (!tex) return;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, SIZE, SIZE);
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const outerR = SIZE / 2;
    const innerR = Math.min(outerR - 0.5, outerR * r2);
    const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
    tex.refresh();
    this._gradTexKey = key;
    this._gradLastRatio = r2;
    if (this._gradImg) {
      this._gradImg.setTexture(key);
    }
  }

  /** Resolve which texture key to stamp this frame. Static mode → the single
   *  injected `_maskTextureKey`. Animation mode → the frame of `_maskFrameKeys`
   *  selected by `_maskAnimTime` against the per-frame durations (looping). */
  private _currentShapeKey(): string | undefined {
    if (this.maskSpriteMode !== "animation") return this._maskTextureKey;
    const keys = this._maskFrameKeys;
    const durs = this._maskFrameDurations;
    if (!keys || keys.length === 0) return this._maskTextureKey;
    if (keys.length === 1) return keys[0] || this._maskTextureKey;
    const total = (durs ?? []).reduce((a, b) => a + (b > 0 ? b : 0), 0);
    if (total <= 0) return keys[0] || this._maskTextureKey;
    let t = this._maskAnimTime % total;
    for (let i = 0; i < keys.length; i++) {
      const d = (durs && durs[i] > 0) ? durs[i] : 0.0001;
      if (t < d) return keys[i] || this._maskTextureKey;
      t -= d;
    }
    return keys[keys.length - 1] || this._maskTextureKey;
  }

  private _redrawMask(): void {
    if (!this._maskRT || !this._maskGfx || !this._bitmapMask) return;
    const scene = this.sprite.scene;
    const cam = scene.cameras.main;
    const view = cam.worldView;
    const host = this.sprite.gameObject as Phaser.GameObjects.GameObject & { x: number; y: number };
    // Pin the RT to the world-view origin, then draw everything in WORLD units
    // relative to it. radius / feather are world units now (no `* zoom`) — the
    // camera applies zoom at render. The (world − view) offset cancels the view
    // term against the render transform, so the reveal tracks the host exactly.
    this._maskRT.setPosition(view.x, view.y);
    // Mirror with facing: flip the horizontal OFFSET (so the whole reveal —
    // circle, gradient, or sprite — swings to the other side when the host
    // faces left), and additionally flip the sprite texture below. Applies to
    // the default circle too, not just sprite shapes.
    const hostFacing = (this.sprite as { facingScaleX?: number }).facingScaleX ?? 1;
    const mirrorMul = (this.maskMirror && hostFacing < 0) ? -1 : 1;
    const cx = host.x + this.centerOffsetX * mirrorMul;
    const cy = host.y + this.centerOffsetY;
    const lx = cx - view.x;
    const ly = cy - view.y;
    const r = this.radius;
    const feather = Math.max(0, Math.min(this.radius, this.featherPx));
    const cutoutOpacity = Math.max(0, Math.min(1, this.cutoutOpacity));
    const invert = !!this.invert;

    this._maskRT.clear();
    this._maskGfx.clear();

    //   non-invert (hole): RT cleared = alpha 0 everywhere (outside circle →
    //     object visible). Draw circle alpha = (1 - cutoutOpacity) at host →
    //     invertAlpha=true → object_alpha inside = cutoutOpacity.
    //   invert (spotlight): fill RT alpha = cutoutOpacity (outside dim),
    //     stamp circle alpha 1 at host → invertAlpha=false → inside fully
    //     visible, outside at cutoutOpacity.
    //
    // The shape is either a sprite-alpha stamp (maskSpriteId set), a hard
    // fillCircle (feather=0), or a baked radial-gradient texture. The stamp's
    // `alpha` scales the whole shape, which is how cutoutOpacity controls the
    // inner core strength in non-invert mode.

    const innerCoreAlpha = invert ? 1 : (1 - cutoutOpacity);

    if (invert && cutoutOpacity > 0) {
      this._maskGfx.fillStyle(0xffffff, cutoutOpacity);
      this._maskGfx.fillRect(0, 0, this._maskRT.width, this._maskRT.height);
      this._maskRT.draw(this._maskGfx);
      this._maskGfx.clear();
    }

    const shapeKey = this._currentShapeKey();
    const useSprite = !!shapeKey && scene.textures.exists(shapeKey);

    if (innerCoreAlpha > 0 && r > 0 && useSprite) {
      // Sprite-alpha shape: opaque pixels reveal, transparent stay masked. The
      // sprite is fit into the radius*2 box (preserving its aspect) so `radius`
      // still controls overall size; feather is ignored for sprite shapes.
      const tex = scene.textures.get(shapeKey!);
      const src = tex.getSourceImage() as { width?: number; height?: number };
      const sw = src.width || 1;
      const sh = src.height || 1;
      const aspect = sw / sh;
      const boxH = r * 2;
      const boxW = boxH * aspect;
      if (!this._shapeImg) {
        this._shapeImg = scene.make.image({ key: shapeKey!, add: false });
        this._shapeImg.setOrigin(0.5, 0.5);
      } else {
        this._shapeImg.setTexture(shapeKey!);
      }
      this._shapeImg.setPosition(lx, ly);
      this._shapeImg.setDisplaySize(boxW, boxH);
      // Flip the texture too when mirroring (origin 0.5 → flips about center).
      if (mirrorMul < 0) this._shapeImg.scaleX = -Math.abs(this._shapeImg.scaleX);
      this._shapeImg.setAlpha(innerCoreAlpha);
      this._maskRT.draw(this._shapeImg);
    } else if (innerCoreAlpha > 0 && r > 0) {
      if (feather <= 0) {
        this._maskGfx.fillStyle(0xffffff, innerCoreAlpha);
        this._maskGfx.fillCircle(lx, ly, r);
        this._maskRT.draw(this._maskGfx);
      } else {
        // Solid-core ratio: 0 = pure gradient, 1 = solid circle. The baked
        // texture handles the smooth fall-off; we just scale + position it.
        const solidRatio = Math.max(0, (r - feather) / r);
        this._ensureGradientTexture(solidRatio);
        if (this._gradTexKey) {
          if (!this._gradImg) {
            this._gradImg = scene.make.image({ key: this._gradTexKey, add: false });
            this._gradImg.setOrigin(0.5, 0.5);
          } else {
            this._gradImg.setTexture(this._gradTexKey);
          }
          this._gradImg.setPosition(lx, ly);
          // Display size 2r so the texture's outer edge (alpha 0) lands at
          // exactly `radius` from the center (world units).
          this._gradImg.setDisplaySize(r * 2, r * 2);
          // Scale the whole gradient's alpha by the requested core strength.
          // Setting it on the Image (not the draw call's alpha arg) — Phaser
          // honors the GameObject's alpha during RT.draw; the alpha arg only
          // works reliably when entry is a texture KEY, not a GameObject.
          this._gradImg.setAlpha(innerCoreAlpha);
          this._maskRT.draw(this._gradImg);
        }
      }
    }

    this._bitmapMask.invertAlpha = !invert;
  }

  private _applyMaskIfNeeded(obj: Phaser.GameObjects.GameObject): void {
    if (!this._bitmapMask) return;
    if (this._maskedObjs.has(obj)) return;
    (obj as Phaser.GameObjects.GameObject & { setMask?: (m: Phaser.Display.Masks.BitmapMask) => void }).setMask?.(this._bitmapMask);
    this._maskedObjs.add(obj);
  }

  private _clearMaskFrom(obj: Phaser.GameObjects.GameObject): void {
    (obj as Phaser.GameObjects.GameObject & { clearMask?: () => void }).clearMask?.();
    this._maskedObjs.delete(obj);
  }

  private _clearAllMasks(): void {
    for (const obj of this._maskedObjs) {
      if (!obj.scene) continue;
      (obj as Phaser.GameObjects.GameObject & { clearMask?: () => void }).clearMask?.();
    }
    this._maskedObjs.clear();
  }

  onDestroy(): void {
    this._clearAllMasks();
    if (this._maskGfx) { try { this._maskGfx.destroy(); } catch { /* ignore */ } this._maskGfx = undefined; }
    if (this._gradImg) { try { this._gradImg.destroy(); } catch { /* ignore */ } this._gradImg = undefined; }
    if (this._shapeImg) { try { this._shapeImg.destroy(); } catch { /* ignore */ } this._shapeImg = undefined; }
    if (this._maskRT)  { try { this._maskRT.destroy();  } catch { /* ignore */ } this._maskRT  = undefined; }
    if (this._gradTexKey) {
      const scene = this.sprite.scene;
      if (scene?.textures?.exists(this._gradTexKey)) {
        try { scene.textures.remove(this._gradTexKey); } catch { /* ignore */ }
      }
      this._gradTexKey = undefined;
      this._gradLastRatio = -1;
    }
    // A BitmapMask owns its own WebGL framebuffer pair — it is NOT freed by
    // destroying the source RenderTexture, so it must be destroyed explicitly
    // or it leaks GPU memory for the GL context's lifetime (every player
    // death/respawn or scene reload otherwise leaks one framebuffer pair).
    if (this._bitmapMask) { try { this._bitmapMask.destroy(); } catch { /* ignore */ } }
    this._bitmapMask = undefined;
  }
}
