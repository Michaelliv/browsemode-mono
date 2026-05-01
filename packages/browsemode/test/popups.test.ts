import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Bus } from "../src/bus.js";
import { resetConfig } from "../src/config.js";
import { PopupsWatchdog } from "../src/orchestration/watchdogs/popups.js";
import { asCdp, FakeCDP } from "./fixtures/fake-cdp.js";

beforeEach(() => resetConfig());
afterEach(() => resetConfig());

// Build a minimal Browser-shaped object that the watchdog expects.
// We don't construct a real Browser because that requires a live
// CDP probe and pages map; the watchdog only reads `.cdp`, `.bus`,
// and `.pages.values()`.
function makeBrowser(fake: FakeCDP) {
  const bus = new Bus();
  return {
    cdp: asCdp(fake),
    bus,
    pages: new Map<string, any>(),
  } as any;
}

describe("PopupsWatchdog", () => {
  it("attaches without throwing and registers a CDP listener", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);
    expect(typeof detach).toBe("function");
    detach();
  });

  it("auto-accepts alert/confirm/beforeunload, dismisses prompt", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);

    const handled: any[] = [];
    browser.bus.on("dialog.handled", (e: any) => handled.push(e));

    // Simulate Chrome firing dialog events for each of the four types.
    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "are you sure?", type: "alert", url: "x" },
      "S1",
    );
    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "delete?", type: "confirm", url: "x" },
      "S1",
    );
    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "leave?", type: "beforeunload", url: "x" },
      "S1",
    );
    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "name?", type: "prompt", url: "x" },
      "S1",
    );

    // Let the .then() callbacks settle — handler dispatch is async.
    await new Promise((r) => setTimeout(r, 10));

    const dispatched = fake.callsFor("Page.handleJavaScriptDialog");
    expect(dispatched).toHaveLength(4);
    // alert/confirm/beforeunload accept; prompt cancels.
    expect(dispatched[0].params.accept).toBe(true);
    expect(dispatched[1].params.accept).toBe(true);
    expect(dispatched[2].params.accept).toBe(true);
    expect(dispatched[3].params.accept).toBe(false);

    // Bus events match.
    expect(handled.map((e) => [e.type, e.accepted])).toEqual([
      ["alert", true],
      ["confirm", true],
      ["beforeunload", true],
      ["prompt", false],
    ]);
    // Messages preserved.
    expect(handled[0].message).toBe("are you sure?");

    detach();
  });

  it("Page.handleJavaScriptDialog uses the same sessionId the dialog came from", async () => {
    // OOPIF dialogs route to the iframe session, not the main frame.
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);

    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "x", type: "alert" },
      "IFRAME-SESSION",
    );
    await new Promise((r) => setTimeout(r, 10));

    const calls = fake.callsFor("Page.handleJavaScriptDialog");
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("IFRAME-SESSION");
    detach();
  });

  it("detach() unsubscribes — later events do not dispatch", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);
    detach();

    fake.emit(
      "Page.javascriptDialogOpening",
      { message: "after detach", type: "alert" },
      "S1",
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.callsFor("Page.handleJavaScriptDialog")).toHaveLength(0);
  });

  it("Page.enable is sent for every existing page on attach", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    // Two pre-existing pages with different session ids.
    browser.pages.set("T1", {
      targetId: "T1",
      mainFrame: { session: { id: "S1" } },
    });
    browser.pages.set("T2", {
      targetId: "T2",
      mainFrame: { session: { id: "S2" } },
    });

    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);

    const enables = fake.callsFor("Page.enable");
    expect(enables.map((c) => c.sessionId).sort()).toEqual(["S1", "S2"]);
    detach();
  });

  it("page.created event triggers Page.enable on the new session", async () => {
    const fake = new FakeCDP();
    const browser = makeBrowser(fake);
    const wd = new PopupsWatchdog();
    const detach = await wd.attach(browser);

    expect(fake.callsFor("Page.enable")).toHaveLength(0);

    browser.bus.emit({
      kind: "page.created",
      targetId: "NEW",
      sessionId: "S-NEW",
    });
    // armSession is fire-and-forget but Page.enable resolves
    // immediately in the fake — give it one tick.
    await new Promise((r) => setTimeout(r, 10));

    const enables = fake.callsFor("Page.enable");
    expect(enables).toHaveLength(1);
    expect(enables[0].sessionId).toBe("S-NEW");
    detach();
  });
});
