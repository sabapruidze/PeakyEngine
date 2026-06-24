import { Behavior } from "../Behavior";
import { persistentState } from "../PersistentState";

/**
 * Inventory behavior — holds a character's item slots. Items are referenced
 * by NAME (the Item asset's name); `maxStack` is supplied by the caller (the
 * action handler resolves it from the project's item catalog) so the behavior
 * stays decoupled from project assets, exactly like Damageable doesn't know
 * about sprite assets.
 *
 * Emits on the host's EventBus so Logic Sheets / other behaviors can react:
 *   - OnItemAdded   { item, qty, added }
 *   - OnItemRemoved { item, qty, removed }
 *   - OnInventoryFull { item }  (an AddItem couldn't fully fit)
 *
 * The Inventory UI widget reads `slots` directly each tick to draw the grid.
 */
export interface InventorySlot {
  itemId: string; // item NAME ("" = empty slot)
  qty: number;
}

/** Recipe shape the runtime reads from `peaky.recipes` (built by runProject from
 *  the project's Recipe assets). Items are referenced by NAME. */
export interface RecipeRuntime {
  name: string;
  inputs: { item: string; qty: number }[];
  outputItem: string;
  outputQty: number;
  /** When false, canCraft / craft refuse this recipe. SetRecipeEnabled
   *  action flips this at runtime; the project file holds the default. */
  enabled?: boolean;
}

export class Inventory extends Behavior {
  kind = "Inventory";

  /** Keep ticking while the game is paused — inventory/transfer UIs usually run
   *  on a paused screen, so the per-tick snapshot must still fire there (else a
   *  bag edited in a pause menu wouldn't be saved before a scene change). */
  tickDuringPause = true;

  /** Total slot count. Slots are normalized to this length on init. */
  capacity = 20;
  /** Fixed-length slot array (length === capacity). Empty slot = { itemId:"", qty:0 }. */
  slots: InventorySlot[] = [];

  /** Cross-scene identity. Set (e.g. "player") → this bag persists between scenes
   *  and drives the HUD count globals. Empty → scene-local; the bag resets to the
   *  BP config each scene and never touches the shared globals (so chests / NPCs
   *  / shops don't cross-contaminate each other or the player). */
  persistKey = "";

  /** Set once the slots have been reconciled with the persistent item globals
   *  (deferred to the first tick because the item catalog isn't on scene.data
   *  yet when behaviors attach during spawn). */
  private _synced = false;

  init(): void {
    this.normalize();
  }

  /** Item catalog (name → { countGlobal, maxStack }) injected by runProject. */
  private itemCatalog(): Record<string, { countGlobal?: string; maxStack?: number }> {
    return (this.sprite.scene?.data?.get("peaky.itemMeta") as Record<string, { countGlobal?: string; maxStack?: number }>) ?? {};
  }

  /** Mirror an item's current total into its persistent count global so the HUD
   *  (`global:<item>`) + shop see it. ONLY tracked inventories (with a persistKey)
   *  write globals — scene-local chests/NPCs never pollute the shared namespace. */
  private mirrorOut(name: string): void {
    if (!this.persistKey) return;
    const g = this.itemCatalog()[name]?.countGlobal;
    if (g) persistentState().globals[g] = this.countItem(name);
    // mirrorOut is called by every bag mutation (add / remove / set), so this is
    // the one choke point that keeps the cross-scene snapshot in sync.
    this.saveSnapshot();
  }

  /** Re-sync HUD globals + the cross-scene snapshot after a DIRECT slot mutation
   *  (a UI drag/transfer between inventories that bypasses addItem). Safe to call
   *  any time; no-ops for scene-local (no persistKey) bags. */
  notifyChanged(): void {
    const seen = new Set<string>();
    for (const s of this.slots) if (s.itemId && !seen.has(s.itemId)) { seen.add(s.itemId); this.mirrorOut(s.itemId); }
    this.saveSnapshot();
  }

  /** Snapshot the WHOLE bag into persistent state under this inventory's key, so
   *  it survives scene changes exactly (items + amounts + positions). No-op for
   *  scene-local inventories (empty persistKey). */
  private saveSnapshot(): void {
    if (!this.persistKey) return;
    // The whole bag persists — items carry across scenes regardless of their
    // "Track how many the player owns" toggle (that toggle only controls the HUD
    // count global). For CURRENCY that shouldn't sit in the bag (e.g. gold), use
    // a money global + SetGlobal on pickup instead of adding it as an item.
    persistentState().inventories[this.persistKey] = this.slots.map((s) => ({ itemId: s.itemId, qty: s.qty }));
  }

