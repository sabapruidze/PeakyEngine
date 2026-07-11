import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";

/**
 * Construct 3-style TiledBackground: renders a single sprite texture
 * repeated infinitely across a rectangular area as ONE draw call.
 *
 * Two scroll modes:
 *  - `followCamera` — tilePosition tracks the host's layer-relative camera
 *    scroll so the texture appears to extend infinitely. Combined with the
 *    layer's parallax, this is the standard parallax sky / mountains layer.
 *    `parallaxFactor` is an extra multiplier on top of the layer parallax
 *    (lets you have multiple loops on ONE layer at different speeds, e.g.
 *    foreground tree silhouettes drift faster than the sky behind them).
 *  - `autoScroll` — fixed pixels/sec drift in X and Y. Independent of the
 *    camera; clouds, water surface, conveyor belts, scrolling shop banner.
 *
 * The host BP's rectangle stays as the physics body (so the BP can still
 * carry tags, colliders, instance vars). The visual is the TileSprite
 * overlay routed to the BP's camera + layer depth.
 */
export class TiledBackground extends Behavior {
  kind = "TiledBackground";

  /** Sprite asset id whose chosen-animation frames are tiled. */
  spriteId = "";

  /** Animation name within the sprite asset (e.g., "idle", "flow"). Empty
   *  → first animation. Lets a single sprite asset drive different tiled
   *  backgrounds via per-instance animation override. */
  currentAnimation = "";

  /** 1 = play frames over time (animated tile, like flowing water); 0 =
   *  freeze on `startFrame`. Defaults to playing for back-compat with
   *  the original single-frame behavior — first frame just renders forever. */
  playing = 1;

  /** Static-frame index used when `playing = 0`. Mirrors SpriteRenderer's
   *  pose semantics. */
  startFrame = 0;

  /** Injected by runProject: ordered list of texture keys for every frame
   *  of the chosen animation. The shader-swap during animation walks
   *  through this list. */
  _frameKeys: string[] = [];

  /** Injected by runProject: frame-by-frame durations in seconds (so an
   *  author-set per-frame duration overrides the animation's base fps). */
  _frameDurations: number[] = [];

  /** Internal animation state. */
  private _animTimeAcc = 0;
  private _animFrameIdx = 0;

  /** Width / height of the tiled region in pixels. `0` on either axis means
   *  "auto-fill the camera viewport on that axis" — resolved each tick so a
   *  camera zoom or window resize stays covered. */
  width = 0;
  height = 0;

  /** Scroll mode — drives how tilePositionX/Y change each tick. */
  mode: "followCamera" | "autoScroll" = "followCamera";

  /** followCamera mode: parallax multiplier per axis.
   *  - 0   = locked to camera (perfect static skybox)
   *  - 0.05 = far mountains / clouds (barely drift)
   *  - 0.5 = mid-distance scenery
   *  - 1   = locked to the world (matches camera 1:1)
   *  - >1  = foreground push (moves faster than world)
   *
   *  Separate X and Y so authors can configure horizontal-only parallax
   *  (sideways scrolling levels — sky scrolls horizontally but stays
   *  put when player jumps up). `parallaxFactor` (legacy) seeds both if
   *  per-axis fields aren't set in saved projects.
   */
  parallaxFactor = 1;
  parallaxFactorX = 1;
  parallaxFactorY = 1;

  /** autoScroll mode only: pixels per second the texture drifts. Positive
   *  X = right, positive Y = down. */
  scrollSpeedX = 0;
  scrollSpeedY = 0;

  /** Flip the tile direction. Useful for some "ambidextrous" textures (a
   *  cliff face that should mirror, water that flows the other way) without
   *  needing a flipped variant in the asset. */
  flipX = 0;
  flipY = 0;

