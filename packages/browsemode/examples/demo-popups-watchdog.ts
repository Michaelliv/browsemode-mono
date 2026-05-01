// Pattern #7 + #12 live demo: popups watchdog + watchdog scaffold.
//
// Two interesting findings against live obscura on :9333:
//
// 1. Obscura defines window.alert / confirm / prompt as functions
//    but they're no-ops that return undefined and DO NOT emit
//    Page.javascriptDialogOpening. So obscura users don't have the
//    "agent stalled on alert" failure mode at all — one less footgun
//    in the obscura column of the README.
//
// 2. The watchdog still attaches cleanly through the Browsemode
//    flow against obscura, proving the scaffold integrates.
//    Verifying the actual dispatch (Page.handleJavaScriptDialog
//    fired with accept=true for alert/confirm, accept=false for
//    prompt) happens in the unit test against FakeCDP, where we
//    fully control which CDP events arrive.

import { Bus } from "../src/bus.js";
import { Browsemode } from "../src/index.js";

// Pre-create the bus so we can subscribe BEFORE connect() emits the
// watchdog.attached event during installation.
const bus = new Bus();

const events: string[] = [];
bus.on("watchdog.attached", (e) => events.push(`+ ${e.name}`));
bus.on("watchdog.detached", (e) => events.push(`- ${e.name}`));
bus.on("page.created", () => events.push("page.created"));
bus.on("dialog.handled", (e) =>
  events.push(`dialog ${e.type} accepted=${e.accepted} msg=${e.message}`),
);

const browser = await Browsemode.connect({
  id: "demo-popups",
  port: 9333,
  bus,
});

const page = await browser.newPage();

// Run all three dialog kinds. Without the watchdog scaffold this
// would be the place where Chrome would hang waiting for
// Page.handleJavaScriptDialog. Against obscura, alert/confirm/prompt
// are no-ops, so this just races through.
const t0 = Date.now();
await page.mainFrame.session.evalString("alert('a')");
await page.mainFrame.session.evalString("confirm('c')");
await page.mainFrame.session.evalString("prompt('p')");
const elapsed = Date.now() - t0;

await browser.close();

console.log(`✓ obscura ran three dialog calls in ${elapsed}ms (no hang)`);
console.log("✓ bus events captured:");
for (const e of events) console.log(`   ${e}`);
console.log("");
console.log(
  "obscura no-ops alert/confirm/prompt — one less failure mode than Chrome.",
);
console.log("Watchdog dispatch verified in test/popups.test.ts (FakeCDP).");
