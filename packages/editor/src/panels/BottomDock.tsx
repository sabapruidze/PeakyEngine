import { useEffect, useState } from "react";
import { useEditor } from "../store";
import { ContentBrowser } from "./ContentBrowser";
import { ConsolePanel } from "./ConsolePanel";
import { Logger } from "@peaky/runtime";

/** Bottom card hosting Content Browser and Output Log via a seg control.
 *  The active tab lives in the store so the left rail can focus it. */
export function BottomDock() {
  const tab = useEditor((s) => s.dockTab);
  const setTab = useEditor((s) => s.setDockTab);
  // Unread warn/error badge — increments whenever the Logger fires a non-log
  // entry while the Output Log tab ISN'T focused. Without this, a failed
  // tile action (e.g. "tilemap not found") logs silently and authors don't
  // know to check the console. Resets when the tab is opened.
  const [unreadWarns, setUnreadWarns] = useState(0);
  useEffect(() => {
    const unsubscribe = Logger.subscribe((entry) => {
      if (entry.level === "log") return;
      setUnreadWarns((n) => n + 1);
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (tab === "console" && unreadWarns > 0) setUnreadWarns(0);
  }, [tab, unreadWarns]);

  return (
    <div
      className="card-flush"
      style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}
    >
      <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <div className="seg">
          <button className={tab === "content" ? "active primary" : ""} onClick={() => setTab("content")}>
            Content
          </button>
          <button
            className={tab === "console" ? "active" : ""}
            onClick={() => setTab("console")}
            style={{ position: "relative" }}
          >
            Output Log
            {unreadWarns > 0 && (
              <span
                title={`${unreadWarns} new warning${unreadWarns === 1 ? "" : "s"}`}
                style={{
                  marginLeft: 6, padding: "1px 6px",
                  background: "var(--orange, #e07474)", color: "#fff",
                  borderRadius: 8, fontSize: 9, fontWeight: 700,
                  minWidth: 14, display: "inline-block", textAlign: "center",
                }}
              >{unreadWarns > 99 ? "99+" : unreadWarns}</span>
            )}
          </button>
        </div>
      </div>
      <div style={{ minHeight: 0 }}>
        {tab === "content" && <ContentBrowser />}
        {tab === "console" && <ConsolePanel />}
      </div>
    </div>
  );
}
