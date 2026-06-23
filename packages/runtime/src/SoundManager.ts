import Phaser from "phaser";

/**
 * Runtime audio for Peaky. One SoundManager per scene, stored in
 * `scene.data` under `peaky.sound`. Action handlers (PlayMusic / PlaySound /
 * …) look it up and drive it.
 *
 * Two roles, mirroring the SoundAsset.kind split:
 *   • MUSIC — a single looping track. `playMusic` stops whatever's playing
 *     and starts the new one (optionally cross-fading). Routed through
 *     master × music volume.
 *   • SFX — fire-and-forget one-shots that overlap freely. Tracked by name
 *     so `stopSound(name)` can cut them. Routed through master × sfx volume.
 *
 * Phaser audio is registered under keys `sound:<assetId>` by the preload
 * pass in runProject. The manager resolves author-facing NAMES to those
 * keys via the asset table passed to the constructor.
 */
export interface SoundAssetRuntime {
  id: string;
  name: string;
  kind: "music" | "sfx";
  /** Authored default volume 0..1. */
  volume: number;
  /** Authored default loop flag. */
  loop: boolean;
  /** Max simultaneous copies (0/undefined = unlimited); steal oldest above it. */
  maxInstances?: number;
  /** Min real-time ms between retriggers (0/undefined = none). */
  minIntervalMs?: number;
}

interface PlayOpts {
  /** 0..1 — overrides the asset's authored volume for this play. */
  volume?: number;
  /** Overrides the asset's authored loop flag for this play. */
  loop?: boolean;
  /** Playback rate (1 = normal). <1 lower/slower pitch, >1 higher/faster.
   *  Used by PlaySounds for per-play pitch variation. */
  rate?: number;
}

/** Config for the multi-sound player (PlaySounds action). */
export interface MultiPlayOpts {
  /** random = random selection; queue = in list order; all = simultaneous. */
  playMode: "random" | "queue" | "all";
  /** false → play exactly ONE sound; true → play ALL one-after-another.
   *  Ignored for `all` (which is always simultaneous). */
  playInSequence: boolean;
  /** Real-time seconds between consecutive sounds in sequence mode. */
  gapSec: number;
  volumeMin: number;
  volumeMax: number;
  pitchMin: number;
  pitchMax: number;
  /** Stable per-node key so queue+single can step 1→2→3 across calls. */
  cursorKey?: string;
}

/** scene.data key the SoundManager is stored under. */
export const SOUND_KEY = "peaky.sound";

/** Convenience lookup used by action handlers. */
export function getSoundManager(scene: Phaser.Scene): SoundManager | undefined {
  return scene.data.get(SOUND_KEY) as SoundManager | undefined;
}

export class SoundManager {
  private scene: Phaser.Scene;
  private byName = new Map<string, SoundAssetRuntime>();

  // Volume buses (0..1). Effective gain = master × bus × per-call volume.
  private masterVol = 1;
  private musicVol = 1;
  private sfxVol = 1;

  // Current music track (single channel).
  private music: Phaser.Sound.BaseSound | null = null;
  private musicName = "";
  private musicBaseVol = 1; // the per-call volume, before bus scaling

  // Active SFX instances grouped by sound name, so stopSound(name) works and
  // finished instances can be reaped.
  private sfx = new Map<string, Phaser.Sound.BaseSound[]>();
  // Last real-time start (ms, scene clock) per sound name — drives minIntervalMs
  // retrigger throttling so a burst of identical hits collapses to one play.
  private lastPlayMs = new Map<string, number>();

  // PlaySounds queue+single stepping — last index played per node key.
  private cursors = new Map<string, number>();
  // Pending real-time gap timers for sequence playback (cleared on stopAll).
  private seqTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(scene: Phaser.Scene, assets: SoundAssetRuntime[]) {
    this.scene = scene;
    for (const a of assets) {
      if (a.name) this.byName.set(a.name, a);
    }
    // Clear pending native `setTimeout`s (stagger / sequence gaps) when the
    // scene shuts down — otherwise a deferred sound callback can fire into a
    // torn-down scene on the next Play, leaking timers across sessions.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.dispose());
    scene.events.once(Phaser.Scenes.Events.DESTROY, () => this.dispose());
    this.installLimiter();
  }

