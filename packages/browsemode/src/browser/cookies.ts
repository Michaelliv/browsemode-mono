// Read Chrome's SQLite cookie store and decrypt AES-encrypted values via
// the password stashed in macOS Keychain ("Chrome Safe Storage"). macOS-
// only for v0.1; Linux uses gnome-keyring/kwallet, Windows uses DPAPI /
// App-Bound Encryption. Adding those is straightforward but speculative.
//
// Format reference (well-documented, stable since Chrome ~80):
//   - Encrypted values start with "v10" then AES-128-CBC ciphertext
//   - IV: 16 spaces (0x20 * 16)
//   - Key: PBKDF2-SHA1(keychainPassword, salt="saltysalt", iter=1003, len=16)
//   - Padding: PKCS7
//   - Chrome ~111+ prepends a 32-byte SHA-256 hash of the cookie host to
//     the plaintext before encryption. Older cookies don't have it; we
//     detect the prefix heuristically and strip.

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.js";

export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires: number; // -1 for session
  sameSite?: "Strict" | "Lax" | "None";
}

export interface ReadCookiesOpts {
  /** Profile name. Default "Default". */
  profile?: string;
  /** Filter: only cookies whose host_key matches this domain (suffix-anchored). */
  domain?: string;
  /** Override the Chrome user-data dir. Default macOS ~/Library/.../Chrome. */
  userDataDir?: string;
  /**
   * Cache decrypted output to ~/.cache/browsemode/cookies/<hash>.json
   * (mode 0600) for this many ms. Skips Keychain on hit, which matters
   * for users who haven't clicked "Always Allow" on macOS — every call
   * would otherwise pop a blocking auth prompt.
   *
   * Cache invalidates when the source SQLite Cookies file's mtime changes,
   * so adding/removing cookies via Chrome triggers a fresh read.
   *
   * Default 10 minutes. 0 disables.
   */
  cacheTtlMs?: number;
}

interface CacheEntry {
  ts: number;
  sourceMtimeMs: number;
  cookies: ChromeCookie[];
}

const SALT = "saltysalt";
const IV = Buffer.alloc(16, 0x20); // 16 spaces
const ITERATIONS = 1003;
const KEY_LEN = 16;

// All paths route through config so deployments can pin them.
function home(): string {
  return process.env.HOME ?? homedir();
}
function cacheDir(): string {
  return join(getConfig().cacheDir, "cookies");
}
function defaultUserDataDir(): string {
  return (
    getConfig().cookies.userDataDir ??
    join(home(), "Library", "Application Support", "Google", "Chrome")
  );
}

function cacheKeyFor(opts: ReadCookiesOpts): string {
  const profile = opts.profile ?? "Default";
  const userDir = opts.userDataDir ?? defaultUserDataDir();
  const domain = opts.domain ?? "";
  return createHash("sha256")
    .update(`${profile}\x00${userDir}\x00${domain}`)
    .digest("hex")
    .slice(0, 16);
}

function cachePathFor(opts: ReadCookiesOpts): string {
  return join(cacheDir(), `${cacheKeyFor(opts)}.json`);
}

export function clearCookieCache(): { removed: number } {
  const dir = cacheDir();
  if (!existsSync(dir)) return { removed: 0 };
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json")) {
      unlinkSync(join(dir, f));
      n++;
    }
  }
  return { removed: n };
}

function getKeychainPassword(): string {
  // `security find-generic-password -wga "Chrome" -s "Chrome Safe Storage"`
  // -w prints just the password to stdout. Errors if the user denies access.
  try {
    const out = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out.trim();
  } catch (e: any) {
    throw new Error(
      "Couldn't read Chrome Safe Storage password from Keychain. " +
        `If macOS prompted, click Allow (or Always Allow). Detail: ${e.message}`,
    );
  }
}

function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_LEN, "sha1");
}

function decrypt(encrypted: Buffer, key: Buffer): string {
  const ct = encrypted.subarray(3); // strip "v10"
  const decipher = createDecipheriv("aes-128-cbc", key, IV);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);

  // Chrome ~111+ prepends a 32-byte SHA-256 host-hash. Heuristic: if the
  // first 32 bytes contain a control byte (other than tab/lf/cr) they're
  // almost certainly the random hash prefix — strip them.
  if (plain.length >= 32) {
    const head = plain.subarray(0, 32);
    let printable = true;
    for (const b of head) {
      if (
        !(
          b === 9 ||
          b === 10 ||
          b === 13 ||
          (b >= 0x20 && b < 0x7f) ||
          b >= 0x80
        )
      ) {
        printable = false;
        break;
      }
    }
    let likelyHash = false;
    for (const b of head) {
      if (b !== 9 && b !== 10 && b !== 13 && b < 0x20) {
        likelyHash = true;
        break;
      }
    }
    if (likelyHash || !printable) {
      return plain.subarray(32).toString("utf-8");
    }
  }
  return plain.toString("utf-8");
}

