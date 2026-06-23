import Phaser from "phaser";
import type { Sprite } from "../Sprite";
import { getDialogueRunner } from "./DialogueRunner";
import { evalExpression } from "../sm/eval";
import { getInputActions } from "../input/InputActions";

/**
 * DialogFlowRunner — declarative trigger table evaluator. Reads the project's
 * `dialogFlow.triggers` list, subscribes to the appropriate signals/events,
 * and plays the right dialog when a trigger fires + conditions match.
 *
 * Doesn't replace the `PlayDialogue` action — coexists with it. Authors can
 * still wire dialog playback explicitly in event sheets; this is the
 * declarative path for the common "this NPC plays this dialog when player
 * interacts in chapter X with HP > 50" pattern.
 *
 * Lifecycle:
 *   - Created per-scene in runProject.ts after the spawn pass
 *   - On init: subscribes to OnInteract / scene-enter / per-signal listeners
 *   - On scene shutdown: unsubs (handled via scene's SHUTDOWN event)
 *
 * Matching algorithm (for OnInteract):
 *   1. Filter triggers where `kind === "OnInteract"` AND speakerBpId matches
 *      the interacted NPC's BP (AND instanceName if set)
 *   2. Drop one-shot triggers that already fired
 *   3. Evaluate conditions on each — drop those that don't pass
 *   4. Sort by priority descending
 *   5. Play the first survivor via DialogueRunner.play(dialogueId)
 *   6. Mark one-shots as fired
 */

interface DialogFlowCondition {
  id: string;
  left: string;
  op: "==" | "!=" | "<" | ">" | "<=" | ">=" | "contains";
  right: string;
}

interface DialogFlowTrigger {
  id: string;
  chapterId: string;
  speakerBpId: string;
  instanceName?: string;
  dialogueId: string;
  kind: "OnInteract" | "OnEnterScene" | "OnSignal";
  signalName?: string;
  /** When kind = "OnInteract" with a tracerName set, the runner auto-polls
   *  this tracer each tick and fires when justHit + actor matches speaker.
   *  Empty = no auto-polling; the trigger relies on manual `InteractWithNPC`
   *  action calls instead. */
  tracerName?: string;
  /** Optional: only check tracers on instances of this BP id. Empty = scan
   *  every BP (legacy global match). */
  tracerHostBpId?: string;
  /** Optional: BP id of the OTHER actor in the tracer hit. Empty = anyone. */
  interactorBpId?: string;
  /** Optional: limit the interactor to a specific named placement. */
  interactorInstanceName?: string;
  /** Optional input action that must be just-pressed on top of the tracer
   *  hit for OnInteract to fire. Empty = no key required (fires on hit edge). */
  interactAction?: string;
  conditions: DialogFlowCondition[];
  priority: number;
  oneShot: boolean;
}

export const DIALOG_FLOW_KEY = "peaky.dialogFlow";

export class DialogFlowRunner {
  private scene: Phaser.Scene;
  private triggers: DialogFlowTrigger[];
  /** Set of one-shot trigger ids that have already fired this game session.
   *  Persisted via the scene data manager so save/load round-trips correctly
   *  (DialogueRunner already uses the same pattern). */
  private firedOnce = new Set<string>();
  /** Unsub handles for the per-signal listeners we set up in init(). */
  private signalUnsubs: Array<() => void> = [];
  /** One-shot diagnostic flag — logs the auto-poll trigger list on the
   *  first update tick. Helps the author confirm "yes the runner sees
   *  my triggers and is watching tracer X." Cleared after first emit. */
  private _loggedInit = false;
  /** Per-trigger "we couldn't find the named tracer" log dedup so the
   *  console doesn't fill up with the same misconfig warning every tick. */
  private _missingTracerLogged = new Set<string>();
  /** Throttle map for _explainNoFire — keyed by trigger id, value is the
   *  scene-time ms of the last log. Caps the diagnostic at ~1 / sec / trigger. */
  private _explainLastMs = new Map<string, number>();

  constructor(scene: Phaser.Scene, triggers: DialogFlowTrigger[]) {
    this.scene = scene;
    this.triggers = triggers;
  }

