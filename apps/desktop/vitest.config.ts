import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    // ONE glob over both extensions, so a future .tsx test is collected
    // rather than silently skipped.
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Both extensions, so nothing is ungated by its file extension alone;
      // what is ungated is named below, on purpose.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        // The webview entry: it mounts the React tree and nothing else.
        "src/main.tsx",
        // The React tree itself is deliberately outside the gate for now:
        // it has no React Testing Library coverage yet, and every decision
        // it makes that can be pinned as a pure function lives in
        // commands.ts, bridge.ts, tacho-status.ts and updater.ts, which are
        // gated. Adding component tests removes this line.
        "src/app.tsx",
      ],
      // Ratchet only: never lowered, capped at 90, with headroom below the
      // measured figure so environment noise cannot fail CI. Measured
      // 2026-09-14 over commands.ts, bridge.ts (Tauri modules faked),
      // tacho-status.ts and updater.ts.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
