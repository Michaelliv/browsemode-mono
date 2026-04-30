// `browsemode browser <list|open|close|forget|status|launch|stop>`
// Lifecycle management for the on-disk browsers and the managed Chrome.

import {
  chromeStatus,
  ensureChrome,
  findChrome,
  stopChrome,
} from "../../browser/chrome.js";
import { Browsemode } from "../../index.js";
import { ensureBrowser } from "../browser-handle.js";
import { EXIT_NOT_FOUND, EXIT_USER_ERROR } from "../exit-codes.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts } from "../flags.js";
import {
  hint,
  info,
  lineOut,
  nextStep,
  output,
  renderError,
  success,
  warn,
} from "../output.js";

// ── browser list ──

export async function browserList(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const browsers = Browsemode.listBrowsers();

  output(opts, {
    json: () => browsers,
    quiet: () => {
      for (const b of browsers) lineOut(b.id);
    },
    human: () => {
      if (browsers.length === 0) {
        lineOut("(no saved browsers)");
        nextStep("browsemode browser open --id <name> --url <url>", opts);
        return;
      }
      for (const b of browsers) {
        const age = ageLabel(b.ts);
        lineOut(
          `${b.id.padEnd(20)} ${b.product.padEnd(18)} :${b.port.toString().padEnd(5)} ${b.tabs.length} tab(s)  ${age}`
        );
      }
    },
  });
}

// ── browser open ──

export interface OpenOpts extends GlobalFlags {
  id?: string;
  url?: string;
}

export async function browserOpen(flags: OpenOpts): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const id =
    flags.id ?? flags.browser ?? Browsemode.config().defaultBrowserId;

  const { browser, opened, fellBack } = await ensureBrowser({
    ...flags,
    browser: id,
  });
  try {
    const scan = await browser.scan();
    browser.snapshot();

    output(opts, {
      json: () => ({
        id: browser.id,
        product: browser.product,
        opened,
        fellBack,
        url: scan.url,
        title: scan.title,
        elements: scan.elements.length,
      }),
      quiet: () => lineOut(browser.id),
      human: () => {
        success(
          `${opened ? "opened" : "reattached to"} '${browser.id}' on ${browser.product || "primary"}`,
          opts
        );
        if (fellBack) hint("primary wedged — fell back to managed Chrome", opts);
        lineOut(`  url:    ${scan.url}`);
        if (scan.title) lineOut(`  title:  ${scan.title}`);
        lineOut(`  elems:  ${scan.elements.length}`);
        lineOut("");
        nextStep(`browsemode scan --browser ${browser.id}`, opts);
        nextStep(
          `browsemode exec --browser ${browser.id} 'return await page.list()'`,
          opts
        );
      },
    });
  } finally {
    await browser.detach();
  }
}

// ── browser close ──

export interface CloseOpts extends GlobalFlags {
  id?: string;
}

export async function browserClose(flags: CloseOpts): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const id =
    flags.id ?? flags.browser ?? Browsemode.config().defaultBrowserId;

  let browser;
  try {
    browser = await Browsemode.restore(id);
  } catch (e: any) {
    // Already gone or unreachable. Drop the snapshot file anyway.
    Browsemode.forgetBrowser(id);
    output(opts, {
      json: () => ({ id, closed: false, snapshotDropped: true }),
      human: () => {
        warn(`browser '${id}' was unreachable — snapshot dropped`, opts);
        hint(e?.message ?? String(e), opts);
      },
    });
    return;
  }
  await browser.close();
  output(opts, {
    json: () => ({ id, closed: true, snapshotDropped: true }),
    quiet: () => {},
    human: () => success(`closed '${id}' (snapshot dropped)`, opts),
  });
}

// ── browser forget ──

export interface ForgetOpts extends GlobalFlags {
  id?: string;
}

export async function browserForget(flags: ForgetOpts): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const id =
    flags.id ?? flags.browser ?? Browsemode.config().defaultBrowserId;
  Browsemode.forgetBrowser(id);
  output(opts, {
    json: () => ({ id, snapshotDropped: true }),
    quiet: () => {},
    human: () => success(`dropped snapshot for '${id}' (live browser unaffected)`, opts),
  });
}

// ── browser status ──

export async function browserStatus(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const id = flags.browser;
  const browsers = Browsemode.listBrowsers();
  const found = id ? browsers.filter((b) => b.id === id) : browsers;

  if (id && found.length === 0) {
    renderError(
      {
        message: `no browser with id '${id}'`,
        next: [
          "browsemode browser list",
          `browsemode browser open --id ${id}`,
        ],
      },
      opts
    );
    process.exit(EXIT_NOT_FOUND);
  }

  output(opts, {
    json: () => found,
    human: () => {
      for (const b of found) {
        info(`${b.id} — ${b.product}`, opts);
        lineOut(`  endpoint: ${b.host}:${b.port}`);
        lineOut(`  tabs:     ${b.tabs.length}`);
        lineOut(`  active:   ${b.activeTargetId || "(none)"}`);
        lineOut(`  saved:    ${ageLabel(b.ts)}`);
      }
    },
  });
}

// ── browser launch / stop (managed Chrome) ──

export async function browserLaunch(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const exec = findChrome();
  if (!exec) {
    renderError(
      {
        message: "no Chrome / Chromium / Brave / Edge / Arc found",
        hints: [
          "set BROWSEMODE_CHROME_PATH to an explicit binary path, OR",
          "Browsemode.configure({ chrome: { path: '/usr/bin/chromium' } })",
        ],
      },
      opts
    );
    process.exit(EXIT_USER_ERROR);
  }
  const port = await ensureChrome();
  output(opts, {
    json: () => ({ port, exec }),
    quiet: () => lineOut(String(port)),
    human: () => success(`Chrome up on :${port} (${exec})`, opts),
  });
}

export async function browserStop(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const r = await stopChrome();
  output(opts, {
    json: () => r,
    quiet: () => {},
    human: () =>
      r.stopped
        ? success(`stopped managed Chrome (pid ${r.pid})`, opts)
        : info("no managed Chrome running", opts),
  });
}

// ── chrome status (legacy alias kept under `browser status`) ──

export async function chromeStatusCmd(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const status = await chromeStatus();
  const exec = findChrome();
  output(opts, {
    json: () => ({ ...status, exec }),
    human: () => {
      if (status.running) {
        success(
          `managed Chrome running — pid ${status.pid}, port ${status.port}`,
          opts
        );
      } else {
        info("no managed Chrome running", opts);
      }
      lineOut(`  binary: ${exec ?? "(not found)"}`);
    },
  });
}

// ── helpers ──

function ageLabel(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
