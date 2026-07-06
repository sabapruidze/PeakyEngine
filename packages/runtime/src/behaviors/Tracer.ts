import Phaser from "phaser";
import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";
import { spriteByUid } from "../Sprite";
import { getNeighbors, getNeighborsByTag } from "../spatialGrid";
import { Logger } from "../Logger";
import { segmentHitsPolygon, rectHitsPolygon, type NavGrid } from "../nav/NavGrid";

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). */
function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * UE5-inspired ray / box trace as a Behavior. Each tracer instance owns one
 * sample direction + one debug overlay; sprites can carry multiple tracers
 * (e.g. one for ground check, one for sight cone) disambiguated by `name`.
 *
 * Reading hit data from the SM:
 *   tracer:<name>.hit         → 1 if hit, 0 if not
 *   tracer:<name>.hitX/hitY   → world-space hit point
 *   tracer:<name>.actorX/Y    → hit actor's position (center)
 *   tracer:<name>.actorName   → hit actor's blueprint name
 *   tracer:<name>.distance    → pivot → hit-point distance (px)
 *
 * Mirroring: `pivotX` and `angle` are SPRITE-LOCAL — they flip with
 * `sprite.facingScaleX`. So angle=0 + facingRight → trace goes right;
 * angle=0 + facingLeft → trace goes left. `pivotY` and `dirY` never flip.
 *
 * Box-trace caveat: the box is built as an axis-aligned bounding box of the
 * swept line + thickness. For purely horizontal / vertical traces the box is
 * exact; for diagonal angles it conservatively over-includes corners. This
 * matches arcade physics' AABB-only world and keeps the test cheap.
 */
export interface TracerHit {
  hitX: number;
  hitY: number;
  actorX: number;
  actorY: number;
  actorName: string;
  actorUid: number;
  actorTags: string[];
  distance: number;
}

/** Axis-aligned bounds of a box tracer's hit area. The box is a rectangle of
 *  length = |end − pivot| (== `distance`) and width = `2*halfThick`
 *  (== thickness), oriented along the reach, reduced to its AABB.
 *
 *  This replaces the old `min/max(px,ex) ± halfThick` inflation, which padded
 *  halfThick onto the FRONT and BACK ends too — so a distance=25, thickness=25
 *  box came out 50×25 (you could never get a square). Now the length stays
 *  exactly `distance`; at angle 0 that's `distance × thickness`. */
function boxTraceAABB(px: number, py: number, ex: number, ey: number, halfThick: number): { minX: number; maxX: number; minY: number; maxY: number } {
  const dx = ex - px, dy = ey - py;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * halfThick, ny = (dx / L) * halfThick;
  const x0 = px + nx, x1 = ex + nx, x2 = ex - nx, x3 = px - nx;
  const y0 = py + ny, y1 = ey + ny, y2 = ey - ny, y3 = py - ny;
  return {
    minX: Math.min(x0, x1, x2, x3), maxX: Math.max(x0, x1, x2, x3),
    minY: Math.min(y0, y1, y2, y3), maxY: Math.max(y0, y1, y2, y3),
  };
}

export class Tracer extends Behavior {
  kind = "Tracer";
  /** Disambiguates when a sprite has multiple tracers. Used by the SM read
   *  syntax `tracer:<name>.<field>` and by Is/Just-Hit conditions' `tracer`
   *  field. Empty string is a valid name (matches the default-named tracer). */
  name = "";
  /** "line" | "box". */
  shape = "line";
  /** Trace length in px. */
  distance = 100;
  /** Direction in degrees, sprite-local. 0 = sprite-forward, 90 = down,
   *  -90 = up. Mirrors with facing on the X axis. */
  angle = 0;
  /** Pivot offset from sprite center in px, sprite-local. pivotX flips with
   *  facing so a tracer attached "in front of the muzzle" stays in front.
   *  Used as-is when `pivotSource = "manual"`, OR added on top of the
   *  resolved point when `pivotSource = "framePivot" | "imagePoint"`
   *  (useful for "muzzle + 5px forward" tweaks without re-editing the
   *  sprite). */
  pivotX = 0;
  pivotY = 0;
  /** Where the trace's start point lives:
   *   - "manual"     — purely from `pivotX`/`pivotY` relative to sprite center.
   *   - "framePivot" — follows the SpriteRenderer's current frame pivot
   *     (the editor's hotspot dot). pivotX/Y still apply as an offset.
   *   - "imagePoint" — follows a named image point on the current frame
   *     (set `imagePointName` to pick which one). Tracks per-frame motion
   *     so the trace sticks to e.g. a swinging weapon's tip across the
   *     animation. pivotX/Y still apply as an offset.
   *   - "weaponSlot" — follows a named image point on the WEAPON SPRITE
   *     equipped in a WeaponSlot (set `weaponSlotName` to pick which slot,
   *     `imagePointName` for the point on the weapon's frame). Lets the
   *     hit-trace originate from the sword's tip wherever the equipped
   *     weapon currently is. pivotX/Y still apply as an offset. */
  pivotSource = "manual";
  /** Image-point name used when `pivotSource = "imagePoint" | "weaponSlot"`.
   *  For "imagePoint" it matches a point on the SpriteRenderer's current
   *  frame; for "weaponSlot" it matches a point on the equipped weapon's
   *  current frame. */
  imagePointName = "";
  /** WeaponSlot name to read from when `pivotSource = "weaponSlot"`. Empty
   *  = first WeaponSlot on the host. */
  weaponSlotName = "";
  /** Set of `(tracerName | imagePointName | anim | frameIdx)` keys we've
   *  already warned about — keeps the console quiet when a multi-frame
   *  anim has the point on only some frames (one warn per missing
   *  frame, not per tick). */
  private _imagePointWarned = new Set<string>();
  /** When > 0, every hit sample auto-applies this damage to the target's
   *  `Damageable` (if present). Routed through Damageable.applyDamage so
   *  i-frames, hitstun, death, knockback, and OnDamageTaken / OnDeath
   *  signals are all honored automatically — no animator-side
   *  read-uid → emit-signal plumbing required for basic damage flow.
   *  Set to 0 to leave damage off and use signals manually. */
  damage = 0;
  /** When 1, damage / knockback / signals are applied to EVERY sprite
   *  that overlaps the trace geometry — not just the closest. Use for
   *  cleave / AOE / sword sweep that should hit multiple enemies in
   *  one swing. `lastHit` still reports the closest hit (so getter
   *  patterns like `GetTracerField(actorUid)` keep behaving sensibly).
   *  0 = single-target (closest only) — the default. */
  multiHit = 0;
  /** Optional knockback applied alongside the damage. Forward-relative
   *  X (auto-flipped by tracer's facing); world Y. Pair with
   *  Damageable.knockbackMultiplier on the target to scale. */
  knockbackX = 0;
  knockbackY = 0;
  /** Box mode only — perpendicular thickness of the swept box (px). */
  boxThickness = 16;
  /** Comma-separated tag list. Empty = hits any sprite with a body. Non-empty
   *  = only hits sprites carrying at least one of these tags. */
  tagFilter = "";
  /** "interval" (sample on a timer / every frame) or "signal" (sample only on
   *  the frame `triggerSignal` fires on the host sprite). Signal mode is the
   *  UE5-style fire-on-demand path — emit any signal (built-in or custom)
   *  to take exactly one sample. `lastHit` persists between fires either
   *  way, so SM conditions can read the most recent result at any time. */
  triggerMode = "interval";
  /** Signal mode only — name of the signal that fires a sample. Empty string
   *  = the tracer never samples (effectively disabled). Use any name your
   *  events emit (custom or built-in like `OnJump`, `OnDashStart`). */
  triggerSignal = "";
  /** When non-empty, sampling is gated on SR's currentAnimation matching
   *  this name. Lets a single Tracer be shared across attacks of the
   *  same shape but only fire while the right anim is playing. Empty =
   *  no animation gate (fires whenever the signal arrives). */
  fireAnim = "";
  /** When >= 0, sampling is gated on SR's currentFrameIdx matching this
   *  index. Pairs with `fireAnim` so the Tracer only fires on, say,
   *  attack1 frame 4 — the same frame your image point is on. Set to
   *  -1 to disable the frame gate. */
  fireFrame = -1;
  /** Signal mode only — seconds the hit result stays "live" after a sample
   *  before auto-clearing (lastHit → null, debug draw vanishes). Useful for
   *  melee hitboxes: signal fires, trace lands, hit is queryable for the
   *  windup, then clears so SM conditions stop firing.
   *  0 = never auto-clear (the hit stays until the next signal). */
  signalLifetimeSec = 0;
  /** Signal mode only — how many traces to fire per signal trigger. 1 = one
   *  shot per signal (default). >1 = a burst (e.g. 5 traces for a sweep
   *  attack). Burst samples are spaced by `intervalSec` (so set
   *  intervalSec=0 for "all on the same frame", or 0.05 for a quick fan). */
  signalCount = 1;
  /** Signal mode only — when the burst's count is exhausted, restart it
   *  (continuous machine-gun fire after the first signal). 0 = single burst
   *  per signal (default), 1 = loop until next signal re-arms or the
   *  behavior is disabled. */
  signalLoop = 0;
  /** Interval mode only. 0 = sample every frame; >0 = seconds between
   *  samples. Hit data + debug draw stay frozen on the previous result
   *  between samples (so e.g. a 0.1s interval gives 10 visible "pings" per
   *  second instead of strobing). */
  intervalSec = 0;
  /** Render the trace line / box overlay at runtime (1 = visible, 0 = off).
   *  OFF by default — debug visuals are a dev aid, not something shipped games
   *  should pay for on every tracer. Toggle on per-tracer while authoring. */
  debugDraw = 0;

