/**
 * Plain-text dialogue script parser.
 *
 * Format (one line per source line; line breaks mean what they look like):
 *
 *   # comment lines are ignored
 *   Alice: Hey, what's that?
 *   Bob: Beats me. Looks heavy.
 *
 *   [wait 1.5]
 *   Alice: Should we open it?
 *   > Yes  [emit ChoseOpen]
 *   > No   [emit ChoseLeave]
 *
 *   [emit DoorAboutToOpen]
 *   Narrator: ...the moment hangs in the air.
 *
 * Rules:
 *   - `Name:` at line start → speaker change. Subsequent lines without a
 *     `Name:` prefix are continuation lines for that speaker (joined with
 *     `\n`).
 *   - Blank line → terminates the current line block (acts as separator).
 *   - `# ...` → comment, ignored.
 *   - `[wait N]` → adds `delaySec = N` to the NEXT non-bracket line.
 *   - `[emit Name]` → adds `emitSignal = Name` to the line it's attached to
 *     (the most recent or upcoming line). Multiple emits on one line: last
 *     one wins (use multiple lines if you need multiple signals).
 *   - `> Option text [emit Sig]` → choice attached to the most recent
 *     speaker line. Each choice MUST carry an `[emit Sig]`. If missing the
 *     parser still keeps the choice but with `emitSignal=""` so the editor
 *     can prompt the user to fill it in.
 *   - Lines without a leading speaker AND no prior speaker → assigned to
 *     the built-in `Narrator` label.
 *
 * The parser is intentionally forgiving: malformed inputs degrade into the
 * closest reasonable interpretation rather than throwing. This keeps the
 * upload flow friction-free — if something looks wrong the user can fix it
 * in the visual editor afterwards.
 */

export interface DialogueChoiceParsed {
  text: string;
  emitSignal: string;
  /** Target dialogue NAME (raw from script) when the option uses
   *  `-> dialogueName` syntax. The editor resolves this to a dialogue id
   *  on import; if no matching dialogue exists, the field is left unset
   *  for the user to wire up later. */
  goToDialogueName?: string;
}

export interface DialogueLineParsed {
  speaker: string;
  text: string;
  delaySec?: number;
  emitSignal?: string;
  choices?: DialogueChoiceParsed[];
}

export interface ParsedDialogue {
  lines: DialogueLineParsed[];
  /** Unique speaker labels in order of first appearance. Includes "Narrator"
   *  when any line was assigned to the implicit narrator. */
  speakers: string[];
}

/** Matches `Name: rest of line`. Speaker = letters / digits / spaces /
 *  underscore, must NOT start with a digit. Trailing colon mandatory. */
const SPEAKER_LINE = /^([A-Za-z_][A-Za-z0-9_ ]*):\s?(.*)$/;
/** Matches a `[wait N]` directive — N is a non-negative decimal. */
const WAIT_TAG = /\[wait\s+(\d+(?:\.\d+)?)\s*\]/i;
/** Matches `[emit SignalName]` — signal name keeps it simple (no spaces). */
const EMIT_TAG = /\[emit\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\]/i;
/** Matches a choice option line: `> Text [emit Sig]`. */
const CHOICE_LINE = /^>\s*(.+)$/;

/** Strip every `[wait …]` and `[emit …]` tag from `s`, return the cleaned
 *  string plus the parsed values. The caller decides where to attach them. */
function extractTags(s: string): { text: string; delaySec?: number; emitSignal?: string } {
  let text = s;
  let delaySec: number | undefined;
  let emitSignal: string | undefined;
  const w = text.match(WAIT_TAG);
  if (w) {
    delaySec = parseFloat(w[1]);
    text = text.replace(WAIT_TAG, "").trim();
  }
  const e = text.match(EMIT_TAG);
  if (e) {
    emitSignal = e[1];
    text = text.replace(EMIT_TAG, "").trim();
  }
  return { text, delaySec, emitSignal };
}

