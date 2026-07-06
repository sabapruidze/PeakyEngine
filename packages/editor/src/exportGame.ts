/**
 * Game export — produces a self-contained playable build.
 *
 * Strategy: every asset (sprite frames, tileset images, sounds, fonts) is
 * converted to a base64 data URL at export time and put in a map keyed by
 * the asset's normal disk path. The runtime's URL resolver checks this map
 * first, so textures and audio load from inlined data URLs — no HTTP, no
 * CORS, no file:// issues.
 *
 * The map ships as a `window.__peakyAssetMap` global in the exported HTML
 * (NOT inside the ZIP's project.json — that JSON gets parsed in a Phaser
 * scene that doesn't need to carry megabytes of base64). The runtime
 * checks the global at preload time.
 *
 * Loose asset files are STILL written into `assets/` inside the ZIP for
 * authors who want to host the unzipped folder via a real web server
 * (smaller initial download than data URLs, browser caches each asset).
 */
import JSZip from "jszip";
import type { PeakyProject } from "./project";
import {
  getActiveAssetStore,
  spriteFrameDiskPath,
  tilesetImagePath,
  soundDiskPath,
  fontDiskPath,
} from "./AssetStore";
import { frameTextureKey, spriteAtlasPath } from "./runProject";

/** Region of a packed sprite atlas for one frame: which atlas, and the cut
 *  rectangle. Keyed by frameTextureKey in the exported frame map. */
type AtlasRegion = { a: string; x: number; y: number; w: number; h: number };

/** Decode raw image bytes into an HTMLImageElement (for canvas packing). */
function decodeImage(buf: ArrayBuffer, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/** Encode a canvas to PNG bytes. */
function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
      blob.arrayBuffer().then(resolve).catch(reject);
    }, "image/png");
  });
}

const ATLAS_MAX_W = 2048;

/** Pack each sprite's frames into ONE atlas PNG (shelf-packed) so the export
 *  ships 1 image per sprite instead of N loose frame files. Returns the atlas
 *  PNGs (by disk path) and a frame map (frameTextureKey → atlas region) the
 *  runtime uses to slice each atlas back into per-frame textures. */
async function packSpriteAtlases(project: PeakyProject): Promise<{
  atlasFiles: Map<string, ArrayBuffer>;
  frameMap: Record<string, AtlasRegion>;
}> {
  const atlasFiles = new Map<string, ArrayBuffer>();
  const frameMap: Record<string, AtlasRegion> = {};
  for (const sprite of project.sprites ?? []) {
    const loaded: { key: string; img: HTMLImageElement; w: number; h: number }[] = [];
    for (const anim of sprite.animations ?? []) {
      const frames = anim.frames ?? [];
      for (let idx = 0; idx < frames.length; idx++) {
        const frame = frames[idx];
        if (!frame.imageFile) continue;
        const path = spriteFrameDiskPath(sprite, frame.imageFile);
        const buf = await readAssetBuffer(path);
        if (!buf) continue;
        try {
          const img = await decodeImage(buf, mimeFromPath(path));
          loaded.push({ key: frameTextureKey(sprite.id, anim.id, idx), img, w: img.width, h: img.height });
        } catch { /* skip an undecodable frame rather than fail the whole export */ }
      }
    }
    if (loaded.length === 0) continue;
    // Shelf pack: lay frames left-to-right, wrap to a new row past ATLAS_MAX_W.
    let x = 0, y = 0, rowH = 0, usedW = 0;
    const place: { key: string; img: HTMLImageElement; x: number; y: number; w: number; h: number }[] = [];
    for (const f of loaded) {
      if (x > 0 && x + f.w > ATLAS_MAX_W) { x = 0; y += rowH; rowH = 0; }
      place.push({ key: f.key, img: f.img, x, y, w: f.w, h: f.h });
      x += f.w; rowH = Math.max(rowH, f.h); usedW = Math.max(usedW, x);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, usedW);
    canvas.height = Math.max(1, y + rowH);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    const atlasPath = spriteAtlasPath(sprite.id);
    for (const p of place) {
      ctx.drawImage(p.img, p.x, p.y);
      frameMap[p.key] = { a: atlasPath, x: p.x, y: p.y, w: p.w, h: p.h };
    }
    atlasFiles.set(atlasPath, await canvasToPng(canvas));
  }
  return { atlasFiles, frameMap };
}

