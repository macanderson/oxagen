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
      // lines/statements floor 61 (measured 63.73 after the account-linking
      // hardening tests; auth.ts is Better Auth config and stays 0% / not
      // unit-testable, which caps the achievable line %). functions floor 90
      // (measured 94.28; once ≥90 the floor stays 90). branches floor 90
      // (measured 96.47; capped at 90). All keep ≥2.5% headroom below measured.
      thresholds: {
        lines: 61,
        branches: 90,
        functions: 90,
        statements: 61,
      },
    },
  },
});
