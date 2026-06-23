import { useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { DialogFlowChapter, DialogFlowTrigger, DialogFlowCondition, DialogFlowTriggerKind, BlueprintDef, DialogueAsset } from "../project";

/**
 * Dialog Flow Tab — timeline view that wires the WHO/WHEN/WHERE of every
 * dialog trigger in the project. Authored as a chapter × NPC grid:
 *
 *   - Columns = chapters (free-form story labels; engine doesn't gate on them)
 *   - Rows    = NPC BPs that have triggers attached
 *   - Cells   = trigger cards (dialog + kind + conditions + priority + one-shot)
 *
 * Click a card → right-side detail panel exposes every field on the trigger.
 * `+ Add Chapter` appends a column; `+ Add Trigger` on any cell creates a
 * blank trigger in that (chapter, NPC) pair.
 *
 * Doesn't author dialog TEXT — that stays in DialogueTab. This tab is purely
 * the wiring layer; runtime evaluation happens in DialogFlowRunner.
 */
export function DialogFlowTab() {
  const project = useEditor((s) => s.project);
  const flow = project.dialogFlow ?? { chapters: [], triggers: [] };
  const addChapter = useEditor((s) => s.addDialogFlowChapter);
  const renameChapter = useEditor((s) => s.renameDialogFlowChapter);
  const removeChapter = useEditor((s) => s.removeDialogFlowChapter);
  const addTrigger = useEditor((s) => s.addDialogFlowTrigger);
  const updateTrigger = useEditor((s) => s.updateDialogFlowTrigger);
  const removeTrigger = useEditor((s) => s.removeDialogFlowTrigger);
  const addCondition = useEditor((s) => s.addDialogFlowCondition);
  const updateCondition = useEditor((s) => s.updateDialogFlowCondition);
  const removeCondition = useEditor((s) => s.removeDialogFlowCondition);
  const addRow = useEditor((s) => s.addDialogFlowRow);
  const removeRow = useEditor((s) => s.removeDialogFlowRow);

  const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(null);
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedTrigger = flow.triggers.find((t) => t.id === selectedTriggerId) ?? null;

  // Build the rows — group triggers by speakerBpId. Always show at least
  // one row for every BP that has triggers; if no triggers exist anywhere,
  // surface every NPC-like BP so the canvas has scaffolding.
  const bpById = new Map(project.blueprints.map((b) => [b.id, b]));
  const triggersByBpId = new Map<string, DialogFlowTrigger[]>();
  for (const t of flow.triggers) {
    const arr = triggersByBpId.get(t.speakerBpId) ?? [];
    arr.push(t);
    triggersByBpId.set(t.speakerBpId, arr);
  }
  // Row list = explicit picks ∪ BPs with triggers (triggers can never become
  // orphaned/invisible — if a trigger exists for a BP, that BP gets a row
  // even if it isn't in the explicit list).
  const explicitRows = flow.rowBpIds ?? [];
  const rowBpIds = Array.from(new Set([
    ...explicitRows,
    ...triggersByBpId.keys(),
  ])).filter((id) => bpById.has(id));
  const unpickedBps = project.blueprints.filter((b) => !rowBpIds.includes(b.id));

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* Main timeline canvas */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "auto" }}>
        <div style={{ padding: "10px 14px 8px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Dialog Flow</span>
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            Declarative trigger table — when player interacts with an NPC in a chapter and conditions match, the chosen dialog plays.
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, position: "relative" }}>
            <button
              onClick={() => setPickerOpen((v) => !v)}
              disabled={unpickedBps.length === 0}
              style={{
                padding: "3px 10px", fontSize: 11,
                background: "var(--inner)", border: "1px solid var(--border)",
                color: unpickedBps.length === 0 ? "var(--text-faint)" : "var(--text)",
                cursor: unpickedBps.length === 0 ? "not-allowed" : "pointer",
              }}
              title={unpickedBps.length === 0 ? "All Blueprints are already rows" : "Add an NPC row to the timeline"}
            >+ Add NPC</button>
            {pickerOpen && unpickedBps.length > 0 && (
              <div
                style={{
                  position: "absolute", top: "100%", right: 0, marginTop: 4,
                  background: "var(--card)", border: "1px solid var(--border)",
                  minWidth: 200, maxHeight: 320, overflowY: "auto",
                  zIndex: 50,
                }}
              >
                {unpickedBps.map((bp) => (
                  <div
                    key={bp.id}
                    onClick={() => { addRow(bp.id); setPickerOpen(false); }}
                    style={{ padding: "6px 10px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--inner)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ width: 10, height: 10, background: `#${(bp.color & 0xffffff).toString(16).padStart(6, "0")}`, flex: "0 0 auto" }} />
                    {bp.name}
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => addChapter()}
              style={{ padding: "3px 10px", fontSize: 11, background: "var(--inner)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer" }}
            >+ Add Chapter</button>
          </div>
        </div>

        {flow.chapters.length === 0 && rowBpIds.length === 0 ? (
          <div style={{ padding: 32, fontSize: 12, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center" }}>
            Empty timeline. Click <b>+ Add NPC</b> to add a row and <b>+ Add Chapter</b> to add a column.
            Chapters are pure organization labels — they don't gate triggers automatically.
            Use the per-trigger Conditions to gate dialog availability.
          </div>
        ) : (
          <TimelineGrid
            chapters={flow.chapters}
            rowBpIds={rowBpIds}
            bpById={bpById}
            triggersByBpId={triggersByBpId}
            selectedTriggerId={selectedTriggerId}
            editingChapterId={editingChapterId}
            onSelectTrigger={setSelectedTriggerId}
            onAddTrigger={(chapterId, bpId) => {
              const newId = addTrigger(chapterId);
              if (bpId) updateTrigger(newId, { speakerBpId: bpId });
              setSelectedTriggerId(newId);
            }}
            onRemoveRow={removeRow}
            onStartRenameChapter={setEditingChapterId}
            onCommitRenameChapter={(id, name) => { renameChapter(id, name); setEditingChapterId(null); }}
            onRemoveChapter={removeChapter}
            dialogues={project.dialogues}
          />
        )}
      </div>

      {/* Right-side detail panel for the selected trigger */}
      {selectedTrigger && (
        <TriggerDetailPanel
          trigger={selectedTrigger}
          chapters={flow.chapters}
          blueprints={project.blueprints}
          dialogues={project.dialogues}
          // Collect every tracer `name` field across all BPs in the
          // project so the OnInteract dropdown lists real values.
          // Deduped (a tracer named "InteractionChecker" on both player
          // and NPC appears once).
          tracerNames={Array.from(new Set(
            project.blueprints.flatMap((b) =>
              b.behaviors
                .filter((bh) => bh.kind === "Tracer")
                .map((bh) => String(bh.config.name ?? ""))
                .filter(Boolean)
            )
          )).sort()}
          inputActionNames={project.inputActions.map((a) => a.name).filter(Boolean)}
          onPatch={(patch) => updateTrigger(selectedTrigger.id, patch)}
          onRemove={() => { removeTrigger(selectedTrigger.id); setSelectedTriggerId(null); }}
          onAddCondition={() => addCondition(selectedTrigger.id)}
          onUpdateCondition={(condId, patch) => updateCondition(selectedTrigger.id, condId, patch)}
          onRemoveCondition={(condId) => removeCondition(selectedTrigger.id, condId)}
        />
      )}
    </div>
  );
}

// ── Timeline grid ──────────────────────────────────────────────────────

function TimelineGrid({
  chapters, rowBpIds, bpById, triggersByBpId,
  selectedTriggerId, editingChapterId,
  onSelectTrigger, onAddTrigger, onRemoveRow,
  onStartRenameChapter, onCommitRenameChapter, onRemoveChapter,
  dialogues,
}: {
  chapters: DialogFlowChapter[];
  rowBpIds: string[];
  bpById: Map<string, BlueprintDef>;
  triggersByBpId: Map<string, DialogFlowTrigger[]>;
  selectedTriggerId: string | null;
  editingChapterId: string | null;
  onSelectTrigger: (id: string) => void;
  onAddTrigger: (chapterId: string, bpId: string) => void;
  onRemoveRow: (bpId: string) => void;
  onStartRenameChapter: (id: string | null) => void;
  onCommitRenameChapter: (id: string, name: string) => void;
  onRemoveChapter: (id: string) => void;
  dialogues: DialogueAsset[];
}) {
  // Sticky NPC label column on the left; chapter columns scroll horizontally.
  // CSS grid with a minmax(220px, …) NPC col + repeat(N, minmax(260px, 1fr)) chapter cols.
  const colTemplate = `220px ${chapters.map(() => "minmax(260px, 1fr)").join(" ")}`;

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: colTemplate, gap: 4, minWidth: 220 + chapters.length * 260 }}>
        {/* Header row: NPC label cell + chapter headers */}
        <div style={{ position: "sticky", left: 0, zIndex: 2, background: "var(--bg)", borderBottom: "2px solid rgba(255,255,255,0.1)", padding: "8px 10px", fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
          NPC ↓ · Chapter →
        </div>
        {chapters.map((ch) => (
          <div key={ch.id} style={{ padding: "8px 10px", borderBottom: "2px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", gap: 6 }}>
            {editingChapterId === ch.id ? (
              <input
                autoFocus
                defaultValue={ch.name}
                onBlur={(e) => onCommitRenameChapter(ch.id, e.target.value.trim() || ch.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRenameChapter(ch.id, (e.target as HTMLInputElement).value.trim() || ch.name);
                  if (e.key === "Escape") onStartRenameChapter(null);
                }}
                style={{ flex: 1, fontSize: 12, padding: "2px 6px" }}
              />
            ) : (
              <span
                onDoubleClick={() => onStartRenameChapter(ch.id)}
                style={{ flex: 1, fontSize: 12, fontWeight: 700, color: "var(--text)", cursor: "text", userSelect: "none" }}
                title="Double-click to rename"
              >{ch.name}</span>
            )}
            <button
              onClick={() => { if (window.confirm(`Delete chapter "${ch.name}" and all its triggers?`)) onRemoveChapter(ch.id); }}
              title="Delete chapter (+ its triggers)"
              style={{ background: "transparent", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 14, padding: "0 4px" }}
            >×</button>
          </div>
        ))}

        {/* Body rows */}
        {rowBpIds.map((bpId) => {
          const bp = bpById.get(bpId);
          const rowTriggers = triggersByBpId.get(bpId) ?? [];
          return (
            <ChapterRow
              key={bpId}
              bpName={bp?.name ?? "(missing BP)"}
              bpColor={bp?.color ?? 0x444444}
              bpId={bpId}
              hasTriggers={rowTriggers.length > 0}
              chapters={chapters}
              triggers={rowTriggers}
              selectedTriggerId={selectedTriggerId}
              onSelectTrigger={onSelectTrigger}
              onAddTrigger={onAddTrigger}
              onRemoveRow={onRemoveRow}
              dialogues={dialogues}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── One row in the timeline (NPC lane) ───────────────────────────────

function ChapterRow({
  bpName, bpColor, bpId, hasTriggers, chapters, triggers, selectedTriggerId,
  onSelectTrigger, onAddTrigger, onRemoveRow, dialogues,
}: {
  bpName: string;
  bpColor: number;
  bpId: string;
  hasTriggers: boolean;
  chapters: DialogFlowChapter[];
  triggers: DialogFlowTrigger[];
  selectedTriggerId: string | null;
  onSelectTrigger: (id: string) => void;
  onAddTrigger: (chapterId: string, bpId: string) => void;
  onRemoveRow: (bpId: string) => void;
  dialogues: DialogueAsset[];
}) {
  return (
    <>
      {/* Sticky left column — NPC label */}
      <div style={{
        position: "sticky", left: 0, zIndex: 1, background: "var(--bg)",
        padding: "8px 10px",
        borderRight: "1px solid var(--border)",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span style={{ width: 10, height: 10, background: `#${(bpColor & 0xffffff).toString(16).padStart(6, "0")}`, flex: "0 0 auto" }} />
        <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{bpName}</span>
        <button
          onClick={() => {
            if (hasTriggers && !window.confirm(`Remove "${bpName}" from the timeline? Its triggers will stay (the row will reappear automatically while triggers exist).`)) return;
            onRemoveRow(bpId);
          }}
          title={hasTriggers ? "Remove from timeline (triggers remain; row stays until triggers are deleted)" : "Remove row from timeline"}
          style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: "0 4px" }}
        >×</button>
      </div>

      {/* Chapter cells */}
      {chapters.map((ch) => {
        const cellTriggers = triggers.filter((t) => t.chapterId === ch.id);
        return (
          <div key={ch.id} style={{
            padding: 6,
            background: "rgba(255,255,255,0.02)",
            borderRight: "1px solid rgba(255,255,255,0.05)",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
            minHeight: 60,
            display: "flex", flexDirection: "column", gap: 4,
          }}>
            {cellTriggers.map((t) => (
              <TriggerCard
                key={t.id}
                trigger={t}
                isSelected={t.id === selectedTriggerId}
                dialogueName={dialogues.find((d) => d.id === t.dialogueId)?.name ?? "(no dialog)"}
                onClick={() => onSelectTrigger(t.id)}
              />
            ))}
            <button
              onClick={() => onAddTrigger(ch.id, bpId)}
              style={{
                marginTop: cellTriggers.length > 0 ? 2 : "auto",
                padding: "2px 6px", fontSize: 10,
                background: "transparent", border: "1px dashed rgba(255,255,255,0.15)",
                borderRadius: 3, color: "var(--text-dim)", cursor: "pointer",
              }}
              title={`Add trigger in "${ch.name}" for ${bpName}`}
            >+ Trigger</button>
          </div>
        );
      })}
    </>
  );
}

// ── A single trigger card on the canvas ──────────────────────────────

function TriggerCard({
  trigger, isSelected, dialogueName, onClick,
}: {
  trigger: DialogFlowTrigger;
  isSelected: boolean;
  dialogueName: string;
  onClick: () => void;
}) {
  const kindLabel: Record<DialogFlowTriggerKind, string> = {
    OnInteract: "🗣 Interact",
    OnEnterScene: "🚪 Enter Scene",
    OnSignal: `📡 ${trigger.signalName || "(no signal)"}`,
  };
  return (
    <div
      onClick={onClick}
      style={{
        padding: "5px 7px",
        background: isSelected ? "rgba(245,207,71,0.25)" : "rgba(74, 124, 209, 0.25)",
        border: `1px solid ${isSelected ? "var(--yellow)" : "rgba(140, 160, 220, 0.4)"}`,
        borderRadius: 4,
        cursor: "pointer",
        display: "flex", flexDirection: "column", gap: 2,
      }}
      title={`Click to edit. Conditions: ${trigger.conditions.length}, Priority: ${trigger.priority}${trigger.oneShot ? ", one-shot" : ""}`}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {dialogueName}
      </span>
      <span style={{ fontSize: 9, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {kindLabel[trigger.kind]}{trigger.conditions.length > 0 ? ` · ${trigger.conditions.length} cond` : ""}{trigger.oneShot ? " · 1-shot" : ""}
      </span>
    </div>
  );
}

// ── Right-side detail panel ──────────────────────────────────────────

function TriggerDetailPanel({
  trigger, chapters, blueprints, dialogues,
  tracerNames, inputActionNames,
  onPatch, onRemove,
  onAddCondition, onUpdateCondition, onRemoveCondition,
}: {
  trigger: DialogFlowTrigger;
  chapters: DialogFlowChapter[];
  blueprints: BlueprintDef[];
  dialogues: DialogueAsset[];
  /** All tracer names declared on any BP — drives the OnInteract Tracer
   *  dropdown so the author picks from real values. */
  tracerNames: string[];
  /** All InputAction names from project settings — drives the optional
   *  "must press X" gate on OnInteract triggers. */
  inputActionNames: string[];
  onPatch: (patch: Partial<DialogFlowTrigger>) => void;
  onRemove: () => void;
  onAddCondition: () => void;
  onUpdateCondition: (id: string, patch: Partial<DialogFlowCondition>) => void;
  onRemoveCondition: (id: string) => void;
}) {
  return (
    <div style={{ width: 340, borderLeft: "1px solid rgba(255,255,255,0.08)", overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Trigger</span>
        <button
          onClick={onRemove}
          style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "var(--red)", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}
          title="Delete this trigger"
        >Delete</button>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <Field label="Dialog">
          <select
            value={trigger.dialogueId}
            onChange={(e) => onPatch({ dialogueId: e.target.value })}
            style={inputStyle}
          >
            <option value="">— pick dialog —</option>
            {dialogues.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>

        <Field label="Speaking NPC">
          <div style={{
            padding: "5px 7px", fontSize: 11, background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4,
            color: "var(--text-2)",
          }}>
            {blueprints.find((b) => b.id === trigger.speakerBpId)?.name ?? "(none — set by timeline row)"}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
            Auto-set by which row this trigger sits in. Move the trigger to a different row to change the NPC.
          </div>
        </Field>

        <Field label="Limit to NPC instance (optional)">
          <input
            type="text"
            value={trigger.instanceName ?? ""}
            placeholder="(any placement of this NPC)"
            onChange={(e) => onPatch({ instanceName: e.target.value || undefined })}
            style={inputStyle}
            title="Optional: only fire for a specific placement of this NPC. Match its instance Name from the scene editor. Empty = any placement of this NPC."
          />
        </Field>

        <Field label="Chapter (narrative arc)">
          <select
            value={trigger.chapterId}
            onChange={(e) => onPatch({ chapterId: e.target.value })}
            style={inputStyle}
            title="Narrative grouping for the timeline (Act 1, Boss Arena, Tutorial, etc.). Display-only — runtime ignores chapter; it's just for organizing triggers in the editor."
          >
            {chapters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
            A narrative bucket for visual organization. Lets one NPC have different dialogs per chapter (Act 1 line vs Act 2 line).
          </div>
        </Field>

        <Field label="Trigger Kind">
          <select
            value={trigger.kind}
            onChange={(e) => onPatch({ kind: e.target.value as DialogFlowTriggerKind })}
            style={inputStyle}
            title="OnInteract = player interacts with this NPC. OnEnterScene = fires automatically at scene start. OnSignal = listens for a named signal on the scene bus."
          >
            <option value="OnInteract">OnInteract (player talks)</option>
            <option value="OnEnterScene">OnEnterScene (auto on load)</option>
            <option value="OnSignal">OnSignal (named signal)</option>
          </select>
        </Field>

        {trigger.kind === "OnSignal" && (
          <Field label="Signal Name">
            <input
              type="text"
              value={trigger.signalName ?? ""}
              onChange={(e) => onPatch({ signalName: e.target.value })}
              placeholder="e.g. ChoseShop"
              style={inputStyle}
            />
          </Field>
        )}

        {trigger.kind === "OnInteract" && (
          <>
            <Field label="Dialog starter (BP)">
              <select
                value={trigger.tracerHostBpId ?? ""}
                onChange={(e) => onPatch({ tracerHostBpId: e.target.value || undefined, tracerName: undefined })}
                style={inputStyle}
                title="Which BP starts the dialogue — typically the player. The dialog fires when this BP's tracer detects the speaking NPC."
              >
                <option value="">— pick BP —</option>
                {blueprints
                  .filter((b) => b.behaviors.some((bh) => bh.kind === "Tracer" && bh.config.name))
                  .map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
                Usually the player. For NPC-to-NPC conversations, pick the other NPC. Only BPs with a named Tracer are listed.
              </div>
            </Field>

            <Field label="Tracer name">
              {(() => {
                // Tracers belonging to the chosen starter BP only — keeps the
                // list short and avoids picking a tracer that doesn't exist
                // on the starter.
                const filteredNames = trigger.tracerHostBpId
                  ? Array.from(new Set(
                      (blueprints.find((b) => b.id === trigger.tracerHostBpId)?.behaviors ?? [])
                        .filter((bh) => bh.kind === "Tracer")
                        .map((bh) => String(bh.config.name ?? ""))
                        .filter(Boolean),
                    )).sort()
                  : [];
                if (filteredNames.length === 0) {
                  return (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
                      {trigger.tracerHostBpId
                        ? "That BP has no named Tracer components. Add a Tracer with a Name on it first."
                        : "Pick a Dialog Starter BP above to see its tracers."}
                    </span>
                  );
                }
                return (
                  <select
                    value={trigger.tracerName ?? ""}
                    onChange={(e) => onPatch({ tracerName: e.target.value || undefined })}
                    style={inputStyle}
                    title="The tracer on the Dialog Starter BP that fires this dialog when it touches the speaking NPC."
                  >
                    <option value="">— manual (use InteractWithNPC action) —</option>
                    {filteredNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                );
              })()}
            </Field>

            {trigger.tracerName && (
              <Field label="Require Key Press">
                {inputActionNames.length === 0 ? (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
                    No Input Actions defined. Define one in project settings to gate this trigger on a key.
                  </span>
                ) : (
                  <select
                    value={trigger.interactAction ?? ""}
                    onChange={(e) => onPatch({ interactAction: e.target.value || undefined })}
                    style={inputStyle}
                    title="Optional: require this Input Action to be pressed in addition to the tracer hit. Empty = fires automatically when the tracer touches the NPC."
                  >
                    <option value="">— no key (auto-fire on tracer hit) —</option>
                    {inputActionNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                )}
              </Field>
            )}
          </>
        )}

        <Field label="Priority">
          <input
            type="number"
            value={trigger.priority}
            onChange={(e) => onPatch({ priority: Number(e.target.value) || 0 })}
            style={inputStyle}
            title="When multiple triggers match the same event, the highest priority wins. Equal priorities → first in list."
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text)", cursor: "pointer" }}>
          <Toggle
            value={trigger.oneShot}
            onChange={(v) => onPatch({ oneShot: v })}
          />
          <span>One-shot (fires only once per game session)</span>
        </label>

        {/* Conditions section */}
        <div style={{ marginTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Conditions (ALL must match)
            </span>
            <button
              onClick={onAddCondition}
              style={{ padding: "2px 8px", fontSize: 10, background: "transparent", border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer" }}
            >+ Condition</button>
          </div>
          {trigger.conditions.length === 0 && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", padding: "4px 0" }}>
              No conditions — trigger fires unconditionally.
            </div>
          )}
          {trigger.conditions.map((c) => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "1fr 60px 1fr 22px", gap: 4, alignItems: "center", marginBottom: 4 }}>
              <input
                type="text"
                value={c.left}
                onChange={(e) => onUpdateCondition(c.id, { left: e.target.value })}
                placeholder="var:Player.hp"
                style={smallInputStyle}
                title="Left-hand value: literal, var:BP.field, or self.x"
              />
              <select
                value={c.op}
                onChange={(e) => onUpdateCondition(c.id, { op: e.target.value as DialogFlowCondition["op"] })}
                style={smallInputStyle}
              >
                <option value="==">==</option>
                <option value="!=">!=</option>
                <option value="<">&lt;</option>
                <option value=">">&gt;</option>
                <option value="<=">&lt;=</option>
                <option value=">=">&gt;=</option>
                <option value="contains">contains</option>
              </select>
              <input
                type="text"
                value={c.right}
                onChange={(e) => onUpdateCondition(c.id, { right: e.target.value })}
                placeholder="50"
                style={smallInputStyle}
              />
              <button
                onClick={() => onRemoveCondition(c.id)}
                style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text-dim)", borderRadius: 3, padding: 0, width: 22, height: 22, cursor: "pointer", fontSize: 11 }}
                title="Remove condition"
              >×</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 11, padding: "4px 6px",
  background: "var(--bg)", color: "var(--text)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3,
  outline: "none",
};
const smallInputStyle: React.CSSProperties = {
  fontSize: 10, padding: "2px 4px",
  background: "var(--bg)", color: "var(--text)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3,
  outline: "none",
};
