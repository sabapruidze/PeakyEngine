import { BEHAVIOR_DEFAULTS } from "../project";
import type { BehaviorInstance, BlueprintDef, LogicFolder, LogicGraphNode, LogicGraphEdge } from "../project";

/**
 * Pickup-item recipe: builds a self-contained item Blueprint (sprite + collider
 * + a juicy spawn animation + self-destroy on touch) AND the player-side pickup
 * wiring, as real Logic Sheet node graphs.
 *
 * Same deterministic principle as the character recipe — we emit the exact
 * { nodes, edges } JSON the Logic Sheet uses. Exec chains are plain exec edges
 * (sourcePin "exec"); the runtime walks them via findExecTargets.
 */

export interface ItemSpec {
  /** Item + instance name; also the GiveItem item key. */
  name: string;
  /** Collide tag the player listens for (and the item carries). */
  tag: string;
  spriteId: string;
  animation: string;
  /** true = let the chosen animation play; false = hold one static frame. */
  animated: boolean;
  frame: number;
}

/** Tiny graph builder — sequential exec chain from a trigger through actions. */
class Graph {
  nodes: LogicGraphNode[] = [];
  edges: LogicGraphEdge[] = [];
  private n = 0;
  private id(p: string) { return `${p}_${this.n++}`; }

  trigger(type: string, params: Record<string, unknown>, x: number, y: number): string {
    const id = this.id("t");
    this.nodes.push({ id, kind: "trigger", type, params, position: { x, y } });
    return id;
  }
  /** Append an action and exec-wire it after `prev`. Returns the new id. */
  action(prev: string, type: string, params: Record<string, unknown>, x: number, y: number): string {
    const id = this.id("a");
    this.nodes.push({ id, kind: "action", type, params, position: { x, y } });
    this.edges.push({ id: this.id("e"), source: prev, sourcePin: "exec", target: id, targetPin: "exec", pinType: "exec" });
    return id;
  }
}

/** The item Blueprint: SpriteRenderer + Collider + tag, with two logic chains:
 *   OnCreate → SetInstanceName → SetFrame → Tween(scale→0.3) → Tween(y→ -30)
 *   OnCollide(player) → Destroy
 */
export function buildItemBlueprint(item: ItemSpec): Partial<BlueprintDef> {
  const D = BEHAVIOR_DEFAULTS as Record<string, Record<string, unknown>>;
  const behaviors: BehaviorInstance[] = [
    {
      kind: "SpriteRenderer",
      config: { ...(D.SpriteRenderer ?? {}), spriteId: item.spriteId, currentAnimation: item.animation, playing: item.animated ? 1 : 0, frame: item.frame, speed: 1 },
      enabled: true,
    },
    { kind: "Collider", config: { ...(D.Collider ?? {}), width: 24, height: 24, collideWorldBounds: 0, passThrough: 1 }, enabled: true },
  ];

  const g = new Graph();
  // Spawn juice.
  const onCreate = g.trigger("OnCreate", {}, 0, 0);
  const a1 = g.action(onCreate, "SetInstanceName", { name: item.name }, 240, 0);
  const a2 = g.action(a1, "SetFrame", { frame: item.frame }, 480, 0);
  const a3 = g.action(a2, "Tween", { tag: "pop", property: "scale", to: 0.3, duration: 0.3, ease: "Sine.easeOut", targetKind: "self" }, 720, 0);
  g.action(a3, "Tween", { tag: "rise", property: "position.y", to: "self.y-30", duration: 0.3, ease: "Sine.easeOut", targetKind: "self" }, 960, 0);
  // Picked up → vanish.
  const onTouch = g.trigger("OnCollide", { tag: "player" }, 0, 200);
  g.action(onTouch, "Destroy", { persist: false }, 240, 200);

  const folder: LogicFolder = { id: `f_item_${item.tag}`, name: "Pickup", graph: { nodes: g.nodes, edges: g.edges } };

  return {
    name: item.name,
    classKind: "Actor",
    tags: [item.tag],
    w: 24,
    h: 24,
    color: 0xffd24a,
    affectedByGravity: false,
    behaviors,
    logicSheet: { folders: [folder] },
  };
}

/** The player-side pickup chain: OnCollide(itemTag) → GiveItem(itemName).
 *  Returned as a folder so the character builder can append it. */
export function pickupFolderForPlayer(item: ItemSpec): LogicFolder {
  const g = new Graph();
  const onHit = g.trigger("OnCollide", { tag: item.tag }, 0, 0);
  g.action(onHit, "GiveItem", { item: item.name, qty: 1 }, 240, 0);
  return { id: `f_pickup_${item.tag}`, name: `Pick up ${item.name}`, graph: { nodes: g.nodes, edges: g.edges } };
}
