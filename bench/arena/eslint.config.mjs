import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next/", "node_modules/", "coverage/"]
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      // `strictTypeChecked` overrides this rule to `allowNumber: false`, which
      // is stricter than every other package in the monorepo (they run the
      // typescript-eslint `recommended` set, whose default is `allowNumber:
      // true`). Interpolating a number into a template literal is safe and
      // idiomatic, so restore the upstream default here. The rule stays ON and
      // still catches genuinely unsafe interpolations (`any`, `unknown`,
      // objects, arrays, nullish, booleans).
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true }
      ]
    }
  },
  // Plain-JS config files (eslint/next/postcss config, dev/kill scripts) and TS
  // tooling configs (vitest.config.ts) belong to no tsconfig project, so the
  // type-aware project service can't find them and errors with "not found by
  // the project service". Lint them untyped — the exact pattern the root
  // `eslint.config.mjs` uses for the same files.
  {
    files: ["**/*.mjs", "**/*.config.ts", "**/*.config.mts", "**/*.config.cts"],
    ...tseslint.configs.disableTypeChecked
  }
);
