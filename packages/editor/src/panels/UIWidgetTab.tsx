import { useEffect, useState } from "react";
import { Toggle } from "../components/Toggle";
import { useEditor } from "../store";
import { BlueprintDef, SpriteAsset, UIDropdownOption, UIWidgetChild, UIWidgetDef, UIWidgetKind, UIWidgetVisual, WidgetBinding, newId } from "../project";
import { spriteFrameDiskPath } from "../AssetStore";
import { useAssetURLs } from "../useAssetURL";
import { LogicSheetEditor } from "./inspector/LogicSheet/LogicSheetModal";
import { SignalPicker } from "../components/SignalPicker";
import { ValueOrVarBinding } from "../components/ValueOrVarBinding";
import { ExpressionField } from "./ExpressionField";
import { FontFamilyInput } from "../components/FontFamilyInput";

/**
 * UI Widget editor — Single / Multi modes.
 *
 *  - **Single**: the widget IS one element. Pick kind, configure properties.
 *  - **Multi**: the widget is a viewport-sized canvas holding multiple
 *    children. Drop a Button + a Label + a Slider all inside one widget,
 *    compose a HUD or menu screen, place it once in a scene to fill the
 *    canvas with the whole layout.
 */

const ALL_KINDS: { value: UIWidgetKind; label: string; description: string }[] = [
  { value: "Panel",       label: "Panel",        description: "Container with background + border." },
  { value: "Label",       label: "Label",        description: "Static text. Supports {var} interpolation." },
  { value: "Button",      label: "Button",       description: "Clickable rect + label. Hover / pressed states." },
  { value: "Slider",      label: "Slider",       description: "Draggable bar that emits signalOnChange." },
  { value: "ProgressBar", label: "Progress Bar", description: "Read-only bar driven by a value or expression." },
  { value: "Dropdown",    label: "Dropdown",     description: "Header that opens an options list." },
  { value: "Image",       label: "Image",        description: "Sprite asset's first frame, scaled to fill." },
  { value: "Inventory",   label: "Inventory",    description: "Grid of item slots bound to a character's Inventory behavior. Drag to rearrange." },
  { value: "CraftGrid",   label: "Craft Grid",   description: "Input slots + result slot. Drag items in from an inventory; drag the matched output back out into an inventory." },
  { value: "Shop",        label: "Shop",         description: "Grid of items for sale (icon + price). Assign an item per slot; click a slot to buy it (charges your money global, gives the item)." },
];

const ANCHOR_OPTIONS = [
  { value: "",   label: "(none)" },
  { value: "TL", label: "Top Left" },
  { value: "TC", label: "Top Center" },
  { value: "TR", label: "Top Right" },
  { value: "ML", label: "Middle Left" },
  { value: "C",  label: "Center" },
  { value: "MR", label: "Middle Right" },
  { value: "BL", label: "Bottom Left" },
  { value: "BC", label: "Bottom Center" },
  { value: "BR", label: "Bottom Right" },
];

