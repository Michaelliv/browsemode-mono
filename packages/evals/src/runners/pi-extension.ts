// pi-extension runner — STUB.
//
// This is where pi-the-coding-agent runs the eval task as a prompt
// with a browsemode tool extension attached. The LLM drives, the
// extension wraps SDK verbs as registerTool() calls.
//
// NOT WIRED YET.
//
// The pi-browse package shipped earlier was a placeholder; per
// project decision we're redoing that integration before committing
// to a tool surface here. Once the new pi extension lands, this
// runner becomes:
//
//   1. spawn pi --mode rpc with --extension <new-browse-extension>
//   2. send the task text as a prompt
//   3. let pi's loop drive the browser via the extension
//   4. when pi reports done, capture the final assistant message
//      as RunArtifact.output
//
// See pi's docs/rpc.md for the protocol shape:
//   /Users/michaelliv/.nvm/versions/node/v24.4.1/lib/node_modules/
//     @mariozechner/pi-coding-agent/docs/rpc.md
//
// Until the extension is reshaped, this file is a placeholder so
// the registry knows the id exists and the CLI can surface a
// clear "not implemented" instead of "no such runner".

import { type Runner, registerRunner } from "../runner.js";
import type { RunArtifact } from "../types.js";

class PiExtensionRunnerStub implements Runner {
  readonly id = "pi-extension";

  async run(): Promise<RunArtifact> {
    throw new Error(
      "pi-extension runner not wired yet. The pi-browse extension " +
        "is being redone; this runner will be implemented once the " +
        "extension's tool surface is settled.",
    );
  }
}

registerRunner(new PiExtensionRunnerStub());
