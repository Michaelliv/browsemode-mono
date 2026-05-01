// Minimal pi RPC client.
//
// Spawns `pi --mode rpc ...`, framed JSONL on stdin/stdout. We talk
// to it as a subprocess instead of using `AgentSession` from the
// SDK so we get full control over flags (--no-extensions etc.) and
// any auth flow (Anthropic OAuth via ~/.pi/agent/auth.json) just
// works the same way it does in interactive pi.
//
// Implementation notes worth keeping:
//
//   - JSONL framing is strict LF; we strip a trailing CR for
//     Windows-friendliness but split only on \n. Per pi's rpc.md,
//     Node's `readline` is NOT compliant because it also splits on
//     U+2028/9 which can appear inside JSON strings.
//   - Pi emits `response` for command replies and `event` JSON for
//     streaming. We correlate responses by request id; events are
//     fanned out via .on().
//   - Process-level errors (spawn failure, unexpected exit) are
//     surfaced through .on("exit", ...). Any in-flight requests
//     reject when the process dies.

import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface PiRpcOptions {
  /** Command name. Default "pi". */
  bin?: string;
  /**
   * Full args list. The runner is responsible for including
   * `--mode rpc` (or whatever flag triggers JSONL stdio) plus any
   * other CLI flags. Keeping this field flat lets us point the
   * client at non-pi binaries in tests.
   */
  args?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Env overrides. */
  env?: NodeJS.ProcessEnv;
}

export interface PiResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

type AnyEvent = { type: string; [k: string]: any };

interface PendingResponse {
  resolve: (r: PiResponse) => void;
  reject: (e: Error) => void;
}

export class PiRpcClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<string, PendingResponse>();
  private listeners = new Set<(e: AnyEvent) => void>();
  private extensionUiHandlers = new Set<(e: AnyEvent) => void>();
  private exited = false;
  private exitCode: number | null = null;
  private exitListeners = new Set<(code: number | null) => void>();
  private stderr: string[] = [];

  constructor(opts: PiRpcOptions = {}) {
    const bin = opts.bin ?? "pi";
    const args = opts.args ?? ["--mode", "rpc"];
    this.proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (this.proc.stdout) this.attachJsonlReader(this.proc.stdout);
    if (this.proc.stderr) {
      const dec = new StringDecoder("utf8");
      this.proc.stderr.on("data", (chunk: Buffer | string) => {
        this.stderr.push(typeof chunk === "string" ? chunk : dec.write(chunk));
      });
    }
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      const err = new Error(
        `pi rpc subprocess exited (${code}). stderr: ${this.stderr.join("").slice(-500)}`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const fn of this.exitListeners) fn(code);
    });
  }

  // ── Public API ──

  /** Send a command and wait for its matching `response`. */
  async send<T = any>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.exited) {
      throw new Error(`pi rpc subprocess already exited (${this.exitCode})`);
    }
    const id = `r${this.nextId++}`;
    const msg = { id, type: command, ...payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          if (!r.success) {
            reject(
              new Error(
                `pi rpc '${command}' failed: ${r.error ?? "(no error msg)"}`,
              ),
            );
            return;
          }
          resolve(r.data as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin?.write(`${JSON.stringify(msg)}\n`);
    });
  }

  /** Subscribe to streaming events. Returns an unsubscribe fn. */
  on(handler: (e: AnyEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Subscribe to extension_ui_request messages so the caller can
   * answer dialogs (select / confirm / input / editor).
   */
  onExtensionUi(handler: (e: AnyEvent) => void): () => void {
    this.extensionUiHandlers.add(handler);
    return () => this.extensionUiHandlers.delete(handler);
  }

  /** Reply to an extension_ui_request with the matching id. */
  answerExtensionUi(reply: { id: string; [k: string]: unknown }): void {
    const msg = { type: "extension_ui_response", ...reply };
    this.proc.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  /** Wait for the subprocess to exit. */
  async waitForExit(): Promise<number | null> {
    if (this.exited) return this.exitCode;
    return new Promise((resolve) => {
      this.exitListeners.add(resolve);
    });
  }

  /** Tear down. Closes stdin which is the documented graceful exit. */
  async close(): Promise<void> {
    if (this.exited) return;
    try {
      this.proc.stdin?.end();
    } catch {
      // ignore
    }
    // Best-effort soft kill if it doesn't exit on its own.
    const timer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }, 2_000);
    await this.waitForExit();
    clearTimeout(timer);
  }

  /** Diagnostic: stderr accumulated since spawn. */
  stderrText(): string {
    return this.stderr.join("");
  }

  // ── Internal ──

  private attachJsonlReader(stream: NodeJS.ReadableStream) {
    const dec = new StringDecoder("utf8");
    let buf = "";
    stream.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : dec.write(chunk);
      while (true) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line) continue;
        this.handleLine(line);
      }
    });
    stream.on("end", () => {
      buf += dec.end();
      if (buf.trim()) this.handleLine(buf);
    });
  }

  private handleLine(line: string) {
    let msg: AnyEvent;
    try {
      msg = JSON.parse(line);
    } catch {
      // Pi shouldn't emit non-JSON; swallow defensively.
      return;
    }
    if (msg.type === "response") {
      const id = (msg as PiResponse).id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        p?.resolve(msg as PiResponse);
      }
      return;
    }
    if (msg.type === "extension_ui_request") {
      for (const h of this.extensionUiHandlers) h(msg);
      return;
    }
    for (const h of this.listeners) h(msg);
  }
}
