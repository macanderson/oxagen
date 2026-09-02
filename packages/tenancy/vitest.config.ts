import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    // ⚠️ THESE FLOORS ARE NOT CURRENTLY ENFORCED. `pnpm gate` runs
    // `turbo run … test:coverage`, and turbo skips a package that has no
    // `test:coverage` script — this package.json only defines `test:unit`, so
    // the thresholds below never execute. Wiring them needs a
    // `"test:coverage": "vitest run --coverage"` script plus the
    // `@vitest/coverage-v8` devDependency the other 36 packages carry.
    //
    // Once wired, the ratchet applies: raise a floor to floor(measured − 2.5),
    // capped at 90, never lower one. Every exported function here is directly
    // tested, so lines/statements/functions are set at the 90 cap and branches
    // at 85 pending a measured run. This is the most safety-critical seam in
    // the repo — a floor far below the real number would let the cross-tenant
    // isolation tests be deleted without the gate noticing.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
