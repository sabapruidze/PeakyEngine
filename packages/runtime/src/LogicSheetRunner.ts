import type { Sprite } from "./Sprite";
import { runAction, evaluateCondition, spritesByTag, numOr } from "./sm/eval";
import { isNavPointAvailable } from "./nav/navPoints";
import { persistentState } from "./PersistentState";
import { Logger } from "./Logger";
import type { Condition, ConditionKind } from "@peaky/shared";
import { getInputActions, pointerOverUiBlocker } from "./input/InputActions";
import type { StateAction, StateActionKind } from "@peaky/shared";
import { ACTION_KINDS } from "@peaky/shared";

/** O(1) set lookup so the generic pass-through doesn't scan ACTION_KINDS
 *  on every action firing. Built once at module load. */
const ENGINE_ACTION_KINDS: Set<string> = new Set(ACTION_KINDS as string[]);

/**
 * Per-BP Logic Sheet runtime. The editor authors a node graph per event
 * (trigger → action / condition / branch nodes wired via exec + typed
 * data edges). This module subscribes to triggers when a sprite spawns,
 * walks the graph when a trigger fires, and unsubscribes on destroy.
 *
 * MVP scope: graph execution is a stub — every event registers its
 * trigger and prints a `[LogicSheet]` line when fired. Real node walking
 * + action dispatch lands once the editor's xyflow canvas can author
 * non-empty graphs.
 */

export type LogicTriggerKind =
  | "OnCreate"
  | "OnDestroyed"
  | "OnCollide"
  | "OnOverlap"
  | "OnSeparate"
  | "OnSignal"
  | "OnComboStep"
  | "OnKeyPressed"
  | "OnKeyHeld"
  | "OnKeyReleased"
  | "OnDoubleKeyPressed"
  | "InputCombo"
  | "OnDamageTaken"
  | "OnHealed"
  | "OnBlocked"
  | "OnDeath"
  | "OnItemAdded"
  | "OnItemRemoved"
  | "OnInventoryFull"
  | "OnAnimationEnd"
  | "OnAnyAnimationEnd"
  | "OnEveryNSeconds"
  | "OnStateEnter"
  | "OnStateMain"
  | "OnStateExit"
  | "OnJump"
  | "OnLand"
  | "OnFall"
  | "OnDashStart"
  | "OnDashEnd"
  | "OnMoved"
  | "OnStopped"
  | "OnArrived"
  | "OnNavFailed"
  | "OnAnyPointArrived"
  | "OnPointArrived"
  | "OnTopdownDirectionChanged"
  | "OnTracerHit"
  | "OnTracerLost"
  | "OnTracedBy"
  | "OnUntracedBy"
  | "OnSquashStretchEnd"
  | "OnParticleBurstEnd"
  | "OnAnimatorAnimEnd"
  | "OnTick"
  | "OnSceneStart"
  | "OnSpriteObjectCreate"
  | "OnSpriteObjectDestroy"
  | "OnCollideWithSpriteObject"
  | "OnOverlapWithSpriteObject"
  | "OnSceneEnd"
  | "OnSaveLoadComplete"
  | "OnCameraPanEnd"
  | "OnMouseButtonPressed"
  | "OnMouseButtonReleased"
  | "OnMouseClick"
  | "OnMouseDoubleClick"
  | "OnMouseWheel"
  | "OnObjectClicked"
  | "OnObjectDoubleClicked"
  | "OnTweenStart"
  | "OnTweenFinish"
  | "OnDialogueStart"
  | "OnDialogueLine"
  | "OnDialogueEnd"
  | "OnLoadStart"
  | "OnLoadProgress"
  | "OnLoadComplete"
  | "OnAIStateEnter"
  | "OnAIStateExit"
  | "OnTargetSighted"
  | "OnTargetLost"
  | "OnTileDestroyed"
  | "OnTileDamaged"
  | "OnTileDrop";

/** Legacy single-trigger-per-event shape — preserved as a type alias
 *  so external consumers of `@peaky/runtime` keep compiling. Triggers
 *  now live inside the graph as nodes with `kind: "trigger"`. */