/** Convert an ArrayBuffer to a base64 string without exhausting the call
 *  stack on large assets — `btoa(String.fromCharCode(...bytes))` blows up
 *  for buffers larger than ~100KB because of argument-count limits. */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Guess a MIME type from a file extension — good enough for the asset
 *  set Peaky supports (PNG/JPG/WEBP for images; MP3/OGG/WAV for audio;
 *  TTF/OTF/WOFF for fonts). */
function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":  return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    case "mp3":  return "audio/mpeg";
    case "ogg":  return "audio/ogg";
    case "wav":  return "audio/wav";
    case "ttf":  return "font/ttf";
    case "otf":  return "font/otf";
    case "woff": return "font/woff";
    case "woff2": return "font/woff2";
    default:     return "application/octet-stream";
  }
}

/** Generates the loader HTML. Embeds project JSON + assetMap inline so
 *  the page boots without any sibling fetch — works on file:// double-
 *  click AND on itch.io / any HTTP host. */
/** Escape every "<" to its JSON-valid unicode escape. The standard technique
 *  for embedding JSON in a <script>: neutralizes BOTH </script> and <!-- without
 *  emitting an invalid JSON escape (the old "<\!--" replacement produced `\!`,
 *  which JSON.parse rejects → exported game failed to boot). Exported for tests. */
export const escapeForScriptTag = (s: string): string => s.replace(/</g, "\\u003c");