  update(): void {
    // Wait until the item catalog is on scene.data (first tick after spawn).
    if (!this.sprite.scene?.data?.get("peaky.itemMeta")) return;
    // Everything below is one-time per instance; after sync we do nothing per
    // tick. (The old per-tick saveSnapshot was O(slots) PER INSTANCE every frame
    // — at 500 NPCs × a 2000-slot bag that's millions of copies a frame. Saves
    // now happen on mutation via mirrorOut, which is enough.)
    if (this._synced) return;
    this._synced = true;
    if (!this.persistKey) return;
    // SHARED LIVE BAG: every instance with the SAME persistKey points its `slots`
    // at ONE array in scene.data — so all NPCs add to the same bag and one widget
    // shows the union. (A blank persistKey stays per-instance + scene-local.) The
    // shared array is seeded ONCE per scene from the cross-scene snapshot; on a
    // scene change it's gone but the snapshot persists, so the next scene reseeds.
    let shared = this.sprite.scene.data.get("peaky.sharedBags") as Map<string, InventorySlot[]> | undefined;
    if (!shared) { shared = new Map(); this.sprite.scene.data.set("peaky.sharedBags", shared); }
    let arr = shared.get(this.persistKey);
    if (!arr) {
      const snap = persistentState().inventories[this.persistKey];
      arr = snap ? snap.map((s) => ({ itemId: String(s.itemId ?? ""), qty: Math.max(0, Math.floor(Number(s.qty) || 0)) })) : [];
      shared.set(this.persistKey, arr);
    }
    this.slots = arr; // share the reference — all instances mutate ONE bag
    this.normalize();
    const seen = new Set<string>();
    for (const s of this.slots) if (s.itemId && !seen.has(s.itemId)) { seen.add(s.itemId); this.mirrorOut(s.itemId); }
    this.saveSnapshot();
  }