export interface LogicTriggerNode {
  id: string;
  kind: LogicTriggerKind;
  params: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface LogicGraphNode {
  id: string;
  kind: "trigger" | "action" | "condition" | "branch" | "literal" | "varRead" | "getter" | "comment";
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface LogicGraphEdge {
  id: string;
  source: string;
  sourcePin: string;
  target: string;
  targetPin: string;
  pinType: "exec" | "number" | "string" | "boolean" | "spriteRef";
}

export interface LogicFolder {
  id: string;
  name: string;
  graph: { nodes: LogicGraphNode[]; edges: LogicGraphEdge[] };
}

export interface LogicSheet {
  folders: LogicFolder[];
}

interface AttachedSheet {
  unsubs: Array<() => void>;
  /** Active `DebounceWait` timers keyed by their author-supplied tag.
   *  Each new call with the same tag cancels the prior timer and starts
   *  a fresh one — so a stack of overlapping "show then hide after 1s"
   *  chains collapses to a single "hide 1s after the LAST call." */
  debounce: Map<string, Phaser.Time.TimerEvent>;
  /** Monotonic generation counter per debounce tag. Each new
   *  DebounceWait invocation bumps the tag's generation; the timer
   *  callback captures its generation at scheduling and bails when it
   *  doesn't match — defense against Phaser TimerEvent.remove(false)
   *  failing to cancel a callback that's already queued for dispatch
   *  on the same tick. */
  debounceGen: Map<string, number>;
  /** Teardown closures for in-flight async wait nodes (WaitForKeyPress /
   *  WaitForAnim / WaitForSignal). Each removes its scene listener / timer.
   *  Cleared if the sprite is destroyed mid-wait so a `scene.events`/timer
   *  doesn't outlive the sprite. Each wait removes its own entry on resolve. */
  waitCleanups: Set<() => void>;
  /** Per-node counter for Flip-Flop / Sequence routing nodes (keyed by node
   *  id). Holds the NEXT output index. Per-sprite so each instance routes
   *  independently. */
  routerIndex: Map<string, number>;
}

const ATTACHED = new WeakMap<Sprite, AttachedSheet>();

export function attachLogicSheet(sprite: Sprite, sheet: LogicSheet | undefined): void {
  if (!sheet || !sheet.folders || sheet.folders.length === 0) return;
  // Idempotence — if any caller (HMR re-init, save-load reattach, scene
  // restart) invokes us twice for the same sprite, the second call would
  // double-subscribe every trigger and `OnJump → action` would fire 2×
  // per real emit. Tear down the prior attachment first so the new set
  // of subscriptions is the only one live.
  destroyLogicSheet(sprite);
  const state: AttachedSheet = { unsubs: [], debounce: new Map(), debounceGen: new Map(), waitCleanups: new Set(), routerIndex: new Map() };
  for (const folder of sheet.folders) {
    // Each `trigger` node in the folder's graph roots an independent
    // exec chain. Subscribe every one — graph execution starts from
    // that specific trigger node's exec output.
    for (const node of folder.graph.nodes) {
      if (node.kind !== "trigger") continue;
      const unsub = subscribeTrigger(sprite, folder, node);
      if (unsub) state.unsubs.push(unsub);
    }
  }
  ATTACHED.set(sprite, state);
}

export function destroyLogicSheet(sprite: Sprite): void {
  const state = ATTACHED.get(sprite);
  if (!state) return;
  for (const u of state.unsubs) {
    try { u(); } catch (e) { console.warn("LogicSheet unsub threw", e); }
  }
  // Cancel any pending DebounceWait timers so a destroyed / re-attached
  // sheet doesn't leave orphaned Phaser TimerEvents queued against a
  // dead sprite. Each timer's .remove() returns it to Phaser's pool.
  // Generation map also cleared so a re-attached sheet starts fresh.
  for (const t of state.debounce.values()) {
    try { t.remove(false); } catch (e) { console.warn("DebounceWait timer cleanup threw", e); }
  }
  state.debounce.clear();
  state.debounceGen.clear();
  // Tear down any in-flight wait nodes (their scene listeners / timers would
  // otherwise outlive the sprite). Snapshot first — each cleanup removes
  // itself from the set.
  for (const c of [...state.waitCleanups]) {
    try { c(); } catch (e) { console.warn("LogicSheet wait cleanup threw", e); }
  }
  state.waitCleanups.clear();
  ATTACHED.delete(sprite);
}

function subscribeTrigger(sprite: Sprite, folder: LogicFolder, trigger: LogicGraphNode): (() => void) | null {
  // `trigger.kind === "trigger"` and `trigger.type` carries the actual
  // engine event name (OnCollide / OnSignal / …). Execution begins at
  // this specific trigger node — `executeGraph` walks the exec edge
  // leaving `trigger.id`'s exec output.
  const fire = (payload?: unknown) => {
    // Deactivated group → this trigger does nothing until re-activated
    // (Set Group Active action). Keyed by the group/folder name.
    if (sprite._disabledGroups.has(folder.name)) return;
    // Collide/overlap/separate events pass the OTHER sprite as payload so a
    // `Get Collided Object` getter can read it during this run. Other triggers
    // pass nothing → clear it (avoid reading a stale prior collision).
    const other = (payload != null && typeof payload === "object" && "uid" in payload)
      ? (payload as Sprite)
      : null;
    sprite._eventOther = other;
    // The thing we collided/overlapped with becomes the PICKED instance, so the
    // chain can read ANY of its vars/fields inline — picked.CanPickBool,
    // picked.hp, picked.x, etc. A later ForEach/Pick in the chain overrides this
    // (last pick wins, matching Construct-3 order). Only set on a real other so
    // non-collision triggers leave the prior pick alone.
    if (other) sprite.scene?.data?.set("peaky.picked", other);
    executeGraph(sprite, folder, trigger.id);
  };
  const kind = trigger.type as LogicTriggerKind;
  switch (kind) {
    case "OnCreate": {
      // Fires synchronously during the spawn pass. Guard it: an exception in
      // an OnCreate action chain would otherwise propagate out of
      // attachLogicSheet and abort the rest of scene boot (later sprites
      // never spawn → "scene half-built, can't move").
      try { fire(); } catch (e) { console.warn(`[LogicSheet] OnCreate chain threw on uid=${sprite.uid}`, e); }
      return null;
    }
    case "OnDestroyed": {
      // Sprite.destroy() emits `_onDestroyed` on the bus BEFORE the
      // sprite is torn down, so action handlers can still read self.x /
      // vars / etc. Wait actions are dropped (the action queue is wiped
      // immediately after destroy).
      return sprite.events.on("_onDestroyed", fire);
    }
    case "OnCollide": {
      // Empty tag = ANY object; a tag filters to objects carrying it.
      const tag = String(trigger.params.tag ?? "");
      return sprite.events.on(tag ? `OnCollide_${tag}` : "OnCollide", fire);
    }
    case "OnSeparate": {
      const tag = String(trigger.params.tag ?? "");
      return sprite.events.on(tag ? `OnSeparate_${tag}` : "OnSeparate", fire);
    }
    case "OnOverlap": {
      // Continuous overlap — re-fires each tick. Implemented as a
      // collide+separate state machine for MVP: subscribe to both
      // edges, run on collide, ignore separate. Real per-tick walking
      // arrives when the executor learns to drive from a tick hook.
      const tag = String(trigger.params.tag ?? "");
      return sprite.events.on(tag ? `OnCollide_${tag}` : "OnCollide", fire);
    }
    case "OnSignal": {
      const sig = String(trigger.params.signal ?? "");
      if (!sig) return null;
      return sprite.events.on(sig, fire);
    }
    case "OnComboStep": {
      const st = String(trigger.params.state ?? "");
      const stepsRaw = trigger.params.steps;
      const steps = Array.isArray(stepsRaw) ? stepsRaw : [];
      if (!st || steps.length === 0) return null;
      const separate = !!trigger.params.separate;
      const nums = steps.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n >= 1);
      const unsubs = nums.map((n) => {
        if (!separate) return sprite.events.on(`OnComboStep_${st}_${n}`, fire);
        // Separate outputs: step n walks its own exec pin `step_<n>`.
        const fireStep = () => {
          if (sprite._disabledGroups.has(folder.name)) return;
          sprite._eventOther = null;
          const targets = findExecTargets(trigger.id, `step_${n}`, folder.graph.edges);
          for (const t of targets) executeGraph(sprite, folder, trigger.id, t);
        };
        return sprite.events.on(`OnComboStep_${st}_${n}`, fireStep);
      });
      return () => { for (const u of unsubs) u(); };
    }
    case "OnDamageTaken":      return sprite.events.on("OnDamageTaken", fire);
    case "OnDeath":            return sprite.events.on("OnDeath", fire);
    case "OnBlocked":          return sprite.events.on("OnBlocked", fire);
    case "OnItemAdded":        return sprite.events.on("OnItemAdded", fire);
    case "OnItemRemoved":      return sprite.events.on("OnItemRemoved", fire);
    case "OnInventoryFull":    return sprite.events.on("OnInventoryFull", fire);
    case "OnAnimationEnd": {
      const want = String(trigger.params.anim ?? "");
      return sprite.events.on("OnAnimationFinished", () => {
        if (want) {
          const sr = sprite.findBehaviorByKind("SpriteRenderer") as { currentAnimation?: string } | undefined;
          if (!sr || sr.currentAnimation !== want) return;
        }
        fire();
      });
    }
    case "OnAnyAnimationEnd":  return sprite.events.on("OnAnimationFinished", fire);
    case "OnSceneEnd":         return sprite.events.on("_sceneEnd",          fire);
    case "OnSaveLoadComplete": return sprite.events.on("_saveLoadComplete",  fire);
    case "OnCameraPanEnd":     return sprite.events.on("_cameraPanEnd",      fire);
    case "OnTileDestroyed":    return sprite.events.on("_tileDestroyed",    fire);
    case "OnTileDamaged":      return sprite.events.on("_tileDamaged",      fire);
    case "OnTileDrop":         return sprite.events.on("_tileDrop",         fire);
    case "OnTweenStart": {
      // Read `tweenTag` first (current field name) and fall back to legacy
      // `tag` so nodes saved before the rename keep working without
      // re-authoring. Without this fallback, fresh-created nodes (with
      // `tweenTag`) subscribed to the EMPTY tag and never fired.
      const tag = String(trigger.params.tweenTag ?? trigger.params.tag ?? "");
      return sprite.events.on(`_tweenStart:${tag}`, fire);
    }
    case "OnTweenFinish": {
      const tag = String(trigger.params.tweenTag ?? trigger.params.tag ?? "");
      return sprite.events.on(`_tweenFinish:${tag}`, fire);
    }
    case "OnMouseButtonPressed": {
      const want = trigger.params.button;
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed) return;
        if (pointerOverUiBlocker(sprite.scene)) return; // pointer over a blocking UI widget
        if (typeof want === "number" && ptr.button !== want) return;
        fire();
      };
      sprite.scene.input.on("pointerdown", handler);
      return () => sprite.scene.input.off("pointerdown", handler);
    }
    case "OnMouseButtonReleased": {
      const want = trigger.params.button;
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed) return;
        if (pointerOverUiBlocker(sprite.scene)) return; // pointer over a blocking UI widget
        if (typeof want === "number" && ptr.button !== want) return;
        fire();
      };
      sprite.scene.input.on("pointerup", handler);
      return () => sprite.scene.input.off("pointerup", handler);
    }
    case "OnMouseClick": {
      const want = trigger.params.button;
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed) return;
        if (pointerOverUiBlocker(sprite.scene)) return; // pointer over a blocking UI widget
        if (typeof want === "number" && ptr.button !== want) return;
        fire();
      };
      sprite.scene.input.on("pointerup", handler);
      return () => sprite.scene.input.off("pointerup", handler);
    }
    case "OnMouseDoubleClick": {
      const want = trigger.params.button;
      const windowSec = 0.5;
      let lastAt = -Infinity;
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed) return;
        if (pointerOverUiBlocker(sprite.scene)) return; // pointer over a blocking UI widget
        if (typeof want === "number" && ptr.button !== want) return;
        const now = sprite.scene.time.now / 1000;
        if (now - lastAt <= windowSec) {
          lastAt = -Infinity;
          fire();
        } else {
          lastAt = now;
        }
      };
      sprite.scene.input.on("pointerup", handler);
      return () => sprite.scene.input.off("pointerup", handler);
    }
    case "OnMouseWheel": {
      const handler = () => { if (!sprite.destroyed && !pointerOverUiBlocker(sprite.scene)) fire(); };
      sprite.scene.input.on("wheel", handler);
      return () => sprite.scene.input.off("wheel", handler);
    }
    case "OnObjectClicked": {
      // Fires when the user clicks on a sprite that matches THIS sprite's
      // BP (or its tags, when params.tag is set). Polled via pointerdown
      // + manual hit-test so we honor the engine's same-frame picking
      // rules (no drag, no continuous press).
      const wantTag = String(trigger.params.tag ?? "");
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed || !sprite.body) return;
        const wx = ptr.worldX ?? ptr.x + sprite.scene.cameras.main.scrollX;
        const wy = ptr.worldY ?? ptr.y + sprite.scene.cameras.main.scrollY;
        const b = sprite.body;
        const inside = wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom;
        if (!inside) return;
        if (wantTag && !sprite.tags.has(wantTag)) return;
        fire();
      };
      sprite.scene.input.on("pointerdown", handler);
      return () => sprite.scene.input.off("pointerdown", handler);
    }
    case "OnObjectDoubleClicked": {
      const wantTag = String(trigger.params.tag ?? "");
      const windowSec = 0.5;
      let lastAt = -Infinity;
      const handler = (ptr: Phaser.Input.Pointer) => {
        if (sprite.destroyed || !sprite.body) return;
        const wx = ptr.worldX ?? ptr.x + sprite.scene.cameras.main.scrollX;
        const wy = ptr.worldY ?? ptr.y + sprite.scene.cameras.main.scrollY;
        const b = sprite.body;
        const inside = wx >= b.x && wx <= b.right && wy >= b.y && wy <= b.bottom;
        if (!inside) return;
        if (wantTag && !sprite.tags.has(wantTag)) return;
        const now = sprite.scene.time.now / 1000;
        if (now - lastAt <= windowSec) {
          lastAt = -Infinity;
          fire();
        } else {
          lastAt = now;
        }
      };
      sprite.scene.input.on("pointerdown", handler);
      return () => sprite.scene.input.off("pointerdown", handler);
    }
    case "OnKeyPressed": {
      const actionName = String(trigger.params.action ?? "");
      if (!actionName) return null;
      const onUpdate = () => {
        if (sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (ia && ia.justPressed(actionName)) fire();
      };
      sprite.scene.events.on("update", onUpdate);
      return () => sprite.scene.events.off("update", onUpdate);
    }
    case "OnKeyHeld": {
      // Fires EVERY tick the named input action is held. Use for "while
      // holding sprint, drain stamina" style chains. For one-shot edge
      // detection use OnKeyPressed instead.
      const actionName = String(trigger.params.action ?? "");
      if (!actionName) return null;
      const onUpdate = () => {
        if (sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (ia && ia.isDown(actionName)) fire();
      };
      sprite.scene.events.on("update", onUpdate);
      return () => sprite.scene.events.off("update", onUpdate);
    }
    case "OnKeyReleased": {
      // Edge trigger — fires the single tick the key transitions from
      // down to up. Mirror of OnKeyPressed.
      const actionName = String(trigger.params.action ?? "");
      if (!actionName) return null;
      const onUpdate = () => {
        if (sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (ia && ia.justReleased(actionName)) fire();
      };
      sprite.scene.events.on("update", onUpdate);
      return () => sprite.scene.events.off("update", onUpdate);
    }
    case "InputCombo": {
      // Multi-key combo — fires on a frame where EVERY configured row
      // matches: held → action down, pressed → JustPressed, released →
      // JustReleased. One `pressed` row provides the edge; `held` rows
      // gate it. No time window, so it can't leak into the next press.
      const rows = (trigger.params.comboKeys as Array<{ mode?: string; action?: string }> | undefined) ?? [];
      if (rows.length === 0) return null;
      const onUpdate = () => {
        if (sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (!ia) return;
        for (const r of rows) {
          const a = String(r.action ?? "").trim();
          if (!a) return;
          const ok = r.mode === "pressed" ? ia.justPressed(a)
            : r.mode === "released" ? ia.justReleased(a)
            : ia.isDown(a);
          if (!ok) return;
        }
        fire();
      };
      sprite.scene.events.on("update", onUpdate);
      return () => sprite.scene.events.off("update", onUpdate);
    }
    case "OnDoubleKeyPressed": {
      // Double-tap detector — fires only when the same input action is
      // pressed TWICE within `windowSec` seconds. No gate node required;
      // wire OnDoubleKeyPressed { action, windowSec } directly to your
      // action chain.
      const actionName = String(trigger.params.action ?? "");
      const windowSec = Math.max(0.05, Number(trigger.params.windowSec ?? 0.3));
      if (!actionName) return null;
      let lastPressAt = -Infinity;
      const onUpdate = () => {
        if (sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (!ia || !ia.justPressed(actionName)) return;
        const now = sprite.scene.time.now / 1000;
        if ((now - lastPressAt) <= windowSec) {
          // Second press inside the window → fire and reset so a third
          // press starts a fresh pair (no auto-fire on every alternate
          // press after the first double-tap lands).
          lastPressAt = -Infinity;
          fire();
        } else {
          lastPressAt = now;
        }
      };
      sprite.scene.events.on("update", onUpdate);
      return () => sprite.scene.events.off("update", onUpdate);
    }
    case "OnEveryNSeconds": {
      // Interval accepts a wired number pin OR an expression (random(2,5) /
      // var:…) OR a plain number — resolved ONCE here at subscribe time. The
      // timer's delay is fixed per sprite, so random() gives each its own
      // cadence (e.g. sheep graze on staggered intervals). Min 0.05s.
      const nodeById = new Map(folder.graph.nodes.map((n) => [n.id, n]));
      const wired = resolveDataPin(trigger.id, "interval", folder.graph.edges, nodeById, sprite);
      const interval = Math.max(0.05, numOr(wired !== undefined ? wired : trigger.params.interval, 1, sprite));
      const timer = sprite.scene.time.addEvent({
        delay: interval * 1000,
        loop: true,
        callback: () => { if (!sprite.destroyed) fire(); },
      });
      return () => timer.remove(false);
    }
    case "OnStateEnter": {
      // Empty / "any" state = fire on EVERY state entry (generic emit).
      // Named state = fire only when that specific state is entered.
      const state = String(trigger.params.state ?? "").trim();
      const eventName = state && state !== "any" ? `OnStateEnter_${state}` : "OnStateEnter";
      return sprite.events.on(eventName, fire);
    }
    case "OnStateMain": {
      const state = String(trigger.params.state ?? "").trim();
      const eventName = state && state !== "any" ? `OnStateMain_${state}` : "OnStateMain";
      return sprite.events.on(eventName, fire);
    }
    case "OnStateExit": {
      const state = String(trigger.params.state ?? "").trim();
      const eventName = state && state !== "any" ? `OnStateExit_${state}` : "OnStateExit";
      return sprite.events.on(eventName, fire);
    }
    case "OnHealed":           return sprite.events.on("OnHealed",           fire);
    case "OnJump":             return sprite.events.on("OnJump",             fire);
    case "OnLand":             return sprite.events.on("OnLand",             fire);
    case "OnFall":             return sprite.events.on("OnFall",             fire);
    case "OnDashStart":        return sprite.events.on("OnDashStart",        fire);
    case "OnDashEnd":          return sprite.events.on("OnDashEnd",          fire);
    case "OnMoved":            return sprite.events.on("OnMoved",            fire);
    case "OnStopped":          return sprite.events.on("OnStopped",          fire);
    case "OnArrived":          return sprite.events.on("OnArrived",          fire);
    case "OnNavFailed":        return sprite.events.on("OnNavFailed",        fire);
    case "OnAnyPointArrived":  return sprite.events.on("OnAnyPointArrived",  fire);
    case "OnPointArrived": {
      const name = String(trigger.params.point ?? "");
      return sprite.events.on(name ? `OnPointArrived:${name}` : "OnAnyPointArrived", fire);
    }
    case "OnTopdownDirectionChanged": return sprite.events.on("OnTopdownDirectionChanged", fire);
    case "OnTracerHit": {
      const tracerName = String(trigger.params.tracer ?? "");
      const event = tracerName ? `OnTracerHit:${tracerName}` : "OnTracerHit";
      return sprite.events.on(event, fire);
    }
    case "OnTracerLost": {
      const tracerName = String(trigger.params.tracer ?? "");
      const event = tracerName ? `OnTracerLost:${tracerName}` : "OnTracerLost";
      return sprite.events.on(event, fire);
    }
    case "OnTracedBy": {
      // Fires on THIS sprite every sample a tracer IS hitting it (any tracer,
      // or one named — the tracer is owned by ANOTHER object). `tracer`
      // filters by name. For the inverse ("stopped hitting me for X sec"),
      // use OnUntracedBy below.
      const tracerName = String(trigger.params.tracer ?? "");
      const event = tracerName ? `OnTracedBy:${tracerName}` : "OnTracedBy";
      return sprite.events.on(event, fire);
    }
    case "OnUntracedBy": {
      // Fires once when a tracer that WAS hitting this sprite stops for
      // `forSeconds`. Implemented as a self-resetting timer on the same
      // OnTracedBy stream: every hit pushes the deadline out; when the tracer
      // goes quiet for the full window, the timer finally fires. Re-arms if
      // the tracer returns and leaves again.
      const tracerName = String(trigger.params.tracer ?? "");
      const event = tracerName ? `OnTracedBy:${tracerName}` : "OnTracedBy";
      const forSeconds = Math.max(0.05, Number(trigger.params.forSeconds ?? 1));
      let timer: Phaser.Time.TimerEvent | null = null;
      const onHit = () => {
        if (timer) timer.remove(false);
        timer = sprite.scene.time.delayedCall(forSeconds * 1000, () => {
          timer = null;
          if (!sprite.destroyed) fire();
        });
      };
      const off = sprite.events.on(event, onHit);
      return () => { off(); if (timer) timer.remove(false); };
    }
    case "OnSquashStretchEnd": return sprite.events.on("OnSquashStretchEnd", fire);
    case "OnParticleBurstEnd": {
      // Per-emitter filter via `target` param. Empty target → fires on
      // ANY emitter's burst end (legacy behavior). Named target →
      // fires only when that specific emitter ends, since the emitter
      // emits `_particleBurstEnd:<name>` in addition to the generic.
      const tgt = String(trigger.params.target ?? "").trim();
      const eventName = tgt ? `_particleBurstEnd:${tgt}` : "_particleBurstEnd";
      return sprite.events.on(eventName, fire);
    }
    case "OnAnimatorAnimEnd": {
      // Fires when a one-shot Animator anim completes (last keyframe
      // reached). Per-anim filter via `anim` param. Empty anim → fires
      // on ANY anim's end. Pair this with the Destroy action to defer
      // sprite teardown until a fade-out finishes, instead of relying
      // on a particle burst's lifetime to align with the anim duration.
      const want = String(trigger.params.anim ?? "").trim();
      const eventName = want ? `_animatorAnimEnd:${want}` : "_animatorAnimEnd";
      return sprite.events.on(eventName, fire);
    }
    case "OnTick":             return sprite.events.on("_tick",              fire);
    case "OnSceneStart":       return sprite.events.on("_sceneStart",        fire);
    case "OnSpriteObjectCreate": {
      // runProject (initial scene boot) and eval.ts (runtime
      // CreateSpriteObject) queue `peaky.pendingPlacementCreates`;
      // Game.ts drains it at the start of each frame and emits
      // `_placementCreate:<spriteId>` on every live sprite.
      const spriteId = String(trigger.params.spriteId ?? "").trim();
      const eventName = spriteId ? `_placementCreate:${spriteId}` : `_placementCreate`;
      return sprite.events.on(eventName, fire);
    }
    case "OnSpriteObjectDestroy": {
      const spriteId = String(trigger.params.spriteId ?? "").trim();
      const eventName = spriteId ? `_placementDestroy:${spriteId}` : `_placementDestroy`;
      return sprite.events.on(eventName, fire);
    }
    case "OnCollideWithSpriteObject": {
      const spriteId = String(trigger.params.spriteId ?? "").trim();
      const eventName = spriteId ? `_placementCollide:${spriteId}` : `_placementCollide`;
      return sprite.events.on(eventName, fire);
    }
    case "OnOverlapWithSpriteObject": {
      const spriteId = String(trigger.params.spriteId ?? "").trim();
      const eventName = spriteId ? `_placementOverlap:${spriteId}` : `_placementOverlap`;
      return sprite.events.on(eventName, fire);
    }
    case "OnDialogueEnd": {
      // Optional asset filter (dialogue NAME) — empty = any dialogue ending.
      const asset = String(trigger.params.asset ?? "");
      const name = asset ? `OnDialogueEnd:${asset}` : "OnDialogueEnd";
      const handler = () => { if (!sprite.destroyed) fire(); };
      sprite.scene.events.on(name, handler);
      return () => sprite.scene.events.off(name, handler);
    }
    case "OnLoadStart":
    case "OnLoadProgress":
    case "OnLoadComplete": {
      // Loading-screen events. The ScenePanel loader fans `_loadStart` /
      // `_loadProgress {pct}` / `_loadComplete` to every sprite that has a
      // listener — so subscribing here (a real `.on`) is what makes the
      // fanout reach this sprite. payload (e.g. {pct}) flows through `fire`.
      const ev = kind === "OnLoadStart" ? "_loadStart"
        : kind === "OnLoadProgress" ? "_loadProgress" : "_loadComplete";
      const handler = (payload?: unknown) => { if (!sprite.destroyed) fire(payload); };
      // EventBus.on returns its own unsubscribe — there is no `.off`.
      return sprite.events.on(ev, handler);
    }
    case "OnDialogueStart": {
      // Subscribe to the broad "OnDialogueStart" OR the
      // asset-filtered "OnDialogueStart:<asset>" depending on param.
      const asset = String(trigger.params.asset ?? "");
      const name = asset ? `OnDialogueStart:${asset}` : "OnDialogueStart";
      const handler = () => { if (!sprite.destroyed) fire(); };
      sprite.scene.events.on(name, handler);
      return () => sprite.scene.events.off(name, handler);
    }
    case "OnDialogueLine": {
      // Content match: fire when the shown line text CONTAINS the keyword(s).
      // matchAny=true → OR (any keyword present); false → AND (all present).
      // Empty keyword list = fire on EVERY line. Case-insensitive substring.
      const kwRaw = trigger.params.keywords;
      const caseSensitive = !!trigger.params.caseSensitive;
      const norm = (s: string) => (caseSensitive ? s : s.toLowerCase());
      if (trigger.params.separate) {
        // One exec output per keyword (pin `kw_<i>`, array index) — each fires
        // when the line contains THAT keyword. Matches are independent, so the
        // Any/All rule doesn't apply. Indices align with the editor's pins.
        const rawList = (Array.isArray(kwRaw) ? kwRaw : []).map((k) => String(k).trim());
        const handler = (payload?: unknown) => {
          if (sprite.destroyed || sprite._disabledGroups.has(folder.name)) return;
          sprite._eventOther = null;
          const text = norm(String((payload as { text?: unknown } | undefined)?.text ?? ""));
          rawList.forEach((k, i) => {
            if (!k || !text.includes(norm(k))) return;
            const targets = findExecTargets(trigger.id, `kw_${i}`, folder.graph.edges);
            for (const t of targets) executeGraph(sprite, folder, trigger.id, t);
          });
        };
        sprite.scene.events.on("OnDialogueLine", handler);
        return () => sprite.scene.events.off("OnDialogueLine", handler);
      }
      const keywords = (Array.isArray(kwRaw) ? kwRaw : [])
        .map((k) => norm(String(k).trim()))
        .filter(Boolean);
      const matchAny = !!trigger.params.matchAny;
      const handler = (payload?: unknown) => {
        if (sprite.destroyed) return;
        if (keywords.length > 0) {
          const text = norm(String((payload as { text?: unknown } | undefined)?.text ?? ""));
          const ok = matchAny
            ? keywords.some((k) => text.includes(k))
            : keywords.every((k) => text.includes(k));
          if (!ok) return;
        }
        fire(payload);
      };
      sprite.scene.events.on("OnDialogueLine", handler);
      return () => sprite.scene.events.off("OnDialogueLine", handler);
    }
    case "OnAIStateEnter": {
      // Empty / "any" state = fire on EVERY AI state entry (generic emit).
      const state = String(trigger.params.state ?? "").trim();
      const eventName = state && state !== "any" ? `OnAIStateEnter_${state}` : "OnAIStateEnter";
      return sprite.events.on(eventName, fire);
    }
    case "OnAIStateExit": {
      const state = String(trigger.params.state ?? "").trim();
      const eventName = state && state !== "any" ? `OnAIStateExit_${state}` : "OnAIStateExit";
      return sprite.events.on(eventName, fire);
    }
    case "OnTargetSighted":
      return sprite.events.on("OnTargetSighted", fire);
    case "OnTargetLost":
      return sprite.events.on("OnTargetLost", fire);
    default:
      return null;
  }
}

/** Synchronous recursion depth of executeGraph. Exec fan-out recurses for
 *  every EXTRA wired target, so an exec output looped back into an upstream
 *  fan-out node would recurse without bound — the per-fire linear `budget`
 *  only caps the inline walk, not the recursion. Async waits don't accumulate
 *  here: they return to the event loop, so the stack unwinds (finally runs)
 *  before their callback re-enters. */
let _execSyncDepth = 0;

/** Per-graph node index, built ONCE and reused — graphs are immutable during a
 *  Play session, but executeGraph runs per trigger fire AND per recursive exec
 *  fan-out / Wait-resume, so rebuilding `new Map(nodes.map(...))` every call was
 *  the graph runtime's biggest GC source at scale. Keyed by the graph object via
 *  a WeakMap, so it auto-evicts when a new Play rebuilds the graph. */
const _nodeIndexCache = new WeakMap<object, Map<string, LogicGraphNode>>();
function nodeIndexFor(graph: { nodes: LogicGraphNode[] }): Map<string, LogicGraphNode> {
  let m = _nodeIndexCache.get(graph);
  if (!m) {
    m = new Map(graph.nodes.map((n) => [n.id, n] as const));
    _nodeIndexCache.set(graph, m);
  }
  return m;
}

function executeGraph(sprite: Sprite, folder: LogicFolder, triggerNodeId: string, startNodeId?: string): void {
  // Dormant pooled sprites keep their trigger subscriptions (pool deactivate
  // doesn't detach the LogicSheet), so an EmitSignalTo-by-uid or a stray bus
  // emit could otherwise run a pooled sprite's exec graph while it's parked in
  // the pool. Gate every graph walk (trigger fires AND Wait-resumes) on it.
  if (sprite.destroyed || sprite._pooled) return;
  if (_execSyncDepth > 400) {
    console.warn("[LogicSheet] exec recursion depth limit hit — aborting chain (an exec output is likely wired back into an upstream node).");
    return;
  }
  _execSyncDepth++;
  try {
  // Walk exec edges from `triggerNodeId`'s exec output (or from
  // `startNodeId` for Wait-resume re-entries). Each visited node either
  // dispatches an action via the engine's runAction or forks on a
  // Branch's bool input. Cycle protection: hard 10k visit cap per fire.
  //
  // Exec FAN-OUT: an output pin may wire to MULTIPLE targets (Construct-style
  // "on this event, do A and B"). The walker follows the first target inline
  // (linear fast path) and dispatches each extra target as an independent
  // sub-walk via a recursive executeGraph call. Async nodes (Wait, etc.)
  // resume ALL their targets when they elapse.
  const { nodes, edges } = folder.graph;
  if (nodes.length === 0) return;
  const nodeById = nodeIndexFor(folder.graph);
  const initialTargets = startNodeId
    ? [startNodeId]
    : findExecTargets(triggerNodeId, "exec", edges);
  for (let i = 1; i < initialTargets.length; i++) {
    executeGraph(sprite, folder, triggerNodeId, initialTargets[i]);
  }
  let cur: string | null = initialTargets[0] ?? null;
  let budget = 10000;
  while (cur && budget-- > 0) {
    const node = nodeById.get(cur);
    if (!node) break;
    if (node.kind === "action" && node.type === "Wait") {
      const secs = Number(resolveOrParam(node, "seconds", edges, nodeById, sprite, 0));
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length && secs > 0) {
        sprite.scene.time.delayedCall(secs * 1000, () => {
          if (sprite.destroyed) return;
          for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
        });
      } else if (nexts.length) {
        for (let i = 1; i < nexts.length; i++) executeGraph(sprite, folder, triggerNodeId, nexts[i]);
        cur = nexts[0];
        continue;
      }
      return;
    }
    if (node.kind === "action" && node.type === "DebounceWait") {
      // Like Wait, but tag-keyed: a second call with the same tag CANCELS
      // the pending timer and restarts. The downstream exec fires once
      // when the timer finally elapses without being reset. Use for
      // "hide HP bar 1 second after the LAST hit" — overlapping
      // OnDamageTaken chains collapse to a single hide.
      const tag = String(resolveOrParam(node, "tag", edges, nodeById, sprite, "default"));
      const secs = Number(resolveOrParam(node, "seconds", edges, nodeById, sprite, 1));
      const nexts = findExecTargets(node.id, "exec", edges);
      const state = ATTACHED.get(sprite);
      // Bump generation BEFORE scheduling — any in-flight callback
      // captured an older generation and will bail when it fires.
      // Belt-and-braces alongside timer.remove(false) since Phaser's
      // remove doesn't always prevent a callback already queued for
      // dispatch on the same tick.
      const gen = (state?.debounceGen.get(tag) ?? 0) + 1;
      if (state) state.debounceGen.set(tag, gen);
      if (state) {
        const prev = state.debounce.get(tag);
        if (prev) prev.remove(false);
      }
      if (nexts.length && secs > 0) {
        const timer = sprite.scene.time.delayedCall(secs * 1000, () => {
          if (sprite.destroyed) return;
          const s = ATTACHED.get(sprite);
          // Stale-callback guard: if a newer DebounceWait with the same
          // tag bumped the generation while this timer was pending,
          // bail. Without this an early hit's cancelled timer could
          // still fire and run the hide chain prematurely.
          if (s && s.debounceGen.get(tag) !== gen) return;
          if (s) s.debounce.delete(tag);
          for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
        });
        if (state) state.debounce.set(tag, timer);
      } else if (nexts.length) {
        for (let i = 1; i < nexts.length; i++) executeGraph(sprite, folder, triggerNodeId, nexts[i]);
        cur = nexts[0];
        continue;
      }
      return;
    }
    if (node.kind === "action" && node.type === "WaitForKeyPress") {
      // Double-tap / confirm-window gate. When exec hits this node, watch
      // for the named input action's `justPressed` over the next `withinSec`
      // seconds. First press inside the window → continue exec chain.
      // Timeout with no press → chain terminates silently (no exec out).
      // Typical use: OnKeyPressed E → WaitForKeyPress E within 1s → Action.
      // The OUTER OnKeyPressed catches press #1; the inner waits for #2.
      const wantAction = String(node.params.action ?? "");
      const withinSec = Math.max(0.05, Number(node.params.withinSec ?? 1));
      const nexts = findExecTargets(node.id, "exec", edges);
      if (!wantAction || nexts.length === 0) return;
      const state = ATTACHED.get(sprite);
      let resolved = false;
      let timer: Phaser.Time.TimerEvent | undefined;
      // Idempotent teardown — removes the scene update listener + timeout and
      // de-registers from waitCleanups. Called on resume, timeout, or sprite
      // destroy (whichever first).
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        sprite.scene.events.off("update", onUpdate);
        timer?.remove(false);
        state?.waitCleanups.delete(cleanup);
      };
      const onUpdate = () => {
        if (resolved || sprite.destroyed) return;
        const ia = getInputActions(sprite.scene);
        if (ia && ia.justPressed(wantAction)) {
          cleanup();
          for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
        }
      };
      sprite.scene.events.on("update", onUpdate);
      timer = sprite.scene.time.delayedCall(withinSec * 1000, cleanup);
      state?.waitCleanups.add(cleanup);
      return;
    }
    if (node.kind === "action" && node.type === "WaitForAnim") {
      // Hold the exec chain until SpriteRenderer emits `OnAnimationFinished`
      // for the named anim. Subscribe once, resume when matched, then
      // unsubscribe. Empty `anim` param = resume on the next anim end of
      // any kind. Authors use this for "play death anim then destroy" style
      // chains without hardcoding the anim's duration.
      const wantAnim = String(node.params.anim ?? "");
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length === 0) return;
      const state = ATTACHED.get(sprite);
      let done = false;
      const cleanup = () => { if (done) return; done = true; unsub(); state?.waitCleanups.delete(cleanup); };
      const unsub = sprite.events.on("OnAnimationFinished", () => {
        if (sprite.destroyed || done) return;
        if (wantAnim) {
          const sr = sprite.findBehaviorByKind("SpriteRenderer") as { currentAnimation?: string } | undefined;
          if (!sr || sr.currentAnimation !== wantAnim) return;
        }
        cleanup();
        for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
      });
      state?.waitCleanups.add(cleanup);
      return;
    }
    if (node.kind === "action" && node.type === "WaitForSignal") {
      // Hold the exec chain until the named signal fires on THIS sprite.
      // Times out after WAIT_FOR_SIGNAL_TIMEOUT_SEC seconds to prevent a
      // typo / never-emitted signal from leaving the chain stalled forever.
      const want = String(node.params.signal ?? "");
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length === 0 || !want) return;
      const TIMEOUT_SEC = 30;
      const state = ATTACHED.get(sprite);
      let fired = false;
      const cleanup = () => { if (fired) return; fired = true; unsub(); timer?.remove(false); state?.waitCleanups.delete(cleanup); };
      const unsub = sprite.events.on(want, () => {
        if (sprite.destroyed || fired) return;
        cleanup();
        for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
      });
      const timer: Phaser.Time.TimerEvent = sprite.scene.time.delayedCall(TIMEOUT_SEC * 1000, () => {
        if (fired) return;
        cleanup();
        console.warn(`[LogicSheet] WaitForSignal "${want}" timed out after ${TIMEOUT_SEC}s — dropping subsequent actions in this chain.`);
      });
      state?.waitCleanups.add(cleanup);
      return;
    }
    if (node.kind === "action" && node.type === "Repeat") {
      // Run the downstream exec chain `times` times serially. The chain
      // shares state across iterations (SetVar / IncrementVar accumulate).
      // No async support — the body runs synchronously each iteration.
      // Author chains an explicit signal/listener pattern for "after-loop"
      // continuation (this node's exec output IS the body, not the tail).
      const times = Math.max(0, Math.floor(Number(node.params.times ?? 0)));
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length && times > 0) {
        for (let i = 0; i < times && !sprite.destroyed; i++) {
          for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
        }
      }
      return;
    }
    if (node.kind === "action" && node.type === "ForEach") {
      // Iterate every sprite carrying `tag` and run the body once per
      // sprite with that sprite as the executor context. Lets author
      // write "for each enemy, destroy" without per-sprite event sheets.
      const tag = String(node.params.tag ?? "");
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length === 0 || !tag) return;
      const targets = spritesByTag(sprite, tag).slice(); // copy — body may destroy iterated sprite
      for (const t of targets) {
        if (t.destroyed) continue;
        for (const nx of nexts) executeGraph(t, folder, triggerNodeId, nx);
      }
      return;
    }
    if (node.kind === "action" && node.type === "While") {
      // Loop the downstream chain while the bool input pin reads true.
      // Caps at `maxIter` to prevent an always-true condition from locking
      // the editor. Default 1000 iterations — comfortably more than any
      // sane game-logic loop, low enough to bail fast on accidents.
      const maxIter = Math.max(1, Math.floor(Number(node.params.maxIter ?? 1000)));
      const nexts = findExecTargets(node.id, "exec", edges);
      if (nexts.length === 0) return;
      let i = 0;
      while (i < maxIter && !sprite.destroyed) {
        const cond = evaluateBoolPin(node, "bool", edges, nodeById, sprite);
        if (!cond) break;
        for (const nx of nexts) executeGraph(sprite, folder, triggerNodeId, nx);
        i++;
      }
      if (i >= maxIter) {
        console.warn(`[LogicSheet] While loop hit maxIter=${maxIter} — likely an always-true condition. Raise maxIter or fix the condition.`);
      }
      return;
    }
    // Regular node: run its effect, then fan out. Walk extra exec targets
    // as independent sub-walks; continue this linear walk with the first.
    const nexts = stepNode(sprite, node, edges, nodeById, folder);
    for (let i = 1; i < nexts.length; i++) {
      executeGraph(sprite, folder, triggerNodeId, nexts[i]);
    }
    cur = nexts[0] ?? null;
  }
  } finally {
    _execSyncDepth--;
  }
}

