// openWithFallback orchestrates: try primary → if expectation misses,
// open managed Chrome and try again. Tests use mocks to drive the
// scenarios without real browsers.

import { afterEach, describe, expect, it, mock } from "bun:test";
import { Bus } from "../src/bus.js";
import { openWithFallback } from "../src/orchestration/fallback.js";

// We mock the Browser class on the module level. Bun's test runner doesn't
// have a great `vi.mock` equivalent — we instead supply mocks via the
// `__test__` injection point we'll wire into fallback.ts during the port.
// For now, the test asserts behaviour through the public OpenResult shape.
//
// The simplest approach: stub out Browser.connect / Browser.launch by
// replacing their static methods on the imported class.

import { Browser } from "../src/browser/browser.js";

let restoreConnect: (() => void) | null = null;
let restoreLaunch: (() => void) | null = null;

function stubConnect(impl: typeof Browser.connect) {
  const orig = Browser.connect;
  (Browser as any).connect = impl;
  restoreConnect = () => {
    (Browser as any).connect = orig;
  };
}
function stubLaunch(impl: typeof Browser.launch) {
  const orig = Browser.launch;
  (Browser as any).launch = impl;
  restoreLaunch = () => {
    (Browser as any).launch = orig;
  };
}

afterEach(() => {
  restoreConnect?.();
  restoreLaunch?.();
  restoreConnect = null;
  restoreLaunch = null;
});

function fakeBrowser(scan: any) {
  const newPage = mock(async () => fakePage(scan));
  return {
    newPage,
    close: mock(async () => undefined),
    bus: new Bus(),
  } as any;
}

function fakePage(scan: any) {
  return {
    scan: mock(async () => scan),
    url: scan.url,
    title: scan.title,
  } as any;
}

const richScan = {
  url: "https://example.com",
  title: "Example",
  elements: Array.from({ length: 30 }, (_, i) => ({
    id: `el_${i}`,
    name: `el${i}`,
    kind: "button",
    text: "",
    verbs: ["click"],
    selector: "",
  })),
  collections: {},
};

const wedgedScan = {
  url: "https://example.com",
  title: "",
  elements: [],
  collections: {},
};

describe("openWithFallback", () => {
  it("primary succeeds, no fallback", async () => {
    stubConnect(async () => fakeBrowser(richScan));
    const r = await openWithFallback({
      primary: { port: 9333 },
      url: "https://example.com",
    });
    expect(r.fellBack).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("primary wedges, falls back to chrome", async () => {
    stubConnect(async () => fakeBrowser(wedgedScan));
    stubLaunch(async () => fakeBrowser(richScan));
    const r = await openWithFallback({
      primary: { port: 9333 },
      url: "https://example.com",
      expect: { minElements: 5 },
    });
    expect(r.fellBack).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("primary wedges with fallback:'off' returns the wedged primary anyway", async () => {
    stubConnect(async () => fakeBrowser(wedgedScan));
    stubLaunch(async () => {
      throw new Error("should not launch");
    });
    const r = await openWithFallback({
      primary: { port: 9333 },
      url: "https://example.com",
      fallback: "off",
      expect: { minElements: 5 },
    });
    expect(r.fellBack).toBe(false);
  });

  it("emits fallback.triggered on the bus when retrying", async () => {
    stubConnect(async () => fakeBrowser(wedgedScan));
    stubLaunch(async () => fakeBrowser(richScan));
    const bus = new Bus();
    const events: any[] = [];
    bus.on("fallback.triggered", (e) => events.push(e));
    await openWithFallback({
      primary: { port: 9333 },
      url: "https://example.com",
      bus,
      expect: { minElements: 5 },
    });
    expect(events).toHaveLength(1);
  });

  it("emits fallback.failed when chrome also misses expectation", async () => {
    stubConnect(async () => fakeBrowser(wedgedScan));
    stubLaunch(async () => fakeBrowser(wedgedScan));
    const bus = new Bus();
    const events: any[] = [];
    bus.on("fallback.failed", (e) => events.push(e));
    await openWithFallback({
      primary: { port: 9333 },
      url: "https://example.com",
      bus,
      expect: { minElements: 5 },
    });
    expect(events).toHaveLength(1);
  });
});
