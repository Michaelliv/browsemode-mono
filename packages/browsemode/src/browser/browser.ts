// Browser owns the CDP connection and the set of Pages running on it.
// One CDP socket, many Pages (tabs). Pages do their own scanning and
// dispatch — Browser's job is attach/detach plus the few browser-level
// concerns (tabs.* sandbox routing, cookie injection, persistence,
// close).
//
// Ergonomics: the Browser also exposes every Page method as sugar that
// routes to `activePage`. Most callers never touch Page directly:
//
//   const browser = await Browsemode.connect({ port: 9333 });
//   await browser.newPage({ url: "https://example.com" });
//   await browser.click("signInButton");
//   await browser.exec("return await page.list();");
//
// Multi-tab when you need it:
//
//   const t = await browser.newPage({ url: "..." });
//   browser.switchTo(t.targetId);

import { Bus } from "../bus.js";
import { CDP } from "../cdp/client.js";
import { Session } from "../cdp/session.js";
import { getConfig, randomBrowserId } from "../config.js";
import {
  clearBrowser,
  type PersistedBrowser,
  pathForBrowser,
  saveBrowser,
} from "../orchestration/persistence.js";
import type { Watchdog } from "../orchestration/watchdogs/base.js";
import { DownloadsWatchdog } from "../orchestration/watchdogs/downloads.js";
import { PopupsWatchdog } from "../orchestration/watchdogs/popups.js";
import type { MarkdownSection } from "../page/markdown.js";
import { Page } from "../page/page.js";
import { SHIM_SCRIPT } from "../page/shim.js";
import { STEALTH_SCRIPT } from "../page/stealth.js";
import type {
  ElementInfo,
  ExecOpts,
  ExecuteResult,
  NavOpts,
  ScanResult,
  ScrollOpts,
  ViewportOpts,
  WaitForOpts,
  WaitForResult,
  WaitUntil,
} from "../types.js";
import { ensureChrome } from "./chrome.js";
import { type ChromeCookie, toCdpCookies } from "./cookies.js";

export interface BrowserOpts {
  /**
   * Stable id for this browser. Persisted snapshots, restore semantics,
   * and Browsemode.listBrowsers() all key on this. Default: config.defaultBrowserId
   * (which itself defaults to `"default"`). Pass `randomBrowserId()` for
   * a fresh ephemeral id.
   */
  id?: string;
  host?: string;
  port?: number;
  /**
   * Inject the obscura DOM-shim preload on every page. Default config.defaults.shim
   * which is "auto" (on for obscura, off for Chrome). `true` / `false`
   * forces either way.
   */
  shim?: boolean;
  /** Inject the stealth preload. Default config.defaults.stealth (true). */
  stealth?: boolean;
  /** ms to settle after a navigating verb. Default config.defaults.settleMs. */
  settleMs?: number;
  /** Event bus. If omitted, a fresh silent bus is created. */
  bus?: Bus;
  /**
   * Watchdogs to install. If omitted, the default set is used
   * (currently: popups). Pass `[]` to disable all watchdogs. Pass
   * your own list to opt into specific ones only.
   */
  watchdogs?: Watchdog[];
}

/**
 * The default set every Browser gets unless overridden via
 * BrowserOpts.watchdogs. New watchdogs land here as they're
 * implemented (permissions, downloads, crash, ...). Each is a
 * factory so instances are per-Browser, never shared across
 * Browsers.
 */
function defaultWatchdogs(): Watchdog[] {
  return [new PopupsWatchdog(), new DownloadsWatchdog()];
}

export interface NewPageOpts {
  /** Open a target with this URL on creation. Default about:blank. */
  url?: string;
  /** Lifecycle event to wait for on first navigation. Default domcontentloaded. */
  waitUntil?: WaitUntil;
  /** Override settleMs for this page. */
  settleMs?: number;
  /** Auto-scan after navigation. Default true. */
  autoScan?: boolean;
}

export class Browser {
  /** Stable id used for persistence and listBrowsers(). */
  id = "";
  product = "";
  isObscura = false;
  shimEnabled = false;
  stealthEnabled = true;
  cdp!: CDP;
  bus!: Bus;
  /** ms to settle after a navigating verb. Pages inherit this. */
  settleMs = 250;

