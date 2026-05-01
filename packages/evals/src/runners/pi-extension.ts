// pi-extension runner — STUB.
//
// This is where pi-the-coding-agent runs the eval task as a prompt
// with a browsemode tool extension attached. The LLM drives, the
// extension wraps SDK verbs as registerTool() calls.
//
// NOT WIRED YET.
//
// pi-browsemode now ships a single-tool surface (execute_browsemode),
// modeled on runline. This runner will:
//
//   1. spawn pi --mode rpc with the pi-browsemode extension loaded
//   2. send the task text as a prompt
//   3. let pi's loop call execute_browsemode as needed; the browser
//      persists across calls so multi-step navigation works the
//      same way it does interactively
//   4. capture pi's final assistant message as RunArtifact.output
//
// See pi's docs/rpc.md for the wire protocol:
//   /Users/michaelliv/.nvm/versions/node/v24.4.1/lib/node_modules/
//     @mariozechner/pi-coding-agent/docs/rpc.md
//
// Implementation lands in a follow-up commit; this file stays a stub
// so the registry knows the id exists and the CLI surfaces a clear
// "not wired yet" instead of "no such runner".

import { type Runner, registerRunner } from "../runner.js";
import type { RunArtifact } from "../types.js";

class PiExtensionRunnerStub implements Runner {
  readonly id = "pi-extension";

  async run(): Promise<RunArtifact> {
    throw new Error(
      "pi-extension runner not wired yet. The pi-browsemode extension " +
        "is in place; this runner needs to spawn pi --mode rpc and " +
        "plumb prompts/responses. Coming in a follow-up commit.",
    );
  }
}

registerRunner(new PiExtensionRunnerStub());