export function UIWidgetTab({ widgetId }: { widgetId: string }) {
  const widget = useEditor((s) => s.project.uiWidgets.find((w) => w.id === widgetId));
  const viewportW = useEditor((s) => s.project.viewportWidth);
  const viewportH = useEditor((s) => s.project.viewportHeight);
  const renameUIWidget = useEditor((s) => s.renameUIWidget);
  const updateUIWidget = useEditor((s) => s.updateUIWidget);
  const setUIWidgetKind = useEditor((s) => s.setUIWidgetKind);
  const setUIWidgetMode = useEditor((s) => s.setUIWidgetMode);
  if (!widget) {
    return <div style={{ padding: 24, color: "var(--text-muted)" }}>UI Widget not found.</div>;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--canvas)", color: "var(--text)", overflow: "hidden" }}>
      {/* Header bar — full width above the body */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)", flexShrink: 0 }}>
            <span style={kindBadge}>UI Widget</span>
            <input value={widget.name} onChange={(e) => renameUIWidget(widget.id, e.target.value)} style={titleInput} />
            <div style={{ display: "inline-flex", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setUIWidgetMode(widget.id, "single")}
                style={{
                  ...modeBtn,
                  background: widget.mode === "single" ? "var(--orange)" : "transparent",
                  color: widget.mode === "single" ? "#000" : "var(--text-muted)",
                }}
                title="One element (Button/Slider/Label/etc.) — drop multiple times in scenes"
              >Single</button>
              <button
                onClick={() => setUIWidgetMode(widget.id, "multi")}
                style={{
                  ...modeBtn,
                  background: widget.mode === "multi" ? "var(--orange)" : "transparent",
                  color: widget.mode === "multi" ? "#000" : "var(--text-muted)",
                }}
                title="Viewport-sized canvas with multiple elements — full HUD/menu screen"
              >Multi</button>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
              title="When on, while the mouse is over this widget it blocks game INPUT ACTIONS (e.g. an attack bound to Left-Click) so clicking the widget or dragging a slider doesn't also fire gameplay. Keyboard input is unaffected.">
              <Toggle value={!!widget.blockGameInput} onChange={(v) => updateUIWidget(widget.id, { blockGameInput: v })} />
              <span>Block game input while hovered</span>
            </label>
          </div>

      {/* Body — single mode keeps the props | logic split; multi mode hands
          the whole area to MultiModeEditor (its own elements | preview split). */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {widget.mode === "single" ? (
          <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(520px, 1.4fr) 1px minmax(380px, 1fr)", overflow: "hidden" }}>
            <div style={{ overflow: "auto", padding: "16px 20px", minWidth: 0 }}>
              <SingleModeEditor
                widget={widget}
                onPatch={(p) => updateUIWidget(widget.id, p)}
                onSetKind={(k) => setUIWidgetKind(widget.id, k)}
              />
            </div>
            <div style={{ background: "rgba(255,255,255,0.06)" }} />
            <div style={{ overflow: "auto", padding: "16px 20px", minWidth: 0 }}>
              <LogicPanel widget={widget} />
            </div>
          </div>
        ) : (
          <MultiModeEditor
            widget={widget}
            viewportW={viewportW}
            viewportH={viewportH}
          />
        )}
      </div>
    </div>
  );
}

// ─── Single mode editor ─────────────────────────────────────────────────────

function SingleModeEditor({
  widget, onPatch, onSetKind,
}: {
  widget: UIWidgetDef;
  onPatch: (p: Partial<UIWidgetDef>) => void;
  onSetKind: (k: UIWidgetKind) => void;
}) {
  const sprites = useEditor((s) => s.project.sprites);
  return (
    <>
      <SingleModePreview widget={widget} sprites={sprites} />
      <Section title="Kind">
        <Field label="Type">
          <select value={widget.kind} onChange={(e) => onSetKind(e.target.value as UIWidgetKind)} style={input}>
            {ALL_KINDS.map((k) => (<option key={k.value} value={k.value}>{k.label}</option>))}
          </select>
        </Field>
        <div style={{ ...hint, gridColumn: "1 / -1", paddingTop: 4 }}>
          {ALL_KINDS.find((k) => k.value === widget.kind)?.description}
        </div>
      </Section>
      <VisualEditor visual={widget} onPatch={onPatch} sprites={sprites} scope={widget.id} />
    </>
  );
}

// ─── Single-mode preview ────────────────────────────────────────────────────
// Static visual preview of a single-mode widget. Mirrors ChildPreview's
// renderer but at a fixed scale, no interaction — the right-side property
// fields are still the only way to edit. Renders the widget's bg/border,
// per-kind body (slider fill / progress fill / image / label text), inside
// a contrasting frame so the author sees exactly what the BP-attached or
// HUD-placed instance will look like at runtime.
function SingleModePreview({
  widget, sprites,
}: {
  widget: UIWidgetDef;
  sprites: SpriteAsset[];
}) {
  // Pick a render scale that comfortably fits the widget into a ~480x240
  // preview viewport. Snap to a few reasonable rungs so authoring at 200x40
  // and 400x80 don't both render at the same physical size and confuse
  // the author.
  const maxW = 480;
  const maxH = 240;
  // Inventory frame size comes from the grid + padding (matches runtime), not
  // the stored width/height which may be stale.
  const frame = widget.kind === "CraftGrid"
    ? craftGridFrameSize(widget)
    : (widget.kind === "Inventory" || widget.kind === "Crafting" || widget.kind === "Shop")
    ? inventoryFrameSize(widget)
    : { width: widget.width, height: widget.height };
  // 1:1 — what you author here is the exact pixel size it renders at in the
  // runtime and the scene viewport (WYSIWYG). The preview box scrolls if the
  // widget is larger than the visible area instead of shrinking it.
  const scale = 1;
  const renderW = frame.width * scale;
  const renderH = frame.height * scale;

  const bgColor = widget.bgColor ?? 0;
  const bgAlpha = widget.bgAlpha ?? (widget.bgColor !== undefined ? 1 : 0);
  const bgHex = `#${(bgColor & 0xffffff).toString(16).padStart(6, "0")}`;
  const borderHex = `#${((widget.borderColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
  const fillHex = `#${((widget.fillColor ?? 0x44ddff) & 0xffffff).toString(16).padStart(6, "0")}`;
  // Clamp to half the smaller dimension so an oversized radius can't render a
  // pill (matches the runtime clamp).
  const cornerRadius = Math.min((widget.cornerRadius ?? 0), Math.min(frame.width, frame.height) / 2) * scale;
  // Slider / ProgressBar fill ratio — read the widget's current `value`
  // against its min/max so an authored "70% HP at design time" preview
  // shows that fill out of the box.
  let fillT = 0;
  if (widget.kind === "Slider" || widget.kind === "ProgressBar") {
    const min = widget.min ?? 0;
    const max = widget.max ?? 100;
    const span = max - min;
    fillT = typeof widget.value === "number" && span > 0
      ? Math.max(0, Math.min(1, (widget.value - min) / span))
      : 0.5;
  }
  const showText = widget.kind === "Label" || widget.kind === "Button" || widget.kind === "Dropdown";
  // For Image kind, pull the first frame of the referenced sprite asset (resolved via AssetStore).
  const imgSprite = widget.kind === "Image" && widget.spriteId
    ? sprites.find((s) => s.id === widget.spriteId)
    : undefined;
  const imgFrame = imgSprite?.animations[0]?.frames[0];
  const imgPath = imgSprite && imgFrame?.imageFile ? spriteFrameDiskPath(imgSprite, imgFrame.imageFile) : undefined;
  const imgUrlMap = useAssetURLs([imgPath]);
  const imgSrc = imgPath ? imgUrlMap.get(imgPath) : undefined;

  return (
    <Section title="Preview">
      <div style={{ gridColumn: "1 / -1" }}>
        <div style={{
          width: "100%", maxWidth: maxW + 40, height: maxH + 40,
          background: "var(--inner, rgba(0,0,0,0.3))",
          border: "1px dashed rgba(255,255,255,0.1)",
          borderRadius: 6,
          display: "flex", alignItems: "center", justifyContent: "center",
          position: "relative",
          overflow: "auto",
        }}>
          <div className="wradius" style={{
            width: renderW, height: renderH,
            position: "relative",
            background: bgAlpha > 0 ? `${bgHex}${alphaHex(bgAlpha)}` : "transparent",
            border: (widget.borderWidth ?? 0) > 0
              ? `${(widget.borderWidth ?? 0) * scale}px solid ${borderHex}`
              : "1px dashed rgba(255,255,255,0.15)",
            borderRadius: cornerRadius,
            boxSizing: "border-box",
            overflow: "hidden",
          }}>
            {imgSrc && (
              <img src={imgSrc} alt="" draggable={false} style={{
                width: "100%", height: "100%",
                objectFit: "fill", imageRendering: "pixelated",
                pointerEvents: "none",
              }} />
            )}
            {(widget.kind === "Slider" || widget.kind === "ProgressBar") && widget.direction !== "vertical" && (
              <div style={{
                position: "absolute", left: 0, top: 0,
                width: `${fillT * 100}%`, height: "100%",
                background: fillHex, pointerEvents: "none",
              }} />
            )}
            {(widget.kind === "Slider" || widget.kind === "ProgressBar") && widget.direction === "vertical" && (
              <div style={{
                position: "absolute", left: 0, bottom: 0,
                width: "100%", height: `${fillT * 100}%`,
                background: fillHex, pointerEvents: "none",
              }} />
            )}
            {showText && (
              <span style={{
                position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
                display: "flex",
                alignItems: widget.vAlign === "top" ? "flex-start" : widget.vAlign === "bottom" ? "flex-end" : "center",
                justifyContent: widget.align === "left" ? "flex-start" : widget.align === "right" ? "flex-end" : "center",
                fontFamily: widget.fontFamily ?? "Arial",
                fontSize: (widget.fontSize ?? 16) * scale,
                color: `#${((widget.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
                fontWeight: widget.fontBold ? 700 : 400,
                fontStyle: widget.fontItalic ? "italic" : "normal",
                padding: (widget.padding ?? 0) * scale,
                boxSizing: "border-box",
                pointerEvents: "none",
              }}>
                {widget.kind === "Dropdown"
                  ? (widget.options?.find((o) => o.value === widget.selectedValue)?.label ?? widget.text ?? "Pick…")
                  : (widget.text ?? "")}
              </span>
            )}
            {(widget.kind === "Inventory" || widget.kind === "Crafting" || widget.kind === "Shop") && (
              <InventoryGridPreview v={widget} scale={scale} />
            )}
            {widget.kind === "CraftGrid" && (
              <CraftGridPreview v={widget} scale={scale} />
            )}
          </div>
          <span style={{
            position: "absolute", bottom: 6, right: 8,
            fontSize: 9, color: "var(--text-faint)",
            fontFamily: "JetBrains Mono, monospace",
            letterSpacing: 0.4,
          }}>{widget.width}×{widget.height} · scale {scale.toFixed(2)}×</span>
        </div>
      </div>
    </Section>
  );
}

// ─── Multi mode editor ──────────────────────────────────────────────────────

// Logic + Bindings panel — shared by single mode (right column) and multi
// mode (right column, below the preview). The node graph edits inline and
// expands to a viewport overlay via the panel's own "⛶ Fullscreen" toggle.
function LogicPanel({ widget }: { widget: UIWidgetDef }) {
  const updateUIWidget = useEditor((s) => s.updateUIWidget);
  const folderCount = widget.logicSheet?.folders?.length ?? 0;
  const [logicExpanded, setLogicExpandedState] = useState<boolean>(() => {
    try { return localStorage.getItem("peaky.logic-expanded") !== "0"; } catch { return true; }
  });
  const setLogicExpanded = (v: boolean) => {
    setLogicExpandedState(v);
    try { localStorage.setItem("peaky.logic-expanded", v ? "1" : "0"); } catch { /* private mode */ }
  };
  // "⛶ Fullscreen" pins this same section to the viewport — the editor
  // element stays mounted, so its canvas state survives the toggle.
  const [logicFullscreen, setLogicFullscreen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Logic Sheet — inline node graph, expandable (same as the Blueprint
          editor). "⛶ Fullscreen" blows up the SAME editor element. */}
      <div
        style={logicFullscreen
          ? { position: "fixed", inset: 0, zIndex: 1000, background: "var(--frame)",
              padding: "10px 14px", display: "flex", flexDirection: "column" }
          : { display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 8 }}>
          {!logicFullscreen && (
            <button
              onClick={() => setLogicExpanded(!logicExpanded)}
              title={logicExpanded ? "Collapse Logic Sheet" : "Expand Logic Sheet"}
              style={{
                width: 18, height: 18, padding: 0, lineHeight: "16px", flexShrink: 0,
                background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, color: "var(--text)", cursor: "pointer", fontSize: 9,
              }}
            >{logicExpanded ? "▾" : "▸"}</button>
          )}
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1 }}>
            🧩 Logic Sheet{" "}
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400 }}>
              ({folderCount} group{folderCount === 1 ? "" : "s"})
            </span>
          </h3>
          <button
            onClick={() => { setLogicFullscreen((v) => !v); setLogicExpanded(true); }}
            title={logicFullscreen ? "Exit fullscreen" : "Edit fullscreen"}
            style={{
              padding: "3px 8px", fontSize: 11, background: "transparent",
              border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4,
              color: "var(--text-dim)", cursor: "pointer",
            }}
          >{logicFullscreen ? "❐ Exit fullscreen" : "⛶ Fullscreen"}</button>
        </div>
        {(logicExpanded || logicFullscreen) && (
          <div style={{
            ...(logicFullscreen ? { flex: 1 } : { height: 460 }),
            display: "flex", minHeight: 0,
            border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, overflow: "hidden",
          }}>
            <LogicSheetEditor
              bp={widget}
              onCommitSheet={(sheet) => updateUIWidget(widget.id, { logicSheet: sheet })}
            />
          </div>
        )}
      </div>
      <div style={{ marginTop: 4, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 14 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Bindings</h3>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
          Declarative reactive bindings — bind a child's property (text / value /
          visible / bgColor / enabled) to a BP variable or expression. No node graph needed.
        </div>
        <WidgetBindingsTable widget={widget} onPatch={(p) => updateUIWidget(widget.id, p)} />
      </div>
    </div>
  );
}

function MultiModeEditor({
  widget, viewportW, viewportH,
}: {
  widget: UIWidgetDef;
  viewportW: number;
  viewportH: number;
}) {
  const sprites = useEditor((s) => s.project.sprites);
  const addUIWidgetChild = useEditor((s) => s.addUIWidgetChild);
  const updateUIWidgetChild = useEditor((s) => s.updateUIWidgetChild);
  const removeUIWidgetChild = useEditor((s) => s.removeUIWidgetChild);
  const setUIWidgetChildKind = useEditor((s) => s.setUIWidgetChildKind);
  const reorderUIWidgetChild = useEditor((s) => s.reorderUIWidgetChild);
  const updateUIWidget = useEditor((s) => s.updateUIWidget);

  // Multi-select: hold Set of ids, derive single-select state from it.
  // selectedChildId is the "primary" selection (last clicked) used by
  // the property panel — visible only when exactly one is selected.
  const [selectedChildIds, setSelectedChildIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);

  const selectedIdArray = Array.from(selectedChildIds);
  const selectedChildId = selectedIdArray.length === 1 ? selectedIdArray[0] : null;
  const selectedChild = selectedChildId ? widget.children.find((c) => c.id === selectedChildId) : undefined;

  // Selection helpers used by the canvas. Shift-click toggles; plain
  // click replaces; null = clear all.
  const selectChild = (id: string | null, modShift = false) => {
    setSelectedChildIds((prev) => {
      if (id === null) return new Set();
      if (modShift) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  };

  // Apply the parent widget's layout settings to its children — flex-
  // box-style packing in the chosen direction with the specified gap,
  // justify, and align. ONE-SHOT: computes new x/y for each child and
  // writes them as absolute positions. Author hits this after adding /
  // removing / resizing children to re-pack. Less brittle than a live
  // layout that owns positions (drag-to-override stays intuitive).
  const applyContainerLayout = () => {
    const dir = widget.layoutDirection ?? "none";
    // Only children opted INTO the layout are packed; ones flagged
    // `excludeFromLayout` (e.g. a full-size backdrop Image) keep their own
    // position and aren't counted in the flow.
    const items = widget.children.filter((c) => !c.excludeFromLayout);
    if (dir === "none" || items.length === 0) return;
    const gap = Math.max(0, widget.layoutGap ?? 0);
    const justify = widget.layoutJustify ?? "start";
    const align = widget.layoutAlign ?? "start";
    const VP_W = viewportW;
    const VP_H = viewportH;
    const isRow = dir === "row";
    // Major axis = direction of packing. Minor axis = cross.
    const majorSizes = items.map((c) => (isRow ? (c.width ?? 0) : (c.height ?? 0)));
    const totalMajor = majorSizes.reduce((s, n) => s + n, 0) + gap * (items.length - 1);
    const majorViewport = isRow ? VP_W : VP_H;
    const minorViewport = isRow ? VP_H : VP_W;
    let cursor = 0;
    let stepGap = gap;
    if (justify === "center") cursor = Math.max(0, (majorViewport - totalMajor) / 2);
    else if (justify === "end") cursor = Math.max(0, majorViewport - totalMajor);
    else if (justify === "spaceBetween" && items.length > 1) {
      cursor = 0;
      const totalChildSizes = majorSizes.reduce((s, n) => s + n, 0);
      stepGap = (majorViewport - totalChildSizes) / (items.length - 1);
    }
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const cMinor = isRow ? (c.height ?? 0) : (c.width ?? 0);
      let minorPos = 0;
      if (align === "center") minorPos = Math.max(0, (minorViewport - cMinor) / 2);
      else if (align === "end") minorPos = Math.max(0, minorViewport - cMinor);
      const x = isRow ? cursor : minorPos;
      const y = isRow ? minorPos : cursor;
      // Clear any per-child anchor — an anchored child ignores its x/y
      // (resolveChildPos pins it to the corner instead), so layout packing
      // would have no visible effect. Packing and anchoring are mutually
      // exclusive: laying out means the container owns the position.
      updateUIWidgetChild(widget.id, c.id, { x: Math.round(x), y: Math.round(y), anchorCorner: "" });
      cursor += majorSizes[i] + stepGap;
    }
  };

  // Align tools — operate on the current selection. Anchor is the
  // axis-extreme child (leftmost / topmost / rightmost / bottommost) or
  // the average for center-align. Distribute spaces out the in-between
  // children evenly between the first and last on the axis.
  const selectedChildren = widget.children.filter((c) => selectedChildIds.has(c.id));
  const alignChildren = (mode:
    | "left" | "centerH" | "right"
    | "top" | "centerV" | "bottom"
    | "distH" | "distV"
  ) => {
    if (selectedChildren.length < 2) return;
    const xs = selectedChildren.map((c) => c.x);
    const ys = selectedChildren.map((c) => c.y);
    const x2 = selectedChildren.map((c) => c.x + (c.width ?? 0));
    const y2 = selectedChildren.map((c) => c.y + (c.height ?? 0));
    if (mode === "left") {
      const a = Math.min(...xs);
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { x: a });
    } else if (mode === "right") {
      const a = Math.max(...x2);
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { x: a - (c.width ?? 0) });
    } else if (mode === "centerH") {
      const a = (Math.min(...xs) + Math.max(...x2)) / 2;
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { x: Math.round(a - (c.width ?? 0) / 2) });
    } else if (mode === "top") {
      const a = Math.min(...ys);
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { y: a });
    } else if (mode === "bottom") {
      const a = Math.max(...y2);
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { y: a - (c.height ?? 0) });
    } else if (mode === "centerV") {
      const a = (Math.min(...ys) + Math.max(...y2)) / 2;
      for (const c of selectedChildren) updateUIWidgetChild(widget.id, c.id, { y: Math.round(a - (c.height ?? 0) / 2) });
    } else if (mode === "distH" && selectedChildren.length >= 3) {
      const sorted = [...selectedChildren].sort((a, b) => a.x - b.x);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = last.x - first.x;
      const step = span / (sorted.length - 1);
      sorted.forEach((c, i) => {
        if (i > 0 && i < sorted.length - 1) updateUIWidgetChild(widget.id, c.id, { x: Math.round(first.x + step * i) });
      });
    } else if (mode === "distV" && selectedChildren.length >= 3) {
      const sorted = [...selectedChildren].sort((a, b) => a.y - b.y);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = last.y - first.y;
      const step = span / (sorted.length - 1);
      sorted.forEach((c, i) => {
        if (i > 0 && i < sorted.length - 1) updateUIWidgetChild(widget.id, c.id, { y: Math.round(first.y + step * i) });
      });
    }
  };

  // Canvas rendered at fit-to-pane scale × author-controlled zoom. The
  // fit-base keeps the initial view comfortable on common 800px-design
  // viewports; the zoom multiplier lets authors get closer for pixel
  // tweaks or pull back for full-screen HUD layouts. Persisted per
  // widget so the chosen zoom survives panel re-mounts.
  const PREVIEW_MAX_W = 760;
  const fitScale = Math.min(1, PREVIEW_MAX_W / viewportW);
  const [zoom, setZoom] = useState<number>(() => {
    try { return Number(localStorage.getItem(`peaky.uiwidget-zoom.${widget.id}`)) || 1; } catch { return 1; }
  });
  const setZoomPersist = (z: number) => {
    const clamped = Math.max(0.25, Math.min(4, z));
    setZoom(clamped);
    try { localStorage.setItem(`peaky.uiwidget-zoom.${widget.id}`, String(clamped)); } catch { /* private mode */ }
  };
  const previewScale = fitScale * zoom;

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(340px, 1fr) 1px minmax(420px, 1.15fr)", overflow: "hidden" }}>
      {/* LEFT — element selector (2-row tiles) + the selected element's
          properties. Selecting is one click on a tile; you only scroll
          WITHIN the properties, never back up to a list. */}
      <div style={{ overflow: "auto", padding: "16px 20px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
      <Section title={`Elements (${widget.children.length})`}>
        <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {widget.children.map((c) => {
            const sel = selectedChildIds.has(c.id);
            return (
              <button
                key={c.id}
                onClick={(e) => selectChild(c.id, e.shiftKey)}
                title={`${c.kind}${c.name ? ` "${c.name}"` : ""} — click to select${" (Shift+click to multi-select)"}`}
                style={{
                  width: 104, height: 42, padding: "4px 8px", flexShrink: 0,
                  display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
                  background: sel ? "var(--orange)" : "rgba(0,0,0,0.35)",
                  color: sel ? "#000" : "var(--text)",
                  border: sel ? "1px solid var(--orange)" : "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 6, cursor: "pointer", textAlign: "left", overflow: "hidden",
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{c.name || c.kind}</span>
                <span style={{ fontSize: 9, opacity: 0.7 }}>{c.kind}</span>
              </button>
            );
          })}
          <button
            onClick={() => setAddOpen((v) => !v)}
            title="Add a new element"
            style={{
              width: 104, height: 42, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "transparent", color: "var(--orange)", fontWeight: 700, fontSize: 12,
              border: "1px dashed rgba(255,165,0,0.5)", borderRadius: 6, cursor: "pointer",
            }}
          >+ Add</button>
        </div>
        {addOpen && (
          <div style={{ gridColumn: "1 / -1", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,165,0,0.3)", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {ALL_KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => {
                  const newId = addUIWidgetChild(widget.id, k.value, 40, 40);
                  setSelectedChildIds(new Set([newId]));
                  setAddOpen(false);
                }}
                style={addItemBtn}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,165,0,0.1)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <strong style={{ width: 110, color: "var(--text)" }}>{k.label}</strong>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{k.description}</span>
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* Container Layout — parent-widget flex-style packing. When
          direction != none, the "Apply Layout" button re-packs all
          children based on the configured direction / gap / justify /
          align. One-shot so dragging individual children still works
          (they stop being part of the auto-flow). */}
      <Section title="Container Layout (Multi parent)">
        <Field label="Direction">
          <select
            value={widget.layoutDirection ?? "none"}
            onChange={(e) => updateUIWidget(widget.id, { layoutDirection: e.target.value as "row" | "column" | "none" })}
            style={input}
          >
            <option value="none">None (absolute x/y)</option>
            <option value="row">Row (left → right)</option>
            <option value="column">Column (top → bottom)</option>
          </select>
        </Field>
        <Field label="Gap (px)">
          <Num value={widget.layoutGap ?? 8} onChange={(n) => updateUIWidget(widget.id, { layoutGap: Math.max(0, n) })} />
        </Field>
        <Field label="Justify (main axis)">
          <select
            value={widget.layoutJustify ?? "start"}
            onChange={(e) => updateUIWidget(widget.id, { layoutJustify: e.target.value as "start" | "center" | "end" | "spaceBetween" })}
            style={input}
          >
            <option value="start">Start</option>
            <option value="center">Center</option>
            <option value="end">End</option>
            <option value="spaceBetween">Space Between</option>
          </select>
        </Field>
        <Field label="Align (cross axis)">
          <select
            value={widget.layoutAlign ?? "start"}
            onChange={(e) => updateUIWidget(widget.id, { layoutAlign: e.target.value as "start" | "center" | "end" })}
            style={input}
          >
            <option value="start">Start</option>
            <option value="center">Center</option>
            <option value="end">End</option>
          </select>
        </Field>
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={applyContainerLayout}
            disabled={(widget.layoutDirection ?? "none") === "none" || widget.children.length === 0}
            style={{
              ...input, padding: "5px 14px", fontWeight: 600,
              cursor: ((widget.layoutDirection ?? "none") === "none" || widget.children.length === 0) ? "default" : "pointer",
              opacity: ((widget.layoutDirection ?? "none") === "none" || widget.children.length === 0) ? 0.4 : 1,
              color: "var(--orange)",
            }}
            title="Recompute every child's x/y based on the layout settings. One-shot — after this, you can drag children individually and the layout WON'T re-flow. Hit Apply again to re-pack."
          >▦ Apply Layout to Children</button>
          <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Auto-arranges children based on direction / gap / justify / align.
            Children stay individually draggable after.
          </span>
        </div>
      </Section>

      {/* Multi-selection panel — alignment + distribution tools. Visible
          only when 2+ children are selected. Single-selected children
          fall through to the regular property panel below. */}
      {selectedChildIds.size >= 2 && (
        <Section title={`${selectedChildIds.size} elements selected`}>
          <Field label="Align Horizontal">
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <button onClick={() => alignChildren("left")}    title="Align left edges"    style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>⊢ Left</button>
              <button onClick={() => alignChildren("centerH")} title="Center horizontally" style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>↔ Center</button>
              <button onClick={() => alignChildren("right")}   title="Align right edges"   style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>⊣ Right</button>
            </div>
          </Field>
          <Field label="Align Vertical">
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <button onClick={() => alignChildren("top")}     title="Align top edges"     style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>⊤ Top</button>
              <button onClick={() => alignChildren("centerV")} title="Center vertically"   style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>↕ Middle</button>
              <button onClick={() => alignChildren("bottom")}  title="Align bottom edges"  style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}>⊥ Bottom</button>
            </div>
          </Field>
          <Field label="Distribute (3+)">
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <button onClick={() => alignChildren("distH")} disabled={selectedChildIds.size < 3} title="Even horizontal spacing between first and last" style={{ ...input, padding: "3px 8px", cursor: selectedChildIds.size < 3 ? "default" : "pointer", fontSize: 10, opacity: selectedChildIds.size < 3 ? 0.4 : 1 }}>↔↔ Horiz</button>
              <button onClick={() => alignChildren("distV")} disabled={selectedChildIds.size < 3} title="Even vertical spacing between first and last" style={{ ...input, padding: "3px 8px", cursor: selectedChildIds.size < 3 ? "default" : "pointer", fontSize: 10, opacity: selectedChildIds.size < 3 ? 0.4 : 1 }}>↕↕ Vert</button>
            </div>
          </Field>
          <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text-dim)", padding: "4px 0", lineHeight: 1.5 }}>
            Shift+Click in the canvas to add/remove from selection. Drag any selected element to move ALL of them together.
          </div>
        </Section>
      )}

      {/* Child properties — split into sibling Sections (NOT nested
          inside one big Section, otherwise their grids fight the outer
          one and labels overlap fields visually). */}
      {selectedChild ? (
        <>
          <Section title={`Selected: ${selectedChild.kind}${selectedChild.name ? ` "${selectedChild.name}"` : ""}`}>
            <Field label="Name (optional)">
              <input
                value={selectedChild.name ?? ""}
                onChange={(e) => updateUIWidgetChild(widget.id, selectedChild.id, { name: e.target.value || undefined })}
                placeholder="StartButton"
                style={input}
              />
            </Field>
            <Field label="Kind">
              <select
                value={selectedChild.kind}
                onChange={(e) => setUIWidgetChildKind(widget.id, selectedChild.id, e.target.value as UIWidgetKind)}
                style={input}
              >
                {ALL_KINDS.map((k) => (<option key={k.value} value={k.value}>{k.label}</option>))}
              </select>
            </Field>
            <Field label="Position X"><Num value={selectedChild.x} onChange={(n) => updateUIWidgetChild(widget.id, selectedChild.id, { x: n })} /></Field>
            <Field label="Position Y"><Num value={selectedChild.y} onChange={(n) => updateUIWidgetChild(widget.id, selectedChild.id, { y: n })} /></Field>
            <Field label="Affected by layout">
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                <Toggle
                  value={!selectedChild.excludeFromLayout}
                  onChange={(v) => updateUIWidgetChild(widget.id, selectedChild.id, { excludeFromLayout: !v })}
                />
                Apply Layout moves this element
              </label>
            </Field>
            <Field label={`Z-Order (${widget.children.findIndex((c) => c.id === selectedChild.id) + 1} of ${widget.children.length})`}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                <button
                  onClick={() => reorderUIWidgetChild(widget.id, selectedChild.id, 0)}
                  title="Send to back — this child renders first (under all others)"
                  style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
                >⤓ Back</button>
                <button
                  onClick={() => {
                    const i = widget.children.findIndex((c) => c.id === selectedChild.id);
                    if (i > 0) reorderUIWidgetChild(widget.id, selectedChild.id, i - 1);
                  }}
                  title="Move down one layer"
                  style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
                >↓</button>
                <button
                  onClick={() => {
                    const i = widget.children.findIndex((c) => c.id === selectedChild.id);
                    if (i < widget.children.length - 1) reorderUIWidgetChild(widget.id, selectedChild.id, i + 1);
                  }}
                  title="Move up one layer"
                  style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
                >↑</button>
                <button
                  onClick={() => reorderUIWidgetChild(widget.id, selectedChild.id, widget.children.length - 1)}
                  title="Bring to front — this child renders last (on top of all others)"
                  style={{ ...input, padding: "3px 8px", cursor: "pointer", fontSize: 10 }}
                >⤒ Front</button>
              </div>
            </Field>
          </Section>

          <VisualEditor
            visual={selectedChild}
            onPatch={(p) => updateUIWidgetChild(widget.id, selectedChild.id, p as Partial<UIWidgetChild>)}
            sprites={sprites}
            scope={`${widget.id}.${selectedChild.id}`}
          />

          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <button
              onClick={() => {
                if (window.confirm(`Delete ${selectedChild.kind}?`)) {
                  removeUIWidgetChild(widget.id, selectedChild.id);
                  setSelectedChildIds(new Set());
                }
              }}
              style={{ ...input, padding: "6px 14px", color: "var(--orange)", cursor: "pointer", fontWeight: 600 }}
            >Delete element</button>
          </div>
        </>
      ) : selectedChildIds.size === 0 ? (
        <div style={{ ...hint, padding: "12px 16px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 6 }}>
          No element selected. Click a tile above (or an element on the preview) to edit it, Shift+click for multiple, or hit <b>+ Add</b> to drop a new one.
        </div>
      ) : null /* multi-select panel above renders instead */}
      </div>{/* end LEFT */}

      <div style={{ background: "rgba(255,255,255,0.06)" }} />

      {/* RIGHT — live preview canvas on top, Logic + Bindings below */}
      <div style={{ overflow: "auto", padding: "16px 20px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        <Section title="Preview">
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1 }}>
                Viewport {viewportW}×{viewportH} · {Math.round(previewScale * 100)}% · drag elements to arrange
              </span>
              <div style={{ display: "inline-flex", gap: 2, alignItems: "center", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, overflow: "hidden" }}>
                <button
                  onClick={() => setZoomPersist(zoom / 1.25)}
                  title="Zoom out (Ctrl+Scroll on canvas)"
                  style={{ fontSize: 11, padding: "2px 8px", background: "rgba(0,0,0,0.3)", color: "var(--text)", border: "none", cursor: "pointer" }}
                >−</button>
                <button
                  onClick={() => setZoomPersist(1)}
                  title="Reset zoom to fit"
                  style={{ fontSize: 10, padding: "2px 6px", background: "rgba(0,0,0,0.3)", color: "var(--text-muted)", border: "none", cursor: "pointer", minWidth: 38 }}
                >{Math.round(zoom * 100)}%</button>
                <button
                  onClick={() => setZoomPersist(zoom * 1.25)}
                  title="Zoom in (Ctrl+Scroll on canvas)"
                  style={{ fontSize: 11, padding: "2px 8px", background: "rgba(0,0,0,0.3)", color: "var(--text)", border: "none", cursor: "pointer" }}
                >+</button>
              </div>
            </div>
            <div
              onWheel={(e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                e.preventDefault();
                e.stopPropagation();
                const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
                setZoomPersist(zoom * factor);
              }}
              style={{ overflow: "auto", maxWidth: "100%", maxHeight: 560 }}
            >
            <ViewportCanvas
              widget={widget}
              viewportW={viewportW}
              viewportH={viewportH}
              scale={previewScale}
              sprites={sprites}
              selectedChildIds={selectedChildIds}
              onSelectChild={selectChild}
              onMoveSelected={(dx, dy) => {
                // Read fresh child positions from the store each step.
                // selectedChildren / widget.children are from the render
                // where mousedown fired — using `c.x` from that snapshot
                // makes every step add the (tiny) delta to the original
                // position, so the child appears stuck after the first
                // pixel. getState() gives us the just-updated x/y.
                const freshWidget = useEditor.getState().project.uiWidgets.find((w) => w.id === widget.id);
                if (!freshWidget) return;
                for (const id of selectedChildIds) {
                  const c = freshWidget.children.find((ch) => ch.id === id);
                  if (!c) continue;
                  const isAnchored = !!c.anchorCorner;
                  if (isAnchored) {
                    updateUIWidgetChild(widget.id, c.id, {
                      anchorOffsetX: Math.round((c.anchorOffsetX ?? 0) + dx),
                      anchorOffsetY: Math.round((c.anchorOffsetY ?? 0) + dy),
                    });
                  } else {
                    updateUIWidgetChild(widget.id, c.id, {
                      x: Math.round(c.x + dx),
                      y: Math.round(c.y + dy),
                    });
                  }
                }
              }}
              onPatchChild={(id, patch) => updateUIWidgetChild(widget.id, id, patch)}
            />
            </div>
          </div>
        </Section>
        <LogicPanel widget={widget} />
      </div>
    </div>
  );
}

// ─── Viewport canvas (multi mode) ───────────────────────────────────────────

/** Resolve a child's effective top-left position in viewport pixels.
 *  When `anchorCorner` is set, the child snaps to that corner of the
 *  viewport (with offsets) — matches the runtime UIWidgetRenderer.init()
 *  math so the editor preview shows exactly what runtime renders.
 *  When no anchor is set, we use the child's authored x/y. */
function resolveChildPos(child: UIWidgetChild, viewportW: number, viewportH: number): { left: number; top: number } {
  if (!child.anchorCorner) {
    return { left: child.x, top: child.y };
  }
  const ox = child.anchorOffsetX ?? 0;
  const oy = child.anchorOffsetY ?? 0;
  // Anchor pins the corresponding CORNER of the child to the corner
  // of the viewport — top-left in viewport pixels for each anchor:
  //   TL → (0,         0)
  //   TC → (vw-W)/2,   0
  //   TR → vw - W,     0
  //   ML → 0,          (vh-H)/2
  //   C  → (vw-W)/2,   (vh-H)/2
  //   MR → vw - W,     (vh-H)/2
  //   BL → 0,          vh - H
  //   BC → (vw-W)/2,   vh - H
  //   BR → vw - W,     vh - H
  const W = child.width;
  const H = child.height;
  let left = 0, top = 0;
  switch (child.anchorCorner) {
    case "TL": left = 0;             top = 0;             break;
    case "TC": left = (viewportW - W) / 2; top = 0;       break;
    case "TR": left = viewportW - W; top = 0;             break;
    case "ML": left = 0;             top = (viewportH - H) / 2; break;
    case "C":  left = (viewportW - W) / 2; top = (viewportH - H) / 2; break;
    case "MR": left = viewportW - W; top = (viewportH - H) / 2; break;
    case "BL": left = 0;             top = viewportH - H; break;
    case "BC": left = (viewportW - W) / 2; top = viewportH - H; break;
    case "BR": left = viewportW - W; top = viewportH - H; break;
  }
  return { left: left + ox, top: top + oy };
}

function ViewportCanvas({
  widget, viewportW, viewportH, scale, sprites,
  selectedChildIds, onSelectChild, onMoveSelected, onPatchChild,
}: {
  widget: UIWidgetDef;
  viewportW: number;
  viewportH: number;
  scale: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sprites: any[];
  selectedChildIds: Set<string>;
  onSelectChild: (id: string | null, modShift?: boolean) => void;
  /** Move every selected child by (dx, dy). Called instead of
   *  onPatchChild when 2+ are selected — keeps the group moving as a
   *  unit. dx/dy are in widget-coords (already un-scaled). */
  onMoveSelected: (dx: number, dy: number) => void;
  onPatchChild: (id: string, patch: Partial<UIWidgetChild>) => void;
}) {
  const onChildMouseDown = (e: React.MouseEvent, child: UIWidgetChild) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const isMulti = selectedChildIds.size >= 2 && selectedChildIds.has(child.id);
    // Shift = toggle in/out of selection (no drag — author is selecting).
    // Plain click on an already-multi-selected child = start group drag.
    // Plain click on a single (or different) child = single-select + drag.
    if (e.shiftKey) {
      onSelectChild(child.id, true);
      return;
    }
    if (!isMulti) onSelectChild(child.id);
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    // When anchor is set, dragging adjusts the anchor's offset (so the
    // visible result tracks the cursor — raw x/y would be ignored by
    // the anchor math). When no anchor is set, plain absolute x/y.
    const isAnchored = !!child.anchorCorner;
    const startX = isAnchored ? (child.anchorOffsetX ?? 0) : child.x;
    const startY = isAnchored ? (child.anchorOffsetY ?? 0) : child.y;
    let lastDx = 0, lastDy = 0;
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startClientX) / scale;
      const dy = (ev.clientY - startClientY) / scale;
      if (isMulti) {
        // Group drag — apply DELTA from the previous tick so every
        // selected child moves together by the same amount. Avoids
        // diverging if any child started at a different offset.
        const stepDx = dx - lastDx;
        const stepDy = dy - lastDy;
        lastDx = dx;
        lastDy = dy;
        if (stepDx !== 0 || stepDy !== 0) onMoveSelected(stepDx, stepDy);
        return;
      }
      const nx = Math.round(startX + dx);
      const ny = Math.round(startY + dy);
      if (isAnchored) {
        onPatchChild(child.id, { anchorOffsetX: nx, anchorOffsetY: ny });
      } else {
        onPatchChild(child.id, { x: nx, y: ny });
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={() => onSelectChild(null)}
      style={{
        position: "relative",
        width:  Math.round(viewportW * scale),
        height: Math.round(viewportH * scale),
        // Checkerboard background so backdrop-filter:blur on a
        // semi-transparent widget actually shows a visible effect
        // (uniform black would be uniform after blur — invisible).
        backgroundColor: "#1a1a24",
        backgroundImage:
          "linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%), " +
          "linear-gradient(-45deg, rgba(255,255,255,0.06) 25%, transparent 25%), " +
          "linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.06) 75%), " +
          "linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.06) 75%)",
        backgroundSize: "20px 20px",
        backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
        border: "2px solid rgba(255,165,0,0.5)",
        borderRadius: 4,
        overflow: "hidden",
        // `isolation: isolate` creates a fresh stacking context, which
        // Chromium needs for backdrop-filter to render reliably under
        // an overflow:hidden parent.
        isolation: "isolate",
        userSelect: "none",
      }}
    >
      {widget.children.map((child) => (
        <ChildPreview
          key={child.id}
          child={child}
          scale={scale}
          viewportW={viewportW}
          viewportH={viewportH}
          selected={selectedChildIds.has(child.id)}
          onMouseDown={(e) => onChildMouseDown(e, child)}
          onResize={(size) => onPatchChild(child.id, size)}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          spriteFirstFrame={(sprites as any).find((sp: { id: string }) => sp.id === child.spriteId)?.animations?.[0]?.frames?.[0]?.image}
        />
      ))}
    </div>
  );
}

/** Build CSS borderRadius / boxShadow / backdropFilter strings from a
 *  UIWidgetVisual's style fields. Used by both the UIWidgetTab canvas
 *  and the SceneEditor preview so editor visuals match runtime. */
export function visualCssStyle(v: UIWidgetVisual, scale: number): {
  borderRadius: string;
  boxShadow: string | undefined;
  backdropFilter: string | undefined;
} {
  const rTL = v.cornersSeparate ? (v.cornerRadiusTL ?? 0) : (v.cornerRadius ?? 0);
  const rTR = v.cornersSeparate ? (v.cornerRadiusTR ?? 0) : (v.cornerRadius ?? 0);
  const rBR = v.cornersSeparate ? (v.cornerRadiusBR ?? 0) : (v.cornerRadius ?? 0);
  const rBL = v.cornersSeparate ? (v.cornerRadiusBL ?? 0) : (v.cornerRadius ?? 0);
  const borderRadius = `${rTL * scale}px ${rTR * scale}px ${rBR * scale}px ${rBL * scale}px`;
  let boxShadow: string | undefined;
  if (v.shadowEnabled) {
    const sc = `#${((v.shadowColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
    const sa = Math.max(0, Math.min(1, v.shadowAlpha ?? 0.4));
    const sx = (v.shadowOffsetX ?? 0) * scale;
    const sy = (v.shadowOffsetY ?? 6) * scale;
    const sb = (v.shadowBlur ?? 12) * scale;
    boxShadow = `${sx}px ${sy}px ${sb}px ${sc}${Math.round(sa * 255).toString(16).padStart(2, "0")}`;
  }
  // Backdrop blur was removed — it only worked in the editor preview, never
  // at runtime, which was misleading. Always undefined now.
  const backdropFilter = undefined;
  return { borderRadius, boxShadow, backdropFilter };
}

/** Inventory frame size, derived from the grid + padding (NOT the stored
 *  width/height, which can be stale after edits). Mirrors the runtime, which
 *  recomputes the frame from the grid every layout(). Use this for the editor
 *  preview box so all three views match exactly. */
export function inventoryFrameSize(v: UIWidgetVisual): { width: number; height: number } {
  const cols = Math.max(1, v.cols ?? 5);
  const rows = Math.max(1, v.rows ?? 1);
  const ss = v.slotSize ?? 48;
  const gap = v.slotGap ?? 4;
  const pad = v.padding ?? 0;
  return {
    width: cols * ss + (cols - 1) * gap + 2 * pad,
    height: rows * ss + (rows - 1) * gap + 2 * pad,
  };
}

/** The inventory slot grid, rendered identically in the widget-tab preview and
 *  the scene viewport. Geometry mirrors UIWidgetRenderer.slotRect exactly:
 *  fixed `slotSize` slots, `slotGap` gaps, NO outer padding, centered on the
 *  widget center, corner radius 4 — so editor previews match the Phaser
 *  runtime 1:1. The grid stays at its true (slotSize-derived) size and centers
 *  itself even if the surrounding box was resized, just like the runtime which
 *  centers the grid on the widget origin regardless of stored width/height. */
export function InventoryGridPreview({ v, scale }: { v: UIWidgetVisual; scale: number }) {
  const sprites = useEditor((s) => s.project.sprites);
  const cols = Math.max(1, v.cols ?? 5);
  const rows = Math.max(1, v.rows ?? 1);
  const slot = (v.slotSize ?? 48) * scale;
  const gap = (v.slotGap ?? 4) * scale;
  const slotBg = `#${((v.slotBgColor ?? 0x222831) & 0xffffff).toString(16).padStart(6, "0")}`;
  const slotBorderColor = `#${((v.slotBorderColor ?? 0x404552) & 0xffffff).toString(16).padStart(6, "0")}`;
  const slotBorderW = (v.slotBorderWidth ?? 1) * scale;
  const slotRadius = Math.max(0, Math.min((v.slotSize ?? 48) / 2, v.slotRadius ?? 0)) * scale;
  // Resolve a (sprite, anim, frame) pick to a frame data-URL for preview.
  // Animated (frame -1) previews frame 0. Returns the on-disk path so the
  // outer hook can batch-resolve to blob URLs via AssetStore.
  const framePathOf = (spriteId?: string, animId?: string, frame?: number): string | undefined => {
    if (!spriteId) return undefined;
    const sp = sprites.find((s) => s.id === spriteId);
    const anim = sp?.animations.find((a) => a.id === animId) ?? sp?.animations[0];
    if (!anim || !sp) return undefined;
    const idx = frame === -1 || frame == null ? 0 : Math.max(0, Math.min(frame, anim.frames.length - 1));
    const file = anim.frames[idx]?.imageFile;
    return file ? spriteFrameDiskPath(sp, file) : undefined;
  };
  const slotPath = framePathOf(v.slotBgSpriteId, v.slotBgAnim, v.slotBgFrame);
  const panelPath = framePathOf(v.panelSpriteId, v.panelAnim, v.panelFrame);
  const urls = useAssetURLs([slotPath, panelPath]);
  const slotImg = slotPath ? urls.get(slotPath) : undefined;
  const panelImg = panelPath ? urls.get(panelPath) : undefined;
  return (
    <>
      {panelImg && (
        <img src={panelImg} alt="" draggable={false} style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "fill", imageRendering: "pixelated", pointerEvents: "none",
        }} />
      )}
      <div style={{
        position: "absolute",
        left: "50%", top: "50%",
        transform: "translate(-50%, -50%)",
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${slot}px)`,
        gridTemplateRows: `repeat(${rows}, ${slot}px)`,
        gap: `${gap}px`,
        pointerEvents: "none",
      }}>
        {Array.from({ length: rows * cols }).map((_, i) => (
          <div key={i} className="wradius" style={{
            width: slot, height: slot,
            // Sprite slot bg stretches to the slot (matches runtime); else colors.
            ...(slotImg
              ? { backgroundImage: `url(${slotImg})`, backgroundSize: "100% 100%", imageRendering: "pixelated" as const }
              : { background: slotBg, border: slotBorderW > 0 ? `${slotBorderW}px solid ${slotBorderColor}` : "none", borderRadius: slotRadius }),
            boxSizing: "border-box",
          }} />
        ))}
      </div>
    </>
  );
}

/** CraftGrid frame size = input grid + arrow gap + result slot + frame padding.
 *  Mirrors UIWidgetRenderer's CraftGrid layout. */
export function craftGridFrameSize(v: UIWidgetVisual): { width: number; height: number } {
  const cols = Math.max(1, v.cols ?? 2);
  const rows = Math.max(1, v.rows ?? 2);
  const ss = v.slotSize ?? 48;
  const gap = v.slotGap ?? 4;
  const pad = v.padding ?? 0;
  const rg = v.resultGap ?? 24;
  const gridW = cols * ss + (cols - 1) * gap;
  const gridH = rows * ss + (rows - 1) * gap;
  return { width: gridW + rg + ss + 2 * pad, height: Math.max(gridH, ss) + 2 * pad };
}

/** CraftGrid preview: left input grid + an arrow + a single result slot. Mirrors
 *  the runtime layout (grid left-justified, result slot to the right). When a
 *  slot bg sprite / arrow sprite is set, paints those instead so the editor
 *  preview matches the in-game widget 1:1. */
export function CraftGridPreview({ v, scale }: { v: UIWidgetVisual; scale: number }) {
  const sprites = useEditor((s) => s.project.sprites);
  const slot = (v.slotSize ?? 48) * scale;
  const slotBg = `#${((v.slotBgColor ?? 0x222831) & 0xffffff).toString(16).padStart(6, "0")}`;
  const slotBorderColor = `#${((v.slotBorderColor ?? 0x404552) & 0xffffff).toString(16).padStart(6, "0")}`;
  const slotBorderW = (v.slotBorderWidth ?? 1) * scale;
  const slotRadius = Math.max(0, Math.min((v.slotSize ?? 48) / 2, v.slotRadius ?? 0)) * scale;
  const pad = (v.padding ?? 0) * scale;
  const rg = (v.resultGap ?? 24) * scale;
  const framePathOf = (spriteId?: string, animId?: string, frame?: number): string | undefined => {
    if (!spriteId) return undefined;
    const sp = sprites.find((s) => s.id === spriteId);
    const anim = sp?.animations.find((a) => a.id === animId) ?? sp?.animations[0];
    if (!anim || !sp) return undefined;
    const idx = frame === -1 || frame == null ? 0 : Math.max(0, Math.min(frame, anim.frames.length - 1));
    const file = anim.frames[idx]?.imageFile;
    return file ? spriteFrameDiskPath(sp, file) : undefined;
  };
  const slotPath = framePathOf(v.slotBgSpriteId, v.slotBgAnim, v.slotBgFrame);
  const arrowPath = framePathOf(v.craftArrowSpriteId, v.craftArrowAnim, v.craftArrowFrame);
  const urls = useAssetURLs([slotPath, arrowPath]);
  const slotSpriteImg = slotPath ? urls.get(slotPath) : undefined;
  const arrowSpriteImg = arrowPath ? urls.get(arrowPath) : undefined;
  return (
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", alignItems: "center", justifyContent: "flex-start",
      padding: pad, gap: rg, boxSizing: "border-box",
      pointerEvents: "none",
    }}>
      <div style={{ position: "relative" }}>
        <InventoryGridPreview v={v} scale={scale} />
        {/* spacer to give the centered grid its true size inside the flex row */}
        <div style={{ width: craftGridInnerGridW(v) * scale, height: craftGridInnerGridH(v) * scale }} />
      </div>
      {arrowSpriteImg
        ? <img src={arrowSpriteImg} alt="" draggable={false} style={{ width: slot * 0.5, height: slot * 0.5, objectFit: "fill", imageRendering: "pixelated" }} />
        : <span style={{ color: "#aab", fontSize: slot * 0.4 }}>▸</span>}
      {slotSpriteImg ? (
        <img src={slotSpriteImg} alt="" draggable={false} style={{
          width: slot, height: slot,
          objectFit: "fill", imageRendering: "pixelated",
        }} />
      ) : (
        <div className="wradius" style={{
          width: slot, height: slot,
          background: slotBg,
          border: slotBorderW > 0 ? `${slotBorderW}px solid ${slotBorderColor}` : "none",
          borderRadius: slotRadius,
          boxSizing: "border-box",
        }} />
      )}
    </div>
  );
}
function craftGridInnerGridW(v: UIWidgetVisual): number {
  const cols = Math.max(1, v.cols ?? 2);
  return cols * (v.slotSize ?? 48) + (cols - 1) * (v.slotGap ?? 4);
}
function craftGridInnerGridH(v: UIWidgetVisual): number {
  const rows = Math.max(1, v.rows ?? 2);
  return rows * (v.slotSize ?? 48) + (rows - 1) * (v.slotGap ?? 4);
}

function ChildPreview({
  child, scale, viewportW, viewportH, selected, onMouseDown, onResize, spriteFirstFrame,
}: {
  child: UIWidgetChild;
  scale: number;
  viewportW: number;
  viewportH: number;
  selected: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onResize?: (size: { width: number; height: number }) => void;
  spriteFirstFrame?: string;
}) {
  const bgColor = child.bgColor ?? 0;
  const bgAlpha = child.bgAlpha ?? (child.bgColor !== undefined ? 1 : 0);
  const bgHex = `#${(bgColor & 0xffffff).toString(16).padStart(6, "0")}`;
  const borderHex = `#${((child.borderColor ?? 0) & 0xffffff).toString(16).padStart(6, "0")}`;
  const css = visualCssStyle(child, scale);
  // Inventory child: size the frame from the grid + padding (matches runtime,
  // which ignores the stored child size) and clamp the frame radius.
  const invFrame = child.kind === "CraftGrid" ? craftGridFrameSize(child)
    : (child.kind === "Inventory" || child.kind === "Crafting" || child.kind === "Shop") ? inventoryFrameSize(child) : null;
  const childBorderRadius = invFrame
    ? `${Math.min(child.cornerRadius ?? 0, Math.min(invFrame.width, invFrame.height) / 2) * scale}px`
    : css.borderRadius;
  const showText = child.kind === "Label" || child.kind === "Button" || child.kind === "Dropdown";
  // Slider/ProgressBar fill ratio
  let fillT = 0;
  if (child.kind === "Slider" || child.kind === "ProgressBar") {
    const min = child.min ?? 0;
    const max = child.max ?? 100;
    const span = max - min;
    fillT = typeof child.value === "number" && span > 0
      ? Math.max(0, Math.min(1, (child.value - min) / span))
      : 0.5;
  }
  const fillHex = `#${((child.fillColor ?? 0x44ddff) & 0xffffff).toString(16).padStart(6, "0")}`;

  return (
    <div
      onMouseDown={onMouseDown}
      className="wradius"
      style={{
        position: "absolute",
        // Use the SAME anchor math the runtime uses, so authored
        // anchorCorner / offset values preview at the right canvas
        // position (was rendering at raw x/y before — anchor was
        // ignored at edit time, only applied at runtime).
        left: resolveChildPos(child, viewportW, viewportH).left * scale,
        top:  resolveChildPos(child, viewportW, viewportH).top  * scale,
        width:  (invFrame ? invFrame.width  : child.width)  * scale,
        height: (invFrame ? invFrame.height : child.height) * scale,
        background: bgAlpha > 0 ? `${bgHex}${alphaHex(bgAlpha)}` : "transparent",
        border: selected
          ? "2px solid var(--yellow)"
          : (child.borderWidth ?? 0) > 0 ? `${child.borderWidth}px solid ${borderHex}` : "1px dashed rgba(255,255,255,0.15)",
        cursor: "grab",
        boxSizing: "border-box",
        overflow: "hidden",
        borderRadius: childBorderRadius,
        boxShadow: css.boxShadow,
        backdropFilter: css.backdropFilter,
        WebkitBackdropFilter: css.backdropFilter,
      }}
      title={`${child.kind}${child.name ? ` · ${child.name}` : ""}`}
    >
      {child.kind === "Image" && spriteFirstFrame && (
        <img src={spriteFirstFrame} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "fill", imageRendering: "pixelated", pointerEvents: "none" }} />
      )}
      {(child.kind === "Inventory" || child.kind === "Crafting" || child.kind === "Shop") && (
        <InventoryGridPreview v={child} scale={scale} />
      )}
      {child.kind === "CraftGrid" && (
        <CraftGridPreview v={child} scale={scale} />
      )}
      {(child.kind === "Slider" || child.kind === "ProgressBar") && child.direction !== "vertical" && (
        <div style={{ position: "absolute", left: 0, top: 0, width: `${fillT * 100}%`, height: "100%", background: fillHex, pointerEvents: "none" }} />
      )}
      {(child.kind === "Slider" || child.kind === "ProgressBar") && child.direction === "vertical" && (
        <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: `${fillT * 100}%`, background: fillHex, pointerEvents: "none" }} />
      )}
      {showText && (
        <span style={{
          position: "absolute", left: 0, top: 0, width: "100%", height: "100%",
          display: "flex",
          alignItems: child.vAlign === "top" ? "flex-start" : child.vAlign === "bottom" ? "flex-end" : "center",
          justifyContent: child.align === "left" ? "flex-start" : child.align === "right" ? "flex-end" : "center",
          fontFamily: child.fontFamily ?? "Arial",
          fontSize: (child.fontSize ?? 14) * scale,
          color: `#${((child.fontColor ?? 0xffffff) & 0xffffff).toString(16).padStart(6, "0")}`,
          fontWeight: child.fontBold ? 700 : 400,
          fontStyle: child.fontItalic ? "italic" : "normal",
          padding: (child.padding ?? 0) * scale,
          boxSizing: "border-box",
          pointerEvents: "none",
        }}>
          {child.kind === "Dropdown"
            ? (child.options?.find((o) => o.value === child.selectedValue)?.label ?? child.text ?? "Pick…")
            : (child.text ?? "")}
        </span>
      )}
      {selected && onResize && (
        <div
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            // SE-corner drag-resize. Capture starting size + cursor in
            // canvas pixels (divide by `scale` to convert screen-space
            // movement to widget design units). Dispatches `onResize`
            // with the live size each pointermove; commit happens
            // implicitly via the parent setting child.width/height.
            const startW = child.width;
            const startH = child.height;
            const startX = e.clientX;
            const startY = e.clientY;
            const onMove = (mv: MouseEvent) => {
              const dx = (mv.clientX - startX) / scale;
              const dy = (mv.clientY - startY) / scale;
              onResize({
                width: Math.max(8, Math.round(startW + dx)),
                height: Math.max(8, Math.round(startH + dy)),
              });
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
          style={{
            position: "absolute",
            right: -5, bottom: -5,
            width: 10, height: 10,
            background: "var(--yellow)",
            border: "1px solid #000",
            cursor: "nwse-resize",
            zIndex: 2,
          }}
          title="Drag to resize"
        />
      )}
    </div>
  );
}

