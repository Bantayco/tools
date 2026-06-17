// Knowledge Base — a personal markdown wiki, the static "IDE frontend" for an
// LLM-maintained knowledge base (after Andrej Karpathy's workflow): raw sources
// get compiled by an LLM into interlinked .md articles; here you read, edit,
// navigate and search them.
//
//   - Each note is one saved asset under the `kb` tool: { title, source }.
//   - Notes link to each other with [[Wiki Links]] (or [[Target|label]]).
//   - Backlinks + outgoing links are derived; full-text search runs client-side.
//   - Saving uses the shared autosave/D1 model (signed in) or localStorage.
//   - marked + DOMPurify render the markdown safely.
// cache-bust: served with no-long-cache headers (see /_headers).
import { getAssetParam, setAssetParam } from "/_shared/util.js";
import { listAssets, getAsset } from "/_shared/api.js";
import { createStore, slugify } from "/_shared/autosave.js";

const TOOL = "kb";
const DRAFT_KEY = "bantay-kb-draft";

const DEFAULT_SOURCE = `# Welcome to your Knowledge Base

This is a personal wiki of markdown notes. An LLM agent compiles raw sources
into interlinked articles; you read, edit, navigate and search them here.

## How it works

- Every note is a markdown file. Write freely.
- **Import** a PDF or EPUB (top right, or drop the file here) to pull its text
  in as a new note — the raw source for the agent to summarize.
- Link to another note with double brackets: [[Data Ingest]] or, with a custom
  label, [[Q and A|ask questions]].
- Each note's **outgoing links** and **backlinks** show on the right, so the
  graph maintains itself as the wiki grows.
- The sidebar lists every note and searches across all of them.
- Use **Read** / **Edit** (top right) to switch between rendered and source.

## Starter notes

These links point at notes that don't exist yet — click one to create it:

- [[Data Ingest]] — index source documents into the wiki.
- [[Q and A]] — ask questions against the whole knowledge base.
- [[Linting]] — health checks that keep the data consistent.

> Tip: nothing here is precious. Let the agent write and maintain the notes,
> then file your own queries and outputs back in to make the next answer better.
`;

const els = {
  status: document.querySelector("#status"),
  title: document.querySelector("#title"),
  viewToggle: document.querySelector("#viewToggle"),
  importBtn: document.querySelector("#importBtn"),
  fileInput: document.querySelector("#fileInput"),
  newNote: document.querySelector("#newNote"),
  search: document.querySelector("#search"),
  noteList: document.querySelector("#noteList"),
  sideNote: document.querySelector("#sideNote"),
  editorBody: document.querySelector("#editorBody"),
  editor: document.querySelector("#editor"),
  preview: document.querySelector("#preview"),
  outLinks: document.querySelector("#outLinks"),
  backLinks: document.querySelector("#backLinks"),
};

const store = createStore({
  tool: TOOL,
  draftKey: DRAFT_KEY,
  getTitle: () => els.title.value,
  getPayload: () => ({ source: els.editor.value }),
  onStatus: showStatus,
  onSaved: refreshList,
});

// ---- State ------------------------------------------------------------------
let mode = "edit"; // "edit" | "read"
let dirty = false; // are there unsaved edits to the current note?
let renderTimer = null;
let indexBuilt = false; // have we fetched every note's content yet?

let allItems = []; // [{ slug, title, updatedAt }] from the API
const slugTitle = new Map(); // slug -> title (from the list)
const noteCache = new Map(); // slug -> { title, source } | null (full content)

init();

async function init() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  const draft = !params.has("new") && store.loadLocal();

  if (draft) {
    els.title.value = draft.title || "";
    els.editor.value = draft.source || "";
    if (draft.slug) store.setSlug(draft.slug);
    setMode("edit");
  } else if (params.has("new")) {
    startBlank();
  } else {
    els.title.value = "Welcome";
    els.editor.value = DEFAULT_SOURCE;
    store.setSlug("welcome");
    setMode("read");
  }
  dirty = false;
  renderPreview();
  updateConnections();

  // Auth probe + sidebar.
  refreshList(await store.init());

  // Precedence: ?id=<slug> (a saved note) > ?f=<name> (a shipped example).
  const id = params.get("id");
  const example = getAssetParam("f");
  if (id) {
    await openNote(slugify(id), { mode: "read" });
  } else if (example) {
    await loadExample(example);
  }

  // Pull every note's content in the background so backlinks + full-text
  // search light up (signed-in only; small-scale, so a simple fan-out is fine).
  buildIndex();
}

