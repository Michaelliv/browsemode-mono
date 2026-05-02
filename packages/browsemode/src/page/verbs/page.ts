// Page-level verbs — goto, wait, waitFor, scroll, clickAt, read, sections,
// rows, eval, viewport, probe, find, describe, list, collections, rescan.
// Receives a Page reference and the args. Each handler returns a JSON-
// serializable value.
//
// These are the functions a sandboxed agent calls as `page.<verb>(args)`,
// and the same ones a TS caller invokes via `page.dispatch(verb, args)`.

import type { Page } from "../page.js";
import type { VerbSpec } from "./help.js";
import { sendKey } from "./keyboard.js";

export type PageVerbHandler = (page: Page, args: unknown) => Promise<unknown>;

export const NAVIGATING_PAGE_VERBS: ReadonlySet<string> = new Set([
  "goto",
  "reload",
  "back",
  "forward",
  "scan",
  "rescan",
  "press",
]);

// Helpers to avoid `args as any` noise in every handler.
function asObj(args: unknown): any {
  return typeof args === "object" && args !== null ? (args as any) : {};
}
function asString(args: unknown): string | undefined {
  if (typeof args === "string") return args;
  return asObj(args).value ?? asObj(args).text ?? asObj(args).query;
}

export const PAGE_VERBS: Record<string, PageVerbHandler> = {
  goto: async (page, args) => {
    const url = typeof args === "string" ? args : asObj(args).url;
    if (!url) throw new Error("goto: url required");
    // Default domcontentloaded — obscura hangs forever on "load" if any
    // subresource times out. Caller can override per-call.
    const waitUntil = asObj(args).waitUntil || "domcontentloaded";
    const timeoutMs = asObj(args).timeoutMs || 30_000;
    const session = page.mainFrame.session;
    try {
      await session.cdp.send("Page.navigate", { url, waitUntil }, session.id, {
        timeoutMs,
      });
    } catch (e: any) {
      if (!/timed out/.test(e?.message ?? "")) throw e;
      // Lifecycle event never fired (heavy ad-tech, infinite retry loops,
      // ...). Page is usually scannable by now — emit and proceed.
      page.browser.bus.emit({
        kind: "nav.timeout",
        url,
        waitUntil,
        timeoutMs,
      });
    }
    return { url };
  },

  reload: async (page) => {
    await page.mainFrame.session.send("Page.reload", {});
    return {};
  },

  title: async (page) => {
    const title = await page.mainFrame.session.evalString("document.title");
    page.title = title;
    return title;
  },
  url: async (page) => {
    const url = await page.mainFrame.session.evalString("location.href");
    page.url = url;
    return url;
  },
  html: async (page) =>
    page.mainFrame.session.evalString("document.documentElement.outerHTML"),

  markdown: async (page) => {
    // Vision via markit. Lazy import keeps cold start fast for callers
    // that never use this verb.
    const html = await page.mainFrame.session.evalString(
      "document.documentElement.outerHTML",
    );
    const { htmlToMarkdown } = await import("../markdown.js");
    return htmlToMarkdown(html);
  },

  read: async (page) => {
    // Like markdown(), but tries markit's URL-first path so we get
    // /llms.txt, VitePress .md sources, RSS, Wikipedia handlers, etc.
    // Falls back to live HTML if URL fetch fails (auth-only pages where
    // we need the rendered DOM).
    const url = await page.mainFrame.session.evalString("location.href");
    const { urlToMarkdown, htmlToMarkdown } = await import("../markdown.js");
    try {
      if (url && /^https?:/.test(url)) {
        const r = await urlToMarkdown(url);
        if (r.markdown && r.markdown.length > 100) return r;
      }
    } catch {
      // fall through to live HTML
    }
    const html = await page.mainFrame.session.evalString(
      "document.documentElement.outerHTML",
    );
    return { markdown: await htmlToMarkdown(html) };
  },

  sections: async (page) => {
    const html = await page.mainFrame.session.evalString(
      "document.documentElement.outerHTML",
    );
    const { htmlToMarkdown, extractSections } = await import("../markdown.js");
    return extractSections(await htmlToMarkdown(html));
  },

  rows: async (page, args) => {
    // For a scanner-detected collection, render each row's outerHTML
    // through markit. Replaces hand-rolled per-row regex parsing.
    const collName = asString(args) ?? asObj(args).name;
    if (!collName) throw new Error("rows: pass a collection name");
    const rowNames = page.collections.get(collName);
    if (!rowNames) {
      throw new Error(
        `rows: no collection '${collName}'. Available: ${[...page.collections.keys()].join(", ") || "(none — scan first)"}`,
      );
    }
    // Anchor each row by the first interactable's data-browsemode id and
    // walk up to the row container.
    const anchorIds: string[] = [];
    for (const interactables of rowNames) {
      const firstName = interactables[0];
      const el = page.elements.get(firstName);
      if (el?.id) anchorIds.push(el.id);
    }
    const expr = `(() => {
      const ids = ${JSON.stringify(anchorIds)};
      return ids.map(id => {
        const a = document.querySelector('[data-browsemode="' + id + '"]');
        if (!a) return null;
        let cur = a;
        for (let depth = 0; depth < 7; depth++) {
          const p = cur.parentElement;
          if (!p) break;
          let count = 0;
          for (const sib of p.children) if (sib.tagName === cur.tagName) count++;
          if (count >= 3) return cur.outerHTML;
          cur = p;
        }
        return cur.outerHTML;
      });
    })()`;
    const htmls =
      await page.mainFrame.session.evalJSON<(string | null)[]>(expr);
    const { htmlToMarkdown } = await import("../markdown.js");
    const out: { row: number; markdown: string }[] = [];
    for (let i = 0; i < htmls.length; i++) {
      const h = htmls[i];
      if (!h) continue;
      out.push({ row: i, markdown: (await htmlToMarkdown(h)).trim() });
    }
    return out;
  },

  probe: async (page) =>
    page.mainFrame.session.evalJSON(`(() => {
      const has = (path) => {
        try {
          const parts = path.split('.');
          let cur = window;
          for (const p of parts) {
            cur = cur?.[p];
            if (cur === undefined || cur === null) return 'missing';
          }
          return typeof cur;
        } catch (e) { return 'error:' + (e.message || e); }
      };
      return {
        shimLoaded: !!window.__browsemode_shim_v1,
        stealthLoaded: !!window.__browsemode_stealth_v1,
        apis: {
          'Document.elementFromPoint': has('Document.prototype.elementFromPoint'),
          'Document.elementsFromPoint': has('Document.prototype.elementsFromPoint'),
          'Element.scrollIntoView': has('Element.prototype.scrollIntoView'),
          'Element.getBoundingClientRect': has('Element.prototype.getBoundingClientRect'),
          'Element.closest': has('Element.prototype.closest'),
          'window.requestIdleCallback': has('requestIdleCallback'),
          'window.requestAnimationFrame': has('requestAnimationFrame'),
          'window.IntersectionObserver': has('IntersectionObserver'),
          'window.ResizeObserver': has('ResizeObserver'),
          'window.MutationObserver': has('MutationObserver'),
          'window.PerformanceObserver': has('PerformanceObserver'),
          'window.matchMedia': has('matchMedia'),
          'window.fetch': has('fetch'),
          'window.WebSocket': has('WebSocket'),
          'window.EventSource': has('EventSource'),
        },
        ua: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`),

  viewport: async (page, args) => {
    const o = asObj(args);
    const w = o.width || 1280;
    const h = o.height || 720;
    const dsf = o.deviceScaleFactor || 1;
    const session = page.mainFrame.session;
    // Chrome path: real viewport via Emulation.
    await session
      .send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: dsf,
        mobile: false,
      })
      .catch(() => undefined);
    // obscura/JS-side: write __browsemode_viewport so the shim's
    // matchMedia and innerWidth/innerHeight getters pick it up.
    await session.evalJSON(`(() => {
      window.__browsemode_viewport = { width: ${w}, height: ${h} };
      try {
        Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => ${w} });
        Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => ${h} });
      } catch (_e) {}
      return { width: ${w}, height: ${h} };
    })()`);
    return { width: w, height: h };
  },

  press: async (page, args) => {
    const key = typeof args === "string" ? args : asObj(args).key;
    if (!key) throw new Error("page.press: pass a key string");
    await sendKey(page.mainFrame.session, key);
    return { ok: true };
  },

  clickAt: async (page, args) => {
    const o = asObj(args);
    const x = o.x;
    const y = o.y;
    if (typeof x !== "number" || typeof y !== "number") {
      throw new Error("clickAt: pass { x, y }");
    }
    const session = page.mainFrame.session;
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    return { ok: true, x, y };
  },

  scroll: async (page, args) => {
    // Accept a few natural call shapes:
    //   page.scroll('elementName')                      -> scroll an element into view
    //   page.scroll(500)                                 -> scroll to absolute y
    //   page.scroll({ y: 500 })                          -> same
    //   page.scroll({ dy: 500 })                         -> relative delta y (positive = down)
    //   page.scroll({ to: 'bottom' | 'top' })            -> scroll endpoints
    //   page.scroll({ direction: 'down' })               -> half-viewport down
    //   page.scroll({ direction: 'up'   })               -> half-viewport up
    //   page.scroll({ direction: 'down', amount: 3 })    -> N viewports down
    //   page.scroll({ name: 'foo' })                     -> scroll element into view
    //
    // The `direction` form is what most agents reach for first because it
    // matches Puppeteer/Playwright keyboard intuition. Supporting it
    // structurally is cheaper than telling the agent to remember a
    // dy-only API.
    const opts =
      typeof args === "string"
        ? { name: args }
        : typeof args === "number"
          ? { y: args }
          : ((args as any) ?? {});
    const session = page.mainFrame.session;
    if (opts.name) {
      const el = page.elements.get(opts.name);
      if (!el) throw new Error(`scroll: unknown name '${opts.name}'`);
      const find =
        el.selector ?? `document.querySelector('[data-browsemode="${el.id}"]')`;
      const target = el.sessionId
        ? new (await import("../../cdp/session.js")).Session(
            session.cdp,
            el.sessionId,
          )
        : session;
      await target.evalJSON(
        `(${find})?.scrollIntoView({ behavior: 'instant', block: 'center' })`,
      );
      return { scrolledTo: opts.name };
    }
    if (opts.to === "bottom") {
      await session.evalJSON(
        "window.scrollTo(0, document.documentElement.scrollHeight)",
      );
      return { scrolledTo: "bottom" };
    }
    if (opts.to === "top") {
      await session.evalJSON("window.scrollTo(0, 0)");
      return { scrolledTo: "top" };
    }
    if (typeof opts.y === "number") {
      await session.evalJSON(`window.scrollTo(0, ${opts.y})`);
      return { scrolledTo: opts.y };
    }
    if (typeof opts.dy === "number") {
      await session.evalJSON(`window.scrollBy(0, ${opts.dy})`);
      return { scrolledBy: opts.dy };
    }
    if (
      typeof opts.direction === "string" &&
      (opts.direction === "up" ||
        opts.direction === "down" ||
        opts.direction === "left" ||
        opts.direction === "right")
    ) {
      const viewports = typeof opts.amount === "number" ? opts.amount : 1;
      const sign =
        opts.direction === "up" || opts.direction === "left" ? -1 : 1;
      const axis =
        opts.direction === "left" || opts.direction === "right"
          ? "window.innerWidth"
          : "window.innerHeight";
      // Half a viewport per amount unit feels closer to how a human
      // reads through a long page than a full viewport jump.
      const expr =
        opts.direction === "left" || opts.direction === "right"
          ? `window.scrollBy(${sign * viewports * 0.5} * ${axis}, 0)`
          : `window.scrollBy(0, ${sign * viewports * 0.5} * ${axis})`;
      await session.evalJSON(expr);
      return { scrolledBy: { direction: opts.direction, amount: viewports } };
    }
    throw new Error(
      "scroll: pass an element name, a number (y), or one of " +
        "{ y }, { dy }, { to: 'bottom'|'top' }, { direction: 'up'|'down'|'left'|'right', amount? }",
    );
  },

  // page.eval was removed: it ran arbitrary JS in the page's V8
  // context, which is a second nested sandbox underneath the
  // QuickJS one. Agents found the layering confusing (they kept
  // writing function bodies expecting the sandbox semantics they
  // already had, hitting 'illegal return' errors). The typed
  // catalog plus `html()` / `markdown()` / `read()` covers every
  // real read need; click / fill / submit / etc. cover writes.
  // If a future task genuinely needs raw DOM access we'll add a
  // specific narrowly-scoped verb (page.text(selector), etc.)
  // rather than a general-purpose eval escape hatch.

  wait: async (_page, args) => {
    const ms = typeof args === "number" ? args : (asObj(args).ms ?? 1000);
    await new Promise((r) => setTimeout(r, ms));
    return {};
  },

  waitFor: async (page, args) => {
    const opts = typeof args === "string" ? { name: args } : asObj(args);
    const {
      name,
      text,
      urlMatches,
      titleMatches,
      urlChanges,
      selector,
      stable,
    } = opts;
    const timeout = opts.timeoutMs ?? 15_000;
    const interval = opts.intervalMs ?? 250;
    if (
      !name &&
      !text &&
      !urlMatches &&
      !titleMatches &&
      !urlChanges &&
      !selector &&
      !stable
    ) {
      throw new Error(
        "waitFor: pass one of { name, text, urlMatches, titleMatches, urlChanges, selector, stable }",
      );
    }
    const session = page.mainFrame.session;
    // urlChanges baseline: explicit `from` overrides; otherwise snapshot
    // current URL. Caveat: if a navigating verb ran with auto-rescan
    // immediately before this call, location.href may already be the
    // new URL — pass `from: <oldUrl>` to make this reliable.
    let baseUrl: string | null = null;
    if (urlChanges) {
      baseUrl = opts.from ?? (await session.evalJSON<string>("location.href"));
    }
    const urlRe = urlMatches ? new RegExp(urlMatches) : null;
    const titleRe = titleMatches ? new RegExp(titleMatches, "i") : null;
    const stableCfg = stable
      ? {
          forMs: typeof stable === "number" ? stable : (stable.forMs ?? 2000),
          minCount:
            (stable && typeof stable === "object" && stable.minCount) || 0,
        }
      : null;
    let lastCount = -1;
    let stableSince = Date.now();
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (urlRe || titleRe || urlChanges || selector) {
        const probeExpr = `({
          url: location.href,
          title: document.title,
          ${selector ? `selFound: !!document.querySelector(${JSON.stringify(selector)}),` : ""}
        })`;
        const probe = await session.evalJSON<{
          url: string;
          title: string;
          selFound?: boolean;
        }>(probeExpr);
        if (urlRe?.test(probe.url))
          return {
            found: probe.url,
            kind: "urlMatches",
            elapsedMs: Date.now() - start,
          };
        if (titleRe?.test(probe.title))
          return {
            found: probe.title,
            kind: "titleMatches",
            elapsedMs: Date.now() - start,
          };
        if (urlChanges && probe.url !== baseUrl)
          return {
            found: probe.url,
            kind: "urlChanges",
            from: baseUrl,
            elapsedMs: Date.now() - start,
          };
        if (selector && probe.selFound)
          return {
            found: selector,
            kind: "selector",
            elapsedMs: Date.now() - start,
          };
      }
      if (name || text || stableCfg) await page.scan();
      if (name && page.elements.has(name))
        return { found: name, kind: "name", elapsedMs: Date.now() - start };
      if (text) {
        const lower = text.toLowerCase();
        const hit = [...page.elements.values()].find((e) =>
          e.text.toLowerCase().includes(lower),
        );
        if (hit)
          return {
            found: hit.name,
            kind: "text",
            elapsedMs: Date.now() - start,
          };
      }
      if (stableCfg) {
        const cur = page.elements.size;
        if (cur !== lastCount) {
          lastCount = cur;
          stableSince = Date.now();
        } else if (
          cur >= stableCfg.minCount &&
          Date.now() - stableSince >= stableCfg.forMs
        ) {
          return {
            found: cur,
            kind: "stable",
            stableForMs: Date.now() - stableSince,
            elapsedMs: Date.now() - start,
          };
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    const what = name
      ? `name='${name}'`
      : text
        ? `text='${text}'`
        : urlMatches
          ? `urlMatches=${urlMatches}`
          : titleMatches
            ? `titleMatches=${titleMatches}`
            : urlChanges
              ? "urlChanges"
              : selector
                ? `selector=${selector}`
                : "stable";
    throw new Error(`waitFor: ${what} not satisfied within ${timeout}ms`);
  },

  list: async (page) => [...page.elements.keys()],

  collections: async (page) =>
    Object.fromEntries(
      [...page.collections.entries()].map(([n, rows]) => [
        n,
        {
          rows: rows.length,
          totalItems: rows.reduce((a, r) => a + r.length, 0),
        },
      ]),
    ),

  scan: async () => ({ triggered: true }), // actual scan happens after dispatch returns

  rescan: async () => ({ triggered: true }), // backwards-compatible alias

  find: async (page, args) => {
    const q = typeof args === "string" ? args : (asObj(args).query ?? "");
    const lower = q.toLowerCase();
    return [...page.elements.values()]
      .filter(
        (e) =>
          e.name.toLowerCase().includes(lower) ||
          e.text.toLowerCase().includes(lower),
      )
      .slice(0, 10)
      .map((e) => ({ name: e.name, kind: e.kind, text: e.text }));
  },

  describe: async (page, args) => {
    const name = typeof args === "string" ? args : asObj(args).name;
    const el = name ? page.elements.get(name) : undefined;
    if (!el) throw new Error(`describe: unknown element ${name}`);
    return el;
  },

  // Page.navigateToHistoryEntry exists on Chrome but obscura's coverage
  // is unreliable. Left as TODO — easy to add when needed.
  back: async () => {
    throw new Error("back not implemented yet");
  },
  forward: async () => {
    throw new Error("forward not implemented yet");
  },
};

export function pageVerbNames(): string[] {
  return Object.keys(PAGE_VERBS);
}

/**
 * Per-verb schemas. Used to build the in-sandbox `api.*` discovery
 * helpers; not consulted by Page.dispatch (handlers above own that).
 * Adding a spec here is opt-in; verbs without one show up in
 * `api.list()` with description "(no spec)".
 */
export const PAGE_VERB_SPECS: Record<string, VerbSpec> = {
  goto: {
    description: "Navigate the active tab to a URL. Auto-rescans on success.",
    inputs: {
      url: { type: "string", required: true, description: "Absolute URL." },
      waitUntil: {
        type: "string",
        description: "Lifecycle event to wait for.",
        oneOf: ["domcontentloaded", "load", "networkidle0", "networkidle2"],
      },
      timeoutMs: {
        type: "number",
        description: "Hard cap on the navigate. Default 30000.",
      },
    },
    examples: [
      'await page.goto("https://example.com")',
      'await page.goto({ url: "https://example.com", waitUntil: "load" })',
    ],
  },
  reload: {
    description: "Reload the active tab.",
    examples: ["await page.reload()"],
  },
  title: {
    description: "Read the page's <title>. Returns a string.",
    examples: ["const t = await page.title()"],
  },
  url: {
    description: "Read the active page's URL. Returns a string.",
    examples: ["const u = await page.url()"],
  },
  html: {
    description: "Return document.documentElement.outerHTML as a string.",
    examples: ["const html = await page.html()"],
  },
  markdown: {
    description:
      "Convert the live HTML to clean markdown via markit. Use this for content extraction; preferred over html() when you want readable text.",
    examples: ["const md = await page.markdown()"],
  },
  read: {
    description:
      "Like markdown(), but tries the URL-first markit pipeline first (/llms.txt, RSS, Wikipedia handlers, etc.) and falls back to live HTML. Returns { markdown, title? }.",
    examples: ["const { markdown } = await page.read()"],
  },
  sections: {
    description:
      "Split the page's markdown into sections by heading. Returns an array of { heading, level, markdown }.",
    examples: ["const secs = await page.sections()"],
  },
  rows: {
    description:
      "For a scanner-detected collection, render each row as markdown. Returns [{ row: number, markdown: string }].",
    inputs: {
      name: {
        type: "string",
        required: true,
        description: "Collection name from page.collections.",
      },
    },
    examples: ['const rows = await page.rows("stories")'],
  },
  probe: {
    description:
      "Diagnostic: report which DOM/runtime APIs are present (elementFromPoint, IntersectionObserver, fetch, ...). Useful for confirming what works on the current backend.",
    examples: ["const probe = await page.probe()"],
  },
  viewport: {
    description: "Set the browser viewport size. Returns { width, height }.",
    inputs: {
      width: { type: "number", description: "Viewport width. Default 1280." },
      height: {
        type: "number",
        description: "Viewport height. Default 720.",
      },
      deviceScaleFactor: {
        type: "number",
        description: "DPR. Default 1.",
      },
    },
    examples: ["await page.viewport({ width: 1366, height: 768 })"],
  },
  press: {
    description:
      "Send a keyboard key to the active page (no element focus required). Pass key names like 'Enter', 'Escape', 'ArrowDown', 'a', 'Control+a'.",
    inputs: {
      key: {
        type: "string",
        required: true,
        description: "Key name or modifier+key combo.",
      },
    },
    examples: ['await page.press("Enter")', 'await page.press("Control+a")'],
  },
  clickAt: {
    description: "Click at absolute (x, y) viewport coordinates.",
    inputs: {
      x: { type: "number", required: true },
      y: { type: "number", required: true },
    },
    examples: ["await page.clickAt({ x: 200, y: 350 })"],
  },
  scroll: {
    description:
      "Scroll the page or an element into view. Accepts several shapes; pick whichever matches your intent.",
    inputs: {
      y: { type: "number", description: "Scroll to absolute y." },
      dy: {
        type: "number",
        description: "Relative delta y (positive = down).",
      },
      to: {
        type: "string",
        description: "Endpoint shortcuts.",
        oneOf: ["bottom", "top"],
      },
      direction: {
        type: "string",
        description:
          "Direction shortcut. Combine with `amount` for N half-viewports.",
        oneOf: ["up", "down", "left", "right"],
      },
      amount: {
        type: "number",
        description: "Half-viewports per direction step. Default 1.",
      },
      name: {
        type: "string",
        description: "Scroll a scanned element into view by name.",
      },
    },
    examples: [
      'await page.scroll({ direction: "down" })',
      "await page.scroll({ dy: 500 })",
      'await page.scroll({ to: "bottom" })',
      'await page.scroll("loginButton")',
    ],
  },
  wait: {
    description: "Sleep for `ms` milliseconds. Pass a number or { ms }.",
    inputs: {
      ms: {
        type: "number",
        description: "Milliseconds to wait. Default 1000.",
      },
    },
    examples: ["await page.wait(2000)"],
  },
  waitFor: {
    description:
      "Block until a condition is met or `timeoutMs` elapses. Pass exactly one positive condition.",
    inputs: {
      name: {
        type: "string",
        description: "Wait for an element by scanned name.",
      },
      text: {
        type: "string",
        description: "Wait for any element whose text matches.",
      },
      urlMatches: {
        type: "string",
        description: "RegExp source against location.href.",
      },
      titleMatches: {
        type: "string",
        description: "RegExp source against document.title.",
      },
      urlChanges: {
        type: "boolean",
        description: "Wait until the URL is different from the baseline.",
      },
      from: {
        type: "string",
        description: "Optional baseline URL for urlChanges (default: current).",
      },
      selector: {
        type: "string",
        description: "Wait until a CSS selector matches at least one node.",
      },
      stable: {
        type: "object",
        description: "{ forMs, minCount? } catalog-stability check.",
      },
      timeoutMs: { type: "number", description: "Default 15000." },
      intervalMs: { type: "number", description: "Poll period. Default 250." },
    },
    examples: [
      'await page.waitFor({ name: "loginButton" })',
      "await page.waitFor({ stable: { forMs: 1500 } })",
      'await page.waitFor({ urlMatches: "/results" })',
    ],
  },
  list: {
    description:
      "Return every named element on the current page as a string array. Combine with find/describe to inspect specific ones.",
    examples: ["const names = await page.list()"],
  },
  collections: {
    description:
      "Summary of repeated-row collections the scanner detected. Returns { name: { rows, totalItems } }.",
    examples: ["const cols = await page.collections()"],
  },
  scan: {
    description:
      "Force a scan of the page after navigation or dynamic DOM changes. Most navigating verbs scan automatically.",
    examples: ["await page.scan()"],
  },
  rescan: {
    description:
      "Force a rescan of the page after a manual DOM mutation. Alias for scan(). Most navigating verbs scan automatically.",
    examples: ["await page.rescan()"],
  },
  find: {
    description:
      "Substring/text search across element names and text. Returns up to 10 [{ name, kind, text }].",
    inputs: {
      query: {
        type: "string",
        required: true,
        description: "Substring to search for (case-insensitive).",
      },
    },
    examples: ['const hits = await page.find("login")'],
  },
  describe: {
    description:
      "Get the ElementInfo for a named element. Throws if the name is unknown.",
    inputs: {
      name: {
        type: "string",
        required: true,
        description: "Element name from page.list() or page.find().",
      },
    },
    examples: ['const el = await page.describe("loginButton")'],
  },
};

/**
 * `page.tabs.<verb>` — multi-tab management. Mirrors the dispatch
 * path in browser.ts (_dispatchTabs).
 */
export const TABS_VERB_SPECS: Record<string, VerbSpec> = {
  list: {
    description:
      "Return [{ id, url, title, active }] for every open tab on this browser.",
    examples: ["const tabs = await page.tabs.list()"],
  },
  active: {
    description: "Return the active tab's targetId.",
    examples: ["const id = await page.tabs.active()"],
  },
  open: {
    description:
      "Open a new tab. Becomes the active tab. Returns the new targetId.",
    inputs: {
      url: { type: "string", description: "Initial URL. Default about:blank." },
      waitUntil: {
        type: "string",
        oneOf: ["domcontentloaded", "load", "networkidle0", "networkidle2"],
      },
    },
    examples: ['await page.tabs.open("https://example.com")'],
  },
  switch: {
    description:
      "Make the given tab active. Subsequent page.* calls route to it.",
    inputs: {
      id: {
        type: "string",
        required: true,
        description: "targetId from tabs.list().",
      },
    },
    examples: ["await page.tabs.switch(id)"],
  },
  close: {
    description:
      "Close a tab. If id is omitted, closes the active tab. Returns { closed, active }.",
    inputs: {
      id: {
        type: "string",
        description: "targetId. Default: active tab.",
      },
    },
    examples: ["await page.tabs.close()", "await page.tabs.close(id)"],
  },
};
