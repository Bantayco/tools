// Spout — folder-aware text/code editor.
//   - File System Access API for the folder tree + read/write (Chromium).
//   - CodeMirror 5 (global) for editing; marked + DOMPurify for markdown preview.
//   - ruff-wasm (lazy) for Python linting.
// cache-bust: served with no-long-cache headers.

const $ = (s, r = document) => r.querySelector(s);

const els = {
  status: $("#status"),
  openFolder: $("#openFolder"),
  openFolder2: $("#openFolder2"),
  newFile: $("#newFile"),
  newFile2: $("#newFile2"),
  rootName: $("#rootName"),
  refreshTree: $("#refreshTree"),
  fileTree: $("#fileTree"),
  tabbar: $("#tabbar"),
  filepath: $("#filepath"),
  previewToggle: $("#previewToggle"),
  editorBody: $("#editorBody"),
  cmHost: $("#cmHost"),
  previewPane: $("#previewPane"),
  emptyState: $("#emptyState"),
  fsaNote: $("#fsaNote"),
  statusbar: $("#statusbar"),
};

const fsaSupported = typeof window.showDirectoryPicker === "function";
const saveSupported = typeof window.showSaveFilePicker === "function";

// ---- Language detection -----------------------------------------------------
// extension -> CodeMirror mode spec
const MODES = {
  js: { name: "javascript" }, mjs: { name: "javascript" }, cjs: { name: "javascript" },
  jsx: { name: "javascript" }, ts: { name: "javascript", typescript: true },
  tsx: { name: "javascript", typescript: true },
  json: { name: "javascript", json: true },
  py: { name: "python" }, pyi: { name: "python" },
  md: { name: "gfm" }, markdown: { name: "gfm" }, mdx: { name: "gfm" },
  html: { name: "htmlmixed" }, htm: { name: "htmlmixed" }, vue: { name: "htmlmixed" },
  xml: { name: "xml" }, svg: { name: "xml" }, rss: { name: "xml" },
  css: { name: "css" }, scss: { name: "css" }, less: { name: "css" },
  yml: { name: "yaml" }, yaml: { name: "yaml" },
  sh: { name: "shell" }, bash: { name: "shell" }, zsh: { name: "shell" },
  c: { name: "text/x-csrc" }, h: { name: "text/x-csrc" },
  cpp: { name: "text/x-c++src" }, cc: { name: "text/x-c++src" }, hpp: { name: "text/x-c++src" },
  java: { name: "text/x-java" }, cs: { name: "text/x-csharp" },
  go: { name: "text/x-go" }, rs: { name: "rust" },
  sql: { name: "sql" }, toml: { name: "toml" },
};
const LANG_LABEL = {
  javascript: "JavaScript", python: "Python", gfm: "Markdown", htmlmixed: "HTML",
  xml: "XML", css: "CSS", yaml: "YAML", shell: "Shell", rust: "Rust", sql: "SQL", toml: "TOML",
};

function extOf(name) {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
function modeForName(name) {
  return MODES[extOf(name)] || { name: "null" };
}
function isMarkdown(name) {
  return ["md", "markdown", "mdx"].includes(extOf(name));
}
function isPython(name) {
  return ["py", "pyi"].includes(extOf(name));
}
function langLabel(name) {
  const m = modeForName(name);
  if (m.json) return "JSON";
  return LANG_LABEL[m.name] || (extOf(name) ? extOf(name).toUpperCase() : "Plain text");
}

// ---- Editor -----------------------------------------------------------------
const cm = CodeMirror(els.cmHost, {
  lineNumbers: true,
  lineWrapping: false,
  matchBrackets: true,
  autoCloseBrackets: true,
  styleActiveLine: true,
  indentUnit: 4,
  tabSize: 4,
  gutters: ["CodeMirror-lint-markers", "CodeMirror-linenumbers"],
  lint: false,
  extraKeys: {
    "Cmd-/": "toggleComment",
    "Ctrl-/": "toggleComment",
    Tab: (editor) => editor.somethingSelected()
      ? editor.indentSelection("add")
      : editor.replaceSelection("    ", "end"),
  },
});

cm.on("change", () => {
  const t = active();
  if (!t) return;
  renderTabs();
  if (t.isMd && t.preview) updatePreview();
  updateStatus();
});
cm.on("cursorActivity", updateStatus);

// ---- Tabs / state -----------------------------------------------------------
let uid = 0;
const tabs = [];
let activeId = null;
let rootHandle = null;

const active = () => tabs.find((t) => t.id === activeId) || null;

function addTab({ name, path, handle, text }) {
  const modeSpec = modeForName(name);
  const doc = CodeMirror.Doc(text, modeSpec);
  const id = ++uid;
  const tab = {
    id, name, path: path || `untitled:${id}`, handle: handle || null,
    doc, modeSpec, isMd: isMarkdown(name), preview: false,
    savedGen: doc.changeGeneration(),
  };
  tabs.push(tab);
  activateTab(id);
}

function activateTab(id) {
  activeId = id;
  const t = active();
  if (!t) { showEmpty(); return; }
  els.emptyState.hidden = true;
  cm.swapDoc(t.doc);
  cm.setOption("mode", t.modeSpec);
  cm.setOption("lint", isPython(t.name) ? PY_LINT : false);
  renderTabs();
  updatePreview();
  updateStatus();
  cm.focus();
  setTimeout(() => cm.refresh(), 0);
  markActiveInTree(t.path);
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = tabs[i];
  if (!t.doc.isClean(t.savedGen) && !confirm(`Discard unsaved changes to ${t.name}?`)) return;
  tabs.splice(i, 1);
  if (activeId === id) {
    const next = tabs[i] || tabs[i - 1];
    if (next) activateTab(next.id);
    else { activeId = null; showEmpty(); }
  }
  renderTabs();
}

function showEmpty() {
  els.emptyState.hidden = false;
  els.editorBody.classList.remove("split");
  els.previewPane.hidden = true;
  els.filepath.textContent = "";
  els.previewToggle.hidden = true;
  cm.swapDoc(CodeMirror.Doc("", { name: "null" }));
  updateStatus();
}

function renderTabs() {
  els.tabbar.textContent = "";
  for (const t of tabs) {
    const dirty = !t.doc.isClean(t.savedGen);
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    el.setAttribute("role", "tab");
    el.title = t.handle ? t.path : `${t.name} (unsaved)`;
    const dot = dirty ? '<span class="dot">●</span>' : "";
    el.innerHTML = `${dot}<span class="tname">${esc(t.name)}</span><span class="tclose" title="Close">×</span>`;
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("tclose")) closeTab(t.id);
      else activateTab(t.id);
    });
    els.tabbar.append(el);
  }
  const t = active();
  els.filepath.textContent = t ? (t.handle ? t.path : `${t.name} · unsaved`) : "";
  els.previewToggle.hidden = !(t && t.isMd);
  els.previewToggle.classList.toggle("on", !!(t && t.preview));
}

