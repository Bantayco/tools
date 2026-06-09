// cache-bust: served with no-long-cache headers (see /_headers)
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import { getAssetParam, setAssetParam } from "/_shared/util.js";
import { getAsset } from "/_shared/api.js";
import { createStore, slugify } from "/_shared/autosave.js";

const TOOL = "mermaid";
const DRAFT_KEY = "bantay-mermaid-draft";

const DEFAULT_SOURCE = `flowchart TD
  A[Start] --> B{Is it working?}
  B -- Yes --> C[Ship it]
  B -- No --> D[Debug]
  D --> B`;

const prefersDark =
  document.documentElement.getAttribute("data-theme") === "dark" ||
  (!document.documentElement.hasAttribute("data-theme") &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: prefersDark ? "dark" : "default" });

const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const errorBox = document.querySelector("#error");
const status = document.querySelector("#status");
const diagramName = document.querySelector("#diagramName");
const myDiagrams = document.querySelector("#myDiagrams");
const copySource = document.querySelector("#copySource");
const downloadMmd = document.querySelector("#downloadMmd");
const exportSvg = document.querySelector("#exportSvg");

const store = createStore({
  tool: TOOL,
  draftKey: DRAFT_KEY,
  getTitle: () => diagramName.value,
  getPayload: () => ({ source: editor.value }),
  onStatus: showStatus,
  onSaved: () => store.init().then(fillSwitcher),
});

let renderSeq = 0;
let renderTimer;

init();

async function init() {
  bindEvents();
  const params = new URLSearchParams(location.search);

  // Restore the working draft (unless ?new asks for a clean start).
  if (!params.has("new") && store.loadLocal()) {
    const draft = store.loadLocal();
    editor.value = draft.source || "";
    diagramName.value = draft.title || "";
    if (draft.slug) store.setSlug(draft.slug);
  } else {
    editor.value = DEFAULT_SOURCE;
    diagramName.value = "";
  }
  await render();

  // Auth probe + populate the "open a saved diagram" switcher.
  fillSwitcher(await store.init());

  // Precedence: ?id=<slug> (a saved diagram) > ?f=<name> (a shipped example).
  const id = params.get("id");
  const example = getAssetParam("f");
  if (id) {
    try {
      await openSaved(slugify(id));
    } catch (err) {
      showStatus(err.message);
    }
  } else if (example) {
    await loadExample(example);
  }
}

function bindEvents() {
  editor.addEventListener("input", () => {
    store.change();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  });
  diagramName.addEventListener("input", () => store.change());
  diagramName.addEventListener("change", () => store.rename());

  copySource.addEventListener("click", async () => {
    await navigator.clipboard.writeText(editor.value);
    showStatus("Source copied");
  });

  downloadMmd.addEventListener("click", () => {
    download(`${store.slug || "diagram"}.mmd`, editor.value, "text/vnd.mermaid");
  });

  exportSvg.addEventListener("click", () => {
    const svg = preview.querySelector("svg");
    if (!svg) {
      showStatus("Nothing to export — fix the diagram first");
      return;
    }
    const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}`;
    download(`${store.slug || "diagram"}.svg`, markup, "image/svg+xml");
  });

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
  } catch (err) {
    // Keep the last good preview; just surface the error.
    setError(oneLine(err?.message || String(err)));
  }
}

// ?f=<name> loads a shipped example from /mermaid/examples/<name>.mmd
async function loadExample(name) {
  try {
    const res = await fetch(`/mermaid/examples/${name}.mmd`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Example "${name}" not found`);
    editor.value = await res.text();
    diagramName.value = name;
    store.setSlug(slugify(name));
    await render();
    store.saveLocal();
    showStatus(`Loaded "${name}"`);
  } catch (err) {
    showStatus(err.message);
    setAssetParam(null, "f");
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

// Load one of the user's saved diagrams (from KV) and make it the autosave target.
async function openSaved(slug) {
  const saved = await getAsset(TOOL, slug);
  editor.value = saved.source || "";
  diagramName.value = saved.title || slug;
  store.setSlug(slug);
  setAssetParam(null, "f");
  await render();
  store.saveLocal();
  myDiagrams.value = slug;
  showStatus(`Loaded "${saved.title || slug}"`);
}

function fillSwitcher(items) {
  const current = store.slug;
  myDiagrams.innerHTML =
    '<option value="">My diagrams…</option>' +
    items
      .map((it) => `<option value="${esc(it.slug)}">${esc(it.title || it.slug)}</option>`)
      .join("");
  if (items.some((it) => it.slug === current)) myDiagrams.value = current;
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
