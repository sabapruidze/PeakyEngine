import { useEffect, useState, type CSSProperties } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import type { BlueprintDef, LogicSheet, ListEntry } from "../project";
import { LogicSheetModal } from "./inspector/LogicSheet/LogicSheetModal";
import { OpenLogicSheetButton } from "../components/OpenLogicSheetButton";

/**
 * Main Logic Sheets manager. Replaces the legacy single per-scene Main
 * Event Sheet — authors can now declare any number of project-level
 * Main Logic Sheets and toggle each on/off independently. Same authoring
 * surface as a Blueprint's logic sheet, just hosted on
 * `project.mainLogicSheets` instead of a BP.
 *
 * Opening a sheet mounts `LogicSheetModal` with a synthesized BP-shaped
 * facade so the same node-graph editor handles project-level sheets
 * without a parallel UI. `onCommitSheet` routes saves back to
 * `setMainLogicSheetGraph`.
 */
export function MainSheetView() {
  const sheets = useEditor((s) => s.project.mainLogicSheets ?? []);
  const addMainLogicSheet = useEditor((s) => s.addMainLogicSheet);
  const renameMainLogicSheet = useEditor((s) => s.renameMainLogicSheet);
  const removeMainLogicSheet = useEditor((s) => s.removeMainLogicSheet);
  const setMainLogicSheetEnabled = useEditor((s) => s.setMainLogicSheetEnabled);
  const setMainLogicSheetGraph = useEditor((s) => s.setMainLogicSheetGraph);

  const globals = useEditor((s) => s.project.globalVariables ?? []);
  const addGlobalVariable = useEditor((s) => s.addGlobalVariable);
  const renameGlobalVariable = useEditor((s) => s.renameGlobalVariable);
  const setGlobalVariableType = useEditor((s) => s.setGlobalVariableType);
  const setGlobalVariableDefault = useEditor((s) => s.setGlobalVariableDefault);
  const setGlobalVariableIsArray = useEditor((s) => s.setGlobalVariableIsArray);
  const setGlobalVariableItems = useEditor((s) => s.setGlobalVariableItems);
  const removeGlobalVariable = useEditor((s) => s.removeGlobalVariable);

  // Blueprint variables promoted to Global (read-only reflection — edited on
  // the Blueprint's variable, shown here so all globals live in one view).
  const blueprints = useEditor((s) => s.project.blueprints);
  const bpGlobals = blueprints.flatMap((bp) =>
    bp.variables.filter((v) => v.global).map((v) => ({ key: `${bp.id}:${v.id}`, name: v.name, bp: bp.name, type: v.type })),
  );

  const lists = useEditor((s) => s.project.lists ?? []);
  const addList = useEditor((s) => s.addList);
  const renameList = useEditor((s) => s.renameList);
  const addListEntry = useEditor((s) => s.addListEntry);
  const renameListEntry = useEditor((s) => s.renameListEntry);
  const setListEntryType = useEditor((s) => s.setListEntryType);
  const setListEntryValue = useEditor((s) => s.setListEntryValue);
  const removeListEntry = useEditor((s) => s.removeListEntry);
  const removeList = useEditor((s) => s.removeList);

  // The open Main Sheet id is keyed under "__main__" so it survives view
  // navigation (close MainSheetView, open a BP, come back — same sheet
  // reopens). Local useState would forget the selection on unmount.
  const openId = useEditor((s) => s.openLogicFolderByOwner["__main__"] ?? null);
  const setOpenLogicFolderForOwner = useEditor((s) => s.setOpenLogicFolderForOwner);
  const setOpenId = (id: string | null) => setOpenLogicFolderForOwner("__main__", id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const openSheet = sheets.find((s) => s.id === openId) ?? null;

  /** Synthesize a BlueprintDef-shaped facade for LogicSheetModal. The
   *  modal reads {id, name, logicSheet, behaviors, variables}; the rest
   *  is shape-only and never touched. `onCommitSheet` routes writes
   *  back to the project's mainLogicSheets array. */
  const facadeFor = (id: string, name: string, sheet: LogicSheet): BlueprintDef => ({
    id: `__main__:${id}`,
    name,
    classKind: "Actor",
    tags: [],
    w: 0,
    h: 0,
    color: 0,
    hideRect: true,
    affectedByGravity: false,
    behaviors: [],
    variables: [],
    events: [],
    eventGroups: [],
    eventPages: [],
    logicSheet: sheet,
    path: "/",
  });

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Main Logic Sheets</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
          Project-wide logic. Each sheet runs alongside Blueprint logic sheets and can be toggled independently.
        </span>
        <button
          onClick={() => addMainLogicSheet()}
          style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 11, background: "var(--inner)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer" }}
        >+ New Main Sheet</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <div style={{ marginBottom: 18, border: "1px solid var(--border)", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: globals.length ? "1px solid var(--border)" : "none" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Global Variables</span>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
              Read/write values that persist across scenes (money, day, flags). Use <code>global:name</code> anywhere. The <b>List</b> toggle makes one hold a growable list of values.
            </span>
            <button
              onClick={() => addGlobalVariable()}
              style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11, background: "var(--inner)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap" }}
            >+ Global</button>
          </div>

          {globals.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
              No global variables yet. Add money, day count, quest flags, etc. — anything that must survive a scene change.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, padding: "8px 12px", alignItems: "start" }}>
              {globals.map((g) => (
                <GlobalVarRow
                  key={g.id}
                  id={g.id}
                  name={g.name}
                  type={g.type}
                  value={g.default}
                  isArray={!!g.isArray}
                  items={g.items ?? []}
                  onRename={(v) => renameGlobalVariable(g.id, v)}
                  onType={(t) => setGlobalVariableType(g.id, t)}
                  onValue={(v) => setGlobalVariableDefault(g.id, v)}
                  onIsArray={(a) => setGlobalVariableIsArray(g.id, a)}
                  onItems={(it) => setGlobalVariableItems(g.id, it)}
                  onRemove={() => removeGlobalVariable(g.id)}
                />
              ))}
            </div>
          )}

          {bpGlobals.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", padding: "7px 12px 9px" }}>
              <div style={{ fontSize: 9.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 5 }}>
                From Blueprint variables (edit on the Blueprint)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {bpGlobals.map((g) => (
                  <span
                    key={g.key}
                    title={`Global variable "${g.name}" (${g.type}) — promoted on Blueprint "${g.bp}". Read via global:${g.name}.`}
                    style={{ fontSize: 10.5, padding: "2px 8px", background: "var(--inner)", border: "1px solid var(--border)", color: "var(--text-2)", borderRadius: 3 }}
                  >
                    <b style={{ color: "var(--text)" }}>{g.name}</b> <span style={{ opacity: 0.6 }}>· {g.bp} · {g.type}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 18, border: "1px solid var(--border)", background: "var(--card)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: lists.length ? "1px solid var(--border)" : "none" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Lists <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>— read-only lookup tables</span></span>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
              Fixed name→value tables you fill in here (prices, dialogue lines, spawn data) — never change in-game. Read with <code>list:name.key</code>. For a list that <i>changes</i> at runtime, use a global with the <b>List</b> toggle instead.
            </span>
            <button
              onClick={() => addList()}
              style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11, background: "var(--inner)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap" }}
            >+ List</button>
          </div>

          {lists.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
              No lists yet. Add lookup data — shop prices, stats tables, dialogue lines. Each list is a named group of entries.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, padding: "10px 12px", alignItems: "start" }}>
              {lists.map((l) => (
                <ListGroup
                  key={l.id}
                  name={l.name}
                  type={l.type}
                  entries={l.entries ?? []}
                  onRename={(v) => renameList(l.id, v)}
                  onAddEntry={() => addListEntry(l.id)}
                  onRenameEntry={(eid, v) => renameListEntry(l.id, eid, v)}
                  onEntryType={(eid, t) => setListEntryType(l.id, eid, t)}
                  onEntryValue={(eid, v) => setListEntryValue(l.id, eid, v)}
                  onRemoveEntry={(eid) => removeListEntry(l.id, eid)}
                  onRemove={() => removeList(l.id)}
                />
              ))}
            </div>
          )}
        </div>

        {sheets.length === 0 ? (
          <div style={{ padding: 32, fontSize: 12, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center" }}>
            No Main Logic Sheets yet. Click <b>+ New Main Sheet</b> to create one.
            Use them for game-wide flow: pause menus, save/load orchestration, scene transitions, persistent timers.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sheets.map((ms) => {
              const isRenaming = renamingId === ms.id;
              const folderCount = ms.sheet.folders.length;
              return (
                <div
                  key={ms.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "10px 12px",
                    background: ms.enabled ? "var(--card)" : "var(--inner)",
                    border: "1px solid var(--border)",
                    opacity: ms.enabled ? 1 : 0.65,
                  }}
                >
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, color: "var(--text-dim)" }}
                    title={ms.enabled ? "Active — this sheet runs at runtime. Click to disable." : "Disabled — this sheet is skipped at runtime. Click to enable."}>
                    <Toggle
                      value={ms.enabled}
                      onChange={(v) => setMainLogicSheetEnabled(ms.id, v)}
                    />
                    {ms.enabled ? "ACTIVE" : "OFF"}
                  </label>

                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => { if (renameDraft.trim()) renameMainLogicSheet(ms.id, renameDraft.trim()); setRenamingId(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { if (renameDraft.trim()) renameMainLogicSheet(ms.id, renameDraft.trim()); setRenamingId(null); }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      style={{ fontSize: 13, padding: "3px 6px" }}
                    />
                  ) : (
                    <span
                      onDoubleClick={() => { setRenamingId(ms.id); setRenameDraft(ms.name); }}
                      title="Double-click to rename"
                      style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", cursor: "text", userSelect: "none" }}
                    >{ms.name}</span>
                  )}

                  <OpenLogicSheetButton onClick={() => setOpenId(ms.id)} folderCount={folderCount} />

                  <button
                    onClick={() => { if (window.confirm(`Delete Main Sheet "${ms.name}"? All its events are removed.`)) removeMainLogicSheet(ms.id); }}
                    title="Delete this sheet"
                    style={{ width: 28, height: 28, padding: 0, background: "transparent", border: "1px solid var(--border)", color: "var(--red)", cursor: "pointer", fontSize: 14 }}
                  >×</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openSheet && (
        <LogicSheetModal
          bp={facadeFor(openSheet.id, openSheet.name, openSheet.sheet)}
          onClose={() => setOpenId(null)}
          onCommitSheet={(next) => setMainLogicSheetGraph(openSheet.id, next)}
        />
      )}
    </div>
  );
}

type GlobalVarType = "number" | "float" | "string" | "boolean";
type Scalar = number | string | boolean;

/** Parse one CSV token to a scalar of the given element type. `number` snaps to
 *  a whole integer; `float` keeps decimals. */
function parseScalar(token: string, type: GlobalVarType): Scalar {
  const t = token.trim();
  if (type === "boolean") return t === "true" || t === "1";
  if (type === "number") { const n = Number(t); return Number.isFinite(n) ? Math.round(n) : 0; }
  if (type === "float") { const n = Number(t); return Number.isFinite(n) ? n : 0; }
  return t;
}

/** One row in the Global Variables table — a single horizontal line:
 *  [name] [type] [ [] switch] [value | CSV list]. Local draft state on the
 *  text inputs so typing doesn't thrash the store; committed on blur / Enter. */
function GlobalVarRow({
  name, type, value, isArray, items, onRename, onType, onValue, onIsArray, onItems, onRemove,
}: {
  id: string;
  name: string;
  type: GlobalVarType;
  value: Scalar;
  isArray: boolean;
  items: Scalar[];
  onRename: (v: string) => void;
  onType: (t: GlobalVarType) => void;
  onValue: (v: Scalar) => void;
  onIsArray: (a: boolean) => void;
  onItems: (it: Scalar[]) => void;
  onRemove: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(name);
  const [valDraft, setValDraft] = useState(String(value));
  const [itemsDraft, setItemsDraft] = useState(items.join(", "));
  // Re-sync drafts when committed values change externally (type coercion etc.).
  // Doesn't fight mid-typing because these only change on commit.
  useEffect(() => { setValDraft(String(value)); }, [value]);
  useEffect(() => { setItemsDraft(items.join(", ")); }, [items]);

  const commitName = () => {
    const v = nameDraft.trim();
    if (v && v !== name) onRename(v);
    else setNameDraft(name);
  };
  const commitValue = () => {
    if (type === "number") {
      const n = Number(valDraft);
      onValue(Number.isFinite(n) ? Math.round(n) : 0);
    } else if (type === "float") {
      const n = Number(valDraft);
      onValue(Number.isFinite(n) ? n : 0);
    } else {
      onValue(valDraft);
    }
  };
  const commitItems = () => {
    const parsed = itemsDraft.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => parseScalar(s, type));
    onItems(parsed);
  };

  const inputStyle: CSSProperties = {
    fontSize: 11, padding: "3px 5px", background: "var(--card)",
    border: "1px solid var(--border)", color: "var(--text)", width: "100%", boxSizing: "border-box", minWidth: 0,
  };

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: 5, background: "var(--inner)", border: "1px solid var(--border)", minWidth: 0 }}>
      <input
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setNameDraft(name); }}
        spellCheck={false}
        placeholder="name"
        title={name}
        style={{ ...inputStyle, fontWeight: 600, flex: 1 }}
      />
      <select
        value={type}
        onChange={(e) => onType(e.target.value as GlobalVarType)}
        title="Element type"
        style={{ ...inputStyle, width: 58, flexShrink: 0, padding: "3px 2px" }}
      >
        <option value="number">number</option>
        <option value="float">float</option>
        <option value="string">string</option>
        <option value="boolean">boolean</option>
      </select>
      {/* List switcher — turns this global into a growable list of values
          (read + write at runtime). NOT the read-only "Lists" section below. */}
      <button
        onClick={() => onIsArray(!isArray)}
        title={isArray ? "This global is a LIST (holds many values; add/remove at runtime). Click for a single value." : "Single value. Click to make it a LIST (holds many values)."}
        style={{
          flexShrink: 0, padding: "0 7px", height: 22, cursor: "pointer", fontSize: 10,
          background: isArray ? "var(--yellow)" : "transparent",
          border: "1px solid var(--border)",
          color: isArray ? "#1a1a1a" : "var(--text-2)", fontWeight: 700, whiteSpace: "nowrap",
        }}
      >List</button>
      {isArray ? (
        <input
          value={itemsDraft}
          onChange={(e) => setItemsDraft(e.target.value)}
          onBlur={commitItems}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="comma, separated, list"
          title="Initial list items (comma-separated)"
          style={{ ...inputStyle, flex: 1 }}
        />
      ) : type === "boolean" ? (
        <select
          value={String(value) === "true" ? "true" : "false"}
          onChange={(e) => onValue(e.target.value === "true")}
          title="Initial value"
          style={{ ...inputStyle, flex: 1 }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          value={valDraft}
          type={type === "string" ? "text" : "number"}
          onChange={(e) => setValDraft(e.target.value)}
          onBlur={commitValue}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="value"
          title="Initial value"
          style={{ ...inputStyle, flex: 1 }}
        />
      )}
      <button
        onClick={onRemove}
        title="Delete global variable"
        style={{ width: 20, height: 20, flexShrink: 0, padding: 0, background: "transparent", border: "1px solid var(--border)", color: "var(--red)", cursor: "pointer", fontSize: 12 }}
      >×</button>
    </div>
  );
}

