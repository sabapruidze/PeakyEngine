import { useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "../components/Toggle";
import { parseDialogueScript } from "@peaky/shared";
import { useEditor } from "../store";
import type { DialogueAsset, DialogueChoice, DialogueLine } from "../project";
import { SpeakerMappingModal } from "./SpeakerMappingModal";
import { NumberField } from "./NumberField";
import { FontFamilyInput } from "../components/FontFamilyInput";

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

/** Sentinel value for the "Narrator" speaker — represents the project's
 *  narratorBpId fallback. Stored as the empty string in `speakerMap` so
 *  runProject's resolution falls through to defaults.narratorBpId. */
const NARRATOR_SENTINEL = "__narrator__";

export function DialogueTab({ dialogueId }: { dialogueId: string }) {
  const dialogue = useEditor((s) => s.project.dialogues.find((d) => d.id === dialogueId));
  // List of OTHER dialogues — passed to choice rows for the "Go to" picker.
  // Excludes the current dialogue to discourage trivial self-loops (the
  // user can still type the id manually if they really want one).
  const dialoguesForGoTo = useEditor((s) => s.project.dialogues.filter((d) => d.id !== dialogueId));
  const dialogues = useEditor((s) => s.project.dialogues);
  const blueprints = useEditor((s) => s.project.blueprints);
  const defaults = useEditor((s) => s.project.dialogueDefaults);
  const inputActions = useEditor((s) => s.project.inputActions);

  const renameDialogue = useEditor((s) => s.renameDialogue);
  const setDialogueLines = useEditor((s) => s.setDialogueLines);
  const setDialogueLine = useEditor((s) => s.setDialogueLine);
  const addDialogueLine = useEditor((s) => s.addDialogueLine);
  const removeDialogueLine = useEditor((s) => s.removeDialogueLine);
  const reorderDialogueLine = useEditor((s) => s.reorderDialogueLine);
  const addDialogueChoice = useEditor((s) => s.addDialogueChoice);
  const setDialogueChoice = useEditor((s) => s.setDialogueChoice);
  const removeDialogueChoice = useEditor((s) => s.removeDialogueChoice);
  const setDialogueSpeakerMap = useEditor((s) => s.setDialogueSpeakerMap);
  const setDialogueSpeakerOffset = useEditor((s) => s.setDialogueSpeakerOffset);
  const setDialogueOverrides = useEditor((s) => s.setDialogueOverrides);
  const setProjectDialogueDefaults = useEditor((s) => s.setProjectDialogueDefaults);

  const fileInputRef = useRef<HTMLInputElement>(null);
  /** When non-null, SpeakerMappingModal is rendered. Holds the parsed
   *  lines waiting to be committed once the user confirms speaker mapping. */
  const [pendingMapping, setPendingMapping] = useState<{
    lines: ReturnType<typeof parseDialogueScript>["lines"];
    speakers: string[];
  } | null>(null);

  // Unique speakers used across this asset's lines, in order of first
  // appearance. Drives the right-rail mapping table.
  const usedSpeakers = useMemo(() => {
    if (!dialogue) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const l of dialogue.lines) {
      if (l.speaker && !seen.has(l.speaker)) {
        seen.add(l.speaker);
        out.push(l.speaker);
      }
    }
    return out;
  }, [dialogue]);

  // All speaker names used across EVERY dialogue in the project — so a
  // narrator name like "BOB" you used in another dialogue still shows
  // up as a suggestion when you author a new line here. Empty + dedup.
  const allProjectSpeakers = useMemo(() => {
    const seen = new Set<string>();
    for (const d of dialogues) {
      for (const l of d.lines) {
        if (l.speaker) seen.add(l.speaker);
      }
    }
    return [...seen];
  }, [dialogues]);

  if (!dialogue) {
    return <div className="card" style={{ padding: 24, color: "var(--text-dim)" }}>Dialogue not found.</div>;
  }

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      const text = await file.text();
      const parsed = parseDialogueScript(text);
      // Auto-match speakers to BPs by exact / case-insensitive / tag match.
      // Anything left unmatched goes to the modal for the user to pick.
      const auto: Record<string, string> = { ...dialogue.speakerMap };
      const unmatched: string[] = [];
      for (const sp of parsed.speakers) {
        if (auto[sp] !== undefined) continue;        // already mapped
        if (sp === "Narrator") {
          auto[sp] = "";                              // sentinel for narrator BP
          continue;
        }
        const exact = blueprints.find((bp) => bp.name === sp);
        if (exact) { auto[sp] = exact.id; continue; }
        const ci = blueprints.find((bp) => bp.name.toLowerCase() === sp.toLowerCase());
        if (ci) { auto[sp] = ci.id; continue; }
        const byTag = blueprints.find((bp) => bp.tags.some((t) => t.toLowerCase() === sp.toLowerCase()));
        if (byTag) { auto[sp] = byTag.id; continue; }
        unmatched.push(sp);
      }
      // Apply lines first; the modal callback (or immediate commit) will
      // set the speakerMap. Splitting the writes keeps intermediate state
      // out of localStorage if the user cancels the modal.
      setDialogueLines(dialogue.id, parsed.lines);
      if (unmatched.length === 0) {
        setDialogueSpeakerMap(dialogue.id, auto);
      } else {
        setPendingMapping({ lines: parsed.lines, speakers: unmatched });
        // Stash auto-matched portion now; modal commits the rest.
        setDialogueSpeakerMap(dialogue.id, auto);
      }
    } catch (e) { console.error("Dialogue upload failed", e); }
  };

  // Suggestions for the speaker autocomplete. Combines:
  //   - speakers already used in this asset (so re-picking is instant)
  //   - every Blueprint name (so the user can pick a BP that hasn't been
  //     used yet without having to type the full name)
  //   - the built-in "Narrator" label
  // De-duplicated, alphabetized.
  const speakerSuggestions = useMemo(() => {
    const set = new Set<string>([
      ...usedSpeakers, ...allProjectSpeakers,
      ...blueprints.map((bp) => bp.name), "Narrator",
    ]);
    return [...set].filter(Boolean).sort();
  }, [usedSpeakers, allProjectSpeakers, blueprints]);

  const renderSpeakerCell = (line: DialogueLine) => {
    const listId = `speakerlist-${dialogue.id}`;
    return (
      <>
        <input
          list={listId}
          value={line.speaker}
          onChange={(e) => setDialogueLine(dialogue.id, line.id, { speaker: e.target.value })}
          placeholder="Speaker"
          style={{ fontSize: 11, padding: "2px 6px", width: 120 }}
          title="Type any name. Suggestions: existing speakers + all Blueprints. Picking a BP name auto-maps it on the right rail."
        />
        <datalist id={listId}>
          {speakerSuggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
      </>
    );
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 320px",
        gap: 12,
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* ─── Center: lines list ───────────────────────────────────────── */}
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {(() => {
          // Guard: warn loudly when the effective advance action doesn't
          // match a registered InputAction. Without this, dialogue silently
          // refuses to advance — there's no in-game feedback that the
          // configured "Interact" doesn't exist (vs. the user's actual
          // "Interaction"). The banner tells them exactly what to fix.
          const effective = (dialogue.advanceAction || defaults.advanceAction || "").trim();
          const isValid = effective === "" ? false : inputActions.some((a) => a.name === effective);
          if (isValid) return null;
          return (
            <div style={{
              margin: "10px 14px 0",
              padding: "8px 10px",
              background: "rgba(232, 116, 59, 0.15)",
              border: "1px solid rgba(232, 116, 59, 0.5)",
              borderRadius: 4,
              fontSize: 11,
              color: "var(--text-2)",
              lineHeight: 1.4,
            }}>
              <strong style={{ color: "var(--orange)" }}>⚠ Dialogue can't advance</strong> — the
              {" "}<strong>Next-line key</strong> is set to <code style={{ background: "rgba(0,0,0,0.3)", padding: "0 4px", borderRadius: 2 }}>{effective || "(none)"}</code>
              {" "}but no Input Action with that name exists.
              Pick one from the right rail under <em>Defaults (this asset)</em> or <em>Project defaults</em>.
              {inputActions.length > 0 && (
                <> Available: {inputActions.map((a) => a.name).join(", ")}.</>
              )}
            </div>
          );
        })()}
        <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 12 }}>
          <input
            value={dialogue.name}
            onChange={(e) => renameDialogue(dialogue.id, e.target.value)}
            style={{ fontSize: 14, fontWeight: 600, padding: "4px 8px", flex: 1 }}
          />
          <button
            className="ghost"
            style={{ fontSize: 11 }}
            onClick={() => fileInputRef.current?.click()}
            title="Upload a .txt / .md / .dlg script. Speakers matching Blueprint names auto-link; the rest open a mapping modal."
          >
            ⬆ Upload script
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.dlg"
            style={{ display: "none" }}
            onChange={(e) => { handleUpload(e.target.files); e.target.value = ""; }}
          />
          <button
            className="ghost"
            style={{ fontSize: 11 }}
            onClick={() => addDialogueLine(dialogue.id)}
          >
            + Line
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          {dialogue.lines.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12, fontStyle: "italic" }}>
              No lines yet. Click "+ Line" to add one, or upload a .txt script to import.
            </div>
          )}
          {dialogue.lines.map((line, i) => (
            <LineCard
              key={line.id}
              line={line}
              index={i}
              speakerCell={renderSpeakerCell(line)}
              dialoguesForGoTo={dialoguesForGoTo}
              onChangeText={(text) => setDialogueLine(dialogue.id, line.id, { text })}
              onAddDelay={() => setDialogueLine(dialogue.id, line.id, { delaySec: 0.5 })}
              onChangeDelay={(v) => setDialogueLine(dialogue.id, line.id, { delaySec: v })}
              onClearDelay={() => setDialogueLine(dialogue.id, line.id, { delaySec: undefined })}
              onAddEmit={() => setDialogueLine(dialogue.id, line.id, { emitSignal: "" })}
              onChangeEmit={(v) => setDialogueLine(dialogue.id, line.id, { emitSignal: v })}
              onClearEmit={() => setDialogueLine(dialogue.id, line.id, { emitSignal: undefined })}
              onAddChoice={() => addDialogueChoice(dialogue.id, line.id)}
              onChangeChoice={(cid, patch) => setDialogueChoice(dialogue.id, line.id, cid, patch)}
              onRemoveChoice={(cid) => removeDialogueChoice(dialogue.id, line.id, cid)}
              onMoveUp={() => i > 0 && reorderDialogueLine(dialogue.id, i, i - 1)}
              onMoveDown={() => i < dialogue.lines.length - 1 && reorderDialogueLine(dialogue.id, i, i + 1)}
              onRemove={() => removeDialogueLine(dialogue.id, line.id)}
            />
          ))}
        </div>
      </div>

      {/* ─── Right: speakers + defaults ──────────────────────────────── */}
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" }}>
        <div style={{ padding: "12px 14px 4px", ...labelStyle, fontWeight: 700 }}>Speakers</div>
        <div style={{ padding: "0 14px 6px", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
          Each speaker pins the dialogue bubble to a Blueprint instance in the scene. No setup on the BP needed — the bubble UI is built-in.
        </div>
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
          {usedSpeakers.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>
              No speakers yet — speakers appear here once you add lines.
            </div>
          )}
          {usedSpeakers.map((sp) => {
            const mapped = dialogue.speakerMap[sp] ?? "";
            const offset = dialogue.speakerOffsets?.[sp];
            const ox = offset?.x ?? 0;
            const oy = offset?.y ?? -10;
            return (
              <div key={sp} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 0", borderTop: "1px dashed rgba(255,255,255,0.05)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(80px, 1fr) auto", gap: 6, alignItems: "center" }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }} title={sp}>{sp}</div>
                  <select
                    value={mapped || NARRATOR_SENTINEL}
                    onChange={(e) => {
                      const v = e.target.value;
                      const next = { ...dialogue.speakerMap };
                      next[sp] = v === NARRATOR_SENTINEL ? "" : v;
                      setDialogueSpeakerMap(dialogue.id, next);
                    }}
                    style={{ fontSize: 11, padding: "2px 4px", maxWidth: 180 }}
                    title="Which Blueprint instance this speaker's bubble pins to. 'No anchor' = floats at top of the camera (use for narrator-style lines)."
                  >
                    <option value={NARRATOR_SENTINEL}>No anchor (camera top)</option>
                    {blueprints.map((bp) => (
                      <option key={bp.id} value={bp.id}>{bp.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 8 }}>
                  <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Offset</span>
                  <label style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 3 }}>
                    X
                    <NumberField
                      value={ox}
                      onChange={(v) => setDialogueSpeakerOffset(dialogue.id, sp, { x: v, y: oy })}
                      style={{ width: 50, fontSize: 10, padding: "1px 3px" }}
                    />
                  </label>
                  <label style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 3 }}>
                    Y
                    <NumberField
                      value={oy}
                      onChange={(v) => setDialogueSpeakerOffset(dialogue.id, sp, { x: ox, y: v })}
                      style={{ width: 50, fontSize: 10, padding: "1px 3px" }}
                      title="Negative = bubble higher above head. Per-speaker — independent from other speakers."
                    />
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: "12px 14px 4px", ...labelStyle, fontWeight: 700, borderTop: "1px solid var(--border)" }}>Defaults (this asset)</div>
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldRow label="Display">
            <select
              value={dialogue.displayMode ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setDialogueOverrides(dialogue.id, {
                  displayMode: v === "" ? undefined : (v as "overhead" | "box"),
                });
              }}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
            >
              <option value="">Inherit ({defaults.displayMode})</option>
              <option value="overhead">Overhead (above speaker)</option>
              <option value="box">Box (single narrator BP)</option>
            </select>
          </FieldRow>
          <FieldRow label="Next-line key">
            <select
              value={dialogue.advanceAction ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setDialogueOverrides(dialogue.id, { advanceAction: v === "" ? undefined : v });
              }}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
              title="The Input Action whose key the player presses to step through dialogue lines (skip the typewriter / advance to the next line). Typically the same as your Interact key."
            >
              <option value="">Inherit ({defaults.advanceAction || "—"})</option>
              {inputActions.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Typewriter cps">
            <input
              type="number"
              min={0}
              step={5}
              value={dialogue.typewriterCps ?? ""}
              placeholder={String(defaults.typewriterCps)}
              onChange={(e) => {
                const v = e.target.value;
                setDialogueOverrides(dialogue.id, { typewriterCps: v === "" ? undefined : Number(v) });
              }}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Auto-advance s">
            <input
              type="number"
              min={0}
              step={0.5}
              value={dialogue.autoAdvanceSec ?? ""}
              placeholder={String(defaults.autoAdvanceSec)}
              onChange={(e) => {
                const v = e.target.value;
                setDialogueOverrides(dialogue.id, { autoAdvanceSec: v === "" ? undefined : Number(v) });
              }}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Player speaker">
            <select
              value={
                dialogue.playerSpeakerBpId === undefined
                  ? "__inherit__"
                  : dialogue.playerSpeakerBpId === ""
                    ? ""
                    : dialogue.playerSpeakerBpId
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__inherit__") {
                  setDialogueOverrides(dialogue.id, { playerSpeakerBpId: undefined });
                } else {
                  setDialogueOverrides(dialogue.id, { playerSpeakerBpId: v });
                }
              }}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
              title="When set, picking a choice ECHOES the chosen text as a line spoken by this BP — RPG-style 'player recites their answer first.' The dialogue won't continue until the player advances past the echo line."
            >
              <option value="__inherit__">
                Inherit ({defaults.playerSpeakerBpId
                  ? blueprints.find((bp) => bp.id === defaults.playerSpeakerBpId)?.name ?? "(missing)"
                  : "no echo"})
              </option>
              <option value="">No echo (apply choice immediately)</option>
              {blueprints.map((bp) => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
            </select>
          </FieldRow>
        </div>

        <div style={{ padding: "12px 14px 4px", ...labelStyle, fontWeight: 700, borderTop: "1px solid var(--border)" }}>Project defaults</div>
        <div style={{ padding: "0 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldRow label="Display">
            <select
              value={defaults.displayMode}
              onChange={(e) => setProjectDialogueDefaults({ displayMode: e.target.value as "overhead" | "box" })}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
            >
              <option value="overhead">Overhead</option>
              <option value="box">Box</option>
            </select>
          </FieldRow>
          <FieldRow label="Next-line key">
            <select
              value={defaults.advanceAction}
              onChange={(e) => setProjectDialogueDefaults({ advanceAction: e.target.value })}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
              title="The Input Action whose key the player presses to step through dialogue lines."
            >
              <option value="">— pick action —</option>
              {inputActions.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </FieldRow>
          <FieldRow label="Typewriter cps">
            <input
              type="number"
              min={0}
              step={5}
              value={defaults.typewriterCps}
              onChange={(e) => setProjectDialogueDefaults({ typewriterCps: Number(e.target.value) })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Auto-advance s">
            <input
              type="number"
              min={0}
              step={0.5}
              value={defaults.autoAdvanceSec}
              onChange={(e) => setProjectDialogueDefaults({ autoAdvanceSec: Number(e.target.value) })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Player speaker">
            <select
              value={defaults.playerSpeakerBpId}
              onChange={(e) => setProjectDialogueDefaults({ playerSpeakerBpId: e.target.value })}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
              title="Default Blueprint that voices picked choices as 'player' lines across all dialogues. Empty = no echo, choice picks fire their action immediately. Per-asset override can flip this on/off per dialogue."
            >
              <option value="">No echo (apply choice immediately)</option>
              {blueprints.map((bp) => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
            </select>
          </FieldRow>
        </div>

        <div style={{ padding: "12px 14px 4px", ...labelStyle, fontWeight: 700, borderTop: "1px solid var(--border)" }}>Bubble style</div>
        <div style={{ padding: "0 14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <FieldRow label="Theme">
            <select
              value={defaults.style.theme ?? "modern"}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, theme: e.target.value as "modern" | "jrpg" | "comic" | "comic-shout" | "comic-thought" | "comic-whisper" | "comic-news" | "image" } })}
              style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
              title="Visual theme for the dialog bubble. Procedural themes draw the box with code (rounded rects, starbursts, etc). Custom image uses a designer-authored 9-slice PNG."
            >
              <optgroup label="General">
                <option value="modern">Modern — rounded, drop shadow, speaker pill</option>
                <option value="jrpg">JRPG — square, double border, attached speaker box</option>
              </optgroup>
              <optgroup label="Comic">
                <option value="comic">Comic — Classic — rounded bubble, speech tail (overhead)</option>
                <option value="comic-shout">Comic — Shout — jagged starburst, loud combat lines</option>
                <option value="comic-thought">Comic — Thought — cloud-puffy, trailing thought bubbles</option>
                <option value="comic-whisper">Comic — Whisper — thin dashed outline, translucent, quiet lines</option>
                <option value="comic-news">Comic — Newspaper — halftone-dot bg, no tail, narrator captions</option>
              </optgroup>
              <optgroup label="Custom">
                <option value="image">Custom Image — 9-slice PNG (designer-authored)</option>
              </optgroup>
            </select>
          </FieldRow>
          {defaults.style.theme === "image" && (
            <DialogBoxAssetSection
              currentId={defaults.style.boxAssetId ?? ""}
              onPick={(id) => setProjectDialogueDefaults({ style: { ...defaults.style, boxAssetId: id } })}
            />
          )}
          <FieldRow label="Box width">
            <input
              type="number"
              min={80}
              max={1000}
              step={20}
              value={defaults.style.boxWidth}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, boxWidth: Number(e.target.value) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Font size">
            <input
              type="number"
              min={8}
              max={48}
              value={defaults.style.fontSize}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, fontSize: Number(e.target.value) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Font family">
            <FontFamilyInput
              value={defaults.style.fontFamily}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, fontFamily: v } })}
              style={{ fontSize: 11, padding: "2px 6px", flex: 1 }}
            />
          </FieldRow>
          <FieldRow label="Text color">
            <input
              type="color"
              value={defaults.style.textColor}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, textColor: e.target.value } })}
              style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
            />
          </FieldRow>
          <FieldRow label="Speaker color">
            <input
              type="color"
              value={defaults.style.speakerColor}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, speakerColor: e.target.value } })}
              style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
            />
          </FieldRow>
          <FieldRow label="BG color">
            <input
              type="color"
              value={`#${defaults.style.bgColor.toString(16).padStart(6, "0")}`}
              onChange={(e) => {
                const n = parseInt(e.target.value.slice(1), 16) || 0;
                setProjectDialogueDefaults({ style: { ...defaults.style, bgColor: n } });
              }}
              style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
            />
          </FieldRow>
          <FieldRow label="BG opacity">
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={defaults.style.bgAlpha}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, bgAlpha: Math.max(0, Math.min(1, Number(e.target.value))) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <FieldRow label="Border color">
            <input
              type="color"
              value={`#${defaults.style.borderColor.toString(16).padStart(6, "0")}`}
              onChange={(e) => {
                const n = parseInt(e.target.value.slice(1), 16) || 0;
                setProjectDialogueDefaults({ style: { ...defaults.style, borderColor: n } });
              }}
              style={{ width: 40, height: 22, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
            />
          </FieldRow>
          <FieldRow label="Border px">
            <input
              type="number"
              min={0}
              max={8}
              value={defaults.style.borderWidth}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, borderWidth: Number(e.target.value) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
            />
          </FieldRow>
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--border)", fontSize: 10, color: "var(--text-muted)" }}>
            Padding (gap between text and bg edge)
          </div>
          <FieldRow label="X (left + right)">
            <input
              type="number"
              min={0}
              max={64}
              value={defaults.style.paddingX}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingX: Number(e.target.value) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
              title="Horizontal inset — both sides. Overridden by per-side values below when set."
            />
          </FieldRow>
          <FieldRow label="Y (top + bottom)">
            <input
              type="number"
              min={0}
              max={64}
              value={defaults.style.paddingY}
              onChange={(e) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingY: Number(e.target.value) } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
              title="Vertical inset — top and bottom. Overridden by per-side values below when set."
            />
          </FieldRow>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, marginBottom: 4 }}>
            Per-side overrides (blank = use X / Y above). Applies to default and 9-slice modes.
          </div>
          <FieldRow label="Top">
            <OptionalNumber
              value={defaults.style.paddingTop}
              fallback={defaults.style.paddingY}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingTop: v } })}
            />
          </FieldRow>
          <FieldRow label="Right">
            <OptionalNumber
              value={defaults.style.paddingRight}
              fallback={defaults.style.paddingX}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingRight: v } })}
            />
          </FieldRow>
          <FieldRow label="Bottom">
            <OptionalNumber
              value={defaults.style.paddingBottom}
              fallback={defaults.style.paddingY}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingBottom: v } })}
            />
          </FieldRow>
          <FieldRow label="Left">
            <OptionalNumber
              value={defaults.style.paddingLeft}
              fallback={defaults.style.paddingX}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, paddingLeft: v } })}
            />
          </FieldRow>
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed var(--border)", fontSize: 10, color: "var(--text-muted)" }}>
            Box position (camera bottom)
          </div>
          <FieldRow label="Offset X">
            <NumberField
              step={2}
              value={defaults.style.boxOffsetX}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, boxOffsetX: v } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
              title="Horizontal offset from camera center. + right, - left."
            />
          </FieldRow>
          <FieldRow label="Offset Y">
            <NumberField
              step={2}
              value={defaults.style.boxOffsetY}
              onChange={(v) => setProjectDialogueDefaults({ style: { ...defaults.style, boxOffsetY: v } })}
              style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
              title="Gap above the camera's bottom edge. Larger = bubble sits higher up the screen (default 16)."
            />
          </FieldRow>
        </div>
      </div>

      {pendingMapping && (
        <SpeakerMappingModal
          asset={dialogue}
          unmatched={pendingMapping.speakers}
          onConfirm={(mapping) => {
            const merged = { ...dialogue.speakerMap, ...mapping };
            setDialogueSpeakerMap(dialogue.id, merged);
            setPendingMapping(null);
          }}
          onCancel={() => setPendingMapping(null)}
        />
      )}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ ...labelStyle, width: 100, flexShrink: 0 }}>{label}</span>
      {children}
    </label>
  );
}

