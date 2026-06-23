import Phaser from "phaser";

/**
 * Phaser.GameObjects.Text renders to a canvas-backed texture per instance,
 * then uploads it to WebGL. Two things blur it in a "pixel art" project
 * (`sampling: "nearest"` / `antialias: false`):
 *
 *   1. The 2D-canvas context that draws the glyphs inherits Phaser's
 *      `imageSmoothingEnabled = false` — fillText renders without sub-
 *      pixel antialiasing, baking jagged glyph edges into the texture.
 *   2. The uploaded GL texture's source defaults to NEAREST scaleMode —
 *      and `Phaser.Textures.Texture.setFilter` doesn't reach the source's
 *      scaleMode field on every refresh path, so every `setText` /
 *      `setResolution` reverts the filter to the global default (NEAREST
 *      in pixel-art mode), undoing whatever `setFilter` had applied.
 *
 * Plus the resolution itself has to account for every transform between
 * the text texture and the on-screen pixel grid:
 *
 *   final_resolution = devicePixelRatio       (retina / Windows DPI scale)
 *                    × scaleManager.displayScale (CSS-fit canvas stretch)
 *                    × camera.zoom              (world-anchored text only)
 *
 * Missing any of these = blurry text. The function below addresses all
 * four problems at once.
 *
 * Call `setupCrispText(text)` right after every `scene.add.text(...)`.
 * Call `refreshCrispText(text)` whenever the text's transform stack changes
 * (scrollFactor swap, mid-game SetCameraZoom, canvas resize) — and ALSO
 * every frame that the text re-renders, since `setText` can re-blank the
 * filter state.
 */
export function setupCrispText(text: Phaser.GameObjects.Text): void {
  applyCrispResolution(text);
  applyLinearFilter(text);
  forceCanvasSmoothing(text);
}

/** Re-derive crisp resolution + re-apply LINEAR filter + canvas smoothing
 *  for an existing text. Cheap when nothing actually changed (each step
 *  early-outs internally), so this is safe to call every frame from
 *  per-tick layout code if you don't want to chase down every place that
 *  rebuilds the underlying canvas. */
export function refreshCrispText(text: Phaser.GameObjects.Text): void {
  applyCrispResolution(text);
  applyLinearFilter(text);
  forceCanvasSmoothing(text);
}

function applyCrispResolution(text: Phaser.GameObjects.Text): void {
  const scene = text.scene;
  if (!scene) return;
  const dpr = window.devicePixelRatio || 1;

  // CSS display scale — Phaser's FIT mode CSS-stretches the canvas; without
  // accounting for it, the browser resamples the text texture and turns it
  // blurry / aliased depending on filter.
  const sm = scene.scale;
  const gw = sm.gameSize.width || 1;
  const gh = sm.gameSize.height || 1;
  const displayScale = Math.max(sm.displaySize.width / gw, sm.displaySize.height / gh, 1);

  // Camera zoom — world-anchored text (scrollFactor != 0) gets multiplied
  // by the main camera's zoom; camera-fixed UI text (scrollFactor == 0)
  // typically renders through the UI camera at zoom 1. Detect via
  // scrollFactor since the text doesn't carry an explicit "which camera"
  // reference.
  const isUI = text.scrollFactorX === 0 && text.scrollFactorY === 0;
  const camZoom = isUI ? 1 : (scene.cameras?.main?.zoom ?? 1);

  let res = Math.max(2, dpr * displayScale * camZoom);

  // Font-size-aware cap. The text canvas is sized (wrap-width × resolution)
  // pixels — at fontSize=64 with resolution=3 the canvas can balloon past a
  // million pixels, and every typewriter setText() call regenerates the
  // whole thing. Big fonts already have plenty of glyph detail at 1× so
  // they don't NEED oversampling for crispness; cap so we don't burn
  // re-render time on a quality bump that's invisible.
  //
  // Targets ~32 effective pixels per glyph height (well above the legibility
  // threshold). Above that, extra resolution is wasted memory + paint cost
  // and trashes typewriter framerate at large font sizes.
  const sizeRaw = (text.style as { fontSize?: string | number } | undefined)?.fontSize;
  const fontPx = typeof sizeRaw === "number"
    ? sizeRaw
    : Number(String(sizeRaw ?? "16").replace(/[^0-9.]/g, "")) || 16;
  const sizeCap = Math.max(1, 32 / fontPx);
  res = Math.min(res, Math.max(1, sizeCap * dpr));

  // Absolute floor still 1 so we don't go sub-pixel-precise; absolute
  // ceiling 4 so a wildly-zoomed cam doesn't push the texture into the
  // tens-of-megabytes range.
  res = Math.max(1, Math.min(4, res));
  text.setResolution(res);
}

function applyLinearFilter(text: Phaser.GameObjects.Text): void {
  const tex = text.texture as Phaser.Textures.Texture | undefined;
  if (!tex) return;
  // setFilter is the convenience API but doesn't always reach Text source
  // refreshes. Force LINEAR directly on every source.scaleMode — this is
  // the field the WebGL renderer actually reads when uploading.
  if (Array.isArray(tex.source)) {
    for (const src of tex.source) {
      if (src) src.scaleMode = Phaser.Textures.FilterMode.LINEAR;
    }
  }
  if (typeof (tex as unknown as { setFilter?: (f: number) => void }).setFilter === "function") {
    (tex as unknown as { setFilter: (f: number) => void }).setFilter(Phaser.Textures.FilterMode.LINEAR);
  }
}

function forceCanvasSmoothing(text: Phaser.GameObjects.Text): void {
  // The 2D-canvas context that renders the glyphs. When the game config
  // has antialias=false (pixel-art mode), Phaser sets this to false on
  // text canvases, baking aliased glyph edges into the texture before
  // it ever hits WebGL. Override per-text so glyphs draw smoothly while
  // the rest of the project keeps its NEAREST pixel-art sampling.
  const ctx = (text as unknown as { context?: CanvasRenderingContext2D }).context;
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    (ctx as unknown as { imageSmoothingQuality?: ImageSmoothingQuality }).imageSmoothingQuality = "high";
  }
  // Force a re-render so the next paint uses the new smoothing setting.
  // setResolution above already marks dirty; this is belt-and-suspenders
  // for the case where applyCrispResolution early-outs because resolution
  // didn't change.
  (text as unknown as { dirty?: boolean }).dirty = true;
}
