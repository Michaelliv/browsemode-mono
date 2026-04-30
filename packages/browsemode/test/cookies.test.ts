import { describe, expect, it } from "bun:test";
import {
  clearCookieCache,
  toCdpCookies,
  type ChromeCookie,
} from "../src/browser/cookies.js";

const cookie = (overrides: Partial<ChromeCookie> = {}): ChromeCookie => ({
  name: "session",
  value: "abc",
  domain: ".example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  expires: 1700000000,
  sameSite: "Lax",
  ...overrides,
});

describe("toCdpCookies", () => {
  it("preserves the core fields verbatim", () => {
    const out: any[] = toCdpCookies([cookie()]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("session");
    expect(out[0].value).toBe("abc");
    expect(out[0].domain).toBe(".example.com");
    expect(out[0].path).toBe("/");
    expect(out[0].secure).toBe(true);
    expect(out[0].httpOnly).toBe(true);
    expect(out[0].sameSite).toBe("Lax");
    expect(out[0].expires).toBe(1700000000);
  });

  it("omits expires when -1 (session cookie)", () => {
    const out: any[] = toCdpCookies([cookie({ expires: -1 })]);
    expect(out[0].expires).toBeUndefined();
  });

  it("omits sameSite when undefined", () => {
    const out: any[] = toCdpCookies([cookie({ sameSite: undefined })]);
    expect(out[0].sameSite).toBeUndefined();
  });

  it("filters out cookies with null/undefined values", () => {
    const out = toCdpCookies([
      cookie({ value: "ok" }),
      cookie({ value: undefined as any }),
      cookie({ value: null as any }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("clearCookieCache", () => {
  it("returns { removed: number } and is idempotent", () => {
    const r1 = clearCookieCache();
    expect(typeof r1.removed).toBe("number");
    const r2 = clearCookieCache();
    expect(typeof r2.removed).toBe("number");
  });
});
