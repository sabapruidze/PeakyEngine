import { useEffect, useMemo, useState } from "react";
import { useEditor } from "../store";
import { buildCharacter, buildNPC, type CharacterSpec, type NpcSpec } from "../recipes/characterRecipe";
import { buildItemBlueprint, pickupFolderForPlayer, type ItemSpec } from "../recipes/pickupRecipe";
import { spriteFrameDiskPath } from "../AssetStore";
import { useAssetURL } from "../useAssetURL";

/**
 * Proof-of-concept in-engine "assistant": a guided wizard that asks every
 * question needed to set up a character, pulling choices from real project
 * assets (sprites, their animations, items), then auto-builds a fully wired
 * Blueprint. No AI — deterministic Q&A → the same JSON the editor uses.
 */

const COMMON_STATES = ["idle", "walk", "run", "block", "hurt", "death", "dash", "turn_left", "turn_right", "jump", "fall", "land", "wallslide", "walljump"];
const PLATFORMER_ONLY = new Set(["jump", "fall", "land", "wallslide", "walljump"]);
// NPCs are driven by the AIBrain — states map to its AI state (IsAIState).
const AI_STATES = ["idle", "patrol", "chase", "attack", "flee", "alert", "search", "hurt", "death"];

type AttackMode = "none" | "single" | "combo";

interface WizState {
  name: string;
  kind: "player" | "npc";
  movement: "topdown" | "sidescroll";
  spriteId: string;
  states: string[];
  stateAnims: Record<string, string>;
  // NPC-only.
  targetTag: string;
  sightRange: number;
  npcHp: number;
  chaseSpeed: number;
  patrolSpeed: number;
  fleeOnDamage: boolean;
  dash: boolean;
  coyote: boolean;
  wallSlide: boolean;
  attackMode: AttackMode;
  attackAnims: string[];
  tracer: Record<string, { on: boolean; frame: number }>;
  imagePoint: string;
  range: number;
  thickness: number;
  damage: number;
  inventory: boolean;
  capacity: number;
  // Pickup item to create (when inventory is on).
  makeItem: boolean;
  makeWidget: boolean;
  itemName: string;
  itemTag: string;
  itemSpriteId: string;
  itemAnim: string;
  itemAnimated: boolean;
  itemFrame: number;
}

const SS: React.CSSProperties = { background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, color: "#e8edf4", fontSize: 13, padding: "7px 9px" };
const Q: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 10, color: "#eaf1fb" };
const HINT: React.CSSProperties = { fontSize: 11.5, color: "#7f8a9c", lineHeight: 1.5, marginTop: 6 };

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 16, cursor: "pointer", fontSize: 12.5,
      background: on ? "rgba(94,179,255,0.22)" : "rgba(255,255,255,0.05)",
      border: `1px solid ${on ? "rgba(94,179,255,0.65)" : "rgba(255,255,255,0.15)"}`,
      color: on ? "#cfe6ff" : "#cdd5e0",
    }}>{label}</button>
  );
}

function Radio({ value, opts, onChange }: { value: string; opts: { v: string; label: string; desc?: string }[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} style={{
          textAlign: "left", padding: "10px 12px", borderRadius: 8, cursor: "pointer",
          background: value === o.v ? "rgba(47,127,224,0.18)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${value === o.v ? "#3a82e6" : "rgba(255,255,255,0.14)"}`, color: "#e8edf4",
        }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.label}</div>
          {o.desc && <div style={{ fontSize: 11.5, color: "#8b96a6", marginTop: 2 }}>{o.desc}</div>}
        </button>
      ))}
    </div>
  );
}

