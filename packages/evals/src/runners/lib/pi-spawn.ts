// Shared helpers for spawning pi (`@mariozechner/pi-coding-agent`)
// in RPC mode. Both the runner and the LLM judge use this so they
// stay consistent on flags, system prompt, and event helpers.
//
// We deliberately strip every default surface (skills, extensions,
// prompt templates, context files, sessions) and pass the
// extension we want explicitly via `-e`. That keeps each subprocess
// hermetic: same behavior on a fresh laptop and on a developer's
// laden ~/.pi/agent/.
//
// Anthropic Claude Pro/Max OAuth (auth.json's anthropic.type=oauth)
// requires the system prompt to identify itself as "Claude Code".
// That line normally lives in your global ~/.pi/agent/AGENTS.md;
// since we strip context files for hermeticity, we inject it via
// --append-system-prompt instead.

import { existsSync } from "node:fs";
import type { PiRpcClient } from "./pi-rpc-client.js";

/**
 * Required identity line for Anthropic OAuth requests. Pi's global
 * AGENTS.md would normally provide this; we re-inject it because
 * we run with --no-context-files.
 */
export const CLAUDE_CODE_SYSTEM_PROMPT_LINE =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export interface PiSpawnOpts {
  /** Path to a single extension dir/file to load. Validated to exist. */
  extensionPath: string;
  /** Provider name (default `anthropic`). Mirrors PI_PROVIDER env. */
  provider?: string;
  /** Model id (default `claude-sonnet-4-20250514`). Mirrors PI_MODEL env. */
  model?: string;
  /** Thinking level (off|minimal|low|medium|high|xhigh). Mirrors PI_THINKING. */
  thinking?: string;
  /**
   * Extra text appended after CLAUDE_CODE_SYSTEM_PROMPT_LINE. Used
   * by the judge to add scoring instructions to the system prompt.
   */
  systemPromptSuffix?: string;
}

/**
 * Build the canonical pi RPC argv. Strips every default surface so
 * only the explicit extension is loaded.
 */
export function buildPiArgs(opts: PiSpawnOpts): string[] {
  if (!existsSync(opts.extensionPath)) {
    throw new Error(
      `pi extension not found at ${opts.extensionPath}. Override with the matching env var.`,
    );
  }
  const provider = opts.provider ?? process.env.PI_PROVIDER ?? "anthropic";
  const model =
    opts.model ?? process.env.PI_MODEL ?? "claude-sonnet-4-20250514";
  const thinking = opts.thinking ?? process.env.PI_THINKING;

  const systemPrompt = opts.systemPromptSuffix
    ? `${CLAUDE_CODE_SYSTEM_PROMPT_LINE}\n\n${opts.systemPromptSuffix}`
    : CLAUDE_CODE_SYSTEM_PROMPT_LINE;

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "-e",
    opts.extensionPath,
    "--provider",
    provider,
    "--model",
    model,
    "--append-system-prompt",
    systemPrompt,
  ];
  if (thinking) args.push("--thinking", thinking);
  return args;
}

/**
 * Wait for a specific event type on a PiRpcClient, honoring an
 * AbortSignal. Used by both the runner and the judge to wait for
 * agent_end.
 */
export function waitForEvent<T = any>(
  client: PiRpcClient,
  type: string,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = client.on((e) => {
      if (e.type === type) {
        off();
        offAbort();
        resolve(e as T);
      }
    });
    const onAbort = () => {
      off();
      offAbort();
      reject(new Error("aborted"));
    };
    const offAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Auto-cancel any extension UI dialog the spawned pi happens to
 * surface. The eval runner has no human to answer prompts; we
 * dismiss everything so a misbehaving extension can't wedge the
 * subprocess.
 */
export function autoCancelExtensionUi(client: PiRpcClient): () => void {
  return client.onExtensionUi((req) => {
    if (
      req.method === "select" ||
      req.method === "confirm" ||
      req.method === "input" ||
      req.method === "editor"
    ) {
      client.answerExtensionUi({ id: req.id, cancelled: true });
    }
  });
}
