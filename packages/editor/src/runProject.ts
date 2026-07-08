import Phaser from "phaser";
import {
  AIBrain,
  Camera,
  CharacterAnimator,
  CharacterMovement,
  TopdownMovement,
  Collider,
  Damageable,
  DialogueRunner,
  DIALOGUE_KEY,
  DIALOG_BOXES_KEY,
  DialogBoxAssetSpec,
  DialogFlowRunner,
  DIALOG_FLOW_KEY,
  JumpThru,
  Peaky,
  PhaseManager,
  Solid,
  Sprite,
  indexSpriteTags,
  indexSpriteName,
  unindexSpriteTags,
  addSpriteTag,
  applyLayerFXToSprite,
  SpriteRenderer,
  ParticleEmitter,
  SquashStretch,
  Outline,
  Shadow,
  LightSource,
  Weather,
  Text,
  Tracer,
  UIWidgetRenderer,
  Widget,
  Animator,
  Projectile,
  Inventory,
  TilemapRenderer,
  VisionMask,
  MoveTo,
  TiledBackground,
  WeaponSlot,
  Dismemberment,
  GibManager,
  GIB_KEY,
  attachLogicSheet,
  SoundManager,
  SOUND_KEY,
  persistentState,
  takePendingEntry,
  setPendingEntry,
  nextSpawnId,
  getSceneSpawns,
  getSceneTileEdits,
  spawnRuntimeSpriteObject,
  firePlacementContact,
  Logger,
  buildNavGrid,
} from "@peaky/runtime";
import type {
  DialogueAssetSpec,
  EventSpec,
  EventGroupSpec,
  SpriteAnimRuntime,
  LogicSheet as RuntimeLogicSheet,
  Builder,
  PreloadHook,
} from "@peaky/runtime";
import type {
  BehaviorInstance,
  BehaviorKind,
  BlueprintInstance,
  LayerDef,
  PeakyEvent,
  PeakyProject,
  SceneData,
  TilemapInstance,
  UIWidgetInstance,
} from "./project";
import { findBlueprint, tilemapTilesets } from "./project";
import {
  getActiveAssetStore,
  spriteFrameDiskPath,
  soundDiskPath,
  tilesetImagePath,
} from "./AssetStore";

/**
 * Resolve "global layers" into a per-scene effective scene. A layer marked
 * `global` shares its content across every scene (HUD, pause menu, persistent
 * overlays): content is authored ONCE in the SOURCE scene (the first scene, in
 * project order, whose layer of that name is global) and rendered in every
 * scene. Scenes are matched by layer NAME — a same-named layer elsewhere shows
 * the same global content rather than its own copy.
 *
 * Returns a shallow-cloned scene whose `layers` include the global layers and
 * whose `instances` / `uiInstances` carry the source scene's global content
 * (layerIds remapped to this scene's matching layer). Stray content placed on a
 * non-source global layer is dropped (one source wins). When the project has no
 * global layers this is a no-op passthrough.
 */
function buildEffectiveScene(project: PeakyProject, scene: SceneData): SceneData {
  // Source scene + layer def per global layer NAME — first in project order.
  const sourceLayer = new Map<string, LayerDef>();
  const sourceSceneId = new Map<string, string>();
  for (const sc of project.scenes) {
    for (const l of sc.layers) {
      if (l.global && !sourceSceneId.has(l.name)) {
        sourceSceneId.set(l.name, sc.id);
        sourceLayer.set(l.name, l);
      }
    }
  }
  if (sourceSceneId.size === 0) return scene;

  // Effective layers: keep this scene's own; for any global layer this scene
  // doesn't already declare by name, prepend a clone (overlays sit on top).
  const layers: LayerDef[] = [...scene.layers];
  const renderLayerId = new Map<string, string>(); // global name → layer id used here
  for (const [name, srcLayer] of sourceLayer) {
    const own = layers.find((l) => l.name === name);
    if (own) renderLayerId.set(name, own.id);
    else { layers.unshift({ ...srcLayer }); renderLayerId.set(name, srcLayer.id); }
  }

  const layerNameOf = (sc: SceneData, layerId: string | undefined): string | undefined =>
    sc.layers.find((l) => l.id === layerId)?.name;
  const isGlobal = (name: string | undefined): name is string => !!name && sourceSceneId.has(name);
  const ownsHere = (name: string) => sourceSceneId.get(name) === scene.id;

  // Drop this scene's content sitting on a global-named layer it doesn't source.
  const ownBp = scene.instances.filter((inst) => {
    const n = layerNameOf(scene, inst.layerId);
    return !(isGlobal(n) && !ownsHere(n));
  });
  const ownUi = (scene.uiInstances ?? []).filter((inst) => {
    const n = layerNameOf(scene, inst.layerId);
    return !(isGlobal(n) && !ownsHere(n));
  });
  const ownTm = (scene.tilemapInstances ?? []).filter((inst) => {
    const n = layerNameOf(scene, inst.layerId);
    return !(isGlobal(n) && !ownsHere(n));
  });

  // Inject the source scene's content for global layers this scene doesn't
  // source, remapping layerId → this scene's render layer.
  const injBp: BlueprintInstance[] = [];
  const injUi: UIWidgetInstance[] = [];
  const injTm: TilemapInstance[] = [];
  for (const [name, srcSceneId] of sourceSceneId) {
    if (srcSceneId === scene.id) continue;
    const src = project.scenes.find((s) => s.id === srcSceneId);
    if (!src) continue;
    const srcLayerId = sourceLayer.get(name)!.id;
    const targetLayerId = renderLayerId.get(name)!;
    for (const inst of src.instances) {
      if (inst.layerId === srcLayerId) injBp.push({ ...inst, layerId: targetLayerId });
    }
    for (const inst of src.uiInstances ?? []) {
      if (inst.layerId === srcLayerId) injUi.push({ ...inst, layerId: targetLayerId });
    }
    for (const inst of src.tilemapInstances ?? []) {
      if (inst.layerId === srcLayerId) injTm.push({ ...inst, layerId: targetLayerId });
    }
  }

  return {
    ...scene,
    layers,
    instances: [...ownBp, ...injBp],
    uiInstances: [...ownUi, ...injUi],
    tilemapInstances: [...ownTm, ...injTm],
  };
}

/** Editor PeakyEvent → runtime EventSpec. Same shape; recursive for children. */
function toEventSpec(ev: PeakyEvent): EventSpec {
  return {
    id: ev.id,
    kind: ev.kind,
    combinator: ev.combinator,
    conditions: ev.conditions,
    actions: ev.actions,
    children: ev.children.map(toEventSpec),
    groupId: ev.groupId,
    disabled: ev.disabled,
  };
}

/** Editor EventGroupDef → runtime EventGroupSpec. */
function toEventGroupSpec(g: { id: string; name: string; enabled: boolean }): EventGroupSpec {
  return { id: g.id, name: g.name, enabled: g.enabled };
}

const BEHAVIOR_REGISTRY = {
  Solid,
  JumpThru,
  CharacterMovement,
  TopdownMovement,
  SpriteRenderer,
  Collider,
  Text,
  Camera,
  Tracer,
  SquashStretch,
  Outline,
  Shadow,
  LightSource,
  Weather,
  UIWidgetRenderer,
  ParticleEmitter,
  Damageable,
  StateMachine: CharacterAnimator,
  AIBrain,
  PhaseManager,
  Widget,
  SmartTween: Animator,
  Projectile,
  Inventory,
  TilemapRenderer,
  VisionMask,
  MoveTo,
  TiledBackground,
  WeaponSlot,
  Dismemberment,
} as const satisfies Record<BehaviorKind, unknown>;

/** Stable Phaser texture key for a given sprite asset / animation / frame. */
export function frameTextureKey(spriteId: string, animId: string, frameIdx: number): string {
  return `sprite:${spriteId}:${animId}:${frameIdx}`;
}

/** Disk path for a sprite's packed export atlas (one image per sprite holding
 *  all its frames). Kept in sync with the packer in exportGame.ts. */
export function spriteAtlasPath(spriteId: string): string {
  return `assets/__atlas__/sprite-${spriteId}.png`;
}

/** Dangling-sprite warnings already surfaced this session (warn once per id). */
const _warnedMissingSprites = new Set<string>();

/** Resolve a (spriteId, animId, frame) pick into texture keys + animation meta,
 *  the same way item icons resolve. `frame === -1` → all of the animation's
 *  frame keys (played as an animation); otherwise just the one chosen frame.
 *  Empty/missing sprite → empty keys (renderer hides the image). */
function resolveSpriteVisual(
  project: PeakyProject,
  spriteId: string | undefined,
  animId: string | undefined,
  frame: number | undefined,
): { keys: string[]; fps: number; loop: boolean; animated: boolean } {
  const sp = spriteId ? project.sprites.find((s) => s.id === spriteId) : undefined;
  // A non-empty spriteId that resolves to nothing = a dangling reference
  // (the sprite was deleted from the Content Browser). Warn ONCE per id so the
  // author isn't left wondering why a BP renders as a blank body rect.
  if (spriteId && !sp && !_warnedMissingSprites.has(spriteId)) {
    _warnedMissingSprites.add(spriteId);
    Logger.log({
      level: "warn",
      source: "SpriteRenderer",
      message: `References a missing sprite asset (id "${spriteId}") — it was likely deleted from the Content Browser. The object will render with no image.`,
    });
  }
  const anim = sp ? (sp.animations.find((a) => a.id === animId) ?? sp.animations[0]) : undefined;
  if (!sp || !anim) return { keys: [], fps: 8, loop: true, animated: false };
  const animated = frame === -1;
  let keys: string[];
  if (animated) {
    keys = anim.frames.map((f, i) => (f.imageFile ? frameTextureKey(sp.id, anim.id, i) : "")).filter(Boolean);
  } else {
    const idx = Math.max(0, frame ?? 0);
    const f = anim.frames[idx] ?? anim.frames[0];
    keys = f?.imageFile ? [frameTextureKey(sp.id, anim.id, anim.frames.indexOf(f))] : [];
  }
  return { keys, fps: anim.fps ?? 8, loop: anim.loop ?? true, animated };
}

/**
 * Walks the scene's instances, collects every SpriteRenderer's referenced
 * Sprite asset, and queues each frame's data-URL into Phaser's loader so the
 * textures are ready by `create()`.  Returns a `PreloadHook` to pass to
 * `Peaky.start`.
 */
/** Builds a Phaser-preload hook for the given scene + project. Exported so
 *  the loading-screen orchestration in ScenePanel can warm a target scene's
 *  assets onto the LIVE loading scene's Phaser scene, fire OnLoadProgress /
 *  OnLoadComplete signals as the loader chews through them, then boot the
 *  target scene against an already-warm texture cache. */
export function buildSpritePreload(project: PeakyProject, scene: SceneData) {
  const ids = new Set<string>();
  // Preload sprite assets referenced by EVERY blueprint in the project
  // (not just scene-placed ones) so runtime-spawned BPs from
  // CreateObject / CreateObjectByName actions render with art instead
  // of falling back to the colored body rect. Scene-placed BPs are
  // a strict subset, so this is the right superset to load.
  for (const bp of project.blueprints) {
    for (const b of bp.behaviors) {
      if (b.kind === "SpriteRenderer") {
        const id = String(b.config.spriteId ?? "");
        if (id) ids.add(id);
      } else if (b.kind === "ParticleEmitter") {
        // Particle emitters use a Sprite asset's first frame (and
        // optionally all frames for `frameMode: "random"`) as their
        // texture. Without queueing it for preload here, the emitter
        // attaches before the texture exists and falls back silently to
        // Phaser's `__DEFAULT` placeholder, looking like "the chosen
        // sprite is being ignored".
        const id = String(b.config.spriteId ?? "");
        if (id) ids.add(id);
      } else if (b.kind === "TiledBackground") {
        // TileSprite reads the texture at construction time; missing it
        // here would mean the first-tick init falls back to __WHITE even
        // though the author picked a sprite.
        const id = String(b.config.spriteId ?? "");
        if (id) ids.add(id);
      } else if (b.kind === "WeaponSlot") {
        // Weapon sprite — preload its frames so the overlay has textures
        // ready on first tick. Empty = unequipped (skip).
        const id = String(b.config.spriteId ?? "");
        if (id) ids.add(id);
      }
    }
  }
  // Touch `scene` so the param stays meaningful for future
  // scene-specific preload trimming and the linter doesn't flag it.
  void scene;
  // UI Widget instances of kind "Image" reference a sprite asset via
  // widget.spriteId — preload those frames too so the runtime renderer
  // can resolve the texture key on init(). Multi-mode widgets also
  // contribute via their `children`, each of which can be an Image
  // kind with its own spriteId.
  for (const inst of scene.uiInstances ?? []) {
    const widget = project.uiWidgets.find((w) => w.id === inst.uiWidgetId);
    if (!widget) continue;
    if (widget.kind === "Image" && widget.spriteId) {
      ids.add(widget.spriteId);
    }
    for (const child of widget.children ?? []) {
      if (child.kind === "Image" && child.spriteId) {
        ids.add(child.spriteId);
      }
    }
  }
  // Every project sprite, fully — so the SetSprite action can swap a
  // SpriteRenderer to any asset (with all its animation frames) at runtime,
  // and SetUIElement can swap an Image to any sprite. Bounded by project size.
  for (const asset of project.sprites) ids.add(asset.id);
  // Folder mode: pre-resolve every referenced asset's disk path to a blob URL
  // via the active AssetStore so the Phaser preload hook can synchronously
  // queue them via load.image/load.audio. The hook itself stays sync because
  // Phaser's preload contract is synchronous; the async pre-warm happens
  // before runScene starts the Phaser game (`buildSpritePreload` returns
  // the pre-warmed hook).
  const store = getActiveAssetStore();
  return async (): Promise<(phaserScene: Phaser.Scene) => void> => {
    // 1) Collect every asset path we'll need.
    type SpriteRef = { spriteId: string; animId: string; idx: number; path: string };
    const spriteRefs: SpriteRef[] = [];
    for (const sprId of ids) {
      const asset = project.sprites.find((s) => s.id === sprId);
      if (!asset) continue;
      for (const anim of asset.animations) {
        anim.frames.forEach((frame, idx) => {
          if (!frame.imageFile) return;
          spriteRefs.push({
            spriteId: asset.id, animId: anim.id, idx,
            path: spriteFrameDiskPath(asset, frame.imageFile),
          });
        });
      }
    }
    type SoundRef = { id: string; path: string };
    const soundRefs: SoundRef[] = [];
    for (const snd of project.sounds ?? []) {
      if (!snd.file) continue;
      soundRefs.push({ id: snd.id, path: soundDiskPath(snd) });
    }
    type TilesetRef = { id: string; path: string };
    const tilesetRefs: TilesetRef[] = [];
    const usedTilesetIds = new Set<string>();
    for (const ti of scene.tilemapInstances ?? []) {
      const map = (project.tilemaps ?? []).find((m) => m.id === ti.tilemapId);
      if (!map) continue;
      // Every tileset the map paints from (primary + extras), so a multi-
      // tileset map preloads all of its atlases, not just the primary.
      for (const slot of tilemapTilesets(map, project.tilesets ?? [])) usedTilesetIds.add(slot.ts.id);
    }
    for (const tsId of usedTilesetIds) {
      const ts = (project.tilesets ?? []).find((t) => t.id === tsId);
      if (!ts?.imageFile) continue;
      tilesetRefs.push({ id: ts.id, path: tilesetImagePath(ts) });
    }
    // 2) Warm the AssetStore cache for every path in parallel.
    if (store) {
      await store.preload([
        ...spriteRefs.map((r) => r.path),
        ...soundRefs.map((r) => r.path),
        ...tilesetRefs.map((r) => r.path),
      ]);
    }
    // 3) Return the actual Phaser preload hook that consumes the cached URLs.
    //    Standalone exports: when no AssetStore is present, fall back to the
    //    raw relative path (e.g. "assets/Sprites/Player/idle_0.png") which
    //    Phaser's loader fetches over HTTP relative to the page's location.
    //    This is what lets an exported game work without the editor's
    //    folder-mode FS in the loop.
    const standaloneBase = (globalThis as Record<string, unknown>)["__peakyAssetsBaseUrl"] as string | undefined;
    const assetMap = (globalThis as Record<string, unknown>)["__peakyAssetMap"] as Record<string, string> | undefined;
    const resolveStandaloneUrl = (path: string): string => {
      // The exported HTML inlines every asset as a base64 data URL keyed
      // by its disk path. When present, we return that directly — no
      // HTTP fetch, no CORS, works on file:// double-click and on any
      // hosted environment alike. This is what makes the export
      // self-contained (single file or zipped folder).
      if (assetMap && typeof assetMap[path] === "string") return assetMap[path];
      // Otherwise fall back to a relative URL under assetsBaseUrl, for
      // dev / hosting scenarios where assets live as loose files.
      if (standaloneBase === undefined) return path;
      const trimmed = path.replace(/^assets\/?/, "");
      const sep = standaloneBase.endsWith("/") ? "" : "/";
      return `${standaloneBase}${sep}${trimmed}`;
    };
    // Exported games ship one PACKED ATLAS image per sprite (all its frames)
    // instead of N loose frame PNGs. The HTML inlines a frame map global; when
    // present (and no editor AssetStore), load each atlas once and slice it
    // into per-frame textures keyed by frameTextureKey — so SpriteRenderer and
    // everything downstream stay byte-for-byte identical to the per-frame path.
    const atlasFrames = (globalThis as Record<string, unknown>)["__peakySpriteAtlasFrames"] as
      Record<string, { a: string; x: number; y: number; w: number; h: number }> | undefined;
    const atlasMode = !store && !!atlasFrames && Object.keys(atlasFrames).length > 0;
    return (phaserScene: Phaser.Scene) => {
      if (atlasMode && atlasFrames) {
        const atlasKeyFor = (p: string) => `atlasimg:${p}`;
        const atlasPaths = new Set<string>();
        for (const fk in atlasFrames) atlasPaths.add(atlasFrames[fk].a);
        for (const p of atlasPaths) {
          const key = atlasKeyFor(p);
          if (phaserScene.textures.exists(key)) continue;
          const url = resolveStandaloneUrl(p);
          if (url) phaserScene.load.image(key, url);
        }
        phaserScene.load.once("complete", () => {
          for (const fk in atlasFrames) {
            if (phaserScene.textures.exists(fk)) continue;
            const r = atlasFrames[fk];
            const atlasTex = phaserScene.textures.get(atlasKeyFor(r.a));
            const src = atlasTex && atlasTex.getSourceImage();
            if (!src) continue;
            const tex = phaserScene.textures.addImage(fk, src as HTMLImageElement);
            if (tex) {
              const base = tex.get("__BASE");
              base.setSize(r.w, r.h, r.x, r.y);
              base.updateUVs();
            }
          }
        });
      } else {
        for (const r of spriteRefs) {
          const key = frameTextureKey(r.spriteId, r.animId, r.idx);
          if (phaserScene.textures.exists(key)) continue;
          const url = store ? store.getCachedURL(r.path) : resolveStandaloneUrl(r.path);
          if (url) phaserScene.load.image(key, url);
        }
      }
      for (const r of soundRefs) {
        const key = `sound:${r.id}`;
        if (phaserScene.cache.audio.exists(key)) continue;
        const url = store ? store.getCachedURL(r.path) : resolveStandaloneUrl(r.path);
        if (url) phaserScene.load.audio(key, url);
      }
      for (const r of tilesetRefs) {
        const key = `tileset:${r.id}`;
        if (phaserScene.textures.exists(key)) continue;
        const url = store ? store.getCachedURL(r.path) : resolveStandaloneUrl(r.path);
        if (url) phaserScene.load.image(key, url);
      }
    };
  };
}

/** Build the runtime SpriteRenderer config (animation table + sprite size).
 *  `scaleX` / `scaleY` apply a per-instance size override — every render
 *  dimension (sprite w/h, frame w/h, image-point coords) gets multiplied
 *  so the instance scales as a whole instead of just its physics body. */
