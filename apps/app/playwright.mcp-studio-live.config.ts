import { defineConfig } from "@playwright/test";

// The MCP Studio live test (lane M17, #5139). It runs only from
// .github/workflows/mcp-studio-live.yml, against production Oxagen, the
// steering live test's GitHub test organization, and sample servers the
// workflow starts on the runner. It opens no browser.
//
// Like playwright.live.config.ts, it stays apart from playwright.config.ts,
// which holds the three rev1 e2e specs INV-20 fixes (ARCHITECTURE.md §6.3).
// It matches only live/mcp-studio.live.ts, which no vitest include, no e2e
// project, and not the steering live config match.
export default defineConfig({
  testDir: "./live",
  testMatch: /mcp-studio\.live\.ts$/,
  forbidOnly: true,
  retries: 0,
  // The tests share one workspace and run in file order in one worker.
  workers: 1,
  fullyParallel: false,
  // The slowest test merges four steering PRs, each waiting up to five
  // minutes for its check and three for the published version.
  timeout: 35 * 60_000,
  // Below the job's 90-minute limit, so a hung run still writes its report
  // and the cleanup step still runs.
  globalTimeout: 75 * 60_000,
  globalTeardown: "./live/mcp-studio-teardown.ts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/mcp-studio-live" }],
  ],
  // The tests call HTTP APIs and never open a page, so there is no trace to keep.
  use: { trace: "off" },
});