export function readChromeCookies(opts: ReadCookiesOpts = {}): ChromeCookie[] {
  const profile = opts.profile ?? "Default";
  const userDir = opts.userDataDir ?? defaultUserDataDir();

  // Newer Chromes moved the cookie DB into Network/ subdir.
  const candidates = [
    join(userDir, profile, "Network", "Cookies"),
    join(userDir, profile, "Cookies"),
  ];
  const src = candidates.find(existsSync);
  if (!src) {
    throw new Error(
      `No Cookies file found for profile "${profile}" under ${userDir}. ` +
        `Tried: ${candidates.join(", ")}`,
    );
  }

  // Try cache first. Hits when: file exists, within TTL, source SQLite
  // mtime unchanged.
  const ttl = opts.cacheTtlMs ?? getConfig().cookies.cacheTtlMs;
  const cachePath = cachePathFor(opts);
  if (ttl > 0 && existsSync(cachePath)) {
    try {
      const entry = JSON.parse(readFileSync(cachePath, "utf-8")) as CacheEntry;
      const ageMs = Date.now() - entry.ts;
      const srcMtime = statSync(src).mtimeMs;
      if (ageMs < ttl && entry.sourceMtimeMs === srcMtime) {
        return entry.cookies;
      }
    } catch {
      // corrupt cache — fall through to a fresh read
    }
  }

  // Copy the DB to temp so we don't fight Chrome's WAL.
  const tmp = mkdtempSync(join(tmpdir(), "browsemode-cookies-"));
  const dbPath = join(tmp, "Cookies");
  copyFileSync(src, dbPath);
  for (const ext of ["-wal", "-shm"]) {
    const walSrc = src + ext;
    if (existsSync(walSrc)) copyFileSync(walSrc, dbPath + ext);
  }

  const password = getKeychainPassword();
  const key = deriveKey(password);

  const db = new Database(dbPath, { readonly: true });
  try {
    // Anchor matching to subdomain boundaries: `--domain x.com` should
    // match `x.com`, `.x.com`, and `*.x.com` — but not `netflix.com` or
    // `a-mx.com`.
    const where = opts.domain
      ? "WHERE host_key = ? OR host_key = ? OR host_key LIKE ?"
      : "";
    const params: any[] = opts.domain
      ? [opts.domain, `.${opts.domain}`, `%.${opts.domain}`]
      : [];

    const rows = db
      .query<
        {
          host_key: string;
          name: string;
          value: string;
          encrypted_value: Uint8Array | null;
          path: string;
          expires_utc: number;
          is_secure: number;
          is_httponly: number;
          samesite: number;
        },
        any[]
      >(
        `SELECT host_key, name, value, encrypted_value, path,
                expires_utc, is_secure, is_httponly, samesite
         FROM cookies ${where}`,
      )
      .all(...params);

    const cookies = rows.map((r) => decode(r, key));

    if (ttl > 0) {
      try {
        if (!existsSync(cacheDir())) {
          mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
        }
        const entry: CacheEntry = {
          ts: Date.now(),
          sourceMtimeMs: statSync(src).mtimeMs,
          cookies,
        };
        writeFileSync(cachePath, JSON.stringify(entry));
        chmodSync(cachePath, 0o600);
      } catch {
        // cache write failure is non-fatal; cookies are returned anyway
      }
    }

    return cookies;
  } finally {
    db.close();
  }
}

function decode(row: any, key: Buffer): ChromeCookie {
  let value: string = row.value ?? "";
  const enc = row.encrypted_value;
  if (enc && enc.length > 0) {
    const buf = Buffer.from(enc);
    if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "v10") {
      try {
        value = decrypt(buf, key);
      } catch {
        // Cross-version entry we can't decrypt; fall back to empty.
        value = "";
      }
    }
  }

  const sameSite =
    row.samesite === 0
      ? "None"
      : row.samesite === 1
        ? "Lax"
        : row.samesite === 2
          ? "Strict"
          : undefined;

  // Chrome stores expires_utc as microseconds since 1601-01-01. Convert
  // to unix seconds; -1 for session cookies / 0 sentinels.
  let expires = -1;
  if (row.expires_utc && row.expires_utc > 0) {
    const unixMs = row.expires_utc / 1000 - 11644473600000;
    expires = Math.floor(unixMs / 1000);
  }

  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path,
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    expires,
    sameSite,
  };
}

export function toCdpCookies(cookies: ChromeCookie[]): unknown[] {
  return cookies
    .filter((c) => c.value !== undefined && c.value !== null)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.expires > 0 ? { expires: c.expires } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
}
