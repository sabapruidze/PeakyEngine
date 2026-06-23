import { useEditor } from "../store";

/**
 * Sticky bar shown when folder auto-save is failing. Clicking it copies the live
 * project JSON to the clipboard so the user can paste it into a file before
 * reloading — the silent-loss escape hatch. Renders nothing while auto-save is
 * healthy. Two flavors:
 *   - guard (amber): the empty-state wipe guard REFUSED the save — disk files
 *     are intact, nothing is lost; the in-memory project just dropped an asset
 *     type the save would have deleted. Reassure, don't alarm.
 *   - error (red): a genuine write failure (permission revoked, file locked) —
 *     recent edits are NOT on disk and will be lost on reload.
 */
export function SaveStatusBanner() {
  const status = useEditor((s) => s.autosaveStatus);
  const detail = useEditor((s) => s.autosaveError);
  const guard = useEditor((s) => s.autosaveGuard);
  if (status !== "broken") return null;

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(useEditor.getState().project, null, 2),
      );
      alert("Project JSON copied to clipboard. Paste it into a text file and save it now.");
    } catch {
      alert("Couldn't copy automatically. Use File → Save As to write your project to a file right now.");
    }
  };

  const msg = guard
    ? `⚠ Auto-save PAUSED — a save was refused to protect your files (${detail ?? "asset type went empty"}). Your disk files are intact. Undo the deletion, or use File → Save to confirm it on purpose.`
    : `⚠ Auto-save offline — folder write is failing${detail ? ` (${detail})` : ""}; recent edits are NOT on disk. Click to copy your project to the clipboard, then File → Save As now.`;

  return (
    <div
      onClick={onClick}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: guard ? "#b8860b" : "var(--red)",
        color: "#fff",
        fontSize: 12,
        fontWeight: 600,
        textAlign: "center",
        padding: "7px 14px",
        cursor: "pointer",
        userSelect: "none",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
      }}
    >
      {msg}
    </div>
  );
}