function buildSpriteRendererConfig(
  b: BehaviorInstance,
  project: PeakyProject,
  scaleX = 1,
  scaleY = 1,
): Record<string, unknown> {
  const id = String(b.config.spriteId ?? "");
  const asset = project.sprites.find((s) => s.id === id);
  if (!asset) return { ...b.config };
  const anims: Record<string, SpriteAnimRuntime> = {};
  for (const anim of asset.animations) {
    const frames = anim.frames.map((f, i) => ({
      textureKey: f.imageFile ? frameTextureKey(asset.id, anim.id, i) : undefined,
      color: f.color,
      // Construct-style per-frame data: each frame has its own pixel size
      // and pivot ("hotspot"). The runtime's SpriteRenderer renders at
      // these dimensions and anchors the pivot pixel to sprite.x/y, so
      // cropping a frame can never affect any other frame or anim.
      w: (f.imageW ?? asset.width)  * scaleX,
      h: (f.imageH ?? asset.height) * scaleY,
      pivotX: f.pivotX !== undefined ? f.pivotX * scaleX : undefined,
      pivotY: f.pivotY !== undefined ? f.pivotY * scaleY : undefined,
      // Named image points carry through so behaviors (Tracer, future
      // pinning systems) can look them up by name. Strip the editor-only
      // `id` field — runtime only needs name + coords.
      points: (f.points ?? []).map((p) => ({ name: p.name, x: p.x * scaleX, y: p.y * scaleY })),
      // Per-frame collider, scaled into display px like w/h so the Collider's
      // "Use Frame Collider" path gets the right body size for this instance.
      collider: f.collider
        ? { enabled: f.collider.enabled, width: f.collider.width * scaleX, height: f.collider.height * scaleY, offsetX: f.collider.offsetX * scaleX, offsetY: f.collider.offsetY * scaleY }
        : undefined,
    }));
    anims[anim.name] = { frames, fps: anim.fps, loop: anim.loop };
  }
  return {
    ...b.config,
    currentAnimation:
      String(b.config.currentAnimation ?? "") || asset.animations[0]?.name || "",
    _animations: anims,
    _spriteW: asset.width  * scaleX,
    _spriteH: asset.height * scaleY,
    // The per-instance size override baked into frame w/h/pivot above. Exposed
    // so behaviors that author against the RAW (unscaled) frame — e.g.
    // Dismemberment regions, drawn in the BP preview's raw pixel space — can
    // recover raw coords and re-apply the true display scale.
    _renderScaleX: scaleX,
    _renderScaleY: scaleY,
  };
}

/**
 * Resolves each instance against its blueprint, spawns it into a live Peaky
 * game, then walks every blueprint's events to register Phaser overlap /
 * collision callbacks for tag-based triggers.
 *
 * Overlap/collision callbacks emit internal events (`_overlap:<tag>` /
 * `_collide:<tag>`) on the sprite's EventBus; the per-event runner on
 * Sprite peeks those when matching `OnOverlap` / `OnCollide` triggers.
 */
/** Build the `{ build, preload }` for one scene. Shared by the initial boot
 *  (`runScene` → fresh game) and in-place transitions (`buildSceneOn` → restart
 *  on the existing game — textures kept, fast). `parent` is the DOM container the
 *  builder dispatches `peaky:sceneReady` on. Returns the effective (global-layer-
 *  merged) scene so the boot path can size the Peaky from it. */
