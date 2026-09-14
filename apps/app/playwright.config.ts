import { defineConfig, devices } from "@playwright/test";

// The rev1 suite (login, pay, page-load) and its production-build webServer
// land in WL-46 (ARCHITECTURE.md §6.3). Until then ./e2e holds no spec and
// `test:e2e` passes with no tests; WL-47 removes --pass-with-no-tests.
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: isCI,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
