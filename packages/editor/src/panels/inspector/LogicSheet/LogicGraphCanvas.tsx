import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toggle } from "../../../components/Toggle";
import { useEditor } from "../../../store";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useNodeConnections,
  addEdge,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Node as RFNode,
  type Edge as RFEdge,
  type EdgeProps,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  BlueprintDef,
  BehaviorKind,
  LogicFolder,
  LogicGraphEdge,
  LogicGraphNode,
  UIWidgetDef,
  UIWidgetKind,
} from "../../../project";
import { BEHAVIOR_PARAMS } from "../../../behaviorMeta";
import { genericActionEntries, genericConditionEntries, COMPONENT_THEME, actionComponent, conditionComponent, triggerTheme, flowTheme, LABEL_OVERRIDES, CONDITION_PARAM_DEFAULTS } from "./nodeRegistry";
import { ACTION_DEFAULTS } from "@peaky/shared";
import { SignalPicker } from "../../../components/SignalPicker";
import { ColorField, isColorParamKey } from "../../../components/ColorField";
import { ExpressionPicker, type ExprGroup, type ExprObject, type ExprToken } from "../../../components/ExpressionPicker";
import { ComponentIcon } from "../../../componentIcons";
import { BigTilePreview } from "../../TilesetTab";
import { animFrameRegion } from "../../../project";

interface LogicGraphCanvasProps {
  folder: LogicFolder;
  bp: BlueprintDef;
  onChange: (folder: LogicFolder) => void;
}

export const PIN_COLORS: Record<string, string> = {
  exec:      "#ffffff",
  number:    "#4ade80", // green
  string:    "#f472d0", // pink
  boolean:   "#ff5a5a", // red
  spriteRef: "#b07bff",
  any:       "#cccccc", // gray — accepts any data type (e.g. Switch value)
};

/** Live ref to the active LogicGraphCanvas's splitEdge callback. Module-
 *  level so the custom edge component (also module-level, can't see the
 *  canvas component's hooks) can dispatch insertions. Updated in
 *  LogicGraphCanvas's useEffect. Only ONE canvas is mounted at a time —
 *  the modal-based editor swaps folders by remount — so a single ref is
 *  enough; otherwise a per-canvas Map would be needed. */
let _splitEdgeDispatch: ((edgeId: string, midX: number, midY: number) => void) | null = null;

/** Custom edge component for exec wires. Renders the default bezier path
 *  plus a small, faint "+" badge at the midpoint. Hover scales it up and
 *  the cursor switches to pointer. Click drops a DebugPrint node on the
 *  wire (between the source and target). Data wires use the default edge
 *  type so the badge only appears where it's actually useful (exec flow). */
function ExecEdgeWithInsert({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const [hover, setHover] = useState(false);
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            cursor: "pointer",
          }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={(e) => {
            e.stopPropagation();
            _splitEdgeDispatch?.(id, labelX, labelY);
          }}
          title="Add inline debug print on this wire"
        >
          <div
            style={{
              width: hover ? 18 : 12,
              height: hover ? 18 : 12,
              borderRadius: "50%",
              background: hover ? "#88ddff" : "rgba(136,221,255,0.45)",
              border: `1px solid ${hover ? "#88ddff" : "rgba(136,221,255,0.6)"}`,
              color: "#0a1a25",
              fontSize: hover ? 12 : 9,
              fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
              opacity: hover ? 1 : 0.5,
              transition: "all 0.12s ease",
              userSelect: "none",
              boxShadow: hover ? "0 1px 4px rgba(0,0,0,0.4)" : "none",
            }}
          >+</div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { execWithInsert: ExecEdgeWithInsert };

/**
 * Closed-set enum dropdowns used in `pickDropdown`. Every value in these
 * lists is something the engine recognizes — typing anything else into the
 * field silently no-ops at runtime, so we surface them as dropdowns to
 * make discoverability the default. Add new entries here when an engine
 * action / condition gains a new enum value.
 */
const ENUM_OPTIONS: Record<string, readonly string[]> = {
  // TracerGetResult — readable fields on a tracer. `hit*` / `actor*` come from
  // lastHit (whatever the trace caught). `startX/Y` and `endX/Y` come from the
  // line geometry — valid even when the trace didn't hit anything, so you can
  // dig / spawn / scan at the tracer's far end regardless of contact.
  field: ["hit", "hitX", "hitY", "actorX", "actorY", "actorName", "actorUid", "actorTags", "distance", "startX", "startY", "endX", "endY"],
  // Comparison operators — used by Compare, CompareValues, CompareCMParam,
  // CompareFrame, CompareTime, CompareCameraZoom, CompareParticleCount, etc.
  op: [">", "<", ">=", "<=", "==", "!="],
  textOp: ["==", "!=", "contains", "startsWith", "endsWith"],
  // Compare property — readable numeric sprite props for Compare condition.
  property: ["velocity.x", "velocity.y", "speed", "position.x", "position.y", "angle", "scale.x", "scale.y", "scale", "alpha", "depth", "is_grounded"],
  // Text alignment.
  alignH: ["left", "center", "right"],
  alignV: ["top", "center", "bottom"],
  // ParticleEmitter / Tracer enums.
  blendMode: ["NORMAL", "ADD", "MULTIPLY"],
  frameMode: ["first", "random"],
  pivotSource: ["host", "imagePoint", "framePivot", "manual"],
  shape: ["line", "box", "circle"],
  triggerMode: ["signal", "interval", "continuous"],
  // CharacterMovement setters.
  ceilingMode: ["stop", "preserve"],
  mirrorMode: ["off", "velocity", "input"],
  control: ["jump", "dash", "MoveLeft", "MoveRight"],
  // AI brain states (also surfaced as `state` via stateOptions; keeps
  // SetAIState's `state` field strict when no animator states exist).
  aiState: ["idle", "alert", "chase", "search", "attack", "flee", "rest"],
  // AIBrain patrolMode.
  patrolMode: ["none", "walls"],
  // SR.playAnimation `from` mode.
  from: ["beginning", "current"],
  // Mouse buttons (0=left, 1=middle, 2=right).
  button: ["0", "1", "2"],
  // Wheel direction.
  wheelDir: ["up", "down", "any"],
  // Cursor styles (CSS cursor values that the engine actually applies).
  cursor: ["default", "pointer", "crosshair", "none", "wait", "text", "move", "grab", "grabbing", "not-allowed"],
  // PlaySounds playback mode.
  playMode: ["random", "queue", "all"],
  // SetPaused — what to freeze.
  scope: ["all", "layer"],
  // UI widget element props (SetUIElement).
  align: ["left", "center", "right"],
  vAlign: ["top", "middle", "bottom"],
  direction: ["horizontal", "vertical"],
  // Shop role (Set UI Element on a Label/Button).
  shopRole: ["name", "buyPrice", "sellPrice", "buy", "sell"],
  // Projectile.mode override on FireProjectile.
  mode: ["straight", "homing", "aimed"],
};

/** A pickable UI-widget target for the `target` dropdown. `value` is what the
 *  action stores (widget/element name, or "" for the widget's own self). The
 *  label carries a glyph so authors can tell whole-widget (◆) from element
 *  (▸) entries at a glance. */
interface WidgetTarget {
  value: string;
  label: string;
  isWidget: boolean;
}

/** Runtime-settable params per widget kind, in display order. Each becomes a
 *  `set_<prop>` toggle + a `<prop>` value field on the SetUIElement node. The
 *  list is limited to props the UIWidgetRenderer re-applies live every tick
 *  (its layout() redraws from these fields) so no toggle here is dead. */
// Shared box/background props every kind exposes (drawn live by layout()).
const BOX_PROPS: { prop: string; def: unknown }[] = [
  { prop: "bgColor", def: 0xffffff }, { prop: "bgAlpha", def: 1 },
  { prop: "borderColor", def: 0x000000 }, { prop: "borderWidth", def: 0 },
  { prop: "cornerRadius", def: 0 }, { prop: "padding", def: 8 },
  { prop: "opacity", def: 1 },
];
// Text props for Label / Button / Dropdown.
const TEXT_PROPS: { prop: string; def: unknown }[] = [
  { prop: "fontFamily", def: "Arial" }, { prop: "fontSize", def: 16 },
  { prop: "fontColor", def: 0xffffff }, { prop: "fontBold", def: false },
  { prop: "fontItalic", def: false }, { prop: "align", def: "center" },
  { prop: "vAlign", def: "middle" },
];
// Shop role props — let a Label/Button be re-pointed at a different item or
// switched between roles at runtime (dynamic / rotating shops).
const SHOP_PROPS: { prop: string; def: unknown }[] = [
  { prop: "shopRole", def: "" }, { prop: "shopItem", def: "" }, { prop: "shopCurrency", def: "" },
];
const SETTABLE_BY_KIND: Record<UIWidgetKind, { prop: string; def: unknown }[]> = {
  Label:       [{ prop: "text", def: "" }, ...TEXT_PROPS, ...SHOP_PROPS, ...BOX_PROPS],
  Button:      [{ prop: "text", def: "" }, ...TEXT_PROPS, { prop: "hoverBgColor", def: 0xffffff }, { prop: "pressedBgColor", def: 0xffffff }, { prop: "enabled", def: true }, ...SHOP_PROPS, ...BOX_PROPS],
  Slider:      [{ prop: "value", def: 0 }, { prop: "min", def: 0 }, { prop: "max", def: 100 }, { prop: "direction", def: "horizontal" }, { prop: "fillColor", def: 0x44ddff }, { prop: "enabled", def: true }, ...BOX_PROPS],
  ProgressBar: [{ prop: "value", def: 0 }, { prop: "min", def: 0 }, { prop: "max", def: 100 }, { prop: "direction", def: "horizontal" }, { prop: "fillColor", def: 0x44ddff }, ...BOX_PROPS],
  Dropdown:    [{ prop: "selectedValue", def: "" }, ...TEXT_PROPS, { prop: "enabled", def: true }, ...BOX_PROPS],
  Image:       [{ prop: "spriteId", def: "" }, ...BOX_PROPS],
  Panel:       [...BOX_PROPS],
  Inventory:   [{ prop: "rows", def: 1 }, { prop: "cols", def: 5 }, ...BOX_PROPS],
  Crafting:    [{ prop: "rows", def: 1 }, { prop: "cols", def: 5 }, ...BOX_PROPS],
  CraftGrid:   [{ prop: "rows", def: 2 }, { prop: "cols", def: 2 }, ...BOX_PROPS],
  Shop:        [{ prop: "rows", def: 2 }, { prop: "cols", def: 4 }, { prop: "shopCurrency", def: "gold" }, ...BOX_PROPS],
};

/** Resolve a SetUIElement target value to the element's widget kind, honoring
 *  sheet scope (a widget's own sheet resolves "" to itself / its children). */
function resolveWidgetKind(targetValue: string, uiWidgets: UIWidgetDef[], hostId: string): UIWidgetKind | undefined {
  const owner = uiWidgets.find((w) => w.id === hostId);
  if (owner) {
    if (targetValue === "") return owner.mode === "multi" ? "Panel" : owner.kind;
    return (owner.children ?? []).find((c) => c.name === targetValue)?.kind;
  }
  for (const w of uiWidgets) {
    if (w.name === targetValue) return w.mode === "multi" ? "Panel" : w.kind;
    const child = (w.children ?? []).find((c) => c.name === targetValue);
    if (child) return child.kind;
  }
  return undefined;
}

/** Build the SetUIElement node's params for a freshly-picked target: the
 *  target plus a set_<prop>/<prop> pair for every prop the element's kind
 *  supports. Existing toggle states + values carry over so re-picking the
 *  same kind keeps the user's settings. */
function buildSetUIElementParams(targetValue: string, kind: UIWidgetKind | undefined, existing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { target: targetValue };
  for (const { prop, def } of (kind ? SETTABLE_BY_KIND[kind] : [])) {
    const setKey = `set_${prop}`;
    out[setKey] = typeof existing[setKey] === "boolean" ? existing[setKey] : false;
    out[prop] = prop in existing ? existing[prop] : def;
  }
  return out;
}

interface NodeData {
  label: string;
  /** Domain node `type` string (e.g. "EmitSignal", "OnSignal"). Read by
   *  ParamField to decide signal-picker mode (emit-side vs listen-side)
   *  and any other type-conditional renders. `label` is the display
   *  string; `nodeType` is the schema kind. */
  nodeType: string;
  params: Record<string, unknown>;
  /** Top-side execution INPUT handles. Most nodes have one (`"exec"`).
   *  Multi-input nodes like Combinator expose `in0..inN-1`. */
  inExec: { pin: string; label?: string }[];
  outExec: { pin: string; label?: string }[];
  inData: { pin: string; type: string; label?: string }[];
  outData: { pin: string; type: string; label?: string }[];
  isTrigger: boolean;
  varNames: string[];
  /** Variables filtered to type=bool — drives SetBool / ToggleBool pickers. */
  boolVarNames: string[];
  /** Variables filtered to type=number — drives SetVar / AddVar / SubVar pickers. */
  numberVarNames: string[];
  behaviorKinds: string[];
  inputActionNames: string[];
  signalNames: string[];
  /** Signal name → source label (hover) + grouped lists (optgroups) for the
   *  On Signal / Emit Signal dropdowns. */
  signalCatalog: { sources: Record<string, string>; groups: { label: string; names: string[] }[] };
  /** Declared project-level global variable names — drives the Set Global
   *  node's `global` dropdown. */
  globalVarNames: string[];
  /** Declared read-only List names — drives the Get List Item node's `list`
   *  dropdown. */
  listNames: string[];
  /** List name → its entry names — drives the Get List Item node's `key`
   *  (entry) dropdown, keyed off the sibling `list` selection. */
  listEntryNames: Record<string, string[]>;
  tagOptions: string[];
  /** BP name → that BP's tags (own + per-instance overrides). Drives the
   *  EditTags `oldTag` chip picker, filtered to the picked BP. */
  tagsByBp: Record<string, string[]>; varsByBp: Record<string, string[]>;
  animOptions: string[];
  /** spriteId → its animation names — for weapon actions to list the
   *  WEAPON sprite's anims instead of the host body's. */
  spriteAnimsById: Record<string, string[]>;
  /** Blueprint name → that BP's SpriteRenderer anims — lets the Drop node's
   *  animation dropdown list the SPAWNED blueprint's anims, not the host's. */
  spriteAnimsByBlueprintName: Record<string, string[]>;
  /** WeaponSlot name → its configured weapon spriteId, for PlayWeaponAnimation. */
  weaponSlotSpriteIds: Record<string, string>;
  /** Names of authored animations on the BP's Animator component(s) —
   *  drives the PlayAnimatorAnim / StopAnimatorAnim node `name` pickers. */
  animatorAnimNames: string[];
  stateOptions: string[];
  /** State Machine states that have combos — name + combo step count.
   *  Drives the On Combo Step trigger's state dropdown + steps multi-select. */
  comboStates: { name: string; steps: number }[];
  stateMachineNames: string[];
  dialogueNames: string[];
  tracerNames: string[];
  textNames: string[];
  componentsByKind: Record<string, string[]>;
  particleEmitterNames: string[];
  soundNames: string[];
  /** Project item names — drives the `item` param dropdown on inventory nodes. */
  itemNames: string[];
  /** Project recipe names — drives the `recipe` param dropdown on Craft/CanCraft. */
  recipeNames: string[];
  widgetNames: WidgetTarget[];
  /** Project sprites (id + name) — drives the SetUIElement Image sprite picker. */
  spriteOptions: { id: string; name: string }[];
  blueprintNames: string[];
  logicGroupNames: string[];
  layerNames: string[];
  sceneNames: string[];
  /** Named SpritePlacement instances on the ACTIVE scene. Drives the
   *  `placement` param dropdown on the Sprite-Object action family. */
  placementNames: string[];
  /** Tilemap ASSET names. Drives the `tilemap` param dropdown on tilemap
   *  actions / conditions. */
  tilemapNames: string[];
  /** Map of tilemap NAME → its internal LAYER NAMES. The `layer` param on a
   *  tilemap node reads its sibling `tilemap` value, then offers exactly
   *  that tilemap's layers (not the scene's parent layers). */
  tilemapLayersByName: Record<string, string[]>;
  /** Map of tilemap NAME → its tileset's BigTile defs. Drives `bigTileId`. */
  tilemapBigTilesByName: Record<string, { id: string; name?: string }[]>;
  /** Map of tilemap NAME → its tileset's AnimatedTile defs. Drives `animatedTileId`. */
  tilemapAnimatedTilesByName: Record<string, { id: string; name?: string }[]>;
  /** Every tag on a big/animated tile, across all tilesets. Drives Get Tagged
   *  Tile's `tag` dropdown (tile tags only — never sprite/BP tags). */
  tileTags: string[];
  /** Every nav-mesh waypoint name + tag across all scenes. Drives the
   *  nav-point / patrol dropdowns (waypoint names/tags only). */
  navPoints: string[];
  /** Map of BP NAME → its SpriteRenderer's image-point names (unique across
   *  every animation frame). Drives the "Image Points" sub-list in the
   *  ExpressionPicker — picked tokens are `var:<Object>.IP.<pointName>.x|y`. */
  imagePointsByBp: Record<string, string[]>;
  /** Host BP NAME — drives the `self` block in the ExpressionPicker so its
   *  own image points show as `var:self.IP.<pointName>.x|y`. */
  hostBpName: string;
  /** Host BP id for the logic sheet being edited — threaded into
   *  SignalPicker so cross-BP-invisible signals (foreign EmitSignal)
   *  get filtered out. */
  hostBpId: string;
  /** Resolved theme — header gradient, chip label/colors. Computed once
   *  per node from the node's `type` + `kind` so the renderer doesn't
   *  re-look-up the registry on every paint. */
  componentLabel: string;
  headerBg: string;
  chipBg: string;
  chipFg: string;
  // Wired in by the parent canvas via xyflow's data prop. Inline param
  // editors call these with the node's id + a partial patch / a no-arg
  // delete. Held inside data (not as React context) because xyflow
  // re-instantiates custom node components freely.
  onParamChange: (nodeId: string, patch: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  onToggleCollapse: (nodeId: string) => void;
  /** When true, render only the title bar (params + data pins hidden). */
  collapsed: boolean;
  nodeId: string;
}

// Nodes whose VALUE input pin adopts the type of the variable chosen in a
// sibling selector param — so Set Variable shows a number pin for a number
// var, a pink string pin for a string var, etc. (keyed: which param names the
// var, which pin carries the value).
export const VAR_VALUE_PINS: Record<string, { varKey: string; valuePin: string }> = {
  // Logic-node param keys (NOT the engine cfg keys). The friendly Set Var node
  // stores the variable under `var` (the runner maps it to engine cfg.name).
  SetVar: { varKey: "var", valuePin: "value" },
  SetGlobal: { varKey: "global", valuePin: "value" },
  SetVarOn: { varKey: "name", valuePin: "value" },
};

// Param keys whose value changes the node's PIN SHAPE (count / type / labels).
// Editing one triggers an immediate per-node data rebuild; everything else
// (free-text values, numbers) skips it so typing never loses input focus.
const SHAPE_PARAM_KEYS: ReadonlySet<string> = new Set([
  "name", "global", "var", "behavior", "params", "pinCount", "separate", "field", "target",
]);

export function nodeShape(node: LogicGraphNode, varTypes?: Map<string, "number" | "string" | "boolean">): Pick<NodeData, "label" | "params" | "inExec" | "outExec" | "inData" | "outData"> {
  if (node.kind === "comment") {
    // Pure-text annotation node — no pins, no exec, no data.
    return {
      label: "",
      params: node.params,
      inExec: [],
      outExec: [],
      inData: [],
      outData: [],
    };
  }
  if (node.kind === "trigger") {
    if (node.type === "OnComboStep" && node.params.separate) {
      // Separate-output mode: one exec out per selected step, pin `step_<n>`,
      // sorted ascending so handles keep a stable visual order.
      const steps = Array.isArray(node.params.steps) ? (node.params.steps as unknown[]) : [];
      const nums = steps
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n >= 1)
        .sort((a, b) => a - b);
      return {
        label: node.type,
        params: node.params,
        inExec: [],
        outExec: nums.map((n) => ({ pin: `step_${n}`, label: `step ${n}` })),
        inData: [],
        outData: [],
      };
    }
    if (node.type === "OnDialogueLine" && node.params.separate) {
      // Separate-output mode: one exec out per keyword, pin `kw_<i>` (array
      // index), so each matched keyword fires its own branch.
      const kws = Array.isArray(node.params.keywords) ? (node.params.keywords as unknown[]) : [];
      return {
        label: node.type,
        params: node.params,
        inExec: [],
        outExec: kws.map((k, i) => ({ pin: `kw_${i}`, label: String(k).trim() || "(keyword)" })),
        inData: [],
        outData: [],
      };
    }
    if (node.type === "OnEveryNSeconds") {
      // Interval is wireable (number pin) + accepts inline expressions
      // (random(2,5) / var:…). Resolved ONCE at subscribe time per sprite, so a
      // random() gives each instance its own cadence.
      return {
        label: node.type,
        params: node.params,
        inExec: [],
        outExec: [{ pin: "exec" }],
        inData: [{ pin: "interval", type: "number", label: "interval" }],
        outData: [],
      };
    }
    return {
      label: node.type,
      params: node.params,
      inExec: [],
      outExec: [{ pin: "exec" }],
      inData: [],
      outData: [],
    };
  }
  if (node.kind === "branch") {
    if (node.type === "Switch") {
      // UE5 "Switch on String" model: ONE value input pin, typed-in case
      // strings (configured in the node body), one output exec per case
      // plus a fixed `default` fallback. Wire any getter into `value`
      // (e.g., Get Collided Object Name) and the Switch routes to the
      // case whose typed string matches.
      const cases = Array.isArray(node.params.cases)
        ? (node.params.cases as { id: string; value: unknown }[]) : [];
      return {
        label: "Switch",
        params: node.params,
        inExec: [{ pin: "exec" }],
        outExec: [
          ...cases.map((c) => ({ pin: `case_${c.id}`, label: String(c.value ?? "") || "(empty)" })),
          { pin: "default", label: "default" },
        ],
        // `any` — the value is compared by string coercion at runtime
        // (String(raw) === case), so a number / bool / string getter can all
        // wire in. The validator only blocks mismatched PRIMITIVES, so `any`
        // accepts every source type.
        inData: [{ pin: "value", type: "any" }],
        outData: [],
      };
    }
    if (node.type === "DoOnce") {
      // Exec gate: forwards exec the FIRST time only, then blocks forever
      // (until the scene restarts). Put it between a repeating trigger and the
      // thing you want to happen exactly once.
      return {
        label: "Do Once",
        params: node.params,
        inExec: [{ pin: "exec" }],
        outExec: [{ pin: "out", label: "out" }],
        inData: [],
        outData: [],
      };
    }
    if (node.type === "FlipFlop") {
      // One exec in, two outs fired alternately A,B,A,B… per trigger.
      return {
        label: "Flip-Flop",
        params: node.params,
        inExec: [{ pin: "exec" }],
        outExec: [{ pin: "out0", label: "A" }, { pin: "out1", label: "B" }],
        inData: [],
        outData: [],
      };
    }
    if (node.type === "Sequence" || node.type === "Random") {
      // N outs; Sequence fires them in round-robin order, Random picks one at
      // random — one out per trigger. `count` sets how many outputs.
      const count = Math.max(2, Math.min(20, Math.floor(Number(node.params.count ?? 3))));
      return {
        label: node.type === "Sequence" ? "Sequence" : "Random Out",
        params: node.params,
        inExec: [{ pin: "exec" }],
        outExec: Array.from({ length: count }, (_, i) => ({ pin: `out${i}`, label: String(i + 1) })),
        inData: [],
        outData: [],
      };
    }
    return {
      label: node.type,
      params: node.params,
      inExec: [{ pin: "exec" }],
      outExec: [{ pin: "true", label: "true" }, { pin: "false", label: "false" }],
      inData: [{ pin: "bool", type: "boolean" }],
      outData: [],
    };
  }
  if (node.kind === "condition") {
    // Combinator is an exec-merge node: variable-arity exec INPUT pins
    // (in0..inN-1) feed a single exec output — ANY input fires the output
    // (OR). (AND would need cross-fire latching; not built, so the node is
    // honestly OR-only.)
    if (node.type === "Combinator") {
      const count = Math.max(2, Math.floor(Number(node.params.pinCount ?? 2)));
      return {
        label: "OR (merge)",
        params: node.params,
        inExec: Array.from({ length: count }, (_, i) => ({
          pin: `in${i}`, label: `${i + 1}`,
        })),
        outExec: [{ pin: "exec" }],
        inData: [],
        outData: [],
      };
    }
    return {
      label: node.type,
      params: node.params,
      inExec: [],
      outExec: [],
      inData: computeConditionInputPins(node),
      outData: [{ pin: "out", type: "boolean" }],
    };
  }
  if (node.kind === "getter") {
    if (node.type === "And" || node.type === "Or" || node.type === "Not") {
      // Boolean logic: wire conditions into a (+ b), feed `out` into a Branch.
      return {
        label: node.type === "And" ? "AND" : node.type === "Or" ? "OR" : "NOT",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: node.type === "Not"
          ? [{ pin: "a", type: "boolean" }]
          : [{ pin: "a", type: "boolean" }, { pin: "b", type: "boolean" }],
        outData: [{ pin: "out", type: "boolean" }],
      };
    }
    if (node.type === "RandomPick") {
      // Pure generator — no exec. A `string` output and a `number` output;
      // wire either (or both) into any data input. Sync pairs them by index.
      return {
        label: "Random",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "string", type: "string" },
          { pin: "number", type: "number" },
        ],
      };
    }
    if (node.type === "RandomRange") {
      // Pure generator — no exec. One number output rolled in [min, max].
      return {
        label: "Random Range",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "number", type: "number" }],
      };
    }
    if (node.type === "GetOtherObject") {
      // Multi-output "break" of the event's other sprite (collided/overlapped).
      return {
        label: "Get Collided Object",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "name", type: "string" },
          { pin: "tag", type: "string" },
          { pin: "instanceTag", type: "string" },
          { pin: "uid", type: "number" },
          { pin: "x", type: "number" },
          { pin: "y", type: "number" },
        ],
      };
    }
    if (node.type === "GetOverlappingObject") {
      // What the host is CURRENTLY overlapping, queried on demand (no collision
      // event needed) — e.g. press E → read the object you're standing on.
      // Optional `tag` narrows the match; empty = first current overlap.
      return {
        label: "Get Overlapping Object",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "name", type: "string" },
          { pin: "tag", type: "string" },
          { pin: "instanceTag", type: "string" },
          { pin: "uid", type: "number" },
          { pin: "x", type: "number" },
          { pin: "y", type: "number" },
        ],
      };
    }
    if (node.type === "GetHoveredObject") {
      // The topmost thing under the cursor, from any sheet. Category toggles
      // (bp / tiles / spriteObjects) decide what counts; `tag` filters; `kind`
      // output says which category was hit.
      return {
        label: "Get Hovered Object",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "name", type: "string" },
          { pin: "tag", type: "string" },
          { pin: "instanceTag", type: "string" },
          { pin: "kind", type: "string" },
          { pin: "uid", type: "number" },
          { pin: "x", type: "number" },
          { pin: "y", type: "number" },
        ],
      };
    }
    if (node.type === "GetDistance") {
      // Distance (px) from self to a target: picked / nearest-tag / named-BP /
      // mouse / point. Single number output — wire into CompareValues.
      return {
        label: "Get Distance",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: "number" }],
      };
    }
    if (node.type === "GetPicked") {
      // Reads ONE field/variable of the PICKED instance (the collided object,
      // or a ForEach/Pick result) via the `field` dropdown — no expressions.
      const field = String(node.params.field ?? "x");
      const outType = (field === "name" || field === "tag" || field === "instanceTag") ? "string" : "number";
      return {
        label: "Get Picked",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: outType }],
      };
    }
    if (node.type === "GetLastTile") {
      // Reads ONE field of the most-recently mined/hit tile (read after On Tile
      // Damaged / On Tile Destroyed) via the `field` dropdown — no expressions.
      const field = String(node.params.field ?? "x");
      const outType = (field === "tag" || field === "name" || field === "tilemap" || field === "layer") ? "string" : "number";
      return {
        label: "Get Last Tile",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: outType }],
      };
    }
    if (node.type === "GetLastDrop") {
      // Reads ONE field of the most-recent tile drop (read after On Tile Drop).
      const field = String(node.params.field ?? "bp");
      const outType = (field === "bp" || field === "layer") ? "string" : "number";
      return {
        label: "Get Last Drop",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: outType }],
      };
    }
    if (node.type === "GetTaggedTile") {
      // World position of a big/animated tile carrying `tag` — feed x AND y
      // (both from this one node) into MoveTo so an NPC walks to a "bush" tile,
      // then mine it. `count` reports how many such tiles exist.
      return {
        label: "Get Tagged Tile",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "x", type: "number" },
          { pin: "y", type: "number" },
          { pin: "count", type: "number" },
        ],
      };
    }
    if (node.type === "GetNavPoint") {
      // World position of a nav-mesh WAYPOINT matched by name/tag — feed x & y
      // into MoveTo NavPosition. `count` = how many match.
      return {
        label: "Get Nav Point",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [
          { pin: "x", type: "number" },
          { pin: "y", type: "number" },
          { pin: "count", type: "number" },
        ],
      };
    }
    if (node.type === "GetLastNavPoint") {
      // ONE field of the waypoint the NPC last arrived at — read after On Any
      // Point Arrived. `name` is a string, x/y are numbers.
      const field = String(node.params.field ?? "name");
      return {
        label: "Get Last Nav Point",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: field === "name" ? "string" : "number" }],
      };
    }
    if (node.type === "GetSlotItem") {
      // Reads the item NAME in a specific inventory slot — string data output.
      // `slot` is both an inline number field AND a data input pin, so the
      // index can be driven by a variable (Read variable → slot).
      return {
        label: "Get Slot Item",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [{ pin: "slot", type: "number" }],
        outData: [{ pin: "out", type: "string" }],
      };
    }
    if (node.type === "GetListValue") {
      // Read a named entry out of a read-only List (key→value group). `list`
      // picks the group, `key` the entry, `field` = value | length. Wire `out`
      // into any data input (SetVar value, CreateObject x/y, etc.).
      return {
        label: "Get List Item",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: "number" }],
      };
    }
    if (node.type === "GetGlobalValue") {
      // Read a global var / array. `index` is both an inline field and a data
      // input pin so it can be driven by a variable. `field` = value|item|length.
      return {
        label: "Get Global Value",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [{ pin: "index", type: "number" }],
        outData: [{ pin: "out", type: "number" }],
      };
    }
    if (node.type === "GetTags") {
      // CSV of the subject sprite's runtime tag list. Wire the output into
      // a CompareText (== / contains) or SetVar value (string variable).
      return {
        label: "Get Tags",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: "string" }],
      };
    }
    if (node.type === "GetSceneName") {
      // Name of the active Peaky scene. Wire into CompareText / SetVar /
      // SetUIText for "now entering: X" UI text without IsScene branches.
      return {
        label: "Get Scene Name",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: "string" }],
      };
    }
    if (node.type === "CountByTag") {
      // Live count of alive sprites carrying `tag`. Number output — feeds
      // SetVar value, CompareValues, or a HUD progress widget.
      return {
        label: "Count By Tag",
        params: node.params,
        inExec: [],
        outExec: [],
        inData: [],
        outData: [{ pin: "out", type: "number" }],
      };
    }
    // Data-only getter — `tracer` + `field` params, one typed output pin.
    // String type for `actorName`, number for everything else (hit, hitX,
    // hitY, actorX, actorY, actorUid, distance). Wire the output into
    // any data-input pin of a downstream node (SetVar value, EmitSignalTo
    // uid, CreateObject x/y, etc.).
    const field = String(node.params.field ?? "hitX");
    const outType = (field === "actorName" || field === "actorTags") ? "string" : "number";
    return {
      label: node.type,
      params: node.params,
      inExec: [],
      outExec: [],
      inData: [],
      outData: [{ pin: "out", type: outType }],
    };
  }
  if (node.kind === "literal" || node.kind === "varRead") {
    // Output pin color follows the value's real type: a string var / string
    // literal gets a pink string pin, a bool a red one — not a blanket number.
    const outType: "number" | "string" | "boolean" = node.kind === "varRead"
      ? (varTypes?.get(String(node.params.var ?? "")) ?? "number")
      : typeof node.params.value === "string" ? "string"
      : typeof node.params.value === "boolean" ? "boolean"
      : "number";
    return {
      label: node.type,
      params: node.params,
      inExec: [],
      outExec: [],
      inData: [],
      outData: [{ pin: "out", type: outType }],
    };
  }
  // Default — action nodes. Every value-shaped param gets a left-side
  // data input pin so authors can wire a getter's output into it
  // (e.g. GetTracerField.actorUid → EmitSignalTo.uid). Selector params
  // (variable names, tags, signals, enums) stay as inline dropdowns —
  // wiring a string into "which variable to set" doesn't make sense.
  const inData = computeActionInputPins(node);
  // Dynamic value pin: Set Variable / Set Global adopt the chosen variable's
  // type so the pin colors + type-checks against the var, not a fixed default.
  const dyn = VAR_VALUE_PINS[node.type];
  if (dyn && varTypes) {
    const vt = varTypes.get(String(node.params[dyn.varKey] ?? ""));
    if (vt) for (const p of inData) if (p.pin === dyn.valuePin) p.type = vt;
  }
  return {
    label: node.type,
    params: node.params,
    inExec: [{ pin: "exec" }],
    outExec: [{ pin: "exec" }],
    inData,
    outData: [],
  };
}

