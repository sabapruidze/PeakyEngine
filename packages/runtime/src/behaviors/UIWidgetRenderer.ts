import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { Logger } from "../Logger";
import type { Sprite } from "../Sprite";
import type { InventorySlot, RecipeRuntime } from "./Inventory";
import { evalExpression, strOr } from "../sm/eval";
import { persistentState } from "../PersistentState";
import { setupCrispText } from "../textRendering";

/** Item catalog entry injected by runProject (peaky.itemMeta), the bits the
 *  shop needs. */
interface ShopItemMeta { buyPrice: number; sellPrice: number; countGlobal: string; maxStack: number; iconKeys: string[]; props?: Record<string, number | string | boolean> }

/**
 * UIWidgetRenderer — single behavior that draws a UI Widget per its
 * `kind` field. Replaces the composable Anchor/Button/Stack/Slider
 * components: each widget IS one kind (Panel / Label / Button / Slider /
 * ProgressBar / Dropdown / Image), and this behavior creates ALL the
 * Phaser game objects needed to render + interact with it.
 *
 * Visual stack (back-to-front):
 *   1. bg rect (Phaser.GameObjects.Rectangle) — colored background
 *   2. fill rect (Slider / ProgressBar) — proportional to value
 *   3. image (Image kind) — sprite asset's first frame, scaled to fit
 *   4. label (Label / Button / Dropdown) — Phaser.Text overlay
 *   5. dropdown chevron (Dropdown)
 *   6. dropdown options list (Dropdown, when open)
 *
 * Interaction:
 *   - Button: pointer events emit signalOnClick / Hover / Leave on the
 *     host Sprite's EventBus.
 *   - Slider: pointer drag updates the widget's `value` field (passed
 *     in via config) and emits signalOnChange.
 *   - Dropdown: click opens the options list; clicking an option emits
 *     signalOnSelect with the option's value, sets selectedValue.
 */

interface DropdownOptionRuntime {
  value: string;
  label: string;
  /** Per-option signal fired when this option is picked (in addition
   *  to the widget-level signalOnSelect, if set). */
  signal?: string;
}

/** Scene-level drag payload (scene.data["peaky.uiDrag"]) shared by all Inventory
 *  + CraftGrid widgets so a drag can cross between widgets. The OWNING renderer
 *  (source) resolves the drop on pointerup. */
interface UIDragPayload {
  ghost: Phaser.GameObjects.Image;
  itemId: string;
  qty: number;
  maxStack: number;
  source:
    | { renderer: UIWidgetRenderer; kind: "slot"; slots: InventorySlot[]; idx: number }
    | { renderer: UIWidgetRenderer; kind: "result"; recipe: RecipeRuntime };
}

/** Move/merge/swap one slot between two stores (generalizes Inventory.moveSlot
 *  to two arrays). `amount` caps how many units move (default = the whole stack);
 *  pass 1 for "place a single ingredient". Merges same item up to maxStack;
 *  places into an empty target; swaps whole stacks only on a full-stack move.
 *  Reassigns elements (clones) so a slot object is never aliased across stores. */
function transferSlot(src: InventorySlot[], si: number, dst: InventorySlot[], di: number, maxStack: number, amount = Infinity): void {
  const a = src[si];
  const b = dst[di];
  if (!a || !b || a.itemId === "" || a.qty <= 0) return;
  const cap = Math.max(1, Math.floor(maxStack));
  const want = Math.min(amount, a.qty);
  if (b.itemId === "" || b.qty <= 0) {
    const move = Math.min(cap, want);
    b.itemId = a.itemId; b.qty = move;
    a.qty -= move;
    if (a.qty <= 0) { a.itemId = ""; a.qty = 0; }
  } else if (b.itemId === a.itemId) {
    const move = Math.min(cap - b.qty, want);
    b.qty += move; a.qty -= move;
    if (a.qty <= 0) { a.itemId = ""; a.qty = 0; }
  } else if (amount === Infinity) {
    // Different items, whole-stack move → swap. A partial move onto an occupied
    // slot of a different item is a no-op (nowhere to put the unit).
    const tmp = { itemId: b.itemId, qty: b.qty };
    dst[di] = { itemId: a.itemId, qty: a.qty };
    src[si] = tmp;
  }
}

/** Remove up to `qty` of `item` across a slot store (in place). */
function removeFromSlots(slots: InventorySlot[], item: string, qty: number): void {
  let rem = qty;
  for (const s of slots) {
    if (rem <= 0) break;
    if (s.itemId === item) {
      const t = Math.min(s.qty, rem);
      s.qty -= t; rem -= t;
      if (s.qty <= 0) { s.itemId = ""; s.qty = 0; }
    }
  }
}

export class UIWidgetRenderer extends Behavior {
  kind = "UIWidgetRenderer";
  /** UI must keep ticking during a pause (timeScale=0) so pause menus
   *  stay interactive — buttons hover, sliders drag, dropdowns open. */
  tickDuringPause = true;

  // ── widget config (set by config spread on attach) ─────────────────
  widgetKind = "Panel"; // "Panel" | "Label" | "Button" | "Slider" | "ProgressBar" | "Dropdown" | "Image"
  widgetW = 200;
  widgetH = 60;
  /** When on, while the pointer is over this widget it SWALLOWS mouse input
   *  actions (e.g. attack on Left-Click) so clicking the widget / dragging a
   *  slider doesn't also fire gameplay. Checked by InputActions per-frame. */
  blockGameInput = 0;
  bgColor = 0;
  bgAlpha = 0;
  borderColor = 0;
  borderWidth = 0;
  padding = 0;
  // Rounded corners
  cornerRadius = 0;
  cornersSeparate = false;
  cornerRadiusTL = 0;
  cornerRadiusTR = 0;
  cornerRadiusBL = 0;
  cornerRadiusBR = 0;
  // Drop shadow
  shadowEnabled = false;
  shadowColor = 0x000000;
  shadowAlpha = 0.4;
  shadowBlur = 12;
  shadowOffsetX = 0;
  shadowOffsetY = 6;
  // Anchor
  anchorCorner = "";
  anchorOffsetX = 0;
  anchorOffsetY = 0;
  // Text
  text = "";
  fontFamily = "Arial";
  fontSize = 16;
  fontColor = 0xffffff;
  fontBold = false;
  fontItalic = false;
  align: "left" | "center" | "right" = "center";
  vAlign: "top" | "middle" | "bottom" = "middle";
  // Button
  signalOnClick = "";
  signalOnHover = "";
  signalOnLeave = "";
  hoverBgColor: number | undefined;
  pressedBgColor: number | undefined;
  /** "single" = fire signalOnClick on every release. "double" = only
   *  fire on the SECOND release within ~400ms (a real double-click). */
  clickMode: "single" | "double" = "single";
  /** ms timestamp of the last click (used by double-click detection). */
  private _lastClickMs = -1;
  // Slider / ProgressBar
  min = 0;
  max = 100;
  value: number | string = 50;
  direction: "horizontal" | "vertical" = "horizontal";
  fillColor = 0x44ddff;
  signalOnChange = "";
  /** When true a Slider's pointer-drag is suppressed — value still
   *  renders / animates from `var:` bindings or SetUIValue, but the
   *  user can't move it with the mouse. Equivalent to a ProgressBar
   *  visually with the slider thumb. */
  readOnly = false;
  // Dropdown
  options: DropdownOptionRuntime[] = [];
  selectedValue = "";
  signalOnSelect = "";
  // Image
  spriteId = "";
  /** Texture key resolved at compile time from spriteId — set by the
   *  runProject compile path (the editor knows about sprite asset IDs;
   *  the runtime works in Phaser texture keys). */
  imageTextureKey = "";
  // Inventory grid
  rows = 1;
  cols = 5;
  slotSize = 48;
  slotGap = 4;
  slotBgColor = 0x222831;
  slotBorderColor = 0x404552;
  slotBorderWidth = 1;
  slotRadius = 0;
  /** BP name / instance name / tag whose Inventory this grid mirrors. Empty =
   *  the attached host (set by the Widget behavior). */
  targetBp = "";
  signalOnSlotClick = "";
  /** Inventory: signal fired on the bound character's bus when an item slot is
   *  double-clicked (use / consume). */
  signalOnSlotDoubleClick = "";
  /** Inventory: variable name written on the bound character with the
   *  double-clicked item's NAME. */
  clickedItemVar = "";
  /** Inventory: when false, slots can't be dragged. Clicks/double-clicks still
   *  fire. */
  slotsDraggable = true;
  /** Crafting widget: tint applied to a cell whose recipe isn't currently
   *  craftable (composed with reduced alpha). */
  uncraftableTint = 0x000000;
  /** Crafting widget: signal fired when a craftable cell is clicked. */
  signalOnCraftClick = "";
  /** CraftGrid: gap between the input grid and the result slot. */
  resultGap = 24;
  /** CraftGrid: signal fired when a crafted result is taken into an inventory. */
  signalOnCraft = "";

  // ── Shop role ──────────────────────────────────────────────────────────
  /** "" = not a shop element. icon/name/buyPrice/sellPrice auto-fill from
   *  `shopItem`; buy/sell run the transaction on click. */
  shopRole = "";
  /** Which Item (by name) this shop element is for. */
  shopItem = "";
  /** Money global charged/paid by buy/sell (default "gold"). */
  shopCurrency = "";
  /** Shop GRID widget — what each slot sells (row-major). stock -1 = unlimited. */
  shopSlots: { item: string; stock: number }[] = [];
  /** Stable name used to key this shop's persistent stock. */
  shopId = "";
  /** Currently-selected shop slot (-1 = none). Click selects; Buy button buys it. */
  selectedSlot = -1;
  /** Selection-frame highlight on the selected slot. */
  selectionColor = 0xffd23c;
  selectionWidth = 3;
  /** Custom grid sprite visuals — resolved texture keys + animation meta
   *  (set by runProject from each picker's sprite + anim + frame). Empty keys
   *  = not set (falls back to colors / outline). */
  _slotBgVisual: { keys: string[]; fps: number; loop: boolean; animated: boolean } = { keys: [], fps: 8, loop: true, animated: false };
  _selectionVisual: { keys: string[]; fps: number; loop: boolean; animated: boolean } = { keys: [], fps: 8, loop: true, animated: false };
  _panelVisual: { keys: string[]; fps: number; loop: boolean; animated: boolean } = { keys: [], fps: 8, loop: true, animated: false };
  /** CraftGrid arrow sprite — same struct shape; empty keys = use the text "▸". */
  _craftArrowVisual: { keys: string[]; fps: number; loop: boolean; animated: boolean } = { keys: [], fps: 8, loop: true, animated: false };

  // ── Phaser objects this behavior owns ───────────────────────────────
  /** Background drawn as a Graphics object so we can support rounded
   *  corners (Phaser.Rectangle has square corners only). The graphics
   *  is redrawn on each layout() call from the current bg / corner /
   *  border config. Shadow lives on a separate graphics underneath. */
  private bg?: Phaser.GameObjects.Graphics;
  private shadow?: Phaser.GameObjects.Graphics;
  private fill?: Phaser.GameObjects.Rectangle;
  /** Border drawn on its OWN Graphics layer (depth above fill) so the
   *  outline stays visible on top of a slider/progressbar's colored
   *  fill rectangle. Without this, the border on the same layer as the
   *  bg fill would get visually painted over by the higher-depth fill.
   *  Only used when `borderWidth > 0`; cleared otherwise. */
  private border?: Phaser.GameObjects.Graphics;
  private image?: Phaser.GameObjects.Image;
  private label?: Phaser.GameObjects.Text;
  private chevron?: Phaser.GameObjects.Text;
  private optionList?: Phaser.GameObjects.Container;
  // Inventory slot visuals (one entry per slot: bg rect, icon image, count text).
  private slotBgs: Phaser.GameObjects.Graphics[] = [];
  private slotIcons: Phaser.GameObjects.Image[] = [];
  private slotCounts: Phaser.GameObjects.Text[] = [];
  // Custom grid sprite visuals: per-slot background image + whole-grid panel +
  // a selection-frame image (textures from the resolved _*Visual structs).
  private slotBgImgs: Phaser.GameObjects.Image[] = [];
  private _panelImg?: Phaser.GameObjects.Image;
  private _selectionImg?: Phaser.GameObjects.Image;
  /** Resolved target Inventory behavior (re-resolved if it dies). `null` =
   *  not yet found. Looked up by `targetBp`, or set by the attaching Widget. */
  private _targetInventory: import("./Inventory").Inventory | null = null;
  /** Crafting widget: ordered recipes mapped to cells (cached each refresh so
   *  a click can resolve the recipe under the pointer). */
  private _craftRecipes: import("./Inventory").RecipeRuntime[] = [];
  /** CraftGrid: transient input-slot contents (length rows*cols). Not persisted. */
  private craftSlots: import("./Inventory").InventorySlot[] = [];
  /** CraftGrid result-slot graphics. */
  private resultBg?: Phaser.GameObjects.Graphics;
  private resultBgImg?: Phaser.GameObjects.Image;
  private resultIcon?: Phaser.GameObjects.Image;
  private resultCount?: Phaser.GameObjects.Text;
  private resultArrow?: Phaser.GameObjects.Text;
  private resultArrowImg?: Phaser.GameObjects.Image;
  /** CraftGrid: recipe currently matched by the placed inputs (null = none). */
  private _matchedRecipe: import("./Inventory").RecipeRuntime | null = null;
  /** Drag state for click-vs-drag disambiguation. The drag ghost + payload live
   *  on scene.data ("peaky.uiDrag") so drags work across widgets. */
  private _dragFrom = -1;
  private _pressX = 0;
  private _pressY = 0;
  private _pressMs = 0;
  /** Inventory double-click (use-item) detection. */
  private _lastSlotClickMs = -1;
  private _lastSlotClickIdx = -1;

