import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { spriteByUid, getSpritesByTag, type Sprite } from "../Sprite";
import { getNeighborsByTag } from "../spatialGrid";
import { findPath, type NavGrid } from "../nav/NavGrid";
import { isNavPointAvailable, navPointTileExists, claimNavPoint } from "../nav/navPoints";

type NavWp = { id?: string; x: number; y: number; name?: string; tags?: string[]; waitSec?: number; signalOnArrive?: string; srcMap?: string; srcX?: number; srcY?: number; setStateAny?: string; setStates?: { bp: string; state: string }[]; singleUse?: boolean };

/**
 * MoveTo — lightweight chase/locomotion behavior. Replaces the heavier
 * AIBrain for "just walk toward X" cases. Construct-3 muscle memory:
 * mode picker decides what "X" means.
 *
 *   - "position": fixed world (targetX, targetY). NPC walks to that spot
 *                 and stops within `stopRadius`. The waypoint AI.
 *   - "object":   chase a specific sprite uid. Re-locks on death.
 *   - "tag":      chase nearest sprite carrying targetTag. Re-acquires
 *                 every `retargetEverySec` (default 0.5s, set 0 = every
 *                 frame). THIS is the swarm-enemy mode (10K zombies all
 *                 chasing the player).
 *   - "angle":    fly in a fixed direction forever (`angleDeg`). Straight-
 *                 line motion regardless of target. Bullets, projectiles
 *                 without homing, etc.
 *
 * Per-tick cost is dominated by the lookup:
 *   - position / angle: O(1)        — no lookup, just math
 *   - object:           O(1)        — uid map hit
 *   - tag:              O(few)      — tag index + spatial grid via
 *                                     getNeighborsByTag
 *
 * Movement output: writes to the Phaser arcade body's velocity each tick
 * when `usePhysics = 1` (default — collides with walls properly). When
 * `usePhysics = 0`, writes directly to `gameObject.x/y` (cheaper, no
 * collision, no body integration — for huge swarms where physics is
 * the bottleneck).
 *
 * Pause/Resume via `enabled` (set to 0 to halt mid-trajectory).
 * Arrival via `arrivalSignal` (emitted once when the sprite enters
 * `stopRadius` of position/object/tag target).
 */
export class MoveTo extends Behavior {
  kind = "MoveTo";

