// Frame represents one document inside a page — the main frame, or a
// cross-origin iframe (OOPIF). Each Frame owns a CDP Session. Same-origin
// iframes don't get their own Frame; the scanner walks them via
// `iframe.contentDocument` inside the parent's session.
//
// Frame discovery:
//   1. Page.scan calls refreshFrames(page).
//   2. refreshFrames walks Target.getTargets, attaches to every iframe
//      target it doesn't already know, registers the shim+stealth
//      preloads on the new session, stores the Frame on the page.
//   3. Stale frame targets get pruned.

import type { Browser } from "../browser/browser.js";
import { Session } from "../cdp/session.js";
import type { Page } from "./page.js";
import { SHIM_SCRIPT } from "./shim.js";
import { STEALTH_SCRIPT } from "./stealth.js";

export interface Frame {
  /** CDP target id for this frame. */
  targetId: string;
  /** Session attached to this frame's process. */
  session: Session;
  /** Last-known URL. */
  url: string;
}

/**
 * Walk Target.getTargets and attach to any iframe targets that aren't
 * yet in the page's frame map. Drops frames whose target disappeared.
 * Emits `iframe.attached` / `iframe.detached` on the browser bus.
 */
export async function refreshFrames(
  browser: Browser,
  page: Page
): Promise<void> {
  // Walk Target.getTargets browser-wide. The browser session sees every
  // target; per-tab sessions can't enumerate iframes that haven't been
  // attached to them yet. Cross-tab leakage is bounded because each tab
  // runs its own attach pool and only routes verbs through its own
  // sessions.
  const r = await browser.cdp
    .send<{ targetInfos?: any[] }>("Target.getTargets", {})
    .catch(() => ({ targetInfos: [] as any[] }));
  // Defensive: fakes / older CDP servers may resolve without `targetInfos`.
  const targetInfos: any[] = r?.targetInfos ?? [];
  const liveIframes = targetInfos.filter((t: any) => t.type === "iframe");
  const liveIds = new Set(liveIframes.map((t: any) => t.targetId));

  // Drop stale frames first.
  for (const id of [...page.iframes.keys()]) {
    if (!liveIds.has(id)) {
      page.iframes.delete(id);
      browser.bus.emit({ kind: "iframe.detached", targetId: id });
    }
  }

  // Attach to any iframe target we don't already have. We don't filter
  // by openerFrameId because Target.getTargets doesn't expose it
  // reliably; cross-tab leakage is bounded by per-tab session pools.
  for (const t of liveIframes) {
    if (page.iframes.has(t.targetId)) continue;
    const attach = await browser.cdp
      .send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: t.targetId,
        flatten: true,
      })
      .catch(() => null);
    if (!attach) continue;

    const session = new Session(browser.cdp, attach.sessionId);

    // Run the shim + stealth in the iframe too. Same justification as
    // the main frame: bootstrap chains break without these on obscura,
    // and they're cheap-to-inject on Chrome.
    if (browser.shimEnabled) {
      await session
        .send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM_SCRIPT })
        .catch(() => undefined);
    }
    await session
      .send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT })
      .catch(() => undefined);

    page.iframes.set(t.targetId, {
      targetId: t.targetId,
      session,
      url: t.url ?? "",
    });
    browser.bus.emit({
      kind: "iframe.attached",
      targetId: t.targetId,
      url: t.url ?? "",
    });
  }
}
