// Mock WebSocket for CDP tests. The CDP class connects via `new WebSocket(url)`.
// We override the global WebSocket constructor for the duration of a test
// with a controllable double.

type Listener = (ev: any) => void;

export class MockSocket {
  url: string;
  readyState = 0; // CONNECTING
  private listeners = new Map<string, Set<Listener>>();
  /** Frames we've sent (parsed JSON). */
  sent: any[] = [];
  static instances: MockSocket[] = [];

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
    // Open in a microtask so the CDP.connect promise can wire up listeners first.
    queueMicrotask(() => this.fire("open", {}));
  }

  addEventListener(name: string, fn: Listener, _opts?: any) {
    let s = this.listeners.get(name);
    if (!s) {
      s = new Set();
      this.listeners.set(name, s);
    }
    s.add(fn);
  }

  removeEventListener(name: string, fn: Listener) {
    this.listeners.get(name)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.fire("close", {});
  }

  /** Test-only: deliver an inbound message. */
  push(msg: object) {
    this.fire("message", { data: JSON.stringify(msg) });
  }

  /** Test-only: respond to the most recent send with id. */
  reply(result: any, errorMsg?: string) {
    const last = this.sent[this.sent.length - 1];
    if (!last || typeof last.id !== "number") throw new Error("no pending send");
    if (errorMsg) {
      this.push({ id: last.id, error: { code: -32000, message: errorMsg } });
    } else {
      this.push({ id: last.id, result });
    }
  }

  private fire(name: string, ev: any) {
    if (name === "open") this.readyState = 1;
    if (name === "close") this.readyState = 3;
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        // swallow
      }
    }
  }
}

let installed: typeof globalThis.WebSocket | null = null;

export function installMockWebSocket() {
  if (installed) return;
  installed = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = MockSocket as any;
}

export function restoreWebSocket() {
  if (installed) {
    (globalThis as any).WebSocket = installed;
    installed = null;
  }
  MockSocket.instances = [];
}

export function lastSocket(): MockSocket {
  const s = MockSocket.instances[MockSocket.instances.length - 1];
  if (!s) throw new Error("no MockSocket created yet");
  return s;
}
