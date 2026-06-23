import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import type { Sprite } from "../Sprite";

/**
 * HP / damage / death behavior. Attach to anything that can be hurt —
 * Character, Enemy, Boss, breakable interactables. Other behaviors call
 * `applyDamage(amount, source, opts)` directly (no event-sheet plumbing).
 *
 * Emits on the host's per-sprite EventBus so other behaviors on the same
 * sprite (Animator → hit_react/death slots, FX → blood_on_hit) can subscribe
 * via `sprite.events.on(...)`, and event-sheet authors can still listen via
 * `OnSignal "OnDamageTaken"`.
 *
 * I-frames are time-based: `iframesUntilSec` in the future → `applyDamage`
 * returns false. Hitstun is published as `hitstunUntilSec`; Damageable
 * itself doesn't lock movement — the Animator's hit_react state does.
 */
export interface DamageOpts {
  knockbackX?: number;
  knockbackY?: number;
  /** Override `iframeSec` for this hit only. */
  iframes?: number;
  /** Override `hitstunSec` for this hit only. */
  hitstun?: number;
  /** Override the default blood FX slot ("blood_on_hit"). */
  fxSlot?: string;
}

export class Damageable extends Behavior {
  kind = "Damageable";

  hp = 100;
  maxHp = 100;
  /** Name of the BP variable mirrored to `hp` on every change. When set,
   *  `init()` reads the BP var's value into `hp` (overriding the inspector
   *  default) and every hp mutation writes back so UI widgets / Logic
   *  Sheet can read `var:hp` and see current health. Empty = no linking.
   *  Default "hp" matches the Character/NPC templates' pre-declared var. */
  hpVar = "hp";
  /** Same for maxHp. Default "maxHp" matches the template variable. */
  maxHpVar = "maxHp";
  /** Default invulnerability window after a damage hit lands. */
  iframeSec = 0.5;
  /** Default lockout duration the Animator should treat as hit-react. */
  hitstunSec = 0.3;
  /** Multiplier applied to incoming knockback. 0 disables knockback. */
  knockbackMultiplier = 1;
  /** When 1, the host Sprite is destroyed after `deathDestroyDelay` from kill(). */
  destroyOnDeath = 1;
  /** Seconds between kill() and Sprite.destroy(). Gives the Animator's
   *  death slot time to play. 0 = destroy immediately. */
  deathDestroyDelay = 0.5;
  /** When 0, `heal()` does nothing. */
  allowHealing = 1;
  /** When 0, AIBrain disengages — any sprite targeting this one drops
   *  the lock and ignores sight hits. Author toggles via SetBehaviorParam
   *  on death, stealth, cutscene, dialogue mode, etc. Default 1 so
   *  combat-capable BPs are attackable until explicitly turned off.
   *  Does NOT affect `applyDamage()` — disabling this only suppresses
   *  AI engagement; direct damage (Tracer hits, scripted damage) still
   *  applies. Use iframes for damage immunity. */
  attackable = 1;

  /** Wall-clock (sim seconds) until i-frames expire. */
  iframesUntilSec = 0;
  /** Wall-clock (sim seconds) until hitstun lockout ends — Animator reads this. */
  hitstunUntilSec = 0;
  /** Latched once kill() runs; further applyDamage calls return false. */
  isDead = false;

  /** Comma-separated CharacterAnimator state names during which incoming
   *  damage is gated (e.g. "block,parry"). While the host's `currentState`
   *  matches one of these, `applyDamage` scales the hit by `guardMultiplier`.
   *  Empty = no state-based gating. This is the "block while in the block
   *  state" path — no event wiring needed, just name the state(s) here. */
  blockStates = "";
  /** Manual guard flag (writable via SetBehaviorParam). Non-zero = guarding,
   *  independent of animator state. Use for hold-to-block that isn't tied to
   *  a dedicated animator state. */
  guarding = 0;
  /** Damage multiplier applied while guarding (state OR manual flag). 0 = the
   *  hit is fully blocked (default); 0.5 = take half; 1 = no reduction. */
  guardMultiplier = 0;

  init(): void {
    // BP variable wins over inspector default when present — author who
    // tunes the BP variable expects that value at spawn. Then push back so
    // a freshly-spawned sprite has the var populated for UI widgets.
    const vars = this.sprite.vars;
    if (this.hpVar && vars.has(this.hpVar)) {
      const v = vars.get(this.hpVar);
      if (typeof v === "number") this.hp = v;
    }
    if (this.maxHpVar && vars.has(this.maxHpVar)) {
      const v = vars.get(this.maxHpVar);
      if (typeof v === "number") this.maxHp = v;
    }
    this._syncToVars();
  }

  private _syncToVars(): void {
    if (this.hpVar) this.sprite.vars.set(this.hpVar, this.hp);
    if (this.maxHpVar) this.sprite.vars.set(this.maxHpVar, this.maxHp);
  }

