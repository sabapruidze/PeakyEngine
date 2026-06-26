import { useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { PALETTE, nodeShape, PIN_COLORS, HIDDEN_FROM_PICKER, HIDDEN_CONDITIONS } from "./inspector/LogicSheet/LogicGraphCanvas";
import { triggerTheme, actionComponent, conditionComponent, flowTheme, type ComponentTheme } from "./inspector/LogicSheet/nodeRegistry";
import { nodeDescription, nodeExample } from "./inspector/LogicSheet/nodeDocs";
import { BEHAVIOR_PARAMS, type BehaviorParamMeta } from "../behaviorMeta";
import { COMPONENT_DOCS } from "./componentDocs";
import { ComponentIcon, hasComponentIcon } from "../componentIcons";
import { ParamField, KnockbackTriple } from "./inspector/BlueprintInspector";
import { useEditor } from "../store";
import type { LogicGraphNode, BehaviorKind } from "../project";

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
  // Every node is grouped by its colored component label.
  const groups = useMemo(() => {
    const match = (e: Entry) => !q || e.label.toLowerCase().includes(q) || e.type.toLowerCase().includes(q) || nodeDescription(e.type).toLowerCase().includes(q);
    const byComp = new Map<string, Entry[]>();
    // A node can sit in several picker categories (e.g. a MoveTo setter shows
    // under both Actions and MoveTo). Grouping by component would funnel them
    // into ONE bucket and render duplicated — dedup by kind:type.
    const seen = new Set<string>();
    for (const g of PALETTE) for (const e of g.entries as Entry[]) {
      if (!visible(e) || !match(e)) continue;
      const key = `${e.kind}:${e.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = byComp.get(themeFor(e).label);
      if (arr) arr.push(e); else byComp.set(themeFor(e).label, [e]);
    }
    return [...byComp.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([title, entries]) => ({ title, entries, color: themeFor(entries[0]).chipBg }));
  }, [q]);
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
        {(() => { const anyOpen = groups.some((g) => !collapsed.has(g.title)); return (
          <button style={btn} onClick={() => setCollapsed(anyOpen ? new Set(groups.map((g) => g.title)) : new Set())}>{anyOpen ? "Collapse all" : "Expand all"}</button>
        ); })()}
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
                    <div key={`${e.kind}:${e.type}`} style={{ display: "flex", gap: 18, alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.025)", borderRadius: 8 }}>
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
  { id: "logicSheet", label: "Logic Sheet" },
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

      <H2>"None" — manual-only states</H2>
      <P>At the very top of the condition picker is <b>None (manual only)</b>. Pick it when a state should <b>not decide its own activation</b> — it never matches on its own, so it stays out of the priority race and only turns on when you <b>drive it from elsewhere</b>:</P>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "4px 0" }}>the Logic Sheet's <Code>Set State</Code> node,</li>
        <li style={{ margin: "4px 0" }}>a nav waypoint's <b>set state on arrive</b> (e.g. an NPC plays <i>eat</i> / <i>sleep</i> when it reaches a point),</li>
        <li style={{ margin: "4px 0" }}>or any other <b>forced-state</b> source.</li>
      </ul>
      <P>Use it for cutscene poses, scripted one-off reactions, or nav-driven states you want to trigger <i>explicitly</i> rather than have compete with idle/walk/etc. every frame. (Under the hood a "None" condition simply never evaluates true.)</P>
      <Callout tone="tip">Prefer <b>None</b> over a fake never-true condition (like <Code>1 == 0</Code>) — it reads clearly as "this state is driven by logic", and it won't accidentally start matching if you tweak a variable.</Callout>

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

// Reserved/auto-attached behaviors that aren't in the + Component menu, so they
// don't belong in this list (Camera is auto on Camera BPs; StateMachine has its
// own doc tab; UIWidgetRenderer is internal — authors use the Widget component).
const RESERVED_COMPONENTS = new Set<BehaviorKind>(["Camera", "StateMachine", "UIWidgetRenderer"]);
// Mirror BlueprintComponents' colorForBehavior so the colored-cube fallback in
// the doc chip matches the real panel for components without an SVG icon.
function chipColor(kind: BehaviorKind): string {
  switch (kind) {
    case "CharacterMovement": return "#4ad17a";
    case "Collider":          return "#4ab1d1";
    case "SpriteRenderer":    return "#d18a4a";
    case "Solid":             return "#7e7eaa";
    default:                  return "#888";
  }
}

/** A faithful copy of the component chip as it appears in the + Component panel
 *  (real icon or colored-cube fallback + the kind name), for the docs. */
function ComponentChip({ kind }: { kind: BehaviorKind }) {
  return (
    <div title="How it looks in the Components panel" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 4, fontSize: 11, color: "#dfe4ee", whiteSpace: "nowrap" }}>
      {hasComponentIcon(kind)
        ? <ComponentIcon kind={kind} size={14} style={{ flex: "0 0 auto" }} />
        : <span style={{ width: 12, height: 12, background: chipColor(kind), border: "1px solid rgba(0,0,0,0.4)", borderRadius: 2, flex: "0 0 auto" }} />}
      <span>{kind}</span>
    </div>
  );
}

/** The whole component's parameter window, rendered by the REAL inspector
 *  `ParamField` (same code + same CSS as the live panel, so it's pixel-identical)
 *  with each field annotated by its plain-English description on the right. */
function ComponentPanelMock({ kind, params, descs }: { kind: BehaviorKind; params: BehaviorParamMeta[]; descs?: Record<string, string> }) {
  const sprites = useEditor((s) => s.project.sprites);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const inputActions = useEditor((s) => s.project.inputActions);
  return (
    <div style={{ marginTop: 12, background: "#171b24", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.11)", background: "#20252f" }}>
        <span style={{ color: "#e8b51f", fontWeight: 600, fontSize: 12.5 }}>{kind}</span>
        <span style={{ color: "#757d8a", fontSize: 11, letterSpacing: 2 }}>⚙ ✕</span>
      </div>
      <div style={{ padding: "4px 0" }}>
        {params.map((p, i) => {
          const soon = !!p.comingSoon;
          const desc = soon ? `🔒 ${p.comingSoon}` : (descs?.[p.key] ?? p.label);
          const isKnockTriple = kind === "Damageable" && p.key === "knockbackMultiplier";
          return (
            <div key={p.key + i} style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 18, alignItems: "center", padding: "1px 6px", background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent", opacity: soon ? 0.5 : 1 }}>
              {/* The actual inspector field — non-interactive in the doc. */}
              <div style={{ pointerEvents: "none", width: 320 }}>
                {isKnockTriple ? (
                  <KnockbackTriple cfg={{}} onUpdate={() => {}} />
                ) : (
                  <ParamField
                    paramKey={p.key}
                    label={p.label}
                    type={p.type}
                    options={p.options}
                    value={p.default}
                    sprites={sprites}
                    currentSpriteId=""
                    uiWidgets={uiWidgets}
                    inputActions={inputActions}
                    onChange={() => {}}
                  />
                )}
              </div>
              <div style={{ fontSize: 12.5, color: soon ? "#9a8a6a" : "#aab3c2", lineHeight: 1.45 }}>{desc}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The Components tab — every Blueprint component + its parameters, in plain
 *  English. Field ROWS come straight from BEHAVIOR_PARAMS so the doc tracks the
 *  real inspector; prose comes from COMPONENT_DOCS (label is the fallback). */
function ComponentsDoc() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const kinds = useMemo(
    () => (Object.keys(BEHAVIOR_PARAMS) as BehaviorKind[]).filter((k) => !RESERVED_COMPONENTS.has(k)),
    [],
  );
  const docFor = (k: BehaviorKind) => COMPONENT_DOCS[k];
  const matches = (k: BehaviorKind) => {
    if (!q) return true;
    const d = docFor(k);
    if (k.toLowerCase().includes(q) || (d?.title ?? "").toLowerCase().includes(q) || (d?.blurb ?? "").toLowerCase().includes(q)) return true;
    return (BEHAVIOR_PARAMS[k] ?? []).some((p) => p.label.toLowerCase().includes(q) || (d?.params[p.key] ?? "").toLowerCase().includes(q));
  };
  const groups = useMemo(() => {
    const byGroup = new Map<string, BehaviorKind[]>();
    for (const k of kinds) {
      if (!matches(k)) continue;
      const g = docFor(k)?.group ?? "Misc";
      const arr = byGroup.get(g); if (arr) arr.push(k); else byGroup.set(g, [k]);
    }
    return [...byGroup.entries()].map(([title, ks]) => ({
      title,
      ks: ks.sort((a, b) => (docFor(a)?.title ?? a).localeCompare(docFor(b)?.title ?? b)),
    }));
  }, [q]);
  const shown = groups.reduce((n, g) => n + g.ks.length, 0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const cbtn = { fontSize: 11, padding: "5px 10px", cursor: "pointer", borderRadius: 5, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "#cdd6e6" } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search components & parameters…"
          style={{ flex: 1, maxWidth: 420, fontSize: 12, padding: "6px 10px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 5, color: "#fff" }}
        />
        {(() => { const anyOpen = kinds.some((k) => expanded.has(k)); return (
          <button style={cbtn} onClick={() => setExpanded(anyOpen ? new Set() : new Set(kinds))}>{anyOpen ? "Collapse all" : "Expand all"}</button>
        ); })()}
        <span style={{ fontSize: 11, color: "#8b93a6" }}>{shown} / {kinds.length} components</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px 60px", maxWidth: 980, margin: "0 auto", width: "100%" }}>
        {groups.map((g) => (
          <div key={g.title} style={{ marginTop: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "#9fb0d0", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 5, marginBottom: 12 }}>{g.title}</div>
            {g.ks.map((k) => {
              const d = docFor(k);
              const params = BEHAVIOR_PARAMS[k] ?? [];
              const open = expanded.has(k) || !!q;
              return (
                <div key={k} style={{ marginBottom: 10, background: "rgba(255,255,255,0.025)", borderRadius: 10, padding: "10px 14px" }}>
                  <div onClick={() => toggle(k)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, color: "#8b93a6", width: 10, flex: "0 0 auto" }}>{open ? "▾" : "▸"}</span>
                    <ComponentChip kind={k} />
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{d?.title ?? k}</span>
                    <code style={{ fontSize: 11, color: "#7f8aa3" }}>{k}</code>
                    <span style={{ marginLeft: "auto", fontSize: 10.5, color: "#6b7488" }}>{params.length === 0 ? "no settings" : `${params.length} field${params.length === 1 ? "" : "s"}`}</span>
                  </div>
                  {open && (
                    <>
                      {d?.blurb && <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55, color: "#d4dae6" }}>{d.blurb}</div>}
                      {d?.when && <div style={{ marginTop: 5, fontSize: 12.5, color: "#9aa6ba", fontStyle: "italic" }}>When to use: {d.when}</div>}
                      {d?.tip && <div style={{ marginTop: 8, background: "rgba(95,174,116,0.12)", borderLeft: "3px solid #5fae74", borderRadius: 6, padding: "8px 12px", fontSize: 12.5, color: "#cfe6d6" }}>💡 {d.tip}</div>}
                      {params.length === 0 ? (
                        <div style={{ marginTop: 10, fontSize: 12, color: "#7f8aa3", fontStyle: "italic" }}>No settings — just attach it.</div>
                      ) : (
                        <ComponentPanelMock kind={k} params={params} descs={d?.params} />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {shown === 0 && <div style={{ marginTop: 40, textAlign: "center", color: "#7f8aa3" }}>No components match “{query}”.</div>}
      </div>
    </div>
  );
}

// ── Shared doc helpers for the Items & UI tabs ─────────────────────────────
const hx = (n: number) => "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);

/** A simple 2/3-column reference table matching the State Machine doc style. */
function DocTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const cols = head.map((_, i) => (i === 0 ? "minmax(150px,200px)" : i === head.length - 1 ? "2fr" : "1.2fr")).join(" ");
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden", margin: "12px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, background: "rgba(255,255,255,0.04)", color: "#8b93a6", fontSize: 9.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {head.map((h, i) => <div key={i} style={{ padding: "6px 10px" }}>{h}</div>)}
      </div>
      {rows.map((r, ri) => (
        <div key={ri} style={{ display: "grid", gridTemplateColumns: cols, borderTop: "1px solid rgba(255,255,255,0.05)", background: ri % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
          {r.map((c, ci) => <div key={ci} style={{ padding: "7px 10px", fontSize: 12, color: ci === 0 ? "#cdd6e6" : "#aab3c2", fontWeight: ci === 0 ? 700 : 400, lineHeight: 1.45 }}>{c}</div>)}
        </div>
      ))}
    </div>
  );
}

/** Content-Browser asset tile (blue IT for items, orange RE for recipes). */
function AssetTile({ badge, color, name, swatch }: { badge: string; color: string; name: string; swatch?: ReactNode }) {
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", width: 92, background: "#171b24", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ height: 60, background: "#0f131b", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        <span style={{ position: "absolute", top: 4, left: 4, fontSize: 8, fontWeight: 800, color: "#fff", background: color, padding: "1px 4px", borderRadius: 3, letterSpacing: 0.5 }}>{badge}</span>
        {swatch ?? <span style={{ width: 28, height: 28, background: "#2a3140", borderRadius: 4 }} />}
      </div>
      <div style={{ padding: "4px 6px", fontSize: 10.5, color: "#cdd6e6", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
    </div>
  );
}

// Faithful inspector-style field row used by the Item / Recipe mock panels.
function MField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, alignItems: "center", padding: "4px 12px" }}>
      <label style={{ color: "#939bab", fontSize: 11 }}>{label}</label>
      <div>{children}</div>
    </div>
  );
}
const mInput = (txt: string, faint = false): CSSProperties => ({ background: "#0f131b", color: faint ? "#565d68" : "#e6e9f0", border: "1px solid rgba(255,255,255,0.11)", padding: "5px 8px", fontSize: 12 });
function MBox({ children, faint }: { children: ReactNode; faint?: boolean }) { return <div style={mInput(String(children), faint)}>{children}</div>; }
function MSelect({ children }: { children: ReactNode }) {
  return <div style={{ ...mInput(""), display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>{children}</span><span style={{ color: "#757d8a", fontSize: 9 }}>▾</span></div>;
}
function MToggle({ on }: { on: boolean }) {
  return (
    <span style={{ display: "inline-block", position: "relative", width: 30, height: 17, borderRadius: 9, border: `1px solid ${on ? "#e8b51f" : "rgba(255,255,255,0.25)"}`, background: on ? "#e8b51f" : "rgba(255,255,255,0.12)" }}>
      <span style={{ position: "absolute", top: 1, left: on ? 15 : 1, width: 13, height: 13, borderRadius: "50%", background: on ? "#fff" : "rgba(255,255,255,0.55)" }} />
    </span>
  );
}
function MockPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ width: 320, background: "#171b24", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.11)", background: "#20252f", color: "#e8b51f", fontWeight: 600, fontSize: 12.5 }}>{title}</div>
      <div style={{ padding: "6px 0" }}>{children}</div>
    </div>
  );
}

function ItemsDoc() {
  return (
    <DocScroll>
      <H1>Items &amp; Recipes</H1>
      <P>Two kinds of project asset, both made in the <b>Content Browser</b>. An <b>Item</b> is a thing the player can own or carry (Gold, Meat, a Sword). A <b>Recipe</b> turns some items into another item (2 Wood → 1 Plank). You design them once as assets, then your logic and UI widgets reference them <b>by name</b>.</P>

      <H2>The Item asset</H2>
      <P>Double-click an item in the Content Browser to open its editor. Every field:</P>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", margin: "12px 0" }}>
        <AssetTile badge="IT" color="#3f86e6" name="Gold" swatch={<span style={{ width: 26, height: 26, borderRadius: 13, background: "#e8b51f" }} />} />
        <MockPanel title="Item — Gold">
          <MField label="Name"><MBox>Gold</MBox></MField>
          <MField label="Icon (sprite)"><MSelect>coin_sprite</MSelect></MField>
          <MField label="Icon frame"><MBox>0</MBox></MField>
          <MField label="Max stack"><MBox>999</MBox></MField>
          <MField label="Track count"><MToggle on /></MField>
          <MField label="Buy price"><MBox>0</MBox></MField>
          <MField label="Sell price"><MBox>0</MBox></MField>
          <MField label="Tags"><MBox faint>currency</MBox></MField>
        </MockPanel>
      </div>
      <DocTable head={["Field", "What it does"]} rows={[
        ["Name", <>The item's name. Everything references it by this string — <Code>GiveItem "Gold"</Code>, recipes, widgets. Renaming cascades everywhere.</>],
        ["Icon (sprite)", "The sprite asset used as the item's picture in inventories, shops, and pickups."],
        ["Icon frame / Animate", <>Show one still frame (a number) or animate the icon (set to <Code>-1</Code>).</>],
        ["Max stack", <>How many fit in one inventory slot. <Code>1</Code> = never stacks; <Code>999</Code> = big stacks like coins.</>],
        ["Track count (countGlobal)", <>When on, the item also lives as a persistent global you can read with <Code>global:Gold</Code> — perfect for a HUD coin counter that survives scene changes.</>],
        ["Buy / Sell price", <>Used by Shop widgets and the <Code>BuyItem</Code> / <Code>SellItem</Code> actions. <Code>0</Code> = not buyable / not sellable.</>],
        ["Tags", "Free labels for grouping (e.g. \"weapon\", \"food\") — handy for filtering."],
        ["Custom properties", <>Your own per-item data (e.g. <Code>damage = 10</Code>, <Code>healing = 25</Code>). Read at runtime with <Code>GetItemProp</Code>.</>],
      ]} />

      <H2>The Recipe asset</H2>
      <P>A recipe lists the <b>inputs</b> it eats and the single <b>output</b> it produces.</P>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", margin: "12px 0" }}>
        <AssetTile badge="RE" color="#e07b2e" name="Plank" />
        <MockPanel title="Recipe — Plank">
          <MField label="Name"><MBox>Plank</MBox></MField>
          <MField label="Enabled"><MToggle on /></MField>
          <div style={{ padding: "4px 12px", color: "#8b93a6", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>Inputs (consumed)</div>
          <MField label="Input 1"><div style={{ display: "flex", gap: 6 }}><div style={{ flex: 1 }}><MSelect>Wood</MSelect></div><div style={{ width: 60 }}><MBox>2</MBox></div></div></MField>
          <div style={{ padding: "4px 12px", color: "#8b93a6", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>Output</div>
          <MField label="Produces"><div style={{ display: "flex", gap: 6 }}><div style={{ flex: 1 }}><MSelect>Plank</MSelect></div><div style={{ width: 60 }}><MBox>1</MBox></div></div></MField>
        </MockPanel>
      </div>
      <DocTable head={["Field", "What it does"]} rows={[
        ["Name", <>The recipe's name. Referenced by recipe actions and the Crafting widget.</>],
        ["Enabled", <>A runtime gate. Turn it off to lock a recipe (e.g. until a quest is done) with <Code>SetRecipeEnabled</Code>. Disabled recipes can't be crafted.</>],
        ["Inputs", "The items (and quantities) eaten when you craft. Add as many as you want."],
        ["Output", "The single item (and quantity) produced."],
      ]} />

      <H2>Two ways to hold items</H2>
      <P>Pick whichever fits — they're independent:</P>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "6px 0" }}><b>Count globals (simplest).</b> Just a number per item, no slots. Turn on <b>Track count</b> on the item, then <Code>GiveItem</Code> / <Code>TakeItem</Code> change it and you read it anywhere with <Code>global:Gold</Code>. Great for currency, score, keys.</li>
        <li style={{ margin: "6px 0" }}><b>The Inventory component (slots).</b> Add the <Code>Inventory</Code> component to a Blueprint for a real bag with a slot count, stacking, and drag/drop in an Inventory widget. Use <Code>AddItem</Code> / <Code>RemoveItem</Code> and the <Code>HasItem</Code> condition.</li>
      </ul>
      <Callout tone="tip">Give the <b>player's</b> Inventory a <b>Persist Key</b> (e.g. <Code>player</Code>) so the bag carries across scenes. Leave it empty on chests/NPCs so each keeps its own.</Callout>

      <H2>Nodes that control items</H2>
      <DocTable head={["Node", "Type", "What it does"]} rows={[
        [<Code>GiveItem</Code>, "Action", <>Add N to an item's count global (<Code>global:&lt;item&gt;</Code>). Persists across scenes.</>],
        [<Code>TakeItem</Code>, "Action", "Subtract N from an item's count global (won't go below 0)."],
        [<Code>AddItem</Code>, "Action", <>Put N of an item into this object's <b>Inventory</b> — stacks first, then fills empty slots. Fires <Code>OnItemAdded</Code> / <Code>OnInventoryFull</Code>.</>],
        [<Code>RemoveItem</Code>, "Action", <>Take up to N of an item out of this object's Inventory. Fires <Code>OnItemRemoved</Code>.</>],
        [<Code>GiveItemTo</Code>, "Action", "Add N of an item to ANOTHER object's Inventory (by tag/name) — pickups, loot, trades."],
        [<Code>ClearInventory</Code>, "Action", "Empty every slot of this object's Inventory."],
        [<Code>GetItemCount</Code>, "Action", "Read how many of an item you have into a variable (from the Inventory, or the count global)."],
        [<Code>GetItemProp</Code>, "Action", <>Read one of an item's custom properties (e.g. <Code>damage</Code>) into a variable.</>],
        [<Code>HasItem</Code>, "Condition", <>True while this object's Inventory holds ≥ N of an item — e.g. gate a door on <Code>HasItem "Key"</Code>.</>],
        [<Code>InventoryIsFull</Code>, "Condition", "True when no empty slots remain."],
      ]} />
      <Callout>Read a count anywhere in an expression with <Code>global:Gold</Code> — e.g. a Label's text <Code>{"{global:Gold}"}</Code>, or a condition <Code>global:Gold &gt;= 100</Code>.</Callout>

      <H2>Crafting</H2>
      <P>Crafting is driven by the <b>Crafting</b> and <b>CraftGrid</b> UI widgets (see the UI tab) — they show recipes, check ingredients, and craft when clicked, emitting <Code>signalOnCraftClick</Code> / <Code>signalOnCraft</Code> that you catch with <Code>OnSignal</Code>. These nodes reshape recipes at runtime:</P>
      <DocTable head={["Node", "Type", "What it does"]} rows={[
        [<Code>SetRecipeEnabled</Code>, "Action", "Lock or unlock a recipe (quest-gating, tech trees)."],
        [<Code>AddRecipeIngredient</Code>, "Action", "Add a required input to a recipe at runtime (upgrades)."],
        [<Code>RemoveRecipeIngredient</Code>, "Action", "Remove a required input from a recipe."],
        [<Code>SetRecipeOutput</Code>, "Action", "Change what a recipe produces (and how many) — recipe tier-ups."],
      ]} />

      <H2>Shops</H2>
      <P>The <b>Shop</b> widget sells/buys items using their Buy/Sell price and a currency global. From logic:</P>
      <DocTable head={["Node", "Type", "What it does"]} rows={[
        [<Code>BuyItem</Code>, "Action", "Pay from a money global and give the item (uses the item's Buy price)."],
        [<Code>SellItem</Code>, "Action", "Take the item and pay into a money global (uses the item's Sell price)."],
        [<Code>RestockShop</Code>, "Action", "Refill a Shop widget's stock back to its configured amounts."],
      ]} />
    </DocScroll>
  );
}

// ── UI widget visual mockups (exact default colors from the runtime) ────────
function WidgetMock({ kind }: { kind: string }) {
  const slotGrid = (cols: number, rows: number, tintLast = false, sel = false) => (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 26px)`, gap: 4, padding: 6, background: hx(0x1a1d23), border: `1px solid ${hx(0x404552)}`, borderRadius: 3 }}>
      {Array.from({ length: cols * rows }).map((_, i) => (
        <span key={i} style={{ width: 26, height: 26, background: hx(0x222831), border: `${sel && i === 0 ? 2 : 1}px solid ${sel && i === 0 ? hx(0xffd23c) : hx(0x404552)}`, opacity: tintLast && i === cols * rows - 1 ? 0.4 : 1 }} />
      ))}
    </div>
  );
  switch (kind) {
    case "Panel": return <div style={{ width: 150, height: 70, background: hx(0x222831), opacity: 0.92, border: `1px solid ${hx(0x404552)}`, borderRadius: 6 }} />;
    case "Label": return <div style={{ color: "#fff", fontSize: 16, fontWeight: 600 }}>Label</div>;
    case "Button": return <div style={{ display: "inline-block", background: hx(0x2d82d4), border: `1px solid ${hx(0x4aa8ff)}`, color: "#fff", fontSize: 14, padding: "8px 18px", borderRadius: 4 }}>Button</div>;
    case "Slider": return <div style={{ width: 150, height: 16, background: hx(0x222831), border: `1px solid ${hx(0x404552)}`, borderRadius: 8, position: "relative" }}><div style={{ position: "absolute", inset: 1, width: "50%", background: hx(0x44ddff), borderRadius: 8 }} /><span style={{ position: "absolute", left: "50%", top: -3, width: 12, height: 22, marginLeft: -6, background: "#fff", borderRadius: 3 }} /></div>;
    case "ProgressBar": return <div style={{ width: 150, height: 16, background: hx(0x222831), border: `1px solid ${hx(0x404552)}`, borderRadius: 8, position: "relative" }}><div style={{ position: "absolute", inset: 1, width: "65%", background: hx(0x44ddff), borderRadius: 8 }} /></div>;
    case "Dropdown": return <div style={{ display: "inline-flex", justifyContent: "space-between", alignItems: "center", gap: 16, minWidth: 110, background: hx(0x2d82d4), border: `1px solid ${hx(0x4aa8ff)}`, color: "#fff", fontSize: 13, padding: "7px 12px", borderRadius: 4 }}><span>Pick…</span><span>▾</span></div>;
    case "Image": return <div style={{ width: 60, height: 60, background: "#0f131b", border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "#565d68", fontSize: 10 }}>sprite</div>;
    case "Inventory": return slotGrid(5, 1);
    case "Crafting": return slotGrid(5, 1, true);
    case "Shop": return slotGrid(4, 2, false, true);
    case "CraftGrid": return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{slotGrid(2, 2)}<span style={{ color: "#757d8a", fontSize: 18 }}>→</span><span style={{ width: 26, height: 26, background: hx(0x222831), border: `1px solid ${hx(0x404552)}` }} /></div>
    );
    default: return null;
  }
}