  /** Target mode. See class docstring for semantics. */
  mode: "position" | "object" | "tag" | "angle" = "position";
  /** World X (position mode). Expression. */
  targetX: number | string = 0;
  /** World Y (position mode). */
  targetY: number | string = 0;
  /** Sprite uid to chase (object mode). -1 = no target. */
  targetUid = -1;
  /** Tag string (tag mode). Resolves nearest sprite carrying it via the
   *  scene's tag index. */
  targetTag = "";
  /** Direction in degrees (angle mode). 0 = +X (right), 90 = +Y (down). */
  angleDeg = 0;
  /** Movement speed in px/sec. */
  speed = 100;
  /** Distance (px) at which the sprite is considered "arrived" — stops
   *  moving and emits `arrivalSignal`. Ignored in angle mode (which has
   *  no destination). Default 4 — pixel-perfect arrival without rounding
   *  jitter. */
  stopRadius = 4;
  /** Tag mode only — seconds between target re-lookups. 0 = every frame
   *  (always chase the CURRENT nearest), 0.5s = re-pick every half second
   *  (lock onto a target for half a sec before considering swapping —
   *  prevents jittery wobble when two targets are equidistant). */
  retargetEverySec = 0.5;
  /** Optional signal name emitted ONCE on arrival (position/object/tag
   *  modes only). Empty = no signal. */
  arrivalSignal = "";
  /** When 1 (default), drives the Phaser body velocity — physics handles
   *  wall collisions, smooth integration, knockback compatibility. When 0,
   *  writes directly to gameObject.x/y each tick — ~2× faster for huge
   *  swarms but no collision response (the sprite walks through walls).
   *  Use 0 ONLY when you can guarantee no-collision movement (open-world
   *  swarms, particle-like NPCs). */
  usePhysics = 1;
  /** Minimum gap (px) this sprite keeps from same-tag siblings. When
   *  > 0, MoveTo blends a "push away from nearest same-tag neighbor"
   *  vector into the move target — so 1500 zombies all chasing the
   *  player spread out instead of stacking exactly on the player's
   *  position. Uses the spatial grid + tag index (Phase 1 + 2 indexes)
   *  so the per-tick cost is O(neighbors-in-cell), not O(N). 0 = off
   *  (default — overlapping is fine for, e.g., bullets). */
  separationDist = 0;
  /** Tag identifying siblings to space against. Defaults to the host's
   *  FIRST tag at init() so "Enemy BP" NPCs separate from each other
   *  out of the box. Set explicitly if a BP carries multiple tags and
   *  you need a specific one (e.g. "swarm") rather than the first. */
  separationTag = "";
  /** Unused since the boids-style push was replaced with the queue/slide
   *  behaviors. Kept on the schema for back-compat with saved configs. */
  separationStrength = 0.6;
  /** How separation enforces spacing between same-tag siblings.
   *   "off"      — no separation, NPCs can fully overlap
   *   "velocity" — Reynolds-style steering blend. Each tick, compute a
   *                repulsion vector away from nearby siblings (weight ∝
   *                closeness) and blend it with the chase velocity. NPCs
   *                swerve gently around each other while approaching the
   *                target. Smooth visual flow, slight overlap possible
   *                in dense crowds. Default for "natural" feel.
   *   "push"     — Vampire Survivors style hard min-distance. Position
   *                correction runs AFTER velocity write: if two NPCs are
   *                closer than separationDist, both move apart by half the
   *                overlap. Symmetric so no oscillation. Maintains a hard
   *                visual gap even in dense piles. */
  separationMode: "off" | "velocity" | "push" = "push";
  /** When a same-tag sibling is between this NPC and its target,
   *  what to do:
   *   0 (default) — STOP. Hold position; wait for the front-runner to
   *                 clear out. The "queue" behavior. Best for tight
   *                 swarms where you want orderly columns.
   *   1           — AVOID. Try to slide PERPENDICULAR to the blocker
   *                 (and pick whichever side gets us closer to the
   *                 target). The "find another way" behavior. NPCs
   *                 flow around obstacles instead of stacking. */
  separationAvoid = 0;
  // `enabled` is inherited from base Behavior (boolean). Toggle off for
  // cinematic pause / cutscene freeze. Default on (set by base).

  /** Internal: sim seconds since last tag-mode retarget. */
  private _sinceRetarget = 0;
  /** Internal: cached resolved target sprite (object/tag mode). */
  private _target: Sprite | null = null;
  /** Internal: arrival latch — fires arrivalSignal once per acquisition. */
  private _arrivedFor: Sprite | string | null = null;
  /** Internal: true on any tick this behavior is actively driving the body
   *  toward a target (all modes). Read by the IsMovingTo condition — which
   *  can't use `_target` because position mode never sets one. */
  _moving = false;
  /** When set, MoveTo FOLLOWS this world-point path (from the nav-mesh A*)
   *  instead of its mode target — advancing waypoint by waypoint and emitting
   *  OnArrived at the final point. Set by MoveToNavPoint; cleared on arrival
   *  or when a plain target (MoveToSetPosition/Object/Tag/Angle) is issued. */
  navPath: { x: number; y: number }[] | null = null;
  private _navIdx = 0;
  /** Active patrol over nav waypoints — set by PatrolNavPoints. On reaching the
   *  current waypoint, MoveTo emits its arrival (signal + On Point Arrived),
   *  waits its `waitSec`, then advances (loop / ping-pong / random) and A*-paths
   *  to the next, so the NPC loops the route around obstacles forever. */
  navPatrol: { points: NavWp[]; idx: number; mode: "loop" | "pingpong" | "random" | "nearest"; dir: number } | null = null;
  /** One-shot nav target waypoint (MoveToNavPoint) — for its arrival behavior. */
  navTarget: NavWp | null = null;
  /** Selection criteria (name/tag) of the last nav request. Lets MoveTo
   *  re-pick another available point when its single-use target is consumed
   *  by another NPC mid-transit. */
  navWant = "";
  /** State to force when a patrol has NO available point (e.g. "Idle"). The NPC
   *  stops here, holds this state, and keeps watching — resuming the moment a
   *  point frees up (another NPC leaves, a bush regrows). Empty = just stop. */
  navFallbackState = "";
  /** True while a patrol is parked with no available point (see navFallbackState).
   *  Public so PatrolNavPoints can start a patrol already parked when every point
   *  is taken. */
  navWaiting = false;
  /** Countdown (sec) to the next "is a point free yet?" re-scan while waiting. */
  private _waitRecheck = 0;
  /** Remaining patrol pause (sec) at the current waypoint. */
  private _waitLeft = 0;
  /** Mirror the host's facing to match horizontal movement direction. When 1
   *  (default), MoveTo writes sprite.facingScaleX so the SpriteRenderer overlay
   *  flips to face the way the NPC walks. 0 = never flip (top-down sprites that
   *  shouldn't mirror). */
  mirror = 1;
  /** Captured natural |facingScaleX| at init so the flip preserves the BP's
   *  baseline scale magnitude. */
  private _absScale = 1;

