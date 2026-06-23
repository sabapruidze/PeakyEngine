import { useEffect, useRef } from "react";
import { Peaky, resetPersistentState, seedPersistentGlobals, seedPersistentLists } from "@peaky/runtime";
import type { Sprite } from "@peaky/runtime";
import { useEditor } from "../store";
import { runScene, buildSpritePreload } from "../runProject";
import { SceneEditor } from "./SceneEditor";

export function ScenePanel() {
  const isRunning = useEditor((s) => s.isRunning);
  const project = useEditor((s) => s.project);
  const scene = useEditor((s) => s.activeScene());
  const previewRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Peaky | null>(null);

  useEffect(() => {
    if (!isRunning || !previewRef.current) return;
    const container = previewRef.current;
    let activeScene = scene;
    let pending = false;        // a swap is queued; ignore further requests
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    // Cancel-token for in-flight boots. React StrictMode runs this effect
    // twice in dev (mount → cleanup → mount), so without the guard the
    // first boot's async runScene completes AFTER the cleanup has fired
    // and the second boot is already in flight — the first game's canvas
    // gets assigned to gameRef (overwriting the second's null), then the
    // second's canvas is appended too. Result: two Phaser canvases side
    // by side rendering the same scene. Token + cancelled check lets the
    // superseded boot tear down its orphan game instead of leaking it.
    let cancelled = false;
    // Boot generation — bumped on every boot() entry. A boot whose async
    // `runScene` resolves AFTER a newer boot started is stale: it destroys its
    // own game and bails, so back-to-back GoToLayouts can't orphan a game that
    // holds a WebGL context (browsers force-drop the oldest context after ~16).
    let bootGen = 0;

    const boot = async (s: typeof scene) => {
      const myGen = ++bootGen;
      gameRef.current?.destroy();
      gameRef.current = null;
      // runScene is async — it awaits AssetStore preload (folder mode
      // reads files from disk into blob URLs before Phaser's loader runs).
      const game = await runScene(project, s, container);
      if (cancelled || myGen !== bootGen) { game.destroy(); return; }
      gameRef.current = game;
      // Debug hook: expose the live game so F12 console can poke
      // peaky.* scene-data keys. `window.__peakyGame.getScene()` returns
      // the active Phaser scene; its `data.get(...)` is the source of
      // truth for placementsBySpriteId, recipes, etc.
      (window as unknown as { __peakyGame: typeof game }).__peakyGame = game;
    };
    // Fresh Play session = fresh world: clear persistent state (removed
    // objects + globals) ONCE on the initial boot. Scene transitions reuse
    // `boot` WITHOUT resetting, so removals/globals carry across scenes.
    resetPersistentState();
    seedPersistentGlobals({
      // Declared Main-Sheet globals.
      ...Object.fromEntries(
        (project.globalVariables ?? []).map((g) => [g.name, g.isArray ? [...(g.items ?? [])] : g.default]),
      ),
      // Blueprint variables marked Global — seed their defaults so global:<name>
      // resolves from frame 0 even before the owning instance spawns.
      ...Object.fromEntries(
        project.blueprints.flatMap((bp) => bp.variables.filter((v) => v.global).map((v) => [v.name, v.default])),
      ),
    });
    seedPersistentLists(
      Object.fromEntries(
        (project.lists ?? []).map((l) => [
          l.name,
          Object.fromEntries((l.entries ?? []).map((e) => [e.name, e.value])),
        ]),
      ),
    );
    void boot(activeScene);

    // GoToLayout / GoToNextLayout dispatch `peaky:goToScene` on the
    // canvas parent (= our container). We resolve the named scene
    // against project.scenes and re-bootstrap with new scene data.
    //
    // Critical: defer the destroy+create to a setTimeout(0) tick.
    // The event fires synchronously from inside a Sprite.tick action
    // chain — destroying Phaser.Game while it's mid-update crashes
    // its internals (visible symptom: "camera jumps + double refresh
    // + new scene starts only intermittently"). The defer lets the
    // current update finish cleanly before we tear down.
    //
    // The `pending` guard drops re-entrant requests — if the user
    // chains GoToLayout actions on the same frame, only the first
    // wins (by design — chains shouldn't pile up scene transitions).
    const onGoToScene = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      const target = project.scenes.find((s) => s.name === detail.name);
      if (!target) {
        console.warn(`[Peaky] GoToLayout: scene "${detail.name}" not found. Available: ${project.scenes.map((s) => s.name).join(", ")}`);
        return;
      }
      if (pending) return;
      pending = true;
      activeScene = target;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        pending = false;
        void boot(activeScene);
      }, 0);
    };
    container.addEventListener("peaky:goToScene", onGoToScene);

    /** GoToLayoutWithLoad path. Two-phase transition:
     *   1) Boot the project's loadingSceneId scene so its Logic Sheet (UI,
     *      animations, OnSceneStart chain) is live.
     *   2) While that scene is running, warm the target scene's textures /
     *      audio / tilesets via buildSpritePreload and let Phaser's loader
     *      report progress. We fan `_loadProgress { pct }` and `_loadComplete`
     *      out to every sprite in the loading scene, plus `_loadStart` on
     *      kickoff. When both `minDisplaySec` has elapsed AND the loader
     *      reports complete, we finally swap to the target scene (which
     *      hits the warmed texture cache, so its own preload runs free).
     *   3) Falls back to a plain GoToScene if no loadingSceneId is set or
     *      the named loading scene is missing — feature stays optional. */
    const onGoToSceneWithLoad = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string; minDisplaySec: number }>).detail;
      const target = project.scenes.find((s) => s.name === detail.name);
      if (!target) {
        console.warn(`[Peaky] GoToLayoutWithLoad: scene "${detail.name}" not found.`);
        return;
      }
      // Loading scene resolution chain: runtime override > project default.
      // SetLoadingScene action sets `peaky.loadingSceneOverride` on the
      // current scene's data; we read it here. Override name takes
      // precedence so authors can swap loaders per-transition without
      // needing per-action config.
      const phCur = gameRef.current?.getScene();
      const overrideName = (phCur?.data.get("peaky.loadingSceneOverride") as string | undefined)?.trim();
      const overrideScene = overrideName ? project.scenes.find((s) => s.name === overrideName) : undefined;
      const projectDefaultScene = project.loadingSceneId
        ? project.scenes.find((s) => s.id === project.loadingSceneId)
        : undefined;
      const loadingScene = overrideScene ?? projectDefaultScene;
      if (!loadingScene) {
        // No loading scene configured — degrade to a plain transition.
        onGoToScene(new CustomEvent("peaky:goToScene", { detail: { name: detail.name } }));
        return;
      }
      if (pending) return;
      pending = true;
      const minDisplayMs = Math.max(0, detail.minDisplaySec * 1000);
      const startedAt = performance.now();
      // Boot the loading scene synchronously via the same defer pattern.
      activeScene = loadingScene;
      pendingTimer = setTimeout(async () => {
        try {
          pendingTimer = null;
          pending = false;
          await boot(activeScene);
          // runScene resolves once Phaser.Game is constructed, but the
          // Phaser scene's create() runs asynchronously on its next
          // animation frame — getScene() returns undefined until then.
          // Poll up to ~1s. (Boot on a fresh project usually takes
          // 100-300ms; 1s is a generous cap.)
          let ph: Phaser.Scene | undefined;
          for (let i = 0; i < 50; i++) {
            ph = gameRef.current?.getScene();
            if (ph) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          if (!ph) {
            console.warn("[Loader] phaser scene never became ready after boot — falling back to plain transition");
            container.dispatchEvent(new CustomEvent("peaky:goToScene", { detail: { name: target.name }, bubbles: true }));
            return;
          }
          // Flag the scene as loading — IsLoading condition reads this.
          ph.data.set("peaky.isLoading", true);
          // Emit OnLoadStart once the loading scene's sprites are alive.
          const fanout = (name: string, payload?: unknown) => {
            const list = (ph.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            for (const s of list) {
              if (s.destroyed) continue;
              if (s.events.listenerCount(name) > 0) s.events.emit(name, payload);
            }
          };
          fanout("_loadStart");
        // Warm-up + queue target scene's assets onto the loading scene's
        // Phaser scene. The `buildSpritePreload(project, target)()` returns
        // a sync hook that calls scene.load.image/audio for each asset.
        let complete = false;
        const tryFinish = () => {
          if (!complete) return;
          const elapsed = performance.now() - startedAt;
          const wait = Math.max(0, minDisplayMs - elapsed);
          setTimeout(() => {
            // Clear the IsLoading flag and consume the one-shot scene
            // override before the target boots — keeps the next
            // GoToLayoutWithLoad starting from a clean slate.
            ph.data.set("peaky.isLoading", false);
            ph.data.set("peaky.loadingSceneOverride", "");
            // Re-dispatch as a plain goToScene so the existing handler does the swap.
            container.dispatchEvent(new CustomEvent("peaky:goToScene", { detail: { name: target.name }, bubbles: true }));
          }, wait);
        };
        try {
          const hook = await buildSpritePreload(project, target)();
          if (cancelled) return;
          // Hook progress + complete BEFORE calling start().
          ph.load.on("progress", (pct: number) => fanout("_loadProgress", { pct }));
          ph.load.once("complete", () => {
            if (complete) return;
            fanout("_loadProgress", { pct: 1 });
            fanout("_loadComplete");
            complete = true;
            tryFinish();
          });
          hook(ph);
          // ALWAYS call start() — Phaser's `totalToLoad` only updates AFTER
          // start runs, so we can't reliably tell beforehand if the queue
          // is empty. start() with an empty queue is a no-op in some Phaser
          // versions (no complete event fires), so we ALSO arm a safety
          // timer. If complete hasn't fired ~150 ms later, force-finish —
          // covers both "already cached" cases (where the hook adds nothing)
          // and rare edge cases where the loader silently drops events.
          ph.load.start();
          setTimeout(() => {
            if (complete || cancelled) return;
            console.log("[Loader] safety timer fired — Phaser's complete event didn't, force-finishing");
            fanout("_loadProgress", { pct: 1 });
            fanout("_loadComplete");
            complete = true;
            tryFinish();
          }, 150);
        } catch (err) {
          console.warn("[Loader] GoToLayoutWithLoad threw during asset warm:", err);
          // Clear the loading flag on error so IsLoading doesn't get stuck.
          ph.data.set("peaky.isLoading", false);
          ph.data.set("peaky.loadingSceneOverride", "");
          // Fall back to plain transition so the user isn't stuck on the loader.
          container.dispatchEvent(new CustomEvent("peaky:goToScene", { detail: { name: target.name }, bubbles: true }));
        }
        } catch (outerErr) {
          // Surface boot-time errors that would otherwise reject silently
          // and leave the loader stuck. The setTimeout async callback's
          // rejection has no `.catch` consumer, so without this try/catch
          // any failure pre-hook (e.g. runScene rejecting) just hangs.
          console.error("[Loader] outer error before asset hook:", outerErr);
          pending = false;
        }
      }, 0);
    };
    container.addEventListener("peaky:goToSceneWithLoad", onGoToSceneWithLoad);

    return () => {
      cancelled = true;
      container.removeEventListener("peaky:goToScene", onGoToScene);
      container.removeEventListener("peaky:goToSceneWithLoad", onGoToSceneWithLoad);
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      gameRef.current?.destroy();
      gameRef.current = null;
    };
    // Re-run only on isRunning toggle — edits during play don't hot-swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  return (
    <div className="scene-area">
      {isRunning ? (
        <div
          ref={previewRef}
          style={{
            background: "#000",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        />
      ) : (
        <SceneEditor />
      )}
    </div>
  );
}
