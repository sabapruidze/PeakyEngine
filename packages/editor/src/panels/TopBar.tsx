import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { TabBar } from "./TabBar";
import { Documentation } from "./NodeReference";
import { emptyProject, type PeakyProject } from "../project";
import { exportWebPhase1, downloadProjectBackup } from "../exportGame";
import {
  AssetStore,
  setActiveAssetStore,
  getActiveAssetStore,
  PROJECT_MANIFEST_FILE,
} from "../AssetStore";
import {
  saveDirHandle,
  readDirHandle,
  clearDirHandle,
  ensureReadWritePermission,
} from "../dirHandleCache";
import {
  loadProjectFromFolder,
  saveProjectToFolder,
  EmptyStateWipeError,
} from "../projectFolderIO";

/** Editor build version — shown as a badge in the header so the author can
 *  confirm at a glance they're running the latest build after a hard refresh.
 *  Keep in sync with package.json. */
const ENGINE_VERSION = "0.0.1";

/** Module-level directory handle for the open folder project. Held outside
 *  React state so it survives re-renders and isn't reset on every keystroke
 *  in unrelated UI. Cleared on Close. */
let _dirHandle: FileSystemDirectoryHandle | null = null;

/** Sniff-check for the FS Access API. Folder projects only work in browsers
 *  that expose `showDirectoryPicker` — Chrome / Edge / Brave / Opera at the
 *  time of writing. */
function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/**
 * Top header card — project name on the left, folder-project File menu next
 * to it, tabs strip in the middle, run-status pill + Play button on the
 * right.
 *
 * v7 / folder mode:
 * - Projects live on disk as a directory: `project.peaky.json` manifest +
 *   `assets/` subtree of binary files (sprite frames, sounds, tilesets,
 *   fonts).
 * - The user picks a folder once per session; the AssetStore caches blob
 *   URLs from that directory for the rest of the editor.
 * - Save writes the manifest only — binary assets land on disk
 *   incrementally via the import flows (drag a PNG in, it writes the PNG
 *   immediately and references it from the manifest).
 */
