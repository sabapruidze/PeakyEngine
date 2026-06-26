// Plain-language docs for the Node Reference page. Built on the engine's own
// node descriptions, with easy fill-ins for nodes that ship without one, plus a
// mini example per node. Keyed by node `type`.
import { ACTION_DESCRIPTIONS, CONDITION_DESCRIPTIONS } from "@peaky/shared";
import type { LogicGraphNode } from "../../../project";

/** Descriptions for pure "getter" nodes (no exec, read-a-value). Lives here so
 *  both the Documentation page and the node picker share one source — the picker
 *  imports nodeDescription() from this file, so keeping these here avoids a
 *  cycle back through LogicGraphCanvas. */
export const GETTER_DESCRIPTIONS: Record<string, string> = {
  GetNavPoint: "Returns the world position (x/y) of a NAV-MESH WAYPOINT matched by name or tag — wire x & y into MoveTo NavPosition. `point` empty = any; pick 'nearest' (to this object) or 'random'. `count` = how many match. Paint waypoints in the Scene → Nav Mesh tool.",
  GetTaggedTile: "Finds a big/animated tile carrying a tag and returns its world position — so an NPC can walk to a tagged tile and act on it (e.g. a sheep going to a 'bush' tile to eat). Set the tag, pick 'nearest' (to this object) or 'random', and read x / y / count. Wire x & y into Move To; on arrival, Mine. Reads tiles live, so destroyed tiles drop out automatically. Tag tiles in Tileset → Big/Animated tiles → Tags.",
  OnTileDrop: "Fires on the MINER when a destroyed tile spawns a drop (one fire per tile, even if it drops a stack). Use Get Last Drop after it to read what dropped (bp / count / x / y) — e.g. count a harvest, play a pickup sound, or show a toast — without putting logic on each dropped item.",
  GetLastDrop: "Reads ONE field of the most-recent tile drop — use it right after On Tile Drop. Fields: bp (dropped blueprint name), count (how many), x / y (world), layer. Wire into a branch or any input — no expressions.",
  GetLastTile: "Reads ONE field of the most-recently mined/hit tile — use it right after an On Tile Damaged / On Tile Destroyed trigger. Pick what to read: x, y (world), c, r (cell), tag (the tile's tags, comma-joined), name, hp / maxHP, tilemap, layer. Wire it into a CompareValues / branch (e.g. only react when tag = \"tree\") or into Emit Signal To's tag — no expressions.",
  GetPicked: "Reads ONE field/variable of the PICKED instance — the object you collided/overlapped with (collide auto-picks it), or a ForEach/Pick result. Pick the BP in the first dropdown so ITS variables appear in the 'read' menu, then choose what to read: x, y, vx, vy, angle, scale, alpha, uid, name, tag, or one of that BP's variables (bool → 1/0). Wire the output into a CompareValues / branch / any input — no expressions.",
  RandomPick: "Random generator (pure node — no exec; rolls when an input pulls it). Build a string list (+add string) and a number list (+add number); wire the `string` and/or `number` output into any input — either works alone. Sync ON pairs them by index (apple→0, bread→15); Sync OFF rolls each independently.",
  RandomRange: "Random number in a RANGE (pure node — no exec; rolls when pulled). Set min and max; Whole = integer inclusive of both ends, Decimal = float. Wire the number output into any number input (SetVar value, etc.). Use this for ranges (0–100); use Random for picking from a fixed list.",
};

const AD = ACTION_DESCRIPTIONS as Record<string, string>;
const CD = CONDITION_DESCRIPTIONS as Record<string, string>;

