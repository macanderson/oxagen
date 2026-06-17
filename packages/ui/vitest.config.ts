import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    // Default environment is node; files annotated with
    // `// @vitest-environment jsdom` get jsdom automatically.
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Setup file for jsdom tests — provides jest-dom matchers (toBeInTheDocument, etc.)
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/components/**/*.tsx", "src/lib/**/*.ts"],
      exclude: ["src/**/*.test.tsx", "src/**/*.test.ts"],
      thresholds: {
        lines: 76,
        branches: 90,
        functions: 90,
        statements: 76,
      },
    },
  },
});
