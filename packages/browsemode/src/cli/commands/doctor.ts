// `browsemode doctor` — pre-flight checks. Tells you what works and
// what's missing before you have to debug from a CLI error.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromeStatus, findChrome } from "../../browser/chrome.js";
import { getConfig } from "../../config.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts } from "../flags.js";
import { fail, hint, lineOut, output, success, warn } from "../output.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export async function doctor(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const cfg = getConfig();
  const checks: Check[] = [];

  // Cache dir writable?
  try {
    if (!existsSync(cfg.cacheDir)) mkdirSync(cfg.cacheDir, { recursive: true });
    const probe = join(cfg.cacheDir, ".doctor-probe");
    Bun.write(probe, "1");
    checks.push({ name: "cache dir", ok: true, detail: cfg.cacheDir });
  } catch (e: any) {
    checks.push({
      name: "cache dir",
      ok: false,
      detail: cfg.cacheDir,
      hint: `not writable (${e?.message ?? e}). Set BROWSEMODE_CACHE_DIR.`,
    });
  }

  // Chrome binary discoverable?
  const chromePath = findChrome();
  if (chromePath) {
    checks.push({ name: "chrome binary", ok: true, detail: chromePath });
  } else {
    checks.push({
      name: "chrome binary",
      ok: false,
      hint: "no Chrome / Chromium / Brave / Edge / Arc found. Set BROWSEMODE_CHROME_PATH.",
    });
  }

  // Managed Chrome currently running?
  const status = await chromeStatus();
  checks.push({
    name: "managed Chrome",
    ok: status.running,
    detail: status.running
      ? `pid ${status.pid} on :${status.port}`
      : "not running",
    hint: status.running
      ? undefined
      : "run `browsemode browser launch` to spawn one",
  });

  // QuickJS loadable?
  let quickjs = false;
  let quickjsErr = "";
  try {
    await import("quickjs-emscripten");
    quickjs = true;
  } catch (e: any) {
    quickjsErr = e?.message ?? String(e);
  }
  checks.push({
    name: "quickjs runtime",
    ok: quickjs,
    detail: quickjs ? "loadable" : quickjsErr,
  });

  // Markit loadable?
  let markit = false;
  try {
    await import("markit-ai");
    markit = true;
  } catch {
    /* */
  }
  checks.push({ name: "markit-ai", ok: markit });

  const allOk = checks.every((c) => c.ok);

  output(opts, {
    json: () => ({ ok: allOk, checks }),
    human: () => {
      for (const c of checks) {
        const line = c.detail ? `${c.name} — ${c.detail}` : c.name;
        if (c.ok) success(line, opts);
        else fail(line, opts);
        if (c.hint) hint(c.hint, opts);
      }
      lineOut("");
      if (allOk) success("ready to drive a browser", opts);
      else warn("some checks failed — see hints above", opts);
    },
  });

  if (!allOk) process.exit(1);
}