async function makeSceneBuilder(project: PeakyProject, scene: SceneData, parent: HTMLElement): Promise<{ build: Builder; preload: PreloadHook; effectiveScene: SceneData }> {
  // Fold in shared global-layer content so the builder treats the merged result
  // as the scene to build (layers + instances + UI instances).
  scene = buildEffectiveScene(project, scene);
  const build: Builder = (g) => {
    // Audio — create the SoundManager early (before any sprite spawns, so an
    // OnCreate → PlaySound fires correctly) and register it on scene.data
    // for the PlayMusic / PlaySound action handlers to find. Audio data is
    // already queued by buildSpritePreload's audio pass.
    const soundScene = g.getScene();
    if (soundScene) {
      soundScene.data.set(SOUND_KEY, new SoundManager(soundScene, (project.sounds ?? []).map((s) => ({
        id: s.id, name: s.name, kind: s.kind, volume: s.volume, loop: s.loop,
        maxInstances: s.maxInstances, minIntervalMs: s.minIntervalMs,
      }))));
    }
    // Layer name↔id maps — set on the live scene UNCONDITIONALLY (independent
    // of any sprite spawning), so SetScreenEffect target=layer (applyLayerFX)
    // and VisionMask cutoutLayers can always resolve a layer name. They used to
    // be set only inside the spawned[0]-gated registry block, so a scene whose
    // build path yielded no spawned[0] left the maps unset and every layer
    // effect silently no-op'd ("no idByName map").
    {
      const layerScene = g.getScene();
      if (layerScene) {
        const idByName: Record<string, string> = {};
        for (const L of scene.layers) idByName[L.name] = L.id;
        layerScene.data.set("peaky.layerIdByName", idByName);
        layerScene.data.set("peaky.layerIdToName", new Map(scene.layers.map((L) => [L.id, L.name])));
        // SaveSlot/LoadSlot namespace — derived from the project name so two
        // published games on the SAME origin don't read/write each other's
        // `peaky.save.*` keys (data loss). Both the editor Play path and the
        // exported standalone boot run through here (standalonePlayer reuses
        // runScene), so one place covers both.
        const saveNs = (project.name || "game").replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase() || "game";
        layerScene.data.set("peaky.saveNamespace", saveNs);
        // Bake the painted nav mesh into an A*-ready grid (walkable − obstacles).
        if (scene.navMesh && scene.navMesh.walkable.length > 0) {
          layerScene.data.set("peaky.navGrid", buildNavGrid(scene.navMesh));
          if (scene.navMesh.debug) layerScene.data.set("peaky.navDebug", true);
        }
        // Painted shelter mask → weather reads it (O(1) cell lookup). Independent
        // of the nav grid — a scene can have shelter with no walkable paint.
        if (scene.navMesh?.shelter && scene.navMesh.shelter.some((v) => v)) {
          const nm = scene.navMesh;
          layerScene.data.set("peaky.shelterMask", { cols: nm.cols, rows: nm.rows, cellSize: nm.cellSize, cells: nm.shelter });
        }
      }
    }
    // Pass 1: instantiate every placement so all sprites exist before we wire
    // tag-based callbacks (we need to know all candidates per tag).
    const spawned: Array<{ sprite: Sprite; tags: string[]; bpId: string }> = [];

    // Pre-compute, once per BP, which tags its OnCollide / OnOverlap event
    // sheets care about. Used by `wireCollisionsFor()` to register
    // tag-based pairs when a sprite spawns — including AFTER scene boot
    // via the `peaky.spawn` runtime path. Without this map, runtime-
    // spawned BPs never register collision callbacks (the legacy pass-2
    // loop only ran once at boot for `spawned[]`, so CreateObject'd
    // sprites silently dropped every OnCollide / OnOverlap forever).
    const bpCollideTags = new Map<string, Set<string>>();
    const bpOverlapTags = new Map<string, Set<string>>();
    // Construct's "On collision with another object" parity: each BP
    // also tracks WHICH OTHER BPs its OnCollide / OnOverlap conditions
    // want to fire against (the new `targetBpId` field on Condition).
    // wireCollisionsFor() registers per-bpId pair callbacks alongside
    // the per-tag ones, emitting `_collide:bp:<id>` / `_overlap:bp:<id>`.
    const bpCollideBpIds = new Map<string, Set<string>>();
    const bpOverlapBpIds = new Map<string, Set<string>>();
    {
      const visit = (
        ev: PeakyEvent,
        collide: Set<string>, overlap: Set<string>,
        collideBp: Set<string>, overlapBp: Set<string>,
      ): void => {
        for (const c of ev.conditions) {
          const kind = c.kind as string;
          if (kind === "OnCollide") {
            for (const t of c.tags ?? []) if (t) collide.add(t);
            if (c.targetBpId) collideBp.add(c.targetBpId);
          }
          if (kind === "OnOverlap") {
            for (const t of c.tags ?? []) if (t) overlap.add(t);
            if (c.targetBpId) overlapBp.add(c.targetBpId);
          }
        }
        for (const child of ev.children) visit(child, collide, overlap, collideBp, overlapBp);
      };
      for (const bp of project.blueprints) {
        const collide = new Set<string>();
        const overlap = new Set<string>();
        const collideBp = new Set<string>();
        const overlapBp = new Set<string>();
        for (const ev of bp.events) visit(ev, collide, overlap, collideBp, overlapBp);
        bpCollideTags.set(bp.id, collide);
        bpOverlapTags.set(bp.id, overlap);
        bpCollideBpIds.set(bp.id, collideBp);
        bpOverlapBpIds.set(bp.id, overlapBp);
      }
      // Main Sheet conditions: each `OnCollide` / `OnOverlap` with
      // `subject: bp:X` is semantically "X collides with target". To
      // wire it correctly we propagate the (target tag / target bp) into
      // X's per-BP collide map so `wireCollisionsFor` registers a Phaser
      // pair between LIVE X SPRITES (not the bodyless world host) and
      // the target. The Main Sheet's trigger redirect in evalOneCondition
      // then iterates X instances and reads each one's events bus.
      const mergeInto = (map: Map<string, Set<string>>, key: string, items: Iterable<string>) => {
        let s = map.get(key);
        if (!s) { s = new Set<string>(); map.set(key, s); }
        for (const it of items) s.add(it);
      };
      const visitMain = (ev: PeakyEvent): void => {
        for (const c of ev.conditions) {
          const kind = c.kind as string;
          const subjectBpId = c.subject?.kind === "bp" ? c.subject.bpId : undefined;
          if (kind === "OnCollide" && subjectBpId) {
            for (const t of c.tags ?? []) if (t) mergeInto(bpCollideTags, subjectBpId, [t]);
            if (c.targetBpId) mergeInto(bpCollideBpIds, subjectBpId, [c.targetBpId]);
          }
          if (kind === "OnOverlap" && subjectBpId) {
            for (const t of c.tags ?? []) if (t) mergeInto(bpOverlapTags, subjectBpId, [t]);
            if (c.targetBpId) mergeInto(bpOverlapBpIds, subjectBpId, [c.targetBpId]);
          }
        }
        for (const child of ev.children) visitMain(child);
      };
      for (const ev of scene.mainEvents ?? []) visitMain(ev);
    }

    /**
     * Register tag-based overlap / collide callbacks between `sprite` and
     * every other LIVE sprite — both directions, so each pair is wired
     * exactly once regardless of which side is the listener. Called from
     * `spawnFromBlueprint` after a sprite is fully attached, so initial
     * scene placements AND runtime CreateObject spawns both participate.
     *
     * The callback fires `_collide:<tag>` / `_overlap:<tag>` on the
     * LISTENING sprite (the one whose event sheet declared the tag).
     * Phaser cleans up the registered handlers automatically when either
     * GameObject is destroyed.
     */
    const wireCollisionsFor = (sprite: Sprite, bpId: string): void => {
      const phaserScene = sprite.scene;
      if (!phaserScene) return;
      // Short-circuit for sprites that opted out of pair-based collision
      // wiring. Their OnCollide / OnOverlap events fire via the per-frame
      // CollisionScan (asymmetric tag-exception path) — not via Phaser's
      // individual pair colliders. The pair-wiring is O(N) per spawn, so
      // spawning N swarm sprites in one frame costs O(N²) — exactly the
      // freeze users hit at scene start (~2.3s for 1500 NPCs).
      // Behavior chips (Collider, Solid, JumpThru) still work — they
      // affect body shape / static-ness, not this pair-callback wiring.
      if ((sprite as unknown as { skipCollisionScan?: boolean }).skipCollisionScan) {
        return;
      }
      const myCollide = bpCollideTags.get(bpId) ?? new Set<string>();
      const myOverlap = bpOverlapTags.get(bpId) ?? new Set<string>();
      const myCollideBp = bpCollideBpIds.get(bpId) ?? new Set<string>();
      const myOverlapBp = bpOverlapBpIds.get(bpId) ?? new Set<string>();
      const live = (phaserScene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      // Guard against orphan Sprite wrappers: a sprite might have its
      // `destroyed` flag still false (Phaser tore down the GameObject
      // without our destroy() being called — happens during a scene
      // restart). Calling `physics.add.collider` with a dead GameObject
      // throws and aborts the spawn loop, which is what was breaking
      // controls after RestartLayout. Treat a missing/disabled body as
      // "skip this pair" — no collider needed for it anyway.
      const isLive = (s: Sprite): boolean => !s.destroyed && !!s.gameObject && !!(s.gameObject as { active?: boolean }).active;
      if (!isLive(sprite)) return;
      for (const other of live) {
        if (other === sprite || other.destroyed) continue;
        if (!isLive(other)) continue;
        // Direction A: I listen for tags carried by `other`, AND for
        // `other`'s blueprintId via the new targetBpId path.
        // Picking: every collide/overlap fire stamps the OTHER sprite as
        // `peaky.picked` on the listener's scene so the next action in
        // the chain can target exactly the thing that just hit us.
        // Helper: stamp the OTHER sprite as the per-listener collide
        // partner so the trigger redirect in evalOneCondition can recover
        // it and populate pickedSets[other.bpId] for plural SOL fan-out.
        // Without this, `OnCollide subject=Player target=Coin → Destroy(Coin)`
        // falls back to "all live Coins" because pickedSets[Coin] is empty.
        const stampPartner = (listener: Sprite, partner: Sprite) => {
          listener.scene.data.set("peaky.picked", partner);
          let map = listener.scene.data.get("peaky.collidePartners") as Map<number, Sprite> | undefined;
          if (!map) { map = new Map(); listener.scene.data.set("peaky.collidePartners", map); }
          map.set(listener.uid, partner);
        };
        // Determine ALL collide / overlap signals to emit for this pair,
        // from BOTH directions, BEFORE registering any Phaser callback.
        // Then register ONE collider (and ONE overlap) per pair with a
        // single callback that emits every applicable signal.
        //
        // Why: when sprite listens for other AND other listens for sprite,
        // we used to call `physics.add.collider` twice for the same pair.
        // Phaser keeps only one effective collider per pair, so the second
        // direction's callback never fired — meaning if both BPs had
        // OnCollide handlers (e.g. "Coin: destroy on Player" + "Player:
        // destroy on Coin"), only the FIRST registered handler ran.
        // Consolidating into one callback fixes that asymmetry.
        const otherCollide = other.blueprintId ? bpCollideTags.get(other.blueprintId) : undefined;
        const otherOverlap = other.blueprintId ? bpOverlapTags.get(other.blueprintId) : undefined;
        const otherCollideBp = other.blueprintId ? bpCollideBpIds.get(other.blueprintId) : undefined;
        const otherOverlapBp = other.blueprintId ? bpOverlapBpIds.get(other.blueprintId) : undefined;

        // Build emit list for collide direction A (sprite hears about other).
        const aCollideSignals: string[] = [];
        for (const tag of myCollide) {
          if (other.tags.has(tag)) aCollideSignals.push(`_collide:${tag}`);
        }
        if (other.blueprintId && myCollideBp.has(other.blueprintId)) {
          aCollideSignals.push(`_collide:bp:${other.blueprintId}`);
        }
        // Direction B (other hears about sprite).
        const bCollideSignals: string[] = [];
        if (otherCollide) {
          for (const tag of otherCollide) {
            if (sprite.tags.has(tag)) bCollideSignals.push(`_collide:${tag}`);
          }
        }
        if (otherCollideBp && otherCollideBp.has(bpId)) {
          bCollideSignals.push(`_collide:bp:${bpId}`);
        }

        // Build overlap signal lists too — when passThrough is on (default),
        // a single physics.add.overlap registration emits BOTH `_collide:`
        // AND `_overlap:` signals so OnCollide and OnOverlap conditions
        // both fire without bodies physically blocking. When passThrough
        // is off on either side, we register physics.add.collider instead
        // (Phaser resolves penetration), and still emit both signals so
        // events that listen for either work.
        const aOverlapSignals: string[] = [];
        for (const tag of myOverlap) {
          if (other.tags.has(tag)) aOverlapSignals.push(`_overlap:${tag}`);
        }
        if (other.blueprintId && myOverlapBp.has(other.blueprintId)) {
          aOverlapSignals.push(`_overlap:bp:${other.blueprintId}`);
        }
        const bOverlapSignals: string[] = [];
        if (otherOverlap) {
          for (const tag of otherOverlap) {
            if (sprite.tags.has(tag)) bOverlapSignals.push(`_overlap:${tag}`);
          }
        }
        if (otherOverlapBp && otherOverlapBp.has(bpId)) {
          bOverlapSignals.push(`_overlap:bp:${bpId}`);
        }

        const allASignals = [...aCollideSignals, ...aOverlapSignals];
        const allBSignals = [...bCollideSignals, ...bOverlapSignals];
        if (allASignals.length > 0 || allBSignals.length > 0) {
          // Pass-through decision: default ON (Collider = trigger / body
          // shape, doesn't block). Either side flagging passThrough=0
          // forces the pair to physics.add.collider so penetrations are
          // resolved (one body becomes effectively solid against the
          // other). Solid behavior remains the "always blocks" path
          // handled separately by Game.registerCollisions.
          const myCol = sprite.findBehaviorByKind("Collider") as { passThrough?: number } | undefined;
          const otherCol = other.findBehaviorByKind("Collider") as { passThrough?: number } | undefined;
          const myPass = myCol ? (myCol.passThrough ?? 1) !== 0 : true;
          const otherPass = otherCol ? (otherCol.passThrough ?? 1) !== 0 : true;
          const usePassThrough = myPass && otherPass;
          const handler = (): void => {
            // EDGE-ONLY: only emit on the FRAME the bodies first contact.
            // Phaser fires the callback every frame they overlap; without
            // this gate, AddVar would tick once per frame of contact and
            // double-count pickups. Tracker is keyed by sorted pair-uid
            // and stores last-fired frame; skip if last fired was the
            // previous frame too (= continuous contact, no fresh edge).
            const tracker = ((): Map<string, number> => {
              let m = phaserScene.data.get("peaky.collideTracker") as Map<string, number> | undefined;
              if (!m) { m = new Map(); phaserScene.data.set("peaky.collideTracker", m); }
              return m;
            })();
            const frame = phaserScene.game.loop.frame;
            const key = sprite.uid < other.uid
              ? `${sprite.uid}|${other.uid}`
              : `${other.uid}|${sprite.uid}`;
            const last = tracker.get(key);
            tracker.set(key, frame);
            if (last !== undefined && last >= frame - 1) return;
            if (!sprite.destroyed && allASignals.length > 0) {
              stampPartner(sprite, other);
              for (const sig of allASignals) sprite.events.emit(sig);
            }
            if (!other.destroyed && allBSignals.length > 0) {
              stampPartner(other, sprite);
              for (const sig of allBSignals) other.events.emit(sig);
            }
          };
          // Track the handle on BOTH sprites so it's removed from the physics
          // world when either is destroyed (else it leaks + keeps being
          // processed every step for the scene's whole life).
          const coll = usePassThrough
            ? phaserScene.physics.add.overlap(sprite.gameObject, other.gameObject, handler)
            : phaserScene.physics.add.collider(sprite.gameObject, other.gameObject, handler);
          sprite._colliders.push(coll);
          other._colliders.push(coll);
        }
      }
    };

    // Render-order constants. Each layer occupies a 1,000,000-unit band;
    // within a layer, each per-instance `z` step bumps depth by 1000 so
    // overlay offsets (SpriteRenderer +1, Text +2, Tracer +5, UIWidget
    // dropdown +100) stay nested under their host. Net: 1000 distinct
    // user-visible z buckets per layer with full overlay headroom in each.
    const LAYER_DEPTH_STEP = 1_000_000;
    const Z_STEP = 1000;
    /** Per-Z-unit parallax modifier. Construct-style: Z represents distance
     *  from the camera, so per-instance Z drives BOTH render order (via
     *  depth band) AND scroll speed (via this multiplier on top of the
     *  layer's parallax). Positive Z = closer to viewer = scrolls faster;
     *  negative Z = further = scrolls slower. 0.01 per unit gives a
     *  comfortable spread: z=±100 → ±100% modifier (2x or 0x scroll). */
    const Z_PARALLAX_PER_UNIT = 0.01;
    /** Translate an instance's Z to a parallax multiplier (clamped ≥ 0 so
     *  extreme negative Z doesn't invert scroll direction). Z=0 → 1
     *  (layer's parallax used as-is). */
    const zParallaxMult = (z: number): number => Math.max(0, 1 + z * Z_PARALLAX_PER_UNIT);
    /** Compute a layer's render-order base depth. Top of the list draws on
        top → highest depth value. */
    const layerBaseDepth = (layerIdx: number): number =>
      (scene.layers.length - 1 - layerIdx) * LAYER_DEPTH_STEP;
    /** Resolve a layerId to its layer + index in the scene.layers list. */
    const resolveLayer = (layerId: string | undefined) => {
      if (layerId) {
        const idx = scene.layers.findIndex((l) => l.id === layerId);
        if (idx >= 0) return { layer: scene.layers[idx], idx };
      }
      // Fall back to the active layer, then the first one.
      const fallbackIdx = scene.layers.findIndex((l) => l.id === scene.activeLayerId);
      const idx = fallbackIdx >= 0 ? fallbackIdx : 0;
      return { layer: scene.layers[idx], idx };
    };

    /** Spawn a single instance from a Blueprint at (x, y). Used by both the
        initial scene placements (Pass 1) AND the runtime CreateObject action.
        `instW` / `instH`, when provided, override the BP's body size and
        scale every visual the BP produces (SpriteRenderer overlay, frame
        sizes, image-point offsets) by the same ratio.
        `instVars`, when provided, overrides per-variable starting values
        on top of the BP's defaults — used when a placement in the scene
        editor sets per-instance values via the Instance Inspector. */
    /** Reactivate a pooled sprite at (x, y). The sprite was previously
     *  deactivated by destroy() (which pushed it into the pool). Most
     *  per-instance state needs re-seeding: position, vars to defaults,
     *  Damageable hp, behavior `enabled` flags, animation, body enable.
     *  Tag index re-entry. Emit OnCreate so author scripts re-fire. */
    const reactivatePooledSprite = (
      sprite: Sprite,
      x: number,
      y: number,
      layerId: string | undefined,
      instVars: Record<string, number | string | boolean> | undefined,
      animation?: string,
      frame?: number,
    ): void => {
      const bp = findBlueprint(project, sprite.blueprintId ?? "");
      sprite._pooled = false;
      sprite._destroying = false;
      // Reactivate gameObject + body, and restore the overlays hidden at pool
      // time (mirror of deactivateToPool's setCullHidden(true)).
      sprite.gameObject.setActive(true);
      sprite.setCullHidden(false);
      sprite.gameObject.setVisible(true);
      if (sprite.body) {
        sprite.body.enable = true;
        sprite.body.moves = true;
        sprite.body.setVelocity(0, 0);
      }
      // Reposition.
      sprite.gameObject.setPosition(x, y);
      if (sprite.body) sprite.body.reset(x, y);
      // Re-add to tag index (was removed at deactivate time).
      indexSpriteTags(sprite.scene, sprite);
      indexSpriteName(sprite.scene, sprite);
      // Reseed per-instance vars from BP defaults + overrides.
      if (bp) {
        for (const v of bp.variables) {
          if (v.global) continue;
          const override = instVars?.[v.name];
          sprite.vars.set(v.name, override !== undefined ? override : v.default);
        }
      }
      // Reset per-event state so OnCreate/OnceWhileTrue/etc. fire again.
      // Reuses the same routine destroy() calls for runtime-state wipe.
      sprite.clearRuntimeState();
      // Behavior-internal runtime state (CharacterMovement jump/dash counters,
      // CharacterAnimator active state, …) — clearRuntimeState doesn't touch
      // these, so without resetForPool a reused enemy respawns mid-dash or
      // stuck in its death state.
      sprite.resetBehaviorsForPool();
      // Reset Damageable hp (most common state).
      const dmg = sprite.findBehaviorByKind("Damageable") as
        | { hp: number; maxHp: number; isDead?: boolean; iframesUntilSec?: number; hitstunUntilSec?: number }
        | undefined;
      if (dmg) {
        dmg.hp = dmg.maxHp;
        if ("isDead" in dmg) dmg.isDead = false;
        if ("iframesUntilSec" in dmg) dmg.iframesUntilSec = 0;
        if ("hitstunUntilSec" in dmg) dmg.hitstunUntilSec = 0;
      }
      // Reset MoveTo to its default state — clear target + arrival.
      const mt = sprite.findBehaviorByKind("MoveTo") as
        | { _target: unknown; _arrivedFor: unknown; enabled: boolean }
        | undefined;
      if (mt) {
        mt._target = null;
        mt._arrivedFor = null;
        mt.enabled = true;
      }
      // SpriteRenderer — restart its initial animation.
      const sr = sprite.findBehaviorByKind("SpriteRenderer") as
        | { initialAnimation?: string; currentAnimation: string; playing: number; currentFrameIdx?: number; lastAnimName?: string; _startFrame?: number; frame?: number }
        | undefined;
      if (sr) {
        // Honor the Drop node's per-spawn animation / frame on reused pooled
        // sprites too (the non-pooled path already does via spawnFromBlueprint).
        const dropAnim = animation || sr.initialAnimation || sr.currentAnimation;
        sr.currentAnimation = dropAnim;
        if (typeof frame === "number" && frame >= 0) {
          // Static pose: pause on the chosen frame. `frame` is the picker the
          // SR holds on when playing=0; keep lastAnimName === currentAnimation
          // so update()'s anim-switch reset can't snap it to 0.
          sr.frame = frame;
          sr._startFrame = frame;
          sr.currentFrameIdx = frame;
          sr.playing = 0;
          sr.lastAnimName = dropAnim;
        } else {
          sr.frame = 0;
          sr.currentFrameIdx = 0;
          sr.playing = 1;
          sr.lastAnimName = "";
        }
      }
      // Layer / depth reset if the layer changed.
      if (layerId !== undefined && sprite.layerId !== layerId) {
        sprite.layerId = layerId;
      }
      // Re-emit OnCreate so author event-sheet triggers re-fire (it's
      // a fresh "spawn" from the author's POV).
      sprite.events.emit("OnCreate");
    };

    /** Deactivate a sprite into the pool. Inverse of reactivatePooledSprite.
     *  Called by Sprite.destroy when the BP has poolSize > 0. */
    const deactivateToPool = (sprite: Sprite): boolean => {
      const bpId = sprite.blueprintId;
      if (!bpId) return false;
      const poolMap = (sceneForRegistry?.data.get("peaky.spritePool") as Map<string, Sprite[]> | undefined);
      if (!poolMap) return false;
      const pool = poolMap.get(bpId);
      if (!pool) return false; // BP isn't pooled
      // Deactivate visuals + physics. Sprite stays in peaky.sprites so the
      // tick loop iterates it, but Sprite.tick early-returns on _pooled.
      sprite._pooled = true;
      // Hide the HOST *and* every overlay (SpriteRenderer image, Text, …).
      // Hiding only the host rect left a sprite-rendered BP (e.g. a pooled
      // projectile) with its visible art frozen on screen after destroy()
      // pooled it — `_pooled` halts the tick so syncOverlay can't move it
      // either, so it looked like "the bullet stopped but wasn't destroyed".
      sprite.setCullHidden(true);
      sprite.gameObject.setActive(false);
      if (sprite.body) {
        sprite.body.setVelocity(0, 0);
        sprite.body.enable = false;
        sprite.body.moves = false;
      }
      // Drop tag index entries so proximity queries don't return pooled sprites.
      unindexSpriteTags(sprite.scene, sprite);
      pool.push(sprite);
      return true;
    };

    const spawnFromBlueprint = (
      bp: ReturnType<typeof findBlueprint>,
      x: number,
      y: number,
      layerId?: string,
      instW?: number,
      instH?: number,
      instVars?: Record<string, number | string | boolean>,
      instZ?: number,
      instTags?: string[],
      instSpriteAnim?: string,
      instSpriteFrame?: number,
      instSpriteId?: string,
      instTiledBg?: BlueprintInstance["tiledBg"],
      instBehaviorOverrides?: Record<string, Record<string, unknown>>,
    ): Sprite | null => {
      if (!bp) return null;
      // Universal scale ratio — applied consistently to body, visual, and
      // collider so they all grow/shrink together by the same factor.
      // The denominator is the editor's "display base" (asset width when
      // there's a SpriteRenderer, BP body width otherwise) so dragging
      // a resize handle in the editor maps 1:1 to runtime size at every
      // BP regardless of how its body hitbox was originally configured.
      // When no override is set, scale stays 1 (no behavior change).
      const renderer = bp.behaviors.find((b) => b.kind === "SpriteRenderer");
      // Display-base resolution honors the instance sprite override
      // (instSpriteId) so a per-instance art swap also scales correctly
      // when the instance has w/h overrides. Falls back to the BP's sprite.
      const rendererSpriteIdResolved = instSpriteId || String(renderer?.config.spriteId ?? "");
      const rendererSprite = renderer
        ? project.sprites.find((s) => s.id === rendererSpriteIdResolved)
        : undefined;
      const displayBaseW = rendererSprite ? rendererSprite.width  : bp.w;
      const displayBaseH = rendererSprite ? rendererSprite.height : bp.h;
      const scaleX = instW !== undefined && displayBaseW > 0 ? instW / displayBaseW : 1;
      const scaleY = instH !== undefined && displayBaseH > 0 ? instH / displayBaseH : 1;
      // Body grows proportionally — preserves the BP's "small body, big
      // art" design ratio. A 16-px body under a 64-px sprite scaled to
      // 1.25× becomes a 20-px body under an 80-px sprite (same ratio).
      const finalW = bp.w * scaleX;
      const finalH = bp.h * scaleY;
      const sprite = g.sprite({
        color: bp.color, w: finalW, h: finalH, classKind: bp.classKind,
        noPhysicsBody: !!bp.noPhysicsBody,
      }).at(x, y);
      sprite.blueprintName = bp.name;
      sprite.blueprintId = bp.id;
      // The w/h-derived "blueprint scale" (e.g. a bed shrunk to 0.6) sizes the
      // body + art but does NOT touch gameObject.scaleX. Stamp it so overlays
      // that fold host scale (Tracer reach, Shadow size) see the REAL effective
      // scale (this × gameObject.scaleX), not just the runtime setScale part.
      sprite._renderScaleX = scaleX;
      sprite._renderScaleY = scaleY;
      // instanceName isn't a parameter on spawnFromBlueprint — set it
      // from the caller (the scene-instance loop below). For runtime
      // CreateObject spawns we leave it empty; those don't have a
      // user-authored placement label anyway.
      // Per-instance tag override fully replaces the BP tag list when set
      // (only honored if the BP marked tags as instance-editable; the
      // editor only writes inst.tags when that flag is on). Missing /
      // undefined / not-editable → fall back to BP tags.
      // REPLACE (not union) so authors can opt an instance OUT of a BP-
      // level tag — e.g. a "Wall" BP tagged `solid` with a decoration-only
      // variant tagged []. Union semantics silently broke that pattern in
      // a prior iteration.
      const tagSource = (instTags !== undefined && bp.tagsInstanceEditable) ? instTags : bp.tags;
      for (const t of tagSource) sprite.tags.add(t);
      if (instTags !== undefined && bp.tagsInstanceEditable) {
        for (const t of instTags) sprite.instanceTags.add(t);
      }
      // Register this sprite in the scene's tag → Set<Sprite> index so
      // tag-based queries (AIBrain target acquisition, FireProjectile homing,
      // EmitSignalTo, Projectile auto-target, …) hit O(1) instead of an
      // O(N) sprite-list scan. Called AFTER all tags are added so the
      // index reflects the final tag set. Read the scene FROM the sprite
      // — spawnFromBlueprint is defined before the outer `phaserScene` is
      // assigned, so referencing it directly would TDZ-throw.
      indexSpriteTags(sprite.scene, sprite);
      indexSpriteName(sprite.scene, sprite);
      // Viewport-culling mode — propagated from BP to the spawned Sprite
      // so Sprite.tick can gate behavior updates without re-reading the
      // BP every frame. Defaults to "never" on legacy BPs (no behavior
      // change for existing projects).
      sprite.cullMode = bp.cullMode ?? "never";
      // Off-screen throttle rate (frames between ticks) — from the BP's Hz.
      sprite.cullThrottleFrames = Math.max(1, Math.round(60 / Math.max(1, bp.cullThrottleHz ?? 10)));
      // Decision throttle — re-decide state-machine / logic at a reduced rate
      // (movement + animation stay smooth). 1 = every frame (default).
      sprite.decisionTickRate = Math.max(1, Math.floor(bp.decisionTickRate ?? 1));
      // CollisionScan opt-out — propagated from BP. Swarm enemies with
      // this flag set bypass the broad-phase pair detection, dropping
      // the per-cluster cost from O(M²) (M sprites in a cell) to 0.
      sprite.skipCollisionScan = !!bp.skipCollisionScan;
      sprite.collisionScanExceptTags = bp.collisionScanExceptTags ?? "";
      sprite.lodGroups = bp.lodGroups ?? [];
      // World sprite → render only on the main camera, never on the UI
      // camera. Lets BlurScene blur the world while leaving UI crisp.
      sprite.routeOverlayToCamera(sprite.gameObject);
      // Initialize variables from BP defaults, then apply per-instance
      // overrides on top (only for keys the BP actually declares — stale
      // overrides from a deleted variable get ignored, not surfaced as
      // ghost data).
      for (const v of bp.variables) {
        if (v.global) {
          // Global var — backed by the persistent store (shared + cross-scene).
          // Seed the local copy from the store (already holds the default or a
          // loaded save value, seeded at Play start) and register the name so
          // writeVar mirrors future writes back into the store.
          sprite.globalVars.add(v.name);
          const store = persistentState().globals;
          if (!(v.name in store)) store[v.name] = v.default;
          sprite.vars.set(v.name, store[v.name] as number | string | boolean);
          continue;
        }
        const override = instVars?.[v.name];
        const value = override !== undefined ? override : v.default;
        sprite.vars.set(v.name, value);
      }

      // Resolve layer FIRST so behaviors can read scrollFactor / depth from
      // the body when they create their own overlays in init().
      const { layer, idx: layerIdx } = resolveLayer(layerId);
      // Per-instance z stacks within the layer band. Behaviors read
      // `gameObject.depth + N` for their overlays so they all inherit
      // the per-instance offset without extra plumbing.
      const baseDepth = layerBaseDepth(layerIdx) + (instZ ?? 0) * Z_STEP;
      // Construct-style Z: drives BOTH render order (depth band) AND
      // parallax (scroll factor). Higher Z = closer to camera = scrolls
      // faster; lower Z = further away = scrolls slower. The layer's
      // parallax is the baseline (z=0); per-instance Z modulates it.
      const zMult = zParallaxMult(instZ ?? 0);
      sprite.gameObject.setScrollFactor(layer.parallaxX * zMult, layer.parallaxY * zMult);
      // Host body sits a hair above the layer's tilemap-base band so the
      // default debug rectangle (BPs without a SpriteRenderer overlay) is
      // visible on top of any tilemap painted into the same scene layer.
      sprite.gameObject.setDepth(baseDepth + 0.5);
      sprite.gameObject.setVisible(layer.visible);
      sprite.layerId = layer.id;
      // Y-sort: opt-in per scene layer. When the layer has `ySort: true`, the
      // sprite recomputes its depth every tick from `world Y + height × pivot`
      // so it interleaves with other Y-sorted sprites and per-row tilemap
      // layers. The pivot defaults to 1 (bottom = "feet") for the topdown
      // convention; BPs can override (e.g. 0.5 = center).
      // `ySortExclude` opts a BP OUT of the layer's Y-sort — it keeps a fixed
      // depth (baseDepth + per-instance z) instead of interleaving by Y. For
      // decals / FX like blood splats that shouldn't flicker in front of and
      // behind characters as they move. Use the instance z-order to place it
      // above (high z) or below (negative z) the Y-sorted sprites.
      if (layer.ySort && !bp.ySortExclude) {
        sprite._ySortEnabled = true;
        sprite._ySortBaseDepth = baseDepth;
        sprite._ySortPivotY = typeof bp.ySortPivotY === "number" ? bp.ySortPivotY : 1;
      }
      sprite.bpName = bp.name ?? "";
      // Body rect alpha. `hideRect` and behaviors that manage their own
      // visuals (SpriteRenderer / Text) drive this elsewhere — multiply
      // the layer opacity in for the case where the rect IS the visual.
      const bodyBaseAlpha = bp.hideRect ? 0 : 1;
      sprite.gameObject.setAlpha(bodyBaseAlpha * layer.opacity);
      // Gravity opt-out — when the BP toggles "Affected by Gravity" off,
      // disable body gravity so Camera / UI / trigger BPs stay put. Default
      // (missing field or true) keeps gravity on for Player / Actor BPs.
      if (bp.affectedByGravity === false && sprite.body) {
        sprite.body.allowGravity = false;
      }

      // "Use Frame Collider" on a SpriteRenderer makes the SPRITE's own
      // per-frame collider act as the BP's collider — no separate Collider
      // component. We auto-provide one here (reusing all the body + collision
      // wiring): it reads the frame collider each tick (Collider.applyShape),
      // and the SR's `solid` maps to passThrough. Skipped if the BP already has
      // a Collider (the author's explicit one wins).
      const srForCol = bp.behaviors.find((b) => b.kind === "SpriteRenderer");
      // Per-instance component overrides — merged ON TOP of the BP's config
      // BEFORE the special-case branches below, so scale folding / SR config
      // building all read the overridden values naturally. Keyed by kind, or
      // `Kind#name` when a BP carries several of the same kind (Tracer,
      // ParticleEmitter — matched by the behavior's `name` field).
      const withOverrides = (b: (typeof bp.behaviors)[number]) => {
        if (!instBehaviorOverrides) return b;
        const bName = String((b.config as Record<string, unknown>).name ?? "");
        const ov = instBehaviorOverrides[`${b.kind}#${bName}`] ?? instBehaviorOverrides[b.kind];
        return ov ? { ...b, config: { ...b.config, ...ov } } : b;
      };
      const effectiveBehaviors = bp.behaviors.map(withOverrides);
      if (srForCol && Number(srForCol.config.useFrameCollider) === 1
          && !bp.behaviors.some((b) => b.kind === "Collider")) {
        // The Collider sizes the body to the per-frame hitbox (frameColliderRect)
        // and makes the BP eligible for collision wiring.
        effectiveBehaviors.push({
          kind: "Collider",
          config: {
            // Body dims are overridden each tick from the frame collider; these
            // are only the pre-first-frame fallback.
            width: 32, height: 32, offsetX: 0, offsetY: 0,
            collideWorldBounds: 0, passThrough: 1,
          },
        });
        // BLOCKING is driven by the Solid behavior (Game.registerCollisions wires
        // Solid↔Collider as a hard block). `passThrough` is vestigial. So when the
        // SR's Solid is on, also give it Solid; otherwise it's overlap-only.
        if (Number(srForCol.config.solid ?? 1) && !bp.behaviors.some((b) => b.kind === "Solid")) {
          effectiveBehaviors.push({ kind: "Solid", config: {} });
        }
        // Collide filter (include/exclude tags) — published on the gameObject so
        // Game.registerCollisions can veto the block per the colliding sprite's
        // tags, mirroring a Sprite Placement's filter.
        const fTags = (srForCol.config.collideFilterTags as string[] | undefined) ?? [];
        sprite.gameObject.setData("peaky.collideTags", [...fTags]);
        sprite.gameObject.setData("peaky.tagMode", String(srForCol.config.collideFilterMode ?? "include"));
      }
      for (const b of effectiveBehaviors) {
        const Ctor = BEHAVIOR_REGISTRY[b.kind];
        let cfg: Record<string, unknown> = b.config;
        if (b.kind === "SpriteRenderer") {
          // Visual scaled by the same universal ratio as body / collider.
          // Per-instance spriteId override: rebuild the SR config against
          // the overridden asset so animations / textures match.
          const bForCfg = instSpriteId
            ? { ...b, config: { ...b.config, spriteId: instSpriteId } }
            : b;
          cfg = buildSpriteRendererConfig(bForCfg, project, scaleX, scaleY);
          // `frame` is a plain frame picker; `playing` controls play/pause — no
          // translation needed (the SR holds on `frame` when playing is off).
          // Per-instance animation / frame override (a posed/varied placement).
          if (instSpriteAnim && (cfg._animations as Record<string, unknown> | undefined)?.[instSpriteAnim]) {
            cfg.currentAnimation = instSpriteAnim;
          }
          // Per-instance Static Frame = pose on that frame: set it + pause.
          if (typeof instSpriteFrame === "number" && instSpriteFrame >= 0) {
            cfg.frame = instSpriteFrame;
            cfg.playing = 0;
          }
        } else if (b.kind === "Collider" && (scaleX !== 1 || scaleY !== 1)) {
          // Collider rect + offset scale with the body so the hitbox
          // follows the visible art. Without this, a resized instance
          // keeps its BP-default collider, leaving a visible mismatch.
          const w = Number(b.config.width  ?? 32) * scaleX;
          const h = Number(b.config.height ?? 48) * scaleY;
          const ox = Number(b.config.offsetX ?? 0) * scaleX;
          const oy = Number(b.config.offsetY ?? 0) * scaleY;
          cfg = { ...b.config, width: w, height: h, offsetX: ox, offsetY: oy };
        } else if (b.kind === "Text") {
          // A scene resize scales the BODY's w/h, not the gameObject's scale,
          // so the Text overlay can't read it off obj.scaleX (always 1). Pass
          // the placement scale so the label + its offset track the resize.
          cfg = { ...b.config, _instScaleX: scaleX, _instScaleY: scaleY };
        } else if (b.kind === "TiledBackground") {
          // Resolve chosen sprite asset + animation + per-frame texture
          // keys/durations. Per-instance spriteId override takes priority
          // over the BP config. Animation defaults to the BP-configured
          // animation, then to the first animation. Static-frame mode +
          // animated mode both supply the full _frameKeys list so the
          // runtime can swap among them — same model as SpriteRenderer.
          const spriteId = instSpriteId || String(b.config.spriteId ?? "");
          if (spriteId) {
            const sp = project.sprites.find((s) => s.id === spriteId);
            if (sp) {
              const animName = instSpriteAnim || String(b.config.currentAnimation ?? "") || sp.animations[0]?.name || "";
              const anim = sp.animations.find((a) => a.name === animName) ?? sp.animations[0];
              if (anim && anim.frames.length > 0) {
                const frameKeys = anim.frames.map((_, i) => frameTextureKey(sp.id, anim.id, i));
                const baseDur = anim.fps > 0 ? 1 / anim.fps : 0.1;
                const frameDurations = anim.frames.map(() => baseDur);
                const startFrame = typeof instSpriteFrame === "number" && instSpriteFrame >= 0
                  ? instSpriteFrame
                  : Number(b.config.startFrame ?? 0);
                const playing = typeof instSpriteFrame === "number" && instSpriteFrame >= 0
                  ? 0
                  : (b.config.playing as number ?? 1);
                const f0Key = anim.frames[0]?.imageFile ? frameKeys[0] : undefined;
                cfg = {
                  ...b.config,
                  spriteId,
                  currentAnimation: animName,
                  startFrame,
                  playing,
                  _textureKey: f0Key,
                  _frameKeys: frameKeys,
                  _frameDurations: frameDurations,
                };
              } else {
                cfg = { ...b.config, spriteId };
              }
            } else {
              cfg = { ...b.config, spriteId };
            }
          }
          // Per-instance parallax / motion / size overrides, applied LAST
          // so they win over the BP-configured values. Only keys set in
          // the instance override are written (the rest inherit).
          if (instTiledBg) {
            const ov = instTiledBg;
            cfg = { ...cfg };
            if (ov.mode !== undefined)            cfg.mode = ov.mode;
            if (ov.parallaxFactorX !== undefined) cfg.parallaxFactorX = ov.parallaxFactorX;
            if (ov.parallaxFactorY !== undefined) cfg.parallaxFactorY = ov.parallaxFactorY;
            if (ov.scrollSpeedX !== undefined)    cfg.scrollSpeedX = ov.scrollSpeedX;
            if (ov.scrollSpeedY !== undefined)    cfg.scrollSpeedY = ov.scrollSpeedY;
            if (ov.width !== undefined)           cfg.width = ov.width;
            if (ov.height !== undefined)          cfg.height = ov.height;
            if (ov.flipX !== undefined)           cfg.flipX = ov.flipX;
            if (ov.flipY !== undefined)           cfg.flipY = ov.flipY;
            if (ov.tileX !== undefined)           cfg.tileX = ov.tileX;
            if (ov.tileY !== undefined)           cfg.tileY = ov.tileY;
          }
        } else if (b.kind === "ParticleEmitter") {
          // Inject the Phaser texture key for the chosen Sprite asset.
          // ParticleEmitter doesn't reach into project state itself — it
          // reads `_textureKey` (and optionally `_frameKeys`) which we
          // resolve here once at attach time. Falls back to undefined so
          // the runtime uses Phaser's built-in `__WHITE` 1x1 pixel,
          // keeping mis-configured emitters visible (tinted) instead of
          // silently invisible.
          const spriteId = String(b.config.spriteId ?? "");
          if (spriteId) {
            const sp = project.sprites.find((s) => s.id === spriteId);
            const a0 = sp?.animations[0];
            const f0 = a0?.frames[0];
            if (sp && a0 && f0?.imageFile) {
              // Reuse the same texture-key convention SpriteRenderer uses
              // (frameTextureKey: `sprite:<id>:<animId>:<frameIdx>`) so the
              // emitter and the renderer share textures when both point
              // at the same Sprite asset.
              const textureKey = frameTextureKey(sp.id, a0.id, 0);
              // POSITIONAL list — index N = texture for frame N, with ""
              // placeholder for frames missing an image. Lets the user's
              // CSV "0,2,5" reference frames by their actual numbering
              // even when intermediate frames are blank.
              const frameKeysAll = a0.frames.map((f, i) => f.imageFile ? frameTextureKey(sp.id, a0.id, i) : "");
              // Backwards-compat: `_frameKeys` is the dense list (image-
              // bearing frames only), still used by frameMode="random".
              const frameKeys = frameKeysAll.filter((k): k is string => k !== "");
              cfg = { ...b.config, _textureKey: textureKey, _frameKeys: frameKeys, _frameKeysAll: frameKeysAll };
            }
          }
        } else if (b.kind === "WeaponSlot") {
          // Weapon uses SpriteRenderer-shaped `_animations` data so it
          // can play any animation on the chosen weapon sprite. Reuse the
          // existing helper; if spriteId is empty (unequipped) we pass
          // the raw config through and the runtime renders nothing.
          if (String(b.config.spriteId ?? "")) {
            cfg = buildSpriteRendererConfig(b, project, scaleX, scaleY);
          }
        } else if (b.kind === "VisionMask") {
          // Inject the mask-shape texture(s) for the chosen sprite (its alpha
          // drives the reveal shape). Empty maskSpriteId = built-in circle, no
          // key. Frames are already preloaded (every project sprite is queued
          // above). Static → one frame key; animation → the dense frame-key
          // list + per-frame durations the runtime cycles.
          const maskSpriteId = String(b.config.maskSpriteId ?? "");
          if (maskSpriteId) {
            const sp = project.sprites.find((s) => s.id === maskSpriteId);
            const animName = String(b.config.maskAnimation ?? "");
            const anim = sp?.animations.find((a) => a.name === animName) ?? sp?.animations[0];
            if (sp && anim && anim.frames.length > 0) {
              const mode = String(b.config.maskSpriteMode ?? "static");
              if (mode === "animation") {
                const keys = anim.frames.map((f, i) => f.imageFile ? frameTextureKey(sp.id, anim.id, i) : "");
                const dense = keys.filter((k): k is string => k !== "");
                const baseDur = anim.fps > 0 ? 1 / anim.fps : 0.1;
                cfg = {
                  ...b.config,
                  _maskTextureKey: dense[0],
                  _maskFrameKeys: dense,
                  _maskFrameDurations: dense.map(() => baseDur),
                };
              } else {
                const fi = Math.max(0, Math.min(anim.frames.length - 1, Math.floor(Number(b.config.maskFrame ?? 0))));
                // Fall back to the first image-bearing frame if the picked one is blank.
                const pick = anim.frames[fi]?.imageFile ? fi : anim.frames.findIndex((f) => f.imageFile);
                if (pick >= 0) cfg = { ...b.config, _maskTextureKey: frameTextureKey(sp.id, anim.id, pick) };
              }
            }
          }
        }
        sprite.addBehavior(Ctor as never, cfg as never);
        if (sprite.lastBehavior) {
          sprite.lastBehavior.enabled = b.enabled !== false;
          // Push the layer into any overlays the behavior just created.
          sprite.lastBehavior.applyLayer(layer.parallaxX * zMult, layer.parallaxY * zMult, baseDepth, layer.opacity, layer.visible);
        }
      }
      sprite.attachEvents(
        bp.events.map(toEventSpec),
        (bp.eventGroups ?? []).map(toEventGroupSpec),
      );
      if (bp.logicSheet) {
        attachLogicSheet(sprite, bp.logicSheet as unknown as RuntimeLogicSheet);
      }
      // Wire OnCollide / OnOverlap pairs against every other live sprite.
      // Runs ALSO for runtime CreateObject spawns (this function is the
      // single spawn entry point), fixing the bug where post-boot spawns
      // never participated in tag-based collisions.
      // Distance-gated wiring: when the BP sets `collisionWakeRadius > 0`,
      // skip the spawn-time wiring entirely. Sprite.tick's wake check
      // calls wireCollisionsFor lazily when a `collisionWakeTag` sprite
      // gets close. Defers the O(N) pair-wiring loop from scene-start
      // to per-frame staggered work as NPCs reach the player.
      const wakeRadius = Number(bp.collisionWakeRadius ?? 0);
      if (wakeRadius > 0) {
        sprite.collisionWakeRadius = wakeRadius;
        sprite.collisionWakeTag = String(bp.collisionWakeTag ?? "player");
        sprite._collisionUnwired = true;
        sprite._wakeTickPhase = sprite.uid;
      } else {
        wireCollisionsFor(sprite, bp.id);
      }
      // If we're being spawned during the same frame as scene start
      // (e.g. an OnSceneStart-triggered RestartLayout that re-creates
      // BPs before the first tick has finished), self-emit
      // `_sceneStart` so this sprite's OnSceneStart trigger still
      // matches. The post-boot grace window is short so long-running
      // spawns (CreateObject mid-game) don't spuriously re-fire
      // OnSceneStart years into the run.
      const startedAtMs = (sprite.scene.data.get("peaky.sceneStartedAtMs") as number | undefined) ?? 0;
      if (startedAtMs && Date.now() - startedAtMs < 50) {
        sprite.events.emit("_sceneStart");
      }
      return sprite;
    };

    /** Spawn a UI Widget instance — distinct from spawnFromBlueprint:
     *  - No physics body (body.enable = false): UI widgets shouldn't
     *    fall, collide, or get pushed by anything. Position is
     *    user-driven (Anchor behavior at init, or scene-editor x/y).
     *  - No tags / no gravity / no `bp.color` rect (UI widgets render
     *    only via their attached visual behaviors — Text / SpriteRenderer).
     *  - The widget's `events` / variables / behaviors are wired the
     *    same way as a BP, so OnSignal / SetVar / etc. all work. */
    /** Build a runtime UIWidgetRenderer config from any UIWidgetVisual
     *  (top-level widget OR a child inside a multi-mode widget). The
     *  shared shape is what makes Single + Multi reuse the same
     *  renderer. */
    const buildUIWidgetCfg = (
      v: import("./project").UIWidgetVisual,
      finalW: number,
      finalH: number,
      bindings: import("./project").WidgetBinding[] = [],
      childName = "",
    ): Record<string, unknown> => ({
      // Injected via the underscore-prefixed pattern (matches SpriteRenderer's
      // _animations, ParticleEmitter's _frameKeys, etc.) — runtime reads
      // them but `SetBehaviorParam` shouldn't be able to write through.
      _bindings: bindings,
      _childName: childName,
      widgetKind: v.kind,
      widgetW: finalW,
      widgetH: finalH,
      blockGameInput: v.blockGameInput ? 1 : 0,
      bgColor: v.bgColor ?? 0,
      bgAlpha: v.bgAlpha ?? (v.bgColor !== undefined ? 1 : 0),
      borderColor: v.borderColor ?? 0,
      borderWidth: v.borderWidth ?? 0,
      padding: v.padding ?? 0,
      cornerRadius: v.cornerRadius ?? 0,
      cornersSeparate: !!v.cornersSeparate,
      cornerRadiusTL: v.cornerRadiusTL ?? 0,
      cornerRadiusTR: v.cornerRadiusTR ?? 0,
      cornerRadiusBL: v.cornerRadiusBL ?? 0,
      cornerRadiusBR: v.cornerRadiusBR ?? 0,
      shadowEnabled: !!v.shadowEnabled,
      shadowColor: v.shadowColor ?? 0x000000,
      shadowAlpha: v.shadowAlpha ?? 0.4,
      shadowBlur: v.shadowBlur ?? 12,
      shadowOffsetX: v.shadowOffsetX ?? 0,
      shadowOffsetY: v.shadowOffsetY ?? 6,
      anchorCorner: v.anchorCorner ?? "",
      anchorOffsetX: v.anchorOffsetX ?? 0,
      anchorOffsetY: v.anchorOffsetY ?? 0,
      text: v.text ?? "",
      fontFamily: v.fontFamily ?? "Arial",
      fontSize: v.fontSize ?? 16,
      fontColor: v.fontColor ?? 0xffffff,
      fontBold: !!v.fontBold,
      fontItalic: !!v.fontItalic,
      align: v.align ?? "center",
      vAlign: v.vAlign ?? "middle",
      signalOnClick: v.signalOnClick ?? "",
      signalOnHover: v.signalOnHover ?? "",
      signalOnLeave: v.signalOnLeave ?? "",
      hoverBgColor: v.hoverBgColor,
      pressedBgColor: v.pressedBgColor,
      clickMode: v.clickMode ?? "single",
      min: v.min ?? 0,
      max: v.max ?? 100,
      value: v.value ?? 0,
      direction: v.direction ?? "horizontal",
      fillColor: v.fillColor ?? 0x44ddff,
      signalOnChange: v.signalOnChange ?? "",
      readOnly: !!v.readOnly,
      options: (v.options ?? []).map((o) => ({ value: o.value, label: o.label, signal: o.signal ?? "" })),
      selectedValue: v.selectedValue ?? "",
      signalOnSelect: v.signalOnSelect ?? "",
      spriteId: v.spriteId ?? "",
      imageTextureKey: (() => {
        if (!v.spriteId) return "";
        const sp = project.sprites.find((s) => s.id === v.spriteId);
        if (!sp) return "";
        const a0 = sp.animations[0];
        if (!a0 || a0.frames.length === 0) return "";
        if (!a0.frames[0].imageFile) return "";
        return frameTextureKey(sp.id, a0.id, 0);
      })(),
      // Inventory grid.
      rows: v.rows ?? 1,
      cols: v.cols ?? 5,
      slotSize: v.slotSize ?? 48,
      slotGap: v.slotGap ?? 4,
      slotBgColor: v.slotBgColor ?? 0x222831,
      slotBorderColor: v.slotBorderColor ?? 0x404552,
      slotBorderWidth: v.slotBorderWidth ?? 1,
      slotRadius: v.slotRadius ?? 0,
      targetBp: v.targetBp ?? "",
      signalOnSlotClick: v.signalOnSlotClick ?? "",
      signalOnSlotDoubleClick: v.signalOnSlotDoubleClick ?? "",
      clickedItemVar: v.clickedItemVar ?? "",
      slotsDraggable: v.slotsDraggable ?? true,
      uncraftableTint: v.uncraftableTint ?? 0x000000,
      signalOnCraftClick: v.signalOnCraftClick ?? "",
      resultGap: v.resultGap ?? 24,
      signalOnCraft: v.signalOnCraft ?? "",
      shopRole: v.shopRole ?? "",
      shopItem: v.shopItem ?? "",
      shopCurrency: v.shopCurrency ?? "",
      shopSlots: v.shopSlots ?? [],
      // Stable key for this shop's persistent stock — the def's name (so the
      // Restock Shop action can target it by name), falling back to its id.
      shopId: (v as { name?: string; id?: string }).name || (v as { id?: string }).id || "",
      selectionColor: v.selectionColor ?? 0xffd23c,
      selectionWidth: v.selectionWidth ?? 3,
      // Resolved grid sprite visuals (keys + anim meta) — underscore-prefixed so
      // SetBehaviorParam can't write them. Each honors its anim + frame pick.
      _slotBgVisual: resolveSpriteVisual(project, v.slotBgSpriteId, v.slotBgAnim, v.slotBgFrame),
      _selectionVisual: resolveSpriteVisual(project, v.selectionSpriteId, v.selectionAnim, v.selectionFrame),
      _panelVisual: resolveSpriteVisual(project, v.panelSpriteId, v.panelAnim, v.panelFrame),
      _craftArrowVisual: resolveSpriteVisual(project, v.craftArrowSpriteId, v.craftArrowAnim, v.craftArrowFrame),
    });

    const spawnFromUIWidget = (
      widgetId: string,
      x: number,
      y: number,
      layerId?: string,
      instW?: number,
      instH?: number,
      /** Optional stable instanceId — when provided, the parent sprite
       *  carries it AND all multi-mode children get parentInstanceId
       *  pointing at it. Lets DestroyUIWidget cascade (kill the parent
       *  → children die too). Scene-placed widgets pass inst.id;
       *  CreateUIWidget runtime spawns synthesize one. */
      instanceId?: string,
      /** When true, the widget is spawned as a BP-attached world-space
       *  child (per-NPC healthbar). Bypasses multi-mode's viewport
       *  centering and root anchor logic — position is the host's world
       *  coords + offset, and the Widget behavior keeps it synced
       *  each tick. Children of a multi-mode widget render relative to
       *  the root's authored canvas position so the visual layout in
       *  the editor matches what spawns. */
      attachedMode = false,
    ): Sprite | null => {
      const widget = project.uiWidgets.find((w) => w.id === widgetId);
      if (!widget) return null;
      const isMulti = widget.mode === "multi";

      // For multi-mode widgets, the parent widget acts as a viewport-
      // sized container — children's positions are viewport-relative.
      // Override the instance's size to match the project viewport so
      // the canvas layout from the editor preview maps 1:1 to runtime.
      // EXCEPT in attachedMode (BP-attached widget): root size stays at
      // the widget's authored dimensions so the per-NPC healthbar matches
      // the editor preview size, not the viewport.
      const finalW = (isMulti && !attachedMode) ? project.viewportWidth  : (instW ?? widget.width);
      const finalH = (isMulti && !attachedMode) ? project.viewportHeight : (instH ?? widget.height);
      // Multi-mode parent is conceptually anchored at the viewport's
      // top-left (canvas (0, 0)), so children at child.x/y land at the
      // matching canvas pixel. Single-mode parent honors the
      // instance's drop position. AttachedMode honors the passed x/y
      // (the host's world position) — Widget.update() keeps it synced.
      const parentCenterX = (isMulti && !attachedMode) ? finalW / 2 : x;
      const parentCenterY = (isMulti && !attachedMode) ? finalH / 2 : y;
      const sprite = g.sprite({ color: 0x000000, w: finalW, h: finalH }).at(parentCenterX, parentCenterY);
      sprite.blueprintName = widget.name;
      sprite.blueprintId = widget.id;
      sprite.isUIWidget = true;
      // Stamp instanceId on the parent NOW so multi-mode children
      // can stamp their parentInstanceId during the same spawn loop
      // below (no postprocess needed by the caller).
      if (instanceId) sprite.instanceId = instanceId;
      sprite.body.enable = false;
      sprite.body.allowGravity = false;

      for (const v of widget.variables) {
        sprite.vars.set(v.name, v.default);
      }

      const { layer, idx: layerIdx } = resolveLayer(layerId);
      const baseDepth = layerBaseDepth(layerIdx);
      sprite.gameObject.setScrollFactor(layer.parallaxX, layer.parallaxY);
      sprite.gameObject.setDepth(baseDepth);
      sprite.gameObject.setVisible(layer.visible);
      sprite.gameObject.setAlpha(0);
      sprite.layerId = layer.id;
      // Camera routing for UI widgets is parallax-driven:
      //   • Layer parallax (0, 0) → render on the UI cam only (ignored by
      //     main cam) so BlurScene leaves the widget crisp and the
      //     widget's anchor + viewport math behaves like classic UI.
      //   • Layer parallax NOT (0, 0) → render on main cam, NOT on the
      //     UI cam. The widget follows the world camera per the layer's
      //     parallax — useful for in-world UI (floating health bars,
      //     diegetic prompts on a wall, etc.).
      // `isUIWidget` stays true regardless (it's the asset-class flag
      // — DestroyUIWidget / resolveUIWidgets need it). Routing is
      // controlled separately via `renderOnMainCamera`.
      sprite.renderOnMainCamera = !(layer.parallaxX === 0 && layer.parallaxY === 0);
      sprite.routeOverlayToCamera(sprite.gameObject);

      if (!isMulti) {
        // Single-mode: one UIWidgetRenderer on the parent sprite. Bindings
        // (if any) target this single instance — childName "" matches the
        // root in WidgetBindingsTable's UI.
        const cfg = buildUIWidgetCfg(widget, finalW, finalH, widget.bindings ?? [], "");
        // In attachedMode the Widget BP component owns the position —
        // suppress the renderer's anchor-corner override that would
        // otherwise pull the widget back to a screen corner each tick.
        if (attachedMode) cfg.anchorCorner = "";
        sprite.addBehavior(UIWidgetRenderer as never, cfg as never);
        if (sprite.lastBehavior) {
          sprite.lastBehavior.applyLayer(layer.parallaxX, layer.parallaxY, baseDepth, layer.opacity, layer.visible);
        }
      } else {
        // Multi-mode: spawn one sub-sprite per child. Each sub-sprite
        // owns its own UIWidgetRenderer for visuals + interaction.
        // CRITICAL: redirect each child's `events` and `vars` to the
        // PARENT's so OnSignal listeners on the parent's event sheet
        // hear the child's clicks / picks / drags. Without this, every
        // child has its own EventBus and the user would have to
        // duplicate listeners per-child.
        // Multi-mode + attachedMode is rejected at the spawnAttachedWidget
        // callback (BP-attached widgets are single-mode only) so the
        // attachedMode branches in this block aren't reachable from the
        // attached-widget path. Multi-mode runs only for scene-placed UI.
        for (let ci = 0; ci < widget.children.length; ci++) {
          const child = widget.children[ci];
          // Each child gets its OWN depth BAND (10 apart) so a child's
          // internal layers (bg=+1, image=+4, label=+5, …) can't interleave
          // with a sibling's. Without this, a full-size backdrop Image child
          // would draw OVER the buttons' backgrounds but UNDER their text
          // (text sits at a higher within-child offset) — "button bg gone".
          // Array order = paint order: first child = lowest band = behind.
          const childDepth = baseDepth + 1 + ci * 10;
          // Author coords (child.x/y) are in canvas-local space — top-left
          // of the parent. Centered to sprite-position convention.
          const childCenterX = child.x + child.width / 2;
          const childCenterY = child.y + child.height / 2;
          const childSprite = g.sprite({ color: 0x000000, w: child.width, h: child.height })
            .at(childCenterX, childCenterY);
          childSprite.blueprintName = widget.name;
          childSprite.blueprintId = widget.id;
          childSprite.instanceName = child.name ?? "";
          childSprite.isUIWidget = true;
          // Tie child to parent so DestroyUIWidget cascades: when the
          // parent (matched by name + isUIWidget flag) gets killed,
          // every sprite whose parentInstanceId matches the parent's
          // instanceId dies with it.
          if (instanceId) childSprite.parentInstanceId = instanceId;
          childSprite.body.enable = false;
          childSprite.body.allowGravity = false;
          // Inherit the parent's camera-routing decision so multi-mode
          // children render on the same cam as their parent (UI cam
          // when parallax is 0/0; main cam otherwise).
          childSprite.renderOnMainCamera = sprite.renderOnMainCamera;
          childSprite.routeOverlayToCamera(childSprite.gameObject);
          // Share the parent's event bus + vars. The child's
          // signalOnClick / Select / Change / etc. emits land on the
          // parent's bus where the widget event sheet is listening.
          // CRITICAL: also flag `ownsEventBus = false` so the child's
          // tick() doesn't call flush() on the shared bus — without
          // this, N siblings each flushing in one frame would clobber
          // `firedPrev` and silently drop signals between siblings.
          childSprite.events = sprite.events;
          (childSprite as unknown as { vars: typeof sprite.vars }).vars = sprite.vars;
          childSprite.ownsEventBus = false;
          childSprite.gameObject.setScrollFactor(layer.parallaxX, layer.parallaxY);
          childSprite.gameObject.setDepth(childDepth);
          childSprite.gameObject.setVisible(layer.visible);
          childSprite.gameObject.setAlpha(0);

          // Each child receives the FULL parent bindings list + its own
          // name. Inside UIWidgetRenderer.update(), each child filters
          // bindings whose `childName` matches its own; the rest are
          // ignored. Lets the parent author bindings for any child by
          // name without per-child wiring at spawn.
          const childCfg = buildUIWidgetCfg(child, child.width, child.height, widget.bindings ?? [], child.name ?? "");
          // Multi-mode has no renderer on the container itself, so the
          // container's "block game input" propagates to every child — clicking
          // any element swallows input (gaps between elements click through).
          if (widget.blockGameInput) childCfg.blockGameInput = 1;
          childSprite.addBehavior(UIWidgetRenderer as never, childCfg as never);
          if (childSprite.lastBehavior) {
            childSprite.lastBehavior.applyLayer(layer.parallaxX, layer.parallaxY, childDepth, layer.opacity, layer.visible);
          }
        }
      }

      sprite.attachEvents(
        widget.events.map(toEventSpec),
        (widget.eventGroups ?? []).map(toEventGroupSpec),
      );
      // Run the widget's Logic Sheet (the node-graph the editor authors via
      // the Logic panel). Without this the widget's OnCreate / OnSignal /
      // SetUIVisible chains never fire at runtime — only legacy `events` did.
      if (widget.logicSheet) {
        attachLogicSheet(sprite, widget.logicSheet as unknown as RuntimeLogicSheet);
      }
      return sprite;
    };

    // Attached-widget spawn callback must be registered BEFORE BP spawns
    // start — the Widget component's init() runs as part of each BP's
    // addBehavior, so the callback has to exist at that moment for
    // healthbars / name labels to materialize on first scene load. The
    // CreateUIWidget runtime callback registers below; that one only
    // matters for actions fired from events, which can't run until after
    // scene create() finishes.
    const earlyScene = g.getScene();
    if (earlyScene) {
      // Viewport cull distance — set on the scene data registry early so
      // Sprite.tick can read it during the FIRST tick (before any spawn
      // pass even runs). Default 1.5 (50% buffer past viewport).
      earlyScene.data.set("peaky.cullDistanceMultiplier", project.cullDistanceMultiplier ?? 1.5);
      earlyScene.data.set("peaky.spawnAttachedWidget", (arg: {
        id: string; x: number; y: number; layer?: string;
        /** Optional host sprite — when provided, the spawned widget
         *  inherits the host's layer (and therefore camera routing). The
         *  Widget BP component passes its own host so the per-NPC HP bar
         *  renders on the same camera as the NPC instead of jumping to
         *  the UI layer. */
        hostLayerId?: string;
      }): Sprite | null => {
        const w = project.uiWidgets.find((x) => x.id === arg.id);
        if (!w) {
          console.warn("[Peaky] Widget component: widget not found id=", arg.id);
          return null;
        }
        if (w.mode === "multi") {
          console.warn(`[Peaky] Widget component: "${w.name}" is multi-mode; only single-mode widgets can attach to BPs.`);
          return null;
        }
        const synthId = `uiinst_attached_${Math.random().toString(36).slice(2, 10)}`;
        // hostLayerId wins so the attached widget rides the same camera
        // as its host. Falls back to arg.layer (legacy callers) or the
        // scene's default UI layer when neither is set.
        return spawnFromUIWidget(w.id, arg.x, arg.y, arg.hostLayerId ?? arg.layer, undefined, undefined, synthId, true);
      });
    }

    for (const inst of scene.instances) {
      // Persistence: an instance permanently removed (Destroy "Remember") in a
      // prior visit is not re-spawned. Stable across reloads via inst.id.
      if (persistentState().removedInstances.has(inst.id)) continue;
      const bp = findBlueprint(project, inst.blueprintId);
      if (!bp) {
        console.warn(`Skipping instance ${inst.id}: blueprint ${inst.blueprintId} not found`);
        continue;
      }
      const sprite = spawnFromBlueprint(bp, inst.x, inst.y, inst.layerId, inst.w, inst.h, inst.vars, inst.z, inst.tags, inst.spriteAnimation, inst.spriteFrame, inst.spriteId, inst.tiledBg, inst.behaviorOverrides);
      // Stable id (for persistent removal / save-load) + per-instance display
      // label (set in Instance Inspector) so dialogue / events / persistence
      // can target THIS specific placement.
      if (sprite) sprite.instanceId = inst.id;
      if (sprite && inst.name) sprite.instanceName = inst.name;
      // Per-instance visual scale + angle. The SpriteRenderer / Text overlays
      // fold the host's scaleX/Y + rotation in via syncOverlay, so the art
      // follows. (Body size stays driven by w/h / the Collider component.)
      if (sprite) {
        const sx = inst.scaleX ?? 1, sy = inst.scaleY ?? 1;
        if (sx !== 1 || sy !== 1) sprite.gameObject.setScale(sx, sy);
        if (inst.angle) sprite.gameObject.setAngle(inst.angle);
      }
      // Door link — stamp it onto the sprite (resolving the destination scene
      // NAME, which the transition APIs take) so the runtime door scan can fire
      // the scene link when a traveler enters. Only doors (destSceneId set) act.
      if (sprite && inst.door && inst.door.destSceneId) {
        const destName = project.scenes.find((s) => s.id === inst.door!.destSceneId)?.name ?? "";
        (sprite as unknown as { doorLink?: unknown }).doorLink = {
          name: inst.door.name,
          destSceneId: inst.door.destSceneId,
          destSceneName: destName,
          destDoor: inst.door.destDoor,
          withLoad: !!inst.door.withLoad,
          loaderSceneName: inst.door.loaderSceneId ? (project.scenes.find((s) => s.id === inst.door!.loaderSceneId)?.name ?? "") : "",
          travelerTag: inst.door.travelerTag,
          activation: inst.door.activation,
          delaySec: inst.door.delaySec,
          inputAction: inst.door.inputAction,
        };
      }
      // Spawned-tag list mirrors the runtime sprite.tags exactly — used by
      // wireCollisionsFor() to set up pair listeners. Honor the per-instance
      // override (when the BP allows it) so tag-based collision routing
      // matches what the runtime actually sees.
      if (sprite) {
        const tagsForCollision = (inst.tags !== undefined && bp.tagsInstanceEditable)
          ? inst.tags
          : bp.tags;
        spawned.push({ sprite, tags: tagsForCollision, bpId: bp.id });
      }
    }


    // ─── UI Widget instance spawn ───────────────────────────────────────
    // After gameplay BPs so UI widgets render on top in DOM order (their
    // layer's depth / parallax handle z-ordering at runtime).
    for (const inst of scene.uiInstances ?? []) {
      const sprite = spawnFromUIWidget(inst.uiWidgetId, inst.x, inst.y, inst.layerId, inst.w, inst.h, inst.id);
      if (!sprite) {
        console.warn(`Skipping UI instance ${inst.id}: widget ${inst.uiWidgetId} not found`);
        continue;
      }
      // instanceId is already set inside spawnFromUIWidget when passed
      // through, but stamp again for clarity / parity with BP loop.
      sprite.instanceId = inst.id;
      if (inst.parentInstanceId) sprite.parentInstanceId = inst.parentInstanceId;
      if (inst.name) sprite.instanceName = inst.name;
      spawned.push({ sprite, tags: [], bpId: inst.uiWidgetId });
    }

    // ─── Tilemap instance spawn ────────────────────────────────────────
    // Each TilemapInstance gets a tiny host sprite whose only job is to host
    // a TilemapRenderer behavior. Wrapped in try/catch per instance so a
    // single misconfigured tilemap (e.g. layers array missing on an old save)
    // can't take down the whole game boot — the user just gets a console
    // warning and the rest of the scene loads normally.
    // Keep each tilemap an ATOMIC z-unit: tilemaps that share a scene layer AND
    // per-instance z would otherwise collide in the same base depth, so their
    // internal layers (offset by only L.z×0.01) interleave — e.g. a water map's
    // "drizzle" layer drawing above a separate "grass" map. Give each such
    // tilemap its own sub-band (array order) wider than any flat internal offset
    // (max ≈ L.z×0.01 + 1 for per-tile overlays). NOTE: Y-sort layers span the
    // whole map height to interleave with sprites and can still cross bands —
    // put Y-sort tilemaps on distinct layers / z.
    const TILEMAP_STACK_BAND = 4;
    const tmStackIdx = new Map<string, number>();
    {
      const seen = new Map<string, number>();
      for (const inst of scene.tilemapInstances ?? []) {
        const key = `${resolveLayer(inst.layerId).idx}|${inst.z ?? 0}`;
        const n = seen.get(key) ?? 0;
        tmStackIdx.set(inst.id, n);
        seen.set(key, n + 1);
      }
    }
    for (const inst of scene.tilemapInstances ?? []) {
      try {
        const map = (project.tilemaps ?? []).find((m) => m.id === inst.tilemapId);
        if (!map) {
          console.warn(`Skipping tilemap instance ${inst.id}: tilemap ${inst.tilemapId} not found`);
          continue;
        }
        if (!Array.isArray(map.layers) || map.layers.length === 0) {
          console.warn(`Skipping tilemap "${map.name}": no layers (legacy save not migrated?)`);
          continue;
        }
        // Ordered tileset list (primary + extras) with firstgids. Painted cells
        // hold GLOBAL ids; we merge every tileset's per-index collision/mining
        // data into one global-keyed set here so the runtime stays index-based.
        const tmSlots = tilemapTilesets(map, project.tilesets ?? []);
        const ts = tmSlots[0]?.ts;
        const multiTileset = tmSlots.length > 1;
        const tileW = ts?.tileW ?? 32;
        const tileH = ts?.tileH ?? 32;

        // The painter numbers tiles with a STABLE sparse stride (firstgid =
        // slotIndex * STRIDE) so re-baking a tileset never renumbers another.
        // The runtime's combined texture wants CONTIGUOUS ids though, so remap
        // stride → contiguous here. `contigFg` is the cumulative tile count.
        let cg = 0;
        const slotRanges = tmSlots.map((s) => { const f = cg; cg += s.count; return { strideFg: s.firstgid, contigFg: f, count: s.count }; });
        const toContig = (g: number): number => {
          if (g < 0) return -1;
          for (const r of slotRanges) if (g >= r.strideFg && g < r.strideFg + r.count) return r.contigFg + (g - r.strideFg);
          return -1;
        };

        // Merge per-tileset data, offsetting each tileset's local indices by its
        // CONTIGUOUS firstgid. For a single-tileset map (firstgid 0) this is
        // identical to the legacy flat injection.
        const solidIndices: number[] = [];
        const tileColliders: Record<string, { points: { x: number; y: number }[] }> = {};
        const tileHardness: Record<string, number | string> = {};
        const tileGrowBack: Record<string, number | string> = {};
        const tileGrowBackPop: Record<string, boolean> = {};
        const tileDrops: typeof TilemapRenderer.prototype.tileDrops = {};
        const tileDropLayer: Record<string, string> = {};
        const tileExcludedTags: Record<string, string[]> = {};
        const tileOnBelowRemoved: Record<string, "destroy" | "drop"> = {};
        const globalExcludedTags = new Set<string>();
        const bigTiles: typeof TilemapRenderer.prototype.bigTiles = {};
        const animatedTiles: typeof TilemapRenderer.prototype.animatedTiles = {};
        for (let si = 0; si < tmSlots.length; si++) {
          const st = tmSlots[si].ts;
          const firstgid = slotRanges[si].contigFg;
          for (const i of st.solidTiles ?? []) solidIndices.push(i + firstgid);
          for (const [k, v] of Object.entries(st.tileColliders ?? {})) tileColliders[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileHardness ?? {})) tileHardness[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileGrowBack ?? {})) tileGrowBack[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileGrowBackPop ?? {})) tileGrowBackPop[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileDrops ?? {})) tileDrops[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileDropLayer ?? {})) tileDropLayer[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileExcludedTags ?? {})) tileExcludedTags[String(Number(k) + firstgid)] = v;
          for (const [k, v] of Object.entries(st.tileOnBelowRemoved ?? {})) tileOnBelowRemoved[String(Number(k) + firstgid)] = v;
          for (const t of st.globalExcludedTags ?? []) globalExcludedTags.add(t);
          // BigTiles keep LOCAL c/r (they composite from their own atlas). For a
          // multi-tileset map the runtime builds ONE reflowed combined texture,
          // so each BigTile carries its owning tileset's source so the composite
          // reads the right (contiguous) region.
          for (const bt of st.bigTiles ?? []) {
            bigTiles[bt.id] = {
              ...bt,
              _src: multiTileset
                ? { key: `tileset:${st.id}`, tileW: st.tileW, tileH: st.tileH, marginX: st.offsetX, marginY: st.offsetY, spacingX: st.spacingX, spacingY: st.spacingY }
                : undefined,
            };
          }
          // Animated frames: a NUMBER frame is a LOCAL tile index → shift to
          // GLOBAL so it indexes the combined texture's `tile_<global>` frame.
          // A REGION frame {c,r,w,h} stays local — the runtime composites it
          // from the owning tileset (via `_src` for multi-tileset maps), exactly
          // like a BigTile. So animated tiles can span multiple cells / BigTiles.
          for (const at of st.animatedTiles ?? []) {
            // All-number anims keep the legacy global-index path (frame shifted
            // into the combined texture's `tile_<global>` slot). If ANY frame is
            // a multi-cell region, convert EVERY frame to a local {c,r,w,h}
            // region so the runtime composites them uniformly (and can span
            // multiple cells, including BigTile footprints).
            const hasRegion = at.frames.some((f) => typeof f !== "number");
            const cols = Math.max(1, st.cols);
            const frames = hasRegion
              ? at.frames.map((f) => (typeof f === "number" ? { c: f % cols, r: Math.floor(f / cols), w: 1, h: 1 } : { ...f }))
              : at.frames.map((f) => (f as number) + firstgid);
            animatedTiles[at.id] = {
              ...at,
              frames,
              _src: multiTileset
                ? { key: `tileset:${st.id}`, tileW: st.tileW, tileH: st.tileH, marginX: st.offsetX, marginY: st.offsetY, spacingX: st.spacingX, spacingY: st.spacingY }
                : undefined,
              drops: at.drops ? at.drops.map((d) => ({ ...d })) : undefined,
            };
          }
        }
        const fullW = Math.max(1, map.cols * tileW);
        const fullH = Math.max(1, map.rows * tileH);
        const sprite = g.sprite({ color: 0, w: fullW, h: fullH }).at(inst.x + fullW / 2, inst.y + fullH / 2);
        sprite.instanceId = inst.id;
        const { layer, idx: layerIdx } = resolveLayer(inst.layerId);
        const baseDepth = layerBaseDepth(layerIdx) + (inst.z ?? 0) * Z_STEP
          + (tmStackIdx.get(inst.id) ?? 0) * TILEMAP_STACK_BAND;
        const zMult = zParallaxMult(inst.z ?? 0);
        sprite.gameObject.setScrollFactor(layer.parallaxX * zMult, layer.parallaxY * zMult);
        sprite.gameObject.setDepth(baseDepth);
        sprite.gameObject.setVisible(layer.visible);
        sprite.layerId = layer.id;
        sprite.addBehavior(TilemapRenderer, {
          tilemapId: map.id,
          name: map.name ?? "",
          textureKey: ts ? `tileset:${ts.id}` : "",
          // Ordered tileset slots (texture key + firstgid + geometry). When more
          // than one, the runtime reflows them into a single combined texture so
          // the rest of the renderer stays single-texture / single-grid.
          tilesets: tmSlots.map((s, i) => ({
            textureKey: `tileset:${s.ts.id}`,
            firstgid: slotRanges[i].contigFg,
            cols: s.ts.cols,
            rows: s.ts.rows,
            tileW: s.ts.tileW,
            tileH: s.ts.tileH,
            marginX: s.ts.offsetX,
            marginY: s.ts.offsetY,
            spacingX: s.ts.spacingX,
            spacingY: s.ts.spacingY,
          })),
          // Sorted by ascending z here so the renderer's z-order is stable.
          // Defaults guard against legacy layers that pre-date some fields.
          layers: [...map.layers].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((L) => ({
            id: L.id,
            name: L.name,
            // Translate the painter's STABLE sparse ids → the runtime's
            // contiguous combined ids. (Also clones, so runtime SetTile/dig
            // mutations never bleed back into the saved project.)
            tiles: Array.isArray(L.tiles) ? L.tiles.map(toContig) : new Array(map.cols * map.rows).fill(-1),
            xf: L.xf ? { ...L.xf } : undefined,
            z: L.z ?? 0,
            alpha: L.alpha ?? 1,
            visible: L.visible !== false,
            collides: L.collides !== false,
            allowOverlap: L.allowOverlap === true,
            // Clone the placements list too — Tier 3 BigTile actions will mutate
            // it (RemoveBigTile / PlaceBigTile); keep editor data untouched.
            bigTilePlacements: (L.bigTilePlacements ?? []).map((p) => ({ ...p })),
            animatedTilePlacements: (L.animatedTilePlacements ?? []).map((p) => ({ ...p })),
            // Effective layer tags = layer's NAME + tilemap's NAME + the
            // tilemap-wide explicit tags. Layer/tilemap names act as implicit
            // tags so excluding "ground" Just Works for a layer called
            // "ground" — no separate tag entry needed. Deduped + filtered
            // for untitled assets.
            tags: Array.from(new Set([
              L.name,
              map.name,
              ...(map.tags ?? []),
            ].filter((t) => t && t.length > 0))),
            ySort: L.ySort === true,
          })),
          cols: map.cols,
          rows: map.rows,
          tileW,
          tileH,
          marginX: ts?.offsetX ?? 0,
          marginY: ts?.offsetY ?? 0,
          spacingX: ts?.spacingX ?? 0,
          spacingY: ts?.spacingY ?? 0,
          // Merged + global-offset collision / mining data (identical to the
          // single tileset's own data when the map has one tileset).
          solidIndices,
          tileColliders,
          tileHardness,
          tileGrowBack,
          tileGrowBackPop,
          tileDrops,
          tileDropLayer,
          globalExcludedTags: Array.from(globalExcludedTags),
          tileExcludedTags,
          tileOnBelowRemoved,
          ySort: !!layer.ySort,
          bigTiles,
          animatedTiles,
          tilesetCols: ts?.cols ?? 0,
          tilesetRows: ts?.rows ?? 0,
        });
        if (sprite.lastBehavior) {
          const a = layer.opacity * (inst.alpha ?? 1);
          sprite.lastBehavior.applyLayer(layer.parallaxX * zMult, layer.parallaxY * zMult, baseDepth, a, layer.visible);
        }
        spawned.push({ sprite, tags: [], bpId: inst.tilemapId });
      } catch (err) {
        // Don't let one bad tilemap kill the whole game boot — log + skip.
        console.error(`Failed to spawn tilemap instance ${inst.id}:`, err);
      }
    }

    // ─── Main Event Sheet host ─────────────────────────────────────────
    // Spawn an invisible "world host" sprite that owns the scene's main
    // event sheet. No body (disabled, doesn't participate in collisions,
    // hit-tests, gravity), no visuals (alpha 0, hideRect), no tags so
    // tag-based lookups can't accidentally match it. Lives in
    // peaky.sprites so the standard tick loop ticks its events every
    // frame just like a normal BP. Variables on it act as global game
    // vars (score, time-of-day, etc.) — readable from any BP via
    // `var:World.<name>` thanks to the cross-BP var: lookup matching by
    // blueprintName.
    const hasMainSheet =
      (scene.mainEvents?.length ?? 0) > 0 ||
      (scene.mainEventGroups?.length ?? 0) > 0 ||
      (scene.mainVariables?.length ?? 0) > 0;
    if (hasMainSheet) {
      const worldHost = g.sprite({ color: 0, w: 1, h: 1 }).at(-9999, -9999);
      worldHost.blueprintName = "World";
      worldHost.blueprintId = `__main__:${scene.id}`;
      worldHost.instanceName = "World";
      worldHost.body.enable = false;
      worldHost.body.allowGravity = false;
      worldHost.gameObject.setVisible(false);
      worldHost.gameObject.setAlpha(0);
      worldHost.gameObject.setScrollFactor(0, 0);
      // Seed declared global vars so `var:World.<name>` resolves to its
      // default (not undefined → 0) on the very first tick.
      for (const v of scene.mainVariables ?? []) {
        worldHost.vars.set(v.name, v.default);
      }
      worldHost.attachEvents(
        (scene.mainEvents ?? []).map(toEventSpec),
        (scene.mainEventGroups ?? []).map(toEventGroupSpec),
      );
      spawned.push({ sprite: worldHost, tags: [], bpId: `__main__:${scene.id}` });
    }

    // ─── Main Logic Sheets — project-level, multi, activatable ─────────
    // Each enabled main sheet gets its own hidden host sprite that the
    // standard Logic Sheet runtime attaches to. Spawning ONE host per
    // sheet (rather than reusing the worldHost) keeps each sheet's
    // trigger subscriptions independent — disabling sheet A doesn't
    // touch sheet B's listeners. Hidden, body-disabled, untagged, so
    // they don't interact with collisions / picking / variable lookups.
    const enabledMainSheets = (project.mainLogicSheets ?? []).filter((s) => s.enabled);
    for (const ms of enabledMainSheets) {
      if (!ms.sheet || (ms.sheet.folders?.length ?? 0) === 0) continue;
      const mainHost = g.sprite({ color: 0, w: 1, h: 1 }).at(-9999, -9999);
      mainHost.blueprintName = "MainLogicSheet";
      mainHost.blueprintId = `__main_logic__:${ms.id}`;
      mainHost.instanceName = ms.name;
      mainHost.body.enable = false;
      mainHost.body.allowGravity = false;
      mainHost.gameObject.setVisible(false);
      mainHost.gameObject.setAlpha(0);
      mainHost.gameObject.setScrollFactor(0, 0);
      attachLogicSheet(mainHost, ms.sheet as unknown as RuntimeLogicSheet);
      spawned.push({ sprite: mainHost, tags: [], bpId: `__main_logic__:${ms.id}` });
    }

    // Register the spawn callback on the scene so the runtime CreateObject /
    // CreateObjectByName actions can call into it. Runtime spawns inherit
    // the scene's active layer (no per-action layer arg in v1).
    const sceneForRegistry = spawned[0]?.sprite.scene;
    if (sceneForRegistry) {
      // Resolve a layer NAME (as used by the CreateObject action's
      // optional `layer` config) to its layerId. Falls back to the
      // scene's active layer when name is empty / unknown — preserves
      // legacy behavior for callers that omit the field.
      const layerIdByName = (nameOrId?: string): string | undefined => {
        if (!nameOrId) return scene.activeLayerId;
        // Layer ID first — internal callers (TilemapRenderer drop spawn) pass
        // a raw layerId so drops land on the SAME scene layer as the tilemap.
        // User-authored CreateObject actions pass a layer NAME.
        const byId = scene.layers.find((l) => l.id === nameOrId);
        if (byId) return byId.id;
        const byName = scene.layers.find((l) => l.name === nameOrId);
        if (byName) return byName.id;
        console.warn(`[Peaky] Spawn: layer "${nameOrId}" not found — falling back to active layer`);
        return scene.activeLayerId;
      };
      // Project-level spawn budget. 0 (default) = unlimited synchronous
      // spawn. When > 0, CreateObject spawns past N per frame queue and
      // drain on subsequent ticks via Game.ts's start-of-frame drain.
      // Stored on scene.data so Game.ts reads the same value.
      const projectSpawnBudget = Math.max(0, Math.floor(project.spawnBudgetPerFrame ?? 0));
      sceneForRegistry.data.set("peaky.spawnBudgetPerFrame", projectSpawnBudget);
      // Expose wireCollisionsFor for the runtime wake check
      // (Sprite._runWakeCheck calls it lazily for distance-gated BPs).
      sceneForRegistry.data.set("peaky.wireCollisionsFor", wireCollisionsFor);

      // Door arrival — if we reached this scene through a Door, move the traveler
      // (tagged sprite, default "player") onto the destination door's authored
      // position. Consumes the one-shot pending entry so a later reload doesn't
      // re-teleport. Runs under the loader cover, so the placement isn't seen.
      {
        const pendingEntry = takePendingEntry();
        // With a loader, the LOADER scene builds BEFORE the destination — it must
        // NOT consume the entry. Only consume it when THIS scene is the target;
        // otherwise put it back so the real destination's build repositions.
        if (pendingEntry && pendingEntry.destSceneId !== scene.id) setPendingEntry(pendingEntry);
        if (pendingEntry && pendingEntry.destSceneId === scene.id) {
          const destInst = scene.instances.find((i) => !!i.door?.name && i.door.name === pendingEntry.destDoor);
          const tag = (pendingEntry.travelerTag && pendingEntry.travelerTag.trim()) || "player";
          const list = (sceneForRegistry.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          const traveler = list.find((s) => !s.destroyed && s.tags.has(tag));
          if (destInst && traveler?.gameObject) {
            const body = (traveler.gameObject as { body?: { reset?: (x: number, y: number) => void } }).body;
            if (body?.reset) body.reset(destInst.x, destInst.y);
            else traveler.gameObject.setPosition(destInst.x, destInst.y);
          } else if (!destInst) {
            Logger.log({ level: "warn", source: "Door", message: `Arrival door "${pendingEntry.destDoor}" not found in scene "${scene.name}" — traveler left at its authored position.` });
          }
        }
      }

      // Scene-ready gate. Fires `peaky:sceneReady` on the container once EVERY
      // TilemapRenderer has actually rendered (a map that deferred on a missing
      // texture flips `rendered` true when its retry re-runs `_init`), plus one
      // extra painted frame so Phaser has drawn the finished scene. The loader's
      // cover holds until this fires — see ScenePanel's GoToLayoutWithLoad path.
      {
        let sawAllReady = false;
        const check = () => {
          const list = (sceneForRegistry.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          for (const s of list) {
            if (s.destroyed) continue;
            const tr = s.findBehaviorByKind?.("TilemapRenderer") as { rendered?: boolean } | undefined;
            if (tr && !tr.rendered) { sawAllReady = false; return; }
          }
          // First frame everything's ready → wait one more so it's been painted.
          if (!sawAllReady) { sawAllReady = true; return; }
          sceneForRegistry.events.off(Phaser.Scenes.Events.POST_UPDATE, check);
          // The DOM event is the ONLY consumer (ScenePanel's cover) — no
          // scene.data mirror; a stale data flag misled a prior audit.
          try { parent.dispatchEvent(new CustomEvent("peaky:sceneReady", { bubbles: true })); } catch { /* headless */ }
        };
        sceneForRegistry.events.on(Phaser.Scenes.Events.POST_UPDATE, check);
        // scene.events survives scene.restart() (Phaser only clears TRANSITION_*)
        // — a run that ends before every tilemap rendered would leak this checker
        // into the NEXT run, where its stale closure can fire a premature
        // `peaky:sceneReady` and drop the cover on an unpainted frame.
        sceneForRegistry.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
          sceneForRegistry.events.off(Phaser.Scenes.Events.POST_UPDATE, check);
        });
      }
      // Object pool — Map<bpId, inactiveSpriteList>. Populated by the
      // pool-fill loop at scene end; consulted by peaky.spawn (pop on
      // spawn) and by Sprite.destroy via peaky.deactivateToPool (push
      // on death). For BPs with poolSize=0, no entry exists and the
      // spawn/destroy paths fall through to fresh allocation / full
      // teardown.
      const spritePool = new Map<string, Sprite[]>();
      sceneForRegistry.data.set("peaky.spritePool", spritePool);
      sceneForRegistry.data.set("peaky.deactivateToPool", deactivateToPool);
      sceneForRegistry.data.set("peaky.spawn", (
        arg: { id?: string; name?: string; x: number; y: number; layer?: string; vars?: Record<string, number | string | boolean>; instanceName?: string; animation?: string; frame?: number; tag?: string },
        opts?: { immediate?: boolean },
      ): Sprite | null => {
        // Spawn budget gate. Author-controlled via project setting
        // `spawnBudgetPerFrame` (default 0 = OFF). FireProjectile passes
        // `immediate: true` regardless so bullets always fire same-frame.
        // When the budget is 0, every spawn is treated as immediate —
        // back to the original synchronous-spawn behavior that produces
        // a brief scene-start freeze but no visible slow ramp.
        const budget = projectSpawnBudget;
        if (budget > 0 && !opts?.immediate) {
          const used = (sceneForRegistry.data.get("peaky.spawnsThisFrame") as number | undefined) ?? 0;
          if (used >= budget) {
            const queue = (sceneForRegistry.data.get("peaky.spawnQueue") as Array<{ arg: typeof arg; byName: boolean }> | undefined) ?? [];
            queue.push({ arg, byName: !!arg.name });
            sceneForRegistry.data.set("peaky.spawnQueue", queue);
            return null;
          }
          sceneForRegistry.data.set("peaky.spawnsThisFrame", used + 1);
        }
        // Lookup precedence: explicit `name` first, then `id` as id, then
        // `id` as a name fallback. Why: when CreateObjectByName passes a
        // name and a BP happens to share that string as its synthetic
        // id (extremely rare but possible after manual JSON edits), the
        // user's intent was clearly "by name" — favor that. CreateObject
        // passes id; we still try name fallback if the id lookup misses
        // (covers the "user typed BP_NPC into the id field" path the
        // ActionRow picker now prevents but legacy projects may carry).
        let bp = arg.name ? project.blueprints.find((b) => b.name === arg.name) : undefined;
        if (!bp && arg.id) bp = findBlueprint(project, arg.id);
        if (!bp && arg.id) bp = project.blueprints.find((b) => b.name === arg.id);
        if (!bp) {
          console.warn("[Peaky] Spawn: blueprint not found", arg, "— available names:", project.blueprints.map((b) => b.name).join(", "));
          return null;
        }
        // Per-spawn vars (`exposeOnSpawn`-flagged variables). Filter to
        // only keys the BP actually declares so a stale spawnVar entry
        // (variable was renamed/deleted on the BP after the action was
        // authored) is silently dropped instead of becoming a ghost
        // entry on the spawned sprite.
        let instVars: Record<string, number | string | boolean> | undefined;
        if (arg.vars) {
          const valid = new Set(bp.variables.map((v) => v.name));
          for (const [k, v] of Object.entries(arg.vars)) {
            if (!valid.has(k)) continue;
            (instVars ??= {})[k] = v;
          }
        }
        // Object pool — try to reactivate an inactive pooled sprite
        // before falling back to a fresh allocation. Pool storage is
        // a Map<bpId, Sprite[]> on scene.data. When the pool for this BP
        // has an entry, pop it, reset state, reposition, return.
        const poolMap = sceneForRegistry.data.get("peaky.spritePool") as Map<string, Sprite[]> | undefined;
        const pool = poolMap?.get(bp.id);
        if (pool && pool.length > 0) {
          const reused = pool.pop()!;
          reactivatePooledSprite(reused, arg.x, arg.y, layerIdByName(arg.layer), instVars, arg.animation, arg.frame);
          if (arg.instanceName) reused.instanceName = arg.instanceName;
          if (arg.tag) addSpriteTag(sceneForRegistry, reused, arg.tag);
          reused.spawnId = nextSpawnId();
          reused.spawnLayerName = arg.layer ?? "";
          applyLayerFXToSprite(reused);
          return reused;
        }
        const spawned = spawnFromBlueprint(bp, arg.x, arg.y, layerIdByName(arg.layer), undefined, undefined, instVars, undefined, undefined, arg.animation, arg.frame);
        if (spawned && arg.instanceName) spawned.instanceName = arg.instanceName;
        if (spawned && arg.tag) addSpriteTag(sceneForRegistry, spawned, arg.tag);
        if (spawned) { spawned.spawnId = nextSpawnId(); spawned.spawnLayerName = arg.layer ?? ""; }
        if (spawned) applyLayerFXToSprite(spawned);
        return spawned;
      });
      // Runtime UI widget spawn — used by the CreateUIWidget action.
      // Looks the widget up by NAME (so the user can author the action
      // with a stable, human-readable identifier).
      sceneForRegistry.data.set("peaky.spawnUIWidget", (arg: { name: string; x: number; y: number; layer?: string }) => {
        const w = project.uiWidgets.find((x) => x.name === arg.name);
        if (!w) {
          console.warn("[Peaky] CreateUIWidget: widget not found", arg);
          return;
        }
        // Synthesize a transient instanceId so DestroyUIWidget cascade
        // works on widgets spawned at runtime (not just scene-placed).
        const synthId = `uiinst_rt_${Math.random().toString(36).slice(2, 10)}`;
        spawnFromUIWidget(w.id, arg.x, arg.y, layerIdByName(arg.layer), undefined, undefined, synthId);
      });
      // Attached-widget spawn callback was already registered BEFORE the
      // BP spawn loop (above) so each BP's Widget.init() can find it. No
      // second registration needed here.
      // Make the scene name list available so GoToNextLayout works.
      sceneForRegistry.data.set("peaky.sceneList", project.scenes.map((s) => s.name));
      // Record which Peaky scene this Phaser scene is currently hosting,
      // so IsScene / GoToNextLayout can compare by name. Phaser only has
      // one scene key ("main") — without this the conditions would have
      // no way to distinguish layouts.
      sceneForRegistry.data.set("peaky.activeSceneName", scene.name);
      // Stable scene id for the spawned-object capture on level exit (see
      // captureSpawnedForScene in eval.ts). activeSceneName is by name; this
      // is the stable id used to bucket each level's carried-over spawns.
      sceneForRegistry.data.set("peaky.sceneId", scene.id);
      // Replay runtime-spawned objects (placed candles / drops) carried over
      // from the last time the player was in THIS level — captured into
      // PersistentState on level exit. Authored instances are already placed
      // above; these are the things the scene itself can't re-create. Runs
      // through peaky.spawn so each one is fully wired (collisions, layer FX).
      // DEFINED here but RUN later (see replayCarriedSpawns() below) — sprite
      // objects need peaky.projectSprites on scene.data to recreate, and that's
      // set further down; running here would make spawnRuntimeSpriteObject bail.
      const replayCarriedSpawns = () => {
        type SpawnRec = { k?: string; spawnId: string; bpId?: string; bpName?: string; spriteId?: string; layer?: string; x: number; y: number; facingScaleX?: number; sx?: number; sy?: number; angle?: number; vars?: Record<string, unknown>; behaviors?: Array<{ kind: string; state: Record<string, unknown> }> };
        const recs = getSceneSpawns(scene.id) as SpawnRec[];
        if (recs.length) {
          const spawnFn = sceneForRegistry.data.get("peaky.spawn") as
            | ((arg: { id?: string; name?: string; x: number; y: number; layer?: string }, opts?: { immediate?: boolean }) => Sprite | null)
            | undefined;
          for (const rec of recs) {
            // Runtime sprite objects ride the same per-scene list (k:"so") but
            // recreate through their own lightweight path, not peaky.spawn.
            if (rec.k === "so" && rec.spriteId) {
              const go = spawnRuntimeSpriteObject(sceneForRegistry, rec.spriteId, rec.x, rec.y, rec.layer ?? "");
              if (go) {
                if (typeof rec.sx === "number" && typeof rec.sy === "number") go.setScale(rec.sx, rec.sy);
                if (typeof rec.angle === "number") go.angle = rec.angle;
              }
              continue;
            }
            const created = spawnFn?.({ id: rec.bpId, name: rec.bpName, x: rec.x, y: rec.y, layer: rec.layer || undefined }, { immediate: true });
            if (!created) continue;
            created.spawnId = rec.spawnId;
            created.spawnLayerName = rec.layer ?? "";
            if (typeof rec.facingScaleX === "number") created.facingScaleX = rec.facingScaleX;
            if (typeof rec.sx === "number" && typeof rec.sy === "number") created.gameObject.setScale(rec.sx, rec.sy);
            if (typeof rec.angle === "number") created.gameObject.angle = rec.angle;
            if (rec.vars) { created.vars.clear(); for (const [k, v] of Object.entries(rec.vars)) created.vars.set(k, v as never); }
            if (rec.behaviors) {
              const usedByKind = new Map<string, Set<number>>();
              for (const entry of rec.behaviors) {
                const candidates = created.findBehaviorsByKind(entry.kind as never) as Array<{ deserialize: (s: Record<string, unknown>) => void }>;
                let used = usedByKind.get(entry.kind);
                if (!used) { used = new Set(); usedByKind.set(entry.kind, used); }
                let target: { deserialize: (s: Record<string, unknown>) => void } | undefined;
                for (let i = 0; i < candidates.length; i++) { if (used.has(i)) continue; target = candidates[i]; used.add(i); break; }
                if (target) { try { target.deserialize(entry.state); } catch (e) { console.warn("[Peaky] carried-spawn deserialize threw", e); } }
              }
            }
          }
        }
      };
      // Expose a layer-by-name lookup so the MoveToLayer action can
      // re-bind a sprite to a different layer at runtime (parallax,
      // visibility, base depth band).
      const layerLookup: Record<string, { parallaxX: number; parallaxY: number; visible: boolean; baseDepth: number }> = {};
      for (let i = 0; i < scene.layers.length; i++) {
        const l = scene.layers[i];
        layerLookup[l.name] = {
          parallaxX: l.parallaxX,
          parallaxY: l.parallaxY,
          visible: l.visible,
          baseDepth: layerBaseDepth(i),
        };
      }
      sceneForRegistry.data.set("peaky.layers", layerLookup);
      // Layer NAME → id, so the SetPaused action (authored with a layer name)
      // can mark the right layer id in peaky.pausedLayers, which Sprite.tick
      // compares against each sprite's `layerId`.
      const layerIdByNameMap: Record<string, string> = {};
      for (const l of scene.layers) layerIdByNameMap[l.name] = l.id;
      sceneForRegistry.data.set("peaky.layerIdByName", layerIdByNameMap);
      // ─── SpritePlacement spawn ──────────────────────────────────────
      // Direct sprite drops — no Blueprint wrapper, no behaviors. Each is a
      // Phaser.GameObjects.Sprite using the picked animation's frame
      // textures (loaded via buildSpritePreload's asset warm). When
      // `playing`, the placement loops via a recurring scene timer driven
      // by the animation's fps. Optional AABB collider when `hasCollider`
      // is set — same arcade body the engine uses for BPs, so tag-based
      // collide / overlap (CollisionScan.ts) just works.
      for (const placement of scene.spritePlacements ?? []) {
        const asset = project.sprites.find((s) => s.id === placement.spriteId);
        if (!asset) {
          console.warn(`[Runtime] skip placement ${placement.id}: sprite ${placement.spriteId} not found`);
          continue;
        }
        // `||` not `??` — `??` would leave an empty `placement.animation`
        // string as the result (falsy ≠ nullish), then `anim.frames`
        // would crash. With `||`, empty/missing animation falls back to
        // the asset's first animation.
        const anim = (placement.animation && asset.animations.find((a) => a.name === placement.animation))
          || asset.animations[0];
        // Empty sprite (no animations OR an animation with 0 frames):
        // render a colored rectangle so the placement is at least
        // visible. Author can populate frames later without re-dropping.
        const hasFrames = !!anim && anim.frames.length > 0;
        const startIdx = hasFrames
          ? Math.max(0, Math.min(anim.frames.length - 1, placement.startFrame ?? 0))
          : 0;
        const firstKey = hasFrames ? frameTextureKey(asset.id, anim.id, startIdx) : "";
        const textureExists = hasFrames && sceneForRegistry.textures.exists(firstKey);
        const go = sceneForRegistry.add.sprite(placement.x, placement.y, textureExists ? firstKey : "__DEFAULT");
        if (!textureExists) {
          // Either the sprite has no frames at all, or the first frame
          // has no image. Either way, render a visible colored rectangle
          // using the asset's width/height (or the frame's color hex).
          const colorHex = hasFrames ? (anim.frames[startIdx].color & 0xffffff) : 0xff00ff;
          go.setTexture("__DEFAULT");
          go.setTint(colorHex);
          go.setDisplaySize(asset.width || 32, asset.height || 32);
          if (!hasFrames) {
            console.warn(`[Runtime] placement ${placement.id}: sprite "${asset.name}" has no frames — rendering color fallback. Add an animation + frame in the Sprite tab to show actual art.`);
          } else {
            console.warn(`[Runtime] placement ${placement.id}: texture "${firstKey}" not preloaded — rendering color fallback. Add an image to this sprite's frame in the Sprite tab.`);
          }
        }
        go.setScale(placement.scaleX ?? 1, placement.scaleY ?? 1);
        go.setRotation(((placement.rotation ?? 0) * Math.PI) / 180);
        go.setAlpha(placement.alpha ?? 1);
        go.setFlip(placement.flipX ?? false, placement.flipY ?? false);
        if (placement.visible === false) go.setVisible(false);
        // Layer binding (parallax, depth, alpha multiplier).
        const layerName = scene.layers.find((l) => l.id === placement.layerId)?.name ?? "";
        // Stamp the layer NAME so VisionMask's cutoutLayers filter can match this
        // placement (it lives outside peaky.sprites, so this is its only layer tag).
        if (layerName) go.setData("peaky.soLayer", layerName);
        const layer = layerLookup[layerName];
        if (layer) {
          go.setScrollFactor(layer.parallaxX, layer.parallaxY);
          go.setDepth(layer.baseDepth);
          if (!layer.visible) go.setVisible(false);
        }
        // Hide the placement from the UI camera so it doesn't render
        // twice (once on main, once on UI). Without this `ignore` call
        // the sprite appears in BOTH cameras' views — visible as a
        // "ghost duplicate" especially when zooming the main camera.
        // Same pattern Sprite.routeOverlayToCamera uses for BP overlays.
        const uiCam = sceneForRegistry.data.get("peaky.uiCam") as Phaser.Cameras.Scene2D.Camera | undefined;
        if (uiCam) uiCam.ignore(go);
        // Animation runner — only meaningful when frames exist. For
        // empty sprites the placement is a static color rect; no timer.
        let curIdx = startIdx;
        let timer: Phaser.Time.TimerEvent | null = null;
        if (hasFrames) {
          const animLocal = anim;
          const fps = Math.max(1, animLocal.fps || 12);
          const frameMs = Math.max(20, Math.round(1000 / fps));
          // Per-frame body resize: when a new frame's collider differs
          // from the previous one (attack frame grows the hitbox, idle
          // shrinks), swap the body dims live. Skipped when this
          // placement has no physics body (hasCollider=false).
          const applyFrameCollider = () => {
            const body = (go.body as Phaser.Physics.Arcade.Body | null);
            if (!body) return;
            const fc = animLocal.frames[curIdx]?.collider;
            if (fc?.enabled) {
              body.setSize(fc.width, fc.height, true);
              // Offset is RELATIVE to the centered body — add it, don't replace
              // (replacing re-anchors to the top-left and shifts the hitbox off
              // the sprite). Same fix as the initial-spawn collider above.
              if (fc.offsetX !== 0 || fc.offsetY !== 0) {
                body.setOffset(body.offset.x + fc.offsetX, body.offset.y + fc.offsetY);
              }
            }
          };
          const stepFrame = () => {
            curIdx = animLocal.loop
              ? (curIdx + 1) % animLocal.frames.length
              : Math.min(curIdx + 1, animLocal.frames.length - 1);
            const k = frameTextureKey(asset.id, animLocal.id, curIdx);
            if (sceneForRegistry.textures.exists(k)) go.setTexture(k);
            applyFrameCollider();
            if (curIdx < animLocal.frames.length - 1 || animLocal.loop) {
              timer = sceneForRegistry.time.delayedCall(frameMs, stepFrame);
            } else {
              timer = null;
            }
          };
          if (placement.playing && animLocal.frames.length > 1) {
            timer = sceneForRegistry.time.delayedCall(frameMs, stepFrame);
          }
          go.setData("peaky.placementSetFrame", (idx: number) => {
            const safe = Math.max(0, Math.min(animLocal.frames.length - 1, idx));
            curIdx = safe;
            const k = frameTextureKey(asset.id, animLocal.id, safe);
            if (sceneForRegistry.textures.exists(k)) go.setTexture(k);
          });
          go.setData("peaky.placementSetPlaying", (v: boolean) => {
            if (v && !timer && animLocal.frames.length > 1) {
              timer = sceneForRegistry.time.delayedCall(frameMs, stepFrame);
            } else if (!v && timer) {
              timer.remove(false); timer = null;
            }
          });
        }
        go.setData("peaky.placementName", placement.name);
        // Animation switcher — PlayPlacementAnim action invokes this to
        // swap to a different animation, optionally non-looping, starting
        // at a specific frame. Builds a fresh timer for the new anim and
        // disposes the old one. Closure captures `asset` so the texture
        // keys resolve correctly.
        go.setData("peaky.placementSwitchAnim", (animName: string, opts: { loop?: boolean; startFrame?: number; destroyOnFinish?: boolean } = {}) => {
          const newAnim = animName
            ? asset.animations.find((a) => a.name === animName)
            : asset.animations[0];
          if (!newAnim || newAnim.frames.length === 0) return;
          // Stop the previous timer so animations don't stack.
          if (timer) { timer.remove(false); timer = null; }
          const newStart = Math.max(0, Math.min(newAnim.frames.length - 1, opts.startFrame ?? 0));
          curIdx = newStart;
          const k0 = frameTextureKey(asset.id, newAnim.id, newStart);
          if (sceneForRegistry.textures.exists(k0)) go.setTexture(k0);
          const fps = Math.max(1, newAnim.fps || 12);
          const frameMsN = Math.max(20, Math.round(1000 / fps));
          // destroyOnFinish forces a single pass (looping would never "finish")
          // and tears down the placement when the animation ends — fire-and-forget
          // one-shot VFX cleanup.
          const dof = !!opts.destroyOnFinish;
          const shouldLoop = dof ? false : (opts.loop ?? newAnim.loop);
          const destroySelf = () => {
            if (timer) { timer.remove(false); timer = null; }
            const m = sceneForRegistry.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined;
            const lst = m?.get(placement.spriteId);
            if (lst) { const i = lst.indexOf(go); if (i >= 0) lst.splice(i, 1); }
            go.destroy();
          };
          const stepNew = () => {
            curIdx = shouldLoop
              ? (curIdx + 1) % newAnim.frames.length
              : Math.min(curIdx + 1, newAnim.frames.length - 1);
            const k = frameTextureKey(asset.id, newAnim.id, curIdx);
            if (sceneForRegistry.textures.exists(k)) go.setTexture(k);
            if (curIdx < newAnim.frames.length - 1 || shouldLoop) {
              timer = sceneForRegistry.time.delayedCall(frameMsN, stepNew);
            } else {
              timer = null;
              if (dof) destroySelf();
            }
          };
          if (newAnim.frames.length > 1) {
            timer = sceneForRegistry.time.delayedCall(frameMsN, stepNew);
          } else if (dof) {
            timer = sceneForRegistry.time.delayedCall(frameMsN, destroySelf);
          }
        });
        // Optional collider. Placements are Phaser GameObjects (NOT
        // Peaky Sprites), so Peaky's tag-based CollisionScan ignores them.
        // We register Phaser colliders directly against the live Peaky
        // sprite list.
        // Source-of-truth for collider DIMS, in priority order:
        //   1. The current frame's `collider` (set in the Sprite tab) —
        //      lets attack frames grow the hitbox, idle frames shrink it.
        //   2. The placement's per-instance W/H — manual override.
        //   3. The sprite asset's natural size — "fit to sprite" default.
        // The placement-level `hasCollider` toggle is the master switch;
        // when off, nothing spawns regardless of frame-level config.
        if (placement.hasCollider) {
          sceneForRegistry.physics.add.existing(go, false);
          const body = (go.body as Phaser.Physics.Arcade.Body | undefined);
          if (body) {
            const frame0Collider = hasFrames ? anim.frames[startIdx].collider : undefined;
            const fitSprite = placement.colliderFitSprite !== false;
            let w: number, h: number, offX = 0, offY = 0;
            if (frame0Collider?.enabled) {
              w = frame0Collider.width;
              h = frame0Collider.height;
              offX = frame0Collider.offsetX;
              offY = frame0Collider.offsetY;
            } else if (fitSprite) {
              w = asset.width  || go.width  || 32;
              h = asset.height || go.height || 32;
            } else {
              w = placement.colliderWidth  || 32;
              h = placement.colliderHeight || 32;
            }
            body.setSize(w, h, true);
            // Per-frame offset takes priority; falls back to per-instance. The
            // offset is RELATIVE to the centered body (setSize(...,true) already
            // centered it), so ADD it to the current centered offset — replacing
            // it would re-anchor the body to the top-left corner, shifting the
            // collider off the sprite and letting the player penetrate.
            const finalOffX = offX !== 0 ? offX : (placement.colliderOffsetX ?? 0);
            const finalOffY = offY !== 0 ? offY : (placement.colliderOffsetY ?? 0);
            if (finalOffX !== 0 || finalOffY !== 0) {
              body.setOffset(body.offset.x + finalOffX, body.offset.y + finalOffY);
            }
            body.setImmovable(true);
            body.allowGravity = false;
            if (placement.tags && placement.tags.length > 0) {
              go.setData("peaky.tags", placement.tags);
            }
            // Register Phaser physics against live Peaky sprites, filtered
            // by the include/exclude tag mode the author chose. Future
            // dynamic spawns (via CreateObject) won't auto-collide yet —
            // covers walls + decorations against the player for V1.
            const allSprites = (sceneForRegistry.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
            // Seed runtime data:
            //   peaky.tags          → IDENTITY tags this placement carries.
            //                         Read by HasSpriteObjectTag and tag
            //                         conditions on other sprites.
            //   peaky.collideTags   → COLLIDE FILTER tag list.
            //   peaky.tagMode       → collide filter mode (include/exclude).
            // The collision callbacks read these via go.getData every fire
            // so runtime mutations (Add/RemoveSpriteObjectTag,
            // SetSpriteObjectCollideMode) take effect immediately.
            go.setData("peaky.tags", [...(placement.tags ?? [])]);
            go.setData("peaky.collideTags", [...(placement.collideFilterTags ?? [])]);
            go.setData("peaky.tagMode", placement.collideFilterMode ?? placement.tagMode ?? "include");
            go.setData("peaky.solid", !!placement.colliderBlocks);
            const tagMatches = (s: Sprite): boolean => {
              const filterTags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
              if (filterTags.length === 0) {
                const mode = (go.getData("peaky.tagMode") as string | undefined) ?? "include";
                return mode === "include";
              }
              const tagSetLive = new Set(filterTags);
              for (const t of s.tags) if (tagSetLive.has(t)) return true;
              return false;
            };
            const shouldCollide = (s: Sprite): boolean => {
              const mode = (go.getData("peaky.tagMode") as string | undefined) ?? "include";
              const matched = tagMatches(s);
              return mode === "include" ? matched : !matched;
            };
            // Frame-exception check: returns true when the current animation
            // frame's `exceptionTags` overlap the other sprite's tags. When
            // true, the placement IGNORES this collision THIS FRAME — for
            // attack frames exempting teammates, block frames exempting
            // projectiles, etc. The closure reads `curIdx` and `anim` from
            // the outer scope so it always sees the LIVE animation state.
            const frameExempts = (otherSprite: Sprite): boolean => {
              if (!hasFrames) return false;
              const frameCfg = anim.frames[curIdx]?.collider;
              if (!frameCfg?.enabled) return false;
              const exempt = frameCfg.exceptionTags;
              if (!exempt || exempt.length === 0) return false;
              for (const t of exempt) if (otherSprite.tags.has(t)) return true;
              return false;
            };
            // Instance filter overrides frame exemption — when the
            // placement's collide-filter list is non-empty, frameExempts
            // is ignored. Matches the Sprite tab's exception-tag hint.
            const frameExemptsRespected = (otherSprite: Sprite): boolean => {
              const filterTags = (go.getData("peaky.collideTags") as string[] | undefined) ?? [];
              if (filterTags.length > 0) return false;
              return frameExempts(otherSprite);
            };
            for (const otherSprite of allSprites) {
              if (!otherSprite.gameObject || !otherSprite.gameObject.body) continue;
              if (!shouldCollide(otherSprite)) continue;
              if (placement.colliderBlocks) {
                sceneForRegistry.physics.add.collider(
                  otherSprite.gameObject as Phaser.Types.Physics.Arcade.GameObjectWithBody,
                  go,
                  () => firePlacementContact(otherSprite, go, "_placementCollide", placement.spriteId),
                  () => !frameExemptsRespected(otherSprite),
                );
              } else {
                sceneForRegistry.physics.add.overlap(
                  otherSprite.gameObject as Phaser.Types.Physics.Arcade.GameObjectWithBody,
                  go,
                  () => firePlacementContact(otherSprite, go, "_placementOverlap", placement.spriteId),
                  () => !frameExemptsRespected(otherSprite),
                );
              }
            }
          }
        }
        // Index by SPRITE ASSET ID — multiple placements can share the
        // same sprite (you drop the same tree art 10 times) and a Set
        // Sprite Object … action targets ALL of them via the asset id.
        // The map's value is a list per spriteId for that reason.
        const idx = (sceneForRegistry.data.get("peaky.placementsBySpriteId") as Map<string, Phaser.GameObjects.Sprite[]> | undefined) ?? new Map();
        const list = idx.get(placement.spriteId) ?? [];
        list.push(go);
        idx.set(placement.spriteId, list);
        sceneForRegistry.data.set("peaky.placementsBySpriteId", idx);
        // Queue OnSpriteObjectCreate for the first tick (carryover-safe).
        // Stored as {spriteId, go} so the drain can set
        // peaky.activePlacement to the SPECIFIC GameObject before each
        // emit — letting downstream Set actions in the OnSpriteObjectCreate
        // chain target THIS one placement instead of all of the sprite.
        const pending = (sceneForRegistry.data.get("peaky.pendingPlacementCreates") as Array<{ spriteId: string; go: Phaser.GameObjects.Sprite }> | undefined) ?? [];
        pending.push({ spriteId: placement.spriteId, go });
        sceneForRegistry.data.set("peaky.pendingPlacementCreates", pending);
      }
      // Sprite id → frame-0 texture key, so SetUIElement's spriteId swap can
      // resolve a chosen sprite to its preloaded Phaser texture at runtime.
      const spriteImageKey: Record<string, string> = {};
      for (const asset of project.sprites) {
        const a0 = asset.animations[0];
        if (a0?.frames[0]?.imageFile) spriteImageKey[asset.id] = frameTextureKey(asset.id, a0.id, 0);
      }
      sceneForRegistry.data.set("peaky.spriteImageKey", spriteImageKey);
      // Project sprite catalogue — used by CreateSpriteObject at runtime
      // to resolve a chosen sprite asset's animations + frame texture keys.
      sceneForRegistry.data.set("peaky.projectSprites", project.sprites);
      // (peaky.recipes is set later — see the recipeMeta builder below.)
      // Expose the spawn helper so Game.ts's per-frame queue-drain can
      // call it under the same budget as BP spawns.
      sceneForRegistry.data.set("peaky.spawnRuntimeSpriteObject", spawnRuntimeSpriteObject);
      // NOW replay carried-over runtime objects — peaky.projectSprites (set just
      // above) + layers + spawn helpers are all in place, so sprite objects and
      // BP spawns both recreate correctly.
      replayCarriedSpawns();
      // Re-apply tilemap edits (mined / placed tiles) carried over from the last
      // visit to this level. The tilemaps are already built above, so their
      // hosts (matched by stable instanceId) just deserialize the saved delta.
      {
        const tileEdits = getSceneTileEdits(scene.id);
        if (Object.keys(tileEdits).length > 0) {
          const tmList = (sceneForRegistry.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
          for (const s of tmList) {
            const st = s.instanceId ? tileEdits[s.instanceId] : undefined;
            if (!st) continue;
            const tm = s.findBehaviorByKind("TilemapRenderer");
            if (tm) { try { tm.deserialize(st as Record<string, unknown>); } catch (e) { console.warn("[Peaky] tilemap edit restore threw", e); } }
          }
        }
      }
      // Full animation tables (frames + fps + loop, scale 1) for every sprite,
      // so the SetSprite action can swap a SpriteRenderer to any asset live.
      const spriteAnimTables: Record<string, Record<string, SpriteAnimRuntime>> = {};
      for (const asset of project.sprites) {
        const anims: Record<string, SpriteAnimRuntime> = {};
        for (const anim of asset.animations) {
          anims[anim.name] = {
            frames: anim.frames.map((f, i) => ({
              textureKey: f.imageFile ? frameTextureKey(asset.id, anim.id, i) : undefined,
              color: f.color,
              w: f.imageW ?? asset.width,
              h: f.imageH ?? asset.height,
              pivotX: f.pivotX,
              pivotY: f.pivotY,
              points: (f.points ?? []).map((p) => ({ name: p.name, x: p.x, y: p.y })),
            })),
            fps: anim.fps,
            loop: anim.loop,
          };
        }
        spriteAnimTables[asset.id] = anims;
      }
      sceneForRegistry.data.set("peaky.spriteAnimTables", spriteAnimTables);
      // Name → id map so SetSprite can accept a wired/typed sprite NAME (the
      // dropdown stores the id, but a string pin or expression naturally holds
      // the human name). Last writer wins on duplicate names.
      const spriteIdByName: Record<string, string> = {};
      for (const asset of project.sprites) if (asset.name) spriteIdByName[asset.name] = asset.id;
      sceneForRegistry.data.set("peaky.spriteIdByName", spriteIdByName);
      // Per-sprite display size — used by EquipWeapon to set the weapon
      // overlay's display size when swapping at runtime. SpriteRenderer
      // bakes per-frame w/h into _animations, but WeaponSlot also keeps
      // a fallback default for empty frames.
      const spriteSizes: Record<string, { w: number; h: number }> = {};
      for (const asset of project.sprites) {
        spriteSizes[asset.id] = { w: asset.width, h: asset.height };
      }
      sceneForRegistry.data.set("peaky.spriteSizes", spriteSizes);
      // Item catalog keyed by NAME (items are referenced by name in actions /
      // the inventory widget): maxStack + the icon's frame-0 texture key.
      const itemMeta: Record<string, { maxStack: number; iconKeys: string[]; fps: number; loop: boolean; animated: boolean; props: Record<string, number | string | boolean>; countGlobal: string; buyPrice: number; sellPrice: number; pickupBp: string; spriteId: string; iconAnim: string; iconFrame: number }> = {};
      for (const it of project.items ?? []) {
        const sp = project.sprites.find((s) => s.id === it.spriteId);
        const anim = sp ? (sp.animations.find((a) => a.id === it.iconAnim) ?? sp.animations[0]) : undefined;
        let iconKeys: string[] = [];
        let animated = false;
        if (sp && anim) {
          if (it.iconFrame === -1) {
            // Animated icon — all frames of the chosen animation.
            animated = true;
            iconKeys = anim.frames.map((f, i) => (f.imageFile ? frameTextureKey(sp.id, anim.id, i) : "")).filter(Boolean);
          } else {
            const idx = Math.max(0, it.iconFrame ?? 0);
            const f = anim.frames[idx] ?? anim.frames[0];
            if (f?.imageFile) iconKeys = [frameTextureKey(sp.id, anim.id, anim.frames.indexOf(f))];
          }
        }
        itemMeta[it.name] = {
          maxStack: Math.max(1, it.maxStack || 1),
          iconKeys,
          fps: anim?.fps ?? 8,
          loop: anim?.loop ?? true,
          animated,
          props: Object.fromEntries((it.props ?? []).filter((p) => p.key).map((p) => [p.key, p.value])),
          countGlobal: it.countGlobal || it.name.replace(/[^A-Za-z0-9_]/g, ""),
          buyPrice: Math.max(0, it.buyPrice ?? 0),
          sellPrice: Math.max(0, it.sellPrice ?? 0),
          // Pickup BP name + raw sprite metadata so drop-spawning can pass
          // "what item am I" instance vars (itemName / spriteId / anim /
          // frame / count) into a single generic pickup BP.
          pickupBp: it.pickupBp || "",
          spriteId: it.spriteId || "",
          iconAnim: it.iconAnim || (anim?.id || ""),
          iconFrame: typeof it.iconFrame === "number" ? it.iconFrame : 0,
        };
      }
      sceneForRegistry.data.set("peaky.itemMeta", itemMeta);
      // Recipe catalog keyed by NAME (recipes are referenced by name in the
      // Craft / CanCraft nodes and the Crafting widget). `enabled` flows
      // through so SetRecipeEnabled actions and the inspector's default
      // toggle both gate the crafting system here.
      const recipeMeta: Record<string, { name: string; inputs: { item: string; qty: number }[]; outputItem: string; outputQty: number; enabled: boolean }> = {};
      for (const r of project.recipes ?? []) {
        recipeMeta[r.name] = {
          name: r.name,
          inputs: (r.inputs ?? []).filter((inp) => inp.item).map((inp) => ({ item: inp.item, qty: Math.max(1, Math.floor(inp.qty || 1)) })),
          outputItem: r.outputItem,
          outputQty: Math.max(1, Math.floor(r.outputQty || 1)),
          enabled: r.enabled !== false,
        };
      }
      sceneForRegistry.data.set("peaky.recipes", recipeMeta);
      // Wheel-event accumulator: Phaser fires `wheel` on the input
      // plugin per scroll. We aggregate deltaY into scene.data each
      // frame and reset at POST_UPDATE so OnMouseWheel triggers see
      // exactly one frame of non-zero delta per physical scroll.
      sceneForRegistry.data.set("peaky.wheelDeltaY", 0);
      // Plural SOL — Construct's per-event picked-set map (§9). Each
      // top-level event chain resets this. Conditions with subject:bp:X
      // populate pickedSets[bpId]; actions with the same subject fan out
      // across the set.
      sceneForRegistry.data.set("peaky.pickedSets", new Map<string, Sprite[]>());
      const onWheel = (_pointer: unknown, _objs: unknown, _dx: number, deltaY: number) => {
        const cur = (sceneForRegistry.data.get("peaky.wheelDeltaY") as number | undefined) ?? 0;
        sceneForRegistry.data.set("peaky.wheelDeltaY", cur + deltaY);
      };
      sceneForRegistry.input.on("wheel", onWheel);
      const resetWheel = () => sceneForRegistry.data.set("peaky.wheelDeltaY", 0);
      sceneForRegistry.events.on(Phaser.Scenes.Events.POST_UPDATE, resetWheel);
      sceneForRegistry.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        sceneForRegistry.input.off("wheel", onWheel);
        sceneForRegistry.events.off(Phaser.Scenes.Events.POST_UPDATE, resetWheel);
      });

      // OnCameraPanEnd: Phaser's main camera fires PAN_COMPLETE once per
      // pan tween (covers both CameraPanTo and CameraPanToTag, plus the
      // direct cam.pan() fallback). We forward it as `_cameraPanEnd` on
      // every alive sprite so any event sheet can react via the trigger.
      const cam = sceneForRegistry.cameras.main;
      const onPanComplete = () => {
        const list = (sceneForRegistry.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
        // Only emit on sprites that actually listen — at 5000 NPCs a blind
        // fanout costs 5000 × listenerCount synchronous callbacks per pan,
        // a multi-second frame spike. listenerCount is O(1). (audit CRIT #3)
        for (const s of list) {
          if (s.destroyed) continue;
          if (s.events.listenerCount("_cameraPanEnd") > 0) s.events.emit("_cameraPanEnd");
        }
      };
      cam.on(Phaser.Cameras.Scene2D.Events.PAN_COMPLETE, onPanComplete);
      sceneForRegistry.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        cam.off(Phaser.Cameras.Scene2D.Events.PAN_COMPLETE, onPanComplete);
      });
    }

    // OnSceneStart — emit `_sceneStart` on every initially-spawned sprite so
    // the trigger evaluates true on frame 1 ONLY for sprites that were alive
    // at scene start. Sprites spawned later (via CreateObject) won't get the
    // signal and won't fire OnSceneStart.
    for (const { sprite } of spawned) {
      sprite.events.emit("_sceneStart");
    }
    // Pre-fill object pools BEFORE scene start emit. For every BP with
    // poolSize > 0, pre-spawn that many instances at off-screen
    // coordinates and immediately deactivate them via deactivateToPool.
    // This pays the per-sprite allocation cost ONCE at scene load (behind
    // a Loading screen if the author shows one) and makes subsequent
    // CreateObject calls O(0.05ms) for the lifetime of the scene.
    // Pool fill happens AFTER initial scene.instances spawns so the
    // pooled sprites can't accidentally interact with first-frame state
    // (their wireCollisionsFor / OnCreate run with the world fully built).
    const poolMap = sceneForRegistry?.data.get("peaky.spritePool") as
      | Map<string, Sprite[]>
      | undefined;
    if (sceneForRegistry && poolMap) {
      for (const bp of project.blueprints) {
        const poolSize = Math.max(0, Math.floor(bp.poolSize ?? 0));
        if (poolSize === 0) continue;
        const pool: Sprite[] = [];
        poolMap.set(bp.id, pool);
        for (let i = 0; i < poolSize; i++) {
          // Spawn off-screen so the player never sees the pool fill flash
          // even if the loading screen is missed for a moment.
          const sprite = spawnFromBlueprint(bp, -99999, -99999);
          if (!sprite) break;
          deactivateToPool(sprite);
        }
      }
    }
    // Pin a wall-clock-ish "scene started at" timestamp so spawnFromBlueprint
    // can decide whether to self-fire `_sceneStart` for runtime spawns that
    // happen DURING the first tick (e.g. an OnSceneStart action that calls
    // CreateObject). The threshold is generous; we only need to catch the
    // initial-tick race without re-firing on long-running spawns.
    if (spawned[0]?.sprite.scene) {
      spawned[0].sprite.scene.data.set("peaky.sceneStartedAtMs", Date.now());
      // Map of Sprite asset id → first-frame Phaser texture key. Populated
      // once at scene boot from the project's sprite library so runtime
      // actions like `SetParticleSprite` can resolve a user-facing
      // `spriteId` to the actual texture key without project access.
      // Sprites without a first-frame image are skipped (the action no-ops
      // for them; ParticleEmitter falls back to its previous texture).
      const spriteAssetFirstFrame = new Map<string, string>();
      for (const sp of project.sprites) {
        const a0 = sp.animations[0];
        if (a0 && a0.frames[0]?.imageFile) {
          spriteAssetFirstFrame.set(sp.id, frameTextureKey(sp.id, a0.id, 0));
        }
      }
      spawned[0].sprite.scene.data.set("peaky.spriteAssetFirstFrame", spriteAssetFirstFrame);
    }

    // Pass 2: register tag-based overlap / collision handlers driven off the
    // event-trigger list. Each `OnCollide`/`OnOverlap` trigger contributes a
    // `(kind, tag)` pair; we register one Phaser callback per pair per target
    // sprite that carries the tag.
    const phaserScene = spawned[0]?.sprite.scene;
    if (!phaserScene) return;

    // Publish a layerId→name lookup so behaviors (VisionMask `cutoutLayers`,
    // anything else needing human-readable layer identity) can resolve at
    // runtime without holding the scene definition.
    phaserScene.data.set("peaky.layerIdToName", new Map(scene.layers.map((L) => [L.id, L.name])));

    // OnSceneEnd — symmetric to _sceneStart. Phaser fires SHUTDOWN once when
    // the scene transitions out (GoToLayout, RestartLayout, page-leave). We
    // emit `_sceneEnd` on every still-alive sprite so its event sheet can
    // run cleanup actions before the world tears down.
    phaserScene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      // Skip the fallback emit entirely when drainSceneEndThen already
      // handled OnSceneEnd cleanly (the normal RestartLayout / GoToLayout
      // path). Without this guard each transition fired _sceneEnd twice —
      // once cleanly via drainSceneEndThen, once during SHUTDOWN with
      // plugins mid-teardown — and the second fan-out is what corrupted
      // the input plugin (visible: "controls dead after RestartLayout,
      // only fixed by page refresh"). Only the external-shutdown path
      // (page refresh, direct scene.shutdown) takes this branch now.
      // (audit CRIT #4)
      if (phaserScene.data.get("peaky.sceneEnding")) return;
      const list = (phaserScene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      for (const s of list) {
        if (s.destroyed) continue;
        if (s.events.listenerCount("_sceneEnd") > 0) s.events.emit("_sceneEnd");
      }
    });

    // Install the DialogueRunner singleton on the scene's data registry
    // so eval.ts's PlayDialogue / StopDialogue / AdvanceDialogue actions
    // can find it. We translate every editor DialogueAsset into the
    // runtime spec shape here so the runner doesn't have to know about
    // editor types — speaker labels are pre-resolved to BP ids.
    const dialogueDefaults = project.dialogueDefaults;
    const dialogueSpecs: DialogueAssetSpec[] = project.dialogues.map((d) => {
      // Resolve the player-echo speaker. Per-asset override wins; falls
      // back to project default. Empty string here means "no echo for
      // this asset" regardless of project default. Look up the BP's
      // display name once at spec build time so the runner can pin the
      // bubble + show the label without reaching back into the editor.
      const playerBpId = d.playerSpeakerBpId !== undefined
        ? d.playerSpeakerBpId
        : dialogueDefaults.playerSpeakerBpId;
      const playerBp = playerBpId
        ? project.blueprints.find((bp) => bp.id === playerBpId)
        : undefined;
      return {
      id: d.id,
      name: d.name,
      displayMode: d.displayMode ?? dialogueDefaults.displayMode,
      advanceAction: d.advanceAction || dialogueDefaults.advanceAction,
      autoAdvanceSec: d.autoAdvanceSec ?? dialogueDefaults.autoAdvanceSec,
      typewriterCps: d.typewriterCps ?? dialogueDefaults.typewriterCps,
      style: { ...dialogueDefaults.style },
      playerSpeakerBpId: playerBp ? playerBp.id : "",
      playerSpeakerLabel: playerBp?.name ?? "",
      speakerOffsets: d.speakerOffsets,
      freezePlayerDuringDialog: d.freezePlayerDuringDialog,
      freezeNpcsDuringDialog: d.freezeNpcsDuringDialog,
      lines: d.lines.map((l) => ({
        id: l.id,
        speakerLabel: l.speaker,
        speakerBpId: d.speakerMap[l.speaker] ?? "",
        text: l.text,
        ...(l.delaySec !== undefined ? { delaySec: l.delaySec } : {}),
        ...(l.emitSignal ? { emitSignal: l.emitSignal } : {}),
        ...(l.choices && l.choices.length
          ? {
              choices: l.choices.map((c) => ({
                id: c.id,
                text: c.text,
                emitSignal: c.emitSignal,
                ...(c.goToDialogue ? { goToDialogue: c.goToDialogue } : {}),
              })),
            }
          : {}),
      })),
      };
    });
    const dialogueRunner = new DialogueRunner(phaserScene, dialogueSpecs);
    phaserScene.data.set(DIALOGUE_KEY, dialogueRunner);
    // Register designer-authored 9-slice dialog box assets. Each box's PNG
    // is decoded as a Phaser texture under `dlgbox:<id>` so the runner can
    // render slices via scene.add.image without re-decoding on every line.
    // The spec table goes onto the scene data registry — DialogueRunner
    // looks it up at draw time when style.theme === "image".
    const dialogBoxes = project.dialogBoxes ?? [];
    const boxSpecs: Record<string, DialogBoxAssetSpec> = {};
    for (const b of dialogBoxes) {
      const key = `dlgbox:${b.id}`;
      const tryRegister = () => {
        if (phaserScene.textures.exists(key)) return;
        // Use Phaser's addBase64 — synchronous-ish: it kicks off an Image
        // decode that fires `addtexture-<key>` on completion. The DialogueRunner's
        // 9-slice draw path tolerates a missing texture by falling back to
        // the procedural modern theme until the decode finishes.
        phaserScene.textures.addBase64(key, b.dataUrl);
      };
      tryRegister();
      // Compute imgW/H from the data-URL by peeking at an Image element.
      // Async — when it resolves we patch the spec table in-place. The
      // dialog runner re-reads the spec every draw, so the new dims show
      // up automatically the next frame after decode completes.
      const probe = new Image();
      probe.onload = () => {
        const s = boxSpecs[b.id];
        if (!s) return;
        s.imgW = probe.naturalWidth || 64;
        s.imgH = probe.naturalHeight || 64;
      };
      probe.src = b.dataUrl;
      boxSpecs[b.id] = {
        id: b.id,
        textureKey: key,
        imgW: 64,
        imgH: 64,
        sliceLeft: b.sliceLeft,
        sliceRight: b.sliceRight,
        sliceTop: b.sliceTop,
        sliceBottom: b.sliceBottom,
      };
    }
    phaserScene.data.set(DIALOG_BOXES_KEY, boxSpecs);
    // Dialog Flow runner — declarative trigger table on top of the same
    // DialogueRunner. Reads project.dialogFlow at scene-create time so the
    // OnEnterScene triggers can fire immediately; OnSignal triggers wire
    // their listeners now too. Missing dialogFlow = empty trigger list,
    // runner does nothing.
    const dfTriggers = (project.dialogFlow?.triggers ?? []) as unknown as ConstructorParameters<typeof DialogFlowRunner>[1];
    const dialogFlowRunner = new DialogFlowRunner(phaserScene, dfTriggers);
    phaserScene.data.set(DIALOG_FLOW_KEY, dialogFlowRunner);
    dialogFlowRunner.init();
    // Per-tick polling for tracer-driven OnInteract triggers. Same UPDATE
    // event slot as DialogueRunner — runs BEFORE InputActions snapshots
    // heldPrev, so justPressed comparisons see the correct frame state.
    const tickDialogFlow = (_time: number, delta: number) => dialogFlowRunner.update(delta);
    phaserScene.events.on(Phaser.Scenes.Events.UPDATE, tickDialogFlow);
    phaserScene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      phaserScene.events.off(Phaser.Scenes.Events.UPDATE, tickDialogFlow);
    });
    // Tick the runner on UPDATE (NOT post_update). The reason matters:
    // InputActions snapshots its `heldPrev` map on POST_UPDATE so
    // `justPressed` can compare current isDown vs end-of-previous-frame
    // state. If the runner ALSO runs on POST_UPDATE, listener order
    // becomes load-bearing — InputActions registered first → its
    // snapshot runs first → it overwrites heldPrev with THIS frame's
    // state → the runner's `justPressed` then sees heldPrev === heldNow
    // and returns false. Net effect: dialogue advance key never fires.
    // Running on UPDATE puts the runner BEFORE the snapshot, so
    // justPressed compares correctly.
    const tickRunner = (_time: number, delta: number) => dialogueRunner.update(delta);
    phaserScene.events.on(Phaser.Scenes.Events.UPDATE, tickRunner);
    phaserScene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      phaserScene.events.off(Phaser.Scenes.Events.UPDATE, tickRunner);
    });

    // GibManager — scene singleton that drives Dismemberment "gib" chunk spin
    // + lifetime cleanup. Ticked with the SCALED sim delta so a paused / slowed
    // scene holds the chunks (matching every other gameplay clock). Destroyed
    // on shutdown so chunks don't leak across RestartLayout / GoToLayout.
    const gibManager = new GibManager(phaserScene);
    phaserScene.data.set(GIB_KEY, gibManager);
    const tickGibs = (_time: number, delta: number) => {
      const scaled = (delta * (phaserScene.time.timeScale ?? 1)) / 1000;
      gibManager.update(scaled);
    };
    phaserScene.events.on(Phaser.Scenes.Events.UPDATE, tickGibs);
    phaserScene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      phaserScene.events.off(Phaser.Scenes.Events.UPDATE, tickGibs);
      gibManager.destroyAll();
    });

    // Tag-based OnCollide / OnOverlap wiring is now handled inside
    // `spawnFromBlueprint` via `wireCollisionsFor()`, so initial scene
    // placements AND runtime CreateObject spawns both register pairs.
    // The legacy boot-only pass-2 loop here was a footgun for the
    // CreateObject path — anything spawned after scene start silently
    // dropped every collide/overlap event forever.
  };
  const preload = await buildSpritePreload(project, scene)();
  return { build, preload, effectiveScene: scene };
}

