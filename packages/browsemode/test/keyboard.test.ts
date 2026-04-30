import { describe, expect, it, mock } from "bun:test";
import { KEY_MAP, sendKey, typeText } from "../src/page/verbs/keyboard.js";

function fakeSession() {
  const calls: Array<{ method: string; params: any }> = [];
  return {
    calls,
    async send(method: string, params: any) {
      calls.push({ method, params });
      // Simulate Input.insertText being unsupported on obscura — only
      // tests that explicitly want this can monkey-patch.
      if (method === "Input.insertText") return {};
      return {};
    },
  } as any;
}

describe("KEY_MAP", () => {
  it("includes the canonical named keys", () => {
    for (const k of [
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Space",
    ]) {
      expect(KEY_MAP[k]).toBeDefined();
      expect(KEY_MAP[k].key).toBeDefined();
      expect(KEY_MAP[k].code).toBeDefined();
    }
  });

  it("Enter has a Windows virtual key code (so editing actions fire)", () => {
    expect(KEY_MAP.Enter.windowsVirtualKeyCode).toBe(13);
  });
});

describe("typeText", () => {
  it("uses Input.insertText when supported", async () => {
    const s = fakeSession();
    await typeText(s, "hi");
    const methods = s.calls.map((c: any) => c.method);
    expect(methods).toContain("Input.insertText");
    expect(s.calls.find((c: any) => c.method === "Input.insertText")?.params).toEqual({
      text: "hi",
    });
  });

  it("falls back to per-char dispatchKeyEvent if insertText throws", async () => {
    const s: any = {
      calls: [] as any[],
      async send(method: string, params: any) {
        if (method === "Input.insertText") throw new Error("not supported");
        s.calls.push({ method, params });
        return {};
      },
    };
    await typeText(s, "ab");
    const types = s.calls.map((c: any) => c.params.type).filter(Boolean);
    // 4 events: keyDown a, keyUp a, keyDown b, keyUp b
    expect(types.filter((t: string) => t === "keyDown")).toHaveLength(2);
    expect(types.filter((t: string) => t === "keyUp")).toHaveLength(2);
  });

  it("noop on empty string", async () => {
    const s = fakeSession();
    await typeText(s, "");
    expect(s.calls).toHaveLength(0);
  });
});

describe("sendKey", () => {
  it("dispatches a keyDown + keyUp pair", async () => {
    const s = fakeSession();
    await sendKey(s, "Enter");
    const types = s.calls.map((c: any) => c.params.type);
    expect(types).toEqual(["keyDown", "keyUp"]);
  });

  it("uses KEY_MAP entry for named keys", async () => {
    const s = fakeSession();
    await sendKey(s, "Enter");
    expect(s.calls[0].params.key).toBe("Enter");
    expect(s.calls[0].params.windowsVirtualKeyCode).toBe(13);
  });

  it("infers params for a single character", async () => {
    const s = fakeSession();
    await sendKey(s, "x");
    expect(s.calls[0].params.key).toBe("x");
    expect(s.calls[0].params.code).toBe("KeyX");
    expect(s.calls[0].params.text).toBe("x");
  });
});
