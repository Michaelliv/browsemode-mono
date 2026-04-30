// Smoke tests on the extension surface — verify the tool registry shape
// without needing a real pi runtime.

import { describe, expect, it, mock } from "bun:test";

describe("pi-browse extension", () => {
  it("default export is a function", async () => {
    const mod = await import("../.pi/extensions/browse/index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("registers the canonical browse_* tools", async () => {
    const mod = await import("../.pi/extensions/browse/index.js");
    const registered: any[] = [];
    const fakePi: any = {
      registerTool: mock((spec: any) => registered.push(spec)),
    };
    mod.default(fakePi);
    const names = registered.map((t) => t.name);
    expect(names).toContain("browse_open");
    expect(names).toContain("browse_scan");
    expect(names).toContain("browse_dispatch");
    expect(names).toContain("browse_exec");
    expect(names).toContain("browse_read");
    expect(names).toContain("browse_close");
  });

  it("each tool has parameters schema and execute fn", async () => {
    const mod = await import("../.pi/extensions/browse/index.js");
    const registered: any[] = [];
    const fakePi: any = { registerTool: (spec: any) => registered.push(spec) };
    mod.default(fakePi);
    for (const tool of registered) {
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
      expect(tool.label).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });
});
