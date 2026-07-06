import Phaser from "phaser";
import { VHSPipeline, ChromaticAberrationPipeline, FilmGrainPipeline } from "./fx/ScreenFXPipelines";
import { clearRandomSyncCache } from "./LogicSheetRunner";
import { drawNavDebug } from "./nav/navPoints";
import { Sprite, SpriteShape } from "./Sprite";
import { runCollisionScan } from "./CollisionScan";
import { runDoorScan } from "./sm/eval";
import { rebuildSpatialGrid } from "./spatialGrid";
import { Solid } from "./behaviors/Solid";
import { JumpThru } from "./behaviors/JumpThru";
import { Collider } from "./behaviors/Collider";
import { InputActions, InputActionSpec, INPUT_ACTIONS_KEY } from "./input/InputActions";

/** Maximum sprites that spawn in a single frame from either the initial
 *  scene.instances pass or the CreateObject action. Excess spawns enqueue
 *  to peaky.spawnQueue and drain on subsequent frames. 50 × ~1.5ms per
 *  spawn ≈ 75ms worst-case per frame, so a 3000-NPC ramp completes in
 *  ~1s while keeping fps above 13. Projectile spawns bypass this via
 *  `{ immediate: true }` on the spawn callback so a fired bullet always
 *  appears the same frame the trigger fires. */
const SPAWN_BUDGET_PER_FRAME = 50;

export interface PeakyConfig {
  /**
   * Viewport (game-window) size — the Phaser canvas renders at this size.
   * The camera shows exactly this slice of the world at any moment.
   */
  width?: number;
  height?: number;
  /**
   * Layout (world) size — the area the camera can scroll across. Defaults
   * to viewport size for non-scrolling games. May be larger; the camera
   * + physics world bounds get clamped to this rectangle.
   */
  layoutWidth?: number;
  layoutHeight?: number;
  /**
   * When false, the camera is NOT clamped to layout bounds (Construct-style
   * "unbounded scrolling"). Default true. Physics body bounds are always
   * applied — only camera scroll is affected by this flag.
   */
  boundedCamera?: boolean;
  backgroundColor?: number;
  gravity?: number;
  parent?: string | HTMLElement;
  /** Project-wide input action mappings — name → list of bound key codes. */
  inputActions?: InputActionSpec[];
  /**
   * Global texture filtering (Construct-style "Sampling"). "nearest" =
   * crisp pixels for pixel art; "bilinear" (default) = smooth; "trilinear"
   * = smooth + mipmaps for downscaling. Sets the Phaser renderer default so
   * every loaded/generated texture follows it.
   */
  sampling?: "nearest" | "bilinear" | "trilinear";
}

export type Builder = (game: Peaky) => void;
/** Phaser preload hook — runs before the scene's `create`, suitable for `scene.load.image(...)`. */
export type PreloadHook = (scene: Phaser.Scene) => void;
/** The per-scene world settings a transition must carry to the next build. */
export interface SceneRunConfig {
  layoutWidth: number;
  layoutHeight: number;
  boundedCamera: boolean;
  gravity: number;
  backgroundColor: number;
}

export class Peaky {
  private readonly config: Required<PeakyConfig>;
  private phaserGame?: Phaser.Game;
  private scene?: Phaser.Scene;
  /** The CURRENT scene builder + preload. Stored (not captured in `start`) so an
   *  in-place `scene.restart()` rebuilds whatever scene `setBuilder` last set —
   *  this is what lets GoToLayout swap scenes WITHOUT destroying the game. */
  private _builder?: Builder;
  private _preload?: PreloadHook;
  /** Public read-only accessor — set inside the Phaser scene's `create()`
   *  callback. Available after start()'s builder runs. Editor-side runProject
   *  uses this to register scene-data callbacks before any sprite spawn. */
  getScene(): Phaser.Scene | undefined { return this.scene; }
  /** Live measured FPS reported by Phaser's frame-time loop. Returns 0
   *  before the game has started or if the loop hasn't reported yet.
   *  Used by the editor TopBar's FPS counter. */
  getActualFps(): number {
    const loop = (this.phaserGame as Phaser.Game | undefined)?.loop;
    return loop ? Math.round(loop.actualFps ?? 0) : 0;
  }
  private readonly sprites: Sprite[] = [];
  /** Frame counter for the throttled per-frame cull stats log. Logs once
   *  per 60 frames (~1Hz) so the console doesn't flood. Public for the
   *  scene-update closure to read/write. */
  _cullStatFrame = 0;

  constructor(config: PeakyConfig = {}) {
    this.config = {
      width: config.width ?? 800,
      height: config.height ?? 600,
      // Layout defaults to viewport so non-scrolling games don't have to
      // think about it. Larger layouts enable camera scrolling.
      layoutWidth: config.layoutWidth ?? config.width ?? 800,
      layoutHeight: config.layoutHeight ?? config.height ?? 600,
      // Default true — camera clamped to layout. Pass false for
      // Construct-style "Unbounded Scrolling".
      boundedCamera: config.boundedCamera ?? true,
      backgroundColor: config.backgroundColor ?? 0x1a1a2e,
      gravity: config.gravity ?? 800,
      parent: config.parent ?? "app",
      inputActions: config.inputActions ?? [],
      sampling: config.sampling ?? "bilinear",
    };
  }

