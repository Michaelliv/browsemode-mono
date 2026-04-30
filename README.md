# browsemode

> Code mode for the web. The page becomes a typed JS surface; agents drive it from a QuickJS sandbox over CDP.

`browsemode` turns any live web page into a named-element API. Instead of writing CSS selectors and waiting for things, you call `page.signInButton.click()`, `page.emailInput.fill("…")`, `page.waitFor({ stable: { forMs: 2000 } })`. An LLM agent writes one short script and the framework handles the rest.

It works with **obscura** (a Rust-based headless browser) or any local **Chrome / Chromium / Brave / Edge / Arc** — auto-falling back when the primary wedges.

This repo is a workspace containing the SDK + CLI and a pi extension that wraps it.

## Packages

| Package | What it is |
|---|---|
| [`browsemode`](packages/browsemode) | The SDK + CLI. `import { Browsemode } from "browsemode"` or `npx browsemode <command>`. |
| [`pi-browse`](packages/pi-browse) | Pi extension that exposes browsemode as 6 tools (`browse_open`, `browse_scan`, `browse_dispatch`, `browse_exec`, `browse_read`, `browse_close`). |

## Install

```bash
bun install
```

The repo uses Bun workspaces. Both packages share `node_modules` and the SDK is consumed by `pi-browse` via `workspace:*`.

## Quick start (CLI)

```bash
# Doctor — verify your setup
bun run packages/browsemode/src/cli/main.ts doctor

# Read a page (no browser needed)
bun run packages/browsemode/src/cli/main.ts read https://example.com

# Open a browser, navigate, scan, exec
bun run packages/browsemode/src/cli/main.ts browser open --id research --url https://github.com
bun run packages/browsemode/src/cli/main.ts scan --browser research
bun run packages/browsemode/src/cli/main.ts exec --browser research \
  'return await page.find("login")'

# Multi-browser
bun run packages/browsemode/src/cli/main.ts browser open --id scratch
bun run packages/browsemode/src/cli/main.ts browser list
```

## Quick start (SDK)

```ts
import { Browsemode } from "browsemode";

const browser = await Browsemode.connect({ id: "research", port: 9333 });
await browser.newPage({ url: "https://example.com" });
await browser.scan();

await browser.click("signInButton");
await browser.fill("emailInput", "user@example.com");
await browser.exec(`
  await page.signInButton.click();
  return await page.title();
`);

await browser.detach();   // keep tabs alive, snapshot for next session
// later in another process:
const same = await Browsemode.restore("research");
```

## Configuration

Every knob is configurable via env or `Browsemode.configure({...})`. Highlights for Docker:

```dockerfile
ENV BROWSEMODE_CACHE_DIR=/data/browsemode
ENV BROWSEMODE_CHROME_PATH=/usr/bin/chromium
ENV BROWSEMODE_CHROME_ARGS=--no-sandbox,--disable-dev-shm-usage
ENV BROWSEMODE_DEFAULT_BROWSER_ID=container-1
```

Run `browsemode config show` to see the resolved values.

## Architecture

Three layers, top to bottom:

- **`Browser`** — owns the CDP socket + a map of `Page`s. Page-method passthrough (`browser.click(...)` routes to `activePage`).
- **`Page`** — the typed surface over one tab. Single-entry `dispatch(path, args)` for both TS callers and the QuickJS sandbox; verb tables in `page/verbs/{page,element,keyboard}.ts`.
- **`Sandbox`** — QuickJS runtime per `exec` call; the `page` proxy funnels every call back through `Page.dispatch`.

Multi-instance: every `Browser` has an `id`. Snapshots live at `<cacheDir>/browsers/<id>.json`. `Browsemode.restore("research")` reattaches.

## Development

```bash
bun test                      # all packages
bun run typecheck             # tsc --noEmit, both packages
bun run lint                  # biome
```

CI runs `bun test` + `bun run typecheck` on every push.

## License

MIT — see [LICENSE](LICENSE).