const WIDGET_GALLERY: { kind: string; blurb: string; fields: string }[] = [
  { kind: "Panel", blurb: "A container frame — the backing box for a HUD group or menu. In multi mode it holds child elements.", fields: "bg color/alpha, border, corner radius, shadow, padding, layout (row/column) for children" },
  { kind: "Label", blurb: "Static or live text. Put {var:hp} / {global:Gold} placeholders in the text and they update every frame.", fields: "text, font family/size/color, bold, italic, align, vAlign" },
  { kind: "Button", blurb: "A clickable button. Emits a signal you catch with On Signal to run logic.", fields: "text, signalOnClick, hover color, pressed color, click mode (single/double)" },
  { kind: "Slider", blurb: "A draggable value bar (volume, settings). Emits signalOnChange as you drag.", fields: "min, max, value, direction, fill color, signalOnChange, readOnly" },
  { kind: "ProgressBar", blurb: "A read-only fill bar — health, XP, loading. Bind value to var:hp / maxHp for a live healthbar.", fields: "min, max, value (literal or expression), direction, fill color" },
  { kind: "Dropdown", blurb: "A pick-one menu. Each option can carry its own signal; the whole thing emits signalOnSelect.", fields: "options[], selectedValue, signalOnSelect" },
  { kind: "Image", blurb: "Shows a sprite frame — a portrait, an icon, a logo.", fields: "spriteId" },
  { kind: "Inventory", blurb: "A live grid of a character's item slots, with drag/drop. Mirrors the target's Inventory component.", fields: "rows, cols, slotSize, targetBp, signalOnSlotClick/DoubleClick, slotsDraggable" },
  { kind: "Crafting", blurb: "A grid of recipes; ones you can't afford are tinted. Click a craftable recipe to make it.", fields: "rows, cols, uncraftableTint, signalOnCraftClick" },
  { kind: "CraftGrid", blurb: "An input grid + a result slot — drop ingredients in, take the result out.", fields: "rows, cols, resultGap, craft arrow sprite, signalOnCraft" },
  { kind: "Shop", blurb: "A grid of items for sale/buy at their price, paid in a currency global.", fields: "shopSlots (item + stock), shopRole (buy/sell), currency, selection color" },
];

