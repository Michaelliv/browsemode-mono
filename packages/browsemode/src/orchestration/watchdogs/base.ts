// Watchdog pattern, ported from browser-use's BaseWatchdog.
//
// A watchdog is a small piece of cross-cutting browser logic that
// reacts to bus events and CDP events so the core dispatcher stays
// focused on verbs. Examples: auto-handling JavaScript dialogs,
// granting permissions on connect, recovering from target crashes,
// detecting downloads triggered by clicks.
//
// Each watchdog implements `attach(browser)`. attach() wires up
// subscriptions and returns a detach function. The Browser collects
// detach fns at install time and calls them on close()/detach().
//
// Watchdogs MUST be safe to attach to a Browser that already has open
// pages: they typically subscribe to `page.created` for per-page
// setup and also walk the existing pages map at attach time.

import type { Browser } from "../../browser/browser.js";

export interface Watchdog {
  /** Short stable id, used in bus events and config. */
  readonly name: string;
  /**
   * Wire up this watchdog. Returns a detach function that tears down
   * every subscription and per-page listener. detach() must be
   * idempotent.
   */
  attach(browser: Browser): Promise<() => void>;
}

/**
 * The default set installed by Browser.connect() unless
 * `opts.watchdogs` is passed explicitly. Each entry is a factory so
 * watchdogs are constructed per-Browser, not shared.
 */
export type WatchdogFactory = () => Watchdog;