export function TopBar() {
  const projectName = useEditor((s) => s.project.name);
  const setProjectName = useEditor((s) => s.setProjectName);
  const isRunning = useEditor((s) => s.isRunning);
  const setRunning = useEditor((s) => s.setRunning);
  const setActiveTab = useEditor((s) => s.setActiveTab);
  const project = useEditor((s) => s.project);
  const loadProject = useEditor((s) => s.loadProject);
  const newProject = useEditor((s) => s.newProject);

  const [boundDirName, setBoundDirName] = useState<string | null>(_dirHandle?.name ?? null);
  // Live FPS counter — polls Peaky's getActualFps() every 250ms while the
  // game is running. The 250ms tick is cheap and smooths over Phaser's
  // per-frame jitter so the number doesn't bounce wildly. Disabled when
  // not running so we don't poll a stale game instance.
  const [liveFps, setLiveFps] = useState<number>(0);
  useEffect(() => {
    if (!isRunning) { setLiveFps(0); return; }
    const tick = () => {
      const g = (window as unknown as { __peakyGame?: { getActualFps?: () => number } }).__peakyGame;
      setLiveFps(g?.getActualFps ? g.getActualFps() : 0);
    };
    tick(); // immediate first read so 0 doesn't linger
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [isRunning]);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [nodeRefOpen, setNodeRefOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  // Cached handle from IndexedDB, surfaced as a "Reopen <name>" hint when no
  // folder is currently bound. Permission state is browser-revoked on reload
  // so we can't auto-mount — needs a click. null = no cached handle.
  const [cachedHandle, setCachedHandle] = useState<FileSystemDirectoryHandle | null>(null);
  useEffect(() => {
    if (_dirHandle) return; // already have a live handle, no point checking cache
    void readDirHandle().then((h) => setCachedHandle(h));
  }, []);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!fileMenuRef.current?.contains(e.target as Node)) setFileMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [fileMenuOpen]);

  const supportsDir = supportsDirectoryPicker();

  /** Write the project to the currently-bound folder using the split-file
   *  layout. Walks every asset list, writes each to its own .json file,
   *  then writes the manifest with paths. Binary assets (PNG / audio /
   *  fonts) are unchanged — those live on disk via the import paths. */
  const writeManifest = async (p: PeakyProject) => {
    const store = getActiveAssetStore();
    if (!store) throw new Error("no project folder open");
    await saveProjectToFolder(store, p);
  };

  /** Save — writes project.peaky.json into the open folder. Silently no-ops
   *  when no folder is open (the Save menu item is disabled in that case).
   *  If the empty-state guard trips, prompt the user before allowing the
   *  wipe — they may have legitimately deleted all assets of a type. */
  const handleSave = async () => {
    if (!_dirHandle) {
      alert("Open or create a folder project first — Save needs a target folder.");
      return;
    }
    try {
      await writeManifest(useEditor.getState().project);
    } catch (err) {
      if (err instanceof EmptyStateWipeError) {
        const ok = window.confirm(
          `Save will remove ALL entries of the following asset type(s) from disk:\n\n` +
          `    ${err.wipedTypes.join(", ")}\n\n` +
          `This is normal if you deleted them on purpose. It's catastrophic if it's a state bug.\n\n` +
          `Continue with the save?`,
        );
        if (!ok) return;
        try {
          const store = getActiveAssetStore();
          if (!store) throw new Error("no project folder open");
          await saveProjectToFolder(store, useEditor.getState().project, { allowWipe: true });
        } catch (retryErr) {
          alert(`Save failed: ${(retryErr as Error).message}`);
        }
        return;
      }
      alert(`Save failed: ${(err as Error).message}`);
    }
  };

  /** Save As — pick a NEW folder, copy every file from the current project's
   *  folder into it, then write the current in-memory manifest on top so any
   *  unsaved edits land in the copy. After completion the active store
   *  switches to the new folder, so subsequent Save writes there. The old
   *  folder is left untouched (this is a duplicate, not a move). */
  const handleSaveAs = async () => {
    if (!_dirHandle) {
      alert("Open a folder project first — Save As copies its files into a new folder.");
      return;
    }
    if (!supportsDir) {
      alert("Save As needs Chromium's File System Access API (Chrome / Edge / Brave / Opera).");
      return;
    }
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const target = await picker({ mode: "readwrite" });
      // Refuse same-folder (would be a no-op at best, double-write race at worst).
      try {
        if (await target.isSameEntry(_dirHandle)) {
          alert("Pick a DIFFERENT folder for Save As — selecting the current one would just overwrite it.");
          return;
        }
      } catch { /* isSameEntry not supported on older browsers; fall through */ }
      // Block on non-empty target so we don't silently merge into an unrelated project.
      // @ts-expect-error - .values() is a real method on FileSystemDirectoryHandle, types lag
      const iter = target.values?.();
      if (iter) {
        const first = await iter.next();
        if (!first.done) {
          const ok = window.confirm(
            `"${target.name}" already contains files. ` +
            "Continue and overwrite anything with the same name? " +
            "Files only present in the current project will be added; files only present in the target will be left alone.",
          );
          if (!ok) return;
        }
      }
      const source = getActiveAssetStore();
      if (!source) throw new Error("no active project store");
      // Temp store on the target handle for serial writes.
      const targetStore = new AssetStore(target);
      // Step 1: Flush in-memory edits to the SOURCE folder so the copy is a
      // coherent disk-to-disk snapshot (no race against in-memory state).
      try {
        await saveProjectToFolder(source, useEditor.getState().project);
      } catch (flushErr) {
        if (flushErr instanceof EmptyStateWipeError) {
          const ok = window.confirm(
            `Saving the current project to its original folder before duplicating would remove ALL entries of: ${flushErr.wipedTypes.join(", ")}.\n\n` +
            `Continue? (The duplicate will have the same state.)`,
          );
          if (!ok) { targetStore.destroy(); return; }
          try {
            await saveProjectToFolder(source, useEditor.getState().project, { allowWipe: true });
          } catch (retryErr) {
            alert(`Save As aborted — couldn't flush source folder: ${(retryErr as Error).message}`);
            targetStore.destroy();
            return;
          }
        } else {
          alert(`Couldn't flush unsaved edits to the current folder first: ${(flushErr as Error).message}. Save As aborted.`);
          targetStore.destroy();
          return;
        }
      }
      // Step 2: SERIAL file-by-file copy of EVERYTHING. Parallel writes to
      // the File System Access API can race on intermediate directory
      // creation; serial avoids it entirely.
      let copied = 0;
      const paths: string[] = [];
      for await (const p of source.walkFiles("")) paths.push(p);
      for (const path of paths) {
        const file = await source.readFile(path);
        if (!file) continue;
        await targetStore.writeBlob(path, file);
        copied++;
      }
      // Step 3: Verify the manifest landed on the target and patch its name.
      const manifestThere = await targetStore.exists("project.peaky.json");
      if (!manifestThere) {
        alert(
          `Files copied (${copied}) but project.peaky.json was missing in the SOURCE folder ` +
          `— Save As needs a fully-saved source. Open the source folder, hit Save, then try Save As again.`,
        );
        targetStore.destroy();
        return;
      }
      try {
        const manifest = await targetStore.readJSON<{ name: string } & Record<string, unknown>>("project.peaky.json");
        manifest.name = target.name;
        await targetStore.writeJSON("project.peaky.json", manifest);
      } catch (renameErr) {
        alert(
          `Files copied (${copied}) but couldn't patch the manifest name: ` +
          `${(renameErr as Error).message}. The duplicate folder still loads under its original project name.`,
        );
      }
      // Step 4: Switch fully onto the new folder. Re-load the project from
      // the target so every panel re-reads from the new store and the project
      // name in tabs / title bar refreshes.
      let reloaded: PeakyProject;
      try {
        reloaded = await loadProjectFromFolder(targetStore);
      } catch (loadErr) {
        alert(`Files copied but couldn't re-load from new folder: ${(loadErr as Error).message}`);
        targetStore.destroy();
        return;
      }
      _dirHandle = target;
      setActiveAssetStore(targetStore);
      setBoundDirName(target.name);
      loadProject(reloaded);
      setProjectName(target.name);
      void saveDirHandle(target);
      alert(`Copied ${copied} files into "${target.name}". You're now editing the duplicate; the original folder is untouched.`);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      alert(`Save As failed: ${(err as Error).message}`);
    }
  };

  /** Pick a directory, load its `project.peaky.json` if one exists. */
  const handleOpenFolder = async () => {
    if (!supportsDir) {
      alert(
        "Folder projects require a Chromium browser (Chrome / Edge / Brave / Opera). " +
        "Firefox and Safari don't expose the File System Access API yet.",
      );
      return;
    }
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: "readwrite" });
      const store = new AssetStore(handle);
      // The manifest is the source of truth — if it isn't there, treat the
      // directory as "not a Peaky project" and offer to initialize.
      const hasManifest = await store.exists(PROJECT_MANIFEST_FILE);
      if (!hasManifest) {
        const ok = window.confirm(
          `"${handle.name}" doesn't contain a Peaky project yet. ` +
          `Initialize it with an empty project?`,
        );
        if (!ok) { store.destroy(); return; }
        // Initialize: write a blank manifest and mount the store. Asset
        // imports will create assets/ on first use.
        _dirHandle = handle;
        setActiveAssetStore(store);
        setBoundDirName(handle.name);
        newProject();
        setProjectName(handle.name);
        await writeManifest(useEditor.getState().project);
        return;
      }
      let parsed: PeakyProject;
      try { parsed = await loadProjectFromFolder(store); }
      catch (e) { store.destroy(); alert(`Could not open: ${(e as Error).message}`); return; }
      if (!validateProject(parsed)) { store.destroy(); return; }
      _dirHandle = handle;
      setActiveAssetStore(store);
      setBoundDirName(handle.name);
      loadProject(parsed);
      // Mirror the directory name into the editor — author expectation set
      // earlier (see basenameOf / project-name fix).
      setProjectName(handle.name);
      void saveDirHandle(handle);
      setCachedHandle(null);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      alert(`Open folder failed: ${(err as Error).message}`);
    }
  };

  /** Reopen a folder cached in IndexedDB from the previous session. Must
   *  be called from a user gesture (button click) — the permission prompt
   *  silently fails otherwise. Falls back to the full picker on permission
   *  denial or missing manifest. */
  const handleReopen = async () => {
    if (!cachedHandle) return;
    const ok = await ensureReadWritePermission(cachedHandle);
    if (!ok) {
      // User declined the permission prompt; offer the full picker.
      void handleOpenFolder();
      return;
    }
    try {
      const store = new AssetStore(cachedHandle);
      const hasManifest = await store.exists(PROJECT_MANIFEST_FILE);
      if (!hasManifest) {
        alert(
          `"${cachedHandle.name}" no longer contains a Peaky project. ` +
          `Pick another folder.`,
        );
        store.destroy();
        await clearDirHandle();
        setCachedHandle(null);
        void handleOpenFolder();
        return;
      }
      let parsed: PeakyProject;
      try { parsed = await loadProjectFromFolder(store); }
      catch (e) { store.destroy(); alert(`Could not reopen: ${(e as Error).message}`); return; }
      if (!validateProject(parsed)) { store.destroy(); return; }
      _dirHandle = cachedHandle;
      setActiveAssetStore(store);
      setBoundDirName(cachedHandle.name);
      loadProject(parsed);
      setProjectName(cachedHandle.name);
      setCachedHandle(null);
    } catch (err) {
      alert(`Reopen failed: ${(err as Error).message}`);
    }
  };

  /** Start a new empty project inside a freshly-picked directory. */
  const handleNewFolder = async () => {
    if (!supportsDir) {
      alert(
        "Folder projects require a Chromium browser (Chrome / Edge / Brave / Opera). " +
        "Firefox and Safari don't expose the File System Access API yet.",
      );
      return;
    }
    if (_dirHandle) {
      const ok = window.confirm(
        "Start a new project in a different folder? Your current project will close. " +
        "Save first if you have unsaved manifest changes.",
      );
      if (!ok) return;
    }
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: "readwrite" });
      const store = new AssetStore(handle);
      // Guard against accidentally overwriting an existing project.
      const hasManifest = await store.exists(PROJECT_MANIFEST_FILE);
      if (hasManifest) {
        const ok = window.confirm(
          `"${handle.name}" already contains a Peaky project. Open it instead of overwriting?`,
        );
        if (!ok) { store.destroy(); return; }
        let parsed: PeakyProject;
        try { parsed = await loadProjectFromFolder(store); }
        catch (e) { store.destroy(); alert(`Could not open: ${(e as Error).message}`); return; }
        if (!validateProject(parsed)) { store.destroy(); return; }
        _dirHandle = handle;
        setActiveAssetStore(store);
        setBoundDirName(handle.name);
        loadProject(parsed);
        setProjectName(handle.name);
        void saveDirHandle(handle);
        setCachedHandle(null);
        return;
      }
      _dirHandle = handle;
      setActiveAssetStore(store);
      setBoundDirName(handle.name);
      newProject();
      setProjectName(handle.name);
      await writeManifest(useEditor.getState().project);
      void saveDirHandle(handle);
      setCachedHandle(null);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      alert(`New folder project failed: ${(err as Error).message}`);
    }
  };

  /** Close the open folder — clears the AssetStore and resets to a blank
   *  in-memory project. The folder on disk is untouched. */
  const handleClose = () => {
    if (_dirHandle) {
      const ok = window.confirm("Close the current folder project? Save any unsaved manifest changes first.");
      if (!ok) return;
    }
    _dirHandle = null;
    setActiveAssetStore(null);
    setBoundDirName(null);
    // Reset the in-memory project so the editor isn't showing stale
    // references to assets the (now-closed) store can no longer resolve.
    newProject();
    // Forget the cached handle — Close means "no folder open." A future
    // reload starts with no Reopen suggestion.
    void clearDirHandle();
    setCachedHandle(null);
  };

  /** Validate the loaded project looks like a Peaky project. Runs after
   *  loadProjectFromFolder has already parsed + assembled the arrays from
   *  per-asset files, so the shape check matches the in-memory view. */
  const validateProject = (parsed: unknown): parsed is PeakyProject => {
    if (typeof parsed !== "object" || parsed === null || !("blueprints" in parsed) || !("scenes" in parsed)) {
      alert(`The folder's ${PROJECT_MANIFEST_FILE} doesn't look like a Peaky project — missing blueprints or scenes.`);
      return false;
    }
    const p = parsed as { version?: number };
    if (p.version !== 8) {
      alert(`Unsupported project version (${p.version ?? "unknown"}). This editor expects v8 split-file projects.`);
      return false;
    }
    return true;
  };

  /** Export the current project as a Web game build (Phase 2 — produces
   *  a real ZIP with index.html, project.json, peaky-standalone.js (when
   *  available), and all asset files under assets/). The runtime bundle
   *  is fetched from /peaky-standalone.js, which `npm run build:standalone`
   *  in packages/runtime + a copy into packages/editor/public/ produces. */
  const handleExportWeb = async () => {
    const { project } = useEditor.getState();
    try {
      await exportWebPhase1(project);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[export] failed:", err);
      alert("Export failed: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  /** Download an off-machine backup of the EDITABLE project (every file on
   *  disk) as a single .zip — keep it in the cloud / on a drive. Restore by
   *  unzipping into a folder and File → Open Folder. */
  const handleBackup = async () => {
    const { project } = useEditor.getState();
    try {
      const { files, bytes } = await downloadProjectBackup(project.name);
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      alert(`Backup downloaded — ${files} files, ${mb} MB.\nStore the .zip somewhere safe (cloud / external drive). To restore: unzip it into a folder, then File → Open Folder.`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[backup] failed:", err);
      alert("Backup failed: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  /** Best-effort tab close. window.close() no-ops in modern browsers for
   *  user-opened tabs; surface that so users know the button isn't broken. */
  const handleQuit = () => {
    const ok = window.confirm("Quit Peaky? Save first if you have unsaved manifest changes.");
    if (!ok) return;
    window.close();
    setTimeout(() => {
      alert("Your browser won't let me close this tab. Use Ctrl+W or close the tab manually.");
    }, 50);
  };

  // Ctrl+S → save manifest. Skipped when focus is in an editable, so typing
  // doesn't trigger a save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      void handleSave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Saved status — surfaced as a small badge so the author can tell when
  // edits are on disk vs still pending. "dirty" right after a project
  // mutation, "saving" during the write, "saved" once the write
  // completed. Drives the beforeunload guard too.
  const [saveStatus, setSaveStatus] = useState<"saved" | "dirty" | "saving">("saved");

  // Autosave the project on any mutation, debounced. Required for folder
  // mode because disk writes happen IMMEDIATELY for asset content (frame
  // PNGs, audio files, tileset images) and for asset folder renames. Without
  // this a reload-before-Ctrl+S would diverge: JSON references the old
  // name, disk has the new folder. The debounce keeps the write off the
  // hot path while the user is making rapid edits.
  useEffect(() => {
    const store = getActiveAssetStore();
    if (!store) return;
    // Skip the initial mount — project hasn't mutated yet, no need to mark
    // dirty. Subsequent runs (when [project] changes) flip to "dirty" until
    // the timer fires.
    setSaveStatus("dirty");
    let handle: ReturnType<typeof setTimeout>;
    const tryRun = () => {
      // Don't save while any folder rename / copy / dir-delete is mid-
      // flight. Saving the manifest in that window would point metadata
      // at a partially-populated destination; on next load the GC would
      // see real binary files as unreferenced and delete them.
      if (store.isDiskBusy) {
        handle = setTimeout(tryRun, 250);
        return;
      }
      setSaveStatus("saving");
      void saveProjectToFolder(store, useEditor.getState().project)
        .then(() => {
          setSaveStatus("saved");
          // Make the autosaveStatus badge truthful — this is now the only
          // writer of autosaveStatus (the dead IDB autosave that used to set
          // it was removed). Success = "ok".
          useEditor.getState().setAutosaveStatus("ok");
        })
        .catch((err) => {
          console.warn("[autosave] save failed:", err);
          setSaveStatus("dirty");
          const guard = err instanceof EmptyStateWipeError;
          useEditor.getState().setAutosaveStatus("broken", {
            error: err instanceof Error ? err.message : String(err),
            guard,
          });
        });
    };
    handle = setTimeout(tryRun, 800);
    return () => clearTimeout(handle);
  }, [project]);

  // beforeunload safety net: warn if the page is about to unload with
  // unsaved edits. Browsers ignore the message string and show a generic
  // "are you sure" — what matters is returning a truthy string to trigger
  // the prompt. Without this, closing the tab during the 800 ms debounce
  // (or any "saving" window) silently loses the most recent edits.
  useEffect(() => {
    if (saveStatus === "saved") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // legacy support
      return "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: 16,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span className="label-uppercase">Project</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            title="Project name — shown in the editor. The folder name on disk is independent (rename the folder in your file explorer)."
            spellCheck={false}
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--text)",
              lineHeight: 1.2,
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 6,
              padding: "1px 4px",
              margin: "-1px -4px",
              width: 160,
            }}
            onFocus={(e) => { e.currentTarget.style.background = "var(--inner)"; e.currentTarget.style.borderColor = "var(--border)"; }}
            onBlur={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; }}
          />
          {boundDirName && (
            <SaveStatusDot status={saveStatus} />
          )}
          <span
            title="Peaky Engine build version"
            style={{
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: 0.3,
              color: "var(--text-dim)",
              background: "var(--inner)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              padding: "1px 5px",
              marginLeft: 4,
            }}
          >
            v{ENGINE_VERSION}
          </span>
        </div>
      </div>

      <div ref={fileMenuRef} style={{ position: "relative", marginLeft: 8 }}>
        <button
          onClick={() => setFileMenuOpen((v) => !v)}
          title={boundDirName ? `Open: "${boundDirName}". Ctrl+S writes the manifest.` : "Project file actions (New / Open / Save / Close)."}
          style={{ fontSize: 11, padding: "4px 12px", background: "var(--inner)", display: "flex", alignItems: "center", gap: 4 }}
        >
          File <span style={{ fontSize: 9, opacity: 0.6 }}>▾</span>
        </button>
        {fileMenuOpen && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: 4,
              minWidth: 240,
              background: "var(--card)",
              border: "1px solid var(--border)",
              padding: "4px 0",
              zIndex: 100,
            }}
          >
            <MenuItem
              label="New Folder Project…"
              shortcut=""
              onClick={() => { setFileMenuOpen(false); void handleNewFolder(); }}
            />
            <MenuItem
              label="Open Folder…"
              shortcut=""
              onClick={() => { setFileMenuOpen(false); void handleOpenFolder(); }}
            />
            {!boundDirName && cachedHandle && (
              <MenuItem
                label={`Reopen  ·  ${cachedHandle.name}`}
                shortcut=""
                onClick={() => { setFileMenuOpen(false); void handleReopen(); }}
              />
            )}
            <MenuSeparator />
            <MenuItem
              label={boundDirName ? `Save  ·  ${boundDirName}` : "Save (no folder open)"}
              shortcut="Ctrl+S"
              disabled={!boundDirName}
              onClick={() => { setFileMenuOpen(false); void handleSave(); }}
            />
            <MenuItem
              label="Save As…  (duplicate to new folder)"
              shortcut=""
              disabled={!boundDirName}
              onClick={() => { setFileMenuOpen(false); void handleSaveAs(); }}
            />
            <MenuSeparator />
            <MenuItem
              label="Export Web Game (ZIP)"
              shortcut=""
              onClick={() => { setFileMenuOpen(false); void handleExportWeb(); }}
            />
            <MenuItem
              label="Download Backup (ZIP)"
              shortcut=""
              disabled={!boundDirName}
              onClick={() => { setFileMenuOpen(false); void handleBackup(); }}
            />
            <MenuSeparator />
            <MenuItem
              label={boundDirName ? "Close Folder" : "Close Folder (none open)"}
              shortcut=""
              disabled={!boundDirName}
              onClick={() => { setFileMenuOpen(false); handleClose(); }}
            />
            <MenuSeparator />
            <MenuItem
              label="Quit"
              shortcut=""
              danger
              onClick={() => { setFileMenuOpen(false); handleQuit(); }}
            />
          </div>
        )}
      </div>

      <button
        onClick={() => setNodeRefOpen(true)}
        title="Documentation — nodes, state machine, components, items, dialogue, UI"
        style={{ fontSize: 11, padding: "4px 12px", marginLeft: 6, background: "var(--inner)", display: "flex", alignItems: "center", gap: 4 }}
      >
        📖 Documentation
      </button>
      {nodeRefOpen && <Documentation onClose={() => setNodeRefOpen(false)} />}

      <div style={{ flex: 1, minWidth: 0, marginLeft: 12, overflow: "hidden" }}>
        <TabBar />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            background: "var(--inner)",
            borderRadius: 9,
          }}
        >
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: isRunning ? "var(--teal)" : "var(--text-faint)",
            }}
          />
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {isRunning
              ? `running · ${liveFps > 0 ? liveFps : "—"} fps`
              : "idle"}
          </span>
        </div>

        {isRunning ? (
          <button onClick={() => setRunning(false)} style={{ background: "var(--inner)", color: "var(--red)" }}>
            ■ Stop
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => {
              if (!getActiveAssetStore()) {
                alert("Open or create a folder project first — Play needs an AssetStore to load sprite / audio / tileset files.");
                return;
              }
              setActiveTab({ kind: "scene" });
              setRunning(true);
            }}
          >
            ▶ Play
          </button>
        )}
      </div>
    </div>
  );
}

