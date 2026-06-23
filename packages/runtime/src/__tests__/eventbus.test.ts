import { describe, it, expect } from "vitest";
import { EventBus } from "../EventBus";

describe("EventBus carryover", () => {
  it("current frame: both firedThisFrame and firedExactlyThisFrame are true", () => {
    const bus = new EventBus();
    bus.emit("X");
    expect(bus.firedThisFrame("X")).toBe(true);
    expect(bus.firedExactlyThisFrame("X")).toBe(true);
  });

  it("after one flush: 1-frame carryover keeps firedThisFrame, drops firedExactlyThisFrame", () => {
    const bus = new EventBus();
    bus.emit("X");
    bus.flush();
    expect(bus.firedThisFrame("X")).toBe(true);
    expect(bus.firedExactlyThisFrame("X")).toBe(false);
  });

  it("after a second flush: the event is fully dropped", () => {
    const bus = new EventBus();
    bus.emit("X");
    bus.flush();
    bus.flush();
    expect(bus.firedThisFrame("X")).toBe(false);
    expect(bus.firedExactlyThisFrame("X")).toBe(false);
  });
});

describe("EventBus listener snapshot during emit", () => {
  it("a listener that unsubscribes a sibling mid-emit does NOT skip it", () => {
    const bus = new EventBus();
    const fired: string[] = [];
    let offB: () => void = () => {};
    bus.on("E", () => { fired.push("A"); offB(); });
    offB = bus.on("E", () => { fired.push("B"); });
    bus.emit("E");
    // B was unsubscribed by A mid-emit, but the snapshot taken before the loop
    // means it still fires this round.
    expect(fired).toEqual(["A", "B"]);
  });

  it("a throwing listener does not kill its siblings", () => {
    const bus = new EventBus();
    const fired: string[] = [];
    bus.on("E", () => { throw new Error("boom"); });
    bus.on("E", () => { fired.push("survived"); });
    bus.emit("E");
    expect(fired).toEqual(["survived"]);
  });

  it("off() unsubscribes for the NEXT emit", () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on("E", () => { n++; });
    bus.emit("E");
    off();
    bus.emit("E");
    expect(n).toBe(1);
  });
});