// ─── Visual fields editor (used by both Single + Multi-child) ───────────────

/**
 * Module-level "clipboard" for widget styles. Pure visual / look fields
 * only — explicit allow-list so paste from a Button onto a Dropdown
 * doesn't smear button-specific functional fields (signals, click mode)
 * onto the dropdown. The kind/element type stays whatever the target
 * already is.
 *
 * What flows on paste:
 *   • Size — width, height
 *   • Background — bgColor, bgAlpha
 *   • Border / frame / stroke — borderColor, borderWidth, padding
 *   • Corners — cornerRadius (uniform or per-corner), cornersSeparate
 *   • Shadow — color, alpha, blur, offset, enabled toggle
 *   • backdropBlur
 *   • Font — family, size, color, bold, italic, align, vAlign
 *   • Hover / pressed bg colors (visual only — they're rendered as
 *     state-tints by the renderer regardless of element kind)
 *
 * What does NOT flow (per-element, would change behavior):
 *   • id / name / kind — identity
 *   • x / y / anchor* — placement
 *   • text — label content
 *   • signal* — wiring (per-element signal names)
 *   • clickMode, readOnly — functional flags
 *   • value / min / max / direction (Slider/ProgressBar functional)
 *   • selectedValue, options (Dropdown content)
 *   • fillColor — Slider/ProgressBar-specific, semi-style but
 *     irrelevant on Button/Label/etc., kept per-element to avoid
 *     accidentally mass-changing a slider color from a button paste.
 *   • spriteId — Image content
 *
 * Lives outside React so the clipboard survives panel re-mounts
 * (switching widgets or children). Page reload clears it. Re-render
 * via a small subscription so the Paste button enables/disables
 * correctly.
 */