  /** Insert a brick-wall-ish compressor between the master gain and the audio
   *  destination so the SUMMED signal can never clip ("red-line") no matter how
   *  many sounds stack — the professional safety net (FMOD/Wwise bus limiter,
   *  Unreal submix limiter). Once per game (the WebAudio sound manager is shared
   *  across scenes). No-ops on the HTML5-audio fallback or if Phaser's node
   *  shape ever changes. */
  private installLimiter(): void {
    try {
      const sm = this.scene.sound as unknown as {
        context?: AudioContext;
        masterVolumeNode?: AudioNode;
        __peakyLimiter?: boolean;
      };
      if (!sm.context || !sm.masterVolumeNode || sm.__peakyLimiter) return;
      const ctx = sm.context;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -3;  // start limiting just below 0 dBFS
      comp.knee.value = 6;
      comp.ratio.value = 20;      // near brick-wall
      comp.attack.value = 0.002;
      comp.release.value = 0.2;
      sm.masterVolumeNode.disconnect();
      sm.masterVolumeNode.connect(comp);
      comp.connect(ctx.destination);
      sm.__peakyLimiter = true;
    } catch { /* HTML5-audio fallback or API shape changed — skip the limiter */ }
  }

  /** Cancel pending gap timers and stop all audio. Idempotent. */
  dispose(): void {
    for (const t of this.seqTimers) clearTimeout(t);
    this.seqTimers.clear();
    try { this.stopAll(); } catch { /* scene already torn down */ }
  }

  private keyFor(asset: SoundAssetRuntime): string {
    return `sound:${asset.id}`;
  }

  private resolve(name: string): SoundAssetRuntime | undefined {
    const a = this.byName.get(name);
    if (!a) {
      console.warn(`[SoundManager] no sound named "${name}". Known: [${[...this.byName.keys()].join(", ") || "(none)"}]`);
      return undefined;
    }
    if (!this.scene.cache.audio.exists(this.keyFor(a))) {
      console.warn(`[SoundManager] sound "${name}" has no decoded audio (key ${this.keyFor(a)} missing). Was it preloaded?`);
      return undefined;
    }
    return a;
  }

  // ── Music ────────────────────────────────────────────────────────────
  playMusic(name: string, opts: PlayOpts & { fadeSec?: number } = {}): void {
    const asset = this.resolve(name);
    if (!asset) return;
    const baseVol = opts.volume ?? asset.volume;
    const loop = opts.loop ?? asset.loop ?? true;

    // Replaying the same track that's already going is a no-op — avoids a
    // restart-stutter when an OnSceneStart fires twice or a layout reloads.
    if (this.music && this.musicName === name && this.music.isPlaying) {
      this.musicBaseVol = baseVol;
      (this.music as Phaser.Sound.BaseSound & { setVolume(v: number): void }).setVolume(baseVol * this.musicVol * this.masterVol);
      return;
    }

    this.stopMusic(opts.fadeSec);
    const snd = this.scene.sound.add(this.keyFor(asset), {
      loop,
      volume: baseVol * this.musicVol * this.masterVol,
    });
    snd.play();
    this.music = snd;
    this.musicName = name;
    this.musicBaseVol = baseVol;

    if (opts.fadeSec && opts.fadeSec > 0) {
      const target = baseVol * this.musicVol * this.masterVol;
      (snd as Phaser.Sound.BaseSound & { setVolume(v: number): void }).setVolume(0);
      this.scene.tweens.add({ targets: snd, volume: target, duration: opts.fadeSec * 1000 });
    }
  }

  stopMusic(fadeSec?: number): void {
    const cur = this.music;
    if (!cur) return;
    this.music = null;
    this.musicName = "";
    if (fadeSec && fadeSec > 0) {
      this.scene.tweens.add({
        targets: cur, volume: 0, duration: fadeSec * 1000,
        onComplete: () => { try { cur.stop(); cur.destroy(); } catch { /* freed */ } },
      });
    } else {
      try { cur.stop(); cur.destroy(); } catch { /* freed */ }
    }
  }

