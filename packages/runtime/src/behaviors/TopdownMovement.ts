import { Behavior } from "../Behavior";
import { getInputActions } from "../input/InputActions";

/** 8-way direction buckets indexed by round(atan2(vy,vx)/45°) mod 8 (Y-down). */
const TM_DIRS_8 = ["right", "downright", "down", "downleft", "left", "upleft", "up", "upright"] as const;

/**
 * 8-directional, gravity-free movement controller for RPG-topdown players (and
 * any free-floating object). The companion to CharacterMovement: CM is a
 * platformer (horizontal + gravity + jump); this is free 2D with no falling.
 *
 * Don't put BOTH on one BP — CharacterMovement applies its own gravity each
 * tick, which would fight this controller's `setAllowGravity(false)`. Use one
 * or the other.
 *
 * Reads four named input actions (up/down/left/right), OR-merged with
 * `simulatedInputs` (so AIBrain / scripted callers can drive it) and gated by
 * the animator's `blockedActions`. Diagonals are normalized so moving on two
 * axes isn't faster than one. Facing/mirror mirrors CharacterMovement exactly
 * (writes `sprite.facingScaleX`, honors the animator's `facingLocked`).
 */
export class TopdownMovement extends Behavior {
  kind = "TopdownMovement";

  /** Top movement speed in px/s. */
  maxSpeed = 220;
  /** Ramp toward target speed (px/s²) while a direction is held. High = snappy
   *  / near-instant (Zelda-like); lower = floaty. */
  acceleration = 1500;
  /** Ramp back to 0 (px/s²) when no direction is held. */
  deceleration = 1500;

  /** Diagonal slide assist. A sloped collider is decomposed into a staircase
   *  of axis-aligned boxes (Arcade has no real diagonals), and with no gravity
   *  to push you along it, pressing straight into the slope dead-stops on a
   *  step face. When on, if the pressed axis is blocked and the perpendicular
   *  axis is free, we probe which way the slope recedes and redirect the
   *  blocked speed along it so you glide up/down the diagonal. 0 = off. */
  slideAssist = 1;

  /** Input-action names per direction. `*EventTrigger` is an optional event
   *  name that ALSO drives the direction (parity with CharacterMovement). */
  upAction = "MoveUp";
  downAction = "MoveDown";
  leftAction = "MoveLeft";
  rightAction = "MoveRight";
  upEventTrigger = "";
  downEventTrigger = "";
  leftEventTrigger = "";
  rightEventTrigger = "";

  /** When non-zero, all input/event movement triggers go silent (momentum
   *  still tick). For cutscene / dialogue lockouts via SetBehaviorParam. */
  ignoreInput = 0;

  /** Facing mirror: 0 = off, 1 = face velocity.x, 2 = face L/R input. Topdown
   *  chars usually use 4 directional anims (mirror off); enable for L/R-mirror
   *  sprites. */
  mirrorMode = 0;
  /** 0 = snap flip, 1 = smooth lerp over `scaleMirrorTime`. */
  scaleMirror = 0;
  scaleMirrorTime = 0.15;

  /** Programmatically-pushed input action names (AIBrain / scripts). OR-merged
   *  with real input, same contract as CharacterMovement.simulatedInputs. */
  simulatedInputs: Set<string> = new Set();

  private _naturalAbsScale = 0;
  private facing: 1 | -1 = 1;
  /** Last 8-way move direction — edge-detects OnTopdownDirectionChanged. */
  private _prevMoveDir = "";
  /** SOCD (simultaneous opposite cardinal direction) resolution — remembers
   *  which of an opposite pair was pressed MOST RECENTLY so holding both
   *  left+right (or up+down) moves toward the last-pressed one instead of
   *  cancelling to a dead stop. */
  private _lastH: "left" | "right" | null = null;
  private _lastV: "up" | "down" | null = null;
  /** Sticky 4-way facing direction — "up" / "down" / "left" / "right" /
   *  "" (never moved). Updated WHENEVER a direction key is held (and survives
   *  release). Read by the `IsTopdownFacing` condition so authors can write
   *  "if facing up → fire up". Defaults to "down" — typical character spawn
   *  pose. */
  facingDir: "up" | "down" | "left" | "right" = "down";

