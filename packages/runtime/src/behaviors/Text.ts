import Phaser from "phaser";
import { Behavior } from "../Behavior";
import { setupCrispText } from "../textRendering";

/**
 * Renders the host Sprite as a Phaser text object. The behavior owns a
 * `Phaser.GameObjects.Text` overlay that follows the body each frame and
 * re-renders when any of the styling or content props change.
 *
 * The underlying physics rectangle is hidden (alpha 0) while text is
 * visible — collision still works against the rect's bounds.
 *
 * Variable interpolation: `{varName}` tokens in `content` are replaced
 * each frame with `sprite.vars.get(varName)`. Lets the user "link" a
 * blueprint variable (e.g. `hp`, `score`) to live on-screen text without
 * an explicit SetText action.
 *
 * Public params:
 *   - content       (string)  — text. Supports `{var}` tokens.
 *   - fontFamily    (string)
 *   - fontSize      (number)
 *   - color         (number)  — 0xRRGGBB
 *   - bold          (0|1)
 *   - italic        (0|1)
 *   - align         ("left"|"center"|"right")
 *   - vAlign        ("top"|"middle"|"bottom")
 *   - wrapWidth     (number, 0 = no wrap)
 *   - visible       (0|1)
 *   - alpha         (0..1)
 */

type Align = "left" | "center" | "right";
type VAlign = "top" | "middle" | "bottom";

