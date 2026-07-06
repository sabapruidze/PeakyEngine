import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";

/**
 * Drives the scene's main camera — follow target, smoothing, deadzone,
 * zoom, shake, fade/flash. Attach to a Blueprint (typically the player
 * or a dedicated MainCamera BP); the runtime instance of that BP becomes
 * the camera anchor.
 *
 * Multiple Camera behaviors in one scene → the most recently `init`'d wins
 * (Phaser only exposes one default `cameras.main`). Multi-camera support
 * is deferred to a later revision.
 *
 * Public params:
 *   - targetMode    "self" | "tag"
 *   - targetTag     tag name (when targetMode = "tag")
 *   - smoothing     0..1 (0 = instant, 0.1 = typical, 1 = very smooth)
 *   - followX       0/1 — track target on X
 *   - followY       0/1 — track target on Y
 *   - offsetX       px — added to target position
 *   - offsetY
 *   - deadzoneX     px — half-width of dead zone (target can move within without camera moving)
 *   - deadzoneY
 *   - zoom          1.0 = native viewport size, 2 = 2× zoom in
 *   - bounded       0/1 — clamp camera to layout bounds (set in Game.ts)
 */
export class Camera extends Behavior {
  kind = "Camera";

  targetMode: "self" | "tag" | "sprite" = "self";
  targetTag = "";
  /** When `targetMode === "sprite"`, the explicit sprite to follow.
   *  Set via setTargetSprite (e.g. picking-driven CameraSetTarget). */
  private targetSprite: Sprite | null = null;
  /** 0 = snap (lerp 1.0), 1 = stuck (lerp 0). 0.5 default — gives a
   *  visible glide out of the box; was 0.1 (lerp 0.9 = 90% per frame)
   *  which looked almost like snap. Tune higher for "movie cam", lower
   *  for "tight platformer cam". */
  smoothing = 0.5;
  followX = 1;
  followY = 1;
  /**
   * Per-direction X offset — applied based on the follow target's facing
   * (scaleX sign) every frame. Set both to the same value for a static
   * non-directional offset; differ them for built-in look-ahead. The
   * `offsetSmoothing` field eases the transition between the two.
   */
  offsetLeftX  = 0;
  offsetRightX = 0;
  offsetY = 0;
  /**
   * Smoothing factor for offset transitions: 0 = snap to new offset
   * instantly (legacy behavior), 1 = never reach the target. Useful for
   * "look-ahead" patterns where the offset flips from +100 to -100 when
   * the character changes facing — without smoothing this jumps; with
   * smoothing ~0.9 it eases over ~150 ms.
   */
  offsetSmoothing = 0;
  deadzoneX = 0;
  deadzoneY = 0;
  zoom = 1;
  bounded = 1;
  /**
   * Lock the camera in place — disables follow + ignores SetTarget while
   * true. Used for cutscenes: lock, pan to NPC, dialog, pan back, unlock.
   * Toggle via CameraLock / CameraUnlock actions.
   */
  locked = 0;

  /** Resolved follow target — null when none / lost. Re-resolved on init,
   *  on target-mode change, or when SetTarget is called. */
  private currentTarget: Sprite | null = null;
  /** Internal lerp state for offset — eases toward (offsetX, offsetY).
   *  Initialized from the configured target offset at init() so static
   *  offsets don't pop on the first frame. */
  private _smoothOffsetX = 0;
  private _smoothOffsetY = 0;
  /** Last deadzone size pushed to Phaser. setDeadzone() re-centers the camera
   *  on the follow target every time it's called, so calling it each frame
   *  snaps the camera onto the target and defeats the deadzone — only call it
   *  when the size actually changes. NaN = nothing applied yet. */
  private _appliedDzW = NaN;
  private _appliedDzH = NaN;

  init(): void {
    // Seed the offset lerp state so static offsets don't pop on frame 1.
    // X seed picks the directional offset matching the host's current facing.
    const facingLeftAtInit = this.sprite.facingScaleX < 0;
    this._smoothOffsetX = facingLeftAtInit ? this.offsetLeftX : this.offsetRightX;
    this._smoothOffsetY = this.offsetY;
    this.resolveAndAttach();
    this.applyAllSettings();
  }

