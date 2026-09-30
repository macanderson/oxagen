import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": src,
      // `server-only` throws outside a Server Component graph; unit tests have no
      // RSC boundary, so it resolves to a no-op here.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    clearMocks: true,
    unstubEnvs: true,
    // A developer whose shell exports `NODE_ENV=development` — the ordinary
    // state of a shell that also runs `next dev` — otherwise runs a different
    // suite from CI's: `app-url.ts` reads `NODE_ENV` to pick its fallback
    // origin, so four tests fail locally and pass on the runner. Pinning it
    // here makes the run say the same thing wherever it is started.
    env: { NODE_ENV: "test" },
    // Vitest's 5s default is shorter than the work this package's slowest
    // tests honestly do: a page test dynamically imports and renders an RSC
    // tree, and a section test drives a dialog through several open-and-close
    // cycles with an axe pass in `afterEach`. CI spawns one worker per file
    // across 189 files on a shared runner, so 5s expires under load and the
    // timed-out test's async continuation then runs inside the next test,
    // the neighbour fails with a count nobody can explain from its own code
    // (#3327). 20s is what `@oxagen/plugins`, `@oxagen/stella-engine-client`
    // and `apps/app_deprecated` already use; `hookTimeout` matches because
    // `afterEach` runs axe over the whole rendered shell.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // The Next instrumentation hook sits at the app root beside its test.
      "instrumentation.test.ts",
      // CI-only tooling beside its tests: the mockup parity capture's plan
      // (scripts/mockup-parity). Coverage below still measures src/ alone.
      "scripts/**/*.test.ts",
    ],
    // Architecture probes are inputs to src/test/arch, never suites of their own.
    exclude: [...configDefaults.exclude, "src/test/arch/probes/**"],
    // #3431 reported a second cause beside the worker timeouts above (#3327):
    // on 2026-09-19 this report seemed to count about 80 retired-app files
    // under `[orgSlug]/[workspaceSlug]` at 0% and fail the 90% floor at
    // 76.69% while all 4641 tests passed. The report did not do that. In that
    // run (Actions run 35423736904) this package failed two real tests,
    // passed 3289 of 3291, and printed no coverage table, because
    // `reportOnFailure` was off. The 76.69% table, the 411 files, the 4641
    // tests, and the `[orgSlug]` paths all came from @oxagen/app-deprecated's
    // own run, which met its own 57% floor. Turbo printed that run's output
    // next, directly above the line `Failed: @oxagen/app#test:coverage`, and
    // it was read as this package's. No coverage crossed between the
    // packages. Each vitest keeps raw data in `<reportsDirectory>/.tmp` under
    // its own root, reads back only the files its own workers wrote, and
    // drops files outside its root while `allowExternal` is off. A scratch
    // run of both suites in one turbo invocation on 2026-09-29 (run
    // 36663611315) found no foreign file in either report or raw directory.
    // CI now runs each app in its own `unit` lane, so their output no longer
    // shares a log. `tools/scripts/check-coverage-scope.mjs` still fails if
    // this report ever names a file outside `src` or one not on disk. It
    // reads the `json` reporter's `coverage/coverage-final.json`, so the
    // reporters and directory are pinned here. `reportOnFailure` writes the
    // report even when a test fails, which gives the guard a report to read
    // and puts this package's own table in the log of a failed run.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "clover", "json"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.d.ts",
        // Compiled by tsc, never executed (INV-24).
        "src/**/*.type-test.ts",
        "src/test/**",
        // Typed values for tests only (INV-22); never in the production graph.
        "src/**/*.builders.ts",
      ],
      // Ratchet: raise to floor(measured - 2.5) as tests land, never lower, cap 90.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
