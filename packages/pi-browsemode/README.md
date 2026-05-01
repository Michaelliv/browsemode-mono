# pi-browsemode

Code mode for the web, in [pi](https://pi.dev).

A pi extension that gives the agent **one tool** to drive a real browser via [browsemode](https://github.com/Michaelliv/browsemode-mono). Modeled on [pi-runline](https://www.npmjs.com/package/pi-runline): single tool, in-sandbox element discovery, browser persists across tool calls. The system prompt stays small because nothing is dumped into context up front; the agent uses helpers inside the sandbox to find what it needs.

## Install

```bash
pi install pi-browsemode
```

(or, while developing in this monorepo, the extension is auto-discovered when pi runs in a subdirectory of `packages/pi-browsemode/`.)

## How the agent uses it

On `session_start`, the extension injects a short primer naming the surface and registers a single tool:

- **`execute_browsemode`**: run JavaScript in browsemode's QuickJS sandbox against a real browser. The global `page` is your handle. Top-level `await` works; `return` surfaces the result; logs are captured.

Discovery happens **inside the sandbox**, not as a separate tool. The agent uses three helpers on `page` to explore the catalog:

```js
page.list()                   // every element name on the active page
page.find("login")            // ranked fuzzy search → [{name, kind, text}]
page.describe("loginButton")  // → {name, kind, text, verbs, role, ...}
```

Unknown names throw with did-you-mean suggestions, so typos self-correct. Recommended flow: `find` to locate, `describe` to confirm the verb is supported, then call.

Calling actions uses the same `page` proxy:

```js
await page.goto("https://example.com");
await page.scan();
await page.emailInput.fill("user@example.com");
await page.signInButton.click();
await page.waitFor({ stable: { forMs: 1000 } });
return page.title;
```

The browser persists across tool invocations. Each `execute_browsemode` call is like a new cell in a notebook against the same kernel: open tabs, scroll position, and cookies all carry forward.

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
| `PI_BROWSE_OBSCURA_PORT` | Port where obscura is listening. Default `9333`. |

The extension tries obscura first, falls back to a managed Chrome if obscura isn't reachable. State is persisted under `~/.cache/browsemode/browsers/<id>.json`, so a `pi --resume` reattaches to exactly the same browser state.

## License

MIT.
