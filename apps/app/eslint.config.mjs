import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "dist/**", ".turbo/**", "coverage/**"] },
  ...nextPlugin,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Foundation-milestone scaffolding (dynamic schema access, loosely-typed
      // server-action payloads) intentionally uses `any`. Surface it as a
      // warning rather than a hard error so it's visible without blocking the
      // gate; tighten to "error" once the capability kernel owns these paths.
      "@typescript-eslint/no-explicit-any": "warn",
      // Align with the workspace-wide convention: _-prefixed vars/args are
      // intentionally unused (ignored values, placeholder params, etc.).
      "@typescript-eslint/no-unused-vars": [
        "warn",
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
