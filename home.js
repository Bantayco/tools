// cache-bust: served with no-long-cache headers (see /_headers)
import { listAllAssets } from "/_shared/api.js";

// Single source of truth for the tools on the dashboard. Add a tool here and it
// shows up both as a "start new" card and as the label/link for its files.
const TOOLS = {
  "style-guide": { label: "Style Guide", href: "/style-guide/", blurb: "Brand tokens for every tool." },
  mermaid: { label: "Mermaid", href: "/mermaid/", blurb: "Edit and preview diagrams." },
};

// Standalone tools (not document editors) — just links.
const APPS = [
  {
    label: "Neural Networks Study Guide",
    href: "/neural-networks-study-guide/",
    blurb: "Nielsen's book, day by day, with progress tracking.",
  },
];

const newTools = document.querySelector("#newTools");
const appsEl = document.querySelector("#apps");
const filesEl = document.querySelector("#files");
const authEl = document.querySelector("#auth");

const SIGN_IN = "/signin?next=%2F";
const SIGN_OUT = "/cdn-cgi/access/logout"; // Cloudflare Access — clears the session cookie

function setAuth(signedIn) {
  authEl.innerHTML = signedIn
    ? `<a class="auth-link" href="${SIGN_OUT}">Sign out</a>`
    : `<a class="auth-link" href="${SIGN_IN}">Sign in</a>`;
}

renderNewCards();
renderApps();
renderFiles();

function renderNewCards() {
  newTools.innerHTML = Object.entries(TOOLS)
    .map(
      ([slug, t]) => `
      <a class="card" href="${t.href}?new=1">
        <strong>New ${esc(t.label)}</strong>
        <span>${esc(t.blurb)}</span>
      </a>`
    )
    .join("");
}

function renderApps() {
  appsEl.innerHTML = APPS.map(
    (a) => `
      <a class="card" href="${a.href}">
        <strong>${esc(a.label)}</strong>
        <span>${esc(a.blurb)}</span>
      </a>`
  ).join("");
}

async function renderFiles() {
  let items;
  try {
    items = await listAllAssets();
  } catch (err) {
    if (err.message === "Not signed in") {
      setAuth(false);
      filesEl.innerHTML =
        `<p class="note">Sign in to see your saved files.</p>` +
        `<a class="signin-btn" href="${SIGN_IN}">Sign in</a>`;
    } else {
      filesEl.innerHTML = `<p class="note">Your files aren't available here (run the full dev server or deploy).</p>`;
    }
    return;
  }

  setAuth(true);

  if (!items.length) {
    filesEl.innerHTML = `<p class="note">No files yet — start one above.</p>`;
    return;
  }

  items.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  filesEl.innerHTML = items
    .map((it) => {
      const tool = TOOLS[it.tool];
      const href = tool ? `${tool.href}?id=${encodeURIComponent(it.slug)}` : "#";
      const label = tool ? tool.label : it.tool;
      return `
      <a class="file" href="${href}">
        <span class="title">${esc(it.title || it.slug)}</span>
        <span class="badge">${esc(label)}</span>
        <span class="when">${esc(timeAgo(it.updatedAt))}</span>
      </a>`;
    })
    .join("");
}

function timeAgo(iso) {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, secs] of units) {
    const v = Math.floor(seconds / secs);
    if (v >= 1) return `${v} ${name}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