const STYLE_FIELDS: (keyof UIWidgetVisual)[] = [
  // Size
  "width", "height",
  // Background
  "bgColor", "bgAlpha",
  // Border / frame / stroke
  "borderColor", "borderWidth", "padding",
  // Corners
  "cornerRadius", "cornersSeparate",
  "cornerRadiusTL", "cornerRadiusTR", "cornerRadiusBL", "cornerRadiusBR",
  // Shadow
  "shadowEnabled", "shadowColor", "shadowAlpha", "shadowBlur",
  "shadowOffsetX", "shadowOffsetY",
  // Font
  "fontFamily", "fontSize", "fontColor", "fontBold", "fontItalic",
  "align", "vAlign",
  // Hover / pressed (state tints — renderer applies them based on kind)
  "hoverBgColor", "pressedBgColor",
];

let _styleClipboard: Partial<UIWidgetVisual> | null = null;
const _styleClipboardListeners = new Set<() => void>();
function setStyleClipboard(v: Partial<UIWidgetVisual> | null) {
  _styleClipboard = v;
  for (const fn of _styleClipboardListeners) fn();
}

function pickStyle(v: UIWidgetVisual): Partial<UIWidgetVisual> {
  const out: Partial<UIWidgetVisual> = {};
  for (const k of STYLE_FIELDS) {
    const value = v[k];
    if (value !== undefined) (out as Record<string, unknown>)[k] = value;
  }
  return out;
}

