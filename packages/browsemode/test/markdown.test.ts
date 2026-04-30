import { describe, expect, it } from "bun:test";
import {
  extractSections,
  htmlToMarkdown,
  urlToMarkdown,
} from "../src/page/markdown.js";

describe("extractSections", () => {
  it("partitions by headings", () => {
    const md = "# A\nalpha\n\n## B\nbeta\n\n# C\ngamma";
    const out = extractSections(md);
    expect(out.map((s) => s.heading)).toEqual(["A", "B", "C"]);
    expect(out.map((s) => s.level)).toEqual([1, 2, 1]);
  });

  it("captures content under each heading until the next", () => {
    const md = "# X\nfoo\nbar\n## Y\nbaz";
    const out = extractSections(md);
    expect(out[0].content).toBe("foo\nbar");
    expect(out[1].content).toBe("baz");
  });

  it("preamble before first heading becomes a level-0 section", () => {
    const md = "intro line\n\n# Real heading\nbody";
    const out = extractSections(md);
    expect(out[0].level).toBe(0);
    expect(out[0].heading).toBe("");
    expect(out[0].content).toContain("intro line");
  });

  it("returns empty array for empty input", () => {
    expect(extractSections("")).toEqual([]);
  });

  it("handles a doc with no headings as a single preamble section", () => {
    const out = extractSections("just paragraphs\nno headings");
    expect(out).toHaveLength(1);
    expect(out[0].heading).toBe("");
    expect(out[0].content).toContain("just paragraphs");
  });
});

describe("htmlToMarkdown", () => {
  it("returns empty string for empty input", async () => {
    expect(await htmlToMarkdown("")).toBe("");
  });

  it("converts a simple HTML doc to markdown containing the heading text", async () => {
    const md = await htmlToMarkdown(
      "<html><body><h1>Hello</h1><p>world</p></body></html>"
    );
    expect(md.toLowerCase()).toContain("hello");
    expect(md.toLowerCase()).toContain("world");
  });
});

describe("urlToMarkdown", () => {
  // Network-dependent; gated on env so CI without internet doesn't fail.
  const live = process.env.BROWSEMODE_E2E === "1";
  it.skipIf(!live)("fetches example.com and returns non-empty markdown", async () => {
    const r = await urlToMarkdown("https://example.com");
    expect(r.markdown.length).toBeGreaterThan(0);
  });
});
