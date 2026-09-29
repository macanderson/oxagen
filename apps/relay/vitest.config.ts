import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Instrument every source file, so a module no test imports still
      // counts against the thresholds.
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/**/*.test.ts",
        "src/test/**",
        // The process entry point: it reads the environment and wires signals.
        "src/main.ts",
      ],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    },
  },
});