function stepNode(
  sprite: Sprite,
  node: LogicGraphNode,
  edges: LogicGraphEdge[],
  nodeById: Map<string, LogicGraphNode>,
  folder: LogicFolder,
): string[] {
  if (sprite.destroyed) return [];
  if (node.kind === "action") {
    const action = nodeToAction(node, edges, nodeById, sprite);
    if (action) {
      // DebugPrint context injection — look up the inbound exec edge to
      // identify the previous node, then stuff its type + the folder name
      // into the action's config. The eval.ts handler reads `_sheet` /
      // `_prev` and formats them into the on-screen message. Keeps
      // the runner→eval contract simple (no extra params on runAction).
      if (action.kind === "DebugPrint") {
        const inbound = edges.find((e) => e.target === node.id && e.pinType === "exec");
        const outbound = edges.find((e) => e.source === node.id && e.pinType === "exec");
        const prevNode = inbound ? nodeById.get(inbound.source) : undefined;
        const nextNode = outbound ? nodeById.get(outbound.target) : undefined;
        (action as { config: Record<string, unknown> }).config = {
          ...action.config,
          _sheet: folder.name,
          _prev: prevNode?.type ?? "(trigger)",
          _next: nextNode?.type ?? "(end)",
        };
      }
      runAction(sprite, action);
    }
    return findExecTargets(node.id, "exec", edges);
  }
  if (node.kind === "branch") {
    if (node.type === "Switch") {
      const raw = resolveDataPin(node.id, "value", edges, nodeById, sprite);
      const v = raw == null ? "" : String(raw).trim();
      const cases = Array.isArray(node.params.cases)
        ? (node.params.cases as { id: string; value: unknown }[]) : [];
      const hit = cases.find((c) => String(c?.value ?? "").trim() === v);
      return findExecTargets(node.id, hit ? `case_${hit.id}` : "default", edges);
    }
    if (node.type === "DoOnce") {
      // Gate: forward exec the FIRST time only. Per-sprite state lives in
      // routerIndex (0 = armed, 1 = spent); cleared when the sheet re-attaches
      // (scene restart), so it's "once per run".
      const st = ATTACHED.get(sprite);
      if ((st?.routerIndex.get(node.id) ?? 0) > 0) return [];
      st?.routerIndex.set(node.id, 1);
      return findExecTargets(node.id, "out", edges);
    }
    if (node.type === "FlipFlop" || node.type === "Sequence" || node.type === "Random") {
      // Route ONE exec output per trigger. FlipFlop alternates out0/out1;
      // Sequence steps out0→out1→…→out0 (round-robin); Random picks one.
      const count = node.type === "FlipFlop" ? 2 : Math.max(2, Math.min(20, Math.floor(Number(node.params.count ?? 3))));
      let idx: number;
      if (node.type === "Random") {
        idx = Math.floor(Math.random() * count);
      } else {
        const st = ATTACHED.get(sprite);
        idx = (st?.routerIndex.get(node.id) ?? 0) % count;
        st?.routerIndex.set(node.id, (idx + 1) % count);
      }
      return findExecTargets(node.id, `out${idx}`, edges);
    }
    const condResult = evaluateBoolPin(node, "bool", edges, nodeById, sprite);
    return findExecTargets(node.id, condResult ? "true" : "false", edges);
  }
  if (node.type === "Combinator") {
    // OR-merge: any incoming exec fires the output. The walker reaches
    // this node when ANY upstream trigger / action exec edge lands here.
    // We just forward to whatever's wired to our `exec` output.
    return findExecTargets(node.id, "exec", edges);
  }
  // condition / literal / varRead are data-only — should not be reached
  // via exec walking. Treat as no-op and stop.
  return [];
}

