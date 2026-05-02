# pi-browsemode

Code mode for the web, in [pi](https://pi.dev).

A pi extension that gives the agent **one tool** to drive a real browser via [browsemode](https://github.com/Michaelliv/browsemode-mono). Modeled on [pi-runline](https://www.npmjs.com/package/pi-runline): single tool, in-sandbox element discovery, browser persists across tool calls. The system prompt stays small because nothing is dumped into context up front; the agent uses helpers inside the sandbox to find what it needs.

## Quick start - local Chrome

```bash
pi install pi-browsemode
```

The `execute_browsemode` tool is now available. By default, pi-browsemode launches a managed local Chrome and persists the browser under the id `pi-browse`.

(or, while developing in this monorepo, the extension is auto-discovered when pi runs in a subdirectory of `packages/pi-browsemode/`.)

## Cloud / remote browser providers

pi-browsemode can also run against hosted browser providers. The agent-facing tool does not change: every provider exposes the same `execute_browsemode` sandbox, same scanner, same tab verbs, and same element catalog. Providers are just different places where the Chromium/CDP session lives.

Set an API key and the router auto-detects the provider:

```bash
export STEEL_API_KEY=...              # or Browserbase / Browserless / Hyperbrowser
pi install pi-browsemode
```

Provider priority is: Steel, Browserbase, Browserless, Hyperbrowser, generic remote CDP, Obscura, managed Chrome.

To force a provider explicitly:

```bash
export PI_BROWSE_PROVIDER=steel       # chrome | obscura | remote-cdp | steel | browserbase | browserless | hyperbrowser
```

## Providers

| Provider | Env vars | Notes |
|---|---|---|
| **Managed Chrome** | none | Default. Starts local Chrome via browsemode. |
| **Obscura** | `PI_BROWSE_PROVIDER=obscura`, optional `PI_BROWSE_OBSCURA_PORT` | Tries Obscura on port `9333`; falls back to Chrome if unavailable. |
| **Remote CDP** | `PI_BROWSE_CDP_WS_URL` or `PI_BROWSE_CDP_HOST` + `PI_BROWSE_CDP_PORT` | Connects to any existing CDP-compatible browser. |
| **Steel** | `STEEL_API_KEY` | Creates a Steel session, connects over CDP, releases the session on close. Optional: `STEEL_API_URL`, `STEEL_USE_PROXY`, `STEEL_SOLVE_CAPTCHA`, `STEEL_SESSION_TIMEOUT_MS`. |
| **Browserbase** | `BROWSERBASE_API_KEY` | Creates a Browserbase session and connects to `connectUrl`. Optional: `BROWSERBASE_PROJECT_ID`, `BROWSERBASE_REGION`, `BROWSERBASE_KEEP_ALIVE`. |
| **Browserless** | `BROWSERLESS_API_TOKEN` | Connects directly to Browserless websocket. Optional: `BROWSERLESS_WS_URL`, `BROWSERLESS_BLOCK_ADS`. |
| **Hyperbrowser** | `HYPERBROWSER_API_KEY` | Creates a Hyperbrowser session, connects to `wsEndpoint`, stops the session on close. Optional: `HYPERBROWSER_API_URL`. |

Steel, Browserbase, Browserless, and Hyperbrowser have all been smoke-tested with navigation, scanning, and tab operations through the normal browsemode CDP path.

## How the agent uses it

On `session_start`, the extension injects a short primer naming the surface and registers a single tool:

- **`execute_browsemode`**: run JavaScript in browsemode's QuickJS sandbox against a real browser. The global `page` is your handle. Top-level `await` works; `return` surfaces the result; logs are captured.

Discovery happens **inside the sandbox**, not as a separate tool. The agent uses `api.*` to inspect callable paths and `page.*` to inspect the current page catalog:

```js
await api.list()                        // every callable path
await api.list("page")                  // page-level verbs
await api.list("element")               // every <name>.<verb> pair
await api.find("submit")                // ranked search across callable paths
await api.describe("page.scroll")       // schema, description, examples
await api.check("page.scroll", { dy: 500 })

await page.list()                       // every element name on the active page
await page.find("login")                // ranked fuzzy search → [{name, kind, text}]
await page.describe("loginButton")      // → {name, kind, text, verbs, role, ...}
```

Unknown names and paths throw with did-you-mean suggestions, so typos self-correct. Recommended flow: navigate, scan, inspect both `page.markdown()` and `page.list()`/`page.find()`, then call the named element verb.

Calling actions uses the same `page` proxy:

```js
await page.goto("https://example.com");
await page.scan();
await page.emailInput.fill("user@example.com");
await page.signInButton.click();
await page.waitFor({ stable: { forMs: 1000 } });
return await page.title();
```

The browser persists across tool invocations. Each `execute_browsemode` call is like a new cell in a notebook against the same kernel: open tabs, scroll position, and cookies all carry forward. Tabs work across local and cloud providers:

```js
const id = await page.tabs.open("https://news.ycombinator.com");
await page.tabs.list();
await page.tabs.switch(id);
await page.tabs.close(id);
```

## Commands

```
/browsemode-status   Show the current browser id, URL, and tab count
/browsemode-id <id>  Switch to a different browser id (multi-project isolation)
/browsemode-close    Close the browser, drop its snapshot
```

## Configuration

| Env var | Meaning |
|---|---|
| `PI_BROWSE_BROWSER_ID` | Browser id this session attaches to. Default `pi-browse`. Different projects can pin different ids and stay isolated. |
| `PI_BROWSE_PROVIDER` | Explicit provider: `chrome`, `obscura`, `remote-cdp`, `steel`, `browserbase`, `browserless`, or `hyperbrowser`. |
| `PI_BROWSE_BACKEND` | Legacy alias for `PI_BROWSE_PROVIDER`; kept for eval runners. |
| `PI_BROWSE_OBSCURA_PORT` | Port where Obscura is listening. Default `9333`. |
| `PI_BROWSE_CDP_WS_URL` | Full websocket URL for a remote CDP browser. |
| `PI_BROWSE_CDP_HOST` / `PI_BROWSE_CDP_PORT` | Host/port for a remote CDP browser exposing `/json/version`. |

Local browser state is persisted under `~/.cache/browsemode/browsers/<id>.json`, so a `pi --resume` can reattach to the same local browser state. Cloud sessions support the same in-session tabs and actions, but durable restore depends on the provider session still being alive.

## Schema

![Schema](schemas.png)

pi-browsemode intentionally exposes one small tool schema. All page/action discovery happens inside the sandbox at runtime.

```ts
execute_browsemode({
  code: string // JavaScript body. Await page/api calls and return a value.
})
```

The result is the returned JSON-serializable value, plus captured logs. This mirrors the `pi-websearch` README style: a small stable agent-facing schema, with provider-specific complexity hidden behind the router.

## Architecture

```
packages/
├── browsemode/              # SDK: CDP, Browser, Page, scanner, verbs, sandbox
└── pi-browsemode/
    ├── src/providers.ts     # Provider router: Chrome, Obscura, CDP, Steel, Browserbase, Browserless, Hyperbrowser
    ├── src/state.ts         # One persistent Browser per pi session
    ├── src/primer.ts        # Session-start instructions for the agent
    └── .pi/extensions/...   # Single execute_browsemode tool
```

Provider adapters normalize everything to a browsemode `Browser` over CDP. After connection, the scanner, verbs, tabs, sandbox, and `api.*` introspection are identical regardless of where the browser is running.

## License

MIT.