export function AssistantModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sprites = useEditor((s) => s.project.sprites);
  const items = useEditor((s) => s.project.items ?? []);
  const addBlueprint = useEditor((s) => s.addBlueprint);
  const updateBlueprint = useEditor((s) => s.updateBlueprint);
  const addItem = useEditor((s) => s.addItem);
  const setItemIconAnim = useEditor((s) => s.setItemIconAnim);
  const setItemIconFrame = useEditor((s) => s.setItemIconFrame);
  const addUIWidget = useEditor((s) => s.addUIWidget);
  const updateUIWidget = useEditor((s) => s.updateUIWidget);

  const [step, setStep] = useState(0);
  const [done, setDone] = useState<{ spec: CharacterSpec; npc: boolean } | null>(null);
  const [w, setW] = useState<WizState>({
    kind: "player", name: "Player", movement: "topdown", spriteId: "", states: ["idle", "walk"], stateAnims: {},
    targetTag: "player", sightRange: 200, npcHp: 50, chaseSpeed: 100, patrolSpeed: 40, fleeOnDamage: false,
    dash: false, coyote: false, wallSlide: false,
    attackMode: "single", attackAnims: [], tracer: {}, imagePoint: "AttackPoint",
    range: 60, thickness: 24, damage: 10, inventory: false, capacity: 20,
    makeItem: false, makeWidget: true, itemName: "Coin", itemTag: "pickup", itemSpriteId: "", itemAnim: "", itemAnimated: false, itemFrame: 0,
  });
  const set = (patch: Partial<WizState>) => setW((p) => ({ ...p, ...patch }));
  // Reopening the assistant after a build → start a fresh wizard (was stuck on
  // the result screen, so you couldn't make a second character).
  useEffect(() => { if (open) { setStep(0); setDone(null); } }, [open]);

  const chosenSprite = useMemo(() => sprites.find((s) => s.id === w.spriteId), [sprites, w.spriteId]);
  const animNames = chosenSprite?.animations.map((a) => a.name) ?? [];

  // Item-frame thumbnail (resolved via the asset store; updates as the user
  // changes sprite/animation/frame).
  const itemSpriteObj = useMemo(() => sprites.find((s) => s.id === w.itemSpriteId), [sprites, w.itemSpriteId]);
  const itemFramePath = useMemo(() => {
    if (!itemSpriteObj) return undefined;
    const anim = itemSpriteObj.animations.find((a) => a.name === w.itemAnim) ?? itemSpriteObj.animations[0];
    const f = anim?.frames[w.itemFrame];
    return f?.imageFile ? spriteFrameDiskPath(itemSpriteObj, f.imageFile) : undefined;
  }, [itemSpriteObj, w.itemAnim, w.itemFrame]);
  const itemFrameUrl = useAssetURL(itemFramePath);

  const hasAttack = w.attackMode !== "none" && w.attackAnims.length > 0;
  // Dynamic step list — tracer/dims steps only appear when there's an attack.
  const isNpc = w.kind === "npc";
  const steps = useMemo(() => [
    "type", "basics", "sprite", "states", "attack",
    ...(hasAttack ? ["tracer", "dims"] : []),
    ...(isNpc ? ["ai"] : ["pickups", ...(w.inventory && w.makeItem ? ["item"] : [])]),
    "review",
  ], [hasAttack, isNpc, w.inventory, w.makeItem]);
  const stepKey = steps[Math.min(step, steps.length - 1)];

  if (!open) return null;

  const toggle = (arr: string[], v: string) => arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const build = () => {
    const attackAnims = w.attackMode === "none" ? [] : (w.attackMode === "single" ? w.attackAnims.slice(0, 1) : w.attackAnims);
    const tracerOnAnims = attackAnims
      .filter((a) => w.tracer[a]?.on)
      .map((a) => ({ anim: a, frame: w.tracer[a]?.frame ?? 0 }));
    const spec: CharacterSpec = {
      name: w.name || "Player", movement: w.movement, spriteId: w.spriteId,
      states: w.states, stateAnims: w.stateAnims, attackAnims, combo: w.attackMode === "combo", tracerOnAnims,
      imagePoint: w.imagePoint.trim(), range: w.range, thickness: w.thickness, damage: w.damage,
      dash: w.dash, coyote: w.coyote, wallSlide: w.wallSlide,
      inventory: w.inventory, capacity: w.capacity,
    };
    if (w.kind === "npc") {
      const npcSpec: NpcSpec = {
        name: w.name || "Enemy", movement: w.movement, spriteId: w.spriteId,
        states: w.states, stateAnims: w.stateAnims,
        attackAnim: attackAnims[0] ?? "",
        attackFrame: attackAnims[0] ? (w.tracer[attackAnims[0]]?.frame ?? 0) : 0,
        imagePoint: w.imagePoint.trim(),
        targetTag: w.targetTag || "player", sightRange: w.sightRange, attackRange: w.range,
        thickness: w.thickness, damage: w.damage, hp: w.npcHp,
        chaseSpeed: w.chaseSpeed, patrolSpeed: w.patrolSpeed, fleeOnDamage: w.fleeOnDamage,
      };
      const npcPartial = buildNPC(npcSpec);
      updateBlueprint(addBlueprint(npcPartial), npcPartial);
      setDone({ spec, npc: true });
      return;
    }
    const pickupFolders = [];
    if (w.inventory && w.makeItem && w.itemSpriteId) {
      const itemSpec: ItemSpec = {
        name: w.itemName || "Item", tag: w.itemTag || "pickup", spriteId: w.itemSpriteId,
        animation: w.itemAnim, animated: w.itemAnimated, frame: w.itemFrame,
      };
      // 1) The ITEM ASSET (data) — defines the item + its count global, which
      //    GiveItem / the inventory read. Set its icon to the chosen animation
      //    + frame (static frame, or -1 to animate) so the inventory/HUD show
      //    the right visual instead of frame 0.
      const itemId = addItem({ name: itemSpec.name, spriteId: itemSpec.spriteId });
      const itemAnimId = itemSpriteObj?.animations.find((a) => a.name === itemSpec.animation)?.id;
      if (itemAnimId) setItemIconAnim(itemId, itemAnimId);
      setItemIconFrame(itemId, itemSpec.animated ? -1 : itemSpec.frame);
      // 2) The world pickup BLUEPRINT (juice + self-destroy on touch).
      //    addBlueprint carries a fixed field set, so re-apply via updateBlueprint
      //    so the generated logicSheet + affectedByGravity actually land.
      const itemPartial = buildItemBlueprint(itemSpec);
      updateBlueprint(addBlueprint(itemPartial), itemPartial);
      // 3) Player-side OnCollide → GiveItem (gives the item asset above).
      pickupFolders.push(pickupFolderForPlayer(itemSpec));
    }
    const playerPartial = buildCharacter(spec, pickupFolders);
    const playerId = addBlueprint(playerPartial);
    updateBlueprint(playerId, playerPartial); // player BP (selected last)

    // Inventory UI widget — created as an asset and LINKED to the player BP
    // (targetBp = the player's name; the player's Inventory carries persistKey
    // "player"). Place it in a scene's UI layer to show it.
    if (w.inventory && w.makeWidget) {
      const playerName = useEditor.getState().project.blueprints.find((b) => b.id === playerId)?.name ?? (w.name || "Player");
      const widId = addUIWidget("/UI", "Inventory");
      updateUIWidget(widId, { name: `${playerName}_Inventory`, targetBp: playerName });
    }
    setDone({ spec, npc: false });
  };

  const next = () => setStep((s) => Math.min(s + 1, steps.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));
  const isLast = stepKey === "review";

  return (
    <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 9500, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onMouseDown={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: "94vw", maxHeight: "88vh", background: "#161a22", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, boxShadow: "0 12px 48px rgba(0,0,0,0.6)", color: "#e8edf4", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", background: "#1d2330", borderBottom: "1px solid rgba(255,255,255,0.1)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 700 }}>✨ Character Setup Assistant</span>
          <button onClick={onClose} style={{ background: "transparent", border: 0, color: "#9aa", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>

        {done ? (
          <Result spec={done.spec} npc={done.npc} assetOk={!w.spriteId || !!chosenSprite}
            itemName={!done.npc && w.inventory && w.makeItem && w.itemSpriteId ? (w.itemName || "Item") : undefined}
            widget={!done.npc && w.inventory && w.makeWidget}
            onClose={onClose} />
        ) : (
          <>
            <div style={{ padding: "8px 16px", fontSize: 11.5, color: "#7f8a9c", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              Step {step + 1} of {steps.length}
            </div>
            <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>
              {stepKey === "type" && (
                <div>
                  <div style={Q}>What are you building?</div>
                  <Radio value={w.kind} onChange={(v) => set({ kind: v as WizState["kind"], states: v === "npc" ? ["idle", "chase", "attack"] : ["idle", "walk"] })} opts={[
                    { v: "player", label: "Player character", desc: "Input-controlled. Movement + states + attack + (optional) inventory/pickups." },
                    { v: "npc", label: "NPC / enemy", desc: "AI-controlled (AIBrain): senses a target, chases, attacks, flees. Sight + attack tracers." },
                  ]} />
                </div>
              )}

              {stepKey === "basics" && (
                <div>
                  <div style={Q}>What's it called, and how does it move?</div>
                  <input value={w.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name" style={{ ...SS, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />
                  <Radio value={w.movement} onChange={(v) => set({ movement: v as WizState["movement"] })} opts={[
                    { v: "topdown", label: "Top-down", desc: "No gravity — walks freely in all directions (Zelda / shooter)." },
                    { v: "sidescroll", label: "Side-scroller", desc: "Gravity + jump (platformer)." },
                  ]} />
                </div>
              )}

              {stepKey === "sprite" && (
                <div>
                  <div style={Q}>Which sprite is this character?</div>
                  {sprites.length === 0 ? (
                    <div style={{ color: "#e0a84a", fontSize: 13 }}>No sprites yet — create one in the Content Browser first, or skip and set it later.</div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {sprites.map((s) => (
                        <Chip key={s.id} label={`${s.name} (${s.animations.length} anim)`} on={w.spriteId === s.id} onClick={() => set({ spriteId: s.id, attackAnims: [], tracer: {} })} />
                      ))}
                    </div>
                  )}
                  <div style={HINT}>Its animations feed the next questions (states, attack, tracer frames).</div>
                </div>
              )}

              {stepKey === "states" && (
                <div>
                  <div style={Q}>States — pick them, then map each to a sprite animation <span style={{ fontWeight: 400, color: "#8b96a6", fontSize: 12 }}>(attack is next)</span></div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    {(isNpc ? AI_STATES : COMMON_STATES.filter((s) => w.movement === "sidescroll" || !PLATFORMER_ONLY.has(s))).map((s) => (
                      <Chip key={s} label={s} on={w.states.includes(s)} onClick={() => set({ states: toggle(w.states, s) })} />
                    ))}
                  </div>
                  {w.states.length > 0 && (animNames.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                      {w.states.map((s) => (
                        <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ width: 84, fontSize: 12, color: "#cfe6ff" }}>{s}</span>
                          <span style={{ fontSize: 11, color: "#8b96a6" }}>plays</span>
                          <select value={w.stateAnims[s] ?? ""} onChange={(e) => set({ stateAnims: { ...w.stateAnims, [s]: e.target.value } })} style={{ ...SS, flex: 1, padding: "5px 8px" }}>
                            <option value="">— use “{s}” —</option>
                            {animNames.map((a) => <option key={a} value={a}>{a}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ ...HINT, marginBottom: 12 }}>Pick a sprite (step 2) to map animations — otherwise each state uses its own name.</div>
                  ))}
                  {!isNpc && w.movement === "sidescroll" && (
                    <div style={{ paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{ ...Q, fontSize: 13.5 }}>Platformer abilities</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <Chip label="Dash" on={w.dash} onClick={() => set({ dash: !w.dash })} />
                        <Chip label="Coyote time" on={w.coyote} onClick={() => set({ coyote: !w.coyote })} />
                        <Chip label="Wall slide / jump" on={w.wallSlide} onClick={() => set({ wallSlide: !w.wallSlide })} />
                      </div>
                      <div style={HINT}>These configure CharacterMovement. Wall slide/jump pairs with the <b>wallslide</b>+<b>walljump</b> states; Dash with the <b>dash</b> state — add those states above too.</div>
                    </div>
                  )}
                </div>
              )}

              {stepKey === "attack" && (
                <div>
                  <div style={Q}>How does it attack?</div>
                  <Radio value={w.attackMode} onChange={(v) => set({ attackMode: v as AttackMode })} opts={[
                    { v: "none", label: "No attack" },
                    { v: "single", label: "Single attack", desc: "One attack animation." },
                    { v: "combo", label: "Combo", desc: "A chain of attack animations." },
                  ]} />
                  {w.attackMode !== "none" && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ fontSize: 13, color: "#cfe6ff", marginBottom: 8 }}>
                        {w.attackMode === "single" ? "Pick the attack animation:" : "Pick the combo animations (in order):"}
                      </div>
                      {animNames.length === 0 ? (
                        <div style={{ color: "#e0a84a", fontSize: 12.5 }}>Pick a sprite with animations first (step 2).</div>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {animNames.map((a) => (
                            <Chip key={a} label={a} on={w.attackAnims.includes(a)}
                              onClick={() => set({ attackAnims: w.attackMode === "single" ? [a] : toggle(w.attackAnims, a) })} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {stepKey === "tracer" && (
                <div>
                  <div style={Q}>Which attack animations spawn the hit tracer — and on which frame?</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {w.attackAnims.map((a) => {
                      const t = w.tracer[a] ?? { on: true, frame: 0 };
                      return (
                        <div key={a} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", background: "rgba(255,255,255,0.04)", borderRadius: 6 }}>
                          <Chip label={a} on={t.on} onClick={() => set({ tracer: { ...w.tracer, [a]: { ...t, on: !t.on } } })} />
                          <span style={{ fontSize: 12, color: "#8b96a6" }}>on frame</span>
                          <input type="number" value={t.frame} disabled={!t.on}
                            onChange={(e) => set({ tracer: { ...w.tracer, [a]: { ...t, frame: Math.max(0, Number(e.target.value) || 0) } } })}
                            style={{ ...SS, width: 64, opacity: t.on ? 1 : 0.4 }} />
                        </div>
                      );
                    })}
                  </div>
                  <div style={HINT}>The State Machine fires the <b>atkTracer</b> signal on that frame of that animation; the Tracer listens for it.</div>
                </div>
              )}

              {stepKey === "dims" && (
                <div>
                  <div style={Q}>Attack tracer — reach, hitbox & where it pivots</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 12px", alignItems: "center", maxWidth: 420 }}>
                    <label>Image point name</label>
                    <input value={w.imagePoint} onChange={(e) => set({ imagePoint: e.target.value })} style={SS} />
                    <label>Reach (range px)</label>
                    <input type="number" value={w.range} onChange={(e) => set({ range: Number(e.target.value) || 0 })} style={SS} />
                    <label>Hitbox thickness px</label>
                    <input type="number" value={w.thickness} onChange={(e) => set({ thickness: Number(e.target.value) || 0 })} style={SS} />
                    <label>Damage</label>
                    <input type="number" value={w.damage} onChange={(e) => set({ damage: Number(e.target.value) || 0 })} style={SS} />
                  </div>
                  <div style={{ ...HINT, color: "#e0a84a", marginTop: 12 }}>
                    ⚠ The image point “{w.imagePoint || "…"}” is created on the Tracer, but <b>you must position it yourself</b> in the Sprite editor (per frame — move it left/right/up/down to the weapon tip). The tracer spawns from wherever you place it.
                  </div>
                </div>
              )}

              {stepKey === "ai" && (
                <div>
                  <div style={Q}>AI behavior</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 12px", alignItems: "center", maxWidth: 420 }}>
                    <label>Hunts (target tag)</label>
                    <input value={w.targetTag} onChange={(e) => set({ targetTag: e.target.value })} style={SS} />
                    <label>Sight range (px)</label>
                    <input type="number" value={w.sightRange} onChange={(e) => set({ sightRange: Number(e.target.value) || 0 })} style={SS} />
                    <label>Chase speed</label>
                    <input type="number" value={w.chaseSpeed} onChange={(e) => set({ chaseSpeed: Number(e.target.value) || 0 })} style={SS} />
                    <label>Patrol speed</label>
                    <input type="number" value={w.patrolSpeed} onChange={(e) => set({ patrolSpeed: Number(e.target.value) || 0 })} style={SS} />
                    <label>HP</label>
                    <input type="number" value={w.npcHp} onChange={(e) => set({ npcHp: Math.max(1, Number(e.target.value) || 1) })} style={SS} />
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <Chip label="Flee when hurt" on={w.fleeOnDamage} onClick={() => set({ fleeOnDamage: !w.fleeOnDamage })} />
                  </div>
                  <div style={HINT}>It senses sprites tagged “{w.targetTag || "player"}” via a circular <b>sight</b> tracer, chases them, and attacks with a <b>box</b> tracer (reach {w.range}px, set in the attack step). AIBrain drives the movement.</div>
                </div>
              )}

              {stepKey === "pickups" && (
                <div>
                  <div style={Q}>Can it pick up / carry items?</div>
                  <Radio value={w.inventory ? "yes" : "no"} onChange={(v) => set({ inventory: v === "yes" })} opts={[
                    { v: "no", label: "No" },
                    { v: "yes", label: "Yes — give it an Inventory", desc: "A bag it can carry items in." },
                  ]} />
                  {w.inventory && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                        <label style={{ fontSize: 13 }}>Slots (capacity)</label>
                        <input type="number" value={w.capacity} onChange={(e) => set({ capacity: Math.max(1, Number(e.target.value) || 1) })} style={{ ...SS, width: 80 }} />
                      </div>
                      <div style={HINT}>
                        Items are project assets given at runtime (Give Item / pickups), not baked into the BP.{" "}
                        {items.length > 0 ? <>Existing items: {items.map((i) => i.name).join(", ")}.</> : <>You have no items yet.</>}
                      </div>
                      <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                        <div style={{ ...Q, fontSize: 13.5 }}>Want me to also create a pickup item Blueprint?</div>
                        <Radio value={w.makeItem ? "yes" : "no"} onChange={(v) => set({ makeItem: v === "yes" })} opts={[
                          { v: "no", label: "No — I'll make items myself" },
                          { v: "yes", label: "Yes — build a full pickup (item data + world BP + wiring)", desc: "An Item asset (data/count), a pickup Blueprint that pops in & self-destroys, and player on-collide → Give Item." },
                        ]} />
                      </div>
                      <div style={{ marginTop: 14 }}>
                        <div style={{ ...Q, fontSize: 13.5 }}>Create + link an Inventory UI widget?</div>
                        <Radio value={w.makeWidget ? "yes" : "no"} onChange={(v) => set({ makeWidget: v === "yes" })} opts={[
                          { v: "yes", label: "Yes — Inventory widget linked to this player", desc: "A slot grid bound to the player's bag (targetBp). It's created as a UI asset — drop it into your scene's UI layer to show it." },
                          { v: "no", label: "No" },
                        ]} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {stepKey === "item" && (
                <div>
                  <div style={Q}>Create the pickup item</div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 12px", alignItems: "center", maxWidth: 440 }}>
                    <label>Item name</label>
                    <input value={w.itemName} onChange={(e) => set({ itemName: e.target.value })} style={SS} />
                    <label>Collide tag</label>
                    <input value={w.itemTag} onChange={(e) => set({ itemTag: e.target.value })} style={SS} />
                  </div>
                  <div style={{ ...Q, fontSize: 13.5, marginTop: 16 }}>Item sprite</div>
                  {sprites.length === 0 ? (
                    <div style={{ color: "#e0a84a", fontSize: 13 }}>No sprites — create one first.</div>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {sprites.map((s) => (
                        <Chip key={s.id} label={s.name} on={w.itemSpriteId === s.id} onClick={() => set({ itemSpriteId: s.id, itemAnim: s.animations[0]?.name ?? "" })} />
                      ))}
                    </div>
                  )}
                  {w.itemSpriteId && (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 12.5, color: "#9bd0ff" }}>Animation</span>
                        {(sprites.find((s) => s.id === w.itemSpriteId)?.animations ?? []).map((a) => (
                          <Chip key={a.id} label={a.name} on={w.itemAnim === a.name} onClick={() => set({ itemAnim: a.name })} />
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                        <Chip label="Animated" on={w.itemAnimated} onClick={() => set({ itemAnimated: true })} />
                        <Chip label="Static frame" on={!w.itemAnimated} onClick={() => set({ itemAnimated: false })} />
                        {!w.itemAnimated && (
                          <><span style={{ fontSize: 12, color: "#8b96a6" }}>frame</span>
                          <input type="number" value={w.itemFrame} onChange={(e) => set({ itemFrame: Math.max(0, Number(e.target.value) || 0) })} style={{ ...SS, width: 64 }} /></>
                        )}
                        <div style={{ width: 48, height: 48, marginLeft: 6, borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                          {itemFrameUrl
                            ? <img src={itemFrameUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", imageRendering: "pixelated" }} />
                            : <span style={{ fontSize: 9, color: "#566" }}>no img</span>}
                        </div>
                      </div>
                    </div>
                  )}
                  <div style={{ ...HINT, lineHeight: 1.6 }}>
                    This creates <b>three</b> things:<br />
                    1. an <b>Item asset “{w.itemName || "Item"}”</b> — the data definition (icon + a count global the inventory tracks); this is what Give Item adds.<br />
                    2. a world <b>pickup Blueprint</b> (sprite + collider, tag “{w.itemTag || "pickup"}”): on spawn → name + frame → pop/rise tween; on touch by player → destroy.<br />
                    3. player wiring: <b>on collide “{w.itemTag || "pickup"}”</b> → Give Item “{w.itemName || "Item"}”.
                  </div>
                </div>
              )}

              {stepKey === "review" && (
                <div>
                  <div style={Q}>Review — ready to build {isNpc ? "NPC" : "player"} “{w.name}”</div>
                  <ul style={{ fontSize: 13, lineHeight: 1.9, color: "#c7d0dc", margin: 0, paddingLeft: 18 }}>
                    <li>{w.movement === "topdown" ? "Top-down" : "Side-scroller"} movement + Collider + Damageable (HP {isNpc ? w.npcHp : 100})</li>
                    <li>Sprite: <b>{chosenSprite?.name ?? "— none picked —"}</b></li>
                    <li>States: <b>{w.states.join(", ") || "none"}</b>{hasAttack ? ", attack" : ""}{isNpc ? " (AI-driven)" : ""}</li>
                    {hasAttack
                      ? <li>Attack: <b>{w.attackMode === "combo" ? `combo (${w.attackAnims.join(" → ")})` : w.attackAnims[0]}</b>; tracer on {w.attackAnims.filter((a) => w.tracer[a]?.on).map((a) => `${a}@f${w.tracer[a]?.frame ?? 0}`).join(", ") || "no frames chosen"}</li>
                      : <li>No attack</li>}
                    {hasAttack && <li>Attack tracer box reach {w.range}px / thickness {w.thickness}px / dmg {w.damage}{!isNpc && `, pivot “${w.imagePoint}”`}</li>}
                    {isNpc && <li><b>AIBrain</b>: hunts “{w.targetTag}”, sight {w.sightRange}px, chase {w.chaseSpeed} / patrol {w.patrolSpeed}{w.fleeOnDamage ? ", flees when hurt" : ""} — plus a sight tracer</li>}
                    {!isNpc && w.inventory && <li>Inventory ({w.capacity} slots)</li>}
                    {!isNpc && w.inventory && w.makeItem && w.itemSpriteId && <li>+ Item asset <b>“{w.itemName}”</b> (data), a world pickup BP (tag {w.itemTag}, spawn/destroy logic), and player <b>on-collide → Give Item</b></li>}
                  </ul>
                </div>
              )}
            </div>

            <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", justifyContent: "space-between" }}>
              <button onClick={back} disabled={step === 0} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", color: step === 0 ? "#566" : "#cdd5e0", borderRadius: 6, padding: "7px 14px", cursor: step === 0 ? "default" : "pointer" }}>← Back</button>
              {isLast
                ? <button onClick={build} style={{ background: "#2f9e5e", border: "1px solid #43b873", color: "#fff", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontWeight: 700 }}>Build Blueprint ✓</button>
                : <button onClick={next} style={{ background: "#2f7fe0", border: "1px solid #4a93ec", color: "#fff", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontWeight: 600 }}>Next →</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Result({ spec, npc, assetOk, itemName, widget, onClose }: { spec: CharacterSpec; npc?: boolean; assetOk: boolean; itemName?: string; widget?: boolean; onClose: () => void }) {
  const comps = npc
    ? ["SpriteRenderer", spec.movement === "topdown" ? "TopdownMovement" : "CharacterMovement", "Collider", "Damageable", "Tracer (sight)", "Tracer (attack)", "AIBrain", "StateMachine"]
    : ["SpriteRenderer", spec.movement === "topdown" ? "TopdownMovement" : "CharacterMovement", "Collider", "Damageable",
      ...(spec.tracerOnAnims.length ? ["Tracer"] : []), ...(spec.inventory ? ["Inventory"] : []), "StateMachine"];
  return (
    <div style={{ padding: 18 }}>
      <div style={{ color: "#7fe0a0", fontWeight: 700, fontSize: 15, marginBottom: 12 }}>✓ Built “{spec.name}” — opened in the Blueprint editor</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {comps.map((c) => <span key={c} style={{ background: "rgba(94,179,255,0.16)", border: "1px solid rgba(94,179,255,0.4)", borderRadius: 10, padding: "2px 9px", fontSize: 12 }}>{c}</span>)}
      </div>
      {(itemName || widget) && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "#c7d0dc", lineHeight: 1.7, background: "rgba(0,0,0,0.25)", borderRadius: 8, padding: "10px 12px" }}>
          <div style={{ color: "#9bd0ff", fontWeight: 600, marginBottom: 4 }}>Also created (separate assets):</div>
          {itemName && <div>• <b>Item asset “{itemName}”</b> → Content Browser ▸ <b>Items</b> (the data + count global)</div>}
          {itemName && <div>• <b>Pickup Blueprint “{itemName}”</b> → Content Browser ▸ <b>Blueprints</b> (the world object)</div>}
          {widget && <div>• <b>Inventory widget</b> → Content Browser ▸ <b>UI</b>, linked to this player — <span style={{ color: "#e0a84a" }}>drag it into a scene's UI layer to show it</span></div>}
        </div>
      )}
      <div style={{ fontSize: 13, color: "#aab3c2", lineHeight: 1.7 }}>
        {spec.tracerOnAnims.length > 0 && (
          <div style={{ color: "#e0a84a", marginBottom: 8 }}>
            ⚠ Don't forget: position the image point <b>“{spec.imagePoint}”</b> on each attack frame in the Sprite editor — the tracer spawns from there.
          </div>
        )}
        {!assetOk && <div style={{ color: "#e0a84a", marginBottom: 8 }}>⚠ No sprite resolved — set the SpriteRenderer's sprite.</div>}
        Tune everything in the Overview inspector.
      </div>
      <div style={{ marginTop: 16, textAlign: "right" }}>
        <button onClick={onClose} style={{ background: "#2f7fe0", border: "1px solid #4a93ec", color: "#fff", borderRadius: 6, padding: "7px 18px", cursor: "pointer", fontWeight: 600 }}>Done</button>
      </div>
    </div>
  );
}
