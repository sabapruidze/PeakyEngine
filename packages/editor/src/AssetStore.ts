/**
 * AssetStore — owns a project's on-disk asset directory and brokers access
 * for the rest of the editor.
 *
 * Folder mode (Web FS Access API, Chromium-only):
 *
 *   MyGame/
 *     project.peaky.json         ← serialized PeakyProject (logic + scenes + asset metadata)
 *     assets/
 *       <content-browser-path>/  ← mirrors SpriteAsset.path / SoundAsset.path / etc.
 *         <asset-name>/          ← one folder per sprite (multiple frames)
 *           sprite.json          ← optional asset-side metadata (currently unused; here so the
 *                                  on-disk folder is self-describing even outside the editor)
 *           <frame-id>.png       ← one PNG per frame
 *         <sound-name>.mp3       ← sounds, tilesets, fonts as direct files
 *
 * The editor stores DISK PATHS (relative to the project root, slash-separated) on
 * asset records and resolves them through this store to blob URLs at read time.
 * Blob URLs are cached and revoked on unload / project swap.
 *
 * Failure modes worth knowing:
 *
 *   - The directory handle is held in memory only. After a page reload the
 *     editor MUST re-prompt for the directory (browsers don't grant persistent
 *     read/write without user gesture). A handle CAN be cached in IndexedDB to
 *     skip the picker but `requestPermission()` still needs a click. Treat the
 *     handle as session-scoped.
 *
 *   - File writes are not atomic. A crash mid-save can leave a partially
 *     written project.peaky.json. The save flow writes assets first, then the
 *     manifest last, so a half-finished save still loads (orphaned asset files
 *     are tolerated and GC'd on next save).
 *
 *   - Blob URLs leak if not revoked. Every URL.createObjectURL has a paired
 *     URL.revokeObjectURL in this module. Calling destroy() drops them all.
 */

/** Subscribers fire after the active store swaps (open / new project). React
 *  hooks listen so they re-resolve their cached URLs against the new store. */
type Listener = () => void;

let _active: AssetStore | null = null;
const _listeners = new Set<Listener>();
let _version = 0;

/** Get the currently-active store. `null` when no folder project is open. */
export function getActiveAssetStore(): AssetStore | null { return _active; }

/** Increment-on-swap version — feed to React state so hooks know to re-fetch. */
export function getAssetStoreVersion(): number { return _version; }

/** Replace the active store. Pass null to clear (e.g. closed project). */
export function setActiveAssetStore(next: AssetStore | null): void {
  if (_active === next) return;
  _active?.destroy();
  _active = next;
  _version++;
  for (const fn of _listeners) fn();
}

