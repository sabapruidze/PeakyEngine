import Phaser from "phaser";
import { Behavior } from "../Behavior";

/**
 * Wraps Phaser.GameObjects.Particles.ParticleEmitter as a Peaky Behavior.
 *
 * Two surfaces share this runtime class:
 *   1. Particles BP class — the host sprite is a placed emitter; the emitter
 *      stays at the instance's spawn position (host body is inert).
 *   2. Particles behavior — attached to any BP; the emitter follows the host
 *      sprite's transform every tick (footstep dust, weapon trails, etc.).
 *
 * Both modes route through the same `_phaserEmitter`, just with different
 * per-tick sync logic. The behavior owns the Phaser emitter's full lifecycle:
 *   - attach   → build Phaser config from public fields, instantiate emitter
 *   - update   → sync emitter position to host (sprite-attached only)
 *   - destroy  → tear down Phaser emitter cleanly
 *
 * Public params are intentionally Construct-3-shaped (rate, lifetime, cone,
 * scale start→end, alpha start→end, tint over life, gravity, blend mode).
 * The Phaser config builder lives in `buildPhaserConfig` so the field-to-
 * Phaser mapping is one place; tests can mock that without spinning a scene.
 *
 * Notes:
 *   - `spriteId` references a Peaky Sprite asset id (same dropdown as
 *     SpriteRenderer). The first frame's texture key is injected as
 *     `_textureKey` by runProject at attach time so this class doesn't
 *     reach into project data; if the key is missing the emitter falls
 *     back to a 1x1 white texture so misconfigured emitters are still
 *     visible (instead of silently producing nothing).
 *   - Tint interpolation: Phaser's emitter takes either a single tint or
 *     an array. We always pass `[tintStart, tintEnd]` so a single colour
 *     setup just uses the same value twice (no behavioural difference).
 *   - Burst mode emits via `explode(burstCount)` on demand; the Phaser
 *     emitter is created with `emitting: false` and the action layer
 *     drives bursts through `burst()` below.
 */
export class ParticleEmitter extends Behavior {
  kind = "ParticleEmitter";

  /** Author-facing name. When a BP has multiple emitters (e.g. "smoke"
   *  and "sparks"), actions can filter to one via the `target` param.
   *  Empty = broadcast (every emitter on the host receives the action). */
  name = "";

  // ── Emission ───────────────────────────────────────────────────────────
  /** "continuous" = emit at `rate` while enabled. "burst" = wait for a
   *  BurstParticles action to fire `burstCount` particles all at once. */
  mode: "continuous" | "burst" = "continuous";
  /** Particles per second (continuous mode). Ignored in burst mode. */
  rate = 10;
  /** Particles emitted per BurstParticles action call (burst mode). */
  burstCount = 30;
  /** Hard cap on alive particles. Phaser pools particles up to this size
   *  — once `rate × lifetime` alive at any instant exceeds the cap,
   *  Phaser drops new emissions silently and the emitter looks like it
   *  bursts and stops. Default 1000 covers rate up to 1000/s × 1s
   *  lifetime; bump higher for dense effects (firework finale, rain). */
  maxParticles = 1000;
  // (overrides the base Behavior.enabled field; truthy = active.
  // The inspector writes 0 / 1 from the bool toggle; truthy semantics
  // are preserved by all !this.enabled / !!this.enabled checks below.)
  enabled = true;
  /** Sprite asset id (Peaky Sprite library) used as the particle texture.
   *  Empty string falls back to a plain white pixel — useful for solid-
   *  colour particles tinted via tintStart/End. */
  spriteId = "";
  /** Delay (seconds) before the emitter starts emitting after attach. */
  delay = 0;
  /** Where particles spawn relative to the host:
   *   - "host" — emit from the host sprite's transform (default).
   *   - "imagePoint" — emit from a named image point on the host's
   *     SpriteRenderer's current frame. Falls back to host position
   *     when the named point isn't on the current frame (so animations
   *     where only some frames carry the point still emit cleanly when
   *     the point is missing). */
  pivotSource: "host" | "imagePoint" = "host";
  /** Image-point name used when `pivotSource = "imagePoint"`. Must match
   *  a `name` set in the SpriteRenderer's frame data (same convention as
   *  Tracer.imagePointName). */
  imagePointName = "";
  /** Random per-particle spawn offset in X around the resolved spawn
   *  position (host or image point). Each particle picks a random value
   *  in `[-spawnJitterX, +spawnJitterX]`. Useful for "fountain that
   *  isn't a single line", crowd dust, area-of-effect bursts. */
  spawnJitterX = 0;
  /** Same as spawnJitterX but on Y axis. */
  spawnJitterY = 0;

  /** Spawn offset from the resolved pivot point (host center or named
   *  image point), in pixels. Lets authors aim a "muzzle flash" emitter
   *  forward from the host center without needing a per-frame image
   *  point. Drag the green dot in the BP preview to set visually.
   *  Applied AFTER the pivot is resolved, so it works in BOTH host
   *  mode and imagePoint mode. */
  offsetX = 0;
  offsetY = 0;

  /** Render order relative to the host sprite:
   *   - "front" (default): particles render ABOVE the host's SpriteRenderer
   *     overlay — muzzle flashes, hit sparks, magic effects in front of
   *     the character.
   *   - "back": particles render BEHIND the host — wing flutter, dust
   *     trail behind a runner, aura that appears around but not over the
   *     character art.
   *  Mid-flight reads honor the current value (applyLayer + per-tick
   *  enforcement), so SetBehaviorParam can swap it at runtime. */
  renderOrder: "front" | "back" = "front";

