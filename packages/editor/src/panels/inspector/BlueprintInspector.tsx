import { Fragment, useEffect, useState } from "react";
import { useEditor, findVarUsages } from "../../store";
import { BehaviorInstance, BlueprintDef, InputActionDef, SpriteAsset, collectEmittedSignalNames } from "../../project";
import { BEHAVIOR_PARAMS } from "../../behaviorMeta";
import { NumberField } from "../NumberField";
import { VariableDetailEditor, defaultColorForType } from "./VariableDetailEditor";
import { ColorField, isColorParamKey } from "../../components/ColorField";
import { FontFamilyInput } from "../../components/FontFamilyInput";
import { ComponentIcon } from "../../componentIcons";
import { Toggle } from "../../components/Toggle";
import { SignalPicker } from "../../components/SignalPicker";

/** Identity (Name + Tags) — small block at the top of the middle column. */
export function BlueprintIdentitySection({ bp }: { bp: BlueprintDef }) {
  const update = useEditor((s) => s.updateBlueprint);
  return (
    <div className="section">
      <div className="title">{bp.name || "Blueprint"}</div>
      <div className="field">
        <label>Name</label>
        <input value={bp.name} onChange={(e) => update(bp.id, { name: e.target.value })} />
      </div>
      {/* Plain flex column — NOT .field (which is a 2-col grid that
       *  forces TagChips into the narrow value column and clips wrapped
       *  chips). Chips here stretch to the full inspector width. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 12px" }}>
        <label style={{ color: "var(--text-dim)", fontSize: 11 }}>Tags</label>
        <TagChips
          tags={bp.tags}
          onChange={(next) => update(bp.id, { tags: next })}
          placeholder="player, enemy…"
        />
      </div>
      <div className="field">
        <label>Instance Editable Tags</label>
        <Toggle
          value={!!bp.tagsInstanceEditable}
          onChange={(v) => update(bp.id, { tagsInstanceEditable: v })}
          title="When on, placed instances of this BP can override the tag list per-instance in the scene editor. Useful for one NPC BP serving multiple variants (boss / mini-boss / shopkeeper). When off, instances inherit the BP tags read-only."
        />
      </div>
      <div className="field">
        <label>Width</label>
        <input type="number" value={bp.w} onChange={(e) => update(bp.id, { w: +e.target.value })} />
      </div>
      <div className="field">
        <label>Height</label>
        <input type="number" value={bp.h} onChange={(e) => update(bp.id, { h: +e.target.value })} />
      </div>
      <div className="field">
        <label>Color</label>
        <input
          type="color"
          value={`#${bp.color.toString(16).padStart(6, "0")}`}
          onChange={(e) => update(bp.id, { color: parseInt(e.target.value.slice(1), 16) })}
        />
      </div>
      <div className="field">
        <label>Hide Rectangle</label>
        <Toggle
          value={!!bp.hideRect}
          onChange={(v) => update(bp.id, { hideRect: v })}
          title="Suppress the BP's default colored rectangle in both the scene editor and at runtime. Useful for Text-only or pure-logic blueprints."
        />
      </div>
      <div className="field">
        <label>Affected by Gravity</label>
        <Toggle
          value={bp.affectedByGravity !== false}
          onChange={(v) => update(bp.id, { affectedByGravity: v })}
          title="Whether the spawned instance falls under the scene's gravity. Uncheck for Camera / UI / trigger BPs that should stay where placed."
        />
      </div>
      <div className="field">
        <label>No Physics Body</label>
        <Toggle
          value={!!bp.noPhysicsBody}
          onChange={(v) => update(bp.id, { noPhysicsBody: v })}
          title="Skip Phaser physics body creation for instances of this BP. Cuts ~0.3ms per spawn — useful when placing many decoration / background sprites. Behaviors that need a body (CharacterMovement, MoveTo with physics, Solid, JumpThru, Damageable knockback) won't work on no-body BPs. Default off."
        />
      </div>
      <div className="field" title="Viewport-culling behavior for instances of this BP when they go off-screen. Never = always full update (story NPCs, bosses — default). Throttled = off-screen NPCs tick at 10Hz instead of 60Hz (villagers, patrol guards — still walking, cheaper). Freeze = off-screen NPCs SKIP UPDATES entirely (swarm enemies — biggest perf win, NPC literally freezes until camera comes back).">
        <label>Culling</label>
        <select
          value={bp.cullMode ?? "never"}
          onChange={(e) => update(bp.id, { cullMode: e.target.value as "never" | "throttled" | "freeze" })}
        >
          <option value="never">Never (always full update)</option>
          <option value="throttled">Throttled (off-screen — living world)</option>
          <option value="freeze">Freeze (skip off-screen — swarms)</option>
        </select>
      </div>
      {bp.cullMode === "throttled" && (
        <div className="field" title="Off-screen tick rate when Culling is Throttled. Higher = smoother movement when an NPC walks back on-screen, but a smaller CPU win off-screen. Lower = bigger win, choppier wake-up. Only applies off-screen; on-screen always runs full rate.">
          <label>Off-screen Rate</label>
          <select
            value={String(bp.cullThrottleHz ?? 10)}
            onChange={(e) => update(bp.id, { cullThrottleHz: Number(e.target.value) })}
          >
            <option value="10">10 Hz (biggest win — default)</option>
            <option value="20">20 Hz</option>
            <option value="30">30 Hz (smoothest wake-up)</option>
          </select>
        </div>
      )}
      <div className="field" title="How often instances of this BP RE-DECIDE — re-evaluating their State Machine and Logic Sheet (OnTick + conditions). Movement, animation playback and overlay sync ALWAYS run every frame, so motion stays smooth — only the thinking is throttled. Use for big background swarms (grazing animals, ambient crowds) where reacting a few times a second is plenty. Reaction latency ≈ the rate. NOT for combat actors that rely on frame-signals / frame-motions / per-frame triggers — keep those at 60Hz. Default 60Hz = decide every frame.">
        <label>Decision Rate</label>
        <select
          value={String(bp.decisionTickRate ?? 1)}
          onChange={(e) => update(bp.id, { decisionTickRate: Number(e.target.value) })}
        >
          <option value="1">60 Hz (every frame — default)</option>
          <option value="2">30 Hz (decide every 2nd frame)</option>
          <option value="3">20 Hz (decide every 3rd frame)</option>
          <option value="6">10 Hz (background swarms)</option>
        </select>
      </div>
      <div className="field" title="Skip CollisionScan's broad-phase pair detection for this BP's instances. HUGE perf win when many NPCs cluster (1500 NPCs in one spot ≈ 1M pair checks per frame normally; with this on, zero). By DEFAULT this disables OnCollide / OnOverlap events on these sprites. Use the 'Detect tags' field below to whitelist specific tags (e.g. 'player') whose pairs should STILL be scanned — typical swarm setup is Skip ON + Detect = 'player', which gives perf for swarm-vs-swarm while keeping swarm-vs-player events alive.">
        <label>Skip Collision Scan</label>
        <Toggle
          value={!!bp.skipCollisionScan}
          onChange={(v) => update(bp.id, { skipCollisionScan: v })}
        />
      </div>
      {bp.skipCollisionScan && (
        <div className="field" title="When Skip Collision Scan is on, pairs with sprites carrying ANY of these tags STILL get detected. Comma- or space-separated. Empty = pure skip (no pairs detected at all). Typical: 'player' so swarm enemies can still fire OnCollide(player) → Destroy / DealDamage / etc.">
          <label>Detect tags (except)</label>
          <input
            type="text"
            value={bp.collisionScanExceptTags ?? ""}
            onChange={(e) => update(bp.id, { collisionScanExceptTags: e.target.value })}
            placeholder="e.g. player, projectile"
            style={{ flex: 1 }}
          />
        </div>
      )}
      <div className="field" title="Distance-gated (proximity) collision wiring. When > 0, this BP's instances SKIP per-pair collider wiring at spawn (the O(N²) cost that freezes scene-start at scale). Each instance periodically checks if a sprite carrying 'Collision Wake Tag' is within this many pixels — when close, colliders are wired (one-shot, never unwired). 0 = wire immediately at spawn (default). Use for non-swarm BPs that need real Phaser collisions but spawn in large batches (200 crates, boss summoning 100 minions). Stale-collision risk for instances that never approach the wake target = none.">
        <label>Collision Wake Radius (px)</label>
        <input
          type="number"
          min={0}
          value={bp.collisionWakeRadius ?? 0}
          onChange={(e) => update(bp.id, { collisionWakeRadius: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      {(bp.collisionWakeRadius ?? 0) > 0 && (
        <div className="field" title="Tag whose nearest carrier triggers the collision wake check. Default 'player'.">
          <label>Collision Wake Tag</label>
          <input
            type="text"
            value={bp.collisionWakeTag ?? "player"}
            onChange={(e) => update(bp.id, { collisionWakeTag: e.target.value })}
            placeholder="player"
            style={{ flex: 1 }}
          />
        </div>
      )}
      <div className="field" title="Object pool size. At scene start, pre-spawn this many instances and deactivate them into a pool. CreateObject for this BP pops from the pool (~0.05ms) instead of allocating a fresh sprite (~1.5ms × behavior count). Destroy returns to the pool instead of tearing down. The Vampire Survivors pattern. 0 = no pool (default). Set ≈ peak simultaneous live count × 1.5 buffer. Pool fill at scene load is `poolSize × ~1.5ms` paid once — hide behind a loading screen. If pool exhausts mid-game, falls back to fresh allocation with a warning.">
        <label>Pool Size</label>
        <input
          type="number"
          min={0}
          value={bp.poolSize ?? 0}
          onChange={(e) => update(bp.id, { poolSize: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <div className="field" title="Vertical sort pivot (0..1) for Y-sort layers. 0=top, 0.5=center, 1=bottom (feet). Trees should use ~1 so the trunk base is the sort point — player walks behind tree above its base, in front below.">
        <label>Y-sort Pivot</label>
        <input
          type="number" step={0.05} min={0} max={1}
          value={bp.ySortPivotY ?? 1}
          onChange={(e) => update(bp.id, { ySortPivotY: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
        />
      </div>
      <div className="field" title="Mirror the Y-sort pivot with vertical movement: moving UP uses the pivot as set (e.g. 0.8), moving DOWN uses 1 − pivot (0.2). Direction latches while standing still. For characters whose depth reference shifts between up- and down-facing sprites.">
        <label>Pivot ↕ Mirror</label>
        <Toggle value={!!bp.ySortFlipByDir} onChange={(v) => update(bp.id, { ySortFlipByDir: v || undefined })} />
      </div>
      <div className="field" title="When on, this BP ignores the layer's Y-sort — it keeps a fixed depth instead of interleaving by Y. For decals / FX like blood splats that shouldn't flicker in front of and behind characters. Use the instance Z-order to place it above (high Z) or below (negative Z) the Y-sorted sprites.">
        <label>Exclude Y-sort</label>
        <Toggle value={!!bp.ySortExclude} onChange={(v) => update(bp.id, { ySortExclude: v || undefined })} />
      </div>
    </div>
  );
}

/**
 * Active-component card (Physics/Movement/Jump/Dash/Wall for CharacterMovement,
 * etc.). Driven by the chip selection in the left rail's Components panel —
 * `selectedIdx` is the parent-owned selection.
 */
export function BlueprintComponentDetail({ bp, selectedIdx }: { bp: BlueprintDef; selectedIdx: number | null }) {
  return <ComponentsSection bp={bp} selectedIdx={selectedIdx} />;
}

/** Footer with Delete Blueprint button — kept as its own export so the
    layout shell can place it wherever it likes. */
export function BlueprintDeleteFooter({ bp }: { bp: BlueprintDef }) {
  const remove = useEditor((s) => s.removeBlueprint);
  return (
    <div style={{ padding: 12 }}>
      <button className="danger" style={{ width: "100%" }} onClick={() => remove(bp.id)}>
        Delete Blueprint
      </button>
    </div>
  );
}

// ── Components section ───────────────────────────────────────────────────────
// Renders the detail card for whichever component the user has selected via
// the left-rail Components chip grid. No tab strip — selection is owned by
// the parent (BlueprintTab) and passed down as `selectedIdx`.

interface BpForComponents {
  id: string;
  behaviors: BehaviorInstance[];
  /** Used by GenericComponentCard to render `varRef`/`varRefNumber` field
   *  dropdowns (e.g. Damageable's HP / Max HP link → BP variable). */
  variables?: Array<{ id: string; name: string; type: string }>;
}

function ComponentsSection({ bp, selectedIdx }: { bp: BpForComponents; selectedIdx: number | null }) {
  const updateBehavior = useEditor((s) => s.updateBlueprintBehavior);
  const removeBehavior = useEditor((s) => s.removeBlueprintBehavior);

  const idx = selectedIdx ?? -1;
  const active = idx >= 0 && idx < bp.behaviors.length ? bp.behaviors[idx] : null;

  const handleRemove = (i: number) => {
    removeBehavior(bp.id, i);
  };

  return (
    <div className="section">
      {!active ? (
        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>
          {bp.behaviors.length === 0
            ? "No components attached. Add one from the left rail."
            : "Click a component chip in the left rail to edit it."}
        </div>
      ) : (
        <>
          {/* Active component card */}
          {active.kind === "CharacterMovement" ? (
            <CharacterMovementCard
              behavior={active}
              hasAIBrain={bp.behaviors.some((b) => b.kind === "AIBrain")}
              onUpdate={(cfg) => updateBehavior(bp.id, idx, cfg)}
              onRemove={() => handleRemove(idx)}
            />
          ) : active.kind === "SmartTween" ? (
            <AnimatorCard
              bp={bp}
              behavior={active}
              onUpdate={(cfg) => updateBehavior(bp.id, idx, cfg)}
              onRemove={() => handleRemove(idx)}
            />
          ) : (
            <GenericComponentCard
              behavior={active}
              onUpdate={(cfg) => updateBehavior(bp.id, idx, cfg)}
              onRemove={() => handleRemove(idx)}
              variables={bp.variables}
              hasAIBrain={bp.behaviors.some((b) => b.kind === "AIBrain")}
              hostSpriteId={String(bp.behaviors.find((b) => b.kind === "SpriteRenderer")?.config.spriteId ?? "")}
            />
          )}
        </>
      )}
    </div>
  );
}

// Component card collapse state — persisted globally per kind so user
// preference survives reloads + tab switches.
const COMPONENT_CARD_COLLAPSE_KEY = (kind: string) => `peaky.component-card.collapsed.${kind}`;

function useComponentCollapse(kind: string): [boolean, (v: boolean) => void] {
  const [open, setOpenRaw] = useState(() => {
    try {
      const v = localStorage.getItem(COMPONENT_CARD_COLLAPSE_KEY(kind));
      if (v === "0") return false;
      if (v === "1") return true;
    } catch { /* no-op */ }
    return true;
  });
  const setOpen = (v: boolean) => {
    setOpenRaw(v);
    try { localStorage.setItem(COMPONENT_CARD_COLLAPSE_KEY(kind), v ? "1" : "0"); } catch { /* no-op */ }
  };
  return [open, setOpen];
}

/** Clickable header with chevron — used by both component cards. */
function ComponentCardHeader({
  kind, open, onToggle, onRemove,
}: {
  kind: string;
  open: boolean;
  onToggle: () => void;
  /** When omitted, the × remove button is hidden (internal-component case). */
  onRemove?: () => void;
}) {
  return (
    <div
      className="header"
      style={{ cursor: "pointer", userSelect: "none" }}
      onClick={onToggle}
      title={open ? "Collapse" : "Expand"}
    >
      <span style={{ color: "var(--text-dim)", fontSize: 10, width: 10, marginRight: 2 }}>
        {open ? "▼" : "▶"}
      </span>
      <ComponentIcon kind={kind} size={16} style={{ marginRight: 6 }} />
      <span className="kind">{kind}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ fontSize: 11, padding: "2px 6px" }}
          title="Remove component"
        >×</button>
      )}
    </div>
  );
}

