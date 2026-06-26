import { Behavior } from "../Behavior";

/**
 * Animator — generic keyframe-based tween system. Attaches to any BP and
 * drives ADDITIVE position / scale / opacity / rotation offsets on a
 * named target component over a sequence of keyframes.
 *
 * Distinct from CharacterAnimator (which is a state machine for sprite
 * animation slots). Animator is "play this position+scale+alpha tween
 * over 0.6s on the Widget component when the NPC takes a hit."
 *
 * Authoring model:
 *   - List of named animations on the component
 *   - Each animation targets ONE component on the host BP (Widget, Text,
 *     SpriteRenderer, Collider) or "host" for the BP itself
 *   - Keyframes are ordered by `time` (seconds). At t=0 the FIRST keyframe
 *     applies; at t=duration the LAST. Between, linear lerp (eased)
 *   - Values are ADDITIVE: an offsetX of 20 ADDS 20px to the component's
 *     authored offsetX. Opacity 0.5 MULTIPLIES authored alpha by 0.5.
 *     Authored values stay intact — animation contribution returns to
 *     identity (0/0/1/1/0) when the anim ends.
 *
 * Runtime:
 *   - `play(name)` starts the animation, capturing the current sim-time
 *   - `update()` interpolates each playing animation's current values
 *     and writes them into the target component's `animOffsetX/Y`,
 *     `animScale`, `animOpacity`, `animRotation` buffer fields
 *   - Components read those buffers in their own per-tick render code
 *     (sync overlay / apply layer) and add them to authored values
 *   - Loop wraps `elapsed` around `duration`; one-shot pins at the
 *     last keyframe's values then clears
 *
 * Composition with other systems:
 *   - Text component's built-in `animate` tween is being deprecated in
 *     favor of attaching Animator with `target=Text`. Until that lands,
 *     both can coexist — Text's own tween writes to overlay directly,
 *     Animator writes to the buffers which Text's sync also reads
 */

export interface AnimatorKeyframe {
  /** Time in seconds since animation start. Must be 0..duration. */
  time: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  opacity: number;
  rotation: number;
  /** Optional tint color (0xRRGGBB), lerped across keyframes and applied to the
   *  target's sprite. -1 / undefined = no tint contribution (clears any). Lets
   *  a SmartTween flash red on hit, fade to grey on death, etc. */
  tint?: number;
  /** Optional signal emitted on the host's event bus when the playhead
   *  CROSSES this keyframe's time (edge — once per pass, re-armed each
   *  loop). Lets a SmartTween fire a hit-signal at the exact pose its
   *  transform reaches — e.g. emit "atk" at the swing apex so a Tracer
   *  pivoting from the weapon sprite fires with the weapon already there.
   *  Empty / undefined = no signal. */
  signal?: string;
}

export type AnimatorEasing = "linear" | "easeIn" | "easeOut" | "back" | "bounce";

export interface AnimatorAnimation {
  name: string;
  /** Component kind to drive — "host" targets the sprite's gameObject
   *  directly. For other kinds the runtime looks up the first behavior
   *  of that kind (multi-instance behaviors like Text use first attached;
   *  future: optional behavior-name filter for disambiguation). */
  target: string;
  durationSec: number;
  loop: number;
  playOnStart: number;
  easing: AnimatorEasing;
  keyframes: AnimatorKeyframe[];
  /** When 1, mirror `offsetX` and `rotation` based on the host sprite's
   *  current facing (`sprite.facingScaleX`). Lets a single "sword swing
   *  right" animation also play correctly when the character faces left
   *  (the swing arcs in the opposite direction). 0 = never mirror. */
  mirror?: number;
  /** When 1, the tint is applied as a SOLID FILL (Phaser setTintFill) instead
   *  of a multiply — the sprite becomes a flat silhouette of the tint color, so
   *  a WHITE tint = a full-white flash. 0 / missing = multiply (default). */
  tintFill?: number;
}