/** Mock of the Widget editor's Bindings table (Child · Property · Source). */
function BindingsTableMock() {
  const rows = [
    { child: "hpLabel", prop: "Text", src: "var:Player.hp" },
    { child: "hpBar", prop: "Value", src: "var:Player.hp / var:Player.maxHp" },
    { child: "lowHpWarn", prop: "Visible", src: "var:Player.hp < 20" },
  ];
  const COLS = "100px 90px 1fr";
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.16)", borderRadius: 8, overflow: "hidden", margin: "12px 0", background: "#161a24" }}>
      <div style={{ padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.1)", color: "#9fc0ff", fontWeight: 700, fontSize: 12 }}>Bindings</div>
      <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 6, padding: "6px 10px 2px", color: "#8b93a6", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>
        <span>Child</span><span>Property</span><span>Source (var / expr)</span>
      </div>
      {rows.map((r) => (
        <div key={r.child} style={{ display: "grid", gridTemplateColumns: COLS, gap: 6, padding: "3px 10px", alignItems: "center" }}>
          <span style={{ ...mInput(""), fontSize: 11 }}>{r.child}</span>
          <span style={{ ...mInput(""), fontSize: 11, display: "flex", justifyContent: "space-between" }}>{r.prop}<span style={{ color: "#757d8a" }}>▾</span></span>
          <span style={{ ...mInput(""), fontSize: 11, color: "#ffd98a" }}>{r.src}</span>
        </div>
      ))}
      <div style={{ padding: "6px 10px", color: "#5fae74", fontSize: 11 }}>+ Add Binding</div>
    </div>
  );
}

