// Smoke tests on the public barrel — every named export should be defined.

import { describe, expect, it } from "bun:test";

describe("public barrel", () => {
  it("exports the Browsemode namespace with config + persistence helpers", async () => {
    const { Browsemode } = await import("../src/index.js");
    expect(typeof Browsemode.connect).toBe("function");
    expect(typeof Browsemode.launch).toBe("function");
    expect(typeof Browsemode.openWithFallback).toBe("function");
    expect(typeof Browsemode.restore).toBe("function");
    expect(typeof Browsemode.listBrowsers).toBe("function");
    expect(typeof Browsemode.forgetBrowser).toBe("function");
    expect(typeof Browsemode.config).toBe("function");
    expect(typeof Browsemode.configure).toBe("function");
  });

  it("exports the core classes", async () => {
    const m = await import("../src/index.js");
    expect(m.Browser).toBeDefined();
    expect(m.Page).toBeDefined();
    expect(m.CDP).toBeDefined();
    expect(m.Session).toBeDefined();
    expect(m.Sandbox).toBeDefined();
    expect(m.Bus).toBeDefined();
  });

  it("exports the chrome helpers", async () => {
    const m = await import("../src/index.js");
    expect(typeof m.findChrome).toBe("function");
    expect(typeof m.ensureChrome).toBe("function");
    expect(typeof m.chromeStatus).toBe("function");
    expect(typeof m.stopChrome).toBe("function");
  });

  it("exports the cookies helpers", async () => {
    const m = await import("../src/index.js");
    expect(typeof m.readChromeCookies).toBe("function");
    expect(typeof m.toCdpCookies).toBe("function");
    expect(typeof m.clearCookieCache).toBe("function");
  });

  it("exports the markdown helpers", async () => {
    const m = await import("../src/index.js");
    expect(typeof m.htmlToMarkdown).toBe("function");
    expect(typeof m.urlToMarkdown).toBe("function");
    expect(typeof m.extractSections).toBe("function");
  });

  it("exports the orchestration helpers", async () => {
    const m = await import("../src/index.js");
    expect(typeof m.meetsExpectation).toBe("function");
    expect(typeof m.parseExpectationSpec).toBe("function");
    expect(typeof m.openWithFallback).toBe("function");
    expect(typeof m.saveBrowser).toBe("function");
    expect(typeof m.loadBrowser).toBe("function");
    expect(typeof m.clearBrowser).toBe("function");
    expect(typeof m.listBrowsers).toBe("function");
    expect(typeof m.pathForBrowser).toBe("function");
  });

  it("exports the config helpers", async () => {
    const m = await import("../src/index.js");
    expect(typeof m.configure).toBe("function");
    expect(typeof m.getConfig).toBe("function");
    expect(typeof m.resetConfig).toBe("function");
    expect(typeof m.randomBrowserId).toBe("function");
  });
});
