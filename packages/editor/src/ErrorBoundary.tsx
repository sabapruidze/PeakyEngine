import React from "react";

/**
 * Top-level error boundary — a render throw in ANY panel otherwise white-screens
 * the whole editor with no recovery UI. The user's project is safe (folder mode
 * writes to disk; autosave snapshots exist), so the honest recovery is a reload.
 * The error text is shown so it can be reported / screenshotted.
 */
interface State { error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Peaky] editor crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        height: "100vh", display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 14, background: "#14161d", color: "#e6e9f0",
        fontFamily: "system-ui, sans-serif", padding: 24, textAlign: "center",
      }}>
        <div style={{ fontSize: 34 }}>💥</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>The editor hit an error</div>
        <div style={{ fontSize: 13, color: "#9aa3b5", maxWidth: 520, lineHeight: 1.5 }}>
          Your project is safe — folder projects are saved on disk (plus rolling
          <code style={{ margin: "0 4px" }}>.autosave</code> snapshots). Reload to continue.
        </div>
        <pre style={{
          maxWidth: 720, maxHeight: 180, overflow: "auto", fontSize: 11, textAlign: "left",
          background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6, padding: "10px 14px", color: "#e8a0a0",
        }}>{String(this.state.error.stack || this.state.error.message || this.state.error)}</pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "10px 26px", fontSize: 14, fontWeight: 700, cursor: "pointer",
            background: "#3a82e8", color: "#fff", border: "none", borderRadius: 6,
          }}
        >
          Reload editor
        </button>
      </div>
    );
  }
}