function UIDoc() {
  return (
    <DocScroll>
      <H1>UI &amp; Widgets</H1>
      <P>UI widgets are screen-space elements — HUDs, menus, buttons, healthbars, inventories. You build them in the <b>UI Widget</b> editor, place them on a scene's UI layer (or pin one above a character with the <Code>Widget</Code> component), and they render on a dedicated <b>UI camera</b> that's locked to the screen, so they never scroll with the world.</P>
      <Callout>A widget is either <b>single</b> mode (the widget IS one element) or <b>multi</b> mode (a canvas holding many child elements — a whole menu in one asset).</Callout>

      <H2>The elements</H2>
      <P>Every widget kind, how it looks with its default styling, and its key fields:</P>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" }}>
        {WIDGET_GALLERY.map((w) => (
          <div key={w.kind} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 16, alignItems: "center", padding: "12px 14px", background: "rgba(255,255,255,0.025)", borderRadius: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 60 }}><WidgetMock kind={w.kind} /></div>
            <div>
              <div style={{ fontWeight: 700, color: "#fff", fontSize: 13.5 }}>{w.kind}</div>
              <div style={{ marginTop: 3, color: "#d0d6e2", fontSize: 12.5, lineHeight: 1.5 }}>{w.blurb}</div>
              <div style={{ marginTop: 4, color: "#8fa0bf", fontSize: 11.5 }}><b style={{ color: "#7f8aa3" }}>Fields:</b> {w.fields}</div>
            </div>
          </div>
        ))}
      </div>

      <H2>Placing a widget</H2>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "6px 0" }}><b>In a scene (HUD / menu):</b> drop the widget onto a UI layer. It sits fixed on screen via the UI camera.</li>
        <li style={{ margin: "6px 0" }}><b>Above a character (healthbar, name):</b> add the <Code>Widget</Code> component to the Blueprint, pick the widget, and set an offset (e.g. Y −40). It follows the host and can <b>Hide When Dead</b>.</li>
      </ul>

      <H2>Showing live data</H2>
      <P>Three ways to make a widget reflect game state:</P>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "6px 0" }}><b>Text placeholders</b> — put <Code>{"{var:hp}"}</Code>, <Code>{"{global:Gold}"}</Code>, <Code>{"{BpName.score}"}</Code> in a Label's text; it re-resolves every frame.</li>
        <li style={{ margin: "6px 0" }}><b>Value expressions</b> — a Slider/ProgressBar's value can be an expression like <Code>var:hp / var:maxHp</Code> for an instant healthbar.</li>
        <li style={{ margin: "6px 0" }}><b>Bindings</b> — the editor's Bindings table wires a property (text / value / visible / bgColor / enabled) to an expression source, declaratively.</li>
      </ul>
      <Callout tone="tip">On a per-character widget, <Code>var:self.hp</Code> reads <i>that</i> instance's own variable — so every enemy's healthbar shows its own HP automatically.</Callout>

      <H2>Binding element values to variables</H2>
      <P>The cleanest way to keep a widget in sync — <b>no nodes</b>. In the Widget editor, the <b>Bindings</b> table (above the Logic Sheet) wires one element's <b>property</b> to a <b>Source</b> expression that's re-read <b>every frame</b>. Change the variable and the element follows automatically.</P>
      <BindingsTableMock />
      <DocTable head={["Property", "Binds…", "Source example"]} rows={[
        ["Text", "A Label / Button / Dropdown's text.", <Code>var:Player.hp</Code>],
        ["Value", "A Slider / ProgressBar's value.", <Code>var:Player.hp / var:Player.maxHp</Code>],
        ["Visible", "Show / hide on a true-false test.", <Code>var:Player.hp &lt; 20</Code>],
        ["Bg Color", "The background color (hex number).", <Code>0xff4242</Code>],
        ["Enabled", "Interactable on/off (greys out a button).", <Code>var:Player.alive</Code>],
      ]} />
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "5px 0" }}>In a <b>multi-mode</b> widget the <b>Child</b> column picks which element the row targets; in <b>single</b> mode it binds the widget itself.</li>
        <li style={{ margin: "5px 0" }}>The Source is any expression — <Code>var:Self.x</Code>, <Code>global:Gold</Code>, math like <Code>var:hp / var:maxHp</Code>.</li>
      </ul>
      <Callout>Bindings vs nodes: a <b>binding</b> means "this element <i>always</i> reflects X" (reactive, every frame). The <Code>SetUIText</Code> / <Code>SetUIValue</Code> nodes mean "change it <i>once</i>, when this event happens". Use bindings for live readouts (healthbars, counters), nodes for one-off changes.</Callout>

      <H2>Inventory, Crafting &amp; Shop — setup</H2>
      <P>These three are <b>live data widgets</b> — they don't store anything themselves; they mirror a real character's <b>Inventory component</b>, your <b>Recipe</b> assets, and item <b>prices</b>. The field that ties each to a character is <b>Character (name/tag)</b> — it matches a <b>Blueprint name</b>, an <b>instance name</b>, or a <b>tag</b> the object carries. Leave it <b>blank</b> to use the host (the object the widget is pinned to via the <Code>Widget</Code> component).</P>

      <div style={{ marginTop: 16, fontWeight: 700, color: "#fff", fontSize: 14 }}>Inventory widget — a live view of one character's bag</div>
      <ol style={{ margin: "6px 0", paddingLeft: 22 }}>
        <li style={{ margin: "5px 0" }}>Add the <Code>Inventory</Code> component to the character's Blueprint (set the slot count; give the <b>player</b> a <b>Persist Key</b> so its bag survives scene changes).</li>
        <li style={{ margin: "5px 0" }}>Set the widget's <b>Character (name/tag)</b> to that Blueprint's name (or a tag it carries). Items show their icon + stack count automatically.</li>
      </ol>
      <DocTable head={["Field", "What it does"]} rows={[
        ["Character (name/tag)", <>Whose bag to show — Blueprint name, instance name, or tag. <b>Blank = the host.</b></>],
        ["On slot click signal", "Optional signal fired when a slot is clicked."],
        ["On double-click signal", <>Fires <b>on the character</b> — wire it to "use / equip the item".</>],
        ["Clicked item → var", "Writes the clicked item's name into a variable on the character (so your logic knows which item)."],
        ["Slots draggable", "Let the player drag items to rearrange (default on)."],
      ]} />

      <div style={{ marginTop: 16, fontWeight: 700, color: "#fff", fontSize: 14 }}>Crafting widget — lists recipes, crafts from a character's bag</div>
      <ol style={{ margin: "6px 0", paddingLeft: 22 }}>
        <li style={{ margin: "5px 0" }}>Make <b>Recipe</b> assets (inputs → output) in the Content Browser.</li>
        <li style={{ margin: "5px 0" }}>Add an <Code>Inventory</Code> to the crafter, and set the widget's <b>Character (name/tag)</b> to it.</li>
        <li style={{ margin: "5px 0" }}>Recipes you can afford show bright; ones missing ingredients get the <b>Uncraftable tint</b>. Click a craftable one → it eats the inputs from that bag and adds the output, and fires <b>On craft click signal</b>.</li>
      </ol>

      <div style={{ marginTop: 16, fontWeight: 700, color: "#fff", fontSize: 14 }}>Shop widget — buy / sell at item prices, paid in a currency global</div>
      <P>Prices live on the <b>Item asset</b> (<b>Buy price</b> / <b>Sell price</b>; <Code>0</Code> = not buyable / not sellable). Two ways to build a shop:</P>
      <ul style={{ margin: "6px 0", paddingLeft: 22 }}>
        <li style={{ margin: "6px 0" }}><b>Shop grid</b> — assign an item per slot with a <b>stock</b> (<Code>-1</Code> = unlimited). Set <b>Money global</b> (default <Code>gold</Code>) and <b>Buy into (character)</b> — whose bag receives purchases. Clicking a slot checks you can afford the item's <b>Buy price</b>, subtracts it from <Code>global:gold</Code>, drops the stock by one, and adds the item to that character's Inventory (or its count global if it has none).</li>
        <li style={{ margin: "6px 0" }}><b>Buy / Sell button</b> — on a Button element set <b>Shop role</b> = Buy or Sell, the item, and the money global, for a hand-designed shop. Buy charges the Buy price; Sell pays the Sell price.</li>
      </ul>
      <Callout tone="tip"><b>Player vs NPC:</b> point <b>Character (name/tag)</b> / <b>Buy into</b> at the <i>player's</i> Blueprint or a <Code>player</Code> tag for the player's bag, or at an <i>NPC's</i> name/tag for that NPC's bag. The currency is a shared global (<Code>global:gold</Code>), so any shop spends the same wallet.</Callout>

      <H2>Nodes that control widgets</H2>
      <DocTable head={["Node", "Type", "What it does"]} rows={[
        [<Code>SetUIText</Code>, "Action", <>Set a Label / Button / Dropdown's text (supports <Code>{"{var}"}</Code> placeholders).</>],
        [<Code>SetUIValue</Code>, "Action", "Set a Slider / ProgressBar's value (literal or expression)."],
        [<Code>SetUISelectedValue</Code>, "Action", "Set a Dropdown's selected option by its value."],
        [<Code>SetUIVisible</Code>, "Action", "Show / hide / toggle a whole widget (hidden = no render and no input)."],
        [<Code>SetUIBgColor</Code>, "Action", "Change a widget's background color."],
        [<Code>SetUIElement</Code>, "Action", "The universal setter — pick any element and toggle exactly which properties to change (text, value, enabled, opacity, sprite, …)."],
        [<Code>CreateUIWidget</Code>, "Action", "Spawn a widget at runtime at an x/y (and optional layer)."],
        [<Code>DestroyUIWidget</Code>, "Action", "Destroy every widget instance matching a name."],
      ]} />

      <H2>Reacting to clicks &amp; changes</H2>
      <P>Widgets don't run logic themselves — they <b>emit signals</b>, and you catch them with the <Code>OnSignal</Code> trigger. Wire <i>On Signal "onStartClicked" → Go To Layout</i>.</P>
      <DocTable head={["Widget", "Emits", "When"]} rows={[
        ["Button", <Code>signalOnClick</Code>, "Clicked (also signalOnHover / signalOnLeave)."],
        ["Slider", <Code>signalOnChange</Code>, "Dragged to a new value."],
        ["Dropdown", <Code>signalOnSelect</Code>, "An option is picked (each option can also carry its own signal)."],
        ["Inventory", <Code>signalOnSlotClick</Code>, "A slot is clicked / double-clicked (signalOnSlotDoubleClick)."],
        ["Crafting", <Code>signalOnCraftClick</Code>, "A craftable recipe is clicked."],
        ["CraftGrid", <Code>signalOnCraft</Code>, "The crafted result is taken out."],
      ]} />
      <Callout>For a widget made of many child elements (multi mode), a child's signal fires on <b>both</b> the child and the parent widget — so the parent's Logic Sheet can handle every button in one place.</Callout>
    </DocScroll>
  );
}

