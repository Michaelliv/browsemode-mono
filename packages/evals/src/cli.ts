#!/usr/bin/env bun
// browsemode-evals CLI.
//
// Tasks come from one of two sources:
//
//   - YAML files under tasks/                  (default)
//   - external benchmarks (mind2web, webvoyager) via --benchmark <id>
//
// Examples:
//   browsemode-evals list                                        # YAML tasks
//   browsemode-evals benchmarks                                  # registered benchmarks
//   browsemode-evals run                                         # all YAML on obscura
//   browsemode-evals run --backend both                          # YAML on obscura + chrome
//   browsemode-evals run hn                                      # filter YAML by name/tag
//   browsemode-evals run --benchmark webvoyager --limit 10       # 10 WebVoyager tasks
//   browsemode-evals run --benchmark webvoyager --sample 50 --limit 5
//                                                                # random sample then take 5
//   browsemode-evals run --benchmark webvoyager -f web_name=GitHub
//   browsemode-evals run --benchmark mind2web --data-path ./mind2web.json --limit 3

import "./benchmarks/mind2web.js";
import "./benchmarks/webvoyager.js";
import "./runners/direct-sdk.js";
import "./runners/pi.js";

import chalk from "chalk";
import { Command } from "commander";
import {
  type BenchmarkLoadOpts,
  getBenchmark,
  listBenchmarks,
} from "./benchmarks/base.js";
import { getJudge } from "./judge.js";
import { loadTasks } from "./loader.js";
import { runOne } from "./orchestrator.js";
import { listRunners } from "./runner.js";
import type { Backend, EvalTask, Report, ScoredRun } from "./types.js";

const program = new Command();
program
  .name("browsemode-evals")
  .description("Run browsemode eval tasks against obscura and/or Chrome")
  .version("0.0.1");

program
  .command("list")
  .description("List YAML tasks discovered in tasks/")
  .option("--filter <pattern>", "name or tag substring")
  .action((opts: { filter?: string }) => {
    const tasks = loadTasks(opts.filter);
    if (tasks.length === 0) {
      console.error(chalk.yellow("(no tasks found)"));
      process.exit(0);
    }
    for (const t of tasks) printTaskRow(t);
    console.error(chalk.dim(`\n${tasks.length} task(s)`));
  });

program
  .command("runners")
  .description("List registered runner implementations")
  .action(() => {
    for (const id of listRunners()) console.log(id);
  });

program
  .command("benchmarks")
  .description("List registered external benchmarks")
  .action(() => {
    for (const b of listBenchmarks()) {
      const filters = b.filterKeys?.join(", ") ?? "(none)";
      console.log(
        `${chalk.cyan(b.id.padEnd(14))} ${chalk.dim(`filters: ${filters}`)}`,
      );
      console.log(`  ${b.description}`);
    }
  });

program
  .command("run [filter]")
  .description(
    "Run tasks (positional filter applies to YAML tasks only; use -f for benchmarks)",
  )
  .option("-b, --backend <backend>", "obscura | chrome | both", "obscura")
  .option("-r, --runner <id>", "runner implementation", "direct-sdk")
  .option("-j, --judge <id>", "judge: substring | pi", "substring")
  .option("--obscura-port <port>", "obscura CDP port", "9333")
  .option("--obscura-host <host>", "obscura host", "localhost")
  .option(
    "--benchmark <id>",
    "load tasks from a registered benchmark instead of tasks/",
  )
  .option(
    "-l, --limit <n>",
    "max tasks (after sample/filter). Default: all",
    asInt,
  )
  .option(
    "-s, --sample <n>",
    "random-sample n tasks first (seeded for reproducibility)",
    asInt,
  )
  .option(
    "-f, --filter-kv <key=value>",
    "benchmark-specific filter (repeatable)",
    collect,
    [] as string[],
  )
  .option(
    "--data-path <path>",
    "explicit dataset file (mind2web only, or override webvoyager cache)",
  )
  .option("--json", "emit a JSON Report on stdout")
  .action(
    async (
      filter: string | undefined,
      opts: {
        backend: string;
        runner: string;
        judge: string;
        obscuraPort: string;
        obscuraHost: string;
        benchmark?: string;
        limit?: number;
        sample?: number;
        filterKv?: string[];
        dataPath?: string;
        json?: boolean;
      },
    ) => {
      const tasks = await resolveTasks(filter, opts);
      if (tasks.length === 0) {
        console.error(chalk.yellow("(no tasks matched)"));
        process.exit(0);
      }
      const backends = parseBackends(opts.backend);
      const judge = getJudge(opts.judge);
      const port = Number.parseInt(opts.obscuraPort, 10);

      const report: Report = {
        total: 0,
        perBackend: {
          obscura: { runs: 0, passed: 0, errored: 0 },
          chrome: { runs: 0, passed: 0, errored: 0 },
        },
        runs: [],
      };

      for (const task of tasks) {
        for (const backend of backends) {
          if (task.only && !task.only.includes(backend)) continue;
          if (!opts.json) {
            process.stderr.write(chalk.dim(`▸ ${task.name} on ${backend}…\n`));
          }
          const result = await runOne(task, {
            runnerId: opts.runner,
            backend,
            obscuraHost: opts.obscuraHost,
            obscuraPort: port,
          });
          const scored = await score(result, judge);
          report.runs.push(scored);
          report.total++;
          report.perBackend[backend].runs++;
          if (scored.errored) report.perBackend[backend].errored++;
          if (scored.passed) report.perBackend[backend].passed++;
          if (!opts.json) printRun(scored);
        }
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        printSummary(report);
      }
      const anyFailed = report.runs.some((r) => !r.passed);
      process.exit(anyFailed ? 1 : 0);
    },
  );

