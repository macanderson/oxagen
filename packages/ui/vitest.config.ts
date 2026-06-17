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
      // Ratchet (cap 90, keep >=2.5% headroom): adopting Checkbox/Tooltip + new
      // brand/page render tests lifted coverage to ~85.6% lines/statements,
      // 90.6% funcs, 92.4% branches. lines/statements floored at 83.
      thresholds: {
        lines: 83,
        branches: 90,
        functions: 90,
        statements: 83,
      },
    },
  },
});