  init(): void {
    this._absScale = Math.abs(this.sprite.facingScaleX) || 1;
    // Initial target resolution so the first tick has something to chase.
    this._sinceRetarget = this.retargetEverySec;
    // Default separation tag to the host's first tag — so an "Enemy" BP
    // separates from other Enemy-tagged NPCs out of the box. The author
    // can still override with a specific tag if the BP carries several.
    if (!this.separationTag && this.sprite.tags.size > 0) {
      this.separationTag = this.sprite.tags.values().next().value ?? "";
    }
  }

  update(delta: number): void {
    if (this.sprite.destroyed) return;
    // PUSH-APART pass runs FIRST, unconditionally — even when MoveTo is
    // disabled (AIBrain attack state, paused chase, etc.). Push-apart is
    // a hard physical-occupation constraint: an NPC standing still must
    // still push back against chase-state NPCs colliding with it,
    // otherwise the cluster boundary jitters. Always runs when mode is
    // "push" OR "velocity" — in velocity mode it acts as the hard
    // min-distance floor that prevents the eventual cluster-on-stop.
    if ((this.separationMode === "push" || this.separationMode === "velocity")
        && this.separationDist > 0
        && this.separationTag) {
      this._runPushApart();
    }
    if (!this.enabled) { this._moving = false; return; }
    // Hitstun gate — while the host is in Damageable.hitstun, freeze the
    // chase steering so the knockback velocity that Damageable.applyDamage
    // wrote isn't overwritten by per-tick targetVx math. CharacterMovement
    // already does this; MoveTo was a gap that made `knockbackX * hitback
    // multiplier` look broken for NPCs that chase via MoveTo (Vampire-
    // Survivors-style swarms etc.).
    const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
    if (dmg?.isInHitstun?.()) { this._moving = false; return; }
    // Animator freeze gate — a block/stunned state with freezeMovement must
    // stop the chase too, else the body follows the target while the block
    // anim plays (the animator zeroes velocity but we'd re-set it here).
    const sm = this.sprite.findBehaviorByKind("StateMachine") as { isMovementFrozen?: () => boolean } | undefined;
    if (sm?.isMovementFrozen?.()) { this._moving = false; this._setVelocity(0, 0); return; }
    const dt = delta / 1000;
    this._sinceRetarget += dt;

    const ox = this.sprite.gameObject.x;
    const oy = this.sprite.gameObject.y;

    // Refresh the claim lease on the point we're heading to / working, so no
    // other NPC picks it. A self-refreshing lease means death / re-target
    // release it automatically (it just stops refreshing).
    const claimWp = this.navTarget ?? (this.navPatrol ? this.navPatrol.points[Math.max(0, Math.min(this.navPatrol.points.length - 1, this.navPatrol.idx))] : undefined);
    if (claimWp?.id) claimNavPoint(this.sprite.scene, claimWp.id, this.sprite.uid);

    // Patrol parked — no point was available. Hold the fallback state and re-scan
    // periodically; resume the instant a point frees up (NPC leaves / bush regrows).
    if (this.navPatrol && this.navWaiting) {
      this._moving = false;
      this._setVelocity(0, 0);
      this._waitRecheck -= dt;
      if (this._waitRecheck <= 0) {
        this._waitRecheck = 0.5;
        const sc = this.sprite.scene;
        const anyFree = sc && this.navPatrol.points.some((p) => p.id && isNavPointAvailable(sc, p as { id: string; singleUse?: boolean; srcMap?: string; srcX?: number; srcY?: number }, this.sprite.uid));
        if (anyFree) {
          this.navWaiting = false;
          const anim = this.sprite.findBehaviorByKind("StateMachine") as { forcedState?: string } | undefined;
          if (anim) anim.forcedState = "";
          this._advancePatrol();
        }
      }
      return;
    }

    // Patrol pause — hold here while the current waypoint's wait counts down.
    if (this.navPatrol && this._waitLeft > 0) {
      this._waitLeft -= dt;
      this._moving = false;
      this._setVelocity(0, 0);
      if (this._waitLeft <= 0) { this._waitLeft = 0; this._advancePatrol(); }
      return;
    }

    // Nav-path following — overrides the mode target. Walk to each waypoint;
    // mid-path nodes use a looser arrive radius so the NPC doesn't stall on
    // corners, the final node uses stopRadius and fires OnArrived.
    if (this.navPath && this.navPath.length > 0) {
      // Destination gone mid-transit? Abandon and re-path. Triggers on either a
      // single-use point consumed by another NPC, OR a renewable tile-backed
      // point whose tile got mined before we arrived. (Claim is NOT an eviction
      // reason — we hold our own claim; sequential per-frame updates already stop
      // two NPCs picking the same point.)
      const scene = this.sprite.scene;
      const usedSet = scene?.data?.get("peaky.usedNavPoints") as Set<string> | undefined;
      const goneFor = (wp: NavWp | null | undefined): boolean =>
        !!wp && ((!!wp.singleUse && !!wp.id && !!usedSet?.has(wp.id)) || (!wp.singleUse && !navPointTileExists(scene, wp)));
      if (scene) {
        if (this.navTarget && goneFor(this.navTarget)) { this._retargetNavTarget(); return; }
        if (this.navPatrol && goneFor(this.navPatrol.points[this.navPatrol.idx])) { this._advancePatrol(); return; }
      }
      const last = this.navPath.length - 1;
      let i = Math.min(this._navIdx, last);
      let wp = this.navPath[i];
      let dist = Math.hypot(wp.x - ox, wp.y - oy);
      const midR = Math.max(this.stopRadius, this.speed * 0.06, 6);
      // Skip past any waypoints already reached this tick (fast NPCs / dense path).
      while (i < last && dist <= midR) { i++; wp = this.navPath[i]; dist = Math.hypot(wp.x - ox, wp.y - oy); }
      this._navIdx = i;
      if (i === last && dist <= this.stopRadius) {
        if (this.navPatrol && this.navPatrol.points.length > 0) {
          const wp = this.navPatrol.points[Math.max(0, Math.min(this.navPatrol.points.length - 1, this.navPatrol.idx))];
          this._onWaypointArrived(wp);
          const waitSec = wp.waitSec ?? 0;
          if (waitSec > 0) { this._waitLeft = waitSec; this.navPath = null; this._navIdx = 0; this._moving = false; this._setVelocity(0, 0); return; }
          this._advancePatrol();
          return;
        }
        if (this.navTarget) { this._onWaypointArrived(this.navTarget); this.navTarget = null; }
        this.navPath = null; this._navIdx = 0; this._moving = false;
        this._setVelocity(0, 0);
        // Hold position HERE. Without this, the mode fallback (position) keeps
        // its stale default target (0,0) and the NPC drifts to the origin. Pin
        // the target to the current spot and latch arrival so OnArrived doesn't
        // re-fire on the next tick.
        this.mode = "position";
        this.targetX = ox; this.targetY = oy;
        this._arrivedFor = `pos:${ox},${oy}`;
        this.sprite.events.emit("OnArrived");
        if (this.arrivalSignal) this.sprite.events.emit(this.arrivalSignal);
        return;
      }
      const inv = 1 / (dist || 1);
      this._moving = true;
      this._setVelocity((wp.x - ox) * inv * this.speed, (wp.y - oy) * inv * this.speed);
      return;
    }

    let tx = 0, ty = 0;
    let hasTarget = false;
    let arrivalKey: Sprite | string | null = null;

    switch (this.mode) {
      case "angle": {
        // No destination — emit velocity along the configured angle.
        const a = (Number(this.angleDeg) * Math.PI) / 180;
        this._moving = true;
        this._setVelocity(Math.cos(a) * this.speed, Math.sin(a) * this.speed);
        return;
      }
      case "position": {
        tx = Number(this.targetX) || 0;
        ty = Number(this.targetY) || 0;
        hasTarget = true;
        arrivalKey = `pos:${tx},${ty}`;
        break;
      }
      case "object": {
        if (this.targetUid > 0) {
          this._target = spriteByUid(this.sprite.scene, this.targetUid) ?? null;
        }
        if (this._target) {
          tx = this._target.gameObject.x;
          ty = this._target.gameObject.y;
          hasTarget = true;
          arrivalKey = this._target;
        }
        break;
      }
      case "tag": {
        // Re-acquire on retargetEverySec OR when current target is lost.
        const needRetarget = !this._target || this._target.destroyed ||
          this._sinceRetarget >= this.retargetEverySec;
        if (needRetarget && this.targetTag) {
          this._target = this._pickNearestByTag(ox, oy);
          this._sinceRetarget = 0;
        }
        if (this._target && !this._target.destroyed) {
          tx = this._target.gameObject.x;
          ty = this._target.gameObject.y;
          hasTarget = true;
          arrivalKey = this._target;
        }
        break;
      }
    }

    if (!hasTarget) {
      this._moving = false;
      this._setVelocity(0, 0);
      return;
    }

    const dx = tx - ox;
    const dy = ty - oy;
    const dist = Math.hypot(dx, dy);

    if (dist <= this.stopRadius) {
      this._moving = false;
      this._setVelocity(0, 0);
      // Latched arrival — fire ONCE per acquisition. Always emit "OnArrived"
      // (the Logic Sheet On Arrived trigger; the fire-once MoveTo emits the same
      // event), plus the optional author-named arrivalSignal when set.
      if (arrivalKey !== null && this._arrivedFor !== arrivalKey) {
        this._arrivedFor = arrivalKey;
        this.sprite.events.emit("OnArrived");
        if (this.arrivalSignal) this.sprite.events.emit(this.arrivalSignal);
      }
      return;
    }
    // Moving — reset the arrival latch so re-arriving (e.g. waypoint
    // re-issued at the same position) fires the signal again.
    if (this._arrivedFor !== null && this._arrivedFor !== arrivalKey) {
      this._arrivedFor = null;
    }

    const inv = 1 / dist;
    let vx = dx * inv * this.speed;
    let vy = dy * inv * this.speed;

    // Separation — two modes (chosen via separationMode):
    //
    // VELOCITY BLEND: smooth steering. Accumulate a repulsion vector
    //   away from each nearby same-tag sibling, weighted by closeness
    //   (1 - dist/separationDist). Blend with the chase velocity so
    //   NPCs swerve gracefully around each other while still pursuing
    //   the target. Looks natural; mild overlap possible at extreme
    //   density.
    //
    // PUSH APART: hard min-distance constraint. Runs AFTER the velocity
    //   has been computed and accepts it as-is for chase. The position
    //   correction at the bottom of update() then nudges this NPC by
    //   half the overlap depth for every too-close sibling. Symmetric
    //   (the OTHER sibling's pass nudges the same amount the other way)
    //   so the system reaches equilibrium fast without oscillation.
    //   Vampire Survivors / Brotato pattern.
    if (this.separationMode === "velocity"
        && this.separationDist > 0
        && this.separationTag) {
      const searchR = this.separationDist;
      const r2 = searchR * searchR;
      const neighbors = getNeighborsByTag(this.sprite.scene, this.separationTag, ox, oy, searchR);
      let pushX = 0;
      let pushY = 0;
      let touched = false;
      for (const n of neighbors) {
        if (n === this.sprite || n.destroyed) continue;
        const ndx = n.gameObject.x - ox;
        const ndy = n.gameObject.y - oy;
        const nd2 = ndx * ndx + ndy * ndy;
        if (nd2 > r2 || nd2 === 0) continue;
        const d = Math.sqrt(nd2);
        // Closeness weight: 1 at touching, → 0 at edge of separationDist.
        const t = 1 - d / searchR;
        pushX -= (ndx / d) * t;
        pushY -= (ndy / d) * t;
        touched = true;
      }
      if (touched) {
        const pushMag = Math.hypot(pushX, pushY);
        if (pushMag > 0.001) {
          // Normalize the push to "one full speed" of repulsion then
          // weighted-blend with chase. Blend ratio 0.6/0.4 chosen to feel
          // responsive but not overwhelming — chase still wins the
          // direction battle, push is the spacing pressure.
          const pushVx = (pushX / pushMag) * this.speed;
          const pushVy = (pushY / pushMag) * this.speed;
          vx = vx * 0.6 + pushVx * 0.4;
          vy = vy * 0.6 + pushVy * 0.4;
          // Renormalize so blended velocity doesn't exceed chase speed.
          const newMag = Math.hypot(vx, vy);
          if (newMag > this.speed) {
            vx = (vx / newMag) * this.speed;
            vy = (vy / newMag) * this.speed;
          }
        }
      }
    }

    this._moving = true;
    this._setVelocity(vx, vy);
  }

