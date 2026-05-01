// Judge — score an agent's output against the task's `must` /
// `must_not` criteria.
//
// Two implementations:
//
//   - SubstringJudge: deterministic. Every `must` criterion is
//     treated as a case-insensitive substring; every `must_not` the
//     same. No LLM, no API key. Used for smoke tests and CI where
//     the criteria are exact phrases the runner is expected to emit
//     ("returned 30 stories", "title contains Hacker News").
//
//   - LlmJudge: stub. Real grading. Calls a model with a prompt that
//     asks it to compare output against criteria and return JSON.
//     Wired against pi's model registry once the pi-extension runner
//     lands so we share LLM credentials across runner + judge.
//
// The CLI defaults to SubstringJudge. Tasks that need semantic
// grading opt into the llm judge with `judge.kind: llm` once that's
// implemented.

import type { EvalTask, RunArtifact, Score } from "./types.js";

export interface Judge {
  readonly id: string;
  score(task: EvalTask, artifact: RunArtifact): Promise<Score>;
}

export class SubstringJudge implements Judge {
  readonly id = "substring";

  async score(task: EvalTask, artifact: RunArtifact): Promise<Score> {
    const haystack = artifact.output.toLowerCase();
    const must = task.judge.must ?? [];
    const mustNot = task.judge.must_not ?? [];
    const metMust = must.filter((c) => haystack.includes(c.toLowerCase()));
    const failedMust = must.filter((c) => !haystack.includes(c.toLowerCase()));
    const hitMustNot = mustNot.filter((c) =>
      haystack.includes(c.toLowerCase()),
    );

    const total = must.length + mustNot.length;
    const passed = metMust.length + (mustNot.length - hitMustNot.length);
    const score = total === 0 ? 1 : passed / total;

    const lines: string[] = [];
    if (metMust.length) lines.push(`✓ met: ${metMust.join("; ")}`);
    if (failedMust.length) lines.push(`✗ missed: ${failedMust.join("; ")}`);
    if (hitMustNot.length) lines.push(`✗ forbidden: ${hitMustNot.join("; ")}`);

    return {
      score,
      rationale: lines.join("\n") || "(no criteria)",
      metMust,
      failedMust,
      hitMustNot,
    };
  }
}

export class LlmJudgeStub implements Judge {
  readonly id = "llm";

  async score(): Promise<Score> {
    throw new Error(
      "LLM judge not implemented yet. Use the substring judge for now: " +
        "leave judge.kind unset or set to 'substring'.",
    );
  }
}

export function getJudge(id: string): Judge {
  switch (id) {
    case "substring":
      return new SubstringJudge();
    case "llm":
      return new LlmJudgeStub();
    default:
      throw new Error(`unknown judge '${id}'. Available: substring, llm`);
  }
}
