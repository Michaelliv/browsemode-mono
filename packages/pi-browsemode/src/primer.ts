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
    "const names = await page.list();        // every element name",
    "return names.slice(0, 10);",
    "```",
    "",
    "### Discovery (do this before guessing element names)",
    "",
    "The page is scanned into a typed catalog of named elements. Three helpers live on `page`:",
    "",
    "```js",
    "await page.list()                       // every element name",
    'await page.find("login")                // ranked fuzzy search → [{name, kind, text}]',
    'await page.describe("loginButton")      // → {name, kind, text, verbs, role, ...}',
    "```",
    "",
    "Unknown names throw with did-you-mean suggestions, so typos self-correct. Recommended flow: `find` to locate, `describe` to confirm the verb is supported, then call.",
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
    "**Verbs by element kind** (call `page.describe(name)` for the exact list per element):",
    "",
    "- **button / link**: `click`, `text` (link adds `href`)",
    "- **text / textarea (input fields)**: `fill`, `clear`, `value`, `focus`",
    "- **checkbox**: `check`, `uncheck`, `toggle`, `isChecked`",
    "- **radio**: `select`, `isSelected`",
    "- **select**: `choose`, `options`, `value`",
    "- **form**: `submit`, `fields`, `fill`",
    "",
    "**Submitting a form**: clicking a submit button often does not actually navigate (depends on the browser backend). Calling `submit()` on the form element is reliable. Use `page.find(\"form\")` or `page.list()` to locate the form name.",
    "",
    "```js",
    'await page.searchInput.fill("hello");',
    "await page.searchForm.submit();         // call .submit() on the FORM, not the button",
    "await page.waitFor({ stable: { forMs: 1500 } });",
    "return await page.title();",
    "```",
    "",
    "**Common page-level verbs:**",
    "",
    "- **State**: `await page.title()`, `await page.url()`, `await page.html()`, `await page.markdown()`, `await page.read()`",
    "- **Navigation**: `await page.goto(url)`, `await page.scan()`, `await page.wait(ms)`, `await page.waitFor({...})`, `await page.scroll({...})`",
    "- **Tabs**: `await page.tabs.list()`, `await page.tabs.open(url)`, `await page.tabs.switch(id)`, `await page.tabs.close(id)`",
    "",
    "### What is NOT here",
    "",
    "There is no `page.eval`, no `document`, no `window`. You are not running inside the page; you are running in a small sandbox that talks to the page through the named verbs above. To read content the catalog doesn't surface, use `page.html()` (raw) or `page.markdown()` (clean). To act on something, find its name with `page.find(query)` and use the element verbs.",
    "",
    "### When to scan",
    "",
    "After any navigation or DOM mutation. `page.click(...)` and `page.goto(...)` auto-rescan, so you usually don't need an explicit `await page.scan()` between calls. Force one if the page renders dynamically and the catalog looks stale.",
    "",
    "### Returning a value",
    "",
    "Whatever you `return` from the body becomes the tool result. Plain values (strings, numbers, JSON-serializable objects) come back to you directly. If you forget to `return`, the result is `undefined`. There is no implicit return.",
  ].join("\n");
}
