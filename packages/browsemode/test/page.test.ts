// Page tests focus on dispatch routing, sugar wrappers, and verb registry
// integration. They use a fake CDP/Session so we don't need a real browser.

import { describe, expect, it, mock } from "bun:test";
import type { Browser } from "../src/browser/browser.js";
import { Bus } from "../src/bus.js";
import { Session } from "../src/cdp/session.js";
import { Page } from "../src/page/page.js";
import { asCdp, FakeCDP } from "./fixtures/fake-cdp.js";

function makePage() {
  const cdp = new FakeCDP();
  // Runtime.evaluate stub: SCAN_SCRIPT returns a valid (empty) ScanResult
  // shape; everything else (verb expressions) returns undefined value.
  cdp.setHandler("Runtime.evaluate", (params: any) => {
    if (
      typeof params.expression === "string" &&
      params.expression.includes("data-browsemode")
    ) {
      return {
        result: {
          value: {
            url: "about:blank",
            title: "",
            elements: [],
            collections: {},
          },
        },
      };
    }
    return { result: { value: undefined } };
  });
  const session = new Session(asCdp(cdp), "S1");
  // Build a minimal stub Browser so Page can reach it for tabs.* dispatch.
  const browser = {
    cdp: asCdp(cdp),
    bus: new Bus(),
    shimEnabled: false,
    settleMs: 0,
    activePage: null as any,
    _dispatchTabs: mock(async (verb: string, args: any) => ({ verb, args })),
  } as unknown as Browser;
  return { cdp, browser, session };
}

describe("Page.dispatch routing", () => {
  it("routes 'tabs.<verb>' to Browser._dispatchTabs", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    await page.dispatch("tabs.list");
    expect((browser as any)._dispatchTabs).toHaveBeenCalledWith(
      "list",
      undefined,
    );
  });

  it("routes 'verb' (single-segment) to a page verb handler", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    // 'list' is a page verb — should not throw on an empty catalog.
    const r = await page.dispatch("list");
    expect(Array.isArray(r)).toBe(true);
  });

  it("routes 'name.verb' to the corresponding element", async () => {
    const { browser, cdp } = makePage();
    const page = await constructPage(browser);
    // Inject a button manually so dispatch finds it.
    page.elements.set("loginButton", {
      id: "el_0",
      name: "loginButton",
      kind: "button",
      text: "Log in",
      verbs: ["click", "text"],
      selector: "document.querySelector('[data-browsemode=\"el_0\"]')",
    });
    await page.dispatch("loginButton.click");
    // click verb evaluates an expression via Runtime.evaluate.
    expect(cdp.callsFor("Runtime.evaluate").length).toBeGreaterThan(0);
  });

  it("throws on an unknown name with a helpful message", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    await expect(page.dispatch("nonexistent.click")).rejects.toThrow(
      /nonexistent|unknown/i,
    );
  });

  it("throws on an unknown page verb with a helpful message", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    await expect(page.dispatch("totallyMadeUpVerb")).rejects.toThrow(
      /unknown|verb/i,
    );
  });

  it("auto-rescans after a navigating element verb", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    page.settleMs = 0;
    page.elements.set("submitButton", {
      id: "el_0",
      name: "submitButton",
      kind: "button",
      text: "",
      verbs: ["click"],
      selector: "document.querySelector('[data-browsemode=\"el_0\"]')",
    });
    const scanSpy = mock(async () => ({
      url: "x",
      title: "y",
      elements: [],
      collections: {},
    }));
    (page as any).scan = scanSpy;
    await page.dispatch("submitButton.click");
    expect(scanSpy).toHaveBeenCalled();
  });

  it("does not auto-rescan after non-navigating verbs (text)", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    page.elements.set("titleLink", {
      id: "el_0",
      name: "titleLink",
      kind: "link",
      text: "Hello",
      verbs: ["click", "text", "href"],
      selector: "document.querySelector('[data-browsemode=\"el_0\"]')",
    });
    const scanSpy = mock(async () => ({
      url: "x",
      title: "y",
      elements: [],
      collections: {},
    }));
    (page as any).scan = scanSpy;
    await page.dispatch("titleLink.text");
    expect(scanSpy).not.toHaveBeenCalled();
  });
});

describe("Page sugar methods funnel through dispatch", () => {
  it("page.click() == page.dispatch('name.click')", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    const dispatchSpy = mock(async () => ({ ok: true }));
    (page as any).dispatch = dispatchSpy;
    await page.click("foo");
    expect(dispatchSpy).toHaveBeenCalledWith("foo.click", undefined);
  });

  it("page.fill() == page.dispatch('name.fill', value)", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    const dispatchSpy = mock(async () => ({ ok: true }));
    (page as any).dispatch = dispatchSpy;
    await page.fill("emailInput", "user@example.com");
    expect(dispatchSpy).toHaveBeenCalledWith(
      "emailInput.fill",
      "user@example.com",
    );
  });

  it("page.goto() == page.dispatch('goto', { url })", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    const dispatchSpy = mock(async (..._a: any[]) => ({ url: "https://x" }));
    (page as any).dispatch = dispatchSpy;
    await page.goto("https://x");
    const call = dispatchSpy.mock.calls[0];
    expect(call?.[0]).toBe("goto");
    expect((call?.[1] as any)?.url).toBe("https://x");
  });

  it("page.list() == page.dispatch('list')", async () => {
    const { browser } = makePage();
    const page = await constructPage(browser);
    const dispatchSpy = mock(() => ["a", "b"]);
    (page as any).dispatch = dispatchSpy;
    page.list();
    expect(dispatchSpy).toHaveBeenCalledWith("list", undefined);
  });
});

// ── helpers ─────────────────────────────────────────

async function constructPage(browser: Browser): Promise<Page> {
  const cdp = (browser as any).cdp;
  const session = new Session(cdp, "S1");
  return await Page._create(browser, "T1", session);
}