// ── Generic metadata-driven component card ────────────────────────────────────
// Renders fields based on BEHAVIOR_PARAMS metadata so types like `spriteRef`
// (sprite-asset dropdown) and `spriteAnim` (animations of the chosen sprite)
// get proper UIs instead of free-text inputs.
/** Inline note under a mover's speed field, shown only when the BP also has an
 *  AIBrain — the brain writes the speed every tick from its Chase/Patrol Speed,
 *  so the field here is inert for an AI NPC. */
function AIBrainSpeedNote() {
  return (
    <div style={{ fontSize: 9, color: "var(--yellow, #d9a531)", fontStyle: "italic", padding: "0 4px 5px 4px", lineHeight: 1.3 }}>
      ⤷ Overridden by the AIBrain&apos;s Chase / Patrol Speed every frame — set the speed on the AIBrain instead.
    </div>
  );
}

interface DismemberRegionRow {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Phase 1 regions editor for the Dismemberment component — a simple add /
 * remove list of numeric {name, x, y, w, h} rows (frame-local pixel coords).
 * The BP preview draws a read-only overlay of these rectangles. No visual
 * drag-to-author yet (Phase 2).
 */
function DismemberRegionsEditor({
  regions,
  frameW,
  frameH,
  onChange,
}: {
  regions: DismemberRegionRow[];
  /** Chosen pose's frame size — new regions spawn centered in it so they land
   *  on the sprite, and the hint tells the author the valid coord range. */
  frameW: number;
  frameH: number;
  onChange: (rs: DismemberRegionRow[]) => void;
}) {
  const update = (i: number, patch: Partial<DismemberRegionRow>) => {
    const next = regions.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };
  const add = () => {
    const n = regions.length + 1;
    // Spawn a region in the middle of the frame so it's immediately visible on
    // the sprite in the preview (rather than at 0,0 / off the art).
    const w = Math.max(2, Math.round((frameW || 32) * 0.4));
    const h = Math.max(2, Math.round((frameH || 32) * 0.4));
    const x = Math.max(0, Math.round((frameW || 32) / 2 - w / 2));
    const y = Math.max(0, Math.round((frameH || 32) / 2 - h / 2));
    onChange([...regions, { name: `chunk${n}`, x, y, w, h }]);
  };
  const remove = (i: number) => onChange(regions.filter((_, idx) => idx !== i));

  const numStyle = { width: 44, fontSize: 10 } as const;
  return (
    <div style={{ padding: "4px 6px 6px" }}>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>
        Regions (frame-local px{frameW > 0 ? `, frame ${frameW}×${frameH}` : ""}). Each becomes one gib chunk on dismember.
      </div>
      {regions.length === 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", marginBottom: 4 }}>
          No regions — add at least one (dismember is a no-op otherwise).
        </div>
      )}
      {regions.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
          <input
            value={r.name}
            placeholder="name"
            onChange={(e) => update(i, { name: e.target.value })}
            style={{ width: 60, fontSize: 10 }}
          />
          <input type="number" value={r.x} title="x" onChange={(e) => update(i, { x: Number(e.target.value) })} style={numStyle} />
          <input type="number" value={r.y} title="y" onChange={(e) => update(i, { y: Number(e.target.value) })} style={numStyle} />
          <input type="number" value={r.w} title="w" onChange={(e) => update(i, { w: Number(e.target.value) })} style={numStyle} />
          <input type="number" value={r.h} title="h" onChange={(e) => update(i, { h: Number(e.target.value) })} style={numStyle} />
          <button
            type="button"
            onClick={() => remove(i)}
            title="Remove region"
            style={{ background: "transparent", border: 0, color: "var(--text-dim)", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        style={{ fontSize: 10, padding: "2px 8px", marginTop: 2, cursor: "pointer" }}
      >+ Region</button>
    </div>
  );
}

export function GenericComponentCard({
  behavior,
  onUpdate,
  onRemove,
  variables,
  hasAIBrain,
  hostSpriteId,
}: {
  behavior: BehaviorInstance;
  onUpdate: (cfg: Record<string, unknown>) => void;
  /** When omitted, the card's remove (×) button is hidden — used by the
   *  Character Overview where behaviors are internal to the template and
   *  not user-removable. */
  onRemove?: () => void;
  /** BP's declared variables — required for `varRef` / `varRefNumber`
   *  field types to render a real dropdown. Optional so callers that
   *  don't have varRef fields can omit. */
  variables?: { id: string; name: string; type: string }[];
  /** True when the owning BP also has an AIBrain — drives the
   *  "overridden by AIBrain" note on `aiOverridden` fields (speed). */
  hasAIBrain?: boolean;
  /** The host BP's SpriteRenderer sprite id — lets `spriteAnim` fields on
   *  behaviors that don't carry their own `spriteId` (e.g. Dismemberment's
   *  pose picker) list the right sprite's animations. */
  hostSpriteId?: string;
}) {
  const sprites = useEditor((s) => s.project.sprites);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const inputActions = useEditor((s) => s.project.inputActions);
  const sceneLayers = useEditor((s) => {
    const sc = s.project.scenes.find((sc) => sc.id === s.project.activeSceneId);
    return sc?.layers.map((L) => ({ id: L.id, name: L.name })) ?? [];
  });
  const params = BEHAVIOR_PARAMS[behavior.kind] ?? [];
  const cfg = behavior.config;
  const [open, setOpen] = useComponentCollapse(behavior.kind);

  // Dismemberment region authoring needs the chosen pose's frame size so new
  // regions can spawn centered ON the sprite (instead of at 0,0 / off-frame).
  const dismemberFrame = (() => {
    if (behavior.kind !== "Dismemberment") return { w: 0, h: 0 };
    const sp = sprites.find((s) => s.id === hostSpriteId);
    if (!sp) return { w: 0, h: 0 };
    const refAnim = String(cfg.refAnimation ?? "");
    const anim = sp.animations.find((a) => a.name === refAnim) ?? sp.animations[0];
    const fIdx = Math.max(0, Math.min((anim?.frames.length ?? 1) - 1, Math.floor(Number(cfg.refFrame ?? 0))));
    const f = anim?.frames[fIdx];
    return { w: f?.imageW ?? sp.width, h: f?.imageH ?? sp.height };
  })();

  return (
    <div className="behavior-card">
      <ComponentCardHeader
        kind={behavior.kind}
        open={open}
        onToggle={() => setOpen(!open)}
        onRemove={onRemove}
      />
      {open && behavior.kind === "Dismemberment" && (
        <DismemberRegionsEditor
          regions={Array.isArray(cfg.regions) ? (cfg.regions as DismemberRegionRow[]) : []}
          frameW={dismemberFrame.w}
          frameH={dismemberFrame.h}
          onChange={(rs) => onUpdate({ ...cfg, regions: rs })}
        />
      )}
      {open && (params.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: 4 }}>(no config)</div>
      ) : (
        params.map((p) => {
          // Honor `dependsOn` — hide this row unless its parent field has
          // the matching value. Loose equality so number `1` matches the
          // value coming back as `1` from a numeric input.
          if (p.dependsOn) {
            const depVal = cfg[p.dependsOn.key] ?? BEHAVIOR_PARAMS[behavior.kind]?.find((x) => x.key === p.dependsOn!.key)?.default;
            // eslint-disable-next-line eqeqeq
            if (depVal != p.dependsOn.value) return null;
          }
          if (behavior.kind === "Damageable" && p.key === "knockbackMultiplier") {
            return <KnockbackTriple key={p.key} cfg={cfg} onUpdate={onUpdate} />;
          }
          if (p.comingSoon) {
            return (
              <Fragment key={p.key}>
                <div style={{ opacity: 0.45, pointerEvents: "none" }} title={p.comingSoon}>
                  <ParamField
                    paramKey={p.key}
                    label={p.label}
                    type={p.type}
                    options={p.options}
                    value={cfg[p.key] ?? p.default}
                    sprites={sprites}
                    currentSpriteId={String((p.animOf ? cfg[p.animOf] : (cfg.spriteId ?? cfg.maskSpriteId)) ?? hostSpriteId ?? "")}
                    variables={variables}
                    uiWidgets={uiWidgets}
                    inputActions={inputActions}
                    sceneLayers={sceneLayers}
                    onChange={() => {}}
                  />
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic", padding: "0 4px 4px 104px" }}>
                  🔒 {p.comingSoon}
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={p.key}>
              <ParamField
                paramKey={p.key}
                label={p.label}
                type={p.type}
                options={p.options}
                value={cfg[p.key] ?? p.default}
                sprites={sprites}
                currentSpriteId={String((p.animOf ? cfg[p.animOf] : (cfg.spriteId ?? cfg.maskSpriteId)) ?? hostSpriteId ?? "")}
                variables={variables}
                uiWidgets={uiWidgets}
                inputActions={inputActions}
                sceneLayers={sceneLayers}
                onChange={(v) => onUpdate({ ...cfg, [p.key]: v })}
              />
              {p.aiOverridden && hasAIBrain && <AIBrainSpeedNote />}
            </Fragment>
          );
        })
      ))}
    </div>
  );
}

// Damageable's three knockback multipliers, laid out side by side with a
// small hint under each so authors see at a glance which case each one drives.
export function KnockbackTriple({
  cfg, onUpdate,
}: {
  cfg: Record<string, unknown>;
  onUpdate: (cfg: Record<string, unknown>) => void;
}) {
  const cols: { key: string; hint: string }[] = [
    { key: "knockbackMultiplier", hint: "for damage" },
    { key: "blockKnockbackMultiplier", hint: "for block" },
    { key: "partialKnockbackMultiplier", hint: "for partial" },
  ];
  return (
    <div className="field" style={{ gridTemplateColumns: "100px 1fr", alignItems: "start" }}>
      <label>Knockback ×</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {cols.map((c) => (
          <div key={c.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <NumberField
              value={typeof cfg[c.key] === "number" ? (cfg[c.key] as number) : 1}
              onChange={(v) => onUpdate({ ...cfg, [c.key]: v })}
              step="any"
              style={{ fontSize: 11 }}
            />
            <span style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "center" }}>{c.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ParamField({
  paramKey, label, type, options, value, sprites, currentSpriteId, variables, uiWidgets, inputActions, sceneLayers, onChange,
}: {
  paramKey: string;
  label: string;
  type?: "number" | "bool" | "string" | "spriteRef" | "spriteAnim" | "varRef" | "varRefNumber" | "widgetRef" | "inputAction" | "font" | "sceneLayerList" | "signal" | "tagList";
  options?: { value: string; label: string }[];
  value: unknown;
  sprites: SpriteAsset[];
  currentSpriteId: string;
  variables?: { id: string; name: string; type: string }[];
  uiWidgets?: { id: string; name: string }[];
  inputActions?: { id: string; name: string }[];
  sceneLayers?: { id: string; name: string }[];
  onChange: (v: unknown) => void;
}) {
  const fieldStyle = { gridTemplateColumns: "100px 1fr" } as const;

  if (type === "signal") {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <SignalPicker
          value={String(value ?? "")}
          onChange={(v) => onChange(v)}
          mode="listen"
          placeholder="pick signal…"
          style={{ width: "100%" }}
        />
      </div>
    );
  }

  if (type === "sceneLayerList") {
    const selected = String(value ?? "")
      .split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    const available = (sceneLayers ?? []).map((L) => L.name);
    const unpicked = available.filter((n) => !selected.includes(n));
    const setNext = (next: string[]) => onChange(next.join(", "));
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {selected.map((name) => (
            <span key={name} style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, padding: "2px 4px 2px 6px",
              background: "rgba(94,179,255,0.18)", border: "1px solid rgba(94,179,255,0.45)",
              borderRadius: 10,
            }}>
              {name}
              <button
                type="button"
                onClick={() => setNext(selected.filter((s) => s !== name))}
                style={{ background: "transparent", border: 0, color: "var(--text-dim)", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}
                title={`Remove ${name}`}
              >×</button>
            </span>
          ))}
          {unpicked.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) setNext([...selected, e.target.value]); }}
              style={{ fontSize: 10, padding: "2px 4px", background: "var(--input-bg, rgba(0,0,0,0.4))", border: "1px solid var(--border, rgba(255,255,255,0.1))", borderRadius: 3, color: "var(--text)" }}
              title="Add a scene layer to the cutout list. Empty list = all layers eligible."
            >
              <option value="">+ add layer…</option>
              {unpicked.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {selected.length === 0 && unpicked.length === 0 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
              No scene layers — open a scene to populate.
            </span>
          )}
          {selected.length === 0 && unpicked.length > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
              empty = all layers
            </span>
          )}
        </div>
      </div>
    );
  }

