import Phaser from "phaser";
import { Sprite } from "../Sprite";
import { getInputActions } from "../input/InputActions";
import { Logger } from "../Logger";
import { setupCrispText, refreshCrispText } from "../textRendering";

/**
 * Runtime spec for one option in a choice block. `emitSignal` and
 * `goToDialogue` are independent — picking can do either or both.
 */
export interface DialogueChoiceSpec {
  id: string;
  text: string;
  emitSignal: string;
  /** When set, picking this choice stops the current dialogue and starts
   *  the asset with this id. Both happen on the same frame. */
  goToDialogue?: string;
}

export interface DialogueLineSpec {
  id: string;
  /** Resolved at build time: the Blueprint id whose sprite should anchor
   *  the speech bubble in overhead mode. Empty string → use the camera-
   *  fixed fallback position (top-center). */
  speakerBpId: string;
  /** Original speaker label from the script — shown above the line in
   *  box mode and as the bubble header in overhead mode. */
  speakerLabel: string;
  text: string;
  delaySec?: number;
  emitSignal?: string;
  choices?: DialogueChoiceSpec[];
}

/** Per-asset visual style. Falls back to project defaults when unset. */
export type DialogueTheme =
  | "modern"
  | "jrpg"
  | "comic"
  | "comic-shout"
  | "comic-thought"
  | "comic-whisper"
  | "comic-news"
  | "image";

/** 9-slice PNG dialog box asset spec (runtime mirror of editor's
 *  DialogBoxAsset). Looked up at render time when style.theme === "image"
 *  and style.boxAssetId is set. The PNG is registered as a Phaser texture
 *  on scene start (key = `dlgbox:<id>`); the 9 slices are computed at draw
 *  time so the box scales smoothly with the dialog's measured content. */
export interface DialogBoxAssetSpec {
  id: string;
  /** Phaser texture key the PNG was registered under. Always
   *  `dlgbox:<id>` — kept on the spec so DialogueRunner doesn't have to
   *  reconstruct it. */
  textureKey: string;
  /** Source PNG natural pixel dimensions. Used to compute the inner /
   *  edge / middle slice rects. */
  imgW: number;
  imgH: number;
  /** Slice cuts in pixels from each edge of the PNG. Clamped at draw
   *  time so corners don't overlap. */
  sliceLeft: number;
  sliceRight: number;
  sliceTop: number;
  sliceBottom: number;
}

/** Sentinel for the per-scene registry of dialog box specs. Populated by
 *  runProject and queried by DialogueRunner.drawThemedBox. */
export const DIALOG_BOXES_KEY = "peaky.dialogBoxes";
export interface DialogueStyleSpec {
  /** Visual theme — drives box shape, speaker label placement, separators,
   *  continue indicator. Colors/fonts/sizes still come from the rest of the
   *  style so themes can be re-tinted. Defaults to "modern" on legacy
   *  assets via the runProject style hydration path. */
  theme?: DialogueTheme;
  /** When `theme === "image"`, the DialogBoxAsset id to render as a 9-slice.
   *  Empty / unknown id → falls back to procedural modern theme. */
  boxAssetId?: string;
  bgColor: number;        // 0xRRGGBB
  bgAlpha: number;        // 0..1
  borderColor: number;
  borderWidth: number;
  textColor: string;      // CSS color (Phaser Text style format)
  speakerColor: string;
  fontFamily: string;
  fontSize: number;       // px
  paddingX: number;
  paddingY: number;
  /** Per-side padding overrides — when set, override the symmetric
   *  paddingX / paddingY for that edge only. Lets authors tune the
   *  bottom gap larger than the top (under a portrait), or shrink the
   *  text inset on one side. Undefined = fall back to paddingX/paddingY.
   *  Applies in both default and 9-slice modes. */
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** Box-mode width (px). Auto-clamps the overhead bubble too. */
  boxWidth: number;
  /** Overhead-mode offset from the speaker sprite's head (top edge).
   *  Negative Y pushes the bubble higher above the head. */
  overheadOffsetX: number;
  overheadOffsetY: number;
  /** Box-mode offset from camera bottom-center. Y is the gap from the
   *  bottom edge (positive = pushes box up). */
  boxOffsetX: number;
  boxOffsetY: number;
}

export interface DialogueAssetSpec {
  id: string;
  name: string;
  lines: DialogueLineSpec[];
  displayMode: "overhead" | "box";
  advanceAction: string;
  autoAdvanceSec: number;
  typewriterCps: number;
  style: DialogueStyleSpec;
  /** When set, picking a choice ECHOES the chosen text as a line spoken
   *  by this BP — RPG-style "player recites their answer" UX. Empty = no
   *  echo (choice action fires immediately on pick). */
  playerSpeakerBpId: string;
  /** Display label for the player speaker bubble — typically the BP's
   *  name. Cached at spec build time so the runner doesn't have to
   *  reach back into the project shape. */
  playerSpeakerLabel: string;
  /** Per-speaker overhead bubble offset override (label → x/y). When set,
   *  the runner uses this offset INSTEAD of `style.overheadOffsetX/Y` for
   *  that speaker's lines. Tunes each NPC's bubble height independently
   *  (tall boss vs short shopkeeper). */
  speakerOffsets?: Record<string, { x: number; y: number }>;
  /** Freeze player's CharacterMovement during this dialog. */
  freezePlayerDuringDialog?: boolean;
  /** Freeze every NPC speaker's CharacterMovement during this dialog. */
  freezeNpcsDuringDialog?: boolean;
}

interface RunState {
  asset: DialogueAssetSpec;
  lineIdx: number;
  /** True for the first update() after play() / beginLine(). The frame
   *  that fired PlayDialogue likely also has the advance key just-pressed
   *  (the user's event uses the same key for both). Without this guard
   *  that single press would: (a) start the dialogue AND (b) immediately
   *  skip the typewriter reveal of line 1 — making the first line flash
   *  in fully-revealed before the user even sees it animate. */
  ignoreInputThisFrame: boolean;
  /** Phase within the current line:
   *   - "delay"          — waiting `delayRemaining` seconds before reveal.
   *   - "reveal"         — typewriter is progressively revealing text.
   *   - "await-advance"  — text is fully revealed; waiting for input or auto.
   *   - "await-choice"   — choices visible; waiting for 1..N key. */
  phase: "delay" | "reveal" | "pre-choice" | "await-advance" | "await-choice";
  /** Countdown timer (seconds) for the pre-choice pause — set in
   *  transitionToAwait when the line has choices, ticked down by the
   *  pre-choice phase handler. Lets the player read the just-finished
   *  line for a moment before the choice list appears. */
  choiceDisplayDelayRemaining: number;
  /** Buffered choices set by transitionToAwait; consumed by the
   *  pre-choice → await-choice transition. */
  pendingChoices?: DialogueChoiceSpec[];
  delayRemaining: number;
  /** Total characters revealed so far (line content only — speaker label
   *  always renders fully). */
  charsRevealed: number;
  /** Resolved full text, including any inline `{var}` interpolation. */
  fullText: string;
  /** Speaker label resolved at line begin (empty string if none). */
  speakerLabel: string;
  /** Cached current speaker sprite (for overhead-mode positioning).
   *  Re-resolved if it gets destroyed mid-line. */
  speakerSprite?: Sprite;
  /** Auto-advance countdown when `autoAdvanceSec > 0`. */
  autoAdvanceRemaining: number;
  /** Cached choice list — copy from the line so we don't allocate per-frame. */
  choices?: DialogueChoiceSpec[];
  /** When set, the current line state is a synthesized "player echo" of a
   *  picked choice. After this echo line is advanced past, run the
   *  pending action (advance to next line OR jump to a different
   *  dialogue). Cleared when consumed. */
  pendingChoiceAction?:
    | { kind: "advance"; nextLineIdx: number }
    | { kind: "goTo"; dialogueId: string };
}

/** Sentinel used in `scene.data` to find the runner. */
export const DIALOGUE_KEY = "peaky.dialogue";

/** Convert a CSS color string ("#rrggbb" or "rrggbb") to a Phaser-style
 *  0xRRGGBB number. Returns null if the input isn't a valid 6-hex color
 *  (e.g. named colors like "white" or 3-digit shorthand) — callers fall
 *  back to a sensible default. */
function parseCssColor(s: string): number | null {
  if (!s) return null;
  const m = s.match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  return parseInt(m[1], 16);
}