  /** Last sampled hit. Null when the most recent sample missed. Persists
   *  between samples while `intervalSec > 0`. */
  lastHit: TracerHit | null = null;
  /** True for one frame after a sample produces a NEW hit (different actor
   *  than the previous sample, or first hit after a miss). Powers
   *  `TracerJustHit`. */
  justHit = false;

  private _lastSampleSec = -Infinity;
  /** Frame number on which `justHit` should be cleared. -1 = no clear pending.
   *  Set by `_sampleNow` whenever `justHit` becomes true; checked at the
   *  start of `update()`. Gives `justHit` a true 1-frame edge in BOTH
   *  interval and signal modes — without this, the old end-of-update
   *  clobber `if (_shotsRemaining === 0) justHit = false` ran in the same
   *  tick the sample fired, killing every interval-mode hit before any
   *  scene listener (DialogFlowRunner, OnTracerHit on remote sprites)
   *  could observe it. */
  private _justHitClearFrame = -1;
  private _gfx?: Phaser.GameObjects.Graphics;
  private _prevHitUid: number | null = null;
  /** Frozen geometry of the last sample, so the debug overlay matches what
   *  was actually traced (and not the live sprite position) between samples. */
  private _lastTraceGeom: { px: number; py: number; ex: number; ey: number; thick: number } | null = null;
  /** Sim seconds until the active/firing visual state ends. Drives the bright
   *  overlay in `_drawDebug` so a tuner can SEE the active window length —
   *  the whole point of the "see the longevity of the tracer" debug mode.
   *  Set on each sample; size = signalLifetimeSec for signal mode, or a
   *  short fixed window for interval mode. */
  private _activeUntilSec = -Infinity;
  /** Sim seconds until the hit-pulse fade completes. */
  private _hitPulseUntilSec = -Infinity;
  /** Where the most recent NEW hit landed — used by the pulse animation. */
  private _hitPulsePoint: { x: number; y: number } | null = null;
  /** Signal mode burst state. >0 means a burst is in flight: that many
   *  shots remain to fire (spaced by `intervalSec`). Re-armed by each
   *  signal fire (and by the loop wrap when `signalLoop` is on). */
  private _shotsRemaining = 0;
  /** CharacterAnimator.currentState captured at the moment the burst started.
   *  Each follow-up shot in update() compares against the host's current
   *  state — if it changed (hit→hurt, attack→idle, etc.) the burst cancels.
   *  Empty string = no Animator on host, or no state captured (interval mode). */
  private _burstStateName = "";
  /** Signal mode lifetime — wall clock (sim seconds) at which the current
   *  hit data should auto-clear. -Infinity = no expiry pending. */
  private _hitExpiresAtSec = -Infinity;
  /** Event-bus listener cleanup for signal-mode subscription. Bus listeners
   *  fire SYNCHRONOUSLY on emit — critical for sampling on the SAME visual
   *  frame the signal was emitted from. Without this, polling for the
   *  signal in `update()` would catch it one frame late (after SpriteRenderer
   *  already advanced the animation), so image-point lookups would land on
   *  the wrong frame. */
  private _signalUnsub: (() => void) | null = null;
  private _subscribedSignal = "";

  init(): void {
    this._gfx = this.sprite.scene.add.graphics();
    this._gfx.setDepth(this.sprite.gameObject.depth + 5);
    // Route to the same camera as the host sprite (world cam for BP
    // tracers, UI cam for UI-widget tracers). Without this, the gfx
    // is drawn by BOTH cameras — and since the UI cam ignores scroll,
    // the world tracer appears a second time at "absolute world"
    // coords (typically a few hundred px below the on-screen sprite,
    // matching the main cam's scrollY).
    this.sprite.routeOverlayToCamera(this._gfx);
    this._refreshSignalSubscription();
  }

  /** (Re)bind the EventBus listener for the configured trigger signal.
   *  Idempotent — safe to call every frame. Listener fires synchronously
   *  when the signal is emitted, so sampling happens during the same tick
   *  (and on the same animation frame) as the emit. */
  private _refreshSignalSubscription(): void {
    const wantName = this.triggerMode === "signal" ? this.triggerSignal.trim() : "";
    if (wantName === this._subscribedSignal) return;
    if (this._signalUnsub) {
      this._signalUnsub();
      this._signalUnsub = null;
    }
    this._subscribedSignal = wantName;
    if (wantName) {
      this._signalUnsub = this.sprite.events.on(wantName, () => {
        if (this._isInHitstun()) return;
        if (!this._frameGatePasses()) return;
        const total = Math.max(1, Math.floor(this.signalCount) || 1);
        this._burstStateName = this._currentStateName();
        this._sampleNow();
        this._shotsRemaining = total - 1;
      });
    }
  }

  private _currentStateName(): string {
    const ca = this.sprite.findBehaviorByKind("StateMachine") as { currentState?: string } | undefined;
    return ca?.currentState ?? "";
  }

  // Damageable sets hitstunUntilSec synchronously when damage applies, so
  // gating sample paths on isInHitstun() closes the 1-tick race where the
  // attack anim hasn't yet switched to hurt but the host is already being
  // damaged. Without this, a tracer fired with the host in hitstun (same
  // tick) lands as a "phantom" hit during the visible hurt state.
  private _isInHitstun(): boolean {
    const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
    return !!dmg?.isInHitstun?.();
  }

