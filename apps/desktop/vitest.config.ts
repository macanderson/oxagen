import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
      // The React tree and the Tauri bridge run only inside the webview
      // (`@tauri-apps/api` has no node runtime); `commands.ts` is the part
      // kept apart from them so the argv mapping is testable here. The
      // thresholds measure that module. They sit at the cap because it is one
      // pure module with a table over it, 2.5 points under an actual figure
      // that has nowhere to go.
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/app.tsx",
        "src/bridge.ts",
        "src/main.tsx",
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
