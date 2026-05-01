import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  configure,
  getConfig,
  randomBrowserId,
  resetConfig,
} from "../src/config.js";

const ENV_KEYS = [
  "BROWSEMODE_CACHE_DIR",
  "BROWSEMODE_DEFAULT_BROWSER_ID",
  "BROWSEMODE_CHROME_PATH",
  "BROWSEMODE_CHROME_PORT",
  "BROWSEMODE_CHROME_ARGS",
  "BROWSEMODE_CHROME_PROFILE_DIR",
  "BROWSEMODE_SETTLE_MS",
  "BROWSEMODE_CDP_TIMEOUT_MS",
  "BROWSEMODE_PROBE_TIMEOUT_MS",
  "BROWSEMODE_NAV_TIMEOUT_MS",
  "BROWSEMODE_USER_AGENT",
  "BROWSEMODE_NO_SHIM",
  "BROWSEMODE_NO_STEALTH",
  "BROWSEMODE_DEBUG",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetConfig();
});

describe("config defaults", () => {
  it("returns sensible defaults when no env / overrides are set", () => {
    const cfg = getConfig();
    expect(cfg.cacheDir).toContain(".cache/browsemode");
    expect(cfg.defaultBrowserId).toBe("default");
    expect(cfg.chrome.port).toBe(9335);
    expect(cfg.chrome.extraArgs).toEqual([]);
    expect(cfg.defaults.settleMs).toBe(250);
    expect(cfg.defaults.cdpTimeoutMs).toBe(30_000);
    expect(cfg.defaults.shim).toBe("auto");
    expect(cfg.defaults.stealth).toBe(true);
    expect(cfg.onEvent).toBeUndefined();
  });
});

describe("env vars override defaults", () => {
  it("BROWSEMODE_CACHE_DIR", () => {
    process.env.BROWSEMODE_CACHE_DIR = "/var/lib/browsemode";
    resetConfig();
    expect(getConfig().cacheDir).toBe("/var/lib/browsemode");
  });

  it("BROWSEMODE_DEFAULT_BROWSER_ID", () => {
    process.env.BROWSEMODE_DEFAULT_BROWSER_ID = "container-1";
    resetConfig();
    expect(getConfig().defaultBrowserId).toBe("container-1");
  });

  it("BROWSEMODE_CHROME_PATH + PORT + ARGS", () => {
    process.env.BROWSEMODE_CHROME_PATH = "/usr/bin/chromium";
    process.env.BROWSEMODE_CHROME_PORT = "9445";
    process.env.BROWSEMODE_CHROME_ARGS = "--no-sandbox,--disable-dev-shm-usage";
    resetConfig();
    const c = getConfig().chrome;
    expect(c.path).toBe("/usr/bin/chromium");
    expect(c.port).toBe(9445);
    expect(c.extraArgs).toEqual(["--no-sandbox", "--disable-dev-shm-usage"]);
  });

  it("BROWSEMODE_NO_SHIM=1 disables shim auto-detect", () => {
    process.env.BROWSEMODE_NO_SHIM = "1";
    resetConfig();
    expect(getConfig().defaults.shim).toBe(false);
  });

  it("BROWSEMODE_NO_STEALTH=1 disables stealth", () => {
    process.env.BROWSEMODE_NO_STEALTH = "1";
    resetConfig();
    expect(getConfig().defaults.stealth).toBe(false);
  });

  it("BROWSEMODE_DEBUG=1 wires a console subscriber on onEvent", () => {
    process.env.BROWSEMODE_DEBUG = "1";
    resetConfig();
    expect(typeof getConfig().onEvent).toBe("function");
  });

  it("integer envs that fail to parse fall back to defaults", () => {
    process.env.BROWSEMODE_CHROME_PORT = "garbage";
    resetConfig();
    expect(getConfig().chrome.port).toBe(9335);
  });

  it("timeout envs reject 0 / negative / NaN as a footgun guard", () => {
    // Pattern #1: a value of 0 in CDP send() means "no timeout" which
    // silently wedges the agent on a dead-but-TCP-alive WebSocket.
    // Mirror browser-use's _coerce_valid_timeout: anything not a
    // finite positive integer falls back to the default.
    const origWrite = process.stderr.write;
    const warnings: string[] = [];
    (process.stderr.write as any) = (chunk: any) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      for (const bad of ["0", "-1", "NaN", "abc"]) {
        process.env.BROWSEMODE_CDP_TIMEOUT_MS = bad;
        resetConfig();
        expect(getConfig().defaults.cdpTimeoutMs).toBe(30_000);
      }
      // At least one warning was emitted naming the env var + bad value.
      expect(
        warnings.some((w) => w.includes("BROWSEMODE_CDP_TIMEOUT_MS")),
      ).toBe(true);
    } finally {
      (process.stderr.write as any) = origWrite;
    }
  });
});

describe("configure() overrides everything", () => {
  it("merges top-level fields", () => {
    configure({ cacheDir: "/tmp/x", defaultBrowserId: "main" });
    const c = getConfig();
    expect(c.cacheDir).toBe("/tmp/x");
    expect(c.defaultBrowserId).toBe("main");
  });

  it("merges nested chrome / defaults / cookies field-by-field", () => {
    configure({ chrome: { extraArgs: ["--no-sandbox"] } });
    const c = getConfig();
    expect(c.chrome.extraArgs).toEqual(["--no-sandbox"]);
    expect(c.chrome.port).toBe(9335); // other fields preserved
  });

  it("supports setting onEvent and clearing it again", () => {
    const fn = () => {};
    configure({ onEvent: fn });
    expect(getConfig().onEvent).toBe(fn);
    configure({ onEvent: undefined });
    expect(getConfig().onEvent).toBeUndefined();
  });

  it("env+configure compose: configure wins", () => {
    process.env.BROWSEMODE_CHROME_PORT = "9445";
    resetConfig();
    expect(getConfig().chrome.port).toBe(9445);
    configure({ chrome: { port: 9999 } });
    expect(getConfig().chrome.port).toBe(9999);
  });
});

describe("randomBrowserId", () => {
  it("returns an 8-char hex-like string", () => {
    const id = randomBrowserId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(4);
    expect(id.length).toBeLessThanOrEqual(16);
  });

  it("is unique across calls", () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(randomBrowserId());
    expect(seen.size).toBe(50);
  });
});
