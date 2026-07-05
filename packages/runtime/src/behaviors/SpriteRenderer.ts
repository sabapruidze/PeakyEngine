import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";

/**
 * Renders the host Sprite as an animated image instead of a colored rectangle.
 *
 * The behavior owns a Phaser.GameObjects.Image overlay that follows the body
 * and swaps its texture each frame. The underlying physics rectangle stays
 * (for collision) and is used as the visible fallback whenever a frame has
 * no image (so empty frames still play — they show as a solid block of the
 * frame's `color`).
 *
 * Animation data is injected at compile-time by `runProject` via the special
 * `_animations` field on `config` — a map of animation-name → ordered list of
 * frame slots `{ textureKey?, color? }` plus fps + loop. Switching
 * `currentAnimation` at runtime re-points to a different animation in the
 * same map.
 *
 * Public params:
 *   - spriteId          (string, dropdown in editor)
 *   - currentAnimation  (string, dropdown filtered by spriteId)
 *   - playing           (1 = advance, 0 = pause)
 *   - speed             (playback rate multiplier; 2 = twice as fast)
 *
 * Emits `OnAnimationFinished` once when a non-loop animation reaches its end.
 */
export interface SpriteFrameRuntime {
  /** Phaser texture key when the frame has an imported image; undefined for empty frames. */
  textureKey?: string;
  /** Fill color for empty-frame fallback (always defined; defaults to the frame's editor color). */
  color?: number;
  /** Per-frame display size (Construct-style). Falls back to sprite-level
   *  _spriteW / _spriteH when missing (legacy frames). */
  w?: number;
  h?: number;
  /** Pivot ("hotspot") in pixel coords within the frame. Anchored to the
   *  sprite's world position. Falls back to the frame's center when missing.
   *  After cropping, the editor adjusts these by the crop offset so the
   *  visible position stays put. */
  pivotX?: number;
  pivotY?: number;
  /** Named image points — extra anchors a frame may carry (e.g. "Muzzle",
   *  "WeaponTip"). Behaviors like Tracer can pin themselves to a named
   *  point and follow it across the animation. Frame-pixel coords. */
  points?: Array<{ name: string; x: number; y: number }>;
  /** Per-frame collider (AABB in frame-local px). When the SpriteRenderer's
   *  `useFrameCollider` toggle is on, the BP's Collider sizes its body to this
   *  for the displayed frame, so the hitbox tracks the art per frame. */
  collider?: { enabled: boolean; width: number; height: number; offsetX: number; offsetY: number };
}

export interface SpriteAnimRuntime {
  frames: SpriteFrameRuntime[];
  fps: number;
  loop: boolean;
}

export class SpriteRenderer extends Behavior {
  kind = "SpriteRenderer";
  spriteId = "";
  currentAnimation = "";
  /** The animation in effect at init — the one the editor BP preview draws
   *  (config.currentAnimation, else the first animation). Stays fixed while
   *  `currentAnimation` mutates as animations play, so Dismemberment can slice
   *  the SAME reference pose the regions were authored against. */
  private _refAnimName = "";
  playing = 1;
  speed = 1.0;
  /** When 1, the BP collides using the SPRITE's own per-frame collider (the
   *  hitbox set up in the sprite editor) — no separate Collider component
   *  needed. runProject auto-provides the body + collision wiring; the body
   *  tracks the displayed frame's hitbox. */
  useFrameCollider = 0;
  /** With `useFrameCollider` on: 1 = the body physically BLOCKS others (a wall),
   *  0 = overlap-only (events fire, no pushback). Mirrors a Sprite Placement's
   *  "Solid". Translated to the auto-Collider's passThrough by runProject. */
  solid = 1;
  /** Which frame to display. It's a plain frame PICKER: when `playing` is off
   *  the sprite holds on this frame; when `playing` is on it's the starting
   *  frame and the animation advances from here. (A per-instance Static Frame
   *  override sets this + turns `playing` off.) */
  frame = 0;
  /** Additive buffers written by the Animator component each tick.
   *  syncOverlay() applies these on top of the BP's authored scale /
   *  alpha / position so an Animator targeting `SpriteRenderer` can
   *  fade / scale / nudge the sprite without trashing authored values. */
  animOffsetX = 0;
  animOffsetY = 0;
  animScale = 1;
  /** Scale-pivot offset (frame-local px from the frame pivot) written by the
   *  Animator. When `animScale !== 1`, syncOverlay shifts the overlay so the
   *  sprite scales AROUND this point instead of the frame pivot — e.g. a pivot
   *  at the feet makes a grow/shrink tween anchor at the ground. 0,0 (default)
   *  = scale from the frame pivot (legacy behavior). */
  animScalePivotX = 0;
  animScalePivotY = 0;
  /** -1 = no Animator contribution (use sprite layer alpha). 0..1 =
   *  override the layer alpha entirely. See IDENTITY comment in
   *  Animator.ts for why opacity uses a sentinel instead of multiplying. */
  animOpacity = -1;
  animRotation = 0;
  /** -1 = no Animator tint contribution (clear any tint). 0xRRGGBB = apply that
   *  tint to the overlay. Driven by SmartTween tint keyframes. */
  animTint = -1;
  /** When true, the Animator tint is a solid FILL (setTintFill) — white = a
   *  full-white flash — instead of a multiply. Driven by the tween's tint mode. */
  animTintFill = false;

