// Shared flag parsing. Commander hands every action a flat opts object
// merging globals + locals (via cmd.optsWithGlobals()). This module
// turns that bag into the structured options each command actually
// needs.

import { configure, getConfig } from "../config.js";
import type { OutputOptions } from "./output.js";

/** The flags every command supports. */
export interface GlobalFlags extends OutputOptions {
  /** Browser id to operate on. Defaults to config.defaultBrowserId. */
  browser?: string;
  /** CDP host (only used when opening a fresh browser). */
  host?: string;
  /** CDP port (only used when opening a fresh browser). */
  port?: number;
  /** Override config.cacheDir for this invocation. */
  cacheDir?: string;
  /** Wedge-handling strategy. */
  fallback?: "auto" | "chrome" | "off";
  /** No-color flag from --no-color (Commander negates --color). */
  color?: boolean;
}

/**
 * Merge flag-derived overrides into the global Browsemode config so the
 * SDK reads them transparently. Per-call overrides also still flow
 * through directly (e.g. browser opts) where they're per-call only.
 */
export function applyGlobalFlags(flags: GlobalFlags): void {
  if (flags.cacheDir) configure({ cacheDir: flags.cacheDir });
}

/** Resolve which browser id this command targets. */
export function resolveBrowserId(flags: GlobalFlags): string {
  return flags.browser ?? getConfig().defaultBrowserId;
}

/** Strip non-output keys for output helpers. */
export function outputOpts(flags: GlobalFlags): OutputOptions {
  return { json: flags.json, quiet: flags.quiet, color: flags.color };
}

/**
 * Parse Commander option values for known flags. Commander gives us
 * mostly-correct types but `port` comes in as a string.
 */
export function parseGlobalFlags(raw: Record<string, any>): GlobalFlags {
  const port = raw.port ? Number.parseInt(String(raw.port), 10) : undefined;
  return {
    browser: raw.browser,
    host: raw.host,
    port: Number.isFinite(port) ? port : undefined,
    cacheDir: raw.cacheDir,
    fallback: raw.fallback,
    json: !!raw.json,
    quiet: !!raw.quiet,
    // Commander's `--no-color` sets opts.color = false.
    color: raw.color,
  };
}
