// Shared ESLint flat config for the Next.js apps (app, website, admin, docs).
// Centralizes the eslint-config-next stack PLUS the workspace rule overrides so
// lint enforcement cannot drift app-by-app. apps/mcp is not a Next app and uses
// the root eslint.config.mjs instead. Per-app configs should re-export this
// (and may append extra `ignores` for generated dirs, e.g. docs' .source/**).
import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { tenancySeamRestrictedImports } from "./eslint.tenancy-seams.mjs";

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
      // OXA-1515: Next apps must route DB access through withTenantDb /
      // withSystemDb — never the raw db() seam.
      "no-restricted-imports": ["error", tenancySeamRestrictedImports],
      // Standard loading-state pattern in useEffect (setLoading(true) at start of
      // async effect) is idiomatic and not a real performance problem in practice.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Test files: relax rules that legitimately don't apply in test contexts.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/globals": "off",
    },
  },
];

export default config;
