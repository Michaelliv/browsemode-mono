// Page-level verbs — goto, wait, waitFor, scroll, clickAt, read, sections,
// rows, eval, viewport, probe, find, describe, list, collections, rescan.
// Receives a Page reference and the args. Each handler returns a JSON-
// serializable value.
//
// These are the functions a sandboxed agent calls as `page.<verb>(args)`,
// and the same ones a TS caller invokes via `page.dispatch(verb, args)`.

import type { Page } from "../page.js";
import { sendKey } from "./keyboard.js";

export type PageVerbHandler = (page: Page, args: unknown) => Promise<unknown>;

export const NAVIGATING_PAGE_VERBS: ReadonlySet<string> = new Set([
  "goto",
  "reload",
  "back",
  "forward",
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

  title: async (page) => page.mainFrame.session.evalString("document.title"),
  url: async (page) => page.mainFrame.session.evalString("location.href"),
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
      // Route to the element's frame session so iframe elements scroll
      // correctly. Page hands us its main session; we need the element's.
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
    throw new Error("scroll: pass { y, dy, to: 'bottom'|'top', or name }");
  },

  eval: async (page, args) => {
    const expr = typeof args === "string" ? args : asObj(args).expression;
    if (!expr) throw new Error("eval: pass a JS expression string");
    return page.mainFrame.session.evalJSON(expr);
  },

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
        if (urlRe && urlRe.test(probe.url))
          return {
            found: probe.url,
            kind: "urlMatches",
            elapsedMs: Date.now() - start,
          };
        if (titleRe && titleRe.test(probe.title))
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

  rescan: async () => ({ triggered: true }), // actual rescan happens after dispatch returns

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
