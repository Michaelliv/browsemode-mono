// Pattern #5: downloads watchdog.
//
// Per obscura's CDP table (Target / Page / Runtime / DOM / Network /
// Fetch / Storage / Input / LP) it has neither a `Browser` domain
// nor any download events. So the watchdog is dormant on obscura
// and active only on Chrome (and forks: Brave/Edge/Arc). Tests
// verify the active path via FakeCDP.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Bus } from "../src/bus.js";
import { resetConfig } from "../src/config.js";
import { DownloadsWatchdog } from "../src/orchestration/watchdogs/downloads.js";
import { asCdp, FakeCDP } from "./fixtures/fake-cdp.js";

beforeEach(() => resetConfig());
afterEach(() => resetConfig());

function makeBrowser(fake: FakeCDP) {
  return {
    cdp: asCdp(fake),
    bus: new Bus(),
    pages: new Map<string, any>(),
  } as any;
}

describe("DownloadsWatchdog", () => {
  it("attaches without throwing and returns a detach fn", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);
    expect(typeof detach).toBe("function");
    detach();
  });

  it("calls Browser.setDownloadBehavior with allowAndName", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);
    // setDownloadBehavior is fire-and-forget — give it one tick to
    // hit the FakeCDP send queue.
    await new Promise((r) => setTimeout(r, 10));
    const setup = fake.callsFor("Browser.setDownloadBehavior");
    expect(setup).toHaveLength(1);
    expect(setup[0].params.behavior).toBe("allowAndName");
    expect(typeof setup[0].params.downloadPath).toBe("string");
    expect(setup[0].params.eventsEnabled).toBe(true);
    detach();
  });

  it("emits download.started on Browser.downloadWillBegin", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);

    const events: any[] = [];
    browser.bus.on("download.started", (e: any) => events.push(e));

    fake.emit("Browser.downloadWillBegin", {
      guid: "G1",
      url: "https://x/file.csv",
      suggestedFilename: "file.csv",
    });

    expect(events).toHaveLength(1);
    expect(events[0].guid).toBe("G1");
    expect(events[0].url).toBe("https://x/file.csv");
    expect(events[0].suggestedFilename).toBe("file.csv");
    detach();
  });

  it("emits download.progress while inProgress, completed on terminal", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);

    const captured: any[] = [];
    browser.bus.on("download.progress", (e: any) =>
      captured.push(["progress", e]),
    );
    browser.bus.on("download.completed", (e: any) =>
      captured.push(["completed", e]),
    );

    fake.emit("Browser.downloadWillBegin", {
      guid: "G2",
      url: "https://x/big.zip",
      suggestedFilename: "big.zip",
    });
    fake.emit("Browser.downloadProgress", {
      guid: "G2",
      receivedBytes: 1024,
      totalBytes: 4096,
      state: "inProgress",
    });
    fake.emit("Browser.downloadProgress", {
      guid: "G2",
      receivedBytes: 2048,
      totalBytes: 4096,
      state: "inProgress",
    });
    fake.emit("Browser.downloadProgress", {
      guid: "G2",
      receivedBytes: 4096,
      totalBytes: 4096,
      state: "completed",
    });

    expect(captured.map((c) => c[0])).toEqual([
      "progress",
      "progress",
      "completed",
    ]);
    expect(captured[0][1].receivedBytes).toBe(1024);
    expect(captured[2][1].guid).toBe("G2");
    expect(captured[2][1].totalBytes).toBe(4096);
    // The path is built from the configured downloadPath + guid.
    expect(captured[2][1].filePath).toContain("G2");
    detach();
  });

  it("emits download.canceled on canceled state", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);

    const events: any[] = [];
    browser.bus.on("download.canceled", (e: any) => events.push(e));

    fake.emit("Browser.downloadWillBegin", {
      guid: "G3",
      url: "x",
      suggestedFilename: "f",
    });
    fake.emit("Browser.downloadProgress", { guid: "G3", state: "canceled" });

    expect(events).toHaveLength(1);
    expect(events[0].guid).toBe("G3");
    detach();
  });

  it("Page.* domain events route through the same handler (Chrome compat)", async () => {
    // Chrome has been migrating from Page.* to Browser.* for downloads;
    // older versions still emit on Page. We listen on both so flows
    // work regardless.
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);

    const events: any[] = [];
    browser.bus.on("download.started", (e: any) => events.push(e));

    fake.emit("Page.downloadWillBegin", {
      guid: "G4",
      url: "u",
      suggestedFilename: "old-chrome.csv",
    });

    expect(events).toHaveLength(1);
    expect(events[0].guid).toBe("G4");
    detach();
  });

  it("detach unsubscribes — events after detach do nothing", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);
    detach();

    const events: any[] = [];
    browser.bus.on("download.started", (e: any) => events.push(e));

    fake.emit("Browser.downloadWillBegin", {
      guid: "GX",
      url: "x",
      suggestedFilename: "x",
    });

    expect(events).toHaveLength(0);
  });

  it("config.downloads.disabled = true → does nothing on attach", async () => {
    const { configure } = await import("../src/config.js");
    configure({ downloads: { disabled: true } });

    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new DownloadsWatchdog();
    const detach = await wd.attach(browser);

    await new Promise((r) => setTimeout(r, 10));
    // No setDownloadBehavior call should have been made.
    expect(fake.callsFor("Browser.setDownloadBehavior")).toHaveLength(0);

    // No subscription either — emitting an event does nothing.
    const events: any[] = [];
    browser.bus.on("download.started", (e: any) => events.push(e));
    fake.emit("Browser.downloadWillBegin", {
      guid: "G",
      url: "x",
      suggestedFilename: "x",
    });
    expect(events).toHaveLength(0);

    detach();
  });
});
