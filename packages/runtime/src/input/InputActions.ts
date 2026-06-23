import Phaser from "phaser";
import { Logger } from "../Logger";

export interface InputActionSpec {
  name: string;
  /** Phaser KeyCode strings (e.g. "LEFT", "A", "SPACE") AND mouse-button
   *  tokens ("MOUSE_LEFT" / "MOUSE_RIGHT" / "MOUSE_MIDDLE"). */
  keys: string[];
}

type MouseButton = "left" | "right" | "middle";

/** Bind-token → pointer button. A `keys` entry matching one of these is treated
 *  as a mouse binding instead of a keyboard key. */
const MOUSE_TOKENS: Record<string, MouseButton> = {
  MOUSE_LEFT: "left",
  MOUSE_RIGHT: "right",
  MOUSE_MIDDLE: "middle",
};

/** True for export/UI: is this bind token a mouse button? */
export function isMouseToken(token: string): boolean {
  return token in MOUSE_TOKENS;
}

/** Is the active pointer over a UI widget that swallows game input
 *  (blockGameInput)? Shared by InputActions (mouse-bound actions) AND the raw
 *  mouse conditions in eval.ts so clicking a widget never leaks to gameplay. */
export function pointerOverUiBlocker(scene: Phaser.Scene): boolean {
  const blockers = scene.data.get("peaky.mouseBlockers") as
    Set<{ blocksPointerAt: (p: Phaser.Input.Pointer) => boolean }> | undefined;
  if (!blockers || blockers.size === 0) return false;
  const p = scene.input.activePointer;
  if (!p) return false;
  for (const b of blockers) { if (b.blocksPointerAt(p)) return true; }
  return false;
}

/**
 * UE5-style action mapping: an action like "Jump" can be bound to multiple
 * keys. State machines and behaviors query by *action name* — rebinding keys
 * never breaks SM transitions.
 *
 * Pressed/released semantics aggregate across all bound keys:
 *   - justPressed("Jump") fires the frame any bound key transitions to down.
 *   - justReleased("Jump") fires the frame the *last* held bound key goes up.
 */
export class InputActions {
  private readonly map = new Map<string, Phaser.Input.Keyboard.Key[]>();
  /** Mouse buttons bound per action (parallel to `map`). */
  private readonly mouseMap = new Map<string, MouseButton[]>();
  private readonly scene: Phaser.Scene;

  /** All registered action names. Used by the animator's input buffer
   *  so it can stamp every action's press time without needing access
   *  to the project's `inputActions` definition list directly. */
  actionNames(): string[] { return [...this.map.keys()]; }

  private readonly heldLast = new Map<string, boolean>();
  /**
   * Per-action "ignored until release" flag. When set, ia.isDown /
   * justPressed / justReleased report this action as NOT pressed even
   * though its physical keys are down. Cleared automatically the moment
   * every bound key for the action goes up.
   *
   * Set by `ignoreAllCurrentlyHeld()` on unpause (timeScale 0→non-zero).
   * Effect: keys held DURING a pause are silently dropped on resume —
   * the user has to physically release + repress to re-engage. Without
   * this, holding `Left` during pause would have the character keep
   * walking the moment the world unpauses (and tapping `Q` to unpause
   * while still holding `Q` would oscillate the pause toggle).
   */
  private readonly ignoredUntilRelease = new Set<string>();
  /** Names we've already warned about (unknown action OR no keys bound),
   *  so a query in a tick loop doesn't spam Logger every frame. */
  private readonly warned = new Set<string>();

