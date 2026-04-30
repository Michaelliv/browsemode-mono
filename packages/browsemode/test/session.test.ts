import { describe, expect, it } from "bun:test";
import { Session } from "../src/cdp/session.js";

function fakeCdp() {
  const calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  let nextResult: any = { result: { value: undefined } };
  return {
    calls,
    setNextResult(r: any) {
      nextResult = r;
    },
    async send(method: string, params: any, sessionId?: string) {
      calls.push({ method, params, sessionId });
      return nextResult;
    },
  } as any;
}

describe("Session", () => {
  it("evalJSON wraps Runtime.evaluate with returnByValue + awaitPromise + this session", async () => {
    const cdp = fakeCdp();
    cdp.setNextResult({ result: { value: 42 } });
    const s = new Session(cdp, "S1");
    await s.evalJSON("1+1");
    expect(cdp.calls).toHaveLength(1);
    expect(cdp.calls[0].method).toBe("Runtime.evaluate");
    expect(cdp.calls[0].sessionId).toBe("S1");
    expect(cdp.calls[0].params).toMatchObject({
      expression: "1+1",
      returnByValue: true,
      awaitPromise: true,
    });
  });

  it("evalJSON returns the unwrapped value", async () => {
    const cdp = fakeCdp();
    cdp.setNextResult({ result: { value: { ok: true } } });
    const s = new Session(cdp, "S1");
    const r = await s.evalJSON<{ ok: boolean }>("({ok:true})");
    expect(r).toEqual({ ok: true });
  });

  it("evalJSON throws when exceptionDetails is set", async () => {
    const cdp = fakeCdp();
    cdp.setNextResult({
      exceptionDetails: { exception: { description: "ReferenceError: x not defined" } },
    });
    const s = new Session(cdp, "S1");
    await expect(s.evalJSON("x")).rejects.toThrow(/x not defined|ReferenceError/);
  });

  it("evalString coerces non-strings to a string", async () => {
    const cdp = fakeCdp();
    cdp.setNextResult({ result: { value: 7 } });
    const s = new Session(cdp, "S1");
    expect(await s.evalString("7")).toBe("7");
  });

  it("evalString returns empty string for null/undefined", async () => {
    const cdp = fakeCdp();
    cdp.setNextResult({ result: { value: null } });
    const s = new Session(cdp, "S1");
    expect(await s.evalString("null")).toBe("");
  });

  it("send routes through CDP using the session id", async () => {
    const cdp = fakeCdp();
    const s = new Session(cdp, "SX");
    await s.send("Page.reload");
    expect(cdp.calls[0]).toMatchObject({ method: "Page.reload", sessionId: "SX" });
  });
});
