import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor } from "../store";

/**
 * Hybrid value editor — number OR `var:<BpName>.<varName>` binding.
 *
 * Used by UI widget Slider / ProgressBar `value` fields and any other
 * "number-or-expression" spot. Eliminates the dual-meaning input that
 * forces authors to remember the `var:Foo.bar` syntax: a Binding tab
 * walks them through BP + var selection and writes the correct string.
 *
 * Round-trips through a single string slot on the host config:
 *  - Pure numeric → stored as number ("50" or 50)
 *  - Binding picked → stored as "var:Player.hp"
 *  - Free-text expression → preserved as-is ("var:hp + 10")
 */
export function ValueOrVarBinding({
  value, onChange, placeholder, style,
}: {
  value: number | string;
  onChange: (next: number | string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const blueprints = useEditor((s) => s.project.blueprints);

  // Detect mode from current value. Numbers → "literal". Strings starting
  // with `var:` → "binding". Everything else (free expression) → "literal"
  // shown as text but not a number — author can still type.
  const valueStr = String(value ?? "");
  const isBinding = valueStr.startsWith("var:");

  // Parse a binding string into (bp, var). Format: var:BpName.varName.
  // The pre-dot part is the BP name lookup; runtime resolves it.
  const parsedBinding = useMemo(() => {
    if (!isBinding) return { bp: "", varName: "" };
    const stripped = valueStr.slice(4); // drop "var:"
    const dot = stripped.indexOf(".");
    if (dot < 0) return { bp: "", varName: stripped };
    return { bp: stripped.slice(0, dot), varName: stripped.slice(dot + 1) };
  }, [valueStr, isBinding]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  const openPicker = () => {
    if (btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setPickerOpen((o) => !o);
  };

  // Picker popup dimensions / clamp — mirrors SignalPicker.
  const POPUP_W = anchorRect ? Math.max(280, anchorRect.width) : 280;
  const POPUP_MAX_H = 360;
  const winW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight : 1080;
  const popupLeft = anchorRect ? Math.min(anchorRect.left, winW - POPUP_W - 8) : 0;
  const popupTop = anchorRect ? Math.min(anchorRect.bottom + 4, winH - POPUP_MAX_H - 8) : 0;

  const commitBinding = (bp: string, varName: string) => {
    if (!bp || !varName) return;
    onChange(`var:${bp}.${varName}`);
    setPickerOpen(false);
  };

  return (
    <div style={{ display: "inline-flex", gap: 4, alignItems: "center", width: "100%", ...style }}>
      {/* Value input — numeric when stored as number, otherwise text (lets
          authors edit a binding string or expression freely). */}
      <input
        type="text"
        value={valueStr}
        onChange={(e) => {
          const t = e.target.value;
          const n = Number(t);
          // Store as number when the input parses cleanly to a finite
          // number (no var: prefix, no expression). Otherwise preserve
          // as string for the runtime's numOr to resolve.
          onChange(t.trim() !== "" && Number.isFinite(n) && !t.includes(":") && !t.includes(" ") ? n : t);
        }}
        placeholder={placeholder ?? "50  or  var:Player.hp"}
        style={{
          flex: 1, minWidth: 0,
          fontSize: 11, padding: "2px 8px",
          background: "var(--inner)",
          border: `1px solid ${isBinding ? "rgba(120,180,255,0.5)" : "rgba(255,255,255,0.15)"}`,
          borderRadius: 3, color: "var(--text)",
          fontFamily: isBinding ? "ui-monospace, monospace" : undefined,
        }}
        title={isBinding ? `Live binding: re-reads ${valueStr} every tick` : "Literal value or free expression"}
      />
      <button
        ref={btnRef}
        type="button"
        onClick={openPicker}
        style={{
          padding: "2px 6px", fontSize: 11,
          background: pickerOpen ? "var(--accent)" : "rgba(120,180,255,0.15)",
          border: "1px solid rgba(120,180,255,0.35)",
          borderRadius: 3,
          color: pickerOpen ? "var(--frame)" : "var(--text)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
        title="Bind to a BP variable — sets the value to `var:BpName.varName` so it updates live as the variable changes."
      >🔗 Bind</button>

      {pickerOpen && anchorRect && createPortal(
        <div
          ref={popupRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: popupTop, left: popupLeft,
            width: POPUP_W, maxHeight: POPUP_MAX_H,
            overflowY: "auto",
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 4, padding: 8, zIndex: 9999,
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}
        >
          <div style={{ fontSize: 9, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Bind to a Variable
          </div>
          {blueprints.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }}>
              No blueprints in this project. Declare one first to bind values.
            </div>
          ) : (
            blueprints.map((bp) => {
              const vars = bp.variables ?? [];
              if (vars.length === 0) return null;
              return (
                <div key={bp.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10, color: "rgba(120,180,255,0.85)", fontWeight: 700, marginBottom: 2 }}>{bp.name}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {vars.map((v) => {
                      const isSelected = parsedBinding.bp === bp.name && parsedBinding.varName === v.name;
                      return (
                        <div
                          key={v.id}
                          onClick={() => commitBinding(bp.name, v.name)}
                          title={`${bp.name}.${v.name} (${v.type}, default ${String(v.default)})`}
                          style={{
                            padding: "3px 6px",
                            fontSize: 11,
                            background: isSelected ? "rgba(255,205,60,0.15)" : "transparent",
                            cursor: "pointer",
                            borderRadius: 2,
                            display: "flex",
                            justifyContent: "space-between",
                            color: "var(--text)",
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isSelected ? "rgba(255,205,60,0.15)" : "transparent"; }}
                        >
                          <span>{v.name}</span>
                          <span style={{ fontSize: 9, color: "var(--text-dim)" }}>{v.type}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
          {/* Clear-binding row at the bottom — restores literal-number
              authoring with one click. */}
          {isBinding && (
            <div
              onClick={() => { onChange(0); setPickerOpen(false); }}
              style={{
                marginTop: 6, padding: "4px 6px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                fontSize: 10, color: "var(--text-dim)",
                cursor: "pointer", textAlign: "center",
              }}
            >Clear binding → 0</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
