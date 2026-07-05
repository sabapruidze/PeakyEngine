import Phaser from "phaser";
import { Behavior } from "../Behavior";

/** Common surface of the particle GameObjects we use (Image / Arc / Rectangle). */
type WGO = Phaser.GameObjects.GameObject & {
  x: number; y: number; rotation: number;
  setDepth(n: number): unknown; setScrollFactor(n: number): unknown;
  setVisible(v: boolean): unknown; destroy(): void;
};
type Particle = { go: WGO; x: number; y: number; phase: number; sp: number; rot0: number; landFrac: number };

/** Drop-in weather — rain / snow across the scene.
 *  - `space`: SCREEN (camera-fixed sheet) vs WORLD (world coords, parallax).
 *  - `mode`: TOPDOWN resets each particle at a random height for a depth
 *    illusion (rain landing at varied distances on a floor); SIDESCROLLER falls
 *    until it hits an object carrying one of `killTags` (ground / trees), then
 *    respawns at the top. */
export class Weather extends Behavior {
  kind = "Weather";
  on = 1;
  /** "screen" | "world". (Sidescroller always runs in world space so particles
   *  can collide with world objects.) */
  space = "screen";
  /** "topdown" | "sidescroller". */
  mode = "topdown";
  /** Sidescroller: comma-separated tags whose objects destroy particles
   *  (e.g. "ground,trees"). Checked against tagged BPs AND tagged tiles. */
  killTags: string | string[] = "";
  /** Comma-separated tags that SHELTER from the weather — drops are hidden over
   *  the footprint of any object carrying one (roofs, canopy, awnings). Unlike
   *  killTags this doesn't destroy the drop; it just stops it rendering while
   *  inside, so no rain appears ON those tiles/sprites. Works in any mode.
   *  Checked against tagged BPs AND tagged tiles (same as killTags). */
  shelterTags: string | string[] = "";
  /** Like shelterTags, but the "no-splash" (RED) variant — objects carrying one
   *  of these keep the rain FALLING but remove its splashes. shelterTags (dry)
   *  wins where both match. */
  shelterDrizzleTags: string | string[] = "";
  /** Particle count (density). */
  count = 160;
  /** Fall speed px/s. */
  speed = 380;
  /** Per-particle speed variation 0..1. */
  speedJitter = 0.3;
  /** Fall DIRECTION — degrees from straight-down (+ = toward the right). */
  angle = 12;
  /** Extra constant horizontal drift px/s (wind). */
  wind = 0;
  /** Per-particle spin, degrees/sec. 0 = no spin (line shapes align to fall). */
  rotationSpeed = 0;
  /** "line" | "circle" | "sprite". */
  shape = "line";
  /** Particle size px. */
  size = 14;
  /** Per-particle size variation 0..1. */
  sizeJitter = 0.4;
  /** Line thickness px. */
  thickness = 2;
  /** Colour (hex 0xRRGGBB) for line/circle. */
  color = 0xaaccff;
  /** Opacity 0..1. */
  alpha = 0.6;
  /** Horizontal sway amplitude px (snow drift). */
  sway = 0;
  /** Sway speed. */
  swaySpeed = 1.5;
  /** Sprite asset id for shape = "sprite" (falls back to a circle if missing). */
  spriteId = "";
  /** Side-scroller: 1 = spawn a splash where a particle dies on a kill-tag. */
  splash = 0;
  /** "simple" (a few scattering pixels) | "sprite" (one-shot sprite animation). */
  splashType = "simple";
  /** Sprite asset for splashType = "sprite". */
  splashSprite = "";
  /** Animation name on the splash sprite (empty = first). */
  splashAnim = "";
  /** Splash sprite scale. */
  splashScale = 1;

  // Above all gameplay (Y-sorted sprites/tiles, layer-bound sprite objects reach
  // ~1e9) so screen-space weather draws in FRONT. UI is a separate camera, so
  // this never covers HUD.
  static DEPTH = 1_900_000_000;
  /** Per-frame cap so heavy rain on the ground doesn't spawn hundreds of splashes. */
  private _splashBudget = 0;

  private _parts: Particle[] = [];
  private _t = 0;
  private _vx = 0;
  private _vy = 0;
  private _rot = 0;
  private _effSway = 0;
  private _killRectsCache: Phaser.Geom.Rectangle[] = [];
  private _killRectsFrame = 0;
  private _shelterRectsCache: Phaser.Geom.Rectangle[] = [];
  private _shelterRectsFrame = 0;
  private _drizzleRectsCache: Phaser.Geom.Rectangle[] = [];
  private _drizzleRectsFrame = 0;
  /** Render depth — set from the host LAYER (applyLayer) to the top of its band,
   *  so the layer stack controls whether the weather is above gameplay but below
   *  a higher layer (e.g. a darkness sheet). Falls back to DEPTH before the
   *  layer is known. */
  private _depth = Weather.DEPTH;