  if (type === "tagList") {
    const tags = Array.isArray(value)
      ? (value as string[])
      : String(value ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    return (
      <div className="field" style={{ ...fieldStyle, alignItems: "start" }}>
        <label>{label}</label>
        <TagChips tags={tags} onChange={(next) => onChange(next)} placeholder="add tag…" />
      </div>
    );
  }

  if (type === "bool") {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <Toggle
          value={Number(value ?? 0) !== 0}
          onChange={(v) => onChange(v ? 1 : 0)}
        />
      </div>
    );
  }

  if (type === "varRef" || type === "varRefNumber") {
    const opts = (variables ?? []).filter((v) => type === "varRef" || v.type === "number");
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        {opts.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            No {type === "varRefNumber" ? "numeric " : ""}variables on this BP.
          </span>
        ) : (
          <select
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            style={{ fontSize: 11 }}
            title="Choose which BP variable mirrors this field. Empty = unlinked."
          >
            <option value="">— unlinked —</option>
            {opts.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === "inputAction") {
    const acts = inputActions ?? [];
    const cur = String(value ?? "");
    // Keep the current value selectable even if it isn't a defined action
    // (custom name, or an action that was renamed/removed) so it isn't lost.
    const missing = cur !== "" && !acts.some((a) => a.name === cur);
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        {acts.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            No Input Actions — add them in the Input Actions panel.
          </span>
        ) : (
          <select
            value={cur}
            onChange={(e) => onChange(e.target.value)}
            style={{ fontSize: 11 }}
            title="Project Input Action that drives this direction. Manage bindings in the Input Actions panel."
          >
            <option value="">— none —</option>
            {missing && <option value={cur}>{cur} (not defined)</option>}
            {acts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === "widgetRef") {
    // BP-attached widgets must be single-mode — multi-mode (Panel + nested
    // children authored at viewport coords) doesn't map cleanly to a
    // following-the-host overlay. Filter so the dropdown only lists
    // attachable widgets.
    const allWidgets = (uiWidgets ?? []) as Array<{ id: string; name: string; mode?: string }>;
    const widgets = allWidgets.filter((w) => w.mode !== "multi");
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        {allWidgets.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            No UI widgets — create one in the Content Browser.
          </span>
        ) : widgets.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--orange)", fontStyle: "italic" }}>
            No single-mode widgets. BP-attached widgets must be single-mode.
          </span>
        ) : (
          <select
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            style={{ fontSize: 11 }}
            title="Pick a single-mode UI widget to attach to this BP. Renders pinned to the host sprite at the configured offset. Use Link Value Var below to wire its value/text to a host BP variable."
          >
            <option value="">— pick widget —</option>
            {widgets.map((w) => <option key={w.id} value={w.id}>{w.name || "(unnamed)"}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === "spriteRef") {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        {sprites.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            No sprites — create one in the Content Browser.
          </span>
        ) : (
          <select
            value={String(value ?? "")}
            onChange={(e) => {
              const newSpriteId = e.target.value;
              const sp = sprites.find((s) => s.id === newSpriteId);
              // When the sprite changes, also reset currentAnimation to its default
              // — otherwise we'd keep an animation name that doesn't exist on the new sprite.
              if (paramKey === "spriteId" && sp) {
                onChange(newSpriteId);
              } else {
                onChange(newSpriteId);
              }
            }}
            style={{ fontSize: 11 }}
          >
            <option value="">— pick sprite —</option>
            {sprites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === "spriteAnim") {
    const sp = sprites.find((s) => s.id === currentSpriteId);
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        {!sp ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            Pick a sprite first.
          </span>
        ) : sp.animations.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
            "{sp.name}" has no animations.
          </span>
        ) : (
          <select
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            style={{ fontSize: 11 }}
            title={`Animations defined on sprite "${sp.name}"`}
          >
            <option value="">— pick animation —</option>
            {sp.animations.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === "font") {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <FontFamilyInput value={String(value ?? "")} onChange={(v) => onChange(v)} style={{ fontSize: 11 }} />
      </div>
    );
  }

  if (type === "string" && options) {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontSize: 11 }}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    );
  }

  if (type === "string") {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <input
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontSize: 11 }}
        />
      </div>
    );
  }

  // Color params (any key matching color/tint heuristic) — swatch + hex
  // input. Falls under the default number branch in behaviorMeta but
  // intercepted here so authors never have to type 0xRRGGBB by hand.
  if (isColorParamKey(paramKey)) {
    return (
      <div className="field" style={fieldStyle}>
        <label>{label}</label>
        <ColorField value={value} onChange={onChange} mode="number" />
      </div>
    );
  }

  // Default: number field. Uses NumberField (controlled string buffer) so
  // intermediate states like `-` (typing a negative) and `1.` (mid-decimal)
  // survive instead of getting wiped to 0.
  const num = typeof value === "number" ? value : parseFloat(String(value ?? 0)) || 0;
  return (
    <div className="field" style={fieldStyle}>
      <label>{label}</label>
      <NumberField
        value={num}
        onChange={onChange}
        step="any"
        style={{ fontSize: 11 }}
      />
    </div>
  );
}

// ── CharacterMovement card ────────────────────────────────────────────────────
// Smart all-in-one platformer character controller with sectioned UI:
//   Physics · Move Left · Move Right · Jump (+ Coyote/Buffer/Multi/VarHeight) · Dash
// Each ability binds to a project InputAction by name (dropdown).

export function CharacterMovementCard({
  behavior,
  onUpdate,
  onRemove,
  hasAIBrain,
}: {
  behavior: BehaviorInstance;
  onUpdate: (cfg: Record<string, unknown>) => void;
  /** When omitted, the × remove button is hidden — used by the Character
   *  Overview where CharacterMovement is internal to the template. */
  onRemove?: () => void;
  /** True when the BP also has an AIBrain — shows the speed-override note. */
  hasAIBrain?: boolean;
}) {
  const inputActions = useEditor((s) => s.project.inputActions);
  // Collect every emitted event name across the project (declared + every
  // EmitEvent action target). Recomputes only when the project ref changes.
  const emittedSignals = useEditor((s) => collectEmittedSignalNames(s.project));
  const cfg = behavior.config;

  const set = (patch: Record<string, unknown>) => onUpdate({ ...cfg, ...patch });

  const num = (key: string, fallback = 0): number =>
    typeof cfg[key] === "number" ? (cfg[key] as number) : fallback;
  const str = (key: string, fallback = ""): string =>
    typeof cfg[key] === "string" ? (cfg[key] as string) : fallback;
  const bool = (key: string): boolean => num(key, 0) !== 0;

  const [open, setOpen] = useComponentCollapse("CharacterMovement");

  return (
    <div className="behavior-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <ComponentCardHeader
        kind="CharacterMovement"
        open={open}
        onToggle={() => setOpen(!open)}
        onRemove={onRemove}
      />

      {open && (
      <>
      <SubSection title="Physics">
        <NumField label="Max Speed"      value={num("maxSpeed", 220)}      onChange={(v) => set({ maxSpeed: v })} />
        {hasAIBrain && <AIBrainSpeedNote />}
        <NumField label="Acceleration"   value={num("acceleration", 1500)} onChange={(v) => set({ acceleration: v })} />
        <NumField label="Deceleration"   value={num("deceleration", 1500)} onChange={(v) => set({ deceleration: v })} />
        <NumField label="Air Control"    value={num("airControl", 1.0)}    onChange={(v) => set({ airControl: v })} step={0.1} />
        <NumField label="Gravity"        value={num("gravity", 800)}       onChange={(v) => set({ gravity: v })} />
        <NumField label="Gravity Angle"  value={num("gravityAngle", 90)}   onChange={(v) => set({ gravityAngle: v })}
          title="Direction in degrees. 0=right, 90=down (default), 180=left, 270=up." />
        <NumField label="Max Fall Speed" value={num("maxFallSpeed", 600)}  onChange={(v) => set({ maxFallSpeed: v })} />
        <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="0=Stop (zero vy on ceiling). 1=Preserve momentum (keep upward velocity).">
          <label>Ceiling</label>
          <select value={String(num("ceilingMode", 0))} onChange={(e) => set({ ceilingMode: parseInt(e.target.value) })} style={{ fontSize: 11 }}>
            <option value="0">stop (zero vy)</option>
            <option value="1">preserve momentum</option>
          </select>
        </div>
        <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="Auto-flip sprite to face direction. Off / Velocity (follow vx) / Input (follow last left-right key).">
          <label>Mirror</label>
          <select value={String(num("mirrorMode", 0))} onChange={(e) => set({ mirrorMode: parseInt(e.target.value) })} style={{ fontSize: 11 }}>
            <option value="0">off</option>
            <option value="1">velocity</option>
            <option value="2">input</option>
          </select>
        </div>
        <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="Animate the mirror flip — scaleX lerps from current to target sign over the time below. Off = instant snap.">
          <label>Smooth Mirror</label>
          <Toggle
            value={num("scaleMirror", 0) !== 0}
            onChange={(v) => set({ scaleMirror: v ? 1 : 0 })}
          />
        </div>
        {num("scaleMirror", 0) !== 0 && (
          <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="Seconds for a full 1↔-1 scaleX traverse. Typical 0.1–0.2.">
            <label>↳ Time (s)</label>
            <NumberField
              value={num("scaleMirrorTime", 0.15)}
              onChange={(v) => set({ scaleMirrorTime: v })}
              step="0.01"
              style={{ fontSize: 11 }}
            />
          </div>
        )}
      </SubSection>

      <SubSection title="Movement">
        <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, padding: "2px 0" }}>Left</div>
        <TriggerField
          actionValue={str("leftAction", "MoveLeft")}
          eventValue={str("leftEventTrigger", "")}
          actions={inputActions}
          emittedSignals={emittedSignals}
          onChange={(action, event) => set({ leftAction: action, leftEventTrigger: event })}
        />
        <CustomFnField
          value={str("leftCustomFn", "")}
          onChange={(v) => set({ leftCustomFn: v })}
        />
        <div style={{ fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5, padding: "6px 0 2px" }}>Right</div>
        <TriggerField
          actionValue={str("rightAction", "MoveRight")}
          eventValue={str("rightEventTrigger", "")}
          actions={inputActions}
          emittedSignals={emittedSignals}
          onChange={(action, event) => set({ rightAction: action, rightEventTrigger: event })}
        />
        <CustomFnField
          value={str("rightCustomFn", "")}
          onChange={(v) => set({ rightCustomFn: v })}
        />
      </SubSection>

      <SubSection title="Jump">
        <TriggerField
          actionValue={str("jumpAction", "Jump")}
          eventValue={str("jumpEventTrigger", "")}
          actions={inputActions}
          emittedSignals={emittedSignals}
          onChange={(action, event) => set({ jumpAction: action, jumpEventTrigger: event })}
        />
        <CustomFnField
          value={str("jumpCustomFn", "")}
          onChange={(v) => set({ jumpCustomFn: v })}
        />
        <NumField label="Strength" value={num("jumpStrength", 460)} onChange={(v) => set({ jumpStrength: v })}
          title="Initial upward velocity. Ignored when Time-To-Apex > 0 (then computed from gravity × time)." />
        <NumField label="Time-To-Apex (s)" value={num("jumpTimeToApex", 0)} onChange={(v) => set({ jumpTimeToApex: v })} step={0.05}
          title="Seconds to reach jump peak. >0 overrides Strength: 0.2=snappy, 0.4=floaty, 0.6+=slow lobs. 0=use Strength as-is." />
        <NumField label="Fall Multiplier" value={num("fallGravityMultiplier", 1)} onChange={(v) => set({ fallGravityMultiplier: v })} step={0.1}
          title="Gravity multiplier while falling. >1 = fall faster than rise (snappy platformer feel). Mario ≈ 1.5–2, Celeste ≈ 2.5. 1 = symmetric." />
        <NumField label="Multi-Jump" value={num("multiJump", 1)} onChange={(v) => set({ multiJump: Math.max(1, Math.round(v)) })}
          title="1 = single jump, 2 = double, 3 = triple…" />

        <ToggleField
          label="Coyote Time"
          checked={bool("coyoteEnabled")}
          onChange={(v) => set({ coyoteEnabled: v ? 1 : 0 })}
          title="Briefly accept jumps after walking off a ledge"
        />
        {bool("coyoteEnabled") && (
          <NumField label="↳ Duration (s)" value={num("coyoteTime", 0.1)} onChange={(v) => set({ coyoteTime: v })} step={0.01} />
        )}

        <ToggleField
          label="Input Buffer"
          checked={bool("bufferEnabled")}
          onChange={(v) => set({ bufferEnabled: v ? 1 : 0 })}
          title="If jump is pressed just before landing, fire on land"
        />
        {bool("bufferEnabled") && (
          <NumField label="↳ Duration (s)" value={num("bufferTime", 0.1)} onChange={(v) => set({ bufferTime: v })} step={0.01} />
        )}

        <ToggleField
          label="Variable Height"
          checked={bool("varHeightEnabled")}
          onChange={(v) => set({ varHeightEnabled: v ? 1 : 0 })}
          title="Releasing jump while ascending caps upward velocity (short hop)"
        />
        {bool("varHeightEnabled") && (
          <NumField label="↳ Cutoff (vy)" value={num("varHeightCutoff", -150)} onChange={(v) => set({ varHeightCutoff: v })}
            title="Less negative = shorter hop. -150 ≈ moderate variable height." />
        )}

        <ToggleField
          label="Jump Sustain"
          checked={bool("jumpSustainEnabled")}
          onChange={(v) => set({ jumpSustainEnabled: v ? 1 : 0 })}
          title="Holding jump within the sustain window keeps the rise going. Releasing cuts it off."
        />
        {bool("jumpSustainEnabled") && (
          <NumField label="↳ Sustain (s)" value={num("jumpSustainTime", 0.18)} onChange={(v) => set({ jumpSustainTime: v })} step={0.01}
            title="Maximum time (in seconds) jump can be held to extend the rise." />
        )}
      </SubSection>

      <SubSection title="Dash">
        <ToggleField
          label="Enabled"
          checked={bool("dashEnabled")}
          onChange={(v) => set({ dashEnabled: v ? 1 : 0 })}
        />
        {bool("dashEnabled") && (
          <>
            <TriggerField
              actionValue={str("dashAction", "Dash")}
              eventValue={str("dashEventTrigger", "")}
              actions={inputActions}
              emittedSignals={emittedSignals}
              onChange={(action, event) => set({ dashAction: action, dashEventTrigger: event })}
            />
            <CustomFnField
              value={str("dashCustomFn", "")}
              onChange={(v) => set({ dashCustomFn: v })}
            />
            <NumField label="Speed"        value={num("dashSpeed", 600)}      onChange={(v) => set({ dashSpeed: v })} />
            <NumField label="Start Delay (s)" value={num("dashStartDelay", 0)} onChange={(v) => set({ dashStartDelay: v })} step={0.01} />
            <NumField label="Duration (s)" value={num("dashDuration", 0.15)}  onChange={(v) => set({ dashDuration: v })} step={0.01} />
            <NumField label="Cooldown (s)" value={num("dashCooldown", 1.0)}   onChange={(v) => set({ dashCooldown: v })} step={0.05} />
            <ToggleField
              label="Block Walls"
              checked={num("dashWallBlock", 1) !== 0}
              onChange={(v) => set({ dashWallBlock: v ? 1 : 0 })}
              title="Stop the dash at tilemap walls instead of phasing through them (a fast dash can tunnel tile collision). Solid blueprints already block it. Off = phase-dash through tiles."
            />
          </>
        )}
      </SubSection>

      <SubSection title="Wall">
        <ToggleField
          label="Enabled"
          checked={bool("wallEnabled")}
          onChange={(v) => set({ wallEnabled: v ? 1 : 0 })}
          title="Wall slide + wall jump. When sliding, descent is capped; pressing jump kicks off the wall."
        />
        {bool("wallEnabled") && (
          <>
            <NumField label="Slide Speed"   value={num("wallSlideSpeed", 100)}   onChange={(v) => set({ wallSlideSpeed: v })}
              title="Maximum downward speed while sliding against a wall. The body accelerates at normal gravity, then vy is clipped to this value." />
            <NumField label="Jump Strength" value={num("wallJumpStrength", 460)} onChange={(v) => set({ wallJumpStrength: v })}
              title="Vertical kick when jumping off a wall." />
            <NumField label="Kick X"        value={num("wallJumpKickX", 320)}    onChange={(v) => set({ wallJumpKickX: v })}
              title="Horizontal velocity away from the wall on wall jump." />
            <ToggleField
              label="Hold to Slide"
              checked={num("wallSlideRequiresInput", 1) !== 0}
              onChange={(v) => set({ wallSlideRequiresInput: v ? 1 : 0 })}
              title="If on, you must hold the direction toward the wall to slide. Releasing the key flips IsWallSliding to false. If off, contact alone is enough."
            />
            <ToggleField
              label="Slide On Contact"
              checked={num("wallSlideOnContact", 0) !== 0}
              onChange={(v) => set({ wallSlideOnContact: v ? 1 : 0 })}
              title="If on, wall-slide engages the moment you contact a wall — even mid-jump while still rising. Upward momentum is zeroed on contact (instant grab). If off, slide only triggers once you start falling."
            />
            <CustomFnField
              value={str("wallSlideCustomFn", "")}
              onChange={(v) => set({ wallSlideCustomFn: v })}
            />
            <CustomFnField
              value={str("wallJumpCustomFn", "")}
              onChange={(v) => set({ wallJumpCustomFn: v })}
            />
          </>
        )}
      </SubSection>
      </>
      )}
    </div>
  );
}

