import { spriteFrameDiskPath, soundDiskPath, tilesetImagePath } from "../AssetStore";
import { useAssetURL } from "../useAssetURL";
import type { SpriteAsset, SpriteFrame, SoundAsset, TilesetAsset } from "../project";
import type { CSSProperties } from "react";

/**
 * Render a sprite frame's image at the given size. Resolves the frame's
 * `imageFile` against the parent sprite's on-disk folder via AssetStore.
 * When the file hasn't loaded yet (or doesn't exist), shows a small
 * placeholder so the layout doesn't jump.
 *
 * Use this anywhere editor code used to render `<img src={frame.image}>`.
 */
export function FrameThumb({
  sprite, frame, alt = "", style, fallback,
}: {
  sprite: { path: string; name: string };
  frame: SpriteFrame | undefined;
  alt?: string;
  style?: CSSProperties;
  /** Custom placeholder while loading / when missing. Defaults to a blank box. */
  fallback?: React.ReactNode;
}) {
  const path = frame?.imageFile
    ? spriteFrameDiskPath(sprite, frame.imageFile)
    : undefined;
  const url = useAssetURL(path);
  if (!url) {
    return <>{fallback ?? <span style={style} />}</>;
  }
  return <img src={url} alt={alt} draggable={false} style={style} />;
}

/** Render a tileset's atlas image. */
export function TilesetThumb({
  tileset, alt = "", style, fallback,
}: {
  tileset: TilesetAsset | undefined;
  alt?: string;
  style?: CSSProperties;
  fallback?: React.ReactNode;
}) {
  const path = tileset?.imageFile ? tilesetImagePath(tileset) : undefined;
  const url = useAssetURL(path);
  if (!url) return <>{fallback ?? <span style={style} />}</>;
  return <img src={url} alt={alt} draggable={false} style={style} />;
}

/** Resolve a sprite frame to a URL for code that needs the raw string
 *  (e.g. CSS background-image, Phaser textures via runProject). Returns
 *  undefined while loading or when no AssetStore is active. */
export function useSpriteFrameURL(
  sprite: { path: string; name: string } | undefined,
  frame: SpriteFrame | undefined,
): string | undefined {
  const path = sprite && frame?.imageFile ? spriteFrameDiskPath(sprite, frame.imageFile) : undefined;
  return useAssetURL(path);
}

/** Resolve a tileset image URL. */
export function useTilesetURL(tileset: TilesetAsset | undefined): string | undefined {
  return useAssetURL(tileset?.imageFile ? tilesetImagePath(tileset) : undefined);
}

/** Resolve a sound file URL. */
export function useSoundURL(sound: SoundAsset | undefined): string | undefined {
  return useAssetURL(sound?.file ? soundDiskPath(sound) : undefined);
}
