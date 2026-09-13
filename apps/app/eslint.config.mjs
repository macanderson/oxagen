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

// `no-restricted-imports` sees only static `import`/`export … from`. A dynamic
// `import()` is an ImportExpression, which it never visits, and plan §4 has
// source.ts select the adapter with exactly `await import("./adapters/fixture")`,
// so a copied call is the likeliest bypass. These selectors match the literal
// specifier, or the leading quasi of a template literal (`../fixture/${x}`).
const importSpecifier = (regex) => [
  `ImportExpression > Literal[value=${regex}]`,
  `ImportExpression > TemplateLiteral[quasis.0.value.raw=${regex}]`,
];
// Any spelling that names the directory: `@/data/adapters/fixture`,
// `../../data/adapters/fixture/runs`.
const FIXTURE_DIR_REGEX = String.raw`/(^|\/)adapters\/fixture(\/|$)/`;
// A sibling-relative spelling from inside src/data/adapters: `./fixture`,
// `../fixture/runs`, `../../fixture` from live/mappers.
const FIXTURE_SIBLING_REGEX = String.raw`/^(\.\.?\/)+fixture(\/|$)/`;
const fixtureDynamicImportBan = (...regexes) => [
  "error",
  ...regexes.flatMap(importSpecifier).map((selector) => ({
    selector,
    message: FIXTURE_MESSAGE,
  })),
];

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
    rules: {
      "no-restricted-imports": ["error", srcRestrictedImports],
      "no-restricted-syntax": fixtureDynamicImportBan(FIXTURE_DIR_REGEX),
    },
  },
  {
    // A live adapter sits beside the fixture adapter, so `../fixture`,
    // `./fixture` from src/data/adapters itself, and `../../fixture` from
    // live/mappers reach it without ever spelling `adapters/fixture`. The `**/`
    // forms close that path at every depth; the fixture dir is ignored below.
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
              group: ["**/fixture", "**/fixture/*"],
              message: FIXTURE_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": fixtureDynamicImportBan(
        FIXTURE_DIR_REGEX,
        FIXTURE_SIBLING_REGEX,
      ),
    },
  },
  {
    // Where the fixture ban is lifted. Every other restriction stays.
    // - src/data/source.ts: the one file that selects the data-layer adapter.
    // - src/features/shell/source.ts: PROMOTE. Lane L3's shell selects its
    //   feature-local adapter the same way until it folds into
    //   `dataSource().shell` (see the PROMOTE note in that file); drop the entry
    //   then.
    // - Unit tests and stories drive components with fixture data and never
    //   ship in a production bundle (next build compiles neither).
    files: [
      "src/data/source.ts",
      "src/features/shell/source.ts",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.stories.tsx",
    ],
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
      // Its only no-restricted-syntax entries are the fixture dynamic-import ban.
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
]);