  /** Fire a waypoint's arrival hooks: the On Any/On Point triggers, its
   *  author-named signal, and stash it as the scene's last nav point. */
  private _onWaypointArrived(wp: NavWp): void {
    // Single-use: consume this point so no other NPC targets it.
    if (wp.singleUse && wp.id) {
      let used = this.sprite.scene?.data?.get("peaky.usedNavPoints") as Set<string> | undefined;
      if (!used) { used = new Set<string>(); this.sprite.scene?.data?.set("peaky.usedNavPoints", used); }
      used.add(wp.id);
    }
    // Forced state on arrival. The BP-agnostic `setStateAny` applies to every
    // NPC (the state machine ignores names it doesn't have); a matching per-BP
    // `setStates` rule overrides it.
    {
      const anim = this.sprite.findBehaviorByKind("StateMachine") as { forcedState?: string } | undefined;
      if (anim) {
        let target = wp.setStateAny?.trim() || "";
        if (wp.setStates && wp.setStates.length > 0) {
          const rule = wp.setStates.find((s) => s.bp === this.sprite.blueprintName || s.bp === this.sprite.blueprintId);
          if (rule && rule.state) target = rule.state;
        }
        if (target) anim.forcedState = target;
      }
    }
    this.sprite.scene?.data?.set("peaky.lastNavPoint", { name: wp.name ?? "", x: wp.x, y: wp.y, tags: wp.tags ?? [] });
    this.sprite.events.emit("OnAnyPointArrived");
    if (wp.name) this.sprite.events.emit(`OnPointArrived:${wp.name}`);
    if (wp.signalOnArrive) this.sprite.events.emit(wp.signalOnArrive);
  }

