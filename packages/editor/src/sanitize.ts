/**
 * Asset name sanitization — UE5-style C-identifier rule.
 *
 * Top-level asset names (Blueprint, Sprite, Scene, Tileset, Tilemap,
 * Dialogue, UI Widget, Item, Recipe, AnimatedTile) and folder segments
 * must match `[A-Za-z_][A-Za-z0-9_]*`. This avoids ambiguity in the
 * expression parser (`var:Player Char.hp` would be invalid), keeps
 * names safe for filesystem export / codegen / URL slots, and matches
 * the convention every mature engine enforces.
 *
 * Variables, signals, input action names, animation names, state names,
 * component names — INTENTIONALLY excluded from this sanitization. Authors
 * commonly want short / casual names there ("hp", "fireball") and the
 * expression parser handles those tokens via prefix matching.
 */

/**
 * Reserved JavaScript / engine identifiers — these cannot be used as
 * blueprint names because they'd collide with expression parser keywords
 * (`self`, `picked`, `mouse`, `var`, etc.) or be unrepresentable safely.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // Expression-parser prefixes (would shadow built-ins)
  "self", "picked", "mouse", "var", "global", "list", "tracer", "sprite", "scene", "bp",
  // JS reserved-ish that would surprise authors
  "null", "undefined", "true", "false", "this",
]);

const FALLBACK_NAME = "Untitled";
const MAX_NAME_LENGTH = 64;

/**
 * Sanitize a single asset name segment to UE5-style:
 *  - Spaces → `_`
 *  - Other illegal chars stripped (only `[A-Za-z0-9_]` survives)
 *  - Leading digit gets prefixed with `_`
 *  - Collapses runs of `_` to a single `_`
 *  - Empty result falls back to `Untitled`
 *  - Reserved names get suffixed with `_`
 *  - Clamped to MAX_NAME_LENGTH chars
 *
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */
export function sanitizeAssetName(input: unknown, fallback: string = FALLBACK_NAME): string {
  const s = typeof input === "string" ? input : String(input ?? "");
  // Spaces → underscore FIRST so multi-word names stay readable.
  const spaced = s.replace(/\s+/g, "_");
  // Strip anything that isn't a C-identifier char.
  let cleaned = spaced.replace(/[^A-Za-z0-9_]/g, "");
  // Collapse multiple underscores.
  cleaned = cleaned.replace(/_+/g, "_");
  // Trim leading/trailing underscores (cosmetic).
  cleaned = cleaned.replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) cleaned = fallback;
  // Leading digit → prefix with `_`.
  if (/^[0-9]/.test(cleaned)) cleaned = `_${cleaned}`;
  // Reserved keyword collision → suffix with `_`.
  if (RESERVED_NAMES.has(cleaned.toLowerCase())) cleaned = `${cleaned}_`;
  // Clamp.
  if (cleaned.length > MAX_NAME_LENGTH) cleaned = cleaned.slice(0, MAX_NAME_LENGTH);
  return cleaned;
}

/**
 * Sanitize a folder path like `/Characters/My Enemies/Goblins` →
 * `/Characters/My_Enemies/Goblins`. Each `/`-separated segment is
 * sanitized independently. Empty segments (leading/trailing/double
 * slashes) are dropped. Returns `/` for empty or whitespace-only paths.
 */
export function sanitizeFolderPath(input: unknown): string {
  const s = typeof input === "string" ? input : String(input ?? "");
  const segments = s.split("/").map((seg) => seg.trim()).filter((seg) => seg.length > 0);
  if (segments.length === 0) return "/";
  return `/${segments.map((seg) => sanitizeAssetName(seg, "Folder")).join("/")}`;
}

/**
 * Make a name unique within a set of existing names by appending
 * `_2`, `_3`, ... until no collision. Sanitizes the input first.
 *
 * Used by "Create new X" / "Duplicate X" mutations so the new asset
 * never silently overrides an existing one with the same name.
 */
export function uniqueAssetName(input: unknown, taken: ReadonlySet<string>, fallback?: string): string {
  const base = sanitizeAssetName(input, fallback);
  // Compare case-INSENSITIVELY: asset names become disk file paths, and
  // Windows/macOS filesystems are case-insensitive — "Hero" and "hero" would
  // otherwise both pass uniqueness yet resolve to the same file, silently
  // clobbering one asset on save. The RETURNED name keeps the author's casing;
  // only the collision check folds to lowercase.
  const takenLower = new Set<string>();
  for (const t of taken) takenLower.add(t.toLowerCase());
  if (!takenLower.has(base.toLowerCase())) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}_${i}`;
    if (!takenLower.has(candidate.toLowerCase())) return candidate;
  }
  // Pathological — 10000 collisions. Fall back to a timestamp-shaped suffix
  // (still deterministic enough that load-time sanitize maps cleanly).
  return `${base}_x`;
}
