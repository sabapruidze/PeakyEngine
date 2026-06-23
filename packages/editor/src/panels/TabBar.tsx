import { useEditor } from "../store";
import { ComponentIcon } from "../componentIcons";

/**
 * Top-of-workspace tab bar — UE5-style. At least one Scene tab is always
 * present (last one is non-closeable). Each opened Scene / Blueprint /
 * Sprite adds its own closable tab. Click switches the active tab; X
 * closes it (and falls back to Scene if it was active).
 */
export function TabBar() {
  const activeTab = useEditor((s) => s.activeTab);
  const setActiveTab = useEditor((s) => s.setActiveTab);
  const openSceneIds = useEditor((s) => s.openSceneIds);
  const openBlueprintIds = useEditor((s) => s.openBlueprintIds);
  const openSpriteIds = useEditor((s) => s.openSpriteIds);
  const openUIWidgetIds = useEditor((s) => s.openUIWidgetIds);
  const scenes = useEditor((s) => s.project.scenes);
  const activeSceneId = useEditor((s) => s.project.activeSceneId);
  const blueprints = useEditor((s) => s.project.blueprints);
  const sprites = useEditor((s) => s.project.sprites);
  const uiWidgets = useEditor((s) => s.project.uiWidgets);
  const setActiveScene = useEditor((s) => s.setActiveScene);
  const sceneSubTab = useEditor((s) => s.sceneSubTab);
  const setSceneSubTab = useEditor((s) => s.setSceneSubTab);
  const closeSceneTab = useEditor((s) => s.closeSceneTab);
  const closeBlueprintTab = useEditor((s) => s.closeBlueprintTab);
  const closeSpriteTab = useEditor((s) => s.closeSpriteTab);
  const closeUIWidgetTab = useEditor((s) => s.closeUIWidgetTab);

  return (
    <div className="tabbar">
      {/* Main Sheet — project-global logic. First in the strip. A sub-view of
          the scene tab, not a separate ActiveTab kind. Gets the same 🧩 icon
          as every logic sheet. */}
      <button
        className={`tab ${activeTab.kind === "scene" && sceneSubTab === "main" ? "active" : ""}`}
        onClick={() => { setActiveTab({ kind: "scene" }); setSceneSubTab("main"); }}
        title="Main Sheet — project-wide logic"
      >
        🧩 Main Sheet
      </button>

      {openSceneIds.map((id) => {
        const sc = scenes.find((s) => s.id === id);
        if (!sc) return null;
        const isActive = activeTab.kind === "scene" && activeSceneId === id && sceneSubTab === "scene";
        const canClose = openSceneIds.length > 1;
        return (
          <button
            key={id}
            className={`tab ${isActive ? "active" : ""}`}
            onClick={() => { setActiveScene(id); setSceneSubTab("scene"); }}
            title={`Edit ${sc.name}`}
          >
            <ComponentIcon kind="NewScene" size={14} style={{ marginRight: 6 }} />
            {sc.name}
            {canClose && (
              <span
                className="close"
                role="button"
                onClick={(e) => { e.stopPropagation(); closeSceneTab(id); }}
                title="Close"
              >×</span>
            )}
          </button>
        );
      })}

      {/* Divider between the scene group (Main Sheet + Scene) and the object
          tabs (blueprints / sprites / widgets). Always shown so the boundary
          reads even before any object tab is open. */}
      <div
        aria-hidden
        style={{ width: 2, alignSelf: "stretch", margin: "4px 8px", background: "rgba(0,0,0,0.28)", flexShrink: 0 }}
      />

      {openBlueprintIds.map((id) => {
        const bp = blueprints.find((b) => b.id === id);
        if (!bp) return null;
        const isActive = activeTab.kind === "blueprint" && activeTab.id === id;
        return (
          <button
            key={id}
            className={`tab ${isActive ? "active" : ""}`}
            onClick={() => setActiveTab({ kind: "blueprint", id })}
            title={`Edit ${bp.name}`}
          >
            <ComponentIcon kind="NewBlueprint" size={14} style={{ marginRight: 6 }} />
            {bp.name}
            <span
              className="close"
              role="button"
              onClick={(e) => { e.stopPropagation(); closeBlueprintTab(id); }}
              title="Close"
            >×</span>
          </button>
        );
      })}

      {openSpriteIds.map((id) => {
        const sp = sprites.find((s) => s.id === id);
        if (!sp) return null;
        const isActive = activeTab.kind === "sprite" && activeTab.id === id;
        const swatchColor = sp.animations[0]?.frames[0]?.color;
        return (
          <button
            key={id}
            className={`tab ${isActive ? "active" : ""}`}
            onClick={() => setActiveTab({ kind: "sprite", id })}
            title={`Edit ${sp.name}`}
          >
            <ComponentIcon kind="NewSprite" size={14} style={{ marginRight: 6 }} />
            {sp.name}
            <span
              className="close"
              role="button"
              onClick={(e) => { e.stopPropagation(); closeSpriteTab(id); }}
              title="Close"
            >×</span>
          </button>
        );
      })}

      {openUIWidgetIds.map((id) => {
        const w = uiWidgets.find((x) => x.id === id);
        if (!w) return null;
        const isActive = activeTab.kind === "uiwidget" && activeTab.id === id;
        return (
          <button
            key={id}
            className={`tab ${isActive ? "active" : ""}`}
            onClick={() => setActiveTab({ kind: "uiwidget", id })}
            title={`Edit ${w.name}`}
          >
            <ComponentIcon kind="NewUIWidget" size={14} style={{ marginRight: 6 }} />
            {w.name}
            <span
              className="close"
              role="button"
              onClick={(e) => { e.stopPropagation(); closeUIWidgetTab(id); }}
              title="Close"
            >×</span>
          </button>
        );
      })}
    </div>
  );
}
