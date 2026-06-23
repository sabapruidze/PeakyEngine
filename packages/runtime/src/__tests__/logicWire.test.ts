// Layer-2 "behavior" verification for the Logic Sheet RUNTIME. Unlike the
// editor-side pin test (Layer 1), this proves a wired value actually FLOWS into
// the action's runtime config — the "I wired it but nothing happened" bug class.
// Runs headless (Phaser is stubbed by vitest.config), no canvas needed.
import { describe, it, expect } from "vitest";
import { nodeToAction, type LogicGraphNode, type LogicGraphEdge } from "../LogicSheetRunner";
import type { Sprite } from "../Sprite";

function mockSprite(vars: Record<string, unknown> = {}): Sprite {
  return {
    uid: 1,
    vars: new Map(Object.entries(vars)),
    scene: { data: { get: () => undefined } },
  } as unknown as Sprite;
}

function run(nodes: LogicGraphNode[], edges: LogicGraphEdge[], targetId: string, sprite: Sprite) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const a = nodeToAction(byId.get(targetId)!, edges, byId, sprite);
  return a ? { kind: a.kind, cfg: a.config as Record<string, unknown> } : null;
}

const lit = (id: string, value: unknown): LogicGraphNode => ({
  id, kind: "literal", type: typeof value === "string" ? "StringValue" : "Literal",
  params: { value }, position: { x: 0, y: 0 },
});
const vread = (id: string, varName: string): LogicGraphNode => ({
  id, kind: "varRead", type: "VarRead", params: { var: varName }, position: { x: 0, y: 0 },
});
const wire = (source: string, target: string, targetPin: string, pinType: LogicGraphEdge["pinType"] = "string"): LogicGraphEdge =>
  ({ id: `${source}->${target}.${targetPin}`, source, sourcePin: "out", target, targetPin, pinType });

const action = (id: string, type: string, params: Record<string, unknown>): LogicGraphNode =>
  ({ id, kind: "action", type, params, position: { x: 0, y: 0 } });

describe("Logic Sheet runtime wire resolution (Layer 2)", () => {
  it("a wired String value reaches Set Var's value", () => {
    const r = run([action("sv", "SetVar", { var: "target", value: 0 }), lit("s", "walk")],
      [wire("s", "sv", "value")], "sv", mockSprite());
    expect(r?.kind).toBe("SetVar");
    expect(r?.cfg.name).toBe("target");   // var → engine cfg.name
    expect(r?.cfg.value).toBe("walk");     // the wire overrode the inline 0
  });

  it("an UNWIRED Set Var uses its inline value", () => {
    const r = run([action("sv", "SetVar", { var: "target", value: 42 })], [], "sv", mockSprite());
    expect(r?.cfg.value).toBe(42);
  });

  it("a wired Read Variable feeds the variable's VALUE (not its name)", () => {
    const r = run([action("sv", "SetVar", { var: "target", value: 0 }), vread("r", "spriteName")],
      [wire("r", "sv", "value")], "sv", mockSprite({ spriteName: "hero" }));
    expect(r?.cfg.value).toBe("hero");
  });

  it("a wired string reaches Play Animation's animation", () => {
    const r = run([action("pa", "PlayAnimation", { name: "" }), lit("s", "run")],
      [wire("s", "pa", "name")], "pa", mockSprite());
    expect(r?.kind).toBe("PlayAnimation");
    expect(r?.cfg.animation).toBe("run");
  });

  it("Increment Var maps to engine AddVar with name + delta", () => {
    const r = run([action("iv", "IncrementVar", { var: "coins", delta: 5 })], [], "iv", mockSprite());
    expect(r?.kind).toBe("AddVar");
    expect(r?.cfg.name).toBe("coins");
    expect(r?.cfg.delta).toBe(5);
  });

  it("a generic action resolves a wired param into its config", () => {
    // SetSprite has no special runner case → generic resolver must still pick
    // up the wired spriteId. (Name→id is resolved later at the eval layer.)
    const r = run([action("ss", "SetSprite", { spriteId: "", animation: "" }), lit("s", "coin")],
      [wire("s", "ss", "spriteId")], "ss", mockSprite());
    expect(r?.kind).toBe("SetSprite");
    expect(r?.cfg.spriteId).toBe("coin");
  });
});
