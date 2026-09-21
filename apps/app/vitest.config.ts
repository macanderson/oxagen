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
    ],
    // Architecture probes are inputs to src/test/arch, never suites of their own.
    exclude: [...configDefaults.exclude, "src/test/arch/probes/**"],
    coverage: {
      provider: "v8",
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
