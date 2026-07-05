import { BehaviorInstance, BlueprintDef, PeakyEvent, VariableDef } from "./project";

/**
 * Blueprint class registry — UE5-style. Every Blueprint is instantiated from a
 * `BpClass` template. The class supplies sensible defaults at creation time
 * (visual size, default behaviors, tags) but does NOT lock the BP — the user
 * is free to add/remove anything afterward.
 *
 * Adding a future class = one entry here + (optionally) the class's
 * behaviors. The "+ New Blueprint" picker reads from `PUBLIC_CLASSES`.
 */

export type BpClass = "Character" | "NPC" | "Actor" | "Camera" | "Empty" | "Trigger";

export interface BpClassMeta {
  label: string;
  description: string;
  /** Returns the seed defaults the new BP starts with (id/name set by the store). */
  defaults: () => BpClassDefaults;
}

export interface BpClassDefaults {
  classKind: BpClass;
  tags?: string[];
  w?: number;
  h?: number;
  color?: number;
  behaviors?: BehaviorInstance[];
  variables?: VariableDef[];
  events?: PeakyEvent[];
  /** When false, runProject disables Phaser body gravity for the host. Use
   *  for classes that don't have a movement behavior managing their own
   *  physics — without this, a blank BP falls off-screen at 800px/sec². */
  affectedByGravity?: boolean;
  /** When true the host rectangle never renders (editor + runtime) — the BP is
   *  an invisible volume (e.g. a Trigger). The collider still works. */
  hideRect?: boolean;
}