  /** Per-axis tile / repeat toggles. When OFF, the texture's WebGL wrap
   *  mode for that axis is `CLAMP_TO_EDGE` instead of `REPEAT`, so the
   *  background DOES NOT loop on that axis even if the tile sprite area
   *  extends beyond the texture's natural dimensions. Useful for finite-
   *  height parallax backgrounds (mountains / horizon-band) where the
   *  X axis should tile infinitely but the Y axis must show exactly one
   *  copy (no faint repeats at the top of the viewport). */
  tileX = 1;
  tileY = 1;

  /** Injected by runProject — the resolved Phaser texture key for `spriteId`.
   *  Lookup happens once at attach time; runtime doesn't reach into project
   *  state itself. Empty = no sprite chosen (falls back to a 1×1 white tile
   *  so the area is still visible as a colored block during authoring). */
  _textureKey?: string;

  /** Per-tick accumulator for autoScroll mode. Tracking it separately from
   *  the tile's actual tilePosition lets us snap+reset cleanly on mode swap. */
  private _scrollAccX = 0;
  private _scrollAccY = 0;

  /** The Phaser TileSprite that does the actual tiling render. Created in
   *  init(). Phaser handles the infinite repeat natively via tilePosition. */
  overlay?: Phaser.GameObjects.TileSprite;

  /** Cached layer state — read by applyLayer, applied to overlay when it
   *  exists (or when it's late-created). */
  private _layerAlpha = 1;
  private _layerVisible = true;
  private _layerScrollX = 1;
  private _layerScrollY = 1;
  private _layerBaseDepth = 0;

