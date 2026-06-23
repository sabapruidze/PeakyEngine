import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import { getInputActions } from "../input/InputActions";

/**
 * Smart all-in-one platformer character controller.
 *
 * Consolidates Platformer + the atomic CoyoteJump / JumpBuffer / DoubleJump /
 * VariableJumpHeight stubs into one component with toggleable sub-features.
 * The editor renders this with a custom sectioned UI (see ComponentDetails
 * branch on `b.kind === "CharacterMovement"`).
 *
 * Each ability binds to a project InputAction *by name* — rebinding keys in
 * the toolbar's Input Actions modal never breaks anything.
 *
 * Emits sprite events: `OnJump`, `OnDashStart`, `OnDashEnd`.
 * `OnLand` and `OnFall` are emitted by `Sprite.tick` itself (velocity-based,
 * works for both walk-off-ledge and jump-apex transitions).
 */
export class CharacterMovement extends Behavior {
  kind = "CharacterMovement";

  // ── Physics ───────────────────────────────────────────────────────────────
  maxSpeed = 220;
  acceleration = 1500;
  deceleration = 1500;
  airControl = 1.0;
  gravity = 800;
  /**
   * Gravity direction in degrees. 0=right, 90=down (default), 180=left, 270=up.
   * Lets you flip gravity for upside-down sections, sideways scrolling, etc.
   */
  gravityAngle = 90;
  maxFallSpeed = 600;
  /**
   * Ceiling collision mode. 0 = stop (default — vertical momentum zeroed when
   * hitting a ceiling). 1 = preserve momentum (lets the player hug ceilings
   * during a strong jump until gravity catches up).
   */
  ceilingMode = 0;

  // ── Move bindings ─────────────────────────────────────────────────────────
  leftAction = "MoveLeft";
  rightAction = "MoveRight";
  /**
   * Programmatically-pushed input action names. AI controllers (AIBrain)
   * add e.g. `"MoveLeft"` here to drive the body as if the player were
   * holding that key — the regular input-action read OR-merges with this
   * set, so coyote / buffer / walljump logic behaves identically. Clear
   * by the controller each tick before re-adding. Empty = no AI input.
   */
  simulatedInputs: Set<string> = new Set();
  /**
   * Optional event names to *listen for* — when this event fires this frame,
   * the ability triggers (in addition to the InputAction binding). Lets users
   * route any event chain to drive movement (e.g. an
   * `OnKeyPressed X → EmitEvent "dash event"` event makes X trigger dash if
   * dashEventTrigger = "dash event"). Empty = no event trigger.
   */
  leftEventTrigger = "";
  rightEventTrigger = "";
  /**
   * Optional event names to *emit* whenever the ability fires (outgoing hook).
   * SMs / future custom-function system can react via OnEvent conditions.
   * Empty = nothing emitted.
   */
  leftCustomFn = "";
  rightCustomFn = "";

  // ── Jump ──────────────────────────────────────────────────────────────────
  jumpAction = "Jump";
  jumpEventTrigger = "";
  jumpCustomFn = "";
  jumpStrength = 460;
  /**
   * Time-to-apex shortcut. When > 0, the jump's actual upward kick is
   * computed as `gravity * jumpTimeToApex` so the character reaches its
   * peak after exactly that many seconds — regardless of `jumpStrength`.
   * 0.2 = snappy (Mario), 0.4 = floaty, 0.6+ = slow lobs.
   * 0 (default) keeps the legacy behavior: `jumpStrength` is used as-is.
   */
  jumpTimeToApex = 0;
  /** 1 = single jump only. 2 = double, 3 = triple… */
  multiJump = 1;
  /**
   * Multiplies gravity while DESCENDING (velocity.y > 0). > 1 makes the
   * fall faster than the rise — the universal "snappy platformer" feel
   * (Mario, Celeste, Hollow Knight all use ~1.5–2.5). 1 (default) keeps
   * symmetric gravity (fall mirrors jump arc).
   */
  fallGravityMultiplier = 1;

  // Coyote time — keep accepting jumps for N seconds after walking off a ledge.
  coyoteEnabled = 1;
  coyoteTime = 0.1;

  // Input buffer — if jump pressed up to N seconds before landing, fire on land.
  bufferEnabled = 1;
  bufferTime = 0.1;

  // Variable jump height — releasing jump while ascending caps upward velocity.
  varHeightEnabled = 0;
  /** When jump is released and velocity.y < this, clamp to this. Less negative = shorter hop. */
  varHeightCutoff = -150;

  // Jump sustain — holding the jump button extends upward acceleration for a
  // window after the initial impulse. Independent of variable height (which
  // CUTS the jump on release; sustain EXTENDS it while held).
  jumpSustainEnabled = 0;
  /** Maximum sustain duration in seconds. While jump is held within this
      window, vy is kept at -jumpStrength so the player keeps rising. */
  jumpSustainTime = 0.18;
  private jumpSustainEndsAt = 0;

  // ── Dash ──────────────────────────────────────────────────────────────────
  dashEnabled = 0;
  dashAction = "Dash";
  dashEventTrigger = "";
  dashCustomFn = "";
  dashSpeed = 600;
  dashDuration = 0.15;
  dashCooldown = 1.0;
  /** Windup before the dash actually moves. `OnDashStart` fires the frame
   *  the key is pressed (so animations can begin), but the velocity boost
   *  is held back by `dashStartDelay` seconds — useful for anticipation
   *  poses / pre-dash flash effects. During windup the body's X/Y velocity
   *  is zeroed (suspended). 0 = legacy behavior (instant dash). */
  dashStartDelay = 0;
  /** When 1 (default), the dash STOPS at tilemap walls instead of tunnelling
   *  through them. A fast dash can move farther in one frame than a tile is
   *  thick, so arcade tile-collision is skipped (Solid sprites still block it
   *  — they're caught by body-vs-body collision). This sweeps ahead each dash
   *  frame for a collidable tile and clamps the dash to it. 0 = let the dash
   *  phase through tiles (a deliberate phase-dash). */
  dashWallBlock = 1;
  /** True while a phase-dash (dashWallBlock=0) has the body's collision
   *  disabled, so we restore it exactly once when the dash ends. */
  private _dashPhasing = false;

