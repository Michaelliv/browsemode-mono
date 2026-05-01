// `browsemode exec [--browser <id>] [--url <url>] '<js>'`
// Run JS against a live page. The JS body runs in a QuickJS sandbox
// where `page` is a proxy that funnels to Page.dispatch.

import { readFileSync } from "node:fs";
import { ensureBrowser } from "../browser-handle.js";
import { EXIT_ERROR, EXIT_USER_ERROR } from "../exit-codes.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts, resolveBrowserId } from "../flags.js";
import {
  hint,
  info,
  jsonOut,
  lineOut,
  output,
  renderError,
} from "../output.js";

export interface ExecOpts extends GlobalFlags {
  url?: string;
  file?: string;
  /** Read code from stdin when the positional code is "-". */
  stdin?: boolean;
}

export async function execCmd(
  code: string | undefined,
  flags: ExecOpts,
): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);

  // Resolve the JS to run: positional → --file → stdin sentinel "-".
  let body = code;
  if (flags.file) body = readFileSync(flags.file, "utf-8");
  if (body === "-" || flags.stdin) body = await readStdin();

  if (!body) {
    renderError(
      {
        message: "no code to run",
        hints: [
          "pass JS as the last argument, or use --file <path>, or pipe via '-'",
        ],
        next: [
          "browsemode exec 'return await page.title();'",
          "browsemode exec --file run.js",
          "echo 'return 1+1' | browsemode exec -",
        ],
      },
      opts,
    );
    process.exit(EXIT_USER_ERROR);
  }

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
    if (flags.url) {
      // explicit --url means navigate even on reattach
      await browser.goto(flags.url);
      await browser.scan();
    }

    const r = await browser.exec(body);
    if (r.error) {
      output(opts, {
        json: () => ({ error: r.error, logs: r.logs }),
        human: () => {
          for (const l of r.logs) lineOut(l);
          renderError({ message: r.error! }, opts);
        },
      });
      browser.snapshot();
      process.exit(EXIT_ERROR);
    }

    output(opts, {
      json: () => ({ result: r.result, logs: r.logs }),
      quiet: () => {
        if (typeof r.result === "string") lineOut(r.result);
        else if (r.result !== undefined) jsonOut(r.result);
      },
      human: () => {
        for (const l of r.logs) lineOut(l);
        if (r.result !== undefined) {
          if (typeof r.result === "string") lineOut(r.result);
          else jsonOut(r.result);
        }
      },
    });

    browser.snapshot();
  } finally {
    await browser.detach();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