interface PlayState {
  startSimSec: number;
  /** Sim time at which the loop most recently wrapped — used to keep the
   *  elapsed math stable across long-running loops without accumulating
   *  floating-point drift. */
  loopAnchorSec: number;
  /** Previous tick's `elapsed` for this animation — used to detect when
   *  the playhead CROSSES a keyframe time so per-keyframe `signal`s fire
   *  exactly once per pass. -1 = first tick (no crossing yet). */
  prevElapsed: number;
}

interface AnimSample {
  offsetX: number;
  offsetY: number;
  scale: number;
  opacity: number;
  rotation: number;
  /** 0xRRGGBB tint, or -1 for "no tint contribution". */
  tint: number;
  /** When true, apply the tint as a solid fill (setTintFill) — white = flash. */
  tintFill?: boolean;
}

/** Lerp two tint colors per RGB channel. A -1 endpoint ("no tint") is treated
 *  as white (0xffffff, the neutral tint) so fades to/from "no tint" look right.
 *  When BOTH ends are -1, the result is -1 (no tint at all). */
function lerpTint(a: number, b: number, t: number): number {
  if (a < 0 && b < 0) return -1;
  const ca = a < 0 ? 0xffffff : a, cb = b < 0 ? 0xffffff : b;
  const ar = (ca >> 16) & 0xff, ag = (ca >> 8) & 0xff, ab = ca & 0xff;
  const br = (cb >> 16) & 0xff, bg = (cb >> 8) & 0xff, bb = cb & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Identity values written to the target's buffer when no animation is
 *  contributing to a given prop. Authored values pass through unchanged.
 *
 *  Opacity uses -1 as a "no contribution" sentinel instead of 1 — the
 *  consuming behavior (Text / SpriteRenderer / Widget) treats a negative
 *  animOpacity as "use base alpha", and any 0..1 value as an absolute
 *  OVERRIDE of the base. This dodges the multiplication trap where a
 *  base alpha of 0 (e.g. "spawn invisible, fade in via animator") would
 *  clamp every animator-driven alpha to 0 too. */
const IDENTITY: AnimSample = Object.freeze({
  offsetX: 0, offsetY: 0,
  scale: 1, opacity: -1, rotation: 0, tint: -1,
});

export class Animator extends Behavior {
  // Display name "Smart Tween". Class/file kept as `Animator`; the
  // saved + lookup kind string is "SmartTween".
  kind = "SmartTween";

  animations: AnimatorAnimation[] = [];

  /** Custom scale pivot for this tween's scale keyframes, as a frame-local px
   *  offset from the sprite's frame pivot. Authored via a draggable point in
   *  the BP preview. Forwarded to the target each tick (SpriteRenderer applies
   *  it). 0,0 = scale from the frame pivot (default / legacy). */
  scalePivotX = 0;
  scalePivotY = 0;

  /** -1 = follow the global timeScale (default). >= 0 = run on the RAW frame
   *  delta at this scale instead — set by a HitStop with `affectSmartTween`
   *  OFF so the tween keeps playing THROUGH the freeze (e.g. a white flash). */
  private _simScaleOverride = -1;
  setSimTimeScale(n: number): void { this._simScaleOverride = n; }

  /** Scaled sim-time accumulator (seconds). Advanced by the timeScale-
   *  adjusted delta each tick so playback honors SetTimeScale (slow-mo,
   *  hitstop, pause). Used as the time source for keyframe playback +
   *  per-keyframe signals instead of wall-clock scene.time.now. */
  private _simTime = 0;

  /** Currently-playing animations keyed by name. Multiple animations can
   *  play simultaneously as long as they target DIFFERENT components —
   *  same-target anims overwrite each other's buffer writes each tick. */
  private _playing = new Map<string, PlayState>();
  /** Targets that had at least one animation contributing last tick.
   *  We re-write IDENTITY to these next tick if no animation owns them
   *  anymore, so the contribution returns to zero cleanly. Without this,
   *  the LAST animation's final values would linger forever. */
  private _activeTargets = new Set<string>();
  /** Per-target "pinned" values from a one-shot animation's last
   *  keyframe. When a non-looping anim finishes, its last-keyframe
   *  values get pinned here so the contribution PERSISTS instead of
   *  snapping back to identity on the next tick. Cleared per-target
   *  when stop(name) targets that anim's target, or wholesale by
   *  stopAll(). A new animation on the same target overrides the pin
   *  the moment its sampled values land in buf. */
  private _pinned = new Map<string, AnimSample>();
  /** Body's natural width / height captured at init — used by host-target
   *  scale animations to resize the COLLISION rect proportionally so a
   *  "shrink whole BP" animation actually changes how the sprite collides.
   *  Stays 0 when the sprite has no arcade body (UI widgets, scene host). */
  private _baseBodyW = 0;
  private _baseBodyH = 0;

  init(): void {
    // Snapshot the body's natural size so host-target scale animations can
    // proportionally resize the COLLISION RECT alongside the visual scale.
    // Captured at init AFTER Collider's own init runs (behaviors attach in
    // order; Collider typically lands before Animator in the BP's chip
    // chain). If a BP has no body (UI widget, scene host), the values stay
    // 0 and the scaling code skips itself.
    const body = this.sprite.body;
    if (body) {
      this._baseBodyW = body.width;
      this._baseBodyH = body.height;
    }
    // playOnStart animations fire on the first update tick after init
    // (not init itself) so other behaviors have a chance to wire their
    // own state first. Stamped via a flag the caller sets, but simplest
    // path: call play() at end of init.
    let didPlay = false;
    for (const a of this.animations) {
      if (a.playOnStart) {
        this.play(a.name);
        didPlay = true;
      }
    }
    // Immediately apply the first-frame sample so a "scale 0 → 1" anim
    // doesn't flash the natural scale 1 pose for one tick before update()
    // runs. The first update() call samples at elapsed=0, which writes the
    // start keyframe's values into every target overlay's anim buffer.
    if (didPlay) this.update(0);
  }

  /** Start (or restart) the named animation. No-op if name doesn't match.
   *  When `override = false` AND the animation is already playing, leaves
   *  the current playback alone (lets one-shots finish before re-triggering).
   *  Default `override = true` matches the legacy "always restart" behavior. */
  play(name: string, override = true): void {
    const a = this.animations.find((x) => x.name === name);
    if (!a) {
      console.warn(`[Animator] uid=${this.sprite.uid} play("${name}") FAILED — no animation with that name. Available: [${this.animations.map((x) => x.name).join(", ") || "(none)"}]`);
      return;
    }
    if (!override && this._playing.has(name)) return;
    // Use the animator's SCALED sim clock (advanced by the timeScale-
    // adjusted delta in update) — NOT wall-clock scene.time.now — so
    // SmartTween playback honors SetTimeScale: slow-mo slows the swing,
    // hitstop freezes it, pause pauses it. Both play() and update() must
    // read the same clock or elapsed math drifts.
    const now = this._simTime;
    this._playing.set(name, { startSimSec: now, loopAnchorSec: now, prevElapsed: -1 });
    // Drop any pinned end-state for this target so a replayed one-shot
    // re-traverses its keyframes cleanly. Without the clear, a tick that
    // misses the buf-write (target lookup transient miss) falls back to
    // the stale pinned value — e.g., a Death anim that previously
    // finished at opacity 0 would keep the sprite invisible during the
    // replay's opening frames.
    this._pinned.delete(a.target);
  }

  /** Stop the named animation. Buffer contributions are cleared on the
   *  next update tick (via _activeTargets). Also unpins any one-shot
   *  end-state for the same target so the contribution snaps to
   *  identity instead of lingering at the pinned values. Idempotent. */
  stop(name: string): void {
    const a = this.animations.find((x) => x.name === name);
    this._playing.delete(name);
    if (a) this._pinned.delete(a.target);
  }

  /** Stop every animation. Same buffer-clear behavior as stop() and
   *  drops every pinned end-state. */
  stopAll(): void {
    this._playing.clear();
    this._pinned.clear();
  }

  /** Read by IsAnimatorAnimPlaying condition. */
  isPlaying(name: string): boolean {
    return this._playing.has(name);
  }

  /** +1 normally, -1 when the animation has `mirror = 1` and the host sprite
   *  is facing left (`facingScaleX < 0`). Applied to offsetX and rotation
   *  in the sample loop so left-facing swings arc the opposite way without
   *  authoring a separate left-side animation. Guarded against a missing
   *  sprite reference (defensive — Behavior.sprite is always set in normal
   *  flow but a hot-reload hand-off could nullify briefly). */
  private _mirrorSign(a: AnimatorAnimation): number {
    if (!a.mirror) return 1;
    const fs = this.sprite?.facingScaleX;
    return typeof fs === "number" && fs < 0 ? -1 : 1;
  }

  /** Cleanup on host destroy — drops the playing-state Map so a long-
   *  running scene that spawns and destroys many Animator-bearing BPs
   *  doesn't accumulate dead entries. */
  onDestroy(): void {
    this._playing.clear();
    this._activeTargets.clear();
    this._pinned.clear();
  }

  update(_delta: number): void {
    // Advance the scaled sim clock every tick (BEFORE the early return so
    // it stays continuous). `_delta` is already timeScale-adjusted by
    // Sprite.tick, so this freezes on pause and slows in slow-mo — UNLESS a
    // HitStop set an override (affectSmartTween OFF), in which case we run off
    // the raw frame delta so the tween plays through the freeze.
    const dt = this._simScaleOverride >= 0
      ? (this.sprite?.scene?.game?.loop?.delta ?? 0) * this._simScaleOverride
      : _delta;
    this._simTime += dt / 1000;
    if (this._playing.size === 0 && this._activeTargets.size === 0) return;

    // Per-target accumulated values for this tick — keyed by the target
    // identifier the animation declared. Multiple anims on the same target
    // overwrite (last-write-wins) since the animator doesn't blend.
    const buf = new Map<string, { offsetX: number; offsetY: number; scale: number; opacity: number; rotation: number; tint: number; tintFill?: boolean }>();
    // Scaled sim clock (see play()) — keeps SmartTween in lockstep with
    // SetTimeScale so keyframe playback + per-keyframe signals slow / pause
    // with the rest of the game instead of running at real wall-clock time.
    const nowSec = this._simTime;

    for (const [name, ps] of this._playing) {
      const a = this.animations.find((x) => x.name === name);
      if (!a) { this._playing.delete(name); continue; }
      // Duration is derived from the last keyframe's time — the
      // explicit durationSec field used to live in the inspector but was
      // redundant (authors had to keep two values in sync). Falls back
      // to the legacy field for older saves that didn't set keyframe
      // times explicitly, then to a sane floor so a zero-keyframe anim
      // doesn't divide by zero downstream.
      const lastKfTime = a.keyframes.length > 0 ? a.keyframes[a.keyframes.length - 1].time : 0;
      const duration = Math.max(0.001, lastKfTime || a.durationSec || 0.6);
      let elapsed = nowSec - ps.loopAnchorSec;
      if (elapsed >= duration) {
        if (a.loop) {
          // Re-anchor so subsequent loops measure from the wrap point.
          ps.loopAnchorSec += Math.floor(elapsed / duration) * duration;
          elapsed = nowSec - ps.loopAnchorSec;
        } else {
          // One-shot finished: stash the last keyframe's values in
          // `_pinned` so they PERSIST across subsequent ticks (until
          // the user explicitly stops or another anim overrides this
          // target). Without this pin, the cleanup pass below would
          // reset the target to identity next frame — making "fade out
          // and stay invisible" impossible to author.
          const last = a.keyframes[a.keyframes.length - 1];
          if (last) {
            const sign = this._mirrorSign(a);
            const vals = {
              offsetX: last.offsetX * sign, offsetY: last.offsetY,
              scale: last.scale, opacity: last.opacity,
              rotation: last.rotation * sign, tint: last.tint ?? -1, tintFill: !!a.tintFill,
            };
            buf.set(a.target, vals);
            this._pinned.set(a.target, vals);
          }
          this._playing.delete(name);
          // Emit signals so Logic Sheet `OnAnimatorAnimEnd` triggers fire
          // when a one-shot anim finishes. Generic `_animatorAnimEnd` for
          // "any anim finished" subscribers + named `_animatorAnimEnd:<name>`
          // for specific-anim subscribers. Mirrors the ParticleEmitter
          // burst-end convention.
          this.sprite.events.emit("_animatorAnimEnd");
          this.sprite.events.emit(`_animatorAnimEnd:${name}`);
          continue;
        }
      }
      // Per-keyframe signals — emit once when the playhead CROSSES a
      // keyframe's time this tick. Edge-detected via prevElapsed so a
      // signal fires exactly once per pass (and again on each loop, since
      // the wrap resets prevElapsed below). The first tick (prevElapsed
      // = -1) also fires any keyframe at/just-after 0 so a t=0 signal
      // isn't missed.
      const prev = ps.prevElapsed;
      for (const kf of a.keyframes) {
        if (!kf.signal) continue;
        const crossed = prev < 0
          ? elapsed >= kf.time
          : (prev < kf.time && elapsed >= kf.time);
        if (crossed) this.sprite.events.emit(kf.signal);
      }
      // Detect a loop wrap (elapsed jumped backwards) so prevElapsed
      // doesn't suppress a keyframe on the new pass.
      ps.prevElapsed = elapsed < prev ? -1 : elapsed;

      const sample = this.sampleKeyframes(a, elapsed);
      sample.tintFill = !!a.tintFill;
      const sign = this._mirrorSign(a);
      if (sign !== 1) {
        sample.offsetX *= sign;
        sample.rotation *= sign;
      }
      buf.set(a.target, sample);
    }

    // Write per-target buffers. Targets without an active write this
    // tick fall back to their pinned one-shot end-state if any; only if
    // BOTH buf and _pinned miss do we reset to identity. This is what
    // keeps a "fade to alpha 0" anim's final frame stuck at 0 instead
    // of snapping back to 1 the moment the anim ends.
    //
    // Iteration order is "host first, specific components after" so that
    // a more-specific target (e.g. "SpriteRenderer") OVERWRITES the
    // broadcast values from "host" on the overlapping component. Without
    // this, two anims — one with target="host" (hit flash on whole BP)
    // and one with target="SpriteRenderer" (death fade on art only) —
    // played in arbitrary order would produce arbitrary winners on the
    // SR component depending on which animator's play() ran first.
    const hostBuf = buf.get("host");
    if (hostBuf !== undefined) {
      this.writeToTarget("host", hostBuf);
      this._activeTargets.add("host");
    }
    for (const [target, vals] of buf) {
      if (target === "host") continue;
      this.writeToTarget(target, vals);
      this._activeTargets.add(target);
    }
    for (const target of this._activeTargets) {
      if (buf.has(target)) continue;
      const pinned = this._pinned.get(target);
      if (pinned) {
        this.writeToTarget(target, pinned);
      } else {
        this.writeToTarget(target, IDENTITY);
        this._activeTargets.delete(target);
      }
    }
  }

  /** Find the two keyframes bracketing `elapsed` and lerp between them
   *  with the animation's easing. Returns IDENTITY for empty keyframe
   *  lists (defensive — the editor doesn't allow this but saves might). */
  private sampleKeyframes(a: AnimatorAnimation, elapsed: number): AnimSample {
    const kfs = a.keyframes;
    if (kfs.length === 0) return { ...IDENTITY };
    if (kfs.length === 1) {
      const k = kfs[0];
      return { offsetX: k.offsetX, offsetY: k.offsetY, scale: k.scale, opacity: k.opacity, rotation: k.rotation, tint: k.tint ?? -1 };
    }
    // Find the keyframe pair surrounding `elapsed`. Assumes kfs are sorted
    // by time ascending — editor enforces; runtime falls back to linear
    // scan since N is small (<10 typical).
    let i = 0;
    for (let j = 0; j < kfs.length - 1; j++) {
      if (elapsed >= kfs[j].time && elapsed <= kfs[j + 1].time) { i = j; break; }
      if (elapsed > kfs[j + 1].time) i = j + 1;
    }
    if (i >= kfs.length - 1) {
      const k = kfs[kfs.length - 1];
      return { offsetX: k.offsetX, offsetY: k.offsetY, scale: k.scale, opacity: k.opacity, rotation: k.rotation, tint: k.tint ?? -1 };
    }
    const k0 = kfs[i];
    const k1 = kfs[i + 1];
    const span = Math.max(0.0001, k1.time - k0.time);
    const t = Math.max(0, Math.min(1, (elapsed - k0.time) / span));
    const e = this.applyEasing(t, a.easing);
    return {
      offsetX:  k0.offsetX  + (k1.offsetX  - k0.offsetX)  * e,
      offsetY:  k0.offsetY  + (k1.offsetY  - k0.offsetY)  * e,
      scale:    k0.scale    + (k1.scale    - k0.scale)    * e,
      opacity:  k0.opacity  + (k1.opacity  - k0.opacity)  * e,
      rotation: k0.rotation + (k1.rotation - k0.rotation) * e,
      tint:     lerpTint(k0.tint ?? -1, k1.tint ?? -1, e),
    };
  }

  private applyEasing(t: number, easing: AnimatorEasing): number {
    const x = Math.max(0, Math.min(1, t));
    switch (easing) {
      case "easeIn":  return x * x;
      case "easeOut": return 1 - (1 - x) * (1 - x);
      case "back": {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
      }
      case "bounce": {
        const n1 = 7.5625;
        const d1 = 2.75;
        if (x < 1 / d1)        return n1 * x * x;
        else if (x < 2 / d1) { const v = x - 1.5 / d1;  return n1 * v * v + 0.75; }
        else if (x < 2.5 / d1){ const v = x - 2.25 / d1; return n1 * v * v + 0.9375; }
        else                  { const v = x - 2.625 / d1; return n1 * v * v + 0.984375; }
      }
      case "linear":
      default: return x;
    }
  }

  /** Push the per-tick buffer values into the chosen target. Each target
   *  type knows which fields to write — Text/Widget have explicit anim
   *  buffer slots; "host" writes directly to the gameObject. */
  private writeToTarget(target: string, v: { offsetX: number; offsetY: number; scale: number; opacity: number; rotation: number; tint: number; tintFill?: boolean }): void {
    // Keyframe rotation is authored in DEGREES (the editor field + the scrub
    // preview both treat it as degrees). The runtime consumers add `animRotation`
    // straight onto Phaser's `rotation`, which is RADIANS — so without this
    // conversion a "15" became 15 radians (~859°) and the sprite spun fast past
    // 360°. Convert once here so every target gets radians.
    const animRotRad = v.rotation * Math.PI / 180;
    if (target === "host") {
      // Host = "the whole BP's visuals." Broadcasts the same buffer values
      // into EVERY visual component on this sprite — SpriteRenderer, Text,
      // Widget — so a single host-targeted animation fades the sprite art
      // AND any overlay labels together. The body rect itself stays
      // untouched because:
      //   - Position would fight CharacterMovement / physics
      //   - Alpha on the body is already 0 (invisible) — body rect is a
      //     pure physics handle, not a visual; writing alpha to it would
      //     show the black placeholder instead.
      // Scale on the body is preserved as before (squash-stretch etc.
      // still read obj.scaleX); we ADDITIONALLY write into each visual
      // component's anim buffer so multi-component BPs all animate.
      const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as unknown as {
        animOffsetX?: number; animOffsetY?: number;
        animScale?: number; animOpacity?: number; animRotation?: number; animTint?: number; animTintFill?: boolean;
        animScalePivotX?: number; animScalePivotY?: number;
      } | undefined;
      if (sr) {
        sr.animOffsetX = v.offsetX;
        sr.animOffsetY = v.offsetY;
        sr.animScale = v.scale;
        sr.animOpacity = v.opacity;
        sr.animRotation = animRotRad;
        sr.animTint = v.tint;
        sr.animTintFill = !!v.tintFill;
        sr.animScalePivotX = this.scalePivotX;
        sr.animScalePivotY = this.scalePivotY;
      }
      const texts = this.sprite.findBehaviorsByKind("Text") as unknown as Array<{
        animOffsetX?: number; animOffsetY?: number;
        animScale?: number; animOpacity?: number; animRotation?: number; animTint?: number;
      }>;
      for (const t of texts) {
        t.animOffsetX = v.offsetX;
        t.animOffsetY = v.offsetY;
        t.animScale = v.scale;
        t.animOpacity = v.opacity;
        t.animRotation = animRotRad;
        t.animTint = v.tint;
      }
      const w = this.sprite.findBehaviorByKind("Widget") as unknown as {
        animOffsetX?: number; animOffsetY?: number;
        animScale?: number; animOpacity?: number; animRotation?: number;
      } | undefined;
      if (w) {
        w.animOffsetX = v.offsetX;
        w.animOffsetY = v.offsetY;
        w.animScale = v.scale;
        w.animOpacity = v.opacity;
        w.animRotation = animRotRad;
      }
      // Body scaling — host target represents the WHOLE BP, so a scale
      // animation should resize the collision rect too. Without this a
      // shrink anim only fakes the look — the player keeps colliding at
      // full size. IDENTITY (v.scale === 1) restores the natural size.
      const body = this.sprite.body;
      if (body && this._baseBodyW > 0 && this._baseBodyH > 0) {
        const tw = this._baseBodyW * v.scale;
        const th = this._baseBodyH * v.scale;
        if (body.width !== tw || body.height !== th) body.setSize(tw, th);
      }
      return;
    }
    // Component target — supports two formats:
    //   • "Text" — first behavior of kind "Text" on the host (legacy /
    //     unambiguous case for single-instance components)
    //   • "Text:hpLabel" — kind=Text, behavior whose `name` field === "hpLabel"
    //     (multi-instance disambiguation — multiple Text / Tracer
    //     components on the same BP)
    const colon = target.indexOf(":");
    const kind = colon >= 0 ? target.slice(0, colon) : target;
    const wantName = colon >= 0 ? target.slice(colon + 1) : "";
    let b: { name?: string; animOffsetX?: number; animOffsetY?: number; animScale?: number; animOpacity?: number; animRotation?: number; animTint?: number; animTintFill?: boolean; animScalePivotX?: number; animScalePivotY?: number } | undefined;
    if (wantName) {
      // Multi-instance lookup — scan all behaviors of this kind, pick
      // the one whose `name` field matches. Falls back to first-found
      // if no match (defensive: editor could pass a stale name).
      const list = this.sprite.findBehaviorsByKind(kind as never) as unknown as Array<{ name?: string }>;
      b = (list.find((x) => x.name === wantName) ?? list[0]) as typeof b;
    } else {
      b = this.sprite.findBehaviorByKind(kind as never) as unknown as typeof b;
    }
    if (!b) return;
    b.animOffsetX = v.offsetX;
    b.animOffsetY = v.offsetY;
    b.animScale = v.scale;
    b.animOpacity = v.opacity;
    b.animRotation = animRotRad;
    b.animTint = v.tint;
    b.animTintFill = !!v.tintFill;
    b.animScalePivotX = this.scalePivotX;
    b.animScalePivotY = this.scalePivotY;
  }
}
