// Open a browser, navigate to a URL, scan, evaluate against an
// Expectation. If the primary doesn't deliver, close it and retry on
// managed Chrome.
//
// Emits `fallback.triggered` when retrying and `fallback.failed` if
// Chrome also misses the expectation.

import {
  Browser,
  type BrowserOpts,
  type NewPageOpts,
} from "../browser/browser.js";
import type { Bus } from "../bus.js";
import type { Page } from "../page/page.js";
import type { Expectation } from "../types.js";
import { meetsExpectation } from "./expectation.js";

export interface OpenWithFallbackOpts {
  /** Connection target for the primary attempt. */
  primary: BrowserOpts;
  /** Strategy when primary misses expect. "chrome" launches managed Chrome; "off" disables. */
  fallback?: "chrome" | "off";
  /** Page options applied to the first new page on whichever browser wins. */
  page?: NewPageOpts;
  /** URL to navigate to. The expectation is checked against the page after settle. */
  url: string;
  /**
   * What to expect on the page. Default `{ minElements: 5 }` — catches
   * obvious wedges without false-positives on tiny pages.
   */
  expect?: Expectation;
  /** Shared bus. Both attempts emit through it. */
  bus?: Bus;
}

export interface OpenResult {
  browser: Browser;
  page: Page;
  /** True if the primary failed expectation and we ran on Chrome. */
  fellBack: boolean;
  /** Expectation reasons that caused the fallback (empty if no fallback). */
  reasons: string[];
}

/**
 * Try `primary`; if expectation isn't met, fall back to Chrome. Returns
 * the browser+page that actually held up, plus whether we fell back.
 */
export async function openWithFallback(
  opts: OpenWithFallbackOpts,
): Promise<OpenResult> {
  // Default expectation: catches obvious wedges (ARS returning 2 elements,
  // CloudFront walls returning 0) without false-positives on truly tiny
  // pages — example.com legitimately returns 1 element. Even when the
  // wedge predicate fires falsely there, the fallback path is harmless
  // because example.com works on Chrome too.
  const expect: Expectation = opts.expect ?? { minElements: 5 };
  const fallbackMode = opts.fallback ?? "chrome";

  const primary = await Browser.connect({
    ...opts.primary,
    bus: opts.bus ?? opts.primary.bus,
  });
  const bus = opts.bus ?? primary.bus;
  const primaryPage = await primary.newPage({
    ...(opts.page ?? {}),
    url: opts.url,
  });
  const primaryScan = await primaryPage.scan();
  const primaryVerdict = meetsExpectation(primaryScan, expect);
  if (primaryVerdict.ok) {
    return {
      browser: primary,
      page: primaryPage,
      fellBack: false,
      reasons: [],
    };
  }

  if (fallbackMode === "off") {
    // Caller asked us not to fall back; surface the wedged primary plus
    // diagnostic reasons. The caller decides what to do (retry, error,
    // navigate elsewhere, ...).
    return {
      browser: primary,
      page: primaryPage,
      fellBack: false,
      reasons: primaryVerdict.reasons,
    };
  }

  // Fall back to managed Chrome.
  bus.emit({
    kind: "fallback.triggered",
    from: primary.product || "primary",
    to: "chrome",
    reasons: primaryVerdict.reasons,
  });
  await primary.close().catch(() => undefined);

  const chrome = await Browser.launch({ bus });
  const chromePage = await chrome.newPage({
    ...(opts.page ?? {}),
    url: opts.url,
  });
  const chromeScan = await chromePage.scan();
  const chromeVerdict = meetsExpectation(chromeScan, expect);
  if (!chromeVerdict.ok) {
    bus.emit({ kind: "fallback.failed", reasons: chromeVerdict.reasons });
  }
  return {
    browser: chrome,
    page: chromePage,
    fellBack: true,
    reasons: primaryVerdict.reasons,
  };
}
