// A Session is a thin (CDP, sessionId) pair with helpers for the patterns
// we use everywhere: evaluate JS expressions, get strings/JSON back. The
// page and verbs talk to Sessions, never to CDP directly. This is the
// abstraction that lets element verbs route to an iframe's session
// without anyone having to swap a mutable field.

import type { CDP } from "./client.js";

export class Session {
  constructor(
    readonly cdp: CDP,
    readonly id: string
  ) {}

  /**
   * Evaluate a JS expression and return its JSON-serialized value
   * (decoded back to a JS value). Throws on JS exceptions inside the page.
   */
  async evalJSON<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp.send<any>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.id
    );
    if (r?.exceptionDetails) {
      // Surface the page-side stack/description so the caller sees what
      // actually went wrong inside the JS, not a generic protocol error.
      throw new Error(
        `eval failed: ${
          r.exceptionDetails.exception?.description ??
          r.exceptionDetails.text ??
          "unknown"
        }`
      );
    }
    return r?.result?.value as T;
  }

  /** Like evalJSON but coerces the result to string (empty for null/undefined). */
  async evalString(expression: string): Promise<string> {
    const v = await this.evalJSON<unknown>(expression);
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  /** Send a CDP command using this session as the target. */
  async send<T = unknown>(method: string, params?: any): Promise<T> {
    return await this.cdp.send<T>(method, params, this.id);
  }
}
