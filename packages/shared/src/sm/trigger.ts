/**
 * Event triggers — the "When …" half of an event block.
 *
 * Each blueprint owns a flat priority list of events; each event has exactly
 * one trigger here. Triggers are evaluated each frame against the sprite's
 * runtime state; firing is one-shot for edge triggers (OnCreate, OnLand,
 * OnPress, OnCollide, OnAnimationEnd, OnEvent) and continuous for level
 * triggers (OnStep, OnKeyHeld).
 *
 * Multi-payload triggers carry **arrays** of names — the trigger fires when
 * **any** named entry matches (OR semantics). Lets you express
 * "On Key Pressed [Jump, AltJump]" or "On Collide [enemy, boss]" in one row.
 * For AND semantics across different payloads (chord-style "shift+W"),
 * combine via guards on a child key event.
 */

export type EventTrigger =
  | { kind: "OnCreate" }
  | { kind: "OnStep" }
  | { kind: "OnKeyPressed";  actions: string[] }
  | { kind: "OnKeyReleased"; actions: string[] }
  | { kind: "OnKeyHeld";     actions: string[] }
  | { kind: "OnCollide"; tags: string[] }
  | { kind: "OnOverlap"; tags: string[] }
  | { kind: "OnAnimationEnd"; animation?: string }
  | { kind: "OnLand" }
  | { kind: "OnJump" }
  | { kind: "OnFall" }
  | { kind: "OnDashStart" }
  | { kind: "OnDashEnd" }
  | { kind: "OnSignal"; signals: string[] };

export type EventTriggerKind = EventTrigger["kind"];

export const EVENT_TRIGGER_KINDS: EventTriggerKind[] = [
  "OnCreate",
  "OnStep",
  "OnKeyPressed",
  "OnKeyReleased",
  "OnKeyHeld",
  "OnCollide",
  "OnOverlap",
  "OnAnimationEnd",
  "OnLand",
  "OnJump",
  "OnFall",
  "OnDashStart",
  "OnDashEnd",
  "OnSignal",
];

export const EVENT_TRIGGER_LABELS: Record<EventTriggerKind, string> = {
  OnCreate: "On Create",
  OnStep: "On Step",
  OnKeyPressed: "On Key Pressed",
  OnKeyReleased: "On Key Released",
  OnKeyHeld: "On Key Held",
  OnCollide: "On Collide",
  OnOverlap: "On Overlap",
  OnAnimationEnd: "On Animation End",
  OnLand: "On Land",
  OnJump: "On Jump",
  OnFall: "On Fall",
  OnDashStart: "On Dash Start",
  OnDashEnd: "On Dash End",
  OnSignal: "On Signal",
};

export const EVENT_TRIGGER_DESCRIPTIONS: Record<EventTriggerKind, string> = {
  OnCreate: "Fires once when this blueprint instance spawns.",
  OnStep: "Fires every frame while the instance lives.",
  OnKeyPressed: "Fires the frame any of the listed input actions is pressed (OR).",
  OnKeyReleased: "Fires the frame any of the listed input actions is released (OR).",
  OnKeyHeld: "Fires every frame any of the listed input actions is held (OR).",
  OnCollide: "Fires while this sprite collides with another sprite carrying any listed tag (OR).",
  OnOverlap: "Fires while this sprite overlaps another sprite carrying any listed tag (OR).",
  OnAnimationEnd: "Fires once when a non-loop animation reaches its last frame.",
  OnLand: "Fires once the frame the sprite touches ground after being airborne (CharacterMovement-emitted).",
  OnJump: "Fires once the frame a jump fires (CharacterMovement-emitted).",
  OnFall: "Fires once the frame the sprite leaves the ground without jumping (CharacterMovement-emitted).",
  OnDashStart: "Fires once the frame a dash begins (CharacterMovement-emitted).",
  OnDashEnd: "Fires once the frame a dash ends (CharacterMovement-emitted).",
  OnSignal: "Fires when any listed signal name is emitted on this sprite (OR).",
};

/** Default config for a newly-picked trigger kind. */
export function defaultTrigger(kind: EventTriggerKind): EventTrigger {
  switch (kind) {
    case "OnKeyPressed":
    case "OnKeyReleased":
    case "OnKeyHeld":
      return { kind, actions: [] };
    case "OnCollide":
    case "OnOverlap":
      return { kind, tags: [] };
    case "OnAnimationEnd":
      return { kind, animation: "" };
    case "OnSignal":
      return { kind, signals: [] };
    default:
      return { kind } as EventTrigger;
  }
}

/** True for triggers that consume a one-shot signal (don't re-fire each frame). */
export function isEdgeTrigger(kind: EventTriggerKind): boolean {
  return (
    kind !== "OnStep" &&
    kind !== "OnKeyHeld" &&
    kind !== "OnCollide" &&
    kind !== "OnOverlap"
  );
}
