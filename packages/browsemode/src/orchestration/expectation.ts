// Expectation predicate. Used by openWithFallback to decide whether the
// primary browser actually delivered a usable page or wedged.
//
// Forms:
//   number    → minimum interactable element count
//   string    → at least one element's name/text matches (case-insensitive)
//   object    → combination of constraints (all must hold)

import type { Expectation, ExpectResult, ScanResult } from "../types.js";

/**
 * Evaluate whether `scan` satisfies `expect`. Returns ok + a list of
 * reasons why not (empty when ok). Reasons are human-readable for
 * inclusion in fallback diagnostics.
 */
export function meetsExpectation(
  scan: ScanResult,
  expect: Expectation
): ExpectResult {
  const reasons: string[] = [];
  const els = scan.elements;

  if (typeof expect === "number") {
    if (els.length < expect) {
      reasons.push(`got ${els.length} elements, expected ≥${expect}`);
    }
  } else if (typeof expect === "string") {
    const lower = expect.toLowerCase();
    const hit = els.find(
      (e) =>
        e.name.toLowerCase().includes(lower) ||
        e.text.toLowerCase().includes(lower)
    );
    if (!hit) reasons.push(`no element matches '${expect}'`);
  } else {
    if (expect.minElements != null && els.length < expect.minElements) {
      reasons.push(
        `got ${els.length} elements, expected ≥${expect.minElements}`
      );
    }
    if (expect.hasInputs != null) {
      const c = els.filter(
        (e) => e.kind === "text" || e.kind === "textarea"
      ).length;
      if (c < expect.hasInputs) {
        reasons.push(`got ${c} inputs, expected ≥${expect.hasInputs}`);
      }
    }
    if (expect.hasButtons != null) {
      const c = els.filter((e) => e.kind === "button").length;
      if (c < expect.hasButtons) {
        reasons.push(`got ${c} buttons, expected ≥${expect.hasButtons}`);
      }
    }
    if (expect.hasLinks != null) {
      const c = els.filter((e) => e.kind === "link").length;
      if (c < expect.hasLinks) {
        reasons.push(`got ${c} links, expected ≥${expect.hasLinks}`);
      }
    }
    if (expect.find) {
      const lower = expect.find.toLowerCase();
      const hit = els.find(
        (e) =>
          e.name.toLowerCase().includes(lower) ||
          e.text.toLowerCase().includes(lower)
      );
      if (!hit) reasons.push(`no element matches find='${expect.find}'`);
    }
    if (expect.titleMatches) {
      const re = new RegExp(expect.titleMatches, "i");
      if (!re.test(scan.title)) {
        reasons.push(
          `title '${scan.title}' doesn't match /${expect.titleMatches}/i`
        );
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Parse a CLI-style spec string into an Expectation. Supported forms:
 *   "25"                       → 25
 *   "find:search"              → { find: "search" }
 *   "inputs:1,find:login"      → { hasInputs: 1, find: "login" }
 *   "title:^GitHub"            → { titleMatches: "^GitHub" }
 */
export function parseExpectationSpec(spec: string): Expectation {
  if (/^\s*\d+\s*$/.test(spec)) return parseInt(spec.trim(), 10);
  const out: Record<string, unknown> = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (!v) continue;
    if (k === "find") out.find = v;
    else if (k === "title") out.titleMatches = v;
    else if (k === "inputs") out.hasInputs = parseInt(v, 10);
    else if (k === "buttons") out.hasButtons = parseInt(v, 10);
    else if (k === "links") out.hasLinks = parseInt(v, 10);
    else if (k === "min" || k === "minElements") out.minElements = parseInt(v, 10);
  }
  // Bare string with no `key:value` pairs → treat as a find query.
  if (Object.keys(out).length === 0 && spec.trim()) return spec.trim();
  return out as Expectation;
}
