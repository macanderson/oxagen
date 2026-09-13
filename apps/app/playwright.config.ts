import { defineConfig, devices } from "@playwright/test";

// One port for the dev server and the browser. Parallel sessions on one machine
// pick distinct ports with E2E_PORT (e.g. E2E_PORT=3100).
const port = Number.parseInt(process.env.E2E_PORT ?? "3000", 10);
const baseURL = `http://localhost:${String(port)}`;
const isCI = Boolean(process.env.CI);

// The dev server gets the fixture data source. `src/data/source.ts` and the
// fixture session only honour MC_DATA=fixture outside a production build, which
// is why e2e drives `next dev` rather than `next start`.
// NODE_ENV is dropped so `next dev` sets its own.
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && entry[0] !== "NODE_ENV",
  ),
);

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["**/support/**"],
  timeout: 60_000,
  // Assertions here wait on a server render, not only the DOM settling.
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev --port ${String(port)}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !isCI,
    timeout: 180_000,
    env: { ...inheritedEnv, MC_DATA: "fixture", E2E_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  },
});
