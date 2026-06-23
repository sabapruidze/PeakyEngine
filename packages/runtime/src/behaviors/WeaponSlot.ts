import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { SpriteAnimRuntime, SpriteRenderer } from "./SpriteRenderer";

/**
 * Pins a weapon sprite to a host image point. The weapon is a separate
 * SpriteAsset (with its own animations) — equipped via `spriteId` and
 * played independently from the host's animation. Mirrors with the
 * host's `facingScaleX` when `followFacing` is on so a left-facing host
 * carries the weapon flipped without per-frame work from the author.
 *
 * Multi-slot wielding (sword + shield, dual blades) = attach multiple
 * `WeaponSlot` behaviors with distinct `slotName`s. Actions and
 * `weapon:slotName.field` expressions target by slotName.
 *
 * Public params:
 *   - slotName     (string) — addressing key for actions / expressions
 *   - spriteId     (string) — weapon SpriteAsset id (empty = unequipped)
 *   - animation    (string) — current animation name on the weapon
 *   - imagePoint   (string) — host's image-point to attach to (e.g. "hand_R")
 *   - offsetX/Y    (number) — extra offset, X mirrors when followFacing+host flipped
 *   - angleOffset  (number) — additive rotation in degrees
 *   - followFacing (0|1)    — mirror with host's facingScaleX
 *   - renderAbove  (0|1)    — depth = host.depth ± 1
 *   - visible      (0|1)    — toggle from event sheet
 *   - playing      (0|1)    — advance animation frames each tick
 *   - speed        (number) — playback rate multiplier
 */
export class WeaponSlot extends Behavior {
  kind = "WeaponSlot";
  /** Slot identifier — addressing key for SetBehaviorParam(componentName="…"),
   *  weapon:NAME.field expressions, and the EquipWeapon / PlayWeaponAnimation
   *  actions. Distinct per slot (RightHand, LeftHand, Back). */
  name = "RightHand";
  spriteId = "";
  currentAnimation = "";
  imagePoint = "";
  offsetX = 0;
  offsetY = 0;
  angleOffset = 0;
  /** Per-instance weapon scale, multiplied with the host's facingScaleX
   *  flip and any Animator `animScale` contribution. 1 = native size of
   *  the weapon's SpriteAsset. Useful for fitting a sword to a bigger /
   *  smaller character without authoring a separate sprite. */
  scaleX = 1;
  scaleY = 1;
  followFacing = 1;
  renderAbove = 1;
  visible = 1;
  playing = 1;
  /** When `playing = 0`, lock the overlay to this frame index instead of
   *  advancing the animation. Lets authors pose a weapon (e.g. an idle
   *  knife sitting in its sheath at frame 2 of the "draw" animation)
   *  without having to author a separate 1-frame animation. */
  startFrame = 0;
  speed = 1.0;

  /** Injected by runProject — same shape SpriteRenderer uses. Maps
   *  animation name → { frames, fps, loop }. Empty = nothing equipped
   *  or the sprite asset was missing at attach time. */
  _animations: Record<string, SpriteAnimRuntime> = {};
  _spriteW = 32;
  _spriteH = 32;

  /** Animator (SmartTween) write targets — mirror SpriteRenderer / Text.
   *  Lets a SmartTween target "WeaponSlot:RightHand" and punch / fade /
   *  scale the weapon on swing without trashing authored values. */
  animOffsetX = 0;
  animOffsetY = 0;
  animScale = 1;
  /** -1 = no Animator contribution; 0..1 overrides base alpha. */
  animOpacity = -1;
  animRotation = 0;

  private overlay?: Phaser.GameObjects.Image;
  private currentFrameIdx = 0;
  private elapsedMs = 0;
  private lastAnimName = "";
  private finishedEmitted = false;
  private _layerAlpha = 1;
  private _layerVisible = true;

