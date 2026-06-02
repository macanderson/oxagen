import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // No coverage thresholds for apps/cli.
    //
    // Rationale: the only testable logic is checkPort() in DevStatus.tsx, which
    // is a private (unexported) function. The test file validates the settle()
    // event-dispatch contract via an inline re-implementation (no import of
    // DevStatus.tsx), so v8 would report 0% coverage for the source file even
    // though the behaviour is fully exercised.
    //
    // The React/Ink component paths require ink-testing-library + a React
    // renderer. When those render tests are added the source will be imported
    // directly and thresholds can be set at that time.
    //
    // Ratchet target: 85% lines / 80% branch once Ink renderer tests are added.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  },
});
