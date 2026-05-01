import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, resetConfig } from "../src/config.js";
import {
  clearBrowser,
  listBrowsers,
  loadBrowser,
  type PersistedBrowser,
  pathForBrowser,
  saveBrowser,
} from "../src/orchestration/persistence.js";

let tmpDir: string;

beforeEach(() => {
  resetConfig();
  tmpDir = mkdtempSync(join(tmpdir(), "browsemode-test-"));
  configure({ cacheDir: tmpDir });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetConfig();
});

const sample = (id = "default"): PersistedBrowser => ({
  v: 1,
  id,
  ts: 1_700_000_000_000,
  browserWsUrl: "ws://localhost:9333/devtools/browser/abc",
  host: "localhost",
  port: 9333,
  product: "Obscura/0.1",
  shimEnabled: true,
  activeTargetId: "T1",
  tabs: [{ targetId: "T1", url: "https://example.com", title: "Example" }],
});

describe("persistence", () => {
  it("save then load roundtrips the snapshot", () => {
    saveBrowser(sample());
    expect(loadBrowser("default")).toEqual(sample());
  });

  it("loadBrowser returns null when no file exists", () => {
    expect(loadBrowser("does-not-exist")).toBeNull();
  });

  it("clearBrowser removes the file", () => {
    saveBrowser(sample());
    clearBrowser("default");
    expect(loadBrowser("default")).toBeNull();
  });

  it("clearBrowser is idempotent on missing file", () => {
    expect(() => clearBrowser("never-existed")).not.toThrow();
  });

  it("pathForBrowser points under the configured cache dir", () => {
    const p = pathForBrowser("research");
    expect(p).toContain(tmpDir);
    expect(p).toContain("browsers");
    expect(p.endsWith("research.json")).toBe(true);
  });

  it("file is created at pathForBrowser(id) on save", () => {
    saveBrowser(sample("research"));
    expect(existsSync(pathForBrowser("research"))).toBe(true);
  });

  it("loadBrowser survives a corrupt file by returning null", () => {
    saveBrowser(sample());
    Bun.write(pathForBrowser("default"), "{not json");
    expect(loadBrowser("default")).toBeNull();
  });

  it("listBrowsers returns every snapshot, newest first", () => {
    saveBrowser({ ...sample("a"), ts: 100 });
    saveBrowser({ ...sample("b"), ts: 300 });
    saveBrowser({ ...sample("c"), ts: 200 });
    const ids = listBrowsers().map((s) => s.id);
    expect(ids).toEqual(["b", "c", "a"]);
  });

  it("listBrowsers returns [] when the dir doesn't exist", () => {
    expect(listBrowsers()).toEqual([]);
  });

  it("two browsers don't collide", () => {
    saveBrowser(sample("research"));
    saveBrowser({ ...sample("scratch"), port: 9999 });
    expect(loadBrowser("research")?.port).toBe(9333);
    expect(loadBrowser("scratch")?.port).toBe(9999);
  });

  it("configure({cacheDir}) is honored at the next call", () => {
    saveBrowser(sample("a"));
    const newDir = mkdtempSync(join(tmpdir(), "browsemode-other-"));
    try {
      configure({ cacheDir: newDir });
      expect(loadBrowser("a")).toBeNull();
      saveBrowser(sample("a"));
      expect(existsSync(pathForBrowser("a"))).toBe(true);
      expect(pathForBrowser("a")).toContain(newDir);
    } finally {
      rmSync(newDir, { recursive: true, force: true });
    }
  });
});
