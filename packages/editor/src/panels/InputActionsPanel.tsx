import { useEffect, useState } from "react";
import { useEditor } from "../store";

interface Props {
  onClose: () => void;
}

/**
 * Modal for project-wide Input Action mapping (UE5-style).
 *
 * Each action has a name and a list of bound key codes (Phaser KeyCode strings).
 * Multiple keys per action — pressing any binds the action down. SMs and the
 * Platformer behavior reference action names, never raw keys, so rebinding
 * here propagates everywhere instantly.
 */
export function InputActionsPanel({ onClose }: Props) {
  const actions = useEditor((s) => s.project.inputActions);
  const groups = useEditor((s) => s.project.inputActionGroups) ?? [];
  const add = useEditor((s) => s.addInputAction);
  const rename = useEditor((s) => s.renameInputAction);
  const setKeys = useEditor((s) => s.setInputActionKeys);
  const remove = useEditor((s) => s.removeInputAction);
  const addGroup = useEditor((s) => s.addInputActionGroup);
  const renameGroup = useEditor((s) => s.renameInputActionGroup);
  const removeGroup = useEditor((s) => s.removeInputActionGroup);
  const move = useEditor((s) => s.moveInputAction);

  // Drag state: which action is being dragged, and the current drop target
  // (an action id for "insert before", or `grp:<name>` / `grp:` for
  // "append to group / ungrouped"). Both drive the highlight.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  // Collapsed group names. A collapsed group hides its rows but stays a drop
  // target — dropping onto it expands it so you see the result.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });

  const actionsIn = (group: string) => actions.filter((a) => (a.group ?? "") === group);

  const onRowDrop = (target: { id: string; group?: string }) => {
    if (dragId && dragId !== target.id) move(dragId, target.group ?? "", target.id);
    setDragId(null); setDropHint(null);
  };
  const onGroupDrop = (group: string) => {
    if (dragId) {
      move(dragId, group, null);
      // Expand the group you just dropped into so the moved action is visible.
      if (group) setCollapsed((prev) => { const n = new Set(prev); n.delete(group); return n; });
    }
    setDragId(null); setDropHint(null);
  };

  const renderRow = (a: typeof actions[number]) => (
    <div
      key={a.id}
      draggable
      onDragStart={(e) => { setDragId(a.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => { setDragId(null); setDropHint(null); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dropHint !== a.id) setDropHint(a.id); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onRowDrop(a); }}
      style={{
        display: "grid",
        gridTemplateColumns: "16px 150px 1fr auto",
        gap: 8,
        alignItems: "center",
        background: dragId === a.id ? "var(--inner-hi)" : "var(--panel-2)",
        border: "1px solid var(--border)",
        borderTop: dropHint === a.id ? "2px solid var(--yellow)" : "1px solid var(--border)",
        borderRadius: 4,
        padding: "6px 8px",
        opacity: dragId === a.id ? 0.5 : 1,
      }}
    >
      <span style={{ cursor: "grab", color: "var(--text-dim)", fontSize: 13, userSelect: "none" }} title="Drag to reorder / move into a group">⠿</span>
      <input
        value={a.name}
        onChange={(e) => rename(a.id, e.target.value)}
        style={{ fontWeight: 600 }}
        title="Action name (must be unique)"
      />
      <KeyBindings keys={a.keys} onChange={(next) => setKeys(a.id, next)} />
      <button onClick={() => remove(a.id)} className="danger" style={{ fontSize: 11, padding: "4px 8px" }}>×</button>
    </div>
  );

  // One drop-zone section. `group` "" = the ungrouped catch-all (no header).
  const renderSection = (group: string) => {
    const rows = actionsIn(group);
    const isUngrouped = group === "";
    const hintKey = `grp:${group}`;
    const isCollapsed = !isUngrouped && collapsed.has(group);
    return (
      <div
        key={hintKey}
        onDragOver={(e) => { e.preventDefault(); if (dropHint !== hintKey) setDropHint(hintKey); }}
        onDrop={(e) => { e.preventDefault(); onGroupDrop(group); }}
        style={{
          display: "flex", flexDirection: "column", gap: 6,
          border: isUngrouped ? "none" : "1px solid var(--border)",
          borderRadius: 6,
          padding: isUngrouped ? 0 : 8,
          background: dropHint === hintKey ? "rgba(255,210,60,0.08)" : "transparent",
        }}
      >
        {!isUngrouped && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => toggleCollapse(group)}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--yellow)", fontSize: 12, padding: 0, width: 16, lineHeight: 1 }}
              title={isCollapsed ? "Expand group" : "Collapse group"}
            >{isCollapsed ? "▸" : "▾"}</button>
            <input
              defaultValue={group}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== group) renameGroup(group, v); else e.target.value = group; }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              style={{ fontWeight: 700, fontSize: 12, flex: 1, background: "transparent", border: "1px solid transparent" }}
              title="Group name (rename)"
            />
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{rows.length}</span>
            <button onClick={() => add(undefined, group)} style={{ fontSize: 11, padding: "2px 7px" }} title="New action in this group">+ Action</button>
            <button onClick={() => removeGroup(group)} className="danger" style={{ fontSize: 11, padding: "2px 7px" }} title="Delete group (its actions become ungrouped)">Ungroup all</button>
          </div>
        )}
        {!isCollapsed && rows.map(renderRow)}
        {!isCollapsed && rows.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic", padding: "6px 8px", border: "1px dashed var(--border)", borderRadius: 4 }}>
            {isUngrouped ? "No ungrouped actions." : "Empty — drag actions here."}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 620, maxHeight: "82vh" }}>
        <header>
          <span>Input Actions</span>
          <button onClick={onClose} style={{ fontSize: 11 }}>Close</button>
        </header>

        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11, borderBottom: "1px solid var(--border)" }}>
          Define named actions like <strong>Jump</strong> and bind them to one or more keys.
          State machines and behaviors reference the action name — rebind here without touching SMs.
          Drag the <span style={{ color: "var(--text-2)" }}>⠿</span> handle to reorder, or drop an action onto a group to move it in.
        </div>

        <div style={{ padding: 8, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g) => renderSection(g))}
          {renderSection("")}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button onClick={() => add()}>+ New Action</button>
            <button onClick={() => addGroup()} style={{ background: "rgba(255,210,60,0.15)", border: "1px solid var(--yellow)" }}>+ New Group</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-action key binding strip. Shows each bound key as a chip, plus a
 * "press a key to add" listener button and a dropdown for special keys
 * that are awkward to capture (ESC closes modals, Enter submits forms).
 */