  update(_delta: number): void {
    // Re-resolve a tag target if it died — common on enemy-defeat / scene
    // transitions. ALSO re-resolve if we're in tag mode and never found
    // one (e.g. the target sprite spawned AFTER us in the scene's instance
    // list, so it didn't exist at our init() time).
    if (this.targetMode === "tag" && (!this.currentTarget || !this.currentTarget.scene)) {
      this.resolveAndAttach();
    }
    // Always reapply settings each frame. Cheap, and avoids a class of bugs
    // where Phaser's startFollow() — including any re-resolution call — resets
    // the camera's lerp to (1, 1), undoing the user's smoothing setting. If
    // the user mutates `smoothing` / `followX` / `zoom` etc. via runtime
    // actions, the next frame picks it up automatically.
    this.applyAllSettings();
  }

  /**
   * Push every camera-controlling field to Phaser. Called from init,
   * resolveAndAttach (after startFollow which resets lerp), and update.
   * No change-detection — this is all O(1) field assignment.
   */
  private applyAllSettings(): void {
    const cam = this.sprite.scene.cameras.main;
    // Smoothing → per-frame lerp on a LOG curve so the whole 0..1 range is
    // usable. A linear map (1 - smoothing) crammed all the real smoothing into
    // 0.9..0.99 (0.1..0.7 felt identical) and made 1 = lerp 0 = frozen. Here:
    //   0   = instant snap (lerp 1)
    //   0.5 = lerp 0.1   (the old "0.9" sweet spot)
    //   1   = very smooth (lerp 0.01 — still follows, NOT frozen)
    const s = Math.max(0, Math.min(1, this.smoothing));
    const lerpFactor = Math.pow(0.01, s);
    const lerpX = this.followX ? lerpFactor : 0;
    const lerpY = this.followY ? lerpFactor : 0;
    cam.setLerp(lerpX, lerpY);
    cam.setZoom(Math.max(0.01, this.zoom));
    // CRITICAL: Phaser's follow logic short-circuits past `lerp` when a
    // deadzone is set (even one with zero size). Setting setDeadzone(0, 0)
    // creates a 0×0 deadzone rectangle, which makes Phaser snap the camera
    // to the target every frame regardless of lerp — silently disabling
    // all smoothing. Only set a deadzone when the user actually wants one.
    const dx = Math.max(0, this.deadzoneX);
    const dy = Math.max(0, this.deadzoneY);
    const wantW = (dx > 0 || dy > 0) ? dx * 2 : -1; // -1 = no deadzone
    const wantH = (dx > 0 || dy > 0) ? dy * 2 : -1;
    // Only touch the deadzone when it changes — each setDeadzone() call snaps
    // the camera onto the target (Phaser re-centers scroll), which every frame
    // would defeat the deadzone AND the lerp.
    if (wantW !== this._appliedDzW || wantH !== this._appliedDzH) {
      this._appliedDzW = wantW;
      this._appliedDzH = wantH;
      if (wantW >= 0) cam.setDeadzone(wantW, wantH);
      else cam.setDeadzone(); // undefined clears it (Phaser sets it to null)
    }
    // Pick the X offset based on the follow target's facing (scaleX sign).
    // Falls back to the host sprite's facing when the target hasn't
    // resolved yet (e.g. first frame of tag-mode lookup). For a static
    // offset, set offsetLeftX === offsetRightX.
    const facingSrc = this.currentTarget ?? this.sprite;
    const facingLeft = facingSrc.facingScaleX < 0;
    const targetOffsetX = facingLeft ? this.offsetLeftX : this.offsetRightX;
    // Offset lerp — eases the *applied* offset toward the configured
    // target each frame. With offsetSmoothing=0 it snaps; with ~0.9 it
    // glides over a few hundred ms. Using same "0=instant, 1=stuck"
    // convention as the main `smoothing` field.
    // Same log curve as the follow smoothing above (see note) so offset
    // smoothing is usable across the whole 0..1 range, not just 0.9..0.99.
    const oLerp = Math.pow(0.01, Math.max(0, Math.min(1, this.offsetSmoothing)));
    this._smoothOffsetX += (targetOffsetX - this._smoothOffsetX) * oLerp;
    this._smoothOffsetY += (this.offsetY - this._smoothOffsetY) * oLerp;
    // Snap when we're within sub-pixel — avoids floating-point grind.
    if (Math.abs(targetOffsetX - this._smoothOffsetX) < 0.05) this._smoothOffsetX = targetOffsetX;
    if (Math.abs(this.offsetY  - this._smoothOffsetY) < 0.05) this._smoothOffsetY = this.offsetY;
    if (cam.followOffset) cam.followOffset.set(this._smoothOffsetX, this._smoothOffsetY);
  }

