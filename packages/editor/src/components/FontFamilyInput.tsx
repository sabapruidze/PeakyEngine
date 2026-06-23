import { type CSSProperties } from "react";
import { useEditor } from "../store";

/** Common browser-bundled families, offered alongside the project's uploaded
 *  custom fonts. */
const WEB_SAFE = [
  "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS",
  "Times New Roman", "Georgia", "Courier New", "Impact", "Comic Sans MS",
];

/**
 * Font-family picker: a real dropdown listing every uploaded custom font
 * (grouped on top) plus the web-safe families. Used wherever a `fontFamily`
 * is set (widget text, Text component, dialogue) so a custom font is one click
 * away — never typed from memory.
 *
 * A value that isn't in either list (an old typed entry / a hand-set web font)
 * is preserved as its own option so switching away and back doesn't lose it.
 */
export function FontFamilyInput({
  value, onChange, style, title,
}: {
  value: string;
  onChange: (v: string) => void;
  style?: CSSProperties;
  title?: string;
}) {
  const fonts = useEditor((s) => s.project.fonts) ?? [];
  const cur = value || "Arial";
  const customNames = fonts.map((f) => f.name);
  const known = new Set<string>([...customNames, ...WEB_SAFE]);
  return (
    <select
      value={cur}
      onChange={(e) => onChange(e.target.value)}
      style={{ fontSize: 11, ...style }}
      title={title ?? "Pick an uploaded custom font or a web-safe family."}
    >
      {/* Preserve a value that isn't a known custom/web font (legacy or typed). */}
      {!known.has(cur) && <option value={cur}>{cur} (current)</option>}
      {customNames.length > 0 && (
        <optgroup label="Custom fonts">
          {customNames.map((n) => (
            <option key={n} value={n} style={{ fontFamily: `"${n}"` }}>{n}</option>
          ))}
        </optgroup>
      )}
      <optgroup label="Web-safe">
        {WEB_SAFE.map((w) => <option key={w} value={w}>{w}</option>)}
      </optgroup>
    </select>
  );
}
