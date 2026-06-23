import { useRef } from "react";
import { useEditor } from "../store";
import { writeAssetFromDataURL, fontDiskPath } from "../AssetStore";

interface Props {
  onClose: () => void;
}

const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i;
const isFontFile = (f: File) =>
  FONT_EXT.test(f.name) || f.type.startsWith("font/") || f.type === "application/font-sfnt";

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => resolve("");
    r.readAsDataURL(file);
  });

/**
 * Custom Fonts manager.
 *
 * Upload font files (ttf / otf / woff / woff2). Each is stored in the project
 * as a base64 data URL and registered with the browser under its name (= the
 * CSS font-family). Pick that name as the Font on any Label / Button / Text
 * and it renders in-game. The preview row renders in the font itself.
 */
export function FontsPanel({ onClose }: Props) {
  const fonts = useEditor((s) => s.project.fonts) ?? [];
  const addFont = useEditor((s) => s.addFont);
  const renameFont = useEditor((s) => s.renameFont);
  const removeFont = useEditor((s) => s.removeFont);
  const fileRef = useRef<HTMLInputElement>(null);

  const importFiles = async (files: FileList | File[]) => {
    // Filenames already used under assets/fonts/. Without this, two font
    // files with the same name silently overwrite each other on disk.
    const used = new Set(fonts.map((x) => x.file));
    for (const f of [...files]) {
      if (!isFontFile(f)) continue;
      const dataUrl = await readAsDataUrl(f);
      if (!dataUrl) continue;
      const base = f.name.replace(/\.[^.]+$/, "");
      const ext = f.name.match(/\.[^.]+$/)?.[0] ?? "";
      let fileName = f.name;
      if (used.has(fileName)) {
        let n = 2;
        while (used.has(`${base}_${n}${ext}`)) n++;
        fileName = `${base}_${n}${ext}`;
      }
      used.add(fileName);
      const ok = await writeAssetFromDataURL(fontDiskPath({ file: fileName }), dataUrl);
      if (!ok) { console.warn("Font import: no AssetStore open — file not written"); continue; }
      addFont({ name: f.name, file: fileName });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 560, maxHeight: "80vh" }}>
        <header>
          <span>Fonts</span>
          <button onClick={onClose} style={{ fontSize: 11 }}>Close</button>
        </header>

        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11, borderBottom: "1px solid var(--border)" }}>
          Upload custom fonts (.ttf / .otf / .woff / .woff2). The font's <strong>name</strong> is what
          you pick as the <em>Font</em> on a Label, Button, or Text component — it renders in-game.
        </div>

        <div
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
          onDrop={(e) => { if (e.dataTransfer.files?.length) { e.preventDefault(); void importFiles(e.dataTransfer.files); } }}
          style={{ padding: 8, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}
        >
          {fonts.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic", padding: "16px 8px", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 6 }}>
              No custom fonts yet. Upload a file or drag one here.
            </div>
          )}
          {fonts.map((f) => (
            <div
              key={f.id}
              style={{
                display: "grid",
                gridTemplateColumns: "180px 1fr auto",
                gap: 8,
                alignItems: "center",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "8px",
              }}
            >
              <input
                value={f.name}
                onChange={(e) => renameFont(f.id, e.target.value)}
                style={{ fontWeight: 600 }}
                title="Font name = the font-family you pick on text. Must be unique."
              />
              <span
                style={{ fontFamily: `"${f.name}", sans-serif`, fontSize: 20, color: "var(--text)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                title="Live preview in this font"
              >
                The quick brown fox 0123
              </span>
              <button onClick={() => removeFont(f.id)} className="danger" style={{ fontSize: 11, padding: "4px 8px" }}>×</button>
            </div>
          ))}

          <input
            ref={fileRef}
            type="file"
            accept=".ttf,.otf,.woff,.woff2,.ttc,font/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.length) void importFiles(e.target.files); e.target.value = ""; }}
          />
          <button onClick={() => fileRef.current?.click()} style={{ alignSelf: "flex-start", marginTop: 4 }}>
            + Upload Font
          </button>
        </div>
      </div>
    </div>
  );
}