  /** Pad / trim `slots` to capacity and fix invalid entries — MUTATES IN PLACE
   *  so a shared (persistKey) bag keeps its single array reference across every
   *  instance that points at it. */
  private normalize(): void {
    const cap = Math.max(1, Math.floor(this.capacity));
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s || typeof s.itemId !== "string" || typeof s.qty !== "number") this.slots[i] = { itemId: "", qty: 0 };
    }
    while (this.slots.length < cap) this.slots.push({ itemId: "", qty: 0 });
    if (this.slots.length > cap) this.slots.length = cap;
  }

  /** Add `qty` of `name`, stacking into existing matching slots first (up to
   *  maxStack) then into empty slots. Returns the overflow that didn't fit. */
  addItem(name: string, qty: number, maxStack: number): number {
    if (!name || qty <= 0) return qty;
    const cap = Math.max(1, Math.floor(maxStack));
    let remaining = Math.floor(qty);
    // Top up existing stacks.
    for (const s of this.slots) {
      if (remaining <= 0) break;
      if (s.itemId === name && s.qty < cap) {
        const room = cap - s.qty;
        const put = Math.min(room, remaining);
        s.qty += put;
        remaining -= put;
      }
    }
    // Fill empty slots.
    for (const s of this.slots) {
      if (remaining <= 0) break;
      if (s.itemId === "" || s.qty <= 0) {
        const put = Math.min(cap, remaining);
        s.itemId = name;
        s.qty = put;
        remaining -= put;
      }
    }
    const added = Math.floor(qty) - remaining;
    if (added > 0) this.sprite.events.emit("OnItemAdded", { item: name, qty: added, added });
    if (remaining > 0) this.sprite.events.emit("OnInventoryFull", { item: name });
    this.mirrorOut(name);
    return remaining;
  }

  /** Remove up to `qty` of `name` across slots. Returns the amount removed. */
  removeItem(name: string, qty: number): number {
    if (!name || qty <= 0) return 0;
    let remaining = Math.floor(qty);
    for (const s of this.slots) {
      if (remaining <= 0) break;
      if (s.itemId === name) {
        const take = Math.min(s.qty, remaining);
        s.qty -= take;
        remaining -= take;
        if (s.qty <= 0) { s.itemId = ""; s.qty = 0; }
      }
    }
    const removed = Math.floor(qty) - remaining;
    if (removed > 0) this.sprite.events.emit("OnItemRemoved", { item: name, qty: removed, removed });
    this.mirrorOut(name);
    return removed;
  }

  countItem(name: string): number {
    let n = 0;
    for (const s of this.slots) if (s.itemId === name) n += s.qty;
    return n;
  }

  /** True when every slot is occupied (no empty slot left). */
  isFull(): boolean {
    return this.slots.every((s) => s.itemId !== "" && s.qty > 0);
  }

  /** Move/swap/merge the contents of slot `from` into slot `to`. Same item =>
   *  merge up to maxStack (overflow stays in `from`); otherwise swap. */
  moveSlot(from: number, to: number, maxStack: number): void {
    if (from === to) return;
    const a = this.slots[from];
    const b = this.slots[to];
    if (!a || !b || a.itemId === "" || a.qty <= 0) return;
    if (b.itemId === a.itemId && b.itemId !== "") {
      const cap = Math.max(1, Math.floor(maxStack));
      const room = cap - b.qty;
      const move = Math.min(room, a.qty);
      b.qty += move;
      a.qty -= move;
      if (a.qty <= 0) { a.itemId = ""; a.qty = 0; }
    } else {
      this.slots[from] = b;
      this.slots[to] = a;
    }
    this.notifyChanged();
  }

  clear(): void {
    const names = new Set(this.slots.map((s) => s.itemId).filter(Boolean));
    for (const s of this.slots) { s.itemId = ""; s.qty = 0; }
    for (const n of names) this.mirrorOut(n);
  }

  /** True when every input of `recipe` is present in the required quantity
   *  AND the recipe is enabled. A disabled recipe always returns false so
   *  UIs (craft buttons, recipe lists) gray it out consistently. */
  canCraft(recipe: RecipeRuntime): boolean {
    if (!recipe || recipe.inputs.length === 0) return false;
    if (recipe.enabled === false) return false;
    return recipe.inputs.every((inp) => this.countItem(inp.item) >= inp.qty);
  }

  /** All-or-nothing: verify the recipe is enabled, every input is present
   *  BEFORE consuming anything, then remove inputs and add the output.
   *  `maxStackOf` resolves an item's stack cap (from the project catalog).
   *  Returns true on success. Emits OnCrafted on success / OnCraftFailed
   *  on missing inputs / OnCraftDisabled when the recipe is gated off. */
  craft(recipe: RecipeRuntime, maxStackOf: (item: string) => number): boolean {
    if (!recipe) return false;
    if (recipe.enabled === false) {
      this.sprite.events.emit("OnCraftDisabled", { recipe: recipe.name });
      return false;
    }
    const missing = recipe.inputs.find((inp) => this.countItem(inp.item) < inp.qty);
    if (recipe.inputs.length === 0 || missing) {
      this.sprite.events.emit("OnCraftFailed", { recipe: recipe.name, missing: missing?.item ?? "" });
      return false;
    }
    for (const inp of recipe.inputs) this.removeItem(inp.item, inp.qty);
    this.addItem(recipe.outputItem, recipe.outputQty, maxStackOf(recipe.outputItem));
    this.sprite.events.emit("OnCrafted", { recipe: recipe.name, output: recipe.outputItem, qty: recipe.outputQty });
    return true;
  }

  serialize(): Record<string, unknown> {
    return { slots: this.slots, capacity: this.capacity };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.capacity === "number") this.capacity = state.capacity;
    if (Array.isArray(state.slots)) this.slots = state.slots as InventorySlot[];
    this.normalize();
    // The loaded slots ARE the authoritative bag (LoadSlot already restored the
    // matching count globals first). Mark synced so the first post-load tick
    // doesn't re-run syncWithGlobals — which, if the save's slots and globals
    // disagreed (older save / edited countGlobal), would silently overwrite the
    // freshly-loaded bag. Mirror the loaded totals back out so `global:<item>`
    // and the HUD agree immediately even if the save lacked those globals.
    this._synced = true;
    for (const name of new Set(this.slots.map((s) => s.itemId).filter(Boolean))) {
      this.mirrorOut(name);
    }
  }
}
