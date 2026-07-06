/**
 * Standalone game player — bundles `runScene` so an exported HTML can
 * actually boot the game. Lives in the editor package because that's
 * where runProject.runScene already lives; the runtime package alone
 * doesn't know how to walk the project schema to spawn BPs.
 *
 * The bundle this file produces (via `npm run build:standalone` in the
 * editor package) is what the export feature drops into the ZIP as
 * `peaky-standalone.js`. The exported `index.html` script tag points
 * at this file's IIFE and calls `window.PeakyStandalone.boot(...)`.
 */
import { runScene, buildSpritePreload } from "./runProject";
import type { PeakyProject, SceneData } from "./project";
import type { Peaky, Sprite } from "@peaky/runtime";
import { resetPersistentState, seedPersistentGlobals, seedPersistentLists } from "@peaky/runtime";
import { registerProjectFonts } from "./fontRegistry";

export interface StandaloneBootOptions {
  /** The full PeakyProject the editor exported (already JSON.parsed). */
  project: PeakyProject;
  /** DOM element OR id selector to attach the canvas to. */
  parent: HTMLElement | string;
  /** Base URL for loading asset files. Defaults to `assets/` relative to
   *  the page. The export ZIP layout already matches that, so most users
   *  don't need to override. */
  assetsBaseUrl?: string;
  /** Optional scene id override (which scene to start in). Defaults to
   *  `project.activeSceneId`, then to the first scene. */
  sceneId?: string;
}

function pickInitialScene(project: PeakyProject, sceneId?: string): SceneData | undefined {
  const explicit = sceneId ?? project.activeSceneId;
  if (explicit) {
    const s = project.scenes.find((sc) => sc.id === explicit);
    if (s) return s;
  }
  return project.scenes[0];
}

function resolveParent(parent: HTMLElement | string): HTMLElement | null {
  if (typeof parent === "string") return document.getElementById(parent);
  return parent;
}

