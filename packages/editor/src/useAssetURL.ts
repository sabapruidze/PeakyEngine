import { useEffect, useState } from "react";
import { getActiveAssetStore, subscribeAssetStore } from "./AssetStore";

/**
 * React hook: given a project-relative asset path (e.g. "assets/Characters/Player/idle_0.png"),
 * returns a blob URL once the file is loaded, or undefined while pending /
 * when no folder project is open.
 *
 * Re-resolves when the active AssetStore swaps (open / new project), so a
 * component rendered before the project loaded still picks up the URL once
 * it's available.
 */
export function useAssetURL(path: string | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!path) { setUrl(undefined); return; }
    let cancelled = false;
    const resolve = () => {
      const store = getActiveAssetStore();
      if (!store) { setUrl(undefined); return; }
      void store.getBlobURL(path).then((u) => { if (!cancelled) setUrl(u || undefined); });
    };
    resolve();
    const unsub = subscribeAssetStore(resolve);
    return () => { cancelled = true; unsub(); };
  }, [path]);
  return url;
}

/**
 * Bulk variant — resolve N paths together. Returns a `Map<path, url>` once
 * every entry has loaded (or failed, in which case its value is undefined).
 * Cheaper than calling `useAssetURL` N times for components rendering grids
 * of sprites (Content Browser, Sprite tab).
 */
export function useAssetURLs(paths: ReadonlyArray<string | undefined>): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  // Stable key for the dep-array — paths is usually a fresh array each render
  // but its contents rarely change. Hashing avoids resolving on every render.
  const key = paths.filter(Boolean).join("|");
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const store = getActiveAssetStore();
      if (!store) { if (!cancelled) setUrls(new Map()); return; }
      const next = new Map<string, string>();
      await Promise.all(paths.filter((p): p is string => !!p).map(async (p) => {
        const u = await store.getBlobURL(p);
        if (u) next.set(p, u);
      }));
      if (!cancelled) setUrls(next);
    };
    void resolve();
    const unsub = subscribeAssetStore(() => void resolve());
    return () => { cancelled = true; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}