  /** Returns true when the configured `fireAnim` / `fireFrame` gate
   *  permits a sample right now. Empty `fireAnim` and fireFrame === -1
   *  mean no gate. Reads SR's currentAnimation / currentFrameIdx. */
  private _frameGatePasses(): boolean {
    if (!this.fireAnim && (this.fireFrame === undefined || this.fireFrame < 0)) return true;
    const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as unknown as { currentAnimation?: string; currentFrameIdx?: number } | undefined;
    if (!sr) return false;
    if (this.fireAnim && sr.currentAnimation !== this.fireAnim) return false;
    if (this.fireFrame >= 0 && (sr.currentFrameIdx ?? -1) !== this.fireFrame) return false;
    return true;
  }

  onDestroy(): void {
    this._signalUnsub?.();
    this._signalUnsub = null;
    this._gfx?.destroy();
    this._gfx = undefined;
  }

  update(_delta: number): void {
    // Re-bind signal listener if config changed. Idempotent + cheap.
    this._refreshSignalSubscription();

    // Hitstun cancels in-flight tracer state. When the host enters hitstun
    // (Damageable sets hitstunUntilSec synchronously during the event-sheet
    // phase between this tick and last), the active visualization window,
    // pending burst shots, and stale lastHit all need to clear immediately —
    // otherwise the previous attack's red box and queued follow-up shots
    // persist into the hurt animation. The _frameGatePasses / _isInHitstun
    // gates below only stop NEW samples; this clears the residue.
    if (this._isInHitstun()) {
      this._shotsRemaining = 0;
      this._burstStateName = "";
      this._activeUntilSec = 0;
      this._hitExpiresAtSec = -Infinity;
      if (this.lastHit) this.emitLost();
      this.lastHit = null;
      this._lastTraceGeom = null;
      this._prevHitUid = null;
      this.justHit = false;
      this._drawDebug();
      return;
    }

    // 1-frame edge for justHit. `_sampleNow` records the frame it set
    // justHit on; once we're past that frame, clear it. Runs BEFORE any
    // sample in this update — a sample that fires this tick will write
    // a fresh clear-frame and keep justHit alive through the rest of
    // the scene's UPDATE listeners (DialogFlowRunner, etc.).
    const curFrame = this.sprite.scene.game.loop.frame;
    if (this._justHitClearFrame >= 0 && curFrame >= this._justHitClearFrame) {
      this.justHit = false;
      this._justHitClearFrame = -1;
    }

    const now = this.sprite.simNowMs / 1000;

    // Auto-expire the previous sample's state after `signalLifetimeSec`.
    if (this._hitExpiresAtSec !== -Infinity && now >= this._hitExpiresAtSec) {
      // The hit clearing IS a "lost" edge (a signal-mode trace whose window
      // ended while still on a target). Fire it so OnTracerLost is symmetric.
      if (this._prevHitUid !== null) this.emitLost();
      this.lastHit = null;
      this._lastTraceGeom = null;
      this._prevHitUid = null;
      this._hitExpiresAtSec = -Infinity;
    }

    // Sampling cadence:
    //   • interval mode — driven entirely from update() polling here.
    //   • signal mode   — first shot fires SYNCHRONOUSLY in the listener
    //                     (so it runs on the same tick + animation frame as
    //                     the emit). update() only handles burst follow-ups
    //                     when `signalCount > 1`, spaced by `intervalSec`.
    if (this.triggerMode === "signal") {
      // Burst follow-up: subsequent shots after the first listener-fired
      // sample. Spaced by intervalSec. The state-name lock is the strict
      // gate — when the burst started we captured CharacterAnimator's
      // currentState (e.g. "Attack"); the moment the host transitions to
      // any other state (Hurt, Idle, Death, etc.) the burst cancels.
      // This is independent of fireAnim/fireFrame config — works even
      // when the author only wires the signal and no anim filter.
      const stateLockBroken = this._burstStateName !== "" && this._currentStateName() !== this._burstStateName;
      if (stateLockBroken) this._shotsRemaining = 0;
      if (this._shotsRemaining > 0 && !this._isInHitstun() && this._frameGatePasses()) {
        const interval = Number.isFinite(this.intervalSec) && this.intervalSec > 0 ? this.intervalSec : 0;
        if (interval === 0 || now - this._lastSampleSec >= interval) {
          this._sampleNow();
          this._shotsRemaining -= 1;
          if (this._shotsRemaining === 0 && this.signalLoop) {
            this._shotsRemaining = Math.max(1, Math.floor(this.signalCount) || 1) - 1;
          }
        }
      }
    } else if (!this._isInHitstun() && this._frameGatePasses()) {
      const interval = Number.isFinite(this.intervalSec) && this.intervalSec > 0 ? this.intervalSec : 0;
      if (interval === 0 || now - this._lastSampleSec >= interval) {
        this._sampleNow();
      }
    }

    // Always redraw the (frozen) debug overlay so it stays on screen
    // between samples. _sampleNow() also redraws on the frame it fires.
    // justHit auto-expiry when lastHit went null (e.g. signal-mode
    // lifetime ran out earlier in this update) — without this, an
    // expired sample could leave justHit stuck true until next sample.
    if (this.lastHit === null) this.justHit = false;
    this._drawDebug();
  }

