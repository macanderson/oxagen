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
      // Only lines/statements are gated. This package is almost entirely
      // type declarations, which emit no runtime code at all; the executable
      // surface is the NonRetriableError constructor plus the barrel's single
      // re-export, neither of which has a branch to measure.
      //
      // Both metrics sit at 100%, so the ratchet is parked at its 90 cap.
      thresholds: {
        lines: 90,
        statements: 90,
      },
    },
  },
});
