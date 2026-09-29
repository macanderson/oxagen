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
        "src/index.ts",
      ],
      // Lane C0 ships types, constants, and stubs whose tests reach every
      // line. The ratchet caps a threshold at 90.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
