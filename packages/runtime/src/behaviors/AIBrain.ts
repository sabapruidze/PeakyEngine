import type { Sprite } from "../Sprite";
import { getNeighborsByTag } from "../spatialGrid";
import { Behavior } from "../Behavior";

/**
 * Sense → Think → Act AI brain. Designed to live on NPC-class BPs alongside
 * CharacterMovement (drives the body), CharacterAnimator (visualizes the
 * state), and two Tracers — one named `sight` (long line, no damage, fires
 * on interval) and one named `attack` (short box, damage > 0, fires on
 * signal). The brain reads sight Tracer's `lastHit` to acquire a target,
 * picks an internal state (idle / alert / chase / search / attack / flee / rest),
 * and drives movement via `CharacterMovement.simulatedInputs` so AI-pushed
 * inputs behave identically to a player holding the same keys (coyote /
 * buffer / walljump intact).
 *
 * State emits `OnAIStateEnter_<name>` and `OnAIStateExit_<name>` signals on
 * the sprite's event bus, mirroring the animator's pattern. Logic Sheet
 * `OnAIStateEnter` triggers subscribe to these.
 */

type AIState = "idle" | "alert" | "chase" | "search" | "attack" | "flee" | "rest";

interface TracerLike {
  name?: string;
  lastHit?: {
    actorUid?: number;
    hitX?: number;
    hitY?: number;
    distance?: number;
  } | null;
}

interface CMWritable {
  simulatedInputs?: Set<string>;
  leftAction?: string;
  rightAction?: string;
  jumpAction?: string;
  maxSpeed?: number;
}

/** Subset of MoveTo's writable fields that AIBrain pushes onto each state
 *  change. Kept narrow on purpose — AIBrain owns when to chase / stop /
 *  flee, MoveTo handles HOW to move. */
interface MoveToLike {
  mode: "position" | "object" | "tag" | "angle";
  targetX: number | string;
  targetY: number | string;
  targetUid: number;
  angleDeg: number;
  speed: number;
  enabled: boolean;
  /** Separation params — AIBrain pushes its own separationDist /
   *  separationTag / separationAvoid / separationMode onto MoveTo so
   *  authors set them in ONE place (the brain) and they apply regardless
   *  of which mover is chosen. MoveTo's own UI for these still works for
   *  standalone use. */
  separationDist: number;
  separationTag: string;
  separationAvoid: number;
  separationMode: "off" | "velocity" | "push";
}

/** Movement-axis mode. Decided at attach time by which behavior is found
 *  on the host. Drives every "which direction inputs to emit" branch in
 *  `_act()`:
 *    - "platformer": MoveLeft / MoveRight only (X-axis chase, gravity-bound).
 *    - "topdown":    MoveLeft / MoveRight / MoveUp / MoveDown (diagonal
 *                    chase, 4-way patrol). */
type MoveMode = "platformer" | "topdown" | "moveto" | "none";

/** Explicit mover choice from the AIBrain inspector. "auto" preserves the
 *  legacy resolve-by-presence behavior (CharacterMovement → TopdownMovement
 *  → none); the other values pin the mover so a sprite carrying multiple
 *  movement behaviors picks the right one. */
type AIMoverChoice = "auto" | "CharacterMovement" | "TopdownMovement" | "MoveTo";

export class AIBrain extends Behavior {
  kind = "AIBrain";

  /** Current AI state. Read-only externally — flip via SetAIState. */
  state: AIState = "idle";
  /** Last state transitioned out of. */
  prevState: AIState | "" = "";

  // ─── Sense config ───────────────────────────────────────────────
  /** Tag of pursuit target (typically "player"). */
  targetTag = "player";
  /** Comma-separated list of Tracer.name values that count as sight
   *  perception. Any of them reporting a hit locks the target. The
   *  default NPC ships with ONE sight tracer centered on the host
   *  (distance=400, pivotX=-200) — covers both sides because pivot AND
   *  direction multiply by facingSign. The default matches legacy
   *  "sight_forward" / "sight_behind" names too so NPCs created before
   *  the consolidation keep working without manual surgery. */
  sightTracerName = "sight,sight_forward,sight_behind";
  /** Comma-separated list of signal names that trigger alert (hearing). */
  hearSignals = "";

