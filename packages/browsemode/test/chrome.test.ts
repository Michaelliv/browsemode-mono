import { describe, expect, it } from "bun:test";
import { findChrome, chromeStatus } from "../src/browser/chrome.js";

describe("findChrome", () => {
  it("returns either a string path or null without throwing", () => {
    const r = findChrome();
    expect(r === null || typeof r === "string").toBe(true);
  });
});

describe("chromeStatus", () => {
  it("returns a status object that has .running boolean", async () => {
    const s = await chromeStatus();
    expect(typeof s.running).toBe("boolean");
  });
});