export async function boot(opts: StandaloneBootOptions): Promise<void> {
  const baseUrl = opts.assetsBaseUrl ?? "assets/";
  // runProject reads this global to fall back from AssetStore (folder
  // mode, editor only) to direct HTTP URLs OR data URLs from
  // __peakyAssetMap. Setting it BEFORE runScene so the URL resolver
  // picks it up on first preload.
  (globalThis as Record<string, unknown>)["__peakyAssetsBaseUrl"] = baseUrl;
  // Bug #1 fix: register custom project fonts via FontFace + document.fonts.
  // In the editor this runs from App.tsx; the standalone bundle never wired
  // it, so any Text using a custom family fell back to system fonts in the
  // export. The font file bytes are already in __peakyAssetMap (inlined as
  // data URLs by exportGame), which is what registerProjectFonts consumes.
  try { registerProjectFonts(opts.project.fonts); } catch { /* font setup is non-fatal */ }
  const parentEl = resolveParent(opts.parent);
  if (!parentEl) {
    // eslint-disable-next-line no-console
    console.error("[Peaky Standalone] parent element not found:", opts.parent);
    return;
  }
  const firstScene = pickInitialScene(opts.project, opts.sceneId);
  if (!firstScene) {
    // eslint-disable-next-line no-console
    console.error("[Peaky Standalone] project has no scenes");
    return;
  }

  // PersistentState seeding — mirrors ScenePanel's Play boot EXACTLY. Without
  // this an exported game starts with UNSEEDED globals/lists (global:<name>
  // reads 0/"" until a SetGlobal runs) and stale state on a re-boot — the #1
  // export-vs-editor behavior divergence found in the v0.0.1 audit.
  resetPersistentState();
  seedPersistentGlobals({
    ...Object.fromEntries(
      (opts.project.globalVariables ?? []).map((g) => [g.name, g.isArray ? [...(g.items ?? [])] : g.default]),
    ),
    ...Object.fromEntries(
      opts.project.blueprints.flatMap((bp) => bp.variables.filter((v) => v.global).map((v) => [v.name, v.default])),
    ),
  });
  seedPersistentLists(
    Object.fromEntries(
      (opts.project.lists ?? []).map((l) => [
        l.name,
        Object.fromEntries((l.entries ?? []).map((e) => [e.name, e.value])),
      ]),
    ),
  );

  // Active Peaky instance — kept in this closure so the scene-transition
  // listener can tear it down before booting the next scene's instance.
  let game: Peaky | null = null;
  // Re-entrancy guard: when an action chain fires multiple GoToLayouts on
  // the same frame, only the first wins. Mirrors ScenePanel's `pending`.
  let pending = false;

  const runOne = async (scene: SceneData) => {
    if (game) {
      try { game.destroy(); } catch { /* ignore */ }
      game = null;
      // Empty the parent so the new canvas isn't appended next to a dead one.
      while (parentEl.firstChild) parentEl.removeChild(parentEl.firstChild);
    }
    try {
      game = await runScene(opts.project, scene, parentEl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[Peaky Standalone] runScene threw:", err);
    }
  };

  // Bug #3 fix: `pending` stays true for the ENTIRE transition lifetime
  // (from event receipt through target-scene boot), not just until the
  // setTimeout(0) fires. A second GoToLayout/WithLoad arriving mid-
  // transition gets dropped, mirroring ScenePanel's behavior.
  const requestScene = (name: string) => {
    const target = opts.project.scenes.find((sc) => sc.name === name || sc.id === name);
    if (!target) {
      // eslint-disable-next-line no-console
      console.warn("[Peaky Standalone] GoToLayout: scene not found:", name,
        "available:", opts.project.scenes.map((s) => s.name).join(", "));
      return;
    }
    if (pending) return;
    pending = true;
    // Defer destroy+boot to setTimeout(0): peaky:goToScene fires
    // synchronously from inside a Sprite.tick action chain — destroying
    // Phaser.Game while it's mid-update crashes Phaser internals.
    setTimeout(async () => {
      try { await runOne(target); }
      finally { pending = false; }
    }, 0);
  };

  // Plain scene-transition handler.
  const onGoToScene = ((ev: Event) => {
    const detail = (ev as CustomEvent<{ name?: string }>).detail ?? {};
    requestScene(String(detail.name ?? "").trim());
  }) as EventListener;

  // Loading-scene transition handler — boot loader scene, warm target
  // assets in the background, fan _loadStart / _loadProgress /
  // _loadComplete to the loader scene's sprites, swap to target once
  // (assets ready AND minDisplaySec elapsed). Falls back to a plain
  // transition when no loading scene is configured.
  const onGoToSceneWithLoad = ((ev: Event) => {
    const detail = (ev as CustomEvent<{ name?: string; minDisplaySec?: number }>).detail ?? {};
    const targetName = String(detail.name ?? "").trim();
    if (!targetName) return;
    const target = opts.project.scenes.find((sc) => sc.name === targetName || sc.id === targetName);
    if (!target) {
      // eslint-disable-next-line no-console
      console.warn("[Peaky Standalone] GoToLayoutWithLoad: target not found:", targetName);
      return;
    }
    const phCur = game?.getScene();
    const overrideName = (phCur?.data.get("peaky.loadingSceneOverride") as string | undefined)?.trim();
    const overrideScene = overrideName
      ? opts.project.scenes.find((s) => s.name === overrideName)
      : undefined;
    const projectDefaultScene = opts.project.loadingSceneId
      ? opts.project.scenes.find((s) => s.id === opts.project.loadingSceneId)
      : undefined;
    const loadingScene = overrideScene ?? projectDefaultScene;
    if (!loadingScene) {
      requestScene(targetName);
      return;
    }
    if (pending) return;
    pending = true;
    const minDisplayMs = Math.max(0, (detail.minDisplaySec ?? 0) * 1000);
    const startedAt = performance.now();
    setTimeout(async () => {
      let releasedPending = false;
      // Helper to hand control off to the plain-transition handler at
      // the end of the loader phase. requestScene's own pending guard
      // would block (we still hold `pending=true`), so we release just
      // before delegating. Marks `releasedPending` so the outer error
      // handler doesn't double-release.
      const swapToTarget = () => {
        releasedPending = true;
        pending = false;
        // requestScene now flips pending back on for its own transition.
        requestScene(targetName);
      };
      try {
        await runOne(loadingScene);
        let ph: Phaser.Scene | undefined;
        for (let i = 0; i < 50; i++) {
          ph = game?.getScene();
          if (ph) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        if (!ph) { swapToTarget(); return; }
        ph.data.set("peaky.isLoading", true);
        const fanout = (name: string, payload?: unknown) => {
          const list = (ph!.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          for (const s of list) {
            if (s.destroyed) continue;
            if (s.events.listenerCount(name) > 0) s.events.emit(name, payload);
          }
        };
        fanout("_loadStart");
        let complete = false;
        const tryFinish = () => {
          if (!complete) return;
          const elapsed = performance.now() - startedAt;
          const wait = Math.max(0, minDisplayMs - elapsed);
          setTimeout(() => {
            ph!.data.set("peaky.isLoading", false);
            ph!.data.set("peaky.loadingSceneOverride", "");
            swapToTarget();
          }, wait);
        };
        try {
          const hook = await buildSpritePreload(opts.project, target)();
          ph.load.on("progress", (pct: number) => fanout("_loadProgress", { pct }));
          ph.load.once("complete", () => {
            if (complete) return;
            fanout("_loadProgress", { pct: 1 });
            fanout("_loadComplete");
            complete = true;
            tryFinish();
          });
          hook(ph);
          ph.load.start();
          setTimeout(() => {
            if (complete) return;
            fanout("_loadProgress", { pct: 1 });
            fanout("_loadComplete");
            complete = true;
            tryFinish();
          }, 150);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[Peaky Standalone] GoToLayoutWithLoad asset-warm failed:", err);
          ph.data.set("peaky.isLoading", false);
          ph.data.set("peaky.loadingSceneOverride", "");
          swapToTarget();
        }
      } catch (outerErr) {
        // eslint-disable-next-line no-console
        console.error("[Peaky Standalone] GoToLayoutWithLoad outer failure:", outerErr);
        if (!releasedPending) pending = false;
      }
    }, 0);
  }) as EventListener;

  // Bug #2 fix: remove any listeners attached by a prior boot() before
  // wiring new ones. We tag the parent element with the handlers so we
  // can detach them — otherwise calling boot() twice on the same parent
  // leaks N transition pipelines per event.
  type ListenerTag = { go: EventListener; goLoad: EventListener };
  const TAG_KEY = "__peakyStandaloneListeners";
  const tagged = (parentEl as unknown as Record<string, ListenerTag | undefined>)[TAG_KEY];
  if (tagged) {
    parentEl.removeEventListener("peaky:goToScene", tagged.go);
    parentEl.removeEventListener("peaky:goToSceneWithLoad", tagged.goLoad);
  }
  parentEl.addEventListener("peaky:goToScene", onGoToScene);
  parentEl.addEventListener("peaky:goToSceneWithLoad", onGoToSceneWithLoad);
  (parentEl as unknown as Record<string, ListenerTag>)[TAG_KEY] = { go: onGoToScene, goLoad: onGoToSceneWithLoad };

  await runOne(firstScene);
}

// Expose the boot function globally so the exported HTML can call it
// without ES module syntax — the IIFE bundle Vite produces self-attaches
// to `window.PeakyStandalone` thanks to vite.config.lib.ts's `name`.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>)["PeakyStandalone"] = { boot };
}