  // ─── Think config ───────────────────────────────────────────────
  /** Seconds without target sight before search → idle. */
  loseSightAfterSec = 2.5;
  /** Distance at which chase upgrades to attack. State is purely
   *  condition-driven: |target.x - self.x| <= attackRange → attack;
   *  otherwise → chase. No timers. Animator's attack state plays the
   *  anim while we're in `attack`. */
  attackRange = 40;
  /** Min seconds between the START of consecutive attack swings. This is
   *  the "attack interval" — the NPC can't begin another swing until this
   *  long after the last one started.
   *
   *  Two regimes, decided by `attackDurationSec`:
   *   • `attackDurationSec = 0` (legacy continuous): the brain stays in
   *     `attack` while the target's in range and RE-EMITS the attack
   *     signal every `attackCooldownSec` (steady stream of hits).
   *   • `attackDurationSec > 0` (discrete swings): the brain attacks for
   *     `attackDurationSec`, drops to `alert` to rest, and re-attacks
   *     only once `attackCooldownSec` has elapsed since the swing began —
   *     producing an attack → idle → attack rhythm. */
  attackCooldownSec = 0.8;
  /** Length of ONE attack swing in seconds. 0 = legacy continuous attack
   *  (stay in `attack` while in range). > 0 = discrete swings: the brain
   *  holds `attack` for this long (the swing / wind-up + recover), then
   *  drops to `alert` and rests until `attackCooldownSec` allows the next
   *  swing. Set this to roughly your attack animation's length, and set
   *  `attackCooldownSec` to the total desired interval between swings. */
  attackDurationSec = 0;
  /** Which AI state the NPC sits in DURING the attack interval (the rest
   *  between swings, after a swing ends and before `attackCooldownSec`
   *  elapses). Default "alert". Pick any state — "idle" (stand and breathe),
   *  "chase" (keep pressuring while it recharges), "alert" (combat-ready
   *  stance), etc. The chosen state drives the animator via IsAIState during
   *  the gap, then the brain swings again once the cooldown allows. Only
   *  applies in discrete-swing mode (`attackDurationSec > 0`). */
  attackRestState: AIState = "alert";
  /** When 1 (default), taking a hit DURING an attack swing interrupts it —
   *  the NPC staggers out of `attack` into `alert` so it can re-orient and
   *  re-engage. Set to 0 for "super armor": the NPC powers through hits and
   *  finishes its swing regardless (bosses, heavy enemies). Overridden by
   *  `fleeOnDamage` (flee wins when both apply). */
  interruptAttackOnHit = 1;
  /** When true, OnDamageTaken flips state to flee for `fleeDurationSec`. */
  fleeOnDamage = 0;
  /** Seconds spent in flee state before returning to alert. */
  fleeDurationSec = 3;
  /** Patrol mode while idle. "none" = stand still; "walls" = bounce. */
  patrolMode = "none";
  /** Omnidirectional awareness radius. When > 0, ANY sprite carrying
   *  `targetTag` within this distance is auto-locked as the target —
   *  regardless of facing or sight Tracer. This is the "hearing /
   *  presence sense" the user needs so a player behind the NPC still
   *  registers. After the lock, the NPC turns to face it (via
   *  `autoFaceTarget`), and the sight Tracer takes over for the longer
   *  chase. 0 = off (sight Tracer alone). */
  detectionRadius = 0;
  /** When true, AIBrain flips the sprite's facing each tick so the
   *  NPC always looks at its current target. Cheap and reliable —
   *  the sight Tracer fires in the facing direction, so this keeps it
   *  pointed at the right thing. Off = facing controlled externally
   *  (Logic Sheet, animator, or just left to CharacterMovement mirror). */
  autoFaceTarget = 1;
  /** When 1 (default), the built-in sense→think→act loop runs and
   *  auto-transitions states (idle → alert → chase → attack / search / flee).
   *  When 0, the brain only SENSES (target lock + edge signals) and ACTS
   *  (writes simulatedInputs from current state). State transitions are
   *  left entirely to Logic Sheet — drop `SetAIState` actions on
   *  `OnTargetSighted` / `OnTargetLost` / `OnCollide` etc. to author your
   *  own AI logic without touching TS. The default "Enemy brain" template
   *  recreates the built-in flow as a starting point. */
  autoBrain = 1;
  /** When 1 (default), the brain halts the moment Damageable reports
   *  hp ≤ 0 OR isDead — skips sense/think/act and clears simulatedInputs
   *  so CharacterMovement stops driving the body. Lets the death anim
   *  play uninterrupted and keeps the corpse from sliding / attacking
   *  during deathDestroyDelay. Turn off if you want zombie behavior
   *  (NPC keeps acting at 0 hp). */
  disableWhenDead = 1;
  /** Sense + Think frequency divisor. 1 = run every frame (60Hz at
   *  60fps), 3 = every 3rd frame (20Hz — the default for typical NPCs),
   *  6 = every 6th frame (10Hz — patrol wildlife), 10 = every 10th frame
   *  (6Hz — distant lazy NPCs). The brain still ACTS every frame so
   *  movement stays smooth — only the expensive sight scan + state-
   *  decision logic is throttled. Reaction time worst-case is
   *  `(aiTickRate / 60) seconds`. Bumping to 3 gives ~3× CPU savings on
   *  the brain at the cost of ~50ms peak reaction lag — invisible for
   *  swarm enemies, possibly noticeable for combat-twitchy bosses (set
   *  to 1 for those). */
  aiTickRate = 3;
  /** Which movement behavior drives this NPC. Picked explicitly in the
   *  inspector so a BP carrying multiple movement chips (rare but
   *  possible) doesn't quietly pick one.
   *   - "auto"             — try CharacterMovement first, then TopdownMovement
   *                          (legacy default for existing BPs).
   *   - "CharacterMovement" — platformer locomotion. Drives via simulatedInputs.
   *   - "TopdownMovement"   — 4-way RPG locomotion. Drives via simulatedInputs.
   *   - "MoveTo"            — high-level steering. AIBrain pushes its current
   *                          target / patrol direction onto MoveTo's mode +
   *                          targetUid + speed each tick instead of driving
   *                          inputs. Useful for swarm NPCs that already use
   *                          MoveTo for chase and just want AIBrain's state
   *                          machine (sight, attack, flee) on top.
   */
  mover: AIMoverChoice = "auto";

  // ─── Act config ─────────────────────────────────────────────────
  /** Minimum gap (px) this NPC keeps from same-tag siblings. When another
   *  sprite carrying `separationTag` is within this radius, AIBrain
   *  overrides its movement to push AWAY (lateral). Stops multiple NPCs
   *  from stacking exactly on the player's x while chasing. 0 = off. */
  separationDist = 0;
  /** Tag identifying siblings to space against. Default "enemy" so the
   *  out-of-the-box NPC keeps gap from other enemy-tagged NPCs. Empty
   *  string scans against every sprite (rare; usually leave at "enemy"). */
  separationTag = "enemy";
  /** When a same-tag sibling is in the chase path, what to do:
   *   0 (default) — STOP. Hold position until the blocker clears.
   *   1           — AVOID. Slide perpendicular to the blocker, picking
   *                 the side that keeps us moving toward target. NPCs
   *                 flow around obstacles in topdown mode. In platformer
   *                 mode, falls back to STOP (no good vertical avoidance
   *                 path in gravity-bound 2D). */
  separationAvoid = 0;
  /** How separation enforces spacing when mover = MoveTo. Pushed onto
   *  MoveTo every tick from _driveMoveTo so the author picks the mode
   *  here on the brain and it applies wherever the chase logic runs.
   *  See MoveTo.separationMode for mode semantics.
   *
   *  Has no effect when mover = CharacterMovement / TopdownMovement —
   *  those movers use AIBrain's own STOP-mode separation block below
   *  (legacy, no velocity blend / push support — they steer via
   *  simulatedInputs, not velocity, so the blend math doesn't apply). */
  separationMode: "off" | "velocity" | "push" = "push";
  /** Move speed when chasing. */
  chaseSpeed = 100;
  /** Move speed during idle/patrol. */
  patrolSpeed = 40;
  /** Tracer.name fired on attack-state entry. */
  attackTracerName = "attack";

  // ─── Internal book-keeping ──────────────────────────────────────
  /** Currently locked target uid. -1 = no target. */
  targetUid = -1;
  /** Sim clock at last successful sight. -Infinity = never. */
  private _lastSightedAt = -Infinity;
  /** Sim clock at last attack. */
  private _lastAttackAt = -Infinity;
  /** True while in the post-swing rest interval — the NPC holds
   *  `attackRestState` and re-attacks only once `attackCooldownSec` elapses.
   *  Cleared when it swings again or the target leaves range/sight. */
  private _resting = false;
  /** Set true once the attack animation has actually started playing this
   *  swing (SpriteRenderer reports it as NOT finished). Used to detect the
   *  anim's finish edge so the swing ends exactly when the anim does —
   *  guards against reading a stale `finishedEmitted` from the prior anim. */
  private _attackAnimStarted = false;
  /** Continuous-mode (attackDurationSec 0) full-swing cycle: set true once the
   *  attack's OUT clip is actually playing in the rest state (SpriteRenderer
   *  NOT finished). Lets the brain wait for the OUT to finish before the next
   *  swing — same stale-flag guard as `_attackAnimStarted`, for the out phase. */
  private _outAnimStarted = false;
  /** Sim clock entered current state. */
  private _enteredAt = 0;
  /** Internal monotonic clock (delta-accumulated). */
  private _now = 0;
  /** Per-NPC frame offset for the aiTickRate throttle. Each AIBrain
   *  starts on a random sub-tick phase so 5000 enemies don't all sense
   *  + think on the SAME frame — that would cause periodic frame spikes
   *  (every Nth frame slow). Random stagger evens the load across the
   *  N-frame window. Set in init() from the sprite uid (cheap, deterministic
   *  enough — uids are monotonic so consecutive spawns hit different phases). */
  private _tickPhase = 0;
  /** Scene frame counter snapshot for `_tickPhase % aiTickRate` checks.
   *  Cheaper than reading scene.game.loop.frame on every tick. */
  private _frame = 0;
  /** Last patrol direction sign (-1 or +1) on the X axis. */
  private _patrolDir: -1 | 1 = 1;
  /** Last patrol direction sign on the Y axis (topdown mode only). */
  private _patrolDirY: -1 | 1 = 1;
  /** Detected movement mode. Decides whether the brain emits 2-axis or
   *  4-axis simulated inputs and which body collision flags to check for
   *  wall-bounce. Resolved at the start of every `_act()` (cheap — just
   *  a behavior lookup) so swapping movement behaviors at runtime is
   *  picked up automatically. */
  private _moveMode: MoveMode = "none";
  /** Stop-on-arrival deadband (px) in topdown chase mode. Without it the
   *  NPC oscillates: at dx=0 it picks Left; the next tick dx flips sign
   *  by half a pixel from movement → picks Right → repeats forever. Empty
   *  band stops emission near zero so the NPC settles on-target. */
  private readonly _topdownDeadband = 2;

