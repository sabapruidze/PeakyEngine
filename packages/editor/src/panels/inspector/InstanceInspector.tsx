import type { CSSProperties } from "react";
import { Toggle } from "../../components/Toggle";
import { useEffect, useState } from "react";
import { useEditor } from "../../store";
import type { BlueprintInstance } from "../../project";
import { TagChips } from "./BlueprintInspector";
import { FrameThumb } from "../../components/FrameThumb";

/** Numeric input that keeps the user's RAW typing while it's still being
 *  edited — so intermediate strings like "-", "-.", or "-0." don't get
 *  killed by `Number("-") === NaN` and silently clear the field. The
 *  outer model only updates when the typed value parses to a real number
 *  (or when the input is cleared back to empty). External value changes
 *  sync back into the raw buffer. */
function NumberOverrideInput({
  value, onChange, placeholder, step = "any",
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
  step?: string;
}) {
  const [raw, setRaw] = useState<string>(value === undefined ? "" : String(value));
  useEffect(() => {
    // Only re-sync from the prop when the underlying number actually
    // changed — otherwise an intermediate string ("-") would get wiped
    // by every re-render of the parent.
    const cur = raw === "" ? undefined : Number(raw);
    if (value === undefined && raw === "") return;
    if (value !== undefined && !isNaN(cur as number) && value === cur) return;
    setRaw(value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="text" inputMode="decimal" step={step} placeholder={placeholder}
      value={raw}
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        if (next === "") {
          onChange(undefined);
          return;
        }
        // Accept intermediate-but-still-editing strings without pushing
        // them to the model. They become valid once the user finishes
        // typing the rest of the number.
        if (/^-?(\d+\.?\d*|\.\d*)?$/.test(next)) {
          const n = Number(next);
          if (!isNaN(n)) onChange(n);
        }
      }}
    />
  );
}

