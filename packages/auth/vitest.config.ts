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
      // lines/statements floor 53 (measured 55.81 after OXA-1789 oauth-proxy-config
      // tests; auth.ts is Better Auth config and stays 0% / not unit-testable).
      // functions floor 89 (measured 92). branches floor 90 (measured 97.27;
      // capped at 90). All keep ≥2.5% headroom below the measured value.
      thresholds: {
        lines: 53,
        branches: 90,
        functions: 89,
        statements: 53,
      },
    },
  },
});
