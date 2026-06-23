import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor, normalizeFolderPath } from "../store";
import { BlueprintDef, SceneData, SpriteAsset, ItemProp, RecipeInput, itemCountGlobalName } from "../project";
import { NewBlueprintPicker } from "./NewBlueprintPicker";
import { CLASSES, buildClassPartial } from "../blueprintClasses";
import { FrameThumb, useSoundURL } from "../components/FrameThumb";
import { spriteFrameDiskPath, tilesetImagePath, soundDiskPath, writeAssetFromDataURL } from "../AssetStore";
import { useAssetURL } from "../useAssetURL";
import { ComponentIcon } from "../componentIcons";

// ─── icons ───────────────────────────────────────────────────────────────────

const FolderIcon = ({ open = false }: { open?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={open ? "var(--yellow)" : "var(--text-dim)"} stroke="none" style={{ flexShrink: 0 }}>
    <path d="M4 5h6l2 3h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
  </svg>
);

const BlueprintIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6" r="2" />
    <circle cx="18" cy="6" r="2" />
    <circle cx="12" cy="18" r="2" />
    <path d="M8 7l3 9M16 7l-3 9" />
  </svg>
);

const SceneIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M7 6V4M11 6V4M15 6V4M19 6V4" />
  </svg>
);

// ─── types ───────────────────────────────────────────────────────────────────

type AssetKind = "blueprint" | "scene" | "sprite" | "dialogue" | "uiwidget" | "sound" | "item" | "recipe" | "tileset" | "tilemap";

interface Asset {
  kind: AssetKind;
  id: string;
  name: string;
  path: string;
  /** Preview swatch colour: BP = its display colour; sprite = first frame's colour. */
  color?: number;
  /** Thumbnail asset path (project-relative) — first frame of the first
   *  animation for sprite/BP/item/recipe tiles, or the atlas image for
   *  tilesets. The tile component resolves this to a blob URL via AssetStore
   *  at render time. Wins over `color` in the tile when present. */
  imagePath?: string;
  /** Sound assets only: music vs sfx — drives the corner badge label. */
  soundKind?: "music" | "sfx";
  /** Soft-deleted: filtered from the grid unless "Show Hidden" is on. */
  hidden?: boolean;
}

interface ContextMenuItem {
  label: string;
  /** Omitted on a pure submenu parent (the submenu rows carry the actions). */
  action?: () => void;
  danger?: boolean;
  /** When present, this row is a parent that opens a nested flyout on hover. */
  submenu?: ContextMenuItem[];
  /** Icon kind from /files2 — e.g. "NewBlueprint" → /files2/NewBlueprint.svg. */
  icon?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

// ─── folder tree helpers ──────────────────────────────────────────────────────

/** Returns the immediate children of `parentPath` from a flat folder list. */
function childFolders(folders: string[], parentPath: string): string[] {
  const prefix = parentPath === "/" ? "/" : parentPath + "/";
  return folders.filter((f) => {
    if (!f.startsWith(prefix)) return false;
    const rest = f.slice(prefix.length);
    return rest.length > 0 && !rest.includes("/");
  });
}

/** Display name: last segment of path. */
function folderName(path: string): string {
  if (path === "/") return "Content";
  return path.slice(path.lastIndexOf("/") + 1);
}

// ─── context-menu ────────────────────────────────────────────────────────────

const MENU_BG = "var(--panel-2)";
const menuRowStyle = (danger?: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "5px 14px",
  cursor: "crosshair",
  fontSize: 12,
  color: danger ? "var(--danger)" : "var(--text)",
});

function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Index of the row whose submenu flyout is open. Driven by hover.
  const [openSub, setOpenSub] = useState<number | null>(null);
  // Screen rect of the row that owns the open submenu — the flyout is
  // positioned `fixed` against it so it ESCAPES the parent menu's
  // `overflowY: auto` clip (which otherwise crops the Move-to folder list).
  const [subRect, setSubRect] = useState<DOMRect | null>(null);
  // Final on-screen position after edge-flipping. Starts at the raw cursor
  // coords; useLayoutEffect adjusts after measurement so a menu that would
  // overflow the bottom (or right) of the viewport opens upward / leftward.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);

  // After the menu mounts (or its items change), measure and flip if it
  // would overflow the viewport. Margin keeps the menu a few pixels off
  // the edge instead of flush against it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const MARGIN = 6;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = menu.x;
    let top = menu.y;
    if (top + rect.height + MARGIN > vh) {
      // Not enough room below → open upward. Anchor bottom of menu to
      // cursor. If even that overflows the top, clamp to MARGIN so the
      // menu is fully visible (truncation by viewport is fine; the menu
      // already supports its own scroll on tall lists).
      top = Math.max(MARGIN, menu.y - rect.height);
    }
    if (left + rect.width + MARGIN > vw) {
      left = Math.max(MARGIN, menu.x - rect.width);
    }
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
  }, [menu.x, menu.y, menu.items, pos.left, pos.top]);

  // Flip the flyout to the left when the menu is near the right screen edge
  // so a long folder list doesn't get clipped off-screen.
  const flyoutLeft = pos.left > window.innerWidth - 360;

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        maxHeight: `calc(100vh - 12px)`,
        overflowY: "auto",
        background: MENU_BG,
        border: "1px solid var(--border)",
        borderRadius: 4,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        zIndex: 2000,
        minWidth: 160,
        padding: "4px 0",
      }}
    >
      {menu.items.map((item, i) => {
        const hasSub = !!item.submenu && item.submenu.length > 0;
        return (
          <div
            key={i}
            onClick={() => { if (!hasSub && item.action) { item.action(); onClose(); } }}
            style={{ ...menuRowStyle(item.danger), position: "relative" }}
            // Moving the cursor into the flyout (a DOM descendant of this row)
            // does NOT fire mouseLeave, so the parent stays highlighted and the
            // submenu stays open while the user reaches into it.
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = "var(--panel)";
              if (hasSub) {
                setOpenSub(i);
                setSubRect((e.currentTarget as HTMLElement).getBoundingClientRect());
              } else {
                setOpenSub(null);
              }
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {item.icon && <ComponentIcon kind={item.icon} size={14} />}
              {item.label}
            </span>
            {hasSub && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>›</span>}
            {hasSub && openSub === i && subRect && (
              <div
                style={{
                  position: "fixed",
                  // Anchor to the row's screen rect so the parent menu's overflow
                  // clip can't crop us. Clamp the top so a flyout near the bottom
                  // edge stays fully on-screen; flip to the left side near the
                  // right edge of the viewport.
                  top: Math.max(6, Math.min(subRect.top - 5, window.innerHeight - 326)),
                  ...(flyoutLeft
                    ? { right: window.innerWidth - subRect.left }
                    : { left: subRect.right }),
                  background: MENU_BG,
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                  minWidth: 160,
                  maxHeight: 320,
                  overflowY: "auto",
                  zIndex: 2001,
                  padding: "4px 0",
                }}
              >
                {item.submenu!.map((sub, j) => (
                  <div
                    key={j}
                    onClick={(e) => { e.stopPropagation(); sub.action?.(); onClose(); }}
                    style={menuRowStyle(sub.danger)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--panel)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
                  >
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {sub.icon && <ComponentIcon kind={sub.icon} size={14} />}
                      {sub.label}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── folder-name inline editor ────────────────────────────────────────────────

function FolderNameEditor({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (val: string) => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => onDone(val)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(val);
        if (e.key === "Escape") onDone(initial);
        e.stopPropagation();
      }}
      style={{
        fontSize: 12,
        padding: "1px 4px",
        height: 20,
        width: "100%",
        background: "var(--bg)",
        border: "1px solid var(--accent)",
        borderRadius: 2,
        color: "var(--text)",
      }}
      autoFocus
    />
  );
}

// ─── FolderTree ───────────────────────────────────────────────────────────────

function FolderNode({
  path,
  depth,
  selectedPath,
  onSelect,
  onContextMenu,
  folders,
}: {
  path: string;
  depth: number;
  selectedPath: string;
  onSelect: (p: string) => void;
  onContextMenu: (e: React.MouseEvent, p: string) => void;
  folders: string[];
}) {
  const [open, setOpen] = useState(true);
  const children = childFolders(folders, path);
  const isSelected = path === selectedPath;

  return (
    <div>
      <div
        onClick={() => { onSelect(path); }}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, path); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `4px 10px 4px ${10 + depth * 14}px`,
          margin: "1px 6px",
          borderRadius: 8,
          cursor: "crosshair",
          background: isSelected ? "var(--inner-hi)" : "transparent",
          fontSize: 12,
          userSelect: "none",
          color: isSelected ? "var(--text)" : "var(--text-2)",
        }}
        onMouseEnter={(e) => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.background = "var(--inner)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) (e.currentTarget as HTMLElement).style.background = "";
        }}
      >
        {children.length > 0 && (
          <span
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            style={{ fontSize: 9, color: "var(--text-dim)", width: 10, flexShrink: 0 }}
          >
            {open ? "▼" : "▶"}
          </span>
        )}
        {children.length === 0 && <span style={{ width: 10, flexShrink: 0 }} />}
        <FolderIcon open={open && children.length > 0} />
        <span style={{ color: isSelected ? "var(--text)" : "var(--text-2)" }}>
          {folderName(path)}
        </span>
      </div>
      {open && children.map((child) => (
        <FolderNode
          key={child}
          path={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          folders={folders}
        />
      ))}
    </div>
  );
}

// ─── AssetTile ────────────────────────────────────────────────────────────────

const SpriteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </svg>
);

const DialogueIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
);

const UIWidgetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);

const SoundIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);
const ItemIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
  </svg>
);

const RecipeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h7M4 12h7M4 17h7" />
    <path d="M15 12h5M17.5 9.5 20 12l-2.5 2.5" />
  </svg>
);