function resolveOrParam(
  node: LogicGraphNode,
  key: string,
  edges: LogicGraphEdge[],
  nodeById: Map<string, LogicGraphNode>,
  sprite: Sprite,
  def: unknown,
): unknown {
  const wired = resolveDataPin(node.id, key, edges, nodeById, sprite);
  if (wired !== undefined) return wired;
  if (node.params[key] !== undefined) return node.params[key];
  return def;
}

// All exec targets wired to (sourceId, pin), in edge order. Exec outputs
// support fan-out (one output → many targets), so this returns every match
// rather than just the first.
function findExecTargets(sourceId: string, pin: string, edges: LogicGraphEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.pinType === "exec" && e.source === sourceId && e.sourcePin === pin) {
      out.push(e.target);
    }
  }
  return out;
}

export function nodeToAction(
  node: LogicGraphNode,
  edges: LogicGraphEdge[],
  nodeById: Map<string, LogicGraphNode>,
  sprite: Sprite,
): StateAction | null {
  // The 10 MVP action node `type`s map to engine StateActionKinds.
  // Params + data-input pins fill the StateAction `config`. Unknown
  // types are skipped (forward-compat: future node types added without
  // a runtime upgrade just no-op until the executor learns them).
  const type = node.type;
  const cfg: Record<string, unknown> = {};
  const id = node.id;
  function resolve(key: string, def: unknown): unknown {
    const wired = resolveDataPin(node.id, key, edges, nodeById, sprite);
    if (wired !== undefined) return wired;
    if (node.params[key] !== undefined) return node.params[key];
    return def;
  }
  let kind: StateActionKind | null = null;
  switch (type) {
    case "EmitSignal":
      kind = "EmitSignal";
      cfg.name = String(resolve("signal", ""));
      break;
    case "EmitSignalTo":
      // `tag` and `uid` are mutually-supportive targets — engine routes
      // to whichever is non-empty. Wiring a getter's `actorUid` output
      // into the `uid` data pin is the canonical "talk to the specific
      // sprite my tracer just hit" pattern.
      kind = "EmitSignalTo";
      cfg.signal = String(resolve("signal", ""));
      cfg.tag = String(resolve("tag", ""));
      cfg.uid = resolve("uid", "");
      break;
    case "SetVar":
      kind = "SetVar";
      cfg.name = String(resolve("var", ""));
      cfg.value = resolve("value", 0);
      break;
    case "IncrementVar":
      kind = "AddVar";
      cfg.name = String(resolve("var", ""));
      cfg.delta = Number(resolve("delta", 1));
      break;
    case "ToggleVar":
      kind = "ToggleBool";
      cfg.name = String(resolve("var", ""));
      break;
    case "PlayAnimation":
      kind = "PlayAnimation";
      cfg.animation = String(resolve("name", ""));
      break;
    case "PlayDialogue":
      kind = "PlayDialogue";
      cfg.dialogueId = String(resolve("dialogueId", ""));
      break;
    case "StopDialogue":
      kind = "StopDialogue";
      break;
    case "SetAIState": {
      // Directly poke AIBrain — no engine StateAction exists. Done here
      // rather than as a runAction dispatch, so return null so the
      // executor doesn't dispatch anything.
      const brain = sprite.findBehaviorByKind("AIBrain") as { setState?: (s: string) => void } | undefined;
      const state = String(resolve("state", ""));
      if (brain?.setState && state) brain.setState(state);
      return null;
    }
    case "SetAITarget": {
      const brain = sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
      const uid = Number(resolve("uid", -1));
      if (brain) brain.targetUid = uid;
      return null;
    }
    case "AlertNearbyAllies": {
      // Broadcast: every sprite within `radius` carrying `tag` gets its
      // AIBrain alerted. Uses the alertNearbyNpcs helper from AIBrain.ts
      // via the scene's sprite registry.
      const tag = String(resolve("tag", "enemy"));
      const radius = Number(resolve("radius", 200));
      const list = (sprite.scene.data.get("peaky.sprites") as Array<{ tags?: Set<string>; destroyed?: boolean; gameObject?: { x: number; y: number }; findBehaviorByKind?: (k: string) => unknown }> | undefined) ?? [];
      const ox = sprite.gameObject.x;
      const oy = sprite.gameObject.y;
      const r2 = radius * radius;
      for (const s of list) {
        if (s.destroyed) continue;
        if (!s.tags?.has(tag)) continue;
        const sx = s.gameObject?.x;
        const sy = s.gameObject?.y;
        if (typeof sx !== "number" || typeof sy !== "number") continue;
        const dx = sx - ox;
        const dy = sy - oy;
        if (dx * dx + dy * dy > r2) continue;
        const brain = s.findBehaviorByKind?.("AIBrain") as { alertFrom?: (x: number, y: number) => void } | undefined;
        brain?.alertFrom?.(ox, oy);
      }
      return null;
    }
    case "CreateObject":
      kind = "CreateObjectByName";
      cfg.blueprintName = String(resolve("bp", ""));
      cfg.x = resolve("x", 0);
      cfg.y = resolve("y", 0);
      cfg.layer = String(resolve("layer", ""));
      // Per-spawn variable overrides (the node's "set on spawn" rows). Pass the
      // raw map; the CreateObjectByName handler resolves each value (self.uid,
      // expressions, literals) against the SPAWNER.
      cfg.spawnVars = node.params.spawnVars;
      break;
    case "DropObject":
      // Spawn a blueprint (e.g. an item-pickup BP) with a pose. Same
      // CreateObjectByName runtime path as Create Object, plus per-spawn
      // instanceName / animation / frame / tag. mode "static" passes the frame
      // so the spawn FREEZES on it; "animation" omits frame so it plays.
      kind = "CreateObjectByName";
      cfg.blueprintName = String(resolve("bp", ""));
      cfg.x = resolve("x", 0);
      cfg.y = resolve("y", 0);
      cfg.layer = String(resolve("layer", ""));
      cfg.instanceName = String(resolve("instanceName", ""));
      cfg.tag = String(resolve("tag", ""));
      cfg.animation = String(resolve("animation", ""));
      cfg.spawnVars = node.params.spawnVars;
      if (String(resolve("mode", "animation")) === "static") {
        cfg.frame = resolve("frame", 0);
      }
      break;
    case "Destroy":
      kind = "Destroy";
      // "Remember (don't respawn)" — without copying this through, the engine
      // Destroy handler never sees it and the instance respawns on reload.
      cfg.persist = !!resolve("persist", false);
      break;
    case "Wait":
      // Wait is intercepted by executeGraph's main loop — control never
      // reaches nodeToAction. This case is defensive: if for any reason
      // a Wait node is dispatched here, it's a no-op.
      return null;
    case "PrintString":
      kind = "PrintString";
      cfg.message  = String(resolve("message", ""));
      cfg.duration = Number(resolve("duration", 2));
      cfg.color    = String(resolve("color", "#00ff88"));
      break;
    case "DebugPrint": {
      // Multi-row debug container. Each row's `message` may be wired in
      // via a per-row data pin `msg_<idx>` — when wired, the resolved
      // value overrides the literal text in node.params.rows[idx].message.
      // Color and duration stay literal-only (the inline DUR / color
      // swatch UI is the primary controls).
      kind = "DebugPrint";
      const rawRows = Array.isArray(node.params.rows) ? node.params.rows : [];
      cfg.rows = (rawRows as Array<{ message?: unknown; color?: unknown; duration?: unknown }>).map((row, idx) => {
        const wired = resolveDataPin(node.id, `msg_${idx}`, edges, nodeById, sprite);
        const message = wired !== undefined ? String(wired) : String(row.message ?? "");
        return { message, color: String(row.color ?? "#ff5555"), duration: Number(row.duration ?? 2) };
      });
      break;
    }
    case "SetBehaviorParam": {
      // One node can set MULTIPLE params on a component. `params` is an array
      // of { param, value }; legacy nodes carry a single param/value pair.
      kind = "SetBehaviorParam";
      const beh = String(resolve("behavior", ""));
      cfg.behaviorKind = beh;
      cfg.componentName = String(resolve("componentName", ""));
      const rawParams = node.params.params;
      const parr: { param: string; value: unknown }[] = Array.isArray(rawParams) && rawParams.length > 0
        ? rawParams.map((p, idx) => {
            const pp = p as { param?: unknown; value?: unknown };
            const wired = resolveDataPin(node.id, `pval_${idx}`, edges, nodeById, sprite);
            return { param: String(pp.param ?? ""), value: wired !== undefined ? wired : pp.value };
          })
        : [{ param: String(resolve("param", "")), value: resolve("value", 0) }];
      cfg.params = parr;
      // Legacy target for any other consumer.
      cfg.target = beh && parr[0] ? `${beh}.${parr[0].param}` : "";
      break;
    }
    case "SetBehaviorEnabled":
      kind = "SetBehaviorEnabled";
      cfg.behavior = String(resolve("behavior", ""));
      cfg.enabled  = resolve("enabled", true) ? 1 : 0;
      break;
    case "ApplyDamage": {
      // Damage the sprite this chain is ABOUT — `_eventOther` (the sprite
      // we collided/overlapped/tracer-hit) when the trigger provides one,
      // else self (poison / spike / DOT on the host). Source = the actor,
      // so knockback + i-frames + sourceUid resolve correctly.
      const amount = Number(resolve("amount", 0));
      const target = sprite._eventOther ?? sprite;
      const dmg = target.findBehaviorByKind("Damageable") as { applyDamage?: (n: number, src?: Sprite) => boolean } | undefined;
      if (dmg && amount > 0) dmg.applyDamage?.(amount, sprite);
      return null;
    }
    case "Heal": {
      // Mirror of ApplyDamage — heal the event target when present (heal an
      // ally you touched), else self (heal pickup / regen on the host).
      const amount = Number(resolve("amount", 0));
      const target = sprite._eventOther ?? sprite;
      const dmg = target.findBehaviorByKind("Damageable") as { heal?: (n: number) => number } | undefined;
      if (dmg && amount > 0) dmg.heal?.(amount);
      return null;
    }
    default: {
      // Generic pass-through for every other engine StateActionKind.
      // The palette's auto-generated entries use the StateActionKind
      // string as the node `type`, with params matching ACTION_DEFAULTS
      // shape. That means we can build a StateAction directly: each
      // param key resolves through data-pin wiring or the literal node
      // value, then becomes the cfg key the engine action handler
      // reads. Unknown / non-engine types still return null.
      if (!ENGINE_ACTION_KINDS.has(type)) return null;
      for (const key of Object.keys(node.params)) {
        const v = resolve(key, node.params[key]);
        if (v !== undefined) cfg[key] = v;
      }
      return { id, kind: type as StateActionKind, config: cfg };
    }
  }
  return { id, kind, config: cfg };
}