function bindEvents() {
  els.editor.addEventListener("input", () => {
    dirty = true;
    store.change();
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderPreview();
      updateConnections();
    }, 250);
  });

  els.title.addEventListener("input", () => {
    dirty = true;
    store.change();
  });
  els.title.addEventListener("change", () => store.rename());

  els.viewToggle.addEventListener("click", () => setMode(mode === "edit" ? "read" : "edit"));
  els.newNote.addEventListener("click", newNote);

  // Import a PDF / EPUB — via the button or by dropping a file on the note.
  els.importBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = ""; // allow re-importing the same file
    if (file) handleImport(file);
  });
  els.editorBody.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    els.editorBody.classList.add("dragover");
  });
  els.editorBody.addEventListener("dragleave", (e) => {
    if (e.target === els.editorBody) els.editorBody.classList.remove("dragover");
  });
  els.editorBody.addEventListener("drop", (e) => {
    e.preventDefault();
    els.editorBody.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) handleImport(file);
  });

  els.search.addEventListener("input", renderList);

  // In-app navigation: clicking a [[wiki link]] in the preview opens that note.
  els.preview.addEventListener("click", (e) => {
    const a = e.target.closest("a.wikilink");
    if (!a) return;
    e.preventDefault();
    openNote(a.dataset.slug, { mode: "read", seedTitle: a.textContent });
  });

  els.noteList.addEventListener("click", (e) => {
    const row = e.target.closest("[data-slug]");
    if (row) openNote(row.dataset.slug, { mode: "read" });
  });

  const connClick = (e) => {
    const row = e.target.closest("[data-slug]");
    if (row) openNote(row.dataset.slug, { mode: "read", seedTitle: row.dataset.title });
  };
  els.outLinks.addEventListener("click", connClick);
  els.backLinks.addEventListener("click", connClick);

  // Back/forward between notes.
  window.addEventListener("popstate", () => {
    const id = new URLSearchParams(location.search).get("id");
    if (id) openNote(slugify(id), { mode: "read", push: false });
  });
}

// ---- View mode --------------------------------------------------------------
function setMode(next) {
  mode = next;
  els.editorBody.classList.toggle("reading", mode === "read");
  els.viewToggle.textContent = mode === "read" ? "Edit" : "Read";
  els.viewToggle.classList.toggle("on", mode === "read");
  if (mode === "read") renderPreview();
  else setTimeout(() => els.editor.focus(), 0);
}

// ---- Notes ------------------------------------------------------------------
function startBlank() {
  els.title.value = "";
  els.editor.value = "";
  store.setSlug("untitled");
  setMode("edit");
}

async function newNote() {
  await flush();
  startBlank();
  dirty = false;
  store.saveLocal();
  renderPreview();
  updateConnections();
  highlightActive();
  els.title.focus();
  setAssetParam(null, "f");
  const url = new URL(location.href);
  url.searchParams.delete("id");
  history.pushState(null, "", url);
}

// Open a note by slug. Loads from cache/D1, or starts a fresh note if it
// doesn't exist yet (so [[broken links]] become a one-click way to write it).
async function openNote(slug, { mode: wantMode = "read", seedTitle, push = true } = {}) {
  slug = slugify(slug);
  if (!slug) return;
  await flush();

  let note = noteCache.has(slug) ? noteCache.get(slug) : undefined;
  if (note === undefined) {
    try {
      note = await getAsset(TOOL, slug);
    } catch {
      note = null; // not found, or signed out
    }
    noteCache.set(slug, note);
  }

  if (note) {
    els.title.value = note.title || prettify(slug);
    els.editor.value = note.source || "";
    setMode(wantMode);
  } else if (slug === store.slug && els.editor.value) {
    // Already showing this (likely a local draft) — keep it.
  } else {
    els.title.value = seedTitle || prettify(slug);
    els.editor.value = "";
    setMode("edit"); // a new note wants writing, not reading
  }

  store.setSlug(slug);
  dirty = false;
  store.saveLocal();
  renderPreview();
  updateConnections();
  highlightActive();
  setAssetParam(null, "f");

  if (push) {
    const url = new URL(location.href);
    url.searchParams.set("id", slug);
    url.searchParams.delete("new");
    history.pushState({ slug }, "", url);
  }
  showStatus(note ? `Opened "${els.title.value}"` : `New note "${els.title.value}"`);
}

