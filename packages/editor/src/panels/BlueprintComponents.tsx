import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BehaviorKind, BlueprintDef } from "../project";
import { BEHAVIOR_PARAMS } from "../behaviorMeta";
import { useEditor } from "../store";
import { ComponentIcon, hasComponentIcon } from "../componentIcons";

/**
 * Auto chip color for a behavior kind. Decorative — the cube to the left of
 * the chip label uses this. Drives at-a-glance recognition.
 */
function colorForBehavior(kind: BehaviorKind): string {
  switch (kind) {
    case "CharacterMovement": return "#4ad17a";
    case "Collider":          return "#4ab1d1";
    case "SpriteRenderer":    return "#d18a4a";
    case "Solid":             return "#7e7eaa";
    default:                  return "#888";
  }
}

/**
 * Components panel (left rail) — chip grid of ATTACHED behaviors.
 *
 * Components are added by clicking the `+ Component` button at the top, which
 * opens a dropdown of available behavior kinds. Each attached chip shows a
 * small colored icon-placeholder cube + the kind name. Clicking a chip body
 * selects it (drives which component the middle column's detail panel
 * edits). The selected chip is highlighted in orange/yellow. A small × on
 * the selected chip detaches.
 */
export function BlueprintComponents({
  bp,
  selectedIdx,
  onSelect,
}: {
  bp: BlueprintDef;
  selectedIdx: number | null;
  onSelect: (idx: number | null) => void;
}) {
  const addBlueprintBehavior = useEditor((s) => s.addBlueprintBehavior);
  const removeBlueprintBehavior = useEditor((s) => s.removeBlueprintBehavior);
  const updateBlueprintBehavior = useEditor((s) => s.updateBlueprintBehavior);
  const duplicateBlueprintBehavior = useEditor((s) => s.duplicateBlueprintBehavior);
  const reorderBlueprintBehavior = useEditor((s) => s.reorderBlueprintBehavior);

  const [addOpen, setAddOpen] = useState(false);
  const [addRect, setAddRect] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  /** Index of the component currently being renamed inline. */
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  /** Drag-reorder state: which chip is being dragged, and where would it
   *  land if dropped right now (for the insertion-line cue). */
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleOpen = () => {
    if (!addOpen && addBtnRef.current) setAddRect(addBtnRef.current.getBoundingClientRect());
    setAddOpen((v) => !v);
  };

  useEffect(() => {
    if (!addOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest("[data-add-component-portal]") && !addBtnRef.current?.contains(target)) {
        setAddOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [addOpen]);

  const allKinds = Object.keys(BEHAVIOR_PARAMS) as BehaviorKind[];
  // Multi-instance components — can be attached more than once to the same
  // BP. Tracer uses its `name` field to disambiguate (e.g. groundCheck +
  // wallCheck on the same character). Text supports multiple labels per BP
  // via per-instance offsetX/Y. Other behaviors stay single-instance.
  const MULTI_INSTANCE: ReadonlySet<BehaviorKind> = new Set<BehaviorKind>(["Tracer", "Text", "ParticleEmitter"]);
  // Camera is reserved — it's only valid on a Camera-class BP, where the
  // class template auto-attaches it. Hide from the Components picker on
  // every other BP class so authors don't accidentally attach it to a
  // Player and pollute their picker with Camera kinds.
  // CharacterAnimator's authoring surface lives at the top of the
  // Animation Slots section in the BP Overview — its component chip
  // would show "(no config)" and confuse authors. Hide everywhere.
  // Class-reserved behaviors — auto-attached by their owning BP class
  // template (or auto-promoted into the Animation Slots UI), hidden
  // from the Components picker so authors can't accidentally pollute
  // (e.g. attaching Camera to Player, or having a chip for CharacterAnimator
  // when there's nothing useful to click into).
  // UIWidgetRenderer is the internal renderer attached automatically to
  // spawned widget sprites — never a user-attachable BP component. Hide
  // it so authors who want a healthbar use the `Widget` component instead.
  const CLASS_RESERVED: ReadonlySet<BehaviorKind> = new Set<BehaviorKind>(["Camera", "StateMachine", "UIWidgetRenderer"]);
  // Camera-class BPs are single-purpose controllers — only the auto-
  // attached Camera component, nothing else.
  const availableToAdd = bp.classKind === "Camera"
    ? []
    : allKinds.filter((k) => {
        if (CLASS_RESERVED.has(k)) return false;
        return MULTI_INSTANCE.has(k) || !bp.behaviors.some((b) => b.kind === k);
      });

  const handleRemove = (idx: number) => {
    const kind = bp.behaviors[idx]?.kind ?? "component";
    if (!window.confirm(`Detach ${kind} from this blueprint?`)) return;
    const wasSelected = idx === selectedIdx;
    removeBlueprintBehavior(bp.id, idx);
    if (wasSelected) onSelect(null);
    else if (selectedIdx !== null && idx < selectedIdx) onSelect(selectedIdx - 1);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 12px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          ref={addBtnRef}
          onClick={handleOpen}
          disabled={availableToAdd.length === 0}
          style={{
            padding: "3px 10px",
            fontSize: 11,
            fontWeight: 600,
            background: availableToAdd.length === 0 ? "rgba(255,255,255,0.04)" : "rgba(74, 124, 209, 0.45)",
            color: availableToAdd.length === 0 ? "var(--text-muted)" : "var(--text)",
            border: "1px solid rgba(140, 160, 220, 0.3)",
            borderRadius: 4,
            cursor: availableToAdd.length === 0 ? "default" : "pointer",
          }}
          title={
            bp.classKind === "Camera" ? "Camera BPs only host the Camera component"
            : availableToAdd.length === 0 ? "All components are attached"
            : "Attach a new component"
          }
        >+ Component</button>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{bp.behaviors.length}</span>
      </div>

      {(() => {
        // Hide CharacterAnimator chips entirely — its UI lives at the top
        // of the Animation Slots section in the BP Overview, so a chip
        // here that opens "(no config)" is just noise. Render the rest.
        const visible = bp.behaviors
          .map((b, idx) => ({ b, idx }))
          .filter(({ b }) => b.kind !== "StateMachine");
        if (visible.length === 0) {
          return (
            <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
              No components yet. Click + Component to add one.
            </div>
          );
        }
        return (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
          padding: "4px 10px 8px",
        }}>
          {visible.map(({ b, idx }) => {
            const isSelected = idx === selectedIdx;
            const disabled = b.enabled === false;
            const renamable = b.kind === "Tracer" || b.kind === "Text";
            // Display name: user-supplied `config.name` if set, else the
            // bare kind. Auto-numbering is done at attach time so the
            // config already has a sane default like "Tracer2".
            const displayName = (typeof b.config.name === "string" && b.config.name)
              ? b.config.name
              : b.kind;
            const isRenaming = renamingIdx === idx;
            const commitRename = () => {
              const trimmed = renameValue.trim();
              // Skip if name unchanged or another sibling already owns it.
              const currentName = typeof b.config.name === "string" ? b.config.name : "";
              if (trimmed && trimmed !== currentName) {
                const dup = bp.behaviors.some((other, j) =>
                  j !== idx && other.kind === b.kind && other.config.name === trimmed,
                );
                if (!dup) {
                  updateBlueprintBehavior(bp.id, idx, { ...b.config, name: trimmed });
                }
              }
              setRenamingIdx(null);
            };
            const isDragging = dragFromIdx === idx;
            const showInsertCue = dragOverIdx === idx && dragFromIdx !== null && dragFromIdx !== idx;
            return (
              <div
                key={idx}
                draggable={!isRenaming}
                onDragStart={(e) => {
                  if (isRenaming) return;
                  setDragFromIdx(idx);
                  e.dataTransfer.effectAllowed = "move";
                  // Most browsers require some data set for dragstart to fire.
                  try { e.dataTransfer.setData("text/plain", String(idx)); } catch { /* Safari */ }
                }}
                onDragEnd={() => { setDragFromIdx(null); setDragOverIdx(null); }}
                onDragOver={(e) => {
                  if (dragFromIdx === null || dragFromIdx === idx) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverIdx !== idx) setDragOverIdx(idx);
                }}
                onDragLeave={() => { if (dragOverIdx === idx) setDragOverIdx(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFromIdx;
                  setDragFromIdx(null);
                  setDragOverIdx(null);
                  if (from === null || from === idx) return;
                  // Drop ON a chip → insert at that chip's slot. splice
                  // semantics: passing `idx` after removing `from` lands the
                  // moved chip at position `idx` regardless of direction —
                  // the store's reorder helper handles the adjustment.
                  const target = from < idx ? idx + 1 : idx;
                  reorderBlueprintBehavior(bp.id, from, target);
                  // Re-anchor selection on the dragged chip's new slot so
                  // the inspector keeps editing the same behavior.
                  if (selectedIdx === from) onSelect(idx);
                  else if (selectedIdx !== null) {
                    // Compensate selection if the move shifted the selected
                    // chip's index.
                    if (from < selectedIdx && idx >= selectedIdx) onSelect(selectedIdx - 1);
                    else if (from > selectedIdx && idx <= selectedIdx) onSelect(selectedIdx + 1);
                  }
                }}
                onClick={() => { if (!isRenaming) onSelect(isSelected ? null : idx); }}
                onDoubleClick={(e) => {
                  if (!renamable) return;
                  e.stopPropagation();
                  setRenameValue(displayName);
                  setRenamingIdx(idx);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 8px",
                  background: isSelected
                    ? "rgba(245,180,71,0.85)"
                    : "rgba(255,255,255,0.06)",
                  border: `1px solid ${isSelected ? "var(--yellow, #f5b447)" : "rgba(255,255,255,0.08)"}`,
                  borderTop: showInsertCue ? "2px solid var(--yellow, #f5b447)" : undefined,
                  borderRadius: 4,
                  color: isSelected ? "#1a1a1a" : disabled ? "var(--text-muted)" : "var(--text-2)",
                  fontSize: 11,
                  fontWeight: isSelected ? 600 : 400,
                  cursor: isRenaming ? "text" : "grab",
                  userSelect: "none",
                  textDecoration: disabled ? "line-through" : "none",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  opacity: isDragging ? 0.4 : 1,
                }}
                title={`${displayName} (${b.kind})${disabled ? " — disabled" : ""}${renamable ? " — double-click to rename, drag to reorder" : " — drag to reorder"}`}
              >
                {hasComponentIcon(b.kind) ? (
                  <ComponentIcon kind={b.kind} size={14} style={{ flex: "0 0 auto" }} />
                ) : (
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      background: colorForBehavior(b.kind),
                      border: "1px solid rgba(0,0,0,0.4)",
                      borderRadius: 2,
                      flex: "0 0 auto",
                    }}
                  />
                )}
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); setRenamingIdx(null); }
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11,
                      padding: "1px 4px",
                      border: "1px solid rgba(0,0,0,0.5)",
                      borderRadius: 2,
                      background: "rgba(255,255,255,0.95)",
                      color: "#1a1a1a",
                    }}
                  />
                ) : (
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{displayName}</span>
                )}
                {isSelected && !isRenaming
                  && !(bp.classKind === "Camera" && b.kind === "Camera") && (
                  <>
                    {/* Duplicate button — only shows for multi-instance
                        kinds (Tracer / Text) since single-instance
                        behaviors can't have a second copy. */}
                    {MULTI_INSTANCE.has(b.kind) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); duplicateBlueprintBehavior(bp.id, idx); }}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#1a1a1a",
                          cursor: "pointer",
                          fontSize: 11,
                          padding: "0 4px",
                          lineHeight: 1,
                          fontWeight: 800,
                        }}
                        title="Duplicate this component with the same parameters"
                      >⎘</button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(idx); }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "#1a1a1a",
                        cursor: "pointer",
                        fontSize: 13,
                        padding: 0,
                        lineHeight: 1,
                        fontWeight: 800,
                      }}
                      title="Detach component"
                    >×</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        );
      })()}

      {addOpen && addRect && createPortal(
        <div
          data-add-component-portal
          style={{
            position: "fixed",
            top: addRect.bottom + 4,
            left: addRect.left,
            minWidth: 180,
            background: "var(--inner)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6,
            zIndex: 9999,
            padding: 4,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          }}
        >
          {availableToAdd.map((k) => (
            <button
              key={k}
              onClick={() => {
                addBlueprintBehavior(bp.id, k);
                onSelect(bp.behaviors.length); // newly attached = last index
                setAddOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "6px 10px",
                background: "transparent",
                border: "none",
                color: "var(--text-2)",
                fontSize: 11,
                textAlign: "left",
                borderRadius: 4,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {hasComponentIcon(k) ? (
                <ComponentIcon kind={k} size={14} style={{ flex: "0 0 auto" }} />
              ) : (
                <span style={{
                  width: 12,
                  height: 12,
                  background: colorForBehavior(k),
                  border: "1px solid rgba(0,0,0,0.4)",
                  borderRadius: 2,
                  flex: "0 0 auto",
                }} />
              )}
              {k}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
