// Higher-level fake CDP that scripts the protocol responses for browser/
// page/frame tests. Constructed with a method-handlers map; calls to
// CDP.send dispatch through the map. Records every call for assertions.

import type { CDP } from "../../src/cdp/client.js";

export type Handler = (params: any, sessionId?: string) => any | Promise<any>;
export type Handlers = Record<string, Handler | Handler[]>;

export class FakeCDP {
  defaultTimeoutMs = 30_000;
  closed = false;
  calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  private handlers: Handlers;
  private listeners = new Map<string, Set<(p: any, s?: string) => void>>();

  constructor(handlers: Handlers = {}) {
    this.handlers = handlers;
  }

  setHandler(method: string, fn: Handler) {
    this.handlers[method] = fn;
  }

  async send(method: string, params: any = {}, sessionId?: string, _opts?: any) {
    this.calls.push({ method, params, sessionId });
    const h = this.handlers[method];
    if (!h) {
      // Unhandled methods resolve with empty object so tests don't
      // accidentally hang on noise calls (Page.enable, etc).
      return {};
    }
    if (Array.isArray(h)) {
      const fn = h.shift();
      if (!fn) throw new Error(`No more queued handlers for ${method}`);
      return await fn(params, sessionId);
    }
    return await h(params, sessionId);
  }

  on(event: string, fn: (p: any, s?: string) => void) {
    let s = this.listeners.get(event);
    if (!s) {
      s = new Set();
      this.listeners.set(event, s);
    }
    s.add(fn);
    return () => s!.delete(fn);
  }

  /** Test helper: deliver an event to subscribers. */
  emit(event: string, params: any, sessionId?: string) {
    this.listeners.get(event)?.forEach((fn) => fn(params, sessionId));
  }

  close() {
    this.closed = true;
  }

  /** Test helper: filter calls by method. */
  callsFor(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

/** Cast a FakeCDP to the real CDP type for tests. */
export function asCdp(fake: FakeCDP): CDP {
  return fake as unknown as CDP;
}