  /** Advance the patrol to the next waypoint (by mode) and A*-path to it. */
  private _advancePatrol(): void {
    // Release the forced state from the point we're LEAVING — the NPC resumes
    // its own state machine (walk) while travelling, and the next point's
    // forced state re-triggers cleanly on arrival.
    const anim = this.sprite.findBehaviorByKind("StateMachine") as { forcedState?: string } | undefined;
    if (anim) anim.forcedState = "";
    const pat = this.navPatrol!;
    const n = pat.points.length;
    const scene = this.sprite.scene;
    // Available = not single-use-consumed, not claimed by another NPC, and (if
    // tile-backed) its tile still exists. The current point counts as available
    // to US even if we hold its claim.
    const isAvail = (i: number) => { const p = pat.points[i]; return !!(p?.id) && isNavPointAvailable(scene, p as { id: string; singleUse?: boolean; srcMap?: string; srcX?: number; srcY?: number }, this.sprite.uid); };
    // No available point — PARK (don't end the patrol). Hold the fallback state,
    // stop, and let update()'s waiting loop re-scan + resume when one frees up.
    const availCount = (() => { let c = 0; for (let i = 0; i < n; i++) if (isAvail(i)) c++; return c; })();
    if (availCount === 0) {
      this.navPath = null; this._navIdx = 0; this._moving = false;
      this._setVelocity(0, 0);
      this.mode = "position"; this.targetX = this.sprite.gameObject.x; this.targetY = this.sprite.gameObject.y;
      if (anim && this.navFallbackState) anim.forcedState = this.navFallbackState;
      if (!this.navWaiting) { this.navWaiting = true; this.sprite.events.emit("OnNavFailed"); }
      this._waitRecheck = 0.5;
      return;
    }
    this.navWaiting = false;
    if (pat.mode === "nearest") {
      // Head to the closest AVAILABLE point, excluding the one we just left.
      const ox = this.sprite.gameObject.x, oy = this.sprite.gameObject.y;
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (i === pat.idx || !isAvail(i)) continue;
        const d = (pat.points[i].x - ox) ** 2 + (pat.points[i].y - oy) ** 2;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      // Only the current point left available → keep it (single-use already
      // excludes consumed, so this is the n=1 / last-standing case).
      if (bestI < 0 && isAvail(pat.idx)) bestI = pat.idx;
      pat.idx = bestI >= 0 ? bestI : pat.idx;
    } else {
      let guard = 0;
      do {
        if (n === 1) { pat.idx = 0; }
        else if (pat.mode === "random") { pat.idx = Math.floor(Math.random() * n); }
        else if (pat.mode === "pingpong") {
          pat.idx += pat.dir;
          if (pat.idx >= n) { pat.idx = n - 2; pat.dir = -1; }
          else if (pat.idx < 0) { pat.idx = 1; pat.dir = 1; }
        } else { pat.idx = (pat.idx + 1) % n; }
        guard++;
      } while (!isAvail(pat.idx) && guard <= n * 2 + 2);
    }
    const next = pat.points[Math.max(0, Math.min(n - 1, pat.idx))];
    const grid = this.sprite.scene?.data?.get("peaky.navGrid") as NavGrid | undefined;
    const path = grid ? findPath(grid, this.sprite.gameObject.x, this.sprite.gameObject.y, next.x, next.y) : null;
    // Claim the moment we commit, so a peer resuming in the SAME frame picks a
    // different point (no re-stacking when one bush frees and several wait).
    if (next?.id) claimNavPoint(this.sprite.scene, next.id, this.sprite.uid);
    if (path) { this.navPath = path; this._navIdx = 0; }
    else {
      // No route to the next point — stop the patrol cleanly instead of drifting.
      this.navPatrol = null; this.navPath = null; this._navIdx = 0; this._moving = false;
      this._setVelocity(0, 0);
      this.mode = "position"; this.targetX = this.sprite.gameObject.x; this.targetY = this.sprite.gameObject.y;
      this.sprite.events.emit("OnNavFailed");
    }
  }

