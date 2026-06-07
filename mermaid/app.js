import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { getAssetParam, setAssetParam } from "/_shared/util.js";
import { listAssets, getAsset, saveAsset } from "/_shared/api.js";

const TOOL = "mermaid";
const STORAGE_KEY = "bantay-mermaid-source";

const DEFAULT_SOURCE = `flowchart TD
  A[Start] --> B{Is it working?}
  B -- Yes --> C[Ship it]
  B -- No --> D[Debug]
  D --> B`;

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });

const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const errorBox = document.querySelector("#error");
const status = document.querySelector("#status");
const diagramName = document.querySelector("#diagramName");
const myDiagrams = document.querySelector("#myDiagrams");
const saveDiagram = document.querySelector("#saveDiagram");
const copySource = document.querySelector("#copySource");
const downloadMmd = document.querySelector("#downloadMmd");
const exportSvg = document.querySelector("#exportSvg");

let renderSeq = 0;
let renderTimer;

init();

async function init() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  if (params.has("new")) {
    editor.value = DEFAULT_SOURCE;
    localStorage.setItem(STORAGE_KEY, editor.value);
  } else {
    editor.value = localStorage.getItem(STORAGE_KEY) || DEFAULT_SOURCE;
  }
  await render();

  // Precedence: ?id=<slug> (a saved diagram) > ?f=<name> (a shipped example).
  const id = params.get("id");
  if (id) {
    try {
      await openSaved(slugify(id));
    } catch (err) {
      showStatus(err.message);
    }
  } else {
    await loadFromAssetParam();
  }
  refreshMyDiagrams();
}

function bindEvents() {
  editor.addEventListener("input", () => {
    localStorage.setItem(STORAGE_KEY, editor.value);
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  });

  copySource.addEventListener("click", async () => {
    await navigator.clipboard.writeText(editor.value);
    showStatus("Source copied");
  });

  downloadMmd.addEventListener("click", () => {
    download(`${currentSlug() || "diagram"}.mmd`, editor.value, "text/vnd.mermaid");
  });

  exportSvg.addEventListener("click", () => {
    const svg = preview.querySelector("svg");
    if (!svg) {
      showStatus("Nothing to export — fix the diagram first");
      return;
    }
    const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
    download(`${currentSlug() || "diagram"}.svg`, markup, "image/svg+xml");
  });

  saveDiagram.addEventListener("click", saveCurrent);
  myDiagrams.addEventListener("change", loadSelected);
}

async function render() {
  const source = editor.value.trim();
  if (!source) {
    preview.innerHTML = "";
    setError("");
    return;
  }
  try {
    await mermaid.parse(source); // throws on invalid syntax
    const { svg } = await mermaid.render(`mmd-${++renderSeq}`, source);
    preview.innerHTML = svg;
    setError("");
    showStatus("Rendered");
  } catch (err) {
    // Keep the last good preview; just surface the error.
    setError(oneLine(err?.message || String(err)));
  }
}

// ?f=<name> loads a shipped example from /mermaid/examples/<name>.mmd
async function loadFromAssetParam() {
  const name = getAssetParam("f");
  if (!name) return;
  try {
    const res = await fetch(`/mermaid/examples/${name}.mmd`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Example "${name}" not found`);
    editor.value = await res.text();
    localStorage.setItem(STORAGE_KEY, editor.value);
    diagramName.value = name;
    await render();
    showStatus(`Loaded "${name}"`);
  } catch (err) {
    showStatus(err.message);
    setAssetParam(null, "f");
  }
}

async function saveCurrent() {
  const slug = currentSlug();
  if (!slug) {
    showStatus("Name the diagram before saving");
    diagramName.focus();
    return;
  }
  try {
    await saveAsset(TOOL, slug, { title: diagramName.value.trim() || slug, source: editor.value });
    showStatus(`Saved "${slug}"`);
    await refreshMyDiagrams(slug);
  } catch (err) {
    showStatus(err.message);
  }
}

async function loadSelected() {
  const slug = myDiagrams.value;
  if (!slug) return;
  try {
    await openSaved(slug);
  } catch (err) {
    showStatus(err.message);
  }
}

// Load one of the user's saved diagrams (from KV) by slug.
async function openSaved(slug) {
  const saved = await getAsset(TOOL, slug);
  editor.value = saved.source || "";
  diagramName.value = saved.title || slug;
  localStorage.setItem(STORAGE_KEY, editor.value);
  setAssetParam(null, "f");
  await render();
  showStatus(`Loaded "${slug}"`);
}

// Best-effort: stays quiet if not signed in or the API isn't available.
async function refreshMyDiagrams(selected = "") {
  try {
    const items = await listAssets(TOOL);
    myDiagrams.innerHTML =
      '<option value="">My diagrams…</option>' +
      items
        .map((it) => `<option value="${esc(it.slug)}">${esc(it.title || it.slug)}</option>`)
        .join("");
    if (selected) myDiagrams.value = selected;
  } catch {
    /* no account / API — leave placeholder */
  }
}

function currentSlug() {
  return slugify(diagramName.value);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  showStatus(`${filename} downloaded`);
}

function setError(message) {
  errorBox.textContent = message;
}

function oneLine(message) {
  return message.replace(/\s+/g, " ").trim().slice(0, 120);
}

function showStatus(message) {
  status.textContent = message;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
