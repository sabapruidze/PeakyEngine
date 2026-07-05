/**
 * One action row inside an event block — kind label + per-kind config + ×.
 *
 * Actions run top-to-bottom each time the parent event fires (and its guards
 * pass). Wait defers subsequent actions in the same chain via the per-event
 * action queue on `Sprite`.
 */

import { StateAction, CHARACTER_MOVEMENT_PARAMS } from "@peaky/shared";
import { Toggle } from "../../components/Toggle";
import { VariableDef } from "../../project";
import { ExpressionField } from "../ExpressionField";
import { useEditor } from "../../store";
import { flatBehaviorParamOptions, BEHAVIOR_PARAMS } from "../../behaviorMeta";
import type { BehaviorKind } from "../../project";
import { SubjectBadge } from "./EventsSection";
import { TagChips } from "./BlueprintInspector";
import { SignalPicker } from "../../components/SignalPicker";

const MONO = "ui-monospace, 'Cascadia Mono', 'Consolas', 'SF Mono', monospace";

const ACTION_PILL: React.CSSProperties = {
  background: "rgba(40, 50, 70, 0.85)",
  color: "rgba(230, 235, 245, 0.95)",
  border: "1px solid rgba(0,0,0,0.3)",
  fontFamily: MONO,
  fontWeight: 700,
  fontSize: 12,
  padding: "3px 9px",
  borderRadius: 4,
  outline: "none",
  cursor: "pointer",
};

/** Component-badge color per behavior source — duplicated from EventsSection
    to avoid an import cycle. Keep these in sync if you change the palette. */
const BADGE_COLORS: Record<string, string> = {
  System:                "#5e7aa8",
  "Variables":           "#7e8cd1",
  "Time":                "#d1a64a",
  "Flow Control":        "#d1a64a",
  "Debug":               "#666",
  "General":             "#5e7aa8",
  "Scenes / Layouts":    "#9b6dd1",
  "Camera / Scroll":     "#4a8ad1",
  "Save / Load":         "#d1d14a",
  "Sprite":              "#d18a4a",
  "Behavior":            "#4ad17a",
  CharacterMovement:     "#4ad17a",
  SpriteRenderer:        "#d18a4a",
  Collider:              "#4ab1d1",
};

function SourceBadge({ category }: { category: string }) {
  const color = BADGE_COLORS[category] ?? "#666";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: "rgba(20, 25, 38, 0.95)",
        color: "rgba(220, 230, 245, 0.95)",
        fontFamily: MONO,
        fontSize: 11,
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: 4,
        border: "1px solid rgba(0,0,0,0.4)",
        whiteSpace: "nowrap",
      }}
      title={`Source: ${category}`}
    >
      <span style={{
        width: 8, height: 8, borderRadius: 2,
        background: color, flex: "0 0 auto",
        border: "1px solid rgba(0,0,0,0.5)",
      }} />
      {category === "System" ? "SYSTEM" : category}
    </span>
  );
}

interface Props {
  action: StateAction;
  /** Source category — "System" / "CharacterMovement" / "SpriteRenderer" /
      "Collider". Drives the leading badge. Computed by caller from
      `categoryForActionKind`. */
  category: string;
  /** Pre-formatted compact summary (e.g. `"vx = 100"`). Caller provides
      this so we can keep ActionRow free of summary-formatting logic. */
  summary?: string;
}

/**
 * Compact display-only render for one action — no inline editing. The
 * caller wires a click handler to open the action picker modal pre-filled
 * with this row's kind + config. Construct-3 style.
 */
export function ActionRow({ action, category, summary }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        padding: "3px 6px",
        minHeight: 22,
      }}
    >
      <SourceBadge category={category} />
      <SubjectBadge subject={action.subject} />
      <span style={{
        background: "rgba(40, 50, 70, 0.85)",
        color: "rgba(230, 235, 245, 0.95)",
        fontFamily: MONO,
        fontWeight: 700,
        fontSize: 11,
        padding: "2px 7px",
        borderRadius: 3,
        border: "1px solid rgba(0,0,0,0.3)",
      }}>
        {action.kind.replace(/([A-Z])/g, " $1").trim()}
      </span>
      {summary && (
        <span style={{
          fontFamily: MONO,
          fontSize: 11,
          color: "rgba(13, 19, 32, 0.85)",
          padding: "2px 6px",
          borderRadius: 3,
          background: "rgba(255,255,255,0.45)",
        }}>{summary}</span>
      )}
    </div>
  );
}

