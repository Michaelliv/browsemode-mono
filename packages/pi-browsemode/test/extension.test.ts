// Smoke tests for the pi-browsemode extension shape. We don't boot a
// real pi; we hand a fake ExtensionAPI to the factory and assert
// what it registered.

import { describe, expect, it, mock } from "bun:test";

const PATH = "../.pi/extensions/browsemode/index.js";

interface Captured {
  tools: any[];
  commands: Record<string, any>;
  events: Record<string, (...args: any[]) => any>;
  renderers: Record<string, any>;
  messages: any[];
}

function makeFakePi(): { pi: any; cap: Captured } {
  const cap: Captured = {
    tools: [],
    commands: {},
    events: {},
    renderers: {},
    messages: [],
  };
  const pi = {
    registerTool: mock((spec: any) => cap.tools.push(spec)),
    registerCommand: mock((name: string, spec: any) => {
      cap.commands[name] = spec;
    }),
    registerMessageRenderer: mock((kind: string, fn: any) => {
      cap.renderers[kind] = fn;
    }),
    on: mock((event: string, handler: any) => {
      cap.events[event] = handler;
    }),
    sendMessage: mock((m: any) => cap.messages.push(m)),
  };
  return { pi, cap };
}

describe("pi-browsemode extension", () => {
  it("default export is a function", async () => {
    const mod = await import(PATH);
    expect(typeof mod.default).toBe("function");
  });

  it("registers exactly one tool: execute_browsemode", async () => {
    const mod = await import(PATH);
    const { pi, cap } = makeFakePi();
    mod.default(pi);
    expect(cap.tools).toHaveLength(1);
    const tool = cap.tools[0];
    expect(tool.name).toBe("execute_browsemode");
    expect(tool.label).toBeTruthy();
    expect(typeof tool.execute).toBe("function");
    // Expects a `code` param like runline's execute_runline.
    expect(tool.parameters.properties.code).toBeDefined();
  });

  it("registers the convenience commands", async () => {
    const mod = await import(PATH);
    const { pi, cap } = makeFakePi();
    mod.default(pi);
    for (const name of [
      "browsemode-status",
      "browsemode-id",
      "browsemode-close",
    ]) {
      expect(cap.commands[name]).toBeDefined();
      expect(typeof cap.commands[name].handler).toBe("function");
    }
  });

  it("subscribes to session_start and session_shutdown", async () => {
    const mod = await import(PATH);
    const { pi, cap } = makeFakePi();
    mod.default(pi);
    expect(typeof cap.events.session_start).toBe("function");
    expect(typeof cap.events.session_shutdown).toBe("function");
  });

  it("registers a custom renderer for browsemode-context messages", async () => {
    const mod = await import(PATH);
    const { pi, cap } = makeFakePi();
    mod.default(pi);
    expect(cap.renderers["browsemode-context"]).toBeDefined();
  });

  it("session_start injects the primer message exactly once", async () => {
    const mod = await import(PATH);
    const { pi, cap } = makeFakePi();
    mod.default(pi);

    const fakeCtx = {
      hasUI: false,
      sessionManager: { getEntries: () => [] as any[] },
      ui: undefined,
    };
    await cap.events.session_start({}, fakeCtx);
    expect(cap.messages).toHaveLength(1);
    expect(cap.messages[0].customType).toBe("browsemode-context");
    expect(cap.messages[0].content).toContain("execute_browsemode");

    // A second session_start (e.g. /resume) sees the prior message
    // in history and skips re-injection.
    const fakeCtx2 = {
      hasUI: false,
      sessionManager: {
        getEntries: () => [
          { type: "custom_message", customType: "browsemode-context" },
        ],
      },
      ui: undefined,
    };
    await cap.events.session_start({}, fakeCtx2);
    expect(cap.messages).toHaveLength(1);
  });
});

describe("browser providers", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const keys = [
    "PI_BROWSE_PROVIDER",
    "PI_BROWSE_BACKEND",
    "PI_BROWSE_CDP_WS_URL",
    "PI_BROWSE_CDP_HOST",
    "PI_BROWSE_CDP_PORT",
    "PI_BROWSE_OBSCURA_PORT",
    "STEEL_API_KEY",
    "BROWSERBASE_API_KEY",
    "BROWSERLESS_API_TOKEN",
    "HYPERBROWSER_API_KEY",
  ];

  function clearProviderEnv() {
    for (const key of keys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restoreProviderEnv() {
    for (const key of keys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  it("defaults to managed Chrome", async () => {
    clearProviderEnv();
    try {
      const { resolveBrowserProvider } = await import("../src/providers.js");
      expect(resolveBrowserProvider().name).toBe("chrome");
    } finally {
      restoreProviderEnv();
    }
  });

  it("auto-selects remote CDP when a websocket URL is configured", async () => {
    clearProviderEnv();
    try {
      process.env.PI_BROWSE_CDP_WS_URL =
        "ws://127.0.0.1:9222/devtools/browser/test";
      const { resolveBrowserProvider } = await import("../src/providers.js");
      expect(resolveBrowserProvider().name).toBe("remote-cdp");
    } finally {
      restoreProviderEnv();
    }
  });

  it("auto-selects cloud browser providers by API key priority", async () => {
    clearProviderEnv();
    try {
      process.env.BROWSERBASE_API_KEY = "fake";
      process.env.STEEL_API_KEY = "fake";
      const { resolveBrowserProvider } = await import("../src/providers.js");
      expect(resolveBrowserProvider().name).toBe("steel");
    } finally {
      restoreProviderEnv();
    }
  });

  it("accepts the legacy PI_BROWSE_BACKEND alias", async () => {
    clearProviderEnv();
    try {
      process.env.PI_BROWSE_BACKEND = "obscura";
      const { resolveBrowserProvider } = await import("../src/providers.js");
      expect(resolveBrowserProvider().name).toBe("obscura");
    } finally {
      restoreProviderEnv();
    }
  });
});

describe("primer", () => {
  it("buildPrimer mentions the tool, the discovery helpers, and the browser id", async () => {
    const { buildPrimer } = await import("../src/primer.js");
    const out = buildPrimer({
      browserId: "scratch",
      willReattach: false,
    });
    expect(out).toContain("execute_browsemode");
    expect(out).toContain("page.list()");
    expect(out).toContain("page.find(");
    expect(out).toContain("page.describe(");
    expect(out).toContain("scratch");
  });

  it("reattach mode shows current tab info when present", async () => {
    const { buildPrimer } = await import("../src/primer.js");
    const out = buildPrimer({
      browserId: "research",
      willReattach: true,
      product: "Obscura/0.1.0",
      activeUrl: "https://news.ycombinator.com",
      activeTitle: "Hacker News",
      activeElementCount: 87,
    });
    expect(out).toContain("Reattaching");
    expect(out).toContain("Obscura/0.1.0");
    expect(out).toContain("Hacker News");
    expect(out).toContain("news.ycombinator.com");
    expect(out).toContain("87 elements");
  });
});
