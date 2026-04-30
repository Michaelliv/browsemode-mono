// Output helpers — TTY detection, color, the output() triple.
//
// Three modes per command:
//   - default: human-friendly, chalk-colored, with state-change hints
//   - --json:  deterministic JSON to stdout (stable for scripts)
//   - --quiet: only essential output (e.g. exec returns its result; no banner)
//
// Color disabled when:
//   - NO_COLOR env var set
//   - --no-color flag passed (sets opts.color = false)
//   - stdout/stderr is not a TTY (chalk handles this; we re-check for status output)
//   - TERM=dumb (chalk handles this)

import chalk, { Chalk, type ChalkInstance } from "chalk";

export interface OutputOptions {
  json?: boolean;
  quiet?: boolean;
  /** Set to false to force color off; undefined lets chalk autodetect. */
  color?: boolean;
}

// Pick a ChalkInstance that respects the user's color preference. We
// pass {level} to control: 0 = no color, ≥1 = on.
const plainChalk = new Chalk({ level: 0 });
function pickChalk(opts: OutputOptions): ChalkInstance {
  if (opts.color === false) return plainChalk;
  if (process.env.NO_COLOR) return plainChalk;
  return chalk;
}

// ── status lines (stderr by convention; stdout reserved for primary output) ──
// Print to stderr so a successful run can still pipe its primary output
// (JSON, scan list, exec return) through stdout cleanly.

export function success(msg: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`${c.green("\u2713")} ${msg}\n`);
}
export function info(msg: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`${c.blue("\u2139")} ${msg}\n`);
}
export function warn(msg: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`${c.yellow("\u26A0")} ${msg}\n`);
}
export function fail(msg: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`${c.red("\u2717")} ${msg}\n`);
}
export function hint(msg: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`  ${c.dim(msg)}\n`);
}
export function nextStep(command: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`  ${c.cyan(command)}\n`);
}
export function header(title: string, opts: OutputOptions = {}): void {
  const c = pickChalk(opts);
  process.stderr.write(`\n${c.bold(title)}\n\n`);
}

// ── primary output (stdout) ──

export function jsonOut(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function lineOut(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The output triple. Each command computes its data once, then we
 * format it for the active mode (json / quiet / human).
 *
 *   output(opts, {
 *     json: () => ({ id, url, ... }),
 *     quiet: () => lineOut(id),
 *     human: () => { success(...); hint(...); },
 *   });
 */
export function output(
  opts: OutputOptions,
  handlers: {
    json?: () => unknown;
    quiet?: () => void;
    human: () => void;
  }
): void {
  if (opts.json && handlers.json) {
    jsonOut(handlers.json());
  } else if (opts.quiet && handlers.quiet) {
    handlers.quiet();
  } else {
    handlers.human();
  }
}

// ── error rendering ──
// Used by the top-level error handler. Renders a clean, human-readable
// message to stderr and a list of next-step suggestions.

export interface ErrorRender {
  message: string;
  hints?: string[];
  /** Concrete next-command suggestions, printed cyan. */
  next?: string[];
}

export function renderError(err: ErrorRender, opts: OutputOptions = {}): void {
  fail(err.message, opts);
  for (const h of err.hints ?? []) hint(h, opts);
  for (const n of err.next ?? []) nextStep(n, opts);
}
