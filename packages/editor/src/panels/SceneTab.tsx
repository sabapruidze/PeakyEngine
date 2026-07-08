import { useEffect, useState } from "react";
import { LayersPanel } from "./LayersPanel";
import { OutlinerPanel } from "./OutlinerPanel";
import { ScenePanel } from "./ScenePanel";
import { InstanceInspector } from "./inspector/InstanceInspector";
import { MainSheetView } from "./MainSheetView";
import { Splitter } from "./Splitter";
import { useEditor } from "../store";

const STORAGE_KEY = "peaky.scene-layout";
const MIN_W = 180;
const MAX_W = 480;
const clamp = (n: number) => Math.max(MIN_W, Math.min(MAX_W, n));

interface LayoutState { left: number; right: number; }

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { left: 220, right: 260 };
    const parsed = JSON.parse(raw);
    return { left: clamp(parsed.left ?? 220), right: clamp(parsed.right ?? 260) };
  } catch { return { left: 220, right: 260 }; }
}

/** 3-card scene workspace. The Scene vs Main Sheet toggle now lives in the
 *  top tab bar (store `sceneSubTab`); this just renders whichever the user
 *  picked. */
export function SceneTab() {
  const [layout, setLayout] = useState<LayoutState>(loadLayout);
  const subTab = useEditor((s) => s.sceneSubTab);
  const setSceneSubTab = useEditor((s) => s.setSceneSubTab);
  const isRunning = useEditor((s) => s.isRunning);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); }, [layout]);

  // When the user hits Play from anywhere — including the Main Sheet sub-view —
  // flip the workspace to the visual Scene viewport. Otherwise the sim runs
  // invisibly behind the Main Sheet editor.
  useEffect(() => {
    if (isRunning && subTab !== "scene") setSceneSubTab("scene");
  }, [isRunning]);

  return (
    <div style={{ minHeight: 0, minWidth: 0, width: "100%", height: "100%" }}>
      {subTab === "scene"
        ? <SceneWorkspace layout={layout} setLayout={setLayout} />
        : <MainSheetView />}
    </div>
  );
}

function SceneWorkspace({
  layout, setLayout,
}: { layout: LayoutState; setLayout: (fn: (l: LayoutState) => LayoutState) => void }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${layout.left}px 12px 1fr 12px ${layout.right}px`,
        height: "100%",
        minHeight: 0,
      }}
    >
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <SectionHeader title="Hierarchy" />
        <div style={{ flex: 1, overflow: "auto", paddingBottom: 6, minHeight: 0 }}>
          <OutlinerPanel />
        </div>
        {/* Layers live under the Hierarchy in the LEFT rail (own capped scroll
            region), leaving the whole right rail to the Inspector. */}
        <div style={{ flex: "0 0 auto", maxHeight: "45%", overflow: "auto", borderTop: "1px solid var(--border)" }}>
          <LayersPanel />
        </div>
      </div>
      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, left: clamp(l.left + dx) }))} />
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0, padding: 12 }}>
        <ScenePanel />
      </div>
      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, right: clamp(l.right - dx) }))} />
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <SectionHeader title="Inspector" />
        <div style={{ flex: 1, overflow: "auto" }}>
          <InstanceInspector />
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span className="label-uppercase">{title}</span>
    </div>
  );
}
