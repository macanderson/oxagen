import { defineConfig } from "vitest/config";

// The benchmark simulation engine (src/lib/**) holds all of the app's logic and
// is pure/deterministic, so coverage is scoped to it — the React view layer in
// src/components and src/app is presentational and exercised by the dev server,
// not unit tests. Thresholds follow the repo ratchet rule (>=2.5% headroom,
// capped at 90).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/*.test.ts", "src/lib/types.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
});