  // ── SFX ──────────────────────────────────────────────────────────────
  playSfx(name: string, opts: PlayOpts = {}): Phaser.Sound.BaseSound | undefined {
    const asset = this.resolve(name);
    if (!asset) return undefined;
    // Retrigger throttle — drop replays within minIntervalMs of the last one,
    // so 10 enemies hit on the same frame don't stack 10 identical copies.
    const minMs = asset.minIntervalMs ?? 0;
    if (minMs > 0) {
      const nowMs = this.scene.time.now;
      const last = this.lastPlayMs.get(name) ?? -Infinity;
      if (nowMs - last < minMs) return undefined;
      this.lastPlayMs.set(name, nowMs);
    }
    const list = this.sfx.get(name) ?? [];
    // Voice cap — steal the OLDEST live copy when at the limit so the summed
    // amplitude (and the "machine-gun" phasing) stays bounded.
    const cap = Math.floor(asset.maxInstances ?? 0);
    if (cap > 0) {
      while (list.length >= cap) {
        const oldest = list[0];
        try { oldest.stop(); } catch { /* freed */ } // 'stop' handler reaps it from `list`
        if (this.sfx.get(name) === list && list[0] === oldest) list.shift(); // defensive
      }
    }
    const baseVol = opts.volume ?? asset.volume;
    const loop = opts.loop ?? asset.loop ?? false;
    const cfg: Phaser.Types.Sound.SoundConfig = {
      loop,
      volume: baseVol * this.sfxVol * this.masterVol,
    };
    if (opts.rate !== undefined) cfg.rate = opts.rate;
    const snd = this.scene.sound.add(this.keyFor(asset), cfg);
    // Track for stopSound + cleanup. One-shots self-evict on complete so the
    // list doesn't grow unbounded in a long session.
    list.push(snd);
    this.sfx.set(name, list);
    snd.once("complete", () => this.reap(name, snd));
    snd.once("stop", () => this.reap(name, snd));
    snd.play();
    return snd;
  }

