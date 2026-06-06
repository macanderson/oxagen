import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  globalSetup: "./e2e/fixtures/global-setup.ts",
  globalTeardown: "./e2e/fixtures/global-setup.ts",
  testDir: "./e2e",
  // Helpers under `e2e/helpers/**` are imported by specs but contain no
  // tests themselves — exclude them from the Playwright test matcher so
  // they don't get reported as empty test files.
  testIgnore: ["**/helpers/**"],
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // In CI we serve a production build (`next start`); the gate builds the
    // app in a prior step so this just boots it. Locally we use the dev
    // server for fast iteration.
    command: process.env.CI ? "pnpm start" : "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // E2E serves a production build over http; tell Better Auth not to use
    // `__Secure-` cookies so the auth helper's injected session is honored.
    env: { ...process.env, E2E_TEST: "true" },
  },
});
