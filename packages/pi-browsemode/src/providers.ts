import { Browsemode, type Browser } from "browsemode";

export interface BrowserProvider {
  name: string;
  envKeys: string[];
  /** True when an existing/restored browser is acceptable for this provider. */
  accepts(browser: Browser): boolean;
  /** Open a fresh browser for this provider. Must create at least one page. */
  open(browserId: string): Promise<Browser>;
}

function parsePort(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return value === "1" || value.toLowerCase() === "true";
}

async function requestJson<T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers:
      body === undefined
        ? headers
        : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  return requestJson<T>(url, "POST", headers, body);
}

function withCloseCleanup(
  browser: Browser,
  cleanup: () => Promise<void>,
): Browser {
  const close = browser.close.bind(browser);
  browser.close = async () => {
    try {
      await close();
    } finally {
      await cleanup().catch(() => undefined);
    }
  };
  return browser;
}

async function openWs(browserId: string, wsUrl: string): Promise<Browser> {
  const browser = await Browsemode.connectWebSocket(wsUrl, { id: browserId });
  await browser.newPage();
  return browser;
}

export const chromeProvider: BrowserProvider = {
  name: "chrome",
  envKeys: [],
  accepts(browser) {
    return !/obscura/i.test(browser.product);
  },
  async open(browserId) {
    const browser = await Browsemode.launch({ id: browserId });
    await browser.newPage();
    return browser;
  },
};

export const obscuraProvider: BrowserProvider = {
  name: "obscura",
  envKeys: ["PI_BROWSE_OBSCURA_PORT"],
  // Obscura intentionally falls back to Chrome when unavailable; keep the
  // fallback handle across calls instead of closing it and retrying forever.
  accepts() {
    return true;
  },
  async open(browserId) {
    try {
      const browser = await Browsemode.connect({
        id: browserId,
        port: parsePort(process.env.PI_BROWSE_OBSCURA_PORT, 9333),
      });
      await browser.newPage();
      return browser;
    } catch {
      return chromeProvider.open(browserId);
    }
  },
};

export const remoteCdpProvider: BrowserProvider = {
  name: "remote-cdp",
  envKeys: ["PI_BROWSE_CDP_WS_URL"],
  accepts() {
    return true;
  },
  async open(browserId) {
    const wsUrl = process.env.PI_BROWSE_CDP_WS_URL;
    if (wsUrl) return openWs(browserId, wsUrl);

    const host = process.env.PI_BROWSE_CDP_HOST;
    if (!host)
      throw new Error("PI_BROWSE_CDP_WS_URL or PI_BROWSE_CDP_HOST not set");
    const browser = await Browsemode.connect({
      id: browserId,
      host,
      port: parsePort(process.env.PI_BROWSE_CDP_PORT, 9222),
    });
    await browser.newPage();
    return browser;
  },
};

export const steelProvider: BrowserProvider = {
  name: "steel",
  envKeys: ["STEEL_API_KEY"],
  accepts() {
    return true;
  },
  async open(browserId) {
    const apiKey = process.env.STEEL_API_KEY;
    if (!apiKey) throw new Error("STEEL_API_KEY not set");
    const apiUrl = process.env.STEEL_API_URL ?? "https://api.steel.dev/v1";
    const session = await postJson<{
      id: string;
      websocketUrl?: string;
      websocket_url?: string;
    }>(
      `${apiUrl.replace(/\/$/, "")}/sessions`,
      { "Steel-Api-Key": apiKey },
      {
        useProxy: envFlag("STEEL_USE_PROXY"),
        solveCaptcha: envFlag("STEEL_SOLVE_CAPTCHA"),
        timeout: process.env.STEEL_SESSION_TIMEOUT_MS
          ? parsePort(process.env.STEEL_SESSION_TIMEOUT_MS, 300_000)
          : undefined,
      },
    );
    const wsUrl =
      session.websocketUrl ??
      session.websocket_url ??
      `wss://connect.steel.dev?apiKey=${encodeURIComponent(apiKey)}&sessionId=${encodeURIComponent(session.id)}`;
    const browser = await openWs(
      browserId,
      wsUrl.includes("apiKey=")
        ? wsUrl
        : `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`,
    );
    return withCloseCleanup(browser, async () => {
      const base = apiUrl.replace(/\/$/, "");
      await requestJson(`${base}/sessions/${session.id}/release`, "POST", {
        "Steel-Api-Key": apiKey,
      }).catch(async () => {
        await requestJson(`${base}/sessions/${session.id}`, "DELETE", {
          "Steel-Api-Key": apiKey,
        });
      });
    });
  },
};

