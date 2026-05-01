// Benchmark abstraction.
//
// A benchmark is a programmatic source of EvalTask items, vs the
// filesystem YAML loader. Each benchmark knows how to fetch / cache
// its own dataset and convert entries into our task shape.
//
// We deliberately don't try to score benchmarks the way their original
// papers did (Mind2Web is per-step, WebVoyager uses GPT-4V-as-judge).
// Initial scoring goes through whatever Judge the CLI is configured
// with. Benchmark-specific judges are a later step.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "../types.js";

export interface BenchmarkLoadOpts {
  /** Cap how many tasks to return after sample/filter. Default: all. */
  limit?: number;
  /** Random sample first, then limit. Useful for spot-checking. */
  sample?: number;
  /** Per-benchmark filters (key=value pairs). */
  filter?: Record<string, string>;
  /** Path to a local copy of the dataset (skips download). */
  dataPath?: string;
}

export interface Benchmark {
  /** CLI id (used as `--benchmark <id>`). */
  readonly id: string;
  /** One-line description for `list`. */
  readonly description: string;
  /** Filter keys this benchmark understands (informational). */
  readonly filterKeys?: string[];
  load(opts: BenchmarkLoadOpts): Promise<EvalTask[]>;
}

const benchmarks = new Map<string, Benchmark>();

export function registerBenchmark(b: Benchmark): void {
  if (benchmarks.has(b.id)) {
    throw new Error(`benchmark '${b.id}' already registered`);
  }
  benchmarks.set(b.id, b);
}

export function getBenchmark(id: string): Benchmark {
  const b = benchmarks.get(id);
  if (!b) {
    const known = [...benchmarks.keys()].join(", ") || "(none)";
    throw new Error(`no benchmark '${id}'. Available: ${known}`);
  }
  return b;
}

export function listBenchmarks(): Benchmark[] {
  return [...benchmarks.values()];
}

/**
 * Cache directory for benchmark datasets.
 * Default: ~/.cache/browsemode-evals/<benchmark-id>/
 * Override via BROWSEMODE_EVALS_CACHE_DIR.
 */
export function cacheDirFor(benchmarkId: string): string {
  const root =
    process.env.BROWSEMODE_EVALS_CACHE_DIR ??
    join(homedir(), ".cache", "browsemode-evals");
  const dir = join(root, benchmarkId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sample-then-limit. Sample is random with a stable seed by default
 * so re-runs are reproducible; pass seed=null to randomize.
 */
export function sampleAndLimit<T>(
  items: T[],
  opts: { limit?: number; sample?: number; seed?: number | null } = {},
): T[] {
  let arr = items;
  if (opts.sample && opts.sample < arr.length) {
    const seed = opts.seed ?? 1;
    arr = pseudoShuffle(arr, seed).slice(0, opts.sample);
  }
  if (opts.limit && opts.limit < arr.length) {
    arr = arr.slice(0, opts.limit);
  }
  return arr;
}

// Tiny seeded shuffle so sampling is reproducible across runs.
// Mulberry32: small, fast, sufficient for non-cryptographic use.
function pseudoShuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
