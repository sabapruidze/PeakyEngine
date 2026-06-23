import { useEffect, useState } from "react";
import { useEditor } from "./store";
import { SceneTab } from "./panels/SceneTab";
import { BlueprintTab } from "./panels/BlueprintTab";
import { SpriteTab } from "./panels/SpriteTab";
import { DialogueTab } from "./panels/DialogueTab";
import { UIWidgetTab } from "./panels/UIWidgetTab";
import { TilesetTab } from "./panels/TilesetTab";
import { TilemapTab } from "./panels/TilemapTab";
import { DialogFlowTab } from "./panels/DialogFlowTab";
import { InputActionsPanel } from "./panels/InputActionsPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { BottomDock } from "./panels/BottomDock";
import { LeftRail } from "./panels/LeftRail";
import { TopBar } from "./panels/TopBar";
import { StatusBar } from "./panels/StatusBar";
import { Splitter } from "./panels/Splitter";
import { SaveStatusBanner } from "./components/SaveStatusBanner";
import { FontsPanel } from "./panels/FontsPanel";
import { registerProjectFonts } from "./fontRegistry";

const CB_HEIGHT_KEY = "peaky.cb-height";
const MIN_CB_H = 140;
const MAX_CB_H = 560;
const DEFAULT_CB_H = 220;

function loadCbHeight(): number {
  try {
    return Math.max(MIN_CB_H, Math.min(MAX_CB_H, Number(localStorage.getItem(CB_HEIGHT_KEY)) || DEFAULT_CB_H));
  } catch { return DEFAULT_CB_H; }
}

/**
 * Phygizon-style shell — outer dark frame with floating rounded cards.
 * Layout:
 *   ┌───┬─── TopBar (project · tabs · play) ───┐
 *   │ R │ ├──────────── active tab ────────────┤
 *   │ a │ │ Scene  /  Blueprint editor         │
 *   │ i │ ├── splitter ────────────────────────┤
 *   │ l │ │ BottomDock (Content / Log)         │
 *   │   │ ├──── StatusBar ─────────────────────┤
 *   └───┴────────────────────────────────────────┘
 */
export function App() {
  const activeTab = useEditor((s) => s.activeTab);
  const dockCollapsed = useEditor((s) => s.dockCollapsed);

  const [inputActionsOpen, setInputActionsOpen] = useState(false);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cbHeight, setCbHeight] = useState(loadCbHeight);
  const fonts = useEditor((s) => s.project.fonts);

  useEffect(() => {
    localStorage.setItem(CB_HEIGHT_KEY, String(cbHeight));
  }, [cbHeight]);

  // Register custom fonts with the browser whenever the set changes, so they're
  // available to both editor previews and the Phaser canvas (same document).
  useEffect(() => {
    registerProjectFonts(fonts);
  }, [fonts]);

  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      // Undo/redo work even when a field is focused (otherwise editing a grid
      // value and pressing Ctrl+Z silently did nothing). Blur first so the
      // browser's native text-undo doesn't swallow the keystroke, then run the
      // app history. The field re-syncs its value from the reverted project.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z") { e.preventDefault(); if (inField) el.blur(); undo(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.shiftKey ? e.key === "z" : e.key === "y")) { e.preventDefault(); if (inField) el.blur(); redo(); return; }
      if (inField) return;
      // Ctrl/Cmd+S → trigger the TopBar's Save flow. We intentionally
      // preventDefault even when no shortcut handler is registered so the
      // browser's "Save Page As" dialog never pops up over the editor.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        // Find the TopBar's Save button by title and click it. Cheap and
        // avoids plumbing an exported handler through context.
        const btn = document.querySelector<HTMLButtonElement>("button[title^='Download the project']");
        btn?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Native-OS file drops outside any handler would otherwise navigate the page
  // (and dump the in-memory project). Swallow them globally; targeted drop
  // zones (Sprite tab, Content Browser) still handle their own drops because
  // they preventDefault first.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "56px 1fr",
        gap: 12,
        padding: 14,
        height: "100vh",
        background: "var(--frame)",
      }}
    >
      <SaveStatusBanner />
      <LeftRail
        onOpenInputActions={() => setInputActionsOpen(true)}
        onOpenFonts={() => setFontsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div
        style={{
          display: "grid",
          gridTemplateRows: dockCollapsed ? "auto 1fr auto" : `auto 1fr ${cbHeight}px auto`,
          gap: 12,
          minHeight: 0,
        }}
      >
        <TopBar />

        <div style={{ minHeight: 0, minWidth: 0 }}>
          {activeTab.kind === "scene" && <SceneTab />}
          {activeTab.kind === "blueprint" && <BlueprintTab bpId={activeTab.id} />}
          {activeTab.kind === "sprite" && <SpriteTab spriteId={activeTab.id} />}
          {activeTab.kind === "dialogue" && <DialogueTab dialogueId={activeTab.id} />}
          {activeTab.kind === "uiwidget" && <UIWidgetTab widgetId={activeTab.id} />}
          {activeTab.kind === "tileset" && <TilesetTab tilesetId={activeTab.id} />}
          {activeTab.kind === "tilemap" && <TilemapTab tilemapId={activeTab.id} />}
          {activeTab.kind === "dialogflow" && <DialogFlowTab />}
        </div>

        {/* Content dock — hidden when collapsed (left-rail folder icon toggles
            it), so a blueprint/scene gets full height. The resize handle floats
            inside the 12px grid gap above (absolute, top:-8) so the scene↔dock
            gap matches every other gap. */}
        {!dockCollapsed && (
          <div style={{ minHeight: 0, minWidth: 0, position: "relative", display: "grid" }}>
            <div style={{ position: "absolute", top: -8, left: 0, right: 0, zIndex: 5 }}>
              <Splitter
                axis="y"
                onDrag={(dy) => setCbHeight((h) => Math.max(MIN_CB_H, Math.min(MAX_CB_H, h - dy)))}
              />
            </div>
            <BottomDock />
          </div>
        )}

        <StatusBar />
      </div>

      {inputActionsOpen && <InputActionsPanel onClose={() => setInputActionsOpen(false)} />}
      {fontsOpen && <FontsPanel onClose={() => setFontsOpen(false)} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
