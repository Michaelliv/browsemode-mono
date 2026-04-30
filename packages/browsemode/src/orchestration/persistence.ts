// Persistent browser snapshots. Each Browser writes itself to
// `<cacheDir>/browsers/<id>.json` after every scan; `Browsemode.restore(id)`
// reattaches to the live tabs.
//
// Multi-browser: any number of named browsers can coexist on disk.
// Each gets its own snapshot file. listBrowsers() walks the directory.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";
import type { ScanResult } from "../types.js";

export interface PersistedBrowser {
  v: 1;
  id: string;
  /** Wall-clock when last written, ms since epoch. */
  ts: number;
  /** ws://host:port/devtools/browser[/uuid]. */
  browserWsUrl: string;
  host: string;
  port: number;
  product: string;
  shimEnabled: boolean;
  activeTargetId: string;
  tabs: Array<{ targetId: string; url: string; title: string }>;
  /** Last scan, so the catalog can be rebuilt without rescanning. */
  lastScan?: ScanResult;
}

function browsersDir(): string {
  return join(getConfig().cacheDir, "browsers");
}

function browserPath(id: string): string {
  return join(browsersDir(), `${id}.json`);
}

/** Path for a specific browser's snapshot. Visible for diagnostics. */
export function pathForBrowser(id: string): string {
  return browserPath(id);
}

export function saveBrowser(state: PersistedBrowser): void {
  const dir = browsersDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(browserPath(state.id), JSON.stringify(state, null, 2));
}

export function loadBrowser(id: string): PersistedBrowser | null {
  const p = browserPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as PersistedBrowser;
  } catch {
    // Corrupt file (truncated write, manual edit, version skew). Caller
    // gets null and falls back to opening fresh.
    return null;
  }
}

export function clearBrowser(id: string): void {
  const p = browserPath(id);
  if (existsSync(p)) unlinkSync(p);
}

/** Every saved browser snapshot, newest first. Skips corrupt files. */
export function listBrowsers(): PersistedBrowser[] {
  const dir = browsersDir();
  if (!existsSync(dir)) return [];
  const out: PersistedBrowser[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(
        JSON.parse(readFileSync(join(dir, f), "utf-8")) as PersistedBrowser
      );
    } catch {
      // skip
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
