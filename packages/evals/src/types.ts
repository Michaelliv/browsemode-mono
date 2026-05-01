// Eval task + result types.
//
// One YAML file per task in `tasks/<name>.yaml`. The runner loads it,
// hands it to a Runner implementation, captures whatever the agent
// produces, then asks a Judge to score it against `judge.must` /
// `judge.must_not` criteria. Results aggregate into a Report that
// breaks down per-backend (obscura vs chrome-fallback).

export type Backend = "obscura" | "chrome";

/**
 * Stable on-disk shape. Keep loose for now; we'll tighten when the
 * format settles. Matches browser-use's YAML shape closely so eval
 * authors who know that ecosystem don't have to relearn.
 */
export interface EvalTask {
  /** Stable id, derived from filename if not present. */
  name: string;
  /** Plain-English instruction for the agent. */
  task: string;
  /** Optional starting URL. The runner navigates here before agent invocation. */
  url?: string;
  /** Hard step / time budget so a runaway agent doesn't bill forever. */
  budget?: {
    /** Max agent steps (loop iterations). Default 8. */
    maxSteps?: number;
    /** Wall-clock cap in seconds. Default 120. */
    timeoutSec?: number;
  };
  /**
   * Backend gating. If set, the task is only scored against the listed
   * backends. Useful for tagging "this needs Chrome" or "this should
   * pass on obscura by N.M".
   */
  only?: Backend[];
  /** What the judge expects. Free-form text criteria, evaluated by an LLM. */
  judge: {
    must: string[];
    /** Optional negative criteria. */
    must_not?: string[];
  };
  /** Tags for filtering: read-only, form, search, multi-tab, etc. */
  tags?: string[];
}

/** Whatever the agent produced for one task on one backend. */
export interface RunArtifact {
  /** Final agent answer, free text. */
  output: string;
  /** Per-step trace if the runner can produce one. */
  steps?: Array<{
    kind: string;
    detail?: string;
  }>;
  /** True if the runner aborted early (timeout, max steps, error). */
  truncated?: boolean;
  /** Wall-clock time. */
  elapsedMs: number;
  /** Whatever metadata the runner wants to carry forward (token counts, model name, etc). */
  meta?: Record<string, unknown>;
}

export interface RunResult {
  task: EvalTask;
  backend: Backend;
  artifact: RunArtifact | null;
  /** True if the runner crashed before producing an artifact. */
  errored?: boolean;
  errorMessage?: string;
}

export interface Score {
  /** 0 = total fail, 1 = total pass. Judges may give partial. */
  score: number;
  /** Per-criterion verdict. */
  rationale: string;
  /** Which `must` criteria the judge thinks were met. */
  metMust: string[];
  failedMust: string[];
  hitMustNot: string[];
}

export interface ScoredRun extends RunResult {
  score: Score | null;
  /** True if this counts as a clean pass per our threshold (default 1.0). */
  passed: boolean;
}

export interface Report {
  total: number;
  perBackend: Record<
    Backend,
    { runs: number; passed: number; errored: number }
  >;
  runs: ScoredRun[];
}
