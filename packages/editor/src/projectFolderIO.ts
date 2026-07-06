/**
 * Reads and writes a v8 folder-mode project.
 *
 * v8 layout: every "big" asset (blueprint, scene, sprite metadata, etc.)
 * lives in its own .json file at assets/<cb-path>/<name>.<type>.json. The
 * project manifest (project.peaky.json) holds only project-level data plus
 * an `assetIndex` that lists each asset file's relative path. Binary
 * assets (PNG frames, audio, fonts) are unchanged from v7.
 *
 * In-memory PeakyProject keeps the same flat-array shape; the split is
 * purely on-disk. Load reads every indexed file in parallel and rebuilds
 * the arrays; save writes each asset to its own file and rewrites the
 * manifest with fresh paths.
 *
 * The split's value: a partial write or corrupted save can't wipe more
 * than one asset at a time. Restoring is "edit one file" instead of "lose
 * everything except inputActions."
 */

import type {
  PeakyProject, BlueprintDef, SceneData, SpriteAsset, TilesetAsset,
  TilemapAsset, DialogueAsset, UIWidgetDef, ItemAsset, RecipeAsset,
} from "./project";
import { emptyProject } from "./project";
import {
  AssetStore,
  PROJECT_MANIFEST_FILE,
  blueprintDiskPath,
  sceneDiskPath,
  spriteMetaDiskPath,
  tilesetMetaDiskPath,
  tilemapDiskPath,
  dialogueDiskPath,
  uiWidgetDiskPath,
  itemDiskPath,
  recipeDiskPath,
  spriteDiskFolder,
  spriteFrameDiskPath,
  tilesetImagePath,
  soundDiskPath,
  fontDiskPath,
} from "./AssetStore";

/** Shape of project.peaky.json on disk. The Peaky*Project flat arrays are
 *  REPLACED with an assetIndex of file paths. Everything else is identical
 *  to the in-memory PeakyProject. */
type SplitManifest = Omit<PeakyProject,
  | "blueprints" | "scenes" | "sprites" | "tilesets" | "tilemaps"
  | "dialogues" | "uiWidgets" | "items" | "recipes"
> & {
  assetIndex: {
    blueprints: string[];
    scenes: string[];
    sprites: string[];
    tilesets: string[];
    tilemaps: string[];
    dialogues: string[];
    uiWidgets: string[];
    items: string[];
    recipes: string[];
  };
};

/** Suffix → asset bucket. Discovery is disk-first so a missing or stale
 *  manifest can't hide an asset that's actually on disk. */
const ASSET_SUFFIXES = [
  { suffix: ".bp.json",      bucket: "blueprints" as const },
  { suffix: ".scene.json",   bucket: "scenes"     as const },
  { suffix: ".sprite.json",  bucket: "sprites"    as const },
  { suffix: ".tileset.json", bucket: "tilesets"   as const },
  { suffix: ".tilemap.json", bucket: "tilemaps"   as const },
  { suffix: ".dlg.json",     bucket: "dialogues"  as const },
  { suffix: ".widget.json",  bucket: "uiWidgets"  as const },
  { suffix: ".item.json",    bucket: "items"      as const },
  { suffix: ".recipe.json",  bucket: "recipes"    as const },
];

/**
 * Read a v8 project from a folder. Reads the manifest for project-level
 * fields (input actions, signals, etc.), then SCANS the assets/ tree for
 * asset files keyed by suffix. The scan approach means the manifest's
 * assetIndex is purely informational — a lost manifest can't hide
 * existing assets on disk. Missing files are logged and skipped.
 *
 * Throws on missing / wrong-version / malformed manifest.
 */