function KeyBindings({ keys, onChange }: { keys: string[]; onChange: (next: string[]) => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // ESC cancels listening without binding (so the user can bail out).
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      const phaserKey = browserEventToPhaserKey(e);
      if (phaserKey && !keys.includes(phaserKey)) {
        onChange([...keys, phaserKey]);
      }
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, keys, onChange]);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {keys.map((k) => (
        <span
          key={k}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
            fontWeight: 600,
          }}
          title={k}
        >
          {prettyKeyLabel(k)}
          <button
            onClick={() => onChange(keys.filter((x) => x !== k))}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 0,
              fontSize: 13,
              lineHeight: 1,
            }}
            title="Unbind"
          >×</button>
        </span>
      ))}
      <button
        onClick={() => setListening(true)}
        style={{
          padding: "3px 9px",
          fontSize: 11,
          fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
          fontWeight: 600,
          background: listening ? "var(--yellow)" : "rgba(74,124,209,0.35)",
          color: listening ? "#000" : "var(--text)",
          border: `1px solid ${listening ? "var(--yellow)" : "rgba(140,160,220,0.3)"}`,
          borderRadius: 4,
          cursor: "pointer",
        }}
        title={listening ? "Press any key to bind. ESC cancels." : "Click then press the key you want to bind"}
      >{listening ? "press a key…" : "+ key"}</button>
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v && !keys.includes(v)) onChange([...keys, v]);
          e.target.value = "";
        }}
        style={{
          fontSize: 11,
          padding: "3px 4px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 4,
          color: "var(--text-2)",
        }}
        title="Pick from special keys (ESC, ENTER, TAB, etc.) that are awkward to capture by pressing"
      >
        <option value="">special…</option>
        {SPECIAL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v && !keys.includes(v)) onChange([...keys, v]);
          e.target.value = "";
        }}
        style={{
          fontSize: 11,
          padding: "3px 4px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 4,
          color: "var(--text-2)",
        }}
        title="Bind a mouse button to this action"
      >
        <option value="">mouse…</option>
        <option value="MOUSE_LEFT">Left Click</option>
        <option value="MOUSE_RIGHT">Right Click</option>
        <option value="MOUSE_MIDDLE">Middle Click</option>
      </select>
    </div>
  );
}

