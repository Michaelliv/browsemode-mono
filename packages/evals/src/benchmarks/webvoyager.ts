// WebVoyager — Tsinghua's real-world web navigation benchmark.
// 643 tasks across 15 popular websites (Allrecipes, Amazon, Apple,
// ArXiv, BBC News, Booking, Cambridge Dictionary, Coursera, ESPN,
// GitHub, Google Flights/Map/Search, Huggingface, Wolfram Alpha).
//
// Source: https://github.com/MinorJerry/WebVoyager
// Dataset:
//   https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl
// Format: JSONL, one task per line:
//   { "web_name": "Allrecipes", "id": "Allrecipes--0",
//     "ques": "...", "web": "https://www.allrecipes.com/" }
//
// We fetch on first use and cache to ~/.cache/browsemode-evals/webvoyager/
// so subsequent runs are offline. Each entry maps to one EvalTask;
// scoring uses whatever Judge the CLI is configured with. The original
// paper used GPT-4V-as-judge, which is on the roadmap once the LLM
// judge lands.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask } from "../types.js";
import {
  type Benchmark,
  type BenchmarkLoadOpts,
  cacheDirFor,
  registerBenchmark,
  sampleAndLimit,
} from "./base.js";

const DATA_URL =
  "https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl";

interface RawEntry {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

class WebVoyagerBenchmark implements Benchmark {
  readonly id = "webvoyager";
  readonly description =
    "WebVoyager: 643 real-world tasks across 15 popular websites";
  readonly filterKeys = ["web_name", "id"];

  async load(opts: BenchmarkLoadOpts): Promise<EvalTask[]> {
    const raw = await this.fetchRaw(opts.dataPath);
    let entries = raw.filter((e) => matchesFilter(e, opts.filter));
    entries = sampleAndLimit(entries, {
      limit: opts.limit,
      sample: opts.sample,
    });
    return entries.map(toEvalTask);
  }

  private async fetchRaw(dataPath?: string): Promise<RawEntry[]> {
    // Explicit path wins.
    if (dataPath) {
      return parseJsonl(readFileSync(dataPath, "utf8"));
    }
    const cache = join(cacheDirFor(this.id), "WebVoyager_data.jsonl");
    if (!existsSync(cache)) {
      const res = await fetch(DATA_URL);
      if (!res.ok) {
        throw new Error(
          `failed to fetch WebVoyager dataset (${res.status}). ` +
            `Download manually from ${DATA_URL} and pass --data-path <file>.`,
        );
      }
      const body = await res.text();
      writeFileSync(cache, body);
    }
    return parseJsonl(readFileSync(cache, "utf8"));
  }
}

function matchesFilter(e: RawEntry, filter?: Record<string, string>): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === "web_name" && e.web_name !== v) return false;
    if (k === "id" && !e.id.includes(v)) return false;
  }
  return true;
}

function toEvalTask(e: RawEntry): EvalTask {
  return {
    name: e.id, // "Allrecipes--0"
    task: e.ques,
    url: e.web,
    tags: ["webvoyager", e.web_name.toLowerCase()],
    budget: { maxSteps: 30, timeoutSec: 300 },
    judge: {
      // WebVoyager tasks have open-ended success criteria; the
      // canonical paper grades with GPT-4V-as-judge. We leave must
      // empty so the pi judge falls into its task-description
      // grading path. The substring judge will vacuously pass
      // these (it has no idea what "successful" means without
      // explicit criteria); use --judge pi to grade properly.
      must: [],
    },
  };
}

function parseJsonl(s: string): RawEntry[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEntry);
}

registerBenchmark(new WebVoyagerBenchmark());