/**
 * Copy / Paste / Reset buttons for widget styles. Sits at the top of
 * the VisualEditor so users can copy one styled element's look and
 * stamp it onto siblings (5 buttons, same styling, no re-edit).
 */
function StyleClipboardBar({
  visual, onPatch,
}: {
  visual: UIWidgetVisual;
  onPatch: (p: Partial<UIWidgetVisual>) => void;
}) {
  // Subscribe to clipboard changes so the Paste button enables/disables
  // when copy is invoked elsewhere in the app.
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _styleClipboardListeners.add(fn);
    return () => { _styleClipboardListeners.delete(fn); };
  }, []);
  const hasClipboard = _styleClipboard !== null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 6px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 4 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4, paddingRight: 4 }}>Style</span>
      <button
        onClick={() => setStyleClipboard(pickStyle(visual))}
        title="Copy this element's style (colors, border, corners, shadow, font, etc.) to the clipboard. Paste onto another element to match."
        style={{ fontSize: 11, padding: "3px 8px", cursor: "pointer" }}
      >Copy</button>
      <button
        onClick={() => { if (_styleClipboard) onPatch({ ..._styleClipboard }); }}
        disabled={!hasClipboard}
        title={hasClipboard ? "Apply the copied style to this element. Other fields (size, position, kind, value) stay unchanged." : "Nothing copied yet — pick an element and click Copy first."}
        style={{ fontSize: 11, padding: "3px 8px", cursor: hasClipboard ? "pointer" : "default", opacity: hasClipboard ? 1 : 0.4 }}
      >Paste</button>
      {hasClipboard && (
        <button
          onClick={() => setStyleClipboard(null)}
          title="Clear the clipboard."
          style={{ fontSize: 11, padding: "3px 6px", cursor: "pointer", color: "var(--text-muted)" }}
        >Clear</button>
      )}
    </div>
  );
}

/**
 * Scoped Section wrapper — stable component identity (declared at module
 * level, not rebuilt per render). Inlining a wrapper component inside
 * VisualEditor caused React to see a different component type on every
 * keystroke and unmount the entire properties tree, which manifested as
 * inputs losing focus + scroll resetting after every typed character.
 */
function ScopedSection({ scope, title, children }: { scope: string; title: string; children: React.ReactNode }) {
  return <Section scope={scope} title={title}>{children}</Section>;
}

