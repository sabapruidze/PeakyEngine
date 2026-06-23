import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { Splitter } from "./Splitter";
import { BlueprintPreview } from "./BlueprintPreview";
import { BlueprintComponents } from "./BlueprintComponents";
import {
  BlueprintIdentitySection,
  BlueprintComponentDetail,
  BlueprintDeleteFooter,
  BlueprintLODSection,
  VariablesSection,
} from "./inspector/BlueprintInspector";
import { AnimStateTable } from "./inspector/CharacterOverview";
import { LogicSheetEditor } from "./inspector/LogicSheet/LogicSheetModal";

const STORAGE_KEY = "peaky.bp-layout";
const BP_STATE_KEY = (bpId: string) => `peaky.bp-state.${bpId}`;
const COL1_MIN = 180;
const COL1_MAX = 420;
const COL2_MIN = 240;
const COL2_MAX = 520;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface BpUiState {
  selectedComponentIdx: number | null;
  col1Scroll: number;
  col2Scroll: number;
  col3Scroll: number;
}

const DEFAULT_BP_STATE: BpUiState = {
  selectedComponentIdx: null,
  col1Scroll: 0,
  col2Scroll: 0,
  col3Scroll: 0,
};

function loadBpState(bpId: string): BpUiState {
  try {
    const raw = localStorage.getItem(BP_STATE_KEY(bpId));
    if (!raw) return DEFAULT_BP_STATE;
    const parsed = JSON.parse(raw);
    return {
      selectedComponentIdx: typeof parsed.selectedComponentIdx === "number" ? parsed.selectedComponentIdx : null,
      col1Scroll: typeof parsed.col1Scroll === "number" ? parsed.col1Scroll : 0,
      col2Scroll: typeof parsed.col2Scroll === "number" ? parsed.col2Scroll : 0,
      col3Scroll: typeof parsed.col3Scroll === "number" ? parsed.col3Scroll : 0,
    };
  } catch { return DEFAULT_BP_STATE; }
}

function saveBpState(bpId: string, patch: Partial<BpUiState>): void {
  try {
    const current = loadBpState(bpId);
    localStorage.setItem(BP_STATE_KEY(bpId), JSON.stringify({ ...current, ...patch }));
  } catch { /* quota / private mode — silent */ }
}

interface LayoutState {
  col1: number;
  col2: number;
}

const DEFAULT_LAYOUT: LayoutState = { col1: 220, col2: 320 };

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw);
    return {
      col1: clamp(parsed.col1 ?? parsed.left ?? DEFAULT_LAYOUT.col1, COL1_MIN, COL1_MAX),
      col2: clamp(parsed.col2 ?? DEFAULT_LAYOUT.col2, COL2_MIN, COL2_MAX),
    };
  } catch { return DEFAULT_LAYOUT; }
}

/**
 * Per-Blueprint workspace, three-column shell:
 *   ┌──────────┬──────────────┬──────────────────────────────────┐
 *   │ Preview  │ Identity     │                                  │
 *   │ Comps    │ Components   │   EVENTS                         │
 *   │ Vars     │ (Physics,    │                                  │
 *   │ Comms    │  Movement,   │                                  │
 *   │ + New BP │  …)          │                                  │
 *   │          │ Delete BP    │                                  │
 *   └──────────┴──────────────┴──────────────────────────────────┘
 *      col 1        col 2                  col 3
 */
