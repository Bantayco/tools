// Smoke test for the Knowledge Base tool.
//
// Runs against the static server (signed out — no /api), so it covers the
// load-bearing client path: the wiki renders markdown, [[wiki links]] become
// clickable links, a broken link opens a fresh note to write, and the
// read/edit toggle and live preview behave.
import { test, expect } from "@playwright/test";

test("default note renders in read mode with wiki links", async ({ page }) => {
  await page.goto("/kb/");

  // Read mode: the rendered article shows, the source textarea is hidden.
  await expect(page.locator("#preview")).toContainText("Welcome to your Knowledge Base");
  await expect(page.locator("#editor")).toBeHidden();

  // A link to a not-yet-written note renders as a "broken" wiki link.
  // (The welcome note links to Data Ingest more than once, so scope to the first.)
  const dataIngest = page.locator("#preview a.wikilink", { hasText: "Data Ingest" }).first();
  await expect(dataIngest).toHaveClass(/broken/);
});

test("clicking a broken wiki link starts that note", async ({ page }) => {
  await page.goto("/kb/");

  await page.locator("#preview a.wikilink", { hasText: "Data Ingest" }).first().click();

  // Lands on a fresh, writable note seeded with the link's title.
  await expect(page).toHaveURL(/\?id=data-ingest/);
  await expect(page.locator("#title")).toHaveValue("Data Ingest");
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("");
});

test("live preview, outgoing links, and read/edit toggle", async ({ page }) => {
  await page.goto("/kb/?new=1");

  // Fresh note opens ready to write.
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#editor")).toHaveValue("");

  await page.locator("#title").fill("Transformers");
  await page.locator("#editor").fill("# Transformers\n\nSee [[Attention]] for the core idea.");

  // Preview renders the heading; the [[Attention]] link shows as an outgoing link.
  await expect(page.locator("#preview h1")).toHaveText("Transformers");
  await expect(page.locator("#preview a.wikilink", { hasText: "Attention" })).toBeVisible();
  await expect(page.locator("#outLinks .link", { hasText: "Attention" })).toBeVisible();

  // Read mode hides the source and keeps the rendered note.
  await page.locator("#viewToggle").click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#preview h1")).toHaveText("Transformers");

  // Back to edit.
  await page.locator("#viewToggle").click();
  await expect(page.locator("#editor")).toBeVisible();
});

test("import accepts PDF and EPUB sources", async ({ page }) => {
  await page.goto("/kb/?new=1");

  // The Import control is present and the picker is scoped to PDF/EPUB.
  await expect(page.locator("#importBtn")).toBeVisible();
  const accept = await page.locator("#fileInput").getAttribute("accept");
  expect(accept).toContain(".pdf");
  expect(accept).toContain(".epub");

  // A small EPUB extracts its title + chapter text into a new note.
  await page.locator("#fileInput").setInputFiles({
    name: "sample.epub",
    mimeType: "application/epub+zip",
    buffer: makeEpub(),
  });

  await expect(page.locator("#title")).toHaveValue("Sample Book", { timeout: 15_000 });
  await expect(page.locator("#preview")).toContainText("Chapter One");
  await expect(page.locator("#preview")).toContainText("the body text of the first chapter");
});

// Build a minimal valid EPUB (a ZIP with the required container + package +
// one XHTML chapter) entirely in-memory, so the test needs no fixture files.
function makeEpub() {
  const files = {
    "mimetype": "application/epub+zip",
    "META-INF/container.xml":
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OEBPS/content.opf":
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample Book</dc:title></metadata>` +
      `<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>` +
      `<spine><itemref idref="c1"/></spine></package>`,
    "OEBPS/ch1.xhtml":
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
      `<h1>Chapter One</h1><p>This is the body text of the first chapter.</p></body></html>`,
  };
  return zip(files);
}

// Minimal STORE-only (no compression) ZIP writer — enough for JSZip to read.
function zip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  const push = (arr) => { chunks.push(arr); offset += arr.length; };

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      nameBytes, data,
    ]);
    central.push({ name: nameBytes, crc, size: data.length, offset });
    push(local);
  }

  const cdStart = offset;
  for (const e of central) {
    push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(e.crc), u32(e.size), u32(e.size),
      u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset),
      e.name,
    ]));
  }
  const cdSize = offset - cdStart;
  push(concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cdSize), u32(cdStart), u16(0),
  ]));

  return Buffer.from(concat(chunks));
}

function concat(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
