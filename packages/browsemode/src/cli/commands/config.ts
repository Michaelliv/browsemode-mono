// `browsemode config show` / `browsemode config path`.

import { getConfig } from "../../config.js";
import type { GlobalFlags } from "../flags.js";
import { applyGlobalFlags, outputOpts } from "../flags.js";
import { header, lineOut, output } from "../output.js";

export async function configShow(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const cfg = getConfig();

  // Strip the function (onEvent) for JSON; humans see "<set>" or "<none>".
  const safe = {
    cacheDir: cfg.cacheDir,
    defaultBrowserId: cfg.defaultBrowserId,
    chrome: cfg.chrome,
    defaults: cfg.defaults,
    cookies: cfg.cookies,
    onEvent: cfg.onEvent ? "<set>" : null,
  };

  output(opts, {
    json: () => safe,
    quiet: () => lineOut(JSON.stringify(safe)),
    human: () => {
      header("Browsemode configuration", opts);
      lineOut(`cacheDir              ${cfg.cacheDir}`);
      lineOut(`defaultBrowserId      ${cfg.defaultBrowserId}`);
      lineOut("");
      lineOut(`chrome.path           ${cfg.chrome.path ?? "(auto-detect)"}`);
      lineOut(`chrome.port           ${cfg.chrome.port}`);
      lineOut(
        `chrome.extraArgs      ${cfg.chrome.extraArgs.length ? cfg.chrome.extraArgs.join(" ") : "(none)"}`
      );
      lineOut(
        `chrome.profileDir     ${cfg.chrome.profileDir ?? `(${cfg.cacheDir}/chrome-profile)`}`
      );
      lineOut(`chrome.spawnTimeout   ${cfg.chrome.spawnTimeoutMs}ms`);
      lineOut("");
      lineOut(`defaults.settleMs     ${cfg.defaults.settleMs}ms`);
      lineOut(`defaults.cdpTimeout   ${cfg.defaults.cdpTimeoutMs}ms`);
      lineOut(`defaults.probeTimeout ${cfg.defaults.probeTimeoutMs}ms`);
      lineOut(`defaults.navTimeout   ${cfg.defaults.navTimeoutMs}ms`);
      lineOut(`defaults.shim         ${cfg.defaults.shim}`);
      lineOut(`defaults.stealth      ${cfg.defaults.stealth}`);
      lineOut("");
      lineOut(
        `cookies.userDataDir   ${cfg.cookies.userDataDir ?? "(macOS default)"}`
      );
      lineOut(`cookies.cacheTTL      ${cfg.cookies.cacheTtlMs}ms`);
      lineOut("");
      lineOut(`onEvent               ${cfg.onEvent ? "<set>" : "(none)"}`);
    },
  });
}

export async function configPath(flags: GlobalFlags): Promise<void> {
  applyGlobalFlags(flags);
  const opts = outputOpts(flags);
  const path = getConfig().cacheDir;
  output(opts, {
    json: () => ({ cacheDir: path }),
    quiet: () => lineOut(path),
    human: () => lineOut(path),
  });
}