// Per-frame roll cache for the Random node's SYNC mode. When sync is on, the
// `string` and `number` output pins must report the SAME rolled index — but
// each pin is resolved by a separate readDataOut call. Caching the roll by
// (sprite, node) for the current frame makes both pulls agree, while a new
// frame re-rolls. Keyed loosely by sprite uid + node id.
const _randomSyncRoll = new Map<string, { frame: number; index: number }>();
/** Per-frame cache for GetTaggedTile's `random` pick — so the x and y output
 *  pins (resolved by separate readDataOut calls) report the SAME tile. Keyed
 *  by `uid:tag`. */
const _taggedTileRoll = new Map<string, { frame: number; index: number; count: number }>();
/** Drop the Random-node per-frame sync cache. Module-level + keyed by
 *  `uid:nodeId`, so without this it accumulates across scene restarts /
 *  GoToLayout for the life of the page. Called from MainScene.create(). */
export function clearRandomSyncCache(): void {
  _randomSyncRoll.clear();
  _taggedTileRoll.clear();
}
function syncedRandomIndex(sprite: Sprite, nodeId: string, count: number): number {
  if (count <= 0) return 0;
  const frame = sprite.scene.game.loop.frame;
  const key = `${sprite.uid}:${nodeId}`;
  const cached = _randomSyncRoll.get(key);
  if (cached && cached.frame === frame && cached.index < count) return cached.index;
  const index = Math.floor(Math.random() * count);
  _randomSyncRoll.set(key, { frame, index });
  return index;
}

