import { useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { LayerDef, SceneData } from "../project";

/**
 * Layers panel — Scene-tab right-rail UI. One row per layer in the
 * scene's `layers` list (top-of-list = drawn on top). Each row exposes:
 *
 *   - Active radio (which layer new placements drop into)
 *   - Visibility toggle
 *   - Name (click to rename inline)
 *   - Parallax X / Y inputs
 *   - Opacity slider
 *   - Drag handle (reorder)
 *   - Trash button (delete; disabled when only one layer remains)
 *
 * Rendering / parallax math lives in `runProject.ts`; this panel just
 * mutates the scene's layer list via store actions.
 */
export function LayersPanel() {
  const scene = useEditor((s) => s.activeScene());
  if (!scene) return null;
  return <LayersPanelInner scene={scene} />;
}

function LayersPanelInner({ scene }: { scene: SceneData }) {
  const addLayer        = useEditor((s) => s.addLayer);
  const removeLayer     = useEditor((s) => s.removeLayer);
  const renameLayer     = useEditor((s) => s.renameLayer);
  const setLayerParallax = useEditor((s) => s.setLayerParallax);
  const setLayerVisible  = useEditor((s) => s.setLayerVisible);
  const setLayerOpacity  = useEditor((s) => s.setLayerOpacity);
  const setLayerGlobal   = useEditor((s) => s.setLayerGlobal);
  const setLayerYSort    = useEditor((s) => s.setLayerYSort);
  const setLayerLocked   = useEditor((s) => s.setLayerLocked);
  const reorderLayer     = useEditor((s) => s.reorderLayer);
  const setActiveLayer   = useEditor((s) => s.setActiveLayer);

  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="label-uppercase">Layers</span>
        <button
          className="ghost"
          onClick={() => addLayer(scene.id)}
          style={{ fontSize: 11, padding: "2px 8px" }}
          title="Add a new layer (inserted above Background)"
        >+ Add</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 8px 8px", overflow: "auto" }}>
        {scene.layers.map((layer, idx) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            isActive={scene.activeLayerId === layer.id}
            isOnly={scene.layers.length <= 1}
            isEditingName={editingId === layer.id}
            onActivate={() => setActiveLayer(scene.id, layer.id)}
            onToggleVisible={() => setLayerVisible(scene.id, layer.id, !layer.visible)}
            onStartRename={() => setEditingId(layer.id)}
            onCommitRename={(name) => { renameLayer(scene.id, layer.id, name); setEditingId(null); }}
            onCancelRename={() => setEditingId(null)}
            onParallax={(x, y) => setLayerParallax(scene.id, layer.id, x, y)}
            onOpacity={(o) => setLayerOpacity(scene.id, layer.id, o)}
            onToggleGlobal={() => setLayerGlobal(scene.id, layer.id, !layer.global)}
            onToggleYSort={() => setLayerYSort(scene.id, layer.id, !layer.ySort)}
            onToggleLocked={() => setLayerLocked(scene.id, layer.id, !layer.locked)}
            onDelete={() => removeLayer(scene.id, layer.id)}
            onMoveUp={idx > 0 ? () => reorderLayer(scene.id, layer.id, idx - 1) : undefined}
            onMoveDown={idx < scene.layers.length - 1 ? () => reorderLayer(scene.id, layer.id, idx + 1) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function LayerRow({
  layer, isActive, isOnly, isEditingName,
  onActivate, onToggleVisible, onStartRename, onCommitRename, onCancelRename,
  onParallax, onOpacity, onToggleGlobal, onToggleYSort, onToggleLocked, onDelete, onMoveUp, onMoveDown,
}: {
  layer: LayerDef;
  isActive: boolean;
  isOnly: boolean;
  isEditingName: boolean;
  onActivate: () => void;
  onToggleVisible: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onParallax: (x: number, y: number) => void;
  onOpacity: (o: number) => void;
  onToggleGlobal: () => void;
  onToggleYSort: () => void;
  onToggleLocked: () => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [draftName, setDraftName] = useState(layer.name);

  return (
    <div
      onClick={onActivate}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        borderRadius: 6,
        background: isActive ? "rgba(245,207,71,0.12)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${isActive ? "var(--yellow)" : "rgba(255,255,255,0.06)"}`,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Active radio */}
        <span
          title={isActive ? "Active layer (new placements drop here)" : "Click to make active"}
          style={{
            width: 10, height: 10, borderRadius: "50%",
            border: `1px solid ${isActive ? "var(--yellow)" : "rgba(255,255,255,0.4)"}`,
            background: isActive ? "var(--yellow)" : "transparent",
            flex: "0 0 auto",
          }}
        />

        {/* Visibility */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
          title={layer.visible ? "Hide layer" : "Show layer"}
          style={{
            background: "transparent", border: "none", padding: 0,
            color: layer.visible ? "var(--text)" : "var(--text-faint)",
            fontSize: 13, cursor: "pointer", width: 16, textAlign: "center",
          }}
        >{layer.visible ? "👁" : "—"}</button>

        {/* Lock — editor-side; instances on a locked layer can't be selected
            or dragged in the scene canvas. Independent of runtime visibility. */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleLocked(); }}
          title={layer.locked ? "Unlock layer (allow selection / drag in scene)" : "Lock layer (block selection / drag in scene)"}
          style={{
            background: "transparent", border: "none", padding: 0,
            color: "var(--text-muted)",
            opacity: layer.locked ? 1 : 0.35,
            cursor: "pointer", width: 16, height: 16,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="6" width="8" height="5" rx="0.8" />
            {layer.locked
              ? <path d="M3.6 6V4.3a2.4 2.4 0 0 1 4.8 0V6" />
              : <path d="M3.6 6V4.3a2.4 2.4 0 0 1 4.8 0" />}
          </svg>
        </button>

        {/* Name */}
        {isEditingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => onCommitRename(draftName.trim() || layer.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename(draftName.trim() || layer.name);
              if (e.key === "Escape") onCancelRename();
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ flex: 1, fontSize: 12, padding: "1px 4px" }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setDraftName(layer.name); onStartRename(); }}
            style={{ flex: 1, fontSize: 12, fontWeight: isActive ? 700 : 500, color: "var(--text)", userSelect: "none" }}
            title="Double-click to rename"
          >{layer.name}</span>
        )}

        {/* Reorder */}
        <button
          onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }}
          disabled={!onMoveUp}
          title="Move layer up (towards front)"
          style={{ background: "transparent", border: "none", padding: 0, color: onMoveUp ? "var(--text-2)" : "var(--text-faint)", cursor: onMoveUp ? "pointer" : "default", width: 14, fontSize: 11 }}
        >▲</button>
        <button
          onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }}
          disabled={!onMoveDown}
          title="Move layer down (towards back)"
          style={{ background: "transparent", border: "none", padding: 0, color: onMoveDown ? "var(--text-2)" : "var(--text-faint)", cursor: onMoveDown ? "pointer" : "default", width: 14, fontSize: 11 }}
        >▼</button>

        {/* Delete */}
        <button
          onClick={(e) => { e.stopPropagation(); if (!isOnly) onDelete(); }}
          disabled={isOnly}
          title={isOnly ? "Can't delete the last layer" : "Delete layer (instances re-anchor to first remaining)"}
          style={{ background: "transparent", border: "none", padding: 0, color: isOnly ? "var(--text-faint)" : "var(--red)", cursor: isOnly ? "default" : "pointer", width: 14, fontSize: 12 }}
        >×</button>
      </div>

      {/* Parallax + opacity sub-row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-2)" }}>
        <span title="Parallax X / Y — 0 = locked to screen, 1 = scrolls 1:1">px</span>
        <input
          type="number" step={0.05} value={layer.parallaxX}
          onChange={(e) => onParallax(Number(e.target.value), layer.parallaxY)}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 44, fontSize: 10, padding: "1px 3px" }}
        />
        <input
          type="number" step={0.05} value={layer.parallaxY}
          onChange={(e) => onParallax(layer.parallaxX, Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 44, fontSize: 10, padding: "1px 3px" }}
        />
        <span style={{ marginLeft: "auto" }} title="Layer opacity (0..1)">α</span>
        <input
          type="range" min={0} max={1} step={0.05} value={layer.opacity}
          onChange={(e) => onOpacity(Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 60 }}
        />
        <span style={{ width: 24, textAlign: "right" }}>{Math.round(layer.opacity * 100)}%</span>
      </div>

      {/* Global toggle — content on a global layer renders in EVERY scene
          (authored once in the source scene; matched across scenes by name). */}
      <label
        onClick={(e) => e.stopPropagation()}
        title="Global: this layer's widgets/objects show in every scene. Author them once here; a same-named layer in another scene shows the same content."
        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: layer.global ? "var(--yellow)" : "var(--text-2)", cursor: "pointer", userSelect: "none" }}
      >
        <Toggle
          value={!!layer.global}
          onChange={onToggleGlobal}
          style={{ margin: 0 }}
        />
        Global (show in all scenes)
      </label>

      {/* Y-sort toggle — topdown depth sorting. Sprites on this layer set
          their depth from world Y each frame; tilemaps split row-by-row so
          tiles interleave with sprites. Standard "player walks behind tree". */}
      <label
        onClick={(e) => e.stopPropagation()}
        title="Y-sort: sprites + tilemap rows on this layer sort by world Y each frame. Lower on screen → drawn on top. Standard topdown depth sorting."
        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: layer.ySort ? "var(--accent)" : "var(--text-2)", cursor: "pointer", userSelect: "none" }}
      >
        <Toggle
          value={!!layer.ySort}
          onChange={onToggleYSort}
          style={{ margin: 0 }}
        />
        Y-sort (topdown depth)
      </label>
    </div>
  );
}
