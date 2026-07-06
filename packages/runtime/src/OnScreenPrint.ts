import Phaser from "phaser";

/**
 * UE5-style on-screen print. Stacks messages in the top-left of the viewport;
 * each line auto-fades after `duration` seconds. Multiple PrintString calls
 * stack vertically, newest at the top.
 *
 * Lifetime is tied to the Phaser scene — when the scene shuts down, all text
 * objects are destroyed automatically by Phaser.
 */

const SCENE_KEY = "_peakyPrintStack";

interface PrintEntry {
  text: Phaser.GameObjects.Text;
  expiresAt: number;
}

interface PrintStack {
  entries: PrintEntry[];
  /** Set by `installPrintTicker` — the scene-update hook that ages entries out. */
  installed: boolean;
}

function getStack(scene: Phaser.Scene): PrintStack {
  let stack = scene.data.get(SCENE_KEY) as PrintStack | undefined;
  if (!stack) {
    stack = { entries: [], installed: false };
    scene.data.set(SCENE_KEY, stack);
  }
  if (!stack.installed) {
    stack.installed = true;
    const tick = () => tickStack(scene, stack!);
    scene.events.on(Phaser.Scenes.Events.UPDATE, tick);
    // Full re-arm on SHUTDOWN: scene.events + scene.data both SURVIVE a
    // scene.restart() (in-place transitions), so without removing the ticker
    // and dropping the stack, a zombie UPDATE listener would keep poking the
    // OLD run's destroyed Text objects in every later scene.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      scene.events.off(Phaser.Scenes.Events.UPDATE, tick);
      for (const e of stack!.entries) e.text.destroy();
      stack!.entries.length = 0;
      stack!.installed = false;
      scene.data.remove(SCENE_KEY);
    });
  }
  return stack;
}

function tickStack(scene: Phaser.Scene, stack: PrintStack): void {
  const now = scene.time.now;
  const survivors: PrintEntry[] = [];
  for (const e of stack.entries) {
    if (now >= e.expiresAt) {
      e.text.destroy();
    } else {
      // Fade in the last 400ms of life.
      const remaining = e.expiresAt - now;
      e.text.setAlpha(remaining < 400 ? remaining / 400 : 1);
      survivors.push(e);
    }
  }
  stack.entries = survivors;
  // Reposition newest-on-top.
  let y = 8;
  for (let i = stack.entries.length - 1; i >= 0; i--) {
    stack.entries[i].text.setPosition(8, y);
    y += stack.entries[i].text.height + 2;
  }
}

export function showOnScreenPrint(
  scene: Phaser.Scene,
  message: string,
  duration: number,
  color: string,
): void {
  const stack = getStack(scene);
  const text = scene.add
    .text(8, 8, message, {
      fontSize: "16px",
      color,
      backgroundColor: "#000000aa",
      padding: { x: 6, y: 3 },
      fontStyle: "bold",
    })
    .setScrollFactor(0)
    .setDepth(10000);
  // Render on the UI camera ONLY (not main). Two reasons:
  //  1. BlurScene applies postFX to main cam — routing print there
  //     would smear it. UI cam is reserved for crisp HUD-layer output.
  //  2. The UI cam's scroll(0,0) means scrollFactor on the text is
  //     irrelevant; text always shows at fixed canvas coords.
  // We tell main to ignore the text instead of UI ignoring it. If the
  // UI cam doesn't exist yet (rare race), text falls through to main —
  // still visible, just blur-affected.
  const uiCam = scene.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
  if (uiCam) scene.cameras.main.ignore(text);
  stack.entries.push({ text, expiresAt: scene.time.now + duration * 1000 });
}
