import { describe, it, expect } from "vitest";
import { evalExpression, numOr, tokenizeExprCached } from "../sm/eval";
import type { Sprite } from "../Sprite";

// Minimal mock — only the fields evalExpression / resolveIdent actually read.
function mockSprite() {
  return {
    uid: 7,
    vars: new Map<string, number>([["hp", 100], ["mana", 50]]),
    gameObject: { x: 10, y: 20, scale: 1, scaleX: 1, scaleY: 1, alpha: 1, angle: 0 },
    body: { velocity: { x: 3, y: -4 } },
    scene: { data: { get: () => undefined } },
  } as unknown as Sprite;
}

describe("evalExpression", () => {
  const s = mockSprite();
  it("arithmetic with operator precedence", () => {
    expect(evalExpression(s, "2 + 3 * 4")).toBe(14);
  });
  it("respects parentheses", () => {
    expect(evalExpression(s, "(2 + 3) * 4")).toBe(20);
  });
  it("unary minus", () => {
    expect(evalExpression(s, "-5 + 2")).toBe(-3);
  });
  it("reads var: identifiers", () => {
    expect(evalExpression(s, "var:hp")).toBe(100);
    expect(evalExpression(s, "var:hp + var:mana")).toBe(150);
  });
  it("reads self.* fields", () => {
    expect(evalExpression(s, "self.x")).toBe(10);
    expect(evalExpression(s, "self.vy")).toBe(-4);
  });
  it("a missing var: reference defaults to 0", () => {
    expect(evalExpression(s, "var:doesNotExist")).toBe(0);
  });
  it("a bare unknown identifier → undefined", () => {
    expect(evalExpression(s, "totallyUnknownThing")).toBeUndefined();
  });
  it("division by zero (non-finite) → undefined", () => {
    expect(evalExpression(s, "10 / 0")).toBeUndefined();
  });
  it("trailing junk → undefined", () => {
    expect(evalExpression(s, "2 + ")).toBeUndefined();
  });
});

describe("numOr", () => {
  const s = mockSprite();
  it("passes finite numbers through", () => {
    expect(numOr(5, 0)).toBe(5);
  });
  it("parses numeric strings", () => {
    expect(numOr("42", 0)).toBe(42);
  });
  it("evaluates expressions against the sprite", () => {
    expect(numOr("var:hp", 0, s)).toBe(100);
  });
  it("falls back on un-parseable input", () => {
    expect(numOr("not a number !!", 7, s)).toBe(7);
  });
  it("falls back on division by zero", () => {
    expect(numOr("1 / 0", 9, s)).toBe(9);
  });
});

describe("tokenizeExprCached", () => {
  it("returns the SAME array reference for a repeated string", () => {
    const a = tokenizeExprCached("var:hp + 1");
    const b = tokenizeExprCached("var:hp + 1");
    expect(a).toBe(b);
  });
  it("returns different arrays for different strings", () => {
    expect(tokenizeExprCached("var:hp + 1")).not.toBe(tokenizeExprCached("var:hp + 2"));
  });
});
