import { Behavior } from "../Behavior";
import type { Sprite } from "../Sprite";

/**
 * Widget — attach a UI widget to a BP. The widget renders in WORLD space
 * (not screen-anchored HUD) following the host BP's position, with an
 * optional offset. Used for per-instance healthbars / name labels / boss
 * intent markers — each NPC gets its own widget that reads its own state.
 *
 * Lifecycle:
 *   - `init()` spawns the widget via the scene's `peaky.spawnUIWidget`
 *     callback (set up by runProject). The widget sprite is parented to
 *     the host's layer so parallax / depth stays consistent.
 *   - `update()` syncs the widget's position (host + offsets) and mirrors
 *     the host's variables into the widget's vars Map so any `var:self.X`
 *     binding on the widget resolves to the host's value. Lets a generic
 *     "HealthBar" widget read this NPC's hp without per-instance wiring.
 *   - `onDestroy()` destroys the widget sprite so it doesn't outlive
 *     its host.
 *
 * Public params:
 *   - widgetId   (string)  — id of the UIWidgetDef to render
 *   - offsetX    (number)  — px offset from host center (X axis)
 *   - offsetY    (number)  — px offset (Y axis; negative = above head)
 *   - hideWhenDead (0|1)   — auto-hide the widget when host is dead
 */
export class Widget extends Behavior {
  kind = "Widget";

  widgetId = "";
  offsetX = 0;
  offsetY = -40;
  hideWhenDead = 1;
  /** Name of the host BP variable that drives the widget's primary
   *  display value. Each tick the runtime reads `host.vars[linkedVar]`
   *  and writes it into the widget's `value` (ProgressBar / Slider) or
   *  `text` (Label / Button) field based on the widget's kind. Empty =
   *  no linking; the widget's authored static value shows. */
  linkedVar = "";
  /** Additive animation buffers written by the Animator component each
   *  tick. The Widget's update() ADDS these to its authored offsets /
   *  scales / etc. so an Animator targeting `Widget` shifts / scales /
   *  fades the bar without trashing the authored values. Identity
   *  values (0/0/1/1/0) = no animator contribution. */
  animOffsetX = 0;
  animOffsetY = 0;
  animScale = 1;
  /** -1 = no Animator contribution. 0..1 = override. Matches Text /
   *  SpriteRenderer convention so an Animator targeting `Widget` can
   *  fade-in a bar that was authored alpha=0 on spawn. */
  animOpacity = -1;
  animRotation = 0;

  /** Reference to the spawned widget sprite — used for per-tick position
   *  sync and cleanup. Null when spawn failed (missing widget id /
   *  callback not registered) or before init. */
  private _widgetSprite: Sprite | null = null;
  /** Cached widget kind from the spawned sprite — drives the per-tick
   *  link write (Label/Button → text, Slider/ProgressBar → value).
   *  Read once in init() so the hot path avoids repeated lookups. */
  private _widgetKind: string = "";
  /** Cached Damageable reference from the host. Looked up once in init()
   *  so the per-tick `hideWhenDead` check skips a behavior-list scan
   *  every frame. `null` = host has no Damageable; we'll never hide. */
  private _hostDamageable: { isDead?: boolean } | null = null;

  init(): void {
    if (!this.widgetId) return;
    const spawnFn = this.sprite.scene.data.get("peaky.spawnAttachedWidget") as
      | ((arg: { id: string; x: number; y: number; layer?: string; hostLayerId?: string }) => Sprite | null)
      | undefined;
    if (typeof spawnFn !== "function") {
      console.warn(`[Widget] uid=${this.sprite.uid} cannot spawn — peaky.spawnAttachedWidget callback not registered.`);
      return;
    }
    // Forward the host's layer so the attached widget rides the SAME
    // camera/parallax/depth as its parent — otherwise it falls back to
    // the scene's default UI layer (parallax 0,0) which renders on the
    // UI camera and stays bolted to the screen corner instead of
    // following the NPC across the world.
    this._widgetSprite = spawnFn({
      id: this.widgetId,
      x: this.sprite.gameObject.x + this.offsetX,
      y: this.sprite.gameObject.y + this.offsetY,
      hostLayerId: this.sprite.layerId,
    });
    if (!this._widgetSprite) {
      console.warn(`[Widget] uid=${this.sprite.uid} spawnAttachedWidget returned null for widgetId="${this.widgetId}".`);
      return;
    }
    // Cache the widget's kind from its UIWidgetRenderer config so the
    // per-tick link write knows whether to target `value` or `text`.
    const renderer = this._widgetSprite.findBehaviorByKind("UIWidgetRenderer");
    this._widgetKind = renderer?.widgetKind ?? "";
    // Attached Inventory widget with no explicit target → mirror the HOST's
    // own Inventory, so a per-NPC inventory bar "just works".
    if (this._widgetKind === "Inventory" && renderer && !renderer.targetBp.trim()) {
      const hostInv = this.sprite.findBehaviorByKind("Inventory");
      if (hostInv) renderer.setTargetInventory(hostInv);
    }
    // Cache the host's Damageable so the per-tick hide-when-dead check
    // doesn't scan the behavior list every frame.
    this._hostDamageable = (this.sprite.findBehaviorByKind("Damageable") as { isDead?: boolean } | undefined) ?? null;
  }