  /** Injected by runProject: per-animation runtime data keyed by name. */
  _animations: Record<string, SpriteAnimRuntime> = {};
  /** Sprite asset's render size (px) — used to scale the overlay / fallback. */
  _spriteW = 64;
  _spriteH = 64;
  /** Per-instance size override baked into the frame w/h/pivot by runProject.
   *  1 = no override. Dismemberment divides it out to recover RAW frame coords
   *  (the BP-preview author space) and re-applies the true display scale. */
  _renderScaleX = 1;
  _renderScaleY = 1;
  /** Frame index to start on (per-instance pose). 0 = first frame. With
   *  `playing = 0` this freezes the instance on that frame. */
  _startFrame = 0;

  private overlay?: Phaser.GameObjects.Image;
  /** Public so the `CompareFrame` guard can read it. */
  currentFrameIdx = 0;
  /** Phaser game-loop frame number at the moment `currentFrameIdx`
   *  transitioned to its current value. Used by `CompareFrame` to
   *  fire as an EDGE trigger (once per anim-frame entry) instead of
   *  matching every tick the anim frame stays current — which is what
   *  authors expect from a "match when on frame X" gate. Multi-tick
   *  matching is unhelpful (a 12-fps anim on a 60-fps loop would fire
   *  ~5x per frame visit). Updated by `applyFrame` whenever the index
   *  actually changes. -1 = never entered. */
  frameEnteredAtTick = -1;
  private elapsedMs = 0;
  private lastAnimName = "";
  /** Public so SM conditions like `IsAnimationFinished` can read it. */
  finishedEmitted = false;
  /**
   * Cached layer state — applied to the overlay on lazy creation. Without
   * this, sprites that start hidden / dimmed by their layer pop in at full
   * alpha when the first textured frame appears (because applyLayer ran
   * before the overlay existed). Defaults are "no layer override".
   */
  private _layerAlpha = 1;
  private _layerVisible = true;
  /** Frame's intrinsic scale after display-size + facingScale + squash bake.
   *  Captured at end of applyFrame so syncOverlay can re-multiply by the
   *  parent BP's scale every tick — without this, scaling the BP root has
   *  no visual effect and the SR image stays at the frame's native size. */
  private _baseScaleX = 1;
  private _baseScaleY = 1;
  /** Last spriteId seen in update() — detects a live `spriteId` write (e.g.
   *  SetBehaviorParam) so the renderer reloads the new sprite's anim table.
   *  A bare field write doesn't swap the asset; this catches it. */
  private _lastSpriteId = "";
  /** Per-name cache of the last pivot-relative offset an image point resolved
   *  to. Lets getImagePointWorld anchor to "where the point WAS" on frames that
   *  don't carry it, so a 1-frame attack point still drives a tracer/mine after
   *  the frame advances. (Same idea as ParticleEmitter's `_lastImagePointPos`.) */
  private _lastImagePointOffset = new Map<string, { dx: number; dy: number }>();
  /** Timestamp (scene.time.now in ms) of the last PlayAnimation request
   *  that targeted this renderer. Used to distinguish a CONTINUOUS
   *  every-frame stream of PlayAnimation calls (e.g. "While Falling →
   *  PlayAnimation(Fall)") from a DISCRETE re-trigger (e.g. "OnHit →
   *  PlayAnimation(Damage)" called on repeated hits). The eval restarts
   *  a finished animation only on discrete calls — leaving a
   *  pinned-on-last-frame fall anim alone when the same continuous
   *  event keeps re-issuing the same name. -1 = never called. */
  _lastPlayAnimRequestMs = -1;

