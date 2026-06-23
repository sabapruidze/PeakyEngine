import { BehaviorKind } from "./project";

/**
 * Per-behavior parameter metadata. Drives:
 *  - The Components section of the BP Details panel (renders fields)
 *  - The Get/Set Behavior Param node dropdowns
 *  - The runtime Set/Get implementations (key validity check)
 *
 * Adding a new behavior parameter = one entry here.
 */

export interface BehaviorParamMeta {
  key: string;
  label: string;
  /** Default value at attach time. String for opaque text fields, number
   *  otherwise, string[] for `tagList`. */
  default: number | string | string[];
  /**
   * Input type rendered by the editor.
   * - "number" (default) → numeric field, runtime treats as number
   * - "bool" → checkbox; runtime stores 0/1 so behavior fields stay
   *   `number` and existing truthy checks (`if (this.followX)`) keep working
   * - "string" → free text (or dropdown if `options` is set)
   * - "spriteRef" → dropdown of project sprites (value = sprite id)
   * - "spriteAnim" → dropdown of the chosen sprite's animations (value = animation name)
   * - "inputAction" → dropdown of the project's Input Actions (value = action name)
   * - "font" → font-family picker (uploaded custom fonts + web-safe families)
   */
  type?: "number" | "bool" | "string" | "spriteRef" | "spriteAnim" | "varRef" | "varRefNumber" | "widgetRef" | "inputAction" | "font" | "sceneLayerList" | "signal" | "tagList";
  /**
   * Optional fixed list of choices — when present and `type === "string"`,
   * the Components panel renders a dropdown instead of a text input. Used
   * for enum-style params like Collider's `shape`.
   */
  options?: { value: string; label: string }[];
  /**
   * Conditional visibility: only render this field when the named other
   * field's current value matches `value`. Used for sub-fields that
   * should appear / disappear based on a parent toggle (e.g. directional
   * offsets only show when the directional-offset toggle is on).
   */
  dependsOn?: { key: string; value: number | string };
  /** When true, a note is shown under this field in the inspector IF the BP
   *  also has an AIBrain — because the brain writes this value every tick
   *  (its Chase / Patrol Speed), so editing it here has no effect on an AI NPC. */
  aiOverridden?: boolean;
}

