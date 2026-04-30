// Frame discovery: refreshFrames walks Target.getTargets, attaches to
// new iframe targets, prunes stale ones, emits bus events.

import { describe, expect, it } from "bun:test";
import { Bus } from "../src/bus.js";
import { refreshFrames } from "../src/page/frame.js";
import { Session } from "../src/cdp/session.js";
import { FakeCDP, asCdp } from "./fixtures/fake-cdp.js";

function setup(targets: any[], existing: Map<string, any> = new Map()) {
  const bus = new Bus();
  const cdp = new FakeCDP({
    "Target.getTargets": () => ({ targetInfos: targets }),
    "Target.attachToTarget": (params: any) => ({ sessionId: `S-${params.targetId}` }),
    "Page.addScriptToEvaluateOnNewDocument": () => ({ identifier: "x" }),
  });
  const browser = {
    cdp: asCdp(cdp),
    bus,
    shimEnabled: true,
    isObscura: true,
  } as any;
  const page = {
    iframes: existing,
    mainFrame: { targetId: "MAIN", url: "https://parent.com", session: new Session(asCdp(cdp), "MAIN") },
    browser,
  } as any;
  return { bus, cdp, browser, page };
}

describe("refreshFrames", () => {
  it("attaches to new iframe targets and registers them on the page", async () => {
    const { page } = setup([
      { type: "iframe", targetId: "F1", url: "https://child.example.com/x" },
      { type: "iframe", targetId: "F2", url: "https://other.example.com/y" },
      { type: "page", targetId: "MAIN", url: "https://parent.com" },
    ]);
    await refreshFrames(page.browser, page);
    expect(page.iframes.size).toBe(2);
    expect(page.iframes.has("F1")).toBe(true);
    expect(page.iframes.has("F2")).toBe(true);
  });

  it("does not re-attach iframes already in the map", async () => {
    const existing = new Map<string, any>([
      ["F1", { targetId: "F1", session: new Session({} as any, "PRE-EXISTING-S"), url: "u" }],
    ]);
    const { cdp, page } = setup(
      [{ type: "iframe", targetId: "F1", url: "u" }],
      existing
    );
    await refreshFrames(page.browser, page);
    expect(cdp.callsFor("Target.attachToTarget")).toHaveLength(0);
  });

  it("prunes frames whose targets disappeared", async () => {
    const existing = new Map<string, any>([
      ["F-OLD", { targetId: "F-OLD", session: new Session({} as any, "S"), url: "u" }],
    ]);
    const { page } = setup([], existing);
    await refreshFrames(page.browser, page);
    expect(page.iframes.has("F-OLD")).toBe(false);
  });

  it("registers the shim + stealth scripts on each new iframe session", async () => {
    const { cdp, page } = setup([
      { type: "iframe", targetId: "F1", url: "u" },
    ]);
    await refreshFrames(page.browser, page);
    const preloads = cdp.callsFor("Page.addScriptToEvaluateOnNewDocument");
    // At least two: shim + stealth.
    expect(preloads.length).toBeGreaterThanOrEqual(2);
    expect(preloads.every((c) => c.sessionId === "S-F1")).toBe(true);
  });

  it("emits iframe.attached when a new frame is attached", async () => {
    const events: any[] = [];
    const { page, bus } = setup([
      { type: "iframe", targetId: "F1", url: "https://child.example.com" },
    ]);
    bus.on("iframe.attached", (e) => events.push(e));
    await refreshFrames(page.browser, page);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "iframe.attached", targetId: "F1" });
  });

  it("emits iframe.detached when pruning", async () => {
    const events: any[] = [];
    const existing = new Map<string, any>([
      ["F-OLD", { targetId: "F-OLD", session: new Session({} as any, "S"), url: "u" }],
    ]);
    const { page, bus } = setup([], existing);
    bus.on("iframe.detached", (e) => events.push(e));
    await refreshFrames(page.browser, page);
    expect(events).toEqual([{ kind: "iframe.detached", targetId: "F-OLD" }]);
  });
});
