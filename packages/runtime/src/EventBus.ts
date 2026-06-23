/**
 * Per-Sprite event bus for behavior → event signalling.
 *
 * Frame-scoped peek semantics with **one-frame carryover**: an event emitted
 * at any point during frame N is visible to readers throughout frame N AND
 * throughout frame N+1, then dropped. This is critical because the tick order
 * is `behaviors update` → `triggers fire` — so a trigger action like
 * `EmitEvent("EXEDASH")` is emitted AFTER behaviors check it. The carryover
 * means the behavior sees the emit on the next frame (1-frame delay,
 * imperceptible at 60fps but functionally critical).
 *
 * Listeners (subscribe-style) are kept for cases that need imperative reaction
 * (e.g. Dialogue waiting on an Interact press) and fire on emit, no carryover.
 */

export type EventName = string;
export type Listener = (payload?: unknown) => void;

export class EventBus {
  /** Events emitted during the current frame. */
  private readonly fired = new Set<EventName>();
  /** Events emitted during the PREVIOUS frame (rotated in by `flush()`). */
  private readonly firedPrev = new Set<EventName>();
  private readonly listeners = new Map<EventName, Set<Listener>>();

  emit(name: EventName, payload?: unknown): void {
    this.fired.add(name);
    const subs = this.listeners.get(name);
    if (!subs || subs.size === 0) return;
    // Snapshot before iterating — a listener that subscribes / unsubscribes
    // during emit (e.g. one-shot handlers that call off() on themselves, or
    // an action chain that wires a new OnSignal in response) would skip
    // siblings or fire newly-added listeners mid-loop without this copy.
    // (audit HIGH #39)
    const snapshot = [...subs];
    for (const fn of snapshot) {
      // Per-listener try/catch — one buggy handler shouldn't kill the rest
      // of the fanout (and corrupt firedThisFrame state mid-emit).
      // (audit AUDIT_2026-06-05 #3)
      try { fn(payload); } catch (e) { console.warn(`[EventBus] listener for "${name}" threw`, e); }
    }
  }

  /** True if `name` was emitted during this frame OR the previous frame.
   *  The carryover is critical for behavior↔trigger ordering: a behavior
   *  that emits AFTER triggers check shouldn't lose the signal. */
  firedThisFrame(name: EventName): boolean {
    return this.fired.has(name) || this.firedPrev.has(name);
  }

  /** True if `name` was emitted during the CURRENT frame only — ignores
   *  the one-frame carryover. Triggers that already matched last frame
   *  check this to avoid re-firing on stale carryover (e.g. OnSignal
   *  printing "hello" twice for a single button click because the
   *  signal lingers in firedPrev). */
  firedExactlyThisFrame(name: EventName): boolean {
    return this.fired.has(name);
  }

  on(name: EventName, fn: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Subscriber count for `name`. Used by broadcast paths
   *  (OnCameraPanEnd, OnSceneEnd) to skip the per-sprite emit when nobody's
   *  listening — at 5000 NPCs a blind fanout is a multi-second frame spike. */
  listenerCount(name: EventName): number {
    return this.listeners.get(name)?.size ?? 0;
  }

  /**
   * Rotate frame buffers: previous-frame set drops, current-frame set becomes
   * previous, current is cleared. Called at the end of every Sprite.tick().
   */
  flush(): void {
    this.firedPrev.clear();
    for (const name of this.fired) this.firedPrev.add(name);
    this.fired.clear();
  }

  /** Hard-reset BOTH frame buffers (current AND carryover). `flush()` only
   *  rotates — it leaves this frame's emissions in `firedPrev`, so a signal
   *  emitted the same frame a sprite is pooled/loaded would be a ghost
   *  `firedThisFrame()` hit on the reactivated sprite's first frame. Used by
   *  clearRuntimeState (pool reactivate + LoadSlot). Listeners are untouched. */
  clearAll(): void {
    this.fired.clear();
    this.firedPrev.clear();
  }
}
