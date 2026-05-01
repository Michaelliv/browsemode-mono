// Survey a varied set of sites to refine where the primary browser
// actually works vs falls down. Run with:
//   bun run packages/browsemode/examples/survey.ts
//
// Requires a CDP-speaking browser already listening on the port — e.g.
//   obscura serve --port 9333 --stealth
// or
//   browsemode browser launch    # spawns Chrome on 9335

import { Browsemode, randomBrowserId } from "../src/index.js";

interface Probe {
  url: string;
  category: string;
  expectInputs?: boolean;
  expectMin?: number;
}

const SITES: Probe[] = [
  { url: "https://example.com", category: "static", expectMin: 1 },
  { url: "https://news.ycombinator.com", category: "static", expectMin: 30 },
  { url: "https://books.toscrape.com", category: "light-spa", expectMin: 20 },
  {
    url: "https://en.wikipedia.org/wiki/Main_Page",
    category: "static-content",
    expectMin: 50,
    expectInputs: true,
  },
  {
    url: "https://todomvc.com/examples/react/dist/",
    category: "single-bundle-spa",
    expectMin: 1,
    expectInputs: true,
  },
  {
    url: "https://www.theverge.com",
    category: "multi-bundle-news",
    expectMin: 50,
  },
  {
    url: "https://www.nytimes.com",
    category: "multi-bundle-news",
    expectMin: 50,
  },
  {
    url: "https://weather.com",
    category: "multi-bundle-ads",
    expectMin: 50,
    expectInputs: true,
  },
  {
    url: "https://arstechnica.com",
    category: "multi-bundle-ads",
    expectMin: 30,
  },
  {
    url: "https://github.com/h4ckf0r0day/obscura",
    category: "github-spa",
    expectMin: 30,
  },
];

interface Row {
  url: string;
  category: string;
  ok: boolean;
  ms: number;
  total: number;
  inputs: number;
  hasSearch: boolean;
  title: string;
  err?: string;
}

async function run(probe: Probe, port: number): Promise<Row> {
  const t0 = Date.now();
  // Each probe gets its own ephemeral browser id so the snapshots don't
  // collide across runs.
  const id = `survey-${randomBrowserId()}`;
  try {
    const browser = await Browsemode.connect({ id, port });
    try {
      const page = await browser.newPage({ url: probe.url, waitUntil: "load" });
      // Heavy pages need extra settle for ad-tech and tracking scripts.
      await page.wait(3000);
      const scan = await page.scan();
      const inputs = scan.elements.filter(
        (e) => e.kind === "text" || e.kind === "textarea",
      );
      const total = scan.elements.length;
      const hasSearch =
        inputs.some((e) => /search|find|query/i.test(e.text + e.name)) ||
        scan.elements.some((e) => /search/i.test(e.name));
      const ok =
        total >= (probe.expectMin ?? 1) &&
        (probe.expectInputs ? inputs.length > 0 : true);
      return {
        url: probe.url,
        category: probe.category,
        ok,
        ms: Date.now() - t0,
        total,
        inputs: inputs.length,
        hasSearch,
        title: scan.title.slice(0, 80),
      };
    } finally {
      await browser.close();
    }
  } catch (e: any) {
    return {
      url: probe.url,
      category: probe.category,
      ok: false,
      ms: Date.now() - t0,
      total: 0,
      inputs: 0,
      hasSearch: false,
      title: "",
      err: String(e.message || e).slice(0, 120),
    };
  }
}

const port = Number.parseInt(process.env.PORT ?? "9333", 10);
process.stderr.write(
  `Surveying ${SITES.length} sites against the browser on :${port}\n\n`,
);

const rows: Row[] = [];
for (const probe of SITES) {
  process.stderr.write(`  ${probe.url} ... `);
  const r = await run(probe, port);
  rows.push(r);
  process.stderr.write(
    `${r.ok ? "✓" : "✗"} ${r.total}el ${r.inputs}in ${r.ms}ms${r.err ? ` (${r.err})` : ""}\n`,
  );
}

process.stderr.write("\n");
console.log("\n## Results table\n");
console.log(
  "| URL | Category | OK | Elements | Inputs | Search? | Time | Note |",
);
console.log("|---|---|---|---:|---:|:-:|---:|---|");
for (const r of rows) {
  console.log(
    `| ${r.url} | ${r.category} | ${r.ok ? "✓" : "✗"} | ${r.total} | ${r.inputs} | ${r.hasSearch ? "✓" : "—"} | ${r.ms}ms | ${r.err ?? r.title} |`,
  );
}

const byCat = new Map<string, { ok: number; n: number }>();
for (const r of rows) {
  const e = byCat.get(r.category) ?? { ok: 0, n: 0 };
  e.n++;
  if (r.ok) e.ok++;
  byCat.set(r.category, e);
}
console.log("\n## By category\n");
for (const [cat, { ok, n }] of byCat) {
  console.log(`- **${cat}**: ${ok}/${n} working`);
}
