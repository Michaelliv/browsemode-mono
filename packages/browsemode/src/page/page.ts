// Page is the typed surface over one browser tab.
//
// Three roles:
//   1. Run scans (main frame + same-origin iframes inline; cross-origin
//      iframes via Frame). Maintains the elements + collections catalogs.
//   2. Dispatch — both TS callers and sandboxed agents enter through
//      `page.dispatch(path, args)`. Path is "verb" or "name.verb" or
//      "tabs.verb". Auto-rescans after navigating verbs.
//   3. Sandbox — `page.exec(code)` runs user JS in QuickJS with a `page`
//      proxy that funnels every call back through `dispatch`.
//
// The sugar methods (`page.click`, `page.fill`, ...) are thin wrappers
// over dispatch. TS-typed call ergonomics; same code path.

import type { Browser } from "../browser/browser.js";
import { Session } from "../cdp/session.js";
import { Sandbox } from "../sandbox/sandbox.js";
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
} from "../types.js";
import type { Frame } from "./frame.js";
import { refreshFrames } from "./frame.js";
import type { MarkdownSection } from "./markdown.js";
import { SCAN_SCRIPT } from "./scanner.js";
import {
  ELEMENT_VERBS,
  NAVIGATING_ELEMENT_VERBS,
  assertElementVerb,
} from "./verbs/element.js";
import { NAVIGATING_PAGE_VERBS, PAGE_VERBS } from "./verbs/page.js";

export interface PageOpts {
  /** ms to wait after a navigating verb before rescanning. Default 250. */
  settleMs?: number;
  /** Auto-rescan after navigating verbs. Default true. */
  autoScan?: boolean;
}

export class Page {
  targetId!: string;
  mainFrame!: Frame;
  browser!: Browser;
  url = "";
  title = "";
  settleMs = 250;
  autoScan = true;

  iframes = new Map<string, Frame>();
  lastScan?: ScanResult;
  elements = new Map<string, ElementInfo>();
  collections = new Map<string, string[][]>();

  private constructor() {}

  /** @internal — Browser.newPage() is the only call site. */
  static async _create(
    browser: Browser,
    targetId: string,
    mainSession: Session,
    opts: PageOpts = {}
  ): Promise<Page> {
    const p = new Page();
    p.browser = browser;
    p.targetId = targetId;
    p.mainFrame = { targetId, session: mainSession, url: "" };
    p.settleMs = opts.settleMs ?? browser.settleMs ?? 250;
    p.autoScan = opts.autoScan ?? true;
    return p;
  }

  async scan(): Promise<ScanResult> {
    // 1. Discover and attach to any new cross-origin iframe targets.
    await refreshFrames(this.browser, this);

    // 2. Run SCAN_SCRIPT in main + each iframe session.
    const sessions: Session[] = [
      this.mainFrame.session,
      ...[...this.iframes.values()].map((f) => f.session),
    ];

    const allElements: ElementInfo[] = [];
    let mainResult: ScanResult | null = null;
    const seenNames = new Map<string, number>();

    for (const s of sessions) {
      const partial = await s
        .evalJSON<ScanResult>(SCAN_SCRIPT)
        .catch((e: any) => {
          // iframe scan failures (about:blank, cross-origin restrictions)
          // are non-fatal — emit and skip. Main-frame failures DO throw.
          if (s === this.mainFrame.session) throw e;
          this.browser.bus.emit({
            kind: "iframe.scan-failed",
            url: this.iframes.get([...this.iframes.keys()].find(
              (k) => this.iframes.get(k)?.session === s
            ) ?? "")?.url ?? "",
            reason: String(e?.message ?? e),
          });
          return null;
        });
      if (!partial) continue;
      if (s === this.mainFrame.session) mainResult = partial;

      for (const el of partial.elements) {
        // Stamp sessionId so dispatch routes verbs to the right frame.
        el.sessionId = s.id;
        // Disambiguate name collisions across frames with a numeric suffix.
        const base = el.name;
        const n = (seenNames.get(base) ?? 0) + 1;
        seenNames.set(base, n);
        if (n > 1) el.name = base + n;
        allElements.push(el);
      }
    }

    if (!mainResult) {
      throw new Error("scan: main page returned no result");
    }

    const merged: ScanResult = {
      url: mainResult.url,
      title: mainResult.title,
      elements: allElements,
      collections: mainResult.collections,
    };
    this.elements.clear();
    for (const e of allElements) this.elements.set(e.name, e);
    this.collections.clear();
    for (const [n, rows] of Object.entries(merged.collections ?? {})) {
      this.collections.set(n, rows);
    }
    this.url = merged.url;
    this.title = merged.title;
    this.lastScan = merged;

    this.browser.bus.emit({
      kind: "scan.complete",
      url: merged.url,
      elementCount: allElements.length,
      iframeCount: this.iframes.size,
    });

    return merged;
  }

