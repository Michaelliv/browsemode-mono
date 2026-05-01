// Pattern #3 + #4: six-step click pipeline.
//
// Branches verified:
//   - <select> and <input type=file> return validation_error (no exception)
//   - Element gone (selector resolves to null) throws Element gone
//   - Toggleable: pre/post `checked` returned + toggled flag
//   - No layout engine (hasElementFromPoint=false) → js-click-no-layout
//   - Occluded (elementFromPoint != target) → js-click-occluded
//   - No visible rect → js-click-no-rect
//   - Happy path → cdp-mouse with 3 Input.dispatchMouseEvent calls

import { describe, expect, it } from "bun:test";
import { Session } from "../src/cdp/session.js";
import { ELEMENT_VERBS } from "../src/page/verbs/element.js";
import { asCdp, FakeCDP } from "./fixtures/fake-cdp.js";

const click = ELEMENT_VERBS.click;

const EL = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "x",
    name: "btn",
    kind: "button",
    text: "",
    verbs: ["click"],
    selector: "document.getElementById('x')",
    sessionId: "S1",
    ...overrides,
  }) as any;

/** Make a Session backed by a FakeCDP that returns a scripted plan. */
function setup(plan: unknown, postCheckedValue: boolean | null = null) {
  const fake = new FakeCDP();
  // First Runtime.evaluate is the planning call. If `plan` declares the
  // element is a toggle and we want to verify pre/post, the second
  // Runtime.evaluate is the post-check that reads `el.checked`.
  const evals: Array<(p: any, s?: string) => any> = [
    () => ({ result: { value: plan } }),
    () => ({ result: { value: postCheckedValue } }),
    () => ({ result: { value: postCheckedValue } }),
    () => ({ result: { value: postCheckedValue } }),
  ];
  fake.setHandler("Runtime.evaluate", (p, s) => {
    const fn = evals.shift();
    return fn ? fn(p, s) : { result: { value: null } };
  });
  fake.setHandler("Input.dispatchMouseEvent", () => ({}));
  const session = new Session(asCdp(fake), "S1");
  return { fake, session };
}

describe("click pipeline (pattern #3 + #4)", () => {
  it("validation_error for <select>", async () => {
    const { fake, session } = setup({
      validation_error:
        "use picker.choose(value) for <select>; click would open the OS dropdown",
    });
    const r = (await click(session, EL({ name: "picker" }), undefined)) as any;
    expect(r.validation_error).toContain("choose");
    expect(r.validation_error).toContain("<select>");
    expect(fake.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("validation_error for <input type=file>", async () => {
    const { fake, session } = setup({
      validation_error:
        "use picker.upload(path) for <input type=file>; click is a no-op",
    });
    const r = (await click(
      session,
      EL({ name: "fileInput" }),
      undefined,
    )) as any;
    expect(r.validation_error).toContain("upload");
    expect(fake.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("element gone (selector resolves to null)", async () => {
    const { session } = setup({ error: "gone" });
    await expect(click(session, EL(), undefined)).rejects.toThrow(
      /Element gone/i,
    );
  });

  it("no rect → js-click fallback (no Input.dispatchMouseEvent)", async () => {
    const { fake, session } = setup({ error: "no_rect" });
    const r = (await click(session, EL(), undefined)) as any;
    expect(r.via).toBe("js-click-no-rect");
    expect(fake.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("no layout engine (hasElementFromPoint=false) → js-click-no-layout", async () => {
    // This is the obscura case: a fully formed plan is returned but
    // the runtime can't actually execute mouse dispatch usefully.
    const { fake, session } = setup({
      x: 50,
      y: 50,
      isToggle: false,
      preClickChecked: null,
      occluded: false,
      hasElementFromPoint: false,
    });
    const r = (await click(session, EL(), undefined)) as any;
    expect(r.via).toBe("js-click-no-layout");
    // Crucially: zero Input.dispatchMouseEvent calls. Pattern #3's
    // CDP path is gated on a real layout engine being present.
    expect(fake.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("occluded → js-click-occluded (still no CDP mouse)", async () => {
    const { fake, session } = setup({
      x: 50,
      y: 50,
      isToggle: false,
      preClickChecked: null,
      occluded: true,
      hasElementFromPoint: true,
    });
    const r = (await click(session, EL(), undefined)) as any;
    expect(r.via).toBe("js-click-occluded");
    // Bypassing pointer events ⇒ no CDP mouse.
    expect(fake.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("happy path → 3 Input.dispatchMouseEvent calls in order", async () => {
    const { fake, session } = setup({
      x: 100,
      y: 200,
      isToggle: false,
      preClickChecked: null,
      occluded: false,
      hasElementFromPoint: true,
    });
    const r = (await click(session, EL(), undefined)) as any;
    expect(r.via).toBe("cdp-mouse");
    expect(r.x).toBe(100);
    expect(r.y).toBe(200);
    const mouseCalls = fake.callsFor("Input.dispatchMouseEvent");
    expect(mouseCalls.map((c) => c.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    // Coords identical across the three events (single-click).
    expect(
      mouseCalls.every((c) => c.params.x === 100 && c.params.y === 200),
    ).toBe(true);
    // mousePressed/Released specify left button + clickCount=1.
    expect(mouseCalls[1].params.button).toBe("left");
    expect(mouseCalls[1].params.clickCount).toBe(1);
    expect(mouseCalls[2].params.button).toBe("left");
  });

  it("toggleable element: pre/post checked + toggled flag (cdp path)", async () => {
    const { session } = setup(
      {
        x: 10,
        y: 20,
        isToggle: true,
        preClickChecked: false,
        occluded: false,
        hasElementFromPoint: true,
      },
      true, // post-click value
    );
    const r = (await click(session, EL({ kind: "check" }), undefined)) as any;
    expect(r.preClickChecked).toBe(false);
    expect(r.postClickChecked).toBe(true);
    expect(r.toggled).toBe(true);
  });

  it("toggleable element: no-layout fallback also surfaces toggle state", async () => {
    const { session } = setup(
      {
        x: 10,
        y: 20,
        isToggle: true,
        preClickChecked: false,
        occluded: false,
        hasElementFromPoint: false,
      },
      true,
    );
    const r = (await click(session, EL({ kind: "check" }), undefined)) as any;
    expect(r.via).toBe("js-click-no-layout");
    expect(r.preClickChecked).toBe(false);
    expect(r.postClickChecked).toBe(true);
    expect(r.toggled).toBe(true);
  });
});
