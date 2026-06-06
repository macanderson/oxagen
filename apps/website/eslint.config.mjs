<<<<<<< Updated upstream
// Uses the shared Next.js flat config (no-explicit-any: error, …) — see
// ../../eslint.next.mjs. Keeps lint enforcement identical across all apps.
export { default } from "../../eslint.next.mjs";
=======
import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "dist/**", ".turbo/**", "coverage/**"] },
  ...nextPlugin,
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
>>>>>>> Stashed changes