  private _effShape(): string { return this.shape; }
  /** Sidescroller must collide with world objects, so it's always world-space. */
  private _worldSpace(): boolean { return this.space === "world" || this.mode === "sidescroller"; }

  /** Normalize a tag field to a clean list. The inspector's `tagList` type
   *  stores a string[], but saved/default configs can be a comma string — accept
   *  both so neither `.split` nor `.trim` blows up. */
  private _tagList(v: unknown): string[] {
    const arr = Array.isArray(v) ? v : String(v ?? "").split(",");
    return arr.map((t) => String(t).trim()).filter((t) => t.length > 0);
  }

  /** World-space AABBs of objects carrying any of `tagSrc` — tagged BPs
   *  (peaky.sprites) and tagged tiles (peaky.bigTileImages). Used for both the
   *  sidescroller kill-tags and the shelter-tags. */
  private _rectsForTags(scene: Phaser.Scene, tagSrc: unknown): Phaser.Geom.Rectangle[] {
    const tags = this._tagList(tagSrc);
    if (!tags.length) return [];
    const out: Phaser.Geom.Rectangle[] = [];
    const sprites = scene.data.get("peaky.sprites") as Array<{ tags?: Set<string>; gameObject?: { getBounds?: () => Phaser.Geom.Rectangle } }> | undefined;
    if (sprites) for (const s of sprites) {
      if (s.tags && tags.some((t) => s.tags!.has(t)) && s.gameObject?.getBounds) out.push(s.gameObject.getBounds());
    }
    const tiles = scene.data.get("peaky.bigTileImages") as Array<{ img?: { getBounds?: () => Phaser.Geom.Rectangle }; tags?: string[] }> | undefined;
    if (tiles) for (const e of tiles) {
      if (e.tags && tags.some((t) => e.tags!.includes(t)) && e.img?.getBounds) out.push(e.img.getBounds());
    }
    return out;
  }

  init(): void {
    const scene = this.sprite.scene;
    if (!scene) return;
    this._t = 0;
    const shape = this._effShape();
    this._effSway = Number(this.sway) || 0;
    const cam = scene.cameras.main;
    const ws = this._worldSpace();
    const left = ws ? cam.worldView.x : 0;
    const top = ws ? cam.worldView.y : 0;
    const w = ws ? cam.worldView.width : cam.width;
    const h = ws ? cam.worldView.height : cam.height;
    const sf = ws ? 1 : 0;
    const texKey = shape === "sprite"
      ? (scene.data.get("peaky.spriteImageKey") as Record<string, string> | undefined)?.[this.spriteId]
      : undefined;
    const make = (x: number, y: number, sz: number): WGO => {
      let go: WGO;
      const sizeP = Math.max(1, this.size * sz);
      if (shape === "sprite" && texKey && scene.textures.exists(texKey)) {
        const img = scene.add.image(x, y, texKey);
        img.setDisplaySize(sizeP, sizeP).setAlpha(this.alpha);
        go = img as unknown as WGO;
      } else if (shape === "circle" || (shape === "sprite" && !texKey)) {
        go = scene.add.circle(x, y, Math.max(1, sizeP / 2), this.color, this.alpha) as unknown as WGO;
      } else {
        go = scene.add.rectangle(x, y, Math.max(1, this.thickness), Math.max(2, sizeP), this.color, this.alpha) as unknown as WGO;
      }
      go.setDepth(this._depth);
      go.setScrollFactor(sf);
      this.sprite.routeOverlayToCamera(go);
      return go;
    };
    const szJit = Math.max(0, Math.min(1, this.sizeJitter));
    const spJit = Math.max(0, Math.min(1, this.speedJitter));
    for (let i = 0; i < Math.max(0, Math.min(2000, this.count)); i++) {
      const x = left + Math.random() * w;
      const y = top + Math.random() * h;
      const sz = 1 + (Math.random() * 2 - 1) * szJit;
      const sp = Math.max(0.1, 1 + (Math.random() * 2 - 1) * spJit);
      this._parts.push({ go: make(x, y, sz), x, y, phase: Math.random() * Math.PI * 2, sp, rot0: Math.random() * Math.PI * 2, landFrac: Math.random() });
    }
    this._recomputeVelocity();
  }

  private _recomputeVelocity(): void {
    // Coerce — inspector number fields can arrive as strings, and `speed + wind`
    // would then concatenate instead of add, silently dropping the wind.
    const speed = Number(this.speed) || 0;
    const wind = Number(this.wind) || 0;
    const rad = ((Number(this.angle) || 0) * Math.PI) / 180;
    this._vx = Math.sin(rad) * speed + wind;
    this._vy = Math.cos(rad) * speed;
    this._rot = Math.atan2(-this._vx, this._vy);
  }

