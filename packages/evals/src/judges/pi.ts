// PiJudge — LLM-driven judge. Spawns pi with the local judge
// extension loaded, sends a scoring prompt, captures the model's
// `judge` tool call args. Same spawn pattern as the pi runner.
//
// We do not ask the model to emit JSON in text. Instead the judge
// extension exposes one tool with a strict TypeBox schema, the
// model calls it exactly once, and we read the args off the
// tool_execution_start event. That eliminates an entire class of
// "model returned almost-but-not-quite valid JSON" failure modes.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Judge } from "../judge.js";
import { PiRpcClient } from "../runners/lib/pi-rpc-client.js";
import {
  autoCancelExtensionUi,
  buildPiArgs,
  waitForEvent,
} from "../runners/lib/pi-spawn.js";
import type { EvalTask, RunArtifact, Score } from "../types.js";

function defaultJudgeExtPath(): string {
  // packages/evals/src/judges/pi.ts
  //  -> packages/evals/extensions/judge
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "..", "extensions", "judge");
}

const SYSTEM_PROMPT_SUFFIX = [
  "You're an evaluator scoring a real browser task that another agent",
  "attempted. You'll be given the task, the must/must_not criteria,",
  "and what the agent produced. Call the `judge` tool exactly once",
  "with your verdict. Do not write a long natural-language reply",
  "outside the tool call: the tool call IS the answer.",
].join(" ");

// 180s budget for the whole judge subprocess. Anthropic's API
// can take 30s+ on long contexts when rate-limited or retrying;
// 60s used to be enough but bit us as soon as agent outputs got
// longer (multi-paragraph WebVoyager answers). Override with
// PI_JUDGE_TIMEOUT_MS.
const JUDGE_TIMEOUT_MS = Number.parseInt(
  process.env.PI_JUDGE_TIMEOUT_MS ?? "180000",
  10,
);

/**
 * Factory used by PiJudge to construct its RPC transport. Default
 * spawns pi via buildPiArgs(); tests inject a stub that points at
 * a fake binary so PiJudge can be exercised end-to-end without a
 * real pi install.
 */
export type PiClientFactory = () => PiRpcClient;

function defaultClientFactory(): PiRpcClient {
  const extPath = process.env.PI_JUDGE_EXT_PATH ?? defaultJudgeExtPath();
  const args = buildPiArgs({
    extensionPath: extPath,
    systemPromptSuffix: SYSTEM_PROMPT_SUFFIX,
    // Judges don't need to think hard; force off if the env doesn't
    // already set one. Models with reasoning enabled by default get
    // expensive on bulk scoring runs.
    thinking: process.env.PI_JUDGE_THINKING ?? "off",
  });
  return new PiRpcClient({
    bin: process.env.PI_BIN ?? "pi",
    args,
  });
}

export class PiJudge implements Judge {
  readonly id = "pi";

  /**
   * @param createClient  override transport construction (tests).
   *                      Default spawns pi via buildPiArgs().
   */
  constructor(
    private readonly createClient: PiClientFactory = defaultClientFactory,
  ) {}

  async score(task: EvalTask, artifact: RunArtifact): Promise<Score> {
    const client = this.createClient();

    autoCancelExtensionUi(client);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), JUDGE_TIMEOUT_MS);

    let captured: ScoreToolArgs | null = null;
    client.on((e) => {
      if (
        e.type === "tool_execution_start" &&
        e.toolName === "judge" &&
        !captured
      ) {
        captured = e.args as ScoreToolArgs;
      }
    });

    try {
      const agentEnd = waitForEvent(client, "agent_end", ac.signal);
      await client.send("prompt", {
        message: buildJudgePrompt(task, artifact),
      });
      await agentEnd;
    } catch (err: any) {
      if (ac.signal.aborted) {
        throw new Error(
          `judge timed out after ${JUDGE_TIMEOUT_MS}ms with no judge() tool call`,
        );
      }
      const stderr = client.stderrText();
      throw new Error(
        `pi judge failed: ${err?.message ?? err}${stderr ? `\nstderr:\n${stderr.slice(-1000)}` : ""}`,
      );
    } finally {
      clearTimeout(timer);
      await client.close();
    }

    if (!captured) {
      throw new Error(
        "judge agent finished without calling the `judge` tool. " +
          "Re-run with --json to inspect the event stream, or set " +
          "BROWSEMODE_EVALS_PI_LOG to dump traces.",
      );
    }

    return scoreFromToolArgs(captured);
  }
}

interface ScoreToolArgs {
  score: number;
  rationale: string;
  met_must: string[];
  failed_must: string[];
  hit_must_not: string[];
}

function scoreFromToolArgs(a: ScoreToolArgs): Score {
  return {
    score: clamp01(Number(a.score)),
    rationale: a.rationale,
    metMust: Array.isArray(a.met_must) ? a.met_must : [],
    failedMust: Array.isArray(a.failed_must) ? a.failed_must : [],
    hitMustNot: Array.isArray(a.hit_must_not) ? a.hit_must_not : [],
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function buildJudgePrompt(task: EvalTask, artifact: RunArtifact): string {
  const mustList = task.judge.must ?? [];
  const mustNotList = task.judge.must_not ?? [];
  const hasExplicitCriteria = mustList.length > 0 || mustNotList.length > 0;

  if (!hasExplicitCriteria) {
    // Open-ended task (typical for WebVoyager / Mind2Web). Grade
    // against whether the agent accomplished what the task
    // describes. Binary scoring: original benchmarks pass/fail per
    // task, so we mirror that. Partial credit is OK only when the
    // agent did most of the work but missed something specific.
    return [
      "## Task",
      task.task,
      task.url ? `\nStarting URL: ${task.url}` : "",
      "",
      "## Agent output",
      "```",
      artifact.output || "(empty)",
      "```",
      "",
      "## How to score",
      "",
      "This is an open-ended task with no explicit must/must_not criteria. Decide whether the agent's output accomplishes the task as a real human would have asked for it.",
      "",
      "- score = 1.0 if the output is a complete, correct answer to the task.",
      "- score = 0.0 if the agent failed (empty output, wrong page, hallucinated, refused).",
      "- score in (0, 1) only when the agent partially accomplished the task (e.g. found the right page but reported an incomplete or off-by-one answer).",
      "",
      "Bias toward binary 1.0 / 0.0 unless there's a clear partial-success story.",
      "",
      "`met_must`, `failed_must`, `hit_must_not` MUST be empty arrays \u2014 there are no explicit criteria for this task. Put your reasoning in `rationale`.",
      "",
      "Call the `judge` tool now with your verdict.",
    ].join("\n");
  }

  const must = mustList.map((s) => `- ${s}`).join("\n") || "(none)";
  const mustNot = mustNotList.map((s) => `- ${s}`).join("\n") || "(none)";
  return [
    "## Task",
    task.task,
    task.url ? `\nStarting URL: ${task.url}` : "",
    "",
    "## Criteria",
    "**must (each one is a positive criterion the output should satisfy):**",
    must,
    "",
    "**must_not (criteria the output must not satisfy):**",
    mustNot,
    "",
    "## Agent output",
    "```",
    artifact.output || "(empty)",
    "```",
    "",
    "## How to score",
    "",
    "- score = N_met_must / (must.length + must_not.length) where N_met_must counts must items met PLUS must_not items NOT hit.",
    "- The verbatim strings you put in `met_must`, `failed_must`, `hit_must_not` MUST come from the criteria lists above.",
    "",
    "Call the `judge` tool now with your verdict.",
  ].join("\n");
}
