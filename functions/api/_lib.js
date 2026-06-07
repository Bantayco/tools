// Shared helpers for the /api Functions (files starting with _ are not routed).

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Slugs become part of a KV key, so keep them tight and predictable.
export function sanitizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
}

// ---- Cloudflare Access JWT verification (RS256) ---------------------------
// Access puts a signed JWT in the Cf-Access-Jwt-Assertion header (and a
// CF_Authorization cookie). We verify the signature against the team's JWKS
// rather than trusting the header blindly.

const textEncoder = new TextEncoder();
let certCache = null; // { fetchedAt, keys }

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function fetchCerts(teamDomain) {
  // Cache JWKS for an hour to avoid a fetch on every request.
  if (certCache && Date.now() - certCache.fetchedAt < 3_600_000) {
    return certCache.keys;
  }
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Could not fetch Access certs");
  const { keys } = await res.json();
  certCache = { fetchedAt: Date.now(), keys };
  return keys;
}

export async function verifyAccessJwt(token, teamDomain, aud) {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("Malformed token");

  const header = b64urlToJson(h);
  const payload = b64urlToJson(p);
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp < now) throw new Error("Token expired");
  if (payload.nbf && payload.nbf > now) throw new Error("Token not yet valid");
  const auds = [].concat(payload.aud || []);
  if (!auds.includes(aud)) throw new Error("Wrong audience");

  const keys = await fetchCerts(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sig),
    textEncoder.encode(`${h}.${p}`)
  );
  if (!ok) throw new Error("Bad signature");

  return payload; // { sub, email, aud, ... }
}

export function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
