/**
 * Subject-locked variable picker — LEFT side of CompareValues.
 *
 * Construct-3's "Compare instance variable" semantics: when the user has
 * picked a specific OBJECT as subject (NPC, Player, World, …), the LEFT
 * side of the comparison is locked to THAT object's variables. There's
 * no object dropdown — the author already chose the object at the subject
 * step. Picking other BPs inside the comparison would contradict the
 * narrowing they just expressed.
 *
 * For "free-scope" subjects (system / mouse / keyboard) — where there
 * IS no specific object — this component falls through to the full
 * <ValueExpressionPicker>, since "compare two arbitrary values" is the
 * natural System read.
 *
 * Stored value format: bare variable name (e.g. "coins"). The runtime
 * swaps `sprite` to the subject's instance via subject redirect, so a
 * bare-name lookup in resolveExpr / resolveIdent reads from the picked
 * instance — no `var:Player.coins` prefix needed.
 */

import { useEffect } from "react";
import type { Subject } from "@peaky/shared";
import type { BlueprintDef, UIWidgetDef } from "../../project";
import { useEditor } from "../../store";
import { ValueExpressionPicker } from "./ValueExpressionPicker";

const PILL: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 3,
  color: "var(--text)",
  outline: "none",
};

/** Resolve which BlueprintDef / UIWidgetDef the subject points at. Returns
 *  null when subject doesn't reference a specific asset (system / mouse /
 *  keyboard / world / self). */
function resolveSubjectAsset(
  subject: Subject | undefined,
  hostBp: BlueprintDef,
  isMain: boolean,
  blueprints: BlueprintDef[],
  uiWidgets: UIWidgetDef[],
): { name: string; variables: string[] } | null {
  if (!subject) return null;
  if (subject.kind === "self") {
    if (isMain) return null; // main sheet has no real "self" — fall through to free
    return { name: hostBp.name, variables: hostBp.variables.map((v) => v.name) };
  }
  // World subject dropped — System on Main Sheet covers global vars.
  // Compare on System with subject=Self (= world host on Main) reads
  // globals directly; or use Object=World on the right-side picker for
  // cross-object reads.
  if (subject.kind === "bp" && subject.bpId) {
    const bp = blueprints.find((b) => b.id === subject.bpId);
    return bp ? { name: bp.name, variables: bp.variables.map((v) => v.name) } : null;
  }
  if (subject.kind === "uiwidget" && subject.bpId) {
    const w = uiWidgets.find((x) => x.id === subject.bpId);
    return w ? { name: w.name, variables: w.variables.map((v) => v.name) } : null;
  }
  return null; // system / mouse / keyboard
}

export function SubjectVarPicker({
  value, onChange, subject, hostBp, isMain,
}: {
  value: string;
  onChange: (next: string) => void;
  subject?: Subject;
  hostBp: BlueprintDef;
  isMain: boolean;
}) {
  const blueprints = useEditor((s) => s.project.blueprints);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);

  const asset = resolveSubjectAsset(subject, hostBp, isMain, blueprints, uiWidgets);

  // Free-scope subjects (system / mouse / keyboard) or unresolved ones —
  // fall back to the full picker so the author can compare any two values.
  if (!asset) {
    return (
      <ValueExpressionPicker
        value={value}
        onChange={onChange}
        subject={subject}
        hostBp={hostBp}
        isMain={isMain}
      />
    );
  }

  // Subject-locked: ONE dropdown, only the subject's variables. No object
  // picker, no literal toggle — those would contradict "I'm already
  // narrowed to <asset.name>'s scope."
  const vars = asset.variables;
  // Strip a legacy `var:Asset.field` prefix if present so re-rendered
  // values pick the right entry. Bare names are the canonical storage.
  const stored = value.startsWith(`var:${asset.name}.`)
    ? value.slice(`var:${asset.name}.`.length)
    : value;
  const selected = vars.includes(stored) ? stored : (vars[0] ?? "");

  // Auto-commit the displayed default to the store when the stored value
  // is empty / out-of-list. Without this, the dropdown VISUALLY shows
  // "coins" (the first var) but `condition.left` stays "" — runtime
  // resolves "" to undefined → comparison falls through to string mode
  // and "" < "anything" is mysteriously true. Now the displayed default
  // becomes the actually-stored value on mount.
  useEffect(() => {
    if (vars.length > 0 && stored !== selected && selected !== "") {
      onChange(selected);
    }
    // Re-run when the resolved subject's vars change (e.g. user changed
    // subject via Back button) or stored changed externally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, stored, vars.join("|")]);

  if (vars.length === 0) {
    return (
      <span style={{ ...PILL, color: "var(--text-muted)", fontStyle: "italic", padding: "2px 8px" }}>
        ({asset.name} has no vars)
      </span>
    );
  }

  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...PILL, maxWidth: 140 }}
      title={`Variable on ${asset.name} (locked — pick another subject to change object)`}
    >
      {vars.map((v) => (
        <option key={v} value={v}>{v}</option>
      ))}
    </select>
  );
}