  init(): void {
    // Float regardless of scene gravity. Sticky — set once.
    this.sprite.body.setAllowGravity(false);
    // Cache natural |scaleX| ONCE so the smooth-mirror lerp targets the right
    // magnitude (re-reading mid-tween would poison it).
    this._naturalAbsScale = Math.abs(this.sprite.gameObject.scaleX) || 1;
  }

  update(delta: number): void {
    const body = this.sprite.body;
    if (!body) return;
    // Hitstun gate — same fix as MoveTo / CharacterMovement. When the
    // host is in Damageable's hitstun window, freeze the input → velocity
    // pipeline so the knockback Damageable just applied actually plays
    // out instead of being overwritten by this tick's setVelocity call.
    const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
    if (dmg?.isInHitstun?.()) return;
    const ia = getInputActions(this.sprite.scene);
    // Input gate: an input-gated animator state can suppress a direction.
    const blocked = (this.sprite.findBehaviorByKind("StateMachine") as { blockedActions?: Set<string> } | undefined)?.blockedActions;
    const isBlocked = (name: string): boolean => !!blocked && blocked.has(name);
    const sim = this.simulatedInputs;
    const inputOff = this.ignoreInput !== 0;
    // A direction is active from EITHER a held key, a simulated input
    // (AIBrain), or its event trigger.
    const held = (action: string, simName: string, eventTrigger: string): boolean => {
      if (inputOff) return false;
      const fromInput = ia && action && !isBlocked(action) ? ia.isDown(action) : false;
      const fromSim = sim.has(simName) || (action ? sim.has(action) : false);
      const fromEvent = eventTrigger ? this.sprite.events.firedThisFrame(eventTrigger) : false;
      return fromInput || fromSim || fromEvent;
    };
    const up = held(this.upAction, "MoveUp", this.upEventTrigger);
    const down = held(this.downAction, "MoveDown", this.downEventTrigger);
    const left = held(this.leftAction, "MoveLeft", this.leftEventTrigger);
    const right = held(this.rightAction, "MoveRight", this.rightEventTrigger);

    // SOCD: track which side of each opposite pair was pressed most recently
    // so holding both moves toward the LAST press instead of cancelling.
    if (ia) {
      if (this.leftAction && ia.justPressed(this.leftAction)) this._lastH = "left";
      if (this.rightAction && ia.justPressed(this.rightAction)) this._lastH = "right";
      if (this.upAction && ia.justPressed(this.upAction)) this._lastV = "up";
      if (this.downAction && ia.justPressed(this.downAction)) this._lastV = "down";
    }
    // Resolve each axis: both held → last-pressed wins; one held → that one;
    // neither → 0. Replaces the old `right - left` which dead-stopped on
    // simultaneous opposite holds.
    let dx = left && right ? (this._lastH === "left" ? -1 : 1)
      : right ? 1 : left ? -1 : 0;
    let dy = up && down ? (this._lastV === "up" ? -1 : 1)
      : down ? 1 : up ? -1 : 0;
    // Sticky facing — last direction the player INTENDED to move. Vertical
    // input wins ties so a player walking diagonally up-left ends up "facing
    // up" once they stop (matches Zelda-style topdown convention). When two
    // axes are held, the LAST-pressed wins on ties via the explicit
    // up/down precedence.
    if (up) this.facingDir = "up";
    else if (down) this.facingDir = "down";
    else if (left) this.facingDir = "left";
    else if (right) this.facingDir = "right";
    // Normalize diagonals so two-axis movement isn't √2 faster.
    if (dx !== 0 && dy !== 0) { const k = Math.SQRT1_2; dx *= k; dy *= k; }

    const dt = delta / 1000;
    const stepTo = (cur: number, target: number): number => {
      const rate = (target !== 0 ? this.acceleration : this.deceleration) * dt;
      const d = target - cur;
      return Math.abs(d) <= rate ? target : cur + Math.sign(d) * rate;
    };
    body.setVelocity(
      stepTo(body.velocity.x, dx * this.maxSpeed),
      stepTo(body.velocity.y, dy * this.maxSpeed),
    );

    // Diagonal slide assist — see the `slideAssist` field. Only when pushing
    // PURELY into one axis (the other has its own velocity to slide already)
    // and that axis is blocked. Probe the two diagonal-ahead cells: the one
    // the slope recedes toward is empty, the other is solid → slide that way.
    if (this.slideAssist !== 0 && Math.hypot(dx, dy) > 0) {
      const ab = body as unknown as {
        x: number; y: number; width: number; height: number;
        blocked: { left: boolean; right: boolean; up: boolean; down: boolean };
        touching: { left: boolean; right: boolean; up: boolean; down: boolean };
      };
      // Static-body contacts set `touching` (and usually `blocked`) — check both.
      const hit = (s: "left" | "right" | "up" | "down") => ab.blocked[s] || ab.touching[s];
      const AHEAD = 4, PERP = 10;
      const clear = (ox: number, oy: number): boolean =>
        this.sprite.scene.physics.overlapRect(ab.x + ox, ab.y + oy, ab.width, ab.height, false, true).length === 0;
      if (dx !== 0 && dy === 0 && (dx < 0 ? hit("left") : hit("right"))) {
        const ax = Math.sign(dx) * AHEAD;
        const up = clear(ax, -PERP), down = clear(ax, PERP);
        if (up !== down) body.setVelocityY((up ? -1 : 1) * this.maxSpeed);
      } else if (dy !== 0 && dx === 0 && (dy < 0 ? hit("up") : hit("down"))) {
        const ay = Math.sign(dy) * AHEAD;
        const left = clear(-PERP, ay), right = clear(PERP, ay);
        if (left !== right) body.setVelocityX((left ? -1 : 1) * this.maxSpeed);
      }
    }

    // Emit OnTopdownDirectionChanged when the 8-way movement direction flips
    // (only while moving) — for footsteps / turn FX. Mirrors how CM emits its
    // OnJump/OnLand edges.
    const mvx = body.velocity.x, mvy = body.velocity.y;
    if (Math.hypot(mvx, mvy) > 8) {
      const idx = ((Math.round(Math.atan2(mvy, mvx) / (Math.PI / 4)) % 8) + 8) % 8;
      const dir = TM_DIRS_8[idx];
      if (dir !== this._prevMoveDir) {
        this._prevMoveDir = dir;
        this.sprite.events.emit("OnTopdownDirectionChanged");
      }
    }

    // Facing — identical model to CharacterMovement: sign lives on
    // sprite.facingScaleX (not the body), respects the animator's facingLocked.
    const animFacingLocked = !!(this.sprite.findBehaviorByKind("StateMachine") as { facingLocked?: boolean } | undefined)?.facingLocked;
    if (this.mirrorMode === 1) {
      // Follow velocity ONLY while the character is moving under its OWN
      // input (held key / sim input) — a knockback also writes body.velocity,
      // and we must NOT let an external shove flip the facing (you'd turn to
      // face your attacker's push). No input → preserve the current facing.
      const movingByInput = left || right || up || down;
      if (movingByInput) {
        if (body.velocity.x > 0.5) this.facing = 1;
        else if (body.velocity.x < -0.5) this.facing = -1;
      }
    } else if (this.mirrorMode === 2) {
      // Input-based mirror — face the SOCD-resolved direction so holding
      // both left+right flips to the LAST-pressed one (matches movement)
      // instead of freezing the facing.
      if (left && right) this.facing = this._lastH === "left" ? -1 : 1;
      else if (left) this.facing = -1;
      else if (right) this.facing = 1;
    }
    if (this.mirrorMode !== 0 && !animFacingLocked) {
      const absScale = this._naturalAbsScale || 1;
      const targetX = absScale * this.facing;
      if (this.scaleMirror && this.scaleMirrorTime > 0) {
        const speed = (2 * absScale) / this.scaleMirrorTime;
        const step = speed * dt;
        const diff = targetX - this.sprite.facingScaleX;
        this.sprite.facingScaleX = Math.abs(diff) <= step ? targetX : this.sprite.facingScaleX + Math.sign(diff) * step;
      } else {
        this.sprite.facingScaleX = targetX;
      }
    }
  }
}
