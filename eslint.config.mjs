// Root ESLint flat config — used by all non-Next packages and apps.
// Next.js apps (apps/app, apps/admin, apps/website, apps/docs) have their
// own eslint.config.mjs that extends eslint-config-next; they do NOT use
// this root config.  Every other package resolves ESLint from root
// node_modules and points --config at this file (or lets flat-config
// discovery walk up to it).
import tseslint from "typescript-eslint";
import { tenancySeamRestrictedImports } from "./eslint.tenancy-seams.mjs";

export default tseslint.config(
  // Global ignores — applied to every package that uses this config.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.d.ts",
      // Generated/vendor files
      "**/contracts.generated.ts",
      "**/schema.cypher",
      "**/migrations/**",
      // Next.js apps lint with their own eslint-config-next stack (see
      // eslint.next.mjs). Without these ignores, a root-context run applies
      // THIS config to their files and errors on disable directives for
      // plugins only registered there (e.g. react-hooks/exhaustive-deps).
      "apps/app/**",
      "apps/admin/**",
      "apps/website/**",
      "apps/docs/**",
      // apps/web is the static oxagen.sh site: no build step, no tsconfig,
      // and its one script is browser vanilla JS. The project service has no
      // project to resolve it against, so linting it here is a parse error
      // rather than a finding.
      "apps/web/**",
    ],
  },
  // Base TS config without type-checking (fast; runs on all TS files).
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // projectService enables type-aware rules only when a tsconfig.json
        // is present in the package.  Packages without one fall back gracefully.
        projectService: {
          // Root-level files (vitest.workspace.ts) belong to no package
          // tsconfig; lint them via the inferred default project instead of
          // erroring when they are passed to eslint explicitly (pre-commit
          // lints staged files by path).
          allowDefaultProject: ["*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Policy 0: no implicit any.
      "@typescript-eslint/no-explicit-any": "error",

      // These fire legitimately during foundation scaffolding where dynamic
      // patterns are needed; keep as warnings so they are visible without
      // blocking the gate.  Tighten to "error" package-by-package as the
      // code stabilises.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",

      // Unused vars: error on all except args prefixed with _.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Allow empty catch blocks with a comment.
      "@typescript-eslint/no-empty-object-type": "error",

      // OXA-1515: forbid raw data-store seam clients outside their owning
      // packages so tenant RLS scoping can't be bypassed by accident.
      "no-restricted-imports": ["error", tenancySeamRestrictedImports],
    },
  },
  // Test files: relax unsafe-assignment/member-access/call warnings — vitest's
  // asymmetric matchers (expect.objectContaining, expect.any, etc.) are typed
  // as `any` by design; suppressing per-line is noisy and adds no safety.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // Plain-JS config files (this file, eslint.next.mjs, …) and TS tooling
  // configs (vitest.config.ts, *.config.ts) belong to no tsconfig project —
  // type-aware parsing fails on them (the projectService can't find a project).
  // Lint them untyped. Without this, staging a vitest.config.ts trips the
  // lefthook lint hook with a "not found by the project service" parse error.
  {
    files: ["**/*.mjs", "**/*.config.ts", "**/*.config.mts", "**/*.config.cts"],
    ...tseslint.configs.disableTypeChecked,
  },
  // The seam-owning packages legitimately use their own raw clients.
  {
    files: [
      "packages/database/**",
      "packages/ontology/**",
      "packages/telemetry/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
  // The Better Auth Drizzle adapter needs a persistent raw db() connection
  // handle (it only touches non-RLS-policied global auth tables). This is the
  // single authorized raw-db() consumer outside @oxagen/database.
  {
    files: ["packages/auth/src/auth.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // Operational seed/backfill/migration scripts run as a trusted operator,
  // not in a request context, and legitimately use the raw db() handle to
  // enumerate and write across tenants (e.g. backfill-org-iam, seed-skills,
  // seed-interactive-agent). They print and confirm the target DB before any
  // write. The request-path RLS seam does not apply here.
  {
    files: ["tools/scripts/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