  // ── Runtime control flags ─────────────────────────────────────────────────
  /** When true, all input action / event triggers are ignored. Gravity and
      momentum continue. Toggled via the CMIgnoreInput action. */
  ignoreInput = 0;

  /**
   * Auto-mirror mode — flips the sprite's `scaleX` so it visually faces the
   * movement direction. 0 = off (no auto-flip), 1 = follow velocity sign
   * (most common), 2 = follow last left/right input. Editable at runtime
   * via CMSet `mirrorMode`.
   */
  mirrorMode = 0;
  /**
   * When 1, mirror flips animate smoothly: scaleX lerps from current to
   * the target sign (`+1` or `-1`) over `scaleMirrorTime` seconds — a
   * brief "turn around" squash. When 0, flips snap (legacy instant).
   */
  scaleMirror = 0;
  /** Duration in seconds for smooth-mirror scale transition (only used
   *  when `scaleMirror` is on). 0 → instant snap. Typical: 0.15. */
  scaleMirrorTime = 0.15;
  /** Cached "natural" |scaleX| — used by the smooth-mirror lerp so the
   *  target sign always points at the user's intended absolute scale,
   *  not the in-progress mid-tween value. Updated only when the sprite
   *  is at rest on its facing side. */
  private _naturalAbsScale = 0;

  // ── Wall slide / wall jump ────────────────────────────────────────────────
  wallEnabled = 0;
  /** Downward speed cap while wall sliding. Acts as a hard ceiling on
   *  vy during raw wall slide — gravity still accelerates the body
   *  normally, then vy clamps here each tick. Lower than `maxFallSpeed`
   *  to make wall slide visibly slower than free fall. */
  wallSlideSpeed = 100;
  /** When 0, the wall-jump branch in update() is gated off — pressing
   *  jump while wall-sliding does NOTHING (no vy kick, no kickX, no
   *  walljump anim trigger). Default 1 (allowed). Authors flip this
   *  via a CharacterAnimator "Set behavior param" event action to gate
   *  wall jump on game logic — e.g. set to 1 in wallslide's "On main
   *  starts" event and back to 0 in walljump's "On state enter" event,
   *  so a fast-tap on the wall (before the slide has played out its
   *  In anim) won't actually wall-jump. */
  wallJumpAllowed = 1;
  /** Vertical kick on wall jump. */
  wallJumpStrength = 460;
  /** Horizontal kick away from the wall on wall jump. */
  wallJumpKickX = 320;
  /**
   * If 1, the sprite must be holding the direction *toward* the wall to slide.
   * If 0, sliding triggers as soon as you're airborne and touching a wall.
   */
  wallSlideRequiresInput = 1;
  /**
   * If 1, wall-slide engages the moment the body contacts a wall — even
   * mid-jump while still rising. Upward momentum is killed on contact so
   * the character "catches" the wall instantly. If 0 (default), wall-slide
   * only engages while falling (preserves your jump arc until the apex).
   */
  wallSlideOnContact = 0;
  /** Optional event names emitted on wall slide start / wall jump fire. */
  wallSlideCustomFn = "";
  wallJumpCustomFn = "";

  // ── Internal state ────────────────────────────────────────────────────────
  // Public so condition guards (CanJump) and action triggers (CMJump) can read.
  jumpsUsed = 0;
  /** Currently wall-sliding (set per-frame in update). Public for IsWallSliding. */
  wallSliding = false;
  /** Sim-time (in seconds, matching `this.now`) when the wall-jump
   *  branch last fired. Animator reads this to fire its `justWallJumped`
   *  edge condition for a short window so a dedicated walljump state
   *  can latch a one-shot anim. -Infinity = never. */
  wallJumpedAtSec = -Infinity;
  /** When > behavior's internal `now`, wall-slide is force-suppressed even
   *  if all entry conditions match. Set by `cancelWallSlide()` /
   *  `CMStopWallSlide` action. Lets the player re-engage only after they
   *  leave the wall and the timer elapses. */
  private _wallSlideSuppressedUntilSec = 0;
  /** Sim-time of the most recent tick where the RAW wall-slide formula
   *  (touching wall + falling + input/contact mode) matched. The exposed
   *  `wallSliding` flag stays true for a short coyote window after this
   *  drops out so a 1-tick gap (Phaser separation step, vy briefly at 0
   *  from the slide-cap clamp) doesn't flicker the animator into the
   *  fall state and back. */
  private _wallSlidingLastTrueAtSec = -Infinity;
  private lastAppliedGravity = NaN;
  private timeSinceGroundedSec = Infinity;
  private bufferedJumpAtSec = -Infinity;
  /** Current sim time in seconds (accumulated from update deltas). */
  private now = 0;
  /** DIAGNOSTIC: previous-frame "airborne + side-blocked" state, for edge-only
   *  logging of the jump-into-ledge push-back. */
  private _dbgSideBlock = false;
  /** Last known facing direction: -1 = left, +1 = right. Used for dash if no input. */
  private facing: 1 | -1 = 1;
  /** SOCD — which of left/right was pressed most recently, so holding both
   *  moves toward the LAST press instead of dead-stopping. */
  private _lastH: "left" | "right" | null = null;

