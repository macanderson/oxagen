import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // apps/website is a purely static Next.js marketing shell (foundations milestone).
    // All pages are RSC components with no non-trivial utility logic to unit-test.
    // --passWithNoTests keeps the CI gate GREEN while the app remains a static shell.
    // Add tests here when business logic (e.g. form handlers, analytics utils) lands.
    // Ratchet target: 85% lines / 80% branch at that point.
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  },
});