export const CLASSES: Record<BpClass, BpClassMeta> = {
  Character: {
    label: "Character",
    description: "Pre-wired Character. HP, movement, jump and collision ready out of the box. Tune via the Overview inspector — toggle features on/off, drop in animations + FX sprites, set HP. No event-sheet authoring required.",
    defaults: () => ({
      classKind: "Character",
      // Baked from the current Untitled-Game project — your tuned Player /
      // NPC setup at 2026-05-16 21:17 becomes the default state for new
      // BPs spawned from + Character. Sprite refs are kept verbatim so
      // they only resolve inside projects where those sprites exist.
      tags: ["character", "player"],
      w: 32,
      h: 48,
      color: 0xff4242,
      behaviors: [
        {
          kind: "CharacterMovement",
          config: {
            maxSpeed: 350,
            acceleration: 5555,
            deceleration: 5555,
            airControl: 2,
            gravity: 1500,
            gravityAngle: 90,
            maxFallSpeed: 1500,
            ceilingMode: 0,
            mirrorMode: 2,
            scaleMirror: 0,
            scaleMirrorTime: 0.15,
            leftAction: "MoveLeft",
            leftEventTrigger: "",
            leftCustomFn: "",
            rightAction: "MoveRight",
            rightEventTrigger: "",
            rightCustomFn: "",
            jumpAction: "Jump",
            jumpEventTrigger: "",
            jumpCustomFn: "",
            jumpStrength: 650,
            jumpTimeToApex: 0,
            fallGravityMultiplier: 2,
            multiJump: 1,
            coyoteEnabled: 1,
            coyoteTime: 0.2,
            bufferEnabled: 1,
            bufferTime: 0.1,
            jumpSustainEnabled: 0,
            jumpSustainTime: 0.18,
            varHeightEnabled: 0,
            varHeightCutoff: -150,
            dashEnabled: 1,
            dashAction: "",
            dashEventTrigger: "dashSignal",
            dashCustomFn: "",
            dashSpeed: 1000,
            dashStartDelay: 0,
            dashDuration: 0.2,
            dashCooldown: 1,
            wallEnabled: 1,
            wallSlideSpeed: 0,
            wallJumpStrength: 650,
            wallJumpKickX: 200,
            wallSlideRequiresInput: 1,
            wallSlideOnContact: 0,
            wallSlideCustomFn: "",
            wallJumpCustomFn: "",
            wallSlideEngageOn: "enter",
            wallJumpRequiresMain: 1,
          },
          enabled: true,
        },
        {
          kind: "SpriteRenderer",
          config: {
            spriteId: "spr_mp1mbgwt_x",
            currentAnimation: "",
            playing: 0,
            speed: 1,
          },
          enabled: true,
        },
        {
          kind: "Collider",
          config: {
            width: 119,
            height: 162,
            offsetX: 0,
            offsetY: -81,
            collideWorldBounds: 1,
            passThrough: 1,
            debugDraw: 0,
            bodyAnchor: "center",
          },
          enabled: true,
        },
        {
          kind: "Damageable",
          config: {
            hp: 100,
            maxHp: 100,
            hpVar: "HP",
            maxHpVar: "MaxHP",
            iframeSec: 0,
            hitstunSec: 0.3,
            knockbackMultiplier: 20,
            destroyOnDeath: 0,
            deathDestroyDelay: 0.5,
            allowHealing: 1,
          },
          enabled: true,
        },
        {
          kind: "Tracer",
          config: {
            name: "AttackTracer",
            shape: "line",
            distance: 300,
            angle: 0,
            pivotSource: "imagePoint",
            imagePointName: "Point 1",
            pivotX: -100,
            pivotY: 0,
            boxThickness: 16,
            tagFilter: "",
            triggerMode: "signal",
            triggerSignal: "atkTracer",
            signalCount: 1,
            signalLoop: 1,
            signalLifetimeSec: 0.2,
            intervalSec: 0,
            debugDraw: 0,
            damage: 10,
            knockbackX: 0,
            knockbackY: 10,
            multiHit: 1,
          },
          enabled: true,
        },
        {
          kind: "Tracer",
          config: {
            name: "InteractionChecker",
            shape: "line",
            distance: 100,
            angle: 0,
            pivotSource: "manual",
            imagePointName: "",
            pivotX: 0,
            pivotY: 0,
            boxThickness: 16,
            tagFilter: "dialog npc",
            triggerMode: "signal",
            triggerSignal: "CheckForInteracion",
            signalCount: 1,
            signalLoop: 0,
            signalLifetimeSec: 0,
            intervalSec: 0,
            debugDraw: 0,
          },
          enabled: true,
        },
        {
          kind: "Tracer",
          config: {
            name: "talk_zone",
            shape: "circle",
            distance: 200,
            pivotSource: "host",
            pivotX: 0,
            pivotY: 0,
            triggerMode: "interval",
            intervalSec: 0.15,
            tagFilter: "",
            damage: 0,
            debugDraw: 0,
          },
          enabled: true,
        },
        {
          kind: "StateMachine",
          config: {
            states: [
              {
                name: "attack",
                priority: 100,
                animation: "attack",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: false,
                primary: { kind: "OnKeyPressed", actions: ["Attack"] },
                comboAnimations: ["atk1", "atk2", "atk3", "atk4", "atk5"],
                frameSignals: [
                  {
                    anim: "atk1",
                    frames: [4],
                    signal: "atkTracer",
                  },
                  {
                    anim: "atk2",
                    frames: [1],
                    signal: "atkTracer",
                  },
                  {
                    anim: "atk3",
                    frames: [0],
                    signal: "atkTracer",
                  },
                  {
                    anim: "atk4",
                    frames: [2],
                    signal: "atkTracer",
                  },
                  {
                    anim: "atk5",
                    frames: [3],
                    signal: "atkTracer",
                  },
                ],
                frameMotions: [],
                freezeMovement: true,
              },
              {
                name: "dash",
                priority: 80,
                animation: "dash",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: true,
                primary: { kind: "IsDashing" },
              },
              {
                name: "wallslide",
                priority: 60,
                animation: "wall_slideLoop",
                enterAnim: "wall_slideIn",
                exitAnim: "",
                useTransitions: true,
                loop: true,
                primary: { kind: "IsWallSliding" },
                useExit: false,
              },
              {
                name: "walljump",
                priority: 65,
                animation: "wall_jump",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: false,
                primary: { kind: "IsWallJumping" },
                holdOnFinish: true,
              },
              {
                name: "land",
                priority: 0,
                animation: "land",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: false,
                primary: { kind: "OnLand" },
              },
              {
                name: "jump",
                priority: 50,
                animation: "jump_start",
                enterAnim: "jump_start",
                exitAnim: "",
                useTransitions: false,
                loop: true,
                primary: { kind: "Compare", property: "velocity.y", op: "<", value: 0 },
              },
              {
                name: "fall",
                priority: 40,
                animation: "fall",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: true,
                primary: { kind: "IsAirborne" },
              },
              {
                name: "turn_left",
                priority: 0,
                animation: "turn_left",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: false,
                primary: { kind: "JustTurnedLeft" },
              },
              {
                name: "turn_right",
                priority: 0,
                animation: "turn_right",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: false,
                primary: { kind: "JustTurnedRight" },
              },
              {
                name: "crouch",
                priority: 20,
                animation: "crouch",
                enterAnim: "crouch_in",
                exitAnim: "crouch_out",
                useTransitions: false,
                loop: true,
                primary: { kind: "IsActionHeld", action: "Crouch" },
              },
              {
                name: "run",
                priority: 15,
                animation: "run",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: true,
                primary: { kind: "IsMoving", value: 1 },
              },
              {
                name: "idle",
                priority: 0,
                animation: "idle",
                enterAnim: "",
                exitAnim: "",
                useTransitions: false,
                loop: true,
                primary: { kind: "Always" },
              },
            ],
            currentState: "idle",
            debugDraw: 1,
          },
          enabled: true,
        },
        {
          kind: "SquashStretch",
          config: {
            intensity: 0.3,
            duration: 0.3,
            easing: "Quad.Out",
            emitOnEnd: 0,
          },
          enabled: true,
        },
      ],
      variables: [
        {
          id: "hp",
          name: "HP",
          type: "number",
          default: 100,
          numberKind: "integer",
          instanceEditable: true,
          exposeOnSpawn: false,
        },
        {
          id: "maxHp",
          name: "MaxHP",
          type: "number",
          default: 100,
          numberKind: "integer",
          instanceEditable: true,
          exposeOnSpawn: true,
        },
      ],
    }),
  },
  NPC: {
    label: "NPC",
    description: "AI-driven character. Same body as a Character but driven by an AIBrain instead of input. Sense (sight tracer) → Think (idle/alert/chase/search/attack/flee) → Act (move/attack/flee). Tune via the NPC Overview — toggle hostility, set patrol mode, sight range, attack damage. Mark passive for shopkeepers / quest givers.",
    defaults: () => ({
      classKind: "NPC",
      // Baked from the current Untitled-Game project — your tuned Player /
      // NPC setup at 2026-05-16 21:17 becomes the default state for new
      // BPs spawned from + NPC. Sprite refs are kept verbatim so
      // they only resolve inside projects where those sprites exist.
      tags: ["npc", "enemy", "dialog npc"],
      w: 32,
      h: 48,
      color: 0xff6b6b,
      behaviors: [
        {
          kind: "CharacterMovement",
          config: {
            leftAction: "",
            rightAction: "",
            jumpAction: "",
          },
          enabled: true,
        },
        {
          kind: "SpriteRenderer",
          config: {
            spriteId: "spr_mp5mfl5u_d",
            playing: 0,
          },
          enabled: true,
        },
        {
          kind: "Collider",
          config: {
            width: 87,
            height: 146,
            offsetX: -3,
            offsetY: -73,
          },
          enabled: true,
        },
        {
          kind: "Damageable",
          config: {
            hp: 500,
            maxHp: 50,
            hitstunSec: 0,
            knockbackMultiplier: 15,
            deathDestroyDelay: 0,
            destroyOnDeath: 0,
            iframeSec: 0,
            hpVar: "HP",
            maxHpVar: "MaxHP",
          },
          enabled: true,
        },
        {
          kind: "StateMachine",
          config: {
            states: [
              {
                // `isInHitstun` is SUSTAINED for the full hitstun window
                // (Damageable.hitstunSec) — not edge-triggered like
                // `signalFired`. So this state wins every tick while
                // Damageable.isInHitstun() is true, which keeps the hurt
                // anim from being interrupted by the still-matching attack
                // state next tick. Pair with freezeMovement: true + the
                // hitstun gate in applyAdvancedPerTick → knockback velocity
                // set by Damageable.applyDamage actually plays out.
                name: "hurt",
                priority: 101,
                pausesAI: true,
                animation: "hurt",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: false,
                primary: { kind: "IsInHitstun" },
                freezeMovement: true,
                frameSignals: [
                  {
                    anim: "hurt",
                    frames: [0],
                    signal: "gethurt",
                  },
                ],
                extras: [],
              },
              {
                name: "attack",
                priority: 90,
                animation: "Attack",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: false,
                primary: { kind: "IsAIState", action: "attack" },
                frameSignals: [
                  {
                    anim: "",
                    frames: [11, 22],
                    signal: "AttackFrame",
                  },
                ],
                extras: [],
              },
              {
                name: "flee",
                priority: 70,
                animation: "flee",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: true,
                primary: { kind: "IsAIState", action: "flee" },
              },
              {
                name: "chase",
                priority: 50,
                animation: "Run",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: true,
                primary: { kind: "IsAIState", action: "chase" },
              },
              {
                name: "search",
                priority: 40,
                animation: "search",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: true,
                primary: { kind: "IsAIState", action: "search" },
              },
              {
                name: "alert",
                priority: 30,
                animation: "alert",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: true,
                primary: { kind: "IsAIState", action: "alert" },
              },
              {
                name: "idle",
                priority: 0,
                animation: "idle",
                enterAnim: "",
                exitAnim: "",
                useEnter: false,
                useExit: false,
                loop: true,
                primary: { kind: "Always" },
              },
              {
                // death uses the highest priority + holdOnFinish + isDead so:
                // 1. priority 200 beats every other state (hurt etc.) once dead
                // 2. isDead is sustained — reads Damageable.isDead flag
                // 3. holdOnFinish pins the last frame so the anim plays ONCE
                name: "death",
                priority: 200,
                pausesAI: true,
                animation: "death",
                loop: false,
                holdOnFinish: true,
                primary: { kind: "IsDead" },
                frameMotions: [],
                frameSignals: [
                  {
                    anim: "death",
                    frames: [0],
                    signal: "gethurt",
                  },
                ],
                freezeMovement: true,
                ignoreInput: true,
              },
            ],
            currentState: "idle",
            debugDraw: 0,
          },
          enabled: true,
        },
        {
          kind: "AIBrain",
          config: {
            autoFaceTarget: 1,
            patrolMode: "walls",
            patrolSpeed: 0,
            attackRange: 100,
            attackCooldownSec: 0,
            attackDurationSec: 3,
            autoBrain: 1,
            disableWhenDead: 0,
            chaseSpeed: 250,
            separationDist: 100,
          },
          enabled: true,
        },
        {
          kind: "Tracer",
          config: {
            name: "sight",
            shape: "box",
            distance: 400,
            angle: 0,
            pivotSource: "manual",
            pivotX: -200,
            pivotY: 0,
            triggerMode: "interval",
            intervalSec: 0.15,
            tagFilter: "player",
            damage: 0,
            boxThickness: 80,
            debugDraw: 0,
          },
          enabled: true,
        },
        {
          kind: "Tracer",
          config: {
            name: "attack",
            shape: "box",
            distance: 80,
            angle: 0,
            pivotSource: "imagePoint",
            triggerMode: "signal",
            triggerSignal: "AttackFrame",
            tagFilter: "player",
            damage: 10,
            signalLifetimeSec: 0.15,
            boxThickness: 24,
            debugDraw: 0,
            imagePointName: "Point 1",
          },
          enabled: true,
        },
        {
          kind: "ParticleEmitter",
          config: {
            mode: "burst",
            rate: 10,
            burstCount: 20,
            maxParticles: 1000,
            enabled: 0,
            spriteId: "spr_mp6pdzdi_c",
            delay: 0,
            pivotSource: "imagePoint",
            imagePointName: "Point 1",
            spawnJitterX: 30,
            spawnJitterY: 50,
            lifetime: 0.4,
            lifetimeJitter: 0,
            speed: 0,
            speedJitter: 0,
            angleMin: -90,
            angleMax: -90,
            gravityX: 0,
            gravityY: 0,
            friction: 0,
            rotationStart: 0,
            rotationEnd: 60,
            rotationJitter: 50,
            scaleStart: 1,
            scaleEnd: 5,
            alphaStart: 1,
            alphaEnd: 0,
            tintStart: 16777215,
            tintEnd: 16777215,
            blendMode: "NORMAL",
            frameMode: "first",
          },
          enabled: true,
        },
        {
          kind: "Text",
          config: {
            name: "Text",
            content: "",
            fontFamily: "Arial",
            fontSize: 16,
            color: 16777215,
            bold: 0,
            italic: 0,
            align: "left",
            vAlign: "top",
            wrapWidth: 0,
            visible: 1,
            alpha: 1,
            offsetX: -4,
            offsetY: -205,
          },
          enabled: true,
        },
      ],
      variables: [
        {
          id: "hp",
          name: "HP",
          type: "number",
          default: 20,
          numberKind: "integer",
          instanceEditable: true,
          exposeOnSpawn: false,
        },
        {
          id: "maxHp",
          name: "MaxHP",
          type: "number",
          default: 50,
          numberKind: "integer",
          instanceEditable: true,
          exposeOnSpawn: true,
        },
      ],
    }),
  },
  Actor: {
    label: "Actor",
    description: "Bare-bones actor (used as the legacy default for un-classed BPs).",
    defaults: () => ({ classKind: "Actor" }),
  },
  Camera: {
    label: "Camera",
    description: "Scene camera. One per scene. Carries the Camera behavior internally — exposes Camera conditions/actions in its picker. Drag to set initial scroll position.",
    defaults: () => ({
      classKind: "Camera",
      tags: ["camera"],
      w: 32,
      h: 32,
      color: 0xffaa44,
      // Camera behavior is auto-attached. The behavior is hidden from
      // the Components picker for non-Camera BPs (see BEHAVIOR_REGISTRY
      // gating in behaviorMeta.ts). Like every BP it also carries a State
      // Machine (single disabled placeholder) so the Overview surface exists.
      behaviors: [
        {
          kind: "StateMachine",
          config: {
            states: [
              { name: "empty", priority: 0, enabled: 0, animation: "", useEnter: false, useExit: false, loop: false, primary: { kind: "Always" } },
            ],
          },
          enabled: true,
        },
        { kind: "Camera", config: {}, enabled: true },
      ],
    }),
  },
  Empty: {
    label: "Empty",
    description: "Blank Blueprint — no components, no tags, no default size. Use as a clean starting point when none of the pre-wired templates fit (custom pickups, triggers, decorations, scripted spawners, etc.). Add components from the Components panel as needed.",
    defaults: () => ({
      classKind: "Empty",
      tags: [],
      w: 32,
      h: 32,
      // Neutral grey — visually identifies "I'm a blank slate, name me
      // something and pick what I do."
      color: 0x808080,
      // Every BP carries a State Machine so the Animation/Overview authoring
      // surface is always available. A blank BP ships with a single disabled
      // placeholder state ("empty", enabled:0 → never wins) — the author
      // renames it / turns it on, or adds real states, from the Overview.
      behaviors: [
        {
          kind: "StateMachine",
          config: {
            states: [
              { name: "empty", priority: 0, enabled: 0, animation: "", useEnter: false, useExit: false, loop: false, primary: { kind: "Always" } },
            ],
          },
          enabled: true,
        },
      ],
      // Default OFF — a blank BP has no movement behavior to manage physics,
      // so leaving gravity on makes the host fall off-screen at 800px/sec²
      // before the user even sees it. Toggle on via Inspector if needed.
      affectedByGravity: false,
    }),
  },
  Trigger: {
    label: "Trigger",
    description: "Invisible sensor volume. Drop it into a scene, size it, and wire OnOverlap / On End Overlap / On Overlap For Seconds in the Logic Sheet. Set its Door link (in the instance inspector) to also teleport the player to another scene. No gravity, hidden rectangle, overlap-only (never blocks movement).",
    defaults: () => ({
      classKind: "Trigger",
      tags: ["trigger"],
      w: 64,
      h: 64,
      // Distinct blue so trigger BPs read differently in lists / the editor
      // wireframe (the rect itself is hidden; the ● Colliders overlay shows it).
      color: 0x33bbff,
      hideRect: true,
      affectedByGravity: false,
      behaviors: [
        // Overlap-only sensor: fires OnCollide/OnOverlap/OnSeparate via
        // CollisionScan but never physically pushes anything.
        {
          kind: "Collider",
          config: { width: 64, height: 64, offsetX: 0, offsetY: 0, collideWorldBounds: 0, passThrough: 1, debugDraw: 0 },
          enabled: true,
        },
        // Placeholder State Machine keeps the Overview/animation surface
        // available and consistent with the Empty class (disabled → never wins).
        {
          kind: "StateMachine",
          config: {
            states: [
              { name: "empty", priority: 0, enabled: 0, animation: "", useEnter: false, useExit: false, loop: false, primary: { kind: "Always" } },
            ],
          },
          enabled: true,
        },
      ],
    }),
  },
};

/** Classes shown to the user in the "+ New Blueprint" picker. */
export const PUBLIC_CLASSES: BpClass[] = ["Character", "NPC", "Trigger", "Empty", "Camera"];

/** Build a partial BlueprintDef from class defaults, suitable for `addBlueprint(partial)`. */
export function buildClassPartial(cls: BpClass): Partial<BlueprintDef> {
  const d = CLASSES[cls].defaults();
  return {
    classKind: d.classKind,
    tags: d.tags,
    w: d.w,
    h: d.h,
    color: d.color,
    behaviors: d.behaviors,
    variables: d.variables,
    events: d.events,
    affectedByGravity: d.affectedByGravity,
    hideRect: d.hideRect,
  };
}
