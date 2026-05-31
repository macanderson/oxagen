import nextPlugin from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", ".source/**", "node_modules/**", "dist/**", ".turbo/**", "coverage/**"] },
  ...nextPlugin,
  ...nextCoreWebVitals,
  ...nextTypescript,
];

export default config;
