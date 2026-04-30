// JS source template that runs inside the QuickJS sandbox. Every
// `page.<verb>(args)` and `page.<name>.<verb>(args)` call funnels back
// to the host through `__browsemode_invoke(path, args)`, which routes
// to Page.dispatch.
//
// We don't ship a baked-in element catalog — the page proxy is a pure
// router, so mid-script auto-rescans (after click/submit/goto)
// automatically reflect in the agent's next call without us having to
// push catalog updates into QuickJS.

/**
 * Build the sandbox source. `userCode` is what the agent passed; we wrap
 * it in an async IIFE (or detect that it's already an arrow function and
 * call it). The returned string is what we hand to QuickJS for evaluation.
 *
 * `pageVerbs` is the list of top-level `page.X` verbs that are functions
 * rather than element handles (goto, wait, list, ...). Anything else
 * gets routed as an element handle.
 */
export function buildSandboxSource(
  userCode: string,
  pageVerbs: readonly string[]
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

// page returns top-level verbs as functions, and any other property name
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
