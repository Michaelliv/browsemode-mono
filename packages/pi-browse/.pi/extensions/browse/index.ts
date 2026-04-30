// pi-browse — pi extension that drives a real browser via browsemode.
//
// Tools registered here are stubs until step 5 (port) is done. Each tool
// gets its full implementation once browsemode itself is green.
//
// State model: ONE Browser per pi session, persisted across tool calls
// via the same on-disk session snapshot that powers `--reuse` in the CLI.
// Pi calls `browse_open` first; subsequent calls reattach to the same
// browser. The extension exits → the snapshot stays; pi can resume later.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
// import { Browsemode } from "browsemode"; // wired up during port

export default function (pi: ExtensionAPI) {
  // ── browse_open ──────────────────────────────────
  pi.registerTool({
    name: "browse_open",
    label: "Open a page",
    description:
      "Open a URL in a fresh tab and return a scan summary (URL, title, top elements, collections). Subsequent tools operate on this tab.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to open." }),
      waitUntil: Type.Optional(
        Type.Union(
          [
            Type.Literal("domcontentloaded"),
            Type.Literal("load"),
            Type.Literal("networkidle0"),
            Type.Literal("networkidle2"),
          ],
          {
            description:
              "Lifecycle event to wait for. Default domcontentloaded.",
          },
        ),
      ),
    }),
    async execute(_id, _params, _signal) {
      throw new Error("not implemented");
    },
  });

  // ── browse_scan ──────────────────────────────────
  pi.registerTool({
    name: "browse_scan",
    label: "Re-scan",
    description:
      "Re-scan the active page and return the updated element catalog. Useful after navigation, dynamic content load, or when the agent thinks the page changed.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("not implemented");
    },
  });

  // ── browse_dispatch ──────────────────────────────
  pi.registerTool({
    name: "browse_dispatch",
    label: "Dispatch a verb",
    description:
      "Run a single verb. `path` is either `verb` (page-level: goto, wait, waitFor, scroll, ...) or `name.verb` (element verb: signInButton.click, emailInput.fill).",
    parameters: Type.Object({
      path: Type.String({
        description:
          "Verb path: 'goto' or 'signInButton.click' or 'emailInput.fill'.",
      }),
      args: Type.Optional(Type.Any({ description: "Arguments for the verb." })),
    }),
    async execute() {
      throw new Error("not implemented");
    },
  });

  // ── browse_exec ──────────────────────────────────
  pi.registerTool({
    name: "browse_exec",
    label: "Run code",
    description:
      "Run JavaScript in a QuickJS sandbox against the live page. Code may use top-level await and must `return` its final value. The `page` global routes every call back through dispatch.",
    parameters: Type.Object({
      code: Type.String({
        description:
          "JS body. Use top-level await; end with `return <value>;`.",
      }),
    }),
    async execute() {
      throw new Error("not implemented");
    },
  });

  // ── browse_read ──────────────────────────────────
  pi.registerTool({
    name: "browse_read",
    label: "Read URL as markdown",
    description:
      "Convert a URL to markdown via markit (no browser). Uses /llms.txt, VitePress .md sources, RSS, Wikipedia handlers, etc when available.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch and convert." }),
    }),
    async execute() {
      throw new Error("not implemented");
    },
  });

  // ── browse_close ─────────────────────────────────
  pi.registerTool({
    name: "browse_close",
    label: "Close session",
    description:
      "Close the active browser tab and clear the persisted session. Run when the task is done.",
    parameters: Type.Object({}),
    async execute() {
      throw new Error("not implemented");
    },
  });
}