const ASSET_ICON_NODES: Record<AssetKind, React.ReactNode> = {
  blueprint: <BlueprintIcon />,
  scene: <SceneIcon />,
  sprite: <SpriteIcon />,
  dialogue: <DialogueIcon />,
  uiwidget: <UIWidgetIcon />,
  sound: <SoundIcon />,
  item: <ItemIcon />,
  recipe: <RecipeIcon />,
  tileset: <SpriteIcon />,
  tilemap: <SceneIcon />,
};
const ASSET_ICON_TINTS: Record<AssetKind, string> = {
  blueprint: "var(--yellow)",
  scene: "var(--purple)",
  sprite: "var(--pink)",
  dialogue: "var(--teal)",
  uiwidget: "var(--orange)",
  sound: "var(--green)",
  item: "var(--blue)",
  recipe: "var(--orange)",
  tileset: "#7eb37e",
  tilemap: "#7eb37e",
};
/** Per-kind stroke color for the thumbnail tile border. Each kind gets a
 *  distinct hue so an unsorted Content Browser folder can be triaged by
 *  type at a glance. Colors use the design tokens so they track the
 *  theme palette. */
const ASSET_STROKE: Record<AssetKind, string> = {
  blueprint: "var(--blue)",
  sprite: "var(--red)",
  scene: "var(--green)",
  dialogue: "var(--teal)",
  uiwidget: "var(--orange)",
  sound: "var(--purple)",
  item: "var(--blue)",
  recipe: "var(--orange)",
  tileset: "#7eb37e",
  tilemap: "#5a8a5a",
};

function AssetTile({
  asset,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
}: {
  asset: Asset;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  // Resolve the thumbnail path to a blob URL. Returns undefined while loading
  // or when no project is open — the kind icon shows instead.
  const imageUrl = useAssetURL(asset.imagePath);
  return (
    <div
      draggable
      onClick={(e) => onClick(e)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e); }}
      onDragStart={onDragStart}
      title={asset.name}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: "8px 6px 6px",
        borderRadius: 12,
        outline: selected ? "1.5px solid var(--yellow)" : "none",
        background: selected ? "var(--inner)" : "transparent",
        cursor: "crosshair",
        userSelect: "none",
        width: 92,
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--inner)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "";
      }}
    >
      {/* Thumbnail card — image (first frame of first anim) wins when
          available; otherwise fall back to the color swatch + icon. The
          stroke color is per-kind so authors can scan by type at a glance
          (BPs blue, sprites red, scenes green, etc.). */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          border: `2px solid ${ASSET_STROKE[asset.kind]}`,
          background: imageUrl
            ? "var(--inner)"
            : (asset.kind === "blueprint" || asset.kind === "sprite") && asset.color !== undefined
              ? `#${asset.color.toString(16).padStart(6, "0")}`
              : "var(--inner)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: ASSET_ICON_TINTS[asset.kind],
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Kind badge — small icon in the top-right corner so authors can
            scan an unsorted grid by type at a glance. Drawn over the
            thumbnail with a translucent dark backdrop for legibility. */}
        <div
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            width: 14,
            height: 14,
            borderRadius: 3,
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            fontSize: 8,
            fontWeight: 700,
            letterSpacing: 0.3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
          title={asset.kind}
        >
          {asset.kind === "blueprint" ? "BP"
            : asset.kind === "sprite" ? "SP"
            : asset.kind === "scene" ? "SC"
            : asset.kind === "dialogue" ? "DL"
            : asset.kind === "sound" ? (asset.soundKind === "music" ? "MUS" : "SFX")
            : asset.kind === "item" ? "IT"
            : asset.kind === "recipe" ? "RE"
            : asset.kind === "tileset" ? "TS"
            : asset.kind === "tilemap" ? "TM"
            : "UI"}
        </div>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              imageRendering: "pixelated",
            }}
          />
        ) : (
          <>
            {asset.kind === "scene" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "sound" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "item" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "recipe" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "tileset" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "tilemap" && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "sprite" && asset.color === undefined && ASSET_ICON_NODES[asset.kind]}
            {asset.kind === "blueprint" && (
              <div
                style={{
                  width: 18,
                  height: 18,
                  background: "rgba(0,0,0,0.25)",
                  borderRadius: 4,
                }}
              />
            )}
          </>
        )}
      </div>
      <span
        style={{
          fontSize: 11,
          color: "var(--text)",
          textAlign: "center",
          wordBreak: "break-word",
          maxWidth: 80,
          lineHeight: 1.3,
        }}
      >
        {asset.name}
      </span>
    </div>
  );
}

// ─── FolderTile ───────────────────────────────────────────────────────────────
// A navigable folder shown IN the asset grid (alongside asset tiles) so the
// subfolders of the current folder are visible without using the left tree.
// Double-click opens (descends into) the folder; right-click opens the same
// folder context menu as the tree.
function FolderTile({
  name,
  selected,
  onClick,
  onOpen,
  onContextMenu,
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      // stopPropagation on click + context menu so the grid's own handlers
      // (clear-selection / grid context menu) don't fire and override the
      // folder's selection / Delete Folder menu.
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => { e.stopPropagation(); onOpen(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}
      title={name}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
        padding: "8px 6px 6px", borderRadius: 12, cursor: "crosshair",
        outline: selected ? "1.5px solid var(--yellow)" : "none",
        background: selected ? "var(--inner)" : "transparent",
        userSelect: "none", width: 92,
      }}
      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--inner)"; }}
      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLElement).style.background = ""; }}
    >
      <div style={{
        width: 56, height: 56, borderRadius: 12,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, color: "var(--yellow)",
      }}>
        <svg width="44" height="44" viewBox="0 0 24 24" fill="var(--yellow)" stroke="none">
          <path d="M4 5h6l2 3h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
        </svg>
      </div>
      <span style={{
        fontSize: 11, color: "var(--text)", textAlign: "center",
        wordBreak: "break-word", maxWidth: 80, lineHeight: 1.3,
      }}>{name}</span>
    </div>
  );
}

// ─── SoundInspector ─────────────────────────────────────────────────────────
// Modal popover for editing a sound asset's kind / volume / loop, plus a
// preview play/stop. Lives here (not a full tab) because the surface is tiny
// and self-contained. Preview uses a plain HTMLAudioElement off the data URL.

