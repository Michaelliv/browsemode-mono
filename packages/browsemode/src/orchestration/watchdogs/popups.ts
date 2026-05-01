// Auto-handle JavaScript dialogs (alert / confirm / prompt /
// beforeunload). Without this, CDP blocks until something handles
// `Page.javascriptDialogOpening` — the page hangs and any agent
// driving it stalls forever. Real flows hit these constantly:
// "are you sure you want to leave?", site banners with confirm(),
// debug `alert()` calls left in production.
//
// Decision matches browser-use's PopupsWatchdog:
//   alert        → accept (clicks OK)
//   confirm      → accept (safer default than cancel for automation)
//   beforeunload → accept (let the navigation through)
//   prompt       → cancel (we don't have an answer to the question)
//
// Every dispatched dialog emits a `dialog.handled` bus event so the
// agent can read the message back later.

import type { Browser } from "../../browser/browser.js";
import type { Watchdog } from "./base.js";

type DialogType = "alert" | "confirm" | "prompt" | "beforeunload";

interface DialogOpening {
  message?: string;
  type?: DialogType;
  url?: string;
  defaultPrompt?: string;
  hasBrowserHandler?: boolean;
}

export class PopupsWatchdog implements Watchdog {
  readonly name = "popups";

  async attach(browser: Browser): Promise<() => void> {
    const offs: Array<() => void> = [];
    const armed = new Set<string>(); // sessionIds we've already wired

    const armSession = async (sessionId: string, targetId: string) => {
      if (armed.has(sessionId)) return;
      armed.add(sessionId);

      // CDP requires Page domain enabled to receive
      // Page.javascriptDialogOpening events. Soft-fail on enable —
      // it's already enabled by Page.scan() but Page.enable is
      // idempotent.
      await browser.cdp
        .send("Page.enable", {}, sessionId)
        .catch(() => undefined);
    };

    // Per-CDP-message listener. javascriptDialogOpening is dispatched
    // on the session that owns the page that opened the dialog. We
    // use the root listener and filter by sessionId so we catch
    // OOPIF dialogs too.
    const off = browser.cdp.on(
      "Page.javascriptDialogOpening",
      (params: DialogOpening, sessionId?: string) => {
        const type = (params?.type ?? "alert") as DialogType;
        const message = params?.message ?? "";
        // Match browser-use: accept everything except prompt (we
        // can't supply input from a watchdog).
        const accept = type !== "prompt";

        // Look up which target this session belongs to so the bus
        // event is addressable.
        let targetId = "";
        for (const p of browser.pages.values()) {
          if (p.mainFrame.session.id === sessionId) {
            targetId = p.targetId;
            break;
          }
        }

        // Race-friendly dispatch: a dialog blocks the page event
        // loop, so the handle call needs its own timeout. If the
        // first attempt times out we ignore (the page may have
        // navigated away in the meantime).
        browser.cdp
          .send(
            "Page.handleJavaScriptDialog",
            { accept },
            sessionId,
            // 500 ms matches browser-use's per-attempt cap. Long
            // enough for a healthy CDP, short enough to bail before
            // the agent's outer step timeout.
            { timeoutMs: 500 },
          )
          .then(() => {
            browser.bus.emit({
              kind: "dialog.handled",
              targetId,
              type,
              message,
              accepted: accept,
            });
          })
          .catch((reason: any) => {
            browser.bus.emit({
              kind: "watchdog.error",
              name: "popups",
              reason: `handleJavaScriptDialog failed: ${reason?.message ?? reason}`,
            });
          });
      },
    );
    offs.push(off);

    // Arm every existing page (the Browser may already have tabs
    // when the watchdog attaches, e.g. on Browsemode.restore).
    for (const p of browser.pages.values()) {
      await armSession(p.mainFrame.session.id, p.targetId);
    }

    // Wire newly-created pages.
    const offCreated = browser.bus.on("page.created", (e) => {
      // Don't await — fire-and-forget. Page.enable failure is
      // non-fatal and we don't want to block page creation.
      void armSession(e.sessionId, e.targetId);
    });
    offs.push(offCreated);

    return () => {
      for (const o of offs) {
        try {
          o();
        } catch {
          // detach is best-effort.
        }
      }
      armed.clear();
    };
  }
}