  // ── Lifetime ───────────────────────────────────────────────────────────
  /** Particle lifetime (seconds). Each particle lives `lifetime ± lifetimeJitter`. */
  lifetime = 1.0;
  /** ± seconds of randomness around lifetime. 0 = all particles same age. */
  lifetimeJitter = 0;

  // ── Movement ───────────────────────────────────────────────────────────
  /** Initial speed (px/s). */
  speed = 100;
  /** ± px/s of randomness around speed. */
  speedJitter = 0;
  /** Cone min angle (degrees). 0 = right, 90 = down, -90 = up. */
  angleMin = -90;
  /** Cone max angle (degrees). For a tight stream, set min === max. */
  angleMax = -90;
  /** Per-particle gravity (px/s²) X axis. Persistent acceleration. */
  gravityX = 0;
  /** Per-particle gravity (px/s²) Y axis. Positive = down. */
  gravityY = 0;
  /** Air friction (0..1 per frame). 0 = no decay, 0.05 = noticeable, 1 =
   *  particles freeze instantly. Phaser implements this via per-tick
   *  velocity decay; we expose 0..1 and translate. */
  friction = 0;
  /** Initial rotation (degrees) at spawn. */
  rotationStart = 0;
  /** Final rotation (degrees) at end-of-life. Phaser interpolates. */
  rotationEnd = 0;
  /** ± degrees randomness around rotationStart at spawn. */
  rotationJitter = 0;

  // ── Visual ─────────────────────────────────────────────────────────────
  /** Scale at spawn. 1 = native sprite size. */
  scaleStart = 1;
  /** Scale at end-of-life. Phaser lerps between scaleStart → scaleEnd. */
  scaleEnd = 1;
  /** Alpha at spawn (0..1). */
  alphaStart = 1;
  /** Alpha at end-of-life. */
  alphaEnd = 0;
  /** Tint at spawn (0xRRGGBB). 0xffffff = no tint. */
  tintStart = 0xffffff;
  /** Tint at end-of-life. Phaser lerps colour over particle lifetime. */
  tintEnd = 0xffffff;
  /** Phaser blend mode. NORMAL = standard alpha blend, ADD = additive
   *  (good for fire / sparks / magic), MULTIPLY = darken-multiply. */
  blendMode: "NORMAL" | "ADD" | "MULTIPLY" = "NORMAL";
  /** "first" = always use animation frame 0. "random" = pick a random
   *  frame from the sprite's first animation per particle. Useful for
   *  variety (e.g. confetti with multiple colours stored as frames). */
  frameMode: "first" | "random" = "first";
  /** Comma-separated frame indices to cycle through per particle (e.g.
   *  "0,1,4"). 0-based numbering — matches the Sprite Editor's frame
   *  strip ("Frame 0, Frame 1, …"). Burst of N particles emits frames in
   *  order with wrap-around (`particle[i] → frames[i mod count]`).
   *  Empty = use `frameMode` (first / random across all). Whitespace +
   *  out-of-range entries are silently dropped. */
  frameIndices = "";

  // ── Injected by runProject at attach ──────────────────────────────────
  /** Phaser texture key to use as the particle image. Set by runProject
   *  from the SpriteId's first-animation, first-frame texture. */
  _textureKey?: string;
  /** Frame keys (Phaser texture frame names) for `frameMode: "random"`.
   *  When present, Phaser picks one per particle. */
  _frameKeys?: string[];
  /** Positional frame keys (index N = frame N's texture, "" for frames
   *  without an image). Used by `frameIndices` CSV to look up specific
   *  frames by their authored index. Injected by runProject alongside
   *  `_frameKeys`. */
  _frameKeysAll?: string[];
  /** Parsed `frameIndices` CSV — recomputed when the field changes.
   *  Empty when the user hasn't set frameIndices OR every parsed entry
   *  was invalid. */
  private _pickIndices: number[] = [];

  // ── Internal state ────────────────────────────────────────────────────
  private _phaserEmitter?: Phaser.GameObjects.Particles.ParticleEmitter;
  /** Captured at attach so per-tick sync only writes when the host moved. */
  private _lastSyncX = 0;
  private _lastSyncY = 0;
  /** Time accumulator for the `delay` field — emitting actually starts
   *  after `_elapsedSec >= delay`. Avoids using Phaser's frequency-delay
   *  which is spawn-only and fights with our enabled flag. */
  private _elapsedSec = 0;
  /** True once the start-delay has elapsed and emission is permitted. */
  private _readyToEmit = false;
  /** Tracks the previous tick's alive-count so we can detect the
   *  high→zero transition that triggers `OnParticleBurstEnd`. */
  private _prevAlive = 0;
  /** Burst count queued while the emitter wasn't yet ready (delay not elapsed
   *  / first tick hasn't run). OnCreate → BurstParticles fires synchronously
   *  during spawn before update() ever runs, so a naive `!_readyToEmit` bail
   *  silently dropped the burst. We accumulate here and explode on first ready. */
  private _pendingBurst = 0;
  /**
   * Real "is this emitter currently emitting" flag. Captured from the
   * config-level `enabled` value at attach time, BEFORE runProject's
   * chip-level overwrite (`sprite.lastBehavior.enabled = b.enabled !== false`)
   * resets the public `enabled` field to true.
   *
   * The collision: the base `Behavior.enabled` controls whether update()
   * runs at all; runProject reuses that same field to mirror the BP
   * behavior-chip's enabled state. The "Emit On Start" inspector toggle
   * also writes to `enabled` as its config value, which Object.assign
   * happily merges in attach() — but runProject then clobbers it. We
   * capture into `_running` between those two steps so the user's
   * inspector intent survives. All internal "should I emit?" checks
   * gate on `_running`; `enabled` is left to its base-behavior role.
   */
  private _running = true;
  /** Key of the canvas texture built by `_buildPackedFramesTexture`, tracked so
   *  it can be released on re-pack and on destroy (else it leaks for the
   *  scene's lifetime). */
  private _packedKey = "";

