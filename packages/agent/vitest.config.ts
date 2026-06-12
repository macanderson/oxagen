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
      // Ratcheted after barrel/test-util excludes: measured 92.16 lines /
      // 84.04 branches / 77.9 functions (WP4 entitlement filter). Thresholds only go up.
      thresholds: {
        lines: 92,
        branches: 84,
        functions: 77,
        statements: 92,
      },
    },
  },
});
