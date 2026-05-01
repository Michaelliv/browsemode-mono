// Benchmark adapters convert raw dataset entries into EvalTask shape.
// Tests use small bundled fixtures so CI doesn't need network or
// HuggingFace auth.

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { getBenchmark, listBenchmarks } from "../src/benchmarks/base.js";

// Side-effect imports register the benchmarks.
import "../src/benchmarks/mind2web.js";
import "../src/benchmarks/webvoyager.js";

const HERE = import.meta.dir;
const WEBVOYAGER_FX = resolve(HERE, "fixtures", "webvoyager-sample.jsonl");
const MIND2WEB_FX = resolve(HERE, "fixtures", "mind2web-sample.json");

describe("benchmark registry", () => {
  it("registers webvoyager and mind2web", () => {
    const ids = listBenchmarks().map((b) => b.id);
    expect(ids).toContain("webvoyager");
    expect(ids).toContain("mind2web");
  });

  it("getBenchmark throws on unknown id with helpful message", () => {
    expect(() => getBenchmark("nope")).toThrow(/no benchmark 'nope'/);
  });
});

describe("WebVoyager adapter", () => {
  it("loads from a local JSONL via dataPath", async () => {
    const tasks = await getBenchmark("webvoyager").load({
      dataPath: WEBVOYAGER_FX,
    });
    expect(tasks).toHaveLength(4);
    const first = tasks[0];
    expect(first.name).toBe("Allrecipes--0");
    expect(first.url).toBe("https://www.allrecipes.com/");
    expect(first.task).toContain("vegetarian lasagna");
    expect(first.tags).toContain("webvoyager");
    expect(first.tags).toContain("allrecipes");
    expect(first.budget?.maxSteps).toBe(30);
  });

  it("filter web_name=GitHub keeps only GitHub tasks", async () => {
    const tasks = await getBenchmark("webvoyager").load({
      dataPath: WEBVOYAGER_FX,
      filter: { web_name: "GitHub" },
    });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.tags?.includes("github"))).toBe(true);
  });

  it("limit caps the number of returned tasks", async () => {
    const tasks = await getBenchmark("webvoyager").load({
      dataPath: WEBVOYAGER_FX,
      limit: 2,
    });
    expect(tasks).toHaveLength(2);
  });

  it("sample is reproducible across runs (seeded)", async () => {
    const a = await getBenchmark("webvoyager").load({
      dataPath: WEBVOYAGER_FX,
      sample: 3,
    });
    const b = await getBenchmark("webvoyager").load({
      dataPath: WEBVOYAGER_FX,
      sample: 3,
    });
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
  });
});

describe("Mind2Web adapter", () => {
  it("loads from local JSON via dataPath", async () => {
    const tasks = await getBenchmark("mind2web").load({
      dataPath: MIND2WEB_FX,
    });
    expect(tasks).toHaveLength(3);
    const first = tasks[0];
    expect(first.name).toBe("f1-restaurants");
    expect(first.task).toContain("Boston");
    // Tags include domain (lowercased) + 'mind2web' + website
    expect(first.tags).toContain("mind2web");
    expect(first.tags).toContain("travel");
    expect(first.tags).toContain("exploretock");
    // url derived from website map
    expect(first.url).toBe("https://www.exploretock.com/");
  });

  it("filter by website", async () => {
    const tasks = await getBenchmark("mind2web").load({
      dataPath: MIND2WEB_FX,
      filter: { website: "amazon" },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].url).toBe("https://www.amazon.com/");
  });

  it("filter by domain", async () => {
    const tasks = await getBenchmark("mind2web").load({
      dataPath: MIND2WEB_FX,
      filter: { domain: "Housing" },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("f3-housing");
  });

  it("missing data with no dataPath gives a helpful error", async () => {
    // Force a cache miss path: point at an absurd cache dir.
    const orig = process.env.BROWSEMODE_EVALS_CACHE_DIR;
    process.env.BROWSEMODE_EVALS_CACHE_DIR = "/tmp/__nonexistent_evals_cache";
    try {
      await expect(getBenchmark("mind2web").load({})).rejects.toThrow(
        /Mind2Web data not found/i,
      );
    } finally {
      if (orig === undefined) delete process.env.BROWSEMODE_EVALS_CACHE_DIR;
      else process.env.BROWSEMODE_EVALS_CACHE_DIR = orig;
    }
  });
});