export async function loadProjectFromFolder(store: AssetStore): Promise<PeakyProject> {
  const manifest = await store.readJSON<SplitManifest>(PROJECT_MANIFEST_FILE);
  if (manifest.version !== 8) {
    // Helpful error so the user knows exactly what happened and what to
    // do. v7 (monolithic) projects can be re-saved from a v7 editor as
    // v8 — there is no in-place migration per project policy. Older /
    // newer versions are flagged so the user doesn't open an unrelated
    // folder thinking it's a Peaky project. (audit HIGH #18)
    const v = manifest.version;
    const hint = v === 7
      ? "v7 (monolithic) projects can't open here — re-export from the v7 editor as v8 (folder mode), then open."
      : v == null
        ? "manifest is missing 'version' — folder may not be a Peaky project, or project.peaky.json is corrupt."
        : `version ${v} is newer than this editor supports (v8) — upgrade the editor.`;
    throw new Error(`Unsupported project version: ${v}. ${hint}`);
  }

  // Walk assets/ and bucket every recognized file by suffix.
  const bucketed: Record<string, string[]> = {
    blueprints: [], scenes: [], sprites: [], tilesets: [], tilemaps: [],
    dialogues: [], uiWidgets: [], items: [], recipes: [],
  };
  for await (const path of store.walkFiles("assets")) {
    for (const { suffix, bucket } of ASSET_SUFFIXES) {
      if (path.endsWith(suffix)) { bucketed[bucket].push(path); break; }
    }
  }

  // Read every discovered file in parallel; per-type Promise.all so a
  // single bad file doesn't sink the whole load. We track per-bucket
  // failure counts so the downstream GC pass can refuse to run if any
  // file failed to load — otherwise a transient I/O error would let the
  // GC walk delete every "missing-from-project" file, including the
  // unreadable-but-recoverable ones we just skipped.
  let anyReadFailed = false;
  async function readAll<T>(paths: string[]): Promise<T[]> {
    const results = await Promise.all(paths.map(async (p) => {
      try {
        const value = await store.readJSON<T>(p);
        return { ok: true as const, value };
      } catch (err) {
        console.warn(`[load] failed to read asset: ${p}`, err);
        anyReadFailed = true;
        return { ok: false as const };
      }
    }));
    const out: T[] = [];
    for (const r of results) if (r.ok) out.push(r.value);
    return out;
  }

  const [blueprints, scenes, sprites, tilesets, tilemaps, dialogues, uiWidgets, items, recipes] =
    await Promise.all([
      readAll<BlueprintDef>(bucketed.blueprints),
      readAll<SceneData>(bucketed.scenes),
      readAll<SpriteAsset>(bucketed.sprites),
      readAll<TilesetAsset>(bucketed.tilesets),
      readAll<TilemapAsset>(bucketed.tilemaps),
      readAll<DialogueAsset>(bucketed.dialogues),
      readAll<UIWidgetDef>(bucketed.uiWidgets),
      readAll<ItemAsset>(bucketed.items),
      readAll<RecipeAsset>(bucketed.recipes),
    ]);

  // Strip assetIndex from manifest — it's a disk-only artifact, not part of
  // the in-memory PeakyProject shape.
  const { assetIndex: _unused, ...rest } = manifest;
  void _unused;
  const project: PeakyProject = {
    ...rest,
    blueprints,
    scenes,
    sprites,
    tilesets,
    tilemaps,
    dialogues,
    uiWidgets,
    items,
    recipes,
  };
  // A project with zero scenes leaves activeScene() returning undefined
  // and crashes every consumer that assumes one exists (StatusBar, scene
  // editor, etc.). If the on-disk index referenced no scene files (or all
  // failed to load), seed a default scene from emptyProject() so the
  // editor stays usable for recovery. We ONLY seed when no scene files
  // were discovered on disk in the first place — if scene files existed
  // but all failed to read, that's a transient I/O hiccup not a true
  // empty project, and seeding would let the GC pass below wipe the
  // unreadable-but-recoverable scene files permanently.
  if (project.scenes.length === 0 && bucketed.scenes.length === 0) {
    const seeded = emptyProject();
    project.scenes = seeded.scenes;
    project.activeSceneId = seeded.activeSceneId;
    console.warn("[load] project had no scenes — seeded a blank Main scene for recovery");
  }

  // On-load FULL cleanup pass: previous session may have ended with
  // deleted-but-not-purged files (frame PNGs, sprite/tileset binary
  // folders, audio, fonts). All our remove* actions DON'T touch disk so
  // undo always works during a session; the GC catches up on the next
  // open. Walks assets/ and removes anything the loaded project doesn't
  // reference. CRITICAL: the referenced set MUST include both binary AND
  // metadata files (every .bp.json / .scene.json / .sprite.json / etc.)
  // or this becomes the cleanupOrphans catastrophe again.
  //
  // SAFETY: skip GC entirely when any readAll bucket threw — a partial
  // load with missing-but-recoverable files would have its real assets
  // deleted by this pass otherwise. Also skip when zero asset files were
  // discovered on disk (fresh project / picked the wrong folder).
  const anyAssetFilesOnDisk = Object.values(bucketed).some((b) => b.length > 0);
  // Belt-and-suspenders: if discovery count > load count (i.e. some files
  // were discovered but ended up dropped from the project for any reason
  // OTHER than a read error — schema mismatch, version filter, dedup),
  // skip GC. anyReadFailed already covers read failures; this catches
  // every other path where a file is on disk but unreferenced by the
  // loaded project, which would otherwise let GC delete real files
  // after a partial save. (audit CRIT #0)
  const totalDiscovered = Object.values(bucketed).reduce((sum, b) => sum + b.length, 0);
  const totalLoaded =
    project.blueprints.length + project.scenes.length + project.sprites.length +
    (project.tilesets?.length ?? 0) + (project.tilemaps?.length ?? 0) +
    project.dialogues.length + project.uiWidgets.length +
    (project.items?.length ?? 0) + (project.recipes?.length ?? 0);
  const foundAll = totalDiscovered === totalLoaded;
  if (!anyReadFailed && anyAssetFilesOnDisk && foundAll) {
    const referenced = new Set<string>();
    // JSON metadata files.
    for (const bp of project.blueprints) referenced.add(blueprintDiskPath(bp));
    for (const sc of project.scenes)     referenced.add(sceneDiskPath(sc));
    for (const sp of project.sprites)    referenced.add(spriteMetaDiskPath(sp));
    for (const ts of project.tilesets ?? [])  referenced.add(tilesetMetaDiskPath(ts));
    for (const tm of project.tilemaps ?? [])  referenced.add(tilemapDiskPath(tm));
    for (const d  of project.dialogues)  referenced.add(dialogueDiskPath(d));
    for (const w  of project.uiWidgets)  referenced.add(uiWidgetDiskPath(w));
    for (const it of project.items ?? [])     referenced.add(itemDiskPath(it));
    for (const r  of project.recipes ?? [])   referenced.add(recipeDiskPath(r));
    // Binary asset files.
    for (const sp of project.sprites) {
      for (const anim of sp.animations) {
        for (const f of anim.frames) {
          if (f.imageFile) referenced.add(spriteFrameDiskPath(sp, f.imageFile));
        }
      }
    }
    for (const ts of project.tilesets ?? []) {
      if (ts.imageFile) referenced.add(tilesetImagePath(ts));
      // The Manual Tile Builder's raw source sheet — keep it so it isn't GC'd
      // on reload (else the regions can never be re-edited/re-baked).
      if (ts.manualSourceFile) referenced.add(tilesetImagePath({ ...ts, imageFile: ts.manualSourceFile }));
    }
    for (const snd of project.sounds ?? []) {
      if (snd.file) referenced.add(soundDiskPath(snd));
    }
    for (const fnt of project.fonts ?? []) {
      if (fnt.file) referenced.add(fontDiskPath(fnt));
    }
    // Collect-then-delete (deterministic). Mutating the directory while
    // walkFiles is still iterating is undefined per FSAA — Chromium may
    // either skip siblings (orphans survive) or throw NotFoundError that
    // gets swallowed silently. Build the full delete list first, THEN
    // delete in a separate pass.
    const toDelete: string[] = [];
    try {
      for await (const path of store.walkFiles("assets")) {
        if (referenced.has(path)) continue;
        // Allow-list of suffixes we actually own — anything else is a
        // user-placed file (NOTES.md, .gitignore, README.txt, design
        // PSDs alongside the sprite folder, etc.) and we must NOT touch
        // it. Loosely match the original ASSET_SUFFIXES discovery plus
        // the binary extensions we write ourselves.
        const lower = path.toLowerCase();
        const owned = GC_OWNED_SUFFIXES.some((s) => lower.endsWith(s));
        if (!owned) continue;
        toDelete.push(path);
      }
    } catch (err) {
      console.warn("[load] on-load cleanup walk failed", err);
    }
    for (const p of toDelete) {
      try { await store.deleteFile(p); }
      catch (err) { console.warn("[load] on-load delete failed", p, err); }
    }
  } else if (anyReadFailed) {
    console.warn("[load] skipping orphan GC — some asset files failed to load and could be recoverable");
  }

  return project;
}