  /** Create a sprite. Must be called after the scene is ready (inside `start()`'s builder). */
  sprite(shape: SpriteShape): Sprite {
    if (!this.scene) {
      throw new Error("Peaky.sprite(): scene not ready. Create sprites inside the start() callback.");
    }
    const s = new Sprite(this.scene, shape);
    this.registerCollisions(s);
    this.sprites.push(s);
    // Bug #6 fix support: notify any registered post-spawn hooks (e.g.,
    // sprite-object placements with collider enabled need to wire pairs
    // against this newly-spawned sprite). Each hook runs in a try/catch
    // so a buggy hook can't kill spawn.
    const hooks = this.scene.data.get("peaky.onSpriteSpawnHooks") as Array<(sp: Sprite) => void> | undefined;
    if (hooks) {
      for (const h of hooks) { try { h(s); } catch { /* ignore — hook bug shouldn't block spawn */ } }
    }
    return s;
  }

  /** Per-scene settings applied by create(). On the initial boot these come from
   *  the Peaky config; an in-place transition (gotoScene) OVERRIDES them with the
   *  TARGET scene's values — without this, a restart would build the new scene
   *  with the OLD scene's world/camera bounds, gravity and background (bodies
   *  clamped to the wrong world = "spawned in the wrong place", camera unable to
   *  scroll, wrong bg). */
  private _sceneOverride?: SceneRunConfig;

  /** Swap the builder + preload for the NEXT scene build. Pure setter — pair
   *  with `scene.restart()` (via `gotoScene`) to rebuild in place. */
  setBuilder(build: Builder, preload?: PreloadHook): void {
    this._builder = build;
    this._preload = preload;
  }

  /** In-place scene transition: swap the builder (+ the target scene's world
   *  config), then restart the Phaser scene so `create()` rebuilds the NEW scene
   *  on the SAME game (textures kept). Fires the prior run's SHUTDOWN cleanup +
   *  the create() registry resets — same path RestartLayout uses. No-op if the
   *  game is already torn down. */
  gotoScene(build: Builder, preload?: PreloadHook, sceneCfg?: SceneRunConfig): void {
    this.setBuilder(build, preload);
    if (sceneCfg) this._sceneOverride = sceneCfg;
    const ph = this.scene;
    if (ph) ph.scene.restart();
  }

