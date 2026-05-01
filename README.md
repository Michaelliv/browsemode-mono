# 🦾 browsemode

**Code mode for the web.** Drive a real browser by writing typed JavaScript that addresses elements by name, not by selector or pixel coordinate.

```ts
await browser.exec(`
  await page.goto("https://news.ycombinator.com");
  await page.searchInput.fill("rust");
  await page.searchSubmit.click();
  return await page.list();
`);
```

That code runs against a live Chrome (or obscura, Brave, Edge, Arc) over CDP. The agent never writes selectors. It never waits manually. It never sees pixels.

## Why

Most browser tools for agents fall into one of two camps:

- **Selector-based frameworks** (Playwright, Selenium, Puppeteer) require fragile CSS or XPath. One DOM rename and the script breaks.
- **High-level agents** (browser-use, Stagehand `agent`) are autonomous loops that decide every click. They are unpredictable in production and burn tokens on each step.

browsemode sits between the two. The page is scanned into a **typed catalog of named elements**, fed to the model as part of its scratchpad, and the model writes one short script. The script runs in a QuickJS sandbox with the same `page` API a TypeScript caller would use. One reasoning step, many actions, deterministic dispatch.

## Quickstart

```bash
bun add browsemode
```

```ts
import { Browsemode } from "browsemode";

const browser = await Browsemode.connect({ id: "research", port: 9333 });
await browser.newPage({ url: "https://example.com" });
await browser.scan();

await browser.click("signInButton");
await browser.fill("emailInput", "user@example.com");

const result = await browser.exec(`
  await page.signInButton.click();
  await page.waitFor({ stable: { forMs: 1000 } });
  return await page.title();
`);

await browser.detach();
```

`browser.exec(code)` is the agent path. The string body runs inside a QuickJS sandbox. Every `page.*` call funnels back through the same `dispatch(path, args)` entry point that the TS sugar methods use, so behavior is identical.

## CLI

`browsemode` ships a CLI for direct use and as a transparent way to drive the SDK from any agent that can shell out:

```
$ browsemode read https://example.com           # URL to markdown, no browser needed
$ browsemode browser open --id research --url https://github.com
$ browsemode scan --browser research            # list every interactable element
$ browsemode exec --browser research 'return await page.find("login")'
$ browsemode cookies dump --domain github.com   # read Chrome cookies + decrypt
$ browsemode browser list                       # every saved browser
$ browsemode doctor                             # diagnose your setup
```

Every command supports `--json` for stable scripted output and `--quiet` for pipelines. Errors point at the next command to run.

## Features

**Named elements, not selectors.** A scan produces `{ name: "signInButton", kind: "button", text: "Sign in", ... }` for every interactable on the page. The names survive most DOM rewrites because they're derived from labels, ARIA, placeholder text, and surrounding context.

**Multi-browser by id.** Every `Browser` has an id. State (target ids, active tab, cookies) lives at `<cacheDir>/browsers/<id>.json`. `Browsemode.restore("research")` reattaches across processes:

```ts
const a = await Browsemode.connect({ id: "research" });
await a.detach();                                // keep the live browser, save state
const b = await Browsemode.restore("research");  // later, in another process
```

**Auto-fallback when the primary wedges.** Configure obscura as the primary and Chrome as the fallback. If the primary fails to settle within the timeout, browsemode spawns the managed Chrome and retries. The whole flow runs on either backend without code changes.

**Tiny footprint by default.** browsemode's recommended primary is [obscura](https://github.com/h4ckf0r0day/obscura), a Rust headless browser that speaks CDP. ~30 MB RAM per session vs Chrome's 200+ MB, ~70 MB single binary vs Chrome's 300+ MB install, ~85 ms page loads vs ~500 ms, and instant cold start vs Chrome's ~2 seconds. For a Docker image: copy one binary, no apt-get install of Chromium and its X11/font dependencies, no `--no-sandbox` ritual.

