/**
 * Icon registry — pulls SVGs from assets/icons/component (per-component icons)
 * and assets/icons/menu (Content Browser create-menu icons). Keyed by stem-name
 * (without ".svg") so e.g. "CharacterMovement.svg" → "CharacterMovement" and
 * "NewBlueprint.svg" → "NewBlueprint". Both folders share the same lookup
 * since names never collide.
 *
 * `<ComponentIcon kind="..." />` returns null when no matching SVG exists,
 * so callers can render it unconditionally and never see a broken image.
 */
import React from "react";

const COMPONENT_ICONS = import.meta.glob("./assets/icons/component/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const MENU_ICONS = import.meta.glob("./assets/icons/menu/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const KIND_TO_URL: Record<string, string> = {};
for (const path of Object.keys(COMPONENT_ICONS)) {
  const match = /([^/\\]+)\.svg$/.exec(path);
  if (match) KIND_TO_URL[match[1]] = COMPONENT_ICONS[path];
}
for (const path of Object.keys(MENU_ICONS)) {
  const match = /([^/\\]+)\.svg$/.exec(path);
  if (match) KIND_TO_URL[match[1]] = MENU_ICONS[path];
}

export function getComponentIconUrl(kind: string): string | undefined {
  return KIND_TO_URL[kind];
}

export function hasComponentIcon(kind: string): boolean {
  return !!KIND_TO_URL[kind];
}

export function ComponentIcon({
  kind,
  size = 14,
  style,
  title,
}: {
  kind: string;
  size?: number;
  style?: React.CSSProperties;
  title?: string;
}): JSX.Element | null {
  const url = KIND_TO_URL[kind];
  if (!url) return null;
  return (
    <img
      src={url}
      alt={kind}
      title={title ?? kind}
      width={size}
      height={size}
      draggable={false}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    />
  );
}