  /**
   * Inflict damage. Returns true if it actually landed (not blocked by
   * i-frames or already-dead). Source is optional — used for attribution
   * in the emitted signal.
   */
  applyDamage(amount: number, source?: Sprite, opts: DamageOpts = {}): boolean {
    if (this.isDead || amount <= 0) {
      Logger.log({ level: "warn", source: "Damageable", message: `applyDamage BLOCKED on "${this.sprite.bpName}" — ${this.isDead ? "already dead" : `amount=${amount} (≤0)`}.` });
      return false;
    }
    const now = this.sprite.scene.time.now / 1000;
    if (now < this.iframesUntilSec) {
      Logger.log({ level: "warn", source: "Damageable", message: `applyDamage BLOCKED on "${this.sprite.bpName}" — i-frames active (${(this.iframesUntilSec - now).toFixed(2)}s left of ${this.iframeSec}s). Lower iframeSec for faster hits.` });
      return false;
    }

    // Guard / block gate. While guarding (manual flag) OR in a configured
    // block animator state, scale the incoming hit by `guardMultiplier`.
    // A 0 multiplier fully blocks: no HP loss, no i-frames consumed — but
    // OnBlocked fires so authors can play a block spark / parry push.
    if (this.isGuarding()) {
      const blocked = amount * (1 - Math.max(0, this.guardMultiplier));
      amount = amount * Math.max(0, this.guardMultiplier);
      this.sprite.events.emit("OnBlocked", {
        blocked,
        hp: this.hp,
        maxHp: this.maxHp,
        sourceUid: source?.uid ?? null,
      });
      if (amount <= 0) {
        Logger.log({ level: "warn", source: "Damageable", message: `applyDamage BLOCKED on "${this.sprite.bpName}" — fully guarded (guardMultiplier=${this.guardMultiplier}).` });
        return false;
      }
    }

    this.hp = Math.max(0, this.hp - amount);
    this._syncToVars();
    this.iframesUntilSec = now + (typeof opts.iframes === "number" ? opts.iframes : this.iframeSec);
    this.hitstunUntilSec = now + (typeof opts.hitstun === "number" ? opts.hitstun : this.hitstunSec);

    const body = this.sprite.body;
    if (body && (opts.knockbackX || opts.knockbackY)) {
      const kx = (opts.knockbackX ?? 0) * this.knockbackMultiplier;
      const ky = (opts.knockbackY ?? 0) * this.knockbackMultiplier;
      if (kx) body.setVelocityX(kx);
      if (ky) body.setVelocityY(ky);
    }

    this.sprite.events.emit("OnDamageTaken", {
      amount,
      hp: this.hp,
      maxHp: this.maxHp,
      sourceUid: source?.uid ?? null,
      fxSlot: opts.fxSlot ?? "blood_on_hit",
    });

    if (this.hp === 0) this.kill();
    return true;
  }

  /** Add HP, clamped to maxHp. Returns the amount actually healed. */
  heal(amount: number): number {
    if (!this.allowHealing || this.isDead || amount <= 0) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const gained = this.hp - before;
    if (gained > 0) {
      this._syncToVars();
      this.sprite.events.emit("OnHealed", { amount: gained, hp: this.hp, maxHp: this.maxHp });
    }
    return gained;
  }

  /** Force death regardless of HP. Idempotent. */
  kill(): void {
    if (this.isDead) return;
    this.isDead = true;
    this.hp = 0;
    this._syncToVars();
    this.sprite.events.emit("OnDeath", { uid: this.sprite.uid });
    if (!this.destroyOnDeath) return;
    const delayMs = Math.max(0, this.deathDestroyDelay * 1000);
    if (delayMs === 0) {
      if (!this.sprite.destroyed) this.sprite.destroy();
      return;
    }
    this.sprite.scene.time.delayedCall(delayMs, () => {
      if (!this.sprite.destroyed) this.sprite.destroy();
    });
  }

  /** True while damage should be gated — the manual `guarding` flag is set,
   *  OR the host's CharacterAnimator is in one of the `blockStates`. */
  isGuarding(): boolean {
    if (this.guarding !== 0) return true;
    if (!this.blockStates) return false;
    const anim = this.sprite.findBehaviorByKind("StateMachine");
    const cur = anim?.currentState;
    if (!cur) return false;
    for (const s of this.blockStates.split(",")) {
      if (s.trim() === cur) return true;
    }
    return false;
  }

  isInIframes(): boolean {
    return this.sprite.scene.time.now / 1000 < this.iframesUntilSec;
  }

  isInHitstun(): boolean {
    return this.sprite.scene.time.now / 1000 < this.hitstunUntilSec;
  }

  serialize(): Record<string, unknown> {
    return { hp: this.hp, maxHp: this.maxHp, isDead: this.isDead };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.hp === "number") this.hp = state.hp;
    if (typeof state.maxHp === "number") this.maxHp = state.maxHp;
    if (typeof state.isDead === "boolean") this.isDead = state.isDead;
  }
}
