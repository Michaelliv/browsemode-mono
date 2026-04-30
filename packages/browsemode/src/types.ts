// Shared types used across the SDK. Anything that crosses module
// boundaries lives here so we don't get circular import knots.

export type ElementKind =
  | "button"
  | "link"
  | "text"
  | "checkbox"
  | "radio"
  | "select"
  | "textarea"
  | "form"
  | "generic";

/** A single interactable element on a page, named by the scanner. */
export interface ElementInfo {
  /** Stable id stamped via `data-browsemode=<id>`. Frame-local. */
  id: string;
  /** Camelcase semantic name exposed to the agent (`signInButton`, ...). */
  name: string;
  kind: ElementKind;
  /** Trimmed, single-line preview of the element's text content. */
  text: string;
  /** Verbs callable on this element (`click`, `fill`, etc). */
  verbs: string[];
  /**
   * JS expression that resolves to the live DOM node when evaluated in
   * this element's frame session. Same-origin iframes get a chained
   * `.contentDocument.querySelector(...)` selector.
   */
  selector: string;
  /**
   * The CDP session this element lives in. For top-level page elements
   * this is the page's session; for OOPIF elements it's the iframe's
   * own session. Filled in by the page.scan() merge step.
   */
  sessionId?: string;
}

export interface ScanResult {
  url: string;
  title: string;
  elements: ElementInfo[];
  /** Maps collection name → array of rows; each row is the names of its interactables. */
  collections: Record<string, string[][]>;
}

export type WaitUntil =
  | "domcontentloaded"
  | "load"
  | "networkidle0"
  | "networkidle2";

export interface NavOpts {
  waitUntil?: WaitUntil;
  /** Hard timeout on the navigate call. Default 30s. */
  timeoutMs?: number;
}

export interface WaitForOpts {
  /** Block until a named element appears in scan. */
  name?: string;
  /** Block until any element's text contains this substring. */
  text?: string;
  /** Block until location.href matches this regex. */
  urlMatches?: string;
  /** Block until document.title matches this regex (case-insensitive). */
  titleMatches?: string;
  /** Block until url differs from `from` (or location.href at call time). */
  urlChanges?: boolean;
  /** Explicit baseline url for `urlChanges`. */
  from?: string;
  /** Block until document.querySelector(selector) is non-null. */
  selector?: string;
  /**
   * Block until the element count stops changing for `forMs` ms. Useful for
   * live-polling pages (Kayak, Airbnb listings).
   */
  stable?: number | { forMs: number; minCount?: number };
  /** Total time budget. Default 15000. */
  timeoutMs?: number;
  /** Polling interval. Default 250. */
  intervalMs?: number;
}

export interface WaitForResult {
  found: string | number;
  kind:
    | "name"
    | "text"
    | "urlMatches"
    | "titleMatches"
    | "urlChanges"
    | "selector"
    | "stable";
  elapsedMs: number;
  [key: string]: unknown;
}

export type ScrollOpts =
  | string // shorthand: name of an element to scroll into view
  | number // shorthand: scrollTo(0, y)
  | { y?: number; dy?: number; to?: "bottom" | "top"; name?: string };

export interface ViewportOpts {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface ExecOpts {
  /** Hard timeout for the user script. Default 60s. */
  timeoutMs?: number;
  /** QuickJS memory cap in bytes. Default 64MB. */
  memoryLimitBytes?: number;
}

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs: string[];
}

/**
 * What the caller expects to see on a page. Used by `openWithFallback` to
 * decide whether the primary browser delivered a usable page.
 */
export type Expectation =
  | number
  | string
  | {
      minElements?: number;
      hasInputs?: number;
      hasButtons?: number;
      hasLinks?: number;
      find?: string;
      titleMatches?: string;
    };

export interface ExpectResult {
  ok: boolean;
  reasons: string[];
}
