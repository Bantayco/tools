// Smoke test for the Paper Doomscroll tool.
//
// Covers the load-bearing path: paste board -> load the shipped sample ->
// start the feed -> the dopamine loop actually fires (XP/streak/progress as
// you scroll, likes toggle) -> scrolling to the bottom reaches the finale
// with a non-zero score. It deliberately avoids asserting the *random*
// rewards (surprise cheers fire ~45% of the time) and only checks the
// deterministic mechanics.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // ?new=1 ignores any saved draft so the run starts from a clean slate.
  await page.goto("/doomscroll/?new=1");
});

test("loads the sample and starts the feed", async ({ page }) => {
  await expect(page.locator("#setup")).toBeVisible();
  await expect(page.locator("#feed")).toBeHidden();

  await page.locator("#loadSample").click();
  await expect(page.locator("#title")).toHaveValue(/Attention Economy/i);
  await expect(page.locator("#source")).not.toHaveValue("");

  await page.locator("#start").click();

  // Feed takes over; the paste board steps aside.
  await expect(page.locator("#feed")).toBeVisible();
  await expect(page.locator("#setup")).toBeHidden();

  // A real paper makes plenty of cards.
  const cards = page.locator(".card");
  expect(await cards.count()).toBeGreaterThan(5);

  // Reaching the very first card already pays out: level shown, streak >= 1,
  // and the progress bar has moved off zero.
  await expect(page.locator("#level")).toHaveText(/Lv \d+/);
  await expect(page.locator("#streak")).toHaveText(/🔥 [1-9]/);
  const width = await page.locator("#progressBar").evaluate((el) => el.style.width);
  expect(parseFloat(width)).toBeGreaterThan(0);
});

test("liking a card toggles the heart and pays XP", async ({ page }) => {
  await startFeed(page);

  const likeBtn = page.locator(".card button[data-like]").first();
  const ico = likeBtn.locator(".ico");
  const count = likeBtn.locator("[data-count]");

  await expect(ico).toHaveText("🤍");
  await expect(count).toHaveText("0");

  await likeBtn.click();

  await expect(ico).toHaveText("❤️");
  await expect(count).toHaveText("1");
  await expect(likeBtn).toHaveClass(/on/);
});

test("scrolling to the bottom reaches the finale with a non-zero score", async ({ page }) => {
  await startFeed(page);

  const total = await page.locator(".card").count();

  // Land on each card in turn so the IntersectionObserver awards every step.
  for (let i = 1; i < total; i++) {
    await page.evaluate((idx) => {
      const c = document.querySelector("#cards");
      c.scrollTo({ top: idx * c.clientHeight, behavior: "instant" });
    }, i);
    await page.waitForTimeout(120);
  }

  // The finale card and its tally.
  const end = page.locator(".card.is-end");
  await expect(end).toBeVisible();
  await expect(end.locator(".body")).toContainText(/finished/i);

  const xp = parseInt(await page.locator("#endXp").textContent(), 10);
  const level = parseInt(await page.locator("#endLevel").textContent(), 10);
  const best = parseInt(await page.locator("#endStreak").textContent(), 10);
  expect(xp).toBeGreaterThan(0);
  expect(level).toBeGreaterThanOrEqual(1);
  // Streak accumulates across scrolls (don't pin it to the exact card count —
  // the observer can coalesce a couple of rapid steps).
  expect(best).toBeGreaterThan(1);

  // Progress bar is full.
  const width = await page.locator("#progressBar").evaluate((el) => parseFloat(el.style.width));
  expect(width).toBe(100);
});

// Helper: from the paste board, load the sample and enter the feed.
async function startFeed(page) {
  await page.locator("#loadSample").click();
  await expect(page.locator("#source")).not.toHaveValue("");
  await page.locator("#start").click();
  await expect(page.locator("#feed")).toBeVisible();
}
