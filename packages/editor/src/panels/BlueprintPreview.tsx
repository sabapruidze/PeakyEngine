import { useCallback, useEffect, useRef, useState } from "react";
import { BehaviorKind, BlueprintDef, SpriteAsset } from "../project";
import { useEditor } from "../store";
import { useSpriteFrameURL } from "../components/FrameThumb";

// ─── Constants ────────────────────────────────────────────────────────────────

const PREVIEW_H_KEY   = "peaky.bp-preview-h";
const PREVIEW_W_KEY   = "peaky.bp-preview-w";
const PREVIEW_Z_KEY   = "peaky.bp-preview-zoom";
const PREVIEW_PX_KEY  = "peaky.bp-preview-panx";
const PREVIEW_PY_KEY  = "peaky.bp-preview-pany";
const PREVIEW_BG_KEY  = "peaky.bp-preview-bg";
const DEFAULT_BG      = "#11141c";
const MIN_PH          = 80;
const DEFAULT_PH      = 180;
const MIN_PW          = 80;
const MIN_ZOOM        = 0.1;
const MAX_ZOOM        = 20;
const ZOOM_STEP       = 1.12;  // 12 % per scroll tick

// Gizmo visual params
const OFFSET_ARROW = 26;
const OFFSET_TIP   = 6;
const HANDLE_R     = 4.5;
const SCALE_HALF   = 5;

// ─── Drag state ───────────────────────────────────────────────────────────────

type DragState = {
  startX: number;
  startY: number;
} & (
  | { kind: "offset"; axis: "x" | "y" | "xy"; origOffX: number; origOffY: number }
  | { kind: "resize-w"; origW: number }
  | { kind: "resize-h"; origH: number }
  | { kind: "text-offset"; axis: "x" | "y" | "xy"; origOffX: number; origOffY: number }
  | { kind: "emitter-offset"; axis: "x" | "y" | "xy"; origOffX: number; origOffY: number }
  | { kind: "visionmask-center"; axis: "x" | "y" | "xy"; origOffX: number; origOffY: number }
  | { kind: "smarttween-pivot"; axis: "x" | "y" | "xy"; origOffX: number; origOffY: number }
  | { kind: "dismember-move"; idx: number; origX: number; origY: number }
  | { kind: "dismember-resize"; idx: number; corner: "nw" | "ne" | "sw" | "se"; origX: number; origY: number; origW: number; origH: number }
  | { kind: "pan"; origPanX: number; origPanY: number }
);

/**
 * Top-of-left-rail preview.
 *
 * - Visual size matches the scene editor (sprite.w/h when SpriteRenderer attached, else bp.w/h).
 * - Always overlays the Collider shape when one is attached.
 * - 5-handle gizmo: offset XY / X / Y, resize W / H (or R for circle).
 * - Scroll to zoom in/out. Double-click to reset zoom.
 * - Drag the bottom handle to resize the preview height (no upper limit).
 */
