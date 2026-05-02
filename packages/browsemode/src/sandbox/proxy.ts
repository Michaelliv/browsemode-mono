// JS source template that runs inside the QuickJS sandbox. Every
// `page.<verb>(args)` and `page.<name>.<verb>(args)` call funnels back
// to the host through `__browsemode_invoke(path, args)`, which routes
// to Page.dispatch.
//
// We bake a fresh verb catalog at every exec call: static page/tabs
// verbs from the spec tables, plus one entry per (currentElement,
// supportedVerb) so the agent can introspect the live API surface
// without round-tripping the host. Mirrors runline's `actions.*`.

import type { VerbCatalogEntry } from "../page/verbs/help.js";

/**
 * Build the sandbox source. `userCode` is what the agent passed; we wrap
 * it in an async IIFE (or detect that it's already an arrow function and
 * call it). The returned string is what we hand to QuickJS for evaluation.
 *
 * `pageVerbs` is the list of top-level `page.X` verbs that are functions
 * rather than element handles (goto, wait, list, ...). Anything else
 * gets routed as an element handle.
 *
 * `catalog` is a snapshot of every callable path the agent has right
 * now. Baked into the sandbox as JSON and surfaced via `api.*`.
 */
export function buildSandboxSource(
  userCode: string,
  pageVerbs: readonly string[],
  catalog: readonly VerbCatalogEntry[] = [],
): string {
  const trimmed = userCode.trim();
  // Heuristic: treat as an arrow function if the body looks like one.
  // `async () => { ... }` or `(args) => ...`. Otherwise inject as the
  // body of an async IIFE so `return ...;` and top-level await work.
  const looksLikeArrow =
    (trimmed.startsWith("async") || trimmed.startsWith("(")) &&
    trimmed.includes("=>");
  const body = looksLikeArrow
    ? `const __fn = (${trimmed}); if (typeof __fn !== 'function') throw new Error('Code must evaluate to a function'); return await __fn();`
    : userCode;

  const verbList = pageVerbs.map((v) => `'${v}'`).join(", ");
  const catalogJson = JSON.stringify(catalog);

  return `"use strict";
const __invoke = __browsemode_invoke;
const __log = __browsemode_log;
try { delete globalThis.__browsemode_invoke; } catch {}
try { delete globalThis.__browsemode_log; } catch {}

const __fmt = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };

const __call = (path, args) => Promise.resolve(__invoke(path, args))
  .then((raw) => raw === undefined ? undefined : JSON.parse(raw));

// Element proxy: page.signInButton.click(args) → __invoke('signInButton.click', args)
const __makeElement = (name) => new Proxy(() => {}, {
  get(_t, verb) {
    if (typeof verb === 'symbol' || verb === 'then') return undefined;
    return (args) => __call(name + '.' + String(verb), args);
  },
});

// Top-level verbs the agent can call without an element.
const __pageVerbs = [${verbList}];
const __pageBase = Object.create(null);
for (const v of __pageVerbs) {
  __pageBase[v] = (args) => __call(v, args);
}

// page.tabs.<verb>(args) sub-namespace for multi-tab management.
const __tabVerbs = ['list', 'active', 'open', 'switch', 'close'];
__pageBase.tabs = Object.create(null);
for (const v of __tabVerbs) {
  __pageBase.tabs[v] = (args) => __call('tabs.' + v, args);
}

// ── api.* — live introspection of the callable surface ──────────
//
// At sandbox boot we bake a snapshot of every callable path on the
// CURRENT page: static page/tabs verbs plus one entry per
// (elementName, verb) pair (e.g. 'signInButton.click',
// 'emailInput.fill'). The agent can list/find/describe/check
// without round-tripping the host. Snapshot freshens on every
// execute_browsemode call (each call gets a new sandbox).
//
// Unknown paths in describe/check throw "Did you mean: ..." with
// the closest substring matches, so typos self-correct.

const __catalog = ${catalogJson};
const __index = (() => {
  const out = Object.create(null);
  for (const e of __catalog) out[e.path] = e;
  return out;
})();

const __formatSig = (e) => {
  const fields = Object.entries(e.inputs || {})
    .map(([k, v]) => k + (v.required ? '' : '?') + ': ' + v.type)
    .join(', ');
  return e.path + (fields ? '({ ' + fields + ' })' : '()');
};

const __scoreMatch = (path, query) => {
  if (!query) return 0;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  if (p === q) return 100;
  if (p.startsWith(q)) return 80;
  if (p.includes(q)) return 60;
  // crude fuzzy: every char in q appears in order in p
  let i = 0;
  for (const c of p) { if (c === q[i]) i++; if (i === q.length) return 30; }
  return 0;
};

const __didYouMean = (path) => {
  const ranked = __catalog
    .map(e => ({ path: e.path, score: __scoreMatch(e.path, path) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(r => r.path);
  return ranked.length ? ' Did you mean: ' + ranked.join(', ') + '?' : '';
};

const __api = {
  /**
   * List every callable path. Optionally filter to one scope
   * ('page' | 'tabs' | 'element') or one element name.
   *   api.list()                 → every path
   *   api.list('page')           → only page-level static verbs
   *   api.list('tabs')           → only tab verbs
   *   api.list('element')        → every element.verb path
   *   api.list('signInButton')   → just that element's verbs
   */
  list(filter) {
    if (!filter) return __catalog.map(e => e.path);
    const f = String(filter);
    if (f === 'page' || f === 'tabs' || f === 'element') {
      return __catalog.filter(e => e.scope === f).map(e => e.path);
    }
    return __catalog
      .filter(e => e.scope === 'element' && e.path.startsWith(f + '.'))
      .map(e => e.path);
  },
  /**
   * Search the catalog for a query. Returns ranked
   * [{ path, description, score }] matches, top 5 by default.
   */
  find(query, limit) {
    const q = String(query || '').trim();
    if (!q) return [];
    const max = typeof limit === 'number' ? limit : 5;
    return __catalog
      .map(e => ({
        path: e.path,
        description: e.description,
        score: Math.max(__scoreMatch(e.path, q), __scoreMatch(e.description || '', q)),
      }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max);
  },
  /**
   * Full schema for a path. Throws if the path doesn't exist,
   * with a 'Did you mean' suggestion.
   */
  describe(path) {
    const hit = __index[path];
    if (!hit) throw new Error('Unknown path: ' + path + '.' + __didYouMean(path));
    return {
      path: hit.path,
      scope: hit.scope,
      description: hit.description,
      signature: __formatSig(hit),
      inputs: hit.inputs,
      examples: hit.examples,
      appliesTo: hit.appliesTo,
    };
  },
  /**
   * Validate args against a path's schema WITHOUT calling it.
   * Returns { ok, missing, unknown, typeErrors, signature }.
   * Use this before a costly call when in doubt.
   */
  check(path, args) {
    const hit = __index[path];
    if (!hit) return { ok: false, error: 'Unknown path: ' + path, suggestions: __didYouMean(path) };
    const inputs = hit.inputs || {};
    const provided = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
    const missing = [];
    const unknown = [];
    const typeErrors = [];
    for (const [k, spec] of Object.entries(inputs)) {
      if (spec.required && !(k in provided)) missing.push(k);
    }
    for (const k of Object.keys(provided)) {
      if (!(k in inputs)) { unknown.push(k); continue; }
      const expected = inputs[k].type;
      const v = provided[k];
      if (v === null || v === undefined) continue;
      const actual = Array.isArray(v) ? 'array' : typeof v;
      if (expected !== actual) typeErrors.push({ field: k, expected, actual });
    }
    return {
      ok: missing.length === 0 && unknown.length === 0 && typeErrors.length === 0,
      missing,
      unknown,
      typeErrors,
      signature: __formatSig(hit),
    };
  },
};

// page returns top-level verbs as functions, any other property name
// as an element handle. Existence is validated host-side at call time
// with helpful errors, so we don't track it in JS — that way mid-script
// auto-rescans don't need to push state into the sandbox.
const page = new Proxy(__pageBase, {
  get(target, prop) {
    if (typeof prop === 'symbol' || prop === 'then') return target[prop];
    if (prop in target) return target[prop];
    return __makeElement(String(prop));
  },
});

// Top-level api global. Same surface as page.api would be; both
// references resolve to the same object so either spelling works.
const api = __api;
__pageBase.api = __api;

const console = {
  log:   (...a) => __log('log',   a.map(__fmt).join(' ')),
  warn:  (...a) => __log('warn',  a.map(__fmt).join(' ')),
  error: (...a) => __log('error', a.map(__fmt).join(' ')),
  info:  (...a) => __log('info',  a.map(__fmt).join(' ')),
};

const fetch = () => { throw new Error('fetch is disabled in the browsemode sandbox'); };

(async () => {
${body}
})()`;
}