/** Suffixes the on-load GC owns. Files NOT matching any of these are
 *  user-placed (notes, .gitignore, design files) and must survive. */
const GC_OWNED_SUFFIXES = [
  // JSON metadata
  ".bp.json", ".scene.json", ".sprite.json", ".tileset.json",
  ".tilemap.json", ".dlg.json", ".widget.json", ".item.json", ".recipe.json",
  // Binary assets we write
  ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".wav", ".ogg", ".mp3", ".m4a",
  ".ttf", ".otf", ".woff", ".woff2",
];

/**
 * Write a v8 project to a folder. Each asset is written to its own file;
 * the manifest is written last so a half-finished save still leaves the
 * old manifest pointing at the previous (intact) asset files.
 *
 * GC: reads the old manifest's assetIndex (if any) before writing, diffs
 * old paths vs new paths, deletes anything the new project no longer
 * references. Catches rename-leftovers ("Player.bp.json" lingering after
 * the BP became "Hero.bp.json") and removed-asset orphans without a
 * separate cleanup pass.
 *
 * Rewrites EVERY asset file on every call. The cost is small (each is KB)
 * and the simplicity is worth it. A future optimization would diff
 * contents and only rewrite the changed files.
 */
/** Error thrown by `saveProjectToFolder` when the empty-state guard catches a
 *  potential corruption-wipe. Carries the list of asset types that went from
 *  non-empty to zero so the caller can show a meaningful confirm prompt. */
