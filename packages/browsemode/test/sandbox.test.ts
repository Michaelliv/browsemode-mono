import { describe, expect, it } from "bun:test";
import type { Page } from "../src/page/page.js";
import { Sandbox } from "../src/sandbox/sandbox.js";

function fakePage(
  handler: (path: string, args: unknown) => Promise<unknown>,
): Page {
  // The sandbox snapshots `page.elements` at exec start to build
  // the api.* catalog. The handler tests don't care about that
  // surface; an empty map is fine.
  return {
    dispatch: handler,
    elements: new Map(),
  } as unknown as Page;
}

describe("Sandbox", () => {
  it("executes a simple async script and returns its value", async () => {
    const calls: string[] = [];
    const page = fakePage(async (path) => {
      calls.push(path);
      if (path === "list") return ["a", "b", "c"];
      return null;
    });
    const sb = new Sandbox(() => page);
    const r = await sb.execute("return await page.list();");
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual(["a", "b", "c"]);
    expect(calls).toEqual(["list"]);
  });

  it("routes element verbs as 'name.verb'", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const page = fakePage(async (path, args) => {
      calls.push({ path, args });
      return { ok: true };
    });
    const sb = new Sandbox(() => page);
    await sb.execute("return await page.signInButton.click();");
    expect(calls[0].path).toBe("signInButton.click");
  });

  it("propagates page.dispatch errors as the script error", async () => {
    const page = fakePage(async () => {
      throw new Error("nope");
    });
    const sb = new Sandbox(() => page);
    const r = await sb.execute("return await page.list();");
    expect(r.error).toMatch(/nope/);
  });

  it("captures console.log output to logs", async () => {
    const page = fakePage(async () => null);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`console.log("hi", 42); return 1;`);
    expect(r.logs.some((l) => l.includes("hi"))).toBe(true);
    expect(r.logs.some((l) => l.includes("42"))).toBe(true);
  });

  it("times out a runaway script", async () => {
    const page = fakePage(async () => null);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(`while(true){}`, { timeoutMs: 100 });
    expect(r.error).toMatch(/timeout/i);
  });

  it("uses the page returned by getPage at call time, allowing tab switch", async () => {
    let active: Page = fakePage(async () => "page-A");
    const sb = new Sandbox(() => active);
    const a = await sb.execute("return await page.title();");
    expect(a.result).toBe("page-A");
    active = fakePage(async () => "page-B");
    const b = await sb.execute("return await page.title();");
    expect(b.result).toBe("page-B");
  });

  it("disables fetch inside the script", async () => {
    const page = fakePage(async () => null);
    const sb = new Sandbox(() => page);
    const r = await sb.execute(
      `try { fetch('x'); return 'no'; } catch(e) { return e.message; }`,
    );
    expect(r.result).toMatch(/disabled/i);
  });
});
