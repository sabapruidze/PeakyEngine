import { useEditor } from "../store";

interface Props {
  onClose: () => void;
}

/**
 * Modal that lets the user pick which Blueprint to add as an instance into
 * the active scene. Blueprint = the "type" being placed (Player, Coin, ...).
 *
 * Placement defaults to the scene's center so the user immediately sees what
 * they added; they can drag from there.
 */
export function BlueprintPicker({ onClose }: Props) {
  const blueprints = useEditor((s) => s.project.blueprints);
  const scene = useEditor((s) => s.activeScene());
  const place = useEditor((s) => s.placeInstance);
  const setView = useEditor((s) => s.setView);
  const addBlueprint = useEditor((s) => s.addBlueprint);

  const pick = (bpId: string) => {
    place(bpId, scene.width / 2, scene.height / 2);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <span>Add Object — choose a Blueprint</span>
          <button onClick={onClose} style={{ fontSize: 11 }}>Close</button>
        </header>

        {blueprints.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
            <div style={{ marginBottom: 12 }}>You don't have any Blueprints yet.</div>
            <button
              className="primary"
              onClick={() => {
                addBlueprint();
                setView("blueprint");
                onClose();
              }}
            >
              Create one now →
            </button>
          </div>
        ) : (
          <div className="body">
            {blueprints.map((b) => (
              <div key={b.id} className="bp-card" onClick={() => pick(b.id)}>
                <div className="preview" style={{ background: `#${b.color.toString(16).padStart(6, "0")}` }} />
                <div className="meta">
                  <span className="name">{b.name}</span>
                  <span className="components">
                    {b.behaviors.length === 0 ? "no components" : b.behaviors.map((c) => c.kind).join(" + ")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
