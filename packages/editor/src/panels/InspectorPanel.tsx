import { useEditor } from "../store";
import { BlueprintInspector } from "./inspector/BlueprintInspector";
import { InstanceInspector } from "./inspector/InstanceInspector";

/**
 * Routes between the two inspector flavors based on which surface the user is on.
 *  - Blueprint view: edit class definition (visual + components).
 *  - Scene view:     edit a placement (position; later: per-instance overrides).
 */
export function InspectorPanel() {
  const view = useEditor((s) => s.view);

  return (
    <div className="panel right">
      <h2>Details</h2>
      {view === "blueprint" ? <BlueprintInspector /> : <InstanceInspector />}
    </div>
  );
}
