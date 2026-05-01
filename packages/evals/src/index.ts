// Public eval-suite surface. Most callers want the CLI; this barrel
// is for programmatic use (CI integrations, custom dashboards, etc).

export {
  type Benchmark,
  type BenchmarkLoadOpts,
  getBenchmark,
  listBenchmarks,
  registerBenchmark,
} from "./benchmarks/base.js";
export { getJudge, type Judge, PiJudge, SubstringJudge } from "./judge.js";
export { loadTasks } from "./loader.js";
export { runOne } from "./orchestrator.js";
export {
  getRunner,
  listRunners,
  type Runner,
  type RunnerContext,
  registerRunner,
} from "./runner.js";
export type {
  Backend,
  EvalTask,
  Report,
  RunArtifact,
  RunResult,
  Score,
  ScoredRun,
} from "./types.js";

// Side-effect imports register the built-in runners + benchmarks.
import "./benchmarks/mind2web.js";
import "./benchmarks/webvoyager.js";
import "./runners/direct-sdk.js";
import "./runners/pi.js";
