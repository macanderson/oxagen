import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": src,
      // `server-only` throws outside a Server Component graph; unit tests have no
      // RSC boundary, so it resolves to a no-op here.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    clearMocks: true,
    unstubEnvs: true,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/*.stories.tsx",
        "src/**/*.d.ts",
        "src/test/**",
        // Route files are exercised by the Playwright suite against a running
        // server, not in isolation.
        "src/app/**/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/**/error.tsx",
        "src/app/**/global-error.tsx",
        "src/app/**/not-found.tsx",
        "src/app/**/route.ts",
      ],
      // Ratchet: raise to floor(measured - 2.5) as tests land, never lower, cap 90.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
