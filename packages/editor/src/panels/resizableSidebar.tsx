import { useEffect, useRef, useState } from "react";

/**
 * useResizableWidth — a persistent width-state hook keyed by a localStorage
 * slot. Returns `[width, setWidth]` plus auto-clamps to [min, max] and
 * writes through to localStorage on every update.
 */
export function useResizableWidth(
  storageKey: string,
  defaultPx: number,
  minPx: number,
  maxPx: number,
): [number, (n: number) => void] {
  const [width, setWidthState] = useState<number>(() => {
    if (typeof window === "undefined") return defaultPx;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(parsed)) return defaultPx;
    return Math.max(minPx, Math.min(maxPx, parsed));
  });
  const setWidth = (n: number) => {
    const clamped = Math.max(minPx, Math.min(maxPx, Math.round(n)));
    setWidthState(clamped);
    try { window.localStorage.setItem(storageKey, String(clamped)); } catch { /* quota / private mode */ }
  };
  return [width, setWidth];
}

/**
 * SidebarResizeHandle — a 5px-wide vertical bar that captures a drag and
 * resizes the sidebar to its left. Drop it as a sibling between the
 * sidebar and the next column inside a flex-row parent.
 */
export function SidebarResizeHandle({
  width, onChange, min, max,
}: {
  width: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
}) {
  const [dragging, setDragging] = useState(false);
  // Hold the latest onChange / min / max in a ref so the drag-effect
  // doesn't depend on them. Without this the effect re-runs whenever the
  // parent re-renders (which it does on every resize step because the
  // parent's width state moves), re-attaching mousemove / mouseup and
  // resetting the body-cursor capture mid-drag.
  const onChangeRef = useRef(onChange);
  const minRef = useRef(min);
  const maxRef = useRef(max);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { minRef.current = min; }, [min]);
  useEffect(() => { maxRef.current = max; }, [max]);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.max(minRef.current, Math.min(maxRef.current, e.clientX));
      onChangeRef.current(next);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Force a column-resize cursor across the whole window so the cursor
    // doesn't flicker when the pointer crosses other elements mid-drag.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);
  void width;
  return (
    <div
      onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
      title="Drag to resize"
      style={{
        width: 5, flexShrink: 0,
        cursor: "col-resize",
        background: dragging ? "var(--accent)" : "transparent",
        borderLeft: "1px solid var(--border)",
        borderRight: "1px solid var(--border)",
        transition: dragging ? "none" : "background 100ms",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = dragging ? "var(--accent)" : "rgba(255,255,255,0.15)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = dragging ? "var(--accent)" : "transparent"; }}
    />
  );
}
