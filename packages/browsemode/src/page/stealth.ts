// Stealth preload — patches the canonical headless-detection signals.
// Ported from puppeteer-extra-plugin-stealth's evasions. We don't try
// to fool serious bot-detection (Akamai, PerimeterX, Datadome) — the
// goal is to handle the easy walls (navigator.webdriver, missing
// chrome.runtime, plugin-list checks) that account for most real-world
// 403s on fresh headless Chrome.
//
// Injected via Page.addScriptToEvaluateOnNewDocument so it runs before
// every page script. Safe on both Chrome and obscura.

export const STEALTH_SCRIPT = String.raw`
(function () {
  if (typeof window === 'undefined') return;
  if (window.__browsemode_stealth_v1) return;
  window.__browsemode_stealth_v1 = true;

  // 1. navigator.webdriver — the canonical headless tell. Many bot
  // detectors short-circuit on this single property.
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      enumerable: true,
      get: function () { return undefined; },
    });
  } catch (_e) {}

  // 2. window.chrome — real Chrome populates this with runtime, app, etc.
  // Headless Chrome with default flags doesn't, which is detectable.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
          runtime: {
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            connect: function () {},
            sendMessage: function () {},
            id: undefined,
          },
          csi: function () {},
          loadTimes: function () { return { commitLoadTime: Date.now() / 1000, connectionInfo: 'http/1.1', finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'Other', npnNegotiatedProtocol: 'unknown', requestTime: Date.now() / 1000 - 1, startLoadTime: Date.now() / 1000 - 1, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: false, wasNpnNegotiated: false }; },
        },
      });
    }
  } catch (_e) {}

  // 3. navigator.plugins — headless reports zero. Real Chrome has
  // PDF Viewer + Native Client by default. We synthesize a plausible list.
  try {
    var fakePlugin = function (name, filename, description) {
      var p = Object.create(Plugin.prototype);
      Object.defineProperty(p, 'name', { value: name });
      Object.defineProperty(p, 'filename', { value: filename });
      Object.defineProperty(p, 'description', { value: description });
      Object.defineProperty(p, 'length', { value: 1 });
      return p;
    };
    var plugins = [
      fakePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      fakePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    var pluginArray = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginArray, 'length', { value: plugins.length });
    plugins.forEach(function (p, i) {
      Object.defineProperty(pluginArray, i, { value: p, enumerable: true });
      Object.defineProperty(pluginArray, p.name, { value: p });
    });
    Object.defineProperty(pluginArray, 'item', { value: function (i) { return plugins[i] || null; } });
    Object.defineProperty(pluginArray, 'namedItem', { value: function (n) { return plugins.find(function (p) { return p.name === n; }) || null; } });
    Object.defineProperty(pluginArray, 'refresh', { value: function () {} });
    Object.defineProperty(Navigator.prototype, 'plugins', {
      configurable: true,
      get: function () { return pluginArray; },
    });
  } catch (_e) {}

  // 4. navigator.languages — real browsers have a list, not just the
  // single navigator.language.
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true,
      get: function () { return ['en-US', 'en']; },
    });
  } catch (_e) {}

  // 5. Notifications permission — headless returns 'denied' for default,
  // real Chrome returns 'default' until user interacts. Many bot detectors
  // probe this to distinguish.
  try {
    var origQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (origQuery) {
      window.navigator.permissions.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: 'default', onchange: null });
        }
        return origQuery.apply(this, arguments);
      };
    }
  } catch (_e) {}

  // 6. WebGL vendor and renderer — headless reports SwiftShader. Real
  // hardware Chrome returns the GPU vendor string. Spoof to a plausible
  // Intel GPU.
  try {
    var spoofParam = function (proto) {
      if (!proto || !proto.getParameter) return;
      var orig = proto.getParameter;
      proto.getParameter = function (param) {
        if (param === 37445 /* UNMASKED_VENDOR_WEBGL */) return 'Intel Inc.';
        if (param === 37446 /* UNMASKED_RENDERER_WEBGL */) return 'Intel(R) Iris(TM) Plus Graphics 640';
        return orig.call(this, param);
      };
    };
    if (typeof WebGLRenderingContext !== 'undefined') spoofParam(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') spoofParam(WebGL2RenderingContext.prototype);
  } catch (_e) {}

  // 7. window.outerWidth / outerHeight — headless reports 0 or matches
  // inner dimensions. Real desktop usually has outer >= inner because
  // of toolbars.
  try {
    Object.defineProperty(window, 'outerWidth', {
      configurable: true,
      get: function () { return window.innerWidth; },
    });
    Object.defineProperty(window, 'outerHeight', {
      configurable: true,
      get: function () { return window.innerHeight + 85; },
    });
  } catch (_e) {}

  // 8. Make patched functions look native to Function.prototype.toString.
  // Some bot detectors check [native code] in the string.
  try {
    var origFnToString = Function.prototype.toString;
    var spoofedFns = new WeakSet();
    var markNative = function (fn) { spoofedFns.add(fn); };
    Function.prototype.toString = function () {
      if (spoofedFns.has(this)) return 'function ' + (this.name || '') + '() { [native code] }';
      return origFnToString.call(this);
    };
    markNative(Function.prototype.toString);
    if (window.chrome && window.chrome.runtime && window.chrome.runtime.connect) markNative(window.chrome.runtime.connect);
    if (window.navigator.permissions && window.navigator.permissions.query) markNative(window.navigator.permissions.query);
  } catch (_e) {}
})();
`;