  constructor(scene: Phaser.Scene, specs: InputActionSpec[]) {
    this.scene = scene;
    const kb = scene.input.keyboard;
    // Diagnostic — emit one Logger entry per registered action with the
    // exact name (JSON-encoded so trailing whitespace / control chars are
    // visible) and the keys it received. Lets a user with a "doesn't work"
    // action quickly see whether the registered name matches what their
    // CM behavior expects (case, whitespace, duplicates).
    for (const spec of specs) {
      // Split bind tokens into keyboard codes and mouse buttons.
      const kbCodes: string[] = [];
      const mouseBtns: MouseButton[] = [];
      for (const tok of spec.keys ?? []) {
        const mb = MOUSE_TOKENS[tok];
        if (mb) mouseBtns.push(mb);
        else kbCodes.push(tok);
      }
      const keys = kb ? kbCodes.map((k) => kb.addKey(k)) : [];
      const validKeys = keys.filter((k): k is Phaser.Input.Keyboard.Key => k != null);
      this.map.set(spec.name, validKeys);
      this.mouseMap.set(spec.name, mouseBtns);
      this.heldLast.set(spec.name, false);
      Logger.log({
        level: "log",
        source: "InputActions",
        message: `Registered action ${JSON.stringify(spec.name)} with keys [${(spec.keys ?? []).map((k) => JSON.stringify(k)).join(", ")}]${validKeys.length !== keys.length ? ` (${keys.length - validKeys.length} unrecognized key code(s) dropped)` : ""}`,
      });
    }

    // Suppress the browser's right-click menu on the game canvas — without
    // this, a right-click (or even a mis-click) pops the OS menu, the
    // canvas loses focus, and any held keys never get their `keyup` event,
    // leaving the character "stuck" walking until the user re-presses and
    // releases the key.
    scene.input.mouse?.disableContextMenu();

    // Snapshot every action's held-state at the END of each frame so the
    // NEXT frame's justPressed / justReleased queries can compute their
    // edge transitions WITHOUT touching shared Phaser key flags. This is
    // what makes the API safe for multi-caller scenarios — e.g. one BP
    // with `dashAction = "Dash"` that runs every frame even when its dash
    // is disabled, plus another BP whose OnKeyPressed[Dash] event drives
    // the actual dash. Phaser's built-in `JustDown(key)` is destructive
    // (clears `_justDown` on read), so the second caller in a frame
    // would see false. We bypass that entirely by reading the
    // non-destructive `key.isDown` and comparing to our own snapshot.
    const refreshHeld = () => {
      for (const name of this.map.keys()) {
        const heldNow = this.rawHeld(name);
        // If this action was flagged "ignore until release" (set on
        // unpause for keys still being held from before / during the
        // pause), clear the flag the moment every bound key goes up.
        // From then on, isDown / justPressed / justReleased report
        // normally — a fresh re-press registers as a normal press.
        if (this.ignoredUntilRelease.has(name) && !heldNow) {
          this.ignoredUntilRelease.delete(name);
        }
        this.heldLast.set(name, heldNow);
      }
    };
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, refreshHeld);