/** [easy description, mini example] for nodes with no built-in code description. */
const FILL: Record<string, [string, string]> = {
  OnEveryNSeconds: ["Fires again and again on a timer.", "Every 2s → spawn an enemy."],
  OnSeparate: ["Fires when this object STOPS overlapping a tagged object.", "Leave the trigger zone → hide the prompt."],
  OnDoubleKeyPressed: ["Fires when a key is tapped twice quickly (double-tap).", "Double-tap Right → dash."],
  OnDamageTaken: ["Fires the moment this object takes damage.", "On hit → play the hurt animation."],
  OnHealed: ["Fires when this object is healed.", "On heal → flash green."],
  OnBlocked: ["Fires when an incoming attack is blocked (guarding).", "On block → spark + small knockback."],
  OnPartialBlock: ["Fires when a guarded hit is only PARTIALLY blocked (Guard Multiplier between 0 and 1) — some damage still got through (chip).", "On partial block → small spark + drain stamina."],
  OnDeath: ["Fires when this object's HP hits 0.", "On death → play death anim, then Destroy Self."],
  OnItemAdded: ["Fires when an item enters the inventory.", "Pick up a coin → update the HUD count."],
  OnItemRemoved: ["Fires when an item leaves the inventory.", "Use a potion → refresh the item list."],
  OnInventoryFull: ["Fires when the inventory has no free slots left.", "→ show a 'bag full' message."],
  OnTracerHit: ["Fires when THIS object's tracer (sight/attack line) hits something.", "Attack tracer hits an enemy → deal damage."],
  OnTracerLost: ["Fires when the tracer stops hitting what it was hitting.", "Lost line-of-sight → stop aiming."],
  OnTracedBy: ["Fires when ANOTHER object's tracer hits THIS one.", "Spotted by an enemy's sight → go alert."],
  OnUntracedBy: ["Fires when another object's tracer stops hitting this one.", "Out of enemy sight → relax."],
  OnComboStep: ["Fires on each step of an input combo.", "3-hit attack chain → step 1, 2, 3."],
  OnStateEnter: ["Fires the moment the State Machine ENTERS a named state.", "Enter 'attack' → turn the hitbox on."],
  OnStateMain: ["Fires every frame while a named state is active.", "While in 'run' → emit dust."],
  OnStateExit: ["Fires when LEAVING a named state.", "Leave 'attack' → turn the hitbox off."],
  OnArrived: ["Fires when a Move To reaches its destination.", "Arrived at point → wait, then move to the next."],
  OnNavFailed: ["Fires when pathfinding can't reach the target.", "No path → go idle."],
  OnPointArrived: ["Fires when arriving at a specific nav waypoint.", "Reach 'bush 3' → start eating."],
  OnAnyPointArrived: ["Fires when arriving at ANY nav waypoint.", "Reached a point → play a small bob."],
  OnTopdownDirectionChanged: ["Fires when a topdown character changes facing.", "Turn left → swap to the left-walk animation."],
  OnSquashStretchEnd: ["Fires when a squash/stretch effect finishes.", "Landing squash done → resume idle."],
  OnAnimatorAnimEnd: ["Fires when a Smart Tween animation finishes.", "Chest-open tween done → spawn loot."],
  OnTick: ["Fires every single frame (use sparingly).", "→ custom per-frame movement."],
  OnDialogueStart: ["Fires when a dialogue begins.", "→ freeze the player."],
  OnDialogueLine: ["Fires on each dialogue line shown.", "→ play a blip sound per line."],
  OnDialogueEnd: ["Fires when a dialogue finishes.", "→ unfreeze the player."],
  OnAIStateEnter: ["Fires when the AI Brain enters a state (idle/alert/chase/…).", "Enter 'chase' → speed up."],
  OnAIStateExit: ["Fires when the AI Brain leaves a state.", "Leave 'chase' → slow down."],
  OnTargetSighted: ["Fires the first frame the AI sees its target.", "Spot the player → alert + chase."],
  OnTargetLost: ["Fires when the AI loses sight of its target.", "Lost the player → search, then idle."],
  VarEquals: ["True when a variable EQUALS a value.", "hp == 0."],
  VarAbove: ["True when a variable is GREATER than a value.", "score > 100 → unlock bonus."],
  VarBelow: ["True when a variable is LESS than a value.", "hp < 20 → show low-health warning."],
  VarTrue: ["True when a boolean variable is ON.", "hasKey is true → open the door."],
  VarFalse: ["True when a boolean variable is OFF.", "isDead is false → allow input."],
  IsTargetSighted: ["True while the AI can currently see its target.", "Sighted → keep chasing."],
  DistanceToTargetBelow: ["True when the AI is closer than N pixels to its target.", "Distance < 50 → attack."],
  Branch: ["If / else. Wire a condition in; the TRUE path runs when true, the FALSE path otherwise.", "Branch(hp<20) → True: flee · False: attack."],
  Switch: ["Runs ONE of several paths based on a value.", "Switch(state) → 'red' / 'green' / 'blue'."],
  DoOnce: ["Lets the flow through only the FIRST time it runs.", "On Overlap → Do Once → show the tutorial once."],
  FlipFlop: ["Alternates between output A and B each time it runs.", "Press E → A: open · B: close."],
  Sequence: ["Runs its outputs in order, one after another.", "step 1 → step 2 → step 3."],
  Random: ["Picks ONE random output each time it runs.", "→ one of 3 random taunts."],
  Combinator: ["Merges several exec wires into one (OR).", "Either trigger → the same action."],
  And: ["Outputs true only when BOTH inputs are true.", "grounded AND jumpPressed → jump."],
  Or: ["Outputs true when EITHER input is true.", "onWall OR onFloor → can jump."],
  Not: ["Flips a boolean — true becomes false.", "NOT grounded → in the air."],
  Comment: ["A sticky note on the canvas. No effect on the game — just labels your logic.", "\"// enemy AI below\"."],
  IncrementVar: ["Adds an amount to a NUMBER variable (negative subtracts).", "coins += 1."],
  ToggleVar: ["Flips a BOOLEAN variable (true ↔ false).", "Toggle 'paused'."],
  DropObject: ["Spawns a blueprint at a position (like Create Object).", "Enemy dies → Drop a coin."],
  DebounceWait: ["Waits, but RESTARTS its timer if called again within the window.", "Fire only 0.3s after the player STOPS pressing."],
  WaitForAnim: ["Pauses the chain until the current animation finishes.", "Play attack → Wait For Animation → enable hitbox."],
  WaitForKeyPress: ["Pauses the chain until a key is pressed.", "Show 'Press any key' → Wait For Key Press → continue."],
  SetAIState: ["Forces the AI Brain into a state (idle/alert/chase/search/…).", "Heard a noise → Set AI State 'search'."],
  SetAITarget: ["Sets the AI's target by uid.", "Collide with player → chase that uid."],
  AlertNearbyAllies: ["Tells nearby tagged allies to react.", "Spotted the player → alert the other guards."],
  Literal: ["A fixed NUMBER you type in. Wire its out into any number input.", "5 → the speed pin of Set Velocity."],
  StringValue: ["A fixed TEXT you type in. Wire its out into any string input.", '"walk" → the animation name of Play Animation.'],
  VarRead: ["Reads a variable's VALUE. Wire its out into a Compare or a value pin.", "Read 'hp' → Branch(hp < 20)."],
  GetTracerField: ["Reads info about what a tracer hit (name, tags, x/y).", "→ Emit Signal To the hit object's tag."],
  GetLastNavPoint: ["Reads info about the last nav waypoint reached.", "→ compare its name."],
  GetSlotItem: ["Reads the item in an inventory slot (by index).", "Slot 0 → show its icon."],
  GetListValue: ["Reads a value from a list by index.", "List 'spawns'[2] → spawn it."],
  GetGlobalValue: ["Reads a GLOBAL variable (persists across scenes & saves).", "Read global 'day' → show on HUD."],
  GetOtherObject: ["Reads a field of the object you collided/overlapped with (name, tag, x, y, uid).", "→ Emit Signal To its tag."],
  GetTags: ["Reads this object's tags as comma-separated text.", "→ CompareText contains 'enemy'."],
  CountByTag: ["Counts how many objects currently have a tag.", "enemiesLeft = Count By Tag 'enemy'."],
  GetSceneName: ["Reads the current scene's name.", "→ Branch when name == 'Boss'."],
};

const KIND_EXAMPLE: Record<LogicGraphNode["kind"], string> = {
  trigger: "Start a chain here — when it fires, the wired nodes run.",
  condition: "Wire into a Branch (or use as a State rule). True → the true path runs.",
  branch: "Forks the flow — wire each output to a different path.",
  literal: "Type a value, wire its out into any matching input.",
  varRead: "Pick a variable; wire its out into a Compare or value pin.",
  getter: "Wire its output pin into a Branch / Compare / action input.",
  action: "Wire a trigger (or another node's exec out) into its exec input to run it.",
  comment: "A note on the canvas — no effect on the game.",
};

export function nodeDescription(type: string): string {
  return FILL[type]?.[0] || AD[type] || CD[type] || GETTER_DESCRIPTIONS[type] || "";
}

export function nodeExample(type: string, kind: LogicGraphNode["kind"]): string {
  return FILL[type]?.[1] || KIND_EXAMPLE[kind] || "";
}
