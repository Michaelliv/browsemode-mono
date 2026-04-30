// `browsemode read <url>` — fetch URL via markit, no browser involved.
// Useful for content-heavy pages where rendering adds nothing.

import { urlToMarkdown } from "../../page/markdown.js";
import { EXIT_USER_ERROR } from "../exit-codes.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts } from "../flags.js";
import { lineOut, output, renderError } from "../output.js";

export async function readCmd(
  url: string | undefined,
  flags: GlobalFlags
): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);

  if (!url) {
    renderError(
      {
        message: "missing URL",
        next: ["browsemode read https://example.com"],
      },
      opts
    );
    process.exit(EXIT_USER_ERROR);
  }

  const r = await urlToMarkdown(url);

  output(opts, {
    json: () => r,
    quiet: () => lineOut(r.markdown),
    human: () => {
      if (r.title) lineOut(`# ${r.title}\n`);
      lineOut(r.markdown);
    },
  });
}
