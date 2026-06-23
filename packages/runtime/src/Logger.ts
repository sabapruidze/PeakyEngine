/**
 * In-game logging service. Drives the editor's Output Log panel and any future
 * on-screen overlay. Subscribers receive entries in the order they're emitted;
 * the Logger itself does not buffer beyond a small history (consumers buffer).
 *
 * Runtime emits via `Logger.log({...})` from the Log / PrintString actions.
 * The editor subscribes via `Logger.subscribe(fn)` at app startup.
 */

export type LogLevel = "log" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  /** Origin tag — e.g. "Movement/Idle", "Event", "Graph", "Player". */
  source: string;
  message: string;
  /** ms since page load (performance.now()). Used for ordering + display. */
  time: number;
}

type Subscriber = (entry: LogEntry) => void;

const subscribers = new Set<Subscriber>();

export const Logger = {
  log(entry: Omit<LogEntry, "time"> & Partial<Pick<LogEntry, "time">>): void {
    const full: LogEntry = {
      level: entry.level,
      source: entry.source,
      message: entry.message,
      time: entry.time ?? performance.now(),
    };
    for (const fn of subscribers) {
      try { fn(full); } catch { /* subscriber threw — swallow so other subscribers still fire */ }
    }
  },

  subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  },
};
