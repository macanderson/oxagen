import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // Coverage gate lives in the build, not in review (engineering policy §6).
    // Floors sit below the package's measured 100% so a small addition doesn't
    // trip the gate, while still enforcing the ≥85% line / ≥80% branch policy bar.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 90, statements: 90, functions: 85, branches: 80 },
    },
  },
});