/**
 * Per-scene singleton that drives dialogue playback.
 *
 * The runner OWNS its UI — a Phaser GameObject overlay (background +
 * speaker name + line text) that's created on first play, updated each
 * frame, and destroyed on stop. No per-Blueprint setup is required:
 * any sprite can speak, the runner pins the bubble above its head
 * (overhead mode) or shows it in a fixed bottom box (box mode).
 *
 * Stored on `scene.data.set(DIALOGUE_KEY, runner)`. eval.ts dispatches
 * `PlayDialogue` / `StopDialogue` / `AdvanceDialogue` here.
 */
export class DialogueRunner {
  private current: RunState | null = null;
  /** Last main-cam zoom value that crisp-text resolution was applied for.
   *  -1 sentinel means "no zoom applied yet". Compared each frame in
   *  repositionOverlay so a mid-dialog SetCameraZoom triggers exactly
   *  one resolution refresh, not a per-frame setResolution churn. */
  private _lastAppliedCamZoom = -1;
  /** Last line index for which we logged the offset breakdown. Prevents
   *  spamming the console once per frame; logs only when the line changes. */
  private _loggedOffsetForLineIdx = -1;
  private readonly assetById = new Map<string, DialogueAssetSpec>();

  // Owned overlay objects — created lazily on first play.
  private overlay?: Phaser.GameObjects.Container;
  /** Drop shadow behind the main box (modern + comic themes). Drawn as a
   *  separate Graphics so it can be offset/translucent independently. */
  private shadowObj?: Phaser.GameObjects.Graphics;
  /** Main box background — re-drawn each repositionOverlay with the
   *  current theme. Replaces the prior flat Rectangle so we can do
   *  rounded corners / double borders / speech-bubble tails. */
  private bg?: Phaser.GameObjects.Graphics;
  /** Speaker name pill/box background (modern + jrpg themes). Drawn as a
   *  separate Graphics so its position/shape doesn't blend with the main
   *  bg's stroke. */
  private speakerBgObj?: Phaser.GameObjects.Graphics;
  private speakerObj?: Phaser.GameObjects.Text;
  /** Thin divider line between speaker and line text (modern + comic
   *  themes). JRPG theme hides it (speaker has its own box). */
  private separatorObj?: Phaser.GameObjects.Graphics;
  private lineObj?: Phaser.GameObjects.Text;
  /** Blinking "press to advance" indicator. ▼ for box mode, ▶ for jrpg.
   *  Alpha is tweened by repositionOverlay based on dialog phase + time. */
  private continueObj?: Phaser.GameObjects.Text;
  /** Lazy 9-slice GameObject for the `image` theme. Created on first use
   *  once the box asset's texture has decoded; reused across subsequent
   *  renders. Stays hidden while other themes are active. */
  private nineSliceObj?: Phaser.GameObjects.NineSlice;
  /** Texture key currently bound to nineSliceObj. Used to detect when the
   *  author swapped to a different box asset mid-session so we re-create
   *  the slice with the new texture instead of dragging the stale binding. */
  private _nineSliceTextureKey = "";
  /** Cache key of the last drawThemedBox paint. Themes like comic-news
   *  draw 1700+ halftone dots per pass and comic-thought has ~40 stroked
   *  arcs around the perimeter — redrawing them every frame trashes
   *  framerate even though nothing visually changed between frames.
   *  Keyed on every input that affects the painted pixels; when the key
   *  matches, drawThemedBox early-outs and the existing Graphics buffers
   *  stay on screen unchanged. */
  private _lastBoxDrawKey = "";

  constructor(
    private readonly scene: Phaser.Scene,
    assets: DialogueAssetSpec[],
  ) {
    for (const a of assets) this.assetById.set(a.id, a);
  }

  setAssets(assets: DialogueAssetSpec[]): void {
    this.assetById.clear();
    for (const a of assets) this.assetById.set(a.id, a);
  }

  isPlaying(): boolean {
    return !!this.current;
  }

  /** Start a dialogue. Optional `overrides` come from the PlayDialogue
   *  action's per-call config.
   *
   *  No-ops when ANY dialogue is already playing — this is what lets the
   *  user wire `OnKeyPressed[Interact] → PlayDialogue` to start a chat
   *  AND use the same key to advance lines. Without this guard the second
   *  press would restart the dialogue from line 0 (the OnKeyPressed event
   *  fires every press, regardless of dialogue state). To force a restart,
   *  call StopDialogue first. To chain scripts, listen for OnDialogueEnd
   *  and call PlayDialogue from there — by then `current` is null so the
   *  next play goes through. */
  play(assetIdOrName: string, overrides?: Record<string, unknown>): void {
    // Look up by id first (the canonical key), fall back to name match
    // so the Logic Sheet's dialogue-name dropdown works without forcing
    // authors to know the internal id.
    let base = this.assetById.get(assetIdOrName);
    if (!base) {
      for (const a of this.assetById.values()) {
        if (a.name === assetIdOrName) { base = a; break; }
      }
    }
    if (!base) {
      Logger.log({
        level: "warn",
        source: "Dialogue",
        message: `PlayDialogue: no dialogue asset with id or name "${assetIdOrName}".`,
      });
      return;
    }
    if (this.current) {
      // Already playing — silently ignore so the trigger key can also
      // serve as the advance key without restarting.
      return;
    }

    // Merge per-call overrides on top of the asset spec.
    const asset: DialogueAssetSpec = {
      ...base,
      displayMode:
        overrides && (overrides.displayMode === "overhead" || overrides.displayMode === "box")
          ? overrides.displayMode
          : base.displayMode,
      advanceAction:
        overrides && typeof overrides.advanceAction === "string" && overrides.advanceAction
          ? overrides.advanceAction
          : base.advanceAction,
      autoAdvanceSec:
        overrides && typeof overrides.autoAdvanceSec === "number"
          ? overrides.autoAdvanceSec
          : base.autoAdvanceSec,
      typewriterCps:
        overrides && typeof overrides.typewriterCps === "number"
          ? overrides.typewriterCps
          : base.typewriterCps,
    };

    this.ensureOverlay(asset);
    this.current = {
      asset,
      lineIdx: -1,
      phase: "delay",
      delayRemaining: 0,
      charsRevealed: 0,
      fullText: "",
      speakerLabel: "",
      autoAdvanceRemaining: 0,
      choiceDisplayDelayRemaining: 0,
      ignoreInputThisFrame: true,
    };
    this.scene.events.emit("OnDialogueStart");
    this.scene.events.emit(`OnDialogueStart:${asset.id}`);
    this.broadcastSignal("OnDialogueStart");
    this.broadcastSignal(`OnDialogueStart:${asset.id}`);
    // Name-keyed variant too — asset-filtered OnDialogueStart triggers store
    // the dialogue NAME (their picker lists names), not the id.
    if (asset.name && asset.name !== asset.id) {
      this.scene.events.emit(`OnDialogueStart:${asset.name}`);
      this.broadcastSignal(`OnDialogueStart:${asset.name}`);
    }
    this.beginLine(0);
  }

  /** Programmatic skip — same effect as the user pressing the advance key.
   *  Mid-reveal: jump to fully revealed. Choice phase: ignored. */
  advance(): void {
    if (!this.current) return;
    const cur = this.current;
    if (cur.phase === "delay") {
      cur.delayRemaining = 0;
      cur.phase = "reveal";
      return;
    }
    if (cur.phase === "reveal") {
      cur.charsRevealed = cur.fullText.length;
      this.flushLineText();
      this.transitionToAwait();
      return;
    }
    if (cur.phase === "await-advance") {
      this.beginLine(cur.lineIdx + 1);
    }
    // await-choice: ignore — user must pick numerically.
  }