    // Defense in depth: when the window loses focus for ANY reason (alt-tab,
    // notification popup, devtools opened), reset every keyboard state.
    // Otherwise a key held during the focus loss stays `isDown=true`
    // forever — same stuck-input bug.
    const onBlur = () => kb?.resetKeys();
    window.addEventListener("blur", onBlur);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("blur", onBlur);
      scene.events.off(Phaser.Scenes.Events.POST_UPDATE, refreshHeld);
    });
  }

  /**
   * Resolve a query against the action map and surface a one-time warning
   * when the answer is "no" because the action was never registered or
   * because it has no keys bound. Without these warnings, the only symptom
   * of a typo / missing binding is "the ability silently doesn't fire" —
   * which the user is left to debug from gameplay alone. Returns the keys
   * array (possibly empty) or undefined when the action is unknown.
   */
  /** Verify the action is registered (and warn once if it isn't, or if it has
   *  no keyboard OR mouse binding). Returns true when the action is known. */
  private checkKnown(action: string): boolean {
    const keys = this.map.get(action);
    if (!keys) {
      if (!this.warned.has(action)) {
        this.warned.add(action);
        const known = Array.from(this.map.keys()).join(", ") || "(none)";
        Logger.log({
          level: "warn",
          source: "InputActions",
          message: `Action "${action}" is not registered. Available actions: ${known}. Check that a behavior's *Action field matches an InputAction's name exactly (case-sensitive).`,
        });
      }
      return false;
    }
    const mouse = this.mouseMap.get(action) ?? [];
    if (keys.length === 0 && mouse.length === 0 && !this.warned.has(action)) {
      this.warned.add(action);
      Logger.log({
        level: "warn",
        source: "InputActions",
        message: `Action "${action}" exists but has no key or mouse button bound — it will never fire. Open the Input Actions modal and bind one.`,
      });
    }
    return true;
  }

  /** True when the pointer is over a UI widget that swallows game input
   *  (blockGameInput). Keeps a Left-Click "attack" from firing while the user
   *  is clicking a button / dragging a slider. */
  private pointerBlocked(): boolean {
    return pointerOverUiBlocker(this.scene);
  }

  /** Is the action's pointer button currently down? */
  private mouseHeld(action: string): boolean {
    const btns = this.mouseMap.get(action);
    if (!btns || btns.length === 0) return false;
    if (this.pointerBlocked()) return false;
    const p = this.scene.input.activePointer;
    if (!p) return false;
    for (const b of btns) {
      if (b === "left" && p.leftButtonDown()) return true;
      if (b === "right" && p.rightButtonDown()) return true;
      if (b === "middle" && p.middleButtonDown()) return true;
    }
    return false;
  }

  /** Raw held-state across BOTH keyboard and mouse bindings (no ignore gate). */
  private rawHeld(action: string): boolean {
    const keys = this.map.get(action);
    if (keys && keys.some((k) => k.isDown)) return true;
    return this.mouseHeld(action);
  }

  /** True for every frame any bound key or mouse button is held. */
  isDown(action: string): boolean {
    if (this.ignoredUntilRelease.has(action)) return false;
    if (!this.checkKnown(action)) return false;
    return this.rawHeld(action);
  }

  /**
   * True the frame any bound key first goes down (one-shot). Edge-detected
   * against our own previous-frame snapshot, NOT against Phaser's built-in
   * `JustDown` — that one is destructive (clears `_justDown` on read), so
   * the second caller in the same frame would see false even though the
   * key was just pressed. Our version is non-destructive: any number of
   * callers in the same frame all see the same answer.
   */
  justPressed(action: string): boolean {
    if (this.ignoredUntilRelease.has(action)) return false;
    if (!this.checkKnown(action)) return false;
    const heldNow = this.rawHeld(action);
    const heldPrev = this.heldLast.get(action) ?? false;
    return heldNow && !heldPrev;
  }

  /**
   * True the frame the *last* held bound key is released. Avoids spurious
   * "released" events while another bound key is still pressed.
   * Non-destructive — see justPressed for the rationale.
   */
  justReleased(action: string): boolean {
    if (this.ignoredUntilRelease.has(action)) return false;
    if (!this.checkKnown(action)) return false;
    const heldNow = this.rawHeld(action);
    const heldPrev = this.heldLast.get(action) ?? false;
    return heldPrev && !heldNow;
  }

  /**
   * Mark every action whose bound keys are currently down as
   * "ignored until release". Used on unpause (timeScale 0→non-zero)
   * to drop keys that were held during the pause — the player has to
   * physically release + repress to re-engage. Without this, holding
   * Left during a pause would have the character keep walking the
   * moment the world resumes, and the pause-toggle key (Q) being
   * held would oscillate the pause state every frame.
   */
  ignoreAllCurrentlyHeld(): void {
    for (const name of this.map.keys()) {
      if (this.rawHeld(name)) {
        this.ignoredUntilRelease.add(name);
      }
    }
  }
}

/** Phaser scene data registry key — runtime + behaviors look it up here. */
export const INPUT_ACTIONS_KEY = "peaky.inputActions";

export function getInputActions(scene: Phaser.Scene): InputActions | undefined {
  return scene.data.get(INPUT_ACTIONS_KEY) as InputActions | undefined;
}
