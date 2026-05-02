// The session-start primer text the agent gets injected into context.
// One short markdown blob explaining the surface.
//
// Mirrors the runline-context approach: tell the agent there's one
// tool, name the discovery helpers, give a tiny worked example. We
// don't dump the element catalog here because it changes every scan
// and is cheap to query in-sandbox via page.list/find/describe.

export interface PrimerInput {
  /** Browser id this session will operate against. */
  browserId: string;
  /** Reported product string from the running browser, e.g. "Obscura/0.1.0". */
  product?: string;
  /** True if a snapshot was found and we'll reattach. */
  willReattach: boolean;
  /** Active page URL, when known (only true on reattach). */
  activeUrl?: string;
  /** Active page title, when known. */
  activeTitle?: string;
  /** Element count from the most recent scan, when known. */
  activeElementCount?: number;
}

export function buildPrimer(input: PrimerInput): string {
  const headerLine = input.willReattach
    ? `Reattaching to **\`${input.browserId}\`**${
        input.product ? ` (${input.product})` : ""
      }.`
    : `Browser id: **\`${input.browserId}\`**${
        input.product ? ` (${input.product})` : ""
      }.`;

  const stateBlock =
    input.willReattach && input.activeUrl
      ? `\n\n**Current tab:** ${input.activeTitle ?? "(no title)"}, ${input.activeUrl}` +
        (input.activeElementCount !== undefined
          ? ` (${input.activeElementCount} elements scanned)`
          : "")
      : "";

  return [
    "## browsemode",
    "",
    "This session has a real browser available via the **`execute_browsemode`** tool. " +
      headerLine +
      stateBlock,
    "",
    "The browser persists across tool calls. Open tabs, scroll position, and cookies are kept; subsequent calls reattach to the same browser. Only call `execute_browsemode` again, the same way you'd write a second cell in a notebook.",
    "",
    "### How to use it",
    "",
    "Inside `execute_browsemode` the global `page` is your handle. **Every `page` call is async; you must `await` it.** Top-level `await` is supported; end with `return <value>` to surface the result.",
    "",
    "```js",
    'await page.goto("https://news.ycombinator.com");',
    "await page.scan();",
    "const markdown = await page.markdown(); // what a human can read",
    "const names = await page.list();        // what you can act on",
    "return { title: await page.title(), names: names.slice(0, 20), markdown: markdown.slice(0, 2000) };",
    "```",
    "",
    "### Discovering the API surface",
    "",
    "There are two discovery surfaces. Use both \u2014 they answer different questions:",
    "",
    "**`api.*`** \u2014 every callable PATH in the sandbox right now (page-level verbs, tab verbs, and one entry per element-name + element-verb pair like `loginButton.click`, `searchForm.submit`). Use this when you don't know what's available, or to validate args before a costly call.",
    "",
    "```js",
    "await api.list()                        // every callable path",
    'await api.list("page")                  // just page-level verbs',
    'await api.list("element")               // every <name>.<verb> pair',
    'await api.find("submit")                // ranked search across paths + descriptions',
    'await api.describe("page.scroll")       // {description, signature, inputs, examples}',
    'await api.check("page.scroll", { dy: 500 })   // {ok, missing, unknown, typeErrors}',
    "```",
    "",
    "**`page.list/find/describe`** \u2014 named ELEMENTS on the current page (their kind, text, role, supported verbs):",
    "",
    "```js",
    "await page.list()                       // element names only",
    'await page.find("login")                // → [{name, kind, text}]',
    'await page.describe("loginButton")      // → {name, kind, text, verbs, role, ...}',
    "```",
    "",
    'Recommended flow after navigation: read **both** `page.markdown()` and `page.list()`/`page.find()`. Markdown shows what a human-visible page says; the element catalog shows what can be clicked or filled. Labels may be localized, icon-only, or missing, so do not rely on `page.find()` alone. If `page.find("search")` misses a field, inspect `page.list()` and `page.describe(name)` for likely inputs/forms.',
    "",
    "Then use `api.find` or `page.find` to locate, `api.describe` (for verb schema) or `page.describe` (for element details), then call. Unknown names/paths throw with 'Did you mean' suggestions so typos self-correct.",
    "",
    "`api.check(path, args)` does NOT execute the verb; it just validates args. Use it before any expensive call when the agent is unsure of the shape.",
    "",
    "```js",
    "// Before doing real work, confirm the call shape:",
    'const c = await api.check("page.waitFor", { stable: { forMs: 1000 } });',
    'if (!c.ok) throw new Error("bad args: " + JSON.stringify(c));',
    "await page.waitFor({ stable: { forMs: 1000 } });",
    "```",
    "",
    "### Driving the page",
    "",
    "Element verbs use the `name.verb` shape (also async):",
    "",
    "```js",
    'await page.emailInput.fill("user@example.com");',
    "await page.signInButton.click();",
    "await page.waitFor({ stable: { forMs: 1000 } });",
    "return await page.title();              // current page title",
    "```",
    "",
    'Submitting a form: clicking the submit button often does not actually navigate; calling `.submit()` on the FORM element is reliable. Use `page.find("form")` or `api.list("element")` to locate the form name.',
    "",
    "```js",
    'await page.searchInput.fill("hello");',
    "await page.searchForm.submit();         // call .submit() on the FORM, not the button",
    "await page.waitFor({ stable: { forMs: 1500 } });",
    "return await page.title();",
    "```",
    "",
    "### What is NOT here",
    "",
    "There is no `page.eval`, no `document`, no `window`. You are not running inside the page; you are running in a small sandbox that talks to the page through the named verbs above. To read content the catalog doesn't surface, use `page.markdown()` first (clean human-readable page text) or `page.html()` when you need raw attributes. To act on something, find its name with `page.list()`/`page.find(query)` and use the element verbs.",
    "",
    "### When to scan",
    "",
    "After any navigation or DOM mutation. `page.click(...)` and `page.goto(...)` auto-rescan, so you usually don't need an explicit `await page.scan()` between calls. Force one if the page renders dynamically and the catalog looks stale. After fills/clicks that open dynamic UI — autocomplete suggestions, modal inputs, expanded menus, hidden search fields — wait briefly and scan again before acting on the new controls.",
    "",
    "```js",
    'await page.searchInput.fill("bert");',
    "await page.waitFor({ stable: { forMs: 500 } });",
    "await page.scan();                    // suggestions/results are now callable",
    "const names = await page.list();",
    "```",
    "",
    "### Returning a value",
    "",
    "Whatever you `return` from the body becomes the tool result. Plain values (strings, numbers, JSON-serializable objects) come back to you directly. If you forget to `return`, the result is `undefined`. There is no implicit return.",
  ].join("\n");
}