  /** Take ONE sample right now using the current frame's geometry.
   *  Called by:
   *   - Interval mode polling in update()
   *   - The EventBus signal listener (synchronous on emit, so the sample
   *     uses the SAME visual frame the signal was fired from — critical
   *     for image-point lookups). */
  private _sampleNow(): void {
    // When pivotSource is imagePoint but the named point isn't on the
    // CURRENT frame, skip the sample entirely instead of falling back
    // to sprite center. The fallback was visually misleading ("yellow
    // fat tracer at sprite bottom") and obscured the real problem —
    // the user fired on a frame that doesn't carry the point. Now: no
    // active flash = no fire happened, so the wrong frame is obvious.
    // The _calcGeom warning still logs to the console for diagnosis.
    if (this.pivotSource === "imagePoint" && this.imagePointName) {
      const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as unknown as {
        getImagePointWorld?: (n: string) => { x: number; y: number } | null;
        currentAnimation?: string;
        currentFrameIdx?: number;
        currentImagePointNames?: () => string[];
        _animations?: Record<string, { frames: { points?: { name: string }[] }[] }>;
      } | null;
      if (!sr || !sr.getImagePointWorld || !sr.getImagePointWorld(this.imagePointName)) {
        const available = sr?.currentImagePointNames?.() ?? [];
        // Find every frame in the current anim that DOES carry the
        // named point — gives the author a direct copy-paste list for
        // their Frame Signals row.
        const animName = sr?.currentAnimation ?? "";
        const anim = sr?._animations?.[animName];
        const framesWithPoint: number[] = [];
        if (anim) {
          for (let i = 0; i < anim.frames.length; i++) {
            if (anim.frames[i]?.points?.some((p) => p.name === this.imagePointName)) {
              framesWithPoint.push(i);
            }
          }
        }
        if (this.debugDraw) {
          console.warn(`[Tracer "${this.name || "(unnamed)"} on ${this.sprite.blueprintName || "?"}"] sample SKIPPED — image point "${this.imagePointName}" not on anim "${animName}" frame ${sr?.currentFrameIdx ?? -1}. Available here: [${available.join(", ")}]. Frames in "${animName}" that DO have "${this.imagePointName}": [${framesWithPoint.join(", ") || "(none — point not in this anim)"}]`);
        }
        this._calcGeom();
        return;
      }
    }
    const now = this.sprite.simNowMs / 1000;
    this._lastSampleSec = now;

    // Actual sample / fire — warn if pivot lookup fails so authors know.
    const { px, py, ex, ey, thick } = this._calcGeom(true);
    this._lastTraceGeom = { px, py, ex, ey, thick };

    // Multi-hit collects EVERY overlapping target (and damages them
    // all); single-target keeps the legacy "closest only" semantics.
    // `lastHit` always reports the closest hit either way so getter
    // patterns (GetTracerField actorUid, etc.) still work.
    const allHits = this.multiHit ? this._sampleAll(px, py, ex, ey) : null;
    const hit = allHits ? (allHits[0] ?? null) : this._sample(px, py, ex, ey);
    const newUid = hit?.actorUid ?? null;
    // A "discrete fire" is one deliberate swing — signal-triggered, OR
    // interval mode with a real gap (intervalSec > 0). Each such fire
    // should CONNECT even against a target that's been inside the whole
    // time, so:
    //   • re-attacks land every swing (not just the first), and
    //   • a tracer that fires while ALREADY overlapping a target still hits.
    // Only continuous every-frame mode (interval mode, intervalSec === 0)
    // keeps the new-target edge gate, so a held trace doesn't melt a
    // target every frame.
    const isDiscreteFire = this.triggerMode === "signal" || this.intervalSec > 0;
    this.justHit = newUid !== null && (isDiscreteFire || newUid !== this._prevHitUid);
    // Schedule the 1-frame-edge clear. `+ 1` so the flag survives the
    // rest of this scene tick (including DialogFlowRunner / OnTracerHit
    // listeners on remote sprites) and clears at the START of the
    // tracer's NEXT update.
    if (this.justHit) {
      this._justHitClearFrame = this.sprite.scene.game.loop.frame + 1;
    }
    // Lost edge: was hitting an actor on the previous sample, now hits nothing.
    // Emit before overwriting _prevHitUid so OnTracerLost fires the moment a
    // sight/attack trace stops connecting (mirror of OnTracerHit).
    if (this._prevHitUid !== null && newUid === null) this.emitLost();
    this._prevHitUid = newUid;
    this.lastHit = hit;

    // Notify each hit TARGET (not just the owner) every sample the trace is on
    // it — so the target's own logic can react ("On Traced By"). Fired every
    // sample (not just the new-hit edge) so a target can detect "no tracer on
    // me for X seconds" by feeding this into a DebounceWait that resets on each
    // hit and finally fires X seconds after the last one. Payload = the owner.
    if (hit && newUid !== null) {
      const scene = this.sprite.scene;
      const targetUids = allHits ? allHits.map((h) => h.actorUid) : [newUid];
      for (const tu of targetUids) {
        const t = spriteByUid(scene, tu);   // O(1) index — was a full-list scan per sample
        if (!t) continue;
        t.events.emit("OnTracedBy", this.sprite);
        if (this.name) t.events.emit(`OnTracedBy:${this.name}`, this.sprite);
      }
    }

    // Auto-deal damage on hit when configured. Routes through the
    // target's Damageable so i-frames / hitstun / death signals are
    // all honored — saves authors from wiring read-uid + emit-signal
    // for the common "swing connects → apply damage" pattern. Only
    // applies on a NEW hit (justHit) so a long-lifetime sample doesn't
    // re-damage the same actor every tick it stays alive.
    if (hit && newUid !== null && this.justHit && this.damage > 0) {
      const scene = this.sprite.scene;
      const facingSign = this.sprite.facingScaleX < 0 ? -1 : 1;
      const targets: number[] = allHits
        ? allHits.map((h) => h.actorUid)
        : [newUid];
      for (const uid of targets) {
        const target = spriteByUid(scene, uid);   // O(1) index
        if (!target) continue;
        const dmgable = target.findBehaviorByKind("Damageable") as { applyDamage?: (amount: number, src?: Sprite, opts?: { knockbackX?: number; knockbackY?: number }) => boolean } | undefined;
        dmgable?.applyDamage?.(this.damage, this.sprite, {
          knockbackX: this.knockbackX * facingSign,
          knockbackY: this.knockbackY,
        });
      }
    }

    if (this.triggerMode === "signal" && this.signalLifetimeSec > 0) {
      this._hitExpiresAtSec = now + this.signalLifetimeSec;
    } else {
      this._hitExpiresAtSec = -Infinity;
    }

    // Active visual window — drives the bright overlay so a tuner can SEE
    // how long the tracer is hot during e.g. an attack animation. Signal
    // mode honors the user-set lifetime exactly (so the visible duration
    // matches the gameplay-active window). Interval mode gets a short
    // floor so single-shot samples are still visible.
    const activeSec = this.triggerMode === "signal" && this.signalLifetimeSec > 0
      ? this.signalLifetimeSec
      : (this.intervalSec > 0 ? Math.min(0.12, this.intervalSec * 0.6) : 0.05);
    this._activeUntilSec = now + activeSec;

    // Pulse fades over 0.25s at every NEW hit (different actor than previous
    // sample, or first hit after a miss).
    if (this.justHit && hit) {
      this._hitPulseUntilSec = now + 0.25;
      this._hitPulsePoint = { x: hit.hitX, y: hit.hitY };
      // Auto-emit so Logic Sheet's OnTracerHit trigger can subscribe
      // without per-event signal wiring. Fires once per new hit edge.
      // Generic event covers "any tracer", name-suffixed lets the
      // Logic Sheet trigger filter to a specific tracer (e.g. sight vs attack).
      this.sprite.events.emit("OnTracerHit");
      if (this.name) this.sprite.events.emit(`OnTracerHit:${this.name}`);
    }

    this._drawDebug();
  }

  /** Fire the "stopped hitting" edge. Generic event covers "any tracer";
   *  name-suffixed lets an OnTracerLost trigger filter to one tracer. */
  private emitLost(): void {
    this.sprite.events.emit("OnTracerLost");
    if (this.name) this.sprite.events.emit(`OnTracerLost:${this.name}`);
  }

