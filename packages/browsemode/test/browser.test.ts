// Browser-layer tests use a fake fetch + fake WebSocket to validate the
// protocol-level behaviour without any browser. Browser.connect probes
// /json/version, opens a CDP socket, and tracks Pages.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Browser } from "../src/browser/browser.js";
import {
  installMockWebSocket,
  lastSocket,
  restoreWebSocket,
} from "./fixtures/mock-ws.js";

const origFetch = globalThis.fetch;

function installFakeFetch(payload: any, status = 200) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as any;
}

function restoreFetch() {
  globalThis.fetch = origFetch;
}

beforeEach(() => {
  installMockWebSocket();
  installFakeFetch({
    Browser: "Obscura/0.1",
    webSocketDebuggerUrl: "ws://localhost:9333/devtools/browser",
  });
});

afterEach(() => {
  restoreWebSocket();
  restoreFetch();
});

describe("Browser.connect", () => {
  it("probes /json/version and opens a CDP socket", async () => {
    const probed: string[] = [];
    globalThis.fetch = (async (url: any) => {
      probed.push(String(url));
      return {
        ok: true,
        json: async () => ({
          Browser: "Obscura/0.1",
          webSocketDebuggerUrl: "ws://localhost:9333/devtools/browser",
        }),
      } as any;
    }) as any;
    const browser = await Browser.connect({ host: "localhost", port: 9333 });
    expect(probed[0]).toContain("/json/version");
    expect(browser.product).toBe("Obscura/0.1");
    expect(browser.isObscura).toBe(true);
  });

  it("isObscura is false for Chrome", async () => {
    installFakeFetch({
      Browser: "Chrome/120.0.0.0",
      webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/abc",
    });
    const b = await Browser.connect({ port: 9222 });
    expect(b.isObscura).toBe(false);
  });

  it("shimEnabled defaults true on obscura, false on chrome", async () => {
    const obscura = await Browser.connect({ port: 9333 });
    expect(obscura.shimEnabled).toBe(true);
    installFakeFetch({
      Browser: "Chrome/120.0.0.0",
      webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser",
    });
    const chrome = await Browser.connect({ port: 9222 });
    expect(chrome.shimEnabled).toBe(false);
  });

  it("explicit shim:true overrides the default for chrome", async () => {
    installFakeFetch({
      Browser: "Chrome/120.0.0.0",
      webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser",
    });
    const b = await Browser.connect({ port: 9222, shim: true });
    expect(b.shimEnabled).toBe(true);
  });

  it("rejects with a helpful error when /json/version is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    await expect(Browser.connect({ port: 9999 })).rejects.toThrow(
      /(json\/version|reach|9999)/i,
    );
  });
});

describe("Browser.newPage", () => {
  it("opens a Target.createTarget and attaches", async () => {
    const browser = await Browser.connect({ port: 9333 });
    const ws = lastSocket();

    // Background drainer auto-replies to every send. Specific methods
    // get scripted results; everything else gets {}. Each id only ever
    // gets one reply.
    const scripted: Record<string, any> = {
      "Target.createTarget": { targetId: "T1" },
      "Target.attachToTarget": { sessionId: "S1" },
    };
    const seen = new Set<number>();
    let stop = false;
    const drain = (async () => {
      while (!stop) {
        for (const m of ws.sent) {
          if (m.id === undefined || seen.has(m.id)) continue;
          seen.add(m.id);
          ws.push({ id: m.id, result: scripted[m.method] ?? {} });
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    const page = await browser.newPage();
    stop = true;
    await drain;

    expect(page.targetId).toBe("T1");
    expect(browser.pages.has("T1")).toBe(true);
    expect(browser.activePage).toBe(page);
  });
});

describe("Browser.close", () => {
  it("closes every open target and disposes the socket", async () => {
    const browser = await Browser.connect({ port: 9333 });
    await browser.close();
    expect(browser.cdp.closed).toBe(true);
  });
});