function SoundInspector({ soundId, onClose }: { soundId: string; onClose: () => void }) {
  const sound = useEditor((s) => (s.project.sounds ?? []).find((x) => x.id === soundId));
  const setSoundKind = useEditor((s) => s.setSoundKind);
  const setSoundVolume = useEditor((s) => s.setSoundVolume);
  const setSoundLoop = useEditor((s) => s.setSoundLoop);
  const setSoundMaxInstances = useEditor((s) => s.setSoundMaxInstances);
  const setSoundMinInterval = useEditor((s) => s.setSoundMinInterval);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Resolve the on-disk audio to a blob URL (or undefined until loaded).
  const soundUrl = useSoundURL(sound);

  // Stop + release the preview element on unmount so audio never outlives
  // the dialog.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) { a.pause(); audioRef.current = null; }
    };
  }, []);

  if (!sound) return null;

  const stopPreview = () => {
    const a = audioRef.current;
    if (a) { a.pause(); a.currentTime = 0; }
    setPlaying(false);
  };
  const togglePreview = () => {
    if (playing) { stopPreview(); return; }
    if (!soundUrl) return; // file still loading or missing
    let a = audioRef.current;
    if (!a) {
      a = new Audio(soundUrl);
      a.onended = () => setPlaying(false);
      audioRef.current = a;
    }
    a.loop = false; // preview always plays once, regardless of asset loop
    a.volume = Math.max(0, Math.min(1, sound.volume));
    void a.play();
    setPlaying(true);
  };

  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-2)", display: "block", marginBottom: 4 };
  const segBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 600, cursor: "pointer",
    background: active ? "var(--accent)" : "var(--inner)",
    color: active ? "#fff" : "var(--text-2)",
    border: "1px solid var(--border)", borderRadius: 6,
  });

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 320, background: "var(--panel-2)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", padding: 18,
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--green)", display: "flex" }}><SoundIcon /></span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1, wordBreak: "break-word" }}>
            {sound.name}
          </span>
        </div>

        <div>
          <span style={labelStyle}>Type</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={segBtn(sound.kind === "music")} onClick={() => setSoundKind(sound.id, "music")}>Music</button>
            <button style={segBtn(sound.kind === "sfx")} onClick={() => setSoundKind(sound.id, "sfx")}>SFX</button>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
            {sound.kind === "music"
              ? "Music plays on the music bus — a new track replaces the current one."
              : "SFX play on the sfx bus — overlapping instances are allowed."}
          </div>
        </div>

        <div>
          <span style={labelStyle}>Base volume — {(sound.volume * 100).toFixed(0)}%</span>
          <input
            type="range" min={0} max={1} step={0.01} value={sound.volume}
            onChange={(e) => setSoundVolume(sound.id, Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-2)", cursor: "pointer" }}>
          <Toggle value={sound.loop} onChange={(v) => setSoundLoop(sound.id, v)} />
          Loop by default
        </label>

        {/* Voice limiting — only meaningful for overlapping SFX. Tames "many
            enemies, one hit sound" clipping + machine-gun phasing. */}
        {sound.kind === "sfx" && (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <span style={labelStyle} title="Max copies playing at once (0 = unlimited). Beyond it, the oldest is cut.">Max at once</span>
              <input
                type="number" min={0} step={1} value={sound.maxInstances ?? 0}
                onChange={(e) => setSoundMaxInstances(sound.id, Number(e.target.value))}
                style={{ width: "100%", fontSize: 12, padding: "4px 6px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
              />
              <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 2 }}>0 = unlimited</div>
            </div>
            <div style={{ flex: 1 }}>
              <span style={labelStyle} title="Minimum ms between retriggers — a burst within this window collapses to one play.">Min gap (ms)</span>
              <input
                type="number" min={0} step={5} value={sound.minIntervalMs ?? 0}
                onChange={(e) => setSoundMinInterval(sound.id, Number(e.target.value))}
                style={{ width: "100%", fontSize: 12, padding: "4px 6px", background: "var(--inner)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)" }}
              />
              <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 2 }}>0 = no throttle</div>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={togglePreview}
            style={{
              flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: playing ? "var(--danger)" : "var(--accent)", color: "#fff",
              border: "none", borderRadius: 6,
            }}
          >
            {playing ? "■ Stop" : "▶ Preview"}
          </button>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px", fontSize: 12, cursor: "pointer",
              background: "var(--inner)", color: "var(--text-2)",
              border: "1px solid var(--border)", borderRadius: 6,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ItemInspector ───────────────────────────────────────────────────────────
// Modal popover for editing an inventory Item asset: name, icon (an existing
// sprite), max stack, tags. Tiny + self-contained, same pattern as SoundInspector.

function ItemInspector({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const item = useEditor((s) => (s.project.items ?? []).find((x) => x.id === itemId));
  const sprites = useEditor((s) => s.project.sprites);
  const renameItem = useEditor((s) => s.renameItem);
  const setItemIcon = useEditor((s) => s.setItemIcon);
  const setItemIconAnim = useEditor((s) => s.setItemIconAnim);
  const setItemIconFrame = useEditor((s) => s.setItemIconFrame);
  const setItemMaxStack = useEditor((s) => s.setItemMaxStack);
  const setItemTags = useEditor((s) => s.setItemTags);
  const setItemProps = useEditor((s) => s.setItemProps);
  const setItemCountGlobal = useEditor((s) => s.setItemCountGlobal);
  const setItemBuyPrice = useEditor((s) => s.setItemBuyPrice);
  const setItemSellPrice = useEditor((s) => s.setItemSellPrice);

  if (!item) return null;

  const sprite = sprites.find((s) => s.id === item.spriteId);
  const anim = sprite?.animations.find((a) => a.id === item.iconAnim) ?? sprite?.animations[0];
  const animated = item.iconFrame === -1;
  const frameIdx = animated ? 0 : Math.max(0, item.iconFrame ?? 0);
  const iconFrame = anim?.frames[frameIdx] ?? anim?.frames[0];
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-2)", display: "block", marginBottom: 4 };
  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 8px", fontSize: 12, background: "var(--inner)",
    color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6,
  };

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 320, background: "var(--panel-2)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", padding: 18,
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--blue)", display: "flex" }}><ItemIcon /></span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1, wordBreak: "break-word" }}>
            {item.name}
          </span>
          {sprite && iconFrame && (
            <FrameThumb sprite={sprite} frame={iconFrame} style={{ width: 28, height: 28, objectFit: "contain", imageRendering: "pixelated", background: "rgba(0,0,0,0.25)", borderRadius: 4 }} />
          )}
        </div>

        <div>
          <span style={labelStyle}>Name</span>
          <input style={fieldStyle} value={item.name} onChange={(e) => renameItem(item.id, e.target.value)} />
        </div>

        <div>
          <span style={labelStyle}>Icon (sprite)</span>
          <select style={fieldStyle} value={item.spriteId} onChange={(e) => setItemIcon(item.id, e.target.value)}>
            <option value="">— no icon —</option>
            {sprites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {sprite && (sprite.animations.length > 0) && (
          <div>
            <span style={labelStyle}>Icon animation</span>
            <select
              style={fieldStyle}
              value={anim?.id ?? ""}
              onChange={(e) => setItemIconAnim(item.id, e.target.value)}
            >
              {sprite.animations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        {anim && (
          <div>
            <span style={labelStyle}>Icon source</span>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button
                onClick={() => setItemIconFrame(item.id, animated ? 0 : frameIdx)}
                style={{
                  flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6,
                  background: !animated ? "var(--accent)" : "var(--inner)", color: !animated ? "#fff" : "var(--text-2)",
                  border: "1px solid var(--border)",
                }}
              >Static frame</button>
              <button
                onClick={() => setItemIconFrame(item.id, -1)}
                style={{
                  flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6,
                  background: animated ? "var(--accent)" : "var(--inner)", color: animated ? "#fff" : "var(--text-2)",
                  border: "1px solid var(--border)",
                }}
                title="Play the whole animation as an animated icon."
              >Animate</button>
            </div>
            {!animated && (
              <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 4 }}>
                {anim.frames.map((f, i) => (
                  <button
                    key={f.id}
                    onClick={() => setItemIconFrame(item.id, i)}
                    title={`Frame ${i}`}
                    style={{
                      flex: "0 0 auto", width: 40, height: 40, padding: 2, cursor: "pointer",
                      background: "rgba(0,0,0,0.25)", borderRadius: 4,
                      border: i === frameIdx ? "2px solid var(--accent)" : "1px solid var(--border)",
                    }}
                  >
                    {sprite && (
                      <FrameThumb
                        sprite={sprite}
                        frame={f}
                        style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
                        fallback={<span style={{ fontSize: 9, color: "var(--text-dim)" }}>{i}</span>}
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <span style={labelStyle}>Max stack</span>
          <input
            type="number" min={1} style={fieldStyle} value={item.maxStack}
            onChange={(e) => setItemMaxStack(item.id, Number(e.target.value))}
          />
        </div>

        <div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text)" }}>
            <Toggle
              value={!!item.countGlobal}
              onChange={(v) => setItemCountGlobal(item.id, v ? itemCountGlobalName(item.name) : "")}
            />
            Track how many the player owns
          </label>
          {item.countGlobal ? (
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
              Owned count lives in <code>global:{item.countGlobal}</code> (read it anywhere). Give Item / shop / pickups update it.
            </span>
          ) : (
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
              Off = this item isn&apos;t counted (no bag tracking).
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Buy price (0 = can't buy)</span>
            <input
              type="number" min={0} style={fieldStyle} value={item.buyPrice ?? 0}
              onChange={(e) => setItemBuyPrice(item.id, Number(e.target.value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Sell price (0 = can't sell)</span>
            <input
              type="number" min={0} style={fieldStyle} value={item.sellPrice ?? 0}
              onChange={(e) => setItemSellPrice(item.id, Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <span style={labelStyle}>Tags (comma-separated)</span>
          <input
            style={fieldStyle}
            value={(item.tags ?? []).join(", ")}
            onChange={(e) => setItemTags(item.id, e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
          />
        </div>

        <div>
          <span style={labelStyle}>Custom properties (read in logic via Get Item Property)</span>
          {(item.props ?? []).map((p, i) => {
            const props = item.props ?? [];
            const setAt = (patch: Partial<ItemProp>) =>
              setItemProps(item.id, props.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
            return (
              <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
                <input
                  style={{ ...fieldStyle, flex: 1 }}
                  placeholder="key"
                  value={p.key}
                  onChange={(e) => setAt({ key: e.target.value })}
                />
                <select
                  style={{ ...fieldStyle, width: 70, flex: "0 0 auto" }}
                  value={p.type}
                  onChange={(e) => {
                    const t = e.target.value as ItemProp["type"];
                    setAt({ type: t, value: t === "number" ? 0 : t === "bool" ? false : "" });
                  }}
                >
                  <option value="number">num</option>
                  <option value="string">text</option>
                  <option value="bool">bool</option>
                </select>
                {p.type === "bool" ? (
                  <Toggle
                    value={!!p.value}
                    onChange={(v) => setAt({ value: v })}
                    style={{ width: "auto", flex: "0 0 auto" }}
                  />
                ) : (
                  <input
                    style={{ ...fieldStyle, width: 80, flex: "0 0 auto" }}
                    type={p.type === "number" ? "number" : "text"}
                    value={String(p.value)}
                    onChange={(e) => setAt({ value: p.type === "number" ? Number(e.target.value) : e.target.value })}
                  />
                )}
                <button
                  onClick={() => setItemProps(item.id, props.filter((_, idx) => idx !== i))}
                  title="Remove property"
                  style={{ flex: "0 0 auto", padding: "4px 8px", cursor: "pointer", background: "var(--inner)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 6 }}
                >×</button>
              </div>
            );
          })}
          <button
            onClick={() => setItemProps(item.id, [...(item.props ?? []), { key: "", type: "number", value: 0 }])}
            style={{ padding: "5px 10px", fontSize: 11, cursor: "pointer", background: "var(--inner)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 6 }}
          >+ Add property</button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: "var(--accent)", color: "#fff",
              border: "none", borderRadius: 6,
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RecipeInspector ──────────────────────────────────────────────────────────
// Modal popover for editing a crafting Recipe: name, input items + quantities,
// and the output item + quantity. Items are referenced by NAME.

function RecipeInspector({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const recipe = useEditor((s) => (s.project.recipes ?? []).find((x) => x.id === recipeId));
  const items = useEditor((s) => s.project.items ?? []);
  const sprites = useEditor((s) => s.project.sprites);
  const renameRecipe = useEditor((s) => s.renameRecipe);
  const setRecipeInputs = useEditor((s) => s.setRecipeInputs);
  const setRecipeOutput = useEditor((s) => s.setRecipeOutput);
  const setRecipeEnabled = useEditor((s) => s.setRecipeEnabled);

  if (!recipe) return null;

  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-2)", display: "block", marginBottom: 4 };
  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 8px", fontSize: 12, background: "var(--inner)",
    color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6,
  };
  // Resolve an item's icon (sprite + frame) for FrameThumb rendering.
  const iconOf = (name: string): { sprite: SpriteAsset; frame: typeof sprites[0]["animations"][0]["frames"][0] } | undefined => {
    const it = items.find((x) => x.name === name);
    if (!it) return undefined;
    const sp = sprites.find((s) => s.id === it.spriteId);
    const anim = sp?.animations.find((a) => a.id === it.iconAnim) ?? sp?.animations[0];
    const idx = it.iconFrame === -1 ? 0 : Math.max(0, it.iconFrame ?? 0);
    const frame = anim?.frames[idx] ?? anim?.frames[0];
    if (!sp || !frame) return undefined;
    return { sprite: sp, frame };
  };
  const inputs = recipe.inputs ?? [];
  const setInputAt = (i: number, patch: Partial<RecipeInput>) =>
    setRecipeInputs(recipe.id, inputs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  const outIcon = iconOf(recipe.outputItem);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 340, background: "var(--panel-2)", border: "1px solid var(--border)",
          borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.6)", padding: 18,
          display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--orange)", display: "flex" }}><RecipeIcon /></span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1, wordBreak: "break-word" }}>
            {recipe.name}
          </span>
          {outIcon && (
            <FrameThumb sprite={outIcon.sprite} frame={outIcon.frame} style={{ width: 28, height: 28, objectFit: "contain", imageRendering: "pixelated", background: "rgba(0,0,0,0.25)", borderRadius: 4 }} />
          )}
        </div>

        <div>
          <span style={labelStyle}>Name</span>
          <input style={fieldStyle} value={recipe.name} onChange={(e) => renameRecipe(recipe.id, e.target.value)} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle
            id={`recipe-enabled-${recipe.id}`}
            value={recipe.enabled !== false}
            onChange={(v) => setRecipeEnabled(recipe.id, v)}
          />
          <label
            htmlFor={`recipe-enabled-${recipe.id}`}
            style={{ fontSize: 12, color: "var(--text)", cursor: "pointer" }}
            title="When off, the crafting system skips this recipe — useful for locked / quest-gated recipes that should default to disabled and be enabled later by a SetRecipeEnabled action."
          >Enabled (default)</label>
        </div>

        <div>
          <span style={labelStyle}>Inputs (consumed when crafted)</span>
          {inputs.map((inp, i) => (
            <div key={i} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
              <select style={{ ...fieldStyle, flex: 1 }} value={inp.item} onChange={(e) => setInputAt(i, { item: e.target.value })}>
                <option value="">— item —</option>
                {items.map((it) => <option key={it.id} value={it.name}>{it.name}</option>)}
              </select>
              <input
                style={{ ...fieldStyle, width: 60, flex: "0 0 auto" }}
                type="number" min={1} value={inp.qty}
                onChange={(e) => setInputAt(i, { qty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              />
              <button
                onClick={() => setRecipeInputs(recipe.id, inputs.filter((_, idx) => idx !== i))}
                title="Remove input"
                style={{ flex: "0 0 auto", padding: "4px 8px", cursor: "pointer", background: "var(--inner)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 6 }}
              >×</button>
            </div>
          ))}
          <button
            onClick={() => setRecipeInputs(recipe.id, [...inputs, { item: "", qty: 1 }])}
            style={{ padding: "5px 10px", fontSize: 11, cursor: "pointer", background: "var(--inner)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 6 }}
          >+ Add input</button>
        </div>

        <div>
          <span style={labelStyle}>Output</span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select style={{ ...fieldStyle, flex: 1 }} value={recipe.outputItem} onChange={(e) => setRecipeOutput(recipe.id, e.target.value, recipe.outputQty)}>
              <option value="">— item —</option>
              {items.map((it) => <option key={it.id} value={it.name}>{it.name}</option>)}
            </select>
            <input
              style={{ ...fieldStyle, width: 60, flex: "0 0 auto" }}
              type="number" min={1} value={recipe.outputQty}
              onChange={(e) => setRecipeOutput(recipe.id, recipe.outputItem, Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: "var(--accent)", color: "#fff",
              border: "none", borderRadius: 6,
            }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ContentBrowser ───────────────────────────────────────────────────────────

const CB_STORAGE_KEY = "peaky.cb-folder-width";
const MIN_FOLDER_W = 140;
const MAX_FOLDER_W = 400;

export function ContentBrowser() {
  const project = useEditor((s) => s.project);
  const openBlueprintTab = useEditor((s) => s.openBlueprintTab);
  const setActiveScene = useEditor((s) => s.setActiveScene);
  const addBlueprint = useEditor((s) => s.addBlueprint);
  const addScene = useEditor((s) => s.addScene);
  const addSprite = useEditor((s) => s.addSprite);
  const addSpriteFrame = useEditor((s) => s.addSpriteFrame);
  const setSpriteSize = useEditor((s) => s.setSpriteSize);
  const duplicateAsset = useEditor((s) => s.duplicateAsset);
  const removeBlueprint = useEditor((s) => s.removeBlueprint);
  const removeScene = useEditor((s) => s.removeScene);
  const renameScene = useEditor((s) => s.renameScene);
  const renameSprite = useEditor((s) => s.renameSprite);
  const removeSprite = useEditor((s) => s.removeSprite);
  const setSpritePath = useEditor((s) => s.setSpritePath);
  const openSpriteTab = useEditor((s) => s.openSpriteTab);
  const addDialogue = useEditor((s) => s.addDialogue);
  const renameDialogue = useEditor((s) => s.renameDialogue);
  const removeDialogue = useEditor((s) => s.removeDialogue);
  const setDialoguePath = useEditor((s) => s.setDialoguePath);
  const openDialogueTab = useEditor((s) => s.openDialogueTab);
  const addUIWidget = useEditor((s) => s.addUIWidget);
  const renameUIWidget = useEditor((s) => s.renameUIWidget);
  const removeUIWidget = useEditor((s) => s.removeUIWidget);
  const setUIWidgetPath = useEditor((s) => s.setUIWidgetPath);
  const openUIWidgetTab = useEditor((s) => s.openUIWidgetTab);
  const addTileset = useEditor((s) => s.addTileset);
  const renameTileset = useEditor((s) => s.renameTileset);
  const removeTileset = useEditor((s) => s.removeTileset);
  const openTilesetTab = useEditor((s) => s.openTilesetTab);
  const addTilemap = useEditor((s) => s.addTilemap);
  const renameTilemap = useEditor((s) => s.renameTilemap);
  const removeTilemap = useEditor((s) => s.removeTilemap);
  const openTilemapTab = useEditor((s) => s.openTilemapTab);
  const updateBlueprint = useEditor((s) => s.updateBlueprint);
  const addFolder = useEditor((s) => s.addFolder);
  const removeFolder = useEditor((s) => s.removeFolder);
  const renameFolder = useEditor((s) => s.renameFolder);
  const setBlueprintPath = useEditor((s) => s.setBlueprintPath);
  const setScenePath = useEditor((s) => s.setScenePath);
  const setTilesetPath = useEditor((s) => s.setTilesetPath);
  const setTilemapPath = useEditor((s) => s.setTilemapPath);
  const newProject = useEditor((s) => s.newProject);
  const addSound = useEditor((s) => s.addSound);
  const renameSound = useEditor((s) => s.renameSound);
  const removeSound = useEditor((s) => s.removeSound);
  const setSoundPath = useEditor((s) => s.setSoundPath);
  const addItem = useEditor((s) => s.addItem);
  const renameItem = useEditor((s) => s.renameItem);
  const removeItem = useEditor((s) => s.removeItem);
  const setItemPath = useEditor((s) => s.setItemPath);
  const addRecipe = useEditor((s) => s.addRecipe);
  const renameRecipe = useEditor((s) => s.renameRecipe);
  const removeRecipe = useEditor((s) => s.removeRecipe);
  const setRecipePath = useEditor((s) => s.setRecipePath);

  const [selectedFolder, setSelectedFolder] = useState<string>("/Blueprints");
  const [search, setSearch] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  // Path of a folder TILE selected in the grid (single-click). Drives the
  // Delete-key path for folders (assets use selectedAssetIds).
  const [selectedFolderTile, setSelectedFolderTile] = useState<string | null>(null);
  // Marquee (rubber-band) selection. start/end are grid-relative px so the
  // outline tracks scroll/zoom of the grid container.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number; ctrl: boolean; baseline: Set<string> } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  /** Replace / extend / toggle selection in one place. `mode = "replace"`
   *  for plain clicks, `"toggle"` for ctrl-clicks, `"union"` for the
   *  marquee's running set. */
  const selectOne = (id: string, mode: "replace" | "toggle") => {
    setSelectedFolderTile(null); // asset + folder selection are mutually exclusive
    setSelectedAssetIds((prev) => {
      if (mode === "toggle") {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  };
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  /** Folder path that pending BP creation should be saved into. Non-null = picker open. */
  const [pickerForPath, setPickerForPath] = useState<string | null>(null);
  const blueprintCount = project.blueprints.length;
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [renamingAssetId, setRenamingAssetId] = useState<string | null>(null);
  // Sound import: a hidden file input is triggered from the context menu;
  // pendingImport remembers which folder + kind the picked file becomes.
  const soundFileRef = useRef<HTMLInputElement>(null);
  const pendingImport = useRef<{ path: string; kind: "music" | "sfx" } | null>(null);
  // Sound properties popover (kind / volume / loop / preview). Opened on
  // double-click or "Edit Sound" — avoids a full tab for a tiny surface.
  const [editingSoundId, setEditingSoundId] = useState<string | null>(null);
  // Item properties popover (icon / maxStack / tags). Opened on double-click
  // or "Edit Item".
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  // Recipe editor popover. Opened on double-click or "Edit Recipe".
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  // True while OS files are being dragged over the asset grid (drop hint).
  const [fileDragOver, setFileDragOver] = useState(false);

  // Folder panel width
  const [folderW, setFolderW] = useState(() => {
    try {
      return Math.max(MIN_FOLDER_W, Math.min(MAX_FOLDER_W, Number(localStorage.getItem(CB_STORAGE_KEY)) || 200));
    } catch { return 200; }
  });
  const dragSplitter = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(CB_STORAGE_KEY, String(folderW));
  }, [folderW]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragSplitter.current) return;
      const dx = e.clientX - dragSplitter.current.startX;
      setFolderW(Math.max(MIN_FOLDER_W, Math.min(MAX_FOLDER_W, dragSplitter.current.startW + dx)));
    };
    const onUp = () => {
      if (!dragSplitter.current) return;
      dragSplitter.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, []);

  // Build flat asset list from project. Sprites + Blueprints get a
  // thumbnail data URL when one's available (first frame of first
  // animation). BPs resolve their sprite through SpriteRenderer.spriteId.
  const spriteById = new Map(project.sprites.map((s) => [s.id, s]));
  // Compute on-disk thumbnail path (project-relative) for tile rendering.
  // The tile component resolves these to blob URLs in bulk via useAssetURLs.
  const firstFramePath = (sp: SpriteAsset | undefined): string | undefined => {
    const f = sp?.animations[0]?.frames[0];
    return sp && f?.imageFile ? spriteFrameDiskPath(sp, f.imageFile) : undefined;
  };
  const itemIconPath = (it: { spriteId: string; iconAnim?: string; iconFrame?: number }): string | undefined => {
    const sp = spriteById.get(it.spriteId);
    if (!sp) return undefined;
    const anim = sp.animations.find((a) => a.id === it.iconAnim) ?? sp.animations[0];
    const idx = it.iconFrame !== undefined && it.iconFrame >= 0 ? it.iconFrame : 0;
    const frame = anim?.frames[idx] ?? anim?.frames[0];
    return frame?.imageFile ? spriteFrameDiskPath(sp, frame.imageFile) : undefined;
  };
  const allAssets: Asset[] = [
    ...project.blueprints.map((b: BlueprintDef): Asset => {
      const sr = b.behaviors.find((bh) => bh.kind === "SpriteRenderer");
      const spId = sr ? String((sr.config as { spriteId?: string }).spriteId ?? "") : "";
      const imagePath = spId ? firstFramePath(spriteById.get(spId)) : undefined;
      return { kind: "blueprint", id: b.id, name: b.name, path: b.path, color: b.color, imagePath, hidden: b.hidden };
    }),
    ...project.scenes.map((sc: SceneData): Asset => ({
      kind: "scene", id: sc.id, name: sc.name, path: sc.path, hidden: sc.hidden,
    })),
    ...project.sprites.map((sp: SpriteAsset): Asset => {
      const firstColor = sp.animations[0]?.frames[0]?.color;
      return { kind: "sprite", id: sp.id, name: sp.name, path: sp.path, color: firstColor, imagePath: firstFramePath(sp), hidden: sp.hidden };
    }),
    ...project.dialogues.map((d): Asset => ({
      kind: "dialogue",
      id: d.id,
      name: d.name,
      path: d.path ?? "/Dialogues",
      hidden: d.hidden,
    })),
    ...project.uiWidgets.map((w): Asset => ({
      kind: "uiwidget",
      id: w.id,
      name: w.name,
      path: w.path ?? "/UI",
      hidden: w.hidden,
    })),
    ...(project.sounds ?? []).map((s): Asset => ({
      kind: "sound",
      id: s.id,
      name: s.name,
      path: s.path ?? "/Audio",
      soundKind: s.kind,
      hidden: s.hidden,
    })),
    ...(project.items ?? []).map((it): Asset => ({
      kind: "item",
      id: it.id,
      name: it.name,
      path: it.path ?? "/Items",
      imagePath: it.spriteId ? itemIconPath(it) : undefined,
      hidden: it.hidden,
    })),
    ...(project.recipes ?? []).map((r): Asset => {
      // Recipe tile shows the OUTPUT item's icon.
      const out = (project.items ?? []).find((it) => it.name === r.outputItem);
      return {
        kind: "recipe",
        id: r.id,
        name: r.name,
        path: r.path ?? "/Recipes",
        imagePath: out && out.spriteId ? itemIconPath(out) : undefined,
        hidden: r.hidden,
      };
    }),
    ...(project.tilesets ?? []).map((t): Asset => ({
      kind: "tileset",
      id: t.id,
      name: t.name,
      path: t.path ?? "/Tilesets",
      // Show the source sheet as the thumbnail when set — easier to recognize
      // a tileset by its art than by a generic icon.
      imagePath: t.imageFile ? tilesetImagePath(t) : undefined,
      hidden: t.hidden,
    })),
    ...(project.tilemaps ?? []).map((m): Asset => ({
      kind: "tilemap",
      id: m.id,
      name: m.name,
      path: m.path ?? "/Tilemaps",
      hidden: m.hidden,
    })),
  ];

  // Non-empty search filters by name across ALL folders; otherwise show the
  // current folder's assets.
  const q = search.trim().toLowerCase();
  const visibleAssets = q
    ? allAssets.filter((a) => a.name.toLowerCase().includes(q))
    : allAssets.filter((a) => a.path === selectedFolder);

  // Ensure selectedFolder is valid; fall back to first folder or "/"
  useEffect(() => {
    const valid = selectedFolder === "/" || project.folders.includes(selectedFolder);
    if (!valid) setSelectedFolder(project.folders[0] ?? "/");
  }, [project.folders, selectedFolder]);

  const openContextMenu = (e: React.MouseEvent, items: ContextMenuState["items"]) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ── Folder context menu ───────────────────────────────────────────────────
  const onFolderContextMenu = (e: React.MouseEvent, folderPath: string) => {
    openContextMenu(e, [
      {
        label: "New Blueprint",
        icon: "NewBlueprint",
        action: () => {
          setSelectedFolder(folderPath);
          setPickerForPath(folderPath);
        },
      },
      {
        label: "New Scene",
        icon: "NewScene",
        action: () => {
          addScene(folderPath);
          setSelectedFolder(folderPath);
        },
      },
      {
        label: "New Sprite",
        icon: "NewSprite",
        action: () => {
          const id = addSprite(folderPath);
          setSelectedFolder(folderPath);
          openSpriteTab(id);
        },
      },
      {
        label: "New Dialogue",
        icon: "NewDialogue",
        action: () => {
          const id = addDialogue(folderPath);
          setSelectedFolder(folderPath);
          openDialogueTab(id);
        },
      },
      {
        label: "New UI Widget",
        icon: "NewUIWidget",
        action: () => {
          const id = addUIWidget(folderPath);
          setSelectedFolder(folderPath);
          openUIWidgetTab(id);
        },
      },
      {
        label: "New Item",
        icon: "NewItem",
        action: () => {
          const id = addItem({ path: folderPath });
          setSelectedFolder(folderPath);
          setEditingItemId(id);
        },
      },
      {
        label: "New Recipe",
        icon: "NewRecipe",
        action: () => {
          const id = addRecipe({ path: folderPath });
          setSelectedFolder(folderPath);
          setEditingRecipeId(id);
        },
      },
      {
        label: "New Tileset",
        icon: "NewTileset",
        action: () => {
          const id = addTileset(folderPath);
          setSelectedFolder(folderPath);
          openTilesetTab(id);
        },
      },
      {
        label: "New Tilemap",
        icon: "NewTilemap",
        action: () => {
          const id = addTilemap(folderPath);
          setSelectedFolder(folderPath);
          openTilemapTab(id);
        },
      },
      {
        label: "Import Music…",
        icon: "ImportMusic",
        action: () => triggerSoundImport(folderPath, "music"),
      },
      {
        label: "Import SFX…",
        icon: "ImportSFX",
        action: () => triggerSoundImport(folderPath, "sfx"),
      },
      {
        label: "New Folder",
        icon: "NewFolder",
        action: () => newFolderUnder(folderPath),
      },
      { label: "Rename Folder", action: () => setRenamingFolderPath(folderPath) },
      {
        label: "Delete Folder",
        danger: true,
        action: () => removeFolder(folderPath),
      },
    ]);
  };

  // ── Asset context menu ────────────────────────────────────────────────────
  const onAssetContextMenu = (e: React.MouseEvent, asset: Asset) => {
    const openLabel =
      asset.kind === "blueprint" ? "Open Blueprint" :
      asset.kind === "scene"     ? "Open Scene"     :
      asset.kind === "sprite"    ? "Open Sprite"    :
      asset.kind === "uiwidget"  ? "Open UI Widget" :
      asset.kind === "sound"     ? "Edit Sound"     :
      asset.kind === "item"      ? "Edit Item"      :
      asset.kind === "recipe"    ? "Edit Recipe"    :
      asset.kind === "tileset"   ? "Open Tileset"   :
      asset.kind === "tilemap"   ? "Open Tilemap"   :
                                   "Open Dialogue";
    const openAsset = (a: Asset) => {
      if (a.kind === "blueprint")     openBlueprintTab(a.id);
      else if (a.kind === "scene")    setActiveScene(a.id);
      else if (a.kind === "sprite")   openSpriteTab(a.id);
      else if (a.kind === "uiwidget") openUIWidgetTab(a.id);
      else if (a.kind === "sound")    setEditingSoundId(a.id);
      else if (a.kind === "item")     setEditingItemId(a.id);
      else if (a.kind === "recipe")   setEditingRecipeId(a.id);
      else if (a.kind === "tileset")  openTilesetTab(a.id);
      else if (a.kind === "tilemap")  openTilemapTab(a.id);
      else                            openDialogueTab(a.id);
    };
    const commonItems: ContextMenuState["items"] = [
      { label: openLabel, action: () => openAsset(asset) },
      { label: "Rename", action: () => setRenamingAssetId(asset.id) },
    ];
    // Duplicate — works for every asset kind. Deep-clones into an
    // independent copy with a unique "<name> copy" name, then opens it.
    commonItems.push({
      label: "Duplicate",
      action: () => {
        const newAssetId = duplicateAsset(asset.kind, asset.id);
        if (!newAssetId) return;
        if (asset.kind === "blueprint")     openBlueprintTab(newAssetId);
        else if (asset.kind === "scene")    setActiveScene(newAssetId);
        else if (asset.kind === "sprite")   openSpriteTab(newAssetId);
        else if (asset.kind === "uiwidget") openUIWidgetTab(newAssetId);
        else if (asset.kind === "sound")    setSelectedAssetIds(new Set([newAssetId]));
        else if (asset.kind === "item")     setSelectedAssetIds(new Set([newAssetId]));
        else if (asset.kind === "recipe")   setSelectedAssetIds(new Set([newAssetId]));
        else if (asset.kind === "tileset")  openTilesetTab(newAssetId);
        else if (asset.kind === "tilemap")  openTilemapTab(newAssetId);
        else                                openDialogueTab(newAssetId);
      },
    });

    // If the right-clicked asset is part of a multi-selection, Move and
    // Delete operate on every selected asset. Otherwise just the clicked
    // one. Mirrors how OS file managers behave.
    const inSelection = selectedAssetIds.has(asset.id) && selectedAssetIds.size > 1;

    // "Move to" is a single submenu parent; the folder list lives in the
    // flyout. When the clicked asset is part of a multi-selection, every
    // selected asset moves together.
    const moveTargets = inSelection
      ? [...selectedAssetIds].map((id) => allAssets.find((x) => x.id === id)).filter(Boolean) as Asset[]
      : [asset];
    const moveSubmenu: ContextMenuItem[] = project.folders
      .filter((f) => moveTargets.some((a) => a.path !== f)) // hide a folder only if it holds ALL of them
      .map((f) => ({
        label: f === "/" ? "Content" : f.replace(/^\//, ""),
        action: () => { for (const a of moveTargets) moveAssetToFolder(a, f); },
      }));
    const moveItems: ContextMenuItem[] = moveSubmenu.length
      ? [{ label: inSelection ? `Move ${moveTargets.length} to` : "Move to", submenu: moveSubmenu }]
      : [];

    const deleteLabel = inSelection ? `Delete (${selectedAssetIds.size})` : "Delete";
    const deleteItem: ContextMenuState["items"] = [
      {
        label: deleteLabel,
        danger: true,
        action: () => {
          if (inSelection) {
            deleteAssetsByIds(selectedAssetIds);
            setSelectedAssetIds(new Set());
          } else {
            deleteAssetById(asset.id);
            setSelectedAssetIds((prev) => {
              if (!prev.has(asset.id)) return prev;
              const next = new Set(prev);
              next.delete(asset.id);
              return next;
            });
          }
        },
      },
    ];

    openContextMenu(e, [...commonItems, ...(moveItems.length ? moveItems : []), ...deleteItem]);
  };

  // Move one asset to a folder — kind-by-kind dispatch shared by the
  // single- and multi-select "Move to" submenu.
  const moveAssetToFolder = (a: Asset, f: string) => {
    if (a.kind === "blueprint")     setBlueprintPath(a.id, f);
    else if (a.kind === "scene")    setScenePath(a.id, f);
    else if (a.kind === "sprite")   setSpritePath(a.id, f);
    else if (a.kind === "uiwidget") setUIWidgetPath(a.id, f);
    else if (a.kind === "sound")    setSoundPath(a.id, f);
    else if (a.kind === "item")     setItemPath(a.id, f);
    else if (a.kind === "recipe")   setRecipePath(a.id, f);
    else if (a.kind === "tileset")  setTilesetPath(a.id, f);
    else if (a.kind === "tilemap")  setTilemapPath(a.id, f);
    else if (a.kind === "dialogue") setDialoguePath(a.id, f);
    // Unrecognized kind: no-op rather than the previous silent fallthrough
    // to setDialoguePath which dropped the action on the floor.
  };

  // ── Delete helpers — single source of truth for asset removal ────────
  // The kind-by-kind switch used to be inlined in three places (RMB,
  // Delete key, marquee-delete). Centralized here so they all stay in
  // sync as new asset kinds get added.
  const deleteAssetById = (id: string) => {
    const a = allAssets.find((x) => x.id === id);
    if (!a) return;
    if (a.kind === "blueprint")     removeBlueprint(a.id);
    else if (a.kind === "scene")    removeScene(a.id);
    else if (a.kind === "sprite")   removeSprite(a.id);
    else if (a.kind === "uiwidget") removeUIWidget(a.id);
    else if (a.kind === "sound")    removeSound(a.id);
    else if (a.kind === "item")     removeItem(a.id);
    else if (a.kind === "recipe")   removeRecipe(a.id);
    else if (a.kind === "tileset")  removeTileset(a.id);
    else if (a.kind === "tilemap")  removeTilemap(a.id);
    else                            removeDialogue(a.id);
  };
  const deleteAssetsByIds = (ids: Iterable<string>) => {
    for (const id of ids) deleteAssetById(id);
  };

  // Keyboard delete — fires when the Content Browser is focused.
  //
  // Gate conditions (any one of these skips the handler):
  //   • Target is an input/textarea/contenteditable — let typing through.
  //   • A rename input is mounted in the Content Browser.
  //   • A Logic Sheet modal (or any React Flow canvas) is in the DOM —
  //     React Flow handles Delete for its own node graph. Without this,
  //     deleting a node in the modal would ALSO delete whatever asset
  //     was last selected in the Content Browser behind it.
  //   • The most recent click landed outside the Content Browser's grid
  //     — the user is interacting elsewhere; their Delete press is
  //     intended for that surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Shared gates for both Delete and Ctrl+D.
      if (inField) return;
      if (renamingAssetId) return;
      if (document.querySelector(".react-flow")) return;
      if (!lastInteractionInGridRef.current) return;

      // ── Ctrl/Cmd+D → Duplicate selected assets (any kind) ───────────
      // Browser's default Ctrl+D (bookmark) is suppressed.
      if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
        if (selectedAssetIds.size === 0) return;
        e.preventDefault();
        const newIds = [...selectedAssetIds]
          .map((id) => {
            const a = allAssets.find((x) => x.id === id);
            return a ? duplicateAsset(a.kind, a.id) : "";
          })
          .filter(Boolean);
        // Re-select the clones so a follow-up action targets them.
        if (newIds.length) setSelectedAssetIds(new Set(newIds));
        return;
      }

      // ── Delete / Backspace ──────────────────────────────────────────
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Folder tile selected → delete the folder (its contents reparent to
      // the parent folder via removeFolder).
      if (selectedFolderTile) {
        e.preventDefault();
        const ok = window.confirm(`Delete folder "${folderName(selectedFolderTile)}"? Items inside move up to the parent folder.`);
        if (!ok) return;
        removeFolder(selectedFolderTile);
        setSelectedFolderTile(null);
        return;
      }
      if (selectedAssetIds.size === 0) return;
      e.preventDefault();
      const count = selectedAssetIds.size;
      const ok = count === 1
        ? window.confirm("Delete this asset?")
        : window.confirm(`Delete ${count} assets? This can't be undone.`);
      if (!ok) return;
      deleteAssetsByIds(selectedAssetIds);
      setSelectedAssetIds(new Set());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssetIds, selectedFolderTile, renamingAssetId]);

  // Track whether the last user interaction was inside the Content
  // Browser. Set on mousedown anywhere in the grid; unset on mousedown
  // elsewhere. Drives the keyboard-delete gate above.
  const lastInteractionInGridRef = useRef(false);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const grid = gridRef.current;
      const target = e.target as Node | null;
      lastInteractionInGridRef.current = !!(grid && target && grid.contains(target));
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, []);

  // ── Sound import ──────────────────────────────────────────────────
  const isAudioFile = (f: File) =>
    f.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba?)$/i.test(f.name);

  const readAsDataUrl = (file: File) =>
    new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });

  // Auto-classify a dropped clip by length: clips >= 15s are almost always
  // background music (and should loop); shorter ones are sound effects.
  // Falls back to "sfx" if the duration can't be read. The user can flip
  // the kind in the Sound inspector regardless.
  const detectSoundKind = (dataUrl: string) =>
    new Promise<"music" | "sfx">((resolve) => {
      const a = new Audio();
      let settled = false;
      const done = (k: "music" | "sfx") => { if (!settled) { settled = true; resolve(k); } };
      a.addEventListener("loadedmetadata", () =>
        done(Number.isFinite(a.duration) && a.duration >= 15 ? "music" : "sfx"));
      a.addEventListener("error", () => done("sfx"));
      setTimeout(() => done("sfx"), 4000);
      a.src = dataUrl;
    });

  // Import one or more audio files into `path`. `kindOverride` forces a
  // kind (Import Music / Import SFX menu); when omitted (drag-drop), each
  // file's kind is auto-detected by duration. Non-audio files are skipped.
  const importAudioFiles = async (files: FileList | File[], path: string, kindOverride?: "music" | "sfx") => {
    const audio = [...files].filter(isAudioFile);
    if (!audio.length) return;
    const newIds: string[] = [];
    // Filenames already used in this folder. Seeded from existing SoundAsset
    // records, then accumulated per import so two newly-dropped "jump.mp3"
    // files don't both write to jump.mp3. Without this, the second silently
    // overwrites the first on disk (the SoundAsset records get deduped names
    // like "jump_2" but their `file` field collides).
    const used = new Set(
      (project.sounds ?? []).filter((s) => s.path === path).map((s) => s.file),
    );
    for (const file of audio) {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl) continue;
      const kind = kindOverride ?? (await detectSoundKind(dataUrl));
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
      // Pick a non-colliding filename in this folder.
      let fileName = file.name;
      if (used.has(fileName)) {
        let n = 2;
        while (used.has(`${baseName}_${n}${ext}`)) n++;
        fileName = `${baseName}_${n}${ext}`;
      }
      used.add(fileName);
      const ok = await writeAssetFromDataURL(
        soundDiskPath({ path, file: fileName }),
        dataUrl,
      );
      if (!ok) { console.warn("Sound import: no AssetStore open — file not written"); continue; }
      newIds.push(addSound({ name: baseName, path, file: fileName, kind }));
    }
    if (newIds.length) {
      setSelectedFolder(path);
      setSelectedAssetIds(new Set(newIds));
      // A single imported sound opens its rename editor immediately, pre-filled
      // with the original name + selected, so the author can type a clean name
      // right away (filenames are usually noisy). Bulk imports skip this.
      if (newIds.length === 1) setRenamingAssetId(newIds[0]);
    }
  };

  // ── Image → Sprite import ─────────────────────────────────────────
  const isImageFile = (f: File) =>
    f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);

  const imageNaturalSize = (dataUrl: string) =>
    new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 64, h: img.naturalHeight || 64 });
      img.onerror = () => resolve({ w: 64, h: 64 });
      img.src = dataUrl;
    });

  // Each dropped image becomes a new Sprite asset whose default animation's
  // first frame IS the image (sized to its natural dimensions). Lets you
  // drag PNGs straight from Explorer and get ready-to-use sprites.
  const importImageFiles = async (files: FileList | File[], path: string) => {
    const imgs = [...files].filter(isImageFile);
    if (!imgs.length) return;
    const newIds: string[] = [];
    for (const file of imgs) {
      const dataUrl = await readAsDataUrl(file);
      if (!dataUrl) continue;
      const { w, h } = await imageNaturalSize(dataUrl);
      const spriteId = addSprite(path);
      // Name from the file, deduped against existing sprite names.
      const base = file.name.replace(/\.[^.]+$/, "") || "Sprite";
      const taken = new Set(useEditor.getState().project.sprites.map((s) => s.name));
      let name = base; let n = 2;
      while (taken.has(name)) name = `${base}${n++}`;
      renameSprite(spriteId, name);
      setSpriteSize(spriteId, w, h);
      const sp = useEditor.getState().project.sprites.find((s) => s.id === spriteId);
      const animId = sp?.animations[0]?.id;
      if (animId && sp) {
        // Write the imported PNG to disk under the sprite's folder. Filename
        // is just `<frame-id>.png` — extension hard-coded because we re-encode
        // to PNG when we lose the original mime through dataUrl conversion.
        const frameFile = `frame_0.png`;
        await writeAssetFromDataURL(spriteFrameDiskPath(sp, frameFile), dataUrl);
        addSpriteFrame(spriteId, animId, { imageFile: frameFile, imageW: w, imageH: h });
      }
      newIds.push(spriteId);
    }
    if (newIds.length) {
      setSelectedFolder(path);
      setSelectedAssetIds(new Set(newIds));
    }
  };

  // Opens the OS file picker; picked files become SoundAssets of the chosen
  // kind in the target folder.
  const triggerSoundImport = (path: string, kind: "music" | "sfx") => {
    pendingImport.current = { path, kind };
    soundFileRef.current?.click();
  };
  const onSoundFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const target = pendingImport.current;
    pendingImport.current = null;
    if (files && files.length && target) void importAudioFiles(files, target.path, target.kind);
    e.target.value = ""; // allow re-importing the same file later
  };

  // Native OS file drag-drop onto the asset grid → import into the selected
  // folder. Internal asset drags use `application/x-peaky-asset` (no Files
  // entry), so they fall through these handlers untouched.
  const onGridFileDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!fileDragOver) setFileDragOver(true);
  };
  const onGridFileDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setFileDragOver(false);
  };
  const onGridFileDrop = (e: React.DragEvent) => {
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    e.preventDefault();
    setFileDragOver(false);
    // Route by type: images → new Sprites, audio → new Sounds. A mixed drop
    // does both; unrecognized files are ignored by each importer.
    void importImageFiles(files, selectedFolder);
    void importAudioFiles(files, selectedFolder);
  };

  const onAssetDragStart = (e: React.DragEvent, asset: Asset) => {
    e.dataTransfer.setData("application/x-peaky-asset", `${asset.kind}:${asset.id}`);
    e.dataTransfer.effectAllowed = "copy";
  };

  const onAssetDoubleClick = (asset: Asset) => {
    if (asset.kind === "blueprint")     openBlueprintTab(asset.id);
    else if (asset.kind === "scene")    setActiveScene(asset.id);
    else if (asset.kind === "sprite")   openSpriteTab(asset.id);
    else if (asset.kind === "uiwidget") openUIWidgetTab(asset.id);
    else if (asset.kind === "sound")    setEditingSoundId(asset.id);
    else if (asset.kind === "item")     setEditingItemId(asset.id);
    else if (asset.kind === "recipe")   setEditingRecipeId(asset.id);
    else if (asset.kind === "tileset")  openTilesetTab(asset.id);
    else if (asset.kind === "tilemap")  openTilemapTab(asset.id);
    else                                openDialogueTab(asset.id);
  };

  // ── Asset inline rename ───────────────────────────────────────────────────
  const commitAssetRename = (asset: Asset, newName: string) => {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== asset.name) {
      if (asset.kind === "blueprint")     updateBlueprint(asset.id, { name: trimmed });
      else if (asset.kind === "scene")    renameScene(asset.id, trimmed);
      else if (asset.kind === "sprite")   renameSprite(asset.id, trimmed);
      else if (asset.kind === "uiwidget") renameUIWidget(asset.id, trimmed);
      else if (asset.kind === "sound")    renameSound(asset.id, trimmed);
      else if (asset.kind === "item")     renameItem(asset.id, trimmed);
      else if (asset.kind === "recipe")   renameRecipe(asset.id, trimmed);
      else if (asset.kind === "tileset")  renameTileset(asset.id, trimmed);
      else if (asset.kind === "tilemap")  renameTilemap(asset.id, trimmed);
      else                                renameDialogue(asset.id, trimmed);
    }
    setRenamingAssetId(null);
  };

  // ── Folder inline rename ──────────────────────────────────────────────────
  const commitFolderRename = (oldPath: string, newSegment: string) => {
    const trimmed = newSegment.trim();
    if (trimmed) {
      const parent = oldPath.slice(0, oldPath.lastIndexOf("/")) || "/";
      const newPath = normalizeFolderPath(parent === "/" ? "/" + trimmed : parent + "/" + trimmed);
      if (newPath && newPath !== oldPath) {
        renameFolder(oldPath, newPath);
        if (selectedFolder === oldPath) setSelectedFolder(newPath);
      }
    }
    setRenamingFolderPath(null);
  };

  // Create a uniquely-named subfolder under `parentPath` and drop straight
  // into rename mode. Shared by the folder-tree and grid context menus so
  // nesting works from either surface.
  const newFolderUnder = (parentPath: string) => {
    const base = parentPath === "/" ? "/New Folder" : parentPath + "/New Folder";
    let path = base;
    let n = 2;
    while (project.folders.includes(path)) path = `${base} ${n++}`;
    addFolder(path);
    setSelectedFolder(parentPath);
    setRenamingFolderPath(path);
  };

  // ── Empty-area context menu in grid ──────────────────────────────────────
  const onGridContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-asset]")) return;
    openContextMenu(e, [
      {
        label: "New Folder",
        icon: "NewFolder",
        action: () => newFolderUnder(selectedFolder),
      },
      {
        label: "New Blueprint",
        icon: "NewBlueprint",
        action: () => setPickerForPath(selectedFolder),
      },
      {
        label: "New Scene",
        icon: "NewScene",
        action: () => addScene(selectedFolder),
      },
      {
        label: "New Sprite",
        icon: "NewSprite",
        action: () => {
          const id = addSprite(selectedFolder);
          openSpriteTab(id);
        },
      },
      {
        label: "New Dialogue",
        icon: "NewDialogue",
        action: () => {
          const id = addDialogue(selectedFolder);
          openDialogueTab(id);
        },
      },
      {
        label: "New UI Widget",
        icon: "NewUIWidget",
        action: () => {
          const id = addUIWidget(selectedFolder);
          openUIWidgetTab(id);
        },
      },
      {
        label: "New Item",
        icon: "NewItem",
        action: () => {
          const id = addItem({ path: selectedFolder });
          setEditingItemId(id);
        },
      },
      {
        label: "New Recipe",
        icon: "NewRecipe",
        action: () => {
          const id = addRecipe({ path: selectedFolder });
          setEditingRecipeId(id);
        },
      },
      {
        label: "New Tileset",
        icon: "NewTileset",
        action: () => {
          const id = addTileset(selectedFolder);
          openTilesetTab(id);
        },
      },
      {
        label: "New Tilemap",
        icon: "NewTilemap",
        action: () => {
          const id = addTilemap(selectedFolder);
          openTilemapTab(id);
        },
      },
      {
        label: "Import Music…",
        icon: "ImportMusic",
        action: () => triggerSoundImport(selectedFolder, "music"),
      },
      {
        label: "Import SFX…",
        icon: "ImportSFX",
        action: () => triggerSoundImport(selectedFolder, "sfx"),
      },
    ]);
  };

  // All folders including virtual root for tree
  const allFolders = project.folders;
  const rootChildren = childFolders(allFolders, "/");
  // Immediate subfolders of the folder being viewed — shown as tiles in the
  // grid so newly-created subfolders are visible without the left tree.
  const childFolderPaths = childFolders(allFolders, selectedFolder);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "var(--card)",
        overflow: "hidden",
      }}
    >
      {/* ─ Folder tree ─ */}
      <div
        style={{
          width: folderW,
          flexShrink: 0,
          overflowY: "auto",
          paddingTop: 4,
        }}
      >
        {/* Root row */}
        <div
          onClick={() => setSelectedFolder("/")}
          onContextMenu={(e) => { e.preventDefault(); onFolderContextMenu(e, "/"); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 10px",
            margin: "1px 6px",
            borderRadius: 8,
            cursor: "crosshair",
            background: selectedFolder === "/" ? "var(--inner-hi)" : "transparent",
            fontSize: 12,
            userSelect: "none",
          }}
        >
          <FolderIcon open />
          <span style={{ color: selectedFolder === "/" ? "var(--text)" : "var(--text-2)", fontWeight: 600 }}>
            Content
          </span>
        </div>

        {rootChildren.map((folder) =>
          renamingFolderPath === folder ? (
            <div key={folder} style={{ padding: "2px 8px 2px 22px" }}>
              <FolderNameEditor
                initial={folderName(folder)}
                onDone={(val) => commitFolderRename(folder, val)}
              />
            </div>
          ) : (
            <FolderNode
              key={folder}
              path={folder}
              depth={0}
              selectedPath={selectedFolder}
              onSelect={setSelectedFolder}
              onContextMenu={onFolderContextMenu}
              folders={allFolders}
            />
          )
        )}
      </div>

      {/* ─ Splitter ─ */}
      <div
        style={{ width: 6, cursor: "col-resize", flexShrink: 0, background: "transparent" }}
        onMouseDown={(e) => {
          e.preventDefault();
          dragSplitter.current = { startX: e.clientX, startW: folderW };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(245,197,66,0.15)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
      />

      {/* ─ Asset grid ─ */}
      <div
        style={{
          flex: 1, overflowY: "auto", padding: "8px", position: "relative",
          outline: fileDragOver ? "2px dashed var(--green)" : "none",
          outlineOffset: -4,
          background: fileDragOver ? "rgba(90,200,120,0.06)" : undefined,
        }}
        onContextMenu={onGridContextMenu}
        onDragOver={onGridFileDragOver}
        onDragLeave={onGridFileDragLeave}
        onDrop={onGridFileDrop}
        onClick={(e) => {
          // Click on empty grid area clears selection. Ignore when the
          // click landed on a tile (tile's own handler ran) OR when the
          // marquee just finished (drag-release reaches here as a click).
          if ((e.target as HTMLElement).closest("[data-asset]")) return;
          if (marquee) return;
          setSelectedAssetIds(new Set());
          setSelectedFolderTile(null);
        }}
        onMouseDown={(e) => {
          // Begin a marquee only when the press lands on empty grid space
          // (not on a tile). Ctrl/Meta = additive — the existing selection
          // is preserved and the rect union extends it.
          if ((e.target as HTMLElement).closest("[data-asset]")) return;
          if (e.button !== 0) return;
          const grid = gridRef.current;
          if (!grid) return;
          const rect = grid.getBoundingClientRect();
          const x = e.clientX - rect.left + grid.scrollLeft;
          const y = e.clientY - rect.top + grid.scrollTop;
          const ctrl = e.ctrlKey || e.metaKey;
          setMarquee({
            x0: x, y0: y, x1: x, y1: y,
            ctrl,
            baseline: ctrl ? new Set(selectedAssetIds) : new Set(),
          });
        }}
        onMouseMove={(e) => {
          if (!marquee) return;
          const grid = gridRef.current;
          if (!grid) return;
          const rect = grid.getBoundingClientRect();
          const x = e.clientX - rect.left + grid.scrollLeft;
          const y = e.clientY - rect.top + grid.scrollTop;
          // Compute new selection: tile is in selection iff its rect
          // intersects the marquee. Tile rects come from the live DOM
          // (every tile is wrapped in [data-asset][data-asset-id]).
          const minX = Math.min(marquee.x0, x);
          const maxX = Math.max(marquee.x0, x);
          const minY = Math.min(marquee.y0, y);
          const maxY = Math.max(marquee.y0, y);
          const hit = new Set<string>(marquee.baseline);
          const tiles = grid.querySelectorAll<HTMLElement>("[data-asset-id]");
          for (const t of tiles) {
            const tr = t.getBoundingClientRect();
            const tx0 = tr.left - rect.left + grid.scrollLeft;
            const tx1 = tr.right - rect.left + grid.scrollLeft;
            const ty0 = tr.top - rect.top + grid.scrollTop;
            const ty1 = tr.bottom - rect.top + grid.scrollTop;
            const overlaps = tx0 < maxX && tx1 > minX && ty0 < maxY && ty1 > minY;
            if (overlaps) {
              const id = t.getAttribute("data-asset-id");
              if (id) hit.add(id);
            }
          }
          setSelectedAssetIds(hit);
          setMarquee({ ...marquee, x1: x, y1: y });
        }}
        onMouseUp={() => {
          // Defer clearing the marquee until after the click handler runs
          // — the click handler checks `marquee` to skip the clear-selection
          // path on drag-release. requestAnimationFrame is enough since
          // React batches both into the same task.
          if (marquee) {
            requestAnimationFrame(() => setMarquee(null));
          }
        }}
        ref={gridRef}
      >
        {/* Breadcrumb + New Project button */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, paddingLeft: 2 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            {q ? "Search results" : `Content${selectedFolder !== "/" ? selectedFolder.replace(/\//g, " / ") : ""}`}
          </span>
          <div
            style={{ position: "relative", flex: "0 1 240px" }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assets…"
              style={{
                width: "100%", fontSize: 11, padding: "3px 22px 3px 8px",
                background: "var(--inner)", color: "var(--text)",
                border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6,
              }}
            />
            {search && (
              <span
                role="button"
                onClick={() => setSearch("")}
                title="Clear search"
                style={{
                  position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                  cursor: "pointer", color: "var(--text-dim)", fontSize: 11, lineHeight: 1,
                }}
              >✕</span>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {/* "New Project" button removed: it downloaded a JSON snapshot of
              the in-memory PeakyProject as a fake backup, but that snapshot
              isn't loadable by either v7 (monolithic with base64 binaries)
              or v8 (split-file with assetIndex) — false safety. Use the
              File menu's "New Folder Project…" for an actual project reset. */}
        </div>

        {marquee && (
          <div
            style={{
              position: "absolute",
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
              background: "rgba(37, 99, 196, 0.10)",
              border: "1.5px dashed var(--blue)",
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        )}
        {visibleAssets.length === 0 && (q || childFolderPaths.length === 0) ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "16px 4px" }}>
            {q
              ? `No assets match “${search.trim()}”.`
              : "Empty folder — right-click to add assets, or drag files here: images → sprites, audio → sounds."}
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignContent: "flex-start" }}>
            {!q && childFolderPaths.map((fp) =>
              renamingFolderPath === fp ? (
                <div key={fp} style={{ width: 90, padding: "40px 4px 6px" }}>
                  <FolderNameEditor
                    initial={folderName(fp)}
                    onDone={(val) => commitFolderRename(fp, val)}
                  />
                </div>
              ) : (
                <div key={fp}>
                  <FolderTile
                    name={folderName(fp)}
                    selected={selectedFolderTile === fp}
                    onClick={() => { setSelectedFolderTile(fp); setSelectedAssetIds(new Set()); }}
                    onOpen={() => { setSelectedFolderTile(null); setSelectedFolder(fp); }}
                    onContextMenu={(e) => onFolderContextMenu(e, fp)}
                  />
                </div>
              )
            )}
            {visibleAssets.map((asset) =>
              renamingAssetId === asset.id ? (
                <div key={asset.id} style={{ width: 90, padding: "40px 4px 6px" }}>
                  <FolderNameEditor
                    initial={asset.name}
                    onDone={(val) => commitAssetRename(asset, val)}
                  />
                </div>
              ) : (
                <div key={asset.id} data-asset data-asset-id={asset.id}>
                  <AssetTile
                    asset={asset}
                    selected={selectedAssetIds.has(asset.id)}
                    onClick={(e) => selectOne(asset.id, e.ctrlKey || e.metaKey ? "toggle" : "replace")}
                    onDoubleClick={() => onAssetDoubleClick(asset)}
                    onContextMenu={(e) => onAssetContextMenu(e, asset)}
                    onDragStart={(e) => onAssetDragStart(e, asset)}
                  />
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Hidden file input for audio import — triggered by the context menu. */}
      <input
        ref={soundFileRef}
        type="file"
        accept="audio/*"
        multiple
        style={{ display: "none" }}
        onChange={onSoundFileChange}
      />

      {editingSoundId && (
        <SoundInspector soundId={editingSoundId} onClose={() => setEditingSoundId(null)} />
      )}
      {editingItemId && (
        <ItemInspector itemId={editingItemId} onClose={() => setEditingItemId(null)} />
      )}
      {editingRecipeId && (
        <RecipeInspector recipeId={editingRecipeId} onClose={() => setEditingRecipeId(null)} />
      )}

      {contextMenu && (
        <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      )}

      {pickerForPath !== null && (
        <NewBlueprintPicker
          onClose={() => setPickerForPath(null)}
          onPick={(cls) => {
            const partial = buildClassPartial(cls);
            const id = addBlueprint({
              ...partial,
              path: pickerForPath,
              name: `${CLASSES[cls].label} ${blueprintCount + 1}`,
            });
            setPickerForPath(null);
            openBlueprintTab(id);
          }}
        />
      )}
    </div>
  );
}