  /** Compute the LIVE trace geometry from the current sprite position +
   *  facing + image-point. Used by `_sampleNow` for the actual trace AND
   *  by `_drawDebug` for the always-visible idle outline (so users see
   *  where the tracer WOULD shoot next, not just where it last shot). */
  private _calcGeom(warnOnMiss: boolean = false): { px: number; py: number; ex: number; ey: number; thick: number } {
    const obj = this.sprite.gameObject;
    const facingSign = this.sprite.facingScaleX < 0 ? -1 : 1;
    let originX = obj.x;
    let originY = obj.y;
    if (this.pivotSource === "weaponSlot") {
      // Pivot from a point on the equipped weapon's sprite. Pick the named
      // WeaponSlot (or the first one), read its current-frame image point.
      const slots = this.sprite.findBehaviorsByKind("WeaponSlot") as unknown as Array<{
        name?: string; getImagePointWorld?: (n: string) => { x: number; y: number } | null;
      }>;
      const want = this.weaponSlotName.trim();
      const slot = want ? slots.find((s) => String(s.name ?? "") === want) : slots[0];
      const resolved = slot?.getImagePointWorld?.(this.imagePointName) ?? null;
      if (resolved) {
        originX = resolved.x;
        originY = resolved.y;
      }
    } else if (this.pivotSource === "framePivot" || this.pivotSource === "imagePoint") {
      const sr = this.sprite.findBehaviorByKind("SpriteRenderer");
      const resolved = !sr ? null
        : this.pivotSource === "framePivot"
          ? sr.getFramePivotWorld()
          : sr.getImagePointWorld(this.imagePointName);
      if (resolved) {
        originX = resolved.x;
        originY = resolved.y;
      } else if (this.pivotSource === "imagePoint" && warnOnMiss) {
        // Lookup failed. Warn ONCE per unique (tracer-name, missing-name,
        // current-anim, current-frame) combo so the console doesn't spam
        // when a tracer in a multi-frame anim doesn't carry the point on
        // every frame. Authors most often hit this from a name typo
        // (case / trailing space) or because the named point only
        // exists on a different frame than the one playing right now.
        //
        // Only warn on ACTUAL FIRE samples — the per-frame debug-draw
        // refresh used to log this once per frame the animation played,
        // even when the tracer never fired, which spammed the Output Log
        // with one warn per frame for every attack animation. Now silent
        // when called from _drawDebug (warnOnMiss=false default) and only
        // chatty when called from _sampleNow / the trigger path.
        const srAny = sr as unknown as { currentAnimation?: string; currentFrameIdx?: number; currentImagePointNames?: () => string[] } | null;
        const animName = srAny?.currentAnimation ?? "?";
        const frameIdx = srAny?.currentFrameIdx ?? -1;
        const warnKey = `${this.name}|${this.imagePointName}|${animName}|${frameIdx}`;
        if (!this._imagePointWarned.has(warnKey)) {
          this._imagePointWarned.add(warnKey);
          const available = srAny?.currentImagePointNames?.() ?? [];
          Logger.log({
            level: "warn",
            source: "Tracer",
            message: `Tracer "${this.name || "(unnamed)"}" looked up image point "${this.imagePointName}" on anim "${animName}" frame ${frameIdx} — not found. Available points on this frame: [${available.join(", ") || "(none)"}]. Falling back to sprite center. Check the name for typos / case / trailing whitespace and confirm the point exists on the frame the tracer fires on.`,
          });
        }
      }
    }
    // Fold the host scale so the trace reach + pivot offset + box thickness grow
    // WITH the BP when it's scaled (a bigger character has a proportionally
    // bigger reach). facingScaleX is the mirror sign (±1), handled by facingSign,
    // so use abs for the magnitude. Image-point origins are already in scaled
    // world space; only the ADDED pivot offset + reach need folding here.
    const sx = (Math.abs(obj.scaleX) || 1) * (this.sprite._renderScaleX || 1);
    const sy = (Math.abs(obj.scaleY) || 1) * (this.sprite._renderScaleY || 1);
    const px = originX + this.pivotX * facingSign * sx;
    const py = originY + this.pivotY * sy;
    const angleRad = (this.angle * Math.PI) / 180;
    const dirX = Math.cos(angleRad) * facingSign;
    const dirY = Math.sin(angleRad);
    const ex = px + dirX * this.distance * sx;
    const ey = py + dirY * this.distance * sy;
    return { px, py, ex, ey, thick: this.boxThickness * ((sx + sy) / 2) };
  }

  /** Box thickness folded by the host scale (matches `_calcGeom().thick`). The
   *  detection samplers MUST use this — not raw `boxThickness` — so a scaled BP's
   *  hit area matches its drawn tracer. `_lastTraceGeom` is set by `_sampleNow`
   *  just before any sampler runs; fall back to the raw value defensively. */
  private _scaledThick(): number {
    return this._lastTraceGeom?.thick ?? this.boxThickness;
  }

