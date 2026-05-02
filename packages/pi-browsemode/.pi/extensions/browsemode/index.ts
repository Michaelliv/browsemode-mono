// pi-browsemode: single-tool browser surface for the agent.
//
// Mirrors the runline pattern. One tool, in-sandbox discovery, no
// per-action schema bloat in the system prompt. The browser persists
// across tool calls so the agent can chain navigations like cells
// in a notebook.

import { type ExtensionAPI, keyHint } from "@mariozechner/pi-coding-agent";
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
    description: [
      "Drive a real browser. Your `code` runs as the body of an async function inside a small sandbox. The sandbox exposes two globals: `page` (the browser handle) and `api` (live introspection of every callable surface).",
      "",
      "Rules:",
      "- Every `page.*` call is async. You MUST `await` every one. Forgetting returns a Promise (or a function reference) which serializes as undefined.",
      "- End with `return <value>` to surface the result. There is no implicit return.",
      "- The browser persists across tool calls. Tabs, scroll position, cookies are kept; treat each call as a notebook cell continuing the same kernel.",
      "- There is no `document`, no `window`, no `eval`. You are not running INSIDE the page; you talk to the page through `page.<verb>` and `page.<elementName>.<verb>` calls only.",
      "",
      "Discover the surface (do this when in doubt instead of guessing):",
      "  await api.list()                       // every callable path right now",
      "  await api.list('page')                 // page-level verbs only",
      "  await api.list('element')              // every <elementName>.<verb> path",
      "  await api.find('submit')               // ranked fuzzy search by path + description",
      "  await api.describe('page.scroll')      // {description, signature, inputs, examples}",
      "  await api.check('page.scroll', { dy: 500 })   // validate args BEFORE calling",
      "",
      "  await page.markdown()                  // human-readable page text; inspect after navigation",
      "  await page.list()                      // element names on the current page",
      "  await page.find('login')               // search elements by name+text; not a substitute for page.list()",
      "  await page.describe('loginButton')     // element details: kind, verbs, text, role",
      "",
      "Recommended first read after navigation:",
      "  await page.goto(url)",
      "  await page.scan()",
      "  return { title: await page.title(), url: await page.url(), elements: (await page.list()).slice(0, 50), markdown: (await page.markdown()).slice(0, 4000) }",
      "",
      "Drive the page:",
      "  await page.goto(url)",
      "  await page.scan()                      // refresh after dynamic content",
      "  await page.<elementName>.click()",
      "  await page.<elementName>.fill(value)",
      "  await page.waitFor({ stable: { forMs: 500 } })",
      "  await page.scan()                      // after fills/clicks that open suggestions, modals, menus, hidden fields",
      "  await page.<formName>.submit()         // the FORM, not the submit button",
      "  await page.waitFor({ stable: { forMs: 1000 } })",
      "  await page.scroll({ direction: 'down' })  // also { dy }, { y }, { to: 'bottom'|'top' }",
      "",
      "Read content:",
      "  await page.title()",
      "  await page.url()",
      "  await page.markdown()                  // clean text view, prefer this for content extraction",
      "  await page.html()                      // raw HTML if you really need it",
      "",
      "Tabs:  await page.tabs.list() / open(url) / switch(id) / close(id)",
      "",
      "Tiny example:",
      "  await page.goto('https://news.ycombinator.com');",
      "  await page.scan();",
      "  return { elements: (await page.list()).slice(0, 20), markdown: (await page.markdown()).slice(0, 2000) };",
      "",
      "Honest reporting (this matters for grading):",
      "- When you produce a final answer, ALWAYS include the URL you got it from and a short verbatim quote from `page.markdown()` or `page.html()` that supports your answer. Treat your reply like a citation: claim, source URL, supporting quote.",
      "- If you cannot find the requested information after honest browsing, say so explicitly. Do NOT substitute a different topic, do NOT fill in plausible-sounding details from prior knowledge. An honest 'I couldn't find it' is the correct answer when the page doesn't have what was asked.",
      "- Never invent URLs, never invent quoted text. If you didn't read it from a `page.*` call in this session, don't put it in your answer.",
    ].join("\n"),
    promptSnippet:
      "Drive a real browser via a tiny sandbox. Use `page.find(query)` / `page.describe(name)` to discover, `await page.<name>.<verb>()` to act, `return <value>` to surface results.",
    renderCall(args, theme, context) {
      const code = typeof args.code === "string" ? args.code.trim() : "";
      const title = theme.fg("toolTitle", theme.bold("execute_browsemode "));
      if (!context.expanded) {
        const preview = code.replace(/\s+/g, " ").slice(0, 120);
        const suffix = code.length > 120 ? "…" : "";
        return new Text(
          title +
            theme.fg("accent", preview || "(empty)") +
            suffix +
            theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`),
          0,
          0,
        );
      }
      return new Text(
        `${title + theme.fg("dim", "code")}\n${theme.fg("accent", code)}`,
        0,
        0,
      );
    },
    parameters: Type.Object({
      code: Type.String({
        description:
          "JavaScript body. The `page` global is bound to the active tab. Every `page.*` call is async; `await` each one. End with `return <value>`.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const browser = await ensureBrowser();

      const result = await browser.exec(params.code);

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

      // ExecuteResult uses `.result` (the IIFE return value); `.value`
      // would be undefined and silently coerce to the string "undefined"
      // here, masking every successful exec as an empty result.
      const returned = result.result;
      const value =
        typeof returned === "string"
          ? returned
          : returned === undefined
            ? "(no return value)"
            : JSON.stringify(returned, null, 2);

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
    },
  });
}
