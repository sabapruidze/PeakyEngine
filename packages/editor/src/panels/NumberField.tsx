import { useEffect, useState, InputHTMLAttributes } from "react";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: number;
  onChange: (n: number) => void;
}

/**
 * Controlled number input that survives intermediate "non-number" states like
 * `-` (typed before digits) or `1.` (mid-decimal).
 *
 * Native `<input type="number">` plus `value={state}` + `onChange={n => set(+e.target.value)}`
 * loses the dash because `Number("-")` is NaN and React re-renders with the
 * old value, deleting the character the user just typed.
 *
 * This component holds a local string while the user is typing, only commits
 * a valid number to `onChange`, and on blur snaps back to the last accepted
 * value if the buffer is unparseable.
 */
export function NumberField({ value, onChange, ...rest }: Props) {
  const [text, setText] = useState(String(value));

  // External value changed (e.g. another component edited it) — re-sync the
  // local buffer unless the user is actively typing a partial value.
  useEffect(() => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed !== value) {
      setText(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const n = Number(next);
        if (next.trim() !== "" && Number.isFinite(n)) {
          onChange(n);
        }
      }}
      onBlur={(e) => {
        const n = Number(text);
        if (text.trim() === "" || !Number.isFinite(n)) {
          setText(String(value));
        }
        rest.onBlur?.(e);
      }}
    />
  );
}