  /** Iterate scene sprites, return EVERY overlapping target (not just the
   *  closest). Used by multi-hit mode so a cleave can damage multiple
   *  enemies in one sweep. Closest-first ordering preserved so callers
   *  can still take [0] for the "primary" hit. */
  private _sampleAll(px: number, py: number, ex: number, ey: number): TracerHit[] {
    const filterTags = this._filterTags();
    const halfThick = this.shape === "box" ? this._scaledThick() / 2 : 0;
    const midX = (px + ex) * 0.5;
    const midY = (py + ey) * 0.5;
    const queryRadius = Math.hypot(ex - px, ey - py) * 0.5 + halfThick;
    const candidates = this._candidates(filterTags, midX, midY, queryRadius);

    const { minX: traceMinX, maxX: traceMaxX, minY: traceMinY, maxY: traceMaxY } = boxTraceAABB(px, py, ex, ey, halfThick);

    const hits: TracerHit[] = [];
    for (const s of candidates) {
      if (s === this.sprite || s.destroyed) continue;
      if (filterTags.length > 1 && !this._sIntersectsTags(s, filterTags)) continue;
      const body = s.body;
      if (!body) continue;
      // Skip disabled bodies (notably the TilemapRenderer host's giant
      // immovable-but-disabled stub) — see other Tracer code path for
      // full rationale.
      if ((body as Phaser.Physics.Arcade.Body).enable === false) continue;
      const bx = body.x, by = body.y, bw = body.width, bh = body.height;
      const br = bx + bw, bb = by + bh;

      let hitPx = 0, hitPy = 0;
      let hitDist = Infinity;
      if (this.shape === "box") {
        if (traceMinX >= br || traceMaxX <= bx || traceMinY >= bb || traceMaxY <= by) continue;
        const cx = px < bx ? bx : px > br ? br : px;
        const cy = py < by ? by : py > bb ? bb : py;
        hitPx = cx; hitPy = cy;
        hitDist = Math.hypot(cx - px, cy - py);
      } else {
        const line = new Phaser.Geom.Line(px, py, ex, ey);
        const out: Phaser.Geom.Point[] = [];
        const bodyRect = new Phaser.Geom.Rectangle(bx, by, bw, bh);
        Phaser.Geom.Intersects.GetLineToRectangle(line, bodyRect, out);
        if (out.length === 0) continue;
        for (const p of out) {
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < hitDist) { hitDist = d; hitPx = p.x; hitPy = p.y; }
        }
      }
      if (hitDist < Infinity) {
        hits.push({
          hitX: hitPx, hitY: hitPy,
          actorX: s.gameObject.x, actorY: s.gameObject.y,
          actorName: s.instanceName || s.blueprintName,
          actorUid: s.uid,
          actorTags: [...s.tags],
          distance: hitDist,
        });
      }
    }
    // Tilemap pass (multi-hit) — mirror the single-hit version. Same
    // filter rules: empty filter OR explicit "tile" includes tiles.
    const includeTilesAll = filterTags.length === 0 || filterTags.indexOf("tile") >= 0;
    if (includeTilesAll) {
      this._tilemapHitInto(px, py, ex, ey, null, Infinity, (hit) => {
        hits.push(hit);
      }, /* closestOnly */ false);
    }
    for (const h of this._placementHits(px, py, ex, ey, filterTags)) hits.push(h);
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /** Iterate candidate sprites near the trace's bounding circle, find the
   *  closest body the trace hits. Uses the per-scene spatial grid instead
   *  of scanning all sprites — at 5000 NPCs this drops the inner loop from
   *  5000 iterations to ~10-50 per sample (only sprites in cells the trace
   *  overlaps). */
  private _sample(px: number, py: number, ex: number, ey: number): TracerHit | null {
    const filterTags = this._filterTags();
    const halfThick = this.shape === "box" ? this._scaledThick() / 2 : 0;
    const midX = (px + ex) * 0.5;
    const midY = (py + ey) * 0.5;
    const queryRadius = Math.hypot(ex - px, ey - py) * 0.5 + halfThick;
    const candidates = this._candidates(filterTags, midX, midY, queryRadius);

    const { minX: traceMinX, maxX: traceMaxX, minY: traceMinY, maxY: traceMaxY } = boxTraceAABB(px, py, ex, ey, halfThick);

    let best: TracerHit | null = null;
    let bestDist = Infinity;

    for (const s of candidates) {
      if (s === this.sprite || s.destroyed) continue;
      // When using multi-tag filter via getNeighbors (no single-tag fast
      // path), still need a per-sprite tag check.
      if (filterTags.length > 1 && !this._sIntersectsTags(s, filterTags)) continue;
      const body = s.body;
      if (!body) continue;
      // Skip bodies flagged but currently DISABLED — most notably the
      // TilemapRenderer host sprite, which carries an immovable body
      // covering the entire tilemap area but sets `enable = false` so
      // collisions are owned by the per-layer Phaser tilemap layers.
      // Without this, Tracer would report phantom hits on the giant
      // invisible body whenever its geometry crossed tilemap bounds.
      if ((body as Phaser.Physics.Arcade.Body).enable === false) continue;
      const bx = body.x, by = body.y, bw = body.width, bh = body.height;
      const br = bx + bw, bb = by + bh;

      let hitPx = 0, hitPy = 0;
      let hitDist = Infinity;

      if (this.shape === "box") {
        // Inline AABB intersect — was new Phaser.Geom.Rectangle(...) per
        // sprite per sample = severe GC pressure with 5000 tracers/frame.
        if (traceMinX >= br || traceMaxX <= bx || traceMinY >= bb || traceMaxY <= by) continue;
        const cx = px < bx ? bx : px > br ? br : px;
        const cy = py < by ? by : py > bb ? bb : py;
        hitPx = cx; hitPy = cy;
        hitDist = Math.hypot(cx - px, cy - py);
      } else {
        const line = new Phaser.Geom.Line(px, py, ex, ey);
        const out: Phaser.Geom.Point[] = [];
        const bodyRect = new Phaser.Geom.Rectangle(bx, by, bw, bh);
        Phaser.Geom.Intersects.GetLineToRectangle(line, bodyRect, out);
        if (out.length === 0) continue;
        for (const p of out) {
          const d = Math.hypot(p.x - px, p.y - py);
          if (d < hitDist) { hitDist = d; hitPx = p.x; hitPy = p.y; }
        }
      }

      if (hitDist < bestDist) {
        bestDist = hitDist;
        best = {
          hitX: hitPx,
          hitY: hitPy,
          actorX: s.gameObject.x,
          actorY: s.gameObject.y,
          actorName: s.instanceName || s.blueprintName,
          actorUid: s.uid,
          actorTags: [...s.tags],
          distance: hitDist,
        };
      }
    }
    // Tilemap pass — same intent as the sprite pass above, but for
    // tiles. Tiles carry an implicit "tile" tag, so we honor `tagFilter`:
    //  - filter empty → "any solid thing" → include tiles
    //  - filter has "tile" → explicit opt-in → include tiles
    //  - filter set but no "tile" → exclude tiles (the NPC sight tracer
    //    case: filter=["player"] should NEVER report ground as a hit)
    const includeTiles = filterTags.length === 0 || filterTags.indexOf("tile") >= 0;
    if (includeTiles) {
      this._tilemapHitInto(px, py, ex, ey, best, bestDist, (hit, dist) => {
        bestDist = dist;
        best = hit;
      });
    }
    // Nav-mesh pass — detect obstacle polygons + waypoints by tag/name. Only
    // when the filter NAMES them (a sight tracer filtered to ["player"] must not
    // trip on a wall unless the author tagged it "player"). actorUid = -1 marks
    // a non-sprite hit; TracerGetResult still reads hitX/hitY/actorName/tags.
    const navGrid = this.sprite.scene.data.get("peaky.navGrid") as NavGrid | undefined;
    if (navGrid && filterTags.length > 0) {
      // BOX tracers test their whole rectangle; LINE tracers test the segment.
      // Same boxTraceAABB as the sprite/tile/placement passes — the old
      // min/max±halfT inflation padded the FRONT and BACK ends too, so this
      // pass hit nav obstacles over a larger area than the drawn box.
      const isBox = this.shape === "box";
      const halfT = this._scaledThick() / 2;
      const { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY } = boxTraceAABB(px, py, ex, ey, halfT);
      for (const o of navGrid.obstacles) {
        if (!o.tags.some((t) => filterTags.indexOf(t) >= 0)) continue;
        const hits = isBox ? rectHitsPolygon(bMinX, bMinY, bMaxX, bMaxY, o.points) : segmentHitsPolygon(px, py, ex, ey, o.points);
        if (!hits) continue;
        let cx = 0, cy = 0; for (const p of o.points) { cx += p.x; cy += p.y; }
        cx /= o.points.length; cy /= o.points.length;
        const dist = Math.hypot(cx - px, cy - py);
        if (dist < bestDist) { bestDist = dist; best = { hitX: cx, hitY: cy, actorX: cx, actorY: cy, actorName: o.id, actorUid: -1, actorTags: [...o.tags], distance: dist }; }
      }
      const reach = Math.max(halfT, 10);
      for (const w of navGrid.waypoints) {
        if (!(w.tags.some((t) => filterTags.indexOf(t) >= 0) || (w.name && filterTags.indexOf(w.name) >= 0))) continue;
        const inReach = isBox ? (w.x >= bMinX && w.x <= bMaxX && w.y >= bMinY && w.y <= bMaxY) : ptSegDist(w.x, w.y, px, py, ex, ey) <= reach;
        if (!inReach) continue;
        const dist = Math.hypot(w.x - px, w.y - py);
        if (dist < bestDist) { bestDist = dist; best = { hitX: w.x, hitY: w.y, actorX: w.x, actorY: w.y, actorName: w.name || w.tags[0] || "wp", actorUid: -1, actorTags: [...w.tags], distance: dist }; }
      }
    }
    for (const h of this._placementHits(px, py, ex, ey, filterTags)) {
      if (h.distance < bestDist) { bestDist = h.distance; best = h; }
    }
    return best;
  }

