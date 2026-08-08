// Smoke test for the fastenAIting tool.
//
// The AI identifier requires an Anthropic key at runtime, so this test skips
// the /api/fastenaiting/identify call entirely and only exercises the offline
// path: manual form entry -> label renders -> buy links become clickable.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // clear settings so tests start clean
  await page.addInitScript(() => {
    try { localStorage.removeItem("fastenaiting:settings:v1"); } catch {}
  });
  await page.goto("/fastenaiting/");
});

test("page loads with tabs and placeholder canvas", async ({ page }) => {
  await expect(page.locator("h1")).toContainText(/fasten/i);
  await expect(page.locator(".tabs .tab.on")).toHaveText(/camera/i);
  const canvas = page.locator("#labelCanvas");
  await expect(canvas).toBeVisible();
  const { w, h } = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
  expect(w).toBeGreaterThan(400);   // 60mm at 360dpi ≈ 851
  expect(h).toBeGreaterThan(120);   // 12mm at 360dpi ≈ 170
});

test("filling the form updates the label and activates buy links", async ({ page }) => {
  // Manual entry: fill a screw so we get a meaningful search query.
  await page.selectOption('[name="category"]', "Screw");
  await page.fill('[name="subtype"]', "Wood");
  await page.selectOption('[name="head"]', "Pan");
  await page.selectOption('[name="drive"]', "Phillips");
  await page.fill('[name="size"]', "#8");
  await page.fill('[name="length"]', '1 1/4"');
  await page.selectOption('[name="finish"]', "Zinc-plated");
  await page.fill('[name="color"]', "silver");

  // Buy links: all three become .ready
  for (const cls of ["home-depot", "lowes", "amazon"]) {
    const link = page.locator(`a.buy.${cls}`);
    await expect(link).toHaveClass(/ready/);
    const href = await link.getAttribute("href");
    expect(href).toContain("8"); // the gauge should appear in the query
  }

  // The canvas has actual non-white pixels (the label rendered something).
  const hasInk = await page.locator("#labelCanvas").evaluate((c) => {
    const ctx = c.getContext("2d");
    // sample a mid-height strip of pixels
    const y = Math.floor(c.height / 2);
    const data = ctx.getImageData(0, y, c.width, 1).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (brightness < 230) dark++;
    }
    return dark;
  });
  expect(hasInk).toBeGreaterThan(20);
});

test("download button emits a PNG", async ({ page }) => {
  await page.fill('[name="size"]', "M6");
  await page.fill('[name="length"]', "30mm");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#downloadLabel").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
});
