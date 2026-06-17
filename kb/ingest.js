// Knowledge Base — client-side ingest of uploaded sources into markdown.
//
// Everything runs in the browser (the site is static, no server to parse on):
//   - PDF  -> pdf.js extracts the text layer, page by page.
//   - EPUB -> JSZip reads the archive, Turndown converts each spine chapter's
//             XHTML into markdown.
// The heavy libraries load lazily from CDN only when an import actually runs,
// so they never weigh down a normal page load.

let pdfjsP, jszipP, turndownP;

function loadPdfjs() {
  // Library and worker come from the SAME version range so their internal
  // version check always matches.
  if (!pdfjsP) {
    pdfjsP = import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs";
      return mod;
    });
  }
  return pdfjsP;
}
function loadJszip() {
  if (!jszipP) jszipP = import("https://esm.sh/jszip@3").then((m) => m.default || m);
  return jszipP;
}
function loadTurndown() {
  if (!turndownP) turndownP = import("https://esm.sh/turndown@7").then((m) => m.default || m);
  return turndownP;
}

// Dispatch on extension -> { title, markdown }. Throws on unsupported types.
export async function extractFile(file, onProgress = () => {}) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return extractPdf(file, onProgress);
  if (ext === "epub") return extractEpub(file, onProgress);
  throw new Error("Only PDF and EPUB files are supported");
}

// ---- PDF --------------------------------------------------------------------
async function extractPdf(file, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;

  let title = "";
  try {
    const meta = await doc.getMetadata();
    title = (meta?.info?.Title || "").trim();
  } catch {
    /* metadata is optional */
  }

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress(`Extracting page ${i} / ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = pageText(content);
    if (text) pages.push(text);
  }
  doc.destroy?.();
  return { title, markdown: pages.join("\n\n").trim() };
}

// pdf.js gives positioned text runs; rebuild lines from the end-of-line flags.
function pageText(content) {
  let out = "";
  for (const it of content.items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- EPUB -------------------------------------------------------------------
async function extractEpub(file, onProgress) {
  const JSZip = await loadJszip();
  const Turndown = await loadTurndown();
  const td = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const parser = new DOMParser();

  const zip = await JSZip.loadAsync(file);

  // META-INF/container.xml points at the package (.opf) document.
  const container = zip.file("META-INF/container.xml");
  if (!container) throw new Error("Not a valid EPUB (no container.xml)");
  const containerDoc = parser.parseFromString(await container.async("string"), "application/xml");
  const opfPath = containerDoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new Error("Not a valid EPUB (no package document)");
  const opfDir = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";

  const opf = parser.parseFromString(await zip.file(opfPath).async("string"), "application/xml");
  const title = firstLocal(opf, "title");

  // manifest: id -> href ; spine: ordered list of idrefs.
  const manifest = {};
  for (const it of opf.getElementsByTagName("item")) {
    manifest[it.getAttribute("id")] = it.getAttribute("href");
  }
  const spine = [...opf.getElementsByTagName("itemref")].map((r) => r.getAttribute("idref"));

  const parts = [];
  let n = 0;
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    const path = resolvePath(opfDir, href);
    const entry = zip.file(path);
    if (!entry) continue;
    n++;
    onProgress(`Converting chapter ${n} / ${spine.length}…`);
    const dom = parser.parseFromString(await entry.async("string"), "text/html");
    dom.querySelectorAll("script, style, svg, img").forEach((el) => el.remove());
    const md = td.turndown((dom.body || dom.documentElement).innerHTML).trim();
    if (md) parts.push(md);
  }
  return { title, markdown: parts.join("\n\n---\n\n").trim() };
}

// First element with this local name, regardless of XML namespace prefix
// (EPUB metadata is <dc:title>, etc.).
function firstLocal(doc, local) {
  for (const el of doc.getElementsByTagName("*")) {
    if (el.localName === local) return (el.textContent || "").trim();
  }
  return "";
}

// Resolve an EPUB href (relative to the .opf's folder), collapsing ../ and ./.
function resolvePath(dir, href) {
  const clean = decodeURIComponent(href.split("#")[0]);
  const out = [];
  for (const part of (dir + clean).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
