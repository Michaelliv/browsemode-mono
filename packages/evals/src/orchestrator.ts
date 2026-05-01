// Orchestrator — run one task against one backend.
//
// Responsible for:
//   - opening a Browser pointed at the right backend (obscura via the
//     configured CDP host/port; chrome via Browsemode.launch fallback)
//   - navigating to task.url if present
//   - invoking the runner with a per-task abort signal
//   - cleaning up the browser regardless of outcome
//
// Does NOT score. Scoring happens in the Judge after the run returns.

import type { Browser } from "browsemode";
import { Browsemode } from "browsemode";
import { getRunner } from "./runner.js";
import type { Backend, EvalTask, RunResult } from "./types.js";

export interface OrchestratorOpts {
  /** id of the runner to invoke. */
  runnerId: string;
  /** Backend to drive. */
  backend: Backend;
  /** Where obscura is listening (only when backend === 'obscura'). */
  obscuraHost?: string;
  obscuraPort?: number;
  /** Browser id used in browsemode. Random per-run by default to avoid persistence collisions. */
  browserId?: string;
}

export async function runOne(
  task: EvalTask,
  opts: OrchestratorOpts,
): Promise<RunResult> {
  const { runnerId, backend } = opts;
  const runner = getRunner(runnerId);
  const timeoutMs = (task.budget?.timeoutSec ?? 120) * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let browser: Browser | null = null;
  const start = Date.now();
  try {
    browser = await openBrowser(backend, opts);
    if (task.url) {
      await browser.newPage({ url: task.url });
    } else {
      await browser.newPage();
    }
    const artifact = await runner.run({
      browser,
      backend,
      task,
      signal: ac.signal,
    });
    return { task, backend, artifact };
  } catch (e: any) {
    return {
      task,
      backend,
      artifact: {
        output: "",
        elapsedMs: Date.now() - start,
        truncated: ac.signal.aborted,
      },
      errored: true,
      errorMessage: ac.signal.aborted
        ? `task '${task.name}' timed out after ${timeoutMs}ms`
        : (e?.message ?? String(e)),
    };
  } finally {
    clearTimeout(timer);
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort cleanup; the run already happened
      }
    }
  }
}

async function openBrowser(
  backend: Backend,
  opts: OrchestratorOpts,
): Promise<Browser> {
  const id = opts.browserId ?? `eval-${Math.random().toString(36).slice(2, 8)}`;
  if (backend === "obscura") {
    return Browsemode.connect({
      id,
      host: opts.obscuraHost ?? "localhost",
      port: opts.obscuraPort ?? 9333,
    });
  }
  // chrome: spawn the managed Chrome and connect.
  return Browsemode.launch({ id });
}
