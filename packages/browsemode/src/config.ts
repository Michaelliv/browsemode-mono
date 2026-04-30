// Global configuration. Every knob the SDK exposes lives here. Read
// from environment variables on first access; programmatic
// `configure({...})` deep-merges over those. Per-call opts (verbs,
// constructors) override config when they're present.
//
// Precedence (highest → lowest):
//   1. Per-call opts
//   2. configure({...})
//   3. process.env
//   4. Hardcoded defaults

import type { BusEvent } from "./bus.js";

export interface BrowsemodeConfig {
  /** Where snapshots, chrome state, cookie cache live. Default ~/.cache/browsemode. */
  cacheDir: string;

  /** Default browser id when caller doesn't pass one. Default "default". */
  defaultBrowserId: string;

  chrome: {
    /** Explicit Chrome binary path. Skips the candidate scan. */
    path?: string;
    /** Port the managed Chrome listens on. */
    port: number;
    /**
     * Extra flags appended to the spawn command. Useful for Docker:
     *   ["--no-sandbox", "--disable-dev-shm-usage"]
     * Mapped via BROWSEMODE_CHROME_ARGS as a comma-separated list.
     */
    extraArgs: string[];
    /** Override the managed-Chrome user-data dir. Default <cacheDir>/chrome-profile. */
    profileDir?: string;
    /** How long ensureChrome waits for the debug port to come up. */
    spawnTimeoutMs: number;
  };

  defaults: {
    /** ms to wait after navigating verbs before rescanning. */
    settleMs: number;
    /** Per-call CDP timeout. */
    cdpTimeoutMs: number;
    /** /json/version probe timeout. */
    probeTimeoutMs: number;
    /** Page.navigate hard timeout. */
    navTimeoutMs: number;
    /** waitFor default budget. */
    waitForTimeoutMs: number;
    /** Sandbox script execution timeout. */
    execTimeoutMs: number;
    /** Sandbox memory cap. */
    execMemoryBytes: number;
    /** UA used to override Chrome's HeadlessChrome token. */
    userAgent: string;
    /** Inject DOM shim. "auto" = on for obscura, off for Chrome. */
    shim: "auto" | true | false;
    /** Inject stealth preload. Cheap; helps everywhere. */
    stealth: boolean;
  };

  cookies: {
    /** Override the macOS Chrome user-data dir. */
    userDataDir?: string;
    /** Cookie-cache TTL. 0 disables. */
    cacheTtlMs: number;
  };

  /**
   * If set, every Bus event from any browser instance fires here. CLI
   * uses this for stderr formatting; library callers leave it null.
   */
  onEvent?: (event: BusEvent) => void;
}

function home(): string {
  return process.env.HOME ?? "/tmp";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

function envCsv(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function debugSubscriber(): ((e: BusEvent) => void) | undefined {
  if (envBool("BROWSEMODE_DEBUG")) {
    return (e) => {
      process.stderr.write(`[browsemode] ${JSON.stringify(e)}\n`);
    };
  }
  return undefined;
}

function fromEnv(): BrowsemodeConfig {
  const noShim = envBool("BROWSEMODE_NO_SHIM");
  const noStealth = envBool("BROWSEMODE_NO_STEALTH");
  return {
    cacheDir: process.env.BROWSEMODE_CACHE_DIR ?? `${home()}/.cache/browsemode`,
    defaultBrowserId: process.env.BROWSEMODE_DEFAULT_BROWSER_ID ?? "default",
    chrome: {
      path: process.env.BROWSEMODE_CHROME_PATH,
      port: envInt("BROWSEMODE_CHROME_PORT", 9335),
      extraArgs: envCsv("BROWSEMODE_CHROME_ARGS"),
      profileDir: process.env.BROWSEMODE_CHROME_PROFILE_DIR,
      spawnTimeoutMs: envInt("BROWSEMODE_CHROME_SPAWN_TIMEOUT_MS", 10_000),
    },
    defaults: {
      settleMs: envInt("BROWSEMODE_SETTLE_MS", 250),
      cdpTimeoutMs: envInt("BROWSEMODE_CDP_TIMEOUT_MS", 30_000),
      probeTimeoutMs: envInt("BROWSEMODE_PROBE_TIMEOUT_MS", 5_000),
      navTimeoutMs: envInt("BROWSEMODE_NAV_TIMEOUT_MS", 30_000),
      waitForTimeoutMs: envInt("BROWSEMODE_WAIT_FOR_TIMEOUT_MS", 15_000),
      execTimeoutMs: envInt("BROWSEMODE_EXEC_TIMEOUT_MS", 60_000),
      execMemoryBytes: envInt(
        "BROWSEMODE_EXEC_MEMORY_BYTES",
        64 * 1024 * 1024
      ),
      userAgent:
        process.env.BROWSEMODE_USER_AGENT ??
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      shim: noShim === true ? false : "auto",
      stealth: noStealth === true ? false : true,
    },
    cookies: {
      userDataDir: process.env.BROWSEMODE_CHROME_USER_DATA_DIR,
      cacheTtlMs: envInt("BROWSEMODE_COOKIE_CACHE_TTL_MS", 10 * 60 * 1000),
    },
    onEvent: debugSubscriber(),
  };
}

let _config: BrowsemodeConfig | null = null;

function ensure(): BrowsemodeConfig {
  if (!_config) _config = fromEnv();
  return _config;
}

/** Get the live config object. Treat as read-only; mutate via configure(). */
export function getConfig(): BrowsemodeConfig {
  return ensure();
}

/**
 * Deep-partial: every nested field is independently optional so a
 * configure() call can touch one knob without forcing the caller to
 * fill in everything else under the same sub-object.
 */
export type PartialConfig = {
  [K in keyof BrowsemodeConfig]?: BrowsemodeConfig[K] extends object
    ? BrowsemodeConfig[K] extends ((...a: any[]) => any)
      ? BrowsemodeConfig[K]
      : { [P in keyof BrowsemodeConfig[K]]?: BrowsemodeConfig[K][P] }
    : BrowsemodeConfig[K];
};

/**
 * Deep-merge a partial config into the global. Persists for the
 * remainder of the process lifetime. Sub-objects (chrome, defaults,
 * cookies) merge field-by-field so callers can override one knob
 * without resetting the rest.
 */
export function configure(partial: PartialConfig): void {
  const cur = ensure();
  if (partial.cacheDir !== undefined) cur.cacheDir = partial.cacheDir;
  if (partial.defaultBrowserId !== undefined) {
    cur.defaultBrowserId = partial.defaultBrowserId;
  }
  if (partial.chrome) Object.assign(cur.chrome, partial.chrome);
  if (partial.defaults) Object.assign(cur.defaults, partial.defaults);
  if (partial.cookies) Object.assign(cur.cookies, partial.cookies);
  if ("onEvent" in partial) cur.onEvent = partial.onEvent;
}

/** Discard the cached config so the next read re-pulls from env. Tests use this. */
export function resetConfig(): void {
  _config = null;
}

/** Generate a random short browser id. */
export function randomBrowserId(): string {
  // crypto.randomUUID is in Node + Bun; first chunk is 8 hex chars.
  // Plenty of entropy for "give me a fresh id" use; not cryptographic.
  const u = (globalThis.crypto as Crypto).randomUUID();
  return u.split("-")[0];
}