  /** Returns the current frame, or undefined when no animation is playing. */
  private currentFrame(): SpriteFrameRuntime | undefined {
    const anim = this._animations[this.currentAnimation];
    if (!anim || anim.frames.length === 0) return undefined;
    return anim.frames[this.currentFrameIdx] ?? anim.frames[0];
  }

  /** The displayed frame's per-frame collider, in HOST-body px (scaled by the
   *  instance render scale), or null when `useFrameCollider` is off or the
   *  frame has no enabled collider. The Collider behavior reads this each tick
   *  so the hitbox follows the art per frame. */
  frameColliderRect(): { w: number; h: number; offX: number; offY: number } | null {
    if (!this.useFrameCollider) return null;
    const f = this.currentFrame();
    if (!f) return null;
    const c = f.collider;
    if (!c?.enabled) return null;
    // Offsets are in display px (runProject scaled w/h/offset by the instance
    // size). The collider offset is authored relative to the frame CENTER, but
    // the overlay anchors the frame PIVOT at the host position. When the pivot
    // is off-center, shift the body by (center − pivot) so the hitbox tracks the
    // VISIBLE art instead of staying pinned to the host center — without this a
    // feet-pivot drags the collider below the sprite at runtime. X mirrors with
    // facing (the art flips around the pivot); a centered pivot → no shift, so
    // existing sprites are unaffected.
    const fw = f.w ?? this._spriteW;
    const fh = f.h ?? this._spriteH;
    const facing = this.sprite.facingScaleX < 0 ? -1 : 1;
    const pivotDX = (fw / 2 - (f.pivotX ?? fw / 2)) * facing;
    const pivotDY = fh / 2 - (f.pivotY ?? fh / 2);
    return { w: c.width, h: c.height, offX: c.offsetX + pivotDX, offY: c.offsetY + pivotDY };
  }

  /**
   * World-space position of the current frame's pivot (the sprite's
   * "hotspot"). The pivot is what the editor's frame uses to align with
   * the sprite's body — so its WORLD position is exactly the sprite's
   * `(gameObject.x, gameObject.y)`. Returns null when no frame is loaded.
   *
   * Used by behaviors (e.g. Tracer) that want to follow the visual
   * anchor instead of computing their own offset.
   */
  getFramePivotWorld(): { x: number; y: number } | null {
    if (!this.currentFrame()) return null;
    const obj = this.sprite.gameObject;
    return { x: obj.x, y: obj.y };
  }

  /** Visible-sprite vertical extent for Y-sort: the overlay's top edge and
   *  height in world px. Returns null when no overlay is showing (the BP
   *  renders as its host rect), so the host falls back to the body rect.
   *  Anchoring Y-sort here makes the pivot map over the sprite the author
   *  actually sees, not the (often differently sized/offset) collision body. */
  ySortExtent(): { topY: number; height: number } | null {
    const ov = this.overlay;
    if (!ov || !ov.visible) return null;
    // World-space AABB — accounts for the frame pivot (origin), scale and
    // offset automatically, so the Y-sort pivot maps cleanly over the VISIBLE
    // sprite (0 = top … 1 = bottom) regardless of where the frame pivot sits.
    const b = ov.getBounds();
    if (b.height <= 0) return null;
    return { topY: b.y, height: b.height };
  }