export function parseDialogueScript(source: string): ParsedDialogue {
  const lines: DialogueLineParsed[] = [];
  const speakerSet = new Set<string>();
  const speakerOrder: string[] = [];

  // Buffer for the current line being built. We accumulate continuation
  // lines into `text` until a blank line or speaker change flushes it.
  let cur: DialogueLineParsed | null = null;
  // Pending delay from a standalone `[wait N]` line — applied to the NEXT
  // non-bracket line that begins.
  let pendingDelay: number | undefined;
  // Pending emit from a standalone `[emit Name]` line — same idea.
  let pendingEmit: string | undefined;

  const flushCurrent = () => {
    if (!cur) return;
    if (!speakerSet.has(cur.speaker)) {
      speakerSet.add(cur.speaker);
      speakerOrder.push(cur.speaker);
    }
    lines.push(cur);
    cur = null;
  };

  const startLine = (speaker: string, text: string, lineDelay?: number, lineEmit?: string) => {
    flushCurrent();
    const delay = lineDelay ?? pendingDelay;
    const emit = lineEmit ?? pendingEmit;
    pendingDelay = undefined;
    pendingEmit = undefined;
    cur = { speaker, text };
    if (delay !== undefined) cur.delaySec = delay;
    if (emit !== undefined) cur.emitSignal = emit;
  };

  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of rawLines) {
    const trimmed = raw.trim();

    // Comment / blank.
    if (!trimmed || trimmed.startsWith("#")) {
      // Blank line terminates the current block; comment leaves it alone
      // so multi-line speaker continuations can include comments between.
      if (!trimmed) flushCurrent();
      continue;
    }

    // Standalone bracket directives — `[wait N]` and/or `[emit Name]` with
    // no other text. These don't start a new line; they attach to the
    // upcoming line.
    const onlyTagsCheck = trimmed.replace(WAIT_TAG, "").replace(EMIT_TAG, "").trim();
    if (onlyTagsCheck === "") {
      const w = trimmed.match(WAIT_TAG);
      const e = trimmed.match(EMIT_TAG);
      if (w) pendingDelay = parseFloat(w[1]);
      if (e) pendingEmit = e[1];
      // A standalone bracket directive ends any in-progress line block —
      // continuation lines can't span across these tags.
      flushCurrent();
      continue;
    }

    // Choice option — attaches to the most recent line.
    const choiceMatch = trimmed.match(CHOICE_LINE);
    if (choiceMatch) {
      const target = cur ?? lines[lines.length - 1];
      if (!target) {
        // No prior line — degrade gracefully: skip the orphan choice.
        continue;
      }
      let optBody = choiceMatch[1];
      // Extract `-> dialogueName` (must come AFTER text, before any
      // trailing tags). Greedy match through end of line, then strip
      // trailing tags from the captured name.
      let goToDialogueName: string | undefined;
      const gotoMatch = optBody.match(/->\s*([^\s\[].*)$/);
      if (gotoMatch) {
        // Strip any trailing tags from the captured name.
        let raw = gotoMatch[1];
        raw = raw.replace(WAIT_TAG, "").replace(EMIT_TAG, "").trim();
        if (raw) goToDialogueName = raw;
        optBody = optBody.replace(/->\s*[^\s\[].*$/, "").trim();
      }
      const { text, emitSignal } = extractTags(optBody);
      const choice: DialogueChoiceParsed = {
        text: text.trim(),
        emitSignal: emitSignal ?? "",
        ...(goToDialogueName ? { goToDialogueName } : {}),
      };
      (target.choices ??= []).push(choice);
      continue;
    }

    // Speaker line.
    const speakerMatch = trimmed.match(SPEAKER_LINE);
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim();
      const rest = speakerMatch[2];
      const { text, delaySec, emitSignal } = extractTags(rest);
      startLine(speaker, text.trim(), delaySec, emitSignal);
      continue;
    }

    // Continuation OR narrator line.
    const { text, delaySec, emitSignal } = extractTags(trimmed);
    // TypeScript's flow analysis narrows `cur` to `null` because the
    // closures (startLine / flushCurrent) are opaque — it can't see that
    // startLine reassigns to a non-null value. Cast back to the union so
    // we can safely branch on it.
    const c = cur as DialogueLineParsed | null;
    if (c) {
      c.text = c.text ? `${c.text}\n${text.trim()}` : text.trim();
      // Inline tags on a continuation merge into the current line.
      if (delaySec !== undefined && c.delaySec === undefined) c.delaySec = delaySec;
      if (emitSignal !== undefined && !c.emitSignal) c.emitSignal = emitSignal;
    } else {
      // No active speaker → narrator line.
      startLine("Narrator", text.trim(), delaySec, emitSignal);
    }
  }
  flushCurrent();

  // Ensure "Narrator" appears in the speakers list when any narrator line
  // exists, even if it was implicit.
  if (lines.some((l) => l.speaker === "Narrator") && !speakerSet.has("Narrator")) {
    speakerOrder.push("Narrator");
  }

  return { lines, speakers: speakerOrder };
}