// Persist the current note now if it has unsaved edits (before navigating away).
async function flush() {
  if (!dirty) return;
  if (!els.editor.value.trim() && !els.title.value.trim()) return; // nothing worth saving
  dirty = false;
  noteCache.set(store.slug, { title: els.title.value, source: els.editor.value });
  await store.commit();
}

// Import a PDF / EPUB: extract its text to markdown and open it as a new note.
async function handleImport(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!["pdf", "epub"].includes(ext)) {
    showStatus("Only PDF or EPUB files are supported");
    return;
  }
  await flush();
  showStatus(`Reading ${file.name}…`);
  els.importBtn.disabled = true;

  let result;
  try {
    const { extractFile } = await import("./ingest.js?v=1");
    result = await extractFile(file, showStatus);
  } catch (err) {
    console.error(err);
    showStatus(`Could not import ${file.name}: ${err.message}`);
    return;
  } finally {
    els.importBtn.disabled = false;
  }

  const base = file.name.replace(/\.[^.]+$/, "");
  const title = (result.title || base).trim().slice(0, 120) || base;
  els.title.value = title;
  els.editor.value = result.markdown || "";
  store.setSlug(slugify(title) || "untitled");
  dirty = true;

  setMode("read");
  updateConnections();
  highlightActive();
  setAssetParam(null, "f");
  const url = new URL(location.href);
  url.searchParams.set("id", store.slug);
  url.searchParams.delete("new");
  history.pushState(null, "", url);

  const bytes = new Blob([JSON.stringify({ title, source: els.editor.value })]).size;
  if (!els.editor.value.trim()) {
    store.saveLocal();
    showStatus(`Imported "${title}", but no text could be extracted (it may be scanned images).`);
  } else if (bytes > 95_000) {
    // Over the per-note save limit — keep it locally and tell the user.
    store.saveLocal();
    showStatus(`Imported "${title}" — ${fmtBytes(bytes)}. Too large to sync; saved locally. Trim or split it.`);
  } else {
    store.change(); // autosave (local always; remote when signed in)
    showStatus(`Imported "${title}" (${fmtBytes(bytes)})`);
  }
}

