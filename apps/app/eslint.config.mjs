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

// A flat config replaces a rule's options wholesale for the files a later
// block matches, so each rule below is built from named groups and restated,
// minus the one group a file is exempt from.

const NAVIGATION_MESSAGE =
  "Redirect through src/shared/navigation.ts and navigate on the client through src/ui/navigation.tsx; every target is a SafePath, LoopbackUri or ExternalCheckoutUrl (INV-13).";

/** no-restricted-imports: the tenancy seams, lane isolation, and the next/navigation names INV-13 routes through its two modules. */
function restrictedImports(navigationNames) {
  return {
    ...tenancySeamRestrictedImports,
    paths: [
      ...(tenancySeamRestrictedImports.paths ?? []),
      {
        name: "next/navigation",
        importNames: navigationNames,
        message: NAVIGATION_MESSAGE,
      },
    ],
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
}

// INV-02 (ARCHITECTURE.md §3.1): a viewer context is built only inside the
// viewer seam, so no code can copy a value into the shape of a context.
const VIEWER_COPIES = [
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
];

// INV-13 (ARCHITECTURE.md §3.8). `redirect` and `permanentRedirect` imports
// are refused by no-restricted-imports; these catch the member forms.
const REDIRECT_CALLS = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression']:matches([callee.property.name='redirect'], [callee.property.name='permanentRedirect'])",
    message: NAVIGATION_MESSAGE,
  },
];

const LOCATION_WRITES = [
  {
    selector: "MemberExpression[object.name='location']",
    message: `location.* navigates around the typed targets; ${NAVIGATION_MESSAGE}`,
  },
  {
    selector:
      "MemberExpression[property.name='location']:matches([object.name='window'], [object.name='document'], [object.name='globalThis'], [object.name='self'])",
    message: `location.* navigates around the typed targets; ${NAVIGATION_MESSAGE}`,
  },
  {
    selector: "AssignmentExpression > Identifier.left[name='location']",
    message: `location.* navigates around the typed targets; ${NAVIGATION_MESSAGE}`,
  },
];

const COMPUTED_LINK_TARGETS = [
  {
    selector:
      "JSXOpeningElement[name.name=/^(a|Link|form)$/] > JSXAttribute[name.name=/^(href|action)$/] > JSXExpressionContainer",
    message:
      "A computed href or form action takes an unchecked target; render <SafeLink to={routes…}> or <SafeForm action={…}> from src/ui/navigation.tsx (INV-13).",
  },
];

const VIEWER_SEAM = ["src/server/viewer.ts", "src/server/viewer.testing.ts"];

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
      "no-restricted-imports": [
        "error",
        restrictedImports(["redirect", "permanentRedirect", "useRouter"]),
      ],
      "no-restricted-syntax": [
        "error",
        ...VIEWER_COPIES,
        ...REDIRECT_CALLS,
        ...LOCATION_WRITES,
        ...COMPUTED_LINK_TARGETS,
      ],
    },
  },
  {
    // INV-02: everywhere under src/ but the viewer seam, a type assertion is
    // refused too. Probes: src/test/arch/lint.test.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: VIEWER_SEAM,
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
    },
  },
  {
    files: VIEWER_SEAM,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...REDIRECT_CALLS,
        ...LOCATION_WRITES,
        ...COMPUTED_LINK_TARGETS,
      ],
    },
  },
  {
    // The one module that performs a redirect.
    files: ["src/shared/navigation.ts"],
    rules: {
      "no-restricted-imports": ["error", restrictedImports(["useRouter"])],
      "no-restricted-syntax": [
        "error",
        ...VIEWER_COPIES,
        ...LOCATION_WRITES,
        ...COMPUTED_LINK_TARGETS,
      ],
    },
  },
  {
    // The one useRouter importer and the one file with a computed link target.
    files: ["src/ui/navigation.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        restrictedImports(["redirect", "permanentRedirect"]),
      ],
      "no-restricted-syntax": [
        "error",
        ...VIEWER_COPIES,
        ...REDIRECT_CALLS,
        ...LOCATION_WRITES,
      ],
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
]);