  /** Sprite-object pass — a collidable Sprite Object placement reads like a BP
   *  Collider here: bounds-test its physics body against the trace, honor the
   *  tag filter against the placement's runtime tags (`peaky.tags`), and report
   *  the hit with `actorUid = -1` (non-sprite, like tiles / nav). Same include
   *  rule as the sprite pass: empty filter = any solid thing, else require a tag
   *  match. v1 iterates `peaky.placementsBySpriteId` directly — placement counts
   *  are small and `HasSpriteObjectTag` already scans this way. */
  private _placementHits(px: number, py: number, ex: number, ey: number, filterTags: string[]): TracerHit[] {
    const idx = this.sprite.scene.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
    if (!idx || idx.size === 0) return [];
    const isBox = this.shape === "box";
    const bounds = isBox ? boxTraceAABB(px, py, ex, ey, this._scaledThick() / 2) : null;
    const line = isBox ? null : new Phaser.Geom.Line(px, py, ex, ey);
    const out: TracerHit[] = [];
    for (const [spriteId, list] of idx) {
      for (const go of list) {
        const body = go.body as Phaser.Physics.Arcade.Body | null;
        if (!body || body.enable === false) continue;
        const tags = (go.getData("peaky.tags") as string[] | undefined) ?? [];
        if (filterTags.length > 0 && !tags.some((t) => filterTags.indexOf(t) >= 0)) continue;
        const bx = body.x, by = body.y, bw = body.width, bh = body.height;
        const br = bx + bw, bb = by + bh;
        let hx = 0, hy = 0, hd = Infinity;
        if (isBox && bounds) {
          if (bounds.minX >= br || bounds.maxX <= bx || bounds.minY >= bb || bounds.maxY <= by) continue;
          hx = px < bx ? bx : px > br ? br : px;
          hy = py < by ? by : py > bb ? bb : py;
          hd = Math.hypot(hx - px, hy - py);
        } else if (line) {
          const o: Phaser.Geom.Point[] = [];
          Phaser.Geom.Intersects.GetLineToRectangle(line, new Phaser.Geom.Rectangle(bx, by, bw, bh), o);
          if (o.length === 0) continue;
          for (const p of o) { const d = Math.hypot(p.x - px, p.y - py); if (d < hd) { hd = d; hx = p.x; hy = p.y; } }
        }
        out.push({ hitX: hx, hitY: hy, actorX: hx, actorY: hy, actorName: go.name || spriteId, actorUid: -1, actorTags: [...tags], distance: hd });
      }
    }
    return out;
  }

