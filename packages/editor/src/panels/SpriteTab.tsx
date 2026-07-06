import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { Splitter } from "./Splitter";
import { NumberField } from "./NumberField";
import { SpriteFrame } from "../project";
import { readAssetAsDataURL, writeAssetFromDataURL, spriteFrameDiskPath, spriteDiskFolder, getActiveAssetStore } from "../AssetStore";
import { FrameThumb, useSpriteFrameURL } from "../components/FrameThumb";

/** Text input that commits its value on blur / Enter instead of on every
 *  keystroke. Critical for the sprite/animation NAME fields: renameSprite
 *  moves the on-disk frame folder, so a per-keystroke call would fire one
 *  async folder-rename PER CHARACTER — overlapping moves that race and drop
 *  freshly-imported frames. Local draft state keeps typing smooth; the
 *  expensive rename runs once when the user is done. */
function CommitInput({
  value, onCommit, style, placeholder,
}: {
  value: string;
  onCommit: (next: string) => void;
  style?: React.CSSProperties;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Re-sync when the upstream value changes from an EXTERNAL source (e.g.
  // sanitization rewrote it, or a different sprite was selected).
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input
      value={draft}
      placeholder={placeholder}
      style={style}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === "Escape") { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

/** Read the frame's on-disk image as a data URL for canvas-based manipulation
 *  (crop / resize / bbox). Returns null if no file or no project open. */
async function readFrameAsDataURL(
  sprite: { path: string; name: string },
  frame: SpriteFrame,
): Promise<string | null> {
  if (!frame.imageFile) return null;
  return await readAssetAsDataURL(spriteFrameDiskPath(sprite, frame.imageFile));
}

/** Write a new image data URL for a frame, picking a stable filename. Returns
 *  the filename (frame.imageFile) to store back on the frame, or null on
 *  failure. Reuses the existing filename if the frame already had one. */
async function writeFrameImage(
  sprite: { path: string; name: string },
  frame: SpriteFrame,
  dataUrl: string,
  overrideName?: string,
): Promise<string | null> {
  const filename = overrideName ?? frame.imageFile ?? `${frame.id}.png`;
  const ok = await writeAssetFromDataURL(spriteFrameDiskPath(sprite, filename), dataUrl);
  return ok ? filename : null;
}

/** Build a fresh-filename allocator for a sprite — picks `frame_N.png` names
 *  that collide with neither the in-memory frames nor any PNG already on disk.
 *  Destructive frame edits (crop / resize) write to a NEW name instead of
 *  overwriting, so the ORIGINAL PNG survives on disk and undo can restore the
 *  pre-edit image (not just its dimensions). Mirrors paste's PNG-copy naming;
 *  orphaned old files are reclaimed by the next-session-open GC. */
async function freshFrameNamer(
  sprite: { id: string; path: string; name: string },
): Promise<(orig?: string) => string> {
  const used = await collectUsedFrameNames(sprite);
  let nextIdx = 0;
  return (orig?: string): string => {
    const m = /\.[^.]+$/.exec(orig ?? ".png");
    const ext = m ? m[0] : ".png";
    while (used.has(`frame_${nextIdx}${ext}`)) nextIdx++;
    const name = `frame_${nextIdx}${ext}`;
    used.add(name);
    nextIdx++;
    return name;
  };
}

/** Collect every frame filename that's "taken" — used for collision avoidance
 *  when picking a new frame_N.png name on import. Includes:
 *
 *   - In-memory: every frame.imageFile across every animation in this sprite
 *   - On-disk:   every .png file actually present in the sprite folder
 *
 *  The disk pass matters because removeSpriteFrame defers the PNG cleanup to
 *  the next-session-open GC (so undo can restore frames). Without including
 *  on-disk files, an import after delete could pick frame_6.png, overwrite
 *  the still-on-disk content, and break undo of the original delete + import. */
/**
 * Paste / duplicate frames into a destination sprite, copying each source
 * PNG to a fresh filename in the dest sprite's folder. Without the copy:
 *   - Ctrl+D in the same sprite leaves two frames pointing at the same PNG;
 *     cropping one corrupts the other.
 *   - Ctrl+V across sprites makes dest reference a file that lives under
 *     the source sprite's folder — blank thumbnail, plus the next-load GC
 *     deletes the source PNG once the source no longer references it.
 *
 * The copy uses store.copyFile + the import naming algorithm
 * (collectUsedFrameNames + pickName) so dest never collides with its own
 * existing frames OR with leftover on-disk PNGs from earlier deletes.
 */
async function pasteFramesWithPngCopy(
  destSprite: { id: string; path: string; name: string },
  animId: string,
  clip: { sourceSpriteId: string | null; frames: Array<Omit<SpriteFrame, "id">> },
  focusIdx: number,
): Promise<string[]> {
  const insertSpriteFrames = useEditor.getState().insertSpriteFrames;
  if (clip.frames.length === 0) return [];

  const store = getActiveAssetStore();
  const sourceSprite = clip.sourceSpriteId
    ? useEditor.getState().project.sprites.find((s) => s.id === clip.sourceSpriteId)
    : undefined;

  // Without a live store or source sprite we can't copy — fall back to
  // inserting metadata only. The frames will reference filenames that
  // don't exist in dest; thumbnails will be blank, but at least the
  // operation doesn't throw. This path is hit in pre-v8 fallback / tests.
  if (!store || !sourceSprite) {
    return insertSpriteFrames(destSprite.id, animId, clip.frames, focusIdx);
  }

  const usedFilenames = await collectUsedFrameNames(destSprite);
  let nextIdx = 0;
  const pickName = (orig: string): string => {
    // Keep the original extension when we can read one.
    const m = /\.[^.]+$/.exec(orig);
    const ext = m ? m[0] : ".png";
    while (usedFilenames.has(`frame_${nextIdx}${ext}`)) nextIdx++;
    const name = `frame_${nextIdx}${ext}`;
    usedFilenames.add(name);
    nextIdx++;
    return name;
  };

  const rewritten: Array<Omit<SpriteFrame, "id">> = [];
  for (const f of clip.frames) {
    if (!f.imageFile) {
      // Empty / color-only frame — no PNG to copy.
      rewritten.push(f);
      continue;
    }
    const newName = pickName(f.imageFile);
    const srcPath = spriteFrameDiskPath(sourceSprite, f.imageFile);
    const dstPath = spriteFrameDiskPath(destSprite, newName);
    try {
      await store.copyFile(srcPath, dstPath);
    } catch (err) {
      console.warn("[paste] frame copy failed", { srcPath, dstPath, err });
    }
    rewritten.push({ ...f, imageFile: newName });
  }
  return insertSpriteFrames(destSprite.id, animId, rewritten, focusIdx);
}

async function collectUsedFrameNames(sprite: { id: string; path: string; name: string }): Promise<Set<string>> {
  const used = new Set<string>();
  // Walk current state via the live store so the caller doesn't need to thread
  // sprite.animations through here. Imports happen rarely enough that the extra
  // hop is fine.
  const liveSprite = useEditor.getState().project.sprites.find((s) => s.id === sprite.id);
  if (liveSprite) {
    for (const anim of liveSprite.animations) {
      for (const f of anim.frames) {
        if (f.imageFile) used.add(f.imageFile);
      }
    }
  }
  const store = getActiveAssetStore();
  if (store) {
    const dir = spriteDiskFolder(sprite);
    try {
      for await (const path of store.walkFiles(dir)) {
        if (!path.toLowerCase().endsWith(".png")) continue;
        const filename = path.slice(dir.length + 1); // strip "<dir>/"
        used.add(filename);
      }
    } catch { /* missing folder = no files = nothing to add */ }
  }
  return used;
}

const LAYOUT_KEY = "peaky.sprite-layout-v2";
const ZOOM_KEY = "peaky.sprite-editor-zoom";
const FRAME_STRIP_H = 132;  // bumped from 80: scrollbar no longer crops thumbnails
const FRAME_THUMB = 96;     // bumped from 56: thumbnails are large enough to read at a glance
const MIN_PANEL = 160;
const MAX_PANEL = 420;

const PIVOT_PRESETS: [string, number, number][] = [
  ["↖", 0, 0],   ["↑", 0.5, 0],   ["↗", 1, 0],
  ["←", 0, 0.5], ["◉", 0.5, 0.5], ["→", 1, 0.5],
  ["↙", 0, 1],   ["↓", 0.5, 1],   ["↘", 1, 1],
];

const PT_COLORS = ["#facc15", "#2dd4bf", "#fb923c", "#f87171", "#c084fc", "#34d399"];

// Module-level frame clipboard. Survives SpriteTab unmount/remount so the user
// can copy frames in one sprite/animation, navigate away, and paste into a
// different sprite or animation later. Cleared by the user only via copying
// new frames. Tracks the SOURCE sprite id so paste/duplicate can copy the
// underlying PNGs from the right folder — without it cross-sprite paste
// would reference a filename that lives under the source sprite's folder
// (blank thumbnail in dest, and the next-load GC would delete the source
// file too once the source no longer referenced it).
let _frameClipboard: { sourceSpriteId: string | null; frames: Array<Omit<SpriteFrame, "id">> } = {
  sourceSpriteId: null,
  frames: [],
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { left: 200, right: 270, animsH: 200 };
    const p = JSON.parse(raw);
    const clamp = (n: number) => Math.max(MIN_PANEL, Math.min(MAX_PANEL, n));
    const clampAnims = (n: number) => Math.max(80, Math.min(800, n));
    return { left: clamp(p.left ?? 200), right: clamp(p.right ?? 270), animsH: clampAnims(p.animsH ?? 200) };
  } catch { return { left: 200, right: 270, animsH: 200 }; }
}

function loadZoom(): number {
  const v = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "");
  return isFinite(v) && v > 0 ? Math.max(0.1, Math.min(20, v)) : 1;
}

export function SpriteTab({ spriteId }: { spriteId: string }) {
  const sprite = useEditor((s) => s.project.sprites.find((sp) => sp.id === spriteId));
  const renameSprite = useEditor((s) => s.renameSprite);
  const setSpriteSize = useEditor((s) => s.setSpriteSize);
  const setSpriteLockAspect = useEditor((s) => s.setSpriteLockAspect);
  const addSpriteAnimation = useEditor((s) => s.addSpriteAnimation);
  const renameSpriteAnimation = useEditor((s) => s.renameSpriteAnimation);
  const removeSpriteAnimation = useEditor((s) => s.removeSpriteAnimation);
  const updateSpriteAnimation = useEditor((s) => s.updateSpriteAnimation);
  const reorderSpriteAnimation = useEditor((s) => s.reorderSpriteAnimation);
  const addSpriteFrame = useEditor((s) => s.addSpriteFrame);
  const removeSpriteFrame = useEditor((s) => s.removeSpriteFrame);
  const removeSpriteFrames = useEditor((s) => s.removeSpriteFrames);
  const insertSpriteFrames = useEditor((s) => s.insertSpriteFrames);
  const updateSpriteFrame = useEditor((s) => s.updateSpriteFrame);
  const applyColliderToAnimFrames = useEditor((s) => s.applyColliderToAnimFrames);
  const applyColliderToAllAnims = useEditor((s) => s.applyColliderToAllAnims);
  const bulkUpdateSpriteFrames = useEditor((s) => s.bulkUpdateSpriteFrames);
  const reorderSpriteFrame = useEditor((s) => s.reorderSpriteFrame);
  const updateSpriteFramePivot = useEditor((s) => s.updateSpriteFramePivot);
  const setFramePivotToAll = useEditor((s) => s.setFramePivotToAll);
  const setFramePivotToAllAnims = useEditor((s) => s.setFramePivotToAllAnims);
  const addSpriteImagePoint = useEditor((s) => s.addSpriteImagePoint);
  const updateSpriteImagePoint = useEditor((s) => s.updateSpriteImagePoint);
  const removeSpriteImagePoint = useEditor((s) => s.removeSpriteImagePoint);
  const setImagePointToAll = useEditor((s) => s.setImagePointToAll);
  const setImagePointToAllAnims = useEditor((s) => s.setImagePointToAllAnims);
  const bulkUpdateSpriteFramesAllAnims = useEditor((s) => s.bulkUpdateSpriteFramesAllAnims);

  const [layout, setLayout] = useState(loadLayout);
  const [selectedAnimId, setSelectedAnimId] = useState<string | null>(null);
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  // Crop options — persisted across sessions. Defaults match the most
  // common request: trim transparent margins on both axes across all frames.
  const [cropOpts, setCropOpts] = useState<{ axisX: boolean; axisY: boolean; allFrames: boolean; allAnims: boolean }>(() => {
    try {
      const raw = localStorage.getItem("peaky.sprite-crop-opts");
      if (raw) {
        const p = JSON.parse(raw);
        return {
          axisX:     p.axisX     !== false,
          axisY:     p.axisY     !== false,
          allFrames: p.allFrames !== false,
          allAnims:  p.allAnims  === true,
        };
      }
    } catch { /* ignore */ }
    return { axisX: true, axisY: true, allFrames: true, allAnims: false };
  });
  useEffect(() => {
    localStorage.setItem("peaky.sprite-crop-opts", JSON.stringify(cropOpts));
  }, [cropOpts]);

  // Manual rectangle crop — draggable / resizable rect overlaid on the
  // canvas, in sprite-pixel coords (multiply by zoom for screen px).
  const [manualCropActive, setManualCropActive] = useState(false);
  const [manualRect, setManualRect] = useState<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 0, h: 0 });
  const cropDrag = useRef<{
    mode: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
    startX: number; startY: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);
  // Currently hovered drop target during a frame drag (for the blue insertion line).
  const [dragOverFrameId, setDragOverFrameId] = useState<string | null>(null);
  // Multi-frame selection — Set of frame ids highlighted in the strip. Always
  // includes selectedFrameId when one is set; range / toggle selections add to it.
  const [multiSelectIds, setMultiSelectIds] = useState<Set<string>>(new Set());
  // Anchor for shift-range selection — last single-clicked frame.
  const selectionAnchorId = useRef<string | null>(null);
  // Clipboard for Ctrl+C / Ctrl+V — module-level so it survives unmounts
  // (e.g. switching to a Scene tab and back, or opening a different sprite).
  // Holds frame data without ids; new ids are minted on paste.
  const frameClipboardRef = useRef<{ sourceSpriteId: string | null; frames: Array<Omit<SpriteFrame, "id">> }>(_frameClipboard);
  // Tracks the previously-active animation id so we can distinguish "user
  // switched animations" (clear multi-select) from "user clicked a different
  // frame in the same animation" (preserve multi-select).
  const lastAnimIdRef = useRef<string | null>(null);
  // Marquee (rectangle drag) selection state — coordinates are in the strip's
  // scrollable content space (so they survive horizontal scroll while dragging).
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [zoom, setZoom] = useState(loadZoom);
  const [useImportedSize, setUseImportedSize] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [renamingPointId, setRenamingPointId] = useState<string | null>(null);
  const [resizeDlg, setResizeDlg] = useState<{
    open: boolean; newW: number; newH: number; mode: "stretch" | "canvas";
    /** When true, edits to width auto-update height (and vice versa) using
     *  the original aspect ratio captured when the dialog opened. */
    keepAspect: boolean;
    /** Snapshot of width/height ratio at dialog-open time. Frozen so the
     *  ratio doesn't drift as the user types. */
    aspect: number;
  }>({ open: false, newW: 64, newH: 64, mode: "stretch", keepAspect: true, aspect: 1 });
  const [containerSize, setContainerSize] = useState({ w: 400, h: 300 });

  // Animation playback
  const [playing, setPlaying] = useState(false);
  const [playFrameIdx, setPlayFrameIdx] = useState(0);
  const playIdxRef = useRef(0);
  playIdxRef.current = playFrameIdx;

  type DragTarget = { kind: "pivot" } | { kind: "point"; id: string };
  const dragRef = useRef<DragTarget | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const spriteRef = useRef(sprite);
  spriteRef.current = sprite;
  // Live frame display dims — mirrors `frameDispW` / `frameDispH` computed in
  // render so `toSpriteCoords` clicks land on the same canvas the user sees.
  // Updated each render below; `sprite.width / .height` are the asset-level
  // fallback only used before the first render with a valid frame.
  const frameDimsRef = useRef<{ w: number; h: number }>({ w: sprite?.width ?? 64, h: sprite?.height ?? 64 });

  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const cutInputRef = useRef<HTMLInputElement>(null);
  const [cutSheet, setCutSheet] = useState<{ dataUrl: string; w: number; h: number } | null>(null);

  useEffect(() => { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)); }, [zoom]);

  // Default to first animation
  useEffect(() => {
    if (!sprite) return;
    if (!sprite.animations.some((a) => a.id === selectedAnimId)) {
      setSelectedAnimId(sprite.animations[0]?.id ?? null);
      setSelectedFrameId(null);
    }
  }, [sprite, selectedAnimId]);

  // Default to first frame when animation changes; stop playback.
  // IMPORTANT: only reset multi-selection on actual animation change — not on
  // every frame click. Otherwise shift-clicking a second frame would wipe the
  // first because each click changes selectedFrameId, re-runs this effect, and
  // would clear multiSelectIds before the new shift-toggled selection sticks.
  useEffect(() => {
    if (!sprite || !selectedAnimId) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;

    const animChanged = lastAnimIdRef.current !== selectedAnimId;
    if (animChanged) {
      setPlaying(false);
      setPlayFrameIdx(0);
      setMultiSelectIds(new Set());
      lastAnimIdRef.current = selectedAnimId;
    }

    // If the focused frame no longer exists in this animation (frame deleted
    // or animation switched), fall back to the first frame.
    if (!anim.frames.some((f) => f.id === selectedFrameId)) {
      const firstId = anim.frames[0]?.id ?? null;
      setSelectedFrameId(firstId);
      if (animChanged) selectionAnchorId.current = firstId;
    } else if (animChanged) {
      selectionAnchorId.current = selectedFrameId;
    }
  }, [selectedAnimId, sprite, selectedFrameId]);

  // Frame strip keyboard shortcuts — Delete/Backspace/Ctrl+C/Ctrl+V/Ctrl+D.
  // Bound on `document` (not window) because some browsers route keys through
  // document first; activeElement is the source of truth for "is the user typing".
  useEffect(() => {
    if (!sprite || !selectedAnimId) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;

    // Pull the currently-targeted frames as full data (for copy/dup operations).
    // Falls back to selectedFrameId when no multi-selection. Returned in
    // strip-order so paste preserves visual order.
    const targetedFramesInOrder = (): SpriteFrame[] => {
      const ids = multiSelectIds.size > 0
        ? multiSelectIds
        : (selectedFrameId ? new Set([selectedFrameId]) : new Set<string>());
      return anim.frames.filter((f) => ids.has(f.id));
    };

    // Strip ids before storing on the clipboard so paste mints fresh ones.
    // Deep-clones the points array to detach from store mutations.
    const stripIds = (frames: SpriteFrame[]): Array<Omit<SpriteFrame, "id">> =>
      frames.map(({ id: _id, points, ...rest }) => {
        void _id;
        return { ...rest, points: points ? points.map((p) => ({ ...p })) : undefined };
      });

    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      const tag = a?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || a?.isContentEditable) return;

      const ctrl = e.ctrlKey || e.metaKey;

      // Left / Right — move the selection between frames within this anim.
      // No modifier so it's just instant nudge. Shift-arrow extends the
      // multi-selection along the strip in the same direction.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (anim.frames.length === 0) return;
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const currentIdx = selectedFrameId
          ? Math.max(0, anim.frames.findIndex((f) => f.id === selectedFrameId))
          : 0;
        const nextIdx = (currentIdx + dir + anim.frames.length) % anim.frames.length;
        const nextFrame = anim.frames[nextIdx];
        if (!nextFrame) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          setMultiSelectIds((prev) => {
            const next = new Set(prev);
            if (selectedFrameId) next.add(selectedFrameId);
            next.add(nextFrame.id);
            return next;
          });
        } else {
          setMultiSelectIds(new Set());
        }
        setSelectedFrameId(nextFrame.id);
        return;
      }

      // Delete / Backspace — remove selected frames
      if (e.key === "Delete" || e.key === "Backspace") {
        if (multiSelectIds.size > 0) {
          e.preventDefault();
          e.stopPropagation();
          removeSpriteFrames(sprite.id, anim.id, Array.from(multiSelectIds));
          setMultiSelectIds(new Set());
          selectionAnchorId.current = null;
        } else if (selectedFrameId && anim.frames.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          removeSpriteFrame(sprite.id, anim.id, selectedFrameId);
        }
        return;
      }

      // Ctrl+C — copy selected frames to clipboard (both local + module-level
      // so the clipboard survives switching sprites or unmounting the tab).
      // Records the source sprite id alongside the frames so paste can copy
      // the underlying PNGs from the right folder.
      if (ctrl && (e.key === "c" || e.key === "C")) {
        const frames = targetedFramesInOrder();
        if (frames.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const stripped = { sourceSpriteId: sprite.id, frames: stripIds(frames) };
        frameClipboardRef.current = stripped;
        _frameClipboard = stripped;
        return;
      }

      // Ctrl+V — paste clipboard frames after current focus (or at end). Read
      // the module-level clipboard too so a fresh tab mount picks it up.
      // Async because we may need to copy PNGs across sprite folders.
      if (ctrl && (e.key === "v" || e.key === "V")) {
        const clip = frameClipboardRef.current.frames.length > 0 ? frameClipboardRef.current : _frameClipboard;
        if (clip.frames.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const focusIdx = selectedFrameId ? anim.frames.findIndex((f) => f.id === selectedFrameId) : -1;
        void pasteFramesWithPngCopy(sprite, anim.id, clip, focusIdx).then((newIds) => {
          setMultiSelectIds(new Set(newIds));
          const lastNew = newIds[newIds.length - 1] ?? null;
          setSelectedFrameId(lastNew);
          selectionAnchorId.current = lastNew;
        });
        return;
      }

      // Ctrl+D — duplicate selected frames in place (after the last selected)
      if (ctrl && (e.key === "d" || e.key === "D")) {
        const frames = targetedFramesInOrder();
        if (frames.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const lastSelectedId = frames[frames.length - 1].id;
        const focusIdx = anim.frames.findIndex((f) => f.id === lastSelectedId);
        // Same path as paste — duplicates also need their own on-disk PNG
        // copies so editing one duplicate doesn't corrupt the source.
        const clip = { sourceSpriteId: sprite.id, frames: stripIds(frames) };
        void pasteFramesWithPngCopy(sprite, anim.id, clip, focusIdx).then((newIds) => {
          setMultiSelectIds(new Set(newIds));
          const lastNew = newIds[newIds.length - 1] ?? null;
          setSelectedFrameId(lastNew);
          selectionAnchorId.current = lastNew;
        });
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    sprite, selectedAnimId, multiSelectIds, selectedFrameId,
    removeSpriteFrame, removeSpriteFrames, insertSpriteFrames,
  ]);

  // RAF playback loop
  useEffect(() => {
    if (!playing || !sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim || anim.frames.length === 0) { setPlaying(false); return; }
    const fps = Math.max(1, anim.fps);
    const msPerFrame = 1000 / fps;
    let rafId = 0;
    let lastSwitch = performance.now();
    const tick = (now: number) => {
      if (now - lastSwitch >= msPerFrame) {
        let next = playIdxRef.current + 1;
        if (next >= anim.frames.length) {
          if (anim.loop) { next = 0; } else { setPlaying(false); return; }
        }
        playIdxRef.current = next;
        setPlayFrameIdx(next);
        lastSwitch = now;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, sprite, selectedAnimId]);

  // ResizeObserver on canvas container
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const toSpriteCoords = useCallback((clientX: number, clientY: number) => {
    const el = canvasAreaRef.current;
    const sp = spriteRef.current;
    if (!el || !sp) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    // Use live frame display dims (mirrors the canvas's `frameDispW/H`) so
    // pivot / image-point drags stay glued to the cursor when a frame's
    // imageW differs from the asset-level sprite.width (post-crop, mixed-
    // size animations, etc.). Falls back to asset size for legacy frames.
    const fw = frameDimsRef.current.w || sp.width;
    const fh = frameDimsRef.current.h || sp.height;
    const originX = el.clientWidth / 2 - (fw * z) / 2;
    const originY = el.clientHeight / 2 - (fh * z) / 2;
    return {
      x: Math.round((clientX - rect.left - originX) / z),
      y: Math.round((clientY - rect.top - originY) / z),
    };
  }, []);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    const dr = dragRef.current;
    const sp = spriteRef.current;
    if (!dr || !sp) return;
    const anim = sp.animations.find((a) => a.id === selectedAnimId);
    const frameId = selectedFrameId;
    if (!anim || !frameId) return;
    const { x, y } = toSpriteCoords(e.clientX, e.clientY);
    // Pivots / image points are stored in frame-pixel coords, so clamp to
    // the visible frame's size (matches the canvas the user is dragging on),
    // not the asset-level sprite size.
    const fw = frameDimsRef.current.w || sp.width;
    const fh = frameDimsRef.current.h || sp.height;
    const cx = Math.max(0, Math.min(fw, x));
    const cy = Math.max(0, Math.min(fh, y));
    if (dr.kind === "pivot") {
      updateSpriteFramePivot(sp.id, anim.id, frameId, cx, cy);
    } else {
      updateSpriteImagePoint(sp.id, anim.id, frameId, dr.id, { x: cx, y: cy });
    }
  }, [selectedAnimId, selectedFrameId, toSpriteCoords, updateSpriteFramePivot, updateSpriteImagePoint]);

  const handleCanvasPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleCanvasWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom((z) => Math.max(0.1, Math.min(20, z * factor)));
  }, []);

  const handleImport = async (files: FileList | null) => {
    // CRITICAL: snapshot the FileList into a real array synchronously. The
    // <input>'s onChange resets e.target.value = "" right after invoking us,
    // which empties the FileList — any await before reading files would leave
    // us iterating an empty list. Spritesheet path was unaffected because it
    // captures files[0] sync; this path's await collectUsedFrameNames() came
    // before the loop and drained the FileList behind our back.
    const fileArr = files ? Array.from(files) : [];
    if (fileArr.length === 0 || !sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;
    let firstW: number | null = null;
    let firstH: number | null = null;
    let lastId: string | null = null;
    const usedFilenames = await collectUsedFrameNames(sprite);
    let nextIdx = 0;
    const pickName = (): string => {
      while (usedFilenames.has(`frame_${nextIdx}.png`)) nextIdx++;
      const name = `frame_${nextIdx}.png`;
      usedFilenames.add(name);
      nextIdx++;
      return name;
    };
    for (const file of fileArr) {
      try {
        const { dataUrl, w, h } = await readImage(file);
        if (firstW === null) { firstW = w; firstH = h; }
        const frameFile = pickName();
        await writeAssetFromDataURL(spriteFrameDiskPath(sprite, frameFile), dataUrl);
        lastId = addSpriteFrame(sprite.id, anim.id, { color: 0xffffff, imageFile: frameFile, imageW: w, imageH: h });
      } catch { console.warn("Sprite import: skipped non-image file", file.name); }
    }
    if (lastId) setSelectedFrameId(lastId);
    if (useImportedSize && firstW !== null && firstH !== null) {
      setSpriteSize(sprite.id, firstW, firstH!);
    }
  };

  const handlePickSheet = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const { dataUrl, w, h } = await readImage(file);
      setCutSheet({ dataUrl, w, h });
    } catch { console.warn("Spritesheet: skipped non-image file", file.name); }
  };

  const handleSliceConfirm = async (
    frames: { dataUrl: string; w: number; h: number }[],
    cellW: number,
    cellH: number,
  ) => {
    if (!sprite) { setCutSheet(null); return; }
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) { setCutSheet(null); return; }
    let lastId: string | null = null;
    const usedFilenames = await collectUsedFrameNames(sprite);
    let nextIdx = 0;
    const pickName = (): string => {
      while (usedFilenames.has(`frame_${nextIdx}.png`)) nextIdx++;
      const name = `frame_${nextIdx}.png`;
      usedFilenames.add(name);
      nextIdx++;
      return name;
    };
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const frameFile = pickName();
      await writeAssetFromDataURL(spriteFrameDiskPath(sprite, frameFile), f.dataUrl);
      lastId = addSpriteFrame(sprite.id, anim.id, { color: 0xffffff, imageFile: frameFile, imageW: f.w, imageH: f.h });
    }
    if (lastId) setSelectedFrameId(lastId);
    if (useImportedSize && cellW > 0 && cellH > 0) setSpriteSize(sprite.id, cellW, cellH);
    setCutSheet(null);
  };

  /** When manual crop activates, seed the rect from the selected frame's
   *  content bbox (so the user starts near the right area) — falls back to
   *  the full sprite canvas. */
  useEffect(() => {
    if (!manualCropActive || !sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    const frame = anim?.frames.find((f) => f.id === selectedFrameId);
    if (frame?.imageFile) {
      void (async () => {
        const dataUrl = await readFrameAsDataURL(sprite, frame);
        if (!dataUrl) { setManualRect({ x: 0, y: 0, w: sprite.width, h: sprite.height }); return; }
        try {
          const bb = await imageBBox(dataUrl);
          const w = Math.max(1, bb.maxX - bb.minX + 1);
          const h = Math.max(1, bb.maxY - bb.minY + 1);
          setManualRect({ x: bb.minX, y: bb.minY, w, h });
        } catch {
          setManualRect({ x: 0, y: 0, w: sprite.width, h: sprite.height });
        }
      })();
    } else {
      setManualRect({ x: 0, y: 0, w: sprite.width, h: sprite.height });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualCropActive]);

  /** Document-level mouse listeners for the manual-crop drag/resize. Active
   *  only while a drag is in flight (cropDrag.current is set). Mouse coords
   *  are converted from screen px to sprite-pixel coords by dividing by the
   *  preview zoom factor. */
  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const d = cropDrag.current;
      if (!d || !sprite) return;
      const dx = (e.clientX - d.startX) / zoom;
      const dy = (e.clientY - d.startY) / zoom;
      let { origX: x, origY: y, origW: w, origH: h } = d;
      if (d.mode === "move") {
        x = d.origX + dx; y = d.origY + dy;
      } else {
        if (d.mode.includes("w")) { x = d.origX + dx; w = d.origW - dx; }
        if (d.mode.includes("e")) { w = d.origW + dx; }
        if (d.mode.includes("n")) { y = d.origY + dy; h = d.origH - dy; }
        if (d.mode.includes("s")) { h = d.origH + dy; }
      }
      // Clamp to sprite bounds with min size 1.
      if (w < 1) w = 1;
      if (h < 1) h = 1;
      x = Math.max(0, Math.min(sprite.width  - 1, x));
      y = Math.max(0, Math.min(sprite.height - 1, y));
      w = Math.max(1, Math.min(sprite.width  - x, w));
      h = Math.max(1, Math.min(sprite.height - y, h));
      setManualRect({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    };
    const onUp = () => { cropDrag.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [zoom, sprite]);

  /** Apply the manual rectangle as the crop region. Honors `axisX` / `axisY`
   *  flags (so user can manually rect-select then crop only on one axis) and
   *  the `allFrames` toggle. */
  const handleManualCrop = async () => {
    if (!sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;
    const targets = cropOpts.allFrames
      ? anim.frames.filter((f) => !!f.imageFile)
      : anim.frames.filter((f) => f.id === selectedFrameId && !!f.imageFile);
    if (targets.length === 0) return;

    try {
      // Collect all patches first, then commit them in one store update so
      // the whole crop is a single undo step (the per-frame loop is async,
      // which would otherwise blow past the 400 ms snapshot-coalesce window
      // and create one undo entry per frame).
      const patches: Array<{ id: string; patch: Partial<SpriteFrame> }> = [];
      // Write crops to FRESH filenames so the original PNGs survive on disk —
      // undo restores imageFile to the old name and the pre-crop image comes
      // back. Overwriting in place destroyed the source, so undo could only
      // revert the dimensions, never the pixels.
      const pickFresh = await freshFrameNamer(sprite);
      for (const f of targets) {
        const fw = f.imageW ?? 0;
        const fh = f.imageH ?? 0;
        const x = cropOpts.axisX ? Math.max(0, Math.min(fw - 1, manualRect.x)) : 0;
        const y = cropOpts.axisY ? Math.max(0, Math.min(fh - 1, manualRect.y)) : 0;
        const w = cropOpts.axisX ? Math.max(1, Math.min(fw - x, manualRect.w)) : fw;
        const h = cropOpts.axisY ? Math.max(1, Math.min(fh - y, manualRect.h)) : fh;
        const src = await readFrameAsDataURL(sprite, f);
        if (!src) continue;
        const out = await cropImage(src, x, y, w, h);
        const filename = await writeFrameImage(sprite, f, out.dataUrl, pickFresh(f.imageFile));
        if (!filename) continue;
        const oldPivX = f.pivotX ?? fw / 2;
        const oldPivY = f.pivotY ?? fh / 2;
        const shiftedPoints = f.points
          ? f.points.map((p) => ({ ...p, x: p.x - x, y: p.y - y }))
          : undefined;
        patches.push({
          id: f.id,
          patch: {
            imageFile: filename, imageW: out.w, imageH: out.h,
            pivotX: oldPivX - x, pivotY: oldPivY - y,
            ...(shiftedPoints ? { points: shiftedPoints } : {}),
          },
        });
      }
      bulkUpdateSpriteFrames(sprite.id, anim.id, patches);
      // Per-animation only: the cropped frames carry their own imageW/imageH
      // and the canvas fits the current frame, so we don't touch the shared
      // asset size (which used to bleed into other animations).
      setManualCropActive(false);
    } catch (e) { console.error("Manual crop failed", e); }
  };

  const handleCropToContent = async () => {
    if (!sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;
    if (!cropOpts.axisX && !cropOpts.axisY) return; // nothing to do

    // Pick target frames per the "Apply to all frames" checkbox.
    const targets = cropOpts.allFrames
      ? anim.frames.filter((f) => !!f.imageFile)
      : anim.frames.filter((f) => f.id === selectedFrameId && !!f.imageFile);
    if (targets.length === 0) return;

    try {
      // Step 1: compute each target frame's content bbox (without cropping).
      const srcUrls = await Promise.all(targets.map((f) => readFrameAsDataURL(sprite, f)));
      const bboxes = await Promise.all(srcUrls.map((u) => u ? imageBBox(u) : Promise.resolve({ minX: 0, minY: 0, maxX: 0, maxY: 0 })));

      // Step 2: when "Apply to all" is on, use the UNION bbox so every
      // frame keeps its content (the old code shrank to frame-1's bbox
      // and chopped content off the others).
      let unionBB = bboxes[0];
      if (cropOpts.allFrames && bboxes.length > 1) {
        unionBB = {
          minX: Math.min(...bboxes.map((b) => b.minX)),
          minY: Math.min(...bboxes.map((b) => b.minY)),
          maxX: Math.max(...bboxes.map((b) => b.maxX)),
          maxY: Math.max(...bboxes.map((b) => b.maxY)),
        };
      }
      // Step 3: collect per-frame patches, then commit them in one store
      // update — keeps the whole crop as a single undo step (otherwise the
      // async loop blows past the 400 ms snapshot-coalesce window and each
      // frame becomes its own undo entry).
      const patches: Array<{ id: string; patch: Partial<SpriteFrame> }> = [];
      // Fresh filenames so the originals survive for undo (see handleManualCrop).
      const pickFresh = await freshFrameNamer(sprite);
      for (let i = 0; i < targets.length; i++) {
        const f = targets[i];
        const bb = cropOpts.allFrames ? unionBB : bboxes[i];
        const fw = f.imageW ?? sprite.width;
        const fh = f.imageH ?? sprite.height;

        const x  = cropOpts.axisX ? Math.max(0, bb.minX) : 0;
        const y  = cropOpts.axisY ? Math.max(0, bb.minY) : 0;
        const w  = cropOpts.axisX ? Math.min(fw - x, bb.maxX - bb.minX + 1) : fw;
        const h  = cropOpts.axisY ? Math.min(fh - y, bb.maxY - bb.minY + 1) : fh;
        if (w <= 0 || h <= 0) continue;

        const src = srcUrls[i];
        if (!src) continue;
        const out = await cropImage(src, x, y, w, h);
        const filename = await writeFrameImage(sprite, f, out.dataUrl, pickFresh(f.imageFile));
        if (!filename) continue;
        // Shift pivot AND every image-point by the crop offset so they
        // all keep pointing at the same content pixel post-crop. Without
        // this, alignment shortcuts compute from the new (smaller) frame
        // but with stale point coords → looks like crop didn't happen.
        const oldPivX = f.pivotX ?? fw / 2;
        const oldPivY = f.pivotY ?? fh / 2;
        const shiftedPoints = f.points
          ? f.points.map((p) => ({ ...p, x: p.x - x, y: p.y - y }))
          : undefined;
        patches.push({
          id: f.id,
          patch: {
            imageFile: filename, imageW: out.w, imageH: out.h,
            pivotX: oldPivX - x, pivotY: oldPivY - y,
            ...(shiftedPoints ? { points: shiftedPoints } : {}),
          },
        });
      }
      bulkUpdateSpriteFrames(sprite.id, anim.id, patches);
      // Per-animation only — cropped frames own their imageW/imageH and the
      // canvas fits the current frame, so the shared asset size is left alone
      // (changing it was what bled the crop into other animations).
    } catch (e) { console.error("Crop failed", e); }
  };

  const handleResize = async () => {
    if (!sprite) return;
    const anim = sprite.animations.find((a) => a.id === selectedAnimId);
    if (!anim) return;
    const { newW, newH, mode } = resizeDlg;
    try {
      // Resize every frame in THIS animation (each carries its own
      // imageW/imageH). We do NOT touch the asset-level sprite.width/height —
      // that's a shared fallback, and changing it is what used to bleed the
      // resize into other animations. Each animation's frames now own their
      // size, so other animations are completely unaffected.
      //
      // Collect all patches first, then commit them in ONE store update so the
      // whole resize is a single undo step. The per-frame loop is async (disk
      // writes), which would otherwise blow past the snapshot-coalesce window
      // and create one fragmented/partial undo entry per frame — the cause of
      // "undo only reverts part of the resize then stops". Mirrors
      // handleManualCrop / handleCropToContent.
      const patches: Array<{ id: string; patch: Partial<SpriteFrame> }> = [];
      // Fresh filenames so the originals survive for undo (see handleManualCrop).
      const pickFresh = await freshFrameNamer(sprite);
      for (const f of anim.frames) {
        if (!f.imageFile) continue;
        const src = await readFrameAsDataURL(sprite, f);
        if (!src) continue;
        const { dataUrl, w, h } = await resizeImage(src, newW, newH, mode);
        const filename = await writeFrameImage(sprite, f, dataUrl, pickFresh(f.imageFile));
        if (!filename) continue;
        patches.push({ id: f.id, patch: { imageFile: filename, imageW: w, imageH: h } });
      }
      bulkUpdateSpriteFrames(sprite.id, anim.id, patches);
      setResizeDlg((d) => ({ ...d, open: false }));
    } catch (e) { console.error("Resize failed", e); }
  };

  /** Flip the targeted frames horizontally and/or vertically. Scope follows the
   *  crop toggles: a single frame, all frames in this animation, or — with
   *  "All animations" on — every frame in every animation. Mirrors each frame's
   *  pivot + image points so they stay on the same content pixel, writes to a
   *  fresh filename (undo-safe), and commits in one atomic step. */
  const handleFlip = async (flipH: boolean, flipV: boolean) => {
    if (!sprite || (!flipH && !flipV)) return;
    // Build (animId, frame) target list per scope.
    const targets: Array<{ animId: string; frame: SpriteFrame }> = [];
    if (cropOpts.allAnims) {
      for (const a of sprite.animations) for (const f of a.frames) if (f.imageFile) targets.push({ animId: a.id, frame: f });
    } else {
      const a = sprite.animations.find((x) => x.id === selectedAnimId);
      if (!a) return;
      const frames = cropOpts.allFrames ? a.frames : a.frames.filter((f) => f.id === selectedFrameId);
      for (const f of frames) if (f.imageFile) targets.push({ animId: a.id, frame: f });
    }
    if (targets.length === 0) return;
    try {
      const pickFresh = await freshFrameNamer(sprite);
      const patches: Array<{ id: string; patch: Partial<SpriteFrame> }> = [];
      for (const { frame: f } of targets) {
        const src = await readFrameAsDataURL(sprite, f);
        if (!src) continue;
        const out = await flipImage(src, flipH, flipV);
        const filename = await writeFrameImage(sprite, f, out.dataUrl, pickFresh(f.imageFile));
        if (!filename) continue;
        const fw = f.imageW ?? out.w;
        const fh = f.imageH ?? out.h;
        const patch: Partial<SpriteFrame> = { imageFile: filename };
        // Mirror pivot + image points so they keep pointing at the same pixel.
        if (flipH && f.pivotX != null) patch.pivotX = fw - f.pivotX;
        if (flipV && f.pivotY != null) patch.pivotY = fh - f.pivotY;
        if (f.points && (flipH || flipV)) {
          patch.points = f.points.map((p) => ({
            ...p,
            x: flipH ? fw - p.x : p.x,
            y: flipV ? fh - p.y : p.y,
          }));
        }
        patches.push({ id: f.id, patch });
      }
      if (patches.length === 0) return;
      if (cropOpts.allAnims) {
        bulkUpdateSpriteFramesAllAnims(sprite.id, patches);
      } else {
        bulkUpdateSpriteFrames(sprite.id, targets[0].animId, patches);
      }
    } catch (e) { console.error("Flip failed", e); }
  };

  const clampPanel = (n: number) => Math.max(MIN_PANEL, Math.min(MAX_PANEL, n));

  const onTabDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragActive(true);
  };
  const onTabDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragActive(false);
  };
  const onTabDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    setDragActive(false);
    handleImport(e.dataTransfer.files);
  };

  if (!sprite) {
    return <div className="card" style={{ padding: 24, color: "var(--text-dim)" }}>Sprite not found.</div>;
  }

  const anim = sprite.animations.find((a) => a.id === selectedAnimId) ?? null;
  // While playing, show the animated frame in the canvas; otherwise show selected frame
  const canvasFrame = playing && anim ? (anim.frames[playFrameIdx] ?? anim.frames[0] ?? null) : (anim?.frames.find((f) => f.id === selectedFrameId) ?? null);
  // Resolve the canvas-displayed frame's on-disk image to a blob URL.
  const canvasFrameURL = useSpriteFrameURL(sprite, canvasFrame ?? undefined);
  const frame = anim?.frames.find((f) => f.id === selectedFrameId) ?? null;
  const framePoints = frame?.points ?? [];

  // Construct-style: canvas size is the CURRENT FRAME's pixel size (falls
  // back to sprite.width/.height for empty frames). Cropping a frame
  // shrinks the canvas; switching frames re-fits to the new frame's size.
  // Other anims / other frames are completely unaffected.
  const frameDispW = canvasFrame?.imageW ?? sprite.width;
  const frameDispH = canvasFrame?.imageH ?? sprite.height;
  // Keep the ref synced for `toSpriteCoords` (pivot / image-point drag).
  frameDimsRef.current = { w: frameDispW, h: frameDispH };

  const pivotX = frame?.pivotX ?? frameDispW / 2;
  const pivotY = frame?.pivotY ?? frameDispH / 2;

  const { w: cW, h: cH } = containerSize;
  const originX = cW / 2 - (frameDispW * zoom) / 2;
  const originY = cH / 2 - (frameDispH * zoom) / 2;

  return (
    <div
      onDragOver={onTabDragOver}
      onDragLeave={onTabDragLeave}
      onDrop={onTabDrop}
      style={{
        display: "grid",
        gridTemplateColumns: `${layout.left}px 12px 1fr 12px ${layout.right}px`,
        height: "100%",
        minHeight: 0,
        position: "relative",
        outline: dragActive ? "2px dashed var(--yellow)" : "none",
        outlineOffset: -4,
        borderRadius: 12,
      }}
    >
      {/* ─── Left: Tools panel — per-frame Collider editor lives here.
       *  Author edits the frame's hitbox config (size, offset, exception
       *  tags) and clicks "Apply to all frames" / "Apply to all anims"
       *  to broadcast. Runtime: SpritePlacements size their body from
       *  the current frame's collider so attack frames can grow the
       *  hitbox, idle frames shrink it. */}
      <div
        className="card-flush"
        style={{ display: "flex", flexDirection: "column", minHeight: 0,
                 padding: "10px 8px", gap: 8, overflow: "auto" }}
      >
        <div className="label-uppercase" style={{ opacity: 0.6 }}>Collider</div>
        {frame && anim ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Toggle
                value={!!frame.collider?.enabled}
                onChange={(v) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                  collider: {
                    enabled: v,
                    width:  frame.collider?.width  ?? (frame.imageW ?? sprite.width),
                    height: frame.collider?.height ?? (frame.imageH ?? sprite.height),
                    offsetX: frame.collider?.offsetX ?? 0,
                    offsetY: frame.collider?.offsetY ?? 0,
                    exceptionTags: frame.collider?.exceptionTags ?? [],
                  },
                })}
              />
              <span style={{ fontSize: 11 }}>Enabled (this frame)</span>
            </div>
            {frame.collider?.enabled && (
              <>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 28 }}>W</span>
                  <NumberField
                    value={frame.collider.width}
                    onChange={(v) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                      collider: { ...frame.collider!, width: v },
                    })}
                    style={{ flex: 1, fontSize: 11, padding: "3px 6px", minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 28 }}>H</span>
                  <NumberField
                    value={frame.collider.height}
                    onChange={(v) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                      collider: { ...frame.collider!, height: v },
                    })}
                    style={{ flex: 1, fontSize: 11, padding: "3px 6px", minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 28 }}>Off X</span>
                  <NumberField
                    value={frame.collider.offsetX}
                    onChange={(v) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                      collider: { ...frame.collider!, offsetX: v },
                    })}
                    style={{ flex: 1, fontSize: 11, padding: "3px 6px", minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 28 }}>Off Y</span>
                  <NumberField
                    value={frame.collider.offsetY}
                    onChange={(v) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                      collider: { ...frame.collider!, offsetY: v },
                    })}
                    style={{ flex: 1, fontSize: 11, padding: "3px 6px", minWidth: 0 }}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Exception Tags</span>
                  <input
                    type="text"
                    value={(frame.collider.exceptionTags ?? []).join(", ")}
                    placeholder="ally, pickup"
                    onChange={(e) => updateSpriteFrame(sprite.id, anim.id, frame.id, {
                      collider: {
                        ...frame.collider!,
                        exceptionTags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                      },
                    })}
                    style={{ fontSize: 11, padding: "3px 6px", width: "100%", boxSizing: "border-box" }}
                  />
                  <span style={{ fontSize: 9, color: "var(--text-muted)", lineHeight: 1.3 }}>
                    Comma-separated. Sprites carrying any of these tags don't collide with this frame.
                  </span>
                  <span style={{ fontSize: 9, color: "var(--yellow)", lineHeight: 1.3, marginTop: 2 }}>
                    ⚠ Per-instance filter (set on the placement in the scene Inspector) overrides this for that specific placement.
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                  <button
                    onClick={() => applyColliderToAnimFrames(sprite.id, anim.id, frame.id)}
                    title="Copy this frame's collider config to every frame in this animation"
                    style={{ fontSize: 10, padding: "4px 6px" }}
                  >Apply to all frames</button>
                  <button
                    onClick={() => applyColliderToAllAnims(sprite.id, anim.id, frame.id)}
                    title="Copy this frame's collider config to every frame in every animation"
                    style={{ fontSize: 10, padding: "4px 6px" }}
                  >Apply to all anims</button>
                </div>
              </>
            )}
          </>
        ) : (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Select a frame.</span>
        )}
      </div>

      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, left: clampPanel(l.left + dx) }))} />

      {/* ─── Center: Canvas editor + Frame strip ─── */}
      <div className="card-flush" style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>

        {/* Canvas area */}
        <div
          ref={canvasAreaRef}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerLeave={handleCanvasPointerUp}
          onWheel={handleCanvasWheel}
          onClick={() => setSelectedPointId(null)}
          style={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            overflow: "hidden",
            background: "#0c0c12",
            cursor: dragRef.current ? "crosshair" : "default",
          }}
        >
          {/* Checkerboard tile behind the sprite */}
          <div
            style={{
              position: "absolute",
              left: originX,
              top: originY,
              width: frameDispW * zoom,
              height: frameDispH * zoom,
              backgroundImage:
                "linear-gradient(45deg,rgba(255,255,255,0.05) 25%,transparent 25%,transparent 75%,rgba(255,255,255,0.05) 75%)," +
                "linear-gradient(45deg,rgba(255,255,255,0.05) 25%,transparent 25%,transparent 75%,rgba(255,255,255,0.05) 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 8px 8px",
              backgroundColor: "rgba(255,255,255,0.02)",
              pointerEvents: "none",
            }}
          />

          {/* Frame image fills the sprite canvas. Cropping in all-frames
              mode shrinks the sprite to match the union bbox so the
              cropped result tightly fills the (now smaller) canvas. */}
          {canvasFrameURL && (
            <img
              src={canvasFrameURL}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: originX,
                top: originY,
                width: frameDispW * zoom,
                height: frameDispH * zoom,
                imageRendering: "pixelated",
                pointerEvents: "none",
                userSelect: "none",
              }}
            />
          )}
          {/* Color placeholder when no image */}
          {canvasFrame && !canvasFrame.imageFile && (
            <div
              style={{
                position: "absolute",
                left: originX,
                top: originY,
                width: frameDispW * zoom,
                height: frameDispH * zoom,
                background: canvasFrame.color < 0 ? "transparent" : `#${canvasFrame.color.toString(16).padStart(6, "0")}`,
                pointerEvents: "none",
              }}
            />
          )}

          {/* Sprite border outline */}
          <div
            style={{
              position: "absolute",
              left: originX,
              top: originY,
              width: frameDispW * zoom,
              height: frameDispH * zoom,
              outline: "1px solid rgba(255,255,255,0.18)",
              pointerEvents: "none",
            }}
          />

          {/* Gizmo SVG: pivot + image points (hidden during playback) */}
          {frame && !playing && (
            <svg
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                overflow: "visible",
                pointerEvents: "none",
              }}
            >
              {/* Image points */}
              {framePoints.map((pt, idx) => {
                const sx = originX + pt.x * zoom;
                const sy = originY + pt.y * zoom;
                const color = PT_COLORS[idx % PT_COLORS.length];
                const isSel = pt.id === selectedPointId;
                return (
                  <g
                    key={pt.id}
                    style={{ pointerEvents: "all", cursor: "crosshair" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedPointId(pt.id);
                      dragRef.current = { kind: "point", id: pt.id };
                      (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
                    }}
                  >
                    <circle cx={sx} cy={sy} r={isSel ? 9 : 6} fill={color} fillOpacity={0.85} stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />
                    <text
                      x={sx + 11} y={sy + 4}
                      fill={color} fontSize={10} fontFamily="monospace"
                      stroke="rgba(0,0,0,0.9)" strokeWidth={3} paintOrder="stroke"
                    >
                      {pt.name}
                    </text>
                  </g>
                );
              })}

              {/* Collider rectangle — dashed orange outline so the author
               *  can visually size the hitbox against the frame's art.
               *  Anchored at the FRAME CENTER + the configured offset, so
               *  positive offsetX shifts right and positive offsetY shifts down. */}
              {frame.collider?.enabled && (() => {
                const c = frame.collider;
                const cx = (frame.imageW ?? sprite.width) / 2 + c.offsetX;
                const cy = (frame.imageH ?? sprite.height) / 2 + c.offsetY;
                const rx = originX + (cx - c.width / 2) * zoom;
                const ry = originY + (cy - c.height / 2) * zoom;
                const rw = c.width * zoom;
                const rh = c.height * zoom;
                return (
                  <g>
                    <rect
                      x={rx} y={ry} width={rw} height={rh}
                      fill="rgba(232, 116, 59, 0.12)"
                      stroke="#ff8a3c"
                      strokeWidth={2.5}
                      strokeDasharray="6 4"
                    />
                    <text
                      x={rx + 3} y={ry - 4}
                      fill="#ff8a3c" fontSize={10} fontFamily="monospace"
                      stroke="rgba(0,0,0,0.9)" strokeWidth={3} paintOrder="stroke"
                    >
                      {c.width}×{c.height}
                    </text>
                  </g>
                );
              })()}

              {/* Pivot crosshair */}
              {(() => {
                const px = originX + pivotX * zoom;
                const py = originY + pivotY * zoom;
                const r = 8;
                return (
                  <g
                    style={{ pointerEvents: "all", cursor: "crosshair" }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      dragRef.current = { kind: "pivot" };
                      (e.currentTarget as SVGGElement).setPointerCapture(e.pointerId);
                    }}
                  >
                    <circle cx={px} cy={py} r={r + 3} fill="rgba(0,0,0,0.45)" />
                    <line x1={px - r} y1={py} x2={px + r} y2={py} stroke="var(--teal)" strokeWidth={1.5} />
                    <line x1={px} y1={py - r} x2={px} y2={py + r} stroke="var(--teal)" strokeWidth={1.5} />
                    <circle cx={px} cy={py} r={r} fill="none" stroke="var(--teal)" strokeWidth={1.5} />
                    <circle cx={px} cy={py} r={2.5} fill="var(--teal)" />
                  </g>
                );
              })()}
            </svg>
          )}

          {/* Manual-crop rectangle overlay — visible only while
              `manualCropActive`. Sprite-pixel coords scaled by zoom. */}
          {manualCropActive && (() => {
            const rx = originX + manualRect.x * zoom;
            const ry = originY + manualRect.y * zoom;
            const rw = manualRect.w * zoom;
            const rh = manualRect.h * zoom;
            const sw = frameDispW * zoom;
            const sh = frameDispH * zoom;
            const HANDLE = 8;
            // Each handle: cx, cy, cursor, drag mode
            const handles: Array<[number, number, string, "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"]> = [
              [rx,         ry,          "nw-resize", "nw"],
              [rx + rw / 2, ry,          "ns-resize", "n"],
              [rx + rw,    ry,          "ne-resize", "ne"],
              [rx + rw,    ry + rh / 2, "ew-resize", "e"],
              [rx + rw,    ry + rh,     "se-resize", "se"],
              [rx + rw / 2, ry + rh,    "ns-resize", "s"],
              [rx,         ry + rh,     "sw-resize", "sw"],
              [rx,         ry + rh / 2, "ew-resize", "w"],
            ];
            return (
              <svg
                style={{
                  position: "absolute",
                  left: originX, top: originY, width: sw, height: sh,
                  overflow: "visible", pointerEvents: "none",
                }}
              >
                {/* Dim outside the rect (4 strips). Stays inside sprite area. */}
                <rect x={0}                  y={0}                  width={Math.max(0, manualRect.x * zoom)} height={Math.max(0, sh)} fill="rgba(0,0,0,0.45)" />
                <rect x={(manualRect.x + manualRect.w) * zoom} y={0} width={Math.max(0, sw - (manualRect.x + manualRect.w) * zoom)} height={Math.max(0, sh)} fill="rgba(0,0,0,0.45)" />
                <rect x={manualRect.x * zoom} y={0} width={Math.max(0, manualRect.w * zoom)} height={Math.max(0, manualRect.y * zoom)} fill="rgba(0,0,0,0.45)" />
                <rect x={manualRect.x * zoom} y={(manualRect.y + manualRect.h) * zoom} width={Math.max(0, manualRect.w * zoom)} height={Math.max(0, sh - (manualRect.y + manualRect.h) * zoom)} fill="rgba(0,0,0,0.45)" />
                {/* Rect body — drag to move */}
                <rect
                  x={manualRect.x * zoom} y={manualRect.y * zoom}
                  width={manualRect.w * zoom} height={manualRect.h * zoom}
                  fill="transparent" stroke="var(--yellow)" strokeWidth={1.5} strokeDasharray="4 3"
                  style={{ cursor: "move", pointerEvents: "all" }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation(); e.preventDefault();
                    cropDrag.current = {
                      mode: "move",
                      startX: e.clientX, startY: e.clientY,
                      origX: manualRect.x, origY: manualRect.y,
                      origW: manualRect.w, origH: manualRect.h,
                    };
                  }}
                />
                {/* Resize handles */}
                {handles.map(([cx, cy, cursor, mode]) => (
                  <rect
                    key={mode}
                    x={cx - originX - HANDLE / 2}
                    y={cy - originY - HANDLE / 2}
                    width={HANDLE} height={HANDLE}
                    fill="var(--yellow)" stroke="rgba(0,0,0,0.6)" strokeWidth={1}
                    style={{ cursor, pointerEvents: "all" }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation(); e.preventDefault();
                      cropDrag.current = {
                        mode,
                        startX: e.clientX, startY: e.clientY,
                        origX: manualRect.x, origY: manualRect.y,
                        origW: manualRect.w, origH: manualRect.h,
                      };
                    }}
                  />
                ))}
              </svg>
            );
          })()}

          {/* Zoom controls */}
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              display: "flex",
              gap: 4,
              pointerEvents: "all",
            }}
          >
            <button
              className="ghost"
              style={{ fontSize: 14, padding: "1px 7px", lineHeight: 1 }}
              onClick={() => setZoom((z) => Math.min(20, z * 1.5))}
              title="Zoom in"
            >
              +
            </button>
            <button
              className="ghost"
              style={{ fontSize: 10, padding: "2px 7px", minWidth: 44, textAlign: "center" }}
              onClick={() => {
                const el = canvasAreaRef.current;
                if (!el) return;
                const fit = Math.min(
                  (el.clientWidth * 0.85) / Math.max(1, frameDispW),
                  (el.clientHeight * 0.85) / Math.max(1, frameDispH),
                );
                setZoom(Math.max(0.1, Math.min(20, fit)));
              }}
              title="Fit to view (reset zoom)"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="ghost"
              style={{ fontSize: 14, padding: "1px 7px", lineHeight: 1 }}
              onClick={() => setZoom((z) => Math.max(0.1, z / 1.5))}
              title="Zoom out"
            >
              −
            </button>
          </div>

          {/* Sprite size label */}
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              fontSize: 10,
              color: "var(--text-faint)",
              pointerEvents: "none",
              fontFamily: "monospace",
            }}
          >
            {sprite.width}×{sprite.height}
          </div>
        </div>

        {/* ─── Frame strip ─── */}
        {anim && (
          <div
            style={{
              height: FRAME_STRIP_H,
              borderTop: "1px solid rgba(255,255,255,0.06)",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "4px 10px 2px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  className={playing ? "danger" : "primary"}
                  style={{ fontSize: 10, padding: "2px 8px" }}
                  disabled={anim.frames.length === 0}
                  onClick={() => {
                    if (playing) {
                      setPlaying(false);
                    } else {
                      setPlayFrameIdx(0);
                      playIdxRef.current = 0;
                      setPlaying(true);
                    }
                  }}
                  title={playing ? "Stop animation preview" : "Play animation preview"}
                >
                  {playing ? "■ Stop" : "▶ Play"}
                </button>
                <span className="label-uppercase" style={{ fontSize: 9 }}>
                  {anim.name}{playing ? ` · ${playFrameIdx}/${anim.frames.length} · ${anim.fps}fps` : " · Frames"}
                </span>
                {multiSelectIds.size > 0 && (
                  <>
                    <span style={{ fontSize: 10, color: "var(--yellow)", fontWeight: 600 }}>
                      {multiSelectIds.size} selected
                    </span>
                    <button
                      className="danger"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      onClick={() => {
                        if (!anim) return;
                        removeSpriteFrames(sprite.id, anim.id, Array.from(multiSelectIds));
                        setMultiSelectIds(new Set());
                        selectionAnchorId.current = null;
                      }}
                      title="Delete all selected frames (or press Delete / Backspace)"
                    >
                      Delete {multiSelectIds.size}
                    </button>
                  </>
                )}
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                <button
                  className="ghost"
                  onClick={() => importInputRef.current?.click()}
                  style={{ fontSize: 10, padding: "1px 6px" }}
                  title="Import image files"
                >
                  ⇪ Import
                </button>
                <button
                  className="ghost"
                  onClick={() => cutInputRef.current?.click()}
                  style={{ fontSize: 10, padding: "1px 6px" }}
                  title="Slice a spritesheet into frames"
                >
                  ✂ Cut Sheet
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    const id = addSpriteFrame(sprite.id, anim.id);
                    setSelectedFrameId(id);
                  }}
                  style={{ fontSize: 10, padding: "1px 6px", color: "var(--yellow)" }}
                >
                  + Frame
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => { handleImport(e.target.files); e.target.value = ""; }}
                />
                <input
                  ref={cutInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => { handlePickSheet(e.target.files); e.target.value = ""; }}
                />
              </div>
            </div>
            <div
              ref={stripRef}
              onMouseDown={(e) => {
                if (!anim) return;
                if ((e.target as HTMLElement).closest("[data-frame-id]")) return; // click on a frame, not the bg
                if (e.button !== 0) return;
                const el = stripRef.current;
                if (!el) return;
                const rect = el.getBoundingClientRect();
                const x = e.clientX - rect.left + el.scrollLeft;
                const y = e.clientY - rect.top;
                if (!e.shiftKey) {
                  // Plain marquee = replace selection. Shift+marquee adds to it.
                  setMultiSelectIds(new Set());
                  setSelectedFrameId(null);
                  selectionAnchorId.current = null;
                }
                setMarquee({ x0: x, y0: y, x1: x, y1: y });
                e.preventDefault();

                const onMove = (ev: MouseEvent) => {
                  const r = el.getBoundingClientRect();
                  setMarquee((m) => (m ? { ...m, x1: ev.clientX - r.left + el.scrollLeft, y1: ev.clientY - r.top } : m));
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  setMarquee((m) => {
                    if (!m || !anim) return null;
                    const lo = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1) };
                    const hi = { x: Math.max(m.x0, m.x1), y: Math.max(m.y0, m.y1) };
                    // Tiny drags (effectively clicks on bg) should clear, not select.
                    const dragged = (hi.x - lo.x) > 3 || (hi.y - lo.y) > 3;
                    if (!dragged) return null;

                    const stripRect = el.getBoundingClientRect();
                    const hits: string[] = [];
                    el.querySelectorAll<HTMLElement>("[data-frame-id]").forEach((fEl) => {
                      const fr = fEl.getBoundingClientRect();
                      const fx0 = fr.left - stripRect.left + el.scrollLeft;
                      const fy0 = fr.top - stripRect.top;
                      const fx1 = fx0 + fr.width;
                      const fy1 = fy0 + fr.height;
                      if (fx1 < lo.x || fx0 > hi.x || fy1 < lo.y || fy0 > hi.y) return;
                      const id = fEl.getAttribute("data-frame-id");
                      if (id) hits.push(id);
                    });
                    if (hits.length > 0) {
                      setMultiSelectIds((prev) => {
                        const next = new Set(prev);
                        for (const id of hits) next.add(id);
                        return next;
                      });
                      setSelectedFrameId(hits[hits.length - 1]);
                      selectionAnchorId.current = hits[0];
                    }
                    return null;
                  });
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              style={{
                flex: 1,
                overflowX: "auto",
                overflowY: "hidden",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "0 10px",
                position: "relative",
                userSelect: "none",
              }}
            >
              {anim.frames.length === 0 && (
                <span style={{ color: "var(--text-muted)", fontSize: 10, whiteSpace: "nowrap" }}>
                  No frames — click &quot;+ Frame&quot; or drag images here
                </span>
              )}
              {anim.frames.map((f, idx) => {
                const inMulti = multiSelectIds.has(f.id);
                const isFocused = f.id === selectedFrameId;
                const highlighted = inMulti || (multiSelectIds.size === 0 && isFocused);
                return (
                <div
                  key={f.id}
                  data-frame-id={f.id}
                  draggable
                  onClick={(e) => {
                    if (!anim) return;
                    // Shift (or Ctrl/Cmd) → toggle this frame in/out of the
                    // selection. The user can click many individual frames
                    // while holding shift to build up a multi-selection.
                    if (e.shiftKey || e.ctrlKey || e.metaKey) {
                      setMultiSelectIds((prev) => {
                        const next = new Set(prev);
                        // If the previous selection was empty, seed it with the
                        // current focus so shift-clicking a second frame leaves
                        // both highlighted (not just the new one).
                        if (next.size === 0 && selectedFrameId) next.add(selectedFrameId);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      });
                      setSelectedFrameId(f.id);
                      selectionAnchorId.current = f.id;
                      return;
                    }
                    // Plain click — single select, drop any multi-selection.
                    setSelectedFrameId(f.id);
                    setMultiSelectIds(new Set([f.id]));
                    selectionAnchorId.current = f.id;
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-peaky-frame-idx", String(idx));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("application/x-peaky-frame-idx")) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverFrameId !== f.id) setDragOverFrameId(f.id);
                  }}
                  onDragLeave={() => {
                    setDragOverFrameId((cur) => (cur === f.id ? null : cur));
                  }}
                  onDragEnd={() => setDragOverFrameId(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverFrameId(null);
                    const fromIdx = Number(e.dataTransfer.getData("application/x-peaky-frame-idx"));
                    if (Number.isFinite(fromIdx) && fromIdx !== idx) {
                      reorderSpriteFrame(sprite.id, anim.id, fromIdx, idx);
                    }
                  }}
                  style={{
                    width: FRAME_THUMB,
                    height: FRAME_THUMB,
                    flexShrink: 0,
                    background: f.imageFile || f.color < 0 ? "rgba(255,255,255,0.04)" : `#${f.color.toString(16).padStart(6, "0")}`,
                    borderRadius: 6,
                    outline: dragOverFrameId === f.id
                      ? "2px dashed var(--accent)"
                      : playing
                        ? (idx === playFrameIdx ? "2px solid var(--teal)" : "1px solid rgba(255,255,255,0.07)")
                        : (highlighted ? "2px solid var(--yellow)" : "1px solid rgba(255,255,255,0.07)"),
                    boxShadow: inMulti && !isFocused ? "inset 0 0 0 1px var(--yellow)" : undefined,
                    cursor: "pointer",
                    position: "relative",
                    overflow: "hidden",
                  }}
                  title={`Frame ${idx}${f.imageW ? ` · ${f.imageW}×${f.imageH}` : ""} (Shift+click range, Ctrl+click toggle, Del to delete)`}
                >
                  {f.imageFile && (
                    <FrameThumb
                      sprite={sprite}
                      frame={f}
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        imageRendering: "pixelated",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  <span
                    style={{
                      position: "absolute",
                      bottom: 1,
                      left: 3,
                      fontSize: 8,
                      color: "#fff",
                      textShadow: "0 0 2px rgba(0,0,0,0.95), 0 0 1px rgba(0,0,0,0.95)",
                      fontWeight: 600,
                      pointerEvents: "none",
                    }}
                  >
                    {idx}
                  </span>
                </div>
                );
              })}
              {marquee && (
                <div
                  style={{
                    position: "absolute",
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                    border: "1px solid var(--yellow)",
                    background: "rgba(245, 207, 71, 0.12)",
                    borderRadius: 2,
                    pointerEvents: "none",
                    zIndex: 5,
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <Splitter onDrag={(dx) => setLayout((l) => ({ ...l, right: clampPanel(l.right - dx) }))} />

      {/* ─── Right: Animations (top) + Sprite properties (below) ───
          Outer column is a strict flex layout (no own overflow) so the
          inner Splitter stays fixed at `animsH` from the top — without
          this, dragging the splitter down would scroll the whole right
          panel and the handle would slide out of reach. The bottom
          section has its own scroll region for the property forms. */}
      <div
        className="card-flush"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          padding: "10px 14px",
          gap: 10,
        }}
      >
        {/* Animations panel — moved from left side to the top of the right
            column so the canvas gets the full center and the author edits
            both the anim list AND sprite/frame properties on one side. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="label-uppercase">Animations</span>
          <button
            className="ghost"
            onClick={() => {
              const id = addSpriteAnimation(sprite.id);
              setSelectedAnimId(id);
              setSelectedFrameId(null);
            }}
            title="New animation"
            style={{ width: 24, height: 24, padding: 0, fontSize: 16, lineHeight: 1, color: "var(--yellow)" }}
          >+</button>
        </div>
        <div style={{ height: layout.animsH, overflowY: "auto", paddingBottom: 6 }}>
          {sprite.animations.map((a, idx) => (
            <AnimationRow
              key={a.id}
              id={a.id}
              name={a.name}
              isSelected={a.id === selectedAnimId}
              isFirst={idx === 0}
              onSelect={() => { setSelectedAnimId(a.id); setSelectedFrameId(null); setMultiSelectIds(new Set()); }}
              onRename={(n) => renameSpriteAnimation(sprite.id, a.id, n)}
              onRemove={() => removeSpriteAnimation(sprite.id, a.id)}
              onReorder={(fromId) => reorderSpriteAnimation(sprite.id, fromId, a.id)}
              canRemove={sprite.animations.length > 1}
            />
          ))}
        </div>
        <Splitter
          axis="y"
          onDrag={(dy) =>
            setLayout((l) => ({ ...l, animsH: Math.max(80, Math.min(2000, l.animsH + dy)) }))
          }
        />

        {/* Bottom region (Sprite / Animation / Pivot / Frame) — owns its
            own vertical scroll so the splitter above always stays at
            `animsH` from the top of the right column. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Sprite */}
        <div className="label-uppercase">Sprite</div>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={labelStyle}>name</span>
          <CommitInput value={sprite.name} onCommit={(n) => renameSprite(sprite.id, n)} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={labelStyle}>W</span>
            <NumberField
              value={sprite.width}
              min={1}
              onChange={(n) => {
                const w = Math.max(1, n);
                setSpriteSize(sprite.id, w, sprite.lockAspect ? Math.max(1, Math.round(w * sprite.height / sprite.width)) : sprite.height);
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={labelStyle}>H</span>
            <NumberField
              value={sprite.height}
              min={1}
              onChange={(n) => {
                const h = Math.max(1, n);
                setSpriteSize(sprite.id, sprite.lockAspect ? Math.max(1, Math.round(h * sprite.width / sprite.height)) : sprite.width, h);
              }}
            />
          </label>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)" }}>
          <Toggle value={sprite.lockAspect} onChange={(v) => setSpriteLockAspect(sprite.id, v)} style={{ width: "auto" }} />
          Lock aspect ratio
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)" }}>
          <Toggle value={useImportedSize} onChange={(v) => setUseImportedSize(v)} style={{ width: "auto" }} />
          Use imported size
        </label>
        <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4 }}>
          The <strong>first</strong> animation in the list plays at runtime if a Blueprint
          doesn't pick one. Drag to reorder, or right-click an animation to move it.
        </div>

        {/* Animation */}
        {anim && (
          <>
            <div className="label-uppercase" style={{ marginTop: 4 }}>Animation</div>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>name</span>
              <CommitInput value={anim.name} onCommit={(n) => renameSpriteAnimation(sprite.id, anim.id, n)} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>FPS</span>
              <NumberField value={anim.fps} min={1} onChange={(n) => updateSpriteAnimation(sprite.id, anim.id, { fps: Math.max(1, n) })} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-2)" }}>
              <Toggle value={anim.loop} onChange={(v) => updateSpriteAnimation(sprite.id, anim.id, { loop: v })} style={{ width: "auto" }} />
              Loop
            </label>
          </>
        )}

        {/* Pivot */}
        {frame && anim && (
          <>
            <div className="label-uppercase" style={{ marginTop: 4 }}>Pivot</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
              {PIVOT_PRESETS.map(([label, xFrac, yFrac]) => (
                <button
                  key={label}
                  className="ghost"
                  style={{ fontSize: 13, padding: "4px 0", textAlign: "center" }}
                  onClick={() => {
                    // Pivot lives in FRAME coords, not sprite-level coords.
                    // After cropping, the frame's imageW/H is what defines
                    // the available space — using sprite.width here would
                    // place the pivot way outside the (smaller) frame.
                    const fW = frame.imageW ?? sprite.width;
                    const fH = frame.imageH ?? sprite.height;
                    updateSpriteFramePivot(
                      sprite.id, anim.id, frame.id,
                      Math.round(xFrac * fW),
                      Math.round(yFrac * fH),
                    );
                  }}
                  title={`Set pivot ${label}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>X (px)</span>
                <NumberField value={Math.round(pivotX)} onChange={(n) => updateSpriteFramePivot(sprite.id, anim.id, frame.id, n, pivotY)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Y (px)</span>
                <NumberField value={Math.round(pivotY)} onChange={(n) => updateSpriteFramePivot(sprite.id, anim.id, frame.id, pivotX, n)} />
              </label>
            </div>
            <button
              className="ghost"
              style={{ fontSize: 10, padding: "2px 8px" }}
              onClick={() => cropOpts.allAnims
                ? setFramePivotToAllAnims(sprite.id, anim.id, frame.id)
                : setFramePivotToAll(sprite.id, anim.id, frame.id)}
              title={cropOpts.allAnims ? "Apply this pivot to every frame in every animation" : "Apply this pivot to every frame in this animation"}
            >
              {cropOpts.allAnims ? "Set pivot to all animations" : "Set pivot to all frames"}
            </button>
          </>
        )}

        {/* Image Points */}
        {frame && anim && (
          <>
            <div
              className="label-uppercase"
              style={{ marginTop: 4, display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
              <span>Image Points</span>
              <button
                className="ghost"
                style={{ width: 20, height: 20, padding: 0, fontSize: 14, color: "var(--yellow)", lineHeight: 1 }}
                onClick={() => {
                  // Place new point at the FRAME's center (not sprite-level)
                  // so cropped frames don't get points spawned off-canvas.
                  const fW = frame.imageW ?? sprite.width;
                  const fH = frame.imageH ?? sprite.height;
                  const id = addSpriteImagePoint(
                    sprite.id, anim.id, frame.id,
                    undefined,
                    Math.round(fW / 2),
                    Math.round(fH / 2),
                  );
                  setSelectedPointId(id);
                }}
                title="Add image point"
              >
                +
              </button>
            </div>
            {framePoints.length === 0 && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>No image points</span>
            )}
            {framePoints.map((pt, idx) => {
              const color = PT_COLORS[idx % PT_COLORS.length];
              const isSel = pt.id === selectedPointId;
              return (
                <div
                  key={pt.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    background: isSel ? "rgba(255,255,255,0.04)" : "transparent",
                    borderRadius: 6,
                    padding: "4px 6px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                    {renamingPointId === pt.id ? (
                      <input
                        autoFocus
                        value={pt.name}
                        onChange={(e) => updateSpriteImagePoint(sprite.id, anim.id, frame.id, pt.id, { name: e.target.value })}
                        onBlur={() => setRenamingPointId(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Escape") setRenamingPointId(null);
                          e.stopPropagation();
                        }}
                        style={{ flex: 1, fontSize: 11 }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        style={{ flex: 1, fontSize: 11, cursor: "pointer", color: isSel ? "var(--text)" : "var(--text-2)" }}
                        onClick={() => setSelectedPointId(pt.id)}
                        onDoubleClick={() => setRenamingPointId(pt.id)}
                        title="Double-click to rename"
                      >
                        {pt.name}
                      </span>
                    )}
                    <button
                      className="ghost"
                      style={{ fontSize: 9, padding: "1px 5px" }}
                      onClick={() => cropOpts.allAnims
                        ? setImagePointToAllAnims(sprite.id, anim.id, frame.id, pt.id)
                        : setImagePointToAll(sprite.id, anim.id, frame.id, pt.id)}
                      title={cropOpts.allAnims ? "Copy to all frames in every animation" : "Copy to all frames in this animation"}
                    >
                      {cropOpts.allAnims ? "↓anims" : "↓all"}
                    </button>
                    <button
                      className="ghost"
                      style={{ width: 18, height: 18, padding: 0, fontSize: 12, color: "var(--text-muted)" }}
                      onClick={() => {
                        removeSpriteImagePoint(sprite.id, anim.id, frame.id, pt.id);
                        if (selectedPointId === pt.id) setSelectedPointId(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  {isSel && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, paddingLeft: 14 }}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={labelStyle}>X</span>
                        <NumberField value={pt.x} onChange={(n) => updateSpriteImagePoint(sprite.id, anim.id, frame.id, pt.id, { x: n })} />
                      </label>
                      <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={labelStyle}>Y</span>
                        <NumberField value={pt.y} onChange={(n) => updateSpriteImagePoint(sprite.id, anim.id, frame.id, pt.id, { y: n })} />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Frame */}
        {frame && anim && (
          <>
            <div className="label-uppercase" style={{ marginTop: 4 }}>Frame</div>
            {frame.imageFile ? (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {frame.imageW}×{frame.imageH} px
              </span>
            ) : (
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>{frame.color < 0 ? "color (empty)" : "color"}</span>
                <input
                  type="color"
                  value={frame.color < 0 ? "#000000" : `#${frame.color.toString(16).padStart(6, "0")}`}
                  onChange={(e) => updateSpriteFrame(sprite.id, anim.id, frame.id, { color: parseInt(e.target.value.slice(1), 16) })}
                />
              </label>
            )}
            {frame.imageFile && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 10, alignItems: "center" }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}
                         title="Trim transparent pixels on the left and right edges">
                    <Toggle
                      value={cropOpts.axisX}
                      onChange={(v) => setCropOpts({ ...cropOpts, axisX: v })}
                    />
                    Crop X
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}
                         title="Trim transparent pixels on the top and bottom edges">
                    <Toggle
                      value={cropOpts.axisY}
                      onChange={(v) => setCropOpts({ ...cropOpts, axisY: v })}
                    />
                    Crop Y
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}
                         title="ON: crop every frame in this animation using the union of their content bounding boxes (no frame loses content). OFF: only the selected frame.">
                    <Toggle
                      value={cropOpts.allFrames}
                      onChange={(v) => setCropOpts({ ...cropOpts, allFrames: v })}
                    />
                    All frames
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 3, cursor: "pointer" }}
                         title="ON: Flip, Set-pivot-to-all, and image-point Copy-to-all apply to every frame in EVERY animation of this sprite, not just this one.">
                    <Toggle
                      value={cropOpts.allAnims}
                      onChange={(v) => setCropOpts({ ...cropOpts, allAnims: v })}
                    />
                    All animations
                  </label>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    className="ghost"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    onClick={handleCropToContent}
                    disabled={!cropOpts.axisX && !cropOpts.axisY}
                    title={
                      !cropOpts.axisX && !cropOpts.axisY
                        ? "Enable Crop X or Crop Y first"
                        : `Auto-crop ${cropOpts.allFrames ? "all frames" : "this frame"} to non-transparent content on ${cropOpts.axisX && cropOpts.axisY ? "both axes" : cropOpts.axisX ? "X axis only" : "Y axis only"}`
                    }
                  >
                    ✂ Auto Crop
                  </button>
                  <button
                    className="ghost"
                    style={{
                      fontSize: 10, padding: "2px 8px",
                      background: manualCropActive ? "var(--yellow)" : undefined,
                      color: manualCropActive ? "var(--frame)" : undefined,
                    }}
                    onClick={() => setManualCropActive((v) => !v)}
                    title={manualCropActive
                      ? "Exit manual crop mode"
                      : "Manual crop — drag a rectangle on the canvas, then click Apply"}
                  >
                    {manualCropActive ? "▭ Cancel" : "▭ Manual"}
                  </button>
                  {manualCropActive && (
                    <button
                      className="primary"
                      style={{ fontSize: 10, padding: "2px 8px" }}
                      onClick={async () => { await handleManualCrop(); }}
                      disabled={!cropOpts.axisX && !cropOpts.axisY}
                      title={`Apply rectangle ${manualRect.x},${manualRect.y} ${manualRect.w}×${manualRect.h} to ${cropOpts.allFrames ? "all frames" : "this frame"}`}
                    >
                      Apply
                    </button>
                  )}
                  <button
                    className="ghost"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    onClick={() => setResizeDlg({
                      open: true,
                      // Seed from THIS animation's current frame size (not the
                      // shared asset size) so each animation shows its own.
                      newW: frameDispW,
                      newH: frameDispH,
                      mode: "stretch",
                      keepAspect: true,
                      aspect: frameDispH > 0 ? frameDispW / frameDispH : 1,
                    })}
                    title="Resize this animation's frames"
                  >
                    ⇔ Resize
                  </button>
                  <button
                    className="ghost"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    onClick={() => { void handleFlip(true, false); }}
                    title={`Flip horizontally — ${cropOpts.allAnims ? "all animations" : cropOpts.allFrames ? "all frames in this animation" : "this frame"} (mirrors pivot + image points)`}
                  >
                    ⇋ Flip H
                  </button>
                  <button
                    className="ghost"
                    style={{ fontSize: 10, padding: "2px 8px" }}
                    onClick={() => { void handleFlip(false, true); }}
                    title={`Flip vertically — ${cropOpts.allAnims ? "all animations" : cropOpts.allFrames ? "all frames in this animation" : "this frame"} (mirrors pivot + image points)`}
                  >
                    ⤡ Flip V
                  </button>
                </div>
                {manualCropActive && (
                  <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>
                    Rect: ({manualRect.x}, {manualRect.y}) {manualRect.w}×{manualRect.h} px ·
                    drag corners/edges to resize, body to move
                  </div>
                )}
              </div>
            )}
            <button
              className="danger"
              style={{ marginTop: 4 }}
              onClick={() => {
                removeSpriteFrame(sprite.id, anim.id, frame.id);
                setSelectedFrameId(null);
              }}
            >
              Delete frame
            </button>
          </>
        )}

        {/* No frame hint */}
        {anim && !frame && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
            Select a frame in the strip below to edit it.
          </span>
        )}
        {!anim && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
            Select an animation on the left.
          </span>
        )}
        </div>
      </div>

      {/* ─── Resize dialog ─── */}
      {cutSheet && (
        <SpritesheetCutterModal
          sheet={cutSheet}
          onCancel={() => setCutSheet(null)}
          onConfirm={handleSliceConfirm}
        />
      )}

      {resizeDlg.open && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            borderRadius: 12,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setResizeDlg((d) => ({ ...d, open: false })); }}
        >
          <div
            className="card"
            style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12, minWidth: 260, background: "var(--card)" }}
          >
            <div className="label-uppercase">Resize Frame</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Width</span>
                <NumberField
                  value={resizeDlg.newW}
                  min={1}
                  onChange={(n) =>
                    setResizeDlg((d) => {
                      const w = Math.max(1, n);
                      const h = d.keepAspect && d.aspect > 0
                        ? Math.max(1, Math.round(w / d.aspect))
                        : d.newH;
                      return { ...d, newW: w, newH: h };
                    })
                  }
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Height</span>
                <NumberField
                  value={resizeDlg.newH}
                  min={1}
                  onChange={(n) =>
                    setResizeDlg((d) => {
                      const h = Math.max(1, n);
                      const w = d.keepAspect && d.aspect > 0
                        ? Math.max(1, Math.round(h * d.aspect))
                        : d.newW;
                      return { ...d, newW: w, newH: h };
                    })
                  }
                />
              </label>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-2)" }}>
              <Toggle
                value={resizeDlg.keepAspect}
                onChange={(v) =>
                  setResizeDlg((d) => ({
                    ...d,
                    keepAspect: v,
                    // Re-snap aspect from the current values when re-locking,
                    // so the user can dial in arbitrary ratios then re-lock.
                    aspect: v && d.newH > 0 ? d.newW / d.newH : d.aspect,
                  }))
                }
              />
              Keep aspect ratio
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={labelStyle}>Mode</span>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-2)" }}>
                <input type="radio" name="resize-mode" checked={resizeDlg.mode === "stretch"} onChange={() => setResizeDlg((d) => ({ ...d, mode: "stretch" }))} />
                Stretch image to new size
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-2)" }}>
                <input type="radio" name="resize-mode" checked={resizeDlg.mode === "canvas"} onChange={() => setResizeDlg((d) => ({ ...d, mode: "canvas" }))} />
                Resize canvas only (keep image)
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="ghost" onClick={() => setResizeDlg((d) => ({ ...d, open: false }))}>Cancel</button>
              <button className="primary" onClick={handleResize}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Read a File as a data URL and probe its native pixel dimensions. */
function readImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ dataUrl, w: img.width, h: img.height });
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

/** Compute the bounding box of non-transparent pixels in a PNG data-URL.
 *  Returns inclusive coords (maxX/maxY are the last pixel with content).
 *  Returns full-image bbox when the image is fully transparent (callers
 *  treat that as "nothing to crop"). */
async function imageBBox(dataUrl: string): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const img = await loadImg(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  let minX = img.width, maxX = -1, minY = img.height, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (data.data[(y * img.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return { minX: 0, minY: 0, maxX: img.width - 1, maxY: img.height - 1 };
  return { minX, minY, maxX, maxY };
}

/** Crop a PNG data-URL to the given pixel rect. Used by the per-axis
 *  crop tool. Coords are validated by the caller. */
async function cropImage(
  dataUrl: string, x: number, y: number, w: number, h: number,
): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImg(dataUrl);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(img, -x, -y);
  return { dataUrl: out.toDataURL("image/png"), w, h };
}

/** Resize a PNG data-URL. Stretch: scale image. Canvas: keep image, resize canvas. */
/** Mirror an image horizontally and/or vertically (nearest-neighbor, so pixel
 *  art stays crisp). Dimensions are unchanged. */
async function flipImage(
  dataUrl: string,
  flipH: boolean,
  flipV: boolean,
): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImg(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(flipH ? img.width : 0, flipV ? img.height : 0);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(img, 0, 0);
  return { dataUrl: canvas.toDataURL("image/png"), w: img.width, h: img.height };
}

async function resizeImage(
  dataUrl: string,
  newW: number,
  newH: number,
  mode: "stretch" | "canvas",
): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImg(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext("2d")!;
  // Nearest-neighbor scaling — keep crisp pixel-art edges instead of the
  // canvas's default bilinear smoothing, which blurs scaled sprites.
  ctx.imageSmoothingEnabled = false;
  if (mode === "stretch") {
    ctx.drawImage(img, 0, 0, newW, newH);
  } else {
    ctx.drawImage(img, Math.round((newW - img.width) / 2), Math.round((newH - img.height) / 2));
  }
  return { dataUrl: canvas.toDataURL("image/png"), w: newW, h: newH };
}

interface CellRect { x: number; y: number; w: number; h: number }

interface SliceParams {
  mode: "size" | "count";
  cellW: number; cellH: number;
  cols: number; rows: number;
  offsetX: number; offsetY: number;
  spacingX: number; spacingY: number;
}

/** Compute the grid of cell rects for a spritesheet, row-major (the standard
 *  frame order). In "size" mode cell W/H are given and the column/row count
 *  is derived to fill the sheet; in "count" mode the counts are given and the
 *  cell size is derived. Cells that spill past the sheet edge are dropped. */
function computeCells(sheetW: number, sheetH: number, p: SliceParams): CellRect[] {
  let cols: number, rows: number, cw: number, ch: number;
  if (p.mode === "count") {
    cols = Math.max(1, Math.floor(p.cols));
    rows = Math.max(1, Math.floor(p.rows));
    cw = Math.floor((sheetW - p.offsetX - (cols - 1) * p.spacingX) / cols);
    ch = Math.floor((sheetH - p.offsetY - (rows - 1) * p.spacingY) / rows);
  } else {
    cw = Math.max(1, Math.floor(p.cellW));
    ch = Math.max(1, Math.floor(p.cellH));
    cols = Math.max(1, Math.floor((sheetW - p.offsetX + p.spacingX) / (cw + p.spacingX)));
    rows = Math.max(1, Math.floor((sheetH - p.offsetY + p.spacingY) / (ch + p.spacingY)));
  }
  if (cw <= 0 || ch <= 0) return [];
  const cells: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = p.offsetX + c * (cw + p.spacingX);
      const y = p.offsetY + r * (ch + p.spacingY);
      if (x + cw > sheetW + 0.5 || y + ch > sheetH + 0.5) continue;
      cells.push({ x, y, w: cw, h: ch });
    }
  }
  return cells;
}