  start(build: Builder, preload?: PreloadHook): this {
    this._builder = build;
    this._preload = preload;
    const self = this;
    class MainScene extends Phaser.Scene {
      constructor() { super("main"); }
      preload() {
        // Caller queues data-URL textures, audio, etc. before create() runs.
        // Reads the CURRENT stored preload so a restart re-preloads the new scene.
        if (self._preload) self._preload(this);
      }
      create() {
        self.scene = this;
        // Reset registries on EVERY scene start (including RestartLayout
        // / GoToLayout). Phaser's scene.restart() preserves DataManager
        // contents — without explicit clearing, `peaky.sprites` keeps
        // accumulating Sprite wrappers from prior scene runs whose
        // GameObjects Phaser already destroyed. The new scene's update
        // loop would then tick those orphans, accessing dead bodies and
        // crashing in subtle ways (visible symptom: "controls dead
        // after RestartLayout, broken even after Stop+Play, only fixed
        // by a page refresh"). Same reset for the Game-instance field
        // so post-restart spawn iteration doesn't re-touch dead refs.
        this.data.set("peaky.sprites", []);
        this.data.set("peaky.spritesByUid", new Map());
        // Per-cell tile HP and the last-destroyed-tile snapshot live on the
        // scene data registry. Without this reset, GoToLayout / RestartLayout
        // would surface stale damage from the previous run — e.g. a tile the
        // player mined in scene 1 spawns with HP &lt; max in scene 2, OR the
        // `lastTile.*` expression tokens return data from the prior scene.
        this.data.set("peaky.tileHP", new Map());
        // Per-tile MAX hardness cache — reset alongside tileHP. Without this it
        // accumulates one permanent entry per distinct damaged tile across every
        // layout in a session (GoToLayout/RestartLayout preserve scene.data),
        // since it's created lazily by TilemapRenderer and never pruned.
        this.data.set("peaky.tileMaxHP", new Map());
        this.data.set("peaky.lastDestroyedTile", null);
        this.data.set("peaky.lastDamagedTile", null);
        this.data.set("peaky.lastDrop", null);
        this.data.set("peaky.usedNavPoints", new Set<string>());
        this.data.set("peaky.claimedNavPoints", new Map<string, { uid: number; frame: number }>());
        this.data.set("peaky.lastNavPoint", null);
        // Spawn queue + per-frame counter survive Phaser's scene.restart()
        // unless cleared here. Without this, queued spawns from the previous
        // run would drain into the fresh scene with stale BP ids / layer
        // names. (audit 2026-06-06 CRIT #2)
        this.data.set("peaky.spawnQueue", []);
        this.data.set("peaky.spawnsThisFrame", 0);
        // Tag/spatial indices + per-frame transient state. (audit HIGH #43, #44)
        this.data.set("peaky.spritesByTag", new Map());
        this.data.set("peaky.spritesByName", new Map());
        this.data.set("peaky.spatialGrid", new Map());
        this.data.set("peaky.picked", null);
        this.data.set("peaky.pickedSets", new Map());
        this.data.set("peaky.collideTracker", new Map());
        this.data.set("peaky.collidePartners", new Map());
        // ── Persistent-game resets ──────────────────────────────────────────
        // These used to be wiped by the full game.destroy() on GoToLayout. With
        // in-place scene.restart() (RestartLayout today, all transitions after
        // the fast-transition refactor) they'd otherwise leak or FREEZE the new
        // scene. Harmless on a fresh boot (already empty).
        // Hitstop — else a transition mid-hitstop leaves the new scene frozen.
        for (const k of ["peaky.hitstopBeginAtMs", "peaky.hitstopUntilRealMs", "peaky.hitstopPrevScale", "peaky.hitstopScale", "peaky.hitstopMs", "peaky.hitstopAffectPhysics", "peaky.hitstopAffectParticles", "peaky.hitstopAffectSmartTween"]) this.data.remove(k);
        this.time.timeScale = 1;
        this.tweens.timeScale = 1;
        if (this.physics?.world) this.physics.world.timeScale = 1;
        // Camera — the MAIN camera survives restart; clear stale zoom/follow/
        // scroll/rotation (the "camera zoomed after a transition" bug) + the
        // cached {sprite,behavior} target (else Camera follows a dead sprite).
        this.data.remove("peaky.camera");
        const _mc = this.cameras?.main;
        if (_mc) { _mc.stopFollow(); _mc.setZoom(1); _mc.setScroll(0, 0); _mc.setRotation(0); }
        // Mouse/input transient state — else a click during the transition ghosts
        // a double-click and held buttons read as stuck in the new scene.
        this.data.set("peaky.mousePrev", new Map());
        this.data.set("peaky.mouseDownAt", new Map());
        this.data.set("peaky.lastClickAt", new Map());
        this.data.set("peaky.lastObjClickAt", new Map());
        this.data.set("peaky.wheelDeltaY", 0);
        this.data.set("peaky.mouseBlockers", new Set());
        // Tilemap registries — TilemapRenderer APPENDS (`?? []`), so old dead
        // layer GameObjects/bodies accumulate unless cleared.
        this.data.set("peaky.tilemapLayers", []);
        this.data.set("peaky.tilemapStaticGroups", []);
        this.data.set("peaky.tilemapsByName", new Map());
        this.data.set("peaky.tilemapsByNameAll", new Map());
        this.data.set("peaky.bigTileImages", []);
        // Placement/spawn callbacks + queues (builder re-registers, but clear so
        // the update loop can't read a stale closure/array from the prior run).
        this.data.set("peaky.pendingPlacementCreates", []);
        this.data.set("peaky.pendingPlacementDestroys", []);
        this.data.set("peaky.onSpriteSpawnHooks", []);
        this.data.remove("peaky.wireCollisionsFor");
        this.data.remove("peaky.deactivateToPool");
        this.data.remove("peaky.spawn");
        this.data.remove("peaky.spawnUIWidget");
        this.data.set("peaky.spritePool", new Map());
        this.data.set("peaky.placementsBySpriteId", new Map());
        this.data.set("peaky.activePlacement", null);
        // Scene-authored lookups that the builder only sets when the scene HAS
        // them — without removal, a scene WITHOUT painted shelter / nav keeps
        // the PREVIOUS scene's mask/grid (rain dying in ghost cells, AI pathing
        // against the old level). Same for the SetAmbientLight darkness sheet:
        // restart destroys the Rectangle but the cached ref survives, so the
        // next SetAmbientLight pokes a dead object and night stops working.
        this.data.remove("peaky.shelterMask");
        this.data.remove("peaky.navGrid");
        this.data.remove("peaky.navDebug");
        this.data.remove("peaky.darkness");
        // Pause + transition flags.
        this.data.set("peaky.pauseAll", false);
        this.data.set("peaky.pausedLayers", new Set());
        this.data.set("peaky.sceneEnding", false);
        this.data.set("peaky.isLoading", false);
        this.data.set("peaky.loadingSceneOverride", "");
        // Release the OUTGOING run's per-sprite resources on scene SHUTDOWN.
        // scene.restart() (RestartLayout) reuses this scene object, so without
        // this the prior run's Logic Sheet scene-listeners + behavior
        // subscriptions stay registered forever (one set per restart), pinning
        // every dead Sprite. Resource-only cleanup — no gameplay OnDestroyed
        // events (a scene exit isn't an in-game destroy). `once` so each run
        // registers exactly one; GoToLayout's full game.destroy() makes it a
        // harmless no-op there.
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
          const live = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          for (const s of [...live]) {
            try { s.shutdownCleanup(); } catch (e) { console.warn("[Peaky] sprite shutdownCleanup threw", e); }
          }
        });
        self.sprites.length = 0;
        // The CURRENT scene's world settings — the boot config, unless an
        // in-place transition (gotoScene) carried the TARGET scene's values.
        const sc = self._sceneOverride ?? self.config;
        this.physics.world.gravity.y = sc.gravity;
        // Background follows the scene too — the Phaser game-level bg was set
        // from the BOOT scene only; a transition must recolor the main camera.
        this.cameras.main.setBackgroundColor(sc.backgroundColor);
        // Camera + physics bounds both follow the unbounded flag. The flag
        // says "no defined layout" — i.e. the world is unlimited — so we
        // skip the camera clamp AND give bodies a virtually infinite play
        // area. Without the physics relax, a player walking past the
        // (small, no-longer-meaningful) layout width would stop dead at the
        // invisible edge even though the camera scrolls freely.
        if (sc.boundedCamera) {
          this.cameras.main.setBounds(0, 0, sc.layoutWidth, sc.layoutHeight);
          this.physics.world.setBounds(0, 0, sc.layoutWidth, sc.layoutHeight);
        } else {
          this.cameras.main.removeBounds();
          this.physics.world.setBounds(-1e6, -1e6, 2e6, 2e6);
        }

        // Secondary "UI" camera — renders ON TOP of the main camera, with
        // the same viewport, but doesn't follow scroll. UI widgets get
        // routed here (mainCam.ignore(uiObj), uiCam.ignore(worldObj))
        // so a `BlurScene` action can blur ONLY the world while the UI
        // stays crisp. Without this split, blur would smear the menu
        // pixels too — defeating the pause-menu aesthetic.
        const uiCam = this.cameras.add(0, 0, self.config.width, self.config.height);
        uiCam.setName("ui");
        uiCam.setScroll(0, 0);
        // UI cam is camera-locked, so never moves. No bounds clamp.
        this.data.set("peaky.uiCam", uiCam);
        // Attach input actions to scene.data so behaviors and SMs can look it up
        // without a separate dependency-injection plumbing layer.
        this.data.set(INPUT_ACTIONS_KEY, new InputActions(this, self.config.inputActions));
        // Screen-FX (SetScreenEffect): register the custom VHS / chromatic shader
        // pipelines once per game, and reset the main camera's postFX to a clean
        // slate each scene (postFX survives scene.restart()). WebGL only.
        this.data.set("peaky.screenFX", {});
        // Per-scene clean slate for layer post-FX too (registry + the
        // late-overlay hook eval.ts registers when a layer effect is active).
        this.data.set("peaky.layerFX", new Map());
        this.data.set("peaky.layerFXHook", undefined);
        // Drop the Random-node sync cache (module-level, keyed by sprite uid) so
        // it doesn't accumulate across scene restarts / GoToLayout.
        clearRandomSyncCache();
        if (this.game.renderer.type === Phaser.WEBGL) {
          const pm = (this.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).pipelines;
          if (!this.game.registry.get("peaky.fxRegistered")) {
            pm.addPostPipeline("peakyVHS", VHSPipeline);
            pm.addPostPipeline("peakyChromatic", ChromaticAberrationPipeline);
            pm.addPostPipeline("peakyGrain", FilmGrainPipeline);
            this.game.registry.set("peaky.fxRegistered", true);
          }
          this.cameras.main.postFX.clear();
          this.cameras.main.resetPostPipeline();
        }
        // Run the CURRENT stored builder (a restart rebuilds the swapped scene).
        if (self._builder) self._builder(self);
      }
      update(_time: number, delta: number) {
        // Nav-point state debug overlay (green=active, yellow=busy, red=consumed,
        // gray=depleted). Toggled by peaky.navDebug.
        if (this.data.get("peaky.navDebug")) drawNavDebug(this);
        // Hitstop auto-resume. A HitStop action froze the scene's timeScale and
        // stored a wall-clock resume time. This update loop runs every frame
        // regardless of timeScale, so we restore the scale here once real time
        // passes (game.loop.time is wall clock — unaffected by the freeze).
        // Phase 1 — begin a scheduled hitstop once its delay elapses. The
        // delay (set by the HitStop action) lets the hit's reaction start
        // first (e.g. the hurt state), so the freeze lands on the hurt pose.
        const hsBegin = this.data.get("peaky.hitstopBeginAtMs") as number | undefined;
        if (hsBegin !== undefined && this.game.loop.time >= hsBegin) {
          const scale = (this.data.get("peaky.hitstopScale") as number | undefined) ?? 0;
          const dur = (this.data.get("peaky.hitstopMs") as number | undefined) ?? 80;
          // Critical: save prevScale ONLY when we're not already frozen by a
          // prior HitStop that's still in flight. Without this guard, a rapid
          // second HitStop (combo hits, multi-hit attacks) would overwrite
          // peaky.hitstopPrevScale with the FROZEN timeScale (0), so Phase 2's
          // resume restored timeScale to 0 and the game stayed frozen forever
          // — the "gray screen on second hit, needs page refresh" symptom.
          // The first HitStop's original prevScale wins so resume goes back to
          // the real running speed.
          const alreadyFrozen = this.data.get("peaky.hitstopUntilRealMs") !== undefined;
          if (!alreadyFrozen) {
            this.data.set("peaky.hitstopPrevScale", this.time.timeScale);
          }
          this.time.timeScale = scale;
          this.tweens.timeScale = scale;
          if (this.data.get("peaky.hitstopAffectPhysics") !== false) {
            this.physics.world.timeScale = scale === 0 ? Infinity : 1 / scale;
          }
          if (this.data.get("peaky.hitstopAffectParticles") !== false) {
            const all = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            for (const s of all) {
              for (const pe of s.findBehaviorsByKind("ParticleEmitter")) pe.setSimTimeScale(scale);
            }
          }
          // affectSmartTween OFF → keep SmartTween playing THROUGH the freeze
          // (run on the raw frame delta at the pre-freeze speed). Default ON
          // freezes it naturally via the global time scale — no override needed.
          if (this.data.get("peaky.hitstopAffectSmartTween") === false) {
            const prevS = (this.data.get("peaky.hitstopPrevScale") as number | undefined) ?? 1;
            const all = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            for (const s of all) {
              for (const st of s.findBehaviorsByKind("SmartTween")) (st as unknown as { setSimTimeScale?: (n: number) => void }).setSimTimeScale?.(prevS);
            }
          }
          // Second HitStop extends the freeze window (max of existing and new
          // end time) rather than truncating — feels right for combo strings
          // where the player wants the last hit's hitstop to land in full.
          const existingUntil = (this.data.get("peaky.hitstopUntilRealMs") as number | undefined) ?? 0;
          const newUntil = this.game.loop.time + dur;
          this.data.set("peaky.hitstopUntilRealMs", Math.max(existingUntil, newUntil));
          this.data.remove("peaky.hitstopBeginAtMs");
        }
        // Phase 2 — auto-resume once the freeze duration elapses.
        const hsUntil = this.data.get("peaky.hitstopUntilRealMs") as number | undefined;
        if (hsUntil !== undefined && this.game.loop.time >= hsUntil) {
          const prev = (this.data.get("peaky.hitstopPrevScale") as number | undefined) ?? 1;
          this.time.timeScale = prev;
          this.tweens.timeScale = prev;
          // Only un-freeze the systems the HitStop actually froze (toggles).
          if (this.data.get("peaky.hitstopAffectPhysics") !== false) {
            this.physics.world.timeScale = prev === 0 ? Infinity : 1 / prev;
            // Drop the physics-step backlog accrued while frozen so bodies
            // don't catch-up-slam on resume (same fix SetTimeScale uses).
            const world = this.physics.world as Phaser.Physics.Arcade.World & { _elapsed?: number };
            if ("_elapsed" in world) world._elapsed = 0;
          }
          if (this.data.get("peaky.hitstopAffectParticles") !== false) {
            const all = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            for (const s of all) {
              for (const pe of s.findBehaviorsByKind("ParticleEmitter")) pe.setSimTimeScale(prev);
            }
          }
          // Clear any SmartTween raw-delta override so it follows the global
          // clock again (harmless when none was set).
          {
            const all = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            for (const s of all) {
              for (const st of s.findBehaviorsByKind("SmartTween")) (st as unknown as { setSimTimeScale?: (n: number) => void }).setSimTimeScale?.(-1);
            }
          }
          this.data.remove("peaky.hitstopUntilRealMs");
          this.data.remove("peaky.hitstopPrevScale");
          this.data.remove("peaky.hitstopAffectPhysics");
          this.data.remove("peaky.hitstopAffectParticles");
          this.data.remove("peaky.hitstopAffectSmartTween");
          this.data.remove("peaky.hitstopMs");
          this.data.remove("peaky.hitstopScale");
        }
        // Spawn budget — only runs when the project sets
        // `spawnBudgetPerFrame > 0` on the project. Default (0) skips
        // this block entirely so spawn is synchronous (brief freeze at
        // scene start with many NPCs but no visible slow ramp). When
        // enabled, queued spawns drain N per frame here.
        const budget = (this.data.get("peaky.spawnBudgetPerFrame") as number | undefined) ?? 0;
        if (budget > 0) {
          this.data.set("peaky.spawnsThisFrame", 0);
          const queue = this.data.get("peaky.spawnQueue") as Array<{
            arg: { id?: string; name?: string; x: number; y: number; layer?: string; vars?: Record<string, number | string | boolean> };
            byName: boolean;
          }> | undefined;
          if (queue && queue.length > 0) {
            const spawn = this.data.get("peaky.spawn") as
              | ((arg: { id?: string; name?: string; x: number; y: number; layer?: string; vars?: Record<string, number | string | boolean> }, opts?: { immediate?: boolean }) => void)
              | undefined;
            if (spawn) {
              let used = 0;
              while (queue.length > 0 && used < budget) {
                const item = queue.shift()!;
                try { spawn(item.arg, { immediate: true }); } catch (e) { console.warn("[Spawn queue] drain threw", e); }
                used += 1;
              }
              this.data.set("peaky.spawnsThisFrame", used);
            }
          }
        }
        // Iterate the live registry that Sprite.destroy() already
        // maintains — `Game.sprites` is the boot-time list and never
        // shrinks, which would leak ticks on destroyed sprites and grow
        // unboundedly in long-running scenes. Snapshot to tolerate mid-tick
        // spawns/destroys mutating the array.
        const live = (this.data.get("peaky.sprites") as Sprite[] | undefined) ?? self.sprites;
        const snapshot = [...live];
        // Drain the SpritePlacement create-broadcast queue. Emits happen
        // here (start of tick) rather than at scene-init time so the
        // signal lands in the EventBus's `fired` set DURING a normal
        // frame — `firedExactlyThisFrame` on listening BPs then returns
        // true. Emitting at init time would put the signal in `fired`
        // before any tick, and by the first tick the bus carryover would
        // have moved it to `firedPrev` (which `firedExactlyThisFrame`
        // doesn't count).
        const pending = this.data.get("peaky.pendingPlacementCreates") as Array<{ spriteId: string; go: Phaser.GameObjects.Sprite }> | undefined;
        if (pending && pending.length > 0) {
          for (const entry of pending) {
            // Make THIS placement's GameObject the active target during
            // the synchronous emit — Set Sprite Object … actions running
            // in the OnSpriteObjectCreate chain will resolve to just this
            // one placement instead of every placement of the asset.
            this.data.set("peaky.activePlacement", entry.go);
            for (const s of snapshot) {
              if (s.destroyed) continue;
              s.events.emit("_placementCreate", { spriteId: entry.spriteId });
              if (entry.spriteId) {
                s.events.emit(`_placementCreate:${entry.spriteId}`, { spriteId: entry.spriteId });
              }
            }
            this.data.set("peaky.activePlacement", null);
          }
          this.data.set("peaky.pendingPlacementCreates", []);
        }
        const pendingDestroy = this.data.get("peaky.pendingPlacementDestroys") as string[] | undefined;
        if (pendingDestroy && pendingDestroy.length > 0) {
          for (const spriteId of pendingDestroy) {
            for (const s of snapshot) {
              if (s.destroyed) continue;
              s.events.emit("_placementDestroy", { spriteId });
              if (spriteId) {
                s.events.emit(`_placementDestroy:${spriteId}`, { spriteId });
              }
            }
          }
          this.data.set("peaky.pendingPlacementDestroys", []);
        }
        // Tag-based overlap scan. Runs AFTER Phaser's physics step (which
        // Phaser handles between scene updates) and BEFORE per-sprite
        // behavior ticks so the animator's tag conditions see this tick's
        // fresh overlap state during its own update.
        runCollisionScan(snapshot);
        // Door scan — reads this tick's ENTER edges (`_justCollidedThisTick`)
        // to start a scene-linking transition when a traveler enters a door.
        runDoorScan(snapshot);
        // Spatial grid — rebucket every sprite into 256px cells before any
        // behavior runs. Behaviors that call getNeighbors/getNeighborsByTag
        // this tick (AIBrain target acquisition, separation, MoveTo,
        // anywhere a "find nearest X" query happens) see a fresh grid
        // reflecting positions AFTER physics resolution. Cost at 10K
        // sprites: ~2ms. Savings on radius queries at 10K: orders of
        // magnitude.
        rebuildSpatialGrid(this);
        // Loop-level viewport cull. Skip sprite.tick() ENTIRELY for any
        // sprite outside the cull ring whose BP opted in to "freeze". This
        // is dramatically cheaper than gating inside Sprite.tick because
        // we skip the function-call + scope-setup overhead too. For 3000
        // NPCs with most off-screen, this is the difference between 30ms
        // of wasted function entries and ~1ms of cheap dx/dy checks.
        const cam = this.cameras?.main;
        const cullMult = (this.data.get("peaky.cullDistanceMultiplier") as number | undefined) ?? 1.5;
        const wv = cam?.worldView;
        const wvcx = wv ? wv.centerX : 0;
        const wvcy = wv ? wv.centerY : 0;
        const halfW = wv ? wv.width * cullMult * 0.5 : Infinity;
        const halfH = wv ? wv.height * cullMult * 0.5 : Infinity;
        // Per-frame stats so authors can verify culling is firing. Logged
        // every 60 frames (~1Hz) so the log doesn't flood. Counts only
        // sprites with `cullMode !== "never"` — story / boss / player BPs
        // are excluded from the "frozen" tally.
        let frozenCount = 0;
        let activeCount = 0;
        for (const s of snapshot) {
          if (s.destroyed) continue;
          // Cull gate — only applies to BPs that opted in via cullMode.
          if (s.cullMode === "freeze" && wv && !s.isUIWidget) {
            const dx = s.gameObject.x - wvcx;
            const dy = s.gameObject.y - wvcy;
            const ax = dx < 0 ? -dx : dx;
            const ay = dy < 0 ? -dy : dy;
            if (ax > halfW || ay > halfH) {
              // Frozen — kill body integration + render. Track state so
              // we restore on re-entry.
              if (!s._frozenByCull) {
                s._frozenByCull = true;
                if (s.body) {
                  s.body.setVelocity(0, 0);
                  s.body.moves = false;
                  s.body.enable = false;
                }
                // Hide the host AND its overlays so the renderer skips them all.
                s.setCullHidden(true);
              }
              frozenCount += 1;
              continue;
            } else if (s._frozenByCull) {
              // Re-entered the ring — wake up.
              s._frozenByCull = false;
              if (s.body) {
                s.body.moves = true;
                s.body.enable = true;
              }
              s.setCullHidden(false);
              // While frozen the sprite never flush()ed, so any signal sent to
              // it (EmitSignalTo by tag — freeze doesn't unindex tags) sat in
              // the bus and would ghost-fire its OnSignal seconds late on wake.
              // Drop the stale backlog, same as the pool reactivate path.
              s.events.clearAll();
            }
          }
          activeCount += 1;
          s.tick(delta);
        }
      }
    }

    const pixelArt = this.config.sampling === "nearest";
    this.phaserGame = new Phaser.Game({
      type: Phaser.AUTO,
      width: this.config.width,
      height: this.config.height,
      backgroundColor: this.config.backgroundColor,
      parent: this.config.parent,
      // Texture filtering (Construct "Sampling"). antialias=false makes every
      // loaded/generated texture default to NEAREST → crisp pixel-art upscaling;
      // true = LINEAR (bilinear). Trilinear adds mipmaps for smoother downscale
      // (power-of-two textures only, a WebGL constraint). roundPixels is left to
      // the Camera behavior — forcing it here (as pixelArt:true would) re-breaks
      // smooth camera follow.
      render: {
        antialias: !pixelArt,
        antialiasGL: !pixelArt,
        mipmapFilter: this.config.sampling === "trilinear" ? "LINEAR_MIPMAP_LINEAR" : "LINEAR",
        roundPixels: false,
      },
      // Fit the canvas inside the parent while preserving aspect ratio. Without
      // this, the canvas renders at fixed scene.width × scene.height regardless
      // of how much room the editor's viewport card has.
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      physics: {
        default: "arcade",
        // tileBias (default 16) is the max overlap arcade resolves against a
        // tile per step. At 16 a body moving / shoved faster than ~16px/frame
        // (fast MoveTo, push-apart separation, a frame spike) can pass through
        // a tile before collision catches it. Raise it so tilemap walls hold
        // against faster bodies. (Dash has its own forward sweep on top.)
        arcade: { gravity: { x: 0, y: this.config.gravity }, debug: false, tileBias: 32 },
      },
      scene: MainScene,
    });
    return this;
  }

  destroy(): void {
    this.phaserGame?.destroy(true);
    this.phaserGame = undefined;
    this.scene = undefined;
    this.sprites.length = 0;
  }

  /**
   * Whenever a new sprite enters the scene, set up colliders against existing sprites
   * where exactly one side is Solid. We defer one microtask so the caller has time to
   * .addBehavior(Solid) before we read .hasBehavior(Solid).
   */
  private registerCollisions(newSprite: Sprite): void {
    queueMicrotask(() => {
      if (!this.scene) return;
      // Iterate the LIVE registry, not `this.sprites` (which never shrinks —
      // it would re-touch every dead sprite from the whole session on each
      // spawn). Track collider handles on both sprites so they're removed when
      // either is destroyed (Phaser keeps + re-processes them otherwise).
      const live = (this.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? this.sprites;
      // Hoist newSprite checks — they don't change per iteration. At
      // spawn-storm scale (~2000 sprites) this removes thousands of
      // redundant Set.has calls per spawn. Combined with the per-kind
      // cache in Sprite, this drops spawn cost dramatically.
      const newIsSolid = newSprite.hasBehavior(Solid);
      const newIsJump = newSprite.hasBehavior(JumpThru);
      const newHasCollider = newSprite.hasBehavior(Collider);
      for (const other of live) {
        if (other === newSprite || other.destroyed) continue;

        // SOLID ↔ non-Solid: full blocking. Non-Solid side needs Collider.
        const otherIsSolid = other.hasBehavior(Solid);
        if (newIsSolid !== otherIsSolid) {
          const nonSolidHasCollider = newIsSolid ? other.hasBehavior(Collider) : newHasCollider;
          if (nonSolidHasCollider) {
            // Optional collide filter published by the SOLID side (a frame-
            // collider BP / placement). Empty list = block everyone.
            const solidSprite = newIsSolid ? newSprite : other;
            const moverSprite = newIsSolid ? other : newSprite;
            const fTags = solidSprite.gameObject.getData?.("peaky.collideTags") as string[] | undefined;
            const proc = (fTags && fTags.length > 0)
              ? () => {
                  const mode = (solidSprite.gameObject.getData?.("peaky.tagMode") as string | undefined) ?? "include";
                  let matches = false;
                  for (const t of fTags) if (moverSprite.tags.has(t)) { matches = true; break; }
                  return mode === "exclude" ? !matches : matches;
                }
              : undefined;
            const c = this.scene.physics.add.collider(newSprite.gameObject, other.gameObject, undefined, proc);
            newSprite._colliders.push(c); other._colliders.push(c);
          }
        }

        // JUMPTHRU ↔ non-JumpThru: one-way. The JumpThru's behavior sets its
        // body's checkCollision flags so only the TOP face accepts contact;
        // we still register a collider with a process callback that consults
        // the actor's `fallingThrough` flag (set by the CMFallThrough action).
        const otherIsJump = other.hasBehavior(JumpThru);
        if (newIsJump !== otherIsJump) {
          const actor = newIsJump ? other : newSprite;
          const actorHasCollider = newIsJump ? other.hasBehavior(Collider) : newHasCollider;
          if (actorHasCollider) {
            const c = this.scene.physics.add.collider(
              newSprite.gameObject,
              other.gameObject,
              undefined,
              () => {
                // Skip the collision when the actor is mid-fall-through.
                // Read the SCALED sim clock (simNowMs) — same clock the deadline
                // was written with — so pause / hitstop holds the window.
                return !actor.fallingThroughUntil
                  || actor.simNowMs > actor.fallingThroughUntil;
              },
            );
            newSprite._colliders.push(c); other._colliders.push(c);
          }
        }
      }

      // TILEMAPS: any sprite with a Collider blocks against every TilemapLayer
      // registered in the scene by a TilemapRenderer behavior. Per-tile blocking
      // is set by the renderer via setCollision(solidIndices). Sprites spawned
      // BEFORE the tilemap are wired by TilemapRenderer.init itself.
      if (newHasCollider) {
        // Excluder tags: a sprite with a tag listed in either the tileset's
        // globalExcludedTags or a per-collider excludedTags entry skips the
        // collision (player ghost-passes, projectile-only walls, etc.). The
        // tilemap renderer attaches itself to each TilemapLayer's data, and
        // each per-tile / per-bigtile / per-animated static body carries its
        // own `excludedTags` union via setData.
        const layers = (this.scene.data.get("peaky.tilemapLayers") as Phaser.Tilemaps.TilemapLayer[] | undefined) ?? [];
        for (const layer of layers) {
          const c = this.scene.physics.add.collider(
            newSprite.gameObject,
            layer,
            undefined,
            (spriteGo, tile) => {
              const sp = (spriteGo as Phaser.GameObjects.GameObject).getData?.("peakySprite") as { tags?: Set<string> } | undefined;
              if (!sp?.tags || sp.tags.size === 0) return true;
              const tr = layer.getData?.("tilemapRenderer") as { getExcludedTagsForTile?: (idx: number) => string[] } | undefined;
              const tileIdx = (tile as Phaser.Tilemaps.Tile).index;
              const ex = tr?.getExcludedTagsForTile?.(tileIdx) ?? [];
              for (const t of ex) if (sp.tags.has(t)) return false;
              return true;
            },
          );
          newSprite._colliders.push(c);
        }
        // Custom-shape static body groups (per-tile / bigtile / animated-tile
        // collision rectangles set up by TilemapRenderer). Each body GO carries
        // its own excludedTags array via setData.
        const groups = (this.scene.data.get("peaky.tilemapStaticGroups") as Phaser.Physics.Arcade.StaticGroup[] | undefined) ?? [];
        for (const grp of groups) {
          const c = this.scene.physics.add.collider(
            newSprite.gameObject,
            grp,
            undefined,
            (spriteGo, bodyGo) => {
              const sp = (spriteGo as Phaser.GameObjects.GameObject).getData?.("peakySprite") as { tags?: Set<string> } | undefined;
              if (!sp?.tags || sp.tags.size === 0) return true;
              const ex = (bodyGo as Phaser.GameObjects.GameObject).getData?.("excludedTags") as string[] | undefined;
              if (!ex || ex.length === 0) return true;
              for (const t of ex) if (sp.tags.has(t)) return false;
              return true;
            },
          );
          newSprite._colliders.push(c);
        }
      }
    });
  }
}
