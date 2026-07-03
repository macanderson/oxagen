import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    // Ink/chalk pick a color depth from the environment at import time, and the
    // slash-menu tests assert exact truecolor ANSI sequences. Pin truecolor so
    // rendering is deterministic everywhere (GitHub Actions runners and local
    // non-TTY shells otherwise downgrade to 16 colors and the assertions fail).
    env: { FORCE_COLOR: "3" },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // Ink TSX components (index.tsx, DevStatus.tsx) require the Ink renderer
      // and are covered by E2E tests, not unit tests. Exclude from unit coverage.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
