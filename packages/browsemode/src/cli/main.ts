#!/usr/bin/env bun
// browsemode CLI — code mode for the web.
//
// Layout follows the cli-design checklist: subcommands grouped by
// workflow (page / browser / cookies / meta), every command supports
// the output triple (--json / --quiet / human), errors come out
// human-formatted with next-step suggestions.

import { Command } from "commander";
import { configure } from "../config.js";
import {
  browserClose,
  browserForget,
  browserLaunch,
  browserList,
  browserOpen,
  browserStatus,
  browserStop,
} from "./commands/browser.js";
import { configPath, configShow } from "./commands/config.js";
import { cookiesDump, cookiesInject } from "./commands/cookies.js";
import { doctor } from "./commands/doctor.js";
import { execCmd } from "./commands/exec.js";
import { gotoCmd } from "./commands/goto.js";
import { readCmd } from "./commands/read.js";
import { scanCmd } from "./commands/scan.js";
import { EXIT_ERROR } from "./exit-codes.js";
import { parseGlobalFlags } from "./flags.js";
import { fail, hint } from "./output.js";

const VERSION = "0.0.1";

const program = new Command();

program
  .name("browsemode")
  .description(
    "Code mode for the web. Drive a real browser by writing typed JS that addresses elements by name.",
  )
  .version(VERSION, "-v, --version")
  // Globals available on every subcommand via `cmd.optsWithGlobals()`.
  .option("--browser <id>", "browser id to operate on (default: 'default')")
  .option("--host <host>", "CDP host", "localhost")
  .option("--port <port>", "CDP port", "9222")
  .option("--cache-dir <path>", "override cache directory")
  .option("--fallback <mode>", "wedge handling: auto | chrome | off", "auto")
  .option("--json", "emit JSON output")
  .option("-q, --quiet", "suppress non-essential output")
  .option("--no-color", "disable color")
  .addHelpText(
    "after",
    `
Examples:
  $ browsemode read https://example.com
  $ browsemode browser open --id research --url https://github.com
  $ browsemode scan --browser research
  $ browsemode exec --browser research 'return await page.find("login")'
  $ browsemode cookies dump --domain github.com | browsemode cookies inject
  $ browsemode browser list
  $ browsemode doctor

Configuration via env (full list: https://github.com/Michaelliv/browsemode):
  BROWSEMODE_CACHE_DIR              ~/.cache/browsemode
  BROWSEMODE_DEFAULT_BROWSER_ID     default browser id
  BROWSEMODE_CHROME_PATH            explicit Chrome binary
  BROWSEMODE_CHROME_ARGS            extra flags (comma-separated)
  BROWSEMODE_DEBUG=1                verbose bus events to stderr
`,
  );

// ── PAGE commands ──

program
  .command("exec [code]")
  .description("Run JS against a live page (sandbox; --file or '-' for stdin)")
  .option("--url <url>", "navigate to this URL first")
  .option("--file <path>", "read code from file")
  .action(async (code: string | undefined, _local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { url?: string; file?: string };
    await execCmd(code, { ...flags, url: local.url, file: local.file });
  });

program
  .command("scan")
  .description("Print interactable elements on the active page")
  .option("--url <url>", "navigate to this URL first")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { url?: string };
    await scanCmd({ ...flags, url: local.url });
  });

program
  .command("goto <url>")
  .description("Navigate the active page")
  .action(async (url: string, _local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    await gotoCmd(url, flags);
  });

program
  .command("read <url>")
  .description("Convert a URL to markdown (no browser needed)")
  .action(async (url: string, _local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    await readCmd(url, flags);
  });

// ── BROWSER commands ──

const browser = program
  .command("browser")
  .description("Open, list, close, forget browsers");

browser
  .command("list")
  .description("List every saved browser snapshot")
  .action(async (_local, cmd: Command) => {
    await browserList(parseGlobalFlags(cmd.optsWithGlobals()));
  });

browser
  .command("open")
  .description("Open or reattach to a browser")
  .option("--id <id>", "browser id (default: --browser flag)")
  .option("--url <url>", "navigate to this URL on first open")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { id?: string; url?: string };
    await browserOpen({ ...flags, id: local.id, url: local.url });
  });