  /** Splash at the impact point (sidescroller kill). */
  private _spawnSplash(scene: Phaser.Scene, x: number, y: number): void {
    const sf = this._worldSpace() ? 1 : 0;
    if (this.splashType === "sprite" && this.splashSprite) {
      const spawnSO = scene.data.get("peaky.spawnRuntimeSpriteObject") as
        | ((s: Phaser.Scene, spriteId: string, x: number, y: number, layer?: string) => (Phaser.GameObjects.GameObject & { setScale?: (n: number) => void; getData?: (k: string) => unknown }) | null)
        | undefined;
      if (!spawnSO) return;
      const go = spawnSO(scene, this.splashSprite, x, y, "");
      if (!go) return;
      // One-shot FX — must NOT be captured for scene persistence, else it
      // reappears as a static, wrong-animation sprite when you return.
      (go as unknown as { setData?: (k: string, v: unknown) => void }).setData?.("peaky.soTransient", true);
      go.setScale?.(this.splashScale);
      // Match the rain's depth + scroll so the splash sits on the SAME band as
      // the drops — without this, spawnSO stamps the sprite-object layer's depth
      // (baseDepth + 900_000 of the top layer) and the splash floats above
      // everything, including layers drawn over the rain.
      const goz = go as unknown as { setDepth?: (n: number) => void; setScrollFactor?: (n: number) => void };
      goz.setDepth?.(this._depth);
      goz.setScrollFactor?.(sf);
      // One-shot: play the chosen anim once, then auto-destroy the placement.
      const sw = go.getData?.("peaky.placementSwitchAnim") as ((name: string, opts?: { loop?: boolean; startFrame?: number; destroyOnFinish?: boolean }) => void) | undefined;
      if (sw) sw(this.splashAnim, { destroyOnFinish: true, startFrame: 0 });
      return;
    }
    // Simple: a crown of 4..10 droplets (rain-line thickness) launching UP + OUT
    // from the impact point and arcing back DOWN under gravity — an actual
    // splash, not drifting dots. Each self-destroys at the end of its arc.
    const n = 4 + Math.floor(Math.random() * 7);
    const psz = Math.max(1, this.thickness);
    const out = this.size * 1.2 + 16;
    const a0 = Math.max(0, Math.min(1, Number(this.alpha) || 0)); // match rain opacity
    for (let i = 0; i < n; i++) {
      const px = scene.add.rectangle(x, y, psz, psz, this.color, a0);
      px.setDepth(this._depth);
      px.setScrollFactor(sf);
      this.sprite.routeOverlayToCamera(px);
      const dir = Math.random() < 0.5 ? -1 : 1;
      const vx = dir * (10 + Math.random() * out);   // outward
      const vy = -(55 + Math.random() * 85);          // upward launch
      const g = 520;                                   // gravity px/s²
      const life = 320 + Math.random() * 260;          // ms
      const h = { t: 0 };
      scene.tweens.add({
        targets: h, t: 1, duration: life, ease: "Linear",
        onUpdate: () => {
          const ts = (h.t * life) / 1000;
          px.x = x + vx * ts;
          px.y = y + vy * ts + 0.5 * g * ts * ts;
          px.alpha = a0 * (1 - h.t);
        },
        onComplete: () => { try { px.destroy(); } catch { /* gone */ } },
      });
    }
  }