function VisualEditor({
  visual, onPatch, sprites, scope = "",
}: {
  visual: UIWidgetVisual;
  onPatch: (p: Partial<UIWidgetVisual>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sprites: any[];
  scope?: string;
}) {
  // Use the module-level ScopedSection directly — wrapping it in a
  // local component (created fresh each render) caused React to see
  // a different component identity on every keystroke and unmount
  // the properties tree, killing input focus.
  // Blueprint names — power the Inventory "Character" combobox (selectable
  // from the dropdown OR free-typed for tags / instance names).
  const blueprintNames = useEditor((s) => s.project.blueprints.map((b) => b.name).filter(Boolean));
  const itemNames = useEditor((s) => (s.project.items ?? []).map((i) => i.name).filter(Boolean));
  const charListId = `inv-char-${scope || "single"}`;
  // Inventory + Crafting + CraftGrid + Shop are grid widgets: auto-sized, no Size/Corners/Shadow.
  const isGrid = visual.kind === "Inventory" || visual.kind === "Crafting" || visual.kind === "CraftGrid" || visual.kind === "Shop";
  // Inventory auto-sizes to its grid — patch width/height from row/col config
  // so anchoring + scene placement + preview all track the real grid size.
  const patchInventory = (p: Partial<UIWidgetVisual>) => {
    if (visual.kind === "CraftGrid") {
      const { width, height } = craftGridFrameSize({ ...visual, ...p });
      onPatch({ ...p, width, height });
      return;
    }
    const cols = p.cols ?? visual.cols ?? 5;
    const rows = p.rows ?? visual.rows ?? 1;
    const ss = p.slotSize ?? visual.slotSize ?? 48;
    const gap = p.slotGap ?? visual.slotGap ?? 4;
    const pad = p.padding ?? visual.padding ?? 0;
    const width = cols * ss + (cols - 1) * gap + 2 * pad;
    const height = rows * ss + (rows - 1) * gap + 2 * pad;
    onPatch({ ...p, width, height });
  };
  return (
    <>
      <StyleClipboardBar visual={visual} onPatch={onPatch} />
      {!isGrid && (
        <ScopedSection scope={scope} title="Size">
          <Field label="Width"><Num value={visual.width} onChange={(n) => onPatch({ width: n })} /></Field>
          <Field label="Height"><Num value={visual.height} onChange={(n) => onPatch({ height: n })} /></Field>
        </ScopedSection>
      )}

      <ScopedSection scope={scope} title="Anchor (viewport corner)">
        <Field label="Corner">
          <AnchorGridPicker
            value={visual.anchorCorner ?? ""}
            onChange={(v) => onPatch({ anchorCorner: v || undefined })}
          />
        </Field>
        {visual.anchorCorner && (<>
          <Field label="Offset X"><Num value={visual.anchorOffsetX ?? 0} onChange={(n) => onPatch({ anchorOffsetX: n })} /></Field>
          <Field label="Offset Y"><Num value={visual.anchorOffsetY ?? 0} onChange={(n) => onPatch({ anchorOffsetY: n })} /></Field>
        </>)}
      </ScopedSection>

      <ScopedSection scope={scope} title="Background & border">
        <Field label="Bg color"><Color value={visual.bgColor ?? 0} onChange={(c) => onPatch({ bgColor: c })} /></Field>
        <Field label="Bg alpha"><Num value={visual.bgAlpha ?? 1} step={0.05} onChange={(n) => onPatch({ bgAlpha: Math.max(0, Math.min(1, n)) })} /></Field>
        <Field label="Border color"><Color value={visual.borderColor ?? 0} onChange={(c) => onPatch({ borderColor: c })} /></Field>
        <Field label="Border width"><Num value={visual.borderWidth ?? 0} onChange={(n) => onPatch({ borderWidth: n })} /></Field>
        <Field label={isGrid ? "Frame padding" : "Padding"}><Num value={visual.padding ?? 0} onChange={(n) => isGrid ? patchInventory({ padding: Math.max(0, n) }) : onPatch({ padding: n })} /></Field>
      </ScopedSection>

      {!isGrid && (
      <ScopedSection scope={scope} title="Corners">
        <Field label="Separate corners">
          <Toggle
            value={!!visual.cornersSeparate}
            onChange={(v) => onPatch({ cornersSeparate: v })}
          />
        </Field>
        {!visual.cornersSeparate ? (
          <Field label="Radius (uniform)"><Num value={visual.cornerRadius ?? 0} onChange={(n) => onPatch({ cornerRadius: Math.max(0, n) })} /></Field>
        ) : (<>
          <Field label="Top-left"><Num value={visual.cornerRadiusTL ?? 0} onChange={(n) => onPatch({ cornerRadiusTL: Math.max(0, n) })} /></Field>
          <Field label="Top-right"><Num value={visual.cornerRadiusTR ?? 0} onChange={(n) => onPatch({ cornerRadiusTR: Math.max(0, n) })} /></Field>
          <Field label="Bottom-left"><Num value={visual.cornerRadiusBL ?? 0} onChange={(n) => onPatch({ cornerRadiusBL: Math.max(0, n) })} /></Field>
          <Field label="Bottom-right"><Num value={visual.cornerRadiusBR ?? 0} onChange={(n) => onPatch({ cornerRadiusBR: Math.max(0, n) })} /></Field>
        </>)}
      </ScopedSection>
      )}

      {!isGrid && (
      <ScopedSection scope={scope} title="Shadow">
        <Field label="Shadow enabled">
          <Toggle
            value={!!visual.shadowEnabled}
            onChange={(v) => onPatch({ shadowEnabled: v })}
          />
        </Field>
        {visual.shadowEnabled && (<>
          <Field label="Shadow color"><Color value={visual.shadowColor ?? 0x000000} onChange={(c) => onPatch({ shadowColor: c })} /></Field>
          <Field label="Shadow alpha"><Num value={visual.shadowAlpha ?? 0.4} step={0.05} onChange={(n) => onPatch({ shadowAlpha: Math.max(0, Math.min(1, n)) })} /></Field>
          <Field label="Shadow softness"><Num value={visual.shadowBlur ?? 12} onChange={(n) => onPatch({ shadowBlur: Math.max(0, n) })} /></Field>
          <Field label="Offset X"><Num value={visual.shadowOffsetX ?? 0} onChange={(n) => onPatch({ shadowOffsetX: n })} /></Field>
          <Field label="Offset Y"><Num value={visual.shadowOffsetY ?? 6} onChange={(n) => onPatch({ shadowOffsetY: n })} /></Field>
        </>)}
      </ScopedSection>
      )}

      {(visual.kind === "Label" || visual.kind === "Button" || visual.kind === "Dropdown") && (
        <ScopedSection scope={scope} title="Text">
          <Field label="Content"><ExpressionField showPicker wrap="braces" value={visual.text ?? ""} onChange={(v) => onPatch({ text: v })} style={input} /></Field>
          <Field label="Font family"><FontFamilyInput value={visual.fontFamily ?? "Arial"} onChange={(v) => onPatch({ fontFamily: v })} style={input} /></Field>
          <Field label="Font size"><Num value={visual.fontSize ?? 16} onChange={(n) => onPatch({ fontSize: n })} /></Field>
          <Field label="Font color"><Color value={visual.fontColor ?? 0xffffff} onChange={(c) => onPatch({ fontColor: c })} /></Field>
          <Field label="Bold"><Toggle value={!!visual.fontBold} onChange={(v) => onPatch({ fontBold: v })} /></Field>
          <Field label="Italic"><Toggle value={!!visual.fontItalic} onChange={(v) => onPatch({ fontItalic: v })} /></Field>
          <Field label="Align (H)">
            <select value={visual.align ?? "center"} onChange={(e) => onPatch({ align: e.target.value as "left" | "center" | "right" })} style={input}>
              <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
            </select>
          </Field>
          <Field label="Align (V)">
            <select value={visual.vAlign ?? "middle"} onChange={(e) => onPatch({ vAlign: e.target.value as "top" | "middle" | "bottom" })} style={input}>
              <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
            </select>
          </Field>
        </ScopedSection>
      )}

      {visual.kind === "Button" && (
        <ScopedSection scope={scope} title="Button behavior">
          <Field label="Click mode">
            <select value={visual.clickMode ?? "single"} onChange={(e) => onPatch({ clickMode: e.target.value as "single" | "double" })} style={input}>
              <option value="single">Single click</option>
              <option value="double">Double click</option>
            </select>
          </Field>
          <Field label="Signal on click">
            <SignalPicker value={visual.signalOnClick ?? ""} onChange={(v) => onPatch({ signalOnClick: v })} placeholder="ButtonClicked" mode="emit" style={{ width: "100%" }} />
          </Field>
          <Field label="Signal on hover">
            <SignalPicker value={visual.signalOnHover ?? ""} onChange={(v) => onPatch({ signalOnHover: v })} placeholder="ButtonHover" mode="emit" style={{ width: "100%" }} />
          </Field>
          <Field label="Signal on leave">
            <SignalPicker value={visual.signalOnLeave ?? ""} onChange={(v) => onPatch({ signalOnLeave: v })} placeholder="ButtonLeave" mode="emit" style={{ width: "100%" }} />
          </Field>
          <Field label="Hover bg color"><Color value={visual.hoverBgColor ?? visual.bgColor ?? 0} onChange={(c) => onPatch({ hoverBgColor: c })} /></Field>
          <Field label="Pressed bg color"><Color value={visual.pressedBgColor ?? visual.bgColor ?? 0} onChange={(c) => onPatch({ pressedBgColor: c })} /></Field>
        </ScopedSection>
      )}

      {(visual.kind === "Label" || visual.kind === "Button") && (
        <ScopedSection scope={scope} title="Shop role">
          <Field label="Role">
            <select value={visual.shopRole ?? ""} onChange={(e) => onPatch({ shopRole: (e.target.value || undefined) as UIWidgetVisual["shopRole"] })} style={input}>
              <option value="">(none)</option>
              <option value="buy">Buy button</option>
              <option value="sell">Sell button</option>
            </select>
          </Field>
          {visual.shopRole && (
            <Field label="Item">
              <input
                value={visual.shopItem ?? ""}
                onChange={(e) => onPatch({ shopItem: e.target.value })}
                list={`shop-items-${scope || "single"}`}
                placeholder="item name"
                style={input}
              />
              <datalist id={`shop-items-${scope || "single"}`}>
                {itemNames.map((n) => <option key={n} value={n} />)}
              </datalist>
            </Field>
          )}
          {(visual.shopRole === "buy" || visual.shopRole === "sell") && (
            <Field label="Money global">
              <input value={visual.shopCurrency ?? ""} onChange={(e) => onPatch({ shopCurrency: e.target.value })} placeholder="gold" style={input} />
            </Field>
          )}
        </ScopedSection>
      )}

      {(visual.kind === "Slider" || visual.kind === "ProgressBar") && (
        <ScopedSection scope={scope} title={`${visual.kind} value`}>
          <Field label="Min"><Num value={visual.min ?? 0} onChange={(n) => onPatch({ min: n })} /></Field>
          <Field label="Max"><Num value={visual.max ?? 100} onChange={(n) => onPatch({ max: n })} /></Field>
          <Field label="Value (number or BP variable)">
            <ValueOrVarBinding
              value={typeof visual.value === "number" || typeof visual.value === "string" ? visual.value : 0}
              onChange={(v) => onPatch({ value: v })}
              placeholder="50  or  click 🔗 Bind"
            />
          </Field>
          <Field label="Direction">
            <select value={visual.direction ?? "horizontal"} onChange={(e) => onPatch({ direction: e.target.value as "horizontal" | "vertical" })} style={input}>
              <option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
            </select>
          </Field>
          <Field label="Fill color"><Color value={visual.fillColor ?? 0x44ddff} onChange={(c) => onPatch({ fillColor: c })} /></Field>
          {visual.kind === "Slider" && (<>
            <Field label="Read-only">
              <Toggle
                value={!!visual.readOnly}
                onChange={(v) => onPatch({ readOnly: v })}
                title="When checked, the slider can't be dragged. Value updates only via SetUIValue or a var:binding."
              />
            </Field>
            <Field label="Signal on change">
              <SignalPicker value={visual.signalOnChange ?? ""} onChange={(v) => onPatch({ signalOnChange: v })} placeholder="VolumeChanged" mode="emit" style={{ width: "100%" }} />
            </Field>
          </>)}
        </ScopedSection>
      )}

      {visual.kind === "Dropdown" && (
        <ScopedSection scope={scope} title="Dropdown options">
          <Field label="Signal on select">
            <SignalPicker value={visual.signalOnSelect ?? ""} onChange={(v) => onPatch({ signalOnSelect: v })} placeholder="Picked" mode="emit" style={{ width: "100%" }} />
          </Field>
          <Field label="Selected value"><input value={visual.selectedValue ?? ""} onChange={(e) => onPatch({ selectedValue: e.target.value })} style={input} /></Field>
          <DropdownOptionsEditor
            options={visual.options ?? []}
            onChange={(opts) => onPatch({ options: opts })}
          />
        </ScopedSection>
      )}

      {visual.kind === "Image" && (
        <ScopedSection scope={scope} title="Image">
          <Field label="Sprite asset">
            <select value={visual.spriteId ?? ""} onChange={(e) => onPatch({ spriteId: e.target.value })} style={input}>
              <option value="">— pick a sprite —</option>
              {sprites.map((sp) => (<option key={sp.id} value={sp.id}>{sp.name}</option>))}
            </select>
          </Field>
        </ScopedSection>
      )}

      {visual.kind === "Inventory" && (
        <ScopedSection scope={scope} title="Inventory">
          <Field label="Rows"><Num value={visual.rows ?? 1} onChange={(n) => patchInventory({ rows: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Columns"><Num value={visual.cols ?? 5} onChange={(n) => patchInventory({ cols: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Slot size"><Num value={visual.slotSize ?? 48} onChange={(n) => patchInventory({ slotSize: Math.max(8, n) })} /></Field>
          <Field label="Slot gap"><Num value={visual.slotGap ?? 4} onChange={(n) => patchInventory({ slotGap: Math.max(0, n) })} /></Field>
          <Field label="Slot bg"><Color value={visual.slotBgColor ?? 0x222831} onChange={(c) => onPatch({ slotBgColor: c })} /></Field>
          <Field label="Slot border"><Color value={visual.slotBorderColor ?? 0x404552} onChange={(c) => onPatch({ slotBorderColor: c })} /></Field>
          <Field label="Slot border width"><Num value={visual.slotBorderWidth ?? 1} onChange={(n) => onPatch({ slotBorderWidth: Math.max(0, n) })} /></Field>
          <Field label="Frame radius"><Num value={visual.cornerRadius ?? 0} onChange={(n) => onPatch({ cornerRadius: Math.max(0, n) })} /></Field>
          <Field label="Slot radius"><Num value={visual.slotRadius ?? 0} onChange={(n) => onPatch({ slotRadius: Math.max(0, n) })} /></Field>
          <Field label="Character (name/tag)">
            <input
              list={charListId}
              value={visual.targetBp ?? ""}
              onChange={(e) => onPatch({ targetBp: e.target.value })}
              placeholder="pick or type — blank = host"
              style={input}
            />
            <datalist id={charListId}>
              {blueprintNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Field>
          <Field label="On slot click signal">
            <input
              value={visual.signalOnSlotClick ?? ""}
              onChange={(e) => onPatch({ signalOnSlotClick: e.target.value })}
              placeholder="(optional)"
              style={input}
            />
          </Field>
          <Field label="On double-click signal">
            <input
              value={visual.signalOnSlotDoubleClick ?? ""}
              onChange={(e) => onPatch({ signalOnSlotDoubleClick: e.target.value })}
              placeholder="fires on the character (use item)"
              style={input}
            />
          </Field>
          <Field label="Clicked item → var">
            <input
              value={visual.clickedItemVar ?? ""}
              onChange={(e) => onPatch({ clickedItemVar: e.target.value })}
              placeholder="char var to receive the item name"
              style={input}
            />
          </Field>
          <Field label="Slots draggable">
            <Toggle
              value={visual.slotsDraggable !== false}
              onChange={(v) => onPatch({ slotsDraggable: v })}
            />
          </Field>
        </ScopedSection>
      )}

      {visual.kind === "Crafting" && (
        <ScopedSection scope={scope} title="Crafting">
          <Field label="Rows"><Num value={visual.rows ?? 1} onChange={(n) => patchInventory({ rows: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Columns"><Num value={visual.cols ?? 5} onChange={(n) => patchInventory({ cols: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Slot size"><Num value={visual.slotSize ?? 48} onChange={(n) => patchInventory({ slotSize: Math.max(8, n) })} /></Field>
          <Field label="Slot gap"><Num value={visual.slotGap ?? 4} onChange={(n) => patchInventory({ slotGap: Math.max(0, n) })} /></Field>
          <Field label="Slot bg"><Color value={visual.slotBgColor ?? 0x222831} onChange={(c) => onPatch({ slotBgColor: c })} /></Field>
          <Field label="Slot border"><Color value={visual.slotBorderColor ?? 0x404552} onChange={(c) => onPatch({ slotBorderColor: c })} /></Field>
          <Field label="Slot border width"><Num value={visual.slotBorderWidth ?? 1} onChange={(n) => onPatch({ slotBorderWidth: Math.max(0, n) })} /></Field>
          <Field label="Frame radius"><Num value={visual.cornerRadius ?? 0} onChange={(n) => onPatch({ cornerRadius: Math.max(0, n) })} /></Field>
          <Field label="Slot radius"><Num value={visual.slotRadius ?? 0} onChange={(n) => onPatch({ slotRadius: Math.max(0, n) })} /></Field>
          <Field label="Uncraftable tint"><Color value={visual.uncraftableTint ?? 0x000000} onChange={(c) => onPatch({ uncraftableTint: c })} /></Field>
          <Field label="Character (name/tag)">
            <input
              list={charListId}
              value={visual.targetBp ?? ""}
              onChange={(e) => onPatch({ targetBp: e.target.value })}
              placeholder="pick or type — blank = host"
              style={input}
            />
            <datalist id={charListId}>
              {blueprintNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Field>
          <Field label="On craft click signal">
            <input
              value={visual.signalOnCraftClick ?? ""}
              onChange={(e) => onPatch({ signalOnCraftClick: e.target.value })}
              placeholder="(optional)"
              style={input}
            />
          </Field>
        </ScopedSection>
      )}

      {visual.kind === "CraftGrid" && (
        <ScopedSection scope={scope} title="Craft Grid">
          <Field label="Input rows"><Num value={visual.rows ?? 2} onChange={(n) => patchInventory({ rows: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Input columns"><Num value={visual.cols ?? 2} onChange={(n) => patchInventory({ cols: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Slot size"><Num value={visual.slotSize ?? 48} onChange={(n) => patchInventory({ slotSize: Math.max(8, n) })} /></Field>
          <Field label="Slot gap"><Num value={visual.slotGap ?? 4} onChange={(n) => patchInventory({ slotGap: Math.max(0, n) })} /></Field>
          <Field label="Result gap"><Num value={visual.resultGap ?? 24} onChange={(n) => patchInventory({ resultGap: Math.max(0, n) })} /></Field>
          <Field label="Slot bg"><Color value={visual.slotBgColor ?? 0x222831} onChange={(c) => onPatch({ slotBgColor: c })} /></Field>
          <Field label="Slot border"><Color value={visual.slotBorderColor ?? 0x404552} onChange={(c) => onPatch({ slotBorderColor: c })} /></Field>
          <Field label="Slot border width"><Num value={visual.slotBorderWidth ?? 1} onChange={(n) => onPatch({ slotBorderWidth: Math.max(0, n) })} /></Field>
          <Field label="Frame radius"><Num value={visual.cornerRadius ?? 0} onChange={(n) => onPatch({ cornerRadius: Math.max(0, n) })} /></Field>
          <Field label="Slot radius"><Num value={visual.slotRadius ?? 0} onChange={(n) => onPatch({ slotRadius: Math.max(0, n) })} /></Field>
          <Field label="On craft signal">
            <input
              value={visual.signalOnCraft ?? ""}
              onChange={(e) => onPatch({ signalOnCraft: e.target.value })}
              placeholder="(optional)"
              style={input}
            />
          </Field>
        </ScopedSection>
      )}

      {visual.kind === "Shop" && (
        <ScopedSection scope={scope} title="Shop">
          <Field label="Rows"><Num value={visual.rows ?? 2} onChange={(n) => patchInventory({ rows: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Columns"><Num value={visual.cols ?? 4} onChange={(n) => patchInventory({ cols: Math.max(1, Math.floor(n)) })} /></Field>
          <Field label="Slot size"><Num value={visual.slotSize ?? 48} onChange={(n) => patchInventory({ slotSize: Math.max(8, n) })} /></Field>
          <Field label="Slot gap"><Num value={visual.slotGap ?? 4} onChange={(n) => patchInventory({ slotGap: Math.max(0, n) })} /></Field>
          <Field label="Slot bg"><Color value={visual.slotBgColor ?? 0x222831} onChange={(c) => onPatch({ slotBgColor: c })} /></Field>
          <Field label="Slot border"><Color value={visual.slotBorderColor ?? 0x404552} onChange={(c) => onPatch({ slotBorderColor: c })} /></Field>
          <Field label="Slot border width"><Num value={visual.slotBorderWidth ?? 1} onChange={(n) => onPatch({ slotBorderWidth: Math.max(0, n) })} /></Field>
          <Field label="Frame radius"><Num value={visual.cornerRadius ?? 0} onChange={(n) => onPatch({ cornerRadius: Math.max(0, n) })} /></Field>
          <Field label="Slot radius"><Num value={visual.slotRadius ?? 0} onChange={(n) => onPatch({ slotRadius: Math.max(0, n) })} /></Field>
          <Field label="Can't-afford tint"><Color value={visual.uncraftableTint ?? 0x000000} onChange={(c) => onPatch({ uncraftableTint: c })} /></Field>
          <Field label="Money global"><input value={visual.shopCurrency ?? "gold"} onChange={(e) => onPatch({ shopCurrency: e.target.value })} placeholder="gold" style={input} /></Field>
          <Field label="Buy into (character)">
            <input
              list={charListId}
              value={visual.targetBp ?? ""}
              onChange={(e) => onPatch({ targetBp: e.target.value })}
              placeholder="blank = the inventory on screen"
              style={input}
            />
            <datalist id={charListId}>
              {blueprintNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </Field>
          <Field label="Selection color"><Color value={visual.selectionColor ?? 0xffd23c} onChange={(c) => onPatch({ selectionColor: c })} /></Field>
          <Field label="Selection width"><Num value={visual.selectionWidth ?? 3} onChange={(n) => onPatch({ selectionWidth: Math.max(0, n) })} /></Field>
          <div style={{ gridColumn: "1 / -1", marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
            Item + stock per slot (left→right, top→bottom). Stock blank = unlimited. Click a slot in-game to
            select it, then press a Buy button. <b>Name this widget</b> so Restock Shop can target it.
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 3 }}>
            {Array.from({ length: Math.max(1, (visual.rows ?? 2)) * Math.max(1, (visual.cols ?? 4)) }).map((_, i) => {
              const slot = (visual.shopSlots ?? [])[i] ?? { item: "", stock: -1 };
              const setSlot = (patch: Partial<{ item: string; stock: number }>) => {
                const arr = (visual.shopSlots ?? []).map((s) => ({ ...s }));
                while (arr.length <= i) arr.push({ item: "", stock: -1 });
                arr[i] = { ...arr[i], ...patch };
                onPatch({ shopSlots: arr });
              };
              return (
                <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <span style={{ width: 26, fontSize: 10, color: "var(--text-dim)" }}>#{i + 1}</span>
                  <input
                    value={slot.item}
                    onChange={(e) => setSlot({ item: e.target.value })}
                    list={`shop-grid-items-${scope || "single"}`}
                    placeholder="item"
                    style={{ ...input, flex: 1, fontSize: 10, padding: "2px 4px" }}
                  />
                  <input
                    type="number"
                    value={slot.stock < 0 ? "" : slot.stock}
                    onChange={(e) => setSlot({ stock: e.target.value === "" ? -1 : Math.max(0, Math.floor(Number(e.target.value))) })}
                    placeholder="∞"
                    title="Stock — blank = unlimited"
                    style={{ ...input, width: 48, fontSize: 10, padding: "2px 4px" }}
                  />
                </div>
              );
            })}
            <datalist id={`shop-grid-items-${scope || "single"}`}>
              {itemNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </div>
        </ScopedSection>
      )}

      {(visual.kind === "Inventory" || visual.kind === "Crafting" || visual.kind === "CraftGrid" || visual.kind === "Shop") && (
        <ScopedSection scope={scope} title="Grid visuals (sprites)">
          <div style={{ gridColumn: "1 / -1", fontSize: 10.5, color: "var(--text-dim)", fontStyle: "italic" }}>
            Optional — draw the grid from sprite art instead of flat colors. Pick an animation + a frame, or
            choose <b>▶ animate</b> for a moving (animated) visual.
          </div>
          {([
            { label: "Slot background", none: "(colors)", idKey: "slotBgSpriteId", animKey: "slotBgAnim", frameKey: "slotBgFrame" },
            { label: "Selection frame", none: "(outline)", idKey: "selectionSpriteId", animKey: "selectionAnim", frameKey: "selectionFrame" },
            { label: "Grid panel", none: "(none)", idKey: "panelSpriteId", animKey: "panelAnim", frameKey: "panelFrame" },
            // CraftGrid-only: arrow between input grid and result slot. Surfaced
            // on every grid kind to keep this table uniform; on non-CraftGrid
            // widgets the field is harmless (runtime ignores it).
            ...(visual.kind === "CraftGrid" ? [{ label: "Craft arrow", none: "(▸ text)", idKey: "craftArrowSpriteId", animKey: "craftArrowAnim", frameKey: "craftArrowFrame" } as const] : []),
          ] as const).map(({ label, none, idKey, animKey, frameKey }) => {
            const vAny = visual as unknown as Record<string, unknown>;
            const spriteId = String(vAny[idKey] ?? "");
            const animId = String(vAny[animKey] ?? "");
            const frame = typeof vAny[frameKey] === "number" ? (vAny[frameKey] as number) : 0;
            const sp = sprites.find((s) => s.id === spriteId);
            const anims = (sp?.animations ?? []) as Array<{ id: string; name: string; frames: unknown[] }>;
            const curAnim = anims.find((a) => a.id === animId) ?? anims[0];
            const frameCount = curAnim?.frames.length ?? 0;
            const patch = (p: Record<string, unknown>) => onPatch(p as Partial<UIWidgetVisual>);
            return (
              <Field key={idKey} label={label}>
                <div style={{ display: "flex", gap: 4, minWidth: 0 }}>
                  <select value={spriteId} onChange={(e) => patch({ [idKey]: e.target.value || undefined, [animKey]: "", [frameKey]: 0 })} title="sprite" style={{ ...input, flex: 1, minWidth: 0 }}>
                    <option value="">{none}</option>
                    {sprites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {spriteId && anims.length > 0 && (
                    <select value={curAnim?.id ?? ""} onChange={(e) => patch({ [animKey]: e.target.value, [frameKey]: 0 })} title="animation" style={{ ...input, flex: 1, minWidth: 0 }}>
                      {anims.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                  {spriteId && (
                    <select value={String(frame)} onChange={(e) => patch({ [frameKey]: Number(e.target.value) })} title="Play = animate the whole animation; a frame = a still image" style={{ ...input, width: 92, flexShrink: 0 }}>
                      <option value="-1">▶ Play</option>
                      {Array.from({ length: frameCount }).map((_, i) => <option key={i} value={String(i)}>Frame {i}</option>)}
                    </select>
                  )}
                </div>
              </Field>
            );
          })}
        </ScopedSection>
      )}
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Collapsible section. Expanded/collapsed state is keyed by `scope` +
 * title and persisted in localStorage so collapsing "Background" on
 * widget A doesn't collapse it on widget B too. `scope` is the host
 * asset's id (widget id, child id) — pass empty for global behavior.
 * Default = expanded.
 */
function Section({ scope = "", title, children }: { scope?: string; title: string; children: React.ReactNode }) {
  const storageKey = `peaky.uiWidgetSection.${scope}.${title}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* quota / private mode — fall back to in-memory only */ }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h3
        onClick={toggle}
        style={{
          margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)",
          cursor: "pointer", userSelect: "none",
          display: "inline-flex", alignItems: "center", gap: 6,
        }}
      >
        <span style={{ display: "inline-block", width: 10, fontSize: 10, color: "var(--text-muted)" }}>{open ? "▼" : "▶"}</span>
        {title}
      </h3>
      {open && (
        // One parameter per row, cleanly aligned: a fixed-width LABEL column
        // and a flexible INPUT column. Every field lines up vertically.
        // Full-width rows (buttons, the element grid) use gridColumn:"1 / -1".
        <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", columnGap: 10, rowGap: 8, alignItems: "center", paddingLeft: 4 }}>{children}</div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<>
    <label style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</label>
    {children}
  </>);
}

function Num({ value, onChange, step }: { value: number; onChange: (n: number) => void; step?: number }) {
  // While the field is focused, show the raw typed text — NOT the parent's
  // (possibly clamped) stored value. Without this, an onChange that clamps
  // (e.g. Slot size = Math.max(8, n)) rewrites the input mid-type, so typing
  // "40" reads back as "80". On blur the field re-syncs to the stored value.
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      value={text !== null ? text : (Number.isFinite(value) ? value : 0)}
      step={step ?? 1}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value !== "") {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }
      }}
      onBlur={() => setText(null)}
      style={input}
    />
  );
}

function Color({ value, onChange }: { value: number; onChange: (c: number) => void }) {
  return (
    <input
      type="color"
      value={`#${(value & 0xffffff).toString(16).padStart(6, "0")}`}
      onChange={(e) => onChange(parseInt(e.target.value.slice(1), 16))}
      style={{ ...input, padding: 2, width: "100%", height: 28 }}
    />
  );
}

function DropdownOptionsEditor({
  options, onChange,
}: { options: UIDropdownOption[]; onChange: (next: UIDropdownOption[]) => void }) {
  return (
    <div style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Options ({options.length})</div>
      {options.map((opt, idx) => (
        <div key={opt.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <input placeholder="value" value={opt.value} onChange={(e) => onChange(options.map((o, i) => i === idx ? { ...o, value: e.target.value } : o))} style={{ ...input, width: 100 }} />
          <input placeholder="label" value={opt.label} onChange={(e) => onChange(options.map((o, i) => i === idx ? { ...o, label: e.target.value } : o))} style={{ ...input, flex: 1 }} />
          <div style={{ width: 150 }}>
            <SignalPicker value={opt.signal ?? ""} onChange={(v) => onChange(options.map((o, i) => i === idx ? { ...o, signal: v || undefined } : o))} placeholder="(per-option)" mode="emit" style={{ width: "100%" }} />
          </div>
          <button onClick={() => onChange(options.filter((_, i) => i !== idx))} style={{ ...input, padding: "2px 8px", cursor: "pointer", color: "var(--text-muted)" }}>×</button>
        </div>
      ))}
      <button
        onClick={() => onChange([...options, { id: newId("opt"), value: "", label: "" }])}
        style={{ ...input, alignSelf: "flex-start", padding: "4px 12px", cursor: "pointer", color: "var(--orange)", fontWeight: 600 }}
      >+ Option</button>
    </div>
  );
}

/**
 * Animation-Slots-style declarative bindings table. Each row binds a
 * widget property (text / value / visible / bgColor / enabled) to a BP
 * variable or expression. Reactivity is one-way (var → property), read
 * tick-by-tick at runtime by UIWidgetRenderer's binding loop.
 *
 * Multi-mode widgets target a named child via the "Child" column. Single
 * mode and root targets use empty / "self" (the widget itself).
 *
 * The `source` column accepts any expression the runtime's `numOr` /
 * `strOr` evaluators support — literal numbers, `var:Foo.bar`,
 * arithmetic, comparisons (yield 0/1 booleans). Reuses the existing
 * ValueOrVarBinding picker for one-click variable selection.
 */
function WidgetBindingsTable({
  widget, onPatch,
}: {
  widget: UIWidgetDef;
  onPatch: (patch: Partial<UIWidgetDef>) => void;
}) {
  const bindings = widget.bindings ?? [];
  const childOptions: string[] = widget.mode === "multi"
    ? (widget.children ?? [])
      .map((c) => c.name)
      .filter((n): n is string => !!n)
    : [];

  // Per-property guidance — surfaced as the placeholder in the source
  // column so authors see what the expression should look like.
  const placeholderFor = (p: WidgetBinding["property"]): string => {
    switch (p) {
      case "text":    return "var:Player.hp";
      case "value":   return "var:Player.hp / var:Player.maxHp";
      case "visible": return "var:tutorialDone == 0";
      case "bgColor": return "0xff4242";
      case "enabled": return "var:Player.alive";
    }
  };

  const patch = (i: number, p: Partial<WidgetBinding>) => {
    const next = bindings.map((b, idx) => (idx === i ? { ...b, ...p } : b));
    onPatch({ bindings: next });
  };
  const remove = (i: number) => {
    onPatch({ bindings: bindings.filter((_, idx) => idx !== i) });
  };
  const add = () => {
    const next: WidgetBinding[] = [
      ...bindings,
      { id: newId("bnd"), childName: "", property: "text", source: "" },
    ];
    onPatch({ bindings: next });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
      {bindings.length === 0 ? (
        <div style={{
          fontSize: 11, color: "var(--text-muted)",
          padding: "8px 10px",
          background: "rgba(255,255,255,0.03)",
          borderRadius: 4, border: "1px dashed rgba(255,255,255,0.1)",
        }}>
          No bindings. Click <b>+ Add Binding</b> to wire a widget property to a
          variable. Example: bind a Label's text to <code style={{ color: "var(--text)" }}>var:Player.hp</code>
          so it auto-updates whenever HP changes.
        </div>
      ) : (
        <>
          {/* Header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: `${widget.mode === "multi" ? "100px " : ""}90px 1fr 22px`,
            gap: 6,
            fontSize: 9, color: "var(--text-dim)",
            textTransform: "uppercase", letterSpacing: 0.5,
            paddingLeft: 4,
          }}>
            {widget.mode === "multi" && <span>Child</span>}
            <span>Property</span>
            <span>Source (var / expr)</span>
            <span></span>
          </div>
          {bindings.map((b, i) => (
            <div key={b.id} style={{
              display: "grid",
              gridTemplateColumns: `${widget.mode === "multi" ? "100px " : ""}90px 1fr 22px`,
              gap: 6,
              alignItems: "center",
              padding: "3px 4px",
              background: "rgba(0,0,0,0.2)",
              borderRadius: 4,
            }}>
              {widget.mode === "multi" && (
                <select
                  value={b.childName ?? ""}
                  onChange={(e) => patch(i, { childName: e.target.value || undefined })}
                  style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                  title="Which named child this binding writes to. Empty = the multi-widget root itself."
                >
                  <option value="">(root)</option>
                  {childOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
              <select
                value={b.property}
                onChange={(e) => patch(i, { property: e.target.value as WidgetBinding["property"] })}
                style={{ width: "100%", minWidth: 0, fontSize: 11 }}
                title="Property to drive. text/value need a string/number source; visible/enabled need a 0/1 (boolean). bgColor needs a hex number like 0xff4242."
              >
                <option value="text">text</option>
                <option value="value">value</option>
                <option value="visible">visible</option>
                <option value="bgColor">bgColor</option>
                <option value="enabled">enabled</option>
              </select>
              <ExpressionField
                showPicker
                wrap="raw"
                value={b.source}
                onChange={(v) => patch(i, { source: v })}
                placeholder={placeholderFor(b.property)}
                style={{
                  width: "100%", minWidth: 0, fontSize: 11,
                  fontFamily: b.source.startsWith("var:") ? "ui-monospace, monospace" : undefined,
                }}
                title="Variable name (var:BpName.varName) or expression. Runtime resolves every tick."
              />
              <button
                onClick={() => remove(i)}
                title="Remove this binding"
                style={{
                  width: 22, height: 20, padding: 0, lineHeight: "18px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
                }}
              >×</button>
            </div>
          ))}
        </>
      )}
      <button
        onClick={add}
        style={{
          alignSelf: "flex-start",
          marginTop: 4, padding: "4px 12px", fontSize: 11,
          background: "transparent",
          border: "1px dashed rgba(255,255,255,0.2)",
          borderRadius: 4, color: "var(--text-dim)", cursor: "pointer",
        }}
      >+ Add Binding</button>
      {bindings.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "4px 0 0", fontStyle: "italic" }}>
          ⚠ Runtime binding application is shipping in the next pass. The
          authoring data is preserved in your project; expect live var-to-property
          updates after the next engine update.
        </div>
      )}
    </div>
  );
}

/**
 * 3×3 visual anchor picker. Replaces the dropdown of "TL/TC/TR/..." with
 * a clickable grid where each cell is the literal viewport corner.
 * Active cell highlights in orange. The center button is "no anchor"
 * (clearing the anchor field — widget uses raw x/y placement instead).
 */
function AnchorGridPicker({
  value, onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const cells: { row: number; col: number; code: string; label: string }[] = [
    { row: 0, col: 0, code: "TL", label: "Top-Left" },
    { row: 0, col: 1, code: "TC", label: "Top-Center" },
    { row: 0, col: 2, code: "TR", label: "Top-Right" },
    { row: 1, col: 0, code: "ML", label: "Middle-Left" },
    { row: 1, col: 1, code: "",   label: "(no anchor)" },
    { row: 1, col: 2, code: "MR", label: "Middle-Right" },
    { row: 2, col: 0, code: "BL", label: "Bottom-Left" },
    { row: 2, col: 1, code: "BC", label: "Bottom-Center" },
    { row: 2, col: 2, code: "BR", label: "Bottom-Right" },
  ];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, 28px)",
      gridTemplateRows: "repeat(3, 24px)",
      gap: 2,
      width: 86, padding: 4,
      background: "rgba(0,0,0,0.3)",
      border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 4,
    }}>
      {cells.map((c) => {
        const isCenter = c.code === "";
        const isActive = value === c.code;
        return (
          <button
            key={`${c.row}-${c.col}`}
            onClick={() => onChange(c.code)}
            title={c.label}
            style={{
              padding: 0, lineHeight: "20px", fontSize: 9,
              background: isActive ? "var(--orange)" : isCenter ? "transparent" : "rgba(255,255,255,0.04)",
              border: `1px ${isCenter ? "dashed" : "solid"} ${isActive ? "var(--orange)" : "rgba(255,255,255,0.12)"}`,
              borderRadius: 2,
              color: isActive ? "#000" : isCenter ? "var(--text-dim)" : "var(--text-muted)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >{isCenter ? "—" : c.code}</button>
        );
      })}
    </div>
  );
}

function alphaHex(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
}

const titleInput: React.CSSProperties = {
  fontSize: 22, fontWeight: 600, background: "transparent",
  border: "none", borderBottom: "1px solid rgba(255,255,255,0.1)",
  color: "var(--text)", outline: "none", flex: 1,
};

const input: React.CSSProperties = {
  background: "rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "var(--text)",
  padding: "4px 8px",
  fontSize: 12,
  borderRadius: 3,
  outline: "none",
};

const kindBadge: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
  textTransform: "uppercase", color: "var(--orange)",
  background: "rgba(255,165,0,0.12)",
  padding: "3px 7px", borderRadius: 3,
};

const modeBtn: React.CSSProperties = {
  padding: "5px 14px", fontSize: 11, fontWeight: 600,
  border: "none", cursor: "pointer", letterSpacing: 0.4,
  textTransform: "uppercase",
};

const addItemBtn: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px", background: "transparent",
  border: "none", cursor: "pointer", borderRadius: 3,
  display: "flex", alignItems: "baseline", gap: 8,
};

const hint: React.CSSProperties = {
  fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4,
};
