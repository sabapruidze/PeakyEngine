import { useEffect, useRef, useState } from "react";
import { Logger, LogEntry } from "@peaky/runtime";

const MAX_ENTRIES = 500;

const LEVEL_COLORS: Record<LogEntry["level"], string> = {
  log: "var(--text)",
  warn: "var(--orange)",
  error: "var(--red)",
};

/**
 * Output Log — subscribes to the runtime Logger singleton, displays every
 * entry newest-at-bottom (terminal-style). Auto-scrolls unless the user
 * scrolled up; "Clear" wipes the buffer.
 */
export function ConsolePanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    return Logger.subscribe((entry) => {
      setEntries((cur) => (cur.length >= MAX_ENTRIES ? [...cur.slice(1), entry] : [...cur, entry]));
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop < 30;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--card)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span className="mono">{entries.length} entries</span>
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setEntries([])} style={{ fontSize: 11 }}>Clear</button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="mono"
        style={{
          flex: 1,
          overflowY: "auto",
          fontSize: 12,
          padding: "4px 0 8px",
          lineHeight: 1.55,
          background: "var(--canvas)",
          margin: "0 14px 14px",
          borderRadius: 12,
        }}
      >
        {entries.length === 0 ? (
          <div style={{ padding: "16px", color: "var(--text-muted)", fontFamily: "Inter, system-ui" }}>
            Output Log is empty. Run the game and any Log / PrintString action will show up here.
          </div>
        ) : (
          entries.map((e, i) => (
            <div
              key={i}
              style={{
                padding: "1px 14px",
                color: LEVEL_COLORS[e.level],
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              <span style={{ color: "var(--text-faint)" }}>{(e.time / 1000).toFixed(2)}s </span>
              <span style={{ color: "var(--teal)" }}>[{e.source}]</span>{" "}
              {e.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
