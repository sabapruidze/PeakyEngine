/**
 * Built-in signal registry — names that the runtime emits automatically
 * from specific behaviors. The editor uses this to power the SignalPicker
 * dropdown so authors can DISCOVER signals (rather than memorize names) and
 * see which subsystem owns each.
 *
 * The runtime doesn't validate against this list — any string can be
 * emitted via `EmitSignal` and listened to via `OnSignal`. This is purely
 * authoring metadata.
 *
 * Adding a new emitted signal: append a row here AND emit it from the
 * behavior. Editor automatically surfaces it in pickers.
 */

export interface BuiltInSignal {
  /** Exact signal name as emitted by the runtime. */
  name: string;
  /** Which behavior / subsystem emits it. Used as the chip label + group
   *  header in the SignalPicker dropdown. Matches COMPONENT_THEME keys. */
  source: string;
  /** One-line description shown as a tooltip on the picker option. */
  description: string;
  /**
   * Authoring direction:
   *  - "listen"  → the engine emits this; authors only LISTEN. Hidden from
   *    EmitSignal / Tracer.triggerSignal / FrameSignal pickers because
   *    manually emitting fakes the signal without the underlying side
   *    effect (e.g. emitting "OnDamageTaken" doesn't actually deal damage).
   *  - "emit"    → authors emit this; engine doesn't. Rare today.
   *  - "both"    → engine + authors both emit. AttackFrame is the canonical
   *    example: the animator fires it from a Frame Signal, the Tracer
   *    listens. Both pickers show it.
   */
  direction: "listen" | "emit" | "both";
}

