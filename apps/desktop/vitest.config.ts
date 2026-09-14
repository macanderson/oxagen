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
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // The webview entry: it mounts the React tree and nothing else.
        "src/main.tsx",
      ],
      // Ratchet only: never lowered, capped at 90, with headroom below the
      // measured figure so environment noise cannot fail CI. Measured
      // 2026-09-14 over commands.ts, bridge.ts (Tauri modules faked) and
      // tacho-status.ts.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
