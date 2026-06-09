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
      // lines floor 75 (measured 76.18 after new contracts added; new capabilities
      //   are schema/config — raise once dedicated contract tests exist).
      // functions floor 55 (measured 56.45); new registerCapability closures counted
      //   as untested functions until contract-level tests land.
      thresholds: {
        lines: 75,
        branches: 78,
        functions: 55,
        statements: 75,
      },
    },
  },
});
