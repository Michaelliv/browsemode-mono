import { describe, expect, it } from "bun:test";
import { SHIM_SCRIPT } from "../src/page/shim.js";
import { STEALTH_SCRIPT } from "../src/page/stealth.js";

describe("SHIM_SCRIPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SHIM_SCRIPT).toBe("string");
    expect(SHIM_SCRIPT.length).toBeGreaterThan(500);
  });

  it("guards against double-injection via __browsemode_shim_v1 marker", () => {
    expect(SHIM_SCRIPT).toContain("__browsemode_shim_v1");
  });

  it("patches Document.elementFromPoint", () => {
    expect(SHIM_SCRIPT).toContain("elementFromPoint");
  });

  it("patches matchMedia", () => {
    expect(SHIM_SCRIPT).toContain("matchMedia");
  });

  it("patches the four common observers", () => {
    expect(SHIM_SCRIPT).toContain("IntersectionObserver");
    expect(SHIM_SCRIPT).toContain("ResizeObserver");
    expect(SHIM_SCRIPT).toContain("MutationObserver");
    expect(SHIM_SCRIPT).toContain("PerformanceObserver");
  });
});

describe("STEALTH_SCRIPT", () => {
  it("is a non-empty string", () => {
    expect(typeof STEALTH_SCRIPT).toBe("string");
    expect(STEALTH_SCRIPT.length).toBeGreaterThan(500);
  });

  it("patches navigator.webdriver", () => {
    expect(STEALTH_SCRIPT).toContain("webdriver");
  });

  it("patches window.chrome", () => {
    expect(STEALTH_SCRIPT).toContain("chrome");
    expect(STEALTH_SCRIPT).toContain("runtime");
  });

  it("synthesises navigator.plugins entries", () => {
    expect(STEALTH_SCRIPT).toContain("plugins");
    expect(STEALTH_SCRIPT).toContain("PDF");
  });

  it("guards against double-injection", () => {
    expect(STEALTH_SCRIPT).toContain("__browsemode_stealth_v1");
  });
});
