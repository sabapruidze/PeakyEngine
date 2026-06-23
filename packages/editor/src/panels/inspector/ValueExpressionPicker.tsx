/**
 * Cross-object value picker — Object dropdown + Variable dropdown +
 * Literal toggle. Round-trips a string expression that the runtime's
 * `numOr` / `strOr` resolvers can parse:
 *
 *   Self + "coins"                  → "coins"               (bare lookup)
 *   Subject (Player) + "coins"      → "coins"               (runtime swaps host)
 *   Other obj (World) + "gold"      → "var:World.gold"      (cross-BP lookup)
 *   Literal "100"                   → "100"                 (numeric literal)
 *   Literal "var:World.gold * 2"    → "var:World.gold * 2"  (free expression)
 *
 * Used inside CompareValues — both LEFT and RIGHT sides. Also reusable
 * for any other expression-taking input we want to upgrade later.
 */

import { useEffect, useMemo, useState } from "react";
import type { Subject } from "@peaky/shared";
import type { BlueprintDef, UIWidgetDef } from "../../project";
import { useEditor } from "../../store";

const PILL: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 3,
  color: "var(--text)",
  outline: "none",
};

/** One selectable object in the dropdown. `kind` distinguishes how we
 *  serialize on commit (bare name vs `var:Name.field`). */
interface ObjectOption {
  /** Stable key for the <option value="..." />. */
  key: string;
  /** Display text in the dropdown. */
  label: string;
  /** How to serialize: "bare" stores `<varName>`; "named" stores `var:<name>.<varName>`. */
  serialize: "bare" | "named";
  /** When serialize === "named", the lookup name written before the dot. */
  lookupName?: string;
  /** Variables exposed by this object (the right-hand dropdown's options). */
  variables: string[];
}

/** Parsed form of a stored expression string — what side of the picker
 *  is currently active and what's selected within it. */
type Parsed =
  | { mode: "var"; objectKey: string; varName: string }
  | { mode: "literal"; text: string };

/** Build the catalog of objects the user can pick on either side.
 *
 * The list is sourced from the entire project — variables from the host
 * BP / Main Sheet World host / every BP / every UI widget — so the user
 * can compare across any pair. The Subject is pinned at the top with a
 * "(subject)" tag for one-click access. Self is exposed only on
 * BP/widget sheets (Main Sheet has no host BP). */
function buildObjectCatalog({
  hostBp, isMain, subject, blueprints, uiWidgets,
}: {
  hostBp: BlueprintDef;
  isMain: boolean;
  subject: Subject | undefined;
  blueprints: BlueprintDef[];
  uiWidgets: UIWidgetDef[];
}): ObjectOption[] {
  const items: ObjectOption[] = [];
  const seenKeys = new Set<string>();
  const push = (opt: ObjectOption) => {
    if (seenKeys.has(opt.key)) return;
    seenKeys.add(opt.key);
    items.push(opt);
  };

  // 1) Subject (pinned at top — most common pick).
  if (subject) {
    if (subject.kind === "bp" && subject.bpId) {
      const bp = blueprints.find((b) => b.id === subject.bpId);
      if (bp) {
        push({
          key: `subject-bp-${bp.id}`,
          label: `${bp.name} (subject)`,
          serialize: "named",
          lookupName: bp.name,
          variables: bp.variables.map((v) => v.name),
        });
      }
    } else if (subject.kind === "uiwidget" && subject.bpId) {
      const w = uiWidgets.find((x) => x.id === subject.bpId);
      if (w) {
        push({
          key: `subject-widget-${w.id}`,
          label: `${w.name} (subject)`,
          serialize: "named",
          lookupName: w.name,
          variables: w.variables.map((v) => v.name),
        });
      }
    }
  }

  // 2) Self — on BP/widget sheets only. Subject="self" is the implicit
  // host, so a SELF entry maps to the host BP's vars. Stores as bare.
  if (!isMain) {
    push({
      key: "self",
      label: `${hostBp.name} (self)`,
      serialize: "bare",
      variables: hostBp.variables.map((v) => v.name),
    });
  }

  // 3) World — main-sheet host. Always shown if the host has vars (the
  // host IS the world on Main Sheet, so we look at hostBp.variables when
  // isMain; else we'd need to grab the active scene's mainVariables but
  // this picker doesn't have scene-data access — defer to v2).
  if (isMain) {
    push({
      key: "world",
      label: "World (globals)",
      serialize: "named",
      lookupName: "World",
      variables: hostBp.variables.map((v) => v.name),
    });
  }

  // 4) Every BP with declared variables.
  for (const bp of blueprints) {
    if (bp.variables.length === 0) continue;
    push({
      key: `bp-${bp.id}`,
      label: bp.name,
      serialize: "named",
      lookupName: bp.name,
      variables: bp.variables.map((v) => v.name),
    });
  }

  // 5) Every UI widget with declared variables.
  for (const w of uiWidgets) {
    if (w.variables.length === 0) continue;
    push({
      key: `uiwidget-${w.id}`,
      label: `${w.name} (UI)`,
      serialize: "named",
      lookupName: w.name,
      variables: w.variables.map((v) => v.name),
    });
  }

  return items;
}

/** Parse a stored expression string back into the picker's UI state.
 *
 * Recognized forms (in order):
 *   - "var:Obj.field"  → mode="var", look up the object whose lookupName
 *                        matches "Obj" (case-sensitive); var = "field".
 *   - "barename"       → mode="var" if any catalog object exposes a
 *                        variable with that bare name (prefer the FIRST
 *                        catalog match — Subject pinned first means a
 *                        bare name picks Subject when ambiguous).
 *   - anything else    → mode="literal" with the raw text.
 *
 * Falls back to literal mode whenever we can't resolve confidently — the
 * user's data isn't lost even if their `var:NoSuchObj.x` doesn't match
 * any current object. */
