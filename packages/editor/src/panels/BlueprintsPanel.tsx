import { useEditor } from "../store";

export function BlueprintsPanel() {
  const blueprints = useEditor((s) => s.project.blueprints);
  const selectedId = useEditor((s) => s.selectedBlueprintId);
  const select = useEditor((s) => s.selectBlueprint);
  const add = useEditor((s) => s.addBlueprint);

  return (
    <div className="panel">
      <h2>Blueprints</h2>
      <div>
        {blueprints.length === 0 && (
          <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
            No blueprints. Click "+ New Blueprint".
          </div>
        )}
        {blueprints.map((b) => (
          <div
            key={b.id}
            className={`object-row ${b.id === selectedId ? "selected" : ""}`}
            onClick={() => select(b.id)}
          >
            <div className="swatch" style={{ background: `#${b.color.toString(16).padStart(6, "0")}` }} />
            <div className="name">{b.name}</div>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{b.behaviors.length}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: 8 }}>
        <button style={{ width: "100%" }} onClick={() => add()}>+ New Blueprint</button>
      </div>
    </div>
  );
}
