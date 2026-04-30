// Scanner: finds interactable elements on a document, assigns each a
// semantic name + supported verbs, stamps a stable `data-browsemode`
// attribute so the page can resolve `name.verb()` back to a real DOM
// node via Runtime.evaluate.
//
// Designed to work against runtimes WITHOUT a layout engine (obscura), so
// we rely on DOM attrs / computed-style hints, not getBoundingClientRect.
// Walks same-origin iframes recursively; cross-origin iframes are handled
// by the Frame layer (separate CDP session per OOPIF).

import type { ScanResult } from "../types.js";

/**
 * JS payload that runs inside a page session via Runtime.evaluate. Returns
 * a ScanResult whose elements carry per-frame selectors. Each invocation
 * wipes prior `data-browsemode` attrs in the document it walks.
 */
export const SCAN_SCRIPT = String.raw`
(() => {
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    'form',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="treeitem"]',
    '[role="gridcell"]',
    '[role="listitem"][onclick]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const isInteractable = (el) => {
    if (el.hidden) return false;
    // Disabled elements are NOT filtered. SPAs commonly render inputs
    // initially disabled and remove the attr post-mount; if that script
    // fires late or fails (obscura issue #45 chained-script wedge), we'd
    // never see the input. The agent can describe() and check kind/verbs
    // if it needs to know.
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('inert')) return false;
    if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs) {
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        if (parseFloat(cs.opacity) === 0) return false;
      }
    } catch (_e) { /* obscura: no layout, accept */ }
    return true;
  };

  // ARIA container roles that ARE the intended click target. e.g. an
  // autocomplete dropdown row is the <li role=option>; the inner button
  // (favorite star) is a separate, secondary action. We want both
  // addressable, so they're NOT pruned by the "drop ancestors" rule.
  const CONTAINER_ROLES = new Set([
    'option', 'treeitem', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'tab', 'listitem',
  ]);

  // ── Kind + verb inference ────────────────────────────
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'form') return 'form';
    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    // Tag wins over role: an <input role="combobox"> is a text input,
    // not a <select>. weather.com etc. use combobox roles on plain inputs
    // for autocomplete UX — we still want fill/clear/value.
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      if (type === 'checkbox' || role === 'checkbox') return 'checkbox';
      if (type === 'radio' || role === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'text';
    }
    if (role === 'combobox') return 'select';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'textbox') return 'text';
    // Listbox/menu options behave like buttons for click purposes.
    if (role === 'option' || role === 'treeitem' || role === 'menuitem' ||
        role === 'menuitemcheckbox' || role === 'menuitemradio' ||
        role === 'tab') return 'button';
    return 'generic';
  };

  const verbsFor = (kind) => {
    switch (kind) {
      case 'button':   return ['click', 'text'];
      case 'link':     return ['click', 'href', 'text'];
      case 'text':     return ['fill', 'clear', 'value', 'focus'];
      case 'textarea': return ['fill', 'clear', 'value', 'focus'];
      case 'checkbox': return ['check', 'uncheck', 'toggle', 'isChecked'];
      case 'radio':    return ['select', 'isSelected'];
      case 'select':   return ['choose', 'options', 'value'];
      case 'form':     return ['submit', 'fields', 'fill'];
      default:         return ['click', 'text'];
    }
  };

  // ── Name inference ───────────────────────────────────
  // Walk the element subtree collecting text, but skip aria-hidden children.
  // Sites use aria-hidden="true" on icon-label spans (Location Pin, Favorite
  // Star) which leak into textContent and produce names like
  // locationPinBostonmassachusettsFavorButton. Skipping them is essential.
  const visibleText = (root) => {
    let s = '';
    const walk = (node) => {
      if (node.nodeType === 3) { s += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
      for (const c of node.childNodes) walk(c);
    };
    walk(root);
    return s;
  };

  // English stopwords that add no semantic signal and bloat camelCase
  // names. "Search by city, zipcode or neighborhood" → keep Search,
  // city, zipcode, neighborhood; drop by, or.
  const STOP = new Set([
    'the', 'a', 'an', 'or', 'of', 'in', 'on', 'at', 'for', 'by',
    'and', 'to', 'with', 'from', 'into', 'about',
  ]);

  // Tokenize, dedupe prefix-overlaps, drop stopwords, return word array.
  const tokenize = (s) => {
    if (!s) return [];
    const raw = s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    // Prefix-dedupe: "Cloudy" / "Cloudy46" → keep "Cloudy46".
    const deduped = [];
    for (const t of raw) {
      const last = deduped[deduped.length - 1];
      if (last) {
        const lo = t.toLowerCase(), llo = last.toLowerCase();
        if (lo.startsWith(llo)) { deduped[deduped.length - 1] = t; continue; }
        if (llo.startsWith(lo)) continue;
      }
      deduped.push(t);
    }
    const useful = deduped.filter((t) => !STOP.has(t.toLowerCase()));
    return useful.length ? useful : deduped;
  };

  // Build camelCase from words, fitting under maxLen by dropping trailing
  // tokens. Always keep at least the first token, even if oversized.
  const camelFit = (words, maxLen) => {
    let out = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const piece = i === 0
        ? w.toLowerCase()
        : w[0].toUpperCase() + w.slice(1).toLowerCase();
      if (out && (out + piece).length > maxLen) break;
      out += piece;
    }
    return out.replace(/^[0-9]+/, '').replace(/[^a-zA-Z0-9]/g, '');
  };

  // Convenience: full pipeline on a string with a budget.
  const cleanCamel = (s, maxLen) => camelFit(tokenize(s), maxLen);

  const nameFor = (el, kind) => {
    // Direct, intentional sources first — use as-is, no token cleaning.
    const direct = [
      el.getAttribute('aria-label'),
      el.getAttribute('data-testid'),
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
    ].filter(Boolean);

    // Fallback to visible text (aria-hidden stripped, deduped).
    // We pass raw text — cleanCamel will tokenize/stopword-strip itself.
    const fallback = visibleText(el);
    const candidates = direct.length ? direct : (fallback ? [fallback] : []);

    const suffix = kind === 'button' ? 'Button'
                 : kind === 'link' ? 'Link'
                 : kind === 'text' ? 'Input'
                 : kind === 'textarea' ? 'Textarea'
                 : kind === 'checkbox' ? 'Checkbox'
                 : kind === 'radio' ? 'Radio'
                 : kind === 'select' ? 'Select'
                 : kind === 'form' ? 'Form'
                 : '';
    // Total budget is 48; reserve room for suffix so the semantic part
    // doesn't get truncated to fit. Names beyond 48 chars are unwieldy
    // for the agent to type; below that we want as much signal as fits.
    const TOTAL_BUDGET = 48;
    const semanticBudget = TOTAL_BUDGET - suffix.length;
    for (const c of candidates) {
      const n = cleanCamel(c, semanticBudget);
      if (n && n.length >= 1) {
        const lower = n.toLowerCase();
        if (suffix && !lower.endsWith(suffix.toLowerCase())) return n + suffix;
        return n;
      }
    }
    return kind + 'Element';
  };

  // ── Build elements + stamp ids ───────────────────────
  const result = [];
  const counts = Object.create(null);
  const elementByNode = new Map();
  let nextElIdx = 0;

  // Walk a document, returning the doc-local interactables list.
  // selectorRoot is the JS expression that resolves to the document we're
  // scanning (e.g. 'document' for top, or
  // 'document.querySelectorAll("iframe")[2].contentDocument' for nested).
  function scanDoc(rootDoc, selectorRoot) {
    rootDoc.querySelectorAll('[data-browsemode]').forEach((el) => {
      el.removeAttribute('data-browsemode');
    });
    const docAll = Array.from(rootDoc.querySelectorAll(SELECTOR));
    const docVisible = docAll.filter(isInteractable);
    const docFiltered = docVisible.filter((el) => {
      if (el.tagName === 'FORM') return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (CONTAINER_ROLES.has(role)) return true;
      return !docVisible.some((other) => other !== el && el.contains(other));
    });

    docFiltered.forEach((el) => {
      const kind = kindOf(el);
      let name = nameFor(el, kind);
      counts[name] = (counts[name] || 0) + 1;
      if (counts[name] > 1) name = name + counts[name];
      const id = 'el_' + nextElIdx++;
      el.setAttribute('data-browsemode', id);
      const entry = {
        id,
        name,
        kind,
        text: ((el.textContent || el.value || el.getAttribute('placeholder') || '') + '').replace(/\s+/g, ' ').trim().slice(0, 120),
        verbs: verbsFor(kind),
        selector: selectorRoot + '.querySelector(\'[data-browsemode="' + id + '"]\')',
      };
      result.push(entry);
      elementByNode.set(el, entry);
    });

    // Recurse into same-origin iframes.
    const frames = Array.from(rootDoc.querySelectorAll('iframe'));
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      let childDoc = null;
      try { childDoc = f.contentDocument; } catch (_e) { /* cross-origin */ }
      if (!childDoc) continue;
      const childRoot = selectorRoot + '.querySelectorAll(\'iframe\')[' + i + '].contentDocument';
      scanDoc(childDoc, childRoot);
    }
  }

  scanDoc(document, 'document');

  // Flat list of every interactable Element (across same-origin iframes too).
  // Used by collection detection below.
  const filtered = [...elementByNode.keys()];

  // Collection detection.
  // For each tagged interactable, walk up to 7 levels of ancestors looking
  // for one whose parent has ≥3 same-tagName siblings. That ancestor is
  // the "row"; its parent is the "list". Multiple interactables in one
  // row collapse onto that row. Lists with ≥3 distinct rows become
  // collections. Track the level with the most same-tag siblings — that's
  // the outermost / largest repeating pattern, which is usually what the
  // user means by "the list" (e.g. on HN the 30-story tbody, not the
  // 4-link cluster inside one story row).
  const findListRow = (el) => {
    let cur = el;
    let best = null;
    for (let depth = 0; depth < 7; depth++) {
      const parent = cur.parentElement;
      if (!parent) break;
      let count = 0;
      for (const sib of parent.children) {
        if (sib.tagName === cur.tagName) count++;
      }
      if (count >= 3 && (!best || count > best.count)) {
        best = { row: cur, list: parent, count };
      }
      cur = parent;
    }
    return best;
  };

  const listInfo = new Map();
  for (const el of filtered) {
    const found = findListRow(el);
    if (!found) continue;
    let l = listInfo.get(found.list);
    if (!l) { l = new Map(); listInfo.set(found.list, l); }
    let rowMembers = l.get(found.row);
    if (!rowMembers) { rowMembers = []; l.set(found.row, rowMembers); }
    rowMembers.push(el);
  }

  const collectionNameFor = (parent, sample) => {
    const fromAttr = cleanCamel(
      parent.getAttribute('aria-label') ||
      parent.id ||
      parent.getAttribute('data-testid') ||
      parent.getAttribute('role') ||
      '',
      48
    );
    if (fromAttr) return fromAttr;
    const kind = sample.kind;
    return (kind === 'link' ? 'links'
      : kind === 'button' ? 'buttons'
      : kind === 'text' ? 'inputs'
      : kind === 'checkbox' ? 'checkboxes'
      : 'items');
  };

  const collections = {};
  const collectionCounts = Object.create(null);
  for (const [list, rows] of listInfo) {
    if (rows.size < 3) continue;
    // Each row contributes ALL its interactables. The collection's items()
    // returns rows-of-names so the agent can pick the right one in each
    // row (HN: [upvote, title, site] vs [user, time, hide, comments]).
    const rowsOfNames = [];
    for (const interactables of rows.values()) {
      const names = interactables
        .map((el) => elementByNode.get(el)?.name)
        .filter(Boolean);
      if (names.length > 0) rowsOfNames.push(names);
    }
    if (rowsOfNames.length < 3) continue;
    const sampleEntry = elementByNode.get([...rows.values()][0][0]);
    let cName = collectionNameFor(list, sampleEntry || { kind: 'generic' });
    collectionCounts[cName] = (collectionCounts[cName] || 0) + 1;
    if (collectionCounts[cName] > 1) cName = cName + collectionCounts[cName];
    collections[cName] = rowsOfNames;
  }

  return {
    url: location.href,
    title: document.title,
    elements: result,
    collections,
  };
})()
`;

// Re-export for convenience so callers don't have to import from ../types.
export type { ElementInfo, ElementKind, ScanResult } from "../types.js";
