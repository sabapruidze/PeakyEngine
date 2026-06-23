import type { CSSProperties, MouseEvent } from "react";

/**
 * Engine-wide on/off toggle. Replaces every `<input type="checkbox">` and
 * 0/1 boolean control across the editor so all boolean settings read as a
 * single consistent sliding switch instead of a mix of checkboxes.
 *
 * `value` / `onChange` are boolean. Callers that store 0/1 convert at the
 * call site (`value={n !== 0}` / `onChange={v => set(v ? 1 : 0)}`).
 *
 * Passthrough props (`id`, `className`, `onClick`, `onMouseDown`) cover the
 * call sites migrated from checkboxes that carried those — `onClick` runs
 * BEFORE the toggle flips (e.g. for `stopPropagation`).
 */
export function Toggle({
  value,
  onChange,
  title,
  disabled,
  size = 1,
  style,
  id,
  className,
  onClick,
  onMouseDown,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  title?: string;
  disabled?: boolean;
  /** Scale factor (1 = default 30×17). */
  size?: number;
  style?: CSSProperties;
  id?: string;
  className?: string;
  onClick?: (e: MouseEvent) => void;
  onMouseDown?: (e: MouseEvent) => void;
}) {
  const w = 30 * size;
  const h = 17 * size;
  const knob = 13 * size;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      id={id}
      className={className}
      onMouseDown={onMouseDown}
      onClick={(e) => { onClick?.(e); e.stopPropagation(); if (!disabled) onChange(!value); }}
      title={title}
      style={{
        // Caller `style` is applied FIRST (e.g. margin) but the toggle's
        // own dimensions / shape win — so a leftover `width: auto`/`100%`
        // from a migrated checkbox can't squish or stretch the switch.
        ...style,
        display: "inline-block",
        position: "relative",
        width: w, height: h, minWidth: w, flexShrink: 0,
        borderRadius: h / 2,
        border: `1px solid ${value ? "var(--accent)" : "rgba(255,255,255,0.25)"}`,
        cursor: disabled ? "not-allowed" : "pointer",
        background: value ? "var(--accent)" : "rgba(255,255,255,0.12)",
        transition: "background 0.12s, border-color 0.12s", padding: 0,
        opacity: disabled ? 0.5 : 1,
        verticalAlign: "middle",
        boxSizing: "border-box",
      }}
    >
      <span style={{
        position: "absolute", top: 1 * size, left: value ? w - knob - 2 * size : 1 * size,
        width: knob, height: knob, borderRadius: "50%",
        background: value ? "#fff" : "rgba(255,255,255,0.55)",
        transition: "left 0.12s",
        boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
      }} />
    </button>
  );
}