/** One row in the File dropdown. Disabled rows are dimmed and ignore clicks. */
function MenuItem({
  label, shortcut, onClick, danger, disabled,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={() => { if (!disabled) onClick(); }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget.style.background = "var(--inner)"); }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "6px 14px",
        fontSize: 12,
        color: disabled ? "var(--text-faint)" : danger ? "var(--red)" : "var(--text)",
        cursor: disabled ? "default" : "pointer",
        userSelect: "none",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span>{label}</span>
      {shortcut && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", letterSpacing: 0.3 }}>{shortcut}</span>
      )}
    </div>
  );
}

function MenuSeparator() {
  return <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />;
}

/** Small colored dot showing the live save state. Hovered, the dot
 *  explains what it means in plain text. Green = on disk; yellow =
 *  pending edits, write scheduled; orange = write in flight. */
function SaveStatusDot({ status }: { status: "saved" | "dirty" | "saving" }) {
  const meta = status === "saved"
    ? { color: "var(--teal)", title: "All changes saved to disk." }
    : status === "saving"
    ? { color: "var(--yellow)", title: "Saving to disk…" }
    : { color: "var(--orange, #e07474)", title: "Unsaved edits — autosaving shortly. Don't close yet." };
  return (
    <span
      title={meta.title}
      style={{
        width: 8, height: 8, borderRadius: "50%",
        background: meta.color, flexShrink: 0, marginLeft: 2,
      }}
    />
  );
}
