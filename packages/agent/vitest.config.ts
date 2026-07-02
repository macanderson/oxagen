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
        // Barrels and side-effect wiring with no testable logic of their own:
        // register.ts binds handlers into the kernel (exercised by every
        // surface boot + kernel tests); types.ts is type-only; the package
        // barrels just re-export. Same policy as @oxagen/handlers.
        "src/index.ts",
        "src/register.ts",
        "src/types.ts",
        "src/test-utils/**",
      ],
      // Gates are ratchets capped at 90 (see CLAUDE.md): lines/statements were
      // ratcheted to 92 with only 0.16% headroom and broke on drift; once a
      // metric reaches 90 its gate floor is 90 and stays there.
      thresholds: {
        lines: 90,
        branches: 84,
        functions: 77,
        statements: 90,
      },
    },
  },
});