  /** Nearest AVAILABLE waypoint matching the last nav request (claim + tile). */
  private _pickAvailablePoint(): NavWp | null {
    const scene = this.sprite.scene;
    const grid = scene?.data?.get("peaky.navGrid") as NavGrid | undefined;
    if (!grid || !scene) return null;
    const want = this.navWant;
    const ox = this.sprite.gameObject.x, oy = this.sprite.gameObject.y;
    let best: NavWp | null = null, bestD = Infinity;
    for (const w of grid.waypoints as NavWp[]) {
      if (!w.id || !isNavPointAvailable(scene, w as { id: string; singleUse?: boolean; srcMap?: string; srcX?: number; srcY?: number }, this.sprite.uid)) continue;
      if (want && w.name !== want && !(w.tags ?? []).includes(want)) continue;
      const d = (w.x - ox) ** 2 + (w.y - oy) ** 2;
      if (d < bestD) { bestD = d; best = w; }
    }
    return best;
  }

  /** Re-path a one-shot nav target after its point was consumed by another NPC. */
  private _retargetNavTarget(): void {
    const next = this._pickAvailablePoint();
    const grid = this.sprite.scene?.data?.get("peaky.navGrid") as NavGrid | undefined;
    const path = next && grid ? findPath(grid, this.sprite.gameObject.x, this.sprite.gameObject.y, next.x, next.y) : null;
    if (next && path) {
      this.navTarget = next; this.navPath = path; this._navIdx = 0;
    } else {
      this.navTarget = null; this.navPath = null; this._navIdx = 0; this._moving = false;
      this._setVelocity(0, 0);
      this.mode = "position"; this.targetX = this.sprite.gameObject.x; this.targetY = this.sprite.gameObject.y;
      this.sprite.events.emit("OnNavFailed");
    }
  }

