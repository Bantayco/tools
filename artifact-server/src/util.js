// Small shared helpers for the Worker and Durable Objects.

const enc = new TextEncoder();

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RESERVED_APPS = new Set(["api", "admin", "mcp", "v", "favicon.ico", "robots.txt"]);
export const HASH = /^[0-9a-f]{64}$/;

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (both sides hashed first so lengths match). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256hex(String(a)), sha256hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Session token cookie: scoped to one session's API path, never readable by JS. */
export function tokenCookie(id, token, maxAge = 400 * 86400) {
  return `bt=${token}; Path=/api/s/${id}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearTokenCookie(id) {
  return `bt=; Path=/api/s/${id}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function readJson(request, limit = 2_000_000) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new HttpError(413, "request too large");
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, "request too large");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/** Bearer-key check against a configured secret. Missing secret = always deny. */
export async function hasKey(request, secret) {
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return !!m && (await safeEqual(m[1].trim(), secret));
}

// Durable Object RPC only carries an error's message across the boundary, so
// public DO methods return HttpErrors as values and the Worker re-throws them.
export async function rpc(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return { __error: { status: e.status, message: e.message, extra: e.extra } };
    throw e;
  }
}

export function unwrap(result) {
  if (result && result.__error) {
    const { status, message, extra } = result.__error;
    throw new HttpError(status, message, extra);
  }
  return result;
}
