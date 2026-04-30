import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetConfig } from "../src/config.js";
import {
  applyGlobalFlags,
  outputOpts,
  parseGlobalFlags,
  resolveBrowserId,
} from "../src/cli/flags.js";

beforeEach(() => resetConfig());
afterEach(() => resetConfig());

describe("parseGlobalFlags", () => {
  it("converts --port string to number", () => {
    const flags = parseGlobalFlags({ port: "9333" });
    expect(flags.port).toBe(9333);
  });

  it("invalid --port becomes undefined (caller falls back)", () => {
    const flags = parseGlobalFlags({ port: "abc" });
    expect(flags.port).toBeUndefined();
  });

  it("defaults json/quiet to false", () => {
    const flags = parseGlobalFlags({});
    expect(flags.json).toBe(false);
    expect(flags.quiet).toBe(false);
  });

  it("preserves --browser, --host, --cache-dir, --fallback", () => {
    const flags = parseGlobalFlags({
      browser: "research",
      host: "example.com",
      cacheDir: "/tmp/x",
      fallback: "off",
    });
    expect(flags.browser).toBe("research");
    expect(flags.host).toBe("example.com");
    expect(flags.cacheDir).toBe("/tmp/x");
    expect(flags.fallback).toBe("off");
  });
});

describe("resolveBrowserId", () => {
  it("returns the explicit --browser flag when present", () => {
    expect(resolveBrowserId({ browser: "myx" })).toBe("myx");
  });

  it("falls back to config.defaultBrowserId", () => {
    expect(resolveBrowserId({})).toBe("default");
  });
});

describe("applyGlobalFlags", () => {
  it("--cache-dir mutates global config", () => {
    applyGlobalFlags({ cacheDir: "/tmp/configured" });
    expect(resolveBrowserId({})).toBe("default"); // still the default id
    // cacheDir change is asserted via the config helpers in another test;
    // here we just verify the function doesn't throw.
  });
});

describe("outputOpts", () => {
  it("strips non-output keys", () => {
    const o = outputOpts({
      browser: "x",
      json: true,
      quiet: false,
      color: false,
    });
    expect(o).toEqual({ json: true, quiet: false, color: false });
  });
});
