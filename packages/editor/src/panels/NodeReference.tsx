import { useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { PALETTE, nodeShape, PIN_COLORS, HIDDEN_FROM_PICKER, HIDDEN_CONDITIONS } from "./inspector/LogicSheet/LogicGraphCanvas";
import { triggerTheme, actionComponent, conditionComponent, flowTheme, type ComponentTheme } from "./inspector/LogicSheet/nodeRegistry";
import { nodeDescription, nodeExample } from "./inspector/LogicSheet/nodeDocs";
import type { LogicGraphNode } from "../project";

type Entry = { type: string; kind: LogicGraphNode["kind"]; label: string; defaults: Record<string, unknown> };

function themeFor(e: Entry): ComponentTheme {
  if (e.kind === "trigger") return triggerTheme();
  if (e.kind === "action") return actionComponent(e.type);
  if (e.kind === "condition") return conditionComponent(e.type);
  return flowTheme();
}

function makeNode(e: Entry): LogicGraphNode {
  return { id: "t", kind: e.kind, type: e.type, params: JSON.parse(JSON.stringify(e.defaults)), position: { x: 0, y: 0 } };
}

/** A static facsimile of the real Logic Sheet node — same header color, chip and
 *  colored pins — so the doc shows what the node actually looks like. */
function NodePreview({ entry }: { entry: Entry }) {
  const theme = themeFor(entry);
  const shape = useMemo(() => nodeShape(makeNode(entry)), [entry]);
  const inExec = shape.inExec.map((p) => ({ pin: p.pin, label: p.pin, type: "exec" }));
  const outExec = shape.outExec.map((p) => ({ pin: p.pin, label: p.pin, type: "exec" }));
  const inData = shape.inData.map((p) => ({ pin: p.pin, label: p.label ?? p.pin, type: p.type }));
  const outData = shape.outData.map((p) => ({ pin: p.pin, label: p.label ?? p.pin, type: p.type }));
  const left = [...inExec, ...inData];
  const right = [...outExec, ...outData];
  const rows = Math.max(left.length, right.length, 1);
  const dot = (type: string) => (
    <span style={{ width: 9, height: 9, borderRadius: type === "exec" ? 2 : 5, background: PIN_COLORS[type] ?? PIN_COLORS.exec, border: "1px solid #000", flexShrink: 0 }} />
  );
  return (
    <div style={{ minWidth: 200, maxWidth: 240, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, background: "#1a1a1a", boxShadow: "0 2px 8px rgba(0,0,0,0.4)", overflow: "hidden", fontSize: 11, color: "#fff" }}>
      <div style={{ padding: "5px 9px", background: theme.headerBg, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.label}</span>
        <span style={{ background: theme.chipBg, color: theme.chipFg, fontSize: 8, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700, whiteSpace: "nowrap" }}>{theme.label}</span>
      </div>
      <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 12 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "#cfd6e6" }}>
              {left[i] ? <>{dot(left[i].type)}<span style={{ textTransform: left[i].type === "exec" ? "uppercase" : "none", letterSpacing: left[i].type === "exec" ? 0.5 : 0 }}>{left[i].type === "exec" ? "▶" : left[i].label}</span></> : null}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 9, color: "#cfd6e6" }}>
              {right[i] ? <>{<span>{right[i].type === "exec" ? "▶" : right[i].label}</span>}{dot(right[i].type)}</> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The Nodes tab — the full visual node reference (search + grouped previews). */
function NodesDoc() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // Match the picker exactly — hide the same dead/duplicate nodes it hides, so
  // the count + list line up with what's actually in the search menu.
  const visible = (e: Entry) =>
    !HIDDEN_FROM_PICKER.has(e.type) && !(e.kind === "condition" && HIDDEN_CONDITIONS.has(e.type));
  const total = useMemo(() => PALETTE.reduce((n, g) => n + (g.entries as Entry[]).filter(visible).length, 0), []);
  // "category" = the picker's own groups (Triggers / Actions / CharacterMovement…).
  // "component" = regroup every node by its colored component label instead.
  const [groupMode, setGroupMode] = useState<"category" | "component">("category");
  const groups = useMemo(() => {
    const match = (e: Entry) => !q || e.label.toLowerCase().includes(q) || e.type.toLowerCase().includes(q) || nodeDescription(e.type).toLowerCase().includes(q);
    if (groupMode === "component") {
      const byComp = new Map<string, Entry[]>();
      for (const g of PALETTE) for (const e of g.entries as Entry[]) {
        if (!visible(e) || !match(e)) continue;
        const arr = byComp.get(themeFor(e).label);
        if (arr) arr.push(e); else byComp.set(themeFor(e).label, [e]);
      }
      return [...byComp.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([title, entries]) => ({ title, entries, color: themeFor(entries[0]).chipBg }));
    }
    return PALETTE.map((g) => {
      const entries = (g.entries as Entry[]).filter(visible).filter(match);
      return { title: g.group, entries, color: entries[0] ? themeFor(entries[0]).chipBg : "#5f6b82" };
    }).filter((g) => g.entries.length > 0);
  }, [q, groupMode]);
  const shown = groups.reduce((n, g) => n + g.entries.length, 0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (title: string) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(title)) n.delete(title); else n.add(title);
    return n;
  });
  const btn = { fontSize: 11, padding: "5px 10px", cursor: "pointer", borderRadius: 5, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "#cdd6e6" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes…  (name or what it does)"
          style={{ flex: 1, maxWidth: 420, fontSize: 12, padding: "6px 10px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 5, color: "#fff" }}
        />
        <button style={{ ...btn, color: "#fff", background: "#3a82e8", border: "1px solid #3a82e8" }} title="Switch between the picker's categories and grouping by component color" onClick={() => setGroupMode((m) => (m === "category" ? "component" : "category"))}>
          Group: {groupMode === "category" ? "Category" : "Component"}
        </button>
        <button style={btn} onClick={() => setCollapsed(new Set())}>Expand all</button>
        <button style={btn} onClick={() => setCollapsed(new Set(groups.map((g) => g.title)))}>Collapse all</button>
        <span style={{ fontSize: 11, color: "#8b93a6" }}>{shown} / {total} nodes</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px 40px" }}>
        {groups.map((g) => {
          // When searching, force every matching group open so results show.
          const isCollapsed = collapsed.has(g.title) && !q;
          return (
            <div key={g.title} style={{ marginTop: 14 }}>
              <div
                onClick={() => toggleGroup(g.title)}
                style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9fb0d0", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 5, marginBottom: 10, cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6 }}
              >
                <span style={{ fontSize: 9, width: 9, display: "inline-block" }}>{isCollapsed ? "▸" : "▾"}</span>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: g.color, border: "1px solid rgba(0,0,0,0.4)", flexShrink: 0 }} />
                {g.title} <span style={{ color: "#5f6b82", fontWeight: 400 }}>· {g.entries.length}</span>
              </div>
              {!isCollapsed && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {g.entries.map((e) => (
                    <div key={e.type} style={{ display: "flex", gap: 18, alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.025)", borderRadius: 8 }}>
                      <div style={{ flexShrink: 0 }}><NodePreview entry={e} /></div>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{e.label} <code style={{ fontSize: 10.5, color: "#7f8aa3", fontWeight: 400 }}>{e.type}</code></div>
                        <div style={{ marginTop: 4, color: "#d0d6e2" }}>{nodeDescription(e.type) || <em style={{ color: "#7f8aa3" }}>(no description)</em>}</div>
                        <div style={{ marginTop: 6, color: "#8fd0a0" }}><b style={{ color: "#5fae74" }}>Example:</b> {nodeExample(e.type, e.kind)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {shown === 0 && <div style={{ marginTop: 40, textAlign: "center", color: "#7f8aa3" }}>No nodes match “{query}”.</div>}
      </div>
    </div>
  );
}

const DOC_TABS = [
  { id: "nodes", label: "Nodes" },
  { id: "stateMachine", label: "State Machine" },
  { id: "components", label: "Components" },
  { id: "items", label: "Items & Recipes" },
  { id: "dialogue", label: "Dialogue" },
  { id: "ui", label: "UI" },
] as const;
type DocTab = (typeof DOC_TABS)[number]["id"];

// ── Shared doc primitives (used by every written tab) ──────────────────────
function DocScroll({ children }: { children: ReactNode }) {
  return <div style={{ height: "100%", overflowY: "auto", padding: "18px 26px 60px" }}><div style={{ maxWidth: 860, margin: "0 auto", fontSize: 13.5, lineHeight: 1.65, color: "#d4dae6" }}>{children}</div></div>;
}
function H1({ children }: { children: ReactNode }) {
  return <h1 style={{ fontSize: 24, fontWeight: 800, color: "#fff", margin: "6px 0 10px" }}>{children}</h1>;
}
function H2({ children }: { children: ReactNode }) {
  return <h2 style={{ fontSize: 16, fontWeight: 700, color: "#9fc0ff", margin: "30px 0 8px", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 5 }}>{children}</h2>;
}
function P({ children }: { children: ReactNode }) {
  return <p style={{ margin: "8px 0" }}>{children}</p>;
}
function Code({ children }: { children: ReactNode }) {
  return <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 6px", borderRadius: 4, fontSize: 12.5, color: "#ffd98a" }}>{children}</code>;
}
function Callout({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "tip" }) {
  const c = tone === "warn" ? { bg: "rgba(230,160,60,0.12)", bd: "#e0a23c", ic: "⚠️" } : tone === "tip" ? { bg: "rgba(95,174,116,0.12)", bd: "#5fae74", ic: "💡" } : { bg: "rgba(90,140,230,0.12)", bd: "#5a8ce6", ic: "ℹ️" };
  return <div style={{ background: c.bg, borderLeft: `3px solid ${c.bd}`, borderRadius: 6, padding: "10px 14px", margin: "12px 0" }}><span style={{ marginRight: 8 }}>{c.ic}</span>{children}</div>;
}

/** A mock of the editor's State Machine table — purely visual, for the docs. */
function StateTableMockup() {
  const rows = [
    { name: "attack", prio: 100, enter: "(none)", main: "attack", exit: "(none)", cond: "On Key Pressed · Attack", c: "#e88ed0" },
    { name: "jump", prio: 50, enter: "jump_start", main: "jump", exit: "(none)", cond: "velocity.y < 0", c: "#8ecbe8" },
    { name: "run", prio: 15, enter: "(none)", main: "run", exit: "(none)", cond: "Is Moving > 100", c: "#5fd28b" },
    { name: "walk", prio: 10, enter: "(none)", main: "walk", exit: "(none)", cond: "Is Moving > 5", c: "#5fd28b" },
    { name: "idle", prio: 0, enter: "(none)", main: "idle", exit: "(none)", cond: "Always", c: "#cdd6e6" },
  ];
  const COLS = "26px 1fr 46px 30px 30px 1fr 1fr 1fr 1.3fr 26px";
  const cell: CSSProperties = { padding: "6px 7px", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const dd = (v: string) => <span style={{ color: v === "(none)" ? "#5f6b82" : "#c9a23a" }}>{v} <span style={{ color: "#5f6b82" }}>▾</span></span>;
  const chk = (on: boolean) => <span style={{ display: "inline-block", width: 13, height: 13, borderRadius: 3, background: on ? "#3a82e8" : "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", textAlign: "center", lineHeight: "12px", fontSize: 9, color: "#fff" }}>{on ? "✓" : ""}</span>;
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, overflow: "hidden", margin: "14px 0", background: "#161a24" }}>
      <div style={{ display: "grid", gridTemplateColumns: COLS, background: "rgba(255,255,255,0.04)", color: "#8b93a6", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {["On", "Name", "Prio", "In", "Out", "Enter", "Main", "Exit", "Condition", ""].map((h, i) => <div key={i} style={cell}>{h}</div>)}
      </div>
      {rows.map((r) => (
        <div key={r.name} style={{ display: "grid", gridTemplateColumns: COLS, borderTop: "1px solid rgba(255,255,255,0.05)", alignItems: "center" }}>
          <div style={cell}>{chk(true)}</div>
          <div style={{ ...cell, fontWeight: 700, color: r.c }}>{r.name}</div>
          <div style={{ ...cell, color: "#cdd6e6", fontFamily: "ui-monospace,monospace" }}>{r.prio}</div>
          <div style={cell}>{chk(r.enter !== "(none)")}</div>
          <div style={cell}>{chk(r.exit !== "(none)")}</div>
          <div style={cell}>{dd(r.enter)}</div>
          <div style={cell}>{dd(r.main)}</div>
          <div style={cell}>{dd(r.exit)}</div>
          <div style={{ ...cell, color: "#9fb0d0" }}>{r.cond} <span style={{ color: "#5f6b82" }}>▾</span></div>
          <div style={{ ...cell, textAlign: "center", color: "#c9a23a" }}>⚙</div>
        </div>
      ))}
    </div>
  );
}

/** Mock of one state row — matches the editor's columns left→right. */
function StateRowMockup() {
  const box = (on: boolean, label: string) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "#8b93a6" }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, background: on ? "#3a82e8" : "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.18)", textAlign: "center", lineHeight: "13px", fontSize: 10, color: "#fff" }}>{on ? "✓" : ""}</span>{label}
    </span>
  );
  const dd = (val: string, w = 110) => (
    <span style={{ width: w, padding: "4px 8px", borderRadius: 4, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.16)", fontSize: 11, display: "inline-flex", justifyContent: "space-between" }}>{val}<span style={{ color: "#5f6b82" }}>▾</span></span>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", margin: "12px 0", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, background: "#161a24", flexWrap: "wrap" }}>
      {box(true, "")}
      <span style={{ width: 80, padding: "4px 8px", borderRadius: 4, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.16)", fontSize: 11, fontWeight: 700, color: "#e88ed0" }}>attack</span>
      <span style={{ width: 44, padding: "4px 8px", borderRadius: 4, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.16)", fontSize: 11, fontFamily: "ui-monospace,monospace" }}>100</span>
      {box(false, "In")}{box(false, "Out")}
      {dd("(none)", 90)}{dd("attack", 90)}{dd("(none)", 90)}
      {dd("Always", 110)}
      <span style={{ width: 26, height: 22, borderRadius: 4, background: "#c9a23a", color: "#1a1300", textAlign: "center", lineHeight: "22px" }}>⚙</span>
      <span style={{ color: "#7f8aa3" }}>✕</span>
    </div>
  );
}

/** Mock of the gear panel's condition group (primary + AND/OR + ! + subs). */
function ConditionMockup() {
  const row = (label: string, neg = false) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "4px 0" }}>
      <span style={{ width: 22, height: 20, borderRadius: 4, textAlign: "center", lineHeight: "20px", fontWeight: 700, fontSize: 12, background: neg ? "#b53a3a" : "rgba(255,255,255,0.08)", color: neg ? "#fff" : "#8b93a6", border: "1px solid rgba(255,255,255,0.16)" }}>!</span>
      <span style={{ flex: 1, padding: "4px 8px", borderRadius: 4, background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.16)", fontSize: 11.5, color: neg ? "#e8a0a0" : "#cdd6e6" }}>{label}</span>
    </div>
  );
  const pill = (txt: string) => <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: 11, background: "#2a6cd1", color: "#fff", fontWeight: 700 }}>{txt}</span>;
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, padding: 12, margin: "12px 0", background: "#161a24" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>{pill("ALL must match")} <span style={{ fontSize: 10, color: "#8b93a6" }}>← click to flip to ANY (OR)</span></div>
      {row("Is Grounded")}
      {row("On Key Pressed · Attack")}
      {row("var:stamina < 10", true)}
      <div style={{ fontSize: 10, color: "#5fae74", margin: "6px 0 4px" }}>+ Add condition</div>
      <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid rgba(120,160,255,0.4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><span style={{ fontSize: 10, color: "#9bd0ff" }}>SUB-GROUP</span> {pill("ANY")}</div>
        {row("Is By Wall (Left)")}
        {row("Is By Wall (Right)")}
      </div>
    </div>
  );
}

function StateMachineDoc() {
  const toggles: [string, string][] = [
    ["Freeze Movement", "Zero the body's velocity every frame while active — a true freeze (cutscene pose, hard stun)."],
    ["Ignore Input", "Block player WASD/jump override without zeroing velocity — for dash/attack where the state itself is driving the motion."],
    ["Hold on Finish", "When the main anim is one-shot, hold on the LAST frame after it ends instead of releasing (death, interact, a held pose)."],
    ["Lock Facing", "Stop the auto mirror/flip while this anim plays a cycle — keeps an attack facing the way it started."],
    ["Pauses AI", "Pause the AI Brain while this state is active (so hurt/death don't get overridden by chase logic). Sticks to the state even if you rename it."],
    ["Replay on Re-trigger", "Restart the anim from frame 0 if the state's condition re-fires while it's already active (e.g. a 2nd hit landing mid-hurt)."],
    ["Hysteresis (ms)", "Sticky window — the prior state keeps winning for this long even after its condition drops, to stop 1-frame flicker between two states."],
    ["Re-entry Guard (ms)", "After leaving, skip the ENTER anim if you re-enter within this window — avoids replaying jump_start on rapid bounces."],
    ["Min / Max Phase", "Only allow this state between these PhaseManager phases — used to gate boss attacks behind HP-driven phases (-1 = no limit)."],
  ];
  return (
    <DocScroll>
      <H1>State Machine</H1>
      <P>The State Machine decides <b>which animation your character plays right now</b>, and can drive movement, signals, and AI alongside it. You give it a list of <b>states</b> (idle, walk, jump, attack…); every frame it picks the <b>one</b> state that should be active.</P>

      <H2>The core rule</H2>
      <P>Each state has a <b>priority</b> and a <b>condition</b>. Every frame the engine checks states <b>highest priority first</b> and plays the <b>first whose condition is true</b>.</P>
      <StateTableMockup />
      <Callout tone="tip">Always keep an <Code>idle</Code> state at priority 0 with condition <Code>Always</Code> — the fallback so nothing is ever blank.</Callout>

      <H2>A state row, field by field</H2>
      <P>This is one row in the table (the columns you see across the top):</P>
      <StateRowMockup />
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "4px 0" }}><b>☑ Enabled</b> — off = the state is skipped entirely (or toggle it live with the <Code>Set State Enabled</Code> node).</li>
        <li style={{ margin: "4px 0" }}><b>Name</b> · <b>Priority</b> — the name (read it via <Code>State Machine state ==</Code>) and the win order.</li>
        <li style={{ margin: "4px 0" }}><b>In / Out</b> — checkboxes to play the enter / exit animations (next column over).</li>
        <li style={{ margin: "4px 0" }}><b>Enter ▾ · Main ▾ · Exit ▾</b> — three animation pickers: a one-shot before, the looping main, a one-shot after.</li>
        <li style={{ margin: "4px 0" }}><b>Condition ▾</b> — the primary condition (when this state may win).</li>
        <li style={{ margin: "4px 0" }}><b>⚙ Gear</b> — opens the <b>advanced panel</b> below (everything in the next sections). <b>✕</b> deletes the state.</li>
      </ul>

      <H2>Conditions — combining with AND / OR / NOT</H2>
      <P>The gear panel's <b>Conditions</b> section lets a state require more than one thing. They're combined with the <b>primary</b> condition:</P>
      <ConditionMockup />
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "4px 0" }}><b>+ Add condition</b> — stack extra conditions.</li>
        <li style={{ margin: "4px 0" }}>The top pill flips the whole group between <b>ALL must match (AND)</b> and <b>ANY matches (OR)</b>.</li>
        <li style={{ margin: "4px 0" }}>The <b>!</b> button on a row <b>negates</b> it (NOT) — e.g. <i>NOT var:stamina &lt; 10</i>.</li>
        <li style={{ margin: "4px 0" }}><b>Sub-conditions</b> — a nested group with its OWN AND/OR, folded in as one term. This lets you build things like <Code>(grounded AND attack) AND (byWallLeft OR byWallRight)</Code>.</li>
      </ul>

      <H2>Animations: Enter · Main · Exit, Loop & Hold on Finish</H2>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0", flexWrap: "wrap", fontSize: 12.5 }}>
        {["jump_start (enter, once)", "jump (main, loops)", "land (exit, once)"].map((s, i) => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ padding: "5px 10px", borderRadius: 5, background: i === 1 ? "rgba(201,162,58,0.2)" : "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)" }}>{s}</span>
            {i < 2 && <span style={{ color: "#5f6b82" }}>→</span>}
          </span>
        ))}
      </div>
      <P><b>Loop</b> states re-check every frame and yield the instant their condition drops. <b>One-shot</b> states latch until the anim ends. <b>Hold on Finish</b> makes a one-shot freeze on the last frame instead of releasing (death poses). The <b>exit</b> anim delays the switch until it finishes (landing thumps, attack recovery).</P>

      <H2>Combo — chain anims on re-entry</H2>
      <P>Instead of one animation, a state can cycle a <b>list</b> on each re-entry: <Code>attack1 → attack2 → attack3</Code>. Set the combo steps (each row = an anim + optional frame range + a signal). Turn on <b>random</b> for weighted-random picks (with no-repeat). The <b>combo window</b> controls how long after the anim you can chain the next hit.</P>

      <H2>Frame Signals — fire on a specific frame</H2>
      <P>Emit a signal on an <b>exact frame</b> of the state's animation — e.g. on the hurt anim's impact frame. Wire <Code>On Signal → Camera Shake</Code>, or set <b>Emit to</b> a tag to fan it out to other objects (like <Code>Emit Signal To</Code>). Add as many as you want.</P>

      <H2>Frame Motions — lunge / dash on a frame</H2>
      <P>Push the body on specific frames — <b>forward-relative and facing-aware</b>. Classic use: an attack that <b>lunges</b> at frames 4 / 10 / 24. Each row has a frame, a <b>dx/dy</b> (a number OR an expression like <Code>random(40,80)</Code>), <b>instant</b> or <b>tween</b> with a duration, and <b>skip if blocked</b> so a lunge won't clip through a wall.</P>

      <H2>Advanced toggles</H2>
      <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden", margin: "12px 0" }}>
        {toggles.map(([name, desc], i) => (
          <div key={name} style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12, padding: "9px 12px", background: i % 2 ? "rgba(255,255,255,0.02)" : "transparent", borderTop: i ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
            <div style={{ fontWeight: 700, color: "#cdd6e6", fontSize: 12.5 }}>{name}</div>
            <div style={{ fontSize: 12.5, color: "#aab3c2" }}>{desc}</div>
          </div>
        ))}
      </div>

      <H2>FX Slots</H2>
      <P>A placeholder section for wiring per-state FX / SFX (sounds, particles) to a state's lifecycle. Not active yet — it's the slot where that lands.</P>

      <H2>The buttons at the bottom</H2>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "4px 0" }}><b>+ Add State</b> — a new blank state row.</li>
        <li style={{ margin: "4px 0" }}><b>+ Add Missing Defaults</b> — adds any standard states (idle/walk/jump…) you don't have yet, without touching your existing ones.</li>
        <li style={{ margin: "4px 0" }}><b>↺ Reset to Defaults</b> — replace the whole machine with the template starter set.</li>
      </ul>

      <H2>Reading state from logic</H2>
      <P>In the Logic Sheet, use <Code>State Machine state ==</Code> (condition) or the <Code>On State Enter</Code> / <Code>On State Main</Code> / <Code>On State Exit</Code> triggers — e.g. <i>On State Enter "attack" → enable hitbox</i>, <i>On State Exit "attack" → disable it</i>.</P>
      <Callout tone="warn">Same priority + both true → the one higher in the list wins. If a state "never plays", a higher-priority state above it is probably always matching.</Callout>
    </DocScroll>
  );
}

