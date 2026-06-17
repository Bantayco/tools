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
  const dataIngest = page.locator("#preview a.wikilink", { hasText: "Data Ingest" });
  await expect(dataIngest).toHaveClass(/broken/);
});

test("clicking a broken wiki link starts that note", async ({ page }) => {
  await page.goto("/kb/");

  await page.locator("#preview a.wikilink", { hasText: "Data Ingest" }).click();

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
