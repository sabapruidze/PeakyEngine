import type { FontAsset } from "./project";
import { getActiveAssetStore, fontDiskPath } from "./AssetStore";

/** Font-family names already handed to the browser, so re-renders don't
 *  re-add the same FontFace every time the project changes. */
const _registered = new Set<string>();

/**
 * Load each project font into `document.fonts` under its `name`, so both CSS
 * (editor previews) and the Phaser canvas — which lives in the same document
 * during Play — can render text with it. The font-family string used at render
 * is exactly the asset's `name`.
 *
 * Folder mode: resolves each font file via AssetStore → blob URL → FontFace.
 * Skips fonts when no AssetStore is active (project not open). Idempotent —
 * a name already loaded is skipped.
 */
export function registerProjectFonts(fonts: FontAsset[] | undefined): void {
  if (!fonts || typeof document === "undefined" || !("fonts" in document)) return;
  const store = getActiveAssetStore();
  // Standalone exports have no AssetStore. They DO have a globally-injected
  // `__peakyAssetMap` keyed by disk path → data URL (set by the export
  // pipeline + the exported HTML). Walk both paths so this function works
  // identically in editor (folder mode) and in shipped games.
  const assetMap = (globalThis as Record<string, unknown>)["__peakyAssetMap"] as Record<string, string> | undefined;
  if (!store && !assetMap) return;
  for (const f of fonts) {
    if (!f.name || !f.file || _registered.has(f.name)) continue;
    _registered.add(f.name);
    const diskPath = fontDiskPath(f);
    const resolve = async (): Promise<string> => {
      // Prefer the inlined data URL when available — works on file:// AND
      // any HTTP host with zero fetch round-trips.
      const inlined = assetMap?.[diskPath];
      if (inlined) return inlined;
      if (store) {
        const url = await store.getBlobURL(diskPath);
        if (url) return url;
      }
      throw new Error(`font asset missing: ${f.name}`);
    };
    void resolve()
      .then((url) => {
        const face = new FontFace(f.name, `url(${url})`);
        return face.load().then((loaded) => { (document as Document).fonts.add(loaded); });
      })
      .catch(() => { _registered.delete(f.name); });
  }
}