browser
  .command("close")
  .description("Close a browser and drop its snapshot")
  .option("--id <id>", "browser id")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { id?: string };
    await browserClose({ ...flags, id: local.id });
  });

browser
  .command("forget")
  .description("Drop the snapshot only — live browser keeps running")
  .option("--id <id>", "browser id")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { id?: string };
    await browserForget({ ...flags, id: local.id });
  });

browser
  .command("status")
  .description("Show one or all browser snapshots")
  .action(async (_local, cmd: Command) => {
    await browserStatus(parseGlobalFlags(cmd.optsWithGlobals()));
  });

browser
  .command("launch")
  .description("Spawn the managed Chrome (used for fallback)")
  .action(async (_local, cmd: Command) => {
    await browserLaunch(parseGlobalFlags(cmd.optsWithGlobals()));
  });

browser
  .command("stop")
  .description("Stop the managed Chrome")
  .action(async (_local, cmd: Command) => {
    await browserStop(parseGlobalFlags(cmd.optsWithGlobals()));
  });

// ── COOKIES commands ──

const cookies = program
  .command("cookies")
  .description("Read or inject cookies");

cookies
  .command("dump")
  .description("Read cookies from Chrome's SQLite store + Keychain")
  .option("--domain <domain>", "filter by domain (suffix match)")
  .option("--profile <name>", "Chrome profile (default: Default)")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { domain?: string; profile?: string };
    await cookiesDump({
      ...flags,
      domain: local.domain,
      profile: local.profile,
    });
  });

cookies
  .command("inject")
  .description("Inject cookies (JSON array on stdin or --file) into a browser")
  .option("--file <path>", "read JSON from file instead of stdin")
  .action(async (_local, cmd: Command) => {
    const flags = parseGlobalFlags(cmd.optsWithGlobals());
    const local = cmd.opts() as { file?: string };
    await cookiesInject({ ...flags, file: local.file });
  });

// ── META commands ──

const config = program
  .command("config")
  .description("Show or change configuration");

config
  .command("show")
  .description("Print the resolved configuration")
  .action(async (_local, cmd: Command) => {
    await configShow(parseGlobalFlags(cmd.optsWithGlobals()));
  });

config
  .command("path")
  .description("Print the cache directory")
  .action(async (_local, cmd: Command) => {
    await configPath(parseGlobalFlags(cmd.optsWithGlobals()));
  });

program
  .command("doctor")
  .description("Diagnose your setup")
  .action(async (_local, cmd: Command) => {
    await doctor(parseGlobalFlags(cmd.optsWithGlobals()));
  });

// ── debug subscriber ──
// When BROWSEMODE_DEBUG=1 isn't set but the user is in human mode,
// surface the most useful bus events on stderr without spamming.

if (!process.env.BROWSEMODE_DEBUG) {
  configure({
    onEvent: (e) => {
      switch (e.kind) {
        case "fallback.triggered":
          process.stderr.write(
            `  ↳ fallback: ${e.from} → ${e.to} (${e.reasons.join("; ")})\n`,
          );
          break;
        case "fallback.failed":
          process.stderr.write(
            `  ↳ fallback also missed: ${e.reasons.join("; ")}\n`,
          );
          break;
        case "nav.timeout":
          process.stderr.write(
            `  ↳ navigate timeout (${e.timeoutMs}ms) — proceeding\n`,
          );
          break;
      }
    },
  });
}

// ── top-level ──

if (process.argv.length <= 2) {
  // No-args behavior per cli-design: short summary + an example, not full help.
  process.stdout.write(
    `browsemode — code mode for the web\n\nUsage: browsemode <command> [options]\n\nCommon commands:\n  exec      Run JS against a live page\n  scan      Print available elements\n  read      URL → markdown (no browser)\n  browser   Open / list / close browsers\n  doctor    Diagnose your setup\n\nExample:\n  $ browsemode read https://example.com\n\nFor full help:\n  $ browsemode --help\n`,
  );
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: any) => {
  fail(err?.message ?? String(err));
  if (process.env.BROWSEMODE_DEBUG) hint(err?.stack ?? "");
  process.exit(EXIT_ERROR);
});