export const BEHAVIOR_PARAMS: Record<BehaviorKind, BehaviorParamMeta[]> = {
  // CharacterMovement is rendered with a custom UI — see ComponentDetails
  // branch on `kind === "CharacterMovement"`. The flat param list here is only
  // used by Get/Set BehaviorParam lookups + numeric reads.
  CharacterMovement: [
    { key: "maxSpeed",          label: "Max Speed",           default: 220 },
    { key: "acceleration",      label: "Acceleration",        default: 1500 },
    { key: "deceleration",      label: "Deceleration",        default: 1500 },
    { key: "airControl",        label: "Air Control",         default: 1.0 },
    { key: "gravity",           label: "Gravity",             default: 800 },
    { key: "gravityAngle",      label: "Gravity Angle (deg)", default: 90 },
    { key: "maxFallSpeed",      label: "Max Fall Speed",      default: 600 },
    { key: "ceilingMode",       label: "Ceiling Mode",        default: 0 },
    { key: "mirrorMode",        label: "Mirror Mode",         default: 0 },
    { key: "scaleMirror",       label: "Smooth Mirror",       default: 0, type: "bool" },
    { key: "scaleMirrorTime",   label: "Smooth Mirror Time (s)", default: 0.15 },
    { key: "leftAction",        label: "Move-Left Action",    default: "MoveLeft",  type: "string" },
    { key: "leftEventTrigger",  label: "Move-Left Event Trigger", default: "",      type: "string" },
    { key: "leftCustomFn",      label: "Move-Left Custom Fn", default: "",          type: "string" },
    { key: "rightAction",       label: "Move-Right Action",   default: "MoveRight", type: "string" },
    { key: "rightEventTrigger", label: "Move-Right Event Trigger",default: "",      type: "string" },
    { key: "rightCustomFn",     label: "Move-Right Custom Fn",default: "",          type: "string" },
    { key: "jumpAction",        label: "Jump Action",         default: "Jump",      type: "string" },
    { key: "jumpEventTrigger",  label: "Jump Event Trigger",  default: "",          type: "string" },
    { key: "jumpCustomFn",      label: "Jump Custom Fn",      default: "",          type: "string" },
    { key: "jumpStrength",      label: "Jump Strength",       default: 460 },
    { key: "multiJump",         label: "Multi-Jump",          default: 1 },
    { key: "coyoteEnabled",     label: "Coyote Enabled",      default: 1 },
    { key: "coyoteTime",        label: "Coyote Time (s)",     default: 0.1 },
    { key: "bufferEnabled",     label: "Buffer Enabled",      default: 1 },
    { key: "bufferTime",        label: "Buffer Time (s)",     default: 0.1 },
    { key: "varHeightEnabled",  label: "Var-Height Enabled",  default: 0 },
    { key: "varHeightCutoff",   label: "Var-Height Cutoff",   default: -150 },
    { key: "jumpSustainEnabled",label: "Jump Sustain Enabled",default: 0 },
    { key: "jumpSustainTime",   label: "Jump Sustain Time (s)",default: 0.18 },
    { key: "dashEnabled",       label: "Dash Enabled",        default: 0 },
    { key: "dashAction",        label: "Dash Action",         default: "Dash", type: "string" },
    { key: "dashEventTrigger",  label: "Dash Event Trigger",  default: "",     type: "string" },
    { key: "dashCustomFn",      label: "Dash Custom Fn",      default: "",     type: "string" },
    { key: "dashSpeed",         label: "Dash Speed",          default: 600 },
    { key: "dashStartDelay",    label: "Dash Start Delay (s)", default: 0 },
    { key: "dashDuration",      label: "Dash Duration (s)",   default: 0.15 },
    { key: "dashCooldown",      label: "Dash Cooldown (s)",   default: 1.0 },
    { key: "dashWallBlock",     label: "Dash: Block Walls",   default: 1, type: "bool" },
    // Wall settings — the inspector card writes these but the param
    // map was missing them, so SetBehaviorParam couldn't reach them and
    // newly-attached CMs silently ran without wall config in their
    // serialized form. Mirrors `CHARACTER_MOVEMENT_PARAMS` in shared.
    { key: "wallEnabled",        label: "Wall Enabled",       default: 0, type: "bool" },
    { key: "wallJumpAllowed",    label: "Wall Jump Allowed",  default: 1, type: "bool" },
    { key: "wallJumpStrength",   label: "Wall Jump Y",        default: 460 },
    { key: "wallJumpKickX",      label: "Wall Jump X",        default: 320 },
    { key: "wallSlideSpeed",     label: "Wall Slide Speed",   default: 100 },
    { key: "wallSlideRequiresInput", label: "Hold to Slide",  default: 1, type: "bool" },
    { key: "wallSlideOnContact", label: "Slide on Contact",   default: 0, type: "bool" },
    { key: "wallSlideCustomFn",  label: "Wall Slide Custom Fn", default: "", type: "string" },
    { key: "wallJumpCustomFn",   label: "Wall Jump Custom Fn",  default: "", type: "string" },
  ],
  // 8-directional, gravity-free movement for topdown/flying. Generic inspector
  // (no custom card). Don't combine with CharacterMovement — use one or other.
  TopdownMovement: [
    { key: "maxSpeed",          label: "Max Speed",            default: 220, aiOverridden: true },
    { key: "acceleration",      label: "Acceleration",         default: 1500 },
    { key: "deceleration",      label: "Deceleration",         default: 1500 },
    { key: "upAction",          label: "Move-Up Action",       default: "MoveUp",    type: "inputAction" },
    { key: "upEventTrigger",    label: "Move-Up Event Trigger",default: "",          type: "string" },
    { key: "downAction",        label: "Move-Down Action",     default: "MoveDown",  type: "inputAction" },
    { key: "downEventTrigger",  label: "Move-Down Event Trigger",default: "",        type: "string" },
    { key: "leftAction",        label: "Move-Left Action",     default: "MoveLeft",  type: "inputAction" },
    { key: "leftEventTrigger",  label: "Move-Left Event Trigger",default: "",        type: "string" },
    { key: "rightAction",       label: "Move-Right Action",    default: "MoveRight", type: "inputAction" },
    { key: "rightEventTrigger", label: "Move-Right Event Trigger",default: "",       type: "string" },
    { key: "mirrorMode",        label: "Mirror Mode (0 off / 1 velocity / 2 input)", default: 0 },
    { key: "scaleMirror",       label: "Smooth Mirror",        default: 0, type: "bool" },
    { key: "scaleMirrorTime",   label: "Smooth Mirror Time (s)", default: 0.15 },
    // Lock player input — momentum coasts. Was writable via SetBehaviorParam
    // but invisible in the inspector. (audit MED #68, #87)
    { key: "ignoreInput",       label: "Ignore Input (lock)",  default: 0, type: "bool" },
    { key: "slideAssist",       label: "Slide Along Diagonals", default: 1, type: "bool" },
  ],
  Solid: [
    { key: "debugDraw", label: "Debug Draw (runtime)", default: 0, type: "bool" },
  ],
  JumpThru: [],
  SpriteRenderer: [
    { key: "spriteId",         label: "Sprite",     default: "", type: "spriteRef" },
    { key: "currentAnimation", label: "Animation",  default: "", type: "spriteAnim" },
    { key: "playing",          label: "Playing",    default: 1, type: "bool" },
    { key: "speed",            label: "Speed",      default: 1.0 },
    { key: "frame",            label: "Frame", default: 0 },
    { key: "useFrameCollider", label: "Use Frame Collider", default: 0, type: "bool" },
    { key: "solid",            label: "Solid (blocks)", default: 1, type: "bool",
      dependsOn: { key: "useFrameCollider", value: 1 } },
    { key: "collideFilterMode", label: "Collide Filter", default: "include", type: "string",
      options: [{ value: "include", label: "Include only these tags" }, { value: "exclude", label: "Exclude these tags" }],
      dependsOn: { key: "useFrameCollider", value: 1 } },
    { key: "collideFilterTags", label: "Filter Tags", default: [], type: "tagList",
      dependsOn: { key: "useFrameCollider", value: 1 } },
  ],
  Collider: [
    { key: "width",              label: "Width",              default: 32 },
    { key: "height",             label: "Height",             default: 48 },
    { key: "offsetX",            label: "Offset X",           default: 0 },
    { key: "offsetY",            label: "Offset Y",           default: 0 },
    { key: "collideWorldBounds", label: "World Bounds",       default: 1, type: "bool" },
    { key: "passThrough",        label: "Pass Through",       default: 1, type: "bool" },
    { key: "debugDraw",          label: "Debug Draw (runtime)", default: 0, type: "bool" },
  ],
  Text: [
    { key: "name",        label: "Name",                 default: "", type: "string" },
    { key: "content",     label: "Text",                 default: "Hello", type: "string" },
    { key: "fontFamily",  label: "Font Family",          default: "Arial", type: "font" },
    { key: "fontSize",    label: "Font Size (px)",       default: 16 },
    { key: "color",       label: "Color (0xRRGGBB)",     default: 0xffffff },
    { key: "bold",        label: "Bold",                 default: 0, type: "bool" },
    { key: "italic",      label: "Italic",               default: 0, type: "bool" },
    { key: "align",       label: "Horizontal Align",     default: "left",  type: "string",
      options: [
        { value: "left",   label: "Left" },
        { value: "center", label: "Center" },
        { value: "right",  label: "Right" },
      ] },
    { key: "vAlign",      label: "Vertical Align",       default: "top",   type: "string",
      options: [
        { value: "top",    label: "Top" },
        { value: "middle", label: "Middle" },
        { value: "bottom", label: "Bottom" },
      ] },
    { key: "wrapWidth",   label: "Wrap Width (0=off)",   default: 0 },
    { key: "visible",     label: "Visible",              default: 1, type: "bool" },
    { key: "alpha",       label: "Alpha (0..1)",         default: 1 },
    { key: "offsetX",     label: "Offset X (px)",        default: 0 },
    { key: "offsetY",     label: "Offset Y (px)",        default: 0 },
  ],
  Tracer: [
    { key: "name",         label: "Name (for tracer:<name>.…)",  default: "",     type: "string" },
    { key: "shape",        label: "Shape",                       default: "line", type: "string",
      options: [
        { value: "line", label: "Line" },
        { value: "box",  label: "Box" },
      ] },
    { key: "distance",     label: "Distance (px)",               default: 100 },
    { key: "angle",        label: "Angle (deg, 0=forward)",      default: 0 },
    { key: "pivotSource",  label: "Pivot Source",                default: "manual", type: "string",
      options: [
        { value: "manual",     label: "Manual (sprite center + offset)" },
        { value: "framePivot", label: "Sprite Frame Pivot (hotspot)" },
        { value: "imagePoint", label: "Named Image Point (body sprite)" },
        { value: "weaponSlot", label: "Weapon Slot Image Point (weapon sprite)" },
      ] },
    { key: "imagePointName", label: "Image Point Name",          default: "", type: "string",
      dependsOn: { key: "pivotSource", value: "imagePoint" } },
    { key: "imagePointName", label: "Weapon Image Point",         default: "", type: "string",
      dependsOn: { key: "pivotSource", value: "weaponSlot" } },
    { key: "weaponSlotName", label: "Weapon Slot Name (empty = first)", default: "", type: "string",
      dependsOn: { key: "pivotSource", value: "weaponSlot" } },
    { key: "pivotX",       label: "Pivot X Offset (px, mirrors)", default: 0 },
    { key: "pivotY",       label: "Pivot Y Offset (px)",         default: 0 },
    { key: "boxThickness", label: "Box Thickness (px)",          default: 16,
      dependsOn: { key: "shape", value: "box" } },
    { key: "tagFilter",    label: "Tag Filter (csv, empty=any · AIBrain's Target Tag overrides this if it's the brain's sight tracer)", default: "",     type: "string" },
    { key: "damage",       label: "Damage (0 = off)",            default: 0 },
    { key: "multiHit",     label: "Hit All In Range (cleave)",   default: 0, type: "bool" },
    { key: "knockbackX",   label: "Knockback X (fwd-relative)",  default: 0 },
    { key: "knockbackY",   label: "Knockback Y",                 default: 0 },
    { key: "triggerMode",  label: "Trigger Mode",                default: "interval", type: "string",
      options: [
        { value: "interval", label: "Interval (timer / every frame)" },
        { value: "signal",   label: "On Signal" },
      ] },
    { key: "intervalSec",  label: "Interval (s, 0=every frame)", default: 0,
      dependsOn: { key: "triggerMode", value: "interval" } },
    { key: "triggerSignal", label: "Trigger Signal",             default: "", type: "string",
      dependsOn: { key: "triggerMode", value: "signal" } },
    { key: "signalCount",   label: "Shots Per Signal",           default: 1,
      dependsOn: { key: "triggerMode", value: "signal" } },
    { key: "signalLoop",    label: "Loop After Burst",           default: 0, type: "bool",
      dependsOn: { key: "triggerMode", value: "signal" } },
    { key: "signalLifetimeSec", label: "Hit Lifetime (s, 0=forever)", default: 0,
      dependsOn: { key: "triggerMode", value: "signal" } },
    // Animation-frame gating — surfaced so authors can configure
    // "fire only on attack anim, frame 4" at attach time instead of
    // having to wire SetBehaviorParam. (audit HIGH #9)
    { key: "fireAnim",     label: "Gate: Animation Name (empty=any)", default: "", type: "string" },
    { key: "fireFrame",    label: "Gate: Frame Index (-1=any)",       default: -1 },
    { key: "debugDraw",    label: "Debug Draw",                  default: 0, type: "bool" },
  ],
  Camera: [
    { key: "targetMode",  label: "Target Mode",          default: "self", type: "string",
      options: [
        { value: "self", label: "Follow Self (host BP)" },
        { value: "tag",  label: "Follow Tag" },
      ] },
    { key: "targetTag",   label: "Target Tag",           default: "", type: "string" },
    { key: "smoothing",   label: "Smoothing (0..1)",     default: 0.5 },
    { key: "followX",     label: "Follow X",             default: 1, type: "bool" },
    { key: "followY",     label: "Follow Y",             default: 1, type: "bool" },
    { key: "offsetLeftX",  label: "Offset X — Facing Left",  default: 0 },
    { key: "offsetRightX", label: "Offset X — Facing Right", default: 0 },
    { key: "offsetY",      label: "Offset Y (px)",            default: 0 },
    { key: "offsetSmoothing", label: "Offset Smoothing (0..1)", default: 0 },
    { key: "deadzoneX",   label: "Deadzone X (px)",      default: 0 },
    { key: "deadzoneY",   label: "Deadzone Y (px)",      default: 0 },
    { key: "zoom",        label: "Zoom (1=native)",      default: 1 },
    { key: "bounded",     label: "Clamp To Layout",      default: 1, type: "bool" },
    { key: "locked",      label: "Locked",               default: 0, type: "bool" },
  ],
  SquashStretch: [
    { key: "intensity", label: "Intensity (0..1)", default: 0.3 },
    { key: "duration",  label: "Duration (s)",     default: 0.3 },
    { key: "easing",    label: "Easing",           default: "Quad.Out", type: "string",
      options: [
        { value: "Linear",      label: "Linear" },
        { value: "Quad.Out",    label: "Quad Out (default)" },
        { value: "Quad.InOut",  label: "Quad InOut" },
        { value: "Cubic.Out",   label: "Cubic Out" },
        { value: "Sine.InOut",  label: "Sine InOut" },
        { value: "Back.Out",    label: "Back Out (overshoot)" },
        { value: "Bounce.Out",  label: "Bounce Out" },
        { value: "Elastic.Out", label: "Elastic Out" },
      ] },
    { key: "emitOnEnd", label: "Emit OnSquashStretchEnd",  default: 0, type: "bool" },
  ],
  // UIWidgetRenderer is attached automatically at UI-widget spawn time;
  // its config is built from the widget's flat fields. Empty params
  // metadata since users author UI widgets through the dedicated
  // UIWidgetTab panel, not by attaching the behavior to a BP.
  UIWidgetRenderer: [],
  // Widget — BP-attachable UI widget. Picks a UIWidgetDef and renders it
  // in world space pinned to the host sprite (per-NPC healthbars, name
  // labels, etc.). Bindings on the widget can read `var:self.<x>` to
  // resolve against the HOST's variables — each placed instance shows
  // its own values automatically.
  Widget: [
    { key: "widgetId",     label: "Widget",            default: "", type: "widgetRef" },
    { key: "linkedVar",    label: "Link Value Var",    default: "", type: "varRef" },
    { key: "offsetX",      label: "Offset X (px)",     default: 0 },
    { key: "offsetY",      label: "Offset Y (px)",     default: -40 },
    { key: "hideWhenDead", label: "Hide When Dead",    default: 1, type: "bool" },
  ],
  // Animator has a structural config (list of named keyframe animations
  // with per-animation target + keyframes). Standard field list can't
  // represent that — the inspector renders a custom card for kind ===
  // "SmartTween" (see BlueprintInspector). Keep this empty so the generic
  // renderer doesn't accidentally show fields.
  SmartTween: [],
  Projectile: [
    { key: "mode",             label: "Mode", default: "straight", type: "string", options: [
      { value: "straight", label: "Straight-line" },
      { value: "homing", label: "Homing" },
    ]},
    { key: "speed",            label: "Speed (px/s)",        default: 600 },
    { key: "lifetime",         label: "Lifetime (s, 0=∞)",   default: 3 },
    { key: "gravityX",         label: "Gravity X",           default: 0 },
    { key: "gravityY",         label: "Gravity Y",           default: 0 },
    { key: "targetTags",       label: "Target Tags",         default: "", type: "string" },
    { key: "hitSignal",        label: "Hit Signal",          default: "", type: "string" },
    { key: "destroyOnHit",     label: "Destroy On Hit",      default: 1, type: "bool" },
    { key: "collideTiles",     label: "Collide With Tiles",  default: 0, type: "bool" },
    { key: "tileHitSignal",    label: "Tile Hit Signal",     default: "", type: "signal", dependsOn: { key: "collideTiles", value: 1 } },
    { key: "rotateToVelocity", label: "Rotate To Velocity",  default: 1, type: "bool" },
    { key: "damage",           label: "Damage (0 = off)",    default: 0 },
    { key: "knockbackX",       label: "Knockback X",         default: 0 },
    { key: "knockbackY",       label: "Knockback Y",         default: 0 },
    { key: "hitboxW",          label: "Hitbox W (0 = body)", default: 0 },
    { key: "hitboxH",          label: "Hitbox H (0 = body)", default: 0 },
    { key: "hitboxOffsetX",    label: "Hitbox Offset X",     default: 0 },
    { key: "hitboxOffsetY",    label: "Hitbox Offset Y",     default: 0 },
    { key: "debugDraw",        label: "Debug Draw Hitbox",   default: 0, type: "bool" },
    { key: "homingTurnRate",   label: "Homing Turn Rate (deg/s)", default: 360, dependsOn: { key: "mode", value: "homing" } },
  ],
  Inventory: [
    // slots fill at runtime (via AddItem / drag-drop); only the capacity is
    // authored. Items are project assets — see the Content Browser.
    { key: "capacity", label: "Slots (capacity)", default: 20 },
    // Cross-scene identity. Give the PLAYER a key (e.g. "player") so its bag
    // carries between scenes + drives the HUD count globals. Leave EMPTY on
    // chests / NPCs / shops so each stays scene-local and independent.
    { key: "persistKey", label: "Persist Key (carry across scenes)", default: "", type: "string" },
  ],
  // TilemapRenderer is configured by the tilemap ASSET (not per-BP fields) —
  // it isn't user-attachable as a component. Empty schema keeps it out of
  // the BP inspector while still satisfying the Record<BehaviorKind, …> shape.
  TilemapRenderer: [],
  VisionMask: [
    { key: "radius",        label: "Radius (px)",                default: 80 },
    { key: "featherPx",     label: "Feather (px)",               default: 0 },
    { key: "cutoutOpacity", label: "Cutout Opacity (0=cut,1=off)", default: 0 },
    { key: "maskSpriteId",  label: "Mask Shape (sprite alpha)",  default: "", type: "spriteRef" },
    { key: "maskSpriteMode", label: "Mask Sprite Mode",          default: "static", type: "string",
      options: [{ value: "static", label: "Static (one frame)" }, { value: "animation", label: "Animation (cycle)" }] },
    { key: "maskAnimation", label: "Mask Animation",             default: "", type: "spriteAnim" },
    { key: "maskFrame",     label: "Mask Frame",                 default: 0, dependsOn: { key: "maskSpriteMode", value: "static" } },
    { key: "maskMirror",    label: "Mirror With Facing",         default: 0, type: "bool" },
    { key: "centerOffsetX", label: "Center Offset X",            default: 0 },
    { key: "centerOffsetY", label: "Center Offset Y",            default: 0 },
    { key: "cutoutLayers",  label: "Cutout Layers",              default: "", type: "sceneLayerList" },
    { key: "excludeTags",   label: "Exclude Tags (csv)",         default: "", type: "string" },
    { key: "invert",        label: "Invert (spotlight)",         default: 0, type: "bool" },
    // WRITABLE_PARAMS exposed `enabled` but the inspector row was missing.
    // (audit MED #80, #81)
    { key: "enabled",       label: "Enabled",                    default: 1, type: "bool" },
  ],
  ParticleEmitter: [
    // Wave 1 ships a flat list. Wave 4 will replace this with a section-
    // grouped layout (Emission / Lifetime / Movement / Visual) and the
    // preset dropdown described in the plan.
    { key: "name",            label: "Name (for targeting)", default: "",           type: "string" },
    { key: "mode",            label: "Mode",                 default: "continuous", type: "string",
      options: [
        { value: "continuous", label: "Continuous (rate)" },
        { value: "burst",      label: "Burst (action)" },
      ] },
    { key: "rate",            label: "Rate (per/sec)",       default: 10 },
    { key: "burstCount",      label: "Burst Count",          default: 30 },
    { key: "maxParticles",    label: "Max Particles",        default: 1000 },
    { key: "enabled",         label: "Emit On Start",        default: 1, type: "bool" },
    { key: "spriteId",        label: "Particle Sprite",      default: "", type: "spriteRef" },
    { key: "delay",           label: "Start Delay (s)",      default: 0 },
    { key: "pivotSource",     label: "Spawn From",           default: "host", type: "string",
      options: [
        { value: "host",        label: "Host (sprite center)" },
        { value: "imagePoint",  label: "Image Point (named)" },
      ] },
    { key: "imagePointName",  label: "Image Point Name",     default: "", type: "string" },
    { key: "spawnJitterX",    label: "Spawn X ± random (px)", default: 0 },
    { key: "spawnJitterY",    label: "Spawn Y ± random (px)", default: 0 },
    { key: "offsetX",         label: "Offset X (px from pivot)", default: 0 },
    { key: "offsetY",         label: "Offset Y (px from pivot)", default: 0 },
    { key: "renderOrder",     label: "Render Order", default: "front", type: "string", options: [
      { value: "front", label: "In Front of Sprite" },
      { value: "back",  label: "Behind Sprite" },
    ]},
    { key: "lifetime",        label: "Lifetime (s)",         default: 1 },
    { key: "lifetimeJitter",  label: "Lifetime ± random (s)", default: 0 },
    { key: "speed",           label: "Speed (px/s)",         default: 100 },
    { key: "speedJitter",     label: "Speed ± random (px/s)", default: 0 },
    { key: "angleMin",        label: "Angle Min (deg)",      default: -90 },
    { key: "angleMax",        label: "Angle Max (deg)",      default: -90 },
    { key: "gravityX",        label: "Gravity X",            default: 0 },
    { key: "gravityY",        label: "Gravity Y",            default: 0 },
    { key: "friction",        label: "Friction (0..1)",      default: 0 },
    { key: "rotationStart",   label: "Rotation Start (deg)", default: 0 },
    { key: "rotationEnd",     label: "Rotation End (deg)",   default: 0 },
    { key: "rotationJitter",  label: "Rotation ± random (deg)", default: 0 },
    { key: "scaleStart",      label: "Scale Start",          default: 1 },
    { key: "scaleEnd",        label: "Scale End",            default: 1 },
    { key: "alphaStart",      label: "Alpha Start (0..1)",   default: 1 },
    { key: "alphaEnd",        label: "Alpha End (0..1)",     default: 0 },
    { key: "tintStart",       label: "Tint Start (0xRRGGBB)",default: 0xffffff },
    { key: "tintEnd",         label: "Tint End (0xRRGGBB)",  default: 0xffffff },
    { key: "blendMode",       label: "Blend Mode",           default: "NORMAL", type: "string",
      options: [
        { value: "NORMAL",   label: "Normal" },
        { value: "ADD",      label: "Additive" },
        { value: "MULTIPLY", label: "Multiply" },
      ] },
    { key: "frameMode",       label: "Frame Mode",           default: "first", type: "string",
      options: [
        { value: "first",  label: "First frame" },
        { value: "random", label: "Random frame" },
      ] },
    { key: "frameIndices",    label: "Frame Indices (0-based csv)", default: "", type: "string" },
  ],
  Damageable: [
    // hp / maxHp values live on the BP variable — edit them in the
    // Variables section. The dropdowns below say WHICH variable owns
    // the value. Damageable mirrors the var on every change.
    { key: "hpVar",               label: "HP Variable",              default: "hp",    type: "varRefNumber" },
    { key: "maxHpVar",            label: "Max HP Variable",          default: "maxHp", type: "varRefNumber" },
    { key: "iframeSec",           label: "I-Frames (s)",             default: 0.5 },
    { key: "hitstunSec",          label: "Hitstun (s)",              default: 0.3 },
    { key: "knockbackMultiplier", label: "Knockback Multiplier",     default: 1 },
    { key: "destroyOnDeath",      label: "Destroy On Death",         default: 1, type: "bool" },
    { key: "deathDestroyDelay",   label: "Death → Destroy Delay (s)",default: 0.5 },
    { key: "allowHealing",        label: "Allow Healing",            default: 1, type: "bool" },
    { key: "attackable",          label: "Attackable (AI engages)",  default: 1, type: "bool" },
    { key: "blockStates",         label: "Block States (comma list, e.g. block,parry)", default: "", type: "string" },
    { key: "guardMultiplier",     label: "Guard Damage × (0 = full block)", default: 0 },
    { key: "guarding",            label: "Guarding (manual flag)",   default: 0, type: "bool" },
  ],
  // CharacterAnimator's config is a `states[]` array, not a flat field
  // list. Rendered by a dedicated table UI in CharacterOverview's
  // Animation Slots section — not via GenericComponentCard. Kept here
  // empty so the BEHAVIOR_PARAMS Record stays exhaustive for the
  // BehaviorKind union.
  // CharacterAnimator's settings now live at the top of the Animation
  // Slots section in the BP Overview (Debug HUD / Combo Window /
  // Input Buffer / Input Gates). Surfaced there because they're tightly
  // coupled with the state-machine authoring flow, and the chip view
  // duplicated them confusingly. Kept here as an empty list so the
  // BEHAVIOR_PARAMS record stays exhaustive on BehaviorKind.
  StateMachine: [],
  AIBrain: [
    { key: "autoBrain",         label: "Built-in brain on (off = drive via Logic Sheet)", default: 1, type: "bool" },
    { key: "state",             label: "State (initial)", default: "idle", type: "string", options: [
      { value: "idle", label: "AI_State_idle" }, { value: "alert", label: "AI_State_alert" },
      { value: "chase", label: "AI_State_chase" }, { value: "search", label: "AI_State_search" },
      { value: "attack", label: "AI_State_attack" }, { value: "flee", label: "AI_State_flee" },
    ] },
    { key: "targetTag",         label: "Target Tag", default: "player", type: "string" },
    { key: "sightTracerName",   label: "Sight Tracer Name", default: "sight", type: "string" },
    { key: "attackTracerName",  label: "Attack Tracer Name", default: "attack", type: "string" },
    { key: "attackRange",       label: "Attack Range", default: 40 },
    { key: "loseSightAfterSec", label: "Lose Sight After (s)", default: 2.5 },
    { key: "attackDurationSec", label: "Discrete Swings (>0 = one anim per swing + rest · 0 = continuous)", default: 0 },
    { key: "attackCooldownSec", label: "Attack Interval (s) — gap between swings", default: 0.8 },
    { key: "attackRestState", label: "Attack Rest State (between swings — drives the animator via IsAIState)", default: "alert", type: "string",
      options: [
        { value: "rest",   label: "Rest (dedicated — map a custom state via IsAIState = rest)" },
        { value: "idle",   label: "Idle" },
        { value: "alert",  label: "Alert" },
        { value: "chase",  label: "Chase (keep pressuring)" },
        { value: "search", label: "Search" },
        { value: "flee",   label: "Flee" },
      ] },
    { key: "interruptAttackOnHit", label: "Interrupt Attack On Hit (off = super armor)", default: 1, type: "bool" },
    { key: "chaseSpeed",        label: "Chase Speed", default: 100 },
    { key: "patrolSpeed",       label: "Patrol Speed", default: 40 },
    { key: "fleeOnDamage",      label: "Flee on Damage", default: 0, type: "bool" },
    { key: "fleeDurationSec",   label: "Flee Duration (s)", default: 3 },
    { key: "hearSignals",       label: "Hear Signals (comma-sep)", default: "", type: "string" },
    { key: "patrolMode",        label: "Patrol Mode", default: "none", type: "string", options: [
      { value: "none", label: "None (stand still)" },
      { value: "walls", label: "Bounce on walls" },
    ] },
    { key: "autoFaceTarget",    label: "Auto-Face Target", default: 1, type: "bool" },
    { key: "disableWhenDead",   label: "Disable When Dead (hp ≤ 0)", default: 1, type: "bool" },
    { key: "separationDist",    label: "Separation Distance (px, 0=off)", default: 0 },
    { key: "separationTag",     label: "Separation Tag", default: "enemy", type: "string" },
    { key: "separationMode",    label: "Separation Mode (applies when mover=MoveTo)", default: "push", type: "string", options: [
      { value: "off",      label: "Off (NPCs can fully overlap)" },
      { value: "velocity", label: "Velocity blend (smooth swerve)" },
      { value: "push",     label: "Push apart (hard min distance — Vampire Survivors style)" },
    ]},
    { key: "aiTickRate",        label: "AI Tick Rate (frames between thinks — 1=60Hz, 3=20Hz default, 6=10Hz)", default: 3 },
    { key: "mover",             label: "Movement Behavior", default: "auto", type: "string", options: [
      { value: "auto", label: "Auto (CharacterMovement → TopdownMovement)" },
      { value: "CharacterMovement", label: "CharacterMovement (platformer)" },
      { value: "TopdownMovement",   label: "TopdownMovement (4-way RPG)" },
      { value: "MoveTo",            label: "MoveTo (steering / chase / patrol)" },
    ]},
  ],
  PhaseManager: [
    { key: "thresholdsPct",         label: "HP Thresholds (% comma-sep — each adds a phase, e.g. 50 or 66,33)", default: "66,33", type: "string" },
    { key: "currentPhase",          label: "Current Phase (initial)", default: 0 },
    { key: "phaseVar",              label: "Mirror To Variable", default: "phase", type: "string" },
    { key: "invulnOnTransitionSec", label: "Invulnerability On Transition (s)", default: 0.6 },
  ],
  MoveTo: [
    { key: "mode", label: "Mode", default: "position", type: "string", options: [
      { value: "position", label: "Position (X, Y)" },
      { value: "object",   label: "Object (sprite uid)" },
      { value: "tag",      label: "Tag (nearest carrying)" },
      { value: "angle",    label: "Angle (straight line)" },
    ]},
    { key: "targetX",          label: "Target X (position mode)",  default: 0,    dependsOn: { key: "mode", value: "position" } },
    { key: "targetY",          label: "Target Y (position mode)",  default: 0,    dependsOn: { key: "mode", value: "position" } },
    { key: "targetUid",        label: "Target UID (object mode)",  default: -1,   dependsOn: { key: "mode", value: "object" } },
    { key: "targetTag",        label: "Target Tag (tag mode)",     default: "",   type: "string", dependsOn: { key: "mode", value: "tag" } },
    { key: "angleDeg",         label: "Angle (degrees, angle mode)", default: 0,  dependsOn: { key: "mode", value: "angle" } },
    { key: "speed",             label: "Speed (px/sec)",            default: 100, aiOverridden: true },
    { key: "stopRadius",        label: "Stop Radius (px)",          default: 4 },
    { key: "retargetEverySec",  label: "Re-target Every (sec, tag mode)", default: 0.5, dependsOn: { key: "mode", value: "tag" } },
    { key: "arrivalSignal",     label: "Arrival Signal (optional)", default: "", type: "string" },
    { key: "mirror",            label: "Mirror Facing (flip sprite to walk direction)", default: 1, type: "bool" },
    { key: "usePhysics",        label: "Use Physics Body (collides w/ walls)", default: 1, type: "bool" },
    { key: "enabled",           label: "Enabled",                   default: 1, type: "bool" },
    { key: "separationDist",    label: "Separation Distance (px, 0=off)", default: 0 },
    { key: "separationTag",     label: "Separation Tag (empty = host's first tag)", default: "", type: "string" },
    { key: "separationStrength",label: "Separation Strength (unused — kept for back-compat)", default: 0.6 },
    { key: "separationMode",    label: "Separation Mode", default: "push", type: "string", options: [
      { value: "off",      label: "Off (NPCs can fully overlap)" },
      { value: "velocity", label: "Velocity blend (smooth swerve)" },
      { value: "push",     label: "Push apart (hard min distance — Vampire Survivors style)" },
    ]},
    // Surface separationAvoid — runtime/WRITABLE_PARAMS expose it but the
    // inspector was missing the row. (audit HIGH #10, #30, #35)
    { key: "separationAvoid",   label: "Separation Avoid (queue vs slide)", default: 0, type: "bool" },
  ],
  TiledBackground: [
    { key: "spriteId",         label: "Sprite",                                  default: "", type: "spriteRef" },
    { key: "currentAnimation", label: "Animation",                                default: "", type: "spriteAnim" },
    { key: "playing",          label: "Playing (off = static frame)",             default: 1, type: "bool" },
    { key: "startFrame",       label: "Static Frame (when not playing)",          default: 0, dependsOn: { key: "playing", value: 0 } },
    { key: "mode",             label: "Mode",                                     default: "followCamera", type: "string", options: [
      { value: "followCamera", label: "Follow Camera (parallax)" },
      { value: "autoScroll",   label: "Auto Scroll (px/sec)" },
    ]},
    { key: "parallaxFactorX", label: "Parallax X (0 = locked to camera, 0.05 = far, 1 = world-locked)", default: 1, dependsOn: { key: "mode", value: "followCamera" } },
    { key: "parallaxFactorY", label: "Parallax Y (0 = locked to camera, 0.05 = far, 1 = world-locked)", default: 1, dependsOn: { key: "mode", value: "followCamera" } },
    { key: "scrollSpeedX",   label: "Scroll Speed X (px/sec)",                 default: 0,  dependsOn: { key: "mode", value: "autoScroll" } },
    { key: "scrollSpeedY",   label: "Scroll Speed Y (px/sec)",                 default: 0,  dependsOn: { key: "mode", value: "autoScroll" } },
    { key: "width",          label: "Width (px, 0 = fill viewport)",           default: 0 },
    { key: "height",         label: "Height (px, 0 = fill viewport)",          default: 0 },
    { key: "flipX",          label: "Flip Tile X",                             default: 0,  type: "bool" },
    { key: "flipY",          label: "Flip Tile Y",                             default: 0,  type: "bool" },
    { key: "tileX",          label: "Tile X (off = one copy only, no horizontal loop)", default: 1, type: "bool" },
    { key: "tileY",          label: "Tile Y (off = one copy only, no vertical loop — for horizon-band BGs)", default: 1, type: "bool" },
    { key: "enabled",        label: "Enabled",                                 default: 1,  type: "bool" },
  ],
  WeaponSlot: [
    { key: "name",         label: "Slot Name (e.g. RightHand — used by EquipWeapon / weapon:NAME.field)", default: "RightHand", type: "string" },
    { key: "spriteId",     label: "Weapon Sprite (empty = unequipped)",        default: "", type: "spriteRef" },
    { key: "currentAnimation", label: "Current Animation",                       default: "", type: "spriteAnim" },
    { key: "imagePoint",   label: "Host Image Point (anchor on the wielder)",   default: "", type: "string" },
    { key: "offsetX",      label: "Offset X (px, mirrors with facing)",         default: 0 },
    { key: "offsetY",      label: "Offset Y (px)",                              default: 0 },
    { key: "angleOffset",  label: "Angle Offset (deg)",                         default: 0 },
    { key: "scaleX",       label: "Scale X (1 = native sprite size)",           default: 1 },
    { key: "scaleY",       label: "Scale Y",                                    default: 1 },
    { key: "followFacing", label: "Follow Facing (mirror with host)",           default: 1, type: "bool" },
    { key: "renderAbove",  label: "Render Above Host",                          default: 1, type: "bool" },
    { key: "visible",      label: "Visible",                                    default: 1, type: "bool" },
    { key: "playing",      label: "Playing (advance animation frames)",         default: 1, type: "bool" },
    { key: "startFrame",   label: "Static Frame (when not playing)",            default: 0, dependsOn: { key: "playing", value: 0 } },
    { key: "speed",        label: "Playback Speed",                             default: 1 },
  ],
  Dismemberment: [
    // `regions` is an array-of-rects — rendered by a custom editor in the
    // BP inspector (GenericComponentCard), not the generic ParamField. It's
    // intentionally NOT listed here so the generic renderer doesn't try to
    // draw it as a text field. Everything below is scalar / enum.
    // Pose the regions are authored against + sliced from (fixed, independent
    // of the live animation). Empty anim = the SpriteRenderer's init pose.
    { key: "refAnimation", label: "Dismember Pose (anim)", default: "", type: "spriteAnim" },
    { key: "refFrame",     label: "Pose Frame",            default: 0 },
    { key: "launch",       label: "Launch",                default: "burst", type: "string", options: [
      { value: "burst",       label: "Burst (radial outward)" },
      { value: "drop",        label: "Drop (downward + spread)" },
      { value: "directional", label: "Directional (angle + spread)" },
      { value: "random",      label: "Random (chaotic)" },
    ]},
    { key: "angleDeg",     label: "Angle (deg, 270=up)",   default: 270, dependsOn: { key: "launch", value: "directional" } },
    { key: "spreadDeg",    label: "Spread (deg cone)",     default: 60 },
    { key: "speedMin",     label: "Speed Min (px/s)",      default: 120 },
    { key: "speedMax",     label: "Speed Max (px/s)",      default: 300 },
    { key: "spinMin",      label: "Spin Min (deg/s)",      default: -360 },
    { key: "spinMax",      label: "Spin Max (deg/s)",      default: 360 },
    { key: "gravity",      label: "Gravity (px/s²)",       default: 900 },
    { key: "bounce",       label: "Bounce (0..1)",         default: 0.3 },
    { key: "cleanup",      label: "Cleanup",               default: "time", type: "string", options: [
      { value: "time",      label: "Time (fade after lifetime)" },
      { value: "offscreen", label: "Offscreen (destroy when off-camera)" },
      { value: "pool",      label: "Pool (FIFO cap — oldest fade out)" },
    ]},
    { key: "lifetimeSec",  label: "Lifetime (s)",          default: 4, dependsOn: { key: "cleanup", value: "time" } },
    { key: "fadeSec",      label: "Fade (s)",              default: 0.5 },
    { key: "maxGibs",      label: "Max Gibs (pool cap)",   default: 50, dependsOn: { key: "cleanup", value: "pool" } },
    { key: "collideWorld", label: "Collide With World",    default: 1, type: "bool" },
    { key: "hideHost",     label: "Hide Host On Dismember", default: 1, type: "bool" },
    { key: "fireSignal",   label: "Auto-Fire On Signal",   default: "", type: "signal" },
  ],
};

/** Flat list of `Behavior.param` choices used by Get/Set Behavior Param dropdowns. */
export function flatBehaviorParamOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  (Object.keys(BEHAVIOR_PARAMS) as BehaviorKind[]).forEach((kind) => {
    for (const p of BEHAVIOR_PARAMS[kind]) {
      out.push({ value: `${kind}.${p.key}`, label: `${kind} · ${p.label}` });
    }
  });
  return out;
}
