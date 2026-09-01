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
      // Instrument ALL source files, not only those a test happens to import —
      // otherwise an untested file is invisible and the thresholds gate
      // nothing. Same posture as @oxagen/plugins.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts", // re-export barrel: no executable logic
      ],
      thresholds: { lines: 90, branches: 81, functions: 90, statements: 90 },
    },
  },
});
