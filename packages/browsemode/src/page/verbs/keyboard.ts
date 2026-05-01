// Portable keyboard input across Chrome and obscura.
//
// obscura's `Input.dispatchKeyEvent` appends `text` to the active input
// on keyDown; Chrome doesn't and needs a separate `Input.insertText`. We
// try Input.insertText first and fall back to per-char dispatchKeyEvent
// so the same code works on both runtimes.
//
// `windowsVirtualKeyCode` matters for Chrome — without it the synthetic
// event doesn't trigger the default editing action (Backspace deleting,
// Enter submitting a form, ...). Named keys get explicit codes; ad-hoc
// single-character keys get inferred ones.

import type { Session } from "../../cdp/session.js";

export interface KeyParams {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
}

export const KEY_MAP: Record<string, KeyParams> = {
  Enter: { key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
};

// Per-session memo: once we've seen Input.insertText fail on a session,
// don't try it again. Keeps the fallback path fast on obscura.
const insertTextSupport = new WeakMap<Session, boolean>();

export async function typeText(session: Session, text: string): Promise<void> {
  if (!text) return;
  if (insertTextSupport.get(session) !== false) {
    try {
      await session.send("Input.insertText", { text });
      insertTextSupport.set(session, true);
      return;
    } catch {
      insertTextSupport.set(session, false);
    }
  }
  for (const ch of text) {
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: ch,
      code: ch.match(/[a-zA-Z]/) ? `Key${ch.toUpperCase()}` : "",
      text: ch,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: ch,
      code: "",
    });
  }
}

export async function sendKey(session: Session, key: string): Promise<void> {
  const mapped = KEY_MAP[key];
  const params: KeyParams = mapped
    ? mapped
    : {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        text: key.length === 1 ? key : "",
        windowsVirtualKeyCode:
          key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
      };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: params.key,
    code: params.code,
    windowsVirtualKeyCode: params.windowsVirtualKeyCode,
  });
}