function resolveDataPin(
  targetId: string,
  pin: string,
  edges: LogicGraphEdge[],
  nodeById: Map<string, LogicGraphNode>,
  sprite: Sprite,
): unknown {
  for (const e of edges) {
    if (e.pinType === "exec") continue;
    if (e.target !== targetId || e.targetPin !== pin) continue;
    const src = nodeById.get(e.source);
    if (!src) return undefined;
    return readDataOut(src, e.sourcePin, sprite, edges, nodeById);
  }
  return undefined;
}

function readDataOut(node: LogicGraphNode, pin: string, sprite: Sprite, edges: LogicGraphEdge[], nodeById: Map<string, LogicGraphNode>): unknown {
  if (node.kind === "literal") return node.params.value;
  if (node.kind === "varRead") {
    const name = String(node.params.var ?? "");
    return sprite.vars.get(name);
  }
  if (node.kind === "condition") {
    return evalConditionNode(node, sprite, edges, nodeById);
  }
  if (node.kind === "getter") {
    // Dispatch on node.type. Each getter resolves to a typed value
    // (number / string / boolean) that flows through the data wire.
    if (node.type === "And" || node.type === "Or" || node.type === "Not") {
      // Boolean logic over wired condition/getter inputs. `a` (and `b` for
      // And/Or) are boolean data pins; wire conditions into them and feed the
      // `out` into a Branch's bool input. Unwired input = false.
      const a = !!resolveDataPin(node.id, "a", edges, nodeById, sprite);
      if (node.type === "Not") return !a;
      const b = !!resolveDataPin(node.id, "b", edges, nodeById, sprite);
      return node.type === "And" ? (a && b) : (a || b);
    }
    if (node.type === "RandomPick") {
      // Pure generator — rolls on pull. `string` / `number` output pins.
      // sync ON → both pins share one rolled index (paired lists); sync OFF →
      // each pin rolls independently. Either pin can be used alone.
      const strings = Array.isArray(node.params.strings) ? (node.params.strings as unknown[]) : [];
      const numbers = Array.isArray(node.params.numbers) ? (node.params.numbers as unknown[]) : [];
      const sync = !!node.params.sync;
      if (sync) {
        const i = syncedRandomIndex(sprite, node.id, Math.max(strings.length, numbers.length));
        if (pin === "string") return strings.length ? String(strings[Math.min(i, strings.length - 1)] ?? "") : "";
        return numbers.length ? Number(numbers[Math.min(i, numbers.length - 1)] ?? 0) : 0;
      }
      if (pin === "string") return strings.length ? String(strings[Math.floor(Math.random() * strings.length)] ?? "") : "";
      return numbers.length ? Number(numbers[Math.floor(Math.random() * numbers.length)] ?? 0) : 0;
    }
    if (node.type === "RandomRange") {
      // Pure generator — rolls a number in [min, max] on pull. Whole (float
      // off) = integer inclusive of both ends; Decimal = float. min/max accept
      // expressions (var:/self./literals) resolved via numOr.
      const lo = numOr(node.params.min, 0, sprite);
      const hi = numOr(node.params.max, 10, sprite);
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      if (node.params.float) return a + Math.random() * (b - a);
      return Math.floor(a + Math.random() * (b - a + 1));
    }
    if (node.type === "GetSlotItem") {
      const inv = sprite.findBehaviorByKind("Inventory") as
        | { slots?: { itemId: string; qty: number }[] } | undefined;
      // Slot index can be wired in (e.g. Read variable → slot) or typed literally.
      const wiredSlot = resolveDataPin(node.id, "slot", edges, nodeById, sprite);
      const idx = Math.floor(Number(wiredSlot !== undefined ? wiredSlot : (node.params.slot ?? 0)));
      const slot = inv?.slots?.[idx];
      return slot && slot.qty > 0 ? slot.itemId : "";
    }
    if (node.type === "GetListValue") {
      // Read a value out of a read-only List (named group of key→value entries).
      // field = value (entry by `key`) | length (entry count).
      const field = String(node.params.field ?? "value");
      const rec = persistentState().lists[String(node.params.list ?? "")];
      if (field === "length") return rec ? Object.keys(rec).length : 0;
      const key = String(node.params.key ?? "");
      const v = rec?.[key];
      return v === undefined ? 0 : v;
    }
    if (node.type === "GetGlobalValue") {
      // Read a global var / array. `index` can be wired (Read variable → index)
      // or typed. field = value (scalar/array-length) | item (element) | length.
      const field = String(node.params.field ?? "value");
      const wiredIdx = resolveDataPin(node.id, "index", edges, nodeById, sprite);
      const idx = Math.floor(Number(wiredIdx !== undefined ? wiredIdx : (node.params.index ?? 0)));
      const value = persistentState().globals[String(node.params.global ?? "")];
      if (field === "length") return Array.isArray(value) ? value.length : 0;
      if (field === "value") return Array.isArray(value) ? value.length : (value ?? 0);
      if (Array.isArray(value)) { const e = value[idx]; return e === undefined ? 0 : e; }
      return 0;
    }
    if (node.type === "GetOtherObject") {
      // The sprite this event collided/overlapped/separated with (set on fire).
      // Identity (name/tag/uid) stays valid even after the other sprite is
      // destroyed — a pickup that despawns on collect is the common case, and
      // the collect chain runs in the same tick. Only bail if there was no
      // event object at all. Position falls back to 0 once the body is gone.
      const o = sprite._eventOther;
      const isStr = pin === "name" || pin === "tag" || pin === "instanceTag";
      if (!o) return isStr ? "" : 0;
      switch (pin) {
        case "name":        return o.instanceName || o.blueprintName || "";
        case "tag":         return [...o.tags][0] ?? "";
        case "instanceTag": return [...o.instanceTags][0] ?? "";
        case "uid":         return o.uid;
        case "x":           return o.gameObject?.x ?? 0;
        case "y":           return o.gameObject?.y ?? 0;
        default:            return 0;
      }
    }
    if (node.type === "GetPicked") {
      // The PICKED instance — collide/overlap auto-picks the other sprite, and
      // ForEach/Pick conditions set it too. Reads one field/var via `field`.
      const o = sprite.scene?.data?.get("peaky.picked") as Sprite | undefined;
      const field = String(node.params.field ?? "x");
      const isStr = field === "name" || field === "tag" || field === "instanceTag";
      if (!o || o.destroyed) return isStr ? "" : 0;
      const obj = o.gameObject;
      const body = o.body;
      switch (field) {
        case "x":           return obj?.x ?? 0;
        case "y":           return obj?.y ?? 0;
        case "vx":          return body?.velocity.x ?? 0;
        case "vy":          return body?.velocity.y ?? 0;
        case "angle":       return obj?.angle ?? 0;
        case "scale":       return obj?.scale ?? 0;
        case "scaleX":      return obj?.scaleX ?? 0;
        case "scaleY":      return obj?.scaleY ?? 0;
        case "alpha":       return obj?.alpha ?? 0;
        case "uid":         return o.uid;
        case "name":        return o.instanceName || o.blueprintName || "";
        case "tag":         return [...o.tags][0] ?? "";
        case "instanceTag": return [...o.instanceTags][0] ?? "";
        default: {
          // Anything else is one of the BP's variable names (chosen from the
          // read dropdown). Bool → 1/0 so it branches cleanly.
          const raw = o.vars.get(field);
          if (typeof raw === "boolean") return raw ? 1 : 0;
          if (typeof raw === "number") return raw;
          const n = Number(raw);
          return Number.isFinite(n) ? n : 0;
        }
      }
    }
    if (node.type === "GetTaggedTile") {
      // Find a big/animated tile placement carrying `tag` and return its world
      // position — so an NPC can MoveTo a "bush" tile and mine it. Reads the
      // live `peaky.bigTileImages` registry (auto-removed when a tile is mined).
      // `pick`: nearest to this sprite, or random. ONE node exposes x / y /
      // count as separate output pins; `pin` selects which. Random is cached
      // per frame so the x and y pins (two readDataOut calls) pick the SAME tile.
      const tag = String(node.params.tag ?? "");
      const pick = String(node.params.pick ?? "nearest");
      const list = sprite.scene?.data?.get("peaky.bigTileImages") as Array<{ img?: { active?: boolean; getBounds?: () => { centerX: number; centerY: number }; x?: number; y?: number }; tags?: string[] }> | undefined;
      const matches = (list ?? []).filter((e) => e.img && e.img.active !== false && (e.tags ?? []).includes(tag));
      if (pin === "count") return matches.length;
      // No tile matches → return the asking sprite's OWN position, so a wired
      // MoveTo targets itself (a no-op, stays put) instead of yanking every NPC
      // to the world origin (0,0) — which looked like all the sheep "retreating"
      // for the frame between a bush being eaten and the re-query finding a new
      // one. Gate movement on the `count` pin if you want explicit idle/wander.
      if (matches.length === 0) return pin === "y" ? sprite.gameObject.y : sprite.gameObject.x;
      const centerOf = (e: typeof matches[number]) => {
        const b = e.img?.getBounds?.();
        return b ? { x: b.centerX, y: b.centerY } : { x: e.img?.x ?? 0, y: e.img?.y ?? 0 };
      };
      let chosen = matches[0];
      if (pick === "random") {
        const frame = sprite.scene?.game.loop.frame ?? 0;
        // Key by TAG (not node id) so the SEPARATE x and y getter nodes — read
        // in the same chain — roll the SAME tile. Node-id keying would pick a
        // different tile per getter, sending the NPC to (tileA.x, tileB.y).
        const key = `${sprite.uid}:${tag}`;
        const cached = _taggedTileRoll.get(key);
        let idx: number;
        if (cached && cached.frame === frame && cached.count === matches.length) idx = cached.index;
        else { idx = Math.floor(Math.random() * matches.length); _taggedTileRoll.set(key, { frame, index: idx, count: matches.length }); }
        chosen = matches[Math.min(idx, matches.length - 1)];
      } else {
        const sx = sprite.gameObject.x, sy = sprite.gameObject.y;
        let bestD = Infinity;
        for (const e of matches) {
          const c = centerOf(e);
          const d = (c.x - sx) ** 2 + (c.y - sy) ** 2;
          if (d < bestD) { bestD = d; chosen = e; }
        }
      }
      const c = centerOf(chosen);
      return pin === "y" ? c.y : c.x;
    }
    if (node.type === "GetNavPoint") {
      // World position (x/y) or count of a nav-mesh WAYPOINT matched by name or
      // tag. Empty point = all waypoints. `pick`: nearest to this sprite / random.
      const want = String(node.params.point ?? "").trim();
      const pick = String(node.params.pick ?? "nearest");
      const grid = sprite.scene?.data?.get("peaky.navGrid") as { waypoints: { id: string; x: number; y: number; name?: string; tags: string[]; singleUse?: boolean; srcMap?: string; srcX?: number; srcY?: number }[] } | undefined;
      const matches = (grid?.waypoints ?? []).filter((w) => isNavPointAvailable(sprite.scene, w, sprite.uid) && (!want || w.name === want || (w.tags ?? []).includes(want)));
      if (pin === "count") return matches.length;
      if (matches.length === 0) return pin === "y" ? sprite.gameObject.y : sprite.gameObject.x;
      let chosen = matches[0];
      if (pick === "random") {
        const frame = sprite.scene?.game.loop.frame ?? 0;
        const key = `${sprite.uid}:nav:${want}`;
        const cached = _taggedTileRoll.get(key);
        let idx: number;
        if (cached && cached.frame === frame && cached.count === matches.length) idx = cached.index;
        else { idx = Math.floor(Math.random() * matches.length); _taggedTileRoll.set(key, { frame, index: idx, count: matches.length }); }
        chosen = matches[Math.min(idx, matches.length - 1)];
      } else {
        const sx = sprite.gameObject.x, sy = sprite.gameObject.y;
        let bestD = Infinity;
        for (const w of matches) { const d = (w.x - sx) ** 2 + (w.y - sy) ** 2; if (d < bestD) { bestD = d; chosen = w; } }
      }
      return pin === "y" ? chosen.y : chosen.x;
    }
    if (node.type === "GetLastNavPoint") {
      // The most-recently arrived-at waypoint (set by MoveTo on On Point Arrived).
      const field = String(node.params.field ?? "name");
      const last = sprite.scene?.data?.get("peaky.lastNavPoint") as { name: string; x: number; y: number } | undefined;
      if (!last) return field === "name" ? "" : 0;
      if (field === "x") return last.x;
      if (field === "y") return last.y;
      return last.name;
    }
    if (node.type === "GetLastTile") {
      // The most-recently mined/hit tile (set by damageTile/BigTile/AnimatedTile,
      // read after On Tile Damaged / On Tile Destroyed). Damaged snapshot wins
      // when both exist this tick (it's the newer event + carries HP).
      const damaged = sprite.scene?.data?.get("peaky.lastDamagedTile") as Record<string, unknown> | undefined;
      const destroyed = sprite.scene?.data?.get("peaky.lastDestroyedTile") as Record<string, unknown> | undefined;
      const last = damaged ?? destroyed;
      const field = String(node.params.field ?? "x");
      const isStr = field === "tag" || field === "name" || field === "tilemap" || field === "layer";
      if (!last) return isStr ? "" : 0;
      switch (field) {
        case "x":       return Number(last.x ?? 0);
        case "y":       return Number(last.y ?? 0);
        case "c":       return Number(last.c ?? 0);
        case "r":       return Number(last.r ?? 0);
        case "hp":      return Number(last.nextHP ?? 0);
        case "maxHP":   return Number(last.maxHP ?? 0);
        case "tag":     return ((last.tags as string[] | undefined) ?? []).join(",");
        case "name":    return String(last.name ?? "");
        case "tilemap": return String(last.tilemap ?? "");
        case "layer":   return String(last.layer ?? "");
        default:        return 0;
      }
    }
    if (node.type === "GetLastDrop") {
      // The most-recent tile drop (set by _spawnTileDrops, read after On Tile
      // Drop). `bp` = dropped blueprint name, `count` = how many, x/y = world.
      const last = sprite.scene?.data?.get("peaky.lastDrop") as Record<string, unknown> | undefined;
      const field = String(node.params.field ?? "bp");
      const isStr = field === "bp" || field === "layer";
      if (!last) return isStr ? "" : 0;
      switch (field) {
        case "bp":    return String(last.bp ?? "");
        case "count": return Number(last.count ?? 0);
        case "x":     return Number(last.x ?? 0);
        case "y":     return Number(last.y ?? 0);
        case "layer": return String(last.layer ?? "");
        default:      return 0;
      }
    }
    if (node.type === "GetTracerField") {
      const tracerName = String(node.params.tracer ?? "");
      const field = String(node.params.field ?? "hitX");
      const all = sprite.findBehaviorsByKind("Tracer") as unknown as Array<{ name?: string; lastHit?: Record<string, unknown> | null; _calcGeom?: () => { px: number; py: number; ex: number; ey: number } }>;
      const tracer = tracerName
        ? all.find((t) => t.name === tracerName)
        : all[0];
      const hit = tracer?.lastHit;
      switch (field) {
        case "hit":       return hit ? 1 : 0;
        case "hitX":      return hit ? Number(hit.hitX ?? 0) : 0;
        case "hitY":      return hit ? Number(hit.hitY ?? 0) : 0;
        case "actorX":    return hit ? Number(hit.actorX ?? 0) : 0;
        case "actorY":    return hit ? Number(hit.actorY ?? 0) : 0;
        case "actorName": return hit ? String(hit.actorName ?? "") : "";
        case "actorUid":  return hit ? Number(hit.actorUid ?? 0) : 0;
        case "actorTags": return hit ? ((hit.actorTags as string[] | undefined) ?? []).join(",") : "";
        case "distance":  return hit ? Number(hit.distance ?? 0) : 0;
        // Live trace-line geometry (valid even with no hit) — matches the
        // `tracer:NAME.startX` expression path.
        case "startX":    return tracer?._calcGeom?.().px ?? 0;
        case "startY":    return tracer?._calcGeom?.().py ?? 0;
        case "endX":      return tracer?._calcGeom?.().ex ?? 0;
        case "endY":      return tracer?._calcGeom?.().ey ?? 0;
        default:          return 0;
      }
    }
    if (node.type === "GetTags") {
      // CSV of the subject sprite's current tags. Includes runtime-added
      // tags from EditTags, not just BP/instance authored ones.
      return [...sprite.tags].join(",");
    }
    if (node.type === "GetSceneName") {
      // Name of the Peaky scene currently active. runProject sets
      // `peaky.activeSceneName` when each scene boots; we fall back to
      // the Phaser scene key for safety (it'll be "main" in that case).
      return String(sprite.scene.data.get("peaky.activeSceneName") ?? sprite.scene.scene.key ?? "");
    }
    if (node.type === "CountByTag") {
      // Live count of sprites carrying `tag`. Uses peaky.spritesByTag for
      // O(1) lookup — same index that powers picking + OnCollide_<tag>.
      const tag = String(node.params.tag ?? "").trim();
      if (!tag) return 0;
      const byTag = sprite.scene.data.get("peaky.spritesByTag") as Map<string, Set<Sprite>> | undefined;
      const set = byTag?.get(tag);
      if (!set) return 0;
      let n = 0;
      for (const s of set) if (!s.destroyed) n++;
      return n;
    }
    return 0;
  }
  return node.params[pin];
}