  init(): void {
    const scene = this.sprite.scene;
    // Pick the starting texture: if static-frame mode AND frames are
    // available, use the configured startFrame; if animated, use the
    // first frame. Falls back to the legacy `_textureKey` (still
    // populated by runProject for single-anim assets) when no frames
    // list was supplied. Final fallback is Phaser's white pixel so the
    // tile is visible during authoring even when assets are missing.
    let initialKey: string | undefined;
    if (this._frameKeys.length > 0) {
      const idx = !this.playing
        ? Math.max(0, Math.min(this._frameKeys.length - 1, Math.floor(this.startFrame)))
        : 0;
      this._animFrameIdx = idx;
      initialKey = this._frameKeys[idx];
    }
    const key = (initialKey && scene.textures.exists(initialKey))
      ? initialKey
      : (this._textureKey && scene.textures.exists(this._textureKey))
        ? this._textureKey
        : "__WHITE";
    if (!this._textureKey) {
      Logger.log({
        level: "warn",
        source: "TiledBackground",
        message: "TiledBackground has no Sprite asset selected — falling back to a white tile so the area stays visible.",
      });
    }
    // Read the texture's natural dimensions — used below to constrain the
    // tile sprite size on axes where the user disabled tiling. Phaser
    // TileSprite renders via its own tiling shader that IGNORES the GL
    // wrap mode, so the only reliable way to stop a tile from looping on
    // an axis is to size that axis to the texture's natural extent so
    // the shader has nothing to tile over.
    let texW = 256, texH = 256;
    try {
      const tex = scene.textures.get(key);
      const src = tex.source[0];
      texW = src.width || 256;
      texH = src.height || 256;
    } catch { /* texture race — defaults are fine */ }
    // Auto axes are sized to the CAMERA VIEWPORT (padded ×2, capped) — NOT
    // a "vast" constant. Phaser's TileSprite allocates an internal canvas at
    // the FULL requested size in its constructor (even in WebGL mode), so a
    // 65536×65536 request is a multi-GB allocation past Chrome's 65535 max
    // canvas dimension — it froze the tab on boot. The infinite scroll comes
    // from tilePosition, not sprite size (Phaser docs: never make a
    // TileSprite larger than the canvas). update() grows it if a zoom-out
    // ever exposes more area than this.
    const cam = scene.cameras.main;
    const vw = Math.min(8192, Math.ceil((cam?.displayWidth || scene.scale.width || 1024) * 2));
    const vh = Math.min(8192, Math.ceil((cam?.displayHeight || scene.scale.height || 768) * 2));
    // Per-axis size resolution:
    //  - User set explicit width/height → honor it.
    //  - Otherwise: viewport-sized if tiling enabled (tilePosition repeats),
    //    texture natural size if tiling disabled (so the shader has nothing
    //    to tile = no looping on that axis).
    const w = this.width > 0 ? this.width : (this.tileX ? vw : texW);
    const h = this.height > 0 ? this.height : (this.tileY ? vh : texH);
    // Default (auto-fill) parks the tile at the screen center — update()
    // re-centers it on the camera every tick. Authored finite sizes anchor
    // at the BP's position (banner / strip / window).
    const autoFill = this.width <= 0 && this.height <= 0;
    const x = autoFill ? (cam?.width ?? 0) / 2 : this.sprite.gameObject.x;
    const y = autoFill ? (cam?.height ?? 0) / 2 : this.sprite.gameObject.y;
    this.overlay = scene.add.tileSprite(x, y, w, h, key).setOrigin(0.5, 0.5);
    if (this.flipX) this.overlay.flipX = true;
    if (this.flipY) this.overlay.flipY = true;
    this.sprite.routeOverlayToCamera(this.overlay);
    // Background tile sprite IGNORES the host layer's parallax — the
    // texture's `tilePosition` handles all per-axis parallax with the
    // explicit `parallaxFactorX/Y` fields. If we honored the layer
    // parallax here too, it would COMPOUND on the texture parallax (a
    // BG with parallaxFactor=0.05 on a parallax=1 layer would actually
    // scroll at 1.05x world speed — what the user reported as
    // "moves fast almost like ground").
    this.overlay.setScrollFactor(0, 0);
    // Backgrounds ALWAYS render behind everything else, regardless of
    // which scene layer the BP host is on. Using baseDepth-relative
    // arithmetic was fragile (a TiledBackground placed on a "top-of-list"
    // layer ended up with a relatively HIGH absolute depth and rendered
    // over tilemaps on lower layers). Pin to a fixed deep value so no
    // other content can ever beat it.
    this.overlay.setDepth(Number.MIN_SAFE_INTEGER);
    this.overlay.setAlpha(this._layerAlpha);
    this.overlay.setVisible(this._layerVisible);
    // Back-compat: if the project has the legacy single `parallaxFactor`
    // but the new per-axis fields are at their class defaults, seed both
    // axes from the legacy value so saved projects keep working.
    if (this.parallaxFactorX === 1 && this.parallaxFactor !== 1) this.parallaxFactorX = this.parallaxFactor;
    if (this.parallaxFactorY === 1 && this.parallaxFactor !== 1) this.parallaxFactorY = this.parallaxFactor;
    // Hide the host BP's colored rectangle — its depth (`baseDepth + 0.5`)
    // could render on TOP of other-layer content when the BG layer sits
    // high in the scene's layer list, even though our tile sprite itself
    // is pushed way below at `baseDepth - 10000`. We KEEP the host body
    // (collider tags, instance vars still work); we only hide its visual.
    // The tile sprite was created above; if its texture had failed to
    // resolve we fell back to `__WHITE`, so SOMETHING is always rendered
    // — the alpha-0 host rect isn't masking a missing visual.
    const host = this.sprite.gameObject as Phaser.GameObjects.GameObject & { setAlpha?: (a: number) => void };
    if (typeof host.setAlpha === "function") host.setAlpha(0);
  }

