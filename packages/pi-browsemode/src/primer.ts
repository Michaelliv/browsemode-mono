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
    "Inside `execute_browsemode` the global `page` is your handle. Top-level `await` is supported; end with `return <value>`.",
    "",
    "```js",
    'await page.goto("https://news.ycombinator.com");',
    "await page.scan();",
    "return page.list().slice(0, 10);   // first 10 element names",
    "```",
    "",
    "### In-sandbox discovery",
    "",
    "The page is scanned into a typed catalog of named elements. You don't need a separate tool to find them; three helpers live on `page`:",
    "",
    "```js",
    "page.list()                          // every element name",
    'page.find("login")                   // ranked fuzzy search → [{name, kind, text}]',
    'page.describe("loginButton")         // → {name, kind, text, verbs, role, ...}',
    "```",
    "",
    "Unknown names throw with did-you-mean suggestions. Recommended flow: `find` to locate, `describe` to confirm the verb is supported, then call.",
    "",
    "### Driving the page",
    "",
    "Element verbs use the `name.verb` shape:",
    "",
    "```js",
    'await page.emailInput.fill("user@example.com");',
    "await page.signInButton.click();",
    "await page.waitFor({ stable: { forMs: 1000 } });",
    "return page.title;",
    "```",
    "",
    "Page-level verbs (`goto`, `scan`, `wait`, `waitFor`, `scroll`, `eval`, `markdown`, `read`, ...) are direct calls on `page`. Tab management lives under `page.tabs.{list,open,switch,close}`. The full surface is whatever `page.list()` returns plus the verbs `describe(name)` reports for each element.",
    "",
    "### When to scan",
    "",
    "After any navigation or DOM mutation. `page.click(...)` and `page.goto(...)` auto-rescan, so you usually don't need an explicit `page.scan()` between calls. Force one if the page renders dynamically and the catalog looks stale.",
  ].join("\n");
}
