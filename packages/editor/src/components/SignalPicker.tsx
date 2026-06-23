import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BUILT_IN_SIGNALS_REGISTRY, type BuiltInSignal } from "@peaky/shared";
import { COMPONENT_THEME } from "../panels/inspector/LogicSheet/nodeRegistry";
import { useEditor } from "../store";
import { collectEmittedSignalNames } from "../project";

/**
 * Grouped signal picker — replaces the bare `<input list=…>` pattern across
 * the editor. Shows every signal the runtime emits AND every user-declared
 * project signal, each chipped with its source subsystem so authors can
 * scan-by-color. Free-text typing is preserved at the bottom so ad-hoc
 * signals (custom CharacterMovement event triggers, dynamic dialog
 * cues, etc.) don't need to be pre-declared.
 *
 * Source labels reuse `COMPONENT_THEME` so the chip colors match what the
 * Logic Sheet uses for action / condition nodes — one mental map.
 */
export function SignalPicker({
  value, onChange, placeholder, style, mode = "listen", forBpId, compact, clearable,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  /** Shrink the closed button to fit a narrow grid column (drops the
   *  140px min-width + trims padding). The portalled popup is unaffected. */
  compact?: boolean;
  /** Show a "(none)" option at the top of the popup that clears the value.
   *  Use where an empty signal is meaningful (e.g. an optional per-keyframe
   *  emit). */
  clearable?: boolean;
  /**
   * Authoring direction. "listen" (default) shows EVERY signal — built-in
   * lifecycle + author-emittable + project. "emit" hides lifecycle signals
   * (OnDamageTaken, OnJump, OnPhaseEnter, etc.) because emitting them
   * manually fakes the event without the underlying side effect. Use
   * "emit" on EmitSignal/EmitSignalTo actions, FrameSignal rows in the
   * animator, and Tracer.triggerSignal — anywhere the AUTHOR is the
   * source of the emission.
   */
  mode?: "listen" | "emit";
  /** When provided, filters the "Custom" signal list to only signals
   *  REACHABLE from this BP — local `EmitSignal` from OTHER BPs is
   *  hidden (those fire on a different sprite bus and can't be heard
   *  cross-BP). EmitSignalTo signals stay visible. Pass the host BP id
   *  whenever the picker is rendered inside that BP's authoring
   *  context (logic sheet, animator slots). Omit for global pickers. */
  forBpId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  // Anchor rect for the portalled popup. Captured on open and refreshed
  // on scroll/resize so the popup tracks the button when its scroll
  // ancestor (xyflow pane, advanced panel scroller) moves.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // Scan the WHOLE project for custom signals — declared in the Signals
  // tab AND emitted via EmitSignal / EmitSignalTo in any event sheet
  // or Logic Sheet folder. Author who typed a signal name once in an
  // EmitSignal action sees it everywhere else now.
  const project = useEditor((s) => s.project);
  // Build the custom-signal list AND a per-signal source map. The source
  // map records every place a signal is emitted (which BP, and how —
  // EmitSignal action / EmitSignalTo broadcast / Frame Signal / declared
  // in the Signals tab) so the picker can show "where does this come
  // from?" instead of a generic placeholder.
  const { customSignals, customSources, tileSignals, tileSources, navSignals, navSources } = useMemo(() => {
    const names = new Set<string>(collectEmittedSignalNames(project, { forBpId }));
    const sources = new Map<string, Set<string>>();
    const addSource = (sig: string, src: string) => {
      if (!sig) return;
      const set = sources.get(sig) ?? new Set<string>();
      set.add(src);
      sources.set(sig, set);
    };
    // Declared in the Signals tab.
    for (const s of project.signals) addSource(s.name, "Declared in Signals tab");
    // Walk BP events + logic sheets for EmitSignal / EmitSignalTo.
    const scanEmit = (kind: string, sig: string, ownerLabel: string, how: string) => {
      if (kind !== "EmitSignal" && kind !== "EmitSignalTo") return;
      const verb = kind === "EmitSignalTo" ? "broadcasts" : "emits";
      addSource(sig, `${ownerLabel} ${verb} via ${how}`);
    };
    for (const bp of project.blueprints) {
      // Logic Sheet nodes — Event Sheets are removed, so this is the only
      // per-BP emit surface to scan.
      for (const folder of bp.logicSheet?.folders ?? []) {
        for (const node of folder.graph.nodes) {
          if (node.kind !== "action") continue;
          const params = node.params as { signal?: unknown; name?: unknown };
          const cand = String(params.signal ?? params.name ?? "");
          scanEmit(node.type, cand, bp.name || "(unnamed BP)", "a Logic Sheet node");
        }
      }
    }
    // Main Logic Sheets.
    for (const ms of project.mainLogicSheets ?? []) {
      for (const folder of ms.sheet.folders) {
        for (const node of folder.graph.nodes) {
          if (node.kind !== "action") continue;
          const params = node.params as { signal?: unknown; name?: unknown };
          const cand = String(params.signal ?? params.name ?? "");
          scanEmit(node.type, cand, `Main Sheet "${ms.name}"`, "a Logic Sheet node");
        }
      }
    }
    // Animator frame signals — emit-side, not in collectEmittedSignalNames.
    // Same cross-BP visibility rule: a frame signal with `targetTag` set is
    // broadcast (visible everywhere); empty targetTag is self-emit (only
    // this BP's picker sees it).
    for (const bp of project.blueprints) {
      for (const b of bp.behaviors) {
        if (b.kind !== "StateMachine") continue;
        const states = ((b.config as Record<string, unknown>).states as Array<{ name?: string; frameSignals?: Array<{ signal?: string; targetTag?: string }> }> | undefined) ?? [];
        for (const s of states) {
          for (const fs of (s.frameSignals ?? [])) {
            if (typeof fs.signal !== "string" || !fs.signal) continue;
            const isBroadcast = typeof fs.targetTag === "string" && !!fs.targetTag;
            if (forBpId && !isBroadcast && bp.id !== forBpId) continue;
            names.add(fs.signal);
            const where = `${bp.name || "(unnamed BP)"} Frame Signal on "${s.name ?? "?"}" state${isBroadcast ? ` (broadcast → tag "${fs.targetTag}")` : ""}`;
            addSource(fs.signal, where);
          }
        }
      }
    }
    // Tile signals — big + animated tiles' Signal on Hit / Mine. Kept in their
    // OWN group so authors can scan them apart from emitted/declared ones.
    const tileNames = new Set<string>();
    const tileSourceMap = new Map<string, Set<string>>();
    const addTile = (sig: string | undefined, src: string) => {
      if (!sig) return;
      tileNames.add(sig);
      const set = tileSourceMap.get(sig) ?? new Set<string>();
      set.add(src);
      tileSourceMap.set(sig, set);
    };
    for (const ts of project.tilesets ?? []) {
      for (const bt of ts.bigTiles ?? []) {
        addTile(bt.signalOnHit, `Tileset "${ts.name}" · BigTile · on hit`);
        addTile(bt.signalOnMine, `Tileset "${ts.name}" · BigTile · on mine`);
      }
      for (const at of ts.animatedTiles ?? []) {
        addTile(at.signalOnHit, `Tileset "${ts.name}" · Animated "${at.name}" · on hit`);
        addTile(at.signalOnMine, `Tileset "${ts.name}" · Animated "${at.name}" · on mine`);
      }
    }
    // Nav arrival signals — waypoints' "Emit signal" on arrive. Own group.
    const navNames = new Set<string>();
    const navSourceMap = new Map<string, Set<string>>();
    const addNav = (sig: string | undefined, src: string) => {
      if (!sig) return;
      navNames.add(sig);
      const set = navSourceMap.get(sig) ?? new Set<string>();
      set.add(src);
      navSourceMap.set(sig, set);
    };
    for (const sc of project.scenes ?? []) {
      for (const w of sc.navMesh?.waypoints ?? []) {
        addNav(w.signalOnArrive, `Scene "${sc.name}" · Nav point "${w.name || w.tags?.[0] || w.id}" · on arrive`);
      }
    }
    // Subtract built-ins so the "Custom" section doesn't duplicate them.
    for (const b of BUILT_IN_SIGNALS_REGISTRY) names.delete(b.name);
    const sourceText = new Map<string, string>();
    for (const [sig, set] of sources) sourceText.set(sig, Array.from(set).join("  •  "));
    const tileSourceText = new Map<string, string>();
    for (const [sig, set] of tileSourceMap) tileSourceText.set(sig, Array.from(set).join("  •  "));
    const navSourceText = new Map<string, string>();
    for (const [sig, set] of navSourceMap) navSourceText.set(sig, Array.from(set).join("  •  "));
    // Tile + nav signals live in their own groups — drop them from Custom.
    const customNames = Array.from(names).filter((n) => !tileNames.has(n) && !navNames.has(n)).sort();
    return { customSignals: customNames, customSources: sourceText, tileSignals: Array.from(tileNames).sort(), tileSources: tileSourceText, navSignals: Array.from(navNames).sort(), navSources: navSourceText };
  }, [project, forBpId]);

  // Refresh anchor when the popup is open — handles xyflow pan/zoom,
  // window resize, ancestor scroll. RAF to coalesce burst events.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const refresh = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
      });
    };
    window.addEventListener("scroll", refresh, true); // capture: catch scrolls on any ancestor
    window.addEventListener("resize", refresh);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [open]);

  // Close on outside click. Check against BOTH the button and the
  // portalled popup so clicking inside the popup doesn't close it.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const openPicker = () => {
    if (btnRef.current) setAnchorRect(btnRef.current.getBoundingClientRect());
    setOpen((o) => !o);
  };

  // Source order — Custom first (the author's own signals are the most
  // important to surface), then Convention, then gameplay / visual / meta
  // built-ins. Matches the dropdown's group rendering order below.
  const SOURCE_ORDER = [
    "Custom", "Tile signals", "Nav signals", "Convention",
    "Damageable", "CharacterMovement", "AIBrain", "PhaseManager",
    "Tracer", "SpriteRenderer", "SquashStretch", "Camera",
  ];

  // Combined option list with source labels. "Custom" rows come from
  // declared (project.signals) + emitted (EmitSignal / FrameSignals
  // scanned via collectEmittedSignalNames). Built-ins are added behind
  // those. In "emit" mode, lifecycle (listen-only) signals are dropped
  // so authors don't accidentally fake engine events.
  const allOptions: BuiltInSignal[] = useMemo(() => {
    const customRows: BuiltInSignal[] = customSignals.map((n) => ({
      name: n,
      source: "Custom",
      // Real per-signal source — "Player emits via a Logic Sheet node",
      // "NPC 5 Frame Signal on 'death' state", etc. Falls back to the
      // generic line only when we couldn't trace any emit site.
      description: customSources.get(n) ?? "Emitted somewhere in the project (source not traced).",
      direction: "both",
    }));
    const tileRows: BuiltInSignal[] = tileSignals.map((n) => ({
      name: n,
      source: "Tile signals",
      description: tileSources.get(n) ?? "Emitted by a tile on hit / mine.",
      direction: "both",
    }));
    const navRows: BuiltInSignal[] = navSignals.map((n) => ({
      name: n,
      source: "Nav signals",
      description: navSources.get(n) ?? "Emitted by a nav waypoint on arrival.",
      direction: "both",
    }));
    const builtIns = mode === "emit"
      ? BUILT_IN_SIGNALS_REGISTRY.filter((s) => s.direction !== "listen")
      : BUILT_IN_SIGNALS_REGISTRY;
    return [...customRows, ...tileRows, ...navRows, ...builtIns];
  }, [customSignals, customSources, tileSignals, tileSources, navSignals, navSources, mode]);

  // Group by source for grouped rendering. Preserves insertion order so
  // SOURCE_ORDER controls the visual sequence.
  const grouped = useMemo(() => {
    const map = new Map<string, BuiltInSignal[]>();
    for (const opt of allOptions) {
      const arr = map.get(opt.source) ?? [];
      arr.push(opt);
      map.set(opt.source, arr);
    }
    return map;
  }, [allOptions]);

  // Source for the current value — drives the chip on the closed button.
  // Unknown values (custom / ad-hoc) get a grey "Custom" chip so authors
  // can spot typos at a glance.
  const currentSource = useMemo(() => {
    if (!value) return undefined;
    const hit = allOptions.find((o) => o.name === value);
    return hit?.source ?? "Custom";
  }, [allOptions, value]);

  const themeFor = (source: string | undefined) => {
    if (!source) return COMPONENT_THEME.Flow;
    // Custom = author-declared / emitted. Reuse the Signals theme color
    // so it visually maps to the engine's "this is a signal" palette.
    if (source === "Custom") return COMPONENT_THEME.Signals ?? COMPONENT_THEME.Flow;
    if (source === "Tile signals") return COMPONENT_THEME.Tilemap ?? COMPONENT_THEME.Signals ?? COMPONENT_THEME.Flow;
    if (source === "Nav signals") return COMPONENT_THEME.MoveTo ?? COMPONENT_THEME.Signals ?? COMPONENT_THEME.Flow;
    // Convention = engine-listens-for-this-from-the-author. Neutral grey
    // chip so it reads as "implementation pattern, not a real source".
    if (source === "Convention") return COMPONENT_THEME.Flow;
    return COMPONENT_THEME[source] ?? COMPONENT_THEME.Flow;
  };

  const commitCustom = () => {
    const v = customDraft.trim();
    if (!v) return;
    onChange(v);
    setCustomDraft("");
    setOpen(false);
  };

  const currentTheme = themeFor(currentSource);

  // Popup positioning — viewport-clamped fixed coords from the button's
  // current rect. Width matches the button, capped to fit the screen.
  const POPUP_W = anchorRect ? Math.max(280, anchorRect.width) : 280;
  const POPUP_MAX_H = 420;
  const winW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight : 1080;
  const popupLeft = anchorRect ? Math.min(anchorRect.left, winW - POPUP_W - 8) : 0;
  // Default: drop below the button. If that overflows the viewport, flip
  // to opening upward.
  const wouldOverflowBottom = anchorRect && (anchorRect.bottom + 4 + POPUP_MAX_H > winH);
  const popupTop = anchorRect
    ? (wouldOverflowBottom
        ? Math.max(8, anchorRect.top - POPUP_MAX_H - 4)
        : anchorRect.bottom + 4)
    : 0;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        ref={btnRef}
        type="button"
        onClick={openPicker}
        style={{
          display: "flex", alignItems: "center", gap: compact ? 3 : 6,
          padding: compact ? "1px 4px" : "2px 8px", fontSize: compact ? 10 : 11,
          minWidth: compact ? 0 : 140, width: "100%",
          background: "var(--inner)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 3, color: "var(--text)", cursor: "pointer",
          textAlign: "left",
        }}
        title={value ? `Signal: ${value} (source: ${currentSource ?? "—"})` : "Pick a signal"}
      >
        {value && (
          <span
            style={{
              background: currentTheme.chipBg, color: currentTheme.chipFg,
              fontSize: 8, fontWeight: 700,
              padding: "1px 5px", borderRadius: 3,
              textTransform: "uppercase", letterSpacing: 0.5,
              whiteSpace: "nowrap",
            }}
          >{currentSource ?? "—"}</span>
        )}
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: value ? "var(--text)" : "var(--text-dim)" }}>
          {value || (placeholder ?? "pick signal…")}
        </span>
        <span style={{ fontSize: 9, color: "var(--text-dim)" }}>▾</span>
      </button>
      {open && anchorRect && createPortal(
        <div
          ref={popupRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: popupTop,
            left: popupLeft,
            width: POPUP_W,
            maxHeight: POPUP_MAX_H,
            overflowY: "auto",
            background: "#1a1a1a",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 4, padding: 4, zIndex: 9999,
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}>
          {clearable && (
            <div
              onClick={() => { onChange(""); setOpen(false); }}
              title="Clear — no signal"
              style={{
                padding: "4px 6px", cursor: "pointer", fontSize: 11,
                color: "var(--text-dim)", fontStyle: "italic",
                background: !value ? "rgba(255,205,60,0.15)" : "transparent",
                borderRadius: 2, marginBottom: 2,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = !value ? "rgba(255,205,60,0.15)" : "transparent"; }}
            >(none — clear signal)</div>
          )}
          {SOURCE_ORDER.flatMap((source) => {
            const opts = grouped.get(source);
            if (!opts || opts.length === 0) return [];
            const theme = themeFor(source);
            return [
              <div key={`hdr-${source}`} style={{
                fontSize: 9, color: theme.chipBg,
                textTransform: "uppercase", letterSpacing: 0.5,
                padding: "6px 6px 2px", fontWeight: 700,
              }}>{source === "Custom" ? "Custom (project)" : source === "Convention" ? "Convention" : source}</div>,
              ...opts.map((opt) => (
                <div
                  key={`${opt.source}:${opt.name}`}
                  onClick={() => { onChange(opt.name); setOpen(false); }}
                  title={opt.description}
                  style={{
                    padding: "4px 6px", cursor: "pointer",
                    display: "flex", alignItems: "flex-start", gap: 6,
                    background: opt.name === value ? "rgba(255,205,60,0.15)" : "transparent",
                    borderRadius: 2, fontSize: 11,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.06)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = opt.name === value ? "rgba(255,205,60,0.15)" : "transparent"; }}
                >
                  <span style={{
                    background: theme.chipBg,
                    width: 8, height: 8, borderRadius: 2,
                    flex: "0 0 auto", marginTop: 3,
                  }} />
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{ color: "#f0f0f0" }}>{opt.name}</span>
                    {/* Source line shown ONLY for custom signals — those are
                        the ones where "who emits this?" is non-obvious and
                        worth tracing. Built-in signals keep their description
                        on the hover tooltip only (the subsystem chip + name
                        already say enough). */}
                    {(opt.source === "Custom" || opt.source === "Tile signals" || opt.source === "Nav signals") && (
                      <span style={{
                        color: "var(--text-dim, #9aa)", fontSize: 9, lineHeight: 1.3,
                        whiteSpace: "normal", wordBreak: "break-word",
                      }}>{opt.description}</span>
                    )}
                  </span>
                </div>
              )),
            ];
          })}
          {/* Catch-all warning for an unknown value already set — surfaces
              typos without forcing a re-pick. */}
          {value && currentSource === "Custom" && (
            <>
              <div key="hdr-custom" style={{
                fontSize: 9, color: themeFor("Custom").chipBg,
                textTransform: "uppercase", letterSpacing: 0.5,
                padding: "6px 6px 2px", fontWeight: 700,
              }}>Current (custom)</div>
              <div style={{
                padding: "3px 6px",
                display: "flex", alignItems: "center", gap: 6,
                background: "rgba(255,205,60,0.10)",
                borderRadius: 2, fontSize: 11,
              }} title="This signal name isn't in the built-in registry or project Signals. Likely custom — make sure it's emitted somewhere.">
                <span style={{
                  background: themeFor("Custom").chipBg,
                  width: 8, height: 8, borderRadius: 2,
                  flex: "0 0 auto",
                }} />
                <span style={{ color: "#f0f0f0" }}>{value}</span>
              </div>
            </>
          )}
          {/* Type-custom row at the bottom so authors can add an ad-hoc
              signal without leaving the picker. Enter commits. */}
          <div style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            marginTop: 6, padding: "6px 6px 2px",
            fontSize: 9, color: "var(--text-dim)",
            textTransform: "uppercase", letterSpacing: 0.5,
            fontWeight: 700,
          }}>Type Custom</div>
          <div style={{ padding: "2px 6px 6px", display: "flex", gap: 4 }}>
            <input
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitCustom(); }
                else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
              }}
              placeholder="custom signal name…"
              style={{
                flex: 1, fontSize: 11, padding: "2px 6px",
                background: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, color: "#f0f0f0",
              }}
            />
            <button
              type="button"
              onClick={commitCustom}
              disabled={!customDraft.trim()}
              style={{
                padding: "2px 8px", fontSize: 11,
                background: customDraft.trim() ? "var(--accent)" : "rgba(255,255,255,0.05)",
                color: customDraft.trim() ? "var(--frame)" : "var(--text-dim)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3,
                cursor: customDraft.trim() ? "pointer" : "default",
              }}
            >Use</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
