import { useEditor } from "../store";
import type { ProjectSampling } from "../project";

interface Props {
  onClose: () => void;
}

/**
 * Project-wide settings modal: project name + game-window (viewport) size.
 * These were previously only reachable via the JSON file (name) or the
 * Inspector's no-selection state (viewport) — surfaced here so the Settings
 * rail icon has a real home.
 */
export function SettingsPanel({ onClose }: Props) {
  const name = useEditor((s) => s.project.name);
  const viewportWidth = useEditor((s) => s.project.viewportWidth);
  const viewportHeight = useEditor((s) => s.project.viewportHeight);
  const sampling = useEditor((s) => s.project.sampling ?? "bilinear");
  const cullDistanceMultiplier = useEditor((s) => s.project.cullDistanceMultiplier ?? 1.5);
  const spawnBudgetPerFrame = useEditor((s) => s.project.spawnBudgetPerFrame ?? 0);
  const loadingSceneId = useEditor((s) => s.project.loadingSceneId ?? "");
  const scenes = useEditor((s) => s.project.scenes);
  const setProjectName = useEditor((s) => s.setProjectName);
  const setViewportSize = useEditor((s) => s.setViewportSize);
  const setSampling = useEditor((s) => s.setSampling);
  const setCullDistanceMultiplier = useEditor((s) => s.setCullDistanceMultiplier);
  const setSpawnBudgetPerFrame = useEditor((s) => s.setSpawnBudgetPerFrame);
  const setLoadingSceneId = useEditor((s) => s.setLoadingSceneId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <header>
          <span>Project Settings</span>
          <button onClick={onClose} style={{ fontSize: 11 }}>Close</button>
        </header>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Project name</span>
            <input
              value={name}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="My Game"
              style={{ fontSize: 13, fontWeight: 500 }}
            />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Game window (viewport)</span>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
                W
                <input
                  type="number"
                  min={1}
                  value={viewportWidth}
                  onChange={(e) => setViewportSize(Number(e.target.value), viewportHeight)}
                  style={{ width: 90 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
                H
                <input
                  type="number"
                  min={1}
                  value={viewportHeight}
                  onChange={(e) => setViewportSize(viewportWidth, Number(e.target.value))}
                  style={{ width: 90 }}
                />
              </label>
            </div>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              The size of the rendered game window — the camera scrolls across the larger scene layout.
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Sampling</span>
            <select
              value={sampling}
              onChange={(e) => setSampling(e.target.value as ProjectSampling)}
              style={{ fontSize: 13 }}
            >
              <option value="nearest">Nearest (pixel art — crisp)</option>
              <option value="bilinear">Bilinear (smooth)</option>
              <option value="trilinear">Trilinear (smooth + mipmaps)</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              How textures are filtered when scaled. Pick <strong>Nearest</strong> for pixel art so
              sprites stay sharp instead of blurring when scaled up. Applies on the next Play.
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Viewport cull distance</span>
            <select
              value={String(cullDistanceMultiplier)}
              onChange={(e) => setCullDistanceMultiplier(Number(e.target.value))}
              style={{ fontSize: 13 }}
            >
              <option value="1">Aggressive — viewport size (max savings, pop-in risk)</option>
              <option value="1.2">Tight — 20% buffer past viewport</option>
              <option value="1.5">Balanced — 50% buffer (recommended)</option>
              <option value="2">Generous — 2× viewport (no pop-in, less savings)</option>
              <option value="3">Very generous — 3× viewport</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              Off-screen NPCs whose BP <strong>Culling</strong> is Throttled or Freeze stop running their
              update loops past this buffer ring around the camera. Bigger = more NPCs alive
              off-screen (smoother pop-in, less CPU savings). Only affects BPs that opted in to
              culling — &ldquo;Never&rdquo; BPs always run regardless.</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Loading scene</span>
            <select
              value={loadingSceneId}
              onChange={(e) => setLoadingSceneId(e.target.value)}
              style={{ fontSize: 13 }}
            >
              <option value="">(none — GoToLayoutWithLoad falls back to plain GoToLayout)</option>
              {scenes.map((sc) => (
                <option key={sc.id} value={sc.id}>{sc.name}</option>
              ))}
            </select>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              When set, the <code>GoToLayoutWithLoad</code> action routes through this scene while it
              loads the destination's assets. Wire its Logic Sheet against
              <code>OnLoadStart</code> / <code>OnLoadProgress</code> / <code>OnLoadComplete</code>
              to drive a progress bar, spinner, or tip text. Leave unset to disable the feature
              (the action then behaves like a plain <code>GoToLayout</code>).
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label-uppercase">Spawn budget (per frame)</span>
            <select
              value={String(spawnBudgetPerFrame)}
              onChange={(e) => setSpawnBudgetPerFrame(Number(e.target.value))}
              style={{ fontSize: 13 }}
            >
              <option value="0">Off (instant — brief freeze at scene start, no slow ramp)</option>
              <option value="25">25 / frame (very gentle ramp)</option>
              <option value="50">50 / frame (gentle ramp)</option>
              <option value="100">100 / frame (faster ramp)</option>
              <option value="200">200 / frame (almost instant)</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
              When <strong>Off</strong>: spawns are synchronous — a 1500-NPC <code>OnSceneStart → Repeat → CreateObject</code>
              loop blocks for ~2s during scene start (looks like a brief gray screen), then runs at full FPS.
              When <strong>&gt; 0</strong>: spawns past N per frame queue and drain over time — the scene starts
              immediately but FPS dips while NPCs ramp in. Most authors want <strong>Off</strong>.
              FireProjectile bypasses this regardless so bullets always fire same-frame.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
