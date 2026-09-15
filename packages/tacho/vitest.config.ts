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
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/index.ts",
        "src/trace/index.ts",
        "src/claude-code/index.ts",
        "src/collector/index.ts",
        "src/collector/main.ts",
        "src/host/index.ts",
        "src/cli/index.ts",
        "src/cli/main.ts",
        "src/claude-code/hook-main.ts",
        "src/host/test-support.ts",
        "src/test-helpers.ts",
        "src/bench/**",
        "bin/**",
        "scripts/**",
        "dist-standalone/**",
      ],
      // Ratchet only: never lowered, capped at 90, with headroom below the
      // measured figure so environment noise cannot fail CI. Measured
      // 2026-09-14 after the Codex writer, reassign, Windows service and
      // loopback-hook tests: 95.0% lines/statements, 85.3% branches, 95.4%
      // functions; lines, statements and functions sit at the cap, branches
      // at floor(85.3 - 2.5).
      thresholds: {
        lines: 90,
        branches: 82,
        functions: 90,
        statements: 90,
      },
    },
  },
});
