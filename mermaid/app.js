// cache-bust: served with no-long-cache headers (see /_headers)
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
import elkLayouts from "https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0/dist/mermaid-layout-elk.esm.min.mjs";
import { getAssetParam, setAssetParam } from "/_shared/util.js";
import { getAsset } from "/_shared/api.js";
import { createStore, slugify } from "/_shared/autosave.js";
import { createPublish } from "/_shared/publish.js";

const TOOL = "mermaid";
const DRAFT_KEY = "bantay-mermaid-draft";
const LOOK_KEY = "bantay-mermaid-look";
const LAYOUT_KEY = "bantay-mermaid-layout";

try {
  mermaid.registerLayoutLoaders(elkLayouts);
} catch (e) {
  console.warn("ELK layout adapter failed to register:", e);
}

const DEFAULT_SOURCE = `flowchart TD
  A[Start] --> B{Is it working?}
  B -- Yes --> C[Ship it]
  B -- No --> D[Debug]
  D --> B`;

const prefersDark =
  document.documentElement.getAttribute("data-theme") === "dark" ||
  (!document.documentElement.hasAttribute("data-theme") &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);

function initMermaid(look, layout) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: prefersDark ? "dark" : "default",
    look: look === "handDrawn" ? "handDrawn" : "classic",
    layout: layout === "elk" ? "elk" : "dagre",
  });
}

const initialLook = localStorage.getItem(LOOK_KEY) || "handDrawn";
const initialLayout = localStorage.getItem(LAYOUT_KEY) || "elk";
initMermaid(initialLook, initialLayout);

const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const previewWrap = preview.parentElement;
const errorBox = document.querySelector("#error");
const status = document.querySelector("#status");
const diagramName = document.querySelector("#diagramName");
const myDiagrams = document.querySelector("#myDiagrams");
const copySource = document.querySelector("#copySource");
const downloadMmd = document.querySelector("#downloadMmd");
const exportSvg = document.querySelector("#exportSvg");
const zoomInBtn = document.querySelector("#zoomIn");
const zoomOutBtn = document.querySelector("#zoomOut");
const zoomFitBtn = document.querySelector("#zoomFit");
const zoomLevel = document.querySelector("#zoomLevel");
const lookSelect = document.querySelector("#lookSelect");
lookSelect.value = initialLook;
const layoutSelect = document.querySelector("#layoutSelect");
layoutSelect.value = initialLayout;

const store = createStore({
  tool: TOOL,
  draftKey: DRAFT_KEY,
  getTitle: () => diagramName.value,
  getPayload: () => ({ source: editor.value }),
  onStatus: showStatus,
  onSaved: () => {
    store.init().then(fillSwitcher);
    publish?.refresh();
  },
});

let renderSeq = 0;
let renderTimer;
let firstRender = true;
let publish = null;

bindZoomPan();

// ?p=<slug> = read-only public viewer. Fetches from /public/<tool>/<slug>,
// renders the diagram, and hides all editor/toolbar UI.
const publicSlug = new URLSearchParams(location.search).get("p");
if (publicSlug) {
  runPublicViewer(slugify(publicSlug));
} else {
  init();
}