  /** Re-resolve the target and tell Phaser's main camera to follow it.
   *  No-ops while `locked` — cutscenes shouldn't be overridden. */
  private resolveAndAttach(): void {
    if (this.locked) return;
    const cam = this.sprite.scene.cameras.main;
    let target: Sprite | null = null;

    if (this.targetMode === "self") {
      target = this.sprite;
    } else if (this.targetMode === "sprite") {
      // Picking-driven follow: use the stashed sprite if it's still alive.
      target = this.targetSprite && !this.targetSprite.destroyed ? this.targetSprite : null;
    } else if (this.targetMode === "tag" && this.targetTag) {
      const all = (this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      // Exclude the host sprite from the lookup. Otherwise, if the user's
      // Camera BP happens to carry the same tag as their target, the Camera
      // matches itself first and follows a stationary point — which looks
      // like "camera doesn't follow."
      // Skip dead/pooled sprites — a pooled corpse stays in peaky.sprites, and
      // following it pins the camera on wherever the body was parked.
      target = all.find((s) => s !== this.sprite && !s.destroyed && !s._pooled && s.tags.has(this.targetTag)) ?? null;
      // Help debug "camera doesn't follow" — log once when a tag is set
      // but no matching sprite exists. Lists the tags actually present so
      // typos are obvious. Suppressed after the first failure.
      if (!target && !this._loggedMissing) {
        const presentTags = new Set<string>();
        for (const s of all) for (const t of s.tags) presentTags.add(t);
        console.warn(
          `[Camera] Looking for sprite with tag "${this.targetTag}" — none found. ` +
          `Tags present in scene: [${[...presentTags].join(", ") || "(none)"}]. ` +
          `Tags are case-sensitive. Verify the player BP's tag list.`,
        );
        this._loggedMissing = true;
      }
    } else if (this.targetMode === "tag" && !this.targetTag && !this._loggedMissing) {
      console.warn(`[Camera] targetMode is "tag" but targetTag is empty — set a tag in the Camera component.`);
      this._loggedMissing = true;
    }

    if (target) {
      // roundPixels=false: when smoothing is non-zero, the camera lerps
      // sub-pixel each frame. Forcing pixel-rounding (true) collapses
      // those tiny movements to integer steps, making smoothing visibly
      // jump in 1px chunks instead of gliding. If pixel-perfect rendering
      // is needed, that's a separate concern at the renderer level
      // (texture filter, integer scale), not the camera follow.
      //
      // Pass lerpX/lerpY directly to startFollow so the lerp is set on
      // the SAME frame the follow target is registered. Calling setLerp
      // afterwards left a one-frame window where Phaser's first preRender
      // used the default (1, 1) snap lerp. Computing the lerp here mirrors
      // applyAllSettings's formula so the values match.
      const lerp = Math.max(0, Math.min(1, this.smoothing));
      const lerpX = this.followX ? (1 - lerp) : 0;
      const lerpY = this.followY ? (1 - lerp) : 0;
      cam.startFollow(target.gameObject, false, lerpX, lerpY);
      this.currentTarget = target;
      this._loggedMissing = false; // arm the warning again if target dies
      // applyAllSettings still runs to handle deadzone / zoom / offset
      // — fields startFollow doesn't accept directly.
      this.applyAllSettings();
    } else {
      cam.stopFollow();
      this.currentTarget = null;
    }
  }
  private _loggedMissing = false;

  /** Public APIs for runtime actions to call. */

  /** Switch target by tag — matches the FIRST sprite carrying it. */
  setTargetByTag(tag: string): void {
    this.targetMode = "tag";
    this.targetTag = tag;
    this.targetSprite = null;
    this.resolveAndAttach();
  }

  /** Follow a SPECIFIC sprite (picking-driven — clicked / collided). */
  setTargetSprite(s: Sprite): void {
    this.targetMode = "sprite";
    this.targetTag = "";
    this.targetSprite = s;
    this.resolveAndAttach();
  }

  /** Snap back to following the host sprite. */
  setTargetSelf(): void {
    this.targetMode = "self";
    this.targetTag = "";
    this.resolveAndAttach();
  }

  stopFollow(): void {
    this.sprite.scene.cameras.main.stopFollow();
    this.currentTarget = null;
  }

  /** Freeze the camera at its current position. While locked, follow logic
   *  is suppressed and SetTarget is queued — pan still works (cutscenes).
   *  `position`, when given, snaps the camera there before locking. */
  lock(position?: { x: number; y: number }): void {
    const cam = this.sprite.scene.cameras.main;
    cam.stopFollow();
    if (position) cam.centerOn(position.x, position.y);
    this.locked = 1;
    this.currentTarget = null;
  }

  /** Resume follow — re-resolves the configured target and reattaches. */
  unlock(): void {
    this.locked = 0;
    this.resolveAndAttach();
  }

  /**
   * Smoothly pan to a world position over `durationSec`. Uses Phaser's
   * built-in pan effect; runs whether locked or not (cutscene-friendly).
   * `ease` defaults to "Sine.easeInOut" — pass "Linear" for a constant
   * scrub or any Phaser ease string for custom curves.
   */
  panTo(x: number, y: number, durationSec: number, ease: string = "Sine.easeInOut"): void {
    const cam = this.sprite.scene.cameras.main;
    const ms = Math.max(0, durationSec * 1000);
    cam.pan(x, y, ms, ease);
  }

  /** Pan smoothly to whatever sprite carries the given tag. No-op if no
   *  matching sprite is found. */
  panToTag(tag: string, durationSec: number, ease: string = "Sine.easeInOut"): void {
    if (!tag) return;
    const all = (this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const target = all.find((s) => !s.destroyed && !s._pooled && s.tags.has(tag));
    if (!target) return;
    this.panTo(target.gameObject.x, target.gameObject.y, durationSec, ease);
  }

  /** Read-only — true while a smooth pan effect is in flight. */
  isPanning(): boolean {
    return !!this.sprite.scene.cameras.main.panEffect.isRunning;
  }

  shake(durationSec: number, intensity: number, force = false): void {
    // Phaser's shake intensity is 0..1; we accept px-style numbers (0..30
    // typical) and map to a sane range. Anything ≥10 saturates at 0.05.
    // `force` restarts an already-running shake; without it Phaser ignores
    // the new trigger while one is in flight.
    const ms = Math.max(0, durationSec * 1000);
    const i = Math.max(0, Math.min(0.05, intensity / 200));
    this.sprite.scene.cameras.main.shake(ms, i, force);
  }

  stopShake(): void {
    this.sprite.scene.cameras.main.shake(0, 0);
  }

  flash(durationSec: number, r = 255, g = 255, b = 255, force = false): void {
    this.sprite.scene.cameras.main.flash(Math.max(0, durationSec * 1000), r, g, b, force);
  }

  fade(durationSec: number, r = 0, g = 0, b = 0, fadeOut = true): void {
    const cam = this.sprite.scene.cameras.main;
    const ms = Math.max(0, durationSec * 1000);
    if (fadeOut) cam.fade(ms, r, g, b);
    else cam.fadeFrom(ms, r, g, b);
  }

  /** Read-only — true while a shake effect is active. */
  isShaking(): boolean {
    return !!this.sprite.scene.cameras.main.shakeEffect.isRunning;
  }

  onDestroy(): void {
    // Stop the camera from chasing a dead body.
    if (this.currentTarget === this.sprite) {
      this.sprite.scene.cameras.main.stopFollow();
    }
    this.currentTarget = null;
  }
}