// ---- Markdown preview -------------------------------------------------------
els.previewToggle.addEventListener("click", () => {
  const t = active();
  if (!t || !t.isMd) return;
  t.preview = !t.preview;
  renderTabs();
  updatePreview();
});

function updatePreview() {
  const t = active();
  const show = !!(t && t.isMd && t.preview);
  els.previewPane.hidden = !show;
  els.editorBody.classList.toggle("split", show);
  if (show) {
    const html = window.marked ? marked.parse(cm.getValue()) : "";
    els.previewPane.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  }
  setTimeout(() => cm.refresh(), 0);
}

// ---- Status bar -------------------------------------------------------------
let lintCount = 0;
function updateStatus() {
  const t = active();
  if (!t) { els.statusbar.textContent = ""; return; }
  const pos = cm.getCursor();
  const parts = [
    `<span>${esc(langLabel(t.name))}</span>`,
    `<span>Ln ${pos.line + 1}, Col ${pos.ch + 1}</span>`,
    `<span>${cm.lineCount()} lines</span>`,
  ];
  if (isPython(t.name)) {
    parts.push(`<span class="sb-problems${lintCount ? " has" : ""}">${lintCount ? lintCount + " problem" + (lintCount === 1 ? "" : "s") : "no problems"}</span>`);
  }
  els.statusbar.innerHTML = parts.join("");
}

function flashStatus(msg) {
  els.status.textContent = msg;
}

// ---- Python linting via ruff-wasm (lazy) ------------------------------------
let ruffPromise = null;
let ruffWorkspace = null;
let ruffBroken = false;

async function ensureRuff() {
  if (ruffWorkspace) return ruffWorkspace;
  if (ruffBroken) return null;
  if (!ruffPromise) {
    ruffPromise = (async () => {
      const mod = await import("https://esm.sh/@astral-sh/ruff-wasm-web@0.15.16");
      await mod.default();
      ruffWorkspace = new mod.Workspace(mod.Workspace.defaultSettings());
      return ruffWorkspace;
    })().catch((err) => {
      ruffBroken = true;
      console.warn("Spout: Python linter unavailable —", err);
      return null;
    });
  }
  return ruffPromise;
}

async function lintPython(text) {
  const ws = await ensureRuff();
  if (!ws) return [];
  let diags;
  try { diags = ws.check(text); } catch (err) { console.warn("ruff check failed", err); return []; }
  return diags.map((d) => {
    const sr = (d.location?.row || 1) - 1;
    const sc = (d.location?.column || 1) - 1;
    const er = (d.end_location?.row || d.location?.row || 1) - 1;
    const ec = (d.end_location?.column || (d.location?.column || 1) + 1) - 1;
    return {
      message: (d.code ? d.code + ": " : "") + d.message,
      severity: /^(E9|F82|F40|F70|E11)/.test(d.code || "") ? "error" : "warning",
      from: CodeMirror.Pos(sr, sc),
      to: CodeMirror.Pos(Math.max(er, sr), Math.max(ec, sc + 1)),
    };
  });
}