  // Interaction state
  private hovering = false;
  private pressed = false;
  private dragging = false;
  private dropdownOpen = false;

  // Pointer listeners (stored so onDestroy can detach)
  private onPointerDown?: (p: Phaser.Input.Pointer) => void;
  private onPointerUp?: (p: Phaser.Input.Pointer) => void;
  private onPointerMove?: (p: Phaser.Input.Pointer) => void;

  // Cached resolved label string (for {var} interpolation / Slider value)
  private lastLabelText = "";

  // Cached current bg color (for hover/pressed transitions)
  private currentBgColor = 0;

  // ── Declarative bindings (authored in WidgetBindingsTable) ──────────
  // Injected by runProject. Iterated each tick; per-row evaluates
  // `source` and writes the result into the matching property. Multi-mode:
  // each child sprite gets the FULL parent list + its own childName; only
  // bindings where `childName === this._childName` apply.
  _bindings: Array<{ id?: string; childName?: string; property: string; source: string }> = [];
  _childName = "";
  /** Per-binding cache of the last evaluated value — skips re-applying
   *  identical values so we don't dirty Phaser objects every tick when
   *  the bound expression hasn't changed. Keyed by binding id (falls
   *  back to property+source). */
  private _bindingLastValue: Map<string, unknown> = new Map();

  // Layer settings (cached)
  private _layerAlpha = 1;
  private _layerVisible = true;
  private _layerScrollX = 1;
  private _layerScrollY = 1;
  private _layerDepth = 0;
  // Runtime opacity multiplier set by SetUIElement. Composed with the layer
  // alpha so it survives layer re-applies. 1 = fully driven by the layer.
  private _opacity = 1;

  init(): void {
    const scene = this.sprite.scene;
    if (!scene) return;
    // Register as an input blocker so InputActions can swallow mouse actions
    // while the pointer is over this widget (opt-in via blockGameInput).
    if (this.blockGameInput) {
      let set = scene.data.get("peaky.mouseBlockers") as Set<UIWidgetRenderer> | undefined;
      if (!set) { set = new Set(); scene.data.set("peaky.mouseBlockers", set); }
      set.add(this);
    }
    const obj = this.sprite.gameObject;

    // Apply Anchor (one-shot at init — FIT canvas mode means viewport
    // dimensions are fixed, so the position doesn't drift after).
    //
    // The anchor pins the widget's MATCHING CORNER to the viewport's
    // corner — e.g. "TL" puts the widget's TOP-LEFT at the viewport's
    // top-left. Since `setPosition` sets the gameObject's CENTER, we
    // shift by half-W / half-H so the corresponding corner lands on
    // the viewport corner. Without this compensation, "TL + (0,0)"
    // would put the widget's CENTER at canvas (0,0), so half the
    // widget would render off-screen — that's the bug the user hit.
    if (this.anchorCorner) {
      const vw = scene.scale.gameSize.width;
      const vh = scene.scale.gameSize.height;
      const halfW = this.widgetW / 2;
      const halfH = this.widgetH / 2;
      let cx = halfW, cy = halfH; // default = TL
      switch (this.anchorCorner) {
        case "TL": cx = halfW;        cy = halfH;        break;
        case "TC": cx = vw / 2;       cy = halfH;        break;
        case "TR": cx = vw - halfW;   cy = halfH;        break;
        case "ML": cx = halfW;        cy = vh / 2;       break;
        case "C":  cx = vw / 2;       cy = vh / 2;       break;
        case "MR": cx = vw - halfW;   cy = vh / 2;       break;
        case "BL": cx = halfW;        cy = vh - halfH;   break;
        case "BC": cx = vw / 2;       cy = vh - halfH;   break;
        case "BR": cx = vw - halfW;   cy = vh - halfH;   break;
      }
      obj.setPosition(cx + this.anchorOffsetX, cy + this.anchorOffsetY);
    }

    // Background drawn as a Graphics object so rounded corners +
    // border draw together. Shadow (if enabled) gets its own Graphics
    // underneath, drawn at an offset with reduced alpha to fake a
    // soft drop. Phaser doesn't expose CSS-style filter:blur for
    // arbitrary game objects cheaply, so the "blur" here is purely
    // the offset+alpha approximation.
    this.currentBgColor = this.bgColor;
    if (this.shadowEnabled) {
      this.shadow = scene.add.graphics();
      this.applyDecor(this.shadow);
      this.sprite.routeOverlayToCamera(this.shadow);
    }
    if (this.bgAlpha > 0 || this.borderWidth > 0) {
      this.bg = scene.add.graphics();
      this.applyDecor(this.bg);
      this.sprite.routeOverlayToCamera(this.bg);
    }

    // Fill (Slider / ProgressBar)
    if (this.widgetKind === "Slider" || this.widgetKind === "ProgressBar") {
      this.fill = scene.add.rectangle(obj.x, obj.y, 1, 1, this.fillColor, 1);
      this.applyDecor(this.fill);
      this.sprite.routeOverlayToCamera(this.fill);
    }

    // Border on its OWN layer so it renders ABOVE the progress fill.
    // Lazy-created when borderWidth > 0; the bg layer keeps the
    // background color only (no longer doubles as the border draw).
    if (this.borderWidth > 0) {
      this.border = scene.add.graphics();
      this.applyDecor(this.border);
      this.sprite.routeOverlayToCamera(this.border);
    }

    // Image
    if (this.widgetKind === "Image" && this.imageTextureKey && scene.textures.exists(this.imageTextureKey)) {
      this.image = scene.add.image(obj.x, obj.y, this.imageTextureKey);
      this.image.setOrigin(0.5, 0.5);
      this.image.setDisplaySize(this.widgetW, this.widgetH);
      this.applyDecor(this.image);
      this.sprite.routeOverlayToCamera(this.image);
    }

    // Label (Label / Button / Dropdown)
    if (this.widgetKind === "Label" || this.widgetKind === "Button" || this.widgetKind === "Dropdown") {
      const initial = this.resolveLabel();
      this.lastLabelText = initial;
      this.label = scene.add.text(obj.x, obj.y, initial, this.buildTextStyle());
      setupCrispText(this.label);
      this.applyTextOrigin(this.label);
      this.applyDecor(this.label);
      this.sprite.routeOverlayToCamera(this.label);
    }

    // Dropdown chevron
    if (this.widgetKind === "Dropdown") {
      this.chevron = scene.add.text(obj.x, obj.y, "▾", {
        fontFamily: this.fontFamily,
        fontSize: `${Math.round(this.fontSize)}px`,
        color: cssColor(this.fontColor),
      });
      setupCrispText(this.chevron);
      this.chevron.setOrigin(0.5, 0.5);
      this.applyDecor(this.chevron);
      this.sprite.routeOverlayToCamera(this.chevron);
    }

    // Inventory / Crafting / CraftGrid / Shop grid — one bg graphic + icon Image + count Text per slot.
    if (this.widgetKind === "Inventory" || this.widgetKind === "Crafting" || this.widgetKind === "CraftGrid" || this.widgetKind === "Shop") {
      this.buildSlotCells(Math.max(1, this.rows * this.cols));
      // Optional whole-grid panel sprite + selection-frame sprite (custom grids).
      this._panelImg = scene.add.image(obj.x, obj.y, "__DEFAULT").setVisible(false);
      this.applyDecor(this._panelImg);
      this.sprite.routeOverlayToCamera(this._panelImg);
      this._selectionImg = scene.add.image(obj.x, obj.y, "__DEFAULT").setVisible(false);
      this.applyDecor(this._selectionImg);
      this.sprite.routeOverlayToCamera(this._selectionImg);
    }

    // CraftGrid — transient input slots + a dedicated result slot (bg/icon/count) + arrow.
    if (this.widgetKind === "CraftGrid") {
      const n = Math.max(1, this.rows * this.cols);
      this.craftSlots = Array.from({ length: n }, () => ({ itemId: "", qty: 0 }));
      this.resultBg = scene.add.graphics();
      this.applyDecor(this.resultBg);
      this.sprite.routeOverlayToCamera(this.resultBg);
      // Parallel Image to paint the result slot using the slot bg sprite,
      // so a custom-art grid covers ALL slots (input + result) instead of
      // showing the colored placeholder rect on the result.
      this.resultBgImg = scene.add.image(obj.x, obj.y, "__DEFAULT");
      this.resultBgImg.setOrigin(0.5, 0.5);
      this.resultBgImg.setVisible(false);
      this.applyDecor(this.resultBgImg);
      this.sprite.routeOverlayToCamera(this.resultBgImg);
      this.resultIcon = scene.add.image(obj.x, obj.y, "__DEFAULT");
      this.resultIcon.setOrigin(0.5, 0.5);
      this.resultIcon.setVisible(false);
      this.applyDecor(this.resultIcon);
      this.sprite.routeOverlayToCamera(this.resultIcon);
      this.resultCount = scene.add.text(obj.x, obj.y, "", {
        fontFamily: this.fontFamily,
        fontSize: `${Math.max(9, Math.round(this.slotSize * 0.28))}px`,
        color: cssColor(this.fontColor),
        fontStyle: "bold",
      });
      setupCrispText(this.resultCount);
      this.resultCount.setOrigin(1, 1);
      this.applyDecor(this.resultCount);
      this.sprite.routeOverlayToCamera(this.resultCount);
      this.resultArrow = scene.add.text(obj.x, obj.y, "▸", {
        fontFamily: this.fontFamily,
        fontSize: `${Math.max(12, Math.round(this.slotSize * 0.4))}px`,
        color: cssColor(this.fontColor),
      });
      setupCrispText(this.resultArrow);
      this.resultArrow.setOrigin(0.5, 0.5);
      this.applyDecor(this.resultArrow);
      this.sprite.routeOverlayToCamera(this.resultArrow);
      // Custom arrow Image — when craftArrowSpriteId is set, this replaces
      // the "▸" text glyph with a sprite so authors can style the arrow to
      // match their HUD theme.
      this.resultArrowImg = scene.add.image(obj.x, obj.y, "__DEFAULT");
      this.resultArrowImg.setOrigin(0.5, 0.5);
      this.resultArrowImg.setVisible(false);
      this.applyDecor(this.resultArrowImg);
      this.sprite.routeOverlayToCamera(this.resultArrowImg);
    }

    // Pointer interactions for Button / Slider / Dropdown / Inventory / Crafting / CraftGrid
    if (this.widgetKind === "Button" || this.widgetKind === "Slider" || this.widgetKind === "Dropdown" || this.widgetKind === "Inventory" || this.widgetKind === "Crafting" || this.widgetKind === "CraftGrid" || this.widgetKind === "Shop") {
      this.installPointer();
    }

    this.layout();
  }

  /** World rect (top-left + size) of inventory slot `i` in grid order. */
  private slotRect(i: number): { x: number; y: number; w: number; h: number } {
    const obj = this.sprite.gameObject;
    const cols = Math.max(1, this.cols);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cell = this.slotSize + this.slotGap;
    const gridW = cols * this.slotSize + (cols - 1) * this.slotGap;
    const gridH = this.rows * this.slotSize + (this.rows - 1) * this.slotGap;
    // CraftGrid left-justifies the input grid (the result slot occupies the
    // right of the wider frame); other grids center on the sprite origin.
    const left = this.widgetKind === "CraftGrid"
      ? obj.x - this.widgetW / 2 + this.padding
      : obj.x - gridW / 2;
    const top = obj.y - gridH / 2;
    return { x: left + col * cell, y: top + row * cell, w: this.slotSize, h: this.slotSize };
  }