export function BlueprintTab({ bpId }: { bpId: string }) {
  const bp = useEditor((s) => s.project.blueprints.find((b) => b.id === bpId));
  const sprites = useEditor((s) => s.project.sprites);
  const selectBlueprint = useEditor((s) => s.selectBlueprint);
  const selectedBlueprintId = useEditor((s) => s.selectedBlueprintId);

  const [layout, setLayout] = useState(loadLayout);
  // Selected component index — persisted per BP so jumping to another BP
  // and back lands on the same component the user was inspecting.
  const [selectedComponentIdx, setSelectedComponentIdxState] = useState<number | null>(
    () => loadBpState(bpId).selectedComponentIdx,
  );
  const setSelectedComponentIdx = (idx: number | null) => {
    setSelectedComponentIdxState(idx);
    saveBpState(bpId, { selectedComponentIdx: idx });
  };
  // Logic Sheet is shown INLINE above the State Machine (expandable). The
  // "⛶ Fullscreen" toggle blows the SAME editor up to a viewport overlay —
  // it's the same React element (and same node-graph canvas state), just
  // repositioned, so copy/paste and selection survive the toggle. Expand
  // state persists so reopening a BP keeps the sheet where you left it.
  const [logicFullscreen, setLogicFullscreen] = useState(false);
  const [logicExpanded, setLogicExpandedState] = useState<boolean>(() => {
    try { return localStorage.getItem("peaky.logic-expanded") !== "0"; } catch { return true; }
  });
  const setLogicExpanded = (v: boolean) => {
    setLogicExpandedState(v);
    try { localStorage.setItem("peaky.logic-expanded", v ? "1" : "0"); } catch { /* private mode */ }
  };
  // State Machine section — collapse/expand toggle, mirrors the Logic Sheet
  // section above. Default expanded so authors notice it on first open.
  const [stateMachineExpanded, setStateMachineExpandedState] = useState<boolean>(() => {
    try { return localStorage.getItem("peaky.state-machine-expanded") !== "0"; } catch { return true; }
  });
  const setStateMachineExpanded = (v: boolean) => {
    setStateMachineExpandedState(v);
    try { localStorage.setItem("peaky.state-machine-expanded", v ? "1" : "0"); } catch { /* private mode */ }
  };

  // Scroll-position restore — refs to the 3 scrolling columns. On bpId
  // change we re-read the saved scroll positions and apply them after
  // React commits the new content. Without the rAF, the scroll restore
  // would happen before the new BP's DOM is laid out and clamp to 0.
  const col1Ref = useRef<HTMLDivElement>(null);
  const col2Ref = useRef<HTMLDivElement>(null);
  const col3Ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedBlueprintId !== bpId) selectBlueprint(bpId);
  }, [bpId, selectedBlueprintId, selectBlueprint]);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); }, [layout]);

  // On bpId change: reload selection + restore scroll positions for the
  // newly-active BP. The state in `selectedComponentIdx` is per-BP via
  // the setter, but useState's initializer only runs once per mount —
  // since BlueprintTab IS unmounted on tab switch, this effect is the
  // safety net for the case where bpId changes WITHOUT remount (e.g.
  // some future router-style nav).
  useEffect(() => {
    const s = loadBpState(bpId);
    setSelectedComponentIdxState(s.selectedComponentIdx);
    // Defer scroll restore one frame so the new BP's content has laid out.
    requestAnimationFrame(() => {
      if (col1Ref.current) col1Ref.current.scrollTop = s.col1Scroll;
      if (col2Ref.current) col2Ref.current.scrollTop = s.col2Scroll;
      if (col3Ref.current) col3Ref.current.scrollTop = s.col3Scroll;
    });
  }, [bpId]);

  if (!bp) {
    return <div className="card" style={{ padding: 24, color: "var(--text-dim)" }}>Blueprint not found.</div>;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${layout.col1}px 12px ${layout.col2}px 12px minmax(0, 1fr)`,
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* COL 1 — Preview, Components, Variables, Communication */}
      <div
        ref={col1Ref}
        onScroll={(e) => saveBpState(bpId, { col1Scroll: (e.currentTarget as HTMLDivElement).scrollTop })}
        className="card-flush"
        style={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto", gap: 10, padding: 10 }}
      >
        <RailPanel>
          <BlueprintPreview bp={bp} sprites={sprites} selectedIdx={selectedComponentIdx} />
        </RailPanel>
        <RailPanel>
          <BlueprintComponents
            bp={bp}
            selectedIdx={selectedComponentIdx}
            onSelect={setSelectedComponentIdx}
          />
        </RailPanel>
        <RailPanel>
          <VariablesSection bp={bp} />
        </RailPanel>
        <RailPanel>
          <BlueprintLODSection bp={bp} />
        </RailPanel>
        <div style={{ flex: 1 }} />
      </div>

      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, col1: clamp(l.col1 + dx, COL1_MIN, COL1_MAX) }))} />

      {/* COL 2 — Identity, active component card, delete footer */}
      <div
        ref={col2Ref}
        onScroll={(e) => saveBpState(bpId, { col2Scroll: (e.currentTarget as HTMLDivElement).scrollTop })}
        className="card-flush"
        style={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto", gap: 10, padding: 10 }}
      >
        <RailPanel>
          <BlueprintIdentitySection bp={bp} />
        </RailPanel>
        <RailPanel>
          <BlueprintComponentDetail bp={bp} selectedIdx={selectedComponentIdx} />
        </RailPanel>
        <div style={{ flex: 1 }} />
        <BlueprintDeleteFooter bp={bp} />
      </div>

      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, col2: clamp(l.col2 + dx, COL2_MIN, COL2_MAX) }))} />

      {/* COL 3 — Logic Sheet button, Animation Slots, FX Slots */}
      <div
        ref={col3Ref}
        onScroll={(e) => saveBpState(bpId, { col3Scroll: (e.currentTarget as HTMLDivElement).scrollTop })}
        className="card-flush"
        style={{ minHeight: 0, minWidth: 0, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 10 }}
      >
        {/* Logic Sheet — inline node graph, expandable, sits ABOVE the State
            Machine so you see logic + states together. "⛶ Fullscreen" pins
            this same section to the viewport (position:fixed) — the editor
            element never unmounts, so its canvas state (selection, copy/paste,
            pasted nodes) is identical inline and fullscreen. */}
        <div
          className="section"
          style={logicFullscreen
            ? { position: "fixed", inset: 0, zIndex: 1000, margin: 0, borderRadius: 0,
                background: "var(--frame)", padding: 0, display: "flex", flexDirection: "column" }
            : { padding: 0, display: "flex", flexDirection: "column" }}
        >
          <div style={{ padding: 10, display: "flex", alignItems: "center", gap: 8 }}>
            {!logicFullscreen && (
              <button
                onClick={() => setLogicExpanded(!logicExpanded)}
                title={logicExpanded ? "Collapse Logic Sheet" : "Expand Logic Sheet"}
                style={{
                  width: 18, height: 18, padding: 0, lineHeight: "16px", flexShrink: 0,
                  background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 3, color: "var(--text)", cursor: "pointer", fontSize: 9,
                }}
              >{logicExpanded ? "▾" : "▸"}</button>
            )}
            <div className="title" style={{ fontSize: 12, flex: 1 }}>
              🧩 Logic Sheet{" "}
              <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400 }}>
                ({bp.logicSheet?.folders.length ?? 0} group{(bp.logicSheet?.folders.length ?? 0) === 1 ? "" : "s"})
              </span>
            </div>
            <button
              onClick={() => { setLogicFullscreen((v) => !v); setLogicExpanded(true); }}
              title={logicFullscreen ? "Exit fullscreen" : "Edit fullscreen"}
              style={{
                padding: "3px 8px", fontSize: 11, background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4,
                color: "var(--text-dim)", cursor: "pointer",
              }}
            >{logicFullscreen ? "❐ Exit fullscreen" : "⛶ Fullscreen"}</button>
          </div>
          {(logicExpanded || logicFullscreen) && (
            <div style={{
              ...(logicFullscreen ? { flex: 1 } : { height: 520 }),
              display: "flex", minHeight: 0,
              borderTop: "1px solid rgba(255,255,255,0.08)",
            }}>
              <LogicSheetEditor bp={bp} />
            </div>
          )}
        </div>
        {/* Animation Slots — the animator state table. Collapse/expand
            toggle so authors can hide the (sometimes-large) table when
            focusing on Logic Sheet / FX work. Persists in localStorage. */}
        <div className="section" style={{ padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => setStateMachineExpanded(!stateMachineExpanded)}
              title={stateMachineExpanded ? "Collapse State Machine" : "Expand State Machine"}
              style={{
                padding: "0 6px", fontSize: 11, background: "transparent",
                border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4,
                color: "var(--text-dim)", cursor: "pointer",
              }}
            >{stateMachineExpanded ? "▾" : "▸"}</button>
            <div className="title" style={{ fontSize: 12, flex: 1 }}>State Machine</div>
          </div>
          {stateMachineExpanded && <AnimStateTable bp={bp} />}
        </div>
        {/* FX Slots placeholder — wire actual content later. */}
        <div className="section" style={{ padding: 10 }}>
          <div className="title" style={{ fontSize: 12, marginBottom: 6 }}>FX Slots</div>
          <div style={{
            padding: 12, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5,
            background: "var(--inner)", borderRadius: 6,
            border: "1px dashed rgba(255,255,255,0.08)",
          }}>
            (placeholder — per-state FX / SFX wiring lands here)
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * Rounded blue-tinted panel that frames each section in the left rail and
 * middle column. Visual chrome only — no behavior. Matches the user's mockup
 * (soft-blue translucent fill, subtle stroke, rounded corners).
 */
function RailPanel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "rgba(85, 100, 150, 0.18)",
      border: "1px solid rgba(140, 160, 220, 0.25)",
      borderRadius: 8,
      padding: "4px 0",
      boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
    }}>
      {children}
    </div>
  );
}
