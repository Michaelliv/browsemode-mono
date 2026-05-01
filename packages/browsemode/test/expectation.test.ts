import { describe, expect, it } from "bun:test";
import {
  meetsExpectation,
  parseExpectationSpec,
} from "../src/orchestration/expectation.js";
import type { ScanResult } from "../src/types.js";

const scan = (els: any[], extra: Partial<ScanResult> = {}): ScanResult => ({
  url: "https://example.com",
  title: "Example Domain",
  elements: els,
  collections: {},
  ...extra,
});

const E = (kind: string, name = "x", text = "") =>
  ({ id: name, name, kind, text, verbs: [], selector: "" }) as any;

describe("meetsExpectation", () => {
  it("number: ok when element count >= threshold", () => {
    expect(meetsExpectation(scan([E("button"), E("link")]), 2).ok).toBe(true);
  });

  it("number: not ok when count below threshold, with reason", () => {
    const r = meetsExpectation(scan([E("button")]), 5);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("1");
    expect(r.reasons[0]).toContain("5");
  });

  it("string: matches element name (case-insensitive)", () => {
    const r = meetsExpectation(
      scan([E("button", "loginButton", "Sign in")]),
      "login",
    );
    expect(r.ok).toBe(true);
  });

  it("string: matches element text", () => {
    const r = meetsExpectation(
      scan([E("link", "x", "Privacy Policy")]),
      "privacy",
    );
    expect(r.ok).toBe(true);
  });

  it("string: no match → not ok with reason", () => {
    const r = meetsExpectation(scan([E("link", "x", "About")]), "checkout");
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("checkout");
  });

  it("object: hasInputs counts text + textarea", () => {
    const els = [E("text"), E("textarea"), E("button")];
    expect(meetsExpectation(scan(els), { hasInputs: 2 }).ok).toBe(true);
    expect(meetsExpectation(scan(els), { hasInputs: 3 }).ok).toBe(false);
  });

  it("object: hasButtons / hasLinks counts respective kinds", () => {
    const els = [E("button"), E("button"), E("link")];
    expect(meetsExpectation(scan(els), { hasButtons: 2, hasLinks: 1 }).ok).toBe(
      true,
    );
    expect(meetsExpectation(scan(els), { hasButtons: 3 }).ok).toBe(false);
  });

  it("object: titleMatches uses regex (case-insensitive)", () => {
    const r = meetsExpectation(
      scan([], { title: "GitHub - h4ckf0r0day/obscura" }),
      {
        titleMatches: "^github",
      },
    );
    expect(r.ok).toBe(true);
  });

  it("object: combined constraints all must hold", () => {
    const els = [
      E("text", "searchInput", "Search"),
      E("button", "goButton", "Go"),
    ];
    expect(
      meetsExpectation(scan(els), { hasInputs: 1, find: "search" }).ok,
    ).toBe(true);
    expect(
      meetsExpectation(scan(els), { hasInputs: 5, find: "search" }).ok,
    ).toBe(false);
  });

  it("object: minElements with collections", () => {
    expect(meetsExpectation(scan([E("button")]), { minElements: 1 }).ok).toBe(
      true,
    );
    expect(meetsExpectation(scan([]), { minElements: 1 }).ok).toBe(false);
  });
});

describe("parseExpectationSpec", () => {
  it("bare integer → number", () => {
    expect(parseExpectationSpec("25")).toBe(25);
    expect(parseExpectationSpec(" 7 ")).toBe(7);
  });

  it("bare string → string (find query)", () => {
    expect(parseExpectationSpec("login")).toBe("login");
  });

  it("key:value pairs → object", () => {
    expect(parseExpectationSpec("inputs:1,find:login")).toEqual({
      hasInputs: 1,
      find: "login",
    });
  });

  it("title:<regex> → titleMatches", () => {
    expect(parseExpectationSpec("title:^GitHub")).toEqual({
      titleMatches: "^GitHub",
    });
  });

  it("min:N → minElements", () => {
    expect(parseExpectationSpec("min:10")).toEqual({ minElements: 10 });
  });

  it("buttons:N + links:N", () => {
    expect(parseExpectationSpec("buttons:3,links:5")).toEqual({
      hasButtons: 3,
      hasLinks: 5,
    });
  });
});
