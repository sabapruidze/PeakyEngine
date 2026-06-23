import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import type { Damageable } from "./Damageable";

/**
 * HP-driven phase counter for bosses (and any health-gated state machine).
 *
 * Reads a sibling Damageable's `hp / maxHp` ratio every tick and advances
 * `currentPhase` when the HP crosses a configured percentage threshold.
 * On every transition it fires both generic and specific signals
 * (`OnPhaseEnter` + `OnPhaseEnter_<n>`) so authors can subscribe by phase
 * or by "any transition", and optionally grants brief i-frames so a
 * burst of damage doesn't skip a phase outright.
 *
 * The animator's eval loop reads `currentPhase` directly via
 * `findBehaviorByKind("PhaseManager")` to gate states by `minPhase` /
 * `maxPhase`. Authors don't need to write any glue for the common case
 * "phase-2 attack unlocks at 33% HP" — they just drop a Boss BP and set
 * the per-state phase fields in the Animation Slots table.
 *
 * Phase progression is one-way by design: a boss heal that pushes HP
 * back above a threshold does NOT walk the phase backward. Bosses don't
 * "un-rage" mid-fight.
 */
export class PhaseManager extends Behavior {
  kind = "PhaseManager";

  /** Comma-separated HP percentages (0..100) where the phase advances. The
   *  thresholds ARE the phases: "50" → phase 0 (100%-50%) + phase 1 (50%-0%);
   *  "66,33" → phases 0, 1, 2. One threshold = one extra phase, so the count
   *  is implied — there's no separate "number of phases" field to get wrong.
   *  Stored as percentages (not absolute HP) so retuning maxHp later doesn't
   *  re-tune the thresholds. String so the inspector edits it as one text
   *  field; parsed every tick by `update()`. */
  thresholdsPct = "66,33";

  /** Public: the animator's phase-gate eval reads this directly. Starts
   *  at 0; only increases. */
  currentPhase = 0;

  /** BP variable to mirror `currentPhase` into so Logic Sheet conditions
   *  can read `var:phase`. Empty = don't write. Default "phase" is the
   *  conventional name — declare a numeric variable called "phase" on
   *  any BP using PhaseManager and the value will be kept in sync. */
  phaseVar = "phase";

  /** Seconds of invulnerability granted on a phase change. Bumps the
   *  sibling Damageable's `iframesUntilSec`. 0 = no iframes. */
  invulnOnTransitionSec = 0.6;

  private _damageable: Damageable | undefined;
  private _initialEmitted = false;
  private _warnedNoDmg = false;

  init(): void {
    if (this.phaseVar) this.sprite.vars.set(this.phaseVar, this.currentPhase);
  }

  /** Lazy lookup — a Damageable attached AFTER this behavior wouldn't be
   *  found by an init()-time cache, which would pin `undefined` forever and
   *  silently disable every phase transition. Re-resolve until found. */
  private damageable(): Damageable | undefined {
    if (!this._damageable) this._damageable = this.sprite.findBehaviorByKind("Damageable");
    return this._damageable;
  }

  update(_delta: number): void {
    // Emit the initial phase's enter signal once, on the first tick — NOT in
    // init(), because the Logic Sheet wires its OnSignal triggers during
    // spawn and an init()-time emit would land before any listener exists.
    // This makes an "OnPhaseEnter_0" handler fire at start (phase 0 is
    // entered at spawn; nothing else would ever emit it).
    if (!this._initialEmitted) {
      this._initialEmitted = true;
      // Only the specific signal — the generic "OnPhaseEnter" means "any
      // transition" and spawn is not a transition, so firing it here would
      // trip every generic handler at start.
      this.sprite.events.emit(`OnPhaseEnter_${this.currentPhase}`);
    }
    const d = this.damageable();
    if (!d || d.maxHp <= 0) {
      // Fire ONCE — both misconfigs return early forever, so without this the
      // feature is silently dead. maxHp<=0 makes hp/maxHp non-finite, so it
      // needs its own message (not just the "no Damageable" case).
      if (!this._warnedNoDmg) {
        this._warnedNoDmg = true;
        const who = this.sprite.blueprintName || this.sprite.instanceName || "?";
        Logger.log({
          level: "warn",
          source: "PhaseManager",
          message: !d
            ? `"${who}" has no Damageable — add a Damageable (HP) component or phases past 0 can't advance.`
            : `"${who}" Damageable maxHp=${d.maxHp} (must be > 0) — set a positive Max HP (or its maxHp variable). Can't compute HP%.`,
        });
      }
      return;
    }
    const pct = (d.hp / d.maxHp) * 100;
    // Phase = count of thresholds the HP has dropped below. Parse the
    // comma-separated string fresh each tick — cheap and means
    // SetBehaviorParam edits at runtime apply immediately. Non-numeric
    // entries are silently ignored (NaN <= pct is always false).
    let target = 0;
    for (const part of String(this.thresholdsPct).split(",")) {
      const t = Number(part);
      if (Number.isFinite(t) && pct <= t) target++;
    }
    // target naturally caps at the number of finite thresholds — the
    // thresholds list IS the phase ceiling, so no separate cap is needed.
    // One-way: only advance, never regress.
    if (target <= this.currentPhase) return;
    const from = this.currentPhase;
    this.currentPhase = target;
    if (this.phaseVar) this.sprite.vars.set(this.phaseVar, target);
    // Generic transition signals — authors who don't care which phase
    // fired use these. Then specific signals so OnSignal can filter
    // without needing a `Compare currentPhase == N` follow-up.
    this.sprite.events.emit("OnPhaseExit");
    this.sprite.events.emit("OnPhaseEnter");
    this.sprite.events.emit(`OnPhaseExit_${from}`);
    this.sprite.events.emit(`OnPhaseEnter_${target}`);
    if (this.invulnOnTransitionSec > 0) {
      // Sim time mirrors Damageable's own tick clock so the window is
      // honored by applyDamage's iframe gate.
      d.iframesUntilSec = this.sprite.scene.time.now / 1000 + this.invulnOnTransitionSec;
      Logger.log({ level: "warn", source: "PhaseManager", message: `"${this.sprite.bpName}" entered phase ${target} → granted ${this.invulnOnTransitionSec}s invulnerability (this blocks follow-up hits; set Invuln On Transition to 0 to disable).` });
    }
  }

  serialize(): Record<string, unknown> {
    // Round-trip currentPhase so a SaveSlot mid-fight resumes at the
    // right phase. Without this, a load would start at phase 0 and
    // re-trigger every threshold as HP catches up.
    return { currentPhase: this.currentPhase };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.currentPhase === "number") {
      this.currentPhase = state.currentPhase;
      if (this.phaseVar) this.sprite.vars.set(this.phaseVar, this.currentPhase);
    }
  }
}