  /** Unsubscribers returned from this.sprite.events.on(). Called in
   *  onDestroy so destroyed brains don't keep firing handlers — without
   *  this, EventBus held references to the brain via captured `this`,
   *  preventing GC and leaking timers on every sprite recycle.
   *  (audit HIGH #26, #28, #29) */
  private _unsubs: Array<() => void> = [];

  init(): void {
    this._enteredAt = 0;
    this._tickPhase = this.sprite.uid % 32;
    this.sprite.events.emit(`OnAIStateEnter_${this.state}`);
    this.sprite.events.emit("OnAIStateEnter");
    const sigs = this.hearSignals.split(",").map((s) => s.trim()).filter(Boolean);
    for (const sig of sigs) {
      this._unsubs.push(this.sprite.events.on(sig, () => this.alertFrom(this.sprite.gameObject.x, this.sprite.gameObject.y)));
    }
    this._unsubs.push(this.sprite.events.on("OnDamageTaken", () => {
      if (this.fleeOnDamage) this.transitionTo("flee");
      else if (this.interruptAttackOnHit && this.state === "attack") this.transitionTo("alert");
    }));
  }

  onDestroy(): void {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }

  /** Save: persist enough AI state that mid-chase / mid-attack NPCs resume
   *  in the same state on Load instead of resetting to idle. Timers reset
   *  on load (per the save-policy convention for in-flight effects) so a
   *  saved attack cooldown won't carry over. (audit HIGH #27) */
  serialize(): Record<string, unknown> | undefined {
    return {
      state: this.state,
      prevState: this.prevState,
      targetUid: this.targetUid,
    };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.state === "string") this.state = state.state as AIState;
    if (typeof state.prevState === "string") this.prevState = state.prevState as AIState | "";
    if (typeof state.targetUid === "number") this.targetUid = state.targetUid;
  }

  update(delta: number): void {
    if (this.sprite.destroyed) return;
    const dt = delta / 1000;
    this._now += dt;

    // Halt when dead — animator's death state plays uninterrupted and
    // the body stops being driven. simulatedInputs cleared so CharacterMovement
    // doesn't keep walking the corpse mid-deathDestroyDelay window.
    // ALSO transition state to "idle" so animator conditions tied to
    // `isAIState chase` / `isAIState attack` stop matching — otherwise
    // the chase / run anim keeps winning over death because the brain's
    // state stays frozen at "chase".
    if (this.disableWhenDead) {
      const d = this.sprite.findBehaviorByKind("Damageable") as { hp?: number; isDead?: boolean } | undefined;
      if (d && ((d.hp ?? 1) <= 0 || d.isDead)) {
        this._resolveMovement().mover?.simulatedInputs?.clear();
        if (this.state !== "idle") this.transitionTo("idle");
        return;
      }
    }
    // Hitstun gate — the brain stops sensing / acting while the host is
    // in hitstun so AIBrain doesn't push fresh simulatedInputs that
    // wipe the knockback velocity Damageable just applied. Inputs are
    // cleared once so the character animator's hurt anim is the only
    // motion visible during the stun window.
    const dmg = this.sprite.findBehaviorByKind("Damageable") as { isInHitstun?: () => boolean } | undefined;
    if (dmg?.isInHitstun?.()) {
      this._resolveMovement().mover?.simulatedInputs?.clear();
      return;
    }
    // StateMachine gate — hitstunSec is often shorter than the visible
    // hurt animation, so AIBrain would wake up mid-stagger and push
    // fresh transitions / inputs while the hurt anim is still on
    // screen. Tie the gate to the state config's `pausesAI` flag —
    // authors tick it on hurt/death/stunned states in the inspector.
    // Name-independent so renames don't break the gate.
    const sm = this.sprite.findBehaviorByKind("StateMachine") as {
      currentState?: string;
      states?: Array<{ name: string; pausesAI?: boolean }>;
    } | undefined;
    const currentStateName = sm?.currentState ?? "";
    const currentStateDef = currentStateName ? sm?.states?.find((s) => s.name === currentStateName) : undefined;
    if (currentStateDef?.pausesAI) {
      this._resolveMovement().mover?.simulatedInputs?.clear();
      return;
    }

    // Sense + Think throttling. Big perf win at high enemy counts: most
    // NPCs don't need to re-decide their state every 16ms. Rate=3 means
    // sense + think runs every 3rd frame (20Hz) while _act still runs
    // every frame for smooth movement. Per-NPC `_tickPhase` staggers the
    // load so the work spreads evenly across the N-frame window instead
    // of all NPCs running on the same frame (which would cause periodic
    // big spikes).
    this._frame += 1;
    const rate = Math.max(1, Math.floor(this.aiTickRate));
    const shouldThink = ((this._frame + this._tickPhase) % rate) === 0;
    if (!shouldThink) {
      // Still ACT every frame — the chase/patrol simulatedInputs from the
      // last think still drive movement smoothly. Decision lags by up to
      // (rate / 60) seconds; movement does not.
      this._act();
      return;
    }

    // 1. SENSE — read sight tracer + (when configured) omnidirectional
    // radius scan. The radius scan is what lets the NPC "feel" a player
    // standing behind it: no facing-aware Tracer would hit, but the
    // radius check fires regardless of facing.
    // Single source of truth: push `targetTag` onto the sight tracer(s) so the
    // author only sets the tag ONCE (on the brain), not also on the tracer.
    this._syncSightTracerTag();
    let sightHit = this._readSightHit();
    // Defensive: even with the sync, reject a sight hit whose actor doesn't
    // carry `targetTag` (stale tracer config, multi-tag tracer, timing).
    if (sightHit && this.targetTag && !this._sightActorHasTargetTag(sightHit.actorUid)) {
      sightHit = null;
    }
    if (!sightHit && this.detectionRadius > 0) {
      const nearest = this._nearestTargetInRadius(this.detectionRadius);
      if (nearest) {
        sightHit = { actorUid: nearest.uid } as NonNullable<TracerLike["lastHit"]>;
      }
    }
    const hadTarget = this.targetUid !== -1;
    const wasRecentlySighted = (this._now - this._lastSightedAt) < 0.2;
    // Skip sight hits whose target has Damageable.attackable = 0. Without
    // this filter the brain re-locks onto an "untargetable" actor every
    // tick the sight tracer hits their (still-existing) body, defeating
    // the attackable=0 drop in `_target()`. Missing Damageable / missing
    // field defaults to attackable.
    let sightActorUnattackable = false;
    if (sightHit && sightHit.actorUid !== undefined && sightHit.actorUid !== null) {
      const list = this.sprite.scene.data.get("peaky.sprites") as Array<{ uid: number; findBehaviorByKind?: (k: string) => unknown }> | undefined;
      const hitSpr = list?.find((s) => s.uid === sightHit!.actorUid);
      const d = hitSpr?.findBehaviorByKind?.("Damageable") as { attackable?: number } | undefined;
      if (d && d.attackable === 0) sightActorUnattackable = true;
    }
    if (sightHit && sightHit.actorUid !== undefined && sightHit.actorUid !== null && !sightActorUnattackable) {
      const newSight = !hadTarget || !wasRecentlySighted;
      this.targetUid = sightHit.actorUid;
      this._lastSightedAt = this._now;
      // IMMEDIATE facing flip — the moment a sight tracer reports a hit,
      // turn toward the hit's actual x position. Doesn't wait for state
      // machine. Simple rule: if hit.x < self.x then mirror, else don't.
      // Skip when dead so a corpse doesn't flip toward a player walking
      // around it. Independent of `disableWhenDead` (which gates the
      // whole brain) — the facing flip on a corpse is always wrong even
      // if the rest of the brain stays live for animation/state reasons.
      if (this.autoFaceTarget && typeof sightHit.hitX === "number" && !this._isDead() && !this._facingLocked()) {
        const dx = sightHit.hitX - this.sprite.gameObject.x;
        if (Math.abs(dx) > 1) {
          (this.sprite as unknown as { facingScaleX: number }).facingScaleX = dx < 0 ? -1 : 1;
        }
      }
      // Edge-emit: fires once when we first see (or re-sight) the target.
      if (newSight) {
        this.sprite.events.emit("OnTargetSighted");
      }
    } else if (hadTarget && wasRecentlySighted) {
      // Just lost sight this tick — emit once.
      // Re-check next tick: wasRecentlySighted will be false until next sight.
      // The transition only fires once because _lastSightedAt isn't updated.
      // (We use the 0.2s window above so brief 1-frame Tracer misses don't
      // spam OnTargetLost. The state machine's loseSightAfterSec handles the
      // proper search→idle decay separately.)
    }
    // Standalone "lost" edge: fire when more than 0.5s without a sight.
    if (hadTarget && (this._now - this._lastSightedAt) >= 0.5 && (this._now - this._lastSightedAt) < 0.5 + (delta / 1000)) {
      this.sprite.events.emit("OnTargetLost");
    }

    // 2. THINK — decide state (only when autoBrain is on; otherwise
    //    Logic Sheet drives transitions via SetAIState).
    if (this.autoBrain) this._think();

    // 3. ACT — push movement / fire attacks
    this._act();
  }

  /** Programmatically set the state (used by Logic Sheet SetAIState). */
  setState(next: AIState): void {
    this.transitionTo(next);
  }

  /** Alert this NPC from a stimulus at (x, y). Skips if already engaged. */
  alertFrom(_x: number, _y: number): void {
    if (this.state === "attack" || this.state === "chase") return;
    this.transitionTo("alert");
  }

  private _readSightHit(): NonNullable<TracerLike["lastHit"]> | null {
    // Read every Tracer attached to the host whose name appears in
    // `sightTracerName` (comma-sep allow-list). When multiple report
    // hits this tick, pick the closest one — keeps target acquisition
    // intuitive when forward + behind tracers both fire.
    const names = this.sightTracerName.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return null;
    const tracers = (this.sprite as unknown as { findBehaviorsByKind?: (k: string) => TracerLike[] }).findBehaviorsByKind?.("Tracer") ?? [];
    let best: NonNullable<TracerLike["lastHit"]> | null = null;
    let bestDist = Infinity;
    for (const t of tracers) {
      if (!t.name || !names.includes(t.name)) continue;
      const hit = t.lastHit;
      if (!hit) continue;
      const d = typeof hit.distance === "number" ? hit.distance : 0;
      if (d < bestDist) { bestDist = d; best = hit; }
    }
    return best;
  }

  /** True if the sight-hit actor carries the brain's `targetTag` — so the
   *  brain only locks targets matching `targetTag`, regardless of what the
   *  sight Tracer's own tagFilter let through. A not-found actor returns true
   *  (fail-open) so transient lookups don't drop a valid target. */
  private _sightActorHasTargetTag(uid: number | undefined | null): boolean {
    if (uid === undefined || uid === null) return true;
    const list = this.sprite.scene.data.get("peaky.sprites") as Array<{ uid: number; tags?: Set<string> }> | undefined;
    const s = list?.find((x) => x.uid === uid);
    if (!s) return true;
    return !!s.tags?.has(this.targetTag);
  }

  /** Push the brain's `targetTag` onto its sight tracer(s)' `tagFilter`, so the
   *  author sets the target tag in ONE place (the brain) and the tracer follows
   *  — no need to keep the two in sync by hand. Only when `targetTag` is set;
   *  an empty targetTag leaves the tracer's own filter alone (advanced use). */
  private _syncSightTracerTag(): void {
    if (!this.targetTag) return;
    const names = this.sightTracerName.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    const tracers = (this.sprite as unknown as { findBehaviorsByKind?: (k: string) => Array<{ name?: string; tagFilter?: string }> }).findBehaviorsByKind?.("Tracer") ?? [];
    for (const t of tracers) {
      if (t.name && names.includes(t.name) && t.tagFilter !== this.targetTag) t.tagFilter = this.targetTag;
    }
  }

  /** Omnidirectional radius scan — used as the "presence sense" when
   *  `detectionRadius > 0`. Walks the scene's sprite list, picks the
   *  nearest sprite carrying `targetTag` within `radius`. Independent
   *  of facing, so the NPC can sense players behind / above / below. */
  private _nearestTargetInRadius(radius: number): { uid: number; x: number; y: number } | null {
    // Tag index + spatial grid intersection. Three-stage cost descent:
    //   (1) baseline:            O(N)        — scan all peaky.sprites
    //   (2) Phase 1 tag-index:   O(tagSize)  — scan only tagged sprites
    //   (3) Phase 2 + 3 grid:    O(cellSize) — scan only tagged sprites
    //                                            in cells overlapping the
    //                                            query radius.
    // getNeighborsByTag auto-picks (2) vs (3) based on which set is
    // smaller — common case "find rare-tag player" goes through path (2),
    // common case "find any of 5000 enemy-tagged sprites within sight"
    // goes through path (3).
    const ox = this.sprite.gameObject.x;
    const oy = this.sprite.gameObject.y;
    const candidates = getNeighborsByTag(this.sprite.scene, this.targetTag, ox, oy, radius);
    if (candidates.length === 0) return null;
    const r2 = radius * radius;
    let best: { uid: number; x: number; y: number; d2: number } | null = null;
    for (const s of candidates) {
      if (s.destroyed) continue;
      if (s.uid === this.sprite.uid) continue;
      const sx = s.gameObject?.x;
      const sy = s.gameObject?.y;
      if (typeof sx !== "number" || typeof sy !== "number") continue;
      const dx = sx - ox;
      const dy = sy - oy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (!best || d2 < best.d2) best = { uid: s.uid, x: sx, y: sy, d2 };
    }
    return best ? { uid: best.uid, x: best.x, y: best.y } : null;
  }

  private _think(): void {
    // Lost target — drop targetUid after search timeout.
    const sinceSight = this._now - this._lastSightedAt;

    // ── Target deliberately gone → idle NOW (not chase/search) ─────────────
    // `_target()` clears `targetUid` to -1 the instant the target is destroyed
    // OR made untargetable (Damageable.attackable=0 — e.g. a dialogue cutscene
    // disabling the player). chase/search exist to RELOCATE a target we still
    // remember (out of sight but alive); with NO remembered target they just
    // mill around for `loseSightAfterSec` before idling. So when targetUid is
    // cleared, abandon combat immediately. (Resolving `_target()` here also
    // performs the clear this same tick, so disengage is instant.)
    if (this._target() === null && this.targetUid === -1
        && this.state !== "idle" && this.state !== "flee") {
      this._resting = false;
      this.transitionTo("idle");
      return;
    }

    // ── Attack-interval rest gate ──────────────────────────────────────────
    // After a discrete swing, the NPC sits in the author-chosen
    // `attackRestState` for the whole `attackCooldownSec` interval — this
    // OVERRIDES that state's normal logic so "idle"/"chase"/"alert"/etc. all
    // behave as the rest pose between swings. It swings again only when the
    // cooldown elapses AND the target is still in range; if the target leaves
    // range or sight, rest ends and normal chase/search resumes.
    if (this._resting && this.attackDurationSec > 0) {
      if (sinceSight > this.loseSightAfterSec) {
        this._resting = false;
        this.transitionTo("search");
      } else {
        const target = this._target();
        const dist = target ? this._distToTarget(target) : Infinity;
        if (dist > this.attackRange) {
          this._resting = false;
          this.transitionTo(sinceSight < 0.5 ? "chase" : "search");
        } else if (this._now - this._lastAttackAt >= this.attackCooldownSec) {
          this._resting = false;
          this.transitionTo("attack");
        } else {
          // Still resting — hold the chosen state; its own _act() drives
          // whatever movement that state implies (idle stands, chase presses).
          return;
        }
      }
    }

    // ── Continuous full-swing cycle (attackDurationSec 0) ───────────────────
    // A swing just finished its MAIN anim and we dropped to the rest state so
    // the animator plays the attack's OUT clip. Re-enter `attack` once that OUT
    // anim finishes — so the recover plays fully before the next windup — for a
    // seamless in→main→out→in… cycle. If the state has no OUT clip (the OUT
    // never starts), a short cap re-attacks so the NPC never sticks in rest.
    if (this._resting && this.attackDurationSec === 0) {
      if (sinceSight > this.loseSightAfterSec) {
        this._resting = false;
        this.transitionTo("search");
      } else {
        const target = this._target();
        const dist = target ? this._distToTarget(target) : Infinity;
        if (dist > this.attackRange) {
          this._resting = false;
          this.transitionTo(sinceSight < 0.5 ? "chase" : "search");
        } else {
          const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as { finishedEmitted?: boolean } | undefined;
          const fin = sr?.finishedEmitted === true;
          if (!fin) this._outAnimStarted = true;
          const outDone = this._outAnimStarted && fin;
          // Re-attack as soon as the OUT finishes. Two safety nets so the NPC
          // can never stick in rest: `noOutCap` re-attacks quickly when no OUT
          // clip ever started, and `hardCap` bounds the pathological case (no
          // OUT + a looping rest-state anim, where `_outAnimStarted` latches but
          // never finishes). A real OUT clip under 3s always wins via `outDone`.
          const noOutCap = !this._outAnimStarted && this._now - this._enteredAt >= 0.3;
          const hardCap = this._now - this._enteredAt >= 3.0;
          const cooldownOk = this._now - this._lastAttackAt >= this.attackCooldownSec;
          if ((outDone || noOutCap || hardCap) && cooldownOk) {
            this._resting = false;
            this.transitionTo("attack");
          } else {
            return;
          }
        }
      }
    }

    switch (this.state) {
      case "idle": {
        if (this.targetUid !== -1 && sinceSight < 0.2) this.transitionTo("alert");
        break;
      }
      case "alert": {
        // Alert doubles as the attack-REST state in discrete-swing mode.
        // If the target is still in attack range, hold here (idle/alert
        // pose) until `attackCooldownSec` since the last swing started,
        // then swing again — this is the gap between attacks. Out of
        // range (or after the brief default delay): resume chase/search.
        if (sinceSight > this.loseSightAfterSec) { this.transitionTo("search"); break; }
        if (this.attackDurationSec > 0) {
          const target = this._target();
          const dist = target ? this._distToTarget(target) : Infinity;
          if (dist <= this.attackRange) {
            // Resting in range — re-attack once the interval has elapsed.
            if (this._now - this._lastAttackAt >= this.attackCooldownSec) {
              this.transitionTo("attack");
            }
            break; // else keep resting (idle pose) this tick
          }
          // Target left range mid-rest — chase it down.
          if (this._now - this._enteredAt > 0.4) {
            this.transitionTo(sinceSight < 0.5 ? "chase" : "search");
          }
          break;
        }
        // Legacy: brief stand, then chase if still visible.
        if (this._now - this._enteredAt > 0.4) {
          if (sinceSight < 0.5) this.transitionTo("chase");
          else this.transitionTo("search");
        }
        break;
      }
      case "chase": {
        if (sinceSight > this.loseSightAfterSec) {
          this.transitionTo("search");
          break;
        }
        // In range → attack, BUT honor the attack interval: only swing once
        // `attackCooldownSec` has elapsed since the last swing began. If the
        // cooldown isn't ready yet, rest in `alert` (which re-gates on the
        // same cooldown) instead of attacking instantly — otherwise a target
        // that bounces in/out of range lets the NPC bypass the interval by
        // re-entering attack through chase every time. First contact still
        // fires immediately (`_lastAttackAt` starts at -Infinity).
        const target = this._target();
        if (target) {
          const dist = this._distToTarget(target);
          if (dist <= this.attackRange) {
            if (this._now - this._lastAttackAt >= this.attackCooldownSec) {
              this.transitionTo("attack");
            } else {
              // In range but cooldown not ready → rest in the chosen state.
              this.transitionTo(this.attackRestState);
              this._resting = true;
            }
          }
        }
        break;
      }
      case "search": {
        if (sinceSight < 0.2) {
          this.transitionTo("chase");
        } else if (this._now - this._enteredAt > this.loseSightAfterSec) {
          this.targetUid = -1;
          this.transitionTo("idle");
        }
        break;
      }
      case "attack": {
        // Stay in attack while still in range AND target visible. Animator
        // plays the attack anim during this window. The moment target
        // moves out of attackRange (or sight lost), drop back to chase.
        if (sinceSight > this.loseSightAfterSec) {
          this.transitionTo("search");
          break;
        }
        const target = this._target();
        if (!target) {
          this.transitionTo("chase");
          break;
        }
        const dist = this._distToTarget(target);
        if (dist > this.attackRange) {
          this.transitionTo("chase");
          break;
        }
        // Discrete-swing mode: ONE swing = one play of the attack animation.
        // End the swing the moment the attack anim FINISHES (so it plays
        // exactly once, no frozen last frame), then drop into the chosen
        // `attackRestState`. `attackDurationSec` is only a safety cap for
        // looping/never-finishing anims — the anim-finish is the real driver,
        // so authors don't have to hand-match a duration to the clip length.
        // Swing ends when the MAIN attack anim finishes — for BOTH continuous
        // (attackDurationSec 0) and discrete (>0). Drop to the rest state so the
        // animator plays the OUT clip; the rest gates above re-enter `attack`
        // for the next swing (discrete waits attackCooldownSec; continuous waits
        // for the OUT anim to finish). Without this, continuous mode sat in
        // `attack` forever and a one-shot anim froze on its last frame, never
        // playing OUT. A LOOPING attack anim never emits `finished`, so
        // channeled attacks stay continuous; `attackDurationSec` remains a
        // safety cap for never-finishing anims in discrete mode.
        {
          const sr = this.sprite.findBehaviorByKind("SpriteRenderer") as { finishedEmitted?: boolean } | undefined;
          const fin = sr?.finishedEmitted === true;
          // Wait until we've seen the attack anim actually playing (fin=false)
          // before trusting a finish edge — avoids a stale finished flag from
          // the prior anim ending the swing on frame 1.
          if (!fin) this._attackAnimStarted = true;
          const animDone = this._attackAnimStarted && fin;
          const durationCap = this.attackDurationSec > 0 && this._now - this._enteredAt >= this.attackDurationSec;
          if (animDone || durationCap) {
            this._outAnimStarted = false;
            this.transitionTo(this.attackRestState);
            this._resting = true;
          }
        }
        break;
      }
      case "flee": {
        if (this._now - this._enteredAt > this.fleeDurationSec) {
          this.transitionTo("alert");
        }
        break;
      }
    }
  }

  private _act(): void {
    // Auto-face the target before deciding movement. Cheap and reliable —
    // the sight Tracer fires in the facing direction, so this keeps it
    // pointed at the right thing. Skipped when autoFaceTarget is off,
    // and ALSO skipped when dead so a corpse doesn't flip to track the
    // player walking around it.
    if (this.autoFaceTarget && !this._isDead() && !this._facingLocked()) {
      const target = this._target();
      if (target) {
        const dx = target.x - this.sprite.gameObject.x;
        if (Math.abs(dx) > 1) {
          (this.sprite as unknown as { facingScaleX: number }).facingScaleX = dx < 0 ? -1 : 1;
        }
      }
    }
    const { mover: cm, mode } = this._resolveMovement();
    if (!cm) return;
    this._moveMode = mode;
    // MoveTo branch — fundamentally different driving model. MoveTo doesn't
    // accept simulatedInputs; it owns its own target + mode + speed. So
    // instead of writing inputs, AIBrain pushes its desired locomotion
    // onto MoveTo's fields based on the current AI state. The MoveTo
    // behavior then handles the actual chase / steering / separation per
    // its own logic.
    if (mode === "moveto") {
      this._driveMoveTo(cm as unknown as MoveToLike);
      return;
    }
    // Ensure simulatedInputs exists (older configs may not have it).
    if (!cm.simulatedInputs) cm.simulatedInputs = new Set<string>();
    const sim = cm.simulatedInputs;
    // Always clear ALL four direction inputs at the top — even in platformer
    // mode, an Up / Down lingering in the set (set externally by Logic Sheet
    // or a prior tick in topdown mode that swapped to platformer) would
    // confuse downstream consumers.
    sim.delete("MoveLeft");
    sim.delete("MoveRight");
    sim.delete("MoveUp");
    sim.delete("MoveDown");

    const target = this._target();
    const ox = this.sprite.gameObject.x;
    const oy = this.sprite.gameObject.y;
    switch (this.state) {
      case "idle": {
        if (this.patrolMode === "walls") {
          // Auto wall-bounce: read Phaser body's blocked/touching flags
          // and flip patrol direction when we hit a wall. No Logic
          // Sheet wiring required — the brain owns the bounce.
          const body = (this.sprite as unknown as { body?: { blocked?: { left?: boolean; right?: boolean; up?: boolean; down?: boolean }; touching?: { left?: boolean; right?: boolean; up?: boolean; down?: boolean } } }).body;
          if (body) {
            const hitLeft  = body.blocked?.left  || body.touching?.left;
            const hitRight = body.blocked?.right || body.touching?.right;
            if (this._patrolDir < 0 && hitLeft) this._patrolDir = 1;
            else if (this._patrolDir > 0 && hitRight) this._patrolDir = -1;
            if (mode === "topdown") {
              const hitUp   = body.blocked?.up   || body.touching?.up;
              const hitDown = body.blocked?.down || body.touching?.down;
              if (this._patrolDirY < 0 && hitUp)   this._patrolDirY = 1;
              else if (this._patrolDirY > 0 && hitDown) this._patrolDirY = -1;
            }
          }
          cm.maxSpeed = this.patrolSpeed;
          sim.add(this._patrolDir < 0 ? "MoveLeft" : "MoveRight");
          if (mode === "topdown") {
            sim.add(this._patrolDirY < 0 ? "MoveUp" : "MoveDown");
          }
        }
        break;
      }
      case "chase": {
        if (!target) break;
        cm.maxSpeed = this.chaseSpeed;
        // Platformer: X-axis only. Topdown: both axes with a small deadband
        // around zero so the NPC doesn't oscillate at point-blank range.
        const dx = target.x - ox;
        if (mode === "topdown") {
          if (Math.abs(dx) > this._topdownDeadband) sim.add(dx < 0 ? "MoveLeft" : "MoveRight");
          const dy = target.y - oy;
          if (Math.abs(dy) > this._topdownDeadband) sim.add(dy < 0 ? "MoveUp" : "MoveDown");
        } else {
          sim.add(dx < 0 ? "MoveLeft" : "MoveRight");
        }
        break;
      }
      case "attack": {
        // Hold position during the attack swing.
        break;
      }
      case "flee": {
        if (!target) break;
        cm.maxSpeed = this.chaseSpeed;
        // Run AWAY: invert the chase direction on every active axis.
        const dx = target.x - ox;
        if (mode === "topdown") {
          if (Math.abs(dx) > this._topdownDeadband) sim.add(dx < 0 ? "MoveRight" : "MoveLeft");
          const dy = target.y - oy;
          if (Math.abs(dy) > this._topdownDeadband) sim.add(dy < 0 ? "MoveDown" : "MoveUp");
        } else {
          sim.add(dx < 0 ? "MoveRight" : "MoveLeft");
        }
        break;
      }
      case "alert":
      case "search":
      default:
        // Stand still.
        break;
    }
    // Separation override — "queue / wait your turn" behavior. If a
    // same-tag sibling is within `separationDist` AND on the path to the
    // target (forward hemisphere relative to the chase direction), clear
    // the move-input so this NPC HOLDS POSITION instead of pushing.
    //
    // Was push-away (boids-style) which created chase ↔ push oscillation
    // (shake) AND scattered the crowd's edge NPCs away from the target.
    // Stop-when-blocked has neither problem: front-runners move, followers
    // wait until the blocker clears, then catch up. No oscillation.
    if (this.separationDist > 0 && target) {
      const r2 = this.separationDist * this.separationDist;
      const list: Iterable<Sprite> = this.separationTag
        ? getNeighborsByTag(this.sprite.scene, this.separationTag, ox, oy, this.separationDist)
        : ((this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? []);
      // Mode dispatch:
      //  - "push" or "velocity": hard position-shift to enforce the
      //    minimum distance, same algorithm MoveTo uses. This is the
      //    fix for "cluster doesn't push apart on CharacterMovement /
      //    TopdownMovement" — those movers ignored separation entirely
      //    before. Same modes both apply the position correction; the
      //    distinction matters for MoveTo (where velocity also gets
      //    blended) but for input-driven CM/Topdown the input system
      //    is opaque to a per-tick blend, so both modes converge here.
      //  - "off" or default: STOP mode — clear inputs when blocked
      //    (legacy "wait your turn" behavior).
      const usePushApart = this.separationMode === "push" || this.separationMode === "velocity";
      if (usePushApart) {
        let dxC = 0;
        let dyC = 0;
        for (const s of list) {
          if (s.destroyed || s.uid === this.sprite.uid) continue;
          const sx = s.gameObject?.x;
          const sy = s.gameObject?.y;
          if (typeof sx !== "number" || typeof sy !== "number") continue;
          const ndx = sx - ox;
          const ndy = sy - oy;
          const nd2 = ndx * ndx + ndy * ndy;
          if (nd2 >= r2 || nd2 < 0.01) continue;
          const d = Math.sqrt(nd2);
          const overlap = this.separationDist - d;
          dxC -= (ndx / d) * (overlap * 0.35);
          dyC -= (ndy / d) * (overlap * 0.35);
        }
        if (dxC !== 0 || dyC !== 0) {
          const body = this.sprite.body;
          // The nudge writes position DIRECTLY (bypassing the arcade tile
          // collider), so a cluster squeezing toward a wall would otherwise
          // shove the front NPC straight through it. Clamp the correction
          // against collidable tiles so it can push toward — but not into — a wall.
          const cl = body ? this._clampSeparationVsTiles(body, dxC, dyC) : { dx: dxC, dy: dyC };
          this.sprite.gameObject.x += cl.dx;
          this.sprite.gameObject.y += cl.dy;
          if (body) {
            body.position.x += cl.dx;
            body.position.y += cl.dy;
          }
        }
      } else {
        let blocked = false;
        for (const s of list) {
          if (s.destroyed || s.uid === this.sprite.uid) continue;
          const sx = s.gameObject?.x;
          const sy = s.gameObject?.y;
          if (typeof sx !== "number" || typeof sy !== "number") continue;
          const ndx = sx - ox;
          const ndy = sy - oy;
          const nd2 = ndx * ndx + ndy * ndy;
          if (nd2 > r2 || nd2 === 0) continue;
          blocked = true;
          break;
        }
        if (blocked) {
          sim.delete("MoveLeft");
          sim.delete("MoveRight");
          sim.delete("MoveUp");
          sim.delete("MoveDown");
        }
      }
    }
  }

  /** Push the current AI state onto MoveTo's fields. Called from `_act()`
   *  when the host's mover is MoveTo. MoveTo runs its own update next tick
   *  and chases / steers per the values we set here.
   *
   *   - chase: MoveTo.mode = "object", targetUid = AIBrain.targetUid,
   *            speed = chaseSpeed, enabled = true.
   *   - attack: MoveTo.enabled = false. Hold position during the swing.
   *   - flee: MoveTo.mode = "angle" pointed AWAY from target,
   *            speed = chaseSpeed, enabled = true.
   *   - idle: if patrolMode is "walls", drive MoveTo in angle mode at
   *           patrolSpeed; otherwise disable.
   *   - alert / search: disable (NPC pauses).
   */
  private _driveMoveTo(mt: MoveToLike): void {
    // Push separation params from the brain onto MoveTo so authors set
    // separation once (on AIBrain) and it applies regardless of mover.
    // Done at the top of _driveMoveTo so the values are current on
    // every state branch (chase / flee / patrol all need them).
    mt.separationDist = this.separationDist;
    mt.separationTag = this.separationTag;
    mt.separationAvoid = this.separationAvoid;
    mt.separationMode = this.separationMode;
    // When we disable MoveTo we MUST also zero the body's velocity —
    // setting `mt.enabled = false` just stops the next update from
    // writing a new velocity; the LAST velocity Phaser integrated is
    // still in the body and the NPC keeps coasting forward indefinitely.
    // This was the "after losing sight it doesn't stop" bug.
    const halt = () => {
      mt.enabled = false;
      const body = this.sprite.body;
      if (body) body.setVelocity(0, 0);
    };
    const target = this._target();
    switch (this.state) {
      case "chase": {
        if (this.targetUid < 0) { halt(); return; }
        mt.mode = "object";
        mt.targetUid = this.targetUid;
        mt.speed = this.chaseSpeed;
        mt.enabled = true;
        return;
      }
      case "attack": {
        halt();
        return;
      }
      case "flee": {
        if (!target) { halt(); return; }
        const ox = this.sprite.gameObject.x;
        const oy = this.sprite.gameObject.y;
        const dx = target.x - ox;
        const dy = target.y - oy;
        mt.mode = "angle";
        mt.angleDeg = (Math.atan2(-dy, -dx) * 180) / Math.PI;
        mt.speed = this.chaseSpeed;
        mt.enabled = true;
        return;
      }
      case "idle": {
        if (this.patrolMode === "walls") {
          mt.mode = "angle";
          mt.angleDeg = this._patrolDir < 0 ? 180 : 0;
          mt.speed = this.patrolSpeed;
          mt.enabled = true;
        } else {
          halt();
        }
        return;
      }
      case "alert":
      case "search":
      default:
        halt();
        return;
    }
  }

  /** Distance from this sprite to a target — X-axis only in platformer
   *  mode (gravity-bound; a target above only matters for X reach),
   *  Euclidean 2D in topdown mode (the target can be on any vector).
   *  Used by every `attackRange` check so an NPC sitting directly above
   *  a topdown player doesn't think it's already in melee range with
   *  dx=0. Reads `_moveMode` populated by `_act()`; falls back to
   *  X-only when mode hasn't been resolved yet (early ticks). */
  private _distToTarget(target: { x: number; y: number }): number {
    const dx = target.x - this.sprite.gameObject.x;
    if (this._moveMode === "topdown") {
      const dy = target.y - this.sprite.gameObject.y;
      return Math.hypot(dx, dy);
    }
    return Math.abs(dx);
  }

  /** Find the movement behavior this AIBrain drives. Honors the explicit
   *  `mover` dropdown so a BP carrying multiple movement chips picks
   *  the right one. "auto" preserves the legacy resolve-by-presence
   *  fallback. The lookup is O(behaviors-on-this-sprite), typically ≤10. */
  private _resolveMovement(): { mover: CMWritable | undefined; mode: MoveMode } {
    switch (this.mover) {
      case "CharacterMovement": {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as CMWritable | undefined;
        return { mover: cm, mode: cm ? "platformer" : "none" };
      }
      case "TopdownMovement": {
        const td = this.sprite.findBehaviorByKind("TopdownMovement") as CMWritable | undefined;
        return { mover: td, mode: td ? "topdown" : "none" };
      }
      case "MoveTo": {
        const mt = this.sprite.findBehaviorByKind("MoveTo") as unknown as CMWritable | undefined;
        return { mover: mt, mode: mt ? "moveto" : "none" };
      }
      case "auto":
      default: {
        const cm = this.sprite.findBehaviorByKind("CharacterMovement") as CMWritable | undefined;
        if (cm) return { mover: cm, mode: "platformer" };
        const td = this.sprite.findBehaviorByKind("TopdownMovement") as CMWritable | undefined;
        if (td) return { mover: td, mode: "topdown" };
        return { mover: undefined, mode: "none" };
      }
    }
  }

  /** True when the host Damageable reports hp ≤ 0 or `isDead`. Used by
   *  the facing-flip guards so a corpse doesn't flip to track the player.
   *  Independent of `disableWhenDead` — that flag gates the whole brain,
   *  but the facing flip on a dead body is always wrong. */
  private _isDead(): boolean {
    const d = this.sprite.findBehaviorByKind("Damageable") as { hp?: number; isDead?: boolean } | undefined;
    if (!d) return false;
    return !!d.isDead || (d.hp ?? 1) <= 0;
  }

  /** True while a `lockFacing` animator state (e.g. an attack mid-swing) holds
   *  the facing. We skip auto-facing the target so the enemy finishes its
   *  cycle before turning. */
  private _facingLocked(): boolean {
    const an = this.sprite.findBehaviorByKind("StateMachine") as { facingLocked?: boolean } | undefined;
    return !!an?.facingLocked;
  }

  /** Clamp a separation nudge so it can't push the body INTO a collidable tile.
   *  The nudge writes position directly (no arcade tile collision), so without
   *  this a squeezing cluster shoves an NPC through walls. Cancels the X and/or
   *  Y component if the body's leading edge at the new position lands in a tile. */
  private _clampSeparationVsTiles(
    body: { x: number; right: number; y: number; bottom: number; center: { x: number; y: number } },
    dxC: number, dyC: number,
  ): { dx: number; dy: number } {
    const layers = this.sprite.scene.data.get("peaky.tilemapLayers") as
      | Array<{ getTileAtWorldXY: (x: number, y: number, nonNull?: boolean) => { index: number; collides: boolean } | null }>
      | undefined;
    if (!layers || layers.length === 0) return { dx: dxC, dy: dyC };
    const solid = (x: number, y: number): boolean => {
      for (const layer of layers) {
        const t = layer.getTileAtWorldXY(x, y, true);
        if (t && t.index >= 0 && t.collides) return true;
      }
      return false;
    };
    let dx = dxC, dy = dyC;
    if (dx !== 0) {
      const edgeX = (dx > 0 ? body.right : body.x) + dx;
      if (solid(edgeX, body.y + 2) || solid(edgeX, body.center.y) || solid(edgeX, body.bottom - 2)) dx = 0;
    }
    if (dy !== 0) {
      const edgeY = (dy > 0 ? body.bottom : body.y) + dy;
      if (solid(body.x + 2, edgeY) || solid(body.center.x, edgeY) || solid(body.right - 2, edgeY)) dy = 0;
    }
    return { dx, dy };
  }

  private _target(): { x: number; y: number; uid: number } | null {
    if (this.targetUid === -1) return null;
    const list = this.sprite.scene.data.get("peaky.sprites") as Array<{ uid: number; destroyed: boolean; gameObject?: { x: number; y: number }; findBehaviorByKind?: (k: string) => unknown }> | undefined;
    if (!list) return null;
    const t = list.find((s) => s.uid === this.targetUid && !s.destroyed);
    // Target destroyed / removed from the world (find skips destroyed sprites,
    // and pooled sprites stay in the list, so a miss = genuinely gone). Clear
    // the uid so the `_think` early-idle guard disengages this frame instead of
    // chasing a dead uid through the loseSightAfterSec search timeout.
    if (!t) { this.targetUid = -1; return null; }
    if (!t.gameObject) return null;
    // Honor the target's Damageable.attackable toggle. Author flips this
    // false to make a sprite untargetable (on death, during stealth,
    // during a dialogue cutscene, etc.) — AIBrain disengages without
    // any per-NPC wiring. Missing Damageable / missing field defaults
    // to attackable (back-compat for sprites without combat surface).
    const d = t.findBehaviorByKind?.("Damageable") as { attackable?: number } | undefined;
    if (d && d.attackable === 0) {
      this.targetUid = -1;
      return null;
    }
    return { x: t.gameObject.x, y: t.gameObject.y, uid: t.uid };
  }

  /** Flip patrol direction. Logic Sheet calls this via SetBehaviorParam or
   *  through a custom action when the NPC bumps a wall. */
  flipPatrolDir(): void {
    this._patrolDir = this._patrolDir === 1 ? -1 : 1;
  }

  private transitionTo(next: AIState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.sprite.events.emit(`OnAIStateExit_${prev}`);
    this.sprite.events.emit("OnAIStateExit");
    this.prevState = prev;
    this.state = next;
    this._enteredAt = this._now;
    this.sprite.events.emit(`OnAIStateEnter_${next}`);
    this.sprite.events.emit("OnAIStateEnter");
    if (next === "attack") {
      this._lastAttackAt = this._now;
      this._resting = false;
      this._attackAnimStarted = false;
      this._outAnimStarted = false;
    }
  }

  /** Read current state (typed). */
  getState(): AIState {
    return this.state;
  }
}