  init(): void {
    const scene = this.sprite.scene;
    if (!scene) return;
    this._running = !!this.enabled;
    const config = this.buildPhaserConfig();
    // Texture is required for the Phaser emitter — fall back to the
    // built-in `__DEFAULT` 32x32 white square if the user hasn't picked
    // a sprite. The tint pipeline still applies, so a coloured-particle
    // setup with no sprite asset still works (and is visibly large
    // enough to spot during dev — `__WHITE` is 1x1 and easy to miss).
    const fallbackKey = scene.textures.exists("__DEFAULT") ? "__DEFAULT"
      : scene.textures.exists("__WHITE") ? "__WHITE"
      : "";
    const texture = this._textureKey && scene.textures.exists(this._textureKey)
      ? this._textureKey
      : fallbackKey;
    if (!texture) {
      // No texture available at all — bail rather than throw on
      // `scene.add.particles` with an empty key.
      return;
    }
    // Resolve the initial spawn position BEFORE creating the Phaser
    // emitter — otherwise continuous emitters fire their first batch at
    // gameObject (host) position before `update()` runs the first time
    // and moves them to the image point. The user-visible bug: "particles
    // emit from BOTH the image point AND the pivot/host center."
    const initialPos = this.resolveSpawnPos();
    // Parse the user's frameIndices CSV. If non-empty, pack the chosen
    // frames into one Phaser canvas texture with named sub-frames so
    // the emitter can do per-particle random picking via Phaser's
    // native `frame: ["0","2","5"]` array support. Per-emit setTexture
    // doesn't work — all particles share the emitter's current texture
    // at render time, so the burst would end up all the LAST frame.
    this._reparsePickIndices();
    let effectiveIndices: number[] = [];
    if (this._pickIndices.length > 0) {
      effectiveIndices = this._pickIndices;
    } else if (this.frameMode === "random" && this._frameKeysAll) {
      effectiveIndices = this._frameKeysAll
        .map((k, i) => (k ? i : -1))
        .filter((i) => i >= 0);
    }
    let useKey = texture;
    if (effectiveIndices.length > 0 && this._frameKeysAll) {
      const packed = this._buildPackedFramesTexture(scene, effectiveIndices);
      if (packed) {
        useKey = packed.key;
        // Cycle through the listed frames in order — particle N gets
        // frames[N % frames.length]. So a burst of 3 with 10 frames
        // emits frames 0/1/2; a burst of 14 emits 0..9 then wraps back
        // to 0..3.
        (config as { frame?: unknown }).frame = {
          frames: packed.frameNames,
          cycle: true,
          quantity: 1,
        };
      }
    }
    this._phaserEmitter = scene.add.particles(
      initialPos.x,
      initialPos.y,
      useKey,
      config,
    );
    this._lastSyncX = initialPos.x;
    this._lastSyncY = initialPos.y;
    // Depth is biased relative to the host so the renderOrder field has
    // a clear meaning regardless of how high the host sits on its layer:
    //   - "front" → host.depth + 10 (above the SR overlay at host+1)
    //   - "back"  → host.depth - 10 (below the host body + SR overlay)
    // 10 is large enough that author-set per-instance z-overrides can
    // sit between particles and SR if needed, and small enough that
    // multiple layers' particle emitters don't bleed across each other.
    this._phaserEmitter.setDepth(this.sprite.gameObject.depth + (this.renderOrder === "back" ? -10 : 10));
    // Route to the same camera as the host (UI cam vs main cam). Without
    // this, BlurScene applies postFX to the main camera while the UI cam
    // also draws the emitter — producing a non-blurred ghost copy on top.
    // Mirrors the convention used by SpriteRenderer / Text / Tracer.
    this.sprite.routeOverlayToCamera(this._phaserEmitter as unknown as Phaser.GameObjects.GameObject);
    // NOTE: previously host-mode emitters called startFollow(host.gameObject)
    // so they'd track even when our update() was skipped. That diverged from
    // image-point mode (which uses per-tick setPosition) and produced a
    // user-visible bug where host-mode emitters wouldn't render at the
    // sprite center (image-point worked, host didn't). We now rely on the
    // per-tick sync in update() for BOTH modes. The original "auto-burst at
    // original spawn position when host died first" edge case is handled by
    // the resolveSpawnPos call right before the burst() explode in
    // BurstParticles, plus the position-sync at the top of update() running
    // every frame the behavior is enabled.
    // Continuous mode: start emitting immediately (after delay) iff
    // `enabled` is on. Burst mode: emitter is silent until BurstParticles.
    if (this.mode === "burst") this._phaserEmitter.stop();
    else if (!this._running) this._phaserEmitter.stop();
    // _lastSyncX/Y already seeded above from initialPos so update()'s
    // first tick doesn't re-fire setPosition for the same coords.
  }

