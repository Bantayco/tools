import { listAllAssets } from "/_shared/api.js";

// Single source of truth for the tools on the dashboard. Add a tool here and it
// shows up both as a "start new" card and as the label/link for its files.
const TOOLS = {
  "style-guide": { label: "Style Guide", href: "/style-guide/", blurb: "Brand tokens for every tool." },
  mermaid: { label: "Mermaid", href: "/mermaid/", blurb: "Edit and preview diagrams." },
};

const newTools = document.querySelector("#newTools");
const filesEl = document.querySelector("#files");

renderNewCards();
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

async function renderFiles() {
  let items;
  try {
    items = await listAllAssets();
  } catch (err) {
    filesEl.innerHTML = `<p class="note">${
      err.message === "Not signed in"
        ? "Sign in to see your files."
        : "Your files aren't available here (run the full dev server or deploy)."
    }</p>`;
    return;
  }

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
