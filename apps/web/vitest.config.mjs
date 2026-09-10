import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.mjs"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["scripts/lib/**/*.mjs"],
      exclude: ["scripts/**/*.test.mjs"],
      reporter: ["text", "json-summary"],
      // Ratchet: raise only when actual coverage leaves >= 2.5% headroom;
      // never lower; cap at 90.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
