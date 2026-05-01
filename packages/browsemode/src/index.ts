// browsemode — code mode for the web.
//
// Public SDK surface. Most callers want `Browsemode.connect()` or
// `Browsemode.openWithFallback()` and a Browser handle.

export type { BrowserOpts, NewPageOpts } from "./browser/browser.js";
export { Browser, randomBrowserId } from "./browser/browser.js";
export type { ChromeStatus, EnsureChromeOpts } from "./browser/chrome.js";
export {
  chromeStatus,
  ensureChrome,
  findChrome,
  stopChrome,
} from "./browser/chrome.js";
export type { ChromeCookie, ReadCookiesOpts } from "./browser/cookies.js";
export {
  clearCookieCache,
  readChromeCookies,
  toCdpCookies,
} from "./browser/cookies.js";
export type { BusEvent, BusEventKind, BusListener } from "./bus.js";
export { Bus } from "./bus.js";
export type { CdpEventHandler, CdpSendOpts } from "./cdp/client.js";
export { CDP } from "./cdp/client.js";
export { Session } from "./cdp/session.js";
export type { BrowsemodeConfig, PartialConfig } from "./config.js";
export { configure, getConfig, resetConfig } from "./config.js";
export {
  meetsExpectation,
  parseExpectationSpec,
} from "./orchestration/expectation.js";
export type {
  OpenResult,
  OpenWithFallbackOpts,
} from "./orchestration/fallback.js";
export { openWithFallback } from "./orchestration/fallback.js";
export type { PersistedBrowser } from "./orchestration/persistence.js";
export type { Watchdog, WatchdogFactory } from "./orchestration/watchdogs/base.js";
export { PopupsWatchdog } from "./orchestration/watchdogs/popups.js";
export {
  clearBrowser,
  listBrowsers,
  loadBrowser,
  pathForBrowser,
  saveBrowser,
} from "./orchestration/persistence.js";
export type { MarkdownSection } from "./page/markdown.js";
export {
  extractSections,
  htmlToMarkdown,
  urlToMarkdown,
} from "./page/markdown.js";
export type { PageOpts } from "./page/page.js";
export { Page } from "./page/page.js";
export { Sandbox } from "./sandbox/sandbox.js";

export type {
  ElementInfo,
  ElementKind,
  ExecOpts,
  ExecuteResult,
  Expectation,
  ExpectResult,
  NavOpts,
  ScanResult,
  ScrollOpts,
  ViewportOpts,
  WaitForOpts,
  WaitForResult,
  WaitUntil,
} from "./types.js";

import { Browser, type BrowserOpts } from "./browser/browser.js";
import { Bus } from "./bus.js";
import { CDP } from "./cdp/client.js";
import { Session } from "./cdp/session.js";
import {
  type BrowsemodeConfig,
  configure,
  getConfig,
  type PartialConfig,
} from "./config.js";
import {
  type OpenResult,
  type OpenWithFallbackOpts,
  openWithFallback,
} from "./orchestration/fallback.js";
import {
  clearBrowser,
  listBrowsers,
  loadBrowser,
  type PersistedBrowser,
} from "./orchestration/persistence.js";
import { Page } from "./page/page.js";

/**
 * The convenience namespace. Mirrors the common ways to start, plus the
 * config and persistence helpers.
 *
 *   Browsemode.connect({ port: 9333 })            — attach to running CDP
 *   Browsemode.launch()                            — start managed Chrome
 *   Browsemode.openWithFallback({ url, primary }) — try primary, fall back
 *   Browsemode.restore("research")                 — reattach by id
 *   Browsemode.listBrowsers()                      — every saved snapshot
 *   Browsemode.forgetBrowser("scratch")           — drop a snapshot file
 *   Browsemode.configure({ cacheDir, chrome, ... }) — global config
 *   Browsemode.config()                            — read current config
 */
