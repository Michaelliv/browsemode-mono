// Element verbs — click, fill, hover, etc. Each takes the element's
// Session (its frame's session) and the ElementInfo, plus optional args.
// Returns a JSON-able value.
//
// The verb table is the single source of truth for what an element
// supports. Page.dispatch consults this; the QuickJS sandbox proxy goes
// through Page.dispatch; TS callers go through Page.dispatch (or the
// sugar methods on Page that wrap it).

import type { Session } from "../../cdp/session.js";
import type { ElementInfo } from "../../types.js";
import { sendKey, typeText } from "./keyboard.js";

export type ElementVerbHandler = (
  session: Session,
  el: ElementInfo,
  args: unknown,
) => Promise<unknown>;

/**
 * Universal verbs available on every element regardless of kind.
 * Bypass the kind-based verbs-list check.
 */
export const UNIVERSAL_ELEMENT_VERBS: ReadonlySet<string> = new Set([
  "press",
  "type",
  "hover",
  "scrollIntoView",
]);

/**
 * Element verbs that may navigate the page or mutate the element catalog.
 * After a successful call to one of these, Page rescans.
 */
export const NAVIGATING_ELEMENT_VERBS: ReadonlySet<string> = new Set([
  "click",
  "submit",
  "choose",
  "press",
]);

/** Quote a string for safe inlining into a JS expression. */
function q(s: string): string {
  return JSON.stringify(s);
}

/** Where the element lives, as a JS expression eval'd in its frame session. */
function find(el: ElementInfo): string {
  return (
    el.selector ?? `document.querySelector('[data-browsemode="${el.id}"]')`
  );
}

export const ELEMENT_VERBS: Record<string, ElementVerbHandler> = {
  click: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone: ${el.name}');
      el.click();
      return { ok: true };
    })()`),

  text: async (s, el) =>
    s.evalString(`(${find(el)})?.textContent?.trim() ?? ''`),

  // Different runtimes resolve `.href` differently. Chrome returns the
  // absolute URL; obscura's V8 DOM may return the raw attribute. Resolve
  // explicitly against location.href so we always get an absolute.
  href: async (s, el) =>
    s.evalString(`(() => {
      const el = (${find(el)});
      if (!el) return '';
      const raw = el.getAttribute('href') || el.href || '';
      try { return new URL(raw, location.href).href; } catch { return raw; }
    })()`),

  value: async (s, el) => s.evalString(`(${find(el)})?.value ?? ''`),

  fill: async (s, el, args) => {
    const text = typeof args === "string" ? args : ((args as any)?.value ?? "");
    // Focus + clear via the prototype's native value setter so React's
    // value tracker sees the change.
    await s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone: ${el.name}');
      el.focus?.();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    })()`);
    if (text.length > 0) await typeText(s, text);
    return { ok: true };
  },

  clear: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.focus?.();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`),

  focus: async (s, el) =>
    s.evalJSON(`(() => { (${find(el)})?.focus?.(); return { ok: true }; })()`),

  // Synthetic mouseover/mouseenter so hover-triggered menus open.
  // Doesn't simulate a real cursor (no Input.dispatchMouseEvent because
  // we'd need bounding-rect coords obscura can't supply), but most
  // hover handlers listen for the events themselves.
  hover: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      for (const t of ['mouseover', 'mouseenter', 'pointerenter', 'pointerover']) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return { ok: true };
    })()`),

  scrollIntoView: async (s, el) =>
    s.evalJSON(`(() => {
      (${find(el)})?.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { ok: true };
    })()`),

  press: async (s, el, args) => {
    const key = typeof args === "string" ? args : (args as any)?.key;
    if (!key) throw new Error(`${el.name}.press: pass a key string`);
    await s.evalJSON(`(${find(el)})?.focus?.()`);
    await sendKey(s, key);
    return { ok: true };
  },

  // Like fill but doesn't clear first. Simulates real typing.
  type: async (s, el, args) => {
    const text = typeof args === "string" ? args : ((args as any)?.text ?? "");
    await s.evalJSON(`(${find(el)})?.focus?.()`);
    await typeText(s, text);
    return { ok: true };
  },

  check: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { checked: el.checked };
    })()`),

  uncheck: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { checked: el.checked };
    })()`),

  toggle: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.checked = !el.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { checked: el.checked };
    })()`),

  isChecked: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      return !!(el && el.checked);
    })()`),

  select: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: !!el.checked };
    })()`),

  isSelected: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      return { selected: !!el.checked };
    })()`),

  choose: async (s, el, args) => {
    const v = typeof args === "string" ? args : ((args as any)?.value ?? "");
    return s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Element gone');
      el.value = ${q(v)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: el.value };
    })()`);
  },

  options: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) return [];
      return Array.from(el.options || []).map(o => ({ value: o.value, label: o.textContent.trim() }));
    })()`),

  submit: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) throw new Error('Form gone');
      el.submit?.() ?? el.requestSubmit?.();
      return { ok: true };
    })()`),

  fields: async (s, el) =>
    s.evalJSON(`(() => {
      const el = (${find(el)});
      if (!el) return [];
      return Array.from(el.elements || []).map(f => ({
        name: f.name || f.id || '',
        type: f.type || f.tagName.toLowerCase(),
        value: f.value || '',
      }));
    })()`),
};

export function assertElementVerb(el: ElementInfo, verb: string): void {
  if (UNIVERSAL_ELEMENT_VERBS.has(verb)) return;
  if (el.verbs.includes(verb)) return;
  throw new Error(
    `${el.name}: verb '${verb}' not supported. Available: ${el.verbs.join(", ")}, ` +
      `${[...UNIVERSAL_ELEMENT_VERBS].join(", ")}`,
  );
}
