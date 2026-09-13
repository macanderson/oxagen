// apps/app/eslint.config.mjs — ESLint 10, standalone. It does not import
// ../../eslint.next.mjs, which is ESLint 9 + eslint-config-next (that config
// hard-depends on eslint-plugin-react / jsx-a11y / import, all capped at ESLint 9).
// Accessibility is gated by axe on rendered pages in e2e instead.
import js from "@eslint/js";
import react from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { tenancySeamRestrictedImports } from "../../eslint.tenancy-seams.mjs";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "storybook-static/**",
    "next-env.d.ts",
  ]),
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.tsx"],
    extends: [react.configs["recommended-typescript"]],
    plugins: { "react-hooks": reactHooks, "@next/next": next },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...tenancySeamRestrictedImports,
          patterns: [
            // Lane isolation: a page's features may not import another page's internals.
            {
              group: ["@/features/*/*"],
              message:
                "Import a page's public surface from '@/features/<page>', never its internals.",
            },
            // Fixtures never reach production code paths.
            {
              group: ["@/data/adapters/fixture", "@/data/adapters/fixture/*"],
              message: "Only src/data/source.ts selects an adapter.",
            },
          ],
        },
      ],
    },
  },
  {
    // The one file allowed to select the fixture adapter.
    files: ["src/data/source.ts"],
    rules: { "no-restricted-imports": ["error", tenancySeamRestrictedImports] },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
]);
