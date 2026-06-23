import { useEditor } from "../store";

interface IconButtonProps {
  active?: boolean;
  accent?: "yellow" | "teal" | "transparent";
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}

function IconButton({ active, accent = "transparent", title, onClick, children }: IconButtonProps) {
  const bg =
    accent === "yellow" ? "var(--yellow)" :
    accent === "teal"   ? "var(--teal)"   :
    active              ? "var(--inner-hi)" : "transparent";
  const fg =
    accent === "yellow" || accent === "teal" ? "var(--frame)" :
    active                                     ? "var(--text)"  : "var(--text-muted)";
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 36,
        height: 36,
        padding: 0,
        background: bg,
        color: fg,
        borderRadius: 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
      }}
    >
      {children}
    </button>
  );
}

/* ─── SVG icons (Lucide-style, 16px) ────────────────────────────────────── */

const Ic = {
  grid: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  folder: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h6l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
    </svg>
  ),
  blueprint: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8 7l3 9M16 7l-3 9" />
    </svg>
  ),
  input: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </svg>
  ),
  audio: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
    </svg>
  ),
  dialogFlow: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <path d="M8 11h.01M12 11h.01M16 11h.01" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 3l14 9-14 9V3z" />
    </svg>
  ),
  stop: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  ),
};

/**
 * Icon-only left rail — primary navigation. Scene / Dialog Flow switch the
 * main view; Content focuses the bottom asset dock; Inputs + Settings open
 * their modals. Every icon does something — no dead chrome.
 * (Play lives in the TopBar with its status pill, so it's not duplicated here.)
 */
export function LeftRail({
  onOpenInputActions,
  onOpenFonts,
  onOpenSettings,
}: {
  onOpenInputActions: () => void;
  onOpenFonts: () => void;
  onOpenSettings: () => void;
}) {
  const activeTab = useEditor((s) => s.activeTab);
  const setActiveTab = useEditor((s) => s.setActiveTab);
  const dockCollapsed = useEditor((s) => s.dockCollapsed);
  const setDockCollapsed = useEditor((s) => s.setDockCollapsed);

  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: 18,
        padding: "12px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {/* Nav */}
      <IconButton
        active={activeTab.kind === "scene"}
        accent={activeTab.kind === "scene" ? "yellow" : "transparent"}
        title="Scene"
        onClick={() => setActiveTab({ kind: "scene" })}
      >
        {Ic.grid}
      </IconButton>
      <IconButton
        active={!dockCollapsed}
        title={dockCollapsed ? "Show Content Browser" : "Hide Content Browser"}
        onClick={() => setDockCollapsed(!dockCollapsed)}
      >{Ic.folder}</IconButton>
      <IconButton
        active={activeTab.kind === "dialogflow"}
        accent={activeTab.kind === "dialogflow" ? "yellow" : "transparent"}
        title="Dialog Flow — wire up when/where/who triggers each dialog"
        onClick={() => setActiveTab({ kind: "dialogflow" })}
      >{Ic.dialogFlow}</IconButton>
      <IconButton title="Input Actions — name your keys (Jump, Attack…)" onClick={onOpenInputActions}>{Ic.input}</IconButton>
      <IconButton title="Fonts — upload custom fonts to use on text & labels" onClick={onOpenFonts}>
        <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1, fontFamily: "Georgia, serif" }}>Aa</span>
      </IconButton>

      <div style={{ flex: 1 }} />

      <IconButton title="Project Settings — name + game-window size" onClick={onOpenSettings}>{Ic.settings}</IconButton>
    </div>
  );
}