async function resolveTasks(
  yamlFilter: string | undefined,
  opts: {
    benchmark?: string;
    limit?: number;
    sample?: number;
    filterKv?: string[];
    dataPath?: string;
  },
): Promise<EvalTask[]> {
  if (opts.benchmark) {
    const bench = getBenchmark(opts.benchmark);
    const loadOpts: BenchmarkLoadOpts = {
      limit: opts.limit,
      sample: opts.sample,
      filter: parseFilterPairs(opts.filterKv ?? []),
      dataPath: opts.dataPath,
    };
    return await bench.load(loadOpts);
  }
  // YAML path.
  let tasks = loadTasks(yamlFilter);
  if (opts.sample && opts.sample < tasks.length) {
    tasks = tasks.slice(0, opts.sample);
  }
  if (opts.limit && opts.limit < tasks.length) {
    tasks = tasks.slice(0, opts.limit);
  }
  return tasks;
}

function parseFilterPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 0) {
      console.error(chalk.red(`bad --filter-kv '${p}', expected key=value`));
      process.exit(2);
    }
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function asInt(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(chalk.red(`bad integer: ${v}`));
    process.exit(2);
  }
  return n;
}

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function parseBackends(s: string): Backend[] {
  if (s === "both") return ["obscura", "chrome"];
  if (s === "obscura" || s === "chrome") return [s];
  console.error(chalk.red(`unknown backend '${s}'. use obscura|chrome|both`));
  process.exit(2);
}

async function score(
  result: Awaited<ReturnType<typeof runOne>>,
  judge: ReturnType<typeof getJudge>,
): Promise<ScoredRun> {
  if (result.errored || !result.artifact) {
    return { ...result, score: null, passed: false };
  }
  // Judge failures (timeout, missing tool call, transport hiccup)
  // are surfaced as errored runs rather than killing the entire
  // batch. We keep the artifact so the user can re-grade later.
  try {
    const s = await judge.score(result.task, result.artifact);
    return { ...result, score: s, passed: s.score >= 1 };
  } catch (e: any) {
    return {
      ...result,
      score: null,
      passed: false,
      errored: true,
      errorMessage: `judge failed: ${e?.message ?? e}`,
    };
  }
}

function printTaskRow(t: EvalTask) {
  const tags = (t.tags ?? []).join(",") || "-";
  const only = t.only ? `[${t.only.join("/")}]` : "[any]";
  console.log(
    `${chalk.cyan(t.name.padEnd(28))} ${chalk.dim(only.padEnd(14))} ${chalk.dim(tags.padEnd(28))} ${t.task.slice(0, 70)}`,
  );
}

function printRun(r: ScoredRun) {
  const tag = r.passed
    ? chalk.green("PASS")
    : r.errored
      ? chalk.red("ERR ")
      : chalk.yellow("FAIL");
  const ms = r.artifact?.elapsedMs ?? 0;
  console.error(
    `${tag} ${chalk.cyan(r.task.name.padEnd(28))} ${chalk.dim(r.backend.padEnd(8))} ${chalk.dim(`${ms}ms`)}`,
  );
  if (r.errored && r.errorMessage) {
    console.error(chalk.red(`     ${r.errorMessage}`));
  } else if (!r.passed && r.score) {
    for (const line of r.score.rationale.split("\n")) {
      console.error(chalk.dim(`     ${line}`));
    }
  }
}

function printSummary(r: Report) {
  console.error("");
  console.error(chalk.bold("Summary"));
  for (const backend of ["obscura", "chrome"] as Backend[]) {
    const b = r.perBackend[backend];
    if (b.runs === 0) continue;
    const passRate = b.runs ? ((b.passed / b.runs) * 100).toFixed(0) : "-";
    console.error(
      `  ${backend.padEnd(8)} ${b.passed}/${b.runs} pass  ${chalk.dim(`${passRate}%`)} ${b.errored ? chalk.red(`${b.errored} err`) : ""}`,
    );
  }
}

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(`Error: ${e?.message ?? e}`));
  process.exit(1);
});