/** Slice each cell rect out of the sheet into its own PNG data-URL. When
 *  `skipEmpty`, fully-transparent cells (common trailing padding on packed
 *  sheets) are dropped. */
async function sliceSheet(
  dataUrl: string, cells: CellRect[], skipEmpty: boolean,
): Promise<{ dataUrl: string; w: number; h: number }[]> {
  const img = await loadImg(dataUrl);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const out: { dataUrl: string; w: number; h: number }[] = [];
  for (const c of cells) {
    canvas.width = c.w;
    canvas.height = c.h;
    ctx.clearRect(0, 0, c.w, c.h);
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    if (skipEmpty) {
      const d = ctx.getImageData(0, 0, c.w, c.h).data;
      let any = false;
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { any = true; break; } }
      if (!any) continue;
    }
    out.push({ dataUrl: canvas.toDataURL("image/png"), w: c.w, h: c.h });
  }
  return out;
}

/** Spritesheet slicer. Shows the sheet with a live grid overlay; on confirm
 *  it slices every cell into a frame data-URL and hands them to the parent,
 *  which appends them to the current animation. */
function SpritesheetCutterModal({ sheet, onCancel, onConfirm }: {
  sheet: { dataUrl: string; w: number; h: number };
  onCancel: () => void;
  onConfirm: (frames: { dataUrl: string; w: number; h: number }[], cellW: number, cellH: number) => void;
}) {
  const [mode, setMode] = useState<"size" | "count">("size");
  const [cellW, setCellW] = useState(Math.min(64, sheet.w));
  const [cellH, setCellH] = useState(Math.min(64, sheet.h));
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(4);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [spacingX, setSpacingX] = useState(0);
  const [spacingY, setSpacingY] = useState(0);
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [busy, setBusy] = useState(false);

  const cells = useMemo(
    () => computeCells(sheet.w, sheet.h, { mode, cellW, cellH, cols, rows, offsetX, offsetY, spacingX, spacingY }),
    [sheet.w, sheet.h, mode, cellW, cellH, cols, rows, offsetX, offsetY, spacingX, spacingY],
  );
  const cw = cells[0]?.w ?? 0;
  const ch = cells[0]?.h ?? 0;

  const scale = Math.min(540 / sheet.w, 340 / sheet.h, 1);
  const dispW = sheet.w * scale;
  const dispH = sheet.h * scale;

  const confirm = async () => {
    if (cells.length === 0 || busy) return;
    setBusy(true);
    try {
      const frames = await sliceSheet(sheet.dataUrl, cells, skipEmpty);
      onConfirm(frames, cw, ch);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 100, borderRadius: 12,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="card" style={{ padding: 18, display: "flex", gap: 18, background: "var(--card)", maxWidth: "92%" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="label-uppercase">Preview</div>
          <div style={{
            position: "relative", width: dispW, height: dispH,
            background: "var(--inner)", outline: "1px solid var(--border)",
            backgroundImage:
              "linear-gradient(45deg,#0003 25%,transparent 25%),linear-gradient(-45deg,#0003 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#0003 75%),linear-gradient(-45deg,transparent 75%,#0003 75%)",
            backgroundSize: "16px 16px",
            backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
          }}>
            <img
              src={sheet.dataUrl}
              width={dispW}
              height={dispH}
              style={{ display: "block", imageRendering: "pixelated" }}
              draggable={false}
            />
            {cells.map((c, i) => (
              <div key={i} style={{
                position: "absolute",
                left: c.x * scale, top: c.y * scale,
                width: c.w * scale, height: c.h * scale,
                border: "1px solid var(--yellow)",
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.4)",
                pointerEvents: "none",
              }} />
            ))}
          </div>
          <span style={{ fontSize: 11, color: "var(--text-2)" }}>
            Sheet {sheet.w}×{sheet.h}px · {cells.length} frame{cells.length === 1 ? "" : "s"}
            {cw > 0 ? ` · ${cw}×${ch}px each` : ""}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 220 }}>
          <div className="label-uppercase">Cut Spritesheet</div>

          <div style={{ display: "flex", gap: 6 }}>
            <button
              className={mode === "size" ? "primary" : "ghost"}
              style={{ flex: 1, fontSize: 11 }}
              onClick={() => setMode("size")}
            >By cell size</button>
            <button
              className={mode === "count" ? "primary" : "ghost"}
              style={{ flex: 1, fontSize: 11 }}
              onClick={() => setMode("count")}
            >By grid count</button>
          </div>

          {mode === "size" ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Cell W</span>
                <NumberField value={cellW} min={1} onChange={(n) => setCellW(Math.max(1, n))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Cell H</span>
                <NumberField value={cellH} min={1} onChange={(n) => setCellH(Math.max(1, n))} />
              </label>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Columns</span>
                <NumberField value={cols} min={1} onChange={(n) => setCols(Math.max(1, n))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={labelStyle}>Rows</span>
                <NumberField value={rows} min={1} onChange={(n) => setRows(Math.max(1, n))} />
              </label>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Offset X</span>
              <NumberField value={offsetX} min={0} onChange={(n) => setOffsetX(Math.max(0, n))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Offset Y</span>
              <NumberField value={offsetY} min={0} onChange={(n) => setOffsetY(Math.max(0, n))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Spacing X</span>
              <NumberField value={spacingX} min={0} onChange={(n) => setSpacingX(Math.max(0, n))} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={labelStyle}>Spacing Y</span>
              <NumberField value={spacingY} min={0} onChange={(n) => setSpacingY(Math.max(0, n))} />
            </label>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-2)" }}>
            <Toggle value={skipEmpty} onChange={(v) => setSkipEmpty(v)} style={{ width: "auto" }} />
            Skip empty cells
          </label>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: "auto" }}>
            <button className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="primary" onClick={confirm} disabled={busy || cells.length === 0}>
              {busy ? "Slicing…" : `Add ${cells.length} frame${cells.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnimationRow({
  id, name, isSelected, isFirst, onSelect, onRename, onRemove, onReorder, canRemove,
}: {
  id: string;
  name: string; isSelected: boolean; isFirst: boolean;
  onSelect: () => void; onRename: (n: string) => void;
  onRemove: () => void;
  /** Called with the dragged source's id when something is dropped onto this row. */
  onReorder: (fromId: string) => void;
  canRemove: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [dragOver, setDragOver] = useState<"top" | "bottom" | null>(null);
  useEffect(() => { setDraft(name); }, [name]);

  const onDragStart = (e: React.DragEvent) => {
    if (editing) { e.preventDefault(); return; }
    e.dataTransfer.setData("application/x-peaky-anim-id", id);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-peaky-anim-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    setDragOver(e.clientY < rect.top + rect.height / 2 ? "top" : "bottom");
  };

  const onDragLeave = () => setDragOver(null);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fromId = e.dataTransfer.getData("application/x-peaky-anim-id");
    setDragOver(null);
    if (!fromId || fromId === id) return;
    onReorder(fromId);
  };

  return (
    <div
      className={`object-row ${isSelected ? "selected" : ""}`}
      onClick={onSelect}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        borderTop: dragOver === "top" ? "2px solid var(--yellow)" : undefined,
        borderBottom: dragOver === "bottom" ? "2px solid var(--yellow)" : undefined,
      }}
      title="Drag to reorder. The first animation plays by default."
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft.trim() || name); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(draft.trim() || name); setEditing(false); }
            if (e.key === "Escape") { setDraft(name); setEditing(false); }
            e.stopPropagation();
          }}
          style={{ flex: 1, fontSize: 12 }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="name"
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
          title="Double-click to rename"
        >
          {name}{isFirst && <span style={{ color: "var(--teal)", marginLeft: 6, fontSize: 10 }} title="First in list — plays by default at runtime">▸ default</span>}
        </span>
      )}
      <button
        className="ghost"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        disabled={!canRemove}
        title={canRemove ? "Remove animation" : "Can't remove the last animation"}
        style={{ width: 22, height: 22, padding: 0, fontSize: 13, color: "var(--text-muted)", opacity: canRemove ? 1 : 0.3 }}
      >
        ×
      </button>
    </div>
  );
}
