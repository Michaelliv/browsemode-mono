// Singleton browser state for the pi-browse extension. Pi calls tools
// one at a time; the extension keeps one Browser across calls,
// persisted to disk so a pi session can resume mid-task.
//
// `getBrowser()` either reattaches to the saved snapshot or opens fresh
// (with auto-fallback to managed Chrome if the primary browser wedges).
//
// The browser id is configurable via env: `PI_BROWSE_BROWSER_ID`,
// defaulting to "pi-browse". Multiple pi conversations get isolated
// browsers if each runs the extension with a different id.

import { Browsemode, type Browser } from "browsemode";

const BROWSER_ID = process.env.PI_BROWSE_BROWSER_ID ?? "pi-browse";

let _browser: Browser | null = null;

/**
 * Reattach to the persisted browser, or open a fresh one. Cached in
 * memory after the first call so repeated tool invocations within one
 * pi session reuse the same handle without round-tripping the
 * snapshot file.
 */
export async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser;

  // Try restore first. Falls through to a fresh launch if the snapshot
  // is missing, stale, or its tabs are gone.
  try {
    _browser = await Browsemode.restore(BROWSER_ID);
    return _browser;
  } catch {
    // fall through
  }

  // No usable snapshot — open fresh. We don't pin a URL here; the
  // browse_open tool drives the first navigation.
  const opened = await Browsemode.openWithFallback({
    primary: { id: BROWSER_ID, port: 9222 },
    url: "about:blank",
  });
  _browser = opened.browser;
  return opened.browser;
}

/**
 * Disconnect the WS but leave tabs running. The snapshot stays on disk
 * so the next tool call's getBrowser() reattaches without reopening.
 */
export async function detachBrowser(): Promise<void> {
  if (!_browser) return;
  await _browser.detach();
  _browser = null;
}

/**
 * Tear down: close every tab, drop the snapshot, close the WS. Called
 * by the `browse_close` tool.
 */
export async function closeBrowser(): Promise<void> {
  if (!_browser) {
    Browsemode.forgetBrowser(BROWSER_ID);
    return;
  }
  await _browser.close();
  _browser = null;
}