// ── Logic Sheet visual mockups ──────────────────────────────────────────────
function FlowNodeMock({ label, sub, color }: { label: string; sub?: string; color: string }) {
  return (
    <div style={{ minWidth: 96, background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 6, overflow: "hidden", fontSize: 11, flex: "0 0 auto" }}>
      <div style={{ background: color, color: "#06121f", fontWeight: 700, padding: "3px 9px", fontSize: 10 }}>{label}</div>
      {sub && <div style={{ padding: "6px 9px", color: "#cfd6e6", whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}
const flowArrow = (k?: string | number) => <span key={k} style={{ color: "#7f8aa3", fontSize: 16, flex: "0 0 auto" }}>▶</span>;

function ExecChainMock() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "14px 0", padding: "14px", background: "#13161e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
      <FlowNodeMock label="TRIGGER" sub="On Key Pressed · Jump" color="#e0a14a" />
      {flowArrow()}
      <FlowNodeMock label="BRANCH" sub="Is Grounded?" color="#8270f0" />
      {flowArrow()}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <FlowNodeMock label="▸ TRUE · ACTION" sub="Play 'jump'" color="#3fc66e" />
        <FlowNodeMock label="▸ TRUE · ACTION" sub="CM Jump" color="#3fc66e" />
      </div>
    </div>
  );
}

function GroupsMock() {
  const tabs: [string, boolean][] = [["Combat", true], ["Patrol", false], ["Pickups", true]];
  return (
    <div style={{ display: "flex", gap: 6, margin: "12px 0", flexWrap: "wrap" }}>
      {tabs.map(([n, on]) => (
        <div key={n} style={{ padding: "6px 14px", borderRadius: "6px 6px 0 0", background: on ? "#20252f" : "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderBottom: on ? "2px solid #5eb3ff" : "1px solid rgba(255,255,255,0.12)", color: on ? "#e6e9f0" : "#6b7488", fontSize: 12.5, fontWeight: on ? 600 : 400 }}>
          📁 {n}{!on && <span style={{ fontSize: 10, marginLeft: 4 }}>(off)</span>}
        </div>
      ))}
    </div>
  );
}

function LogicSheetDoc() {
  return (
    <DocScroll>
      <H1>Logic Sheets</H1>
      <P>A <b>Logic Sheet</b> is where you wire game logic visually. You start from a <b>trigger</b> (something happens), optionally check <b>conditions</b>, then run <b>actions</b>. Nodes are connected by <b>exec wires</b> — the <span style={{ color: "#9fc0ff" }}>▶ flow</span> that says "do this, then this". Separate <b>data wires</b> feed values (a number, a variable, another object) into a node's inputs. The <b>Nodes</b> tab lists every node you can drop in; this page explains how they fit together and run.</P>
      <ExecChainMock />
      <div style={{ color: "#9aa6ba", fontSize: 12.5, margin: "8px 0" }}>Read it left→right: <i>when Jump is pressed, IF the character is grounded, play the jump animation and do a CM Jump.</i></div>

      <H2>Two kinds of Logic Sheet</H2>
      <P>There are two places logic lives, and the difference is <b>scope</b>:</P>
      <DocTable head={["Sheet", "Runs…", "Use it for"]} rows={[
        [<b>Per-object (Blueprint)</b>, <>Once <b>per instance</b> of that Blueprint. <Code>self</Code> = that instance. 100 sheep = 100 independent copies.</>, "What THIS thing does — an enemy's AI, a pickup's effect, a door's open logic."],
        [<b>Main Logic Sheet</b>, <>Once, <b>scene-global</b>, on an invisible host (not tied to any object). You can have several, each <b>enabled/disabled</b> on its own.</>, "What the GAME / SCENE does — score, timers, spawning waves, coordinating objects, tutorial gating."],
      ]} />
      <Callout tone="tip">Rule of thumb: a health pickup's "heal the player" logic → <b>per-object</b>. A wave spawner or a global score counter → <b>main</b>.</Callout>

      <H2>Groups (the folder tabs)</H2>
      <P>Every sheet is split into named <b>groups</b> — the folder tabs across the top. They exist for two reasons:</P>
      <GroupsMock />
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "5px 0" }}><b>Organization</b> — keep Combat / Patrol / Pickups logic in separate tabs so a big sheet stays readable.</li>
        <li style={{ margin: "5px 0" }}><b>Runtime on/off</b> — you can <b>disable a whole group</b> so all its triggers stop firing, then re-enable it later.</li>
      </ul>
      <P>Toggle a group with the <Code>Set Group Active</Code> node — e.g. <Code>Set Group Active &#123; group: "Patrol", active: off &#125;</Code>. It only affects <b>this object's own</b> groups; a disabled group's triggers simply don't fire until you turn it back on.</P>
      <DocTable head={["Why groups", "Example"]} rows={[
        ["Boss phases", "Disable the 'phase 1 attacks' group and enable 'phase 2 attacks' when the boss is hit."],
        ["Tutorial gating", "Keep the 'free roam' group off until the tutorial group signals it's done."],
        ["Mode switching", "Turn 'patrol' off and 'flee' on the moment an NPC is alerted."],
        ["Readability", "Find and edit one slice of behavior without scrolling a giant canvas."],
      ]} />

      <H2>How it executes (the order)</H2>
      <P>Logic is <b>event-driven</b>, not read top-to-bottom. The model:</P>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "6px 0" }}>Each <b>trigger</b> subscribes to its event when the object spawns. When that event happens, execution starts at the trigger and <b>walks the exec wires</b> through the connected nodes.</li>
        <li style={{ margin: "6px 0" }}><b>Per-frame triggers</b> (On Step / On Tick, On Key Held, Every N Seconds) fire every frame. <b>One-shot triggers</b> (On Create, On Key Pressed, On Signal, On Collide…) fire the instant their event occurs.</li>
        <li style={{ margin: "6px 0" }}>Inside a chain, nodes run in <b>wire order</b>. If one output wires to several nodes, they run in the order the wires were made. Conditions feed a <b>Branch</b> that picks the true/false path; flow nodes (Sequence, ForEach, Wait) route or pause the flow.</li>
        <li style={{ margin: "6px 0" }}>Across objects, each instance runs its own sheet <b>independently</b>; per-frame triggers fire once per instance per frame, in spawn order.</li>
      </ul>
      <Callout tone="warn">Groups do <b>not</b> set the order — the <b>exec wires</b> do. Two triggers in different groups both fire whenever their own events happen; there's no "group 1 runs before group 2". If you need a strict order, wire it explicitly (a <Code>Sequence</Code> node) or gate steps with conditions / signals. The order is otherwise deterministic — the same every run.</Callout>

      <H2>self, picked &amp; variables</H2>
      <DocTable head={["Reference", "Resolves to"]} rows={[
        [<Code>self</Code>, <>The object running the chain. In a per-object sheet that's the instance; in the <b>Main</b> sheet it's the invisible host (which has no body).</>],
        [<Code>var:Name</Code>, "A variable on self."],
        [<Code>global:Name</Code>, "A project-wide global that survives scene changes and save/load."],
        [<Code>picked</Code>, "The 'other' object from a ForEach loop or a collision — e.g. who you just hit."],
      ]} />
      <P>In the <b>Main</b> sheet, since <Code>self</Code> is just a host with no body, you mostly work through <b>globals</b>, <b>ForEach / picked</b>, and <Code>Emit Signal To</Code> to reach the real objects in the scene.</P>

      <H2>Flow-control nodes</H2>
      <P>These route or pause the exec flow (the full set is in the Nodes tab):</P>
      <DocTable head={["Node", "What it does to the flow"]} rows={[
        [<Code>Branch (If)</Code>, "Splits into a true path and a false path based on a condition."],
        [<Code>Sequence</Code>, "Fires its outputs one after another, in order — guarantees ordering."],
        [<Code>ForEach</Code>, "Runs the downstream chain once per object with a tag (each becomes 'picked')."],
        [<Code>Do Once</Code>, "Runs only the first time it's reached (per object)."],
        [<Code>FlipFlop</Code>, "Alternates between two outputs each time it fires (toggle)."],
        [<Code>Random</Code>, "Picks one output at random each fire."],
        [<Code>Repeat</Code>, "Runs the downstream chain N times in a row."],
        [<Code>While</Code>, "Loops the downstream chain while a condition stays true (capped for safety)."],
        [<><Code>Wait</Code> / <Code>Wait Realtime</Code></>, "Pauses the chain for N seconds, then continues (Realtime ignores time-scale / pause)."],
        [<><Code>Wait For Signal</Code> / <Code>Key</Code> / <Code>Anim</Code></>, "Holds the chain until a signal fires, a key is pressed, or an animation finishes."],
      ]} />
      <Callout>Because <Code>Wait</Code> pauses one chain without freezing the game, you can build sequences — <i>damage → Wait 2s → recover</i> — and each object's chains run on their own timers.</Callout>
    </DocScroll>
  );
}