export function ActionConfig({
  action, variables, animationNames, groupNames, onChange,
}: {
  action: StateAction;
  variables: VariableDef[];
  animationNames: string[];
  groupNames: string[];
  onChange: (cfg: Record<string, unknown>) => void;
}) {
  const cfg = action.config;
  const PILL = ACTION_PILL;
  const muted: React.CSSProperties = { color: "var(--text-muted)", fontFamily: MONO, fontSize: 11, fontWeight: 700, textTransform: "uppercase" };
  // Project-wide picker data — replaces raw text inputs with strict
  // selects for cross-asset references (blueprint id / name, scene
  // name, widget name, layer name). Same store subscription pattern
  // as the dialogues field below; cheap because Zustand re-renders only
  // when the slice actually changes.
  const blueprints = useEditor((s) => s.project.blueprints);
  const scenes = useEditor((s) => s.project.scenes);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  // All layers across all scenes — layer names are scene-scoped, but
  // CreateObject's layer field is also scene-scoped at runtime; we
  // surface every distinct name so the user can pick one quickly.
  const allLayerNames = Array.from(new Set(scenes.flatMap((s) => s.layers.map((l) => l.name)))).sort();
  // Distinct tag pool across every BP — surfaced as a datalist so tag-
  // input fields (ScrollToObject, EmitSignalTo, SetVarOn, etc.) get
  // autocomplete, while still allowing free-form entry for project
  // structures the user is mid-authoring. Also includes per-instance tag
  // overrides so a tag that only exists on a specific placement still
  // shows up in the picker.
  const allTags = Array.from(new Set([
    ...blueprints.flatMap((bp) => bp.tags ?? []),
    ...scenes.flatMap((s) => s.instances.flatMap((inst) => inst.tags ?? [])),
  ])).sort();
  // All UI targets: every widget name + every multi-mode child name.
  // Surfaced as a datalist on the SetUI* `target` fields so the user
  // gets autocomplete (free-form entry remains valid for things like
  // an instance label not yet authored). Empty target = self by
  // convention; the datalist explicitly lists "(self)" as the first
  // suggestion.
  // Widget target groups for hierarchical <select> rendering. Each
  // group header is the widget; entries inside are the widget itself
  // ("— whole widget —") plus any named children. Runtime accepts:
  //   • "WidgetName"         → whole widget
  //   • "WidgetName.Child"   → specific child
  //   • "ChildName"          → any child of that name (back-compat)
  const uiTargetGroups: Array<{ widget: string; entries: Array<{ value: string; label: string }> }> = [];
  for (const w of uiWidgets) {
    if (!w.name) continue;
    const entries: Array<{ value: string; label: string }> = [
      { value: w.name, label: `— whole widget (${w.kind}) —` },
    ];
    for (const c of w.children ?? []) {
      if (!c.name) continue;
      entries.push({ value: `${w.name}.${c.name}`, label: `${c.name} (${c.kind})` });
    }
    uiTargetGroups.push({ widget: w.name, entries });
  }
  // All Tween tags declared anywhere in the project — surfaced as a
  // datalist on Tween/TweenStop/TweenSetEndValue/TweenPause/Resume
  // tag fields so authors don't have to retype the tag from memory.
  const allTweenTags = (() => {
    const out = new Set<string>();
    const visit = (events: { actions?: { kind: string; config?: Record<string, unknown> }[]; children?: unknown[] }[] | undefined) => {
      if (!events) return;
      for (const ev of events) {
        for (const a of ev.actions ?? []) {
          if (a.kind === "Tween" || a.kind.startsWith("Tween")) {
            const t = String(a.config?.tag ?? "").trim();
            if (t) out.add(t);
          }
        }
        visit(ev.children as never);
      }
    };
    for (const bp of blueprints) visit(bp.events as never);
    return Array.from(out).sort();
  })();
  switch (action.kind) {
    case "PlayAnimation":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {animationNames.length > 0 ? (
            <select
              value={(cfg.animation as string) ?? ""}
              onChange={(e) => onChange({ ...cfg, animation: e.target.value })}
              style={PILL}
            >
              <option value="">— pick animation —</option>
              {animationNames.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          ) : (
            <input
              value={(cfg.animation as string) ?? ""}
              onChange={(e) => onChange({ ...cfg, animation: e.target.value })}
              placeholder="Idle, Run, Jump…"
              style={PILL}
            />
          )}
          <select
            value={(cfg.from as string) ?? "current"}
            onChange={(e) => onChange({ ...cfg, from: e.target.value })}
            style={PILL}
            title="from beginning = restart every call (re-triggerable). from current = smart resume — keeps mid-play state for continuous calls."
          >
            <option value="current">from current</option>
            <option value="beginning">from beginning</option>
          </select>
        </span>
      );
    case "StopAnimation":
      return <span style={{ ...muted, fontStyle: "italic" }}>(no params — freezes on current frame)</span>;
    case "SetFrame":
      return (
        <input
          type="text"
          value={String(cfg.frame ?? 0)}
          onChange={(e) => {
            const v = e.target.value;
            const n = Number(v);
            const stored: number | string = !Number.isNaN(n) && !v.includes(":") && !v.startsWith("$") ? n : v;
            onChange({ ...cfg, frame: stored });
          }}
          placeholder="0"
          title="0-indexed frame number (matches the editor's frame strip labels). Accepts var:name or expressions."
          style={{ ...PILL, width: 60 }}
        />
      );
    case "SetAnimationSpeed":
      return (
        <input
          type="text"
          value={String(cfg.speed ?? 1)}
          onChange={(e) => {
            const v = e.target.value;
            const n = Number(v);
            const stored: number | string = !Number.isNaN(n) && !v.includes(":") && !v.startsWith("$") ? n : v;
            onChange({ ...cfg, speed: stored });
          }}
          placeholder="1"
          title="Speed multiplier. 1 = native fps; 2 = double; 0.5 = half; 0 = paused."
          style={{ ...PILL, width: 60 }}
        />
      );
    case "SetColor":
      return (
        <input
          type="color"
          value={`#${((cfg.color as number) ?? 0xffffff).toString(16).padStart(6, "0")}`}
          onChange={(e) => onChange({ ...cfg, color: parseInt(e.target.value.slice(1), 16) })}
          style={{ ...PILL, padding: 2, width: 40, height: 28, cursor: "pointer" }}
        />
      );
    case "SetSize":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>W</span>
          <ExpressionField value={(cfg.w as number) ?? 32} onChange={(n) => onChange({ ...cfg, w: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>H</span>
          <ExpressionField value={(cfg.h as number) ?? 32} onChange={(n) => onChange({ ...cfg, h: n })} style={{ ...PILL, width: 60 }} />
        </span>
      );
    case "SetVelocityX":
      return <ExpressionField value={(cfg.vx as number) ?? 0} onChange={(n) => onChange({ ...cfg, vx: n })} style={{ ...PILL, width: 70 }} />;
    case "SetVelocityY":
      return <ExpressionField value={(cfg.vy as number) ?? 0} onChange={(n) => onChange({ ...cfg, vy: n })} style={{ ...PILL, width: 70 }} />;
    case "Wait":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField value={cfg.seconds as string | number | undefined} onChange={(s) => onChange({ ...cfg, seconds: s })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>SEC</span>
        </span>
      );
    case "WaitRealtime":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField value={cfg.seconds as string | number | undefined} onChange={(s) => onChange({ ...cfg, seconds: s })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>SEC (wall clock)</span>
        </span>
      );
    case "SetTimeScale":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.scale as number) ?? 1} onChange={(n) => onChange({ ...cfg, scale: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>× (1=normal, 0=pause)</span>
        </span>
      );
    case "HitStop":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>freeze</span>
          <ExpressionField value={cfg.durationMs as string | number | undefined} onChange={(n) => onChange({ ...cfg, durationMs: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>ms · delay</span>
          <ExpressionField value={cfg.delayMs as string | number | undefined} onChange={(n) => onChange({ ...cfg, delayMs: n })} style={{ ...PILL, width: 56 }} />
          <span style={muted}>ms at scale</span>
          <ExpressionField step="0.05" value={cfg.scale as string | number | undefined} onChange={(n) => onChange({ ...cfg, scale: n })} style={{ ...PILL, width: 60 }} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }}>
            <Toggle value={cfg.affectPhysics !== false} onChange={(v) => onChange({ ...cfg, affectPhysics: v })} />
            physics
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }}>
            <Toggle value={cfg.affectParticles !== false} onChange={(v) => onChange({ ...cfg, affectParticles: v })} />
            particles
          </label>
        </span>
      );
    case "SetBool": {
      const boolVars = variables.filter((v) => v.type === "bool");
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {boolVars.length > 0 ? (
            <select value={(cfg.name as string) ?? ""} onChange={(e) => onChange({ ...cfg, name: e.target.value })} style={PILL}>
              <option value="">— pick bool var —</option>
              {boolVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
          ) : (
            <span style={{ ...muted, color: "var(--red)" }}>NO BOOL VARS</span>
          )}
          <span style={muted}>=</span>
          <select
            value={cfg.value === false || cfg.value === "false" ? "false" : "true"}
            onChange={(e) => onChange({ ...cfg, value: e.target.value === "true" })}
            style={PILL}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </span>
      );
    }
    case "ToggleBool": {
      const boolVars = variables.filter((v) => v.type === "bool");
      return boolVars.length > 0 ? (
        <select value={(cfg.name as string) ?? ""} onChange={(e) => onChange({ ...cfg, name: e.target.value })} style={PILL}>
          <option value="">— pick bool var —</option>
          {boolVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
        </select>
      ) : (
        <span style={{ ...muted, color: "var(--red)" }}>NO BOOL VARS</span>
      );
    }
    case "SubVar": {
      const numVars = variables.filter((v) => v.type === "number");
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          {numVars.length > 0 ? (
            <select value={(cfg.name as string) ?? ""} onChange={(e) => onChange({ ...cfg, name: e.target.value })} style={PILL}>
              <option value="">— pick var —</option>
              {numVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
          ) : (
            <span style={{ ...muted, color: "var(--red)" }}>NO NUM VARS</span>
          )}
          <span style={muted}>−</span>
          <ExpressionField value={(cfg.delta as number) ?? 1} onChange={(n) => onChange({ ...cfg, delta: n })} style={{ ...PILL, width: 70 }} />
        </span>
      );
    }
    case "WaitForSignal":
      return (
        <input
          list="peaky-signal-suggestions"
          value={String(cfg.name ?? "")}
          onChange={(e) => onChange({ ...cfg, name: e.target.value })}
          placeholder="SignalName"
          style={{ ...PILL, minWidth: 120 }}
        />
      );
    case "CreateObject": {
      // Resolve the targeted BP so we can render one input per
      // `exposeOnSpawn`-flagged variable. Spawn-vars get stored under
      // `cfg.spawnVars` keyed by variable name. Runtime translates this
      // into `instVars` for spawnFromBlueprint.
      const targetBp = blueprints.find((bp) => bp.id === String(cfg.blueprintId ?? ""));
      const exposed = targetBp?.variables.filter((v) => v.exposeOnSpawn) ?? [];
      const spawnVars = (cfg.spawnVars as Record<string, unknown> | undefined) ?? {};
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select value={String(cfg.blueprintId ?? "")} onChange={(e) => onChange({ ...cfg, blueprintId: e.target.value })} style={{ ...PILL, minWidth: 140 }}>
            <option value="">— pick blueprint —</option>
            {blueprints.map((bp) => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
          </select>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>LAYER</span>
          <select value={String(cfg.layer ?? "")} onChange={(e) => onChange({ ...cfg, layer: e.target.value })} style={{ ...PILL, width: 130 }}>
            <option value="">(active)</option>
            {allLayerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {exposed.map((v) => (
            <span key={v.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <span style={muted}>{v.name.toUpperCase()}</span>
              <input
                value={String(spawnVars[v.name] ?? "")}
                placeholder={String(v.default)}
                onChange={(e) => {
                  const txt = e.target.value;
                  const next: Record<string, unknown> = { ...spawnVars };
                  if (txt === "") delete next[v.name];
                  else if (v.type === "bool") next[v.name] = txt === "true" || txt === "1";
                  else if (v.type === "number") {
                    const n = Number(txt);
                    next[v.name] = Number.isFinite(n) && !txt.includes(":") && !txt.startsWith("$") ? n : txt;
                  } else next[v.name] = txt;
                  onChange({ ...cfg, spawnVars: next });
                }}
                style={{ ...PILL, width: 80 }}
                title={`Per-spawn override for ${v.name} (${v.type}). Default: ${v.default}. Leave empty to use default.`}
              />
            </span>
          ))}
        </span>
      );
    }
    case "CreateObjectByName": {
      // Same exposed-vars treatment, looked up by name instead of id.
      const targetBp = blueprints.find((bp) => bp.name === String(cfg.blueprintName ?? ""));
      const exposed = targetBp?.variables.filter((v) => v.exposeOnSpawn) ?? [];
      const spawnVars = (cfg.spawnVars as Record<string, unknown> | undefined) ?? {};
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input value={String(cfg.blueprintName ?? "")} onChange={(e) => onChange({ ...cfg, blueprintName: e.target.value })} placeholder="blueprint name" list="peaky-bp-name-suggestions" style={{ ...PILL, minWidth: 120 }} />
          <datalist id="peaky-bp-name-suggestions">
            {blueprints.map((bp) => <option key={bp.id} value={bp.name} />)}
          </datalist>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>LAYER</span>
          <select value={String(cfg.layer ?? "")} onChange={(e) => onChange({ ...cfg, layer: e.target.value })} style={{ ...PILL, width: 130 }}>
            <option value="">(active)</option>
            {allLayerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {exposed.map((v) => (
            <span key={v.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <span style={muted}>{v.name.toUpperCase()}</span>
              <input
                value={String(spawnVars[v.name] ?? "")}
                placeholder={String(v.default)}
                onChange={(e) => {
                  const txt = e.target.value;
                  const next: Record<string, unknown> = { ...spawnVars };
                  if (txt === "") delete next[v.name];
                  else if (v.type === "bool") next[v.name] = txt === "true" || txt === "1";
                  else if (v.type === "number") {
                    const n = Number(txt);
                    next[v.name] = Number.isFinite(n) && !txt.includes(":") && !txt.startsWith("$") ? n : txt;
                  } else next[v.name] = txt;
                  onChange({ ...cfg, spawnVars: next });
                }}
                style={{ ...PILL, width: 80 }}
                title={`Per-spawn override for ${v.name} (${v.type}). Default: ${v.default}.`}
              />
            </span>
          ))}
        </span>
      );
    }
    case "FireProjectile": {
      // Mirrors the Projectile component: ONE visible field (which BP to
      // fire) plus a toggle for each of the 15 component parameters. Off
      // (default) → use the BP's Projectile component value. On → action's
      // value overrides that parameter for this shot. Spawn position +
      // direction + layer are derived from the firing sprite automatically.
      const OVR_FIELDS: Array<{ flag: string; key: string; label: string; kind: "num" | "str" | "enum"; title: string; options?: string[] }> = [
        { flag: "ovrMode",             key: "mode",             label: "MODE",        kind: "enum", options: ["straight", "homing"], title: "straight | homing. Overrides Projectile.mode for this shot." },
        { flag: "ovrSpeed",            key: "speed",            label: "SPEED",       kind: "num",  title: "Travel speed in px/sec. Overrides Projectile.speed." },
        { flag: "ovrLifetime",         key: "lifetime",         label: "LIFETIME",    kind: "num",  title: "Lifetime in seconds. Overrides Projectile.lifetime." },
        { flag: "ovrGravityX",         key: "gravityX",         label: "GRAVITY X",   kind: "num",  title: "Horizontal gravity (px/s²). Overrides Projectile.gravityX." },
        { flag: "ovrGravityY",         key: "gravityY",         label: "GRAVITY Y",   kind: "num",  title: "Vertical gravity (px/s²). Overrides Projectile.gravityY." },
        { flag: "ovrTargetTags",       key: "targetTags",       label: "TARGET TAGS", kind: "str",  title: "Comma-separated valid hit tags. Overrides Projectile.targetTags." },
        { flag: "ovrHitSignal",        key: "hitSignal",        label: "HIT SIGNAL",  kind: "str",  title: "Signal emitted on hit. Overrides Projectile.hitSignal." },
        { flag: "ovrDestroyOnHit",     key: "destroyOnHit",     label: "ON-HIT KILL", kind: "num",  title: "1 = destroy on hit, 0 = pierce. Overrides Projectile.destroyOnHit." },
        { flag: "ovrRotateToVelocity", key: "rotateToVelocity", label: "ROTATE",      kind: "num",  title: "1 = face velocity, 0 = fixed. Overrides Projectile.rotateToVelocity." },
        { flag: "ovrDamage",           key: "damage",           label: "DAMAGE",      kind: "num",  title: "Damage on hit. Overrides Projectile.damage." },
        { flag: "ovrKnockbackX",       key: "knockbackX",       label: "KNOCKBACK X", kind: "num",  title: "Horizontal knockback. Overrides Projectile.knockbackX." },
        { flag: "ovrKnockbackY",       key: "knockbackY",       label: "KNOCKBACK Y", kind: "num",  title: "Vertical knockback. Overrides Projectile.knockbackY." },
        { flag: "ovrHitboxW",          key: "hitboxW",          label: "HITBOX W",    kind: "num",  title: "Hitbox width (px). 0 = body. Overrides Projectile.hitboxW." },
        { flag: "ovrHitboxH",          key: "hitboxH",          label: "HITBOX H",    kind: "num",  title: "Hitbox height (px). 0 = body. Overrides Projectile.hitboxH." },
        { flag: "ovrHomingTurnRate",   key: "homingTurnRate",   label: "TURN °/s",    kind: "num",  title: "Homing turn rate (degrees/sec). Overrides Projectile.homingTurnRate." },
      ];
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={String(cfg.blueprintName ?? "")}
            onChange={(e) => onChange({ ...cfg, blueprintName: e.target.value })}
            placeholder="projectile BP name"
            list="peaky-bp-name-suggestions"
            style={{ ...PILL, minWidth: 140 }}
            title="Blueprint with a Projectile component. Spawn position = this firing sprite's center; direction = this sprite's facing."
          />
          {/* Component-mirroring overrides. Each row = checkbox + label +
              value field (dimmed when off). Off (default) → bullet uses
              the BP Projectile component's authored value. */}
          <div style={{ flexBasis: "100%", height: 0 }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 0 0 0", width: "100%" }}>
            <span style={{ ...muted, fontSize: 10, marginRight: 4, alignSelf: "center" }}>PROJECTILE OVERRIDES (off = use component):</span>
            {OVR_FIELDS.map((f) => {
              const active = Number(cfg[f.flag] ?? 0) === 1;
              return (
                <label
                  key={f.flag}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    padding: "2px 6px",
                    background: active ? "rgba(120, 180, 255, 0.12)" : "transparent",
                    border: `1px solid ${active ? "rgba(120, 180, 255, 0.4)" : "var(--border)"}`,
                    borderRadius: 4,
                    opacity: active ? 1 : 0.55,
                    cursor: "pointer",
                  }}
                  title={f.title}
                >
                  <Toggle
                    value={active}
                    onChange={(v) => {
                      onChange({ ...cfg, [f.flag]: v ? 1 : 0 });
                    }}
                    style={{ margin: 0, cursor: "pointer" }}
                  />
                  <span style={{ ...muted, fontSize: 10 }}>{f.label}</span>
                  {f.kind === "enum" ? (
                    <select
                      value={String(cfg[f.key] ?? f.options?.[0] ?? "")}
                      onChange={(e) => onChange({ ...cfg, [f.key]: e.target.value })}
                      disabled={!active}
                      style={{ ...PILL, width: 90 }}
                    >
                      {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.kind === "num" ? (
                    <ExpressionField
                      value={cfg[f.key] as string | number | undefined}
                      onChange={(n) => onChange({ ...cfg, [f.key]: n })}
                      style={{ ...PILL, width: 60 }}
                      disabled={!active}
                    />
                  ) : (
                    <input
                      value={String(cfg[f.key] ?? "")}
                      onChange={(e) => onChange({ ...cfg, [f.key]: e.target.value })}
                      disabled={!active}
                      style={{ ...PILL, width: 90 }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </span>
      );
    }
    case "SortZOrder":
    case "StopLoop":
    case "RestartLayout":
    case "GoToNextLayout":
    case "RecreateInitialObjects":
      return <span style={{ ...muted, fontStyle: "italic" }}>(no params)</span>;
    case "GoToLayout":
      return (
        <select value={String(cfg.name ?? "")} onChange={(e) => onChange({ ...cfg, name: e.target.value })} style={{ ...PILL, minWidth: 160 }}>
          <option value="">— pick scene —</option>
          {scenes.map((sc) => <option key={sc.id} value={sc.name}>{sc.name}</option>)}
        </select>
      );
    case "ScrollToObject":
      return (<>
        <input value={String(cfg.tag ?? "")} onChange={(e) => onChange({ ...cfg, tag: e.target.value })} placeholder="tag (e.g. player)" list="peaky-tag-suggestions" style={{ ...PILL, minWidth: 120 }} />
        <datalist id="peaky-tag-suggestions">
          {allTags.map((t) => <option key={t} value={t} />)}
        </datalist>
      </>);
    case "ScrollToPosition":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 70 }} />
        </span>
      );
    case "SetLayoutScale":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.1" value={(cfg.scale as number) ?? 1} onChange={(n) => onChange({ ...cfg, scale: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>× zoom</span>
        </span>
      );
    case "SaveSlot":
    case "LoadSlot":
      return (
        <input value={String(cfg.slot ?? "default")} onChange={(e) => onChange({ ...cfg, slot: e.target.value })} placeholder="slot name" style={{ ...PILL, minWidth: 120 }} />
      );
    case "CMJump":
    case "CMDash":
    case "CMStopDash":
    case "CMStopWallSlide":
    case "CMStopMovement":
    case "CMResetJumps":
    case "CMSetDefaultControls":
      return <span style={{ ...muted, fontStyle: "italic" }}>(no params)</span>;
    case "CMFallThrough":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.duration as number) ?? 0.2} onChange={(n) => onChange({ ...cfg, duration: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>SEC</span>
        </span>
      );
    // Explicit numeric setters — single value field each.
    case "CMSetMaxSpeed":
    case "CMSetAcceleration":
    case "CMSetDeceleration":
    case "CMSetGravity":
    case "CMSetGravityAngle":
    case "CMSetMaxFallSpeed":
    case "CMSetJumpStrength":
    case "CMSetMultiJump":
      return (
        <ExpressionField
          step={action.kind === "CMSetMultiJump" ? "1" : "any"}
          value={(cfg.value as number) ?? 0}
          onChange={(n) => onChange({ ...cfg, value: n })}
          style={{ ...PILL, width: 90 }}
        />
      );
    case "CMSetJumpSustain":
    case "CMSetDoubleJump":
      return (
        <select
          value={cfg.value === false || cfg.value === "false" ? "false" : "true"}
          onChange={(e) => onChange({ ...cfg, value: e.target.value === "true" })}
          style={PILL}
        >
          <option value="true">on</option>
          <option value="false">off</option>
        </select>
      );
    case "CMSetCeilingMode":
      return (
        <select
          value={String(cfg.mode ?? "stop")}
          onChange={(e) => onChange({ ...cfg, mode: e.target.value })}
          style={PILL}
        >
          <option value="stop">stop (zero vy)</option>
          <option value="preserve">preserve momentum</option>
        </select>
      );
    case "CMSetMirror":
      return (
        <select
          value={String(cfg.mode ?? "off")}
          onChange={(e) => onChange({ ...cfg, mode: e.target.value })}
          style={PILL}
          title="Auto-flip mode: off = no flip; velocity = follow vx sign; input = follow last left/right key"
        >
          <option value="off">off</option>
          <option value="velocity">velocity</option>
          <option value="input">input</option>
        </select>
      );
    case "SetFacing":
      return (
        <select
          value={String(cfg.direction ?? "left")}
          onChange={(e) => onChange({ ...cfg, direction: e.target.value })}
          style={PILL}
          title="Manual mirror direction. Turn AIBrain.autoFaceTarget + CharacterMovement.mirrorMode OFF first if you want full control."
        >
          <option value="left">face left</option>
          <option value="right">face right</option>
          <option value="flip">flip</option>
        </select>
      );
    case "CMSet": {
      // Find the CM param spec so we can render the right input type (number / bool).
      const param = String(cfg.param ?? "maxSpeed");
      const spec = CHARACTER_MOVEMENT_PARAMS.find((p) => p.name === param);
      // Group params for the dropdown.
      const groups = new Map<string, typeof CHARACTER_MOVEMENT_PARAMS>();
      for (const p of CHARACTER_MOVEMENT_PARAMS) {
        const arr = groups.get(p.group) ?? [];
        arr.push(p);
        groups.set(p.group, arr);
      }
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={param}
            onChange={(e) => onChange({ ...cfg, param: e.target.value })}
            style={PILL}
          >
            {Array.from(groups.entries()).map(([groupName, params]) => (
              <optgroup key={groupName} label={groupName}>
                {params.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
              </optgroup>
            ))}
          </select>
          <span style={muted}>=</span>
          {spec?.bool ? (
            <select
              value={cfg.value === true || cfg.value === 1 || cfg.value === "true" ? "true" : "false"}
              onChange={(e) => onChange({ ...cfg, value: e.target.value === "true" ? 1 : 0 })}
              style={PILL}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <ExpressionField
              step={spec?.step ? String(spec.step) : "any"}
              value={(cfg.value as number) ?? (spec?.default ?? 0)}
              onChange={(n) => onChange({ ...cfg, value: n })}
              style={{ ...PILL, width: 80 }}
            />
          )}
        </span>
      );
    }
    case "CMIgnoreInput":
      return (
        <select
          value={cfg.ignore === "toggle" ? "toggle" : (cfg.ignore === false || cfg.ignore === "false" || cfg.ignore === "off") ? "off" : "on"}
          onChange={(e) => onChange({ ...cfg, ignore: e.target.value })}
          style={PILL}
        >
          <option value="on">ignore</option>
          <option value="off">allow</option>
          <option value="toggle">toggle</option>
        </select>
      );
    case "CMSimulateControl":
      return (
        <select
          value={String(cfg.control ?? "jump")}
          onChange={(e) => onChange({ ...cfg, control: e.target.value })}
          style={PILL}
        >
          <option value="left">left</option>
          <option value="right">right</option>
          <option value="jump">jump</option>
          <option value="dash">dash</option>
        </select>
      );
    case "Log":
      return (
        <input
          value={(cfg.message as string) ?? ""}
          onChange={(e) => onChange({ ...cfg, message: e.target.value })}
          placeholder="message"
          style={{ ...PILL, minWidth: 120 }}
        />
      );
    case "PrintString":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input value={String(cfg.message ?? "")} onChange={(e) => onChange({ ...cfg, message: e.target.value })} placeholder="message" style={{ ...PILL, minWidth: 140 }} />
          <ExpressionField step="0.1" value={(cfg.duration as number) ?? 2} onChange={(n) => onChange({ ...cfg, duration: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>SEC</span>
          <input type="color" value={typeof cfg.color === "string" ? cfg.color : "#00ff88"} onChange={(e) => onChange({ ...cfg, color: e.target.value })} style={{ ...PILL, padding: 2, width: 40, height: 28 }} />
        </span>
      );
    case "EmitSignal":
      return (
        <SignalPicker
          value={(cfg.name as string) ?? ""}
          onChange={(v) => onChange({ ...cfg, name: v })}
          placeholder="SignalName"
          mode="emit"
        />
      );
    case "SetVar":
    case "AddVar": {
      const numKey = action.kind === "SetVar" ? "value" : "delta";
      const selectedVar = variables.find((v) => v.name === (cfg.name as string));
      const t = selectedVar?.type ?? "number";
      const isAddOnBool = action.kind === "AddVar" && t === "bool";
      // Free-text name with the host BP's variables as autocomplete.
      // Lets ForEach/Pick chains target variables on the PICKED sprite
      // (whose vars aren't in this BP's `variables` list) — type just
      // the name. Runtime resolves `sprite.vars.get(name)` against
      // whichever sprite the action ends up running on. Type-aware
      // value input below falls back to "number" when the typed name
      // isn't on this BP — string / bool variables on a picked target
      // are coerced at runtime via `SetVar`'s typeof-cur switch.
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            list="peaky-bp-var-suggestions"
            value={(cfg.name as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, name: e.target.value })}
            placeholder="varName"
            style={{ ...PILL, minWidth: 110 }}
            title={variables.length === 0
              ? "No variables defined on this BP. Type a name — at runtime the action targets the picked sprite's variable."
              : "Pick from this BP's variables, or type any name to target a picked sprite's variable (e.g. with ForEach)."}
          />
          <datalist id="peaky-bp-var-suggestions">
            {variables.map((v) => <option key={v.id} value={v.name}>{`<${v.type}>`}</option>)}
          </datalist>
          <span style={muted}>
            {action.kind === "SetVar" ? "=" : "+="}
          </span>
          {isAddOnBool ? (
            <span style={{ ...muted, fontStyle: "italic" }} title="AddVar on a bool variable is a no-op — use SetVar to flip it.">
              (NO-OP)
            </span>
          ) : t === "string" ? (
            <input
              value={String(cfg[numKey] ?? "")}
              onChange={(e) => onChange({ ...cfg, [numKey]: e.target.value })}
              style={{ ...PILL, minWidth: 80 }}
              placeholder={action.kind === "SetVar" ? "value" : "append"}
            />
          ) : t === "bool" ? (
            <select
              value={cfg[numKey] === true || cfg[numKey] === "true" || cfg[numKey] === 1 ? "true" : "false"}
              onChange={(e) => onChange({ ...cfg, [numKey]: e.target.value === "true" })}
              style={PILL}
            >
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          ) : (
            // Number typed variables — text input (NOT NumberField) so users
            // can write expressions like `$var:hp`, `tracer:TracerA.hitX`,
            // `5`, etc. Runtime `numOr` parses literals and references both.
            // Stores as string when the user types a reference, as number
            // when the user types a numeric literal — keeps the JSON small
            // and matches existing literal-number storage.
            <input
              value={typeof cfg[numKey] === "number" ? String(cfg[numKey]) : (cfg[numKey] as string ?? "")}
              onChange={(e) => {
                const raw = e.target.value;
                const n = Number(raw);
                const stored = raw !== "" && !Number.isNaN(n) && !raw.startsWith("$") && !raw.includes(":")
                  ? n
                  : raw;
                onChange({ ...cfg, [numKey]: stored });
              }}
              placeholder="5 / $var:hp / tracer:T.hitX"
              style={{ ...PILL, minWidth: 110 }}
              title="Number literal, $var:name reference, or tracer:Name.field reference."
            />
          )}
        </span>
      );
    }
    case "Destroy":
      return <span style={{ ...muted, fontStyle: "italic" }}>DESTROYS THIS INSTANCE</span>;
    case "SetBehaviorParam": {
      const paramOpts = flatBehaviorParamOptions();
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={(cfg.target as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, target: e.target.value })}
            style={{ ...PILL, minWidth: 220 }}
          >
            <option value="">— pick behavior.param —</option>
            {paramOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <ExpressionField value={(cfg.value as number) ?? 0} onChange={(n) => onChange({ ...cfg, value: n })} style={{ ...PILL, width: 70 }} />
        </span>
      );
    }
    case "SetBehaviorEnabled": {
      const behaviorKinds = Object.keys(BEHAVIOR_PARAMS) as BehaviorKind[];
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={(cfg.behavior as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, behavior: e.target.value })}
            style={{ ...PILL, minWidth: 160 }}
          >
            <option value="">— pick behavior —</option>
            {behaviorKinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select
            value={String(cfg.enabled ?? 1)}
            onChange={(e) => onChange({ ...cfg, enabled: Number(e.target.value) })}
            style={PILL}
          >
            <option value="1">enabled</option>
            <option value="0">disabled</option>
          </select>
        </span>
      );
    }
    case "SetEventGroupEnabled": {
      const currentGroup = (cfg.group as string) ?? "";
      const knownGroup = groupNames.includes(currentGroup);
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {groupNames.length === 0 ? (
            <input
              value={currentGroup}
              onChange={(e) => onChange({ ...cfg, group: e.target.value })}
              placeholder="(no groups defined)"
              style={{ ...PILL, minWidth: 140 }}
              title="Define event groups in the Events section first"
            />
          ) : (
            <select
              value={currentGroup}
              onChange={(e) => onChange({ ...cfg, group: e.target.value })}
              style={PILL}
            >
              <option value="">— pick group —</option>
              {!knownGroup && currentGroup && (
                <option value={currentGroup}>{currentGroup} (unknown)</option>
              )}
              {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          )}
          <select
            value={String(cfg.enabled ?? 1)}
            onChange={(e) => onChange({ ...cfg, enabled: Number(e.target.value) })}
            style={PILL}
          >
            <option value="1">enable</option>
            <option value="0">disable</option>
          </select>
        </span>
      );
    }
    case "SetText":
    case "AppendText":
      return (
        <input
          value={(cfg.text as string) ?? ""}
          onChange={(e) => onChange({ ...cfg, text: e.target.value })}
          placeholder="text or $var:name"
          style={{ ...PILL, minWidth: 180 }}
          title="Literal string. Use $var:name to interpolate a blueprint variable."
        />
      );
    case "SetFontFamily":
      return (
        <input
          value={(cfg.family as string) ?? "Arial"}
          onChange={(e) => onChange({ ...cfg, family: e.target.value })}
          placeholder="Arial, Courier New…"
          style={{ ...PILL, width: 160 }}
        />
      );
    case "SetFontSize":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField value={(cfg.size as number) ?? 16} onChange={(n) => onChange({ ...cfg, size: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>PX</span>
        </span>
      );
    case "SetTextColor":
      return (
        <input
          type="color"
          value={`#${((cfg.color as number) ?? 0xffffff).toString(16).padStart(6, "0")}`}
          onChange={(e) => onChange({ ...cfg, color: parseInt(e.target.value.slice(1), 16) })}
          style={{ ...PILL, padding: 2, width: 40, height: 28, cursor: "pointer" }}
        />
      );
    case "SetBold":
    case "SetItalic":
      return (
        <select
          value={String(cfg.value ?? 1)}
          onChange={(e) => onChange({ ...cfg, value: Number(e.target.value) })}
          style={PILL}
        >
          <option value="1">on</option>
          <option value="0">off</option>
        </select>
      );
    case "SetAlignH":
      return (
        <select
          value={(cfg.align as string) ?? "left"}
          onChange={(e) => onChange({ ...cfg, align: e.target.value })}
          style={PILL}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      );
    case "SetAlignV":
      return (
        <select
          value={(cfg.align as string) ?? "top"}
          onChange={(e) => onChange({ ...cfg, align: e.target.value })}
          style={PILL}
        >
          <option value="top">top</option>
          <option value="middle">middle</option>
          <option value="bottom">bottom</option>
        </select>
      );
    case "SetWrapWidth":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField value={(cfg.width as number) ?? 0} onChange={(n) => onChange({ ...cfg, width: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>PX (0=off)</span>
        </span>
      );
    case "SetTextVisible":
      return (
        <select
          value={String(cfg.visible ?? 1)}
          onChange={(e) => onChange({ ...cfg, visible: Number(e.target.value) })}
          style={PILL}
        >
          <option value="1">show</option>
          <option value="0">hide</option>
        </select>
      );
    case "ShowText":
    case "HideText":
    case "StopAllAnimatorAnims":
      return null;
    case "PlayAnimatorAnim":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>name</span>
          <input
            value={String((cfg.name as string) ?? "")}
            onChange={(e) => onChange({ ...cfg, name: e.target.value })}
            placeholder="animation name"
            style={{ ...PILL, width: 130 }}
            title="Name of the animation defined on the host's Smart Tween component."
          />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }} title="When checked, restart the animation from the start on every call. When unchecked, skip the call if it's already playing — useful so a one-shot finishes cleanly before re-triggering.">
            <Toggle
              value={cfg.override === undefined ? true : !!cfg.override}
              onChange={(v) => onChange({ ...cfg, override: v ? 1 : 0 })}
            />
            OVERRIDE
          </label>
        </span>
      );
    case "StopAnimatorAnim":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>name</span>
          <input
            value={String((cfg.name as string) ?? "")}
            onChange={(e) => onChange({ ...cfg, name: e.target.value })}
            placeholder="animation name"
            style={{ ...PILL, width: 130 }}
            title="Name of the animation defined on the host's Smart Tween component."
          />
        </span>
      );
    case "InteractWithNPC":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>uid</span>
          <ExpressionField
            value={cfg.uid as string | number | undefined}
            onChange={(n) => onChange({ ...cfg, uid: n })}
            style={{ ...PILL, width: 140 }}
            title="Sprite UID of the NPC to interact with. Use `tracer:InteractionChecker.actorUid` to bridge from a tracer hit, or a literal number for direct testing."
          />
        </span>
      );
    // ── Camera ──
    case "CameraSetTarget":
    case "CameraPanToTag":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            value={(cfg.tag as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, tag: e.target.value })}
            placeholder="tag name"
            list="peaky-tag-suggestions"
            style={{ ...PILL, width: 130 }}
          />
          {action.kind === "CameraPanToTag" && (
            <>
              <span style={muted}>over</span>
              <ExpressionField step="0.1" value={(cfg.duration as number) ?? 1}
                onChange={(n) => onChange({ ...cfg, duration: n })}
                style={{ ...PILL, width: 60 }} />
              <span style={muted}>SEC</span>
            </>
          )}
        </span>
      );
    case "CameraShake":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.duration as number) ?? 0.3}
            onChange={(n) => onChange({ ...cfg, duration: n })}
            style={{ ...PILL, width: 60 }} />
          <span style={muted}>SEC ·</span>
          <ExpressionField value={(cfg.intensity as number) ?? 5}
            onChange={(n) => onChange({ ...cfg, intensity: n })}
            style={{ ...PILL, width: 60 }} />
          <span style={muted}>PX</span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }}>
            <Toggle value={cfg.forceRestart === true} onChange={(v) => onChange({ ...cfg, forceRestart: v })} />
            override
          </label>
        </span>
      );
    case "CameraSetSmoothing":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.value as number) ?? 0.1}
            onChange={(n) => onChange({ ...cfg, value: n })}
            style={{ ...PILL, width: 70 }} />
          <span style={muted}>(0=instant, 1=floaty)</span>
        </span>
      );
    case "CameraSetOffset":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 60 }} />
        </span>
      );
    case "CameraSetZoom":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.1" value={(cfg.zoom as number) ?? 1}
            onChange={(n) => onChange({ ...cfg, zoom: n })}
            style={{ ...PILL, width: 70 }} />
          <span style={muted}>×</span>
        </span>
      );
    case "CameraSetFollowAxes":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <select value={String(cfg.followX ?? 1)} onChange={(e) => onChange({ ...cfg, followX: Number(e.target.value) })} style={PILL}>
            <option value="1">on</option>
            <option value="0">off</option>
          </select>
          <span style={muted}>Y</span>
          <select value={String(cfg.followY ?? 1)} onChange={(e) => onChange({ ...cfg, followY: Number(e.target.value) })} style={PILL}>
            <option value="1">on</option>
            <option value="0">off</option>
          </select>
        </span>
      );
    case "CameraFlash":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.duration as number) ?? 0.25}
            onChange={(n) => onChange({ ...cfg, duration: n })}
            style={{ ...PILL, width: 60 }} />
          <span style={muted}>SEC</span>
          <input
            type="color"
            value={`#${((cfg.color as number) ?? 0xffffff).toString(16).padStart(6, "0")}`}
            onChange={(e) => onChange({ ...cfg, color: parseInt(e.target.value.slice(1), 16) })}
            style={{ ...PILL, padding: 2, width: 40, height: 28, cursor: "pointer" }}
          />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }}>
            <Toggle value={cfg.forceRestart === true} onChange={(v) => onChange({ ...cfg, forceRestart: v })} />
            override
          </label>
        </span>
      );
    case "CameraFade":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <ExpressionField step="0.05" value={(cfg.duration as number) ?? 0.5}
            onChange={(n) => onChange({ ...cfg, duration: n })}
            style={{ ...PILL, width: 60 }} />
          <span style={muted}>SEC</span>
          <input
            type="color"
            value={`#${((cfg.color as number) ?? 0).toString(16).padStart(6, "0")}`}
            onChange={(e) => onChange({ ...cfg, color: parseInt(e.target.value.slice(1), 16) })}
            style={{ ...PILL, padding: 2, width: 40, height: 28, cursor: "pointer" }}
          />
          <select value={String(cfg.fadeOut ?? 1)}
            onChange={(e) => onChange({ ...cfg, fadeOut: Number(e.target.value) })} style={PILL}>
            <option value="1">fade out</option>
            <option value="0">fade in</option>
          </select>
        </span>
      );
    case "CameraPanTo":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>over</span>
          <ExpressionField step="0.1" value={(cfg.duration as number) ?? 1}
            onChange={(n) => onChange({ ...cfg, duration: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>SEC</span>
        </span>
      );
    case "CameraSetTargetSelf":
    case "CameraStopFollow":
    case "CameraStopShake":
    case "CameraLock":
    case "CameraUnlock":
      return null;
    // ── Tracer ──
    case "TracerGetResult": {
      // Three dropdowns: pick tracer name, pick which hit field, pick var.
      // The variable list is filtered by compatible type for the chosen
      // field — only string vars when reading actorName, only numeric vars
      // otherwise (matches what the runtime stores).
      const field = (cfg.field as string) ?? "hitX";
      const stringField = field === "actorName" || field === "actorTags";
      const eligibleVars = variables.filter((v) =>
        stringField ? v.type === "string" : v.type === "number",
      );
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>FROM</span>
          <input
            value={(cfg.tracer as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, tracer: e.target.value })}
            placeholder="(default)"
            style={{ ...PILL, width: 110 }}
            title="Tracer name (matches the Name field on the Tracer component). Empty = first attached Tracer."
          />
          <span style={muted}>·</span>
          <select
            value={field}
            onChange={(e) => onChange({ ...cfg, field: e.target.value })}
            style={PILL}
            title="Which hit field to read."
          >
            <option value="hit">hit (1/0)</option>
            <option value="hitX">hit point X</option>
            <option value="hitY">hit point Y</option>
            <option value="actorX">actor X</option>
            <option value="actorY">actor Y</option>
            <option value="actorName">actor name</option>
            <option value="actorUid">actor UID</option>
            <option value="actorTags">actor tags (csv)</option>
            <option value="distance">distance</option>
            <option value="startX">trace start X</option>
            <option value="startY">trace start Y</option>
            <option value="endX">trace end X</option>
            <option value="endY">trace end Y</option>
          </select>
          <span style={muted}>→</span>
          {eligibleVars.length === 0 ? (
            <span style={{ color: "var(--red)", fontFamily: MONO, fontSize: 11, fontWeight: 700 }}>
              NO {stringField ? "STRING" : "NUMBER"} VARS
            </span>
          ) : (
            <select
              value={(cfg.varName as string) ?? ""}
              onChange={(e) => onChange({ ...cfg, varName: e.target.value })}
              style={PILL}
              title="Variable to write the field's value into."
            >
              <option value="" disabled>(var)</option>
              {eligibleVars.map((v) => <option key={v.id} value={v.name}>{`${v.name} <${v.type}>`}</option>)}
            </select>
          )}
        </span>
      );
    }
    // ── Cross-object communication ──
    case "EmitSignalTo": {
      // Read tags from `cfg.tags` (array) preferred, fall back to `cfg.tag`
      // (legacy single-string, comma-split). Editing always writes back to
      // `cfg.tags`; the legacy `cfg.tag` is cleared so the array becomes the
      // single source of truth going forward.
      const rawTags = Array.isArray(cfg.tags) ? (cfg.tags as string[])
        : typeof cfg.tag === "string" && cfg.tag
          ? cfg.tag.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>TO TAGS</span>
          <span style={{ minWidth: 160 }}>
            <TagChips
              tags={rawTags}
              onChange={(next) => onChange({ ...cfg, tags: next, tag: undefined })}
              placeholder="tag (or use UID)"
            />
          </span>
          <span style={muted}>OR UID</span>
          <input
            value={(cfg.uid as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, uid: e.target.value })}
            placeholder="uid"
            style={{ ...PILL, width: 70 }}
            title="Specific instance UID. UID wins if both are set."
          />
          <span style={muted}>SIGNAL</span>
          <SignalPicker
            value={(cfg.signal as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, signal: v })}
            placeholder="SignalName"
            style={{ minWidth: 150 }}
            mode="emit"
          />
        </span>
      );
    }
    case "SetVarOn": {
      const rawTags = Array.isArray(cfg.tags) ? (cfg.tags as string[])
        : typeof cfg.tag === "string" && cfg.tag
          ? cfg.tag.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>ON TAGS</span>
          <span style={{ minWidth: 160 }}>
            <TagChips
              tags={rawTags}
              onChange={(next) => onChange({ ...cfg, tags: next, tag: undefined })}
              placeholder="tag (or use UID)"
            />
          </span>
          <span style={muted}>OR UID</span>
          <input
            value={(cfg.uid as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, uid: e.target.value })}
            placeholder="uid"
            style={{ ...PILL, width: 70 }}
            title="Specific instance UID. UID wins if both are set."
          />
          <span style={muted}>VAR</span>
          <input
            value={(cfg.name as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, name: e.target.value })}
            placeholder="varName"
            style={{ ...PILL, width: 100 }}
            title="Variable name on the receiver. Type is auto-detected from the receiver's existing value."
          />
          <span style={muted}>=</span>
          <input
            value={String(cfg.value ?? "")}
            onChange={(e) => onChange({ ...cfg, value: e.target.value })}
            placeholder="value / $var:x / tracer:T.f"
            style={{ ...PILL, width: 140 }}
            title="Literal, $var:name, or tracer:Name.field. Coerced to receiver's var type at runtime."
          />
        </span>
      );
    }
    // ── Position / Tween ──
    case "SetPosition":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <input value={String(cfg.x ?? "0")} onChange={(e) => onChange({ ...cfg, x: e.target.value })}
            placeholder="0 / $var:x" style={{ ...PILL, width: 90 }} />
          <span style={muted}>Y</span>
          <input value={String(cfg.y ?? "0")} onChange={(e) => onChange({ ...cfg, y: e.target.value })}
            placeholder="0 / $var:y" style={{ ...PILL, width: 90 }} />
        </span>
      );
    case "SetPositionX":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X =</span>
          <input value={String(cfg.x ?? "0")} onChange={(e) => onChange({ ...cfg, x: e.target.value })}
            placeholder="0 / $var:x" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "SetPositionY":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>Y =</span>
          <input value={String(cfg.y ?? "0")} onChange={(e) => onChange({ ...cfg, y: e.target.value })}
            placeholder="0 / $var:y" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "SetAngle":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>ANGLE =</span>
          <input value={String(cfg.angle ?? "0")} onChange={(e) => onChange({ ...cfg, angle: e.target.value })}
            placeholder="0 / $var:rot" style={{ ...PILL, width: 110 }} />
          <span style={muted}>°</span>
        </span>
      );
    case "SetScale":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>SCALE =</span>
          <input value={String(cfg.scale ?? "1")} onChange={(e) => onChange({ ...cfg, scale: e.target.value })}
            placeholder="1 / $var:s" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "SetScaleX":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>SCALE X =</span>
          <input value={String(cfg.scaleX ?? "1")} onChange={(e) => onChange({ ...cfg, scaleX: e.target.value })}
            placeholder="1 / $var:sx" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "SetScaleY":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>SCALE Y =</span>
          <input value={String(cfg.scaleY ?? "1")} onChange={(e) => onChange({ ...cfg, scaleY: e.target.value })}
            placeholder="1 / $var:sy" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "SetOpacity":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>ALPHA =</span>
          <input value={String(cfg.alpha ?? "1")} onChange={(e) => onChange({ ...cfg, alpha: e.target.value })}
            placeholder="0..1" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "MoveToLayer":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>LAYER</span>
          <select value={(cfg.layer as string) ?? ""} onChange={(e) => onChange({ ...cfg, layer: e.target.value })} style={{ ...PILL, width: 160 }}>
            <option value="">— pick layer —</option>
            {allLayerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </span>
      );
    case "SetZOrder":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>DEPTH =</span>
          <input value={String(cfg.depth ?? "0")} onChange={(e) => onChange({ ...cfg, depth: e.target.value })}
            placeholder="0 / $var:z" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "Tween":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <datalist id="peaky-tween-tag-suggestions">
            {allTweenTags.map((t) => <option key={t} value={t} />)}
          </datalist>
          <span style={muted}>TAG</span>
          <input value={(cfg.tag as string) ?? ""} onChange={(e) => onChange({ ...cfg, tag: e.target.value })}
            placeholder="tweenTag" list="peaky-tween-tag-suggestions" style={{ ...PILL, width: 100 }} />
          <select value={(cfg.property as string) ?? "position.x"} onChange={(e) => onChange({ ...cfg, property: e.target.value })} style={PILL}>
            <option value="position.x">position.x</option>
            <option value="position.y">position.y</option>
            <option value="scale">scale</option>
            <option value="scaleX">scaleX</option>
            <option value="scaleY">scaleY</option>
            <option value="alpha">alpha</option>
            <option value="angle">angle</option>
          </select>
          <span style={muted}>→</span>
          <input value={String(cfg.to ?? "0")} onChange={(e) => onChange({ ...cfg, to: e.target.value })}
            placeholder="value" style={{ ...PILL, width: 80 }} />
          <span style={muted}>OVER</span>
          <input value={String(cfg.duration ?? "0.5")} onChange={(e) => onChange({ ...cfg, duration: e.target.value })}
            placeholder="0.5" style={{ ...PILL, width: 60 }} />
          <span style={muted}>S</span>
          <select value={(cfg.ease as string) ?? "Sine.easeOut"} onChange={(e) => onChange({ ...cfg, ease: e.target.value })} style={PILL}>
            <option value="Linear">Linear</option>
            <option value="Sine.easeIn">Sine.easeIn</option>
            <option value="Sine.easeOut">Sine.easeOut</option>
            <option value="Sine.easeInOut">Sine.easeInOut</option>
            <option value="Quad.easeIn">Quad.easeIn</option>
            <option value="Quad.easeOut">Quad.easeOut</option>
            <option value="Quad.easeInOut">Quad.easeInOut</option>
            <option value="Cubic.easeIn">Cubic.easeIn</option>
            <option value="Cubic.easeOut">Cubic.easeOut</option>
            <option value="Cubic.easeInOut">Cubic.easeInOut</option>
            <option value="Bounce.easeOut">Bounce.easeOut</option>
            <option value="Back.easeOut">Back.easeOut</option>
          </select>
          <span style={muted}>REPEAT</span>
          <input type="number" value={String(cfg.repeat ?? "0")} onChange={(e) => onChange({ ...cfg, repeat: Number(e.target.value) })}
            placeholder="0 / -1" style={{ ...PILL, width: 60 }} title="-1 = infinite, 0 = play once, N = play N+1 times" />
          <label style={{ ...muted, display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }} title="Yoyo / ping-pong: at end, reverse back to start">
            <Toggle value={Number(cfg.yoyo ?? 0) !== 0} onChange={(v) => onChange({ ...cfg, yoyo: v ? 1 : 0 })} />
            YOYO
          </label>
        </span>
      );
    case "TweenSetEndValue":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>TAG</span>
          <input value={(cfg.tag as string) ?? ""} onChange={(e) => onChange({ ...cfg, tag: e.target.value })}
            placeholder="tweenTag" list="peaky-tween-tag-suggestions" style={{ ...PILL, width: 110 }} />
          <span style={muted}>→</span>
          <input value={String(cfg.to ?? "0")} onChange={(e) => onChange({ ...cfg, to: e.target.value })}
            placeholder="new target value" style={{ ...PILL, width: 110 }} />
        </span>
      );
    case "TweenStop":
    case "TweenPause":
    case "TweenResume":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>TAG</span>
          <input value={(cfg.tag as string) ?? ""} onChange={(e) => onChange({ ...cfg, tag: e.target.value })}
            placeholder="tweenTag" list="peaky-tween-tag-suggestions" style={{ ...PILL, width: 130 }} />
        </span>
      );
    case "TweenStopAll":
    case "TweenPauseAll":
    case "TweenResumeAll":
      return <span style={{ ...muted, fontStyle: "italic" }}>(all tweens)</span>;
    case "PlayDialogue":
      // Dropdown of dialogues. Rendered with a custom DialoguePicker below
      // when the parent has the project context; here we just show a
      // compact pill so the row stays readable. The full picker lives on
      // the action's expanded config view.
      return <DialoguePickerPill cfg={cfg} onChange={(c) => onChange(c)} />;
    case "StopDialogue":
      return <span style={{ ...muted, fontStyle: "italic" }}>(current dialogue)</span>;
    case "PlaySquashStretch":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={(cfg.kind as string) ?? "both"}
            onChange={(e) => onChange({ ...cfg, kind: e.target.value })}
            style={{ ...ACTION_PILL, width: 90 }}
            title="both = squash → stretch → return. squash / stretch = single deform + return."
          >
            <option value="both">both</option>
            <option value="squash">squash</option>
            <option value="stretch">stretch</option>
          </select>
          <span style={muted}>amt</span>
          <ExpressionField
            value={cfg.intensity as string | number | undefined}
            onChange={(n) => onChange({ ...cfg, intensity: n })}
            style={{ ...ACTION_PILL, width: 50 }}
          />
          <span style={muted}>dur</span>
          <ExpressionField
            value={cfg.duration as string | number | undefined}
            onChange={(n) => onChange({ ...cfg, duration: n })}
            style={{ ...ACTION_PILL, width: 60 }}
          />
          <span style={muted}>ease</span>
          <select
            value={(cfg.easing as string) || "Quad.Out"}
            onChange={(e) => onChange({ ...cfg, easing: e.target.value })}
            style={{ ...ACTION_PILL, width: 110 }}
            title="Easing curve applied to each phase of the timeline."
          >
            <option value="Linear">Linear</option>
            <option value="Quad.In">Quad.In</option>
            <option value="Quad.Out">Quad.Out</option>
            <option value="Quad.InOut">Quad.InOut</option>
            <option value="Cubic.In">Cubic.In</option>
            <option value="Cubic.Out">Cubic.Out</option>
            <option value="Cubic.InOut">Cubic.InOut</option>
            <option value="Sine.In">Sine.In</option>
            <option value="Sine.Out">Sine.Out</option>
            <option value="Sine.InOut">Sine.InOut</option>
            <option value="Back.Out">Back.Out</option>
            <option value="Bounce.Out">Bounce.Out</option>
            <option value="Elastic.Out">Elastic.Out</option>
          </select>
        </span>
      );
    case "SetUIText":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <UITargetSelect
            value={(cfg.target as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, target: v })}
            groups={uiTargetGroups}
          />
          <span style={muted}>=</span>
          <input
            value={(cfg.text as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, text: e.target.value })}
            placeholder='"new content"'
            style={{ ...PILL, width: 200 }}
          />
        </span>
      );
    case "SetUIValue":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <UITargetSelect
            value={(cfg.target as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, target: v })}
            groups={uiTargetGroups}
          />
          <span style={muted}>=</span>
          <input
            value={String(cfg.value ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              const n = Number(v);
              onChange({ ...cfg, value: v.trim() !== "" && Number.isFinite(n) ? n : v });
            }}
            placeholder="50  or  var:hp"
            style={{ ...PILL, width: 160 }}
          />
        </span>
      );
    case "SetUISelectedValue":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>DROPDOWN</span>
          <UITargetSelect
            value={(cfg.target as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, target: v })}
            groups={uiTargetGroups}
          />
          <span style={muted}>→</span>
          <input
            value={(cfg.value as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, value: e.target.value })}
            placeholder='option value'
            style={{ ...PILL, width: 140 }}
          />
        </span>
      );
    case "SetUIVisible":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <UITargetSelect
            value={(cfg.target as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, target: v })}
            groups={uiTargetGroups}
          />
          <select
            value={String(cfg.visible ?? 1)}
            onChange={(e) => onChange({ ...cfg, visible: Number(e.target.value) })}
            style={{ ...PILL, width: 80 }}
          >
            <option value="1">show</option>
            <option value="0">hide</option>
          </select>
        </span>
      );
    case "SetUIBgColor":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <UITargetSelect
            value={(cfg.target as string) ?? ""}
            onChange={(v) => onChange({ ...cfg, target: v })}
            groups={uiTargetGroups}
          />
          <input
            type="color"
            value={`#${((cfg.color as number) ?? 0xffffff).toString(16).padStart(6, "0")}`}
            onChange={(e) => onChange({ ...cfg, color: parseInt(e.target.value.slice(1), 16) })}
            style={{ ...PILL, padding: 2, width: 50, height: 28, cursor: "pointer" }}
          />
        </span>
      );
    case "CreateUIWidget":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <select
            value={(cfg.widgetName as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, widgetName: e.target.value })}
            style={{ ...PILL, width: 160 }}
          >
            <option value="">— pick widget —</option>
            {uiWidgets.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
          </select>
          <span style={muted}>X</span>
          <ExpressionField value={(cfg.x as number) ?? 0} onChange={(n) => onChange({ ...cfg, x: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>Y</span>
          <ExpressionField value={(cfg.y as number) ?? 0} onChange={(n) => onChange({ ...cfg, y: n })} style={{ ...PILL, width: 60 }} />
          <span style={muted}>LAYER</span>
          <select value={String(cfg.layer ?? "")} onChange={(e) => onChange({ ...cfg, layer: e.target.value })} style={{ ...PILL, width: 130 }}>
            <option value="">(active)</option>
            {allLayerNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </span>
      );
    case "DestroyUIWidget":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>WIDGET</span>
          <input
            value={(cfg.target as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, target: e.target.value })}
            placeholder="WidgetName"
            list="peaky-widget-name-suggestions"
            style={{ ...PILL, width: 160 }}
          />
          <datalist id="peaky-widget-name-suggestions">
            {uiWidgets.map((w) => <option key={w.id} value={w.name} />)}
          </datalist>
        </span>
      );
    case "QuitGame":
      return <span style={{ ...muted, fontStyle: "italic" }}>(quit)</span>;
    case "BlurScene":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>STRENGTH</span>
          <ExpressionField
            value={cfg.strength as string | number | undefined}
            onChange={(s) => onChange({ ...cfg, strength: s })}
            style={{ ...PILL, width: 60 }}
          />
          <span style={{ ...muted, fontStyle: "italic" }}>0 = remove</span>
        </span>
      );
    case "SetCursor":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={muted}>STYLE</span>
          <select
            value={(cfg.style as string) ?? "default"}
            onChange={(e) => onChange({ ...cfg, style: e.target.value })}
            style={{ ...PILL, width: 130 }}
            title="CSS cursor style. Common values: default, pointer, crosshair, none, text, move, grab, grabbing, wait, help, not-allowed."
          >
            <option value="default">default</option>
            <option value="pointer">pointer (hand)</option>
            <option value="crosshair">crosshair</option>
            <option value="text">text (I-beam)</option>
            <option value="move">move</option>
            <option value="grab">grab</option>
            <option value="grabbing">grabbing</option>
            <option value="wait">wait</option>
            <option value="help">help</option>
            <option value="not-allowed">not-allowed</option>
            <option value="none">none (hidden)</option>
          </select>
        </span>
      );
    case "ResetCursor":
    case "HideCursor":
    case "ShowCursor":
    case "StartParticles":
    case "StopParticles":
      return <span style={{ ...muted, fontStyle: "italic" }}>(no params)</span>;
    case "BurstParticles":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>COUNT</span>
          <input value={String(cfg.count ?? "30")} onChange={(e) => onChange({ ...cfg, count: e.target.value })}
            placeholder="30" style={{ ...PILL, width: 70 }} />
        </span>
      );
    case "SetParticleRate":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>RATE</span>
          <input value={String(cfg.rate ?? "10")} onChange={(e) => onChange({ ...cfg, rate: e.target.value })}
            placeholder="10" style={{ ...PILL, width: 70 }} />
          <span style={muted}>per/s</span>
        </span>
      );
    case "SetParticleSpeed":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>SPEED</span>
          <input value={String(cfg.speed ?? "100")} onChange={(e) => onChange({ ...cfg, speed: e.target.value })}
            placeholder="100" style={{ ...PILL, width: 70 }} />
          <span style={muted}>±</span>
          <input value={String(cfg.jitter ?? "0")} onChange={(e) => onChange({ ...cfg, jitter: e.target.value })}
            placeholder="0" style={{ ...PILL, width: 50 }} />
        </span>
      );
    case "SetParticleGravity":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>X</span>
          <input value={String(cfg.x ?? "0")} onChange={(e) => onChange({ ...cfg, x: e.target.value })}
            placeholder="0" style={{ ...PILL, width: 60 }} />
          <span style={muted}>Y</span>
          <input value={String(cfg.y ?? "0")} onChange={(e) => onChange({ ...cfg, y: e.target.value })}
            placeholder="0" style={{ ...PILL, width: 60 }} />
        </span>
      );
    case "SetParticleSprite":
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span style={muted}>SPRITE</span>
          <input value={(cfg.spriteId as string) ?? ""} onChange={(e) => onChange({ ...cfg, spriteId: e.target.value })}
            placeholder="sprite asset id" style={{ ...PILL, width: 160 }}
            title="Sprite asset id from your project library. Resolved to a Phaser texture key at runtime." />
        </span>
      );
    case "SetStatePriority":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input value={(cfg.state as string) ?? ""} onChange={(e) => onChange({ ...cfg, state: e.target.value })}
            placeholder="state name" style={{ ...PILL, width: 90 }}
            title="State Machine state name. The action looks it up by exact match and writes the new priority. No-op when missing." />
          <span style={{ color: "var(--text-dim)", fontSize: 10 }}>priority</span>
          <input type="number" value={Number(cfg.priority ?? 0)} onChange={(e) => onChange({ ...cfg, priority: Number(e.target.value) || 0 })}
            style={{ ...PILL, width: 60 }} />
        </span>
      );
    case "SetStateEnabled":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <input value={(cfg.state as string) ?? ""} onChange={(e) => onChange({ ...cfg, state: e.target.value })}
            placeholder="state name" style={{ ...PILL, width: 90 }}
            title="State Machine state name. The action toggles its enabled flag — disabled rows are skipped by the priority loop." />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--text-dim)" }}>
            <Toggle value={!!cfg.enabled} onChange={(v) => onChange({ ...cfg, enabled: v })} />
            enabled
          </label>
        </span>
      );
    case "PlayMusic":
    case "StopMusic":
    case "PlaySound":
    case "PlaySounds":
    case "StopSound":
    case "StopAllSounds":
    case "SetMusicVolume":
    case "SetSfxVolume":
    case "SetMasterVolume":
      // Audio actions are authored in the Logic Sheet (node graph), which
      // renders their params generically. This legacy event-sheet pill is
      // kept exhaustive but unused.
      return <span style={{ color: "var(--text-muted)" }}>{action.kind}</span>;
    case "SetUIElement":
      // Per-param-toggle node authored in the Logic Sheet; the event-sheet
      // pill is kept exhaustive but unused.
      return <span style={{ color: "var(--text-muted)" }}>{action.kind}</span>;
    case "SetPaused":
      // Pause/resume node authored in the Logic Sheet; the event-sheet pill
      // is kept exhaustive but unused.
      return <span style={{ color: "var(--text-muted)" }}>{action.kind}</span>;
    case "SetSprite":
      // Authored in the Logic Sheet; event-sheet pill kept exhaustive but unused.
      return <span style={{ color: "var(--text-muted)" }}>{action.kind}</span>;
    case "GiveItem":
    case "TakeItem":
    case "BuyItem":
    case "SellItem":
    case "AddItem":
    case "RemoveItem":
    case "ClearInventory":
    case "GiveItemTo":
    case "GetItemCount":
    case "GetItemProp":
    case "RandomNumber": {
      // Roll a random number into a named variable. min/max accept expressions
      // so authors can drive ranges from other vars. (audit HIGH #11)
      const numVars = variables.filter((v) => v.type === "number");
      return (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <input
            list="peaky-bp-var-suggestions"
            value={(cfg.var as string) ?? ""}
            onChange={(e) => onChange({ ...cfg, var: e.target.value })}
            placeholder="varName"
            style={{ ...PILL, minWidth: 110 }}
            title={numVars.length === 0 ? "No number variables on this BP — type a name." : "Pick a number var or type a name (e.g. for picked targets)."}
          />
          <span style={muted}>MIN</span>
          <ExpressionField value={cfg.min as string | number | undefined} onChange={(n) => onChange({ ...cfg, min: n })} style={{ ...PILL, width: 70 }} />
          <span style={muted}>MAX</span>
          <ExpressionField value={cfg.max as string | number | undefined} onChange={(n) => onChange({ ...cfg, max: n })} style={{ ...PILL, width: 70 }} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 3, ...muted }}>
            <Toggle value={cfg.float === true} onChange={(v) => onChange({ ...cfg, float: v })} />
            FLOAT
          </label>
        </span>
      );
    }
    case "SetGroupActive":
    case "SetActiveStateMachine":
    case "MoveTo":
    case "MoveStop":
    case "TMSet":
    case "TMStop":
    case "TMIgnoreInput":
    case "TMSimulateControl":
    case "SetGlobal":
    case "AddGlobal":
    case "SubGlobal":
    case "GlobalArrayOp":
    case "RestockShop":
    case "ResetWorld":
    case "SetTile":
    case "RemoveTile":
    case "SetTileAtWorld":
    case "RemoveTileAtWorld":
    case "FillTileRect":
    case "ReplaceTile":
    case "RemoveTilesInTracer":
    case "FillTilesInTracer":
    case "PlaceBigTile":
    case "RemoveBigTileAtWorld":
    case "RemoveBigTileAt":
    case "TracerSet":
    case "DamageTile":
    case "DamageTileAtWorld":
    case "MineTileAtWorld":
    case "RestoreTileHP":
    case "PlayTileAnimation":
    case "PlayTileAnimationAtWorld":
    case "StopTileAnimation":
    case "StopTileAnimationAtWorld":
    case "PlayAllTileAnimations":
    case "StopAllTileAnimations":
    case "RemoveAnimatedTileAt":
    case "MoveToSetPosition":
    case "MoveToSetObject":
    case "MoveToSetTag":
    case "MoveToSetAngle":
    case "MoveToStop":
    case "MoveToResume":
    case "MoveToSetSpeed":
    case "GoToLayoutWithLoad":
    case "SetLoadingProgress":
    case "SetLoadingScene":
    case "SetInstanceName":
    case "EditTags":
    case "DebugPrint":
    case "SetPlacementVisible":
    case "SetPlacementFrame":
    case "PlayPlacementAnim":
    case "StopPlacementAnim":
    case "SetPlacementPos":
    case "CreateSpriteObject":
    case "DestroySpriteObject":
    case "SetPlacementScale":
    case "SetPlacementRotation":
    case "SetPlacementAlpha":
    case "SetSpriteObjectColliderEnabled":
    case "SetSpriteObjectSolid":
    case "SetSpriteObjectCollideMode":
    case "AddSpriteObjectTag":
    case "RemoveSpriteObjectTag":
    case "ClearSpriteObjectTags":
    case "AddSpriteObjectCollideTag":
    case "RemoveSpriteObjectCollideTag":
    case "ClearSpriteObjectCollideTags":
    case "SetRecipeEnabled":
    case "AddRecipeIngredient":
    case "RemoveRecipeIngredient":
    case "SetRecipeOutput":
    case "EquipWeapon":
    case "PlayWeaponAnimation":
    case "ApplyDamage":
    case "Heal":
    case "SetScreenEffect":
    case "Dismember":
    case "MoveToNavPoint":
    case "PatrolNavPoints":
    case "PlaceBigTileAtWorld":
    case "PlaceAnimatedTileAtWorld":
    case "SetAmbientLight":
    case "TweenVar":
    case "TweenParam":
    case "SetVisible":
      // Logic-Sheet-only actions; pill kept exhaustive (no event-sheet UI).
      return <span style={{ color: "var(--text-muted)" }}>{action.kind}</span>;
    default: {
      const _e: never = action.kind;
      return <span style={{ color: "var(--text-muted)" }}>{String(_e)}</span>;
    }
  }
}

