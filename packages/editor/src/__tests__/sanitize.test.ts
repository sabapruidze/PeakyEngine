import { describe, it, expect } from "vitest";
import { sanitizeAssetName, uniqueAssetName } from "../sanitize";

describe("sanitizeAssetName", () => {
  it("spaces become underscores", () => {
    expect(sanitizeAssetName("My Hero")).toBe("My_Hero");
  });
  it("strips non-identifier characters", () => {
    expect(sanitizeAssetName("a!b@c#")).toBe("abc");
  });
  it("prefixes a leading digit with _", () => {
    expect(sanitizeAssetName("9lives")).toBe("_9lives");
  });
  it("falls back when nothing usable remains", () => {
    expect(sanitizeAssetName("!!!")).toBe(sanitizeAssetName(""));
    expect(sanitizeAssetName("!!!").length).toBeGreaterThan(0);
  });
  it("is idempotent (sanitize(sanitize(x)) === sanitize(x))", () => {
    for (const input of ["My Hero!", "9lives", "  spaced  ", "a__b", "_trim_", "class"]) {
      const once = sanitizeAssetName(input);
      expect(sanitizeAssetName(once)).toBe(once);
    }
  });
});

describe("uniqueAssetName (case-insensitive — ITEM 3)", () => {
  it("returns the base when there is no collision", () => {
    expect(uniqueAssetName("Coin", new Set(["Hero"]))).toBe("Coin");
  });
  it("treats Hero and hero as colliding (Windows/macOS FS)", () => {
    expect(uniqueAssetName("hero", new Set(["Hero"]))).toBe("hero_2");
  });
  it("keeps the author's casing while folding the suffix check", () => {
    expect(uniqueAssetName("Hero", new Set(["hero", "hero_2"]))).toBe("Hero_3");
  });
});