  // ── Multi-sound player (PlaySounds action) ────────────────────────────
  // Plays from a list with per-play volume + pitch randomization. All entries
  // play as one-shot SFX (overlap-friendly), regardless of authored kind:
  //   • playMode "all"                  → every entry at once (simultaneous).
  //   • playInSequence false, "random"  → one random entry.
  //   • playInSequence false, "queue"   → one entry, stepping 1→2→3 per call.
  //   • playInSequence true,  "random"  → ALL, shuffled, one after another.
  //   • playInSequence true,  "queue"   → ALL, in order, one after another.
  // Sequence playback inserts `gapSec` REAL-TIME seconds between sounds.
  playMulti(names: string[], opts: MultiPlayOpts): void {
    const list = names.filter((n) => n && this.byName.has(n));
    if (list.length === 0) return;
    const rng = (a: number, b: number) => (a === b ? a : a + Math.random() * (b - a));
    const playOne = (name: string) =>
      this.playSfx(name, {
        volume: rng(opts.volumeMin, opts.volumeMax),
        rate: rng(opts.pitchMin, opts.pitchMax),
        loop: false,
      });

    // "all" → fire every entry, ignoring the sequence toggle. gap = 0 plays
    // them simultaneously; gap > 0 STAGGERS the starts (sound i begins
    // i*gap real-time seconds in) so they overlap on a fixed offset, rather
    // than waiting for each to finish like queue/sequence does.
    if (opts.playMode === "all") {
      if (opts.gapSec > 0) {
        list.forEach((name, idx) => {
          if (idx === 0) { playOne(name); return; }
          const t = setTimeout(() => {
            this.seqTimers.delete(t);
            if (this.isAlive()) playOne(name);
          }, idx * opts.gapSec * 1000);
          this.seqTimers.add(t);
        });
      } else {
        for (const n of list) playOne(n);
      }
      return;
    }

    if (!opts.playInSequence) {
      // Play exactly ONE.
      if (opts.playMode === "queue") {
        const key = opts.cursorKey ?? "";
        const idx = (this.cursors.get(key) ?? 0) % list.length;
        this.cursors.set(key, idx + 1);
        playOne(list[idx]);
      } else {
        playOne(list[Math.floor(Math.random() * list.length)]);
      }
      return;
    }

    // Sequence: play ALL one-after-another (shuffled for random, in order for
    // queue), with a real-time gap between each.
    const ordered = opts.playMode === "random" ? this.shuffle(list) : list.slice();
    let i = 0;
    const step = () => {
      if (i >= ordered.length || !this.isAlive()) return;
      const snd = playOne(ordered[i++]);
      const advance = () => {
        if (i >= ordered.length) return;
        if (opts.gapSec > 0) {
          const t = setTimeout(() => {
            this.seqTimers.delete(t);
            if (this.isAlive()) step();
          }, opts.gapSec * 1000);
          this.seqTimers.add(t);
        } else {
          step();
        }
      };
      if (snd) snd.once("complete", advance);
      else advance(); // entry failed to resolve — skip to the next
    };
    step();
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  private isAlive(): boolean {
    try { return !!this.scene && this.scene.sys.isActive(); } catch { return false; }
  }

  private reap(name: string, snd: Phaser.Sound.BaseSound): void {
    const list = this.sfx.get(name);
    if (!list) return;
    const i = list.indexOf(snd);
    if (i >= 0) list.splice(i, 1);
    try { snd.destroy(); } catch { /* freed */ }
    if (list.length === 0) this.sfx.delete(name);
  }

  /** Stop a named SFX (all its instances). Empty name = stop ALL sfx. */
  stopSfx(name?: string): void {
    if (name) {
      const list = this.sfx.get(name);
      if (!list) return;
      for (const s of [...list]) { try { s.stop(); } catch { /* freed */ } }
      this.sfx.delete(name);
      return;
    }
    // Stop-all also cancels any pending sequence gap timers so a
    // half-played PlaySounds sequence doesn't resume after a stopAll.
    for (const t of this.seqTimers) clearTimeout(t);
    this.seqTimers.clear();
    for (const [, list] of this.sfx) {
      for (const s of [...list]) { try { s.stop(); } catch { /* freed */ } }
    }
    this.sfx.clear();
  }

  /** Stop music AND all sfx — e.g. on scene transition / game over. */
  stopAll(): void {
    this.stopMusic();
    this.stopSfx();
  }

  // ── Volume buses ─────────────────────────────────────────────────────
  private clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

  setMasterVolume(v: number): void {
    this.masterVol = this.clamp01(v);
    this.reapplyMusicVolume();
  }
  setMusicVolume(v: number): void {
    this.musicVol = this.clamp01(v);
    this.reapplyMusicVolume();
  }
  setSfxVolume(v: number): void {
    this.sfxVol = this.clamp01(v);
    // Live-update currently-playing sfx so a volume change is heard
    // immediately on sustained / looping sfx (not just future plays).
    for (const [, list] of this.sfx) {
      for (const s of list) {
        (s as Phaser.Sound.BaseSound & { setVolume?: (n: number) => void }).setVolume?.(this.sfxVol * this.masterVol);
      }
    }
  }
  private reapplyMusicVolume(): void {
    if (this.music) {
      (this.music as Phaser.Sound.BaseSound & { setVolume?: (n: number) => void })
        .setVolume?.(this.musicBaseVol * this.musicVol * this.masterVol);
    }
  }

  // ── Queries ──────────────────────────────────────────────────────────
  /** True if music is playing. With `name`, only when THAT track is playing. */
  isMusicPlaying(name?: string): boolean {
    if (!this.music || !this.music.isPlaying) return false;
    return name ? this.musicName === name : true;
  }
  /** True if any live instance of the named SFX is playing. */
  isSfxPlaying(name: string): boolean {
    const list = this.sfx.get(name);
    return !!list && list.some((s) => s.isPlaying);
  }
}