  update(delta: number): void {
    if (!this._parts.length) return;
    const scene = this.sprite.scene;
    if (!this.on || !scene) { for (const p of this._parts) p.go.setVisible(false); return; }
    const dt = delta / 1000;
    this._t += dt;
    this._recomputeVelocity();
    const cam = scene.cameras.main;
    const ws = this._worldSpace();
    const left = ws ? cam.worldView.x : 0;
    const top = ws ? cam.worldView.y : 0;
    const w = ws ? cam.worldView.width : cam.width;
    const h = ws ? cam.worldView.height : cam.height;
    const margin = (Number(this.size) || 0) + 8;
    const spin = (this.rotationSpeed * Math.PI) / 180;
    const isLine = this._effShape() === "line";
    const topdown = this.mode === "topdown";
    // Cache the kill-rects — recompute every 8th frame instead of allocating a
    // fresh getBounds() for every tagged object every frame. Ground/trees are
    // static, so an 8-frame-stale box is invisible; fast-moving tagged objects
    // get slightly delayed collision, which is fine for weather.
    let killRects: Phaser.Geom.Rectangle[] = [];
    if (this.mode === "sidescroller") {
      if (this._killRectsFrame++ % 8 === 0) this._killRectsCache = this._rectsForTags(scene, this.killTags);
      killRects = this._killRectsCache;
    }
    let shelterRects: Phaser.Geom.Rectangle[] = [];
    if (this._tagList(this.shelterTags).length) {
      if (this._shelterRectsFrame++ % 8 === 0) this._shelterRectsCache = this._rectsForTags(scene, this.shelterTags);
      shelterRects = this._shelterRectsCache;
    }
    let drizzleRects: Phaser.Geom.Rectangle[] = [];
    if (this._tagList(this.shelterDrizzleTags).length) {
      if (this._drizzleRectsFrame++ % 8 === 0) this._drizzleRectsCache = this._rectsForTags(scene, this.shelterDrizzleTags);
      drizzleRects = this._drizzleRectsCache;
    }
    // Painted static-shelter mask (baked from scene.navMesh.shelter). O(1) cell
    // lookup per drop — no per-frame allocation, so it's read fresh each tick.
    const shelterMask = scene.data.get("peaky.shelterMask") as { cols: number; rows: number; cellSize: number; cells: number[] } | undefined;
    this._splashBudget = 8;
    for (const p of this._parts) {
      p.go.setVisible(true);
      p.x += this._vx * p.sp * dt;
      p.y += this._vy * p.sp * dt;
      let drawX = p.x;
      if (this._effSway > 0) drawX += Math.sin(this._t * this.swaySpeed + p.phase) * this._effSway;
      // Decide whether this particle respawns this frame. "landed" = hit the
      // ground (topdown varied-height OR a sidescroller kill-tag) → splashes;
      // "offBottom" = fell past the field with no surface → no splash.
      const offBottom = p.y > top + h + margin;
      let landed = topdown && p.y > top + p.landFrac * h;
      if (!landed && !offBottom && killRects.length) {
        for (const r of killRects) { if (Phaser.Geom.Rectangle.Contains(r, drawX, p.y)) { landed = true; break; } }
      }
      // Under shelter? Test the drop's CURRENT (pre-respawn) position so a drop
      // that lands under cover neither SPLASHES nor draws there. Screen-space
      // drops convert to world coords to match the world-space shelter AABBs.
      // 0 = not sheltered, 1 = BLUE (drops hidden + splashes off — fully dry),
      // 2 = RED (drops still fall; ONLY the splashes are removed). Painted mask
      // carries the per-cell kind; tagged shelter (movable objects) kills both.
      let shelterKind = 0;
      if (shelterRects.length || drizzleRects.length || shelterMask) {
        const wx = ws ? drawX : cam.worldView.x + drawX / cam.zoom;
        const wy = ws ? p.y : cam.worldView.y + p.y / cam.zoom;
        if (shelterMask) {
          const cc = Math.floor(wx / shelterMask.cellSize);
          const cr = Math.floor(wy / shelterMask.cellSize);
          if (cc >= 0 && cc < shelterMask.cols && cr >= 0 && cr < shelterMask.rows) shelterKind = shelterMask.cells[cr * shelterMask.cols + cc] || 0;
        }
        // Dry (both) wins over no-splash (drizzle) where they overlap.
        if (shelterKind === 0) for (const r of shelterRects) { if (Phaser.Geom.Rectangle.Contains(r, wx, wy)) { shelterKind = 1; break; } }
        if (shelterKind === 0) for (const r of drizzleRects) { if (Phaser.Geom.Rectangle.Contains(r, wx, wy)) { shelterKind = 2; break; } }
      }
      if (offBottom || landed) {
        // Splash only where nothing shelters — BOTH blue and red remove splashes.
        if (landed && this.splash && shelterKind === 0 && this._splashBudget > 0) { this._spawnSplash(scene, drawX, p.y); this._splashBudget--; }
        p.y = top - margin;
        p.x = left + Math.random() * w;
        p.landFrac = Math.random();
        drawX = p.x;
      } else {
        if (drawX > left + w + margin) p.x -= w + margin * 2;
        else if (drawX < left - margin) p.x += w + margin * 2;
        // Blue (1) only: hide the falling drop. Red (2) keeps drops visible and
        // just suppresses their splashes (the shelterKind===0 gate above).
        if (shelterKind === 1) { p.go.setVisible(false); continue; }
      }
      p.go.x = drawX;
      p.go.y = p.y;
      if (spin !== 0) p.go.rotation = p.rot0 + spin * this._t;
      else if (isLine) p.go.rotation = this._rot;
    }
  }

  applyLayer(_sx: number, _sy: number, baseDepth: number, _a: number, visible: boolean): void {
    // Render at the TOP of the host layer's band (matches Sprite Objects), so the
    // layer stack decides coverage: a layer ABOVE the weather's layer (higher
    // baseDepth, ≥ +1,000,000) draws over it, a layer below draws under it.
    this._depth = baseDepth + 900_000;
    for (const p of this._parts) { p.go.setDepth(this._depth); p.go.setVisible(visible && !!this.on); }
  }

  onDestroy(): void {
    for (const p of this._parts) p.go.destroy();
    this._parts = [];
  }
}