export class EmptyStateWipeError extends Error {
  wipedTypes: string[];
  constructor(wipedTypes: string[]) {
    super(`save aborted — these asset types would be wiped: ${wipedTypes.join(", ")}`);
    this.name = "EmptyStateWipeError";
    this.wipedTypes = wipedTypes;
  }
}

/** Per-path cache of the last-written asset object reference, for the
 *  incremental-save skip in saveProjectToFolder. Module-level: a reload swaps
 *  in fresh asset objects (new references), so everything writes once after a
 *  load and only changed assets write thereafter. */
const _lastWrittenAsset = new Map<string, unknown>();
/** The store the reference cache above currently reflects. When the save
 *  target changes (Open another folder, Save As switching the active store),
 *  the cached references no longer correspond to what's on the new disk, so we
 *  drop them and let everything write once. */
let _lastWrittenStore: AssetStore | null = null;

export async function saveProjectToFolder(store: AssetStore, project: PeakyProject, opts?: { allowWipe?: boolean }): Promise<void> {
  if (store !== _lastWrittenStore) {
    _lastWrittenAsset.clear();
    _lastWrittenStore = store;
  }
  // Compute the on-disk paths from each asset's (path, name). These are
  // ALSO the paths recorded in the manifest's assetIndex.
  const bpPaths    = project.blueprints.map(blueprintDiskPath);
  const scenePaths = project.scenes.map(sceneDiskPath);
  const spPaths    = project.sprites.map(spriteMetaDiskPath);
  const tsPaths    = (project.tilesets ?? []).map(tilesetMetaDiskPath);
  const tmPaths    = (project.tilemaps ?? []).map(tilemapDiskPath);
  const dlgPaths   = project.dialogues.map(dialogueDiskPath);
  const uiwPaths   = project.uiWidgets.map(uiWidgetDiskPath);
  const itemPaths  = (project.items ?? []).map(itemDiskPath);
  const recPaths   = (project.recipes ?? []).map(recipeDiskPath);

  // Read the old manifest (if present) to learn what was on disk last
  // save. Anything in the old assetIndex that isn't in the new path set
  // becomes a delete — that covers both rename-leftovers and removed
  // assets in one sweep.
  const newPathSet = new Set([
    ...bpPaths, ...scenePaths, ...spPaths, ...tsPaths, ...tmPaths,
    ...dlgPaths, ...uiwPaths, ...itemPaths, ...recPaths,
  ]);
  // Defensive: detect case-insensitive path collisions among the assets being
  // written. uniqueAssetName now prevents NEW collisions, but a project saved
  // BEFORE that fix can still carry two assets whose paths differ only by case
  // ("Hero.bp.json" vs "hero.bp.json"). On Windows/macOS those are the same
  // file, so the parallel writes below would race and silently clobber one.
  // Keep the FIRST occurrence (insertion order), skip + log every later one.
  const skipPaths = new Set<string>();
  {
    const seenLower = new Map<string, string>();
    for (const p of newPathSet) {
      const lower = p.toLowerCase();
      const first = seenLower.get(lower);
      if (first === undefined) seenLower.set(lower, p);
      else {
        skipPaths.add(p);
        console.error(
          `[saveProjectToFolder] case-insensitive path collision: "${p}" maps to the ` +
          `same file as "${first}" on case-insensitive filesystems. Skipping the write ` +
          `of "${p}" to avoid clobbering — rename one of these assets to resolve it.`,
        );
      }
    }
  }
  // Incremental save: skip rewriting an asset whose object REFERENCE hasn't
  // changed since the last save. The store mutates immutably, so an unedited
  // blueprint/scene/sprite keeps the same reference — only the asset you
  // actually changed gets a new one. Without this, a 24-asset project
  // re-stringified + re-wrote ALL 24 files on every 800ms autosave, which
  // froze the editor for seconds as it grew. The manifest is still written
  // every save (cheap), so the on-disk index stays correct.
  const writeIfNotSkipped = (path: string, data: unknown): Promise<void> => {
    if (skipPaths.has(path)) return Promise.resolve();
    if (_lastWrittenAsset.get(path) === data) return Promise.resolve();
    return store.writeJSON(path, data).then(() => { _lastWrittenAsset.set(path, data); });
  };
  let toDelete: string[] = [];
  try {
    const oldManifest = await store.readJSON<SplitManifest>(PROJECT_MANIFEST_FILE);
    const oldIdx = oldManifest.assetIndex;
    if (oldIdx) {
      // Wipe detection: list every asset type that went from non-empty in
      // the old manifest to zero in the in-memory project. Bubble the list
      // up via EmptyStateWipeError so the caller can prompt the user. The
      // hard-throw remains as the safe default for autosave / silent writes;
      // interactive Save passes allowWipe=true after confirming with the user.
      const wipedTypes: string[] = [];
      if (oldIdx.blueprints.length > 0 && project.blueprints.length === 0) wipedTypes.push("blueprints");
      if (oldIdx.scenes.length > 0 && project.scenes.length === 0) wipedTypes.push("scenes");
      if (oldIdx.sprites.length > 0 && project.sprites.length === 0) wipedTypes.push("sprites");
      if (oldIdx.tilesets.length > 0 && (project.tilesets ?? []).length === 0) wipedTypes.push("tilesets");
      if (oldIdx.tilemaps.length > 0 && (project.tilemaps ?? []).length === 0) wipedTypes.push("tilemaps");
      if (oldIdx.dialogues.length > 0 && project.dialogues.length === 0) wipedTypes.push("dialogues");
      if (oldIdx.uiWidgets.length > 0 && project.uiWidgets.length === 0) wipedTypes.push("ui widgets");
      if (oldIdx.items.length > 0 && (project.items ?? []).length === 0) wipedTypes.push("items");
      if (oldIdx.recipes.length > 0 && (project.recipes ?? []).length === 0) wipedTypes.push("recipes");
      if (wipedTypes.length > 0 && !opts?.allowWipe) {
        console.error(
          `[saveProjectToFolder] empty-state guard: refusing to wipe ${wipedTypes.join(", ")}. ` +
          `Call with { allowWipe: true } to proceed (interactive Save should confirm with the user).`,
        );
        throw new EmptyStateWipeError(wipedTypes);
      }
      const oldPaths = [
        ...oldIdx.blueprints, ...oldIdx.scenes, ...oldIdx.sprites,
        ...oldIdx.tilesets, ...oldIdx.tilemaps, ...oldIdx.dialogues,
        ...oldIdx.uiWidgets, ...oldIdx.items, ...oldIdx.recipes,
      ];
      toDelete = oldPaths.filter((p) => !newPathSet.has(p));
    }
  } catch (err) {
    // Re-throw the wipe-guard error so the interactive caller can prompt.
    // No-old-manifest exceptions (first save) are still tolerated below.
    if (err instanceof EmptyStateWipeError) throw err;
  }

  // Write all asset files in parallel — each is small and independent.
  await Promise.all([
    ...project.blueprints.map((bp, i) => writeIfNotSkipped(bpPaths[i], bp)),
    ...project.scenes.map((sc, i) => writeIfNotSkipped(scenePaths[i], sc)),
    ...project.sprites.map((sp, i) => writeIfNotSkipped(spPaths[i], sp)),
    ...(project.tilesets ?? []).map((ts, i) => writeIfNotSkipped(tsPaths[i], ts)),
    ...(project.tilemaps ?? []).map((tm, i) => writeIfNotSkipped(tmPaths[i], tm)),
    ...project.dialogues.map((d, i) => writeIfNotSkipped(dlgPaths[i], d)),
    ...project.uiWidgets.map((w, i) => writeIfNotSkipped(uiwPaths[i], w)),
    ...(project.items ?? []).map((it, i) => writeIfNotSkipped(itemPaths[i], it)),
    ...(project.recipes ?? []).map((r, i) => writeIfNotSkipped(recPaths[i], r)),
  ]);

  // GC the orphans AFTER the new files are written, so a crash mid-save
  // never leaves the project with neither the old nor the new asset.
  await Promise.all(toDelete.map((p) => store.deleteFile(p)));

  // Frame-PNG cleanup is NOT done here. If we deleted unreferenced PNGs
  // at save time, undo-after-save would restore the in-memory frame but
  // its file would be gone → blank thumbnail. Deleted-frame PNGs stay
  // on disk; cleanup is an explicit user action (TODO: add a "Clean Up
  // Unused Frames" button somewhere). Trade-off: orphan files accumulate
  // until cleanup, but undo never crosses a one-way boundary.

  // Strip the flat arrays + write the slim manifest. The cast is safe
  // because the assetIndex carries the same data shape Promise.all wrote.
  const {
    blueprints: _bp, scenes: _sc, sprites: _sp, tilesets: _ts, tilemaps: _tm,
    dialogues: _dlg, uiWidgets: _uiw, items: _it, recipes: _rc,
    ...rest
  } = project;
  void _bp; void _sc; void _sp; void _ts; void _tm; void _dlg; void _uiw; void _it; void _rc;
  const manifest: SplitManifest = {
    ...rest,
    assetIndex: {
      blueprints: bpPaths,
      scenes: scenePaths,
      sprites: spPaths,
      tilesets: tsPaths,
      tilemaps: tmPaths,
      dialogues: dlgPaths,
      uiWidgets: uiwPaths,
      items: itemPaths,
      recipes: recPaths,
    },
  };
  // Rolling snapshot FIRST, live manifest SECOND. If a crash corrupts the
  // live-manifest write below, the just-written snapshot already holds this
  // save's full content → nothing is lost. The old order (manifest first)
  // left a window where a mid-write crash corrupted the live file while the
  // newest snapshot was one save behind.
  // Snapshots live under .autosave/autosave_<N>.json (rolling AUTOSAVE_SLOTS);
  // the main project.peaky.json stays the live source-of-truth load target.
  await writeRollingSnapshot(store, manifest);
  await store.writeJSON(PROJECT_MANIFEST_FILE, manifest);
}

