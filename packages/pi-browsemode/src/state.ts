// Singleton Browser for the pi-browse extension.
//
// pi calls tools one at a time. We keep one Browser across calls, so
// state (tabs, scroll position, cookies) survives between tool
// invocations the same way it does for a human's open browser
// window. The Browser is also persisted to disk via Browsemode's
// snapshot, so a pi --resume picks up exactly where you were.
//
// The browser id is configurable. Default is "pi-browse" — multiple
// pi sessions on different projects can pin different ids and stay
// isolated.

import { Browsemode, type Browser } from "browsemode";
import { resolveBrowserProvider } from "./providers.js";

export const DEFAULT_BROWSER_ID =
  process.env.PI_BROWSE_BROWSER_ID ?? "pi-browse";

let _browser: Browser | null = null;
let _browserId: string = DEFAULT_BROWSER_ID;

export function getBrowserId(): string {
  return _browserId;
}

export function setBrowserId(id: string): void {
  // If the id changes mid-session, drop the cached handle so the next
  // getBrowser() call attaches to the right snapshot. Any open
  // tabs on the previous id stay alive on disk; user can reattach
  // explicitly with /browse-switch.
  if (_browser && id !== _browserId) {
    _browser = null;
  }
  _browserId = id;
}

/**
 * Restore the saved browser, or fail with a clear message. The
 * extension's tool body should call ensureBrowser() instead — that
 * one falls through to a fresh launch.
 */
export async function attachBrowser(): Promise<Browser> {
  if (_browser) return _browser;
  _browser = await Browsemode.restore(_browserId);
  return _browser;
}

/**
 * Best-effort attach. If the snapshot is missing or stale, opens a
 * fresh primary at about:blank. The agent navigates wherever it
 * wants once it has the handle.
 *
 * Provider selection mirrors pi-websearch's router pattern:
 *   - PI_BROWSE_PROVIDER=chrome|obscura|remote-cdp selects explicitly.
 *   - Legacy PI_BROWSE_BACKEND is still accepted as an alias.
 *   - Without either, remote-cdp wins when its env vars are present,
 *     otherwise managed Chrome is used.
 */
export async function ensureBrowser(): Promise<Browser> {
  const provider = resolveBrowserProvider();
  if (_browser) {
    if (provider.accepts(_browser) && (await isUsable(_browser))) {
      return _browser;
    }
    await _browser.close().catch(() => undefined);
    _browser = null;
  }
  try {
    const restored = await Browsemode.restore(_browserId);
    if (provider.accepts(restored) && (await isUsable(restored))) {
      _browser = restored;
      return _browser;
    }
    await restored.close().catch(() => undefined);
  } catch {
    // No usable snapshot — open fresh.
  }

  _browser = await provider.open(_browserId);
  return _browser;
}

/**
 * Drop the cached handle. Snapshot stays on disk so the next
 * ensureBrowser() reattaches.
 */
export async function detachBrowser(): Promise<void> {
  if (!_browser) return;
  try {
    await _browser.detach();
  } finally {
    _browser = null;
  }
}

/**
 * Tear down: close every tab, drop the snapshot, close the WS.
 * After close(), ensureBrowser() opens a fresh browser.
 */
export async function closeBrowser(): Promise<void> {
  if (!_browser) {
    Browsemode.forgetBrowser(_browserId);
    return;
  }
  try {
    await _browser.close();
  } finally {
    _browser = null;
  }
}

export function currentBrowser(): Browser | null {
  return _browser;
}

async function isUsable(browser: Browser): Promise<boolean> {
  try {
    const result = await browser.exec("return await page.title()", {
      timeoutMs: 3000,
    });
    return !result.error;
  } catch {
    return false;
  }
}
