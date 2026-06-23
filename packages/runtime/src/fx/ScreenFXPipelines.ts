import Phaser from "phaser";

/**
 * Custom WebGL post-FX shader pipelines for the `SetScreenEffect` action.
 *
 * Phaser ships built-in postFX for blur and ColorMatrix (grayscale), but NOT
 * VHS or chromatic aberration — those need custom GLSL. Each pipeline reads a
 * single `uIntensity` (0..1) uniform set per-frame from its public `intensity`
 * field (assigned by `applyScreenFX` in eval.ts). VHS also animates via uTime.
 *
 * Registered at boot in Game.ts (`MainScene.create`) via
 * `game.renderer.pipelines.addPostPipeline(name, Class)`, then attached to the
 * main camera with `cam.setPostPipeline(Class)`. WebGL only — guarded at the
 * call sites.
 */

const CHROMATIC_FRAG = `
precision mediump float;
uniform sampler2D uMainSampler;
uniform float uIntensity;
varying vec2 outTexCoord;

void main(void) {
  vec2 uv = outTexCoord;
  // Radial split — offset grows toward the screen edges (dir from center).
  vec2 dir = uv - vec2(0.5);
  float amt = uIntensity * 0.02; // up to ~2% of the frame at intensity 1
  vec2 off = dir * amt;
  float r = texture2D(uMainSampler, uv + off).r;
  float g = texture2D(uMainSampler, uv).g;
  float b = texture2D(uMainSampler, uv - off).b;
  float a = texture2D(uMainSampler, uv).a;
  gl_FragColor = vec4(r, g, b, a);
}
`;

const VHS_FRAG = `
precision mediump float;
uniform sampler2D uMainSampler;
uniform float uIntensity;
uniform float uTime;
varying vec2 outTexCoord;

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
  vec2 uv = outTexCoord;
  float it = uIntensity;
  // Per-scanline horizontal wobble, animated.
  uv.x += sin(uv.y * 80.0 + uTime * 5.0) * 0.0015 * it;
  // Chroma shift.
  float shift = 0.003 * it;
  float r = texture2D(uMainSampler, uv + vec2(shift, 0.0)).r;
  float g = texture2D(uMainSampler, uv).g;
  float b = texture2D(uMainSampler, uv - vec2(shift, 0.0)).b;
  vec3 col = vec3(r, g, b);
  float a = texture2D(uMainSampler, uv).a;
  // Scanlines + grain ADD to every pixel, including the transparent area of a
  // per-object render target — which bleeds full-screen in layer mode. Gate
  // them by the source alpha so they only touch opaque pixels. On the camera
  // a=1 everywhere, so screen mode is unchanged.
  float scan = sin(uv.y * 800.0) * 0.06 * it;
  float n = rand(uv + fract(uTime)) * 0.12 * it;
  col += (-scan + n - 0.06 * it) * a;
  gl_FragColor = vec4(col, a);
}
`;

export class ChromaticAberrationPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** 0..1 — set per-camera by applyScreenFX before each frame. */
  intensity = 0;

  constructor(game: Phaser.Game) {
    super({ game, name: "peakyChromatic", fragShader: CHROMATIC_FRAG });
  }

  onPreRender(): void {
    this.set1f("uIntensity", this.intensity);
  }
}

const GRAIN_FRAG = `
precision mediump float;
uniform sampler2D uMainSampler;
uniform float uIntensity;
uniform float uTime;
varying vec2 outTexCoord;

float rand(vec2 co) {
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
  vec2 uv = outTexCoord;
  vec4 col = texture2D(uMainSampler, uv);
  // Grain ADDS to every pixel — including the transparent area of a per-object
  // render target, which bleeds full-screen in layer mode. Gate by the source
  // alpha so it only touches opaque pixels. a=1 on the camera, so screen mode
  // is unchanged.
  float n = rand(uv + fract(uTime)) - 0.5;
  col.rgb += n * uIntensity * 0.25 * col.a;
  gl_FragColor = col;
}
`;

export class FilmGrainPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** 0..1 — set per-camera by applyScreenFX before each frame. */
  intensity = 0;

  constructor(game: Phaser.Game) {
    super({ game, name: "peakyGrain", fragShader: GRAIN_FRAG });
  }

  onPreRender(): void {
    this.set1f("uIntensity", this.intensity);
    this.set1f("uTime", this.game.loop.time / 1000);
  }
}

export class VHSPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** 0..1 — set per-camera by applyScreenFX before each frame. */
  intensity = 0;

  constructor(game: Phaser.Game) {
    super({ game, name: "peakyVHS", fragShader: VHS_FRAG });
  }

  onPreRender(): void {
    this.set1f("uIntensity", this.intensity);
    this.set1f("uTime", this.game.loop.time / 1000);
  }
}

export const PEAKY_VHS_PIPELINE = "peakyVHS";
export const PEAKY_CHROMATIC_PIPELINE = "peakyChromatic";
