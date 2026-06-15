import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Scope to the pure, testable logic behind the secrets DB. Excluded:
      // pull-secrets.ts (drives gcloud + runs main() on import), server.ts /
      // vercel.ts / config.ts / sources.ts / catalog.ts (Vercel-deploy side of
      // the tool, network-bound), and *.test.ts.
      include: [
        "src/secrets-db.ts",
        "src/secrets-meta.ts",
        "src/secrets-reconcile.ts",
        "src/secrets-usage.ts",
      ],
      // Ratchet (cap 90, ≥2.5% headroom under measured coverage):
      // measured ≈ 96.6 lines/stmts, 97.4 funcs, 91.3 branches.
      thresholds: {
        lines: 90,
        branches: 88,
        functions: 90,
        statements: 90,
      },
    },
  },
});