  update(deltaMs: number): void {
    if (!this._phaserEmitter || this._phaserEmitter.scene === null) return;

    // Position sync FIRST — emitter follows the resolved spawn point
    // each tick. For "host" mode this is just the host sprite's
    // transform; for "imagePoint" it's the named point on the SR's
    // current frame (with host-position fallback when the frame lacks
    // the point). Done before the ready/auto-burst transition below
    // so the auto-burst spawns at the correct image-point position
    // on its very first frame.
    const pos = this.resolveSpawnPos();
    if (pos.x !== this._lastSyncX || pos.y !== this._lastSyncY) {
      this._phaserEmitter.setPosition(pos.x, pos.y);
      this._lastSyncX = pos.x;
      this._lastSyncY = pos.y;
    }

    // Depth sync — follow the host's CURRENT depth every tick so renderOrder
    // ("front"/"back") holds even on a Y-SORT layer, where the host's depth is
    // recomputed each tick from its world Y. Set once at init, the emitter
    // depth would fall behind a Y-sorting host and "front" particles would slip
    // BEHIND the sprite. (Mirrors SpriteRenderer.syncOverlay's depth follow.)
    const wantDepth = this.sprite.gameObject.depth + (this.renderOrder === "back" ? -10 : 10);
    if (this._phaserEmitter.depth !== wantDepth) this._phaserEmitter.setDepth(wantDepth);

    // Honor start-delay. Once the delay has elapsed, mark ready and
    // either start continuous emission OR auto-fire one burst (burst mode).
    if (!this._readyToEmit) {
      this._elapsedSec += deltaMs / 1000;
      if (this._elapsedSec >= this.delay) {
        this._readyToEmit = true;
        // Drain any BurstParticles calls that arrived BEFORE ready (typically
        // OnCreate chains, which run synchronously during spawn). One pooled
        // explode() preserves the author's intended count instead of silently
        // dropping it.
        if (this._pendingBurst > 0) {
          this._phaserEmitter.explode(this._pendingBurst);
          this._pendingBurst = 0;
        }
        if (!this._running) {
          // not running at ready time — neither path fires. StartParticles
          // can flip _running later and either start the continuous
          // stream or arm a manual burst.
        } else if (this.mode === "continuous") {
          this._phaserEmitter.start();
        } else {
          // Burst mode: fire one auto-burst on ready so configuring
          // mode = burst in the inspector "just works" without needing
          // an explicit BurstParticles action. Authors who want extra
          // bursts later still chain BurstParticles actions on top.
          this._phaserEmitter.explode(Math.max(0, Math.floor(this.burstCount)));
        }
      }
    }

    // Burst-end detection: alive-count went from >0 last frame to 0
    // this frame. Fires `_particleBurstEnd` on the host sprite's bus
    // so OnParticleBurstEnd condition matches. Edge-only (one emit per
    // burst end), powered by the same `firedThisFrame` plumbing as
    // other triggers.
    const alive = this._phaserEmitter.getAliveParticleCount();
    if (this._prevAlive > 0 && alive === 0) {
      this.sprite.events.emit("_particleBurstEnd");
      if (this.name) this.sprite.events.emit(`_particleBurstEnd:${this.name}`);
    }
    this._prevAlive = alive;
  }

  /** Resolve the world-space spawn position for new particles. For
   *  `host` mode this is just the host sprite's gameObject position;
   *  for `imagePoint` mode we look up the named point on the
   *  SpriteRenderer's current frame and fall back to the host position
   *  if the point isn't present (so animations where only some frames
   *  carry the point still emit cleanly during the gap frames). */
  /** Logged once when the image-point lookup misses, so a typo / case
   *  mismatch / no-SR setup is visible. Reset only on attach. */
  private _imagePointWarned = false;
  /** Last successful image-point OFFSET relative to the host center. Used
   *  when the CURRENT frame doesn't carry the named point (mid-animation gap
   *  frames, or a death/hurt animation that drops it) so particles keep
   *  emitting from the same logical place RELATIVE to the host instead of
   *  snapping to the sprite center.
   *
   *  Stored as an offset (not an absolute world position) on purpose: the
   *  fallback must FOLLOW the moving host. Caching the absolute world point
   *  glued the spawn to wherever the point was last seen — so an NPC that
   *  ran away from spawn and then died on a frame lacking the point burst
   *  particles back at its CREATE position. */
  private _lastImagePointOffset: { x: number; y: number } | null = null;

