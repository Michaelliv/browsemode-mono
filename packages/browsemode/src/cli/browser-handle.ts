// "Get me a browser to operate on." Most page commands (exec, scan,
// goto) need a Browser handle — either by reattaching to a saved one
// or by opening a fresh one if it doesn't exist yet.
//
// Resolution order:
//   1. Browsemode.restore(id)  — reattach if saved
//   2. Browsemode.openWithFallback(...) — open a fresh one
//
// This is the heart of what makes the CLI's `--browser <id>` flag work.

import { Browsemode } from "../index.js";
import type { Browser } from "../browser/browser.js";
import type { GlobalFlags } from "./flags.js";

export interface EnsureOpts extends GlobalFlags {
  /** URL to navigate to on first-open. Skipped on reattach. */
  url?: string;
  /** waitUntil for first-open navigation. */
  waitUntil?: "domcontentloaded" | "load" | "networkidle0" | "networkidle2";
}

/**
 * Reattach to the browser id, or open a fresh one. Bus events are
 * forwarded by config.onEvent (set by main.ts based on global flags),
 * so callers don't need to subscribe.
 */
export async function ensureBrowser(
  flags: EnsureOpts
): Promise<{ browser: Browser; opened: boolean; fellBack: boolean }> {
  const id = flags.browser ?? Browsemode.config().defaultBrowserId;

  // Reattach path. Restore throws on missing/stale; we fall through.
  try {
    const browser = await Browsemode.restore(id);
    return { browser, opened: false, fellBack: false };
  } catch {
    // fall through
  }

  // Fresh open.
  const result = await Browsemode.openWithFallback({
    primary: {
      id,
      host: flags.host,
      port: flags.port,
    },
    fallback: flags.fallback === "off" ? "off" : "chrome",
    url: flags.url ?? "about:blank",
    page: { waitUntil: flags.waitUntil },
  });
  return {
    browser: result.browser,
    opened: true,
    fellBack: result.fellBack,
  };
}