export const browserbaseProvider: BrowserProvider = {
  name: "browserbase",
  envKeys: ["BROWSERBASE_API_KEY"],
  accepts() {
    return true;
  },
  async open(browserId) {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) throw new Error("BROWSERBASE_API_KEY not set");
    const body: Record<string, unknown> = {};
    if (process.env.BROWSERBASE_PROJECT_ID)
      body.projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (process.env.BROWSERBASE_REGION)
      body.region = process.env.BROWSERBASE_REGION;
    if (process.env.BROWSERBASE_KEEP_ALIVE !== undefined)
      body.keepAlive = envFlag("BROWSERBASE_KEEP_ALIVE");
    const session = await postJson<{ connectUrl: string }>(
      "https://api.browserbase.com/v1/sessions",
      { "X-BB-API-Key": apiKey },
      body,
    );
    const browser = await openWs(browserId, session.connectUrl);
    // Browserbase documents browser.close() as explicit session termination;
    // no extra REST cleanup is needed for normal sessions.
    return browser;
  },
};

export const browserlessProvider: BrowserProvider = {
  name: "browserless",
  envKeys: ["BROWSERLESS_API_TOKEN"],
  accepts() {
    return true;
  },
  async open(browserId) {
    const token = process.env.BROWSERLESS_API_TOKEN;
    if (!token) throw new Error("BROWSERLESS_API_TOKEN not set");
    const base =
      process.env.BROWSERLESS_WS_URL ?? "wss://production-sfo.browserless.io";
    const url = new URL(base);
    if (!url.searchParams.has("token")) url.searchParams.set("token", token);
    if (process.env.BROWSERLESS_BLOCK_ADS)
      url.searchParams.set("blockAds", process.env.BROWSERLESS_BLOCK_ADS);
    return openWs(browserId, url.toString());
  },
};

export const hyperbrowserProvider: BrowserProvider = {
  name: "hyperbrowser",
  envKeys: ["HYPERBROWSER_API_KEY"],
  accepts() {
    return true;
  },
  async open(browserId) {
    const apiKey = process.env.HYPERBROWSER_API_KEY;
    if (!apiKey) throw new Error("HYPERBROWSER_API_KEY not set");
    const apiUrl =
      process.env.HYPERBROWSER_API_URL ?? "https://api.hyperbrowser.ai";
    const session = await postJson<{ id: string; wsEndpoint: string }>(
      `${apiUrl.replace(/\/$/, "")}/api/session`,
      { "x-api-key": apiKey },
      {},
    );
    const browser = await openWs(browserId, session.wsEndpoint);
    return withCloseCleanup(browser, async () => {
      const base = apiUrl.replace(/\/$/, "");
      await requestJson(`${base}/api/session/${session.id}/stop`, "PUT", {
        "x-api-key": apiKey,
      }).catch(async () => {
        await requestJson(`${base}/api/session/${session.id}`, "DELETE", {
          "x-api-key": apiKey,
        });
      });
    });
  },
};

export const allBrowserProviders: BrowserProvider[] = [
  steelProvider,
  browserbaseProvider,
  browserlessProvider,
  hyperbrowserProvider,
  remoteCdpProvider,
  obscuraProvider,
  chromeProvider,
];

export function resolveBrowserProvider(
  providers: BrowserProvider[] = allBrowserProviders,
): BrowserProvider {
  const explicit =
    process.env.PI_BROWSE_PROVIDER ?? process.env.PI_BROWSE_BACKEND;
  if (explicit) {
    const provider = providers.find((p) => p.name === explicit);
    if (!provider) {
      throw new Error(
        `Unknown PI_BROWSE_PROVIDER '${explicit}'. Available: ${providers
          .map((p) => p.name)
          .join(", ")}`,
      );
    }
    return provider;
  }

  for (const provider of providers) {
    if (
      provider.envKeys.length > 0 &&
      provider.envKeys.every((key) => process.env[key])
    ) {
      return provider;
    }
  }

  if (process.env.PI_BROWSE_CDP_HOST) return remoteCdpProvider;

  return chromeProvider;
}