export const BUILT_IN_SIGNALS_REGISTRY: BuiltInSignal[] = [
  // ─── Damageable ─────────────────────────────────────────────────────
  { name: "OnDamageTaken",        source: "Damageable",         direction: "listen", description: "Fires on the host the frame applyDamage() lands (passes i-frame gate)." },
  { name: "OnDeath",              source: "Damageable",         direction: "listen", description: "Fires on the host the frame kill() runs (hp hits 0 or explicit kill)." },
  { name: "OnHealed",             source: "Damageable",         direction: "listen", description: "Fires on the host the frame heal() adds hp (above 0)." },
  { name: "OnBlocked",            source: "Damageable",         direction: "listen", description: "Fires on the host when an incoming hit is guarded (host is in a Block State or the guarding flag is on). Use for block sparks / parry push / SFX." },
  { name: "OnPartialBlock",       source: "Damageable",         direction: "listen", description: "Fires on the host when a guarded hit is only PARTIALLY blocked (0 < Guard Multiplier < 1) — some damage was absorbed but some still got through (chip damage). Fires alongside OnBlocked. Payload: blocked (absorbed) + through (damage taken)." },

  // ─── Inventory ──────────────────────────────────────────────────────
  { name: "OnItemAdded",          source: "Inventory",          direction: "listen", description: "Fires on the host when AddItem adds at least one unit. Payload: { item, qty, added }." },
  { name: "OnItemRemoved",        source: "Inventory",          direction: "listen", description: "Fires on the host when RemoveItem removes at least one unit. Payload: { item, qty, removed }." },
  { name: "OnInventoryFull",      source: "Inventory",          direction: "listen", description: "Fires on the host when an AddItem couldn't fully fit (no room). Payload: { item }." },

  // ─── CharacterMovement ──────────────────────────────────────────────
  { name: "OnJump",               source: "CharacterMovement",  direction: "listen", description: "Fires the frame a jump fires (any jump — first, double, etc.)." },
  { name: "OnLand",               source: "CharacterMovement",  direction: "listen", description: "Fires the frame the body touches ground after being airborne." },
  { name: "OnFall",               source: "CharacterMovement",  direction: "listen", description: "Fires the frame the body starts falling (vy crosses 0 while airborne)." },
  { name: "OnDashStart",          source: "CharacterMovement",  direction: "listen", description: "Fires the frame a dash begins." },
  { name: "OnDashEnd",            source: "CharacterMovement",  direction: "listen", description: "Fires the frame a dash ends." },
  { name: "OnMoved",              source: "CharacterMovement",  direction: "listen", description: "Fires the frame horizontal speed transitions 0 → non-zero." },
  { name: "OnStopped",            source: "CharacterMovement",  direction: "listen", description: "Fires the frame horizontal speed transitions non-zero → 0." },

  // ─── SpriteRenderer ─────────────────────────────────────────────────
  { name: "OnAnimationFinished",  source: "SpriteRenderer",     direction: "listen", description: "Fires the frame a non-looping animation reaches its last frame." },

  // ─── Tracer ─────────────────────────────────────────────────────────
  { name: "OnTracerHit",          source: "Tracer",             direction: "listen", description: "Fires on the host the frame a Tracer registers a new hit." },
  { name: "OnTracerLost",         source: "Tracer",             direction: "listen", description: "Fires on the host the frame a Tracer stops hitting (was on a target, now hits nothing)." },
  { name: "OnTracedBy",           source: "Tracer",             direction: "listen", description: "Fires on a TARGET sprite each sample a tracer is hitting it." },
  { name: "OnUntracedBy",         source: "Tracer",             direction: "listen", description: "Fires on a TARGET sprite when a tracer that was hitting it stops for N seconds (set on the trigger)." },

  // ─── AIBrain ────────────────────────────────────────────────────────
  { name: "OnTargetSighted",      source: "AIBrain",            direction: "listen", description: "Fires when the brain first locks onto a target via its sight tracer." },
  { name: "OnTargetLost",         source: "AIBrain",            direction: "listen", description: "Fires when the brain's target goes out of sight or is destroyed." },

  // ─── Convention signals ─────────────────────────────────────────────
  // Not emitted by any behavior — the engine LISTENS for them via Tracer
  // / behavior config defaults. Author wires the emission (Frame Signal
  // on an animator state, EmitSignal action, etc.) and the listening
  // component picks them up. Direction "both" so both sides show them.
  { name: "AttackFrame",          source: "Convention",         direction: "both",   description: "Default value of Tracer.triggerSignal. Author emits it from a Frame Signal on an attack animator state (e.g. frame 4 of attack1). The attack Tracer listens and fires its hitbox on that exact frame. Engine doesn't emit this — it's a 2-step author pattern." },
  { name: "SpecialFrame",         source: "Convention",         direction: "both",   description: "Default trigger signal for the Boss BP's `special` Tracer. Author wires it as a Frame Signal on a phase-2 attack anim so the wider AOE hitbox fires only on that swing." },

  // ─── SquashStretch ──────────────────────────────────────────────────
  { name: "OnSquashStretchEnd",   source: "SquashStretch",      direction: "listen", description: "Fires when a squash/stretch sequence finishes returning to neutral." },

  // ─── Camera ─────────────────────────────────────────────────────────
  { name: "OnCameraPanEnd",       source: "Camera",             direction: "listen", description: "Fires when a CameraPanTo / CameraPanToTag tween finishes." },

  // ─── PhaseManager ───────────────────────────────────────────────────
  // Generic transitions — for catch-all 'any phase change' handlers.
  { name: "OnPhaseEnter",         source: "PhaseManager",       direction: "listen", description: "Fires on every phase transition (any direction). Use to gate logic that runs on ANY phase change." },
  { name: "OnPhaseExit",          source: "PhaseManager",       direction: "listen", description: "Fires on every phase transition (any direction)." },
  // Specific per-phase variants — let OnSignal filter without checking var:phase.
  { name: "OnPhaseEnter_0",       source: "PhaseManager",       direction: "listen", description: "Fires when entering phase 0 (initial / full HP)." },
  { name: "OnPhaseEnter_1",       source: "PhaseManager",       direction: "listen", description: "Fires when entering phase 1 (HP crossed first threshold)." },
  { name: "OnPhaseEnter_2",       source: "PhaseManager",       direction: "listen", description: "Fires when entering phase 2 (HP crossed second threshold)." },
  { name: "OnPhaseExit_0",        source: "PhaseManager",       direction: "listen", description: "Fires when exiting phase 0." },
  { name: "OnPhaseExit_1",        source: "PhaseManager",       direction: "listen", description: "Fires when exiting phase 1." },
  { name: "OnPhaseExit_2",        source: "PhaseManager",       direction: "listen", description: "Fires when exiting phase 2." },
];

/** Just the names — kept for compatibility with older code that consumed a
 *  flat string array (e.g. the legacy BUILT_IN_SIGNALS in CharacterOverview).
 *  New code should consume `BUILT_IN_SIGNALS_REGISTRY` directly so it gets
 *  the source labels too. */
export const BUILT_IN_SIGNAL_NAMES: string[] = BUILT_IN_SIGNALS_REGISTRY.map((s) => s.name);