async function init() {
  bindEvents();
  mountPublish();
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
  publish?.refresh();

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

function mountPublish() {
  const mount = document.querySelector("#publishMount");
  if (!mount) return;
  publish = createPublish({
    tool: TOOL,
    getSlug: () => store.slug,
    container: mount,
    onStatus: showStatus,
    makePublicUrl: (tool, slug) => `${location.origin}/${tool}/?p=${slug}`,
  });
}

async function runPublicViewer(slug) {
  document.body.classList.add("viewer");
  try {
    const res = await fetch(`/public/${TOOL}/${encodeURIComponent(slug)}`, {
      cache: "no-cache",
    });
    if (!res.ok) throw new Error(res.status === 404 ? "Not found or unpublished" : `Failed (${res.status})`);
    const item = await res.json();
    document.title = item.title ? `${item.title} — Mermaid` : "Mermaid";
    editor.value = item.data?.source || "";
    await render();
    requestAnimationFrame(fitToScreen);
    showStatus(item.title || "");
  } catch (err) {
    setError(oneLine(err?.message || String(err)));
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

  lookSelect.addEventListener("change", async () => {
    const look = lookSelect.value;
    localStorage.setItem(LOOK_KEY, look);
    initMermaid(look, layoutSelect.value);
    await render();
    showStatus(`Look: ${look === "handDrawn" ? "Hand-drawn" : "Classic"}`);
  });

  layoutSelect.addEventListener("change", async () => {
    const layout = layoutSelect.value;
    localStorage.setItem(LAYOUT_KEY, layout);
    initMermaid(lookSelect.value, layout);
    await render();
    showStatus(`Layout: ${layout === "elk" ? "ELK" : "Default"}`);
  });
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
    if (firstRender) {
      firstRender = false;
      requestAnimationFrame(fitToScreen);
    } else {
      applyTransform();
    }
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
    requestAnimationFrame(fitToScreen);
    store.saveLocal();
    publish?.refresh();
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
  requestAnimationFrame(fitToScreen);
  store.saveLocal();
  myDiagrams.value = slug;
  publish?.refresh();
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

// --- Zoom & Pan ---------------------------------------------------------
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
let scale = 1;
let tx = 0;
let ty = 0;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function applyTransform() {
  preview.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

function zoomAt(clientX, clientY, factor) {
  const rect = previewWrap.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = next / scale;
  tx = px - (px - tx) * ratio;
  ty = py - (py - ty) * ratio;
  scale = next;
  applyTransform();
}

function centerZoom(factor) {
  const rect = previewWrap.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

function fitToScreen() {
  const svg = preview.querySelector("svg");
  if (!svg) {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
    return;
  }
  // Reset transform so bounding rects reflect natural size.
  preview.style.transform = "translate(0,0) scale(1)";
  const wrapRect = previewWrap.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const previewRect = preview.getBoundingClientRect();
  const svgX = svgRect.left - previewRect.left;
  const svgY = svgRect.top - previewRect.top;
  const pad = 24;
  const availW = wrapRect.width - pad * 2;
  const availH = wrapRect.height - pad * 2;
  if (svgRect.width <= 0 || svgRect.height <= 0 || availW <= 0 || availH <= 0) {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
    return;
  }
  const s = Math.min(availW / svgRect.width, availH / svgRect.height, 1);
  scale = s > 0 ? s : 1;
  tx = pad + (availW - svgRect.width * scale) / 2 - svgX * scale;
  ty = pad + (availH - svgRect.height * scale) / 2 - svgY * scale;
  applyTransform();
}

function bindZoomPan() {
  previewWrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false }
  );

  let panning = false;
  let startClientX = 0;
  let startClientY = 0;
  let startTx = 0;
  let startTy = 0;

  previewWrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".zoom-controls")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    panning = true;
    previewWrap.classList.add("panning");
    try {
      previewWrap.setPointerCapture(e.pointerId);
    } catch {}
    startClientX = e.clientX;
    startClientY = e.clientY;
    startTx = tx;
    startTy = ty;
  });

  previewWrap.addEventListener("pointermove", (e) => {
    if (!panning) return;
    tx = startTx + (e.clientX - startClientX);
    ty = startTy + (e.clientY - startClientY);
    applyTransform();
  });

  function endPan(e) {
    if (!panning) return;
    panning = false;
    previewWrap.classList.remove("panning");
    try {
      previewWrap.releasePointerCapture(e.pointerId);
    } catch {}
  }
  previewWrap.addEventListener("pointerup", endPan);
  previewWrap.addEventListener("pointercancel", endPan);

  zoomInBtn.addEventListener("click", () => centerZoom(1.25));
  zoomOutBtn.addEventListener("click", () => centerZoom(1 / 1.25));
  zoomFitBtn.addEventListener("click", fitToScreen);
}
