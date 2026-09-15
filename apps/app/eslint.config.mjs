// apps/app/eslint.config.mjs — ESLint 10, standalone. It does not import
// ../../eslint.next.mjs, which is ESLint 9 + eslint-config-next (that config
// hard-depends on eslint-plugin-react / jsx-a11y / import, all capped at ESLint 9).
// Accessibility is gated by axe-core in component tests (INV-26).
import js from "@eslint/js";
import react from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { tenancySeamRestrictedImports } from "../../eslint.tenancy-seams.mjs";

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
  ],
};

export default defineConfig([
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    // Architecture probes must violate a rule each; src/test/arch judges them.
    "src/test/arch/probes/**",
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
    },
  },
  {
    // INV-02 (ARCHITECTURE.md §3.1): a viewer context is built only inside the
    // viewer seam. Everywhere else under src/ a type assertion, an
    // Object.assign and a structuredClone are refused, so no code can cast or
    // copy a value into the shape of a context. Probes: src/test/arch/lint.test.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/viewer.ts", "src/server/viewer.testing.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Object']:matches([callee.property.name='assign'], [callee.property.value='assign'])",
          message:
            "Object.assign copies a value into any shape; build the object, or mint a viewer context in src/server/viewer.ts (INV-02).",
        },
        {
          selector:
            "CallExpression:matches([callee.name='structuredClone'], [callee.property.name='structuredClone'])",
          message:
            "structuredClone copies a value into any shape; a viewer context is minted only in src/server/viewer.ts (INV-02).",
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