/**
 * Helper for editor diagnostics + tests: returns the list of valid AI
 * state names. Mirrors the `AIState` union above. The NPC Overview's
 * state dropdown and Logic Sheet's IsAIState/SetAIState use this.
 */
export const AI_STATES: readonly AIState[] = [
  "idle", "alert", "chase", "search", "attack", "flee", "rest",
] as const;

/** Returns true when the NPC's AIBrain considers `sprite` its target. */
export function isAIBrainTarget(brain: AIBrain, sprite: Sprite): boolean {
  return brain.targetUid === sprite.uid;
}

/** External alert-broadcast helper used by Logic Sheet AlertNearbyAllies. */
export function alertNearbyNpcs(originX: number, originY: number, radius: number, tag: string, scene: Phaser.Scene): number {
  // Tag index + spatial grid intersection. Walks only same-tag sprites
  // inside the alert radius's cells — typical "alert all ENEMY NPCs within
  // 400px" goes from O(N) over all sprites to O(cells × tag-in-cell).
  const candidates = getNeighborsByTag(scene, tag, originX, originY, radius);
  if (candidates.length === 0) return 0;
  let count = 0;
  const r2 = radius * radius;
  for (const s of candidates) {
    if (s.destroyed) continue;
    const sx = s.gameObject?.x;
    const sy = s.gameObject?.y;
    if (typeof sx !== "number" || typeof sy !== "number") continue;
    const dx = sx - originX;
    const dy = sy - originY;
    if (dx * dx + dy * dy > r2) continue;
    const brain = s.findBehaviorByKind?.("AIBrain") as AIBrain | undefined;
    if (!brain) continue;
    brain.alertFrom(originX, originY);
    count++;
  }
  return count;
}
