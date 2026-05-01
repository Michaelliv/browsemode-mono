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

/**
 * Six-step click pipeline ported from browser-use's
 * _click_element_node_impl. The naive `el.click()` call works for
 * most cases but fails in three real ways:
 *
 *   1. <select> and <input type=file> need their own dispatch (choose,
 *      upload). Calling .click() on them either no-ops (file input)
 *      or opens the OS-level dropdown that we can't dismiss.
 *   2. Elements with multiple bounding rects (a long anchor that
 *      wraps across lines) get a click that lands on whichever rect
 *      .click() resolves to first — often the off-screen one.
 *   3. Elements covered by a higher-z-index overlay (cookie banners,
 *      modals) get "clicked" via .click() but the user never sees the
 *      handler fire because pointer events go to the cover. Real CDP
 *      mouse dispatch would also miss; here we fall back to JS click
 *      which bypasses pointer-events.
 *
 * The pipeline (one Runtime.evaluate to gather state, then either
 * three Input.dispatchMouseEvent calls or one JS .click() fallback):
 *
 *   1. Refuse <select> and <input type=file> with a structured
 *      validation_error result (no exception, easier for agents).
 *   2. Capture pre-click `checked` for toggleables so the result can
 *      surface whether the click actually toggled.
 *   3. scrollIntoView({block:'center'}) and settle.
 *   4. Get every getClientRects() entry, pick the one with the
 *      largest area visible inside the viewport (Pattern #4).
 *   5. Clamp the click point inside the viewport (off-screen clicks
 *      are rejected by Chrome).
 *   6. Occlusion check via elementFromPoint when available
 *      (graceful no-op on obscura which doesn't implement it).
 *   7. Either CDP-level mouse dispatch (mouseMoved, mousePressed,
 *      mouseReleased — each with its own timeout) or JS .click()
 *      fallback when occluded.
 */
async function clickPipeline(
  s: Session,
  el: ElementInfo,
  _args: unknown,
): Promise<unknown> {
  // ── Step 1–6: gather plan in one round trip ──
  const plan = (await s.evalJSON(`(() => {
    const el = (${find(el)});
    if (!el) return { error: 'gone' };
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    if (tag === 'select') {
      return { validation_error: 'use ' + ${q(el.name)} + '.choose(value) for <select>; click would open the OS dropdown' };
    }
    if (tag === 'input' && type === 'file') {
      return { validation_error: 'use ' + ${q(el.name)} + '.upload(path) for <input type=file>; click is a no-op' };
    }
    const isToggle = tag === 'input' && (type === 'checkbox' || type === 'radio');
    const preClickChecked = isToggle ? !!el.checked : null;

    // Step 3: scrollIntoView. settle is done on the TS side after this returns.
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {}

    // Step 4: pick the largest visible rect.
    const rects = el.getClientRects ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let bestRect = null;
    let bestArea = 0;
    for (const r of rects) {
      if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      const visW = Math.min(vw, r.right) - Math.max(0, r.left);
      const visH = Math.min(vh, r.bottom) - Math.max(0, r.top);
      const area = visW * visH;
      if (area > bestArea) { bestArea = area; bestRect = r; }
    }
    if (!bestRect && rects.length) bestRect = rects[0];
    if (!bestRect) return { error: 'no_rect' };

    // Step 5: clamp center to viewport.
    let cx = (bestRect.left + bestRect.right) / 2;
    let cy = (bestRect.top + bestRect.bottom) / 2;
    cx = Math.max(0, Math.min(vw - 1, cx));
    cy = Math.max(0, Math.min(vh - 1, cy));

    // Step 6: occlusion check, graceful when elementFromPoint is
    // unavailable (obscura V8 doesn't ship it).
    let occluded = false;
    if (typeof document.elementFromPoint === 'function') {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        occluded = true;
      }
    }

    return {
      x: cx,
      y: cy,
      isToggle,
      preClickChecked,
      occluded,
      hasElementFromPoint: typeof document.elementFromPoint === 'function',
    };
  })()`)) as any;

  if (plan?.error === "gone") {
    throw new Error(`Element gone: ${el.name}`);
  }
  if (plan?.validation_error) {
    return { validation_error: plan.validation_error };
  }
  if (plan?.error === "no_rect") {
    // Off-screen and unscrollable to: fall back to JS .click().
    await s.evalJSON(`(${find(el)})?.click?.()`);
    return { ok: true, via: "js-click-no-rect" };
  }

  // 50ms scroll settle (Step 3). Browser-use uses the same number.
  await new Promise((r) => setTimeout(r, 50));

  // Pattern #3 caveat discovered against obscura: when the runtime
  // doesn't ship document.elementFromPoint, it also doesn't have a
  // real layout engine, so Input.dispatchMouseEvent at any coordinate
  // is a no-op (no painted elements to hit). Same signal, same
  // mitigation: skip the CDP mouse path and use JS .click(). Real
  // Chrome / Edge / Brave all return hasElementFromPoint=true and
  // get the full CDP dispatch.
  if (!plan.hasElementFromPoint) {
    await s.evalJSON(`(${find(el)})?.click?.()`);
    const result: any = { ok: true, via: "js-click-no-layout" };
    if (plan.isToggle) {
      const post = await s.evalJSON(`(() => {
        const el = (${find(el)});
        return el ? !!el.checked : null;
      })()`);
      result.preClickChecked = plan.preClickChecked;
      result.postClickChecked = post;
      result.toggled = plan.preClickChecked !== post;
    }
    return result;
  }

  // Step 7a: occluded → JS click (bypasses pointer-events).
  if (plan.occluded) {
    await s.evalJSON(`(${find(el)})?.click?.()`);
    const result: any = { ok: true, via: "js-click-occluded" };
    if (plan.isToggle) {
      const post = await s.evalJSON(`(() => {
        const el = (${find(el)});
        return el ? !!el.checked : null;
      })()`);
      result.preClickChecked = plan.preClickChecked;
      result.postClickChecked = post;
      result.toggled = plan.preClickChecked !== post;
    }
    return result;
  }

  // Step 7b: CDP mouse dispatch. Three calls, each with its own short
  // timeout. Failure modes: a confirm() opening between mousePressed
  // and mouseReleased (browser-use's exact reasoning) blocks until the
  // popups watchdog dismisses it. Bounded waits ensure we proceed even
  // if the browser is mid-dialog.
  const move = s.cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: plan.x, y: plan.y },
    s.id,
    { timeoutMs: 1000 },
  );
  await move;
  await s.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x: plan.x,
      y: plan.y,
      button: "left",
      clickCount: 1,
    },
    s.id,
    { timeoutMs: 3000 },
  );
  await s.cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseReleased",
      x: plan.x,
      y: plan.y,
      button: "left",
      clickCount: 1,
    },
    s.id,
    { timeoutMs: 5000 },
  );

  const result: any = {
    ok: true,
    via: "cdp-mouse",
    x: plan.x,
    y: plan.y,
  };
  if (plan.isToggle) {
    const post = await s.evalJSON(`(() => {
      const el = (${find(el)});
      return el ? !!el.checked : null;
    })()`);
    result.preClickChecked = plan.preClickChecked;
    result.postClickChecked = post;
    result.toggled = plan.preClickChecked !== post;
  }
  return result;
}

export const ELEMENT_VERBS: Record<string, ElementVerbHandler> = {
  click: clickPipeline,

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