  /** Pick a 0-based choice index. Fires the choice's emitSignal AND/OR
   *  jumps to a target dialogue. When `goToDialogue` is set, the current
   *  dialogue stops and the target starts immediately — same frame, same
   *  bubble. Without `goToDialogue`, advances to the next non-choice line
   *  in the current dialogue.
   *
   *  When the asset has `playerSpeakerBpId` configured, the choice's
   *  TEXT first echoes as a player-spoken line (typewriter + advance
   *  press to dismiss) before the underlying action fires. This is the
   *  RPG-style "the player recites their answer first" pattern. */
  pickChoice(idx: number): void {
    if (!this.current || this.current.phase !== "await-choice") return;
    const cur = this.current;
    const opts = cur.choices ?? [];
    if (idx < 0 || idx >= opts.length) return;
    const choice = opts[idx];
    const lineId = cur.asset.lines[cur.lineIdx]?.id ?? "";
    this.scene.events.emit(`OnDialogueChoice:${lineId}:${choice.id}`);
    this.broadcastSignal(`OnDialogueChoice:${lineId}:${choice.id}`);
    if (choice.emitSignal) {
      this.broadcastSignal(choice.emitSignal);
    }

    // Compute the deferred action — what to do once the (optional) echo
    // completes. With echo: stash here, apply on next advance press.
    // Without echo: apply right now.
    const action: RunState["pendingChoiceAction"] = choice.goToDialogue
      ? { kind: "goTo", dialogueId: choice.goToDialogue }
      : { kind: "advance", nextLineIdx: cur.lineIdx + 1 };

    const playerBp = cur.asset.playerSpeakerBpId;
    if (playerBp) {
      const playerSprite = this.findFirstSpriteOfBp(playerBp);
      if (playerSprite) {
        // Echo the chosen text as a player-spoken line. Replace the
        // current line state with a synthesized one — same machinery as
        // beginLine, but the line content comes from the choice rather
        // than the asset.
        cur.fullText = this.interpolateVars(choice.text, playerSprite);
        cur.speakerLabel = cur.asset.playerSpeakerLabel || "";
        cur.speakerSprite = playerSprite;
        cur.charsRevealed = 0;
        cur.choices = undefined;
        cur.delayRemaining = 0;
        cur.phase = "reveal";
        cur.pendingChoiceAction = action;
        cur.ignoreInputThisFrame = true;
        if (this.speakerObj) {
          this.speakerObj.setText(cur.speakerLabel);
          this.speakerObj.setVisible(!!cur.speakerLabel);
        }
        if (this.lineObj) this.lineObj.setText("");
        this.repositionOverlay();
        return;
      }
      // playerSpeakerBpId set but no sprite in scene — fall through to
      // immediate action so the dialogue doesn't deadlock.
      Logger.log({
        level: "warn",
        source: "Dialogue",
        message: `Choice echo skipped — playerSpeakerBpId "${playerBp}" has no sprite in scene.`,
      });
    }

    // No echo configured (or skipped) — apply the action immediately.
    this.applyChoiceAction(action);
  }

  /** Apply a deferred choice action — either advance to the next line in
   *  the current dialogue OR stop+start a different one. Used both for
   *  the no-echo path AND for resolving the echo's pending action when
   *  the player advances past the echo line. */
  private applyChoiceAction(action: NonNullable<RunState["pendingChoiceAction"]>): void {
    if (action.kind === "goTo") {
      this.stop({ silent: true });
      this.play(action.dialogueId);
      return;
    }
    this.beginLine(action.nextLineIdx);
  }

  stop(opts?: { silent?: boolean }): void {
    if (!this.current) return;
    const assetId = this.current.asset.id;
    const assetName = this.current.asset.name;
    this.current = null;
    this.hideOverlay();
    if (!opts?.silent) {
      this.scene.events.emit("OnDialogueEnd");
      this.scene.events.emit(`OnDialogueEnd:${assetId}`);
      this.broadcastSignal("OnDialogueEnd");
      this.broadcastSignal(`OnDialogueEnd:${assetId}`);
      // Name-keyed variant — asset-filtered OnDialogueEnd triggers use the name.
      if (assetName && assetName !== assetId) {
        this.scene.events.emit(`OnDialogueEnd:${assetName}`);
        this.broadcastSignal(`OnDialogueEnd:${assetName}`);
      }
    }
  }

  update(delta: number): void {
    if (!this.current) return;
    const cur = this.current;
    const dt = delta / 1000;
    const ia = getInputActions(this.scene);
    // The first frame after play() / beginLine() ignores input — see the
    // note on RunState.ignoreInputThisFrame for why.
    const inputAllowed = !cur.ignoreInputThisFrame;
    cur.ignoreInputThisFrame = false;
    // Snapshot the just-pressed value once at the top so we can decide
    // which phase consumes it. Without this, the press that completes
    // the typewriter reveal would IMMEDIATELY also satisfy the
    // await-advance check in the same update — net effect "press once
    // to skip a line."
    const advancePressed = inputAllowed && !!ia && !!cur.asset.advanceAction
      && ia.justPressed(cur.asset.advanceAction);

    if (cur.phase === "delay") {
      cur.delayRemaining -= dt;
      if (cur.delayRemaining <= 0) {
        cur.phase = "reveal";
      }
      // No further phase progression this frame — reveal runs next frame.
      this.repositionOverlay();
      return;
    }

    if (cur.phase === "reveal") {
      const cps = cur.asset.typewriterCps;
      if (cps <= 0) {
        cur.charsRevealed = cur.fullText.length;
      } else {
        cur.charsRevealed = Math.min(cur.fullText.length, cur.charsRevealed + cps * dt);
      }
      this.flushLineText();
      // Skip-on-press during reveal — completes the line. The press is
      // CONSUMED by reveal, so the await-advance block does not run this
      // frame even after we transitionToAwait below.
      if (advancePressed) {
        cur.charsRevealed = cur.fullText.length;
        this.flushLineText();
        this.transitionToAwait();
      } else if (cur.charsRevealed >= cur.fullText.length) {
        // Natural end-of-reveal — also transitions, but no input was
        // pressed THIS frame, so await-advance can legitimately consume
        // a press on the very next frame.
        this.transitionToAwait();
      }
      this.repositionOverlay();
      return;
    }
    if (cur.phase === "pre-choice") {
      // Brief pause after typewriter finishes BEFORE choices appear —
      // otherwise the user sees the answer list flash in the same frame
      // the line completes and feels jarring. ~250ms is enough to read
      // "this line just finished" without making the UI feel sluggish.
      cur.choiceDisplayDelayRemaining -= dt;
      if (cur.choiceDisplayDelayRemaining <= 0) {
        cur.phase = "await-choice";
        cur.choices = cur.pendingChoices;
        cur.pendingChoices = undefined;
        this.appendChoicesToText();
      }
      this.repositionOverlay();
      return;
    }

    if (cur.phase === "await-advance") {
      // If we're awaiting advance on a player-echo line, the press
      // applies the deferred choice action (next line OR goToDialogue)
      // instead of bumping lineIdx. Same for auto-advance.
      const fireDeferred = () => {
        const a = cur.pendingChoiceAction;
        cur.pendingChoiceAction = undefined;
        if (a) this.applyChoiceAction(a);
        else this.beginLine(cur.lineIdx + 1);
      };
      if (cur.asset.autoAdvanceSec > 0) {
        cur.autoAdvanceRemaining -= dt;
        if (cur.autoAdvanceRemaining <= 0) {
          fireDeferred();
          return;
        }
      }
      if (advancePressed) {
        fireDeferred();
        return;
      }
      this.repositionOverlay();
      return;
    }

    if (cur.phase === "await-choice") {
      if (inputAllowed) {
        const opts = cur.choices ?? [];
        for (let i = 0; i < opts.length && i < 9; i++) {
          const keyName = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"][i];
          const k = this.scene.input.keyboard?.addKey(keyName);
          if (k && Phaser.Input.Keyboard.JustDown(k)) {
            this.pickChoice(i);
            return;
          }
        }
      }
      this.repositionOverlay();
      return;
    }

    // Fallback — keep the overlay anchored even if no phase matched.
    this.repositionOverlay();
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private transitionToAwait(): void {
    if (!this.current) return;
    const cur = this.current;
    // CRITICAL: when an echo line is finishing its typewriter, we must
    // go to await-advance (NOT await-choice). pendingChoiceAction
    // signals that the current displayed line is an echo synthesized
    // from a picked choice — `cur.lineIdx` still points at the original
    // NPC line which has the choices attached, so re-reading them here
    // would replay the SAME picker on top of the echo text.
    if (cur.pendingChoiceAction) {
      cur.phase = "await-advance";
      cur.choices = undefined;
      cur.autoAdvanceRemaining = cur.asset.autoAdvanceSec;
      return;
    }
    const line = cur.asset.lines[cur.lineIdx];
    if (line.choices && line.choices.length > 0) {
      // Buffer the choices and start the pre-choice pause. The actual
      // append-and-show happens once choiceDisplayDelayRemaining ticks
      // down to 0 — see the "pre-choice" branch in update().
      cur.phase = "pre-choice";
      cur.pendingChoices = line.choices;
      cur.choices = undefined;
      cur.choiceDisplayDelayRemaining = 0.25;
    } else {
      cur.phase = "await-advance";
      cur.choices = undefined;
    }
    cur.autoAdvanceRemaining = cur.asset.autoAdvanceSec;
  }

  /** Move to a specific line index. End-of-script if past the last line. */
  private beginLine(idx: number): void {
    if (!this.current) return;
    const cur = this.current;
    if (idx >= cur.asset.lines.length) {
      this.stop();
      return;
    }
    const line = cur.asset.lines[idx];

    // Per-line signals.
    this.scene.events.emit(`OnDialogueLine:${line.id}`);
    this.broadcastSignal(`OnDialogueLine:${line.id}`);
    if (line.emitSignal) this.broadcastSignal(line.emitSignal);

    // Resolve the speaker sprite for overhead-mode positioning. Tries
    // mapped BP id → instance-name match → BP-name match. Failing all
    // three falls back to the camera-fixed render position; the line
    // still plays. NO per-BP Text component required.
    const speakerSprite = this.resolveSpeakerSprite(line.speakerBpId, line.speakerLabel);
    if (!speakerSprite && (line.speakerBpId || line.speakerLabel)) {
      Logger.log({
        level: "warn",
        source: "Dialogue",
        message: `Line "${line.id}" speaker "${line.speakerLabel || line.speakerBpId}" not in scene — rendering at fallback position.`,
      });
    }

    cur.lineIdx = idx;
    cur.fullText = this.interpolateVars(line.text, speakerSprite);
    // Generic per-line event carrying the shown text — drives the On Dialogue
    // Line trigger node (keyword/content matching).
    this.scene.events.emit("OnDialogueLine", { text: cur.fullText, id: line.id });
    cur.speakerLabel = line.speakerLabel;
    cur.speakerSprite = speakerSprite;
    cur.charsRevealed = 0;
    cur.choices = undefined;
    cur.pendingChoices = undefined;
    cur.choiceDisplayDelayRemaining = 0;
    cur.delayRemaining = Math.max(0, line.delaySec ?? 0);
    cur.phase = cur.delayRemaining > 0 ? "delay" : "reveal";

    // Reset visible text for the new line. Speaker label renders fully
    // (no typewriter) — we only progressive-reveal the line content.
    if (this.speakerObj) {
      this.speakerObj.setText(cur.speakerLabel);
      this.speakerObj.setVisible(!!cur.speakerLabel);
      this.speakerObj.setColor(cur.asset.style.speakerColor);
    }
    if (this.lineObj) {
      this.lineObj.setText("");
      this.lineObj.setColor(cur.asset.style.textColor);
      this.lineObj.setStyle({
        fontFamily: cur.asset.style.fontFamily,
        fontSize: `${cur.asset.style.fontSize}px`,
      });
    }
    this.repositionOverlay();
  }

  /** Replace `{token}` tokens with variable values. Two forms supported:
   *    - `{varName}`           → reads `varName` from the SPEAKER sprite.
   *    - `{BpName.varName}`    → reads `varName` from the FIRST sprite of
   *                              the named Blueprint in the scene.
   *
   *  Same convention the Text behavior uses for the simple form, plus
   *  cross-BP support so an NPC line can reference the player's money
   *  (or any other BP's variable). Missing vars / BPs expand to empty
   *  string — never throws, never warns repeatedly. */
  private interpolateVars(text: string, speaker?: Sprite): string {
    if (!text.includes("{")) return text;
    return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/g, (_full, token: string) => {
      const dot = token.indexOf(".");
      if (dot < 0) {
        // Bare {varName} — read from the speaker.
        if (!speaker) return "";
        const v = speaker.vars.get(token);
        return v === undefined || v === null ? "" : String(v);
      }
      // {BpName.varName} — find the first sprite of BpName, read its var.
      const bpName = token.slice(0, dot);
      const varName = token.slice(dot + 1);
      const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const sprite = all.find((s) => !s.destroyed && s.blueprintName === bpName);
      if (!sprite) return "";
      const v = sprite.vars.get(varName);
      return v === undefined || v === null ? "" : String(v);
    });
  }

