// Shared ESLint flat config for the Next.js apps (apps/app, apps/docs).
// Centralizes the eslint-config-next stack PLUS the workspace rule overrides so
// lint enforcement cannot drift app-by-app. apps/mcp is not a Next app and uses
// the root eslint.config.mjs instead. Per-app configs should re-export this
// (and may append extra `ignores` for generated dirs, e.g. docs' .source/**).
//
// NOTE — this config registers no `parserOptions.project`/`projectService`, and
// eslint-config-next does not either, so type-aware rules cannot run here. The
// `@typescript-eslint/no-unsafe-*` family that the root config enables (as
// gate-blocking warnings) is therefore UNENFORCED in the Next apps. Enabling it
// means adding a projectService block below, not just listing the rules.
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
// Patterns only — merged into the tenancy seam's `patterns` list below. It
// carries no `paths` entries of its own, so nothing else here reads one.
const uiIndirectionRestriction = {
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
      // Playwright's other two outputs, same class as e2e/screenshots/** above
      // and gitignored beside it (.gitignore:38-39). playwright-report/ embeds
      // a bundled trace viewer — minified vendor JS that eslint reads as
      // thousands of real errors, so running e2e and then lint turned the
      // whole gate red on a tree nobody had edited.
      "**/playwright-report/**",
      "**/test-results/**",
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
      "no-restricted-imports": [
        "error",
        {
          ...tenancySeamRestrictedImports,
          patterns: [
            ...(tenancySeamRestrictedImports.patterns ?? []),
            ...uiIndirectionRestriction.patterns,
          ],
        },
      ],
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
  // The `no-unsafe-*` family is deliberately absent — it is never enabled here
  // (see the note at the top of this file), so disabling it would be dead
  // config that hides the fact that the rules do not run.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/globals": "off",
    },
  },
];

export default config;
