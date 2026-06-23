import { InputHTMLAttributes, useId, useMemo, useRef } from "react";
import { useEditor } from "../store";
import { ExpressionPicker, ExprGroup, ExprObject } from "../components/ExpressionPicker";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "list"> {
  /** The current expression text (literal number, `picked.x`, `var:World.gold`,
   *  `self.x + 100`, etc.). Stored as-is; the runtime parses via numOr / strOr. */
  value: string | number | undefined;
  /** Callback receives the raw string. Caller stores it on the action's
   *  config field; runtime evaluates at tick time. */
  onChange: (next: string) => void;
  /** Show the `{ }` token-picker button next to the input. Off by default so
   *  existing tight pill layouts are unchanged; turn on wherever an author
   *  types an expression and would otherwise have to remember the prefixes. */
  showPicker?: boolean;
  /** How a picked token is inserted:
   *   - "raw"    → `var:Player.hp`     (pure-expression fields: compares, thresholds)
   *   - "braces" → `{var:Player.hp}`   (text fields with `{…}` interpolation: labels) */
  wrap?: "raw" | "braces";
}

/**
 * Free-text expression input — replaces NumberField on action params
 * where authors should be able to type cross-object refs (`picked.x`,
 * `var:World.gold`, `self.x + 100`) instead of hardcoded literals.
 *
 * Stores the raw string. Runtime numOr / strOr resolves it (legacy plain
 * numbers like "100" still work — they parse as numeric literals).
 *
 * Autocomplete: a project-wide datalist of every var/self/picked/mouse
 * expression the user could plausibly type. With `showPicker`, the same
 * catalog is also offered as a clickable `{ }` popup (the component the
 * node graph uses) so authors don't have to memorize the prefixes.
 */