/** Placeholder for tabs whose content we'll fill in next. */
function ComingSoon({ title }: { title: string }) {
  return (
    <div style={{ padding: 50, textAlign: "center", color: "#8b93a6" }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#cdd6e6", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13 }}>Documentation for this section is coming next.</div>
    </div>
  );
}

export function Documentation({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<DocTab>("nodes");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#0b0d12", display: "flex", flexDirection: "column", color: "#e8ecf5" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderBottom: "1px solid rgba(255,255,255,0.1)", background: "#11141c" }}>
        <span style={{ fontSize: 15, fontWeight: 700, whiteSpace: "nowrap" }}>📖 Documentation</span>
        <div style={{ display: "flex", gap: 4, flex: 1, flexWrap: "wrap" }}>
          {DOC_TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  fontSize: 12, padding: "5px 12px", cursor: "pointer", borderRadius: 5,
                  background: active ? "#3a82e8" : "rgba(255,255,255,0.06)",
                  color: active ? "#fff" : "#aeb6c6",
                  border: `1px solid ${active ? "#3a82e8" : "rgba(255,255,255,0.14)"}`,
                  fontWeight: active ? 700 : 500,
                }}
              >{t.label}</button>
            );
          })}
        </div>
        <button onClick={onClose} style={{ fontSize: 12, padding: "6px 14px", cursor: "pointer", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 5, color: "#fff", whiteSpace: "nowrap" }}>✕ Close</button>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        {tab === "nodes" ? <NodesDoc />
          : tab === "stateMachine" ? <StateMachineDoc />
          : <ComingSoon title={DOC_TABS.find((t) => t.id === tab)!.label} />}
      </div>
    </div>
  );
}