function parseStoredValue(stored: string, catalog: ObjectOption[]): Parsed {
  const text = stored.trim();
  if (text === "") return { mode: "literal", text: "" };

  // "var:Obj.field" — strict match against catalog by lookupName.
  if (text.startsWith("var:")) {
    const rest = text.slice(4);
    const dot = rest.indexOf(".");
    if (dot > 0 && /^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/.test(rest)) {
      const objName = rest.slice(0, dot);
      const varName = rest.slice(dot + 1);
      const found = catalog.find((o) => o.serialize === "named" && o.lookupName === objName);
      if (found) return { mode: "var", objectKey: found.key, varName };
    }
    // Falls through to literal — caller can edit raw `var:Foo.bar`.
    return { mode: "literal", text };
  }

  // Bare identifier — match against any catalog object that exposes it
  // as a variable. Subject is first in the catalog so it wins ties.
  if (/^[A-Za-z_][\w]*$/.test(text)) {
    const found = catalog.find((o) => o.variables.includes(text));
    if (found) return { mode: "var", objectKey: found.key, varName: text };
  }

  return { mode: "literal", text };
}

/** Serialize the picker's UI state back to a storable string. Inverse
 *  of `parseStoredValue`. */
function serializeValue(parsed: Parsed, catalog: ObjectOption[]): string {
  if (parsed.mode === "literal") return parsed.text;
  const obj = catalog.find((o) => o.key === parsed.objectKey);
  if (!obj) return parsed.varName; // shouldn't happen — defensive
  if (obj.serialize === "bare") return parsed.varName;
  return `var:${obj.lookupName}.${parsed.varName}`;
}

export function ValueExpressionPicker({
  value, onChange, subject, hostBp, isMain,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Active subject from the condition/action — pinned to the top of the
   *  object dropdown for one-click selection. */
  subject?: Subject;
  /** Sheet's host BP (for "self" entry on BP/widget sheets, or for
   *  world-host vars on Main Sheet). */
  hostBp: BlueprintDef;
  /** True when the sheet is the per-scene Main Event Sheet. Hides "Self"
   *  and exposes "World" (the same host, just labelled differently). */
  isMain: boolean;
}) {
  const blueprints = useEditor((s) => s.project.blueprints);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);

  const catalog = useMemo(
    () => buildObjectCatalog({ hostBp, isMain, subject, blueprints, uiWidgets }),
    [hostBp, isMain, subject, blueprints, uiWidgets],
  );

  // Parsed UI state — derived from `value` on first render and whenever
  // `value` changes from outside. Edits update `parsed` via setParsed +
  // immediately propagate to onChange so the parent stays in sync.
  const [parsed, setParsed] = useState<Parsed>(() => parseStoredValue(value, catalog));

  // Re-parse when the incoming `value` changes (e.g. a sibling edit) AND
  // it doesn't match what we just wrote. This avoids a feedback loop on
  // every keystroke.
  useEffect(() => {
    const ourSerialized = serializeValue(parsed, catalog);
    if (ourSerialized !== value) {
      setParsed(parseStoredValue(value, catalog));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: Parsed) => {
    setParsed(next);
    onChange(serializeValue(next, catalog));
  };

  if (parsed.mode === "literal") {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <input
          value={parsed.text}
          onChange={(e) => commit({ mode: "literal", text: e.target.value })}
          placeholder="value"
          style={{ ...PILL, width: 130 }}
          title="Literal value or free expression. Examples: 100, hello, var:World.gold * 2."
        />
        <button
          type="button"
          onClick={() => {
            // Flip to var mode — pick the first catalog object that has
            // any variables; if nothing has any, keep literal mode (the
            // toggle becomes a no-op).
            const first = catalog.find((o) => o.variables.length > 0);
            if (!first) return;
            commit({ mode: "var", objectKey: first.key, varName: first.variables[0] });
          }}
          style={{
            ...PILL, padding: "2px 8px", cursor: "pointer", color: "var(--text-2)",
          }}
          title="Switch to variable picker"
        >var</button>
      </span>
    );
  }

  // var mode — Object dropdown + Variable dropdown.
  const obj = catalog.find((o) => o.key === parsed.objectKey);
  const objKey = obj ? parsed.objectKey : (catalog[0]?.key ?? "");
  const objSelected = catalog.find((o) => o.key === objKey);
  const vars = objSelected?.variables ?? [];
  const varSel = vars.includes(parsed.varName) ? parsed.varName : (vars[0] ?? "");

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <select
        value={objKey}
        onChange={(e) => {
          const next = catalog.find((o) => o.key === e.target.value);
          if (!next) return;
          commit({ mode: "var", objectKey: next.key, varName: next.variables[0] ?? "" });
        }}
        style={{ ...PILL, maxWidth: 130 }}
        title="Object whose variable to read."
      >
        {catalog.length === 0 && <option value="">— no objects —</option>}
        {catalog.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      {vars.length > 0 ? (
        <select
          value={varSel}
          onChange={(e) => commit({ mode: "var", objectKey: objKey, varName: e.target.value })}
          style={{ ...PILL, maxWidth: 110 }}
          title="Variable on the chosen object."
        >
          {vars.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : (
        <span style={{ ...PILL, color: "var(--text-muted)", fontStyle: "italic", padding: "2px 8px" }}>
          (no vars)
        </span>
      )}
      <button
        type="button"
        onClick={() => commit({ mode: "literal", text: "" })}
        style={{
          ...PILL, padding: "2px 8px", cursor: "pointer", color: "var(--text-2)",
        }}
        title="Switch to literal value / free expression"
      >123</button>
    </span>
  );
}
