import { defineConfig } from "@playwright/test";

// The steering repo live test (lane S11, #4723). It runs only from
// .github/workflows/steering-live.yml, against production Oxagen and a GitHub
// test organization, and opens no browser.
//
// It stays apart from playwright.config.ts on purpose. That config holds the
// three rev1 e2e specs INV-20 fixes (ARCHITECTURE.md §6.3), needs a built app
// to serve, and matches nothing under live/. This one matches only
// live/steering-repo.live.ts, which no vitest include and no e2e project
// matches. The MCP Studio live test (M17) shares live/ and has its own
// config, playwright.mcp-studio-live.config.ts.
export default defineConfig({
  testDir: "./live",
  testMatch: /steering-repo\.live\.ts$/,
  forbidOnly: true,
  retries: 0,
  // The tests share one workspace and run in file order in one worker.
  workers: 1,
  fullyParallel: false,
  // Each test waits on GitHub webhooks and provisioning. The slowest test
  // polls for at most ten minutes in total.
  timeout: 15 * 60_000,
  // Below the job's 60-minute limit, so a hung run still writes its report
  // and the cleanup step still runs.
  globalTimeout: 40 * 60_000,
  globalTeardown: "./live/steering-teardown.ts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/steering-live" }],
  ],
  // The tests call HTTP APIs and never open a page, so there is no trace to keep.
  use: { trace: "off" },
});
