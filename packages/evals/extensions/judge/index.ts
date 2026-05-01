// Eval judge extension. Registers a single `judge` tool that the
// LLM calls exactly once to record its verdict on a task. Same
// architecture as pi-browsemode: one tool, structured params, no
// loose JSON parsing on our side.
//
// The judge runner spawns pi with this extension and a prompt
// describing:
//   - the task instruction
//   - the agent's output (RunArtifact.output)
//   - the must / must_not criteria
//   - "call the judge tool with your verdict"
//
// The tool itself is a no-op that just acknowledges the call. The
// runner reads the tool_execution_start event to capture the args,
// which IS the score. Doing it via a tool instead of asking for
// JSON in plain text means we get strict schema validation for
// free and zero parse failures.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "judge",
    label: "Eval Judge",
    description:
      "Record the verdict for the eval task being scored. " +
      "Call this tool exactly once with your assessment. " +
      "The score is between 0 and 1 (1 = every must was met, no must_not was hit).",
    promptSnippet:
      "Score the agent's output by calling `judge` with score, rationale, and the lists of met/failed/forbidden criteria.",
    parameters: Type.Object({
      score: Type.Number({
        minimum: 0,
        maximum: 1,
        description:
          "Overall score in [0, 1]. 1 means every `must` criterion is satisfied and no `must_not` is hit. Partial credit allowed.",
      }),
      rationale: Type.String({
        description:
          "Short prose explaining the score. Mention which criteria were met, missed, or forbidden.",
      }),
      met_must: Type.Array(Type.String(), {
        description:
          "Subset of the task's `must` criteria you consider satisfied by the output. Verbatim from the task.",
      }),
      failed_must: Type.Array(Type.String(), {
        description:
          "Subset of the task's `must` criteria you consider NOT satisfied by the output. Verbatim from the task.",
      }),
      hit_must_not: Type.Array(Type.String(), {
        description:
          "Subset of the task's `must_not` criteria the output violated. Verbatim from the task.",
      }),
    }),
    async execute(_id, params) {
      // No real work: the runner reads the tool args off the
      // event stream. The text we return here is just so the
      // model knows it was acknowledged and can stop the loop.
      const summary =
        `Recorded score=${params.score}, ${params.met_must.length} met, ` +
        `${params.failed_must.length} missed, ${params.hit_must_not.length} forbidden.`;
      return {
        content: [{ type: "text", text: summary }],
        details: params,
      };
    },
  });
}