  async dispatch(path: string, args?: unknown): Promise<unknown> {
    const parts = path.split(".");
    let result: unknown;
    let shouldRescan = false;

    if (parts.length === 1) {
      const verb = parts[0];
      const handler = PAGE_VERBS[verb];
      if (!handler) {
        throw new Error(`Unknown page verb: ${path}`);
      }
      result = await handler(this, args);
      shouldRescan = NAVIGATING_PAGE_VERBS.has(verb);
    } else if (parts.length === 2) {
      const [name, verb] = parts;
      // tabs.* routes to the Browser, not this Page.
      if (name === "tabs") {
        return await this.browser._dispatchTabs(verb, args);
      }
      const el = this.elements.get(name);
      if (el) {
        assertElementVerb(el, verb);
        const handler = ELEMENT_VERBS[verb];
        if (!handler) {
          throw new Error(`Unknown element verb: ${verb}`);
        }
        // Route to the element's frame session if it lives in an OOPIF.
        const session =
          el.sessionId && el.sessionId !== this.mainFrame.session.id
            ? new Session(this.browser.cdp, el.sessionId)
            : this.mainFrame.session;
        result = await handler(session, el, args);
        shouldRescan = NAVIGATING_ELEMENT_VERBS.has(verb);
      } else if (this.collections.has(name)) {
        result = collectionVerb(this.collections.get(name)!, name, verb, args);
      } else {
        const elsSample = [...this.elements.keys()].slice(0, 6).join(", ");
        const collsSample = [...this.collections.keys()].slice(0, 6).join(", ");
        throw new Error(
          `Unknown name: '${name}'. ` +
            `Elements: ${elsSample}\u2026 ` +
            `Collections: ${collsSample || "(none)"}`
        );
      }
    } else {
      throw new Error(`Bad action path: ${path}`);
    }

    if (shouldRescan && this.autoScan) {
      if (this.settleMs > 0) {
        await new Promise((r) => setTimeout(r, this.settleMs));
      }
      await this.scan();
    }
    return result;
  }

  async exec(code: string, opts?: ExecOpts): Promise<ExecuteResult> {
    // The Sandbox holds a `getPage` callback so mid-script tabs.switch()
    // reroutes the proxy to the new active Page on this Browser.
    const sb = new Sandbox(() => this.browser.activePage);
    return sb.execute(code, opts);
  }

  // ── sugar over dispatch ───────────────────────────

  async goto(url: string, opts: NavOpts = {}): Promise<void> {
    await this.dispatch("goto", { url, ...opts });
  }
  async reload(): Promise<void> {
    await this.dispatch("reload");
  }
  async wait(ms: number): Promise<void> {
    await this.dispatch("wait", ms);
  }
  async waitFor(opts: WaitForOpts): Promise<WaitForResult> {
    return (await this.dispatch("waitFor", opts)) as WaitForResult;
  }
  async scroll(opts: ScrollOpts): Promise<unknown> {
    return await this.dispatch("scroll", opts);
  }
  async clickAt(x: number, y: number): Promise<void> {
    await this.dispatch("clickAt", { x, y });
  }
  async press(key: string): Promise<void> {
    await this.dispatch("press", key);
  }
  async viewport(opts: ViewportOpts): Promise<ViewportOpts> {
    return (await this.dispatch("viewport", opts)) as ViewportOpts;
  }
  async eval<T = unknown>(expression: string): Promise<T> {
    return (await this.dispatch("eval", expression)) as T;
  }
  async html(): Promise<string> {
    return (await this.dispatch("html")) as string;
  }
  async markdown(): Promise<string> {
    return (await this.dispatch("markdown")) as string;
  }
  async read(): Promise<{ markdown: string; title?: string }> {
    return (await this.dispatch("read")) as { markdown: string; title?: string };
  }
  async sections(): Promise<MarkdownSection[]> {
    return (await this.dispatch("sections")) as MarkdownSection[];
  }
  async rows(
    collection: string
  ): Promise<Array<{ row: number; markdown: string }>> {
    return (await this.dispatch("rows", collection)) as Array<{
      row: number;
      markdown: string;
    }>;
  }
  async probe(): Promise<unknown> {
    return await this.dispatch("probe");
  }
  list(): string[] {
    return this.dispatch("list", undefined) as unknown as string[];
  }
  find(query: string): Array<{ name: string; kind: string; text: string }> {
    return this.dispatch("find", query) as unknown as Array<{
      name: string;
      kind: string;
      text: string;
    }>;
  }
  describe(name: string): ElementInfo | undefined {
    return this.dispatch("describe", name) as unknown as ElementInfo | undefined;
  }

  // Element-named sugar.
  async click(name: string, args?: unknown): Promise<unknown> {
    return await this.dispatch(`${name}.click`, args);
  }
  async fill(name: string, value: string): Promise<unknown> {
    return await this.dispatch(`${name}.fill`, value);
  }
  async clear(name: string): Promise<unknown> {
    return await this.dispatch(`${name}.clear`);
  }
  async hover(name: string): Promise<unknown> {
    return await this.dispatch(`${name}.hover`);
  }
  async submit(name: string): Promise<unknown> {
    return await this.dispatch(`${name}.submit`);
  }
  async choose(name: string, value: string): Promise<unknown> {
    return await this.dispatch(`${name}.choose`, value);
  }

  /** Close this tab. */
  async close(): Promise<void> {
    await this.browser.closePage(this.targetId);
  }
}

// Collections (groups of repeated DOM siblings). Each collection is an
// array of rows; each row is an array of element names. items() returns
// rows; flat() returns all names flattened.
function collectionVerb(
  rows: string[][],
  name: string,
  verb: string,
  args: unknown
): unknown {
  switch (verb) {
    case "items":
      return rows.map((r) => r.slice());
    case "length":
      return rows.length;
    case "flat":
      return rows.flat();
    case "at": {
      const i = typeof args === "number" ? args : (args as any)?.index ?? 0;
      if (i < 0 || i >= rows.length) {
        throw new Error(
          `${name}.at(${i}): index out of range (length=${rows.length})`
        );
      }
      return rows[i].slice();
    }
    case "first":
      return rows[0]?.slice();
    case "last":
      return rows[rows.length - 1]?.slice();
    default:
      throw new Error(
        `Collection '${name}': verb '${verb}' not supported. Available: items, flat, length, at, first, last`
      );
  }
}
