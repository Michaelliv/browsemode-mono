// The Runner interface.
//
// A Runner is "how the agent actually attempts the task". Different
// runners exist so we can compare:
//
//   - direct-sdk: TypeScript driver that calls browsemode's SDK
//     directly, no LLM. Used to verify the eval framework itself
//     works end-to-end against deterministic page flows.
//   - pi-extension: pi (the coding agent) runs the task as a
//     prompt with the browse extension attached, the LLM drives.
//     This is what we'll actually score in real eval runs.
//
// The pi-extension runner is intentionally NOT wired up yet. The
// pi-browsemode extension's tool surface is now settled
// (single-tool, runline-style); the runner that spawns pi in RPC
// mode and plumbs prompts/responses lands in a follow-up commit.

import type { Browser } from "browsemode";
import type { Backend, EvalTask, RunArtifact } from "./types.js";

export interface RunnerContext {
  /** Pre-opened browser pointing at task.url (or about:blank). */
  browser: Browser;
  /** Which backend this run is targeting. Runners may want to log it. */
  backend: Backend;
  /** Task being attempted. */
  task: EvalTask;
  /** AbortSignal that fires when the per-task timeout elapses. */
  signal: AbortSignal;
}

export interface Runner {
  /** Stable id ("direct-sdk", "pi-extension", ...). */
  readonly id: string;
  /** Attempt the task. Should respect ctx.signal. */
  run(ctx: RunnerContext): Promise<RunArtifact>;
}

/**
 * Registry of available runners. Resolve by id at the CLI layer.
 * Empty until concrete runners register; populated by importing
 * src/runners/*.
 */
const runners = new Map<string, Runner>();

export function registerRunner(r: Runner): void {
  if (runners.has(r.id)) {
    throw new Error(`runner '${r.id}' already registered`);
  }
  runners.set(r.id, r);
}

export function getRunner(id: string): Runner {
  const r = runners.get(id);
  if (!r) {
    const known = [...runners.keys()].join(", ") || "(none)";
    throw new Error(`no runner '${id}'. Available: ${known}`);
  }
  return r;
}

export function listRunners(): string[] {
  return [...runners.keys()];
}
