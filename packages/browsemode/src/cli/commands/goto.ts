// `browsemode goto [--browser <id>] <url>`
// Navigate the active page on a browser.

import { ensureBrowser } from "../browser-handle.js";
import { EXIT_USER_ERROR } from "../exit-codes.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts, resolveBrowserId } from "../flags.js";
import {
  hint,
  info,
  lineOut,
  nextStep,
  output,
  renderError,
  success,
} from "../output.js";

export async function gotoCmd(
  url: string | undefined,
  flags: GlobalFlags,
): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);

  if (!url) {
    renderError(
      {
        message: "missing URL",
        next: ["browsemode goto https://example.com"],
      },
      opts,
    );
    process.exit(EXIT_USER_ERROR);
  }

  const id = resolveBrowserId(flags);
  if (!opts.json && !opts.quiet) info(`browser '${id}'`, opts);

  const { browser, opened, fellBack } = await ensureBrowser({
    ...flags,
    url,
  });
  if (!opts.json && !opts.quiet) {
    if (opened) hint(`opened on ${browser.product || "primary"}`, opts);
    if (fellBack) hint("primary wedged — fell back to managed Chrome", opts);
  }

  try {
    if (!opened) await browser.goto(url);
    const scan = await browser.scan();
    browser.snapshot();

    output(opts, {
      json: () => ({
        url: scan.url,
        title: scan.title,
        elements: scan.elements.length,
      }),
      quiet: () => lineOut(scan.url),
      human: () => {
        success(`navigated to ${scan.url}`, opts);
        if (scan.title) lineOut(`  ${scan.title}`);
        lineOut(`  ${scan.elements.length} interactable element(s)`);
        lineOut("");
        nextStep(`browsemode scan --browser ${id}`, opts);
        nextStep(
          `browsemode exec --browser ${id} 'return await page.list()'`,
          opts,
        );
      },
    });
  } finally {
    await browser.detach();
  }
}