/** Inline picker for the PlayDialogue action — shows the selected dialogue
 *  name with a dropdown to swap to another. */
function DialoguePickerPill({
  cfg,
  onChange,
}: {
  cfg: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
}) {
  const dialogues = useEditor((s) => s.project.dialogues);
  const id = String(cfg.dialogueId ?? "");
  const sel = dialogues.find((d) => d.id === id);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <select
        value={id}
        onChange={(e) => onChange({ ...cfg, dialogueId: e.target.value })}
        style={{ ...ACTION_PILL, width: 160 }}
      >
        <option value="">— pick dialogue —</option>
        {!sel && id && <option value={id}>{id} (missing)</option>}
        {dialogues.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
    </span>
  );
}

/**
 * UI Widget target picker for SetUI* actions. Renders as a `<select>`
 * with one `<optgroup>` per widget — the group label is the widget's
 * name (bold by default, browser-rendered), entries inside are the
 * widget itself ("— whole widget —") plus each named child. Browser
 * indents children visually under the group header.
 *
 * Empty value = "(self)" — the widget that owns the event sheet.
 * Custom value (an instance label set in the scene editor) preserves
 * via the "(custom: …)" option that's added to the front of the list
 * when `value` doesn't match any known target — so the dropdown still
 * shows the user's pick even when it's something we didn't suggest.
 */
function UITargetSelect({
  value, onChange, groups,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: Array<{ widget: string; entries: Array<{ value: string; label: string }> }>;
}) {
  const PILL = ACTION_PILL;
  const knownValues = new Set<string>([""]);
  for (const g of groups) for (const e of g.entries) knownValues.add(e.value);
  const isCustom = value !== "" && !knownValues.has(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...PILL, minWidth: 180 }}
      title="Pick the widget or child to target. Empty = self (the widget owning this event sheet)."
    >
      <option value="">(self)</option>
      {isCustom && <option value={value}>(custom: {value})</option>}
      {groups.map((g) => (
        <optgroup key={g.widget} label={g.widget}>
          {g.entries.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
