// SubstringJudge is the deterministic baseline. Every must matches
// case-insensitively; must_not matches the same way. Score is the
// fraction of criteria satisfied.

import { describe, expect, it } from "bun:test";
import { SubstringJudge } from "../src/judge.js";
import type { EvalTask, RunArtifact } from "../src/types.js";

const judge = new SubstringJudge();

const TASK = (must: string[], must_not: string[] = []): EvalTask => ({
  name: "x",
  task: "x",
  judge: { must, must_not },
});

const ART = (output: string): RunArtifact => ({
  output,
  elapsedMs: 0,
});

describe("SubstringJudge", () => {
  it("score 1 when every must matches and no must_not hits", async () => {
    const s = await judge.score(
      TASK(["alpha", "beta"]),
      ART("alpha and beta and gamma"),
    );
    expect(s.score).toBe(1);
    expect(s.metMust).toEqual(["alpha", "beta"]);
    expect(s.failedMust).toEqual([]);
  });

  it("score 0.5 when half the musts match", async () => {
    const s = await judge.score(
      TASK(["alpha", "missing"]),
      ART("alpha is here"),
    );
    expect(s.score).toBe(0.5);
    expect(s.failedMust).toEqual(["missing"]);
  });

  it("must_not subtracts from score", async () => {
    const s = await judge.score(
      TASK(["alpha"], ["captcha"]),
      ART("alpha captcha appears"),
    );
    // 1 met / 2 total = 0.5
    expect(s.score).toBe(0.5);
    expect(s.hitMustNot).toEqual(["captcha"]);
  });

  it("case-insensitive matching", async () => {
    const s = await judge.score(TASK(["HELLO"]), ART("hello world"));
    expect(s.score).toBe(1);
  });

  it("empty criteria returns score 1 (no constraints)", async () => {
    const s = await judge.score(TASK([]), ART("anything"));
    expect(s.score).toBe(1);
  });

  it("rationale lists met / missed / forbidden", async () => {
    const s = await judge.score(TASK(["a", "b"], ["x"]), ART("a and x"));
    expect(s.rationale).toContain("met: a");
    expect(s.rationale).toContain("missed: b");
    expect(s.rationale).toContain("forbidden: x");
  });
});