  private flushLineText(): void {
    if (!this.lineObj || !this.current) return;
    const cur = this.current;
    const n = Math.max(0, Math.floor(cur.charsRevealed));
    this.lineObj.setText(cur.fullText.slice(0, n));
  }

  /** Append numbered choice list to the line text. v1 layout — v1.5 can
   *  upgrade to a dedicated picker UI. */
  private appendChoicesToText(): void {
    if (!this.lineObj || !this.current) return;
    const cur = this.current;
    const opts = cur.choices ?? [];
    const labels = opts.map((c, i) => `${i + 1}) ${c.text}`).join("\n");
    this.lineObj.setText(`${cur.fullText}\n\n${labels}`);
  }

  /** Create the overlay objects on first use (after we know the style). */
  private ensureOverlay(asset: DialogueAssetSpec): void {
    if (this.overlay) {
      this.overlay.setVisible(true);
      this.applyStyle(asset);
      this.applyDisplayMode(asset.displayMode);
      // After display mode (box vs overhead) swaps the scrollFactor + which
      // camera renders the text, the prior crisp-resolution is stale —
      // re-derive so the next line's text renders sharp under the new
      // transform stack (CSS scale × current cam zoom × dpr).
      if (this.speakerObj) refreshCrispText(this.speakerObj);
      if (this.lineObj) refreshCrispText(this.lineObj);
      return;
    }
    const scene = this.scene;
    const style = asset.style;
    // Drawing layers, back-to-front: shadow → main bg → separator →
    // speaker bg pill → speaker text → line text → continue indicator.
    // Graphics primitives are repainted each repositionOverlay by drawBox()
    // so theme changes (and dynamic resizing for variable-length text)
    // take effect without recreating the container.
    this.shadowObj = scene.add.graphics();
    this.bg = scene.add.graphics();
    this.separatorObj = scene.add.graphics();
    this.speakerBgObj = scene.add.graphics();
    this.speakerObj = scene.add.text(0, 0, "", {
      fontFamily: style.fontFamily,
      fontSize: `${Math.max(10, style.fontSize - 2)}px`,
      color: style.speakerColor,
      fontStyle: "bold",
    });
    setupCrispText(this.speakerObj);
    // Anchor speaker top-LEFT for the modern/jrpg pill alignment; the
    // pill draws around it using the text's measured bounds. Comic theme
    // re-centers via the layout pass.
    this.speakerObj.setOrigin(0, 0);
    this.lineObj = scene.add.text(0, 0, "", {
      fontFamily: style.fontFamily,
      fontSize: `${style.fontSize}px`,
      color: style.textColor,
      wordWrap: { width: style.boxWidth - (style.paddingLeft ?? style.paddingX) - (style.paddingRight ?? style.paddingX) },
      align: "left",
    });
    setupCrispText(this.lineObj);
    this.lineObj.setOrigin(0, 0);
    this.continueObj = scene.add.text(0, 0, "▼", {
      fontFamily: style.fontFamily,
      fontSize: `${Math.max(8, style.fontSize - 4)}px`,
      color: style.textColor,
    });
    setupCrispText(this.continueObj);
    this.continueObj.setOrigin(1, 1);
    this.overlay = scene.add.container(0, 0, [
      this.shadowObj,
      this.bg,
      this.separatorObj,
      this.speakerBgObj,
      this.speakerObj,
      this.lineObj,
      this.continueObj,
    ]);
    // Top of the depth stack — always above gameplay.
    this.overlay.setDepth(100000);
    this.applyDisplayMode(asset.displayMode);
    // Initial setupCrispText ran before applyDisplayMode set the final
    // scrollFactor, so the camera-zoom factor was inferred wrong. Re-derive
    // resolution now that scrollFactor reflects the actual rendering camera.
    refreshCrispText(this.speakerObj);
    refreshCrispText(this.lineObj);
    refreshCrispText(this.continueObj);
  }

  private applyStyle(asset: DialogueAssetSpec): void {
    const style = asset.style;
    // bg / speakerBgObj / separatorObj / shadowObj are Graphics objects —
    // they are RE-DRAWN every repositionOverlay from the current style, so
    // no per-style sync needed here (graphics are dynamic-paint, unlike
    // the prior Rectangle which held its fill/stroke as persistent state).
    if (this.speakerObj) {
      this.speakerObj.setStyle({
        fontFamily: style.fontFamily,
        fontSize: `${Math.max(10, style.fontSize - 2)}px`,
        color: style.speakerColor,
      });
    }
    if (this.lineObj) {
      this.lineObj.setStyle({
        fontFamily: style.fontFamily,
        fontSize: `${style.fontSize}px`,
        color: style.textColor,
        wordWrap: { width: style.boxWidth - (style.paddingLeft ?? style.paddingX) - (style.paddingRight ?? style.paddingX) },
      });
    }
    if (this.continueObj) {
      this.continueObj.setStyle({
        fontFamily: style.fontFamily,
        fontSize: `${Math.max(8, style.fontSize - 4)}px`,
        color: style.textColor,
      });
    }
  }