  private resolveSpawnPos(): { x: number; y: number } {
    const obj = this.sprite.gameObject;
    // Resolve the BASE pivot (host center or image point), then add the
    // editor-configurable (offsetX, offsetY) on top. Offset is the same
    // regardless of pivot source, so an emitter set up as "host + offset
    // (12, -4)" stays positioned correctly even if the author later
    // swaps to an image-point pivot.
    let base: { x: number; y: number };
    if (this.pivotSource !== "imagePoint" || !this.imagePointName) {
      base = { x: obj.x, y: obj.y };
    } else {
      const sr = this.sprite.findBehaviorByKind("SpriteRenderer");
      if (!sr) {
        if (!this._imagePointWarned) {
          this._imagePointWarned = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[ParticleEmitter] pivotSource="imagePoint" but host "${this.sprite.blueprintName}" has no SpriteRenderer — falling back to sprite center.`,
          );
        }
        base = { x: obj.x, y: obj.y };
      } else {
        const pt = sr.getImagePointWorld(this.imagePointName);
        if (pt) {
          this._lastImagePointOffset = { x: pt.x - obj.x, y: pt.y - obj.y };
          base = pt;
        } else if (this._lastImagePointOffset) {
          // Current frame doesn't have the point — keep tracking via the
          // last-seen offset relative to the host's CURRENT position.
          base = { x: obj.x + this._lastImagePointOffset.x, y: obj.y + this._lastImagePointOffset.y };
        } else {
          if (!this._imagePointWarned) {
            this._imagePointWarned = true;
            // eslint-disable-next-line no-console
            console.warn(
              `[ParticleEmitter] image point "${this.imagePointName}" not found on current frame ` +
              `of "${this.sprite.blueprintName}" — falling back to sprite center until the point is seen. ` +
              `Check spelling (case-sensitive) AND make sure the point is set on at least one frame the SR plays.`,
            );
          }
          base = { x: obj.x, y: obj.y };
        }
      }
    }
    return { x: base.x + this.offsetX, y: base.y + this.offsetY };
  }

  /** Apply layer config to the emitter — parallax (scrollFactor), depth
   *  band, and alpha. Without this the emitter keeps default scrollFactor
   *  (1, 1) and ignores the host layer's parallax, drifting visibly on
   *  non-1:1 parallax layers (background fog vs foreground sparks). */
  applyLayer(scrollX: number, scrollY: number, baseDepth: number, alpha: number, _visible: boolean): void {
    if (!this._phaserEmitter) return;
    this._phaserEmitter.setScrollFactor(scrollX, scrollY);
    // Mirror init()'s depth biasing so renderOrder still controls front/
    // back ordering after a layer change. Without this, applyLayer would
    // collapse the bias and particles would slam back to "above SR" on
    // a layer swap.
    this._phaserEmitter.setDepth(baseDepth + (this.renderOrder === "back" ? -10 : 10));
    this._phaserEmitter.setAlpha(alpha);
  }

  onDestroy(): void {
    const emitter = this._phaserEmitter;
    this._phaserEmitter = undefined;
    const scene = this.sprite?.scene;
    // Let a death / despawn burst FINISH instead of vanishing with the host.
    // A common pattern is "OnDeath → BurstParticles" on the dying sprite's
    // own emitter — but the host tears down the same frame, so without this
    // the particles would be destroyed the instant they spawn. If any
    // particles are still alive, stop NEW emission, detach from the (about-
    // to-die) host so it stays at the death position, and self-destruct the
    // emitter after the longest a particle could live.
    const aliveCount = (emitter as unknown as { getAliveParticleCount?: () => number })?.getAliveParticleCount?.() ?? 0;
    // The linger path only works while the scene is LIVE. During scene SHUTDOWN
    // (transition/restart) the Clock has already shut down — a delayedCall
    // scheduled now never fires, so the emitter + packed canvas would leak one
    // copy per transition (packed keys embed the sprite uid, which is fresh
    // every run, so the next run can't reuse them). Shutting down destroys all
    // display objects anyway — no linger to preserve; clean up synchronously.
    const shuttingDown = !!(scene?.sys as unknown as { isShuttingDown?: () => boolean })?.isShuttingDown?.();
    if (emitter && aliveCount > 0 && scene && !shuttingDown) {
      emitter.stop();
      (emitter as unknown as { stopFollow?: () => void }).stopFollow?.();
      const lingerMs = (this.lifetime + Math.max(0, this.lifetimeJitter)) * 1000 + 100;
      scene.time.delayedCall(lingerMs, () => {
        emitter.destroy();
        if (this._packedKey && scene.textures?.exists(this._packedKey)) scene.textures.remove(this._packedKey);
        this._packedKey = "";
      });
      return;
    }
    emitter?.destroy();
    // Release the packed-frames canvas texture so it doesn't outlive the
    // emitter in the scene's texture manager.
    if (this._packedKey && scene?.textures?.exists(this._packedKey)) scene.textures.remove(this._packedKey);
    this._packedKey = "";
  }

  // ── Public API for actions ────────────────────────────────────────────

  /** Fire a one-shot burst of `count` particles. No-op when the start-
   *  delay hasn't elapsed yet. Manual bursts (via the BurstParticles
   *  action) deliberately bypass `_running` — the author explicitly
   *  invoked the action, so "Emit On Start: OFF" should not block it. */
  burst(count: number): void {
    if (!this._phaserEmitter) return;
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return;
    if (!this._readyToEmit) {
      // OnCreate → BurstParticles fires before the emitter has its first
      // update tick. Queue the count; the ready-transition in update()
      // drains _pendingBurst into a single explode().
      this._pendingBurst += n;
      return;
    }
    // Snap the emitter to the current spawn position before exploding.
    const pos = this.resolveSpawnPos();
    this._phaserEmitter.setPosition(pos.x, pos.y);
    this._lastSyncX = pos.x;
    this._lastSyncY = pos.y;
    // Phaser's `maxParticles` is now a soft cap (see buildPhaserConfig).
    // When the in-flight count + new burst would push past the cap,
    // Phaser recycles the oldest — so two rapid bursts on the same
    // emitter visually overlap up to the cap, then start replacing.
    // No gray-screen GPU exhaustion.
    this._phaserEmitter.explode(n);
  }

  /** Resume continuous emission (no-op in burst mode and when delay hasn't
   *  elapsed). Toggles `_running` on. */
  start(): void {
    this._running = true;
    if (this._phaserEmitter && this.mode === "continuous" && this._readyToEmit) {
      this._phaserEmitter.start();
    }
  }

  /** Stop emitting. Existing particles finish their lifetime; no new ones
   *  spawn. Toggles `_running` off. */
  stop(): void {
    this._running = false;
    this._phaserEmitter?.stop();
  }

  /** Scale the emitter's simulation rate — used by HitStop to freeze
   *  particles (0) and resume them (1). Phaser particle emitters run on the
   *  raw frame loop, so `scene.time.timeScale` doesn't touch them; this is
   *  how a time-freeze reaches the particle sim. */
  setSimTimeScale(n: number): void {
    if (this._phaserEmitter) this._phaserEmitter.timeScale = Math.max(0, n);
  }

  /** Live-tune emission rate (continuous mode). Maps to Phaser's
   *  `frequency` (ms between emits) which is `1000 / rate` for our
   *  particles-per-second convention. */
  setRate(perSec: number): void {
    this.rate = Math.max(0, perSec);
    if (this._phaserEmitter && this.rate > 0) {
      this._phaserEmitter.frequency = 1000 / this.rate;
    }
  }

  /** Live-tune gravity. Phaser exposes per-particle gravity via the
   *  emitter's `gravityX/Y` op, so writing the field is enough — new
   *  particles pick up the new value at spawn. */
  setGravity(gx: number, gy: number): void {
    this.gravityX = gx;
    this.gravityY = gy;
    if (this._phaserEmitter) {
      this._phaserEmitter.gravityX = gx;
      this._phaserEmitter.gravityY = gy;
    }
  }

  /** Parse the `frameIndices` CSV into 0-based runtime indices, filtered
   *  to entries that have a frame texture. User-facing numbering is
   *  0-based to match the Sprite Editor's frame strip (which labels its
   *  frames "0, 1, 2, …") — same convention as the CharacterAnimator's
   *  frame-signal CSV. Called once at init AND any time `frameIndices` is
   *  mutated at runtime via SetBehaviorParam. */
  private _reparsePickIndices(): void {
    const raw = this.frameIndices.trim();
    if (!raw || !this._frameKeysAll || this._frameKeysAll.length === 0) {
      this._pickIndices = [];
      return;
    }
    const all = this._frameKeysAll;
    const out: number[] = [];
    for (const tok of raw.split(/[,\s]+/)) {
      if (!tok) continue;
      const n = parseInt(tok, 10);
      if (!Number.isFinite(n)) continue;
      if (n < 0 || n >= all.length) continue;
      if (!all[n]) continue; // missing image at that index
      out.push(n);
    }
    this._pickIndices = out;
  }

  /** Build a single Phaser canvas texture combining every frame named
   *  in `_pickIndices` into named sub-frames ("0", "2", "5"). The
   *  emitter config's `frame: [...names]` array then resolves against
   *  THIS packed texture and Phaser picks one per particle. Returns
   *  null when no source frames have image data — caller falls back
   *  to the single-texture path. */
  private _buildPackedFramesTexture(scene: Phaser.Scene, indices: number[]): { key: string; frameNames: string[] } | null {
    const all = this._frameKeysAll;
    if (!all) return null;
    const usable: { index: number; img: HTMLImageElement | HTMLCanvasElement; w: number; h: number }[] = [];
    for (const idx of indices) {
      const sourceKey = all[idx];
      if (!sourceKey) continue;
      const sourceTex = scene.textures.get(sourceKey);
      const src = sourceTex?.getSourceImage(0) as HTMLImageElement | HTMLCanvasElement | undefined;
      if (!src) continue;
      const w = (src as HTMLImageElement).width;
      const h = (src as HTMLImageElement).height;
      if (!w || !h) continue;
      usable.push({ index: idx, img: src, w, h });
    }
    if (usable.length === 0) return null;
    // Pack horizontally — each frame at x = sumOfPriorWidths. Phaser
    // tracks each frame's rect via the registered name, so packing
    // layout is internal and never shown to the author.
    let totalW = 0;
    let maxH = 0;
    for (const u of usable) {
      totalW += u.w;
      if (u.h > maxH) maxH = u.h;
    }
    // DETERMINISTIC key: same emitter (uid + name) + same frame SET → the same
    // texture. uid is globally unique per sprite; the frame-index signature
    // disambiguates re-tunes. This means re-entering a scene on a PERSISTENT game
    // REUSES the packed texture instead of leaking a fresh canvas per visit (the
    // old `Math.random()` suffix minted a new one every init → GPU leak).
    const safeName = (this.name || "_").replace(/[^a-zA-Z0-9]+/g, "_");
    const idxSig = usable.map((u) => u.index).join("-");
    const packedKey = `peaky_particle_pack_${this.sprite.uid}_${safeName}_${idxSig}`;
    // Already built (same frames) → reuse, don't re-pack.
    if (scene.textures.exists(packedKey)) {
      this._packedKey = packedKey;
      return { key: packedKey, frameNames: usable.map((u) => String(u.index)) };
    }
    // Frames changed → drop the emitter's PREVIOUS pack so canvases don't pile up.
    if (this._packedKey && this._packedKey !== packedKey && scene.textures.exists(this._packedKey)) scene.textures.remove(this._packedKey);
    this._packedKey = packedKey;
    const ct = scene.textures.createCanvas(packedKey, totalW, maxH);
    if (!ct) return null;
    const ctx = ct.getContext();
    let xCursor = 0;
    const frameNames: string[] = [];
    for (const u of usable) {
      ctx.drawImage(u.img as CanvasImageSource, xCursor, 0);
      const name = String(u.index);
      ct.add(name, 0, xCursor, 0, u.w, u.h);
      frameNames.push(name);
      xCursor += u.w;
    }
    ct.refresh();
    return { key: packedKey, frameNames };
  }

  /** Live-tune base speed. Stores the new value on the behavior fields;
   *  Phaser's emitter config captures speed at construction so existing
   *  particles keep their original speed. New particles use the updated
   *  value via the per-particle EmitterOp resolution path.
   *
   *  NOTE: live range updates (min/max) aren't supported by Phaser's
   *  EmitterOp at runtime — the op is configured at create time. The
   *  scalar speed update below works for the common single-value case.
   *  Authors who need a runtime range change should StopParticles and
   *  re-StartParticles after writing speedJitter via SetBehaviorParam. */
  setSpeed(speed: number, jitter: number = 0): void {
    this.speed = speed;
    this.speedJitter = Math.max(0, jitter);
    if (this._phaserEmitter) {
      // Set the scalar default via the emitter's runtime ops; jitter is
      // captured at config-build time and not updated here.
      this._phaserEmitter.ops.speedX.onChange(speed);
      this._phaserEmitter.ops.speedY.onChange(speed);
    }
  }

  /** Live-tune which frames the emitter draws (frameMode + frameIndices),
   *  used by a particle override. The frame set is packed into a texture at
   *  creation, so a runtime change rebuilds that packed texture and re-points
   *  the live emitter at it. No-op when there's nothing multi-frame to pick. */
  setFrameSelection(frameIndices: string, frameMode: string): void {
    if (!this._phaserEmitter) return;
    // Idempotent — skip the rebuild when neither input changed. Without this,
    // every BurstParticles action call with `frameMode` or `frameIndices`
    // present in the config (even unchanged from the inspector defaults)
    // would tear down the packed texture and rebuild it. Particles from a
    // previous burst still referenced the old texture pointer; Phaser then
    // crashed silently on the next render → the "gray screen on second
    // attack hit" symptom that bit combat chains. The early-return
    // preserves the old texture so in-flight particles stay valid.
    const nextFrameMode = (frameMode === "first" || frameMode === "random") ? frameMode : this.frameMode;
    const nextFrameIndices = frameIndices ?? "";
    if (nextFrameIndices === this.frameIndices && nextFrameMode === this.frameMode) return;
    const scene = this.sprite.scene;
    this.frameIndices = nextFrameIndices;
    this.frameMode = nextFrameMode;
    this._reparsePickIndices();
    let indices: number[] = [];
    if (this._pickIndices.length > 0) indices = this._pickIndices;
    else if (this.frameMode === "random" && this._frameKeysAll) {
      indices = this._frameKeysAll.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
    }
    if (indices.length === 0 || !this._frameKeysAll) return;
    const packed = this._buildPackedFramesTexture(scene, indices);
    if (!packed) return;
    this._phaserEmitter.setTexture(packed.key);
    this._phaserEmitter.setEmitterFrame(packed.frameNames, false, 1);
    this._textureKey = packed.key;
  }

  /** Live-tune particle texture. Swaps the texture key on the emitter;
   *  subsequent particles use the new image. */
  setTexture(textureKey: string): void {
    if (!this._phaserEmitter) return;
    if (textureKey && this.sprite.scene.textures.exists(textureKey)) {
      this._phaserEmitter.setTexture(textureKey);
      this._textureKey = textureKey;
    }
  }

  /** Number of currently-alive particles. Used by CompareParticleCount. */
  getAliveCount(): number {
    return this._phaserEmitter?.getAliveParticleCount() ?? 0;
  }

  /** True while at least one particle is alive AND emission is enabled.
   *  Used by IsEmittingParticles condition. */
  isActive(): boolean {
    if (!this._phaserEmitter) return false;
    if (!this._running) return false;
    if (this.mode === "continuous") return this._readyToEmit;
    return this._phaserEmitter.getAliveParticleCount() > 0;
  }

  // ── Phaser config builder ─────────────────────────────────────────────

  /** Translate our 25 public fields into a Phaser ParticleEmitter config.
   *  Pure function of `this` — no scene state, no Phaser globals. Lets the
   *  config layer be unit-tested without booting a scene. */
  private buildPhaserConfig(): Phaser.Types.GameObjects.Particles.ParticleEmitterConfig {
    const blendMap: Record<string, Phaser.BlendModes> = {
      NORMAL: Phaser.BlendModes.NORMAL,
      ADD: Phaser.BlendModes.ADD,
      MULTIPLY: Phaser.BlendModes.MULTIPLY,
    };
    // Lifetime in ms (Phaser convention).
    const lifeMs = this.lifetime * 1000;
    const jitterMs = this.lifetimeJitter * 1000;
    // Speed range — Phaser samples per particle.
    const speedMin = Math.max(0, this.speed - this.speedJitter);
    const speedMax = this.speed + this.speedJitter;
    // Frame selection lives entirely in the init() packed-texture path
    // — passing raw texture KEYS via `frame:` to Phaser doesn't work
    // (Phaser treats them as frame NAMES within ONE texture, which only
    // has its default frame). The buildPackedFramesTexture path handles
    // both modes: CSV-specific subset OR frameMode=random across all
    // frames. Leave `frame` undefined here.
    const frame: undefined = undefined;

    return {
      // Per-particle spawn offset around the emitter's position. When
      // jitter is 0 we omit (Phaser defaults to 0,0 = exact position).
      // Phaser's `x`/`y` ops are spawn-time deltas relative to the
      // emitter — moving the emitter via setPosition (per-tick sync /
      // burst) shifts the random range with it.
      ...(this.spawnJitterX > 0
        ? { x: { min: -this.spawnJitterX, max: this.spawnJitterX } }
        : {}),
      ...(this.spawnJitterY > 0
        ? { y: { min: -this.spawnJitterY, max: this.spawnJitterY } }
        : {}),
      // Lifecycle
      lifespan: jitterMs > 0 ? { min: lifeMs - jitterMs, max: lifeMs + jitterMs } : lifeMs,
      // 1000 / rate gives ms between emissions in continuous mode. 0 rate
      // freezes the emitter without disabling it (special-case: subscribe
      // to enabled instead).
      frequency: this.rate > 0 ? 1000 / this.rate : -1,
      // Pool cap: always set to 0 (unlimited) at creation regardless of
      // mode. Phaser's `maxParticles` is read during particle allocation;
      // setting it AFTER creation doesn't reliably grow the underlying
      // pool (the cap was respected at first allocation and stays
      // sticky). With 0 at creation, the pool grows freely to whatever
      // size is needed, so successive bursts coexist without recycling
      // each other's still-alive particles.
      //
      // Memory stays bounded by `lifetime` × rate naturally — particles
      // self-destruct after their configured lifetime, freeing slots
      // for reuse. The user's `maxParticles` field is now advisory: it
      // doesn't cap, but the per-burst pre-burst slot bump in burst()
      // still uses it as a hint for the headroom calculation.
      maxParticles: 0,
      quantity: 1,
      // Position random — handled by setPosition + offset; we keep particle
      // spawn at emitter origin and let speed+angle disperse them.
      // Movement
      speed: speedMin === speedMax ? speedMin : { min: speedMin, max: speedMax },
      angle: this.angleMin === this.angleMax
        ? this.angleMin
        : { min: this.angleMin, max: this.angleMax },
      gravityX: this.gravityX,
      gravityY: this.gravityY,
      // Phaser doesn't have a direct "friction" — implement as exponential
      // velocity decay via the per-particle update callback. Disabled at
      // friction=0 to skip the per-tick math entirely.
      ...(this.friction > 0
        ? { particleBringToTop: false } // placeholder — friction wired below
        : {}),
      // Rotation — three cases:
      //  1) jitter > 0 with no end animation (start === end): per-particle
      //     random rotation in [start - jitter, start + jitter]. Constant
      //     for that particle's lifetime. Phaser's `{ min, max }` shape.
      //  2) jitter > 0 WITH end animation (start !== end): each particle
      //     spawns with random rotation, then linearly interpolates to
      //     `end`. Implemented via onEmit (random spawn, stored on the
      //     particle) + onUpdate (lerp from stored spawn → end). Phaser's
      //     simple `{ start, end }` only handles a single shared start.
      //  3) jitter === 0 + start === end → constant; otherwise simple
      //     `{ start, end }` interpolation.
      rotate: this.rotationJitter > 0
        ? (this.rotationStart === this.rotationEnd
            ? { min: this.rotationStart - this.rotationJitter, max: this.rotationStart + this.rotationJitter }
            : (() => {
                const start = this.rotationStart;
                const end = this.rotationEnd;
                const jitter = this.rotationJitter;
                return {
                  onEmit: (particle?: Phaser.GameObjects.Particles.Particle): number => {
                    const spawn = start + (Math.random() * 2 - 1) * jitter;
                    // Stash the per-particle spawn rotation so onUpdate
                    // knows where to interpolate FROM. `data` is a free
                    // store Phaser provides for exactly this kind of use.
                    if (particle) (particle.data as Record<string, unknown>).spawnRot = spawn;
                    return spawn;
                  },
                  onUpdate: (particle: Phaser.GameObjects.Particles.Particle, _key: string, t: number): number => {
                    const spawn = ((particle.data as Record<string, unknown>).spawnRot as number | undefined) ?? start;
                    return spawn + (end - spawn) * t;
                  },
                };
              })())
        : (this.rotationStart === this.rotationEnd
            ? this.rotationStart
            : { start: this.rotationStart, end: this.rotationEnd }),
      // Visual
      scale: this.scaleStart === this.scaleEnd
        ? this.scaleStart
        : { start: this.scaleStart, end: this.scaleEnd },
      alpha: this.alphaStart === this.alphaEnd
        ? this.alphaStart
        : { start: this.alphaStart, end: this.alphaEnd },
      // Tint over life — always emit an array so Phaser interpolates
      // even when start === end (no behavioural change, simpler code).
      tint: [this.tintStart, this.tintEnd],
      blendMode: blendMap[this.blendMode] ?? Phaser.BlendModes.NORMAL,
      frame,
      // Continuous emitters start emitting after init (with start-delay
      // honored manually in update). Burst mode starts silent.
      // Continuous mode + _running=on → emit on creation. Burst mode
      // never sets emitting; bursts go through explode() in update.
      // (Gates on `_running` — captured from the inspector's enabled
      // value at init() — not on `this.enabled`, which runProject
      // overwrites with the BP chip-enabled flag after attach.)
      emitting: this.mode === "continuous" && this._running,
    };
  }
}