/**
 * Param keys that stay inline-only — NO input pin. These are CLOSED ENUMS
 * (op, ease, alignH, blendMode, …) and config TOGGLES (override, affectPhysics).
 * Wiring an arbitrary string into a fixed-choice enum or a checkbox doesn't make
 * semantic sense. Reference selectors (var / tag / signal / name / animation /
 * object / …) are NOT here — they get a data input pin AND keep their inline
 * dropdown as the unwired default, so authors can drive them dynamically
 * (Unreal-Blueprint style). The runtime already prefers a wired value over the
 * inline param (LogicSheetRunner `resolve`), so this is purely an editor gate.
 */
export const ENUM_PARAM_KEYS: ReadonlySet<string> = new Set([
  // Closed enums
  "field", "op", "varOp", "textOp", "property", "alignH", "alignV", "blendMode",
  "frameMode", "pivotSource", "shape", "triggerMode", "ceilingMode",
  "mirrorMode", "control", "aiState", "patrolMode", "from", "button",
  "wheelDir", "cursor", "ease", "mode", "kind",
  // Toggles — inline checkboxes, never wired.
  "override", "affectPhysics", "affectParticles", "forceRestart",
]);

// Action node type → the one value param that should accept ANY source (the
// runtime String()-coerces it, so a number/distance/count can be wired in and
// printed/shown). Without this the field is a string pin that rejects numbers.
const ANY_VALUE_PIN: Record<string, string> = {
  PrintString: "message",
  Log: "message",
  SetText: "text",
  AppendText: "text",
  SetUIText: "text",
};

export function computeActionInputPins(node: LogicGraphNode): { pin: string; type: string; label?: string }[] {
  // SetUIElement is edited entirely inline (per-element toggles); exposing a
  // data pin for every param — including the internal `set_*` toggles — just
  // produces a wall of meaningless pins. Any dynamic value can still be an
  // inline expression (var:…), so no pins are needed.
  if (node.type === "SetUIElement") return [];
  // Set Component Param: `params` is a multi-row ARRAY — pinning the array
  // itself replaced it (collapse + break). Expose one pin PER ROW (pval_<idx>,
  // labeled by the param name), typed by that component param's declared kind
  // in BEHAVIOR_PARAMS — so a string param like a weapon's Image Point gets a
  // string pin, not a number one. Unknown / numeric params default to number.
  if (node.type === "SetBehaviorParam") {
    const rows = Array.isArray(node.params.params) ? node.params.params : [];
    const metaList = BEHAVIOR_PARAMS[String(node.params.behavior ?? "") as BehaviorKind] ?? [];
    return rows.map((r, i) => {
      const key = String((r as { param?: unknown }).param ?? "");
      const t = metaList.find((m) => m.key === key)?.type;
      const type = t === "bool" ? "boolean"
        : (t === "number" || t === "varRefNumber" || t === undefined) ? "number"
        : "string";
      return { pin: `pval_${i}`, type, label: key || `value ${i + 1}` };
    });
  }
  const defaults = (ACTION_DEFAULTS as Record<string, Record<string, unknown>>)[node.type] ?? {};
  const out: { pin: string; type: string; label?: string }[] = [];
  for (const [key, val] of Object.entries(node.params)) {
    if (ENUM_PARAM_KEYS.has(key)) continue;
    // Text-display actions String()-coerce their value at runtime, so the
    // message/text field should accept a NUMBER (or anything) source — e.g.
    // print a distance / count. A string pin blocked wiring a numeric getter.
    if (ANY_VALUE_PIN[node.type] === key) {
      out.push({ pin: key, type: "any", label: key });
      continue;
    }
    // Pin type is the param's CANONICAL type (from ACTION_DEFAULTS), not the
    // live value — so a numeric field (frame, scale, x…) stays a number pin
    // even when the author types an inline expression like random(0,5) into
    // it, which makes the live value a string. Falls back to the live value
    // for params that have no default entry (dynamic/spawn-derived keys).
    const ref = key in defaults ? defaults[key] : val;
    let type: string;
    if (typeof ref === "number") type = "number";
    else if (typeof ref === "boolean") type = "boolean";
    else type = "string";
    out.push({ pin: key, type, label: key });
  }
  return out;
}

/** Mirror of computeActionInputPins for condition nodes. Every typed
 *  param gets a wireable input pin so authors can drive comparisons /
 *  predicates from getters (e.g. wire `picked.instanceTag` into
 *  `CompareValues.left`). Enum-shaped params keep their dropdown only. */
export function computeConditionInputPins(node: LogicGraphNode): { pin: string; type: string; label?: string }[] {
  const defaults = (CONDITION_PARAM_DEFAULTS as Record<string, Record<string, unknown>>)[node.type] ?? {};
  const out: { pin: string; type: string; label?: string }[] = [];
  for (const [key, val] of Object.entries(node.params)) {
    if (ENUM_PARAM_KEYS.has(key)) continue;
    // CompareValues compares two ARBITRARY expressions — its left/right accept
    // a number OR string source (the runtime coerces: numeric compare when both
    // parse as numbers, else string). Type them `any` so a numeric getter (Get
    // Distance, Count By Tag, var reads) can wire in — string pins blocked it.
    if (node.type === "CompareValues" && (key === "left" || key === "right")) {
      out.push({ pin: key, type: "any", label: key });
      continue;
    }
    // Canonical type (from CONDITION_PARAM_DEFAULTS) keeps a numeric compare
    // value a number pin even when an inline expression is typed in. See
    // computeActionInputPins for the rationale.
    const ref = key in defaults ? defaults[key] : val;
    let type: string;
    if (typeof ref === "number") type = "number";
    else if (typeof ref === "boolean") type = "boolean";
    else type = "string";
    out.push({ pin: key, type, label: key });
  }
  return out;
}