/** Number input where blank = inherit a fallback value. Used for the
 *  per-side dialog padding rows: typing a number sets the override,
 *  clearing the field drops back to paddingX / paddingY. */
function OptionalNumber({
  value, fallback, onChange,
}: {
  value: number | undefined;
  fallback: number;
  onChange: (v: number | undefined) => void;
}) {
  const [draft, setDraft] = useState<string>(value === undefined ? "" : String(value));
  // Sync from prop when external changes (preset, reset, etc.).
  useEffect(() => { setDraft(value === undefined ? "" : String(value)); }, [value]);
  const commit = () => {
    const t = draft.trim();
    if (t === "") { if (value !== undefined) onChange(undefined); return; }
    const n = Number(t);
    if (!Number.isFinite(n)) { setDraft(value === undefined ? "" : String(value)); return; }
    if (n !== value) onChange(n);
  };
  return (
    <input
      type="number"
      min={0}
      max={64}
      value={draft}
      placeholder={`${fallback}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(); (e.currentTarget as HTMLInputElement).blur(); } }}
      style={{ fontSize: 11, padding: "2px 6px", width: 80 }}
      title="Leave blank to inherit from X / Y above."
    />
  );
}

function LineCard({
  line,
  index,
  speakerCell,
  dialoguesForGoTo,
  onChangeText,
  onAddDelay,
  onChangeDelay,
  onClearDelay,
  onAddEmit,
  onChangeEmit,
  onClearEmit,
  onAddChoice,
  onChangeChoice,
  onRemoveChoice,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  line: DialogueLine;
  index: number;
  speakerCell: React.ReactNode;
  dialoguesForGoTo: DialogueAsset[];
  onChangeText: (text: string) => void;
  onAddDelay: () => void;
  onChangeDelay: (v: number) => void;
  onClearDelay: () => void;
  onAddEmit: () => void;
  onChangeEmit: (v: string) => void;
  onClearEmit: () => void;
  onAddChoice: () => void;
  onChangeChoice: (cid: string, patch: Partial<DialogueChoice>) => void;
  onRemoveChoice: (cid: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ ...labelStyle, width: 28, fontFamily: "ui-monospace, monospace" }}>{index + 1}</span>
        {speakerCell}
        <span style={{ flex: 1 }} />
        <button className="ghost" style={miniBtn} onClick={onMoveUp} title="Move up">▲</button>
        <button className="ghost" style={miniBtn} onClick={onMoveDown} title="Move down">▼</button>
        <button className="ghost" style={{ ...miniBtn, color: "var(--red)" }} onClick={onRemove} title="Delete line">×</button>
      </div>
      <textarea
        value={line.text}
        onChange={(e) => onChangeText(e.target.value)}
        rows={Math.max(1, line.text.split("\n").length)}
        placeholder="Line text… {var} interpolation supported."
        style={{ fontSize: 12, padding: "4px 6px", resize: "vertical", minHeight: 28, fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {line.delaySec === undefined ? (
          <button className="ghost" style={chipBtn} onClick={onAddDelay} title="Insert a wait before this line plays">+ delay</button>
        ) : (
          <span style={chipFilled}>
            wait
            <input
              type="number"
              min={0}
              step={0.1}
              value={line.delaySec}
              onChange={(e) => onChangeDelay(Number(e.target.value))}
              style={{ width: 50, fontSize: 11, padding: "1px 4px" }}
            />
            s
            <button className="ghost" style={miniBtn} onClick={onClearDelay} title="Remove delay">×</button>
          </span>
        )}
        {line.emitSignal === undefined ? (
          <button className="ghost" style={chipBtn} onClick={onAddEmit} title="Emit a signal when this line begins">+ emit</button>
        ) : (
          <span style={chipFilled}>
            emit
            <input
              type="text"
              value={line.emitSignal}
              onChange={(e) => onChangeEmit(e.target.value)}
              placeholder="SignalName"
              style={{ width: 110, fontSize: 11, padding: "1px 4px" }}
            />
            <button className="ghost" style={miniBtn} onClick={onClearEmit} title="Remove emit">×</button>
          </span>
        )}
        <button className="ghost" style={chipBtn} onClick={onAddChoice} title="Attach a choice option to this line">+ choice</button>
      </div>
      {line.choices && line.choices.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 18, borderLeft: "2px solid var(--accent)" }}>
          {line.choices.map((c, ci) => (
            <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...labelStyle, width: 20 }}>{ci + 1}</span>
                <input
                  type="text"
                  value={c.text}
                  onChange={(e) => onChangeChoice(c.id, { text: e.target.value })}
                  placeholder="Option text"
                  style={{ flex: 1, fontSize: 12, padding: "2px 6px" }}
                />
                <button className="ghost" style={{ ...miniBtn, color: "var(--red)" }} onClick={() => onRemoveChoice(c.id)} title="Remove choice">×</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 26 }}>
                <span style={{ fontSize: 10, color: "var(--text-muted)", width: 38 }}>emit</span>
                <input
                  type="text"
                  value={c.emitSignal}
                  onChange={(e) => onChangeChoice(c.id, { emitSignal: e.target.value })}
                  placeholder="ChoseX (optional)"
                  style={{ flex: 1, fontSize: 11, padding: "2px 6px", maxWidth: 160 }}
                  title="Signal name fired when this option is picked. Listen for it via OnSignal in any event sheet."
                />
                <span style={{ fontSize: 10, color: "var(--text-muted)", width: 38, marginLeft: 4 }}>go to</span>
                <select
                  value={c.goToDialogue ?? ""}
                  onChange={(e) => onChangeChoice(c.id, { goToDialogue: e.target.value || undefined })}
                  style={{ flex: 1, fontSize: 11, padding: "2px 4px", maxWidth: 180 }}
                  title="When picked, immediately stop this dialogue and play the selected one. Pairs cleanly with emit — both fire."
                >
                  <option value="">— stay in this dialogue —</option>
                  {dialoguesForGoTo.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                  {/* If goToDialogue points at a deleted dialogue, surface
                      the orphan id so the user can clear it. */}
                  {c.goToDialogue && !dialoguesForGoTo.some((d) => d.id === c.goToDialogue) && (
                    <option value={c.goToDialogue}>{c.goToDialogue} (missing)</option>
                  )}
                </select>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 6px",
  minWidth: 0,
};

const chipBtn: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 999,
};

const chipFilled: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 6px 2px 8px",
  fontSize: 11,
  background: "rgba(255, 255, 255, 0.06)",
  border: "1px solid var(--border)",
  borderRadius: 999,
};

/**
 * 9-slice PNG dialog-box asset manager. Shown when the Bubble Style theme
 * is set to "Custom Image". Lets the user upload a PNG, tune the four
 * slice cuts (left/right/top/bottom in pixels), and pick which box is
 * bound to the dialogue's style.boxAssetId.
 *
 * The PNG is stored inline as a data-URL on the project — fine for the
 * small box artwork typical here (corners + edges + tileable middle
 * compress well; <10KB is normal). For sprite-sheet-class asset sizes,
 * a future revision would push the bytes through AssetStore the same way
 * sound / font assets do.
 */
function DialogBoxAssetSection({ currentId, onPick }: { currentId: string; onPick: (id: string) => void }) {
  const boxes = useEditor((s) => s.project.dialogBoxes ?? []);
  const addDialogBox = useEditor((s) => s.addDialogBox);
  const updateDialogBox = useEditor((s) => s.updateDialogBox);
  const removeDialogBox = useEditor((s) => s.removeDialogBox);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (!dataUrl.startsWith("data:image/")) return;
      const baseName = file.name.replace(/\.[a-z0-9]+$/i, "");
      const newId = addDialogBox({ name: baseName, dataUrl, sliceLeft: 16, sliceRight: 16, sliceTop: 16, sliceBottom: 16 });
      // Auto-select the new asset so the user sees their upload take effect
      // immediately — saves an extra click on the "Bound box" dropdown.
      onPick(newId);
    };
    reader.readAsDataURL(file);
  };
  return (
    <div style={{
      borderTop: "1px dashed var(--border)",
      paddingTop: 8,
      marginTop: 4,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <FieldRow label="Bound box">
        <select
          value={currentId}
          onChange={(e) => onPick(e.target.value)}
          style={{ fontSize: 11, padding: "2px 4px", flex: 1 }}
          title="Which uploaded box asset to render. Empty / unknown id → falls back to procedural modern theme."
        >
          <option value="">— pick a box —</option>
          {boxes.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button
          onClick={() => fileRef.current?.click()}
          style={{ fontSize: 10, padding: "2px 8px", marginLeft: 6 }}
          title="Upload a new PNG box. The new asset is selected automatically."
        >
          Upload PNG…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            onUpload(f);
            // Reset the input so re-selecting the same file fires onChange.
            if (e.target) e.target.value = "";
          }}
        />
      </FieldRow>
      {boxes.map((b) => {
        const isCurrent = b.id === currentId;
        return (
          <div
            key={b.id}
            style={{
              padding: 8,
              border: `1px solid ${isCurrent ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 6,
              background: isCurrent ? "rgba(120, 180, 255, 0.06)" : "transparent",
              display: "flex",
              gap: 10,
            }}
          >
            {/* Preview thumbnail — shows the source PNG at natural size up
                to a 64px cap so the user can see what they uploaded. */}
            <div style={{ width: 64, height: 64, background: "#222", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
              <img src={b.dataUrl} alt={b.name} style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }} />
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="text"
                  value={b.name}
                  onChange={(e) => updateDialogBox(b.id, { name: e.target.value })}
                  style={{ flex: 1, fontSize: 11, padding: "2px 6px" }}
                  title="Display name for the picker."
                />
                <button
                  onClick={() => {
                    if (!confirm(`Delete box "${b.name}"?`)) return;
                    removeDialogBox(b.id);
                  }}
                  style={{ fontSize: 10, padding: "2px 6px" }}
                  title="Remove this box asset. Any dialog style still referencing it will fall back to modern."
                >
                  ×
                </button>
              </div>
              {/* Four slice cuts. Corners are drawn unscaled; edges stretch
                  on one axis; middle stretches both. Set each to the pixel
                  distance from that edge of the PNG to where the stretchable
                  middle should begin. */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 10 }}>
                <SliceField label="Left"   value={b.sliceLeft}   onChange={(v) => updateDialogBox(b.id, { sliceLeft: v })} />
                <SliceField label="Right"  value={b.sliceRight}  onChange={(v) => updateDialogBox(b.id, { sliceRight: v })} />
                <SliceField label="Top"    value={b.sliceTop}    onChange={(v) => updateDialogBox(b.id, { sliceTop: v })} />
                <SliceField label="Bottom" value={b.sliceBottom} onChange={(v) => updateDialogBox(b.id, { sliceBottom: v })} />
              </div>
            </div>
          </div>
        );
      })}
      {boxes.length === 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "4px 0", lineHeight: 1.4 }}>
          No box assets yet. Click <b>Upload PNG…</b> above. Tip: design your box at the size you want corners to render (e.g. 64×64 with 16px corner regions). The engine stretches the middle to fill any dialog size while keeping corners crisp.
        </div>
      )}
    </div>
  );
}

function SliceField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
      <span style={{ minWidth: 42 }}>{label}</span>
      <input
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, fontSize: 10, padding: "1px 4px" }}
      />
    </label>
  );
}