// Per-subsection collapsed state — persisted globally so user preference
// survives BP/scene tab switches and page reloads.
const COLLAPSE_KEY = (title: string) => `peaky.cm.collapsed.${title}`;

function SubSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: import("react").ReactNode;
}) {
  const [open, setOpenRaw] = useState(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY(title));
      if (v === "0") return false;
      if (v === "1") return true;
    } catch { /* no-op */ }
    return defaultOpen;
  });
  const setOpen = (v: boolean) => {
    setOpenRaw(v);
    try { localStorage.setItem(COLLAPSE_KEY(title), v ? "1" : "0"); } catch { /* no-op */ }
  };
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: 4,
      padding: open ? "6px 10px 8px" : 0,
      background: "rgba(85, 100, 150, 0.18)",
      borderRadius: 6,
      border: "1px solid rgba(140, 160, 220, 0.22)",
      overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          color: "#ff8c42",
          textAlign: "left",
          width: "100%",
        }}
        title={open ? "Collapse" : "Expand"}
      >
        <span style={{ fontSize: 11, color: "#ff8c42", width: 12 }}>{open ? "▼" : "▶"}</span>
        <span>{title}</span>
      </button>
      {open && children}
    </div>
  );
}

function NumField({
  label, value, onChange, step, title,
}: {
  label: string; value: number; onChange: (v: number) => void; step?: number; title?: string;
}) {
  return (
    <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title={title}>
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}

function ToggleField({
  label, checked, onChange, title,
}: {
  label: string; checked: boolean; onChange: (v: boolean) => void; title?: string;
}) {
  return (
    <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title={title}>
      <label>{label}</label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <Toggle
          value={checked}
          onChange={(v) => onChange(v)}
          style={{ width: "auto" }}
        />
        <span style={{ fontSize: 11, color: checked ? "var(--accent)" : "var(--text-dim)" }}>
          {checked ? "On" : "Off"}
        </span>
      </label>
    </div>
  );
}

function CustomFnField({
  value, onChange,
}: {
  value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="Optional. When set, the behavior emits an event with this name when the action triggers — wire SMs (and future custom functions) to this for fully controlled flow. Built-in physics still runs alongside.">
      <label style={{ color: "var(--text-dim)" }}>Custom Fn</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="(optional) custom function name"
        style={{ fontSize: 11, fontStyle: value ? "normal" : "italic", color: value ? undefined : "var(--text-dim)" }}
      />
    </div>
  );
}

/**
 * Combined trigger picker: an ability fires when its InputAction is held/pressed
 * OR when its linked Signal fires this frame. The dropdown shows InputAction
 * bindings, "— None —", and "→ Link to Signal" — picking the last reveals a
 * second dropdown of project Signals (declared in the Signals modal AND any
 * name typed into an EmitSignal action).
 */
function TriggerField({
  actionValue, eventValue, actions, emittedSignals, onChange,
}: {
  actionValue: string;
  eventValue: string;
  actions: InputActionDef[];
  emittedSignals: string[];
  /** Atomic update — receives BOTH action and event values in a single
   *  call so the parent's `set({ ...patch })` merges them in one store
   *  write. Two sequential updates with separate callbacks would each
   *  capture the same stale config snapshot from the closure, and the
   *  second would clobber the first — picking "MoveLeft" would revert
   *  to None as `rightEventTrigger=""` overwrote `rightAction="MoveLeft"`. */
  onChange: (action: string, event: string) => void;
}) {
  const knownAction = actions.some((a) => a.name === actionValue);

  // Track "user explicitly picked signal mode but hasn't chosen one yet" so
  // the second dropdown stays visible even with eventValue === "".
  const [signalModeIntent, setSignalModeIntent] = useState(false);
  const signalMode = !!eventValue || signalModeIntent;

  const onChangePrimary = (v: string) => {
    if (v === "__signal__") {
      setSignalModeIntent(true);
      onChange("", eventValue); // entering signal mode — keep current eventValue, clear action
    } else {
      setSignalModeIntent(false);
      onChange(v, ""); // picking an action — set action, clear event in ONE write
    }
  };

  const showSignalPicker = signalMode;
  const primarySelectValue = signalMode ? "__signal__" : actionValue;

  return (
    <>
      <div
        className="field"
        style={{ gridTemplateColumns: "110px 1fr" }}
        title={signalMode ? "Triggered by signal" : actionValue === "" ? "No trigger — drive externally" : undefined}
      >
        <label style={signalMode || actionValue === "" ? { color: "var(--text-dim)" } : undefined}>Action</label>
        {actions.length === 0 && !signalMode ? (
          <span style={{ fontSize: 11, fontStyle: "italic", color: "var(--red, #d65)" }}>
            No Input Actions defined — open the Input Actions modal in the toolbar to add some.
          </span>
        ) : (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <select
              value={primarySelectValue}
              onChange={(e) => onChangePrimary(e.target.value)}
              style={{
                fontSize: 11,
                fontStyle: (signalMode || actionValue === "") ? "italic" : "normal",
                color: (signalMode || actionValue === "") ? "var(--text-dim)" : undefined,
              }}
            >
              <option value="">— None —</option>
              {!knownAction && actionValue && !signalMode && (
                <option value={actionValue}>{actionValue} (unknown)</option>
              )}
              {actions.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              <option value="__signal__">→ Link to Signal…</option>
            </select>
            <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "monospace" }} title="Diagnostic — number of InputActions visible to this dropdown">
              [{actions.length}]
            </span>
          </span>
        )}
      </div>
      {showSignalPicker && (
        <div className="field" style={{ gridTemplateColumns: "110px 1fr" }} title="Ability fires when this signal is emitted on the sprite this frame. Includes signals declared in the Signals modal AND any name typed into an EmitSignal action.">
          <label style={{ color: "var(--accent)" }}>↳ Signal</label>
          {emittedSignals.length === 0 && !eventValue ? (
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontStyle: "italic" }}>
              No signals emitted yet. Add an EmitSignal action or declare one in the Signals modal.
            </span>
          ) : (
            <select
              value={eventValue}
              onChange={(e) => onChange("", e.target.value)}
              style={{ fontSize: 11 }}
            >
              <option value="">— pick signal —</option>
              {/* Show the current value even if it's not in the emitted list yet
                  (e.g. user just typed it elsewhere — keeps selection stable) */}
              {eventValue && !emittedSignals.includes(eventValue) && (
                <option value={eventValue}>{eventValue} (not yet emitted)</option>
              )}
              {emittedSignals.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Variables panel (left rail) — chip-grid layout per mockup.
 *
 * Each variable renders as a colored pill (color from `variable.color`,
 * falling back to a type-based default). Clicking a chip selects it and
 * reveals the {@link VariableDetailEditor} below the grid (Default Value,
 * Auto Cap, Instance Editable, Expose on Spawn, Color). Click again to
 * collapse. The `+` chip on the end adds a new variable.
 */
export function VariablesSection({ bp }: { bp: import("../../project").BlueprintDef }) {
  const add = useEditor((s) => s.addVariable);
  const rename = useEditor((s) => s.renameVariable);
  const remove = useEditor((s) => s.removeVariable);
  const project = useEditor((s) => s.project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const selected = bp.variables.find((v) => v.id === selectedId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 12px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="label-uppercase">+ Variables</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{bp.variables.length}</span>
      </div>

      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: "4px 10px 6px",
      }}>
        {bp.variables.map((v) => {
          const color = defaultColorForType(v.type, v.numberKind);
          const isSelected = v.id === selectedId;
          return (
            <div
              key={v.id}
              onClick={() => setSelectedId(isSelected ? null : v.id)}
              onMouseEnter={() => setHoverId(v.id)}
              onMouseLeave={() => setHoverId((h) => (h === v.id ? null : h))}
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: `1px solid ${isSelected ? "var(--yellow, #f5b447)" : "rgba(255,255,255,0.08)"}`,
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-2)",
                userSelect: "none",
              }}
              title={`${v.name} <${v.type}>${isSelected ? " — click to collapse" : " — click to edit"}`}
            >
              <span style={{
                width: 10,
                height: 10,
                background: color,
                borderRadius: 2,
                border: "1px solid rgba(0,0,0,0.4)",
                flex: "0 0 auto",
              }} />
              {isSelected ? (
                <input
                  value={v.name}
                  onChange={(e) => rename(bp.id, v.id, e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                  style={{
                    fontSize: 11,
                    padding: "0 2px",
                    background: "transparent",
                    border: "none",
                    color: "var(--text)",
                    outline: "none",
                    width: Math.max(40, v.name.length * 7),
                  }}
                />
              ) : (
                <span>{v.name}</span>
              )}
              {isSelected && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Delete variable "${v.name}"?`)) return;
                    remove(bp.id, v.id);
                    setSelectedId(null);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: 0,
                    lineHeight: 1,
                  }}
                  title="Remove variable"
                >×</button>
              )}
              {hoverId === v.id && !isSelected && (() => {
                const uses = findVarUsages(project, bp.id, bp.name, v.name);
                const seen = new Set<string>();
                const lines = uses
                  .map((u) => `${u.where} ▸ ${u.detail}`)
                  .filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
                return (
                  <div style={{
                    position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50,
                    minWidth: 200, maxWidth: 320,
                    background: "var(--card)", border: "1px solid var(--border)",
                    borderRadius: 6, padding: "6px 8px",
                    boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
                    fontSize: 10, color: "var(--text-2)", lineHeight: 1.5,
                    cursor: "default",
                  }}>
                    <div style={{ color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 8, marginBottom: 3 }}>
                      Used in
                    </div>
                    {lines.length === 0 ? (
                      <div style={{ fontStyle: "italic", color: "var(--text-dim)" }}>Not used anywhere</div>
                    ) : (
                      <>
                        {lines.slice(0, 10).map((l, i) => <div key={i}>{l}</div>)}
                        {lines.length > 10 && <div style={{ color: "var(--text-dim)" }}>+{lines.length - 10} more</div>}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })}
        <button
          onClick={() => {
            const id = add(bp.id);
            setSelectedId(id);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            background: "rgba(255,255,255,0.04)",
            border: "1px dashed rgba(255,255,255,0.15)",
            borderRadius: 4,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 11,
          }}
          title="Add a new variable"
        >+ add</button>
      </div>

      {selected && <VariableDetailEditor bpId={bp.id} variable={selected} />}
    </div>
  );
}

/**
 * Compatibility wrapper — vertically stacks the named sections. Used by
 * `InspectorPanel.tsx` (right-side inspector when no 3-column shell is in
 * play). The 3-column blueprint workspace places the named sections in
 * separate columns instead of using this wrapper.
 */
export function BlueprintInspector() {
  const bp = useEditor((s) => s.selectedBlueprint());
  if (!bp) {
    return (
      <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
        Select a blueprint to edit.
      </div>
    );
  }
  return (
    <>
      <BlueprintIdentitySection bp={bp} />
      <BlueprintComponentDetail bp={bp} selectedIdx={null} />
      <VariablesSection bp={bp} />
      <BlueprintLODSection bp={bp} />
      <BlueprintDeleteFooter bp={bp} />
    </>
  );
}

/**
 * Component-LOD authoring. Lets the author group a BP's behavior chips
 * by distance — components in a group enable only when a sprite carrying
 * `targetTag` is within `distance` px. Cheap behaviors (MoveTo,
 * Damageable) can be left out of any group → they always run.
 *
 * Layout mirrors VariablesSection: chip-grid of groups (one per group),
 * click a chip to expand the detail editor inline.
 */
export function BlueprintLODSection({ bp }: { bp: BlueprintDef }) {
  const addGroup = useEditor((s) => s.addLODGroup);
  const updateGroup = useEditor((s) => s.updateLODGroup);
  const removeGroup = useEditor((s) => s.removeLODGroup);
  const toggleComponent = useEditor((s) => s.toggleLODGroupComponent);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const groups = bp.lodGroups ?? [];
  const selected = groups.find((g) => g.id === selectedId) ?? null;
  const availableKinds = Array.from(new Set(bp.behaviors.map((b) => b.kind)));

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 12px 4px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className="label-uppercase" title="Per-component LOD: list behaviors that should only run when a tag-matched sprite (e.g. 'player') is close. Cheaper than CullMode=Freeze because gameplay behaviors like MoveTo keep running off-screen.">+ Component LOD</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{groups.length}</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "4px 10px 6px" }}>
        {groups.map((g) => {
          const isSelected = g.id === selectedId;
          return (
            <div
              key={g.id}
              onClick={() => setSelectedId(isSelected ? null : g.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: `1px solid ${isSelected ? "var(--yellow, #f5b447)" : "rgba(255,255,255,0.08)"}`,
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 11,
                color: "var(--text-2)",
                userSelect: "none",
              }}
              title={`${g.name}: ${g.components.length} component${g.components.length === 1 ? "" : "s"}, ${g.distance}px → ${g.targetTag || "(no tag)"}`}
            >
              <span style={{ fontWeight: 500 }}>{g.name || "Group"}</span>
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {g.distance}px → {g.targetTag || "?"}
              </span>
            </div>
          );
        })}
        <button
          onClick={() => {
            const id = addGroup(bp.id);
            setSelectedId(id);
          }}
          style={{
            padding: "4px 10px",
            background: "rgba(255,255,255,0.03)",
            border: "1px dashed rgba(255,255,255,0.15)",
            borderRadius: 4,
            color: "var(--text-dim)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          + Add Group
        </button>
      </div>

      {selected && (
        <div style={{
          margin: "0 10px 10px",
          padding: 10,
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 4,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Name</label>
            <input
              value={selected.name}
              onChange={(e) => updateGroup(bp.id, selected.id, { name: e.target.value })}
              placeholder="e.g. Combat"
            />
          </div>
          <div className="field" style={{ margin: 0 }} title="Enable distance in world pixels. Sprites with `targetTag` closer than this enable the group's components. Hysteresis: disable is 10% farther to avoid edge-flicker.">
            <label>Distance</label>
            <input
              type="number"
              min={1}
              value={selected.distance}
              onChange={(e) => updateGroup(bp.id, selected.id, { distance: Math.max(1, Number(e.target.value) || 0) })}
            />
          </div>
          <div className="field" style={{ margin: 0 }} title="Tag whose nearest carrier is measured against. Typically 'player'.">
            <label>Target Tag</label>
            <input
              value={selected.targetTag}
              onChange={(e) => updateGroup(bp.id, selected.id, { targetTag: e.target.value })}
              list="peaky-tag-suggestions"
              placeholder="player"
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label-uppercase" style={{ fontSize: 10 }}>Components in this group</span>
            {availableKinds.length === 0 ? (
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                Add behavior components to this BP first.
              </span>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {availableKinds.map((kind) => {
                  const on = selected.components.includes(kind);
                  return (
                    <div
                      key={kind}
                      onClick={() => toggleComponent(bp.id, selected.id, kind)}
                      style={{
                        padding: "3px 8px",
                        background: on ? "rgba(245,180,71,0.18)" : "rgba(255,255,255,0.04)",
                        border: `1px solid ${on ? "var(--yellow, #f5b447)" : "rgba(255,255,255,0.08)"}`,
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 11,
                        color: on ? "var(--text)" : "var(--text-dim)",
                        userSelect: "none",
                      }}
                      title={on ? `Remove ${kind} from this group` : `Add ${kind} to this group`}
                    >
                      {kind}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              if (!window.confirm(`Delete LOD group "${selected.name}"?`)) return;
              removeGroup(bp.id, selected.id);
              setSelectedId(null);
            }}
            style={{
              alignSelf: "flex-start",
              padding: "3px 10px",
              background: "transparent",
              border: "1px solid rgba(255,80,80,0.3)",
              borderRadius: 4,
              color: "var(--red, #ff6464)",
              fontSize: 10,
              cursor: "pointer",
              marginTop: 4,
            }}
          >
            Delete Group
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Chip-based tag editor. Each tag renders as a removable pill; the
 * trailing text input accepts a new tag (commit on Enter / comma /
 * blur). Comma in the typed text splits multiple tags at once.
 *
 * Used by BP Inspector's Tags row + (future) per-instance tag override.
 * Other tag-using fields (events / actions) keep their datalist input
 * because they might also accept patterns we don't pre-author.
 */
export function TagChips({
  tags, onChange, placeholder,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = (raw: string) => {
    const additions = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => !tags.includes(t));
    if (additions.length === 0) return;
    onChange([...tags, ...additions]);
    setDraft("");
  };
  const removeAt = (i: number) => {
    onChange(tags.filter((_, j) => j !== i));
  };
  return (
    <div
      style={{
        display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center",
        padding: "3px 6px",
        background: "var(--input-bg, rgba(0,0,0,0.4))",
        border: "1px solid var(--border, rgba(255,255,255,0.1))",
        borderRadius: 4,
        minHeight: 28,
        width: "100%",
        boxSizing: "border-box",
      }}
      onClick={(e) => {
        // Click anywhere on the chip area focuses the trailing input.
        const input = (e.currentTarget.querySelector("input") as HTMLInputElement | null);
        input?.focus();
      }}
    >
      {tags.map((t, i) => (
        <span
          key={`${t}-${i}`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 6px",
            background: "var(--accent, rgba(245,207,71,0.18))",
            color: "var(--text)",
            border: "1px solid rgba(245,207,71,0.4)",
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.2,
          }}
        >
          {t}
          <button
            onClick={(e) => { e.stopPropagation(); removeAt(i); }}
            title="Remove tag"
            style={{
              padding: 0, width: 14, height: 14,
              border: "none",
              background: "transparent",
              color: "rgba(255,255,255,0.6)",
              cursor: "pointer",
              fontSize: 13,
              lineHeight: 1,
            }}
          >×</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          // If user types a comma, treat the segment before as a finished tag.
          if (v.includes(",")) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
            // Backspace on empty input removes the last chip — standard
            // chip-input pattern.
            removeAt(tags.length - 1);
          }
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        placeholder={tags.length === 0 ? (placeholder ?? "add tag…") : ""}
        style={{
          flex: "1 1 80px", minWidth: 80,
          padding: "2px 4px",
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--text)",
          fontSize: 12,
        }}
      />
    </div>
  );
}

// ─── Animator card ─────────────────────────────────────────────────────
// Custom inspector for the Animator behavior. Standard field-list UI can't
// represent a list of named keyframe animations, so this card renders:
//   1. List of authored animations (collapsible rows)
//   2. + Add Animation button (appends a new blank animation)
//   3. Expanding a row reveals: target picker, duration/loop/easing settings,
//      keyframe table (rows of time / offsetX / offsetY / scale / opacity /
//      rotation numeric fields), + Add Keyframe button.
//
// At runtime the Animator component plays these via PlayAnimatorAnim action.
// Each animation's target is the component KIND on the host BP (Widget /
// Text / SpriteRenderer / Collider) or "host" for the BP body itself.
const ANIMATOR_TARGETS: { value: string; label: string }[] = [
  { value: "host",            label: "Host (whole BP)" },
  { value: "Widget",          label: "Widget" },
  { value: "Text",            label: "Text" },
  { value: "SpriteRenderer",  label: "SpriteRenderer" },
  { value: "Collider",        label: "Collider" },
];
const ANIMATOR_EASINGS: { value: string; label: string }[] = [
  { value: "linear",  label: "Linear" },
  { value: "easeIn",  label: "Ease In" },
  { value: "easeOut", label: "Ease Out" },
  { value: "back",    label: "Back (overshoot)" },
  { value: "bounce",  label: "Bounce" },
];

/** Easing functions matching the runtime Animator. Preview accuracy is
 *  important — the scrub slider should land on the same visual result the
 *  game will render at the same time. */
function easeT(name: string, t: number): number {
  switch (name) {
    case "easeIn":  return t * t;
    case "easeOut": return 1 - (1 - t) * (1 - t);
    case "back": {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    case "bounce": {
      const n1 = 7.5625, d1 = 2.75;
      let u = 1 - t;
      let r: number;
      if (u < 1 / d1)        r = n1 * u * u;
      else if (u < 2 / d1) { u -= 1.5 / d1;  r = n1 * u * u + 0.75; }
      else if (u < 2.5 / d1) { u -= 2.25 / d1; r = n1 * u * u + 0.9375; }
      else                  { u -= 2.625 / d1; r = n1 * u * u + 0.984375; }
      return 1 - r;
    }
    default: return t;
  }
}

/** Sample an animation's keyframes at the given time, returning the
 *  interpolated transform values. Returns identity when no keyframes
 *  exist. Used by the scrub-preview slider so authors can scrub to any
 *  point in the animation and see the resulting pose live. */
/** Per-RGB-channel lerp of two tint colors (mirrors the runtime's lerpTint).
 *  A -1 ("no tint") endpoint counts as white so fades to/from it look right;
 *  both -1 → -1 (no tint at all). */
function lerpTintHex(a: number | undefined, b: number | undefined, t: number): number {
  const av = a ?? -1, bv = b ?? -1;
  if (av < 0 && bv < 0) return -1;
  const ca = av < 0 ? 0xffffff : av, cb = bv < 0 ? 0xffffff : bv;
  const ar = (ca >> 16) & 0xff, ag = (ca >> 8) & 0xff, ab = ca & 0xff;
  const br = (cb >> 16) & 0xff, bg = (cb >> 8) & 0xff, bb = cb & 0xff;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
function sampleAnimAtTime(a: { keyframes: KFRow[]; easing: string }, time: number): { offsetX: number; offsetY: number; scale: number; opacity: number; rotation: number; tint: number } {
  const kfs = a.keyframes;
  if (kfs.length === 0) return { offsetX: 0, offsetY: 0, scale: 1, opacity: 1, rotation: 0, tint: -1 };
  if (time <= kfs[0].time) return { offsetX: kfs[0].offsetX, offsetY: kfs[0].offsetY, scale: kfs[0].scale, opacity: kfs[0].opacity, rotation: kfs[0].rotation, tint: kfs[0].tint ?? -1 };
  const last = kfs[kfs.length - 1];
  if (time >= last.time) return { offsetX: last.offsetX, offsetY: last.offsetY, scale: last.scale, opacity: last.opacity, rotation: last.rotation, tint: last.tint ?? -1 };
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i], k1 = kfs[i + 1];
    if (time >= k0.time && time <= k1.time) {
      const span = k1.time - k0.time;
      const raw = span === 0 ? 0 : (time - k0.time) / span;
      const t = easeT(a.easing, raw);
      return {
        offsetX: k0.offsetX + (k1.offsetX - k0.offsetX) * t,
        offsetY: k0.offsetY + (k1.offsetY - k0.offsetY) * t,
        scale:   k0.scale   + (k1.scale   - k0.scale)   * t,
        opacity: k0.opacity + (k1.opacity - k0.opacity) * t,
        rotation: k0.rotation + (k1.rotation - k0.rotation) * t,
        tint:    lerpTintHex(k0.tint, k1.tint, t),
      };
    }
  }
  return { offsetX: 0, offsetY: 0, scale: 1, opacity: 1, rotation: 0, tint: -1 };
}

interface KFRow {
  time: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  opacity: number;
  rotation: number;
  /** Optional tint color (0xRRGGBB). White (0xffffff) / missing = no tint. */
  tint?: number;
  /** Optional signal emitted when the playhead crosses this keyframe. */
  signal?: string;
}
interface AnimRow {
  name: string;
  target: string;
  durationSec: number;
  loop: number;
  playOnStart: number;
  easing: string;
  keyframes: KFRow[];
  /** Mirror offsetX + rotation with the sprite's facing (1 = on). */
  mirror?: number;
  /** Tint mode: 1 = solid fill (white = flash), 0 / missing = multiply. */
  tintFill?: number;
}

function AnimatorCard({
  bp, behavior, onUpdate, onRemove,
}: {
  bp: { id: string; behaviors: BehaviorInstance[] };
  behavior: BehaviorInstance;
  onUpdate: (cfg: Record<string, unknown>) => void;
  onRemove?: () => void;
}) {
  const animations: AnimRow[] = Array.isArray(behavior.config.animations)
    ? (behavior.config.animations as AnimRow[])
    : [];
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** Per-animation scrub time (0..durationSec). Local state so multiple
   *  expanded rows can independently scrub without fighting each other. */
  const [scrubTime, setScrubTime] = useState<Record<number, number>>({});
  /** Which animation row currently owns the preview override — null when
   *  no scrub is active. Lets the useEffect below know which row to
   *  re-sample whenever its keyframes change, without spamming the
   *  preview from inactive rows. */
  const [activeScrub, setActiveScrub] = useState<number | null>(null);
  const setAnimatorPreview = useEditor((s) => s.setAnimatorPreview);

  // Re-sample whenever the active animation's keyframes (or easing, or
  // mirror flag) change, so editing an X/Y/Scale value in the keyframe
  // grid updates the BP preview live — without forcing the user to
  // wiggle the slider every time.
  const activeAnim = activeScrub !== null ? animations[activeScrub] : undefined;
  const activeTime = activeScrub !== null ? (scrubTime[activeScrub] ?? 0) : 0;
  useEffect(() => {
    if (activeScrub === null || !activeAnim) return;
    const sample = sampleAnimAtTime(activeAnim, activeTime);
    setAnimatorPreview({
      bpId: bp.id,
      target: activeAnim.target,
      mirror: activeAnim.mirror ?? 0,
      tintFill: activeAnim.tintFill ?? 0,
      ...sample,
    });
    // We intentionally depend on the keyframes array IDENTITY (changes
    // whenever the user edits any field via patchKF, which creates a new
    // array) plus easing, mirror, target, and the scrub time — covering
    // every input the sample depends on.
  }, [activeScrub, activeAnim?.keyframes, activeAnim?.easing, activeAnim?.mirror, activeAnim?.target, activeTime, bp.id, setAnimatorPreview, activeAnim]);

  const commit = (next: AnimRow[]) => onUpdate({ ...behavior.config, animations: next });
  const toggle = (i: number) => setExpanded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const addAnim = () => commit([...animations, {
    name: `anim${animations.length + 1}`,
    target: "host",
    durationSec: 0.6,
    loop: 0,
    playOnStart: 0,
    easing: "easeOut",
    keyframes: [
      { time: 0,   offsetX: 0, offsetY: 0,   scale: 1,   opacity: 1, rotation: 0 },
      { time: 0.6, offsetX: 0, offsetY: -20, scale: 1.2, opacity: 1, rotation: 0 },
    ],
  }]);
  const patchAnim = (i: number, patch: Partial<AnimRow>) => {
    commit(animations.map((a, idx) => idx === i ? { ...a, ...patch } : a));
  };
  const removeAnim = (i: number) => commit(animations.filter((_, idx) => idx !== i));
  const addKF = (i: number) => {
    const a = animations[i];
    const lastT = a.keyframes.length > 0 ? a.keyframes[a.keyframes.length - 1].time : 0;
    patchAnim(i, { keyframes: [...a.keyframes, { time: lastT + 0.2, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, rotation: 0 }] });
  };
  const patchKF = (i: number, ki: number, patch: Partial<KFRow>) => {
    const a = animations[i];
    patchAnim(i, { keyframes: a.keyframes.map((k, kIdx) => kIdx === ki ? { ...k, ...patch } : k) });
  };
  const removeKF = (i: number, ki: number) => {
    const a = animations[i];
    patchAnim(i, { keyframes: a.keyframes.filter((_, kIdx) => kIdx !== ki) });
  };

  // Build target options — "host" always available, plus EACH attached
  // animatable component. Multi-instance components (Text, Tracer) get
  // listed by name (e.g. "Text:hpLabel"), with a fallback bare "Text"
  // entry only when there's a single unnamed instance. Single-instance
  // components (Widget, SpriteRenderer, Collider) just show as "Widget"
  // etc. since name disambiguation isn't useful.
  const ANIMATABLE_KINDS: ReadonlySet<string> = new Set([
    "Widget", "Text", "SpriteRenderer", "Collider", "WeaponSlot",
  ]);
  const MULTI_INSTANCE_KINDS: ReadonlySet<string> = new Set(["Text", "Tracer", "ParticleEmitter", "WeaponSlot"]);
  type TargetOption = { value: string; label: string };
  const availableTargets: TargetOption[] = [{ value: "host", label: "Host (whole BP)" }];
  // Group attached behaviors by kind so we can list named instances together.
  const byKind = new Map<string, BehaviorInstance[]>();
  for (const b of bp.behaviors) {
    if (!ANIMATABLE_KINDS.has(b.kind)) continue;
    const arr = byKind.get(b.kind) ?? [];
    arr.push(b);
    byKind.set(b.kind, arr);
  }
  for (const [kind, instances] of byKind) {
    if (MULTI_INSTANCE_KINDS.has(kind)) {
      // Multi-instance kind (Text, Tracer) — ALWAYS list by name so
      // authors can target a specific instance even when there's only
      // one attached. Author names their Text "hpLabel" → dropdown
      // shows "Text: hpLabel" not just "Text". Unnamed instances fall
      // back to "Text: #N" so the dropdown stays unique.
      instances.forEach((b, idx) => {
        const nm = String(b.config?.name ?? "");
        if (nm) {
          availableTargets.push({ value: `${kind}:${nm}`, label: `${kind}: ${nm}` });
        } else if (instances.length === 1) {
          // Single unnamed instance — bare kind is fine; runtime
          // resolves to the only attached behavior.
          availableTargets.push({ value: kind, label: `${kind} (unnamed)` });
        } else {
          // Multiple unnamed instances need a suffix to be distinct.
          availableTargets.push({ value: `${kind}:#${idx + 1}`, label: `${kind}: #${idx + 1}` });
        }
      });
    } else {
      // Single-instance kind (Widget, SpriteRenderer, Collider) — name
      // disambiguation isn't useful since there's only one.
      availableTargets.push({ value: kind, label: kind });
    }
  }

  return (
    <div className="behavior-card">
      <div className="header" style={{ cursor: "default" }}>
        <span className="kind">Smart Tween</span>
        {onRemove && (
          <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ fontSize: 11, padding: "2px 6px" }} title="Remove component">×</button>
        )}
      </div>
      <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
        {animations.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", padding: 4, fontStyle: "italic" }}>
            No animations yet. Click <b>+ Add Animation</b> to author one.
          </div>
        )}
        {animations.map((a, i) => {
          const isOpen = expanded.has(i);
          // Key MUST be stable across the name being typed — using
          // `${a.name}::${i}` remounts the row on every keystroke and the
          // input loses focus after each character. Index is fine: the list
          // order is stable during edits, and controlled inputs read their
          // value from `a.name` each render so nothing goes stale.
          return (
            <div key={i} style={{
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 4,
              background: "rgba(0,0,0,0.2)",
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 6px",
                background: "rgba(255,255,255,0.04)",
                borderBottom: isOpen ? "1px solid rgba(255,255,255,0.08)" : "none",
              }}>
                <button onClick={() => toggle(i)} style={{ width: 18, height: 18, padding: 0, background: "transparent", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}>
                  {isOpen ? "▼" : "▶"}
                </button>
                <input
                  value={a.name}
                  onChange={(e) => patchAnim(i, { name: e.target.value })}
                  style={{ flex: 1, fontSize: 11, padding: "1px 4px", background: "var(--bg)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 3, color: "var(--text)" }}
                  placeholder="anim name"
                />
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>→ {a.target}</span>
                <button onClick={() => removeAnim(i)} title="Delete animation" style={{ width: 20, height: 18, padding: 0, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}>×</button>
              </div>
              {isOpen && (
                <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 70px 1fr", gap: 6, alignItems: "center", fontSize: 10 }}>
                    <label style={{ color: "var(--text-dim)" }}>Target</label>
                    <select value={a.target} onChange={(e) => patchAnim(i, { target: e.target.value })} style={{ fontSize: 11, padding: "1px 4px" }}>
                      {availableTargets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <label style={{ color: "var(--text-dim)" }}>Easing</label>
                    <select value={a.easing} onChange={(e) => patchAnim(i, { easing: e.target.value })} style={{ fontSize: 11, padding: "1px 4px" }}>
                      {ANIMATOR_EASINGS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                    </select>
                    <label style={{ color: "var(--text-dim)" }}>Loop</label>
                    <Toggle value={!!a.loop} onChange={(v) => patchAnim(i, { loop: v ? 1 : 0 })} />
                    <label style={{ color: "var(--text-dim)" }}>On Start</label>
                    <Toggle value={!!a.playOnStart} onChange={(v) => patchAnim(i, { playOnStart: v ? 1 : 0 })} />
                    <label style={{ color: "var(--text-dim)" }} title="When on, offsetX and rotation flip sign based on the host sprite's facing direction (facingScaleX). Use for a single 'swing right' animation that arcs left when the character faces left.">Mirror w/ facing</label>
                    <Toggle value={!!a.mirror} onChange={(v) => patchAnim(i, { mirror: v ? 1 : 0 })} />
                    <label style={{ color: "var(--text-dim)" }} title="How tint keyframes apply. Tint = multiply (white = no change, for colored tints). Fill = solid silhouette of the color (white = a full-white flash).">Tint Mode</label>
                    <select value={a.tintFill ? "fill" : "tint"} onChange={(e) => patchAnim(i, { tintFill: e.target.value === "fill" ? 1 : 0 })} style={{ fontSize: 11, padding: "1px 4px" }}>
                      <option value="tint">Tint (multiply)</option>
                      <option value="fill">Fill (flash)</option>
                    </select>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>
                    Keyframes
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "42px 40px 40px 40px 46px 46px 50px minmax(48px, 1fr) 18px", gap: 4, fontSize: 9, color: "var(--text-dim)", paddingLeft: 4 }}>
                    <span>Time</span>
                    <span>X</span>
                    <span>Y</span>
                    <span>Scale</span>
                    <span>Opac.</span>
                    <span>Rot.</span>
                    <span title="Tint color lerped across keyframes. White = no tint (original colors). e.g. flash red on hit, fade grey on death.">Tint</span>
                    <span title="Signal emitted when the playhead crosses this keyframe — fire a hit-signal at the exact pose (e.g. a Tracer pivoting from the weapon sprite). Empty = none.">Signal</span>
                    <span></span>
                  </div>
                  {a.keyframes.map((k, ki) => (
                    <div key={ki} style={{ display: "grid", gridTemplateColumns: "42px 40px 40px 40px 46px 46px 50px minmax(48px, 1fr) 18px", gap: 4, alignItems: "center" }}>
                      <NumberField step={0.05} value={k.time}     onChange={(n) => patchKF(i, ki, { time:     n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <NumberField step={1}    value={k.offsetX}  onChange={(n) => patchKF(i, ki, { offsetX:  n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <NumberField step={1}    value={k.offsetY}  onChange={(n) => patchKF(i, ki, { offsetY:  n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <NumberField step={0.05} value={k.scale}    onChange={(n) => patchKF(i, ki, { scale:    n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <NumberField step={0.05} value={k.opacity}  onChange={(n) => patchKF(i, ki, { opacity:  n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <NumberField step={0.05} value={k.rotation} onChange={(n) => patchKF(i, ki, { rotation: n })} style={{ fontSize: 10, padding: "1px 2px", width: "100%" }} />
                      <div style={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={typeof k.tint === "number" && k.tint >= 0}
                          onChange={(e) => patchKF(i, ki, { tint: e.target.checked ? (typeof k.tint === "number" && k.tint >= 0 ? k.tint : 0xffffff) : -1 })}
                          title="Tint this keyframe (off = no tint — use an 'off' keyframe to END a flash)."
                          style={{ width: 12, height: 12, margin: 0, flex: "0 0 auto" }}
                        />
                        <input
                          type="color"
                          disabled={!(typeof k.tint === "number" && k.tint >= 0)}
                          value={typeof k.tint === "number" && k.tint >= 0 ? "#" + (k.tint >>> 0).toString(16).padStart(6, "0").slice(-6) : "#ffffff"}
                          onChange={(e) => patchKF(i, ki, { tint: parseInt(e.target.value.slice(1), 16) })}
                          title="Tint color. White + Fill mode = full-white flash."
                          style={{ flex: 1, minWidth: 0, height: 16, padding: 0, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, cursor: "pointer", background: "transparent", opacity: typeof k.tint === "number" && k.tint >= 0 ? 1 : 0.35 }}
                        />
                      </div>
                      <SignalPicker
                        value={k.signal ?? ""}
                        onChange={(v) => patchKF(i, ki, { signal: v })}
                        placeholder="(none)"
                        mode="emit"
                        compact
                        clearable
                        forBpId={bp.id}
                        style={{ width: "100%", minWidth: 0 }}
                      />
                      <button onClick={() => removeKF(i, ki)} title="Remove keyframe" style={{ width: 18, height: 18, padding: 0, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", fontSize: 10, minWidth: 0 }}>×</button>
                    </div>
                  ))}
                  <button onClick={() => addKF(i)} style={{ alignSelf: "flex-start", padding: "2px 8px", fontSize: 10, background: "transparent", border: "1px dashed rgba(255,255,255,0.2)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer", marginTop: 4 }}>
                    + Add Keyframe
                  </button>
                  {/* Scrub timeline — interpolate keyframes at the chosen
                      time, push values into the editor store so the BP
                      preview applies them live. Disabled when there are
                      no keyframes yet (nothing to sample). */}
                  <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-dim)" }} title="Scrub through the animation to preview each frame on the BP preview. Move to the far left to clear the preview.">
                    <span style={{ minWidth: 36 }}>Preview</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.05, a.keyframes.length > 0 ? a.keyframes[a.keyframes.length - 1].time : 0)}
                      step={0.01}
                      value={scrubTime[i] ?? 0}
                      disabled={a.keyframes.length === 0}
                      onChange={(e) => {
                        const t = Number(e.target.value);
                        setScrubTime((m) => ({ ...m, [i]: t }));
                        setActiveScrub(i);
                        // Immediate push so the slider FEELS instant —
                        // the useEffect above keeps it in sync when
                        // keyframes change afterward.
                        const sample = sampleAnimAtTime(a, t);
                        setAnimatorPreview({
                          bpId: bp.id,
                          target: a.target,
                          mirror: a.mirror ?? 0,
                          tintFill: a.tintFill ?? 0,
                          ...sample,
                        });
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{(scrubTime[i] ?? 0).toFixed(2)}s</span>
                    <button
                      onClick={() => {
                        setScrubTime((m) => ({ ...m, [i]: 0 }));
                        setActiveScrub(null);
                        setAnimatorPreview(null);
                      }}
                      title="Clear preview (return to BP's default pose)"
                      style={{ padding: "1px 6px", fontSize: 10, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 3, color: "var(--text-dim)", cursor: "pointer" }}
                    >Clear</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <button
          onClick={addAnim}
          style={{ alignSelf: "flex-start", padding: "3px 10px", fontSize: 11, background: "rgba(74, 124, 209, 0.45)", border: "1px solid rgba(140, 160, 220, 0.3)", borderRadius: 4, color: "var(--text)", cursor: "pointer" }}
        >+ Add Animation</button>
      </div>
    </div>
  );
}
