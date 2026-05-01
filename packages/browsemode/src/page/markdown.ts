// HTML → markdown via markit-ai. The agent's text "vision" of a page —
// instead of pixels, the LLM gets clean markdown. Markit also handles
// llms.txt discovery, VitePress .md sources, RSS, Wikipedia, etc; we
// lean on it instead of rolling our own renderers.

import { Markit } from "markit-ai";

export interface MarkdownSection {
  level: number;
  heading: string;
  content: string;
}

// Lazy singleton — Markit ships heavy init (DOMPurify, turndown), no need to
// pay it on import.
let _markit: Markit | null = null;
function getMarkit(): Markit {
  if (!_markit) _markit = new Markit();
  return _markit;
}

/** Convert raw HTML to markdown. Returns "" for empty input. */
export async function htmlToMarkdown(html: string): Promise<string> {
  if (!html) return "";
  const result = await getMarkit().convert(Buffer.from(html, "utf-8"), {
    extension: ".html",
  });
  return result.markdown;
}

/**
 * Convert a URL to markdown. Lets markit do its URL-first magic: probe
 * /llms.txt, look for `<link rel="alternate" type="text/markdown">`,
 * detect VitePress and pull the raw .md, etc. Falls back to fetching
 * the HTML and rendering.
 */
export async function urlToMarkdown(
  url: string,
): Promise<{ markdown: string; title?: string }> {
  const result = await getMarkit().convertUrl(url);
  return { markdown: result.markdown, title: result.title };
}

/**
 * Partition a markdown document by headings. Each section runs from a
 * heading line until the next heading of equal-or-higher rank. Pre-
 * heading content folds into a synthetic level-0 "preamble" section.
 */
export function extractSections(md: string): MarkdownSection[] {
  const lines = md.split("\n");
  const out: MarkdownSection[] = [];
  let cur: MarkdownSection | null = null;
  const flush = () => {
    if (cur) {
      cur.content = cur.content.trim();
      out.push(cur);
    }
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      cur = { level: m[1].length, heading: m[2].trim(), content: "" };
    } else if (cur) {
      cur.content += `${line}\n`;
    } else {
      cur = { level: 0, heading: "", content: `${line}\n` };
    }
  }
  flush();
  return out.filter((s) => s.heading || s.content);
}