  // Dash state — `dashing` is public so `IsDashing` guard can read it.
  dashing = false;
  private dashEndsAtSec = 0;
  /** Sim time at which the windup ends + the velocity boost begins. Equal
   *  to the press time when `dashStartDelay` is 0 (legacy instant dash). */
  private dashWindupEndsAtSec = 0;
  // Public so CanDash guard can compare against `now`.
  dashReadyAtSec = 0;
  private dashDir: 1 | -1 = 1;

  /**
   * Cancel an in-progress wall-slide from outside (e.g. SM action
   * `CMStopWallSlide`). Forces `IsWallSliding` to false and suppresses
   * re-engagement for `suppressSec` seconds. Player can re-slide once
   * they've left the wall AND the suppression timer has elapsed. Use for
   * hit-stun, cutscenes, special-move cancels.
   */
  cancelWallSlide(suppressSec = 0.2): void {
    this.wallSliding = false;
    this._wallSlideSuppressedUntilSec = this.now + Math.max(0, suppressSec);
  }

  /**
   * Cancel an in-progress dash from outside (e.g. SM action `CMStopDash`).
   * Uses the behavior's own clock (`this.now`) for `dashReadyAtSec` so the
   * cooldown is comparable to future dash-press checks. Callers using
   * `sprite.scene.time.now` directly would set a huge number that the
   * internal clock never reaches → dash permanently un-re-eligible.
   * No-op when no dash is in flight.
   */
  cancelDash(): void {
    if (!this.dashing) return;
    this.dashing = false;
    this.dashReadyAtSec = this.now + this.dashCooldown;
    if (this.sprite.body) {
      this.sprite.body.setVelocityX(0);
      this.sprite.body.setVelocityY(0);
    }
    this.sprite.events.emit("OnDashEnd");
  }

  /** Tracks the previously-applied gravity ANGLE so we know when to recompute. */
  private lastAppliedGravityAngle = NaN;
  /** Previous frame's vy — used by ceilingMode=preserve to restore upward
      momentum when a ceiling strip Phaser's default zero-out. */
  private prevVy = 0;

  init(): void {
    this.applyGravity();
    // Cache the user's natural |scaleX| ONCE so the smooth-mirror lerp
    // always knows the correct target magnitude. Re-reading from
    // obj.scaleX each frame would let mid-tween values poison the cache.
    this._naturalAbsScale = Math.abs(this.sprite.gameObject.scaleX) || 1;
  }