const PY_LINT = {
  async: true,
  getAnnotations(text, updateLinting) {
    lintPython(text)
      .then((annotations) => { lintCount = annotations.length; updateLinting(annotations); updateStatus(); })
      .catch(() => { lintCount = 0; updateLinting([]); });
  },
};

// ---- File System Access: folder tree ----------------------------------------
async function pickFolder() {
  if (!fsaSupported) { flashStatus("Folder access needs a Chromium browser"); return; }
  let handle;
  try { handle = await window.showDirectoryPicker({ mode: "readwrite" }); }
  catch (err) { if (err.name !== "AbortError") flashStatus("Could not open folder"); return; }
  rootHandle = handle;
  els.rootName.textContent = handle.name;
  els.refreshTree.hidden = false;
  await renderTree();
  flashStatus(`Opened ${handle.name}`);
}

async function renderTree() {
  els.fileTree.textContent = "";
  try {
    els.fileTree.append(await dirToList(rootHandle, 0, ""));
  } catch (err) {
    flashStatus("Could not read folder");
  }
}

async function dirToList(dirHandle, depth, parentPath) {
  const ul = document.createElement("ul");
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) entries.push([name, handle]);
  entries.sort((a, b) => {
    if (a[1].kind !== b[1].kind) return a[1].kind === "directory" ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  for (const [name, handle] of entries) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "node " + handle.kind;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = path;

    if (handle.kind === "directory") {
      row.innerHTML = `<span class="caret">▸</span><span class="name">${esc(name)}</span>`;
      let childUl = null;
      row.addEventListener("click", async () => {
        const open = row.classList.toggle("open");
        if (open) {
          if (!childUl) { childUl = await dirToList(handle, depth + 1, path); li.append(childUl); }
          else childUl.style.display = "";
        } else if (childUl) childUl.style.display = "none";
      });
    } else {
      row.innerHTML = `<span class="fic"></span><span class="name">${esc(name)}</span>`;
      row.addEventListener("click", () => openFile(handle, path));
    }
    li.append(row);
    ul.append(li);
  }
  return ul;
}

function markActiveInTree(path) {
  els.fileTree.querySelectorAll(".node.active").forEach((n) => n.classList.remove("active"));
  const node = els.fileTree.querySelector(`.node.file[data-path="${cssEscape(path)}"]`);
  if (node) node.classList.add("active");
}

async function openFile(handle, path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) { activateTab(existing.id); return; }
  let text;
  try {
    const file = await handle.getFile();
    if (file.size > 3_000_000) { flashStatus(`${handle.name} is too large to open`); return; }
    text = await file.text();
  } catch (err) { flashStatus(`Could not read ${handle.name}`); return; }
  addTab({ name: handle.name, path, handle, text });
}

// ---- Save -------------------------------------------------------------------
async function saveActive() {
  const t = active();
  if (!t) return;
  try {
    if (!t.handle) {
      if (saveSupported) {
        t.handle = await window.showSaveFilePicker({ suggestedName: t.name });
        t.name = t.handle.name;
        t.path = t.name;
        t.isMd = isMarkdown(t.name);
        t.modeSpec = modeForName(t.name);
        cm.setOption("mode", t.modeSpec);
        cm.setOption("lint", isPython(t.name) ? PY_LINT : false);
      } else {
        downloadText(t.name, t.doc.getValue());
        flashStatus(`Downloaded ${t.name}`);
        return;
      }
    }
    const writable = await t.handle.createWritable();
    await writable.write(t.doc.getValue());
    await writable.close();
    t.savedGen = t.doc.changeGeneration();
    renderTabs();
    updateStatus();
    flashStatus(`Saved ${t.name}`);
  } catch (err) {
    if (err.name !== "AbortError") flashStatus(`Save failed: ${err.message}`);
  }
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---- New file ---------------------------------------------------------------
function newFile() {
  const name = (prompt("New file name", "untitled.md") || "").trim();
  if (!name) return;
  if (tabs.some((t) => !t.handle && t.name === name)) { flashStatus("A file with that name is already open"); return; }
  addTab({ name, path: null, handle: null, text: "" });
}

// ---- Wiring -----------------------------------------------------------------
els.openFolder.addEventListener("click", pickFolder);
els.openFolder2.addEventListener("click", pickFolder);
els.newFile.addEventListener("click", newFile);
els.newFile2.addEventListener("click", newFile);
els.refreshTree.addEventListener("click", renderTree);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveActive();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (tabs.some((t) => !t.doc.isClean(t.savedGen))) { e.preventDefault(); e.returnValue = ""; }
});

if (!fsaSupported) { els.fsaNote.hidden = false; }
showEmpty();

// Expose a tiny hook (used by "New file" flow + debugging).
window.spout = { openText: (name, text = "") => addTab({ name, path: null, handle: null, text }) };

// ---- helpers ----------------------------------------------------------------
function esc(v) {
  return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function cssEscape(v) {
  return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");
}