export const Browsemode = {
  connect: (opts?: BrowserOpts) => Browser.connect(opts),
  launch: (opts?: BrowserOpts) => Browser.launch(opts),
  openWithFallback: (opts: OpenWithFallbackOpts): Promise<OpenResult> =>
    openWithFallback(opts),

  /**
   * Reattach to a previously-saved browser. Throws if the snapshot is
   * missing/stale or has no live tabs. Tabs that were closed externally
   * between save and restore are silently skipped.
   */
  restore: async (id: string): Promise<Browser> => {
    const snapshot = loadBrowser(id);
    if (!snapshot) {
      throw new Error(
        `no saved browser with id '${id}' (looked in ${getConfig().cacheDir}/browsers)`,
      );
    }

    // Verify the saved browser is still listening (probe timeout from config
    // so a hung browser doesn't wedge the caller).
    const probe = await fetch(
      `http://${snapshot.host}:${snapshot.port}/json/version`,
      { signal: AbortSignal.timeout(getConfig().defaults.probeTimeoutMs) },
    ).catch((e: any) => {
      throw new Error(
        `saved browser '${id}' points at ${snapshot.host}:${snapshot.port} but it's not reachable (${e?.message ?? e})`,
      );
    });
    if (!probe.ok) {
      throw new Error(
        `saved browser '${id}' probe returned ${probe.status} from ${snapshot.host}:${snapshot.port}`,
      );
    }

    // Build the Browser by hand — we want the saved WebSocket URL exactly
    // (Chrome's UUID path may change across restarts; we trust the snapshot).
    const cdp = await CDP.connect(snapshot.browserWsUrl);
    const b = Object.assign(Object.create(Browser.prototype), {
      id,
      product: snapshot.product,
      isObscura: /obscura/i.test(snapshot.product),
      shimEnabled: snapshot.shimEnabled,
      stealthEnabled: true,
      cdp,
      bus: new Bus(),
      settleMs: getConfig().defaults.settleMs,
      _browserWsUrl: snapshot.browserWsUrl,
      _host: snapshot.host,
      _port: snapshot.port,
      _pages: new Map<string, Page>(),
      _activeTargetId: null as string | null,
      _watchdogDetachers: [] as Array<() => void>,
    }) as Browser;

    for (const tab of snapshot.tabs) {
      const attach = await cdp
        .send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: tab.targetId,
          flatten: true,
        })
        .catch(() => null);
      if (!attach) continue; // closed externally; skip
      const session = new Session(cdp, attach.sessionId);
      const page = await Page._create(b, tab.targetId, session, {
        settleMs: getConfig().defaults.settleMs,
        autoScan: true,
      });
      page.url = tab.url;
      page.title = tab.title;
      (b as any)._pages.set(tab.targetId, page);
    }

    if ((b as any)._pages.size === 0) {
      cdp.close();
      throw new Error(`saved browser '${id}' has no live tabs`);
    }
    (b as any)._activeTargetId = (b as any)._pages.has(snapshot.activeTargetId)
      ? snapshot.activeTargetId
      : (b as any)._pages.keys().next().value;

    // Install default watchdogs against the restored Browser. Each
    // watchdog walks the existing pages map at attach time so popups
    // (etc) work on tabs that pre-existed before this restore.
    const { PopupsWatchdog: PW } = await import(
      "./orchestration/watchdogs/popups.js"
    );
    const watchdogs = [new PW()];
    for (const wd of watchdogs) {
      try {
        const detach = await wd.attach(b);
        (b as any)._watchdogDetachers.push(detach);
        b.bus.emit({ kind: "watchdog.attached", name: wd.name });
      } catch (e: any) {
        b.bus.emit({
          kind: "watchdog.error",
          name: wd.name,
          reason: `attach failed: ${e?.message ?? e}`,
        });
      }
    }

    b.bus.emit({ kind: "session.restored", path: getConfig().cacheDir });
    return b;
  },

  /** Every browser snapshot on disk, newest first. */
  listBrowsers: (): PersistedBrowser[] => listBrowsers(),

  /** Delete a snapshot file. Live browser is untouched. */
  forgetBrowser: (id: string): void => clearBrowser(id),

  /**
   * Read the current global config. Returns the live object — treat as
   * read-only; mutate via configure().
   */
  config: (): BrowsemodeConfig => getConfig(),

  /** Set / merge global config. Persists for the process lifetime. */
  configure: (partial: PartialConfig): void => configure(partial),
} as const;
