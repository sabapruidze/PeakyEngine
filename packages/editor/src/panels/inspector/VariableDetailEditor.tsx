/**
 * Variable detail editor — left-rail panel that appears below the variable
 * chip grid for the currently-selected variable.
 *
 * Mirrors the mockup: Default Value · Auto Cap (min/max) · Instance Editable ·
 * Expose on Spawn. Plus a Type / Number-kind picker. Chip color is auto-
 * derived from type (no picker) — see {@link defaultColorForType}.
 */

import { useEditor } from "../../store";
import { Toggle } from "../../components/Toggle";
import { VariableDef } from "../../project";

export function VariableDetailEditor({ bpId, variable }: { bpId: string; variable: VariableDef }) {
  const setVariableType = useEditor((s) => s.setVariableType);
  const setVariableDefault = useEditor((s) => s.setVariableDefault);
  const setVariableAutoCap = useEditor((s) => s.setVariableAutoCap);
  const setVariableInstanceEditable = useEditor((s) => s.setVariableInstanceEditable);
  const setVariableExposeOnSpawn = useEditor((s) => s.setVariableExposeOnSpawn);
  const setVariableNumberKind = useEditor((s) => s.setVariableNumberKind);
  const setVariableGlobal = useEditor((s) => s.setVariableGlobal);

  const isNumber = variable.type === "number";
  const isBool = variable.type === "bool";
  const cap = variable.autoCap;
  const numberKind = variable.numberKind ?? "integer";

  const rowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "center",
    gap: 8,
    padding: "5px 8px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 4,
    fontSize: 11,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 10px 8px" }}>
      <Row label="Type" rowStyle={rowStyle}>
        <select
          // Flat 4-way picker (matches Globals + Lists): "number" = integer,
          // "float" = decimal. Both map to type=number with the numberKind set.
          value={variable.type === "number" ? (numberKind === "float" ? "float" : "number") : variable.type}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "number" || v === "float") {
              setVariableType(bpId, variable.id, "number");
              setVariableNumberKind(bpId, variable.id, v === "float" ? "float" : "integer");
            } else {
              setVariableType(bpId, variable.id, v as "string" | "bool");
            }
          }}
          style={inputStyle}
          title="number = whole, float = decimal, string = text, bool = true/false."
        >
          <option value="number">number</option>
          <option value="float">float</option>
          <option value="string">string</option>
          <option value="bool">bool</option>
        </select>
      </Row>

      <Row label="Default Value" rowStyle={rowStyle}>
        {isBool ? (
          <select
            value={variable.default ? "true" : "false"}
            onChange={(e) => setVariableDefault(bpId, variable.id, e.target.value === "true")}
            style={inputStyle}
          >
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        ) : isNumber ? (
          <input
            type="number"
            step={numberKind === "integer" ? "1" : "any"}
            value={typeof variable.default === "number" ? variable.default : 0}
            onChange={(e) => {
              const raw = parseFloat(e.target.value) || 0;
              const v = numberKind === "integer" ? Math.round(raw) : raw;
              setVariableDefault(bpId, variable.id, v);
            }}
            style={inputStyle}
          />
        ) : (
          <input
            value={String(variable.default ?? "")}
            onChange={(e) => setVariableDefault(bpId, variable.id, e.target.value)}
            style={inputStyle}
          />
        )}
      </Row>

      {isNumber && (
        <Row label="Auto Cap" rowStyle={rowStyle}>
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              type="number"
              step={numberKind === "integer" ? "1" : "any"}
              value={cap ? cap[0] : ""}
              placeholder="min"
              onChange={(e) => {
                const raw = parseFloat(e.target.value);
                if (Number.isNaN(raw)) {
                  setVariableAutoCap(bpId, variable.id, undefined);
                } else {
                  const min = numberKind === "integer" ? Math.round(raw) : raw;
                  setVariableAutoCap(bpId, variable.id, [min, cap?.[1] ?? min]);
                }
              }}
              style={{ ...inputStyle, width: 60 }}
            />
            <input
              type="number"
              step={numberKind === "integer" ? "1" : "any"}
              value={cap ? cap[1] : ""}
              placeholder="max"
              onChange={(e) => {
                const raw = parseFloat(e.target.value);
                if (Number.isNaN(raw)) {
                  setVariableAutoCap(bpId, variable.id, undefined);
                } else {
                  const max = numberKind === "integer" ? Math.round(raw) : raw;
                  setVariableAutoCap(bpId, variable.id, [cap?.[0] ?? max, max]);
                }
              }}
              style={{ ...inputStyle, width: 60 }}
            />
          </span>
        </Row>
      )}

      {/* Per-instance + spawn-arg flags only make sense for BP/widget vars
          (which have instances and may be spawned from code). The Main
          Event Sheet's vars are scene-global — there are no instances and
          no spawn — so hide both toggles when bpId is the main-sheet
          sentinel. */}
      {!bpId.startsWith("__main__:") && (
        <>
          <Row label="Instance Editable" rowStyle={rowStyle}>
            <Toggle
              value={!!variable.instanceEditable}
              onChange={(v) => setVariableInstanceEditable(bpId, variable.id, v)}
              title="Allow per-placement override of this variable in the scene"
            />
          </Row>

          <Row label="Expose on Spawn" rowStyle={rowStyle}>
            <Toggle
              value={!!variable.exposeOnSpawn}
              onChange={(v) => setVariableExposeOnSpawn(bpId, variable.id, v)}
              title="Include this variable as a parameter when spawning the BP from code"
            />
          </Row>

          <Row label="Global" rowStyle={rowStyle}>
            <Toggle
              value={!!variable.global}
              onChange={(v) => setVariableGlobal(bpId, variable.id, v)}
              title="Persist this variable across scenes + save/load and SHARE one value across every instance. For singleton Blueprints (Player, GameManager). Read anywhere via global:<name> or var:<BP>.<name>."
            />
          </Row>
          {variable.global && (
            <div style={{ fontSize: 9.5, color: "var(--yellow)", padding: "0 8px 2px", lineHeight: 1.3 }}>
              Shared across ALL instances + scenes. Use only on singleton Blueprints. Read via <code>global:{variable.name}</code>.
            </div>
          )}
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 3,
  color: "var(--text)",
  outline: "none",
};

function Row({ label, children, rowStyle }: { label: string; children: React.ReactNode; rowStyle: React.CSSProperties }) {
  return (
    <div style={rowStyle}>
      <span style={{ color: "var(--text-2)" }}>{label}</span>
      {children}
    </div>
  );
}

/**
 * Auto chip color for a variable, by type. Per the user's reference:
 *   bool    → red
 *   integer → bluish-green
 *   float   → green
 *   string  → purple
 */
export function defaultColorForType(t: VariableDef["type"], numberKind?: VariableDef["numberKind"]): string {
  if (t === "bool") return "#e54040";
  if (t === "string") return "#a350c7";
  if (t === "number") return numberKind === "float" ? "#3fc66e" : "#34c8a8";
  return "#888";
}