const groupInputStyle: CSSProperties = {
  fontSize: 11, padding: "3px 5px", background: "var(--card)",
  border: "1px solid var(--border)", color: "var(--text)", width: "100%", boxSizing: "border-box", minWidth: 0,
};

/** A read-only List group card — a named group header (name + type + delete)
 *  over a column of {name, value} entry rows with a + Add button. */
function ListGroup({
  name, type, entries, onRename, onAddEntry, onRenameEntry, onEntryType, onEntryValue, onRemoveEntry, onRemove,
}: {
  name: string;
  /** List default type — silent default for new rows; each row can override. */
  type: GlobalVarType;
  entries: ListEntry[];
  onRename: (v: string) => void;
  onAddEntry: () => void;
  onRenameEntry: (entryId: string, v: string) => void;
  onEntryType: (entryId: string, t: GlobalVarType) => void;
  onEntryValue: (entryId: string, v: Scalar) => void;
  onRemoveEntry: (entryId: string) => void;
  onRemove: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(name);
  useEffect(() => { setNameDraft(name); }, [name]);
  const commitName = () => {
    const v = nameDraft.trim();
    if (v && v !== name) onRename(v);
    else setNameDraft(name);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: 7, background: "var(--inner)", border: "1px solid var(--border)", minWidth: 0 }}>
      {/* Group header — name · type · delete */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setNameDraft(name); }}
          spellCheck={false}
          placeholder="list name"
          title={name}
          style={{ ...groupInputStyle, fontWeight: 700, flex: 1 }}
        />
        <button
          onClick={onRemove}
          title="Delete list"
          style={{ width: 20, height: 20, flexShrink: 0, padding: 0, background: "transparent", border: "1px solid var(--border)", color: "var(--red)", cursor: "pointer", fontSize: 12 }}
        >×</button>
      </div>

      {/* Entries */}
      {entries.map((e) => (
        <ListEntryRow
          key={e.id}
          name={e.name}
          type={e.type ?? type}
          value={e.value}
          onRename={(v) => onRenameEntry(e.id, v)}
          onType={(t) => onEntryType(e.id, t)}
          onValue={(v) => onEntryValue(e.id, v)}
          onRemove={() => onRemoveEntry(e.id)}
        />
      ))}

      <button
        onClick={onAddEntry}
        style={{ alignSelf: "flex-start", padding: "2px 9px", fontSize: 10.5, background: "var(--card)", border: "1px dashed var(--border)", color: "var(--text-2)", cursor: "pointer" }}
      >+ Add</button>
    </div>
  );
}