function evaluateBoolPin(
  node: LogicGraphNode,
  pin: string,
  edges: LogicGraphEdge[],
  nodeById: Map<string, LogicGraphNode>,
  sprite: Sprite,
): boolean {
  const v = resolveDataPin(node.id, pin, edges, nodeById, sprite);
  return !!v;
}

function evalConditionNode(node: LogicGraphNode, sprite: Sprite, _edges?: LogicGraphEdge[], _nodeById?: Map<string, LogicGraphNode>): boolean {
  const type = node.type;
  // Every typed param on a condition node can also be driven by a wired pin
  // (rule: any field that accepts a typed value must also accept a pin).
  // Pin value, when present, overrides the typed param. Without this merge,
  // wiring e.g. `picked.instanceTag` into CompareValues.left would be a
  // visual no-op — the runtime would still read the typed string.
  const p = (() => {
    if (!_edges || !_nodeById) return node.params;
    const merged: Record<string, unknown> = { ...node.params };
    for (const key of Object.keys(node.params)) {
      const wired = resolveDataPin(node.id, key, _edges, _nodeById, sprite);
      if (wired !== undefined) merged[key] = wired;
    }
    return merged;
  })();
  switch (type) {
    case "VarEquals": {
      const v = sprite.vars.get(String(p.var ?? ""));
      return v === p.value || String(v) === String(p.value);
    }
    case "VarAbove":  return Number(sprite.vars.get(String(p.var ?? "")) ?? 0) > Number(p.value ?? 0);
    case "VarBelow":  return Number(sprite.vars.get(String(p.var ?? "")) ?? 0) < Number(p.value ?? 0);
    case "VarTrue":   return !!sprite.vars.get(String(p.var ?? ""));
    case "VarFalse":  return !sprite.vars.get(String(p.var ?? ""));
    case "IsOverlappingTag": {
      const tag = String(p.tag ?? "");
      for (const other of sprite._currOverlap) {
        if (other.tags.has(tag)) return true;
      }
      return false;
    }
    case "IsAnimationPlaying": {
      const sr = sprite.findBehaviorByKind("SpriteRenderer") as { currentAnimation?: string } | undefined;
      return sr?.currentAnimation === String(p.anim ?? "");
    }
    case "IsState": {
      const an = sprite.findBehaviorByKind("StateMachine") as { currentState?: string } | undefined;
      return an?.currentState === String(p.state ?? "");
    }
    case "IsGrounded": {
      const cm = sprite.findBehaviorByKind("CharacterMovement") as { isGrounded?: boolean } | undefined;
      return !!cm?.isGrounded;
    }
    case "IsByWall": {
      // Read Phaser arcade body blocked/touching directly — CM doesn't
      // surface a `byWall` field, it just consults the body inline. We
      // do the same here so the condition works whether or not CM has
      // declared wallSliding (e.g. while grounded next to a wall).
      const body = (sprite as unknown as { body?: { blocked?: { left?: boolean; right?: boolean }; touching?: { left?: boolean; right?: boolean } } }).body;
      if (!body) return false;
      const left  = body.blocked?.left  || body.touching?.left;
      const right = body.blocked?.right || body.touching?.right;
      return !!(left || right);
    }
    case "IsDialoguePlaying": {
      const runner = sprite.scene.data.get("peaky.dialogue") as
        | { isPlaying?: () => boolean }
        | undefined;
      return !!runner?.isPlaying?.();
    }
    case "IsAIState": {
      const brain = sprite.findBehaviorByKind("AIBrain") as { state?: string } | undefined;
      return brain?.state === String(p.state ?? "");
    }
    case "IsTargetSighted": {
      // Target was sighted within the last 0.2s — uses AIBrain's
      // internal sight-edge timer indirectly via the targetUid lock.
      const brain = sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
      return !!brain && (brain.targetUid ?? -1) !== -1;
    }
    case "DistanceToTargetBelow": {
      const brain = sprite.findBehaviorByKind("AIBrain") as { targetUid?: number } | undefined;
      if (!brain || (brain.targetUid ?? -1) === -1) return false;
      const list = sprite.scene.data.get("peaky.sprites") as Array<{ uid: number; destroyed: boolean; gameObject?: { x: number; y: number } }> | undefined;
      const target = list?.find((s) => s.uid === brain.targetUid && !s.destroyed);
      if (!target || !target.gameObject) return false;
      const dx = target.gameObject.x - sprite.gameObject.x;
      const dy = target.gameObject.y - sprite.gameObject.y;
      const threshold = Number(p.value ?? 0);
      return (dx * dx + dy * dy) < (threshold * threshold);
    }
    default: {
      // Generic pass-through: build a `Condition` from node.type + params
      // and delegate to the engine's full evaluator. Lets every legacy
      // engine ConditionKind become available as a Logic Sheet condition
      // node without per-kind code here. Auto-generated palette entries
      // use kind-matching `type` + ACTION_DEFAULTS-shaped params for this
      // to line up.
      const c: Condition = { kind: type as ConditionKind, ...p };
      return evaluateCondition(sprite, c);
    }
  }
}
