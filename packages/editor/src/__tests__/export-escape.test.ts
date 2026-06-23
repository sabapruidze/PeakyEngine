import { describe, it, expect } from "vitest";
import { escapeForScriptTag } from "../exportGame";

describe("escapeForScriptTag (ITEM 1)", () => {
  it("round-trips </script> and <!-- through JSON.parse intact", () => {
    const obj = { a: "x</script>y", b: "sign says <!-- hi -->" };
    const escaped = escapeForScriptTag(JSON.stringify(obj));
    // No raw "<" survives (so the embedded <script> can't be broken out of)...
    expect(escaped).not.toContain("<");
    // ...it became the JSON-valid unicode escape instead...
    expect(escaped).toContain("\\u003c");
    // ...and JSON.parse decodes it straight back to the original strings.
    expect(JSON.parse(escaped)).toEqual(obj);
  });

  it("leaves strings without < untouched", () => {
    const json = JSON.stringify({ a: "hello world" });
    expect(escapeForScriptTag(json)).toBe(json);
  });
});