/** Initial boot — construct a fresh Peaky/Phaser.Game for `scene` and start it.
 *  Transitions use `buildSceneOn` (rebuild on the existing game) instead. */
export async function runScene(project: PeakyProject, scene: SceneData, parent: HTMLElement): Promise<Peaky> {
  const { build, preload, effectiveScene: eff } = await makeSceneBuilder(project, scene, parent);
  const game: Peaky = new Peaky({
    width: project.viewportWidth,
    height: project.viewportHeight,
    layoutWidth: eff.width,
    layoutHeight: eff.height,
    boundedCamera: !eff.unboundedScroll,
    backgroundColor: eff.backgroundColor,
    gravity: eff.gravity,
    parent,
    inputActions: project.inputActions.map((a) => ({ name: a.name, keys: a.keys })),
    sampling: project.sampling ?? "bilinear",
  });
  // Expose the active Peaky globally so the editor TopBar can poll FPS + F12 debug.
  (window as unknown as { __peakyGame?: Peaky }).__peakyGame = game;
  game.start(build, preload);
  return game;
}

/** In-place transition — rebuild `scene` on an EXISTING game (textures kept →
 *  fast). Keeps the same Phaser.Game/canvas; does NOT touch `__peakyGame`.
 *  Carries the TARGET scene's world config so create() doesn't rebuild with the
 *  OLD scene's bounds/gravity/background (wrong-world clamping = wrong spawn). */
export async function buildSceneOn(game: Peaky, project: PeakyProject, scene: SceneData, parent: HTMLElement): Promise<void> {
  const { build, preload, effectiveScene: eff } = await makeSceneBuilder(project, scene, parent);
  game.gotoScene(build, preload, {
    layoutWidth: eff.width,
    layoutHeight: eff.height,
    boundedCamera: !eff.unboundedScroll,
    gravity: eff.gravity,
    backgroundColor: eff.backgroundColor,
  });
}
