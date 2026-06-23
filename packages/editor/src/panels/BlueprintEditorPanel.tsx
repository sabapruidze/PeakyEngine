import { useEditor } from "../store";

/**
 * The center pane in Blueprint view. Shows:
 *  - A preview of the blueprint's visual (color/size as a centered rect)
 *  - The components/behaviors list (clickable, but selection of a single behavior
 *    is deferred — for now the Inspector edits all of them inline).
 */
export function BlueprintEditorPanel() {
  const bp = useEditor((s) => s.selectedBlueprint());

  if (!bp) {
    return (
      <div className="scene-area" style={{ flexDirection: "column", gap: 12 }}>
        <div style={{ color: "var(--text-dim)" }}>Select a blueprint to edit, or create a new one.</div>
      </div>
    );
  }

  const PREVIEW_BOX = 480;
  const scale = Math.min(PREVIEW_BOX / Math.max(bp.w, 80), PREVIEW_BOX / Math.max(bp.h, 80), 4);

  return (
    <div className="scene-area" style={{ flexDirection: "column", gap: 16 }}>
      <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
        Editing Blueprint: <span style={{ color: "var(--accent)" }}>{bp.name}</span>
      </div>

      <div
        style={{
          width: PREVIEW_BOX,
          height: PREVIEW_BOX,
          background: "#0a0b10",
          border: "1px dashed var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <div
          style={{
            width: bp.w * scale,
            height: bp.h * scale,
            background: `#${bp.color.toString(16).padStart(6, "0")}`,
            outline: "2px solid var(--accent)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          {bp.w} × {bp.h} px &middot; preview {scale.toFixed(2)}×
        </div>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
        {bp.behaviors.length === 0
          ? "No components yet. Add one from the Inspector →"
          : `${bp.behaviors.length} component${bp.behaviors.length === 1 ? "" : "s"}: ${bp.behaviors.map((b) => b.kind).join(", ")}`}
      </div>
    </div>
  );
}
