// Uses the shared Next.js flat config (no-explicit-any: error, …) — see
// ../../eslint.next.mjs — plus the Fumadocs-generated .source/** ignore on top.
import nextConfig from "../../eslint.next.mjs";

<<<<<<< Updated upstream
export default [...nextConfig, { ignores: [".source/**"] }];
=======
const config = [
  { ignores: [".next/**", ".source/**", "node_modules/**", "dist/**", ".turbo/**", "coverage/**"] },
  ...nextPlugin,
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
>>>>>>> Stashed changes