  update(delta: number): void {
    if (!this.overlay) return;
    const scene = this.sprite.scene;
    // Animation tick — only when in animated mode AND we have a frame list
    // injected by runProject. Each frame's duration overrides the anim's
    // base fps (matching SpriteRenderer's per-frame durations model).
    if (this.playing && this._frameKeys.length > 1) {
      const dt = (delta * (scene.time.timeScale ?? 1)) / 1000;
      this._animTimeAcc += dt;
      const curDur = this._frameDurations[this._animFrameIdx] ?? 0.1;
      if (this._animTimeAcc >= curDur) {
        this._animTimeAcc -= curDur;
        this._animFrameIdx = (this._animFrameIdx + 1) % this._frameKeys.length;
        const nextKey = this._frameKeys[this._animFrameIdx];
        if (nextKey && scene.textures.exists(nextKey)) this.overlay.setTexture(nextKey);
      }
    }
    const cam = scene.cameras.main;
    const autoFill = this.width <= 0 && this.height <= 0;
    // Grow-only viewport tracking for auto axes: a zoom-out (or window
    // resize) can expose more area than the init()-time size covered.
    // Growing is rare (shrink is never needed — over-cover is invisible),
    // so the canvas realloc inside setSize stays a one-off, not per-frame.
    if (this.tileX || this.tileY) {
      const needW = this.width <= 0 && this.tileX ? Math.min(8192, Math.ceil(cam.displayWidth * 2)) : this.overlay.width;
      const needH = this.height <= 0 && this.tileY ? Math.min(8192, Math.ceil(cam.displayHeight * 2)) : this.overlay.height;
      if (needW > this.overlay.width || needH > this.overlay.height) {
        this.overlay.setSize(Math.max(needW, this.overlay.width), Math.max(needH, this.overlay.height));
      }
    }
    // Parallax math per axis. When tile-on-axis is OFF the shader can't
    // tile (its sample range matches the texture), so parallax has to
    // come from MOVING THE TILE SPRITE instead of shifting tilePosition.
    // When ON, the standard TileSprite trick works: tilePosition handles
    // the parallax and the sprite stays put.
    const baseX = autoFill ? cam.width / 2 : (this.sprite.gameObject.x - cam.scrollX);
    const baseY = autoFill ? cam.height / 2 : (this.sprite.gameObject.y - cam.scrollY);
    if (this.mode === "followCamera") {
      const offX = this.tileX ? 0 : -cam.scrollX * this.parallaxFactorX;
      const offY = this.tileY ? 0 : -cam.scrollY * this.parallaxFactorY;
      this.overlay.setPosition(baseX + offX, baseY + offY);
      this.overlay.tilePositionX = this.tileX ? cam.scrollX * this.parallaxFactorX : 0;
      this.overlay.tilePositionY = this.tileY ? cam.scrollY * this.parallaxFactorY : 0;
    } else {
      this.overlay.setPosition(baseX, baseY);
      // autoScroll — drift the texture at fixed px/sec regardless of camera.
      // Scaled delta so SetTimeScale 0 freezes the drift.
      const dt = (delta * (scene.time.timeScale ?? 1)) / 1000;
      this._scrollAccX += this.scrollSpeedX * dt;
      this._scrollAccY += this.scrollSpeedY * dt;
      this.overlay.tilePositionX = this._scrollAccX;
      this.overlay.tilePositionY = this._scrollAccY;
    }
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    this._layerScrollX = scrollX;
    this._layerScrollY = scrollY;
    this._layerBaseDepth = baseDepth;
    this._layerAlpha = alpha;
    this._layerVisible = visible;
    if (!this.overlay) return;
    // ScrollFactor stays at 0 — see init() rationale. The tile sprite
    // ignores the layer's parallax to avoid compounding with the per-axis
    // parallaxFactor below.
    this.overlay.setScrollFactor(0, 0);
    // See init() — pinned to MIN_SAFE_INTEGER, ignoring baseDepth.
    this.overlay.setDepth(Number.MIN_SAFE_INTEGER);
    this.overlay.setAlpha(alpha);
    this.overlay.setVisible(visible);
  }

  onDestroy(): void {
    if (this.overlay) {
      this.overlay.setVisible(false);
      this.overlay.setActive(false);
      this.overlay.destroy();
      this.overlay = undefined;
    }
  }
}
