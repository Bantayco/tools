// End-to-end tests against the real Worker + Durable Objects (wrangler dev /
// Miniflare), with a throwaway state dir so every run starts empty.
import { defineConfig, devices } from "@playwright/test";

const PORT = 8790;
const executablePath = process.env.PW_CHROMIUM || undefined; // e.g. /opt/pw-browsers/chromium

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } }],
  webServer: {
    command:
      `rm -rf .wrangler/e2e && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to .wrangler/e2e ` +
      `--var PUBLISH_KEY:test-publish --var ADMIN_KEY:test-admin`,
    url: `http://127.0.0.1:${PORT}/robots.txt`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
