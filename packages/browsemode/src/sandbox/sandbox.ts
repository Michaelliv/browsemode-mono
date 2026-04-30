// QuickJS sandbox: runs user-supplied JS that addresses a `page` object,
// every property access of which routes back to Page.dispatch through
// the __browsemode_invoke bridge.
//
// One Sandbox per exec call (cheap to construct, isolated state). The
// Sandbox is parameterized by a `getPage()` callback so that mid-script
// `page.tabs.switch(otherPageId)` can reroute subsequent calls to a
// different Page on the same Browser.
//
// Lifted in spirit from runline's engine.ts: same __invoke bridge
// pattern, same one-arg convention, same drain-pending-jobs loop.
// Simplified — we have a single `page` plugin and the action surface is
// generated per page, refreshed by Page.dispatch after navigating verbs,
// so the sandbox doesn't need to know it.

import {
  type QuickJSDeferredPromise,
  getQuickJS,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
import type { Page } from "../page/page.js";
import type { ExecOpts, ExecuteResult } from "../types.js";
import { pageVerbNames } from "../page/verbs/page.js";
import { buildSandboxSource } from "./proxy.js";

export class Sandbox {
  /**
   * @param getPage Returns the currently-active Page. May change mid-script
   *                if the user calls page.tabs.switch.
   */
  constructor(private getPage: () => Page) {}

  async execute(code: string, opts: ExecOpts = {}): Promise<ExecuteResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const memoryLimit = opts.memoryLimitBytes ?? 64 * 1024 * 1024;
    const deadline = Date.now() + timeoutMs;
    const logs: string[] = [];
    const pending = new Set<QuickJSDeferredPromise>();

    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();

    try {
      runtime.setMemoryLimit(memoryLimit);
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
      const ctx = runtime.newContext();

      try {
        // Log bridge.
        const logFn = ctx.newFunction("__browsemode_log", (lvl, line) => {
          logs.push(`[${ctx.getString(lvl)}] ${ctx.getString(line)}`);
          return ctx.undefined;
        });
        ctx.setProp(ctx.global, "__browsemode_log", logFn);
        logFn.dispose();

        // Action bridge — every page.<...> call lands here.
        const invokeFn = ctx.newFunction(
          "__browsemode_invoke",
          (pathH, argsH) => {
            const path = ctx.getString(pathH);
            const args =
              argsH === undefined || ctx.typeof(argsH) === "undefined"
                ? undefined
                : ctx.dump(argsH);

            const deferred = ctx.newPromise();
            pending.add(deferred);
            deferred.settled.finally(() => pending.delete(deferred));

            this.getPage()
              .dispatch(path, args)
              .then(
                (val) => {
                  if (!deferred.alive) return;
                  if (val === undefined) {
                    deferred.resolve();
                    return;
                  }
                  // We marshal across the QuickJS boundary as JSON. The
                  // sandbox `__call` parses it back. Functions and other
                  // non-JSON values fall through to undefined — that's
                  // fine for our verb surface (everything verb returns is
                  // JSON-able by contract).
                  const json = JSON.stringify(val);
                  const h = ctx.newString(json);
                  deferred.resolve(h);
                  h.dispose();
                },
                (err) => {
                  if (!deferred.alive) return;
                  const msg = err instanceof Error ? err.message : String(err);
                  const h = ctx.newError(msg);
                  deferred.reject(h);
                  h.dispose();
                }
              );

            return deferred.handle;
          }
        );
        ctx.setProp(ctx.global, "__browsemode_invoke", invokeFn);
        invokeFn.dispose();

        const source = buildSandboxSource(code, pageVerbNames());

        const evaluated = ctx.evalCode(source, "browsemode-sandbox.js");
        if (evaluated.error) {
          const e = ctx.dump(evaluated.error);
          evaluated.error.dispose();
          return { result: null, error: formatError(e), logs };
        }

        // Pull the IIFE's promise out as `__browsemode_result` and read
        // its settle state via a tiny adapter object so we can poll it
        // without blocking the event loop.
        ctx.setProp(ctx.global, "__browsemode_result", evaluated.value);
        evaluated.value.dispose();

        const stateExpr = `(function(p){
          var s = { v: void 0, e: void 0, settled: false };
          var fmtErr = function(e){ if (e && typeof e==='object') {
            var m = typeof e.message==='string' ? e.message : '';
            var st = typeof e.stack==='string' ? e.stack : '';
            if (m && st) return st.indexOf(m)===-1 ? m+'\\n'+st : st;
            if (m) return m; if (st) return st; }
            return String(e); };
          p.then(function(v){ s.v=v; s.settled=true; }, function(e){ s.e=fmtErr(e); s.settled=true; });
          return s;
        })(__browsemode_result)`;
        const stateRes = ctx.evalCode(stateExpr);
        if (stateRes.error) {
          const e = ctx.dump(stateRes.error);
          stateRes.error.dispose();
          return { result: null, error: formatError(e), logs };
        }

        const stateHandle = stateRes.value;
        try {
          await drainAsync(ctx, runtime, pending, deadline, timeoutMs);
          const settled = readProp(ctx, stateHandle, "settled") === true;
          if (!settled) {
            return { result: null, error: `Timeout after ${timeoutMs}ms`, logs };
          }
          const err = readProp(ctx, stateHandle, "e");
          if (err !== undefined) {
            return { result: null, error: formatError(err), logs };
          }
          return { result: readProp(ctx, stateHandle, "v"), logs };
        } finally {
          stateHandle.dispose();
        }
      } finally {
        for (const d of pending) if (d.alive) d.dispose();
        pending.clear();
        ctx.dispose();
      }
    } catch (err) {
      return { result: null, error: formatError(err), logs };
    } finally {
      runtime.dispose();
    }
  }
}

// ── helpers ────────────────────────────────────────────

function readProp(ctx: any, handle: any, key: string): unknown {
  const p = ctx.getProp(handle, key);
  try {
    return ctx.dump(p);
  } finally {
    p.dispose();
  }
}

function formatError(c: unknown): string {
  if (c instanceof Error) return c.stack ?? c.message;
  if (
    c &&
    typeof c === "object" &&
    "message" in c &&
    typeof (c as any).message === "string"
  ) {
    return (c as any).message;
  }
  return String(c);
}

async function drainAsync(
  ctx: any,
  runtime: any,
  pending: Set<QuickJSDeferredPromise>,
  deadline: number,
  timeoutMs: number
): Promise<void> {
  drainJobs(ctx, runtime, deadline, timeoutMs);
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms`);
    let timer: any;
    try {
      await Promise.race([
        Promise.race([...pending].map((d) => d.settled)),
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`Timeout after ${timeoutMs}ms`)),
            remaining
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    drainJobs(ctx, runtime, deadline, timeoutMs);
  }
  drainJobs(ctx, runtime, deadline, timeoutMs);
}

function drainJobs(
  ctx: any,
  runtime: any,
  deadline: number,
  timeoutMs: number
): void {
  while (runtime.hasPendingJob()) {
    if (Date.now() >= deadline) throw new Error(`Timeout after ${timeoutMs}ms`);
    const j = runtime.executePendingJobs();
    if (j.error) {
      const e = ctx.dump(j.error);
      j.error.dispose();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}
