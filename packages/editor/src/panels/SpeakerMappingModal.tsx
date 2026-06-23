import { useState } from "react";
import { useEditor } from "../store";
import type { DialogueAsset } from "../project";

const NARRATOR_SENTINEL = "__narrator__";

/**
 * Post-upload speaker mapping confirmation. Shown when a parsed script
 * contains speaker labels that didn't auto-match any Blueprint by exact /
 * case-insensitive name or by tag.
 *
 * Each unmatched speaker gets a dropdown:
 *   - "Narrator (default)" → empty string in speakerMap (runtime falls
 *     back to dialogueDefaults.narratorBpId).
 *   - any Blueprint → maps the label to that BP's id.
 *
 * The user can dismiss by mapping all (or skipping) and clicking Confirm.
 */
export function SpeakerMappingModal({
  asset,
  unmatched,
  onConfirm,
  onCancel,
}: {
  asset: DialogueAsset;
  unmatched: string[];
  onConfirm: (mapping: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const blueprints = useEditor((s) => s.project.blueprints);
  // Local draft so the user can review before committing.
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const sp of unmatched) out[sp] = ""; // default = narrator fallback
    return out;
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="card"
        style={{
          padding: 20,
          minWidth: 480,
          maxWidth: 600,
          maxHeight: "80vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Map Speakers — {asset.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.4 }}>
          {unmatched.length} speaker{unmatched.length === 1 ? "" : "s"} in your script didn't match a Blueprint name. Pick where each should display, or leave as Narrator to use the project's narrator BP.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {unmatched.map((sp) => (
            <div
              key={sp}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                alignItems: "center",
                padding: "6px 8px",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{sp}</div>
              <select
                value={draft[sp] || NARRATOR_SENTINEL}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => ({ ...d, [sp]: v === NARRATOR_SENTINEL ? "" : v }));
                }}
                style={{ fontSize: 12, padding: "3px 6px" }}
              >
                <option value={NARRATOR_SENTINEL}>Narrator (default)</option>
                {blueprints.map((bp) => (
                  <option key={bp.id} value={bp.id}>{bp.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="ghost" onClick={onCancel} style={{ fontSize: 12 }}>Cancel</button>
          <button className="primary" onClick={() => onConfirm(draft)} style={{ fontSize: 12 }}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