// ?f=<name> loads a shipped example from /kb/examples/<name>.txt
async function loadExample(name) {
  try {
    const res = await fetch(`/kb/examples/${name}.txt`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Example "${name}" not found`);
    els.editor.value = await res.text();
    els.title.value = prettify(name);
    store.setSlug(slugify(name));
    dirty = false;
    setMode("read");
    store.saveLocal();
    showStatus(`Loaded "${name}"`);
  } catch (err) {
    showStatus(err.message);
    setAssetParam(null, "f");
  }
}

// ---- Markdown + wiki links --------------------------------------------------
// Turn [[Target]] / [[Target|label]] into real markdown links to ?id=<slug>,
// skipping fenced code blocks so literal brackets in code survive untouched.
function transformWikiLinks(md) {
  return String(md)
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (m, target, label) => {
            const slug = slugify(target);
            if (!slug) return m;
            const text = (label || target).trim();
            return `[${text}](?id=${slug})`;
          })
    )
    .join("");
}

function renderPreview() {
  const html = window.marked ? marked.parse(transformWikiLinks(els.editor.value)) : "";
  els.preview.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  const exists = existsSet();
  els.preview.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (href.startsWith("?id=")) {
      const slug = slugify(href.slice(4));
      a.classList.add("wikilink");
      if (!exists.has(slug)) a.classList.add("broken");
      a.dataset.slug = slug;
    } else if (/^https?:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  });
}

// Slugs referenced by a note's source.
function outgoingSlugs(source) {
  const out = new Set();
  String(source)
    .split(/(```[\s\S]*?```)/g)
    .forEach((seg, i) => {
      if (i % 2 === 1) return;
      let m;
      const re = /\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
      while ((m = re.exec(seg))) {
        const slug = slugify(m[1]);
        if (slug) out.add(slug);
      }
    });
  return out;
}

// ---- Connections panel ------------------------------------------------------
function updateConnections() {
  const current = store.slug;
  // Reflect the live note so its own outgoing links are always up to date.
  noteCache.set(current, { title: els.title.value, source: els.editor.value });

  const outs = [...outgoingSlugs(els.editor.value)].filter((s) => s !== current);
  renderLinks(els.outLinks, outs, "No outgoing links yet.");

  const backs = [];
  for (const [slug, note] of noteCache) {
    if (slug === current || !note) continue;
    if (outgoingSlugs(note.source || "").has(current)) backs.push(slug);
  }
  backs.sort((a, b) => titleForSlug(a).localeCompare(titleForSlug(b)));
  renderLinks(els.backLinks, backs, indexBuilt ? "No backlinks yet." : "Loading…");
}

function renderLinks(container, slugs, emptyText) {
  if (!slugs.length) {
    container.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  const exists = existsSet();
  container.innerHTML = slugs
    .map((slug) => {
      const title = titleForSlug(slug);
      const broken = !exists.has(slug) ? " broken" : "";
      return `<button type="button" class="link${broken}" data-slug="${esc(slug)}" data-title="${esc(title)}">${esc(title)}</button>`;
    })
    .join("");
}

// ---- Sidebar list -----------------------------------------------------------
function refreshList(items) {
  if (Array.isArray(items)) {
    allItems = items;
    slugTitle.clear();
    for (const it of items) slugTitle.set(it.slug, it.title || it.slug);
  } else {
    // Called as an onSaved hook (no args) — re-pull the list.
    listAssets(TOOL).then(refreshList).catch(() => {});
    return;
  }
  renderList();
  updateConnections(); // existence may have changed (broken -> resolved)
}

function renderList() {
  const q = els.search.value.trim().toLowerCase();
  let items = allItems;
  if (q) {
    items = items.filter((it) => {
      if ((it.title || it.slug).toLowerCase().includes(q)) return true;
      const note = noteCache.get(it.slug);
      return note && (note.source || "").toLowerCase().includes(q);
    });
  }

  if (!allItems.length) {
    els.sideNote.textContent = store.signedIn
      ? "No notes yet — start writing."
      : "Sign in to keep a wiki of notes.";
  } else {
    els.sideNote.textContent = q
      ? `${items.length} of ${allItems.length} notes`
      : `${allItems.length} note${allItems.length === 1 ? "" : "s"}`;
  }

  const current = store.slug;
  els.noteList.innerHTML = items
    .map((it) => {
      const on = it.slug === current ? " active" : "";
      return `<button type="button" class="note-row${on}" data-slug="${esc(it.slug)}">${esc(it.title || it.slug)}</button>`;
    })
    .join("");
}

function highlightActive() {
  renderList();
}

// ---- Content index (backlinks + full-text search) ---------------------------
async function buildIndex() {
  if (indexBuilt) return;
  let items;
  try {
    items = await listAssets(TOOL);
  } catch {
    return; // signed out — nothing to index
  }
  await Promise.all(
    items.map(async (it) => {
      if (noteCache.has(it.slug) && noteCache.get(it.slug)) return;
      try {
        noteCache.set(it.slug, await getAsset(TOOL, it.slug));
      } catch {
        noteCache.set(it.slug, null);
      }
    })
  );
  indexBuilt = true;
  updateConnections();
}

// ---- Helpers ----------------------------------------------------------------
function existsSet() {
  const set = new Set(slugTitle.keys());
  for (const [slug, note] of noteCache) if (note) set.add(slug);
  return set;
}

function titleForSlug(slug) {
  return slugTitle.get(slug) || noteCache.get(slug)?.title || prettify(slug);
}

function prettify(slug) {
  return String(slug).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Untitled";
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function showStatus(message) {
  els.status.textContent = message;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
