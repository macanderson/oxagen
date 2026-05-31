// Root ESLint flat config — used by all non-Next packages and apps.
// Next.js apps (apps/app, apps/admin, apps/website, apps/docs) have their
// own eslint.config.mjs that extends eslint-config-next; they do NOT use
// this root config.  Every other package resolves ESLint from root
// node_modules and points --config at this file (or lets flat-config
// discovery walk up to it).
import tseslint from "typescript-eslint";

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
    ],
  },
  // Base TS config without type-checking (fast; runs on all TS files).
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // projectService enables type-aware rules only when a tsconfig.json
        // is present in the package.  Packages without one fall back gracefully.
        projectService: true,
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
    },
  },
);