const SPECIAL_KEYS = [
  "ESC",
  "ENTER",
  "TAB",
  "SPACE",
  "SHIFT",
  "CTRL",
  "ALT",
  "BACKSPACE",
  "DELETE",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

/**
 * Friendly chip label for a Phaser KeyCode string.
 * NUMPAD_EIGHT → "Num 8", NUMPAD_ADD → "Num +", FORWARD_SLASH → "/", etc.
 * Stored value stays the Phaser code; this only changes the display.
 */
function prettyKeyLabel(k: string): string {
  // Mouse buttons
  const mouseLbl: Record<string, string> = {
    MOUSE_LEFT: "🖱 Left", MOUSE_RIGHT: "🖱 Right", MOUSE_MIDDLE: "🖱 Middle",
  };
  if (k in mouseLbl) return mouseLbl[k];
  // Numpad digits
  const numDigit: Record<string, string> = {
    NUMPAD_ZERO: "Num 0", NUMPAD_ONE: "Num 1", NUMPAD_TWO: "Num 2",
    NUMPAD_THREE: "Num 3", NUMPAD_FOUR: "Num 4", NUMPAD_FIVE: "Num 5",
    NUMPAD_SIX: "Num 6", NUMPAD_SEVEN: "Num 7", NUMPAD_EIGHT: "Num 8",
    NUMPAD_NINE: "Num 9",
  };
  if (k in numDigit) return numDigit[k];
  // Numpad operators
  if (k === "NUMPAD_ADD") return "Num +";
  if (k === "NUMPAD_SUBTRACT") return "Num -";
  if (k === "NUMPAD_MULTIPLY") return "Num *";
  if (k === "NUMPAD_DIVIDE") return "Num /";
  if (k === "NUMPAD_DECIMAL") return "Num .";
  // Top-row digits
  const digit: Record<string, string> = {
    ZERO: "0", ONE: "1", TWO: "2", THREE: "3", FOUR: "4",
    FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9",
  };
  if (k in digit) return digit[k];
  // Punctuation
  if (k === "FORWARD_SLASH") return "/";
  if (k === "BACK_SLASH") return "\\";
  if (k === "OPEN_BRACKET") return "[";
  if (k === "CLOSE_BRACKET") return "]";
  if (k === "SEMICOLON") return ";";
  if (k === "COMMA") return ",";
  if (k === "PERIOD") return ".";
  if (k === "QUOTES") return "'";
  if (k === "BACKTICK") return "`";
  if (k === "MINUS") return "-";
  if (k === "PLUS") return "+";
  return k;
}

/** Map a browser KeyboardEvent to the Phaser KeyCode string used by the runtime. */
function browserEventToPhaserKey(e: KeyboardEvent): string | null {
  // Letter keys: e.code is "KeyA" → "A"
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  // Top-row digits: "Digit1" → "ONE" … "Digit0" → "ZERO".
  if (/^Digit[0-9]$/.test(e.code)) {
    const digits = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
    return digits[parseInt(e.code.slice(5))];
  }
  // Numpad digits: "Numpad1" → "NUMPAD_ONE" … (Phaser KeyCodes.NUMPAD_*).
  if (/^Numpad[0-9]$/.test(e.code)) {
    const numpads = ["NUMPAD_ZERO", "NUMPAD_ONE", "NUMPAD_TWO", "NUMPAD_THREE", "NUMPAD_FOUR", "NUMPAD_FIVE", "NUMPAD_SIX", "NUMPAD_SEVEN", "NUMPAD_EIGHT", "NUMPAD_NINE"];
    return numpads[parseInt(e.code.slice(6))];
  }
  // Numpad operators
  if (e.code === "NumpadAdd") return "NUMPAD_ADD";
  if (e.code === "NumpadSubtract") return "NUMPAD_SUBTRACT";
  if (e.code === "NumpadMultiply") return "NUMPAD_MULTIPLY";
  if (e.code === "NumpadDivide") return "NUMPAD_DIVIDE";
  if (e.code === "NumpadDecimal") return "NUMPAD_DECIMAL";
  if (e.code === "NumpadEnter") return "ENTER";
  // Arrow keys
  if (e.code === "ArrowLeft") return "LEFT";
  if (e.code === "ArrowRight") return "RIGHT";
  if (e.code === "ArrowUp") return "UP";
  if (e.code === "ArrowDown") return "DOWN";
  // Special
  if (e.code === "Space") return "SPACE";
  if (e.code === "Enter") return "ENTER";
  if (e.code === "Escape") return "ESC";
  if (e.code === "Tab") return "TAB";
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") return "SHIFT";
  if (e.code === "ControlLeft" || e.code === "ControlRight") return "CTRL";
  if (e.code === "AltLeft" || e.code === "AltRight") return "ALT";
  if (e.code === "Backspace") return "BACKSPACE";
  if (e.code === "Delete") return "DELETE";
  // Punctuation
  if (e.code === "Semicolon") return "SEMICOLON";
  if (e.code === "Comma") return "COMMA";
  if (e.code === "Period") return "PERIOD";
  if (e.code === "Slash") return "FORWARD_SLASH";
  if (e.code === "Backslash") return "BACK_SLASH";
  if (e.code === "BracketLeft") return "OPEN_BRACKET";
  if (e.code === "BracketRight") return "CLOSE_BRACKET";
  if (e.code === "Quote") return "QUOTES";
  if (e.code === "Backquote") return "BACKTICK";
  if (e.code === "Minus") return "MINUS";
  if (e.code === "Equal") return "PLUS";
  // Function keys
  const fmatch = /^F([1-9]|1[0-2])$/.exec(e.code);
  if (fmatch) return `F${fmatch[1]}`;
  // Fallback — only accept letter results; reject bare digits and symbols
  // because Phaser's KeyCodes lookup keys by NAME ("EIGHT"), not character ("8").
  const fallback = e.key.toUpperCase();
  if (/^[A-Z]$/.test(fallback)) return fallback;
  return null;
}
