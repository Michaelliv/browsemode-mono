// DOM-shim preload that browsemode injects into every page on obscura.
// Patches APIs whose absence wedges modern framework bootstrap chains.
//
// Reference issues that motivate each polyfill:
//   - obscura #63: Document.elementFromPoint missing; breaks Google
//     Publisher Tag, IntersectionObserver, viewability libs, and React
//     synthetic event hit-testing during init. The retry loop on throw
//     is what wedges the runtime (#62).
//   - General modern-web assumptions: requestIdleCallback, matchMedia,
//     ResizeObserver/IntersectionObserver/MutationObserver, scrollIntoView.
//
// Principle: a wrong answer that doesn't throw is strictly better than
// an exception that wedges the bootstrap chain. Most callers no-op
// gracefully when the answer is "nothing's there"; few re-throw on null.
//
// Registered once per target via Page.addScriptToEvaluateOnNewDocument
// so it runs before every page script on every navigation in that target.

export const SHIM_SCRIPT = String.raw`
(function () {
  if (typeof window === 'undefined') return;
  if (window.__browsemode_shim_v1) return;
  window.__browsemode_shim_v1 = true;

  // 1. Document.elementFromPoint / elementsFromPoint
  // Real impl needs layout; obscura has no layout. Stub returns body so
  // hit-testing callers no-op instead of throwing.
  try {
    if (typeof Document !== 'undefined' && Document.prototype) {
      if (typeof Document.prototype.elementFromPoint !== 'function') {
        Document.prototype.elementFromPoint = function (x, y) {
          if (x < 0 || y < 0 ||
              x > (window.innerWidth || 0) ||
              y > (window.innerHeight || 0)) return null;
          return this.body || this.documentElement || null;
        };
      }
      if (typeof Document.prototype.elementsFromPoint !== 'function') {
        Document.prototype.elementsFromPoint = function (x, y) {
          var el = this.elementFromPoint(x, y);
          return el ? [el] : [];
        };
      }
    }
    // Same on ShadowRoot for completeness.
    if (typeof ShadowRoot !== 'undefined' && ShadowRoot.prototype &&
        typeof ShadowRoot.prototype.elementFromPoint !== 'function') {
      ShadowRoot.prototype.elementFromPoint = function (x, y) {
        return this.host || null;
      };
      ShadowRoot.prototype.elementsFromPoint = function (x, y) {
        var el = this.elementFromPoint(x, y);
        return el ? [el] : [];
      };
    }
  } catch (_e) {}

  // 2. requestIdleCallback / cancelIdleCallback — non-Chrome runtimes
  // often skip these. Many frameworks defer init work through it.
  try {
    if (typeof window.requestIdleCallback !== 'function') {
      window.requestIdleCallback = function (cb) {
        return setTimeout(function () {
          cb({ didTimeout: false, timeRemaining: function () { return 16; } });
        }, 0);
      };
      window.cancelIdleCallback = function (id) { clearTimeout(id); };
    }
  } catch (_e) {}

  // 3. Observer classes — provide no-op constructors when missing so
  // calling new IntersectionObserver(cb).observe(el) doesn't throw.
  try {
    var observers = ['IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver'];
    for (var i = 0; i < observers.length; i++) {
      var Name = observers[i];
      if (typeof window[Name] !== 'function') {
        window[Name] = (function () {
          function NoopObserver(_cb) {}
          NoopObserver.prototype.observe = function () {};
          NoopObserver.prototype.unobserve = function () {};
          NoopObserver.prototype.disconnect = function () {};
          NoopObserver.prototype.takeRecords = function () { return []; };
          return NoopObserver;
        })();
      }
    }
  } catch (_e) {}

  // 4. scrollIntoView — defensive no-op. SPAs call it after route changes.
  try {
    if (typeof Element !== 'undefined' && Element.prototype &&
        typeof Element.prototype.scrollIntoView !== 'function') {
      Element.prototype.scrollIntoView = function () {};
    }
  } catch (_e) {}

  // 5. matchMedia — always replace on obscura. Native impl returns
  // matches:false for every query, which makes responsive sites fall
  // back to their mobile layout. We write to globalThis (shared with the
  // page's main realm) instead of window in case obscura's window proxy
  // rejects new arbitrary keys.
  try {
    var G = (typeof globalThis !== 'undefined') ? globalThis : window;
    G.__browsemode_shim_step5 = 'started';
    try {
      Object.defineProperty(G, '__browsemode_viewport', {
        configurable: true,
        writable: true,
        value: { width: 1280, height: 800 },
      });
    } catch (e1) {
      try { G.__browsemode_viewport = { width: 1280, height: 800 }; }
      catch (e2) { G.__browsemode_shim_vp_err = String(e2.message || e2); }
    }
    G.__browsemode_shim_step5 = 'vp-set:' + (G.__browsemode_viewport ? 'yes' : 'no');
    var evalMediaQuery = function (query) {
      var vp = window.__browsemode_viewport || { width: 1280, height: 800 };
      var q = String(query || '').toLowerCase().replace(/^\s*@media\s+/, '').trim();
      // Split on 'and' for compound queries.
      var parts = q.split(/\s+and\s+/);
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (part === 'screen' || part === 'all' || part === 'only screen') continue;
        if (part === 'print') return false;
        var m = part.match(/^\(\s*([\w-]+)\s*(?::\s*([^)]+))?\s*\)$/);
        if (!m) return false;
        var prop = m[1];
        var val = (m[2] || '').trim();
        if (prop === 'min-width' || prop === 'max-width') {
          var pxw = parseFloat(val);
          if (prop === 'min-width' && vp.width < pxw) return false;
          if (prop === 'max-width' && vp.width > pxw) return false;
          continue;
        }
        if (prop === 'min-height' || prop === 'max-height') {
          var pxh = parseFloat(val);
          if (prop === 'min-height' && vp.height < pxh) return false;
          if (prop === 'max-height' && vp.height > pxh) return false;
          continue;
        }
        if (prop === 'orientation') {
          var isLandscape = vp.width >= vp.height;
          if (val === 'landscape' && !isLandscape) return false;
          if (val === 'portrait' && isLandscape) return false;
          continue;
        }
        if (prop === 'hover') { if (val !== 'hover') return false; continue; }
        if (prop === 'pointer') { if (val !== 'fine') return false; continue; }
        if (prop === 'any-hover') { if (val !== 'hover') return false; continue; }
        if (prop === 'any-pointer') { if (val !== 'fine') return false; continue; }
        if (prop === 'prefers-color-scheme') { if (val !== 'light') return false; continue; }
        if (prop === 'prefers-reduced-motion') { if (val !== 'no-preference') return false; continue; }
        if (prop === 'display-mode') { if (val !== 'browser') return false; continue; }
        // Unknown property: assume match to be permissive.
      }
      return true;
    };
    var ourMatchMedia = function (q) {
      var matches = evalMediaQuery(q);
      return {
        matches: matches,
        media: q,
        onchange: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        addListener: function () {},
        removeListener: function () {},
        dispatchEvent: function () { return false; },
      };
    };
    var mmInstalled = false;
    try {
      Object.defineProperty(G, 'matchMedia', {
        configurable: true,
        writable: true,
        value: ourMatchMedia,
      });
      mmInstalled = G.matchMedia === ourMatchMedia;
    } catch (e3) { G.__browsemode_shim_mm_err1 = String(e3.message || e3); }
    if (!mmInstalled) {
      try {
        G.matchMedia = ourMatchMedia;
        mmInstalled = G.matchMedia === ourMatchMedia;
      } catch (e4) { G.__browsemode_shim_mm_err2 = String(e4.message || e4); }
    }
    G.__browsemode_shim_step5 = 'mm:' + (mmInstalled ? 'replaced' : 'native');
    try {
      Object.defineProperty(G, '__browsemode_shim_diag', {
        configurable: true,
        writable: true,
        value: {
          mmReplaced: mmInstalled,
          mmType: typeof G.matchMedia,
          vpAfterAssign: G.__browsemode_viewport,
        },
      });
    } catch (_e) {}
    G.__browsemode_shim_step5 = 'done';
    // Expose innerWidth/innerHeight from the same source so layout logic
    // that reads window.innerWidth gets the configured viewport.
    try {
      Object.defineProperty(G, 'innerWidth', {
        configurable: true,
        get: function () {
          return (G.__browsemode_viewport && G.__browsemode_viewport.width) || 1280;
        },
      });
      Object.defineProperty(G, 'innerHeight', {
        configurable: true,
        get: function () {
          return (G.__browsemode_viewport && G.__browsemode_viewport.height) || 800;
        },
      });
    } catch (_e) {}
  } catch (eOuter) {
    try {
      (typeof globalThis !== 'undefined' ? globalThis : window).__browsemode_shim_outer_err =
        String(eOuter.message || eOuter);
    } catch (_) {}
  }

  // 6. requestAnimationFrame / cancelAnimationFrame fallbacks.
  try {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = function (cb) {
        return setTimeout(function () { cb(Date.now()); }, 16);
      };
      window.cancelAnimationFrame = function (id) { clearTimeout(id); };
    }
  } catch (_e) {}

  // 7. Element.prototype.closest fallback (rare to be missing, but cheap).
  try {
    if (typeof Element !== 'undefined' && Element.prototype &&
        typeof Element.prototype.closest !== 'function') {
      Element.prototype.closest = function (sel) {
        var el = this;
        while (el && el.nodeType === 1) {
          if (el.matches && el.matches(sel)) return el;
          el = el.parentElement;
        }
        return null;
      };
    }
  } catch (_e) {}

  // 8. getBoundingClientRect — if missing entirely, return a stub rect.
  // (We don't override an existing impl even if it returns zeros; the
  // shim is for missing APIs, not for fudging layout numbers.)
  try {
    if (typeof Element !== 'undefined' && Element.prototype &&
        typeof Element.prototype.getBoundingClientRect !== 'function') {
      Element.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
      };
    }
  } catch (_e) {}
})();
`;
