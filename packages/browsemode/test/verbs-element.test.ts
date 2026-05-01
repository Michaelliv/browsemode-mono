import { describe, expect, it } from "bun:test";
import {
  assertElementVerb,
  ELEMENT_VERBS,
  NAVIGATING_ELEMENT_VERBS,
  UNIVERSAL_ELEMENT_VERBS,
} from "../src/page/verbs/element.js";

const EL = (kind: string, verbs: string[] = []) =>
  ({ id: "x", name: "x", kind, text: "", verbs, selector: "" }) as any;

describe("element verb registry", () => {
  it("ELEMENT_VERBS has the canonical verbs", () => {
    for (const v of [
      "click",
      "text",
      "href",
      "value",
      "fill",
      "clear",
      "focus",
      "hover",
      "scrollIntoView",
      "press",
      "type",
      "check",
      "uncheck",
      "toggle",
      "isChecked",
      "select",
      "isSelected",
      "choose",
      "options",
      "submit",
      "fields",
    ]) {
      expect(ELEMENT_VERBS[v]).toBeDefined();
      expect(typeof ELEMENT_VERBS[v]).toBe("function");
    }
  });

  it("UNIVERSAL_ELEMENT_VERBS includes press, type, hover, scrollIntoView", () => {
    for (const v of ["press", "type", "hover", "scrollIntoView"]) {
      expect(UNIVERSAL_ELEMENT_VERBS.has(v)).toBe(true);
    }
  });

  it("NAVIGATING_ELEMENT_VERBS includes click, submit, choose, press", () => {
    for (const v of ["click", "submit", "choose", "press"]) {
      expect(NAVIGATING_ELEMENT_VERBS.has(v)).toBe(true);
    }
  });
});

describe("assertElementVerb", () => {
  it("accepts a kind-supported verb", () => {
    expect(() =>
      assertElementVerb(EL("button", ["click", "text"]), "click"),
    ).not.toThrow();
  });

  it("accepts a universal verb regardless of kind", () => {
    expect(() =>
      assertElementVerb(EL("button", ["click"]), "hover"),
    ).not.toThrow();
    expect(() =>
      assertElementVerb(EL("button", ["click"]), "press"),
    ).not.toThrow();
  });

  it("throws for an unsupported verb", () => {
    expect(() => assertElementVerb(EL("button", ["click"]), "fill")).toThrow();
  });

  it("throw message lists the available verbs", () => {
    try {
      assertElementVerb(EL("button", ["click", "text"]), "fill");
      throw new Error("should not reach");
    } catch (e: any) {
      expect(e.message).toContain("click");
      expect(e.message).toContain("text");
    }
  });
});
