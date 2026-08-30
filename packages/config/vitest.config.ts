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
      // Scope to all files with meaningful logic, including index.ts (it
      // defines PORTS and platformVersion() in addition to re-exporting the
      // other modules). registry.ts, domain.ts, and geo.ts export validators
      // and option arrays; their tests already exist — this wires them to the
      // gate so a regression is caught.
      include: [
        "src/env.ts",
        "src/index.ts",
        "src/registry.ts",
        "src/domain.ts",
        "src/geo.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
