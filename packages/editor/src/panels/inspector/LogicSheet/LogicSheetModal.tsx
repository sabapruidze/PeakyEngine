import { useState } from "react";
import { useEditor } from "../../../store";
import type { BlueprintDef, LogicFolder, LogicSheet, UIWidgetDef } from "../../../project";
import { LogicGraphCanvas } from "./LogicGraphCanvas";
import { Splitter } from "../../Splitter";

interface EditorProps {
  /** Host whose `logicSheet` is being edited. BlueprintDef OR UIWidgetDef.
   *  Both expose the same shape used here (id, name, logicSheet, behaviors,
   *  variables) — UIWidgetDef's `behaviors` is a compat shim that's always
   *  empty for widgets. */
  bp: BlueprintDef | UIWidgetDef;
  /** When provided, called on every sheet edit instead of `updateBlueprint`.
   *  Used by UIWidgetTab to route changes through `updateUIWidget`. */
  onCommitSheet?: (sheet: LogicSheet) => void;
}

/**
 * The Logic Sheet body — event/folder sidebar + node-graph canvas. Fills its
 * parent (the parent sets the size), so it works both inline in the Blueprint
 * editor (above the State Machine) and inside the fullscreen modal below.
 */
export function LogicSheetEditor({ bp, onCommitSheet }: EditorProps) {
  const updateBlueprint = useEditor((s) => s.updateBlueprint);
  const sheet: LogicSheet = bp.logicSheet ?? { folders: [] };
  // Persist the folder selection in the store so navigating away and back
  // (or switching between BPs in the inspector) reopens the same folder.
  // bp.id (or "__main__:<sceneId>" for the Main Sheet facade) is the
  // owner key. Falls back to the first folder when there's no saved
  // selection (or the saved id has been deleted).
  const savedFolderId = useEditor((s) => s.openLogicFolderByOwner[bp.id] ?? null);
  const setOpenLogicFolderForOwner = useEditor((s) => s.setOpenLogicFolderForOwner);
  const effectiveSelectedId = (savedFolderId && sheet.folders.some((f) => f.id === savedFolderId))
    ? savedFolderId
    : (sheet.folders[0]?.id ?? null);
  const setSelectedId = (id: string | null) => setOpenLogicFolderForOwner(bp.id, id);
  const selectedId = effectiveSelectedId;
  // Draggable folders/canvas divider — persisted, clamped to a sane range.
  const [sidebarWidth, setSidebarWidthState] = useState<number>(() => {
    try { const n = Number(localStorage.getItem("peaky.logic-sidebar-w")); return n >= 120 && n <= 460 ? n : 220; }
    catch { return 220; }
  });
  const setSidebarWidth = (updater: (w: number) => number) => {
    setSidebarWidthState((w) => {
      const next = Math.max(120, Math.min(460, updater(w)));
      try { localStorage.setItem("peaky.logic-sidebar-w", String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  function commit(next: LogicSheet) {
    if (onCommitSheet) onCommitSheet(next);
    else updateBlueprint(bp.id, { logicSheet: next });
  }

  function addFolder(name: string, seedGraph?: LogicFolder["graph"]) {
    const id = `fld-${Math.random().toString(36).slice(2, 10)}`;
    const folder: LogicFolder = { id, name, graph: seedGraph ?? { nodes: [], edges: [] } };
    commit({ folders: [...sheet.folders, folder] });
    setSelectedId(id);
  }

  function addBlankFolder() {
    const name = window.prompt("Group name", `Group ${sheet.folders.length + 1}`);
    if (!name) return;
    addFolder(name);
  }

  function removeFolder(fid: string) {
    if (!window.confirm("Delete this group and all its nodes?")) return;
    commit({ folders: sheet.folders.filter((f) => f.id !== fid) });
    if (selectedId === fid) setSelectedId(null);
  }

  function renameFolder(fid: string) {
    const folder = sheet.folders.find((f) => f.id === fid);
    if (!folder) return;
    const name = window.prompt("Rename group", folder.name);
    if (!name) return;
    commit({ folders: sheet.folders.map((f) => (f.id === fid ? { ...f, name } : f)) });
  }

  const selected = sheet.folders.find((f) => f.id === selectedId) ?? null;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, height: "100%" }}>
      <aside style={{
        width: sidebarWidth, flexShrink: 0,
        display: "flex", flexDirection: "column", minHeight: 0,
      }}>
        <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            onClick={addBlankFolder}
            style={{
              width: "100%", padding: "8px 12px",
              background: "var(--accent)", border: "none",
              borderRadius: 4, color: "var(--frame)",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
            }}
          >+ New Group</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 10px" }}>
          {sheet.folders.length === 0 && (
            <div style={{
              fontSize: 11, color: "var(--text-dim)",
              padding: "20px 10px", textAlign: "center", lineHeight: 1.5,
            }}>
              No groups yet. Click <b>+ New Group</b> for an empty canvas.
            </div>
          )}
          {sheet.folders.map((folder) => {
            const triggerCount = folder.graph.nodes.filter((n) => n.kind === "trigger").length;
            return (
              <div
                key={folder.id}
                onClick={() => setSelectedId(folder.id)}
                style={{
                  padding: "8px 10px", marginBottom: 4,
                  background: folder.id === selectedId ? "rgba(120,180,255,0.15)" : "transparent",
                  border: folder.id === selectedId
                    ? "1px solid rgba(120,180,255,0.5)"
                    : "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 4, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {folder.name}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}>
                    {triggerCount} trigger{triggerCount === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); renameFolder(folder.id); }}
                  title="Rename group"
                  style={{
                    width: 18, height: 18, padding: 0, lineHeight: "16px",
                    background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", fontSize: 9,
                  }}
                >✎</button>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFolder(folder.id); }}
                  title="Delete group"
                  style={{
                    width: 18, height: 18, padding: 0, lineHeight: "16px",
                    background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", fontSize: 10,
                  }}
                >×</button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Draggable divider — resize the groups sidebar vs the canvas. */}
      <Splitter onDrag={(dx) => setSidebarWidth((w) => w + dx)} />

      <main style={{
        flex: 1, background: "rgba(0,0,0,0.25)",
        display: "flex", alignItems: "stretch", justifyContent: "stretch",
        color: "var(--text-dim)", fontSize: 12, minHeight: 0,
      }}>
        {selected ? (
          <LogicGraphCanvas
            key={selected.id}
            folder={selected}
            bp={bp as BlueprintDef}
            onChange={(next) => commit({
              folders: sheet.folders.map((f) => (f.id === selected.id ? next : f)),
            })}
          />
        ) : (
          <div style={{ margin: "auto", textAlign: "center", maxWidth: 360, lineHeight: 1.6, padding: 20 }}>
            Pick a group from the list, or click <b>+ New Group</b> to add one.
          </div>
        )}
      </main>
    </div>
  );
}

interface LogicSheetModalProps extends EditorProps {
  onClose: () => void;
}

/**
 * Fullscreen editor wrapper around LogicSheetEditor. Used by MainSheetView,
 * whose sheets have no inline surface (they're opened from a list). Always
 * fills the viewport — there is no windowed mode.
 */
export function LogicSheetModal({ bp, onClose, onCommitSheet }: LogicSheetModalProps) {
  // Default to a bottom-docked panel (~55% of viewport height). User
  // explicitly toggles to full-viewport via the Fullscreen button. The
  // preference persists in localStorage so subsequent opens remember the
  // last chosen layout. (Was: always full-viewport on open, which buried
  // the rest of the editor and felt heavy for quick scripting changes.)
  const [fullscreen, setFullscreenState] = useState<boolean>(() => {
    try { return localStorage.getItem("peaky.logic-modal-fullscreen") === "1"; }
    catch { return false; }
  });
  const setFullscreen = (v: boolean) => {
    setFullscreenState(v);
    try { localStorage.setItem("peaky.logic-modal-fullscreen", v ? "1" : "0"); } catch { /* private mode */ }
  };
  return (
    <div
      style={{
        position: "fixed",
        // Middle-docked: slots into the empty area between the Main Sheet
        // list (top) and the Content browser (bottom-anchored dock,
        // ~140 px tall). Default height: ~40% of viewport, vertically
        // centered in the available area. Fullscreen covers everything.
        left: 0, right: 0,
        ...(fullscreen
          ? { top: 0, bottom: 0 }
          : { top: "38vh", bottom: 150 }),
        zIndex: 1000,
        background: "var(--frame)",
        borderTop: fullscreen ? "none" : "2px solid rgba(255,255,255,0.15)",
        borderBottom: fullscreen ? "none" : "2px solid rgba(255,255,255,0.15)",
        boxShadow: fullscreen ? "none" : "0 4px 24px rgba(0,0,0,0.4)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}
    >
      <div style={{
        padding: "10px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <strong style={{ fontSize: 13 }}>Logic Sheet — {bp.name}</strong>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setFullscreen(!fullscreen)}
          title={fullscreen ? "Exit fullscreen (back to bottom panel)" : "Open as fullscreen"}
          style={{
            padding: "4px 12px", fontSize: 11, background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4,
            color: "var(--text-dim)", cursor: "pointer",
          }}
        >{fullscreen ? "❐ Exit fullscreen" : "⛶ Fullscreen"}</button>
        <button
          onClick={onClose}
          style={{
            padding: "4px 12px", fontSize: 11, background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4,
            color: "var(--text-dim)", cursor: "pointer",
          }}
        >Close</button>
      </div>
      <LogicSheetEditor bp={bp} onCommitSheet={onCommitSheet} />
    </div>
  );
}
