import type { MouseEvent as ReactMouseEvent } from "react";
import { useEditor } from "../store";

export function OutlinerPanel() {
  const scene = useEditor((s) => s.activeScene());
  const blueprintFor = useEditor((s) => s.blueprintFor);
  const tilemaps = useEditor((s) => s.project.tilemaps ?? []);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const selectedId = useEditor((s) => s.selectedInstanceId);
  const multiSelected = useEditor((s) => s.multiSelected);
  const select = useEditor((s) => s.selectInstance);
  const toggleMultiSelected = useEditor((s) => s.toggleMultiSelected);
  const setInstanceLocked = useEditor((s) => s.setInstanceLocked);

  const handleRowClick = (id: string, e: ReactMouseEvent) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) toggleMultiSelected(id);
    else select(id);
  };
  const isSelected = (id: string) => id === selectedId || multiSelected.has(id);

  const instances = scene.instances;
  const tilemapInsts = scene.tilemapInstances ?? [];
  const uiInsts = scene.uiInstances ?? [];
  const placements = scene.spritePlacements ?? [];
  const sprites = useEditor((s) => s.project.sprites);
  const totalCount = instances.length + tilemapInsts.length + uiInsts.length + placements.length;

  return (
    <div className="panel">
      <h2>Outliner</h2>

      <div>
        {totalCount === 0 && (
          <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
            No instances yet. Drag a blueprint or tilemap from the Content Browser into the scene.
          </div>
        )}
        {/* Group by layer in the order they appear in the LayersPanel
            (top-of-list first). Empty layers still show their header so
            users can see them — and so the layer's parallax/visibility
            chip is visible even before instances land on it. */}
        {scene.layers.map((layer) => {
          const layerInstances = instances.filter(
            (i) => (i.layerId ?? scene.activeLayerId) === layer.id,
          );
          const layerTilemaps = tilemapInsts.filter(
            (ti) => (ti.layerId ?? scene.activeLayerId) === layer.id,
          );
          const layerUIInsts = uiInsts.filter(
            (ui) => (ui.layerId ?? scene.activeLayerId) === layer.id,
          );
          const layerPlacements = placements.filter(
            (p) => (p.layerId ?? scene.activeLayerId) === layer.id,
          );
          const layerTotal = layerInstances.length + layerTilemaps.length + layerUIInsts.length + layerPlacements.length;
          return (
            <div key={layer.id}>
              <div
                style={{
                  padding: "6px 12px 4px",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: layer.visible ? "var(--text-2)" : "var(--text-faint)",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <span>{layer.visible ? "▾" : "▸"}</span>
                <span>{layer.name}</span>
                <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 9 }}>
                  {layerTotal} · ({layer.parallaxX},{layer.parallaxY})
                </span>
              </div>
              {layerInstances.map((inst) => {
                const bp = blueprintFor(inst);
                const color = bp ? `#${bp.color.toString(16).padStart(6, "0")}` : "#666";
                const label = inst.name ?? bp?.name ?? "(missing)";
                return (
                  <div
                    key={inst.id}
                    className={`object-row ${isSelected(inst.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(inst.id, e)}
                    style={{ paddingLeft: 18, opacity: layer.visible ? 1 : 0.5 }}
                  >
                    <div className="swatch" style={{ background: color }} />
                    <div className="name">{label}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{bp?.name}</span>
                    <LockBtn locked={!!inst.locked} layerLocked={!!layer.locked} onToggle={() => setInstanceLocked(inst.id, !inst.locked)} />
                  </div>
                );
              })}
              {layerTilemaps.map((ti) => {
                const map = tilemaps.find((m) => m.id === ti.tilemapId);
                const label = map?.name ?? "(missing tilemap)";
                return (
                  <div
                    key={ti.id}
                    className={`object-row ${isSelected(ti.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(ti.id, e)}
                    style={{ paddingLeft: 18, opacity: layer.visible ? 1 : 0.5 }}
                    title="Tilemap instance (Shift/Ctrl+click to multi-select)"
                  >
                    <div className="swatch" style={{ background: "#7eb37e" }} />
                    <div className="name">{label}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>tilemap</span>
                    <LockBtn locked={!!ti.locked} layerLocked={!!layer.locked} onToggle={() => setInstanceLocked(ti.id, !ti.locked)} />
                  </div>
                );
              })}
              {layerUIInsts.map((ui) => {
                const w = uiWidgets.find((u) => u.id === ui.uiWidgetId);
                const label = ui.name ?? w?.name ?? "(missing widget)";
                return (
                  <div
                    key={ui.id}
                    className={`object-row ${isSelected(ui.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(ui.id, e)}
                    style={{ paddingLeft: 18, opacity: layer.visible ? 1 : 0.5 }}
                    title="UI widget instance (Shift/Ctrl+click to multi-select)"
                  >
                    <div className="swatch" style={{ background: "#e0a87a" }} />
                    <div className="name">{label}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{w?.kind ?? "widget"}</span>
                    <LockBtn locked={!!ui.locked} layerLocked={!!layer.locked} onToggle={() => setInstanceLocked(ui.id, !ui.locked)} />
                  </div>
                );
              })}
              {layerPlacements.map((p) => {
                const sp = sprites.find((s) => s.id === p.spriteId);
                const label = p.name || sp?.name || "(missing sprite)";
                return (
                  <div
                    key={p.id}
                    className={`object-row ${isSelected(p.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(p.id, e)}
                    style={{ paddingLeft: 18, opacity: layer.visible ? 1 : 0.5 }}
                    title="Sprite placement (Shift/Ctrl+click to multi-select)"
                  >
                    <div className="swatch" style={{ background: "#9a7ec4" }} />
                    <div className="name">{label}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>sprite</span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {/* Orphaned instances — entries whose layerId points to a layer
         *  that no longer exists in this scene. Without this section
         *  they'd be invisible in the Outliner but still spawn at runtime,
         *  matching exactly the "ghost sprite I can't find" symptom. */}
        {(() => {
          const validLayerIds = new Set(scene.layers.map((l) => l.id));
          const orphanInstances = instances.filter((i) => !validLayerIds.has(i.layerId ?? scene.activeLayerId));
          const orphanTilemaps = tilemapInsts.filter((ti) => !validLayerIds.has(ti.layerId ?? scene.activeLayerId));
          const orphanUI = uiInsts.filter((ui) => !validLayerIds.has(ui.layerId ?? scene.activeLayerId));
          const orphanPlacements = placements.filter((p) => !validLayerIds.has(p.layerId ?? scene.activeLayerId));
          const orphanTotal = orphanInstances.length + orphanTilemaps.length + orphanUI.length + orphanPlacements.length;
          if (orphanTotal === 0) return null;
          return (
            <div>
              <div style={{
                padding: "6px 12px 4px", fontSize: 10,
                textTransform: "uppercase", letterSpacing: 0.5,
                color: "var(--danger, #d65a5a)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <span>⚠</span>
                <span>Orphaned — layer deleted</span>
                <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 9 }}>{orphanTotal}</span>
              </div>
              {orphanInstances.map((inst) => {
                const bp = blueprintFor(inst);
                return (
                  <div key={inst.id} className={`object-row ${isSelected(inst.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(inst.id, e)}
                    style={{ paddingLeft: 18 }}>
                    <div className="swatch" style={{ background: bp ? `#${bp.color.toString(16).padStart(6, "0")}` : "#666" }} />
                    <div className="name">{inst.name ?? bp?.name ?? "(missing)"}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>bp · orphan</span>
                  </div>
                );
              })}
              {orphanTilemaps.map((ti) => (
                <div key={ti.id} className={`object-row ${isSelected(ti.id) ? "selected" : ""}`}
                  onClick={(e) => handleRowClick(ti.id, e)} style={{ paddingLeft: 18 }}>
                  <div className="swatch" style={{ background: "#7eb37e" }} />
                  <div className="name">{tilemaps.find((m) => m.id === ti.tilemapId)?.name ?? "(missing tilemap)"}</div>
                  <span style={{ color: "var(--text-dim)", fontSize: 10 }}>tilemap · orphan</span>
                </div>
              ))}
              {orphanUI.map((ui) => {
                const w = uiWidgets.find((u) => u.id === ui.uiWidgetId);
                return (
                  <div key={ui.id} className={`object-row ${isSelected(ui.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(ui.id, e)} style={{ paddingLeft: 18 }}>
                    <div className="swatch" style={{ background: "#e0a87a" }} />
                    <div className="name">{ui.name ?? w?.name ?? "(missing widget)"}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{w?.kind ?? "widget"} · orphan</span>
                  </div>
                );
              })}
              {orphanPlacements.map((p) => {
                const sp = sprites.find((s) => s.id === p.spriteId);
                return (
                  <div key={p.id} className={`object-row ${isSelected(p.id) ? "selected" : ""}`}
                    onClick={(e) => handleRowClick(p.id, e)} style={{ paddingLeft: 18 }}
                    title={`Layer id "${p.layerId}" no longer exists. Click to select, then Delete.`}>
                    <div className="swatch" style={{ background: "#9a7ec4" }} />
                    <div className="name">{p.name || sp?.name || "(missing sprite)"}</div>
                    <span style={{ color: "var(--text-dim)", fontSize: 10 }}>sprite · orphan</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function LockBtn({ locked, layerLocked, onToggle }: { locked: boolean; layerLocked: boolean; onToggle: () => void }) {
  const effective = locked || layerLocked;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={
        layerLocked && !locked
          ? "Layer is locked — unlock the layer in the Layers panel to edit this instance"
          : locked
          ? "Unlock this instance (allow selection / drag)"
          : "Lock this instance (block selection / drag)"
      }
      disabled={layerLocked && !locked}
      style={{
        background: "transparent", border: "none", padding: 0,
        color: "var(--text-muted)",
        cursor: layerLocked && !locked ? "default" : "pointer",
        opacity: effective ? 1 : 0.35, marginLeft: 4,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 16, height: 16,
      }}
    >
      <LockIcon locked={effective} />
    </button>
  );
}

/** Single-color padlock glyph. `locked` swaps the shackle between closed
 *  (full loop) and open (gap on the right). Stroke uses `currentColor` so
 *  the parent button controls tint without us touching color here. */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="8" height="5" rx="0.8" />
      {locked ? (
        <path d="M3.6 6V4.3a2.4 2.4 0 0 1 4.8 0V6" />
      ) : (
        <path d="M3.6 6V4.3a2.4 2.4 0 0 1 4.8 0" />
      )}
    </svg>
  );
}