  /**
   * World-space position of a named image point on the current frame.
   * Image points are extra anchors (e.g. "Muzzle", "WeaponTip") placed
   * per-frame in the sprite editor.
   *
   * Frames render with origin set to the frame's pivot — the pivot
   * pixel lands at `(gameObject.x, gameObject.y)`. So an image point
   * at frame-pixel `(pt.x, pt.y)` lands in world at
   *   `(obj.x + (pt.x - pivotX) * facing, obj.y + (pt.y - pivotY))`.
   *
   * X delta is mirrored by sprite facing so a Muzzle point anchored
   * "right of the body" stays in front when the sprite faces left.
   *
   * Returns null when no frame is loaded or when the named point doesn't
   * exist on the current frame.
   */
  getImagePointWorld(name: string): { x: number; y: number } | null {
    const frame = this.currentFrame();
    const pt = frame?.points?.find((p) => p.name === name);
    const facing = this.sprite.facingScaleX < 0 ? -1 : 1;
    const obj = this.sprite.gameObject;
    if (pt) {
      const fw = frame!.w ?? this._spriteW;
      const fh = frame!.h ?? this._spriteH;
      // Frame-pixel delta from PIVOT to image point. Default pivot is
      // image center when the frame doesn't carry one (matches the
      // legacy fallback used in applyFrame's setOrigin).
      const px = frame!.pivotX ?? fw / 2;
      const py = frame!.pivotY ?? fh / 2;
      const dx = pt.x - px;
      const dy = pt.y - py;
      this._lastImagePointOffset.set(name, { dx, dy });
      return { x: obj.x + dx * facing, y: obj.y + dy };
    }
    // Point not on the CURRENT frame — anchor to the last frame that DID carry
    // it (same pivot-relative offset, current body position). A 1-frame attack
    // point that drives a tracer/mine then survives the signal's 1-frame delay
    // instead of snapping the trace origin to sprite center.
    const cached = this._lastImagePointOffset.get(name);
    if (cached) return { x: obj.x + cached.dx * facing, y: obj.y + cached.dy };
    return null;
  }

  /** The FIXED reference frame the editor BP preview shows: frame 0 of the
   *  init-time animation. Dismemberment slices THIS (texture key + author-space
   *  metrics) instead of the live pose, so what's drawn against the preview is
   *  what's cut — regardless of which animation is playing when it fires. */
  referenceFrame(animName?: string, frameIdx?: number): {
    key: string; w: number; h: number; pivotX: number; pivotY: number;
    renderScaleX: number; renderScaleY: number;
  } | null {
    const name = animName && this._animations[animName] ? animName : this._refAnimName;
    const anim = this._animations[name] ?? this._animations[Object.keys(this._animations)[0]];
    if (!anim || anim.frames.length === 0) return null;
    const idx = Math.max(0, Math.min(anim.frames.length - 1, Math.floor(frameIdx ?? 0)));
    const f = anim.frames[idx];
    if (!f || !f.textureKey) return null;
    // Frame w/h/pivot were baked with the instance's _renderScale. Divide it
    // back out so the returned metrics are in RAW frame px — the same space the
    // BP preview authors regions in. The caller re-applies renderScale for
    // world placement/size.
    const sx = this._renderScaleX || 1;
    const sy = this._renderScaleY || 1;
    const w = (f.w ?? this._spriteW) / sx;
    const h = (f.h ?? this._spriteH) / sy;
    const pivotX = (f.pivotX ?? (f.w ?? this._spriteW) / 2) / sx;
    const pivotY = (f.pivotY ?? (f.h ?? this._spriteH) / 2) / sy;
    return { key: f.textureKey, w, h, pivotX, pivotY, renderScaleX: sx, renderScaleY: sy };
  }

  /** All image-point names available on the current frame (for editor
   *  pickers / debugging). Empty array when no frame or no points. */
  currentImagePointNames(): string[] {
    const frame = this.currentFrame();
    if (!frame || !frame.points) return [];
    return frame.points.map((p) => p.name);
  }