  /** Push-apart pass — position correction enforcing min distance to
   *  same-tag siblings. Called from the TOP of update() so it runs even
   *  when MoveTo is disabled (chase-state stops at attack range etc.).
   *
   *  Damping factor of 0.35 (vs theoretical 0.5) deliberately UNDER-
   *  corrects per frame: a stationary NPC with multiple overlapping
   *  neighbors accumulates corrections from each neighbor; at 0.5 the
   *  sum can overshoot and the next tick over-corrects back → jitter.
   *  At 0.35, equilibrium is reached in 2-3 frames instead of 1 but
   *  with no oscillation. The trade-off is invisible at 60fps and
   *  removes the "glitch when stopped" the user reported.
   *
   *  Position is written directly to gameObject AND body.position so
   *  Phaser doesn't sync a stale value next frame. body.position is
   *  the source of truth when physics is enabled. */
  private _runPushApart(): void {
    const ox = this.sprite.gameObject.x;
    const oy = this.sprite.gameObject.y;
    const minDist = this.separationDist;
    const r2 = minDist * minDist;
    const neighbors = getNeighborsByTag(this.sprite.scene, this.separationTag, ox, oy, minDist);
    let dxC = 0;
    let dyC = 0;
    for (const n of neighbors) {
      if (n === this.sprite || n.destroyed) continue;
      const ndx = n.gameObject.x - ox;
      const ndy = n.gameObject.y - oy;
      const nd2 = ndx * ndx + ndy * ndy;
      // Skip exact-overlap (nd2 ≈ 0) — degenerate; would divide by zero.
      // Two NPCs at the SAME pixel are rare and will diverge once any
      // velocity is applied. Skipping here is preferable to picking an
      // arbitrary "split" direction (which would itself cause jitter).
      if (nd2 >= r2 || nd2 < 0.01) continue;
      const d = Math.sqrt(nd2);
      const overlap = minDist - d;
      dxC -= (ndx / d) * (overlap * 0.35);
      dyC -= (ndy / d) * (overlap * 0.35);
    }
    if (dxC !== 0 || dyC !== 0) {
      this.sprite.gameObject.x += dxC;
      this.sprite.gameObject.y += dyC;
      const body = this.sprite.body;
      if (body) {
        // body.position is top-left in Phaser arcade — use the property
        // directly to be explicit (body.x is just a getter alias).
        body.position.x += dxC;
        body.position.y += dyC;
      }
    }
  }

