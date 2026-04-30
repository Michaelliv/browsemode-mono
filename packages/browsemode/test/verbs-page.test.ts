import { describe, expect, it } from "bun:test";
import {
  NAVIGATING_PAGE_VERBS,
  PAGE_VERBS,
  pageVerbNames,
} from "../src/page/verbs/page.js";

describe("page verb registry", () => {
  it("PAGE_VERBS has the canonical verbs", () => {
    for (const v of [
      "goto",
      "back",
      "forward",
      "reload",
      "rescan",
      "title",
      "url",
      "html",
      "markdown",
      "wait",
      "waitFor",
      "list",
      "find",
      "describe",
      "collections",
      "eval",
      "press",
      "viewport",
      "probe",
      "read",
      "sections",
      "rows",
      "clickAt",
      "scroll",
    ]) {
      expect(PAGE_VERBS[v]).toBeDefined();
      expect(typeof PAGE_VERBS[v]).toBe("function");
    }
  });

  it("NAVIGATING_PAGE_VERBS includes goto/reload/back/forward/rescan/press", () => {
    for (const v of ["goto", "reload", "back", "forward", "rescan", "press"]) {
      expect(NAVIGATING_PAGE_VERBS.has(v)).toBe(true);
    }
  });

  it("pageVerbNames() returns the keys of PAGE_VERBS", () => {
    const names = pageVerbNames();
    expect(names).toContain("goto");
    expect(names).toContain("waitFor");
    expect(names.length).toBeGreaterThan(15);
  });
});
