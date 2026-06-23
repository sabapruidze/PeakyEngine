/**
 * Persistent cache for the last-opened FileSystemDirectoryHandle, stored in
 * IndexedDB. Folder projects re-prompt for permission on every page reload
 * because browsers don't grant persistent FS access without a user gesture
 * — caching the handle here lets the editor show a one-click "Reopen
 * <Folder>" button instead of forcing the user back through the directory
 * picker every time.
 *
 * Structured clone preserves FileSystemDirectoryHandle across IDB read/
 * write, but the handle still requires `requestPermission()` to be usable
 * (the browser revokes it on page reload). The flow is:
 *
 *   1. After successful Open/New Folder → saveDirHandle(handle)
 *   2. Page reload → readDirHandle() returns the handle (no perm yet)
 *   3. User clicks "Reopen" → ensureReadWritePermission(handle) prompts
 *      for permission via a user gesture
 *   4. Permission granted → mount the AssetStore against the handle
 */

const DB_NAME = "peaky.dirHandle";
const STORE = "handle";
const KEY = "current";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(handle, KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("[dirHandleCache] saveDirHandle failed:", err);
  }
}

export async function readDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle ?? null;
  } catch (err) {
    console.warn("[dirHandleCache] readDirHandle failed:", err);
    return null;
  }
}

export async function clearDirHandle(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("[dirHandleCache] clearDirHandle failed:", err);
  }
}

/**
 * Ask the user to re-grant readwrite permission on the cached handle. Must
 * be called from a user-gesture (button click) — calling it on page-load
 * silently no-ops in Chrome ("Permission denied"). Returns true when the
 * handle is usable after this call.
 */
export async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  type Permissionable = {
    queryPermission: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
    requestPermission: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };
  const h = handle as unknown as Permissionable;
  try {
    const current = await h.queryPermission({ mode: "readwrite" });
    if (current === "granted") return true;
    const after = await h.requestPermission({ mode: "readwrite" });
    return after === "granted";
  } catch (err) {
    console.warn("[dirHandleCache] permission check failed:", err);
    return false;
  }
}
