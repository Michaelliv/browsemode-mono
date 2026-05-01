// Pattern #3 + #4 live demo: six-step click pipeline.
//
// Three scenarios, all driven against live obscura on :9333.
// Pages are built inline via document.body.innerHTML so we avoid
// obscura's SSRF guards on localhost / private IPs.
//
//   A. Validation: clicking a <select> returns a structured
//      validation_error rather than opening the OS dropdown.
//   B. Toggleable: clicking a checkbox returns pre/post state.
//   C. Multi-rect element: a button rendered after scrolling out of
//      view returns "off-screen → JS click fallback" without throwing.

import { Browsemode } from "../src/index.js";
import type { ElementInfo } from "../src/types.js";

function fakeEl(id: string, kind: string, name: string): ElementInfo {
  return {
    id,
    name,
    kind: kind as any,
    text: "",
    verbs: ["click"],
    selector: `document.getElementById('${id}')`,
    sessionId: "",
    role: "",
  } as any;
}

const browser = await Browsemode.connect({ id: "demo-click", port: 9333 });
const page = await browser.newPage();
const s = page.mainFrame.session;

// Build a deterministic test page. Two interactables:
// - <select> (should be refused)
// - <input type=checkbox> (should toggle)
// Plus a far-off-screen <button> (no rect inside viewport).
await s.evalJSON(`(() => {
  document.body.innerHTML = \`
    <select id=picker>
      <option value=a>A</option>
      <option value=b>B</option>
    </select>
    <input type=checkbox id=tick>
    <button id=far style="position:absolute; left:-9999px; top:-9999px">Far</button>
  \`;
  return true;
})()`);

const { ELEMENT_VERBS } = await import("../src/page/verbs/element.js");
const click = ELEMENT_VERBS.click;

// ── A. <select> rejection ──
const selectResult = await click(
  s,
  fakeEl("picker", "select", "picker"),
  undefined,
);
console.log("A. <select> click:", JSON.stringify(selectResult));

// ── B. <input type=checkbox> toggle ──
const tickResult = await click(s, fakeEl("tick", "check", "tick"), undefined);
console.log("B. <checkbox> click:", JSON.stringify(tickResult));

// ── C. Off-screen button → JS click fallback ──
const farResult = await click(s, fakeEl("far", "button", "far"), undefined);
console.log("C. Off-screen click:", JSON.stringify(farResult));

await browser.close();
