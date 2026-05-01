// Mind2Web — Ohio State's web-task benchmark.
// 2,350 tasks across 137 websites covering diverse domains.
//
// Source: https://github.com/OSU-NLP-Group/Mind2Web
// Dataset: https://huggingface.co/datasets/osunlp/Mind2Web
//
// The full dataset is gated on Hugging Face (requires acceptance of
// usage terms + auth token), so we don't auto-download. Two ways to
// load it:
//
//   1. Pass --data-path /path/to/processed.json. The expected shape
//      matches browser-use's preprocessed copy:
//        [{ id, website, domain, subdomain, confirmed_task,
//           action_reprs: [...] }]
//      browser-use ships theirs at tests/mind2web_data/processed.json
//      and you can copy it into your cache.
//
//   2. Place your own processed.json at
//      ~/.cache/browsemode-evals/mind2web/processed.json
//      and call without --data-path.
//
// Mind2Web tasks intentionally don't carry a starting URL — the
// agent is expected to find the website itself. We do a best-effort
// website-name → URL mapping for the most common sites; tasks
// without a known mapping fall back to a Google query.
//
// Original scoring is per-step element-match accuracy. We don't try
// to reproduce that here. The substring judge will under-grade these
// tasks; treat their output as replay traces until the LLM judge
// can match generated trajectories against gold action_reprs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask } from "../types.js";
import {
  type Benchmark,
  type BenchmarkLoadOpts,
  cacheDirFor,
  registerBenchmark,
  sampleAndLimit,
} from "./base.js";

interface RawEntry {
  id: string;
  website: string;
  domain?: string;
  subdomain?: string;
  confirmed_task: string;
  action_reprs?: string[];
}

// Best-effort website → URL map for the websites Mind2Web covers
// most often. Anything missing falls back to a Google query.
const WEBSITE_URLS: Record<string, string> = {
  exploretock: "https://www.exploretock.com/",
  kbb: "https://www.kbb.com/",
  redfin: "https://www.redfin.com/",
  amazon: "https://www.amazon.com/",
  delta: "https://www.delta.com/",
  united: "https://www.united.com/",
  airbnb: "https://www.airbnb.com/",
  ticketmaster: "https://www.ticketmaster.com/",
  yelp: "https://www.yelp.com/",
  imdb: "https://www.imdb.com/",
  github: "https://github.com/",
  spotify: "https://open.spotify.com/",
  walmart: "https://www.walmart.com/",
  target: "https://www.target.com/",
  ebay: "https://www.ebay.com/",
};

function urlFor(website: string): string {
  const known = WEBSITE_URLS[website.toLowerCase()];
  if (known) return known;
  // Fallback: search the website name on Google. Not ideal but at
  // least lets the agent attempt.
  return `https://www.google.com/search?q=${encodeURIComponent(website)}`;
}

class Mind2WebBenchmark implements Benchmark {
  readonly id = "mind2web";
  readonly description =
    "Mind2Web: 2.3k web tasks across 137 sites (data not bundled, see --data-path)";
  readonly filterKeys = ["website", "domain", "subdomain"];

  async load(opts: BenchmarkLoadOpts): Promise<EvalTask[]> {
    const raw = this.readDataset(opts.dataPath);
    let entries = raw.filter((e) => matchesFilter(e, opts.filter));
    entries = sampleAndLimit(entries, {
      limit: opts.limit,
      sample: opts.sample,
    });
    return entries.map(toEvalTask);
  }

  private readDataset(dataPath?: string): RawEntry[] {
    const explicit = dataPath;
    const cache = join(cacheDirFor(this.id), "processed.json");
    const file = explicit ?? (existsSync(cache) ? cache : null);
    if (!file) {
      throw new Error(
        "Mind2Web data not found. The dataset is HuggingFace-gated " +
          "and not auto-downloaded. Either:\n" +
          "  - pass --data-path /path/to/processed.json, or\n" +
          `  - place processed.json at ${cache}\n` +
          "browser-use ships a preprocessed copy at " +
          "tests/mind2web_data/processed.json that's compatible.",
      );
    }
    const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(data)) {
      throw new Error(
        `expected ${file} to be a JSON array of Mind2Web entries`,
      );
    }
    return data as RawEntry[];
  }
}

function matchesFilter(e: RawEntry, filter?: Record<string, string>): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (k === "website" && e.website !== v) return false;
    if (k === "domain" && e.domain !== v) return false;
    if (k === "subdomain" && e.subdomain !== v) return false;
  }
  return true;
}

function toEvalTask(e: RawEntry): EvalTask {
  const tags = ["mind2web", e.website.toLowerCase()];
  if (e.domain) tags.push(e.domain.toLowerCase());
  return {
    name: e.id,
    task: e.confirmed_task,
    url: urlFor(e.website),
    tags,
    budget: { maxSteps: 25, timeoutSec: 240 },
    judge: {
      // Same caveat as WebVoyager: original scoring is per-step
      // element-match. Until the LLM judge lands, the substring
      // judge will under-grade these. The action_reprs gold
      // trajectory is preserved on the meta side via the
      // benchmark fixture for later trajectory matching.
      must: ["__placeholder__"],
    },
  };
}

registerBenchmark(new Mind2WebBenchmark());
