import { defineConfig, devices } from "@playwright/test";
import { traceMode } from "./e2e/helpers/trace-mode";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Load .env.local into process.env before Playwright config is evaluated.
//
// The test process (playwright runner) inherits the shell environment, which
// may have stale / mis-quoted values for BETTER_AUTH_SECRET and other keys.
// Next.js dotenv-parsing strips surrounding double-quotes from values like
// `KEY="value"` → value. We replicate that strip here so the auth helper
// (e2e/helpers/auth.ts) sees the same secret the running app uses, letting
// the seeded Better-Auth session cookie verify correctly.
//
// Priority: shell env wins over .env.local (same as Next.js), EXCEPT for
// known-bad patterns (value starts with `"` but doesn't end with `"`, which
// indicates a partially-stripped double-quote from the shell). In that case
// we replace from .env.local so signing works.
// ---------------------------------------------------------------------------
function loadEnvLocal(): void {
  // Resolve the directory of this config file — compatible with ESM and CJS.
  const configDir = dirname(fileURLToPath(import.meta.url));

  // Walk from the current file up to the monorepo root looking for .env.local.
  // In normal operation cwd is apps/app; fall back to the monorepo root too.
  const candidates = [
    resolve(configDir, ".env.local"),
    resolve(configDir, "../../.env.local"),
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip one balanced surrounding double-quote pair (same as normalizeEnv).
      if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      // Override the shell value when:
      //  (a) the key is not set at all in the shell, OR
      //  (b) the shell value looks corrupted (starts with `"` without matching
      //      end quote — a known artifact of how zsh exports double-quoted env
      //      vars that contain `=` characters).
      const current = process.env[key];
      const corrupted =
        typeof current === "string" &&
        current.startsWith('"') &&
        !current.endsWith('"');
      if (current === undefined || corrupted) {
        process.env[key] = val;
      }
    }
    // Use the first .env.local found.
    break;
  }
}

loadEnvLocal();

export default defineConfig({
  testDir: "./e2e",
  // Helpers under `e2e/helpers/**` are imported by specs but contain no
  // tests themselves — exclude them from the Playwright test matcher so
  // they don't get reported as empty test files.
  //
  // `*-verify.spec.ts` are ONE-OFF live verification specs that hit the real
  // AI Gateway (no mocks) — they require AI_GATEWAY_API_KEY and are not part
  // of the deterministic CI suite (the mocked equivalent, e.g.
  // ask-drawer-form-fill.spec.ts, provides CI coverage). Excluding them keeps
  // the sharded CI run green; run them locally with a real gateway key.
  //
  // `screenshots-capture.spec.ts` is a LOCAL screenshot tool driven by the
  // gitignored root `creds.json` (see e2e/screenshots.config.ts). It reads
  // creds.json at module load, which throws ENOENT in CI where the file is
  // absent — failing collection for the whole shard. It has its own config, so
  // exclude it from the main deterministic suite.
  testIgnore: [
    "**/helpers/**",
    "**/*-verify.spec.ts",
    "**/screenshots-capture.spec.ts",
  ],
  timeout: 60_000,
  // Playwright's default assertion timeout is 5 s, tuned for assertions that
  // resolve in the browser. Most of this suite's do not: nearly every screen
  // here mutates through a Server Action and then waits for a revalidation, so
  // the assertion is waiting on a server round-trip and a re-render, not on the
  // DOM settling.
  //
  // That mismatch is #2559's "rotating navigation timeout, one spec at a time".
  // A sweep of `apps/app/e2e` found 34 specs containing at least one assertion
  // that follows a mutation and takes the 5 s default — so on any given run,
  // whichever one loses the race under load is the one that fails, and it is a
  // different one each time. developer-tokens.spec.ts lost it on run
  // 34540186574 and failed all three attempts, which is not a flake being
  // unlucky; 5 s was simply not enough that run.
  //
  // Raising the floor is the fix for the class. It costs nothing when an
  // assertion passes — Playwright polls and returns as soon as it is true — and
  // only changes how long a genuinely failing one waits before saying so. The
  // per-test budget above stays 60 s, so a hung test still fails at the same
  // point it always did.
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    // `on-first-retry` never traces the attempt that failed — it starts at
    // the retry, which for a flake usually passes. The nightly sets
    // PLAYWRIGHT_TRACE_ALL and gets every attempt (#2559).
    trace: traceMode(),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
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
    {
      // API server (Hono, port 4000) — required by asset-upload e2e tests.
      // tsx inherits process.env which playwright.config.ts already populates
      // from .env.local via loadEnvLocal(), so no --env-file flag is needed.
      command: "pnpm --filter @oxagen/api exec tsx src/index.ts",
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      url: "http://localhost:4000/health",
      reuseExistingServer: !process.env.CI,
      // tsx transpiles the whole API on boot; on a loaded machine that takes
      // over a minute cold (measured ~75s locally), and a 60s ceiling turned
      // that into "Timed out waiting from config.webServer" with zero output.
      // A ceiling, not a wait — a fast boot still proceeds immediately.
      timeout: 180_000,
      env: { ...process.env, E2E_TEST: "true" },
      // Forward the API's pino output into the Playwright (and CI) log — a
      // sanitized 500 from a route is undebuggable without the server stack.
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
