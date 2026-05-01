// Pattern #1 live demo: per-call CDP timeout with informative error.
//
// Phase 1: against real obscura — prove normal calls work fast.
// Phase 2: against a deaf mock CDP that accepts connections but never
//   replies (the exact "TCP alive, server dead" failure mode this
//   pattern guards against). Prove the new timeout error fires with
//   the actionable message browser-use's TimeoutWrappedCDPClient
//   surfaces.

import { CDP } from "../src/cdp/client.js";

// ── Phase 1: real obscura on :9333 ──
{
  const probe = await fetch("http://localhost:9333/json/version").then((r) =>
    r.json(),
  );
  const cdp = await CDP.connect(probe.webSocketDebuggerUrl);
  const t0 = Date.now();
  const r = await cdp.send("Target.getTargets", {});
  console.log(
    `✓ obscura ${probe.Browser} responded in ${Date.now() - t0}ms (${r.targetInfos?.length ?? 0} targets)`,
  );
  cdp.close();
}

// ── Phase 2: deaf mock CDP — accepts WS, never replies ──
const deaf = Bun.serve({
  port: 19555,
  fetch(req, server) {
    if (server.upgrade(req)) return; // drop the request, never reply
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(_ws) {
      // Intentionally do nothing. Every send() into this server will hang.
    },
    message(_ws, _msg) {
      // Drop every message on the floor. This is the "dead container,
      // alive proxy" failure mode in production.
    },
  },
});

const cdp = await CDP.connect(`ws://localhost:${deaf.port}/devtools/browser`);
console.log(`✓ connected to deaf mock at :${deaf.port}`);

const t0 = Date.now();
try {
  await cdp.send("Target.getTargets", {}, undefined, { timeoutMs: 250 });
  console.log("UNEXPECTED: send succeeded");
} catch (e: any) {
  console.log(`✓ rejected after ${Date.now() - t0}ms:`);
  console.log(`   ${e.message}`);
}

cdp.close();
deaf.stop();
