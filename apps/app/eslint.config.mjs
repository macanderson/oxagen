// apps/app/eslint.config.mjs — ESLint 10, standalone. It does not import
// ../../eslint.next.mjs, which is ESLint 9 + eslint-config-next (that config
// hard-depends on eslint-plugin-react / jsx-a11y / import, all capped at ESLint 9).
// Accessibility is gated by axe-core in component tests (INV-26).
import js from "@eslint/js";
import react from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import { defineConfig, globalIgnores } from "eslint/config";
import { builtinRules } from "eslint/use-at-your-own-risk";
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
        group: ["@/features/*/*", "!@/features/fleet/client"],
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

// Test-only modules (§4 preamble): they render fixtures, never interface.
const TEST_ONLY = [
  "src/**/*.test.{ts,tsx}",
  "src/**/*.type-test.ts",
  "src/**/*.builders.ts",
  "src/test/**",
  "src/server/viewer.testing.ts",
];

// INV-12 (ARCHITECTURE.md §4): interface prose comes from messages/*.json.
const PROSE_MESSAGE =
  "Interface prose comes from messages/*.json through t(); a literal string reaches no catalog (INV-12).";
const PROSE = [
  { selector: "JSXText[value=/[A-Za-z]/]", message: PROSE_MESSAGE },
  {
    selector:
      "JSXAttribute[name.name=/^(aria-label|title|placeholder|alt)$/] > Literal[value=/[A-Za-z]/]",
    message: PROSE_MESSAGE,
  },
  {
    selector:
      "JSXAttribute[name.name=/^(aria-label|title|placeholder|alt)$/] > JSXExpressionContainer > :matches(Literal[value=/[A-Za-z]/], TemplateLiteral)",
    message: PROSE_MESSAGE,
  },
];

// INV-09 (ARCHITECTURE.md §4): only src/ui/money-format.ts formats a number,
// and only src/data/contracts/money.ts does arithmetic on micros.
const NUMBER_FORMAT_MESSAGE =
  "Format money through <Money> and counts through formatCount from src/ui/money-format.ts (INV-09).";
const NUMBER_FORMATTING = [
  {
    selector:
      ":matches(NewExpression, CallExpression):matches([callee.name='NumberFormat'], [callee.property.name='NumberFormat'])",
    message: NUMBER_FORMAT_MESSAGE,
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(toFixed|toLocaleString)$/]",
    message: NUMBER_FORMAT_MESSAGE,
  },
];
const BIGINT = [
  {
    selector: "CallExpression[callee.name='BigInt']",
    message:
      "Arithmetic on micros happens only in src/data/contracts/money.ts (mulMicros), INV-09.",
  },
];

const FORMATTER_FACTORIES = new Set(["getFormatter", "useFormatter"]);

/** `getFormatter()`, `useFormatter()` or either awaited. */
function isFormatter(node) {
  const call = node?.type === "AwaitExpression" ? node.argument : node;
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    FORMATTER_FACTORIES.has(call.callee.name)
  );
}

/** The initializer an identifier was declared with, looked up through the enclosing scopes. */
function initializerOf(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable) {
      const def = variable.defs[0];
      return def?.type === "Variable" ? def.node : null;
    }
  }
  return null;
}

/** INV-09: next-intl's `.number(` on a formatter, called or destructured, by any binding. */
const formatterNumber = {
  meta: {
    type: "problem",
    schema: [],
    messages: { number: NUMBER_FORMAT_MESSAGE },
  },
  create(context) {
    return {
      "CallExpression > MemberExpression.callee[property.name='number']"(
        member,
      ) {
        const target =
          member.object.type === "Identifier"
            ? initializerOf(
                context.sourceCode.getScope(member),
                member.object.name,
              )?.init
            : member.object;
        if (isFormatter(target))
          context.report({ node: member, messageId: "number" });
      },
      "VariableDeclarator > ObjectPattern.id > Property[key.name='number']"(
        property,
      ) {
        if (isFormatter(property.parent.parent.init))
          context.report({ node: property, messageId: "number" });
      },
    };
  },
};

// `no-restricted-syntax` restated under rule names of their own, so the
// exemptions of INV-09 and INV-12 never replace the INV-02 and INV-13 groups.
const restrictedSyntax = builtinRules.get("no-restricted-syntax");
const invariants = {
  rules: {
    prose: restrictedSyntax,
    "number-format": restrictedSyntax,
    bigint: restrictedSyntax,
    "formatter-number": formatterNumber,
  },
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
    // INV-09 and INV-12, everywhere under src/ but test-only modules. Probes:
    // src/test/arch/lint.test.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: TEST_ONLY,
    plugins: { invariants },
    rules: {
      "invariants/prose": ["error", ...PROSE],
      "invariants/number-format": ["error", ...NUMBER_FORMATTING],
      "invariants/formatter-number": "error",
      "invariants/bigint": ["error", ...BIGINT],
    },
  },
  {
    // The one module that formats a number.
    files: ["src/ui/money-format.ts"],
    rules: {
      "invariants/number-format": "off",
      "invariants/formatter-number": "off",
    },
  },
  {
    // The one module that does arithmetic on micros.
    files: ["src/data/contracts/money.ts"],
    rules: { "invariants/bigint": "off" },
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
