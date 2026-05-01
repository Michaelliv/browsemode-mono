// PiJudge tests using a fake pi subprocess.
//
// The judge spawns pi via a PiClientFactory; we inject one that
// points at a tiny node script emulating pi's RPC protocol. The
// script:
//   1. acks every command with response success:true
//   2. on receiving `prompt`, emits scripted events
//   3. exits when stdin closes
//
// This exercises the same wire protocol PiJudge expects from real
// pi: the model decides to call `judge` with structured args, we
// surface that as Score; if the model never calls `judge`, we
// reject with a clear error.

import { describe, expect, it } from "bun:test";
import { PiJudge } from "../src/judges/pi.js";
import { PiRpcClient } from "../src/runners/lib/pi-rpc-client.js";
import type { EvalTask, RunArtifact } from "../src/types.js";

/** Build the args for a node subprocess that emulates pi rpc. */
function fakePiArgs(events: any[]): string[] {
  const code = `
    const events = ${JSON.stringify(events)};
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c.toString();
      while (true) {
        const i = buf.indexOf("\\n");
        if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          type: "response", id: m.id, command: m.type,
          success: true, data: m.type === "get_last_assistant_text" ? { text: null } : {},
        }) + "\\n");
        if (m.type === "prompt") {
          for (const e of events) process.stdout.write(JSON.stringify(e) + "\\n");
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
  `;
  return ["-e", code];
}

function makeFactory(events: any[]) {
  return () =>
    new PiRpcClient({
      bin: process.execPath,
      args: fakePiArgs(events),
    });
}

const TASK: EvalTask = {
  name: "demo",
  task: "Open Hacker News and report the title of the top story.",
  judge: { must: ["hacker news"] },
};

const ARTIFACT: RunArtifact = {
  output: "I navigated to news.ycombinator.com and read the headlines.",
  elapsedMs: 1234,
};

describe("PiJudge", () => {
  it("captures the judge tool args as a Score (happy path)", async () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "judge",
        args: {
          score: 0.75,
          rationale: "met two of three",
          met_must: ["hacker news"],
          failed_must: [],
          hit_must_not: [],
        },
      },
      { type: "agent_end", messages: [] },
    ];
    const judge = new PiJudge(makeFactory(events));
    const score = await judge.score(TASK, ARTIFACT);
    expect(score.score).toBe(0.75);
    expect(score.rationale).toBe("met two of three");
    expect(score.metMust).toEqual(["hacker news"]);
    expect(score.failedMust).toEqual([]);
    expect(score.hitMustNot).toEqual([]);
  });

  it("clamps out-of-range scores and treats non-arrays defensively", async () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "judge",
        // Model misbehaves: returns score above 1, missing arrays.
        args: {
          score: 1.7,
          rationale: "good",
          met_must: null,
          failed_must: undefined,
          hit_must_not: "not-an-array",
        },
      },
      { type: "agent_end", messages: [] },
    ];
    const judge = new PiJudge(makeFactory(events));
    const score = await judge.score(TASK, ARTIFACT);
    expect(score.score).toBe(1);
    expect(score.metMust).toEqual([]);
    expect(score.failedMust).toEqual([]);
    expect(score.hitMustNot).toEqual([]);
  });

  it("rejects when the agent finishes without calling the judge tool", async () => {
    const events = [
      { type: "agent_end", messages: [] }, // no judge tool call
    ];
    const judge = new PiJudge(makeFactory(events));
    await expect(judge.score(TASK, ARTIFACT)).rejects.toThrow(
      /without calling the `judge` tool/i,
    );
  });

  it("first judge call wins (subsequent tool calls ignored)", async () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "judge",
        args: {
          score: 0.4,
          rationale: "first",
          met_must: [],
          failed_must: ["hacker news"],
          hit_must_not: [],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "judge",
        args: {
          score: 1.0,
          rationale: "second (should be ignored)",
          met_must: ["hacker news"],
          failed_must: [],
          hit_must_not: [],
        },
      },
      { type: "agent_end", messages: [] },
    ];
    const judge = new PiJudge(makeFactory(events));
    const score = await judge.score(TASK, ARTIFACT);
    expect(score.score).toBe(0.4);
    expect(score.rationale).toBe("first");
  });
});
