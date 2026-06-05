// Shared ESLint flat config for the Next.js apps (app, website, admin, docs).
// Centralizes the eslint-config-next stack PLUS the workspace rule overrides so
// lint enforcement cannot drift app-by-app. apps/mcp is not a Next app and uses
// the root eslint.config.mjs instead. Per-app configs should re-export this
// (and may append extra `ignores` for generated dirs, e.g. docs' .source/**).
import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  { ignores: [".next/**", "node_modules/**", "dist/**", ".turbo/**", "coverage/**"] },
  ...nextPlugin,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Policy 0: no implicit any. Matches the root config used by every
      // non-Next package — enforced as an error on every surface, no drift.
      "@typescript-eslint/no-explicit-any": "error",
      // _-prefixed vars/args are intentionally unused (ignored values,
      // placeholder params, destructured rest). Everything else is an error.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
];

export default config;
