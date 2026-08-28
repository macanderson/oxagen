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
      // Library source only. bin/oxagen-skills.mjs is the npx installer
      // entrypoint — a process-spawning script proven by CLI install.sh /
      // smoke runs, not unit-testable in-process; counting it at 0% masks
      // the real src coverage (~95%).
      include: ["src/**"],
      // Thresholds keep at least 2.5% headroom below measured coverage so a
      // small environment-noise dip does not fail CI.
      thresholds: {
        lines: 90,
        branches: 86,
        functions: 84,
        statements: 90,
      },
    },
  },
});