  /** Wire up listeners. Call once after the spawn pass — by then every BP
   *  instance exists on `peaky.sprites`, so trigger queries can resolve. */
  init(): void {
    // OnEnterScene — fire immediately for any matching trigger.
    for (const t of this.triggers) {
      if (t.kind !== "OnEnterScene") continue;
      this.maybeFire(t);
    }
    // OnSignal — subscribe one listener per unique signal name. The
    // listener queries every matching trigger when the signal fires.
    const onSignalTriggers = this.triggers.filter((t) => t.kind === "OnSignal" && !!t.signalName);
    const signalNames = Array.from(new Set(onSignalTriggers.map((t) => t.signalName!)));
    for (const name of signalNames) {
      const handler = () => {
        // Snapshot at fire-time so a trigger that fires + mutates the list
        // (e.g. one-shot marking) doesn't perturb iteration.
        const matches = onSignalTriggers.filter((t) => t.signalName === name);
        for (const t of matches) this.maybeFire(t);
      };
      this.scene.events.on(name, handler);
      this.signalUnsubs.push(() => this.scene.events.off(name, handler));
    }
    // Cleanup on scene shutdown.
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  /** Per-tick poll for tracer-driven OnInteract triggers. Wired into the
   *  scene's UPDATE event from runProject.ts. Walks each OnInteract trigger
   *  that declares a `tracerName` — scans every sprite, finds the tracer
   *  by name, checks `justHit` edge + optional key requirement, and fires
   *  matching triggers automatically. No event-sheet wiring required.
   *
   *  Tick-cost is bounded by (# OnInteract triggers with tracerName) ×
   *  (# sprites). Typical project: a handful of triggers, ~20 sprites,
   *  ~negligible.
   */
  update(_delta: number): void {
    const list = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const ia = getInputActions(this.scene);
    for (const t of this.triggers) {
      if (t.kind !== "OnInteract") continue;
      if (!t.tracerName) continue;
      if (t.oneShot && this.firedOnce.has(t.id)) continue;
      // Optional key gate — when set, require justPressed THIS frame.
      if (t.interactAction) {
        if (!ia || !ia.justPressed(t.interactAction)) continue;
      }
      // Find any sprite carrying a tracer of the requested name whose
      // current hit matches our speaker. Tracer's `justHit` flips true
      // on the frame the hit actor changes — edge-triggered by design,
      // so a player standing in the zone doesn't re-fire every tick.
      // For triggers with a key gate, we don't care about justHit
      // (the key press itself is the edge); a key press while standing
      // in the zone is enough.
      const requireEdge = !t.interactAction;
      let hitNpc: Sprite | null = null;
      let tracerFound = false;
      // The speaker NPC can be EITHER side of the tracer hit:
      //   1) Tracer host == speaker (NPC's own "talk zone" detects player):
      //      the NPC carries the tracer, target is whatever walked in.
      //   2) Tracer target == speaker (player's interact-tracer hits NPC):
      //      the player carries the tracer, target is the NPC.
      // Both setups are legitimate. Walk every sprite, find tracers with the
      // configured name, check both sides for a speaker match.
      outer: for (const s of list) {
        if (s.destroyed) continue;
        // Filter by host BP when the author specified one — narrows the scan
        // and prevents same-named tracers on other BPs from accidentally
        // matching (e.g. both player and NPC declared a tracer "ZONE").
        if (t.tracerHostBpId && s.blueprintId !== t.tracerHostBpId) continue;
        const tracers = s.findBehaviorsByKind?.("Tracer") as Array<{
          name?: string; justHit?: boolean; lastHit?: { actorUid?: number; actorTags?: string[] } | null;
        }> | undefined;
        if (!tracers) continue;
        for (const tracer of tracers) {
          if (tracer.name !== t.tracerName) continue;
          tracerFound = true;
          if (requireEdge && !tracer.justHit) continue;
          if (!tracer.lastHit) continue;
          const targetUid = tracer.lastHit.actorUid;
          if (targetUid === undefined) continue;
          const target = list.find((sp) => sp.uid === targetUid && !sp.destroyed);
          if (!target) continue;
          // Speaker can be the tracer's TARGET or the tracer's HOST. For each
          // candidate (speakerSide, otherSide), check both speaker AND
          // interactor filters. interactorBpId optional — when set, the OTHER
          // side must match it (lets author wire NPC ↔ NPC conversations
          // where only NPC_B entering NPC_A's tracer fires the dialogue, not
          // the player wandering past).
          const sides: Array<[Sprite, Sprite]> = [[target, s], [s, target]];
          for (const [speakerSide, otherSide] of sides) {
            if (t.speakerBpId && speakerSide.blueprintId !== t.speakerBpId) continue;
            if (t.instanceName && speakerSide.instanceName !== t.instanceName) continue;
            if (t.interactorBpId && otherSide.blueprintId !== t.interactorBpId) continue;
            if (t.interactorInstanceName && otherSide.instanceName !== t.interactorInstanceName) continue;
            hitNpc = speakerSide;
            break outer;
          }
        }
      }
      if (!tracerFound && t.tracerName) {
        // Spam-guarded: only log this once per trigger per session so the
        // console doesn't fill up if the user mis-typed a tracer name.
        if (!this._missingTracerLogged.has(t.id)) {
          this._missingTracerLogged.add(t.id);
          console.warn(`[DialogFlow] trigger "${t.dialogueId}" references tracer "${t.tracerName}" but no sprite carries a tracer with that name (with hostBpId filter "${t.tracerHostBpId ?? ""}"). Available tracer names on live sprites: [${this._listTracerNames(list).join(", ") || "(none)"}]`);
        }
      }
      if (hitNpc) this.fireBestMatch([t], hitNpc);
    }
  }

  /** Called by the engine when a player interacts with an NPC. The Interact
   *  flow (key press near tagged NPC, etc.) is project-level wiring — we
   *  just expose this entry point. */
  handleInteract(npc: Sprite): void {
    const matches = this.triggers.filter((t) =>
      t.kind === "OnInteract"
      && t.speakerBpId === npc.blueprintId
      && (!t.instanceName || t.instanceName === npc.instanceName)
    );
    this.fireBestMatch(matches, npc);
  }

  /** Internal — for OnEnterScene / OnSignal where there's no specific
   *  interacted NPC. Picks the trigger's speakerBpId instance as the
   *  evaluation context when available (so `self.X` resolves to that NPC).
   *  Falls back to ANY sprite when the speaker isn't placed in this
   *  scene — narration-style OnEnterScene triggers shouldn't require a
   *  speaker instance to exist. */
  private maybeFire(t: DialogFlowTrigger): void {
    let evalSprite: Sprite | null = null;
    if (t.speakerBpId) evalSprite = this.findSpeakerInstance(t);
    if (!evalSprite) {
      // Speaker missing or not set — pick any live sprite for evalExpression
      // context (only used by condition expressions; conditionless triggers
      // ignore it entirely). `self.X` won't resolve to the intended NPC
      // but most OnEnterScene triggers either have no conditions or check
      // global vars (`var:Player.hp`, `var:flag.shop_opened`).
      const list = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      evalSprite = list.find((s) => !s.destroyed) ?? null;
      if (!evalSprite) return; // truly empty scene — can't evaluate anything
    }
    this.fireBestMatch([t], evalSprite);
  }

  /** Picks the best matching trigger (highest priority, conditions pass,
   *  not already one-shot-fired) and plays its dialog. */
  private fireBestMatch(candidates: DialogFlowTrigger[], evalSprite: Sprite): void {
    const eligible = candidates
      .filter((t) => !(t.oneShot && this.firedOnce.has(t.id)))
      .filter((t) => this.conditionsPass(t.conditions, evalSprite))
      .sort((a, b) => b.priority - a.priority);
    if (eligible.length === 0) return;
    const winner = eligible[0];
    const runner = getDialogueRunner(this.scene);
    if (!runner) return;
    // Dialog's per-line speakers come from its own script's speakerMap;
    // we don't override here. The trigger's `speakerBpId` is used by the
    // editor to organize the timeline + match interactions, NOT to
    // re-assign who speaks each line at runtime.
    runner.play(winner.dialogueId);
    if (winner.oneShot) this.firedOnce.add(winner.id);
  }

  /** Evaluate every condition; ALL must pass. Empty list = unconditional. */
  private conditionsPass(conds: DialogFlowCondition[], sprite: Sprite): boolean {
    if (!conds || conds.length === 0) return true;
    for (const c of conds) {
      if (!this.evalCondition(c, sprite)) return false;
    }
    return true;
  }

  /** Single-condition eval. Numeric ops use evalExpression; string ops
   *  ("contains") fall back to raw string comparison. */
  private evalCondition(c: DialogFlowCondition, sprite: Sprite): boolean {
    const leftN = evalExpression(sprite, String(c.left));
    const rightN = evalExpression(sprite, String(c.right));
    // Numeric path — when both sides resolve as numbers.
    if (typeof leftN === "number" && typeof rightN === "number") {
      switch (c.op) {
        case "==": return leftN === rightN;
        case "!=": return leftN !== rightN;
        case "<":  return leftN <  rightN;
        case ">":  return leftN >  rightN;
        case "<=": return leftN <= rightN;
        case ">=": return leftN >= rightN;
        case "contains": return String(leftN).includes(String(rightN));
      }
    }
    // String path — raw literal comparison when either side isn't numeric.
    const lStr = String(c.left);
    const rStr = String(c.right);
    switch (c.op) {
      case "==": return lStr === rStr;
      case "!=": return lStr !== rStr;
      case "contains": return lStr.includes(rStr);
      default: return false; // numeric ops on non-numeric values fail
    }
  }

  /** List every distinct tracer name found across the live sprite set.
   *  Used by the "tracer not found" diagnostic to print author-friendly
   *  alternatives so a typo is immediately obvious. */
  private _listTracerNames(list: Sprite[]): string[] {
    const out = new Set<string>();
    for (const s of list) {
      if (s.destroyed) continue;
      const tracers = s.findBehaviorsByKind?.("Tracer") as Array<{ name?: string }> | undefined;
      if (!tracers) continue;
      for (const t of tracers) if (t.name) out.add(t.name);
    }
    return Array.from(out).sort();
  }

  /** Diagnostic — when a tracer with the right name IS present but the
   *  trigger isn't firing, walk every candidate and explain why. Fires once
   *  per trigger so the console doesn't flood. */
  private _explainNoFire(t: DialogFlowTrigger, list: Sprite[]): void {
    console.warn(
      `[DialogFlow] trigger "${t.dialogueId}" (speaker ${t.speakerBpId}, tracer "${t.tracerName}", hostBpId "${t.tracerHostBpId ?? ""}", interactorBpId "${t.interactorBpId ?? ""}") is NOT firing despite the tracer being present. Per-candidate reasons:`,
    );
    for (const s of list) {
      if (s.destroyed) continue;
      if (t.tracerHostBpId && s.blueprintId !== t.tracerHostBpId) continue;
      const tracers = s.findBehaviorsByKind?.("Tracer") as Array<{
        name?: string; justHit?: boolean; lastHit?: { actorUid?: number } | null;
      }> | undefined;
      if (!tracers) continue;
      for (const tracer of tracers) {
        if (tracer.name !== t.tracerName) continue;
        const reqEdge = !t.interactAction;
        const targetUid = tracer.lastHit?.actorUid;
        const target = targetUid !== undefined
          ? list.find((sp) => sp.uid === targetUid && !sp.destroyed)
          : null;
        console.warn(
          `  · host "${s.blueprintName}" (uid ${s.uid}, bpId ${s.blueprintId}) tracer "${tracer.name}":` +
          ` justHit=${tracer.justHit}, requireEdge=${reqEdge},` +
          ` lastHit.actorUid=${targetUid ?? "(none)"},` +
          ` target=${target ? `${target.blueprintName} (bpId ${target.blueprintId})` : "(no live target)"}.` +
          ` Speaker check: speakerBpId="${t.speakerBpId}"; ` +
          ` would need target.blueprintId===speakerBpId OR host.blueprintId===speakerBpId.`,
        );
      }
    }
  }

  /** Find an instance of the trigger's speakerBpId. Prefers the named
   *  instance when `instanceName` is set; otherwise first match wins. */
  private findSpeakerInstance(t: DialogFlowTrigger): Sprite | null {
    const list = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of list) {
      if (s.destroyed) continue;
      if (s.blueprintId !== t.speakerBpId) continue;
      if (t.instanceName && s.instanceName !== t.instanceName) continue;
      return s;
    }
    return null;
  }

  destroy(): void {
    for (const unsub of this.signalUnsubs) unsub();
    this.signalUnsubs.length = 0;
  }
}

/** Convenience accessor for code that needs the per-scene runner reference
 *  (e.g. the engine's Interact dispatch flow). */
export function getDialogFlowRunner(scene: Phaser.Scene): DialogFlowRunner | undefined {
  return scene.data.get(DIALOG_FLOW_KEY) as DialogFlowRunner | undefined;
}
