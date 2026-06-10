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
      // lines floor 91 (measured 91.44); branches floor 83 (measured 83.43);
      // functions floor 76 (measured 76.13) — ratcheted after serverAllowlist tests.
      thresholds: {
        lines: 91,
        branches: 83,
        functions: 76,
        statements: 91,
      },
    },
  },
});
