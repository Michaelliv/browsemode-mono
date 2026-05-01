// Judges score an agent's output against the task's `must` /
// `must_not` criteria.
//
// Two implementations:
//
//   - SubstringJudge: deterministic. Every `must` criterion is a
//     case-insensitive substring; same for `must_not`. No LLM, no
//     API key. Used for smoke tests and CI where the criteria are
//     exact phrases the runner is expected to emit.
//
//   - PiJudge: spawns pi with a tiny extension that registers a
//     `judge` tool. The model calls the tool exactly once with a
//     structured verdict. Same RPC pattern as the pi runner, same
//     auth, same Anthropic OAuth path. See judges/pi.ts.
//
// The CLI defaults to substring. Use `--judge pi` for semantic
// grading on benchmark tasks (WebVoyager, Mind2Web) where the
// criteria are open-ended.

import { PiJudge } from "./judges/pi.js";
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

export function getJudge(id: string): Judge {
  switch (id) {
    case "substring":
      return new SubstringJudge();
    case "pi":
      return new PiJudge();
    default:
      throw new Error(`unknown judge '${id}'. Available: substring, pi`);
  }
}

export { PiJudge } from "./judges/pi.js";