  serialize(): Record<string, unknown> {
    // Save discrete state only — timers (`dashEndsAtSec`, `jumpSustainEndsAt`,
    // `_jumpAscentEndsAt`, etc.) are intentionally dropped so a Load
    // produces a clean re-spawn. In-flight dashes / wall-slides end on
    // load; the user picks up running on the ground without the gameplay
    // looking glitchy. `Sprite.clearRuntimeState()` already zeroes the
    // queues and tweens to match.
    return {
      jumpsUsed: this.jumpsUsed,
      ignoreInput: this.ignoreInput,
      facing: this.facing,
    };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.jumpsUsed === "number") this.jumpsUsed = state.jumpsUsed;
    if (typeof state.ignoreInput === "number") this.ignoreInput = state.ignoreInput;
    if (state.facing === -1 || state.facing === 1) this.facing = state.facing;
    // Reset every in-flight phase explicitly so a save mid-dash / mid-jump
    // can't leak back into runtime once the user continues.
    this.dashing = false;
    this.dashEndsAtSec = 0;
    this.dashWindupEndsAtSec = 0;
    this.dashReadyAtSec = 0;
    this.jumpSustainEndsAt = 0;
    this.bufferedJumpAtSec = -Infinity;
    this.timeSinceGroundedSec = Infinity;
    this._jumpAscentEndsAt = 0;
    this._wallSlideSuppressedUntilSec = 0;
    this.wallSliding = false;
  }

  /** Sim time at which the in-flight jump's ascent phase ends (apex). Used
   *  to know whether to apply the ascent-tuned gravity (so height stays
   *  at the user-set value) or the base / fall gravity. Set on each jump
   *  fire when `jumpTimeToApex > 0`; otherwise irrelevant (legacy mode). */
  private _jumpAscentEndsAt = 0;

  /** Effective upward kick for a jump.
   *  - Legacy (`jumpTimeToApex == 0` OR `gravity <= 0`): `jumpStrength`
   *    is initial velocity. Falls back to legacy when gravity is 0 to
   *    avoid the time-to-apex formula's division-by-zero, which would
   *    return Infinity and tunnel the body to NaN coords.
   *  - Time-to-apex mode: produces the SAME height as legacy mode would,
   *    but reaches it in T seconds. From H = v²/(2g) and T = v/g:
   *      v_apex = jumpStrength² / (gravity × T)
   *      g_apex = jumpStrength² / (gravity × T²)
   *    `jumpStrength` keeps its meaning across modes — only the speed of
   *    ascent changes when T varies. */
  private effectiveJumpStrength(): number {
    if (this.jumpTimeToApex > 0 && this.gravity > 0) {
      const T = this.jumpTimeToApex;
      const v = (this.jumpStrength * this.jumpStrength) / (this.gravity * T);
      // Pathological inputs (jumpStrength near MAX_VALUE) overflow to
      // Infinity here. Falling back to the literal jumpStrength keeps the
      // body integration sane — Phaser tweens / collision math hate NaN.
      if (Number.isFinite(v)) return v;
    }
    return this.jumpStrength;
  }

  /** Gravity to apply THIS frame.
   *  - Ascent of an apex-tuned jump → custom gravity that keeps the
   *    legacy-equivalent height while reaching apex in T seconds.
   *  - Falling, at or past `maxFallSpeed` → 0 (terminal velocity reached).
   *  - Stationary or rising with `maxFallSpeed === 0` → 0 (no fall allowed
   *    at all; without this, the at-rest case kept re-priming gravity each
   *    time the velocity clamp zeroed `vy`, producing a slow oscillating
   *    drift downward).
   *  - Falling, below cap → `gravity × fallGravityMultiplier`.
   *  - Otherwise (rising / on ground) → base `gravity`. */
  private computeFrameGravity(): number {
    if (this.jumpTimeToApex > 0 && this.gravity > 0 && this.now < this._jumpAscentEndsAt) {
      const T = this.jumpTimeToApex;
      const g = (this.jumpStrength * this.jumpStrength) / (this.gravity * T * T);
      // Same Infinity-guard as effectiveJumpStrength — degrade to base
      // gravity rather than NaN-tunneling the body into the void.
      if (Number.isFinite(g)) return g;
    }
    if (this.maxFallSpeed <= 0) return 0;
    // No-body BPs (noPhysicsBody=true) have undefined `body`; bail to
    // base gravity since there's no velocity to read. (audit HIGH #34)
    const vy = this.sprite.body?.velocity.y ?? 0;
    if (vy > 0) {
      if (vy >= this.maxFallSpeed) return 0;
      return this.gravity * this.fallGravityMultiplier;
    }
    return this.gravity;
  }

  private applyGravity(): void {
    const g = this.computeFrameGravity();
    if (g === this.lastAppliedGravity && this.gravityAngle === this.lastAppliedGravityAngle) return;
    // 2D gravity vector from magnitude + angle (degrees, 0=right, 90=down).
    const rad = (this.gravityAngle * Math.PI) / 180;
    const gx = Math.cos(rad) * g;
    const gy = Math.sin(rad) * g;
    const world = this.sprite.scene.physics.world.gravity;
    this.sprite.body.setGravityX(gx - world.x);
    this.sprite.body.setGravityY(gy - world.y);
    this.lastAppliedGravity = g;
    this.lastAppliedGravityAngle = this.gravityAngle;
  }

  /** Distance from the body's leading edge (in dash direction `dir`) to the
   *  nearest collidable tilemap tile within `reach` px, or null if the path is
   *  clear. Samples the body's top / middle / bottom so a wall covering only
   *  part of the body's height still counts. Used by the dash anti-tunnel sweep. */
  private _dashTileWallDist(body: Phaser.Physics.Arcade.Body, dir: number, reach: number): number | null {
    const layers = this.sprite.scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined;
    if (!layers || layers.length === 0) return null;
    const edgeX = dir > 0 ? body.right : body.x;
    const ys = [body.y + 1, body.center.y, body.bottom - 1];
    const STEP = 4;
    for (let d = 0; d <= reach; d += STEP) {
      const sx = edgeX + dir * d;
      for (const sy of ys) {
        for (const layer of layers) {
          const tile = layer.getTileAtWorldXY(sx, sy, true);
          if (tile && tile.index >= 0 && tile.collides) return Math.max(0, d - 1);
        }
      }
    }
    return null;
  }

  update(delta: number): void {
    // Apply the per-frame gravity (handles ascent + asymmetric fall).
    this.applyGravity();
    const dt = delta / 1000;
    this.now += dt;

    const body = this.sprite.body;
    // DIAGNOSTIC (jump-into-ledge push-back): log the frame the body first
    // gets blocked sideways while airborne — the "pushed back at the cliff"
    // moment. delta exposes a first-frame spike (deep tile penetration →
    // arcade separates sideways instead of landing on top).
    if (body) {
      const sideBlock = body.blocked.left || body.blocked.right;
      const airborne = !(body.blocked.down || body.touching.down);
      if (sideBlock && airborne && !this._dbgSideBlock) {
        Logger.log({ level: "warn", source: "CM-jump", message: `airborne side-block at (${body.x.toFixed(1)},${body.y.toFixed(1)}) vx=${body.velocity.x.toFixed(0)} vy=${body.velocity.y.toFixed(0)} delta=${delta.toFixed(1)}ms frame=${this.sprite.scene.game.loop.frame} L=${body.blocked.left} R=${body.blocked.right}` });
      }
      this._dbgSideBlock = sideBlock && airborne;
    }
    // Hitstun gate — while Damageable's hitstun window is active, freeze
    // the character's input / movement logic so the knockback velocity
    // set by `Damageable.applyDamage` actually plays out instead of
    // being overwritten by the per-tick targetVx calculation. Gravity
    // still applies (above) so the body falls / arcs naturally.
    const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
    if (dmg?.isInHitstun?.()) {
      return;
    }
    const ia = getInputActions(this.sprite.scene);
    const onGround = body.blocked.down || body.touching.down;

    // Trigger sources per ability — `*Action` = InputAction binding, `*EventTrigger`
    // = event name to listen for. Both can be set; ability fires if EITHER matches.
    // Empty = no trigger from that source.
    // Gate input checks on the animator's `blockedActions` set so an
    // input-gate "Block jump while comboing" (etc.) actually prevents
    // CM from seeing the press. Falsy when no animator attached.
    const blocked = (this.sprite.findBehaviorByKind("StateMachine") as { blockedActions?: Set<string> } | undefined)?.blockedActions;
    const isBlocked = (name: string): boolean => !!blocked && blocked.has(name);
    // AI-pushed simulated inputs OR-merge with native action reads.
    // The action name lookup uses the same string the user configured for
    // `leftAction` / `rightAction` / etc., so an AIBrain adding
    // "MoveLeft" or any custom action name fires the matching ability.
    const sim = this.simulatedInputs;
    const leftFromInput = ia && this.leftAction && !isBlocked(this.leftAction) ? ia.isDown(this.leftAction) : false;
    const rightFromInput = ia && this.rightAction && !isBlocked(this.rightAction) ? ia.isDown(this.rightAction) : false;
    const leftHeld = leftFromInput || sim.has("MoveLeft") || (this.leftAction ? sim.has(this.leftAction) : false);
    const rightHeld = rightFromInput || sim.has("MoveRight") || (this.rightAction ? sim.has(this.rightAction) : false);
    const jumpFromInput = ia && this.jumpAction && !isBlocked(this.jumpAction) ? ia.justPressed(this.jumpAction) : false;
    const jumpReleased = ia && this.jumpAction && !isBlocked(this.jumpAction) ? ia.justReleased(this.jumpAction) : false;
    const dashFromInput = ia && this.dashAction && !isBlocked(this.dashAction) ? ia.justPressed(this.dashAction) : false;

    // MUST be `firedThisFrame` (which checks fired + firedPrev) — NOT
    // `firedExactlyThisFrame`. Tick order is: behaviors update FIRST,
    // then processEvents emits signals, then flush. So a self-emit
    // pattern like `OnKeyPressed[J] → EmitSignal "JumpSignal"` paired
    // with CM `jumpEventTrigger = "JumpSignal"` lands the signal in
    // `fired` AFTER CM already checked. CM only sees it next frame
    // from `firedPrev` — which the carryover-aware variant covers.
    // The "2-frame fire" the audit flagged was a misread; the carryover
    // is essential, not a bug.
    const leftFromEvent = this.leftEventTrigger ? this.sprite.events.firedThisFrame(this.leftEventTrigger) : false;
    const rightFromEvent = this.rightEventTrigger ? this.sprite.events.firedThisFrame(this.rightEventTrigger) : false;
    const jumpFromEvent = this.jumpEventTrigger ? this.sprite.events.firedThisFrame(this.jumpEventTrigger) : false;
    const dashFromEvent = this.dashEventTrigger ? this.sprite.events.firedThisFrame(this.dashEventTrigger) : false;

    // Honor runtime input suppression flag — physics/momentum still tick,
    // only input-driven triggers go silent. Event triggers ALSO go silent
    // since the user typically wants a full lockout (e.g. cutscene).
    const inputOff = this.ignoreInput !== 0;
    const left = !inputOff && (leftHeld || leftFromEvent);
    const right = !inputOff && (rightHeld || rightFromEvent);
    const jumpPressed = !inputOff && (jumpFromInput || jumpFromEvent);
    const dashPressed = !inputOff && (dashFromInput || dashFromEvent);

    // SOCD: when both directions are held, the LAST-pressed wins (instead of
    // cancelling to a dead stop). `effLeft`/`effRight` are the resolved,
    // mutually-exclusive movement directions used everywhere below.
    if (ia) {
      if (this.leftAction && ia.justPressed(this.leftAction)) this._lastH = "left";
      if (this.rightAction && ia.justPressed(this.rightAction)) this._lastH = "right";
    }
    const effLeft = left && (!right || this._lastH === "left");
    const effRight = right && (!left || this._lastH === "right");

    // Custom-function hooks (outgoing): when the ability fires, emit the
    // configured event name so SMs / future custom functions can react.
    if (left && this.leftCustomFn) this.sprite.events.emit(this.leftCustomFn);
    if (right && this.rightCustomFn) this.sprite.events.emit(this.rightCustomFn);

    // Track facing for dash-without-input
    if (effLeft) this.facing = -1;
    else if (effRight) this.facing = 1;

    // Defensive: if a phase-dash was cancelled externally (SetBehaviorParam,
    // death, etc.) without the end-block restoring collision, restore it now so
    // the body can never get stuck in no-clip.
    if (this._dashPhasing && !this.dashing && body.checkCollision) {
      body.checkCollision.none = false;
      this._dashPhasing = false;
    }
    // ── Dash ──────────────────────────────────────────────────────────────
    if (this.dashEnabled && this.dashing) {
      // Two phases:
      //   • windup  (now < dashWindupEndsAtSec) — body suspended, animations
      //     play. OnDashStart already fired on the press frame so anim
      //     events can react. Skipping the velocity write keeps the player
      //     in place and ignores gravity through the anticipation pose.
      //   • active  (now >= dashWindupEndsAtSec) — full dash velocity.
      if (this.now < this.dashWindupEndsAtSec) {
        body.setVelocityX(0);
        body.setVelocityY(0);
      } else {
        // Anti-tunnel: a fast dash can move farther in one frame than a tile is
        // thick, so arcade tile-collision is skipped and the dash phases through
        // tilemap walls (Solid sprites still stop it via body collision). When
        // dashWallBlock is on, sweep ahead by this frame's travel for a
        // collidable tile and, if one's in the way, move only up to it and end
        // the dash so it can't pass through.
        if (this.dashWallBlock) {
          const dt = Math.max(0.0001, delta / 1000);
          const dist = this._dashTileWallDist(body, this.dashDir, this.dashSpeed * dt + 1);
          if (dist !== null) {
            body.setVelocityX((dist / dt) * this.dashDir);
            body.setVelocityY(0);
            this.dashing = false;
            this.dashReadyAtSec = this.now + this.dashCooldown;
            this.sprite.events.emit("OnDashEnd");
            return;
          }
        }
        body.setVelocityX(this.dashSpeed * this.dashDir);
        body.setVelocityY(0);
      }
      if (this.now >= this.dashEndsAtSec) {
        this.dashing = false;
        this.dashReadyAtSec = this.now + this.dashCooldown;
        if (this._dashPhasing && body.checkCollision) { body.checkCollision.none = false; this._dashPhasing = false; }
        // Zero velocity at dash end so `IsRunning` (grounded + moving +
        // !dashing) doesn't latch on for 1-2 frames while the body is
        // still cruising at dashSpeed. Without this, the run animation
        // event fires briefly between OnDashEnd and natural deceleration,
        // looking like a flicker into "run" mid-recovery.
        body.setVelocityX(0);
        body.setVelocityY(0);
        this.sprite.events.emit("OnDashEnd");
      }
      return; // skip normal movement while dashing
    }
    if (this.dashEnabled && dashPressed && this.now >= this.dashReadyAtSec) {
      this.dashing = true;
      // Block Walls OFF → phase-dash: disable the body's collision so the dash
      // passes through solids AND tiles. (vy is held at 0 each dash frame, so
      // the body doesn't fall through the floor mid-dash.) Restored at end.
      if (!this.dashWallBlock && body.checkCollision) {
        body.checkCollision.none = true;
        this._dashPhasing = true;
      }
      const windup = Math.max(0, this.dashStartDelay);
      this.dashWindupEndsAtSec = this.now + windup;
      // Active duration (`dashDuration`) starts AFTER the windup, so the
      // total time from press → re-eligible to dash is windup + duration
      // + cooldown. Matches user expectation that dashDuration measures
      // the moving phase only.
      this.dashEndsAtSec = this.now + windup + this.dashDuration;
      this.dashDir = effLeft ? -1 : effRight ? 1 : this.facing;
      this.sprite.events.emit("OnDashStart");
      if (this.dashCustomFn) this.sprite.events.emit(this.dashCustomFn);
      // Suspend velocity during the windup; first active frame writes the
      // dash velocity from the dashing-block above.
      if (windup > 0) {
        body.setVelocityX(0);
        body.setVelocityY(0);
      } else {
        body.setVelocityX(this.dashSpeed * this.dashDir);
        body.setVelocityY(0);
      }
      return;
    }

    // ── Horizontal movement (smooth accel) ────────────────────────────────
    const targetVx = effLeft ? -this.maxSpeed
                  : effRight ? this.maxSpeed
                  : 0;
    const inputMag = (effLeft || effRight) ? 1 : 0;
    const usingAccel = (inputMag !== 0 && Math.sign(targetVx) === Math.sign(body.velocity.x))
                       || (inputMag !== 0 && body.velocity.x === 0);
    const rate = usingAccel ? this.acceleration : this.deceleration;
    const dv = rate * dt * (onGround ? 1 : this.airControl);
    if (body.velocity.x < targetVx) body.setVelocityX(Math.min(body.velocity.x + dv, targetVx));
    else if (body.velocity.x > targetVx) body.setVelocityX(Math.max(body.velocity.x - dv, targetVx));

    // ── Wall slide detection ─────────────────────────────────────────────
    // Slide condition: airborne, touching a side wall, falling. If
    // wallSlideRequiresInput is on, also require holding direction into wall.
    const onWallLeft  = !onGround && (body.blocked.left  || body.touching.left);
    const onWallRight = !onGround && (body.blocked.right || body.touching.right);
    const wallDir: 0 | -1 | 1 = onWallLeft ? -1 : onWallRight ? 1 : 0;
    const inputIntoWall = (wallDir === -1 && left) || (wallDir === 1 && right);
    const inputAwayFromWall = (wallDir === -1 && right) || (wallDir === 1 && left);
    // Vertical eligibility: by default while falling OR stationary
    // (preserves jump arcs). The `>= 0` rather than `> 0` keeps the
    // flag held when authors clamp vy to 0 via Logic Sheet (a strict
    // `> 0` would flip eligibility false → gravity normal → 2-tick
    // oscillation that visibly slides the body). When
    // `wallSlideOnContact` is on, any vertical state qualifies.
    const verticallyEligible = this.wallSlideOnContact ? true : body.velocity.y >= 0;
    const suppressed = this.now < this._wallSlideSuppressedUntilSec;
    const rawWallSliding = !suppressed && !!this.wallEnabled && wallDir !== 0 && verticallyEligible &&
                        // Pressing AWAY from the wall ends the slide immediately,
                        // in EVERY mode — including on-contact / no-input, where it
                        // would otherwise hold while the body is still touching the
                        // wall (1-2 frames) and the slide anim lingers before fall.
                        !inputAwayFromWall &&
                        (!this.wallSlideRequiresInput || inputIntoWall);
    if (rawWallSliding) this._wallSlidingLastTrueAtSec = this.now;
    // Deliberate press-away KILLS the coyote timestamp. Without this, the
    // moment the body separates from the wall (wallDir → 0) `inputAwayFromWall`
    // can no longer be detected, the coyote `(now - lastTrue) < 100ms` test
    // passes again, and the slide re-engages for the rest of the window — the
    // residual "few frames of wall-slide before fall" bug. Zeroing it here
    // ends the slide on the press-away frame and keeps it ended.
    else if (inputAwayFromWall) this._wallSlidingLastTrueAtSec = -Infinity;
    // Coyote window — keep `wallSliding` true for 100 ms after the raw
    // formula drops out, as long as we're still airborne. ONLY airborne
    // is required (not wallDir!=0) because Phaser's body-separation
    // step flickers `blocked.left/right` and `touching.left/right` to
    // false every 1-2 ticks during a steady slide → wallDir flickers →
    // sticky fails. Stale wall-slide for 100ms after legitimately
    // leaving the wall is harmless: wall jump explicitly clears the
    // flag, grounding clears it, and any other release path waits at
    // most 100ms which the player won't perceive.
    const wallSlideCoyote = 0.1;
    const stickyWallSliding = rawWallSliding || (
      !onGround &&
      // Coyote is ONLY for the physics-flicker false-negative during a steady
      // slide. A deliberate press AWAY from the wall must detach immediately —
      // otherwise the wall-slide anim lingers a few frames before fall.
      !inputAwayFromWall &&
      (this.now - this._wallSlidingLastTrueAtSec) < wallSlideCoyote
    );
    const wallSliding = stickyWallSliding;
    this.wallSliding = wallSliding; // expose for IsWallSliding guard
    // Physics-side wall-slide effects ONLY apply when the RAW formula is
    // true. The sticky/coyote case keeps the flag true for the animator
    // but skips physics — applying the gravity clamp to a body with
    // negative vy (just after wall jump) computes a huge positive
    // gravity that kills the upward velocity.
    if (rawWallSliding) {
      // Wall slide cap = `wallSlideSpeed`. Body accelerates at normal
      // gravity until vy reaches the cap, then vy clamps AND body
      // gravity zeros out so the next physics step doesn't push vy
      // past the cap and integrate the overshoot into position
      // (visible as ~0.2 px/frame slow drift even at wallSlideSpeed=0).
      if (body.velocity.y >= this.wallSlideSpeed) {
        body.setVelocityY(this.wallSlideSpeed);
        body.setGravityY(-this.sprite.scene.physics.world.gravity.y);
        this.lastAppliedGravity = NaN;
      } else if (this.wallSlideOnContact && body.velocity.y < 0) {
        body.setVelocityY(0);
      }
      // Wall stick — without a small velocity into the wall, arcade
      // physics separates the body the moment there's no force
      // pushing it in, dropping `touching.left/right` next tick and
      // ending the slide.
      if (!this.wallSlideRequiresInput && !inputAwayFromWall) {
        body.setVelocityX(40 * wallDir);
      }
      if (this.wallSlideCustomFn) this.sprite.events.emit(this.wallSlideCustomFn);
    }

    // ── Coyote / buffer book-keeping ──────────────────────────────────────
    if (onGround) this.timeSinceGroundedSec = 0;
    else this.timeSinceGroundedSec += dt;

    if (jumpPressed) this.bufferedJumpAtSec = this.now;
    const jumpBuffered = this.bufferEnabled !== 0 && (this.now - this.bufferedJumpAtSec) <= this.bufferTime;

    const canCoyote = this.coyoteEnabled !== 0 && this.timeSinceGroundedSec <= this.coyoteTime;

    // ── Jump ─────────────────────────────────────────────────────────────
    // Slot model: jumpsUsed in [0, multiJump]. Slot 0 = first jump (ground or
    // coyote). Slots 1..multiJump-1 = mid-air re-jumps. Walking off a ledge
    // without jumping consumes slot 0 (so multiJump=1 means truly one jump),
    // but only AFTER the coyote window expires — within the window, slot 0
    // is still claimable.
    let didJump = false;
    const wantJump = jumpPressed || jumpBuffered;
    // Wall jump takes priority — if we're sliding and pressed jump, kick off
    // the wall and consume the press so it doesn't double-fire as a regular jump.
    // Gated by `wallJumpAllowed` so an event-flipped flag (e.g. "must
    // reach wallslide main phase before wall-jumping is allowed") can
    // block the physics entirely from the animator side.
    if (wantJump && wallSliding && this.wallJumpAllowed) {
      body.setVelocityY(-this.wallJumpStrength);
      body.setVelocityX(-wallDir * this.wallJumpKickX);
      this.bufferedJumpAtSec = -Infinity;
      this.jumpsUsed = 1;
      this.timeSinceGroundedSec = Infinity;
      // Clear the slide state and suppress re-detection for a short
      // window so the character clearly leaves the wall before
      // wallSliding can flip back on. Without this, the animator's
      // `isWallSliding` condition reads true for the frame(s) the body
      // still touches the wall after the kick, and the wallslide state
      // keeps winning instead of letting `jump` take over.
      this.wallSliding = false;
      this._wallSlideSuppressedUntilSec = this.now + 0.15;
      this.wallJumpedAtSec = this.now;
      this.sprite.events.emit("OnJump");
      if (this.jumpCustomFn) this.sprite.events.emit(this.jumpCustomFn);
      if (this.wallJumpCustomFn) this.sprite.events.emit(this.wallJumpCustomFn);
      didJump = true;
    }
    if (wantJump && !didJump) {
      const canFirstJump = (onGround || canCoyote) && this.jumpsUsed === 0;
      const canExtraJump = !canFirstJump && this.jumpsUsed >= 1 && this.jumpsUsed < this.multiJump;

      const kick = this.effectiveJumpStrength();
      if (canFirstJump) {
        body.setVelocityY(-kick);
        if (this.jumpTimeToApex > 0) this._jumpAscentEndsAt = this.now + this.jumpTimeToApex;
        this.jumpsUsed = 1;
        this.timeSinceGroundedSec = Infinity; // prevent re-using same coyote window
        this.bufferedJumpAtSec = -Infinity;
        if (this.jumpSustainEnabled) this.jumpSustainEndsAt = this.now + this.jumpSustainTime;
        this.sprite.events.emit("OnJump");
        if (this.jumpCustomFn) this.sprite.events.emit(this.jumpCustomFn);
        didJump = true;
      } else if (canExtraJump) {
        body.setVelocityY(-kick);
        if (this.jumpTimeToApex > 0) this._jumpAscentEndsAt = this.now + this.jumpTimeToApex;
        this.jumpsUsed++;
        this.bufferedJumpAtSec = -Infinity;
        if (this.jumpSustainEnabled) this.jumpSustainEndsAt = this.now + this.jumpSustainTime;
        this.sprite.events.emit("OnJump");
        if (this.jumpCustomFn) this.sprite.events.emit(this.jumpCustomFn);
        didJump = true;
      }
    }

    // ── Jump sustain — hold to keep rising ────────────────────────────────
    // While the jump button is held within the sustain window, keep vy
    // pinned at -jumpStrength so the player maintains upward speed. Released
    // jump or sustain timeout naturally hands off to gravity.
    // Honor `ignoreInput` so a cutscene that starts mid-jump doesn't keep
    // the player rising while the sustain timer ticks down (the user might
    // have a finger on Jump that the cutscene shouldn't see).
    const jumpHeldNow = !inputOff && ia && this.jumpAction ? ia.isDown(this.jumpAction) : false;
    if (this.jumpSustainEnabled && jumpHeldNow && this.now < this.jumpSustainEndsAt) {
      const kick = this.effectiveJumpStrength();
      if (body.velocity.y > -kick) body.setVelocityY(-kick);
    }
    // Cancel sustain immediately on jump release so the player has fine
    // control over hop height.
    if (jumpReleased) this.jumpSustainEndsAt = 0;
    if (onGround && !didJump) this.jumpsUsed = 0;
    // Once airborne and coyote window has elapsed, the first slot is gone for good
    // (until next ground touch). Without this, multiJump=1 would still allow one
    // free mid-air jump because slot 0 stays at 0.
    if (!onGround && !canCoyote && this.jumpsUsed === 0) this.jumpsUsed = 1;

    // ── Variable jump height (release-to-cut) ─────────────────────────────
    if (this.varHeightEnabled && jumpReleased && body.velocity.y < this.varHeightCutoff) {
      body.setVelocityY(this.varHeightCutoff);
    }

    // ── Ceiling mode ─────────────────────────────────────────────────────
    // Phaser zeros vy on collision by default. In "preserve momentum" mode
    // we restore the previous frame's upward vy if the player just smacked
    // a ceiling while ascending — they keep rising past the corner.
    if (this.ceilingMode !== 0 && (body.blocked.up || body.touching.up) && this.prevVy < 0) {
      body.setVelocityY(this.prevVy);
    }
    this.prevVy = body.velocity.y;

    // ── Cap fall speed ────────────────────────────────────────────────────
    if (body.velocity.y > this.maxFallSpeed) body.setVelocityY(this.maxFallSpeed);

    // ── Auto-mirror — flip sprite to face movement direction ─────────────
    // Mode 1 (velocity): flip whenever velocity.x has clear sign. Sticky on
    //   deceleration (we don't flip back to "right" while sliding right at
    //   negative vx since vx > 0 there).
    // Mode 2 (input): flip on the last held direction key — useful when you
    //   want the character to face their intent even before moving.
    if (this.mirrorMode === 1) {
      if (body.velocity.x > 0.5) this.facing = 1;
      else if (body.velocity.x < -0.5) this.facing = -1;
    } else if (this.mirrorMode === 2) {
      if (left && !right) this.facing = -1;
      else if (right && !left) this.facing = 1;
    }
    // A one-shot state with `lockFacing` (e.g. an attack) suppresses the
    // visual flip until its animation completes a cycle. We still update
    // `this.facing` above so the held flip lands on the LATEST direction once
    // the lock releases — we just skip writing `facingScaleX` here.
    const animFacingLocked = !!(this.sprite.findBehaviorByKind("StateMachine") as { facingLocked?: boolean } | undefined)?.facingLocked;
    if (this.mirrorMode !== 0 && !animFacingLocked) {
      // Mirror factor lives on `sprite.facingScaleX` — NOT on the body
      // Rectangle's scaleX. Setting a negative scaleX on the body desyncs
      // the arcade physics body from its visual (body drifts by its own
      // width). Body scale stays at the user's natural absolute value;
      // SpriteRenderer / Camera / SM facing conditions all read
      // `sprite.facingScaleX` to mirror in lockstep.
      const wantSign = this.facing;
      const absScale = this._naturalAbsScale || 1;
      const targetX = absScale * wantSign;
      if (this.scaleMirror && this.scaleMirrorTime > 0) {
        // Smooth flip: linear lerp at constant speed so a full traverse
        // (-absScale ↔ +absScale, distance 2*absScale) takes exactly
        // scaleMirrorTime seconds. Mid-tween direction changes retarget
        // from current value with no snap — produces the squash.
        const speed = (2 * absScale) / this.scaleMirrorTime;
        const step = speed * (delta / 1000);
        const diff = targetX - this.sprite.facingScaleX;
        this.sprite.facingScaleX = Math.abs(diff) <= step
          ? targetX
          : this.sprite.facingScaleX + Math.sign(diff) * step;
      } else {
        this.sprite.facingScaleX = targetX;
      }
    }

    // OnLand / OnFall are emitted by Sprite.tick (built-in, velocity-based).
  }
}