  /** In `box` mode we anchor to the camera (scrollFactor 0). In `overhead`
   *  mode we anchor to the world (scrollFactor 1) so the bubble follows
   *  the speaker as the camera scrolls.
   *
   *  ALSO routes the overlay to the correct camera:
   *    - box       → UI cam only (mainCam ignores it). HUD-style overlay
   *                  stays crisp under BlurScene, doesn't double-render.
   *    - overhead  → main cam only (uiCam ignores it). World-space bubble
   *                  follows scroll/zoom; the UI cam would draw a second
   *                  fixed-screen copy if not excluded — the "two dialog
   *                  boxes" symptom.
   */
  private applyDisplayMode(mode: "overhead" | "box"): void {
    const sf = mode === "box" ? 0 : 1;
    if (this.shadowObj) this.shadowObj.setScrollFactor(sf, sf);
    if (this.bg) this.bg.setScrollFactor(sf, sf);
    if (this.separatorObj) this.separatorObj.setScrollFactor(sf, sf);
    if (this.speakerBgObj) this.speakerBgObj.setScrollFactor(sf, sf);
    if (this.speakerObj) this.speakerObj.setScrollFactor(sf, sf);
    if (this.lineObj) this.lineObj.setScrollFactor(sf, sf);
    if (this.continueObj) this.continueObj.setScrollFactor(sf, sf);
    const mainCam = this.scene.cameras.main;
    const uiCam = this.scene.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
    if (!this.overlay) return;
    if (mode === "box") {
      // UI cam draws the overlay; main cam ignores it.
      mainCam.ignore(this.overlay);
      if (uiCam) {
        // De-ignore in case the same runner was previously in overhead
        // mode (cameras.ignore is sticky until you swap which display
        // list it's filtering out).
        const ignoreList = (uiCam as unknown as { ignoreObjects?: Set<unknown> }).ignoreObjects;
        if (ignoreList && typeof (ignoreList as { delete?: (v: unknown) => void }).delete === "function") {
          (ignoreList as { delete: (v: unknown) => void }).delete(this.overlay);
        }
      }
    } else {
      // overhead — main cam draws; ui cam ignores.
      if (uiCam) uiCam.ignore(this.overlay);
      const ignoreList = (mainCam as unknown as { ignoreObjects?: Set<unknown> }).ignoreObjects;
      if (ignoreList && typeof (ignoreList as { delete?: (v: unknown) => void }).delete === "function") {
        (ignoreList as { delete: (v: unknown) => void }).delete(this.overlay);
      }
    }
  }

  private hideOverlay(): void {
    this.overlay?.setVisible(false);
    if (this.speakerObj) this.speakerObj.setText("");
    if (this.lineObj) this.lineObj.setText("");
    // Invalidate the box-draw cache so the next play() definitely repaints
    // (theme / style / dims may have changed mid-stop).
    this._lastBoxDrawKey = "";
  }

  /** Update overlay position + size each frame. Box mode: fixed at the
   *  bottom of the camera viewport. Overhead mode: above the speaker
   *  sprite, with a sensible fallback when the sprite isn't placed.
   *
   *  Layout (children positioned relative to the container CENTER):
   *
   *      ┌─────────────────────────────┐  ← top   = -boxH/2
   *      │  paddingY                   │
   *      │  ┌─speaker (origin 0,0)───┐ │
   *      │  └────────────────────────┘ │
   *      │  speakerH                   │
   *      │  + 4px gap                  │
   *      │  ┌─line text (origin 0,0)─┐ │
   *      │  │                        │ │
   *      │  └────────────────────────┘ │
   *      │  paddingY                   │
   *      └─────────────────────────────┘  ← bottom = +boxH/2
   */
  private repositionOverlay(): void {
    if (!this.current || !this.overlay || !this.bg || !this.lineObj || !this.speakerObj || !this.continueObj || !this.shadowObj || !this.speakerBgObj || !this.separatorObj) return;
    const cur = this.current;
    const style = cur.asset.style;
    const cam = this.scene.cameras.main;
    // Re-sharpen text if the main camera zoom changed since the last
    // resolution apply. Overhead-mode text is rendered through main cam,
    // so a SetCameraZoom action mid-dialog otherwise leaves the texture
    // under- or over-sampled. Cheap: setResolution early-outs when value
    // hasn't moved, so this is a tracked-value compare in the common case.
    const z = cam.zoom;
    if (z !== this._lastAppliedCamZoom) {
      this._lastAppliedCamZoom = z;
      refreshCrispText(this.speakerObj);
      refreshCrispText(this.lineObj);
      refreshCrispText(this.continueObj);
    }
    const theme: DialogueTheme = (style.theme ?? "modern") as DialogueTheme;
    const hasSpeaker = !!cur.speakerLabel;
    const speakerH = hasSpeaker ? this.speakerObj.height : 0;
    const lineH = this.lineObj.height || style.fontSize;
    // Per-theme vertical gap between speaker label and line text.
    // JRPG mode puts the speaker in its own attached box above the main
    // box, so there's no in-box speaker height to budget for.
    const inBoxSpeaker = hasSpeaker && theme !== "jrpg";
    const speakerGap = inBoxSpeaker ? (theme === "modern" ? 6 : 4) : 0;
    const inBoxSpeakerH = inBoxSpeaker ? speakerH : 0;

    // Per-side padding overrides fall through to the symmetric defaults.
    const padT = style.paddingTop    ?? style.paddingY;
    const padR = style.paddingRight  ?? style.paddingX;
    const padB = style.paddingBottom ?? style.paddingY;
    const padL = style.paddingLeft   ?? style.paddingX;

    // Bubble height: top + (in-box speaker?) + gap + line + bottom.
    const boxH = padT + inBoxSpeakerH + speakerGap + lineH + padB;
    // Bubble width: configured cap (box mode) / auto-fit (overhead mode).
    const measured = Math.max(this.lineObj.width, this.speakerObj.width) + padL + padR;
    const boxW = cur.asset.displayMode === "box"
      ? style.boxWidth
      : Math.min(style.boxWidth, Math.max(120, measured));

    // Position children in container-relative coords. With origin (0, 0)
    // on the texts we set their top-left at (left + padL, top + padT).
    // ROUND every text position to integer pixels — the game config keeps
    // `roundPixels: false` intentionally so camera follow stays smooth, but
    // that means text containers can land on fractional pixel coordinates.
    // LINEAR sampling at fractional positions blends the text texture
    // across two screen pixel columns and produces the soft halo around
    // every letter (the "blurry" look). Snapping the OVERLAY positions
    // doesn't affect camera follow at all — it only locks dialog text
    // to the pixel grid.
    const left = Math.round(-boxW / 2 + padL);
    const top = Math.round(-boxH / 2 + padT);
    if (inBoxSpeaker) {
      this.speakerObj.setPosition(left, top);
      this.speakerObj.setVisible(true);
      this.lineObj.setPosition(left, Math.round(top + speakerH + speakerGap));
    } else if (hasSpeaker && theme === "jrpg") {
      // JRPG: speaker sits in its own box ABOVE the main box, top-left.
      this.speakerObj.setPosition(left, Math.round(top - speakerH - 6));
      this.speakerObj.setVisible(true);
      this.lineObj.setPosition(left, top);
    } else {
      this.speakerObj.setVisible(false);
      this.lineObj.setPosition(left, top);
    }

    // Continue indicator — bottom-right inside the box, blinking sine alpha
    // while waiting for input, hidden otherwise. ▼ for box mode (down arrow
    // hints "press to continue"); ▶ for jrpg box mode (classic FF style).
    const isAwaiting = cur.phase === "await-advance" || cur.phase === "await-choice";
    const wantArrow = theme === "jrpg" ? "▶" : "▼";
    if (this.continueObj.text !== wantArrow) this.continueObj.setText(wantArrow);
    if (isAwaiting) {
      this.continueObj.setVisible(true);
      const t = this.scene.time.now / 1000;
      this.continueObj.setAlpha(0.4 + 0.6 * Math.abs(Math.sin(t * 4)));
    } else {
      this.continueObj.setVisible(false);
    }
    this.continueObj.setPosition(
      Math.round(boxW / 2 - padR),
      Math.round(boxH / 2 - padB),
    );

    // Paint all the box graphics for the active theme.
    this.drawThemedBox(theme, boxW, boxH, style, hasSpeaker);

    // Place the whole container in scene/camera coords.
    if (cur.asset.displayMode === "box") {
      // Camera-fixed bottom-center, with user offsets. boxOffsetY is the
      // gap from the bottom edge (positive = pushes the box up); X is
      // added to the centered X position (positive = right).
      const x = Math.round(cam.width / 2 + style.boxOffsetX);
      const y = Math.round(cam.height - boxH / 2 - style.boxOffsetY);
      this.overlay.setPosition(x, y);
    } else {
      // Overhead — above the speaker's head in WORLD coords. Re-resolve
      // the sprite if it was destroyed.
      let sprite = cur.speakerSprite;
      if (sprite && sprite.destroyed) sprite = undefined;
      if (!sprite) {
        const line = cur.asset.lines[cur.lineIdx];
        if (line) sprite = this.resolveSpeakerSprite(line.speakerBpId, line.speakerLabel);
        cur.speakerSprite = sprite;
      }
      if (sprite) {
        const obj = sprite.gameObject;
        const headY = obj.y - obj.height / 2;
        // Per-speaker offset override — when the asset defines
        // `speakerOffsets[label]`, use those values INSTEAD of the
        // asset-wide style defaults. Lets the author tune each NPC's
        // bubble height/X independently. The current line carries the
        // speaker label that drives this lookup.
        const line = cur.asset.lines[cur.lineIdx];
        const perSpeaker = line?.speakerLabel
          ? cur.asset.speakerOffsets?.[line.speakerLabel]
          : undefined;
        const offX = perSpeaker ? perSpeaker.x : style.overheadOffsetX;
        const offY = perSpeaker ? perSpeaker.y : style.overheadOffsetY;
        // One-shot diagnostic per (line index) so the user can see in
        // F12 exactly what offset is being applied, whether per-speaker
        // OR the style default. Helps verify the per-speaker override
        // is wired through to the runtime.
        // Bubble's BOTTOM edge sits at headY + offY (typically a small
        // negative number to lift it above the head). Container is
        // positioned at the bubble's center, so account for boxH/2.
        const x = Math.round(obj.x + offX);
        const y = Math.round(headY + offY - boxH / 2);
        this.overlay.setPosition(x, y);
      } else {
        // Fallback — top-center of the camera viewport (still in world
        // coords because scrollFactor is 1, so add the camera scroll).
        this.overlay.setPosition(cam.scrollX + cam.width / 2, cam.scrollY + 40 + boxH / 2);
      }
    }
  }

