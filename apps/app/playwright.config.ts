import { defineConfig, devices } from "@playwright/test";
import { OWNER_STATE } from "./e2e/support";

// The rev1 e2e harness (ARCHITECTURE.md §5, §6.3): three projects — login,
// then page-load and pay on the storage state login.spec.ts saved — against
// `next start` on the build the job's Build step produced, seeded through
// package APIs (`pnpm --filter @oxagen/app seed:e2e`). retries 0, one shard,
// flaky is failed: a test either proves its journey or it does not.
const isCI = Boolean(process.env.CI);

/**
 * A variable the production build needs to boot and sign in. Named here so
 * the server's environment is explicit rather than whatever the runner
 * happened to inherit, and a missing one fails before the server starts.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`playwright.config.ts: ${name} must be set`);
  }
  return value;
}

/**
 * Whether the job resolved a Stripe test key ("1") or is a fork pull request
 * without one ("0"; pay.spec.ts skips on it, WL-48). Unset locally means no
 * key, so the server carries "0" with the rest of its list.
 */
const stripeE2E = process.env.STRIPE_E2E ?? "0";

const appUrl = required("NEXT_PUBLIC_APP_URL");

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: isCI,
  retries: 0,
  failOnFlakyTests: true,
  workers: 1,
  // 20 minutes for the whole run, well under the `e2e` job's 45-minute
  // ceiling and the setup steps (build, seed, browser install) that run
  // before Playwright ever starts. Three projects, ~19 tests total, each
  // bounded by its own default 30s test timeout, add up to a few minutes in
  // the worst case where every one fails — this run should never approach
  // the cap on its own. Run 35941767115 (commit 310955e) had none: the "E2E
  // tests" step sat silent for 29 minutes and was cancelled only when the
  // job's own timeout hit, which reads identically to a step one minute from
  // finishing. A globalTimeout turns that into a named failure with a report
  // instead of a cancelled job with no evidence.
  globalTimeout: 20 * 60_000,

  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: appUrl, trace: "retain-on-failure" },
  projects: [
    {
      name: "login",
      testMatch: /login\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "page-load",
      testMatch: /page-load\.spec\.ts$/,
      dependencies: ["login"],
      use: { ...devices["Desktop Chrome"], storageState: OWNER_STATE },
    },
    {
      name: "pay",
      testMatch: /pay\.spec\.ts$/,
      dependencies: ["login"],
      use: { ...devices["Desktop Chrome"], storageState: OWNER_STATE },
    },
  ],
  webServer: {
    // `next start` on the .next the Build step produced: apps/app is built
    // once, and the sentinel scan (scripts/scan-build-sentinels.mjs) reads
    // that same build.
    command: "pnpm --filter @oxagen/app start",
    url: `${appUrl}/login`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    // Playwright merges this over the runner's process.env (turbo's test:e2e
    // list). Listed here, in addition, is exactly what the production build
    // needs to boot and sign in, so the harness is reproducible locally with
    // the same seed. VERCEL_ENV marks the process as not a real production
    // runtime (packages/config isProductionRuntime; next start hardcodes
    // NODE_ENV=production). E2E_TEST=true is the one sanctioned relaxation
    // (packages/auth: email verification and secure cookies off-Vercel).
    // No model-provider secret: login, pay and page-load call no model.
    env: {
      VERCEL_ENV: "preview",
      E2E_TEST: "true",
      DATABASE_URL: required("DATABASE_URL"),
      BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
      BETTER_AUTH_URL: required("BETTER_AUTH_URL"),
      NEXT_PUBLIC_APP_URL: appUrl,
      STRIPE_SECRET_KEY: required("STRIPE_SECRET_KEY"),
      STRIPE_WEBHOOK_SECRET: required("STRIPE_WEBHOOK_SECRET"),
      STRIPE_E2E: stripeE2E,
    },
  },
});
