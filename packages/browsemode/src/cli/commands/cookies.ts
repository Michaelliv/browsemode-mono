// `browsemode cookies dump` — read Chrome's SQLite cookie store + decrypt.
// `browsemode cookies inject` — push cookies into a browsemode browser.

import {
  type ChromeCookie,
  readChromeCookies,
  toCdpCookies,
} from "../../browser/cookies.js";
import { Browsemode } from "../../index.js";
import { ensureBrowser } from "../browser-handle.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts, resolveBrowserId } from "../flags.js";
import {
  hint,
  info,
  jsonOut,
  output,
  renderError,
  success,
} from "../output.js";

export interface CookiesDumpOpts extends GlobalFlags {
  domain?: string;
  profile?: string;
}

export async function cookiesDump(flags: CookiesDumpOpts): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);

  let cookies: ChromeCookie[];
  try {
    cookies = readChromeCookies({
      domain: flags.domain,
      profile: flags.profile,
    });
  } catch (e: any) {
    renderError(
      {
        message: e?.message ?? String(e),
        hints: [
          "first time? macOS will prompt to read 'Chrome Safe Storage' from Keychain.",
        ],
      },
      opts
    );
    process.exit(1);
  }

  output(opts, {
    json: () => cookies,
    quiet: () => jsonOut(cookies),
    human: () => {
      jsonOut(cookies);
      info(
        `${cookies.length} cookie(s)${flags.domain ? ` matching ${flags.domain}` : ""}`,
        opts
      );
    },
  });
}

export interface CookiesInjectOpts extends GlobalFlags {
  /** Read JSON from this file instead of stdin. */
  file?: string;
}

export async function cookiesInject(
  flags: CookiesInjectOpts
): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);

  // Read JSON from file or stdin.
  let raw: string;
  if (flags.file) {
    raw = await Bun.file(flags.file).text();
  } else {
    if (process.stdin.isTTY) {
      renderError(
        {
          message: "no cookies to inject",
          hints: ["pipe JSON via stdin or pass --file <path>"],
          next: [
            "browsemode cookies dump --domain x.com | browsemode cookies inject",
            "browsemode cookies inject --file cookies.json",
          ],
        },
        opts
      );
      process.exit(2);
    }
    raw = await readStdin();
  }

  let cookies: ChromeCookie[];
  try {
    cookies = JSON.parse(raw);
  } catch (e: any) {
    renderError({ message: `bad JSON on stdin: ${e?.message}` }, opts);
    process.exit(2);
  }
  if (!Array.isArray(cookies)) {
    renderError({ message: "expected an array of cookies" }, opts);
    process.exit(2);
  }

  const id = resolveBrowserId(flags);
  if (!opts.json && !opts.quiet) info(`browser '${id}'`, opts);
  const { browser, opened, fellBack } = await ensureBrowser({
    ...flags,
    url: "about:blank",
  });
  if (!opts.json && !opts.quiet) {
    if (opened) hint(`opened on ${browser.product || "primary"}`, opts);
    if (fellBack) hint("primary wedged — fell back to managed Chrome", opts);
  }

  try {
    const r = await browser.injectCookies(cookies);
    output(opts, {
      json: () => ({ ...r, browser: id }),
      quiet: () => {},
      human: () => success(`pushed ${r.count} cookie(s) to '${id}'`, opts),
    });
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