// ── Dialogue visual mockups ─────────────────────────────────────────────────
/** The runtime dialogue bubble (modern theme, default style colors). */
function DialogueBubbleMock() {
  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: 320, background: "rgba(0,0,0,0.85)", border: "2px solid #ffffff", borderRadius: 10, padding: "10px 14px 14px", boxShadow: "0 6px 18px rgba(0,0,0,0.55)" }}>
      <div style={{ display: "inline-block", background: "rgba(255,204,102,0.16)", color: "#ffcc66", fontWeight: 700, fontSize: 13, padding: "1px 9px", borderRadius: 6, marginBottom: 6 }}>Alice</div>
      <div style={{ color: "#ffffff", fontSize: 15, lineHeight: 1.45, fontFamily: "Arial" }}>You finally made it. I wasn't sure you'd come…</div>
      <div style={{ position: "absolute", right: 9, bottom: 5, color: "#ffffff", fontSize: 11, opacity: 0.8 }}>▼</div>
    </div>
  );
}

/** A faithful copy of one line card from the Dialogue editor. */
function DialogueLineMock() {
  const chip = (txt: string, filled = false, color = "#5eb3ff") => (
    <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap", background: filled ? color : "transparent", color: filled ? "#06121f" : color, border: `1px solid ${color}`, fontWeight: filled ? 700 : 400 }}>{txt}</span>
  );
  return (
    <div style={{ width: 380, background: "#171b24", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ color: "#6b7488", fontSize: 11, width: 14 }}>1</span>
        <span style={{ ...mInput("Alice"), flex: 1, fontWeight: 600 }}>Alice</span>
        <span style={{ color: "#6b7488", fontSize: 12 }}>↑ ↓ ✕</span>
      </div>
      <div style={{ background: "#0f131b", border: "1px solid rgba(255,255,255,0.11)", borderRadius: 4, padding: "6px 8px", fontSize: 12, color: "#e6e9f0", fontFamily: "ui-monospace,monospace", lineHeight: 1.4 }}>You finally made it. I wasn't sure you'd come…</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
        {chip("wait 0.5 s ✕", true, "#5eb3ff")}
        {chip("emit DoorOpens ✕", true, "#c77bff")}
        {chip("+ choice", false, "#5fae74")}
      </div>
      <div style={{ marginTop: 8, paddingLeft: 14, borderLeft: "2px solid #e8b51f" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ color: "#8b93a6", fontSize: 11 }}>1</span><span style={{ ...mInput("Open the door"), flex: 1 }}>Open the door</span><span style={{ color: "#e85553" }}>✕</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, paddingLeft: 18, fontSize: 10.5, color: "#8b93a6" }}>emit <span style={{ ...mInput("ChoseOpen"), padding: "2px 6px" }}>ChoseOpen</span> go to <span style={{ ...mInput(""), padding: "2px 6px", display: "inline-flex", gap: 8 }}>—<span style={{ color: "#757d8a" }}>▾</span></span></div>
      </div>
    </div>
  );
}

