// Client wrapper for the /api/assets Functions. Same-origin fetches carry the
// Cloudflare Access cookie automatically, so there's no token to manage here.
// Every call is scoped to a `tool` namespace so saves don't mix across tools.

const enc = encodeURIComponent;

// Send the browser through the Access-protected /signin page, then back here.
// Defaults to the current path only (drops query, so ?new etc. don't replay).
export function goSignIn(next = location.pathname) {
  const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  location.href = `/signin?next=${enc(safe)}`;
}

async function req(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) throw new Error("Not signed in");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res;
}

// Every saved item across all tools -> [{ tool, slug, title, updatedAt }].
export async function listAllAssets() {
  const res = await req(`/api/assets`);
  return (await res.json()).items;
}

// One tool's items -> [{ slug, title, updatedAt }].
export async function listAssets(tool) {
  const res = await req(`/api/assets/${enc(tool)}`);
  return (await res.json()).items;
}

export async function getAsset(tool, slug) {
  const res = await req(`/api/assets/${enc(tool)}/${enc(slug)}`);
  return res.json();
}

export async function saveAsset(tool, slug, data) {
  await req(`/api/assets/${enc(tool)}/${enc(slug)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteAsset(tool, slug) {
  await req(`/api/assets/${enc(tool)}/${enc(slug)}`, { method: "DELETE" });
}
