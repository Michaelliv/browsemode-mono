import { describe, expect, it, mock } from "bun:test";
import { Bus, type BusEvent } from "../src/bus.js";

describe("Bus", () => {
  it("delivers events to subscribers of matching kind", () => {
    const bus = new Bus();
    const seen: BusEvent[] = [];
    bus.on("iframe.attached", (e) => seen.push(e));
    bus.emit({ kind: "iframe.attached", targetId: "T1", url: "https://a.com" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      kind: "iframe.attached",
      targetId: "T1",
      url: "https://a.com",
    });
  });

  it("does not deliver events to listeners of a different kind", () => {
    const bus = new Bus();
    const wrong = mock(() => {});
    bus.on("iframe.detached", wrong);
    bus.emit({ kind: "iframe.attached", targetId: "T1", url: "x" });
    expect(wrong).not.toHaveBeenCalled();
  });

  it("supports multiple listeners on the same kind", () => {
    const bus = new Bus();
    const a = mock(() => {});
    const b = mock(() => {});
    bus.on("nav.timeout", a);
    bus.on("nav.timeout", b);
    bus.emit({
      kind: "nav.timeout",
      url: "u",
      waitUntil: "load",
      timeoutMs: 1,
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("returns an unsubscribe function from on()", () => {
    const bus = new Bus();
    const fn = mock(() => {});
    const off = bus.on("iframe.attached", fn);
    off();
    bus.emit({ kind: "iframe.attached", targetId: "T", url: "u" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("clear() drops all listeners", () => {
    const bus = new Bus();
    const fn = mock(() => {});
    bus.on("iframe.attached", fn);
    bus.clear();
    bus.emit({ kind: "iframe.attached", targetId: "T", url: "u" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("a listener throwing does not stop other listeners", () => {
    const bus = new Bus();
    const ok = mock(() => {});
    bus.on("iframe.attached", () => {
      throw new Error("boom");
    });
    bus.on("iframe.attached", ok);
    bus.emit({ kind: "iframe.attached", targetId: "T", url: "u" });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
