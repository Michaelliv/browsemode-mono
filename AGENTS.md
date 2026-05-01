# AGENTS.md

Project-level instructions for AI agents working in this repo.

## What this is

A monorepo with two packages:

- **`packages/browsemode`** — TypeScript SDK + CLI. Drives a real browser (obscura, Chrome, Chromium, Brave, Edge, Arc) over CDP. The browser's interactable elements are scanned into a typed catalog so an agent can write `page.signInButton.click()` instead of guessing CSS selectors.
- **`packages/pi-browsemode`** — pi extension. Single tool (`execute_browsemode`), in-sandbox element discovery, browser persists across calls. Modeled on the runline pattern.

Bun workspaces. `pi-browsemode` consumes `browsemode` via `workspace:*`.

## Commands

```bash
bun install                          # install workspace deps
bun test                             # run all package tests (174 today)
bun run typecheck                    # tsc --noEmit, both packages
bun run lint                         # biome check
bun run lint:fix                     # biome fix
bun run packages/browsemode/src/cli/main.ts --help   # try the CLI
```

## Architecture

```
packages/browsemode/src/
├── index.ts                  Public SDK barrel + Browsemode namespace
├── types.ts                  Shared types (ElementInfo, ScanResult, ...)
├── config.ts                 Global config — env + configure() + getConfig()
├── bus.ts                    Typed event bus (per-Browser + global onEvent)
│
├── cdp/                      Wire layer
│   ├── client.ts             CDP class (WebSocket, send, on, timeouts)
│   └── session.ts            Session = (CDP, sessionId) + evalJSON/evalString
│
├── browser/
│   ├── browser.ts            Browser class — connect/launch/restore, pages map,
│   │                         persistence, page-method passthrough sugar
│   ├── chrome.ts             findChrome / ensureChrome / chromeStatus / stopChrome
│   └── cookies.ts            readChromeCookies (SQLite + Keychain) / toCdpCookies
│
├── page/
│   ├── page.ts               Page class — scan, dispatch (single entry), exec
│   ├── frame.ts              OOPIF discovery + per-iframe Session attach
│   ├── scanner.ts            SCAN_SCRIPT (runs in the page; produces ScanResult)
│   ├── shim.ts               DOM polyfills for obscura
│   ├── stealth.ts            Headless-detection patches
│   ├── markdown.ts           htmlToMarkdown / urlToMarkdown / extractSections
│   └── verbs/
│       ├── page.ts           PAGE_VERBS table — every page-level verb
│       ├── element.ts        ELEMENT_VERBS table — every element-level verb
│       └── keyboard.ts       typeText / sendKey / KEY_MAP
│
├── sandbox/
│   ├── sandbox.ts            QuickJS sandbox (one per exec call)
│   └── proxy.ts              The `page` proxy template
│
├── orchestration/
│   ├── expectation.ts        meetsExpectation + parseExpectationSpec
│   ├── fallback.ts           openWithFallback (primary → Chrome retry)
│   └── persistence.ts        Multi-browser snapshots under <cacheDir>/browsers/
│
└── cli/
    ├── main.ts               Commander entry, global flags, no-args banner
    ├── output.ts             chalk + output() triple (json/quiet/human)
    ├── flags.ts              Shared flag parsing
    ├── browser-handle.ts     "give me a Browser by id" (restore-or-open)
    └── commands/             One file per command group
```

## Key patterns

### Single dispatch path

`Page.dispatch(path, args)` is the **one** entry point used by both TS callers and the QuickJS sandbox. Path forms:

- `"verb"` — page-level verb (goto, scan, waitFor, …)
- `"name.verb"` — element verb (signInButton.click, emailInput.fill, …)
- `"tabs.verb"` — multi-tab management (delegated to Browser)

Every sugar method (`page.click(name, args)`, `browser.exec(code)`, etc.) is a thin wrapper over `dispatch`.

### Verb tables

`PAGE_VERBS` and `ELEMENT_VERBS` are plain object literals — keys are verb names, values are async handlers. Adding a verb = one entry. The sandbox proxy auto-discovers page verbs via `pageVerbNames()`.

### Multi-browser

Every `Browser` has an `id`. Snapshots live at `<cacheDir>/browsers/<id>.json`. `Browsemode.restore("research")` reattaches to the live tabs (their CDP target ids stay valid across browser restarts as long as the user-data-dir does).

### Bus events, not stderr

The SDK never prints. `Browser.bus` emits typed events (`iframe.attached`, `nav.timeout`, `fallback.triggered`, `scan.complete`, `session.persisted`, …). The CLI subscribes; library callers ignore by default. A global `config.onEvent` hook fires alongside per-bus subscribers.

### Configuration precedence

1. Per-call opts (e.g. `connect({ shim: true })`)
2. `Browsemode.configure({...})`
3. `process.env.BROWSEMODE_*`
4. Hardcoded defaults

### Output triple

Every CLI command supports three modes via `output(opts, { json, quiet, human })`:
- `--json` — deterministic JSON to stdout (stable for scripts)
- `--quiet` — only essential output (e.g. exec's result, no banner)
- default — chalk-colored human format with state-change hints and next-step suggestions

## Adding a new verb

1. Add the handler to `page/verbs/page.ts` (`PAGE_VERBS["myVerb"]`) or `page/verbs/element.ts` (`ELEMENT_VERBS["myVerb"]`).
2. If it changes the catalog (navigates / mutates DOM), add the verb name to `NAVIGATING_PAGE_VERBS` or `NAVIGATING_ELEMENT_VERBS` for auto-rescan.
3. (Optional) add a sugar method on `Page` and on `Browser` (passthrough).
4. Write a test in `test/verbs-{page,element}.test.ts` asserting the registry contains it.

The QuickJS sandbox auto-discovers page verbs via `pageVerbNames()` — no proxy update needed.

## Adding a new CLI command

1. Create `src/cli/commands/<name>.ts`. Take `(positionalArgs, flags: GlobalFlags)`. Use `applyGlobalFlags(flags)` to honor `--cache-dir` etc, and `output(outputOpts(flags), {...})` for the output triple.
2. Wire it in `src/cli/main.ts`:
   ```ts
   program
     .command("<name>")
     .description("...")
     .action(async (_local, cmd) => {
       await myCmd(parseGlobalFlags(cmd.optsWithGlobals()));
     });
   ```
3. Smoke-test: `bun run packages/browsemode/src/cli/main.ts <name> --help`.

## Style rules

- **Every file uses `.js` extensions in imports.** TypeScript compiles to JS, Node ESM requires extensions.
- **Never use `bun:sqlite` from npm-published code paths** — limit it to the cookies module which is bun-only by design (we'd port to `sql.js` if cookies ever needed cross-runtime support).
- **CLI shebang is `#!/usr/bin/env bun`**, not node. The SDK depends on bun-only modules.
- **No `process.stderr.write` in SDK code.** Emit a Bus event instead. The CLI subscribes. The one exception is `config.ts`'s `BROWSEMODE_DEBUG=1` subscriber — that's the implementation of an explicit opt-in feature, not a leak.
- **Tests live under `packages/<pkg>/test/`** matching the source path. `bun test` runs all of them.
