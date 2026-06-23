/**
 * Color picker that round-trips through whichever shape the host config
 * uses. Two storage formats coexist in the project model:
 *   - Numeric  0xRRGGBB (Phaser-style — Text.color, ParticleEmitter.tintStart, etc.)
 *   - Hex      "#aabbcc" (CSS-style — PrintString config, UI widget styles, etc.)
 * The picker reads the current value, infers the shape, and writes back
 * in the SAME shape so existing saves keep their format. New writes
 * follow the inferred shape too — when value is undefined/null, the
 * `mode` prop decides ("number" default for behavior params; "string"
 * for action configs).
 */
import { useMemo } from "react";

type ColorMode = "number" | "string";

function toHex(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
  }
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toLowerCase();
  }
  if (typeof value === "string" && /^#[0-9a-fA-F]{3}$/.test(value)) {
    const r = value[1], g = value[2], b = value[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

export function ColorField({
  value,
  onChange,
  mode,
  fallback = "#ffffff",
  style,
  textWidth = 78,
}: {
  value: unknown;
  /** Receives the value in the SAME shape as the input (number → number,
   *  string → string). For an undefined input, follows `mode`. */
  onChange: (next: number | string) => void;
  /** Storage shape used when `value` is missing. */
  mode?: ColorMode;
  fallback?: string;
  style?: React.CSSProperties;
  textWidth?: number;
}) {
  const inferred: ColorMode = useMemo(() => {
    if (typeof value === "number") return "number";
    if (typeof value === "string") return "string";
    return mode ?? "number";
  }, [value, mode]);

  const hex = toHex(value, fallback);

  const emit = (nextHex: string) => {
    if (inferred === "number") {
      onChange(parseInt(nextHex.slice(1), 16));
    } else {
      onChange(nextHex);
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}>
      <input
        type="color"
        value={hex}
        onChange={(e) => emit(e.target.value)}
        style={{ width: 32, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 3, background: "transparent", cursor: "pointer" }}
        title="Pick a color"
      />
      <input
        type="text"
        value={hex}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) emit(v.toLowerCase());
          else if (/^#[0-9a-fA-F]{3}$/.test(v)) {
            const r = v[1], g = v[2], b = v[3];
            emit(`#${r}${r}${g}${g}${b}${b}`.toLowerCase());
          }
        }}
        style={{ width: textWidth, fontSize: 11, fontFamily: "ui-monospace, monospace" }}
        title={`Hex color (${inferred === "number" ? "stored as 0xRRGGBB number" : "stored as #hex string"})`}
      />
    </span>
  );
}

/** Heuristic: param key looks like a color field. Used by generic
 *  ParamField renderers to auto-route to ColorField without changing
 *  every meta entry. Matches "color", "tint", "bgColor", "borderColor",
 *  "shadowColor", "fillColor", "hoverBgColor", "pressedBgColor", etc.
 *  Excludes substrings like "collider" / "tinted-by" that aren't color
 *  fields. */
export function isColorParamKey(key: string): boolean {
  if (!key) return false;
  const k = key.toLowerCase();
  if (k.includes("collider")) return false;
  return /(^|[^a-z])(color|tint)([^a-z]|$)|color$|tint$/i.test(key)
    || k.endsWith("color")
    || k.endsWith("tint")
    || k.endsWith("tintstart")
    || k.endsWith("tintend");
}