const VAR_TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function colorToCss(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

export class Text extends Behavior {
  kind = "Text";
  /** Identifier shown in the Components panel and used by future
   *  per-name action targeting (`SetText name="HUD" text="…"`). Auto-set
   *  by the editor on attach so multiple Text components on the same BP
   *  stay distinguishable (Text, Text2, Text3, …). */
  name = "";
  content = "";
  fontFamily = "Arial";
  fontSize = 16;
  color = 0xffffff;
  bold = 0;
  italic = 0;
  align: Align = "left";
  vAlign: VAlign = "top";
  wrapWidth = 0;
  visible = 1;
  alpha = 1;
  /** Per-axis pixel offset added on top of the alignment-based anchor. */
  offsetX = 0;
  offsetY = 0;
  /** Per-instance placement scale, injected by runProject. A scene resize
   *  changes the BODY's width/height (not the gameObject's `scaleX`), so the
   *  overlay can't read the resize off `obj.scaleX` — it would always be 1.
   *  These carry the placement scale so the label grows and its offset scales
   *  with a resized instance. Composed with `obj.scaleX` (runtime SetScale)
   *  and `animScale` (Animator) below. */
  _instScaleX = 1;
  _instScaleY = 1;
  /** Additive buffers written by the Animator component each tick.
   *  Combined with the Text's authored offset / alpha / etc. in
   *  syncOverlay so an Animator targeting `Text` can punch / fade / rotate
   *  the label without trashing authored values. */
  animOffsetX = 0;
  animOffsetY = 0;
  animScale = 1;
  /** -1 = no Animator contribution (use authored `alpha`). 0..1 =
   *  override base alpha entirely (so a base alpha=0 doesn't trap the
   *  animator at 0). See IDENTITY comment in Animator.ts. */
  animOpacity = -1;
  animRotation = 0;

  private overlay?: Phaser.GameObjects.Text;
  /** Cached signature of the last applied style — re-applied only on change. */
  private lastStyleSig = "";
  /** Cached last rendered string — only re-set when the resolved string changes. */
  private lastRendered = "";

  serialize(): Record<string, unknown> {
    return {
      content: this.content,
      visible: this.visible,
      alpha: this.alpha,
    };
  }

  deserialize(state: Record<string, unknown>): void {
    if (typeof state.content === "string") this.content = state.content;
    if (typeof state.visible === "number") this.visible = state.visible;
    if (typeof state.alpha === "number") this.alpha = state.alpha;
  }

  init(): void {
    const scene = this.sprite.scene;
    this.overlay = scene.add.text(this.sprite.gameObject.x, this.sprite.gameObject.y, "", {});
    setupCrispText(this.overlay);
    this.overlay.setOrigin(0.5, 0.5);
    // Route to main / UI camera based on host sprite kind. Without this
    // a Text overlay attached to a non-UI BP would draw on the UI cam
    // too (and vice versa), and BlurScene wouldn't blur it correctly.
    this.sprite.routeOverlayToCamera(this.overlay);
    // Sit 2 above the body rect — above SpriteRenderer's overlay (which
    // uses +1) so HP labels render in front of the character. Layers add
    // their base depth on top via applyLayer().
    this.overlay.setDepth(this.sprite.gameObject.depth + 2);
    // Inherit the host's scroll factor so the overlay defaults to the
    // layer's parallax instead of (1, 1).
    this.overlay.setScrollFactor(
      this.sprite.gameObject.scrollFactorX,
      this.sprite.gameObject.scrollFactorY,
    );
    this.applyStyle();
    this.applyContent();
    this.syncOverlay();
  }

  update(_delta: number): void {
    this.applyStyle();
    this.applyContent();
    this.syncOverlay();
  }

  /** Replace `{name}` tokens with the host sprite's matching variable. */
  private resolve(): string {
    const raw = String(this.content ?? "");
    if (!raw.includes("{")) return raw;
    return raw.replace(VAR_TOKEN, (_full, name: string) => {
      const v = this.sprite.vars.get(name);
      return v === undefined || v === null ? "" : String(v);
    });
  }

  private applyContent(): void {
    if (!this.overlay) return;
    const next = this.resolve();
    if (next !== this.lastRendered) {
      this.overlay.setText(next);
      this.lastRendered = next;
    }
  }

  private applyStyle(): void {
    if (!this.overlay) return;
    const sig = [
      this.fontFamily, this.fontSize, this.color,
      this.bold, this.italic, this.align, this.wrapWidth,
    ].join("|");
    if (sig === this.lastStyleSig) return;
    this.lastStyleSig = sig;

    const styleParts: string[] = [];
    if (this.italic) styleParts.push("italic");
    if (this.bold) styleParts.push("bold");
    const fontStyle = styleParts.join(" ");

    this.overlay.setStyle({
      fontFamily: this.fontFamily || "Arial",
      fontSize: `${Math.max(1, this.fontSize | 0)}px`,
      color: colorToCss(this.color),
      align: this.align,
      ...(fontStyle ? { fontStyle } : {}),
    });
    if (this.wrapWidth > 0) {
      this.overlay.setWordWrapWidth(this.wrapWidth, true);
    } else {
      this.overlay.setWordWrapWidth(null);
    }
  }

  /** Sync the text overlay to the host's transform. Called every tick
   *  AND on-demand by transform actions so the change shows up on the
   *  same frame as the body's move/scale/rotation. */
  syncOverlay(): void {
    if (!this.overlay) return;
    const obj = this.sprite.gameObject;

    // Always hide the underlying physics rect — Text replaces the BP's
    // default visual entirely. Collision still uses the body bounds.
    obj.setAlpha(0);

    const show = !!this.visible;
    this.overlay.setVisible(show);
    if (!show) return;

    // Animator component contribution — animOpacity multiplies onto the
    // authored alpha. Identity (1) when no Animator is driving Text.
    // Animator opacity uses -1 sentinel for "no contribution" — when
    // present, use the authored `alpha`; otherwise the animator's value
    // OVERRIDES base so a base alpha of 0 (spawn-invisible) doesn't trap
    // the animator at 0.
    const effectiveAlpha = this.animOpacity < 0 ? this.alpha : this.animOpacity;
    this.overlay.setAlpha(Math.max(0, Math.min(1, effectiveAlpha)) * this._layerAlpha);

    // Alignment sets the text's PIVOT (origin) — left/right/center on X,
    // top/middle/bottom on Y — so the text grows in the chosen direction
    // away from the anchor. The anchor itself stays fixed at body center
    // plus the gizmo offset, regardless of alignment.
    let originX = 0.5;
    if (this.align === "left") originX = 0;
    else if (this.align === "right") originX = 1;
    let originY = 0.5;
    if (this.vAlign === "top") originY = 0;
    else if (this.vAlign === "bottom") originY = 1;
    this.overlay.setOrigin(originX, originY);
    // Pin the label to the body as if it were a grouped child (full TRS).
    // `sx/sy` = placement scale (scene resize) × runtime SetScale. The glyphs
    // scale by it (resize WITH the object) and the offset scales by it too, so
    // the label keeps its relative spot as the body grows/shrinks. The offset
    // is then rotated into the body's frame so it orbits with the body's angle.
    // Anchor is the body CENTER (obj.x/obj.y) — same point SpriteRenderer pins
    // to — so the label and the art share one origin.
    const sx = obj.scaleX * this._instScaleX;
    const sy = obj.scaleY * this._instScaleY;
    this.overlay.setScale(sx * this.animScale, sy * this.animScale);
    this.overlay.setRotation(obj.rotation + this.animRotation);
    const ox = (this.offsetX + this.animOffsetX) * sx;
    const oy = (this.offsetY + this.animOffsetY) * sy;
    const cos = Math.cos(obj.rotation), sin = Math.sin(obj.rotation);
    this.overlay.setPosition(
      obj.x + ox * cos - oy * sin,
      obj.y + ox * sin + oy * cos,
    );
  }

  /** Apply layer config to the text overlay. */
  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, visible: boolean): void {
    if (!this.overlay) return;
    this.overlay.setScrollFactor(scrollX, scrollY);
    this.overlay.setDepth(baseDepth + 2);
    // alpha multiplies into the behavior's own alpha — but Text's
    // syncOverlay() rewrites alpha each frame from this.alpha. So we
    // store the layer's alpha multiplier separately and apply it there.
    this._layerAlpha = alpha;
    this.overlay.setVisible(visible && !!this.visible);
  }

  /** Layer-level alpha multiplier — applied on top of the behavior's own alpha. */
  private _layerAlpha = 1;

  onDestroy(): void {
    this.overlay?.destroy();
    this.overlay = undefined;
  }
}