**Scope today.** obscura is v0.1.x, a young project (first release April 2026) actively filling out CDP coverage. browsemode is tested against it and degrades cleanly on the gaps. Out of the verbs we ship, on obscura you get the fast path for navigation, scan, fill, type, eval, markdown extraction, cookie injection, and JS-level click. You fall back to Chrome (auto, transparent) for clicks that need real layout coordinates, JavaScript dialogs (`alert` / `confirm` / `prompt`), browser-managed downloads, request interception via `Fetch.*`, screenshots, and any flow that requires a working `elementFromPoint` or `Page.getLayoutMetrics`. The fallback Browser instance is the same `Browser` class with a different backend, so calling code never branches on this. As obscura merges its [open CDP PRs](https://github.com/h4ckf0r0day/obscura/pulls) more flows shift to the obscura path automatically.

**Same one binary in Docker either way.** Even when you need Chrome fallback, the *primary* doesn't have to ship Chromium in the image. A pure-obscura image is ~70 MB and handles a real majority of read-heavy workloads. Add Chrome only when you know your flow needs it, or run two services and let the orchestrator pick.

**No screenshots, no vision models.** Pages convert to markdown via [markit](https://github.com/Michaelliv/markit) when the agent needs to read content. This is fast, deterministic, and costs near zero tokens compared to image input.

**Iframe support.** OOPIFs are auto-discovered and attached on every scan. Elements inside iframes appear in the same flat catalog, addressable by the same names.

**Cookie sync.** Read your real Chrome's cookies (SQLite + macOS Keychain) and inject them into a browsemode-managed browser. Useful for quickly priming a session without scripted login.

**One script, one reasoning step.** The QuickJS sandbox lets an agent write five actions, three waits, and a return value as one body. Compare to MCP-style tools where each click is a separate model round trip.

## Configuration

Every knob is a `BROWSEMODE_*` env var or a `Browsemode.configure({...})` call. The 15 most-used:

| Variable | Meaning |
|---|---|
| `BROWSEMODE_CACHE_DIR` | where snapshots live |
| `BROWSEMODE_DEFAULT_BROWSER_ID` | id used when none is passed |
| `BROWSEMODE_CHROME_PATH` | explicit Chrome binary (overrides auto-detection) |
| `BROWSEMODE_CHROME_PORT` | port for the managed Chrome |
| `BROWSEMODE_CHROME_ARGS` | extra Chrome flags (comma-separated) |
| `BROWSEMODE_SETTLE_MS` | how long to wait after a navigation |
| `BROWSEMODE_CDP_TIMEOUT_MS` | max time for any CDP call |
| `BROWSEMODE_PROBE_TIMEOUT_MS` | max time to verify a browser is alive |
| `BROWSEMODE_NAV_TIMEOUT_MS` | navigation timeout |
| `BROWSEMODE_NO_SHIM` | disable the obscura DOM shim |
| `BROWSEMODE_NO_STEALTH` | disable headless-detection patches |
| `BROWSEMODE_DEBUG` | verbose bus events to stderr |

Run `browsemode config show` for the full list and resolved values.

For Docker:

```dockerfile
ENV BROWSEMODE_CACHE_DIR=/data/browsemode
ENV BROWSEMODE_CHROME_PATH=/usr/bin/chromium
ENV BROWSEMODE_CHROME_ARGS=--no-sandbox,--disable-dev-shm-usage
ENV BROWSEMODE_DEFAULT_BROWSER_ID=container-1
```

## How it compares

| | browsemode | browser-use | Stagehand | Playwright MCP |
|---|---|---|---|---|
| Element addressing | named (`page.signInButton`) | numeric index (`click 0`) | natural language (`act("click sign in")`) | accessibility refs (`ref=e3`) |
| Reasoning per task | one script | many tool calls | many primitives | many tool calls |
| Driver | direct CDP | direct CDP | Playwright | Playwright |
| Default browser | obscura v0.1.x (Rust, 30 MB RAM) | Chromium (200+ MB RAM) | Chromium (200+ MB RAM) | Chromium (200+ MB RAM) |
| Docker image cost | ~70 MB binary, no Chrome | full Chromium install | full Chromium install | full Chromium install |
| Cold start | instant | ~2 s | ~2 s | ~2 s |
| Fallback browser | Chrome, Brave, Edge, Arc (transparent) | Chromium | Chromium / cloud | Chromium / Firefox / WebKit |
| Layout-aware click | Chrome only (obscura: JS click) | yes | yes | yes |
| JS dialogs (alert/confirm/prompt) | Chrome only (obscura no-ops them) | yes | yes | yes |
| Browser-level downloads | Chrome only | yes | yes | yes |
| Request interception (Fetch.*) | Chrome only (obscura PR [#50](https://github.com/h4ckf0r0day/obscura/pull/50) pending) | not exposed | yes | yes |
| Vision | markdown via markit | screenshots | optional | accessibility snapshots |
| Sandbox | QuickJS | none | none | none |
| Persistence | id-keyed snapshots | session dir | profile dir | profile dir |

This is not a "better than" claim. The right tool depends on the workload. browsemode is built for agents that already speak code well and want a low-token, deterministic surface where one block of JS replaces a chain of tool calls.

## Repo layout

This is a Bun workspace monorepo:

```
packages/browsemode/    SDK + CLI (this is what most users want)
packages/pi-browse/     pi extension wrapping the SDK as 6 agent tools
```

The `pi-browse` package is consumed via `workspace:*` and exposes browsemode through the [pi](https://github.com/Anthropic/pi) extension protocol.

## Development

```bash
bun install
bun test                # 199 tests across both packages
bun run typecheck       # tsc --noEmit
bun run lint            # biome check
bun run packages/browsemode/src/cli/main.ts --help
```

CI runs tests, typecheck, and lint on every push.

For agents working in this repo, see [AGENTS.md](AGENTS.md) for architecture, conventions, and how to add new verbs and CLI commands.

## Status

Early, on both sides. The SDK is stable enough to drive real flows; the CLI is shipping; the watchdog scaffold (popups, downloads) is in place. Anti-bot defenses (Cloudflare TLS fingerprinting, canvas-based UIs) are known gaps.

Obscura is at v0.1.x and rapidly filling CDP gaps. browsemode pins no specific obscura version but is tested against the current release. We catch obscura's missing surfaces (`elementFromPoint`, `Page.getLayoutMetrics`, real `Fetch` interception, dialog events, downloads) at runtime and fall back to Chrome where needed. As obscura merges its open PRs, more flows shift to the obscura path with no code change here.

If you're choosing a stack today: use browsemode if you want a single API that runs against either backend, with the small one for the easy 80% of pages and the heavy one only when forced. Use Stagehand or browser-use directly if you want a polished Chromium-first experience and don't care about the deployment cost.

## License

MIT. See [LICENSE](LICENSE).
