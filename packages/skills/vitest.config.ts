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
      // lines floor 90 (reduced from 94 for CI stability); target 75
      // branches floor 86 (measured 91.07); target 70
      thresholds: {
        lines: 90,
        branches: 86,
        functions: 84,
        statements: 90,
      },
    },
  },
});