  /** Sample the trace geometry against every Phaser tilemap layer. Walks
   *  ~11 points along the line, asks each layer whether a collidable tile
   *  sits at that world point. In closest-only mode the callback only
   *  fires for tiles nearer than `initialBestDist`; in multi-hit mode the
   *  caller passes `closestOnly=false` and every solid sample reports. */
  private _tilemapHitInto(
    px: number, py: number, ex: number, ey: number,
    _initialBest: TracerHit | null, initialBestDist: number,
    onHit: (hit: TracerHit, dist: number) => void,
    closestOnly = true,
  ): void {
    const scene = this.sprite.scene;
    const layers = (scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
    if (layers.length === 0) return;
    let bestDist = initialBestDist;
    const SAMPLES = 10;
    // Dedup per-cell so a long trace through a single tile doesn't
    // emit the same hit 5×. Key is (layerIndex)|(tileX,tileY).
    const seen = new Set<string>();
    // Box trace is an AABB (see the class caveat). Check EVERY colliding tile
    // the box overlaps — the line-sampling below only catches the single tile
    // row the CENTRE line passes through, which is why a tall box "only hit at
    // the level where it spawned" until the player lined up with the tile.
    if (this.shape === "box") {
      const { minX: bMinX, maxX: bMaxX, minY: bMinY, maxY: bMaxY } = boxTraceAABB(px, py, ex, ey, this._scaledThick() / 2);
      const bW = bMaxX - bMinX;
      const bH = bMaxY - bMinY;
      for (let li = 0; li < layers.length; li++) {
        const tiles = layers[li].getTilesWithinWorldXY(bMinX, bMinY, bW, bH);
        for (const tile of tiles) {
          if (!tile || tile.index < 0 || !tile.collides) continue;
          const key = `${li}|${tile.x},${tile.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Closest point on the tile (in WORLD space) to the pivot. tile.pixelX/Y
          // are tilemap-LOCAL — the Phaser layer is positioned at the tilemap's
          // scene offset — so they MUST be converted, or the hit point lands off
          // by that offset (the "red dot on the floor while the box hits a tile
          // elsewhere" bug). getTilesWithinWorldXY above is already world-aware.
          const wp = layers[li].tileToWorldXY(tile.x, tile.y);
          const tl = wp.x, tt = wp.y;
          const tr = tl + tile.width, tb = tt + tile.height;
          const cx = px < tl ? tl : px > tr ? tr : px;
          const cy = py < tt ? tt : py > tb ? tb : py;
          const d = Math.hypot(cx - px, cy - py);
          if (closestOnly) { if (d >= bestDist) continue; bestDist = d; }
          onHit({
            hitX: cx, hitY: cy,
            actorX: tl + tile.width / 2, actorY: tt + tile.height / 2,
            actorName: "tile", actorUid: -1, actorTags: ["tile"], distance: d,
          }, d);
        }
      }
      return;
    }
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const sx = px + (ex - px) * t;
      const sy = py + (ey - py) * t;
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        const tile = layer.getTileAtWorldXY(sx, sy, true);
        if (!tile || tile.index < 0 || !tile.collides) continue;
        const key = `${li}|${tile.x},${tile.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const d = Math.hypot(sx - px, sy - py);
        if (closestOnly) {
          if (d >= bestDist) continue;
          bestDist = d;
        }
        // actorX/Y must be WORLD — tile.pixelX/Y are tilemap-local (layer is
        // offset at the tilemap's scene position), so convert via the layer.
        const wp = layer.tileToWorldXY(tile.x, tile.y);
        onHit({
          hitX: sx,
          hitY: sy,
          actorX: wp.x + tile.width / 2,
          actorY: wp.y + tile.height / 2,
          actorName: "tile",
          actorUid: -1,
          actorTags: ["tile"],
          distance: d,
        }, d);
      }
    }
  }

  /** The trace's current world LINE segment (pivot → end). Lets tile mining
   *  test the tracer's REAL position against a tile's custom polygon (sub-cell),
   *  instead of "any cell the shape touches". Null for box tracers (they fall
   *  back to cell overlap). Same live geometry as collectOverlappedTileCenters. */
  mineSegment(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.shape === "box") return null;
    const { px, py, ex, ey } = this._calcGeom();
    return { x0: px, y0: py, x1: ex, y1: ey };
  }

  /** The trace's current world BOX rect (for box tracers), so tile mining can
   *  test the box against a tile's custom polygon area instead of its cells.
   *  Null for line tracers (those use `mineSegment`). */
  mineBox(): { x: number; y: number; w: number; h: number } | null {
    if (this.shape !== "box") return null;
    const { px, py, ex, ey, thick } = this._calcGeom();
    const halfThick = thick / 2;
    return {
      x: Math.min(px, ex) - halfThick,
      y: Math.min(py, ey) - halfThick,
      w: Math.abs(ex - px) + thick,
      h: Math.abs(ey - py) + thick,
    };
  }

  /** World centers of EVERY non-empty tile this tracer's geometry overlaps
   *  right now (box → full AABB; line → sampled). Used by MineTileAtWorld's
   *  "mine all tracer hits" mode so one swing clears the whole hitbox. Unlike
   *  the hit-detection pass this includes non-colliding tiles too — the mine
   *  action itself skips cells with no hardness, so it should see every tile. */
  collectOverlappedTileCenters(): Array<{ x: number; y: number }> {
    const scene = this.sprite.scene;
    const layers = (scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
    const out: Array<{ x: number; y: number }> = [];
    if (layers.length === 0) return out;
    // Use the SAME live geometry the tracer is drawn with, so the mined cells
    // match the visible tracer exactly. The image-point lookup caches its
    // last-seen position (SpriteRenderer.getImagePointWorld), so even when a
    // signal-driven Mine runs a frame after the attack frame has passed, the
    // origin stays on the trace instead of snapping to sprite center.
    const { px, py, ex, ey, thick } = this._calcGeom();
    const seen = new Set<string>();
    const push = (li: number, tile: Phaser.Tilemaps.Tile | null): void => {
      if (!tile || tile.index < 0) return;
      const key = `${li}|${tile.x},${tile.y}`;
      if (seen.has(key)) return;
      seen.add(key);
      const wp = layers[li].tileToWorldXY(tile.x, tile.y);
      out.push({ x: wp.x + tile.width / 2, y: wp.y + tile.height / 2 });
    };
    if (this.shape === "box") {
      const halfThick = thick / 2;
      const minX = Math.min(px, ex) - halfThick;
      const minY = Math.min(py, ey) - halfThick;
      const w = Math.abs(ex - px) + thick;
      const h = Math.abs(ey - py) + thick;
      for (let li = 0; li < layers.length; li++) {
        for (const tile of layers[li].getTilesWithinWorldXY(minX, minY, w, h)) push(li, tile);
      }
    } else {
      const SAMPLES = 12;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const sx = px + (ex - px) * t;
        const sy = py + (ey - py) * t;
        for (let li = 0; li < layers.length; li++) push(li, layers[li].getTileAtWorldXY(sx, sy, true));
      }
    }
    return out;
  }

  /** Parse the comma-separated tagFilter once per sample. Returns an empty
   *  array when no filter is set. */
  private _filterTags(): string[] {
    if (!this.tagFilter) return [];
    const out: string[] = [];
    for (const raw of this.tagFilter.split(",")) {
      const t = raw.trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** Pick the cheapest candidate source for the trace's bounding circle.
   *  Tracers care about body-vs-geometry intersection, but `getNeighborsByTag`'s
   *  rare-tag fast path filters by sprite CENTER distance — a body whose center
   *  sits just outside the trace's bounding circle but whose corner extends
   *  into the trace gets dropped before the precise AABB check ever runs.
   *  So:
   *    - 1 tag, few carriers (typical player-sight case) → iterate the tag
   *      Set directly. The per-sprite AABB check inside the caller does the
   *      precise filter; the grid would only over-reject here.
   *    - 1 tag, many carriers → use grid + tag intersect, with a half-cell
   *      safety margin on radius so body-straddles-cell-boundary still hits.
   *    - 0 / 2+ tags → grid with safety margin; caller filters tags inline. */
  private _candidates(filterTags: string[], midX: number, midY: number, radius: number): Sprite[] {
    const scene = this.sprite.scene;
    const safeRadius = radius + 128;
    if (filterTags.length === 1) {
      const byTag = scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
      const tagged = byTag?.get(filterTags[0]);
      if (!tagged || tagged.size === 0) return [];
      if (tagged.size <= 64) return Array.from(tagged);
      const cells = getNeighbors(scene, midX, midY, safeRadius);
      const out: Sprite[] = [];
      for (const s of cells) if (tagged.has(s)) out.push(s);
      return out;
    }
    return getNeighbors(scene, midX, midY, safeRadius);
  }

  private _sIntersectsTags(s: Sprite, tags: string[]): boolean {
    for (const t of tags) if (s.tags.has(t)) return true;
    return false;
  }

  private _drawDebug(): void {
    if (!this._gfx) return;
    this._gfx.clear();
    if (!this.debugDraw) return;

    const now = this.sprite.simNowMs / 1000;
    const isActive = now < this._activeUntilSec;

    // Idle outline — where the tracer WOULD shoot right now if it fired.
    // Hidden when pivotSource = "imagePoint" but the current frame
    // doesn't carry the named point: the tracer would silently fall
    // back to sprite center, which is misleading "bottom of sprite"
    // graffiti. Only show the idle preview on frames that CAN actually
    // fire from the configured anchor.
    let idleHidden = false;
    if (this.pivotSource === "imagePoint" && this.imagePointName) {
      const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as unknown as { getImagePointWorld?: (n: string) => { x: number; y: number } | null } | null;
      if (!sr || !sr.getImagePointWorld || !sr.getImagePointWorld(this.imagePointName)) {
        idleHidden = true;
      }
    }
    const live = this._calcGeom();
    if (!idleHidden) {
      // Bumped from the original 1px/0.22 alpha so authors can actually
      // see which frames have the configured image point — the faint
      // version was easy to miss against scene backgrounds.
      this._strokeShape(live.px, live.py, live.ex, live.ey, live.thick, 0x40c0ff, 0.55, 2);
    }

    // Active overlay — bright stroke of the LAST sampled geometry. Color
    // and width are tuned so the active window is visually unmistakable:
    // red when hitting, yellow when active-but-clear. This is what makes
    // "see the longevity" work — the bright window starts on each sample
    // and lasts as long as `_activeUntilSec` says.
    if (isActive && this._lastTraceGeom) {
      const g = this._lastTraceGeom;
      const hotColor = this.lastHit ? 0xff3030 : 0xffd040;
      this._strokeShape(g.px, g.py, g.ex, g.ey, g.thick, hotColor, 0.95, 3);
      // Pivot dot — bright + bigger when active.
      this._gfx.fillStyle(0xffff00, 1);
      this._gfx.fillCircle(g.px, g.py, 4);
      // Persistent hit point dot while the sample is still "alive".
      if (this.lastHit) {
        this._gfx.fillStyle(0xff3030, 1);
        this._gfx.fillCircle(this.lastHit.hitX, this.lastHit.hitY, 4);
      }
    } else if (!idleHidden) {
      // Idle pivot dot — small + faint so it doesn't compete with the
      // active visual when the tracer fires. Hidden when the named
      // image point isn't on the current frame (see idleHidden above).
      this._gfx.fillStyle(0xffff00, 0.55);
      this._gfx.fillCircle(live.px, live.py, 2);
    }

    // Hit pulse — expanding ring fading over 0.25s at each NEW hit.
    if (this._hitPulsePoint && now < this._hitPulseUntilSec) {
      const remaining = this._hitPulseUntilSec - now;
      const t = 1 - remaining / 0.25;
      const radius = 4 + t * 18;
      const alpha = 0.85 * (1 - t);
      this._gfx.lineStyle(2, 0xff3030, alpha);
      this._gfx.strokeCircle(this._hitPulsePoint.x, this._hitPulsePoint.y, radius);
    }
  }

  /** Stroke the configured shape (line / box) at the given geometry, color,
   *  alpha, and width. Shared between the idle outline + active overlay so
   *  changes to shape rendering only need to land in one place. */
  private _strokeShape(
    px: number, py: number, ex: number, ey: number, thick: number,
    color: number, alpha: number, width: number,
  ): void {
    if (!this._gfx) return;
    this._gfx.lineStyle(width, color, alpha);
    if (this.shape === "box") {
      const { minX, maxX, minY, maxY } = boxTraceAABB(px, py, ex, ey, thick / 2);
      this._gfx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    } else {
      this._gfx.beginPath();
      this._gfx.moveTo(px, py);
      this._gfx.lineTo(ex, ey);
      this._gfx.strokePath();
    }
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, _alpha: number, visible: boolean): void {
    if (!this._gfx) return;
    this._gfx.setScrollFactor(scrollX, scrollY);
    this._gfx.setDepth(baseDepth + 5);
    this._gfx.setVisible(visible);
  }

}

/** Look up a Tracer on a sprite by name. Empty `name` matches the FIRST
 *  attached tracer (useful when there's only one). Returns undefined when
 *  no matching tracer exists. */
export function findTracer(sprite: Sprite, name: string): Tracer | undefined {
  const all = sprite.findBehaviorsByKind("Tracer");
  if (all.length === 0) return undefined;
  if (!name) return all[0];
  return all.find((t) => t.name === name);
}
