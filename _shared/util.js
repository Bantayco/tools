// Shared helpers for every tool under tools.bantay.co
// Import with an absolute path so it resolves the same on Pages and a
// root-served local dev server: import { ... } from "/_shared/util.js";

// Read a query param (defaults to ?f=) and return a SAFE asset name, or null.
// Only [a-z0-9-] is allowed: this is the whitelist that prevents path
// traversal (../) and external URLs from ever reaching a fetch.
export function getAssetParam(param = "f") {
  const raw = new URLSearchParams(location.search).get(param);
  if (!raw) return null;
  const safe = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  // Reject if sanitizing changed anything — fail closed rather than guess.
  return safe && safe === raw.toLowerCase() ? safe : null;
}

// Fetch a saved token set by name from the published, fixed-prefix location.
// The name is re-sanitized here too, so callers can't bypass the whitelist.
export async function loadTokenSet(name) {
  const safe = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!safe) throw new Error("Invalid token set name");
  const res = await fetch(`/_shared/tokens/${safe}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Token set "${safe}" not found (${res.status})`);
  return res.json();
}

// Convenience: set a query param without reloading (e.g. after loading a set).
export function setAssetParam(value, param = "f") {
  const url = new URL(location.href);
  if (value) url.searchParams.set(param, value);
  else url.searchParams.delete(param);
  history.replaceState(null, "", url);
}