function buildIndexHtml(project: PeakyProject, assetMap: Record<string, string>, frameMap: Record<string, AtlasRegion>): string {
  const title = (project.name || "Peaky Game").replace(/[<>&"]/g, "_");
  const inlineProject = escapeForScriptTag(JSON.stringify(project));
  const inlineAssetMap = escapeForScriptTag(JSON.stringify(assetMap));
  const inlineFrameMap = escapeForScriptTag(JSON.stringify(frameMap));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; padding: 0; background: #000; overflow: hidden; height: 100%; }
    #peaky-game { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; }
    #peaky-game canvas { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
    .peaky-loading { color: #888; font-family: system-ui, sans-serif; font-size: 14px; }
    .peaky-error   { color: #f55; font-family: system-ui, sans-serif; font-size: 14px; padding: 16px; text-align: center; max-width: 80%; line-height: 1.5; }
  </style>
</head>
<body>
  <div id="peaky-game"><span class="peaky-loading">Loading…</span></div>
  <script id="peaky-project"     type="application/json">${inlineProject}</script>
  <script id="peaky-asset-map"   type="application/json">${inlineAssetMap}</script>
  <script id="peaky-atlas-frames" type="application/json">${inlineFrameMap}</script>
  <script src="peaky-standalone.js"></script>
  <script>
    (function() {
      var statusEl = document.querySelector("#peaky-game .peaky-loading");
      function showError(msg) {
        if (!statusEl) return;
        statusEl.className = "peaky-error";
        statusEl.textContent = msg;
      }
      try {
        var project   = JSON.parse(document.getElementById("peaky-project").textContent);
        var assetMap  = JSON.parse(document.getElementById("peaky-asset-map").textContent);
        // The runtime's URL resolver checks this global FIRST when a
        // preload tries to fetch an asset path. Data URLs work in all
        // contexts (file://, https, sandboxed iframe).
        window.__peakyAssetMap = assetMap;
        // Sprite-frame atlas map: runtime slices one packed atlas per sprite
        // into per-frame textures. Absent → runtime falls back to loose frames.
        window.__peakySpriteAtlasFrames = JSON.parse(document.getElementById("peaky-atlas-frames").textContent);
        if (!window.PeakyStandalone || typeof window.PeakyStandalone.boot !== "function") {
          showError("peaky-standalone.js wasn't loaded — the runtime bundle is missing from this folder.");
          return;
        }
        if (statusEl) statusEl.remove();
        window.PeakyStandalone.boot({ project: project, parent: "peaky-game", assetsBaseUrl: "assets/" });
      } catch (err) {
        showError("Failed to start: " + (err && err.message ? err.message : err));
      }
    })();
  </script>
</body>
</html>
`;
}

/** Read a file from AssetStore as ArrayBuffer for both ZIP insertion AND
 *  base64 embedding. Returns null when the asset is missing. */
async function readAssetBuffer(path: string): Promise<ArrayBuffer | null> {
  const store = getActiveAssetStore();
  if (!store) return null;
  const file = await store.readFile(path);
  if (!file) return null;
  return await file.arrayBuffer();
}

/** Maximum size of an asset that gets inlined as a base64 data URL in
 *  the HTML. Anything LARGER stays loose-files-only in `assets/` so the
 *  HTML doesn't balloon to tens of megabytes per audio track. The
 *  trade-off: oversized assets won't load when the HTML is opened from
 *  `file://` (browsers block XHR for `file://` URLs), but they DO load
 *  fine when hosted via HTTP (itch.io, any web server). The README
 *  flags any asset that crossed the threshold so the author knows. */
const INLINE_MAX_BYTES = 512 * 1024; // 512KB per asset (audio etc.)
// Images (sprites/tilesets) are CRITICAL for a file:// double-click export —
// if not inlined, the browser blocks the XHR and the tilemap/sprite is blank.
// A tileset atlas routinely exceeds 512KB, so give images a much larger budget.
const IMAGE_INLINE_MAX_BYTES = 8 * 1024 * 1024; // 8MB per image

/** Walk every sprite/tileset/sound/font in the project. Every asset is
 *  written as a LOOSE FILE into the ZIP (under its disk path). Assets
 *  under the inline threshold ALSO get a base64 data URL in the asset
 *  map for file:// compatibility; oversized ones rely on HTTP hosting. */
async function collectAssets(project: PeakyProject, zip: JSZip): Promise<{
  added: number; missed: number; inlined: number; loose: number;
  assetMap: Record<string, string>; oversized: { path: string; sizeKB: number }[];
  frameMap: Record<string, AtlasRegion>;
}> {
  let added = 0;
  let missed = 0;
  let inlined = 0;
  let loose = 0;
  const assetMap: Record<string, string> = {};
  const oversized: { path: string; sizeKB: number }[] = [];
  const addBytes = (path: string, buf: ArrayBuffer) => {
    zip.file(path, buf);
    // Images (sprite atlases, tileset atlases) get the much larger image budget
    // so a >512KB image still inlines and renders on a file:// double-click —
    // otherwise it stays loose-only and is blank. Audio/fonts keep the smaller
    // budget to avoid ballooning the HTML.
    const limit = mimeFromPath(path).startsWith("image/") ? IMAGE_INLINE_MAX_BYTES : INLINE_MAX_BYTES;
    if (buf.byteLength <= limit) {
      assetMap[path] = `data:${mimeFromPath(path)};base64,${bufferToBase64(buf)}`;
      inlined++;
    } else {
      // Oversized — leave path resolution to the runtime's HTTP fallback.
      oversized.push({ path, sizeKB: Math.round(buf.byteLength / 1024) });
      loose++;
    }
    added++;
  };
  const handle = async (path: string) => {
    const buf = await readAssetBuffer(path);
    if (!buf) {
      // eslint-disable-next-line no-console
      console.warn("[export] missing asset:", path);
      missed++;
      return;
    }
    addBytes(path, buf);
  };
  // Sprite frames ship as ONE packed atlas per sprite (frameMap lets the
  // runtime slice it back), instead of N loose frame PNGs.
  const { atlasFiles, frameMap } = await packSpriteAtlases(project);
  for (const [path, buf] of atlasFiles) addBytes(path, buf);
  for (const ts of project.tilesets ?? []) {
    if (!ts.imageFile) continue;
    await handle(tilesetImagePath(ts));
  }
  for (const sound of project.sounds ?? []) {
    if (!sound.file) continue;
    await handle(soundDiskPath(sound));
  }
  for (const font of project.fonts ?? []) {
    if (!font.file) continue;
    await handle(fontDiskPath(font));
  }
  return { added, missed, inlined, loose, assetMap, oversized, frameMap };
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Download a full off-machine BACKUP of the project as a single .zip — every
 *  file currently on disk in the project folder (manifest, blueprints, scenes,
 *  sprite metadata + frame PNGs, sounds, tilesets, fonts…). This is the
 *  EDITABLE project, NOT the game export. Store the zip wherever you like
 *  (cloud / external drive). Restore = unzip into a folder and File → Open
 *  Folder. Returns counts for a status message. */
export async function downloadProjectBackup(projectName: string): Promise<{ files: number; bytes: number }> {
  const store = getActiveAssetStore();
  if (!store) {
    throw new Error("No project folder is open — open a folder (File → Open Folder) before backing up.");
  }
  const zip = new JSZip();
  let files = 0;
  let bytes = 0;
  for await (const path of store.walkFiles("")) {
    // Skip the transient rolling autosave snapshots — they're recovery scratch,
    // not project data, and just bloat the backup.
    if (path === ".autosave" || path.startsWith(".autosave/")) continue;
    const file = await store.readFile(path);
    if (!file) continue;
    const buf = await file.arrayBuffer();
    zip.file(path, buf);
    files++;
    bytes += buf.byteLength;
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const base = (projectName || "peaky-project").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "project";
  downloadBlob(`${base}_backup_${backupTimestamp()}.zip`, blob);
  return { files, bytes };
}

export async function exportWebPhase1(project: PeakyProject): Promise<void> {
  const baseName = (project.name || "peaky-game").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const zip = new JSZip();
  // Collect assets FIRST so the HTML can embed the resulting asset map.
  const { added, missed, inlined, loose, assetMap, oversized, frameMap } = await collectAssets(project, zip);
  zip.file("index.html", buildIndexHtml(project, assetMap, frameMap));
  zip.file("project.json", JSON.stringify(project, null, 2));
  // Pull the runtime bundle from editor's public/ (placed there by
  // `npm run build:standalone` in packages/editor). When absent we still
  // produce a ZIP but the README explains the build step.
  let bundleStatus: "included" | "missing" = "missing";
  try {
    const resp = await fetch("peaky-standalone.js");
    if (resp.ok) {
      const text = await resp.text();
      zip.file("peaky-standalone.js", text);
      bundleStatus = "included";
    }
  } catch { /* handled below */ }
  // Surface a MISSING runtime at click time — a silent success here hands the
  // user a ZIP that can't boot (only the README explains why). Let them cancel.
  if (bundleStatus === "missing") {
    const proceed = window.confirm(
      "The game runtime (peaky-standalone.js) could not be found — the exported game will NOT run.\n\n" +
      "Fix: run `npm run build:standalone` in packages/editor, reload, and export again.\n\n" +
      "Export the broken ZIP anyway?",
    );
    if (!proceed) return;
  }
  zip.file("README.txt", buildReadme(baseName, bundleStatus, added, missed, inlined, loose, oversized));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  downloadBlob(`${baseName}.zip`, blob);
  // eslint-disable-next-line no-console
  console.log(`[export] packed ${added} asset(s) (${inlined} inlined / ${loose} loose-only), ${missed} missing, bundle: ${bundleStatus}`);
}

function buildReadme(
  baseName: string, bundle: "included" | "missing",
  added: number, missed: number,
  inlined: number, loose: number, oversized: { path: string; sizeKB: number }[],
): string {
  const oversizedList = oversized.length > 0
    ? `\nLARGE ASSETS (>${Math.round(INLINE_MAX_BYTES / 1024)}KB — NOT inlined, will load via HTTP only):\n` +
      oversized.map((o) => `  ${o.sizeKB.toLocaleString()} KB  ${o.path}`).join("\n") + "\n"
    : "";
  return `Peaky Game export — ${baseName}

Assets packed: ${added}  (${inlined} inlined into HTML, ${loose} loose-files-only)${missed > 0 ? `\n  ${missed} MISSING — check the editor console for paths` : ""}
${oversizedList}
This ZIP contains:
  - index.html             Loader. Small assets (sprites, tilesets, fonts, short
                           sounds) are inlined as base64 data URLs — works on
                           file:// double-click AND any web host.
  - project.json           Schema-only copy of your project (for inspection).
  - peaky-standalone.js    The Peaky runtime bundle. ${bundle === "included" ? "INCLUDED." : "*** MISSING ***"}
  - assets/                Loose-file copies of every asset. Big audio tracks
                           live here ONLY (above the ${Math.round(INLINE_MAX_BYTES / 1024)}KB inline threshold) —
                           they need HTTP hosting (itch.io etc.) to load.

${bundle === "missing" ? `IMPORTANT — the standalone runtime bundle is missing.
  Build it once with:
    cd packages/editor && npm run build:standalone
  This writes peaky-standalone.js into packages/editor/public/, which the
  editor's Export feature fetches and embeds in the ZIP.

  Then re-export from the editor.
` : `To play:
  - Double-click index.html. The page contains everything needed to run:
    project data, the runtime bundle, and all assets (as data URLs).
  - OR host the unzipped folder over HTTP (e.g., npx serve .) — the same
    index.html will still work and the data URLs are still used.

  Uploading to itch.io: zip just THIS folder's contents (index.html +
  peaky-standalone.js — the assets/ folder is optional since assets are
  inlined). Tick "Play in browser" + set Project Type to HTML.`}
`;
}