  update(_delta: number): void {
    const ws = this._widgetSprite;
    if (!ws || ws.destroyed) return;
    // Position sync — host + offsets + animator buffer. Offsets follow
    // host scale so a 2x scaled BP keeps its "40 px above head" feel
    // proportionally. animOffsetX/Y add on top so an Animator targeting
    // `Widget` can punch the bar up on hit, etc.
    //
    // NOTE: position sync moves the widget sprite's BODY rect, which is
    // hidden (alpha 0). UIWidgetRenderer's overlay GameObjects (bg rect,
    // text, fill bar) are tracked separately. Writing scale/alpha/rotation
    // to the body would just unhide the (black) body rect — those props
    // need to land on the overlays via UIWidgetRenderer's buffer fields.
    // For now Widget supports POSITION animation only; scale/opacity/rotation
    // routed through UIWidgetRenderer is a follow-up (will need each overlay
    // type — bg / text / fill — to honor the buffers in its draw pass).
    const obj = this.sprite.gameObject;
    const newX = obj.x + (this.offsetX + this.animOffsetX) * (obj.scaleX || 1);
    const newY = obj.y + (this.offsetY + this.animOffsetY) * (obj.scaleY || 1);
    ws.gameObject.x = newX;
    ws.gameObject.y = newY;

    // Link Value Var — push the host's `linkedVar` value into the
    // widget's primary display field each tick. Target field auto-
    // detects from widget kind:
    //   • Slider / ProgressBar → `value` (numeric)
    //   • Label / Button       → `text`  (stringified)
    //   • other kinds          → no-op
    // Author drops the picker on the Widget component, picks `hp` →
    // every NPC's bar reflects that NPC's hp without authoring bindings.
    if (this.linkedVar) {
      const raw = this.sprite.vars.get(this.linkedVar);
      if (raw !== undefined) {
        const renderer = ws.findBehaviorByKind("UIWidgetRenderer") as
          | { value?: number; text?: string }
          | undefined;
        if (renderer) {
          if (this._widgetKind === "Slider" || this._widgetKind === "ProgressBar") {
            const n = typeof raw === "number" ? raw : Number(raw);
            if (Number.isFinite(n)) renderer.value = n;
          } else if (this._widgetKind === "Label" || this._widgetKind === "Button") {
            renderer.text = raw === null ? "" : String(raw);
          }
        }
      }
    }

    // Optional hide-on-death — read host's cached Damageable.isDead.
    // Routes through UIWidgetRenderer.applyLayer so EVERY overlay
    // (shadow/bg/fill/border/image/label/chevron) is hidden, not just
    // the (already-invisible) body rect. Setting visibility on the body
    // only would let the overlays keep rendering — the previous fix was
    // silently a no-op, causing the widget to keep flashing through any
    // running Wait→SetUIVisible chain even after the host died.
    if (this.hideWhenDead && this._hostDamageable?.isDead) {
      const renderer = ws.findBehaviorByKind("UIWidgetRenderer") as
        | { applyLayer?: (sx: number, sy: number, depth: number, alpha: number, visible: boolean) => void }
        | undefined;
      if (renderer?.applyLayer) {
        const wsObj = ws.gameObject;
        renderer.applyLayer(wsObj.scrollFactorX, wsObj.scrollFactorY, wsObj.depth, 1, false);
      }
      ws.gameObject.setVisible(false);
    }
  }

  onDestroy(): void {
    if (this._widgetSprite && !this._widgetSprite.destroyed) {
      this._widgetSprite.destroy();
    }
    this._widgetSprite = null;
  }
}
