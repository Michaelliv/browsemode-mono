// Tiny typed event bus. The SDK doesn't print to stderr — it emits events.
// CLI subscribes for human-readable output. Tests assert on emissions.
// Default behavior with no subscribers: silent.
//
// Each Browser owns a Bus. Every emit also fires `getConfig().onEvent`
// if that's set, so a single global subscriber (like the CLI's stderr
// formatter) can listen across every browser without per-instance wiring.

export type BusEvent =
  | { kind: "iframe.attached"; targetId: string; url: string }
  | { kind: "iframe.detached"; targetId: string }
  | { kind: "iframe.scan-failed"; url: string; reason: string }
  | {
      kind: "scan.complete";
      url: string;
      elementCount: number;
      iframeCount: number;
    }
  | { kind: "nav.timeout"; url: string; waitUntil: string; timeoutMs: number }
  | { kind: "fallback.triggered"; from: string; to: string; reasons: string[] }
  | { kind: "fallback.failed"; reasons: string[] }
  | { kind: "session.persisted"; path: string }
  | { kind: "session.restored"; path: string }
  // Lifecycle hooks for watchdogs
  | { kind: "page.created"; targetId: string; sessionId: string }
  | { kind: "page.closed"; targetId: string }
  // Watchdog observations
  | {
      kind: "dialog.handled";
      targetId: string;
      type: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      accepted: boolean;
    }
  | { kind: "watchdog.attached"; name: string }
  | { kind: "watchdog.detached"; name: string }
  | { kind: "watchdog.error"; name: string; reason: string }
  // Downloads watchdog
  | {
      kind: "download.started";
      guid: string;
      url: string;
      suggestedFilename: string;
    }
  | {
      kind: "download.progress";
      guid: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | {
      kind: "download.completed";
      guid: string;
      filePath: string;
      totalBytes: number;
    }
  | { kind: "download.canceled"; guid: string }
  | { kind: "download.failed"; guid: string; reason: string };

export type BusEventKind = BusEvent["kind"];
export type BusListener<K extends BusEventKind = BusEventKind> = (
  event: Extract<BusEvent, { kind: K }>,
) => void;

// Imported lazily-via-helper to dodge the perceived (type-only) circular
// dependency between bus.ts and config.ts. config imports `type BusEvent`
// from us; we import its getConfig at module top.
import { getConfig } from "./config.js";

function configOnEvent(): ((e: BusEvent) => void) | undefined {
  return getConfig().onEvent;
}

export class Bus {
  private listeners = new Map<BusEventKind, Set<BusListener>>();

  on<K extends BusEventKind>(kind: K, fn: BusListener<K>): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(fn as unknown as BusListener);
    return () => {
      set.delete(fn as unknown as BusListener);
    };
  }

  emit<E extends BusEvent>(event: E): void {
    const set = this.listeners.get(event.kind);
    if (set) {
      // Snapshot listeners so an off() during iteration doesn't break us.
      for (const fn of [...set]) {
        try {
          fn(event as any);
        } catch {
          // A faulty listener never blocks the others or the emitter.
        }
      }
    }
    // Fire the global config.onEvent hook too. Read at emit time so a
    // configure({onEvent}) after this Bus was constructed still applies.
    // config imports BusEvent as a type-only import — no runtime cycle.
    const onEvent = configOnEvent();
    if (onEvent) {
      try {
        onEvent(event);
      } catch {
        // global hook errors don't block the local listeners.
      }
    }
  }

  /** Remove every listener. Useful between tests. */
  clear(): void {
    this.listeners.clear();
  }
}
