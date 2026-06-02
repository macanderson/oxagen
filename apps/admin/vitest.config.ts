import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // apps/admin is a purely static Next.js placeholder (milestone: foundations).
    // It has no non-trivial utility logic — all files are Next.js page/layout
    // RSC components with zero pure-function units to assert. No tests exist and
    // --passWithNoTests is used so the CI gate (test:unit) stays GREEN while
    // the app remains a static shell.
    // Add tests here when business logic (e.g. admin utilities) is introduced.
    // Ratchet target: 85% lines / 80% branch at that point.
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  },
});
