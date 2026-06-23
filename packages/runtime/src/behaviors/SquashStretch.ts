import { Behavior } from "../Behavior";

/**
 * Cartoon-style squash-and-stretch effect. Drives `sprite.squashX` /
 * `sprite.squashY` over a short timeline so the visual scale wobbles
 * (wider+shorter, then taller+narrower, then back to 1). Used for
 * landing impacts, jump anticipation, telegraphed attacks, getting hit,
 * etc. The physics body never moves — only the visual scale.
 *
 * Triggered by the `PlaySquashStretch` action. The behavior holds the
 * default amplitude / duration / easing; the action can override per
 * call. Without this behavior attached, the action logs a warning and
 * does nothing.
 *
 * Implementation: a self-contained mini-timeline driven by `update(delta)`.
 * We don't lean on Phaser's tween engine here so the effect is fully
 * deterministic and never gets caught up in tween chain ordering quirks
 * with plain proxy objects.
 */
export interface SquashStretchPlayOptions {
  /** "both" = squash → stretch → return. "squash" = squash → return.
   *  "stretch" = stretch → return. Default: "both". */
  kind?: "both" | "squash" | "stretch";
  /** 0..1 — how aggressive the deformation is. 0.3 = ±30% from baseline. */
  intensity?: number;
  /** Total animation length in seconds. */
  duration?: number;
  /** Easing name, mirrors a small subset of Phaser's curves:
   *  "Linear", "Quad.Out", "Quad.In", "Quad.InOut",
   *  "Cubic.Out", "Cubic.In", "Cubic.InOut",
   *  "Sine.Out", "Sine.In", "Sine.InOut",
   *  "Bounce.Out", "Back.Out", "Elastic.Out". */
  easing?: string;
}

interface Phase {
  toX: number;
  toY: number;
  durMs: number;
  ease: string;
}

export class SquashStretch extends Behavior {
  kind = "SquashStretch";
  intensity = 0.3;
  duration = 0.3;
  easing = "Quad.Out";
  /** When 1, emit `OnSquashStretchEnd` on the sprite once the animation
   *  finishes — useful for chaining (spawn dust puff at exit, etc.). */
  emitOnEnd = 0;

  // Active timeline state. `phases` is the queued list; `phaseIdx` and
  // `phaseElapsedMs` track where we are. `fromX/Y` is the start value of
  // the CURRENT phase.
  private phases: Phase[] = [];
  private phaseIdx = -1;
  private phaseElapsedMs = 0;
  private fromX = 1;
  private fromY = 1;
  private active = false;

  /** Public API used by the PlaySquashStretch action. Cancels any in-flight
   *  animation and starts a fresh timeline. */
  play(opts?: SquashStretchPlayOptions): void {
    const sprite = this.sprite;
    if (sprite.destroyed) return;

    const intensity = clamp01(opts?.intensity ?? this.intensity);
    const duration = Math.max(0.05, opts?.duration ?? this.duration);
    const easing = opts?.easing ?? this.easing;
    const kind = opts?.kind ?? "both";

    const sx = 1 + intensity;
    const sy = 1 - intensity;
    const tx = 1 - intensity;
    const ty = 1 + intensity;

    this.phases = [];
    if (kind === "both") {
      const ms = (duration * 1000) / 3;
      this.phases.push({ toX: sx, toY: sy, durMs: ms, ease: easing });
      this.phases.push({ toX: tx, toY: ty, durMs: ms, ease: easing });
      this.phases.push({ toX: 1,  toY: 1,  durMs: ms, ease: easing });
    } else if (kind === "squash") {
      const ms = (duration * 1000) / 2;
      this.phases.push({ toX: sx, toY: sy, durMs: ms, ease: easing });
      this.phases.push({ toX: 1,  toY: 1,  durMs: ms, ease: easing });
    } else {
      const ms = (duration * 1000) / 2;
      this.phases.push({ toX: tx, toY: ty, durMs: ms, ease: easing });
      this.phases.push({ toX: 1,  toY: 1,  durMs: ms, ease: easing });
    }

    // Pick up from wherever we are right now — feels continuous on
    // re-trigger instead of snapping back to (1,1) first.
    this.fromX = sprite.squashX;
    this.fromY = sprite.squashY;
    this.phaseIdx = 0;
    this.phaseElapsedMs = 0;
    this.active = true;
  }

  /** Cancel any in-flight animation. Squash values stay where they are. */
  stop(): void {
    this.active = false;
    this.phases = [];
    this.phaseIdx = -1;
  }

  /** Force-reset the visual scale to baseline. */
  reset(): void {
    this.stop();
    if (!this.sprite.destroyed) {
      this.sprite.squashX = 1;
      this.sprite.squashY = 1;
    }
  }

  update(delta: number): void {
    if (!this.active) return;
    const sprite = this.sprite;
    if (sprite.destroyed) return;

    const phase = this.phases[this.phaseIdx];
    if (!phase) {
      this.active = false;
      return;
    }

    this.phaseElapsedMs += delta;
    let t = this.phaseElapsedMs / phase.durMs;
    if (t >= 1) t = 1;
    const k = ease(phase.ease, t);
    sprite.squashX = this.fromX + (phase.toX - this.fromX) * k;
    sprite.squashY = this.fromY + (phase.toY - this.fromY) * k;

    if (t >= 1) {
      // Snap to exact end and advance to the next phase (or finish).
      sprite.squashX = phase.toX;
      sprite.squashY = phase.toY;
      this.phaseIdx += 1;
      this.phaseElapsedMs = 0;
      this.fromX = phase.toX;
      this.fromY = phase.toY;
      if (this.phaseIdx >= this.phases.length) {
        this.active = false;
        sprite.squashX = 1;
        sprite.squashY = 1;
        if (this.emitOnEnd) sprite.events.emit("OnSquashStretchEnd");
      }
    }
  }

  onDestroy(): void {
    this.stop();
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Tiny easing library — covers the curve names exposed in the editor's
 *  PlaySquashStretch dropdown. Unknown names fall back to linear. */
function ease(name: string, t: number): number {
  switch (name) {
    case "Linear":      return t;
    case "Quad.In":     return t * t;
    case "Quad.Out":    return 1 - (1 - t) * (1 - t);
    case "Quad.InOut":  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "Cubic.In":    return t * t * t;
    case "Cubic.Out":   return 1 - Math.pow(1 - t, 3);
    case "Cubic.InOut": return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "Sine.In":     return 1 - Math.cos((t * Math.PI) / 2);
    case "Sine.Out":    return Math.sin((t * Math.PI) / 2);
    case "Sine.InOut":  return -(Math.cos(Math.PI * t) - 1) / 2;
    case "Back.Out": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    case "Bounce.Out": {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (t < 1 / d1)        return n1 * t * t;
      else if (t < 2 / d1)   return n1 * (t -= 1.5 / d1) * t + 0.75;
      else if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      else                   return n1 * (t -= 2.625 / d1) * t + 0.984375;
    }
    case "Elastic.Out": {
      const c4 = (2 * Math.PI) / 3;
      if (t === 0) return 0;
      if (t === 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
    default: return t;
  }
}