  /** Repaint the box graphics for the active theme. Container-relative
   *  coordinates: (0,0) is the box CENTER; top-left is (-boxW/2, -boxH/2).
   *  Called every repositionOverlay so dimension changes (variable-length
   *  text per line) flow through without recreating the container. */
  private drawThemedBox(
    theme: DialogueTheme,
    boxW: number,
    boxH: number,
    style: DialogueStyleSpec,
    hasSpeaker: boolean,
  ): void {
    if (!this.bg || !this.shadowObj || !this.separatorObj || !this.speakerBgObj || !this.speakerObj) return;
    // Skip the repaint when nothing affecting the drawn pixels has changed.
    // Box dimensions + theme + colors + speaker text width compose the
    // visible state — same key → byte-identical output, so reuse the prior
    // frame's Graphics contents and save (in the worst case) thousands of
    // draw calls per frame on the dot-grid / cloud-puff / starburst themes.
    // Speaker text width is folded in because the modern pill + separator
    // length under the name follow it. Animation of the continue indicator
    // is handled by setAlpha on a separate Text object — not painted here —
    // so it's correctly excluded from this key.
    const speakerW = hasSpeaker ? this.speakerObj.width : 0;
    const speakerH2 = hasSpeaker ? this.speakerObj.height : 0;
    const key = `${theme}|${boxW}|${boxH}|${hasSpeaker ? 1 : 0}|${speakerW}|${speakerH2}|${style.bgColor}|${style.bgAlpha}|${style.borderColor}|${style.borderWidth}|${style.speakerColor}|${style.paddingX}|${style.paddingY}|${style.boxAssetId ?? ""}`;
    if (key === this._lastBoxDrawKey) return;
    this._lastBoxDrawKey = key;
    this.bg.clear();
    this.shadowObj.clear();
    this.separatorObj.clear();
    this.speakerBgObj.clear();
    // Hide the 9-slice when not in image mode so a previously-bound asset
    // doesn't bleed through after the author switches back to a procedural
    // theme. The image branch below will show + resize when needed.
    if (theme !== "image" && this.nineSliceObj) this.nineSliceObj.setVisible(false);
    const halfW = boxW / 2;
    const halfH = boxH / 2;
    const isOverhead = this.current?.asset.displayMode === "overhead";
    if (theme === "modern") {
      // Drop shadow — translucent rounded rect offset down/right.
      this.shadowObj.fillStyle(0x000000, 0.35);
      this.shadowObj.fillRoundedRect(-halfW + 4, -halfH + 4, boxW, boxH, 10);
      // Main bg — rounded rect with thin border.
      this.bg.fillStyle(style.bgColor, style.bgAlpha);
      this.bg.fillRoundedRect(-halfW, -halfH, boxW, boxH, 10);
      this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
      this.bg.strokeRoundedRect(-halfW, -halfH, boxW, boxH, 10);
      // Subtle inset highlight along the top edge — gives the box a soft
      // sheen instead of looking flat.
      this.bg.lineStyle(1, 0xffffff, 0.10);
      this.bg.beginPath();
      this.bg.moveTo(-halfW + 10, -halfH + 1);
      this.bg.lineTo(halfW - 10, -halfH + 1);
      this.bg.strokePath();
      if (hasSpeaker) {
        // Speaker pill — small rounded rect behind the speaker name text,
        // tinted with the speakerColor (parsed from the "#rrggbb" string).
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sw = this.speakerObj.width + 12;
        const sh = this.speakerObj.height + 6;
        const pillColor = parseCssColor(style.speakerColor) ?? 0xffcc66;
        this.speakerBgObj.fillStyle(pillColor, 0.18);
        this.speakerBgObj.fillRoundedRect(tx - 6, ty - 3, sw, sh, 4);
        this.speakerBgObj.lineStyle(1, pillColor, 0.6);
        this.speakerBgObj.strokeRoundedRect(tx - 6, ty - 3, sw, sh, 4);
        // Thin separator line below the speaker label, full inner width.
        const sepY = ty + this.speakerObj.height + 4;
        this.separatorObj.lineStyle(1, 0xffffff, 0.15);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(-halfW + (style.paddingLeft ?? style.paddingX), sepY);
        this.separatorObj.lineTo(halfW - (style.paddingRight ?? style.paddingX), sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "jrpg") {
      // No drop shadow — classic JRPG aesthetic is high-contrast and crisp.
      // Main bg — square corners, double border (thick outer + thin inner).
      this.bg.fillStyle(style.bgColor, Math.max(style.bgAlpha, 0.9));
      this.bg.fillRect(-halfW, -halfH, boxW, boxH);
      this.bg.lineStyle(Math.max(2, style.borderWidth), style.borderColor, 1);
      this.bg.strokeRect(-halfW, -halfH, boxW, boxH);
      this.bg.lineStyle(1, style.borderColor, 0.7);
      this.bg.strokeRect(-halfW + 4, -halfH + 4, boxW - 8, boxH - 8);
      if (hasSpeaker) {
        // Speaker box attached above the main box, top-left aligned.
        const sw = this.speakerObj.width + 16;
        const sh = this.speakerObj.height + 8;
        const sx = -halfW;
        const sy = this.speakerObj.y - 4;
        this.speakerBgObj.fillStyle(style.bgColor, Math.max(style.bgAlpha, 0.9));
        this.speakerBgObj.fillRect(sx, sy, sw, sh);
        this.speakerBgObj.lineStyle(Math.max(2, style.borderWidth), style.borderColor, 1);
        this.speakerBgObj.strokeRect(sx, sy, sw, sh);
        // Re-position speaker text inside its box (re-center vertically).
        this.speakerObj.setPosition(sx + 8, sy + 4);
      }
    } else if (theme === "comic") {
      // Classic comic — rounded bubble + downward tail in overhead mode.
      this.shadowObj.fillStyle(0x000000, 0.30);
      this.shadowObj.fillRoundedRect(-halfW + 3, -halfH + 3, boxW, boxH, 14);
      this.bg.fillStyle(style.bgColor, style.bgAlpha);
      this.bg.fillRoundedRect(-halfW, -halfH, boxW, boxH, 14);
      this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
      this.bg.strokeRoundedRect(-halfW, -halfH, boxW, boxH, 14);
      if (isOverhead) {
        // Speech-bubble tail — small triangle pointing down at the speaker.
        const tipX = 0;
        const tipY = halfH + 12;
        const baseLeftX = -8;
        const baseRightX = 8;
        const baseY = halfH - 1;
        this.bg.fillStyle(style.bgColor, style.bgAlpha);
        this.bg.beginPath();
        this.bg.moveTo(baseLeftX, baseY);
        this.bg.lineTo(baseRightX, baseY);
        this.bg.lineTo(tipX, tipY);
        this.bg.closePath();
        this.bg.fillPath();
        this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
        this.bg.beginPath();
        this.bg.moveTo(baseLeftX, baseY);
        this.bg.lineTo(tipX, tipY);
        this.bg.lineTo(baseRightX, baseY);
        this.bg.strokePath();
      }
      if (hasSpeaker) {
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 2;
        this.separatorObj.lineStyle(1, parseCssColor(style.speakerColor) ?? 0xffcc66, 0.6);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(tx, sepY);
        this.separatorObj.lineTo(tx + this.speakerObj.width, sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "comic-shout") {
      // Shout — jagged starburst outline. Built as a polygon with N spikes
      // alternating between an outer "burst" radius and an inner "shaft"
      // radius. The fill body is the burst polygon itself (no rounded rect
      // underneath) so spikes are part of the speech volume.
      const cx = 0;
      const cy = 0;
      // Bounding box of the burst — sized to FULLY CONTAIN boxW/boxH plus
      // some spike room so the inner text-safe area still fits the content.
      const innerRX = halfW + 4;
      const innerRY = halfH + 4;
      const outerRX = innerRX + 14;
      const outerRY = innerRY + 14;
      const spikes = 14;
      const points: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 === 0 ? 1 : 0.78;
        const rx = (i % 2 === 0 ? outerRX : innerRX) * r;
        const ry = (i % 2 === 0 ? outerRY : innerRY) * r;
        points.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
      }
      // Drop shadow — offset starburst, low alpha.
      this.shadowObj.fillStyle(0x000000, 0.35);
      this.shadowObj.beginPath();
      this.shadowObj.moveTo(points[0].x + 4, points[0].y + 4);
      for (let i = 1; i < points.length; i++) this.shadowObj.lineTo(points[i].x + 4, points[i].y + 4);
      this.shadowObj.closePath();
      this.shadowObj.fillPath();
      // Body.
      this.bg.fillStyle(style.bgColor, Math.max(style.bgAlpha, 0.95));
      this.bg.beginPath();
      this.bg.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) this.bg.lineTo(points[i].x, points[i].y);
      this.bg.closePath();
      this.bg.fillPath();
      // Bold high-contrast border.
      this.bg.lineStyle(Math.max(3, style.borderWidth + 1), style.borderColor, 1);
      this.bg.beginPath();
      this.bg.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) this.bg.lineTo(points[i].x, points[i].y);
      this.bg.closePath();
      this.bg.strokePath();
      if (hasSpeaker) {
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 2;
        this.separatorObj.lineStyle(2, parseCssColor(style.speakerColor) ?? 0xffcc66, 0.9);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(tx, sepY);
        this.separatorObj.lineTo(tx + this.speakerObj.width, sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "comic-thought") {
      // Thought bubble — cloud-puffy outline made of overlapping arcs
      // around the perimeter, plus trailing small bubbles instead of a
      // pointed tail. Render the main puff as a filled shape + a stroked
      // arc loop.
      const bumpR = 10;
      const stepX = Math.max(16, Math.floor(boxW / Math.max(3, Math.round(boxW / 28))));
      const stepY = Math.max(16, Math.floor(boxH / Math.max(2, Math.round(boxH / 24))));
      // Drop shadow.
      this.shadowObj.fillStyle(0x000000, 0.25);
      this.shadowObj.fillRoundedRect(-halfW + 3, -halfH + 3, boxW, boxH, 18);
      // Filled body — a rounded rect (the cloud bumps stick out from it).
      this.bg.fillStyle(style.bgColor, style.bgAlpha);
      this.bg.fillRoundedRect(-halfW, -halfH, boxW, boxH, 18);
      // Puffs around the perimeter — each puff is a filled circle that
      // overlaps the main rect (so the overall outline reads as cloudy).
      for (let x = -halfW + bumpR; x <= halfW - bumpR; x += stepX) {
        this.bg.fillStyle(style.bgColor, style.bgAlpha);
        this.bg.fillCircle(x, -halfH, bumpR);
        this.bg.fillCircle(x,  halfH, bumpR);
      }
      for (let y = -halfH + bumpR; y <= halfH - bumpR; y += stepY) {
        this.bg.fillStyle(style.bgColor, style.bgAlpha);
        this.bg.fillCircle(-halfW, y, bumpR);
        this.bg.fillCircle( halfW, y, bumpR);
      }
      // Border — stroke each puff outline so the cloud reads as outlined.
      this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
      for (let x = -halfW + bumpR; x <= halfW - bumpR; x += stepX) {
        this.bg.strokeCircle(x, -halfH, bumpR);
        this.bg.strokeCircle(x,  halfH, bumpR);
      }
      for (let y = -halfH + bumpR; y <= halfH - bumpR; y += stepY) {
        this.bg.strokeCircle(-halfW, y, bumpR);
        this.bg.strokeCircle( halfW, y, bumpR);
      }
      if (isOverhead) {
        // Trail of small bubbles leading down to the speaker — classic
        // "thinking" indicator.
        this.bg.fillStyle(style.bgColor, style.bgAlpha);
        this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
        const tailBubbles = [
          { x: 0, y: halfH + 10, r: 6 },
          { x: 4, y: halfH + 22, r: 4 },
          { x: 8, y: halfH + 30, r: 2.5 },
        ];
        for (const b of tailBubbles) {
          this.bg.fillCircle(b.x, b.y, b.r);
          this.bg.strokeCircle(b.x, b.y, b.r);
        }
      }
      if (hasSpeaker) {
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 2;
        this.separatorObj.lineStyle(1, parseCssColor(style.speakerColor) ?? 0xffcc66, 0.5);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(tx, sepY);
        this.separatorObj.lineTo(tx + this.speakerObj.width, sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "comic-whisper") {
      // Whisper — thin dashed outline, translucent fill, slim tail.
      // Phaser Graphics has no native dash API, so we approximate by
      // stroking a series of small line segments around the perimeter.
      const dashLen = 4;
      const gapLen = 3;
      // Light drop shadow.
      this.shadowObj.fillStyle(0x000000, 0.18);
      this.shadowObj.fillRoundedRect(-halfW + 2, -halfH + 2, boxW, boxH, 12);
      // Translucent body — reduce author-set alpha further so the whisper
      // reads as "see-through" regardless of the configured opacity.
      this.bg.fillStyle(style.bgColor, Math.min(style.bgAlpha, 0.55));
      this.bg.fillRoundedRect(-halfW, -halfH, boxW, boxH, 12);
      // Dashed border — perimeter is approximated as 4 sides; ignore the
      // rounded-corner arc segments (visually fine at 12px corner radius).
      this.bg.lineStyle(1, style.borderColor, 0.8);
      const sides = [
        { x1: -halfW + 12, y1: -halfH, x2:  halfW - 12, y2: -halfH },
        { x1:  halfW,      y1: -halfH + 12, x2:  halfW, y2:  halfH - 12 },
        { x1:  halfW - 12, y1:  halfH, x2: -halfW + 12, y2:  halfH },
        { x1: -halfW,      y1:  halfH - 12, x2: -halfW, y2: -halfH + 12 },
      ];
      for (const s of sides) {
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        const len = Math.hypot(dx, dy);
        const nx = dx / len;
        const ny = dy / len;
        let t = 0;
        while (t < len) {
          const a = Math.min(t + dashLen, len);
          this.bg.beginPath();
          this.bg.moveTo(s.x1 + nx * t, s.y1 + ny * t);
          this.bg.lineTo(s.x1 + nx * a, s.y1 + ny * a);
          this.bg.strokePath();
          t = a + gapLen;
        }
      }
      if (isOverhead) {
        // Slim dashed tail — same dashed treatment.
        const tipX = 0;
        const tipY = halfH + 10;
        const baseY = halfH;
        const tailSides = [
          { x1: -4, y1: baseY, x2: tipX, y2: tipY },
          { x1:  4, y1: baseY, x2: tipX, y2: tipY },
        ];
        for (const s of tailSides) {
          const dx = s.x2 - s.x1;
          const dy = s.y2 - s.y1;
          const len = Math.hypot(dx, dy);
          const nx = dx / len;
          const ny = dy / len;
          let t = 0;
          while (t < len) {
            const a = Math.min(t + dashLen, len);
            this.bg.beginPath();
            this.bg.moveTo(s.x1 + nx * t, s.y1 + ny * t);
            this.bg.lineTo(s.x1 + nx * a, s.y1 + ny * a);
            this.bg.strokePath();
            t = a + gapLen;
          }
        }
      }
      if (hasSpeaker) {
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 2;
        this.separatorObj.lineStyle(1, parseCssColor(style.speakerColor) ?? 0xffcc66, 0.4);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(tx, sepY);
        this.separatorObj.lineTo(tx + this.speakerObj.width, sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "image") {
      // 9-slice render path. Look up the bound DialogBoxAsset spec; if
      // missing (no asset selected, asset deleted, texture not decoded yet)
      // gracefully fall back to procedural modern theme so the dialog still
      // shows something while the author is wiring up.
      const boxes = this.scene.data.get(DIALOG_BOXES_KEY) as Record<string, DialogBoxAssetSpec> | undefined;
      const assetId = style.boxAssetId ?? "";
      const spec = assetId && boxes ? boxes[assetId] : undefined;
      const textureReady = spec && this.scene.textures.exists(spec.textureKey);
      if (!spec || !textureReady) {
        // Fallback paint — procedural modern theme. Hide any prior 9-slice.
        if (this.nineSliceObj) this.nineSliceObj.setVisible(false);
        this.shadowObj.fillStyle(0x000000, 0.35);
        this.shadowObj.fillRoundedRect(-halfW + 4, -halfH + 4, boxW, boxH, 10);
        this.bg.fillStyle(style.bgColor, style.bgAlpha);
        this.bg.fillRoundedRect(-halfW, -halfH, boxW, boxH, 10);
        this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
        this.bg.strokeRoundedRect(-halfW, -halfH, boxW, boxH, 10);
      } else {
        // Real image render. Procedural graphics layers were already
        // cleared at the top of drawThemedBox; leave them blank.
        // Lazily create or rebind the NineSlice GameObject. Phaser's
        // NineSlice takes (key, frame, width, height, leftWidth, rightWidth,
        // topHeight, bottomHeight) — corners are drawn unscaled, the four
        // edges are stretched along one axis, middle stretches on both.
        const needCreate = !this.nineSliceObj || this._nineSliceTextureKey !== spec.textureKey;
        if (needCreate) {
          if (this.nineSliceObj) {
            this.overlay?.remove(this.nineSliceObj, true);
            this.nineSliceObj = undefined;
          }
          const ns = this.scene.add.nineslice(
            0, 0, spec.textureKey, undefined,
            boxW, boxH,
            spec.sliceLeft, spec.sliceRight, spec.sliceTop, spec.sliceBottom,
          );
          ns.setOrigin(0.5, 0.5);
          // Insert under everything except shadow so speaker pill / text /
          // continue indicator render ON TOP. Index 1 = above shadowObj
          // (index 0), below speakerBgObj/text/etc.
          this.overlay?.addAt(ns, 1);
          ns.setScrollFactor(
            (this.bg.scrollFactorX ?? 1),
            (this.bg.scrollFactorY ?? 1),
          );
          this.nineSliceObj = ns;
          this._nineSliceTextureKey = spec.textureKey;
        } else if (this.nineSliceObj) {
          // Existing 9-slice — just resize for the current box dims.
          // setSize works on NineSlice; slice cuts persist from construction.
          this.nineSliceObj.setSize(boxW, boxH);
          this.nineSliceObj.setVisible(true);
        }
      }
      if (hasSpeaker) {
        // Thin separator below the speaker — matches modern's read pattern.
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 4;
        this.separatorObj.lineStyle(1, parseCssColor(style.speakerColor) ?? 0xffcc66, 0.6);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(-halfW + style.paddingX, sepY);
        this.separatorObj.lineTo(halfW - style.paddingX, sepY);
        this.separatorObj.strokePath();
      }
    } else if (theme === "comic-news") {
      // Newspaper caption — sharp rect with halftone-dot bg pattern,
      // thin black border, NO tail. Use for narrator captions.
      // Filled bg — opaque so dots read against it.
      this.bg.fillStyle(style.bgColor, Math.max(style.bgAlpha, 0.95));
      this.bg.fillRect(-halfW, -halfH, boxW, boxH);
      // Halftone pattern — small dots in a regular grid, low alpha so the
      // text on top still reads cleanly. Color = borderColor so the dots
      // share the caption's accent palette.
      const dotR = 0.9;
      const stepX = 5;
      const stepY = 5;
      this.bg.fillStyle(style.borderColor, 0.20);
      for (let y = -halfH + 4; y < halfH - 2; y += stepY) {
        const row = Math.floor((y + halfH) / stepY);
        // Stagger every other row by half a step — proper halftone look.
        const xOffset = row % 2 === 0 ? 0 : stepX / 2;
        for (let x = -halfW + 4 + xOffset; x < halfW - 2; x += stepX) {
          this.bg.fillCircle(x, y, dotR);
        }
      }
      // Thin border.
      this.bg.lineStyle(Math.max(1, style.borderWidth), style.borderColor, 1);
      this.bg.strokeRect(-halfW, -halfH, boxW, boxH);
      // Speaker = caption byline, underlined in border color.
      if (hasSpeaker) {
        const tx = this.speakerObj.x;
        const ty = this.speakerObj.y;
        const sepY = ty + this.speakerObj.height + 2;
        this.separatorObj.lineStyle(1, style.borderColor, 0.9);
        this.separatorObj.beginPath();
        this.separatorObj.moveTo(tx, sepY);
        this.separatorObj.lineTo(tx + this.speakerObj.width, sepY);
        this.separatorObj.strokePath();
      }
    }
  }

  private findFirstSpriteOfBp(bpId: string): Sprite | undefined {
    const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (!s.destroyed && s.blueprintId === bpId) return s;
    }
    return undefined;
  }

  /** Resolve which Sprite a dialogue line's speaker label points at.
   *  Three strategies in priority order:
   *    1. Mapped BP id (from `speakerMap[label]` in the editor) →
   *       first instance of that BP. Used when the user wired up the
   *       mapping via the right-rail Speakers panel.
   *    2. Per-instance NAME match — if any sprite in the scene has
   *       `instanceName === label`, use THAT specific instance. This is
   *       how multiple NPCs of the same BP get differentiated (e.g.
   *       4 Guards, named "Guard1".."Guard4" in the Instance Inspector;
   *       a script that says "Guard2: Halt!" pins the bubble to
   *       Guard2 specifically).
   *    3. Per-BP NAME match — fallback when the label isn't mapped and
   *       isn't an instance name; uses the first instance of the BP
   *       whose `blueprintName === label`. Lets you write a script
   *       without setting up speakerMap as long as your BP names match
   *       the script's speakers. */
  private resolveSpeakerSprite(speakerBpId: string, speakerLabel: string): Sprite | undefined {
    if (speakerBpId) {
      const hit = this.findFirstSpriteOfBp(speakerBpId);
      if (hit) return hit;
    }
    if (!speakerLabel) return undefined;
    const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (!s.destroyed && s.instanceName === speakerLabel) return s;
    }
    for (const s of all) {
      if (!s.destroyed && s.blueprintName === speakerLabel) return s;
    }
    return undefined;
  }

  private broadcastSignal(name: string): void {
    const all = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    const snapshot = [...all];
    for (const s of snapshot) {
      if (!s.destroyed) s.events.emit(name);
    }
  }
}

export function getDialogueRunner(scene: Phaser.Scene): DialogueRunner | undefined {
  return scene.data.get(DIALOGUE_KEY) as DialogueRunner | undefined;
}
