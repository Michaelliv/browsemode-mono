import { describe, expect, it } from "bun:test";
import { buildSandboxSource } from "../src/sandbox/proxy.js";

const VERBS = ["goto", "list", "find", "waitFor"];

describe("buildSandboxSource", () => {
  it("wraps a top-level statement body in an async IIFE", () => {
    const src = buildSandboxSource("return await page.list();", VERBS);
    expect(src).toContain("(async () => {");
    expect(src).toContain("return await page.list();");
  });

  it("detects an arrow-function body and calls it", () => {
    const src = buildSandboxSource("async () => 1", VERBS);
    expect(src).toContain("async () => 1");
    expect(src).toContain("__fn");
  });

  it("declares the page proxy with __invoke routing", () => {
    const src = buildSandboxSource("return 1;", VERBS);
    expect(src).toMatch(/__browsemode_invoke/);
    expect(src).toContain("Proxy");
  });

  it("declares the configured page verbs as functions on page", () => {
    const src = buildSandboxSource("return 1;", ["goto", "waitFor"]);
    expect(src).toContain("'goto'");
    expect(src).toContain("'waitFor'");
  });

  it("declares the tabs sub-namespace with the canonical verbs", () => {
    const src = buildSandboxSource("return 1;", VERBS);
    expect(src).toContain("tabs");
    expect(src).toContain("switch");
    expect(src).toContain("open");
    expect(src).toContain("close");
  });

  it("disables fetch inside the sandbox", () => {
    const src = buildSandboxSource("return 1;", VERBS);
    expect(src).toMatch(/fetch is disabled/);
  });
});
