import { BehaviorKind } from "../project";

/**
 * Beginner-friendly documentation for Blueprint components, shown in the
 * Documentation modal's Components tab. The PARAMETER ROWS are pulled live from
 * `BEHAVIOR_PARAMS` (behaviorMeta.ts) so the doc can never drift from the real
 * inspector fields — this file only supplies the plain-English prose. A param
 * with no entry in `params` falls back to its inspector label, so the tab still
 * renders every field even before its description is written.
 */
export interface ComponentDoc {
  /** Friendly display name (the BehaviorKind is shown as the code tag). */
  title: string;
  /** Section the component is grouped under in the docs. */
  group: string;
  /** One-liner: what this component IS, in plain words. */
  blurb: string;
  /** When you'd reach for it. */
  when?: string;
  /** key → plain-English "what this field does + an example". */
  params: Record<string, string>;
  /** Optional highlighted note. */
  tip?: string;
}

export const COMPONENT_GROUPS = [
  "Movement", "Visuals", "Physics", "Camera", "Combat & RPG", "AI", "UI", "Tilemap", "Misc",
] as const;

export const COMPONENT_DOCS: Partial<Record<BehaviorKind, ComponentDoc>> = {
  CharacterMovement: {
    title: "Character Movement",
    group: "Movement",
    blurb: "The full platformer controller — left/right running, gravity, jumping, dashing and wall-sliding, all driven by named Input Actions.",
    when: "Add it to a side-on player or platformer enemy. Don't combine it with Topdown Movement — pick one mover.",
    tip: "All these values can also be changed live during play with the CM Set… nodes.",
    params: {
      maxSpeed: "Top running speed in pixels/second. Higher = faster. 220 is a typical run.",
      acceleration: "How fast it speeds UP to max. High = snappy, low = a slippery start. 1500 ≈ responsive.",
      deceleration: "How fast it slows DOWN when you let go. High = stops on a dime, low = ice-skating.",
      airControl: "How much steering you have in mid-air (0..1). 1 = full control, 0 = committed jump with no air steering.",
      gravity: "How hard it's pulled down each second. Higher = heavier, falls faster. 800 ≈ normal.",
      gravityAngle: "Which way 'down' is, in degrees. 90 = straight down (normal). Change it for flipped / wall gravity.",
      maxFallSpeed: "Fastest it can fall (terminal velocity). Caps how fast gravity drags it. 600 keeps falls controllable.",
      ceilingMode: "What happens when it bonks a ceiling mid-jump. 0 = just stop rising (normal). Advanced.",
      mirrorMode: "Auto-flip the sprite to face the way it moves. 0 = off, 1 = flip by movement, 2 = flip by input.",
      scaleMirror: "When flipping to face the other way, smoothly turn instead of snapping instantly.",
      scaleMirrorTime: "How long that smooth flip takes, in seconds. 0.15 = a quick turn.",
      leftAction: "The named Input Action that moves left (set up in Input Actions). Rebinding keys there never breaks this.",
      rightAction: "The named Input Action that moves right.",
      jumpAction: "The named Input Action that jumps.",
      dashAction: "The named Input Action that dashes.",
      leftEventTrigger: "Optional: a custom event to fire when 'left' is pressed — bolt extra logic on. Leave empty if unused.",
      rightEventTrigger: "Optional custom event fired when 'right' is pressed.",
      jumpEventTrigger: "Optional custom event fired when 'jump' is pressed.",
      dashEventTrigger: "Optional custom event fired when 'dash' is pressed.",
      leftCustomFn: "Advanced internal hook. Leave empty.",
      rightCustomFn: "Advanced internal hook. Leave empty.",
      jumpCustomFn: "Advanced internal hook. Leave empty.",
      dashCustomFn: "Advanced internal hook. Leave empty.",
      wallSlideCustomFn: "Advanced internal hook. Leave empty.",
      wallJumpCustomFn: "Advanced internal hook. Leave empty.",
      jumpStrength: "How hard the jump launches upward. Higher = jumps higher. 460 ≈ a medium jump.",
      multiJump: "How many jumps before touching the ground again. 1 = single, 2 = double jump.",
      coyoteEnabled: "Coyote time — let the player still jump for a split second AFTER walking off a ledge. Feels forgiving.",
      coyoteTime: "How long that after-ledge grace lasts, in seconds. 0.1 = a tenth of a second.",
      bufferEnabled: "Jump buffer — if you press jump just BEFORE landing, it still jumps the instant you land.",
      bufferTime: "How early a pre-press still counts, in seconds. 0.1 default.",
      varHeightEnabled: "Variable jump height — tap = short hop, hold = full jump. Off by default.",
      varHeightCutoff: "(Variable height) when you release early, rising speed is clamped to this. More negative = taller minimum hop.",
      jumpSustainEnabled: "Let holding jump keep adding lift for a moment (a floatier rise). Off by default.",
      jumpSustainTime: "How long holding jump keeps boosting, in seconds.",
      dashEnabled: "Turn the dash ability on or off.",
      dashSpeed: "How fast the dash flings you, px/sec. 600 = a quick burst.",
      dashStartDelay: "Wind-up before the dash actually moves, in seconds. 0 = instant.",
      dashDuration: "How long the dash lasts, in seconds. 0.15 = a short blink.",
      dashCooldown: "How long before you can dash again, in seconds.",
      dashWallBlock: "On = a dash stops at walls instead of clipping through them.",
      wallEnabled: "Turn wall-sliding and wall-jumping on.",
      wallJumpAllowed: "Allow jumping OFF a wall while sliding on it.",
      wallJumpStrength: "Upward power of a wall jump.",
      wallJumpKickX: "Sideways push-off power of a wall jump (kicks you away from the wall).",
      wallSlideSpeed: "How fast you slide DOWN a wall while clinging. Lower = stickier.",
      wallSlideRequiresInput: "On = you must hold toward the wall to cling. Off = clings automatically.",
      wallSlideOnContact: "On = start sliding the moment you touch a wall while airborne.",
    },
  },

  TopdownMovement: {
    title: "Topdown Movement",
    group: "Movement",
    blurb: "8-direction, gravity-free movement for top-down / RPG / flying objects. Moves on all four axes via named Input Actions.",
    when: "Add it to a top-down player or creature. Don't combine it with Character Movement.",
    params: {
      maxSpeed: "Top move speed, px/sec. (If an AI Brain drives this NPC, the brain sets it.)",
      acceleration: "How fast it speeds up to max.",
      deceleration: "How fast it slows to a stop when you let go.",
      upAction: "The Input Action that moves up.",
      downAction: "The Input Action that moves down.",
      leftAction: "The Input Action that moves left.",
      rightAction: "The Input Action that moves right.",
      upEventTrigger: "Optional custom event fired when 'up' is pressed.",
      downEventTrigger: "Optional custom event fired when 'down' is pressed.",
      leftEventTrigger: "Optional custom event fired when 'left' is pressed.",
      rightEventTrigger: "Optional custom event fired when 'right' is pressed.",
      mirrorMode: "Auto-flip the sprite: 0 = off, 1 = by movement direction, 2 = by input.",
      scaleMirror: "Smoothly turn when flipping facing, instead of snapping.",
      scaleMirrorTime: "How long the smooth flip takes, in seconds.",
      ignoreInput: "Lock the player's input so momentum just coasts — for cutscenes or knockback.",
      slideAssist: "Slide along a diagonal wall instead of sticking to it.",
    },
  },

  MoveTo: {
    title: "Move To",
    group: "Movement",
    blurb: "A simple 'walk toward something' steering driver — a point, a specific object, the nearest tagged object, or a heading. Also runs nav-mesh patrols.",
    when: "Use it for NPCs that wander, chase, or follow a path. The AI Brain can also drive this for you.",
    params: {
      mode: "How it picks where to go. Position = a fixed X,Y. Object = one specific sprite. Tag = the nearest sprite with a tag. Angle = just head in a straight line.",
      targetX: "(Position mode) the X to walk to.",
      targetY: "(Position mode) the Y to walk to.",
      targetUid: "(Object mode) the specific sprite to follow. Usually set by logic, not by hand.",
      targetTag: "(Tag mode) walk to the nearest sprite carrying this tag, e.g. 'player'.",
      angleDeg: "(Angle mode) heading to move along, in degrees. 0 = right, 90 = down.",
      speed: "Move speed in px/sec. (If an AI Brain drives this NPC, the brain sets it.)",
      stopRadius: "How close counts as 'arrived', in px. Bigger = stops further away.",
      retargetEverySec: "(Tag mode) how often to re-scan for a new nearest target, in seconds.",
      arrivalSignal: "Optional signal fired when it reaches the target — catch it in the Logic Sheet.",
      mirror: "Flip the sprite to face its walking direction.",
      usePhysics: "On = moves the physics body so walls stop it. Off = slides straight to the target each frame (cheaper, ignores walls).",
      enabled: "Turn the movement on/off — e.g. freeze it during a cutscene.",
      separationDist: "Keep this many px of space from same-tag neighbors (0 = off). Stops a crowd stacking into one pile.",
      separationTag: "Which neighbors to keep apart from (empty = the host's own first tag).",
      separationStrength: "Leftover/unused — ignore it.",
      separationMode: "How crowding is resolved. Off = overlap freely. Velocity = gentle swerve. Push = hard min-gap (Vampire-Survivors style).",
      separationAvoid: "Not built yet — has no effect (see the grayed note in the inspector).",
    },
  },

  SpriteRenderer: {
    title: "Sprite Renderer",
    group: "Visuals",
    blurb: "Draws an animated sprite on the object. This is what makes a Blueprint actually look like something instead of a colored box.",
    when: "Add it to anything that should show artwork. Pick a sprite you made in the Sprite editor.",
    params: {
      spriteId: "Which sprite asset to draw. Pick one from your project's sprites.",
      currentAnimation: "Which animation of that sprite plays by default (e.g. 'idle').",
      playing: "On = the animation plays. Off = freeze on a single frame.",
      speed: "Playback speed multiplier. 1 = normal, 2 = double speed, 0.5 = half.",
      frame: "Which frame to show when not playing (a still pose).",
      useFrameCollider: "Advanced: use per-frame collision shapes baked into the sprite instead of the box Collider.",
      solid: "(Frame collider) whether those per-frame shapes physically block other objects.",
      collideFilterMode: "(Frame collider) include only — or exclude — the tags listed below.",
      collideFilterTags: "(Frame collider) which tags the shapes collide with.",
    },
  },

  Collider: {
    title: "Collider",
    group: "Physics",
    blurb: "Sets the invisible physics box that actually bumps into walls and other objects — separate from how big the picture looks.",
    when: "Add it when the default body size (matching the sprite box) is wrong, or you want a trigger/sensor.",
    params: {
      width: "Width of the physics box in px. This is what collides — not the artwork.",
      height: "Height of the physics box in px.",
      offsetX: "Nudge the box left/right from the sprite center (e.g. line it up with feet).",
      offsetY: "Nudge the box up/down from the sprite center.",
      collideWorldBounds: "Keep this object inside the scene edges — it can't walk off the map.",
      passThrough: "On = others can overlap it (a trigger/sensor zone). Off = it's solid and blocks.",
      debugDraw: "Draw the box during Play so you can see it. Turn off for release.",
    },
  },

  Solid: {
    title: "Solid",
    group: "Physics",
    blurb: "Marks the object as immovable world geometry — walls, floors, platforms that other bodies collide against.",
    when: "Add it to static level pieces that should block the player and enemies.",
    params: {
      debugDraw: "Draw the solid's outline during Play to debug placement.",
    },
  },

  JumpThru: {
    title: "Jump-Through Platform",
    group: "Physics",
    blurb: "A one-way platform: bodies pass UP through it from below, then land on TOP. Classic for floating platforms.",
    when: "Add it to ledges you want to jump up onto but not bonk your head on. No settings — just attach it.",
    params: {},
  },

  Tracer: {
    title: "Tracer",
    group: "Combat & RPG",
    blurb: "A reach that detects (and optionally damages) other objects — a line for line-of-sight or bullets, or a box for melee swings. Also used as an AI's 'eyes'.",
    when: "Add it for melee hitboxes, sight checks, or any 'is something in front of me?' test. You can attach several (named).",
    params: {
      name: "A label for this tracer so logic and other components can target it (e.g. an AI's sight vs attack tracer).",
      shape: "Line = a thin ray (line-of-sight, bullets). Box = a rectangle area (melee swing).",
      distance: "How far the tracer reaches, in px.",
      angle: "Direction it points, in degrees. 0 = straight forward (the way the sprite faces).",
      pivotSource: "Where it starts from: the sprite center, a frame hotspot, a named image point, or a weapon's image point.",
      imagePointName: "Which named point on the sprite to start from (image-point modes).",
      weaponSlotName: "Which weapon slot's point to start from (weapon mode; empty = the first slot).",
      pivotX: "Nudge the start point left/right by this many px (mirrors with facing).",
      pivotY: "Nudge the start point up/down by this many px.",
      boxThickness: "(Box shape) how thick the box is, in px.",
      tagFilter: "Only detect sprites with these tags (comma list; empty = anything).",
      damage: "Damage dealt to whatever it hits. 0 = it's just a sensor, no damage.",
      multiHit: "On = hit everyone in range at once (cleave). Off = only the first target.",
      knockbackX: "Forward push dealt to what it hits.",
      knockbackY: "Vertical push dealt to what it hits.",
      triggerMode: "When it fires: Interval (on a timer / every frame) or On Signal (you fire it from logic).",
      intervalSec: "(Interval) seconds between checks; 0 = every frame.",
      triggerSignal: "(Signal) the signal name that makes it fire.",
      signalCount: "(Signal) how many hits per fire.",
      signalLoop: "(Signal) keep firing after the first burst.",
      signalLifetimeSec: "(Signal) how long a hit stays active; 0 = forever.",
      fireAnim: "Only allow it to fire during this animation (empty = any). e.g. 'attack'.",
      fireFrame: "Only fire on this frame index (-1 = any) — e.g. the exact swing impact frame.",
      debugDraw: "Draw the tracer during Play so you can see its reach.",
    },
  },

  Damageable: {
    title: "Damageable",
    group: "Combat & RPG",
    blurb: "Gives the object HP so it can take damage, get knocked back, and die. Reads/writes HP from a Blueprint variable.",
    when: "Add it to anything that can be hurt — players, enemies, breakable crates.",
    params: {
      hpVar: "Which BP variable holds current HP. The number itself lives in the Variables section.",
      maxHpVar: "Which BP variable holds max HP.",
      iframeSec: "Invincibility time right after a hit, in seconds — stops instant multi-hits.",
      hitstunSec: "How long it's stunned (can't act) after a hit.",
      knockbackMultiplier: "Scales incoming knockback. 1 = normal, 2 = flies twice as far, 0 = immovable.",
      destroyOnDeath: "On = the object is removed when HP hits 0.",
      deathDestroyDelay: "Wait this long after death before removing it (lets a death animation play).",
      allowHealing: "Allow HP to go back up (heals, potions).",
      attackable: "On = AI enemies will target and attack it. Off = they ignore it.",
      blockStates: "Animator state names that count as blocking (e.g. 'block,parry') — damage is reduced while in them.",
      guardMultiplier: "Damage taken while blocking. 0 = full block (no damage), 0.5 = half, 1 = no block.",
      guarding: "A manual block on/off flag you can drive from logic.",
    },
  },

  Inventory: {
    title: "Inventory",
    group: "Combat & RPG",
    blurb: "A bag of item slots the object can carry. Items are project assets added at runtime via Give Item / pickups.",
    when: "Add it to the player (and to chests / shops / NPCs that hold items).",
    tip: "Give the PLAYER a Persist Key so its bag survives scene changes; leave it EMPTY on chests so each has its own.",
    params: {
      capacity: "How many item slots the bag has.",
      persistKey: "Set a key (e.g. 'player') so this bag carries across scenes and feeds the HUD. Leave EMPTY for a scene-local, independent bag.",
    },
  },

  AIBrain: {
    title: "AI Brain",
    group: "AI",
    blurb: "A ready-made enemy brain: it senses a target, chases, attacks, and flees — all automatically. Drives the movement component for you.",
    when: "Add it to an enemy that should act on its own. Use either AI Brain OR drive the NPC by hand from the Logic Sheet, not both.",
    tip: "It needs a Tracer named to match Sight/Attack Tracer Name, and a movement component to drive.",
    params: {
      autoBrain: "On = use the built-in brain (sense → chase → attack). Off = you drive the NPC yourself from the Logic Sheet.",
      state: "Which AI state it starts in (idle, alert, chase, attack, flee, search).",
      targetTag: "Who it hunts — the tag of its enemy, e.g. 'player'.",
      sightTracerName: "Name of the Tracer used as its eyes (line-of-sight). Must match a Tracer on this BP.",
      attackTracerName: "Name of the Tracer used as its attack reach / hitbox.",
      attackRange: "How close (px) the target must be before it attacks.",
      loseSightAfterSec: "Keep chasing this long after losing sight of the target, then give up.",
      attackDurationSec: ">0 = one distinct swing per attack with a rest between. 0 = continuous attacking.",
      attackCooldownSec: "Seconds between attack swings.",
      attackRestState: "Which state to show between swings (e.g. alert).",
      interruptAttackOnHit: "On = getting hit cancels its attack. Off = super armor (attack continues through hits).",
      chaseSpeed: "Move speed while chasing.",
      patrolSpeed: "Move speed while patrolling / wandering.",
      fleeOnDamage: "On = runs away when it gets hurt.",
      fleeDurationSec: "How long it flees before recovering.",
      hearSignals: "Signal names it 'hears' and reacts to (comma list) — e.g. noises that alert it.",
      patrolMode: "What it does with no target: None = stand still, Bounce on walls = wander and turn at walls.",
      autoFaceTarget: "Auto-turn to face its target.",
      disableWhenDead: "Stop thinking once HP ≤ 0.",
      separationDist: "Keep this much space from fellow enemies (0 = off) so they don't stack into one blob.",
      separationTag: "Which enemies to keep apart from.",
      separationMode: "How crowding is resolved (when the mover is MoveTo). Off / Velocity swerve / Push apart.",
      aiTickRate: "How often it 'thinks', in frames. 1 = every frame (60Hz, smartest, costliest), 3 = 20Hz (default), 6 = 10Hz (cheap for big crowds).",
      mover: "Which movement component the brain drives: Auto, Character Movement (platformer), Topdown (4-way), or Move To (steering/chase/patrol).",
    },
  },

  // ── Below: intro written, full per-param prose still to come. The renderer
  //    shows their real fields (label as fallback) so they're already usable. ──
  Text: {
    title: "Text", group: "Visuals", params: {},
    blurb: "Draws a text label on the object — names, damage numbers, signs. Supports {var:hp}-style placeholders that fill in live values.",
  },
  TiledBackground: {
    title: "Tiled Background", group: "Visuals", params: {},
    blurb: "A repeating, scrolling background image — skies, clouds, parallax layers that drift behind the action.",
  },
  SquashStretch: {
    title: "Squash & Stretch", group: "Visuals", params: {},
    blurb: "Cartoon squash-and-stretch wobble — adds juice to jumps, landings, and hits. Trigger it with the Play Squash Stretch node.",
  },
  ParticleEmitter: {
    title: "Particle Emitter", group: "Visuals", params: {},
    blurb: "Spits out particles — smoke, sparks, blood, dust. Runs continuously or fires one-off bursts on command.",
  },
  VisionMask: {
    title: "Vision Mask", group: "Visuals", params: {},
    blurb: "A darkness/fog cutout around the object — a flashlight cone, fog of war, or spotlight effect.",
  },
  Dismemberment: {
    title: "Dismemberment", group: "Visuals", params: {},
    blurb: "Lets parts of the sprite detach or break off — gore, shattering armor, breakable pieces.",
  },
  Projectile: {
    title: "Projectile", group: "Combat & RPG", params: {},
    blurb: "Makes the object fly like a bullet or arrow — straight-line or homing — dealing damage and dying on hit.",
  },
  WeaponSlot: {
    title: "Weapon Slot", group: "Combat & RPG", params: {},
    blurb: "Pins a weapon sprite to a point on the character (like a hand) so it moves and flips with them.",
  },
  PhaseManager: {
    title: "Phase Manager", group: "AI", params: {},
    blurb: "Boss phases — splits a fight into stages at HP thresholds (e.g. 66% and 33%) you can react to in logic.",
  },
  Widget: {
    title: "Widget", group: "UI", params: {},
    blurb: "Pins a UI widget — like a healthbar or name label — above this object in the world. Each instance shows its own values.",
  },
  SmartTween: {
    title: "Smart Tween", group: "Misc", params: {},
    blurb: "Author keyframed motion, scale, and rotation animations on the object — opening doors, moving platforms, bobbing pickups.",
  },
  TilemapRenderer: {
    title: "Tilemap Renderer", group: "Tilemap", params: {},
    blurb: "Draws a tilemap. Configured by the tilemap asset itself (in the Tilemap editor), not by per-object fields.",
  },
};
