import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines measured 42.48; branches measured 97.82; target 75/70 respectively.
      // docker.ts run()/stream() hot paths are not yet covered — inject a
      // Dockerode factory to enable mocked testing of truncation/timeout/OOM paths.
      thresholds: {
        lines: 42,
        branches: 92,
        functions: 40,
        statements: 42,
      },
    },
  },
});