  serialize(): Record<string, unknown> {
    return {
      spriteId: this.spriteId,
      currentAnimation: this.currentAnimation,
      imagePoint: this.imagePoint,
      visible: this.visible,
    };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.spriteId === "string") this.spriteId = state.spriteId;
    if (typeof state.currentAnimation === "string") this.currentAnimation = state.currentAnimation;
    if (typeof state.imagePoint === "string") this.imagePoint = state.imagePoint;
    if (typeof state.visible === "number") this.visible = state.visible;
  }

  init(): void {
    this.ensureOverlay();
    if (this.currentAnimation && !this._animations[this.currentAnimation]) {
      // Fall back to the first available anim if the configured one isn't
      // in this sprite's animation set (e.g. user typo or asset swap).
      const first = Object.keys(this._animations)[0];
      if (first) this.currentAnimation = first;
    }
    this.lastAnimName = this.currentAnimation;
    // Honor startFrame when locked (playing = 0). Clamped to the
    // animation's frame count so an out-of-range index doesn't render
    // empty — fall back to the last available frame instead.
    if (this.playing === 0) {
      const anim = this._animations[this.currentAnimation];
      const count = anim?.frames.length ?? 0;
      this.currentFrameIdx = count > 0 ? Math.max(0, Math.min(count - 1, Math.floor(this.startFrame))) : 0;
    }
    this.applyFrame();
  }

  private ensureOverlay(): void {
    if (this.overlay) return;
    const scene = this.sprite.scene;
    this.overlay = scene.add.image(this.sprite.gameObject.x, this.sprite.gameObject.y, "");
    this.overlay.setOrigin(0.5, 0.5);
    this.sprite.routeOverlayToCamera(this.overlay);
    this.overlay.setScrollFactor(
      this.sprite.gameObject.scrollFactorX,
      this.sprite.gameObject.scrollFactorY,
    );
  }

  /** World position of a named image point on the CURRENT weapon frame,
   *  accounting for the weapon overlay's position, facing-mirror, scale,
   *  and rotation. Lets a Tracer pivot from a point on the weapon sprite
   *  (e.g. a sword's tip) rather than the host body. Returns null when the
   *  point isn't on the current frame or nothing is equipped. */
  getImagePointWorld(name: string): { x: number; y: number } | null {
    if (!this.overlay) return null;
    const anim = this._animations[this.currentAnimation];
    if (!anim || anim.frames.length === 0) return null;
    const idx = Math.max(0, Math.min(this.currentFrameIdx, anim.frames.length - 1));
    const frame = anim.frames[idx];
    const pt = frame.points?.find((p) => p.name === name);
    if (!pt) return null;
    const dispW = frame.w ?? this._spriteW;
    const dispH = frame.h ?? this._spriteH;
    const pivotX = frame.pivotX ?? dispW / 2;
    const pivotY = frame.pivotY ?? dispH / 2;
    // Delta from the weapon's pivot to the image point, in frame-pixel
    // space (= display space since the overlay renders at frame size).
    const dx = pt.x - pivotX;
    const dy = pt.y - pivotY;
    // overlay.scaleX already carries the facing-mirror sign + author scale.
    const sx = this.overlay.scaleX;
    const sy = this.overlay.scaleY;
    const rot = this.overlay.rotation;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const lx = dx * sx;
    const ly = dy * sy;
    return {
      x: this.overlay.x + (lx * cos - ly * sin),
      y: this.overlay.y + (lx * sin + ly * cos),
    };
  }

  /** Image-point names available on the current weapon frame — for editor
   *  pickers / diagnostics. */
  currentImagePointNames(): string[] {
    const anim = this._animations[this.currentAnimation];
    if (!anim || anim.frames.length === 0) return [];
    const idx = Math.max(0, Math.min(this.currentFrameIdx, anim.frames.length - 1));
    return (anim.frames[idx].points ?? []).map((p) => p.name);
  }

  /** Runtime swap — called by EquipWeapon action. Wipes anim state so the
   *  new sprite starts from frame 0 even if the prior weapon was mid-anim. */
  equip(spriteId: string, animation?: string, animations?: Record<string, SpriteAnimRuntime>, spriteW?: number, spriteH?: number): void {
    this.spriteId = spriteId;
    if (animations) this._animations = animations;
    if (typeof spriteW === "number") this._spriteW = spriteW;
    if (typeof spriteH === "number") this._spriteH = spriteH;
    if (animation) {
      this.currentAnimation = animation;
    } else {
      // Default to the first anim of the new sprite.
      this.currentAnimation = Object.keys(this._animations)[0] ?? "";
    }
    this.lastAnimName = this.currentAnimation;
    this.currentFrameIdx = 0;
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    this.applyFrame();
  }

  /** Runtime animation switch — called by PlayWeaponAnimation. */
  playAnimation(animName: string): void {
    if (!this._animations[animName]) return;
    this.currentAnimation = animName;
    this.lastAnimName = animName;
    this.currentFrameIdx = 0;
    this.elapsedMs = 0;
    this.finishedEmitted = false;
    this.playing = 1;
    this.applyFrame();
  }

  update(deltaMs: number): void {
    if (!this.overlay) this.ensureOverlay();
    if (!this.overlay) return;

    // Hide overlay when unequipped — empty spriteId / no anim data.
    const hasWeapon = this.spriteId !== "" && Object.keys(this._animations).length > 0;
    const want = hasWeapon && this.visible !== 0 && this._layerVisible;
    this.overlay.setVisible(want);
    if (!want) return;

    // Re-arm finishedEmitted when the user switches anim (e.g. swing → idle).
    if (this.currentAnimation !== this.lastAnimName) {
      this.lastAnimName = this.currentAnimation;
      this.currentFrameIdx = 0;
      this.elapsedMs = 0;
      this.finishedEmitted = false;
    }

    const anim = this._animations[this.currentAnimation];
    if (anim && anim.frames.length > 0 && this.playing !== 0) {
      const fps = Math.max(1, anim.fps) * Math.max(0.0001, this.speed);
      const frameMs = 1000 / fps;
      this.elapsedMs += deltaMs;
      while (this.elapsedMs >= frameMs) {
        this.elapsedMs -= frameMs;
        const next = this.currentFrameIdx + 1;
        if (next >= anim.frames.length) {
          if (anim.loop) {
            this.currentFrameIdx = 0;
          } else if (!this.finishedEmitted) {
            this.finishedEmitted = true;
            this.sprite.events.emit(`OnWeaponAnimEnd:${this.name}`);
            this.sprite.events.emit("OnWeaponAnimEnd");
            // Hold on the last frame.
            this.currentFrameIdx = anim.frames.length - 1;
            break;
          } else {
            // Already finished and pinned to last frame — just stop advancing.
            break;
          }
        } else {
          this.currentFrameIdx = next;
        }
      }
    }

    this.applyFrame();
    this.syncTransform();
  }

  /** Push the current frame's texture + pivot-as-origin into the overlay.
   *  Pivot lookup mirrors SpriteRenderer: frame's pixel-coord pivot becomes
   *  the overlay's normalized origin so the pivot pixel (e.g. the sword's
   *  HANDLE, not its center) lands at the syncTransform anchor. */
  private applyFrame(): void {
    if (!this.overlay) return;
    const anim = this._animations[this.currentAnimation];
    if (!anim || anim.frames.length === 0) {
      this.overlay.setTexture("__MISSING__");
      this.overlay.setVisible(false);
      return;
    }
    const idx = Math.max(0, Math.min(this.currentFrameIdx, anim.frames.length - 1));
    const frame = anim.frames[idx];
    if (frame.textureKey && this.sprite.scene.textures.exists(frame.textureKey)) {
      this.overlay.setTexture(frame.textureKey);
      const displayW = frame.w ?? this._spriteW;
      const displayH = frame.h ?? this._spriteH;
      this.overlay.setDisplaySize(displayW, displayH);
      // Pivot is in frame-pixel coords; the runProject frame builder
      // already multiplies by the instance scale before injecting, so
      // pivotX / displayW gives the correct normalized origin even on
      // resized BP instances.
      const px = frame.pivotX !== undefined ? frame.pivotX : displayW / 2;
      const py = frame.pivotY !== undefined ? frame.pivotY : displayH / 2;
      this.overlay.setOrigin(px / displayW, py / displayH);
    } else {
      // Empty frame — keep the overlay visible-but-blank so authored timing
      // still lines up. Empty texture renders nothing, which is fine.
      this.overlay.setVisible(false);
    }
  }

  /** Position / rotation / scale / depth sync per tick. */
  private syncTransform(): void {
    if (!this.overlay) return;
    const host = this.sprite;
    const obj = host.gameObject as Phaser.GameObjects.Components.Transform & Phaser.GameObjects.Components.Depth & Phaser.GameObjects.GameObject;

    // Anchor: host's image point, falling back to host body center.
    let anchorX = obj.x;
    let anchorY = obj.y;
    const sr = host.findBehaviorByKind("SpriteRenderer") as
      | (SpriteRenderer & { getImagePointWorld?: (n: string) => { x: number; y: number } | null })
      | undefined;
    if (this.imagePoint && sr?.getImagePointWorld) {
      const pt = sr.getImagePointWorld(this.imagePoint);
      if (pt) { anchorX = pt.x; anchorY = pt.y; }
    }

    // Mirror — read the host's FLOAT facingScaleX (not just its sign) so a
    // smooth-mirror tween on the host (CharacterMovement.scaleMirrorTime > 0)
    // propagates through to the weapon. The host can sit mid-flip at e.g.
    // facingScaleX = -0.3 for several frames during the tween; using binary
    // sign would snap the weapon while the host stays smooth — visible
    // de-sync. Float mode makes both flip together. followFacing off
    // pins to 1 (no mirror at all).
    const fScale = this.followFacing !== 0 ? host.facingScaleX : 1;
    // Animator contribution — additive offset (also follows mirror tween) +
    // multiplicative scale + rotation; opacity uses -1 sentinel for
    // "no animator override" (mirrors SR / Text convention).
    // Author-configured offsets/angle mirror with facing automatically.
    // The Animator's contribution (animOffsetX / animRotation) is NOT
    // re-mirrored here — Animator already applies its OWN mirror sign when
    // the animation's "mirror" flag is checked. Auto-mirroring again would
    // cancel that out, making the inspector checkbox appear reversed.
    this.overlay.x = anchorX + this.offsetX * fScale + this.animOffsetX;
    this.overlay.y = anchorY + this.offsetY + this.animOffsetY;
    this.overlay.setScale(fScale * this.scaleX * this.animScale, this.scaleY * this.animScale);
    this.overlay.rotation = ((obj as Phaser.GameObjects.Components.Transform).rotation ?? 0)
      + (this.angleOffset * fScale + this.animRotation) * Math.PI / 180;

    // Depth — above or below the host. Layer base is applied via applyLayer.
    const sign = this.renderAbove !== 0 ? +1 : -1;
    this.overlay.setDepth((obj as Phaser.GameObjects.Components.Depth).depth + sign);

    // Layer alpha contribution. Animator opacity (-1 sentinel = no override)
    // multiplies onto the layer alpha; explicit 0..1 replaces base.
    const baseAlpha = this.animOpacity < 0 ? 1 : Math.max(0, Math.min(1, this.animOpacity));
    this.overlay.setAlpha(this._layerAlpha * baseAlpha);
  }

  onDestroy(): void {
    this.overlay?.destroy();
    this.overlay = undefined;
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    this._layerAlpha = alpha;
    this._layerVisible = visible;
    if (!this.overlay) return;
    this.overlay.setScrollFactor(scrollX, scrollY);
    const sign = this.renderAbove !== 0 ? +1 : -1;
    this.overlay.setDepth(baseDepth + sign);
    this.overlay.setAlpha(alpha);
    this.overlay.setVisible(visible && this.visible !== 0 && this.spriteId !== "");
  }
}
