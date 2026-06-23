/**
 * The single "Open Logic Sheet" button used everywhere a Logic Sheet is
 * opened (Blueprint tab, UI widget, Main Sheets). One component so the
 * icon / text / styling stay identical across all call sites. Pass
 * `folderCount` to append the "(N events)" suffix.
 */
export function OpenLogicSheetButton({
  onClick,
  folderCount,
}: {
  onClick: () => void;
  folderCount?: number;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 14px", fontSize: 13, fontWeight: 600,
        background: "var(--accent)", color: "var(--frame)",
        border: "none", borderRadius: 6, cursor: "pointer", alignSelf: "flex-start",
      }}
    >🧩 Open Logic Sheet
      {folderCount !== undefined && (
        <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.85, fontWeight: 400 }}>
          ({folderCount} event{folderCount === 1 ? "" : "s"})
        </span>
      )}
    </button>
  );
}
