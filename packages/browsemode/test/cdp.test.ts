import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CDP } from "../src/cdp/client.js";
import {
  installMockWebSocket,
  lastSocket,
  restoreWebSocket,
} from "./fixtures/mock-ws.js";

beforeEach(() => installMockWebSocket());
afterEach(() => restoreWebSocket());

describe("CDP", () => {
  it("connects and sends a JSON command with sequential ids", async () => {
    const cdp = await CDP.connect("ws://test/devtools/browser");
    const ws = lastSocket();

    // Don't await — we need to inspect the in-flight send first.
    const p = cdp.send("Page.enable", {}, "S1");
    // Microtask: send hits ws.send synchronously after the promise is created.
    await Promise.resolve();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toMatchObject({
      id: 1,
      method: "Page.enable",
      params: {},
      sessionId: "S1",
    });
    ws.reply({ ok: true });
    await expect(p).resolves.toEqual({ ok: true });

    // Next id is 2.
    const q = cdp.send("Runtime.evaluate", { expression: "1" });
    await Promise.resolve();
    expect(ws.sent[1].id).toBe(2);
    ws.reply({ result: { value: 1 } });
    await q;
  });

  it("rejects when the server returns an error", async () => {
    const cdp = await CDP.connect("ws://test/x");
    const ws = lastSocket();
    const p = cdp.send("X.y").catch((e) => e);
    await Promise.resolve();
    ws.reply(undefined, "boom");
    const e = (await p) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.message.toLowerCase()).toContain("boom");
  });

  it("delivers events to registered listeners", async () => {
    const cdp = await CDP.connect("ws://test/x");
    const ws = lastSocket();
    const seen: any[] = [];
    cdp.on("Page.frameAttached", (params, sessionId) =>
      seen.push({ params, sessionId }),
    );
    ws.push({
      method: "Page.frameAttached",
      params: { frameId: "F1" },
      sessionId: "S1",
    });
    expect(seen).toEqual([{ params: { frameId: "F1" }, sessionId: "S1" }]);
  });

  it("on() returns an unsubscribe function", async () => {
    const cdp = await CDP.connect("ws://test/x");
    const ws = lastSocket();
    const seen: any[] = [];
    const off = cdp.on("Foo.bar", (p) => seen.push(p));
    off();
    ws.push({ method: "Foo.bar", params: { x: 1 } });
    expect(seen).toEqual([]);
  });

  it("default per-call timeout rejects long-running sends", async () => {
    const cdp = await CDP.connect("ws://test/x");
    cdp.defaultTimeoutMs = 20;
    const start = Date.now();
    const p = cdp.send("Slow.method").catch((e) => e);
    const e = (await p) as Error;
    expect(e.message.toLowerCase()).toContain("timed out");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("timeout error names the method and the actionable failure mode", async () => {
    // Pattern #1 from browser-use: a silent-WebSocket hang is the most
    // common reason a CDP method never resolves. The error text has to
    // surface that so callers stop guessing.
    const cdp = await CDP.connect("ws://test/x");
    const e = (await cdp
      .send("Page.captureScreenshot", {}, undefined, { timeoutMs: 5 })
      .catch((err) => err)) as Error;
    expect(e.message).toContain("Page.captureScreenshot");
    expect(e.message).toContain("5ms");
    expect(e.message).toContain("browser may be unresponsive");
    expect(e.message).toMatch(/silent WebSocket|dead container|stuck script/);
  });

  it("opts.timeoutMs overrides the default", async () => {
    const cdp = await CDP.connect("ws://test/x");
    cdp.defaultTimeoutMs = 10_000;
    const p = cdp.send("X", {}, undefined, { timeoutMs: 20 }).catch((e) => e);
    const e = (await p) as Error;
    expect(e.message.toLowerCase()).toContain("timed out");
  });

  it("close() rejects all pending sends", async () => {
    const cdp = await CDP.connect("ws://test/x");
    const a = cdp.send("X").catch((e) => e);
    const b = cdp.send("Y").catch((e) => e);
    cdp.close();
    expect(((await a) as Error).message).toMatch(/closed/i);
    expect(((await b) as Error).message).toMatch(/closed/i);
  });

  it("send() after close throws synchronously (or rejects) immediately", async () => {
    const cdp = await CDP.connect("ws://test/x");
    cdp.close();
    await expect(cdp.send("X")).rejects.toThrow(/closed/i);
  });
});