  serialize(): Record<string, unknown> {
    return {
      currentAnimation: this.currentAnimation,
      currentFrameIdx: this.currentFrameIdx,
      playing: this.playing,
    };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.currentAnimation === "string") this.currentAnimation = state.currentAnimation;
    if (typeof state.currentFrameIdx === "number") this.currentFrameIdx = Math.max(0, state.currentFrameIdx | 0);
    if (typeof state.playing === "number") this.playing = state.playing;
    // Reset playback timing so the loaded frame holds for its full duration
    // rather than skipping ahead based on the previous tick's elapsed.
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    this.lastAnimName = this.currentAnimation;
  }

  /** Restart playback of the current animation from frame 0. Used by the
   *  PlayAnimation action so that re-triggering the SAME animation
   *  (e.g. damage flinch on repeated hits) actually replays it instead
   *  of being a no-op once it finished on a previous trigger. */
  restart(): void {
    this.currentFrameIdx = 0;
    this.frameEnteredAtTick = this.sprite.scene.game.loop.frame;
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    // Treat as a fresh switch so update()'s "anim changed?" branch runs.
    this.lastAnimName = this.currentAnimation;
  }

  /** Show `anim` from frame 0 and PAINT it immediately, without waiting for the
   *  next update() tick. Used by PlayAnimation so a signal-driven animation on
   *  ANOTHER object (e.g. a bed reacting to the player's EmitSignalTo) shows on
   *  the exact frame it's triggered — no 1-frame cross-object render lag.
   *  No-op if the anim name is unknown. `lastAnimName` is set so update()'s
   *  "anim changed?" branch doesn't redundantly re-reset the frame next tick. */
  playNow(anim: string): void {
    const a = this._animations[anim];
    if (!a || a.frames.length === 0) return;
    this.currentAnimation = anim;
    this.lastAnimName = anim;
    this.currentFrameIdx = 0;
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    this.frameEnteredAtTick = this.sprite.scene.game.loop.frame;
    this.applyFrame(this.sprite.scene, a.frames[0]);
  }

  /** Swap to a DIFFERENT sprite asset at runtime (new animation table). The
   *  table comes from `peaky.spriteAnimTables` (built by runProject for every
   *  project sprite). Plays `animName` if given+valid, else the first anim.
   *  Mirrors init()'s frame-0 paint so there's no blank frame on the swap. */
  setSprite(spriteId: string, anims: Record<string, SpriteAnimRuntime>, animName?: string): void {
    const names = Object.keys(anims);
    if (names.length === 0) return;
    this.spriteId = spriteId;
    this._animations = anims;
    const target = animName && anims[animName] ? animName : names[0];
    this.currentAnimation = target;
    this.lastAnimName = target;
    this.currentFrameIdx = 0;
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    this.frameEnteredAtTick = this.sprite.scene.game.loop.frame;
    const anim = anims[target];
    if (anim && anim.frames.length > 0) this.applyFrame(this.sprite.scene, anim.frames[0]);
  }

  init(): void {
    const scene = this.sprite.scene;
    const anims = Object.values(this._animations);

    if (anims.length === 0) {
      Logger.log({
        level: "warn",
        source: "SpriteRenderer",
        message: this.spriteId
          ? `Sprite "${this.spriteId}" has no animations.`
          : "SpriteRenderer is attached but no Sprite asset is selected (Components panel).",
      });
      return;
    }

    // Lazy overlay — created the first time a frame with a real texture appears.
    // Empty-only animations are still valid; the BP's coloured rect handles them.
    const animName = this.currentAnimation || Object.keys(this._animations)[0];
    this.currentAnimation = animName;
    this._refAnimName = animName;
    this._lastSpriteId = this.spriteId;
    const anim = this._animations[animName];
    this.lastAnimName = animName;
    if (anim && anim.frames.length > 0) {
      // Start on the selected `frame` (also honors a per-instance Static Frame,
      // which runProject writes into `frame`). With playing=0 the sprite holds
      // here; otherwise it's just the starting frame.
      const start = Math.max(0, Math.min(anim.frames.length - 1, Math.floor(this.frame || this._startFrame || 0)));
      this.currentFrameIdx = start;
      this.applyFrame(scene, anim.frames[start]);
    }
  }

  update(delta: number): void {
    const scene = this.sprite.scene;

    // Live spriteId swap — a direct field write (SetBehaviorParam
    // "SpriteRenderer.spriteId") doesn't reload the anim table, so detect the
    // change and reload from the project's sprite tables. (The SetSprite action
    // does this directly; this makes the bare param write work too.)
    if (this.spriteId !== this._lastSpriteId) {
      this._lastSpriteId = this.spriteId;
      const tables = scene.data.get("peaky.spriteAnimTables") as
        | Record<string, Record<string, SpriteAnimRuntime>> | undefined;
      // Accept either a sprite id (editor dropdown) or a sprite NAME — a wired
      // string / Read Variable naturally holds the human name, not the id.
      let id = this.spriteId;
      let table = tables?.[id];
      if (!table) {
        const byName = scene.data.get("peaky.spriteIdByName") as Record<string, string> | undefined;
        const mapped = byName?.[this.spriteId];
        if (mapped) { id = mapped; table = tables?.[mapped]; }
      }
      if (table) {
        this.setSprite(id, table, this.currentAnimation);
      } else if (this.spriteId) {
        Logger.log({
          level: "warn",
          source: "SpriteRenderer",
          message: `spriteId "${this.spriteId}" matched no sprite by id OR name — a wired Read Variable outputs the variable's VALUE (must equal the sprite's name), not the variable name.`,
        });
      }
    }

    // Animation switch — reset frame counter.
    if (this.currentAnimation !== this.lastAnimName) {
      this.currentFrameIdx = 0;
      this.frameEnteredAtTick = scene.game.loop.frame;
      this.elapsedMs = 0;
      this.finishedEmitted = false;
      this.lastAnimName = this.currentAnimation;
    }

    const anim = this._animations[this.currentAnimation];
    if (!anim || anim.frames.length === 0) {
      this.syncOverlay();
      return;
    }

    // `playing` is the single source of truth for play/pause. When paused, hold
    // on the selected `frame` (a static frame PICKER — not a play/pause hack).
    // Toggling `playing` at runtime (SetBehaviorParam) starts/stops immediately;
    // changing `frame` while paused re-poses. (CharacterAnimator, when present,
    // drives `playing`/`currentAnimation` itself — this only governs a plain SR.)
    if (this.playing === 0) {
      const f = Math.max(0, Math.min(anim.frames.length - 1, Math.floor(this.frame || 0)));
      if (this.currentFrameIdx !== f) {
        this.currentFrameIdx = f;
        this.frameEnteredAtTick = scene.game.loop.frame;
        this.applyFrame(scene, anim.frames[f]);
      }
      this.syncOverlay();
      return;
    }

    if (!this.finishedEmitted) {
      // Guard against NaN / non-positive speed multipliers.
      const safeSpeed = Number.isFinite(this.speed) && this.speed > 0 ? this.speed : 1;
      const fps = Math.max(0.0001, anim.fps * safeSpeed);
      const msPerFrame = 1000 / fps;
      // Clamp big deltas (tab-return, GC pause, devtools breakpoint) so the
      // while-loop below can't spin through hundreds of frames at once. Cap
      // at roughly 5 frames worth of catch-up — anything beyond that is a
      // pathological pause and the user is better served by the animation
      // resuming from "now" than by a long no-skip catchup.
      this.elapsedMs += Math.min(delta, msPerFrame * 5);
      while (this.elapsedMs >= msPerFrame) {
        this.elapsedMs -= msPerFrame;
        let next = this.currentFrameIdx + 1;
        if (next >= anim.frames.length) {
          if (anim.loop) {
            next = 0;
          } else {
            this.currentFrameIdx = anim.frames.length - 1;
            this.frameEnteredAtTick = this.sprite.scene.game.loop.frame;
            this.finishedEmitted = true;
            this.sprite.events.emit("OnAnimationFinished");
            // If a listener of OnAnimationFinished destroyed the sprite
            // (e.g. Logic Sheet "OnAnimationEnd → Destroy"), bail BEFORE
            // applyFrame runs below — applyFrame's lazy create would
            // re-spawn the overlay we just tore down in SR.onDestroy,
            // leaving the last frame visible forever.
            if (this.sprite.destroyed) return;
            break;
          }
        }
        if (next !== this.currentFrameIdx) {
          this.currentFrameIdx = next;
          this.frameEnteredAtTick = this.sprite.scene.game.loop.frame;
        }
      }
    }

    const slot = anim.frames[this.currentFrameIdx];
    this.applyFrame(scene, slot);
    this.syncOverlay();
  }

  /**
   * Render either the textured overlay or the BP's colour rect, depending on
   * whether the current frame slot has a loaded texture. Switching back and
   * forth between textured + empty frames in the same animation just toggles
   * which of the two visual layers is visible.
   */
  private applyFrame(scene: Phaser.Scene, slot: SpriteFrameRuntime): void {
    const hasTexture = !!slot.textureKey && scene.textures.exists(slot.textureKey);

    if (hasTexture) {
      // Hide the BP rect, show the overlay with this frame's texture.
      if (!this.overlay) {
        this.overlay = scene.add.image(this.sprite.gameObject.x, this.sprite.gameObject.y, slot.textureKey!);
        // Route to main / UI camera based on host sprite kind so a
        // BlurScene-applied main-cam blur doesn't smear UI widget
        // sprite art (and vice versa).
        this.sprite.routeOverlayToCamera(this.overlay);
        // Sit 1 above the body within whichever layer the host sprite is on.
        // The +1 keeps the overlay above the body rect; layers add the base.
        this.overlay.setDepth(this.sprite.gameObject.depth + 1);
        // Mirror the host's scroll factor so newly-created overlays inherit
        // the layer's parallax (rather than defaulting to 1,1).
        this.overlay.setScrollFactor(
          this.sprite.gameObject.scrollFactorX,
          this.sprite.gameObject.scrollFactorY,
        );
        // Apply the cached layer alpha/visible — applyLayer may have run
        // before the overlay existed (lazy creation), so without this a
        // sprite on a hidden / dimmed layer would pop in at full alpha
        // the first time a textured frame appears.
        this.overlay.setAlpha(this._layerAlpha);
      }
      if (this.overlay.texture.key !== slot.textureKey) {
        this.overlay.setTexture(slot.textureKey!);
      }
      this.overlay.setVisible(this._layerVisible && !this.sprite.manualHidden);
      // Per-frame display size, centered on the body. Multiply scaleX by
      // sprite.facingScaleX so the overlay mirrors PROPORTIONALLY — during a
      // smooth-mirror tween (facingScaleX in transit between -1 and 1) the
      // overlay scales horizontally too, producing the visible squash.
      // (Reading from `sprite.facingScaleX` rather than the body's own
      // scaleX keeps the physics body axis-aligned and stationary while
      // the visual flips — otherwise the body drifts by its own width.)
      const dispW = slot.w ?? this._spriteW;
      const dispH = slot.h ?? this._spriteH;
      const obj = this.sprite.gameObject;
      // Pivot-driven origin (Construct-style). Each frame's pivotX/pivotY
      // is its "hotspot" in source-image pixels — the renderer maps that
      // pixel to (obj.x, obj.y), so frames of different sizes align at
      // the pivot instead of jumping when their bounding boxes differ.
      // Scaling (squash/stretch, instance scale, Tween-on-displaySize)
      // pivots around this point automatically. Default pivot is image
      // center for legacy frames that don't have one set.
      const px = slot.pivotX ?? dispW / 2;
      const py = slot.pivotY ?? dispH / 2;
      this.overlay.setOrigin(px / dispW, py / dispH);
      const targetW = dispW * this.sprite.squashX;
      const targetH = dispH * this.sprite.squashY;
      this.overlay.setDisplaySize(targetW, targetH);
      // Capture the frame's intrinsic scale UNSIGNED (no facing fold) so
      // syncOverlay can re-apply facingScaleX every tick. Without this,
      // a `SetFacing` write between frame transitions wouldn't take
      // effect until the next applyFrame ran.
      this._baseScaleX = this.overlay.scaleX;
      this._baseScaleY = this.overlay.scaleY;
      this.overlay.scaleX *= this.sprite.facingScaleX * obj.scaleX;
      this.overlay.scaleY *= obj.scaleY;
      this.overlay.setPosition(obj.x, obj.y);
      this.overlay.setRotation(obj.rotation);
      obj.setAlpha(0);
    } else {
      // Empty frame — hide the overlay. The body Rectangle stays
      // invisible (alpha=0 from Sprite construction); we no longer flip
      // it to alpha=1 as a colored placeholder. Empty animation frames
      // render as nothing visible, which matches the "the body has no
      // default visual" contract — sprites without art are pure physics.
      if (this.overlay) this.overlay.setVisible(false);
    }
  }

  /**
   * Mirror the physics body's position onto the overlay. Mirroring (incl.
   * smooth-mirror partial values) is now handled in applyFrame via
   * `overlay.scaleX *= obj.scaleX`, so no boolean setFlipX needed here.
   */
  /** Sync the overlay to the host's transform. Called every tick AND
   *  on-demand by transform actions (SetScale / SetPosition / etc.) so
   *  the visual lands on the same frame the body moves — without this
   *  the overlay shows the old transform for one render before the
   *  next tick catches up. */
  syncOverlay(): void {
    if (!this.overlay) return;
    const obj = this.sprite.gameObject;
    // Overlay origin is set per-frame to the frame's pivot, so the
    // pivot pixel always lands at (obj.x, obj.y). Track position +
    // parent transform (scale/rotation) every tick so the SR image
    // follows the BP root as a child of its transform group. The
    // frame's intrinsic scale was captured in applyFrame; we re-fold
    // the parent's scale here in case it changed between frame swaps.
    // Scale-pivot compensation. The overlay origin sits at the frame pivot, so
    // animScale normally scales around it. To scale around a custom point P
    // (frame-local offset from the pivot), shift the overlay by
    //   P ⊙ baseScale ⊙ (1 − animScale)
    // rotated by the overlay's rotation. At animScale=1 (or pivot 0,0) the
    // shift is zero → no effect on non-scaling sprites / legacy configs.
    let pivotCompX = 0;
    let pivotCompY = 0;
    if (this.animScale !== 1 && (this.animScalePivotX !== 0 || this.animScalePivotY !== 0)) {
      const k = 1 - this.animScale;
      pivotCompX = this.animScalePivotX * (this._baseScaleX * this.sprite.facingScaleX * obj.scaleX) * k;
      pivotCompY = this.animScalePivotY * (this._baseScaleY * obj.scaleY) * k;
      const rot = obj.rotation + this.animRotation;
      if (rot !== 0) {
        const c = Math.cos(rot), s = Math.sin(rot);
        const rx = pivotCompX * c - pivotCompY * s;
        const ry = pivotCompX * s + pivotCompY * c;
        pivotCompX = rx; pivotCompY = ry;
      }
    }
    this.overlay.setPosition(obj.x + this.animOffsetX + pivotCompX, obj.y + this.animOffsetY + pivotCompY);
    // Re-fold `facingScaleX` every tick so manual mirror flips
    // (SetFacing action, AIBrain.autoFaceTarget) take effect between
    // anim-frame transitions instead of waiting for the next applyFrame.
    this.overlay.setScale(
      this._baseScaleX * this.sprite.facingScaleX * obj.scaleX * this.animScale,
      this._baseScaleY * obj.scaleY * this.animScale,
    );
    this.overlay.setRotation(obj.rotation + this.animRotation);
    // Animator's `animOpacity` uses -1 as "no contribution" sentinel.
    // When set (>=0) it OVERRIDES the layer alpha entirely so an author
    // who started the sprite at alpha=0 can fade it back in via animator.
    this.overlay.setAlpha((this.animOpacity < 0 ? this._layerAlpha : this.animOpacity * this._layerAlpha) * this.sprite.manualAlpha);
    // Animator tint (SmartTween tint keyframes). -1 = no contribution → clear
    // any tint. Fill mode = solid silhouette (white = flash); else multiply.
    const ov = this.overlay as unknown as { setTint?: (c: number) => void; setTintFill?: (c: number) => void; clearTint?: () => void };
    if (this.animTint < 0) ov.clearTint?.();
    else if (this.animTintFill) ov.setTintFill?.(this.animTint);
    else ov.setTint?.(this.animTint);
    // Mirror depth from the body so SetZOrder / SetDepth actions on the
    // body propagate to the rendered sprite. +1 keeps the visual above
    // the (typically invisible) body rect within the same layer band.
    this.overlay.setDepth(obj.depth + 1);
  }

  /** Apply layer config to the image overlay. Cached so a lazy overlay
   *  created later picks up the same layer alpha/visibility. */
  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    this._layerAlpha = alpha;
    this._layerVisible = visible;
    if (!this.overlay) return;
    this.overlay.setScrollFactor(scrollX, scrollY);
    this.overlay.setDepth(baseDepth + 1);
    this.overlay.setAlpha(alpha * this.sprite.manualAlpha);
    this.overlay.setVisible(visible && !this.sprite.manualHidden);
  }

  onDestroy(): void {
    if (this.overlay) {
      // Force-hide first so even if Phaser's destroy is deferred or the
      // overlay reference is stale, the last rendered frame isn't left
      // visible on the canvas for the user to see.
      this.overlay.setVisible(false);
      this.overlay.setActive(false);
      this.overlay.destroy();
    }
    this.overlay = undefined;
  }
}
