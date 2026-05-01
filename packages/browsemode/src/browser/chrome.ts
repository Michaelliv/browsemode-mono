// Find and (re)launch a local Chrome / Chromium for browsemode's auto-
// fallback when the primary browser wedges on a page. Electrobun-style:
// never ship Chrome, just locate what's already installed and lazily
// spawn a headless instance.
//
// Lifecycle: spawn-and-reuse. We write the spawned Chrome's pid + port
// to <cacheDir>/chrome.{pid,port}. Subsequent invocations check if that
// process is still alive and reuse it.
//
// Configurable via env / Browsemode.configure({ chrome: {...} }):
//   path           — explicit Chrome binary
//   port           — debug port
//   extraArgs      — flags appended (Docker: --no-sandbox)
//   profileDir     — managed user-data dir
//   spawnTimeoutMs — port-up grace period

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.js";

export interface ChromeStatus {
  running: boolean;
  pid?: number;
  port?: number;
  /** Path to the Chrome-compatible binary we're managing (or would manage). */
  exec?: string;
}

export interface EnsureChromeOpts {
  /** Override config.chrome.port for this call. */
  port?: number;
  /** Append to config.chrome.extraArgs for this call. */
  extraArgs?: string[];
}

function cacheDir(): string {
  return getConfig().cacheDir;
}
function pidFile(): string {
  return join(cacheDir(), "chrome.pid");
}
function portFile(): string {
  return join(cacheDir(), "chrome.port");
}
function profileDir(): string {
  return getConfig().chrome.profileDir ?? join(cacheDir(), "chrome-profile");
}

const CANDIDATES_BY_OS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
    "/headless-shell/headless-shell", // chromedp/headless-shell Docker image
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export function findChrome(): string | null {
  // Explicit path wins. Useful in containers where the binary isn't at
  // a standard location.
  const explicit = getConfig().chrome.path;
  if (explicit && existsSync(explicit)) return explicit;
  if (explicit) return null; // user said "use this", we honor and fail explicitly

  const candidates = CANDIDATES_BY_OS[process.platform] ?? [];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill — just probes whether the process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(getConfig().defaults.probeTimeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function chromeStatus(): Promise<ChromeStatus> {
  const pf = pidFile();
  const pf2 = portFile();
  if (!existsSync(pf) || !existsSync(pf2)) return { running: false };
  const pid = Number.parseInt(readFileSync(pf, "utf-8").trim(), 10);
  const port = Number.parseInt(readFileSync(pf2, "utf-8").trim(), 10);
  if (!pid || !port) return { running: false };
  if (!isPidAlive(pid)) return { running: false, pid, port };
  const responsive = await isPortListening(port);
  if (!responsive) return { running: false, pid, port };
  return { running: true, pid, port };
}

export async function ensureChrome(
  opts: EnsureChromeOpts = {},
): Promise<number> {
  const cfg = getConfig().chrome;
  const status = await chromeStatus();
  if (status.running && status.port) return status.port;

  const exec = findChrome();
  if (!exec) {
    throw new Error(
      "No Chrome / Chromium / Brave / Edge / Arc found. Set BROWSEMODE_CHROME_PATH " +
        "or call Browsemode.configure({ chrome: { path: '/usr/bin/chromium' } }).",
    );
  }

  // Stale pid/port files from a prior run — clean up.
  const pf = pidFile();
  const pf2 = portFile();
  if (existsSync(pf)) unlinkSync(pf);
  if (existsSync(pf2)) unlinkSync(pf2);

  const port = opts.port ?? cfg.port;
  const dir = cacheDir();
  const profile = profileDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(profile)) mkdirSync(profile, { recursive: true });

  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=PaintHolding",
    ...cfg.extraArgs,
    ...(opts.extraArgs ?? []),
  ];

  const child = spawn(exec, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) {
    throw new Error(`Failed to spawn Chrome at ${exec}`);
  }
  writeFileSync(pf, String(child.pid));
  writeFileSync(pf2, String(port));

  const deadline = Date.now() + cfg.spawnTimeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return port;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Chrome spawned (pid ${child.pid}) but port ${port} never opened within ${cfg.spawnTimeoutMs}ms`,
  );
}

export async function stopChrome(): Promise<{
  stopped: boolean;
  pid?: number;
}> {
  const status = await chromeStatus();
  if (!status.pid) return { stopped: false };
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // already dead
  }
  const pf = pidFile();
  const pf2 = portFile();
  if (existsSync(pf)) unlinkSync(pf);
  if (existsSync(pf2)) unlinkSync(pf2);
  return { stopped: true, pid: status.pid };
}