  /** Pick the nearest sprite carrying `targetTag`. Tag index + spatial
   *  grid intersection (via getNeighborsByTag) — only iterates sprites
   *  carrying the tag AND in cells near this MoveTo's host. For huge
   *  swarms (10K NPCs all running MoveTo `tag: player`), this drops the
   *  per-NPC cost from O(N) to ~O(1) because only the player matches
   *  the tag and the cell lookup is constant. */
  private _pickNearestByTag(ox: number, oy: number): Sprite | null {
    // First try a "near" query at 2000px (covers most chases). If empty,
    // fall back to the unbounded tag set — slower but guarantees a target
    // when one exists somewhere on the map.
    const NEAR_RADIUS = 2000;
    let candidates: Iterable<Sprite> = getNeighborsByTag(this.sprite.scene, this.targetTag, ox, oy, NEAR_RADIUS);
    if ((candidates as Sprite[]).length === 0) {
      candidates = getSpritesByTag(this.sprite.scene, this.targetTag);
    }
    let best: Sprite | null = null;
    let bestD2 = Infinity;
    for (const s of candidates) {
      if (s === this.sprite || s.destroyed) continue;
      const dx = s.gameObject.x - ox;
      const dy = s.gameObject.y - oy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  /** Write velocity to the appropriate output channel (physics body or
   *  direct position step). Direct mode integrates by dt so speed is
   *  consistent regardless of frame rate. */
  private _setVelocity(vx: number, vy: number): void {
    if (this.mirror && Math.abs(vx) > 0.5) {
      this.sprite.facingScaleX = this._absScale * (vx > 0 ? 1 : -1);
    }
    if (this.usePhysics) {
      const body = this.sprite.body;
      if (body) { body.setVelocityX(vx); body.setVelocityY(vy); }
    } else {
      // Direct integration — bypasses physics. The sprite walks through
      // colliders. Caller opted in to this with usePhysics=0.
      const dt = (this.sprite.scene.game.loop.delta || 16) / 1000;
      const go = this.sprite.gameObject as Phaser.GameObjects.GameObject & { x: number; y: number };
      go.x += vx * dt;
      go.y += vy * dt;
    }
  }
}