  /** World rect of the CraftGrid result slot (right of the input grid). */
  private resultRect(): { x: number; y: number; w: number; h: number } {
    const obj = this.sprite.gameObject;
    const cols = Math.max(1, this.cols);
    const gridW = cols * this.slotSize + (cols - 1) * this.slotGap;
    const x = obj.x - this.widgetW / 2 + this.padding + gridW + this.resultGap;
    return { x, y: obj.y - this.slotSize / 2, w: this.slotSize, h: this.slotSize };
  }

  /** Slot index under a pointer (canvas coords), or -1. */
  private slotIndexAt(px: number, py: number): number {
    const total = this.slotBgs.length;
    for (let i = 0; i < total; i++) {
      const r = this.slotRect(i);
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
    }
    return -1;
  }

  /** Create `count` slot graphics (bg + icon + count) and push them onto the
   *  slot arrays. Shared by init() and rebuildSlots(). */
  private buildSlotCells(count: number): void {
    const scene = this.sprite.scene;
    const obj = this.sprite.gameObject;
    for (let i = 0; i < count; i++) {
      const slotBg = scene.add.graphics();
      this.applyDecor(slotBg);
      this.sprite.routeOverlayToCamera(slotBg);
      this.slotBgs.push(slotBg);
      // Optional per-slot background SPRITE (custom grid art). Hidden until a
      // slot-bg sprite is configured + resolved.
      const slotBgImg = scene.add.image(obj.x, obj.y, "__DEFAULT");
      slotBgImg.setOrigin(0.5, 0.5);
      slotBgImg.setVisible(false);
      this.applyDecor(slotBgImg);
      this.sprite.routeOverlayToCamera(slotBgImg);
      this.slotBgImgs.push(slotBgImg);
      const icon = scene.add.image(obj.x, obj.y, "__DEFAULT");
      icon.setOrigin(0.5, 0.5);
      icon.setVisible(false);
      this.applyDecor(icon);
      this.sprite.routeOverlayToCamera(icon);
      this.slotIcons.push(icon);
      const cnt = scene.add.text(obj.x, obj.y, "", {
        fontFamily: this.fontFamily,
        fontSize: `${Math.max(9, Math.round(this.slotSize * 0.28))}px`,
        color: cssColor(this.fontColor),
        fontStyle: "bold",
      });
      setupCrispText(cnt);
      cnt.setOrigin(1, 1);
      this.applyDecor(cnt);
      this.sprite.routeOverlayToCamera(cnt);
      this.slotCounts.push(cnt);
    }
  }

  /** Rebuild the slot-cell graphics for the current rows*cols (used when
   *  rows/cols change at runtime via SetUIElement). Preserves CraftGrid input
   *  contents where they still fit. */
  private rebuildSlots(): void {
    for (const g of this.slotBgs) g.destroy();
    for (const im of this.slotIcons) im.destroy();
    for (const t of this.slotCounts) t.destroy();
    for (const im of this.slotBgImgs) im.destroy();
    this.slotBgs = [];
    this.slotIcons = [];
    this.slotCounts = [];
    this.slotBgImgs = [];
    const count = Math.max(1, this.rows * this.cols);
    this.buildSlotCells(count);
    if (this.widgetKind === "CraftGrid") {
      this.craftSlots = Array.from({ length: count }, (_, i) => this.craftSlots[i] ?? { itemId: "", qty: 0 });
    }
    this.applyLayer(this._layerScrollX, this._layerScrollY, this._layerDepth, this._layerAlpha, this._layerVisible);
    this.layout();
  }

  /** Point this Inventory grid at a specific Inventory behavior — used by the
   *  attaching Widget behavior so an attached inventory shows its host's items
   *  (when `targetBp` is left empty). */
  setTargetInventory(inv: import("./Inventory").Inventory | null): void {
    this._targetInventory = inv;
  }

  // ── Cross-widget drag (shared scene payload) ─────────────────────────
  private getDrag(): UIDragPayload | undefined {
    return this.sprite.scene?.data.get("peaky.uiDrag") as UIDragPayload | undefined;
  }
  private setDrag(p: UIDragPayload | undefined): void {
    this.sprite.scene?.data.set("peaky.uiDrag", p);
  }
  private maxStackOf(item: string): number {
    const meta = this.sprite.scene?.data.get("peaky.itemMeta") as Record<string, { maxStack?: number }> | undefined;
    return meta?.[item]?.maxStack ?? 99;
  }
  /** The slot store this renderer owns for drag targeting (Inventory → its
   *  target inventory's slots, CraftGrid → its input slots, else null). */
  slotArray(): InventorySlot[] | null {
    if (this.widgetKind === "Inventory") return this.resolveTargetInventory()?.slots ?? null;
    if (this.widgetKind === "CraftGrid") return this.craftSlots;
    return null;
  }
  /** Slot index under (px,py), or -1. Public for cross-widget drop targeting. */
  hitSlot(px: number, py: number): number { return this.slotIndexAt(px, py); }
  /** True if (px,py) is over the CraftGrid result slot. */
  hitResult(px: number, py: number): boolean {
    if (this.widgetKind !== "CraftGrid") return false;
    const r = this.resultRect();
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }
  /** Find an Inventory/CraftGrid widget slot under the pointer (cross-widget). */
  private findDropTarget(px: number, py: number): { renderer: UIWidgetRenderer; slots: InventorySlot[]; idx: number } | null {
    const all = (this.sprite.scene?.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (s.destroyed || !s.isUIWidget) continue;
      const r = s.findBehaviorByKind("UIWidgetRenderer") as UIWidgetRenderer | undefined;
      if (!r) continue;
      const arr = r.slotArray();
      if (!arr) continue;
      const idx = r.hitSlot(px, py);
      if (idx >= 0) return { renderer: r, slots: arr, idx };
    }
    return null;
  }

  /** After a direct slot mutation (drag/transfer), tell the bound Inventory to
   *  re-sync its HUD globals + cross-scene snapshot — drag paths bypass addItem. */
  commitInventoryChange(): void {
    (this.resolveTargetInventory() as unknown as { notifyChanged?: () => void } | null)?.notifyChanged?.();
  }