function LogicNodeView({ data, selected }: { data: NodeData; selected?: boolean }) {
  const { isTrigger, nodeId, params, varNames, onParamChange, onDelete, onToggleCollapse, collapsed, label } = data;
  // Which input (target) handles currently have a wire. A wired param shows
  // its pin + label but HIDES the inline editor — the value comes from the
  // wire (Unreal-Blueprint style). Updates live as wires connect/disconnect.
  const connections = useNodeConnections({ handleType: "target" });
  const wiredPins = useMemo(() => {
    const s = new Set<string>();
    for (const c of connections) if (c.targetHandle) s.add(c.targetHandle);
    return s;
  }, [connections]);
  // Visual BigTile / Animated-tile picker source. Resolve the chosen tilemap →
  // its tilesets (primary + extras, fall back to all), then list each BigTile /
  // animated tile with its owning tileset so we can render a real thumbnail via
  // BigTilePreview. Hooks run unconditionally to keep hook order stable.
  const allTilemaps = useEditor((s) => s.project.tilemaps);
  const allTilesets = useEditor((s) => s.project.tilesets);
  const tilePicker = useMemo(() => {
    const isBig = "bigTileId" in params, isAnim = "animatedTileId" in params;
    if (!TILEMAP_NODE_TYPES.has(data.nodeType) || (!isBig && !isAnim)) return null;
    const tm = (allTilemaps ?? []).find((m) => m.name === String(params.tilemap ?? ""));
    const ids = tm ? [tm.tilesetId, ...((tm.extraTilesetIds ?? []))] : [];
    let sets = ids.map((id) => (allTilesets ?? []).find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
    if (sets.length === 0) sets = (allTilesets ?? []);
    const kind: "big" | "anim" = isBig ? "big" : "anim";
    const items = sets.flatMap((ts) => kind === "big"
      ? (ts.bigTiles ?? []).map((bt) => ({ ts, id: bt.id, name: (bt as { name?: string }).name, region: bt }))
      : (ts.animatedTiles ?? []).filter((a) => (a.frames?.length ?? 0) > 0).map((a) => ({ ts, id: a.id, name: a.name, region: animFrameRegion(a.frames[0], ts.cols) })));
    return { kind, items };
  }, [allTilemaps, allTilesets, data.nodeType, params]);
  // Comment nodes render as a transparent yellow note with an inline
  // editable textarea — no header, no pins, no body grid.
  if (label === "" && "text" in params) {
    return (
      <div style={{
        minWidth: 220, minHeight: 100,
        background: "rgba(243, 210, 74, 0.12)",
        border: selected
          ? "2px solid #ffcd3c"
          : "1px dashed rgba(243, 210, 74, 0.5)",
        borderRadius: 6,
        color: "#f3d24a",
        fontSize: 12, lineHeight: 1.4,
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Drag handle bar — the only part that initiates xyflow's
            node drag (textarea has nodrag, so without this header
            there'd be no way to move the comment). */}
        <div style={{
          height: 18,
          background: "rgba(243, 210, 74, 0.25)",
          borderBottom: "1px dashed rgba(243, 210, 74, 0.35)",
          cursor: "grab",
          display: "flex", alignItems: "center",
          padding: "0 6px",
          fontSize: 9, color: "rgba(243, 210, 74, 0.7)",
          letterSpacing: 0.5, textTransform: "uppercase",
        }}>
          <span style={{ flex: 1 }}>≡ Comment</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(nodeId); }}
            title="Delete comment"
            className="nodrag"
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 14, height: 14, padding: 0, lineHeight: "12px",
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 2, color: "#f0f0f0",
              cursor: "pointer", fontSize: 9,
            }}
          >×</button>
        </div>
        <textarea
          value={String(params.text ?? "")}
          onChange={(e) => onParamChange(nodeId, { text: e.target.value })}
          className="nodrag nowheel"
          onMouseDown={(e) => e.stopPropagation()}
          rows={3}
          style={{
            width: "100%", minHeight: 70,
            background: "transparent",
            border: "none", outline: "none",
            color: "#f3d24a", fontSize: 12,
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            resize: "both",
            padding: 8, paddingTop: 4,
            boxSizing: "border-box",
          }}
        />
      </div>
    );
  }
  // Header gradient + chip come from the registry-resolved theme so each
  // node visually advertises which subsystem owns it.
  const headerBg = data.headerBg;
  // When a node has an `override` boolean param and it's off, collapse
  // the inline editor — hide every other param EXCEPT the always-visible
  // ones (`count` for BurstParticles). Authors flip the toggle on to
  // expand and edit the full override set. Matches the "compact when
  // off / expanded when on" UX request.
  const hasOverrideToggle = "override" in params;
  const overrideOn = hasOverrideToggle && !!params.override && params.override !== 0;
  // Params that stay visible even when `override` is off — these aren't
  // particle-config tweaks, they're WHO the action targets / HOW many
  // particles fire, which the author needs to pick whether or not they
  // also want to override the emitter's authored config.
  const ALWAYS_VISIBLE_WHEN_OVERRIDE_OFF = new Set(["override", "count", "target"]);
  // SetUIVisible: in toggle mode the explicit `visible` value is meaningless
  // (it flips current visibility), so hide it; show it only in set mode.
  const hideVisibleForToggle = (data.nodeType === "SetUIVisible" || data.nodeType === "SetVisible") && params.mode === "toggle";
  // EditTags: only the fields needed for the current mode render.
  //   insert  → just the new tag (free text + expressions).
  //   remove  → just oldTag (chip dropdown of existing project tags).
  //   replace → both oldTag AND tag.
  const editMode = data.nodeType === "EditTags" ? String(params.mode ?? "insert") : "";
  const hideEditTagsTag    = editMode === "remove";   // only remove mode hides the NEW tag
  const hideEditTagsOldTag = editMode === "insert";   // only insert mode hides the OLD tag
  // Tween: only show the picker field that matches the current targetKind.
  // Self has nothing to pick. spriteObject → spriteId. bp → bp. bpTag → targetTag.
  const tweenTargetKind = data.nodeType === "Tween" ? String(params.targetKind ?? "self") : "";
  const hideTweenSpriteId = tweenTargetKind !== "" && tweenTargetKind !== "spriteObject";
  const hideTweenBp       = tweenTargetKind !== "" && tweenTargetKind !== "bp";
  const hideTweenTargetTag= tweenTargetKind !== "" && tweenTargetKind !== "bpTag";
  // Drop node: the `frame` picker only matters in Static mode (freeze on that
  // frame). In Animation mode the animation plays, so hide frame.
  const dropMode = data.nodeType === "DropObject" ? String(params.mode ?? "animation") : "";
  const hideDropFrame = data.nodeType === "DropObject" && dropMode !== "static";
  // SetScreenEffect: the `layer` picker only applies when target = layer.
  const hideEffectLayer = data.nodeType === "SetScreenEffect" && String(params.target ?? "screen") !== "layer";
  // Mine/DamageTileAtWorld: when a `tracer` is chosen the action mines every
  // tile that tracer's geometry overlaps, so the single-point x/y AND the
  // box w/h are all ignored (tracer > w/h > self-hitbox) — hide them.
  const hideMineXY = (data.nodeType === "MineTileAtWorld" || data.nodeType === "DamageTileAtWorld")
    && String(params.tracer ?? "") !== "";
  // Get Distance: show only the field that matches the chosen from/to modes.
  const isGetDistance = data.nodeType === "GetDistance";
  const distTo = isGetDistance ? String(params.distTo ?? "picked") : "";
  const distFrom = isGetDistance ? String(params.distFrom ?? "self") : "";
  const hideDistTag = isGetDistance && distTo !== "tag";
  const hideDistBp  = isGetDistance && distTo !== "bp";
  const hideDistInstance = isGetDistance && distTo !== "instance";
  const hideDistInstanceFrom = isGetDistance && distFrom !== "instance";
  const hideDistXY  = isGetDistance && distTo !== "point";
  // Render exactly the node's OWN saved params — do NOT merge ACTION_DEFAULTS
  // keys in. Friendly nodes remap their schema (SetVar uses `var`, EmitSignal
  // uses `signal`) so a blind merge surfaced phantom fields (`name`, etc.) and
  // duplicate pickers. New palette params reach existing nodes via re-add, not
  // a merge.
  const paramKeys = Object.keys(params).filter((k) =>
    k !== "spawnVars" // rendered by the dedicated spawn-var editor below
    && (!hasOverrideToggle || overrideOn || ALWAYS_VISIBLE_WHEN_OVERRIDE_OFF.has(k))
    && !(hideVisibleForToggle && k === "visible")
    && !(hideEditTagsTag && k === "tag")
    && !(hideEditTagsOldTag && k === "oldTag")
    && !(hideTweenSpriteId  && k === "spriteId")
    && !(hideTweenBp        && k === "bp")
    && !(hideTweenTargetTag && k === "targetTag")
    && !(hideDropFrame && k === "frame")
    && !(hideEffectLayer && k === "layer")
    && !(hideMineXY && (k === "x" || k === "y" || k === "w" || k === "h"))
    && !(hideDistTag && k === "tag")
    && !(hideDistBp && k === "bp")
    && !(hideDistInstance && k === "instance")
    && !(hideDistInstanceFrom && k === "instanceFrom")
    && !(hideDistXY && (k === "x" || k === "y"))
    // Get Hovered Object's category flags render as checkboxes in their own
    // section below, not as raw 1/0 fields here.
    && !(data.nodeType === "GetHoveredObject" && (k === "bp" || k === "tiles" || k === "spriteObjects" || k === "widgets"))
  );
  // Shared bag of dropdown/option props every ParamField needs — spread into
  // each so both the generic loop and the custom SetUIElement section stay in
  // sync without repeating ~20 props.
  const sharedParamProps = {
    siblingParams: params, nodeType: data.nodeType, varNames,
    boolVarNames: data.boolVarNames, numberVarNames: data.numberVarNames,
    animatorAnimNames: data.animatorAnimNames, behaviorKinds: data.behaviorKinds,
    inputActionNames: data.inputActionNames, signalNames: data.signalNames, signalCatalog: data.signalCatalog,
    globalVarNames: data.globalVarNames, listNames: data.listNames, listEntryNames: data.listEntryNames,
    tagOptions: data.tagOptions, tagsByBp: data.tagsByBp, varsByBp: data.varsByBp, animOptions: data.animOptions,
    spriteAnimsById: data.spriteAnimsById, spriteAnimsByBlueprintName: data.spriteAnimsByBlueprintName, weaponSlotSpriteIds: data.weaponSlotSpriteIds,
    stateOptions: data.stateOptions, comboStates: data.comboStates, stateMachineNames: data.stateMachineNames, dialogueNames: data.dialogueNames,
    tracerNames: data.tracerNames, textNames: data.textNames, componentsByKind: data.componentsByKind, particleEmitterNames: data.particleEmitterNames,
    soundNames: data.soundNames, itemNames: data.itemNames, recipeNames: data.recipeNames, widgetNames: data.widgetNames,
    spriteOptions: data.spriteOptions,
    blueprintNames: data.blueprintNames, logicGroupNames: data.logicGroupNames, layerNames: data.layerNames,
    sceneNames: data.sceneNames,
    placementNames: data.placementNames,
    tilemapNames: data.tilemapNames, tilemapLayersByName: data.tilemapLayersByName,
    tilemapBigTilesByName: data.tilemapBigTilesByName, tilemapAnimatedTilesByName: data.tilemapAnimatedTilesByName,
    tileTags: data.tileTags, navPoints: data.navPoints,
    imagePointsByBp: data.imagePointsByBp, hostBpName: data.hostBpName,
    hostBpId: data.hostBpId,
  };
  const isSetUIElement = data.nodeType === "SetUIElement";
  // SetUIElement is dynamic: its `set_<prop>` keys (rebuilt when the target
  // changes) decide which property rows the node shows.
  const setUIProps = isSetUIElement
    ? Object.keys(params).filter((k) => k.startsWith("set_")).map((k) => k.slice(4))
    : [];
  // FireProjectile uses the SAME toggle pattern as SetUIElement for its
  // per-shot Projectile-component overrides — each `ovrXxx` flag pairs
  // with an `xxx` value field. Off (flag = 0) → field hidden, BP's
  // Projectile authored value used at runtime. On (flag = 1) → value
  // field appears for editing. List declares essential spawn-time params
  // first (BP, position, aim, target, etc. — non-toggleable, always
  // visible) then the override pairs in display order.
  const isFireProjectile = data.nodeType === "FireProjectile";
  // FireProjectile mirrors the Projectile component: ONE essential field
  // (which BP to fire) plus a toggle for each component parameter below.
  // All toggles default OFF — the bullet uses the BP's authored values.
  const FIREPROJ_ESSENTIAL = ["blueprintName", "spawnImagePoint"];
  const FIREPROJ_OVERRIDES: Array<{ flag: string; key: string }> = [
    { flag: "ovrMode",             key: "mode" },
    { flag: "ovrAngle",            key: "angle" },
    { flag: "ovrSpeed",            key: "speed" },
    { flag: "ovrLifetime",         key: "lifetime" },
    { flag: "ovrGravityX",         key: "gravityX" },
    { flag: "ovrGravityY",         key: "gravityY" },
    { flag: "ovrTargetTags",       key: "targetTags" },
    { flag: "ovrHitSignal",        key: "hitSignal" },
    { flag: "ovrDestroyOnHit",     key: "destroyOnHit" },
    { flag: "ovrRotateToVelocity", key: "rotateToVelocity" },
    { flag: "ovrDamage",           key: "damage" },
    { flag: "ovrKnockbackX",       key: "knockbackX" },
    { flag: "ovrKnockbackY",       key: "knockbackY" },
    { flag: "ovrHitboxW",          key: "hitboxW" },
    { flag: "ovrHitboxH",          key: "hitboxH" },
    { flag: "ovrHomingTurnRate",   key: "homingTurnRate" },
  ];
  return (
    <div style={{
      minWidth: 220, maxWidth: 244, fontSize: 11, color: "#fff",
      border: selected
        ? "2px solid #ffcd3c"
        : "1px solid rgba(255,255,255,0.2)",
      borderRadius: 6, background: "#1a1a1a",
      boxShadow: selected
        ? "0 0 0 1px rgba(255,205,60,0.4), 0 2px 8px rgba(0,0,0,0.4)"
        : "0 2px 8px rgba(0,0,0,0.4)",
      overflow: "hidden",
    }}>
      {data.inExec.length > 0 && (
        <div style={{ position: "relative", height: 6 }}>
          {data.inExec.map((p, i) => {
            // Distribute multiple inputs evenly across the top edge.
            // Single-input nodes get a centered handle (the default).
            const pct = data.inExec.length === 1 ? 50 : (100 / (data.inExec.length + 1)) * (i + 1);
            return (
              <Handle
                key={p.pin}
                type="target"
                position={Position.Top}
                id={p.pin}
                style={{
                  background: PIN_COLORS.exec,
                  width: 10, height: 10,
                  border: "1px solid #000",
                  left: `${pct}%`, transform: "translate(-50%, -50%)",
                }}
              />
            );
          })}
        </div>
      )}
      <div style={{
        padding: collapsed ? "8px 10px" : "6px 10px", background: headerBg,
        fontWeight: 600, borderBottom: collapsed ? "none" : "1px solid rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        {/* Collapse / expand toggle — folds the node down to just this
            title bar (params + data pins hidden), exec handles preserved. */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(nodeId); }}
          title={collapsed ? "Expand" : "Collapse"}
          className="nodrag"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: 16, height: 16, padding: 0, lineHeight: "14px", flexShrink: 0,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 3, color: "#f0f0f0",
            cursor: "pointer", fontSize: 9,
          }}
        >{collapsed ? "▸" : "▾"}</button>
        <span title={LABEL_OVERRIDES[data.label] ?? data.label} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: collapsed ? 13 : undefined }}>{LABEL_OVERRIDES[data.label] ?? data.label}</span>
        {/* Component chip — tells the author "this node lives on
            <component>". Trigger gets a Trigger chip; flow/util nodes
            get the generic Flow chip. SVG icon prefix (if the chip's
            label matches a /files/<Kind>.svg) replaces the kind text. */}
        <span
          title={`${data.componentLabel} node`}
          style={{
            background: data.chipBg,
            color: data.chipFg,
            fontSize: 8.5,
            padding: "1px 6px",
            borderRadius: 3,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 700,
            whiteSpace: "nowrap",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            maxWidth: 96,
            minWidth: 0,
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <ComponentIcon kind={data.componentLabel} size={11} style={{ filter: "brightness(0.2)", flexShrink: 0 }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.componentLabel}</span>
        </span>
        {!isTrigger && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(nodeId); }}
            title="Delete node"
            className="nodrag"
            style={{
              width: 18, height: 18, padding: 0, lineHeight: "16px",
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 3, color: "#f0f0f0",
              cursor: "pointer", fontSize: 10,
            }}
          >×</button>
        )}
      </div>
      {/* When COLLAPSED, still render the handles for any WIRED input pins —
          xyflow drops an edge whose endpoint handle no longer exists, so hiding
          the body would silently disconnect wired values. This keeps just those
          pins (label + handle) visible so the wires survive a collapse. */}
      {collapsed && data.inData.some((p) => wiredPins.has(p.pin)) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 10px 4px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
          {data.inData.filter((p) => wiredPins.has(p.pin)).map((p) => (
            <div key={p.pin} style={{ position: "relative", paddingLeft: 16, minHeight: 14, display: "flex", alignItems: "center", fontSize: 9, color: "#7fd0ff", textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Handle type="target" position={Position.Left} id={p.pin}
                style={{ background: PIN_COLORS[p.type] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{paramLabel(p.pin, data.nodeType)} (wired)</span>
            </div>
          ))}
        </div>
      )}
      {!collapsed && !isSetUIElement && !isFireProjectile && (paramKeys.length > 0 || data.inData.length > 0) && (
        <div style={{
          padding: "8px 10px 8px 0", display: "flex", flexDirection: "column", gap: 6,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          {/* Pure-wire inputs (no editable field) render FIRST — e.g.
              Switch's `value` belongs ABOVE the cases list so the input
              source for the comparison is visually at the top of the
              node (matches UE5's Switch on String / Branch layout). */}
          {data.inData.filter((p) => !(p.pin in params)
            // SetBehaviorParam's per-row value pins (pval_<i>) render INSIDE
            // each param row of the editor below, aligned [pin | name | value]
            // — not as a separate list up here.
            && !(data.nodeType === "SetBehaviorParam" && p.pin.startsWith("pval_"))).map((p) => (
            <div key={p.pin} style={{ position: "relative", paddingLeft: 16, minHeight: 16, display: "flex", alignItems: "center", fontSize: 9, color: "#f0f0f0", textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Handle type="target" position={Position.Left} id={p.pin}
                style={{ background: PIN_COLORS[p.type] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }} />
              <span>{p.label ?? p.pin}</span>
            </div>
          ))}
          {/* Each param sits on one row with its input pin on the left edge of
              that row (react-flow centers the Left handle in its position:relative
              ancestor). A wired pin hides the inline editor — the wire drives it. */}
          {paramKeys.map((k) => {
            const pin = data.inData.find((p) => p.pin === k);
            const wired = !!pin && wiredPins.has(k);
            return (
              <div key={k} style={{ position: "relative", paddingLeft: 16, minHeight: 16, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                {pin && (
                  <Handle type="target" position={Position.Left} id={k}
                    style={{ background: PIN_COLORS[pin.type] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }} />
                )}
                {wired ? (
                  <span style={{ fontSize: 9, color: "#f0f0f0", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {paramLabel(k, data.nodeType)} <span style={{ color: "#7fd0ff" }}>(wired)</span>
                  </span>
                ) : (
                  <ParamField
                    paramKey={k}
                    value={params[k]}
                    {...sharedParamProps}
                    onChange={(v) => onParamChange(nodeId, { [k]: v })}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {!collapsed && (data.nodeType === "CreateObject" || data.nodeType === "CreateObjectByName" || data.nodeType === "DropObject") && (() => {
        // "Set on spawn" — pick any of the spawned blueprint's variables and a
        // value (literal, self.uid, expression). Stored in params.spawnVars; the
        // runtime sets each ONLY on the freshly-spawned instance.
        const targetBp = String(params.bp ?? params.blueprintName ?? "");
        const allVars: string[] = data.varsByBp[targetBp] ?? [];
        const sv = (params.spawnVars as Record<string, string> | undefined) ?? {};
        const rows = Object.entries(sv);
        const setSV = (next: Record<string, string>) => onParamChange(nodeId, { spawnVars: Object.keys(next).length ? next : undefined });
        const unused = allVars.filter((v) => !(v in sv));
        const SEL: React.CSSProperties = { fontSize: 10, padding: "2px 4px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 3, color: "#f0f0f0" };
        return (
          <div className="nodrag" style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 5, borderBottom: "1px solid rgba(255,255,255,0.05)" }} onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 9, color: "#9bd0ff", textTransform: "uppercase", letterSpacing: 0.5 }}>Set on spawn</div>
            {!targetBp && <div style={{ fontSize: 9, color: "#888", fontStyle: "italic" }}>pick a blueprint first</div>}
            {rows.map(([name, val]) => (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <select value={name} style={{ ...SEL, flex: "0 0 auto", maxWidth: 110 }}
                  onChange={(e) => { const nn = e.target.value; if (nn === name) return; const next = { ...sv }; delete next[name]; next[nn] = val; setSV(next); }}>
                  <option value={name}>{name}</option>
                  {unused.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <span style={{ color: "#888", fontSize: 10 }}>=</span>
                <input value={val} placeholder="self.uid · 5 · random(1,3)" style={{ ...SEL, flex: 1, minWidth: 0 }}
                  onChange={(e) => setSV({ ...sv, [name]: e.target.value })} />
                <button onClick={() => { const next = { ...sv }; delete next[name]; setSV(next); }}
                  style={{ background: "transparent", border: "none", color: "#e87", cursor: "pointer", fontSize: 13 }}>×</button>
              </div>
            ))}
            {targetBp && (
              unused.length > 0
                ? <button onClick={() => setSV({ ...sv, [unused[0]]: "" })} style={{ ...SEL, cursor: "pointer", color: "#9af0b5", textAlign: "left" }}>+ set var</button>
                : allVars.length === 0 ? <div style={{ fontSize: 9, color: "#888", fontStyle: "italic" }}>this blueprint has no variables</div> : null
            )}
          </div>
        );
      })()}
      {!collapsed && isSetUIElement && (
        <div style={{
          padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          {/* Element picker — changing this rebuilds the rows below for the
              selected element's kind (handled in handleParamChange). */}
          <ParamField
            paramKey="target"
            value={params.target}
            {...sharedParamProps}
            onChange={(v) => onParamChange(nodeId, { target: v })}
          />
          {setUIProps.length === 0 ? (
            <div style={{ fontSize: 9, color: "#888", lineHeight: 1.4 }}>
              Pick an element above — its properties appear here.
            </div>
          ) : setUIProps.map((prop) => {
            const on = !!params[`set_${prop}`];
            return (
              <div key={prop} style={{ display: "flex", alignItems: "flex-start", gap: 8, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 6, marginTop: 2 }}>
                <Toggle
                  className="nodrag"
                  value={on}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(v) => onParamChange(nodeId, { [`set_${prop}`]: v })}
                  style={{ flexShrink: 0, margin: 0, marginTop: 1, cursor: "pointer" }}
                />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 9, color: on ? "#f0f0f0" : "#777", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {prop.replace(/_/g, " ")}
                  </span>
                  {on && (
                    <ParamField
                      paramKey={prop}
                      value={params[prop]}
                      hideLabel
                      {...sharedParamProps}
                      onChange={(v) => onParamChange(nodeId, { [prop]: v })}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!collapsed && data.nodeType === "GetHoveredObject" && (
        <div style={{
          padding: "6px 10px 8px 16px", display: "flex", flexDirection: "column", gap: 5,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          <span style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>Detect (any ticked)</span>
          {([["bp", "Blueprints"], ["spriteObjects", "Sprite Objects"], ["tiles", "Tilemaps"], ["widgets", "Widgets"]] as const).map(([key, lbl]) => (
            <label key={key} className="nodrag" onMouseDown={(e) => e.stopPropagation()}
              style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: params[key] ? "#f0f0f0" : "#888", cursor: "pointer" }}>
              <Toggle value={!!params[key]} onChange={(v) => onParamChange(nodeId, { [key]: v ? 1 : 0 })} />
              {lbl}
            </label>
          ))}
        </div>
      )}
      {!collapsed && tilePicker && (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{
          padding: "6px 10px 8px 16px", display: "flex", flexDirection: "column", gap: 5,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          <span style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {tilePicker.kind === "big" ? "BigTile" : "Animated Tile"} — click to pick
          </span>
          {tilePicker.items.length === 0 ? (
            <span style={{ fontSize: 10, color: "#888" }}>
              {params.tilemap ? "This tileset has none defined." : "Pick a tilemap above first."}
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 160, overflowY: "auto", padding: 3, background: "rgba(0,0,0,0.25)", borderRadius: 4 }}>
              {tilePicker.items.map((it) => {
                const key = tilePicker.kind === "big" ? "bigTileId" : "animatedTileId";
                const cur = String((tilePicker.kind === "big" ? params.bigTileId : params.animatedTileId) ?? "");
                const sel = cur === it.id || (!!it.name && cur === it.name);
                return (
                  <div key={it.id} title={it.name || it.id} onClick={() => onParamChange(nodeId, { [key]: it.id })}
                    style={{
                      cursor: "pointer", padding: 2, borderRadius: 3,
                      outline: sel ? "2px solid #7fd0ff" : "1px solid rgba(255,255,255,0.1)",
                      background: sel ? "rgba(127,208,255,0.15)" : "transparent",
                    }}>
                    <BigTilePreview ts={it.ts} bt={it.region} maxPx={42} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {!collapsed && isFireProjectile && (
        <div style={{
          padding: "8px 10px 8px 0", display: "flex", flexDirection: "column", gap: 6,
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}>
          {/* Essential spawn-time params first — always visible, no toggle.
              Each gets the same wired-pin logic as the default render path. */}
          {FIREPROJ_ESSENTIAL.filter((k) => k in params).map((k) => {
            const pin = data.inData.find((p) => p.pin === k);
            const wired = !!pin && wiredPins.has(k);
            return (
              <div key={k} style={{ position: "relative", paddingLeft: 16, minHeight: 16, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                {pin && (
                  <Handle type="target" position={Position.Left} id={k}
                    style={{ background: PIN_COLORS[pin.type] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }} />
                )}
                {wired ? (
                  <span style={{ fontSize: 9, color: "#f0f0f0", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {paramLabel(k, data.nodeType)} <span style={{ color: "#7fd0ff" }}>(wired)</span>
                  </span>
                ) : (
                  <ParamField
                    paramKey={k}
                    value={params[k]}
                    {...sharedParamProps}
                    onChange={(v) => onParamChange(nodeId, { [k]: v })}
                  />
                )}
              </div>
            );
          })}
          {/* Per-shot OVERRIDES — same checkbox + label + value-when-on
              pattern SetUIElement uses. Each row pairs an ovrXxx enable
              flag with its value field. Off = BP's Projectile chip value
              wins at runtime; on = action's value overrides. */}
          <div style={{ fontSize: 9, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, paddingLeft: 16, paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 2 }}>
            Projectile overrides (off = use component)
          </div>
          {FIREPROJ_OVERRIDES.filter(({ flag, key }) => flag in params && key in params).map(({ flag, key }) => {
            const on = !!params[flag];
            return (
              <div key={flag} style={{ display: "flex", alignItems: "flex-start", gap: 8, paddingLeft: 16 }}>
                <Toggle
                  className="nodrag"
                  value={on}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(v) => onParamChange(nodeId, { [flag]: v ? 1 : 0 })}
                  style={{ flexShrink: 0, margin: 0, marginTop: 1, cursor: "pointer" }}
                />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 9, color: on ? "#f0f0f0" : "#777", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {paramLabel(key, data.nodeType)}
                  </span>
                  {on && (
                    <ParamField
                      paramKey={key}
                      value={params[key]}
                      hideLabel
                      {...sharedParamProps}
                      onChange={(v) => onParamChange(nodeId, { [key]: v })}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!collapsed && data.outData.length > 0 && (
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 0" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingRight: 4, alignItems: "flex-end" }}>
          {data.outData.map((p) => (
            <div key={p.pin} style={{ position: "relative", paddingRight: 12, height: 14, fontSize: 9, color: "#f0f0f0" }}>
              {p.label ?? p.pin}
              <Handle
                type="source"
                position={Position.Right}
                id={p.pin}
                style={{ background: PIN_COLORS[p.type] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }}
              />
            </div>
          ))}
        </div>
      </div>
      )}
      {data.outExec.length > 0 && (
        <div style={{ position: "relative", display: "flex", justifyContent: data.outExec.length > 1 ? "space-around" : "center", paddingTop: 4, paddingBottom: 8 }}>
          {data.outExec.map((p) => (
            <div key={p.pin} style={{ position: "relative", width: 28, height: 6 }}>
              {p.label && (
                <div style={{
                  position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
                  fontSize: 9, color: "#f0f0f0",
                  // Display the label as-typed so a Switch case "Apple" shows
                  // as "Apple" (matching what the runtime actually compares
                  // against). Previously textTransform: "lowercase" lied to
                  // authors that the comparison was case-insensitive.
                  whiteSpace: "nowrap",
                  fontWeight: 600,
                }}>{p.label}</div>
              )}
              <Handle
                type="source"
                position={Position.Bottom}
                id={p.pin}
                style={{ background: PIN_COLORS.exec, width: 10, height: 10, border: "1px solid #000" }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Friendly node-param labels. The default label is just the raw key
// uppercased (e.g. "speedJitter" → "SPEEDJITTER"), which is ugly and doesn't
// match the component inspector. These mirror the ParticleEmitter component's
// labels so the burst/override node reads the same — with "random" spelled out
// on every ± (jitter) field.
/** Per-node-type overrides for PARAM_LABELS. Use when the same param key
 *  needs different labels depending on the action. E.g. `spriteId` is
 *  "Particle Sprite" by default (ParticleEmitter actions dominated this
 *  param historically) but a "Sprite" picker on CreateSpriteObject — so
 *  add a per-node override here rather than renaming the param. */
const PARAM_LABEL_OVERRIDES_BY_NODE: Record<string, Record<string, string>> = {
  CreateSpriteObject: { spriteId: "Sprite" },
  TweenVar: { varName: "Variable", duration: "Duration (s)", ease: "Easing", tweenTag: "Tween Tag (optional)", repeat: "Repeat (-1 = forever)", yoyo: "Yoyo (0/1)" },
  TweenParam: { duration: "Duration (s)", ease: "Easing", tweenTag: "Tween Tag (optional)", repeat: "Repeat (-1 = forever)", yoyo: "Yoyo (0/1)" },
};

function paramLabel(paramKey: string, nodeType?: string): string {
  if (nodeType) {
    const o = PARAM_LABEL_OVERRIDES_BY_NODE[nodeType];
    if (o && o[paramKey]) return o[paramKey];
  }
  return PARAM_LABELS[paramKey] ?? paramKey.replace(/_/g, " ");
}

const PARAM_LABELS: Record<string, string> = {
  machine: "State Machine",
  forSeconds: "Not traced for (seconds)",
  textName: "Text component (blank = first)",
  componentName: "Which one (blank = first)",
  behavior: "Component type",
  param: "Parameter",
  fromVal: "From",
  toVal: "To",
  stopRadius: "Stop Within (px)",
  tmParam: "TM Parameter",
  persist: "Remember (don't respawn)",
  global: "Global Name",
  list: "List",
  key: "Entry",
  shop: "Shop (blank = all)",
  index: "Index",
  count: "Count",
  spriteId: "Particle Sprite",
  lifetime: "Lifetime (s)",
  lifetimeJitter: "Lifetime ± random (s)",
  speed: "Speed (px/s)",
  speedJitter: "Speed ± random (px/s)",
  angleMin: "Angle Min (deg)",
  angleMax: "Angle Max (deg)",
  gravityX: "Gravity X",
  gravityY: "Gravity Y",
  friction: "Friction (0..1)",
  rotationStart: "Rotation Start (deg)",
  rotationEnd: "Rotation End (deg)",
  rotationJitter: "Rotation ± random (deg)",
  scaleStart: "Scale Start",
  scaleEnd: "Scale End",
  alphaStart: "Alpha Start (0..1)",
  alphaEnd: "Alpha End (0..1)",
  tintStart: "Tint Start (0xRRGGBB)",
  tintEnd: "Tint End (0xRRGGBB)",
  blendMode: "Blend Mode",
  frameMode: "Frame Mode",
  frameIndices: "Frame Indices (0-based csv)",
  spawnJitterX: "Spawn X ± random (px)",
  spawnJitterY: "Spawn Y ± random (px)",
  forceRestart: "Override if already playing",
  durationMs: "Freeze (ms)",
  delayMs: "Delay before freeze (ms)",
  affectPhysics: "Affect physics",
  affectParticles: "Affect particles",
  slot: "Slot (0-based)",
  float: "Float (decimals)",
  // Tilemap (Tier 1) — author-friendly labels for the generic tile actions.
  tilemap: "Tilemap (name)",
  layer: "Layer (name)",
  tile: "Tile Index",
  fromTile: "From Tile",
  toTile: "To Tile",
  c0: "Col 0", r0: "Row 0", c1: "Col 1", r1: "Row 1",
  tileX: "World X", tileY: "World Y",
  bigTileId: "BigTile",
  animatedTileId: "Animated Tile (blank = all)",
  restart: "Restart from frame 1",
  tweenTag: "Tween Tag (label)",
  c: "Column",
  r: "Row",
  amount: "Damage",
  power: "Mining Power",
  tracer: "Tracer (name)",
  var: "Variable to read",
};

/**
 * Node types whose `layer` parameter targets an INTERNAL TILEMAP layer
 * (water / land / foliage) rather than the scene's parent render layer.
 * Used by the param picker to swap the `layer` dropdown source on the fly.
 */
const TILEMAP_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  "SetTile", "RemoveTile",
  "SetTileAtWorld", "RemoveTileAtWorld",
  "FillTileRect", "ReplaceTile",
  "RemoveTilesInTracer", "FillTilesInTracer",
  "PlaceBigTile", "PlaceBigTileAtWorld", "PlaceAnimatedTileAtWorld",
  "RemoveBigTileAtWorld", "RemoveBigTileAt",
  "DamageTile", "DamageTileAtWorld", "MineTileAtWorld", "RestoreTileHP",
  "PlayTileAnimation", "PlayTileAnimationAtWorld",
  "StopTileAnimation", "StopTileAnimationAtWorld",
  "PlayAllTileAnimations", "StopAllTileAnimations",
  "RemoveAnimatedTileAt",
  "CompareTileAt", "CompareTileAtWorld",
  "IsTileSolidAt", "IsTileEmptyAt",
]);

/** Multi-row editor for Set Component Param's `params`: each row is a
 *  [parameter dropdown] / [value control], where the value control is dynamic
 *  to that param's behaviorMeta type (enum/ref → dropdown, bool → toggle, else
 *  input). "+ add parameter" appends a row so one node sets many params. */
function CompParamsEditor({
  behavior, rows, opts, inputStyle, onChange,
}: {
  behavior: string;
  rows: { param: string; value: unknown }[];
  opts: Parameters<typeof pickDropdown>[3];
  inputStyle: React.CSSProperties;
  onChange: (next: unknown) => void;
}) {
  const metaList = BEHAVIOR_PARAMS[behavior as BehaviorKind] ?? [];
  const set = (next: { param: string; value: unknown }[]) => onChange(next);
  // Which per-row value pins (pval_<i>) currently have a wire — so a wired row
  // hides its inline value control (the wire drives it), mirroring the rest of
  // the node's pins.
  const connections = useNodeConnections({ handleType: "target" });
  const wiredPins = useMemo(() => {
    const s = new Set<string>();
    for (const c of connections) if (c.targetHandle) s.add(c.targetHandle);
    return s;
  }, [connections]);
  return (
    <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.length === 0 && <span style={{ fontSize: 9, color: "#888", fontStyle: "italic" }}>No parameters yet.</span>}
      {rows.map((row, i) => {
        const dd = pickDropdown("value", row.value, { behavior, param: row.param }, opts);
        const metaType = metaList.find((p) => p.key === row.param)?.type;
        const isBool = metaType === "bool";
        const pinType = metaType === "bool" ? "boolean"
          : (metaType === "number" || metaType === "varRefNumber" || metaType === undefined) ? "number"
          : "string";
        const wired = wiredPins.has(`pval_${i}`);
        return (
          <div key={i} style={{ position: "relative", paddingLeft: 16, display: "flex", alignItems: "center", gap: 3 }}>
            {/* Per-row value pin, aligned with this param's name + value. */}
            <Handle type="target" position={Position.Left} id={`pval_${i}`}
              style={{ background: PIN_COLORS[pinType] ?? PIN_COLORS.exec, width: 8, height: 8, border: "1px solid #000" }} />
            <select
              value={row.param}
              onChange={(e) => {
                const def = metaList.find((p) => p.key === e.target.value)?.default ?? 0;
                set(rows.map((r, idx) => (idx === i ? { param: e.target.value, value: def } : r)));
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            >
              <option value="">— param —</option>
              {metaList.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
            </select>
            {wired ? (
              <span style={{ flex: 1, fontSize: 9, color: "#7fd0ff", textTransform: "uppercase", letterSpacing: 0.5 }}>(wired)</span>
            ) : isBool ? (
              <Toggle value={Number(row.value) !== 0} onChange={(v) => set(rows.map((r, idx) => (idx === i ? { ...r, value: v ? 1 : 0 } : r)))} />
            ) : dd ? (
              <select
                value={String(row.value ?? "")}
                onChange={(e) => set(rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              >
                <option value="">— {dd.placeholder} —</option>
                {dd.options.map((o) => <option key={o} value={o}>{dd.labels?.[o] ?? o}</option>)}
              </select>
            ) : (
              <input
                value={String(row.value ?? "")}
                onChange={(e) => {
                  const v = e.target.value;
                  const num = v.trim() !== "" && /^-?\d*\.?\d+$/.test(v.trim());
                  set(rows.map((r, idx) => (idx === i ? { ...r, value: num ? Number(v) : v } : r)));
                }}
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
            )}
            <button onClick={() => set(rows.filter((_, idx) => idx !== i))} title="Remove" style={{ ...inputStyle, width: 20, padding: 0, color: "#e87", cursor: "pointer" }}>×</button>
          </div>
        );
      })}
      <button
        onClick={() => set([...rows, { param: metaList[0]?.key ?? "", value: metaList[0]?.default ?? 0 }])}
        style={{ ...inputStyle, cursor: "pointer", textAlign: "left", color: "#9cf" }}
      >+ add parameter</button>
    </div>
  );
}

function ParamField({
  paramKey, value, siblingParams, nodeType, varNames, boolVarNames, numberVarNames, behaviorKinds, inputActionNames, signalNames, signalCatalog, globalVarNames, listNames, listEntryNames, tagOptions, tagsByBp, varsByBp, animOptions, spriteAnimsById, spriteAnimsByBlueprintName, weaponSlotSpriteIds, animatorAnimNames, stateOptions, comboStates, stateMachineNames, dialogueNames, tracerNames, textNames, componentsByKind, particleEmitterNames, soundNames, itemNames, recipeNames, widgetNames, spriteOptions, blueprintNames, logicGroupNames, layerNames, sceneNames, placementNames, tilemapNames, tilemapLayersByName, tilemapBigTilesByName, tilemapAnimatedTilesByName, tileTags, navPoints, imagePointsByBp, hostBpName, hostBpId, onChange, hideLabel,
}: {
  paramKey: string;
  value: unknown;
  /** When true, omit the field's own label — the caller renders one (e.g. the
   *  SetUIElement node draws "[✓] PROP" itself and just wants the value editor). */
  hideLabel?: boolean;
  siblingParams: Record<string, unknown>;
  /** Schema type of the parent node (e.g. "EmitSignal", "OnSignal"). Used
   *  to decide signal-picker mode and any other type-conditional renders. */
  nodeType: string;
  varNames: string[];
  /** Variable names filtered to type=bool — drives SetBool/ToggleBool
   *  variable pickers so they don't list animations / number vars. */
  boolVarNames: string[];
  /** Variable names filtered to type=number — drives SetVar/AddVar/SubVar
   *  variable pickers. */
  numberVarNames: string[];
  behaviorKinds: string[];
  inputActionNames: string[];
  signalNames: string[];
  signalCatalog: { sources: Record<string, string>; groups: { label: string; names: string[] }[] };
  globalVarNames: string[];
  listNames: string[];
  listEntryNames: Record<string, string[]>;
  tagOptions: string[];
  tagsByBp: Record<string, string[]>; varsByBp: Record<string, string[]>;
  animOptions: string[];
  spriteAnimsById: Record<string, string[]>;
  spriteAnimsByBlueprintName: Record<string, string[]>;
  weaponSlotSpriteIds: Record<string, string>;
  animatorAnimNames: string[];
  stateOptions: string[];
  comboStates: { name: string; steps: number }[];
  stateMachineNames: string[];
  dialogueNames: string[];
  tracerNames: string[];
  textNames: string[];
  componentsByKind: Record<string, string[]>;
  particleEmitterNames: string[];
  soundNames: string[];
  itemNames: string[];
  recipeNames: string[];
  widgetNames: WidgetTarget[];
  spriteOptions: { id: string; name: string }[];
  blueprintNames: string[];
  logicGroupNames: string[];
  layerNames: string[];
  sceneNames: string[];
  placementNames: string[];
  tilemapNames: string[];
  tilemapLayersByName: Record<string, string[]>;
  tilemapBigTilesByName: Record<string, { id: string; name?: string }[]>;
  tilemapAnimatedTilesByName: Record<string, { id: string; name?: string }[]>;
  tileTags: string[];
  navPoints: string[];
  imagePointsByBp: Record<string, string[]>;
  hostBpName: string;
  hostBpId: string;
  onChange: (next: unknown) => void;
}) {
  // Pick a smart input based on the param key. Falls back to text/number
  // input when the key isn't recognized as a known kind. nodrag/nowheel
  // + stopPropagation on mousedown keep xyflow's pan-drag from
  // hijacking pointer events while the user interacts with the field.
  const ddOpts = { varNames, boolVarNames, numberVarNames, behaviorKinds, inputActionNames, signalNames, signalCatalog, globalVarNames, listNames, listEntryNames, tagOptions, tagsByBp, varsByBp, animOptions, spriteAnimsById, spriteAnimsByBlueprintName, weaponSlotSpriteIds, animatorAnimNames, stateOptions, comboStates, stateMachineNames, dialogueNames, tracerNames, textNames, componentsByKind, particleEmitterNames, soundNames, itemNames, recipeNames, widgetNames, spriteOptions, blueprintNames, logicGroupNames, layerNames, sceneNames, placementNames, tilemapNames, tilemapLayersByName, tilemapBigTilesByName, tilemapAnimatedTilesByName, tileTags, navPoints, nodeType };
  const dropdown = pickDropdown(paramKey, value, siblingParams, ddOpts);
  const isNum = typeof value === "number";
  const isBool = typeof value === "boolean";
  const inputStyle: React.CSSProperties = {
    padding: "4px 7px", fontSize: 10,
    background: "rgba(0,0,0,0.4)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 3, color: "#f0f0f0",
    width: "100%", boxSizing: "border-box",
  };
  // Expression-picker catalog for the free-text field — built from data already
  // in scope. `varNames` already merges local names (no dot) + cross-object
  // paths ("Object.field"); split them back out for the two var groups.
  const exprInputRef = useRef<HTMLInputElement>(null);
  // Local draft state for the free-text input — typed characters live HERE
  // until blur/Enter, instead of round-tripping through onParamChange every
  // keystroke. The round-trip caused React Flow to re-render the node and
  // remount the input mid-keystroke, dropping focus to the end of the
  // field. With local state, the input element identity is stable for the
  // entire typing burst. Sync from `value` prop only when it changes for
  // a reason OTHER than this input's own commits (e.g. ExpressionPicker
  // inserts, programmatic overrides).
  const [draft, setDraft] = useState<string>(() =>
    value === undefined || value === null ? "" : String(value));
  // The latest external value we've seen — if `value` differs from this,
  // the change came from outside (not from our own commit). Without this,
  // the useEffect below would clobber the draft on every parent re-render.
  const lastExternalRef = useRef<string>(draft);
  useEffect(() => {
    const ext = value === undefined || value === null ? "" : String(value);
    if (ext !== lastExternalRef.current) {
      lastExternalRef.current = ext;
      setDraft(ext);
    }
  }, [value]);
  const commitDraft = () => {
    const cur = value === undefined || value === null ? "" : String(value);
    if (draft !== cur) {
      lastExternalRef.current = draft;
      onChange(draft);
    }
  };
  // Always-visible "system" expression groups.
  const exprSystemGroups: ExprGroup[] = (() => {
    const g: ExprGroup[] = [
      { label: "Picked", color: "#e0a14a", tokens: ["x", "y", "name", "tag", "uid", "vx", "vy", "angle", "scale", "alpha"].map((f) => ({ token: `picked.${f}` })) },
      { label: "Mouse", color: "#2ea36a", tokens: ["x", "y", "screenX", "screenY", "left", "right", "middle"].map((f) => ({ token: `mouse.${f}` })) },
      {
        label: "Random", color: "#ff7ad4",
        tokens: [
          { token: "random.float(0, 1)",         hint: "uniform float in [min, max)" },
          { token: "random.int(1, 10)",          hint: "integer in [min, max] inclusive" },
          { token: "random.string(a, b, c, 7)",  hint: "N random tokens from the list (last arg = length)" },
          { token: "choose(1, 2, 3)",            hint: "pick one comma-separated expression — lazy" },
        ],
      },
    ];
    if (tracerNames.length) {
      const fields = ["hitX", "hitY", "actorX", "actorY", "actorName", "actorUid", "actorTags", "distance", "startX", "startY", "endX", "endY"];
      g.push({ label: "Tracers", color: "#f3d24a", tokens: tracerNames.flatMap((t) => fields.map((f) => ({ token: `tracer:${t}.${f}` }))) });
    }
    // Persistent globals (money, day, flags), item counts, and read-only lists —
    // all readable via the global:/list: expression prefixes.
    if (globalVarNames.length) {
      g.push({ label: "Custom Globals", color: "#c77bff", tokens: globalVarNames.map((n) => ({ token: `global:${n}`, hint: "global variable you created" })) });
    }
    if (itemNames.length) {
      g.push({ label: "Item counts", color: "#3fc66e", tokens: itemNames.map((n) => ({ token: `global:${n.replace(/[^A-Za-z0-9_]/g, "")}`, hint: `how many ${n} the player owns` })) });
    }
    const listToks: ExprToken[] = [];
    for (const [list, entries] of Object.entries(listEntryNames)) {
      for (const e of entries) listToks.push({ token: `list:${list}.${e}`, hint: "list entry" });
      listToks.push({ token: `list:${list}.length`, hint: "entry count" });
    }
    if (listToks.length) g.push({ label: "Lists", color: "#5fb3ff", tokens: listToks });
    return g;
  })();
  // Objects — variables hidden until an object is clicked. `varNames` merges
  // this object's locals (no dot) + cross paths ("Object.field").
  // The Main Logic Sheet runs on an invisible host sprite (no body, no behaviors,
  // no user vars), so `self` there resolves to that off-screen host — a footgun.
  // Hide the "This object" group in main sheets; authors use globals / other
  // objects / picked instead.
  const isMainSheet = hostBpId.startsWith("__main__:");
  const exprObjects: ExprObject[] = (() => {
    const out: ExprObject[] = [];
    const locals = varNames.filter((n) => !n.includes("."));
    // Self's built-in transform fields. Merged into "This object" so authors
    // don't see Self in two separate places (was previously a system group +
    // a vars/IPs group). One unified entry per object.
    const SELF_XFORM = ["x", "y", "vx", "vy", "angle", "scale", "scaleX", "scaleY", "alpha", "uid"];
    const selfXform = SELF_XFORM.map((f) => ({ token: `self.${f}`, hint: `self's ${f}` }));
    // Self's image points use the `var:self.IP.<name>.x|y` form so the
    // runtime resolver finds them via the cross-BP `var:` path.
    const selfIPs = (imagePointsByBp[hostBpName] ?? []).flatMap((pt) => [
      { token: `var:self.IP.${pt}.x`, hint: `image point ${pt} x` },
      { token: `var:self.IP.${pt}.y`, hint: `image point ${pt} y` },
    ]);
    if (!isMainSheet) out.push({ name: "This object", color: "#0e9384", tokens: [...selfXform, ...locals.map((n) => ({ token: `var:${n}` })), ...selfIPs] });
    const byObj = new Map<string, ExprToken[]>();
    for (const p of varNames) {
      const dot = p.indexOf(".");
      if (dot < 0) continue;
      const obj = p.slice(0, dot);
      if (!byObj.has(obj)) byObj.set(obj, []);
      byObj.get(obj)!.push({ token: `var:${p}`, hint: "variable" });
    }
    // Each other object also exposes its built-in transform fields (the runtime
    // resolves `var:<Object>.<field>` for these), shown before its user vars.
    const XFORM = ["x", "y", "vx", "vy", "angle", "scale", "scaleX", "scaleY", "alpha", "uid"];
    // Every blueprint is referenceable — even one with NO user variables (a
    // blank/Empty BP) still exposes x/y and the other built-in transform fields.
    // Union the var-derived objects with the FULL blueprint list so a fresh
    // Empty BP isn't invisible in the picker. The host is shown as "This object"
    // above, so skip it here.
    const objNames = [...new Set<string>([...byObj.keys(), ...blueprintNames])]
      .filter((n) => n && n !== hostBpName)
      .sort((a, b) => a.localeCompare(b));
    for (const obj of objNames) {
      const toks = byObj.get(obj) ?? [];
      const builtins = XFORM.map((f) => ({ token: `var:${obj}.${f}`, hint: `${obj}'s ${f}` }));
      const ips = (imagePointsByBp[obj] ?? []).flatMap((pt) => [
        { token: `var:${obj}.IP.${pt}.x`, hint: `${obj}'s image point ${pt} x` },
        { token: `var:${obj}.IP.${pt}.y`, hint: `${obj}'s image point ${pt} y` },
      ]);
      out.push({ name: obj, color: "#b07bff", tokens: [...builtins, ...ips, ...toks] });
    }
    return out;
  })();
  const insertExpr = (token: string) => {
    const el = exprInputRef.current;
    // Read the draft (what the user is currently typing) — falls back to
    // `value` when there's no draft (initial mount).
    const cur = draft;
    const pos = el && el.selectionStart != null ? el.selectionStart : cur.length;
    const next = cur.slice(0, pos) + token + cur.slice(pos);
    // Update BOTH draft and parent state so the inserted token sticks and
    // is visible immediately — picker inserts are an "external" change so
    // we must also bump lastExternalRef to prevent the next re-render's
    // useEffect from clobbering the just-set draft.
    lastExternalRef.current = next;
    setDraft(next);
    onChange(next);
    requestAnimationFrame(() => {
      if (el) { el.focus(); const p = pos + token.length; el.setSelectionRange(p, p); }
    });
  };
  // Special inline editors for combinator nodes:
  //  - `mode` with AND/OR → two-button toggle.
  //  - `pinCount` → +/- buttons, clamped to >=2.
  const isMode = paramKey === "mode" && (value === "AND" || value === "OR");
  // Drop node `mode` → Animation (plays) vs Static (freeze on a frame) toggle.
  const isDropMode = paramKey === "mode" && nodeType === "DropObject";
  const isPinCount = paramKey === "pinCount" && typeof value === "number";
  // Signal params use the dedicated picker — built-ins + project signals
  // + source chips + free-text. Bypasses the smart-dropdown which would
  // show nothing when no project signals are declared.
  const isSignal = paramKey === "signal";
  const isColor = isColorParamKey(paramKey);
  // PlaySounds `sounds` param — a list of sound names (play order = list
  // order for queue mode). Custom chip editor since ParamField otherwise
  // only handles scalar values.
  const isSoundList = paramKey === "sounds" && nodeType === "PlaySounds";
  const soundList: string[] = isSoundList && Array.isArray(value) ? (value as string[]) : [];
  // Random node — editable string list, number list, and a Sync toggle.
  const isRandStrings = paramKey === "strings" && nodeType === "RandomPick";
  const isRandNumbers = paramKey === "numbers" && nodeType === "RandomPick";
  const isRandSync    = paramKey === "sync"    && nodeType === "RandomPick";
  const isRandFloat   = paramKey === "float"   && nodeType === "RandomRange";
  const randStrings: string[] = isRandStrings && Array.isArray(value) ? (value as string[]) : [];
  const randNumbers: number[] = isRandNumbers && Array.isArray(value) ? (value as number[]) : [];
  // Switch `cases` param — each row is a match value; each renders its own
  // exec output pin (`case_<id>`). Stable ids so pins survive edits/removal.
  const isCases = paramKey === "cases" && nodeType === "Switch";
  const caseList: { id: string; value: string }[] =
    isCases && Array.isArray(value) ? (value as { id: string; value: string }[]) : [];
  // InputCombo `comboKeys` — each row is { mode, action }: a key requirement.
  const isComboKeys = paramKey === "comboKeys" && nodeType === "InputCombo";
  const comboList: { mode: string; action: string }[] =
    isComboKeys && Array.isArray(value) ? (value as { mode: string; action: string }[]) : [];
  // OnComboStep `steps` — multi-select of 1-based combo step numbers. N (the
  // count of toggle buttons) comes from the chosen sibling `state`'s combo
  // length; no state picked → render a hint instead of toggles.
  const isComboSteps = paramKey === "steps" && nodeType === "OnComboStep";
  const comboStepSel: number[] = isComboSteps && Array.isArray(value) ? (value as number[]) : [];
  const comboStepCount = isComboSteps
    ? (comboStates.find((s) => s.name === String(siblingParams.state ?? ""))?.steps ?? 0)
    : 0;
  // OnComboStep `separate` — single shared exec output vs one exec out per step.
  const isComboSeparate = paramKey === "separate" && nodeType === "OnComboStep";
  // OnDialogueLine `keywords` — substrings matched against the shown line text;
  // `matchAny` toggles OR (any keyword) vs AND (all keywords).
  const isDialogueKeywords = paramKey === "keywords" && nodeType === "OnDialogueLine";
  const dialogueKeywords: string[] = isDialogueKeywords && Array.isArray(value) ? (value as string[]) : [];
  const isDialogueMatchMode = paramKey === "matchAny" && nodeType === "OnDialogueLine";
  const isDialogueCase = paramKey === "caseSensitive" && nodeType === "OnDialogueLine";
  const isDialogueSeparate = paramKey === "separate" && nodeType === "OnDialogueLine";
  // Emit-side nodes hide engine-emitted lifecycle signals so authors don't
  // fake events. Listen-side (OnSignal trigger, IsSignalFiring,
  // SignalFiredEdge) shows everything. Add to this set when new emit-style
  // actions / configs land.
  const EMIT_SIDE_NODE_TYPES = new Set<string>(["EmitSignal", "EmitSignalTo"]);
  const signalMode: "listen" | "emit" = EMIT_SIDE_NODE_TYPES.has(nodeType) ? "emit" : "listen";
  // Set Component Param VALUE where the chosen param is a bool → render a
  // toggle (the value is stored as 0/1, so the generic `isBool` check misses
  // it). Enum / sprite-ref values become dropdowns via pickDropdown above.
  const compValMeta = (nodeType === "SetBehaviorParam" && paramKey === "value")
    ? BEHAVIOR_PARAMS[String(siblingParams.behavior ?? "") as BehaviorKind]?.find((p) => p.key === String(siblingParams.param ?? ""))
    : undefined;
  const isCompBool = compValMeta?.type === "bool";
  // Set Component Param `params` — a multi-row [param / value] editor with
  // +add, each value control dynamic to its param's type.
  const isCompParams = nodeType === "SetBehaviorParam" && paramKey === "params";
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {!hideLabel && <span style={{ fontSize: 8, color: "#f0f0f0", textTransform: "uppercase", letterSpacing: 0.5 }}>{paramLabel(paramKey, nodeType)}</span>}
      {isCompParams ? (
        <CompParamsEditor
          behavior={String(siblingParams.behavior ?? "")}
          rows={Array.isArray(value) ? (value as { param: string; value: unknown }[]) : []}
          opts={ddOpts}
          inputStyle={inputStyle}
          onChange={onChange}
        />
      ) : isComboKeys ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {comboList.map((row, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <select
                value={row.mode ?? "held"}
                onChange={(e) => onChange(comboList.map((x, idx) => (idx === i ? { ...x, mode: e.target.value } : x)))}
                style={{ ...inputStyle, width: 64 }}
                title="Held = key down · Pressed = on press · Released = on release"
              >
                <option value="held">Held</option>
                <option value="pressed">Pressed</option>
                <option value="released">Released</option>
              </select>
              <select
                value={row.action ?? ""}
                onChange={(e) => onChange(comboList.map((x, idx) => (idx === i ? { ...x, action: e.target.value } : x)))}
                style={{ flex: 1, ...inputStyle }}
              >
                <option value="">— action —</option>
                {inputActionNames.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <button
                onClick={() => onChange(comboList.filter((_, idx) => idx !== i))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove key"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange([...comboList, { mode: "held", action: "" }])}
            style={{ ...inputStyle, cursor: "pointer", textAlign: "center", color: "#9fd0ff" }}
          >+ Add key</button>
        </div>
      ) : isCases ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {caseList.map((c, i) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#888", width: 12, textAlign: "right" }}>{i + 1}.</span>
              <input
                type="text"
                value={c.value ?? ""}
                placeholder="match value"
                onChange={(e) => onChange(caseList.map((x) => (x.id === c.id ? { ...x, value: e.target.value } : x)))}
                style={{ flex: 1, ...inputStyle }}
              />
              <button
                onClick={() => onChange(caseList.filter((x) => x.id !== c.id))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove case"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange([...caseList, { id: Math.random().toString(36).slice(2, 8), value: "" }])}
            style={{ ...inputStyle, cursor: "pointer", textAlign: "center", color: "#9fd0ff" }}
          >+ Add case</button>
        </div>
      ) : isComboSteps ? (
        comboStepCount <= 0 ? (
          <span style={{ fontSize: 9, color: "#888", fontStyle: "italic" }}>pick a state first</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
            {Array.from({ length: comboStepCount }, (_, i) => i + 1).map((n) => {
              const on = comboStepSel.includes(n);
              return (
                <button
                  key={n}
                  onClick={() => onChange(on ? comboStepSel.filter((x) => x !== n) : [...comboStepSel, n].sort((a, b) => a - b))}
                  style={{
                    width: 22, height: 22, padding: 0, fontSize: 10,
                    background: on ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                    color: on ? "#fff" : "#aaa",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 3, cursor: "pointer", fontWeight: 600,
                  }}
                >{n}</button>
              );
            })}
          </div>
        )
      ) : isComboSeparate ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([["Single output", false], ["Separate outputs", true]] as [string, boolean][]).map(([lbl, val]) => {
            const on = !!value === val;
            return (
              <button
                key={lbl}
                onClick={() => onChange(val)}
                style={{
                  flex: 1, height: 22, padding: 0, fontSize: 9,
                  background: on ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                  color: on ? "#fff" : "#aaa",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 3, cursor: "pointer", fontWeight: 600,
                }}
              >{lbl}</button>
            );
          })}
        </div>
      ) : isDialogueMatchMode ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([["Any (OR)", true], ["All (AND)", false]] as [string, boolean][]).map(([lbl, val]) => {
            const on = !!value === val;
            return (
              <button
                key={lbl}
                onClick={() => onChange(val)}
                title={val ? "Fire if the line contains ANY of the keywords" : "Fire only if the line contains ALL keywords"}
                style={{
                  flex: 1, height: 22, padding: 0, fontSize: 9,
                  background: on ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                  color: on ? "#fff" : "#aaa",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 3, cursor: "pointer", fontWeight: 600,
                }}
              >{lbl}</button>
            );
          })}
        </div>
      ) : isDialogueSeparate ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([["Single output", false], ["Separate per keyword", true]] as [string, boolean][]).map(([lbl, val]) => {
            const on = !!value === val;
            return (
              <button
                key={lbl}
                onClick={() => onChange(val)}
                title={val ? "One exec output per keyword — each fires when ITS keyword matches the line" : "One shared exec output — fires per the Any/All rule"}
                style={{
                  flex: 1, height: 22, padding: 0, fontSize: 9,
                  background: on ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                  color: on ? "#fff" : "#aaa",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 3, cursor: "pointer", fontWeight: 600,
                }}
              >{lbl}</button>
            );
          })}
        </div>
      ) : isDialogueCase ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([["Ignore case", false], ["Case-sensitive", true]] as [string, boolean][]).map(([lbl, val]) => {
            const on = !!value === val;
            return (
              <button
                key={lbl}
                onClick={() => onChange(val)}
                style={{
                  flex: 1, height: 22, padding: 0, fontSize: 9,
                  background: on ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                  color: on ? "#fff" : "#aaa",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 3, cursor: "pointer", fontWeight: 600,
                }}
              >{lbl}</button>
            );
          })}
        </div>
      ) : isDialogueKeywords ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {dialogueKeywords.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#888", width: 12, textAlign: "right" }}>{i + 1}.</span>
              <input
                type="text"
                value={s}
                onChange={(e) => onChange(dialogueKeywords.map((x, idx) => (idx === i ? e.target.value : x)))}
                placeholder="contains text…"
                style={{ flex: 1, ...inputStyle }}
              />
              <button
                onClick={() => onChange(dialogueKeywords.filter((_, idx) => idx !== i))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange([...dialogueKeywords, ""])}
            style={{ ...inputStyle, cursor: "pointer", color: "#9ecbff", textAlign: "left" }}
          >+ add keyword</button>
        </div>
      ) : isSoundList ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {soundList.map((s, i) => (
            <div key={`${s}-${i}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#888", width: 12, textAlign: "right" }}>{i + 1}.</span>
              <span style={{ flex: 1, ...inputStyle, padding: "3px 6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s}</span>
              <button
                onClick={() => onChange(soundList.filter((_, idx) => idx !== i))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove"
              >×</button>
            </div>
          ))}
          <select
            value=""
            onChange={(e) => { if (e.target.value) onChange([...soundList, e.target.value]); }}
            style={inputStyle}
          >
            <option value="">+ add sound…</option>
            {soundNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      ) : isRandStrings ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {randStrings.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#888", width: 12, textAlign: "right" }}>{i + 1}.</span>
              <input
                value={s}
                onChange={(e) => onChange(randStrings.map((x, idx) => (idx === i ? e.target.value : x)))}
                style={{ flex: 1, ...inputStyle }}
                placeholder="word"
              />
              <button
                onClick={() => onChange(randStrings.filter((_, idx) => idx !== i))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange([...randStrings, ""])}
            style={{ ...inputStyle, cursor: "pointer", color: "#9ecbff", textAlign: "left" }}
          >+ add string</button>
        </div>
      ) : isRandNumbers ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {randNumbers.map((n, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 8, color: "#888", width: 12, textAlign: "right" }}>{i + 1}.</span>
              <input
                type="number"
                value={Number.isFinite(n) ? n : 0}
                onChange={(e) => onChange(randNumbers.map((x, idx) => (idx === i ? Number(e.target.value) : x)))}
                style={{ flex: 1, ...inputStyle }}
              />
              <button
                onClick={() => onChange(randNumbers.filter((_, idx) => idx !== i))}
                style={{ width: 18, height: 18, padding: 0, lineHeight: "16px", background: "rgba(0,0,0,0.4)", color: "#e07474", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", fontSize: 11 }}
                title="Remove"
              >×</button>
            </div>
          ))}
          <button
            onClick={() => onChange([...randNumbers, 0])}
            style={{ ...inputStyle, cursor: "pointer", color: "#9ecbff", textAlign: "left" }}
          >+ add number</button>
        </div>
      ) : isRandSync ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([[true, "Synced"], [false, "Independent"]] as const).map(([v, label]) => (
            <button
              key={label}
              onClick={() => onChange(v)}
              title={v ? "String + number pair by index (apple→0, bread→15)" : "String and number roll independently"}
              style={{
                flex: 1, padding: "3px 0", fontSize: 10,
                background: !!value === v ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                color: !!value === v ? "#fff" : "#aaa",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, cursor: "pointer", fontWeight: 600,
              }}
            >{label}</button>
          ))}
        </div>
      ) : isRandFloat ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([[false, "Whole"], [true, "Decimal"]] as const).map(([v, label]) => (
            <button
              key={label}
              onClick={() => onChange(v)}
              title={v ? "Float (e.g. 4.73)" : "Integer, both ends inclusive (e.g. 0..10)"}
              style={{
                flex: 1, padding: "3px 0", fontSize: 10,
                background: !!value === v ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                color: !!value === v ? "#fff" : "#aaa",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, cursor: "pointer", fontWeight: 600,
              }}
            >{label}</button>
          ))}
        </div>
      ) : isSignal ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          <SignalPicker
            value={typeof value === "string" ? value : ""}
            onChange={(v) => onChange(v)}
            placeholder="pick signal…"
            style={{ width: "100%" }}
            mode={signalMode}
            forBpId={hostBpId}
          />
        </div>
      ) : isColor ? (
        <div className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          <ColorField value={value} onChange={onChange} mode={isNum ? "number" : "string"} />
        </div>
      ) : isMode ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {(["AND", "OR"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onChange(m)}
              style={{
                flex: 1, padding: "3px 0", fontSize: 10,
                background: value === m ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                color: value === m ? "#fff" : "#aaa",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, cursor: "pointer", fontWeight: 600,
              }}
            >{m}</button>
          ))}
        </div>
      ) : isDropMode ? (
        <div style={{ display: "flex", gap: 4 }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          {([["animation", "Animation"], ["static", "Static"]] as const).map(([m, label]) => (
            <button
              key={m}
              onClick={() => onChange(m)}
              title={m === "animation" ? "Play the chosen animation" : "Freeze on one frame of the chosen animation"}
              style={{
                flex: 1, padding: "3px 0", fontSize: 10,
                background: value === m ? "#2a6cd1" : "rgba(0,0,0,0.4)",
                color: value === m ? "#fff" : "#aaa",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 3, cursor: "pointer", fontWeight: 600,
              }}
            >{label}</button>
          ))}
        </div>
      ) : isPinCount ? (
        <div style={{ display: "flex", gap: 4, alignItems: "center" }} className="nodrag" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={() => onChange(Math.max(2, (value as number) - 1))}
            style={{
              width: 22, height: 22, padding: 0, lineHeight: "20px",
              background: "rgba(0,0,0,0.4)", color: "#f0f0f0",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 3, cursor: "pointer", fontSize: 13,
            }}
          >−</button>
          <span style={{
            flex: 1, textAlign: "center", padding: "3px 0",
            background: "rgba(0,0,0,0.4)", color: "#f0f0f0",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 3, fontSize: 11,
          }}>{value} pins</span>
          <button
            onClick={() => onChange((value as number) + 1)}
            style={{
              width: 22, height: 22, padding: 0, lineHeight: "20px",
              background: "rgba(0,0,0,0.4)", color: "#f0f0f0",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 3, cursor: "pointer", fontSize: 13,
            }}
          >+</button>
        </div>
      ) : isCompBool ? (
        <Toggle
          value={Number(value) !== 0}
          className="nodrag"
          onClick={(e) => e.stopPropagation()}
          onChange={(v) => onChange(v ? 1 : 0)}
        />
      ) : isBool ? (
        <Toggle
          value={!!value}
          className="nodrag"
          onClick={(e) => e.stopPropagation()}
          onChange={(v) => onChange(v)}
        />
      ) : dropdown ? (
        <select
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="nodrag"
          onMouseDown={(e) => e.stopPropagation()}
          style={inputStyle}
        >
          <option value="">— {dropdown.placeholder} —</option>
          {dropdown.groups && dropdown.groups.length > 0 ? (
            dropdown.groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.names.map((n) => (
                  <option key={n} value={n} title={dropdown.titles?.[n]} style={dropdown.colors?.[n] ? { color: dropdown.colors[n] } : undefined}>
                    {dropdown.labels?.[n] ?? n}
                  </option>
                ))}
              </optgroup>
            ))
          ) : (
            dropdown.options.map((n) => (
              <option key={n} value={n} title={dropdown.titles?.[n]} style={dropdown.colors?.[n] ? { color: dropdown.colors[n] } : undefined}>
                {dropdown.labels?.[n] ?? n}
              </option>
            ))
          )}
          {typeof value === "string" && value && !dropdown.options.includes(value) && (
            <option value={value}>{value} (custom)</option>
          )}
        </select>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            ref={exprInputRef}
            type="text"
            value={draft}
            className="nodrag nowheel"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              // Local-state only — every keystroke updates `draft`, NOT the
              // parent. Parent commit happens on blur / Enter via
              // commitDraft(). This breaks the per-keystroke React Flow
              // re-render that was remounting the input element and
              // dropping focus to the end of the field.
              setDraft(e.target.value);
            }}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") { commitDraft(); e.currentTarget.blur(); }
              else if (e.key === "Escape") { setDraft(lastExternalRef.current); e.currentTarget.blur(); }
            }}
            style={inputStyle}
          />
          <ExpressionPicker groups={exprSystemGroups} objects={exprObjects} onPick={insertExpr} />
        </div>
      )}
    </label>
  );
}

const WIDGET_TARGET_COLOR = "#ff7ed1";   // whole-widget entries (matches the UI component chip)
const ELEMENT_TARGET_COLOR = "#9fd0ff";  // element / child entries

/** Build a `target` / `widgetName` dropdown from WidgetTargets — option values
 *  are the stored names, labels carry the ◆/▸ glyph, and colors tint
 *  whole-widget vs element so the two are distinguishable in the list. */
function buildWidgetDropdown(
  targets: WidgetTarget[],
  placeholder: string,
): { options: string[]; placeholder: string; labels: Record<string, string>; colors: Record<string, string> } | null {
  if (targets.length === 0) return null;
  const labels: Record<string, string> = {};
  const colors: Record<string, string> = {};
  const options: string[] = [];
  // De-dup by value, first-wins — element names can repeat across widgets,
  // and the runtime targets ALL matches by name, so one option suffices.
  for (const t of targets) {
    if (t.value in labels) continue;
    labels[t.value] = t.label;
    colors[t.value] = t.isWidget ? WIDGET_TARGET_COLOR : ELEMENT_TARGET_COLOR;
    options.push(t.value);
  }
  return { options, placeholder, labels, colors };
}

function pickDropdown(
  key: string,
  _value: unknown,
  siblingParams: Record<string, unknown>,
  opts: {
    varNames: string[]; boolVarNames: string[]; numberVarNames: string[];
    behaviorKinds: string[]; inputActionNames: string[];
    signalNames: string[]; signalCatalog: { sources: Record<string, string>; groups: { label: string; names: string[] }[] }; globalVarNames: string[]; listNames: string[]; listEntryNames: Record<string, string[]>; tagOptions: string[]; tagsByBp: Record<string, string[]>; varsByBp: Record<string, string[]>; animOptions: string[];
    spriteAnimsById: Record<string, string[]>; spriteAnimsByBlueprintName: Record<string, string[]>; weaponSlotSpriteIds: Record<string, string>;
    animatorAnimNames: string[];
    stateOptions: string[]; comboStates: { name: string; steps: number }[]; stateMachineNames: string[]; dialogueNames: string[]; tracerNames: string[]; textNames: string[]; componentsByKind: Record<string, string[]>;
    particleEmitterNames: string[];
    soundNames: string[];
    itemNames: string[];
    recipeNames: string[];
    widgetNames: WidgetTarget[];
    spriteOptions: { id: string; name: string }[];
    blueprintNames: string[]; logicGroupNames: string[]; layerNames: string[]; sceneNames: string[];
    placementNames: string[];
    tilemapNames: string[];
    tilemapLayersByName: Record<string, string[]>;
    tilemapBigTilesByName: Record<string, { id: string; name?: string }[]>;
    tilemapAnimatedTilesByName: Record<string, { id: string; name?: string }[]>;
    tileTags: string[];
    navPoints: string[];
    nodeType?: string;
  },
): { options: string[]; placeholder: string; labels?: Record<string, string>; colors?: Record<string, string>; groups?: { label: string; names: string[] }[]; titles?: Record<string, string> } | null {
  // Variable-target nodes that share the generic `name` param key with
  // SR's PlayAnimation. Without an early exit, the polymorphic name
  // handler below sees animOptions first and serves animations into a
  // variable picker — the bug the author hit on SetBool. Route them
  // here so each picks the right variable list by type.
  if (key === "name" && opts.nodeType) {
    // The SET family writes a var on THIS BP, so offer only the host's OWN
    // variables — not cross-object `Object.field` paths (those are dotted; the
    // host's own names are bare). Use SetVarOn to write another object's var.
    if (opts.nodeType === "SetBool" || opts.nodeType === "ToggleBool") {
      const ns = opts.boolVarNames.filter((n) => !n.includes("."));
      return ns.length > 0 ? { options: ns, placeholder: "bool variable" } : null;
    }
    if (opts.nodeType === "AddVar" || opts.nodeType === "SubVar") {
      // Add/Sub are arithmetic — number vars only.
      const ns = opts.numberVarNames.filter((n) => !n.includes("."));
      return ns.length > 0 ? { options: ns, placeholder: "number variable" } : null;
    }
    if (opts.nodeType === "SetVar") {
      // Set Variable accepts number OR string vars (bools go through Set Bool).
      const ns = opts.varNames.filter((n) => !opts.boolVarNames.includes(n) && !n.includes("."));
      return ns.length > 0 ? { options: ns, placeholder: "variable" } : null;
    }
    if (opts.nodeType === "PlayAnimatorAnim" || opts.nodeType === "StopAnimatorAnim") {
      return opts.animatorAnimNames.length > 0
        ? { options: opts.animatorAnimNames, placeholder: "animation name" }
        : null;
    }
    if (opts.nodeType === "SetInstanceName") {
      // `name` here is a FREE-TEXT instance name (for SaveSlot matching /
      // instance:<name> lookups), NOT an animation. Return null → plain text
      // input, instead of falling through to the animation dropdown.
      return null;
    }
  }
  switch (key) {
    case "ease":
      // Easing curves (Phaser ease names) — a closed set, so a dropdown beats
      // a free-text field everywhere ease is used (Tween / Camera pan / etc.).
      return {
        options: [
          "Linear",
          "Sine.easeIn", "Sine.easeOut", "Sine.easeInOut",
          "Quad.easeIn", "Quad.easeOut", "Quad.easeInOut",
          "Cubic.easeIn", "Cubic.easeOut", "Cubic.easeInOut",
          "Back.easeIn", "Back.easeOut", "Back.easeInOut",
          "Bounce.easeOut", "Elastic.easeOut",
        ],
        placeholder: "easing",
      };
    case "var": {
      // The friendly var nodes store the variable under `var`, typed by node:
      //   ToggleVar → bool vars only · IncrementVar → number vars only ·
      //   SetVar → number OR string (bools use Toggle Var). Everything else
      //   that reads a var (GetVar, etc.) sees every variable.
      // Host's OWN variables only (no cross-object `Object.field` paths).
      if (opts.nodeType === "ToggleVar") {
        const ns = opts.boolVarNames.filter((n) => !n.includes("."));
        return ns.length > 0 ? { options: ns, placeholder: "bool variable" } : null;
      }
      if (opts.nodeType === "IncrementVar") {
        const ns = opts.numberVarNames.filter((n) => !n.includes("."));
        return ns.length > 0 ? { options: ns, placeholder: "number variable" } : null;
      }
      if (opts.nodeType === "SetVar") {
        const ns = opts.varNames.filter((n) => !opts.boolVarNames.includes(n) && !n.includes("."));
        return ns.length > 0 ? { options: ns, placeholder: "variable" } : null;
      }
      return opts.varNames.length > 0 ? { options: opts.varNames, placeholder: "variable" } : null;
    }
    case "varName":
      // `varName` is the field name some engine actions/conditions use
      // (IsBetween, TracerGetResult). Same dropdown source as `var`.
      return opts.varNames.length > 0 ? { options: opts.varNames, placeholder: "variable" } : null;
    case "group":
      // Set Group Active — pick one of THIS BP's Logic Sheet groups (folders).
      return opts.logicGroupNames.length > 0 ? { options: opts.logicGroupNames, placeholder: "group" } : null;
    case "behavior":
      return opts.behaviorKinds.length > 0 ? { options: opts.behaviorKinds, placeholder: "component" } : null;
    case "param": {
      // Param dropdown depends on the sibling `behavior` value: look
      // up that behavior's writable params in BEHAVIOR_PARAMS catalog.
      const beh = String(siblingParams.behavior ?? "");
      if (!beh) return null;
      const list = BEHAVIOR_PARAMS[beh as BehaviorKind];
      if (!list) return null;
      return { options: list.map((p) => p.key), placeholder: "parameter" };
    }
    case "value": {
      // Set Component Param's VALUE adapts to the chosen param's TYPE (from the
      // component's behaviorMeta) — every ref/enum type becomes the same picker
      // the component card uses, so it's never a bare text box when known values
      // exist. (bool → a toggle in the field renderer; number/text → input.)
      if (opts.nodeType !== "SetBehaviorParam") return null;
      const beh = String(siblingParams.behavior ?? "");
      const par = String(siblingParams.param ?? "");
      const meta = beh && par ? BEHAVIOR_PARAMS[beh as BehaviorKind]?.find((p) => p.key === par) : undefined;
      if (!meta) return null;
      const list = (o: string[], placeholder: string) => (o.length > 0 ? { options: o, placeholder } : null);
      // Enum (fixed choices) wins regardless of declared `type`.
      if (meta.options && meta.options.length > 0) {
        return { options: meta.options.map((o) => o.value), placeholder: "value", labels: Object.fromEntries(meta.options.map((o) => [o.value, o.label])) };
      }
      switch (meta.type) {
        case "spriteRef":
          return opts.spriteOptions.length > 0
            ? { options: opts.spriteOptions.map((s) => s.id), placeholder: "sprite", labels: Object.fromEntries(opts.spriteOptions.map((s) => [s.id, s.name])) }
            : null;
        case "spriteAnim":     return list(opts.animOptions, "animation");
        case "inputAction":    return list(opts.inputActionNames, "input action");
        case "signal":         return opts.signalNames.length > 0 ? { options: opts.signalNames, placeholder: "signal", groups: opts.signalCatalog.groups, titles: opts.signalCatalog.sources } : null;
        case "varRef":         return list(opts.varNames, "variable");
        case "varRefNumber":   return list(opts.numberVarNames, "number variable");
        case "sceneLayerList": return list(opts.layerNames, "layer");
        case "widgetRef":
          return opts.widgetNames.length > 0
            ? { options: opts.widgetNames.map((w) => w.value), placeholder: "widget", labels: Object.fromEntries(opts.widgetNames.map((w) => [w.value, w.label])) }
            : null;
        default:               return null; // bool → toggle; number / string / font → input
      }
    }
    case "signal":
      return opts.signalNames.length > 0 ? { options: opts.signalNames, placeholder: "signal", groups: opts.signalCatalog.groups, titles: opts.signalCatalog.sources } : null;
    case "global":
      // SetGlobal picks one of the declared project global variables. Falls
      // through to free-text when none are declared yet (author can still
      // type an ad-hoc name).
      return opts.globalVarNames.length > 0 ? { options: opts.globalVarNames, placeholder: "global variable" } : null;
    case "action":
      return opts.inputActionNames.length > 0 ? { options: opts.inputActionNames, placeholder: "input action" } : null;
    case "oldTag":
      // EditTags' `oldTag` shows the picked Blueprint's tags. Filtering to
      // the BP keeps the chip list short + meaningful — "Boss" doesn't
      // need to see "coin" / "tile" / unrelated tags from other BPs. When
      // no BP is picked yet, fall back to the project-wide list so the
      // dropdown isn't empty (author can preview options while wiring).
      if (opts.nodeType === "EditTags") {
        const bp = typeof siblingParams.bp === "string" ? siblingParams.bp : "";
        const bpTags = bp ? opts.tagsByBp[bp] : undefined;
        const list = bpTags && bpTags.length > 0 ? bpTags : opts.tagOptions;
        return list.length > 0 ? { options: list, placeholder: bp ? `${bp}'s tags` : "pick a BP first" } : null;
      }
      return null;
    case "point":
      // Nav-point fields take a WAYPOINT name or tag — not sprite/BP tags.
      return { options: opts.navPoints, placeholder: opts.navPoints.length > 0 ? "waypoint name/tag" : "paint a waypoint first" };
    case "tag":
    case "tagValue":
    case "tagFilter":
      // Get Tagged Tile targets TILES, so its tag must come from big/animated
      // tile tags — NOT sprite/BP tags, which would never match a tile.
      if (opts.nodeType === "GetTaggedTile") {
        return opts.tileTags.length > 0
          ? { options: opts.tileTags, placeholder: "tile tag" }
          : { options: [], placeholder: "tag a tile in the Tileset tab first" };
      }
      // Patrol targets nav WAYPOINTS by tag — not sprite/BP tags.
      if (opts.nodeType === "PatrolNavPoints") {
        return { options: opts.navPoints, placeholder: opts.navPoints.length > 0 ? "waypoint tag" : "paint a waypoint first" };
      }
      // Skip the BP-tag autocomplete for kinds whose `tag` param is an
      // arbitrary author-defined LABEL (not a sprite tag):
      //   - DebounceWait: timer name.
      //   - Tween / TweenSetEndValue / TweenStop / TweenPause / TweenResume:
      //     self-referential tween identifier on the host — used to
      //     STOP/PAUSE/RESUME this particular tween from a later action.
      //   - EditTags: the `tag` field is the NEW tag the author is creating
      //     (insert / replace). A dropdown of existing tags would just
      //     railroad them into picking one that already exists; free-text
      //     keeps "type a brand-new tag" obvious. The `oldTag` field still
      //     shows the chip dropdown for picking which existing tag to act on.
      // Falling through to free-text makes the field's purpose obvious
      // and prevents the BP-tag dropdown from suggesting "player" /
      // "ground" / "enemy" etc. which would actively mislead authors.
      if (opts.nodeType === "DebounceWait") return null;
      if (opts.nodeType === "EditTags") return null;
      if (
        opts.nodeType === "Tween" || opts.nodeType === "TweenSetEndValue" ||
        opts.nodeType === "TweenStop" || opts.nodeType === "TweenPause" ||
        opts.nodeType === "TweenResume"
      ) return null;
      // OnCollide / OnOverlap: an EMPTY tag means "any object" at runtime
      // (CollisionScan emits the bare OnCollide for every collider). Make that
      // discoverable via the placeholder; picking a tag narrows it. Either way
      // the Get Collided Object node returns the object.
      if (opts.nodeType === "OnCollide" || opts.nodeType === "OnOverlap" || opts.nodeType === "OnOverlapForSeconds") {
        return { options: opts.tagOptions, placeholder: "any object — or pick a tag" };
      }
      return opts.tagOptions.length > 0 ? { options: opts.tagOptions, placeholder: "tag" } : null;
    case "state": {
      // On Combo Step restricts to states that HAVE combos — listing
      // non-combo states would offer a `steps` multi-select with N=0.
      if (opts.nodeType === "OnComboStep") {
        const names = opts.comboStates.map((s) => s.name);
        return names.length > 0 ? { options: names, placeholder: "combo state" } : { options: [], placeholder: "no combo states" };
      }
      // OnStateEnter / OnStateMain / OnStateExit (animator) and
      // OnAIStateEnter / OnAIStateExit (AI brain) accept an empty /
      // "any" value to fire on EVERY state transition — surface that
      // as the placeholder so authors can pick "any" from the dropdown
      // without typing. Other consumers (isState condition, SetAIState
      // action) still require a specific state.
      const anyStateTriggers = new Set<string>([
        "OnStateEnter", "OnStateMain", "OnStateExit",
        "OnAIStateEnter", "OnAIStateExit",
      ]);
      if (opts.nodeType && anyStateTriggers.has(opts.nodeType)) {
        return opts.stateOptions.length > 0
          ? { options: opts.stateOptions, placeholder: "any state" }
          : { options: [], placeholder: "any state" };
      }
      return opts.stateOptions.length > 0 ? { options: opts.stateOptions, placeholder: "animator state" } : null;
    }
    case "machine":
      // SetActiveStateMachine — pick which named State Machine to activate.
      return opts.stateMachineNames.length > 0 ? { options: opts.stateMachineNames, placeholder: "state machine" } : null;
    case "dialogueId":
    case "asset":
      return opts.dialogueNames.length > 0 ? { options: opts.dialogueNames, placeholder: "dialogue" } : null;
    case "sound":
      return opts.soundNames.length > 0 ? { options: opts.soundNames, placeholder: "sound" } : null;
    case "item":
      return opts.itemNames.length > 0 ? { options: opts.itemNames, placeholder: "item" } : null;
    case "recipe":
      return opts.recipeNames.length > 0 ? { options: opts.recipeNames, placeholder: "recipe" } : null;
    case "varOp":
      return { options: ["set", "add", "sub"], placeholder: "set" };
    case "ignore":
      // CM/TM Ignore Input — same shape as Set Paused's mode: lock input,
      // restore it, or flip the current state in one trigger.
      return { options: ["on", "off", "toggle"], placeholder: "mode" };
    case "tracer":
      // OnTracedBy / OnUntracedBy filter by the name of a tracer owned by
      // ANOTHER object (the one hitting this sprite), so the own-BP tracer
      // list doesn't apply — free text (empty = any tracer hitting me).
      if (opts.nodeType === "OnTracedBy" || opts.nodeType === "OnUntracedBy") return null;
      return opts.tracerNames.length > 0 ? { options: opts.tracerNames, placeholder: "any tracer" } : null;
    case "textName":
      // Which Text component a text action targets, by its Name. Empty = the
      // first Text. Only meaningful when the BP has named Text components.
      return opts.textNames.length > 0 ? { options: opts.textNames, placeholder: "first Text" } : null;
    case "componentName": {
      // Set Component Param: pick a SPECIFIC component of the chosen `behavior`
      // kind by Name (3 Texts, Sight/Attack tracers, …). Blank = first of kind.
      const kind = String(siblingParams.behavior ?? "");
      const names = opts.componentsByKind[kind] ?? [];
      return names.length > 0 ? { options: names, placeholder: "first of this kind" } : null;
    }
    case "target": {
      // SetScreenEffect — where to apply the post-FX: whole screen or a layer.
      if (opts.nodeType === "SetScreenEffect") {
        return { options: ["screen", "layer"], placeholder: "target" };
      }
      // The `target` field is shared: particle nodes target an emitter,
      // UI-widget nodes target a widget / child by name. Route by node type.
      const PARTICLE_NODES = new Set<string>([
        "StartParticles", "StopParticles", "BurstParticles",
        "SetParticleRate", "SetParticleSpeed", "SetParticleGravity", "SetParticleSprite",
        "OnParticleBurstEnd",
        "IsEmittingParticles", "IsParticleEmitterEnabled", "CompareParticleCount",
      ]);
      if (opts.nodeType && PARTICLE_NODES.has(opts.nodeType)) {
        return opts.particleEmitterNames.length > 0
          ? { options: opts.particleEmitterNames, placeholder: "any emitter" }
          : null;
      }
      const UI_NODES = new Set<string>([
        "SetUIText", "SetUIValue", "SetUIVisible", "SetUIBgColor", "SetUIElement", "DestroyUIWidget",
      ]);
      if (opts.nodeType && UI_NODES.has(opts.nodeType)) {
        if (opts.widgetNames.length === 0) return null;
        // When editing a widget's OWN sheet, widgetNames is already scoped to
        // self + own elements and the sole `isWidget` entry uses value="" —
        // surface that as the placeholder ("this widget (self)") so a blank
        // pick reads as "the whole widget", and only ELEMENTS appear in the
        // list. Other sheets show every widget (◆) and element (▸).
        const selfEntry = opts.widgetNames.find((t) => t.isWidget && t.value === "");
        const listed = opts.widgetNames.filter((t) => t !== selfEntry);
        if (selfEntry) {
          // Single-mode widget with no children → no elements to list, but
          // still show the dropdown so the blank = "this widget (self)"
          // reads clearly instead of an ambiguous free-text box.
          return buildWidgetDropdown(listed, selfEntry.label) ?? { options: [], placeholder: selfEntry.label };
        }
        return buildWidgetDropdown(listed, "widget / element");
      }
      return null;
    }
    case "widgetName":
      // CreateUIWidget — spawn a widget ASSET, so only whole-widget entries
      // make sense (not elements).
      return buildWidgetDropdown(opts.widgetNames.filter((t) => t.isWidget), "widget");
    case "spriteId": {
      // SetSprite / SetUIElement Image — pick a project sprite. Store the id,
      // show the name.
      if (opts.spriteOptions.length === 0) return null;
      const labels: Record<string, string> = {};
      for (const s of opts.spriteOptions) labels[s.id] = s.name;
      return { options: opts.spriteOptions.map((s) => s.id), placeholder: "sprite", labels };
    }
    case "mode":
      // SetUIVisible — set (use the visible flag) vs toggle (flip current
      // visibility). Scoped by nodeType so the bare `mode` key on other
      // actions (CMSetCeilingMode / CMSetMirror) and the AND/OR Combinator
      // toggle keep their own editors.
      if (opts.nodeType === "SetUIVisible" || opts.nodeType === "SetVisible") return { options: ["set", "toggle"], placeholder: "mode" };
      if (opts.nodeType === "SetPaused") return { options: ["pause", "resume", "toggle"], placeholder: "mode" };
      if (opts.nodeType === "EditTags") return { options: ["insert", "remove", "replace"], placeholder: "mode" };
      if (opts.nodeType === "SetSpriteObjectCollideMode") return { options: ["include", "exclude"], placeholder: "mode" };
      if (opts.nodeType === "PatrolNavPoints") return { options: ["loop", "pingpong", "random", "nearest"], placeholder: "mode" };
      return null;
    case "distFrom":
      // Get Distance source. self = this instance (no field). instance = a
      // sprite by name (needed in the Main Sheet, which has no host position).
      return { options: ["self", "instance"], placeholder: "measure from" };
    case "distTo":
      // Get Distance "measure to" mode. tag → nearest tagged; bp → nearest
      // named blueprint; instance → a sprite by name; point → x/y;
      // picked/mouse need no extra field.
      return { options: ["picked", "tag", "bp", "instance", "mouse", "point"], placeholder: "measure to" };
    case "targetKind":
      // Tween target selector:
      //   self          → the BP running the action
      //   spriteObject  → Sprite Object placement(s) (use `spriteId`)
      //   bp            → BP instance(s) by blueprint name (use `bp`)
      //   bpTag         → every BP carrying a tag (use `targetTag`)
      return { options: ["self", "spriteObject", "bp", "bpTag"], placeholder: "target" };
    case "targetTag":
      // Tween's bpTag target — dropdown of every project tag.
      return opts.tagOptions.length > 0 ? { options: opts.tagOptions, placeholder: "tag" } : null;
    case "slot": {
      // EquipWeapon / PlayWeaponAnimation — pick which WeaponSlot by name.
      const slots = Object.keys(opts.weaponSlotSpriteIds).filter(Boolean);
      return slots.length > 0 ? { options: slots, placeholder: "weapon slot" } : null;
    }
    case "anim":
    case "animation":
      // Drop node: the animation belongs to the SPAWNED blueprint (the node's
      // `bp` param), not this host — route to that BP's SpriteRenderer anims.
      // Free text until a blueprint is picked (nothing to list yet).
      if (opts.nodeType === "DropObject") {
        const dropBp = String(siblingParams.bp ?? "");
        const anims = opts.spriteAnimsByBlueprintName[dropBp] ?? [];
        return anims.length > 0 ? { options: anims, placeholder: "animation" } : null;
      }
      // OnAnimatorAnimEnd's `anim` references an Animator behavior's
      // keyframe-animation name (not a sprite frame anim) — route to
      // animatorAnimNames so the picker offers the right list.
      if (opts.nodeType === "OnAnimatorAnimEnd") {
        return opts.animatorAnimNames.length > 0
          ? { options: opts.animatorAnimNames, placeholder: "any anim" }
          : null;
      }
      // Weapon actions animate the WEAPON sprite, not the host body.
      // EquipWeapon takes the weapon by `spriteId` sibling; PlayWeaponAnimation
      // takes it by `slot` (→ that WeaponSlot's configured weapon sprite).
      if (opts.nodeType === "EquipWeapon") {
        const sid = String(siblingParams.spriteId ?? "");
        const anims = opts.spriteAnimsById[sid] ?? [];
        return anims.length > 0 ? { options: anims, placeholder: "weapon anim" } : null;
      }
      if (opts.nodeType === "PlayWeaponAnimation") {
        const slot = String(siblingParams.slot ?? "");
        const sid = opts.weaponSlotSpriteIds[slot]
          ?? Object.values(opts.weaponSlotSpriteIds)[0] ?? "";
        const anims = opts.spriteAnimsById[sid] ?? [];
        return anims.length > 0 ? { options: anims, placeholder: "weapon anim" } : null;
      }
      // Sprite Object animation actions play the chosen sprite asset's anims
      // (sibling `spriteId`), NOT the host body's SpriteRenderer animations.
      if (opts.nodeType === "PlayPlacementAnim") {
        const sid = String(siblingParams.spriteId ?? "");
        const anims = opts.spriteAnimsById[sid] ?? [];
        return anims.length > 0 ? { options: anims, placeholder: "animation" } : null;
      }
      return opts.animOptions.length > 0 ? { options: opts.animOptions, placeholder: "animation" } : null;
    case "name":
      // Polymorphic by node type. GoToLayout / GoToLayoutWithLoad / SetLoadingScene
      // all target a SCENE, so they must offer scene names — NOT animations/blueprints.
      // CreateSpriteObject's `name` is the AUTHOR-CHOSEN identifier of the new placement
      // (free text — there's nothing to suggest from), so explicitly return null
      // here to keep the field a plain text input instead of falling through to
      // the blueprint-name dropdown below.
      if (opts.nodeType === "GoToLayout" || opts.nodeType === "GoToLayoutWithLoad" || opts.nodeType === "SetLoadingScene") {
        return opts.sceneNames.length > 0 ? { options: opts.sceneNames, placeholder: "scene" } : null;
      }
      if (opts.nodeType === "CreateSpriteObject") return null;
      if (opts.animOptions.length > 0) return { options: opts.animOptions, placeholder: "animation" };
      if (opts.blueprintNames.length > 0) return { options: opts.blueprintNames, placeholder: "blueprint" };
      return null;
    case "effect":
      // SetScreenEffect — fixed dropdown of the screen post-FX kinds.
      if (opts.nodeType === "SetScreenEffect") {
        return { options: ["grayscale", "vhs", "chromatic", "filmgrain"], placeholder: "effect" };
      }
      return null;
    case "scene":
      // IsScene condition — pick from the project's scenes so authors
      // don't have to remember exact names.
      return opts.sceneNames.length > 0 ? { options: opts.sceneNames, placeholder: "scene name" } : null;
    // `placement` is legacy — kept as a no-op fallthrough so any saved
    // node with an old "placement" string still renders. New Sprite
    // Object actions/triggers target by `spriteId` which gets a real
    // sprite-asset dropdown via the existing case above.
    case "placement":
      return null;
    case "bp":
    case "blueprintName":
    case "blueprintId":
      return opts.blueprintNames.length > 0 ? { options: opts.blueprintNames, placeholder: "blueprint" } : null;
    case "tilemap":
      // Drives the `tilemap` param on every tilemap action / condition.
      return opts.tilemapNames.length > 0 ? { options: opts.tilemapNames, placeholder: "tilemap" } : null;
    case "layer": {
      // The `layer` param means two different things:
      //   - On tilemap actions/conditions → INTERNAL tilemap layer
      //     (water/land/foliage). Read the sibling `tilemap` value to know
      //     which tilemap's layers to offer.
      //   - On MoveToLayer etc. → SCENE PARENT layer.
      if (opts.nodeType && TILEMAP_NODE_TYPES.has(opts.nodeType)) {
        const sib = typeof siblingParams.tilemap === "string" ? siblingParams.tilemap : "";
        const layers = sib && opts.tilemapLayersByName[sib]
          ? opts.tilemapLayersByName[sib]
          // Fallback: flat union of every tilemap's layers so the dropdown
          // still works before `tilemap` is chosen.
          : Array.from(new Set(Object.values(opts.tilemapLayersByName).flat()));
        return layers.length > 0 ? { options: layers, placeholder: "layer" } : null;
      }
      return opts.layerNames.length > 0 ? { options: opts.layerNames, placeholder: "scene layer" } : null;
    }
    case "bigTileId":
    case "animatedTileId":
      // Free-text / expression field — pick visually via the BigTilePreview grid
      // (LogicNodeView), OR type a tile NAME, OR feed `var:x` to change what's
      // placed at runtime. The runtime resolves name → id. Returning null here
      // renders the typeable input instead of a fixed dropdown.
      return null;
    case "cmParam": {
      // Whitelist CharacterMovement fields that CMSet / CompareCMParam
      // actually read at runtime. Mirrors the CM behavior's public params.
      const cm = BEHAVIOR_PARAMS.CharacterMovement;
      return cm ? { options: cm.map((p) => p.key), placeholder: "CM parameter" } : null;
    }
    case "param": {
      // TracerSet — pull writable params from the Tracer behavior's meta.
      // Stays generic for any future behavior-specific `param` field that
      // wants to drive its dropdown from BEHAVIOR_PARAMS.
      if (opts.nodeType === "TracerSet") {
        const tr = BEHAVIOR_PARAMS.Tracer;
        return tr ? { options: tr.map((p) => p.key), placeholder: "Tracer param" } : null;
      }
      return null;
    }
    case "op": {
      // Shared key: GlobalArrayOp uses list operations; everything else
      // (Compare*, etc.) uses comparison operators from ENUM_OPTIONS.
      if (opts.nodeType === "GlobalArrayOp") {
        return { options: ["push", "set", "removeAt", "clear"], placeholder: "operation" };
      }
      // CompareValues compares ANY two expressions (names, uids, tags,
      // numbers) so it also offers the string-match operators. The other
      // numeric Compare* nodes keep the bare numeric set.
      if (opts.nodeType === "CompareValues") {
        return { options: [">", "<", ">=", "<=", "==", "!=", "contains", "startsWith", "endsWith"], placeholder: "op" };
      }
      const e = ENUM_OPTIONS["op"];
      return e ? { options: e as string[], placeholder: "op" } : null;
    }
    case "list":
      // Get List Item — pick one of the declared read-only lists.
      return opts.listNames.length > 0 ? { options: opts.listNames, placeholder: "list" } : null;
    case "shopItem":
      // Set UI Element shop role — which item this element sells/shows.
      return opts.itemNames.length > 0 ? { options: opts.itemNames, placeholder: "item" } : null;
    case "key": {
      // Get List Item — entry dropdown for the chosen list (sibling `list`).
      const entries = opts.listEntryNames[String(siblingParams.list ?? "")] ?? [];
      return entries.length > 0 ? { options: entries, placeholder: "entry" } : null;
    }
    case "pick":
      return { options: ["nearest", "random"], placeholder: "pick" };
    case "field": {
      // Shared key: the List/Global getters read item|length|value; the tracer
      // getter reads its hit fields (ENUM_OPTIONS["field"]).
      if (opts.nodeType === "GetListValue") return { options: ["value", "length"], placeholder: "read" };
      if (opts.nodeType === "GetGlobalValue") return { options: ["value", "item", "length"], placeholder: "read" };
      if (opts.nodeType === "GetPicked") {
        // Standard transform/physics fields + the chosen BP's own variables —
        // so you pick CanPickBool (etc.) from the menu, no typing.
        const FIELDS = ["x", "y", "vx", "vy", "angle", "scale", "scaleX", "scaleY", "alpha", "uid", "name", "tag", "instanceTag"];
        const bp = typeof siblingParams.bp === "string" ? siblingParams.bp : "";
        const vars = bp ? (opts.varsByBp[bp] ?? []) : [];
        return { options: [...FIELDS, ...vars], placeholder: bp ? "field / variable" : "pick a BP first" };
      }
      if (opts.nodeType === "GetLastTile") {
        return { options: ["x", "y", "c", "r", "tag", "name", "hp", "maxHP", "tilemap", "layer"], placeholder: "read" };
      }
      if (opts.nodeType === "GetLastDrop") {
        return { options: ["bp", "count", "x", "y", "layer"], placeholder: "read" };
      }
      if (opts.nodeType === "GetLastNavPoint") {
        return { options: ["name", "x", "y"], placeholder: "read" };
      }
      const e = ENUM_OPTIONS["field"];
      return e ? { options: e as string[], placeholder: "field" } : null;
    }
    case "tmParam": {
      // Numeric TopdownMovement params for TMSet / CompareTMParam (skip the
      // string/input-action fields — they're not settable to a number).
      const tm = BEHAVIOR_PARAMS.TopdownMovement;
      return tm ? { options: tm.filter((p) => p.type !== "string" && p.type !== "inputAction").map((p) => p.key), placeholder: "TM parameter" } : null;
    }
    case "direction": {
      // Shared key: SetFacing uses left/right/flip (ENUM_OPTIONS), the TM
      // nodes use movement directions. Branch by node type, else fall back.
      if (opts.nodeType === "TMSimulateControl") return { options: ["up", "down", "left", "right"], placeholder: "direction" };
      if (opts.nodeType === "IsTopdownFacing") return { options: ["up", "down", "left", "right"], placeholder: "facing" };
      if (opts.nodeType === "IsMovingDir") return { options: ["up", "upright", "right", "downright", "down", "downleft", "left", "upleft"], placeholder: "direction" };
      const e = ENUM_OPTIONS["direction"];
      return e ? { options: e as string[], placeholder: "direction" } : null;
    }
  }
  // Closed-set enums (operators, modes, alignment, etc.) — every value
  // the engine recognizes. Strict dropdown, no free text.
  const enumOptions = ENUM_OPTIONS[key];
  if (enumOptions) return { options: enumOptions as string[], placeholder: key };
  return null;
}

/** Compact debug-print container. Renders a small rounded rectangle that
 *  holds 1..N print rows; each row is a single horizontal strip:
 *    [message text input] [DUR / 2.0 stacked] [color swatch] [×]
 *  The "+" button at the bottom-left adds a new row. All rows fire on the
 *  same tick when the chain hits the container. Pin layout: exec input on
 *  the left, exec output on the right — matches the rest of the engine's
 *  horizontal flow. */
/** Minimum visible chars (small default) and max char cap on the message
 *  input. The input grows as you type up to MAX_CHARS — past that wraps in
 *  ellipsis. Width per char is an approximation that's close enough for
 *  the variable-pitch font; final clamp keeps the node's max width at
 *  parity with the rest of the engine's nodes (~240 px text area). */
const DEBUG_MSG_MIN_CHARS = 6;
const DEBUG_MSG_MAX_CHARS = 36;

function DebugPrintNodeView({ data, selected }: { data: NodeData; selected?: boolean }) {
  const { nodeId, params, onParamChange, onDelete } = data;
  const rows = Array.isArray(params.rows) ? params.rows as Array<{ message?: string; color?: string; duration?: number }> : [];
  // Set of message-pin ids that currently have an incoming wire. When a row
  // is wired, the text input hides and a small "(wired)" hint shows instead
  // — same UX as other nodes whose params are driven by upstream getters.
  const wiredMsgPins = useNodeConnections({ handleType: "target", id: nodeId })
    .filter((c) => typeof c.targetHandle === "string" && c.targetHandle.startsWith("msg_"))
    .map((c) => c.targetHandle as string);
  const wiredSet = new Set(wiredMsgPins);
  const updateRow = (idx: number, patch: Partial<{ message: string; color: string; duration: number }>) => {
    const next = rows.map((r, i) => i === idx ? { ...r, ...patch } : r);
    onParamChange(nodeId, { rows: next });
  };
  const addRow = () => {
    onParamChange(nodeId, { rows: [...rows, { message: "", color: "#ff5555", duration: 2 }] });
  };
  const removeRow = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx);
    if (next.length === 0) { onDelete(nodeId); return; }
    onParamChange(nodeId, { rows: next });
  };
  // Row layout constants. The string-pin handles are absolutely positioned
  // against the OUTER node (position: relative), with `top` computed from
  // the row index — that's why the individual row divs do NOT have
  // position: relative (would otherwise scope handles to the row only,
  // collapsing them to the same absolute y).
  const PADDING_TOP = 6;
  const ROW_HEIGHT = 26;
  const ROW_GAP = 4;
  return (
    <div
      style={{
        background: "rgba(50,50,55,0.95)",
        border: `1px solid ${selected ? "var(--yellow, #f5b447)" : "rgba(255,255,255,0.1)"}`,
        borderRadius: 6,
        padding: `${PADDING_TOP}px 8px`,
        display: "inline-flex", flexDirection: "column", gap: ROW_GAP,
        fontSize: 11,
        position: "relative",
      }}
    >
      {/* Exec input on TOP — chain flows vertically through DebugPrint
       *  (matches the figma reference). Centered horizontally by default. */}
      <Handle type="target" position={Position.Top} id="exec" style={{ background: "#88ddff", width: 10, height: 10 }} />
      {rows.map((row, idx) => {
        const pinId = `msg_${idx}`;
        const isWired = wiredSet.has(pinId);
        const msg = row.message ?? "";
        // Auto-expand based on character count, clamped to a sensible range.
        const inputChars = Math.max(DEBUG_MSG_MIN_CHARS, Math.min(DEBUG_MSG_MAX_CHARS, (msg.length || 0) + 2));
        // Vertical center of THIS row in the outer node's coordinate space.
        const handleTop = PADDING_TOP + idx * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2;
        return (
          <div
            key={idx}
            style={{ display: "flex", alignItems: "center", gap: 4, height: ROW_HEIGHT }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Per-row data input pin — wire a variable / getter here to
             *  drive the message text. Top is absolute against the OUTER
             *  node, so each row's pin lands on its row's vertical center. */}
            <Handle
              type="target"
              position={Position.Left}
              id={pinId}
              style={{
                background: PIN_COLORS.string,
                width: 8, height: 8,
                top: handleTop,
                left: -4,
              }}
            />
            {/* Cancel out the wrapper's flex offset for the (visually absent)
             *  handle — without this, the row content shifts right by handle width. */}
            {isWired ? (
              <span style={{
                width: `${DEBUG_MSG_MIN_CHARS}ch`,
                background: "#0a0a0a",
                border: "1px dashed rgba(243,210,74,0.6)",
                borderRadius: 3,
                padding: "3px 6px",
                color: "rgba(243,210,74,0.85)",
                fontSize: 10,
                fontStyle: "italic",
                fontWeight: 600,
                userSelect: "none",
              }}>wired</span>
            ) : (
              <input
                type="text"
                value={msg}
                placeholder="print..."
                onChange={(e) => updateRow(idx, { message: e.target.value })}
                className="nodrag"
                style={{
                  width: `${inputChars}ch`,
                  minWidth: `${DEBUG_MSG_MIN_CHARS}ch`,
                  maxWidth: `${DEBUG_MSG_MAX_CHARS}ch`,
                  background: "#0a0a0a",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 3,
                  padding: "3px 6px",
                  color: "#f0f0f0",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  outline: "none",
                  transition: "width 0.08s linear",
                }}
              />
            )}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1, fontSize: 8, color: "var(--text-dim, #999)" }}>
              <span style={{ fontWeight: 700 }}>DUR</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={row.duration ?? 2}
                onChange={(e) => updateRow(idx, { duration: Number(e.target.value) })}
                className="nodrag"
                style={{
                  width: 34,
                  background: "transparent",
                  border: "none",
                  color: "#ddd",
                  fontSize: 10,
                  fontWeight: 700,
                  textAlign: "center",
                  outline: "none",
                  marginTop: 1,
                }}
              />
            </div>
            <input
              type="color"
              value={row.color ?? "#ff5555"}
              onChange={(e) => updateRow(idx, { color: e.target.value })}
              className="nodrag"
              style={{
                width: 20, height: 20,
                border: "1px solid rgba(0,0,0,0.5)",
                borderRadius: 3,
                cursor: "pointer",
                background: "transparent",
                padding: 0,
              }}
              title="Color"
            />
            <button
              onClick={() => removeRow(idx)}
              className="nodrag"
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.4)",
                fontSize: 12,
                cursor: "pointer",
                padding: "0 2px",
              }}
              title="Remove row"
            >×</button>
          </div>
        );
      })}
      <button
        onClick={addRow}
        className="nodrag"
        style={{
          background: "transparent",
          border: "none",
          color: "rgba(255,255,255,0.6)",
          fontSize: 14,
          fontWeight: 700,
          cursor: "pointer",
          alignSelf: "flex-start",
          padding: "0 4px",
          lineHeight: 1,
        }}
        title="Add print row"
      >+</button>
      {/* Exec output on BOTTOM — chain continues to the next node below. */}
      <Handle type="source" position={Position.Bottom} id="exec" style={{ background: "#88ddff", width: 10, height: 10 }} />
    </div>
  );
}

const nodeTypes = { logicNode: LogicNodeView, debugPrintNode: DebugPrintNodeView };

// Node copy/paste clipboard. MODULE-LEVEL (not a per-canvas ref) so a copy
// survives switching to another Blueprint / Main Sheet — the canvas remounts
// on folder change, which would otherwise wipe an instance ref. This is what
// lets you copy nodes in one BP's logic sheet and paste them into another's.
let logicNodeClipboard: { nodes: LogicGraphNode[]; edges: LogicGraphEdge[] } | null = null;

export function LogicGraphCanvas({ folder, bp, onChange }: LogicGraphCanvasProps) {
  // Selection state — populated by xyflow's onSelectionChange callback
  // in a single batch. We never write `selected: …` onto rfNodes; the
  // visual outline is driven by the `selected` prop xyflow passes to
  // our custom node component from its own internal state. We mirror
  // here only because copy/paste needs to read what's selected.
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const inputActions = useEditor((s) => s.project.inputActions);
  const signals = useEditor((s) => s.project.signals);
  const globalVariables = useEditor((s) => s.project.globalVariables);
  const projectLists = useEditor((s) => s.project.lists);
  const sprites = useEditor((s) => s.project.sprites);
  const blueprints = useEditor((s) => s.project.blueprints);
  const dialogues = useEditor((s) => s.project.dialogues);
  const scenes = useEditor((s) => s.project.scenes);
  const tilemaps = useEditor((s) => s.project.tilemaps);
  const tilesets = useEditor((s) => s.project.tilesets);
  const sounds = useEditor((s) => s.project.sounds);
  const items = useEditor((s) => s.project.items);
  const recipes = useEditor((s) => s.project.recipes);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const historyTick = useEditor((s) => s.historyTick);

  // Cross-object write targets — every OTHER blueprint/widget's variables as
  // `Object.field`. Appended to the var dropdowns so a node can write to e.g.
  // `Player.HP` (the runtime resolves the path to that sprite). The host's own
  // vars stay as bare local names.
  const crossVarEntries = useMemo(() => {
    const out: { path: string; type: string }[] = [];
    const add = (objName: string, vars: { name: string; type: string }[]) => {
      for (const v of vars) if (v.name) out.push({ path: `${objName}.${v.name}`, type: v.type });
    };
    for (const b of blueprints) if (b.id !== bp.id) add(b.name, b.variables ?? []);
    for (const w of uiWidgets) if (w.id !== bp.id) add(w.name, w.variables ?? []);
    return out;
  }, [blueprints, uiWidgets, bp.id]);
  const varNames = useMemo(
    () => [...(bp.variables ?? []).map((v) => v.name).filter(Boolean), ...crossVarEntries.map((e) => e.path)],
    [bp.variables, crossVarEntries],
  );
  // Type-filtered slices of the variable list — node param pickers that
  // target a SPECIFIC type (SetBool/ToggleBool need bool vars; SetVar/
  // AddVar need number vars) read these instead of the unfiltered
  // varNames so the dropdown can't offer the wrong type.
  const boolVarNames = useMemo(
    () => [
      ...(bp.variables ?? []).filter((v) => v.type === "bool").map((v) => v.name).filter(Boolean),
      ...crossVarEntries.filter((e) => e.type === "bool").map((e) => e.path),
    ],
    [bp.variables, crossVarEntries],
  );
  const numberVarNames = useMemo(
    () => [
      ...(bp.variables ?? []).filter((v) => v.type === "number").map((v) => v.name).filter(Boolean),
      ...crossVarEntries.filter((e) => e.type === "number").map((e) => e.path),
    ],
    [bp.variables, crossVarEntries],
  );
  // Variable name → pin type, so a Read-Variable node's output pin is colored
  // and type-checked by what the variable actually HOLDS (string var → pink
  // string pin, bool var → red), not blindly assumed numeric. Covers both the
  // host's bare local names and the `Object.field` cross-object paths.
  const varPinTypes = useMemo(() => {
    const conv = (t: string): "number" | "string" | "boolean" =>
      t === "string" ? "string" : t === "bool" ? "boolean" : "number";
    const m = new Map<string, "number" | "string" | "boolean">();
    for (const v of bp.variables ?? []) if (v.name) m.set(v.name, conv(v.type));
    for (const e of crossVarEntries) m.set(e.path, conv(e.type));
    // Globals share a flat namespace across BPs — index by bare name too so a
    // Set Global value pin can adopt the global's type.
    for (const b of blueprints) for (const v of b.variables ?? []) if (v.global && v.name && !m.has(v.name)) m.set(v.name, conv(v.type));
    return m;
  }, [bp.variables, crossVarEntries, blueprints]);
  // Authored animation names on every Animator component attached to
  // this BP. Used by PlayAnimatorAnim / StopAnimatorAnim node `name`
  // dropdowns so authors pick from real values instead of typing.
  const animatorAnimNames = useMemo(() => {
    const out = new Set<string>();
    for (const b of bp.behaviors) {
      if (b.kind !== "SmartTween") continue;
      const anims = (b.config?.animations ?? []) as Array<{ name?: string }>;
      for (const a of anims) {
        if (a.name) out.add(a.name);
      }
    }
    return Array.from(out).sort();
  }, [bp.behaviors]);
  const behaviorKinds = useMemo(
    () => Array.from(new Set(bp.behaviors.map((b) => b.kind))),
    [bp.behaviors],
  );
  const inputActionNames = useMemo(
    () => inputActions.map((a) => a.name).filter(Boolean),
    [inputActions],
  );
  // Full signal catalog: declared + emitted-in-blueprints + tile signals, each
  // tagged with WHERE it comes from (shown on hover) and grouped by source so
  // the signal dropdown lists them under "Tile signals", "Blueprints", etc.
  const signalCatalog = useMemo(() => {
    const sources: Record<string, string> = {};
    const groups: { label: string; names: string[] }[] = [];
    const addGroup = (label: string, names: string[], src: (n: string) => string) => {
      const uniq = Array.from(new Set(names.filter(Boolean)));
      if (uniq.length === 0) return;
      groups.push({ label, names: uniq });
      for (const n of uniq) if (!sources[n]) sources[n] = src(n);
    };
    const declared = signals.map((s) => s.name).filter(Boolean);
    addGroup("Declared", declared, () => "Declared signal");
    // Tile signals — big + animated tiles' Signal on Hit / on Mine.
    const tile: string[] = [];
    const tileSrc: Record<string, string> = {};
    for (const ts of tilesets ?? []) {
      for (const bt of ts.bigTiles ?? []) {
        if (bt.signalOnHit) { tile.push(bt.signalOnHit); tileSrc[bt.signalOnHit] ??= `Tileset "${ts.name}" · BigTile · on hit`; }
        if (bt.signalOnMine) { tile.push(bt.signalOnMine); tileSrc[bt.signalOnMine] ??= `Tileset "${ts.name}" · BigTile · on mine`; }
      }
      for (const at of ts.animatedTiles ?? []) {
        if (at.signalOnHit) { tile.push(at.signalOnHit); tileSrc[at.signalOnHit] ??= `Tileset "${ts.name}" · Animated "${at.name}" · on hit`; }
        if (at.signalOnMine) { tile.push(at.signalOnMine); tileSrc[at.signalOnMine] ??= `Tileset "${ts.name}" · Animated "${at.name}" · on mine`; }
      }
    }
    addGroup("Tile signals", tile, (n) => tileSrc[n] ?? "Tile signal");
    // Emitted in blueprint logic sheets (EmitSignal / EmitSignalTo nodes).
    const bpSig: string[] = [];
    const bpSrc: Record<string, string> = {};
    for (const b of blueprints) {
      for (const folder of b.logicSheet?.folders ?? []) {
        for (const node of folder.graph?.nodes ?? []) {
          if (node.type !== "EmitSignal" && node.type !== "EmitSignalTo") continue;
          const sig = String((node.params as Record<string, unknown>)?.signal ?? (node.params as Record<string, unknown>)?.name ?? "").trim();
          if (sig) { bpSig.push(sig); bpSrc[sig] ??= `Blueprint "${b.name}"`; }
        }
      }
    }
    addGroup("Emitted by blueprints", bpSig, (n) => bpSrc[n] ?? "Blueprint");
    // Component-emitted signals — free-text fields on behaviors (Projectile's
    // Hit Signal / Tile Hit Signal). Without scanning these, a bullet's hit
    // signal never shows up in another BP's OnSignal picker, so the author
    // can't even select it.
    const compSig: string[] = [];
    const compSrc: Record<string, string> = {};
    for (const b of blueprints) {
      for (const beh of b.behaviors ?? []) {
        if (beh.kind !== "Projectile") continue;
        const cfg = beh.config as Record<string, unknown>;
        const hs = String(cfg?.hitSignal ?? "").trim();
        if (hs) { compSig.push(hs); compSrc[hs] ??= `Blueprint "${b.name}" · Projectile hit`; }
        const ths = String(cfg?.tileHitSignal ?? "").trim();
        if (ths) { compSig.push(ths); compSrc[ths] ??= `Blueprint "${b.name}" · Projectile tile hit`; }
      }
    }
    addGroup("Component signals", compSig, (n) => compSrc[n] ?? "Component signal");
    // UI widget element signals — button click / slider change / dropdown
    // select / slot / craft, plus per-option signals. These broadcast
    // scene-wide now, so ANY blueprint's OnSignal can hear them — without
    // listing them here the author couldn't pick a button's signal in a BP.
    const widgetSig: string[] = [];
    const widgetSrc: Record<string, string> = {};
    const SIG_KEYS = ["signalOnClick", "signalOnHover", "signalOnLeave", "signalOnChange", "signalOnSelect", "signalOnSlotClick", "signalOnSlotDoubleClick", "signalOnCraftClick", "signalOnCraft"];
    const collectWidgetSig = (v: Record<string, unknown>, wName: string) => {
      for (const k of SIG_KEYS) {
        const s = v[k];
        const sig = typeof s === "string" ? s.trim() : "";
        if (sig) { widgetSig.push(sig); widgetSrc[sig] ??= `Widget "${wName}"`; }
      }
      const opts = v.options as Array<{ signal?: unknown }> | undefined;
      for (const o of opts ?? []) {
        const sig = typeof o?.signal === "string" ? o.signal.trim() : "";
        if (sig) { widgetSig.push(sig); widgetSrc[sig] ??= `Widget "${wName}" · option`; }
      }
    };
    for (const w of uiWidgets) {
      collectWidgetSig(w as unknown as Record<string, unknown>, w.name);
      for (const c of w.children ?? []) collectWidgetSig(c as unknown as Record<string, unknown>, w.name);
    }
    addGroup("Widget signals", widgetSig, (n) => widgetSrc[n] ?? "Widget signal");
    // Emitted in widget logic sheets (EmitSignal / EmitSignalTo nodes) — same
    // scan as blueprints, so a signal a widget's sheet sends is selectable in
    // the BP listening for it.
    const widgetEmit: string[] = [];
    const widgetEmitSrc: Record<string, string> = {};
    for (const w of uiWidgets) {
      for (const folder of w.logicSheet?.folders ?? []) {
        for (const node of folder.graph?.nodes ?? []) {
          if (node.type !== "EmitSignal" && node.type !== "EmitSignalTo") continue;
          const sig = String((node.params as Record<string, unknown>)?.signal ?? (node.params as Record<string, unknown>)?.name ?? "").trim();
          if (sig) { widgetEmit.push(sig); widgetEmitSrc[sig] ??= `Widget "${w.name}"`; }
        }
      }
    }
    addGroup("Emitted by widgets", widgetEmit, (n) => widgetEmitSrc[n] ?? "Widget");
    const all = Array.from(new Set([...declared, ...tile, ...bpSig, ...compSig, ...widgetSig, ...widgetEmit]));
    return { all, sources, groups };
  }, [signals, tilesets, blueprints, uiWidgets]);
  const signalNames = signalCatalog.all;
  const globalVarNames = useMemo(() => {
    const set = new Set<string>();
    for (const g of globalVariables ?? []) if (g.name) set.add(g.name);
    // Blueprint variables promoted to Global share the same flat namespace.
    for (const b of blueprints) for (const v of b.variables) if (v.global && v.name) set.add(v.name);
    return Array.from(set);
  }, [globalVariables, blueprints]);
  const listNames = useMemo(
    () => (projectLists ?? []).map((l) => l.name).filter(Boolean),
    [projectLists],
  );
  // list name → its entry names, so the Get List Item node's `key` is a
  // dropdown of the chosen list's entries (not a free-text field).
  const listEntryNames = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const l of projectLists ?? []) m[l.name] = (l.entries ?? []).map((e) => e.name).filter(Boolean);
    return m;
  }, [projectLists]);
  const tagOptions = useMemo(() => {
    // Collect every tag declared across all BPs AND per-instance overrides
    // in the project so a collision/separate/overlap trigger's tag dropdown
    // surfaces real values without typing. Deduped.
    const set = new Set<string>();
    for (const b of blueprints) {
      for (const t of (b.tags ?? [])) {
        if (t) set.add(t);
      }
    }
    for (const sc of scenes) {
      for (const inst of sc.instances) {
        for (const t of (inst.tags ?? [])) {
          if (t) set.add(t);
        }
      }
    }
    return Array.from(set).sort();
  }, [blueprints, scenes]);
  /** Per-BP tag list, keyed by Blueprint NAME (matches the `bp` field on
   *  EditTags / CreateObjectByName). Includes the BP's own tags PLUS any
   *  tags pinned on placed scene instances of that BP — so an instance-
   *  added tag still appears in the EditTags chip picker even if it's not
   *  on the BP definition. Used by the EditTags oldTag dropdown to filter
   *  to "tags the picked BP actually has." */
  const tagsByBp = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const b of blueprints) {
      const set = new Set<string>();
      for (const t of (b.tags ?? [])) if (t) set.add(t);
      for (const sc of scenes) {
        for (const inst of sc.instances) {
          if (inst.blueprintId !== b.id) continue;
          for (const t of (inst.tags ?? [])) if (t) set.add(t);
        }
      }
      if (b.name) m[b.name] = Array.from(set).sort();
    }
    return m;
  }, [blueprints, scenes]);
  // Variable names per BP — populates the "Get Picked" read dropdown so you
  // choose a var from a menu instead of typing it.
  const varsByBp = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const b of blueprints) {
      if (b.name) m[b.name] = (b.variables ?? []).map((v) => v.name).filter(Boolean).sort();
    }
    return m;
  }, [blueprints]);
  const animOptions = useMemo(() => {
    // Anim names come from THIS BP's SpriteRenderer asset. If the BP
    // doesn't have an SR or the sprite asset is missing, fall back to
    // an empty list (input falls back to free text).
    const sr = bp.behaviors.find((b) => b.kind === "SpriteRenderer");
    if (!sr) return [];
    const id = String(sr.config.spriteId ?? "");
    const sprite = sprites.find((s) => s.id === id);
    return sprite ? sprite.animations.map((a) => a.name) : [];
  }, [bp.behaviors, sprites]);
  // spriteId → its animation names. Lets weapon actions (EquipWeapon,
  // PlayWeaponAnimation) list the WEAPON sprite's animations instead of
  // the host body's SpriteRenderer animations.
  const spriteAnimsById = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const s of sprites) m[s.id] = s.animations.map((a) => a.name);
    return m;
  }, [sprites]);
  // Blueprint name → its SpriteRenderer sprite's anims. Lets the Drop node's
  // `animation` field list the SPAWNED bp's animations (resolved from the
  // node's `bp` param), not the host body's.
  const spriteAnimsByBlueprintName = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const b of blueprints) {
      const sr = b.behaviors.find((x) => x.kind === "SpriteRenderer");
      if (!sr) continue;
      const sprite = sprites.find((s) => s.id === String(sr.config.spriteId ?? ""));
      if (sprite && b.name) m[b.name] = sprite.animations.map((a) => a.name);
    }
    return m;
  }, [blueprints, sprites]);
  // WeaponSlot name → its configured weapon spriteId, for THIS BP. Lets
  // PlayWeaponAnimation resolve the weapon sprite from its `slot` param.
  const weaponSlotSpriteIds = useMemo(() => {
    const m: Record<string, string> = {};
    for (const b of bp.behaviors) {
      if (b.kind !== "WeaponSlot") continue;
      const cfg = b.config as { name?: string; spriteId?: string };
      m[String(cfg.name ?? "")] = String(cfg.spriteId ?? "");
    }
    return m;
  }, [bp.behaviors]);
  const stateOptions = useMemo(() => {
    // Animator state names from this BP's CharacterAnimator config +
    // (for NPC BPs) the AIBrain's fixed state list. Both feed the same
    // `state` dropdown — Logic Sheet authors don't care which state
    // machine the name comes from; the trigger / condition kind tells
    // the runtime which to read.
    const names = new Set<string>();
    const an = bp.behaviors.find((b) => b.kind === "StateMachine");
    if (an) {
      const states = (an.config as { states?: Array<{ name: string }> }).states ?? [];
      for (const s of states) if (s.name) names.add(s.name);
    }
    const hasAI = bp.behaviors.some((b) => b.kind === "AIBrain");
    if (hasAI) {
      for (const s of ["idle", "alert", "chase", "search", "attack", "flee", "rest"]) names.add(s);
    }
    return Array.from(names);
  }, [bp.behaviors]);
  // States on this BP's State Machine that HAVE combos — name + step count.
  // Feeds the On Combo Step trigger's `state` dropdown and its `steps`
  // multi-select (N = comboAnimations.length of the chosen state).
  const comboStates = useMemo<{ name: string; steps: number }[]>(() => {
    const an = bp.behaviors.find((b) => b.kind === "StateMachine");
    if (!an) return [];
    const states = (an.config as { states?: Array<{ name?: string; comboAnimations?: string[] }> }).states ?? [];
    const out: { name: string; steps: number }[] = [];
    for (const s of states) {
      const n = s.comboAnimations?.length ?? 0;
      if (s.name && n > 0) out.push({ name: s.name, steps: n });
    }
    return out;
  }, [bp.behaviors]);
  // Names of every State Machine on this BP — the primary (config.machineName,
  // default "Main") + each extra in config.stateMachines. Feeds the `machine`
  // dropdown on SetActiveStateMachine. "(none)" deactivates all.
  const stateMachineNames = useMemo(() => {
    const an = bp.behaviors.find((b) => b.kind === "StateMachine");
    if (!an) return [];
    const cfg = an.config as { machineName?: string; stateMachines?: Array<{ name?: string }> };
    const names = new Set<string>([cfg.machineName || "Main"]);
    for (const m of cfg.stateMachines ?? []) if (m?.name) names.add(m.name);
    return ["(none)", ...names];
  }, [bp.behaviors]);
  const dialogueNames = useMemo(
    () => dialogues.map((d) => d.name).filter(Boolean),
    [dialogues],
  );
  // Names of every Tracer chip on this BP — surfaces as the dropdown
  // for OnTracerHit's `tracer` filter param.
  const tracerNames = useMemo(
    () => bp.behaviors
      .filter((b) => b.kind === "Tracer")
      .map((b) => String((b.config as { name?: string }).name ?? ""))
      .filter(Boolean),
    [bp.behaviors],
  );
  // Names of every Text component on this BP — surfaces as the `textName`
  // dropdown so the text actions can target a specific Text when there are
  // several (one is blank = "first Text").
  const textNames = useMemo(
    () => bp.behaviors
      .filter((b) => b.kind === "Text")
      .map((b) => String((b.config as { name?: string }).name ?? ""))
      .filter(Boolean),
    [bp.behaviors],
  );
  // kind → named component instances of that kind. Powers Set Component Param's
  // `componentName` picker so authors can target a SPECIFIC one of several
  // same-kind components (3 Texts, Sight/Attack tracers, …).
  const componentsByKind = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const b of bp.behaviors) {
      const n = String((b.config as { name?: string }).name ?? "").trim();
      if (n) (m[b.kind] ??= []).push(n);
    }
    return m;
  }, [bp.behaviors]);
  // Names of every ParticleEmitter chip on this BP — surfaces as the
  // dropdown for particle actions' `target` filter param.
  const particleEmitterNames = useMemo(
    () => bp.behaviors
      .filter((b) => b.kind === "ParticleEmitter")
      .map((b) => String((b.config as { name?: string }).name ?? ""))
      .filter(Boolean),
    [bp.behaviors],
  );
  // Project-level sound assets — surfaces as the dropdown for the
  // `sound` param on PlayMusic / PlaySound / StopSound and the
  // IsMusicPlaying / IsSoundPlaying conditions.
  const soundNames = useMemo(
    () => (sounds ?? []).map((s) => s.name).filter(Boolean),
    [sounds],
  );
  // Project-level item assets — surfaces as the `item` dropdown on the
  // inventory action/condition nodes (AddItem / RemoveItem / HasItem / …).
  const itemNames = useMemo(
    () => (items ?? []).map((i) => i.name).filter(Boolean),
    [items],
  );
  const recipeNames = useMemo(
    () => (recipes ?? []).map((r) => r.name).filter(Boolean),
    [recipes],
  );
  // UI widget + child targets — surfaces as the dropdown for the `target`
  // param on SetUIText/Value/Visible/BgColor/Element/DestroyUIWidget and the
  // `widgetName` param on CreateUIWidget.
  //
  // Scope: when editing a WIDGET's own logic sheet (the host `bp` IS a UI
  // widget), the list is restricted to that widget itself + its own elements
  // — a widget can't reach into other widgets. Cross-widget control belongs
  // in the main scene sheet, which (host isn't a widget) sees every widget.
  const widgetNames = useMemo<WidgetTarget[]>(() => {
    const ownerWidget = uiWidgets.find((w) => w.id === bp.id);
    if (ownerWidget) {
      // value "" = self (the runtime resolves an empty target to "this
      // widget / all my children"), surfaced as the placeholder downstream.
      const out: WidgetTarget[] = [{ value: "", label: `◆ ${ownerWidget.name || "this widget"} (this widget)`, isWidget: true }];
      if (ownerWidget.mode === "multi") {
        for (const c of ownerWidget.children ?? []) {
          if (c.name) out.push({ value: c.name, label: `▸ ${c.name}`, isWidget: false });
        }
      }
      return out;
    }
    const out: WidgetTarget[] = [];
    for (const w of uiWidgets) {
      if (w.name) out.push({ value: w.name, label: `◆ ${w.name} (widget)`, isWidget: true });
      if (w.mode === "multi") {
        for (const c of w.children ?? []) {
          if (c.name) out.push({ value: c.name, label: `▸ ${w.name}: ${c.name}`, isWidget: false });
        }
      }
    }
    return out;
  }, [uiWidgets, bp.id]);
  const spriteOptions = useMemo(
    () => sprites.map((s) => ({ id: s.id, name: s.name })),
    [sprites],
  );
  // Project-level reference dropdowns:
  //   blueprintNames — CreateObject / CreateObjectByName / OnCollide-target picks
  //   layerNames     — MoveToLayer (unique across all scenes)
  //   sceneNames     — GoToLayout target picks
  const blueprintNames = useMemo(
    () => blueprints.map((b) => b.name).filter(Boolean),
    [blueprints],
  );
  // This BP's Logic Sheet groups (folders) — drives Set Group Active's `group`
  // dropdown so authors pick an existing group instead of typing its name.
  const logicGroupNames = useMemo(
    () => (bp.logicSheet?.folders ?? []).map((f) => f.name).filter(Boolean),
    [bp.logicSheet],
  );
  const layerNames = useMemo(() => {
    const seen = new Set<string>();
    for (const sc of scenes) for (const l of (sc.layers ?? [])) if (l.name) seen.add(l.name);
    return Array.from(seen);
  }, [scenes]);
  // Tilemap asset names — used by tilemap actions (`SetTile`, `RemoveTile`, …)
  // when their `tilemap` param dropdown asks "which placed tilemap?".
  const tilemapNames = useMemo(
    () => (tilemaps ?? []).map((m) => m.name).filter(Boolean),
    [tilemaps],
  );
  // Map tilemap NAME → that tilemap's internal LAYER names. Tilemap-action
  // `layer` dropdowns read this so users pick from the right tilemap's
  // layers (water/land/foliage), NOT the scene's parent layers.
  const tilemapLayersByName = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const m of (tilemaps ?? [])) {
      if (!m.name) continue;
      out[m.name] = (m.layers ?? []).map((L) => L.name).filter(Boolean);
    }
    return out;
  }, [tilemaps]);
  // Map tilemap NAME → its tileset's BigTile defs ({id, name?}). Drives the
  // `bigTileId` param dropdown on PlaceBigTile / RemoveBigTileAt(World).
  const tilemapBigTilesByName = useMemo(() => {
    const out: Record<string, { id: string; name?: string }[]> = {};
    // Fallback: every BigTile across all tilesets, so the picker is never empty
    // when the author HAS BigTiles but the tilemap→tileset link is off.
    const all = (tilesets ?? []).flatMap((t) => (t.bigTiles ?? []).map((b) => ({ id: b.id, name: (b as { name?: string }).name })));
    for (const m of (tilemaps ?? [])) {
      if (!m.name) continue;
      const ids = [m.tilesetId, ...((m.extraTilesetIds ?? []))];
      const big = ids.flatMap((id) => (tilesets ?? []).find((t) => t.id === id)?.bigTiles ?? []).map((b) => ({ id: b.id, name: (b as { name?: string }).name }));
      out[m.name] = big.length > 0 ? big : all;
    }
    return out;
  }, [tilemaps, tilesets]);
  // Map tilemap NAME → its tileset's AnimatedTile defs. Drives the
  // `animatedTileId` param dropdown on Play/Stop tile-animation actions.
  const tilemapAnimatedTilesByName = useMemo(() => {
    const out: Record<string, { id: string; name?: string }[]> = {};
    const all = (tilesets ?? []).flatMap((t) => (t.animatedTiles ?? []).map((a) => ({ id: a.id, name: a.name })));
    for (const m of (tilemaps ?? [])) {
      if (!m.name) continue;
      const ids = [m.tilesetId, ...((m.extraTilesetIds ?? []))];
      const anim = ids.flatMap((id) => (tilesets ?? []).find((t) => t.id === id)?.animatedTiles ?? []).map((a) => ({ id: a.id, name: a.name }));
      out[m.name] = anim.length > 0 ? anim : all;
    }
    return out;
  }, [tilemaps, tilesets]);
  // Every tag defined on a big/animated tile across all tilesets — the ONLY
  // valid options for Get Tagged Tile (tile tags, NOT sprite/BP tags).
  const tileTags = useMemo(() => {
    const s = new Set<string>();
    for (const t of (tilesets ?? [])) {
      for (const b of (t.bigTiles ?? [])) for (const tag of (b.tags ?? [])) if (tag) s.add(tag);
      for (const a of (t.animatedTiles ?? [])) for (const tag of (a.tags ?? [])) if (tag) s.add(tag);
    }
    return Array.from(s).sort();
  }, [tilesets]);
  // Every nav-mesh WAYPOINT name + tag across all scenes — the options for the
  // nav-point/patrol fields (NOT sprite/BP tags).
  const navPoints = useMemo(() => {
    const s = new Set<string>();
    for (const sc of (scenes ?? [])) {
      for (const w of (sc.navMesh?.waypoints ?? [])) {
        if (w.name) s.add(w.name);
        for (const t of (w.tags ?? [])) if (t) s.add(t);
      }
    }
    return Array.from(s).sort();
  }, [scenes]);
  const sceneNames = useMemo(
    () => scenes.map((s) => s.name).filter(Boolean),
    [scenes],
  );
  // Sprite Object actions/triggers target by SPRITE ASSET name — the
  // author picks a sprite from the dropdown and the runtime acts on the
  // placement created from that sprite. Auto-naming on CreateSpriteObject
  // (when cfg.name is empty) and on scene drop both use the sprite
  // asset's name, so this dropdown stays in sync without authors
  // needing to type matching identifiers.
  const mainLogicSheets = useEditor((s) => s.project.mainLogicSheets ?? []);
  void mainLogicSheets;
  const placementNames = useMemo(
    () => {
      const seen = new Set<string>();
      // Every project sprite is offerable — picking it targets any
      // placement created from this sprite (scene-drop OR runtime
      // CreateSpriteObject auto-named after the asset).
      for (const sp of sprites) if (sp.name) seen.add(sp.name);
      // Also include explicit custom names from scene placements (in
      // case authors named one manually) and CreateSpriteObject nodes
      // (in case they set a custom name).
      for (const sc of scenes) {
        for (const p of sc.spritePlacements ?? []) {
          if (p.name) seen.add(p.name);
        }
      }
      return [...seen];
    },
    [sprites, scenes],
  );
  // Map BP NAME → unique image-point names declared across every frame of every
  // animation of its SpriteRenderer's sprite asset. Drives the Image Points
  // sub-group in the ExpressionPicker — `var:<Object>.IP.<pointName>.x|y`
  // resolves to that point's world position at runtime.
  const imagePointsByBp = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const b of blueprints) {
      const sr = b.behaviors?.find((bh) => bh.kind === "SpriteRenderer");
      const spriteId = sr?.config?.spriteId as string | undefined;
      if (!spriteId) continue;
      const asset = sprites.find((s) => s.id === spriteId);
      if (!asset) continue;
      const seen = new Set<string>();
      for (const anim of asset.animations ?? []) {
        for (const fr of anim.frames ?? []) {
          for (const pt of fr.points ?? []) {
            if (pt.name) seen.add(pt.name);
          }
        }
      }
      if (seen.size > 0) out[b.name] = Array.from(seen);
    }
    return out;
  }, [blueprints, sprites]);

  // Stable callback refs — the rfNodes useMemo depends on these, and
  // recreating them on every render (because they close over `folder`)
  // was rebuilding the whole node list mid-marquee, making xyflow
  // re-process and visibly miscolor the selection until the dust
  // settled ~2 ticks later. We hold a live ref to folder + onChange
  // so the callbacks themselves never change identity.
  const folderRef = useRef(folder);
  const onChangeRef = useRef(onChange);
  const bpRef = useRef(bp);
  useEffect(() => { folderRef.current = folder; }, [folder]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { bpRef.current = bp; }, [bp]);

  const handleParamChange = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    const f = folderRef.current;
    const nextNodes = f.graph.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          // SetUIElement is dynamic: when its target changes, rebuild the
          // param set to match the newly-selected element's widget kind so
          // the node only ever shows params that element actually has.
          if (n.type === "SetUIElement" && "target" in patch) {
            const uiW = useEditor.getState().project.uiWidgets;
            const tgt = String(patch.target ?? "");
            const kind = resolveWidgetKind(tgt, uiW, bpRef.current.id);
            return { ...n, params: buildSetUIElementParams(tgt, kind, n.params) };
          }
          // Particle override toggled ON → seed the override fields from the
          // host BP's ParticleEmitter so the author tweaks from THEIR configured
          // values, not raw engine defaults. Only pulls keys the node already
          // exposes; target/count/override stay as-is. (Uses the host BP's first
          // ParticleEmitter — the common "burst my own emitter" case.)
          if ((n.type === "StartParticles" || n.type === "BurstParticles") && patch.override === true) {
            const pe = bpRef.current.behaviors?.find((b) => b.kind === "ParticleEmitter");
            const cfg = (pe?.config ?? {}) as Record<string, unknown>;
            const seeded: Record<string, unknown> = {};
            for (const k of Object.keys(n.params)) {
              if (k === "override" || k === "target" || k === "count") continue;
              if (k in cfg) seeded[k] = cfg[k];
            }
            // Ensure the frame fields appear even on nodes created before they
            // existed (they're part of the emitter's look, so authors expect them).
            for (const k of ["frameMode", "frameIndices"]) {
              if (k in cfg) seeded[k] = cfg[k];
            }
            return { ...n, params: { ...n.params, ...seeded, ...patch } };
          }
          return { ...n, params: { ...n.params, ...patch } };
    });
    onChangeRef.current({ ...f, graph: { ...f.graph, nodes: nextNodes } });
    // Live-rebuild the edited node's `data` so pin SHAPE that depends on params
    // (Set Variable's value-pin type, Set Component Param pins, Switch cases…)
    // refreshes immediately — the folder-level resync only fires on full
    // rebuilds (folder switch / undo / option-list change), not param edits.
    const updated = nextNodes.find((n) => n.id === nodeId);
    // Rebuild this node's data when its pin SHAPE depends on the changed param:
    // a shape key (var selector, component, switch count…), OR a literal whose
    // output pin type follows the typed value (number vs string vs bool).
    const shapeChanged = Object.keys(patch).some((k) => SHAPE_PARAM_KEYS.has(k))
      || (updated?.kind === "literal" && "value" in patch);
    if (updated && buildRfNodeRef.current && shapeChanged) {
      const data = buildRfNodeRef.current(updated).data;
      setRfNodesStateRef.current?.((prev) => prev.map((rn) => (rn.id === nodeId ? { ...rn, data } : rn)));
    }
  }, []);

  const handleToggleCollapse = useCallback((nodeId: string) => {
    const f = folderRef.current;
    onChangeRef.current({
      ...f,
      graph: {
        ...f.graph,
        nodes: f.graph.nodes.map((n) =>
          n.id === nodeId ? { ...n, collapsed: !n.collapsed } : n,
        ),
      },
    });
    // Mirror into xyflow's live node data so the node folds immediately —
    // folder.id doesn't change, so the rebuild effect won't fire on its own.
    // `setRfNodesState` is a stable useState setter (declared below); empty
    // deps avoid a TDZ read of it in the dependency array.
    setRfNodesState((prev) => prev.map((rn) => {
      if (rn.id !== nodeId) return rn;
      const d = rn.data as unknown as NodeData;
      return { ...rn, data: { ...rn.data, collapsed: !d.collapsed } };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // setRfNodesState / setRfEdgesState / buildRfEdge are declared further
  // down. handleNodeDelete is used by buildRfNode (above them) so it has
  // to live here, but its body needs to call into the later setters.
  // We forward through refs that get assigned once those setters exist.
  const setRfNodesStateRef = useRef<((updater: (prev: RFNode[]) => RFNode[]) => void) | null>(null);
  const setRfEdgesStateRef = useRef<((updater: (prev: RFEdge[]) => RFEdge[]) => void) | null>(null);
  const buildRfEdgeRef = useRef<((e: LogicGraphEdge) => RFEdge) | null>(null);
  const buildRfNodeRef = useRef<((n: LogicGraphNode) => RFNode) | null>(null);
  const handleNodeDelete = useCallback((nodeId: string) => {
    const f = folderRef.current;
    // DebugPrint passthrough on the × path too (matches Delete-key behavior).
    const node = f.graph.nodes.find((n) => n.id === nodeId);
    const bridgeEdges: LogicGraphEdge[] = [];
    if (node?.type === "DebugPrint") {
      const incoming = f.graph.edges.filter((e) =>
        e.target === nodeId && e.targetPin === "exec" && e.pinType === "exec");
      const outgoing = f.graph.edges.filter((e) =>
        e.source === nodeId && e.sourcePin === "exec" && e.pinType === "exec");
      for (const inE of incoming) {
        for (const outE of outgoing) {
          if (inE.source === outE.target && inE.sourcePin === outE.targetPin) continue;
          bridgeEdges.push({
            id: `edge-${Math.random().toString(36).slice(2, 10)}`,
            source: inE.source, sourcePin: inE.sourcePin,
            target: outE.target, targetPin: outE.targetPin,
            pinType: "exec",
          });
        }
      }
    }
    onChangeRef.current({
      ...f,
      graph: {
        nodes: f.graph.nodes.filter((n) => n.id !== nodeId),
        edges: [
          ...f.graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          ...bridgeEdges,
        ],
      },
    });
    // The × path bypasses xyflow's change events, so internal state has to
    // be mirrored manually — otherwise the node stays visible until the
    // folder id flips and the canvas remounts.
    setRfNodesStateRef.current?.((prev) => prev.filter((n) => n.id !== nodeId));
    const mkEdge = buildRfEdgeRef.current;
    if (mkEdge) {
      setRfEdgesStateRef.current?.((prev) => [
        ...prev.filter((e) => e.source !== nodeId && e.target !== nodeId),
        ...bridgeEdges.map(mkEdge),
      ]);
    }
  }, []);

  // Last cursor position over the canvas (page coords), kept fresh by the
  // wrapper's onMouseMove. Ctrl+V reads it to drop the paste under the
  // pointer; cleared on mouse-leave so an off-canvas paste falls back to
  // the legacy offset.
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

  // Copy/paste — Ctrl+C copies the currently selected nodes (plus any
  // internal edges between them) into the module-level clipboard;
  // Ctrl+V pastes a deep copy with fresh ids anchored under the cursor
  // (the top-left-most node lands at the pointer, relative layout kept).
  // The clipboard is module-level so a copy carries across Blueprints.
  // Gated by document focus: ignored when the user is typing in an input field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmd = e.ctrlKey || e.metaKey;
      if (!isCmd) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
      if (e.key === "c" || e.key === "C") {
        if (selectedNodeIds.size === 0) return;
        const nodes = folder.graph.nodes.filter((n) => selectedNodeIds.has(n.id));
        const edges = folder.graph.edges.filter(
          (ed) => selectedNodeIds.has(ed.source) && selectedNodeIds.has(ed.target),
        );
        logicNodeClipboard = {
          nodes: JSON.parse(JSON.stringify(nodes)),
          edges: JSON.parse(JSON.stringify(edges)),
        };
        e.preventDefault();
      } else if (e.key === "x" || e.key === "X") {
        // Cut = copy + delete the selected nodes (and their incident edges).
        if (selectedNodeIds.size === 0) return;
        const nodes = folder.graph.nodes.filter((n) => selectedNodeIds.has(n.id));
        const edges = folder.graph.edges.filter(
          (ed) => selectedNodeIds.has(ed.source) && selectedNodeIds.has(ed.target),
        );
        logicNodeClipboard = {
          nodes: JSON.parse(JSON.stringify(nodes)),
          edges: JSON.parse(JSON.stringify(edges)),
        };
        const keptNodes = folder.graph.nodes.filter((n) => !selectedNodeIds.has(n.id));
        const keptEdges = folder.graph.edges.filter(
          (ed) => !selectedNodeIds.has(ed.source) && !selectedNodeIds.has(ed.target),
        );
        onChange({ ...folder, graph: { nodes: keptNodes, edges: keptEdges } });
        // Mirror to xyflow's internal state so the deletion shows up
        // without waiting for a folder.id remount.
        const cutSet = selectedNodeIds;
        setRfNodesState((prev) => prev.filter((n) => !cutSet.has(n.id)));
        setRfEdgesState((prev) => prev.filter((edge) => !cutSet.has(edge.source) && !cutSet.has(edge.target)));
        setSelectedNodeIds(new Set());
        e.preventDefault();
      } else if (e.key === "v" || e.key === "V") {
        const clip = logicNodeClipboard;
        if (!clip || clip.nodes.length === 0) return;
        // Anchor the paste under the cursor when it's over the canvas;
        // otherwise fall back to the legacy +40,+40 nudge.
        let dx = 40, dy = 40;
        const inst = rfInstanceRef.current;
        const mouse = lastMousePosRef.current;
        if (inst && mouse) {
          const target = inst.screenToFlowPosition({ x: mouse.x, y: mouse.y });
          const minX = Math.min(...clip.nodes.map((n) => n.position.x));
          const minY = Math.min(...clip.nodes.map((n) => n.position.y));
          dx = target.x - minX;
          dy = target.y - minY;
        }
        const idMap = new Map<string, string>();
        const newNodes: LogicGraphNode[] = clip.nodes.map((n) => {
          const newId = `${n.kind}-${Math.random().toString(36).slice(2, 9)}`;
          idMap.set(n.id, newId);
          return {
            ...n,
            id: newId,
            position: { x: n.position.x + dx, y: n.position.y + dy },
          };
        });
        const newEdges: LogicGraphEdge[] = clip.edges.map((ed) => ({
          ...ed,
          id: `edge-${Math.random().toString(36).slice(2, 10)}`,
          source: idMap.get(ed.source) ?? ed.source,
          target: idMap.get(ed.target) ?? ed.target,
        }));
        onChange({
          ...folder,
          graph: {
            nodes: [...folder.graph.nodes, ...newNodes],
            edges: [...folder.graph.edges, ...newEdges],
          },
        });
        // Mirror into xyflow's internal state — without this the new
        // nodes only appear after the canvas re-syncs (folder.id change),
        // which doesn't happen until the modal closes and reopens.
        setRfNodesState((prev) => [...prev, ...newNodes.map(buildRfNode)]);
        setRfEdgesState((prev) => [...prev, ...newEdges.map(buildRfEdge)]);
        // Make the pasted nodes the new selection so a follow-up Ctrl+V
        // duplicates the LATEST set, and Delete removes the paste cleanly.
        setSelectedNodeIds(new Set(newNodes.map((n) => n.id)));
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folder, onChange, selectedNodeIds]);
  // xyflow's internal state for nodes/edges. We initialize from
  // folder.graph and sync back only on settled events (drag stop,
  // node delete, connect) — never during mid-marquee. This breaks
  // the "rebuild during marquee" feedback loop that was causing the
  // 2-second selection settle.
  const [rfNodesState, setRfNodesState, onNodesChangeInternal] = useNodesState<RFNode>([]);
  const [rfEdgesState, setRfEdgesState, onEdgesChangeInternal] = useEdgesState<RFEdge>([]);

  // Build a fresh RFNode from a domain LogicGraphNode. Captured below
  // by useEffect (on folder.id change) and by addNode for new nodes.
  const buildRfNode = useCallback((n: LogicGraphNode): RFNode => {
    // Pick the component theme from the registry. Trigger / branch / flow
    // nodes get a generic Flow or Trigger theme; action / condition nodes
    // route to their owning subsystem (CharacterMovement / Camera / etc.)
    // so authors see component-tagged backgrounds at a glance.
    const theme = n.kind === "trigger"
      ? triggerTheme()
      : n.kind === "action"
        ? actionComponent(n.type)
        : n.kind === "condition"
          ? conditionComponent(n.type)
          : flowTheme();
    const data: NodeData = {
      ...nodeShape(n, varPinTypes),
      nodeType: n.type,
      isTrigger: n.kind === "trigger",
      varNames,
      boolVarNames,
      numberVarNames,
      behaviorKinds,
      inputActionNames,
      signalNames,
      signalCatalog,
      globalVarNames,
      listNames,
      listEntryNames,
      tagOptions,
      tagsByBp,
      varsByBp,
      animOptions,
      spriteAnimsById,
      spriteAnimsByBlueprintName,
      weaponSlotSpriteIds,
      animatorAnimNames,
      stateOptions,
      comboStates,
      stateMachineNames,
      dialogueNames,
      tracerNames,
      textNames,
      componentsByKind,
      particleEmitterNames,
      soundNames,
      itemNames,
      recipeNames,
      widgetNames,
      spriteOptions,
      blueprintNames,
      logicGroupNames,
      layerNames,
      sceneNames,
      placementNames,
      tilemapNames,
      tilemapLayersByName,
      tilemapBigTilesByName,
      tilemapAnimatedTilesByName,
      tileTags,
      navPoints,
      imagePointsByBp,
      hostBpName: bp.name ?? "",
      hostBpId: bp.id,
      componentLabel: theme.label,
      headerBg: theme.headerBg,
      chipBg: theme.chipBg,
      chipFg: theme.chipFg,
      onParamChange: handleParamChange,
      onDelete: handleNodeDelete,
      onToggleCollapse: handleToggleCollapse,
      collapsed: n.collapsed ?? false,
      nodeId: n.id,
    };
    return {
      id: n.id,
      // DebugPrint gets its own compact rectangle renderer; everything else
      // uses the standard component-themed card.
      type: n.type === "DebugPrint" ? "debugPrintNode" : "logicNode",
      position: n.position,
      data: data as unknown as Record<string, unknown>,
      draggable: true,
    };
  }, [varNames, boolVarNames, numberVarNames, behaviorKinds, inputActionNames, signalNames, signalCatalog, globalVarNames, listNames, listEntryNames, tagOptions, varsByBp, animOptions, spriteAnimsById, spriteAnimsByBlueprintName, weaponSlotSpriteIds, animatorAnimNames, stateOptions, comboStates, stateMachineNames, dialogueNames, tracerNames, textNames, componentsByKind, particleEmitterNames, soundNames, itemNames, recipeNames, widgetNames, spriteOptions, blueprintNames, logicGroupNames, layerNames, sceneNames, placementNames, tilemapNames, tilemapLayersByName, tilemapBigTilesByName, tilemapAnimatedTilesByName, imagePointsByBp, varPinTypes, bp.name, handleParamChange, handleNodeDelete, handleToggleCollapse]);

  const buildRfEdge = useCallback((e: LogicGraphEdge): RFEdge => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourcePin,
    target: e.target,
    targetHandle: e.targetPin,
    // Exec edges get the custom edge type so the midpoint debug-insert
    // icon renders. Other pin types (data wires) stay default; the icon
    // would be confusing on a value pipe.
    type: e.pinType === "exec" ? "execWithInsert" : undefined,
    style: { stroke: PIN_COLORS[e.pinType] ?? PIN_COLORS.exec, strokeWidth: e.pinType === "exec" ? 2.5 : 1.5 },
    animated: e.pinType === "exec",
    interactionWidth: 20,
    data: { pinType: e.pinType },
  }), []);

  // Bind the forward refs used by handleNodeDelete (declared earlier so
  // it can be wired into buildRfNode's data). useLayoutEffect so the refs
  // are set before any user click can fire — useEffect would have a
  // 1-tick gap where × clicks would no-op the visual delete.
  useEffect(() => {
    setRfNodesStateRef.current = setRfNodesState;
    setRfEdgesStateRef.current = setRfEdgesState;
    buildRfEdgeRef.current = buildRfEdge;
    buildRfNodeRef.current = buildRfNode;
  }, [setRfNodesState, setRfEdgesState, buildRfEdge, buildRfNode]);

  // Initialize / re-init when we switch folders. Critical: depend on
  // folder.id, NOT folder, so re-renders with the same folder don't
  // reset xyflow's internal state (selection, drag, etc.).
  useEffect(() => {
    setRfNodesState(folderRef.current.graph.nodes.map(buildRfNode));
    setRfEdgesState(folderRef.current.graph.edges.map(buildRfEdge));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id]);

  // Force a full rebuild from folder.graph on undo/redo. Those revert graph
  // CONTENT without changing folder.id, so the [folder.id] effect above
  // wouldn't fire and the canvas would keep showing the pre-undo nodes.
  // Skips the initial mount (the [folder.id] effect already built it).
  const didMountTick = useRef(false);
  useEffect(() => {
    if (!didMountTick.current) { didMountTick.current = true; return; }
    setRfNodesState(folderRef.current.graph.nodes.map(buildRfNode));
    setRfEdgesState(folderRef.current.graph.edges.map(buildRfEdge));
    setSelectedNodeIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyTick]);

  // Re-sync only the node `data` field when option lists change (vars,
  // anims, etc.) — preserves selection / position / dragging state.
  useEffect(() => {
    setRfNodesState((prev) => prev.map((n) => {
      const domain = folderRef.current.graph.nodes.find((dn) => dn.id === n.id);
      if (!domain) return n;
      return { ...n, data: buildRfNode(domain).data };
    }));
  }, [buildRfNode, setRfNodesState]);

  // Wrap xyflow's internal onNodesChange. Selection / drag / dimension
  // changes ALL apply only to internal state (so the marquee experience
  // is instant — no parent re-render mid-drag). Position drops and node
  // removals additionally commit to folder.graph so they persist.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // DebugPrint passthrough: detect removals BEFORE xyflow processes
      // them — at this point folder.graph still has the DebugPrint's
      // exec wires intact. handleEdgesChange runs later and would wipe
      // them, leaving handleNodesDelete unable to compute bridges.
      // Snapshot here, compute bridges, commit folder + xyflow in one go.
      const f = folderRef.current;
      const dbgRemovals: LogicGraphNode[] = [];
      for (const c of changes) {
        if (c.type === "remove") {
          const node = f.graph.nodes.find((n) => n.id === c.id);
          if (node && node.type === "DebugPrint") dbgRemovals.push(node);
        }
      }
      if (dbgRemovals.length > 0) {
        const removedIds = new Set(dbgRemovals.map((n) => n.id));
        const bridgeEdges: LogicGraphEdge[] = [];
        for (const node of dbgRemovals) {
          const incoming = f.graph.edges.filter((e) =>
            e.target === node.id && e.targetPin === "exec" && e.pinType === "exec");
          const outgoing = f.graph.edges.filter((e) =>
            e.source === node.id && e.sourcePin === "exec" && e.pinType === "exec");
          for (const inEdge of incoming) {
            for (const outEdge of outgoing) {
              if (inEdge.source === outEdge.target && inEdge.sourcePin === outEdge.targetPin) continue;
              bridgeEdges.push({
                id: `edge-${Math.random().toString(36).slice(2, 10)}`,
                source: inEdge.source, sourcePin: inEdge.sourcePin,
                target: outEdge.target, targetPin: outEdge.targetPin,
                pinType: "exec",
              });
            }
          }
        }
        // Commit folder.graph with node removed + bridges added. The edges
        // attached to the removed node are also filtered out here so the
        // subsequent handleEdgesChange (which fires separately for the
        // removed edges) just no-ops on already-gone edges.
        const survivingEdges = f.graph.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target));
        onChangeRef.current({
          ...f,
          graph: {
            nodes: f.graph.nodes.filter((n) => !removedIds.has(n.id)),
            edges: [...survivingEdges, ...bridgeEdges],
          },
        });
        // Mirror to xyflow's edge state so the bridge shows immediately.
        setRfEdgesState((prev) => [
          ...prev.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target)),
          ...bridgeEdges.map(buildRfEdge),
        ]);
      }
      onNodesChangeInternal(changes);
      // Track selection set for copy/paste (read at Ctrl+C time).
      const addSel = new Set<string>();
      const removeSel = new Set<string>();
      let selectionTouched = false;
      for (const c of changes) {
        if (c.type === "select") {
          selectionTouched = true;
          if (c.selected) addSel.add(c.id);
          else removeSel.add(c.id);
        }
      }
      if (selectionTouched) {
        setSelectedNodeIds((prev) => {
          const next = new Set(prev);
          for (const id of removeSel) next.delete(id);
          for (const id of addSel) next.add(id);
          return next;
        });
      }
    },
    [onNodesChangeInternal, setRfEdgesState, buildRfEdge],
  );

  /** DebugPrint nodes we've already bridged this session. Both
   *  handleNodesChange and handleEdgesChange can hit the rewire path
   *  (depending on which xyflow change-handler fires first for a given
   *  delete batch) — this set keeps a second pass from creating
   *  duplicate bridge edges for the same DebugPrint. */
  const bridgedDebugIdsRef = useRef<Set<string>>(new Set());
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === "remove");
      if (removed.length > 0) {
        // Look BEFORE applying changes — folder.graph still has the edges,
        // and (critically) folder.graph.nodes still has the DebugPrints
        // until handleNodesChange fires. If the edge being removed has a
        // DebugPrint endpoint, capture its other-side edges and create a
        // bridge. The dedup ref prevents the same DebugPrint from being
        // bridged twice (once via the incoming half, once via outgoing).
        const f = folderRef.current;
        const removedEdgeIds = new Set(removed.map((c) => (c as { id: string }).id));
        const bridgeEdges: LogicGraphEdge[] = [];
        const dbgToBridge = new Set<string>();
        for (const c of removed) {
          const e = f.graph.edges.find((x) => x.id === (c as { id: string }).id);
          if (!e || e.pinType !== "exec") continue;
          const srcNode = f.graph.nodes.find((n) => n.id === e.source);
          const dstNode = f.graph.nodes.find((n) => n.id === e.target);
          if (srcNode?.type === "DebugPrint") dbgToBridge.add(srcNode.id);
          if (dstNode?.type === "DebugPrint") dbgToBridge.add(dstNode.id);
        }
        for (const dbgId of dbgToBridge) {
          if (bridgedDebugIdsRef.current.has(dbgId)) continue;
          bridgedDebugIdsRef.current.add(dbgId);
          const incoming = f.graph.edges.filter((e) =>
            e.target === dbgId && e.targetPin === "exec" && e.pinType === "exec");
          const outgoing = f.graph.edges.filter((e) =>
            e.source === dbgId && e.sourcePin === "exec" && e.pinType === "exec");
          for (const inE of incoming) {
            for (const outE of outgoing) {
              if (inE.source === outE.target && inE.sourcePin === outE.targetPin) continue;
              bridgeEdges.push({
                id: `edge-${Math.random().toString(36).slice(2, 10)}`,
                source: inE.source, sourcePin: inE.sourcePin,
                target: outE.target, targetPin: outE.targetPin,
                pinType: "exec",
              });
            }
          }
        }
        if (bridgeEdges.length > 0 || removedEdgeIds.size > 0) {
          const survivingEdges = f.graph.edges.filter((e) => !removedEdgeIds.has(e.id));
          onChangeRef.current({
            ...f,
            graph: {
              ...f.graph,
              edges: [...survivingEdges, ...bridgeEdges],
            },
          });
          setRfEdgesState((prev) => [
            ...prev.filter((e) => !removedEdgeIds.has(e.id)),
            ...bridgeEdges.map(buildRfEdge),
          ]);
          // We already mirrored xyflow internal state; skip the default
          // onEdgesChangeInternal call so it doesn't replay the removes
          // on top of our manual state update.
          // Apply only non-remove changes through xyflow's reducer.
          const otherChanges = changes.filter((c) => c.type !== "remove");
          if (otherChanges.length > 0) onEdgesChangeInternal(otherChanges);
          return;
        }
      }
      onEdgesChangeInternal(changes);
    },
    [onEdgesChangeInternal, setRfEdgesState, buildRfEdge],
  );
  // Clear the bridged-set whenever the folder identity flips. Otherwise a
  // DebugPrint id from one Logic Sheet could spuriously block bridging in
  // another sheet (very low likelihood given random ids, but a session
  // can compound a lot).
  useEffect(() => { bridgedDebugIdsRef.current = new Set(); }, [folder.id]);

  // Commit position changes to folder.graph only when the drag actually
  // ends — not on every mid-drag tick. This is the key fix: parent
  // re-renders only happen at settled drag points, never during marquee.
  const handleNodeDragStop = useCallback(
    (_e: unknown, _node: RFNode, nodes: RFNode[]) => {
      const movedIds = new Set(nodes.map((n) => n.id));
      const f = folderRef.current;
      onChangeRef.current({
        ...f,
        graph: {
          ...f.graph,
          nodes: f.graph.nodes.map((dn) => {
            if (!movedIds.has(dn.id)) return dn;
            const rf = nodes.find((rn) => rn.id === dn.id);
            if (!rf) return dn;
            if (rf.position.x === dn.position.x && rf.position.y === dn.position.y) return dn;
            return { ...dn, position: { x: rf.position.x, y: rf.position.y } };
          }),
        },
      });
    },
    [],
  );

  const handleNodesDelete = useCallback(
    (deleted: RFNode[]) => {
      // DebugPrint deletions already committed to folder.graph by
      // handleNodesChange (which sees them BEFORE handleEdgesChange wipes
      // the connecting wires) — including any bridge edges. This handler
      // only needs to commit non-DebugPrint deletions.
      const removeIds = new Set(deleted.map((n) => n.id));
      const f = folderRef.current;
      // If the only nodes deleted were DebugPrints, folder.graph is
      // already up to date — bail.
      const stillPresent = deleted.some((rf) => f.graph.nodes.some((n) => n.id === rf.id));
      if (stillPresent) {
        onChangeRef.current({
          ...f,
          graph: {
            nodes: f.graph.nodes.filter((n) => !removeIds.has(n.id)),
            edges: f.graph.edges.filter((e) => !removeIds.has(e.source) && !removeIds.has(e.target)),
          },
        });
      }
      setSelectedNodeIds((prev) => {
        const next = new Set(prev);
        for (const id of removeIds) next.delete(id);
        return next;
      });
    },
    [],
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
      const f = folderRef.current;
      // Exec-ness is decided by the source node's declared output pins, so any
      // multi-exec node (Branch true/false, Switch case_*/default, …) is handled
      // without hardcoding pin names here.
      const srcNode = f.graph.nodes.find((n) => n.id === conn.source);
      const srcShape = srcNode ? nodeShape(srcNode, varPinTypes) : null;
      const isExecOut = !!srcShape && srcShape.outExec.some((o) => o.pin === conn.sourceHandle);
      // Wire color = the source pin's actual declared type (same source of
      // truth as the guard + rendered pin), falling back to inferPinType.
      const outType = srcShape?.outData.find((o) => o.pin === conn.sourceHandle)?.type as LogicGraphEdge["pinType"] | undefined;
      const pinType: LogicGraphEdge["pinType"] = isExecOut ? "exec" : (outType ?? inferPinType(conn, f, varPinTypes));
      // Exec pins FAN OUT: one output may wire to many targets (Construct-
      // style "on this event, do A and B"), and a target may take many
      // inputs. So exec connections add without stripping siblings — the
      // runtime walker runs every wired target. Data pins stay 1-in per
      // target pin (a value input takes a single source).
      const stripped = pinType === "exec"
        ? f.graph.edges
        : f.graph.edges.filter((e) =>
            !(e.target === conn.target && e.targetPin === conn.targetHandle));
      const newEdge: LogicGraphEdge = {
        id: `edge-${Math.random().toString(36).slice(2, 10)}`,
        source: conn.source,
        sourcePin: conn.sourceHandle,
        target: conn.target,
        targetPin: conn.targetHandle,
        pinType,
      };
      // Reject exact duplicates.
      if (f.graph.edges.some((e) =>
        e.source === conn.source && e.sourcePin === conn.sourceHandle
        && e.target === conn.target && e.targetPin === conn.targetHandle)) return;
      onChangeRef.current({
        ...f,
        graph: { ...f.graph, edges: [...stripped, newEdge] },
      });
      // Mirror to xyflow internal state.
      setRfEdgesState((prev) => addEdge(buildRfEdge(newEdge), prev));
    },
    [setRfEdgesState, buildRfEdge, varPinTypes],
  );

  // Live type guard (React Flow calls this while dragging a wire): block
  // mismatched connections so they never snap. Rules:
  //   - exec pins connect ONLY to exec pins (and vice-versa).
  //   - a value pin must match type EXACTLY among number / string / boolean
  //     (green / pink / red). Other types (spriteRef, untyped) are permissive
  //     since they can't be reliably inferred.
  const isValidConnection = useCallback((conn: Connection | RFEdge): boolean => {
    if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return false;
    if (conn.source === conn.target) return false;
    const f = folderRef.current;
    const srcNode = f.graph.nodes.find((n) => n.id === conn.source);
    const tgtNode = f.graph.nodes.find((n) => n.id === conn.target);
    if (!srcNode || !tgtNode) return false;
    const srcShape = nodeShape(srcNode, varPinTypes);
    const tgtShape = nodeShape(tgtNode, varPinTypes);
    const srcIsExec = srcShape.outExec.some((o) => o.pin === conn.sourceHandle);
    const tgtIsExec = tgtShape.inExec.some((i) => i.pin === conn.targetHandle);
    if (srcIsExec || tgtIsExec) return srcIsExec && tgtIsExec; // exec ↔ exec only
    // Both are data pins — enforce exact type for the colored primitives.
    // Read BOTH sides from nodeShape (the same source of truth that colors the
    // pins) so the guard can never disagree with what the author sees — e.g. a
    // getter / Random pin shown as string is treated as string, not number.
    const PRIM = new Set(["number", "string", "boolean"]);
    const srcType = srcShape.outData.find((o) => o.pin === conn.sourceHandle)?.type;
    const tgtType = tgtShape.inData.find((i) => i.pin === conn.targetHandle)?.type;
    if (srcType && tgtType && PRIM.has(srcType) && PRIM.has(tgtType) && srcType !== tgtType) return false;
    return true;
  }, [varPinTypes]);

  /** Wire-insert: drop a compact DebugPrint node onto an existing exec
   *  edge. Splits the wire so chain ordering is preserved — the source's
   *  exec now flows source → DebugPrint → original target. Refuses to
   *  insert a second DebugPrint between the same pair (i.e. on either
   *  half of an already-split wire) — at most ONE per original wire. */
  const splitEdgeWithDebugPrint = useCallback((edgeId: string, midX: number, midY: number) => {
    const f = folderRef.current;
    const edge = f.graph.edges.find((e) => e.id === edgeId);
    if (!edge || edge.pinType !== "exec") return;
    // Refuse to chain a second DebugPrint when either endpoint is already
    // one. Keeps the graph readable and matches author intent — the icon
    // on the split halves is just leftover from React Flow rendering.
    const srcNode = f.graph.nodes.find((n) => n.id === edge.source);
    const dstNode = f.graph.nodes.find((n) => n.id === edge.target);
    if (srcNode?.type === "DebugPrint" || dstNode?.type === "DebugPrint") return;
    const newNodeId = `action-${Math.random().toString(36).slice(2, 9)}`;
    const newNode: LogicGraphNode = {
      id: newNodeId,
      kind: "action",
      type: "DebugPrint",
      params: { rows: [{ message: "", color: "#ff5555", duration: 2 }] },
      position: { x: midX - 120, y: midY - 20 },
    };
    // Replace original edge with two stitched edges.
    const restEdges = f.graph.edges.filter((e) => e.id !== edgeId);
    const e1: LogicGraphEdge = {
      id: `e-${Math.random().toString(36).slice(2, 9)}`,
      source: edge.source, sourcePin: edge.sourcePin,
      target: newNodeId, targetPin: "exec",
      pinType: "exec",
    };
    const e2: LogicGraphEdge = {
      id: `e-${Math.random().toString(36).slice(2, 9)}`,
      source: newNodeId, sourcePin: "exec",
      target: edge.target, targetPin: edge.targetPin,
      pinType: "exec",
    };
    onChangeRef.current({
      ...f,
      graph: {
        ...f.graph,
        nodes: [...f.graph.nodes, newNode],
        edges: [...restEdges, e1, e2],
      },
    });
    // Mirror xyflow internal state so the change is visible without a remount.
    setRfNodesState((prev) => [...prev, buildRfNode(newNode)]);
    setRfEdgesState((prev) => [
      ...prev.filter((e) => e.id !== edgeId),
      buildRfEdge(e1),
      buildRfEdge(e2),
    ]);
  }, [setRfNodesState, setRfEdgesState]);
  // Bind the module-level dispatch ref so the custom edge component
  // (which can't see this hook scope) can call back into the active
  // canvas. Reset on unmount so stale dispatch from a closed editor
  // doesn't fire if some delayed click still squeaks through.
  useEffect(() => {
    _splitEdgeDispatch = splitEdgeWithDebugPrint;
    return () => { _splitEdgeDispatch = null; };
  }, [splitEdgeWithDebugPrint]);

  const addNode = useCallback(
    (entry: PaletteEntry, atPosition?: { x: number; y: number }) => {
      const f = folderRef.current;
      const existing = f.graph.nodes;
      let x: number;
      let y: number;
      if (atPosition) {
        // RMB-picker spawn — drop the node exactly where the user clicked.
        x = atPosition.x;
        y = atPosition.y;
      } else {
        x = 40;
        y = 40 + (existing.filter((n) => n.kind === "trigger").length * 220);
        if (entry.kind !== "trigger" && existing.length > 0) {
          const maxX = Math.max(...existing.map((n) => n.position.x));
          x = maxX + 240;
          y = existing[0].position.y;
        }
      }
      const id = `${entry.kind}-${Math.random().toString(36).slice(2, 9)}`;
      const newNode: LogicGraphNode = {
        id,
        kind: entry.kind,
        type: entry.type,
        params: { ...entry.defaults },
        position: { x, y },
      };
      onChangeRef.current({
        ...f,
        graph: { ...f.graph, nodes: [...f.graph.nodes, newNode] },
      });
      // Mirror to xyflow internal state.
      setRfNodesState((prev) => [...prev, buildRfNode(newNode)]);
    },
    [setRfNodesState, buildRfNode],
  );

  // RMB context menu picker — captures the canvas click position so a
  // selected entry spawns its node exactly where the author right-clicked
  // (UE5 Blueprint style). screenToFlowPosition translates from page
  // coords (where the popup sits) to flow-canvas coords (where the node
  // lands). The popup itself is rendered as a fixed overlay.
  const rfInstanceRef = useRef<{ screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number } } | null>(null);
  const [picker, setPicker] = useState<{ clientX: number; clientY: number; flowX: number; flowY: number } | null>(null);

  const handlePaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const inst = rfInstanceRef.current;
    if (!inst) return;
    const flowPos = inst.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setPicker({ clientX: event.clientX, clientY: event.clientY, flowX: flowPos.x, flowY: flowPos.y });
  }, []);

  return (
    <div
      style={{ width: "100%", height: "100%" }}
      // Block the browser's native context menu over the whole canvas so
      // RMB cleanly belongs to xyflow (pan-drag) + our picker — without
      // this, the browser menu pops up on top of the picker / overrides
      // xyflow's right-button pan handler. onPaneContextMenu still fires
      // the picker on empty-pane clicks; node clicks just no-op.
      onContextMenu={(e) => e.preventDefault()}
      onMouseMove={(e) => { lastMousePosRef.current = { x: e.clientX, y: e.clientY }; }}
      onMouseLeave={() => { lastMousePosRef.current = null; }}
    >
      <ReactFlow
        nodes={rfNodesState}
        edges={rfEdgesState}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(inst) => { rfInstanceRef.current = inst; }}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={handleNodesDelete}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onPaneContextMenu={handlePaneContextMenu}
        deleteKeyCode={["Delete", "Backspace"]}
        multiSelectionKeyCode={["Control", "Meta", "Shift"]}
        selectionOnDrag
        panOnDrag={[1, 2]}
        selectionMode={SelectionMode.Partial}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="rgba(255,255,255,0.06)" />
        <Controls />
      </ReactFlow>
      {picker && (
        <NodePickerPopup
          clientX={picker.clientX}
          clientY={picker.clientY}
          isMainSheet={bp.id.startsWith("__main__:")}
          onClose={() => setPicker(null)}
          onPick={(entry) => {
            addNode(entry, { x: picker.flowX, y: picker.flowY });
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Node palette catalog. Each entry knows how to create a fresh node of
// its type at a given position. Param defaults match what the executor
// reads in LogicSheetRunner.ts so a freshly dropped node already works
// (filling in tag/var/etc. is then the author's job).
// ──────────────────────────────────────────────────────────────────────

export interface PaletteEntry {
  type: string;
  kind: LogicGraphNode["kind"];
  label: string;
  defaults: Record<string, unknown>;
}

/**
 * UE5-style right-click context-menu picker. Opens at the canvas point
 * where the author RMB-clicked, focuses a search box, and shows every
 * PALETTE entry filtered by the query. Selecting one spawns the node at
 * the original click position (mapped through xyflow's screenToFlow).
 *
 * Each result row shows the component chip + the action label so authors
 * can scan by color OR by name. Arrow keys + Enter for keyboard nav;
 * Esc / outside-click closes.
 */
// Hover descriptions for pure getter nodes (kind "getter"). Actions/conditions
// pull from the shared ACTION/CONDITION_DESCRIPTIONS; getters aren't engine
// kinds so they have no shared entry — keep their docs here.
export { GETTER_DESCRIPTIONS } from "./nodeDocs";
import { nodeDescription } from "./nodeDocs";

// Node types hidden from the Logic Sheet picker:
//  - Pick* / ForEach: legacy Construct-style picking conditions whose targeting
//    only works in the old event-sheet runner (Sprite.tryFire) — in the node
//    graph they have no tag field and no SOL, so they do nothing.
//  - RandomNumber: the var-writing action is superseded by the pure Random
//    Range generator (wire its output into SetVar).
// TODO: delete these kinds from the engine registries entirely.
export const HIDDEN_FROM_PICKER = new Set<string>([
  "PickAll", "PickRandom", "PickByHighest", "PickByLowest", "PickNth", "PickByComparison", "ForEach",
  "RandomNumber",
  // Dead event-sheet-era conditions — no-op / always-true|false in the node graph.
  "TriggerOnceWhileTrue", "Else", "IsAnimatorAnimPlaying",
  // Legacy event-group toggle — use Set Group Active (Logic Sheet folders) instead.
  "SetEventGroupEnabled",
]);
// Repeat/While exist as BOTH a working flow ACTION and a dead CONDITION (same
// type name). Hide only the condition copy.
export const HIDDEN_CONDITIONS = new Set<string>(["Repeat", "While"]);

// Tokenize a label/type/chip into lowercase words, splitting on whitespace,
// punctuation AND camelCase boundaries — so "CharacterMovement", "Character
// Movement" and "character movement" all become ["character","movement"]. The
// node search matches each typed word as a PREFIX of one of these tokens, which
// is what lets a multi-word query ("character movement") find a compound chip
// while a mid-word fragment ("ate", "mac") never floods unrelated subsystems.
function searchWords(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function NodePickerPopup({
  clientX, clientY, onPick, onClose, isMainSheet,
}: {
  clientX: number;
  clientY: number;
  onPick: (entry: PaletteEntry) => void;
  onClose: () => void;
  isMainSheet: boolean;
}) {
  const [query, setQuery] = useState("");
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // True only when the highlight last moved via the ARROW KEYS. The scroll-
  // into-view effect checks this so mouse hover (which also moves the
  // highlight) doesn't scroll the list — that caused a feedback loop where
  // hovering a bottom row scrolled it up under the cursor, re-highlighting the
  // next row and scrolling again.
  const kbdNavRef = useRef(false);

  // Flatten every PALETTE entry into a single searchable list, tagging
  // each with the same theme used by LogicNodeView so the row chips
  // match the eventual node's chips.
  const allEntries = useMemo(() => {
    const out: { entry: PaletteEntry; chip: { bg: string; fg: string; label: string } }[] = [];
    // A kind can legitimately appear in BOTH a curated PALETTE group and the
    // auto-generated component groups when the curated set in nodeRegistry
    // (CURATED_ACTION_KINDS / CURATED_CONDITION_KINDS) misses it. Dedup by
    // (kind:type), keeping the FIRST occurrence — curated groups come first in
    // PALETTE so their friendlier label wins — so the picker never shows the
    // same node twice no matter how the registries drift.
    const seen = new Set<string>();
    for (const { entries } of PALETTE) {
      for (const e of entries) {
        // OnDestroyed binds to the sheet's host sprite. The Main sheet's host
        // is the invisible MainLogicSheet sprite that never dies, so the
        // trigger can never fire there — hide it (it's BP/Widget-sheet only).
        if (isMainSheet && e.type === "OnDestroyed") continue;
        // Dead/superseded nodes hidden from the picker (legacy Pick*/ForEach,
        // and RandomNumber → use the Random Range generator). See the set.
        if (HIDDEN_FROM_PICKER.has(e.type)) continue;
        if (e.kind === "condition" && HIDDEN_CONDITIONS.has(e.type)) continue;
        const dedupKey = `${e.kind}:${e.type}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const theme = e.kind === "trigger"
          ? triggerTheme()
          : e.kind === "action"
            ? actionComponent(e.type)
            : e.kind === "condition"
              ? conditionComponent(e.type)
              : flowTheme();
        out.push({ entry: e, chip: { bg: theme.chipBg, fg: theme.chipFg, label: theme.label } });
      }
    }
    return out;
  }, [isMainSheet]);

  // Substring match across the node's label, its type, AND its component
  // chip label — so typing a category word ("damage", "combat", "input",
  // "camera") surfaces that subsystem's nodes, not just exact name hits.
  // Component matches rank BELOW name/type matches so a precise node-name
  // query still wins the top slots (typing "move" lists the MoveTo nodes
  // first, then the rest of the CharacterMovement group beneath them).
  // Sorted: name-prefix > type-prefix > name-substring > type-substring >
  // component-substring.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allEntries;
    // Each typed word must PREFIX some token of the field — so "character
    // movement" (two words) matches the "CharacterMovement" chip, but "ate" /
    // "mac" never do. Component matches rank below name/type so a precise node
    // name still wins the top slots.
    const qTokens = q.split(/\s+/).filter(Boolean);
    const allTokensPrefix = (pool: string[]) => qTokens.every((t) => pool.some((w) => w.startsWith(t)));
    // Coarse match TIER (lower = better). Results sort by tier, then cluster by
    // component, then alphabetically by label — so every node of one subsystem
    // (all AI Brain, all State Machine…) stays together and reads in order
    // instead of being scattered by a per-row score.
    const scored: { item: typeof allEntries[number]; tier: number }[] = [];
    for (const it of allEntries) {
      const label = it.entry.label.toLowerCase();
      const type = it.entry.type.toLowerCase();
      const labelWords = searchWords(it.entry.label);
      const typeWords = searchWords(it.entry.type);
      const compWords = searchWords(it.chip.label);
      let tier = -1;
      if (label.startsWith(q)) tier = 0;
      else if (type.startsWith(q)) tier = 1;
      else if (allTokensPrefix(labelWords)) tier = 2;
      else if (allTokensPrefix([...labelWords, ...typeWords])) tier = 3;
      // Substring fallback only for queries ≥4 chars — long enough to be a real
      // intent ("moveto", "particle"), not a mid-word fragment ("ate" in "state")
      // that would otherwise flood unrelated subsystems.
      else if (q.length >= 4 && (label.includes(q) || type.includes(q))) tier = 4;
      else if (allTokensPrefix(compWords)) tier = 5;
      if (tier > -1) scored.push({ item: it, tier });
    }
    scored.sort((a, b) =>
      a.tier - b.tier
      || a.item.chip.label.localeCompare(b.item.chip.label)
      || a.item.entry.label.localeCompare(b.item.entry.label));
    return scored.map((s) => s.item);
  }, [query, allEntries]);

  // Clamp highlight when filter shrinks the list.
  useEffect(() => {
    if (highlightedIdx >= filtered.length) setHighlightedIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlightedIdx]);

  // Autofocus the search input as soon as the popup mounts so the
  // author can start typing immediately — matches UE5's behavior.
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Scroll the highlighted row into view ONLY for keyboard navigation — never
  // on mouse hover (see kbdNavRef).
  useEffect(() => {
    if (!kbdNavRef.current) return;
    kbdNavRef.current = false;
    const node = listRef.current?.querySelector(`[data-row-idx="${highlightedIdx}"]`);
    (node as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  }, [highlightedIdx]);

  // Popup is positioned with a viewport clamp so it never escapes the
  // window edges (matters near the right/bottom of the canvas). Sized
  // generously so the full PALETTE (180+ entries) is browsable without
  // squeezing the visible window down to a half-dozen rows.
  const POPUP_W = 360;
  const winW = typeof window !== "undefined" ? window.innerWidth : 1920;
  const winH = typeof window !== "undefined" ? window.innerHeight : 1080;
  // Cap height to the viewport (with margin) so the description pane at the
  // bottom is never pushed off the screen edge — that was why it only showed
  // when the list was filtered short.
  const POPUP_H = Math.min(600, winH - 24);
  const left = Math.min(clientX, winW - POPUP_W - 8);
  const top = Math.max(8, Math.min(clientY, winH - POPUP_H - 8));

  return (
    <div
      onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 8000 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left, top,
          width: POPUP_W, maxHeight: POPUP_H,
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          display: "flex", flexDirection: "column",
          fontSize: 11, color: "#eee",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: 6, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlightedIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
              if (e.key === "ArrowDown") { e.preventDefault(); kbdNavRef.current = true; setHighlightedIdx((i) => Math.min(filtered.length - 1, i + 1)); return; }
              if (e.key === "ArrowUp")   { e.preventDefault(); kbdNavRef.current = true; setHighlightedIdx((i) => Math.max(0, i - 1)); return; }
              if (e.key === "Enter")     { e.preventDefault(); const hit = filtered[highlightedIdx]; if (hit) onPick(hit.entry); return; }
            }}
            placeholder="Search nodes…"
            style={{
              width: "100%", padding: "5px 8px", fontSize: 12,
              background: "rgba(0,0,0,0.35)", color: "#fff",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 4, outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 16, color: "var(--text-dim)", textAlign: "center" }}>No matches</div>
          ) : (
            filtered.map((it, idx) => (
              <div
                key={`${it.entry.kind}:${it.entry.type}`}
                data-row-idx={idx}
                onMouseEnter={() => setHighlightedIdx(idx)}
                onClick={() => onPick(it.entry)}
                style={{
                  padding: "4px 8px",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8,
                  background: idx === highlightedIdx ? "rgba(255,205,60,0.15)" : "transparent",
                  borderLeft: idx === highlightedIdx ? "2px solid #ffcd3c" : "2px solid transparent",
                }}
              >
                <span
                  style={{
                    background: it.chip.bg, color: it.chip.fg,
                    fontSize: 8, fontWeight: 700,
                    padding: "1px 5px", borderRadius: 3,
                    textTransform: "uppercase", letterSpacing: 0.5,
                    minWidth: 78, textAlign: "center",
                    whiteSpace: "nowrap",
                  }}
                >{it.chip.label}</span>
                <span style={{ flex: 1 }}>{it.entry.label}</span>
                <span style={{ fontSize: 9, color: "var(--text-dim)" }}>{it.entry.kind}</span>
              </div>
            ))
          )}
        </div>
        {/* Description preview pane — pulls from ACTION_DESCRIPTIONS /
            CONDITION_DESCRIPTIONS for the currently highlighted entry. These
            descriptions exist in shared/ but were never surfaced anywhere
            authors could see them. Hidden when the highlighted entry has no
            description so the picker doesn't waste vertical space on flow/
            getter/branch entries that intentionally have no description. */}
        {(() => {
          const hit = filtered[highlightedIdx];
          if (!hit) return null;
          const desc = nodeDescription(hit.entry.type);
          if (!desc) return null;
          return (
            <div style={{
              padding: "9px 12px",
              borderTop: "2px solid rgba(255,205,60,0.4)",
              fontSize: 12, color: "#e8e8e8", lineHeight: 1.5,
              minHeight: 44, maxHeight: 140, overflowY: "auto",
              background: "rgba(255,205,60,0.08)",
              flexShrink: 0,
            }}>
              <span style={{ color: "#ffcd3c", fontWeight: 700, fontSize: 12, marginRight: 6 }}>
                {hit.entry.label}
              </span>
              {desc}
            </div>
          );
        })()}
        <div style={{
          padding: "5px 10px", borderTop: "1px solid rgba(255,255,255,0.08)",
          fontSize: 9, color: "var(--text-dim)", textAlign: "right",
          flexShrink: 0,
        }}>
          {filtered.length} of {allEntries.length} {query ? "matched" : "total"} · ↑↓ ↵ to add · Esc to close
        </div>
      </div>
    </div>
  );
}

export const PALETTE: { group: string; entries: PaletteEntry[] }[] = [
  {
    group: "Triggers",
    entries: [
      { type: "OnCreate",          kind: "trigger", label: "On Create",          defaults: {} },
      { type: "OnDestroyed",       kind: "trigger", label: "On Destroyed",       defaults: {} },
      { type: "OnSceneStart",      kind: "trigger", label: "On Scene Start",     defaults: {} },
      { type: "OnEveryNSeconds",   kind: "trigger", label: "Every N Seconds",    defaults: { interval: 1 } },
      { type: "OnCollide",         kind: "trigger", label: "On Collide (tag)",   defaults: { tag: "" } },
      { type: "OnOverlap",         kind: "trigger", label: "On Overlap (tag)",   defaults: { tag: "" } },
      { type: "OnSeparate",        kind: "trigger", label: "On End Overlap (tag)", defaults: { tag: "" } },
      { type: "OnOverlapForSeconds", kind: "trigger", label: "On Overlap For (s)", defaults: { tag: "", seconds: 1 } },
      { type: "OnSignal",          kind: "trigger", label: "On Signal",          defaults: { signal: "" } },
      { type: "OnKeyPressed",      kind: "trigger", label: "On Key Pressed",     defaults: { action: "" } },
      { type: "OnKeyHeld",         kind: "trigger", label: "On Key Held",        defaults: { action: "" } },
      { type: "OnKeyHeldFor",      kind: "trigger", label: "On Key Held For (s)", defaults: { action: "", seconds: 1 } },
      { type: "OnKeyReleased",     kind: "trigger", label: "On Key Released",    defaults: { action: "" } },
      { type: "OnDoubleKeyPressed",kind: "trigger", label: "On Double Key Pressed", defaults: { action: "", windowSec: 0.3 } },
      { type: "InputCombo",        kind: "trigger", label: "Input Combo (multi-key)", defaults: { comboKeys: [] } },
      { type: "OnDamageTaken",     kind: "trigger", label: "On Damage Taken",    defaults: {} },
      { type: "OnHealed",          kind: "trigger", label: "On Healed",          defaults: {} },
      { type: "OnBlocked",         kind: "trigger", label: "On Blocked",         defaults: {} },
      { type: "OnPartialBlock",    kind: "trigger", label: "On Partial Block",   defaults: {} },
      { type: "OnDeath",           kind: "trigger", label: "On Death",           defaults: {} },
      { type: "OnItemAdded",       kind: "trigger", label: "On Item Added",      defaults: {} },
      { type: "OnItemRemoved",     kind: "trigger", label: "On Item Removed",    defaults: {} },
      { type: "OnInventoryFull",   kind: "trigger", label: "On Inventory Full",  defaults: {} },
      { type: "OnTracerHit",       kind: "trigger", label: "On Tracer Hit",      defaults: { tracer: "" } },
      { type: "OnTracerLost",      kind: "trigger", label: "On Tracer Lost",     defaults: { tracer: "" } },
      { type: "OnTracedBy",        kind: "trigger", label: "On Traced By",       defaults: { tracer: "" } },
      { type: "OnUntracedBy",      kind: "trigger", label: "On Untraced By",     defaults: { tracer: "", forSeconds: 1 } },
      { type: "OnComboStep",       kind: "trigger", label: "On Combo Step",      defaults: { state: "", steps: [], separate: false } },
      { type: "OnStateEnter",      kind: "trigger", label: "On State Enter",     defaults: { state: "" } },
      { type: "OnStateMain",       kind: "trigger", label: "On State Main",      defaults: { state: "" } },
      { type: "OnStateExit",       kind: "trigger", label: "On State Exit",      defaults: { state: "" } },
      { type: "OnAnimationEnd",    kind: "trigger", label: "On Animation End",   defaults: { anim: "" } },
      { type: "OnAnyAnimationEnd", kind: "trigger", label: "On Any Animation End", defaults: {} },
      { type: "OnSceneEnd",        kind: "trigger", label: "On Scene End",       defaults: {} },
      { type: "OnSaveLoadComplete",kind: "trigger", label: "On Save/Load Complete", defaults: {} },
      { type: "OnLoadStart",       kind: "trigger", label: "On Load Start",      defaults: {} },
      { type: "OnLoadProgress",    kind: "trigger", label: "On Load Progress",   defaults: {} },
      { type: "OnLoadComplete",    kind: "trigger", label: "On Load Complete",   defaults: {} },
      { type: "OnCameraPanEnd",    kind: "trigger", label: "On Camera Pan End",  defaults: {} },
      { type: "OnTweenStart",      kind: "trigger", label: "On Tween Start",     defaults: { tweenTag: "" } },
      { type: "OnTweenFinish",     kind: "trigger", label: "On Tween Finish",    defaults: { tweenTag: "" } },
      { type: "OnMouseButtonPressed",  kind: "trigger", label: "On Mouse Button Pressed", defaults: { button: 0 } },
      { type: "OnMouseButtonReleased", kind: "trigger", label: "On Mouse Button Released", defaults: { button: 0 } },
      { type: "OnMouseClick",      kind: "trigger", label: "On Mouse Click",     defaults: { button: 0 } },
      { type: "OnMouseDoubleClick",kind: "trigger", label: "On Mouse Double-Click", defaults: { button: 0 } },
      { type: "OnMouseWheel",      kind: "trigger", label: "On Mouse Wheel",     defaults: {} },
      { type: "OnObjectClicked",   kind: "trigger", label: "On Object Clicked",  defaults: { tag: "" } },
      { type: "OnObjectDoubleClicked", kind: "trigger", label: "On Object Double-Clicked", defaults: { tag: "" } },
      { type: "OnObjectHovered",   kind: "trigger", label: "On Object Hovered",  defaults: { tag: "" } },
      { type: "OnObjectUnhovered", kind: "trigger", label: "On Object Unhovered", defaults: { tag: "" } },
      { type: "IsCursorOverObject", kind: "condition", label: "Is Cursor Over Object", defaults: { tags: [] } },
      { type: "OnJump",            kind: "trigger", label: "On Jump",            defaults: {} },
      { type: "OnLand",            kind: "trigger", label: "On Land",            defaults: {} },
      { type: "OnFall",            kind: "trigger", label: "On Fall",            defaults: {} },
      { type: "OnDashStart",       kind: "trigger", label: "On Dash Start",      defaults: {} },
      { type: "OnDashEnd",         kind: "trigger", label: "On Dash End",        defaults: {} },
      { type: "OnMoved",           kind: "trigger", label: "On Moved",           defaults: {} },
      { type: "OnStopped",         kind: "trigger", label: "On Stopped",         defaults: {} },
      { type: "OnArrived",         kind: "trigger", label: "On Arrived (Move To)", defaults: {} },
      { type: "OnNavFailed",       kind: "trigger", label: "On Nav Failed",       defaults: {} },
      { type: "OnPointArrived",    kind: "trigger", label: "On Point Arrived",     defaults: { point: "" } },
      { type: "OnAnyPointArrived", kind: "trigger", label: "On Any Point Arrived", defaults: {} },
      { type: "OnTopdownDirectionChanged", kind: "trigger", label: "On Topdown Direction Changed", defaults: {} },
      { type: "OnSquashStretchEnd",kind: "trigger", label: "On S/S End",         defaults: {} },
      { type: "OnParticleBurstEnd",kind: "trigger", label: "On Burst End",       defaults: { target: "" } },
      { type: "OnTileDestroyed",   kind: "trigger", label: "On Tile Destroyed",  defaults: {} },
      { type: "OnTileDamaged",     kind: "trigger", label: "On Tile Damaged",    defaults: {} },
      { type: "OnTileDrop",        kind: "trigger", label: "On Tile Drop",       defaults: {} },
      { type: "OnAnimatorAnimEnd", kind: "trigger", label: "On Smart Tween End", defaults: { anim: "" } },
      { type: "OnTick",            kind: "trigger", label: "On Tick (every frame)", defaults: {} },
      { type: "OnDialogueStart",   kind: "trigger", label: "On Dialogue Start",  defaults: { asset: "" } },
      { type: "OnDialogueLine",    kind: "trigger", label: "On Dialogue Line",   defaults: { keywords: [], matchAny: true, caseSensitive: false, separate: false } },
      { type: "OnDialogueEnd",     kind: "trigger", label: "On Dialogue End",    defaults: { asset: "" } },
      { type: "OnAIStateEnter",    kind: "trigger", label: "On AI State Enter",  defaults: { state: "" } },
      { type: "OnAIStateExit",     kind: "trigger", label: "On AI State Exit",   defaults: { state: "" } },
      { type: "OnTargetSighted",   kind: "trigger", label: "On Target Sighted",  defaults: {} },
      { type: "OnTargetLost",      kind: "trigger", label: "On Target Lost",     defaults: {} },
    ],
  },
  {
    group: "Actions",
    entries: [
      { type: "ApplyDamage",   kind: "action", label: "Apply Damage",    defaults: { amount: 10 } },
      { type: "Heal",          kind: "action", label: "Heal",            defaults: { amount: 10 } },
      { type: "EmitSignal",    kind: "action", label: "Emit Signal",     defaults: { signal: "" } },
      { type: "EmitSignalTo",  kind: "action", label: "Emit Signal To",  defaults: { signal: "", tag: "", uid: 0 } },
      { type: "SetVar",        kind: "action", label: "Set Var",         defaults: { var: "", value: 0 } },
      { type: "IncrementVar",  kind: "action", label: "Increment Var",   defaults: { var: "", delta: 1 } },
      { type: "ToggleVar",     kind: "action", label: "Toggle Var",      defaults: { var: "" } },
      { type: "PlayAnimation", kind: "action", label: "Play Animation",  defaults: { name: "" } },
      { type: "CreateObject",  kind: "action", label: "Create Object",   defaults: { bp: "", x: 0, y: 0, layer: "" } },
      { type: "DropObject",    kind: "action", label: "Drop",            defaults: { bp: "", x: 0, y: 0, layer: "", instanceName: "", tag: "", mode: "animation", animation: "", frame: 0 } },
      { type: "Destroy",       kind: "action", label: "Destroy Self",    defaults: { persist: false } },
      { type: "MoveToSetPosition", kind: "action", label: "MoveTo → Position", defaults: { x: 0, y: 0, speed: 0 } },
      { type: "MoveToSetObject",   kind: "action", label: "MoveTo → Object (uid)", defaults: { uid: 0, speed: 0 } },
      { type: "MoveToSetTag",      kind: "action", label: "MoveTo → Tag",      defaults: { tag: "", speed: 0 } },
      { type: "MoveToSetAngle",    kind: "action", label: "MoveTo → Angle",    defaults: { angleDeg: 0, speed: 0 } },
      { type: "MoveToStop",        kind: "action", label: "MoveTo Stop",       defaults: {} },
      { type: "MoveToResume",      kind: "action", label: "MoveTo Resume",     defaults: {} },
      { type: "MoveToSetSpeed",    kind: "action", label: "MoveTo Set Speed",  defaults: { speed: 100 } },
      { type: "IsMovingTo",        kind: "condition", label: "Is MoveTo Active", defaults: {} },
      { type: "HasArrived",        kind: "condition", label: "MoveTo Has Arrived", defaults: {} },
      { type: "Wait",              kind: "action", label: "Wait (s)",            defaults: { seconds: 0.5 } },
      { type: "DebounceWait",      kind: "action", label: "Debounce Wait (tag, s)", defaults: { tag: "default", seconds: 1 } },
      { type: "WaitForAnim",       kind: "action", label: "Wait For Animation",  defaults: { anim: "" } },
      { type: "WaitForKeyPress",   kind: "action", label: "Wait For Key Press (gate)", defaults: { action: "", withinSec: 1 } },
      { type: "WaitForSignal",     kind: "action", label: "Wait For Signal",     defaults: { signal: "" } },
      { type: "Repeat",            kind: "action", label: "Repeat N times",      defaults: { times: 3 } },
      { type: "ForEach",           kind: "action", label: "For Each (tag)",      defaults: { tag: "" } },
      { type: "While",             kind: "action", label: "While (bool)",        defaults: { maxIter: 1000 } },
      { type: "PrintString",       kind: "action", label: "Print (debug)",       defaults: { message: "hello", duration: 2, color: "#00ff88" } },
      { type: "PlayDialogue",      kind: "action", label: "Play Dialogue",       defaults: { dialogueId: "" } },
      { type: "StopDialogue",      kind: "action", label: "Stop Dialogue",       defaults: {} },
      { type: "SetAIState",        kind: "action", label: "Set AI State",        defaults: { state: "idle" } },
      { type: "SetAITarget",       kind: "action", label: "Set AI Target (uid)", defaults: { uid: -1 } },
      { type: "AlertNearbyAllies", kind: "action", label: "Alert Nearby Allies", defaults: { tag: "enemy", radius: 200 } },
      { type: "SetBehaviorParam",  kind: "action", label: "Set Component Param", defaults: { behavior: "CharacterMovement", componentName: "", params: [{ param: "maxSpeed", value: 200 }] } },
      { type: "SetBehaviorEnabled",kind: "action", label: "Enable/Disable Comp", defaults: { behavior: "CharacterMovement", enabled: true } },
      { type: "TweenVar",          kind: "action", label: "Tween Variable (smooth)", defaults: { varName: "", fromVal: 0, toVal: 5, duration: 1, ease: "Linear", tweenTag: "", repeat: 0, yoyo: 0 } },
      { type: "TweenParam",        kind: "action", label: "Tween Component Param (smooth)", defaults: { behavior: "LightSource", param: "radius", componentName: "", fromVal: 0, toVal: 200, duration: 1, ease: "Linear", tweenTag: "", repeat: 0, yoyo: 0 } },
      { type: "SetVisible",        kind: "action", label: "Set Visible (whole BP)", defaults: { mode: "set", visible: 1 } },
      { type: "GoToLayoutWithLoad",kind: "action", label: "Go To Layout (with loading)", defaults: { name: "", minDisplaySec: 0 } },
      { type: "SetLoadingProgress",kind: "action", label: "Set Loading Progress (0..1)", defaults: { pct: 0 } },
      { type: "SetLoadingScene",   kind: "action", label: "Set Loading Scene (one-shot override)", defaults: { name: "" } },
      { type: "SetPlacementVisible",kind: "action",label: "Set Sprite Object Visible",   defaults: { spriteId: "", visible: true } },
      { type: "SetPlacementFrame", kind: "action", label: "Set Sprite Object Frame",     defaults: { spriteId: "", frame: 0 } },
      { type: "PlayPlacementAnim", kind: "action", label: "Play Sprite Object Animation",defaults: { spriteId: "", animation: "", loop: true, startFrame: 0, destroyOnFinish: false } },
      { type: "StopPlacementAnim", kind: "action", label: "Stop Sprite Object Animation",defaults: { spriteId: "" } },
      { type: "SetPlacementPos",   kind: "action", label: "Set Sprite Object Position",  defaults: { spriteId: "", x: 0, y: 0 } },
      { type: "CreateSpriteObject",kind: "action", label: "Create Sprite Object",        defaults: { spriteId: "", x: 0, y: 0, layer: "" } },
      { type: "DestroySpriteObject",kind: "action",label: "Destroy Sprite Object",       defaults: { spriteId: "" } },
      { type: "SetPlacementScale", kind: "action", label: "Set Sprite Object Scale",     defaults: { spriteId: "", scaleX: 1, scaleY: 1 } },
      { type: "SetPlacementRotation",kind:"action",label: "Set Sprite Object Rotation",  defaults: { spriteId: "", rotation: 0 } },
      { type: "SetPlacementAlpha", kind: "action", label: "Set Sprite Object Alpha",     defaults: { spriteId: "", alpha: 1 } },
      { type: "SetSpriteObjectColliderEnabled", kind: "action", label: "Set Sprite Object Has Collider", defaults: { spriteId: "", enabled: true } },
      { type: "SetSpriteObjectSolid",        kind: "action", label: "Set Sprite Object Solid",        defaults: { spriteId: "", solid: true } },
      { type: "SetSpriteObjectCollideMode",  kind: "action", label: "Set Sprite Object Collider Mode", defaults: { spriteId: "", mode: "include" } },
      { type: "AddSpriteObjectTag",          kind: "action", label: "Add Sprite Object Tag",          defaults: { spriteId: "", tag: "" } },
      { type: "RemoveSpriteObjectTag",       kind: "action", label: "Remove Sprite Object Tag",       defaults: { spriteId: "", tag: "" } },
      { type: "ClearSpriteObjectTags",       kind: "action", label: "Clear Sprite Object Tags",       defaults: { spriteId: "" } },
      { type: "AddSpriteObjectCollideTag",   kind: "action", label: "Add Sprite Object Collider Tag",   defaults: { spriteId: "", tag: "" } },
      { type: "RemoveSpriteObjectCollideTag",kind: "action", label: "Remove Sprite Object Collider Tag",defaults: { spriteId: "", tag: "" } },
      { type: "ClearSpriteObjectCollideTags",kind: "action", label: "Clear Sprite Object Collider Tags",defaults: { spriteId: "" } },
      { type: "HasSpriteObjectTag",          kind: "condition", label: "Sprite Object Has Tag",       defaults: { spriteId: "", tag: "" } },
      { type: "SetRecipeEnabled",    kind: "action", label: "Set Recipe Enabled",        defaults: { recipe: "", enabled: true } },
      { type: "AddRecipeIngredient", kind: "action", label: "Add Recipe Ingredient",     defaults: { recipe: "", item: "", qty: 1 } },
      { type: "RemoveRecipeIngredient",kind:"action",label: "Remove Recipe Ingredient",  defaults: { recipe: "", item: "" } },
      { type: "SetRecipeOutput",     kind: "action", label: "Set Recipe Output",         defaults: { recipe: "", item: "", qty: 1 } },
      { type: "SetInstanceName",   kind: "action", label: "Set Instance Name",   defaults: { name: "" } },
      { type: "EditTags",          kind: "action", label: "Edit Tags",           defaults: { bp: "", mode: "insert", tag: "", oldTag: "" } },
      { type: "DebugPrint",        kind: "action", label: "Debug Print (inline)", defaults: { rows: [{ message: "", color: "#ff5555", duration: 2 }] } },
    ],
  },
  {
    group: "Conditions",
    entries: [
      { type: "VarEquals",          kind: "condition", label: "Var ==",            defaults: { var: "", value: 0 } },
      { type: "VarAbove",           kind: "condition", label: "Var >",             defaults: { var: "", value: 0 } },
      { type: "VarBelow",           kind: "condition", label: "Var <",             defaults: { var: "", value: 0 } },
      { type: "VarTrue",            kind: "condition", label: "Var is true",       defaults: { var: "" } },
      { type: "VarFalse",           kind: "condition", label: "Var is false",      defaults: { var: "" } },
      { type: "IsOverlappingTag",   kind: "condition", label: "Overlapping tag",   defaults: { tag: "" } },
      { type: "HasTag",             kind: "condition", label: "Has Tag",            defaults: { tag: "" } },
      { type: "HasAnyTag",          kind: "condition", label: "Has Any Tag (OR)",   defaults: { tags: [] } },
      { type: "HasAllTags",         kind: "condition", label: "Has All Tags (AND)", defaults: { tags: [] } },
      { type: "IsLoading",          kind: "condition", label: "Is Loading",         defaults: {} },
      { type: "IsScene",            kind: "condition", label: "Is Scene ==",        defaults: { scene: "" } },
      // Sprite-object collide/overlap are RETIRED from the palette — a collidable
      // Sprite Object now fires the unified `On Collide`/`On Overlap [tag]` nodes
      // (see firePlacementContact). Tag the placement and use those instead. The
      // runtime + ConditionKind are kept so older saves still load.
      { type: "OnSpriteObjectCreate",      kind: "trigger", label: "On Sprite Object Create",       defaults: { spriteId: "" } },
      { type: "OnSpriteObjectDestroy",     kind: "trigger", label: "On Sprite Object Destroy",      defaults: { spriteId: "" } },
      { type: "IsAnimationPlaying", kind: "condition", label: "Animation playing", defaults: { anim: "" } },
      { type: "IsState",            kind: "condition", label: "State Machine state ==", defaults: { state: "" } },
      { type: "IsGrounded",         kind: "condition", label: "Is grounded",       defaults: {} },
      { type: "IsByWall",           kind: "condition", label: "By wall",           defaults: {} },
      { type: "IsDialoguePlaying",  kind: "condition", label: "Dialogue playing",  defaults: {} },
      { type: "IsAIState",                kind: "condition", label: "AI state ==",          defaults: { action: "idle" } },
      { type: "IsTargetSighted",          kind: "condition", label: "Target is sighted",    defaults: {} },
      { type: "DistanceToTargetBelow",    kind: "condition", label: "Distance to target <", defaults: { value: 100 } },
    ],
  },
  {
    group: "Utility",
    entries: [
      { type: "Branch",     kind: "branch",    label: "Branch (if/else)",   defaults: {} },
      { type: "Switch",     kind: "branch",    label: "Switch (on value)",  defaults: { cases: [] } },
      { type: "DoOnce",     kind: "branch",    label: "Do Once",            defaults: {} },
      { type: "FlipFlop",   kind: "branch",    label: "Flip-Flop (A/B)",    defaults: {} },
      { type: "Sequence",   kind: "branch",    label: "Sequence (in order)", defaults: { count: 3 } },
      { type: "Random",     kind: "branch",    label: "Random Out",          defaults: { count: 3 } },
      { type: "Combinator", kind: "condition", label: "OR (merge exec)", defaults: { pinCount: 2 } },
      { type: "Literal",    kind: "literal",   label: "Number value",        defaults: { value: 0 } },
      { type: "StringValue",kind: "literal",   label: "String value",        defaults: { value: "" } },
      { type: "VarRead",    kind: "varRead",   label: "Read variable",       defaults: { var: "" } },
      { type: "RandomPick",  kind: "getter",    label: "Random",              defaults: { strings: [], numbers: [], sync: false } },
      { type: "RandomRange", kind: "getter",    label: "Random Range",        defaults: { min: 0, max: 10, float: false } },
      { type: "GetTracerField", kind: "getter", label: "Get Tracer Field",   defaults: { tracer: "", field: "hitX" } },
      { type: "GetLastTile", kind: "getter",   label: "Get Last Tile",       defaults: { field: "tag" } },
      { type: "GetLastDrop", kind: "getter",   label: "Get Last Drop",       defaults: { field: "bp" } },
      { type: "GetTaggedTile", kind: "getter", label: "Get Tagged Tile",     defaults: { tag: "", pick: "nearest" } },
      { type: "GetNavPoint",   kind: "getter", label: "Get Nav Point",       defaults: { point: "", pick: "nearest" } },
      { type: "GetLastNavPoint", kind: "getter", label: "Get Last Nav Point", defaults: { field: "name" } },
      { type: "GetSlotItem", kind: "getter",   label: "Get Slot Item",       defaults: { slot: 0 } },
      { type: "GetListValue", kind: "getter",  label: "Get List Item",       defaults: { list: "", key: "", field: "value" } },
      { type: "GetGlobalValue", kind: "getter", label: "Get Global Value",   defaults: { global: "", field: "value", index: 0 } },
      { type: "GetOtherObject", kind: "getter", label: "Get Collided Object", defaults: {} },
      { type: "GetOverlappingObject", kind: "getter", label: "Get Overlapping Object", defaults: { tag: "" } },
      { type: "GetHoveredObject", kind: "getter", label: "Get Hovered Object", defaults: { tag: "", bp: 1, spriteObjects: 0, tiles: 0, widgets: 0 } },
      { type: "GetDistance", kind: "getter", label: "Get Distance", defaults: { distFrom: "self", instanceFrom: "", distTo: "picked", tag: "", bp: "", instance: "", x: 0, y: 0 } },
      { type: "GetPicked", kind: "getter", label: "Get Picked", defaults: { bp: "", field: "x" } },
      { type: "GetTags",     kind: "getter",   label: "Get Tags (CSV)",      defaults: {} },
      { type: "CountByTag",  kind: "getter",   label: "Count By Tag",        defaults: { tag: "" } },
      { type: "GetSceneName",kind: "getter",   label: "Get Scene Name",      defaults: {} },
      { type: "And",        kind: "getter",    label: "AND (a & b)",         defaults: {} },
      { type: "Or",         kind: "getter",    label: "OR (a | b)",          defaults: {} },
      { type: "Not",        kind: "getter",    label: "NOT (a)",             defaults: {} },
      { type: "Comment",    kind: "comment",   label: "Comment",             defaults: { text: "Add notes here…" } },
    ],
  },
  // Auto-generated per-component groups for every engine StateActionKind
  // that isn't already curated above. The component grouping matches the
  // EventsSection legacy categorizer so authors who know "CMSetGravity is
  // on CharacterMovement" find it in the same place. Each group keeps the
  // node's component-color when rendered.
  ...buildAutoActionGroups(),
];

function buildAutoActionGroups(): { group: string; entries: PaletteEntry[] }[] {
  // Preserve a stable order matching how authors think about subsystems —
  // gameplay/transform/visual first, then tween/audio, then meta.
  const order = [
    "CharacterMovement", "Transform", "SpriteRenderer", "Damageable", "Tracer",
    "Camera", "Particles", "Text", "Tween", "Dialogue", "Audio", "SquashStretch",
    "UI", "Mouse", "Behavior", "Scene", "Spawning", "SaveLoad", "System", "Time", "Debug",
    "Variables", "Signals", "Flow",
  ];
  const byComp = new Map<string, PaletteEntry[]>();
  // Merge actions + conditions by component so each section reads "all
  // CharacterMovement nodes" or "all Camera nodes" together — keeps the
  // mental model unified instead of forcing the author to scan two
  // panels for the same subsystem.
  for (const entry of genericActionEntries()) {
    const arr = byComp.get(entry.component) ?? [];
    arr.push({ type: entry.type, kind: entry.kind, label: entry.label, defaults: entry.defaults });
    byComp.set(entry.component, arr);
  }
  for (const entry of genericConditionEntries()) {
    const arr = byComp.get(entry.component) ?? [];
    arr.push({ type: entry.type, kind: entry.kind, label: entry.label, defaults: entry.defaults });
    byComp.set(entry.component, arr);
  }
  const out: { group: string; entries: PaletteEntry[] }[] = [];
  for (const comp of order) {
    const entries = byComp.get(comp);
    if (!entries || entries.length === 0) continue;
    // Group label uses the friendly name from COMPONENT_THEME so the
    // palette section matches what shows on the node chip at a glance.
    out.push({ group: COMPONENT_THEME[comp]?.label ?? comp, entries });
    byComp.delete(comp);
  }
  // Spill anything we didn't have an ordering for under "Other".
  for (const [comp, entries] of byComp) {
    out.push({ group: COMPONENT_THEME[comp]?.label ?? comp, entries });
  }
  return out;
}

export function inferPinType(conn: Connection, folder: LogicFolder, varTypes?: Map<string, "number" | "string" | "boolean">): LogicGraphEdge["pinType"] {
  // Look up the source node and figure out the pin's declared type.
  const src = folder.graph.nodes.find((n) => n.id === conn.source);
  if (!src) return "number";
  if (src.kind === "condition") return "boolean";
  // A Read-Variable pin is typed by what the variable holds — a string var
  // outputs a string pin, a bool var a boolean. Falls back to number when the
  // var can't be resolved (deleted / cross-scene).
  if (src.kind === "varRead") return varTypes?.get(String(src.params.var ?? "")) ?? "number";
  if (src.kind === "getter") {
    // For GetTracerField, actorName returns a string; everything else
    // is numeric. Other future getter types can extend this switch.
    if (src.type === "GetOtherObject" || src.type === "GetOverlappingObject" || src.type === "GetHoveredObject") {
      return (conn.sourceHandle === "name" || conn.sourceHandle === "tag" || conn.sourceHandle === "instanceTag" || conn.sourceHandle === "kind") ? "string" : "number";
    }
    if (src.type === "GetSlotItem") return "string";
    if (src.type === "GetTracerField") {
      const f = String(src.params.field ?? "");
      if (f === "actorName" || f === "actorTags") return "string";
    }
    return "number";
  }
  if (src.kind === "literal") {
    const v = src.params.value;
    if (typeof v === "string") return "string";
    if (typeof v === "boolean") return "boolean";
    return "number";
  }
  return "number";
}
