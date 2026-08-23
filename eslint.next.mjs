// Shared ESLint flat config for the Next.js apps (app, website, admin, docs).
// Centralizes the eslint-config-next stack PLUS the workspace rule overrides so
// lint enforcement cannot drift app-by-app. apps/mcp is not a Next app and uses
// the root eslint.config.mjs instead. Per-app configs should re-export this
// (and may append extra `ignores` for generated dirs, e.g. docs' .source/**).
import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { tenancySeamRestrictedImports } from "./eslint.tenancy-seams.mjs";

/**
 * Restrict direct imports from @oxagen/ui/components/* inside Next.js apps.
 * All UI component imports must flow through the app's local re-export layer
 * (e.g. `@/components/ui/button`) so the indirection can be swapped for a
 * local wrapper without touching every consumer.
 *
 * Allowed: `@oxagen/ui` (barrel), `@oxagen/ui/styles/*`, `@oxagen/ui/lib/*`.
 * Forbidden: `@oxagen/ui/components/*` (must use local re-export).
 */
const uiIndirectionRestriction = {
  paths: [],
  patterns: [
    {
      group: ["@oxagen/ui/components/*"],
      message:
        "Import UI components from '@/components/ui/<name>' (the local re-export), not directly from '@oxagen/ui/components/*'. This preserves the override escape hatch.",
    },
  ],
};

/** @type {import("eslint").Linter.Config[]} */
const config = [
  // Generated/ephemeral output that is gitignored and must never be linted:
  // e2e/screenshots/** is deleted and recreated on every Playwright run (it can
  // hold generated probe .mjs scripts), so linting it produces spurious local
  // failures that never occur in a clean CI checkout.
  {
    ignores: [
      ".next/**",
      // OpenNext's deploy bundle (apps/docs). Same class as .next/**: build
      // output that exists only on a machine that has packaged the app, and
      // that turned a local full-gate lint into 3,062 phantom errors.
      ".open-next/**",
      "node_modules/**",
      "dist/**",
      ".turbo/**",
      "coverage/**",
      "**/e2e/screenshots/**",
    ],
  },
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
      "no-restricted-imports": ["error", {
        ...tenancySeamRestrictedImports,
        patterns: [
          ...(tenancySeamRestrictedImports.patterns ?? []),
          ...uiIndirectionRestriction.patterns,
        ],
      }],
      // Standard loading-state pattern in useEffect (setLoading(true) at start of
      // async effect) is idiomatic and not a real performance problem in practice.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // The re-export files in src/components/ui/*.tsx ARE the indirection layer —
  // they legitimately import directly from @oxagen/ui/components/*.
  {
    files: ["**/src/components/ui/*.tsx", "**/src/components/ui/*.ts"],
    rules: {
      "no-restricted-imports": ["error", tenancySeamRestrictedImports],
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
