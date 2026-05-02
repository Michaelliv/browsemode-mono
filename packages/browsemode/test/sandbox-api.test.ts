// Sandbox `api.*` introspection tests. The catalog is baked into
// the sandbox source at exec start from PAGE_VERB_SPECS,
// TABS_VERB_SPECS, ELEMENT_VERB_SPECS plus the live page.elements.
// Mirrors runline's actions.list/find/describe/check shape.

import { describe, expect, it } from "bun:test";
import type { Page } from "../src/page/page.js";
import { Sandbox } from "../src/sandbox/sandbox.js";
import type { ElementInfo } from "../src/types.js";

function fakePage(elements: ElementInfo[] = []): Page {
  const map = new Map<string, ElementInfo>();
  for (const e of elements) map.set(e.name, e);
  return {
    dispatch: async () => undefined,
    elements: map,
  } as unknown as Page;
}

function el(name: string, kind: string, verbs: string[]): ElementInfo {
  return {
    id: name,
    name,
    kind: kind as any,
    text: name,
    role: "",
    verbs,
    sessionId: "",
  } as any;
}

describe("sandbox api.*", () => {
  it("api.list() returns paths for static page verbs + tab verbs", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      const all = await api.list();
      return {
        hasGoto: all.includes("page.goto"),
        hasScan: all.includes("page.scan"),
        hasTabsOpen: all.includes("tabs.open"),
        count: all.length,
      };
    `);
    const out = r.result as any;
    expect(out.hasGoto).toBe(true);
    expect(out.hasScan).toBe(true);
    expect(out.hasTabsOpen).toBe(true);
    expect(out.count).toBeGreaterThan(10);
  });

  it("api.list('element') expands to <elementName>.<verb> paths", async () => {
    const page = fakePage([
      el("loginBtn", "button", ["click", "text"]),
      el("emailInput", "text", ["fill", "clear", "value", "focus"]),
    ]);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      return await api.list("element");
    `);
    const paths = r.result as string[];
    expect(paths).toContain("loginBtn.click");
    expect(paths).toContain("loginBtn.text");
    expect(paths).toContain("emailInput.fill");
    expect(paths).toContain("emailInput.clear");
    expect(paths).toContain("emailInput.value");
  });

  it("api.list(elementName) filters to that element's paths", async () => {
    const page = fakePage([
      el("loginBtn", "button", ["click", "text"]),
      el("signupBtn", "button", ["click", "text"]),
    ]);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`return await api.list("loginBtn");`);
    const paths = r.result as string[];
    expect(paths.every((p) => p.startsWith("loginBtn."))).toBe(true);
    expect(paths).toContain("loginBtn.click");
    expect(paths.includes("signupBtn.click")).toBe(false);
  });

  it("api.find ranks paths by query", async () => {
    const page = fakePage([
      el("submitForm", "form", ["submit", "fields", "fill"]),
      el("searchInput", "text", ["fill"]),
    ]);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`return await api.find("submit");`);
    const hits = r.result as Array<{ path: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    // submitForm.submit (path startsWith match) outranks anything else
    expect(hits[0].path).toMatch(/submitForm\.submit/);
  });

  it("api.describe returns full schema for a path", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`return await api.describe("page.scroll");`);
    const d = r.result as any;
    expect(d.path).toBe("page.scroll");
    expect(d.scope).toBe("page");
    expect(d.signature).toContain("page.scroll");
    expect(d.inputs.direction).toBeDefined();
    expect(d.inputs.dy).toBeDefined();
    expect(Array.isArray(d.examples)).toBe(true);
  });

  it("api.describe throws with did-you-mean on typo", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      try {
        await api.describe("page.scrol");
        return { ok: false };
      } catch (e) {
        return { msg: e.message };
      }
    `);
    expect((r.result as any).msg).toMatch(/Unknown path/);
    expect((r.result as any).msg).toMatch(/Did you mean.*page\.scroll/);
  });

  it("api.check returns ok when args match the schema", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      return await api.check("page.scroll", { direction: "down", amount: 2 });
    `);
    expect((r.result as any).ok).toBe(true);
    expect((r.result as any).typeErrors).toEqual([]);
  });

  it("api.check flags type errors without calling", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      return await api.check("page.scroll", { dy: "not-a-number" });
    `);
    const c = r.result as any;
    expect(c.ok).toBe(false);
    expect(c.typeErrors).toEqual([
      { field: "dy", expected: "number", actual: "string" },
    ]);
  });

  it("api.check flags unknown fields", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`
      return await api.check("page.goto", { url: "https://x", weirdField: 1 });
    `);
    const c = r.result as any;
    expect(c.ok).toBe(false);
    expect(c.unknown).toContain("weirdField");
  });

  it("api.check flags missing required fields", async () => {
    const page = fakePage();
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`return await api.check("page.goto", {});`);
    const c = r.result as any;
    expect(c.ok).toBe(false);
    expect(c.missing).toContain("url");
  });

  it("element entries include the appliesTo hint", async () => {
    const page = fakePage([el("primaryBtn", "button", ["click", "text"])]);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(
      `return await api.describe("primaryBtn.click");`,
    );
    const d = r.result as any;
    expect(d.scope).toBe("element");
    expect(Array.isArray(d.appliesTo)).toBe(true);
    expect(d.appliesTo).toContain("button");
  });
});