/** Mock of the Dialog Flow timeline — chapters (columns) × NPC (rows). */
function DialogFlowGridMock() {
  const kindBadge = (txt: string, c: string) => <span style={{ fontSize: 8.5, padding: "1px 5px", borderRadius: 3, background: c, color: "#06121f", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{txt}</span>;
  const card = (dlg: string, badge: ReactNode) => (
    <div style={{ background: "#1c2230", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 5, padding: "5px 7px", display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 11, color: "#e6e9f0", fontWeight: 600 }}>{dlg}</span>{badge}
    </div>
  );
  const COLS = "120px 1fr 1fr";
  const head = (t: string) => <div style={{ padding: "6px 8px", fontSize: 11, fontWeight: 700, color: "#9fb0d0", textTransform: "uppercase", letterSpacing: 0.4 }}>{t}</div>;
  const npc = (t: string) => <div style={{ padding: "8px", fontSize: 12, fontWeight: 600, color: "#cdd6e6", display: "flex", alignItems: "center" }}>{t}</div>;
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.14)", borderRadius: 8, overflow: "hidden", background: "#13161e", margin: "12px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: COLS, background: "rgba(255,255,255,0.04)" }}>{head("NPC")}{head("Act 1 — Village")}{head("Act 2 — Cave")}</div>
      <div style={{ display: "grid", gridTemplateColumns: COLS, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        {npc("BP_Elder")}
        <div style={{ padding: 6, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>{card("Greeting", kindBadge("On Interact", "#5fd28b"))}</div>
        <div style={{ padding: 6, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>{card("Warning", kindBadge("On Enter Scene", "#5eb3ff"))}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: COLS, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        {npc("BP_Merchant")}
        <div style={{ padding: 6, borderLeft: "1px solid rgba(255,255,255,0.06)" }}>{card("Shop Intro", kindBadge("On Interact", "#5fd28b"))}</div>
        <div style={{ padding: 6, borderLeft: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", color: "#5f6b82", fontSize: 11 }}>+ Add Trigger</div>
      </div>
    </div>
  );
}

const DIALOGUE_THEMES: [string, string][] = [
  ["modern", "Soft rounded corners, drop shadow, speaker pill. The default."],
  ["jrpg", "Square corners, double-line border, speaker box top-left."],
  ["comic", "Rounded speech bubble with a downward tail (overhead mode)."],
  ["comic-shout", "Jagged starburst outline — combat / loud lines."],
  ["comic-thought", "Cloud-puffy perimeter with trailing thought bubbles."],
  ["comic-whisper", "Dashed, translucent outline — quiet lines."],
  ["comic-news", "Sharp rectangle with a halftone-dot pattern — narrator captions."],
  ["image", "Your own 9-slice PNG box (designer-authored)."],
];

function DialogueDoc() {
  return (
    <DocScroll>
      <H1>Dialogue &amp; Dialog Flow</H1>
      <P>Two pieces work together. A <b>Dialogue</b> is the <i>script</i> — an ordered list of spoken lines (with branching choices). The <b>Dialog Flow</b> timeline is the <i>director</i> — it decides <b>which</b> dialogue plays, on <b>which</b> NPC, and <b>when</b> (on interact, on entering a scene, or on a signal). You can also just fire a dialogue straight from logic with the <Code>PlayDialogue</Code> node.</P>

      <H2>The dialogue bubble</H2>
      <P>At runtime the engine draws its own bubble above the speaker (or fixed at the screen bottom). This is the default <b>modern</b> theme:</P>
      <div style={{ margin: "14px 0", display: "flex", justifyContent: "center" }}><DialogueBubbleMock /></div>
      <DocTable head={["Setting", "What it does"]} rows={[
        ["Display mode", <><b>Overhead</b> = bubble floats above the speaker in the world. <b>Box</b> = fixed at the bottom of the screen (HUD).</>],
        ["Theme", "The bubble's look — see the themes below."],
        ["Text / Speaker color", <>Defaults: white text, <span style={{ color: "#ffcc66" }}>warm-yellow speaker</span> (<Code>#ffcc66</Code>).</>],
        ["BG color / opacity", <>Default black at <Code>0.85</Code> opacity.</>],
        ["Border color / width", <>Default white, <Code>2px</Code>.</>],
        ["Font family / size", <>Default Arial <Code>16px</Code>.</>],
        ["Box width / padding", <>Max width <Code>360</Code>; padding <Code>12×10</Code> (per-side overrides available).</>],
        ["Offsets", <>Overhead: <Code>(0, -8)</Code> above the head. Box: <Code>(0, 16)</Code> above the screen bottom.</>],
      ]} />
      <div style={{ marginTop: 14, fontWeight: 700, color: "#fff", fontSize: 14 }}>Themes</div>
      <DocTable head={["Theme", "Look"]} rows={DIALOGUE_THEMES.map(([t, d]) => [<Code>{t}</Code>, d])} />

      <H2>A dialogue line</H2>
      <P>Each line is one speech bubble. This is a line in the editor:</P>
      <div style={{ margin: "14px 0", display: "flex", justifyContent: "center" }}><DialogueLineMock /></div>
      <DocTable head={["Field", "What it does"]} rows={[
        ["Speaker", <>Who's talking — a label like <i>Alice</i> mapped to a Blueprint (see Speakers). Empty = narrator.</>],
        ["Text", <>What they say. Multi-line; supports <Code>{"{var}"}</Code> (speaker's variable) and <Code>{"{Bp.var}"}</Code> (another object's) interpolation.</>],
        ["wait (delaySec)", "Pause this many seconds before the line appears (stage timing)."],
        ["emit (emitSignal)", <>Fire a signal the instant the line begins — catch it with <Code>OnSignal</Code> to trigger something (open a door, shake the camera).</>],
        ["choices", "Turn the line into a branching choice — see below."],
      ]} />

      <H2>Choices &amp; branching</H2>
      <P>Add choices to a line and it waits for the player to pick (keys 1–9). Each choice:</P>
      <DocTable head={["Choice field", "What it does"]} rows={[
        ["Text", "The option label shown to the player."],
        ["emit (emitSignal)", <>Signal fired when this option is picked — branch your logic on it with <Code>OnSignal</Code>.</>],
        ["go to (goToDialogue)", "Jump to another Dialogue asset. Empty = just continue to the next line."],
      ]} />
      <Callout tone="tip">Set a <b>Player speaker</b> on the asset to have the player "recite" the choice text as a spoken line before the branch runs.</Callout>

      <H2>Speakers</H2>
      <P>The <b>Speakers</b> panel maps each speaker label to a Blueprint so the bubble knows where to float and whose variables to read. Per-speaker <b>offset X/Y</b> nudges that character's bubble. No mapping → the bubble falls back to a fixed camera position.</P>

      <H2>Playback &amp; advancing</H2>
      <DocTable head={["Setting", "What it does"]} rows={[
        ["Advance action", <>The Input Action that steps to the next line (default <Code>Interact</Code>). The same press also completes the typewriter.</>],
        ["Typewriter cps", <>Characters revealed per second (default <Code>30</Code>; <Code>0</Code> = instant).</>],
        ["Auto-advance s", <>Auto-step after N seconds with no input (default <Code>0</Code> = wait for the player).</>],
        ["Freeze player / NPCs", "Optionally freeze the player and/or NPCs while the conversation runs."],
      ]} />

      <H2>Writing scripts as plain text</H2>
      <P>Instead of clicking line-by-line, upload a <Code>.txt</Code> / <Code>.md</Code> / <Code>.dlg</Code> file. The parser turns it into lines and auto-matches speakers to Blueprints (you wire any it can't guess). The grammar:</P>
      <div style={{ background: "#0f131b", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "12px 14px", fontFamily: "ui-monospace,monospace", fontSize: 12.5, lineHeight: 1.6, color: "#d4dae6", margin: "12px 0", whiteSpace: "pre-wrap" }}>{`# a comment line is ignored
Alice: Hey there! [wait 0.5] [emit Wave]
This continues Alice's line.

Bob: Pick one.
> Open it   [emit ChoseOpen]
> Leave     [emit ChoseLeave] -> EndingDialogue`}</div>
      <ul style={{ margin: "8px 0", paddingLeft: 22 }}>
        <li style={{ margin: "4px 0" }}><Code>Speaker: text</Code> — a line. A blank line ends the block; an un-prefixed next line continues the same speaker.</li>
        <li style={{ margin: "4px 0" }}><Code>[wait N]</Code> / <Code>[emit Name]</Code> — apply to the line (or the next one if on their own).</li>
        <li style={{ margin: "4px 0" }}><Code>&gt; Option</Code> — a choice on the line above; <Code>[emit Name]</Code> and <Code>-&gt; OtherDialogue</Code> optional.</li>
      </ul>

      <H2>The Dialog Flow timeline</H2>
      <P>The <b>Dialog Flow</b> tab is a grid — <b>columns are chapters</b> (free-form story labels), <b>rows are NPC Blueprints</b>, and each <b>cell is a trigger</b> that says "play this dialogue, on this condition." It's the at-a-glance map of every conversation in the game.</P>
      <DialogFlowGridMock />
      <P>Click a cell to edit its trigger:</P>
      <DocTable head={["Trigger field", "What it does"]} rows={[
        ["Dialogue", "Which Dialogue asset plays."],
        ["Kind", <><b>On Interact</b> (player presses the interact action while in range), <b>On Enter Scene</b> (fires when the scene loads), or <b>On Signal</b> (a named signal fires).</>],
        ["Signal name", <>(On Signal kind) the signal that fires it.</>],
        ["Interactor / instance", "Limit who can trigger it (e.g. only the player BP), or only a specific placed instance."],
        ["Interact action", "Which Input Action counts as 'interact' for this trigger."],
        ["Conditions", <>Extra gates — <Code>var:Player.hp &gt; 0</Code>, <Code>global:Gold &gt;= 100</Code>… ALL must be true.</>],
        ["Priority", "When several triggers match at once, the highest priority wins."],
        ["One-shot", "Fire at most once per session (e.g. a first-meeting greeting)."],
      ]} />

      <H2>Controlling nodes &amp; signals</H2>
      <DocTable head={["Node", "Type", "What it does"]} rows={[
        [<Code>PlayDialogue</Code>, "Action", "Play a Dialogue asset right now (its bubble UI). No-op if one's already playing. Optional overrides for display mode / advance action / cps."],
        [<Code>StopDialogue</Code>, "Action", "Cancel the running dialogue and clear the bubble."],
        [<Code>IsDialoguePlaying</Code>, "Condition", "True while a conversation is running — gate input or pause logic during dialogue."],
      ]} />
      <P>Dialogue also <b>emits signals</b> you catch with <Code>OnSignal</Code>:</P>
      <DocTable head={["Signal", "When"]} rows={[
        [<><Code>OnDialogueStart</Code> / <Code>:&lt;name&gt;</Code></>, "A dialogue begins (generic, and per-asset variants)."],
        [<><Code>OnDialogueEnd</Code> / <Code>:&lt;name&gt;</Code></>, "A dialogue finishes or is stopped."],
        [<Code>OnDialogueChoice:&lt;line&gt;:&lt;choice&gt;</Code>, "A specific choice is picked (plus the choice's own emit signal)."],
        ["a line's emit signal", "The instant that line begins (set per line)."],
      ]} />
      <Callout>For branching, the simplest pattern is: give each choice an <b>emit</b> signal (e.g. <Code>ChoseOpen</Code>), then <i>On Signal "ChoseOpen" → do the thing</i>. Or use a choice's <b>go to</b> to chain straight into another dialogue.</Callout>
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
    <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "#0b0d12", display: "flex", flexDirection: "column", color: "#e8ecf5" }}>
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
      {/* TODO: replace the placeholder report URL below with the real one. */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 26px", fontSize: 22, lineHeight: 1.4, color: "#f0d59a", background: "rgba(230,160,60,0.13)", borderBottom: "2px solid rgba(230,160,60,0.4)" }}>
        <span style={{ flex: "0 0 auto", fontSize: 42 }}>⚠️</span>
        <span style={{ flex: 1 }}>
          Peaky is an <b>early-access</b> engine built by <b>one person + AI</b> — some features may not work yet, and parts of these docs can be out of date or mismatched. If something's broken or wrong, reporting it is hugely appreciated:{" "}
          <a href="https://www.exampleiwillreplacethislater.com" target="_blank" rel="noreferrer" style={{ color: "#9fc0ff", fontWeight: 700, whiteSpace: "nowrap" }}>www.exampleiwillreplacethislater.com</a>
        </span>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        {tab === "nodes" ? <NodesDoc />
          : tab === "logicSheet" ? <LogicSheetDoc />
          : tab === "stateMachine" ? <StateMachineDoc />
          : tab === "components" ? <ComponentsDoc />
          : tab === "items" ? <ItemsDoc />
          : tab === "ui" ? <UIDoc />
          : tab === "dialogue" ? <DialogueDoc />
          : <ComingSoon title={DOC_TABS.find((t) => t.id === tab)!.label} />}
      </div>
    </div>
  );
}
