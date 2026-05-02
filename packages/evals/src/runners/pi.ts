// Pi runner. Spawns `@mariozechner/pi-coding-agent` in RPC mode
// loaded with only the pi-browsemode extension; the model drives
// the browser via execute_browsemode tool calls and we capture the
// final assistant message as the artifact.
//
// Configuration via env so the eval CLI doesn't need flags for
// every knob:
//
//   PI_BIN                       which pi binary to spawn (default "pi")
//   PI_PROVIDER                  default "anthropic"
//   PI_MODEL                     default "claude-sonnet-4-20250514"
//   PI_THINKING                  off | minimal | low | medium | high
//   PI_BROWSEMODE_EXT_PATH       absolute path to the extension dir;
//                                defaults to packages/pi-browsemode/.pi/extensions/browsemode
//   BROWSEMODE_EVALS_PI_LOG      when set, write per-task pi event
//                                stream to this directory for replay

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Runner, type RunnerContext, registerRunner } from "../runner.js";
import type { RunArtifact } from "../types.js";
import { PiRpcClient } from "./lib/pi-rpc-client.js";
import {
  autoCancelExtensionUi,
  buildPiArgs,
  waitForEvent,
} from "./lib/pi-spawn.js";

function defaultBrowsemodeExtPath(): string {
  // packages/evals/src/runners/pi.ts
  //  -> packages/pi-browsemode/.pi/extensions/browsemode
  const here = fileURLToPath(import.meta.url);
  return resolve(
    dirname(here),
    "..",
    "..",
    "..",
    "pi-browsemode",
    ".pi",
    "extensions",
    "browsemode",
  );
}

class PiRunner implements Runner {
  readonly id = "pi";
  // The spawned pi subprocess (via pi-browsemode) opens its own
  // browser inside the extension; the orchestrator's pre-opened
  // handle would be a separate Browser instance that the agent
  // never sees. Tell the orchestrator to skip that open.
  readonly ownsBrowser = true;

  async run(ctx: RunnerContext): Promise<RunArtifact> {
    const start = Date.now();

    const extPath =
      process.env.PI_BROWSEMODE_EXT_PATH ?? defaultBrowsemodeExtPath();
    const args = buildPiArgs({ extensionPath: extPath });

    // Browser id is per-task so concurrent runs don't fight over
    // the same snapshot file. The pi-browsemode extension reads
    // PI_BROWSE_BROWSER_ID at session_start.
    const browserId = `eval-${ctx.task.name}-${ctx.backend}`.slice(0, 60);

    const client = new PiRpcClient({
      bin: process.env.PI_BIN ?? "pi",
      args,
      env: {
        PI_BROWSE_BROWSER_ID: browserId,
        // Tell the extension which backend the orchestrator picked
        // so chrome-only tasks force the chrome path even when an
        // obscura is running on the configured port.
        PI_BROWSE_BACKEND: ctx.backend,
        PI_BROWSE_OBSCURA_PORT:
          process.env.PI_BROWSE_OBSCURA_PORT ?? String(9333),
      },
    });

    // Capture the event stream so we can write a trace and produce
    // RunArtifact.steps.
    const steps: Array<{ kind: string; detail?: string }> = [];
    const events: any[] = [];
    let finalText: string | null = null;
    let agentError: string | null = null;

    client.on((e) => {
      events.push(e);
      switch (e.type) {
        case "tool_execution_start":
          steps.push({
            kind: `tool:${e.toolName}:start`,
            detail:
              e.toolName === "execute_browsemode"
                ? clip(e.args?.code)
                : undefined,
          });
          break;
        case "tool_execution_end":
          steps.push({
            kind: `tool:${e.toolName}:end`,
            detail: clip(extractText(e.result?.content)),
          });
          break;
        case "message_end":
        case "turn_end": {
          const msg = e.message;
          if (msg?.role === "assistant" && msg.errorMessage) {
            agentError = msg.errorMessage;
          }
          break;
        }
        case "extension_error":
          steps.push({
            kind: "extension_error",
            detail: `${e.extensionPath}: ${e.error}`,
          });
          break;
      }
    });

    autoCancelExtensionUi(client);

    // Honor the orchestrator-level abort signal (per-task timeout).
    const onAbort = () => {
      client.send("abort").catch(() => undefined);
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });

    let truncated = false;

    try {
      const taskPrompt = buildTaskPrompt(ctx);
      const agentEndPromise = waitForEvent<any>(
        client,
        "agent_end",
        ctx.signal,
      );
      await client.send("prompt", { message: taskPrompt });
      const agentEnd = await agentEndPromise;
      const lastMessage = Array.isArray(agentEnd?.messages)
        ? agentEnd.messages[agentEnd.messages.length - 1]
        : null;
      if (lastMessage?.role === "assistant" && lastMessage.errorMessage) {
        agentError = lastMessage.errorMessage;
      }
      if (agentError) throw new Error(`pi agent failed: ${agentError}`);

      const last = await client
        .send<{ text: string | null }>("get_last_assistant_text")
        .catch(() => ({ text: null }));
      finalText = last?.text ?? null;
    } catch (err: any) {
      truncated = ctx.signal.aborted;
      if (!ctx.signal.aborted) {
        const stderr = client.stderrText();
        throw new Error(
          `${err?.message ?? err}${stderr ? `\nstderr:\n${stderr.slice(-1000)}` : ""}`,
        );
      }
    } finally {
      await client.close();
    }

    // Optional event-stream dump for offline replay/debug.
    const logDir = process.env.BROWSEMODE_EVALS_PI_LOG;
    if (logDir) {
      try {
        mkdirSync(logDir, { recursive: true });
        const f = join(
          logDir,
          `${ctx.task.name}.${ctx.backend}.${Date.now()}.jsonl`,
        );
        writeFileSync(
          f,
          `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
        );
      } catch {
        // Logging is best-effort.
      }
    }

    return {
      output: finalText ?? "",
      steps,
      truncated,
      elapsedMs: Date.now() - start,
      meta: {
        provider: process.env.PI_PROVIDER ?? "anthropic",
        model: process.env.PI_MODEL ?? "claude-sonnet-4-20250514",
        thinking: process.env.PI_THINKING,
        browserId,
        eventCount: events.length,
      },
    };
  }
}

function buildTaskPrompt(ctx: RunnerContext): string {
  const lines = [
    "You're being evaluated on a real browser task. Use the `execute_browsemode` tool to drive the browser. The browser starts at about:blank.",
    "",
    "Task:",
    ctx.task.task,
    "",
  ];
  if (ctx.task.url) {
    lines.push(
      `Start by navigating to ${ctx.task.url} (the browser is currently on about:blank).`,
    );
    lines.push("");
  }
  lines.push(
    "How to reply:",
    "- Use `execute_browsemode` for ALL browser actions. Do NOT use bash, fetch, or other tools for browsing.",
    "- In your final reply, include (a) the source URL you read from, and (b) a short verbatim quote from page.markdown() or page.html() that supports your answer. Cite your work like a journalist; the grader needs evidence the answer came from the page, not from prior knowledge.",
    "- If you cannot find the requested information, say so plainly (\"I could not find X on this site\"). Do NOT substitute a different topic. Do NOT fill in plausible-sounding details. An honest 'not found' is correct when the page doesn't have it.",
    "- Never invent URLs, dates, names, prices, or quotes. If you didn't observe it through a `page.*` call this session, don't put it in your answer.",
  );
  return lines.join("\n");
}

function extractText(content: any): string | undefined {
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
  }
  return undefined;
}

function clip(s: string | undefined, max = 200): string | undefined {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

registerRunner(new PiRunner());