  /** Resolve (and cache) the Inventory behavior this grid mirrors. */
  private resolveTargetInventory(): import("./Inventory").Inventory | null {
    if (this._targetInventory && !this._targetInventory.sprite.destroyed) return this._targetInventory;
    this._targetInventory = null;
    const scene = this.sprite.scene;
    if (!scene) return null;
    const target = this.targetBp.trim();
    if (!target) return null; // attached-host path sets _targetInventory directly
    const all = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (s.destroyed) continue;
      if (s.blueprintName === target || s.instanceName === target || s.tags.has(target)) {
        const inv = s.findBehaviorByKind("Inventory");
        if (inv) { this._targetInventory = inv; return inv; }
      }
    }
    return null;
  }

  private _diagLogged = false;

  /** Current texture key for a resolved grid sprite visual: the single chosen
   *  frame (static) or the cycling frame (animated). "" when not set. */
  private frameKeyOf(v: { keys: string[]; fps: number; loop: boolean; animated: boolean }, nowSec: number): string {
    if (v.keys.length === 0) return "";
    if (!v.animated || v.keys.length === 1) return v.keys[0];
    const fps = v.fps > 0 ? v.fps : 8;
    const raw = Math.floor(nowSec * fps);
    return v.keys[v.loop ? raw % v.keys.length : Math.min(raw, v.keys.length - 1)];
  }

  update(_delta: number): void {
    if (this.sprite.destroyed) return;
    // Apply declarative bindings BEFORE the text/value resolution below
    // so a bound `text` shows up immediately, a bound `value` shows in
    // the slider fill, etc. Cheap when there are no bindings (most
    // widgets have none) — early-return on empty array.
    if (this._bindings && this._bindings.length > 0) this.applyBindings();
    // Re-resolve label (for {var} interpolation + ProgressBar value
    // text if we add it later) and slider fill ratio. Layout follows.
    if (this.label) {
      const next = this.resolveLabel();
      if (next !== this.lastLabelText) {
        this.label.setText(next);
        this.lastLabelText = next;
      }
    }
    if (this.widgetKind === "Inventory") this.refreshInventory();
    if (this.widgetKind === "Crafting") this.refreshCrafting();
    if (this.widgetKind === "CraftGrid") this.refreshCraftGrid();
    if (this.widgetKind === "Shop") this.refreshShop();
    this.layout();
  }

  /** Repaint slot icons + counts from the target Inventory's slots. */
  private refreshInventory(): void {
    const inv = this.resolveTargetInventory();
    const scene = this.sprite.scene;
    // Surface the silent "widget points at nothing" failure once, with the
    // names/tags it could have matched, so authors aren't left guessing.
    if (!inv && this.targetBp.trim() && !this._diagLogged) {
      this._diagLogged = true;
      const all = (scene?.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const ids = all.filter((s) => !s.destroyed && s.findBehaviorByKind("Inventory"))
        .map((s) => s.blueprintName || s.instanceName || `uid${s.uid}`);
      console.warn(`[Inventory widget] "Reads from" = "${this.targetBp}" matched no live sprite with an Inventory. Sprites that DO have one: [${ids.join(", ") || "none"}]. Set "Reads from" to that blueprint's name or a tag it carries.`);
    }
    type IconMeta = { iconKeys?: string[]; fps?: number; loop?: boolean; animated?: boolean };
    const meta = (scene?.data.get("peaky.itemMeta") as Record<string, IconMeta> | undefined) ?? {};
    const nowSec = (scene?.time.now ?? 0) / 1000;
    // While an item is being dragged out of one of our slots, paint that slot
    // empty so the item visually "leaves" the slot and lives only on the cursor.
    const drag = this.getDrag();
    const hideIdx = drag && drag.source.kind === "slot" && drag.source.renderer === this ? drag.source.idx : -1;
    for (let i = 0; i < this.slotIcons.length; i++) {
      const slot = inv?.slots[i];
      const icon = this.slotIcons[i];
      const cnt = this.slotCounts[i];
      if (i !== hideIdx && slot && slot.itemId && slot.qty > 0) {
        const m = meta[slot.itemId];
        const keys = m?.iconKeys ?? [];
        let key = keys[0];
        if (m?.animated && keys.length > 1) {
          const fps = m.fps && m.fps > 0 ? m.fps : 8;
          const raw = Math.floor(nowSec * fps);
          // Loop wraps; non-loop holds the last frame (matches SpriteRenderer).
          const idx = m.loop ? raw % keys.length : Math.min(raw, keys.length - 1);
          key = keys[idx];
        }
        const hasIcon = !!key && !!scene?.textures.exists(key);
        if (hasIcon) {
          icon.setTexture(key);
          icon.setVisible(this._layerVisible);
        } else {
          icon.setVisible(false);
        }
        // Show the count for stacks (qty>1) AND for any item whose icon is
        // missing — otherwise a single un-iconed item paints a blank slot and
        // looks like "nothing was added".
        const showCount = slot.qty > 1 || !hasIcon;
        cnt.setText(showCount ? String(slot.qty) : "");
        cnt.setVisible(this._layerVisible && showCount);
      } else {
        icon.setVisible(false);
        cnt.setText("");
        cnt.setVisible(false);
      }
    }
  }

  /** Repaint crafting cells: each cell shows a recipe's OUTPUT icon, tinted with
   *  `uncraftableTint` when the target Inventory can't currently craft it. */
  private refreshCrafting(): void {
    const scene = this.sprite.scene;
    type IconMeta = { iconKeys?: string[]; fps?: number; loop?: boolean; animated?: boolean };
    const meta = (scene?.data.get("peaky.itemMeta") as Record<string, IconMeta> | undefined) ?? {};
    // Filter out disabled recipes so the Crafting widget doesn't even
    // SHOW them. inv.canCraft / inv.craft are gated separately as a
    // defense in depth.
    this._craftRecipes = Object.values((scene?.data.get("peaky.recipes") as Record<string, import("./Inventory").RecipeRuntime> | undefined) ?? {})
      .filter((r) => r.enabled !== false);
    const inv = this.resolveTargetInventory();
    const nowSec = (scene?.time.now ?? 0) / 1000;
    for (let i = 0; i < this.slotIcons.length; i++) {
      const recipe = this._craftRecipes[i];
      const icon = this.slotIcons[i];
      const cnt = this.slotCounts[i];
      if (recipe && recipe.outputItem) {
        const m = meta[recipe.outputItem];
        const keys = m?.iconKeys ?? [];
        let key = keys[0];
        if (m?.animated && keys.length > 1) {
          const fps = m.fps && m.fps > 0 ? m.fps : 8;
          const raw = Math.floor(nowSec * fps);
          const idx = m.loop ? raw % keys.length : Math.min(raw, keys.length - 1);
          key = keys[idx];
        }
        if (key && scene?.textures.exists(key)) {
          icon.setTexture(key);
          icon.setVisible(this._layerVisible);
          // Tint (not alpha) signals "can't craft" — tint survives applyLayer.
          if (inv && inv.canCraft(recipe)) icon.clearTint();
          else icon.setTint(this.uncraftableTint);
        } else {
          icon.setVisible(false);
        }
        cnt.setText(recipe.outputQty > 1 ? String(recipe.outputQty) : "");
        cnt.setVisible(this._layerVisible && recipe.outputQty > 1);
      } else {
        icon.setVisible(false);
        icon.clearTint();
        cnt.setText("");
        cnt.setVisible(false);
      }
    }
  }

  /** Remaining stock for shop slot `idx`. ∞ when the slot is unlimited
   *  (config stock < 0); otherwise the persistent remaining, lazily seeded
   *  from config the first time it's read. */
  slotStockRemaining(idx: number): number {
    const cfg = this.shopSlots[idx]?.stock ?? -1;
    if (cfg < 0) return Infinity;
    const store = persistentState().shopStock;
    const key = `${this.shopId || "shop"}#${idx}`;
    if (store[key] === undefined) store[key] = Math.max(0, Math.floor(cfg));
    return store[key];
  }

  /** Repaint the Shop grid — each slot shows its item's icon + price (and stock
   *  count when limited). Sold-out / unaffordable slots are tinted. */
  private refreshShop(): void {
    const scene = this.sprite.scene;
    type IconMeta = { iconKeys?: string[]; fps?: number; loop?: boolean; animated?: boolean; buyPrice?: number };
    const meta = (scene?.data.get("peaky.itemMeta") as Record<string, IconMeta> | undefined) ?? {};
    const cur = (this.shopCurrency || "gold").replace(/[^A-Za-z0-9_]/g, "");
    const gold = Math.max(0, Number(persistentState().globals[cur]) || 0);
    const nowSec = (scene?.time.now ?? 0) / 1000;
    for (let i = 0; i < this.slotIcons.length; i++) {
      const slot = this.shopSlots[i];
      const item = slot?.item ?? "";
      const icon = this.slotIcons[i];
      const cnt = this.slotCounts[i];
      const m = item ? meta[item] : undefined;
      const keys = m?.iconKeys ?? [];
      let key = keys[0];
      if (m?.animated && keys.length > 1) {
        const fps = m.fps && m.fps > 0 ? m.fps : 8;
        const raw = Math.floor(nowSec * fps);
        key = keys[m.loop ? raw % keys.length : Math.min(raw, keys.length - 1)];
      }
      const price = m?.buyPrice ?? 0;
      const limited = (slot?.stock ?? -1) >= 0;
      const remaining = item ? this.slotStockRemaining(i) : 0;
      const soldOut = limited && remaining <= 0;
      const cantAfford = price > 0 && gold < price;
      if (item && key && scene?.textures.exists(key)) {
        icon.setTexture(key);
        icon.setVisible(this._layerVisible);
        if (soldOut || cantAfford) icon.setTint(this.uncraftableTint);
        else icon.clearTint();
      } else {
        icon.setVisible(false);
        icon.clearTint();
      }
      // Slot label = remaining STOCK (an amount, like an inventory slot's qty) —
      // NOT the price, which would clash with that meaning. Price shows on the
      // Buy button. Unlimited slots show no number.
      const label = item && limited ? String(remaining) : "";
      cnt.setText(label);
      cnt.setVisible(this._layerVisible && label !== "");
    }
  }

  /** Buy the CURRENTLY-SELECTED shop slot — charge the money global, decrement
   *  stock (if limited), give the item. No-op if nothing selected, sold out,
   *  or unaffordable. Public so a Buy button (another widget) can call it. */
  buySelected(): void {
    const idx = this.selectedSlot;
    const slot = this.shopSlots[idx];
    if (!slot || !slot.item) return;
    const meta = (this.sprite.scene?.data?.get("peaky.itemMeta") as Record<string, ShopItemMeta> | undefined)?.[slot.item];
    if (!meta || meta.buyPrice <= 0) return;
    if (this.slotStockRemaining(idx) <= 0) return; // sold out
    const cur = (this.shopCurrency || "gold").replace(/[^A-Za-z0-9_]/g, "");
    const store = persistentState().globals;
    const gold = Math.max(0, Number(store[cur]) || 0);
    if (gold < meta.buyPrice) return;
    store[cur] = gold - meta.buyPrice;
    if (slot.stock >= 0) {
      const sk = `${this.shopId || "shop"}#${idx}`;
      persistentState().shopStock[sk] = Math.max(0, this.slotStockRemaining(idx) - 1);
    }
    const inv = this.findShopInventory();
    if (inv) inv.addItem(slot.item, 1, Math.max(1, meta.maxStack));
    else store[meta.countGlobal] = (Number(store[meta.countGlobal]) || 0) + 1;
  }

  /** Repaint CraftGrid input slots from `craftSlots`, match a recipe, and paint
   *  the result slot with the matched output (or hide it). */
  private refreshCraftGrid(): void {
    const scene = this.sprite.scene;
    type IconMeta = { iconKeys?: string[]; fps?: number; loop?: boolean; animated?: boolean };
    const meta = (scene?.data.get("peaky.itemMeta") as Record<string, IconMeta> | undefined) ?? {};
    const nowSec = (scene?.time.now ?? 0) / 1000;
    const keyFor = (item: string): string | undefined => {
      const m = meta[item];
      const keys = m?.iconKeys ?? [];
      if (keys.length === 0) return undefined;
      if (m?.animated && keys.length > 1) {
        const fps = m.fps && m.fps > 0 ? m.fps : 8;
        const raw = Math.floor(nowSec * fps);
        return keys[m.loop ? raw % keys.length : Math.min(raw, keys.length - 1)];
      }
      return keys[0];
    };
    const drag = this.getDrag();
    const hideIdx = drag && drag.source.kind === "slot" && drag.source.renderer === this ? drag.source.idx : -1;
    for (let i = 0; i < this.slotIcons.length; i++) {
      const slot = this.craftSlots[i];
      const icon = this.slotIcons[i];
      const cnt = this.slotCounts[i];
      if (i !== hideIdx && slot && slot.itemId && slot.qty > 0) {
        const key = keyFor(slot.itemId);
        if (key && scene?.textures.exists(key)) { icon.setTexture(key); icon.setVisible(this._layerVisible); }
        else icon.setVisible(false);
        cnt.setText(slot.qty > 1 ? String(slot.qty) : "");
        cnt.setVisible(this._layerVisible && slot.qty > 1);
      } else {
        icon.setVisible(false);
        cnt.setText("");
        cnt.setVisible(false);
      }
    }
    this._matchedRecipe = this.matchRecipe();
    const r = this._matchedRecipe;
    if (this.resultIcon && this.resultCount) {
      const key = r && r.outputItem ? keyFor(r.outputItem) : undefined;
      if (r && key && scene?.textures.exists(key)) {
        this.resultIcon.setTexture(key);
        this.resultIcon.setVisible(this._layerVisible);
        this.resultCount.setText(r.outputQty > 1 ? String(r.outputQty) : "");
        this.resultCount.setVisible(this._layerVisible && r.outputQty > 1);
      } else {
        this.resultIcon.setVisible(false);
        this.resultCount.setText("");
        this.resultCount.setVisible(false);
      }
    }
  }

  /** Shapeless match: the items placed in the grid must EXACTLY equal a recipe's
   *  inputs (same item set, same quantities). Exact (not >=) so that adding a
   *  unit switches recipes — e.g. 1 metal + 2 wood = sword, but 2 metal + 2 wood
   *  = hammer rather than still matching the cheaper sword. */
  private matchRecipe(): import("./Inventory").RecipeRuntime | null {
    const scene = this.sprite.scene;
    // Disabled recipes are skipped — the CraftGrid result slot stays
    // empty even when the player places matching inputs. Authors flip
    // `enabled` via the Recipe inspector (default) or `Set Recipe
    // Enabled` at runtime to unlock the recipe.
    const recipes = Object.values((scene?.data.get("peaky.recipes") as Record<string, import("./Inventory").RecipeRuntime> | undefined) ?? {})
      .filter((r) => r.enabled !== false);
    const placed = new Map<string, number>();
    for (const s of this.craftSlots) if (s.itemId && s.qty > 0) placed.set(s.itemId, (placed.get(s.itemId) ?? 0) + s.qty);
    if (placed.size === 0) return null;
    for (const r of recipes) {
      const req = new Map<string, number>();
      for (const inp of r.inputs) if (inp.item) req.set(inp.item, (req.get(inp.item) ?? 0) + inp.qty);
      if (req.size === 0 || req.size !== placed.size) continue;
      let ok = true;
      for (const [item, qty] of req) if ((placed.get(item) ?? 0) !== qty) { ok = false; break; }
      if (ok) return r;
    }
    return null;
  }

  onDestroy(): void {
    this.shadow?.destroy();
    this.bg?.destroy();
    this.fill?.destroy();
    this.border?.destroy();
    this.image?.destroy();
    this.label?.destroy();
    this.chevron?.destroy();
    this.optionList?.destroy();
    for (const g of this.slotBgs) g.destroy();
    for (const im of this.slotIcons) im.destroy();
    for (const t of this.slotCounts) t.destroy();
    for (const im of this.slotBgImgs) im.destroy();
    this._panelImg?.destroy();
    this._selectionImg?.destroy();
    this.resultBg?.destroy();
    this.resultBgImg?.destroy();
    this.resultIcon?.destroy();
    this.resultCount?.destroy();
    this.resultArrow?.destroy();
    this.resultArrowImg?.destroy();
    // If a cross-widget drag this renderer started is still in flight, clear it
    // (its pointerup listener is about to detach and could never resolve).
    const drag = this.getDrag();
    if (drag && drag.source.renderer === this) { drag.ghost.destroy(); this.setDrag(undefined); }
    const scene = this.sprite.scene;
    if (scene) {
      if (this.onPointerDown) scene.input.off("pointerdown", this.onPointerDown);
      if (this.onPointerUp) scene.input.off("pointerup", this.onPointerUp);
      if (this.onPointerMove) scene.input.off("pointermove", this.onPointerMove);
      (scene.data.get("peaky.mouseBlockers") as Set<UIWidgetRenderer> | undefined)?.delete(this);
    }
  }

  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    this._layerScrollX = scrollX;
    this._layerScrollY = scrollY;
    this._layerDepth = baseDepth;
    this._layerAlpha = alpha;
    this._layerVisible = visible;
    const a = alpha * this._opacity;
    // Shadow renders BELOW the bg (at index 0 / lowest depth), followed
    // by bg, fill, BORDER (on top of fill so progressbar outlines stay
    // visible), image, label, chevron stacking upward.
    [this.shadow, this.bg, this.fill, this.border, this.image, this.label, this.chevron].forEach((go, i) => {
      if (!go) return;
      go.setScrollFactor(scrollX, scrollY);
      go.setDepth(baseDepth + i);
      go.setAlpha(a);
      go.setVisible(visible);
    });
    // Custom-grid sprite visuals: panel behind everything, slot bg with the
    // colored slots, selection frame above the icons.
    if (this._panelImg) { this._panelImg.setScrollFactor(scrollX, scrollY); this._panelImg.setDepth(baseDepth + 7); this._panelImg.setAlpha(a); }
    for (const im of this.slotBgImgs) { im.setScrollFactor(scrollX, scrollY); im.setDepth(baseDepth + 8); im.setAlpha(a); }
    if (this._selectionImg) { this._selectionImg.setScrollFactor(scrollX, scrollY); this._selectionImg.setDepth(baseDepth + 11); this._selectionImg.setAlpha(a); }
    // Inventory slot overlays — bg below, icon above, count on top. Visibility
    // of icons/counts is also gated per-slot by refreshInventory (empty slots
    // hide their icon/count regardless of layer visibility).
    for (const g of this.slotBgs) { g.setScrollFactor(scrollX, scrollY); g.setDepth(baseDepth + 8); g.setAlpha(a); g.setVisible(visible); }
    for (const im of this.slotIcons) { im.setScrollFactor(scrollX, scrollY); im.setDepth(baseDepth + 9); im.setAlpha(a); }
    for (const t of this.slotCounts) { t.setScrollFactor(scrollX, scrollY); t.setDepth(baseDepth + 10); t.setAlpha(a); }
    // CraftGrid result slot overlays share the slot depth band.
    if (this.resultBg) { this.resultBg.setScrollFactor(scrollX, scrollY); this.resultBg.setDepth(baseDepth + 8); this.resultBg.setAlpha(a); this.resultBg.setVisible(visible); }
    if (this.resultBgImg) { this.resultBgImg.setScrollFactor(scrollX, scrollY); this.resultBgImg.setDepth(baseDepth + 8); this.resultBgImg.setAlpha(a); }
    if (this.resultArrow) { this.resultArrow.setScrollFactor(scrollX, scrollY); this.resultArrow.setDepth(baseDepth + 8); this.resultArrow.setAlpha(a); this.resultArrow.setVisible(visible); }
    if (this.resultArrowImg) { this.resultArrowImg.setScrollFactor(scrollX, scrollY); this.resultArrowImg.setDepth(baseDepth + 8); this.resultArrowImg.setAlpha(a); }
    if (this.resultIcon) { this.resultIcon.setScrollFactor(scrollX, scrollY); this.resultIcon.setDepth(baseDepth + 9); this.resultIcon.setAlpha(a); }
    if (this.resultCount) { this.resultCount.setScrollFactor(scrollX, scrollY); this.resultCount.setDepth(baseDepth + 10); this.resultCount.setAlpha(a); }
  }

  /** Runtime opacity (0..1) set by SetUIElement. Composed with the layer
   *  alpha and re-applied so the value sticks across layer recomputes. */
  setOpacity(o: number): void {
    this._opacity = Math.max(0, Math.min(1, o));
    this.applyLayer(this._layerScrollX, this._layerScrollY, this._layerDepth, this._layerAlpha, this._layerVisible);
  }

  /** Toggle this element's visibility without disturbing its opacity. */
  setElementVisible(v: boolean): void {
    this.sprite.gameObject.setVisible(v);
    this.applyLayer(this._layerScrollX, this._layerScrollY, this._layerDepth, this._layerAlpha, v);
  }

  /** Apply a single runtime property from the SetUIElement node. layout()
   *  re-reads these fields every tick, so most are plain assignments; the
   *  exceptions (bgColor's currentBgColor mirror, enabled's binding flag,
   *  opacity's layer re-apply, spriteId's texture swap) are handled here so
   *  callers don't have to. */
  setLiveProp(prop: string, value: number | string | boolean): void {
    const num = Number(value);
    const bool = value === true || (typeof value === "number" && value !== 0) || value === "true";
    switch (prop) {
      // Text content
      case "text": this.text = String(value); this.lastLabelText = ""; break;
      case "selectedValue": this.selectedValue = String(value); this.lastLabelText = ""; break;
      // Font
      case "fontFamily": this.fontFamily = String(value); break;
      case "fontSize": if (Number.isFinite(num)) this.fontSize = num; break;
      case "fontColor": if (Number.isFinite(num)) this.fontColor = num; break;
      case "fontBold": this.fontBold = bool; break;
      case "fontItalic": this.fontItalic = bool; break;
      case "align": this.align = String(value) as "left" | "center" | "right"; break;
      case "vAlign": this.vAlign = String(value) as "top" | "middle" | "bottom"; break;
      // Shop role — re-point/retype an element at runtime (dynamic shops).
      case "shopRole": this.shopRole = String(value); this.lastLabelText = ""; break;
      case "shopItem": this.shopItem = String(value); this.lastLabelText = ""; break;
      case "shopCurrency": this.shopCurrency = String(value); break;
      // Slider / progress
      case "value": this.value = typeof value === "boolean" ? Number(value) : value; break;
      case "min": if (Number.isFinite(num)) this.min = num; break;
      case "max": if (Number.isFinite(num)) this.max = num; break;
      case "fillColor": if (Number.isFinite(num)) this.fillColor = num; break;
      case "direction": this.direction = String(value) as "horizontal" | "vertical"; break;
      // Box / background
      case "bgColor":
        if (!Number.isFinite(num)) break;
        this.bgColor = num;
        // layout() draws from currentBgColor; sync it unless a hover/press is
        // actively overriding the color (pointer handlers re-sync on exit).
        if (!this.pressed && !this.hovering) this.currentBgColor = num;
        break;
      case "bgAlpha": if (Number.isFinite(num)) this.bgAlpha = num; break;
      // Inventory / CraftGrid grid dimensions — rebuild the slot cells.
      case "rows":
        if (Number.isFinite(num) && num >= 1) { this.rows = Math.floor(num); this.rebuildSlots(); }
        break;
      case "cols":
        if (Number.isFinite(num) && num >= 1) { this.cols = Math.floor(num); this.rebuildSlots(); }
        break;
      case "borderColor": if (Number.isFinite(num)) this.borderColor = num; break;
      case "borderWidth": if (Number.isFinite(num)) this.borderWidth = num; break;
      case "cornerRadius": if (Number.isFinite(num)) this.cornerRadius = num; break;
      case "padding": if (Number.isFinite(num)) this.padding = num; break;
      case "hoverBgColor": if (Number.isFinite(num)) this.hoverBgColor = num; break;
      case "pressedBgColor": if (Number.isFinite(num)) this.pressedBgColor = num; break;
      // Behavior
      case "enabled": this._bindingEnabled = bool; break;
      case "opacity": this.setOpacity(num); break;
      // Image texture swap — resolve the new sprite's frame-0 key from the
      // scene's id→key map (built by runProject for every project sprite).
      case "spriteId": {
        const id = String(value);
        const map = this.sprite.scene.data.get("peaky.spriteImageKey") as Record<string, string> | undefined;
        const key = map?.[id];
        if (key && this.image && this.sprite.scene.textures.exists(key)) {
          this.imageTextureKey = key;
          this.image.setTexture(key);
        }
        break;
      }
    }
  }

  // ── private helpers ────────────────────────────────────────────────

  /** Emit a widget element signal. Fires on this sprite's own bus AND — for a
   *  multi-mode child — on the parent widget's bus, so the widget's logic
   *  sheet (which lives on the parent) hears child element signals like a
   *  button click. Single-mode widgets host their own sheet, so the self-emit
   *  is enough there. */
  private emitSignal(sig: string): void {
    if (!sig) return;
    this.sprite.events.emit(sig);
    const pid = this.sprite.parentInstanceId;
    if (!pid) return;
    const all = (this.sprite.scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (!s.destroyed && s.instanceId === pid) { s.events.emit(sig); break; }
    }
  }

  private applyDecor(go: Phaser.GameObjects.GameObject): void {
    // Cast through `unknown` because not every GameObject subclass has
    // all three components in its type chain — but Rectangle / Image /
    // Text all do at runtime, and we only call this on those.
    const any = go as unknown as {
      setScrollFactor?: (x: number, y: number) => void;
      setDepth?: (n: number) => void;
      setAlpha?: (a: number) => void;
      setVisible?: (v: boolean) => void;
    };
    any.setScrollFactor?.(this._layerScrollX, this._layerScrollY);
    any.setDepth?.(this._layerDepth + 1);
    any.setAlpha?.(this._layerAlpha * this._opacity);
    any.setVisible?.(this._layerVisible);
  }

  private buildTextStyle(): Phaser.Types.GameObjects.Text.TextStyle {
    const fontStyle = [
      this.fontBold ? "bold" : "",
      this.fontItalic ? "italic" : "",
    ].filter(Boolean).join(" ") || "normal";
    return {
      fontFamily: this.fontFamily,
      fontSize: `${Math.round(this.fontSize)}px`,
      color: cssColor(this.fontColor),
      fontStyle,
    };
  }

  private applyTextOrigin(t: Phaser.GameObjects.Text): void {
    let ox = 0.5, oy = 0.5;
    if (this.align === "left") ox = 0;
    else if (this.align === "right") ox = 1;
    if (this.vAlign === "top") oy = 0;
    else if (this.vAlign === "bottom") oy = 1;
    t.setOrigin(ox, oy);
  }

  /**
   * Apply declarative bindings each tick. For each binding row whose
   * `childName` targets this sprite (empty = root / single-mode self;
   * otherwise must match `_childName`), evaluate `source` via the shared
   * expression evaluator and write into the matching property.
   *
   * Supported properties:
   *   - text     → this.text (label/button content; honors interpolation)
   *   - value    → this.value (slider / progress numeric)
   *   - visible  → driven via layer-level setVisible on the renderer's
   *                game objects; falsy hides the entire widget visual
   *   - bgColor  → this.bgColor (forces a layout to re-draw the bg rect)
   *   - enabled  → this._bindingEnabled (suppresses click/drag handlers)
   *
   * Cached per-binding: identical evaluations skip the write so we don't
   * dirty Phaser objects every tick when the source hasn't changed.
   */
  private _bindingEnabled = true;
  private applyBindings(): void {
    const ours = this._childName ?? "";
    for (const b of this._bindings) {
      const targetChild = b.childName ?? "";
      if (targetChild !== ours) continue;
      const expr = String(b.source ?? "").trim();
      if (!expr) continue;
      const cacheKey = b.id ?? `${b.property}:${expr}`;
      const result = evalExpression(this.sprite, expr);
      if (this._bindingLastValue.get(cacheKey) === result) continue;
      this._bindingLastValue.set(cacheKey, result);
      switch (b.property) {
        case "text": {
          // Coerce to string. Label / button / dropdown header read this
          // via resolveLabel() on the next tick path.
          this.text = result === null || result === undefined ? "" : String(result);
          // Force the label to re-resolve interpolation against the new
          // value by invalidating the cached last-rendered string.
          this.lastLabelText = "";
          break;
        }
        case "value": {
          const n = typeof result === "number" ? result : Number(result);
          if (Number.isFinite(n)) this.value = n;
          break;
        }
        case "visible": {
          // evalExpression returns a number (0 for false-ish, non-zero
          // for true-ish — comparisons emit 0/1).
          const truthy = Number(result) !== 0;
          // Apply by re-running applyLayer with current params but
          // overridden visibility — cheap and respects layer-level
          // scroll/depth/alpha.
          this.applyLayer(this._layerScrollX, this._layerScrollY, this._layerDepth, this._layerAlpha, truthy);
          break;
        }
        case "bgColor": {
          const n = Number(result);
          if (Number.isFinite(n)) {
            this.bgColor = n;
            // Force a re-layout so the bg rect picks up the new color.
            this.layout();
          }
          break;
        }
        case "enabled": {
          this._bindingEnabled = Number(result) !== 0;
          break;
        }
      }
    }
  }

  /** Item catalog row for a given item name. */
  private metaFor(name: string): ShopItemMeta | undefined {
    if (!name) return undefined;
    const cat = this.sprite.scene?.data?.get("peaky.itemMeta") as Record<string, ShopItemMeta> | undefined;
    return cat?.[name];
  }

  /** Resolve one property of an item to display text. Handles the built-ins
   *  (name / price / buyPrice / sellPrice / maxStack / count) plus any CUSTOM
   *  property defined on the item. Empty string when the item or prop is
   *  unknown. Shared by the {shop.<prop>} and {item:<Name>.<prop>} tokens. */
  private itemPropToString(itemName: string, prop: string): string {
    if (!itemName) return "";
    if (prop === "name") return itemName;
    const m = this.metaFor(itemName);
    if (!m) return "";
    switch (prop) {
      case "price":
      case "buyPrice":  return String(m.buyPrice ?? 0);
      case "sellPrice": return String(m.sellPrice ?? 0);
      case "stack":
      case "maxStack":  return String(m.maxStack ?? 0);
      case "count":
      case "owned":     return String(Number(persistentState().globals[m.countGlobal]) || 0);
    }
    const pv = m.props?.[prop];
    return pv === undefined ? "" : String(pv);
  }

  private shopItemMeta(): ShopItemMeta | undefined {
    return this.metaFor(this.shopItem);
  }

  /** The item name of the Shop grid's currently-selected slot (""). */
  selectedItem(): string {
    return this.shopSlots[this.selectedSlot]?.item ?? "";
  }

  /** Inventory to give/take through — an explicit target, else the first
   *  Inventory in the scene (the player). null = no bag (counts-only via globals). */
  private findShopInventory(): import("./Inventory").Inventory | null {
    // 1. The shop's own explicit "Reads from" target, if set.
    const explicit = this.resolveTargetInventory();
    if (explicit) return explicit;
    const all = (this.sprite.scene?.data?.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    // 2. Wherever an Inventory WIDGET in the scene is pointed — so a shop with no
    //    explicit target adds to the SAME bag the player sees on screen. Without
    //    this, the shop grabs the first character with an Inventory (often the
    //    wrong one), so purchases land in a bag the open widget isn't showing.
    for (const s of all) {
      if (s.destroyed) continue;
      const r = s.findBehaviorByKind("UIWidgetRenderer") as UIWidgetRenderer | undefined;
      if (r && r.widgetKind === "Inventory") {
        const inv = r.resolveTargetInventory();
        if (inv) return inv;
      }
    }
    // 3. Last resort: the first character that has an Inventory behavior.
    for (const s of all) {
      if (s.destroyed) continue;
      const inv = s.findBehaviorByKind("Inventory");
      if (inv) return inv as import("./Inventory").Inventory;
    }
    return null;
  }

  /** Run a buy/sell transaction against the money global + the bag (or item
   *  count global when there's no Inventory). No-op if unaffordable / empty. */
  /** Find the Shop grid widget in the scene (first one). Used by a Buy button
   *  with no specific item to buy the grid's currently-selected slot. */
  private findShopGrid(): UIWidgetRenderer | null {
    const all = (this.sprite.scene?.data?.get("peaky.sprites") as Sprite[] | undefined) ?? [];
    for (const s of all) {
      if (s.destroyed) continue;
      const r = s.findBehaviorByKind("UIWidgetRenderer") as UIWidgetRenderer | undefined;
      if (r && r.widgetKind === "Shop") return r;
    }
    return null;
  }

  private runShopTransaction(): void {
    // Buy button with no specific item → buy the Shop grid's SELECTED slot.
    if (this.shopRole === "buy" && !this.shopItem.trim()) {
      this.findShopGrid()?.buySelected();
      return;
    }
    const meta = this.shopItemMeta();
    if (!meta) return;
    const cur = (this.shopCurrency || "gold").replace(/[^A-Za-z0-9_]/g, "");
    const store = persistentState().globals;
    const gold = typeof store[cur] === "number" ? (store[cur] as number) : Number(store[cur]) || 0;
    const inv = this.findShopInventory();
    const have = inv ? inv.countItem(this.shopItem) : Math.max(0, Number(store[meta.countGlobal]) || 0);
    if (this.shopRole === "buy") {
      const price = meta.buyPrice;
      if (price <= 0 || gold < price) return;
      store[cur] = gold - price;
      if (inv) inv.addItem(this.shopItem, 1, Math.max(1, meta.maxStack));
      else store[meta.countGlobal] = (Number(store[meta.countGlobal]) || 0) + 1;
    } else if (this.shopRole === "sell") {
      const price = meta.sellPrice;
      if (price <= 0 || have < 1) return;
      if (inv) inv.removeItem(this.shopItem, 1);
      else store[meta.countGlobal] = Math.max(0, (Number(store[meta.countGlobal]) || 0) - 1);
      store[cur] = gold + price;
    }
  }

  /** The buy price of the Shop grid's currently-selected slot (0 if none). */
  selectedBuyPrice(): number {
    const slot = this.shopSlots[this.selectedSlot];
    if (!slot?.item) return 0;
    const meta = (this.sprite.scene?.data?.get("peaky.itemMeta") as Record<string, { buyPrice?: number }> | undefined)?.[slot.item];
    return meta?.buyPrice ?? 0;
  }

  private resolveLabel(): string {
    // A Buy button's text is just interpolated like any label — place the
    // price/name with tokens: "Buy {shop.name} ({shop.price})". `{price}` is
    // kept as a legacy alias for `{shop.price}`. No implicit auto-append: a
    // plain "Buy" stays "Buy" (display is explicit, via tokens, everywhere).
    if (this.shopRole === "buy" && !this.shopItem.trim()) {
      const price = this.findShopGrid()?.selectedBuyPrice() ?? 0;
      return this.interpolate((this.text || "Buy").replace(/\{price\}/g, String(price)));
    }
    let raw = this.text || "";
    if (this.widgetKind === "Dropdown") {
      const sel = this.options.find((o) => o.value === this.selectedValue);
      raw = sel?.label ?? this.text ?? "Pick…";
    }
    return this.interpolate(raw);
  }

  /**
   * Replace `{varName}` and `{BpName.varName}` tokens in any text
   * (Label content, Button label, Dropdown header label OR option
   * labels, etc.). Public-shaped so the dropdown options list can
   * use the SAME convention — typing `{Player.coins}` in an option
   * label expands at render time.
   *
   *   {varName}            → reads from this widget's own vars.
   *   {BpName.varName}     → reads from the first sprite in the
   *                          scene whose blueprintName or
   *                          instanceName matches BpName.
   *
   * Tokens with unknown vars / missing BPs expand to empty string —
   * never throws, never warns repeatedly.
   */
  private interpolate(raw: string): string {
    if (!raw.includes("{")) return raw;
    return raw.replace(/\{([^}]+)\}/g, (_full, tokenRaw: string) => {
      const token = tokenRaw.trim();
      // {shop.<prop>} — ANY property of the Shop grid's currently selected
      // item: name / price / sellPrice / maxStack / count, or any CUSTOM item
      // property you defined in the Item editor. Namespaced under `shop.` so it
      // can't collide with a user var. Empty when nothing is selected.
      if (token.startsWith("shop.")) {
        return this.itemPropToString(this.findShopGrid()?.selectedItem() ?? "", token.slice(5));
      }
      // {item:<Name>.<prop>} — same properties, but for a SPECIFIC named item
      // (independent of any shop selection). e.g. {item:Sword.damage}.
      if (token.startsWith("item:")) {
        const dot = token.indexOf(".");
        return dot > 5 ? this.itemPropToString(token.slice(5, dot), token.slice(dot + 1)) : "";
      }
      // Persistent stores + cross-object reads, resolved through the shared
      // expression resolver: {global:Apple} (item count / money), {list:prices.apple},
      // {var:Player.hp}, {self.x}. This is what lets a HUD label show a global.
      if (/^(global:|list:|var:|self\.|picked\.)/.test(token)) {
        return strOr(token, "", this.sprite);
      }
      // Legacy {varName} → this widget's own var; {BpName.varName} → another
      // sprite's var by blueprint/instance name.
      const dot = token.indexOf(".");
      if (dot < 0) {
        const v = this.sprite.vars.get(token);
        return v === undefined || v === null ? "" : String(v);
      }
      const bpName = token.slice(0, dot);
      const varName = token.slice(dot + 1);
      const scene = this.sprite.scene;
      if (!scene) return "";
      const all = (scene.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const target = all.find((s) => !s.destroyed && (s.blueprintName === bpName || s.instanceName === bpName));
      if (!target) return "";
      const v = target.vars.get(varName);
      return v === undefined || v === null ? "" : String(v);
    });
  }

  /** Diagnostic: warn ONCE per unresolved expression so the user can
   *  see why their slider/progressbar is empty. Common causes:
   *   - typo in BP name (case-sensitive — "BPlayer" ≠ "Bplayer")
   *   - target BP isn't instantiated in this scene
   *   - var name doesn't exist on the target (missing or mistyped) */
  private _warnedUnresolved = new Set<string>();

  /** Resolve the slider/progress value through the expression evaluator
   *  so things like `"var:hp"` and `"var:Player.hp"` work. Falls back
   *  to a literal number. Logs once when a string expression fails to
   *  resolve so empty bars aren't mysteriously silent. */
  private resolveValue(): number {
    if (typeof this.value === "number") return this.value;
    const expr = String(this.value ?? "");
    if (!expr) return 0;
    const r = evalExpression(this.sprite, expr);
    if (typeof r === "number" && Number.isFinite(r)) return r;
    // Failed: warn once + try plain number coercion as a final fallback.
    if (!this._warnedUnresolved.has(expr)) {
      this._warnedUnresolved.add(expr);
      const all = (this.sprite.scene?.data.get("peaky.sprites") as Sprite[] | undefined) ?? [];
      const names = Array.from(new Set(all.flatMap((s) => [s.blueprintName, s.instanceName].filter(Boolean)))).join(", ");
      Logger.log({
        level: "warn",
        source: "UIWidget Slider",
        message: `Couldn't resolve "${expr}" — slider/bar reads 0. Available BP/instance names in scene: [${names || "(none)"}]. Check spelling, case, and that the target BP is instantiated.`,
      });
    }
    const fallback = Number(this.value);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  private layout(): void {
    const obj = this.sprite.gameObject;
    // Inventory frame is derived from the grid + padding (not from the stored
    // widget/instance size, which can be stale after rows/cols/padding edits).
    // This keeps the frame, the slot grid and the pointer hit-box in lockstep
    // and guarantees a `padding` gap between the frame edge and the slots.
    if (this.widgetKind === "Inventory" || this.widgetKind === "Crafting" || this.widgetKind === "Shop") {
      const gridW = this.cols * this.slotSize + (this.cols - 1) * this.slotGap;
      const gridH = this.rows * this.slotSize + (this.rows - 1) * this.slotGap;
      this.widgetW = gridW + 2 * this.padding;
      this.widgetH = gridH + 2 * this.padding;
    } else if (this.widgetKind === "CraftGrid") {
      const gridW = this.cols * this.slotSize + (this.cols - 1) * this.slotGap;
      const gridH = this.rows * this.slotSize + (this.rows - 1) * this.slotGap;
      this.widgetW = gridW + this.resultGap + this.slotSize + 2 * this.padding;
      this.widgetH = Math.max(gridH, this.slotSize) + 2 * this.padding;
    }
    const W = this.widgetW;
    const H = this.widgetH;

    // Resolve corner radii. Clamp to half the smaller dimension and coerce
    // NaN/undefined to 0 — Phaser's fillRoundedRect uses a DEFAULT 20px radius
    // for any corner that is undefined/NaN, which is what made "0 rounding"
    // widgets render rounded at runtime.
    const maxR = Math.max(0, Math.min(W, H) / 2);
    const baseR = this.cornerRadius;
    const clampR = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(maxR, v)) : 0);
    const rTL = clampR(this.cornersSeparate ? this.cornerRadiusTL : baseR);
    const rTR = clampR(this.cornersSeparate ? this.cornerRadiusTR : baseR);
    const rBL = clampR(this.cornersSeparate ? this.cornerRadiusBL : baseR);
    const rBR = clampR(this.cornersSeparate ? this.cornerRadiusBR : baseR);
    // All corners 0 → draw a plain rect. fillRoundedRect with a 0 radius can
    // still subtly bevel and trips the default-20 quirk above, so avoid it.
    const squareCorners = rTL === 0 && rTR === 0 && rBL === 0 && rBR === 0;
    const x = obj.x - W / 2;
    const y = obj.y - H / 2;

    // Shadow — drawn first so the bg sits on top. Approximated as an
    // offset, alpha-reduced, larger rounded rect for a soft halo.
    if (this.shadow) {
      this.shadow.clear();
      const sx = x + this.shadowOffsetX;
      const sy = y + this.shadowOffsetY;
      // Multiple alpha-decreasing passes simulate a blur-like falloff
      // without an actual shader. Cost: a few extra draw calls per UI
      // element, fine for typical HUD scale.
      const passes = Math.max(1, Math.min(8, Math.round(this.shadowBlur / 2)));
      for (let i = 0; i < passes; i++) {
        const inflate = (i / passes) * this.shadowBlur;
        const a = (this.shadowAlpha / passes) * (1 - i / passes);
        this.shadow.fillStyle(this.shadowColor, a);
        this.shadow.fillRoundedRect(sx - inflate, sy - inflate, W + inflate * 2, H + inflate * 2, {
          tl: rTL + inflate, tr: rTR + inflate, bl: rBL + inflate, br: rBR + inflate,
        });
      }
    }

    // Background — Graphics with rounded rect, fill only. Border lives
    // on its own layer above the progress fill so it stays visible.
    if (this.bg) {
      this.bg.clear();
      if (this.bgAlpha > 0) {
        this.bg.fillStyle(this.currentBgColor, this.bgAlpha);
        if (squareCorners) this.bg.fillRect(x, y, W, H);
        else this.bg.fillRoundedRect(x, y, W, H, { tl: rTL, tr: rTR, bl: rBL, br: rBR });
      }
    }
    // Border — drawn on its own Graphics layer at a higher depth than
    // `fill` (see applyLayer ordering). This keeps the outline visible
    // on progressbars/sliders where the fill rect would otherwise
    // overlap the border.
    if (this.border) {
      this.border.clear();
      if (this.borderWidth > 0) {
        this.border.lineStyle(this.borderWidth, this.borderColor, 1);
        if (squareCorners) this.border.strokeRect(x, y, W, H);
        else this.border.strokeRoundedRect(x, y, W, H, { tl: rTL, tr: rTR, bl: rBL, br: rBR });
      }
    }

    // Fill — slider / progressbar
    if (this.fill) {
      const v = this.resolveValue();
      const span = this.max - this.min;
      const t = span === 0 ? 0 : Math.max(0, Math.min(1, (v - this.min) / span));
      if (this.direction === "vertical") {
        const fh = H * t;
        this.fill.setOrigin(0.5, 1);
        this.fill.setPosition(obj.x, obj.y + H / 2);
        this.fill.setSize(W, fh);
      } else {
        const fw = W * t;
        this.fill.setOrigin(0, 0.5);
        this.fill.setPosition(obj.x - W / 2, obj.y);
        this.fill.setSize(fw, H);
      }
      this.fill.setFillStyle(this.fillColor, 1);
    }

    if (this.image) {
      this.image.setPosition(obj.x, obj.y);
      this.image.setDisplaySize(W, H);
    }

    if (this.label) {
      // Label sits with alignment-based origin at the corresponding
      // edge of the body rect, plus padding.
      const pad = this.padding;
      let lx = obj.x;
      let ly = obj.y;
      if (this.align === "left")  lx = obj.x - W / 2 + pad;
      if (this.align === "right") lx = obj.x + W / 2 - pad;
      if (this.vAlign === "top")    ly = obj.y - H / 2 + pad;
      if (this.vAlign === "bottom") ly = obj.y + H / 2 - pad;
      // Dropdown reserves room on the right for the chevron — text
      // doesn't get pushed under the arrow.
      if (this.widgetKind === "Dropdown") {
        if (this.align === "right") lx -= this.fontSize * 0.9;
      }
      this.label.setPosition(lx, ly);
      this.label.setStyle(this.buildTextStyle());
      this.applyTextOrigin(this.label);
    }

    if (this.chevron) {
      this.chevron.setPosition(obj.x + W / 2 - this.padding - this.fontSize * 0.4, obj.y);
      this.chevron.setStyle({
        fontFamily: this.fontFamily,
        fontSize: `${Math.round(this.fontSize)}px`,
        color: cssColor(this.fontColor),
      });
    }

    // Inventory slots — draw each slot bg + position its icon (centered) and
    // count (bottom-right corner). Slot geometry comes from slotRect().
    if (this.slotBgs.length > 0) {
      const inset = this.slotBorderWidth / 2;
      const sr = Number.isFinite(this.slotRadius)
        ? Math.max(0, Math.min(this.slotSize / 2, this.slotRadius))
        : 0;
      const squareSlots = sr === 0;
      const scn = this.sprite.scene;
      const nowSec = (scn?.time.now ?? 0) / 1000;
      const slotKey = this.frameKeyOf(this._slotBgVisual, nowSec);
      const slotSprite = slotKey && scn?.textures.exists(slotKey) ? slotKey : "";
      const selKey = this.frameKeyOf(this._selectionVisual, nowSec);
      for (let i = 0; i < this.slotBgs.length; i++) {
        const r = this.slotRect(i);
        const g = this.slotBgs[i];
        const bgImg = this.slotBgImgs[i];
        g.clear();
        // Slot background: a sprite (custom grids) OR the colored box + border.
        if (slotSprite) {
          bgImg?.setTexture(slotSprite).setPosition(r.x + r.w / 2, r.y + r.h / 2).setDisplaySize(r.w, r.h).setVisible(this._layerVisible);
        } else {
          bgImg?.setVisible(false);
          g.fillStyle(this.slotBgColor, 1);
          if (squareSlots) g.fillRect(r.x, r.y, r.w, r.h);
          else g.fillRoundedRect(r.x, r.y, r.w, r.h, sr);
          if (this.slotBorderWidth > 0) {
            g.lineStyle(this.slotBorderWidth, this.slotBorderColor, 1);
            if (squareSlots) g.strokeRect(r.x + inset, r.y + inset, r.w - this.slotBorderWidth, r.h - this.slotBorderWidth);
            else g.strokeRoundedRect(r.x + inset, r.y + inset, r.w - this.slotBorderWidth, r.h - this.slotBorderWidth, sr);
          }
        }
        // Selection frame on the chosen Shop slot (color/width outline; a sprite
        // frame is positioned separately below when a selection sprite is set).
        if (this.widgetKind === "Shop" && i === this.selectedSlot && !selKey && this.selectionWidth > 0) {
          const w2 = this.selectionWidth / 2;
          g.lineStyle(this.selectionWidth, this.selectionColor, 1);
          if (squareSlots) g.strokeRect(r.x + w2, r.y + w2, r.w - this.selectionWidth, r.h - this.selectionWidth);
          else g.strokeRoundedRect(r.x + w2, r.y + w2, r.w - this.selectionWidth, r.h - this.selectionWidth, sr);
        }
        const icon = this.slotIcons[i];
        icon.setPosition(r.x + r.w / 2, r.y + r.h / 2);
        icon.setDisplaySize(r.w - 6, r.h - 6);
        const cnt = this.slotCounts[i];
        cnt.setPosition(r.x + r.w - 3, r.y + r.h - 2);
      }

      // Whole-grid panel sprite (custom grids) — sized to the widget frame.
      if (this._panelImg) {
        const panelKey = this.frameKeyOf(this._panelVisual, nowSec);
        if (panelKey && scn?.textures.exists(panelKey)) {
          this._panelImg.setTexture(panelKey).setPosition(obj.x, obj.y).setDisplaySize(W, H).setVisible(this._layerVisible);
        } else this._panelImg.setVisible(false);
      }
      // Selection-frame sprite on the selected Shop slot (overlays the slot).
      if (this._selectionImg) {
        if (this.widgetKind === "Shop" && this.selectedSlot >= 0 && this.selectedSlot < this.slotBgs.length
            && selKey && scn?.textures.exists(selKey)) {
          const r = this.slotRect(this.selectedSlot);
          this._selectionImg.setTexture(selKey).setPosition(r.x + r.w / 2, r.y + r.h / 2).setDisplaySize(r.w, r.h).setVisible(this._layerVisible);
        } else this._selectionImg.setVisible(false);
      }

      // CraftGrid result slot + arrow (same square-when-radius-0 styling).
      // When a custom slot sprite is set, paint the result slot with it too
      // (matches the input slots) and hide the colored placeholder rect.
      if (this.widgetKind === "CraftGrid" && this.resultBg) {
        const rr = this.resultRect();
        this.resultBg.clear();
        if (slotSprite) {
          this.resultBgImg?.setTexture(slotSprite).setPosition(rr.x + rr.w / 2, rr.y + rr.h / 2).setDisplaySize(rr.w, rr.h).setVisible(this._layerVisible);
        } else {
          this.resultBgImg?.setVisible(false);
          this.resultBg.fillStyle(this.slotBgColor, 1);
          if (squareSlots) this.resultBg.fillRect(rr.x, rr.y, rr.w, rr.h);
          else this.resultBg.fillRoundedRect(rr.x, rr.y, rr.w, rr.h, sr);
          if (this.slotBorderWidth > 0) {
            this.resultBg.lineStyle(this.slotBorderWidth, this.slotBorderColor, 1);
            if (squareSlots) this.resultBg.strokeRect(rr.x + inset, rr.y + inset, rr.w - this.slotBorderWidth, rr.h - this.slotBorderWidth);
            else this.resultBg.strokeRoundedRect(rr.x + inset, rr.y + inset, rr.w - this.slotBorderWidth, rr.h - this.slotBorderWidth, sr);
          }
        }
        this.resultIcon?.setPosition(rr.x + rr.w / 2, rr.y + rr.h / 2).setDisplaySize(rr.w - 6, rr.h - 6);
        this.resultCount?.setPosition(rr.x + rr.w - 3, rr.y + rr.h - 2);
        // Arrow: prefer the sprite when set, else fall back to the "▸" text.
        const arrowKey = this.frameKeyOf(this._craftArrowVisual, nowSec);
        const arrowSprite = arrowKey && scn?.textures.exists(arrowKey) ? arrowKey : "";
        const arrowX = rr.x - this.resultGap / 2;
        const arrowY = this.sprite.gameObject.y;
        if (arrowSprite) {
          const arrowSize = Math.max(12, Math.round(this.slotSize * 0.5));
          this.resultArrowImg?.setTexture(arrowSprite).setPosition(arrowX, arrowY).setDisplaySize(arrowSize, arrowSize).setVisible(this._layerVisible);
          this.resultArrow?.setVisible(false);
        } else {
          this.resultArrowImg?.setVisible(false);
          this.resultArrow?.setPosition(arrowX, arrowY).setVisible(this._layerVisible);
        }
      }
    }
  }

  /** Fire an Inventory slot's click + double-click signals on the bound
   *  CHARACTER's bus (so its OnSignal logic hears them) and write the clicked
   *  item's name into `clickedItemVar`. Runs whether or not dragging is enabled. */
  private handleInventoryClick(slotIdx: number): void {
    if (slotIdx < 0) return;
    const scene = this.sprite.scene;
    if (!scene) return;
    const arr = this.slotArray();
    const slot = arr ? arr[slotIdx] : undefined;
    const itemId = slot && slot.qty > 0 ? slot.itemId : "";
    const inv = this.resolveTargetInventory();
    const fire = (sig: string) => { if (sig) { if (inv) inv.sprite.events.emit(sig); else this.emitSignal(sig); } };
    if (inv && this.clickedItemVar && itemId) inv.sprite.vars.set(this.clickedItemVar, itemId);
    fire(this.signalOnSlotClick);
    const now = scene.time.now;
    const isDouble = slotIdx === this._lastSlotClickIdx && (now - this._lastSlotClickMs) <= 400;
    this._lastSlotClickMs = isDouble ? -1 : now;
    this._lastSlotClickIdx = slotIdx;
    if (isDouble) fire(this.signalOnSlotDoubleClick);
  }

  /** Is the pointer within this widget's screen rect? UI widgets sit on a
   *  parallax-(0,0) layer, so pointer.x/y matches the gameObject's canvas
   *  position directly. */
  private pointerInside(p: Phaser.Input.Pointer): boolean {
    const obj = this.sprite.gameObject;
    const w = this.widgetW, h = this.widgetH;
    return p.x >= obj.x - w / 2 && p.x <= obj.x + w / 2 && p.y >= obj.y - h / 2 && p.y <= obj.y + h / 2;
  }

  /** Guard read by InputActions: should this widget swallow mouse input at the
   *  pointer's position? Only when opted in AND visible. */
  blocksPointerAt(p: Phaser.Input.Pointer): boolean {
    if (!this.blockGameInput) return false;
    // Use the widget's LAYER visibility — the host gameObject is invisible
    // (the visuals are separate bg/label objects), so its `visible` flag is
    // not a reliable "is this widget shown" signal.
    if (!this._layerVisible) return false;
    return this.pointerInside(p);
  }

  private installPointer(): void {
    const scene = this.sprite.scene;
    if (!scene) return;

    const hit = (p: Phaser.Input.Pointer): boolean => this.pointerInside(p);

    this.onPointerMove = (p) => {
      const inside = hit(p);
      // Hover edge events for Button
      if (this.widgetKind === "Button") {
        if (inside && !this.hovering) {
          this.hovering = true;
          if (this.signalOnHover) this.emitSignal(this.signalOnHover);
          if (this.hoverBgColor !== undefined) { this.currentBgColor = this.hoverBgColor; this.layout(); }
        } else if (!inside && this.hovering) {
          this.hovering = false;
          if (this.signalOnLeave) this.emitSignal(this.signalOnLeave);
          if (!this.pressed) { this.currentBgColor = this.bgColor; this.layout(); }
        }
      }
      // Slider drag (readOnly slider can't be dragging in the first
      // place since pointerdown bails — but guard regardless).
      if (this.widgetKind === "Slider" && this.dragging && !this.readOnly) {
        this.setValueFromPointer(p);
      }
      // Dropdown option hover highlight
      if (this.widgetKind === "Dropdown" && this.dropdownOpen && this.optionList) {
        const idx = this.findOptionAt(p);
        this.highlightDropdownRow(idx);
      }
      // Cross-widget drag — the OWNING renderer moves the shared ghost.
      const drag = this.getDrag();
      if (drag && drag.source.renderer === this) drag.ghost.setPosition(p.x, p.y);
    };

    this.onPointerDown = (p) => {
      // Dropdown: when the list is open, the per-option pointerdown
      // listeners can't fire reliably because this global listener
      // would close the list first (destroying the listeners). Handle
      // option-click selection HERE instead so the order is correct:
      //  1. Open list, user clicks an option → we resolve which option
      //     by hit-testing the per-row rectangles, fire signalOnSelect,
      //     update selectedValue, close.
      //  2. Open list, user clicks outside the list AND the header → close.
      //  3. Open list, user clicks the header → close (toggle).
      if (this.widgetKind === "Dropdown" && this.dropdownOpen) {
        const idx = this.findOptionAt(p);
        if (idx >= 0) {
          const opt = this.options[idx];
          this.selectedValue = opt.value;
          this.lastLabelText = ""; // force label refresh on next update
          // Per-option signal OVERRIDES the widget-level signalOnSelect
          // when set — otherwise fall back to the widget's. This avoids
          // double-firing when a user sets the same name in both
          // fields, and lets options mix: some with their own custom
          // signal, others using the widget's default.
          const signalToFire = opt.signal || this.signalOnSelect;
          if (signalToFire) this.emitSignal(signalToFire);
          this.closeDropdown();
          return;
        }
        // Header click while open → toggle close. Outside click → close.
        this.closeDropdown();
        return;
      }
      if (!hit(p)) return;
      if (this.widgetKind === "Button") {
        this.pressed = true;
        if (this.pressedBgColor !== undefined) { this.currentBgColor = this.pressedBgColor; this.layout(); }
      } else if (this.widgetKind === "Slider") {
        // readOnly slider: ignore the press. Value stays driven by
        // SetUIValue / var:bindings only.
        if (!this.readOnly) {
          this.dragging = true;
          this.setValueFromPointer(p);
        }
      } else if (this.widgetKind === "Dropdown") {
        this.openDropdown();
      } else if (this.widgetKind === "Inventory" || this.widgetKind === "CraftGrid") {
        this._pressX = p.x; this._pressY = p.y; this._pressMs = scene.time.now;
        // Clear any stale drag (owner destroyed without cleanup, etc.).
        const prev = this.getDrag();
        if (prev) { prev.ghost.destroy(); this.setDrag(undefined); }
        // CraftGrid result-slot take takes priority over input-slot pickup.
        if (this.widgetKind === "CraftGrid" && this.hitResult(p.x, p.y) && this._matchedRecipe) {
          const r = this._matchedRecipe;
          const key = this.resultIcon?.texture.key;
          this._dragFrom = -1;
          if (!key) return;
          const ghost = scene.add.image(p.x, p.y, key);
          ghost.setDisplaySize(this.slotSize - 6, this.slotSize - 6).setAlpha(0.85);
          this.sprite.routeOverlayToCamera(ghost);
          ghost.setDepth(this._layerDepth + 50);
          this.setDrag({ ghost, itemId: r.outputItem, qty: r.outputQty, maxStack: this.maxStackOf(r.outputItem),
            source: { renderer: this, kind: "result", recipe: r } });
          return;
        }
        const i = this.slotIndexAt(p.x, p.y);
        this._dragFrom = i; // record even on empty slots so a click can fire
        const arr = this.slotArray();
        const slot = i >= 0 && arr ? arr[i] : undefined;
        // Inventory honors the slotsDraggable toggle; CraftGrid always drags.
        const canDrag = this.widgetKind !== "Inventory" || this.slotsDraggable;
        if (canDrag && i >= 0 && arr && slot && slot.itemId && slot.qty > 0) {
          // Pick up — a translucent ghost icon follows the cursor (shared payload).
          const ghost = scene.add.image(p.x, p.y, this.slotIcons[i].texture.key);
          ghost.setDisplaySize(this.slotSize - 6, this.slotSize - 6).setAlpha(0.8);
          this.sprite.routeOverlayToCamera(ghost);
          ghost.setDepth(this._layerDepth + 50);
          this.setDrag({ ghost, itemId: slot.itemId, qty: slot.qty, maxStack: this.maxStackOf(slot.itemId),
            source: { renderer: this, kind: "slot", slots: arr, idx: i } });
        }
      } else if (this.widgetKind === "Crafting" || this.widgetKind === "Shop") {
        this._pressX = p.x; this._pressY = p.y; this._pressMs = scene.time.now;
        this._dragFrom = this.slotIndexAt(p.x, p.y);
      }
    };

    this.onPointerUp = (p) => {
      if (this.widgetKind === "Button") {
        const wasPressed = this.pressed;
        this.pressed = false;
        if (wasPressed && hit(p)) {
          // Decide whether THIS release counts as a "click". In double-click
          // mode only the SECOND release within ~400ms counts; the first arms
          // the timer. Both the signal AND the shop transaction gate on this,
          // so a double-click Buy button doesn't fire on a single click.
          let clicked = true;
          if (this.clickMode === "double") {
            const now = this.sprite.scene?.time.now ?? 0;
            const DOUBLE_CLICK_MS = 400;
            if (this._lastClickMs >= 0 && (now - this._lastClickMs) <= DOUBLE_CLICK_MS) {
              this._lastClickMs = -1; // reset so a 3rd click doesn't immediately re-fire
            } else {
              this._lastClickMs = now;
              clicked = false;
            }
          }
          if (clicked) {
            if (this.signalOnClick) this.emitSignal(this.signalOnClick);
            // Shop buy/sell — money + item counts move; the bag grid updates live.
            if (this.shopRole === "buy" || this.shopRole === "sell") this.runShopTransaction();
          }
        }
        // Restore appropriate bg (hover if still hovering, else base)
        this.currentBgColor = this.hovering && this.hoverBgColor !== undefined ? this.hoverBgColor : this.bgColor;
        this.layout();
      } else if (this.widgetKind === "Slider") {
        this.dragging = false;
      } else if (this.widgetKind === "Inventory" || this.widgetKind === "CraftGrid") {
        const drag = this.getDrag();
        const from = this._dragFrom;
        this._dragFrom = -1;
        // Not our drag: only fire the Inventory slot-click when nothing is dragging.
        // This is also the path when slotsDraggable is off (no payload was created).
        if (!drag || drag.source.renderer !== this) {
          if (!drag && this.widgetKind === "Inventory" && from >= 0) {
            const travel = Math.abs(p.x - this._pressX) + Math.abs(p.y - this._pressY);
            const dt = scene.time.now - this._pressMs;
            if (travel <= 5 && dt <= 250) this.handleInventoryClick(from);
          }
          return;
        }
        // We own the drag → resolve, then always clean up the ghost + payload.
        try {
          const target = this.findDropTarget(p.x, p.y);
          if (drag.source.kind === "slot") {
            const sameSlot = !!target && target.renderer === drag.source.renderer && target.idx === drag.source.idx;
            if (target && !sameSlot) {
              // Dropping INTO a CraftGrid input slot places ONE unit (ingredient);
              // any other transfer moves the whole stack (inventory rearrange).
              const amount = target.renderer.widgetKind === "CraftGrid" ? 1 : Infinity;
              transferSlot(drag.source.slots, drag.source.idx, target.slots, target.idx, drag.maxStack, amount);
              // Persist both bags NOW — the drag bypasses addItem and may happen
              // on a paused screen, so don't wait for the next tick.
              drag.source.renderer.commitInventoryChange();
              target.renderer.commitInventoryChange();
            } else {
              // Same slot or dropped outside: tiny travel ⇒ Inventory slot-click.
              const travel = Math.abs(p.x - this._pressX) + Math.abs(p.y - this._pressY);
              const dt = scene.time.now - this._pressMs;
              if (this.widgetKind === "Inventory" && travel <= 5 && dt <= 250) this.handleInventoryClick(drag.source.idx);
            }
          } else {
            // Result take — deposit FIRST (cancel if no room), only THEN consume inputs.
            if (target) {
              const dst = target.slots[target.idx];
              let deposited = false;
              if (dst.itemId === "" || dst.qty <= 0) { dst.itemId = drag.itemId; dst.qty = drag.qty; deposited = true; }
              else if (dst.itemId === drag.itemId) { dst.qty = Math.min(drag.maxStack, dst.qty + drag.qty); deposited = true; }
              else {
                const empty = target.slots.find((s) => s.itemId === "" || s.qty <= 0);
                if (empty) { empty.itemId = drag.itemId; empty.qty = drag.qty; deposited = true; }
              }
              if (deposited) {
                for (const inp of drag.source.recipe.inputs) removeFromSlots(this.craftSlots, inp.item, inp.qty);
                if (this.signalOnCraft) this.emitSignal(this.signalOnCraft);
                target.renderer.commitInventoryChange();
              }
            }
            // Dropped outside / no room → cancel (inputs untouched).
          }
        } finally {
          drag.ghost.destroy();
          this.setDrag(undefined);
        }
      } else if (this.widgetKind === "Crafting") {
        const i = this._dragFrom;
        this._dragFrom = -1;
        if (i < 0) return;
        const travel = Math.abs(p.x - this._pressX) + Math.abs(p.y - this._pressY);
        const dt = scene.time.now - this._pressMs;
        if (travel > 5 || dt > 250) return; // not a click
        const recipe = this._craftRecipes[i];
        if (!recipe) return;
        if (this.signalOnCraftClick) this.emitSignal(this.signalOnCraftClick);
        const inv = this.resolveTargetInventory();
        if (inv) {
          const meta = scene.data.get("peaky.itemMeta") as Record<string, { maxStack: number }> | undefined;
          inv.craft(recipe, (it) => meta?.[it]?.maxStack ?? 99);
        }
      } else if (this.widgetKind === "Shop") {
        const i = this._dragFrom;
        this._dragFrom = -1;
        if (i < 0) return;
        const travel = Math.abs(p.x - this._pressX) + Math.abs(p.y - this._pressY);
        const dt = scene.time.now - this._pressMs;
        if (travel > 5 || dt > 250) return; // not a click
        // Click SELECTS the slot (the Buy button confirms). Only selectable if
        // the slot actually sells something.
        if (this.shopSlots[i]?.item) this.selectedSlot = i;
      }
    };

    scene.input.on("pointermove", this.onPointerMove);
    scene.input.on("pointerdown", this.onPointerDown);
    scene.input.on("pointerup", this.onPointerUp);
  }

  private setValueFromPointer(p: Phaser.Input.Pointer): void {
    const obj = this.sprite.gameObject;
    const W = this.widgetW;
    const H = this.widgetH;
    let t: number;
    if (this.direction === "vertical") {
      const bottom = obj.y + H / 2;
      t = Math.max(0, Math.min(1, (bottom - p.y) / H));
    } else {
      const left = obj.x - W / 2;
      t = Math.max(0, Math.min(1, (p.x - left) / W));
    }
    const next = this.min + t * (this.max - this.min);
    const prev = typeof this.value === "number" ? this.value : 0;
    if (next !== prev) {
      this.value = next;
      if (this.signalOnChange) this.emitSignal(this.signalOnChange);
    }
  }

  /** Highlight the option at the given row idx (-1 = none). Re-applies
   *  the bg fill on each option's Rectangle child of the option list. */
  private highlightDropdownRow(activeIdx: number): void {
    if (!this.optionList) return;
    // Children alternate: [bg, label, bg, label, ...]. Recolor each bg.
    const list = this.optionList.getAll();
    const hover = this.hoverBgColor ?? 0x4aa8ff;
    for (let i = 0; i < this.options.length; i++) {
      const bg = list[i * 2];
      if (!bg || !("setFillStyle" in bg)) continue;
      const target = i === activeIdx ? hover : this.bgColor;
      (bg as Phaser.GameObjects.Rectangle).setFillStyle(target, this.bgAlpha || 1);
    }
  }

  /** Hit-test pointer against open dropdown options. Returns the
   *  matched option's index or -1 if outside / closed. */
  private findOptionAt(p: Phaser.Input.Pointer): number {
    if (!this.dropdownOpen || this.options.length === 0) return -1;
    const obj = this.sprite.gameObject;
    const W = this.widgetW;
    const H = this.widgetH;
    const itemH = Math.max(20, Math.round(this.fontSize * 1.6));
    const left = obj.x - W / 2;
    const right = obj.x + W / 2;
    const top = obj.y + H / 2;
    if (p.x < left || p.x > right || p.y < top) return -1;
    const idx = Math.floor((p.y - top) / itemH);
    if (idx < 0 || idx >= this.options.length) return -1;
    return idx;
  }

  private openDropdown(): void {
    const scene = this.sprite.scene;
    if (!scene || this.options.length === 0) return;
    const obj = this.sprite.gameObject;
    const itemH = Math.max(20, Math.round(this.fontSize * 1.6));
    const W = this.widgetW;
    const H = this.widgetH;
    const startY = obj.y + H / 2;
    // Container for the open options. Pointer click selection is
    // handled by the global onPointerDown via findOptionAt(); per-row
    // setInteractive listeners conflicted with the global handler's
    // close-on-click logic and lost the selection.
    const list = scene.add.container(0, 0);
    list.setScrollFactor(this._layerScrollX, this._layerScrollY);
    list.setDepth(this._layerDepth + 100);
    list.setAlpha(this._layerAlpha * this._opacity);
    list.setVisible(this._layerVisible);
    // Dropdown's option container is a UI element — route to UI cam.
    this.sprite.routeOverlayToCamera(list);

    this.options.forEach((opt, idx) => {
      const itemY = startY + idx * itemH + itemH / 2;
      const itemBg = scene.add.rectangle(obj.x, itemY, W, itemH, this.bgColor, this.bgAlpha || 1);
      itemBg.setStrokeStyle(1, this.borderColor || 0x404552, 1);
      this.sprite.routeOverlayToCamera(itemBg);
      const itemLabel = scene.add.text(
        this.align === "left" ? obj.x - W / 2 + this.padding : obj.x,
        itemY,
        this.interpolate(opt.label),
        this.buildTextStyle(),
      );
      setupCrispText(itemLabel);
      itemLabel.setOrigin(this.align === "left" ? 0 : 0.5, 0.5);
      this.sprite.routeOverlayToCamera(itemLabel);
      list.add(itemBg);
      list.add(itemLabel);
    });
    this.optionList = list;
    this.dropdownOpen = true;
  }

  private closeDropdown(): void {
    this.optionList?.destroy();
    this.optionList = undefined;
    this.dropdownOpen = false;
  }
}

function cssColor(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}
