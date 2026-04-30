import { describe, expect, it } from "bun:test";
import { SCAN_SCRIPT } from "../src/page/scanner.js";

describe("SCAN_SCRIPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SCAN_SCRIPT).toBe("string");
    expect(SCAN_SCRIPT.length).toBeGreaterThan(500);
  });

  it("looks like an IIFE returning a ScanResult shape", () => {
    expect(SCAN_SCRIPT).toContain("(() =>");
    expect(SCAN_SCRIPT).toContain("elements");
    expect(SCAN_SCRIPT).toContain("collections");
    expect(SCAN_SCRIPT).toContain("location.href");
    expect(SCAN_SCRIPT).toContain("document.title");
  });

  it("stamps a data-browsemode attribute, not a legacy data-webline", () => {
    expect(SCAN_SCRIPT).toContain("data-browsemode");
    expect(SCAN_SCRIPT).not.toContain("data-webline");
  });

  it("walks same-origin iframes via contentDocument", () => {
    expect(SCAN_SCRIPT).toContain("contentDocument");
    expect(SCAN_SCRIPT).toContain("iframe");
  });

  it("includes the interactable selector list", () => {
    expect(SCAN_SCRIPT).toContain("a[href]");
    expect(SCAN_SCRIPT).toContain("button");
    expect(SCAN_SCRIPT).toContain("[role=\"button\"]");
  });
});