export function InstanceInspector() {
  const inst = useEditor((s) => s.selectedInstance());
  const uiInst = useEditor((s) => s.selectedUIInstance());
  const scene = useEditor((s) => s.activeScene());
  const viewportW = useEditor((s) => s.project.viewportWidth);
  const viewportH = useEditor((s) => s.project.viewportHeight);
  const blueprintFor = useEditor((s) => s.blueprintFor);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const sprites = useEditor((s) => s.project.sprites);
  const scenes = useEditor((s) => s.project.scenes);
  const inputActions = useEditor((s) => s.project.inputActions);
  const update = useEditor((s) => s.updateInstance);
  const remove = useEditor((s) => s.removeInstance);
  const setInstanceLayer = useEditor((s) => s.setInstanceLayer);
  const setInstanceVar = useEditor((s) => s.setInstanceVar);
  const clearInstanceVar = useEditor((s) => s.clearInstanceVar);
  const setSceneSize = useEditor((s) => s.setSceneSize);
  const setSceneBackground = useEditor((s) => s.setSceneBackground);
  const setSceneGravity = useEditor((s) => s.setSceneGravity);
  const setSceneUnboundedScroll = useEditor((s) => s.setSceneUnboundedScroll);
  const setViewportSize = useEditor((s) => s.setViewportSize);
  const openBlueprintTab = useEditor((s) => s.openBlueprintTab);
  const openUIWidgetTab = useEditor((s) => s.openUIWidgetTab);
  const updateUIWidgetInstance = useEditor((s) => s.updateUIWidgetInstance);
  const removeUIWidgetInstance = useEditor((s) => s.removeUIWidgetInstance);
  const tilemapInst = useEditor((s) => s.selectedTilemapInstance());
  const tilemaps = useEditor((s) => s.project.tilemaps ?? []);
  const tilesets = useEditor((s) => s.project.tilesets ?? []);
  const updateTilemapInstance = useEditor((s) => s.updateTilemapInstance);
  const removeTilemapInstance = useEditor((s) => s.removeTilemapInstance);
  const openTilemapTab = useEditor((s) => s.openTilemapTab);
  const tilemapPaintMode = useEditor((s) => s.tilemapPaintMode);
  const setTilemapPaintMode = useEditor((s) => s.setTilemapPaintMode);
  const placement = useEditor((s) => s.selectedSpritePlacement());
  const updateSpritePlacement = useEditor((s) => s.updateSpritePlacement);
  const removeSpritePlacement = useEditor((s) => s.removeSpritePlacement);
  const openSpriteTab = useEditor((s) => s.openSpriteTab);

  // When several items are selected, edits to SHARED properties fan out to ALL
  // of them — not just the primary. `selectedInstanceId` is the universal id
  // used by every kind (BP instance, sprite placement, UI, tilemap), so this
  // works whether the selection is BPs or bare sprites. Each per-kind update fn
  // only matches its own ids, so calling it for every selected id is safe even
  // for mixed selections. Per-instance transform fields (x/y) stay single.
  const selectedIds = (): string[] => {
    const st = useEditor.getState();
    return st.multiSelected.size > 1
      ? Array.from(st.multiSelected)
      : (st.selectedInstanceId ? [st.selectedInstanceId] : []);
  };
  const updateAll = (patch: Partial<BlueprintInstance>) => {
    for (const id of selectedIds()) update(id, patch);
  };
  const updatePlacementAll = (patch: Parameters<typeof updateSpritePlacement>[1]) => {
    for (const id of selectedIds()) updateSpritePlacement(id, patch);
  };
  const setVarAll = (name: string, value: number | string | boolean) => {
    for (const id of selectedIds()) setInstanceVar(id, name, value);
  };
  const clearVarAll = (name: string) => {
    for (const id of selectedIds()) clearInstanceVar(id, name);
  };

  // ── SpritePlacement branch ────────────────────────────────────────────────
  // Direct sprite drops — no Blueprint wrapper. Inspector shows the
  // sprite reference, transform, animation choice + start frame, flip,
  // alpha, layer, optional collider with tags.
  if (placement) {
    const sprite = sprites.find((s) => s.id === placement.spriteId);
    const animFromName = placement.animation
      ? sprite?.animations.find((a) => a.name === placement.animation)
      : undefined;
    const anim = animFromName ?? sprite?.animations[0];
    return (
      <>
        <div className="section">
          <div className="title">Sprite Placement</div>
          <div className="field">
            <label>Sprite</label>
            <button
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => { if (sprite) openSpriteTab(sprite.id); }}
            >
              {sprite?.name ?? "(missing)"} →
            </button>
          </div>
          <div className="field">
            <label title="Author-facing identifier. Logic Sheet actions like SetPlacementFrame target by this name. Optional — leave blank for pure decorations.">Name</label>
            <input type="text" value={placement.name} placeholder="(unnamed)"
              onChange={(e) => updateSpritePlacement(placement.id, { name: e.target.value })} />
          </div>
        </div>

        <div className="section">
          <div className="title">Transform</div>
          <div className="field">
            <label>X</label>
            <input type="number" value={placement.x} onChange={(e) => updateSpritePlacement(placement.id, { x: +e.target.value })} />
          </div>
          <div className="field">
            <label>Y</label>
            <input type="number" value={placement.y} onChange={(e) => updateSpritePlacement(placement.id, { y: +e.target.value })} />
          </div>
          <div className="field">
            <label>Scale X</label>
            <input type="number" step={0.1} value={placement.scaleX} onChange={(e) => updatePlacementAll({ scaleX: +e.target.value })} />
          </div>
          <div className="field">
            <label>Scale Y</label>
            <input type="number" step={0.1} value={placement.scaleY} onChange={(e) => updatePlacementAll({ scaleY: +e.target.value })} />
          </div>
          <div className="field">
            <label>Rotation (deg)</label>
            <input type="number" value={placement.rotation} onChange={(e) => updatePlacementAll({ rotation: +e.target.value })} />
          </div>
          <div className="field">
            <label>Alpha</label>
            <input type="number" step={0.05} min={0} max={1} value={placement.alpha} onChange={(e) => updatePlacementAll({ alpha: +e.target.value })} />
          </div>
          <div className="field">
            <label>Flip X</label>
            <Toggle value={placement.flipX} onChange={(v) => updatePlacementAll({ flipX: v })} />
          </div>
          <div className="field">
            <label>Flip Y</label>
            <Toggle value={placement.flipY} onChange={(v) => updatePlacementAll({ flipY: v })} />
          </div>
          <div className="field">
            <label>Layer</label>
            <select value={placement.layerId} onChange={(e) => updatePlacementAll({ layerId: e.target.value })}>
              {scene.layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Visible</label>
            <Toggle value={placement.visible !== false} onChange={(v) => updatePlacementAll({ visible: v })} />
          </div>
        </div>

        <div className="section">
          <div className="title">Animation</div>
          <div className="field">
            <label>Animation</label>
            <select
              value={placement.animation || (anim?.name ?? "")}
              onChange={(e) => updatePlacementAll({ animation: e.target.value, startFrame: 0 })}
            >
              {(sprite?.animations ?? []).map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Start Frame</label>
            <input type="number" min={0} max={Math.max(0, (anim?.frames.length ?? 1) - 1)}
              value={placement.startFrame}
              onChange={(e) => updatePlacementAll({ startFrame: +e.target.value })} />
          </div>
          <div className="field">
            <label title="When true, the animation auto-plays at scene start. When false, the sprite sits on the start frame until a Logic Sheet action triggers it.">Playing</label>
            <Toggle value={placement.playing} onChange={(v) => updatePlacementAll({ playing: v })} />
          </div>
        </div>

        <div className="section">
          <div className="title">Instance Collider</div>
          <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.4 }}>
            Settings here apply to THIS placement only. Hitbox size / shape come from the Sprite tab.
          </div>
          <div className="field">
            <label title="Master toggle. Off = no physics body at all.">Has Collider</label>
            <Toggle value={!!placement.hasCollider} onChange={(v) => updatePlacementAll({ hasCollider: v })} />
          </div>
          {placement.hasCollider && (
            <>
              {/* Instance Tags — what THIS placement carries. Other
               *  sprites react to them via HasSpriteObjectTag /
               *  OnCollide_<tag> / OnCollideWithSpriteObject. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 12px" }}>
                <label style={{ color: "var(--text-dim)", fontSize: 11 }} title="Tags carried BY this placement. Conditions like 'Sprite Object Has Tag' check these. Independent from the Collide Filter below.">Instance Tags</label>
                <TagChips
                  tags={placement.tags ?? []}
                  onChange={(tags) => updatePlacementAll({ tags })}
                />
                <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.3 }}>
                  Tags this placement carries (its identity). Other sprites read them.
                </span>
              </div>
              {/* Collide Filter — which sprites COLLIDE with this placement. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 12px" }}>
                <label style={{ color: "var(--text-dim)", fontSize: 11 }} title="Filter for which OTHER sprites can collide with this placement. Include = only listed tags collide. Exclude = listed tags are ignored.">Collide Filter</label>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => updatePlacementAll({ collideFilterMode: "include" })}
                    style={{
                      flex: 1, padding: "4px 8px", fontSize: 11,
                      background: (placement.collideFilterMode ?? "include") === "include" ? "var(--accent)" : "var(--inner)",
                      color: (placement.collideFilterMode ?? "include") === "include" ? "var(--frame)" : "var(--text-2)",
                      border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer",
                    }}
                  >Include only these</button>
                  <button
                    onClick={() => updatePlacementAll({ collideFilterMode: "exclude" })}
                    style={{
                      flex: 1, padding: "4px 8px", fontSize: 11,
                      background: placement.collideFilterMode === "exclude" ? "var(--accent)" : "var(--inner)",
                      color: placement.collideFilterMode === "exclude" ? "var(--frame)" : "var(--text-2)",
                      border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer",
                    }}
                  >Exclude these</button>
                </div>
                <TagChips
                  tags={placement.collideFilterTags ?? []}
                  onChange={(collideFilterTags) => updatePlacementAll({ collideFilterTags })}
                />
                <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.3 }}>
                  {(placement.collideFilterMode ?? "include") === "include"
                    ? (placement.collideFilterTags?.length
                        ? `Only sprites tagged with any of these collide.`
                        : `Empty list → collides with EVERY sprite.`)
                    : (placement.collideFilterTags?.length
                        ? `Sprites tagged with any of these are ignored.`
                        : `Empty list → no sprites ignored.`)}
                </span>
              </div>
              <div className="field">
                <label title="On = the placement blocks other bodies physically (a wall). Off = bodies pass through; only fires overlap triggers.">Solid</label>
                <Toggle value={!!placement.colliderBlocks}
                  onChange={(v) => updatePlacementAll({ colliderBlocks: v })} />
              </div>
            </>
          )}
        </div>

        <div className="section">
          <button style={{ width: "100%", padding: 8, color: "var(--danger, #d65a5a)" }}
            onClick={() => removeSpritePlacement(placement.id)}>
            Delete Placement
          </button>
        </div>
      </>
    );
  }

  // ── Tilemap instance branch ───────────────────────────────────────────────
  // Selection ids are shared with BP / UI instances; this branch wins when
  // the id resolves to one of the scene's tilemapInstances. Authors edit
  // position, layer, and the referenced tilemap+tileset from here.
  if (tilemapInst) {
    const map = tilemaps.find((m) => m.id === tilemapInst.tilemapId);
    const ts = map ? tilesets.find((t) => t.id === map.tilesetId) : undefined;
    const tileW = ts?.tileW ?? 32;
    const tileH = ts?.tileH ?? 32;
    return (
      <>
        <div className="section">
          <div className="title">Tilemap Instance</div>
          <div className="field">
            <label>Tilemap</label>
            <button
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => { if (map) openTilemapTab(map.id); }}
            >
              {map?.name ?? "(missing)"} →
            </button>
          </div>
          {map && (
            <div style={{ padding: "0 12px", fontSize: 10, color: "var(--text-dim)" }}>
              {map.cols}×{map.rows} cells · {map.cols * tileW}×{map.rows * tileH}px
              {ts ? ` · "${ts.name}"` : " · no tileset"}
            </div>
          )}
        </div>

        <div className="section">
          <div className="title">Transform</div>
          <div className="field">
            <label>X</label>
            <input type="number" value={tilemapInst.x} onChange={(e) => updateTilemapInstance(scene.id, tilemapInst.id, { x: +e.target.value })} title="Top-left X (Tiled convention)." />
          </div>
          <div className="field">
            <label>Y</label>
            <input type="number" value={tilemapInst.y} onChange={(e) => updateTilemapInstance(scene.id, tilemapInst.id, { y: +e.target.value })} title="Top-left Y (Tiled convention)." />
          </div>
          <div className="field">
            <label title="The SCENE layer (render parent) this tilemap is drawn on — drives parallax, depth band, and visibility. Distinct from the tilemap's INTERNAL layers (Background / Foreground / etc.), which are edited in the Tilemap tab.">Scene Layer</label>
            <select
              value={tilemapInst.layerId ?? scene.activeLayerId}
              onChange={(e) => updateTilemapInstance(scene.id, tilemapInst.id, { layerId: e.target.value })}
              title="Scene layer the tilemap is rendered on. Lower-in-the-list layers draw behind. Tilemap-internal layers are edited in the Tilemap tab."
            >
              {scene.layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · parallax ({l.parallaxX}, {l.parallaxY})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Z</label>
            <input
              type="number"
              value={tilemapInst.z ?? 0}
              onChange={(e) => updateTilemapInstance(scene.id, tilemapInst.id, { z: +e.target.value })}
              title="Sub-order WITHIN the layer. Higher = closer to camera (also gets a parallax bump)."
            />
          </div>
          <div className="field">
            <label>Alpha</label>
            <input
              type="number" min={0} max={1} step={0.05}
              value={tilemapInst.alpha ?? 1}
              onChange={(e) => updateTilemapInstance(scene.id, tilemapInst.id, { alpha: Math.max(0, Math.min(1, +e.target.value)) })}
            />
          </div>
        </div>

        <div className="section">
          <div className="title">Actions</div>
          <div className="field">
            <button
              style={{
                width: "100%",
                background: tilemapPaintMode ? "var(--yellow)" : undefined,
                color: tilemapPaintMode ? "var(--frame)" : undefined,
                fontWeight: 700,
              }}
              onClick={() => setTilemapPaintMode(!tilemapPaintMode)}
              title="Toggle scene-editor paint mode. ON = mouse on this tilemap paints; OFF = drag to move it."
            >{tilemapPaintMode ? "✓ Painting on canvas" : "✏ Paint on canvas"}</button>
          </div>
          <div className="field">
            <button
              style={{ width: "100%", color: "var(--orange)" }}
              onClick={() => removeTilemapInstance(scene.id, tilemapInst.id)}
            >Delete Tilemap Instance</button>
          </div>
        </div>
      </>
    );
  }

  // ── UI Widget instance branch ─────────────────────────────────────────────
  // Routes BEFORE the BP-instance branch since `selectedUIInstance` and
  // `selectedInstance` are mutually exclusive — exactly one returns the
  // currently-selected entity. Renders a parallel inspector with widget
  // name / position / size / layer / parent fields.
  if (uiInst) {
    const widget = uiWidgets.find((w) => w.id === uiInst.uiWidgetId);
    const currentLayerId = uiInst.layerId ?? scene.activeLayerId;
    const layer = scene.layers.find((l) => l.id === currentLayerId);
    const isUILayer = layer && layer.parallaxX === 0 && layer.parallaxY === 0;
    return (
      <>
        <div className="section">
          <div className="title">UI Widget Instance</div>
          <div className="field">
            <label>Name</label>
            <input
              value={uiInst.name ?? ""}
              placeholder={widget?.name ?? ""}
              onChange={(e) => updateUIWidgetInstance(uiInst.id, { name: e.target.value || undefined })}
            />
          </div>
          <div className="field">
            <label>Widget</label>
            <button
              style={{ width: "100%", textAlign: "left" }}
              onClick={() => { if (widget) openUIWidgetTab(widget.id); }}
            >
              {widget?.name ?? "(missing)"} →
            </button>
          </div>
        </div>

        <div className="section">
          <div className="title">Transform</div>
          <div className="field">
            <label>X</label>
            <input type="number" value={uiInst.x} onChange={(e) => updateUIWidgetInstance(uiInst.id, { x: +e.target.value })} />
          </div>
          <div className="field">
            <label>Y</label>
            <input type="number" value={uiInst.y} onChange={(e) => updateUIWidgetInstance(uiInst.id, { y: +e.target.value })} />
          </div>
          <div className="field">
            <label>W</label>
            <input
              type="number"
              value={uiInst.w ?? widget?.width ?? 0}
              onChange={(e) => updateUIWidgetInstance(uiInst.id, { w: +e.target.value })}
              title="Render-size override. Empty = widget default."
            />
          </div>
          <div className="field">
            <label>H</label>
            <input
              type="number"
              value={uiInst.h ?? widget?.height ?? 0}
              onChange={(e) => updateUIWidgetInstance(uiInst.id, { h: +e.target.value })}
            />
          </div>
          <div className="field">
            <label>Layer</label>
            <select
              value={currentLayerId}
              onChange={(e) => updateUIWidgetInstance(uiInst.id, { layerId: e.target.value })}
              title="Pick a parallax-(0,0) layer for HUD-style camera-locked UI. Other layers will scroll with the world."
            >
              {scene.layers.map((l) => {
                const isUI = l.parallaxX === 0 && l.parallaxY === 0;
                return (
                  <option key={l.id} value={l.id}>
                    {l.name}{isUI ? " · UI" : ` · parallax (${l.parallaxX}, ${l.parallaxY})`}
                  </option>
                );
              })}
            </select>
          </div>
          {!isUILayer && (
            <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--orange)", lineHeight: 1.4 }}>
              ⚠ This widget isn't on a parallax-(0,0) layer — it will scroll with the camera. Pick a UI layer for screen-locked HUDs.
            </div>
          )}
        </div>

        <div className="section">
          <div className="title">Actions</div>
          <div className="field">
            <button
              style={{ width: "100%", color: "var(--orange)" }}
              onClick={() => removeUIWidgetInstance(uiInst.id)}
            >Delete UI Instance</button>
          </div>
        </div>
      </>
    );
  }

  // No instance selected → show scene + project viewport properties so the
  // panel is always useful instead of going dark.
  if (!inst) {
    return (
      <>
        <div className="section">
          <div className="title">Scene · {scene.name}</div>
          <div className="field">
            <label>Layout W</label>
            <input
              type="number" value={scene.width}
              onChange={(e) => setSceneSize(scene.id, +e.target.value, scene.height)}
              title="World width — the area the camera can scroll across. Can be larger than the viewport."
            />
          </div>
          <div className="field">
            <label>Layout H</label>
            <input
              type="number" value={scene.height}
              onChange={(e) => setSceneSize(scene.id, scene.width, +e.target.value)}
              title="World height. Make this larger than the viewport for a vertically scrollable level."
            />
          </div>
          <div className="field">
            <label>Background</label>
            <input
              type="color"
              value={`#${(scene.backgroundColor & 0xffffff).toString(16).padStart(6, "0")}`}
              onChange={(e) => setSceneBackground(scene.id, parseInt(e.target.value.slice(1), 16))}
            />
          </div>
          <div className="field">
            <label>Gravity</label>
            <input
              type="number" step={10} value={scene.gravity}
              onChange={(e) => setSceneGravity(scene.id, +e.target.value)}
              title="Vertical gravity in px/s² (positive = down)."
            />
          </div>
          <div className="field">
            <label>Unbounded Scroll</label>
            <Toggle
              value={!!scene.unboundedScroll}
              onChange={(v) => setSceneUnboundedScroll(scene.id, v)}
              title="When checked, the camera can scroll past layout edges (no clamp). Construct-style 'unbounded scrolling'."
            />
          </div>
        </div>

        <div className="section">
          <div className="title">Project Viewport</div>
          <div className="field">
            <label>Viewport W</label>
            <input
              type="number" value={viewportW}
              onChange={(e) => setViewportSize(+e.target.value, viewportH)}
              title="Game window width — the canvas size players see. Camera frames a rectangle of this size from the layout."
            />
          </div>
          <div className="field">
            <label>Viewport H</label>
            <input
              type="number" value={viewportH}
              onChange={(e) => setViewportSize(viewportW, +e.target.value)}
              title="Game window height. Layout sizes can exceed this for scrolling levels."
            />
          </div>
          <div style={{ padding: "0 12px 8px", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Drag the dashed teal rectangle in the scene to preview which slice
            of the layout the camera will frame.
          </div>
        </div>

        <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>
          Select an instance to edit its properties.
        </div>
      </>
    );
  }

  const bp = blueprintFor(inst);
  const currentLayerId = inst.layerId ?? scene.activeLayerId;

  return (
    <>
      <div className="section">
        <div className="title">Instance</div>
        <div className="field">
          <label>Name</label>
          <input
            value={inst.name ?? ""}
            placeholder={bp?.name ?? ""}
            onChange={(e) => update(inst.id, { name: e.target.value || undefined })}
          />
        </div>
        <div className="field">
          <label>Blueprint</label>
          <button
            style={{ width: "100%", textAlign: "left" }}
            onClick={() => {
              if (bp) openBlueprintTab(bp.id);
            }}
          >
            {bp?.name ?? "(missing)"} →
          </button>
        </div>
      </div>

      <div className="section">
        <div className="title">Transform</div>
        <div className="field">
          <label>X</label>
          <input type="number" value={inst.x} onChange={(e) => update(inst.id, { x: +e.target.value })} />
        </div>
        <div className="field">
          <label>Y</label>
          <input type="number" value={inst.y} onChange={(e) => update(inst.id, { y: +e.target.value })} />
        </div>
        <div className="field">
          <label>Scale X</label>
          <input type="number" step={0.1} value={inst.scaleX ?? 1} onChange={(e) => updateAll({ scaleX: +e.target.value })} title="Visual scale. 1 = the BP's default size. The scene gizmo edits this same value. Body collision size stays the BP/Collider size." />
        </div>
        <div className="field">
          <label>Scale Y</label>
          <input type="number" step={0.1} value={inst.scaleY ?? 1} onChange={(e) => updateAll({ scaleY: +e.target.value })} />
        </div>
        <div className="field">
          <label>Angle</label>
          <input type="number" step={1} value={inst.angle ?? 0} onChange={(e) => updateAll({ angle: +e.target.value })} title="Visual rotation in degrees." />
        </div>
        <div className="field">
          <label>Layer</label>
          <select
            value={currentLayerId}
            onChange={(e) => {
              const layerId = e.target.value;
              // Fan out across every multi-selected sibling — without this,
              // the dropdown only moves the primary instance and the rest of
              // a marquee/shift selection are left behind on the old layer.
              const multi = useEditor.getState().multiSelected;
              if (multi.size > 1 && multi.has(inst.id)) {
                for (const id of multi) setInstanceLayer(scene.id, id, layerId);
              } else {
                setInstanceLayer(scene.id, inst.id, layerId);
              }
            }}
            title="Render layer — drives parallax scroll factor + z-depth"
          >
            {scene.layers.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Z</label>
          <input
            type="number"
            min={-499}
            max={499}
            step={1}
            value={inst.z ?? 0}
            onChange={(e) => {
              const raw = +e.target.value;
              if (!Number.isFinite(raw)) {
                updateAll({ z: undefined });
                return;
              }
              // Per-instance Z step is 1000 within a layer band
              // (LAYER_DEPTH_STEP / Z_STEP = 1_000_000 / 1000). The
              // symmetric range -499..+499 keeps the depth contribution
              // inside the layer band (max |z * 1000| = 499_000 < 1M),
              // so negative z stacks BELOW siblings without spilling
              // into the layer below.
              const clamped = Math.max(-499, Math.min(499, Math.floor(raw)));
              if (clamped !== raw) {
                console.warn(`[Peaky] Z-order ${raw} clamped to ${clamped} — per-layer range is -499..+499. Use a different layer for deeper stacking.`);
              }
              updateAll({ z: clamped !== 0 ? clamped : undefined });
            }}
            title="Per-instance z-order WITHIN this layer (-499..+499). Higher draws on top, negative draws below siblings. Layer order still wins — z only re-stacks instances on the same layer."
          />
        </div>
      </div>

      {bp?.classKind === "Trigger" && (
        <div className="section">
          <div className="title">Door (scene link)</div>
          <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Give this door an <b>Entry name</b>, then set a <b>Destination scene</b> + <b>door</b> to send the traveler there. Leave the destination empty to keep it a plain trigger.
          </div>
          <div className="field">
            <label title="This door's entry id — other doors target it as their Destination door. Also where a traveler arriving here lands.">Entry name</label>
            <input value={inst.door?.name ?? ""} placeholder="e.g. east"
              onChange={(e) => update(inst.id, { door: { ...inst.door, name: e.target.value } })} />
          </div>
          <div className="field">
            <label title="Set to make this trigger a DOOR — the traveler is sent to this scene on entry.">Dest scene</label>
            <select value={inst.door?.destSceneId ?? ""}
              onChange={(e) => update(inst.id, { door: { ...inst.door, destSceneId: e.target.value || undefined } })}>
              <option value="">— none (plain trigger) —</option>
              {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          {inst.door?.destSceneId && (
            <>
              <div className="field">
                <label title="Which door in the destination scene to arrive on (its Entry name).">Dest door</label>
                {(() => {
                  const dest = scenes.find((s) => s.id === inst.door!.destSceneId);
                  const names = (dest?.instances ?? []).map((i) => i.door?.name).filter((n): n is string => !!n);
                  return names.length > 0 ? (
                    <select value={inst.door?.destDoor ?? ""}
                      onChange={(e) => update(inst.id, { door: { ...inst.door, destDoor: e.target.value } })}>
                      <option value="">— pick door —</option>
                      {names.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  ) : (
                    <input value={inst.door?.destDoor ?? ""} placeholder="door entry name"
                      onChange={(e) => update(inst.id, { door: { ...inst.door, destDoor: e.target.value } })} />
                  );
                })()}
              </div>
              <div className="field">
                <label title="Which sprite tag counts as the traveler that activates this door. Default: player.">Traveler tag</label>
                <input value={inst.door?.travelerTag ?? ""} placeholder="player"
                  onChange={(e) => update(inst.id, { door: { ...inst.door, travelerTag: e.target.value || undefined } })} />
              </div>
              <div className="field">
                <label title="How the door fires: Instant = travel on touch; Delay = wait on it; Input = press a key.">Activation</label>
                <select value={inst.door?.activation ?? "instant"}
                  onChange={(e) => update(inst.id, { door: { ...inst.door, activation: e.target.value as "instant" | "delay" | "input" } })}>
                  <option value="instant">Instant (on touch)</option>
                  <option value="delay">After delay</option>
                  <option value="input">On key press</option>
                </select>
              </div>
              {inst.door?.activation === "delay" && (
                <div className="field">
                  <label title="Seconds the traveler must stand on the door before it travels.">Delay (sec)</label>
                  <input type="number" step={0.1} min={0} value={inst.door?.delaySec ?? 1}
                    onChange={(e) => update(inst.id, { door: { ...inst.door, delaySec: Math.max(0, +e.target.value) } })} />
                </div>
              )}
              {inst.door?.activation === "input" && (
                <div className="field">
                  <label title="Input action the traveler presses (while on the door) to travel. Defined in the Input Actions editor.">Key action</label>
                  {(inputActions ?? []).length > 0 ? (
                    <select value={inst.door?.inputAction ?? ""}
                      onChange={(e) => update(inst.id, { door: { ...inst.door, inputAction: e.target.value || undefined } })}>
                      <option value="">— pick action —</option>
                      {(inputActions ?? []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                    </select>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--orange)" }}>No input actions — add one in the Input Actions editor first.</span>
                  )}
                </div>
              )}
              <div className="field">
                <label title="Use the loading-screen transition (holds a cover until the destination is fully built) instead of a plain cut.">Use loader</label>
                <input type="checkbox" checked={!!inst.door?.withLoad}
                  onChange={(e) => update(inst.id, { door: { ...inst.door, withLoad: e.target.checked || undefined } })} />
              </div>
              {inst.door?.withLoad && (
                <div className="field">
                  <label title="Which scene to show as the loading screen. Default = the project's Loading Scene setting.">Loader scene</label>
                  <select value={inst.door?.loaderSceneId ?? ""}
                    onChange={(e) => update(inst.id, { door: { ...inst.door, loaderSceneId: e.target.value || undefined } })}>
                    <option value="">— project default —</option>
                    {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {bp && (
        <div className="section">
          <div className="title">From Blueprint (read-only)</div>
          <div className="field">
            <label>Size</label>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{bp.w} × {bp.h}</span>
          </div>
          <div className="field">
            <label>Components</label>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {bp.behaviors.length === 0 ? "none" : bp.behaviors.map((b) => b.kind).join(", ")}
            </span>
          </div>
        </div>
      )}

      {(() => {
        // Per-instance sprite asset / animation / frame override.
        // Applies to BOTH SpriteRenderer AND TiledBackground components —
        // a single BP with either of them gets the per-instance art-swap
        // control here. SR also exposes animation + static-frame pose.
        const sr = bp?.behaviors.find((b) => b.kind === "SpriteRenderer");
        const tb = bp?.behaviors.find((b) => b.kind === "TiledBackground");
        const component = sr ?? tb;
        if (!component) return null;
        // Resolve the effective sprite asset: instance override first,
        // then the component's BP-configured sprite.
        const effectiveSpriteId = inst.spriteId || String(component.config.spriteId ?? "");
        const spriteAsset = sprites.find((s) => s.id === effectiveSpriteId);
        if (!spriteAsset) return null;
        const bpAnimName = String(component.config.currentAnimation ?? "") || spriteAsset.animations[0]?.name || "";
        const shownAnimName = inst.spriteAnimation || bpAnimName;
        const anim = spriteAsset.animations.find((a) => a.name === shownAnimName) ?? spriteAsset.animations[0];
        // Animation + static-frame controls show whenever the chosen sprite
        // asset has at least one animation — applies equally to SR and
        // TiledBackground (both consume per-instance overrides at spawn).
        const hasAnims = !!anim && spriteAsset.animations.length > 0;
        const isStatic = typeof inst.spriteFrame === "number" && inst.spriteFrame >= 0;
        const frameIdx = (hasAnims && isStatic && anim) ? Math.max(0, Math.min(anim.frames.length - 1, inst.spriteFrame as number)) : 0;
        const toggleBtn = (active: boolean): CSSProperties => ({
          flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 4,
          background: active ? "var(--accent)" : "var(--inner)", color: active ? "#fff" : "var(--text-2)",
          border: "1px solid var(--border)",
        });
        const bpSpriteName = sprites.find((s) => s.id === String(component.config.spriteId ?? ""))?.name ?? "—";
        return (
          <div className="section">
            <div className="title">Sprite (this instance)</div>
            <div className="field">
              <label>Sprite</label>
              <select
                value={inst.spriteId ?? ""}
                onChange={(e) => updateAll({
                  spriteId: e.target.value || undefined,
                  // Clear animation override when swapping assets — the name
                  // may not exist on the new asset, and the BP default for
                  // the new asset is a more useful starting point.
                  spriteAnimation: undefined,
                  spriteFrame: undefined,
                })}
              >
                <option value="">BP default ({bpSpriteName})</option>
                {sprites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {hasAnims && (
            <div className="field">
              <label>Animation</label>
              <select
                value={inst.spriteAnimation ?? ""}
                onChange={(e) => updateAll({ spriteAnimation: e.target.value || undefined })}
              >
                <option value="">BP default ({bpAnimName || "—"})</option>
                {spriteAsset.animations.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </div>
            )}
            {hasAnims && (
            <div className="field">
              <label>Mode</label>
              <div style={{ display: "flex", gap: 6, flex: 1 }}>
                <button style={toggleBtn(!isStatic)} onClick={() => updateAll({ spriteFrame: undefined })} title="Play the animation normally at runtime.">Animate</button>
                <button style={toggleBtn(isStatic)} onClick={() => updateAll({ spriteFrame: frameIdx })} title="Freeze this instance posed on a single frame.">Static frame</button>
              </div>
            </div>
            )}
            {hasAnims && isStatic && anim && (
              <div className="field" style={{ alignItems: "flex-start" }}>
                <label>Frame</label>
                <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 4, flex: 1 }}>
                  {anim.frames.map((f, i) => (
                    <button
                      key={f.id}
                      onClick={() => updateAll({ spriteFrame: i })}
                      title={`Frame ${i}`}
                      style={{
                        flex: "0 0 auto", width: 36, height: 36, padding: 2, cursor: "pointer",
                        background: "rgba(0,0,0,0.25)", borderRadius: 4,
                        border: i === frameIdx ? "2px solid var(--accent)" : "1px solid var(--border)",
                      }}
                    >
                      <FrameThumb
                        sprite={spriteAsset}
                        frame={f}
                        style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
                        fallback={<span style={{ fontSize: 9, color: "var(--text-dim)" }}>{i}</span>}
                      />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {(() => {
        // Per-instance TiledBackground overrides — parallax / scroll /
        // size / flip / tile-axis. BP-default placeholder text shows
        // whichever the BP has configured so authors can quickly see
        // what they're overriding.
        const tb = bp?.behaviors.find((b) => b.kind === "TiledBackground");
        if (!tb) return null;
        const ov = inst.tiledBg ?? {};
        const setOv = (patch: Partial<NonNullable<typeof inst.tiledBg>>) => {
          const merged = { ...ov, ...patch };
          for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
            if (patch[k] === undefined || patch[k] === "" as unknown as undefined) delete (merged as Record<string, unknown>)[k];
          }
          updateAll({ tiledBg: Object.keys(merged).length > 0 ? merged : undefined });
        };
        const bpVal = (k: string, fb: string | number) => {
          const v = tb.config[k];
          return v === undefined || v === null || v === "" ? String(fb) : String(v);
        };
        return (
          <div className="section">
            <div className="title">Background (this instance)</div>
            <div className="field">
              <label>Mode</label>
              <select
                value={ov.mode ?? ""}
                onChange={(e) => setOv({ mode: (e.target.value || undefined) as ("followCamera" | "autoScroll" | undefined) })}
              >
                <option value="">BP default ({bpVal("mode", "followCamera")})</option>
                <option value="followCamera">Follow Camera</option>
                <option value="autoScroll">Auto Scroll</option>
              </select>
            </div>
            <div className="field">
              <label>Parallax X</label>
              <NumberOverrideInput value={ov.parallaxFactorX} step="0.05"
                placeholder={`BP: ${bpVal("parallaxFactorX", 1)}`}
                onChange={(v) => setOv({ parallaxFactorX: v })}
              />
            </div>
            <div className="field">
              <label>Parallax Y</label>
              <NumberOverrideInput value={ov.parallaxFactorY} step="0.05"
                placeholder={`BP: ${bpVal("parallaxFactorY", 1)}`}
                onChange={(v) => setOv({ parallaxFactorY: v })}
              />
            </div>
            <div className="field">
              <label>Scroll X (px/sec)</label>
              <NumberOverrideInput value={ov.scrollSpeedX}
                placeholder={`BP: ${bpVal("scrollSpeedX", 0)}`}
                onChange={(v) => setOv({ scrollSpeedX: v })}
              />
            </div>
            <div className="field">
              <label>Scroll Y (px/sec)</label>
              <NumberOverrideInput value={ov.scrollSpeedY}
                placeholder={`BP: ${bpVal("scrollSpeedY", 0)}`}
                onChange={(v) => setOv({ scrollSpeedY: v })}
              />
            </div>
            <div className="field">
              <label>Width</label>
              <NumberOverrideInput value={ov.width}
                placeholder={`BP: ${bpVal("width", 0)}`}
                onChange={(v) => setOv({ width: v })}
              />
            </div>
            <div className="field">
              <label>Height</label>
              <NumberOverrideInput value={ov.height}
                placeholder={`BP: ${bpVal("height", 0)}`}
                onChange={(v) => setOv({ height: v })}
              />
            </div>
            <div className="field">
              <label>Flip X</label>
              <Toggle value={!!ov.flipX}
                onChange={(v) => setOv({ flipX: v ? 1 : undefined })} />
            </div>
            <div className="field">
              <label>Flip Y</label>
              <Toggle value={!!ov.flipY}
                onChange={(v) => setOv({ flipY: v ? 1 : undefined })} />
            </div>
            <div className="field">
              <label>Tile X (off = no X loop)</label>
              <Toggle value={ov.tileX !== 0}
                onChange={(v) => setOv({ tileX: v ? undefined : 0 })} />
            </div>
            <div className="field">
              <label>Tile Y (off = no Y loop)</label>
              <Toggle value={ov.tileY !== 0}
                onChange={(v) => setOv({ tileY: v ? undefined : 0 })} />
            </div>
          </div>
        );
      })()}

      {bp && bp.tagsInstanceEditable && (
        <div className="section">
          <div className="title">Tags (this instance)</div>
          <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
            Extra tags for this instance — <b>added on top of</b> the BP tags (which always apply).
            Blueprint tags:{" "}
            <span style={{ color: "var(--text)" }}>
              {bp.tags.length === 0 ? "(none)" : bp.tags.join(", ")}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "4px 12px" }}>
            <TagChips
              tags={inst.tags ?? []}
              onChange={(next) => updateAll({ tags: next })}
              placeholder="add tag…"
            />
            {inst.tags !== undefined && inst.tags.length > 0 && (
              <button
                className="ghost"
                style={{ padding: "2px 8px", fontSize: 11, marginTop: 4, alignSelf: "flex-start" }}
                onClick={() => updateAll({ tags: undefined })}
                title="Clear this instance's extra tags"
              >↺ Clear extra tags</button>
            )}
          </div>
        </div>
      )}

      {bp && (() => {
        // Per-instance variable overrides — only shown for vars the BP
        // marked `instanceEditable`. Empty input falls back to the BP
        // default; explicit value (including "0") overrides. Each row
        // also has a small ↺ button to revert to the BP default.
        const editable = bp.variables.filter((v) => v.instanceEditable);
        if (editable.length === 0) return null;
        const overrides = inst.vars ?? {};
        return (
          <div className="section">
            <div className="title">Variables (this instance)</div>
            <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.4 }}>
              Override the Blueprint defaults for THIS instance only.
              Leave a field empty to use the BP default.
            </div>
            {editable.map((v) => {
              const hasOverride = v.name in overrides;
              const current = hasOverride ? overrides[v.name] : v.default;
              return (
                <div key={v.id} className="field" title={`Default: ${String(v.default)} (${v.type})`}>
                  <label>{v.name}</label>
                  <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                    {v.type === "bool" ? (
                      <Toggle
                        value={!!current}
                        onChange={(checked) => setVarAll(v.name, checked)}
                      />
                    ) : v.type === "number" ? (
                      <input
                        type="number"
                        value={current === "" ? "" : String(current)}
                        placeholder={String(v.default)}
                        onChange={(e) => {
                          const txt = e.target.value;
                          if (txt === "") { clearVarAll(v.name); return; }
                          const n = Number(txt);
                          if (Number.isFinite(n)) setVarAll(v.name, n);
                        }}
                        style={{ width: 90, fontStyle: hasOverride ? "normal" : "italic", color: hasOverride ? undefined : "var(--text-dim)" }}
                      />
                    ) : (
                      <input
                        type="text"
                        value={String(current ?? "")}
                        placeholder={String(v.default)}
                        onChange={(e) => {
                          const txt = e.target.value;
                          if (txt === "") clearVarAll(v.name);
                          else setVarAll(v.name, txt);
                        }}
                        style={{ width: 130, fontStyle: hasOverride ? "normal" : "italic", color: hasOverride ? undefined : "var(--text-dim)" }}
                      />
                    )}
                    {hasOverride && (
                      <button
                        className="ghost"
                        style={{ padding: "0 6px", fontSize: 11 }}
                        onClick={() => clearInstanceVar(inst.id, v.name)}
                        title="Revert to Blueprint default"
                      >↺</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}

      <div style={{ padding: 12 }}>
        <button className="danger" style={{ width: "100%" }} onClick={() => remove(inst.id)}>
          Delete Instance
        </button>
      </div>
    </>
  );
}
