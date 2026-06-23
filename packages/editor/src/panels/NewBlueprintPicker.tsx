import { BpClass, CLASSES, PUBLIC_CLASSES } from "../blueprintClasses";

/**
 * Modal shown whenever the user creates a new Blueprint. Lets them pick a
 * class (Character / future …); the parent handles the actual creation via
 * `onPick` so different call sites can supply different `path` / context.
 */
export function NewBlueprintPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (cls: BpClass) => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <header>
          <span>New Blueprint</span>
          <button className="ghost" onClick={onClose} style={{ fontSize: 14, padding: "0 6px" }}>×</button>
        </header>
        <div className="body" style={{ display: "flex", flexDirection: "column", gridTemplateColumns: "unset", gap: 8 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.6 }}>
            Pick a class
          </span>
          {PUBLIC_CLASSES.map((cls) => {
            const meta = CLASSES[cls];
            return (
              <button
                key={cls}
                onClick={() => onPick(cls)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 4,
                  padding: "12px 14px",
                  background: "var(--inner)",
                  border: "1px solid transparent",
                  borderRadius: 12,
                  textAlign: "left",
                  width: "100%",
                  cursor: "crosshair",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--yellow)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "transparent"; }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{meta.label}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{meta.description}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
