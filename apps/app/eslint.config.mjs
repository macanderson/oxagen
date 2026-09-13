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

const FIXTURE_MESSAGE = "Only src/data/source.ts selects an adapter.";

// `no-restricted-imports` matches the import specifier as written, with
// gitignore semantics. `@/data/adapters/fixture` alone is bypassed by any
// relative spelling (`./adapters/fixture/runs`, `../data/adapters/fixture`), so
// the `**/` forms match the directory at any depth whatever the prefix.
const srcRestrictedImports = {
  ...tenancySeamRestrictedImports,
  patterns: [
    ...(tenancySeamRestrictedImports.patterns ?? []),
    // Lane isolation: a page's features may not import another page's internals.
    {
      group: ["@/features/*/*"],
      message:
        "Import a page's public surface from '@/features/<page>', never its internals.",
    },
    // Fixtures never reach production code paths.
    {
      group: [
        "@/data/adapters/fixture",
        "@/data/adapters/fixture/*",
        "**/adapters/fixture",
        "**/adapters/fixture/*",
      ],
      message: FIXTURE_MESSAGE,
    },
  ],
};

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
    rules: { "no-restricted-imports": ["error", srcRestrictedImports] },
  },
  {
    // A live adapter sits beside the fixture adapter, so `../fixture` (and
    // `./fixture` from src/data/adapters itself) reaches it without ever
    // spelling `adapters/fixture`. Close that path too.
    files: ["src/data/adapters/**/*.{ts,tsx}"],
    ignores: ["src/data/adapters/fixture/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...srcRestrictedImports,
          patterns: [
            ...srcRestrictedImports.patterns,
            {
              group: ["./fixture", "./fixture/*", "../fixture", "../fixture/*"],
              message: FIXTURE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // The one file allowed to select the fixture adapter. It keeps every other
    // restriction; only the fixture ban is lifted.
    files: ["src/data/source.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...srcRestrictedImports,
          patterns: srcRestrictedImports.patterns.filter(
            (pattern) => pattern.message !== FIXTURE_MESSAGE,
          ),
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
]);
