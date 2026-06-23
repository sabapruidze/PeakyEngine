// Layer-1 "wiring" verification for every Logic Sheet node. Runs headless via
// `npm test` — no Phaser, no canvas. It does NOT prove a node visually works at
// runtime; it proves the node's PINS are well-formed and self-consistent, which
// is the class of bug that kept slipping through (Set Var var/name, string pins
// mistyped, dynamic pins not re-typing).
import { describe, it, expect } from "vitest";
import {
  PALETTE,
  nodeShape,
  VAR_VALUE_PINS,
  ENUM_PARAM_KEYS,
  PIN_COLORS,
} from "./LogicGraphCanvas";
import type { LogicGraphNode } from "../../../project";

type Entry = { type: string; kind: LogicGraphNode["kind"]; label: string; defaults: Record<string, unknown> };

const ENTRIES: Entry[] = PALETTE.flatMap((g) => g.entries as Entry[]);
const VALID_PIN_TYPES = new Set(Object.keys(PIN_COLORS)); // exec / number / string / boolean / spriteRef …

function makeNode(e: Entry, params?: Record<string, unknown>): LogicGraphNode {
  return {
    id: "t",
    kind: e.kind,
    type: e.type,
    params: params ?? JSON.parse(JSON.stringify(e.defaults)),
    position: { x: 0, y: 0 },
  };
}

// Params that intentionally never expose a wireable pin (custom inline editors).
const NO_PIN_PARAMS = new Set(["spawnVars", "params"]);
// Nodes with a fully custom pin scheme (not 1 pin per param):
//  - SetUIElement: edited entirely inline (per-element toggles).
//  - SetBehaviorParam: exposes one pin PER ROW (pval_<i>); `behavior` /
//    `componentName` are inline component selectors, not wireable.
const NO_PIN_NODES = new Set(["SetUIElement", "SetBehaviorParam"]);

describe("Logic Sheet node pins (Layer 1)", () => {
  it("has a non-empty palette", () => {
    expect(ENTRIES.length).toBeGreaterThan(100);
  });

  it("every node produces only valid pin types", () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      const shape = nodeShape(makeNode(e));
      for (const p of [...shape.inData, ...shape.outData]) {
        if (!VALID_PIN_TYPES.has(p.type)) bad.push(`${e.type}: pin "${p.pin}" has invalid type "${p.type}"`);
      }
    }
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });

  // The Set Var bug: VAR_VALUE_PINS referenced "name" but the node param key is
  // "var". This asserts every var-value mapping points at keys the node has.
  it("VAR_VALUE_PINS keys exist in the node's params", () => {
    const bad: string[] = [];
    for (const [type, { varKey, valuePin }] of Object.entries(VAR_VALUE_PINS)) {
      const e = ENTRIES.find((x) => x.type === type);
      if (!e) { bad.push(`${type}: has a VAR_VALUE_PINS entry but no palette node`); continue; }
      if (!(varKey in e.defaults)) bad.push(`${type}: varKey "${varKey}" not in params {${Object.keys(e.defaults).join(", ")}}`);
      if (!(valuePin in e.defaults)) bad.push(`${type}: valuePin "${valuePin}" not in params {${Object.keys(e.defaults).join(", ")}}`);
    }
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });

  // Set Var / Set Global etc: the value pin must adopt the chosen variable's
  // type so it colors + type-checks correctly (number→green, string→pink).
  it("var-value nodes re-type their value pin to the chosen variable", () => {
    const bad: string[] = [];
    for (const [type, { varKey, valuePin }] of Object.entries(VAR_VALUE_PINS)) {
      const e = ENTRIES.find((x) => x.type === type);
      if (!e) continue;
      for (const vt of ["string", "number", "boolean"] as const) {
        const node = makeNode(e);
        node.params[varKey] = "V";
        const shape = nodeShape(node, new Map([["V", vt]]));
        const pin = shape.inData.find((p) => p.pin === valuePin);
        if (!pin) { bad.push(`${type}: value pin "${valuePin}" missing`); break; }
        if (pin.type !== vt) bad.push(`${type}: var=${vt} → value pin is "${pin.type}" (expected "${vt}")`);
      }
    }
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });

  // Every non-enum action param should be wireable, so a getter/var/string can
  // drive it (the "wire a name into a dropdown" capability).
  it("every non-enum action param exposes a wireable input pin", () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      if (e.kind !== "action" || NO_PIN_NODES.has(e.type)) continue;
      const pins = new Set(nodeShape(makeNode(e)).inData.map((p) => p.pin));
      for (const k of Object.keys(e.defaults)) {
        if (ENUM_PARAM_KEYS.has(k) || NO_PIN_PARAMS.has(k)) continue;
        if (/^(set_|ovr)/.test(k)) continue; // per-prop override toggles
        if (!pins.has(k)) bad.push(`${e.type}: param "${k}" has no input pin`);
      }
    }
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });

  // A literal node's output pin must follow the typed value (number vs string).
  it("literal nodes type their output pin by the value", () => {
    const bad: string[] = [];
    for (const e of ENTRIES) {
      if (e.kind !== "literal") continue;
      for (const [val, want] of [[5, "number"], ["hi", "string"], [true, "boolean"]] as const) {
        const shape = nodeShape(makeNode(e, { value: val }));
        const out = shape.outData[0];
        if (out?.type !== want) bad.push(`${e.type}: value ${JSON.stringify(val)} → out "${out?.type}" (expected "${want}")`);
      }
    }
    expect(bad, `\n${bad.join("\n")}`).toEqual([]);
  });
});
