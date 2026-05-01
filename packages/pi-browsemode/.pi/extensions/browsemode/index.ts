// pi-browsemode: single-tool browser surface for the agent.
//
// Mirrors the runline pattern. One tool, in-sandbox discovery, no
// per-action schema bloat in the system prompt. The browser persists
// across tool calls so the agent can chain navigations like cells
// in a notebook.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { buildPrimer } from "../../../src/primer.js";
import {
  closeBrowser,
  currentBrowser,
  detachBrowser,
  ensureBrowser,
  getBrowserId,
  setBrowserId,
} from "../../../src/state.js";

export default function (pi: ExtensionAPI) {
  // ── Custom message renderer ─────────────────────────────────────
  // Same trick runline uses: keep the primer collapsed by default so
  // it doesn't dominate the transcript visually.

  pi.registerMessageRenderer(
    "browsemode-context",
    (message, { expanded }, theme) => {
      if (!expanded) {
        const label = theme.fg("customMessageLabel", "🦾 browsemode");
        const hint = theme.fg("dim", " (Ctrl+O to expand)");
        return new Text(label + hint, 1, 0);
      }
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text",
              )
              .map((c) => c.text)
              .join("\n");
      return new Markdown(
        content,
        1,
        0,
        {
          heading: (t) => theme.fg("mdHeading", t),
          link: (t) => theme.fg("mdLink", t),
          linkUrl: (t) => theme.fg("mdLinkUrl", t),
          code: (t) => theme.fg("mdCode", t),
          codeBlock: (t) => theme.fg("mdCodeBlock", t),
          codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
          quote: (t) => theme.fg("mdQuote", t),
          quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
          hr: (t) => theme.fg("mdHr", t),
          listBullet: (t) => theme.fg("mdListBullet", t),
          bold: (t) => theme.bold(t),
          italic: (t) => theme.italic(t),
          strikethrough: (t) => theme.strikethrough(t),
          underline: (t) => theme.underline(t),
        },
        { color: (t) => theme.fg("customMessageText", t) },
      );
    },
  );

  // ── Session lifecycle ───────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Inject the primer once per session (not per /resume reload).
    const alreadyInjected = ctx.sessionManager
      .getEntries()
      .some(
        (e) =>
          e.type === "custom_message" && e.customType === "browsemode-context",
      );

    // Whether we'll reattach depends on whether a snapshot exists.
    // We don't actually open the browser yet. That happens lazily
    // on first execute_browsemode call so a session that never uses
    // it doesn't pay the cost.
    const browserId = getBrowserId();

    if (!alreadyInjected) {
      pi.sendMessage({
        customType: "browsemode-context",
        content: buildPrimer({ browserId, willReattach: false }),
        display: true,
      });
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "browsemode",
        ctx.ui.theme.fg("dim", `🦾 browsemode: ${browserId} (idle)`),
      );
    }
  });

  pi.on("session_shutdown", async () => {
    // Best-effort detach so the snapshot is current. Tabs stay alive
    // so the next pi --resume reattaches to the same state.
    await detachBrowser().catch(() => {
      // shutdown is best-effort
    });
  });

  // ── The single tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "execute_browsemode",
    label: "Browsemode",
    description:
      "Run JavaScript in browsemode's QuickJS sandbox against a real browser. " +
      "The global `page` exposes a typed catalog of named elements: use `page.list()`, " +
      "`page.find(query)`, `page.describe(name)` to discover, then `page.<name>.click()`, " +
      "`page.<name>.fill(value)`, `page.goto(url)`, etc. to drive. Top-level `await`, " +
      "use `return` to surface the result. The browser persists across calls.",
    promptSnippet:
      "Drive a real browser. Use `page.find(...)` / `page.describe(...)` inside the sandbox to discover elements; `return` the result.",
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript body. The `page` global is bound to the active tab. End with `return <value>`.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const browser = await ensureBrowser();

      // Update the status line with the current URL so the human
      // operator can see what the agent is doing.
      const urlBefore = browser.activePage?.url ?? "";
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "browsemode",
          ctx.ui.theme.fg("dim", `🦾 ${getBrowserId()}: ${urlBefore}`),
        );
      }

      const result = await browser.exec(params.code);

      const urlAfter = browser.activePage?.url ?? "";
      if (ctx.hasUI && urlAfter && urlAfter !== urlBefore) {
        ctx.ui.setStatus(
          "browsemode",
          ctx.ui.theme.fg("dim", `🦾 ${getBrowserId()}: ${urlAfter}`),
        );
      }

      const logs = result.logs?.length
        ? `\n\nLogs:\n${result.logs.join("\n")}`
        : "";

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}${logs}` }],
          isError: true,
          details: result,
        };
      }

      const value =
        typeof result.value === "string"
          ? result.value
          : JSON.stringify(result.value, null, 2);

      return {
        content: [{ type: "text", text: value + logs }],
        details: result,
      };
    },
  });

  // ── Convenience commands ────────────────────────────────────────

  pi.registerCommand("browsemode-status", {
    description: "Show the current browser id, URL, and tab count",
    handler: async (_args, ctx) => {
      const id = getBrowserId();
      const browser = currentBrowser();
      if (!browser) {
        ctx.ui.notify(
          `browser '${id}' not yet opened (call execute_browsemode to open)`,
          "info",
        );
        return;
      }
      const tabCount = browser.pages.size;
      const url = browser.activePage?.url ?? "(no active page)";
      const title = browser.activePage?.title ?? "";
      ctx.ui.notify(
        `${id}: ${tabCount} tab(s), active=${title || url}`,
        "info",
      );
    },
  });

  pi.registerCommand("browsemode-id", {
    description: "Switch to a different browsemode browser id",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify(
          `current id: ${getBrowserId()} (pass a new one to switch)`,
          "info",
        );
        return;
      }
      setBrowserId(id);
      ctx.ui.notify(`browsemode id: ${id}`, "info");
    },
  });

  pi.registerCommand("browsemode-close", {
    description:
      "Close the browser, drop its snapshot. The next execute_browsemode call opens a fresh one.",
    handler: async (_args, ctx) => {
      await closeBrowser();
      ctx.ui.notify(`browsemode '${getBrowserId()}' closed`, "info");
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "browsemode",
          ctx.ui.theme.fg("dim", `🦾 browsemode: ${getBrowserId()} (idle)`),
        );
      }
    },
  });
}
