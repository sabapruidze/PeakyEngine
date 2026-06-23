import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ExprToken { token: string; hint?: string; }
export interface ExprGroup { label: string; color: string; tokens: ExprToken[]; }
/** A navigable object — its variables are hidden until the object is clicked. */
export interface ExprObject { name: string; color: string; tokens: ExprToken[]; }

/**
 * `{ }` button → portalled popup for inserting an expression token.
 *
 * Two levels:
 *  - ROOT: the always-available "system" groups (Self / Picked / Mouse /
 *    Tracers) as chips, then a list of OBJECTS (This object / Player / NPC /
 *    widgets…). Object variables are NOT shown here — only the object names.
 *  - DRILL: click an object → its variable chips, with a ← back row.
 *
 * Portalled to document.body (logic nodes clip overflow). Picking a chip calls
 * `onPick(token)`.
 */
export function ExpressionPicker({ groups, objects, onPick, title }: {
  groups: ExprGroup[];
  objects: ExprObject[];
  onPick: (token: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [drill, setDrill] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const refresh = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect()); });
    };
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = () => {
    if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect());
    setQ("");
    setDrill(null);
    setOpen((o) => !o);
  };

  const pick = (token: string) => { onPick(token); setOpen(false); };
  const ql = q.trim().toLowerCase();
  const matchTok = (t: ExprToken) => !ql || t.token.toLowerCase().includes(ql);

  const POPUP_W = 300, POPUP_MAX_H = 360;
  const winW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight : 1080;
  const left = anchor ? Math.min(anchor.left, winW - POPUP_W - 8) : 0;
  const overflowBottom = anchor && anchor.bottom + 4 + POPUP_MAX_H > winH;
  const top = anchor ? (overflowBottom ? Math.max(8, anchor.top - POPUP_MAX_H - 4) : anchor.bottom + 4) : 0;

  const chip = (t: ExprToken, color: string) => (
    <button
      key={t.token}
      type="button"
      onClick={(e) => { e.stopPropagation(); pick(t.token); }}
      title={t.hint ?? t.token}
      style={{
        fontSize: 10, padding: "2px 7px", background: "rgba(255,255,255,0.08)", color: "#f0f0f0",
        border: `1px solid ${color}`, borderRadius: 10, cursor: "pointer", whiteSpace: "nowrap",
      }}
    >{t.token}</button>
  );
  const chipRow = (label: string, color: string, tokens: ExprToken[]) => {
    const toks = tokens.filter(matchTok);
    if (toks.length === 0) return null;
    return (
      <div key={label} style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 9, color, textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 4px 2px", fontWeight: 700 }}>{label}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 4px" }}>{toks.map((t) => chip(t, color))}</div>
      </div>
    );
  };

  const drillObj = drill ? objects.find((o) => o.name === drill) : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="nodrag"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        title={title ?? "Insert an expression (self.x, picked., mouse., or an object's variable)"}
        style={{
          flexShrink: 0, width: 20, height: 20, padding: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: open ? "var(--accent)" : "rgba(0,0,0,0.35)",
          color: open ? "var(--frame)" : "#9fd0ff",
          border: "1px solid rgba(255,255,255,0.2)", borderRadius: 3,
          cursor: "pointer", fontSize: 12, fontWeight: 700, lineHeight: 1,
          fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap",
        }}
      >{"{}"}</button>
      {open && anchor && createPortal(
        <div
          ref={popupRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top, left, width: POPUP_W, maxHeight: POPUP_MAX_H, overflowY: "auto",
            background: "#1a1a1a", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 4,
            padding: 4, zIndex: 9999, boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter…"
            style={{
              width: "100%", marginBottom: 4, fontSize: 11, padding: "3px 6px",
              background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, color: "#f0f0f0",
            }}
          />
          {drillObj ? (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setDrill(null); }}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
                  fontSize: 11, padding: "4px 6px", marginBottom: 4, color: "#f0f0f0",
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 3, cursor: "pointer",
                }}
              >← {drillObj.name}</button>
              {drillObj.tokens.filter(matchTok).length === 0
                ? <div style={{ fontSize: 10, color: "#aaa", padding: 8 }}>No variables.</div>
                : <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 4px" }}>{drillObj.tokens.filter(matchTok).map((t) => chip(t, drillObj.color))}</div>}
            </>
          ) : (
            <>
              {groups.map((g) => chipRow(g.label, g.color, g.tokens))}
              {objects.length > 0 && (
                <div style={{ marginTop: 2 }}>
                  <div style={{ fontSize: 9, color: "#9fd0ff", textTransform: "uppercase", letterSpacing: 0.5, padding: "4px 4px 2px", fontWeight: 700 }}>Objects</div>
                  {objects
                    .filter((o) => !ql || o.name.toLowerCase().includes(ql) || o.tokens.some(matchTok))
                    .map((o) => (
                      <button
                        key={o.name}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDrill(o.name); setQ(""); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
                          fontSize: 11, padding: "5px 6px", marginBottom: 2, color: "#f0f0f0",
                          background: "rgba(255,255,255,0.04)", border: `1px solid ${o.color}`,
                          borderRadius: 3, cursor: "pointer",
                        }}
                      >
                        <span style={{ flex: 1 }}>{o.name}</span>
                        <span style={{ fontSize: 9, color: "#888" }}>{o.tokens.length} var{o.tokens.length === 1 ? "" : "s"} ▸</span>
                      </button>
                    ))}
                </div>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