/** Subscribe to active-store changes. Returns an unsubscribe fn. */
export function subscribeAssetStore(fn: Listener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** Force-notify all subscribers (bumps the version). Used after async disk
 *  operations — rename, GC — so React hooks re-resolve cached URLs. Without
 *  it a useAssetURL that resolved BEFORE the rename completed would keep
 *  showing the (cached empty) old result until the next AssetStore swap. */
export function notifyAssetStoreChange(): void {
  _version++;
  for (const fn of _listeners) fn();
}

export class AssetStore {
  /** Root directory handle the user picked. Every read/write is rooted here. */
  private rootDir: FileSystemDirectoryHandle;
  /** Display name (the directory's name). Shown in the title bar. */
  readonly rootName: string;
  /** path → blob URL. Loaded lazily on first read, cached until destroy or
   *  overwrite. */
  private urls = new Map<string, string>();
  /** path → in-flight Promise so concurrent reads coalesce instead of racing. */
  private pending = new Map<string, Promise<string>>();
  /** In-flight rename / copy / dir-delete operations. Autosave gates on
   *  this — saving the manifest in the middle of a folder rename would
   *  write metadata pointing at a partially-populated destination. */
  private _pendingDiskOps = 0;
  /** True while any rename / copy / dir-delete is mid-flight. */
  get isDiskBusy(): boolean { return this._pendingDiskOps > 0; }

  constructor(rootDir: FileSystemDirectoryHandle) {
    this.rootDir = rootDir;
    this.rootName = rootDir.name;
  }

  /** Resolve a project-relative path (e.g. "assets/Characters/Player/idle_0.png")
   *  to a blob URL. Cached. Returns the empty string when the file is missing
   *  so consumers don't crash on dangling refs — a missing-asset warning shows
   *  in the Output Log instead. */
  async getBlobURL(path: string): Promise<string> {
    if (!path) return "";
    const cached = this.urls.get(path);
    if (cached !== undefined) return cached;
    const inFlight = this.pending.get(path);
    if (inFlight) return inFlight;
    const p = this._load(path).finally(() => { this.pending.delete(path); });
    this.pending.set(path, p);
    return p;
  }

  private async _load(path: string): Promise<string> {
    try {
      const file = await this._getFile(path, { create: false });
      const url = URL.createObjectURL(file);
      this.urls.set(path, url);
      return url;
    } catch (err) {
      // File missing or unreadable. Cache the miss as "" so we don't retry
      // every render. Authors will see the Output Log warning and either
      // re-import or delete the reference.
      console.warn(`[AssetStore] missing asset: ${path}`, err);
      this.urls.set(path, "");
      return "";
    }
  }

  /** Bulk preload — used by runProject before booting a scene so Phaser's
   *  loader can synchronously consume the cached URLs. Failures are surfaced
   *  via the per-path getBlobURL warning; the returned promise always resolves. */
  async preload(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.getBlobURL(p)));
  }

  /** Sync read of the cached URL — returns "" if not yet resolved. Used by
   *  Phaser's preload hook AFTER an awaited bulk preload() warmed the cache,
   *  so the hook can queue load.image(key, url) synchronously without
   *  returning to the event loop. */
  getCachedURL(path: string): string {
    return this.urls.get(path) ?? "";
  }

  /** Write (or overwrite) a binary asset at `path`. Creates intermediate
   *  directories. Invalidates the cached blob URL AND broadcasts a version
   *  bump so React hooks re-resolve — without the broadcast, any hook that
   *  previously resolved while the file didn't exist (cached "") would
   *  keep returning "" forever even after the file lands. */
  async writeBlob(path: string, blob: Blob): Promise<void> {
    const fh = await this._getFileHandle(path, { create: true });
    const writable = await fh.createWritable();
    await writable.write(blob);
    await writable.close();
    this._invalidate(path);
    notifyAssetStoreChange();
  }

  /** Read+parse a JSON file (the project manifest). Throws if missing/invalid. */
  async readJSON<T>(path: string): Promise<T> {
    const file = await this._getFile(path, { create: false });
    const text = await file.text();
    return JSON.parse(text) as T;
  }

  /** Read a raw file. Returns null when missing/unreadable so callers
   *  iterating via walkFiles can skip cleanly without try/catch. */
  async readFile(path: string): Promise<File | null> {
    try { return await this._getFile(path, { create: false }); }
    catch { return null; }
  }

  /** Write a JSON file. Pretty-printed (2-space). */
  async writeJSON(path: string, value: unknown): Promise<void> {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    await this.writeBlob(path, blob);
  }

  /** Delete a single file. No-op if missing. Recursive directory deletion is
   *  intentionally separate (deleteDir) so a stray writeBlob can't wipe a tree. */
  async deleteFile(path: string): Promise<void> {
    const parts = this._split(path);
    if (parts.length === 0) return;
    try {
      const parent = await this._getDir(parts.slice(0, -1), { create: false });
      await parent.removeEntry(parts[parts.length - 1]);
      this._invalidate(path);
      notifyAssetStoreChange();
    } catch (err) {
      // Missing → ok. Real errors get logged so silent delete failures don't
      // leave the project referencing files that "should be" gone.
      const msg = (err as Error).message ?? String(err);
      if (!/not found|NotFoundError/i.test(msg)) {
        console.warn(`[AssetStore] deleteFile failed: ${path}`, err);
      }
    }
  }

  /** Recursive directory delete. Used when a SpriteAsset is removed (its
   *  whole folder of frames goes with it) or a content-browser folder is
   *  dropped. */
  async deleteDir(path: string): Promise<void> {
    const parts = this._split(path);
    if (parts.length === 0) return;
    try {
      const parent = await this._getDir(parts.slice(0, -1), { create: false });
      await parent.removeEntry(parts[parts.length - 1], { recursive: true });
      // Invalidate every cached URL under this prefix.
      const pfx = path.endsWith("/") ? path : path + "/";
      for (const key of Array.from(this.urls.keys())) {
        if (key === path || key.startsWith(pfx)) this._invalidate(key);
      }
      notifyAssetStoreChange();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (!/not found|NotFoundError/i.test(msg)) {
        console.warn(`[AssetStore] deleteDir failed: ${path}`, err);
      }
    }
  }

  /** Rename / move a file. The FSAA spec doesn't expose atomic rename, so
   *  this copies-then-deletes. Cached URL gets re-keyed. On case-insensitive
   *  filesystems (Windows local FS over FSAA) a case-only rename resolves
   *  source and destination to the same file handle — the copy would be a
   *  read-then-write on the same target and the delete would nuke the
   *  result. Detect that and route via a temp filename. */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    if (oldPath.toLowerCase() === newPath.toLowerCase()) {
      const tmp = `${oldPath}.__case_tmp_${this._tempSuffix()}`;
      this._pendingDiskOps++;
      try {
        await this.renameFile(oldPath, tmp);
        await this.renameFile(tmp, newPath);
      } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
      return;
    }
    this._pendingDiskOps++;
    try {
      const file = await this._getFile(oldPath, { create: false });
      const blob = await file.arrayBuffer();
      await this.writeBlob(newPath, new Blob([blob], { type: file.type || "application/octet-stream" }));
      await this.deleteFile(oldPath);
    } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
  }

  /** Rename / move a directory (recursive copy + delete). The FSAA spec
   *  doesn't expose atomic dir rename either. Used when an asset whose
   *  on-disk folder is derived from its name (sprite, tileset) gets
   *  renamed in the editor — keeps the file system in sync without the
   *  caller having to walk children. No-op on equal paths or when the
   *  source dir is missing.
   *
   *  Case-only renames ("Hero" → "hero" on Windows) collapse to the same
   *  handle on case-insensitive filesystems. Route them via a temp dir to
   *  avoid copy-into-self-then-delete-self. */
  async renameDir(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    if (oldPath.toLowerCase() === newPath.toLowerCase()) {
      const tmp = `${oldPath}.__case_tmp_${this._tempSuffix()}`;
      this._pendingDiskOps++;
      try {
        await this.renameDir(oldPath, tmp);
        await this.renameDir(tmp, newPath);
      } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
      return;
    }
    const oldParts = this._split(oldPath);
    if (oldParts.length === 0) return;
    this._pendingDiskOps++;
    try {
      let srcDir: FileSystemDirectoryHandle;
      try { srcDir = await this._getDir(oldParts, { create: false }); }
      catch { return; }
      await this._copyDir(srcDir, newPath);
      await this.deleteDir(oldPath);
      // Invalidate cached "" misses under the NEW prefix too. React hooks
      // that re-resolved a NEW-path URL during the in-flight rename window
      // (before _copyDir finished) cached a missing-asset "" — without this
      // bust they'd keep returning "" forever and the assets look "still on
      // disk but gone in the engine".
      const newPfx = newPath.endsWith("/") ? newPath : newPath + "/";
      for (const key of Array.from(this.urls.keys())) {
        if (key === newPath || key.startsWith(newPfx)) this._invalidate(key);
      }
    } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
  }

  /** Recursive copy of every entry under `srcPath` to `destPath`. Used when
   *  duplicating an asset whose binary lives in its own folder (sprite frames,
   *  tileset atlas). No-op when the source doesn't exist. */
  async copyDir(srcPath: string, destPath: string): Promise<void> {
    if (srcPath === destPath) return;
    const parts = this._split(srcPath);
    this._pendingDiskOps++;
    try {
      let srcDir: FileSystemDirectoryHandle;
      try { srcDir = await this._getDir(parts, { create: false }); }
      catch { return; }
      await this._copyDir(srcDir, destPath);
    } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
  }

  /** Copy a single file from src to dest. Used by sprite-frame paste/dup
   *  to give the new frame its own on-disk PNG (without it, edits to one
   *  copy would silently overwrite the source). */
  async copyFile(srcPath: string, destPath: string): Promise<void> {
    if (srcPath === destPath) return;
    this._pendingDiskOps++;
    try {
      const file = await this._getFile(srcPath, { create: false });
      const blob = await file.arrayBuffer();
      await this.writeBlob(destPath, new Blob([blob], { type: file.type || "application/octet-stream" }));
    } catch (err) {
      console.warn(`[AssetStore] copyFile failed: ${srcPath} → ${destPath}`, err);
    } finally { this._pendingDiskOps--; notifyAssetStoreChange(); }
  }

  /** Suffix for temp-rename paths. Date.now()-style but the FSAA doesn't
   *  block on Date so we use a counter to keep it pure. */
  private _tempCounter = 0;
  private _tempSuffix(): string {
    return `${++this._tempCounter}_${Math.floor(performance.now())}`;
  }

  /** Recursive copy of every entry under `srcDir` into `destPath`. */
  private async _copyDir(srcDir: FileSystemDirectoryHandle, destPath: string): Promise<void> {
    // Browser-shipped API; TS lib lags. Same shim as listDir().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const entry of (srcDir as any).values()) {
      const childDest = destPath ? `${destPath}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        const file = await (entry as FileSystemFileHandle).getFile();
        const blob = await file.arrayBuffer();
        await this.writeBlob(childDest, new Blob([blob], { type: file.type || "application/octet-stream" }));
      } else {
        await this._copyDir(entry as FileSystemDirectoryHandle, childDest);
      }
    }
  }

  /** Returns true if the path exists. Used by the loader to detect "is this
   *  directory already a Peaky project". */
  async exists(path: string): Promise<boolean> {
    try { await this._getFile(path, { create: false }); return true; }
    catch { return false; }
  }

  /** Recursively yield every file path under `rootPath` (project-relative).
   *  Returns nothing when the root doesn't exist. Used by the orphan GC to
   *  enumerate everything on disk and diff against the manifest. */
  async *walkFiles(rootPath: string): AsyncGenerator<string> {
    const parts = this._split(rootPath);
    let dir: FileSystemDirectoryHandle;
    try { dir = await this._getDir(parts, { create: false }); }
    catch { return; }
    yield* this._walkDir(dir, rootPath);
  }

  private async *_walkDir(dir: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const entry of (dir as any).values()) {
      const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        yield childPath;
      } else {
        yield* this._walkDir(entry as FileSystemDirectoryHandle, childPath);
      }
    }
  }

  /** List entries in a directory (one level deep). Used by the Content Browser
   *  to mirror the on-disk tree. */
  async listDir(path: string): Promise<{ name: string; kind: "file" | "directory" }[]> {
    const parts = this._split(path);
    try {
      const dir = await this._getDir(parts, { create: false });
      const out: { name: string; kind: "file" | "directory" }[] = [];
      // @ts-expect-error - .values() is a real method on FileSystemDirectoryHandle, types lag
      for await (const entry of dir.values()) {
        out.push({ name: entry.name, kind: entry.kind });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Free every cached blob URL. Idempotent. */
  destroy(): void {
    for (const url of this.urls.values()) {
      if (url) URL.revokeObjectURL(url);
    }
    this.urls.clear();
    this.pending.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private _invalidate(path: string): void {
    const old = this.urls.get(path);
    if (old) URL.revokeObjectURL(old);
    this.urls.delete(path);
  }

  /** Split a slash path into segments, stripping leading/trailing slashes. */
  private _split(path: string): string[] {
    return path.split("/").filter((s) => s.length > 0);
  }

  /** Resolve the directory at `parts` from the root. Optionally creates
   *  intermediate dirs. */
  private async _getDir(parts: string[], opts: { create: boolean }): Promise<FileSystemDirectoryHandle> {
    let dir: FileSystemDirectoryHandle = this.rootDir;
    for (const p of parts) {
      dir = await dir.getDirectoryHandle(p, { create: opts.create });
    }
    return dir;
  }

  /** Resolve a file handle. */
  private async _getFileHandle(path: string, opts: { create: boolean }): Promise<FileSystemFileHandle> {
    const parts = this._split(path);
    if (parts.length === 0) throw new Error("empty path");
    const parent = await this._getDir(parts.slice(0, -1), opts);
    return parent.getFileHandle(parts[parts.length - 1], { create: opts.create });
  }

  /** Resolve a file (the File blob). */
  private async _getFile(path: string, opts: { create: boolean }): Promise<File> {
    const fh = await this._getFileHandle(path, opts);
    return fh.getFile();
  }
}

/* ─── Path helpers ─────────────────────────────────────────────────────────

These compute on-disk paths from project entities. The convention:

  - Content-browser path (e.g. "/Characters") + asset name ("Player") →
    "assets/Characters/Player[/ ...]". Leading slash in the CB path is dropped
    so the resulting disk path stays relative.
  - Asset names and folder segments must already be sanitized to filesystem-
    safe characters (existing sanitizeAssetName / sanitizeFolderPath in the
    editor handle this).

────────────────────────────────────────────────────────────────────────── */

/** Project-relative folder a SpriteAsset's frames live in. */
export function spriteDiskFolder(sprite: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(sprite.path), sprite.name);
}

/** Project-relative disk path for one frame of a sprite. Frame paths are
 *  stored on SpriteFrame.path as a filename-only (no slashes) to keep the
 *  on-disk layout flat under the sprite folder. */
export function spriteFrameDiskPath(sprite: { path: string; name: string }, frameFile: string): string {
  return joinPath(spriteDiskFolder(sprite), frameFile);
}

/** Project-relative folder a TilesetAsset's image lives in. */
export function tilesetDiskFolder(tileset: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(tileset.path), tileset.name);
}

export function tilesetImageDiskPath(tileset: { path: string; name: string }, ext: string): string {
  return joinPath(tilesetDiskFolder(tileset), `tileset.${ext}`);
}

/** Project-relative disk path for a SoundAsset. The asset's `file` field
 *  carries the filename (with extension); we just compose it under the
 *  asset's content-browser folder. */
export function soundDiskPath(sound: { path: string; file: string }): string {
  return joinPath("assets", trimSlashes(sound.path), sound.file);
}

/** Fonts don't have a content-browser path field — they live flat under
 *  assets/fonts/. The `file` field carries the filename (with extension). */
export function fontDiskPath(font: { file: string }): string {
  return joinPath("assets/fonts", font.file);
}

/** Project-relative disk path for a TilesetAsset's atlas image. The asset's
 *  `imageFile` field is the filename within the tileset's folder. */
export function tilesetImagePath(tileset: { path: string; name: string; imageFile: string }): string {
  return joinPath(tilesetDiskFolder(tileset), tileset.imageFile);
}

export const PROJECT_MANIFEST_FILE = "project.peaky.json";

/* ─── Per-asset JSON file paths ────────────────────────────────────────────

Each "big" asset gets its own .json file at:
  assets/<cb-path>/<name>.<type>.json

The CB path mirrors the asset's `path` field; the suffix discriminates the
asset type for disk-side glance-ability AND lets a sprite folder
(`assets/Characters/Hero/`) and a sprite metadata file
(`assets/Characters/Hero.sprite.json`) coexist without collision.

────────────────────────────────────────────────────────────────────────── */

export function blueprintDiskPath(bp: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(bp.path), `${bp.name}.bp.json`);
}
export function sceneDiskPath(sc: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(sc.path), `${sc.name}.scene.json`);
}
export function spriteMetaDiskPath(sp: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(sp.path), `${sp.name}.sprite.json`);
}
export function tilesetMetaDiskPath(ts: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(ts.path), `${ts.name}.tileset.json`);
}
export function tilemapDiskPath(tm: { path: string; name: string }): string {
  return joinPath("assets", trimSlashes(tm.path), `${tm.name}.tilemap.json`);
}
export function dialogueDiskPath(d: { path?: string; name: string }): string {
  return joinPath("assets", trimSlashes(d.path ?? "/Dialogues"), `${d.name}.dlg.json`);
}
export function uiWidgetDiskPath(w: { path?: string; name: string }): string {
  return joinPath("assets", trimSlashes(w.path ?? "/UI"), `${w.name}.widget.json`);
}
export function itemDiskPath(it: { path?: string; name: string }): string {
  return joinPath("assets", trimSlashes(it.path ?? "/Items"), `${it.name}.item.json`);
}
export function recipeDiskPath(r: { path?: string; name: string }): string {
  return joinPath("assets", trimSlashes(r.path ?? "/Recipes"), `${r.name}.recipe.json`);
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

/** Detect file extension from a data URL's mime — used during one-time import
 *  to pick a sensible on-disk filename. Returns "" if unknown. */
export function extFromDataUrl(dataUrl: string): string {
  const m = /^data:([^;]+);/.exec(dataUrl);
  if (!m) return "";
  const mime = m[1].toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/wav" || mime === "audio/wave" || mime === "audio/x-wav") return "wav";
  if (mime === "font/ttf" || mime === "application/x-font-ttf") return "ttf";
  if (mime === "font/otf" || mime === "application/x-font-otf") return "otf";
  if (mime === "font/woff") return "woff";
  if (mime === "font/woff2") return "woff2";
  // application/octet-stream and the like — best effort, caller falls back.
  return "";
}

/** Convert a data URL into a Blob (one-time use during import-existing-project
 *  paths if we add them later, or test fixtures). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mimeMatch = /:([^;]+);/.exec(head);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const isBase64 = /;base64/i.test(head);
  if (isBase64) {
    const bin = atob(body);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** Read an on-disk asset as a data URL — convenience for code paths that
 *  do image manipulation through a canvas + dataURL pipeline. Returns null
 *  when the asset is missing or no project is open. */
export async function readAssetAsDataURL(diskPath: string): Promise<string | null> {
  const store = getActiveAssetStore();
  if (!store) return null;
  const url = await store.getBlobURL(diskPath);
  if (!url) return null;
  const res = await fetch(url);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Write a data URL out as a binary asset. Used after image-manipulation
 *  pipelines that produce new dataURLs. Returns true on success. */
export async function writeAssetFromDataURL(diskPath: string, dataUrl: string): Promise<boolean> {
  const store = getActiveAssetStore();
  if (!store) return false;
  const blob = dataUrlToBlob(dataUrl);
  await store.writeBlob(diskPath, blob);
  return true;
}
