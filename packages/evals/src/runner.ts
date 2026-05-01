// The Runner interface.
//
// A Runner is "how the agent actually attempts the task". Two are
// shipped:
//
//   - direct-sdk: TypeScript driver that calls browsemode's SDK
//     directly, no LLM. Used to verify the eval framework itself
//     works end-to-end against deterministic page flows.
//   - pi: spawns pi (@mariozechner/pi-coding-agent) in RPC mode
//     loaded with only the pi-browsemode extension. The model
//     drives the browser via execute_browsemode tool calls. This
//     is the runner used for real eval runs.

import type { Browser } from "browsemode";
import type { Backend, EvalTask, RunArtifact } from "./types.js";

export interface RunnerContext {
  /**
   * Pre-opened browser pointing at task.url (or about:blank). Only
   * provided when the runner declares ownsBrowser=false. The pi
   * runner manages its own browser via the spawned subprocess, so
   * the orchestrator skips the open for it.
   */
  browser: Browser | null;
  /** Which backend this run is targeting. Runners may want to log it. */
  backend: Backend;
  /** Task being attempted. */
  task: EvalTask;
  /** AbortSignal that fires when the per-task timeout elapses. */
  signal: AbortSignal;
}

export interface Runner {
  /** Stable id ("direct-sdk", "pi", ...). */
  readonly id: string;
  /**
   * If true, the runner spawns/owns its own browser and the
   * orchestrator should NOT pre-open one. Default false.
   */
  readonly ownsBrowser?: boolean;
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