/** One {name, value} entry inside a List group. `type` is the entry's EFFECTIVE
 *  type (its own override, else the list default); `onType` sets the per-entry
 *  override so one list can mix types. */
function ListEntryRow({
  name, type, value, onRename, onType, onValue, onRemove,
}: {
  name: string;
  type: GlobalVarType;
  value: Scalar;
  onRename: (v: string) => void;
  onType: (t: GlobalVarType) => void;
  onValue: (v: Scalar) => void;
  onRemove: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(name);
  const [valDraft, setValDraft] = useState(String(value));
  useEffect(() => { setNameDraft(name); }, [name]);
  useEffect(() => { setValDraft(String(value)); }, [value]);

  const commitName = () => {
    const v = nameDraft.trim();
    if (v && v !== name) onRename(v);
    else setNameDraft(name);
  };
  const commitValue = () => {
    if (type === "number") {
      const n = Number(valDraft);
      onValue(Number.isFinite(n) ? Math.round(n) : 0);
    } else if (type === "float") {
      const n = Number(valDraft);
      onValue(Number.isFinite(n) ? n : 0);
    } else {
      onValue(valDraft);
    }
  };

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <input
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setNameDraft(name); }}
        spellCheck={false}
        placeholder="name"
        style={{ ...groupInputStyle, flex: 1 }}
      />
      <select
        value={type}
        onChange={(e) => onType(e.target.value as GlobalVarType)}
        title="Type of this entry (overrides the list default)"
        style={{ ...groupInputStyle, width: 54, flexShrink: 0, padding: "3px 2px" }}
      >
        <option value="number">num</option>
        <option value="float">float</option>
        <option value="string">str</option>
        <option value="boolean">bool</option>
      </select>
      {type === "boolean" ? (
        <select
          value={String(value) === "true" ? "true" : "false"}
          onChange={(e) => onValue(e.target.value === "true")}
          style={{ ...groupInputStyle, flex: 1 }}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          value={valDraft}
          type={type === "string" ? "text" : "number"}
          onChange={(e) => setValDraft(e.target.value)}
          onBlur={commitValue}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="value"
          style={{ ...groupInputStyle, flex: 1 }}
        />
      )}
      <button
        onClick={onRemove}
        title="Delete entry"
        style={{ width: 18, height: 18, flexShrink: 0, padding: 0, background: "transparent", border: "1px solid var(--border)", color: "var(--red)", cursor: "pointer", fontSize: 11 }}
      >×</button>
    </div>
  );
}
