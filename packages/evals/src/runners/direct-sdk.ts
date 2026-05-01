// Direct-SDK runner.
//
// No LLM in the loop. The task YAML carries an optional `script` field
// (a string of TS/JS) that runs against the browser via Browser.exec.
// Used to verify the eval framework end-to-end on tasks where we know
// what the right answer is and don't want LLM noise.
//
// This is the "smoke test" runner. The real evaluation work happens
// in the pi runner.

import { type Runner, registerRunner } from "../runner.js";
import type { EvalTask, RunArtifact } from "../types.js";

interface DirectSdkTask extends EvalTask {
  /** Optional inline script for the direct-sdk runner. Ignored by other runners. */
  script?: string;
}

export class DirectSdkRunner implements Runner {
  readonly id = "direct-sdk";

  async run({
    browser,
    task,
  }: {
    browser: any;
    task: EvalTask;
    backend: string;
    signal: AbortSignal;
  }): Promise<RunArtifact> {
    const t = task as DirectSdkTask;
    const start = Date.now();
    if (!browser) {
      throw new Error(
        "direct-sdk runner needs the orchestrator to pre-open a browser. " +
          "This runner does not declare ownsBrowser=true.",
      );
    }
    if (!t.script) {
      throw new Error(
        `direct-sdk runner needs a 'script' field on task '${t.name}'. ` +
          "Add one inline in the YAML or run with --runner pi.",
      );
    }

    // browser.exec runs the body in QuickJS with the page proxy. The
    // script's return value is what the judge sees.
    const result = await browser.exec(t.script);
    const elapsedMs = Date.now() - start;
    // ExecuteResult uses `.result` for the IIFE return value (not
    // `.value`); same trap that bit pi-browsemode in d23a9ec.
    const returned = result.result;
    const output =
      typeof returned === "string" ? returned : JSON.stringify(returned);

    return {
      output,
      elapsedMs,
      truncated: false,
      meta: { logs: result.logs?.length ?? 0 },
    };
  }
}

registerRunner(new DirectSdkRunner());