export function ExpressionField({ value, onChange, showPicker, wrap = "raw", ...rest }: Props) {
  const text = value === undefined || value === null ? "" : String(value);
  const blueprints = useEditor((s) => s.project.blueprints);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const globalVariables = useEditor((s) => s.project.globalVariables);
  const lists = useEditor((s) => s.project.lists);
  const items = useEditor((s) => s.project.items);
  const datalistId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const out: string[] = [];
    // Self / mouse / picked — generic shorthands available everywhere.
    out.push("self.x", "self.y", "self.uid", "self.angle", "self.scale", "self.alpha", "self.vx", "self.vy");
    out.push("picked.x", "picked.y", "picked.uid", "picked.name", "picked.tag", "picked.angle", "picked.alpha");
    out.push("mouse.x", "mouse.y", "mouse.screenX", "mouse.screenY");
    // var:<BP>.<field> for every BP's variables.
    for (const bp of blueprints) {
      for (const v of bp.variables) out.push(`var:${bp.name}.${v.name}`);
    }
    // var:<Widget>.<field> for every UI widget's variables.
    for (const w of uiWidgets) {
      for (const v of w.variables) out.push(`var:${w.name}.${v.name}`);
    }
    // Persistent globals (money/day/flags) + item counts + read-only lists.
    for (const g of globalVariables ?? []) if (g.name) out.push(`global:${g.name}`);
    for (const it of items ?? []) out.push(`global:${(it.countGlobal || it.name).replace(/[^A-Za-z0-9_]/g, "")}`);
    for (const l of lists ?? []) {
      for (const e of l.entries) out.push(`list:${l.name}.${e.name}`);
      out.push(`list:${l.name}.length`);
    }
    out.push("lastTile.c", "lastTile.r", "lastTile.idx", "lastTile.x", "lastTile.y", "lastTile.tilemap", "lastTile.layer");
    out.push(
      "tile.idx(Tilemap, Layer, mouse.x, mouse.y)",
      "tile.c(Tilemap, mouse.x)",
      "tile.r(Tilemap, mouse.y)",
      "tile.worldX(Tilemap, 0)",
      "tile.worldY(Tilemap, 0)",
      "tile.cols(Tilemap)",
      "tile.rows(Tilemap)",
    );
    // Dedupe — a custom global "NewItem2" and an item whose countGlobal
    // sanitizes to "NewItem2" both produce `global:NewItem2`, which would
    // otherwise emit two <option> elements with the same React key.
    return Array.from(new Set(out));
  }, [blueprints, uiWidgets, globalVariables, lists, items]);

  // Same catalog, shaped for the `{ }` ExpressionPicker (grouped chips +
  // drill-into objects). Built lazily — only when the picker is enabled.
  const { groups, objects } = useMemo<{ groups: ExprGroup[]; objects: ExprObject[] }>(() => {
    if (!showPicker) return { groups: [], objects: [] };
    const g: ExprGroup[] = [
      { label: "Self", color: "#5fb3ff", tokens: ["x", "y", "vx", "vy", "angle", "scale", "scaleX", "scaleY", "alpha", "uid"].map((f) => ({ token: `self.${f}` })) },
      { label: "Picked", color: "#e0a14a", tokens: ["x", "y", "name", "tag", "uid", "vx", "vy", "angle", "scale", "alpha"].map((f) => ({ token: `picked.${f}` })) },
      { label: "Mouse", color: "#2ea36a", tokens: ["x", "y", "screenX", "screenY"].map((f) => ({ token: `mouse.${f}` })) },
      { label: "Last destroyed tile", color: "#e07474", tokens: [
        { token: "lastTile.c", hint: "column of the tile that just hit HP 0" },
        { token: "lastTile.r", hint: "row of the tile that just hit HP 0" },
        { token: "lastTile.idx", hint: "tile index that just hit HP 0" },
        { token: "lastTile.x", hint: "world X of the destroyed tile's cell" },
        { token: "lastTile.y", hint: "world Y of the destroyed tile's cell" },
        { token: "lastTile.tilemap", hint: "name of the tilemap the tile belonged to" },
        { token: "lastTile.layer", hint: "name of the tilemap layer the tile belonged to" },
      ] },
      { label: "Tile reads", color: "#7eb37e", tokens: [
        { token: "tile.idx(Tilemap, Layer, mouse.x, mouse.y)", hint: "tile index at world (x, y) on a named tilemap layer" },
        { token: "tile.c(Tilemap, mouse.x)", hint: "world X → column on a named tilemap" },
        { token: "tile.r(Tilemap, mouse.y)", hint: "world Y → row on a named tilemap" },
        { token: "tile.worldX(Tilemap, 0)", hint: "column → world X on a named tilemap" },
        { token: "tile.worldY(Tilemap, 0)", hint: "row → world Y on a named tilemap" },
        { token: "tile.cols(Tilemap)", hint: "number of columns in a named tilemap" },
        { token: "tile.rows(Tilemap)", hint: "number of rows in a named tilemap" },
      ] },
    ];
    const gvars = (globalVariables ?? []).filter((v) => v.name);
    if (gvars.length) g.push({ label: "Custom Globals", color: "#c77bff", tokens: gvars.map((v) => ({ token: `global:${v.name}`, hint: "global variable you created" })) });
    if ((items ?? []).length) g.push({ label: "Item counts", color: "#3fc66e", tokens: (items ?? []).map((it) => ({ token: `global:${(it.countGlobal || it.name).replace(/[^A-Za-z0-9_]/g, "")}`, hint: `how many ${it.name} owned` })) });
    const listToks = (lists ?? []).flatMap((l) => [...l.entries.map((e) => ({ token: `list:${l.name}.${e.name}`, hint: "list entry" })), { token: `list:${l.name}.length`, hint: "entry count" }]);
    if (listToks.length) g.push({ label: "Lists", color: "#5fb3ff", tokens: listToks });
    // Shop-selection tokens are interpolation-only ({shop.name}); offer them in
    // braces mode (text fields) where they make sense. Built-ins + every custom
    // item property the project defines, so authors can show any item field on
    // a label/button that follows the shop's selected slot.
    if (wrap === "braces") {
      const shopToks = [
        { token: "shop.name", hint: "selected item name" },
        { token: "shop.price", hint: "buy price" },
        { token: "shop.sellPrice", hint: "sell price" },
        { token: "shop.count", hint: "how many owned" },
        { token: "shop.maxStack", hint: "max stack" },
      ];
      const propKeys = Array.from(new Set((items ?? []).flatMap((it) => (it.props ?? []).map((p) => p.key)).filter(Boolean)));
      for (const k of propKeys) shopToks.push({ token: `shop.${k}`, hint: "custom item property" });
      g.push({ label: "Shop selection", color: "#f3a14a", tokens: shopToks });
    }
    const objs: ExprObject[] = [];
    for (const bp of blueprints) if (bp.variables.length) objs.push({ name: bp.name, color: "#0e9384", tokens: bp.variables.map((v) => ({ token: `var:${bp.name}.${v.name}`, hint: "variable" })) });
    for (const w of uiWidgets) if (w.variables.length) objs.push({ name: w.name, color: "#7b61ff", tokens: w.variables.map((v) => ({ token: `var:${w.name}.${v.name}`, hint: "widget variable" })) });
    return { groups: g, objects: objs };
  }, [showPicker, wrap, blueprints, uiWidgets, globalVariables, lists, items]);

  // Insert a picked token at the caret (or replace the selection), wrapping in
  // `{…}` for interpolation fields. Falls back to appending if the input isn't
  // focused / no caret is available.
  const insertToken = (token: string) => {
    const piece = wrap === "braces" ? `{${token}}` : token;
    const el = inputRef.current;
    if (el && el.selectionStart !== null && el.selectionEnd !== null) {
      const next = text.slice(0, el.selectionStart) + piece + text.slice(el.selectionEnd);
      onChange(next);
      // Restore caret just past the inserted token on the next frame.
      const caret = el.selectionStart + piece.length;
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
      return;
    }
    onChange(text ? `${text}${piece}` : piece);
  };

  const input = (
    <input
      {...rest}
      ref={inputRef}
      type="text"
      list={datalistId}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      title={typeof rest.title === "string"
        ? `${rest.title}\n\nAccepts numbers (100), expressions (self.x + 50), object reads (picked.x, var:World.gold), and the picked object's vars (picked.<varName>).`
        : "Accepts numbers, expressions (self.x + 50), object reads (picked.x, var:World.gold), and the picked object's vars."}
      style={showPicker ? { flex: 1, minWidth: 0, ...(rest.style ?? {}) } : rest.style}
    />
  );

  return (
    <>
      {showPicker ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, width: "100%" }}>
          {input}
          <ExpressionPicker groups={groups} objects={objects} onPick={insertToken} />
        </span>
      ) : input}
      <datalist id={datalistId}>
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}
