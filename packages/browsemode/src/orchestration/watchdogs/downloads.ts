// Capture browser-initiated downloads and surface them on the bus.
// Without this watchdog, files vanish into the browser's default
// downloads folder with no signal to the agent that anything
// happened — a click on "Export to CSV" looks indistinguishable
// from a no-op click.
//
// Three things happen on attach:
//
//   1. Browser.setDownloadBehavior is called once at the browser
//      level so every page inherits the configured download path.
//      Behavior "allowAndName" tells Chrome to write files with
//      their CDP-assigned guid instead of using the suggested
//      filename, so two simultaneous downloads of the same name
//      don't collide.
//   2. Page.downloadWillBegin is wired up — fires once per
//      starting download. We emit `download.started`.
//   3. Page.downloadProgress is wired up — fires repeatedly until
//      the state goes to `completed` or `canceled`. We emit
//      `download.progress` while in progress and either
//      `download.completed` or `download.canceled` on terminal.
//
// Against obscura the setup call is accepted but no events ever
// fire (no real download manager). Same graceful-degradation
// pattern as the popups watchdog: against a runtime that doesn't
// have the failure mode, the watchdog is dormant.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "../../browser/browser.js";
import { getConfig } from "../../config.js";
import type { Watchdog } from "./base.js";

interface DownloadWillBegin {
  guid?: string;
  url?: string;
  suggestedFilename?: string;
}

interface DownloadProgress {
  guid?: string;
  receivedBytes?: number;
  totalBytes?: number;
  state?: "inProgress" | "completed" | "canceled";
}

export class DownloadsWatchdog implements Watchdog {
  readonly name = "downloads";

  async attach(browser: Browser): Promise<() => void> {
    const cfg = getConfig();
    if (cfg.downloads.disabled) {
      // Caller explicitly opted out — do nothing.
      return () => {};
    }

    // Resolve and create the download path so the browser has
    // somewhere to write. mkdir is idempotent with recursive=true.
    const downloadPath = cfg.downloads.path ?? join(cfg.cacheDir, "downloads");
    try {
      mkdirSync(downloadPath, { recursive: true });
    } catch {
      // Failure here is non-fatal — the browser will surface a
      // permission error when it actually tries to write.
    }

    // Configure once at the browser level. The 'allowAndName'
    // behavior matches browser-use: writes with guid as filename
    // so concurrent same-named downloads don't collide.
    //
    // Fire-and-forget: don't block attach() on the configuration call
    // resolving. Against runtimes without a Browser domain (obscura
    // currently) the call resolves with {} silently. Against mocks
    // that don't auto-drain, awaiting would deadlock attach() and
    // therefore Browser.connect(). Per-call timeout protects us if
    // the runtime accepts but never replies.
    browser.cdp
      .send(
        "Browser.setDownloadBehavior",
        {
          behavior: "allowAndName",
          downloadPath,
          eventsEnabled: true,
        },
        undefined,
        { timeoutMs: 5_000 },
      )
      .catch((e: any) => {
        browser.bus.emit({
          kind: "watchdog.error",
          name: "downloads",
          reason: `setDownloadBehavior failed: ${e?.message ?? e}`,
        });
      });

    // Track filename per guid so progress + completion events can
    // surface where the file landed. Chrome only includes the
    // suggested filename on the initial willBegin event.
    const guidToFilename = new Map<string, string>();

    // Register listeners on both the Browser-level and Page-level
    // events. Chrome moved these from Page.* to Browser.* in
    // recent versions; we listen on both for breadth.
    const offs: Array<() => void> = [];

    const onWillBegin = (params: DownloadWillBegin) => {
      const guid = params?.guid ?? "";
      const url = params?.url ?? "";
      const suggested = params?.suggestedFilename ?? "";
      if (guid) guidToFilename.set(guid, suggested);
      browser.bus.emit({
        kind: "download.started",
        guid,
        url,
        suggestedFilename: suggested,
      });
    };

    const onProgress = (params: DownloadProgress) => {
      const guid = params?.guid ?? "";
      const received = Number(params?.receivedBytes ?? 0);
      const total = Number(params?.totalBytes ?? 0);
      if (params?.state === "completed") {
        const filename = guidToFilename.get(guid) ?? guid;
        guidToFilename.delete(guid);
        browser.bus.emit({
          kind: "download.completed",
          guid,
          // Best-effort: the actual on-disk path is downloadPath/guid
          // because we configured 'allowAndName'. The suggested
          // filename is preserved for display in the bus event.
          filePath: join(downloadPath, guid),
          totalBytes: total,
        });
      } else if (params?.state === "canceled") {
        guidToFilename.delete(guid);
        browser.bus.emit({ kind: "download.canceled", guid });
      } else {
        browser.bus.emit({
          kind: "download.progress",
          guid,
          receivedBytes: received,
          totalBytes: total,
        });
      }
    };

    offs.push(browser.cdp.on("Browser.downloadWillBegin", onWillBegin));
    offs.push(browser.cdp.on("Browser.downloadProgress", onProgress));
    offs.push(browser.cdp.on("Page.downloadWillBegin", onWillBegin));
    offs.push(browser.cdp.on("Page.downloadProgress", onProgress));

    return () => {
      for (const o of offs) {
        try {
          o();
        } catch {
          // best-effort
        }
      }
      guidToFilename.clear();
    };
  }
}
