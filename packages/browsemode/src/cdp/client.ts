// Minimal CDP client over a raw WebSocket. We own the wire because obscura's
// CDP surface is non-standard: static /json/list, no /json/protocol,
// session-routed dispatch only. chrome-remote-interface auto-enables
// domains on property access, which produces "No page" errors that go
// away once we control the handshake ourselves.

import { getConfig } from "../config.js";

export type CdpEventHandler = (params: any, sessionId?: string) => void;

export interface CdpSendOpts {
  /** Per-call timeout override (ms). 0 disables. */
  timeoutMs?: number;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

export class CDP {
  /**
   * Default per-call timeout. Without this a hung browser (obscura runtime
   * stuck in a retry loop, Chrome blocked on a script) wedges the caller
   * indefinitely. Sourced from getConfig().defaults.cdpTimeoutMs at
   * connect time; can be reassigned per-instance after construction.
   * Per-call override via opts.timeoutMs (0 disables).
   */
  defaultTimeoutMs = getConfig().defaults.cdpTimeoutMs;

  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<CdpEventHandler>>();
  private _closed = false;

  private constructor() {}

  /** Open a fresh CDP connection to the given browser-level WebSocket URL. */
  static async connect(url: string): Promise<CDP> {
    const c = new CDP();
    c.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        c.ws.removeEventListener("error", onErr as any);
        resolve();
      };
      const onErr = () => {
        c.ws.removeEventListener("open", onOpen as any);
        reject(new Error(`WebSocket failed connecting to ${url}`));
      };
      c.ws.addEventListener("open", onOpen as any, { once: true } as any);
      c.ws.addEventListener("error", onErr as any, { once: true } as any);
    });
    c.ws.addEventListener("message", (ev: any) => c.onMessage(ev.data));
    c.ws.addEventListener("close", () => {
      c._closed = true;
      const err = new Error("CDP socket closed");
      for (const p of c.pending.values()) p.reject(err);
      c.pending.clear();
    });
    return c;
  }

  send<T = any>(
    method: string,
    params: any = {},
    sessionId?: string,
    opts: CdpSendOpts = {}
  ): Promise<T> {
    if (this._closed) return Promise.reject(new Error("CDP socket closed"));
    const id = this.nextId++;
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: any;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(event: string, handler: CdpEventHandler): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      this.ws.close();
    }
  }

  private onMessage(data: any): void {
    const text = typeof data === "string" ? data : data.toString();
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve(msg.result);
      }
    } else if (typeof msg.method === "string") {
      const set = this.listeners.get(msg.method);
      if (!set) return;
      for (const h of set) {
        try {
          h(msg.params, msg.sessionId);
        } catch {
          // A faulty listener never blocks the others.
        }
      }
    }
  }
}
