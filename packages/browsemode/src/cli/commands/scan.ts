// `browsemode scan [--browser <id>] [--url <url>]`
// Print interactable elements on the active page.

import { ensureBrowser } from "../browser-handle.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts, resolveBrowserId } from "../flags.js";
import { hint, info, lineOut, nextStep, output } from "../output.js";

export interface ScanOpts extends GlobalFlags {
  url?: string;
}

export async function scanCmd(flags: ScanOpts): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const id = resolveBrowserId(flags);
  if (!opts.json && !opts.quiet) info(`browser '${id}'`, opts);

  const { browser, opened, fellBack } = await ensureBrowser({
    ...flags,
    url: flags.url,
  });
  if (!opts.json && !opts.quiet) {
    if (opened) hint(`opened on ${browser.product || "primary"}`, opts);
    if (fellBack) hint("primary wedged — fell back to managed Chrome", opts);
  }

  try {
    if (flags.url) await browser.goto(flags.url);
    const scan = await browser.scan();
    browser.snapshot();

    output(opts, {
      json: () => scan,
      quiet: () => {
        for (const e of scan.elements) lineOut(e.name);
      },
      human: () => {
        if (scan.elements.length === 0) {
          lineOut("(no interactable elements)");
          return;
        }
        for (const e of scan.elements) {
          const verbs = e.verbs.join("|");
          const text = e.text.slice(0, 60).replace(/\s+/g, " ");
          lineOut(
            `${e.name.padEnd(36)} ${e.kind.padEnd(10)} [${verbs}]  ${text}`,
          );
        }
        const colls = Object.entries(scan.collections);
        if (colls.length > 0) {
          lineOut("");
          lineOut("Collections:");
          for (const [name, rows] of colls) {
            lineOut(`  ${name.padEnd(34)} ${rows.length} rows`);
          }
        }
        lineOut("");
        nextStep(
          `browsemode exec --browser ${id} 'return await page.find("login")'`,
          opts,
        );
      },
    });
  } finally {
    await browser.detach();
  }
}