export function BlueprintPreview({
  bp,
  sprites,
  selectedIdx,
}: {
  bp: BlueprintDef;
  sprites: SpriteAsset[];
  /** Currently-selected component index in the BP's behaviors list. Drives
      which gizmo (if any) is shown. `null` = nothing selected → no gizmos. */
  selectedIdx?: number | null;
}) {
  const updateBlueprintBehavior = useEditor((s) => s.updateBlueprintBehavior);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const animatorPreview = useEditor((s) => s.animatorPreview);

  // ─── Persistent height + width ───────────────────────────────────────────
  const [previewH, setPreviewH] = useState<number>(() => {
    try {
      const v = localStorage.getItem(PREVIEW_H_KEY);
      return v ? Math.max(MIN_PH, parseInt(v, 10)) : DEFAULT_PH;
    } catch { return DEFAULT_PH; }
  });
  useEffect(() => {
    localStorage.setItem(PREVIEW_H_KEY, String(previewH));
  }, [previewH]);

  // null → fill parent width; number → explicit px width
  const [previewW, setPreviewW] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(PREVIEW_W_KEY);
      return v ? Math.max(MIN_PW, parseInt(v, 10)) : null;
    } catch { return null; }
  });
  useEffect(() => {
    if (previewW !== null) localStorage.setItem(PREVIEW_W_KEY, String(previewW));
    else localStorage.removeItem(PREVIEW_W_KEY);
  }, [previewW]);

  // ─── Zoom ─────────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const v = localStorage.getItem(PREVIEW_Z_KEY);
      return v ? Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, parseFloat(v))) : 1;
    } catch { return 1; }
  });
  useEffect(() => {
    localStorage.setItem(PREVIEW_Z_KEY, String(zoom));
  }, [zoom]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor)));
  };

  // ─── Pan ──────────────────────────────────────────────────────────────────
  const [panX, setPanX] = useState<number>(() => {
    try { return Number(localStorage.getItem(PREVIEW_PX_KEY) ?? 0) || 0; } catch { return 0; }
  });
  const [panY, setPanY] = useState<number>(() => {
    try { return Number(localStorage.getItem(PREVIEW_PY_KEY) ?? 0) || 0; } catch { return 0; }
  });
  useEffect(() => { localStorage.setItem(PREVIEW_PX_KEY, String(panX)); }, [panX]);
  useEffect(() => { localStorage.setItem(PREVIEW_PY_KEY, String(panY)); }, [panY]);

  // ─── Background color (author-picked, persistent) ────────────────────────
  const [bgColor, setBgColor] = useState<string>(() => {
    try { return localStorage.getItem(PREVIEW_BG_KEY) || DEFAULT_BG; } catch { return DEFAULT_BG; }
  });
  useEffect(() => { try { localStorage.setItem(PREVIEW_BG_KEY, bgColor); } catch { /* private mode */ } }, [bgColor]);

  const resetView = () => { setZoom(1); setPanX(0); setPanY(0); };

  // ─── Container width measurement ─────────────────────────────────────────
  const [containerW, setContainerW] = useState(220);
  const outerRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setContainerW(el.offsetWidth);
  }, []);

  // ─── Always-fresh refs for stable event listeners ─────────────────────────
  const effectiveScaleRef = useRef(1);
  const colliderIdxRef    = useRef(-1);
  const colliderCfgRef    = useRef<Record<string, unknown>>({});
  const textIdxRef        = useRef(-1);
  const emitterIdxRef     = useRef(-1);
  const emitterCfgRef     = useRef<Record<string, unknown>>({});
  const visionMaskIdxRef  = useRef(-1);
  const visionMaskCfgRef  = useRef<Record<string, unknown>>({});
  const dismemberIdxRef   = useRef(-1);
  const dismemberCfgRef   = useRef<Record<string, unknown>>({});
  const dismemberFrameRef = useRef({ w: 0, h: 0 });
  const smartTweenIdxRef  = useRef(-1);
  const smartTweenCfgRef  = useRef<Record<string, unknown>>({});
  const textCfgRef        = useRef<Record<string, unknown>>({});
  const dragRef           = useRef<DragState | null>(null);

  // ─── Sprite resolution ────────────────────────────────────────────────────
  // The TiledBackground component implies "render this BP as a tile of the
  // chosen sprite asset." For editor preview purposes it behaves the same as
  // a SpriteRenderer — show the first frame. Authors picking TiledBackground
  // instead of SpriteRenderer should still SEE the chosen sprite in the BP
  // / scene preview, not an empty rect. SpriteRenderer wins if both attached.
  const renderer    = bp.behaviors.find((b) => b.kind === "SpriteRenderer")
                   ?? bp.behaviors.find((b) => b.kind === "TiledBackground");
  const colliderIdx = bp.behaviors.findIndex((b) => b.kind === "Collider");
  const collider    = colliderIdx >= 0 ? bp.behaviors[colliderIdx] : undefined;
  const textIdx     = bp.behaviors.findIndex((b) => b.kind === "Text");
  const textBh      = textIdx >= 0 ? bp.behaviors[textIdx] : undefined;
  const tCfg        = textBh?.config ?? {};
  const tOffX       = Number(tCfg.offsetX ?? 0);
  // Particle emitter spawn offset — when the user selects a
  // ParticleEmitter chip, the BP preview shows a draggable point at
  // its (offsetX, offsetY) relative to the host's pivot, so authors
  // can place the spawn point visually (e.g., a muzzle flash 12px
  // forward and 4px up from the sprite center).
  const emitterIdx  = (typeof selectedIdx === "number" && bp.behaviors[selectedIdx]?.kind === "ParticleEmitter")
    ? selectedIdx
    : bp.behaviors.findIndex((b) => b.kind === "ParticleEmitter");
  const emitterBh   = emitterIdx >= 0 ? bp.behaviors[emitterIdx] : undefined;
  const eCfg        = emitterBh?.config ?? {};
  const eOffX       = Number(eCfg.offsetX ?? 0);
  const eOffY       = Number(eCfg.offsetY ?? 0);
  const tOffY       = Number(tCfg.offsetY ?? 0);
  // VisionMask center — when the user selects a VisionMask chip, the preview
  // shows a draggable point at its (centerOffsetX, centerOffsetY) from the
  // host origin, plus a ring at `radius`, so the reveal center is placed
  // visually. Only the SELECTED VisionMask gets a gizmo.
  const visionMaskIdx = (typeof selectedIdx === "number" && bp.behaviors[selectedIdx]?.kind === "VisionMask")
    ? selectedIdx
    : -1;
  const visionMaskBh  = visionMaskIdx >= 0 ? bp.behaviors[visionMaskIdx] : undefined;
  const vmCfg         = visionMaskBh?.config ?? {};
  // AIBrain attack-range ring — shown when the AIBrain chip is selected so the
  // author can tune `attackRange` visually (mirrors the VisionMask radius ring).
  const aiBrainIdx = (typeof selectedIdx === "number" && bp.behaviors[selectedIdx]?.kind === "AIBrain")
    ? selectedIdx : -1;
  const aiBrainBh  = aiBrainIdx >= 0 ? bp.behaviors[aiBrainIdx] : undefined;
  const vmOffX        = Number(vmCfg.centerOffsetX ?? 0);
  const vmOffY        = Number(vmCfg.centerOffsetY ?? 0);
  const vmRadius      = Number(vmCfg.radius ?? 80);

  // Dismemberment regions — interactive overlay. When a Dismemberment chip is
  // selected, draw each region as a draggable/resizable rectangle over the
  // sprite, AND show the SAME reference pose (refAnimation/refFrame) the runtime
  // slices, so what's drawn is what gets cut.
  const dismemberIdx  = (typeof selectedIdx === "number" && bp.behaviors[selectedIdx]?.kind === "Dismemberment")
    ? selectedIdx
    : -1;
  const dismemberBh   = dismemberIdx >= 0 ? bp.behaviors[dismemberIdx] : undefined;
  const dismemberRegions = Array.isArray(dismemberBh?.config.regions)
    ? (dismemberBh!.config.regions as Array<{ name?: string; x?: number; y?: number; w?: number; h?: number }>)
    : [];
  const dismemberRefAnim  = dismemberBh ? String(dismemberBh.config.refAnimation ?? "") : "";
  const dismemberRefFrame = dismemberBh ? Math.max(0, Math.floor(Number(dismemberBh.config.refFrame ?? 0))) : 0;

  // SmartTween scale-pivot — when a SmartTween chip is selected, show a
  // draggable point at its (scalePivotX, scalePivotY) offset from the frame
  // pivot. Scale keyframes pivot around this point at runtime.
  const smartTweenIdx = (typeof selectedIdx === "number" && bp.behaviors[selectedIdx]?.kind === "SmartTween")
    ? selectedIdx
    : -1;
  const smartTweenBh  = smartTweenIdx >= 0 ? bp.behaviors[smartTweenIdx] : undefined;
  const stPivotX      = Number(smartTweenBh?.config.scalePivotX ?? 0);
  const stPivotY      = Number(smartTweenBh?.config.scalePivotY ?? 0);

  const sprite     = renderer ? sprites.find((s) => s.id === String(renderer.config.spriteId ?? "")) : undefined;
  const animName   = renderer ? (String(renderer.config.currentAnimation ?? "") || sprite?.animations[0]?.name || "") : "";
  // When editing a Dismemberment, the displayed pose follows its refAnimation/
  // refFrame so the regions overlay the exact frame that will be sliced.
  const effAnimName = (dismemberBh && dismemberRefAnim) ? dismemberRefAnim : animName;
  const anim       = sprite?.animations.find((a) => a.name === effAnimName) ?? sprite?.animations[0];
  // The SpriteRenderer's `frame` field poses the preview on that frame (Dismember
  // editing still follows its own ref frame). -1 = frame 0.
  const compFrame  = renderer ? Number(renderer.config.frame ?? -1) : -1;
  const frameIdx   = dismemberBh
    ? Math.min(dismemberRefFrame, Math.max(0, (anim?.frames.length ?? 1) - 1))
    : (compFrame >= 0 ? Math.min(compFrame, Math.max(0, (anim?.frames.length ?? 1) - 1)) : 0);
  const firstFrame = anim?.frames[frameIdx];
  // Resolve the displayed frame's on-disk image to a blob URL. Returns
  // undefined while the file loads or when no folder project is open.
  const firstFrameURL = useSpriteFrameURL(sprite, firstFrame);

  // VisionMask shape preview — resolve the chosen mask sprite's frame so the
  // author sees the actual reveal SHAPE (not just a ring) under the gizmo.
  const maskSprite    = visionMaskBh ? sprites.find((s) => s.id === String(vmCfg.maskSpriteId ?? "")) : undefined;
  const maskAnim      = maskSprite?.animations.find((a) => a.name === String(vmCfg.maskAnimation ?? "")) ?? maskSprite?.animations[0];
  const maskFrameIdx  = String(vmCfg.maskSpriteMode ?? "static") === "static"
    ? Math.max(0, Math.floor(Number(vmCfg.maskFrame ?? 0)))
    : 0;
  const maskFrameObj  = maskAnim?.frames[Math.min(maskFrameIdx, Math.max(0, (maskAnim?.frames.length ?? 1) - 1))] ?? maskAnim?.frames[0];
  const maskFrameURL  = useSpriteFrameURL(maskSprite, maskFrameObj);

  // Visual reference size — use the FRAME's own pixel dimensions so the
  // BP preview matches the viewport / runtime (which both use per-frame
  // size). After cropping, the frame is smaller and the preview shrinks
  // accordingly; collider proportions stay consistent across all views.
  const visW = firstFrame?.imageW ?? (sprite ? sprite.width  : bp.w);
  const visH = firstFrame?.imageH ?? (sprite ? sprite.height : bp.h);

  // Pivot in image-pixel coords (defaults to image center for legacy
  // frames without one set — same fallback as the runtime renderer).
  // The pivot pixel is what anchors at the BP's world origin (the
  // actor's `(actorPx, actorPy)` here). Frames are rendered so this
  // pixel lands at that screen point, instead of being centered.
  const pivotX = firstFrame?.pivotX ?? visW / 2;
  const pivotY = firstFrame?.pivotY ?? visH / 2;

  // ─── Collider world dimensions ────────────────────────────────────────────
  const cCfg  = collider?.config ?? {};
  const cW    = Number(cCfg.width  ?? 32);
  const cH    = Number(cCfg.height ?? 48);
  const cOffX = Number(cCfg.offsetX ?? 0);
  const cOffY = Number(cCfg.offsetY ?? 0);

  // ─── Projectile hitbox (damage / tile-mining footprint) ───────────────────
  // Shown when the Projectile component is selected. hitboxW/H of 0 falls back
  // to the body size (the Collider when present, else the BP's own W/H) — the
  // same rule the runtime uses.
  const projectileIdx = bp.behaviors.findIndex((b) => b.kind === "Projectile");
  const projectile    = projectileIdx >= 0 ? bp.behaviors[projectileIdx] : undefined;
  const pjCfg         = projectile?.config ?? {};
  const pjHbW         = Number(pjCfg.hitboxW ?? 0) > 0 ? Number(pjCfg.hitboxW) : (collider ? cW : bp.w);
  const pjHbH         = Number(pjCfg.hitboxH ?? 0) > 0 ? Number(pjCfg.hitboxH) : (collider ? cH : bp.h);
  const pjHbOffX      = Number(pjCfg.hitboxOffsetX ?? 0);
  const pjHbOffY      = Number(pjCfg.hitboxOffsetY ?? 0);

  // ─── "Fit" scale: make bounding box fill ~80 % of preview at zoom=1 ───────
  // Sprite extent in world space spans from `-pivotX` (left edge) to
  // `visW - pivotX` (right edge), since the pivot pixel lives at the
  // origin. Same for Y. Collider extent is body-centered at its offset.
  const spriteLeft   = -pivotX;
  const spriteRight  = visW - pivotX;
  const spriteTop    = -pivotY;
  const spriteBottom = visH - pivotY;
  const leftBound   = collider ? Math.min(spriteLeft,   cOffX - cW / 2) : spriteLeft;
  const rightBound  = collider ? Math.max(spriteRight,  cOffX + cW / 2) : spriteRight;
  const topBound    = collider ? Math.min(spriteTop,    cOffY - cH / 2) : spriteTop;
  const bottomBound = collider ? Math.max(spriteBottom, cOffY + cH / 2) : spriteBottom;

  const fitScale = Math.max(0.05, Math.min(
    (containerW * 0.80) / (rightBound - leftBound),
    (previewH   * 0.80) / (bottomBound - topBound),
  ));

  // User zoom multiplied on top
  const sc = fitScale * zoom;

  // Bounding-box center in world space → maps to preview center
  const bboxCx = (leftBound + rightBound)  / 2;
  const bboxCy = (topBound  + bottomBound) / 2;

  // Actor center in preview pixels — pan offsets the whole world.
  const actorPx = containerW / 2 - bboxCx * sc + panX;
  const actorPy = previewH   / 2 - bboxCy * sc + panY;

  // Actor display rect
  const actorW   = Math.round(visW * sc);
  const actorHpx = Math.round(visH * sc);

  // Collider display
  const cDispW = Math.max(4, Math.round(cW * sc));
  const cDispH = Math.max(4, Math.round(cH * sc));
  const cx     = Math.round(actorPx + cOffX * sc);
  const cy     = Math.round(actorPy + cOffY * sc);

  // Keep fresh refs
  effectiveScaleRef.current = sc;
  colliderIdxRef.current    = colliderIdx;
  colliderCfgRef.current    = collider?.config ?? {};
  textIdxRef.current        = textIdx;
  emitterIdxRef.current     = emitterIdx;
  emitterCfgRef.current     = emitterBh?.config ?? {};
  visionMaskIdxRef.current  = visionMaskIdx;
  visionMaskCfgRef.current  = visionMaskBh?.config ?? {};
  dismemberIdxRef.current   = dismemberIdx;
  dismemberCfgRef.current   = dismemberBh?.config ?? {};
  dismemberFrameRef.current = { w: visW, h: visH };
  smartTweenIdxRef.current  = smartTweenIdx;
  smartTweenCfgRef.current  = smartTweenBh?.config ?? {};
  textCfgRef.current        = textBh?.config ?? {};

  // ─── Gizmo drag ───────────────────────────────────────────────────────────
  const startGizmoDrag = (state: DragState, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = state;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const s  = effectiveScaleRef.current;
      const dx = (e.clientX - d.startX) / s;
      const dy = (e.clientY - d.startY) / s;

      // Pan — independent of any behavior; uses raw screen pixels (no /s).
      if (d.kind === "pan") {
        const rawDx = e.clientX - d.startX;
        const rawDy = e.clientY - d.startY;
        setPanX(d.origPanX + rawDx);
        setPanY(d.origPanY + rawDy);
        return;
      }

      // Text offset — drives the Text behavior's offsetX/offsetY.
      if (d.kind === "text-offset") {
        if (textIdxRef.current < 0) return;
        const cfg: Record<string, unknown> = { ...textCfgRef.current };
        if (d.axis === "x" || d.axis === "xy") cfg.offsetX = Math.round(d.origOffX + dx);
        if (d.axis === "y" || d.axis === "xy") cfg.offsetY = Math.round(d.origOffY + dy);
        updateBlueprintBehavior(bp.id, textIdxRef.current, cfg);
        return;
      }

      // Emitter offset — drives the ParticleEmitter behavior's offsetX/Y.
      if (d.kind === "emitter-offset") {
        if (emitterIdxRef.current < 0) return;
        const cfg: Record<string, unknown> = { ...emitterCfgRef.current };
        if (d.axis === "x" || d.axis === "xy") cfg.offsetX = Math.round(d.origOffX + dx);
        if (d.axis === "y" || d.axis === "xy") cfg.offsetY = Math.round(d.origOffY + dy);
        updateBlueprintBehavior(bp.id, emitterIdxRef.current, cfg);
        return;
      }

      // VisionMask center — drives the VisionMask behavior's centerOffsetX/Y.
      if (d.kind === "visionmask-center") {
        if (visionMaskIdxRef.current < 0) return;
        const cfg: Record<string, unknown> = { ...visionMaskCfgRef.current };
        if (d.axis === "x" || d.axis === "xy") cfg.centerOffsetX = Math.round(d.origOffX + dx);
        if (d.axis === "y" || d.axis === "xy") cfg.centerOffsetY = Math.round(d.origOffY + dy);
        updateBlueprintBehavior(bp.id, visionMaskIdxRef.current, cfg);
        return;
      }

      // SmartTween scale pivot — drives the SmartTween behavior's scalePivotX/Y.
      if (d.kind === "smarttween-pivot") {
        if (smartTweenIdxRef.current < 0) return;
        const cfg: Record<string, unknown> = { ...smartTweenCfgRef.current };
        if (d.axis === "x" || d.axis === "xy") cfg.scalePivotX = Math.round(d.origOffX + dx);
        if (d.axis === "y" || d.axis === "xy") cfg.scalePivotY = Math.round(d.origOffY + dy);
        updateBlueprintBehavior(bp.id, smartTweenIdxRef.current, cfg);
        return;
      }

      // Dismemberment region — move the whole rect, or resize from a corner.
      // Coords are frame-local pixels; dx/dy are already world-scaled above.
      if (d.kind === "dismember-move" || d.kind === "dismember-resize") {
        if (dismemberIdxRef.current < 0) return;
        const cfg: Record<string, unknown> = { ...dismemberCfgRef.current };
        const regions = Array.isArray(cfg.regions)
          ? (cfg.regions as Array<Record<string, unknown>>).map((r) => ({ ...r }))
          : [];
        const reg = regions[d.idx];
        if (!reg) return;
        // Clamp to the frame so regions can't be authored outside the sprite —
        // the runtime can only slice real frame pixels, so out-of-bounds rects
        // would mismatch the preview (e.g. a region dragged above the frame).
        const fw = dismemberFrameRef.current.w || 0;
        const fh = dismemberFrameRef.current.h || 0;
        if (d.kind === "dismember-move") {
          const w = Number(reg.w) || 1;
          const h = Number(reg.h) || 1;
          let nx = Math.round(d.origX + dx);
          let ny = Math.round(d.origY + dy);
          if (fw > 0) nx = Math.max(0, Math.min(nx, fw - w));
          if (fh > 0) ny = Math.max(0, Math.min(ny, fh - h));
          reg.x = nx;
          reg.y = ny;
        } else {
          // Resolve to edges so dragging a corner past its opposite flips cleanly.
          let left = d.origX;
          let right = d.origX + d.origW;
          let top = d.origY;
          let bottom = d.origY + d.origH;
          if (d.corner === "nw" || d.corner === "sw") left = d.origX + dx;
          if (d.corner === "ne" || d.corner === "se") right = d.origX + d.origW + dx;
          if (d.corner === "nw" || d.corner === "ne") top = d.origY + dy;
          if (d.corner === "sw" || d.corner === "se") bottom = d.origY + d.origH + dy;
          if (fw > 0) { left = Math.max(0, Math.min(left, fw)); right = Math.max(0, Math.min(right, fw)); }
          if (fh > 0) { top = Math.max(0, Math.min(top, fh)); bottom = Math.max(0, Math.min(bottom, fh)); }
          reg.x = Math.round(Math.min(left, right));
          reg.y = Math.round(Math.min(top, bottom));
          reg.w = Math.max(1, Math.round(Math.abs(right - left)));
          reg.h = Math.max(1, Math.round(Math.abs(bottom - top)));
        }
        cfg.regions = regions;
        updateBlueprintBehavior(bp.id, dismemberIdxRef.current, cfg);
        return;
      }

      // Collider gizmo (offset + resize) — needs a collider on the BP.
      if (colliderIdxRef.current < 0) return;
      const cfg: Record<string, unknown> = { ...colliderCfgRef.current };
      if (d.kind === "offset") {
        if (d.axis === "x" || d.axis === "xy") cfg.offsetX = Math.round(d.origOffX + dx);
        if (d.axis === "y" || d.axis === "xy") cfg.offsetY = Math.round(d.origOffY + dy);
      } else if (d.kind === "resize-w") {
        cfg.width  = Math.max(2, Math.round(d.origW + dx * 2));
      } else if (d.kind === "resize-h") {
        cfg.height = Math.max(2, Math.round(d.origH + dy * 2));
      }
      updateBlueprintBehavior(bp.id, colliderIdxRef.current, cfg);
    };
    const onUp = () => { dragRef.current = null; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
  }, [bp.id, updateBlueprintBehavior]);

  // ─── Preview resize helpers ──────────────────────────────────────────────
  const startResizeDrag = (
    e: React.MouseEvent,
    axes: "h" | "w" | "both",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startH = previewH;
    const startW = previewW ?? containerW - 20;
    const onMove = (ev: MouseEvent) => {
      if (axes === "h" || axes === "both")
        setPreviewH(Math.max(MIN_PH, startH + ev.clientY - startY));
      if (axes === "w" || axes === "both")
        setPreviewW(Math.max(MIN_PW, startW + ev.clientX - startX));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  };

  // ─── Gizmo shorthand helpers ──────────────────────────────────────────────
  const oX    = Number(cCfg.offsetX ?? 0);
  const oY    = Number(cCfg.offsetY ?? 0);
  const origW = Number(cCfg.width   ?? 32);
  const origH = Number(cCfg.height  ?? 48);

  const scaleHandleRX = cx + cDispW / 2;
  const scaleHandleRY = cy;
  const scaleHandleBX = cx;
  const scaleHandleBY = cy + cDispH / 2;

  const zoomPct = Math.round(zoom * 100);

  // Width the preview box actually uses (css)
  const boxWidth = previewW !== null ? previewW : undefined; // undefined = fill parent

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={outerRef}
      style={{
        position: "relative",
        margin: "10px 10px 0",
        flexShrink: 0,
        width: boxWidth,
        // When explicitly sized, don't let parent stretch it back
        alignSelf: previewW !== null ? "flex-start" : "auto",
      }}
    >
      {/* Clipped background */}
      <div
        onWheel={onWheel}
        onDoubleClick={resetView}
        onMouseDown={(e) => {
          // Middle-mouse, OR plain left-click on the empty background
          // (gizmo handles stop-propagation so they take priority).
          const isMiddle = e.button === 1;
          const isLeftBg = e.button === 0;
          if (!isMiddle && !isLeftBg) return;
          e.preventDefault();
          dragRef.current = {
            kind: "pan",
            startX: e.clientX, startY: e.clientY,
            origPanX: panX, origPanY: panY,
          };
        }}
        style={{
          height: previewH,
          // Author-picked background — default near-black so the orange
          // dashed collider stroke reads with contrast. A color swatch in
          // the bottom-right opens a native color picker.
          background: bgColor,
          borderRadius: 12,
          overflow: "hidden",
          position: "relative",
          cursor: "grab",
        }}
        title="Drag to pan · Scroll to zoom · Double-click to reset"
      >
        {/* Actor body — rect placeholder + sprite art render. `hideRect`
            only suppresses the colored rect placeholder (it's just a
            "where's the BP" testing visual); sprite art is independent
            and keeps rendering when it exists. Text behavior owns its
            own visual so the rect is also suppressed in that case. */}
        {(() => {
          // Render EVERY Text behavior (Text is multi-instance — a BP can
          // have multiple labels at different offsets). `hasText` is used
          // for the "hide the bg rect because text owns the visual" check;
          // any Text attached suppresses the rect.
          const textBehaviors = bp.behaviors.filter((b) => b.kind === "Text");
          const hasText = textBehaviors.length > 0;
          const showRect = !firstFrame?.imageFile && !hasText && !bp.hideRect;
          const showSprite = !!firstFrameURL;
          // Position the image so its pivot pixel lands at (actorPx, actorPy).
          // For legacy frames without a pivot, this collapses to the same
          // result as the old centered render (default pivot = image center).
          const pivotPxX = pivotX * sc;
          const pivotPxY = pivotY * sc;
          const spriteLeftPx = Math.round(actorPx - pivotPxX);
          const spriteTopPx  = Math.round(actorPy - pivotPxY);
          // Rect fallback (no sprite art) stays centered on the actor —
          // it's purely an editor placeholder so the BP is visible in the
          // preview; the runtime renders nothing for empty BPs.
          const rectLeftPx = Math.round(actorPx - actorW   / 2);
          const rectTopPx  = Math.round(actorPy - actorHpx / 2);
          // SmartTween scrub preview for the HOST body / SpriteRenderer —
          // applied to the BP's main visual (sprite img + fallback rect) so
          // scrubbing a "host" or "SpriteRenderer" animation previews on the
          // whole BP, not just weapons. Same additive-offset / multiplicative-
          // scale / additive-rotation°/ multiplicative-opacity convention as
          // WeaponSlotPreview.
          const hostPv = (animatorPreview && animatorPreview.bpId === bp.id
            && (animatorPreview.target === "host" || animatorPreview.target === "SpriteRenderer"))
            ? animatorPreview : null;
          const hostPvTransform = hostPv
            ? `translate(${(hostPv.offsetX * sc).toFixed(2)}px, ${(hostPv.offsetY * sc).toFixed(2)}px) scale(${hostPv.scale}) rotate(${hostPv.rotation}deg)`
            : "";
          // Honor TiledBackground flipX/flipY + compose the SmartTween host
          // scrub transform. Shared by the sprite img AND its tint overlay.
          const flipT = (() => {
            if (renderer?.kind !== "TiledBackground") return "";
            const fx = renderer.config.flipX ? -1 : 1;
            const fy = renderer.config.flipY ? -1 : 1;
            return fx === 1 && fy === 1 ? "" : `scale(${fx}, ${fy})`;
          })();
          const imgTransform = `${hostPvTransform} ${flipT}`.trim() || undefined;
          const imgTransformOrigin = (hostPv && smartTweenBh)
            ? `${(pivotX + stPivotX) * sc}px ${(pivotY + stPivotY) * sc}px`
            : "center center";
          // SmartTween scrub tint — approximates Phaser's tint with a colored
          // overlay masked to the sprite alpha. Multiply mode = mix-blend
          // multiply (white = no-op, so it's skipped). Fill mode = solid
          // silhouette (mix-blend normal), so white shows as a full-white flash.
          const pvFill = !!(hostPv && hostPv.tintFill);
          const pvTint = hostPv && typeof hostPv.tint === "number" && hostPv.tint >= 0 && (pvFill || hostPv.tint !== 0xffffff) ? hostPv.tint : -1;
          return (
            <>
              {showSprite && (
                <img
                  src={firstFrameURL} alt="" draggable={false}
                  style={{
                    position: "absolute",
                    left: spriteLeftPx,
                    top:  spriteTopPx,
                    width:  actorW,
                    height: actorHpx,
                    imageRendering: "pixelated",
                    pointerEvents: "none",
                    opacity: hostPv ? hostPv.opacity : undefined,
                    transform: imgTransform,
                    transformOrigin: imgTransformOrigin,
                  }}
                />
              )}
              {showSprite && pvTint >= 0 && firstFrameURL && (
                <div
                  style={{
                    position: "absolute",
                    left: spriteLeftPx,
                    top:  spriteTopPx,
                    width:  actorW,
                    height: actorHpx,
                    backgroundColor: `#${(pvTint >>> 0).toString(16).padStart(6, "0").slice(-6)}`,
                    WebkitMaskImage: `url(${firstFrameURL})`,
                    maskImage: `url(${firstFrameURL})`,
                    WebkitMaskSize: "100% 100%",
                    maskSize: "100% 100%",
                    WebkitMaskRepeat: "no-repeat",
                    maskRepeat: "no-repeat",
                    mixBlendMode: pvFill ? "normal" : "multiply",
                    pointerEvents: "none",
                    opacity: hostPv ? hostPv.opacity : undefined,
                    transform: imgTransform,
                    transformOrigin: imgTransformOrigin,
                  }}
                />
              )}
              {showRect && (
                <div style={{
                  position: "absolute",
                  left: rectLeftPx,
                  top:  rectTopPx,
                  width: actorW,
                  height: actorHpx,
                  background: `#${bp.color.toString(16).padStart(6, "0")}`,
                  borderRadius: 2,
                  opacity: hostPv ? hostPv.opacity : undefined,
                  transform: hostPvTransform || undefined,
                  transformOrigin: (hostPv && smartTweenBh)
                    ? `${actorW / 2 + stPivotX * sc}px ${actorHpx / 2 + stPivotY * sc}px`
                    : "center center",
                }} />
              )}
              {/* WeaponSlots — render each equipped weapon's first frame at its
                  configured host image-point (falls back to the host body
                  center when the point is missing on this frame). Mirrors with
                  no facing in BP preview (host always faces right here). */}
              {bp.behaviors.filter((b) => b.kind === "WeaponSlot").map((wb, wi) => {
                // Scrub preview override: matches when the SmartTween's
                // target is THIS slot's name (e.g. "WeaponSlot:RightHand").
                const slotName = String((wb.config as Record<string, unknown>).name ?? "");
                const wantTarget = `WeaponSlot:${slotName}`;
                const wantBareTarget = "WeaponSlot";
                const matches = animatorPreview && animatorPreview.bpId === bp.id
                  && (animatorPreview.target === wantTarget || animatorPreview.target === wantBareTarget);
                return (
                  <WeaponSlotPreview
                    key={`ws-${wi}`}
                    cfg={wb.config as Record<string, unknown>}
                    sprites={sprites}
                    hostFirstFrame={firstFrame}
                    actorPx={actorPx}
                    actorPy={actorPy}
                    hostPivotX={pivotX}
                    hostPivotY={pivotY}
                    sc={sc}
                    previewOverride={matches ? animatorPreview : null}
                  />
                );
              })}
              {textBehaviors.map((tb, ti) => {
                const cfg = tb.config as Record<string, unknown>;
                const visible = Number(cfg.visible ?? 1) !== 0;
                if (!visible) return null;
                const content = String(cfg.content ?? "");
                const colorN = Number(cfg.color ?? 0xffffff);
                const align  = String(cfg.align  ?? "left") as "left" | "center" | "right";
                const vAlign = String(cfg.vAlign ?? "top")  as "top"  | "middle" | "bottom";
                const ox = Number(cfg.offsetX ?? 0) * sc;
                const oy = Number(cfg.offsetY ?? 0) * sc;
                // Anchor lives at (actor center + offset) regardless of
                // alignment. Alignment controls the pivot via CSS transform:
                //   left   → 0%   (text's left edge at anchor)
                //   center → -50% (text's center at anchor)
                //   right  → -100% (text's right edge at anchor)
                // Same pattern for vAlign on Y.
                const tx = align  === "center" ? "-50%" : align  === "right"  ? "-100%" : "0%";
                const ty = vAlign === "middle" ? "-50%" : vAlign === "bottom" ? "-100%" : "0%";
                const anchorX = actorPx + ox;
                const anchorY = actorPy + oy;
                return (
                  <span key={`text-${ti}`} style={{
                    position: "absolute",
                    left: anchorX,
                    top: anchorY,
                    transform: `translate(${tx}, ${ty})`,
                    fontFamily: String(cfg.fontFamily ?? "Arial"),
                    fontSize: Number(cfg.fontSize ?? 16) * sc,
                    color: `#${(colorN & 0xffffff).toString(16).padStart(6, "0")}`,
                    fontWeight: Number(cfg.bold ?? 0) ? 700 : 400,
                    fontStyle: Number(cfg.italic ?? 0) ? "italic" : "normal",
                    textAlign: align,
                    whiteSpace: Number(cfg.wrapWidth ?? 0) > 0 ? "pre-wrap" : "pre",
                    maxWidth: Number(cfg.wrapWidth ?? 0) > 0 ? Number(cfg.wrapWidth) * sc : undefined,
                    lineHeight: 1.1,
                    userSelect: "none",
                    pointerEvents: "none",
                  }}>{content}</span>
                );
              })}
              {/* Widget preview — for each BP-attached `Widget` component
                  (per-NPC healthbar etc.), draw a simplified representation
                  at the configured offset so authors see where the widget
                  will land. Mirrors the runtime composition: root box +
                  multi-mode children stacked at their authored offsets. */}
              {bp.behaviors.filter((b) => b.kind === "Widget").map((widgetBeh, wi) => {
                const cfg = widgetBeh.config as Record<string, unknown>;
                const wid = String(cfg.widgetId ?? "");
                if (!wid) return null;
                const widget = uiWidgets.find((w) => w.id === wid);
                if (!widget) return (
                  <span key={`wmiss-${wi}`} style={{
                    position: "absolute",
                    left: actorPx + Number(cfg.offsetX ?? 0) * sc,
                    top:  actorPy + Number(cfg.offsetY ?? -40) * sc,
                    transform: "translate(-50%, -50%)",
                    fontSize: 9, color: "var(--orange)",
                    background: "rgba(0,0,0,0.5)", padding: "2px 4px",
                    borderRadius: 3, pointerEvents: "none",
                  }}>⚠ missing widget</span>
                );
                const ox = Number(cfg.offsetX ?? 0) * sc;
                const oy = Number(cfg.offsetY ?? -40) * sc;
                const wW = widget.width * sc;
                const wH = widget.height * sc;
                const rootLeft = actorPx + ox - wW / 2;
                const rootTop  = actorPy + oy - wH / 2;
                const isMulti = widget.mode === "multi";
                const rootBgN = widget.bgColor ?? 0;
                const rootBgA = widget.bgAlpha ?? (widget.bgColor !== undefined ? 1 : 0);
                const rootBorderN = widget.borderColor ?? 0;
                const rootBorderW = widget.borderWidth ?? 0;
                return (
                  <div key={`w-${wi}`} style={{
                    position: "absolute",
                    left: rootLeft, top: rootTop,
                    width: wW, height: wH,
                    pointerEvents: "none",
                    overflow: "visible",
                  }}>
                    {/* Root box — only render fill/border when widget has them.
                        Multi-mode root is often transparent and only the
                        children carry visuals. */}
                    {!isMulti && (rootBgA > 0 || rootBorderW > 0) && (
                      <div className="wradius" style={{
                        position: "absolute", inset: 0,
                        background: rootBgA > 0 ? `rgba(${(rootBgN >> 16) & 0xff}, ${(rootBgN >> 8) & 0xff}, ${rootBgN & 0xff}, ${rootBgA})` : "transparent",
                        border: rootBorderW > 0 ? `${Math.max(1, rootBorderW * sc)}px solid #${(rootBorderN & 0xffffff).toString(16).padStart(6, "0")}` : "none",
                        borderRadius: (widget.cornerRadius ?? 0) * sc,
                        boxSizing: "border-box",
                      }} />
                    )}
                    {/* Multi-mode children — each rendered at its authored
                        canvas offset (top-left of root + child.x/y). Simple
                        bg-color box approximation; for label children we
                        also draw the text. */}
                    {isMulti && widget.children.map((c, ci) => {
                      const cBgN = c.bgColor ?? 0;
                      const cBgA = c.bgAlpha ?? (c.bgColor !== undefined ? 1 : 0);
                      const cBorderN = c.borderColor ?? 0;
                      const cBorderW = c.borderWidth ?? 0;
                      const isFillKind = c.kind === "ProgressBar" || c.kind === "Slider";
                      return (
                        <div key={ci} className="wradius" style={{
                          position: "absolute",
                          left: c.x * sc, top: c.y * sc,
                          width: c.width * sc, height: c.height * sc,
                          background: cBgA > 0 ? `rgba(${(cBgN >> 16) & 0xff}, ${(cBgN >> 8) & 0xff}, ${cBgN & 0xff}, ${cBgA})` : "transparent",
                          border: cBorderW > 0 ? `${Math.max(1, cBorderW * sc)}px solid #${(cBorderN & 0xffffff).toString(16).padStart(6, "0")}` : "none",
                          borderRadius: (c.cornerRadius ?? 0) * sc,
                          boxSizing: "border-box",
                          color: `#${((c.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
                          fontSize: (c.fontSize ?? 12) * sc,
                          fontFamily: c.fontFamily ?? "Arial",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: c.align === "right" ? "flex-end" : c.align === "left" ? "flex-start" : "center",
                          overflow: "hidden",
                          padding: 2 * sc,
                        }}>
                          {isFillKind && (
                            // Draw a "value" fill at the current value/(max-min)
                            <div style={{
                              position: "absolute",
                              left: 0, top: 0,
                              width: `${((Number(c.value ?? 0) - Number(c.min ?? 0)) / Math.max(1, Number(c.max ?? 100) - Number(c.min ?? 0))) * 100}%`,
                              height: "100%",
                              background: `#${((c.fillColor ?? 0x44ddff) & 0xffffff).toString(16).padStart(6, "0")}`,
                              opacity: 0.85,
                            }} />
                          )}
                          {c.kind === "Label" || c.kind === "Button" ? String(c.text ?? "") : ""}
                        </div>
                      );
                    })}
                    {/* Widget-name badge in the corner so the author knows
                        which widget is attached at a glance. */}
                    <span style={{
                      position: "absolute",
                      left: 0, top: -14 * sc,
                      fontSize: Math.max(8, 9 * sc),
                      color: "var(--text-faint)",
                      fontFamily: "JetBrains Mono, monospace",
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                      pointerEvents: "none",
                      whiteSpace: "nowrap",
                    }}>≡ {widget.name || "widget"}</span>
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* Collider shape overlay — bumped stroke + tint so it stays
            visible on light author-picked backgrounds. */}
        {collider && (
          <div style={{
            position: "absolute",
            left: cx - cDispW / 2, top: cy - cDispH / 2,
            width: cDispW, height: cDispH,
            borderRadius: 3,
            border: "2px dashed #ff9a3c",
            background: "rgba(255,154,60,0.15)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }} />
        )}

        {/* Projectile hitbox overlay — the damage / tile-mining footprint,
            centered on the body. Shown when the Projectile component is
            selected. Orange-red to match the Projectile chip badge. */}
        {projectile && selectedIdx === projectileIdx && (() => {
          const w = Math.max(2, Math.round(pjHbW * sc));
          const h = Math.max(2, Math.round(pjHbH * sc));
          const hx = actorPx + pjHbOffX * sc;
          const hy = actorPy + pjHbOffY * sc;
          return (
            <>
              <div style={{
                position: "absolute",
                left: hx - w / 2, top: hy - h / 2,
                width: w, height: h,
                border: "2px dashed #e8743b",
                background: "rgba(232,116,59,0.12)",
                boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
                boxSizing: "border-box",
                pointerEvents: "none",
              }} />
              <span style={{
                position: "absolute",
                left: hx - w / 2, top: hy - h / 2 - 13,
                fontSize: 9, color: "#e8743b",
                fontFamily: "JetBrains Mono, monospace",
                whiteSpace: "nowrap", pointerEvents: "none",
                textShadow: "0 0 2px #000",
              }}>hitbox {Math.round(pjHbW)}×{Math.round(pjHbH)}</span>
            </>
          );
        })()}

        {/* Bottom-left badges */}
        <span style={{
          position: "absolute", bottom: 6, left: 8,
          fontSize: 9, color: "var(--text-faint)",
          fontFamily: "JetBrains Mono, monospace",
          textTransform: "uppercase", letterSpacing: 0.6,
        }}>
          {bp.classKind === "Character" ? "Character" : "Actor"}
        </span>

        {/* Zoom level — shown whenever not 100 % */}
        {zoom !== 1 && (
          <span
            title="Double-click anywhere to reset zoom"
            style={{
              position: "absolute", bottom: 6, right: 32,
              fontSize: 9, color: "var(--text-muted)",
              fontFamily: "JetBrains Mono, monospace",
              letterSpacing: 0.4,
              cursor: "default",
            }}
          >
            {zoomPct}%
          </span>
        )}

        {/* Background color picker — bottom-right swatch. Click opens the
            native color dialog; alt-click resets to the default. Stopping
            propagation keeps the underlying pan-drag from grabbing. */}
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title="Preview background color (alt-click to reset)"
          style={{
            position: "absolute", bottom: 6, right: 8,
            width: 18, height: 14,
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 3, padding: 0, lineHeight: 0,
            background: bgColor, cursor: "pointer", overflow: "hidden",
          }}
          onClick={(e) => {
            if (e.altKey) { setBgColor(DEFAULT_BG); return; }
            const input = (e.currentTarget.querySelector("input") as HTMLInputElement | null);
            input?.click();
          }}
        >
          <input
            type="color"
            value={bgColor}
            onChange={(e) => setBgColor(e.target.value)}
            style={{ opacity: 0, width: "100%", height: "100%", border: "none", padding: 0, margin: 0, cursor: "pointer" }}
          />
        </div>
      </div>

      {/* Y-sort line — the world Y this BP sorts on (overlay top + height ×
          pivot, matching the runtime). Drawn over the sprite so the author
          sees the height at which the player passes behind vs in front. */}
      <svg
        style={{
          position: "absolute", top: 0, left: 0,
          width: "100%", height: previewH,
          overflow: "visible", pointerEvents: "none",
        }}
      >
        {(() => {
          const ysPivot = typeof bp.ySortPivotY === "number" ? bp.ySortPivotY : 1;
          const ysLineY = Math.round(actorPy + (spriteTop + visH * ysPivot) * sc);
          return (
            <>
              <line
                x1={0} y1={ysLineY} x2={containerW} y2={ysLineY}
                stroke="#ffcc33" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.85}
              />
              <text x={5} y={ysLineY - 4} fill="#ffcc33" fontSize={10} fontWeight={600}>
                Y-sort
              </text>
            </>
          );
        })()}
      </svg>

      {/* Gizmo SVG — outside the clip so arrows are never cut off.
          Only rendered when the user has the Collider component selected
          in the left-rail Components panel. */}
      {collider && selectedIdx === colliderIdx && (
        <svg
          style={{
            position: "absolute", top: 0, left: 0,
            width: "100%", height: previewH,
            overflow: "visible", pointerEvents: "none",
          }}
        >
          {/* Offset — X arrow */}
          <line x1={cx} y1={cy} x2={cx+OFFSET_ARROW} y2={cy} stroke="#ff5555" strokeWidth={1.5} />
          <polygon
            points={`${cx+OFFSET_ARROW},${cy-OFFSET_TIP/2} ${cx+OFFSET_ARROW+OFFSET_TIP},${cy} ${cx+OFFSET_ARROW},${cy+OFFSET_TIP/2}`}
            fill="#ff5555"
          />
          {/* Offset — Y arrow */}
          <line x1={cx} y1={cy} x2={cx} y2={cy+OFFSET_ARROW} stroke="#44ddaa" strokeWidth={1.5} />
          <polygon
            points={`${cx-OFFSET_TIP/2},${cy+OFFSET_ARROW} ${cx},${cy+OFFSET_ARROW+OFFSET_TIP} ${cx+OFFSET_TIP/2},${cy+OFFSET_ARROW}`}
            fill="#44ddaa"
          />

          {/* Center handle (offset XY) */}
          <rect
            x={cx-5} y={cy-5} width={10} height={10}
            fill="white" opacity={0.9} rx={1}
            style={{ cursor: "move", pointerEvents: "all" }}
            onMouseDown={(e) => startGizmoDrag(
              { kind: "offset", axis: "xy", startX: e.clientX, startY: e.clientY, origOffX: oX, origOffY: oY }, e)}
          />
          {/* X-only handle */}
          <circle
            cx={cx+OFFSET_ARROW+OFFSET_TIP+4} cy={cy} r={HANDLE_R}
            fill="#ff5555"
            style={{ cursor: "ew-resize", pointerEvents: "all" }}
            onMouseDown={(e) => startGizmoDrag(
              { kind: "offset", axis: "x", startX: e.clientX, startY: e.clientY, origOffX: oX, origOffY: oY }, e)}
          />
          {/* Y-only handle */}
          <circle
            cx={cx} cy={cy+OFFSET_ARROW+OFFSET_TIP+4} r={HANDLE_R}
            fill="#44ddaa"
            style={{ cursor: "ns-resize", pointerEvents: "all" }}
            onMouseDown={(e) => startGizmoDrag(
              { kind: "offset", axis: "y", startX: e.clientX, startY: e.clientY, origOffX: oX, origOffY: oY }, e)}
          />

          {/* Right-edge — resize width */}
          <rect
            x={scaleHandleRX-SCALE_HALF} y={scaleHandleRY-SCALE_HALF}
            width={SCALE_HALF*2} height={SCALE_HALF*2}
            fill="var(--orange)" opacity={0.9} rx={1}
            style={{ cursor: "ew-resize", pointerEvents: "all" }}
            onMouseDown={(e) => startGizmoDrag(
              { kind: "resize-w", startX: e.clientX, startY: e.clientY, origW }, e)}
          />
          <text
            x={scaleHandleRX+SCALE_HALF+3} y={scaleHandleRY+4}
            fontSize={8} fill="var(--orange)"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >W</text>

          {/* Bottom-edge — resize height */}
          <rect
            x={scaleHandleBX-SCALE_HALF} y={scaleHandleBY-SCALE_HALF}
            width={SCALE_HALF*2} height={SCALE_HALF*2}
            fill="var(--orange)" opacity={0.9} rx={1}
            style={{ cursor: "ns-resize", pointerEvents: "all" }}
            onMouseDown={(e) => startGizmoDrag(
              { kind: "resize-h", startX: e.clientX, startY: e.clientY, origH }, e)}
          />
          <text
            x={scaleHandleBX+SCALE_HALF+3} y={scaleHandleBY+4}
            fontSize={8} fill="var(--orange)"
            style={{ pointerEvents: "none", userSelect: "none" }}
          >H</text>
        </svg>
      )}

      {/* Text offset gizmo — positions the Text behavior's anchor point.
          Always centered on the actor + the user offset; alignment props
          are now purely about multi-line text justification, not anchor.
          Only rendered when the Text component is the selected one. */}
      {emitterBh && selectedIdx === emitterIdx && (() => {
        // Draggable spawn-point indicator for the selected ParticleEmitter.
        // Drag the green dot to set offsetX/offsetY; the axis handles let
        // you constrain to a single axis. Matches the Text gizmo idiom so
        // the BP preview gizmo language is consistent.
        const ex = Math.round(actorPx + eOffX * sc);
        const ey = Math.round(actorPy + eOffY * sc);
        return (
          <svg
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: previewH,
              overflow: "visible", pointerEvents: "none",
            }}
          >
            {/* X arrow (green) */}
            <line x1={ex} y1={ey} x2={ex+OFFSET_ARROW} y2={ey} stroke="#4ade80" strokeWidth={1.5} />
            <polygon
              points={`${ex+OFFSET_ARROW},${ey-OFFSET_TIP/2} ${ex+OFFSET_ARROW+OFFSET_TIP},${ey} ${ex+OFFSET_ARROW},${ey+OFFSET_TIP/2}`}
              fill="#4ade80"
            />
            {/* Y arrow (green) */}
            <line x1={ex} y1={ey} x2={ex} y2={ey+OFFSET_ARROW} stroke="#4ade80" strokeWidth={1.5} />
            <polygon
              points={`${ex-OFFSET_TIP/2},${ey+OFFSET_ARROW} ${ex},${ey+OFFSET_ARROW+OFFSET_TIP} ${ex+OFFSET_TIP/2},${ey+OFFSET_ARROW}`}
              fill="#4ade80"
            />
            {/* Center handle — round dot, the visual "spawn point" */}
            <circle
              cx={ex} cy={ey} r={6}
              fill="#4ade80" stroke="#000" strokeWidth={1}
              style={{ cursor: "move", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "emitter-offset", axis: "xy", startX: e.clientX, startY: e.clientY, origOffX: eOffX, origOffY: eOffY }, e)}
            />
            {/* X-only handle */}
            <circle
              cx={ex+OFFSET_ARROW+OFFSET_TIP+4} cy={ey} r={HANDLE_R}
              fill="#4ade80"
              style={{ cursor: "ew-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "emitter-offset", axis: "x", startX: e.clientX, startY: e.clientY, origOffX: eOffX, origOffY: eOffY }, e)}
            />
            {/* Y-only handle */}
            <circle
              cx={ex} cy={ey+OFFSET_ARROW+OFFSET_TIP+4} r={HANDLE_R}
              fill="#4ade80"
              style={{ cursor: "ns-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "emitter-offset", axis: "y", startX: e.clientX, startY: e.clientY, origOffX: eOffX, origOffY: eOffY }, e)}
            />
          </svg>
        );
      })()}

      {aiBrainBh && (() => {
        // Attack-range ring (dashed circle) + radial distance line + label,
        // centered on the actor. Red matches the combat/attack convention.
        const R = Number(aiBrainBh.config.attackRange ?? 0);
        if (!(R > 0)) return null;
        const ring = Math.max(2, R * sc);
        const C = "#e85553";
        return (
          <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: previewH, overflow: "visible", pointerEvents: "none" }}>
            <circle cx={actorPx} cy={actorPy} r={ring} fill="rgba(232,85,83,0.05)" stroke={C} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.85} />
            <line x1={actorPx} y1={actorPy} x2={actorPx + ring} y2={actorPy} stroke={C} strokeWidth={1.5} opacity={0.9} />
            <circle cx={actorPx} cy={actorPy} r={3} fill="#ffd040" opacity={0.95} />
            <text x={actorPx + ring / 2} y={actorPy - 5} fill="#ff8a88" fontSize={11} fontWeight={700} textAnchor="middle">atk {Math.round(R)}</text>
          </svg>
        );
      })()}

      {visionMaskBh && selectedIdx === visionMaskIdx && (() => {
        // Draggable reveal-center for the selected VisionMask + a ring showing
        // the radius. Cyan matches the VisionMask chip badge color.
        const mx = Math.round(actorPx + vmOffX * sc);
        const my = Math.round(actorPy + vmOffY * sc);
        const ring = Math.max(2, Math.round(vmRadius * sc));
        const C = "#3ab0ff";
        return (
          <>
          {/* Actual reveal shape (sprite alpha) under the gizmo, so the author
              sees the silhouette at the configured center + radius. */}
          {maskFrameURL && (
            <img
              src={maskFrameURL} alt="" draggable={false}
              style={{
                position: "absolute",
                left: mx, top: my - ring,
                height: ring * 2, width: "auto",
                transform: "translateX(-50%)",
                opacity: 0.5,
                imageRendering: "pixelated",
                pointerEvents: "none",
              }}
            />
          )}
          <svg
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: previewH,
              overflow: "visible", pointerEvents: "none",
            }}
          >
            {/* Radius ring */}
            <circle cx={mx} cy={my} r={ring} fill="none" stroke={C} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
            {/* X arrow */}
            <line x1={mx} y1={my} x2={mx+OFFSET_ARROW} y2={my} stroke={C} strokeWidth={1.5} />
            <polygon
              points={`${mx+OFFSET_ARROW},${my-OFFSET_TIP/2} ${mx+OFFSET_ARROW+OFFSET_TIP},${my} ${mx+OFFSET_ARROW},${my+OFFSET_TIP/2}`}
              fill={C}
            />
            {/* Y arrow */}
            <line x1={mx} y1={my} x2={mx} y2={my+OFFSET_ARROW} stroke={C} strokeWidth={1.5} />
            <polygon
              points={`${mx-OFFSET_TIP/2},${my+OFFSET_ARROW} ${mx},${my+OFFSET_ARROW+OFFSET_TIP} ${mx+OFFSET_TIP/2},${my+OFFSET_ARROW}`}
              fill={C}
            />
            {/* Center handle (offset XY) */}
            <circle
              cx={mx} cy={my} r={6}
              fill={C} stroke="#000" strokeWidth={1}
              style={{ cursor: "move", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "visionmask-center", axis: "xy", startX: e.clientX, startY: e.clientY, origOffX: vmOffX, origOffY: vmOffY }, e)}
            />
            {/* X-only handle */}
            <circle
              cx={mx+OFFSET_ARROW+OFFSET_TIP+4} cy={my} r={HANDLE_R}
              fill={C}
              style={{ cursor: "ew-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "visionmask-center", axis: "x", startX: e.clientX, startY: e.clientY, origOffX: vmOffX, origOffY: vmOffY }, e)}
            />
            {/* Y-only handle */}
            <circle
              cx={mx} cy={my+OFFSET_ARROW+OFFSET_TIP+4} r={HANDLE_R}
              fill={C}
              style={{ cursor: "ns-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "visionmask-center", axis: "y", startX: e.clientX, startY: e.clientY, origOffX: vmOffX, origOffY: vmOffY }, e)}
            />
          </svg>
          </>
        );
      })()}

      {smartTweenBh && selectedIdx === smartTweenIdx && (() => {
        // Draggable scale-pivot for the selected SmartTween — scale keyframes
        // pivot around this point at runtime. Magenta matches the SmartTween
        // chip badge color. A small ⊕ crosshair marks the "scale origin".
        const sx = Math.round(actorPx + stPivotX * sc);
        const sy = Math.round(actorPy + stPivotY * sc);
        const C = "#c93aa8";
        return (
          <svg
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: previewH,
              overflow: "visible", pointerEvents: "none",
            }}
          >
            {/* crosshair through the pivot */}
            <line x1={sx - 9} y1={sy} x2={sx + 9} y2={sy} stroke={C} strokeWidth={1} opacity={0.7} />
            <line x1={sx} y1={sy - 9} x2={sx} y2={sy + 9} stroke={C} strokeWidth={1} opacity={0.7} />
            {/* X arrow */}
            <line x1={sx} y1={sy} x2={sx + OFFSET_ARROW} y2={sy} stroke={C} strokeWidth={1.5} />
            <polygon
              points={`${sx + OFFSET_ARROW},${sy - OFFSET_TIP / 2} ${sx + OFFSET_ARROW + OFFSET_TIP},${sy} ${sx + OFFSET_ARROW},${sy + OFFSET_TIP / 2}`}
              fill={C}
            />
            {/* Y arrow */}
            <line x1={sx} y1={sy} x2={sx} y2={sy + OFFSET_ARROW} stroke={C} strokeWidth={1.5} />
            <polygon
              points={`${sx - OFFSET_TIP / 2},${sy + OFFSET_ARROW} ${sx},${sy + OFFSET_ARROW + OFFSET_TIP} ${sx + OFFSET_TIP / 2},${sy + OFFSET_ARROW}`}
              fill={C}
            />
            {/* Center handle (offset XY) */}
            <circle
              cx={sx} cy={sy} r={6}
              fill={C} stroke="#000" strokeWidth={1}
              style={{ cursor: "move", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "smarttween-pivot", axis: "xy", startX: e.clientX, startY: e.clientY, origOffX: stPivotX, origOffY: stPivotY }, e)}
            />
            {/* X-only handle */}
            <circle
              cx={sx + OFFSET_ARROW + OFFSET_TIP + 4} cy={sy} r={HANDLE_R}
              fill={C}
              style={{ cursor: "ew-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "smarttween-pivot", axis: "x", startX: e.clientX, startY: e.clientY, origOffX: stPivotX, origOffY: stPivotY }, e)}
            />
            {/* Y-only handle */}
            <circle
              cx={sx} cy={sy + OFFSET_ARROW + OFFSET_TIP + 4} r={HANDLE_R}
              fill={C}
              style={{ cursor: "ns-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "smarttween-pivot", axis: "y", startX: e.clientX, startY: e.clientY, origOffX: stPivotX, origOffY: stPivotY }, e)}
            />
          </svg>
        );
      })()}

      {dismemberBh && selectedIdx === dismemberIdx && dismemberRegions.length > 0 && (() => {
        // Interactive region editor. A frame-pixel (rx, ry) maps to screen via
        // the same pivot transform the sprite art uses: the pivot pixel lands
        // at (actorPx, actorPy), so pixel p → actorPx + (p - pivot) * sc.
        // Drag the rect body to move; drag a corner to resize.
        const C = "#e06a6a";
        const HS = 5; // corner handle half-size (screen px)
        const corners: Array<{ c: "nw" | "ne" | "sw" | "se"; cur: string }> = [
          { c: "nw", cur: "nwse-resize" },
          { c: "ne", cur: "nesw-resize" },
          { c: "sw", cur: "nesw-resize" },
          { c: "se", cur: "nwse-resize" },
        ];
        return (
          <svg
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: previewH,
              // Clip to the preview box so region rects (which can sit far from
              // the sprite when their pixel coords don't match the current pose)
              // never spill over the surrounding inspector UI.
              overflow: "hidden", pointerEvents: "none",
            }}
          >
            {dismemberRegions.map((r, i) => {
              const rx = Number(r.x ?? 0);
              const ry = Number(r.y ?? 0);
              const rw = Math.max(1, Number(r.w ?? 1));
              const rh = Math.max(1, Number(r.h ?? 1));
              const left = actorPx + (rx - pivotX) * sc;
              const top  = actorPy + (ry - pivotY) * sc;
              const w = rw * sc;
              const h = rh * sc;
              return (
                <g key={i}>
                  <rect
                    x={left} y={top} width={w} height={h}
                    fill={C} fillOpacity={0.12}
                    stroke={C} strokeWidth={1} strokeDasharray="3 2"
                    style={{ cursor: "move", pointerEvents: "all" }}
                    onMouseDown={(e) => startGizmoDrag(
                      { kind: "dismember-move", idx: i, startX: e.clientX, startY: e.clientY, origX: rx, origY: ry }, e)}
                  />
                  <text
                    x={left + 2} y={top + 9}
                    fill={C} fontSize={9}
                    style={{ fontFamily: "monospace", pointerEvents: "none", userSelect: "none" }}
                  >{String(r.name ?? `r${i}`)}</text>
                  {corners.map(({ c, cur }) => {
                    const hx = c === "nw" || c === "sw" ? left : left + w;
                    const hy = c === "nw" || c === "ne" ? top : top + h;
                    return (
                      <rect
                        key={c}
                        x={hx - HS} y={hy - HS} width={HS * 2} height={HS * 2}
                        fill={C} stroke="#000" strokeWidth={0.5}
                        style={{ cursor: cur, pointerEvents: "all" }}
                        onMouseDown={(e) => startGizmoDrag(
                          { kind: "dismember-resize", idx: i, corner: c, startX: e.clientX, startY: e.clientY, origX: rx, origY: ry, origW: rw, origH: rh }, e)}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
        );
      })()}

      {textBh && selectedIdx === textIdx && (() => {
        const tx = Math.round(actorPx + tOffX * sc);
        const ty = Math.round(actorPy + tOffY * sc);
        return (
          <svg
            style={{
              position: "absolute", top: 0, left: 0,
              width: "100%", height: previewH,
              overflow: "visible", pointerEvents: "none",
            }}
          >
            {/* X arrow (purple) */}
            <line x1={tx} y1={ty} x2={tx+OFFSET_ARROW} y2={ty} stroke="#d14ad1" strokeWidth={1.5} />
            <polygon
              points={`${tx+OFFSET_ARROW},${ty-OFFSET_TIP/2} ${tx+OFFSET_ARROW+OFFSET_TIP},${ty} ${tx+OFFSET_ARROW},${ty+OFFSET_TIP/2}`}
              fill="#d14ad1"
            />
            {/* Y arrow (purple) */}
            <line x1={tx} y1={ty} x2={tx} y2={ty+OFFSET_ARROW} stroke="#d14ad1" strokeWidth={1.5} />
            <polygon
              points={`${tx-OFFSET_TIP/2},${ty+OFFSET_ARROW} ${tx},${ty+OFFSET_ARROW+OFFSET_TIP} ${tx+OFFSET_TIP/2},${ty+OFFSET_ARROW}`}
              fill="#d14ad1"
            />
            {/* Center handle (offset XY) */}
            <rect
              x={tx-5} y={ty-5} width={10} height={10}
              fill="white" opacity={0.9} rx={1}
              style={{ cursor: "move", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "text-offset", axis: "xy", startX: e.clientX, startY: e.clientY, origOffX: tOffX, origOffY: tOffY }, e)}
            />
            {/* X-only handle */}
            <circle
              cx={tx+OFFSET_ARROW+OFFSET_TIP+4} cy={ty} r={HANDLE_R}
              fill="#d14ad1"
              style={{ cursor: "ew-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "text-offset", axis: "x", startX: e.clientX, startY: e.clientY, origOffX: tOffX, origOffY: tOffY }, e)}
            />
            {/* Y-only handle */}
            <circle
              cx={tx} cy={ty+OFFSET_ARROW+OFFSET_TIP+4} r={HANDLE_R}
              fill="#d14ad1"
              style={{ cursor: "ns-resize", pointerEvents: "all" }}
              onMouseDown={(e) => startGizmoDrag(
                { kind: "text-offset", axis: "y", startX: e.clientX, startY: e.clientY, origOffX: tOffX, origOffY: tOffY }, e)}
            />
          </svg>
        );
      })()}

      {/* ── Resize handles ── */}

      {/* Bottom edge — height only */}
      <div
        onMouseDown={(e) => startResizeDrag(e, "h")}
        title="Drag to resize height"
        style={{
          height: 7, marginTop: 2,
          cursor: "ns-resize",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ width: 36, height: 2, borderRadius: 1, background: "rgba(255,255,255,0.12)" }} />
      </div>

      {/* Right edge — width only */}
      <div
        onMouseDown={(e) => startResizeDrag(e, "w")}
        title="Drag to resize width"
        style={{
          position: "absolute",
          top: 0, right: -7,
          width: 7, height: previewH,
          cursor: "ew-resize",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{ width: 2, height: 36, borderRadius: 1, background: "rgba(255,255,255,0.12)" }} />
      </div>

      {/* Bottom-right corner — both */}
      <div
        onMouseDown={(e) => startResizeDrag(e, "both")}
        title="Drag to resize both"
        style={{
          position: "absolute",
          bottom: 0, right: -7,
          width: 14, height: 14,
          cursor: "nwse-resize",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <div style={{
          width: 6, height: 6, borderRadius: 1,
          background: "rgba(255,255,255,0.18)",
        }} />
      </div>
    </div>
  );
}

/** Small icon mark for a behavior kind — used in the components list. */
export function BehaviorKindBadge({ kind }: { kind: BehaviorKind }) {
  const colors: Record<BehaviorKind, string> = {
    Solid:              "var(--teal)",
    JumpThru:           "var(--cyan)",
    CharacterMovement:  "var(--accent)",
    TopdownMovement:    "#4a9be0",
    SpriteRenderer:     "var(--pink)",
    Collider:           "var(--orange)",
    Text:               "var(--purple, #d14ad1)",
    Camera:             "#5e7aa8",
    Tracer:             "#ff7a00",
    SquashStretch:      "var(--yellow)",
    UIWidgetRenderer:   "var(--orange)",
    ParticleEmitter:    "#ff5e9c",
    Damageable:         "#e64545",
    StateMachine:       "#9c6bff",
    AIBrain:            "#ffcd3c",
    PhaseManager:       "#b53a3a",
    Widget:             "#d24ab0",
    SmartTween:         "#c93aa8",
    Projectile:         "#e8743b",
    Inventory:          "#e8b35a",
    TilemapRenderer:    "#7eb37e",
    VisionMask:         "#3ab0ff",
    MoveTo:             "#5dd39e",
    TiledBackground:    "#6e8ec9",
    WeaponSlot:         "#c084fc",
    Dismemberment:      "#e06a6a",
  };
  return (
    <span style={{
      width: 8, height: 8, borderRadius: 2,
      background: colors[kind],
      display: "inline-block", flexShrink: 0,
    }} />
  );
}

/** Render a single WeaponSlot's first frame at its configured host image
 *  point in the BP preview / scene editor. Position math mirrors the
 *  runtime's WeaponSlot.syncTransform (anchor = host image point in
 *  host-frame coords → screen coords via host's pivot + scale). */
function WeaponSlotPreview({
  cfg,
  sprites,
  hostFirstFrame,
  actorPx,
  actorPy,
  hostPivotX,
  hostPivotY,
  sc,
  previewOverride,
}: {
  cfg: Record<string, unknown>;
  sprites: SpriteAsset[];
  hostFirstFrame: { points?: Array<{ name: string; x: number; y: number }> } | undefined;
  actorPx: number;
  actorPy: number;
  hostPivotX: number;
  hostPivotY: number;
  sc: number;
  /** Sampled SmartTween values to additively apply on top of the
   *  configured offset/scale/rotation/opacity, so the scrub slider
   *  previews the live keyframe pose. Null = no preview override. */
  previewOverride: { offsetX: number; offsetY: number; scale: number; opacity: number; rotation: number } | null;
}) {
  const spriteId = String(cfg.spriteId ?? "");
  const animName = String(cfg.currentAnimation ?? "");
  const pointName = String(cfg.imagePoint ?? "");
  const offX = Number(cfg.offsetX ?? 0);
  const offY = Number(cfg.offsetY ?? 0);
  const angle = Number(cfg.angleOffset ?? 0);
  const sX = Number(cfg.scaleX ?? 1);
  const sY = Number(cfg.scaleY ?? 1);
  const visible = Number(cfg.visible ?? 1) !== 0;
  const playing = Number(cfg.playing ?? 1) !== 0;
  const startFrame = Math.max(0, Math.floor(Number(cfg.startFrame ?? 0)));
  const sprite = spriteId ? sprites.find((s) => s.id === spriteId) : undefined;
  const anim = sprite?.animations.find((a) => a.name === animName) ?? sprite?.animations[0];
  // Show the configured static frame when paused, otherwise frame 0 (the
  // pose authors most often want to see in the editor preview).
  const frameIdx = !playing && anim ? Math.min(startFrame, anim.frames.length - 1) : 0;
  const frame = anim?.frames[Math.max(0, frameIdx)];
  const url = useSpriteFrameURL(sprite, frame);
  if (!visible || !sprite || !frame || !url) return null;
  // Host image-point lookup. If found, anchor sits at that pixel; otherwise
  // collapses to host body center (same fallback the runtime uses).
  const pt = pointName
    ? hostFirstFrame?.points?.find((p) => p.name === pointName)
    : undefined;
  const anchorOffsetX = pt ? (pt.x - hostPivotX) * sc : 0;
  const anchorOffsetY = pt ? (pt.y - hostPivotY) * sc : 0;
  const baseW = (frame.imageW ?? sprite.width);
  const baseH = (frame.imageH ?? sprite.height);
  // SmartTween scrub preview — compose on top of the configured values.
  // additive offset (px), multiplicative scale, additive rotation (deg),
  // multiplicative opacity. Identity defaults so absence is a no-op.
  const pvOffX = previewOverride?.offsetX ?? 0;
  const pvOffY = previewOverride?.offsetY ?? 0;
  const pvScale = previewOverride?.scale ?? 1;
  const pvRot = previewOverride?.rotation ?? 0;
  const pvOpa = previewOverride?.opacity ?? 1;
  const finalSX = sX * pvScale;
  const finalSY = sY * pvScale;
  const weaponW = baseW * sc * finalSX;
  const weaponH = baseH * sc * finalSY;
  const wPivotX = (frame.pivotX ?? baseW / 2) * sc * finalSX;
  const wPivotY = (frame.pivotY ?? baseH / 2) * sc * finalSY;
  const x = actorPx + anchorOffsetX + (offX + pvOffX) * sc;
  const y = actorPy + anchorOffsetY + (offY + pvOffY) * sc;
  const totalAngle = angle + pvRot;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{
        position: "absolute",
        left: Math.round(x - wPivotX),
        top: Math.round(y - wPivotY),
        width: weaponW,
        height: weaponH,
        imageRendering: "pixelated",
        pointerEvents: "none",
        opacity: pvOpa,
        transform: totalAngle !== 0 ? `rotate(${totalAngle}deg)` : undefined,
        transformOrigin: `${wPivotX}px ${wPivotY}px`,
      }}
    />
  );
}