/** How many rolling autosave slots to keep. With ~1 save per edit burst,
 *  10 slots = roughly the last 10 distinct edit moments. */
const AUTOSAVE_SLOTS = 10;
const AUTOSAVE_DIR = ".autosave";
const AUTOSAVE_SLOT_KEY = "peaky.autosave-slot";

/** Bump the rotating slot counter and write the manifest snapshot.
 *  Slot tracking lives in localStorage keyed per directory (so different
 *  projects don't fight over the same counter). */
async function writeRollingSnapshot(store: AssetStore, manifest: SplitManifest): Promise<void> {
  try {
    const key = `${AUTOSAVE_SLOT_KEY}:${store.rootName}`;
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { /* private mode */ }
    const prev = raw === null ? -1 : parseInt(raw, 10);
    const slot = ((Number.isFinite(prev) ? prev : -1) + 1) % AUTOSAVE_SLOTS;
    const filename = `autosave_${String(slot).padStart(2, "0")}.json`;
    // Write first, then bump localStorage. If a crash happens before the
    // counter advances, the next session re-uses the same slot (idempotent
    // rewrite) — without this order the counter could advance past an
    // orphaned slot, eating into the rotation pool. (audit HIGH #20)
    await store.writeJSON(`${AUTOSAVE_DIR}/${filename}`, manifest);
    try { localStorage.setItem(key, String(slot)); } catch { /* private mode */ }
  } catch (err) {
    // Snapshot is a safety net, not load-blocking — log and move on.
    console.warn("[save] rolling snapshot failed:", err);
  }
}

/**
 * Initialize a brand-new project in an empty directory. Writes an empty
 * project's manifest + (empty) assetIndex. Asset files don't exist yet —
 * they'll appear when the author creates assets.
 */
export async function initEmptyProjectInFolder(store: AssetStore, name: string): Promise<PeakyProject> {
  const project: PeakyProject = { ...emptyProject(), name };
  await saveProjectToFolder(store, project);
  return project;
}
