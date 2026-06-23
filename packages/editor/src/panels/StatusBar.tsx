import { useEditor } from "../store";

/**
 * Bottom status bar card — connection dot, branch, scene info, perf counters.
 * Today most of these are static; counters become live once we wire perf.
 */
export function StatusBar() {
  const project = useEditor((s) => s.project);
  const scene = useEditor((s) => s.activeScene());
  const isRunning = useEditor((s) => s.isRunning);

  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: 12,
        padding: "7px 14px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: 10,
        color: "var(--text-muted)",
      }}
      className="mono"
    >
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: isRunning ? "var(--teal)" : "var(--text-faint)",
          }}
        />
        {isRunning ? "live" : "idle"}
      </span>
      <span>scene: {scene?.name ?? "—"}</span>
      <span>blueprints: {project.blueprints.length}</span>
      <span>instances: {scene?.instances.length ?? 0}</span>
      <span style={{ marginLeft: "auto" }}>peaky · 0.0.1</span>
    </div>
  );
}
