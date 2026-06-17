// Playwright config for the tools' smoke tests.
//
// Tests run against the SAME static server the tools use in local dev
// (`npm run static` → python3 -m http.server 8000), served from the repo
// root so the absolute `/_shared/...` imports resolve exactly as on Pages.
import { defineConfig, devices } from "@playwright/test";

const PORT = 8000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Boot the static server for the run and tear it down after.
  webServer: {
    command: "python3 -m http.server " + PORT,
    url: baseURL + "/doomscroll/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