  // Persistence: retained for snapshot() to write back.
  private _browserWsUrl = "";
  private _host = "localhost";
  private _port = 9222;

  private _pages = new Map<string, Page>();
  private _activeTargetId: string | null = null;
  private _watchdogDetachers: Array<() => void> = [];

  private constructor() {}

  // ── lifecycle ─────────────────────────────────────

  static async connect(opts: BrowserOpts = {}): Promise<Browser> {
    const cfg = getConfig();
    const host = opts.host ?? "localhost";
    const port = opts.port ?? 9222;

    // /json/version probe with a hard ceiling. Without this an obscura
    // wedged in a busy loop wedges the caller too — even the probe would
    // hang forever because the runtime can't service incoming requests.
    const versionRes = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(cfg.defaults.probeTimeoutMs),
    }).catch((e: any) => {
      throw new Error(
        `Couldn't reach CDP at http://${host}:${port}/json/version: ${e?.message ?? e}. ` +
          "Is the browser running and responsive?",
      );
    });
    if (!versionRes.ok) {
      throw new Error(
        `CDP probe at http://${host}:${port}/json/version returned ${versionRes.status}`,
      );
    }
    const version = (await versionRes.json()) as {
      webSocketDebuggerUrl?: string;
      Browser?: string;
    };

    const b = new Browser();
    b.id = opts.id ?? cfg.defaultBrowserId;
    b.product = version.Browser ?? "";
    b.isObscura = /obscura/i.test(b.product);
    b.shimEnabled =
      opts.shim ??
      (cfg.defaults.shim === "auto" ? b.isObscura : cfg.defaults.shim);
    b.stealthEnabled = opts.stealth ?? cfg.defaults.stealth;
    b.bus = opts.bus ?? new Bus();
    b.settleMs = opts.settleMs ?? cfg.defaults.settleMs;
    b._host = host;
    b._port = port;
    b._browserWsUrl =
      version.webSocketDebuggerUrl ?? `ws://${host}:${port}/devtools/browser`;
    b.cdp = await CDP.connect(b._browserWsUrl);

    // Install watchdogs after CDP is up but before any page exists,
    // so the page.created emission for the first newPage() reaches them.
    const watchdogs = opts.watchdogs ?? defaultWatchdogs();
    for (const wd of watchdogs) {
      try {
        const detach = await wd.attach(b);
        b._watchdogDetachers.push(detach);
        b.bus.emit({ kind: "watchdog.attached", name: wd.name });
      } catch (e: any) {
        b.bus.emit({
          kind: "watchdog.error",
          name: wd.name,
          reason: `attach failed: ${e?.message ?? e}`,
        });
      }
    }
    return b;
  }

  /** Tear down every installed watchdog. Idempotent. */
  private detachWatchdogs(): void {
    while (this._watchdogDetachers.length) {
      const fn = this._watchdogDetachers.pop()!;
      try {
        fn();
      } catch {
        // Per-watchdog detach errors don't block the rest.
      }
    }
  }

  static async launch(opts: BrowserOpts = {}): Promise<Browser> {
    const port = await ensureChrome();
    return Browser.connect({ ...opts, host: "localhost", port });
  }

  /** Open a new tab. Becomes the active page. */
  async newPage(opts: NewPageOpts = {}): Promise<Page> {
    const cfg = getConfig();
    const { targetId } = await this.cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const { sessionId } = await this.cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    const session = new Session(this.cdp, sessionId);

    // Auto-attach to nested OOPIF targets so refreshFrames sees them.
    // Without this, cross-origin iframes are invisible to scan() because
    // their JS lives in a different process.
    await session
      .send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      .catch(() => undefined);

    // Preloads must register BEFORE Page.navigate so they land on the
    // next document.
    if (this.shimEnabled) {
      await session
        .send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM_SCRIPT })
        .catch(() => undefined);
    }
    if (this.stealthEnabled) {
      await session
        .send("Page.addScriptToEvaluateOnNewDocument", {
          source: STEALTH_SCRIPT,
        })
        .catch(() => undefined);
    }

    // Drop Chrome's "HeadlessChrome" UA token. obscura already reports a
    // clean Chrome-like UA, leave it alone.
    if (!this.isObscura) {
      await session
        .send("Network.setUserAgentOverride", {
          userAgent: cfg.defaults.userAgent,
          acceptLanguage: "en-US,en;q=0.9",
          platform: "MacIntel",
        })
        .catch(() => undefined);
    }

    const page = await Page._create(this, targetId, session, {
      settleMs: opts.settleMs ?? this.settleMs,
      autoScan: opts.autoScan ?? true,
    });
    this._pages.set(targetId, page);
    this._activeTargetId = targetId;
    // Watchdogs subscribe to this to attach per-page CDP listeners.
    // Fire AFTER the page is registered so a watchdog handler that
    // looks up the page by targetId finds it.
    this.bus.emit({
      kind: "page.created",
      targetId,
      sessionId: session.id,
    });

    if (opts.url && opts.url !== "about:blank") {
      await page.dispatch("goto", {
        url: opts.url,
        waitUntil: opts.waitUntil,
      });
      if (opts.autoScan !== false) {
        await new Promise((r) => setTimeout(r, page.settleMs));
        await page.scan();
      }
    }
    return page;
  }

  // ── page management ───────────────────────────────

  get pages(): ReadonlyMap<string, Page> {
    return this._pages;
  }

  get activePage(): Page {
    if (!this._activeTargetId) {
      throw new Error(
        `browser '${this.id}' has no open pages — call browser.newPage() first`,
      );
    }
    const p = this._pages.get(this._activeTargetId);
    if (!p) throw new Error("Active page is gone");
    return p;
  }

  switchTo(targetId: string): void {
    if (!this._pages.has(targetId)) {
      throw new Error(
        `switchTo: unknown id '${targetId}'. Open: ${[...this._pages.keys()].join(", ")}`,
      );
    }
    this._activeTargetId = targetId;
  }

  async closePage(targetId: string): Promise<void> {
    if (!this._pages.has(targetId)) return;
    await this.cdp
      .send("Target.closeTarget", { targetId })
      .catch(() => undefined);
    this._pages.delete(targetId);
    if (this._activeTargetId === targetId) {
      const next = this._pages.keys().next().value;
      this._activeTargetId = next ?? null;
    }
    this.bus.emit({ kind: "page.closed", targetId });
  }

  // ── persistence ───────────────────────────────────

  /** Build the on-disk snapshot for this browser and write it. */
  snapshot(): PersistedBrowser {
    const state: PersistedBrowser = {
      v: 1,
      id: this.id,
      ts: Date.now(),
      browserWsUrl: this._browserWsUrl,
      host: this._host,
      port: this._port,
      product: this.product,
      shimEnabled: this.shimEnabled,
      activeTargetId: this._activeTargetId ?? "",
      tabs: [...this._pages.values()].map((p) => ({
        targetId: p.targetId,
        url: p.url,
        title: p.title,
      })),
      lastScan: this._activeTargetId ? this.activePage.lastScan : undefined,
    };
    saveBrowser(state);
    this.bus.emit({ kind: "session.persisted", path: pathForBrowser(this.id) });
    return state;
  }

  /**
   * Disconnect the WS but leave the CDP-side tabs alive. The snapshot
   * stays on disk so a later Browsemode.restore(this.id) reattaches.
   */
  async detach(): Promise<void> {
    this.snapshot();
    this.detachWatchdogs();
    this.cdp.close();
    this._pages.clear();
    this._activeTargetId = null;
  }

  /**
   * Tear down: close every tab on the browser side, drop the snapshot,
   * close the WS.
   */
  async close(): Promise<void> {
    for (const p of this._pages.values()) {
      await this.cdp
        .send("Target.closeTarget", { targetId: p.targetId })
        .catch(() => undefined);
    }
    this._pages.clear();
    this._activeTargetId = null;
    this.detachWatchdogs();
    this.cdp.close();
    clearBrowser(this.id);
  }

  async injectCookies(cookies: ChromeCookie[]): Promise<{ count: number }> {
    // Cookies are session-scoped; we open an ephemeral target, push,
    // close. Subsequent newPage() calls inherit them via the browser
    // context.
    const { targetId } = await this.cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const { sessionId } = await this.cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    try {
      await this.cdp.send(
        "Network.setCookies",
        { cookies: toCdpCookies(cookies) },
        sessionId,
      );
    } finally {
      await this.cdp
        .send("Target.closeTarget", { targetId })
        .catch(() => undefined);
    }
    return { count: cookies.length };
  }

  // ── Page-passthrough sugar ────────────────────────
  // Every method here delegates to activePage. Multi-tab callers can
  // still grab `browser.activePage` and call methods directly; this is
  // the ergonomic surface for the common single-tab case.

  async dispatch(path: string, args?: unknown): Promise<unknown> {
    return this.activePage.dispatch(path, args);
  }
  async exec(code: string, opts?: ExecOpts): Promise<ExecuteResult> {
    return this.activePage.exec(code, opts);
  }
  async scan(): Promise<ScanResult> {
    return this.activePage.scan();
  }
  async goto(url: string, opts?: NavOpts): Promise<void> {
    return this.activePage.goto(url, opts);
  }
  async reload(): Promise<void> {
    return this.activePage.reload();
  }
  async wait(ms: number): Promise<void> {
    return this.activePage.wait(ms);
  }
  async waitFor(opts: WaitForOpts): Promise<WaitForResult> {
    return this.activePage.waitFor(opts);
  }
  async scroll(opts: ScrollOpts): Promise<unknown> {
    return this.activePage.scroll(opts);
  }
  async clickAt(x: number, y: number): Promise<void> {
    return this.activePage.clickAt(x, y);
  }
  async press(key: string): Promise<void> {
    return this.activePage.press(key);
  }
  async viewport(opts: ViewportOpts): Promise<ViewportOpts> {
    return this.activePage.viewport(opts);
  }
  async html(): Promise<string> {
    return this.activePage.html();
  }
  async markdown(): Promise<string> {
    return this.activePage.markdown();
  }
  async read(): Promise<{ markdown: string; title?: string }> {
    return this.activePage.read();
  }
  async sections(): Promise<MarkdownSection[]> {
    return this.activePage.sections();
  }
  async rows(
    collection: string,
  ): Promise<Array<{ row: number; markdown: string }>> {
    return this.activePage.rows(collection);
  }
  async probe(): Promise<unknown> {
    return this.activePage.probe();
  }
  list(): string[] {
    return this.activePage.list();
  }
  find(query: string): Array<{ name: string; kind: string; text: string }> {
    return this.activePage.find(query);
  }
  describe(name: string): ElementInfo | undefined {
    return this.activePage.describe(name);
  }
  async click(name: string, args?: unknown): Promise<unknown> {
    return this.activePage.click(name, args);
  }
  async fill(name: string, value: string): Promise<unknown> {
    return this.activePage.fill(name, value);
  }
  async clear(name: string): Promise<unknown> {
    return this.activePage.clear(name);
  }
  async hover(name: string): Promise<unknown> {
    return this.activePage.hover(name);
  }
  async submit(name: string): Promise<unknown> {
    return this.activePage.submit(name);
  }
  async choose(name: string, value: string): Promise<unknown> {
    return this.activePage.choose(name, value);
  }
  /** URL of the active page. Throws if no pages open. */
  get url(): string {
    return this.activePage.url;
  }
  /** Title of the active page. Throws if no pages open. */
  get title(): string {
    return this.activePage.title;
  }

  // ── internal: sandbox tabs.* verbs ──
  async _dispatchTabs(verb: string, args: unknown): Promise<unknown> {
    const a = (args ?? {}) as any;
    switch (verb) {
      case "list":
        return [...this._pages.values()].map((p) => ({
          id: p.targetId,
          url: p.url,
          title: p.title,
          active: p.targetId === this._activeTargetId,
        }));
      case "active":
        return this._activeTargetId;
      case "open": {
        const url = typeof args === "string" ? args : a.url;
        const p = await this.newPage({ url, waitUntil: a.waitUntil });
        return p.targetId;
      }
      case "switch": {
        const id = typeof args === "string" ? args : a.id;
        if (!id) throw new Error("tabs.switch: pass a tab id");
        this.switchTo(id);
        return this._activeTargetId;
      }
      case "close": {
        const id =
          (typeof args === "string" ? args : a.id) ?? this._activeTargetId;
        if (!id) throw new Error("tabs.close: no active tab and no id given");
        await this.closePage(id);
        return { closed: id, active: this._activeTargetId };
      }
      default:
        throw new Error(
          `tabs: unknown verb '${verb}'. Available: list, active, open, switch, close`,
        );
    }
  }
}

// Re-export for convenience.
export { randomBrowserId } from "../config.js";
